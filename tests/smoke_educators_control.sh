#!/usr/bin/env bash
# Run only as root in a disposable Debian container with the explicit opt-in.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f /.dockerenv ] \
  || fail 'refusing Educators control smoke outside a disposable container'
[ "${AVIAN_EDUCATORS_CONTROL_TEST:-0}" = 1 ] \
  || fail 'refusing Educators control smoke without AVIAN_EDUCATORS_CONTROL_TEST=1'
[ "${EUID:-$(id -u)}" -eq 0 ] || fail 'test must run as root'
for command in flock php sqlite3; do
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
caddy_gid=$(getent group caddy | cut -d: -f3)

repo=/home/bird/BirdNET-Pi
recordings=/srv/avian-recordings
extracted=/srv/avian-extracted
processed=$recordings/Processed
mkdir -p "$repo/avian/api" "$repo/scripts" "$recordings" "$extracted" "$processed" \
  /etc/birdnet /var/lib/avian-visitors
chown -R bird:bird /home/bird
chown -R bird:bird "$recordings" "$extracted"
chmod 0755 /home/bird "$repo" "$repo/avian" "$repo/avian/api" "$repo/scripts"
cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=bird
RECS_DIR=$recordings
EXTRACTED=$extracted
PROCESSED=$processed
IDFILE=/home/bird/IdentifiedSoFar.txt
EOF
set_zone() {
  local zone=$1
  printf '%s\n' "$zone" >/etc/timezone
  ln -sfn "/usr/share/zoneinfo/$zone" /etc/localtime
}
rm -f /etc/timezone
sqlite3 "$repo/scripts/birds.db" \
  'CREATE TABLE detections(Date TEXT,Time TEXT,Com_Name TEXT,Sci_Name TEXT);'
sqlite3 "$repo/scripts/birds.db" \
  "INSERT INTO detections VALUES('2026-09-01','08:00:00','American Crow','Corvus brachyrhynchos'),('2026-09-01','08:01:00','House Finch','Haemorhous mexicanus');"
chown bird:bird "$repo/scripts/birds.db"

cat >"$repo/avian/api/educator-store.php" <<'PHP'
<?php
declare(strict_types=1);
$action = $argv[1] ?? '';
if (!in_array($action, ['init', 'stop-current', 'reset-data'], true)) exit(64);
$fd = getenv('AV_EDUCATOR_LOCK_FD');
if ($fd !== '10' || realpath('/proc/self/fd/10') !== '/var/lib/avian-visitors/educators.lock') exit(65);
$timezone = getenv('AVIAN_STATION_TIMEZONE');
if (!is_string($timezone) || !in_array($timezone, ['US/Pacific', 'America/Los_Angeles', 'Etc/GMT+8'], true)) exit(66);
$db = '/var/lib/avian-visitors/educators/educators.db';
if (!is_file($db) || filesize($db) === 0) file_put_contents($db, "stub\n");
chmod($db, 0660);
file_put_contents('/tmp/avian-educator-store-actions', $action . "\t" . trim((string)@file_get_contents('/var/lib/avian-visitors/educators.state')) . "\t" . $timezone . "\n", FILE_APPEND | LOCK_EX);
echo "{\"ok\":true}\n";
PHP
chown bird:bird "$repo/avian/api/educator-store.php"
chmod 0644 "$repo/avian/api/educator-store.php"

install -o root -g root -m 0600 /dev/null /var/lib/avian-visitors/admin-auth.lock
install -o root -g root -m 0755 /source/scripts/educators_control.sh \
  /usr/local/sbin/avian-educators
cat >/usr/local/sbin/avian-caddy-refresh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "${AVIAN_AUTH_LOCK_FD:-}" = 9 ] || exit 90
[ "$(readlink -f /proc/self/fd/9)" = /var/lib/avian-visitors/admin-auth.lock ] || exit 91
count_file=/tmp/avian-caddy-count
count=0
[ ! -f "$count_file" ] || count=$(cat "$count_file")
count=$((count + 1))
printf '%s\n' "$count" >"$count_file"
profile=missing
[ ! -f /var/lib/avian-visitors/educators.state ] \
  || profile=$(tr '\t' ':' </var/lib/avian-visitors/educators.state)
printf '%s\t%s\t%s\n' "$count" "${AVIAN_CLOSE_STREAMS:-}" \
  "$profile" \
  >>/tmp/avian-caddy-actions
if [ -f /tmp/avian-caddy-fail-at ] \
  && [ "$count" = "$(cat /tmp/avian-caddy-fail-at)" ]; then
  exit 1
fi
EOF
chmod 0755 /usr/local/sbin/avian-caddy-refresh
chown root:root /usr/local/sbin/avian-caddy-refresh

birds_pristine_hash=$(sha256sum "$repo/scripts/birds.db" | cut -d' ' -f1)
birds_pristine_schema=$(sqlite3 "$repo/scripts/birds.db" '.schema')
status=$(/usr/local/sbin/avian-educators status)
grep -Fq '"enabled":false' <<<"$status" \
  || fail 'missing profile did not report disabled'
[ ! -e /var/lib/avian-visitors/educators.lock ] \
  || fail 'read-only status created the Educators coordination lock'
refresh=$(/usr/local/sbin/avian-educators refresh-install)
grep -Fq '"enabled":false' <<<"$refresh" \
  || fail 'a pristine disabled update did not report disabled'
[ "$(stat -c '%u:%g:%a:%h' /var/lib/avian-visitors/educators.lock)" = \
  "0:$caddy_gid:660:1" ] \
  || fail 'a pristine disabled update did not provision the coordination lock'
[ ! -e /var/lib/avian-visitors/educators.state ] \
  || fail 'read-only disabled status created profile state'
[ ! -e /var/lib/avian-visitors/educators ] \
  || fail 'a pristine disabled update created Educators storage'
[ "$(sha256sum "$repo/scripts/birds.db" | cut -d' ' -f1)" = "$birds_pristine_hash" ] \
  || fail 'a pristine disabled update changed birds.db bytes'
[ "$(sqlite3 "$repo/scripts/birds.db" '.schema')" = "$birds_pristine_schema" ] \
  || fail 'a pristine disabled update changed the detections schema'
printf 'v1\tclear\n' >/var/lib/avian-visitors/educators.maintenance
chown root:caddy /var/lib/avian-visitors/educators.maintenance
chmod 0640 /var/lib/avian-visitors/educators.maintenance
if /usr/local/sbin/avian-educators status \
    >/tmp/avian-disabled-maintenance.out 2>&1; then
  fail 'read-only status ignored pending maintenance recovery'
fi
grep -Fq 'Educators maintenance recovery is required: clear' \
  /tmp/avian-disabled-maintenance.out \
  || fail 'pending maintenance recovery returned the wrong status error'
rm -f /var/lib/avian-visitors/educators.maintenance
if /usr/local/sbin/avian-educators enable >/tmp/avian-missing-timezone.out 2>&1; then
  fail 'enable accepted a missing station timezone'
fi
grep -Fq 'Station timezone was not found' /tmp/avian-missing-timezone.out \
  || fail 'enable returned the wrong missing-timezone error'
[ ! -e /var/lib/avian-visitors/educators.state ] \
  && [ ! -e /var/lib/avian-visitors/educators ] \
  || fail 'failed first enable created optional profile storage'
ln -sfn /usr/share/zoneinfo/US/Pacific /etc/localtime
printf 'Etc/UTC\n' >/etc/timezone
if /usr/local/sbin/avian-educators enable >/tmp/avian-stale-timezone.out 2>&1; then
  fail 'enable accepted a stale station timezone'
fi
grep -Fq 'Station timezone does not match the system clock' /tmp/avian-stale-timezone.out \
  || fail 'enable returned the wrong stale-timezone error'
set_zone US/Pacific

enabled=$(/usr/local/sbin/avian-educators enable)
grep -Fq '"changed":true' <<<"$enabled" || fail 'first enable did not report a change'
[ "$(cat /var/lib/avian-visitors/educators.state)" = $'v1\t1\t1' ] \
  || fail 'first enable did not commit canonical state'
[ "$(stat -c '%u:%g:%a:%h' /var/lib/avian-visitors/educators.state)" = "0:$caddy_gid:640:1" ] \
  || fail 'profile state metadata is wrong'
[ "$(stat -c '%u:%g:%a:%h' /var/lib/avian-visitors/educators.lock)" = "0:$caddy_gid:660:1" ] \
  || fail 'profile lock metadata is wrong'
for slot in /var/lib/avian-visitors/educator-audio-{0,1}.lock; do
  [ "$(stat -c '%u:%g:%a:%h' "$slot")" = "0:$caddy_gid:660:1" ] \
    || fail "audio slot metadata is wrong: $slot"
done
generation=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
[[ "$generation" =~ ^[a-f0-9]{32}$ ]] || fail 'initial detections generation is invalid'
tail -n 1 /tmp/avian-educator-store-actions | grep -Fq $'init\t\tUS/Pacific' \
  || fail 'first enable did not initialize the store before publishing profile state'
[ "$(sqlite3 "$repo/scripts/birds.db" 'SELECT COUNT(*) FROM avian_detection_sequence;')" = 2 ] \
  || fail 'first enable did not migrate every historical detection exactly once'

set_zone America/Los_Angeles
/usr/local/sbin/avian-educators refresh-install >/dev/null
tail -n 1 /tmp/avian-educator-store-actions | grep -Fq $'init\tv1\t1\t1\tAmerica/Los_Angeles' \
  || fail 'enabled update did not validate the store with the station timezone'
[ "$(sqlite3 "$repo/scripts/birds.db" 'SELECT COUNT(*) FROM avian_detection_sequence;')" = 2 ] \
  || fail 'enabled update duplicated historical detection sequence rows'
head -n 1 /tmp/avian-caddy-actions | grep -Fq $'1\t1\tmissing' \
  || fail 'first enable did not close the disabled live boundary first'
tail -n 1 /tmp/avian-caddy-actions | grep -Fq $'2\t0\tv1:1:1' \
  || fail 'enable did not restore the enabled local backend second'

set_zone Etc/GMT+8
disabled=$(/usr/local/sbin/avian-educators disable)
grep -Fq '"changed":true' <<<"$disabled" || fail 'disable did not report a change'
[ "$(cat /var/lib/avian-visitors/educators.state)" = $'v1\t0\t2' ] \
  || fail 'disable did not commit canonical state'
tail -n 1 /tmp/avian-educator-store-actions | grep -Fq $'stop-current\tv1\t1\t1\tEtc/GMT+8' \
  || fail 'disable did not stop the capture with the current fixed timezone'
tail -n 1 /tmp/avian-caddy-actions | grep -Fq $'3\t1\tv1:0:2' \
  || fail 'disable did not reconcile Caddy from disabled state'

printf 'saved classroom history\n' \
  >/var/lib/avian-visitors/educators/educators.db
disabled_birds_hash=$(sha256sum "$repo/scripts/birds.db" | cut -d' ' -f1)
disabled_store_hash=$(sha256sum /var/lib/avian-visitors/educators/educators.db | cut -d' ' -f1)
disabled_actions=$(wc -l </tmp/avian-educator-store-actions)
rm -f /etc/timezone
/usr/local/sbin/avian-educators status >/dev/null
/usr/local/sbin/avian-educators refresh-install >/dev/null
[ "$(sha256sum "$repo/scripts/birds.db" | cut -d' ' -f1)" = "$disabled_birds_hash" ] \
  || fail 'disabled update changed birds.db'
[ "$(sha256sum /var/lib/avian-visitors/educators/educators.db | cut -d' ' -f1)" = "$disabled_store_hash" ] \
  || fail 'disabled update changed saved Educators history'
[ "$(wc -l </tmp/avian-educator-store-actions)" = "$disabled_actions" ] \
  || fail 'disabled update opened the Educators store'
set_zone Etc/GMT+8

# A failed second enable phase must restore disabled state with a fresh epoch.
printf '2\n' >/tmp/avian-caddy-fail-at
printf '0\n' >/tmp/avian-caddy-count
if /usr/local/sbin/avian-educators enable >/tmp/avian-enable-failure.out 2>&1; then
  fail 'enable succeeded when the enabled Caddy render failed'
fi
[ "$(cat /var/lib/avian-visitors/educators.state)" = $'v1\t0\t4' ] \
  || fail 'failed enable did not restore disabled state with a new epoch'
rm -f /tmp/avian-caddy-fail-at

before_reset=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
profile_before=$(cat /var/lib/avian-visitors/educators.state)
/usr/local/sbin/avian-educators reset-data >/dev/null
after_reset=$(sqlite3 "$repo/scripts/birds.db" \
  "SELECT value FROM avian_metadata WHERE key='educator_generation';")
[ "$before_reset" != "$after_reset" ] || fail 'reset did not rotate detections generation'
[[ "$after_reset" =~ ^[a-f0-9]{32}$ ]] || fail 'rotated generation is invalid'
[ "$(cat /var/lib/avian-visitors/educators.state)" = "$profile_before" ] \
  || fail 'reset changed the enabled profile state'
tail -n 1 /tmp/avian-educator-store-actions | grep -Fq $'reset-data\tv1\t0\t4' \
  || fail 'reset did not clear Educators metadata'

printf '../UTC\n' >/etc/timezone
if /usr/local/sbin/avian-educators enable >/tmp/avian-invalid-timezone.out 2>&1; then
  fail 'enable accepted an invalid station timezone'
fi
grep -Fq 'Station timezone is invalid' /tmp/avian-invalid-timezone.out \
  || fail "enable returned the wrong invalid-timezone error: $(tr '\n' ' ' </tmp/avian-invalid-timezone.out)"
set_zone Etc/GMT+8

# Two simultaneous first re-enables serialize on the canonical lock. Exactly
# one advances the profile, while the other validates the committed result.
/usr/local/sbin/avian-educators enable >"$test_root/race-enable-a.out" &
race_a=$!
/usr/local/sbin/avian-educators enable >"$test_root/race-enable-b.out" &
race_b=$!
wait "$race_a" || fail 'first concurrent enable failed'
wait "$race_b" || fail 'second concurrent enable failed'
grep -Fq '"changed":true' "$test_root/race-enable-a.out" \
  || grep -Fq '"changed":true' "$test_root/race-enable-b.out" \
  || fail 'concurrent enable did not commit one transition'
grep -Fq '"changed":false' "$test_root/race-enable-a.out" \
  || grep -Fq '"changed":false' "$test_root/race-enable-b.out" \
  || fail 'concurrent enable did not observe the committed transition'
[ "$(cat /var/lib/avian-visitors/educators.state)" = $'v1\t1\t5' ] \
  || fail 'concurrent enable advanced the profile more than once'
[ "$(sqlite3 "$repo/scripts/birds.db" 'SELECT COUNT(*) FROM avian_detection_sequence;')" = 2 ] \
  || fail 'concurrent enable duplicated historical sequence rows'
/usr/local/sbin/avian-educators disable >/dev/null

birds_before_corrupt=$(sha256sum "$repo/scripts/birds.db" | cut -d' ' -f1)
printf 'not a profile\n' >/var/lib/avian-visitors/educators.state
chown root:caddy /var/lib/avian-visitors/educators.state
chmod 0640 /var/lib/avian-visitors/educators.state
if /usr/local/sbin/avian-educators status >/tmp/avian-corrupt-profile.out 2>&1; then
  fail 'malformed profile state was silently accepted'
fi
[ "$(cat /var/lib/avian-visitors/educators.state)" = 'not a profile' ] \
  || fail 'malformed profile state was silently replaced'
[ "$(sha256sum "$repo/scripts/birds.db" | cut -d' ' -f1)" = "$birds_before_corrupt" ] \
  || fail 'malformed profile state changed the detections database'

echo 'Educators control smoke passed.'
