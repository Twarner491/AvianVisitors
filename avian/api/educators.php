<?php
// Administrative API for optional Educators listening periods and folders.

declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/educator-state.php';
require_once __DIR__ . '/educator-store.php';

function educator_api_error(int $status, string $message, array $extra = []): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    try {
        echo json_encode(['ok' => false, 'error' => $message] + $extra, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        http_response_code(503);
        echo '{"ok":false,"error":"Educators data could not be encoded"}';
    }
    exit;
}

function educator_api_enabled_profile(): array {
    $profile = educator_profile_state();
    if (empty($profile['valid']) || empty($profile['enabled'])) {
        educator_api_error(404, 'Educators mode is disabled');
    }
    return $profile;
}

function educator_api_decode_body(string $raw): array {
    if ($raw === '' || strlen($raw) > 4096) {
        throw new EducatorStoreError('invalid request', strlen($raw) > 4096 ? 413 : 400);
    }
    try {
        $body = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        throw new EducatorStoreError('invalid request');
    }
    if (!is_array($body) || array_is_list($body)) throw new EducatorStoreError('invalid request');
    return $body;
}

function educator_api_body(): array {
    $length = $_SERVER['CONTENT_LENGTH'] ?? null;
    if ($length !== null && (!ctype_digit((string)$length) || (int)$length > 4096)) {
        educator_api_error(413, 'request is too large');
    }
    $raw = file_get_contents('php://input', false, null, 0, 4097);
    try {
        return educator_api_decode_body(is_string($raw) ? $raw : '');
    } catch (EducatorStoreError $error) {
        educator_api_error($error->httpStatus, $error->getMessage());
    }
}

function educator_api_exact_keys(array $body, array $required, array $optional = []): void {
    foreach ($required as $key) {
        if (!array_key_exists($key, $body)) educator_api_error(400, "$key is required");
    }
    $allowed = array_fill_keys(array_merge($required, $optional), true);
    foreach (array_keys($body) as $key) {
        if (!is_string($key) || !isset($allowed[$key])) educator_api_error(400, 'unexpected request field');
    }
}

function educator_api_revision(array $body, string $key): int {
    $value = $body[$key] ?? null;
    if (!is_int($value) || $value < 0 || $value > 2147483647) {
        educator_api_error(400, "$key is invalid");
    }
    return $value;
}

function educator_api_id(array $body, string $key, string $kind): string {
    $value = $body[$key] ?? null;
    if (!is_string($value) || !educator_valid_public_id($value, $kind)) {
        educator_api_error(400, "$key is invalid");
    }
    return $value;
}

function educator_api_raw_query_parameter_count(string $name): ?int {
    if (!array_key_exists('QUERY_STRING', $_SERVER)) return null;
    $rawQuery = $_SERVER['QUERY_STRING'];
    if (!is_string($rawQuery) || strlen($rawQuery) > 1024) return -1;
    $count = 0;
    foreach (preg_split('/[&;]/', $rawQuery) ?: [] as $part) {
        $separator = strpos($part, '=');
        $rawKey = $separator === false ? $part : substr($part, 0, $separator);
        $key = rawurldecode(str_replace('+', ' ', $rawKey));
        $normalized = [];
        parse_str($rawKey . '=1', $normalized);
        if (array_key_exists($name, $normalized) && $key !== $name) return -1;
        if ($key === $name) $count++;
    }
    return $count;
}

function educator_api_exact_query_keys(array $query, array $required, array $optional = []): void {
    foreach ($required as $key) {
        if (!array_key_exists($key, $query)) throw new EducatorStoreError("$key is required");
    }
    $allowed = array_fill_keys(array_merge($required, $optional), true);
    foreach (array_keys($query) as $key) {
        if (!is_string($key) || !isset($allowed[$key])) {
            throw new EducatorStoreError('unexpected request field');
        }
    }
    foreach (array_keys($allowed) as $key) {
        $present = array_key_exists($key, $query);
        $rawCount = educator_api_raw_query_parameter_count($key);
        if ($rawCount !== null && $rawCount !== ($present ? 1 : 0)) {
            throw new EducatorStoreError('ambiguous request field');
        }
    }
}

function educator_api_capture_count_ids($raw): array {
    $maxBytes = (AVIAN_EDUCATOR_COUNT_BATCH_MAX * 34) + AVIAN_EDUCATOR_COUNT_BATCH_MAX - 1;
    if (!is_string($raw) || strlen($raw) < 34 || strlen($raw) > $maxBytes) {
        throw new EducatorStoreError('capture count ids are invalid');
    }
    $ids = explode(',', $raw);
    if (count($ids) < 1 || count($ids) > AVIAN_EDUCATOR_COUNT_BATCH_MAX) {
        throw new EducatorStoreError('capture count ids are invalid');
    }
    $seen = [];
    foreach ($ids as $id) {
        if (!educator_valid_public_id($id, 'capture')) {
            throw new EducatorStoreError('capture count id is invalid');
        }
        if (isset($seen[$id])) {
            throw new EducatorStoreError('capture count ids contain a duplicate');
        }
        $seen[$id] = true;
    }
    return $ids;
}

function educator_api_query_revision($raw): int {
    if (!is_string($raw)
        || preg_match('/\A(?:0|[1-9][0-9]{0,9})\z/D', $raw) !== 1
        || (int)$raw > 2147483647) {
        throw new EducatorStoreError('state_revision is invalid');
    }
    return (int)$raw;
}

function educator_api_response(
    SQLite3 $db,
    array $profile,
    array $extra = [],
    bool $includeActiveCounts = true
): never {
    $snapshot = educator_store_snapshot($db, $includeActiveCounts);
    $now = educator_now();
    $payload = [
        'ok' => true,
        'enabled' => true,
        'profile_epoch' => (int)$profile['epoch'],
        'server_time' => [
            'local' => educator_local_iso($now['local'], $now['offset']),
            'utc' => $now['utc'],
            'timezone' => $now['timezone'],
            'offset' => $now['offset'],
        ],
    ] + $snapshot + $extra;
    try {
        $encoded = json_encode($payload, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        educator_api_error(503, 'Educators data could not be encoded');
    }
    echo $encoded;
    exit;
}

if (defined('AVIAN_EDUCATORS_LIBRARY_ONLY')) return;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

educator_api_enabled_profile();
$preflightLock = null;
try {
    $preflightLock = educator_store_lock(false);
    educator_assert_no_maintenance_marker();
} catch (Throwable $error) {
    educator_store_unlock($preflightLock);
    educator_api_error(503, $error->getMessage());
}
educator_store_unlock($preflightLock);
avian_require_admin();
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST');
    educator_api_error(405, 'GET or POST required');
}

$lock = null;
$db = null;
try {
    if ($method === 'GET') {
        $profile = educator_api_enabled_profile();
        $lock = educator_store_lock(false);
        educator_assert_no_maintenance_marker();
        $profile = educator_api_enabled_profile();
        $db = educator_store_open(false);
        $getAction = $_GET['action'] ?? '';
        if (!is_string($getAction)) throw new EducatorStoreError('action is invalid');
        $rawActionCount = educator_api_raw_query_parameter_count('action');
        if ($rawActionCount !== null
            && $rawActionCount !== (array_key_exists('action', $_GET) ? 1 : 0)) {
            throw new EducatorStoreError('ambiguous request field');
        }
        if ($getAction !== '' && $getAction !== 'captures' && $getAction !== 'capture-counts') {
            throw new EducatorStoreError('unknown action', 404);
        }
        if ($getAction === 'captures') {
            educator_api_exact_query_keys($_GET, ['action'], ['cursor', 'limit']);
            $cursor = $_GET['cursor'] ?? null;
            if ($cursor !== null && !is_string($cursor)) throw new EducatorStoreError('capture cursor is invalid');
            $limitRaw = $_GET['limit'] ?? 100;
            if (is_array($limitRaw) || preg_match('/\A[1-9][0-9]{0,2}\z/D', (string)$limitRaw) !== 1) {
                throw new EducatorStoreError('capture limit is invalid');
            }
            $page = educator_store_capture_page($db, (int)$limitRaw, $cursor);
            try {
                $encoded = json_encode([
                'ok' => true,
                'enabled' => true,
                'profile_epoch' => (int)$profile['epoch'],
                'state_revision' => educator_state_revision($db),
                ] + $page, JSON_THROW_ON_ERROR);
            } catch (Throwable $error) {
                throw new EducatorStoreError('Educators data could not be encoded', 503);
            }
            echo $encoded;
            exit;
        }
        if ($getAction === 'capture-counts') {
            educator_api_exact_query_keys($_GET, ['action', 'ids', 'state_revision']);
            $stateRevision = educator_api_query_revision($_GET['state_revision']);
            $counts = educator_store_capture_counts(
                $db,
                educator_api_capture_count_ids($_GET['ids']),
                $stateRevision
            );
            try {
                $encoded = json_encode([
                    'ok' => true,
                    'enabled' => true,
                    'profile_epoch' => (int)$profile['epoch'],
                    'state_revision' => $stateRevision,
                    'counts' => $counts,
                ], JSON_THROW_ON_ERROR);
            } catch (Throwable $error) {
                throw new EducatorStoreError('Educators data could not be encoded', 503);
            }
            echo $encoded;
            exit;
        }
        if ($_GET !== [] && $_GET !== ['action' => '']) {
            throw new EducatorStoreError('unexpected request field');
        }
        educator_api_response($db, $profile);
    }

    avian_require_json_action();
    $body = educator_api_body();
    $action = $body['action'] ?? null;
    if (!is_string($action)) educator_api_error(400, 'action is required');
    $lock = educator_store_lock(true);
    educator_assert_no_maintenance_marker();
    $profile = educator_api_enabled_profile();
    $db = educator_store_open(false);

    if ($action === 'audio-grant') {
        educator_api_exact_keys($body, ['action', 'state_revision']);
        educator_expect_state_revision($db, educator_api_revision($body, 'state_revision'));
        $token = avian_create_educator_audio_grant($_SERVER);
        if (!is_string($token)) throw new EducatorStoreError('unlock the admin menu to hear live audio', 401);
        educator_api_response($db, $profile, [
            'token' => $token,
            'expires_in' => 15,
            'url' => '/avian/api/educator-audio.php?grant=' . rawurlencode($token),
        ], false);
    }

    $stateRevision = educator_api_revision($body, 'state_revision');
    $result = [];
    switch ($action) {
        case 'start':
            educator_api_exact_keys($body, ['action', 'state_revision'], ['name']);
            if (array_key_exists('name', $body) && !is_string($body['name'])) {
                educator_api_error(400, 'name is invalid');
            }
            $result = educator_store_start($db, $stateRevision, $body['name'] ?? null);
            break;
        case 'pause':
        case 'resume':
            educator_api_exact_keys($body, ['action', 'id', 'revision', 'state_revision']);
            $result = educator_store_transition(
                $db,
                $action,
                educator_api_id($body, 'id', 'capture'),
                educator_api_revision($body, 'revision'),
                $stateRevision
            );
            break;
        case 'stop':
            educator_api_exact_keys($body, ['action', 'id', 'revision', 'state_revision'], ['folder_id']);
            $folderId = $body['folder_id'] ?? null;
            if ($folderId !== null && (!is_string($folderId) || !educator_valid_public_id($folderId, 'folder'))) {
                educator_api_error(400, 'folder_id is invalid');
            }
            $result = educator_store_transition(
                $db,
                'stop',
                educator_api_id($body, 'id', 'capture'),
                educator_api_revision($body, 'revision'),
                $stateRevision,
                $folderId
            );
            break;
        case 'rename-capture':
            educator_api_exact_keys($body, ['action', 'id', 'revision', 'state_revision', 'name']);
            $result = educator_store_update_capture(
                $db,
                $action,
                educator_api_id($body, 'id', 'capture'),
                educator_api_revision($body, 'revision'),
                $stateRevision,
                $body['name']
            );
            break;
        case 'move-capture':
            educator_api_exact_keys($body, ['action', 'id', 'revision', 'state_revision', 'folder_id']);
            $result = educator_store_update_capture(
                $db,
                $action,
                educator_api_id($body, 'id', 'capture'),
                educator_api_revision($body, 'revision'),
                $stateRevision,
                $body['folder_id']
            );
            break;
        case 'delete-capture':
            educator_api_exact_keys($body, ['action', 'id', 'revision', 'state_revision']);
            $result = educator_store_delete_capture(
                $db,
                educator_api_id($body, 'id', 'capture'),
                educator_api_revision($body, 'revision'),
                $stateRevision
            );
            break;
        case 'create-folder':
            educator_api_exact_keys($body, ['action', 'state_revision', 'name']);
            if (!is_string($body['name'])) educator_api_error(400, 'name is invalid');
            $result = educator_store_create_folder($db, $body['name'], $stateRevision);
            break;
        case 'rename-folder':
            educator_api_exact_keys($body, ['action', 'id', 'revision', 'state_revision', 'name']);
            if (!is_string($body['name'])) educator_api_error(400, 'name is invalid');
            $result = educator_store_rename_folder(
                $db,
                educator_api_id($body, 'id', 'folder'),
                educator_api_revision($body, 'revision'),
                $stateRevision,
                $body['name']
            );
            break;
        case 'delete-folder':
            educator_api_exact_keys($body, ['action', 'id', 'revision', 'state_revision']);
            $result = educator_store_delete_folder(
                $db,
                educator_api_id($body, 'id', 'folder'),
                educator_api_revision($body, 'revision'),
                $stateRevision
            );
            break;
        default:
            throw new EducatorStoreError('unknown action', 404);
    }
    educator_api_response($db, $profile, ['result' => $result], false);
} catch (Throwable $error) {
    $extra = [];
    $status = 503;
    if ($error instanceof EducatorStoreError) {
        $status = $error->httpStatus;
        $extra = $error->details;
        if ($status === 409 && $db instanceof SQLite3) {
            try { $extra['current'] = educator_store_snapshot($db); } catch (Throwable $ignored) {}
        }
    }
    if ($db instanceof SQLite3) $db->close();
    educator_store_unlock($lock);
    educator_api_error($status, $error->getMessage(), $extra);
} finally {
    if ($db instanceof SQLite3) $db->close();
    educator_store_unlock($lock);
}
