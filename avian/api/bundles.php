<?php
// Authenticated station bundle library API.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/bundle-runtime.php';

avian_require_admin();

function avian_bundles_respond(int $status, array $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function avian_bundles_exact_keys(array $body, array $expected): bool {
    $actual = array_keys($body);
    sort($actual, SORT_STRING);
    sort($expected, SORT_STRING);
    return $actual === $expected;
}

function avian_bundles_manager_failure(array $result): void {
    avian_bundles_respond((int)$result['status'], [
        'ok' => false,
        'error' => (string)$result['error'],
    ]);
}

function avian_bundles_snapshot(): array {
    $result = avian_bundle_run_manager(['snapshot', '--json'], 30);
    if (!$result['ok']) avian_bundles_manager_failure($result);
    $snapshot = $result['result'];
    if (!is_array($snapshot) || array_is_list($snapshot)
        || ($snapshot['ok'] ?? null) !== true) {
        avian_bundles_respond(502, ['ok' => false, 'error' => 'bundle manager returned an invalid snapshot']);
    }
    return $snapshot;
}

function avian_bundles_normalize_id(string $id): string {
    if ($id === 'woodblock' || $id === 'japanese-woodblock') {
        return AVIAN_BUNDLE_INCLUDED_ID;
    }
    return $id;
}

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'GET') {
    $readAction = $_GET === [] ? 'snapshot' : ($_GET['action'] ?? null);
    if (!is_string($readAction)
        || !in_array($readAction, ['snapshot', 'status'], true)
        || ($_GET !== [] && $_GET !== ['action' => $readAction])) {
        avian_bundles_respond(400, ['ok' => false, 'error' => 'unsupported query']);
    }
    $snapshot = avian_bundles_snapshot();
    if ($readAction === 'status') {
        avian_bundles_respond(200, [
            'ok' => true,
            'job' => $snapshot['job'] ?? null,
            'active' => $snapshot['library']['active'] ?? null,
        ]);
    }
    avian_bundles_respond(200, $snapshot);
}

if ($method !== 'POST') {
    header('Allow: GET, POST');
    avian_bundles_respond(405, ['ok' => false, 'error' => 'GET or POST required']);
}

avian_require_json_action();
$contentLength = $_SERVER['CONTENT_LENGTH'] ?? null;
if (is_string($contentLength)
    && (!ctype_digit($contentLength) || (int)$contentLength > 4096)) {
    avian_bundles_respond(413, ['ok' => false, 'error' => 'request body is too large']);
}
$raw = file_get_contents('php://input', false, null, 0, 4097);
if (!is_string($raw) || strlen($raw) > 4096) {
    avian_bundles_respond(413, ['ok' => false, 'error' => 'request body is too large']);
}
try {
    $body = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
} catch (JsonException $error) {
    avian_bundles_respond(400, ['ok' => false, 'error' => 'bad json']);
}
if (!is_array($body) || array_is_list($body) || !is_string($body['action'] ?? null)) {
    avian_bundles_respond(400, ['ok' => false, 'error' => 'invalid bundle action']);
}

$action = $body['action'];
$arguments = ['enqueue', '--action', $action];
if ($action === 'use') {
    if (!avian_bundles_exact_keys($body, ['action', 'id'])
        || !is_string($body['id'])) {
        avian_bundles_respond(400, ['ok' => false, 'error' => 'invalid use request']);
    }
    $id = avian_bundles_normalize_id($body['id']);
    if (!avian_bundle_id_valid($id)) {
        avian_bundles_respond(400, ['ok' => false, 'error' => 'invalid use request']);
    }
    // Resolve location locally on every use, including an already active bundle.
    $arguments = ['enqueue', '--action', 'use', '--id', $id, '--json'];
} elseif ($action === 'install' || $action === 'update') {
    if (!avian_bundles_exact_keys($body, ['action', 'activate', 'id'])
        || !is_string($body['id']) || !avian_bundle_id_valid($body['id'])
        || !is_bool($body['activate'])) {
        avian_bundles_respond(400, ['ok' => false, 'error' => 'invalid install request']);
    }
    $arguments[] = '--id';
    $arguments[] = $body['id'];
    if ($body['activate']) $arguments[] = '--activate';
} elseif ($action === 'activate' || $action === 'remove') {
    if (!avian_bundles_exact_keys($body, ['action', 'id', 'version'])
        || !is_string($body['id']) || !avian_bundle_id_valid($body['id'])
        || !is_string($body['version']) || !avian_bundle_version_valid($body['version'])) {
        avian_bundles_respond(400, ['ok' => false, 'error' => 'invalid bundle version request']);
    }
    $arguments[] = '--id';
    $arguments[] = $body['id'];
    $arguments[] = '--version';
    $arguments[] = $body['version'];
} elseif ($action === 'rollback' || $action === 'refresh') {
    if (!avian_bundles_exact_keys($body, ['action'])) {
        avian_bundles_respond(400, ['ok' => false, 'error' => 'invalid bundle request']);
    }
} else {
    avian_bundles_respond(400, ['ok' => false, 'error' => 'unsupported bundle action']);
}
if ($action !== 'use') $arguments[] = '--json';
$result = avian_bundle_run_manager($arguments, 15);
if (!$result['ok']) avian_bundles_manager_failure($result);
$accepted = (array)$result['result'];
$accepted['accepted'] = true;
avian_bundles_respond(202, $accepted);
