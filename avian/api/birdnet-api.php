<?php
// AvianVisitors - JSON facade over BirdNET-Pi's birds.db. Read-only.
// Symlinked into the BirdNET-Pi Caddy site root at /avian/api/.
//
// Endpoints (?action=...):
//   stats       - totals (detections, unique species, today, last hour)
//   lifelist    - every species with first_seen, last_seen, total_count
//   recent      - &hours=N (default 24): species heard in the window
//   species     - &sci=<sci_name>: per-species detail page
//   timeseries  - &days=N: daily detection counts per species
//   firstseen   - every species' earliest detection
//
// Default LAN deploy ships without auth. If you've exposed the Pi via
// Cloudflare or a tunnel, add a Caddy `basic_auth` matcher around the
// /avian/api/* path - see avian/forwarding/.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=30');

// PHP resolves __DIR__ through symlinks to the realpath. This script
// lives at $HOME/BirdNET-Pi/avian/api/birdnet-api.php (served via the
// ${EXTRACTED}/avian symlink). dirname(..., 2) walks to the BirdNET-Pi
// install root. Works under any username because we never bake the
// home directory in. getenv('HOME') would resolve to /var/lib/caddy
// under PHP-FPM (BirdNET-Pi runs it as the caddy user), so it can't
// be relied on.
$DB_PATH = dirname(__DIR__, 2) . '/scripts/birds.db';

if (!file_exists($DB_PATH)) {
    http_response_code(503);
    echo json_encode(['error' => 'birds.db not found']);
    exit;
}

try {
    $db = new SQLite3($DB_PATH, SQLITE3_OPEN_READONLY);
    $db->busyTimeout(2000);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'db open failed']);
    exit;
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

function get_dutch_labels(): array {
    static $labels = null;
    if ($labels === null) {
        $path = dirname(__DIR__, 2) . '/model/l18n/labels_nl.json';
        $content = @file_get_contents($path);
        $labels = $content !== false ? json_decode($content, true) : [];
        if (!is_array($labels)) {
            $labels = [];
        }
    }
    return $labels;
}

function localize_com_name(string $sci, ?string $fallback = null): string {
    $labels = get_dutch_labels();
    $translated = $labels[$sci] ?? null;
    if (is_string($translated) && $translated !== '') {
        return $translated;
    }
    return $fallback !== null && $fallback !== '' ? $fallback : $sci;
}

function localize_rows(array $rows): array {
    $out = [];
    foreach ($rows as $row) {
        if (!is_array($row)) {
            $out[] = $row;
            continue;
        }
        $sci = $row['sci'] ?? $row['Sci_Name'] ?? null;
        $fallback = $row['com'] ?? $row['Com_Name'] ?? null;
        if (is_string($sci) && $sci !== '') {
            $row['com'] = localize_com_name($sci, is_string($fallback) ? $fallback : null);
        } elseif (is_string($fallback)) {
            $row['com'] = $fallback;
        }
        $out[] = $row;
    }
    return $out;
}

$action = $_GET['action'] ?? 'stats';

switch ($action) {

    case 'stats': {
        $total       = (int)(one($db, 'SELECT COUNT(*) AS n FROM detections')['n'] ?? 0);
        $species     = (int)(one($db, 'SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections')['n'] ?? 0);
        $today       = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE Date = DATE('now','localtime')")['n'] ?? 0);
        $todaySpec   = (int)(one($db, "SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections WHERE Date = DATE('now','localtime')")['n'] ?? 0);
        $lastHour    = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE Date = DATE('now','localtime') AND Time >= TIME('now','localtime','-1 hour')")['n'] ?? 0);
        $week        = (int)(one($db, "SELECT COUNT(*) AS n FROM detections WHERE Date >= DATE('now','localtime','-7 day')")['n'] ?? 0);
        $weekSpec    = (int)(one($db, "SELECT COUNT(DISTINCT Sci_Name) AS n FROM detections WHERE Date >= DATE('now','localtime','-7 day')")['n'] ?? 0);
        $first       = one($db, 'SELECT MIN(Date) AS d FROM detections');
        echo json_encode([
            'totals'    => ['detections' => $total, 'species' => $species],
            'today'     => ['detections' => $today, 'species' => $todaySpec],
            'last_hour' => ['detections' => $lastHour],
            'week'      => ['detections' => $week,  'species' => $weekSpec],
            'started'   => $first['d'] ?? null,
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
        $rs = localize_rows($rs);
        echo json_encode(['species' => $rs, 'as_of' => date('c')]);
        break;
    }

    case 'recent': {
        // Cap raised to 1,000,000 hours (~114 years) so the frontend's
        // "ALL" button can turn off the time filter without needing a
        // separate code path.
        $hours = max(1, min(1000000, (int)($_GET['hours'] ?? 24)));
        // species-collapsed view: one row per species seen in the window,
        // with the file of its highest-confidence detection inside the window.
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, COUNT(*) AS n, MAX(Confidence) AS best_conf, "
        . "       MAX(Date||' '||Time) AS last_seen "
        . "FROM detections "
        . "WHERE (julianday('now','localtime') - julianday(Date||' '||Time)) * 24 <= :hrs "
        . "GROUP BY Sci_Name ORDER BY last_seen DESC",
          [':hrs' => $hours]
        );
        $rs = localize_rows($rs);
        // for each row, attach the file of the top-confidence detection in the window
        foreach ($rs as &$r) {
            $best = one($db,
              "SELECT File_Name AS file, Date AS d, Time AS t, Confidence AS conf "
            . "FROM detections "
            . "WHERE Sci_Name = :sn "
            . "AND (julianday('now','localtime') - julianday(Date||' '||Time)) * 24 <= :hrs "
            . "ORDER BY Confidence DESC LIMIT 1",
              [':sn' => $r['sci'], ':hrs' => $hours]
            );
            $r['top_file'] = $best['file'] ?? null;
            $r['top_at']   = isset($best['d']) ? ($best['d'].' '.$best['t']) : null;
        }
        echo json_encode(['hours' => $hours, 'species' => $rs, 'as_of' => date('c')]);
        break;
    }

    case 'species': {
        $sci = $_GET['sci'] ?? '';
        if ($sci === '') { http_response_code(400); echo json_encode(['error' => 'sci= required']); break; }
        $detections = rows($db,
          "SELECT Date AS d, Time AS t, File_Name AS file, Confidence AS conf "
        . "FROM detections WHERE Sci_Name = :sn ORDER BY Date DESC, Time DESC LIMIT 500",
          [':sn' => $sci]
        );
        $summary = one($db,
          "SELECT Com_Name AS com, COUNT(*) AS total, MIN(Date||' '||Time) AS first_seen, "
        . "       MAX(Date||' '||Time) AS last_seen, MAX(Confidence) AS best_conf "
        . "FROM detections WHERE Sci_Name = :sn",
          [':sn' => $sci]
        );
        if (is_array($summary)) {
            $summary['com'] = localize_com_name($sci, $summary['com'] ?? null);
        }
        echo json_encode(['sci' => $sci, 'summary' => $summary, 'detections' => $detections]);
        break;
    }

    case 'timeseries': {
        // Aggregated time-bucketed counts for the stats charts.
        //   daily   - last $days days, detections + unique species per day
        //   by_hour - detections grouped by hour of day, last 30 days
        // The frontend backfills missing dates with zero - sparse data days
        // are otherwise dropped by the GROUP BY.
        $days = max(1, min(90, (int)($_GET['days'] ?? 30)));
        $daily = rows($db,
          "SELECT Date AS date, COUNT(*) AS detections, COUNT(DISTINCT Sci_Name) AS species "
        . "FROM detections "
        . "WHERE Date >= DATE('now','localtime','-".($days - 1)." day') "
        . "GROUP BY Date ORDER BY Date"
        );
        $by_hour = rows($db,
          "SELECT CAST(strftime('%H', Time) AS INT) AS hour, COUNT(*) AS detections "
        . "FROM detections "
        . "WHERE Date >= DATE('now','localtime','-30 day') "
        . "GROUP BY hour ORDER BY hour"
        );
        echo json_encode([
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
        $rs = rows($db,
          "SELECT Sci_Name AS sci, Com_Name AS com, MIN(Date||' '||Time) AS first_seen, "
        . "       COUNT(*) AS total "
        . "FROM detections GROUP BY Sci_Name ORDER BY first_seen DESC LIMIT :lim",
          [':lim' => $limit]
        );
        $rs = localize_rows($rs);
        echo json_encode(['species' => $rs, 'as_of' => date('c')]);
        break;
    }

    default:
        http_response_code(404);
        echo json_encode(['error' => 'unknown action']);
}
