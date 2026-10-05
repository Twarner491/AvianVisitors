#!/usr/bin/env bash
# Run only as root in a disposable Debian container with the explicit opt-in.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f /.dockerenv ] \
  || fail 'refusing Educators restore smoke outside a disposable container'
[ "${AVIAN_EDUCATOR_RESTORE_TEST:-0}" = 1 ] \
  || fail 'refusing Educators restore smoke without AVIAN_EDUCATOR_RESTORE_TEST=1'
[ "${EUID:-$(id -u)}" -eq 0 ] || fail 'test must run as root'
for command in flock php runuser sqlite3 sudo systemd-analyze tar; do
  command -v "$command" >/dev/null || fail "$command is required"
done

test_root=$(mktemp -d)
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 \
  || useradd --system --gid caddy --no-create-home --shell /usr/sbin/nologin caddy
id bird >/dev/null 2>&1 || useradd --create-home --shell /bin/bash bird

bird_home=/home/bird
repo=$bird_home/BirdNET-Pi
recordings=/srv/avian-educator-recordings
extracted=/srv/avian-educator-extracted
processed=$recordings/Processed
mkdir -p "$repo/avian/api" "$repo/scripts" "$repo/.git" \
  "$recordings" "$processed" "$extracted/Charts" "$extracted/By_Date" /etc/birdnet
cp /source/avian/api/educator-store.php "$repo/avian/api/educator-store.php"
cp /source/scripts/backup_data.sh "$repo/scripts/backup_data.sh"
cp /source/scripts/clear_all_data.sh "$repo/scripts/clear_all_data.sh"
cat >"$repo/scripts/stop_core_services.sh" <<'EOF'
#!/bin/sh
printf 'stop\n' >>/tmp/avian-educator-restore-order
EOF
cat >"$repo/scripts/restart_services.sh" <<'EOF'
#!/bin/sh
printf 'restart\n' >>/tmp/avian-educator-restore-order
EOF
cat >"$repo/scripts/install_language_label.sh" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$repo/scripts"/*.sh

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

sqlite3 "$repo/scripts/birds.db" <<'SQL'
CREATE TABLE detections(Date TEXT, Time TEXT, Com_Name TEXT, Sci_Name TEXT);
INSERT INTO detections VALUES('2026-08-31','09:00:00','American Crow','Corvus brachyrhynchos');
SQL
printf 'current export\n' >"$repo/BirdDB.txt"
printf 'original chart\n' >"$extracted/Charts/original.txt"
printf 'original recording\n' >"$extracted/By_Date/original.mp3"
chown -R bird:bird "$bird_home" "$recordings" "$extracted" "$test_root"
chmod 0755 "$bird_home" "$repo" "$repo/avian" "$repo/avian/api" "$repo/scripts"
chmod 0664 "$repo/scripts/birds.db"

install -o root -g root -m 0755 /source/scripts/educators_control.sh \
  /usr/local/sbin/avian-educators
mkdir -p /var/lib/avian-visitors
install -o root -g root -m 0600 /dev/null /var/lib/avian-visitors/admin-auth.lock
cat >/usr/local/sbin/avian-caddy-refresh <<'EOF'
#!/bin/sh
exit 0
EOF
chown root:root /usr/local/sbin/avian-caddy-refresh
chmod 0755 /usr/local/sbin/avian-caddy-refresh

if ! /usr/local/sbin/avian-educators enable >/tmp/avian-educator-initial-status 2>&1 \
  || ! /usr/local/sbin/avian-educators disable >>/tmp/avian-educator-initial-status 2>&1; then
  cat /tmp/avian-educator-initial-status >&2
  sqlite3 "$repo/scripts/birds.db" '.schema' >&2 || true
  runuser -u caddy -- php -r '
    $db = new SQLite3($argv[1], SQLITE3_OPEN_READONLY);
    var_dump($db->querySingle("SELECT value FROM avian_metadata WHERE key=\"educator_generation\""));
    var_dump($db->querySingle("SELECT COALESCE(MAX(sequence),0) FROM avian_detection_sequence"));
  ' "$repo/scripts/birds.db" >&2 || true
  fail 'initial Educators store setup failed'
fi
mv /usr/bin/systemctl /usr/bin/systemctl.real
cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>/tmp/avian-educator-systemctl
exit 0
EOF
chmod 0755 /usr/bin/systemctl
/usr/local/sbin/avian-educators install-recovery-unit >/dev/null
mv /usr/bin/systemctl.real /usr/bin/systemctl
recovery_unit=/etc/systemd/system/avian-educators-recover.service
[ -f "$recovery_unit" ] && [ ! -L "$recovery_unit" ] \
  && [ "$(stat -c '%U:%G:%a:%h' "$recovery_unit")" = root:root:644:1 ] \
  || fail 'boot recovery unit metadata is unsafe'
grep -Fq 'ConditionPathExists=/var/lib/avian-visitors/educators.maintenance' "$recovery_unit" \
  || fail 'boot recovery unit does not gate on the durable marker'
grep -Fq 'ExecStart=/usr/local/sbin/avian-educators recover' "$recovery_unit" \
  || fail 'boot recovery unit does not use the fixed root helper'
grep -Fq 'Environment=AVIAN_EDUCATOR_BOOT_RECOVERY=1' "$recovery_unit" \
  || fail 'boot recovery unit does not suppress recursive service starts'
for guarded_service in caddy.service birdnet_recording.service birdnet_analysis.service; do
  guarded_dropin=/etc/systemd/system/$guarded_service.d/05-avian-educators-recovery.conf
  grep -Fq 'Requires=avian-educators-recover.service' "$guarded_dropin" \
    && grep -Fq 'After=avian-educators-recover.service' "$guarded_dropin" \
    || fail "boot recovery ordering is missing for $guarded_service"
  printf '%s\n' '[Service]' 'Type=oneshot' 'ExecStart=/bin/true' \
    >"/etc/systemd/system/$guarded_service"
done
if ! systemd-analyze verify \
    "$recovery_unit" \
    /etc/systemd/system/caddy.service \
    /etc/systemd/system/birdnet_recording.service \
    /etc/systemd/system/birdnet_analysis.service \
    >"$test_root/recovery-unit-verify.out" 2>&1; then
  cat "$test_root/recovery-unit-verify.out" >&2
  fail 'boot recovery unit or guarded service ordering is invalid'
fi
mv /usr/bin/systemctl /usr/bin/systemctl.real
cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
case "${1:-}" in
  restart) printf 'restart\n' >>/tmp/avian-educator-restore-order ;;
esac
exit 0
EOF
chmod 0755 /usr/bin/systemctl
generation=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
[[ "$generation" =~ ^[a-f0-9]{32}$ ]] || fail 'initial generation is invalid'
first_detection_rowid=$(sqlite3 "$repo/scripts/birds.db" 'SELECT rowid FROM detections LIMIT 1;')
first_detection_sequence=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT sequence FROM avian_detection_sequence WHERE detection_rowid=$first_detection_rowid;")
sqlite3 "$repo/scripts/birds.db" \
  "DELETE FROM detections WHERE rowid=$first_detection_rowid; INSERT INTO detections VALUES('2026-08-31','09:00:00','American Crow','Corvus brachyrhynchos');"
reused_detection_rowid=$(sqlite3 "$repo/scripts/birds.db" 'SELECT rowid FROM detections LIMIT 1;')
reused_detection_sequence=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT sequence FROM avian_detection_sequence WHERE detection_rowid=$reused_detection_rowid;")
[ "$reused_detection_rowid" = "$first_detection_rowid" ] \
  || fail 'rowid-reuse fixture did not reuse the deleted detections rowid'
[ "$reused_detection_sequence" -gt "$first_detection_sequence" ] \
  || fail 'detections sequence floor moved backwards after rowid reuse'
profile_db=/var/lib/avian-visitors/educators/educators.db
started_epoch=$(date -u -d '2026-08-31T16:00:00Z' +%s)
sqlite3 "$profile_db" <<SQL
PRAGMA foreign_keys=ON;
INSERT INTO folders(public_id,name,revision,created_at_utc,updated_at_utc)
VALUES('f_11111111111111111111111111111111','Biology 1',1,'2026-08-31T16:00:00Z','2026-08-31T16:00:00Z');
INSERT INTO captures(public_id,name,status,folder_id,started_local,started_at_utc,started_epoch,
  started_offset,started_timezone,revision,created_at_utc,updated_at_utc)
VALUES('c_22222222222222222222222222222222','Period 1','running',1,'2026-08-31 09:00:00','2026-08-31T16:00:00Z',
  $started_epoch,'-07:00','US/Pacific',1,'2026-08-31T16:00:00Z','2026-08-31T16:00:00Z');
INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,
  started_offset,started_timezone,birds_generation,start_sequence,revision)
VALUES(1,'2026-08-31 09:00:00','2026-08-31T16:00:00Z',$started_epoch,
  '-07:00','US/Pacific','$generation',0,1);
SQL
chown caddy:caddy "$profile_db"
chmod 0660 "$profile_db"

cat >/etc/sudoers.d/avian-educator-restore-test <<'EOF'
bird ALL=(root) NOPASSWD: /usr/local/sbin/avian-educators backup-snapshot, \
    /usr/local/sbin/avian-educators restore-staged, \
    /usr/local/sbin/avian-educators discard-snapshot *, \
    /usr/local/sbin/avian-educators restart-services
EOF
chmod 0440 /etc/sudoers.d/avian-educator-restore-test
visudo -cf /etc/sudoers.d/avian-educator-restore-test >/dev/null

paired_archive=$test_root/paired.tar
if ! runuser -u bird -- "$repo/scripts/backup_data.sh" -a backup -f - \
    >"$paired_archive" 2>"$test_root/backup.err"; then
  cat "$test_root/backup.err" >&2
  fail 'paired backup command failed'
fi
[ -s "$paired_archive" ] || fail 'paired backup archive is empty'
[ "$(find /var/lib/avian-visitors/educator-backups -mindepth 1 -maxdepth 1 | wc -l)" = 0 ] \
  || fail 'successful backup left a privileged snapshot behind'

paired_root=$test_root/paired
mkdir "$paired_root"
tar -C "$paired_root" -xf "$paired_archive"
[ -f "$paired_root/educators.db" ] || fail 'paired backup omitted Educators history'
archive_generation=$(sqlite3 "$paired_root/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
[ "$archive_generation" = "$generation" ] || fail 'paired backup changed its generation'
[ "$(sqlite3 "$paired_root/educators.db" \
  "SELECT status FROM captures WHERE public_id='c_22222222222222222222222222222222';")" = stopped ] \
  || fail 'backup did not normalize the active listening period'
[ "$(sqlite3 "$profile_db" \
  "SELECT status FROM captures WHERE public_id='c_22222222222222222222222222222222';")" = running ] \
  || fail 'backup modified the live listening period'

sqlite3 "$repo/scripts/birds.db" \
  "DELETE FROM detections; UPDATE avian_metadata SET value=lower(hex(randomblob(16))) WHERE key='educator_generation';"
sqlite3 "$profile_db" 'DELETE FROM captures; DELETE FROM folders;'
printf 'changed chart\n' >"$extracted/Charts/changed.txt"
rm -f "$extracted/Charts/original.txt" "$extracted/By_Date/original.mp3"
printf 'changed recording\n' >"$extracted/By_Date/changed.mp3"
chown -R bird:bird "$extracted"

runuser -u bird -- sh -c \
  "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$paired_archive'" \
  >"$test_root/paired-restore.out" 2>&1
restored_generation=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
[ "$restored_generation" = "$archive_generation" ] \
  || fail 'paired restore did not preserve the detections generation'
[ "$(sqlite3 "$profile_db" "SELECT name FROM folders WHERE public_id='f_11111111111111111111111111111111';")" = 'Biology 1' ] \
  || fail 'paired restore lost the saved classroom folder'
[ "$(sqlite3 "$profile_db" "SELECT status FROM captures WHERE public_id='c_22222222222222222222222222222222';")" = stopped ] \
  || fail 'paired restore reopened a listening period'
[ -f "$extracted/Charts/original.txt" ] && [ -f "$extracted/By_Date/original.mp3" ] \
  || fail 'paired restore did not restore media'

legacy_root=$test_root/legacy
mkdir "$legacy_root"
tar -C "$legacy_root" -xf "$paired_archive"
rm "$legacy_root/educators.db"
legacy_archive=$test_root/legacy.tar
tar -C "$legacy_root" -cf "$legacy_archive" .
chown bird:bird "$legacy_archive"
if ! runuser -u bird -- sh -c \
  "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$legacy_archive'" \
  >"$test_root/legacy-restore.out" 2>&1; then
  cat "$test_root/legacy-restore.out" >&2
  fail 'legacy restore command failed'
fi
legacy_generation=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
[ "$legacy_generation" != "$archive_generation" ] \
  || fail 'legacy restore did not rotate the detections generation'
[ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM captures;')" = 0 ] \
  && [ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM folders;')" = 0 ] \
  || fail 'legacy restore retained stale Educators history'
grep -Fq 'Legacy backup has no Educators history' "$test_root/legacy-restore.out" \
  || fail 'legacy restore did not report its Educators migration'

mismatch_root=$test_root/mismatch
mkdir "$mismatch_root"
tar -C "$mismatch_root" -xf "$paired_archive"
sqlite3 "$mismatch_root/educators.db" \
  "UPDATE capture_segments SET birds_generation='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';"
mismatch_archive=$test_root/mismatch.tar
tar -C "$mismatch_root" -cf "$mismatch_archive" .
chown bird:bird "$mismatch_archive"
printf 'current chart\n' >"$extracted/Charts/current.txt"
printf 'current recording\n' >"$extracted/By_Date/current.mp3"
chown -R bird:bird "$extracted"
generation_before_reject=$legacy_generation
if runuser -u bird -- sh -c \
    "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$mismatch_archive'" \
    >"$test_root/mismatch.out" 2>&1; then
  fail 'mismatched database pair was restored'
fi
[ "$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")" = \
  "$generation_before_reject" ] \
  || fail 'rejected pair changed the live detections database'
[ -f "$extracted/Charts/current.txt" ] && [ -f "$extracted/By_Date/current.mp3" ] \
  || fail 'rejected pair changed live media'

sequence_bad_root=$test_root/sequence-bad
mkdir "$sequence_bad_root"
tar -C "$sequence_bad_root" -xf "$paired_archive"
sqlite3 "$sequence_bad_root/birds.db" \
  'DROP TRIGGER avian_detection_sequence_insert;'
sequence_bad_archive=$test_root/sequence-bad.tar
tar -C "$sequence_bad_root" -cf "$sequence_bad_archive" .
chown bird:bird "$sequence_bad_archive"
if runuser -u bird -- sh -c \
  "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$sequence_bad_archive'" \
  >"$test_root/sequence-bad.out" 2>&1; then
  fail 'restore accepted a detections database with a missing sequence trigger'
fi
[ "$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")" = \
  "$generation_before_reject" ] \
  || fail 'rejected sequence authority changed the live detections database'
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'preflight sequence rejection left a maintenance marker'

# Fail after By_Date has been replaced but before Charts is installed. A
# shared scope lock must remain blocked throughout, and rollback must restore
# the original media and both databases before the lock is released.
mv /usr/sbin/runuser /usr/sbin/runuser.real
cat >/usr/sbin/runuser <<EOF
#!/bin/sh
if [ "\${1:-}" = -u ] && [ "\${2:-}" = bird ]; then
  for argument in "\$@"; do
    if [ "\$argument" = '$recordings/tmp/Charts' ] && [ ! -e /tmp/avian-restore-failed-once ]; then
      touch /tmp/avian-restore-window
      sleep 3
      touch /tmp/avian-restore-failed-once
      exit 77
    fi
  done
fi
exec /usr/sbin/runuser.real "\$@"
EOF
chmod 0755 /usr/sbin/runuser
runuser -u bird -- sh -c \
  "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$paired_archive'" \
  >"$test_root/interrupted.out" 2>&1 &
restore_pid=$!
for _ in $(seq 1 50); do
  [ -e /tmp/avian-restore-window ] && break
  sleep 0.1
done
[ -e /tmp/avian-restore-window ] || fail 'restore did not reach the partial replacement window'
if flock -s -n /var/lib/avian-visitors/educators.lock -c true; then
  fail 'scoped reads could enter during partial media replacement'
fi
if wait "$restore_pid"; then
  fail 'injected partial restore unexpectedly succeeded'
fi
mv /usr/sbin/runuser.real /usr/sbin/runuser
[ "$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")" = \
  "$generation_before_reject" ] \
  || fail 'partial restore rollback changed the detections database'
[ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM captures;')" = 0 ] \
  || fail 'partial restore rollback changed Educators history'
[ -f "$extracted/Charts/current.txt" ] && [ -f "$extracted/By_Date/current.mp3" ] \
  || fail 'partial restore rollback did not restore live media'
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'ordinary restore rollback left the maintenance marker active'
[ "$(tail -n 1 /tmp/avian-educator-restore-order)" = restart ] \
  || fail 'failed restore did not restart stopped services'

# SIGKILL cannot run the root helper's rollback trap. The durable marker must
# keep every educator-aware read closed until the fixed rollback paths are
# recovered under the exclusive lock.
restart_count_before_kill=$(awk '$0 == "restart" { count++ } END { print count + 0 }' \
  /tmp/avian-educator-restore-order)
mv /usr/sbin/runuser /usr/sbin/runuser.real
cat >/usr/sbin/runuser <<EOF
#!/bin/sh
if [ "\${1:-}" = -u ] && [ "\${2:-}" = bird ]; then
  for argument in "\$@"; do
    if [ "\$argument" = '$recordings/tmp/Charts' ] && [ ! -e /tmp/avian-restore-killed ]; then
      touch /tmp/avian-restore-killed
      kill -KILL "\$PPID"
      sleep 1
      exit 137
    fi
  done
fi
exec /usr/sbin/runuser.real "\$@"
EOF
chmod 0755 /usr/sbin/runuser
if runuser -u bird -- sh -c \
  "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$paired_archive'" \
  >"$test_root/killed.out" 2>&1; then
  fail 'SIGKILL restore unexpectedly succeeded'
fi
mv /usr/sbin/runuser.real /usr/sbin/runuser
[ -e /tmp/avian-restore-killed ] || fail 'restore SIGKILL hook did not run'
[ "$(cat /var/lib/avian-visitors/educators.maintenance)" = $'v1\trestore' ] \
  || fail 'SIGKILL restore did not retain the fail-closed marker'
[ "$(stat -c '%U:%G:%a:%h' /var/lib/avian-visitors/educators.maintenance)" = root:caddy:640:1 ] \
  || fail 'restore maintenance marker metadata is unsafe'
[ -d "$extracted/.By_Date.avian-old" ] \
  || fail 'SIGKILL restore did not retain its rollback data'
[ "$(awk '$0 == "restart" { count++ } END { print count + 0 }' \
  /tmp/avian-educator-restore-order)" = "$restart_count_before_kill" ] \
  || fail 'restore cleanup restarted writers while recovery was pending'
grep -Fq 'Services remain stopped until Educators maintenance recovery completes' \
  "$test_root/killed.out" \
  || fail 'interrupted restore did not report that writers remain stopped'
: >"$test_root/boot-order.log"
if AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
    /usr/local/sbin/avian-educators recover >"$test_root/recover.out"; then
  printf 'recovery\n' >>"$test_root/boot-order.log"
  printf 'caddy\nrecording\nanalysis\n' >>"$test_root/boot-order.log"
else
  fail 'boot recovery could not roll back the interrupted restore'
fi
[ "$(tr '\n' ' ' <"$test_root/boot-order.log")" = \
  'recovery caddy recording analysis ' ] \
  || fail 'guarded services did not wait for boot recovery'
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'restore recovery did not remove the maintenance marker'
[ ! -e "$extracted/.By_Date.avian-old" ] \
  || fail 'restore recovery retained the old media tree'
[ -f "$extracted/Charts/current.txt" ] && [ -f "$extracted/By_Date/current.mp3" ] \
  || fail 'restore recovery did not restore the pre-transaction media'
[ "$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")" = \
  "$generation_before_reject" ] \
  || fail 'restore recovery changed the detections database'
second_recovery=$(AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
  /usr/local/sbin/avian-educators recover)
grep -Fq '"recovered":false' <<<"$second_recovery" \
  || fail 'a second boot recovery was not an idempotent no-op'
printf 'invalid\n' >/var/lib/avian-visitors/educators.maintenance
chown root:caddy /var/lib/avian-visitors/educators.maintenance
chmod 0640 /var/lib/avian-visitors/educators.maintenance
: >"$test_root/corrupt-boot-order.log"
if AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
    /usr/local/sbin/avian-educators recover >"$test_root/corrupt-recover.out" 2>&1; then
  printf 'caddy\n' >>"$test_root/corrupt-boot-order.log"
fi
[ ! -s "$test_root/corrupt-boot-order.log" ] \
  || fail 'a guarded service started after corrupt recovery state'
[ -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'corrupt recovery state was removed without recovery'
rm -f /var/lib/avian-visitors/educators.maintenance

for seam in charts birds educators committed; do
  case "$seam" in
    charts) needle="|| fail 'Could not install restored charts'" ;;
    birds) needle='chown "$birdnet_user:$birdnet_gid" "$birds_db" && chmod 0664 "$birds_db"' ;;
    educators) needle='chown caddy:caddy "$PROFILE_DB" && chmod 0660 "$PROFILE_DB"' ;;
    committed) needle='write_maintenance_state "$committed_mode" "$restore_mode"' ;;
  esac
  awk -v needle="$needle" '
    { print }
    index($0, needle) && $0 !~ /\\$/ { print "  kill -KILL \"$$\""; found=1 }
    END { if (!found) exit 1 }
  ' /source/scripts/educators_control.sh >"$test_root/avian-educators-$seam"
  install -o root -g root -m 0755 "$test_root/avian-educators-$seam" \
    /usr/local/sbin/avian-educators
  if runuser -u bird -- sh -c \
    "exec '$repo/scripts/backup_data.sh' -a restore -f - <'$paired_archive'" \
    >"$test_root/killed-$seam.out" 2>&1; then
    fail "restore unexpectedly survived the $seam SIGKILL seam"
  fi
  install -o root -g root -m 0755 /source/scripts/educators_control.sh \
    /usr/local/sbin/avian-educators
  expected_marker=restore
  [ "$seam" != committed ] || expected_marker=restore-committed
  if [ ! -f /var/lib/avian-visitors/educators.maintenance ] \
    || [ "$(cat /var/lib/avian-visitors/educators.maintenance)" != \
      "v1"$'\t'"$expected_marker" ]; then
    cat "$test_root/killed-$seam.out" >&2
    fail "restore $seam seam retained the wrong maintenance marker"
  fi
  AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
    /usr/local/sbin/avian-educators recover >"$test_root/recover-$seam.out"
  [ ! -e /var/lib/avian-visitors/educators.maintenance ] \
    || fail "restore $seam recovery retained the maintenance marker"
  if [ "$seam" = committed ]; then
    [ -f "$extracted/Charts/original.txt" ] \
      && [ -f "$extracted/By_Date/original.mp3" ] \
      || fail 'committed restore recovery did not retain the validated new media'
    [ "$(sqlite3 "$repo/scripts/birds.db" \
      "SELECT value FROM avian_metadata WHERE key='educator_generation';")" = \
      "$archive_generation" ] \
      || fail 'committed restore recovery rolled back the validated database pair'
  else
    [ -f "$extracted/Charts/current.txt" ] \
      && [ -f "$extracted/By_Date/current.mp3" ] \
      || fail "restore $seam recovery did not roll back the old media"
    [ "$(sqlite3 "$repo/scripts/birds.db" \
      "SELECT value FROM avian_metadata WHERE key='educator_generation';")" = \
      "$generation_before_reject" ] \
      || fail "restore $seam recovery changed the old database pair"
  fi
done

# The repeated fall-back hour is not representable in BirdNET's offset-less
# Date/Time columns. Disable and backup must both leave the live capture and
# enabled profile untouched until a safe wall-clock boundary exists.
printf 'America/Los_Angeles\n' >/etc/timezone
ln -sfn /usr/share/zoneinfo/America/Los_Angeles /etc/localtime
/usr/local/sbin/avian-educators enable >/dev/null
fold_started_epoch=$(date -u -d '2026-11-01T06:00:00Z' +%s)
fold_sequence=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT COALESCE(MAX(sequence),0) FROM avian_detection_sequence;")
fold_generation=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
sqlite3 "$profile_db" <<SQL
INSERT INTO captures(public_id,name,status,folder_id,started_local,started_at_utc,started_epoch,
  started_offset,started_timezone,revision,created_at_utc,updated_at_utc)
VALUES('c_33333333333333333333333333333333','Fall-back period','running',NULL,
  '2026-10-31 23:00:00','2026-11-01T06:00:00Z',$fold_started_epoch,'-07:00',
  'America/Los_Angeles',1,'2026-11-01T06:00:00Z','2026-11-01T06:00:00Z');
INSERT INTO capture_segments(capture_id,started_local,started_at_utc,started_epoch,
  started_offset,started_timezone,birds_generation,start_sequence,revision)
VALUES((SELECT id FROM captures WHERE public_id='c_33333333333333333333333333333333'),
  '2026-10-31 23:00:00','2026-11-01T06:00:00Z',$fold_started_epoch,'-07:00',
  'America/Los_Angeles','$fold_generation',$fold_sequence,1);
SQL
mv /usr/bin/php /usr/bin/php.real
cat >/usr/bin/php <<'EOF'
#!/bin/sh
AV_EDUCATOR_NOW=$(cat /tmp/avian-educator-now)
export AV_EDUCATOR_NOW
exec /usr/bin/php.real "$@"
EOF
chmod 0755 /usr/bin/php
printf '%s\n' '2026-11-01T01:30:00-08:00' >/tmp/avian-educator-now
profile_before_fold=$(cat /var/lib/avian-visitors/educators.state)
if /usr/local/sbin/avian-educators disable >"$test_root/fold-disable.out" 2>&1; then
  fail 'disable accepted the repeated daylight-saving hour'
fi
[ "$(cat /var/lib/avian-visitors/educators.state)" = "$profile_before_fold" ] \
  || fail 'failed fall-back disable changed the enabled profile'
[ "$(sqlite3 "$profile_db" \
  "SELECT status FROM captures WHERE public_id='c_33333333333333333333333333333333';")" = running ] \
  || fail 'failed fall-back disable stopped the live capture'
[ "$(sqlite3 "$profile_db" \
  "SELECT COUNT(*) FROM capture_segments WHERE stopped_epoch IS NULL;")" = 1 ] \
  || fail 'failed fall-back disable changed the open segment'
if runuser -u bird -- "$repo/scripts/backup_data.sh" -a backup -f - \
  >"$test_root/fold.tar" 2>"$test_root/fold-backup.out"; then
  fail 'backup normalized a capture during the repeated daylight-saving hour'
fi
[ "$(sqlite3 "$profile_db" \
  "SELECT status FROM captures WHERE public_id='c_33333333333333333333333333333333';")" = running ] \
  || fail 'failed fall-back backup changed the live capture'
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'failed fall-back backup opened a maintenance transaction'
printf '%s\n' '2026-11-01T03:00:00-08:00' >/tmp/avian-educator-now
/usr/local/sbin/avian-educators disable >/dev/null
mv /usr/bin/php.real /usr/bin/php

# Clearing detections is also a multi-path transaction. Kill the root helper
# after the media/database reset but before Educators metadata is reset. The
# durable marker must keep every scoped and unscoped data route closed, and a
# boot recovery must safely rerun the clear without retaining old ranges.
mkdir -p "$repo/homepage" "$repo/model" "$repo/templates" \
  "$bird_home/phpsysinfo/templates/html"
printf 'fixture\n' >"$repo/homepage/index.php"
printf 'labels\n' >"$repo/model/labels.txt"
for fixture in phpsysinfo.ini green_bootstrap.css index_bootstrap.html; do
  printf 'fixture\n' >"$repo/templates/$fixture"
done
for fixture in exclude_species_list.txt confirmed_species_list.txt \
  include_species_list.txt whitelist_species_list.txt; do
  : >"$repo/$fixture"
done
cat >"$repo/scripts/createdb.sh" <<'EOF'
#!/bin/sh
set -eu
database=/home/bird/BirdNET-Pi/scripts/birds.db
rm -f -- "$database" "$database-wal" "$database-shm"
sqlite3 "$database" <<'SQL'
CREATE TABLE detections(Date TEXT, Time TEXT, Com_Name TEXT, Sci_Name TEXT);
SQL
chmod 0664 "$database"
EOF
chmod 0755 "$repo/scripts/createdb.sh"
cat >/usr/local/sbin/avian-link-webroot <<'EOF'
#!/bin/sh
exit 0
EOF
chown root:root /usr/local/sbin/avian-link-webroot
chmod 0755 /usr/local/sbin/avian-link-webroot
cat >/usr/local/sbin/avian-caddy-refresh <<'EOF'
#!/bin/sh
printf 'refresh\n' >>/tmp/avian-educator-clear-caddy
exit 0
EOF
chown root:root /usr/local/sbin/avian-caddy-refresh
chmod 0755 /usr/local/sbin/avian-caddy-refresh
chown -R bird:bird "$repo/homepage" "$repo/model" "$repo/templates" \
  "$bird_home/phpsysinfo" "$repo"/*.txt "$repo/scripts/createdb.sh"

cat >/etc/sudoers.d/avian-educator-clear-recovery-test <<'EOF'
bird ALL=(bird) NOPASSWD: /usr/bin/ln, /usr/bin/touch
bird ALL=(root) NOPASSWD: /usr/bin/systemctl stop birdnet_recording.service, \
    /usr/bin/systemctl stop birdnet_analysis.service, \
    /usr/local/sbin/avian-caddy-refresh
EOF
chmod 0440 /etc/sudoers.d/avian-educator-clear-recovery-test
visudo -cf /etc/sudoers.d/avian-educator-clear-recovery-test >/dev/null
cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>/tmp/avian-educator-clear-systemctl
exit 0
EOF
chmod 0755 /usr/bin/systemctl

old_clear_generation=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
sqlite3 "$profile_db" <<'SQL'
INSERT INTO folders(public_id,name,revision,created_at_utc,updated_at_utc)
VALUES('f_44444444444444444444444444444444','Clear recovery fixture',1,
  '2026-11-01T12:00:00Z','2026-11-01T12:00:00Z');
SQL
printf 'must be cleared\n' >"$extracted/By_Date/clear-recovery.mp3"
printf 'must be cleared\n' >"$extracted/Charts/clear-recovery.png"
chown -R bird:bird "$recordings" "$extracted"
profile_before_clear=$(cat /var/lib/avian-visitors/educators.state)
[ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM captures;')" -gt 0 ] \
  && [ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM folders;')" -gt 0 ] \
  || fail 'clear recovery metadata fixture is incomplete'

awk -v needle="|| fail 'BirdNET-Pi data could not be cleared'" '
  { print }
  index($0, needle) && $0 !~ /\\$/ { print "  kill -KILL \"$$\""; found=1 }
  END { if (!found) exit 1 }
' /source/scripts/educators_control.sh >"$test_root/avian-educators-clear-kill"
install -o root -g root -m 0755 "$test_root/avian-educators-clear-kill" \
  /usr/local/sbin/avian-educators
if /usr/local/sbin/avian-educators clear-all \
    >"$test_root/clear-killed.out" 2>&1; then
  fail 'clear unexpectedly survived the SIGKILL seam'
fi
install -o root -g root -m 0755 /source/scripts/educators_control.sh \
  /usr/local/sbin/avian-educators
[ -f /var/lib/avian-visitors/educators.maintenance ] \
  && [ "$(cat /var/lib/avian-visitors/educators.maintenance)" = $'v1\tclear' ] \
  || fail 'clear SIGKILL did not retain the fail-closed marker'
[ "$(cat /var/lib/avian-visitors/educators.state)" = "$profile_before_clear" ] \
  || fail 'interrupted clear changed the Educators profile state'
[ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM captures;')" -gt 0 ] \
  && [ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM folders;')" -gt 0 ] \
  || fail 'clear SIGKILL occurred after Educators metadata reset'
if grep -q '^restart ' /tmp/avian-educator-clear-systemctl; then
  fail 'interrupted clear restarted a writer while its marker was active'
fi
for endpoint in birdnet-api.php recording.php spectrogram.php export.php; do
  route_result=$(runuser -u caddy -- /usr/bin/php -r '
    $_GET = ["action" => "stats", "sci" => "Corvus brachyrhynchos", "what" => "detections"];
    $_SERVER = ["REMOTE_ADDR" => "192.168.1.20", "REQUEST_METHOD" => "GET", "HTTP_HOST" => "birdnet.local"];
    register_shutdown_function(static function (): void {
      fwrite(STDERR, "\n__HTTP__" . (string)http_response_code() . "\n");
    });
    include $argv[1];
  ' "/source/avian/api/$endpoint" 2>&1 || true)
  grep -Fq '__HTTP__503' <<<"$route_result" \
    || { printf '%s\n' "$route_result" >&2; fail "maintenance marker did not close $endpoint"; }
done

: >"$test_root/clear-boot-order.log"
if AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
    /usr/local/sbin/avian-educators recover >"$test_root/clear-recover.out"; then
  printf 'recovery\n' >>"$test_root/clear-boot-order.log"
  printf 'caddy\nrecording\nanalysis\n' >>"$test_root/clear-boot-order.log"
else
  fail 'boot recovery could not complete the interrupted clear'
fi
[ "$(tr '\n' ' ' <"$test_root/clear-boot-order.log")" = \
  'recovery caddy recording analysis ' ] \
  || fail 'guarded services did not wait for clear recovery'
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'clear recovery retained the maintenance marker'
new_clear_generation=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
[[ "$new_clear_generation" =~ ^[a-f0-9]{32}$ ]] \
  && [ "$new_clear_generation" != "$old_clear_generation" ] \
  || fail 'clear recovery did not rotate the detections generation'
[ "$(sqlite3 "$repo/scripts/birds.db" 'SELECT COUNT(*) FROM detections;')" = 0 ] \
  && [ "$(sqlite3 "$repo/scripts/birds.db" 'SELECT COUNT(*) FROM avian_detection_sequence;')" = 0 ] \
  || fail 'clear recovery retained detections or sequence mappings'
[ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM captures;')" = 0 ] \
  && [ "$(sqlite3 "$profile_db" 'SELECT COUNT(*) FROM folders;')" = 0 ] \
  || fail 'clear recovery retained Educators metadata'
[ -d "$extracted/By_Date" ] && [ -d "$extracted/Charts" ] \
  && [ ! -e "$extracted/By_Date/clear-recovery.mp3" ] \
  && [ ! -e "$extracted/Charts/clear-recovery.png" ] \
  || fail 'clear recovery retained old media or missed the clean layout'
if grep -q '^restart ' /tmp/avian-educator-clear-systemctl; then
  fail 'boot recovery recursively started a service ordered after itself'
fi
[ ! -e /tmp/avian-educator-clear-caddy ] \
  || fail 'boot recovery recursively started or reloaded Caddy'
second_clear_recovery=$(AVIAN_EDUCATOR_BOOT_RECOVERY=1 \
  /usr/local/sbin/avian-educators recover)
grep -Fq '"recovered":false' <<<"$second_clear_recovery" \
  || fail 'a second clear recovery was not an idempotent no-op'
: >/tmp/avian-educator-clear-systemctl
/usr/local/sbin/avian-educators clear-all >"$test_root/runtime-clear.out"
[ -s /tmp/avian-educator-clear-caddy ] \
  || fail 'runtime clear did not refresh Caddy'
for service in birdnet_recording.service birdnet_analysis.service; do
  grep -q "^restart $service$" /tmp/avian-educator-clear-systemctl \
    || fail "runtime clear did not restart $service"
done
[ ! -e /var/lib/avian-visitors/educators.maintenance ] \
  || fail 'runtime clear retained the maintenance marker'

# birdnet.conf is user-editable. Even if it points at system or another
# account's paths, clear-all must never grant root authority to that path.
cat >/etc/sudoers.d/avian-educator-malicious-clear-test <<'EOF'
bird ALL=(root) NOPASSWD: /usr/bin/systemctl stop birdnet_recording.service, \
    /usr/bin/systemctl stop birdnet_analysis.service
EOF
chmod 0440 /etc/sudoers.d/avian-educator-malicious-clear-test
visudo -cf /etc/sudoers.d/avian-educator-malicious-clear-test >/dev/null
printf 'root sentinel\n' >/var/avian-educator-root-sentinel

cat >"$repo/birdnet.conf" <<EOF
BIRDNET_USER=bird
RECS_DIR=/etc
EXTRACTED=$extracted
PROCESSED=/etc/Processed
IDFILE=$bird_home/IdentifiedSoFar.txt
CADDY_PWD=
EOF
if /usr/local/sbin/avian-educators clear-all \
    >"$test_root/malicious-etc.out" 2>&1; then
  fail 'clear-all accepted /etc as a privileged recordings target'
fi
[ -f /etc/passwd ] && [ -f /etc/timezone ] \
  || fail 'malicious recordings path changed system files'

malicious_recordings=/srv/avian-malicious-recordings
mkdir -p "$malicious_recordings/Processed"
chown -R bird:bird "$malicious_recordings"
cat >"$repo/birdnet.conf" <<EOF
BIRDNET_USER=bird
RECS_DIR=$malicious_recordings
EXTRACTED=/var
PROCESSED=$malicious_recordings/Processed
IDFILE=$bird_home/IdentifiedSoFar.txt
CADDY_PWD=
EOF
if /usr/local/sbin/avian-educators clear-all \
    >"$test_root/malicious-var.out" 2>&1; then
  fail 'clear-all accepted /var as a privileged extracted target'
fi
[ -f /var/avian-educator-root-sentinel ] \
  || fail 'malicious extracted path changed root-owned data'
[ -f "$profile_db" ] && [ -f /var/lib/avian-visitors/admin-auth.lock ] \
  || fail 'malicious configured paths changed Avian state'
mv /usr/bin/systemctl.real /usr/bin/systemctl

echo 'Educators paired backup and restore smoke passed.'
