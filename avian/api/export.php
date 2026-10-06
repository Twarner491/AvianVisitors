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

function avian_bundle_export_fail(string $error, int $status): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('Pragma: no-cache');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'");
    echo json_encode(['error' => $error], JSON_UNESCAPED_SLASHES);
    exit;
}

function avian_bundle_export_stop($process): ?int {
    @proc_terminate($process, 15);
    $deadline = microtime(true) + 2.0;
    do {
        $status = proc_get_status($process);
        if (is_array($status) && empty($status['running'])) {
            return is_int($status['exitcode']) && $status['exitcode'] >= 0
                ? $status['exitcode'] : null;
        }
        usleep(20000);
    } while (microtime(true) < $deadline);
    @proc_terminate($process, 9);
    $deadline = microtime(true) + 1.0;
    do {
        $status = proc_get_status($process);
        if (is_array($status) && empty($status['running'])) {
            return is_int($status['exitcode']) && $status['exitcode'] >= 0
                ? $status['exitcode'] : null;
        }
        usleep(20000);
    } while (microtime(true) < $deadline);
    return null;
}

/** @return array{code:?int,stdout:string,stderr:string,failed:bool} */
function avian_bundle_export_process(array $command, int $timeoutSeconds): array {
    if (!function_exists('proc_open') || count($command) < 1 || count($command) > 32) {
        return ['code' => null, 'stdout' => '', 'stderr' => '', 'failed' => true];
    }
    foreach ($command as $argument) {
        if (!is_string($argument) || strlen($argument) > 2048 || str_contains($argument, "\0")) {
            return ['code' => null, 'stdout' => '', 'stderr' => '', 'failed' => true];
        }
    }
    $pipes = [];
    $process = @proc_open(
        $command,
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
        $pipes,
        null,
        [
            'PATH' => '/usr/local/bin:/usr/bin:/bin',
            'LANG' => 'C',
            'LC_ALL' => 'C',
            'PYTHONDONTWRITEBYTECODE' => '1',
            'PYTHONHASHSEED' => '0',
        ],
        ['bypass_shell' => true]
    );
    if (!is_resource($process)) {
        return ['code' => null, 'stdout' => '', 'stderr' => '', 'failed' => true];
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $stdout = '';
    $stderr = '';
    $limit = 65536;
    $deadline = microtime(true) + max(1, min(1800, $timeoutSeconds));
    $exitCode = null;
    $failed = false;
    while (true) {
        if (connection_aborted()) {
            $failed = true;
            $exitCode = avian_bundle_export_stop($process);
            break;
        }
        $read = [];
        if (!feof($pipes[1])) $read[] = $pipes[1];
        if (!feof($pipes[2])) $read[] = $pipes[2];
        if ($read !== []) {
            $write = null;
            $except = null;
            $selected = @stream_select($read, $write, $except, 0, 50000);
            if ($selected === false) {
                $failed = true;
                $exitCode = avian_bundle_export_stop($process);
                break;
            }
            foreach ($read as $stream) {
                $chunk = fread($stream, 16384);
                if (!is_string($chunk) || $chunk === '') continue;
                if ($stream === $pipes[1]) $stdout .= $chunk;
                else $stderr .= $chunk;
            }
        }
        if (strlen($stdout) > $limit || strlen($stderr) > $limit) {
            $failed = true;
            $exitCode = avian_bundle_export_stop($process);
            break;
        }
        $status = proc_get_status($process);
        if (!is_array($status)) {
            $failed = true;
            $exitCode = avian_bundle_export_stop($process);
            break;
        }
        if (empty($status['running'])) {
            if (is_int($status['exitcode']) && $status['exitcode'] >= 0) {
                $exitCode = $status['exitcode'];
            }
            if (feof($pipes[1]) && feof($pipes[2])) break;
        }
        if ($read === []) usleep(20000);
        if (microtime(true) >= $deadline) {
            $failed = true;
            $exitCode = avian_bundle_export_stop($process);
            break;
        }
    }
    foreach ([1, 2] as $index) {
        $remaining = max(0, $limit + 1 - ($index === 1 ? strlen($stdout) : strlen($stderr)));
        $tail = $remaining > 0 ? stream_get_contents($pipes[$index], $remaining) : '';
        if (is_string($tail)) {
            if ($index === 1) $stdout .= $tail;
            else $stderr .= $tail;
        }
        fclose($pipes[$index]);
    }
    $closed = proc_close($process);
    if ($exitCode === null && is_int($closed) && $closed >= 0) $exitCode = $closed;
    if (strlen($stdout) > $limit || strlen($stderr) > $limit) $failed = true;
    return ['code' => $exitCode, 'stdout' => $stdout, 'stderr' => $stderr, 'failed' => $failed];
}

function avian_bundle_export_python(string $root): ?string {
    $candidates = [
        "$root/birdnet/bin/python3",
        '/usr/bin/python3',
        '/usr/local/bin/python3',
        '/opt/homebrew/bin/python3',
    ];
    $seen = [];
    foreach ($candidates as $candidate) {
        if (!is_file($candidate) || !is_executable($candidate)) continue;
        $real = realpath($candidate);
        $key = is_string($real) ? $real : $candidate;
        if (isset($seen[$key])) continue;
        $seen[$key] = true;
        $probe = avian_bundle_export_process([
            $candidate,
            '-I',
            '-c',
            'import PIL; print("avian-bundle-python-v1")',
        ], 5);
        if (!$probe['failed'] && $probe['code'] === 0
            && trim($probe['stdout']) === 'avian-bundle-python-v1') {
            return $candidate;
        }
    }
    return null;
}

function avian_bundle_export_test_path(string $environment, string $default): string {
    if (PHP_SAPI !== 'cli' && PHP_SAPI !== 'cli-server') return $default;
    $candidate = getenv($environment);
    if (!is_string($candidate) || $candidate === '' || $candidate[0] !== '/'
        || strlen($candidate) > 2048 || str_contains($candidate, "\0")) {
        return $default;
    }
    return $candidate;
}

/** @return resource */
function avian_bundle_export_request_lock(string $path) {
    clearstatcache(true, $path);
    $before = @lstat($path);
    $handle = @fopen($path, 'rb');
    $opened = is_resource($handle) ? fstat($handle) : false;
    $permissions = is_array($opened) ? ((int)$opened['mode'] & 0777) : -1;
    $defaultPath = $path === '/run/lock/avian-bundle-export.lock';
    if (!is_array($before) || !is_array($opened)
        || (($before['mode'] & 0170000) !== 0100000)
        || (($opened['mode'] & 0170000) !== 0100000)
        || (int)($opened['nlink'] ?? 0) !== 1
        || $before['dev'] !== $opened['dev'] || $before['ino'] !== $opened['ino']
        || is_link($path)
        || ($defaultPath && ((int)($opened['uid'] ?? -1) !== 0 || $permissions !== 0660))
        || (!$defaultPath && $permissions !== 0600)) {
        if (is_resource($handle)) fclose($handle);
        avian_bundle_export_fail('bundle export lock is unavailable', 409);
    }
    if (!flock($handle, LOCK_EX | LOCK_NB)) {
        fclose($handle);
        avian_bundle_export_fail('another bundle export is already in progress', 409);
    }
    clearstatcache(true, $path);
    $after = @lstat($path);
    if (!is_array($after) || is_link($path)
        || $after['dev'] !== $opened['dev'] || $after['ino'] !== $opened['ino']) {
        flock($handle, LOCK_UN);
        fclose($handle);
        avian_bundle_export_fail('bundle export lock changed while it was opened', 409);
    }
    return $handle;
}

function avian_bundle_export_request_dir(): ?string {
    $parent = sys_get_temp_dir();
    if (!is_dir($parent) || is_link($parent)) return null;
    for ($attempt = 0; $attempt < 4; $attempt++) {
        try {
            $name = $parent . '/avian-bundle-' . bin2hex(random_bytes(16));
        } catch (Throwable $error) {
            return null;
        }
        if (@mkdir($name, 0700) && @chmod($name, 0700)) return $name;
    }
    return null;
}

function avian_bundle_export_cleanup(string $directory, int $depth = 0): void {
    if ($depth > 2 || !is_dir($directory) || is_link($directory)) return;
    $items = @scandir($directory);
    if (is_array($items) && count($items) <= 64) {
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') continue;
            $path = $directory . '/' . $item;
            if (is_dir($path) && !is_link($path)) {
                avian_bundle_export_cleanup($path, $depth + 1);
            } else {
                @unlink($path);
            }
        }
    }
    @rmdir($directory);
}

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
if ($what === 'bundle') {
    avian_require_admin();
    $bundleRoot = dirname(__DIR__, 2);
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
        header('Allow: GET');
        avian_bundle_export_fail('GET required', 405);
    }
    if (($_SERVER['QUERY_STRING'] ?? '') !== 'what=bundle') {
        avian_bundle_export_fail('invalid bundle export request', 400);
    }
    if (PHP_SAPI === 'fpm-fcgi') {
        $requestUri = (string)($_SERVER['REQUEST_URI'] ?? '');
        $queryOffset = strpos($requestUri, '?');
        $requestPath = $queryOffset === false
            ? $requestUri
            : substr($requestUri, 0, $queryOffset);
        if ($requestPath !== '/avian/api/export.php'
            || (string)($_SERVER['PATH_INFO'] ?? '') !== '') {
            avian_bundle_export_fail('invalid bundle export path', 400);
        }
        if (($_SERVER['AVIAN_BUNDLE_EXPORT_POOL'] ?? '') !== '1') {
            avian_bundle_export_fail('bundle export service is unavailable', 503);
        }
    }
    $exportLockPath = avian_bundle_export_test_path(
        'AVIAN_EXPORT_REQUEST_LOCK',
        '/run/lock/avian-bundle-export.lock'
    );
    $exportLock = avian_bundle_export_request_lock($exportLockPath);
    $illustrations = avian_bundle_export_test_path(
        'AVIAN_EXPORT_ILLUSTRATIONS',
        "$bundleRoot/avian/assets/illustrations"
    );
    $script = "$bundleRoot/avian/scripts/bundle_export.py";
    $lock = avian_bundle_export_test_path(
        'AVIAN_EXPORT_GENERATION_LOCK',
        '/run/lock/avian-generation.lock'
    );
    $catalogOverride = avian_bundle_export_test_path('AVIAN_EXPORT_CATALOG', '');
    $catalogs = $catalogOverride !== '' ? [$catalogOverride] : array_values(array_filter([
        "$bundleRoot/avian/bundles/catalog-v1.json",
        "$bundleRoot/assembled/site/public/catalog/bundles-v1.json",
        "$bundleRoot/avian/scripts/bundle-taxonomy-v1.json",
    ], static fn(string $path): bool => is_file($path) && !is_link($path)));
    if (!is_dir($illustrations) || is_link($illustrations)
        || !is_file($script) || is_link($script) || !is_readable($script)
        || !is_file($lock) || is_link($lock) || !$catalogs) {
        avian_bundle_export_fail('local illustration bundle is unavailable', 409);
    }
    foreach ($catalogs as $catalog) {
        if (!is_file($catalog) || is_link($catalog) || !is_readable($catalog)) {
            avian_bundle_export_fail('trusted illustration taxonomy is unavailable', 409);
        }
    }
    $python = avian_bundle_export_python($bundleRoot);
    if ($python === null) {
        avian_bundle_export_fail('bundle export runtime is unavailable', 503);
    }
    $requestDir = avian_bundle_export_request_dir();
    if ($requestDir === null) {
        avian_bundle_export_fail('could not create a private export directory', 503);
    }
    register_shutdown_function(static function () use ($requestDir): void {
        avian_bundle_export_cleanup($requestDir);
    });
    $temporary = $requestDir . '/bundle.zip';
    $command = [
        $python,
        '-I',
        $script,
        '--illustrations', $illustrations,
        '--generation-lock', $lock,
        '--output', $temporary,
    ];
    foreach ($catalogs as $catalog) {
        $command[] = '--catalog';
        $command[] = $catalog;
    }
    ignore_user_abort(false);
    set_time_limit(1810);
    $result = avian_bundle_export_process($command, 1800);
    $payload = json_decode(trim($result['stdout']), true);
    if ($result['failed'] || $result['code'] !== 0 || !is_array($payload)
        || ($payload['ok'] ?? false) !== true) {
        avian_bundle_export_cleanup($requestDir);
        $message = is_array($payload) && is_string($payload['error'] ?? null)
            && strlen($payload['error']) <= 240
            ? $payload['error'] : 'bundle export failed safely';
        avian_bundle_export_fail($message, 409);
    }
    $id = $payload['id'] ?? null;
    $version = $payload['version'] ?? null;
    if (!is_string($id) || preg_match('/\A[a-z0-9][a-z0-9._-]{0,79}\z/D', $id) !== 1
        || !is_string($version)
        || preg_match('/\A(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\z/D', $version) !== 1) {
        avian_bundle_export_cleanup($requestDir);
        avian_bundle_export_fail('bundle exporter returned invalid metadata', 503);
    }
    clearstatcache(true, $temporary);
    $before = @lstat($temporary);
    $stream = @fopen($temporary, 'rb');
    $opened = is_resource($stream) ? fstat($stream) : false;
    $size = is_array($opened) ? (int)($opened['size'] ?? 0) : 0;
    if (!is_array($before) || !is_array($opened)
        || (($before['mode'] & 0170000) !== 0100000)
        || (($opened['mode'] & 0170000) !== 0100000)
        || (int)($opened['nlink'] ?? 0) !== 1
        || $before['dev'] !== $opened['dev'] || $before['ino'] !== $opened['ino']
        || is_link($temporary) || $size < 1024 || $size > 768 * 1024 * 1024) {
        if (is_resource($stream)) fclose($stream);
        avian_bundle_export_cleanup($requestDir);
        avian_bundle_export_fail('bundle exporter produced an invalid archive', 503);
    }
    if (!@unlink($temporary) || !@rmdir($requestDir)) {
        fclose($stream);
        avian_bundle_export_cleanup($requestDir);
        avian_bundle_export_fail('bundle archive could not be detached for download', 503);
    }
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . $id . '-' . $version . '.zip"');
    header('Content-Length: ' . (string)$size);
    header('Cache-Control: no-store');
    header('Pragma: no-cache');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'");
    while (ob_get_level()) ob_end_clean();
    $streamBudgetSeconds = 1800;
    $streamDeadline = microtime(true) + $streamBudgetSeconds;
    set_time_limit($streamBudgetSeconds + 10);
    $sent = 0;
    while ($sent < $size && !feof($stream) && !connection_aborted()
        && microtime(true) < $streamDeadline) {
        $chunk = fread($stream, min(256 * 1024, $size - $sent));
        if (!is_string($chunk) || $chunk === '') break;
        $chunkBytes = strlen($chunk);
        if ($chunkBytes > $size - $sent) break;
        echo $chunk;
        $sent += $chunkBytes;
        flush();
    }
    fclose($stream);
    flock($exportLock, LOCK_UN);
    fclose($exportLock);
    avian_bundle_export_cleanup($requestDir);
    exit;
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
