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
id avian-bundle >/dev/null 2>&1 \
  || useradd --system --user-group --home-dir /nonexistent \
    --shell /usr/sbin/nologin avian-bundle
install -d -o root -g root -m 0755 /var/empty /var/lib/avian-visitors
install -d -o root -g root -m 0555 /var/empty/avian-bundle
usermod -a -G "$station_user" caddy

mkdir -p \
  "$repo/.git" \
  "$repo/avian/assets/illustrations" \
  "$repo/avian/assets/references" \
  "$repo/avian/frontend" \
  "$repo/avian/scripts" \
  "$repo/scripts" \
  "$logs" \
  /etc/birdnet \
  /etc/sudoers.d \
  /usr/local/sbin
printf '{}\n' >"$repo/avian/frontend/dims.json"
printf '{}\n' >"$repo/avian/frontend/masks.json"
cp /source/avian/scripts/build_masks.py "$repo/avian/scripts/build_masks.py"
cp /source/avian/assets/illustrations/corvus-brachyrhynchos.png \
  "$repo/avian/assets/illustrations/corvus-brachyrhynchos.png"
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
install -o root -g root -m 0755 /source/scripts/generation_runtime_control.sh \
  /usr/local/sbin/avian-generation-runtime
install -o root -g root -m 0755 /source/avian/scripts/bundle_manager.py \
  /usr/local/sbin/avian-bundle-control
install -o root -g root -m 0755 /source/scripts/avian-bundle \
  /usr/local/bin/avian-bundle
install -d -o root -g root -m 0755 /usr/share/avian-visitors/bundles
install -o root -g root -m 0644 /source/avian/bundles/catalog-v1.json \
  /usr/share/avian-visitors/bundles/catalog-v1.json
/usr/local/sbin/avian-bundle-control initialize --json >/dev/null
install -o root -g root -m 0644 /dev/null \
  /var/lib/avian-visitors/bundles-v1.enabled

fpm_version=$(php -r 'printf("%d.%d", PHP_MAJOR_VERSION, PHP_MINOR_VERSION);')
bundle_fpm_socket=/run/php/avian-bundle-export-${fpm_version}.sock
mkdir -p /run/php
python3 -c 'import os, signal, socket, sys
path, uid, gid = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    os.unlink(path)
except FileNotFoundError:
    pass
s = socket.socket(socket.AF_UNIX)
s.bind(path)
os.chown(path, uid, gid)
os.chmod(path, 0o600)
s.listen()
signal.pause()' "$bundle_fpm_socket" "$(id -u caddy)" "$(id -g caddy)" &
fake_fpm_pid=$!
trap 'kill "$fake_fpm_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  [ -S "$bundle_fpm_socket" ] && break
  sleep 0.1
done
[ -S "$bundle_fpm_socket" ] || fail 'fake dedicated FPM socket did not start'
cat >/usr/bin/systemctl <<EOF
#!/bin/sh
case "\$*" in
  'is-active --quiet php${fpm_version}-fpm.service'|'reload php${fpm_version}-fpm.service') exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod 0755 /usr/bin/systemctl

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
[ "$(stat -c '%U:%G:%a:%h:%s' /var/lib/avian-visitors/included-art.revision)" \
  = "root:$station_user:660:1:65" ] \
  || fail "persistent illustration revision metadata is unsafe"
grep -Eq '^[0-9a-f]{64}$' /var/lib/avian-visitors/included-art.revision \
  || fail "persistent illustration revision was not committed after rebuild"
[ ! -s /run/lock/avian-generation.lock ] \
  || fail "the ephemeral mutex was mistaken for persistent revision state"
[ "$(stat -c '%U:%G:%a:%h' /etc/systemd/system/avian-generation-runtime.service)" \
  = root:root:644:1 ] \
  || fail "illustration boot recovery unit is unsafe"
grep -Fxq 'Requires=avian-generation-runtime.service' \
  /etc/systemd/system/caddy.service.d/20-avian-generation-runtime.conf \
  || fail "Caddy is not ordered after illustration boot recovery"
bundle_fpm_pool=/etc/php/${fpm_version}/fpm/pool.d/zz-avian-bundle-export.conf
[ "$(stat -c '%U:%G:%a:%h' "$bundle_fpm_pool")" = root:root:644:1 ] \
  || fail 'bundle FPM pool metadata is unsafe'
grep -Fxq 'pm.max_children = 2' "$bundle_fpm_pool" \
  || fail 'bundle FPM pool does not permit immediate busy responses'
grep -Fxq 'pm.max_requests = 1' "$bundle_fpm_pool" \
  || fail 'bundle FPM workers are not recycled'
grep -Fxq 'request_terminate_timeout = 3700s' "$bundle_fpm_pool" \
  || fail 'bundle FPM pool hard deadline is missing'
grep -Fxq 'request_terminate_timeout_track_finished = yes' "$bundle_fpm_pool" \
  || fail 'bundle FPM deadline does not cover response streaming'
case " $(id -G caddy) " in
  *" $(id -g "$station_user") "*) ;;
  *) fail 'security refresh did not restore Caddy station-group access' ;;
esac

# Simulate /run recreation across a normal reboot. tmpfiles recreates both
# fixed coordination inodes before the generation recovery unit runs.
valid_revision=$(cat /var/lib/avian-visitors/included-art.revision)
bundle_lock_policy=/etc/tmpfiles.d/avian-bundle-locks.conf
station_gid=$(id -g "$station_user")
[ "$(stat -c '%u:%g:%a:%h' -- "$bundle_lock_policy")" = '0:0:644:1' ] \
  || fail "bundle lock tmpfiles policy metadata is unsafe"
rm -f /run/lock/avian-generation.lock /run/lock/avian-bundle-export.lock
/usr/bin/systemd-tmpfiles --create "$bundle_lock_policy"
for coordination_lock in \
  /run/lock/avian-generation.lock /run/lock/avian-bundle-export.lock; do
  [ "$(stat -c '%u:%g:%a:%h' -- "$coordination_lock")" = \
    "0:$station_gid:660:1" ] \
    || fail "boot recreated coordination lock unsafely: $coordination_lock"
done
/usr/local/sbin/avian-generation-runtime >/tmp/avian-generation-valid-reboot.out
[ "$(cat /var/lib/avian-visitors/included-art.revision)" = "$valid_revision" ] \
  || fail "valid-state reboot unnecessarily changed the illustration revision"
[ "$(stat -c '%U:%G:%a:%h' /run/lock/avian-generation.lock)" \
  = "root:$station_user:660:1" ] \
  || fail "boot recovery recreated the illustration mutex unsafely"

# A power loss during mutation leaves the durable sentinel behind while /run
# disappears. Boot recovery must rebuild before Caddy and publish a new nonce.
printf 'invalid%057d\n' 0 | tr 0 '!' \
  >/var/lib/avian-visitors/included-art.revision
rm -f /run/lock/avian-generation.lock /run/lock/avian-bundle-export.lock
/usr/bin/systemd-tmpfiles --create "$bundle_lock_policy"
/usr/local/sbin/avian-generation-runtime >/tmp/avian-generation-invalid-reboot.out
grep -Eq '^[0-9a-f]{64}$' /var/lib/avian-visitors/included-art.revision \
  || fail "invalid-state reboot did not rebuild the illustration inventory"
[ "$(cat /var/lib/avian-visitors/included-art.revision)" != "$valid_revision" ] \
  || fail "invalid-state reboot reused the prior cache revision"
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
