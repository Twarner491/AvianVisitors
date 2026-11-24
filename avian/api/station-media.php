<?php
declare(strict_types=1);

// The latest playable clip must still have a detection. Its files may
// outlive that detection after a correction, or disappear first on rotation.
function station_latest_media(string $root, string $sci, string $common, bool $spectrogram): ?string {
    if (!is_dir($root)) return null;
    $wanted = educator_scope_dir_key($common);
    try {
        $db = new SQLite3(educator_birds_db_path(), SQLITE3_OPEN_READONLY);
        $db->enableExceptions(true);
        $db->busyTimeout(2000);
        $query = $db->prepare('SELECT File_Name FROM detections WHERE Date=:date AND Sci_Name=:sci '
            . 'ORDER BY Time DESC, rowid DESC');
        $query->bindValue(':sci', $sci, SQLITE3_TEXT);
        foreach (scandir($root, SCANDIR_SORT_DESCENDING) ?: [] as $date) {
            if (!preg_match('/\A\d{4}-\d{2}-\d{2}\z/D', $date) || !is_dir("$root/$date")) continue;
            foreach (scandir("$root/$date") ?: [] as $sub) {
                $dir = "$root/$date/$sub";
                if ($sub[0] === '.' || !is_dir($dir) || educator_scope_dir_key($sub) !== $wanted) continue;
                $query->bindValue(':date', $date, SQLITE3_TEXT);
                $rows = $query->execute();
                while ($row = $rows->fetchArray(SQLITE3_NUM)) {
                    $file = $row[0];
                    if (!is_string($file) || $file === '' || str_contains($file, '..')
                        || str_contains($file, '/') || str_contains($file, '\\')
                        || preg_match('/[\x00-\x1f\x7f]/u', $file) !== 0
                        || (!$spectrogram && !str_ends_with($file, '.mp3'))) continue;
                    $path = "$dir/$file" . ($spectrogram ? '.png' : '');
                    if (is_file($path) && @filesize($path) >= 64) return $path;
                }
                $rows->finalize();
                $query->reset();
            }
        }
    } catch (Throwable $error) {
        // A filesystem-only fallback could reintroduce an incorrect clip.
    }
    return null;
}
