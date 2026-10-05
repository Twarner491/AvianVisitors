<?php
// AvianVisitors - JSON facade over BirdNET-Pi's birds.db. Read-only.
// Symlinked into the BirdNET-Pi Caddy site root at /avian/api/.
//
// Endpoints (?action=...):
//   stats       - totals (detections, unique species, today, last hour)
//   lifelist    - every species with first_seen, last_seen, total_count
//   recent      - &hours=N (default 24): species heard in the window
//   rhythm      - &hours=N: minute-by-minute rhythm for the selected window
//   hourly      - species-by-hour ledger for one calendar day
//   species     - &sci=<sci_name>: per-species detail page
//   timeseries  - &days=N: daily detection counts per species
//   firstseen   - every species' earliest detection
//   calendar    - detection totals by calendar date
//
// Default LAN deploy ships without auth. If you've exposed the Pi via
// Cloudflare or a tunnel, add a Caddy `basic_auth` matcher around the
// /avian/api/* path - see avian/forwarding/.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header('Cross-Origin-Resource-Policy: same-origin');

require_once __DIR__ . '/educator-scope.php';
require_once __DIR__ . '/admin-auth.php';

// PHP resolves __DIR__ through symlinks to the realpath. This script
// lives at $HOME/BirdNET-Pi/avian/api/birdnet-api.php (served via the
// ${EXTRACTED}/avian symlink). dirname(..., 2) walks to the BirdNET-Pi
// install root. Works under any username because we never bake the
// home directory in. getenv('HOME') would resolve to /var/lib/caddy
// under PHP-FPM (BirdNET-Pi runs it as the caddy user), so it can't
// be relied on.
$DB_PATH = educator_birds_db_path();
$CONF_PATH = dirname(__DIR__, 2) . '/birdnet.conf';

// SITE_NAME is already public on BirdNET-Pi's legacy homepage. Read only that
// key so the collage can share its canonical title without exposing the rest
// of birdnet.conf, which can contain API and service credentials.
function publicSiteName(string $path): string {
    if (!is_readable($path) || is_dir($path)) return 'BirdNET-Pi';
    $lines = @file($path, FILE_IGNORE_NEW_LINES);
    if (!is_array($lines)) return 'BirdNET-Pi';
    $value = '';
    foreach ($lines as $line) {
        if (trim($line) === '' || str_starts_with(ltrim($line), '#')) continue;
        if (preg_match('/^\s*(?:export\s+)?SITE_NAME\s*=\s*(.*)$/', $line, $match) !== 1) continue;
        $raw = trim($match[1]);
        if (str_starts_with($raw, '"')) {
            if (preg_match('/^"([^"\\\\]*)"\s*(?:#.*)?$/', $raw, $quoted) !== 1) continue;
            $raw = $quoted[1];
        } elseif (str_starts_with($raw, "'")) {
            if (preg_match("/^'([^']*)'\\s*(?:#.*)?$/", $raw, $quoted) !== 1) continue;
            $raw = $quoted[1];
        } else {
            $raw = preg_replace('/\s+#.*$/', '', $raw) ?? '';
            $raw = trim($raw);
        }
        if (strlen($raw) <= 60 && preg_match("/^[A-Za-z0-9 _.,'-]*$/u", $raw) === 1) {
            $value = $raw;
        }
    }
    return $value !== '' ? $value : 'BirdNET-Pi';
}

function publicConfigFlag(string $path, string $key): bool {
    if (!is_readable($path) || is_dir($path)) return false;
    $lines = @file($path, FILE_IGNORE_NEW_LINES);
    if (!is_array($lines)) return false;
    $value = null;
    $pattern = '/^\s*(?:export\s+)?'.preg_quote($key, '/').'\s*=\s*(.*)$/';
    foreach ($lines as $line) {
        if (preg_match($pattern, $line, $match) === 1) {
            $value = strtolower(trim($match[1], " \t\n\r\0\x0B\"'"));
        }
    }
    return in_array($value, ['1', 'true', 'yes', 'on'], true);
}

function recentWindow(
    SQLite3 $db,
    int $hours,
    array $dateContext,
    bool $resetAtMidnight,
    bool $scoped
): array {
    $through = "DATETIME(Date||' '||Time) <= DATETIME(:anchor)";
    $enabled = $resetAtMidnight && !$scoped;
    if ($hours >= 1000000) {
        return [
            'where' => $through,
            'bind' => [':anchor' => $dateContext['anchor']],
            'reset_at_midnight' => $enabled,
            'midnight_clamped' => false,
            'window_start' => null,
        ];
    }
    $statement = $db->prepare(
        "SELECT DATETIME(:anchor,'-".$hours." hours') AS rolling, "
            . "DATETIME(:anchor,'start of day') AS midnight"
    );
    if (!$statement) throw new RuntimeException('could not prepare time window');
    $statement->bindValue(':anchor', $dateContext['anchor'], SQLITE3_TEXT);
    $result = $statement->execute();
    $times = $result ? ($result->fetchArray(SQLITE3_ASSOC) ?: []) : [];
    $rolling = (string)($times['rolling'] ?? '');
    $midnight = (string)($times['midnight'] ?? '');
    $clamped = $enabled
        && !empty($dateContext['is_today'])
        && $rolling !== ''
        && $midnight !== ''
        && $rolling <= $midnight;
    $start = $clamped ? $midnight : $rolling;
    $lowerOperator = $clamped ? '>=' : '>';
    return [
        'where' => $through." AND DATETIME(Date||' '||Time) "
            .$lowerOperator." DATETIME(:window_start)",
        'bind' => [':anchor' => $dateContext['anchor'], ':window_start' => $start],
        'reset_at_midnight' => $enabled,
        'midnight_clamped' => $clamped,
        'window_start' => $start,
    ];
}

if (defined('AVIAN_BIRDNET_API_LIBRARY_ONLY')) return;

$RESET_AT_MIDNIGHT = publicConfigFlag($CONF_PATH, 'RESET_AT_MIDNIGHT');

$educatorDirectRequest = avian_is_direct_local_request($_SERVER);
$educatorSavedRequest = educator_saved_scope_requested($_GET);
$educatorPublicCapability = $educatorSavedRequest;
$educatorIncludePrivateScope = $educatorDirectRequest && !$educatorSavedRequest;
$action = $_GET['action'] ?? 'stats';
$educatorScopeProbe = is_string($action) && $action === 'scope-probe';

$db = null;
try {
    if ($educatorScopeProbe) {
        $allowed = ['action' => true, 'edu' => true];
        foreach (array_keys($_GET) as $key) {
            if (!is_string($key) || !isset($allowed[$key])) {
                throw new EducatorScopeError('educator scope probe is invalid', 400);
            }
        }
        $rawActionCount = educator_scope_raw_parameter_count('action');
        if (count($_GET) !== 2
            || !is_string($_GET['edu'] ?? null)
            || preg_match('/\A[cf]_[a-f0-9]{32}\z/D', $_GET['edu']) !== 1
            || ($rawActionCount !== null && $rawActionCount !== 1)) {
            throw new EducatorScopeError('educator scope probe is invalid', 400);
        }
    }
    $educatorScope = educator_resolve_scope($_GET);
} catch (EducatorScopeError $error) {
    [$scopeStatus, $scopeMessage] = educator_public_scope_error(
        $error,
        $educatorPublicCapability
    );
    http_response_code($scopeStatus);
    header('Cache-Control: no-store');
    echo json_encode(['error' => $scopeMessage, 'educator_scope' => null]);
    exit;
}
$educatorProfileForCache = educator_profile_state();
$educatorCacheDisabled = !empty($educatorProfileForCache['valid'])
    && !empty($educatorProfileForCache['enabled']);
header('Cache-Control: ' . (($educatorCacheDisabled || $RESET_AT_MIDNIGHT)
    ? 'no-store'
    : 'public, max-age=30'));

if (!file_exists($DB_PATH)) {
    http_response_code(503);
    echo json_encode([
        'error' => $educatorPublicCapability ? 'saved view unavailable' : 'birds.db not found',
        'educator_scope' => $educatorPublicCapability
            ? null
            : educator_scope_public($educatorScope, $educatorIncludePrivateScope),
    ]);
    educator_scope_release($educatorScope);
    exit;
}

try {
    $db = new SQLite3($DB_PATH, SQLITE3_OPEN_READONLY);
    $db->busyTimeout(2000);
    $db->exec('BEGIN');
    $educatorProbePayload = $educatorScopeProbe
        ? educator_scope_probe($db, $educatorScope)
        : null;
    if (!$educatorScopeProbe) educator_scope_detection_table($db, $educatorScope);
} catch (Throwable $e) {
    if ($db instanceof SQLite3) {
        try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
        try { $db->close(); } catch (Throwable $ignored) {}
    }
    if ($e instanceof EducatorScopeError) {
        [$status, $message] = educator_public_scope_error($e, $educatorPublicCapability);
    } else {
        $status = $educatorPublicCapability ? 503 : 500;
        $message = $educatorPublicCapability ? 'saved view unavailable' : 'db open failed';
    }
    http_response_code($status);
    echo json_encode([
        'error' => $message,
        'educator_scope' => $educatorPublicCapability
            ? null
            : educator_scope_public($educatorScope, $educatorIncludePrivateScope),
    ]);
    educator_scope_release($educatorScope);
    exit;
}

function birdnetRespond(SQLite3 $db, ?array &$scope, array $payload): void {
    try {
        educator_scope_recheck_generation($db, $scope);
        $payload['educator_scope'] = educator_scope_public(
            $scope,
            avian_is_direct_local_request($_SERVER)
                && !educator_saved_scope_requested($_GET)
        );
        $encoded = json_encode($payload, JSON_THROW_ON_ERROR);
        educator_store_test_hook('birdnet-before-commit');
        $db->exec('COMMIT');
        $db->close();
        echo $encoded;
    } catch (EducatorScopeError $error) {
        try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
        try { $db->close(); } catch (Throwable $ignored) {}
        $publicCapability = educator_saved_scope_requested($_GET);
        [$status, $message] = educator_public_scope_error($error, $publicCapability);
        http_response_code($status);
        try {
            echo json_encode([
                'error' => $message,
                'educator_scope' => $publicCapability ? null : educator_scope_public(
                    $scope,
                    avian_is_direct_local_request($_SERVER)
                        && !educator_saved_scope_requested($_GET)
                ),
            ], JSON_THROW_ON_ERROR);
        } catch (Throwable $encodingError) {
            http_response_code(503);
            echo '{"error":"scoped response could not be encoded","educator_scope":null}';
        }
    } catch (Throwable $error) {
        try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
        try { $db->close(); } catch (Throwable $ignored) {}
        http_response_code(503);
        echo '{"error":"scoped response could not be encoded","educator_scope":null}';
    } finally {
        educator_scope_release($scope);
    }
}

function rows(SQLite3 $db, string $sql, array $bind = []): array {
    $stmt = $db->prepare($sql);
    foreach ($bind as $k => $v) $stmt->bindValue($k, $v);
    $res = $stmt->execute();
    $out = [];
    while ($r = $res->fetchArray(SQLITE3_ASSOC)) $out[] = $r;
    return $out;
}
function one(SQLite3 $db, string $sql, array $bind = []) {
    $r = rows($db, $sql, $bind);
    return $r[0] ?? null;
}

function validIsoDate(string $date): bool {
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    return $parsed !== false && $parsed->format('Y-m-d') === $date;
}

// A stats date is always interpreted in the station's SQLite local clock.
// Today ends at the current second; a historical date ends at 23:59:59.
// Returning the same shape from every date-aware action keeps the frontend's
// timeline, lists, ledger, and rhythm on one coherent cutoff.
function dateContext(SQLite3 $db, ?array &$educatorScope): array {
    $today = one($db, "SELECT DATE('now','localtime') AS d")['d'] ?? date('Y-m-d');
    $asked = $_GET['date'] ?? null;
    if ($asked !== null && (!is_string($asked) || !validIsoDate($asked) || $asked > $today)) {
        http_response_code(400);
        birdnetRespond($db, $educatorScope, ['error' => 'bad date']);
        exit;
    }
    $scopedLatest = null;
    if ($asked === null && $educatorScope !== null) {
        $latest = one($db, "SELECT MAX(Date||' '||Time) AS t FROM detections");
        $scopedLatest = is_string($latest['t'] ?? null) ? $latest['t'] : null;
    }
    $date = $asked ?? ($scopedLatest !== null ? substr($scopedLatest, 0, 10) : $today);
    $isToday = $date === $today;
    $anchor = $scopedLatest ?? ($isToday
        ? (one($db, "SELECT DATETIME('now','localtime') AS t")['t'] ?? ($today.' 23:59:59'))
        : $date.' 23:59:59');
    return ['date' => $date, 'today' => $today, 'is_today' => $isToday, 'anchor' => $anchor];
}

function windowClause(int $hours): string {
    $through = "DATETIME(Date||' '||Time) <= DATETIME(:anchor)";
    if ($hours >= 1000000) return $through;
    return $through." AND DATETIME(Date||' '||Time) > DATETIME(:anchor,'-".$hours." hours')";
}

if ($educatorScopeProbe) {
    birdnetRespond($db, $educatorScope, $educatorProbePayload);
    exit;
}

switch ($action) {

    case 'stats': {
        $ctx = dateContext($db, $educatorScope);
        $bind = [':anchor' => $ctx['anchor']];
        $total       = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE DATETIME(Date||' '||Time) <= DATETIME(:anchor)", $bind)['n'] ?? 0);
        educator_store_test_hook('birdnet-stats-after-total');
        $species     = (int)(one($db, "SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections WHERE DATETIME(Date||' '||Time) <= DATETIME(:anchor)", $bind)['n'] ?? 0);
        $day         = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE Date = :d", [':d' => $ctx['date']])['n'] ?? 0);
        $daySpec     = (int)(one($db, "SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections WHERE Date = :d", [':d' => $ctx['date']])['n'] ?? 0);
        $lastHour    = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE ".windowClause(1), $bind)['n'] ?? 0);
        $week        = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE ".windowClause(168), $bind)['n'] ?? 0);
        $weekSpec    = (int)(one($db, "SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections WHERE ".windowClause(168), $bind)['n'] ?? 0);
        $first       = one($db, "SELECT MIN(Date) AS d FROM detections WHERE DATETIME(Date||' '||Time) <= DATETIME(:anchor)", $bind);
        birdnetRespond($db, $educatorScope, [
            'totals'    => ['detections' => $total, 'species' => $species],
            'today'     => ['detections' => $day, 'species' => $daySpec],
            'last_hour' => ['detections' => $lastHour],
            'week'      => ['detections' => $week,  'species' => $weekSpec],
            'started'   => $first['d'] ?? null,
            'date'      => $ctx['date'],
            'station_date' => $ctx['today'],
            'is_today'  => $ctx['is_today'],
            'anchor'    => $ctx['anchor'],
            'as_of'     => date('c'),
        ]);
        break;
    }

    case 'lifelist': {
        // n = total calls (matches the `recent` action's alias so the
        // frontend can read either response interchangeably).
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, MIN(Date||' '||Time) AS first_seen, "
        . "       MAX(Date||' '||Time) AS last_seen, COUNT(*) AS n, MAX(Confidence) AS best_conf "
        . "FROM detections GROUP BY Sci_Name ORDER BY first_seen ASC"
        );
        birdnetRespond($db, $educatorScope, ['species' => $rs, 'as_of' => date('c')]);
        break;
    }

    case 'recent': {
        // Cap raised to 1,000,000 hours (~114 years) so the frontend's
        // "ALL" button can turn off the time filter without needing a
        // separate code path.
        $hours = max(1, min(1000000, (int)($_GET['hours'] ?? 24)));
        $ctx = dateContext($db, $educatorScope);
        $window = recentWindow(
            $db,
            $hours,
            $ctx,
            $RESET_AT_MIDNIGHT,
            $educatorScope !== null
        );
        $where = $window['where'];
        $bind = $window['bind'];
        // species-collapsed view: one row per species seen in the window,
        // with the file of its highest-confidence detection inside the window.
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, COUNT(*) AS n, MAX(Confidence) AS best_conf, "
        . "       MAX(Date||' '||Time) AS last_seen "
        . "FROM detections "
        . "WHERE $where "
        . "GROUP BY Sci_Name ORDER BY last_seen DESC",
          $bind
        );
        // for each row, attach the file of the top-confidence detection in the window
        foreach ($rs as &$r) {
            $best = one($db,
              "SELECT detection_id, File_Name AS file, Date AS d, Time AS t, Confidence AS conf "
            . "FROM detections "
            . "WHERE Sci_Name = :sn "
            . "AND $where "
            . "ORDER BY Confidence DESC LIMIT 1",
              array_merge([':sn' => $r['sci']], $bind)
            );
            $r['top_file'] = $best['file'] ?? null;
            $r['detection_id'] = isset($best['detection_id']) ? (int)$best['detection_id'] : null;
            $r['top_at']   = isset($best['d']) ? ($best['d'].' '.$best['t']) : null;
        }
        birdnetRespond($db, $educatorScope, [
            'hours' => $hours, 'date' => $ctx['date'], 'station_date' => $ctx['today'],
            'is_today' => $ctx['is_today'], 'anchor' => $ctx['anchor'],
            'reset_at_midnight' => $window['reset_at_midnight'],
            'midnight_clamped' => $window['midnight_clamped'],
            'window_start' => $window['window_start'],
            'species' => $rs, 'site_name' => publicSiteName($CONF_PATH), 'as_of' => date('c')
        ]);
        break;
    }

    case 'species': {
        $sci = $_GET['sci'] ?? '';
        if ($sci === '') { http_response_code(400); birdnetRespond($db, $educatorScope, ['error' => 'sci= required']); break; }
        $limit = max(1, min(1000, (int)($_GET['limit'] ?? 500)));
        $offset = max(0, (int)($_GET['offset'] ?? 0));
        $detections = rows($db,
          "SELECT detection_id, Date AS d, Time AS t, File_Name AS file, Confidence AS conf "
        . "FROM detections WHERE Sci_Name = :sn ORDER BY Date DESC, Time DESC "
        . "LIMIT ".$limit." OFFSET ".$offset,
          [':sn' => $sci]
        );
        $summary = one($db,
          "SELECT Com_Name AS com, COUNT(*) AS total, MIN(Date||' '||Time) AS first_seen, "
        . "       MAX(Date||' '||Time) AS last_seen, MAX(Confidence) AS best_conf "
        . "FROM detections WHERE Sci_Name = :sn",
          [':sn' => $sci]
        );
        birdnetRespond($db, $educatorScope, [
            'sci' => $sci,
            'summary' => $summary,
            'detections' => $detections,
            'page' => ['limit' => $limit, 'offset' => $offset, 'returned' => count($detections)],
        ]);
        break;
    }

    case 'timeseries': {
        // Aggregated time-bucketed counts for the stats charts.
        //   daily   - last $days days, detections + unique species per day
        //   by_hour - detections grouped by hour of day, last 30 days
        // The frontend backfills missing dates with zero - sparse data days
        // are otherwise dropped by the GROUP BY.
        $days = max(1, min(90, (int)($_GET['days'] ?? 30)));
        $seriesAnchor = $educatorScope !== null
            ? (one($db, 'SELECT MAX(Date) AS d FROM detections')['d'] ?? date('Y-m-d'))
            : (one($db, "SELECT DATE('now','localtime') AS d")['d'] ?? date('Y-m-d'));
        $daily = rows($db,
          "SELECT Date AS date, COUNT(*) AS detections, COUNT(DISTINCT Sci_Name) AS species "
        . "FROM detections "
        . "WHERE Date >= DATE(:series_anchor,'-".($days - 1)." day') AND Date<=:series_anchor "
        . "GROUP BY Date ORDER BY Date"
          , [':series_anchor' => $seriesAnchor]
        );
        $by_hour = rows($db,
          "SELECT CAST(strftime('%H', Time) AS INT) AS hour, COUNT(*) AS detections "
        . "FROM detections "
        . "WHERE Date >= DATE(:series_anchor,'-30 day') AND Date<=:series_anchor "
        . "GROUP BY hour ORDER BY hour"
          , [':series_anchor' => $seriesAnchor]
        );
        birdnetRespond($db, $educatorScope, [
            'days'    => $days,
            'daily'   => $daily,
            'by_hour' => $by_hour,
            'as_of'   => date('c'),
        ]);
        break;
    }

    case 'firstseen': {
        // Most recent additions to the life list - first detection per
        // species, sorted by first_seen DESC. Powers the "First Detections"
        // section on the stats view.
        $limit = max(1, min(50, (int)($_GET['limit'] ?? 10)));
        $ctx = dateContext($db, $educatorScope);
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, MIN(Date||' '||Time) AS first_seen, "
        . "       COUNT(*) AS total "
        . "FROM detections WHERE DATETIME(Date||' '||Time) <= DATETIME(:anchor) "
        . "GROUP BY Sci_Name ORDER BY first_seen DESC LIMIT :lim",
          [':anchor' => $ctx['anchor'], ':lim' => $limit]
        );
        birdnetRespond($db, $educatorScope, [
            'date' => $ctx['date'], 'station_date' => $ctx['today'],
            'is_today' => $ctx['is_today'], 'species' => $rs, 'as_of' => date('c')
        ]);
        break;
    }

    case 'calendar': {
        // Small date index for the Stats calendar. Counts let the UI mark
        // days with detections without guessing from the currently selected
        // window, while empty days remain selectable and honest.
        $today = one($db, "SELECT DATE('now','localtime') AS d")['d'] ?? date('Y-m-d');
        $rs = rows($db,
          "SELECT Date AS date, COUNT(*) AS detections, "
        . "COUNT(DISTINCT Sci_Name) AS species FROM detections "
        . "WHERE Date <= :today GROUP BY Date ORDER BY Date",
          [':today' => $today]
        );
        birdnetRespond($db, $educatorScope, [
            'station_date' => $today,
            'first_date' => $rs[0]['date'] ?? null,
            'last_date' => $rs ? $rs[count($rs) - 1]['date'] : null,
            'days' => $rs,
            'as_of' => date('c'),
        ]);
        break;
    }

    case 'rhythm': {
        // Minute-of-day pulse for the stats window. Short windows and 24H show
        // one selected day against the preceding week's average. 7D shows the
        // average daily shape of that seven-day block against the seven days
        // immediately before it. ALL intentionally returns the selected day:
        // the global date pager can then walk the station history day by day.
        $days = max(1, min(30, (int)($_GET['days'] ?? 7)));
        $hours = max(1, min(1000000, (int)($_GET['hours'] ?? 24)));
        $ctx = dateContext($db, $educatorScope);
        // Slot 0..1439 = hour*60 + minute.
        $slot = "(CAST(strftime('%H', Time) AS INT) * 60 "
              . "+ CAST(strftime('%M', Time) AS INT))";
        $day = $ctx['date'];
        $isToday = $ctx['is_today'];
        $mode = $hours === 168 ? 'week' : ($hours >= 1000000 ? 'all-day' : 'day');
        if ($mode === 'week') {
            $today = rows($db,
              "SELECT $slot AS slot, ROUND(COUNT(*) * 1.0 / 7, 2) AS detections "
            . "FROM detections WHERE DATETIME(Date||' '||Time) > DATETIME(:anchor,'-168 hours') "
            . "AND DATETIME(Date||' '||Time) <= DATETIME(:anchor) GROUP BY slot ORDER BY slot",
              [':anchor' => $ctx['anchor']]
            );
            $avg = rows($db,
              "SELECT $slot AS slot, ROUND(COUNT(*) * 1.0 / 7, 2) AS avg "
            . "FROM detections WHERE DATETIME(Date||' '||Time) > DATETIME(:anchor,'-336 hours') "
            . "AND DATETIME(Date||' '||Time) <= DATETIME(:anchor,'-168 hours') GROUP BY slot ORDER BY slot",
              [':anchor' => $ctx['anchor']]
            );
        } else {
            $today = rows($db,
              "SELECT $slot AS slot, COUNT(*) AS detections "
            . "FROM detections WHERE Date = :d GROUP BY slot ORDER BY slot",
              [':d' => $day]
            );
            $avg = rows($db,
              "SELECT $slot AS slot, ROUND(COUNT(*) * 1.0 / ".$days.", 2) AS avg "
            . "FROM detections WHERE Date >= DATE(:d,'-".$days." day') AND Date < :d "
            . "GROUP BY slot ORDER BY slot",
              [':d' => $day]
            );
        }
        // The station's own current slot: the frontend draws the live day's
        // line only up to it. A past day is complete, so its line runs the
        // whole way.
        $nb = one($db, "SELECT (CAST(strftime('%H','now','localtime') AS INT) * 60 "
                     . "+ CAST(strftime('%M','now','localtime') AS INT)) AS s");
        $nowSlot = ($isToday && $mode !== 'week') ? (int)($nb['s'] ?? 1439) : 1439;
        $rangeStart = $hours <= 1 ? max(0, $nowSlot - 59)
                    : ($hours <= 12 ? max(0, $nowSlot - 719) : 0);
        $rangeEnd = $hours <= 12 ? $nowSlot : 1439;
        birdnetRespond($db, $educatorScope, [
            'days'     => $days,
            'hours'    => $hours,
            'mode'     => $mode,
            'date'     => $day,
            'station_date' => $ctx['today'],
            'is_today' => $isToday,
            'slots'    => 1440,
            'today'    => $today,
            'avg'      => $avg,
            'now_slot' => $nowSlot,
            'now_hour' => intdiv($nowSlot, 60),
            'range_start_slot' => $rangeStart,
            'range_end_slot' => $rangeEnd,
            'as_of'    => date('c'),
        ]);
        break;
    }

    case 'hourly': {
        // Species-by-hour ledger for one calendar day (the station's local
        // date): the day's top species, each with per-hour detection counts.
        // Hours with no rows are absent - the frontend backfills zeros, same
        // convention as timeseries. Powers the hourly tab on the stats view.
        // "Today" comes from SQLite's localtime, the same clock the rows
        // were written against and the same one the rhythm query uses.
        // PHP's date() follows date.timezone, which on a stock Pi is UTC:
        // taking today from there puts a US station a day ahead every
        // evening and the ledger reads empty.
        $ctx = dateContext($db, $educatorScope);
        $today = $ctx['today'];
        $date = $ctx['date'];
        $limit = max(1, min(30, (int)($_GET['limit'] ?? 15)));
        $rs = rows($db,
          "WITH top AS ( "
        . "  SELECT Sci_Name FROM detections WHERE Date = :d "
        . "  GROUP BY Sci_Name ORDER BY COUNT(*) DESC, Sci_Name ASC LIMIT :lim "
        . ") "
        . "SELECT d.Sci_Name AS sci, d.Com_Name AS com, "
        . "       CAST(strftime('%H', d.Time) AS INT) AS hour, COUNT(*) AS n "
        . "FROM detections d JOIN top ON top.Sci_Name = d.Sci_Name "
        . "WHERE d.Date = :d GROUP BY d.Sci_Name, hour",
          [':d' => $date, ':lim' => $limit]
        );
        // Pivot to one entry per species, ordered by the day's total.
        $species = [];
        foreach ($rs as $r) {
            $sci = $r['sci'];
            if (!isset($species[$sci])) {
                $species[$sci] = ['sci' => $sci, 'com' => $r['com'], 'total' => 0, 'hours' => []];
            }
            $species[$sci]['hours'][] = ['hour' => (int)$r['hour'], 'n' => (int)$r['n']];
            $species[$sci]['total'] += (int)$r['n'];
        }
        $species = array_values($species);
        usort($species, function ($a, $b) {
            return $b['total'] <=> $a['total'] ?: strcmp($a['sci'], $b['sci']);
        });
        birdnetRespond($db, $educatorScope, [
            'date'    => $date,
            'station_date' => $today,
            'is_today' => $date === $today,
            'anchor_hour' => $date === $today
                ? (int)(one($db, "SELECT CAST(strftime('%H','now','localtime') AS INT) AS h")['h'] ?? 23)
                : 23,
            'species' => $species,
            'as_of'   => date('c'),
        ]);
        break;
    }

    default:
        http_response_code(404);
        birdnetRespond($db, $educatorScope, ['error' => 'unknown action']);
}
