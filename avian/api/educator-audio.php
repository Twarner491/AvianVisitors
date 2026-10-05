<?php
// Bounded authenticated proxy for Educators live audio under LAN protection.

declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/educator-state.php';

const AVIAN_EDUCATOR_AUDIO_MAX_SECONDS = 1800;
const AVIAN_EDUCATOR_AUDIO_CHECK_SECONDS = 2;
const AVIAN_EDUCATOR_AUDIO_HEADER_MAX = 16384;
const AVIAN_EDUCATOR_AUDIO_SLOTS = [
    '/var/lib/avian-visitors/educator-audio-0.lock',
    '/var/lib/avian-visitors/educator-audio-1.lock',
];

function educator_audio_fail(int $status, string $error, ?string $allow = null): never {
    http_response_code($status);
    if ($allow !== null) header('Allow: ' . $allow);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: private, no-store, max-age=0');
    header('Pragma: no-cache');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

/** @return resource|null */
function educator_audio_slot() {
    if (!function_exists('posix_getgrnam')) return null;
    $group = posix_getgrnam('caddy');
    if (!is_array($group) || !isset($group['gid'])) return null;
    $expectedGid = (int)$group['gid'];
    $parent = @lstat('/var/lib/avian-visitors');
    if (!is_array($parent)
        || (($parent['mode'] ?? 0) & 0170000) !== 0040000
        || (int)($parent['uid'] ?? -1) !== 0
        || (int)($parent['gid'] ?? -1) !== 0
        || (($parent['mode'] ?? 0) & 0777) !== 0755) {
        return null;
    }
    foreach (AVIAN_EDUCATOR_AUDIO_SLOTS as $path) {
        clearstatcache(true, $path);
        $before = @lstat($path);
        if (!is_array($before)
            || (($before['mode'] ?? 0) & 0170000) !== 0100000
            || (int)($before['uid'] ?? -1) !== 0
            || (int)($before['gid'] ?? -1) !== $expectedGid
            || (($before['mode'] ?? 0) & 0777) !== 0660
            || (int)($before['nlink'] ?? 0) !== 1) {
            continue;
        }
        $handle = @fopen($path, 'r+b');
        if (!is_resource($handle)) continue;
        $opened = fstat($handle);
        clearstatcache(true, $path);
        $after = @lstat($path);
        if (!is_array($opened)
            || !is_array($after)
            || (int)($opened['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
            || (int)($opened['ino'] ?? -1) !== (int)($before['ino'] ?? -2)
            || (int)($after['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
            || (int)($after['ino'] ?? -1) !== (int)($before['ino'] ?? -2)
            || (($opened['mode'] ?? 0) & 0170000) !== 0100000
            || (int)($opened['uid'] ?? -1) !== 0
            || (int)($opened['gid'] ?? -1) !== $expectedGid
            || (($opened['mode'] ?? 0) & 0777) !== 0660
            || (int)($opened['nlink'] ?? 0) !== 1) {
            fclose($handle);
            continue;
        }
        if (@flock($handle, LOCK_EX | LOCK_NB)) return $handle;
        fclose($handle);
    }
    return null;
}

/** @return array{0:resource,1:string}|null */
function educator_audio_open_upstream(): ?array {
    $errno = 0;
    $error = '';
    $socket = @stream_socket_client(
        'tcp://127.0.0.1:8000',
        $errno,
        $error,
        1.0,
        STREAM_CLIENT_CONNECT
    );
    if (!is_resource($socket)) return null;
    stream_set_blocking($socket, true);
    stream_set_timeout($socket, 1);
    $request = "GET /stream HTTP/1.0\r\n"
        . "Host: 127.0.0.1\r\n"
        . "Connection: close\r\n"
        . "User-Agent: AvianVisitors-Educators\r\n\r\n";
    if (@fwrite($socket, $request) !== strlen($request)) {
        fclose($socket);
        return null;
    }
    $received = '';
    $headerEnd = false;
    $separatorLength = 0;
    while (strlen($received) <= AVIAN_EDUCATOR_AUDIO_HEADER_MAX) {
        $chunk = @fread($socket, 4096);
        if (!is_string($chunk) || $chunk === '') {
            fclose($socket);
            return null;
        }
        $received .= $chunk;
        $headerEnd = strpos($received, "\r\n\r\n");
        $separatorLength = 4;
        if ($headerEnd === false) {
            $headerEnd = strpos($received, "\n\n");
            $separatorLength = 2;
        }
        if ($headerEnd !== false) break;
    }
    if ($headerEnd === false || $headerEnd > AVIAN_EDUCATOR_AUDIO_HEADER_MAX) {
        fclose($socket);
        return null;
    }
    $headers = substr($received, 0, $headerEnd);
    $body = substr($received, $headerEnd + $separatorLength);
    $lines = preg_split('/\r?\n/', $headers);
    $status = is_array($lines) ? array_shift($lines) : null;
    if (!is_string($status)
        || preg_match('/\AHTTP\/1[.][01][ \t]+200(?:[ \t]|\z)/D', $status) !== 1) {
        fclose($socket);
        return null;
    }
    $contentType = null;
    foreach ($lines as $line) {
        if (!is_string($line) || strpbrk($line, "\0\r\n") !== false) {
            fclose($socket);
            return null;
        }
        if (stripos($line, 'Content-Type:') === 0) {
            if ($contentType !== null) {
                fclose($socket);
                return null;
            }
            $contentType = strtolower(trim(substr($line, strlen('Content-Type:'))));
        }
    }
    if ($contentType === null
        || preg_match('/\Aaudio\/mpeg(?:[ \t]*;[^\r\n]*)?\z/D', $contentType) !== 1) {
        fclose($socket);
        return null;
    }
    return [$socket, $body];
}

function educator_audio_session_check(string $cookie, int $epoch): bool {
    $errno = 0;
    $error = '';
    $socket = @stream_socket_client(
        'tcp://127.0.0.1:80',
        $errno,
        $error,
        1.0,
        STREAM_CLIENT_CONNECT
    );
    if (!is_resource($socket)) return false;
    stream_set_blocking($socket, true);
    stream_set_timeout($socket, 1);
    $request = "GET /avian/api/educator-audio-check.php HTTP/1.0\r\n"
        . "Host: localhost\r\n"
        . "Cookie: " . AVIAN_ADMIN_SESSION_NAME . "=$cookie\r\n"
        . "X-Avian-Educator-Epoch: $epoch\r\n"
        . "Connection: close\r\n\r\n";
    $written = @fwrite($socket, $request);
    if ($written !== strlen($request)) {
        fclose($socket);
        return false;
    }
    $line = @fgets($socket, 256);
    fclose($socket);
    return is_string($line)
        && preg_match('/\AHTTP\/1[.][01][ \t]+204(?:[ \t]|\r?\n|\z)/D', $line) === 1;
}

$server = $_SERVER;
$method = strtoupper((string)($server['REQUEST_METHOD'] ?? 'GET'));
if ($method !== 'GET') {
    educator_audio_fail(405, 'GET required', 'GET');
}
if (!avian_is_direct_local_request($server)) {
    educator_audio_fail(404, 'not found');
}
if (isset($server['HTTP_RANGE'])) {
    educator_audio_fail(416, 'range requests are not supported');
}
if (!avian_lan_admin_auth_required($server)) {
    educator_audio_fail(403, 'protected audio is available only when LAN password protection is enabled');
}
$profile = educator_profile_state();
if (empty($profile['valid']) || empty($profile['enabled'])) {
    educator_audio_fail(403, 'Educators mode is disabled');
}
$tokenValue = $_GET['grant'] ?? '';
$token = is_string($tokenValue) ? $tokenValue : '';
if (preg_match('/\A[a-f0-9]{48}\z/D', $token) !== 1) {
    educator_audio_fail(401, 'invalid or expired audio grant');
}
if (!function_exists('avian_consume_educator_audio_grant')) {
    educator_audio_fail(503, 'protected audio is unavailable');
}
$cookie = avian_consume_educator_audio_grant($server, $token);
if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
if (!is_string($cookie)
    || strlen($cookie) < 16
    || strlen($cookie) > 128
    || preg_match('/\A[A-Za-z0-9,-]+\z/D', $cookie) !== 1) {
    educator_audio_fail(401, 'invalid or expired audio grant');
}

$slot = educator_audio_slot();
if (!is_resource($slot)) {
    educator_audio_fail(429, 'two live audio listeners are already connected');
}
$upstream = educator_audio_open_upstream();
if (!is_array($upstream)) {
    flock($slot, LOCK_UN);
    fclose($slot);
    educator_audio_fail(503, 'live audio is unavailable');
}
[$audio, $initialBody] = $upstream;
if (!educator_audio_session_check($cookie, (int)$profile['epoch'])) {
    fclose($audio);
    flock($slot, LOCK_UN);
    fclose($slot);
    educator_audio_fail(401, 'audio session is no longer valid');
}

header('Content-Type: audio/mpeg');
header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header('Cross-Origin-Resource-Policy: same-origin');
header('X-Accel-Buffering: no');
while (ob_get_level() > 0) @ob_end_clean();
@set_time_limit(0);
ignore_user_abort(false);

$started = hrtime(true);
$nextCheck = $started + (AVIAN_EDUCATOR_AUDIO_CHECK_SECONDS * 1000000000);
$epoch = (int)$profile['epoch'];
if ($initialBody !== '') {
    echo $initialBody;
    flush();
}
while (!connection_aborted()
    && (hrtime(true) - $started) < (AVIAN_EDUCATOR_AUDIO_MAX_SECONDS * 1000000000)) {
    $now = hrtime(true);
    if ($now >= $nextCheck) {
        if (!educator_audio_session_check($cookie, $epoch)) break;
        $nextCheck = $now + (AVIAN_EDUCATOR_AUDIO_CHECK_SECONDS * 1000000000);
    }
    $chunk = @fread($audio, 16384);
    if (is_string($chunk) && $chunk !== '') {
        echo $chunk;
        flush();
        continue;
    }
    $meta = stream_get_meta_data($audio);
    if (!empty($meta['eof'])) break;
    if (empty($meta['timed_out'])) break;
}
fclose($audio);
flock($slot, LOCK_UN);
fclose($slot);
