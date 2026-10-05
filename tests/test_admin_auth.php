<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/avian/api/admin-auth.php';

$checks = 0;
$failures = 0;

function check(bool $condition, string $label): void {
    global $checks, $failures;
    $checks++;
    if ($condition) return;
    $failures++;
    fwrite(STDERR, "FAIL: $label\n");
}

function request(array $extra = []): array {
    return array_merge([
        'REQUEST_METHOD' => 'GET',
        'REMOTE_ADDR' => '203.0.113.10',
        'HTTP_HOST' => 'birds.example.com',
    ], $extra);
}

function credential_request(string $password, array $extra = []): array {
    return request(array_merge([
        'REQUEST_METHOD' => 'POST',
        'HTTP_X_AVIAN_CREDENTIAL' => '1',
        'HTTP_AUTHORIZATION' => 'Basic ' . base64_encode('birdnet:' . $password),
    ], $extra));
}

function state_with(string $verifier, bool $required = true, string $epoch = '1'): array {
    return [
        'valid' => true,
        'required' => $required,
        'epoch' => $epoch,
        'verifier' => $verifier,
        'configured' => true,
        'error' => null,
    ];
}

$password = 'quoted!safe';
$verifier = password_hash($password, PASSWORD_BCRYPT, ['cost' => 14]);
check(is_string($verifier) && str_starts_with($verifier, '$2y$14$'), 'fixture uses the required bcrypt cost');
$required = state_with((string)$verifier);
$trusted = state_with((string)$verifier, false);

putenv('AV_REQUIRE_AUTH=0');
$local = request(['REMOTE_ADDR' => '192.168.1.20', 'HTTP_HOST' => 'birdnet.local']);
check(avian_is_direct_local_request($local) && !avian_lan_admin_auth_required($local),
    'trusted direct LAN request satisfies the runtime bypass predicates');
$caddyLocal = array_merge($local, [
    'AVIAN_DIRECT_LOCAL' => '1',
    'REQUEST_SCHEME' => 'http',
    'HTTP_X_FORWARDED_FOR' => '192.168.1.20',
    'HTTP_X_FORWARDED_HOST' => 'birdnet.local',
    'HTTP_X_FORWARDED_PROTO' => 'http',
]);
check(avian_is_direct_local_request($caddyLocal),
    'managed Caddy marker accepts only its validated transport fields');
check(!avian_is_direct_local_request(array_merge($caddyLocal, [
    'HTTP_X_FORWARDED_PREFIX' => '/station',
])), 'managed Caddy marker rejects an unexpected X-Forwarded field');
check(!avian_is_direct_local_request(array_merge($caddyLocal, [
    'HTTP_CF_WORKER' => 'proxy.example',
])), 'managed Caddy marker rejects an unexpected Cloudflare field');
check(!avian_is_direct_local_request(array_merge($caddyLocal, [
    'HTTP_X_FORWARDED_FOR' => '198.51.100.2',
])), 'managed Caddy marker validates its synthesized client address');
check(!avian_is_direct_local_request(array_merge($caddyLocal, [
    'HTTP_X_FORWARDED_HOST' => 'birds.example.com',
])), 'managed Caddy marker validates its synthesized host');
check(!avian_is_direct_local_request(array_merge($caddyLocal, [
    'HTTP_X_FORWARDED_PROTO' => 'https',
])), 'managed Caddy marker validates its synthesized scheme');
putenv('AV_REQUIRE_AUTH=1');
check(avian_lan_admin_auth_required(request()), 'required policy closes the direct bypass predicate');
$wrongCredentials = avian_basic_credentials(credential_request('wrong'));
check(is_array($wrongCredentials)
    && !avian_admin_password_matches((string)$wrongCredentials[1], $required),
    'wrong explicit credential does not match the verifier');
$legacyCredentials = avian_basic_credentials(credential_request($password));
check(is_array($legacyCredentials)
    && hash_equals('birdnet', (string)$legacyCredentials[0])
    && avian_admin_password_matches((string)$legacyCredentials[1], $required),
    'legacy punctuation credential parses and matches');
$utf8Password = 'mésange!';
$utf8State = state_with((string)password_hash($utf8Password, PASSWORD_BCRYPT, ['cost' => 4]));
$utf8Credentials = avian_basic_credentials(credential_request($utf8Password));
check(is_array($utf8Credentials)
    && avian_admin_password_matches((string)$utf8Credentials[1], $utf8State),
    'legacy UTF-8 credential parses and matches');
$cached = request(['HTTP_AUTHORIZATION' => 'Basic ' . base64_encode('birdnet:' . $password)]);
check(!avian_admin_credential_requested($cached), 'cached Basic header lacks explicit proof marker');
putenv('AV_REQUIRE_AUTH=0');
check(avian_lan_admin_auth_required(array_merge($local, ['AVIAN_FORCE_AUTH' => '1'])),
    'Caddy force marker overrides the CLI trusted-mode fixture');

check(avian_admin_password_is_supported('a', 1), 'one-byte migrated credential remains supported');
check(avian_admin_password_is_supported('quoted! safe', 1), 'printable migrated credential remains supported');
check(avian_admin_password_is_supported('mésange!', 1), 'UTF-8 migrated credential remains supported');
check(!avian_admin_password_is_supported("bad\nvalue", 1), 'line break is rejected');
check(!avian_admin_password_is_supported('shortvalue1', 12), 'new credential below 12 characters is rejected');
check(avian_admin_password_is_supported('TwelveChars12', 12), 'new alphanumeric credential is accepted');
check(!avian_admin_password_is_supported('Twelve!Chars', 12), 'new punctuation credential is rejected');

$action = request([
    'REQUEST_METHOD' => 'POST',
    'CONTENT_TYPE' => 'application/json; charset=UTF-8',
    'HTTP_X_AVIAN_ACTION' => '1',
]);
check(avian_json_action_decision($action)['allowed'], 'JSON POST with action marker is allowed');
check(avian_json_action_decision(array_merge($action, ['REQUEST_METHOD' => 'GET']))['status'] === 405, 'mutating GET is denied');
check(avian_json_action_decision(array_merge($action, ['CONTENT_TYPE' => 'text/plain']))['status'] === 415, 'non-JSON POST is denied');
check(avian_json_action_decision(array_merge($action, ['HTTP_X_AVIAN_ACTION' => '0']))['status'] === 403, 'wrong action marker is denied');

$tmp = sys_get_temp_dir() . '/avian-admin-auth-' . bin2hex(random_bytes(6));
check(mkdir($tmp, 0700), 'temporary auth directory is created');
$statePath = $tmp . '/admin-auth.state';
putenv('AV_ADMIN_STATE_TEST_METADATA=1');
putenv('AV_ADMIN_STATE_FILE=' . $statePath);
$line = "v1\t1\t7\t" . $verifier . "\n";
check(file_put_contents($statePath, $line) === strlen($line), 'valid state fixture is written');
chmod($statePath, 0640);
$parsed = avian_admin_state();
check($parsed['valid'] && $parsed['required'] && $parsed['epoch'] === '7', 'canonical state parses');
check(avian_admin_password_matches($password, $parsed), 'parsed verifier matches punctuation credential');

file_put_contents($statePath, "v1\t1\t07\t" . $verifier . "\n");
check(!avian_admin_state()['valid'], 'leading-zero epoch is rejected');
file_put_contents($statePath, "v1\t1\t2147483648\t" . $verifier . "\n");
check(!avian_admin_state()['valid'], 'epoch above maximum is rejected');
file_put_contents($statePath, str_repeat('x', AVIAN_ADMIN_STATE_MAX_BYTES + 1));
check(!avian_admin_state()['valid'], 'oversized state is rejected');
unlink($statePath);
check(!avian_admin_state()['valid'] && avian_admin_state()['required'], 'missing state fails closed');
file_put_contents($statePath, $line);
chmod($statePath, 0640);

$ratePath = $tmp . '/admin-auth.rate';
file_put_contents($ratePath, "{\"version\":1,\"entries\":{}}\n");
chmod($ratePath, 0660);
putenv('AV_AUTH_RATE_FILE=' . $ratePath);
putenv('AV_AUTH_RATE_TEST_METADATA=1');
putenv('AV_AUTH_RATE_TEST_NO_DELAY=1');
$fastVerifier = password_hash('RatePassword', PASSWORD_BCRYPT, ['cost' => 4]);
$rateState = state_with((string)$fastVerifier);
check(avian_admin_rate_peer(['REMOTE_ADDR' => '2001:db8:1:2::1'])
    === avian_admin_rate_peer(['REMOTE_ADDR' => '2001:db8:1:2:ffff::2']), 'IPv6 peers are bucketed by /64');
for ($index = 1; $index <= 130; $index++) {
    $third = intdiv($index, 255);
    $fourth = $index % 255;
    avian_admin_password_attempt(
        ['REMOTE_ADDR' => "10.0.$third.$fourth"],
        $rateState,
        'birdnet',
        'wrong'
    );
}
$rateData = json_decode((string)file_get_contents($ratePath), true);
check(is_array($rateData) && count($rateData['entries'] ?? []) <= AVIAN_ADMIN_RATE_MAX_ENTRIES, 'rate state has a global entry cap');

$rotatedVerifier = password_hash('RotatedRatePassword', PASSWORD_BCRYPT, ['cost' => 4]);
$rotatedRateState = state_with((string)$rotatedVerifier);
avian_admin_password_attempt(['REMOTE_ADDR' => '10.2.0.1'], $rotatedRateState, 'birdnet', 'wrong');
$rateData = json_decode((string)file_get_contents($ratePath), true);
$namespaces = array_unique(array_map(
    static fn(array $entry): string => (string)($entry['namespace'] ?? ''),
    array_values($rateData['entries'] ?? [])
));
check(count($namespaces) === 1
    && $namespaces[0] === substr(hash('sha256', (string)$rotatedVerifier), 0, 16), 'password rotation prunes the old rate namespace');

$heldRate = fopen($ratePath, 'r+');
check(is_resource($heldRate) && flock($heldRate, LOCK_EX), 'rate contention fixture holds the shared lock');
$contentionStart = microtime(true);
$contendedAttempt = avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.3.0.1'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
);
$contentionElapsed = microtime(true) - $contentionStart;
check(!$contendedAttempt['allowed'] && $contendedAttempt['retry'] === 1,
    'a contended rate lock denies the attempt with a bounded retry');
check($contentionElapsed < 0.5, 'a contended rate lock does not block a PHP worker');
flock($heldRate, LOCK_UN);
fclose($heldRate);

if (function_exists('pcntl_fork') && function_exists('pcntl_waitpid')) {
    file_put_contents($ratePath, "{\"version\":1,\"entries\":{}}\n");
    $barrier = $tmp . '/rate-start';
    $children = [];
    $parallelStart = microtime(true);
    for ($index = 0; $index < 4; $index++) {
        $pid = pcntl_fork();
        if ($pid === 0) {
            while (!is_file($barrier)) usleep(1000);
            avian_admin_password_attempt(
                ['REMOTE_ADDR' => '10.3.0.1'],
                $rotatedRateState,
                'birdnet',
                'wrong'
            );
            exit(0);
        }
        if ($pid > 0) $children[] = $pid;
    }
    touch($barrier);
    foreach ($children as $pid) pcntl_waitpid($pid, $status);
    $parallelElapsed = microtime(true) - $parallelStart;
    $rateData = json_decode((string)file_get_contents($ratePath), true);
    $entry = array_values($rateData['entries'] ?? [])[0] ?? [];
    check(($entry['failures'] ?? 0) >= 1
        && ($entry['failures'] ?? 0) <= count($children),
        'parallel failures retain bounded shared accounting');
    check($parallelElapsed < 2.0, 'parallel attempts finish within a bounded interval');
    unlink($barrier);
}

check(avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.3.0.1'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
)['allowed'], 'correct credential remains usable through the bounded rate file');
check(avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.3.0.1'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
)['allowed'], 'a second correct credential accepts the canonical empty rate map');

file_put_contents($ratePath, "{\"version\":1,\"entries\":{}}\n");
$rateBeforeFailedWrite = file_get_contents($ratePath);
putenv('AV_AUTH_RATE_TEST_WRITE_FAIL=before');
$failedWrite = avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.4.0.1'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
);
check(!$failedWrite['allowed'] && $failedWrite['retry'] === 1,
    'rate accounting persistence failure denies a correct credential');
check(file_get_contents($ratePath) === $rateBeforeFailedWrite,
    'injected rate persistence failure does not damage prior state');
putenv('AV_AUTH_RATE_TEST_WRITE_FAIL');

file_put_contents($ratePath, "{\"version\":1,\"entries\":{}}\n");
putenv('AV_AUTH_RATE_TEST_WRITE_FAIL=partial');
$partialWrite = avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.4.0.2'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
);
check(!$partialWrite['allowed'] && $partialWrite['retry'] === 1,
    'partial rate persistence failure denies a correct credential');
putenv('AV_AUTH_RATE_TEST_WRITE_FAIL');
check(file_get_contents($ratePath) === '{"version":1',
    'partial persistence fixture leaves an honestly truncated rate file');
$afterPartial = avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.4.0.2'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
);
check(!$afterPartial['allowed'] && $afterPartial['retry'] === 1,
    'truncated rate state remains fail closed until root recovery');

foreach ([
    '',
    "{}\n",
    "{\"version\":1,\"entries\":{},\"extra\":true}\n",
    '{"version":1,"entries":',
] as $malformedRate) {
    file_put_contents($ratePath, $malformedRate);
    $malformedAttempt = avian_admin_password_attempt(
        ['REMOTE_ADDR' => '10.5.0.1'],
        $rotatedRateState,
        'birdnet',
        'RotatedRatePassword'
    );
    check(!$malformedAttempt['allowed'] && $malformedAttempt['retry'] === 1,
        'malformed or partial rate state fails closed');
}
unlink($ratePath);
$missingRateAttempt = avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.5.0.2'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
);
check(!$missingRateAttempt['allowed'] && $missingRateAttempt['retry'] === 1,
    'missing rate state fails closed');
file_put_contents($ratePath, "{\"version\":1,\"entries\":{}}\n");
chmod($ratePath, 0600);
putenv('AV_AUTH_RATE_TEST_METADATA');
$unsafeRateAttempt = avian_admin_password_attempt(
    ['REMOTE_ADDR' => '10.5.0.3'],
    $rotatedRateState,
    'birdnet',
    'RotatedRatePassword'
);
check(!$unsafeRateAttempt['allowed'] && $unsafeRateAttempt['retry'] === 1,
    'unsafe rate state metadata fails closed');
putenv('AV_AUTH_RATE_TEST_METADATA=1');
chmod($ratePath, 0660);
file_put_contents($ratePath, "{\"version\":1,\"entries\":{}}\n");

$sessionDir = $tmp . '/sessions';
check(mkdir($sessionDir, 0700), 'temporary session directory is created');
session_save_path($sessionDir);
$_COOKIE = [];
$https = request(['HTTPS' => 'on', 'SERVER_PORT' => '443']);
check(avian_create_admin_session($https, $parsed), 'admin session is created');
$sessionId = session_id();
check($sessionId !== '', 'session has an identifier');
check(session_status() === PHP_SESSION_NONE, 'session file lock is released');

$_COOKIE = [AVIAN_ADMIN_SESSION_NAME => $sessionId];
session_id($sessionId);
check(avian_admin_session_valid($https, $parsed, false, true), 'session is reusable');
$_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] = time() - 100;
$seenBefore = $_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY];
session_write_close();

session_id($sessionId);
check(avian_admin_session_valid($https, $parsed, false, true), 'passive session validation succeeds');
check($_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] === $seenBefore, 'passive validation does not slide idle time');
session_write_close();

session_id($sessionId);
check(avian_admin_session_valid($https, $parsed, true, true), 'explicit activity validates session');
check($_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] > $seenBefore, 'explicit activity advances idle time');
session_write_close();

session_id($sessionId);
$newEpoch = state_with((string)$verifier, true, '8');
check(!avian_admin_session_valid($https, $newEpoch), 'epoch change invalidates old session');
check(session_status() === PHP_SESSION_NONE, 'invalid stale request releases its session');

$_COOKIE = [];
session_id('');
check(avian_create_admin_session($https, $parsed), 'fresh session is created for grant test');
$grantSession = session_id();
$_COOKIE = [AVIAN_ADMIN_SESSION_NAME => $grantSession];
session_id($grantSession);
$grant = avian_create_admin_download_grant($https, 'detections');
check(is_string($grant), 'single-use download grant is created');
session_id($grantSession);
check(avian_consume_admin_download_grant($https, 'detections', (string)$grant), 'download grant is consumed once');
session_id($grantSession);
check(!avian_consume_admin_download_grant($https, 'detections', (string)$grant), 'download grant cannot be replayed');
$educatorStatePath = $tmp . '/educators.state';
$educatorStateLine = "v1\t1\t3\n";
file_put_contents($educatorStatePath, $educatorStateLine);
chmod($educatorStatePath, 0640);
putenv('AV_EDUCATOR_STATE_FILE=' . $educatorStatePath);
putenv('AV_EDUCATOR_STATE_TEST_METADATA=1');
$boundScope = 'c_' . str_repeat('a', 32);
$directGrantServer = array_merge($local, ['HTTPS' => 'on', 'SERVER_PORT' => '443']);
session_id($grantSession);
$boundGrant = avian_create_admin_download_grant($directGrantServer, 'recordings', $boundScope);
session_id($grantSession);
$boundDetails = avian_consume_admin_download_grant_details($directGrantServer, 'recordings', (string)$boundGrant);
check(is_array($boundDetails) && $boundDetails['educator_scope'] === $boundScope,
    'download grant details preserve the private educator binding server-side');
session_id($grantSession);
check(avian_consume_admin_download_grant_details($directGrantServer, 'recordings', (string)$boundGrant) === null,
    'download grant details cannot be replayed');
session_id($grantSession);
check(avian_create_admin_download_grant($https, 'recordings', $boundScope) === null,
    'public-host requests cannot create a private educator download grant');
session_id($grantSession);
$epochBoundGrant = avian_create_admin_download_grant($directGrantServer, 'detections', $boundScope);
file_put_contents($educatorStatePath, "v1\t1\t4\n");
session_id($grantSession);
check(avian_consume_admin_download_grant_details(
    $directGrantServer,
    'detections',
    (string)$epochBoundGrant
) === null, 'Educators profile epoch changes revoke scoped download grants');
file_put_contents($educatorStatePath, $educatorStateLine);
$audioServer = array_merge($local, ['HTTPS' => 'on', 'SERVER_PORT' => '443']);
putenv('AV_REQUIRE_AUTH=1');
$_COOKIE = [];
session_id('');
check(avian_create_admin_session($audioServer, $parsed), 'audio grant session is created');
$audioSession = session_id();
$_COOKIE = [AVIAN_ADMIN_SESSION_NAME => $audioSession];
session_id($audioSession);
$audioGrant = avian_create_educator_audio_grant($audioServer);
check(is_string($audioGrant) && strlen($audioGrant) === 48, 'educator audio grant is a 48-character token');
session_id($audioSession);
check(avian_consume_educator_audio_grant($audioServer, (string)$audioGrant) === $audioSession,
    'educator audio grant returns its validated session cookie once');
session_id($audioSession);
check(avian_consume_educator_audio_grant($audioServer, (string)$audioGrant) === null,
    'educator audio grant cannot be replayed');

session_id($audioSession);
$expiredAudioGrant = avian_create_educator_audio_grant($audioServer);
session_id($audioSession);
check(avian_admin_session_valid($audioServer, $parsed, false, true), 'audio grant session opens for expiry fixture');
$_SESSION[AVIAN_ADMIN_SESSION_EDUCATOR_AUDIO_GRANTS_KEY][hash('sha256', (string)$expiredAudioGrant)]['expires'] = time() - 1;
session_write_close();
session_id($audioSession);
check(avian_consume_educator_audio_grant($audioServer, (string)$expiredAudioGrant) === null,
    'expired educator audio grant is rejected');

session_id($audioSession);
$idleAudioGrant = avian_create_educator_audio_grant($audioServer);
session_id($audioSession);
check(avian_admin_session_valid($audioServer, $parsed, false, true), 'audio grant session opens for idle fixture');
$_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] = time() - AVIAN_ADMIN_SESSION_IDLE_SECONDS - 1;
session_write_close();
session_id($audioSession);
check(avian_consume_educator_audio_grant($audioServer, (string)$idleAudioGrant) === null,
    'educator audio grant enforces the admin idle boundary');

$_COOKIE = [];
session_id('');
check(avian_create_admin_session($audioServer, $parsed), 'second audio session is created');
$otherAudioSession = session_id();
$_COOKIE = [AVIAN_ADMIN_SESSION_NAME => $otherAudioSession];
session_id($otherAudioSession);
check(avian_consume_educator_audio_grant($audioServer, (string)$idleAudioGrant) === null,
    'educator audio grants cannot cross sessions');
session_id($otherAudioSession);
check(avian_create_educator_audio_grant($https) === null,
    'forwarded educator audio grant creation is rejected');
putenv('AV_REQUIRE_AUTH=0');
session_id($otherAudioSession);
check(avian_create_educator_audio_grant($audioServer) === null,
    'educator audio grant creation requires LAN password protection');
putenv('AV_REQUIRE_AUTH=1');

session_id($grantSession);
$boundaryGrant = avian_create_admin_download_grant($https, 'recordings');
session_id($grantSession);
check(avian_admin_session_valid($https, $parsed, false, true), 'grant session opens for idle-boundary fixture');
$_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] = time() - AVIAN_ADMIN_SESSION_IDLE_SECONDS - 1;
session_write_close();
session_id($grantSession);
check(avian_consume_admin_download_grant($https, 'recordings', (string)$boundaryGrant), 'fresh grant survives the idle boundary');

foreach (glob($sessionDir . '/*') ?: [] as $file) unlink($file);
rmdir($sessionDir);
unlink($statePath);
unlink($educatorStatePath);
unlink($ratePath);
rmdir($tmp);
putenv('AV_ADMIN_STATE_FILE');
putenv('AV_ADMIN_STATE_TEST_METADATA');
putenv('AV_AUTH_RATE_FILE');
putenv('AV_AUTH_RATE_TEST_METADATA');
putenv('AV_AUTH_RATE_TEST_NO_DELAY');
putenv('AV_AUTH_RATE_TEST_WRITE_FAIL');
putenv('AV_REQUIRE_AUTH');
putenv('AV_EDUCATOR_STATE_FILE');
putenv('AV_EDUCATOR_STATE_TEST_METADATA');

if ($failures > 0) {
    fwrite(STDERR, "$failures of $checks checks failed\n");
    exit(1);
}
echo "admin auth tests passed ($checks checks)\n";
