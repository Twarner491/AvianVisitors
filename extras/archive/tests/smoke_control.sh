#!/usr/bin/env bash
# Run inside a disposable Debian container with the repository mounted at
# /source. Exercises the privileged helper without a real Pi, timer, or Drive.

set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

useradd -m bird
mkdir -p /etc/birdnet /home/bird/BirdNET-Pi/extras
cp -R /source/extras/archive /home/bird/BirdNET-Pi/extras/archive
cat >/etc/birdnet/birdnet.conf <<'EOF'
BIRDNET_USER=bird
EOF
cat >/home/bird/BirdNET-Pi/birdnet.conf <<'EOF'
MAX_FILES_SPECIES=99999
FULL_DISK=keep
EOF
chown -R bird:bird /home/bird/BirdNET-Pi

# Fixed stubs are enough to verify action routing and state transitions. The
# archive worker's rclone/sqlite behavior has its own end-to-end smoke matrix.
cat >/usr/local/bin/rclone <<'EOF'
#!/bin/sh
exit 0
EOF
cat >/usr/local/bin/sqlite3 <<'EOF'
#!/bin/sh
exit 0
EOF
cat >/usr/local/bin/systemctl <<'EOF'
#!/bin/sh
state=/run/archive-test
mkdir -p "$state"
case "$1" in
  is-enabled) cat "$state/enabled" 2>/dev/null || echo disabled ;;
  is-active)
    case "$2" in
      bird-archive.timer) cat "$state/timer-active" 2>/dev/null || echo inactive ;;
      bird-archive.service) cat "$state/service-active" 2>/dev/null || echo inactive ;;
      *) echo inactive ;;
    esac
    ;;
  show) echo 'Tue 2026-08-04 03:15:00 PDT' ;;
  daemon-reload) exit 0 ;;
  enable)
    echo 'Created symlink /etc/systemd/system/timers.target.wants/bird-archive.timer.' >&2
    echo enabled >"$state/enabled"
    echo active >"$state/timer-active"
    ;;
  disable)
    echo 'Removed /etc/systemd/system/timers.target.wants/bird-archive.timer.' >&2
    echo disabled >"$state/enabled"
    echo inactive >"$state/timer-active"
    ;;
  --no-block)
    [ "$2" = start ] || exit 2
    echo activating >"$state/service-active"
    ;;
  *) exit 2 ;;
esac
EOF
chmod 0755 /usr/local/bin/rclone /usr/local/bin/sqlite3 /usr/local/bin/systemctl

control=/source/scripts/archive_control.sh

outside_dir=/tmp/archive-outside
mkdir -p "$outside_dir"
ln -s "$outside_dir" /home/bird/bird-archive
if $control install >/dev/null 2>&1; then fail "archive directory symlink accepted"; fi
[ -z "$(find "$outside_dir" -mindepth 1 -print -quit)" ] \
  || fail "archive directory symlink wrote outside the station home"
rm /home/bird/bird-archive

install_json=$($control install)
grep -q '"installed":true' <<<"$install_json" || fail "install state"
grep -q '^User=bird$' /etc/systemd/system/bird-archive.service || fail "unit user"
grep -q '^NoNewPrivileges=true$' /etc/systemd/system/bird-archive.service || fail "unit hardening"
systemd-analyze verify /etc/systemd/system/bird-archive.service \
  /etc/systemd/system/bird-archive.timer
[ "$(stat -c '%U:%G:%a' /home/bird/bird-archive/archive_to_drive.sh)" = 'root:root:755' ] \
  || fail "worker ownership"

cp /home/bird/bird-archive/archive.conf /tmp/archive.conf.saved
printf 'outside sentinel\n' >/tmp/outside-conf
outside_before=$(stat -c '%U:%G:%a:%s' /tmp/outside-conf)
rm /home/bird/bird-archive/archive.conf
ln -s /tmp/outside-conf /home/bird/bird-archive/archive.conf
if $control install >/dev/null 2>&1; then fail "archive config symlink accepted"; fi
[ "$(stat -c '%U:%G:%a:%s' /tmp/outside-conf)" = "$outside_before" ] \
  || fail "archive config symlink changed outside metadata"
grep -qx 'outside sentinel' /tmp/outside-conf \
  || fail "archive config symlink changed outside contents"
rm /home/bird/bird-archive/archive.conf
mv /tmp/archive.conf.saved /home/bird/bird-archive/archive.conf
chown bird:bird /home/bird/bird-archive/archive.conf
chmod 0600 /home/bird/bird-archive/archive.conf

mv /home/bird/bird-archive/archive.conf /tmp/archive-hardlink-conf
chown bird:bird /tmp/archive-hardlink-conf
chmod 0600 /tmp/archive-hardlink-conf
ln /tmp/archive-hardlink-conf /home/bird/bird-archive/archive.conf
if $control install >/dev/null 2>&1; then fail "archive config hard link accepted"; fi
[ "$(stat -c %h /tmp/archive-hardlink-conf)" -eq 2 ] \
  || fail "archive config hard-link test changed unexpectedly"
rm /home/bird/bird-archive/archive.conf
mv /tmp/archive-hardlink-conf /home/bird/bird-archive/archive.conf
config_before=$(sha256sum /home/bird/bird-archive/archive.conf | awk '{print $1}')
repeat_json=$($control install)
grep -q '"installed":true' <<<"$repeat_json" || fail "repeat install state"
[ "$(sha256sum /home/bird/bird-archive/archive.conf | awk '{print $1}')" = "$config_before" ] \
  || fail "repeat install changed archive config"
[ "$(stat -c '%U:%G:%a' /home/bird/bird-archive/archive.conf)" = 'bird:bird:600' ] \
  || fail "repeat install changed archive config metadata"

# The station owns its home directory, so it can rename the archive directory
# while the root helper is running. Root writes must stay anchored to the
# directory descriptor that was opened before the rename, never follow the
# replacement symlink into another location.
race_outside=/tmp/archive-race-outside
race_stop=/tmp/archive-race-stop
mkdir -p "$race_outside"
rm -f "$race_stop"
runuser -u bird -- sh -c '
  home=/home/bird
  while [ ! -e /tmp/archive-race-stop ]; do
    if [ -d "$home/bird-archive" ] && [ ! -L "$home/bird-archive" ] \
        && [ ! -e "$home/bird-archive.real" ]; then
      mv -T "$home/bird-archive" "$home/bird-archive.real" 2>/dev/null || true
    fi
    if [ -d "$home/bird-archive.real" ] && [ ! -e "$home/bird-archive" ]; then
      ln -s /tmp/archive-race-outside "$home/bird-archive" 2>/dev/null || true
    fi
    [ ! -L "$home/bird-archive" ] || rm -f "$home/bird-archive"
    if [ -d "$home/bird-archive.real" ] && [ ! -e "$home/bird-archive" ]; then
      mv -T "$home/bird-archive.real" "$home/bird-archive" 2>/dev/null || true
    fi
  done
' &
race_pid=$!
for _attempt in $(seq 1 200); do
  $control install >/dev/null 2>&1 || true
done
touch "$race_stop"
wait "$race_pid"
if [ -L /home/bird/bird-archive ]; then
  rm -f /home/bird/bird-archive
fi
if [ -d /home/bird/bird-archive.real ]; then
  if [ -d /home/bird/bird-archive ]; then
    unexpected=$(find /home/bird/bird-archive.real -mindepth 1 -maxdepth 1 \
      ! -name archive_to_drive.sh ! -name archive.conf ! -name status -print -quit)
    [ -z "$unexpected" ] \
      || fail "archive race left unexpected station file: $unexpected"
    rm -f /home/bird/bird-archive.real/archive_to_drive.sh \
      /home/bird/bird-archive.real/archive.conf \
      /home/bird/bird-archive.real/status
    rmdir /home/bird/bird-archive.real
  else
    mv /home/bird/bird-archive.real /home/bird/bird-archive
  fi
fi
[ -d /home/bird/bird-archive ] || fail "archive race did not restore directory"
[ -z "$(find "$race_outside" -mindepth 1 -print -quit)" ] \
  || fail "archive directory race wrote outside the station home"

mkdir -p /home/bird/.config/rclone
cat >/home/bird/.config/rclone/rclone.conf <<'EOF'
[gdrive]
type = drive
EOF
chown -R bird:bird /home/bird/.config

partial_json=$($control status)
grep -q '"configured":false' <<<"$partial_json" || fail "partial remote accepted"
if $control enable >/dev/null 2>&1; then fail "partial remote enabled timer"; fi

cat >/home/bird/.config/rclone/rclone.conf <<'EOF'
[gdrive]
type = s3
token = {"refresh_token":"wrong-backend-secret"}
EOF
wrong_backend_json=$($control status)
grep -q '"configured":false' <<<"$wrong_backend_json" || fail "wrong backend accepted"

cat >/home/bird/.config/rclone/rclone.conf <<'EOF'
[gdrive]
type = drive
token = {"access_token":"short-lived-secret","token_type":"Bearer","refresh_token":"private-refresh-secret","expiry":"2099-01-01T00:00:00Z"}
EOF

# An older build could leave cleanup on while its timer was off. Enabling the
# schedule must migrate that hidden state back to copy-only.
sed -i 's/^PURGE=false$/PURGE=true/' /home/bird/bird-archive/archive.conf
enabled_json=$($control enable 2>&1)
grep -q '"enabled":"enabled"' <<<"$enabled_json" || fail "timer enable"
grep -q '"purge":false' <<<"$enabled_json" || fail "timer enable retained hidden cleanup"
grep -q '^PURGE=false$' /home/bird/bird-archive/archive.conf || fail "timer enable did not reset cleanup"
[ "$(wc -l <<<"$enabled_json")" -eq 1 ] || fail "systemctl output contaminated enable JSON"
grep -q 'private-refresh-secret' <<<"$enabled_json" && fail "refresh token leaked"
grep -q 'short-lived-secret' <<<"$enabled_json" && fail "access token leaked"

if $control purge-on >/dev/null 2>&1; then fail "cleanup unlocked before a safe run"; fi
echo 'OK 2026-08-04T03:20:00-07:00 verified_files=0' >/home/bird/bird-archive/status
chown bird:bird /home/bird/bird-archive/status
if $control purge-on >/dev/null 2>&1; then fail "empty run unlocked cleanup"; fi
echo 'OK 2026-08-04T03:20:00-07:00 verified_files=3' >/home/bird/bird-archive/status
chown bird:bird /home/bird/bird-archive/status
purge_json=$($control purge-on)
grep -q '"purge":true' <<<"$purge_json" || fail "cleanup opt-in"
grep -q '^PURGE=true$' /home/bird/bird-archive/archive.conf || fail "cleanup config"

disabled_json=$($control disable 2>&1)
grep -q '"enabled":"disabled"' <<<"$disabled_json" || fail "timer disable"
grep -q '"purge":false' <<<"$disabled_json" || fail "timer disable did not clear cleanup"
grep -q '^PURGE=false$' /home/bird/bird-archive/archive.conf || fail "cleanup remained enabled after timer disable"
[ "$(wc -l <<<"$disabled_json")" -eq 1 ] || fail "systemctl output contaminated disable JSON"
if $control purge-on >/dev/null 2>&1; then fail "cleanup enabled while nightly archive was off"; fi
if $control unknown >/dev/null 2>&1; then fail "unknown action accepted"; fi

echo 'archive control smoke: ok'
