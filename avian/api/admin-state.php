<?php
// Read the root-managed AvianVisitors admin credential state as data.

declare(strict_types=1);

const AVIAN_ADMIN_STATE_DEFAULT_PATH = '/var/lib/avian-visitors/admin-auth.state';
const AVIAN_ADMIN_STATE_MAX_BYTES = 256;
const AVIAN_ADMIN_EPOCH_MAX = 2147483647;

/** @return array{valid:bool,required:bool,epoch:string,verifier:?string,configured:bool,error:?string} */
function avian_invalid_admin_state(string $error): array {
    return [
        'valid' => false,
        'required' => true,
        'epoch' => 'invalid',
        'verifier' => null,
        'configured' => false,
        'error' => $error,
    ];
}

function avian_admin_state_path(): string {
    $override = getenv('AV_ADMIN_STATE_FILE');
    return is_string($override) && $override !== ''
        ? $override
        : AVIAN_ADMIN_STATE_DEFAULT_PATH;
}

function avian_admin_state_metadata_is_valid(array $stat): bool {
    // CLI tests may use a private temporary fixture. HTTP runtimes never skip
    // ownership checks, even if an environment variable is accidentally set.
    if (PHP_SAPI === 'cli' && getenv('AV_ADMIN_STATE_TEST_METADATA') === '1') {
        return true;
    }
    if (!function_exists('posix_getgrnam')) return false;
    $group = posix_getgrnam('caddy');
    if (!is_array($group) || !isset($group['gid'])) return false;
    return (($stat['mode'] ?? 0) & 0170000) === 0100000
        && (int)($stat['uid'] ?? -1) === 0
        && (int)($stat['gid'] ?? -1) === (int)$group['gid']
        && (($stat['mode'] ?? 0) & 0777) === 0640
        && (int)($stat['nlink'] ?? 0) === 1;
}

function avian_admin_state_parent_is_valid(string $path): bool {
    if (PHP_SAPI === 'cli' && getenv('AV_ADMIN_STATE_TEST_METADATA') === '1') {
        return true;
    }
    $parent = @lstat(dirname($path));
    return is_array($parent)
        && (($parent['mode'] ?? 0) & 0170000) === 0040000
        && (int)($parent['uid'] ?? -1) === 0
        && (int)($parent['gid'] ?? -1) === 0
        && (($parent['mode'] ?? 0) & 0777) === 0755;
}

/** @return array{valid:bool,required:bool,epoch:string,verifier:?string,configured:bool,error:?string} */
function avian_admin_state(?string $path = null): array {
    $path = $path ?? avian_admin_state_path();
    if (!avian_admin_state_parent_is_valid($path)) {
        return avian_invalid_admin_state('admin credential state directory is unsafe');
    }
    clearstatcache(true, $path);
    $before = @lstat($path);
    if (!is_array($before) || !avian_admin_state_metadata_is_valid($before)) {
        return avian_invalid_admin_state('admin credential state is missing or unsafe');
    }
    $size = (int)($before['size'] ?? -1);
    if ($size < 1 || $size > AVIAN_ADMIN_STATE_MAX_BYTES) {
        return avian_invalid_admin_state('admin credential state has an invalid size');
    }

    $handle = @fopen($path, 'rb');
    if (!is_resource($handle)) {
        return avian_invalid_admin_state('admin credential state is unreadable');
    }
    $opened = fstat($handle);
    if (!is_array($opened)
        || !avian_admin_state_metadata_is_valid($opened)
        || (int)($opened['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($opened['ino'] ?? -1) !== (int)($before['ino'] ?? -2)) {
        fclose($handle);
        return avian_invalid_admin_state('admin credential state changed while opening');
    }
    $raw = stream_get_contents($handle, AVIAN_ADMIN_STATE_MAX_BYTES + 1);
    fclose($handle);
    if (!is_string($raw) || strlen($raw) !== $size) {
        return avian_invalid_admin_state('admin credential state could not be read');
    }
    clearstatcache(true, $path);
    $after = @lstat($path);
    if (!is_array($after)
        || (int)($after['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($after['ino'] ?? -1) !== (int)($before['ino'] ?? -2)) {
        return avian_invalid_admin_state('admin credential state changed while reading');
    }

    if (preg_match(
        '/\Av1\t([01])\t(0|[1-9][0-9]{0,9})\t(-|\$2y\$14\$[.\/A-Za-z0-9]{53})\n\z/D',
        $raw,
        $match
    ) !== 1) {
        return avian_invalid_admin_state('admin credential state is malformed');
    }
    $epoch = (int)$match[2];
    if ($epoch > AVIAN_ADMIN_EPOCH_MAX) {
        return avian_invalid_admin_state('admin credential epoch is out of range');
    }
    $verifier = $match[3] === '-' ? null : $match[3];
    return [
        'valid' => true,
        'required' => $match[1] === '1',
        'epoch' => (string)$epoch,
        'verifier' => $verifier,
        'configured' => is_string($verifier),
        'error' => null,
    ];
}

function avian_admin_password_is_supported(string $password, int $minimum = 1): bool {
    $length = strlen($password);
    if ($minimum < 1 || $length < $minimum || $length > 64) return false;
    if ($minimum <= 1) {
        return preg_match('/[\x00-\x1F\x7F]/D', $password) !== 1;
    }
    return preg_match('/\A[A-Za-z0-9]+\z/D', $password) === 1;
}

function avian_admin_password_matches(string $password, ?array $state = null): bool {
    if (!avian_admin_password_is_supported($password, 1)) return false;
    $state = $state ?? avian_admin_state();
    $verifier = $state['verifier'] ?? null;
    return !empty($state['valid'])
        && is_string($verifier)
        && password_verify($password, $verifier);
}
