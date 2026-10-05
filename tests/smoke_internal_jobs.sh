#!/usr/bin/env bash
# Run as root in a disposable Debian container with the repository at /source.

set -euo pipefail
IFS=$'\n\t'

fail() { echo "FAIL: $*" >&2; exit 1; }

[ "${EUID:-$(id -u)}" -eq 0 ] || fail "test must run as root"
test_root=$(mktemp -d)
home=$test_root/home
repo=$home/BirdNET-Pi
extracted=$home/BirdSongs/Extracted
by_date=$extracted/By_Date/2026-08-26/Test_Bird
processed=$home/BirdSongs/Processed
test_bin=$test_root/bin
mkdir -p "$repo/scripts" "$repo/birdnet/bin" "$by_date" "$processed" \
  "$extracted/scripts" \
  "$test_bin" /etc/birdnet

cat >"$test_bin/df" <<'EOF'
#!/bin/sh
printf '%s\n' \
  'Filesystem Size Used Avail Use% Mounted on' \
  'fixture 100G 96G 4G 96% /fixture'
EOF
cat >"$test_bin/curl" <<EOF
#!/bin/sh
touch "$test_root/curl.called"
exit 90
EOF
chmod 0755 "$test_bin/df" "$test_bin/curl"

cat >"$extracted/scripts/common.php" <<'PHP'
<?php
function set_timezone() {
  date_default_timezone_set('Pacific/Auckland');
}
PHP

cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=bird
EXTRACTED=$extracted
PROCESSED=$processed
FULL_DISK=purge
PURGE_THRESHOLD=95
APPRISE_WEEKLY_REPORT=1
EOF

cat >"$extracted/stats.php" <<'PHP'
<?php
$instant = new DateTimeImmutable('2026-08-30 12:30:00', new DateTimeZone('UTC'));
if (date_default_timezone_get() !== 'Pacific/Auckland'
    || $instant->format('N') !== '7'
    || $instant->setTimezone(new DateTimeZone(date_default_timezone_get()))->format('N') !== '1') {
  exit(3);
}
$target = getenv('HOME') . '/BirdNET-Pi/scripts/disk_check_exclude.txt';
file_put_contents($target, "##start\n2026-08-26/Test_Bird/A-protected.wav\n##end\n");
PHP
printf 'protected\n' >"$by_date/A-protected.wav"
printf 'delete\n' >"$by_date/B-delete.wav"
printf 'processed\n' >"$processed/old.wav"

# Required LAN mode closes views.php. The cleanup job must not depend on that
# HTTP route, and it must refresh the exclusion list before deleting anything.
HOME="$home" PATH="$test_bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  bash /source/scripts/disk_check.sh >"$test_root/disk.log" 2>&1 \
  || fail "disk cleanup failed with the legacy HTTP route unavailable"
[ ! -e "$test_root/curl.called" ] || fail "disk cleanup called the protected HTTP route"
[ -f "$by_date/A-protected.wav" ] || fail "disk cleanup removed a protected recording"
[ ! -e "$by_date/B-delete.wav" ] || fail "disk cleanup retained its deletion candidate"

# An early exit(0), including the database busy path, must not count as a
# completed refresh even when a stale exclusion file still looks valid.
cat >"$extracted/stats.php" <<'PHP'
<?php exit(0);
PHP
printf 'keep on failure\n' >"$by_date/B-keep.wav"
if HOME="$home" PATH="$test_bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  bash /source/scripts/disk_check.sh >"$test_root/disk-failure.log" 2>&1; then
  fail "disk cleanup continued after its exclusion refresh failed"
fi
[ -f "$by_date/B-keep.wav" ] || fail "failed exclusion refresh allowed a deletion"

# Exercise the production stats writer as an unprivileged station user. A
# valid but unwritable old list must make stats.php fail before the purge.
cp /source/scripts/stats.php "$extracted/stats.php"
cat >"$extracted/scripts/common.php" <<'PHP'
<?php
if (!defined('SQLITE3_ASSOC')) define('SQLITE3_ASSOC', 1);
final class EmptySpeciesResult {
  public function fetchArray($mode) { return false; }
}
function set_timezone() { date_default_timezone_set('Pacific/Auckland'); }
function get_home() { return getenv('HOME'); }
function fetch_species_array($sort) { return new EmptySpeciesResult(); }
PHP
printf '##start\n2026-08-26/Test_Bird/A-protected.wav\n##end\n' \
  >"$repo/scripts/disk_check_exclude.txt"
printf 'keep after write failure\n' >"$by_date/C-keep.wav"
if ! id bird >/dev/null 2>&1; then
  useradd --home-dir "$home" --no-create-home bird
fi
chmod 0755 "$test_root"
chown -R bird:bird "$home"
chown root:root "$repo/scripts/disk_check_exclude.txt"
chmod 0444 "$repo/scripts/disk_check_exclude.txt"
if runuser -u bird -- env HOME="$home" \
  PATH="$test_bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  bash /source/scripts/disk_check.sh >"$test_root/disk-write-failure.log" 2>&1; then
  fail "disk cleanup continued after the exclusion write failed"
fi
[ -f "$by_date/C-keep.wav" ] || fail "failed exclusion write allowed a deletion"

# Restore the lightweight fixtures for the report path.
cat >"$extracted/scripts/common.php" <<'PHP'
<?php
function set_timezone() {
  date_default_timezone_set('Pacific/Auckland');
}
PHP

cat >"$extracted/weekly_report.php" <<'PHP'
<?php
if (empty($_GET['ascii'])) exit(2);
$instant = new DateTimeImmutable('2026-08-30 12:30:00', new DateTimeZone('UTC'));
if (date_default_timezone_get() !== 'Pacific/Auckland'
    || $instant->format('N') !== '7'
    || $instant->setTimezone(new DateTimeZone(date_default_timezone_get()))->format('N') !== '1') {
  exit(3);
}
echo "# Weekly title\nBody line\n";
PHP
cat >"$repo/birdnet/bin/apprise" <<EOF
#!/bin/sh
printf '%s\n' "\$@" >"$test_root/apprise.args"
EOF
chmod 0755 "$repo/birdnet/bin/apprise"
: >"$repo/apprise.txt"
rm -f "$test_root/curl.called"
HOME="$home" PATH="$test_bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  bash /source/scripts/weekly_report.sh \
  || fail "weekly report failed with the legacy HTTP route unavailable"
[ ! -e "$test_root/curl.called" ] || fail "weekly report called the protected HTTP route"
grep -Fxq ' Weekly title' "$test_root/apprise.args" \
  || fail "weekly report did not pass the generated title to Apprise"
grep -Fxq 'Body line' "$test_root/apprise.args" \
  || fail "weekly report did not pass the generated body to Apprise"

# An exit(0) database-busy style response is not a completed report.
cat >"$extracted/weekly_report.php" <<'PHP'
<?php echo "Database is busy"; exit(0);
PHP
rm -f "$test_root/apprise.args"
if HOME="$home" PATH="$test_bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  bash /source/scripts/weekly_report.sh >"$test_root/weekly-failure.log" 2>&1; then
  fail "weekly report accepted incomplete output"
fi
[ ! -e "$test_root/apprise.args" ] || fail "incomplete report reached Apprise"

echo "internal jobs smoke: ok"
