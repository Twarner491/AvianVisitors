<?php
// Shared authentication, verifier-bound sessions, and cross-site request
// checks for AvianVisitors' private station APIs.

declare(strict_types=1);

require_once __DIR__ . '/admin-state.php';
require_once __DIR__ . '/educator-state.php';

const AVIAN_ADMIN_SESSION_NAME = 'avian_admin';
const AVIAN_ADMIN_SESSION_KEY = 'password_fingerprint';
const AVIAN_ADMIN_SESSION_CREATED_KEY = 'created_at';
const AVIAN_ADMIN_SESSION_SEEN_KEY = 'seen_at';
const AVIAN_ADMIN_SESSION_GRANTS_KEY = 'download_grants';
const AVIAN_ADMIN_SESSION_EDUCATOR_AUDIO_GRANTS_KEY = 'educator_audio_grants';
const AVIAN_ADMIN_SESSION_IDLE_SECONDS = 1800;
const AVIAN_ADMIN_SESSION_ABSOLUTE_SECONDS = 28800;
const AVIAN_ADMIN_RATE_DEFAULT_PATH = '/var/lib/avian-visitors/admin-auth.rate';
const AVIAN_ADMIN_RATE_MAX_BYTES = 32768;
const AVIAN_ADMIN_RATE_MAX_ENTRIES = 128;

function avian_api_fail(int $status, string $error): void {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['ok' => false, 'error' => $error]);
    exit;
}

function avian_admin_password_missing_fail(): void {
    http_response_code(401);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode([
        'ok' => false,
        'error' => 'admin credential state is missing or invalid',
        'recovery' => true,
    ]);
    exit;
}

function avian_configured_lan_admin_auth_required(): bool {
    return (bool)avian_admin_state()['required'];
}

function avian_lan_admin_auth_required(?array $server = null): bool {
    $server = $server ?? $_SERVER;
    if (hash_equals('1', (string)($server['AVIAN_FORCE_AUTH'] ?? ''))) return true;
    // Focused test override. Production stations use the root-managed state.
    if (PHP_SAPI === 'cli') {
        $override = getenv('AV_REQUIRE_AUTH');
        if ($override === '1') return true;
        if ($override === '0') return false;
    }
    return avian_configured_lan_admin_auth_required();
}

function avian_private_address(string $address): bool {
    $packed = @inet_pton($address);
    if ($packed === false) return false;

    if (strlen($packed) === 4) {
        $first = ord($packed[0]);
        $second = ord($packed[1]);
        return $first === 10
            || ($first === 172 && $second >= 16 && $second <= 31)
            || ($first === 192 && $second === 168)
            || $first === 127
            || ($first === 169 && $second === 254);
    }

    // ::1, fc00::/7 (unique-local), and fe80::/10 (link-local).
    if ($packed === str_repeat("\0", 15) . "\1") return true;
    $first = ord($packed[0]);
    $second = ord($packed[1]);
    return (($first & 0xFE) === 0xFC)
        || ($first === 0xFE && ($second & 0xC0) === 0x80);
}

function avian_local_host(string $value): bool {
    $host = strtolower(trim($value));
    if ($host === '' || strpbrk($host, "\r\n,/@") !== false) return false;

    if ($host[0] === '[') {
        $end = strpos($host, ']');
        if ($end === false) return false;
        $literal = substr($host, 1, $end - 1);
        $rest = substr($host, $end + 1);
        if ($rest !== '' && !preg_match('/^:\d{1,5}$/', $rest)) return false;
        return filter_var($literal, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false
            && avian_private_address($literal);
    }

    // Remove a port from an IPv4 literal or hostname. Bare IPv6 literals
    // contain multiple colons and are handled by filter_var below.
    if (substr_count($host, ':') === 1) {
        [$candidate, $port] = explode(':', $host, 2);
        if ($port === '' || !ctype_digit($port)) return false;
        $host = $candidate;
    }

    return $host === 'localhost'
        || str_ends_with($host, '.local')
        || (filter_var($host, FILTER_VALIDATE_IP) !== false
            && avian_private_address($host));
}

function avian_has_forwarding_headers(array $server): bool {
    foreach ($server as $key => $value) {
        if ($value === null || $value === '') continue;
        $name = strtoupper((string)$key);
        if ($name === 'HTTP_FORWARDED'
            || $name === 'HTTP_X_REAL_IP'
            || str_starts_with($name, 'HTTP_X_FORWARDED_')
            || str_starts_with($name, 'HTTP_CF_')) {
            return true;
        }
    }
    return false;
}

function avian_has_unexpected_caddy_forwarding_headers(array $server): bool {
    foreach ($server as $key => $value) {
        if ($value === null || $value === '') continue;
        $name = strtoupper((string)$key);
        if ($name === 'HTTP_FORWARDED'
            || $name === 'HTTP_X_REAL_IP'
            || str_starts_with($name, 'HTTP_CF_')) {
            return true;
        }
        if (str_starts_with($name, 'HTTP_X_FORWARDED_')
            && !in_array($name, [
                'HTTP_X_FORWARDED_FOR',
                'HTTP_X_FORWARDED_HOST',
                'HTTP_X_FORWARDED_PROTO',
            ], true)) {
            return true;
        }
    }
    return false;
}

function avian_is_direct_local_request(array $server): bool {
    // Caddy's FastCGI transport adds exactly these three X-Forwarded fields.
    // A request header cannot set the FastCGI marker, but an unexpected
    // forwarding-family field must still invalidate the direct decision.
    if (array_key_exists('AVIAN_DIRECT_LOCAL', $server)) {
        $remote = (string)($server['REMOTE_ADDR'] ?? '');
        $host = (string)($server['HTTP_HOST'] ?? '');
        $scheme = strtolower((string)($server['REQUEST_SCHEME'] ?? 'http'));
        if (!empty($server['HTTPS']) && strtolower((string)$server['HTTPS']) !== 'off') {
            $scheme = 'https';
        }
        return hash_equals('1', (string)$server['AVIAN_DIRECT_LOCAL'])
            && !avian_has_unexpected_caddy_forwarding_headers($server)
            && avian_private_address($remote)
            && avian_local_host($host)
            && hash_equals($remote, trim((string)($server['HTTP_X_FORWARDED_FOR'] ?? '')))
            && hash_equals(strtolower($host), strtolower(trim((string)($server['HTTP_X_FORWARDED_HOST'] ?? ''))))
            && hash_equals($scheme, strtolower(trim((string)($server['HTTP_X_FORWARDED_PROTO'] ?? ''))));
    }

    if (avian_has_forwarding_headers($server)) return false;
    return avian_private_address((string)($server['REMOTE_ADDR'] ?? ''))
        && avian_local_host((string)($server['HTTP_HOST'] ?? ''));
}

/** @return array{0:string,1:string}|null */
function avian_basic_credentials(array $server): ?array {
    $header = $server['HTTP_AUTHORIZATION'] ?? $server['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
    if (!is_string($header)) return null;

    $header = trim($header);
    if (strlen($header) > 2048) return null;
    if (!preg_match('/^Basic[ \t]+([A-Za-z0-9+\/]+={0,2})$/D', $header, $m)) return null;
    $decoded = base64_decode($m[1], true);
    if (!is_string($decoded) || strpbrk($decoded, "\0\r\n") !== false) return null;

    $colon = strpos($decoded, ':');
    if ($colon === false) return null;
    return [substr($decoded, 0, $colon), substr($decoded, $colon + 1)];
}

function avian_has_authorization_header(array $server): bool {
    return array_key_exists('HTTP_AUTHORIZATION', $server)
        || array_key_exists('REDIRECT_HTTP_AUTHORIZATION', $server);
}

function avian_admin_credential_requested(array $server): bool {
    // Browsers can cache same-origin Basic credentials and attach them to
    // later requests without the app asking. Only an explicit login or
    // password-confirmation POST may turn a Basic header into a session.
    return strtoupper((string)($server['REQUEST_METHOD'] ?? '')) === 'POST'
        && hash_equals('1', (string)($server['HTTP_X_AVIAN_CREDENTIAL'] ?? ''));
}

function avian_request_is_https(array $server): bool {
    $https = strtolower(trim((string)($server['HTTPS'] ?? '')));
    if ($https !== '' && $https !== 'off' && $https !== '0') return true;
    if ((string)($server['SERVER_PORT'] ?? '') === '443') return true;

    // A proxy marker can only make the cookie more restrictive. A forged
    // value on plain HTTP results in a Secure cookie the browser will not
    // return; it can never downgrade a genuinely HTTPS request.
    $forwardedProto = strtolower(trim(explode(',', (string)($server['HTTP_X_FORWARDED_PROTO'] ?? ''), 2)[0]));
    if ($forwardedProto === 'https') return true;
    if (preg_match('/(?:^|[;,]\s*)proto\s*=\s*"?https"?(?:[;,]|$)/i', (string)($server['HTTP_FORWARDED'] ?? '')) === 1) {
        return true;
    }

    // Cloudflare Tunnel preserves the public scheme in CF-Visitor while its
    // local hop to Caddy is HTTP. A forged value only makes the cookie more
    // restrictive, so accepting "https" here cannot weaken authentication.
    $visitor = json_decode((string)($server['HTTP_CF_VISITOR'] ?? ''), true);
    return is_array($visitor) && strtolower((string)($visitor['scheme'] ?? '')) === 'https';
}

function avian_admin_session_fingerprint(array $state, string $sessionId): string {
    // Binding the policy state invalidates every older session when the LAN
    // requirement changes. The browser performing the change receives a new
    // session after the atomic config write.
    $policy = !empty($state['required']) ? '1' : '0';
    $verifier = is_string($state['verifier'] ?? null) ? $state['verifier'] : 'invalid';
    return hash_hmac(
        'sha256',
        'avian-admin-session-v4:' . $policy . ':' . (string)($state['epoch'] ?? 'invalid') . ':' . $sessionId,
        $verifier
    );
}

function avian_start_admin_session(array $server, bool $requireCookie): bool {
    if (session_status() === PHP_SESSION_ACTIVE) {
        return session_name() === AVIAN_ADMIN_SESSION_NAME;
    }
    if (session_status() === PHP_SESSION_DISABLED || headers_sent()) return false;

    if ($requireCookie) {
        $cookie = $_COOKIE[AVIAN_ADMIN_SESSION_NAME] ?? null;
        if (!is_string($cookie)
            || strlen($cookie) < 16
            || strlen($cookie) > 128
            || !preg_match('/^[A-Za-z0-9,-]+$/D', $cookie)) {
            return false;
        }
    }

    if (@ini_set('session.use_strict_mode', '1') === false
        || @ini_set('session.use_cookies', '1') === false
        || @ini_set('session.use_only_cookies', '1') === false
        || @ini_set('session.use_trans_sid', '0') === false) {
        return false;
    }
    if (!session_name(AVIAN_ADMIN_SESSION_NAME)) return false;
    if (!session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/avian/',
        'domain' => '',
        'secure' => avian_request_is_https($server),
        'httponly' => true,
        'samesite' => 'Strict',
    ])) {
        return false;
    }
    // Passive validation reads the submitted cookie explicitly with PHP's
    // cookie emitter disabled. If another request has already rotated this
    // session, strict mode may choose a replacement ID, but that stale
    // response can never overwrite the fresh browser cookie.
    if ($requireCookie) {
        if (@ini_set('session.use_cookies', '0') === false) return false;
        session_id($cookie);
        if (!hash_equals($cookie, session_id())) return false;
    }
    return @session_start();
}

function avian_destroy_admin_session(array $server, bool $expireCookie = true): void {
    if (session_status() === PHP_SESSION_ACTIVE && session_name() === AVIAN_ADMIN_SESSION_NAME) {
        $_SESSION = [];
        @session_destroy();
    }
    if ($expireCookie && !headers_sent()) {
        setcookie(AVIAN_ADMIN_SESSION_NAME, '', [
            'expires' => time() - 42000,
            'path' => '/avian/',
            'domain' => '',
            'secure' => avian_request_is_https($server),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
    }
}

function avian_logout_admin_session(array $server): void {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        avian_start_admin_session($server, true);
    }
    avian_destroy_admin_session($server);
}

function avian_create_admin_session(array $server, ?array $state = null): bool {
    $state = $state ?? avian_admin_state();
    if (empty($state['valid']) || empty($state['configured'])) return false;
    if (!avian_start_admin_session($server, false)) return false;
    if (!session_regenerate_id(true)) {
        avian_destroy_admin_session($server);
        return false;
    }
    $_SESSION = [
        AVIAN_ADMIN_SESSION_KEY => avian_admin_session_fingerprint($state, session_id()),
        AVIAN_ADMIN_SESSION_CREATED_KEY => time(),
        AVIAN_ADMIN_SESSION_SEEN_KEY => time(),
    ];
    // No endpoint mutates session state after authentication. Release the
    // file lock now so a long CSV or recordings download cannot stall the
    // rest of the admin interface.
    return session_write_close();
}

function avian_admin_session_valid(
    array $server,
    ?array $state = null,
    bool $touch = false,
    bool $keepOpen = false,
    bool $enforceIdle = true,
    bool $expireInvalidCookie = false
): bool {
    $state = $state ?? avian_admin_state();
    if (empty($state['valid']) || empty($state['configured'])) return false;
    if (!avian_start_admin_session($server, true)) return false;

    $stored = $_SESSION[AVIAN_ADMIN_SESSION_KEY] ?? null;
    $created = $_SESSION[AVIAN_ADMIN_SESSION_CREATED_KEY] ?? null;
    $seen = $_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] ?? null;
    $now = time();
    $expected = avian_admin_session_fingerprint($state, session_id());
    $valid = is_string($stored)
        && is_int($created)
        && is_int($seen)
        && $created <= $now
        && $seen <= $now
        && ($now - $created) <= AVIAN_ADMIN_SESSION_ABSOLUTE_SECONDS
        && (!$enforceIdle || ($now - $seen) <= AVIAN_ADMIN_SESSION_IDLE_SECONDS)
        && hash_equals($expected, $stored);
    if ($valid) {
        if ($touch) $_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] = $now;
        if (!$keepOpen) session_write_close();
    }
    // A stale parallel request can finish after a policy or password change.
    // Remove only its server-side session data here. Expiring the shared
    // browser cookie could otherwise delete the fresh cookie issued by the
    // successful security-change request. Explicit logout and confirmed idle
    // lock remain responsible for expiring the browser cookie.
    else avian_destroy_admin_session($server, $expireInvalidCookie);
    return $valid;
}

function avian_valid_educator_scope_id(?string $scope): bool {
    return $scope === null || preg_match('/\A[cf]_[a-f0-9]{32}\z/D', $scope) === 1;
}

function avian_create_admin_download_grant(
    array $server,
    string $scope,
    ?string $educatorScope = null,
    bool $allowForwardedEducatorScope = false
): ?string {
    if (!in_array($scope, ['detections', 'recordings'], true)) return null;
    if (!avian_valid_educator_scope_id($educatorScope)) return null;
    if ($educatorScope !== null
        && !avian_is_direct_local_request($server)
        && !$allowForwardedEducatorScope) return null;
    $educatorEpoch = null;
    if ($educatorScope !== null) {
        $profile = educator_profile_state();
        if (empty($profile['valid']) || empty($profile['enabled'])) return null;
        $educatorEpoch = (int)$profile['epoch'];
    }
    $state = avian_admin_state();
    if (!avian_admin_session_valid($server, $state, false, true)) return null;
    try {
        $token = bin2hex(random_bytes(24));
    } catch (Throwable $error) {
        session_write_close();
        return null;
    }
    $now = time();
    $grants = $_SESSION[AVIAN_ADMIN_SESSION_GRANTS_KEY] ?? [];
    if (!is_array($grants)) $grants = [];
    foreach ($grants as $key => $grant) {
        if (!is_array($grant) || (int)($grant['expires'] ?? 0) < $now) unset($grants[$key]);
    }
    if (count($grants) >= 4) $grants = [];
    $grants[hash('sha256', $token)] = [
        'scope' => $scope,
        'educator_scope' => $educatorScope,
        'educator_epoch' => $educatorEpoch,
        'expires' => $now + 30,
    ];
    $_SESSION[AVIAN_ADMIN_SESSION_GRANTS_KEY] = $grants;
    session_write_close();
    return $token;
}

/**
 * Consume a download grant and return its server-side scope binding.
 *
 * The caller must resolve the current request scope after this succeeds and
 * compare it with `educator_scope`. This keeps a private capture id out of a
 * public `edu=active` URL while still binding the one-use grant to one exact
 * listening period.
 *
 * @return array{educator_scope:?string}|null
 */
function avian_consume_admin_download_grant_details(
    array $server,
    string $scope,
    string $token
): ?array {
    if (!in_array($scope, ['detections', 'recordings'], true)
        || preg_match('/\A[a-f0-9]{48}\z/D', $token) !== 1) return null;
    $state = avian_admin_state();
    if (!avian_admin_session_valid($server, $state, false, true, false)) return null;
    $key = hash('sha256', $token);
    $grants = $_SESSION[AVIAN_ADMIN_SESSION_GRANTS_KEY] ?? [];
    $grant = is_array($grants) ? ($grants[$key] ?? null) : null;
    if (is_array($grants)) {
        unset($grants[$key]);
        $_SESSION[AVIAN_ADMIN_SESSION_GRANTS_KEY] = $grants;
    }
    session_write_close();
    if (!is_array($grant)
        || !hash_equals($scope, (string)($grant['scope'] ?? ''))
        || (int)($grant['expires'] ?? 0) < time()) return null;
    $educatorScope = $grant['educator_scope'] ?? null;
    if (!is_string($educatorScope) && $educatorScope !== null) return null;
    if (!avian_valid_educator_scope_id($educatorScope)) return null;
    if ($educatorScope !== null) {
        $profile = educator_profile_state();
        if (empty($profile['valid']) || empty($profile['enabled'])
            || !is_int($grant['educator_epoch'] ?? null)
            || (int)$grant['educator_epoch'] !== (int)$profile['epoch']) return null;
    }
    return ['educator_scope' => $educatorScope];
}

/** Backwards-compatible exact-binding wrapper. */
function avian_consume_admin_download_grant(
    array $server,
    string $scope,
    string $token,
    ?string $educatorScope = null
): bool {
    if (!avian_valid_educator_scope_id($educatorScope)) return false;
    $details = avian_consume_admin_download_grant_details($server, $scope, $token);
    return is_array($details) && $details['educator_scope'] === $educatorScope;
}

function avian_create_educator_audio_grant(array $server): ?string {
    if (!avian_is_direct_local_request($server) || !avian_lan_admin_auth_required($server)) return null;
    $profile = educator_profile_state();
    if (empty($profile['valid']) || empty($profile['enabled'])) return null;
    $state = avian_admin_state();
    if (!avian_admin_session_valid($server, $state, false, true, true, false)) return null;
    try {
        $token = bin2hex(random_bytes(24));
    } catch (Throwable $error) {
        session_write_close();
        return null;
    }
    $now = time();
    $grants = $_SESSION[AVIAN_ADMIN_SESSION_EDUCATOR_AUDIO_GRANTS_KEY] ?? [];
    if (!is_array($grants)) $grants = [];
    foreach ($grants as $key => $grant) {
        if (!is_array($grant) || (int)($grant['expires'] ?? 0) < $now) unset($grants[$key]);
    }
    if (count($grants) >= 4) $grants = [];
    $grants[hash('sha256', $token)] = [
        'expires' => $now + 15,
        'profile_epoch' => (int)$profile['epoch'],
    ];
    $_SESSION[AVIAN_ADMIN_SESSION_EDUCATOR_AUDIO_GRANTS_KEY] = $grants;
    session_write_close();
    return $token;
}

/** Return the validated session cookie associated with a one-use grant. */
function avian_consume_educator_audio_grant(array $server, string $token): ?string {
    if (preg_match('/\A[a-f0-9]{48}\z/D', $token) !== 1) return null;
    if (!avian_is_direct_local_request($server) || !avian_lan_admin_auth_required($server)) return null;
    $profile = educator_profile_state();
    if (empty($profile['valid']) || empty($profile['enabled'])) return null;
    $state = avian_admin_state();
    if (!avian_admin_session_valid($server, $state, false, true, true, false)) return null;
    $cookie = session_id();
    $key = hash('sha256', $token);
    $grants = $_SESSION[AVIAN_ADMIN_SESSION_EDUCATOR_AUDIO_GRANTS_KEY] ?? [];
    $grant = is_array($grants) ? ($grants[$key] ?? null) : null;
    if (is_array($grants)) {
        unset($grants[$key]);
        $_SESSION[AVIAN_ADMIN_SESSION_EDUCATOR_AUDIO_GRANTS_KEY] = $grants;
    }
    session_write_close();
    if (!is_array($grant)
        || (int)($grant['expires'] ?? 0) < time()
        || (int)($grant['profile_epoch'] ?? -1) !== (int)$profile['epoch']
        || strlen($cookie) < 16
        || strlen($cookie) > 128
        || preg_match('/\A[A-Za-z0-9,-]+\z/D', $cookie) !== 1) {
        return null;
    }
    return $cookie;
}

/** @return array{locked:bool,remaining:int} */
function avian_idle_lock_admin_session(array $server): array {
    $state = avian_admin_state();
    if (!avian_admin_session_valid($server, $state, false, true, false, false)) {
        return ['locked' => true, 'remaining' => 0];
    }
    $seen = (int)($_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] ?? 0);
    $remaining = max(0, AVIAN_ADMIN_SESSION_IDLE_SECONDS - (time() - $seen));
    if ($remaining > 0) {
        session_write_close();
        return ['locked' => false, 'remaining' => $remaining];
    }
    // The response may arrive after another tab replaces the shared cookie.
    // Destroy the idle server-side session without emitting a stale expiry.
    avian_destroy_admin_session($server, false);
    return ['locked' => true, 'remaining' => 0];
}

function avian_admin_request_proved(bool $mark = false): bool {
    static $proved = false;
    if ($mark) $proved = true;
    return $proved;
}

function avian_verified_request_password(?string $set = null, bool $consume = false): ?string {
    static $verified = null;
    if ($set !== null) $verified = $set;
    if (!$consume) return $verified;
    $value = $verified;
    $verified = null;
    return $value;
}

function avian_admin_rate_path(): string {
    $override = getenv('AV_AUTH_RATE_FILE');
    if (PHP_SAPI === 'cli' && is_string($override) && $override !== '') return $override;
    return AVIAN_ADMIN_RATE_DEFAULT_PATH;
}

function avian_admin_rate_peer(array $server): string {
    $peer = (string)($server['REMOTE_ADDR'] ?? 'unknown');
    $packed = @inet_pton($peer);
    if (!is_string($packed)) return 'unknown';
    // One IPv6 /64 is one peer. Rotating interface identifiers cannot create
    // an unbounded set of independent login allowances.
    if (strlen($packed) === 16) {
        $peer = (string)inet_ntop(substr($packed, 0, 8) . str_repeat("\0", 8));
    }
    return $peer;
}

function avian_admin_rate_metadata_is_valid(array $stat): bool {
    if (PHP_SAPI === 'cli' && getenv('AV_AUTH_RATE_TEST_METADATA') === '1') return true;
    if (!function_exists('posix_getgrnam')) return false;
    $group = posix_getgrnam('caddy');
    return is_array($group) && isset($group['gid'])
        && (($stat['mode'] ?? 0) & 0170000) === 0100000
        && (int)($stat['uid'] ?? -1) === 0
        && (int)($stat['gid'] ?? -1) === (int)$group['gid']
        && (($stat['mode'] ?? 0) & 0777) === 0660
        && (int)($stat['nlink'] ?? 0) === 1;
}

/** @return resource|null */
function avian_admin_rate_handle() {
    $path = avian_admin_rate_path();
    if (!avian_admin_state_parent_is_valid($path)) return null;
    clearstatcache(true, $path);
    $before = @lstat($path);
    if (!is_array($before) || !avian_admin_rate_metadata_is_valid($before)
        || (int)($before['size'] ?? -1) < 0
        || (int)($before['size'] ?? -1) > AVIAN_ADMIN_RATE_MAX_BYTES) return null;
    $handle = @fopen($path, 'r+');
    if (!is_resource($handle)) return null;
    if (!@flock($handle, LOCK_EX | LOCK_NB)) {
        fclose($handle);
        return null;
    }
    $opened = fstat($handle);
    clearstatcache(true, $path);
    $after = @lstat($path);
    if (!is_array($opened) || !is_array($after)
        || !avian_admin_rate_metadata_is_valid($opened)
        || (int)($opened['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($opened['ino'] ?? -1) !== (int)($before['ino'] ?? -2)
        || (int)($after['dev'] ?? -1) !== (int)($before['dev'] ?? -2)
        || (int)($after['ino'] ?? -1) !== (int)($before['ino'] ?? -2)) {
        flock($handle, LOCK_UN);
        fclose($handle);
        return null;
    }
    return $handle;
}

function avian_write_admin_rate_state($handle, array $entries): bool {
    $encoded = json_encode(['version' => 1, 'entries' => (object)$entries]);
    if (!is_string($encoded) || strlen($encoded) + 1 > AVIAN_ADMIN_RATE_MAX_BYTES) return false;
    $testFailure = PHP_SAPI === 'cli' ? getenv('AV_AUTH_RATE_TEST_WRITE_FAIL') : false;
    if ($testFailure === 'before') return false;
    if (!@rewind($handle)) return false;
    if ($testFailure === 'partial') {
        $partial = substr($encoded . "\n", 0, 12);
        $written = @fwrite($handle, $partial);
        if ($written !== strlen($partial) || !@fflush($handle)) return false;
        if (!@ftruncate($handle, $written) || !@fflush($handle)) return false;
        return false;
    }
    $written = @fwrite($handle, $encoded . "\n");
    if ($written !== strlen($encoded) + 1 || !@fflush($handle)) return false;
    if (!@ftruncate($handle, $written)) return false;
    return @fflush($handle);
}

function avian_admin_login_delay(): void {
    if (PHP_SAPI === 'cli' && getenv('AV_AUTH_RATE_TEST_NO_DELAY') === '1') return;
    usleep(200000);
}

/** @return array{allowed:bool,retry:int} */
function avian_admin_password_attempt(array $server, array $state, string $user, string $provided): array {
    $handle = avian_admin_rate_handle();
    if (!is_resource($handle)) {
        avian_admin_login_delay();
        return ['allowed' => false, 'retry' => 1];
    }
    $raw = stream_get_contents($handle, AVIAN_ADMIN_RATE_MAX_BYTES + 1);
    $decoded = is_string($raw) && strlen($raw) <= AVIAN_ADMIN_RATE_MAX_BYTES
        ? json_decode($raw, true)
        : null;
    if (!is_array($decoded)
        || array_keys($decoded) !== ['version', 'entries']
        || $decoded['version'] !== 1
        || !is_array($decoded['entries'])
        || count($decoded['entries']) > AVIAN_ADMIN_RATE_MAX_ENTRIES
        || (json_encode([
            'version' => 1,
            'entries' => (object)$decoded['entries'],
        ]) . "\n") !== $raw) {
        flock($handle, LOCK_UN);
        fclose($handle);
        avian_admin_login_delay();
        return ['allowed' => false, 'retry' => 1];
    }
    $now = time();
    $verifier = is_string($state['verifier'] ?? null) ? $state['verifier'] : 'invalid';
    $namespace = substr(hash('sha256', $verifier), 0, 16);
    $peer = avian_admin_rate_peer($server);
    $key = hash('sha256', $namespace . "\0" . $peer);
    $entries = [];
    $sourceEntries = $decoded['entries'];
    foreach ($sourceEntries as $entryKey => $entry) {
        if (!is_string($entryKey)
            || preg_match('/\A[a-f0-9]{64}\z/D', $entryKey) !== 1
            || !is_array($entry)
            || array_keys($entry) !== ['namespace', 'window', 'failures', 'blocked_until', 'seen']
            || !is_string($entry['namespace'])
            || preg_match('/\A[a-f0-9]{16}\z/D', $entry['namespace']) !== 1
            || !is_int($entry['window'])
            || !is_int($entry['failures'])
            || !is_int($entry['blocked_until'])
            || !is_int($entry['seen'])
            || $entry['window'] < 0
            || $entry['failures'] < 0
            || $entry['failures'] > 100
            || $entry['blocked_until'] < 0
            || $entry['seen'] < 0) {
            flock($handle, LOCK_UN);
            fclose($handle);
            avian_admin_login_delay();
            return ['allowed' => false, 'retry' => 1];
        }
        if ($entry['namespace'] !== $namespace) continue;
        $seen = $entry['seen'];
        if ($seen < $now - 300 || $seen > $now) continue;
        $entries[$entryKey] = [
            'namespace' => $namespace,
            'window' => (int)($entry['window'] ?? 0),
            'failures' => max(0, min(100, (int)($entry['failures'] ?? 0))),
            'blocked_until' => (int)($entry['blocked_until'] ?? 0),
            'seen' => $seen,
        ];
    }
    uasort($entries, static fn(array $a, array $b): int => $b['seen'] <=> $a['seen']);
    $entries = array_slice($entries, 0, AVIAN_ADMIN_RATE_MAX_ENTRIES - 1, true);
    $rate = $entries[$key] ?? [];
    $blockedUntil = is_array($rate) ? (int)($rate['blocked_until'] ?? 0) : 0;
    if ($blockedUntil > $now) {
        $retry = min(30, $blockedUntil - $now);
        if (!avian_write_admin_rate_state($handle, $entries)) $retry = max(1, $retry);
        flock($handle, LOCK_UN);
        fclose($handle);
        return ['allowed' => false, 'retry' => $retry];
    }

    // Keep verification and failure accounting under the same nonblocking
    // rate-state lock. Concurrent attempts cannot all observe one allowance.
    $allowed = hash_equals('birdnet', $user)
        && avian_admin_password_matches($provided, $state);
    if ($allowed) {
        unset($entries[$key]);
        $persisted = avian_write_admin_rate_state($handle, $entries);
        flock($handle, LOCK_UN);
        fclose($handle);
        if (!$persisted) {
            avian_admin_login_delay();
            return ['allowed' => false, 'retry' => 1];
        }
        return ['allowed' => true, 'retry' => 0];
    }

    $window = is_array($rate) ? (int)($rate['window'] ?? 0) : 0;
    $failures = is_array($rate) ? (int)($rate['failures'] ?? 0) : 0;
    if ($window < ($now - 60) || $window > $now) {
        $window = $now;
        $failures = 0;
    }
    $failures++;
    $blockedUntil = $failures >= 5 ? $now + min(30, 5 * ($failures - 4)) : 0;
    $entries[$key] = [
        'namespace' => $namespace,
        'window' => $window,
        'failures' => $failures,
        'blocked_until' => $blockedUntil,
        'seen' => $now,
    ];
    $persisted = avian_write_admin_rate_state($handle, $entries);
    flock($handle, LOCK_UN);
    fclose($handle);
    avian_admin_login_delay();
    if (!$persisted) return ['allowed' => false, 'retry' => 1];
    return ['allowed' => false, 'retry' => max(0, $blockedUntil - $now)];
}

function avian_require_explicit_admin_credential(
    ?array $state = null,
    bool $reuseRequestProof = false
): string {
    $server = $_SERVER;
    if (!avian_admin_credential_requested($server)
        || !avian_has_authorization_header($server)) {
        avian_api_fail(401, 'password confirmation required');
    }
    $state = $state ?? avian_admin_state();
    if (empty($state['valid']) || empty($state['configured'])) {
        avian_admin_password_missing_fail();
    }
    // config.php enters through avian_require_admin() first. That gate has
    // already verified this exact request header, so extract it without a
    // second cost-14 bcrypt pass. The root helper still verifies it again
    // under the root-only state lock before changing policy or password.
    if ($reuseRequestProof && avian_admin_request_proved()) {
        $verified = avian_verified_request_password(null, true);
        if (is_string($verified)) return $verified;
        avian_api_fail(401, 'unauthorized');
    }
    $credentials = avian_basic_credentials($server);
    $user = $credentials[0] ?? '';
    $provided = $credentials[1] ?? '';
    $attempt = avian_admin_password_attempt($server, $state, $user, $provided);
    if ($attempt['retry'] > 0) {
        header('Retry-After: ' . $attempt['retry']);
        avian_api_fail(429, 'try again shortly');
    }
    if (!$attempt['allowed']) avian_api_fail(401, 'unauthorized');
    avian_verified_request_password($provided);
    return $provided;
}

function avian_require_admin_proof(): void {
    if (avian_admin_request_proved()) return;

    $server = $_SERVER;
    $state = avian_admin_state();
    if (empty($state['valid']) || empty($state['configured'])) {
        avian_admin_password_missing_fail();
    }

    // An explicit credential attempt must stand on its own. A malformed or
    // wrong Basic attempt never falls through to an older valid session.
    // A cached browser Authorization header without the app marker is ignored.
    if (avian_admin_credential_requested($server)) {
        avian_require_explicit_admin_credential($state);
        // Browsers may keep sending cached Basic credentials after login.
        // Reuse an already-valid session so parallel API requests do not race
        // through repeated session-ID rotations.
        if (avian_admin_session_valid($server, $state)) {
            avian_admin_request_proved(true);
            return;
        }
        if (!avian_create_admin_session($server, $state)) {
            avian_api_fail(503, 'authentication session unavailable');
        }
        avian_admin_request_proved(true);
        return;
    }

    if (avian_admin_session_valid($server, $state)) {
        avian_admin_request_proved(true);
        return;
    }
    avian_api_fail(401, 'unauthorized');
}

function avian_require_admin(): void {
    $server = $_SERVER;
    if (!avian_lan_admin_auth_required()
        && !avian_admin_credential_requested($server)
        && avian_is_direct_local_request($server)) {
        return;
    }
    avian_require_admin_proof();
}

function avian_rotate_admin_session_after_policy_change(): bool {
    return avian_create_admin_session($_SERVER);
}

/** @return array{allowed:bool,status:int,error:?string} */
function avian_json_action_decision(?array $server = null): array {
    $server = $server ?? $_SERVER;
    if (strtoupper((string)($server['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
        return ['allowed' => false, 'status' => 405, 'error' => 'POST required'];
    }

    $type = strtolower(trim(explode(';', (string)($server['CONTENT_TYPE'] ?? ''), 2)[0]));
    if ($type !== 'application/json') {
        return ['allowed' => false, 'status' => 415, 'error' => 'expected application/json'];
    }
    if (($server['HTTP_X_AVIAN_ACTION'] ?? null) !== '1') {
        return ['allowed' => false, 'status' => 403, 'error' => 'missing action header'];
    }
    return ['allowed' => true, 'status' => 200, 'error' => null];
}

function avian_require_json_action(): void {
    $decision = avian_json_action_decision();
    if (!$decision['allowed']) {
        if ($decision['status'] === 405) header('Allow: POST');
        avian_api_fail($decision['status'], (string)$decision['error']);
    }
}
