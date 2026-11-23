<?php
// AvianVisitors - xeno-canto reference recordings for the postcard's
// "compare" control, so a detection can be checked against known songs and
// calls of the same species.
//
// Endpoints:
//   GET                          -> {enabled}; the control stays hidden
//                                   until a key is configured.
//   GET ?sci=<sci_name>          -> {recordings: [...]}: a few short,
//                                   good-quality recordings with recordist,
//                                   license and source link.
//   GET ?sci=<sci_name>&id=<xc>  -> that recording's audio.
//
// The site's CSP only allows same-origin media, so the audio is proxied.
// Only species this station has detected are looked up, the audio id must
// come from that species' list, and every request (redirects included) is
// pinned to https://xeno-canto.org.
//
// Opt-in: add XENO_CANTO_API_KEY to birdnet.conf. Any verified xeno-canto
// account has a free key at https://xeno-canto.org/account. The key never
// reaches the browser.

declare(strict_types=1);

const XC_API = 'https://xeno-canto.org/api/3/recordings';
const XC_RESULTS = 8;
const XC_JSON_MAX = 2097152;   // 2 MB
const XC_AUDIO_MAX = 16777216; // 16 MB; downloads are often WAV, clips under 20 s
const XC_LIST_TTL = 86400;

$BIRDNETPI_DIR = dirname(__DIR__, 2);

function xc_fail(int $status, string $error): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $error]);
    exit;
}

// Same reader as generate.php's GEMINI_API_KEY lookup.
function xc_key(string $conf): string {
    if (!is_readable($conf)) return '';
    foreach (file($conf, FILE_IGNORE_NEW_LINES) as $line) {
        if (preg_match('/^\s*XENO_CANTO_API_KEY\s*=\s*(.*)$/', $line, $m)) {
            $v = trim($m[1]);
            if (strlen($v) >= 2 && ($v[0] === '"' || $v[0] === "'") && substr($v, -1) === $v[0]) {
                $v = substr($v, 1, -1);
            }
            return preg_match('/^[A-Za-z0-9_-]{1,128}$/', $v) ? $v : '';
        }
    }
    return '';
}

// HTTPS GET with a size cap -> [body, content type]. Redirects are followed
// by hand so each hop is checked against the xeno-canto host first.
function xc_get(string $url, int $max): ?array {
    for ($hop = 0; $hop < 4; $hop++) {
        if (!preg_match('#^https://(?:www\.)?xeno-canto\.org/#', $url)) return null;
        $handle = curl_init($url);
        if ($handle === false) return null;
        $body = '';
        curl_setopt_array($handle, [
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
            CURLOPT_USERAGENT => 'AvianVisitors/1.0 (+https://github.com/Twarner491/AvianVisitors)',
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use (&$body, $max): int {
                if (strlen($body) + strlen($chunk) > $max) return 0;
                $body .= $chunk;
                return strlen($chunk);
            },
        ]);
        $done = curl_exec($handle);
        $status = (int)curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        $next = (string)curl_getinfo($handle, CURLINFO_REDIRECT_URL);
        $type = (string)curl_getinfo($handle, CURLINFO_CONTENT_TYPE);
        if ($done !== true) return null;
        if ($status >= 300 && $status < 400 && $next !== '') {
            $url = $next;
            continue;
        }
        return $status === 200 ? [$body, $type] : null;
    }
    return null;
}

function xc_detected(string $db, string $sci): bool {
    if (!is_readable($db) || !class_exists('SQLite3')) return false;
    try {
        $handle = new SQLite3($db, SQLITE3_OPEN_READONLY);
        $stmt = $handle->prepare('SELECT 1 FROM detections WHERE Sci_Name = :s LIMIT 1');
        $stmt->bindValue(':s', $sci, SQLITE3_TEXT);
        $res = $stmt->execute();
        $found = $res && $res->fetchArray() !== false;
        $handle->close();
        return $found;
    } catch (\Throwable $e) {
        return false;
    }
}

// Bounded display text. mbstring is optional on stations (see wiki.php), so
// trim by UTF-8 characters with PCRE; invalid UTF-8 becomes ''.
function xc_text(mixed $value, int $max): string {
    return is_string($value) && preg_match('/^.{0,' . $max . '}/su', $value, $m) ? trim($m[0]) : '';
}

function xc_license(string $url): array {
    if (str_starts_with($url, '//')) $url = 'https:' . $url;
    if (!preg_match('#^https?://creativecommons\.org/(licenses|publicdomain)/([a-z-]+)/([0-9.]+)/?$#', $url, $m)) {
        return ['license' => 'see source', 'license_url' => null];
    }
    $name = $m[1] === 'publicdomain' ? strtoupper($m[2]) : 'CC ' . strtoupper($m[2]);
    return ['license' => $name . ' ' . $m[3], 'license_url' => 'https://creativecommons.org/' . $m[1] . '/' . $m[2] . '/' . $m[3] . '/'];
}

function xc_list(string $key, string $sci): ?array {
    $url = XC_API . '?' . http_build_query([
        'query' => 'sp:"' . $sci . '" q:">C" len:"<20"',
        'per_page' => 50,
        'key' => $key,
    ], '', '&', PHP_QUERY_RFC3986);
    $raw = xc_get($url, XC_JSON_MAX);
    $payload = $raw === null ? null : json_decode($raw[0], true);
    if (!is_array($payload) || !is_array($payload['recordings'] ?? null)) return null;
    $out = [];
    foreach ($payload['recordings'] as $r) {
        $id = (string)($r['id'] ?? '');
        // Restricted species come back with the file redacted; skip them.
        if (!preg_match('/^[1-9][0-9]{0,9}$/', $id) || !str_starts_with((string)($r['file'] ?? ''), 'https://')) continue;
        $out[] = [
            'id' => (int)$id,
            'rec' => xc_text($r['rec'] ?? '', 80),
            'type' => xc_text($r['type'] ?? '', 60),
            'q' => xc_text($r['q'] ?? '', 2),
            'length' => xc_text($r['length'] ?? '', 8),
            'cnt' => xc_text($r['cnt'] ?? '', 60),
            'url' => 'https://xeno-canto.org/' . $id,
        ] + xc_license((string)($r['lic'] ?? ''));
    }
    // Quality A before B; usort is stable, so xeno-canto's order is kept within each.
    usort($out, static fn(array $a, array $b): int => strcmp($a['q'], $b['q']));
    return array_slice($out, 0, XC_RESULTS);
}

$key = function_exists('curl_init') ? xc_key("$BIRDNETPI_DIR/birdnet.conf") : '';
$sci = trim((string)($_GET['sci'] ?? ''));

if ($sci === '') {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['enabled' => $key !== '']);
    exit;
}
if ($key === '') xc_fail(404, 'xeno-canto key not configured');
// Same Genus species[ subspecies] check as recording.php / spectrogram.php.
if (!preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) xc_fail(400, 'invalid sci');
if (!xc_detected("$BIRDNETPI_DIR/scripts/birds.db", $sci)) xc_fail(404, 'species not detected');

// One small list per detected species, so audio requests can be checked
// against it without another API call. Only a cache directory this process
// owns is trusted.
$cacheDir = sys_get_temp_dir() . '/avian-xeno-canto';
$cacheFile = $cacheDir . '/' . sha1($sci) . '.json';
$cacheOk = is_dir($cacheDir)
    ? !function_exists('posix_geteuid') || fileowner($cacheDir) === posix_geteuid()
    : @mkdir($cacheDir, 0700, true);
$list = null;
if ($cacheOk && is_file($cacheFile) && time() - (int)filemtime($cacheFile) < XC_LIST_TTL) {
    $list = json_decode((string)file_get_contents($cacheFile), true);
}
if (!is_array($list)) {
    $list = xc_list($key, $sci);
    if ($list === null) xc_fail(502, 'xeno-canto unavailable');
    if ($cacheOk) {
        $tmp = $cacheFile . '.' . bin2hex(random_bytes(6));
        if (@file_put_contents($tmp, json_encode($list)) !== false) @rename($tmp, $cacheFile);
    }
}

if (!isset($_GET['id'])) {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: private, max-age=3600');
    echo json_encode(['recordings' => $list, 'source' => 'xeno-canto.org'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

$id = (string)$_GET['id'];
if (!preg_match('/^[1-9][0-9]{0,9}$/', $id) || !in_array((int)$id, array_column($list, 'id'), true)) {
    xc_fail(404, 'unknown recording');
}
$audio = xc_get("https://xeno-canto.org/$id/download", XC_AUDIO_MAX);
if ($audio === null || strlen($audio[0]) < 1024) xc_fail(502, 'recording unavailable');
// xeno-canto serves the original upload (mostly MP3 or WAV).
$type = preg_match('#^audio/(?:mpeg|mp3|wav|x-wav|wave|flac|x-flac|ogg)\b#i', $audio[1], $m) ? strtolower($m[0]) : 'audio/mpeg';

header('Content-Type: ' . $type);
header('Content-Length: ' . strlen($audio[0]));
header('Cache-Control: private, max-age=604800');
header('X-Content-Type-Options: nosniff');
echo $audio[0];
