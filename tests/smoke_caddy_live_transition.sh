#!/usr/bin/env bash
# Run as root with real Caddy in a disposable Debian container.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  [ ! -f /tmp/avian-live-caddy.log ] || tail -n 80 /tmp/avian-live-caddy.log >&2
  exit 1
}

[ -f /.dockerenv ] \
  || fail "refusing live transition smoke outside a disposable container"
[ "${AVIAN_LIVE_TRANSITION_TEST:-0}" = 1 ] \
  || fail "refusing live transition smoke without AVIAN_LIVE_TRANSITION_TEST=1"
[ "${EUID:-$(id -u)}" -eq 0 ] || fail "test must run as root"
for command in caddy curl php systemd-analyze; do
  command -v "$command" >/dev/null || fail "$command is required"
done

test_root=$(mktemp -d)
site=$test_root/site
auth_dir=/var/lib/avian-visitors
admin=/usr/local/sbin/avian-admin-control
caddy_pid=''
toggle_pid=''
stream_backend_pid=''
listener_pid=''
unrelated_pid=''
rogue_icecast_pid=''
pgrep_path=''
pgrep_backup=''
cleanup() {
  [ -z "$rogue_icecast_pid" ] || kill "$rogue_icecast_pid" 2>/dev/null || true
  [ -z "$unrelated_pid" ] || kill "$unrelated_pid" 2>/dev/null || true
  [ -z "$listener_pid" ] || kill "$listener_pid" 2>/dev/null || true
  [ -z "$toggle_pid" ] || kill "$toggle_pid" 2>/dev/null || true
  [ -z "$stream_backend_pid" ] || kill "$stream_backend_pid" 2>/dev/null || true
  [ -z "$caddy_pid" ] || kill "$caddy_pid" 2>/dev/null || true
  wait 2>/dev/null || true
  if [ -n "$pgrep_backup" ] && [ -e "$pgrep_backup" ]; then
    mv -f -- "$pgrep_backup" "$pgrep_path"
  fi
  rm -rf "$test_root"
}
trap cleanup EXIT

id caddy >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
id icecast2 >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin icecast2
id bird >/dev/null 2>&1 || useradd --create-home --shell /bin/bash bird
mkdir -p "$site" /home/bird/BirdNET-Pi/.git /etc/birdnet /etc/caddy \
  /etc/default /etc/icecast2 "$auth_dir"
printf 'Etc/UTC\n' >/etc/timezone
ln -sfn /usr/share/zoneinfo/Etc/UTC /etc/localtime
cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=bird
EXTRACTED=$site
EOF
printf 'shell\n' >"$site/index.html"
install -o root -g root -m 0600 /dev/null "$auth_dir/admin-auth.lock"
legacy_hash='$2y$14$FJs8skDlFXw6UEyzPutTQuQBPcFdy0iyGDrL3silEC/X6CwX7aOhi'
printf 'v1\t0\t0\t%s\n' "$legacy_hash" >"$auth_dir/admin-auth.state"
chown root:caddy "$auth_dir/admin-auth.state"
chmod 0640 "$auth_dir/admin-auth.state"
printf 'v1\n' >"$auth_dir/admin-auth.initialized"
chmod 0400 "$auth_dir/admin-auth.initialized"

install -o root -g root -m 0755 /source/scripts/admin_control.sh "$admin"
install -o root -g root -m 0755 /source/scripts/update_caddyfile.sh \
  /usr/local/sbin/avian-caddy-refresh
cat >/etc/systemd/system/icecast2.service <<'EOF'
[Unit]
Description=Test Icecast service

[Service]
Type=oneshot
User=icecast2
ExecStart=/bin/true
RemainAfterExit=yes
EOF

cat >"$test_root/stream_backend.php" <<'PHP'
<?php
ignore_user_abort(false);
header('Content-Type: audio/mpeg');
for ($index = 0; $index < 1200 && !connection_aborted(); $index++) {
    echo "audio-frame\n";
    flush();
    usleep(50000);
}
PHP

cat >"$test_root/toggle_backend.php" <<'PHP'
<?php
$pipes = [];
$process = proc_open(
    ['/usr/local/sbin/avian-admin-control', 'lan-auth-set-stdin', '1'],
    [['pipe', 'r'], ['pipe', 'w'], ['pipe', 'w']],
    $pipes
);
if (!is_resource($process)) {
    http_response_code(500);
    exit;
}
fwrite($pipes[0], "legacy-safe\0");
fclose($pipes[0]);
$body = stream_get_contents($pipes[1]);
$error = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);
$status = proc_close($process);
http_response_code($status === 0 ? 200 : 500);
header('Content-Type: application/json');
header('Set-Cookie: rebound=1; Path=/; HttpOnly; SameSite=Strict');
echo $status === 0 ? $body : $error;
PHP

cat >/usr/local/sbin/avian-test-start-stream <<EOF
#!/bin/sh
# systemd does not pass the caller's auth-state lock into a restarted unit.
# Match that boundary in the fake service manager before forking the backend.
exec 9>&-
stream_host=127.0.0.1
[ ! -e /tmp/avian-stream-wildcard ] || stream_host=0.0.0.0
stream_port=8000
[ ! -s /tmp/avian-stream-port ] || stream_port=\$(cat /tmp/avian-stream-port)
php -d output_buffering=0 -S "\$stream_host:\$stream_port" "$test_root/stream_backend.php" \
  >/tmp/avian-stream-backend.log 2>&1 &
echo \$! >/tmp/avian-stream-backend.pid
for attempt in \$(seq 1 50); do
  : >/tmp/avian-stream-service-ready
  curl -sS --max-time 0.2 "http://127.0.0.1:\$stream_port/" \
    >/tmp/avian-stream-service-ready 2>/dev/null || true
  [ ! -s /tmp/avian-stream-service-ready ] || exit 0
  kill -0 \$! 2>/dev/null || exit 1
  sleep 0.1
done
exit 1
EOF
chmod 0755 /usr/local/sbin/avian-test-start-stream

cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
set -eu
icecast_state() {
  if [ -e /tmp/avian-icecast-uninstalled ]; then
    echo unknown
    return 4
  fi
  if [ -e /tmp/avian-icecast-activating ]; then
    echo activating
    return 3
  fi
  if [ -e /tmp/avian-icecast-disabled ] \
    || [ -e /tmp/avian-icecast-report-inactive ]; then
    echo inactive
    return 3
  fi
  if [ -s /tmp/avian-stream-backend.pid ] \
    && kill -0 "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null; then
    echo active
    return 0
  fi
  echo inactive
  return 3
}
case "$*" in
  'daemon-reload') exit 0 ;;
  'is-active --quiet caddy')
    [ -s /tmp/avian-live-caddy.pid ] \
      && kill -0 "$(cat /tmp/avian-live-caddy.pid)" 2>/dev/null
    ;;
  'reload caddy')
    if [ -e /tmp/avian-caddy-reload-fail-once ]; then
      rm -f /tmp/avian-caddy-reload-fail-once
      exit 1
    fi
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    ;;
  'start caddy') exit 0 ;;
  'is-active icecast2') icecast_state ;;
  'is-active --quiet icecast2')
    [ "$(icecast_state 2>/dev/null || true)" = active ]
    ;;
  'is-enabled icecast2') echo enabled ;;
  'cat icecast2')
    [ ! -e /tmp/avian-icecast-uninstalled ] || exit 1
    if [ -f /etc/systemd/system/icecast2.service ]; then
      cat /etc/systemd/system/icecast2.service
    else
      cat /run/systemd/generator.late/icecast2.service
    fi
    ;;
  'show -p MainPID --value icecast2')
    if [ -s /tmp/avian-stream-backend.pid ] \
      && kill -0 "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null; then
      cat /tmp/avian-stream-backend.pid
    else
      echo 0
    fi
    ;;
  'show -p ControlPID --value icecast2') echo 0 ;;
  'show -p ControlGroup --value icecast2') echo /avian-test-icecast2 ;;
  'stop icecast2')
    [ ! -e /tmp/avian-icecast-uninstalled ] || exit 4
    [ ! -e /tmp/avian-icecast-disabled ] || exit 0
    [ ! -e /tmp/avian-icecast-report-inactive ] || exit 0
    rm -f /tmp/avian-icecast-activating
    kill "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null || true
    ;;
  'kill --kill-who=all --signal=KILL icecast2')
    [ ! -e /tmp/avian-icecast-uninstalled ] || exit 4
    [ ! -e /tmp/avian-icecast-disabled ] || exit 0
    kill -KILL "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null || true
    ;;
  'start icecast2')
    if grep -Fxq \
      'ExecCondition=+/usr/local/sbin/avian-admin-control icecast-start-allowed' \
      /etc/systemd/system/icecast2.service.d/zz-avian-lan-auth.conf 2>/dev/null \
      && ! /usr/local/sbin/avian-admin-control icecast-start-allowed \
        >/tmp/avian-icecast-condition.out 2>&1; then
      exit 0
    fi
    [ "$(icecast_state 2>/dev/null || true)" != active ] || exit 0
    /usr/local/sbin/avian-test-start-stream
    ;;
  'restart icecast2')
    kill "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null || true
    "$0" start icecast2
    ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 /usr/bin/systemctl

cat >/etc/caddy/avian-site-overlay.caddy <<'EOF'
handle /toggle {
  reverse_proxy 127.0.0.1:9001
}
EOF
chown root:caddy /etc/caddy/avian-site-overlay.caddy
chmod 0640 /etc/caddy/avian-site-overlay.caddy

start_test_stream() {
  local port=8000
  [ ! -s /tmp/avian-stream-port ] || port=$(cat /tmp/avian-stream-port)
  /usr/local/sbin/avian-test-start-stream
  stream_backend_pid=$(cat /tmp/avian-stream-backend.pid)
  for _ in $(seq 1 50); do
    : >/tmp/avian-stream-ready.out
    curl -sS --max-time 0.2 "http://127.0.0.1:$port/" \
      >/tmp/avian-stream-ready.out 2>/dev/null || true
    [ -s /tmp/avian-stream-ready.out ] && return 0
    sleep 0.1
  done
  fail "stream backend did not start"
}

expect_backend_stopped() {
  local label=$1 port=${2:-8000}
  [ ! -s /tmp/avian-stream-backend.pid ] \
    || ! kill -0 "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null \
    || fail "$label left its backend running"
  if curl -sS --max-time 0.2 "http://127.0.0.1:$port/" >/dev/null 2>&1; then
    fail "$label left a direct listener on port $port"
  fi
}

stream_responds() {
  local port=$1 code
  : >/tmp/avian-stream-probe.out
  code=$(curl -sS --max-time 0.2 -o /tmp/avian-stream-probe.out \
    -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null || true)
  [ "$code" = 200 ] && [ -s /tmp/avian-stream-probe.out ]
}

write_test_auth_state() {
  local policy=$1 epoch=$2
  printf 'v1\t%s\t%s\t%s\n' "$policy" "$epoch" "$legacy_hash" \
    >"$auth_dir/admin-auth.state"
  chown root:caddy "$auth_dir/admin-auth.state"
  chmod 0640 "$auth_dir/admin-auth.state"
}

write_educator_state() {
  local enabled=$1 epoch=$2
  printf 'v1\t%s\t%s\n' "$enabled" "$epoch" >"$auth_dir/educators.state"
  chown root:caddy "$auth_dir/educators.state"
  chmod 0640 "$auth_dir/educators.state"
}

write_transition() {
  local phase=$1 restore=$2
  printf 'v2\t%s\t%s\n' "$phase" "$restore" \
    >"$auth_dir/icecast-start-blocked"
  chown root:root "$auth_dir/icecast-start-blocked"
  chmod 0400 "$auth_dir/icecast-start-blocked"
}

expect_transition() {
  local phase=$1 restore=$2 label=$3
  [ "$(stat -c '%U:%G:%a:%h' "$auth_dir/icecast-start-blocked")" = root:root:400:1 ] \
    || fail "$label installed unsafe transition state"
  [ "$(cat "$auth_dir/icecast-start-blocked")" = "v2"$'\t'"$phase"$'\t'"$restore" ] \
    || fail "$label recorded the wrong transition state"
}

exercise_guard() {
  local label=$1 port=${2:-8000}
  printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 1 \
    >"/tmp/avian-enable-$label.out" \
    || fail "$label could not enable protected mode"
  [ "$(cut -f2 "$auth_dir/admin-auth.state")" = 1 ] \
    || fail "$label did not commit protected policy"
  expect_backend_stopped "$label" "$port"
  [ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/stream)" = 404 ] \
    || fail "$label left the Caddy stream open"
  expect_transition blocked yes "$label"
  [ ! -e "$auth_dir/icecast-restore-on-unlock" ] \
    || fail "$label retained the superseded restore marker"
  if "$admin" icecast-start-allowed >/tmp/avian-condition-required.out 2>&1; then
    fail "$label allowed Icecast under protected policy"
  fi
  systemctl start icecast2 \
    || fail "$label simulated boot returned an unexpected systemd failure"
  expect_backend_stopped "$label reboot" "$port"
  printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
    >"/tmp/avian-disable-$label.out" \
    || fail "$label could not disable protected mode"
  [ ! -e "$auth_dir/icecast-start-blocked" ] \
    || fail "$label retained the transition state after unlock"
  [ ! -e "$auth_dir/icecast-restore-on-unlock" ] \
    || fail "$label retained the restore state after recovery"
  for _ in $(seq 1 50); do
    stream_responds "$port" && return 0
    sleep 0.1
  done
  fail "$label did not restore the previously active service"
}

start_test_stream
php -S 127.0.0.1:9001 "$test_root/toggle_backend.php" \
  >/tmp/avian-toggle-backend.log 2>&1 &
toggle_pid=$!
# First render sees inactive Caddy. The fake start accepts the validated file;
# the test then runs that exact generated file as a foreground Caddy process.
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-first-render.log 2>&1
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile \
  >/tmp/avian-live-caddy.log 2>&1 &
caddy_pid=$!
echo "$caddy_pid" >/tmp/avian-live-caddy.pid
for _ in $(seq 1 50); do
  if curl -fsS --max-time 1 http://127.0.0.1/ >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS http://127.0.0.1/ >/dev/null || fail "Caddy did not start"

# The permanent systemd condition is root-owned and delegates to the narrow
# policy check. It is installed even while policy is off so a later protected
# transition does not depend on Icecast's XML shape, selected config, or port.
guard=/etc/systemd/system/icecast2.service.d/zz-avian-lan-auth.conf
[ "$(stat -c '%U:%G:%a:%h' "$guard")" = root:root:644:1 ] \
  || fail "systemd guard metadata is unsafe"
grep -Fxq 'ExecCondition=+/usr/local/sbin/avian-admin-control icecast-start-allowed' "$guard" \
  || fail "systemd guard condition is missing"
SYSTEMD_UNIT_PATH=/etc/systemd/system:/usr/lib/systemd/system \
  systemd-analyze verify icecast2.service \
  || fail "systemd rejected the installed Icecast guard"
"$admin" icecast-start-allowed >/tmp/avian-condition-off.out \
  || fail "ordinary policy-off start check was rejected"

# If the fail-closed enable render cannot reload Caddy, the authoritative
# policy is still off. The admin transaction must immediately reconcile that
# state so its durable start block cannot silently strand live audio.
touch /tmp/avian-caddy-reload-fail-once
set +e
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 1 \
  >/tmp/avian-enable-reload-failure.out 2>&1
status=$?
set -e
[ "$status" -ne 0 ] || fail "failed enable reload was reported as success"
grep -Fq 'prior access policy and live audio state were restored and verified' \
  /tmp/avian-enable-reload-failure.out \
  || fail "failed enable reload did not report verified reconciliation"
[ "$(cut -f2 "$auth_dir/admin-auth.state")" = 0 ] \
  || fail "failed enable reload changed the authoritative policy"
[ ! -e "$auth_dir/icecast-start-blocked" ] \
  || fail "failed enable reload left the durable Icecast start block behind"
stream_responds 8000 \
  || fail "failed enable reload did not preserve the active backend"

# Verify and exercise the same drop-in against a stock SysV-generated unit.
# The native fixture above carries User=icecast2, so its successful simulated
# start also depends on the condition's explicit systemd '+' privilege prefix.
mv /etc/systemd/system/icecast2.service "$test_root/native-icecast2.service"
mkdir -p /run/systemd/generator.late
cat >/etc/init.d/icecast2 <<'EOF'
#!/bin/sh
case "${1:-}" in start|stop) exit 0 ;; *) exit 1 ;; esac
EOF
chmod 0755 /etc/init.d/icecast2
cat >/run/systemd/generator.late/icecast2.service <<'EOF'
# Automatically generated by systemd-sysv-generator
[Unit]
SourcePath=/etc/init.d/icecast2
Description=LSB: Icecast2

[Service]
Type=forking
RemainAfterExit=yes
ExecStart=/etc/init.d/icecast2 start
ExecStop=/etc/init.d/icecast2 stop
EOF
SYSTEMD_UNIT_PATH=/etc/systemd/system:/run/systemd/generator.late:/usr/lib/systemd/system \
  systemd-analyze verify icecast2.service \
  || fail "systemd rejected the Icecast guard on a SysV-generated unit"
exercise_guard sysv-generated
mv "$test_root/native-icecast2.service" /etc/systemd/system/icecast2.service
rm -f /run/systemd/generator.late/icecast2.service /etc/init.d/icecast2

# Stock wildcard defaults, multiple sockets, missing XML, malformed metadata,
# and both loopback families all follow the same service-level invariant. An
# active backend is stopped, later starts are skipped, and its prior active
# state is restored only after protection is disabled.
printf '%s\n' '<icecast><listen-socket><port>8000</port></listen-socket></icecast>' \
  >/etc/icecast2/icecast.xml
exercise_guard stock-default
printf '%s\n' \
  '<icecast><listen-socket><port>8000</port><bind-address>127.0.0.1</bind-address></listen-socket>' \
  '<listen-socket><port>8001</port><bind-address>0.0.0.0</bind-address></listen-socket></icecast>' \
  >/etc/icecast2/icecast.xml
exercise_guard multiple-sockets
rm -f /etc/icecast2/icecast.xml
exercise_guard missing-config
printf '%s\n' '<icecast><listen-socket>' >/etc/icecast2/icecast.xml
chmod 0666 /etc/icecast2/icecast.xml
exercise_guard malformed-unsafe-config
printf '%s\n' '<icecast><listen-socket><bind-address>127.0.0.1</bind-address></listen-socket></icecast>' \
  >/etc/icecast2/icecast.xml
chmod 0640 /etc/icecast2/icecast.xml
exercise_guard ipv4-loopback
printf '%s\n' '<icecast><listen-socket><bind-address>::1</bind-address></listen-socket></icecast>' \
  >/etc/icecast2/icecast.xml
exercise_guard ipv6-loopback

# A loopback-looking stock file cannot excuse a real public listener. Also use
# a supported alternate CONFIGFILE and port so this checks the service itself,
# not a hardcoded XML path or port 8000.
systemctl stop icecast2
printf 'unrelated-listener\n' >"$test_root/unrelated.txt"
php -S 127.0.0.1:8000 -t "$test_root" \
  >/tmp/avian-unrelated-backend.log 2>&1 &
unrelated_pid=$!
for _ in $(seq 1 50); do
  curl -fsS --max-time 0.2 http://127.0.0.1:8000/unrelated.txt \
    >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS http://127.0.0.1:8000/unrelated.txt >/dev/null \
  || fail "unrelated port 8000 listener did not start"
printf '8001\n' >/tmp/avian-stream-port
touch /tmp/avian-stream-wildcard
printf '%s\n' \
  '<icecast><listen-socket><port>8001</port><bind-address>0.0.0.0</bind-address></listen-socket></icecast>' \
  >"$test_root/alternate-icecast.xml"
printf 'CONFIGFILE=%s\n' "$test_root/alternate-icecast.xml" >/etc/default/icecast2
printf '%s\n' '<icecast><listen-socket><port>8000</port><bind-address>127.0.0.1</bind-address></listen-socket></icecast>' \
  >/etc/icecast2/icecast.xml
systemctl start icecast2
exercise_guard alternate-config 8001
kill -0 "$unrelated_pid" 2>/dev/null \
  || fail "Icecast cutoff killed an unrelated port 8000 listener"
curl -fsS http://127.0.0.1:8000/unrelated.txt >/dev/null \
  || fail "Icecast cutoff disrupted an unrelated port 8000 listener"
[ "$(systemctl is-enabled icecast2)" = enabled ] \
  || fail "guard changed the unit enable state"
systemctl stop icecast2
kill "$unrelated_pid"
wait "$unrelated_pid" 2>/dev/null || true
unrelated_pid=''
rm -f /tmp/avian-stream-port /tmp/avian-stream-wildcard /etc/default/icecast2
systemctl start icecast2
stream_backend_pid=$(cat /tmp/avian-stream-backend.pid)

# A closed, disabled, or uninstalled backend is already safe in required mode.
# The guard remains applicable even when the service unit is absent.
systemctl stop icecast2
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 1 >/tmp/avian-unavailable-enable.out
expect_backend_stopped "unavailable backend"
expect_transition blocked no "unavailable backend"
[ ! -e "$auth_dir/icecast-restore-on-unlock" ] \
  || fail "inactive backend was incorrectly marked for restore"
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-unavailable-refresh.out \
  || fail "closed backend poisoned a protected refresh"
for unavailable in disabled uninstalled; do
  touch "/tmp/avian-icecast-$unavailable"
  /usr/local/sbin/avian-caddy-refresh \
    >"/tmp/avian-$unavailable-refresh.out" \
    || fail "$unavailable backend poisoned a protected refresh"
  rm -f "/tmp/avian-icecast-$unavailable"
done

# Minimal supported images do not necessarily install procps. Verify the
# protected refresh with pgrep absent, then prove that the dependency-free
# /proc scan still detects a real process whose kernel name is icecast2.
pgrep_path=$(command -v pgrep || true)
if [ -n "$pgrep_path" ]; then
  pgrep_backup=$test_root/pgrep.saved
  mv -- "$pgrep_path" "$pgrep_backup"
fi
[ -z "$(command -v pgrep || true)" ] \
  || fail "pgrep remained available during the minimal-install check"
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-no-pgrep-refresh.out \
  || fail "protected refresh required pgrep"
cp /bin/sleep "$test_root/icecast2"
"$test_root/icecast2" 30 &
rogue_icecast_pid=$!
for _ in $(seq 1 50); do
  [ "$(cat "/proc/$rogue_icecast_pid/comm" 2>/dev/null || true)" = icecast2 ] \
    && break
  sleep 0.1
done
[ "$(cat "/proc/$rogue_icecast_pid/comm" 2>/dev/null || true)" = icecast2 ] \
  || fail "could not start the named Icecast process fixture"
set +e
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-named-process-refresh.out 2>&1
status=$?
set -e
[ "$status" = 20 ] \
  || fail "named Icecast process returned $status instead of cutoff status 20"
grep -Fq 'older live audio connection may remain' \
  /tmp/avian-named-process-refresh.out \
  || fail "named Icecast process failure lacked cutoff guidance"
kill "$rogue_icecast_pid"
wait "$rogue_icecast_pid" 2>/dev/null || true
rogue_icecast_pid=''
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-named-process-cleared.out \
  || fail "protected refresh did not recover after the named process exited"
if [ -n "$pgrep_backup" ]; then
  mv -- "$pgrep_backup" "$pgrep_path"
  pgrep_backup=''
fi
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 >/tmp/avian-unavailable-disable.out
[ ! -s /tmp/avian-stream-backend.pid ] \
  || ! kill -0 "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null \
  || fail "inactive backend was started during policy disable"
systemctl start icecast2
stream_backend_pid=$(cat /tmp/avian-stream-backend.pid)

# Migrate stations that already require a password but predate the durable
# transition record. Preserve active and activating intent, but do not revive
# a service that was inactive when the guard was introduced.
rm -f "$auth_dir/icecast-start-blocked" "$auth_dir/icecast-restore-on-unlock"
epoch=$(cut -f3 "$auth_dir/admin-auth.state")
write_test_auth_state 1 "$((epoch + 1))"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-migrate-active.out \
  || fail "already-required active migration failed"
expect_transition blocked yes "already-required active migration"
expect_backend_stopped "already-required active migration"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-migrate-active-repeat.out \
  || fail "already-required active reconciliation was not idempotent"
expect_transition blocked yes "already-required active repeat"
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
  >/tmp/avian-migrate-active-disable.out \
  || fail "active migration intent was not restorable"
stream_responds 8000 || fail "active migration did not restore Icecast"

systemctl stop icecast2
rm -f "$auth_dir/icecast-start-blocked"
epoch=$(cut -f3 "$auth_dir/admin-auth.state")
write_test_auth_state 1 "$((epoch + 1))"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-migrate-inactive.out \
  || fail "already-required inactive migration failed"
expect_transition blocked no "already-required inactive migration"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-migrate-inactive-repeat.out \
  || fail "already-required inactive reconciliation was not idempotent"
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
  >/tmp/avian-migrate-inactive-disable.out \
  || fail "inactive migration could not be unlocked"
expect_backend_stopped "inactive migration unlock"
systemctl start icecast2
stream_backend_pid=$(cat /tmp/avian-stream-backend.pid)

systemctl stop icecast2
touch /tmp/avian-icecast-activating
rm -f "$auth_dir/icecast-start-blocked"
epoch=$(cut -f3 "$auth_dir/admin-auth.state")
write_test_auth_state 1 "$((epoch + 1))"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-migrate-activating.out \
  || fail "already-required activating migration failed"
expect_transition blocked yes "already-required activating migration"
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
  >/tmp/avian-migrate-activating-disable.out \
  || fail "activating migration intent was not restorable"
stream_responds 8000 || fail "activating migration did not restore Icecast"

printf 'v1\n' >"$auth_dir/icecast-start-blocked"
printf 'v1\n' >"$auth_dir/icecast-restore-on-unlock"
chown root:root "$auth_dir/icecast-start-blocked" "$auth_dir/icecast-restore-on-unlock"
chmod 0400 "$auth_dir/icecast-start-blocked" "$auth_dir/icecast-restore-on-unlock"
epoch=$(cut -f3 "$auth_dir/admin-auth.state")
write_test_auth_state 1 "$((epoch + 1))"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-migrate-legacy-records.out \
  || fail "legacy transition record migration failed"
expect_transition blocked yes "legacy transition record migration"
[ ! -e "$auth_dir/icecast-restore-on-unlock" ] \
  || fail "legacy restore marker survived migration"
expect_backend_stopped "legacy transition record migration"
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
  >/tmp/avian-migrate-legacy-disable.out
stream_responds 8000 || fail "legacy restore intent was not preserved"

# Simulate interruption at every durable record phase. A retry must converge
# without changing the remembered pre-protection service intent.
write_transition blocked unknown
epoch=$(cut -f3 "$auth_dir/admin-auth.state")
write_test_auth_state 1 "$((epoch + 1))"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-reconcile-unknown-active.out \
  || fail "blocked unknown active reconciliation failed"
expect_transition blocked yes "blocked unknown active"
expect_backend_stopped "blocked unknown active"
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
  >/tmp/avian-reconcile-unknown-active-disable.out
stream_responds 8000 || fail "blocked unknown active lost active intent"

systemctl stop icecast2
write_transition blocked unknown
epoch=$(cut -f3 "$auth_dir/admin-auth.state")
write_test_auth_state 1 "$((epoch + 1))"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-reconcile-unknown-inactive.out \
  || fail "blocked unknown inactive reconciliation failed"
expect_transition blocked no "blocked unknown inactive"
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
  >/tmp/avian-reconcile-unknown-inactive-disable.out
expect_backend_stopped "blocked unknown inactive unlock"

write_transition blocked yes
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-reconcile-blocked-yes.out \
  || fail "blocked yes restore reconciliation failed"
[ ! -e "$auth_dir/icecast-start-blocked" ] \
  || fail "blocked yes restore reconciliation retained its record"
stream_responds 8000 || fail "blocked yes restore reconciliation did not start Icecast"
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-reconcile-blocked-yes-repeat.out \
  || fail "post-restore policy-off refresh was not idempotent"

systemctl stop icecast2
write_transition blocked no
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-reconcile-blocked-no.out \
  || fail "blocked no restore reconciliation failed"
[ ! -e "$auth_dir/icecast-start-blocked" ] \
  || fail "blocked no restore reconciliation retained its record"
expect_backend_stopped "blocked no restore reconciliation"

write_transition restoring yes
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-reconcile-restoring.out \
  || fail "restoring phase reconciliation failed"
[ ! -e "$auth_dir/icecast-start-blocked" ] \
  || fail "restoring phase reconciliation retained its record"
stream_responds 8000 || fail "restoring phase reconciliation did not start Icecast"

write_transition restoring yes
epoch=$(cut -f3 "$auth_dir/admin-auth.state")
write_test_auth_state 1 "$((epoch + 1))"
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-reconcile-restoring-required.out \
  || fail "required policy did not recover an interrupted restore"
expect_transition blocked yes "required interrupted restore"
expect_backend_stopped "required interrupted restore"
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 \
  >/tmp/avian-reconcile-restoring-required-disable.out
stream_responds 8000 || fail "required interrupted restore lost active intent"

# Ordinary policy-off refreshes preserve the current direct-LAN stream.
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-policy-off.out \
  || fail "ordinary policy-off refresh failed"
policy_off_code=$(curl -sS --max-time 0.5 -o /tmp/avian-policy-off-stream \
  -w '%{http_code}' http://127.0.0.1/stream 2>/dev/null || true)
[ "$policy_off_code" = 200 ] && [ -s /tmp/avian-policy-off-stream ] \
  || fail "policy-off refresh closed the direct-LAN stream"

# Client B opens the live microphone route before Client A enables policy.
: >/tmp/avian-stream-preflight.out
curl -sS --no-buffer --max-time 1 -D /tmp/avian-stream-preflight.headers \
  http://127.0.0.1/stream >/tmp/avian-stream-preflight.out \
  2>/tmp/avian-stream-preflight.err || true
[ -s /tmp/avian-stream-preflight.out ] || fail "stream preflight failed: $(tr '\n' ' ' </tmp/avian-stream-preflight.headers) $(cat /tmp/avian-stream-preflight.err)"
curl -sS --no-buffer --max-time 30 http://127.0.0.1/stream \
  >/tmp/avian-live-listener.out 2>/tmp/avian-live-listener.err &
listener_pid=$!
for _ in $(seq 1 50); do
  [ -s /tmp/avian-live-listener.out ] && break
  sleep 0.1
done
[ -s /tmp/avian-live-listener.out ] || fail "live listener did not receive audio"

code=$(curl -sS --max-time 20 -D /tmp/avian-toggle-headers \
  -o /tmp/avian-toggle-body -w '%{http_code}' http://127.0.0.1/toggle)
[ "$code" = 200 ] || fail "initiating request returned $code"
grep -Eiq '^Set-Cookie:[[:space:]]*rebound=1' /tmp/avian-toggle-headers \
  || fail "initiating request lost its rebound cookie"
grep -Fq '"lan_auth":1' /tmp/avian-toggle-body \
  || fail "root policy transition did not finish"

ended=0
for _ in $(seq 1 50); do
  if ! kill -0 "$listener_pid" 2>/dev/null; then ended=1; break; fi
  sleep 0.1
done
[ "$ended" = 1 ] || fail "existing live listener did not reach EOF"
wait "$listener_pid" 2>/dev/null || true
listener_pid=''
[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/stream)" = 404 ] \
  || fail "new live audio request was not closed"
[ "$(cut -f2 "$auth_dir/admin-auth.state")" = 1 ] \
  || fail "authoritative policy was not committed"
[ "$(stat -c '%U:%G:%a:%h' /etc/caddy/Caddyfile)" = root:caddy:640:1 ] \
  || fail "generated Caddyfile metadata is unsafe"

# A failed or inactive unit can still retain a backend process in its cgroup.
# The cutoff must send the kill even when is-active reports false.
printf 'legacy-safe\0' | "$admin" lan-auth-set-stdin 0 >/tmp/avian-disable-body
stream_backend_pid=$(cat /tmp/avian-stream-backend.pid)
curl -sS --no-buffer --max-time 30 http://127.0.0.1/stream \
  >/tmp/avian-inactive-listener.out 2>/tmp/avian-inactive-listener.err &
listener_pid=$!
for _ in $(seq 1 50); do
  [ -s /tmp/avian-inactive-listener.out ] && break
  sleep 0.1
done
[ -s /tmp/avian-inactive-listener.out ] \
  || fail "inactive-unit listener did not receive audio"
touch /tmp/avian-icecast-report-inactive
code=$(curl -sS --max-time 20 -D /tmp/avian-inactive-toggle-headers \
  -o /tmp/avian-inactive-toggle-body -w '%{http_code}' http://127.0.0.1/toggle)
[ "$code" = 200 ] || fail "inactive-unit transition returned $code"
ended=0
for _ in $(seq 1 50); do
  if ! kill -0 "$listener_pid" 2>/dev/null; then ended=1; break; fi
  sleep 0.1
done
[ "$ended" = 1 ] || fail "inactive-unit live listener did not reach EOF"
wait "$listener_pid" 2>/dev/null || true
listener_pid=''
[ ! -s /tmp/avian-stream-backend.pid ] \
  || ! kill -0 "$(cat /tmp/avian-stream-backend.pid)" 2>/dev/null \
  || fail "inactive Icecast cgroup process survived the cutoff"
[ "$(cut -f2 "$auth_dir/admin-auth.state")" = 1 ] \
  || fail "inactive-unit policy transition was not committed"

# Educators mode keeps the Icecast source loopback-only while Caddy continues
# to return 404 from the historical /stream route. A credential transition
# recycles that backend so every existing authenticated proxy reaches EOF.
rm -f /tmp/avian-icecast-report-inactive
write_educator_state 1 1
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-educator-enable-refresh.out \
  || fail "Educators protected refresh failed"
systemctl start icecast2 || fail "Educators profile could not start loopback Icecast"
stream_responds 8000 || fail "Educators profile did not keep loopback Icecast available"
"$admin" icecast-start-allowed >/tmp/avian-educator-condition.out \
  || fail "systemd guard rejected enabled Educators mode"
[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/stream)" = 404 ] \
  || fail "Educators profile reopened the historical Caddy stream"
old_backend_pid=$(cat /tmp/avian-stream-backend.pid)
AVIAN_CLOSE_STREAMS=1 /usr/local/sbin/avian-caddy-refresh \
  >/tmp/avian-educator-recycle.out \
  || fail "Educators protected stream recycle failed"
new_backend_pid=$(cat /tmp/avian-stream-backend.pid)
[ "$old_backend_pid" != "$new_backend_pid" ] \
  || fail "Educators credential transition did not recycle Icecast"
kill -0 "$new_backend_pid" 2>/dev/null \
  || fail "Educators credential transition did not restore Icecast"
[ ! -e "$auth_dir/icecast-start-blocked" ] \
  || fail "Educators recycle retained the transition block"
[ "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/stream)" = 404 ] \
  || fail "Educators recycle changed /stream behavior"

# Publishing disabled state is the revocation point. The next canonical Caddy
# refresh closes the backend and leaves systemd blocked without erasing data.
write_educator_state 0 2
/usr/local/sbin/avian-caddy-refresh >/tmp/avian-educator-disable-refresh.out \
  || fail "Educators disable refresh failed"
expect_backend_stopped "Educators disable"
expect_transition blocked yes "Educators disable"
if "$admin" icecast-start-allowed >/tmp/avian-educator-disabled-condition.out 2>&1; then
  fail "systemd guard allowed disabled Educators mode under LAN protection"
fi

echo "Caddy live transition smoke: ok"
