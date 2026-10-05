<?php
// SQLite metadata store for bounded Educators listening captures.

declare(strict_types=1);

const AVIAN_EDUCATOR_STORE_DEFAULT_PATH = '/var/lib/avian-visitors/educators/educators.db';
const AVIAN_EDUCATOR_LOCK_DEFAULT_PATH = '/var/lib/avian-visitors/educators.lock';
const AVIAN_EDUCATOR_SCHEMA_VERSION = 1;
const AVIAN_EDUCATOR_APPLICATION_ID = 1096172868; // "AVED"
const AVIAN_EDUCATOR_NAME_MAX_CHARS = 80;
const AVIAN_EDUCATOR_NAME_MAX_BYTES = 256;
const AVIAN_EDUCATOR_STORE_MAX_BYTES = 536870912;
const AVIAN_EDUCATOR_WAL_MAX_BYTES = 134217728;
const AVIAN_EDUCATOR_SHM_MAX_BYTES = 16777216;
const AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS = 2048;
const AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS = 8192;
const AVIAN_EDUCATOR_MAX_FOLDERS = 256;
const AVIAN_EDUCATOR_COUNT_MAX_SEGMENTS = 256;
const AVIAN_EDUCATOR_COUNT_MAX_HITS = 100000;
const AVIAN_EDUCATOR_COUNT_BATCH_MAX = 8;
const AVIAN_DETECTION_SEQUENCE_TABLE = 'avian_detection_sequence';
const AVIAN_DETECTION_SEQUENCE_INSERT_TRIGGER = 'avian_detection_sequence_insert';
const AVIAN_DETECTION_SEQUENCE_DELETE_TRIGGER = 'avian_detection_sequence_delete';
const AVIAN_DETECTION_SEQUENCE_UPDATE_TRIGGER = 'avian_detection_sequence_update';

final class EducatorStoreError extends RuntimeException {
    public int $httpStatus;
    public array $details;

    public function __construct(string $message, int $httpStatus = 400, array $details = []) {
        parent::__construct($message);
        $this->httpStatus = $httpStatus;
        $this->details = $details;
    }
}

function educator_store_path(): string {
    $override = getenv('AV_EDUCATOR_STORE_FILE');
    return PHP_SAPI === 'cli' && is_string($override) && $override !== ''
        ? $override
        : AVIAN_EDUCATOR_STORE_DEFAULT_PATH;
}

function educator_lock_path(): string {
    $override = getenv('AV_EDUCATOR_LOCK_FILE');
    return PHP_SAPI === 'cli' && is_string($override) && $override !== ''
        ? $override
        : AVIAN_EDUCATOR_LOCK_DEFAULT_PATH;
}

function educator_store_test_metadata(): bool {
    return PHP_SAPI === 'cli' && getenv('AV_EDUCATOR_STORE_TEST_METADATA') === '1';
}

function educator_caddy_identity(): ?array {
    if (!function_exists('posix_getpwnam') || !function_exists('posix_getgrnam')) return null;
    $user = posix_getpwnam('caddy');
    $group = posix_getgrnam('caddy');
    if (!is_array($user) || !isset($user['uid']) || !is_array($group) || !isset($group['gid'])) {
        return null;
    }
    return ['uid' => (int)$user['uid'], 'gid' => (int)$group['gid']];
}

function educator_store_file_metadata_valid(array $stat): bool {
    if (educator_store_test_metadata()) return true;
    $identity = educator_caddy_identity();
    return is_array($identity)
        && (($stat['mode'] ?? 0) & 0170000) === 0100000
        && (int)($stat['uid'] ?? -1) === $identity['uid']
        && (int)($stat['gid'] ?? -1) === $identity['gid']
        && (($stat['mode'] ?? 0) & 0777) === 0660
        && (int)($stat['nlink'] ?? 0) === 1;
}

function educator_store_parent_metadata_valid(string $path): bool {
    if (educator_store_test_metadata()) return true;
    $identity = educator_caddy_identity();
    $stat = @lstat(dirname($path));
    return is_array($identity) && is_array($stat)
        && (($stat['mode'] ?? 0) & 0170000) === 0040000
        && (int)($stat['uid'] ?? -1) === 0
        && (int)($stat['gid'] ?? -1) === $identity['gid']
        && (($stat['mode'] ?? 0) & 0777) === 0770;
}

function educator_lock_metadata_valid(array $stat): bool {
    if (educator_store_test_metadata()) return true;
    $identity = educator_caddy_identity();
    return is_array($identity)
        && (($stat['mode'] ?? 0) & 0170000) === 0100000
        && (int)($stat['uid'] ?? -1) === 0
        && (int)($stat['gid'] ?? -1) === $identity['gid']
        && (($stat['mode'] ?? 0) & 0777) === 0660
        && (int)($stat['nlink'] ?? 0) === 1;
}

/** @return resource */
function educator_store_lock(bool $exclusive = true) {
    $path = educator_lock_path();
    $inherited = PHP_SAPI === 'cli' ? getenv('AV_EDUCATOR_LOCK_FD') : false;
    if ($inherited !== false && (!is_string($inherited)
        || preg_match('/\A(?:[3-9]|[1-9][0-9]{1,3})\z/D', $inherited) !== 1
        || (int)$inherited > 1024)) {
        throw new EducatorStoreError('inherited educator lock is invalid', 503);
    }
    if (is_string($inherited)) {
        $resolved = @readlink('/proc/self/fd/' . $inherited);
        if (!is_string($resolved) || realpath($path) !== realpath($resolved)) {
            throw new EducatorStoreError('inherited educator lock is invalid', 503);
        }
        $handle = @fopen('php://fd/' . $inherited, 'r+');
        $opened = is_resource($handle) ? fstat($handle) : false;
        if (!is_resource($handle) || !is_array($opened) || !educator_lock_metadata_valid($opened)) {
            if (is_resource($handle)) fclose($handle);
            throw new EducatorStoreError('inherited educator lock is unsafe', 503);
        }
        $GLOBALS['avian_educator_inherited_locks'][get_resource_id($handle)] = true;
        return $handle;
    }

    clearstatcache(true, $path);
    $before = @lstat($path);
    if (!is_array($before) || !educator_lock_metadata_valid($before)) {
        throw new EducatorStoreError('educator lock is missing or unsafe', 503);
    }
    $handle = @fopen($path, 'r+');
    if (!is_resource($handle)) throw new EducatorStoreError('educator lock is unreadable', 503);
    $opened = fstat($handle);
    clearstatcache(true, $path);
    $after = @lstat($path);
    if (!is_array($opened) || !is_array($after)
        || !educator_lock_metadata_valid($opened)
        || (int)$opened['dev'] !== (int)$before['dev']
        || (int)$opened['ino'] !== (int)$before['ino']
        || (int)$after['dev'] !== (int)$before['dev']
        || (int)$after['ino'] !== (int)$before['ino']) {
        fclose($handle);
        throw new EducatorStoreError('educator lock changed while opening', 503);
    }
    if (!@flock($handle, $exclusive ? LOCK_EX : LOCK_SH)) {
        fclose($handle);
        throw new EducatorStoreError('educator lock is unavailable', 503);
    }
    return $handle;
}

function educator_store_unlock($handle): void {
    if (!is_resource($handle)) return;
    $resourceId = get_resource_id($handle);
    $inherited = !empty($GLOBALS['avian_educator_inherited_locks'][$resourceId]);
    unset($GLOBALS['avian_educator_inherited_locks'][$resourceId]);
    if (!$inherited) @flock($handle, LOCK_UN);
    @fclose($handle);
}

function educator_store_validate_existing_path(string $path): void {
    if (!educator_store_parent_metadata_valid($path)) {
        throw new EducatorStoreError('educator data directory is unsafe', 503);
    }
    clearstatcache(true, $path);
    $before = @lstat($path);
    if (!is_array($before) || !educator_store_file_metadata_valid($before)
        || (int)($before['size'] ?? -1) < 0
        || (int)($before['size'] ?? -1) > AVIAN_EDUCATOR_STORE_MAX_BYTES) {
        throw new EducatorStoreError('educator data store is missing or unsafe', 503);
    }
}

function educator_store_validate_sidecars(string $path): void {
    foreach ([$path . '-wal' => AVIAN_EDUCATOR_WAL_MAX_BYTES, $path . '-shm' => AVIAN_EDUCATOR_SHM_MAX_BYTES] as $sidecar => $maxBytes) {
        clearstatcache(true, $sidecar);
        $stat = @lstat($sidecar);
        if ($stat !== false && (!is_array($stat) || !educator_store_file_metadata_valid($stat)
            || (int)($stat['size'] ?? -1) < 0 || (int)($stat['size'] ?? -1) > $maxBytes)) {
            throw new EducatorStoreError('educator data store sidecar is unsafe', 503);
        }
    }
}

function educator_store_schema(SQLite3 $db): void {
    $sql = <<<'SQL'
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS educator_meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
) WITHOUT ROWID;
INSERT OR IGNORE INTO educator_meta(key, value) VALUES ('state_revision', 0);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS folder_names_unique
ON folders(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS captures (
    id INTEGER PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','paused','stopped')),
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    started_local TEXT NOT NULL,
    started_at_utc TEXT NOT NULL,
    started_epoch INTEGER NOT NULL,
    started_offset TEXT NOT NULL,
    started_timezone TEXT NOT NULL,
    stopped_local TEXT,
    stopped_at_utc TEXT,
    stopped_epoch INTEGER,
    stopped_offset TEXT,
    stopped_timezone TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL,
    CHECK(stopped_epoch IS NULL OR stopped_epoch >= started_epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_capture
ON captures((1)) WHERE status IN ('running','paused');
CREATE INDEX IF NOT EXISTS captures_by_folder
ON captures(folder_id, started_epoch DESC);
CREATE TABLE IF NOT EXISTS capture_segments (
    id INTEGER PRIMARY KEY,
    capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    started_local TEXT NOT NULL,
    started_at_utc TEXT NOT NULL,
    started_epoch INTEGER NOT NULL,
    started_offset TEXT NOT NULL,
    started_timezone TEXT NOT NULL,
    birds_generation TEXT NOT NULL CHECK(length(birds_generation)=32),
    start_sequence INTEGER NOT NULL CHECK(typeof(start_sequence)='integer' AND start_sequence >= 0),
    stopped_local TEXT,
    stopped_at_utc TEXT,
    stopped_epoch INTEGER,
    stopped_offset TEXT,
    stopped_timezone TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    CHECK(stopped_epoch IS NULL OR stopped_epoch >= started_epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_segment_per_capture
ON capture_segments(capture_id) WHERE stopped_epoch IS NULL;
CREATE INDEX IF NOT EXISTS segments_by_capture
ON capture_segments(capture_id, started_epoch);
PRAGMA user_version = 1;
SQL;
    if (!$db->exec($sql)) {
        throw new EducatorStoreError('educator schema migration failed', 503);
    }
}

function educator_store_open(bool $initialize = false): SQLite3 {
    $path = educator_store_path();
    if (!$initialize) educator_store_validate_existing_path($path);
    elseif (!educator_store_parent_metadata_valid($path)) {
        throw new EducatorStoreError('educator data directory is unsafe', 503);
    }
    educator_store_validate_sidecars($path);
    $before = @lstat($path);
    $probe = null;
    if (is_array($before)) {
        $probe = @fopen($path, 'r+');
        $opened = is_resource($probe) ? fstat($probe) : false;
        if (!is_array($opened)
            || (int)$opened['dev'] !== (int)$before['dev']
            || (int)$opened['ino'] !== (int)$before['ino']
            || !educator_store_file_metadata_valid($opened)) {
            if (is_resource($probe)) fclose($probe);
            throw new EducatorStoreError('educator data store changed while opening', 503);
        }
    }
    $oldUmask = umask(0007);
    try {
        $db = new SQLite3($path, SQLITE3_OPEN_READWRITE | SQLITE3_OPEN_CREATE);
    } catch (Throwable $error) {
        umask($oldUmask);
        if (is_resource($probe)) fclose($probe);
        throw new EducatorStoreError('educator data store could not be opened', 503);
    }
    umask($oldUmask);
    $db->busyTimeout(5000);
    $db->enableExceptions(true);
    try {
        if ($initialize) @chmod($path, 0660);
        clearstatcache(true, $path);
        $after = @lstat($path);
        if (!is_array($after) || !educator_store_file_metadata_valid($after)
            || (int)($after['size'] ?? -1) < 0
            || (int)($after['size'] ?? -1) > AVIAN_EDUCATOR_STORE_MAX_BYTES
            || (is_array($before) && ((int)$after['dev'] !== (int)$before['dev']
                || (int)$after['ino'] !== (int)$before['ino']))) {
            throw new EducatorStoreError('educator data store changed while opening', 503);
        }
        $db->exec('PRAGMA foreign_keys = ON');
        $db->exec('PRAGMA journal_mode = WAL');
        $db->exec('PRAGMA synchronous = FULL');
        if ($initialize) {
            $applicationId = (int)$db->querySingle('PRAGMA application_id');
            if ($applicationId === 0) $db->exec('PRAGMA application_id = ' . AVIAN_EDUCATOR_APPLICATION_ID);
            educator_store_schema($db);
        }
        $version = (int)$db->querySingle('PRAGMA user_version');
        $applicationId = (int)$db->querySingle('PRAGMA application_id');
        if ($version !== AVIAN_EDUCATOR_SCHEMA_VERSION) {
            throw new EducatorStoreError('educator data store needs migration', 503);
        }
        if ($applicationId !== AVIAN_EDUCATOR_APPLICATION_ID) {
            throw new EducatorStoreError('educator data store belongs to another application', 503);
        }
        foreach ([$path . '-wal', $path . '-shm'] as $sidecar) {
            if (file_exists($sidecar)) @chmod($sidecar, 0660);
        }
        educator_store_validate_sidecars($path);
    } catch (Throwable $error) {
        $db->close();
        if (is_resource($probe)) fclose($probe);
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('educator data store is invalid', 503);
    }
    if (is_resource($probe)) fclose($probe);
    return $db;
}

function educator_store_rows(SQLite3 $db, string $sql, array $bind = []): array {
    $stmt = $db->prepare($sql);
    foreach ($bind as $key => $value) {
        $type = is_int($value) ? SQLITE3_INTEGER : ($value === null ? SQLITE3_NULL : SQLITE3_TEXT);
        $stmt->bindValue($key, $value, $type);
    }
    $result = $stmt->execute();
    $rows = [];
    while ($row = $result->fetchArray(SQLITE3_ASSOC)) $rows[] = $row;
    return $rows;
}

function educator_store_one(SQLite3 $db, string $sql, array $bind = []): ?array {
    return educator_store_rows($db, $sql, $bind)[0] ?? null;
}

function educator_state_revision(SQLite3 $db): int {
    try {
        $stmt = $db->prepare("SELECT value FROM educator_meta WHERE key='state_revision'");
        $result = $stmt->execute();
        $first = $result->fetchArray(SQLITE3_NUM);
        $second = $result->fetchArray(SQLITE3_NUM);
        $value = is_array($first) ? ($first[0] ?? null) : null;
        if (!is_int($value) || $value < 0 || $value > 2147483647 || $second !== false) {
            throw new EducatorStoreError('educator state revision is invalid', 503);
        }
        return $value;
    } catch (Throwable $error) {
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('educator state revision is unavailable', 503);
    }
}

function educator_expect_state_revision(SQLite3 $db, int $expected): void {
    $actual = educator_state_revision($db);
    if ($expected !== $actual) {
        throw new EducatorStoreError('educator state changed in another window', 409, [
            'state_revision' => $actual,
        ]);
    }
}

function educator_bump_state_revision(SQLite3 $db): int {
    $db->exec("UPDATE educator_meta SET value=value+1 WHERE key='state_revision'");
    return educator_state_revision($db);
}

function educator_valid_public_id(string $value, string $kind = ''): bool {
    $prefix = $kind === 'capture' ? 'c' : ($kind === 'folder' ? 'f' : '[cf]');
    return preg_match('/\A' . $prefix . '_[a-f0-9]{32}\z/D', $value) === 1;
}

function educator_new_public_id(string $prefix): string {
    return $prefix . '_' . bin2hex(random_bytes(16));
}

function educator_valid_name($value): ?string {
    if (!is_string($value)) return null;
    $name = trim($value);
    if ($name === '' || strlen($name) > AVIAN_EDUCATOR_NAME_MAX_BYTES) return null;
    if (preg_match('//u', $name) !== 1) return null;
    $chars = function_exists('mb_strlen') ? mb_strlen($name, 'UTF-8') : preg_match_all('/./us', $name);
    if (!is_int($chars) || $chars < 1 || $chars > AVIAN_EDUCATOR_NAME_MAX_CHARS) return null;
    if (preg_match('/\A[\p{Z}\s]*\z/u', $name) === 1) return null;
    if (preg_match('/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', $name) === 1) return null;
    return $name;
}

function educator_name_key(string $name): string {
    return function_exists('mb_strtolower') ? mb_strtolower($name, 'UTF-8') : strtolower($name);
}

function educator_assert_folder_name_available(SQLite3 $db, string $name, ?int $exceptId = null): void {
    $wanted = educator_name_key($name);
    foreach (educator_store_rows($db, 'SELECT id,name FROM folders') as $row) {
        if (($exceptId === null || (int)$row['id'] !== $exceptId)
            && educator_name_key((string)$row['name']) === $wanted) {
            throw new EducatorStoreError('a folder already uses that name', 409);
        }
    }
}

function educator_station_timezone(): DateTimeZone {
    $configured = getenv('AVIAN_STATION_TIMEZONE');
    if (!is_string($configured) || $configured === '' || strlen($configured) > 128
        || preg_match('~\A[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*\z~D', $configured) !== 1) {
        throw new EducatorStoreError('station timezone is unavailable', 503);
    }
    try {
        return new DateTimeZone($configured);
    } catch (Throwable $error) {
        throw new EducatorStoreError('station timezone is invalid', 503);
    }
}

function educator_clock(DateTimeZone $zone): DateTimeImmutable {
    $override = PHP_SAPI === 'cli' ? getenv('AV_EDUCATOR_NOW') : false;
    if (is_string($override) && $override !== '') {
        try {
            return (new DateTimeImmutable($override))->setTimezone($zone);
        } catch (Throwable $error) {
            throw new EducatorStoreError('test clock is invalid', 503);
        }
    }
    return new DateTimeImmutable('now', $zone);
}

function educator_store_test_hook(string $phase): void {
    $hook = $GLOBALS['AVIAN_EDUCATOR_TEST_HOOK'] ?? null;
    if (PHP_SAPI === 'cli' && $hook instanceof Closure) $hook($phase);
}

/** @return array{local:string,utc:string,epoch:int,offset:string,timezone:string} */
function educator_now(): array {
    $zone = educator_station_timezone();
    $local = educator_clock($zone);
    return [
        'local' => $local->format('Y-m-d H:i:s'),
        'utc' => $local->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
        'epoch' => $local->getTimestamp(),
        'offset' => $local->format('P'),
        'timezone' => $zone->getName(),
    ];
}

function educator_time_is_repeated(DateTimeImmutable $local, DateTimeZone $zone): bool {
    $epoch = $local->getTimestamp();
    $transitions = $zone->getTransitions($epoch - 86400, $epoch + 86400);
    if (!is_array($transitions) || count($transitions) < 2) return false;
    $previousOffset = (int)$transitions[0]['offset'];
    $wallEpoch = $epoch + (int)$local->format('Z');
    foreach (array_slice($transitions, 1) as $transition) {
        $nextOffset = (int)$transition['offset'];
        $transitionEpoch = (int)$transition['ts'];
        if ($nextOffset < $previousOffset
            && $wallEpoch >= $transitionEpoch + $nextOffset
            && $wallEpoch < $transitionEpoch + $previousOffset) {
            return true;
        }
        $previousOffset = $nextOffset;
    }
    return false;
}

function educator_capture_now(?array $capture = null): array {
    $zone = educator_station_timezone();
    $local = educator_clock($zone);
    if (educator_time_is_repeated($local, $zone)) {
        throw new EducatorStoreError('wait until the repeated daylight-saving hour ends', 409);
    }
    if ($capture !== null && !hash_equals((string)$capture['started_timezone'], $zone->getName())) {
        throw new EducatorStoreError(
            'station timezone changed; disable Educators mode to safely close this capture',
            409
        );
    }
    return [
        'local' => $local->format('Y-m-d H:i:s'),
        'utc' => $local->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
        'epoch' => $local->getTimestamp(),
        'offset' => $local->format('P'),
        'timezone' => $zone->getName(),
    ];
}

function educator_birds_db_path(): string {
    $override = getenv('AV_EDUCATOR_BIRDS_DB');
    return PHP_SAPI === 'cli' && is_string($override) && $override !== ''
        ? $override
        : dirname(__DIR__, 2) . '/scripts/birds.db';
}

function educator_birds_snapshot(): array {
    $path = educator_birds_db_path();
    if (!is_file($path) || is_link($path)) {
        throw new EducatorStoreError('detections database is unavailable', 503);
    }
    $db = null;
    try {
        $db = new SQLite3($path, SQLITE3_OPEN_READONLY);
        $db->busyTimeout(2000);
        $db->exec('BEGIN');
        $generation = educator_birds_generation_from_db($db);
        $sequence = educator_birds_sequence_authority($db, true);
        $db->exec('COMMIT');
        $db->close();
        $db = null;
        return ['generation' => $generation, 'sequence' => $sequence];
    } catch (Throwable $error) {
        if ($db instanceof SQLite3) {
            try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
            try { $db->close(); } catch (Throwable $ignored) {}
        }
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('detections database is unavailable', 503);
    }
}

function educator_sql_signature(string $sql): string {
    $signature = strtolower((string)preg_replace('/\s+/', '', trim($sql, " \t\r\n;")));
    return (string)preg_replace('/\A(create(?:table|trigger))ifnotexists/', '$1', $signature);
}

function educator_detection_sequence_trigger_sql(string $action): string {
    if ($action === 'insert') {
        return 'CREATE TRIGGER ' . AVIAN_DETECTION_SEQUENCE_INSERT_TRIGGER
            . ' AFTER INSERT ON detections BEGIN INSERT INTO ' . AVIAN_DETECTION_SEQUENCE_TABLE
            . '(detection_rowid) VALUES(NEW.rowid); END';
    }
    if ($action === 'delete') {
        return 'CREATE TRIGGER ' . AVIAN_DETECTION_SEQUENCE_DELETE_TRIGGER
            . ' AFTER DELETE ON detections BEGIN DELETE FROM ' . AVIAN_DETECTION_SEQUENCE_TABLE
            . ' WHERE detection_rowid=OLD.rowid; END';
    }
    return 'CREATE TRIGGER ' . AVIAN_DETECTION_SEQUENCE_UPDATE_TRIGGER
        . ' AFTER UPDATE OF rowid ON detections BEGIN UPDATE ' . AVIAN_DETECTION_SEQUENCE_TABLE
        . ' SET detection_rowid=NEW.rowid WHERE detection_rowid=OLD.rowid; END';
}

/**
 * Validate the application-owned insertion sequence attached to BirdNET's
 * unmodified detections table. sqlite_sequence is the floor authority: unlike
 * MAX(detections.rowid), it never moves backwards after supported deletion.
 */
function educator_birds_sequence_authority(SQLite3 $db, bool $fullMapping = false): int {
    try {
        $dateTimeIndex = educator_store_one($db,
            "SELECT type,tbl_name FROM sqlite_master WHERE name='detections_Date_Time'"
        );
        $dateTimeColumns = array_values(array_filter(
            educator_store_rows($db, "PRAGMA main.index_xinfo('detections_Date_Time')"),
            fn(array $column): bool => (int)($column['key'] ?? 0) === 1
        ));
        $dateTimeListing = null;
        foreach (educator_store_rows($db, "PRAGMA main.index_list('detections')") as $listedIndex) {
            if (($listedIndex['name'] ?? null) === 'detections_Date_Time') $dateTimeListing = $listedIndex;
        }
        if (($dateTimeIndex['type'] ?? null) !== 'index'
            || ($dateTimeIndex['tbl_name'] ?? null) !== 'detections'
            || !is_array($dateTimeListing)
            || (int)($dateTimeListing['unique'] ?? 0) !== 0
            || (int)($dateTimeListing['partial'] ?? 1) !== 0
            || count($dateTimeColumns) !== 2
            || ($dateTimeColumns[0]['name'] ?? null) !== 'Date'
            || (int)($dateTimeColumns[0]['desc'] ?? 0) !== 1
            || strtoupper((string)($dateTimeColumns[0]['coll'] ?? '')) !== 'BINARY'
            || ($dateTimeColumns[1]['name'] ?? null) !== 'Time'
            || (int)($dateTimeColumns[1]['desc'] ?? 0) !== 1
            || strtoupper((string)($dateTimeColumns[1]['coll'] ?? '')) !== 'BINARY') {
            throw new EducatorStoreError('detections date/time index is unavailable', 503);
        }
        $table = educator_store_one($db,
            "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=:name",
            [':name' => AVIAN_DETECTION_SEQUENCE_TABLE]
        );
        $tableSql = is_array($table) ? ($table['sql'] ?? null) : null;
        if (($table['type'] ?? null) !== 'table'
            || ($table['tbl_name'] ?? null) !== AVIAN_DETECTION_SEQUENCE_TABLE
            || !is_string($tableSql)
            || preg_match('/\Acreatetable' . AVIAN_DETECTION_SEQUENCE_TABLE
                . '\(sequenceintegerprimarykeyautoincrement,detection_rowidintegernotnullunique\)\z/D',
                educator_sql_signature($tableSql)) !== 1) {
            throw new EducatorStoreError('detections sequence table is invalid', 503);
        }
        $columns = educator_store_rows($db, 'PRAGMA table_info(' . AVIAN_DETECTION_SEQUENCE_TABLE . ')');
        if (count($columns) !== 2
            || ($columns[0]['name'] ?? null) !== 'sequence'
            || strtoupper((string)($columns[0]['type'] ?? '')) !== 'INTEGER'
            || (int)($columns[0]['pk'] ?? 0) !== 1
            || ($columns[1]['name'] ?? null) !== 'detection_rowid'
            || strtoupper((string)($columns[1]['type'] ?? '')) !== 'INTEGER'
            || (int)($columns[1]['notnull'] ?? 0) !== 1
            || (int)($columns[1]['pk'] ?? 0) !== 0) {
            throw new EducatorStoreError('detections sequence columns are invalid', 503);
        }
        foreach (['insert', 'delete', 'update'] as $action) {
            $name = constant('AVIAN_DETECTION_SEQUENCE_' . strtoupper($action) . '_TRIGGER');
            $trigger = educator_store_one($db,
                "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=:name",
                [':name' => $name]
            );
            if (($trigger['type'] ?? null) !== 'trigger'
                || ($trigger['tbl_name'] ?? null) !== 'detections'
                || !is_string($trigger['sql'] ?? null)
                || !hash_equals(
                    educator_sql_signature(educator_detection_sequence_trigger_sql($action)),
                    educator_sql_signature((string)$trigger['sql'])
                )) {
                throw new EducatorStoreError('detections sequence trigger is invalid', 503);
            }
        }
        $last = educator_store_one($db, 'SELECT sequence,detection_rowid FROM '
            . AVIAN_DETECTION_SEQUENCE_TABLE . ' ORDER BY sequence DESC LIMIT 1');
        $max = $last['sequence'] ?? 0;
        if (!is_int($max) || $max < 0 || ($last !== null
            && (!is_int($last['detection_rowid'] ?? null) || $last['detection_rowid'] < 1))) {
            throw new EducatorStoreError('detections sequence rows are invalid', 503);
        }
        $sequenceRow = educator_store_one($db,
            'SELECT seq FROM sqlite_sequence WHERE name=:name',
            [':name' => AVIAN_DETECTION_SEQUENCE_TABLE]
        );
        $floor = $sequenceRow['seq'] ?? null;
        if ($floor === null && $max === 0 && $sequenceRow === null) $floor = 0;
        if (!is_int($max) || $max < 0 || !is_int($floor) || $floor < $max || $floor < 0) {
            throw new EducatorStoreError('detections sequence floor is invalid', 503);
        }
        if ($fullMapping) {
            $invalid = $db->querySingle('SELECT COUNT(*) FROM ' . AVIAN_DETECTION_SEQUENCE_TABLE
                . " WHERE typeof(sequence)!='integer' OR sequence<1 "
                . "OR typeof(detection_rowid)!='integer' OR detection_rowid<1");
            $missing = $db->querySingle('SELECT COUNT(*) FROM detections d LEFT JOIN '
                . AVIAN_DETECTION_SEQUENCE_TABLE . ' s ON s.detection_rowid=d.rowid WHERE s.sequence IS NULL');
            $extra = $db->querySingle('SELECT COUNT(*) FROM ' . AVIAN_DETECTION_SEQUENCE_TABLE
                . ' s LEFT JOIN detections d ON d.rowid=s.detection_rowid WHERE d.rowid IS NULL');
            if (!is_int($invalid) || !is_int($missing) || !is_int($extra)
                || $invalid !== 0 || $missing !== 0 || $extra !== 0) {
                throw new EducatorStoreError('detections sequence mapping is incomplete', 503);
            }
        }
        return $floor;
    } catch (Throwable $error) {
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('detections sequence authority is unavailable', 503);
    }
}

function educator_birds_generation_from_db(SQLite3 $db): string {
    try {
        $stmt = $db->prepare("SELECT value FROM avian_metadata WHERE key='educator_generation'");
        $result = $stmt->execute();
        $first = $result->fetchArray(SQLITE3_ASSOC);
        $second = $result->fetchArray(SQLITE3_ASSOC);
        $value = is_array($first) ? ($first['value'] ?? null) : null;
        if (!is_string($value) || preg_match('/\A[a-f0-9]{32}\z/D', $value) !== 1 || $second !== false) {
            throw new EducatorStoreError('detections database generation is invalid', 503);
        }
        return $value;
    } catch (Throwable $error) {
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('detections database generation is unavailable', 503);
    }
}

function educator_birds_sequence_floor(): int {
    return educator_birds_snapshot()['sequence'];
}

function educator_birds_generation(): string {
    return educator_birds_snapshot()['generation'];
}

function educator_local_iso(?string $local, ?string $offset): ?string {
    if ($local === null || $offset === null) return null;
    return str_replace(' ', 'T', $local) . $offset;
}

function educator_wall_parts(string $local): array {
    if (preg_match('/\A(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\z/D', $local, $match) !== 1) {
        throw new EducatorStoreError('educator wall time is invalid', 503);
    }
    return ['date' => $match[1], 'time' => $match[2]];
}

function educator_stored_int(array $row, string $key, int $min = 0, ?int $max = null, bool $nullable = false): ?int {
    $value = $row[$key] ?? null;
    if ($value === null && $nullable) return null;
    if (!is_int($value) || $value < $min || ($max !== null && $value > $max)) {
        throw new EducatorStoreError('educator data contains an invalid ' . $key, 503);
    }
    return $value;
}

function educator_stored_text(array $row, string $key, int $maxBytes, bool $nullable = false): ?string {
    $value = $row[$key] ?? null;
    if ($value === null && $nullable) return null;
    if (!is_string($value) || $value === '' || strlen($value) > $maxBytes
        || preg_match('//u', $value) !== 1) {
        throw new EducatorStoreError('educator data contains an invalid ' . $key, 503);
    }
    return $value;
}

function educator_validate_utc_text(string $value, string $key): void {
    if (preg_match('/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\z/D', $value) !== 1) {
        throw new EducatorStoreError('educator data contains an invalid ' . $key, 503);
    }
    $parsed = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s\Z', $value, new DateTimeZone('UTC'));
    $errors = DateTimeImmutable::getLastErrors();
    if (!$parsed || (is_array($errors) && ($errors['warning_count'] || $errors['error_count']))
        || $parsed->format('Y-m-d\TH:i:s\Z') !== $value) {
        throw new EducatorStoreError('educator data contains an invalid ' . $key, 503);
    }
}

/** Validate one stored local/UTC/epoch/offset/timezone tuple exactly. */
function educator_validate_time_bundle(array $row, string $prefix, bool $nullable = false): ?array {
    $keys = [
        'local' => $prefix . '_local',
        'utc' => $prefix . '_at_utc',
        'epoch' => $prefix . '_epoch',
        'offset' => $prefix . '_offset',
        'timezone' => $prefix . '_timezone',
    ];
    $values = array_map(fn(string $key) => $row[$key] ?? null, $keys);
    $nulls = count(array_filter($values, fn($value): bool => $value === null));
    if ($nullable && $nulls === count($values)) return null;
    if ($nulls !== 0) throw new EducatorStoreError('educator data contains an incomplete ' . $prefix . ' time', 503);
    $local = educator_stored_text($row, $keys['local'], 19);
    $utc = educator_stored_text($row, $keys['utc'], 20);
    $epoch = educator_stored_int($row, $keys['epoch'], 0, 4102444799);
    $offset = educator_stored_text($row, $keys['offset'], 6);
    $timezone = educator_stored_text($row, $keys['timezone'], 128);
    if (preg_match('/\A\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\z/D', $local) !== 1
        || preg_match('/\A[+-](?:0\d|1[0-4]):[0-5]\d\z/D', $offset) !== 1
        || preg_match('~\A[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*\z~D', $timezone) !== 1) {
        throw new EducatorStoreError('educator data contains an invalid ' . $prefix . ' time', 503);
    }
    educator_validate_utc_text($utc, $keys['utc']);
    try {
        $zone = new DateTimeZone($timezone);
        $instant = (new DateTimeImmutable('@' . $epoch))->setTimezone($zone);
    } catch (Throwable $error) {
        throw new EducatorStoreError('educator data contains an invalid ' . $prefix . ' timezone', 503);
    }
    if ($instant->format('Y-m-d H:i:s') !== $local
        || $instant->format('P') !== $offset
        || $instant->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z') !== $utc) {
        throw new EducatorStoreError('educator data contains an inconsistent ' . $prefix . ' time', 503);
    }
    return ['local' => $local, 'utc' => $utc, 'epoch' => $epoch, 'offset' => $offset, 'timezone' => $timezone];
}

function educator_validate_segment_row(array $row, ?int $captureId = null): array {
    $id = educator_stored_int($row, 'id', 1);
    $storedCapture = educator_stored_int($row, 'capture_id', 1);
    if ($captureId !== null && $captureId !== $storedCapture) {
        throw new EducatorStoreError('educator segment belongs to the wrong capture', 503);
    }
    $started = educator_validate_time_bundle($row, 'started');
    $stopped = educator_validate_time_bundle($row, 'stopped', true);
    $generation = educator_stored_text($row, 'birds_generation', 32);
    if (preg_match('/\A[a-f0-9]{32}\z/D', $generation) !== 1) {
        throw new EducatorStoreError('educator segment generation is invalid', 503);
    }
    $startSequence = educator_stored_int($row, 'start_sequence', 0);
    $revision = educator_stored_int($row, 'revision', 1, 2147483647);
    if ($stopped !== null && $stopped['epoch'] < $started['epoch']) {
        throw new EducatorStoreError('educator segment boundaries are invalid', 503);
    }
    return compact('id', 'storedCapture', 'started', 'stopped', 'generation', 'startSequence', 'revision');
}

function educator_validate_capture_row(array $row): array {
    $id = educator_stored_int($row, 'id', 1);
    $publicId = educator_stored_text($row, 'public_id', 34);
    if (!educator_valid_public_id($publicId, 'capture')) {
        throw new EducatorStoreError('educator capture id is invalid', 503);
    }
    $name = educator_stored_text($row, 'name', AVIAN_EDUCATOR_NAME_MAX_BYTES);
    if (educator_valid_name($name) !== $name) throw new EducatorStoreError('educator capture name is invalid', 503);
    $status = educator_stored_text($row, 'status', 7);
    if (!in_array($status, ['running', 'paused', 'stopped'], true)) {
        throw new EducatorStoreError('educator capture status is invalid', 503);
    }
    $folderId = educator_stored_int($row, 'folder_id', 1, null, true);
    if (array_key_exists('folder_public_id', $row)) {
        $folderPublicId = $row['folder_public_id'];
        if (($folderId === null) !== ($folderPublicId === null)
            || ($folderPublicId !== null
                && (!is_string($folderPublicId) || !educator_valid_public_id($folderPublicId, 'folder')))) {
            throw new EducatorStoreError('educator capture folder is invalid', 503);
        }
    }
    $started = educator_validate_time_bundle($row, 'started');
    $stopped = educator_validate_time_bundle($row, 'stopped', true);
    if (($status === 'stopped') !== ($stopped !== null)
        || ($stopped !== null && $stopped['epoch'] < $started['epoch'])) {
        throw new EducatorStoreError('educator capture boundaries are invalid', 503);
    }
    $revision = educator_stored_int($row, 'revision', 1, 2147483647);
    $created = educator_stored_text($row, 'created_at_utc', 20);
    $updated = educator_stored_text($row, 'updated_at_utc', 20);
    educator_validate_utc_text($created, 'created_at_utc');
    educator_validate_utc_text($updated, 'updated_at_utc');
    if (strcmp($updated, $created) < 0) throw new EducatorStoreError('educator capture update time is invalid', 503);
    if (isset($row['segment_count'])) educator_stored_int($row, 'segment_count', 0, AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS);
    if (isset($row['duration_seconds'])) educator_stored_int($row, 'duration_seconds', 0);
    return compact('id', 'publicId', 'name', 'status', 'folderId', 'started', 'stopped', 'revision');
}

function educator_validate_folder_row(array $row): array {
    $id = educator_stored_int($row, 'id', 1);
    $publicId = educator_stored_text($row, 'public_id', 34);
    if (!educator_valid_public_id($publicId, 'folder')) throw new EducatorStoreError('educator folder id is invalid', 503);
    $name = educator_stored_text($row, 'name', AVIAN_EDUCATOR_NAME_MAX_BYTES);
    if (educator_valid_name($name) !== $name) throw new EducatorStoreError('educator folder name is invalid', 503);
    $revision = educator_stored_int($row, 'revision', 1, 2147483647);
    $created = educator_stored_text($row, 'created_at_utc', 20);
    $updated = educator_stored_text($row, 'updated_at_utc', 20);
    educator_validate_utc_text($created, 'created_at_utc');
    educator_validate_utc_text($updated, 'updated_at_utc');
    if (strcmp($updated, $created) < 0) throw new EducatorStoreError('educator folder update time is invalid', 503);
    if (isset($row['capture_count'])) educator_stored_int($row, 'capture_count', 0);
    return compact('id', 'publicId', 'name', 'revision');
}

function educator_validate_capture_segments(array $captureRow, array $segmentRows): void {
    $capture = educator_validate_capture_row($captureRow);
    if ($segmentRows === [] || count($segmentRows) > AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS) {
        throw new EducatorStoreError('educator capture segments are invalid', 503);
    }
    $previous = null;
    $open = 0;
    foreach ($segmentRows as $index => $row) {
        $segment = educator_validate_segment_row($row, $capture['id']);
        if ($index === 0 && ($segment['started']['epoch'] !== $capture['started']['epoch']
            || $segment['started']['local'] !== $capture['started']['local'])) {
            throw new EducatorStoreError('educator capture start does not match its first segment', 503);
        }
        if ($previous !== null && ($previous['stopped'] === null
            || $segment['started']['epoch'] < $previous['stopped']['epoch']
            || $segment['startSequence'] < $previous['startSequence'])) {
            throw new EducatorStoreError('educator capture segments overlap or are unordered', 503);
        }
        if (!hash_equals($capture['started']['timezone'], $segment['started']['timezone'])
            || ($segment['stopped'] !== null
                && !hash_equals($capture['started']['timezone'], $segment['stopped']['timezone']))) {
            throw new EducatorStoreError('educator capture segment timezone is inconsistent', 503);
        }
        if ($segment['stopped'] === null) $open++;
        $previous = $segment;
    }
    if (($capture['status'] === 'running' && ($open !== 1 || $previous['stopped'] !== null))
        || ($capture['status'] !== 'running' && $open !== 0)
        || ($capture['status'] === 'stopped'
            && $capture['stopped']['epoch'] < $previous['stopped']['epoch'])) {
        throw new EducatorStoreError('educator capture state does not match its segments', 503);
    }
}

function educator_segment_public(array $row): array {
    educator_validate_segment_row($row);
    return [
        'id' => (int)$row['id'],
        'started_at' => educator_local_iso((string)$row['started_local'], (string)$row['started_offset']),
        'stopped_at' => educator_local_iso($row['stopped_local'] ?? null, $row['stopped_offset'] ?? null),
        'revision' => (int)$row['revision'],
    ];
}

function educator_capture_public(SQLite3 $db, array $row, bool $segments = true): array {
    educator_validate_capture_row($row);
    $out = [
        'id' => (string)$row['public_id'],
        'name' => (string)$row['name'],
        'status' => (string)$row['status'],
        'folder_id' => $row['folder_public_id'] ?? null,
        'started_at' => educator_local_iso((string)$row['started_local'], (string)$row['started_offset']),
        'stopped_at' => educator_local_iso($row['stopped_local'] ?? null, $row['stopped_offset'] ?? null),
        'revision' => (int)$row['revision'],
    ];
    if (isset($row['segment_count'])) $out['segment_count'] = (int)$row['segment_count'];
    if (isset($row['duration_seconds'])) $out['duration_seconds'] = max(0, (int)$row['duration_seconds']);
    foreach (['detection_count', 'species_count'] as $countKey) {
        if (array_key_exists($countKey, $row)) {
            $out[$countKey] = $row[$countKey] === null ? null : educator_stored_int($row, $countKey, 0);
        }
    }
    if ($segments) {
        $segmentRows = educator_store_rows($db,
            'SELECT * FROM capture_segments WHERE capture_id=:id ORDER BY started_epoch,id LIMIT '
            . (AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS + 1),
            [':id' => (int)$row['id']]
        );
        if (count($segmentRows) > AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS) {
            throw new EducatorStoreError('capture has too many listening segments', 413);
        }
        educator_validate_capture_segments($row, $segmentRows);
        $out['segments'] = array_map('educator_segment_public', $segmentRows);
        $duration = 0;
        $now = time();
        foreach ($segmentRows as $segment) {
            $duration += max(0, (int)($segment['stopped_epoch'] ?? $now) - (int)$segment['started_epoch']);
        }
        $out['duration_seconds'] = $duration;
    }
    return $out;
}

/**
 * Count page captures in one Birds read snapshot. Each segment uses the
 * station's Date/Time index, then a small TEMP hit table is aggregated once.
 * A hard segment budget keeps an adversarial pause/resume history from turning
 * the 10-second state poll into unbounded work on a small Pi.
 */
function educator_capture_count_materialize_sql(bool $closed): string {
    return 'INSERT OR IGNORE INTO temp.educator_count_hits(capture_id,detection_id,sci_name) '
        . 'SELECT :capture,d.rowid,d.Sci_Name FROM main.detections AS d INDEXED BY detections_Date_Time '
        . 'JOIN main.' . AVIAN_DETECTION_SEQUENCE_TABLE . ' q ON q.detection_rowid=d.rowid '
        . 'WHERE q.sequence>:sequence AND (d.Date,d.Time)>=(:started_date,:started_time)'
        . ($closed ? ' AND (d.Date,d.Time)<(:stopped_date,:stopped_time)' : '')
        . ' LIMIT :hit_limit';
}

function educator_capture_page_counts(SQLite3 $storeDb, array $captureRows): array {
    if ($captureRows === []) return [];
    $captureIds = [];
    foreach ($captureRows as $capture) {
        $validated = educator_validate_capture_row($capture);
        if (in_array($validated['id'], $captureIds, true)) {
            throw new EducatorStoreError('capture count input contains a duplicate id', 503);
        }
        $captureIds[] = $validated['id'];
    }
    $idList = implode(',', array_map('intval', $captureIds));
    $segments = educator_store_rows($storeDb,
        'SELECT * FROM capture_segments WHERE capture_id IN (' . $idList . ') '
        . 'ORDER BY capture_id,started_epoch,id LIMIT ' . (AVIAN_EDUCATOR_COUNT_MAX_SEGMENTS + 1)
    );
    if (count($segments) > AVIAN_EDUCATOR_COUNT_MAX_SEGMENTS) {
        return array_fill_keys($captureIds, ['detection_count' => null, 'species_count' => null]);
    }
    $byCapture = [];
    foreach ($segments as $segment) $byCapture[$segment['capture_id']][] = $segment;
    foreach ($captureRows as $capture) {
        $captureId = $capture['id'];
        educator_validate_capture_segments($capture, $byCapture[$captureId] ?? []);
    }

    $path = educator_birds_db_path();
    if (!is_file($path) || is_link($path)) {
        throw new EducatorStoreError('detections database is unavailable', 503);
    }
    $birds = null;
    try {
        $birds = new SQLite3($path, SQLITE3_OPEN_READONLY);
        $birds->busyTimeout(2000);
        $birds->exec('BEGIN');
        $generation = educator_birds_generation_from_db($birds);
        educator_birds_sequence_authority($birds, false);
        $birds->exec('CREATE TEMP TABLE educator_count_hits('
            . 'capture_id INTEGER NOT NULL,detection_id INTEGER NOT NULL,sci_name TEXT NOT NULL,'
            . 'PRIMARY KEY(capture_id,detection_id)) WITHOUT ROWID');
        $hitCount = 0;
        $inserts = [];
        foreach ($segments as $segment) {
            $validated = educator_validate_segment_row($segment);
            if (!hash_equals($generation, $validated['generation'])) {
                throw new EducatorStoreError('educator capture belongs to a different detections database', 409);
            }
            $started = educator_wall_parts($validated['started']['local']);
            $stopped = $validated['stopped'] === null
                ? null
                : educator_wall_parts($validated['stopped']['local']);
            $insertKey = $stopped === null ? 'open' : 'closed';
            if (!isset($inserts[$insertKey])) {
                $inserts[$insertKey] = $birds->prepare(
                    educator_capture_count_materialize_sql($stopped !== null)
                );
            }
            $insert = $inserts[$insertKey];
            $insert->bindValue(':capture', $validated['storedCapture'], SQLITE3_INTEGER);
            $insert->bindValue(':sequence', $validated['startSequence'], SQLITE3_INTEGER);
            $insert->bindValue(':started_date', $started['date'], SQLITE3_TEXT);
            $insert->bindValue(':started_time', $started['time'], SQLITE3_TEXT);
            if ($stopped !== null) {
                $insert->bindValue(':stopped_date', $stopped['date'], SQLITE3_TEXT);
                $insert->bindValue(':stopped_time', $stopped['time'], SQLITE3_TEXT);
            }
            $insert->bindValue(
                ':hit_limit',
                AVIAN_EDUCATOR_COUNT_MAX_HITS + 1 - $hitCount,
                SQLITE3_INTEGER
            );
            $insert->execute();
            $hitCount += $birds->changes();
            $insert->reset();
            if ($hitCount > AVIAN_EDUCATOR_COUNT_MAX_HITS) {
                $inserts = [];
                $birds->exec('ROLLBACK');
                $birds->close();
                $birds = null;
                return array_fill_keys($captureIds, [
                    'detection_count' => null,
                    'species_count' => null,
                ]);
            }
        }
        $inserts = [];
        $rows = educator_store_rows($birds,
            'SELECT capture_id,COUNT(*) AS detection_count,COUNT(DISTINCT sci_name) AS species_count '
            . 'FROM temp.educator_count_hits GROUP BY capture_id'
        );
        educator_store_test_hook('capture-counts-after-materialize');
        if (!hash_equals($generation, educator_birds_generation_from_db($birds))) {
            throw new EducatorStoreError('detections database changed while counting captures', 409);
        }
        educator_birds_sequence_authority($birds, false);
        $birds->exec('COMMIT');
        $birds->close();
        $birds = null;
        $counts = array_fill_keys($captureIds, ['detection_count' => 0, 'species_count' => 0]);
        $seenCounts = [];
        foreach ($rows as $row) {
            $captureId = educator_stored_int($row, 'capture_id', 1);
            if (!array_key_exists($captureId, $counts) || isset($seenCounts[$captureId])) {
                throw new EducatorStoreError('capture count result is invalid', 503);
            }
            $seenCounts[$captureId] = true;
            $counts[$captureId] = [
                'detection_count' => educator_stored_int($row, 'detection_count', 0),
                'species_count' => educator_stored_int($row, 'species_count', 0),
            ];
        }
        return $counts;
    } catch (Throwable $error) {
        if ($birds instanceof SQLite3) {
            try { $birds->exec('ROLLBACK'); } catch (Throwable $ignored) {}
            $birds->close();
        }
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('capture counts are unavailable', 503);
    }
}

function educator_store_capture_counts(SQLite3 $db, array $publicIds, int $stateRevision): array {
    if (!array_is_list($publicIds)
        || count($publicIds) < 1
        || count($publicIds) > AVIAN_EDUCATOR_COUNT_BATCH_MAX) {
        throw new EducatorStoreError('capture count batch is invalid');
    }
    $seen = [];
    foreach ($publicIds as $publicId) {
        if (!is_string($publicId) || !educator_valid_public_id($publicId, 'capture')) {
            throw new EducatorStoreError('capture count id is invalid');
        }
        if (isset($seen[$publicId])) {
            throw new EducatorStoreError('capture count batch contains a duplicate id');
        }
        $seen[$publicId] = true;
    }

    educator_expect_state_revision($db, $stateRevision);
    $captures = [];
    foreach ($publicIds as $publicId) {
        $capture = educator_capture_row($db, $publicId);
        if ($capture === null) throw new EducatorStoreError('capture was not found', 404);
        $validated = educator_validate_capture_row($capture);
        if ($validated['status'] !== 'stopped') {
            throw new EducatorStoreError('capture is still active', 409);
        }
        $captures[$publicId] = $capture;
    }

    $counts = [];
    foreach ($publicIds as $publicId) {
        $capture = $captures[$publicId];
        $captureCounts = educator_capture_page_counts($db, [$capture]);
        if (count($captureCounts) !== 1 || !array_key_exists($capture['id'], $captureCounts)) {
            throw new EducatorStoreError('capture count result is invalid', 503);
        }
        $counts[$publicId] = [
            'revision' => (int)$capture['revision'],
        ] + $captureCounts[$capture['id']];
        educator_store_test_hook('capture-counts-after-item');
    }
    educator_expect_state_revision($db, $stateRevision);
    return $counts;
}

function educator_capture_row(SQLite3 $db, string $publicId): ?array {
    return educator_store_one($db,
        'SELECT c.*, f.public_id AS folder_public_id, '
        . '(SELECT COUNT(*) FROM capture_segments s WHERE s.capture_id=c.id) AS segment_count '
        . ',(SELECT COALESCE(SUM(MAX(0,COALESCE(s.stopped_epoch,CAST(strftime(\'%s\',\'now\') AS INTEGER))-s.started_epoch)),0) '
        . 'FROM capture_segments s WHERE s.capture_id=c.id) AS duration_seconds '
        . 'FROM captures c '
        . 'LEFT JOIN folders f ON f.id=c.folder_id WHERE c.public_id=:id',
        [':id' => $publicId]
    );
}

function educator_current_capture_row(SQLite3 $db): ?array {
    return educator_store_one($db,
        "SELECT c.*, f.public_id AS folder_public_id FROM captures c "
        . "LEFT JOIN folders f ON f.id=c.folder_id WHERE c.status IN ('running','paused') LIMIT 1"
    );
}

function educator_folder_row(SQLite3 $db, string $publicId): ?array {
    return educator_store_one($db,
        'SELECT f.*, COUNT(c.id) AS capture_count FROM folders f '
        . 'LEFT JOIN captures c ON c.folder_id=f.id WHERE f.public_id=:id GROUP BY f.id',
        [':id' => $publicId]
    );
}

function educator_folder_public(array $row): array {
    educator_validate_folder_row($row);
    return [
        'id' => (string)$row['public_id'],
        'name' => (string)$row['name'],
        'revision' => (int)$row['revision'],
        'capture_count' => (int)($row['capture_count'] ?? 0),
    ];
}

function educator_capture_cursor_encode(int $startedEpoch, int $id): string {
    return rtrim(strtr(base64_encode($startedEpoch . ':' . $id), '+/', '-_'), '=');
}

function educator_capture_cursor_decode(?string $cursor): ?array {
    if ($cursor === null || $cursor === '') return null;
    if (preg_match('/\A[A-Za-z0-9_-]{3,64}\z/D', $cursor) !== 1) {
        throw new EducatorStoreError('capture cursor is invalid');
    }
    $padding = (4 - strlen($cursor) % 4) % 4;
    $decoded = base64_decode(strtr($cursor, '-_', '+/') . str_repeat('=', $padding), true);
    if (!is_string($decoded)
        || preg_match('/\A(0|[1-9][0-9]{0,10}):([1-9][0-9]{0,18})\z/D', $decoded, $match) !== 1) {
        throw new EducatorStoreError('capture cursor is invalid');
    }
    return ['epoch' => (int)$match[1], 'id' => (int)$match[2]];
}

function educator_store_capture_page(SQLite3 $db, int $limit = 100, ?string $cursor = null): array {
    $limit = max(1, min(100, $limit));
    $decoded = educator_capture_cursor_decode($cursor);
    $where = '';
    $bind = [];
    if ($decoded !== null) {
        $where = 'WHERE (c.started_epoch<:epoch OR (c.started_epoch=:epoch AND c.id<:id)) ';
        $bind = [':epoch' => $decoded['epoch'], ':id' => $decoded['id']];
    }
    $rows = educator_store_rows($db,
        'SELECT c.*, f.public_id AS folder_public_id, '
        . '(SELECT COUNT(*) FROM capture_segments s WHERE s.capture_id=c.id) AS segment_count, '
        . '(SELECT COALESCE(SUM(MAX(0,COALESCE(s.stopped_epoch,CAST(strftime(\'%s\',\'now\') AS INTEGER))-s.started_epoch)),0) '
        . 'FROM capture_segments s WHERE s.capture_id=c.id) AS duration_seconds FROM captures c '
        . 'LEFT JOIN folders f ON f.id=c.folder_id ' . $where
        . 'ORDER BY c.started_epoch DESC,c.id DESC LIMIT ' . ($limit + 1),
        $bind
    );
    $more = count($rows) > $limit;
    if ($more) array_pop($rows);
    $captures = [];
    foreach ($rows as $row) {
        // Saved-list counts are intentionally lazy. Counting 100 broad saved
        // periods every 10 seconds can revisit the station history 100 times.
        $row += ['detection_count' => null, 'species_count' => null];
        $capture = educator_capture_public($db, $row, false);
        $captures[] = $capture;
    }
    $last = $rows ? $rows[count($rows) - 1] : null;
    return [
        'captures' => $captures,
        'capture_page' => [
            'total' => (int)($db->querySingle('SELECT COUNT(*) FROM captures') ?: 0),
            'more' => $more,
            'next_cursor' => $more && $last
                ? educator_capture_cursor_encode((int)$last['started_epoch'], (int)$last['id'])
                : null,
        ],
    ];
}

function educator_store_snapshot(SQLite3 $db, bool $includeActiveCounts = true): array {
    $page = educator_store_capture_page($db);
    $folders = educator_store_rows($db,
        'SELECT f.*, COUNT(c.id) AS capture_count FROM folders f '
        . 'LEFT JOIN captures c ON c.folder_id=f.id GROUP BY f.id ORDER BY lower(f.name),f.id'
    );
    $current = educator_current_capture_row($db);
    $active = null;
    if ($current !== null) {
        if ($includeActiveCounts) {
            $activeCounts = educator_capture_page_counts($db, [$current]);
            $current += $activeCounts[$current['id']]
                ?? ['detection_count' => null, 'species_count' => null];
        } else {
            // Mutation results are already committed. Do not make their
            // response depend on a second database after that commit.
            $current += ['detection_count' => null, 'species_count' => null];
        }
        $active = educator_capture_public($db, $current);
    }
    return [
        'state_revision' => educator_state_revision($db),
        'active' => $active,
        'captures' => $page['captures'],
        'capture_page' => $page['capture_page'],
        'folders' => array_map('educator_folder_public', $folders),
    ];
}

function educator_begin(SQLite3 $db): void {
    $db->exec('BEGIN IMMEDIATE');
}

function educator_commit(SQLite3 $db): void {
    $db->exec('COMMIT');
}

function educator_rollback(SQLite3 $db): void {
    try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
}

function educator_insert_segment(
    SQLite3 $db,
    int $captureId,
    array $now,
    int $sequenceFloor,
    string $birdsGeneration
): void {
    $count = (int)($db->querySingle(
        'SELECT COUNT(*) FROM capture_segments WHERE capture_id=' . $captureId
    ) ?: 0);
    if ($count >= AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS) {
        throw new EducatorStoreError('capture reached the listening segment limit', 409);
    }
    $stmt = $db->prepare(
        'INSERT INTO capture_segments '
        . '(capture_id,started_local,started_at_utc,started_epoch,started_offset,started_timezone,birds_generation,start_sequence) '
        . 'VALUES (:capture,:local,:utc,:epoch,:offset,:timezone,:generation,:sequence)'
    );
    foreach ([
        ':capture' => $captureId, ':local' => $now['local'], ':utc' => $now['utc'],
        ':epoch' => $now['epoch'], ':offset' => $now['offset'], ':timezone' => $now['timezone'],
        ':generation' => $birdsGeneration,
        ':sequence' => $sequenceFloor,
    ] as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
    }
    $stmt->execute();
}

function educator_assert_folder_segment_capacity(
    SQLite3 $db,
    ?int $folderId,
    int $additionalSegments
): void {
    if ($folderId === null || $additionalSegments < 1) return;
    $stmt = $db->prepare(
        'SELECT COUNT(*) AS n FROM capture_segments s '
        . 'JOIN captures c ON c.id=s.capture_id WHERE c.folder_id=:folder'
    );
    $stmt->bindValue(':folder', $folderId, SQLITE3_INTEGER);
    $row = $stmt->execute()->fetchArray(SQLITE3_ASSOC);
    $current = (int)($row['n'] ?? 0);
    if ($current > AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS - $additionalSegments) {
        throw new EducatorStoreError('move a listening period before adding more segments to this folder', 409);
    }
}

function educator_close_open_segment(SQLite3 $db, int $captureId, array $now): void {
    $stmt = $db->prepare(
        'UPDATE capture_segments SET stopped_local=:local,stopped_at_utc=:utc,stopped_epoch=:epoch,'
        . 'stopped_offset=:offset,stopped_timezone=:timezone,revision=revision+1 '
        . 'WHERE capture_id=:capture AND stopped_epoch IS NULL'
    );
    foreach ([
        ':local' => $now['local'], ':utc' => $now['utc'], ':epoch' => $now['epoch'],
        ':offset' => $now['offset'], ':timezone' => $now['timezone'], ':capture' => $captureId,
    ] as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
    }
    $stmt->execute();
}

function educator_assert_capture_boundary(SQLite3 $db, array $capture, string $action, array $now): void {
    $segment = educator_store_one($db,
        'SELECT * FROM capture_segments WHERE capture_id=:id ORDER BY id DESC LIMIT 1',
        [':id' => (int)$capture['id']]
    );
    if (!$segment) throw new EducatorStoreError('capture has no valid listening segment', 409);
    $useStop = $segment['stopped_epoch'] !== null;
    if ($action === 'resume' && !$useStop) {
        throw new EducatorStoreError('capture already has an open listening segment', 409);
    }
    $boundaryEpoch = (int)($useStop ? $segment['stopped_epoch'] : $segment['started_epoch']);
    $boundaryLocal = (string)($useStop ? $segment['stopped_local'] : $segment['started_local']);
    if ((int)$now['epoch'] < $boundaryEpoch || strcmp((string)$now['local'], $boundaryLocal) < 0) {
        throw new EducatorStoreError('station clock moved backward; correct it before continuing', 409);
    }
}

function educator_assert_birds_generation(string $expected): void {
    $actual = educator_birds_generation();
    if (!hash_equals($expected, $actual)) {
        throw new EducatorStoreError('detections database changed during the capture update', 409);
    }
}

function educator_require_entity_revision(array $row, int $revision): void {
    if ((int)$row['revision'] !== $revision) {
        throw new EducatorStoreError('educator item changed in another window', 409, [
            'revision' => (int)$row['revision'],
        ]);
    }
}

function educator_bump_folder_revisions(SQLite3 $db, array $folderIds, string $utc): void {
    $folderIds = array_values(array_unique(array_filter(
        array_map(fn($id): ?int => $id === null ? null : (int)$id, $folderIds),
        fn($id): bool => $id !== null
    )));
    $stmt = $db->prepare('UPDATE folders SET revision=revision+1,updated_at_utc=:utc WHERE id=:id');
    foreach ($folderIds as $folderId) {
        $stmt->bindValue(':utc', $utc, SQLITE3_TEXT);
        $stmt->bindValue(':id', $folderId, SQLITE3_INTEGER);
        $stmt->execute();
        $stmt->reset();
    }
}

function educator_store_start(SQLite3 $db, int $stateRevision, ?string $requestedName = null): array {
    $name = null;
    if ($requestedName !== null) {
        $name = educator_valid_name($requestedName);
        if ($name === null) throw new EducatorStoreError('capture name is invalid');
    }
    educator_expect_state_revision($db, $stateRevision);
    $current = educator_current_capture_row($db);
    if ($current) throw new EducatorStoreError('a listening period is already active', 409);
    $birdsSnapshot = educator_birds_snapshot();
    $sequence = $birdsSnapshot['sequence'];
    $birdsGeneration = $birdsSnapshot['generation'];
    educator_store_test_hook('after-birds-snapshot');
    $now = educator_capture_now();
    $name = $name ?? substr($now['local'], 0, 16);
    educator_begin($db);
    try {
        $id = educator_new_public_id('c');
        $stmt = $db->prepare(
            'INSERT INTO captures '
            . '(public_id,name,status,started_local,started_at_utc,started_epoch,started_offset,started_timezone,created_at_utc,updated_at_utc) '
            . "VALUES (:id,:name,'running',:local,:utc,:epoch,:offset,:timezone,:utc,:utc)"
        );
        foreach ([
            ':id' => $id, ':name' => $name, ':local' => $now['local'], ':utc' => $now['utc'],
            ':epoch' => $now['epoch'], ':offset' => $now['offset'], ':timezone' => $now['timezone'],
        ] as $key => $value) {
            $stmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
        }
        $stmt->execute();
        $captureId = (int)$db->lastInsertRowID();
        educator_insert_segment($db, $captureId, $now, $sequence, $birdsGeneration);
        educator_store_test_hook('before-generation-recheck');
        educator_assert_birds_generation($birdsGeneration);
        $next = educator_bump_state_revision($db);
        educator_commit($db);
        $capture = educator_capture_row($db, $id);
        return ['created' => true, 'state_revision' => $next, 'capture' => educator_capture_public($db, $capture)];
    } catch (Throwable $error) {
        educator_rollback($db);
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('could not start a listening period', 409);
    }
}

function educator_store_transition(SQLite3 $db, string $action, string $publicId, int $revision, int $stateRevision, ?string $folderPublicId = null): array {
    if (!in_array($action, ['pause', 'resume', 'stop'], true)) {
        throw new EducatorStoreError('capture action is invalid');
    }
    if (!educator_valid_public_id($publicId, 'capture')) throw new EducatorStoreError('capture id is invalid');
    $row = educator_capture_row($db, $publicId);
    if (!$row) throw new EducatorStoreError('capture was not found', 404);
    if ($action === 'pause' && $row['status'] === 'paused') {
        return ['changed' => false, 'capture' => educator_capture_public($db, $row), 'state_revision' => educator_state_revision($db)];
    }
    if ($action === 'stop' && $row['status'] === 'stopped') {
        return ['changed' => false, 'capture' => educator_capture_public($db, $row), 'state_revision' => educator_state_revision($db)];
    }
    educator_expect_state_revision($db, $stateRevision);
    educator_require_entity_revision($row, $revision);
    $expected = $action === 'pause' ? 'running' : ($action === 'resume' ? 'paused' : null);
    if ($expected !== null && $row['status'] !== $expected) {
        throw new EducatorStoreError('capture state does not allow this action', 409);
    }
    if ($action === 'stop' && !in_array($row['status'], ['running', 'paused'], true)) {
        throw new EducatorStoreError('capture is not current', 409);
    }
    $folderId = $row['folder_id'];
    if ($folderPublicId !== null) {
        if (!educator_valid_public_id($folderPublicId, 'folder')) throw new EducatorStoreError('folder id is invalid');
        $folder = educator_folder_row($db, $folderPublicId);
        if (!$folder) throw new EducatorStoreError('folder was not found', 404);
        $folderId = (int)$folder['id'];
    }
    $birdsSnapshot = $action === 'resume' ? educator_birds_snapshot() : null;
    $sequence = $birdsSnapshot['sequence'] ?? 0;
    $birdsGeneration = $birdsSnapshot['generation'] ?? '';
    if ($action === 'resume') educator_store_test_hook('after-birds-snapshot');
    $now = educator_capture_now($row);
    educator_assert_capture_boundary($db, $row, $action, $now);
    educator_begin($db);
    try {
        if ($action === 'pause') {
            educator_close_open_segment($db, (int)$row['id'], $now);
            $stmt = $db->prepare("UPDATE captures SET status='paused',revision=revision+1,updated_at_utc=:utc WHERE id=:id");
        } elseif ($action === 'resume') {
            educator_assert_folder_segment_capacity($db, $row['folder_id'], 1);
            educator_insert_segment($db, (int)$row['id'], $now, $sequence, $birdsGeneration);
            $stmt = $db->prepare("UPDATE captures SET status='running',revision=revision+1,updated_at_utc=:utc WHERE id=:id");
        } else {
            if ($folderId !== null && $folderId !== $row['folder_id']) {
                $captureSegments = (int)($db->querySingle(
                    'SELECT COUNT(*) FROM capture_segments WHERE capture_id=' . (int)$row['id']
                ) ?: 0);
                educator_assert_folder_segment_capacity($db, $folderId, $captureSegments);
            }
            if ($row['status'] === 'running') educator_close_open_segment($db, (int)$row['id'], $now);
            $stmt = $db->prepare(
                "UPDATE captures SET status='stopped',folder_id=:folder,stopped_local=:local,stopped_at_utc=:utc,"
                . 'stopped_epoch=:epoch,stopped_offset=:offset,stopped_timezone=:timezone,'
                . 'revision=revision+1,updated_at_utc=:utc WHERE id=:id'
            );
            $stmt->bindValue(':folder', $folderId, $folderId === null ? SQLITE3_NULL : SQLITE3_INTEGER);
            $stmt->bindValue(':local', $now['local'], SQLITE3_TEXT);
            $stmt->bindValue(':epoch', $now['epoch'], SQLITE3_INTEGER);
            $stmt->bindValue(':offset', $now['offset'], SQLITE3_TEXT);
            $stmt->bindValue(':timezone', $now['timezone'], SQLITE3_TEXT);
        }
        $stmt->bindValue(':utc', $now['utc'], SQLITE3_TEXT);
        $stmt->bindValue(':id', (int)$row['id'], SQLITE3_INTEGER);
        $stmt->execute();
        if ($action === 'resume') {
            educator_store_test_hook('before-generation-recheck');
            educator_assert_birds_generation($birdsGeneration);
        }
        if ($action === 'stop') {
            educator_bump_folder_revisions($db, [$row['folder_id'], $folderId], $now['utc']);
        } elseif ($action === 'pause' || $action === 'resume') {
            educator_bump_folder_revisions($db, [$row['folder_id']], $now['utc']);
        }
        $next = educator_bump_state_revision($db);
        educator_commit($db);
        $updated = educator_capture_row($db, $publicId);
        return ['changed' => true, 'state_revision' => $next, 'capture' => educator_capture_public($db, $updated)];
    } catch (Throwable $error) {
        educator_rollback($db);
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('could not change the listening period', 409);
    }
}

function educator_store_update_capture(SQLite3 $db, string $action, string $publicId, int $revision, int $stateRevision, $value): array {
    if (!educator_valid_public_id($publicId, 'capture')) throw new EducatorStoreError('capture id is invalid');
    $row = educator_capture_row($db, $publicId);
    if (!$row) throw new EducatorStoreError('capture was not found', 404);
    educator_expect_state_revision($db, $stateRevision);
    educator_require_entity_revision($row, $revision);
    $now = educator_now();
    if ($action === 'rename-capture') {
        $name = educator_valid_name($value);
        if ($name === null) throw new EducatorStoreError('capture name is invalid');
        $sql = 'UPDATE captures SET name=:value,revision=revision+1,updated_at_utc=:utc WHERE id=:id';
        $bound = $name;
    } else {
        $folderId = null;
        if ($value !== null) {
            if (!is_string($value) || !educator_valid_public_id($value, 'folder')) throw new EducatorStoreError('folder id is invalid');
            $folder = educator_folder_row($db, $value);
            if (!$folder) throw new EducatorStoreError('folder was not found', 404);
            $folderId = (int)$folder['id'];
        }
        $sql = 'UPDATE captures SET folder_id=:value,revision=revision+1,updated_at_utc=:utc WHERE id=:id';
        $bound = $folderId;
    }
    educator_begin($db);
    try {
        if ($action === 'move-capture' && $bound !== null && $bound !== $row['folder_id']) {
            $captureSegments = (int)($db->querySingle(
                'SELECT COUNT(*) FROM capture_segments WHERE capture_id=' . (int)$row['id']
            ) ?: 0);
            educator_assert_folder_segment_capacity($db, $bound, $captureSegments);
        }
        $stmt = $db->prepare($sql);
        $stmt->bindValue(':value', $bound, $bound === null ? SQLITE3_NULL : (is_int($bound) ? SQLITE3_INTEGER : SQLITE3_TEXT));
        $stmt->bindValue(':utc', $now['utc'], SQLITE3_TEXT);
        $stmt->bindValue(':id', (int)$row['id'], SQLITE3_INTEGER);
        $stmt->execute();
        if ($action === 'move-capture' && $bound !== $row['folder_id']) {
            educator_bump_folder_revisions($db, [$row['folder_id'], $bound], $now['utc']);
        }
        $next = educator_bump_state_revision($db);
        educator_commit($db);
        return ['state_revision' => $next, 'capture' => educator_capture_public($db, educator_capture_row($db, $publicId))];
    } catch (Throwable $error) {
        educator_rollback($db);
        throw new EducatorStoreError('could not update the capture', 409);
    }
}

function educator_store_delete_capture(SQLite3 $db, string $publicId, int $revision, int $stateRevision): array {
    if (!educator_valid_public_id($publicId, 'capture')) throw new EducatorStoreError('capture id is invalid');
    $row = educator_capture_row($db, $publicId);
    if (!$row) throw new EducatorStoreError('capture was not found', 404);
    if ($row['status'] !== 'stopped') throw new EducatorStoreError('stop the capture before removing it', 409);
    educator_expect_state_revision($db, $stateRevision);
    educator_require_entity_revision($row, $revision);
    $now = educator_now();
    educator_begin($db);
    try {
        $stmt = $db->prepare('DELETE FROM captures WHERE id=:id');
        $stmt->bindValue(':id', (int)$row['id'], SQLITE3_INTEGER);
        $stmt->execute();
        educator_bump_folder_revisions($db, [$row['folder_id']], $now['utc']);
        $next = educator_bump_state_revision($db);
        educator_commit($db);
        return ['state_revision' => $next, 'deleted' => $publicId];
    } catch (Throwable $error) {
        educator_rollback($db);
        throw new EducatorStoreError('could not remove the capture', 409);
    }
}

function educator_store_create_folder(SQLite3 $db, string $nameValue, int $stateRevision): array {
    educator_expect_state_revision($db, $stateRevision);
    $name = educator_valid_name($nameValue);
    if ($name === null) throw new EducatorStoreError('folder name is invalid');
    $now = educator_now();
    educator_begin($db);
    try {
        educator_assert_folder_name_available($db, $name);
        if ((int)$db->querySingle('SELECT COUNT(*) FROM folders') >= AVIAN_EDUCATOR_MAX_FOLDERS) {
            throw new EducatorStoreError('remove a folder before creating another one', 409);
        }
        $publicId = educator_new_public_id('f');
        $stmt = $db->prepare('INSERT INTO folders(public_id,name,created_at_utc,updated_at_utc) VALUES(:id,:name,:utc,:utc)');
        $stmt->bindValue(':id', $publicId, SQLITE3_TEXT);
        $stmt->bindValue(':name', $name, SQLITE3_TEXT);
        $stmt->bindValue(':utc', $now['utc'], SQLITE3_TEXT);
        $stmt->execute();
        $next = educator_bump_state_revision($db);
        educator_commit($db);
        return ['state_revision' => $next, 'folder' => educator_folder_public(educator_folder_row($db, $publicId))];
    } catch (Throwable $error) {
        educator_rollback($db);
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('could not create the folder', 409);
    }
}

function educator_store_rename_folder(SQLite3 $db, string $publicId, int $revision, int $stateRevision, string $nameValue): array {
    if (!educator_valid_public_id($publicId, 'folder')) throw new EducatorStoreError('folder id is invalid');
    $row = educator_folder_row($db, $publicId);
    if (!$row) throw new EducatorStoreError('folder was not found', 404);
    educator_expect_state_revision($db, $stateRevision);
    educator_require_entity_revision($row, $revision);
    $name = educator_valid_name($nameValue);
    if ($name === null) throw new EducatorStoreError('folder name is invalid');
    educator_assert_folder_name_available($db, $name, (int)$row['id']);
    $now = educator_now();
    educator_begin($db);
    try {
        $stmt = $db->prepare('UPDATE folders SET name=:name,revision=revision+1,updated_at_utc=:utc WHERE id=:id');
        $stmt->bindValue(':name', $name, SQLITE3_TEXT);
        $stmt->bindValue(':utc', $now['utc'], SQLITE3_TEXT);
        $stmt->bindValue(':id', (int)$row['id'], SQLITE3_INTEGER);
        $stmt->execute();
        $next = educator_bump_state_revision($db);
        educator_commit($db);
        return ['state_revision' => $next, 'folder' => educator_folder_public(educator_folder_row($db, $publicId))];
    } catch (Throwable $error) {
        educator_rollback($db);
        throw new EducatorStoreError('could not rename the folder', 409);
    }
}

function educator_store_delete_folder(SQLite3 $db, string $publicId, int $revision, int $stateRevision): array {
    if (!educator_valid_public_id($publicId, 'folder')) throw new EducatorStoreError('folder id is invalid');
    $row = educator_folder_row($db, $publicId);
    if (!$row) throw new EducatorStoreError('folder was not found', 404);
    educator_expect_state_revision($db, $stateRevision);
    educator_require_entity_revision($row, $revision);
    $now = educator_now();
    educator_begin($db);
    try {
        $stmt = $db->prepare('UPDATE captures SET folder_id=NULL,revision=revision+1,updated_at_utc=:utc WHERE folder_id=:id');
        $stmt->bindValue(':utc', $now['utc'], SQLITE3_TEXT);
        $stmt->bindValue(':id', (int)$row['id'], SQLITE3_INTEGER);
        $stmt->execute();
        $stmt = $db->prepare('DELETE FROM folders WHERE id=:id');
        $stmt->bindValue(':id', (int)$row['id'], SQLITE3_INTEGER);
        $stmt->execute();
        $next = educator_bump_state_revision($db);
        educator_commit($db);
        return ['state_revision' => $next, 'deleted' => $publicId];
    } catch (Throwable $error) {
        educator_rollback($db);
        throw new EducatorStoreError('could not remove the folder', 409);
    }
}

function educator_store_stop_current(SQLite3 $db): bool {
    $row = educator_current_capture_row($db);
    if (!$row) return false;
    educator_validate_capture_row($row);
    try {
        $now = educator_capture_now($row);
    } catch (EducatorStoreError $error) {
        if ($error->httpStatus !== 409) throw $error;
        $configuredZone = educator_station_timezone();
        if (hash_equals((string)$row['started_timezone'], $configuredZone->getName())) {
            // A repeated local hour cannot be represented unambiguously in
            // BirdNET's offset-less Date/Time columns. Do not shorten or stop
            // the period. The root lifecycle operation must retry later.
            throw new EducatorStoreError(
                'cannot safely stop during the repeated daylight-saving hour',
                409
            );
        }
        $segment = educator_store_one($db,
            'SELECT * FROM capture_segments WHERE capture_id=:id ORDER BY id DESC LIMIT 1',
            [':id' => (int)$row['id']]
        );
        if (!$segment) throw new EducatorStoreError('could not safely close the current capture', 503);
        $useStop = $segment['stopped_epoch'] !== null;
        $boundaryEpoch = (int)($useStop ? $segment['stopped_epoch'] : $segment['started_epoch']);
        $boundaryLocal = (string)($useStop ? $segment['stopped_local'] : $segment['started_local']);
        try {
            $captureZone = new DateTimeZone((string)$row['started_timezone']);
            $local = educator_clock($captureZone);
            if (educator_time_is_repeated($local, $captureZone)
                || $local->getTimestamp() < $boundaryEpoch
                || strcmp($local->format('Y-m-d H:i:s'), $boundaryLocal) < 0) {
                throw new EducatorStoreError('could not safely close the current capture', 409);
            }
            $now = [
                'local' => $local->format('Y-m-d H:i:s'),
                'utc' => $local->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s\Z'),
                'epoch' => $local->getTimestamp(),
                'offset' => $local->format('P'),
                'timezone' => $captureZone->getName(),
            ];
        } catch (Throwable $recoveryError) {
            if ($recoveryError instanceof EducatorStoreError) throw $recoveryError;
            throw new EducatorStoreError('could not safely close the current capture', 409);
        }
    }
    educator_begin($db);
    try {
        if ($row['status'] === 'running') educator_close_open_segment($db, (int)$row['id'], $now);
        $stmt = $db->prepare(
            "UPDATE captures SET status='stopped',stopped_local=:local,stopped_at_utc=:utc,stopped_epoch=:epoch,"
            . 'stopped_offset=:offset,stopped_timezone=:timezone,revision=revision+1,updated_at_utc=:utc WHERE id=:id'
        );
        foreach ([
            ':local' => $now['local'], ':utc' => $now['utc'], ':epoch' => $now['epoch'],
            ':offset' => $now['offset'], ':timezone' => $now['timezone'], ':id' => (int)$row['id'],
        ] as $key => $value) {
            $stmt->bindValue($key, $value, is_int($value) ? SQLITE3_INTEGER : SQLITE3_TEXT);
        }
        $stmt->execute();
        educator_bump_state_revision($db);
        educator_commit($db);
        return true;
    } catch (Throwable $error) {
        educator_rollback($db);
        throw new EducatorStoreError('could not stop the current capture', 503);
    }
}

function educator_store_reset(SQLite3 $db): void {
    educator_begin($db);
    try {
        $db->exec('DELETE FROM captures');
        $db->exec('DELETE FROM folders');
        educator_bump_state_revision($db);
        educator_commit($db);
    } catch (Throwable $error) {
        educator_rollback($db);
        throw new EducatorStoreError('could not reset educator data', 503);
    }
}

/** Full bounded validation used before accepting a restored educator store. */
function educator_store_validate_integrity(SQLite3 $db, ?array $birdsSnapshot = null): void {
    try {
        $check = $db->querySingle('PRAGMA integrity_check(1)');
        if (!is_string($check) || $check !== 'ok') {
            throw new EducatorStoreError('educator data store integrity check failed', 503);
        }
        $foreign = $db->query('PRAGMA foreign_key_check');
        if ($foreign->fetchArray(SQLITE3_ASSOC) !== false) {
            throw new EducatorStoreError('educator data store has broken references', 503);
        }
        educator_state_revision($db);
        $folderCount = $db->querySingle('SELECT COUNT(*) FROM folders');
        if (!is_int($folderCount) || $folderCount < 0 || $folderCount > AVIAN_EDUCATOR_MAX_FOLDERS) {
            throw new EducatorStoreError('educator folder count is invalid', 503);
        }
        $folderKeys = [];
        $folders = educator_store_rows($db,
            'SELECT f.*,COUNT(c.id) AS capture_count FROM folders f '
            . 'LEFT JOIN captures c ON c.folder_id=f.id GROUP BY f.id ORDER BY f.id'
        );
        foreach ($folders as $folder) {
            $validated = educator_validate_folder_row($folder);
            $key = educator_name_key($validated['name']);
            if (isset($folderKeys[$key])) throw new EducatorStoreError('educator folder names are ambiguous', 503);
            $folderKeys[$key] = true;
            $segmentCount = $db->querySingle(
                'SELECT COUNT(*) FROM capture_segments s JOIN captures c ON c.id=s.capture_id WHERE c.folder_id='
                . $validated['id']
            );
            if (!is_int($segmentCount) || $segmentCount > AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS) {
                throw new EducatorStoreError('educator folder contains too many segments', 503);
            }
        }
        $birdsSnapshot = $birdsSnapshot ?? educator_birds_snapshot();
        $generation = $birdsSnapshot['generation'] ?? null;
        $sequenceFloor = $birdsSnapshot['sequence'] ?? null;
        if (!is_string($generation) || preg_match('/\A[a-f0-9]{32}\z/D', $generation) !== 1
            || !is_int($sequenceFloor) || $sequenceFloor < 0) {
            throw new EducatorStoreError('detections database authority is invalid', 503);
        }
        $captures = $db->query(
            'SELECT c.*,f.public_id AS folder_public_id FROM captures c '
            . 'LEFT JOIN folders f ON f.id=c.folder_id ORDER BY c.id'
        );
        $current = 0;
        while ($capture = $captures->fetchArray(SQLITE3_ASSOC)) {
            $validated = educator_validate_capture_row($capture);
            if ($validated['status'] !== 'stopped') $current++;
            $segments = educator_store_rows($db,
                'SELECT * FROM capture_segments WHERE capture_id=:id ORDER BY started_epoch,id LIMIT '
                . (AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS + 1),
                [':id' => $validated['id']]
            );
            educator_validate_capture_segments($capture, $segments);
            foreach ($segments as $segment) {
                $validatedSegment = educator_validate_segment_row($segment, $validated['id']);
                if (!hash_equals($generation, $validatedSegment['generation'])
                    || $validatedSegment['startSequence'] > $sequenceFloor) {
                    throw new EducatorStoreError('educator segment does not match the detections database', 409);
                }
            }
        }
        if ($current > 1) throw new EducatorStoreError('educator data has more than one current capture', 503);
    } catch (Throwable $error) {
        if ($error instanceof EducatorStoreError) throw $error;
        throw new EducatorStoreError('educator data store validation failed', 503);
    }
}

function educator_store_cli(array $argv): int {
    $command = $argv[1] ?? '';
    if (count($argv) !== 2 || !in_array($command, ['init', 'stop-current', 'reset-data', 'validate'], true)) {
        fwrite(STDERR, "Usage: educator-store.php init|stop-current|reset-data|validate\n");
        return 64;
    }
    $lock = null;
    $db = null;
    try {
        $lock = educator_store_lock(true);
        $birdsSnapshot = educator_birds_snapshot();
        $db = educator_store_open($command === 'init');
        if ($command === 'stop-current') educator_store_stop_current($db);
        elseif ($command === 'reset-data') educator_store_reset($db);
        educator_store_validate_integrity($db, $birdsSnapshot);
        echo json_encode(['ok' => true, 'command' => $command]) . "\n";
        return 0;
    } catch (Throwable $error) {
        fwrite(STDERR, json_encode(['ok' => false, 'error' => $error->getMessage()]) . "\n");
        return 1;
    } finally {
        if ($db instanceof SQLite3) $db->close();
        educator_store_unlock($lock);
    }
}

if (PHP_SAPI === 'cli'
    && isset($_SERVER['SCRIPT_FILENAME'])
    && realpath((string)$_SERVER['SCRIPT_FILENAME']) === __FILE__
    && !defined('AVIAN_EDUCATOR_STORE_LIBRARY_ONLY')) {
    exit(educator_store_cli($argv));
}
