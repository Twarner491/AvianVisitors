# Nightly Google Drive archive + rolling disk clear

A BirdNET-Pi station on a 28-32GB SD card records roughly 150-400MB of
extracted clips a day; the card fills in a few months. This extra archives
every completed day's recordings to Google Drive, sorted into one folder per
species, plus per-day analytics CSVs from the detections database, verifies
every file landed (rclone `check`; Drive stores md5), and only then, if you
opt in, clears those days from the SD card. An upload or verification failure
leaves that day local and the next night's run picks up the backlog. The
archive is idempotent and self-healing.

What lands in Drive:

```
AvianVisitors/
├── Recordings/
│   ├── Chimney_Swift/            every clip + spectrogram, filenames
│   │                             already carry date + time
│   └── <Species>/...
└── Analytics/
    ├── 2026-07-15-detections.csv  every detection: time, species, confidence
    └── 2026-07-15-summary.csv     per-species count, first/last heard, max conf
```

## Safety model

- waits until every species in a day verifies, then deletes **only** files it
  enumerated before upload; directories fall to `rmdir` only, so a straggler
  extraction or stray file survives and flags the day for the next night
- never touches today's directory, `birds.db` rows, `BirdDB.txt`,
  StreamData/, Charts/, cutouts/, or the web-root symlinks
- reads the database from a point-in-time snapshot (`.backup`), so the
  live analyzer's inserts are never blocked
- refuses to run without NTP sync; waits out fresh boots so the analyzer
  can drain its backlog; retries an unreachable Drive before giving up
  without deleting the affected day
- writes `~/bird-archive/status` (`OK`/`FAIL` + timestamp); check it, or
  wire it to your notifier of choice; a station that can't upload keeps
  recording and keeps its files

## Setup

The guided path is under **Settings → Nightly Drive backup**. It installs the
worker without enabling it, checks the two dependencies, and manages the timer
and safe cleanup mode. Google authorization remains a one-time `rclone config`
step because the OAuth token should stay between rclone and Google. The page
never reads or stores it.

When you enable the nightly archive, the interface also turns on **Preserve all
recordings** and sets **When disk fills** to `keep`. This prevents BirdNET-Pi's
independent cleanup from deleting an unarchived backlog while Drive is offline.
Clearing verified local files remains disabled until a safe run finishes.
That run must verify at least one file, so an empty first night cannot unlock
cleanup without exercising the upload path.

For a manual install:

1. Run `sudo apt install rclone sqlite3` on the Pi, then use `rclone config`
   to create a Google Drive remote named `gdrive`. When rclone asks for the
   access scope, choose `drive.file`, which limits the remote to files and
   folders rclone created. Let the archive create its `AvianVisitors` folder
   rather than creating that folder in Drive first. On a headless Pi, follow
   rclone's prompt to authorize from a machine with a browser and paste the
   resulting token back into the Pi.
2. In AvianVisitors settings, turn on **Preserve all recordings** and set
   **When disk fills** to `keep`.
3. Copy this directory to `~/bird-archive/`, then:
   ```
   cp archive.conf.example ~/bird-archive/archive.conf   # edit REMOTE if needed
   chmod +x ~/bird-archive/archive_to_drive.sh
   # If your username is not pi, change both User= and /home/pi in ExecStart.
   sudo cp bird-archive.{service,timer} /etc/systemd/system/
   sudo systemctl daemon-reload
   ```
4. First run in safe mode (`PURGE=false`, the default): run
   `~/bird-archive/archive_to_drive.sh` manually, watch
   `~/bird-archive/archive.log`, and eyeball the files in Drive.
5. When satisfied: set `PURGE=true` (and `KEEP_DAYS=1` if you want
   yesterday to stay playable on the website for one extra day), then
   `sudo systemctl enable --now bird-archive.timer` (03:15 nightly,
   catches up after downtime).

Note: once old days are purged, the website does not stream them from Drive.
The detail modal still lists historical detections because they remain in the
database, but purged recordings return 404. Stats, the collage, and the frame
are database-driven and unaffected.
