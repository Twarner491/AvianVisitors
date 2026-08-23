<?php
// AvianVisitors - on-demand illustration generation for one species.
//
// Powers the atlas "generate illustration" button: spawns
// avian/scripts/generate_one.py in the background (Gemini render +
// instant chroma cutout + mask merge) and reports its progress.
//
// Endpoints:
//   GET  ?action=status -> {running, sci, com, step, ok, error, at,
//                           chroma}  (chroma = instant cutouts awaiting
//                           the workstation upgrade pass)
//   POST ?action=start  -> JSON body {sci, force?}. Species must exist
//                          in birds.db (the station actually heard it) -
//                          both cost control and input control, since
//                          sci/com reach a shell command line.
//
// Uses the Gemini key saved via the settings panel (GEMINI_API_KEY in
// birdnet.conf). Direct private-address requests are available without a
// password; forwarded and public-host requests require the station password.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/admin-auth.php';
avian_require_admin();

$BIRDNETPI_DIR = dirname(__DIR__, 2);
$ILLUS   = "$BIRDNETPI_DIR/avian/assets/illustrations";
$STATE   = "$ILLUS/.generate.state.json";
$STARTS  = "$ILLUS/.generate.starts";
$LOCK    = getenv('AVIAN_GENERATION_LOCK');
if (!is_string($LOCK) || $LOCK === '') {
    $LOCK = '/run/lock/avian-generation.lock';
}
$LOG     = "$ILLUS/.generate.log";
$DB_PATH = "$BIRDNETPI_DIR/scripts/birds.db";
$CONF    = "$BIRDNETPI_DIR/birdnet.conf";
$STALE_S = 15 * 60;   // a "running" state older than this is a dead run
$HOUR_CAP = 20;       // max starts per rolling hour (cost brake)

function read_state(string $path): array {
    if (!is_readable($path)) return [];
    $j = json_decode((string)file_get_contents($path), true);
    return is_array($j) ? $j : [];
}

function decode_start_state(string $contents): ?array {
    $decoded = json_decode($contents);
    if (!$decoded instanceof stdClass) return null;
    $state = get_object_vars($decoded);
    if (!array_key_exists('running', $state) || !is_bool($state['running'])) return null;
    if (array_key_exists('at', $state) && !is_int($state['at'])) return null;
    return $state;
}

function chroma_count(string $illus): int {
    $p = "$illus/cuts.json";
    if (!is_readable($p)) return 0;
    $j = json_decode((string)file_get_contents($p), true);
    if (!is_array($j)) return 0;
    $n = 0;
    foreach ($j as $kind) { if ($kind === 'chroma') $n++; }
    return $n;
}

function conf_value(string $conf, string $key): string {
    if (!is_readable($conf)) return '';
    foreach (file($conf, FILE_IGNORE_NEW_LINES) as $line) {
        if (preg_match('/^\s*' . $key . '\s*=\s*(.*)$/', $line, $m)) {
            $v = trim($m[1]);
            if (strlen($v) >= 2 && $v[0] === '"' && substr($v, -1) === '"') {
                $v = substr($v, 1, -1);
            }
            return $v;
        }
    }
    return '';
}

function atomic_write(string $path, string $contents): bool {
    try {
        $temporary = $path . '.tmp.' . bin2hex(random_bytes(8));
    } catch (Throwable $e) {
        return false;
    }

    $handle = @fopen($temporary, 'x+b');
    if ($handle === false) return false;

    $ok = true;
    $offset = 0;
    $length = strlen($contents);
    while ($offset < $length) {
        $written = @fwrite($handle, substr($contents, $offset));
        if ($written === false || $written === 0) {
            $ok = false;
            break;
        }
        $offset += $written;
    }
    if ($ok && !@fflush($handle)) $ok = false;
    if ($ok && function_exists('fsync')) @fsync($handle);
    if ($ok && !@chmod($temporary, 0664)) $ok = false;
    if ($ok && !@rename($temporary, $path)) $ok = false;
    if (!@fclose($handle)) $ok = false;
    if (!$ok) @unlink($temporary);
    return $ok;
}

function restore_file(string $path, bool $existed, string $contents): bool {
    if ($existed) return atomic_write($path, $contents);
    return !file_exists($path) || @unlink($path);
}

function find_executable(string $name): ?string {
    foreach (explode(PATH_SEPARATOR, (string)getenv('PATH')) as $directory) {
        if ($directory === '' || $directory[0] !== DIRECTORY_SEPARATOR) continue;
        $candidate = rtrim($directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $name;
        if (is_file($candidate) && is_executable($candidate)) return $candidate;
    }
    return null;
}

$action = $_GET['action'] ?? 'status';

if ($action === 'status') {
    $s = read_state($STATE);
    $running = !empty($s['running']);
    if ($running && (time() - (int)($s['at'] ?? 0)) > $STALE_S) {
        // The worker died without writing a final state.
        $running = false;
        $s['ok'] = false;
        $s['error'] = $s['error'] ?? 'timed out';
    }
    echo json_encode([
        'running' => $running,
        'sci'     => $s['sci'] ?? null,
        'com'     => $s['com'] ?? null,
        'step'    => $s['step'] ?? null,
        'ok'      => $s['ok'] ?? null,
        'error'   => $s['error'] ?? null,
        'at'      => $s['at'] ?? null,
        'chroma'  => chroma_count($ILLUS),
    ]);
    exit;
}

if ($action === 'start') {
    avian_require_json_action();
    try {
        $body = json_decode((string)file_get_contents('php://input'), false, 16, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid JSON body']);
        exit;
    }
    if (!$body instanceof stdClass) {
        http_response_code(400);
        echo json_encode(['error' => 'JSON object required']);
        exit;
    }
    $fields = get_object_vars($body);
    if (array_diff(array_keys($fields), ['sci', 'force'])) {
        http_response_code(400);
        echo json_encode(['error' => 'unexpected field']);
        exit;
    }
    if (!array_key_exists('sci', $fields) || !is_string($fields['sci'])) {
        http_response_code(400);
        echo json_encode(['error' => 'bad sci name']);
        exit;
    }
    if (array_key_exists('force', $fields) && !is_bool($fields['force'])) {
        http_response_code(400);
        echo json_encode(['error' => 'force must be boolean']);
        exit;
    }
    $sci = trim($fields['sci']);
    $force = $fields['force'] ?? false;
    // Strict binomial, same shape cutout.php enforces. This string (and
    // the DB-resolved common name) is all that ever reaches the shell,
    // and both still go through escapeshellarg.
    if (!preg_match("/^[A-Z][a-z-]+ [a-z-]+$/", $sci)) {
        http_response_code(400);
        echo json_encode(['error' => 'bad sci name']);
        exit;
    }

    // The species must have actually been heard by this station.
    if (!file_exists($DB_PATH)) {
        http_response_code(503);
        echo json_encode(['error' => 'birds.db not found']);
        exit;
    }
    $db = new SQLite3($DB_PATH, SQLITE3_OPEN_READONLY);
    $db->busyTimeout(2000);
    $st = $db->prepare('SELECT Com_Name FROM detections WHERE Sci_Name = :s ORDER BY Date DESC LIMIT 1');
    $st->bindValue(':s', $sci, SQLITE3_TEXT);
    $row = $st->execute()->fetchArray(SQLITE3_ASSOC);
    $db->close();
    if (!$row) {
        http_response_code(404);
        echo json_encode(['error' => 'species not in your detections']);
        exit;
    }
    $com = (string)$row['Com_Name'];

    $key = conf_value($CONF, 'GEMINI_API_KEY');
    if ($key === '') {
        http_response_code(409);
        echo json_encode(['error' => 'no gemini key', 'hint' => 'add it in settings']);
        exit;
    }

    $python = "$BIRDNETPI_DIR/birdnet/bin/python3";
    if (!is_executable($python)) $python = find_executable('python3') ?? '';
    $nohup = find_executable('nohup') ?? '';
    $workerScript = "$BIRDNETPI_DIR/avian/scripts/generate_one.py";
    if ($python === '' || $nohup === '' || !is_readable($workerScript)
        || !is_executable('/bin/sh') || !function_exists('proc_open')) {
        http_response_code(500);
        echo json_encode(['error' => 'generator unavailable']);
        exit;
    }

    if (!is_dir($ILLUS) && !@mkdir($ILLUS, 0775, true) && !is_dir($ILLUS)) {
        http_response_code(500);
        echo json_encode(['error' => 'illustration directory unavailable']);
        exit;
    }
    // Provisioned root-owned by the installer. Caddy can lock the inode but
    // cannot replace it, and the updater shares it for an atomic library view.
    $generationLock = @fopen($LOCK, 'r+');
    if ($generationLock === false) {
        http_response_code(500);
        echo json_encode(['error' => 'generation lock unavailable']);
        exit;
    }
    if (!flock($generationLock, LOCK_EX | LOCK_NB)) {
        fclose($generationLock);
        http_response_code(409);
        echo json_encode(['error' => 'busy']);
        exit;
    }

    // The lock covers the state and rate-limit decisions through spawning,
    // so simultaneous requests cannot each start a worker.
    $now = time();
    $stateExisted = file_exists($STATE);
    $stateBefore = $stateExisted ? @file_get_contents($STATE) : '';
    $s = is_string($stateBefore) && $stateExisted ? decode_start_state($stateBefore) : [];
    if (!is_string($stateBefore) || $s === null) {
        flock($generationLock, LOCK_UN);
        fclose($generationLock);
        http_response_code(500);
        echo json_encode(['error' => 'generation state unavailable']);
        exit;
    }
    if (!empty($s['running']) && ($now - (int)($s['at'] ?? 0)) <= $STALE_S) {
        flock($generationLock, LOCK_UN);
        fclose($generationLock);
        http_response_code(409);
        echo json_encode(['error' => 'busy', 'sci' => $s['sci'] ?? null]);
        exit;
    }

    // Rolling-hour start cap - a public deploy shouldn't let a stranger
    // spend the owner's Gemini budget in a loop.
    $startsExisted = file_exists($STARTS);
    $startsBefore = $startsExisted ? @file_get_contents($STARTS) : '';
    $startLines = is_string($startsBefore)
        ? preg_split('/\r\n|\n|\r/', $startsBefore)
        : false;
    if ($startLines === false) {
        flock($generationLock, LOCK_UN);
        fclose($generationLock);
        http_response_code(500);
        echo json_encode(['error' => 'generation state unavailable']);
        exit;
    }
    $starts = [];
    foreach ($startLines as $line) {
        $line = trim($line);
        if ($line === '') continue;
        if (!ctype_digit($line)) {
            flock($generationLock, LOCK_UN);
            fclose($generationLock);
            http_response_code(500);
            echo json_encode(['error' => 'generation state unavailable']);
            exit;
        }
        $startedAt = (int)$line;
        if ($startedAt > $now - 3600) $starts[] = $startedAt;
    }
    if (count($starts) >= $HOUR_CAP) {
        flock($generationLock, LOCK_UN);
        fclose($generationLock);
        http_response_code(429);
        echo json_encode(['error' => 'hourly cap reached']);
        exit;
    }
    $starts[] = $now;
    if (!atomic_write($STARTS, implode("\n", $starts) . "\n")) {
        flock($generationLock, LOCK_UN);
        fclose($generationLock);
        http_response_code(500);
        echo json_encode(['error' => 'generation state unavailable']);
        exit;
    }

    // Mark running before the spawn so the UI flips immediately; the
    // worker takes over this file once it boots.
    $stateJson = json_encode([
        'running' => true, 'sci' => $sci, 'com' => $com,
        'step' => 'starting', 'at' => $now,
    ], JSON_INVALID_UTF8_SUBSTITUTE);
    if (!is_string($stateJson) || !atomic_write($STATE, $stateJson . "\n")) {
        restore_file($STARTS, $startsExisted, $startsBefore);
        flock($generationLock, LOCK_UN);
        fclose($generationLock);
        http_response_code(500);
        echo json_encode(['error' => 'generation state unavailable']);
        exit;
    }

    // Pass the API key only through the worker environment. The shell command
    // is visible in process listings, so it must never contain the secret.
    $cmd = ': >> ' . escapeshellarg($LOG) . ' || exit 1; '
         . escapeshellarg($nohup) . ' ' . escapeshellarg($python)
         . ' ' . escapeshellarg($workerScript)
         . ' --sci ' . escapeshellarg($sci)
         . ' --com ' . escapeshellarg($com)
         . ($force ? ' --force' : '')
         . ' >> ' . escapeshellarg($LOG) . ' 2>&1 < /dev/null & '
         . 'worker_pid=$!; sleep 0.05; kill -0 "$worker_pid" 2>/dev/null';
    $environment = getenv();
    if (!is_array($environment)) $environment = [];
    $environment['GEMINI_API_KEY'] = $key;
    $descriptors = [
        0 => ['file', '/dev/null', 'r'],
        1 => ['file', '/dev/null', 'a'],
        2 => ['file', '/dev/null', 'a'],
    ];
    $process = @proc_open(
        ['/bin/sh', '-c', $cmd],
        $descriptors,
        $pipes,
        $BIRDNETPI_DIR,
        $environment,
        ['bypass_shell' => true]
    );
    $spawnStatus = is_resource($process) ? proc_close($process) : -1;
    if ($spawnStatus !== 0) {
        restore_file($STATE, $stateExisted, $stateBefore);
        restore_file($STARTS, $startsExisted, $startsBefore);
        flock($generationLock, LOCK_UN);
        fclose($generationLock);
        http_response_code(500);
        echo json_encode(['error' => 'could not start generator']);
        exit;
    }
    flock($generationLock, LOCK_UN);
    fclose($generationLock);

    echo json_encode(['ok' => true, 'sci' => $sci, 'com' => $com]);
    exit;
}

http_response_code(404);
echo json_encode(['error' => 'unknown action']);
