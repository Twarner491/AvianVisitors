<?php
declare(strict_types=1);

define('AVIAN_BIRDWEATHER_LIBRARY_ONLY', true);
require_once dirname(__DIR__) . '/avian/api/birdweather.php';

$checks = 0;
$failures = 0;

function check_birdweather(bool $condition, string $label): void {
    global $checks, $failures;
    $checks++;
    if ($condition) return;
    $failures++;
    fwrite(STDERR, "FAIL: $label\n");
}

$token = 'station-token-123';
$clean = birdweather_effective_config([
    'BIRDWEATHER_ID' => '',
    'BIRDWEATHER_ENABLED' => '0',
    'BIRDWEATHER_UPLOAD_AUDIO' => '0',
    'PRIVACY_THRESHOLD' => '0',
]);
check_birdweather(!$clean['enabled'] && !$clean['upload_audio'], 'clean install is off and detections-only');
check_birdweather(!$clean['enabled_implicit'] && !$clean['upload_audio_implicit'], 'clean policy is explicit');

$legacy = birdweather_effective_config(['BIRDWEATHER_ID' => $token]);
check_birdweather($legacy['enabled'] && $legacy['upload_audio'], 'legacy token preserves sharing and audio');
check_birdweather($legacy['enabled_implicit'] && $legacy['upload_audio_implicit'], 'legacy migration is reported');

$partial = birdweather_effective_config([
    'BIRDWEATHER_ID' => $token,
    'BIRDWEATHER_ENABLED' => '1',
]);
check_birdweather($partial['enabled'] && !$partial['upload_audio'], 'missing new audio permission fails closed');

$public = json_encode(birdweather_public_status(['BIRDWEATHER_ID' => $token]));
check_birdweather(is_string($public) && !str_contains($public, $token), 'public status never contains the token');
check_birdweather(is_string($public) && !str_contains($public, hash('sha256', $token)), 'public status has no token fingerprint');
check_birdweather(birdweather_normalize_token($token) === $token, 'plain token is unchanged');
check_birdweather(birdweather_normalize_token('  #' . $token . '  ') === $token, 'one optional hash prefix is normalized');
check_birdweather(birdweather_normalize_token('##' . $token) === null, 'a second hash prefix is rejected');
check_birdweather(birdweather_normalize_token('#') === null, 'an empty prefixed token is rejected');
check_birdweather(birdweather_normalize_token('.') === null, 'single-dot token is rejected');
check_birdweather(birdweather_normalize_token('..') === null, 'double-dot token is rejected');
check_birdweather(!birdweather_token_is_valid('.'), 'shared validator rejects single-dot token');
check_birdweather(!birdweather_token_is_valid('..'), 'shared validator rejects double-dot token');
check_birdweather(birdweather_normalize_token("\0" . $token) === null, 'NUL-bearing token is rejected before trimming');
check_birdweather(birdweather_normalize_token("\t" . $token . "\n") === null, 'control-bearing token is rejected before trimming');

check_birdweather(birdweather_probe_payload_state([
    'success' => true,
    'detections' => [],
], 'detections') === 'connected', 'official empty detections response is accepted');
check_birdweather(birdweather_probe_payload_state([
    'success' => true,
    'soundscapes' => [['station' => ['id' => 12]]],
], 'soundscapes') === 'connected', 'official soundscapes list response is accepted');
check_birdweather(birdweather_probe_payload_state([
    'detections' => [],
], 'detections') === 'unavailable', 'probe response must explicitly report success');
check_birdweather(birdweather_probe_payload_state([
    'success' => 1,
    'detections' => [],
], 'detections') === 'invalid', 'non-boolean success is rejected');
check_birdweather(birdweather_probe_payload_state([
    'success' => true,
    'soundscapes' => [],
], 'detections') === 'unavailable', 'probe response must contain the expected collection');
check_birdweather(birdweather_probe_payload_state([
    'success' => true,
    'detections' => ['row' => []],
], 'detections') === 'unavailable', 'probe collection must be a list');
check_birdweather(birdweather_probe_payload_state([
    'success' => true,
    'detections' => ['not-an-object'],
], 'detections') === 'unavailable', 'probe list entries must be objects');

foreach (['.', '..'] as $legacyDotToken) {
    $legacyDot = birdweather_effective_config(['BIRDWEATHER_ID' => $legacyDotToken]);
    check_birdweather($legacyDot['token_configured'], 'legacy dot token remains visibly configured');
    check_birdweather(!$legacyDot['configuration_valid'], 'legacy dot token is marked invalid');
    check_birdweather(!$legacyDot['enabled'], 'legacy dot token cannot enable sharing');
    $legacyEnable = birdweather_validate_update(
        ['enabled' => true],
        ['BIRDWEATHER_ID' => $legacyDotToken]
    );
    check_birdweather(!$legacyEnable['ok'] && $legacyEnable['status'] === 409, 'legacy dot token cannot satisfy enable validation');
}

$new = birdweather_validate_update([
    'enabled' => true,
    'token' => $token,
], []);
check_birdweather($new['ok'], 'new station update validates');
check_birdweather($new['updates']['BIRDWEATHER_UPLOAD_AUDIO'] === '0', 'new opt-in defaults to detections-only');
check_birdweather($new['updates']['BIRDWEATHER_ENABLED'] === '1', 'new opt-in writes an explicit enable key');
check_birdweather($new['updates']['PRIVACY_THRESHOLD'] === '1', 'new opt-in defaults local human filtering to level one');

$prefixed = birdweather_validate_update(['token' => ' #' . $token . ' '], []);
check_birdweather($prefixed['ok'], 'prefixed token patch validates');
check_birdweather($prefixed['new_token'] === $token, 'prefixed token is normalized before probing');
check_birdweather($prefixed['updates']['BIRDWEATHER_ID'] === $token, 'prefixed token is normalized before storage');
check_birdweather($prefixed['updates']['BIRDWEATHER_ENABLED'] === '0', 'entering a first token alone does not enable sharing');
check_birdweather($prefixed['updates']['BIRDWEATHER_UPLOAD_AUDIO'] === '0', 'entering a first token alone defaults audio off');

$verified = birdweather_validate_new_token($new, static fn(string $value): array => [
    'state' => $value === $token ? 'connected' : 'invalid',
    'station_id' => 314,
]);
check_birdweather($verified['ok'] && $verified['station']['station_id'] === 314, 'new token must pass the bounded probe');
$invalidProbe = birdweather_validate_new_token($new, static fn(string $value): array => ['state' => 'invalid']);
check_birdweather(!$invalidProbe['ok'] && $invalidProbe['status'] === 422, 'rejected token cannot proceed to a write');
$offlineProbe = birdweather_validate_new_token($new, static fn(string $value): array => ['state' => 'unavailable']);
check_birdweather(!$offlineProbe['ok'] && $offlineProbe['status'] === 503, 'unverified token cannot proceed to a write');

$migrated = birdweather_validate_update(['enabled' => true], ['BIRDWEATHER_ID' => $token]);
check_birdweather($migrated['ok'], 'legacy station can migrate without replacing its token');
check_birdweather($migrated['updates']['BIRDWEATHER_UPLOAD_AUDIO'] === '1', 'legacy station preserves audio permission');
check_birdweather(!array_key_exists('PRIVACY_THRESHOLD', $migrated['updates']), 'legacy station privacy is never changed implicitly');
check_birdweather(birdweather_validate_new_token(
    $migrated,
    static fn(string $value): array => ['state' => 'invalid']
)['ok'], 'legacy station is not blocked on a new-token probe');

$disabled = birdweather_validate_update(['enabled' => false], ['BIRDWEATHER_ID' => $token]);
check_birdweather($disabled['ok'] && $disabled['updates']['BIRDWEATHER_ENABLED'] === '0', 'sharing can be disabled');

$audioPatch = birdweather_validate_update(['upload_audio' => true], [
    'BIRDWEATHER_ID' => $token,
    'BIRDWEATHER_ENABLED' => '0',
    'BIRDWEATHER_UPLOAD_AUDIO' => '0',
]);
check_birdweather($audioPatch['ok'] && $audioPatch['updates'] === [
    'BIRDWEATHER_UPLOAD_AUDIO' => '1',
], 'audio autosave changes only its own policy key');
$privacyPatch = birdweather_validate_update(['privacy_threshold' => 3], [
    'BIRDWEATHER_ID' => $token,
    'BIRDWEATHER_ENABLED' => '1',
    'BIRDWEATHER_UPLOAD_AUDIO' => '0',
]);
check_birdweather($privacyPatch['ok'] && $privacyPatch['updates'] === [
    'PRIVACY_THRESHOLD' => '3',
], 'privacy autosave changes only its own policy key');
$replacement = birdweather_validate_update(['token' => '#replacement-456'], [
    'BIRDWEATHER_ID' => $token,
    'BIRDWEATHER_ENABLED' => '1',
    'BIRDWEATHER_UPLOAD_AUDIO' => '0',
    'PRIVACY_THRESHOLD' => '2',
]);
check_birdweather($replacement['ok'] && $replacement['updates'] === [
    'BIRDWEATHER_ID' => 'replacement-456',
], 'token replacement does not restore stale neighboring settings');

$missing = birdweather_validate_update(['enabled' => true], []);
check_birdweather(!$missing['ok'] && $missing['status'] === 409, 'enabling without a token is rejected');
$emptyPatch = birdweather_validate_update([], []);
check_birdweather(!$emptyPatch['ok'] && $emptyPatch['status'] === 400, 'empty patches are rejected');
$unknown = birdweather_validate_update(['enabled' => false, 'surprise' => true], []);
check_birdweather(!$unknown['ok'] && $unknown['status'] === 400, 'unknown input keys are rejected');
$coerced = birdweather_validate_update(['enabled' => 1], []);
check_birdweather(!$coerced['ok'], 'integer booleans are rejected');
$badToken = birdweather_validate_update(['enabled' => true, 'token' => "secret/route"], []);
check_birdweather(!$badToken['ok'], 'path-bearing token is rejected');
$badPrivacy = birdweather_validate_update(['enabled' => false, 'privacy_threshold' => 4], []);
check_birdweather(!$badPrivacy['ok'], 'out-of-range local privacy is rejected');
$blankToken = birdweather_validate_update(['enabled' => false, 'token' => ''], []);
check_birdweather(!$blankToken['ok'], 'blank token is not treated as a replacement');
$forgotten = birdweather_validate_update(['forget_token' => true], [
    'BIRDWEATHER_ID' => $token,
    'BIRDWEATHER_ENABLED' => '1',
    'BIRDWEATHER_UPLOAD_AUDIO' => '1',
]);
check_birdweather($forgotten['ok'] && $forgotten['updates']['BIRDWEATHER_ID'] === '', 'token has an explicit forget operation');
check_birdweather($forgotten['updates']['BIRDWEATHER_UPLOAD_AUDIO'] === '0', 'forgetting a token also revokes audio permission');
check_birdweather($forgotten['updates']['BIRDWEATHER_ENABLED'] === '0', 'forgetting a token also disables sharing');
$forgetEnabled = birdweather_validate_update([
    'enabled' => true,
    'forget_token' => true,
], ['BIRDWEATHER_ID' => $token]);
check_birdweather(!$forgetEnabled['ok'] && $forgetEnabled['status'] === 409, 'active sharing cannot forget its credential');
$replaceAndForget = birdweather_validate_update([
    'enabled' => false,
    'token' => $token,
    'forget_token' => true,
], ['BIRDWEATHER_ID' => $token]);
check_birdweather(!$replaceAndForget['ok'], 'token replacement and removal are mutually exclusive');
$invalidSerialized = json_encode(birdweather_validate_update(['token' => '#secret/route'], []));
check_birdweather(is_string($invalidSerialized) && !str_contains($invalidSerialized, 'secret/route'), 'validation errors never echo rejected token input');

check_birdweather(birdweather_find_station_id([
    'detections' => [['id' => 99, 'stationId' => 314]],
]) === 314, 'public station ID is extracted from a detection');
check_birdweather(birdweather_find_station_id([
    'soundscapes' => [['id' => 99, 'station' => ['id' => '2718']]],
]) === 2718, 'public station ID is extracted from a nested station');
check_birdweather(birdweather_find_station_id(['detections' => [['id' => 99]]]) === null, 'detection ID is not mistaken for station ID');
check_birdweather(birdweather_station_id_value('0007') === null, 'non-canonical station ID is rejected');

$tmp = tempnam(sys_get_temp_dir(), 'avian-birdweather-');
check_birdweather(is_string($tmp), 'temporary config is created');
if (is_string($tmp)) {
    $fixture = "BIRDWEATHER_ID=discarded-earlier-value\n"
        . "export BIRDWEATHER_ID=\"$token\" # write credential\n"
        . "BIRDWEATHER_ENABLED='1' # enabled\n"
        . "BIRDWEATHER_UPLOAD_AUDIO=0 # detections only\n"
        . "PRIVACY_THRESHOLD=\"2\" # local filter\n"
        . "GEMINI_API_KEY=do-not-retain\n";
    file_put_contents($tmp, $fixture);
    $read = birdweather_read_conf($tmp);
    check_birdweather(($read['BIRDWEATHER_ID'] ?? null) === $token, 'station token is read server-side');
    check_birdweather(($read['BIRDWEATHER_ENABLED'] ?? null) === '1', 'single-quoted assignment with comment parses');
    check_birdweather(($read['BIRDWEATHER_UPLOAD_AUDIO'] ?? null) === '0', 'bare assignment with comment parses');
    check_birdweather(($read['PRIVACY_THRESHOLD'] ?? null) === '2', 'double-quoted assignment with comment parses');
    check_birdweather(!array_key_exists('GEMINI_API_KEY', $read), 'unrelated secrets are not retained');
    unlink($tmp);
}

$concurrent = tempnam(sys_get_temp_dir(), 'avian-birdweather-concurrent-');
check_birdweather(is_string($concurrent), 'concurrent config fixture is created');
if (is_string($concurrent)) {
    file_put_contents($concurrent, "BIRDWEATHER_ID=replacement-456\n"
        . "BIRDWEATHER_ENABLED=1\n"
        . "BIRDWEATHER_UPLOAD_AUDIO=0\n"
        . "PRIVACY_THRESHOLD=1\n");
    $firstStatus = birdweather_canonical_status(
        $concurrent,
        ['BIRDWEATHER_ID' => 'replacement-456'],
        ['state' => 'connected', 'station_id' => 314]
    );
    check_birdweather(($firstStatus['station']['station_id'] ?? null) === 314, 'matching canonical token keeps its probe result');

    // Model a second patch committing before the first request builds its
    // response. The first response must reflect disk and drop stale station
    // metadata from its superseded token.
    file_put_contents($concurrent, "BIRDWEATHER_ID=concurrent-789\n"
        . "BIRDWEATHER_ENABLED=0\n"
        . "BIRDWEATHER_UPLOAD_AUDIO=1\n"
        . "PRIVACY_THRESHOLD=3\n");
    $concurrentStatus = birdweather_canonical_status(
        $concurrent,
        ['BIRDWEATHER_ID' => 'replacement-456'],
        ['state' => 'connected', 'station_id' => 314]
    );
    check_birdweather(is_array($concurrentStatus)
        && !$concurrentStatus['enabled']
        && $concurrentStatus['upload_audio']
        && $concurrentStatus['privacy_threshold'] === 3,
        'response reflects the complete concurrent on-disk patch');
    check_birdweather(!array_key_exists('station', $concurrentStatus), 'superseded token never receives stale station metadata');
    $concurrentJson = json_encode($concurrentStatus);
    check_birdweather(is_string($concurrentJson) && !str_contains($concurrentJson, 'concurrent-789'), 'canonical status remains token-free');
    unlink($concurrent);
}

if ($failures > 0) exit(1);
echo "birdweather api tests passed ($checks checks)\n";
