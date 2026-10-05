<?php
// Loopback-only continuation check for a protected Educators audio stream.

declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/educator-state.php';

header('Cache-Control: private, no-store, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

$server = $_SERVER;
$method = strtoupper((string)($server['REQUEST_METHOD'] ?? 'GET'));
if ($method !== 'GET') {
    if ($method !== 'HEAD') header('Allow: GET');
    http_response_code(405);
    exit;
}
if ((string)($server['REMOTE_ADDR'] ?? '') !== '127.0.0.1'
    || !avian_is_direct_local_request($server)
    || isset($server['HTTP_RANGE'])) {
    http_response_code(404);
    exit;
}
if (!avian_lan_admin_auth_required($server)) {
    http_response_code(403);
    exit;
}
$profile = educator_profile_state();
$epoch = (string)($server['HTTP_X_AVIAN_EDUCATOR_EPOCH'] ?? '');
if (empty($profile['valid'])
    || empty($profile['enabled'])
    || preg_match('/\A(?:0|[1-9][0-9]{0,9})\z/D', $epoch) !== 1
    || !hash_equals((string)$profile['epoch'], $epoch)
    || !avian_admin_session_valid($server, null, false, false, true, false)) {
    http_response_code(403);
    exit;
}
http_response_code(204);
exit;
