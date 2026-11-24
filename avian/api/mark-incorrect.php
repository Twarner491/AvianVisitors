<?php
declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/educator-store.php';
require_once __DIR__ . '/detection-correction.php';

avian_require_admin();
avian_require_json_action();
$origin = (avian_request_is_https($_SERVER) ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? '');
if ((isset($_SERVER['HTTP_ORIGIN']) && strcasecmp($_SERVER['HTTP_ORIGIN'], $origin) !== 0)
    || !in_array($_SERVER['HTTP_SEC_FETCH_SITE'] ?? 'none', ['none', 'same-origin'], true)) {
    avian_api_fail(403, 'Same-origin request required');
}
$input = file_get_contents('php://input', false, null, 0, 513);
if (!is_string($input) || strlen($input) > 512) avian_api_fail(413, 'Request is too large');
$selection = json_decode($input, true);
if (!valid_correction_selection($selection)) avian_api_fail(400, 'Invalid detection selection');
try {
    // Clear/restore takes the exclusive lifecycle lock. Hold the shared lock
    // until the station user has committed, even for non-Educators stations.
    $lock = educator_store_lock(false);
    educator_assert_no_maintenance_marker();
    $process = proc_open(['/usr/bin/sudo', '-n', '/usr/local/sbin/avian-admin-control', 'mark-incorrect'],
        [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    if (!is_resource($process)) throw new RuntimeException();
    fwrite($pipes[0], json_encode($selection));
    fclose($pipes[0]);
    $status = proc_close($process);
} catch (Throwable $error) {
    $status = 1;
} finally {
    educator_store_unlock($lock ?? null);
}
if ($status === 2) avian_api_fail(409, 'This detection has changed. Reload the recordings before trying again.');
if ($status !== 0) avian_api_fail(503, 'Could not update the detection. Reload the recordings and try again.');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
echo '{"ok":true}';
