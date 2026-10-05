<?php
declare(strict_types=1);

define('AVIAN_BIRDNET_API_LIBRARY_ONLY', true);
require dirname(__DIR__) . '/avian/api/birdnet-api.php';

$checks = 0;
function checkMidnight(bool $condition, string $message): void {
    global $checks;
    $checks++;
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
}

$config = tempnam(sys_get_temp_dir(), 'avian-midnight-');
checkMidnight(is_string($config), 'temporary config created');
file_put_contents($config, "RESET_AT_MIDNIGHT=1\n");
checkMidnight(publicConfigFlag($config, 'RESET_AT_MIDNIGHT'), 'numeric true is accepted');
file_put_contents($config, "RESET_AT_MIDNIGHT=yes\n");
checkMidnight(publicConfigFlag($config, 'RESET_AT_MIDNIGHT'), 'word true is accepted');
file_put_contents($config, "RESET_AT_MIDNIGHT=1\nRESET_AT_MIDNIGHT=0\n");
checkMidnight(!publicConfigFlag($config, 'RESET_AT_MIDNIGHT'), 'last assignment wins');
unlink($config);
checkMidnight(!publicConfigFlag($config, 'RESET_AT_MIDNIGHT'), 'missing config is disabled');

$db = new SQLite3(':memory:');
$today = [
    'anchor' => '2026-09-02 15:30:00',
    'is_today' => true,
];
$clamped = recentWindow($db, 24, $today, true, false);
checkMidnight($clamped['reset_at_midnight'] === true, 'global reset setting is reported');
checkMidnight($clamped['midnight_clamped'] === true, '24 hour window clamps after midnight');
checkMidnight($clamped['window_start'] === '2026-09-02 00:00:00', 'clamp uses station midnight');

$short = recentWindow($db, 12, $today, true, false);
checkMidnight($short['midnight_clamped'] === false, 'short window inside the day stays rolling');
checkMidnight($short['window_start'] === '2026-09-02 03:30:00', 'short window keeps its rolling start');

$disabled = recentWindow($db, 24, $today, false, false);
checkMidnight($disabled['midnight_clamped'] === false, 'disabled setting stays rolling');
checkMidnight($disabled['window_start'] === '2026-09-01 15:30:00', 'disabled setting crosses midnight');

$historical = recentWindow($db, 24, [
    'anchor' => '2026-08-20 23:59:59',
    'is_today' => false,
], true, false);
checkMidnight($historical['midnight_clamped'] === false, 'historical date stays rolling');

$scoped = recentWindow($db, 24, $today, true, true);
checkMidnight($scoped['reset_at_midnight'] === false, 'saved scope ignores the station display preference');
checkMidnight($scoped['window_start'] === '2026-09-01 15:30:00', 'saved scope keeps its requested window');
checkMidnight(
    $scoped === recentWindow($db, 24, $today, false, true),
    'saved scope output is identical whether the station preference is on or off'
);

$all = recentWindow($db, 1000000, $today, true, false);
checkMidnight($all['window_start'] === null, 'all time has no lower bound');
checkMidnight($all['midnight_clamped'] === false, 'all time is never clamped');

$db->exec('CREATE TABLE detections (Date TEXT NOT NULL, Time TEXT NOT NULL)');
$db->exec("INSERT INTO detections VALUES
    ('2026-09-01', '23:59:59'),
    ('2026-09-02', '00:00:00'),
    ('2026-09-02', '12:00:00')");
$statement = $db->prepare('SELECT COUNT(*) AS n FROM detections WHERE '.$clamped['where']);
foreach ($clamped['bind'] as $key => $value) {
    $statement->bindValue($key, $value, SQLITE3_TEXT);
}
$row = $statement->execute()->fetchArray(SQLITE3_ASSOC);
checkMidnight((int)($row['n'] ?? 0) === 2, 'clamped query includes midnight and excludes the prior day');

$db->exec("INSERT INTO detections VALUES ('2026-09-01', '15:30:00')");
$statement = $db->prepare('SELECT COUNT(*) AS n FROM detections WHERE '.$disabled['where']);
foreach ($disabled['bind'] as $key => $value) {
    $statement->bindValue($key, $value, SQLITE3_TEXT);
}
$row = $statement->execute()->fetchArray(SQLITE3_ASSOC);
checkMidnight((int)($row['n'] ?? 0) === 3, 'disabled rolling query keeps its exclusive lower bound');
$db->close();

echo "midnight reset tests passed ({$checks} checks)\n";
