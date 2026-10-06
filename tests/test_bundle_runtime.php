<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/avian/api/bundle-runtime.php';

$checks = 0;
function check_bundle(bool $condition, string $message): void {
    global $checks;
    $checks++;
    if (!$condition) {
        fwrite(STDERR, "FAIL: $message\n");
        exit(1);
    }
}

function write_bundle_json(string $path, array $value): void {
    file_put_contents($path, json_encode($value, JSON_UNESCAPED_SLASHES) . "\n");
    chmod($path, 0640);
}

function make_bundle_directory(string $path): void {
    if (!is_dir($path)) mkdir($path, 0750, true);
    chmod($path, 0750);
}

function remove_bundle_fixture(string $path): void {
    if (is_link($path) || is_file($path)) {
        unlink($path);
        return;
    }
    if (!is_dir($path)) return;
    foreach (array_diff(scandir($path), ['.', '..']) as $child) {
        remove_bundle_fixture($path . '/' . $child);
    }
    rmdir($path);
}

$root = sys_get_temp_dir() . '/avian-bundle-runtime-' . bin2hex(random_bytes(8));
$missing = $root . '-missing';
putenv('AVIAN_BUNDLE_ROOT=' . $missing);
check_bundle(avian_bundle_active_state()['included'] === true, 'absent library uses included bundle');

$provisionedMarker = $root . '-provisioned';
file_put_contents($provisionedMarker, '');
chmod($provisionedMarker, 0640);
putenv('AVIAN_BUNDLE_PROVISIONED_MARKER=' . $provisionedMarker);
check_bundle(
    avian_bundle_missing_root_state(AVIAN_BUNDLE_ROOT_DEFAULT)['status'] === 'invalid',
    'provisioned default library missing its root fails closed'
);
unlink($provisionedMarker);
check_bundle(
    avian_bundle_missing_root_state(AVIAN_BUNDLE_ROOT_DEFAULT)['included'] === true,
    'pre-migration default library without a marker uses included bundle'
);
file_put_contents($provisionedMarker, '');
chmod($provisionedMarker, 0660);
check_bundle(
    avian_bundle_missing_root_state(AVIAN_BUNDLE_ROOT_DEFAULT)['status'] === 'invalid',
    'unsafe provisioned marker fails closed'
);
unlink($provisionedMarker);
putenv('AVIAN_BUNDLE_PROVISIONED_MARKER');
check_bundle(
    avian_bundle_missing_root_state($missing)['included'] === true,
    'override roots retain the source-checkout fallback'
);

make_bundle_directory($root);
putenv('AVIAN_BUNDLE_ROOT=' . $root);
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'provisioned library without state fails closed');

$included = avian_bundle_included_state();
write_bundle_json($root . '/active.json', [
    'schema_version' => 1,
    'active' => array_diff_key($included, ['status' => true]),
    'previous' => null,
]);
$state = avian_bundle_active_state();
check_bundle($state['status'] === 'ok' && $state['revision'] === AVIAN_BUNDLE_INCLUDED_REVISION, 'included state loads');

$fixture = dirname(__DIR__) . '/avian/assets/illustrations/corvus-brachyrhynchos.png';
check_bundle(is_file($fixture), 'checked-in PNG fixture exists');
$objectHash = hash_file('sha256', $fixture);
$objectBytes = filesize($fixture);
$revisionOne = str_repeat('1', 64);
$revisionTwo = str_repeat('2', 64);

make_bundle_directory($root . '/objects/sha256/' . substr($objectHash, 0, 2));
copy($fixture, $root . '/objects/sha256/' . substr($objectHash, 0, 2) . '/' . $objectHash . '.png');
chmod($root . '/objects/sha256/' . substr($objectHash, 0, 2) . '/' . $objectHash . '.png', 0640);
make_bundle_directory($root . '/packs/test-pack/1.0.0');
$index = [
    'schema_version' => 1,
    'id' => 'test-pack',
    'version' => '1.0.0',
    'revision' => $revisionOne,
    'assets' => [
        'corvus-brachyrhynchos' => [
            'perched' => ['sha256' => $objectHash, 'bytes' => $objectBytes],
        ],
    ],
];
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $index);
write_bundle_json($root . '/packs/test-pack/1.0.0/meta.json', [
    'reference' => [
        'id' => 'test-pack', 'version' => '1.0.0', 'revision' => $revisionOne,
        'included' => false, 'name' => 'Test pack',
    ],
    'installed_at' => '2026-09-01T00:00:00Z',
]);
write_bundle_json($root . '/packs/test-pack/1.0.0/dims.json', [
    'corvus-brachyrhynchos' => [560, 400],
]);
write_bundle_json($root . '/packs/test-pack/1.0.0/masks.json', [
    'corvus-brachyrhynchos' => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\x80")],
]);
$custom = [
    'id' => 'test-pack',
    'version' => '1.0.0',
    'revision' => $revisionOne,
    'included' => false,
    'name' => 'Test pack',
];
write_bundle_json($root . '/active.json', [
    'schema_version' => 1,
    'active' => $custom,
    'previous' => array_diff_key($included, ['status' => true]),
]);
$state = avian_bundle_active_state();
check_bundle($state['status'] === 'ok' && !$state['included'], 'custom active state loads');
$unicodeName = str_repeat("\u{9CE5}", 90);
$unicodeState = $custom;
$unicodeState['name'] = $unicodeName;
write_bundle_json($root . '/active.json', [
    'schema_version' => 1,
    'active' => $unicodeState,
    'previous' => null,
]);
check_bundle(
    strlen($unicodeName) === 270 && avian_bundle_active_state()['name'] === $unicodeName,
    'active bundle name accepts 90 Unicode code points independent of UTF-8 bytes'
);
$unicodeState['name'] .= "\u{9CE5}";
write_bundle_json($root . '/active.json', [
    'schema_version' => 1,
    'active' => $unicodeState,
    'previous' => null,
]);
check_bundle(
    avian_bundle_active_state()['status'] === 'invalid',
    'active bundle name rejects 91 Unicode code points'
);
write_bundle_json($root . '/active.json', [
    'schema_version' => 1,
    'active' => $custom,
    'previous' => array_diff_key($included, ['status' => true]),
]);
$state = avian_bundle_active_state();
$validRootMode = fileperms($root) & 0777;
chmod($root, 0770);
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'group-writable bundle root fails closed');
chmod($root, $validRootMode);
$activePath = $root . '/active.json';
chmod($activePath, 0660);
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'group-writable active state fails closed');
chmod($activePath, 0640);
$indexPath = $root . '/packs/test-pack/1.0.0/index.json';
chmod($indexPath, 0660);
check_bundle(avian_bundle_active_index($state) === null, 'group-writable bundle index fails closed');
chmod($indexPath, 0640);
$loadedIndex = avian_bundle_active_index($state);
check_bundle(is_array($loadedIndex), 'custom immutable index loads');
$object = avian_bundle_resolve_object($loadedIndex, 'corvus-brachyrhynchos', 1);
check_bundle(is_array($object) && $object['sha256'] === $objectHash, 'exact perched pose resolves');
check_bundle(avian_bundle_resolve_object($loadedIndex, 'corvus-brachyrhynchos', 2) === null, 'missing flight pose does not fall back');
$opened = avian_bundle_open_object($object);
check_bundle(is_array($opened) && is_resource($opened[0]), 'verified content object opens');
fclose($opened[0]);
check_bundle(count(avian_bundle_read_table($state, 'dims') ?? []) === 1, 'custom dims inventory loads');
check_bundle(count(avian_bundle_read_table($state, 'masks') ?? []) === 1, 'custom masks inventory loads');
$maskPath = $root . '/packs/test-pack/1.0.0/masks.json';
chmod($maskPath, 0660);
check_bundle(
    avian_bundle_read_table($state, 'masks') === null,
    'included-table write allowance never weakens an external geometry table'
);
chmod($maskPath, 0640);
write_bundle_json($maskPath, [
    'corvus-brachyrhynchos' => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\0")],
]);
check_bundle(
    avian_bundle_read_table($state, 'masks') === null,
    'all-zero bundle mask fails closed'
);
write_bundle_json($maskPath, [
    'corvus-brachyrhynchos' => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\x80")],
]);
$longScientific = 'A' . str_repeat('a', 39) . ' ' . str_repeat('b', 40)
    . ' ' . str_repeat('c', 40) . ' ' . str_repeat('d', 40);
$longSlug = strtolower(str_replace(' ', '-', $longScientific));
check_bundle(strlen($longScientific) === 163 && strlen($longSlug) === 163,
    'hosted scientific-name maximum produces a canonical 163-character slug');
check_bundle(avian_bundle_slug_valid($longSlug), '163-character scientific slug is valid');
check_bundle(!avian_bundle_slug_valid($longSlug . 'x'), '164-character scientific slug is invalid');
$longIndex = $index;
$longIndex['assets'][$longSlug] = [
    'perched' => ['sha256' => $objectHash, 'bytes' => $objectBytes],
    'flight' => ['sha256' => $objectHash, 'bytes' => $objectBytes],
];
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $longIndex);
write_bundle_json($root . '/packs/test-pack/1.0.0/dims.json', [
    'corvus-brachyrhynchos' => [560, 400],
    $longSlug => [560, 400],
    $longSlug . '-2' => [560, 400],
]);
write_bundle_json($root . '/packs/test-pack/1.0.0/masks.json', [
    'corvus-brachyrhynchos' => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\x80")],
    $longSlug => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\x80")],
    $longSlug . '-2' => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\x80")],
]);
$longLoadedIndex = avian_bundle_index_for_state($state);
check_bundle(is_array($longLoadedIndex), 'runtime loads an index containing a 163-character slug');
check_bundle(
    avian_bundle_resolve_object($longLoadedIndex, $longSlug, 1)['sha256'] === $objectHash,
    'runtime resolves the maximum-length perched asset'
);
check_bundle(
    avian_bundle_resolve_object($longLoadedIndex, $longSlug, 2)['sha256'] === $objectHash,
    'runtime resolves the maximum-length flight asset'
);
check_bundle(
    count(avian_bundle_read_table($state, 'dims') ?? []) === 3
        && count(avian_bundle_read_table($state, 'masks') ?? []) === 3,
    'runtime geometry accepts the 163-character base and 165-character flight keys'
);
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $index);
write_bundle_json($root . '/packs/test-pack/1.0.0/dims.json', [
    'corvus-brachyrhynchos' => [560, 400],
]);
write_bundle_json($root . '/packs/test-pack/1.0.0/masks.json', [
    'corvus-brachyrhynchos' => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\x80")],
]);
check_bundle(avian_bundle_state_for_revision($revisionOne)['id'] === 'test-pack', 'active immutable revision resolves');
check_bundle(avian_bundle_state_for_revision(AVIAN_BUNDLE_INCLUDED_REVISION)['included'] === true, 'included immutable revision resolves');
check_bundle(avian_bundle_version_valid('1.0.0-alpha.1+build.7'), 'valid SemVer is accepted');
check_bundle(!avian_bundle_version_valid('1.0.0-01'), 'numeric prerelease identifiers reject leading zeroes');
check_bundle(!avian_bundle_id_valid('../test-pack'), 'bundle id rejects traversal');
check_bundle(!avian_bundle_slug_valid('corvus/../../secret'), 'asset slug rejects traversal');

$tooSmallIndex = $index;
$tooSmallIndex['assets']['corvus-brachyrhynchos']['perched']['bytes'] = 66;
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $tooSmallIndex);
check_bundle(avian_bundle_index_for_state($custom) === null, 'bundle index enforces the PNG byte floor');
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $index);

$emptyIndex = $index;
$emptyIndex['assets'] = [];
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $emptyIndex);
check_bundle(avian_bundle_index_for_state($custom) === null, 'empty external bundle index fails closed');
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $index);

$nearLimitHeader = "\x89PNG\r\n\x1a\n" . pack('N', 13) . 'IHDR' . pack('NN', 4096, 3906);
$overPixelHeader = "\x89PNG\r\n\x1a\n" . pack('N', 13) . 'IHDR' . pack('NN', 4096, 3907);
$overSideHeader = "\x89PNG\r\n\x1a\n" . pack('N', 13) . 'IHDR' . pack('NN', 4097, 1);
check_bundle(avian_bundle_png_dimensions($nearLimitHeader) === [4096, 3906], 'PNG dimensions accept the bounded edge');
check_bundle(avian_bundle_png_dimensions($overPixelHeader) === null, 'PNG dimensions enforce the pixel ceiling');
check_bundle(avian_bundle_png_dimensions($overSideHeader) === null, 'PNG dimensions enforce the side ceiling');

$objectPath = $root . '/objects/sha256/' . substr($objectHash, 0, 2) . '/' . $objectHash . '.png';
$originalObject = file_get_contents($objectPath);
$corruptObject = $originalObject;
$corruptObject[strlen($corruptObject) - 1] = chr(ord($corruptObject[strlen($corruptObject) - 1]) ^ 1);
file_put_contents($objectPath, $corruptObject);
chmod($objectPath, 0640);
check_bundle(avian_bundle_open_object($object) === null, 'same-size object hash mismatch fails closed');
file_put_contents($objectPath, $originalObject);
chmod($objectPath, 0640);
chmod($objectPath, 0666);
check_bundle(avian_bundle_open_object($object) === null, 'world-writable object fails closed');
chmod($objectPath, 0640);
chmod($objectPath, 0660);
check_bundle(avian_bundle_open_object($object) === null, 'group-writable object fails closed');
chmod($objectPath, 0640);
$objectLink = $objectPath . '.link';
link($objectPath, $objectLink);
check_bundle(avian_bundle_open_object($object) === null, 'hard-linked object fails closed');
unlink($objectLink);
$objectReal = $objectPath . '.real';
rename($objectPath, $objectReal);
symlink($objectReal, $objectPath);
check_bundle(avian_bundle_open_object($object) === null, 'symlinked object fails closed');
unlink($objectPath);
rename($objectReal, $objectPath);

$extraIndex = $index;
$extraIndex['path'] = '/tmp/not-allowed.png';
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $extraIndex);
check_bundle(avian_bundle_index_for_state($custom) === null, 'bundle index rejects undeclared path fields');
write_bundle_json($root . '/packs/test-pack/1.0.0/index.json', $index);

make_bundle_directory($root . '/packs/second-pack/2.0.0');
$secondIndex = $index;
$secondIndex['id'] = 'second-pack';
$secondIndex['version'] = '2.0.0';
$secondIndex['revision'] = $revisionTwo;
write_bundle_json($root . '/packs/second-pack/2.0.0/index.json', $secondIndex);
write_bundle_json($root . '/packs/second-pack/2.0.0/meta.json', [
    'reference' => [
        'id' => 'second-pack', 'version' => '2.0.0', 'revision' => $revisionTwo,
        'included' => false, 'name' => 'Second pack',
    ],
    'installed_at' => '2026-09-01T00:00:00Z',
]);
write_bundle_json($root . '/packs/second-pack/2.0.0/dims.json', ['corvus-brachyrhynchos' => [560, 400]]);
write_bundle_json($root . '/packs/second-pack/2.0.0/masks.json', [
    'corvus-brachyrhynchos' => ['w' => 1, 'h' => 1, 'bits' => base64_encode("\x80")],
]);
write_bundle_json($root . '/active.json', [
    'schema_version' => 1,
    'active' => [
        'id' => 'second-pack', 'version' => '2.0.0', 'revision' => $revisionTwo,
        'included' => false, 'name' => 'Second pack',
    ],
    'previous' => $custom,
]);
check_bundle(avian_bundle_state_for_revision($revisionOne)['id'] === 'test-pack', 'installed stale revision resolves without mixing current geometry');

$validState = file_get_contents($root . '/active.json');
$otherLink = $root . '/active-other.json';
link($root . '/active.json', $otherLink);
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'hard-linked active state fails closed');
unlink($otherLink);
check_bundle(avian_bundle_active_state()['status'] === 'ok', 'active state recovers after hard-link removal');
unlink($root . '/active.json');
symlink($root . '/packs/test-pack/1.0.0/index.json', $root . '/active.json');
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'symlinked active state fails closed');
unlink($root . '/active.json');
file_put_contents($root . '/active.json', "{broken\n");
chmod($root . '/active.json', 0640);
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'malformed active state fails closed');
file_put_contents($root . '/active.json', $validState);
chmod($root . '/active.json', 0640);
chmod($root . '/active.json', 0666);
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'world-writable active state fails closed');
chmod($root . '/active.json', 0640);
$extraState = json_decode($validState, true);
$extraState['active']['path'] = '/tmp/not-allowed.png';
write_bundle_json($root . '/active.json', $extraState);
check_bundle(avian_bundle_active_state()['status'] === 'invalid', 'active state rejects undeclared path fields');
file_put_contents($root . '/active.json', $validState);
chmod($root . '/active.json', 0640);

$control = $root . '/fake-control.sh';
$argvLog = $root . '/argv.log';
$marker = $root . '/injected';
file_put_contents($control, "#!/bin/sh\nprintf '%s\\n' \"\$@\" >\"\$AVIAN_ARGV_LOG\"\nprintf '{\"ok\":true}\\n'\n");
chmod($control, 0750);
putenv('AVIAN_BUNDLE_CONTROL=' . $control);
putenv('AVIAN_ARGV_LOG=' . $argvLog);
$literal = 'test-pack;touch ' . $marker;
$run = avian_bundle_run_manager(['enqueue', '--action', 'activate', '--id', $literal, '--json']);
check_bundle($run['ok'] === true, 'fixed control helper returns bounded JSON');
check_bundle(!file_exists($marker), 'manager argv is never shell interpreted');
check_bundle(str_contains((string)file_get_contents($argvLog), $literal), 'manager receives hostile argv literally');

putenv('AVIAN_BUNDLE_CONTROL');
putenv('AVIAN_ARGV_LOG');
putenv('AVIAN_BUNDLE_ROOT');
putenv('AVIAN_BUNDLE_PROVISIONED_MARKER');
remove_bundle_fixture($root);
echo "bundle runtime: $checks checks passed\n";
