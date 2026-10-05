<?php
// Resolve Educators capture/folder scopes and build a read-only detections view.

declare(strict_types=1);

require_once __DIR__ . '/educator-state.php';
require_once __DIR__ . '/educator-store.php';

// A scoped request builds a full-schema TEMP relation before running one API
// action. Twenty thousand rows keeps that relation and its indexes bounded on
// 512 MB Pis, including the dashboard's eight parallel actions. The extra row
// requested below is only an overflow sentinel and is never served.
const AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS = 20000;
// One query per disjoint interval is predictable on small Pis. A ceiling of
// 512 leaves room for more than two school years of one period per weekday,
// while rejecting pathological pause/resume histories before SQLite work.
const AVIAN_EDUCATOR_SCOPE_MAX_SLICES = 512;

final class EducatorScopeError extends RuntimeException {
    public int $httpStatus;

    public function __construct(string $message, int $httpStatus = 400) {
        parent::__construct($message);
        $this->httpStatus = $httpStatus;
    }
}

function educator_scope_raw_parameter_count(string $name, ?string $rawQuery = null): ?int {
    if ($rawQuery === null) {
        if (!array_key_exists('QUERY_STRING', $_SERVER)) return null;
        if (!is_string($_SERVER['QUERY_STRING'])) return -1;
        $rawQuery = $_SERVER['QUERY_STRING'];
    }
    $count = 0;
    foreach (preg_split('/[&;]/', $rawQuery) ?: [] as $part) {
        $separator = strpos($part, '=');
        $rawKey = $separator === false ? $part : substr($part, 0, $separator);
        $key = rawurldecode(str_replace('+', ' ', $rawKey));
        $normalized = [];
        // PHP folds bracket and NUL-suffixed keys into the same top-level
        // name. Any such alias makes a bearer URL ambiguous.
        parse_str($rawKey . '=1', $normalized);
        if (array_key_exists($name, $normalized) && $key !== $name) return -1;
        if ($key === $name) $count++;
    }
    return $count;
}

function educator_scope_requested(array $query, ?string $rawQuery = null): array {
    $present = array_key_exists('edu', $query);
    $rawCount = educator_scope_raw_parameter_count('edu', $rawQuery);
    if ($rawCount !== null && $rawCount !== ($present ? 1 : 0)) {
        throw new EducatorScopeError('educator scope is invalid', 400);
    }
    if (!$present) return ['present' => false, 'value' => null];
    if (!is_string($query['edu'])
        || ($query['edu'] !== 'active' && !educator_valid_public_id($query['edu']))) {
        throw new EducatorScopeError('educator scope is invalid', 400);
    }
    return ['present' => true, 'value' => $query['edu']];
}

/**
 * A saved capture/folder id is an unlisted read-only capability outside the
 * direct LAN. The literal `active` marker has its own public scope contract.
 */
function educator_saved_scope_requested(array $query): bool {
    if (!array_key_exists('edu', $query)) return false;
    $rawCount = educator_scope_raw_parameter_count('edu');
    return ($rawCount !== null && $rawCount !== 1)
        || !is_string($query['edu'])
        || $query['edu'] !== 'active';
}

/** Keep public capability failures uniform without hiding operational 5xxs. */
function educator_public_scope_error(EducatorScopeError $error, bool $publicCapability): array {
    if (!$publicCapability) return [$error->httpStatus, $error->getMessage()];
    if ($error->httpStatus === 400 || $error->httpStatus === 404) return [404, 'not found'];
    return [$error->httpStatus, 'saved view unavailable'];
}

function educator_scope_segments(SQLite3 $db, string $kind, int $internalId): array {
    if ($kind === 'capture') {
        $capture = educator_store_one($db, 'SELECT * FROM captures WHERE id=:id', [':id' => $internalId]);
        if (!is_array($capture)) throw new EducatorScopeError('educator capture metadata is invalid', 503);
        $rows = educator_store_rows($db,
            'SELECT s.* FROM capture_segments s WHERE s.capture_id=:id ORDER BY s.started_epoch,s.id LIMIT '
            . (AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS + 1),
            [':id' => $internalId]
        );
        if (count($rows) > AVIAN_EDUCATOR_CAPTURE_MAX_SEGMENTS) {
            throw new EducatorScopeError('capture has too many listening segments', 413);
        }
        try {
            educator_validate_capture_segments($capture, $rows);
        } catch (EducatorStoreError $error) {
            throw new EducatorScopeError($error->getMessage(), $error->httpStatus);
        }
        return $rows;
    }
    $folder = educator_store_one($db, 'SELECT * FROM folders WHERE id=:id', [':id' => $internalId]);
    if (!is_array($folder)) throw new EducatorScopeError('educator folder metadata is invalid', 503);
    try { educator_validate_folder_row($folder); }
    catch (EducatorStoreError $error) { throw new EducatorScopeError($error->getMessage(), $error->httpStatus); }
    $captures = educator_store_rows($db,
        'SELECT * FROM captures WHERE folder_id=:id ORDER BY started_epoch,id LIMIT '
        . (AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS + 1),
        [':id' => $internalId]
    );
    if (count($captures) > AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS) {
        throw new EducatorScopeError('folder has too many listening periods; split it into smaller folders', 413);
    }
    $rows = educator_store_rows($db,
        'SELECT s.* FROM capture_segments s JOIN captures c ON c.id=s.capture_id '
        . 'WHERE c.folder_id=:id ORDER BY s.started_epoch,s.id LIMIT '
        . (AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS + 1),
        [':id' => $internalId]
    );
    if (count($rows) > AVIAN_EDUCATOR_FOLDER_MAX_SEGMENTS) {
        throw new EducatorScopeError('folder has too many listening segments; split it into smaller folders', 413);
    }
    $grouped = [];
    foreach ($rows as $segment) $grouped[$segment['capture_id']][] = $segment;
    try {
        foreach ($captures as $capture) {
            $captureId = educator_stored_int($capture, 'id', 1);
            educator_validate_capture_segments($capture, $grouped[$captureId] ?? []);
        }
    } catch (EducatorStoreError $error) {
        throw new EducatorScopeError($error->getMessage(), $error->httpStatus);
    }
    return $rows;
}

/**
 * The returned internal `_lock` intentionally stays held until
 * educator_scope_release(). This prevents Stop/Delete from changing the
 * scope between validation and the final query or media membership check.
 */
function educator_resolve_scope(
    array $query,
    bool $allowAutomatic = true,
    ?string $rawQuery = null
): ?array {
    $requested = educator_scope_requested($query, $rawQuery);
    $lock = null;
    $db = null;
    try {
        // The root lifecycle helper holds this lock while creating/removing
        // the persistent maintenance marker. Check it before every early
        // return, including the disabled global path, so a crash-mid-restore
        // can never expose a partially swapped station dataset.
        $lock = educator_store_lock(false);
        educator_assert_no_maintenance_marker();
        $profile = educator_profile_state();
        if (empty($profile['valid']) || empty($profile['enabled'])) {
            educator_store_unlock($lock);
            $lock = null;
            if ($requested['present']) throw new EducatorScopeError('educator scope was not found', 404);
            return null;
        }
        $db = educator_store_open(false);
        $automatic = false;
        $publicActive = false;
        $row = null;
        $kind = '';
        if ($requested['present']) {
            $publicId = (string)$requested['value'];
            if ($publicId === 'active') {
                $kind = 'capture';
                $row = educator_current_capture_row($db);
                $automatic = true;
                $publicActive = true;
            } elseif (str_starts_with($publicId, 'c_')) {
                $kind = 'capture';
                $row = educator_capture_row($db, $publicId);
            } else {
                $kind = 'folder';
                $row = educator_folder_row($db, $publicId);
            }
            if (!$row) throw new EducatorScopeError('educator scope was not found', 404);
        } elseif ($allowAutomatic) {
            $row = educator_current_capture_row($db);
            if (!$row) {
                $db->close();
                educator_store_unlock($lock);
                return null;
            }
            $kind = 'capture';
            $automatic = true;
            $publicActive = true;
        } else {
            $db->close();
            educator_store_unlock($lock);
            return null;
        }

        $segments = educator_scope_segments($db, $kind, (int)$row['id']);
        if ($kind === 'capture') educator_validate_capture_row($row);
        else educator_validate_folder_row($row);
        $stateRevision = educator_state_revision($db);
        $scope = [
            'id' => (string)$row['public_id'],
            'kind' => $kind,
            'label' => (string)$row['name'],
            'revision' => (int)$row['revision'],
            'status' => $kind === 'capture' ? (string)$row['status'] : 'saved',
            'automatic' => $automatic,
            'state_revision' => $stateRevision,
            'state_key' => substr(hash(
                'sha256',
                'avian-educator-scope-v1:' . (int)$profile['epoch'] . ':' . $stateRevision . ':'
                . (string)$row['public_id'] . ':' . (int)$row['revision']
            ), 0, 24),
            '_public_active' => $publicActive,
            '_saved_capability' => $requested['present'] && !$publicActive,
            '_segments' => $segments,
            '_lock' => $lock,
        ];
        $db->close();
        return $scope;
    } catch (Throwable $error) {
        if ($db instanceof SQLite3) $db->close();
        educator_store_unlock($lock);
        if ($error instanceof EducatorScopeError) throw $error;
        if ($error instanceof EducatorStoreError) {
            throw new EducatorScopeError($error->getMessage(), $error->httpStatus);
        }
        throw new EducatorScopeError('educator scope is unavailable', 503);
    }
}

function educator_scope_public(?array $scope, bool $includePrivate = true): ?array {
    if ($scope === null) return null;
    $public = [
        'kind' => $scope['kind'],
        'revision' => $scope['revision'],
        'status' => $scope['status'],
        'automatic' => $scope['automatic'],
        'state_revision' => $scope['state_revision'],
        'state_key' => $scope['state_key'],
    ];
    if ($includePrivate && empty($scope['_public_active'])) {
        $public['id'] = $scope['id'];
        $public['label'] = $scope['label'];
        if (isset($scope['_birds_generation'])) $public['generation'] = $scope['_birds_generation'];
    }
    return $public;
}

function educator_scope_release(?array &$scope): void {
    if ($scope === null) return;
    educator_store_unlock($scope['_lock'] ?? null);
    unset($scope['_lock']);
}

/**
 * Drop the request-local detections relation regardless of whether a previous
 * call created it as a view (global) or a materialized table (scoped).
 */
function educator_scope_drop_temp_detections(SQLite3 $birdsDb): void {
    $type = $birdsDb->querySingle(
        "SELECT type FROM sqlite_temp_master WHERE name='detections' LIMIT 1"
    );
    if ($type === 'view') $birdsDb->exec('DROP VIEW temp.detections');
    elseif ($type === 'table') $birdsDb->exec('DROP TABLE temp.detections');
}

function educator_scope_materialize_sql(bool $closed): string {
    return 'INSERT OR IGNORE INTO temp.detections '
        . 'SELECT d.rowid,d.Date,d.Time,d.Sci_Name,d.Com_Name,d.Confidence,d.Lat,d.Lon,'
        . 'd.Cutoff,d.Week,d.Sens,d.Overlap,d.File_Name '
        . 'FROM main.detections AS d INDEXED BY detections_Date_Time '
        . 'JOIN main.' . AVIAN_DETECTION_SEQUENCE_TABLE . ' q ON q.detection_rowid=d.rowid '
        . 'WHERE q.sequence>:sequence AND (d.Date,d.Time)>=(:started_date,:started_time)'
        . ($closed ? ' AND (d.Date,d.Time)<(:stopped_date,:stopped_time)' : '')
        . ' LIMIT :scope_limit';
}

/** A narrow indexed scan for the saved-scope change probe. */
function educator_scope_probe_sql(bool $closed): string {
    return 'INSERT OR IGNORE INTO temp.educator_scope_probe_hits(detection_id,sequence) '
        . 'SELECT d.rowid,q.sequence '
        . 'FROM main.detections AS d INDEXED BY detections_Date_Time '
        . 'JOIN main.' . AVIAN_DETECTION_SEQUENCE_TABLE . ' q ON q.detection_rowid=d.rowid '
        . 'WHERE q.sequence>:sequence AND (d.Date,d.Time)>=(:started_date,:started_time)'
        . ($closed ? ' AND (d.Date,d.Time)<(:stopped_date,:stopped_time)' : '')
        . ' LIMIT :scope_limit';
}

/** Return the smallest active insertion-sequence floor in O(log n) amortized time. */
function educator_scope_active_floor(SplPriorityQueue $floors, array $active): ?int {
    while (!$floors->isEmpty()) {
        $top = $floors->top();
        $key = $top['data']['key'] ?? null;
        $sequence = $top['data']['sequence'] ?? null;
        if (is_int($key) && is_int($sequence)
            && isset($active[$key]) && $active[$key] === $sequence) {
            return $sequence;
        }
        $floors->extract();
    }
    return null;
}

/**
 * Normalize a union of [started_local, stopped_local) predicates before SQL.
 * Within a wall-time slice, `sequence > min(active start_sequence)` is exactly
 * the union membership predicate. BirdNET stores Date and Time as local wall
 * values, so offset changes remain represented by the validated boundaries.
 * A non-increasing wall interval is empty under the same half-open SQL rule.
 */
function educator_scope_normalized_segments(array $segments): array {
    $events = [];
    foreach (array_values($segments) as $key => $row) {
        $segment = educator_validate_segment_row($row);
        $start = $segment['started']['local'];
        $stop = $segment['stopped']['local'] ?? null;
        if ($stop !== null && strcmp($stop, $start) <= 0) continue;
        $events[$start]['starts'][] = ['key' => $key, 'sequence' => $segment['startSequence']];
        if ($stop !== null) $events[$stop]['stops'][] = $key;
    }
    if ($events === []) return [];
    ksort($events, SORT_STRING);

    $active = [];
    $floors = new SplPriorityQueue();
    $floors->setExtractFlags(SplPriorityQueue::EXTR_BOTH);
    $slices = [];
    $previous = null;
    foreach ($events as $time => $changes) {
        if ($previous !== null && strcmp($previous, $time) < 0) {
            $floor = educator_scope_active_floor($floors, $active);
            if ($floor !== null) {
                $last = count($slices) - 1;
                if ($last >= 0
                    && $slices[$last]['start_sequence'] === $floor
                    && $slices[$last]['stopped_local'] === $previous) {
                    $slices[$last]['stopped_local'] = $time;
                } else {
                    if (count($slices) >= AVIAN_EDUCATOR_SCOPE_MAX_SLICES) {
                        throw new EducatorScopeError(
                            'educator scope has too many separate listening intervals; select a smaller folder',
                            413
                        );
                    }
                    $slices[] = [
                        'started_local' => $previous,
                        'stopped_local' => $time,
                        'start_sequence' => $floor,
                    ];
                }
            }
        }
        // Starts precede stops at the same wall second. This preserves the
        // half-open rule and leaves a zero-duration [t,t) segment inactive.
        foreach ($changes['starts'] ?? [] as $start) {
            $active[$start['key']] = $start['sequence'];
            $floors->insert($start, -$start['sequence']);
        }
        foreach ($changes['stops'] ?? [] as $key) unset($active[$key]);
        $previous = $time;
    }

    $floor = educator_scope_active_floor($floors, $active);
    if ($floor !== null && $previous !== null) {
        $last = count($slices) - 1;
        if ($last >= 0
            && $slices[$last]['start_sequence'] === $floor
            && $slices[$last]['stopped_local'] === $previous) {
            $slices[$last]['stopped_local'] = null;
        } else {
            if (count($slices) >= AVIAN_EDUCATOR_SCOPE_MAX_SLICES) {
                throw new EducatorScopeError(
                    'educator scope has too many separate listening intervals; select a smaller folder',
                    413
                );
            }
            $slices[] = [
                'started_local' => $previous,
                'stopped_local' => null,
                'start_sequence' => $floor,
            ];
        }
    }
    return $slices;
}

/**
 * Return a bounded, opaque change signal without building the full scoped
 * detections relation. The private generation and capability id keep the
 * exact count and sequence out of the public response.
 *
 * @return array{open:bool,fingerprint:string}
 */
function educator_scope_probe(SQLite3 $birdsDb, array &$scope): array {
    $generation = educator_birds_generation_from_db($birdsDb);
    educator_birds_sequence_authority($birdsDb, false);
    foreach ($scope['_segments'] as $segment) {
        if (!hash_equals($generation, (string)($segment['birds_generation'] ?? ''))) {
            throw new EducatorScopeError(
                'educator scope belongs to a different detections database',
                409
            );
        }
    }
    $scope['_birds_generation'] = $generation;
    $segments = educator_scope_normalized_segments($scope['_segments']);
    $birdsDb->exec('DROP TABLE IF EXISTS temp.educator_scope_probe_hits');
    $birdsDb->exec(
        'CREATE TEMP TABLE educator_scope_probe_hits('
        . 'detection_id INTEGER PRIMARY KEY,sequence INTEGER NOT NULL)'
    );

    $inserts = [];
    $materialized = 0;
    foreach ($segments as $segment) {
        $started = educator_wall_parts($segment['started_local']);
        $stopped = $segment['stopped_local'] === null
            ? null
            : educator_wall_parts($segment['stopped_local']);
        $insertKey = $stopped === null ? 'open' : 'closed';
        if (!isset($inserts[$insertKey])) {
            $inserts[$insertKey] = $birdsDb->prepare(educator_scope_probe_sql($stopped !== null));
        }
        $insert = $inserts[$insertKey];
        $insert->bindValue(':sequence', $segment['start_sequence'], SQLITE3_INTEGER);
        $insert->bindValue(':started_date', $started['date'], SQLITE3_TEXT);
        $insert->bindValue(':started_time', $started['time'], SQLITE3_TEXT);
        if ($stopped !== null) {
            $insert->bindValue(':stopped_date', $stopped['date'], SQLITE3_TEXT);
            $insert->bindValue(':stopped_time', $stopped['time'], SQLITE3_TEXT);
        }
        $remaining = AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS - $materialized;
        $insert->bindValue(':scope_limit', $remaining + 1, SQLITE3_INTEGER);
        $result = $insert->execute();
        if ($result instanceof SQLite3Result) $result->finalize();
        $materialized += $birdsDb->changes();
        $insert->reset();
        if ($materialized > AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS) {
            $inserts = [];
            throw new EducatorScopeError(
                'educator scope has too many detections; select a smaller folder',
                413
            );
        }
    }
    $inserts = [];
    $summary = educator_store_one(
        $birdsDb,
        'SELECT COUNT(*) AS detection_count,COALESCE(MAX(sequence),0) AS max_sequence '
            . 'FROM temp.educator_scope_probe_hits'
    );
    $count = is_array($summary) ? ($summary['detection_count'] ?? null) : null;
    $maxSequence = is_array($summary) ? ($summary['max_sequence'] ?? null) : null;
    if (!is_int($count) || $count < 0 || $count > AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS
        || !is_int($maxSequence) || $maxSequence < 0) {
        throw new EducatorScopeError('educator scope probe is unavailable', 503);
    }
    $open = false;
    foreach ($segments as $segment) {
        if ($segment['stopped_local'] === null) {
            $open = true;
            break;
        }
    }
    return [
        'open' => $open,
        'fingerprint' => substr(hash(
            'sha256',
            'avian-educator-scope-probe-v1:' . $generation . ':' . (string)$scope['id']
                . ':' . $count . ':' . $maxSequence
        ), 0, 24),
    ];
}

/**
 * Return `detections` globally or a request-local materialized table when
 * scoped. Each segment is populated through BirdNET's Date/Time index, then
 * all API queries operate only on the eligible rows.
 */
function educator_scope_detection_table(SQLite3 $birdsDb, ?array &$scope): string {
    educator_scope_drop_temp_detections($birdsDb);
    if ($scope === null) {
        $birdsDb->exec(
            'CREATE TEMP VIEW detections AS SELECT d.rowid AS detection_id,d.* FROM main.detections d'
        );
        return 'detections';
    }
    $generation = educator_birds_generation_from_db($birdsDb);
    educator_birds_sequence_authority($birdsDb, false);
    foreach ($scope['_segments'] as $segment) {
        if (!hash_equals($generation, (string)($segment['birds_generation'] ?? ''))) {
            throw new EducatorScopeError(
                'educator scope belongs to a different detections database',
                409
            );
        }
    }
    $scope['_birds_generation'] = $generation;
    $normalizedSegments = educator_scope_normalized_segments($scope['_segments']);
    $birdsDb->exec(
        'CREATE TEMP TABLE detections('
        . 'detection_id INTEGER PRIMARY KEY,Date DATE,Time TIME,Sci_Name TEXT NOT NULL,'
        . 'Com_Name TEXT NOT NULL,Confidence REAL,Lat REAL,Lon REAL,Cutoff REAL,Week INTEGER,'
        . 'Sens REAL,Overlap REAL,File_Name TEXT NOT NULL)'
    );
    $inserts = [];
    $materialized = 0;
    foreach ($normalizedSegments as $segment) {
        $started = educator_wall_parts($segment['started_local']);
        $stopped = $segment['stopped_local'] === null
            ? null
            : educator_wall_parts($segment['stopped_local']);
        $insertKey = $stopped === null ? 'open' : 'closed';
        if (!isset($inserts[$insertKey])) {
            $inserts[$insertKey] = $birdsDb->prepare(educator_scope_materialize_sql($stopped !== null));
        }
        $insert = $inserts[$insertKey];
        $insert->bindValue(':sequence', $segment['start_sequence'], SQLITE3_INTEGER);
        $insert->bindValue(':started_date', $started['date'], SQLITE3_TEXT);
        $insert->bindValue(':started_time', $started['time'], SQLITE3_TEXT);
        if ($stopped !== null) {
            $insert->bindValue(':stopped_date', $stopped['date'], SQLITE3_TEXT);
            $insert->bindValue(':stopped_time', $stopped['time'], SQLITE3_TEXT);
        }
        $remaining = AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS - $materialized;
        $insert->bindValue(':scope_limit', $remaining + 1, SQLITE3_INTEGER);
        $insert->execute();
        $materialized += $birdsDb->changes();
        $insert->reset();
        if ($materialized > AVIAN_EDUCATOR_SCOPE_MAX_DETECTIONS) {
            $inserts = [];
            throw new EducatorScopeError(
                'educator scope has too many detections; select a smaller folder',
                413
            );
        }
    }
    $inserts = [];
    $birdsDb->exec('CREATE INDEX educator_scope_date_time ON detections(Date DESC,Time DESC)');
    $birdsDb->exec('CREATE INDEX educator_scope_sci_name ON detections(Sci_Name)');
    return 'detections';
}

function educator_scope_recheck_generation(SQLite3 $birdsDb, ?array $scope): void {
    if ($scope === null) return;
    $expected = (string)($scope['_birds_generation'] ?? '');
    $actual = educator_birds_generation_from_db($birdsDb);
    educator_birds_sequence_authority($birdsDb, false);
    if ($expected === '' || !hash_equals($expected, $actual)) {
        throw new EducatorScopeError('detections database changed during the request', 409);
    }
}

function educator_scope_detection_row(SQLite3 $birdsDb, int $detectionId): ?array {
    if ($detectionId < 1) return null;
    $stmt = $birdsDb->prepare(
        'SELECT detection_id,Date,Time,Com_Name,Sci_Name,File_Name '
        . 'FROM temp.detections WHERE detection_id=:id LIMIT 1'
    );
    $stmt->bindValue(':id', $detectionId, SQLITE3_INTEGER);
    $result = $stmt->execute();
    $row = $result->fetchArray(SQLITE3_ASSOC);
    return is_array($row) ? $row : null;
}

function educator_scope_dir_key(string $value): string {
    $lower = function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
    return preg_replace('/[^\p{L}\p{N}]/u', '', $lower) ?? '';
}

function educator_configured_extracted_root(array $server): ?string {
    $value = $server['AVIAN_EXTRACTED_ROOT'] ?? null;
    if (PHP_SAPI === 'cli') {
        $override = getenv('AVIAN_EXTRACTED_ROOT');
        if (is_string($override) && $override !== '') $value = $override;
    }
    if (!is_string($value) || $value === '' || strlen($value) > 4096
        || $value[0] !== '/' || strpbrk($value, "\0\r\n") !== false
        || preg_match('~(?:\A|/)\.\.(?:/|\z)~D', $value) === 1
        || is_link($value)) return null;
    $root = realpath($value);
    if (!is_string($root) || !is_dir($root) || !hash_equals(rtrim($value, '/'), $root)) return null;
    $stat = @lstat($root);
    if (!is_array($stat) || (($stat['mode'] ?? 0) & 0170000) !== 0040000) return null;
    $byDate = realpath($root . '/By_Date');
    if (!is_string($byDate) || !is_dir($byDate) || !str_starts_with($byDate . '/', $root . '/')) return null;
    return $root;
}

/** Return a verified open file and byte count for one exact scoped row. */
function educator_scope_open_media(
    array $row,
    string $kind,
    string $byDateRoot,
    ?array &$directoryCache = null,
    bool $freeze = true
): ?array {
    $date = (string)($row['Date'] ?? '');
    $common = (string)($row['Com_Name'] ?? '');
    $file = (string)($row['File_Name'] ?? '');
    if (preg_match('/\A\d{4}-\d{2}-\d{2}\z/D', $date) !== 1
        || $common === '' || strlen($common) > 200
        || $file === '' || strlen($file) > 512
        || strpos($file, '..') !== false
        || preg_match("/\A[\\p{L}\\p{N}_.:'-]+[.]mp3\z/uD", $file) !== 1
        || !in_array($kind, ['recording', 'spectrogram'], true)) {
        return null;
    }
    $root = realpath($byDateRoot);
    $day = realpath($byDateRoot . '/' . $date);
    if (!is_string($root) || !is_string($day) || !is_dir($day)
        || !str_starts_with($day . '/', $root . '/')) return null;
    $wanted = educator_scope_dir_key($common);
    if ($wanted === '') return null;
    if ($directoryCache === null) $directoryCache = ['days' => [], 'entries' => 0];
    if (!array_key_exists($date, $directoryCache['days'])) {
        if (count($directoryCache['days']) >= 4096) {
            throw new EducatorScopeError('recording export spans too many dates', 413);
        }
        $index = [];
        foreach (scandir($day) ?: [] as $entry) {
            if ($entry === '.' || $entry === '..') continue;
            $candidate = $day . '/' . $entry;
            if (!is_dir($candidate) || is_link($candidate)) continue;
            $key = educator_scope_dir_key($entry);
            if ($key === '') continue;
            $resolved = realpath($candidate);
            if (!is_string($resolved) || !str_starts_with($resolved . '/', $day . '/')) continue;
            $index[$key] = array_key_exists($key, $index) ? false : $resolved;
            $directoryCache['entries']++;
            if ($directoryCache['entries'] > 32768) {
                throw new EducatorScopeError('recording directory index is too large', 413);
            }
        }
        $directoryCache['days'][$date] = $index;
    }
    $speciesDir = $directoryCache['days'][$date][$wanted] ?? null;
    if (!is_string($speciesDir) || !str_starts_with($speciesDir . '/', $day . '/')) return null;
    $leaf = $kind === 'recording' ? $file : $file . '.png';
    $candidate = $speciesDir . '/' . $leaf;
    clearstatcache(true, $candidate);
    $before = @lstat($candidate);
    if (!is_array($before) || (($before['mode'] ?? 0) & 0170000) !== 0100000
        || (int)($before['nlink'] ?? 0) !== 1
        || (int)($before['size'] ?? -1) < 64
        || (int)($before['size'] ?? -1) > ($kind === 'recording' ? 67108864 : 5242880)) return null;
    $handle = @fopen($candidate, 'rb');
    $opened = is_resource($handle) ? fstat($handle) : false;
    clearstatcache(true, $candidate);
    $after = @lstat($candidate);
    if (!is_resource($handle) || !is_array($opened) || !is_array($after)
        || (($opened['mode'] ?? 0) & 0170000) !== 0100000
        || (int)$opened['dev'] !== (int)$before['dev'] || (int)$opened['ino'] !== (int)$before['ino']
        || (int)$after['dev'] !== (int)$before['dev'] || (int)$after['ino'] !== (int)$before['ino']
        || (int)$opened['nlink'] !== 1
        || (int)$opened['size'] !== (int)$before['size']) {
        if (is_resource($handle)) fclose($handle);
        return null;
    }
    educator_store_test_hook('media-after-open');
    $prefix = fread($handle, 8);
    $validSignature = $kind === 'spectrogram'
        ? $prefix === "\x89PNG\r\n\x1a\n"
        : is_string($prefix) && (str_starts_with($prefix, 'ID3')
            || (strlen($prefix) >= 2 && ord($prefix[0]) === 0xff && (ord($prefix[1]) & 0xe0) === 0xe0));
    $verified = fstat($handle);
    if (!$validSignature || !is_array($verified)
        || (int)$verified['dev'] !== (int)$opened['dev']
        || (int)$verified['ino'] !== (int)$opened['ino']
        || (int)$verified['size'] !== (int)$opened['size']) {
        fclose($handle);
        return null;
    }
    rewind($handle);
    if (!$freeze) return ['handle' => $handle, 'size' => (int)$opened['size'], 'path' => $candidate];
    $frozen = tmpfile();
    if (!is_resource($frozen)) {
        fclose($handle);
        return null;
    }
    $remaining = (int)$opened['size'];
    while ($remaining > 0) {
        $chunk = fread($handle, min(65536, $remaining));
        if (!is_string($chunk) || $chunk === '' || fwrite($frozen, $chunk) !== strlen($chunk)) {
            fclose($handle);
            fclose($frozen);
            return null;
        }
        $remaining -= strlen($chunk);
    }
    educator_store_test_hook('media-after-copy');
    $afterCopy = fstat($handle);
    fclose($handle);
    if (!is_array($afterCopy)
        || (int)$afterCopy['dev'] !== (int)$opened['dev']
        || (int)$afterCopy['ino'] !== (int)$opened['ino']
        || (int)$afterCopy['size'] !== (int)$opened['size']) {
        fclose($frozen);
        return null;
    }
    rewind($frozen);
    return ['handle' => $frozen, 'size' => (int)$opened['size'], 'path' => $candidate];
}

function educator_scope_media_fail(?array &$scope, int $status, string $message): never {
    if (!empty($scope['_saved_capability'])
        && ($status === 409 || $status === 413 || $status >= 500)) {
        $message = 'saved view unavailable';
    }
    educator_scope_release($scope);
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    echo $message;
    exit;
}

/** Serve exact row-bound media when a capture/folder scope is active. */
function educator_scope_serve_media(
    ?array &$scope,
    array $query,
    array $server,
    string $kind,
    string $birdsDbPath,
    string $byDateRoot
): void {
    if ($scope === null) return;
    if (strtoupper((string)($server['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
        header('Allow: GET');
        educator_scope_media_fail($scope, 405, 'GET required');
    }
    if (isset($server['HTTP_RANGE'])) educator_scope_media_fail($scope, 416, 'range not supported');
    $rawId = $query['detection'] ?? null;
    if (!is_string($rawId) || preg_match('/\A[1-9][0-9]{0,18}\z/D', $rawId) !== 1) {
        educator_scope_media_fail($scope, 400, 'detection required');
    }
    $detectionId = filter_var($rawId, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if (!is_int($detectionId)) educator_scope_media_fail($scope, 400, 'invalid detection');
    $media = null;
    $birdsDb = null;
    try {
        $birdsDb = new SQLite3($birdsDbPath, SQLITE3_OPEN_READONLY);
        $birdsDb->busyTimeout(2000);
        $birdsDb->exec('BEGIN');
        educator_scope_detection_table($birdsDb, $scope);
        $row = educator_scope_detection_row($birdsDb, $detectionId);
        if (!$row) {
            $birdsDb->close();
            educator_scope_media_fail($scope, 404, 'detection not found in this listening period');
        }
        if (isset($query['file']) && (!is_string($query['file'])
            || !hash_equals((string)$row['File_Name'], $query['file']))) {
            $birdsDb->close();
            educator_scope_media_fail($scope, 404, 'detection media mismatch');
        }
        if (isset($query['sci']) && (!is_string($query['sci'])
            || !hash_equals((string)$row['Sci_Name'], $query['sci']))) {
            $birdsDb->close();
            educator_scope_media_fail($scope, 404, 'detection species mismatch');
        }
        $directoryCache = null;
        $media = educator_scope_open_media($row, $kind, $byDateRoot, $directoryCache);
        if (!is_array($media)) {
            $birdsDb->close();
            educator_scope_media_fail($scope, 404, $kind . ' not found');
        }
        educator_scope_recheck_generation($birdsDb, $scope);
        $birdsDb->exec('COMMIT');
        $birdsDb->close();
        $birdsDb = null;
    } catch (EducatorScopeError $error) {
        if ($birdsDb instanceof SQLite3) {
            try { $birdsDb->exec('ROLLBACK'); } catch (Throwable $ignored) {}
            $birdsDb->close();
        }
        if (is_array($media) && is_resource($media['handle'] ?? null)) fclose($media['handle']);
        educator_scope_media_fail($scope, $error->httpStatus, $error->getMessage());
    } catch (Throwable $error) {
        if ($birdsDb instanceof SQLite3) {
            try { $birdsDb->exec('ROLLBACK'); } catch (Throwable $ignored) {}
            $birdsDb->close();
        }
        if (is_array($media) && is_resource($media['handle'] ?? null)) fclose($media['handle']);
        educator_scope_media_fail($scope, 503, 'detection media is unavailable');
    }
    educator_scope_release($scope);
    $handle = $media['handle'];
    $size = (int)$media['size'];
    header('Content-Type: ' . ($kind === 'recording' ? 'audio/mpeg' : 'image/png'));
    header('Content-Length: ' . $size);
    header('Cache-Control: private, no-store, max-age=0');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    header('Cross-Origin-Resource-Policy: same-origin');
    $remaining = $size;
    while ($remaining > 0 && !feof($handle)) {
        $chunk = fread($handle, min(65536, $remaining));
        if (!is_string($chunk) || $chunk === '') break;
        echo $chunk;
        $remaining -= strlen($chunk);
    }
    fclose($handle);
    exit;
}
