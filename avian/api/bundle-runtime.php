<?php
// Read-only helpers for resolving the station-wide bird bundle.
//
// This file is an include, not a public endpoint. Caddy deliberately leaves it
// outside the reviewed API allowlist. Bundle files are data only and remain
// outside the webroot under /var/lib/avian-visitors/bundles.

declare(strict_types=1);

const AVIAN_BUNDLE_ROOT_DEFAULT = '/var/lib/avian-visitors/bundles';
const AVIAN_BUNDLE_PROVISIONED_MARKER = '/var/lib/avian-visitors/bundles-v1.enabled';
const AVIAN_BUNDLE_STATE_MAX_BYTES = 16384;
const AVIAN_BUNDLE_INDEX_MAX_BYTES = 4_194_304;
// 10,000 max-size mask rows are about 15 MiB; keep table data separately
// bounded with headroom instead of weakening manifest or state limits.
const AVIAN_BUNDLE_TABLE_MAX_BYTES = 25_165_824;
const AVIAN_BUNDLE_MAX_OBJECT_BYTES = 4_194_304;
const AVIAN_BUNDLE_MAX_OBJECTS = 10000;
const AVIAN_BUNDLE_MAX_IMAGE_SIDE = 4096;
const AVIAN_BUNDLE_MAX_IMAGE_PIXELS = 16000000;
const AVIAN_BUNDLE_SCIENTIFIC_SLUG_MAX = 163;
const AVIAN_BUNDLE_INCLUDED_ID = 'official-western-us-woodblock';
const AVIAN_BUNDLE_INCLUDED_VERSION = '1.0.0';
const AVIAN_BUNDLE_INCLUDED_REVISION = 'included-woodblock-v1';
const AVIAN_BUNDLE_GENERATION_LOCK = '/run/lock/avian-generation.lock';
const AVIAN_BUNDLE_ART_REVISION_STATE = '/var/lib/avian-visitors/included-art.revision';

/** @return array{status:string,id:string,version:string,revision:string,included:bool,name:string} */
function avian_bundle_included_state(): array {
    return [
        'status' => 'ok',
        'id' => AVIAN_BUNDLE_INCLUDED_ID,
        'version' => AVIAN_BUNDLE_INCLUDED_VERSION,
        'revision' => AVIAN_BUNDLE_INCLUDED_REVISION,
        'included' => true,
        'name' => 'Japanese Woodblock',
    ];
}

/** @return array{status:string,id:string,version:string,revision:string,included:bool,name:string} */
function avian_bundle_invalid_state(): array {
    return [
        'status' => 'invalid',
        'id' => '',
        'version' => '',
        'revision' => '',
        'included' => false,
        'name' => '',
    ];
}

function avian_bundle_id_valid(string $value): bool {
    return preg_match('/\A[a-z0-9][a-z0-9._-]{0,79}\z/D', $value) === 1;
}

function avian_bundle_version_valid(string $value): bool {
    if (strlen($value) > 64 || preg_match(
        '/\A(?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)'
        . '(?:-[0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?'
        . '(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?\z/D',
        $value
    ) !== 1) return false;
    $withoutBuild = explode('+', $value, 2)[0];
    $dash = strpos($withoutBuild, '-');
    if ($dash === false) return true;
    foreach (explode('.', substr($withoutBuild, $dash + 1)) as $identifier) {
        if (ctype_digit($identifier) && strlen($identifier) > 1 && $identifier[0] === '0') return false;
    }
    return true;
}

function avian_bundle_revision_valid(string $value): bool {
    return preg_match('/\A[0-9a-f]{64}\z/D', $value) === 1;
}

function avian_bundle_slug_valid(string $value): bool {
    return strlen($value) <= AVIAN_BUNDLE_SCIENTIFIC_SLUG_MAX
        && preg_match('/\A[a-z0-9]+(?:-[a-z0-9]+)+\z/D', $value) === 1;
}

/** @return array{status:string,id:string,version:string,revision:string,included:bool,name:string}|null */
function avian_bundle_reference_state($value): ?array {
    if (!is_array($value) || array_is_list($value)) return null;
    $keys = array_keys($value);
    sort($keys, SORT_STRING);
    $selected = array_key_exists('selection_revision', $value);
    $expected = ['id', 'included', 'name', 'revision', 'version'];
    if ($selected) { $expected[] = 'selection_revision'; sort($expected, SORT_STRING); }
    if ($keys !== $expected) return null;
    $included = $value['included'];
    $id = $value['id'];
    $version = $value['version'];
    $revision = $value['revision'];
    $name = $value['name'];
    if ($selected && ($included !== false || !is_string($value['selection_revision'])
        || !avian_bundle_revision_valid($value['selection_revision']))) return null;
    if (!is_bool($included) || !is_string($id) || !is_string($version)
        || !is_string($revision) || !is_string($name)
        || preg_match('/\A.{1,90}\z/usD', $name) !== 1
        || preg_match('/[\x00-\x1F\x7F]/D', $name) === 1) return null;
    if ($included) {
        if ($id !== AVIAN_BUNDLE_INCLUDED_ID
            || $version !== AVIAN_BUNDLE_INCLUDED_VERSION
            || $revision !== AVIAN_BUNDLE_INCLUDED_REVISION
            || $name !== 'Japanese Woodblock') return null;
    } elseif (!avian_bundle_id_valid($id)
        || !avian_bundle_version_valid($version)
        || !avian_bundle_revision_valid($revision)) {
        return null;
    }
    $state = [
        'status' => 'ok',
        'id' => $id,
        'version' => $version,
        'revision' => $revision,
        'included' => $included,
        'name' => $name,
    ];
    if ($selected) $state['selection_revision'] = $value['selection_revision'];
    return $state;
}

function avian_bundle_root(): string {
    $configured = getenv('AVIAN_BUNDLE_ROOT');
    $root = is_string($configured) && $configured !== ''
        ? $configured
        : AVIAN_BUNDLE_ROOT_DEFAULT;
    if ($root === '' || $root[0] !== '/' || strlen($root) > 512 || str_contains($root, "\0")) {
        return '';
    }
    foreach (explode('/', $root) as $part) {
        if ($part === '..') return '';
    }
    return rtrim($root, '/');
}

function avian_bundle_mode_type(array $stat): int {
    return ((int)($stat['mode'] ?? 0)) & 0170000;
}

function avian_bundle_provisioned_marker_path(): string {
    $override = getenv('AVIAN_BUNDLE_PROVISIONED_MARKER');
    if (PHP_SAPI !== 'cli' || !is_string($override) || $override === '') {
        return AVIAN_BUNDLE_PROVISIONED_MARKER;
    }
    if ($override[0] !== '/' || strlen($override) > 512 || str_contains($override, "\0")) {
        return '';
    }
    foreach (explode('/', $override) as $part) {
        if ($part === '..') return '';
    }
    return rtrim($override, '/');
}

/** @return 'absent'|'present'|'invalid' */
function avian_bundle_provisioned_marker_state(): string {
    $path = avian_bundle_provisioned_marker_path();
    if ($path === '') return 'invalid';
    clearstatcache(true, $path);
    $stat = @lstat($path);
    if (!is_array($stat)) return is_link($path) ? 'invalid' : 'absent';
    $requiresRoot = $path === AVIAN_BUNDLE_PROVISIONED_MARKER;
    if (avian_bundle_mode_type($stat) !== 0100000
        || (int)($stat['nlink'] ?? 0) !== 1
        || ($requiresRoot && (
            (int)($stat['uid'] ?? -1) !== 0
            || (int)($stat['gid'] ?? -1) !== 0
        ))
        || (((int)$stat['mode']) & 0022) !== 0) {
        return 'invalid';
    }
    return 'present';
}

/** @return array{status:string,id:string,version:string,revision:string,included:bool,name:string} */
function avian_bundle_missing_root_state(string $root): array {
    if ($root !== AVIAN_BUNDLE_ROOT_DEFAULT) return avian_bundle_included_state();
    return avian_bundle_provisioned_marker_state() === 'absent'
        ? avian_bundle_included_state()
        : avian_bundle_invalid_state();
}

function avian_bundle_requires_root_owner(string $path): bool {
    $root = avian_bundle_root();
    if ($root !== AVIAN_BUNDLE_ROOT_DEFAULT) return false;
    return $path === $root || str_starts_with($path, $root . '/');
}

function avian_bundle_safe_directory(string $path): bool {
    clearstatcache(true, $path);
    $stat = @lstat($path);
    $requiresRoot = avian_bundle_requires_root_owner($path);
    return is_array($stat)
        && avian_bundle_mode_type($stat) === 0040000
        && (!$requiresRoot || (
            (int)($stat['uid'] ?? -1) === 0
            && (int)($stat['gid'] ?? -1) === 0
        ))
        && (((int)$stat['mode']) & 0022) === 0;
}

function avian_bundle_is_mutable_included_table(string $path): bool {
    $frontend = dirname(__DIR__) . '/frontend';
    return $path === $frontend . '/dims.json' || $path === $frontend . '/masks.json';
}

function avian_bundle_mutable_included_table_stat(array $stat): bool {
    $permissions = ((int)($stat['mode'] ?? 0)) & 0777;
    if ($permissions !== 0644 && $permissions !== 0660) return false;
    if (($permissions & 0020) !== 0) {
        if (!function_exists('posix_getegid')
            || (int)($stat['gid'] ?? -1) !== posix_getegid()) return false;
    }
    return true;
}

function avian_bundle_generation_lock_path(): string {
    $override = getenv('AVIAN_GENERATION_LOCK');
    if ((PHP_SAPI === 'cli' || PHP_SAPI === 'cli-server')
        && is_string($override) && $override !== '') {
        if ($override[0] !== '/' || strlen($override) > 512 || str_contains($override, "\0")) {
            return '';
        }
        foreach (explode('/', $override) as $part) {
            if ($part === '..') return '';
        }
        return $override;
    }
    return AVIAN_BUNDLE_GENERATION_LOCK;
}

function avian_bundle_art_revision_state_path(): string {
    $override = getenv('AVIAN_ART_REVISION_STATE');
    if ((PHP_SAPI === 'cli' || PHP_SAPI === 'cli-server')
        && is_string($override) && $override !== '') {
        if ($override[0] !== '/' || strlen($override) > 512 || str_contains($override, "\0")) {
            return '';
        }
        foreach (explode('/', $override) as $part) {
            if ($part === '..') return '';
        }
        return $override;
    }
    return AVIAN_BUNDLE_ART_REVISION_STATE;
}

/**
 * Hold a coherent read view across the two mutable included geometry tables.
 * The on-device generator and checkout updater already hold this same inode
 * exclusively across PNG and table mutations. A missing lock is allowed only
 * for an unprovisioned source checkout; a provisioned station fails closed.
 *
 * @return resource|false|null acquired resource, failure, or no lock required
 */
function avian_bundle_open_included_table_read_lock() {
    $path = avian_bundle_generation_lock_path();
    if ($path === '') return false;
    $isDefault = $path === AVIAN_BUNDLE_GENERATION_LOCK;
    if ($isDefault && avian_bundle_root() !== AVIAN_BUNDLE_ROOT_DEFAULT) return null;

    clearstatcache(true, $path);
    $before = @lstat($path);
    if (!is_array($before)) {
        if (!$isDefault) return false;
        $root = avian_bundle_root();
        clearstatcache(true, $root);
        $rootAbsent = $root === AVIAN_BUNDLE_ROOT_DEFAULT
            && !file_exists($root) && !is_link($root);
        return $rootAbsent && avian_bundle_provisioned_marker_state() === 'absent'
            ? null : false;
    }
    $permissions = ((int)($before['mode'] ?? 0)) & 0777;
    if (avian_bundle_mode_type($before) !== 0100000
        || (int)($before['nlink'] ?? 0) !== 1
        || ($isDefault && (
            (int)($before['uid'] ?? -1) !== 0 || $permissions !== 0660
        ))
        || (!$isDefault && $permissions !== 0600)) {
        return false;
    }
    $handle = @fopen($path, 'rb');
    if (!is_resource($handle)) return false;
    $opened = fstat($handle);
    if (!is_array($opened)
        || avian_bundle_mode_type($opened) !== 0100000
        || (int)($opened['nlink'] ?? 0) !== 1
        || (int)($opened['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($opened['ino'] ?? -1) !== (int)($before['ino'] ?? -2)
        || !@flock($handle, LOCK_SH | LOCK_NB)) {
        fclose($handle);
        return false;
    }
    return $handle;
}

function avian_bundle_close_included_table_read_lock($handle): void {
    if (!is_resource($handle)) return;
    @flock($handle, LOCK_UN);
    fclose($handle);
}

function avian_bundle_read_art_revision_state($tableLock): ?string {
    $path = avian_bundle_art_revision_state_path();
    if ($path === '') return null;
    $isDefault = $path === AVIAN_BUNDLE_ART_REVISION_STATE;
    clearstatcache(true, $path);
    $before = @lstat($path);
    if (!is_array($before)) {
        if (!$isDefault || is_link($path)) return null;
        $root = avian_bundle_root();
        clearstatcache(true, $root);
        $unprovisioned = $root === AVIAN_BUNDLE_ROOT_DEFAULT
            && !file_exists($root) && !is_link($root)
            && avian_bundle_provisioned_marker_state() === 'absent';
        return $unprovisioned ? 'unprovisioned' : null;
    }
    $permissions = ((int)($before['mode'] ?? 0)) & 0777;
    $lockStat = is_resource($tableLock) ? fstat($tableLock) : null;
    if (avian_bundle_mode_type($before) !== 0100000
        || (int)($before['nlink'] ?? 0) !== 1
        || ($isDefault && (
            (int)($before['uid'] ?? -1) !== 0
            || $permissions !== 0660
            || !is_array($lockStat)
            || (int)($before['gid'] ?? -1) !== (int)($lockStat['gid'] ?? -2)
        ))
        || (!$isDefault && $permissions !== 0600)) return null;

    $handle = @fopen($path, 'rb');
    if (!is_resource($handle)) return null;
    $opened = fstat($handle);
    $raw = stream_get_contents($handle, 66);
    fclose($handle);
    if (!is_array($opened) || !is_string($raw)
        || (int)($opened['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($opened['ino'] ?? -1) !== (int)($before['ino'] ?? -2)
        || (int)($opened['size'] ?? -1) !== 65
        || preg_match('/\A[0-9a-f]{64}\n\z/D', $raw) !== 1) return null;
    return substr($raw, 0, 64);
}

function avian_bundle_content_revision(array $active, $tableLock = null): ?string {
    if (empty($active['included'])) {
        $revision = $active['selection_revision'] ?? $active['revision'] ?? null;
        return is_string($revision) && avian_bundle_revision_valid($revision)
            ? $revision : null;
    }

    $commit = avian_bundle_read_art_revision_state($tableLock);
    if ($commit === null) return null;

    // Bundle-assets validates the table bytes once. Cutout requests need only
    // this O(1) file-identity snapshot plus the commit nonce written under the
    // exclusive generation lock. That avoids re-hashing ~818 KB for every bird.
    $frontend = dirname(__DIR__) . '/frontend';
    $files = [];
    foreach (['dims.json', 'masks.json'] as $name) {
        $path = $frontend . '/' . $name;
        clearstatcache(true, $path);
        $stat = @lstat($path);
        if (!is_array($stat)
            || avian_bundle_mode_type($stat) !== 0100000
            || (int)($stat['nlink'] ?? 0) !== 1
            || !avian_bundle_mutable_included_table_stat($stat)) return null;
        $size = (int)($stat['size'] ?? -1);
        if ($size < 0 || $size > AVIAN_BUNDLE_TABLE_MAX_BYTES) return null;
        $files[$name] = [
            'dev' => (int)($stat['dev'] ?? -1),
            'ino' => (int)($stat['ino'] ?? -1),
            'size' => $size,
            'mtime' => (int)($stat['mtime'] ?? -1),
            'ctime' => (int)($stat['ctime'] ?? -1),
            'mode' => ((int)($stat['mode'] ?? 0)) & 0777,
        ];
    }
    $material = json_encode(
        ['commit' => $commit, 'files' => $files],
        JSON_UNESCAPED_SLASHES
    );
    return is_string($material) ? hash('sha256', $material) : null;
}

/** @return array{0:resource,1:array}|null */
function avian_bundle_open_regular(
    string $path,
    int $maxBytes,
    ?string $within = null,
    bool $allowMutableIncludedTable = false
): ?array {
    clearstatcache(true, $path);
    $before = @lstat($path);
    $requiresRoot = avian_bundle_requires_root_owner($path);
    $mutableIncluded = $allowMutableIncludedTable && avian_bundle_is_mutable_included_table($path);
    if (!is_array($before)
        || avian_bundle_mode_type($before) !== 0100000
        || (int)($before['nlink'] ?? 0) !== 1
        || ($requiresRoot && (
            (int)($before['uid'] ?? -1) !== 0
            || (int)($before['gid'] ?? -1) !== 0
        ))
        || ($mutableIncluded
            ? !avian_bundle_mutable_included_table_stat($before)
            : (((int)$before['mode']) & 0022) !== 0)) {
        return null;
    }
    $size = (int)($before['size'] ?? -1);
    if ($size < 0 || $size > $maxBytes) return null;
    $handle = @fopen($path, 'rb');
    if (!is_resource($handle)) return null;
    $opened = fstat($handle);
    if (!is_array($opened)
        || avian_bundle_mode_type($opened) !== 0100000
        || (int)($opened['nlink'] ?? 0) !== 1
        || ($requiresRoot && (
            (int)($opened['uid'] ?? -1) !== 0
            || (int)($opened['gid'] ?? -1) !== 0
        ))
        || ($mutableIncluded
            ? !avian_bundle_mutable_included_table_stat($opened)
            : (((int)$opened['mode']) & 0022) !== 0)
        || (int)($opened['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($opened['ino'] ?? -1) !== (int)($before['ino'] ?? -2)
        || (int)($opened['size'] ?? -1) !== $size) {
        fclose($handle);
        return null;
    }
    if ($within !== null) {
        $realRoot = @realpath($within);
        $realPath = @realpath($path);
        $canonical = is_string($realPath) ? @lstat($realPath) : false;
        if (!is_string($realRoot) || !is_string($realPath)
            || ($realPath !== $realRoot && !str_starts_with($realPath, rtrim($realRoot, '/') . '/'))
            || !is_array($canonical)
            || avian_bundle_mode_type($canonical) !== 0100000
            || (int)($canonical['dev'] ?? -1) !== (int)($opened['dev'] ?? -2)
            || (int)($canonical['ino'] ?? -1) !== (int)($opened['ino'] ?? -2)) {
            fclose($handle);
            return null;
        }
    }
    return [$handle, $opened];
}

/** @return array<string,mixed>|null */
function avian_bundle_read_json(
    string $path,
    int $maxBytes,
    ?string $within = null,
    bool $allowMutableIncludedTable = false
): ?array {
    $opened = avian_bundle_open_regular(
        $path,
        $maxBytes,
        $within,
        $allowMutableIncludedTable
    );
    if ($opened === null) return null;
    [$handle, $stat] = $opened;
    $size = (int)$stat['size'];
    $raw = stream_get_contents($handle, $maxBytes + 1);
    fclose($handle);
    if (!is_string($raw) || strlen($raw) !== $size) return null;
    try {
        $decoded = json_decode($raw, true, 128, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        return null;
    }
    return is_array($decoded) && !array_is_list($decoded) ? $decoded : null;
}

/** @return array{status:string,id:string,version:string,revision:string,included:bool,name:string} */
function avian_bundle_active_state(): array {
    $root = avian_bundle_root();
    if ($root === '') return avian_bundle_invalid_state();

    clearstatcache(true, $root);
    if (!file_exists($root) && !is_link($root)) {
        // Source checkouts and pre-migration stations use the included art.
        // Once provisioning has left its root-owned marker, losing the entire
        // library must not silently change an external style to Woodblock.
        return avian_bundle_missing_root_state($root);
    }
    if (!avian_bundle_safe_directory($root)) return avian_bundle_invalid_state();

    $statePath = $root . '/active.json';
    clearstatcache(true, $statePath);
    if (!file_exists($statePath) && !is_link($statePath)) {
        // A provisioned library is initialized atomically. Losing its active
        // record must not silently change an external style to the built-in.
        return avian_bundle_invalid_state();
    }
    $state = avian_bundle_read_json($statePath, AVIAN_BUNDLE_STATE_MAX_BYTES, $root);
    if ($state === null) return avian_bundle_invalid_state();
    $stateKeys = array_keys($state);
    sort($stateKeys, SORT_STRING);
    if ($stateKeys !== ['active', 'previous', 'schema_version']
        || ($state['schema_version'] ?? null) !== 1) {
        return avian_bundle_invalid_state();
    }
    $active = avian_bundle_reference_state($state['active']);
    $previous = $state['previous'] === null
        ? null : avian_bundle_reference_state($state['previous']);
    if ($active === null || ($state['previous'] !== null && $previous === null)) {
        return avian_bundle_invalid_state();
    }
    return $active;
}

function avian_bundle_pack_directory(array $active): string {
    $root = avian_bundle_root();
    if ($root === '' || !avian_bundle_safe_directory($root)) return '';
    $packs = $root . '/packs';
    $idDir = $packs . '/' . $active['id'];
    $versionDir = $idDir . '/' . $active['version'];
    foreach ([$packs, $idDir, $versionDir] as $directory) {
        if (!avian_bundle_safe_directory($directory)) return '';
    }
    if (isset($active['selection_revision'])) {
        if (!is_string($active['selection_revision'])
            || !avian_bundle_revision_valid($active['selection_revision'])) return '';
        $selections = $versionDir . '/selections';
        $profile = $selections . '/' . $active['selection_revision'];
        if (!avian_bundle_safe_directory($selections)
            || !avian_bundle_safe_directory($profile)) return '';
        return $profile;
    }
    return $versionDir;
}

function avian_bundle_selection_matches(array $state, string $directory, array $assets): bool {
    $opened = avian_bundle_open_regular($directory . '/selection.json', AVIAN_BUNDLE_INDEX_MAX_BYTES, avian_bundle_root());
    if ($opened === null) return false;
    [$handle, $stat] = $opened;
    $raw = stream_get_contents($handle, AVIAN_BUNDLE_INDEX_MAX_BYTES + 1);
    fclose($handle);
    if (!is_string($raw) || strlen($raw) !== (int)$stat['size']
        || !hash_equals($state['selection_revision'], hash('sha256', $raw))) return false;
    try { $selection = json_decode($raw, true, 16, JSON_THROW_ON_ERROR); }
    catch (JsonException $error) { return false; }
    if (!is_array($selection) || array_is_list($selection)) return false;
    $keys = array_keys($selection);
    sort($keys, SORT_STRING);
    if ($keys !== ['basis_sha256', 'manifest_sha256', 'mode', 'schema_version', 'species']
        || $selection['schema_version'] !== 1
        || !in_array($selection['mode'], ['local', 'all'], true)
        || $selection['manifest_sha256'] !== $state['revision']
        || !is_string($selection['basis_sha256'])
        || !avian_bundle_revision_valid($selection['basis_sha256'])
        || !is_array($selection['species']) || !array_is_list($selection['species'])
        || count($selection['species']) < 1 || count($selection['species']) > 5000) return false;
    $slugs = [];
    $previous = '';
    foreach ($selection['species'] as $name) {
        if (!is_string($name) || strcmp($previous, $name) >= 0
            || preg_match('/\A[A-Z][A-Za-z-]{1,39}(?: [a-z][A-Za-z-]{1,39}){1,3}\z/D', $name) !== 1) return false;
        $previous = $name;
        $slugs[] = trim((string)preg_replace('/[^a-z0-9]+/', '-', strtolower($name)), '-');
    }
    $actual = array_keys($assets);
    sort($slugs, SORT_STRING);
    sort($actual, SORT_STRING);
    return $slugs === $actual;
}

/** @return array<string,mixed>|null */
function avian_bundle_index_for_state(array $state): ?array {
    if (($state['status'] ?? '') !== 'ok' || !empty($state['included'])) return null;
    $directory = avian_bundle_pack_directory($state);
    if ($directory === '') return null;
    $index = avian_bundle_read_json(
        $directory . '/index.json',
        AVIAN_BUNDLE_INDEX_MAX_BYTES,
        avian_bundle_root()
    );
    if ($index === null) return null;
    $indexKeys = array_keys($index);
    sort($indexKeys, SORT_STRING);
    $expectedKeys = ['assets', 'id', 'revision', 'schema_version', 'version'];
    if (isset($state['selection_revision'])) {
        $expectedKeys[] = 'selection_revision'; sort($expectedKeys, SORT_STRING);
    }
    if ($indexKeys !== $expectedKeys
        || ($index['schema_version'] ?? null) !== 1
        || ($index['id'] ?? null) !== $state['id']
        || ($index['version'] ?? null) !== $state['version']
        || ($index['revision'] ?? null) !== $state['revision']
        || ($index['selection_revision'] ?? null) !== ($state['selection_revision'] ?? null)) {
        return null;
    }
    $assets = $index['assets'] ?? null;
    if (!is_array($assets) || array_is_list($assets) || $assets === []
        || count($assets) > AVIAN_BUNDLE_MAX_OBJECTS) {
        return null;
    }
    $poseCount = 0;
    foreach ($assets as $slug => $poses) {
        if (!is_string($slug) || !avian_bundle_slug_valid($slug)
            || !is_array($poses) || array_is_list($poses)) {
            return null;
        }
        if (array_diff(array_keys($poses), ['perched', 'flight']) !== []) return null;
        if ($poses === []) return null;
        foreach ($poses as $pose => $object) {
            if (($pose !== 'perched' && $pose !== 'flight')
                || !is_array($object) || array_is_list($object)
                || array_diff(array_keys($object), ['sha256', 'bytes']) !== []) {
                return null;
            }
            $sha = $object['sha256'] ?? null;
            $bytes = $object['bytes'] ?? null;
            if (!is_string($sha) || !avian_bundle_revision_valid($sha)
                || !is_int($bytes) || $bytes < 67 || $bytes > AVIAN_BUNDLE_MAX_OBJECT_BYTES) {
                return null;
            }
            $poseCount++;
            if ($poseCount > AVIAN_BUNDLE_MAX_OBJECTS) return null;
        }
    }
    if (isset($state['selection_revision'])
        && !avian_bundle_selection_matches($state, $directory, $assets)) return null;
    return $index;
}

/** @return array<string,mixed>|null */
function avian_bundle_active_index(array $active): ?array {
    return avian_bundle_index_for_state($active);
}

/**
 * Resolve a geometry revision to the same immutable pack that produced it.
 * This lets a browser which loaded tables just before a switch finish loading
 * matching images instead of mixing the new active art with stale geometry.
 *
 * @return array{status:string,id:string,version:string,revision:string,included:bool,name:string}
 */
function avian_bundle_state_for_revision(string $revision, ?string $content = null): array {
    $active = avian_bundle_active_state();
    if ($active['status'] !== 'ok') return avian_bundle_invalid_state();
    if ($content !== null && !avian_bundle_revision_valid($content)) return avian_bundle_invalid_state();
    if (hash_equals($active['revision'], $revision)
        && (!empty($active['included'])
            || ($active['selection_revision'] ?? null) === $content
            || (!isset($active['selection_revision']) && $content === $revision))) return $active;
    if ($revision === AVIAN_BUNDLE_INCLUDED_REVISION) return avian_bundle_included_state();
    if (!avian_bundle_revision_valid($revision)) return avian_bundle_invalid_state();

    $root = avian_bundle_root();
    $packs = $root . '/packs';
    if ($root === '' || !avian_bundle_safe_directory($root)
        || !avian_bundle_safe_directory($packs)) return avian_bundle_invalid_state();
    $ids = @scandir($packs);
    if (!is_array($ids) || count($ids) > 1002) return avian_bundle_invalid_state();
    $match = null;
    $visited = 0;
    foreach ($ids as $id) {
        if ($id === '.' || $id === '..') continue;
        if (!avian_bundle_id_valid($id)) continue;
        $idDirectory = $packs . '/' . $id;
        if (!avian_bundle_safe_directory($idDirectory)) return avian_bundle_invalid_state();
        $versions = @scandir($idDirectory);
        if (!is_array($versions) || count($versions) > 130) return avian_bundle_invalid_state();
        foreach ($versions as $version) {
            if ($version === '.' || $version === '..') continue;
            if (!avian_bundle_version_valid($version)) continue;
            $visited++;
            if ($visited > 2000) return avian_bundle_invalid_state();
            $versionDirectory = $idDirectory . '/' . $version;
            if (!avian_bundle_safe_directory($versionDirectory)) return avian_bundle_invalid_state();
            $directory = $versionDirectory;
            if ($content !== null && $content !== $revision) {
                $directory .= '/selections/' . $content;
                if (!avian_bundle_safe_directory($versionDirectory . '/selections')
                    || !avian_bundle_safe_directory($directory)) continue;
            }
            $meta = avian_bundle_read_json(
                $directory . '/meta.json',
                65536,
                $root
            );
            if ($meta === null) continue;
            $metaKeys = array_keys($meta);
            sort($metaKeys, SORT_STRING);
            $reference = $metaKeys === ['installed_at', 'reference']
                ? avian_bundle_reference_state($meta['reference'] ?? null)
                : null;
            if ($reference === null || $reference['included']
                || $reference['id'] !== $id
                || $reference['version'] !== $version
                || $reference['revision'] !== $revision
                || ($reference['selection_revision'] ?? $revision) !== ($content ?? $revision)) {
                continue;
            }
            $candidate = $reference;
            $index = avian_bundle_index_for_state($candidate);
            if ($index === null || ($index['revision'] ?? null) !== $revision) continue;
            if ($match !== null) return avian_bundle_invalid_state();
            $match = $candidate;
        }
    }
    return $match ?? avian_bundle_invalid_state();
}

/** @return array{sha256:string,bytes:int}|null */
function avian_bundle_resolve_object(array $index, string $slug, int $pose): ?array {
    if (!avian_bundle_slug_valid($slug)) return null;
    $poseName = $pose === 2 ? 'flight' : 'perched';
    $object = $index['assets'][$slug][$poseName] ?? null;
    if (!is_array($object)) return null;
    $sha = $object['sha256'] ?? null;
    $bytes = $object['bytes'] ?? null;
    return is_string($sha) && avian_bundle_revision_valid($sha)
        && is_int($bytes) && $bytes >= 67 && $bytes <= AVIAN_BUNDLE_MAX_OBJECT_BYTES
        ? ['sha256' => $sha, 'bytes' => $bytes]
        : null;
}

/** @return array{0:resource,1:array}|null */
function avian_bundle_open_object(array $object): ?array {
    $root = avian_bundle_root();
    $sha = (string)($object['sha256'] ?? '');
    $bytes = $object['bytes'] ?? null;
    if ($root === '' || !avian_bundle_revision_valid($sha) || !is_int($bytes)) return null;
    $objects = $root . '/objects';
    $shaRoot = $objects . '/sha256';
    $prefix = $shaRoot . '/' . substr($sha, 0, 2);
    foreach ([$root, $objects, $shaRoot, $prefix] as $directory) {
        if (!avian_bundle_safe_directory($directory)) return null;
    }
    $opened = avian_bundle_open_regular(
        $prefix . '/' . $sha . '.png',
        AVIAN_BUNDLE_MAX_OBJECT_BYTES,
        $root
    );
    if ($opened === null || (int)$opened[1]['size'] !== $bytes) {
        if ($opened !== null) fclose($opened[0]);
        return null;
    }
    $signature = fread($opened[0], 8);
    if ($signature !== "\x89PNG\r\n\x1a\n") {
        fclose($opened[0]);
        return null;
    }
    rewind($opened[0]);
    $header = fread($opened[0], 24);
    if (!is_string($header) || avian_bundle_png_dimensions($header) === null) {
        fclose($opened[0]);
        return null;
    }
    rewind($opened[0]);
    $hash = hash_init('sha256');
    if (hash_update_stream($hash, $opened[0]) !== $bytes
        || !hash_equals($sha, hash_final($hash))) {
        fclose($opened[0]);
        return null;
    }
    rewind($opened[0]);
    return $opened;
}

/** @return array<string,mixed>|null */
function avian_bundle_read_table(array $active, string $kind): ?array {
    if ($kind !== 'dims' && $kind !== 'masks') return null;
    if (!empty($active['included'])) {
        $path = dirname(__DIR__) . '/frontend/' . $kind . '.json';
    } else {
        $directory = avian_bundle_pack_directory($active);
        if ($directory === '') return null;
        $path = $directory . '/' . $kind . '.json';
    }
    $table = avian_bundle_read_json(
        $path,
        AVIAN_BUNDLE_TABLE_MAX_BYTES,
        !empty($active['included']) ? null : avian_bundle_root(),
        !empty($active['included'])
    );
    if ($table === null || count($table) > AVIAN_BUNDLE_MAX_OBJECTS) return null;
    foreach ($table as $key => $value) {
        $base = str_ends_with((string)$key, '-2') ? substr((string)$key, 0, -2) : (string)$key;
        if (!is_string($key) || !avian_bundle_slug_valid($base)) return null;
        if ($kind === 'dims') {
            if (!is_array($value) || count($value) !== 2
                || !is_int($value[0] ?? null) || !is_int($value[1] ?? null)
                || $value[0] < 1 || $value[1] < 1 || $value[0] > 560 || $value[1] > 560) {
                return null;
            }
        } else {
            if (!is_array($value) || array_is_list($value)
                || array_diff(array_keys($value), ['w', 'h', 'bits']) !== []) return null;
            $w = $value['w'] ?? null;
            $h = $value['h'] ?? null;
            $bits = $value['bits'] ?? null;
            $decoded = is_string($bits) && strlen($bits) <= 2048
                ? base64_decode($bits, true) : false;
            if (!is_int($w) || !is_int($h) || $w < 1 || $h < 1 || $w > 93 || $h > 93
                || !is_string($decoded) || strlen($decoded) !== intdiv($w * $h + 7, 8)
                || trim($decoded, "\0") === '') {
                return null;
            }
        }
    }
    return $table;
}

function avian_bundle_png_dimensions(string $bytes): ?array {
    if (strlen($bytes) < 24 || substr($bytes, 0, 8) !== "\x89PNG\r\n\x1a\n"
        || substr($bytes, 12, 4) !== 'IHDR') return null;
    $unpacked = unpack('Nwidth/Nheight', substr($bytes, 16, 8));
    $width = (int)($unpacked['width'] ?? 0);
    $height = (int)($unpacked['height'] ?? 0);
    if ($width < 1 || $height < 1 || $width > AVIAN_BUNDLE_MAX_IMAGE_SIDE
        || $height > AVIAN_BUNDLE_MAX_IMAGE_SIDE
        || $width * $height > AVIAN_BUNDLE_MAX_IMAGE_PIXELS) return null;
    return [$width, $height];
}

function avian_bundle_control_command(): array {
    $override = getenv('AVIAN_BUNDLE_CONTROL');
    if (PHP_SAPI === 'cli' && is_string($override) && $override !== '') {
        if ($override[0] === '/' && strlen($override) <= 512 && !str_contains($override, "\0")
            && is_file($override) && !is_link($override) && is_executable($override)) {
            return [$override];
        }
        return [];
    }
    $sudo = '/usr/bin/sudo';
    $helper = '/usr/local/sbin/avian-bundle-control';
    clearstatcache(true, $helper);
    $stat = @lstat($helper);
    if (!is_file($sudo) || !is_executable($sudo) || !is_array($stat)
        || avian_bundle_mode_type($stat) !== 0100000
        || (int)($stat['uid'] ?? -1) !== 0 || (int)($stat['gid'] ?? -1) !== 0
        || (((int)$stat['mode']) & 0777) !== 0755 || (int)($stat['nlink'] ?? 0) !== 1
        || is_link($helper) || !is_executable($helper)) {
        return [];
    }
    return [$sudo, '-n', $helper];
}

/**
 * Run the fixed bundle manager without a shell and decode one bounded JSON
 * object. User-controlled values are still validated by each endpoint before
 * reaching this function; argv array execution prevents shell interpretation.
 *
 * @return array{ok:bool,status:int,result:?array,error:string}
 */
function avian_bundle_run_manager(array $arguments, int $timeoutSeconds = 20): array {
    $control = avian_bundle_control_command();
    if ($control === []) {
        return ['ok' => false, 'status' => 503, 'result' => null, 'error' => 'bundle manager is unavailable'];
    }
    if (count($arguments) > 16) {
        return ['ok' => false, 'status' => 500, 'result' => null, 'error' => 'bundle manager arguments are invalid'];
    }
    foreach ($arguments as $argument) {
        if (!is_string($argument) || strlen($argument) > 256 || str_contains($argument, "\0")) {
            return ['ok' => false, 'status' => 500, 'result' => null, 'error' => 'bundle manager arguments are invalid'];
        }
    }

    $command = array_merge($control, $arguments);
    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    $pipes = [];
    $process = @proc_open($command, $descriptors, $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        return ['ok' => false, 'status' => 503, 'result' => null, 'error' => 'bundle manager could not start'];
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $stdout = '';
    $stderr = '';
    $deadline = microtime(true) + max(1, min(60, $timeoutSeconds));
    $exitCode = null;
    $failed = false;
    while (true) {
        $stdoutChunk = stream_get_contents($pipes[1]);
        $stderrChunk = stream_get_contents($pipes[2]);
        if (is_string($stdoutChunk)) $stdout .= $stdoutChunk;
        if (is_string($stderrChunk)) $stderr .= $stderrChunk;
        if (strlen($stdout) > 4_194_304 || strlen($stderr) > 65_536) {
            $failed = true;
            @proc_terminate($process, 9);
            break;
        }
        $status = proc_get_status($process);
        if (!is_array($status) || empty($status['running'])) {
            if (is_array($status) && is_int($status['exitcode']) && $status['exitcode'] >= 0) {
                $exitCode = $status['exitcode'];
            }
            break;
        }
        if (microtime(true) >= $deadline) {
            $failed = true;
            @proc_terminate($process, 9);
            break;
        }
        usleep(20000);
    }
    $tail = stream_get_contents($pipes[1]);
    $errorTail = stream_get_contents($pipes[2]);
    if (is_string($tail)) $stdout .= $tail;
    if (is_string($errorTail)) $stderr .= $errorTail;
    fclose($pipes[1]);
    fclose($pipes[2]);
    $closed = proc_close($process);
    if ($exitCode === null && is_int($closed) && $closed >= 0) $exitCode = $closed;
    if ($failed || strlen($stdout) > 4_194_304 || strlen($stderr) > 65_536) {
        return ['ok' => false, 'status' => 503, 'result' => null, 'error' => 'bundle manager did not return safely'];
    }
    try {
        $decoded = json_decode($stdout, true, 128, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        return ['ok' => false, 'status' => 502, 'result' => null, 'error' => 'bundle manager returned an invalid response'];
    }
    if (!is_array($decoded) || array_is_list($decoded) || !is_bool($decoded['ok'] ?? null)) {
        return ['ok' => false, 'status' => 502, 'result' => null, 'error' => 'bundle manager returned an invalid response'];
    }
    if ($exitCode !== 0 || $decoded['ok'] !== true) {
        $message = is_string($decoded['error'] ?? null)
            ? trim((string)$decoded['error'])
            : 'bundle operation could not be started';
        if ($message === '' || strlen($message) > 240 || preg_match('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/D', $message)) {
            $message = 'bundle operation could not be started';
        }
        return ['ok' => false, 'status' => 409, 'result' => $decoded, 'error' => $message];
    }
    return ['ok' => true, 'status' => 200, 'result' => $decoded, 'error' => ''];
}

/** @return array{ok:bool,status:int,bytes:string,error:string} */
function avian_bundle_run_preview(string $id, int $index): array {
    if (!avian_bundle_id_valid($id) || $index < 0 || $index > 5) {
        return ['ok' => false, 'status' => 400, 'bytes' => '', 'error' => 'invalid bundle preview'];
    }
    $control = avian_bundle_control_command();
    if ($control === []) {
        return ['ok' => false, 'status' => 503, 'bytes' => '', 'error' => 'bundle manager is unavailable'];
    }
    $command = array_merge($control, ['preview', '--id', $id, '--index', (string)$index]);
    $pipes = [];
    $process = @proc_open($command, [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ], $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        return ['ok' => false, 'status' => 503, 'bytes' => '', 'error' => 'bundle preview could not start'];
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $bytes = '';
    $stderr = '';
    $deadline = microtime(true) + 20;
    $exitCode = null;
    $failed = false;
    while (true) {
        $chunk = stream_get_contents($pipes[1]);
        $errorChunk = stream_get_contents($pipes[2]);
        if (is_string($chunk)) $bytes .= $chunk;
        if (is_string($errorChunk)) $stderr .= $errorChunk;
        if (strlen($bytes) > AVIAN_BUNDLE_MAX_OBJECT_BYTES || strlen($stderr) > 65536) {
            $failed = true;
            @proc_terminate($process, 9);
            break;
        }
        $status = proc_get_status($process);
        if (!is_array($status) || empty($status['running'])) {
            if (is_array($status) && is_int($status['exitcode']) && $status['exitcode'] >= 0) {
                $exitCode = $status['exitcode'];
            }
            break;
        }
        if (microtime(true) >= $deadline) {
            $failed = true;
            @proc_terminate($process, 9);
            break;
        }
        usleep(20000);
    }
    $tail = stream_get_contents($pipes[1]);
    $errorTail = stream_get_contents($pipes[2]);
    if (is_string($tail)) $bytes .= $tail;
    if (is_string($errorTail)) $stderr .= $errorTail;
    fclose($pipes[1]);
    fclose($pipes[2]);
    $closed = proc_close($process);
    if ($exitCode === null && is_int($closed) && $closed >= 0) $exitCode = $closed;
    if ($failed || $exitCode !== 0 || $bytes === ''
        || strlen($bytes) > AVIAN_BUNDLE_MAX_OBJECT_BYTES) {
        return ['ok' => false, 'status' => $exitCode === 2 ? 404 : 503, 'bytes' => '', 'error' => 'bundle preview is unavailable'];
    }
    return ['ok' => true, 'status' => 200, 'bytes' => $bytes, 'error' => ''];
}
