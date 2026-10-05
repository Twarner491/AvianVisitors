<?php
// AvianVisitors - bulk data export. Your detections and recordings are
// yours; this makes them easy to take somewhere and do science on.
//
// Endpoints:
//   ?what=detections            -> full detections table as CSV
//   ?what=recordings            -> every extracted clip, one tar stream
//   ?what=recordings&sci=X y    -> one species' clips, one tar stream
//
// Everything streams: the CSV is written row by row off the SQLite
// cursor and the tar comes straight from tar's stdout, so a Zero 2 W
// never holds more than a buffer in memory. mp3 doesn't compress, so
// no gzip. Same auth stance as the rest of avian/api/.

declare(strict_types=1);

require_once __DIR__ . '/admin-auth.php';
require_once __DIR__ . '/educator-scope.php';

$what = (string)($_GET['what'] ?? '');
$grant = (string)($_GET['grant'] ?? '');
$maintenanceLock = null;
try {
    $maintenanceLock = educator_store_lock(false);
    educator_assert_no_maintenance_marker();
    educator_store_unlock($maintenanceLock);
    $maintenanceLock = null;
} catch (Throwable $error) {
    educator_store_unlock($maintenanceLock);
    avian_api_fail(503, $error->getMessage());
}
$requestedEducatorScope = null;
if (array_key_exists('edu', $_GET)) {
    if (!is_string($_GET['edu'])
        || ($_GET['edu'] !== 'active' && !avian_valid_educator_scope_id($_GET['edu']))) {
        avian_api_fail(400, 'invalid educator scope');
    }
    $requestedEducatorScope = $_GET['edu'];
    if ($requestedEducatorScope !== 'active' && !avian_is_direct_local_request($_SERVER)) {
        avian_api_fail(404, 'not found');
    }
}
$grantDetails = null;
if ($grant !== '') {
    $grantDetails = avian_consume_admin_download_grant_details($_SERVER, $what, $grant);
    if (!is_array($grantDetails)) {
        avian_api_fail(401, 'download authorization expired');
    }
} else {
    avian_require_admin();
}

try {
    $educatorScope = educator_resolve_scope($_GET);
} catch (EducatorScopeError $error) {
    avian_api_fail($error->httpStatus, $error->getMessage());
}
if (is_array($grantDetails)
    && (($educatorScope['id'] ?? null) !== $grantDetails['educator_scope'])) {
    educator_scope_release($educatorScope);
    avian_api_fail(401, 'download authorization expired');
}

$BIRDNETPI_DIR = dirname(__DIR__, 2);
$DB_PATH   = educator_birds_db_path();
$EXTRACTED = dirname($BIRDNETPI_DIR) . '/BirdSongs/Extracted';
if ($what === 'recordings' && $educatorScope !== null) {
    $configuredExtracted = educator_configured_extracted_root($_SERVER);
    if ($configuredExtracted === null) {
        educator_scope_release($educatorScope);
        avian_api_fail(503, 'configured recordings directory is unavailable');
    }
    $EXTRACTED = $configuredExtracted;
}

if ($what === 'detections') {
    $db = null;
    $transactionOpen = false;
    $res = null;
    try {
        if (!file_exists($DB_PATH)) {
            throw new EducatorScopeError('birds.db not found', 503);
        }
        $db = new SQLite3($DB_PATH, SQLITE3_OPEN_READONLY);
        $db->busyTimeout(2000);
        if (!$db->exec('BEGIN')) {
            throw new RuntimeException('detections snapshot could not be opened');
        }
        $transactionOpen = true;
        educator_scope_detection_table($db, $educatorScope);
        educator_scope_recheck_generation($db, $educatorScope);
        if (!$db->exec('COMMIT')) {
            throw new RuntimeException('detections snapshot could not be prepared');
        }
        $transactionOpen = false;
        $cols = ['Date', 'Time', 'Sci_Name', 'Com_Name', 'Confidence',
                 'Lat', 'Lon', 'Cutoff', 'Week', 'Sens', 'Overlap', 'File_Name'];
        $res = $db->query('SELECT ' . implode(',', $cols) . ' FROM detections ORDER BY Date, Time');
        if (!$res instanceof SQLite3Result) {
            throw new RuntimeException('detections export could not be prepared');
        }
    } catch (EducatorScopeError $error) {
        if ($db instanceof SQLite3) {
            if ($transactionOpen) {
                try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
            }
            try { $db->close(); } catch (Throwable $ignored) {}
        }
        educator_scope_release($educatorScope);
        avian_api_fail($error->httpStatus, $error->getMessage());
    } catch (Throwable $error) {
        if ($db instanceof SQLite3) {
            if ($transactionOpen) {
                try { $db->exec('ROLLBACK'); } catch (Throwable $ignored) {}
            }
            try { $db->close(); } catch (Throwable $ignored) {}
        }
        educator_scope_release($educatorScope);
        avian_api_fail(503, 'detections export is unavailable');
    }
    educator_scope_release($educatorScope);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="detections-' . date('Y-m-d') . '.csv"');
    header('Cache-Control: no-store');
    while (ob_get_level()) ob_end_clean();
    $out = fopen('php://output', 'w');
    // Explicit escape='' writes standard RFC-4180 quoting and quiets the
    // PHP 8.4+ deprecation about the changing default.
    fputcsv($out, $cols, ',', '"', '');
    // Row-by-row off the cursor - rows() would buffer a production DB's
    // 100k+ rows into RAM. ASC order reads as a diary and the reverse
    // index scan costs nothing.
    while ($r = $res->fetchArray(SQLITE3_NUM)) {
        fputcsv($out, $r, ',', '"', '');
    }
    $db->close();
    exit;
}

if ($what === 'recordings') {
    $byDate = "$EXTRACTED/By_Date";
    if (!is_dir($byDate)) {
        http_response_code(503);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'no extracted recordings']);
        exit;
    }
    $sci = trim((string)($_GET['sci'] ?? ''));
    if ($educatorScope !== null) {
        if ($sci !== '' && !preg_match("/^[A-Z][a-z-]+ [a-z-]+$/", $sci)) {
            educator_scope_release($educatorScope);
            avian_api_fail(400, 'bad sci name');
        }
        try {
            $db = new SQLite3($DB_PATH, SQLITE3_OPEN_READONLY);
            $db->busyTimeout(2000);
            $db->exec('BEGIN');
            educator_scope_detection_table($db, $educatorScope);
            educator_scope_recheck_generation($db, $educatorScope);
            $sql = 'SELECT DISTINCT Date,Com_Name,Sci_Name,File_Name FROM detections';
            $bindSci = false;
            if ($sci !== '') {
                $sql .= ' WHERE Sci_Name=:sci';
                $bindSci = true;
            }
            $sql .= ' ORDER BY Date,File_Name';
            $stmt = $db->prepare($sql);
            if ($bindSci) $stmt->bindValue(':sci', $sci, SQLITE3_TEXT);
            $rows = $stmt->execute();
            $manifest = tmpfile();
            if (!is_resource($manifest)) throw new RuntimeException('manifest unavailable');
            $manifestBytes = 0;
            $fileCount = 0;
            $totalBytes = 0;
            $directoryCache = null;
            $root = realpath($EXTRACTED);
            if (!is_string($root)) throw new RuntimeException('recordings unavailable');
            while ($row = $rows->fetchArray(SQLITE3_ASSOC)) {
                $media = educator_scope_open_media($row, 'recording', $byDate, $directoryCache, false);
                if (!is_array($media)) continue;
                fclose($media['handle']);
                $path = (string)$media['path'];
                if (!str_starts_with($path, $root . '/')) continue;
                $relative = substr($path, strlen($root) + 1);
                $manifestBytes += strlen($relative) + 1;
                $fileCount++;
                $totalBytes += (int)$media['size'];
                if ($manifestBytes > 16777216 || $fileCount > 200000 || $totalBytes > 2147483648) {
                    fclose($manifest);
                    throw new EducatorScopeError('recording export is too large; export a smaller folder', 413);
                }
                fwrite($manifest, $relative . "\0");
            }
            if ($fileCount === 0) {
                fclose($manifest);
                avian_api_fail(404, 'no scoped recordings are currently on disk');
            }
            rewind($manifest);
            $label = $sci === '' ? 'educator-recordings' : strtolower(str_replace(' ', '-', $sci));
            educator_store_test_hook('export-before-tar');
            $tarErrors = tmpfile();
            if (!is_resource($tarErrors)) {
                fclose($manifest);
                avian_api_fail(503, 'recording export could not be started');
            }
            $tarArchive = tmpfile();
            if (!is_resource($tarArchive)) {
                fclose($manifest);
                fclose($tarErrors);
                avian_api_fail(503, 'recording export could not be staged');
            }
            $pipes = [];
            $tarBinary = '/usr/bin/tar';
            if (PHP_SAPI === 'cli'
                && isset($GLOBALS['AVIAN_EDUCATOR_TEST_TAR_BINARY'])
                && is_string($GLOBALS['AVIAN_EDUCATOR_TEST_TAR_BINARY'])) {
                $tarBinary = $GLOBALS['AVIAN_EDUCATOR_TEST_TAR_BINARY'];
            }
            $process = @proc_open(
                [$tarBinary, '-cf', '-', '-C', $EXTRACTED, '--null', '-T', '-'],
                [0 => $manifest, 1 => $tarArchive, 2 => $tarErrors],
                $pipes
            );
            if (!is_resource($process)) {
                if (is_resource($process)) proc_close($process);
                fclose($manifest);
                fclose($tarErrors);
                fclose($tarArchive);
                avian_api_fail(503, 'recording export could not be started');
            }
            fclose($manifest);
            $tarStatus = proc_close($process);
            $archiveStat = fstat($tarArchive);
            if ($tarStatus !== 0 || !is_array($archiveStat)
                || (int)($archiveStat['size'] ?? 0) < 1024
                || (int)($archiveStat['size'] ?? 0) > $totalBytes + ($fileCount + 4) * 2048) {
                rewind($tarErrors);
                $tarError = stream_get_contents($tarErrors, 2048);
                error_log('Avian Visitors scoped tar export failed: ' . trim((string)$tarError));
                fclose($tarErrors);
                fclose($tarArchive);
                throw new EducatorScopeError('recording files changed during export; try again', 409);
            }
            educator_scope_recheck_generation($db, $educatorScope);
            $db->close();
            educator_scope_release($educatorScope);
            fclose($tarErrors);
            rewind($tarArchive);
            header('Content-Type: application/x-tar');
            header('Content-Disposition: attachment; filename="' . $label . '-' . date('Y-m-d') . '.tar"');
            header('Cache-Control: no-store');
            while (ob_get_level()) ob_end_clean();
            set_time_limit(0);
            ignore_user_abort(false);
            fpassthru($tarArchive);
            fclose($tarArchive);
            exit;
        } catch (EducatorScopeError $error) {
            educator_scope_release($educatorScope);
            avian_api_fail($error->httpStatus, $error->getMessage());
        } catch (Throwable $error) {
            educator_scope_release($educatorScope);
            avian_api_fail(503, 'scoped recording export is unavailable');
        }
    }
    $label = 'recordings';
    $list = [];
    if ($sci !== '') {
        if (!preg_match("/^[A-Z][a-z-]+ [a-z-]+$/", $sci)) {
            http_response_code(400);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'bad sci name']);
            exit;
        }
        // Resolve the species' on-disk dir name (space->underscore common
        // name) from the DB, then collect its clips from every date dir.
        if (!file_exists($DB_PATH)) {
            http_response_code(503);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'birds.db not found']);
            exit;
        }
        $db = new SQLite3($DB_PATH, SQLITE3_OPEN_READONLY);
        $db->busyTimeout(2000);
        $st = $db->prepare('SELECT DISTINCT Com_Name FROM detections WHERE Sci_Name = :s');
        $st->bindValue(':s', $sci, SQLITE3_TEXT);
        $rs = $st->execute();
        // Match dirs the way recording.php does - normalized to bare
        // alphanumerics, because BirdNET-Pi isn't consistent about
        // apostrophes in species dir names (Anna's vs Annas).
        $norm = function (string $s): string {
            return preg_replace('/[^a-z0-9]/', '', strtolower($s));
        };
        $want = [];
        while ($r = $rs->fetchArray(SQLITE3_ASSOC)) {
            $want[$norm((string)$r['Com_Name'])] = true;
        }
        $db->close();
        if (!$want) {
            http_response_code(404);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'species not in your detections']);
            exit;
        }
        foreach (scandir($byDate) ?: [] as $date) {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) continue;
            foreach (scandir("$byDate/$date") ?: [] as $sub) {
                if ($sub === '.' || $sub === '..' || !is_dir("$byDate/$date/$sub")) continue;
                if (isset($want[$norm($sub)])) $list[] = "By_Date/$date/$sub";
            }
        }
        if (!$list) {
            http_response_code(404);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'no clips on disk for that species']);
            exit;
        }
        $label = strtolower(str_replace(' ', '-', $sci));
    } else {
        $list[] = 'By_Date';
    }

    header('Content-Type: application/x-tar');
    header('Content-Disposition: attachment; filename="' . $label . '-' . date('Y-m-d') . '.tar"');
    header('Cache-Control: no-store');
    while (ob_get_level()) ob_end_clean();
    set_time_limit(0);
    // tar streams from disk to stdout; -C keeps paths tidy relative to
    // Extracted/. Every path in $list was built above from validated
    // parts, and escapeshellarg guards the boundary anyway.
    $args = implode(' ', array_map('escapeshellarg', $list));
    $p = popen('tar -cf - -C ' . escapeshellarg($EXTRACTED) . ' ' . $args, 'r');
    if ($p) {
        fpassthru($p);
        pclose($p);
    }
    exit;
}

http_response_code(400);
header('Content-Type: application/json; charset=utf-8');
echo json_encode(['error' => 'what=detections or what=recordings']);
