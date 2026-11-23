<?php
declare(strict_types=1);
require_once __DIR__ . '/educator-store.php';

// An implicit SQLite rowid alone can be reused after a delete. Bind the
// selection to the displayed event AND database (including clear/restore).
function detection_correction_binding_sql(SQLite3 $db, bool $main, $databaseStream): string {
    // Never initialize Educators on a station that has not enabled it. Where
    // it exists its generation and insertion sequence distinguish even a
    // byte-identical reimport into the very same rowid.
    $tables = $db->querySingle("SELECT COUNT(*) FROM main.sqlite_master WHERE type='table' "
        . "AND name IN ('avian_detection_sequence','avian_metadata')");
    if ($tables === 0) {
        // The sqlite_master read above pins a snapshot. In rollback-journal
        // mode its on-disk header cannot change until this transaction ends.
        // With no insertion sequence, invalidate ALL selections on any DB
        // change; otherwise an identical reinsert into a reused rowid wins.
        // In WAL mode the main-file header can lag committed transactions.
        $mode = $db->querySingle('PRAGMA main.journal_mode');
        if (!in_array($mode, ['delete', 'persist', 'truncate'], true)
            || !is_resource($databaseStream)) return 'NULL';
        $header = fread($databaseStream, 100);
        if (!is_string($header) || strlen($header) !== 100
            || substr($header, 0, 16) !== "SQLite format 3\0"
            || substr($header, 18, 2) !== "\x01\x01"
            || substr($header, 24, 4) !== substr($header, 92, 4)) return 'NULL';
        // The only text inserted in this SQL literal is a hex digest.
        return "'" . hash('sha256', $header) . "'";
    }
    if ($tables !== 2) return 'NULL';
    try {
        educator_birds_generation_from_db($db);
        educator_birds_sequence_authority($db, false);
    } catch (EducatorStoreError $error) {
        return 'NULL'; // Incomplete authority must never make a row actionable.
    }
    $id = $main ? 'd.rowid' : 'd.detection_id';
    return "(SELECT value FROM main.avian_metadata WHERE key='educator_generation') || ':' || "
        . "(SELECT sequence FROM main.avian_detection_sequence WHERE detection_rowid=$id)";
}

function detection_correction_key(array $stat, string $sci, array $row): string {
    return hash('sha256', serialize([
        $stat['dev'], $stat['ino'], $row['detection_id'], $sci, $row['d'], $row['t'],
        $row['file'], $row['conf'] === null ? null : pack('E', (float)$row['conf']), $row['binding'],
    ]));
}

function valid_correction_selection($value): bool {
    return is_array($value) && count($value) === 2
        && is_int($value['id'] ?? null) && $value['id'] > 0
        && is_string($value['key'] ?? null) && preg_match('/\A[a-f0-9]{64}\z/D', $value['key']) === 1;
}

// Invoked only by the fixed station-user command. No media paths or user SQL.
if (PHP_SAPI === 'cli' && isset($_SERVER['SCRIPT_FILENAME'])
    && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    try {
        if ($argc !== 1 || !function_exists('posix_geteuid') || posix_geteuid() === 0) exit(1);
        $input = stream_get_contents(STDIN, 513);
        $selection = json_decode($input, true);
        if (strlen($input) > 512 || !valid_correction_selection($selection)) exit(1);
        $path = dirname(__DIR__, 2) . '/scripts/birds.db';
        if (is_link($path)) exit(1);
        // Keep this descriptor open until AFTER SQLite releases its locks:
        // on POSIX an unrelated close on the same inode releases process locks.
        $stream = fopen($path, 'rb');
        $stat = $stream ? fstat($stream) : false;
        if (!$stat || ($stat['mode'] & 0170000) !== 0100000) exit(1);
        $db = new SQLite3($path, SQLITE3_OPEN_READWRITE);
        $db->enableExceptions(true);
        $db->busyTimeout(2500);
        $db->exec('BEGIN IMMEDIATE');
        $binding = detection_correction_binding_sql($db, true, $stream);
        $stmt = $db->prepare('SELECT rowid AS detection_id, Sci_Name AS sci, Date AS d, Time AS t, '
            . "File_Name AS file, Confidence AS conf, $binding AS binding FROM detections d WHERE rowid=:id");
        $stmt->bindValue(':id', $selection['id'], SQLITE3_INTEGER);
        $rows = $stmt->execute();
        $row = $rows->fetchArray(SQLITE3_ASSOC);
        $rows->finalize();
        if (!$row || $row['binding'] === null
            || !hash_equals(detection_correction_key($stat, $row['sci'], $row), $selection['key'])) {
            $db->exec('ROLLBACK');
            exit(2);
        }
        $stmt = $db->prepare('DELETE FROM detections WHERE rowid=:id');
        $stmt->bindValue(':id', $selection['id'], SQLITE3_INTEGER);
        $stmt->execute()->finalize();
        if ($db->changes() !== 1) throw new RuntimeException();
        $db->exec('COMMIT');
    } catch (Throwable $error) {
        if (isset($db)) {
            try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
        }
        exit(1);
    }
}
