<?php
// Species-only selection basis for a frame mirroring this station on the LAN.
declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/bundle-runtime.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function avian_bundle_species_fail(int $status, string $error): void {
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

if (!avian_is_direct_local_request($_SERVER)
    || !in_array($_SERVER['HTTP_SEC_FETCH_SITE'] ?? 'none', ['none', 'same-origin'], true)
    || !empty($_SERVER['HTTP_ORIGIN'])) {
    avian_bundle_species_fail(403, 'direct station access required');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    header('Allow: GET');
    avian_bundle_species_fail(405, 'GET required');
}
if ($_GET !== []) avian_bundle_species_fail(400, 'unsupported query');

$result = avian_bundle_run_manager(['selection-basis', '--json'], 60);
if (!$result['ok']) avian_bundle_species_fail((int)$result['status'], (string)$result['error']);
$basis = $result['result'];
if (!is_array($basis) || ($basis['ok'] ?? null) !== true || ($basis['schema_version'] ?? null) !== 1
    || !array_key_exists('species', $basis) || !array_key_exists('basis_sha256', $basis)) {
    avian_bundle_species_fail(503, 'local species are unavailable');
}
$names = $basis['species'];
$digest = $basis['basis_sha256'];
if ($names !== null || $digest !== null) {
    if (!is_array($names) || !array_is_list($names) || count($names) < 1 || count($names) > 12000
        || !is_string($digest) || preg_match('/\A[0-9a-f]{64}\z/D', $digest) !== 1) {
        avian_bundle_species_fail(503, 'local species are unavailable');
    }
    $previous = '';
    foreach ($names as $name) {
        if (!is_string($name) || strcmp($previous, $name) >= 0
            || preg_match('/\A[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}\z/D', $name) !== 1) {
            avian_bundle_species_fail(503, 'local species are unavailable');
        }
        $previous = $name;
    }
}
echo json_encode(['ok' => true, 'schema_version' => 1, 'species' => $names, 'basis_sha256' => $digest]);
