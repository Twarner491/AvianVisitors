<?php
declare(strict_types=1);

define('AVIAN_EDUCATOR_STORE_LIBRARY_ONLY', true);
require_once dirname(__DIR__) . '/avian/api/educator-scope.php';

$checks = 0;
$failures = 0;
function scope_check(bool $condition, string $label): void {
    global $checks, $failures;
    $checks++;
    if ($condition) return;
    $failures++;
    fwrite(STDERR, "FAIL: $label\n");
}

$path = tempnam(sys_get_temp_dir(), 'avian-scope-performance-');
if (!is_string($path)) throw new RuntimeException('temporary database unavailable');
register_shutdown_function(function () use ($path): void {
    foreach ([$path, $path . '-wal', $path . '-shm'] as $candidate) {
        if (is_file($candidate)) @unlink($candidate);
    }
});

$generation = str_repeat('a', 32);
$writer = new SQLite3($path);
$writer->enableExceptions(true);
$writer->exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; BEGIN;'
    . 'CREATE TABLE detections(Date TEXT,Time TEXT,Sci_Name TEXT NOT NULL,Com_Name TEXT NOT NULL,'
    . 'Confidence REAL,Lat REAL,Lon REAL,Cutoff REAL,Week INTEGER,Sens REAL,Overlap REAL,File_Name TEXT NOT NULL);'
    . 'CREATE INDEX detections_Date_Time ON detections(Date DESC,Time DESC);'
    . 'CREATE TABLE avian_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;'
    . "INSERT INTO avian_metadata VALUES('educator_generation','$generation');"
    . "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<120001) "
    . "INSERT INTO detections(Date,Time,Sci_Name,Com_Name,Confidence,File_Name) "
    . "SELECT '2026-01-01',printf('%02d:%02d:%02d',(x/3600)%24,(x/60)%60,x%60),"
    . "printf('Avis testus %d',x%32),printf('Test Bird %d',x%32),0.9,printf('test-%d.mp3',x) FROM n;"
    . 'CREATE TABLE ' . AVIAN_DETECTION_SEQUENCE_TABLE
    . ' (sequence INTEGER PRIMARY KEY AUTOINCREMENT, detection_rowid INTEGER NOT NULL UNIQUE);'
    . 'INSERT INTO ' . AVIAN_DETECTION_SEQUENCE_TABLE . '(detection_rowid) SELECT rowid FROM detections ORDER BY rowid;'
);
foreach (['insert', 'delete', 'update'] as $action) {
    $writer->exec(educator_detection_sequence_trigger_sql($action));
}
$writer->exec('COMMIT');
$writer->close();

function scope_segment(int $id, int $sequence, string $generation): array {
    return scope_interval(
        $id,
        $sequence,
        $generation,
        '2026-01-01 00:00:00',
        '2026-01-02 00:00:00'
    );
}
function scope_interval(
    int $id,
    int $sequence,
    string $generation,
    string $start,
    ?string $stop,
    string $timezone = 'UTC'
): array {
    $zone = new DateTimeZone($timezone);
    $started = new DateTimeImmutable($start, $zone);
    $stopped = $stop === null ? null : new DateTimeImmutable($stop, $zone);
    return [
        'id' => $id,
        'capture_id' => $id,
        'started_local' => $started->format('Y-m-d H:i:s'),
        'started_at_utc' => $started->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
        'started_epoch' => $started->getTimestamp(),
        'started_offset' => $started->format('P'),
        'started_timezone' => $timezone,
        'stopped_local' => $stopped?->format('Y-m-d H:i:s'),
        'stopped_at_utc' => $stopped?->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
        'stopped_epoch' => $stopped?->getTimestamp(),
        'stopped_offset' => $stopped?->format('P'),
        'stopped_timezone' => $stopped === null ? null : $timezone,
        'birds_generation' => $generation,
        'start_sequence' => $sequence,
        'revision' => 1,
    ];
}
function scope_reader(string $path): SQLite3 {
    $db = new SQLite3($path, SQLITE3_OPEN_READONLY);
    $db->enableExceptions(true);
    $db->busyTimeout(2000);
    $db->exec('BEGIN');
    return $db;
}

$planDb = scope_reader($path);
$planDb->exec(
    'CREATE TEMP TABLE detections(detection_id INTEGER PRIMARY KEY,Date DATE,Time TIME,'
    . 'Sci_Name TEXT NOT NULL,Com_Name TEXT NOT NULL,Confidence REAL,Lat REAL,Lon REAL,'
    . 'Cutoff REAL,Week INTEGER,Sens REAL,Overlap REAL,File_Name TEXT NOT NULL)'
);
$plan = $planDb->prepare('EXPLAIN QUERY PLAN ' . educator_scope_materialize_sql(true));
foreach ([
    ':sequence' => 0,
    ':started_date' => '2026-01-01',
    ':started_time' => '00:00:00',
    ':stopped_date' => '2026-01-02',
    ':stopped_time' => '00:00:00',
    ':scope_limit' => AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS + 1,
] as $key => $value) {
    $plan->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
}
$details = [];
$result = $plan->execute();
while ($row = $result->fetchArray(SQLITE3_ASSOC)) $details[] = (string)$row['detail'];
$planText = implode(' | ', $details);
scope_check(str_contains($planText, 'detections_Date_Time')
    && str_contains($planText, '(Date,Time)'),
    'normalized scope materialization uses the Date/Time interval index');
$planDb->exec(
    'CREATE TEMP TABLE educator_scope_probe_hits('
    . 'detection_id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL)'
);
$probePlan = $planDb->prepare('EXPLAIN QUERY PLAN ' . educator_scope_probe_sql(true));
foreach ([
    ':sequence' => 0,
    ':started_date' => '2026-01-01',
    ':started_time' => '00:00:00',
    ':stopped_date' => '2026-01-02',
    ':stopped_time' => '00:00:00',
    ':scope_limit' => AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS + 1,
] as $key => $value) {
    $probePlan->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
}
$probeDetails = [];
$probePlanResult = $probePlan->execute();
while ($row = $probePlanResult->fetchArray(SQLITE3_ASSOC)) {
    $probeDetails[] = (string)$row['detail'];
}
$probePlanText = implode(' | ', $probeDetails);
scope_check(str_contains($probePlanText, 'detections_Date_Time')
    && str_contains($probePlanText, '(Date,Time)'),
    'saved-scope probe uses the Date/Time interval index');
$planDb->exec('ROLLBACK');
$planDb->close();

$partial = educator_scope_normalized_segments([
    scope_interval(10, 100, $generation, '2026-01-01 00:00:00', '2026-01-01 00:10:00'),
    scope_interval(11, 50, $generation, '2026-01-01 00:05:00', '2026-01-01 00:15:00'),
]);
scope_check($partial === [
    ['started_local' => '2026-01-01 00:00:00', 'stopped_local' => '2026-01-01 00:05:00', 'start_sequence' => 100],
    ['started_local' => '2026-01-01 00:05:00', 'stopped_local' => '2026-01-01 00:15:00', 'start_sequence' => 50],
], 'partial overlaps use the minimum active sequence floor and merge equal adjacent slices');

$nested = educator_scope_normalized_segments([
    scope_interval(12, 100, $generation, '2026-01-01 00:00:00', '2026-01-01 00:20:00'),
    scope_interval(13, 200, $generation, '2026-01-01 00:05:00', '2026-01-01 00:15:00'),
]);
scope_check($nested === [[
    'started_local' => '2026-01-01 00:00:00',
    'stopped_local' => '2026-01-01 00:20:00',
    'start_sequence' => 100,
]], 'a nested stricter sequence floor does not split equivalent union membership');

$identical = educator_scope_normalized_segments([
    scope_interval(14, 300, $generation, '2026-01-01 00:00:00', '2026-01-01 00:10:00'),
    scope_interval(15, 75, $generation, '2026-01-01 00:00:00', '2026-01-01 00:10:00'),
]);
scope_check($identical === [[
    'started_local' => '2026-01-01 00:00:00',
    'stopped_local' => '2026-01-01 00:10:00',
    'start_sequence' => 75,
]], 'identical intervals collapse to one exact union predicate');

$adjacent = educator_scope_normalized_segments([
    scope_interval(16, 20, $generation, '2026-01-01 00:00:00', '2026-01-01 00:05:00'),
    scope_interval(17, 20, $generation, '2026-01-01 00:05:00', '2026-01-01 00:10:00'),
    scope_interval(18, 10, $generation, '2026-01-01 00:10:00', '2026-01-01 00:15:00'),
]);
scope_check($adjacent === [
    ['started_local' => '2026-01-01 00:00:00', 'stopped_local' => '2026-01-01 00:10:00', 'start_sequence' => 20],
    ['started_local' => '2026-01-01 00:10:00', 'stopped_local' => '2026-01-01 00:15:00', 'start_sequence' => 10],
], 'same-floor adjacent intervals merge while a changed floor keeps the shared-second boundary');

$open = educator_scope_normalized_segments([
    scope_interval(19, 100, $generation, '2026-01-01 00:00:00', null),
    scope_interval(20, 50, $generation, '2026-01-01 00:05:00', '2026-01-01 00:10:00'),
]);
scope_check($open === [
    ['started_local' => '2026-01-01 00:00:00', 'stopped_local' => '2026-01-01 00:05:00', 'start_sequence' => 100],
    ['started_local' => '2026-01-01 00:05:00', 'stopped_local' => '2026-01-01 00:10:00', 'start_sequence' => 50],
    ['started_local' => '2026-01-01 00:10:00', 'stopped_local' => null, 'start_sequence' => 100],
], 'an open interval resumes its prior floor after a broader finite overlap');

$dst = educator_scope_normalized_segments([
    scope_interval(21, 1, $generation, '2026-03-08 01:55:00', '2026-03-08 03:05:00', 'America/Los_Angeles'),
]);
scope_check($dst === [[
    'started_local' => '2026-03-08 01:55:00',
    'stopped_local' => '2026-03-08 03:05:00',
    'start_sequence' => 1,
]], 'DST offsets validate independently while BirdNET wall-time boundaries remain exact');

$exactSegment = scope_segment(1, 100001, $generation);
$actions = [
    'stats' => 'SELECT COUNT(*) FROM detections',
    'lifelist' => 'SELECT COUNT(*) FROM (SELECT Sci_Name FROM detections GROUP BY Sci_Name)',
    'timeseries' => 'SELECT COUNT(*) FROM (SELECT Date FROM detections GROUP BY Date)',
    'firstseen' => 'SELECT COUNT(*) FROM (SELECT Sci_Name,MIN(Date||Time) FROM detections GROUP BY Sci_Name)',
    'recent' => 'SELECT COUNT(*) FROM (SELECT Sci_Name,MAX(Date||Time) FROM detections GROUP BY Sci_Name)',
    'rhythm' => "SELECT COUNT(*) FROM (SELECT substr(Time,1,5) FROM detections GROUP BY substr(Time,1,5))",
    'hourly' => "SELECT COUNT(*) FROM (SELECT substr(Time,1,2) FROM detections GROUP BY substr(Time,1,2))",
    'calendar' => 'SELECT COUNT(*) FROM (SELECT Date,COUNT(*) FROM detections GROUP BY Date)',
];
$overlap128 = [];
for ($index = 0; $index < 128; $index++) {
    $overlap128[] = scope_segment(1000 + $index, 100001, $generation);
}
scope_check(count(educator_scope_normalized_segments($overlap128)) === 1,
    '128 identical intervals collapse to one materialization query');
$safeReaders = [];
$safeStarted = microtime(true);
foreach ($actions as $name => $sql) {
    $db = scope_reader($path);
    $scope = ['_segments' => $overlap128];
    educator_scope_detection_table($db, $scope);
    scope_check((int)$db->querySingle('SELECT COUNT(*) FROM detections')
        === AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS, "$name keeps an exact-cap union complete");
    $db->querySingle($sql);
    $safeReaders[] = $db;
}
$safeElapsed = microtime(true) - $safeStarted;
scope_check($safeElapsed < 8.0,
    'the eight-action 128-overlap batch completes within the normalized acceptance budget');
foreach ($safeReaders as $db) { $db->exec('ROLLBACK'); $db->close(); }

$overlap8192 = [];
for ($index = 0; $index < 8192; $index++) {
    $overlap8192[] = scope_segment(2000 + $index, 100001, $generation);
}
$normalizeStarted = microtime(true);
$normalized8192 = educator_scope_normalized_segments($overlap8192);
$normalizeElapsed = microtime(true) - $normalizeStarted;
scope_check(count($normalized8192) === 1 && $normalizeElapsed < 3.0,
    '8,192 identical intervals normalize to one query in bounded O(n log n) work');
$maximumOverlapDb = scope_reader($path);
$maximumOverlapScope = ['_segments' => $overlap8192];
educator_scope_detection_table($maximumOverlapDb, $maximumOverlapScope);
scope_check((int)$maximumOverlapDb->querySingle('SELECT COUNT(*) FROM detections')
    === AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS,
    'the maximum raw overlap still materializes the complete exact-cap union once');
$maximumOverlapDb->exec('ROLLBACK');
$maximumOverlapDb->close();
$maximumOverlapProbeDb = scope_reader($path);
$maximumOverlapProbeScope = [
    'id' => 'f_' . str_repeat('1', 32),
    '_segments' => $overlap8192,
];
$maximumOverlapProbe = educator_scope_probe($maximumOverlapProbeDb, $maximumOverlapProbeScope);
scope_check($maximumOverlapProbe['open'] === false
    && preg_match('/\A[a-f0-9]{24}\z/D', $maximumOverlapProbe['fingerprint']) === 1
    && (int)$maximumOverlapProbeDb->querySingle(
        'SELECT COUNT(*) FROM temp.educator_scope_probe_hits'
    ) === AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS,
    'the maximum raw overlap probe deduplicates the complete exact-cap union once');
$maximumOverlapProbeDb->exec('ROLLBACK');
$maximumOverlapProbeDb->close();

$disjoint = [];
$base = new DateTimeImmutable('2026-01-01 00:00:00', new DateTimeZone('UTC'));
for ($index = 0; $index <= AVIAN_EDUCATOR_SCOPE_MAX_SLICES; $index++) {
    $start = $base->modify('+' . ($index * 2) . ' seconds')->format('Y-m-d H:i:s');
    $stop = $base->modify('+' . ($index * 2 + 1) . ' seconds')->format('Y-m-d H:i:s');
    $disjoint[] = scope_interval(11000 + $index, $index, $generation, $start, $stop);
}
$sliceDb = scope_reader($path);
$sliceScope = ['_segments' => $disjoint];
$sliceStatus = 0;
try {
    educator_scope_detection_table($sliceDb, $sliceScope);
} catch (EducatorScopeError $error) {
    $sliceStatus = $error->httpStatus;
}
scope_check($sliceStatus === 413
    && (int)$sliceDb->querySingle(
        "SELECT COUNT(*) FROM sqlite_temp_master WHERE name='detections'"
    ) === 0,
    '513 disjoint slices fail honestly before a TEMP relation or SQL query is created');
$sliceDb->exec('ROLLBACK');
$sliceDb->close();
$sliceProbeDb = scope_reader($path);
$sliceProbeScope = [
    'id' => 'f_' . str_repeat('2', 32),
    '_segments' => $disjoint,
];
$sliceProbeStatus = 0;
try {
    educator_scope_probe($sliceProbeDb, $sliceProbeScope);
} catch (EducatorScopeError $error) {
    $sliceProbeStatus = $error->httpStatus;
}
scope_check($sliceProbeStatus === 413
    && (int)$sliceProbeDb->querySingle(
        "SELECT COUNT(*) FROM sqlite_temp_master WHERE name='educator_scope_probe_hits'"
    ) === 0,
    'probe rejects 513 normalized slices before creating its TEMP hit table');
$sliceProbeDb->exec('ROLLBACK');
$sliceProbeDb->close();

$broadSegment = scope_segment(2, 0, $generation);
$broadReaders = [];
$broadStarted = microtime(true);
foreach (array_keys($actions) as $name) {
    $db = scope_reader($path);
    $scope = ['_segments' => [$broadSegment]];
    $status = 0;
    try {
        educator_scope_detection_table($db, $scope);
    } catch (EducatorScopeError $error) {
        $status = $error->httpStatus;
    }
    scope_check($status === 413, "$name rejects a 120,001-detection capability");
    scope_check((int)$db->querySingle('SELECT COUNT(*) FROM temp.detections')
        === AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS + 1,
        "$name stops materialization at one overflow sentinel");
    $broadReaders[] = $db;
}
$broadElapsed = microtime(true) - $broadStarted;
scope_check($broadElapsed < 30.0, 'the eight-action over-cap batch fails within the acceptance budget');
foreach ($broadReaders as $db) { $db->exec('ROLLBACK'); $db->close(); }
$broadProbeDb = scope_reader($path);
$broadProbeScope = [
    'id' => 'f_' . str_repeat('3', 32),
    '_segments' => [$broadSegment],
];
$broadProbeStatus = 0;
try {
    educator_scope_probe($broadProbeDb, $broadProbeScope);
} catch (EducatorScopeError $error) {
    $broadProbeStatus = $error->httpStatus;
}
scope_check($broadProbeStatus === 413
    && (int)$broadProbeDb->querySingle(
        'SELECT COUNT(*) FROM temp.educator_scope_probe_hits'
    ) === AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS + 1,
    'probe enforces the same 20,001-row overflow sentinel as full scope materialization');
$broadProbeDb->exec('ROLLBACK');
$broadProbeDb->close();

$overlapDb = scope_reader($path);
$overlapScope = ['_segments' => [$exactSegment, scope_segment(3, 100000, $generation)]];
$overlapStatus = 0;
try {
    educator_scope_detection_table($overlapDb, $overlapScope);
} catch (EducatorScopeError $error) {
    $overlapStatus = $error->httpStatus;
}
scope_check($overlapStatus === 413
    && (int)$overlapDb->querySingle('SELECT COUNT(*) FROM temp.detections')
        === AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS + 1,
    'an overlapping segment cannot hide one unique row beyond the cap');
$overlapDb->exec('ROLLBACK');
$overlapDb->close();

$tooLarge = new EducatorScopeError('educator scope has too many detections; select a smaller folder', 413);
scope_check(educator_public_scope_error($tooLarge, false)
    === [413, 'educator scope has too many detections; select a smaller folder'],
    'private over-cap errors explain how to recover');
scope_check(educator_public_scope_error($tooLarge, true) === [413, 'saved view unavailable'],
    'public over-cap errors do not reveal capability metadata');

printf(
    "Educator scope performance: %d checks, 128-overlap batch %.3fs, 8192 normalize %.3fs, over-cap batch %.3fs\n",
    $checks,
    $safeElapsed,
    $normalizeElapsed,
    $broadElapsed
);
exit($failures === 0 ? 0 : 1);
