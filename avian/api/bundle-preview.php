<?php
// Authenticated, same-origin preview for a catalog-declared bundle specimen.
// The caller supplies only a validated catalog ID and bounded preview index;
// the root-owned manager resolves and verifies the declared PNG object.

declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/bundle-runtime.php';

avian_require_admin();

function avian_bundle_preview_fail(int $status, string $error): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    header('Allow: GET');
    avian_bundle_preview_fail(405, 'GET required');
}
if (array_diff(array_keys($_GET), ['id', 'index']) !== []
    || count($_GET) !== 2
    || !is_string($_GET['id'] ?? null)
    || !avian_bundle_id_valid($_GET['id'])
    || !is_string($_GET['index'] ?? null)
    || preg_match('/\A[0-5]\z/D', $_GET['index']) !== 1) {
    avian_bundle_preview_fail(400, 'invalid bundle preview');
}

$result = avian_bundle_run_preview($_GET['id'], (int)$_GET['index']);
if (!$result['ok']) {
    avian_bundle_preview_fail((int)$result['status'], (string)$result['error']);
}
$bytes = $result['bytes'];
if (avian_bundle_png_dimensions($bytes) === null) {
    avian_bundle_preview_fail(502, 'bundle preview is invalid');
}
$digest = hash('sha256', $bytes);
$etag = '"avian-bundle-preview-' . $digest . '"';
header('ETag: ' . $etag);
header('Cache-Control: private, max-age=86400, immutable');
header('X-Content-Type-Options: nosniff');
if (trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) {
    http_response_code(304);
    exit;
}
header('Content-Type: image/png');
header('Content-Length: ' . strlen($bytes));
echo $bytes;
