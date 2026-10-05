<?php
// Narrow JSON facade for the optional Drive backup shown in Settings.
// The root-owned helper accepts only fixed actions and never returns OAuth
// tokens or rclone configuration contents.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/admin-auth.php';
avian_require_admin();

$control = getenv('AV_ARCHIVE_CONTROL') ?: '/usr/local/sbin/avian-archive-control';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

function archive_response(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function run_archive_control(string $control, string $action): array {
    if (!is_executable($control)) {
        return [
            'status' => 503,
            'body' => [
                'ok' => false,
                'error' => 'archive control is not installed',
                'hint' => 'reinstall services once after updating AvianVisitors',
            ],
        ];
    }
    $out = [];
    $rc = 0;
    exec('sudo -n ' . escapeshellarg($control) . ' ' . escapeshellarg($action) . ' 2>&1', $out, $rc);
    $raw = implode("\n", $out);
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return [
            'status' => 500,
            'body' => ['ok' => false, 'error' => 'archive control returned an invalid response'],
        ];
    }
    return ['status' => $rc === 0 ? 200 : 409, 'body' => $decoded];
}

if ($method === 'GET') {
    $result = run_archive_control($control, 'status');
    archive_response($result['status'], $result['body']);
}

avian_require_json_action();

$body = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($body)) {
    archive_response(400, ['ok' => false, 'error' => 'bad json']);
}
$action = (string)($body['action'] ?? '');
$allowed = ['install', 'enable', 'disable', 'run', 'purge-on', 'purge-off'];
if (!in_array($action, $allowed, true)) {
    archive_response(400, ['ok' => false, 'error' => 'unknown action']);
}
if ($action === 'purge-on' && ($body['confirm'] ?? '') !== 'verified-local-files') {
    archive_response(400, ['ok' => false, 'error' => 'cleanup confirmation required']);
}

$result = run_archive_control($control, $action);
archive_response($result['status'], $result['body']);
