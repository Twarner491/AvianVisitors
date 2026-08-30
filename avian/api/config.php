<?php
// AvianVisitors - read/write a small, whitelisted subset of BirdNET-Pi
// settings from the admin overlay's settings panel. Fetched by the
// frontend at /avian/api/config.php.
//
// Endpoints:
//   GET  -> returns current values as JSON.
//   POST -> JSON body with any whitelisted key. Writes through to
//           birdnet.conf and restarts birdnet_analysis + birdnet_recording
//           so the changes take effect immediately.
//
// Direct requests on the station's private address are available without a
// password unless the owner enables the LAN admin gate. Forwarded and
// public-host requests always verify BirdNET-Pi's configured admin password.
//
// Restart requires passwordless sudo for the caddy user that runs
// php-fpm, dropped in place by install_services.sh at
// /etc/sudoers.d/020_avian-admin.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/admin-auth.php';
avian_require_admin();

// Path layout: /home/{USER}/BirdNET-Pi/avian/api/config.php
$BIRDNETPI_DIR = dirname(__DIR__, 2);
$CONF_PATH     = '/etc/birdnet/birdnet.conf';
$ADMIN_CONTROL = getenv('AV_ADMIN_CONTROL') ?: '/usr/local/sbin/avian-admin-control';

// Whitelist: { config_key => { type, min?, max?, restart? } }
$ALLOWED = [
    'CONFIDENCE'         => ['type' => 'float', 'min' => 0.05, 'max' => 0.99, 'restart' => true],
    'SENSITIVITY'        => ['type' => 'float', 'min' => 0.5,  'max' => 1.5,  'restart' => true],
    // Floor matches upstream: 0.0 admits every label in the model and
    // silently disables the range filter for the whole station.
    'SF_THRESH'          => ['type' => 'float', 'min' => 0.0005, 'max' => 0.99, 'restart' => true],
    'OVERLAP'            => ['type' => 'float', 'min' => 0.0,  'max' => 2.5,  'restart' => true],
    'MAX_FILES_SPECIES'  => ['type' => 'int',   'min' => 0,    'max' => 100000],
    'FULL_DISK'          => ['type' => 'enum',  'values' => ['purge', 'keep']],
    // Display preference, no service restart: the collage picks it up on its
    // next fetch and the frame publisher on its next tick.
    'COLLAGE_LABELS'     => ['type' => 'enum',  'values' => ['on', 'off']],
    'PURGE_THRESHOLD'    => ['type' => 'int',   'min' => 50,   'max' => 99],
    'LATITUDE'           => ['type' => 'float', 'min' => -90,  'max' => 90, 'restart' => true],
    'LONGITUDE'          => ['type' => 'float', 'min' => -180, 'max' => 180, 'restart' => true],
    'SITE_NAME'          => ['type' => 'string', 'maxlen' => 60],
    // BirdWeather writes use the dedicated facade, which verifies a new token
    // remotely before this root-owned writer is allowed to persist it.
    'BIRDWEATHER_ID'     => ['type' => 'secret', 'maxlen' => 160, 'managed_by' => 'birdweather'],
    'BIRDWEATHER_ENABLED' => ['type' => 'int', 'min' => 0, 'max' => 1, 'managed_by' => 'birdweather'],
    'BIRDWEATHER_UPLOAD_AUDIO' => ['type' => 'int', 'min' => 0, 'max' => 1, 'managed_by' => 'birdweather'],
    'PRIVACY_THRESHOLD'  => ['type' => 'int', 'min' => 0, 'max' => 3, 'managed_by' => 'birdweather'],
    // Secrets: writable like any setting, but NEVER echoed back on GET -
    // the response carries only a set/unset flag. Consumed by the
    // illustration pipeline (generate.php passes them by env).
    'GEMINI_API_KEY'     => ['type' => 'secret', 'maxlen' => 200],
    'EBIRD_API_KEY'      => ['type' => 'secret', 'maxlen' => 120],
];

function read_conf(string $path): array {
    if (!is_readable($path)) return [];
    $out = [];
    foreach (file($path, FILE_IGNORE_NEW_LINES) as $line) {
        if (!$line || $line[0] === '#') continue;
        if (preg_match('/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i', $line, $m)) {
            $val = trim($m[2]);
            if (strlen($val) >= 2 && $val[0] === '"' && substr($val, -1) === '"') {
                $val = substr($val, 1, -1);
            }
            $out[$m[1]] = $val;
        }
    }
    return $out;
}

function run_admin_control(string $control, array $arguments, ?string $input = null): array {
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

    $writeOk = true;
    if ($input !== null && $input !== '') {
        $offset = 0;
        $length = strlen($input);
        while ($offset < $length) {
            $written = @fwrite($pipes[0], substr($input, $offset));
            if (!is_int($written) || $written < 1) {
                $writeOk = false;
                break;
            }
            $offset += $written;
        }
    }
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $code = proc_close($process);
    if (!$writeOk) {
        return ['ok' => false, 'error' => 'could not send config to admin control'];
    }

    $decoded = json_decode(is_string($stdout) ? $stdout : '', true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'error' => 'admin control returned an invalid response'];
    }
    if ($code !== 0 || empty($decoded['ok'])) {
        return ['ok' => false, 'error' => (string)($decoded['error'] ?? 'admin control failed')];
    }
    return $decoded;
}

function admin_control_needs_ssh_recovery(string $error): bool {
    return stripos($error, 'credential state') !== false
        || stripos($error, 'initialization is incomplete') !== false
        || stripos($error, 'set the admin password from SSH') !== false
        || stripos($error, 'cannot initialize the admin credential') !== false;
}

function admin_control_audio_remediation(
    string $error,
    bool $passwordAction,
    array $adminState
): ?string {
    if (!str_contains($error, 'live audio') && !str_contains($error, 'Icecast')) {
        return null;
    }
    $protected = empty($adminState['valid']) || !empty($adminState['required']);
    if (!$protected && str_contains($error, 'restored and verified')) {
        return null;
    }
    if (!$protected) {
        return 'Over SSH, inspect Icecast with sudo systemctl status icecast2, start it with sudo systemctl start icecast2 if appropriate, then verify /stream works from the local network.';
    }
    if ($passwordAction) {
        return 'Retry the same password. If the warning remains, over SSH run sudo systemctl stop icecast2, confirm it is inactive, then verify /stream returns 404.';
    }
    return 'Over SSH, reboot the station, then verify /stream returns 404.';
}

function admin_state_revision(array $state): string {
    return (!empty($state['valid']) ? 'valid' : 'invalid') . ':'
        . (!empty($state['required']) ? '1' : '0') . ':'
        . (string)($state['epoch'] ?? 'invalid') . ':'
        . (string)($state['verifier'] ?? '-');
}

// Tight allowlist for string fields. The root-owned writer repeats the same
// validation before it touches birdnet.conf.
function safe_string_value(string $v): bool {
    return (bool)preg_match("/^[A-Za-z0-9 _.,'-]*$/u", $v);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $adminState = avian_admin_state();
    $configuredLanAuth = avian_configured_lan_admin_auth_required();
    $effectiveLanAuth = avian_lan_admin_auth_required();
    $conf = read_conf($CONF_PATH);
    $out = [];
    $secrets = [];
    foreach ($ALLOWED as $k => $spec) {
        if ($spec['type'] === 'secret') {
            // Never return the value; the UI only needs to know it's set.
            $secrets[$k] = ($conf[$k] ?? '') !== '';
            continue;
        }
        if (!array_key_exists($k, $conf)) continue;
        $v = $conf[$k];
        if ($spec['type'] === 'float') $v = (float)$v;
        elseif ($spec['type'] === 'int') $v = (int)$v;
        $out[$k] = $v;
    }
    echo json_encode([
        'values'   => $out,
        'secrets'  => $secrets,
        'meta'     => $ALLOWED,
        'preserve' => (int)($conf['MAX_FILES_SPECIES'] ?? 0) >= 10000,
        'security' => [
            'lan_admin_auth' => $configuredLanAuth,
            'policy_reconciliation_needed' => avian_is_direct_local_request($_SERVER)
                && $effectiveLanAuth !== $configuredLanAuth,
            'password_configured' => !empty($adminState['valid'])
                && !empty($adminState['configured']),
            'recovery' => empty($adminState['valid']),
        ],
    ]);
    exit;
}

if ($method === 'POST') {
    avian_require_json_action();
    $raw = file_get_contents('php://input');
    $body = json_decode((string)$raw, true);
    if (!is_array($body)) {
        http_response_code(400);
        echo json_encode(['error' => 'bad json']);
        exit;
    }
    if ((array_key_exists('lan_admin_auth', $body)
            || array_key_exists('admin_password', $body))
        && count($body) !== 1) {
        http_response_code(400);
        echo json_encode(['error' => 'access credentials must be changed by themselves']);
        exit;
    }
    $updates = [];
    $errors = [];
    foreach ($body as $k => $v) {
        // These UI-side convenience flags are handled below.
        if ($k === 'preserve' || $k === 'lan_admin_auth' || $k === 'admin_password') continue;
        if (!isset($ALLOWED[$k])) { $errors[$k] = 'unknown'; continue; }
        $spec = $ALLOWED[$k];
        if (($spec['managed_by'] ?? '') === 'birdweather') {
            $errors[$k] = 'use BirdWeather settings';
            continue;
        }
        if ($spec['type'] === 'float') {
            if (!is_int($v) && !is_float($v)) { $errors[$k] = 'not a number'; continue; }
            $v = (float)$v;
            if ($v < ($spec['min'] ?? -INF) || $v > ($spec['max'] ?? INF)) { $errors[$k] = 'out of range'; continue; }
        } elseif ($spec['type'] === 'int') {
            if (!is_int($v)) { $errors[$k] = 'not an integer'; continue; }
            if ($v < ($spec['min'] ?? -PHP_INT_MAX) || $v > ($spec['max'] ?? PHP_INT_MAX)) { $errors[$k] = 'out of range'; continue; }
        } elseif ($spec['type'] === 'enum') {
            if (!is_string($v)) { $errors[$k] = 'invalid value'; continue; }
            if (!in_array($v, $spec['values'], true)) { $errors[$k] = 'invalid value'; continue; }
        } elseif ($spec['type'] === 'string') {
            if (!is_string($v)) { $errors[$k] = 'not a string'; continue; }
            $v = (string)$v;
            if (strlen($v) > ($spec['maxlen'] ?? 200)) { $errors[$k] = 'too long'; continue; }
            // String fields land in birdnet.conf which upstream shell tools
            // source. Keep shell metacharacters out before the root writer
            // repeats the same validation.
            if (!safe_string_value($v)) { $errors[$k] = 'invalid characters'; continue; }
        } elseif ($spec['type'] === 'secret') {
            if (!is_string($v)) { $errors[$k] = 'not a string'; continue; }
            $v = trim((string)$v);
            if (strlen($v) > ($spec['maxlen'] ?? 200)) { $errors[$k] = 'too long'; continue; }
            // API tokens need a wider character set than SITE_NAME, but still
            // stay inside a fixed allowlist. Empty string clears the key.
            if (!preg_match('/^[A-Za-z0-9_\-.\/+=:]*$/', $v)) { $errors[$k] = 'invalid characters'; continue; }
        }
        $updates[$k] = $v;
    }
    if ($errors) {
        http_response_code(400);
        echo json_encode(['error' => 'validation', 'fields' => $errors]);
        exit;
    }

    // Convenience flag: "preserve" toggle in the UI sets a high recording cap.
    // Off restores the installer default (0 = no per-species cap) rather
    // than 50, which would delete recordings a user never asked to lose.
    if (isset($body['preserve'])) {
        if (!is_bool($body['preserve'])) {
            http_response_code(400);
            echo json_encode(['error' => 'validation', 'fields' => ['preserve' => 'not a boolean']]);
            exit;
        }
        $updates['MAX_FILES_SPECIES'] = $body['preserve'] ? 99999 : 0;
    }

    $policyChanged = false;
    $passwordChanged = false;
    if (array_key_exists('admin_password', $body)) {
        $newPassword = $body['admin_password'];
        if (!is_string($newPassword)
            || preg_match('/^[A-Za-z0-9]{12,64}$/D', $newPassword) !== 1) {
            http_response_code(400);
            echo json_encode([
                'error' => 'password must use 12 to 64 letters or numbers',
            ]);
            exit;
        }
        $adminState = avian_admin_state();
        if (empty($adminState['valid']) || empty($adminState['configured'])) {
            http_response_code(409);
            echo json_encode([
                'error' => 'initialize the admin password from SSH first',
                'recovery' => true,
            ]);
            exit;
        }
        $beforeRevision = admin_state_revision($adminState);
        $currentPassword = avian_require_explicit_admin_credential($adminState, true);
        $passwordUpdate = run_admin_control(
            $ADMIN_CONTROL,
            ['password-change-stdin'],
            $currentPassword . "\0" . $newPassword . "\0"
        );
        $currentPassword = '';
        $newPassword = '';
        if (empty($passwordUpdate['ok'])) {
            $error = (string)($passwordUpdate['error'] ?? 'password change failed');
            $finalAdminState = avian_admin_state();
            $reauth = admin_state_revision($finalAdminState) !== $beforeRevision;
            http_response_code(500);
            echo json_encode([
                'error' => $error,
                'recovery' => admin_control_needs_ssh_recovery($error),
                'reauth' => $reauth,
                'remediation' => admin_control_audio_remediation(
                    $error,
                    true,
                    $finalAdminState
                )
                    ?? ($reauth
                        ? 'Unlock with your current password. If that fails, reset it from SSH.'
                        : null),
            ]);
            exit;
        }
        $passwordChanged = !empty($passwordUpdate['changed']);
    }
    if (array_key_exists('lan_admin_auth', $body)) {
        if (!is_bool($body['lan_admin_auth'])) {
            http_response_code(400);
            echo json_encode(['error' => 'validation', 'fields' => ['lan_admin_auth' => 'not a boolean']]);
            exit;
        }
        $requestedPolicy = $body['lan_admin_auth'];
        $adminState = avian_admin_state();
        if (empty($adminState['valid']) || empty($adminState['configured'])) {
            http_response_code(409);
            echo json_encode([
                'error' => 'set the admin password from SSH first',
                'recovery' => true,
            ]);
            exit;
        }
        $beforeRevision = admin_state_revision($adminState);

        // Re-enter the configured credential for transitions and same-value
        // reconciliation. A local bypass or unattended session is not proof.
        $password = avian_require_explicit_admin_credential($adminState, true);
        $policyUpdate = run_admin_control(
            $ADMIN_CONTROL,
            ['lan-auth-set-stdin', $requestedPolicy ? '1' : '0'],
            $password . "\0"
        );
        $password = '';
        if (empty($policyUpdate['ok'])) {
            $error = (string)($policyUpdate['error'] ?? 'access setting failed');
            $finalAdminState = avian_admin_state();
            http_response_code(500);
            echo json_encode([
                'error' => $error,
                'recovery' => admin_control_needs_ssh_recovery($error),
                'reauth' => admin_state_revision($finalAdminState) !== $beforeRevision,
                'remediation' => admin_control_audio_remediation(
                    $error,
                    false,
                    $finalAdminState
                ),
            ]);
            exit;
        }
        $policyChanged = admin_state_revision(avian_admin_state()) !== $beforeRevision;
    }

    if ($updates) {
        $payload = '';
        foreach ($updates as $key => $value) {
            $payload .= $key . "\0" . (string)$value . "\0";
        }
        $result = run_admin_control(
            $ADMIN_CONTROL,
            ['config-set-stdin', (string)count($updates)],
            $payload
        );
        if (empty($result['ok'])) {
            http_response_code(500);
            echo json_encode(['error' => $result['error'] ?? 'config write failed']);
            exit;
        }
    }

    if (($policyChanged || $passwordChanged)
        && !avian_rotate_admin_session_after_policy_change()) {
        http_response_code(503);
        echo json_encode([
            'ok' => false,
            'error' => 'security setting saved; sign in again',
            'reauth' => true,
        ]);
        exit;
    }

    // Restart services if any setting requires it.
    $needsRestart = false;
    foreach (array_keys($updates) as $k) {
        if (!empty($ALLOWED[$k]['restart'])) { $needsRestart = true; break; }
    }
    $restarted = [];
    if ($needsRestart) {
        foreach (['birdnet_analysis', 'birdnet_recording'] as $svc) {
            $result = run_admin_control($ADMIN_CONTROL, ['restart', $svc]);
            $restarted[$svc] = !empty($result['ok']);
        }
        if (in_array(false, $restarted, true)) {
            http_response_code(500);
            echo json_encode([
                'ok' => false,
                'error' => 'settings saved, but a BirdNET service did not restart',
                'restarted' => $restarted,
            ]);
            exit;
        }
    }
    // Don't echo secret values back; report which keys changed only.
    $shown = [];
    foreach ($updates as $k => $v) {
        $shown[$k] = (($ALLOWED[$k]['type'] ?? '') === 'secret') ? '(saved)' : $v;
    }
    echo json_encode([
        'ok' => true,
        'updates' => $shown,
        'restarted' => $restarted,
        'security' => [
            'lan_admin_auth' => avian_configured_lan_admin_auth_required(),
        ],
    ]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
