<?php
// AvianVisitors - serves the most-recent detection mp3 for a given
// scientific name. Called by the collage detail modal at
// /avian/api/recording.php?sci=<name>.
//
// BirdNET-Pi writes audio + spectrograms to
//   $HOME/BirdSongs/Extracted/By_Date/YYYY-MM-DD/<Common_Name>/<base>.mp3
// (with a matching .png next to it). Common_Name is the SPACE-stripped
// English common name (e.g. "Anna's_Hummingbird"), NOT the scientific
// name. We resolve sci -> common via birds.json under BirdNET-Pi/scripts/
// and walk the directory tree newest-first.
//

declare(strict_types=1);

$sci = trim((string)($_GET['sci'] ?? ''));
$file = trim((string)($_GET['file'] ?? ''));

if ($sci === '' && $file === '') {
    http_response_code(400);
    echo 'sci or file required';
    exit;
}

// Reject any sci-name that isn't a clean Genus species[ subspecies[ tri]]
// pattern. resolve_common() below falls back to str_replace(' ', '_', $sci)
// when there's no birds.json match - without this guard, `?sci=../etc` would
// flow through unmodified into a filesystem path.
if ($sci !== '' && !preg_match('/^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/', $sci)) {
    http_response_code(400);
    echo 'invalid sci';
    exit;
}

$BY_DATE = dirname(__DIR__, 3) . '/BirdSongs/Extracted/By_Date';

// ---- Direct-by-file lookup ----
// Used by the atlas detail modal to play any past recording.
// Filename schema (BirdNET-Pi):
//   <Common_Name>-<conf>-<YYYY-MM-DD>-birdnet-<HH-MM-SS>.mp3
// We pull the date out of the filename to locate the species
// directory under By_Date/. Whitelisted character set keeps this
// safe against path-traversal payloads.
if ($file !== '') {
    // BirdNET-Pi keeps apostrophes in some common names (e.g.
    // Anna's_Hummingbird-...mp3), so allow ' in the whitelist; the
    // regex still blocks "/" and ".." so path traversal isn't reachable.
    // Allow Unicode letters so accented common names (DATABASE_LANG=fr etc.)
    // resolve; "/" is still excluded and ".." is rejected, so the value
    // stays a safe basename.
    if (strpos($file, '..') !== false || !preg_match("/^[\\p{L}\\p{N}_.:'-]+\\.mp3$/u", $file)) {
        http_response_code(400);
        echo 'invalid file name';
        exit;
    }
    // Extract the YYYY-MM-DD from the filename if present.
    $date = null;
    if (preg_match('/(\d{4}-\d{2}-\d{2})/', $file, $m)) $date = $m[1];
    // The species directory is the prefix before the first dash-digit.
    // Try a couple of strategies: explicit species_dir param, dir from file
    // prefix, then a broader recursive search as fallback.
    $candidates = [];
    if ($date) {
        // Look in that specific date dir across every species subdir.
        $dayDir = "$BY_DATE/$date";
        if (is_dir($dayDir)) {
            foreach (scandir($dayDir) as $sub) {
                if ($sub[0] === '.') continue;
                $p = "$dayDir/$sub/$file";
                if (is_file($p)) { $candidates[] = $p; break; }
            }
        }
    }
    if (!$candidates) {
        // Fall back to scanning every date dir (slower).
        if (is_dir($BY_DATE)) {
            foreach (scandir($BY_DATE) as $d) {
                if ($d[0] === '.') continue;
                $dayDir = "$BY_DATE/$d";
                if (!is_dir($dayDir)) continue;
                foreach (scandir($dayDir) as $sub) {
                    if ($sub[0] === '.') continue;
                    $p = "$dayDir/$sub/$file";
                    if (is_file($p)) { $candidates[] = $p; break 2; }
                }
            }
        }
    }
    if (!$candidates || filesize($candidates[0]) < 64) {
        http_response_code(404);
        echo 'recording not found';
        exit;
    }
    $path = $candidates[0];
    header('Content-Type: audio/mpeg');
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: public, max-age=86400');
    header('Accept-Ranges: bytes');
    readfile($path);
    exit;
}
// ---- Resolve scientific name -> common name (with underscores) ----
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
    // Then birds.json (clean sci/com pairs, usually English).
    foreach ([dirname(__DIR__, 3) . '/BirdNET-Pi/scripts/birds.json'] as $f) {
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
    }
    // Fallback: labels.txt has "<sci>_<com>" or "<sci>, <com>" per line.
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

$common = resolve_common($sci);
if ($common === null) {
    // Last-ditch: try the scientific name itself, with spaces -> underscores.
    // (Some BirdNET dirs are keyed by sci name.)
    $common = str_replace(' ', '_', $sci);
}

// ---- Find newest matching file ----
//   Walk By_Date/* newest-first; inside each date dir, look for a
//   subdirectory named exactly $common, return the newest .mp3 inside.
function newest_recording(string $rootDir, string $common): ?string {
    if (!is_dir($rootDir)) return null;
    // Match species dirs by a normalised name so apostrophes / case /
    // punctuation don't matter: "Anna's_Hummingbird" == "Annas_Hummingbird"
    // == "annas hummingbird". BirdNET-Pi isn't consistent about the
    // apostrophe in species dir names, which is why a bird like Anna's
    // Hummingbird could 404 while every other species played fine.
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
            // Skip zero-byte / truncated files a purge may have left behind.
            if (substr($f, -4) === '.mp3' && @filesize("$speciesDir/$f") >= 64) {
                return "$speciesDir/$f";
            }
        }
    }
    return null;
}

$path = newest_recording($BY_DATE, $common);
if ($path === null || !is_file($path) || filesize($path) < 64) {
    http_response_code(404);
    echo 'no recording for ' . htmlspecialchars($sci);
    exit;
}

// ---- Serve ----
header('Content-Type: audio/mpeg');
header('Content-Length: ' . filesize($path));
header('Cache-Control: public, max-age=60');
header('Accept-Ranges: bytes');
readfile($path);
