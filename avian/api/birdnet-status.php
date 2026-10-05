<?php
// AvianVisitors - system / service / log JSON facade for the admin
// overlay (settings/system/logs/tools sections). Fetched by the
// frontend at /avian/api/birdnet-status.php?action=...
//
// Endpoints (?action=...):
//   system    - uptime / load / disk / mem / temp / audio device / db file age
//   services  - status of every birdnet_* unit + caddy + php-fpm
//   logs      - &unit=<name>&lines=N: last N lines of that unit's journal
//   restart   - POST &unit=<name>: restart a single service (whitelisted)
//   diag      - everything in one go (system + services + recent logs)
//
// Direct requests on the station's private address may be available without a
// password. The station owner can require the configured admin password there
// too. Forwarded and public-host requests always require it.
//
// Every sudo call passes -n so it can never sit waiting for a password:
// php-fpm has no tty to answer one, and the request would just hang until
// the worker times out. With /etc/sudoers.d/020_avian-admin in place the
// flag changes nothing; without it the call fails at once and the panel
// can say so.
//
// Service restart + journalctl need passwordless sudo for the caddy
// user that runs php-fpm. install_services.sh drops the matching
// sudoers rule at /etc/sudoers.d/020_avian-admin with an explicit
// command allowlist.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

require_once __DIR__ . '/admin-auth.php';
avian_require_admin();

$action = $_GET['action'] ?? 'diag';

// Path layout: /home/{USER}/BirdNET-Pi/avian/api/birdnet-status.php
//   __DIR__              -> .../BirdNET-Pi/avian/api
//   dirname(__DIR__, 2)  -> .../BirdNET-Pi
//   dirname(__DIR__, 3)  -> /home/{USER}
$BIRDNETPI_DIR = dirname(__DIR__, 2);
$BIRDSONGS_DIR = dirname(__DIR__, 3) . '/BirdSongs';
$DB_PATH       = "$BIRDNETPI_DIR/scripts/birds.db";
$CONF_PATH     = "$BIRDNETPI_DIR/birdnet.conf";
$STREAM_DIR    = "$BIRDSONGS_DIR/StreamData";
$ADMIN_CONTROL = getenv('AV_ADMIN_CONTROL') ?: '/usr/local/sbin/avian-admin-control';

function shellout(string $cmd): string {
    // Always merge stderr so a broken command shows what failed.
    $rc = 0; $out = [];
    exec($cmd . ' 2>&1', $out, $rc);
    return implode("\n", $out);
}

function admin_control_output(string $control, array $arguments, ?int &$status = null): string {
    if (!is_executable($control)) {
        $status = 127;
        return 'admin control is not installed';
    }
    $command = ['/usr/bin/sudo', '-n', $control];
    foreach ($arguments as $argument) $command[] = (string)$argument;
    $pipes = [];
    $process = proc_open($command, [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ], $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        $status = 127;
        return 'could not start admin control';
    }
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[2]);
    $status = proc_close($process);
    $stdout = is_string($stdout) ? trim($stdout) : '';
    $stderr = is_string($stderr) ? trim($stderr) : '';
    return $stdout !== '' ? $stdout : $stderr;
}

function read_uptime(): array {
    $up = @file_get_contents('/proc/uptime');
    $sec = $up ? (float)explode(' ', trim($up))[0] : 0;
    return [
        'seconds' => $sec,
        'pretty'  => human_duration((int)$sec),
        'load'    => sys_getloadavg(),
        'now'     => date('c'),
    ];
}

function human_duration(int $s): string {
    $d = intdiv($s, 86400); $s -= $d * 86400;
    $h = intdiv($s, 3600);  $s -= $h * 3600;
    $m = intdiv($s, 60);
    $parts = [];
    if ($d) $parts[] = $d . 'd';
    if ($h) $parts[] = $h . 'h';
    if ($m && !$d) $parts[] = $m . 'm';
    return $parts ? implode(' ', $parts) : '<1m';
}

function read_mem(): array {
    $info = @file_get_contents('/proc/meminfo') ?: '';
    preg_match('/MemTotal:\s+(\d+)/', $info, $t);
    preg_match('/MemAvailable:\s+(\d+)/', $info, $a);
    $tot = isset($t[1]) ? (int)$t[1] * 1024 : 0;
    $avail = isset($a[1]) ? (int)$a[1] * 1024 : 0;
    $used = $tot - $avail;
    return [
        'total_bytes' => $tot,
        'used_bytes'  => $used,
        'used_pct'    => $tot ? round($used / $tot * 100, 1) : 0,
    ];
}

function read_disk(string $path): array {
    if (!is_dir($path)) return ['path' => $path, 'error' => 'not found'];
    $tot = @disk_total_space($path);
    $free = @disk_free_space($path);
    if (!$tot) return ['path' => $path, 'error' => 'stat failed'];
    return [
        'path'        => $path,
        'total_bytes' => (int)$tot,
        'free_bytes'  => (int)$free,
        'used_pct'    => round(($tot - $free) / $tot * 100, 1),
    ];
}

function read_temp(): ?float {
    $f = '/sys/class/thermal/thermal_zone0/temp';
    if (!is_readable($f)) return null;
    $raw = trim((string)@file_get_contents($f));
    return $raw === '' ? null : round((int)$raw / 1000, 1);
}

function read_audio(): array {
    // Read /proc/asound/cards directly - works even when the capture
    // device is busy (arecord -l would fail with "no soundcards" if
    // birdnet_recording holds the mic). The file is two lines per card.
    $raw = @file_get_contents('/proc/asound/cards') ?: '';
    $lines = array_values(array_filter(array_map('rtrim', explode("\n", $raw)), 'strlen'));
    $cards = [];
    for ($i = 0; $i < count($lines); $i += 2) {
        $head = trim($lines[$i]);
        $detail = isset($lines[$i + 1]) ? trim($lines[$i + 1]) : '';
        $cards[] = $detail !== '' ? "$head - $detail" : $head;
    }
    $usb = shellout('lsusb');
    return [
        'arecord_l' => $cards,
        'usb' => array_values(array_filter(explode("\n", $usb), function ($l) {
            return $l !== '' && (
                stripos($l, 'audio') !== false ||
                stripos($l, 'microphone') !== false ||
                stripos($l, 'mic') !== false
            );
        })),
    ];
}

function read_streamdata(string $dir): array {
    if (!is_dir($dir)) return ['exists' => false];
    $files = @scandir($dir, SCANDIR_SORT_DESCENDING) ?: [];
    $wav = array_values(array_filter($files, function ($f) {
        return $f !== '.' && $f !== '..' && preg_match('/\.(wav|mp3|raw)$/i', $f);
    }));
    $newest_age = null;
    if (count($wav) > 0) {
        $newest_age = time() - (int)@filemtime("$dir/" . $wav[0]);
    }
    return [
        'exists'        => true,
        'file_count'    => count($wav),
        'newest_age_s'  => $newest_age,
        'newest_name'   => $wav[0] ?? null,
    ];
}

function read_db_age(string $db): array {
    if (!is_file($db)) return ['exists' => false];
    return [
        'exists'      => true,
        'size_bytes'  => (int)filesize($db),
        'modified_s'  => time() - (int)filemtime($db),
        'mtime'       => date('c', (int)filemtime($db)),
    ];
}

function read_conf_summary(string $p): array {
    if (!is_readable($p)) return ['readable' => false];
    $keys = [
        'CONFIDENCE','SENSITIVITY','OVERLAP','REC_CARD','LATITUDE','LONGITUDE',
        'MODEL','SITE_NAME',
    ];
    $vals = [];
    foreach (file($p, FILE_IGNORE_NEW_LINES) as $line) {
        if (!$line || $line[0] === '#') continue;
        if (preg_match('/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i', $line, $m)) {
            if (in_array($m[1], $keys, true)) {
                $v = trim($m[2]);
                if (strlen($v) >= 2 && $v[0] === '"' && substr($v, -1) === '"') $v = substr($v, 1, -1);
                $vals[$m[1]] = $v;
            }
        }
    }
    return ['readable' => true, 'values' => $vals];
}

// Whitelisted units surfaced in the system page and logs.
// Includes both 8.2 and 8.4 php-fpm so older Debian + Trixie both report
// the right unit name; missing units come back as "inactive (not-found)".
const ALLOWED_UNITS = [
    'birdnet_recording',
    'birdnet_analysis',
    'birdnet_log',
    'birdnet_stats',
    'spectrogram_viewer',
    'livestream',
    'chart_viewer',
    'icecast2',
    'caddy',
    'php8.4-fpm',
    'php8.3-fpm',
    'php8.2-fpm',
];

// Never synchronously restart the web server or PHP worker from the request
// they are serving. These remain visible for status and logs only.
const RESTARTABLE_UNITS = [
    'birdnet_recording',
    'birdnet_analysis',
    'birdnet_log',
    'birdnet_stats',
    'spectrogram_viewer',
    'livestream',
    'chart_viewer',
    'icecast2',
];

function restartable_units_for_state(): array {
    $state = avian_admin_state();
    if (!empty($state['valid']) && empty($state['required'])) {
        return RESTARTABLE_UNITS;
    }
    return array_values(array_filter(
        RESTARTABLE_UNITS,
        static fn(string $unit): bool => $unit !== 'icecast2'
    ));
}

function services_status(): array {
    $out = [];
    $restartableUnits = restartable_units_for_state();
    foreach (ALLOWED_UNITS as $u) {
        $state = trim(shellout('systemctl is-active ' . escapeshellarg($u)));
        // Skip units that systemd doesn't know about at all (e.g. php8.2-fpm
        // on a Trixie box that ships php8.4). Keeps the table tidy.
        if ($state === 'inactive') {
            $exists = trim(shellout('systemctl cat ' . escapeshellarg($u) . ' >/dev/null 2>&1 && echo Y || echo N'));
            if ($exists !== 'Y') continue;
        }
        $enabled = trim(shellout('systemctl is-enabled ' . escapeshellarg($u)));
        $since = trim(shellout("systemctl show -p ActiveEnterTimestamp --value " . escapeshellarg($u)));
        $out[$u] = [
            'active'  => $state,
            'enabled' => $enabled,
            'since'   => $since ?: null,
            'restartable' => in_array($u, $restartableUnits, true),
        ];
    }
    return $out;
}

function logs_for(string $control, string $unit, int $lines): array {
    if (!in_array($unit, ALLOWED_UNITS, true)) {
        http_response_code(400);
        return ['error' => 'unit not allowed', 'allowed' => ALLOWED_UNITS];
    }
    $lines = max(10, min(500, $lines));
    $rc = 0;
    $out = admin_control_output($control, ['journal', $unit, (string)$lines], $rc);
    return [
        'unit'  => $unit,
        'lines' => $lines,
        'text'  => $out,
        'ok'    => $rc === 0,
    ];
}

switch ($action) {

    case 'system': {
        echo json_encode([
            'uptime'      => read_uptime(),
            'mem'         => read_mem(),
            'disk_root'   => read_disk('/'),
            'disk_birds'  => read_disk($BIRDSONGS_DIR),
            'temp_c'      => read_temp(),
            'audio'       => read_audio(),
            'stream_data' => read_streamdata($STREAM_DIR),
            'birds_db'    => read_db_age($DB_PATH),
            'conf'        => read_conf_summary($CONF_PATH),
            'hostname'    => trim(shellout('hostname')),
            'kernel'      => trim(shellout('uname -r')),
            'as_of'       => date('c'),
        ]);
        break;
    }

    case 'services': {
        echo json_encode(['services' => services_status(), 'as_of' => date('c')]);
        break;
    }

    case 'logs': {
        $unit = (string)($_GET['unit'] ?? 'birdnet_recording');
        $lines = (int)($_GET['lines'] ?? 60);
        echo json_encode(logs_for($ADMIN_CONTROL, $unit, $lines));
        break;
    }

    case 'restart': {
        avian_require_json_action();
        $unit = (string)($_GET['unit'] ?? '');
        $restartableUnits = restartable_units_for_state();
        if (!in_array($unit, $restartableUnits, true)) {
            http_response_code(400);
            echo json_encode(['error' => 'unit is status-only', 'allowed' => $restartableUnits]);
            break;
        }
        $rc = 0;
        $raw = admin_control_output($ADMIN_CONTROL, ['restart', $unit], $rc);
        $decoded = json_decode($raw, true);
        $ok = $rc === 0 && is_array($decoded) && !empty($decoded['ok']);
        if (!$ok) http_response_code(500);
        echo json_encode([
            'unit' => $unit,
            'ok'   => $ok,
            'rc'   => $rc,
            'out'  => $ok ? '' : (string)($decoded['error'] ?? 'restart failed'),
        ]);
        break;
    }

    case 'diag': {
        // Everything a /system page wants in one fetch.
        $svc = services_status();
        $key_units = ['birdnet_recording', 'birdnet_analysis'];
        $recent_logs = [];
        foreach ($key_units as $u) {
            $rc = 0;
            $recent_logs[$u] = trim(admin_control_output(
                $ADMIN_CONTROL, ['journal', $u, '20'], $rc
            ));
        }
        echo json_encode([
            'system'      => [
                'uptime'      => read_uptime(),
                'mem'         => read_mem(),
                'disk_root'   => read_disk('/'),
                'disk_birds'  => read_disk($BIRDSONGS_DIR),
                'temp_c'      => read_temp(),
                'audio'       => read_audio(),
                'stream_data' => read_streamdata($STREAM_DIR),
                'birds_db'    => read_db_age($DB_PATH),
                'conf'        => read_conf_summary($CONF_PATH),
                'hostname'    => trim(shellout('hostname')),
                'kernel'      => trim(shellout('uname -r')),
            ],
            'services'    => $svc,
            'recent_logs' => $recent_logs,
            'as_of'       => date('c'),
        ]);
        break;
    }

    default:
        http_response_code(404);
        echo json_encode(['error' => 'unknown action']);
}
