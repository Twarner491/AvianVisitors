<?php
declare(strict_types=1);

define('AVIAN_EDUCATOR_STORE_LIBRARY_ONLY', true);
require_once dirname(__DIR__) . '/avian/api/educator-scope.php';
define('AVIAN_EDUCATORS_LIBRARY_ONLY', true);
require_once dirname(__DIR__) . '/avian/api/educators.php';

$checks = 0;
$failures = 0;
function edu_check(bool $condition, string $label): void {
    global $checks, $failures;
    $checks++;
    if ($condition) return;
    $failures++;
    fwrite(STDERR, "FAIL: $label\n");
}
function edu_throws(callable $call, int $status, string $label): void {
    try {
        $call();
        edu_check(false, $label);
    } catch (Throwable $error) {
        $actual = $error instanceof EducatorStoreError || $error instanceof EducatorScopeError
            ? $error->httpStatus : 0;
        edu_check($actual === $status, $label . " (status $actual)");
    }
}
function edu_set_marker(SQLite3 $db, string $marker): void {
    $stmt = $db->prepare(
        "INSERT INTO avian_metadata(key,value) VALUES('educator_generation',:value) "
        . 'ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    $stmt->bindValue(':value', $marker, SQLITE3_TEXT);
    $stmt->execute();
}
function edu_install_sequence(SQLite3 $db): void {
    $db->exec('CREATE TABLE IF NOT EXISTS ' . AVIAN_DETECTION_SEQUENCE_TABLE
        . ' (sequence INTEGER PRIMARY KEY AUTOINCREMENT, detection_rowid INTEGER NOT NULL UNIQUE)');
    $db->exec('INSERT INTO ' . AVIAN_DETECTION_SEQUENCE_TABLE . '(detection_rowid) '
        . 'SELECT d.rowid FROM detections d LEFT JOIN ' . AVIAN_DETECTION_SEQUENCE_TABLE
        . ' s ON s.detection_rowid=d.rowid WHERE s.sequence IS NULL ORDER BY d.rowid');
    foreach (['insert', 'delete', 'update'] as $action) {
        $db->exec(educator_detection_sequence_trigger_sql($action));
    }
}
function edu_insert_detection(
    SQLite3 $db,
    string $date,
    string $time,
    string $file,
    string $sci = 'Avis testus',
    string $common = 'Test Bird'
): int {
    $stmt = $db->prepare(
        'INSERT INTO detections(Date,Time,Sci_Name,Com_Name,Confidence,File_Name) '
        . 'VALUES(:date,:time,:sci,:common,0.91,:file)'
    );
    foreach ([':date' => $date, ':time' => $time, ':sci' => $sci, ':common' => $common, ':file' => $file] as $key => $value) {
        $stmt->bindValue($key, $value, SQLITE3_TEXT);
    }
    $stmt->execute();
    return (int)$db->lastInsertRowID();
}
function edu_endpoint(
    string $file,
    array $get,
    array $server,
    string $stdin = '',
    array $cookies = [],
    ?string $sessionPath = null,
    string $prelude = ''
): array {
    $code = '$_GET=' . var_export($get, true) . ';$_SERVER=' . var_export($server, true) . ';'
        . '$_COOKIE=' . var_export($cookies, true) . ';' . $prelude
        . 'register_shutdown_function(function(){fwrite(STDERR,"\\nSTATUS:".(http_response_code()?:200));});'
        . 'include ' . var_export($file, true) . ';';
    $pipes = [];
    $command = [PHP_BINARY, '-d', 'display_errors=0'];
    if ($sessionPath !== null) {
        $command[] = '-d';
        $command[] = 'session.save_path=' . $sessionPath;
    }
    $command[] = '-r';
    $command[] = $code;
    $process = proc_open(
        $command,
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes
    );
    if (!is_resource($process)) return ['status' => 0, 'out' => '', 'err' => 'proc_open failed'];
    fwrite($pipes[0], $stdin);
    fclose($pipes[0]);
    $out = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $err = stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $exit = proc_close($process);
    $status = preg_match('/STATUS:(\d+)\s*\z/', (string)$err, $match) === 1 ? (int)$match[1] : 0;
    $err = preg_replace('/\n?STATUS:\d+\s*\z/', '', (string)$err) ?? (string)$err;
    return ['status' => $status, 'out' => (string)$out, 'err' => trim($err), 'exit' => $exit];
}
function edu_php_input_prelude(string $body): string {
    return 'final class AvianEducatorTestInputStream{public $context;private int $offset=0;'
        . 'private string $body=' . var_export($body, true) . ';'
        . 'public function stream_open($path,$mode,$options,&$openedPath):bool{return $path==="php://input";}'
        . 'public function stream_read($count):string{$part=substr($this->body,$this->offset,$count);'
        . '$this->offset+=strlen($part);return $part;}'
        . 'public function stream_eof():bool{return $this->offset>=strlen($this->body);}'
        . 'public function stream_stat():array{return [];}public function url_stat($path,$flags):array{return [];}}'
        . 'stream_wrapper_unregister("php");'
        . 'stream_wrapper_register("php",AvianEducatorTestInputStream::class);';
}

$tmp = sys_get_temp_dir() . '/avian-educator-backend-' . bin2hex(random_bytes(6));
mkdir($tmp, 0700, true);
$dataDir = $tmp . '/educators';
mkdir($dataDir, 0700);
$storePath = $dataDir . '/educators.db';
$lockPath = $tmp . '/educators.lock';
$statePath = $tmp . '/educators.state';
$maintenanceMarkerPath = $tmp . '/educators.maintenance';
$birdsPath = $tmp . '/birds.db';
file_put_contents($lockPath, '');
file_put_contents($statePath, "v1\t1\t7\n");

putenv('AV_EDUCATOR_STORE_FILE=' . $storePath);
putenv('AV_EDUCATOR_LOCK_FILE=' . $lockPath);
putenv('AV_EDUCATOR_STATE_FILE=' . $statePath);
putenv('AV_EDUCATOR_MAINTENANCE_FILE=' . $maintenanceMarkerPath);
putenv('AV_EDUCATOR_BIRDS_DB=' . $birdsPath);
putenv('AV_EDUCATOR_STORE_TEST_METADATA=1');
putenv('AV_EDUCATOR_STATE_TEST_METADATA=1');
putenv('AVIAN_STATION_TIMEZONE=UTC');
putenv('AV_EDUCATOR_NOW=2026-01-02T10:00:01+00:00');
putenv('AV_EDUCATOR_LOCK_FD=2');
edu_throws(fn() => educator_store_lock(true), 503,
    'an invalid inherited maintenance descriptor fails closed');
putenv('AV_EDUCATOR_LOCK_FD');
$fdCode = 'define("AVIAN_EDUCATOR_STORE_LIBRARY_ONLY",true);require '
    . var_export(dirname(__DIR__) . '/avian/api/educator-store.php', true)
    . ';$h=educator_store_lock(false);echo is_resource($h)?"accepted":"rejected";';
$fdPipes = [];
if (is_dir('/proc/self/fd')) {
    $fdProcess = proc_open(
        ['/bin/bash', '-c', 'exec 10<>"$1"; AV_EDUCATOR_LOCK_FD=10 exec "$2" -r "$3"',
            'avian-fd-test', $lockPath, PHP_BINARY, $fdCode],
        [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $fdPipes
    );
    $fdOutput = is_resource($fdProcess) ? stream_get_contents($fdPipes[1]) : '';
    if (is_resource($fdProcess)) {
        fclose($fdPipes[1]);
        fclose($fdPipes[2]);
        $fdStatus = proc_close($fdProcess);
    } else {
        $fdStatus = -1;
    }
} else {
    $fdStatus = 0;
    $fdOutput = 'accepted';
}
edu_check($fdStatus === 0 && $fdOutput === 'accepted',
    'the root helper inherited descriptor contract accepts exact FD 10');

$birds = new SQLite3($birdsPath);
$birds->exec('PRAGMA journal_mode=WAL');
$birds->exec(
    'CREATE TABLE detections(Date TEXT,Time TEXT,Sci_Name TEXT NOT NULL,Com_Name TEXT NOT NULL,'
    . 'Confidence REAL,Lat REAL,Lon REAL,Cutoff REAL,Week INTEGER,Sens REAL,Overlap REAL,File_Name TEXT NOT NULL);'
    . 'CREATE INDEX detections_Date_Time ON detections(Date DESC,Time DESC);'
    . 'CREATE TABLE avian_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;'
);
$generation = str_repeat('a', 32);
edu_set_marker($birds, $generation);
edu_install_sequence($birds);

$callerUmask = umask(0022);
$store = educator_store_open(true);
edu_check(umask() === 0022, 'educator store initialization restores the caller umask');
umask($callerUmask);
edu_check((int)$store->querySingle('PRAGMA application_id') === AVIAN_EDUCATOR_APPLICATION_ID,
    'educator store has the fixed application id');
edu_check(educator_state_revision($store) === 0, 'new store begins at revision zero');

$hookInserted = 0;
$GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] = function (string $phase) use ($birds, &$hookInserted): void {
    if ($phase === 'after-birds-snapshot' && $hookInserted === 0) {
        $hookInserted = edu_insert_detection(
            $birds,
            '2026-01-02',
            '10:00:01',
            'Test_Bird-91-2026-01-02-birdnet-10:00:01.mp3'
        );
    }
};
$started = educator_store_start($store, 0);
unset($GLOBALS['AVIAN_EDUCATOR_TEST_HOOK']);
$capture = $started['capture'];
edu_check($started['created'] && $hookInserted > 0, 'start creates one capture after the rowid seam hook');
edu_check($capture['segments'][0]['started_at'] === '2026-01-02T10:00:01+00:00',
    'capture stores an offset-bearing local boundary');
$startState = educator_state_revision($store);
edu_throws(fn() => educator_store_start($store, 0, $capture['name']), 409,
    'a duplicate Start click with the stale revision cannot adopt the active capture');
edu_throws(fn() => educator_store_start($store, 0, 'Competing class name'), 409,
    'a concurrent tab with a different name loses through the state revision');
edu_throws(fn() => educator_store_start($store, $startState, 'Fresh competing name'), 409,
    'a fresh Start intent is rejected while another listening period is active');
edu_throws(fn() => educator_store_start($store, $startState, "bad\nname"), 400,
    'Start validates its name intent even while another period is active');
$afterRejectedStarts = educator_current_capture_row($store);
edu_check($afterRejectedStarts !== null
    && $afterRejectedStarts['public_id'] === $capture['id']
    && $afterRejectedStarts['name'] === $capture['name']
    && educator_state_revision($store) === $startState,
    'rejected duplicate and concurrent Starts leave the active period unchanged');

$scope = educator_resolve_scope(['edu' => 'active']);
$scopedBirds = new SQLite3($birdsPath, SQLITE3_OPEN_READONLY);
educator_scope_detection_table($scopedBirds, $scope);
edu_check((int)$scopedBirds->querySingle('SELECT COUNT(*) FROM detections') === 1,
    'row inserted between floor and clock belongs to the new capture');
$publicActive = educator_scope_public($scope, false);
edu_check(isset($publicActive['state_key'], $publicActive['state_revision'])
    && !isset($publicActive['id'], $publicActive['label'], $publicActive['generation']),
    'public active scope exposes only generic replacement metadata');
$firstStateKey = $publicActive['state_key'];
educator_scope_release($scope);
$scopedBirds->close();

$folder = educator_store_create_folder($store, 'Period One', 1)['folder'];
edu_throws(fn() => educator_store_create_folder($store, 'period one', 2), 409,
    'folder names are case-insensitively unique');
$moved = educator_store_update_capture(
    $store,
    'move-capture',
    $capture['id'],
    $capture['revision'],
    2,
    $folder['id']
);
$capture = $moved['capture'];
$folderBeforePause = educator_folder_row($store, $folder['id']);

putenv('AV_EDUCATOR_NOW=2026-01-02T10:05:00+00:00');
$paused = educator_store_transition($store, 'pause', $capture['id'], $capture['revision'], 3);
$capture = $paused['capture'];
$pausedRetry = educator_store_transition($store, 'pause', $capture['id'], 1, 0);
edu_check(!$pausedRetry['changed'] && $pausedRetry['capture']['status'] === 'paused',
    'lost-response Pause retry is idempotent despite stale revisions');
edu_throws(fn() => educator_store_capture_counts(
    $store,
    [$capture['id']],
    educator_state_revision($store)
), 409, 'saved counts reject a paused listening period');
$folderAfterPause = educator_folder_row($store, $folder['id']);
edu_check((int)$folderAfterPause['revision'] > (int)$folderBeforePause['revision'],
    'pausing advances the containing folder revision');
$pausedScope = educator_resolve_scope(['edu' => 'active']);
edu_check(educator_scope_public($pausedScope, false)['state_key'] !== $firstStateKey,
    'public active state key changes when capture state changes');
educator_scope_release($pausedScope);
$gapDetection = edu_insert_detection(
    $birds,
    '2026-01-02',
    '10:07:00',
    'Gap_Bird-90-2026-01-02-birdnet-10:07:00.mp3'
);

putenv('AV_EDUCATOR_NOW=2026-01-02T10:10:00+00:00');
$resumeRaceGeneration = str_repeat('c', 32);
$GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] = function (string $phase) use ($birds, $resumeRaceGeneration): void {
    if ($phase === 'before-generation-recheck') edu_set_marker($birds, $resumeRaceGeneration);
};
edu_throws(fn() => educator_store_transition(
    $store,
    'resume',
    $capture['id'],
    $capture['revision'],
    4
), 409, 'generation rotation before commit rolls Resume back');
unset($GLOBALS['AVIAN_EDUCATOR_TEST_HOOK']);
edu_set_marker($birds, $generation);
$afterResumeRace = educator_capture_row($store, $capture['id']);
edu_check($afterResumeRace['status'] === 'paused'
    && (int)$afterResumeRace['segment_count'] === 1
    && educator_state_revision($store) === 4,
    'failed generation race leaves Resume state and segments unchanged');
$resumeSeamDetection = 0;
$GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] = function (string $phase) use ($birds, &$resumeSeamDetection): void {
    if ($phase === 'after-birds-snapshot' && $resumeSeamDetection === 0) {
        $resumeSeamDetection = edu_insert_detection(
            $birds,
            '2026-01-02',
            '10:10:00',
            'Resume_Seam-90-2026-01-02-birdnet-10:10:00.mp3'
        );
    }
};
$resumed = educator_store_transition($store, 'resume', $capture['id'], $capture['revision'], 4);
unset($GLOBALS['AVIAN_EDUCATOR_TEST_HOOK']);
$capture = $resumed['capture'];
$resumeSeamScope = educator_resolve_scope(['edu' => 'active']);
$resumeSeamBirds = new SQLite3($birdsPath, SQLITE3_OPEN_READONLY);
educator_scope_detection_table($resumeSeamBirds, $resumeSeamScope);
edu_check($resumeSeamDetection > 0
    && educator_scope_detection_row($resumeSeamBirds, $resumeSeamDetection) !== null,
    'row inserted between Resume floor sampling and its wall boundary belongs to the new segment');
educator_scope_release($resumeSeamScope);
$resumeSeamBirds->close();
$birds->exec('DELETE FROM detections WHERE rowid=' . $resumeSeamDetection);
edu_insert_detection($birds, '2026-01-02', '10:10:01', 'Second_Bird-90-2026-01-02-birdnet-10:10:01.mp3');
putenv('AV_EDUCATOR_NOW=2026-01-02T10:15:00+00:00');
$stopped = educator_store_transition($store, 'stop', $capture['id'], $capture['revision'], 5);
$capture = $stopped['capture'];
$stopRetry = educator_store_transition($store, 'stop', $capture['id'], 1, 0);
edu_check(!$stopRetry['changed'] && $stopRetry['capture']['status'] === 'stopped',
    'lost-response Stop retry is idempotent despite stale revisions');
edu_check(count($capture['segments']) === 2, 'pause and resume create two bounded segments');
edu_throws(fn() => educator_resolve_scope(['edu' => 'active']), 404,
    'literal active scope fails closed immediately after Stop');

$folderScope = educator_resolve_scope(['edu' => $folder['id']]);
$folderBirds = new SQLite3($birdsPath, SQLITE3_OPEN_READONLY);
educator_scope_detection_table($folderBirds, $folderScope);
edu_check((int)$folderBirds->querySingle('SELECT COUNT(*) FROM detections') === 2,
    'folder scope unions every segment and excludes the paused gap');
edu_check(educator_scope_detection_row($folderBirds, $hookInserted)['File_Name']
    === 'Test_Bird-91-2026-01-02-birdnet-10:00:01.mp3',
    'scoped media resolves one exact source rowid');
educator_scope_recheck_generation($folderBirds, $folderScope);
educator_scope_release($folderScope);
$folderBirds->close();

// A folder is a set union. Duplicate a capture's exact segments to prove
// overlapping listening periods never multiply one BirdNET detection.
$originalInternalId = (int)$store->querySingle(
    "SELECT id FROM captures WHERE public_id='" . SQLite3::escapeString($capture['id']) . "'"
);
$overlapId = 'c_' . str_repeat('d', 32);
$folderInternalId = (int)$store->querySingle(
    "SELECT id FROM folders WHERE public_id='" . SQLite3::escapeString($folder['id']) . "'"
);
$overlapStmt = $store->prepare(
    "INSERT INTO captures(public_id,name,status,folder_id,started_local,started_at_utc,started_epoch,"
    . "started_offset,started_timezone,stopped_local,stopped_at_utc,stopped_epoch,stopped_offset,"
    . "stopped_timezone,created_at_utc,updated_at_utc) "
    . "SELECT :public,'Overlapping period','stopped',:folder,started_local,started_at_utc,started_epoch,"
    . "started_offset,started_timezone,stopped_local,stopped_at_utc,stopped_epoch,stopped_offset,"
    . "stopped_timezone,created_at_utc,updated_at_utc FROM captures WHERE id=:source"
);
$overlapStmt->bindValue(':public', $overlapId, SQLITE3_TEXT);
$overlapStmt->bindValue(':folder', $folderInternalId, SQLITE3_INTEGER);
$overlapStmt->bindValue(':source', $originalInternalId, SQLITE3_INTEGER);
$overlapStmt->execute();
$overlapInternalId = (int)$store->lastInsertRowID();
$copySegments = $store->prepare(
    'INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,started_offset,'
    . 'started_timezone,birds_generation,start_sequence,stopped_local,stopped_at_utc,stopped_epoch,'
    . 'stopped_offset,stopped_timezone,revision) '
    . 'SELECT :target,started_local,started_at_utc,started_epoch,started_offset,started_timezone,'
    . 'birds_generation,start_sequence,stopped_local,stopped_at_utc,stopped_epoch,stopped_offset,'
    . 'stopped_timezone,revision FROM capture_segments WHERE capture_id=:source'
);
$copySegments->bindValue(':target', $overlapInternalId, SQLITE3_INTEGER);
$copySegments->bindValue(':source', $originalInternalId, SQLITE3_INTEGER);
$copySegments->execute();
$overlapScope = educator_resolve_scope(['edu' => $folder['id']]);
$overlapBirds = new SQLite3($birdsPath, SQLITE3_OPEN_READONLY);
educator_scope_detection_table($overlapBirds, $overlapScope);
edu_check((int)$overlapBirds->querySingle('SELECT COUNT(*) FROM detections') === 2,
    'overlapping captures in one folder form a set union without double-counting');
educator_scope_release($overlapScope);
$overlapBirds->close();
$overlapProbeScope = educator_resolve_scope(['edu' => $folder['id']]);
$overlapProbeBirds = new SQLite3($birdsPath, SQLITE3_OPEN_READONLY);
$overlapProbe = educator_scope_probe($overlapProbeBirds, $overlapProbeScope);
edu_check($overlapProbe['open'] === false
    && preg_match('/\A[a-f0-9]{24}\z/D', $overlapProbe['fingerprint']) === 1
    && (int)$overlapProbeBirds->querySingle(
        'SELECT COUNT(*) FROM temp.educator_scope_probe_hits'
    ) === 2,
    'the stopped-folder probe normalizes overlapping periods into one exact two-row set');
educator_scope_release($overlapProbeScope);
$overlapProbeBirds->close();

$page = educator_store_capture_page($store, 100);
edu_check(isset($page['captures'][0]['segment_count'], $page['captures'][0]['duration_seconds'])
    && !isset($page['captures'][0]['segments'])
    && $page['captures'][0]['duration_seconds'] === 599,
    'bounded capture page returns exact paused duration without segment arrays');
edu_check(array_key_exists('detection_count', $page['captures'][0])
    && array_key_exists('species_count', $page['captures'][0])
    && $page['captures'][0]['detection_count'] === null
    && $page['captures'][0]['species_count'] === null,
    'saved capture pages leave expensive historical counts lazy');
$countStateRevision = educator_state_revision($store);
$savedCounts = educator_store_capture_counts(
    $store,
    [$capture['id'], $overlapId],
    $countStateRevision
);
edu_check(($savedCounts[$capture['id']]['detection_count'] ?? -1) === 2
    && ($savedCounts[$capture['id']]['species_count'] ?? -1) === 1
    && ($savedCounts[$capture['id']]['revision'] ?? 0) === $capture['revision']
    && ($savedCounts[$overlapId]['detection_count'] ?? -1) === 2
    && ($savedCounts[$overlapId]['species_count'] ?? -1) === 1,
    'the explicit saved-count batch returns exact independent capture counts');
edu_throws(fn() => educator_store_capture_counts(
    $store,
    [$capture['id'], $capture['id']],
    $countStateRevision
), 400, 'the saved-count batch rejects duplicate public ids');
edu_throws(fn() => educator_store_capture_counts(
    $store,
    ['c_' . str_repeat('0', 32)],
    $countStateRevision
), 404, 'the saved-count batch rejects a missing capture');
edu_throws(fn() => educator_store_capture_counts(
    $store,
    [$capture['id']],
    $countStateRevision - 1
), 409, 'the saved-count batch rejects a stale state revision');
$GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] = function (string $phase) use ($store): void {
    if ($phase === 'capture-counts-after-item') {
        $store->exec("UPDATE educator_meta SET value=value+1 WHERE key='state_revision'");
    }
};
edu_throws(fn() => educator_store_capture_counts(
    $store,
    [$capture['id']],
    $countStateRevision
), 409, 'a state change after count materialization invalidates the whole batch');
unset($GLOBALS['AVIAN_EDUCATOR_TEST_HOOK']);
$restoreCountState = $store->prepare("UPDATE educator_meta SET value=:revision WHERE key='state_revision'");
$restoreCountState->bindValue(':revision', $countStateRevision, SQLITE3_INTEGER);
$restoreCountState->execute();
$maximumCountIds = [];
for ($idIndex = 1; $idIndex <= AVIAN_EDUCATOR_COUNT_BATCH_MAX; $idIndex++) {
    $maximumCountIds[] = 'c_' . str_pad(dechex(1000 + $idIndex), 32, '0', STR_PAD_LEFT);
}
edu_check(educator_api_capture_count_ids(implode(',', $maximumCountIds)) === $maximumCountIds,
    'the count query accepts exactly eight unique capture ids');
edu_throws(fn() => educator_api_capture_count_ids(
    implode(',', [...$maximumCountIds, 'c_' . str_repeat('f', 32)])
), 400, 'the count query rejects a ninth capture id');
edu_throws(fn() => educator_api_capture_count_ids($capture['id'] . ',' . $capture['id']), 400,
    'the count query rejects duplicate capture ids');
edu_throws(fn() => educator_api_capture_count_ids([$capture['id']]), 400,
    'the count query rejects array-shaped ids');
edu_check(educator_api_query_revision('2147483647') === 2147483647,
    'the count query accepts the maximum state revision');
foreach (['', '00', '01', '-1', '2147483648'] as $badCountRevision) {
    edu_throws(fn() => educator_api_query_revision($badCountRevision), 400,
        'the count query rejects a noncanonical state revision');
}
$duplicateCountRow = educator_capture_row($store, $capture['id']);
edu_throws(fn() => educator_capture_page_counts($store, [$duplicateCountRow, $duplicateCountRow]), 503,
    'capture count input rejects duplicate entity ids');
edu_check(educator_capture_cursor_decode(educator_capture_cursor_encode(100, 2)) === ['epoch' => 100, 'id' => 2],
    'capture keyset cursor round-trips');
edu_throws(fn() => educator_capture_cursor_decode('%%%%'), 400, 'malformed cursor is rejected');

foreach ([
    "bad\nname",
    "safe\u{202E}unsafe",
    "line\u{2028}break",
    "\u{00A0}\u{00A0}",
    "\xff",
    str_repeat('x', AVIAN_EDUCATOR_NAME_MAX_BYTES + 1),
] as $badName) {
    edu_check(educator_valid_name($badName) === null, 'control, bidi, and oversized names are rejected');
}
edu_check(educator_valid_name(str_repeat("\u{1F426}", 64)) !== null
    && educator_valid_name(str_repeat("\u{1F426}", 65)) === null,
    'Unicode names honor the exact 256-byte boundary');
edu_throws(fn() => educator_store_update_capture($store, 'rename-capture', $capture['id'], 1, 0, 'stale'), 409,
    'stale optimistic revisions are rejected');
edu_throws(fn() => educator_resolve_scope(['edu' => 'c_' . str_repeat('0', 32)]), 404,
    'unknown explicit scope never falls back to global');

$firstSegmentId = (int)$store->querySingle(
    'SELECT id FROM capture_segments WHERE capture_id=' . $originalInternalId . ' ORDER BY id LIMIT 1'
);
$firstSequence = $store->querySingle('SELECT start_sequence FROM capture_segments WHERE id=' . $firstSegmentId);
$store->exec('PRAGMA ignore_check_constraints=ON');
$store->exec("UPDATE capture_segments SET start_sequence=CAST('not-a-floor' AS TEXT) WHERE id=" . $firstSegmentId);
$store->exec('PRAGMA ignore_check_constraints=OFF');
edu_throws(fn() => educator_resolve_scope(['edu' => $capture['id']]), 503,
    'text in a stored sequence floor fails scope construction closed');
edu_throws(fn() => educator_store_validate_integrity($store), 503,
    'restore validation rejects malformed stored segment fields');
$restoreFloor = $store->prepare('UPDATE capture_segments SET start_sequence=:floor WHERE id=:id');
$restoreFloor->bindValue(':floor', $firstSequence, SQLITE3_INTEGER);
$restoreFloor->bindValue(':id', $firstSegmentId, SQLITE3_INTEGER);
$restoreFloor->execute();
$store->exec("UPDATE captures SET started_offset='+01:00' WHERE id=" . $originalInternalId);
edu_throws(fn() => educator_resolve_scope(['edu' => $capture['id']]), 503,
    'inconsistent stored capture time metadata fails scope construction closed');
$store->exec("UPDATE captures SET started_offset='+00:00' WHERE id=" . $originalInternalId);
$originalFolderRevision = (int)$store->querySingle('SELECT revision FROM folders WHERE id=' . $folderInternalId);
$store->exec('PRAGMA ignore_check_constraints=ON');
$store->exec("UPDATE folders SET revision=CAST('bad' AS TEXT) WHERE id=" . $folderInternalId);
$store->exec('PRAGMA ignore_check_constraints=OFF');
edu_throws(fn() => educator_resolve_scope(['edu' => $folder['id']]), 503,
    'malformed stored folder fields fail scope construction closed');
$restoreFolderRevision = $store->prepare('UPDATE folders SET revision=:revision WHERE id=:id');
$restoreFolderRevision->bindValue(':revision', $originalFolderRevision, SQLITE3_INTEGER);
$restoreFolderRevision->bindValue(':id', $folderInternalId, SQLITE3_INTEGER);
$restoreFolderRevision->execute();

$oldProfile = file_get_contents($statePath);
file_put_contents($statePath, "corrupt\n");
edu_check(educator_resolve_scope([]) === null, 'corrupt optional profile state behaves disabled on ordinary pages');
edu_throws(fn() => educator_resolve_scope(['edu' => 'active']), 404,
    'corrupt profile never accepts an explicit or active scope');
file_put_contents($statePath, $oldProfile);

putenv('AVIAN_STATION_TIMEZONE=America/Los_Angeles');
putenv('AV_EDUCATOR_NOW=2026-11-01T01:30:00-07:00');
edu_throws(fn() => educator_store_start($store, educator_state_revision($store)), 409,
    'start rejects a repeated daylight-saving wall hour');
putenv('AV_EDUCATOR_NOW=2026-11-01T00:30:00-07:00');
$foldCapture = educator_store_start($store, educator_state_revision($store))['capture'];
putenv('AV_EDUCATOR_NOW=2026-11-01T01:30:00-07:00');
edu_throws(fn() => educator_store_stop_current($store), 409,
    'stop-current refuses a repeated daylight-saving wall hour without shortening the period');
$foldAfterFailure = educator_capture_row($store, $foldCapture['id']);
$foldOpenSegment = educator_store_one($store,
    'SELECT * FROM capture_segments WHERE capture_id=:id ORDER BY id DESC LIMIT 1',
    [':id' => (int)$foldAfterFailure['id']]
);
edu_check($foldAfterFailure['status'] === 'running' && $foldAfterFailure['stopped_epoch'] === null
    && $foldOpenSegment['stopped_epoch'] === null
    && $foldOpenSegment['started_local'] === '2026-11-01 00:30:00',
    'failed repeated-hour stop preserves the enabled current capture and its full open boundary');
putenv('AV_EDUCATOR_NOW=2026-11-01T02:30:00-08:00');
edu_check(educator_store_stop_current($store), 'stop-current succeeds after the repeated hour ends');
putenv('AVIAN_STATION_TIMEZONE=US/Pacific');
putenv('AV_EDUCATOR_NOW=2026-02-01T09:00:00-08:00');
edu_check(educator_capture_now()['timezone'] === 'US/Pacific', 'legacy IANA timezone aliases remain valid');

putenv('AVIAN_STATION_TIMEZONE=UTC');
putenv('AV_EDUCATOR_NOW=2026-01-03T12:00:00+00:00');
$second = educator_store_start($store, educator_state_revision($store))['capture'];
$timezoneDetection = edu_insert_detection(
    $birds,
    '2026-01-03',
    '12:01:00',
    'Timezone_Bird-90-2026-01-03-birdnet-12:01:00.mp3'
);
putenv('AV_EDUCATOR_NOW=2026-01-03T11:59:59+00:00');
edu_throws(fn() => educator_store_transition(
    $store, 'pause', $second['id'], $second['revision'], educator_state_revision($store)
), 409, 'wall-clock regression is rejected');
putenv('AVIAN_STATION_TIMEZONE=America/New_York');
putenv('AV_EDUCATOR_NOW=2026-01-03T07:05:00-05:00');
edu_throws(fn() => educator_store_transition(
    $store, 'pause', $second['id'], $second['revision'], educator_state_revision($store)
), 409, 'timezone change is rejected for HTTP capture transitions');
edu_check(educator_store_stop_current($store), 'recovery stop safely closes a capture after timezone change');
$timezoneClosed = educator_capture_row($store, $second['id']);
$timezoneScope = educator_resolve_scope(['edu' => $second['id']]);
$timezoneBirds = new SQLite3($birdsPath, SQLITE3_OPEN_READONLY);
educator_scope_detection_table($timezoneBirds, $timezoneScope);
edu_check((int)$timezoneBirds->querySingle('SELECT COUNT(*) FROM detections') === 1
    && educator_scope_detection_row($timezoneBirds, $timezoneDetection) !== null
    && ($timezoneClosed['duration_seconds'] ?? 0) === 300,
    'timezone recovery preserves the valid old-zone period instead of collapsing it');
educator_scope_release($timezoneScope);
$timezoneBirds->close();

putenv('AVIAN_STATION_TIMEZONE=UTC');
putenv('AV_EDUCATOR_NOW=2026-01-04T12:00:00+00:00');
$revisionBeforeRace = educator_state_revision($store);
$rotatedGeneration = str_repeat('b', 32);
$GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] = function (string $phase) use ($birds, $rotatedGeneration): void {
    if ($phase === 'before-generation-recheck') edu_set_marker($birds, $rotatedGeneration);
};
edu_throws(fn() => educator_store_start($store, $revisionBeforeRace), 409,
    'generation rotation before commit rolls Start back');
unset($GLOBALS['AVIAN_EDUCATOR_TEST_HOOK']);
edu_check(educator_state_revision($store) === $revisionBeforeRace
    && educator_current_capture_row($store) === null,
    'failed generation race leaves no active capture or revision bump');
edu_set_marker($birds, $generation);

$mediaRoot = $tmp . '/custom recordings';
$mediaDay = $mediaRoot . '/By_Date/2026-01-02';
$mediaSpecies = $mediaDay . '/Test_Bird';
mkdir($mediaSpecies, 0700, true);
$mediaFile = $mediaSpecies . '/Test_Bird-91-2026-01-02-birdnet-10:00:01.mp3';
file_put_contents($mediaFile, 'ID3' . str_repeat("\0", 61));
$savedPngBytes = "\x89PNG\r\n\x1a\n" . str_repeat("\0", 56);
file_put_contents($mediaFile . '.png', $savedPngBytes);
putenv('AVIAN_EXTRACTED_ROOT=' . realpath($mediaRoot));
edu_check(educator_configured_extracted_root([]) === realpath($mediaRoot),
    'custom configured recordings root resolves canonically');
$mediaRow = [
    'Date' => '2026-01-02', 'Com_Name' => 'Test Bird',
    'File_Name' => basename($mediaFile),
];
$mediaCache = null;
$openedMedia = educator_scope_open_media($mediaRow, 'recording', $mediaRoot . '/By_Date', $mediaCache);
edu_check(is_array($openedMedia) && $openedMedia['size'] === 64,
    'scoped MP3 passes signature, containment, and frozen-size validation');
if (is_array($openedMedia)) fclose($openedMedia['handle']);
$originalMediaBytes = file_get_contents($mediaFile);
$GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] = function (string $phase) use ($mediaFile): void {
    if ($phase === 'media-after-open') file_put_contents($mediaFile, 'ID3' . str_repeat("\0", 8));
};
$mediaCache = null;
edu_check(educator_scope_open_media($mediaRow, 'recording', $mediaRoot . '/By_Date', $mediaCache) === null,
    'scoped media rejects a post-open truncate');
unset($GLOBALS['AVIAN_EDUCATOR_TEST_HOOK']);
file_put_contents($mediaFile, $originalMediaBytes);
$GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] = function (string $phase) use ($mediaFile): void {
    if ($phase === 'media-after-copy') file_put_contents($mediaFile, "x", FILE_APPEND);
};
$mediaCache = null;
edu_check(educator_scope_open_media($mediaRow, 'recording', $mediaRoot . '/By_Date', $mediaCache) === null,
    'scoped media rejects a post-open grow before emitting bytes');
unset($GLOBALS['AVIAN_EDUCATOR_TEST_HOOK']);
file_put_contents($mediaFile, $originalMediaBytes);
$hardLink = $mediaSpecies . '/linked.mp3';
link($mediaFile, $hardLink);
$mediaCache = null;
edu_check(educator_scope_open_media($mediaRow, 'recording', $mediaRoot . '/By_Date', $mediaCache) === null,
    'scoped media rejects files with more than one hard link');
unlink($hardLink);
file_put_contents($mediaFile, str_repeat('z', 64));
$mediaCache = null;
edu_check(educator_scope_open_media($mediaRow, 'recording', $mediaRoot . '/By_Date', $mediaCache) === null,
    'scoped media rejects a non-MP3 payload despite its extension');
file_put_contents($mediaFile, $originalMediaBytes);
mkdir($mediaDay . '/Test-Bird', 0700);
$mediaCache = null;
edu_check(educator_scope_open_media($mediaRow, 'recording', $mediaRoot . '/By_Date', $mediaCache) === null,
    'ambiguous normalized species directories fail closed');
rmdir($mediaDay . '/Test-Bird');

$apiRoot = dirname(__DIR__) . '/avian/api';
$directServer = [
    'REQUEST_METHOD' => 'GET',
    'REMOTE_ADDR' => '192.168.1.40',
    'HTTP_HOST' => 'birdnet.local',
];
$publicServer = [
    'REQUEST_METHOD' => 'GET',
    'REMOTE_ADDR' => '203.0.113.40',
    'HTTP_HOST' => 'birds.example.com',
];
putenv('AV_REQUIRE_AUTH=0');
$menuResponse = edu_endpoint($apiRoot . '/menu.php', [], $directServer);
$menuJson = json_decode($menuResponse['out'], true);
edu_check($menuResponse['status'] === 200
    && count($menuJson['items'] ?? []) === 5
    && ($menuJson['items'][4]['label'] ?? '') === 'educators'
    && ($menuJson['items'][4]['full'] ?? false) === true
    && ($menuJson['auth']['direct_local'] ?? null) === true
    && !array_key_exists('educators', $menuJson),
    'enabled direct menu adds one full-width fifth row and authoritative locality metadata');
$birdActions = [];
foreach ([
    'stats' => [],
    'recent' => ['hours' => '1000000'],
    'rhythm' => ['hours' => '24', 'days' => '7'],
    'hourly' => [],
    'species' => ['sci' => 'Avis testus', 'limit' => '1', 'offset' => '1'],
    'firstseen' => ['limit' => '10'],
    'calendar' => [],
] as $action => $parameters) {
    $response = edu_endpoint(
        $apiRoot . '/birdnet-api.php',
        ['action' => $action, 'edu' => $folder['id']] + $parameters,
        $directServer
    );
    $birdActions[$action] = json_decode($response['out'], true);
    edu_check($response['status'] === 200 && is_array($birdActions[$action]),
        "scoped $action action returns one valid response");
}
edu_check(($birdActions['stats']['totals']['detections'] ?? -1) === 2,
    'scoped stats excludes the paused gap and overlapping segments');
edu_check(($birdActions['recent']['species'][0]['n'] ?? -1) === 2,
    'scoped collage recent data uses the complete folder union');
edu_check(array_sum(array_column($birdActions['rhythm']['today'] ?? [], 'detections')) === 2,
    'scoped rhythm uses only listening-period detections');
edu_check(($birdActions['hourly']['species'][0]['total'] ?? -1) === 2,
    'scoped hourly ledger uses only listening-period detections');
edu_check(($birdActions['species']['summary']['total'] ?? -1) === 2
    && count($birdActions['species']['detections'] ?? []) === 1,
    'scoped species detail and pagination use the same folder union');
edu_check(($birdActions['firstseen']['species'][0]['total'] ?? -1) === 2,
    'scoped first-detection list uses the same folder union');
edu_check(($birdActions['calendar']['days'][0]['detections'] ?? -1) === 2,
    'scoped calendar uses the same folder union');
$life = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'lifelist', 'edu' => $folder['id']],
    $directServer
);
$lifeJson = json_decode($life['out'], true);
edu_check($life['status'] === 200 && $life['err'] === '' && is_array($lifeJson)
    && json_last_error() === JSON_ERROR_NONE && count($lifeJson['species'] ?? []) === 1,
    'scoped lifelist emits exactly one valid JSON document');
$oldSeries = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'timeseries', 'days' => '30', 'edu' => $folder['id']],
    $directServer
);
$oldSeriesJson = json_decode($oldSeries['out'], true);
edu_check(($oldSeriesJson['daily'][0]['date'] ?? '') === '2026-01-02',
    'scoped trend anchors to an old saved period instead of station today');
$snapshotFile = 'Snapshot_Bird-90-2026-01-02-birdnet-10:12:00.mp3';
$snapshotInsertSql = "INSERT INTO detections(Date,Time,Sci_Name,Com_Name,Confidence,File_Name) "
    . "VALUES('2026-01-02','10:12:00','Avis testus','Test Bird',0.90,'" . $snapshotFile . "')";
$snapshotPrelude = '$GLOBALS["AVIAN_EDUCATOR_TEST_HOOK"]=function($phase){static $done=false;'
    . 'if($done||$phase!=="birdnet-stats-after-total")return;$done=true;$w=new SQLite3('
    . var_export($birdsPath, true) . ');$w->busyTimeout(2000);$w->exec('
    . var_export($snapshotInsertSql, true) . ');$w->close();};';
$snapshotResponse = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer,
    '',
    [],
    null,
    $snapshotPrelude
);
$snapshotJson = json_decode($snapshotResponse['out'], true);
$afterSnapshotResponse = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer
);
$afterSnapshotJson = json_decode($afterSnapshotResponse['out'], true);
edu_check($snapshotResponse['status'] === 200
    && ($snapshotJson['totals']['detections'] ?? -1) === 2
    && ($snapshotJson['today']['detections'] ?? -1) === 2
    && ($afterSnapshotJson['totals']['detections'] ?? -1) === 3,
    'one birdnet response remains on a single Birds read snapshot while a detection commits');
$publicFolder = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $publicServer
);
$publicFolderJson = json_decode($publicFolder['out'], true);
$publicFolderScope = $publicFolderJson['educator_scope'] ?? [];
edu_check($publicFolder['status'] === 200
    && ($publicFolderJson['totals']['detections'] ?? -1) === 3
    && ($publicFolderScope['kind'] ?? '') === 'folder'
    && !isset(
        $publicFolderScope['id'],
        $publicFolderScope['label'],
        $publicFolderScope['generation']
    )
    && !str_contains($publicFolder['out'], $folder['id'])
    && !str_contains($publicFolder['out'], 'Period One'),
    'an unlisted public folder capability returns only generic scoped data');
$publicFolderProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $publicServer
);
$directFolderProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $directServer
);
$publicFolderProbeJson = json_decode($publicFolderProbe['out'], true);
$initialProbeFingerprint = $publicFolderProbeJson['fingerprint'] ?? '';
edu_check($publicFolderProbe['status'] === 200
    && $directFolderProbe['status'] === 200
    && $directFolderProbe['out'] === $publicFolderProbe['out']
    && array_keys($publicFolderProbeJson ?? []) === ['open', 'fingerprint', 'educator_scope']
    && ($publicFolderProbeJson['open'] ?? true) === false
    && preg_match('/\A[a-f0-9]{24}\z/D', (string)$initialProbeFingerprint) === 1
    && array_keys($publicFolderProbeJson['educator_scope'] ?? []) === [
        'kind', 'revision', 'status', 'automatic', 'state_revision', 'state_key',
    ]
    && ($publicFolderProbeJson['educator_scope']['kind'] ?? '') === 'folder'
    && !isset(
        $publicFolderProbeJson['educator_scope']['id'],
        $publicFolderProbeJson['educator_scope']['label'],
        $publicFolderProbeJson['educator_scope']['generation']
    )
    && !array_key_exists('profile_epoch', $publicFolderProbeJson)
    && !str_contains($publicFolderProbe['out'], $folder['id'])
    && !str_contains($publicFolderProbe['out'], 'Period One'),
    'saved-scope probe returns the same opaque generic metadata on direct and public hosts');
$probeLateDetection = edu_insert_detection(
    $birds,
    '2026-01-02',
    '10:13:30',
    'Probe_Late-90-2026-01-02-birdnet-10:13:30.mp3'
);
$probeAfterInsert = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $publicServer
);
$probeAfterInsertJson = json_decode($probeAfterInsert['out'], true);
$birds->exec('DELETE FROM detections WHERE rowid=' . $probeLateDetection);
$probeAfterDelete = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $publicServer
);
$probeAfterDeleteJson = json_decode($probeAfterDelete['out'], true);
edu_check($probeAfterInsert['status'] === 200
    && ($probeAfterInsertJson['fingerprint'] ?? '') !== $initialProbeFingerprint
    && $probeAfterDelete['status'] === 200
    && ($probeAfterDeleteJson['fingerprint'] ?? '') === $initialProbeFingerprint,
    'saved-scope fingerprint changes for a late insert and returns after its deletion');
$publicCapture = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $capture['id']],
    $publicServer
);
$publicCaptureJson = json_decode($publicCapture['out'], true);
edu_check($publicCapture['status'] === 200
    && ($publicCaptureJson['totals']['detections'] ?? -1) === 3
    && ($publicCaptureJson['educator_scope']['kind'] ?? '') === 'capture'
    && !isset(
        $publicCaptureJson['educator_scope']['id'],
        $publicCaptureJson['educator_scope']['label'],
        $publicCaptureJson['educator_scope']['generation']
    )
    && !str_contains($publicCapture['out'], $capture['id']),
    'an unlisted public capture capability returns its exact saved period without its id');
$publicCaptureProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $capture['id']],
    $publicServer
);
$publicCaptureProbeJson = json_decode($publicCaptureProbe['out'], true);
edu_check($publicCaptureProbe['status'] === 200
    && ($publicCaptureProbeJson['open'] ?? true) === false
    && ($publicCaptureProbeJson['educator_scope']['kind'] ?? '') === 'capture'
    && preg_match('/\A[a-f0-9]{24}\z/D', (string)($publicCaptureProbeJson['fingerprint'] ?? '')) === 1
    && !str_contains($publicCaptureProbe['out'], $capture['id'])
    && !str_contains($publicCaptureProbe['out'], $capture['name']),
    'saved capture probe exposes only generic metadata and an opaque fingerprint');
$directFolderJson = $birdActions['stats'];
edu_check(($directFolderJson['educator_scope']['kind'] ?? '') === 'folder'
    && !isset(
        $directFolderJson['educator_scope']['id'],
        $directFolderJson['educator_scope']['label'],
        $directFolderJson['educator_scope']['generation']
    ),
    'saved capability responses stay generic on the direct LAN too');

$forwardingHeaders = [
    'HTTP_FORWARDED' => 'for=198.51.100.2',
    'HTTP_X_FORWARDED_FOR' => '198.51.100.2',
    'HTTP_X_FORWARDED_HOST' => 'birds.example.com',
    'HTTP_X_FORWARDED_PROTO' => 'https',
    'HTTP_X_FORWARDED_PORT' => '443',
    'HTTP_X_FORWARDED_SERVER' => 'proxy.example.com',
    'HTTP_X_FORWARDED_SCHEME' => 'https',
    'HTTP_X_FORWARDED_PREFIX' => '/station',
    'HTTP_X_REAL_IP' => '198.51.100.2',
    'HTTP_CF_CONNECTING_IP' => '198.51.100.2',
    'HTTP_CF_CONNECTING_IPV6' => '2001:db8::2',
    'HTTP_CF_PSEUDO_IPV4' => '192.0.2.2',
    'HTTP_CF_RAY' => 'test-LAX',
    'HTTP_CF_VISITOR' => '{"scheme":"https"}',
];
$allForwardedGeneric = true;
foreach ($forwardingHeaders as $header => $value) {
    $forwardedCapability = edu_endpoint(
        $apiRoot . '/birdnet-api.php',
        ['action' => 'stats', 'edu' => $folder['id']],
        array_merge($directServer, [$header => $value])
    );
    $forwardedCapabilityJson = json_decode($forwardedCapability['out'], true);
    $allForwardedGeneric = $allForwardedGeneric
        && $forwardedCapability['status'] === 200
        && ($forwardedCapabilityJson['totals']['detections'] ?? -1) === 3
        && !isset(
            $forwardedCapabilityJson['educator_scope']['id'],
            $forwardedCapabilityJson['educator_scope']['label'],
            $forwardedCapabilityJson['educator_scope']['generation']
        )
        && !str_contains($forwardedCapability['out'], $folder['id'])
        && !str_contains($forwardedCapability['out'], 'Period One');
}
edu_check($allForwardedGeneric,
    'every reviewed forwarding-header family keeps saved capability metadata generic');

$publicSavedRecording = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $capture['id'], 'detection' => (string)$hookInserted, 'file' => basename($mediaFile)],
    $publicServer
);
$publicSavedSpectrogram = edu_endpoint(
    $apiRoot . '/spectrogram.php',
    ['edu' => $folder['id'], 'detection' => (string)$hookInserted, 'file' => basename($mediaFile)],
    $publicServer
);
$publicWrongRow = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $folder['id'], 'detection' => (string)$gapDetection, 'file' => basename($mediaFile)],
    $publicServer
);
edu_check($publicSavedRecording['status'] === 200
    && hash_equals($originalMediaBytes, $publicSavedRecording['out'])
    && $publicSavedSpectrogram['status'] === 200
    && hash_equals($savedPngBytes, $publicSavedSpectrogram['out'])
    && $publicWrongRow['status'] === 404
    && !str_contains($publicWrongRow['out'], $originalMediaBytes),
    'public saved media is bound to one exact detection row inside the capability scope');
putenv('AV_REQUIRE_AUTH=1');
$protectedLanCapability = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer
);
$protectedLanMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $capture['id'], 'detection' => (string)$hookInserted, 'file' => basename($mediaFile)],
    $directServer
);
$protectedCountState = educator_state_revision($store);
$protectedSavedCounts = edu_endpoint(
    $apiRoot . '/educators.php',
    [
        'action' => 'capture-counts',
        'ids' => $capture['id'],
        'state_revision' => (string)$protectedCountState,
    ],
    $directServer
);
$protectedLanJson = json_decode($protectedLanCapability['out'], true);
edu_check($protectedLanCapability['status'] === 200
    && ($protectedLanJson['totals']['detections'] ?? -1) === 3
    && !isset(
        $protectedLanJson['educator_scope']['id'],
        $protectedLanJson['educator_scope']['label'],
        $protectedLanJson['educator_scope']['generation']
    )
    && $protectedLanMedia['status'] === 200
    && hash_equals($originalMediaBytes, $protectedLanMedia['out'])
    && $protectedSavedCounts['status'] === 401
    && !str_contains($protectedSavedCounts['out'], $capture['id']),
    'saved links stay read-only while saved counts still require the protected admin session');
putenv('AV_REQUIRE_AUTH=0');
$forwardedExport = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id']],
    $publicServer
);
edu_check($forwardedExport['status'] === 404
    && !str_contains($forwardedExport['out'], $folder['id']),
    'a public saved-view capability does not grant exports');
$endpointCountState = educator_state_revision($store);
$countQuery = [
    'action' => 'capture-counts',
    'ids' => $capture['id'] . ',' . $overlapId,
    'state_revision' => (string)$endpointCountState,
];
$countResponse = edu_endpoint($apiRoot . '/educators.php', $countQuery, $directServer);
$countJson = json_decode($countResponse['out'], true);
$ordinaryStateResponse = edu_endpoint($apiRoot . '/educators.php', [], $directServer);
$ordinaryStateJson = json_decode($ordinaryStateResponse['out'], true);
$ordinarySavedCountsStayLazy = $ordinaryStateResponse['status'] === 200;
foreach ($ordinaryStateJson['captures'] ?? [] as $ordinaryCapture) {
    $ordinarySavedCountsStayLazy = $ordinarySavedCountsStayLazy
        && array_key_exists('detection_count', $ordinaryCapture)
        && array_key_exists('species_count', $ordinaryCapture)
        && $ordinaryCapture['detection_count'] === null
        && $ordinaryCapture['species_count'] === null;
}
edu_check($countResponse['status'] === 200
    && array_keys($countJson ?? []) === ['ok', 'enabled', 'profile_epoch', 'state_revision', 'counts']
    && ($countJson['state_revision'] ?? -1) === $endpointCountState
    && ($countJson['counts'][$capture['id']]['revision'] ?? 0) === $capture['revision']
    && ($countJson['counts'][$capture['id']]['detection_count'] ?? -1) === 3
    && ($countJson['counts'][$capture['id']]['species_count'] ?? -1) === 1
    && ($countJson['counts'][$overlapId]['detection_count'] ?? -1) === 3,
    'the authenticated count endpoint returns exact counts for a bounded stopped-capture batch');
edu_check($ordinarySavedCountsStayLazy,
    'ordinary Educators state polling keeps every saved capture count lazy');
$publicSavedCounts = edu_endpoint($apiRoot . '/educators.php', $countQuery, $publicServer);
edu_check($publicSavedCounts['status'] !== 200
    && !str_contains($publicSavedCounts['out'], $capture['id'])
    && !str_contains($publicSavedCounts['out'], 'detection_count'),
    'saved-view capability access never widens into the administrative count endpoint');

$lateInsertFile = 'Late_Count-90-2026-01-02-birdnet-10:13:00.mp3';
$lateInsertSql = "INSERT INTO detections(Date,Time,Sci_Name,Com_Name,Confidence,File_Name) "
    . "VALUES('2026-01-02','10:13:00','Avis later','Late Bird',0.90,'" . $lateInsertFile . "')";
$lateInsertPrelude = '$GLOBALS["AVIAN_EDUCATOR_TEST_HOOK"]=function($phase){static $done=false;'
    . 'if($done||$phase!=="capture-counts-after-materialize")return;$done=true;$w=new SQLite3('
    . var_export($birdsPath, true) . ');$w->busyTimeout(2000);$w->exec('
    . var_export($lateInsertSql, true) . ');$w->close();};';
$lateInsertResponse = edu_endpoint(
    $apiRoot . '/educators.php',
    $countQuery,
    $directServer,
    '',
    [],
    null,
    $lateInsertPrelude
);
$lateInsertJson = json_decode($lateInsertResponse['out'], true);
$afterLateInsert = edu_endpoint($apiRoot . '/educators.php', $countQuery, $directServer);
$afterLateInsertJson = json_decode($afterLateInsert['out'], true);
edu_check($lateInsertResponse['status'] === 200
    && ($lateInsertJson['counts'][$capture['id']]['detection_count'] ?? -1) === 3
    && ($afterLateInsertJson['counts'][$capture['id']]['detection_count'] ?? -1) === 4
    && ($afterLateInsertJson['counts'][$capture['id']]['species_count'] ?? -1) === 2,
    'a count response stays on one Birds snapshot while a late detection insert appears next time');
$lateInsertId = (int)$birds->querySingle(
    "SELECT rowid FROM detections WHERE File_Name='" . SQLite3::escapeString($lateInsertFile) . "'"
);
$birds->exec('DELETE FROM detections WHERE rowid=' . $lateInsertId);

$lateDeleteSql = "DELETE FROM detections WHERE File_Name='" . SQLite3::escapeString($snapshotFile) . "'";
$lateDeletePrelude = '$GLOBALS["AVIAN_EDUCATOR_TEST_HOOK"]=function($phase){static $done=false;'
    . 'if($done||$phase!=="capture-counts-after-materialize")return;$done=true;$w=new SQLite3('
    . var_export($birdsPath, true) . ');$w->busyTimeout(2000);$w->exec('
    . var_export($lateDeleteSql, true) . ');$w->close();};';
$lateDeleteResponse = edu_endpoint(
    $apiRoot . '/educators.php',
    $countQuery,
    $directServer,
    '',
    [],
    null,
    $lateDeletePrelude
);
$lateDeleteJson = json_decode($lateDeleteResponse['out'], true);
$afterLateDelete = edu_endpoint($apiRoot . '/educators.php', $countQuery, $directServer);
$afterLateDeleteJson = json_decode($afterLateDelete['out'], true);
edu_check($lateDeleteResponse['status'] === 200
    && ($lateDeleteJson['counts'][$capture['id']]['detection_count'] ?? -1) === 3
    && ($afterLateDeleteJson['counts'][$capture['id']]['detection_count'] ?? -1) === 2,
    'a count response stays on one Birds snapshot while a late deletion appears next time');
edu_insert_detection($birds, '2026-01-02', '10:12:00', $snapshotFile);

$invalidCountCases = [
    [['action' => 'capture-counts', 'ids' => [$capture['id']], 'state_revision' => (string)$endpointCountState], $directServer],
    [['action' => 'capture-counts', 'ids' => str_repeat('c', 300), 'state_revision' => (string)$endpointCountState], $directServer],
    [['action' => 'capture-counts', 'ids' => $capture['id'], 'state_revision' => '01'], $directServer],
    [$countQuery + ['extra' => '1'], $directServer],
    [$countQuery, array_merge($directServer, [
        'QUERY_STRING' => 'action=capture-counts&ids=' . rawurlencode($capture['id'])
            . '&ids=' . rawurlencode($capture['id']) . '&state_revision=' . $endpointCountState,
    ])],
    [$countQuery, array_merge($directServer, [
        'QUERY_STRING' => 'action=capture-counts&ids%5B%5D=' . rawurlencode($capture['id'])
            . '&ids=' . rawurlencode($capture['id']) . '&state_revision=' . $endpointCountState,
    ])],
];
$invalidCountInputsRejected = true;
foreach ($invalidCountCases as [$invalidCountQuery, $invalidCountServer]) {
    $invalidCountResponse = edu_endpoint(
        $apiRoot . '/educators.php',
        $invalidCountQuery,
        $invalidCountServer
    );
    $invalidCountInputsRejected = $invalidCountInputsRejected
        && $invalidCountResponse['status'] === 400
        && !str_contains($invalidCountResponse['out'], $folder['id']);
}
edu_check($invalidCountInputsRejected,
    'the count endpoint rejects arrays, oversize values, aliases, duplicates, and unexpected fields');
$nineCountIds = [...$maximumCountIds, 'c_' . str_repeat('f', 32)];
$tooManyCountResponse = edu_endpoint(
    $apiRoot . '/educators.php',
    [
        'action' => 'capture-counts',
        'ids' => implode(',', $nineCountIds),
        'state_revision' => (string)$endpointCountState,
    ],
    $directServer
);
$staleCountResponse = edu_endpoint(
    $apiRoot . '/educators.php',
    [
        'action' => 'capture-counts',
        'ids' => $capture['id'],
        'state_revision' => (string)max(0, $endpointCountState - 1),
    ],
    $directServer
);
$missingCountResponse = edu_endpoint(
    $apiRoot . '/educators.php',
    [
        'action' => 'capture-counts',
        'ids' => 'c_' . str_repeat('0', 32),
        'state_revision' => (string)$endpointCountState,
    ],
    $directServer
);
edu_check($tooManyCountResponse['status'] === 400
    && $staleCountResponse['status'] === 409
    && $missingCountResponse['status'] === 404,
    'the count endpoint enforces its batch, revision, and entity bounds');

$differentCountGeneration = str_repeat('b', 32);
edu_set_marker($birds, $differentCountGeneration);
$staleGenerationCounts = edu_endpoint($apiRoot . '/educators.php', $countQuery, $directServer);
edu_set_marker($birds, $generation);
putenv('AV_EDUCATOR_BIRDS_DB=' . $tmp . '/missing-birds.db');
$missingBirdsCounts = edu_endpoint($apiRoot . '/educators.php', $countQuery, $directServer);
putenv('AV_EDUCATOR_BIRDS_DB=' . $birdsPath);
file_put_contents($maintenanceMarkerPath, "v1\ttest\n");
$maintenanceCounts = edu_endpoint($apiRoot . '/educators.php', $countQuery, $directServer);
unlink($maintenanceMarkerPath);
edu_check($staleGenerationCounts['status'] === 409
    && $missingBirdsCounts['status'] === 503
    && $maintenanceCounts['status'] === 503,
    'the count endpoint fails closed across generation, database, and maintenance changes');
$publicEducatorsState = edu_endpoint(
    $apiRoot . '/educators.php',
    ['edu' => $folder['id']],
    $publicServer
);
$publicEducatorsMutation = edu_endpoint(
    $apiRoot . '/educators.php',
    [],
    array_merge($publicServer, [
        'REQUEST_METHOD' => 'POST',
        'CONTENT_TYPE' => 'application/json',
        'HTTP_X_AVIAN_ACTION' => '1',
        'CONTENT_LENGTH' => '46',
    ]),
    json_encode(['action' => 'delete-folder', 'id' => $folder['id']])
);
$publicLiveAudio = edu_endpoint(
    $apiRoot . '/educator-audio.php',
    ['grant' => str_repeat('a', 48), 'edu' => $folder['id']],
    $publicServer
);
$publicGrantBody = json_encode(['scope' => 'detections', 'edu' => $folder['id']]);
$publicDownloadGrant = edu_endpoint(
    $apiRoot . '/menu.php',
    ['action' => 'download-grant'],
    array_merge($publicServer, [
        'REQUEST_METHOD' => 'POST',
        'CONTENT_TYPE' => 'application/json',
        'HTTP_X_AVIAN_ACTION' => '1',
        'CONTENT_LENGTH' => (string)strlen($publicGrantBody),
    ]),
    $publicGrantBody
);
edu_check($publicEducatorsState['status'] !== 200
    && $publicEducatorsMutation['status'] !== 200
    && $publicDownloadGrant['status'] !== 200
    && $publicLiveAudio['status'] === 404
    && !str_contains($publicEducatorsState['out'], $folder['id'])
    && !str_contains($publicEducatorsMutation['out'], $folder['id'])
    && !str_contains($publicDownloadGrant['out'], $folder['id'])
    && !str_contains($publicDownloadGrant['out'], 'token'),
    'saved-view capabilities do not widen state, mutation, export-grant, or live-audio access');

$publicMalformed = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => 'not-a-capability'],
    $publicServer
);
$publicMissing = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => 'c_' . str_repeat('0', 32)],
    $publicServer
);
$directMissing = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => 'c_' . str_repeat('0', 32)],
    $directServer
);
$publicMalformedArray = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => ['bad']],
    $publicServer
);
$publicDuplicateLastValid = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    array_merge($publicServer, [
        'QUERY_STRING' => 'action=stats&edu=not-a-capability&edu=' . rawurlencode($folder['id']),
    ])
);
$publicDuplicateLastInvalid = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => 'not-a-capability'],
    array_merge($publicServer, [
        'QUERY_STRING' => 'action=stats&edu=' . rawurlencode($folder['id']) . '&edu=not-a-capability',
    ])
);
$publicDuplicateMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $capture['id'], 'detection' => (string)$hookInserted, 'file' => basename($mediaFile)],
    array_merge($publicServer, [
        'QUERY_STRING' => 'edu=bad&edu=' . rawurlencode($capture['id'])
            . '&detection=' . $hookInserted . '&file=' . rawurlencode(basename($mediaFile)),
    ])
);
$publicBracketAliasLastValid = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    array_merge($publicServer, [
        'QUERY_STRING' => 'action=stats&edu%5B%5D=bad&e%64u=' . rawurlencode($folder['id']),
    ])
);
$publicNamedBracketAliasLastValid = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    array_merge($publicServer, [
        'QUERY_STRING' => 'action=stats&edu%5Bx%5D=bad&%65%64%75=' . rawurlencode($folder['id']),
    ])
);
$publicNullAliasLastValid = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    array_merge($publicServer, [
        'QUERY_STRING' => 'action=stats&edu%00x=bad&edu=' . rawurlencode($folder['id']),
    ])
);
$publicMissingProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => 'c_' . str_repeat('0', 32)],
    $publicServer
);
$directMissingProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => 'c_' . str_repeat('0', 32)],
    $directServer
);
$publicProbeExtra = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id'], 'extra' => '1'],
    $publicServer
);
$publicProbeDuplicateAction = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    array_merge($publicServer, [
        'QUERY_STRING' => 'action=stats&action=scope-probe&edu=' . rawurlencode($folder['id']),
    ])
);
edu_check($publicMalformed['status'] === 404
    && $publicMissing['status'] === 404
    && $directMissing['status'] === 404
    && $publicMalformedArray['status'] === 404
    && $publicDuplicateLastValid['status'] === 404
    && $publicDuplicateLastInvalid['status'] === 404
    && $publicDuplicateMedia['status'] === 404
    && $publicBracketAliasLastValid['status'] === 404
    && $publicNamedBracketAliasLastValid['status'] === 404
    && $publicNullAliasLastValid['status'] === 404
    && $publicMalformed['out'] === $publicMissing['out']
    && $directMissing['out'] === $publicMissing['out']
    && $publicMalformedArray['out'] === $publicMissing['out']
    && $publicDuplicateLastValid['out'] === $publicMissing['out']
    && $publicDuplicateLastInvalid['out'] === $publicMissing['out']
    && $publicDuplicateMedia['out'] === 'not found'
    && $publicBracketAliasLastValid['out'] === $publicMissing['out']
    && $publicNamedBracketAliasLastValid['out'] === $publicMissing['out']
    && $publicNullAliasLastValid['out'] === $publicMissing['out']
    && $publicMalformed['out'] === '{"error":"not found","educator_scope":null}',
    'malformed, duplicate, and unknown public capabilities return one uniform 404 without global fallback');
edu_check($publicMissingProbe['status'] === 404
    && $directMissingProbe['status'] === 404
    && $publicProbeExtra['status'] === 404
    && $publicProbeDuplicateAction['status'] === 404
    && $publicMissingProbe['out'] === $publicMissing['out']
    && $directMissingProbe['out'] === $publicMissing['out']
    && $publicProbeExtra['out'] === $publicMissing['out']
    && $publicProbeDuplicateAction['out'] === $publicMissing['out'],
    'saved probes reject unknown scopes, extra fields, and duplicate actions uniformly on every host');

$csv = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id']],
    $directServer
);
edu_check($csv['status'] === 200
    && str_contains($csv['out'], 'Test_Bird-91')
    && str_contains($csv['out'], 'Second_Bird-90')
    && !str_contains($csv['out'], 'Gap_Bird-90'),
    'scoped CSV contains only exact folder detections');
$tar = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'recordings', 'edu' => $folder['id']],
    $directServer
);
edu_check($tar['status'] === 200 && $tar['err'] === ''
    && str_contains($tar['out'], basename($mediaFile))
    && !str_contains($tar['out'], 'Gap_Bird-90'),
    'scoped tar is staged successfully before its response: ' . json_encode([
        'status' => $tar['status'], 'err' => $tar['err'], 'bytes' => strlen($tar['out']),
    ]));
$maintenanceProbe = $tmp . '/maintenance-lock-probe';
$maintenanceChild = '$h=fopen(' . var_export($lockPath, true) . ',"r+");'
    . 'exit(is_resource($h)&&flock($h,LOCK_EX|LOCK_NB)?1:0);';
$maintenancePrelude = '$GLOBALS["AVIAN_EDUCATOR_TEST_HOOK"]=function($phase){'
    . 'if($phase!=="export-before-tar")return;$pipes=[];$p=proc_open('
    . var_export([PHP_BINARY, '-r', $maintenanceChild], true)
    . ',[0=>["file","/dev/null","r"],1=>["file","/dev/null","w"],'
    . '2=>["file","/dev/null","w"]],$pipes);$status=is_resource($p)?proc_close($p):2;'
    . 'file_put_contents(' . var_export($maintenanceProbe, true) . ',(string)$status);};';
$maintenanceRace = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'recordings', 'edu' => $folder['id']],
    $directServer,
    '',
    [],
    null,
    $maintenancePrelude
);
edu_check($maintenanceRace['status'] === 200
    && file_get_contents($maintenanceProbe) === '0',
    'scoped tar holds the shared maintenance lock through path authorization and staging');
$removedDuringTar = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'recordings', 'edu' => $folder['id']],
    $directServer,
    '',
    [],
    null,
    '$GLOBALS["AVIAN_EDUCATOR_TEST_HOOK"]=function($phase){if($phase==="export-before-tar")'
        . '@unlink(' . var_export($mediaFile, true) . ');};'
);
edu_check($removedDuringTar['status'] === 409
    && is_array(json_decode($removedDuringTar['out'], true))
    && !str_contains($removedDuringTar['out'], basename($mediaFile)),
    'scoped tar handles retention removal without deadlock or partial archive output');
file_put_contents($mediaFile, $originalMediaBytes);
$unavailableTar = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'recordings', 'edu' => $folder['id']],
    $directServer,
    '',
    [],
    null,
    '$GLOBALS["AVIAN_EDUCATOR_TEST_TAR_BINARY"]="/definitely-not-avian-tar";'
);
edu_check($unavailableTar['status'] === 503
    && is_array(json_decode($unavailableTar['out'], true))
    && !str_contains($unavailableTar['out'], basename($mediaFile)),
    'scoped tar reports process startup failure before any archive headers or bytes');

$differentExportGeneration = str_repeat('b', 32);
edu_set_marker($birds, $differentExportGeneration);
$generationCsv = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id']],
    $directServer
);
$generationSavedMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $folder['id'], 'detection' => (string)$hookInserted, 'file' => basename($mediaFile)],
    $publicServer
);
$generationSavedProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $publicServer
);
$generationPublicData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $publicServer
);
$generationDirectData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer
);
$generationDirectProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $directServer
);
edu_set_marker($birds, $generation);
$generationCsvJson = json_decode($generationCsv['out'], true);
edu_check($generationCsv['status'] === 409
    && is_array($generationCsvJson)
    && ($generationCsvJson['ok'] ?? true) === false
    && !str_starts_with($generationCsv['out'], 'Date,Time')
    && !str_contains($generationCsv['out'], 'Test_Bird-91'),
    'detections CSV returns a clean 409 before headers or rows for a generation mismatch');
edu_check($generationSavedMedia['status'] === 409
    && $generationSavedMedia['out'] === 'saved view unavailable'
    && !str_contains($generationSavedMedia['out'], 'different detections database'),
    'public saved media keeps scoped 409 failures generic');
edu_check($generationSavedProbe['status'] === 409
    && $generationDirectProbe['status'] === 409
    && $generationDirectProbe['out'] === $generationSavedProbe['out']
    && $generationSavedProbe['out'] === '{"error":"saved view unavailable","educator_scope":null}'
    && !str_contains($generationSavedProbe['out'], $folder['id'])
    && !str_contains($generationSavedProbe['out'], 'different detections database'),
    'saved probe keeps generation failures generic on direct and public hosts');
edu_check($generationPublicData['status'] === 409
    && $generationDirectData['status'] === 409
    && $generationDirectData['out'] === $generationPublicData['out']
    && $generationPublicData['out'] === '{"error":"saved view unavailable","educator_scope":null}',
    'saved bird-data generation errors are generic on direct and public hosts');
$generationCsvLock = educator_store_lock(true);
edu_check(is_resource($generationCsvLock),
    'detections CSV generation failure releases the Educators scope lock');
educator_store_unlock($generationCsvLock);

putenv('AV_EDUCATOR_BIRDS_DB=' . $tmp . '/missing-export-birds.db');
$missingCsv = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id']],
    $directServer
);
putenv('AV_EDUCATOR_BIRDS_DB=' . $birdsPath);
$missingCsvJson = json_decode($missingCsv['out'], true);
edu_check($missingCsv['status'] === 503
    && is_array($missingCsvJson)
    && ($missingCsvJson['ok'] ?? true) === false
    && !str_starts_with($missingCsv['out'], 'Date,Time'),
    'detections CSV returns a clean 503 before headers or rows when Birds data is unavailable');
$missingCsvLock = educator_store_lock(true);
edu_check(is_resource($missingCsvLock),
    'detections CSV availability failure releases the Educators scope lock');
educator_store_unlock($missingCsvLock);

putenv('AV_EDUCATOR_BIRDS_DB=' . $tmp . '/missing-export-birds.db');
$missingSavedData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $publicServer
);
$missingSavedDataDirect = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer
);
edu_check($missingSavedData['status'] === 503
    && $missingSavedDataDirect['status'] === 503
    && $missingSavedDataDirect['out'] === $missingSavedData['out']
    && $missingSavedData['out'] === '{"error":"saved view unavailable","educator_scope":null}',
    'saved bird-data keeps a missing Birds database generic on direct and public hosts');

$unopenableBirdsPath = $tmp . '/unopenable-birds.db';
mkdir($unopenableBirdsPath, 0700);
putenv('AV_EDUCATOR_BIRDS_DB=' . $unopenableBirdsPath);
$unopenableSavedData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $publicServer
);
$unopenableSavedDataDirect = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer
);
putenv('AV_EDUCATOR_BIRDS_DB=' . $birdsPath);
rmdir($unopenableBirdsPath);
edu_check($unopenableSavedData['status'] === 503
    && $unopenableSavedDataDirect['status'] === 503
    && $unopenableSavedDataDirect['out'] === $unopenableSavedData['out']
    && $unopenableSavedData['out'] === '{"error":"saved view unavailable","educator_scope":null}',
    'saved bird-data keeps an unopenable Birds database generic on direct and public hosts');

$birds->exec(
    "WITH RECURSIVE overflow(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM overflow WHERE n<20001) "
    . "INSERT INTO detections(Date,Time,Sci_Name,Com_Name,Confidence,File_Name) "
    . "SELECT '2026-01-02','10:12:30','Avis overflow','Overflow Bird',0.50,"
    . "printf('Educator_Export_Overflow-%05d.mp3',n) FROM overflow"
);
$oversizeCsv = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id']],
    $directServer
);
$oversizeSavedProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $publicServer
);
$oversizePublicData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $publicServer
);
$oversizeDirectData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer
);
$oversizeDirectProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $folder['id']],
    $directServer
);
$oversizeCsvJson = json_decode($oversizeCsv['out'], true);
edu_check($oversizeCsv['status'] === 413
    && is_array($oversizeCsvJson)
    && ($oversizeCsvJson['ok'] ?? true) === false
    && !str_starts_with($oversizeCsv['out'], 'Date,Time')
    && !str_contains($oversizeCsv['out'], 'Educator_Export_Overflow'),
    'detections CSV returns a clean 413 before headers or rows when scope materialization exceeds its cap');
$oversizeCsvLock = educator_store_lock(true);
edu_check(is_resource($oversizeCsvLock),
    'detections CSV cap failure releases the Educators scope lock');
educator_store_unlock($oversizeCsvLock);
$oversizeSavedMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $folder['id'], 'detection' => (string)$hookInserted, 'file' => basename($mediaFile)],
    $publicServer
);
edu_check($oversizeSavedMedia['status'] === 413
    && $oversizeSavedMedia['out'] === 'saved view unavailable'
    && !str_contains($oversizeSavedMedia['out'], 'too many detections'),
    'public saved media keeps scoped 413 failures generic');
edu_check($oversizeSavedProbe['status'] === 413
    && $oversizeDirectProbe['status'] === 413
    && $oversizeDirectProbe['out'] === $oversizeSavedProbe['out']
    && $oversizeSavedProbe['out'] === '{"error":"saved view unavailable","educator_scope":null}'
    && !str_contains($oversizeSavedProbe['out'], $folder['id'])
    && !str_contains($oversizeSavedProbe['out'], 'too many detections'),
    'saved probe stops at the 20,001-row sentinel and keeps the cap generic on every host');
edu_check($oversizePublicData['status'] === 413
    && $oversizeDirectData['status'] === 413
    && $oversizeDirectData['out'] === $oversizePublicData['out']
    && $oversizePublicData['out'] === '{"error":"saved view unavailable","educator_scope":null}',
    'saved bird-data cap errors are generic on direct and public hosts');
$birds->exec("DELETE FROM detections WHERE File_Name LIKE 'Educator_Export_Overflow-%'");

$store->exec('UPDATE folders SET name=CAST(X\'FF\' AS TEXT) WHERE id=' . $folderInternalId);
$corruptState = edu_endpoint($apiRoot . '/educators.php', [], $directServer);
$corruptStateJson = json_decode($corruptState['out'], true);
edu_check($corruptState['status'] === 503 && is_array($corruptStateJson)
    && ($corruptStateJson['ok'] ?? true) === false,
    'corrupt SQLite text produces a checked Educators 503 JSON response');
$corruptBirds = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $directServer
);
$corruptBirdsJson = json_decode($corruptBirds['out'], true);
edu_check($corruptBirds['status'] === 503 && is_array($corruptBirdsJson)
    && array_key_exists('educator_scope', $corruptBirdsJson)
    && $corruptBirdsJson['educator_scope'] === null,
    'corrupt scope labels never become an empty 200 bird-data response');
$restoreFolderName = $store->prepare('UPDATE folders SET name=:name WHERE id=:id');
$restoreFolderName->bindValue(':name', 'Period One', SQLITE3_TEXT);
$restoreFolderName->bindValue(':id', $folderInternalId, SQLITE3_INTEGER);
$restoreFolderName->execute();

file_put_contents($statePath, "v1\t0\t8\n");
$missingStorePath = $dataDir . '/missing.db';
putenv('AV_EDUCATOR_STORE_FILE=' . $missingStorePath);
file_put_contents($maintenanceMarkerPath, "v1\trestore\n");
$maintenanceBirdData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats'],
    $publicServer
);
$maintenanceRecording = edu_endpoint($apiRoot . '/recording.php', [], $publicServer);
$maintenanceExport = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections'],
    $publicServer
);
edu_check($maintenanceBirdData['status'] === 503
    && $maintenanceRecording['status'] === 503
    && $maintenanceExport['status'] === 503,
    'persistent maintenance marker blocks disabled global data, media, and exports without fallback: '
        . json_encode([$maintenanceBirdData['status'], $maintenanceRecording['status'], $maintenanceExport['status']]));
unlink($maintenanceMarkerPath);
$disabledBirdData = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats'],
    $publicServer
);
edu_check($disabledBirdData['status'] === 200 && !file_exists($missingStorePath),
    'disabled profile serves global bird data without opening an Educators store');
$disabledRecent = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'recent', 'hours' => '1000000'],
    $publicServer
);
$disabledSpecies = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'species', 'sci' => 'Avis testus', 'limit' => '1'],
    $publicServer
);
edu_check($disabledRecent['status'] === 200 && $disabledSpecies['status'] === 200
    && (json_decode($disabledRecent['out'], true)['species'][0]['detection_id'] ?? 0) > 0
    && (json_decode($disabledSpecies['out'], true)['detections'][0]['detection_id'] ?? 0) > 0,
    'disabled global collage and species actions expose the source rowid alias without SQL errors');
$disabledApi = edu_endpoint($apiRoot . '/educators.php', [], $publicServer);
edu_check($disabledApi['status'] === 404 && str_contains($disabledApi['out'], 'disabled')
    && !str_contains($disabledApi['out'], 'unauthorized'),
    'disabled Educators API returns its stable 404 before auth behavior');
$disabledCapability = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $folder['id']],
    $publicServer
);
$disabledCapabilityMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $capture['id'], 'detection' => (string)$hookInserted, 'file' => basename($mediaFile)],
    $publicServer
);
edu_check($disabledCapability['status'] === 404
    && $disabledCapability['out'] === $publicMissing['out']
    && $disabledCapabilityMedia['status'] === 404
    && $disabledCapabilityMedia['out'] === 'not found',
    'disabling Educators revokes saved data and media links with the uniform 404');
putenv('AV_REQUIRE_AUTH=1');
$disabledProtectedApi = edu_endpoint($apiRoot . '/educators.php', [], $directServer);
edu_check($disabledProtectedApi['status'] === 404
    && !str_contains($disabledProtectedApi['out'], 'unauthorized'),
    'disabled Educators API stays a stable 404 when LAN admin auth is on');
putenv('AV_REQUIRE_AUTH=0');
file_put_contents($statePath, "v1\t1\t9\n");
$enabledMissingStore = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats'],
    $publicServer
);
edu_check($enabledMissingStore['status'] === 503,
    'enabled profile fails ordinary bird data closed when its state store is unavailable');
putenv('AV_EDUCATOR_STORE_FILE=' . $storePath);
$enabledNoActive = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'recent', 'hours' => '1000000'],
    $publicServer
);
$enabledNoActiveJson = json_decode($enabledNoActive['out'], true);
edu_check($enabledNoActive['status'] === 200
    && array_key_exists('educator_scope', $enabledNoActiveJson)
    && $enabledNoActiveJson['educator_scope'] === null
    && ($enabledNoActiveJson['species'][0]['detection_id'] ?? 0) > 0,
    'enabled profile with no current capture serves a valid unscoped response');
$badJsonServer = array_merge($directServer, [
    'REQUEST_METHOD' => 'POST',
    'CONTENT_TYPE' => 'application/json',
    'HTTP_X_AVIAN_ACTION' => '1',
    'CONTENT_LENGTH' => '58',
]);
$badJson = edu_endpoint(
    $apiRoot . '/educators.php',
    [],
    $badJsonServer,
    "{\"action\":\"start\",\"state_revision\":0,\"name\":\"\xff\"}"
);
edu_check($badJson['status'] === 400 && str_contains($badJson['out'], 'invalid request'),
    'Educators API rejects malformed UTF-8 instead of substituting it');
edu_throws(fn() => educator_api_decode_body(
    "{\"action\":\"start\",\"state_revision\":0,\"name\":\"\xff\"}"
), 400, 'Educators JSON decoder rejects malformed UTF-8 name bytes');

putenv('AVIAN_STATION_TIMEZONE=UTC');
putenv('AV_EDUCATOR_NOW=2026-01-04T12:00:00+00:00');
$activeCapture = educator_store_start($store, educator_state_revision($store))['capture'];
$liveProbeFolder = educator_store_create_folder(
    $store,
    'Live probe folder',
    educator_state_revision($store)
)['folder'];
$activeCapture = educator_store_update_capture(
    $store,
    'move-capture',
    $activeCapture['id'],
    $activeCapture['revision'],
    educator_state_revision($store),
    $liveProbeFolder['id']
)['capture'];
$activeCountState = educator_state_revision($store);
$activeCountResponse = edu_endpoint(
    $apiRoot . '/educators.php',
    [
        'action' => 'capture-counts',
        'ids' => $activeCapture['id'],
        'state_revision' => (string)$activeCountState,
    ],
    $directServer
);
edu_check($activeCountResponse['status'] === 409
    && str_contains($activeCountResponse['out'], 'still active'),
    'the saved-count endpoint refuses a running period');
$activeFileName = 'Test_Bird-93-2026-01-04-birdnet-12:00:01.mp3';
$activeDetection = edu_insert_detection($birds, '2026-01-04', '12:00:01', $activeFileName);
$liveFolderProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $liveProbeFolder['id']],
    $publicServer
);
$liveFolderProbeJson = json_decode($liveFolderProbe['out'], true);
edu_check($liveFolderProbe['status'] === 200
    && ($liveFolderProbeJson['open'] ?? false) === true
    && ($liveFolderProbeJson['educator_scope']['kind'] ?? '') === 'folder'
    && preg_match('/\A[a-f0-9]{24}\z/D', (string)($liveFolderProbeJson['fingerprint'] ?? '')) === 1
    && !str_contains($liveFolderProbe['out'], $liveProbeFolder['id'])
    && !str_contains($liveFolderProbe['out'], 'Live probe folder'),
    'a folder probe reports open while it contains the current running capture');
$activeDir = $mediaRoot . '/By_Date/2026-01-04/Test_Bird';
mkdir($activeDir, 0700, true);
$activeBytes = 'ID3' . str_repeat("\x01", 61);
file_put_contents($activeDir . '/' . $activeFileName, $activeBytes);
$pngBytes = "\x89PNG\r\n\x1a\n" . str_repeat("\0", 56);
file_put_contents($activeDir . '/' . $activeFileName . '.png', $pngBytes);
$publicActive = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'recent', 'hours' => '24', 'edu' => 'active'],
    $publicServer
);
$publicActiveJson = json_decode($publicActive['out'], true);
$publicScope = $publicActiveJson['educator_scope'] ?? [];
edu_check($publicActive['status'] === 200
    && preg_match('/\A[a-f0-9]{24}\z/D', (string)($publicScope['state_key'] ?? '')) === 1
    && ($publicScope['state_key'] ?? '') !== $firstStateKey
    && !isset($publicScope['id'], $publicScope['label'], $publicScope['generation'])
    && ($publicActiveJson['species'][0]['detection_id'] ?? 0) === $activeDetection,
    'replacement active capture has a new generic key and no private scope metadata');
$automaticActive = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'recent', 'hours' => '24'],
    $publicServer
);
$automaticActiveJson = json_decode($automaticActive['out'], true);
edu_check($automaticActive['status'] === 200
    && ($automaticActiveJson['species'][0]['detection_id'] ?? 0) === $activeDetection
    && !isset($automaticActiveJson['educator_scope']['id'], $automaticActiveJson['educator_scope']['label']),
    'omitted bird-data scope automatically follows the current capture without private metadata');
$publicRecording = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => 'active', 'detection' => (string)$activeDetection, 'file' => $activeFileName],
    $publicServer
);
edu_check($publicRecording['status'] === 200 && $publicRecording['err'] === ''
    && hash_equals($activeBytes, $publicRecording['out']),
    'public active recording streams exactly the frozen verified bytes: ' . json_encode([
        'status' => $publicRecording['status'], 'err' => $publicRecording['err'],
        'out' => $publicRecording['out'],
    ]));
$publicSpectrogram = edu_endpoint(
    $apiRoot . '/spectrogram.php',
    ['edu' => 'active', 'detection' => (string)$activeDetection, 'file' => $activeFileName],
    $publicServer
);
edu_check($publicSpectrogram['status'] === 200 && hash_equals($pngBytes, $publicSpectrogram['out']),
    'public active spectrogram streams an exact validated PNG: ' . json_encode([
        'status' => $publicSpectrogram['status'], 'err' => $publicSpectrogram['err'],
        'bytes' => strlen($publicSpectrogram['out']),
    ]));
$legacyRecording = edu_endpoint(
    $apiRoot . '/recording.php',
    ['detection' => (string)$activeDetection, 'file' => $activeFileName],
    $publicServer
);
edu_check(!str_contains($legacyRecording['out'], 'detection required'),
    'legacy media requests without edu keep station-wide behavior while a capture is active');
$savedActiveMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $activeCapture['id'], 'detection' => (string)$activeDetection, 'file' => $activeFileName],
    $publicServer
);
edu_check($savedActiveMedia['status'] === 200
    && hash_equals($activeBytes, $savedActiveMedia['out']),
    'a saved capture capability serves only its exact row-bound recording');

require_once $apiRoot . '/admin-auth.php';
$adminStatePath = $tmp . '/admin-auth.state';
$adminVerifier = '$2y$14$' . str_repeat('A', 53);
file_put_contents($adminStatePath, "v1\t1\t1\t" . $adminVerifier . "\n");
putenv('AV_ADMIN_STATE_FILE=' . $adminStatePath);
putenv('AV_ADMIN_STATE_TEST_METADATA=1');
$sessionPath = $tmp . '/sessions';
mkdir($sessionPath, 0700);
ini_set('session.save_path', $sessionPath);
$protectedServer = array_merge($directServer, ['HTTPS' => 'on', 'SERVER_PORT' => '443']);
putenv('AV_REQUIRE_AUTH=1');
$_COOKIE = [];
session_id('');
edu_check(avian_create_admin_session($protectedServer),
    'protected export fixture creates a verifier-bound admin session');
$adminSession = session_id();
$adminCookies = [AVIAN_ADMIN_SESSION_NAME => $adminSession];
$protectedDirectMenu = edu_endpoint(
    $apiRoot . '/menu.php',
    [],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
$protectedForwardedMenu = edu_endpoint(
    $apiRoot . '/menu.php',
    [],
    array_merge($protectedServer, ['HTTP_X_FORWARDED_FOR' => '198.51.100.2']),
    '',
    $adminCookies,
    $sessionPath
);
$protectedDirectMenuJson = json_decode($protectedDirectMenu['out'], true);
$protectedForwardedMenuJson = json_decode($protectedForwardedMenu['out'], true);
edu_check($protectedDirectMenu['status'] === 200
    && $protectedForwardedMenu['status'] === 200
    && ($protectedDirectMenuJson['auth']['direct_local'] ?? null) === true
    && ($protectedForwardedMenuJson['auth']['direct_local'] ?? null) === false,
    'authenticated menu reports locality from the authoritative direct-request boundary');
$menuGrant = function (string $what, ?string $scope, ?array $server = null) use (
    $apiRoot,
    $protectedServer,
    $adminCookies,
    $sessionPath
): array {
    $body = ['scope' => $what];
    if ($scope !== null) $body['edu'] = $scope;
    $json = json_encode($body);
    $requestServer = array_merge($server ?? $protectedServer, [
        'REQUEST_METHOD' => 'POST',
        'CONTENT_TYPE' => 'application/json',
        'HTTP_X_AVIAN_ACTION' => '1',
        'CONTENT_LENGTH' => (string)strlen((string)$json),
        // Match the real route. The Educators scope is intentionally in the
        // JSON body, not in this action-only HTTP query string.
        'QUERY_STRING' => 'action=download-grant',
    ]);
    return edu_endpoint(
        $apiRoot . '/menu.php',
        ['action' => 'download-grant'],
        $requestServer,
        '',
        $adminCookies,
        $sessionPath,
        edu_php_input_prelude((string)$json)
    );
};
$grantToken = static function (array $response): string {
    $decoded = json_decode($response['out'], true);
    return is_array($decoded) && is_string($decoded['token'] ?? null)
        ? $decoded['token'] : '';
};

$toolsGrantResponse = $menuGrant('detections', null);
$toolsGrant = $grantToken($toolsGrantResponse);
$protectedTools = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'grant' => (string)$toolsGrant],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($toolsGrantResponse['status'] === 200
    && preg_match('/\A[a-f0-9]{48}\z/D', $toolsGrant) === 1
    && $protectedTools['status'] === 200
    && str_contains($protectedTools['out'], $activeFileName)
    && !str_contains($protectedTools['out'], 'Test_Bird-91-2026-01-02'),
    'protected menu grant and Tools CSV bind an omitted edu body to the exact active capture');

$activeArchiveGrantResponse = $menuGrant('recordings', 'active');
$activeArchiveGrant = $grantToken($activeArchiveGrantResponse);
$protectedActiveArchive = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'recordings', 'edu' => 'active', 'grant' => (string)$activeArchiveGrant],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($activeArchiveGrantResponse['status'] === 200
    && preg_match('/\A[a-f0-9]{48}\z/D', $activeArchiveGrant) === 1
    && $protectedActiveArchive['status'] === 200
    && str_contains($protectedActiveArchive['out'], $activeFileName),
    'protected menu active grant downloads the exact private capture tar server-side');

$forwardedProtectedServer = array_merge(
    $protectedServer,
    ['HTTP_X_FORWARDED_FOR' => '198.51.100.2']
);
$forwardedActiveGrantResponse = $menuGrant(
    'detections',
    'active',
    $forwardedProtectedServer
);
$forwardedActiveGrant = $grantToken($forwardedActiveGrantResponse);
$forwardedActiveExport = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => 'active', 'grant' => (string)$forwardedActiveGrant],
    $forwardedProtectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($forwardedActiveGrantResponse['status'] === 200
    && preg_match('/\A[a-f0-9]{48}\z/D', $forwardedActiveGrant) === 1
    && $forwardedActiveExport['status'] === 200
    && str_contains($forwardedActiveExport['out'], $activeFileName)
    && !str_contains($forwardedActiveExport['out'], 'Test_Bird-91-2026-01-02'),
    'forwarded protected active grant stays bound to the exact current capture');

$forwardedImplicitGrantResponse = $menuGrant(
    'detections',
    null,
    $forwardedProtectedServer
);
$forwardedImplicitGrant = $grantToken($forwardedImplicitGrantResponse);
$forwardedImplicitExport = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'grant' => (string)$forwardedImplicitGrant],
    $forwardedProtectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($forwardedImplicitGrantResponse['status'] === 200
    && preg_match('/\A[a-f0-9]{48}\z/D', $forwardedImplicitGrant) === 1
    && $forwardedImplicitExport['status'] === 200
    && str_contains($forwardedImplicitExport['out'], $activeFileName)
    && !str_contains($forwardedImplicitExport['out'], 'Test_Bird-91-2026-01-02'),
    'forwarded protected implicit Tools grant keeps the automatic active scope');

foreach ([$capture['id'] => 'saved capture', $folder['id'] => 'saved folder'] as $savedId => $label) {
    $savedGrantResponse = $menuGrant('detections', $savedId);
    $savedGrant = $grantToken($savedGrantResponse);
    $savedExport = edu_endpoint(
        $apiRoot . '/export.php',
        ['what' => 'detections', 'edu' => $savedId, 'grant' => (string)$savedGrant],
        $protectedServer,
        '',
        $adminCookies,
        $sessionPath
    );
    edu_check($savedGrantResponse['status'] === 200
        && preg_match('/\A[a-f0-9]{48}\z/D', $savedGrant) === 1
        && $savedExport['status'] === 200
        && str_contains($savedExport['out'], 'Test_Bird-91-2026-01-02')
        && !str_contains($savedExport['out'], 'Gap_Bird-90'),
        "protected menu $label grant downloads its exact CSV binding");
}

$mismatchGrantResponse = $menuGrant('detections', $folder['id']);
$mismatchGrant = $grantToken($mismatchGrantResponse);
$mismatchedExport = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $capture['id'], 'grant' => $mismatchGrant],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($mismatchGrantResponse['status'] === 200
    && $mismatchedExport['status'] === 401
    && !str_starts_with($mismatchedExport['out'], 'Date,Time')
    && !str_contains($mismatchedExport['out'], 'Test_Bird-91'),
    'a protected grant cannot cross from its folder binding to a capture CSV');

$crossExportGrantResponse = $menuGrant('detections', $folder['id']);
$crossExportGrant = $grantToken($crossExportGrantResponse);
$crossExport = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'recordings', 'edu' => $folder['id'], 'grant' => $crossExportGrant],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($crossExportGrantResponse['status'] === 200
    && $crossExport['status'] === 401
    && !str_contains($crossExport['out'], basename($mediaFile)),
    'a protected detections grant cannot authorize a recordings archive');

$invalidGrantResponse = $menuGrant('detections', 'not-a-capability');
$missingGrantResponse = $menuGrant('detections', 'c_' . str_repeat('0', 32));
edu_check($invalidGrantResponse['status'] === 400
    && $missingGrantResponse['status'] === 404
    && !str_contains($invalidGrantResponse['out'], 'token')
    && !str_contains($missingGrantResponse['out'], 'token'),
    'protected menu grants reject malformed and unknown body scopes without issuing tokens');

$forwardedMenuGrant = $menuGrant(
    'detections',
    $folder['id'],
    array_merge($protectedServer, ['HTTP_X_FORWARDED_FOR' => '198.51.100.2'])
);
edu_check($forwardedMenuGrant['status'] === 404
    && !str_contains($forwardedMenuGrant['out'], $folder['id'])
    && !str_contains($forwardedMenuGrant['out'], 'token'),
    'an authenticated forwarded request cannot enumerate or mint a saved-scope grant');

$strictGetGrantResponse = $menuGrant('detections', $folder['id']);
$strictGetGrant = $grantToken($strictGetGrantResponse);
$strictDuplicateGet = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id'], 'grant' => $strictGetGrant],
    array_merge($protectedServer, [
        'QUERY_STRING' => 'what=detections&edu=bad&edu=' . rawurlencode($folder['id'])
            . '&grant=' . rawurlencode($strictGetGrant),
    ]),
    '',
    $adminCookies,
    $sessionPath
);
edu_check($strictGetGrantResponse['status'] === 200
    && $strictDuplicateGet['status'] === 400
    && !str_starts_with($strictDuplicateGet['out'], 'Date,Time'),
    'JSON-body grant resolution does not relax duplicate edu rejection on GET downloads');

$forwardedGrantResponse = $menuGrant('detections', $folder['id']);
$forwardedGrant = $grantToken($forwardedGrantResponse);
$protectedForwarded = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id'], 'grant' => (string)$forwardedGrant],
    array_merge($publicServer, ['HTTPS' => 'on', 'SERVER_PORT' => '443']),
    '',
    $adminCookies,
    $sessionPath
);
edu_check($forwardedGrantResponse['status'] === 200
    && $protectedForwarded['status'] === 404
    && !str_contains($protectedForwarded['out'], $folder['id']),
    'protected explicit export remains unavailable through a forwarded host');
$forwardedGrantDirect = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => $folder['id'], 'grant' => (string)$forwardedGrant],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($forwardedGrantDirect['status'] === 200,
    'a forwarded enumeration denial does not consume the direct-LAN grant');

$stopRaceGrantResponse = $menuGrant('detections', 'active');
$stopRaceGrant = $grantToken($stopRaceGrantResponse);
putenv('AV_EDUCATOR_NOW=2026-01-04T12:01:00+00:00');
$stoppedActiveCapture = educator_store_transition(
    $store,
    'stop',
    $activeCapture['id'],
    $activeCapture['revision'],
    educator_state_revision($store)
);
$stoppedLiveFolderProbe = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'scope-probe', 'edu' => $liveProbeFolder['id']],
    $publicServer
);
$stoppedLiveFolderProbeJson = json_decode($stoppedLiveFolderProbe['out'], true);
edu_check($stoppedLiveFolderProbe['status'] === 200
    && ($stoppedLiveFolderProbeJson['open'] ?? true) === false
    && ($stoppedLiveFolderProbeJson['fingerprint'] ?? '')
        === ($liveFolderProbeJson['fingerprint'] ?? null)
    && ($stoppedLiveFolderProbeJson['educator_scope']['state_key'] ?? '')
        !== ($liveFolderProbeJson['educator_scope']['state_key'] ?? ''),
    'Stop changes the folder probe state and closes it without inventing a detection change');
$stoppedGrant = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => 'active', 'grant' => (string)$stopRaceGrant],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($stopRaceGrantResponse['status'] === 200
    && $stoppedGrant['status'] === 404
    && !str_contains($stoppedGrant['out'], $activeCapture['id']),
    'Stop between grant creation and download fails the active URL closed');
$replayedStopGrant = edu_endpoint(
    $apiRoot . '/export.php',
    ['what' => 'detections', 'edu' => 'active', 'grant' => (string)$stopRaceGrant],
    $protectedServer,
    '',
    $adminCookies,
    $sessionPath
);
edu_check($replayedStopGrant['status'] === 401,
    'a Stop-raced download grant remains strictly one-use');
putenv('AV_REQUIRE_AUTH=0');
$staleActiveMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => 'active', 'detection' => (string)$activeDetection, 'file' => $activeFileName],
    $publicServer
);
edu_check($staleActiveMedia['status'] === 404 && !str_contains($staleActiveMedia['out'], $activeBytes),
    'active media URL fails closed when Stop wins before playback');

putenv('AVIAN_STATION_TIMEZONE=UTC');
putenv('AV_EDUCATOR_NOW=2026-01-05T10:00:00+00:00');
$reuseCapture = educator_store_start($store, educator_state_revision($store))['capture'];
$reuseStateBefore = educator_store_snapshot($store);
$reuseMutationSnapshot = educator_store_snapshot($store, false);
edu_check(array_key_exists('detection_count', $reuseMutationSnapshot['active'])
    && array_key_exists('species_count', $reuseMutationSnapshot['active'])
    && $reuseMutationSnapshot['active']['detection_count'] === null
    && $reuseMutationSnapshot['active']['species_count'] === null,
    'post-mutation snapshots omit Birds database counts');
$reuseFirst = edu_insert_detection($birds, '2026-01-05', '10:00:01', 'Reuse_A-90-2026-01-05-birdnet-10:00:01.mp3');
$reuseSecond = edu_insert_detection($birds, '2026-01-05', '10:00:01', 'Reuse_B-90-2026-01-05-birdnet-10:00:01.mp3');
$reuseThird = edu_insert_detection($birds, '2026-01-05', '10:00:01', 'Reuse_C-90-2026-01-05-birdnet-10:00:01.mp3');
$birds->exec('DELETE FROM detections WHERE rowid IN (' . $reuseSecond . ',' . $reuseThird . ')');
$replacementSecond = edu_insert_detection($birds, '2026-01-05', '10:00:01', 'Reuse_D-90-2026-01-05-birdnet-10:00:01.mp3');
$replacementThird = edu_insert_detection($birds, '2026-01-05', '10:00:01', 'Reuse_E-90-2026-01-05-birdnet-10:00:01.mp3');
$reuseStateAfter = educator_store_snapshot($store);
$reuseActiveAfter = $reuseStateAfter['active'];
edu_check($replacementSecond === $reuseSecond && $replacementThird === $reuseThird
    && $reuseStateAfter['state_revision'] === $reuseStateBefore['state_revision']
    && ($reuseStateBefore['active']['detection_count'] ?? -1) === 0
    && ($reuseActiveAfter['detection_count'] ?? -1) === 3
    && ($reuseActiveAfter['species_count'] ?? -1) === 1,
    'monotonic insertion sequences survive multiple highest-row deletions, same-second rowid reuse, and count polls');
putenv('AV_EDUCATOR_NOW=2026-01-05T10:01:00+00:00');
$reuseStopped = educator_store_transition(
    $store,
    'stop',
    $reuseCapture['id'],
    $reuseCapture['revision'],
    educator_state_revision($store)
)['capture'];
$reuseScope = educator_resolve_scope(['edu' => $reuseStopped['id']]);
$reuseBirds = new SQLite3($birdsPath, SQLITE3_OPEN_READONLY);
$reuseBirds->exec('BEGIN');
educator_scope_detection_table($reuseBirds, $reuseScope);
edu_check((int)$reuseBirds->querySingle('SELECT COUNT(*) FROM detections') === 3
    && educator_scope_detection_row($reuseBirds, $reuseFirst) !== null
    && educator_scope_detection_row($reuseBirds, $replacementSecond) !== null
    && educator_scope_detection_row($reuseBirds, $replacementThird) !== null,
    'saved scope includes every replacement row without clearing educator metadata');
$reuseBirds->exec('COMMIT');
educator_scope_release($reuseScope);
$reuseBirds->close();

$futureFolderResult = educator_store_create_folder(
    $store,
    'Future Membership',
    educator_state_revision($store)
);
$futureFolder = $futureFolderResult['folder'];
$futureBefore = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $futureFolder['id']],
    $publicServer
);
$futureBeforeJson = json_decode($futureBefore['out'], true);
$movedIntoFuture = educator_store_update_capture(
    $store,
    'move-capture',
    $reuseStopped['id'],
    $reuseStopped['revision'],
    educator_state_revision($store),
    $futureFolder['id']
)['capture'];
$futureAfter = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $futureFolder['id']],
    $publicServer
);
$futureAfterJson = json_decode($futureAfter['out'], true);
edu_check($futureBefore['status'] === 200
    && ($futureBeforeJson['totals']['detections'] ?? -1) === 0
    && $futureAfter['status'] === 200
    && ($futureAfterJson['totals']['detections'] ?? -1) === 3,
    'a folder capability includes a period moved into it after the link was copied');

educator_store_delete_capture(
    $store,
    $movedIntoFuture['id'],
    $movedIntoFuture['revision'],
    educator_state_revision($store)
);
$deletedCaptureLink = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $movedIntoFuture['id']],
    $publicServer
);
$deletedCaptureMedia = edu_endpoint(
    $apiRoot . '/recording.php',
    ['edu' => $movedIntoFuture['id'], 'detection' => '1', 'file' => basename($mediaFile)],
    $publicServer
);
$futureFolderRow = educator_folder_row($store, $futureFolder['id']);
educator_store_delete_folder(
    $store,
    $futureFolder['id'],
    (int)$futureFolderRow['revision'],
    educator_state_revision($store)
);
$deletedFolderLink = edu_endpoint(
    $apiRoot . '/birdnet-api.php',
    ['action' => 'stats', 'edu' => $futureFolder['id']],
    $publicServer
);
edu_check($deletedCaptureLink['status'] === 404
    && $deletedFolderLink['status'] === 404
    && $deletedCaptureMedia['status'] === 404
    && $deletedCaptureMedia['out'] === 'not found'
    && $deletedCaptureLink['out'] === $publicMissing['out']
    && $deletedFolderLink['out'] === $publicMissing['out'],
    'deleting a saved capture or folder revokes its capability with the uniform 404');

$limitDb = new SQLite3(':memory:');
$limitDb->enableExceptions(true);
educator_store_schema($limitDb);
$limitFolderId = 'f_' . str_repeat('e', 32);
$limitDb->exec(
    "INSERT INTO folders(public_id,name,created_at_utc,updated_at_utc) VALUES('"
    . $limitFolderId . "','Limits','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')"
);
$limitFolderInternal = (int)$limitDb->lastInsertRowID();
$limitCaptureIds = [];
$limitBaseEpoch = 1767225600;
for ($captureIndex = 1; $captureIndex <= 5; $captureIndex++) {
    $public = 'c_' . str_pad(dechex($captureIndex), 32, '0', STR_PAD_LEFT);
    $stmt = $limitDb->prepare(
        "INSERT INTO captures(public_id,name,status,folder_id,started_local,started_at_utc,started_epoch,"
        . "started_offset,started_timezone,stopped_local,stopped_at_utc,stopped_epoch,stopped_offset,"
        . "stopped_timezone,created_at_utc,updated_at_utc) VALUES(:public,:name,'stopped',:folder,"
        . "'2026-01-01 00:00:00','2026-01-01T00:00:00Z',1767225600,'+00:00','UTC',"
        . "'2026-01-01 02:00:00','2026-01-01T02:00:00Z',1767232800,'+00:00','UTC',"
        . "'2026-01-01T00:00:00Z','2026-01-01T02:00:00Z')"
    );
    $stmt->bindValue(':public', $public, SQLITE3_TEXT);
    $stmt->bindValue(':name', 'Limit ' . $captureIndex, SQLITE3_TEXT);
    $stmt->bindValue(':folder', $limitFolderInternal, SQLITE3_INTEGER);
    $stmt->execute();
    $limitCaptureIds[] = (int)$limitDb->lastInsertRowID();
}
$limitDb->exec('UPDATE captures SET folder_id=NULL WHERE id=' . $limitCaptureIds[4]);
$segmentInsert = $limitDb->prepare(
    'INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,started_offset,'
    . 'started_timezone,birds_generation,start_sequence,stopped_local,stopped_at_utc,stopped_epoch,'
    . 'stopped_offset,stopped_timezone) VALUES(:capture,:local,:utc,:epoch,'
    . "'+00:00','UTC',:generation,0,:stoplocal,:stoputc,:stopped,'+00:00','UTC')"
);
$limitDb->exec('BEGIN');
for ($segmentIndex = 0; $segmentIndex < AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS; $segmentIndex++) {
    $epoch = $limitBaseEpoch + ($segmentIndex * 2);
    $local = gmdate('Y-m-d H:i:s', $epoch);
    $utc = gmdate('Y-m-d\TH:i:s\Z', $epoch);
    $segmentInsert->bindValue(':capture', $limitCaptureIds[0], SQLITE3_INTEGER);
    $segmentInsert->bindValue(':local', $local, SQLITE3_TEXT);
    $segmentInsert->bindValue(':utc', $utc, SQLITE3_TEXT);
    $segmentInsert->bindValue(':epoch', $epoch, SQLITE3_INTEGER);
    $segmentInsert->bindValue(':generation', $generation, SQLITE3_TEXT);
    $segmentInsert->bindValue(':stoplocal', gmdate('Y-m-d H:i:s', $epoch + 1), SQLITE3_TEXT);
    $segmentInsert->bindValue(':stoputc', gmdate('Y-m-d\TH:i:s\Z', $epoch + 1), SQLITE3_TEXT);
    $segmentInsert->bindValue(':stopped', $epoch + 1, SQLITE3_INTEGER);
    $segmentInsert->execute();
    $segmentInsert->reset();
}
$limitDb->exec('COMMIT');
$overBudgetCapture = educator_store_one($limitDb, 'SELECT * FROM captures WHERE id=:id', [
    ':id' => $limitCaptureIds[0],
]);
$overBudgetCounts = educator_capture_page_counts($limitDb, [$overBudgetCapture]);
edu_check($overBudgetCounts[$limitCaptureIds[0]] === [
    'detection_count' => null,
    'species_count' => null,
], 'capture counts become explicit nulls once the 256-segment poll budget is exceeded');
$smallCountCaptureId = $limitCaptureIds[4];
$limitDb->exec(
    'INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,started_offset,'
    . 'started_timezone,birds_generation,start_sequence,stopped_local,stopped_at_utc,stopped_epoch,'
    . 'stopped_offset,stopped_timezone,revision) SELECT ' . $smallCountCaptureId
    . ',started_local,started_at_utc,started_epoch,started_offset,started_timezone,birds_generation,'
    . 'start_sequence,stopped_local,stopped_at_utc,stopped_epoch,stopped_offset,stopped_timezone,revision '
    . 'FROM capture_segments WHERE capture_id=' . $limitCaptureIds[0] . ' ORDER BY id LIMIT 1'
);
$overBudgetPublicId = (string)$limitDb->querySingle(
    'SELECT public_id FROM captures WHERE id=' . $limitCaptureIds[0]
);
$smallCountPublicId = (string)$limitDb->querySingle(
    'SELECT public_id FROM captures WHERE id=' . $smallCountCaptureId
);
$isolatedBudgetCounts = educator_store_capture_counts(
    $limitDb,
    [$overBudgetPublicId, $smallCountPublicId],
    educator_state_revision($limitDb)
);
edu_check($isolatedBudgetCounts[$overBudgetPublicId]['detection_count'] === null
    && $isolatedBudgetCounts[$overBudgetPublicId]['species_count'] === null
    && $isolatedBudgetCounts[$smallCountPublicId]['detection_count'] === 0
    && $isolatedBudgetCounts[$smallCountPublicId]['species_count'] === 0,
    'one capture exhausting the 256-segment budget does not blank another capture in its batch');
$limitDb->exec('DELETE FROM capture_segments WHERE capture_id=' . $smallCountCaptureId);
$exactBudgetCaptureId = $limitCaptureIds[1];
$limitDb->exec(
    'INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,started_offset,'
    . 'started_timezone,birds_generation,start_sequence,stopped_local,stopped_at_utc,stopped_epoch,'
    . 'stopped_offset,stopped_timezone,revision) SELECT ' . $exactBudgetCaptureId
    . ',started_local,started_at_utc,started_epoch,started_offset,started_timezone,birds_generation,'
    . 'start_sequence,stopped_local,stopped_at_utc,stopped_epoch,stopped_offset,stopped_timezone,revision '
    . 'FROM capture_segments WHERE capture_id=' . $limitCaptureIds[0]
    . ' ORDER BY id LIMIT ' . AVIAN_EDUCATOR_COUNT_MAX_SEGMENTS
);
$exactBudgetPublicId = (string)$limitDb->querySingle(
    'SELECT public_id FROM captures WHERE id=' . $exactBudgetCaptureId
);
$exactBudgetCounts = educator_store_capture_counts(
    $limitDb,
    [$exactBudgetPublicId],
    educator_state_revision($limitDb)
);
edu_check($exactBudgetCounts[$exactBudgetPublicId]['detection_count'] === 0
    && $exactBudgetCounts[$exactBudgetPublicId]['species_count'] === 0,
    'a capture at the exact 256-segment count budget remains countable');
$limitDb->exec('DELETE FROM capture_segments WHERE capture_id=' . $exactBudgetCaptureId);
edu_check(count(educator_scope_segments($limitDb, 'capture', $limitCaptureIds[0]))
    === AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS,
    'capture scope accepts the exact classroom-safe segment limit');
edu_throws(fn() => educator_insert_segment($limitDb, $limitCaptureIds[0], [
    'local' => '2026-01-01 02:00:00', 'utc' => '2026-01-01T02:00:00Z',
    'epoch' => 7200, 'offset' => '+00:00', 'timezone' => 'UTC',
], 0, $generation), 409, 'pause and resume cannot exceed the per-capture segment limit');
for ($copyIndex = 1; $copyIndex < 4; $copyIndex++) {
    $limitDb->exec(
        'INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,started_offset,'
        . 'started_timezone,birds_generation,start_sequence,stopped_local,stopped_at_utc,stopped_epoch,'
        . 'stopped_offset,stopped_timezone,revision) SELECT ' . $limitCaptureIds[$copyIndex]
        . ',started_local,started_at_utc,started_epoch,started_offset,started_timezone,birds_generation,'
        . 'start_sequence,stopped_local,stopped_at_utc,stopped_epoch,stopped_offset,stopped_timezone,revision '
        . 'FROM capture_segments WHERE capture_id=' . $limitCaptureIds[0]
    );
}
edu_check(count(educator_scope_segments($limitDb, 'folder', $limitFolderInternal))
    === AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS,
    'folder scope accepts the exact bounded aggregation limit');
edu_throws(fn() => educator_assert_folder_segment_capacity($limitDb, $limitFolderInternal, 1), 409,
    'mutations cannot make a folder exceed its scoped segment limit');
$limitDb->exec('UPDATE captures SET folder_id=' . $limitFolderInternal . ' WHERE id=' . $limitCaptureIds[4]);
$limitDb->exec(
    'INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,started_offset,'
    . 'started_timezone,birds_generation,start_sequence,stopped_local,stopped_at_utc,stopped_epoch,'
    . "stopped_offset,stopped_timezone) VALUES(" . $limitCaptureIds[4]
    . ",'2026-01-01 00:00:00','2026-01-01T00:00:00Z',1767225600,'+00:00','UTC','" . $generation
    . "',0,'2026-01-01 00:00:01','2026-01-01T00:00:01Z',1767225601,'+00:00','UTC')"
);
edu_throws(fn() => educator_scope_segments($limitDb, 'folder', $limitFolderInternal), 413,
    'folder aggregation fails honestly one segment above its bounded limit');
for ($folderIndex = 2; $folderIndex <= AVIAN_EDUCATOR_MAX_FOLDERS; $folderIndex++) {
    $folderId = 'f_' . str_pad(dechex($folderIndex), 32, '0', STR_PAD_LEFT);
    $folderStmt = $limitDb->prepare(
        'INSERT INTO folders(public_id,name,created_at_utc,updated_at_utc) '
        . "VALUES(:id,:name,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')"
    );
    $folderStmt->bindValue(':id', $folderId, SQLITE3_TEXT);
    $folderStmt->bindValue(':name', 'Folder ' . $folderIndex, SQLITE3_TEXT);
    $folderStmt->execute();
}
$boundedSnapshotJson = json_encode(educator_store_snapshot($limitDb), JSON_THROW_ON_ERROR);
edu_check((int)$limitDb->querySingle('SELECT COUNT(*) FROM folders') === AVIAN_EDUCATOR_MAX_FOLDERS
    && strlen($boundedSnapshotJson) < 262144,
    'the exact folder limit keeps a full state snapshot under 256 KiB');
edu_throws(fn() => educator_store_create_folder(
    $limitDb,
    'One folder too many',
    educator_state_revision($limitDb)
), 409, 'folder creation fails transactionally at the fixed folder limit');
$limitDb->exec("DELETE FROM educator_meta WHERE key='state_revision'");
edu_throws(fn() => educator_state_revision($limitDb), 503,
    'missing state revision metadata fails closed instead of aliasing revision zero');
$limitDb->close();

$performanceBirds = new SQLite3(':memory:');
$performanceBirds->enableExceptions(true);
$performanceBirds->exec(
    'CREATE TABLE detections(Date TEXT,Time TEXT,Sci_Name TEXT NOT NULL,Com_Name TEXT NOT NULL,'
    . 'Confidence REAL,Lat REAL,Lon REAL,Cutoff REAL,Week INTEGER,Sens REAL,Overlap REAL,File_Name TEXT NOT NULL);'
    . 'CREATE INDEX detections_Date_Time ON detections(Date DESC,Time DESC);'
    . "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100000) "
    . "INSERT INTO detections(Date,Time,Sci_Name,Com_Name,Confidence,File_Name) "
    . "SELECT CASE WHEN x>99900 THEN '2026-01-02' ELSE '2020-01-01' END,"
    . "printf('%02d:%02d:%02d',(x/3600)%24,(x/60)%60,x%60),'Avis testus','Test Bird',0.9,"
    . "printf('test-%d.mp3',x) FROM n;"
);
edu_install_sequence($performanceBirds);
$performanceBirds->exec(
    'CREATE TEMP TABLE detections(detection_id INTEGER PRIMARY KEY,Date DATE,Time TIME,'
    . 'Sci_Name TEXT NOT NULL,Com_Name TEXT NOT NULL,Confidence REAL,Lat REAL,Lon REAL,'
    . 'Cutoff REAL,Week INTEGER,Sens REAL,Overlap REAL,File_Name TEXT NOT NULL)'
);
$planStmt = $performanceBirds->prepare('EXPLAIN QUERY PLAN ' . educator_scope_materialize_sql(true));
foreach ([
    ':sequence' => 0,
    ':started_date' => '2026-01-02',
    ':started_time' => '00:00:00',
    ':stopped_date' => '2026-01-03',
    ':stopped_time' => '00:00:00',
    ':scope_limit' => AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS + 1,
] as $key => $value) $planStmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
$planRows = [];
$planResult = $planStmt->execute();
while ($planRow = $planResult->fetchArray(SQLITE3_ASSOC)) $planRows[] = (string)$planRow['detail'];
$planResult->finalize();
$planStmt->close();
$indexedInsert = $performanceBirds->prepare(educator_scope_materialize_sql(true));
foreach ([
    ':sequence' => 0,
    ':started_date' => '2026-01-02',
    ':started_time' => '00:00:00',
    ':stopped_date' => '2026-01-03',
    ':stopped_time' => '00:00:00',
    ':scope_limit' => AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS + 1,
] as $key => $value) $indexedInsert->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
$indexedStarted = microtime(true);
$indexedResult = $indexedInsert->execute();
$indexedResult->finalize();
$indexedInsert->close();
$indexedElapsed = microtime(true) - $indexedStarted;
$scopePlanText = implode(' | ', $planRows);
edu_check(str_contains($scopePlanText, 'SEARCH d USING INDEX detections_Date_Time')
    && str_contains($scopePlanText, '(Date,Time)')
    && (int)$performanceBirds->querySingle('SELECT COUNT(*) FROM temp.detections') === 100
    && $indexedElapsed < 5.0,
    '100,000-row scope materialization is Date/Time-indexed and visits only the requested interval');
$performanceBirds->exec('DROP TABLE temp.detections');
$performanceBirds->exec('CREATE TEMP TABLE educator_count_hits('
    . 'capture_id INTEGER NOT NULL,detection_id INTEGER NOT NULL,sci_name TEXT NOT NULL,'
    . 'PRIMARY KEY(capture_id,detection_id)) WITHOUT ROWID');
$countPlanStmt = $performanceBirds->prepare(
    'EXPLAIN QUERY PLAN ' . educator_capture_count_materialize_sql(true)
);
foreach ([
    ':capture' => 1,
    ':sequence' => 0,
    ':started_date' => '2026-01-02',
    ':started_time' => '00:00:00',
    ':stopped_date' => '2026-01-03',
    ':stopped_time' => '00:00:00',
    ':hit_limit' => AVIAN_EDUCATOR_COUNT_MAX_HITS + 1,
] as $key => $value) $countPlanStmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
$countPlanRows = [];
$countPlanResult = $countPlanStmt->execute();
while ($countPlanRow = $countPlanResult->fetchArray(SQLITE3_ASSOC)) {
    $countPlanRows[] = (string)$countPlanRow['detail'];
}
$countPlanResult->finalize();
$countPlanStmt->close();
$countPlanText = implode(' | ', $countPlanRows);
edu_check(str_contains($countPlanText, 'SEARCH d USING INDEX detections_Date_Time')
    && str_contains($countPlanText, '(Date,Time)'),
    'capture count materialization is pinned to the same Date/Time interval index');
$routineStarted = microtime(true);
for ($routineCheck = 0; $routineCheck < 20; $routineCheck++) {
    $routineFloor = educator_birds_sequence_authority($performanceBirds, false);
}
$routineElapsed = microtime(true) - $routineStarted;
$fullStarted = microtime(true);
$fullFloor = educator_birds_sequence_authority($performanceBirds, true);
$fullElapsed = microtime(true) - $fullStarted;
edu_check($routineFloor === 100000 && $fullFloor === 100000 && $routineElapsed < $fullElapsed,
    'twenty routine sequence checks stay cheaper than one full 100,000-row restore validation');
$performanceBirds->exec('DROP INDEX detections_Date_Time;'
    . 'CREATE INDEX detections_Date_Time ON detections(Time DESC,Date DESC)');
edu_throws(fn() => educator_birds_sequence_authority($performanceBirds, false), 503,
    'a missing or malformed canonical Date/Time index fails routine scopes closed');
$performanceBirds->close();

$store->close();
$birds->close();

// Remove only this test's random, validated directory tree.
$remove = function (string $path) use (&$remove): void {
    if (is_dir($path) && !is_link($path)) {
        foreach (scandir($path) ?: [] as $entry) {
            if ($entry !== '.' && $entry !== '..') $remove($path . '/' . $entry);
        }
        rmdir($path);
    } elseif (file_exists($path) || is_link($path)) {
        unlink($path);
    }
};
$remove($tmp);
foreach ([
    'AV_EDUCATOR_STORE_FILE', 'AV_EDUCATOR_LOCK_FILE', 'AV_EDUCATOR_STATE_FILE',
    'AV_EDUCATOR_BIRDS_DB', 'AV_EDUCATOR_STORE_TEST_METADATA',
    'AV_EDUCATOR_STATE_TEST_METADATA', 'AVIAN_STATION_TIMEZONE',
    'AV_EDUCATOR_NOW', 'AVIAN_EXTRACTED_ROOT', 'AV_ADMIN_STATE_FILE',
    'AV_ADMIN_STATE_TEST_METADATA', 'AV_REQUIRE_AUTH', 'AV_EDUCATOR_LOCK_FD',
] as $name) putenv($name);

if ($failures > 0) {
    fwrite(STDERR, "$failures of $checks educator backend checks failed\n");
    exit(1);
}
echo "educator backend tests passed ($checks checks)\n";
