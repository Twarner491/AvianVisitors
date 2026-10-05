<?php
// Admin-only BirdWeather settings facade. The BirdWeather station token is a
// write credential carried in API URLs, not the station's public numeric ID.
// Normal status responses never include it. An explicit reveal requires a
// verifier-bound admin session even when ordinary direct-LAN access is trusted.

declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';

const AVIAN_BIRDWEATHER_API = 'https://app.birdweather.com/api/v1/stations';
const AVIAN_BIRDWEATHER_PUBLIC = 'https://app.birdweather.com';
const AVIAN_BIRDWEATHER_RESPONSE_MAX = 262144;

function birdweather_response(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function birdweather_conf_path(): string {
    // CLI-only override keeps runtime tests away from the real station config.
    if (PHP_SAPI === 'cli') {
        $override = getenv('AV_BIRDWEATHER_CONF');
        if (is_string($override) && $override !== '') return $override;
    }
    return '/etc/birdnet/birdnet.conf';
}

function birdweather_parse_conf_value(string $raw): ?string {
    if (strlen($raw) > 1024) return null;
    $raw = trim($raw);
    if ($raw === '') return '';
    $first = $raw[0];
    if ($first === "'") {
        $close = strpos($raw, "'", 1);
        if ($close === false || preg_match('/\A\s*(?:#.*)?\z/D', substr($raw, $close + 1)) !== 1) {
            return null;
        }
        return substr($raw, 1, $close - 1);
    }
    if ($first === '"') {
        $value = '';
        $length = strlen($raw);
        for ($index = 1; $index < $length; $index++) {
            $character = $raw[$index];
            if ($character === '"') {
                return preg_match('/\A\s*(?:#.*)?\z/D', substr($raw, $index + 1)) === 1
                    ? $value
                    : null;
            }
            if ($character === '\\') {
                $index++;
                if ($index >= $length) return null;
                $escaped = $raw[$index];
                $value .= in_array($escaped, ['\\', '"', '$', '`'], true)
                    ? $escaped
                    : '\\' . $escaped;
                continue;
            }
            if ($character === '$' || $character === '`') return null;
            $value .= $character;
        }
        return null;
    }
    if (preg_match('/\A([A-Za-z0-9._+,:@%\/=~-]*)(?:\s+#.*)?\z/D', $raw, $match) !== 1) {
        return null;
    }
    return $match[1];
}

function birdweather_read_conf(string $path): array {
    if (!is_readable($path) || is_dir($path)) return [];
    $values = [];
    $lines = @file($path, FILE_IGNORE_NEW_LINES);
    if (!is_array($lines)) return [];
    foreach ($lines as $line) {
        if ($line === '' || $line[0] === '#') continue;
        if (preg_match('/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/', $line, $match) !== 1) {
            continue;
        }
        // Only these four keys are retained. This keeps unrelated secrets out
        // of memory and out of any accidental future response serialization.
        if (in_array($match[1], [
            'BIRDWEATHER_ID',
            'BIRDWEATHER_ENABLED',
            'BIRDWEATHER_UPLOAD_AUDIO',
            'PRIVACY_THRESHOLD',
        ], true)) {
            $value = birdweather_parse_conf_value($match[2]);
            if ($value === null) unset($values[$match[1]]);
            else $values[$match[1]] = $value;
        }
    }
    return $values;
}

function birdweather_token_is_valid(string $token): bool {
    return $token !== '.'
        && $token !== '..'
        && preg_match('/\A[A-Za-z0-9._~-]{1,160}\z/D', $token) === 1;
}

function birdweather_normalize_token(mixed $value): ?string {
    if (!is_string($value)) return null;
    // Do not make a control-bearing credential valid by trimming it. Only
    // ordinary spaces around a pasted value are presentation noise.
    if (preg_match('/[\x00-\x1F\x7F]/D', $value) === 1) return null;
    $token = trim($value, ' ');
    if (str_starts_with($token, '#')) $token = substr($token, 1);
    return birdweather_token_is_valid($token) ? $token : null;
}

function birdweather_effective_config(array $conf): array {
    $token = trim((string)($conf['BIRDWEATHER_ID'] ?? ''));
    $tokenConfigured = $token !== '';
    $tokenValid = birdweather_token_is_valid($token);
    $enabledExplicit = array_key_exists('BIRDWEATHER_ENABLED', $conf);
    $audioExplicit = array_key_exists('BIRDWEATHER_UPLOAD_AUDIO', $conf);

    $enabled = $enabledExplicit
        ? (string)$conf['BIRDWEATHER_ENABLED'] === '1'
        : $tokenConfigured;
    // Old installations have neither policy key. Preserve their audio upload
    // behavior. Once either policy key exists, a missing audio key is false.
    $uploadAudio = $audioExplicit
        ? (string)$conf['BIRDWEATHER_UPLOAD_AUDIO'] === '1'
        : ($tokenConfigured && !$enabledExplicit);
    $privacy = filter_var(
        $conf['PRIVACY_THRESHOLD'] ?? 0,
        FILTER_VALIDATE_INT,
        ['options' => ['min_range' => 0, 'max_range' => 3]]
    );
    if ($privacy === false) $privacy = 0;

    return [
        'enabled' => $enabled && $tokenValid,
        'token_configured' => $tokenConfigured,
        'configuration_valid' => !$tokenConfigured || $tokenValid,
        'upload_audio' => $uploadAudio,
        'privacy_threshold' => (int)$privacy,
        'enabled_implicit' => !$enabledExplicit,
        'upload_audio_implicit' => !$audioExplicit,
    ];
}

function birdweather_public_status(array $conf): array {
    $effective = birdweather_effective_config($conf);
    return [
        'ok' => true,
        'enabled' => $effective['enabled'],
        'token_configured' => $effective['token_configured'],
        'configuration_valid' => $effective['configuration_valid'],
        'upload_audio' => $effective['upload_audio'],
        'privacy_threshold' => $effective['privacy_threshold'],
        'migration' => [
            'enabled_implicit' => $effective['enabled_implicit'],
            'upload_audio_implicit' => $effective['upload_audio_implicit'],
        ],
        'sharing' => [
            'detections_include' => [
                'bird names',
                'confidence',
                'timestamp',
                'station coordinates',
            ],
            'audio_is_full_recording' => true,
        ],
        'birdweather_url' => AVIAN_BIRDWEATHER_PUBLIC,
    ];
}

function birdweather_station_id_value(mixed $value): ?int {
    if (is_int($value)) return $value > 0 && $value <= 2147483647 ? $value : null;
    if (!is_string($value) || preg_match('/\A[1-9][0-9]{0,9}\z/D', $value) !== 1) return null;
    $stationId = (int)$value;
    return $stationId > 0 && $stationId <= 2147483647 ? $stationId : null;
}

function birdweather_find_station_id(mixed $value, int $depth = 0): ?int {
    if (!is_array($value) || $depth > 6) return null;
    foreach (['stationId', 'station_id'] as $key) {
        if (array_key_exists($key, $value)) {
            $stationId = birdweather_station_id_value($value[$key]);
            if ($stationId !== null) return $stationId;
        }
    }
    if (isset($value['station']) && is_array($value['station']) && array_key_exists('id', $value['station'])) {
        $stationId = birdweather_station_id_value($value['station']['id']);
        if ($stationId !== null) return $stationId;
    }
    foreach ($value as $nested) {
        if (!is_array($nested)) continue;
        $stationId = birdweather_find_station_id($nested, $depth + 1);
        if ($stationId !== null) return $stationId;
    }
    return null;
}

function birdweather_probe_payload_state(mixed $decoded, string $collection): string {
    if (!in_array($collection, ['detections', 'soundscapes'], true)
        || !is_array($decoded)
        || !array_key_exists('success', $decoded)) {
        return 'unavailable';
    }
    if ($decoded['success'] !== true) return 'invalid';
    if (!array_key_exists($collection, $decoded)
        || !is_array($decoded[$collection])
        || !array_is_list($decoded[$collection])) {
        return 'unavailable';
    }
    foreach ($decoded[$collection] as $entry) {
        if (!is_array($entry)) return 'unavailable';
    }
    return 'connected';
}

function birdweather_http_get(string $url, string $collection): array {
    if (!function_exists('curl_init')) {
        return ['state' => 'unavailable', 'status' => 0, 'body' => null];
    }
    $handle = curl_init($url);
    if ($handle === false) {
        return ['state' => 'unavailable', 'status' => 0, 'body' => null];
    }
    $body = '';
    curl_setopt_array($handle, [
        CURLOPT_RETURNTRANSFER => false,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT => 7,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
        CURLOPT_USERAGENT => 'BirdNET-Pi AvianVisitors',
        CURLOPT_PROXY => '',
        CURLOPT_NOPROXY => '*',
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body): int {
            if (strlen($body) + strlen($chunk) > AVIAN_BIRDWEATHER_RESPONSE_MAX) return 0;
            $body .= $chunk;
            return strlen($chunk);
        },
    ]);
    if (defined('CURLOPT_PROTOCOLS') && defined('CURLPROTO_HTTPS')) {
        curl_setopt($handle, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    }
    $completed = curl_exec($handle);
    $status = (int)curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);
    if ($completed !== true) {
        return ['state' => 'unavailable', 'status' => $status, 'body' => null];
    }
    $decoded = json_decode($body, true);
    if ($status < 200 || $status >= 300 || !is_array($decoded)) {
        return [
            'state' => in_array($status, [401, 403, 404], true) ? 'invalid' : 'unavailable',
            'status' => $status,
            'body' => null,
        ];
    }
    $state = birdweather_probe_payload_state($decoded, $collection);
    return [
        'state' => $state,
        'status' => $status,
        'body' => $state === 'connected' ? $decoded : null,
    ];
}

function birdweather_probe(string $token): array {
    $normalized = birdweather_normalize_token($token);
    if ($normalized === null) return ['state' => 'invalid'];
    $token = $normalized;
    $base = AVIAN_BIRDWEATHER_API . '/' . rawurlencode($token);
    $connected = false;
    $unavailable = false;
    foreach ([
        ['resource' => 'detections?limit=1', 'collection' => 'detections'],
        ['resource' => 'soundscapes?limit=1', 'collection' => 'soundscapes'],
    ] as $request) {
        $response = birdweather_http_get(
            $base . '/' . $request['resource'],
            $request['collection']
        );
        if ($response['state'] === 'invalid') return ['state' => 'invalid'];
        if ($response['state'] !== 'connected') {
            $unavailable = true;
            continue;
        }
        $connected = true;
        $stationId = birdweather_find_station_id($response['body']);
        if ($stationId !== null) {
            return [
                'state' => 'connected',
                'station_id' => $stationId,
                'station_url' => AVIAN_BIRDWEATHER_PUBLIC . '/stations/' . $stationId,
            ];
        }
    }
    if ($connected) return ['state' => 'connected', 'station_id' => null, 'station_url' => null];
    return ['state' => $unavailable ? 'unavailable' : 'invalid'];
}

function birdweather_validate_update(array $body, array $conf): array {
    $allowed = ['enabled', 'upload_audio', 'token', 'forget_token', 'privacy_threshold'];
    if ($body === []) {
        return ['ok' => false, 'status' => 400, 'error' => 'no setting supplied'];
    }
    foreach (array_keys($body) as $key) {
        if (!is_string($key) || !in_array($key, $allowed, true)) {
            return ['ok' => false, 'status' => 400, 'error' => 'unknown setting'];
        }
    }
    if (array_key_exists('enabled', $body) && !is_bool($body['enabled'])) {
        return ['ok' => false, 'status' => 400, 'error' => 'enabled must be true or false'];
    }
    if (array_key_exists('upload_audio', $body) && !is_bool($body['upload_audio'])) {
        return ['ok' => false, 'status' => 400, 'error' => 'upload_audio must be true or false'];
    }
    if (array_key_exists('privacy_threshold', $body)
        && (!is_int($body['privacy_threshold'])
            || $body['privacy_threshold'] < 0
            || $body['privacy_threshold'] > 3)) {
        return ['ok' => false, 'status' => 400, 'error' => 'privacy_threshold must be 0 through 3'];
    }
    if (array_key_exists('forget_token', $body) && $body['forget_token'] !== true) {
        return ['ok' => false, 'status' => 400, 'error' => 'forget_token must be true'];
    }
    if (!empty($body['forget_token']) && array_key_exists('token', $body)) {
        return ['ok' => false, 'status' => 400, 'error' => 'cannot replace and forget the token together'];
    }
    if (!empty($body['forget_token']) && ($body['enabled'] ?? false)) {
        return ['ok' => false, 'status' => 409, 'error' => 'turn sharing off before forgetting the token'];
    }

    $effective = birdweather_effective_config($conf);
    $newToken = null;
    if (array_key_exists('token', $body)) {
        $newToken = birdweather_normalize_token($body['token']);
        if ($newToken === null) {
            return ['ok' => false, 'status' => 400, 'error' => 'station token is invalid'];
        }
    }
    $hasUsableToken = $newToken !== null
        || ($effective['token_configured'] && $effective['configuration_valid']);
    if (($body['enabled'] ?? false) && !$hasUsableToken) {
        return ['ok' => false, 'status' => 409, 'error' => 'add a BirdWeather station token first'];
    }

    // Each request is a patch. This keeps independently autosaved controls
    // from restoring stale values for neighboring controls. Safety-coupled
    // defaults and token removal still land in one atomic root-helper write.
    $updates = [];
    if (array_key_exists('enabled', $body)) {
        $updates['BIRDWEATHER_ENABLED'] = $body['enabled'] ? '1' : '0';
    }
    if (array_key_exists('upload_audio', $body)) {
        $updates['BIRDWEATHER_UPLOAD_AUDIO'] = $body['upload_audio'] ? '1' : '0';
    }
    if (array_key_exists('privacy_threshold', $body)) {
        $updates['PRIVACY_THRESHOLD'] = (string)$body['privacy_threshold'];
    }
    if ($newToken !== null) {
        $updates['BIRDWEATHER_ID'] = $newToken;
        if (!$effective['token_configured']) {
            // Merely entering a first token must not start sharing. Audio and
            // local privacy also receive explicit, fail-closed defaults.
            if (!array_key_exists('enabled', $body)) $updates['BIRDWEATHER_ENABLED'] = '0';
            if (!array_key_exists('upload_audio', $body)) $updates['BIRDWEATHER_UPLOAD_AUDIO'] = '0';
            if (!array_key_exists('privacy_threshold', $body)) $updates['PRIVACY_THRESHOLD'] = '1';
        }
    }
    // Writing the first explicit enabled key changes how a legacy station
    // interprets a missing audio key. Preserve that station's prior behavior
    // unless this patch explicitly changes its audio permission.
    if (array_key_exists('enabled', $body)
        && !array_key_exists('upload_audio', $body)
        && $effective['token_configured']
        && $effective['upload_audio_implicit']) {
        $updates['BIRDWEATHER_UPLOAD_AUDIO'] = $effective['upload_audio'] ? '1' : '0';
    }
    if (!empty($body['forget_token'])) {
        $updates['BIRDWEATHER_ENABLED'] = '0';
        $updates['BIRDWEATHER_ID'] = '';
        $updates['BIRDWEATHER_UPLOAD_AUDIO'] = '0';
    }
    return ['ok' => true, 'updates' => $updates, 'new_token' => $newToken];
}

function birdweather_validate_new_token(array $validation, callable $probe): array {
    $token = $validation['new_token'] ?? null;
    if (!is_string($token)) return ['ok' => true, 'station' => null];
    $station = $probe($token);
    $state = is_array($station) ? ($station['state'] ?? '') : '';
    if ($state === 'connected') return ['ok' => true, 'station' => $station];
    if ($state === 'invalid') {
        return ['ok' => false, 'status' => 422, 'error' => 'BirdWeather rejected the station token'];
    }
    return ['ok' => false, 'status' => 503, 'error' => 'BirdWeather could not verify the station token'];
}

function birdweather_run_admin_control(string $control, array $arguments, string $input): array {
    if (!is_executable($control)) {
        return ['ok' => false, 'error' => 'admin control is not installed'];
    }
    $command = ['/usr/bin/sudo', '-n', $control];
    foreach ($arguments as $argument) $command[] = (string)$argument;
    $pipes = [];
    $process = proc_open($command, [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ], $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        return ['ok' => false, 'error' => 'could not start admin control'];
    }
    $offset = 0;
    $inputLength = strlen($input);
    $writeOk = true;
    while ($offset < $inputLength) {
        $written = @fwrite($pipes[0], substr($input, $offset));
        if (!is_int($written) || $written < 1) {
            $writeOk = false;
            break;
        }
        $offset += $written;
    }
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    // Do not surface stderr. It may contain a token-bearing URL from a future
    // helper implementation even though this helper currently performs only
    // local config writes and service restarts.
    stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $status = proc_close($process);
    if (!$writeOk) return ['ok' => false, 'error' => 'could not send settings to admin control'];
    $decoded = json_decode(is_string($stdout) ? $stdout : '', true);
    if ($status !== 0 || !is_array($decoded) || empty($decoded['ok'])) {
        return ['ok' => false, 'error' => 'admin control failed'];
    }
    return ['ok' => true];
}

function birdweather_canonical_status(
    string $path,
    array $updates,
    mixed $probedStation = null
): ?array {
    if (!is_readable($path) || is_dir($path)) return null;
    $conf = birdweather_read_conf($path);
    // Every accepted patch writes at least one retained BirdWeather key. An
    // empty result after that write cannot be treated as an honest snapshot.
    if ($conf === []) return null;

    $status = birdweather_public_status($conf);
    $writtenToken = $updates['BIRDWEATHER_ID'] ?? null;
    $canonicalToken = (string)($conf['BIRDWEATHER_ID'] ?? '');
    if (is_array($probedStation)
        && is_string($writtenToken)
        && $writtenToken !== ''
        && hash_equals($writtenToken, $canonicalToken)) {
        $status['station'] = $probedStation;
    }
    return $status;
}

function birdweather_main(): void {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    avian_require_admin();

    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $confPath = birdweather_conf_path();
    $conf = birdweather_read_conf($confPath);
    if ($conf === [] && !is_readable($confPath)) {
        birdweather_response(503, ['ok' => false, 'error' => 'station config is unavailable']);
    }

    if ($method === 'GET') {
        $probeValue = $_GET['probe'] ?? '0';
        if (!is_string($probeValue) || !in_array($probeValue, ['0', '1'], true)) {
            birdweather_response(400, ['ok' => false, 'error' => 'invalid probe setting']);
        }
        $revealValue = $_GET['reveal'] ?? '0';
        if (!is_string($revealValue) || !in_array($revealValue, ['0', '1'], true)) {
            birdweather_response(400, ['ok' => false, 'error' => 'invalid reveal setting']);
        }
        if ($revealValue === '1') avian_require_admin_proof();
        $status = birdweather_public_status($conf);
        if ($revealValue === '1') {
            $status['token'] = (string)($conf['BIRDWEATHER_ID'] ?? '');
        }
        if ($probeValue === '1') {
            $token = trim((string)($conf['BIRDWEATHER_ID'] ?? ''));
            $status['station'] = $token === ''
                ? ['state' => 'not_configured']
                : birdweather_probe($token);
            $token = '';
        }
        birdweather_response(200, $status);
    }

    avian_require_json_action();
    $body = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($body) || array_is_list($body)) {
        birdweather_response(400, ['ok' => false, 'error' => 'expected a JSON object']);
    }
    $validation = birdweather_validate_update($body, $conf);
    if (empty($validation['ok'])) {
        birdweather_response((int)$validation['status'], [
            'ok' => false,
            'error' => (string)$validation['error'],
        ]);
    }
    $probeCheck = birdweather_validate_new_token($validation, 'birdweather_probe');
    if (empty($probeCheck['ok'])) {
        birdweather_response((int)$probeCheck['status'], [
            'ok' => false,
            'error' => (string)$probeCheck['error'],
        ]);
    }

    $updates = $validation['updates'];
    $payload = '';
    foreach ($updates as $key => $value) $payload .= $key . "\0" . $value . "\0";
    if (array_key_exists('token', $body)) $body['token'] = '';
    $validation['new_token'] = null;
    $control = getenv('AV_ADMIN_CONTROL') ?: '/usr/local/sbin/avian-admin-control';
    $write = birdweather_run_admin_control(
        $control,
        ['config-set-stdin', (string)count($updates)],
        $payload
    );
    $payload = '';
    if (empty($write['ok'])) {
        birdweather_response(503, ['ok' => false, 'error' => $write['error']]);
    }
    $restart = birdweather_run_admin_control($control, ['restart', 'birdnet_analysis'], '');
    // Another autosave may have committed while this request restarted the
    // analyzer. Return one canonical on-disk snapshot, never a stale merge of
    // this request's original read and its own patch.
    $response = birdweather_canonical_status(
        $confPath,
        $updates,
        $probeCheck['station'] ?? null
    );
    if (empty($restart['ok'])) {
        $failure = [
            'ok' => false,
            'saved' => true,
            'error' => 'settings saved, but birdnet_analysis did not restart',
        ];
        if (is_array($response)) $failure['settings'] = $response;
        birdweather_response(500, $failure);
    }
    if (!is_array($response)) {
        birdweather_response(500, [
            'ok' => false,
            'saved' => true,
            'error' => 'settings saved, but station config could not be re-read',
        ]);
    }
    birdweather_response(200, $response);
}

if (!defined('AVIAN_BIRDWEATHER_LIBRARY_ONLY')) birdweather_main();
