<?php
// Narrow JSON facade for station updates shown under Tools. Public requests
// require the configured admin gate. Without it, maintenance is available
// only through a direct local hostname and a private-network connection.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/admin-auth.php';
avian_require_admin();

function maintenance_response(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

$control = getenv('AV_MAINTENANCE_CONTROL') ?: '/usr/local/sbin/avian-maintenance-control';

function run_maintenance_control(string $control, string $action): array {
    if (!is_executable($control)) {
        return ['status' => 503, 'body' => ['ok' => false, 'error' => 'maintenance control is not installed']];
    }
    $out = [];
    $rc = 0;
    exec('sudo -n ' . escapeshellarg($control) . ' ' . escapeshellarg($action) . ' 2>&1', $out, $rc);
    $decoded = json_decode(implode("\n", $out), true);
    if (!is_array($decoded)) {
        return ['status' => 500, 'body' => ['ok' => false, 'error' => 'maintenance control returned an invalid response']];
    }
    return ['status' => $rc === 0 ? 200 : 409, 'body' => $decoded];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'GET') {
    $result = run_maintenance_control($control, 'status');
    maintenance_response($result['status'], $result['body']);
}
avian_require_json_action();
$body = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($body)) maintenance_response(400, ['ok' => false, 'error' => 'bad json']);
$action = (string)($body['action'] ?? '');
$confirm = (string)($body['confirm'] ?? '');
$expected = ['update' => 'update-station', 'services' => 'reinstall-services'];
if (!isset($expected[$action]) || $confirm !== $expected[$action]) {
    maintenance_response(400, ['ok' => false, 'error' => 'maintenance confirmation required']);
}
$result = run_maintenance_control($control, $action);
maintenance_response($result['status'], $result['body']);
