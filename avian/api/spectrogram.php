<?php
// AvianVisitors - serves the spectrogram PNG that BirdNET-Pi generates
// alongside each detection mp3. Same lookup logic as recording.php (find
// the matching file under By_Date/<date>/<Common_Name>/) - just .png
// instead of .mp3.
//
// Endpoints:
//   ?sci=<sci_name>            -> newest spectrogram for that species
//   ?file=<original-base>.mp3  -> spectrogram next to that specific
//                                recording (atlas modal uses this so the
//                                strip below each play button is the
//                                spectrogram for that recording, not
//                                "the most recent" - they can differ).

declare(strict_types=1);

$sci = trim((string)($_GET['sci'] ?? ''));
$file = trim((string)($_GET['file'] ?? ''));

if ($sci === '' && $file === '') {
    http_response_code(400);
    echo 'sci or file required';
    exit;
}

// Reject any sci-name that isn't a clean Genus species[ subspecies[ tri]]
// pattern. Same defence-in-depth check as recording.php.
if ($sci !== '' && !preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
    http_response_code(400);
    echo 'invalid sci';
    exit;
}

$BY_DATE = dirname(__DIR__, 3) . '/BirdSongs/Extracted/By_Date';

// ---- Direct-by-file lookup ----
// BirdNET-Pi writes <base>.mp3 and <base>.png next to each other under
// By_Date/<date>/<Common_Name>/. So we accept the mp3 filename, swap
// the extension, and search the same way recording.php does.
if ($file !== '') {
    // BirdNET-Pi keeps apostrophes in some common names (e.g.
    // Anna's_Hummingbird-...mp3.png), so allow ' in the whitelist; the
    // regex still blocks "/" and ".." so path traversal isn't reachable.
    // Allow Unicode letters so accented common names (DATABASE_LANG=fr etc.)
    // resolve; "/" is still excluded and ".." is rejected, so the value
    // stays a safe basename.
    if (strpos($file, '..') !== false || !preg_match("/^[\\p{L}\\p{N}_.:'-]+\\.(mp3|png)$/u", $file)) {
        http_response_code(400);
        echo 'invalid file name';
        exit;
    }
    // BirdNET-Pi names the spectrogram as the FULL mp3 filename plus
    // ".png" - e.g. "American_Crow-82-...-20:25:29.mp3" pairs with
    // "American_Crow-82-...-20:25:29.mp3.png" (not "...-20:25:29.png").
    // Accept either form gracefully.
    if (substr($file, -4) === '.png') {
        $png = $file;
    } else {
        $png = $file . '.png';
    }
    $date = null;
    if (preg_match('/(\d{4}-\d{2}-\d{2})/', $png, $m)) $date = $m[1];
    $candidates = [];
    if ($date) {
        $dayDir = "$BY_DATE/$date";
        if (is_dir($dayDir)) {
            foreach (scandir($dayDir) as $sub) {
                if ($sub[0] === '.') continue;
                $p = "$dayDir/$sub/$png";
                if (is_file($p)) { $candidates[] = $p; break; }
            }
        }
    }
    if (!$candidates) {
        if (is_dir($BY_DATE)) {
            foreach (scandir($BY_DATE) as $d) {
                if ($d[0] === '.') continue;
                $dayDir = "$BY_DATE/$d";
                if (!is_dir($dayDir)) continue;
                foreach (scandir($dayDir) as $sub) {
                    if ($sub[0] === '.') continue;
                    $p = "$dayDir/$sub/$png";
                    if (is_file($p)) { $candidates[] = $p; break 2; }
                }
            }
        }
    }
    if (!$candidates || filesize($candidates[0]) < 64) {
        http_response_code(404);
        echo 'spectrogram not found';
        exit;
    }
    $path = $candidates[0];
    header('Content-Type: image/png');
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: public, max-age=86400');
    readfile($path);
    exit;
}

// The DB's Com_Name is in the configured DATABASE_LANG, which is how
// BirdNET-Pi names the species directories. Prefer it so non-English
// installs (DATABASE_LANG=fr, etc.) resolve to the right directory.
function resolve_common_from_db(string $sci): ?string {
    $dbPath = dirname(__DIR__, 2) . '/scripts/birds.db';
    if (!is_readable($dbPath) || !class_exists('SQLite3')) return null;
    try {
        $db = new SQLite3($dbPath, SQLITE3_OPEN_READONLY);
        $stmt = $db->prepare('SELECT Com_Name FROM detections WHERE Sci_Name = :s ORDER BY Date DESC, Time DESC LIMIT 1');
        $stmt->bindValue(':s', $sci, SQLITE3_TEXT);
        $res = $stmt->execute();
        $row = $res ? $res->fetchArray(SQLITE3_ASSOC) : false;
        $db->close();
        if ($row && !empty($row['Com_Name'])) {
            return str_replace(' ', '_', (string)$row['Com_Name']);
        }
    } catch (\Throwable $e) {
        // fall through to the file-based maps below
    }
    return null;
}

function resolve_common(string $sci): ?string {
    $fromDb = resolve_common_from_db($sci);
    if ($fromDb !== null) return $fromDb;
    $f = dirname(__DIR__, 3) . '/BirdNET-Pi/scripts/birds.json';
    if (is_readable($f)) {
        $list = json_decode((string)file_get_contents($f), true);
        if (is_array($list)) {
            foreach ($list as $row) {
                if (!is_array($row)) continue;
                $rowSci = $row['sci'] ?? $row['scientific'] ?? $row['scientificName'] ?? '';
                $rowCom = $row['com'] ?? $row['common'] ?? $row['commonName'] ?? '';
                if (strcasecmp(trim((string)$rowSci), $sci) === 0 && $rowCom) {
                    return str_replace(' ', '_', (string)$rowCom);
                }
            }
        }
    }
    $labels = dirname(__DIR__, 3) . '/BirdNET-Pi/model/labels.txt';
    if (is_readable($labels)) {
        foreach (file($labels, FILE_IGNORE_NEW_LINES) as $line) {
            if (strpos($line, '_') !== false) {
                [$s, $c] = explode('_', $line, 2);
                if (strcasecmp(trim($s), $sci) === 0) {
                    return str_replace(' ', '_', trim($c));
                }
            }
        }
    }
    return null;
}

$common = resolve_common($sci) ?? str_replace(' ', '_', $sci);

function newest_spectrogram(string $rootDir, string $common): ?string {
    if (!is_dir($rootDir)) return null;
    // Normalised match so apostrophes / case don't matter - same fix as
    // recording.php (e.g. Anna's_Hummingbird vs Annas_Hummingbird).
    $norm = function (string $s): string {
        return preg_replace('/[^a-z0-9]/', '', strtolower($s));
    };
    $want = $norm($common);
    $dates = scandir($rootDir, SCANDIR_SORT_DESCENDING);
    if (!$dates) return null;
    foreach ($dates as $date) {
        if ($date[0] === '.') continue;
        $dayDir = "$rootDir/$date";
        if (!is_dir($dayDir)) continue;
        $speciesDir = null;
        foreach (scandir($dayDir) as $sub) {
            if ($sub[0] === '.' || !is_dir("$dayDir/$sub")) continue;
            if ($norm($sub) === $want) { $speciesDir = "$dayDir/$sub"; break; }
        }
        if ($speciesDir === null) continue;
        $files = scandir($speciesDir, SCANDIR_SORT_DESCENDING);
        if (!$files) continue;
        foreach ($files as $f) {
            if (substr($f, -4) === '.png' && @filesize("$speciesDir/$f") >= 64) {
                return "$speciesDir/$f";
            }
        }
    }
    return null;
}

$path = newest_spectrogram($BY_DATE, $common);
if ($path === null || !is_file($path) || filesize($path) < 64) {
    http_response_code(404);
    echo 'no spectrogram for ' . htmlspecialchars($sci);
    exit;
}

header('Content-Type: image/png');
header('Content-Length: ' . filesize($path));
header('Cache-Control: public, max-age=60');
readfile($path);
