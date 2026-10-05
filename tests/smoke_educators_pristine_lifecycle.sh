#!/usr/bin/env bash
# Run only as root in a disposable Debian container with the explicit opt-in.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f /.dockerenv ] \
  || fail 'refusing pristine Educators lifecycle smoke outside a disposable container'
[ "${AVIAN_EDUCATORS_PRISTINE_TEST:-0}" = 1 ] \
  || fail 'refusing pristine Educators lifecycle smoke without AVIAN_EDUCATORS_PRISTINE_TEST=1'
[ "${EUID:-$(id -u)}" -eq 0 ] || fail 'test must run as root'
for command in flock php runuser sha256sum sqlite3 sudo tar visudo; do
  command -v "$command" >/dev/null || fail "$command is required"
done

test_root=$(mktemp -d)
cleanup() {
  if [ -e /usr/bin/tar.avian-real ]; then
    mv -f /usr/bin/tar.avian-real /usr/bin/tar
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT

getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 \
  || useradd --system --gid caddy --no-create-home --shell /usr/sbin/nologin caddy
id bird >/dev/null 2>&1 || useradd --create-home --shell /bin/bash bird

bird_home=/home/bird
repo=$bird_home/BirdNET-Pi
recordings=/srv/avian-pristine-recordings
extracted=/srv/avian-pristine-extracted
processed=$recordings/Processed
birds_db=$repo/scripts/birds.db
profile_state=/var/lib/avian-visitors/educators.state
profile_dir=/var/lib/avian-visitors/educators
profile_db=$profile_dir/educators.db
profile_lock=/var/lib/avian-visitors/educators.lock
systemctl_log=/tmp/avian-pristine-systemctl
stop_log=/tmp/avian-pristine-stop
mkdir -p "$repo/avian/api" "$repo/scripts" "$repo/.git" \
  "$repo/homepage" "$repo/model" "$repo/templates" \
  "$bird_home/phpsysinfo/templates/html" "$recordings" "$processed" \
  "$extracted/Charts" "$extracted/By_Date" /etc/birdnet
for api_file in admin-auth.php admin-state.php birdnet-api.php educator-scope.php \
  educator-state.php educator-store.php export.php recording.php; do
  cp "/source/avian/api/$api_file" "$repo/avian/api/$api_file"
done
cp /source/scripts/backup_data.sh "$repo/scripts/backup_data.sh"
cp /source/scripts/clear_all_data.sh "$repo/scripts/clear_all_data.sh"

cat >"$repo/scripts/stop_core_services.sh" <<'EOF'
#!/bin/sh
printf 'stop\n' >>/tmp/avian-pristine-stop
EOF
cat >"$repo/scripts/install_language_label.sh" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$repo/scripts/createdb.sh" <<'EOF'
#!/bin/sh
set -eu
database=/home/bird/BirdNET-Pi/scripts/birds.db
rm -f -- "$database" "$database-wal" "$database-shm" "$database-journal"
sqlite3 "$database" <<'SQL'
CREATE TABLE detections(Date TEXT, Time TEXT, Com_Name TEXT, Sci_Name TEXT);
SQL
chmod 0664 "$database"
EOF
chmod 0755 "$repo/scripts"/*.sh

printf 'fixture\n' >"$repo/homepage/index.php"
printf 'labels\n' >"$repo/model/labels.txt"
for fixture in phpsysinfo.ini green_bootstrap.css index_bootstrap.html; do
  printf 'fixture\n' >"$repo/templates/$fixture"
done
for fixture in exclude_species_list.txt confirmed_species_list.txt \
  include_species_list.txt whitelist_species_list.txt; do
  : >"$repo/$fixture"
done
cat >"$repo/birdnet.conf" <<EOF
BIRDNET_USER=bird
RECS_DIR=$recordings
EXTRACTED=$extracted
PROCESSED=$processed
IDFILE=$bird_home/IdentifiedSoFar.txt
CADDY_PWD=
EOF
ln -s "$repo/birdnet.conf" /etc/birdnet/birdnet.conf
printf 'US/Pacific\n' >/etc/timezone
ln -sfn /usr/share/zoneinfo/US/Pacific /etc/localtime

prepare_base_database() {
  rm -f -- "$birds_db" "$birds_db-wal" "$birds_db-shm" "$birds_db-journal"
  sqlite3 "$birds_db" <<'SQL'
CREATE TABLE detections(Date TEXT, Time TEXT, Com_Name TEXT, Sci_Name TEXT);
INSERT INTO detections VALUES('2026-09-02','09:00:00','American Crow','Corvus brachyrhynchos');
SQL
  chown bird:bird "$birds_db"
  chmod 0664 "$birds_db"
}

prepare_base_media() {
  rm -rf -- "$extracted/Charts" "$extracted/By_Date"
  mkdir -p "$extracted/Charts" "$extracted/By_Date"
  printf 'base chart\n' >"$extracted/Charts/base.txt"
  printf 'base recording\n' >"$extracted/By_Date/base.mp3"
  printf 'base export\n' >"$repo/BirdDB.txt"
  chown -R bird:bird "$extracted" "$repo/BirdDB.txt"
}

assert_uninitialized() {
  [ ! -e "$profile_state" ] && [ ! -L "$profile_state" ] \
    || fail 'pristine lifecycle created Educators profile state'
  [ ! -e "$profile_dir" ] && [ ! -L "$profile_dir" ] \
    || fail 'pristine lifecycle created Educators profile storage'
}

assert_coordination_lock() {
  local caddy_gid
  caddy_gid=$(getent group caddy | cut -d: -f3)
  [ "$(stat -c '%u:%g:%a:%h' "$profile_lock")" = "0:$caddy_gid:660:1" ] \
    || fail 'Educators coordination lock metadata is unsafe'
}

assert_base_schema() {
  [ "$(sqlite3 "$birds_db" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='detections';")" = 1 ] \
    || fail 'base detections table is missing'
  [ "$(sqlite3 "$birds_db" \
    "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('avian_metadata','avian_detection_sequence','avian_detection_sequence_insert','avian_detection_sequence_delete','avian_detection_sequence_update');")" = 0 ] \
    || fail 'pristine lifecycle installed Educators detection authority'
}

assert_restarts() {
  local service count
  count=$(awk '$1 == "restart" { count++ } END { print count + 0 }' "$systemctl_log")
  [ "$count" = 7 ] || fail "expected 7 service restarts, found $count"
  for service in chart_viewer.service spectrogram_viewer.service icecast2.service \
    birdnet_recording.service birdnet_analysis.service birdnet_log.service \
    birdnet_stats.service; do
    [ "$(grep -c "^restart $service$" "$systemctl_log")" = 1 ] \
      || fail "service restart was missing or duplicated: $service"
  done
}

prepare_base_database
prepare_base_media
chown -R bird:bird "$bird_home" "$recordings" "$extracted" "$test_root"
chmod 0755 "$bird_home" "$repo" "$repo/avian" "$repo/avian/api" "$repo/scripts"

install -o root -g root -m 0755 /source/scripts/educators_control.sh \
  /usr/local/sbin/avian-educators
install -d -o root -g root -m 0755 /var/lib/avian-visitors
install -o root -g root -m 0600 /dev/null /var/lib/avian-visitors/admin-auth.lock
cat >/usr/local/sbin/avian-caddy-refresh <<'EOF'
#!/bin/sh
exit 0
EOF
cat >/usr/local/sbin/avian-link-webroot <<'EOF'
#!/bin/sh
exit 0
EOF
chown root:root /usr/local/sbin/avian-caddy-refresh /usr/local/sbin/avian-link-webroot
chmod 0755 /usr/local/sbin/avian-caddy-refresh /usr/local/sbin/avian-link-webroot
cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>/tmp/avian-pristine-systemctl
exit 0
EOF
chmod 0755 /usr/bin/systemctl
: >"$systemctl_log"
: >"$stop_log"
chown bird:bird "$stop_log"

cat >/etc/sudoers.d/avian-educators-pristine-test <<'EOF'
bird ALL=(root) NOPASSWD: /usr/local/sbin/avian-educators backup-snapshot, \
    /usr/local/sbin/avian-educators restore-staged, \
    /usr/local/sbin/avian-educators discard-snapshot *, \
    /usr/local/sbin/avian-educators restart-services
bird ALL=(bird) NOPASSWD: /usr/bin/ln, /usr/bin/touch
bird ALL=(root) NOPASSWD: /usr/bin/systemctl stop birdnet_recording.service, \
    /usr/bin/systemctl stop birdnet_analysis.service, \
    /usr/local/sbin/avian-caddy-refresh
EOF
chmod 0440 /etc/sudoers.d/avian-educators-pristine-test
visudo -cf /etc/sudoers.d/avian-educators-pristine-test >/dev/null

base_hash=$(sha256sum "$birds_db" | cut -d' ' -f1)
base_schema=$(sqlite3 "$birds_db" '.schema')
[ ! -e "$profile_lock" ] && [ ! -L "$profile_lock" ] \
  || fail 'pristine update fixture already had an Educators coordination lock'
refresh=$(/usr/local/sbin/avian-educators refresh-install)
grep -Fq '"enabled":false' <<<"$refresh" \
  || fail 'pristine update did not report Educators disabled'
assert_coordination_lock
assert_uninitialized
assert_base_schema
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'coordination lock provisioning changed the detections database'

# Global APIs take the Educators lock even when the optional profile is
# absent. A default update must make those ordinary station views available
# without manufacturing profile state, storage, or detection authority.
api_birds_db=$repo/scripts/api-birds.db
sqlite3 "$api_birds_db" <<'SQL'
CREATE TABLE detections(
  Date TEXT, Time TEXT, Sci_Name TEXT, Com_Name TEXT, Confidence REAL,
  Lat REAL, Lon REAL, Cutoff REAL, Week INTEGER, Sens REAL, Overlap REAL,
  File_Name TEXT
);
INSERT INTO detections VALUES(
  '2020-01-01','09:00:00','Corvus brachyrhynchos','American Crow',0.91,
  37.0,-122.0,0.1,1,1.0,0.0,'American_Crow-0.91-2020-01-01-birdnet-09-00-00.mp3'
);
SQL
chown caddy:caddy "$api_birds_db"
chmod 0640 "$api_birds_db"
api_runner=$repo/api-pristine-runner.php
cat >"$api_runner" <<'PHP'
<?php
declare(strict_types=1);
if ($argc !== 3) exit(64);
parse_str($argv[2], $_GET);
$_SERVER = [
    'REQUEST_METHOD' => 'GET',
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_HOST' => 'birdpic.local',
    'REQUEST_SCHEME' => 'http',
    'QUERY_STRING' => $argv[2],
];
require $argv[1];
PHP
chmod 0644 "$api_runner"
api_env=(AV_EDUCATOR_BIRDS_DB="$api_birds_db" AV_REQUIRE_AUTH=0)
runuser -u caddy -- env "${api_env[@]}" /usr/bin/php "$api_runner" \
  "$repo/avian/api/birdnet-api.php" action=stats >"$test_root/api-stats.out"
grep -Fq '"totals":{"detections":1,"species":1}' "$test_root/api-stats.out" \
  || fail 'global BirdNET stats were unavailable after a pristine update'

media_dir=$bird_home/BirdSongs/Extracted/By_Date/2020-01-01/American_Crow
mkdir -p "$media_dir"
media_file=$media_dir/American_Crow-0.91-2020-01-01-birdnet-09-00-00.mp3
printf '%s' \
  'global media fixture global media fixture global media fixture global media fixture' \
  >"$media_file"
chmod 0644 "$media_file"
runuser -u caddy -- env "${api_env[@]}" /usr/bin/php "$api_runner" \
  "$repo/avian/api/recording.php" 'sci=Corvus+brachyrhynchos' \
  >"$test_root/api-recording.out"
cmp -s "$media_file" "$test_root/api-recording.out" \
  || fail 'global recording media was unavailable after a pristine update'

runuser -u caddy -- env "${api_env[@]}" /usr/bin/php "$api_runner" \
  "$repo/avian/api/export.php" what=detections >"$test_root/api-export.out"
grep -Fq 'Date,Time,Sci_Name,Com_Name,Confidence,Lat,Lon,Cutoff,Week,Sens,Overlap,File_Name' \
  "$test_root/api-export.out" \
  && grep -Fq '2020-01-01,09:00:00,"Corvus brachyrhynchos","American Crow"' \
    "$test_root/api-export.out" \
  || fail 'global detections export was unavailable after a pristine update'
assert_coordination_lock
assert_uninitialized
assert_base_schema
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'pristine global API reads changed the live detections database'

pristine_archive=$test_root/pristine.tar
if ! runuser -u bird -- "$repo/scripts/backup_data.sh" -a backup -f - \
    >"$pristine_archive" 2>"$test_root/pristine-backup.err"; then
  cat "$test_root/pristine-backup.err" >&2
  fail 'pristine backup command failed'
fi
[ -s "$pristine_archive" ] || fail 'pristine backup archive is empty'
if tar -tf "$pristine_archive" | sed 's#^\./##' | grep -qx 'educators.db'; then
  fail 'pristine backup unexpectedly included an Educators database'
fi
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'pristine backup changed the live detections database'
[ ! -e "$birds_db-wal" ] && [ ! -e "$birds_db-shm" ] && [ ! -e "$birds_db-journal" ] \
  || fail 'pristine backup left a live SQLite sidecar'
assert_uninitialized
assert_base_schema
assert_restarts
[ "$(find /var/lib/avian-visitors/educator-backups -mindepth 1 -maxdepth 1 | wc -l)" = 0 ] \
  || fail 'pristine backup left a privileged snapshot behind'

pristine_root=$test_root/pristine
mkdir "$pristine_root"
tar -C "$pristine_root" -xf "$pristine_archive"
archive_birds_hash=$(sha256sum "$pristine_root/birds.db" | cut -d' ' -f1)

# A tar failure happens after services stop and after the database snapshot.
# Cleanup must discard the snapshot and restart writers without initializing
# Educators or changing the live detections database.
: >"$systemctl_log"
mv /usr/bin/tar /usr/bin/tar.avian-real
cat >/usr/bin/tar <<'EOF'
#!/bin/sh
[ "${1:-}" != --create ] || exit 73
exec /usr/bin/tar.avian-real "$@"
EOF
chmod 0755 /usr/bin/tar
if runuser -u bird -- "$repo/scripts/backup_data.sh" -a backup -f - \
    >"$test_root/failed.tar" 2>"$test_root/failed-backup.err"; then
  fail 'injected pristine backup failure unexpectedly succeeded'
fi
mv /usr/bin/tar.avian-real /usr/bin/tar
assert_restarts
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'failed pristine backup changed the live detections database'
assert_uninitialized
[ "$(find /var/lib/avian-visitors/educator-backups -mindepth 1 -maxdepth 1 | wc -l)" = 0 ] \
  || fail 'failed pristine backup left a privileged snapshot behind'

# A partially failed stop script is also treated as potentially stopped, so
# cleanup must restart the complete writer set before returning failure.
cat >"$repo/scripts/stop_core_services.sh" <<'EOF'
#!/bin/sh
printf 'partial stop\n' >>/tmp/avian-pristine-stop
exit 74
EOF
chmod 0755 "$repo/scripts/stop_core_services.sh"
: >"$systemctl_log"
if runuser -u bird -- "$repo/scripts/backup_data.sh" -a backup -f - \
    >"$test_root/stop-failed.tar" 2>"$test_root/stop-failed.err"; then
  fail 'injected service-stop failure unexpectedly succeeded'
fi
assert_restarts
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'failed service stop changed the live detections database'
assert_uninitialized
cat >"$repo/scripts/stop_core_services.sh" <<'EOF'
#!/bin/sh
printf 'stop\n' >>/tmp/avian-pristine-stop
EOF
chmod 0755 "$repo/scripts/stop_core_services.sh"

install -o bird -g bird -m 0664 /dev/null "$birds_db-wal"
: >"$systemctl_log"
if runuser -u bird -- "$repo/scripts/backup_data.sh" -a backup -f - \
    >"$test_root/nonquiescent.tar" 2>"$test_root/nonquiescent.err"; then
  fail 'pristine backup accepted pending SQLite sidecar state'
fi
assert_restarts
rm -f -- "$birds_db-wal"
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'nonquiescent backup rejection changed the live detections database'
assert_uninitialized

: >"$systemctl_log"
/usr/local/sbin/avian-educators restart-services >/dev/null
assert_restarts
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'pristine service restart changed the detections database'
assert_uninitialized

: >"$systemctl_log"
recovery=$(/usr/local/sbin/avian-educators recover)
grep -Fq '"recovered":false' <<<"$recovery" \
  || fail 'pristine no-marker recovery was not an idempotent no-op'
[ ! -s "$systemctl_log" ] || fail 'no-marker recovery unexpectedly restarted services'
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$base_hash" ] \
  && [ "$(sqlite3 "$birds_db" '.schema')" = "$base_schema" ] \
  || fail 'pristine no-marker recovery changed the detections database'
assert_uninitialized

# A legacy archive restores only the base data. It must not manufacture a
# profile or add Educators tables and triggers to birds.db.
sqlite3 "$birds_db" \
  "INSERT INTO detections VALUES('2026-09-02','10:00:00','House Finch','Haemorhous mexicanus');"
printf 'changed chart\n' >"$extracted/Charts/changed.txt"
printf 'changed recording\n' >"$extracted/By_Date/changed.mp3"
chown -R bird:bird "$extracted"
: >"$systemctl_log"
runuser -u bird -- sh -c \
  "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$pristine_archive'" \
  >"$test_root/pristine-restore.out" 2>&1
assert_restarts
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$archive_birds_hash" ] \
  || fail 'legacy pristine restore installed the wrong detections snapshot'
[ -f "$extracted/Charts/base.txt" ] && [ -f "$extracted/By_Date/base.mp3" ] \
  || fail 'legacy pristine restore did not restore media'
assert_uninitialized
assert_base_schema

corrupt_root=$test_root/corrupt
mkdir "$corrupt_root"
tar -C "$corrupt_root" -xf "$pristine_archive"
printf 'not sqlite\n' >"$corrupt_root/birds.db"
corrupt_archive=$test_root/corrupt.tar
tar -C "$corrupt_root" -cf "$corrupt_archive" .
chown bird:bird "$corrupt_archive"
before_reject_hash=$(sha256sum "$birds_db" | cut -d' ' -f1)
: >"$systemctl_log"
if runuser -u bird -- sh -c \
    "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$corrupt_archive'" \
    >"$test_root/corrupt-restore.out" 2>&1; then
  fail 'corrupt pristine restore unexpectedly succeeded'
fi
assert_restarts
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$before_reject_hash" ] \
  || fail 'rejected pristine restore changed the live detections database'
assert_uninitialized
assert_base_schema

# Base clear uses its own durable marker and recreates only BirdNET-Pi data.
sqlite3 "$birds_db" \
  "INSERT INTO detections VALUES('2026-09-02','11:00:00','California Scrub-Jay','Aphelocoma californica');"
printf 'clear me\n' >"$extracted/By_Date/clear.mp3"
printf 'clear me\n' >"$extracted/Charts/clear.png"
chown -R bird:bird "$recordings" "$extracted"
: >"$systemctl_log"
/usr/local/sbin/avian-educators clear-all >"$test_root/base-clear.out"
assert_restarts
[ "$(sqlite3 "$birds_db" 'SELECT COUNT(*) FROM detections;')" = 0 ] \
  || fail 'pristine clear retained detections'
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'pristine clear retained its maintenance marker'
assert_uninitialized
assert_base_schema

# A kill after the base clear core leaves writers stopped behind clear-base.
# Boot recovery reruns the clear without recursively starting guarded services.
sqlite3 "$birds_db" \
  "INSERT INTO detections VALUES('2026-09-02','12:00:00','Bushtit','Psaltriparus minimus');"
printf 'clear recovery\n' >"$extracted/By_Date/recovery.mp3"
chown -R bird:bird "$recordings" "$extracted"
awk '
  { print }
  /^clear_base_data[(][)] [{]$/ { in_base=1 }
  in_base && index($0, "|| fail '\''BirdNET-Pi data could not be cleared'\''") && $0 !~ /\\$/ {
    print "  kill -KILL \"$$\""
    found=1
    in_base=0
  }
  END { if (!found) exit 1 }
' /source/scripts/educators_control.sh >"$test_root/avian-educators-clear-base-kill"
install -o root -g root -m 0755 "$test_root/avian-educators-clear-base-kill" \
  /usr/local/sbin/avian-educators
: >"$systemctl_log"
if /usr/local/sbin/avian-educators clear-all \
    >"$test_root/base-clear-killed.out" 2>&1; then
  fail 'pristine clear unexpectedly survived the SIGKILL seam'
fi
install -o root -g root -m 0755 /source/scripts/educators_control.sh \
  /usr/local/sbin/avian-educators
[ "$(cat /var/lib/avian-visitors/educators.maintenance)" = $'v1\tclear-base' ] \
  || fail 'interrupted pristine clear retained the wrong marker'
if grep -q '^restart ' "$systemctl_log"; then
  fail 'interrupted pristine clear restarted writers before recovery'
fi
assert_uninitialized
: >"$systemctl_log"
AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
  /usr/local/sbin/avian-educators recover >"$test_root/base-clear-recover.out"
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'pristine clear recovery retained its marker'
if grep -q '^restart ' "$systemctl_log"; then
  fail 'boot recovery recursively restarted a guarded service'
fi
[ "$(sqlite3 "$birds_db" 'SELECT COUNT(*) FROM detections;')" = 0 ] \
  || fail 'pristine clear recovery retained detections'
assert_uninitialized
assert_base_schema

# Build a valid paired backup, then exercise its first import on a station
# whose canonical profile and optional store have never been initialized.
prepare_base_database
prepare_base_media
/usr/local/sbin/avian-educators enable >/dev/null
/usr/local/sbin/avian-educators disable >/dev/null
generation=$(sqlite3 "$birds_db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
sqlite3 "$profile_db" <<'SQL'
INSERT INTO folders(public_id,name,revision,created_at_utc,updated_at_utc)
VALUES('f_55555555555555555555555555555555','Imported Biology',1,
  '2026-09-02T16:00:00Z','2026-09-02T16:00:00Z');
SQL
chown caddy:caddy "$profile_db"
chmod 0660 "$profile_db"
paired_archive=$test_root/paired.tar
runuser -u bird -- "$repo/scripts/backup_data.sh" -a backup -f - \
  >"$paired_archive" 2>"$test_root/paired-backup.err"
[ -s "$paired_archive" ] || fail 'paired import fixture is empty'

reset_to_uninitialized_base() {
  rm -f -- "$profile_state"
  if [ -d "$profile_dir" ] && [ ! -L "$profile_dir" ]; then
    find "$profile_dir" -xdev -depth -delete
  fi
  prepare_base_database
  prepare_base_media
}

reset_to_uninitialized_base
import_base_hash=$(sha256sum "$birds_db" | cut -d' ' -f1)
awk -v needle="|| fail 'Could not install restored charts'" '
  { print }
  index($0, needle) && $0 !~ /\\$/ { print "  kill -KILL \"$$\""; found=1 }
  END { if (!found) exit 1 }
' /source/scripts/educators_control.sh >"$test_root/avian-educators-import-kill"
install -o root -g root -m 0755 "$test_root/avian-educators-import-kill" \
  /usr/local/sbin/avian-educators
: >"$systemctl_log"
if runuser -u bird -- sh -c \
    "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$paired_archive'" \
    >"$test_root/import-killed.out" 2>&1; then
  fail 'first paired import unexpectedly survived the rollback seam'
fi
install -o root -g root -m 0755 /source/scripts/educators_control.sh \
  /usr/local/sbin/avian-educators
[ "$(cat /var/lib/avian-visitors/educators.maintenance)" = $'v1\trestore-import' ] \
  || fail 'interrupted first import retained the wrong marker'
if grep -q '^restart ' "$systemctl_log"; then
  fail 'interrupted first import restarted writers before recovery'
fi
AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
  /usr/local/sbin/avian-educators recover >"$test_root/import-recover.out"
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'first import rollback recovery retained its marker'
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$import_base_hash" ] \
  || fail 'first import rollback did not restore the base detections database'
[ -f "$extracted/Charts/base.txt" ] && [ -f "$extracted/By_Date/base.mp3" ] \
  || fail 'first import rollback did not restore base media'
assert_uninitialized
assert_base_schema

: >"$systemctl_log"
runuser -u bird -- sh -c \
  "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$paired_archive'" \
  >"$test_root/import.out" 2>&1
assert_restarts
[ "$(cat "$profile_state")" = $'v1\t0\t0' ] \
  || fail 'first paired import did not publish a disabled canonical profile'
[ "$(sqlite3 "$profile_db" \
  "SELECT name FROM folders WHERE public_id='f_55555555555555555555555555555555';")" = \
  'Imported Biology' ] || fail 'first paired import lost Educators history'
[ "$(sqlite3 "$birds_db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")" = "$generation" ] \
  || fail 'first paired import installed a mismatched detections generation'

# Once the commit marker is durable, recovery must retain the imported pair
# and remove only rollback artifacts.
reset_to_uninitialized_base
awk -v needle='write_maintenance_state "$committed_mode" "$restore_mode"' '
  { print }
  index($0, needle) && $0 !~ /\\$/ { print "  kill -TERM \"$$\""; found=1 }
  END { if (!found) exit 1 }
' /source/scripts/educators_control.sh >"$test_root/avian-educators-import-committed-kill"
install -o root -g root -m 0755 "$test_root/avian-educators-import-committed-kill" \
  /usr/local/sbin/avian-educators
: >"$systemctl_log"
if runuser -u bird -- sh -c \
    "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$paired_archive'" \
    >"$test_root/import-committed-killed.out" 2>&1; then
  fail 'first paired import unexpectedly survived the committed seam'
fi
install -o root -g root -m 0755 /source/scripts/educators_control.sh \
  /usr/local/sbin/avian-educators
[ "$(cat /var/lib/avian-visitors/educators.maintenance)" = \
  $'v1\trestore-import-committed' ] \
  || fail 'committed first import retained the wrong marker'
AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
  /usr/local/sbin/avian-educators recover >"$test_root/import-committed-recover.out"
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'committed first import recovery retained its marker'
[ "$(cat "$profile_state")" = $'v1\t0\t0' ] \
  || fail 'committed first import recovery changed canonical profile state'
[ "$(sqlite3 "$profile_db" \
  "SELECT name FROM folders WHERE public_id='f_55555555555555555555555555555555';")" = \
  'Imported Biology' ] || fail 'committed first import recovery lost Educators history'
if grep -q '^restart ' "$systemctl_log"; then
  fail 'boot recovery recursively restarted services after committed import'
fi

# Mismatched no-profile storage is not treated as pristine and cannot trigger
# a backup or writer restart.
rm -f -- "$profile_state"
find "$profile_dir" -xdev -depth -delete
install -d -o root -g caddy -m 0770 "$profile_dir"
install -o caddy -g caddy -m 0660 /dev/null "$profile_db"
birds_before_partial=$(sha256sum "$birds_db" | cut -d' ' -f1)
if /usr/local/sbin/avian-educators status >"$test_root/partial-status.out" 2>&1; then
  fail 'partial no-profile storage was accepted as pristine'
fi
: >"$systemctl_log"
if /usr/local/sbin/avian-educators restart-services \
    >"$test_root/partial-restart.out" 2>&1; then
  fail 'partial no-profile storage allowed services to restart'
fi
[ ! -s "$systemctl_log" ] || fail 'partial profile storage restarted a service'
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$birds_before_partial" ] \
  || fail 'partial profile rejection changed the detections database'

find "$profile_dir" -xdev -depth -delete
printf 'v1\t0\t0\n' >"$profile_state"
chown root:caddy "$profile_state"
chmod 0640 "$profile_state"
if /usr/local/sbin/avian-educators status \
    >"$test_root/missing-store-status.out" 2>&1; then
  fail 'canonical profile without its store was accepted'
fi
: >"$systemctl_log"
if /usr/local/sbin/avian-educators restart-services \
    >"$test_root/missing-store-restart.out" 2>&1; then
  fail 'canonical profile without its store allowed services to restart'
fi
[ ! -s "$systemctl_log" ] || fail 'missing Educators store restarted a service'
[ "$(sha256sum "$birds_db" | cut -d' ' -f1)" = "$birds_before_partial" ] \
  || fail 'missing-store rejection changed the detections database'

echo 'Pristine Educators lifecycle smoke passed.'
