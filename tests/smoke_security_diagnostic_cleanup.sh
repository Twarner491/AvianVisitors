#!/usr/bin/env bash
# Run as root in a disposable Debian container with the repository at /source
# and AVIAN_SECURITY_DIAGNOSTIC_TEST=1 set explicitly.
# Exercises the real security refresh, including legacy diagnostic migration.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f /.dockerenv ] \
  || fail "refusing security diagnostic smoke outside a disposable container"
[ "${AVIAN_SECURITY_DIAGNOSTIC_TEST:-0}" = 1 ] \
  || fail "refusing security diagnostic smoke without AVIAN_SECURITY_DIAGNOSTIC_TEST=1"

expect_failure() {
  local label=$1 expected=$2
  shift 2
  if "$@" >/tmp/avian-diagnostic-refresh-failure.out 2>&1; then
    fail "$label unexpectedly succeeded"
  fi
  grep -Fq "$expected" /tmp/avian-diagnostic-refresh-failure.out \
    || fail "$label returned the wrong error: $(cat /tmp/avian-diagnostic-refresh-failure.out)"
}

[ "${EUID:-$(id -u)}" -eq 0 ] || fail "test must run as root"
[ -r /source/scripts/security_refresh.sh ] || fail "repository is not mounted at /source"

station_user=aviandiag
station_home=/home/$station_user
repo=$station_home/BirdNET-Pi
conf=$repo/birdnet.conf
logs=$repo/logs

id caddy >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
id "$station_user" >/dev/null 2>&1 \
  || useradd --create-home --shell /bin/bash "$station_user"
usermod -a -G "$station_user" caddy

mkdir -p \
  "$repo/.git" \
  "$repo/avian/assets/illustrations" \
  "$repo/avian/assets/references" \
  "$repo/avian/frontend" \
  "$repo/scripts" \
  "$logs" \
  /etc/birdnet \
  /etc/sudoers.d \
  /usr/local/sbin
printf '{}\n' >"$repo/avian/frontend/dims.json"
printf '{}\n' >"$repo/avian/frontend/masks.json"
printf '##start\n##end\n' >"$repo/scripts/disk_check_exclude.txt"
cat >"$conf" <<EOF
BIRDNET_USER=$station_user
CADDY_PWD=
EOF
ln -sfn "$conf" /etc/birdnet/birdnet.conf

cat >/tmp/avian-diagnostic-noop <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 /tmp/avian-diagnostic-noop
for helper in \
  avian-admin-control \
  avian-archive-control \
  avian-maintenance-control \
  avian-update-control \
  avian-service-refresh \
  avian-caddy-refresh \
  avian-link-webroot \
  avian-educators; do
  install -o root -g root -m 0755 /tmp/avian-diagnostic-noop "/usr/local/sbin/$helper"
done

chown -hR "$station_user:$station_user" "$repo"
printf 'BIRDWEATHER_ID=firstrun-secret-token\n' >"$repo/scripts/firstrun.ini"
printf 'pre-patch-archive-secret\n' >"$repo/logs.tar.gz"
printf 'BIRDWEATHER_ID=staged-config-secret\n' >"$logs/birdnet.conf"
printf '+ BIRDWEATHER_ID=staged-journal-secret\n' >"$logs/service.log"
chmod 0644 "$repo/scripts/firstrun.ini" "$repo/logs.tar.gz" \
  "$logs/birdnet.conf" "$logs/service.log"

/source/scripts/security_refresh.sh >/tmp/avian-diagnostic-security-refresh.out
grep -Fxq 'security refresh: ok' /tmp/avian-diagnostic-security-refresh.out \
  || fail "security refresh did not report success"
[ ! -e "$repo/scripts/firstrun.ini" ] && [ ! -L "$repo/scripts/firstrun.ini" ] \
  || fail "obsolete first-run config survived the real refresh"
[ ! -e "$repo/logs.tar.gz" ] && [ ! -L "$repo/logs.tar.gz" ] \
  || fail "legacy diagnostic archive survived the real refresh"
[ ! -e "$logs/birdnet.conf" ] && [ ! -L "$logs/birdnet.conf" ] \
  || fail "legacy diagnostic config survived the real refresh"
[ "$(cat "$logs/service.log")" = '+ BIRDWEATHER_ID=staged-journal-secret' ] \
  || fail "neighboring legacy journal was changed"
[ "$(stat -c '%a' "$logs")" = 700 ] \
  || fail "legacy diagnostic directory was not quarantined"
if runuser -u caddy -- cat "$logs/service.log" >/dev/null 2>&1; then
  fail "Caddy can traverse quarantined legacy diagnostics"
fi

target=/tmp/avian-diagnostic-symlink-target
printf 'target-must-survive\n' >"$target"
ln -s "$target" "$repo/logs.tar.gz"
expect_failure "archive symlink" "Unsafe legacy diagnostic archive" \
  /source/scripts/security_refresh.sh
[ "$(cat "$target")" = target-must-survive ] || fail "archive symlink target changed"
rm -f -- "$repo/logs.tar.gz"

ln -s /tmp/avian-diagnostic-missing-target "$repo/logs.tar.gz"
expect_failure "broken archive symlink" "Unsafe legacy diagnostic archive" \
  /source/scripts/security_refresh.sh
rm -f -- "$repo/logs.tar.gz"

mkdir "$repo/logs.tar.gz"
expect_failure "archive directory" "Unsafe legacy diagnostic archive" \
  /source/scripts/security_refresh.sh
rmdir "$repo/logs.tar.gz"

mv "$logs" "$repo/logs.saved"
mkdir /tmp/avian-diagnostic-log-target
ln -s /tmp/avian-diagnostic-log-target "$logs"
expect_failure "logs symlink" "Unsafe legacy diagnostic directory" \
  /source/scripts/security_refresh.sh
rm -f -- "$logs"
mv "$repo/logs.saved" "$logs"

ln -s "$target" "$logs/birdnet.conf"
expect_failure "staged config symlink" "Unsafe legacy diagnostic config" \
  /source/scripts/security_refresh.sh
[ "$(cat "$target")" = target-must-survive ] || fail "staged config symlink target changed"
rm -f -- "$logs/birdnet.conf"

ln -s /tmp/avian-diagnostic-missing-target "$logs/birdnet.conf"
expect_failure "broken staged config symlink" "Unsafe legacy diagnostic config" \
  /source/scripts/security_refresh.sh
rm -f -- "$logs/birdnet.conf"

mkdir "$logs/birdnet.conf"
expect_failure "staged config directory" "Unsafe legacy diagnostic config" \
  /source/scripts/security_refresh.sh
rmdir "$logs/birdnet.conf"

[ "$(cat "$logs/service.log")" = '+ BIRDWEATHER_ID=staged-journal-secret' ] \
  || fail "refusal paths changed an unrelated legacy journal"
echo "security diagnostic cleanup smoke: ok"
