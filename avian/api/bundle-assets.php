<?php
// Public, read-only geometry inventory for the exact active bird bundle.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, no-cache');
header('X-Content-Type-Options: nosniff');

require_once __DIR__ . '/bundle-runtime.php';

function avian_bundle_assets_fail(int $status, string $error): void {
    http_response_code($status);
    header('Cache-Control: no-store');
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
    header('Allow: GET');
    avian_bundle_assets_fail(405, 'GET required');
}
foreach ($_GET as $key => $value) {
    if (($key !== 'v' && $key !== 't') || !is_string($value)
        || preg_match('/\A[0-9A-Za-z._-]{1,80}\z/D', $value) !== 1) {
        avian_bundle_assets_fail(400, 'unsupported query');
    }
}

$active = avian_bundle_active_state();
if ($active['status'] !== 'ok') {
    avian_bundle_assets_fail(503, 'active bundle state is unavailable');
}
$tableLock = !empty($active['included'])
    ? avian_bundle_open_included_table_read_lock()
    : null;
if ($tableLock === false) {
    avian_bundle_assets_fail(503, 'active bundle inventory is changing');
}
$dims = avian_bundle_read_table($active, 'dims');
$masks = avian_bundle_read_table($active, 'masks');
if ($dims === null || $masks === null) {
    avian_bundle_close_included_table_read_lock($tableLock);
    avian_bundle_assets_fail(503, 'active bundle inventory is unavailable');
}
$dimKeys = array_keys($dims);
$maskKeys = array_keys($masks);
sort($dimKeys, SORT_STRING);
sort($maskKeys, SORT_STRING);
if ($dimKeys !== $maskKeys) {
    avian_bundle_close_included_table_read_lock($tableLock);
    avian_bundle_assets_fail(503, 'active bundle inventory is unavailable');
}

$species = [];
$poseCount = count($dims);
if (!$active['included']) {
    $index = avian_bundle_active_index($active);
    if ($index === null) avian_bundle_assets_fail(503, 'active bundle inventory is unavailable');
    $expected = [];
    foreach ($index['assets'] as $slug => $poses) {
        $species[$slug] = true;
        if (isset($poses['perched'])) $expected[] = $slug;
        if (isset($poses['flight'])) $expected[] = $slug . '-2';
    }
    sort($expected, SORT_STRING);
    $actual = array_keys($dims);
    sort($actual, SORT_STRING);
    if ($expected !== $actual) {
        avian_bundle_assets_fail(503, 'active bundle inventory is inconsistent');
    }
} else {
    foreach (array_keys($dims) as $key) {
        $species[str_ends_with($key, '-2') ? substr($key, 0, -2) : $key] = true;
    }
}

$contentRevision = avian_bundle_content_revision($active, $tableLock);
avian_bundle_close_included_table_read_lock($tableLock);
if ($contentRevision === null) {
    avian_bundle_assets_fail(503, 'active bundle inventory is unavailable');
}
$etag = '"avian-bundle-' . $active['revision']
    . ($active['included'] || isset($active['selection_revision']) ? '-' . $contentRevision : '') . '"';
header('ETag: ' . $etag);
if (trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) {
    http_response_code(304);
    exit;
}

echo json_encode([
    'ok' => true,
    'active' => [
        'id' => $active['id'],
        'version' => $active['version'],
        'revision' => $active['revision'],
        'included' => $active['included'],
        'name' => $active['name'],
        'content_revision' => $contentRevision,
        'species_count' => count($species),
        'pose_count' => $poseCount,
    ] + (isset($active['selection_revision']) ? ['selection_revision' => $active['selection_revision']] : []),
    'dims' => $dims,
    'masks' => $masks,
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
