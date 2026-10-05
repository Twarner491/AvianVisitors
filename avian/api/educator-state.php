<?php
// Root-managed feature state for the optional Avian Visitors Educators UI.

declare(strict_types=1);

const AVIAN_EDUCATOR_STATE_DEFAULT_PATH = '/var/lib/avian-visitors/educators.state';
const AVIAN_EDUCATOR_MAINTENANCE_DEFAULT_PATH = '/var/lib/avian-visitors/educators.maintenance';
const AVIAN_EDUCATOR_STATE_MAX_BYTES = 64;
const AVIAN_EDUCATOR_EPOCH_MAX = 2147483647;

/** @return array{valid:bool,enabled:bool,epoch:int,error:?string} */
function educator_invalid_profile_state(string $error): array {
    return [
        'valid' => false,
        'enabled' => false,
        'epoch' => 0,
        'error' => $error,
    ];
}

function educator_profile_state_path(): string {
    $override = getenv('AV_EDUCATOR_STATE_FILE');
    return PHP_SAPI === 'cli' && is_string($override) && $override !== ''
        ? $override
        : AVIAN_EDUCATOR_STATE_DEFAULT_PATH;
}

function educator_maintenance_marker_path(): string {
    $override = getenv('AV_EDUCATOR_MAINTENANCE_FILE');
    return PHP_SAPI === 'cli' && is_string($override) && $override !== ''
        ? $override
        : AVIAN_EDUCATOR_MAINTENANCE_DEFAULT_PATH;
}

function educator_profile_state_metadata_is_valid(array $stat): bool {
    if (PHP_SAPI === 'cli' && getenv('AV_EDUCATOR_STATE_TEST_METADATA') === '1') {
        return true;
    }
    if (!function_exists('posix_getgrnam')) return false;
    $group = posix_getgrnam('caddy');
    return is_array($group) && isset($group['gid'])
        && (($stat['mode'] ?? 0) & 0170000) === 0100000
        && (int)($stat['uid'] ?? -1) === 0
        && (int)($stat['gid'] ?? -1) === (int)$group['gid']
        && (($stat['mode'] ?? 0) & 0777) === 0640
        && (int)($stat['nlink'] ?? 0) === 1;
}

function educator_profile_state_parent_is_valid(string $path): bool {
    if (PHP_SAPI === 'cli' && getenv('AV_EDUCATOR_STATE_TEST_METADATA') === '1') {
        return true;
    }
    $parent = @lstat(dirname($path));
    return is_array($parent)
        && (($parent['mode'] ?? 0) & 0170000) === 0040000
        && (int)($parent['uid'] ?? -1) === 0
        && (int)($parent['gid'] ?? -1) === 0
        && (($parent['mode'] ?? 0) & 0777) === 0755;
}

/** @return array{valid:bool,enabled:bool,epoch:int,error:?string} */
function educator_profile_state(?string $path = null): array {
    $path = $path ?? educator_profile_state_path();
    if (!educator_profile_state_parent_is_valid($path)) {
        return educator_invalid_profile_state('educator profile directory is unsafe');
    }

    clearstatcache(true, $path);
    $before = @lstat($path);
    if (!is_array($before) || !educator_profile_state_metadata_is_valid($before)) {
        return educator_invalid_profile_state('educator profile state is missing or unsafe');
    }
    $size = (int)($before['size'] ?? -1);
    if ($size < 1 || $size > AVIAN_EDUCATOR_STATE_MAX_BYTES) {
        return educator_invalid_profile_state('educator profile state has an invalid size');
    }

    $handle = @fopen($path, 'rb');
    if (!is_resource($handle)) {
        return educator_invalid_profile_state('educator profile state is unreadable');
    }
    $opened = fstat($handle);
    if (!is_array($opened)
        || !educator_profile_state_metadata_is_valid($opened)
        || (int)($opened['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($opened['ino'] ?? -1) !== (int)($before['ino'] ?? -2)) {
        fclose($handle);
        return educator_invalid_profile_state('educator profile state changed while opening');
    }
    $raw = stream_get_contents($handle, AVIAN_EDUCATOR_STATE_MAX_BYTES + 1);
    fclose($handle);
    if (!is_string($raw) || strlen($raw) !== $size) {
        return educator_invalid_profile_state('educator profile state could not be read');
    }
    clearstatcache(true, $path);
    $after = @lstat($path);
    if (!is_array($after)
        || (int)($after['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($after['ino'] ?? -1) !== (int)($before['ino'] ?? -2)) {
        return educator_invalid_profile_state('educator profile state changed while reading');
    }
    if (preg_match('/\Av1\t([01])\t(0|[1-9][0-9]{0,9})\n\z/D', $raw, $match) !== 1) {
        return educator_invalid_profile_state('educator profile state is malformed');
    }
    $epoch = (int)$match[2];
    if ($epoch > AVIAN_EDUCATOR_EPOCH_MAX) {
        return educator_invalid_profile_state('educator profile epoch is out of range');
    }
    return [
        'valid' => true,
        'enabled' => $match[1] === '1',
        'epoch' => $epoch,
        'error' => null,
    ];
}

/**
 * Fail closed when a clear or restore did not finish atomically. The root
 * lifecycle helper owns this marker and the canonical educator lock. Callers
 * must hold that lock before checking so a new maintenance operation cannot
 * begin between this check and the protected read.
 */
function educator_assert_no_maintenance_marker(?string $path = null): void {
    $path = $path ?? educator_maintenance_marker_path();
    clearstatcache(true, $path);
    $before = @lstat($path);
    if ($before === false) return;
    if (!is_array($before)
        || !educator_profile_state_parent_is_valid($path)
        || !educator_profile_state_metadata_is_valid($before)
        || (int)($before['size'] ?? -1) < 9
        || (int)($before['size'] ?? -1) > 32) {
        throw new RuntimeException('educator data maintenance needs recovery');
    }
    $handle = @fopen($path, 'rb');
    $opened = is_resource($handle) ? fstat($handle) : false;
    if (!is_resource($handle) || !is_array($opened)
        || !educator_profile_state_metadata_is_valid($opened)
        || (int)$opened['dev'] !== (int)$before['dev']
        || (int)$opened['ino'] !== (int)$before['ino']) {
        if (is_resource($handle)) fclose($handle);
        throw new RuntimeException('educator data maintenance needs recovery');
    }
    $raw = stream_get_contents($handle, 33);
    fclose($handle);
    clearstatcache(true, $path);
    $after = @lstat($path);
    if (!is_string($raw) || !is_array($after)
        || (int)$after['dev'] !== (int)$before['dev']
        || (int)$after['ino'] !== (int)$before['ino']
        || !in_array($raw, ["v1\tclear\n", "v1\trestore\n", "v1\trestore-committed\n"], true)) {
        throw new RuntimeException('educator data maintenance needs recovery');
    }
    throw new RuntimeException('educator data maintenance is in progress');
}
