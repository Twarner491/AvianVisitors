#!/usr/bin/env bash
# Run as root in a disposable Debian container with the repository at /source
# and AVIAN_CADDY_OVERLAY_TEST=1 set explicitly.

set -euo pipefail
IFS=$'\n\t'

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f /.dockerenv ] \
  || fail "refusing Caddy overlay smoke outside a disposable container"
[ "${AVIAN_CADDY_OVERLAY_TEST:-0}" = 1 ] \
  || fail "refusing Caddy overlay smoke without AVIAN_CADDY_OVERLAY_TEST=1"
[ "$(id -u)" -eq 0 ] || fail "test must run as root"
test_root=/tmp/avian-caddy-overlay-smoke
overlay=/etc/caddy/avian-site-overlay.caddy
generator=/source/scripts/update_caddyfile.sh
auth_dir=/var/lib/avian-visitors
mkdir -p "$test_root" /etc/birdnet /etc/caddy /srv/avian \
  /usr/sbin "$auth_dir"
id caddy >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
id bird >/dev/null 2>&1 || useradd --create-home --shell /bin/bash bird
install -o root -g root -m 0600 /dev/null "$auth_dir/admin-auth.lock"
cat >/etc/birdnet/birdnet.conf <<'EOF'
BIRDNET_USER=bird
EXTRACTED=/srv/avian
EOF
install -o root -g root -m 0755 /source/scripts/admin_control.sh \
  /usr/local/sbin/avian-admin-control

legacy_hash='$2y$14$FJs8skDlFXw6UEyzPutTQuQBPcFdy0iyGDrL3silEC/X6CwX7aOhi'
write_state() {
  printf 'v1\t%s\t%s\t%s\n' "$1" "$2" "$3" >"$auth_dir/admin-auth.state"
  chown root:caddy "$auth_dir/admin-auth.state"
  chmod 0640 "$auth_dir/admin-auth.state"
}

cat >/usr/sbin/caddy <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
test_root=/tmp/avian-caddy-overlay-smoke
case "${1:-}" in
  fmt)
    printf 'fmt\n' >>"$test_root/order.log"
    if [ -e "$test_root/pause-fmt" ]; then
      : >"$test_root/fmt-paused"
      while [ ! -e "$test_root/release-fmt" ]; do sleep 0.05; done
    fi
    ;;
  validate)
    printf 'validate\n' >>"$test_root/order.log"
    [ ! -e "$test_root/fail-validate" ]
    ;;
  *) exit 1 ;;
esac
EOF

cat >/usr/sbin/systemctl <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root=/tmp/avian-caddy-overlay-smoke
printf 'systemctl %s\n' "$*" >>"$root/order.log"
case "$*" in
  'daemon-reload') : ;;
  'is-active --quiet caddy') [ ! -e "$root/caddy-inactive" ] ;;
  'is-active --quiet icecast2') [ -e "$root/icecast-active" ] ;;
  'is-active icecast2')
    if [ -e "$root/icecast-active" ]; then printf 'active\n'; else printf 'inactive\n'; exit 3; fi
    ;;
  'cat icecast2') printf '[Service]\nExecStart=/usr/bin/icecast2\n' ;;
  'show -p MainPID --value icecast2')
    if [ -e "$root/icecast-active" ]; then printf '1\n'; else printf '0\n'; fi
    ;;
  'show -p ControlPID --value icecast2') printf '0\n' ;;
  'show -p ControlGroup --value icecast2') printf '/avian-test-icecast2\n' ;;
  'is-enabled icecast2') printf 'enabled\n' ;;
  'reload caddy') [ ! -e "$root/fail-caddy-reload" ] ;;
  'start caddy') [ ! -e "$root/fail-caddy-start" ] ;;
  'stop icecast2')
    [ ! -e "$root/fail-icecast-stop" ] || exit 1
    rm -f "$root/icecast-active"
    ;;
  'kill --kill-who=all --signal=KILL icecast2')
    [ ! -e "$root/fail-icecast-kill" ] || exit 1
    rm -f "$root/icecast-active"
    ;;
  'start icecast2')
    [ ! -e "$root/fail-icecast-start" ] || exit 1
    touch "$root/icecast-active"
    ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 /usr/sbin/caddy /usr/sbin/systemctl

reset_logs() {
  : >"$test_root/order.log"
  rm -f "$test_root"/fail-* "$test_root/caddy-inactive" \
    "$test_root/icecast-active" "$test_root/pause-fmt" \
    "$test_root/fmt-paused" "$test_root/release-fmt"
}

first_stream_route_instruction() {
  awk '
    /handle @stream/ { stream=1; next }
    stream && /route[[:space:]]*{/ { route=1; next }
    route && NF { sub(/^[[:space:]]*/, ""); print; exit }
  ' /etc/caddy/Caddyfile
}

write_original() { printf 'original caddy config\n' >/etc/caddy/Caddyfile; }

remove_overlay() {
  if [ -d "$overlay" ] && [ ! -L "$overlay" ]; then
    rmdir "$overlay"
  elif [ -e "$overlay" ] || [ -L "$overlay" ]; then
    rm -f "$overlay"
  fi
}

expect_overlay_refusal() {
  local label=$1
  reset_logs
  write_original
  if bash "$generator" >"$test_root/$label.log" 2>&1; then
    fail "$label overlay was accepted"
  fi
  [ "$(cat /etc/caddy/Caddyfile)" = 'original caddy config' ] \
    || fail "$label replaced the active Caddyfile"
  [ ! -s "$test_root/order.log" ] || fail "$label reached Caddy validation"
  grep -Fq 'Refusing unsafe Caddy site overlay' "$test_root/$label.log" \
    || fail "$label did not report an explicit refusal"
  remove_overlay
}

# Trusted mode uses no Basic gate and leaves direct live audio available.
remove_overlay
write_state 0 0 -
reset_logs
write_original
bash "$generator"
grep -Fq 'handle @directLegacyAdmin' /etc/caddy/Caddyfile \
  || fail "trusted mode lost direct legacy pages"
[ "$(first_stream_route_instruction)" != 'respond 404' ] \
  || fail "trusted mode closed live audio"
grep -Fxq 'systemctl reload caddy' "$test_root/order.log" \
  || fail "active Caddy was not reloaded"
! grep -Fq 'systemctl restart caddy' "$test_root/order.log" \
  || fail "generator synchronously restarted active Caddy"
[ "$(stat -c '%U:%G:%a:%h' /etc/systemd/system/icecast2.service.d/zz-avian-lan-auth.conf)" = root:root:644:1 ] \
  || fail "systemd live audio guard metadata is unsafe"
grep -Fxq 'ExecCondition=+/usr/local/sbin/avian-admin-control icecast-start-allowed' \
  /etc/systemd/system/icecast2.service.d/zz-avian-lan-auth.conf \
  || fail "systemd live audio guard condition is missing"

# Compatibility mode takes the bcrypt verifier only from root-owned state.
write_state 0 1 "$legacy_hash"
reset_logs
bash "$generator"
grep -Fq "birdnet $legacy_hash" /etc/caddy/Caddyfile \
  || fail "compatibility mode did not use the state verifier"
[ "$(stat -c '%U:%G:%a:%h' /etc/caddy/Caddyfile)" = root:caddy:640:1 ] \
  || fail "generated Caddyfile exposed its verifier"

# Required mode closes the legacy surface and places the stream rejection at
# the first instruction in the stream route.
write_state 1 2 "$legacy_hash"
reset_logs
bash "$generator"
grep -A2 -F 'handle @legacySurface' /etc/caddy/Caddyfile | grep -Fq 'respond 404' \
  || fail "required mode did not close legacy routes"
[ "$(first_stream_route_instruction)" = 'respond 404' ] \
  || fail "required mode did not close live audio"

# Missing or malformed state installs a hard-closed candidate and reports
# recovery failure instead of retaining an older permissive file.
rm -f "$auth_dir/admin-auth.state"
reset_logs
if bash "$generator" >"$test_root/missing-state.log" 2>&1; then
  fail "missing state was reported as success"
fi
[ "$(first_stream_route_instruction)" = 'respond 404' ] \
  || fail "missing state retained an open stream route"
! grep -Fq 'handle @directLegacyAdmin' /etc/caddy/Caddyfile \
  || fail "missing state retained direct legacy access"
write_state 1 3 "$legacy_hash"
chmod 0644 "$auth_dir/admin-auth.state"
reset_logs
if bash "$generator" >"$test_root/unsafe-state.log" 2>&1; then
  fail "unsafe state metadata was reported as success"
fi
[ "$(first_stream_route_instruction)" = 'respond 404' ] \
  || fail "unsafe state metadata reopened the stream"
write_state 1 4 "$legacy_hash"

# Inactive Caddy is started; active Caddy is never restarted.
reset_logs
touch "$test_root/caddy-inactive"
bash "$generator"
grep -Fxq 'systemctl start caddy' "$test_root/order.log" \
  || fail "inactive Caddy was not started"

# Required policy terminates established Icecast listeners and leaves the
# service stopped behind the permanent systemd condition.
reset_logs
touch "$test_root/icecast-active"
AVIAN_CLOSE_STREAMS=1 bash "$generator"
grep -Fxq 'systemctl stop icecast2' "$test_root/order.log" \
  || fail "active Icecast was not stopped"
! grep -Eq 'systemctl (start|restart|enable|disable) icecast2' "$test_root/order.log" \
  || fail "protected cutoff changed or started the Icecast unit"

# A failed restore reports status 21, retains its root-only transition record, and
# never alters whether the service is enabled at boot.
write_state 0 3 "$legacy_hash"
printf 'v1\n' >"$auth_dir/icecast-restore-on-unlock"
chown root:root "$auth_dir/icecast-restore-on-unlock"
chmod 0400 "$auth_dir/icecast-restore-on-unlock"
reset_logs
touch "$test_root/fail-icecast-start"
set +e
bash "$generator" >"$test_root/start-failure.log" 2>&1
status=$?
set -e
[ "$status" = 21 ] || fail "Icecast start failure returned $status instead of 21"
[ "$(cat "$auth_dir/icecast-start-blocked")" = "v2"$'\t'"restoring"$'\t'"yes" ] \
  || fail "Icecast start failure discarded restore intent"
[ ! -e "$auth_dir/icecast-restore-on-unlock" ] \
  || fail "Icecast start failure retained a superseded legacy marker"
! grep -Eq 'systemctl (enable|disable) icecast2' "$test_root/order.log" \
  || fail "Icecast restore changed the unit enable state"
rm -f "$auth_dir/icecast-start-blocked"

write_state 1 4 "$legacy_hash"
reset_logs
touch "$test_root/icecast-active" "$test_root/fail-icecast-stop" \
  "$test_root/fail-icecast-kill"
set +e
AVIAN_CLOSE_STREAMS=1 bash "$generator" >"$test_root/stop-failure.log" 2>&1
status=$?
set -e
[ "$status" = 20 ] || fail "uncertain cutoff returned $status instead of 20"
grep -Fq 'older live audio connection may remain' "$test_root/stop-failure.log" \
  || fail "uncertain cutoff did not report recovery guidance"

# A reload failure restores the prior protected file and never synchronously
# restarts Caddy from the request path.
write_state 1 5 "$legacy_hash"
reset_logs
bash "$generator"
protected_hash=$(sha256sum /etc/caddy/Caddyfile)
write_state 0 6 "$legacy_hash"
reset_logs
touch "$test_root/fail-caddy-reload"
if bash "$generator" >"$test_root/reload-failure.log" 2>&1; then
  fail "failed Caddy reload was reported as success"
fi
[ "$(sha256sum /etc/caddy/Caddyfile)" = "$protected_hash" ] \
  || fail "failed reload did not restore the protected Caddyfile"
! grep -Fq 'systemctl restart caddy' "$test_root/order.log" \
  || fail "reload failure synchronously restarted Caddy"

# A valid overlay is imported by pathname and never copied into the generated
# file. Every unsafe metadata variant is refused before validation.
write_state 0 7 -
cat >"$overlay" <<'EOF'
@localOverlay path /local-overlay-test
respond @localOverlay 418
EOF
chown root:caddy "$overlay"
chmod 0640 "$overlay"
reset_logs
bash "$generator"
[ "$(sed -n '3p' /etc/caddy/Caddyfile)" = "  import $overlay" ] \
  || fail "valid overlay was not imported first"
! grep -Fq '@localOverlay' /etc/caddy/Caddyfile \
  || fail "overlay contents were copied into the managed Caddyfile"
remove_overlay

printf 'respond /redirected 200\n' >"$test_root/target"
chown root:caddy "$test_root/target"
chmod 0640 "$test_root/target"
ln -s "$test_root/target" "$overlay"
expect_overlay_refusal symlink

printf 'respond /hardlinked 200\n' >"$test_root/hardlink"
chown root:caddy "$test_root/hardlink"
chmod 0640 "$test_root/hardlink"
ln "$test_root/hardlink" "$overlay"
expect_overlay_refusal hardlink
rm -f "$test_root/hardlink"

printf 'respond /wrong-owner 200\n' >"$overlay"
chown 65534:caddy "$overlay"
chmod 0640 "$overlay"
expect_overlay_refusal wrong-owner

printf 'respond /wrong-mode 200\n' >"$overlay"
chown root:caddy "$overlay"
chmod 0644 "$overlay"
expect_overlay_refusal wrong-mode

# Safe metadata with invalid syntax must fail validation before replacement.
printf 'invalid caddy syntax\n' >"$overlay"
chown root:caddy "$overlay"
chmod 0640 "$overlay"
reset_logs
touch "$test_root/fail-validate"
write_original
if bash "$generator" >"$test_root/invalid-syntax.log" 2>&1; then
  fail "failed validation was ignored"
fi
[ "$(cat /etc/caddy/Caddyfile)" = 'original caddy config' ] \
  || fail "failed validation replaced active Caddyfile"
[ "$(tr '\n' ' ' <"$test_root/order.log")" = 'fmt validate ' ] \
  || fail "validation did not precede installation"

echo "Caddy overlay smoke: ok"
