<?php
// AvianVisitors - drawer menu items.
//
// Returns the list of links shown in the side drawer when a user clicks
// the menu button. The live JS expects {items: [{label, href, native}]}.
//
// Direct requests can be password protected by the station owner. Forwarded
// and public-host requests always verify the same configured password.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/educator-state.php';
require_once __DIR__ . '/educator-scope.php';

$helperStat = @lstat('/usr/local/sbin/avian-admin-control');
$installationRecovery = !is_array($helperStat)
    || (($helperStat['mode'] ?? 0) & 0170000) !== 0100000
    || (($helperStat['mode'] ?? 0) & 07777) !== 0755
    || (int)($helperStat['uid'] ?? -1) !== 0
    || (int)($helperStat['gid'] ?? -1) !== 0
    || (int)($helperStat['nlink'] ?? 0) !== 1;
$menuAction = (string)($_GET['action'] ?? '');

if ($menuAction === 'lock') {
    avian_require_json_action();
    avian_logout_admin_session($_SERVER);
    echo json_encode(['ok' => true]);
    exit;
}

if ($menuAction === 'activity') {
    avian_require_json_action();
    $activityState = avian_admin_state();
    if (empty($activityState['valid']) || empty($activityState['configured'])) {
        avian_admin_password_missing_fail();
    }
    if (!avian_admin_session_valid($_SERVER, $activityState, true)) {
        avian_api_fail(401, 'unauthorized');
    }
    echo json_encode(['ok' => true]);
    exit;
}

if ($menuAction === 'idle-lock') {
    avian_require_json_action();
    $idleState = avian_admin_state();
    echo json_encode([
        'ok' => true,
        'recovery' => empty($idleState['valid']) || empty($idleState['configured']),
        'installation_recovery' => $installationRecovery,
    ] + avian_idle_lock_admin_session($_SERVER));
    exit;
}

if ($menuAction === 'download-grant') {
    avian_require_json_action();
    avian_require_admin();
    $grantLength = $_SERVER['CONTENT_LENGTH'] ?? null;
    if ($grantLength !== null && (!ctype_digit((string)$grantLength) || (int)$grantLength > 1024)) {
        avian_api_fail(413, 'download request is too large');
    }
    $grantRaw = file_get_contents('php://input', false, null, 0, 1025);
    if (!is_string($grantRaw) || $grantRaw === '' || strlen($grantRaw) > 1024) {
        avian_api_fail(400, 'invalid download request');
    }
    try {
        $grantBody = json_decode($grantRaw, true, 8, JSON_THROW_ON_ERROR);
    } catch (Throwable $error) {
        avian_api_fail(400, 'invalid download request');
    }
    if (!is_array($grantBody) || array_is_list($grantBody)) avian_api_fail(400, 'invalid download request');
    $grantKeys = array_keys($grantBody);
    sort($grantKeys);
    $allowedGrantKeys = array_key_exists('edu', $grantBody) ? ['edu', 'scope'] : ['scope'];
    if ($grantKeys !== $allowedGrantKeys || !isset($grantBody['scope']) || !is_string($grantBody['scope'])) {
        avian_api_fail(400, 'invalid download request');
    }
    $scope = $grantBody['scope'];
    $eduQuery = [];
    if (array_key_exists('edu', $grantBody)) {
        if (!is_string($grantBody['edu'])) avian_api_fail(400, 'invalid download request');
        if ($grantBody['edu'] !== 'active' && !avian_is_direct_local_request($_SERVER)) {
            avian_api_fail(404, 'not found');
        }
        $eduQuery['edu'] = $grantBody['edu'];
    }
    try {
        // `edu` is an exact-key JSON field here, not a query parameter. Give
        // the shared resolver a canonical representation of that validated
        // body field so its normal GET ambiguity checks remain unchanged.
        $educatorBodyQuery = array_key_exists('edu', $eduQuery)
            ? 'edu=' . rawurlencode($eduQuery['edu'])
            : '';
        $educatorScope = educator_resolve_scope($eduQuery, true, $educatorBodyQuery);
        $educatorScopeId = $educatorScope['id'] ?? null;
        educator_scope_release($educatorScope);
    } catch (EducatorScopeError $error) {
        avian_api_fail($error->httpStatus, $error->getMessage());
    }
    // Omitted and `active` requests expose no saved capability id. They keep
    // the ordinary protected Tools behavior on a forwarded host while the
    // grant remains bound to the exact current capture server-side. Explicit
    // saved c_/f_ exports stay direct-LAN-only above.
    $allowForwardedActive = !array_key_exists('edu', $grantBody)
        || $grantBody['edu'] === 'active';
    $token = avian_create_admin_download_grant(
        $_SERVER,
        $scope,
        $educatorScopeId,
        $allowForwardedActive
    );
    if (!is_string($token)) avian_api_fail(400, 'invalid download request');
    echo json_encode([
        'ok' => true,
        'token' => $token,
        'expires_in' => 30,
    ]);
    exit;
}

$adminState = avian_admin_state();
$passwordRequired = avian_lan_admin_auth_required()
    || !avian_is_direct_local_request($_SERVER);
if ($passwordRequired
    && (empty($adminState['valid']) || empty($adminState['configured']))) {
    http_response_code(401);
    echo json_encode([
        'ok' => false,
        'error' => 'admin credential state is missing or invalid',
        'recovery' => true,
        'installation_recovery' => $installationRecovery,
    ]);
    exit;
}
avian_require_admin();

// Count of instant (chroma) cutouts awaiting the full-quality upgrade
// pass - drives the notification dot on the menu button and the
// settings entry. See generate.php / generate_one.py.
$cuts = dirname(__DIR__) . '/assets/illustrations/cuts.json';
$chroma = 0;
if (is_readable($cuts)) {
    $j = json_decode((string)file_get_contents($cuts), true);
    if (is_array($j)) {
        foreach ($j as $kind) { if ($kind === 'chroma') $chroma++; }
    }
}

// The four base items are in-app overlays. `native: true` tells the FE to
// route via `#admin=<section>` rather than opening a new window. We
// deliberately don't link out to BirdNET-Pi's stock pages - those stay
// reachable at /index.php, and the github link lives in the drawer
// footer next to "built by teddy".
$educatorProfile = educator_profile_state();
$items = [
        ['label' => 'settings', 'href' => '/#admin=settings', 'native' => true, 'dot' => $chroma > 0],
        ['label' => 'system',   'href' => '/#admin=system',   'native' => true],
        ['label' => 'logs',     'href' => '/#admin=logs',     'native' => true],
        ['label' => 'tools',    'href' => '/#admin=tools',    'native' => true],
];
if (!empty($educatorProfile['valid']) && !empty($educatorProfile['enabled'])) {
    $items[] = [
        'label' => 'educators',
        'href' => '/#admin=educators',
        'native' => true,
        'full' => true,
    ];
}
echo json_encode([
    'items' => $items,
    'chroma' => $chroma,
    'auth' => [
        'required' => $passwordRequired,
        'direct_local' => avian_is_direct_local_request($_SERVER),
        'lan_policy' => avian_lan_admin_auth_required(),
        'password_configured' => !empty($adminState['valid'])
            && !empty($adminState['configured']),
        'recovery' => empty($adminState['valid']),
    ],
]);
