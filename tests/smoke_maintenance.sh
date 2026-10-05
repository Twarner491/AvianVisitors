#!/usr/bin/env bash
# Run as root in a disposable Debian container. The systemd runner is replaced,
# but both actions terminate in fixed root-owned helpers exactly as production.

set -euo pipefail
IFS=$'\n\t'

fail() { echo "FAIL: $*" >&2; exit 1; }

[ "${EUID:-$(id -u)}" -eq 0 ] || { echo 'run this smoke test as root' >&2; exit 1; }
test_root=/tmp/avian-maintenance-smoke
rm -rf "$test_root" /var/lib/avian-maintenance
mkdir -p "$test_root/repo/scripts" /usr/local/bin /usr/local/sbin

cp /source/scripts/maintenance_control.sh /usr/local/sbin/avian-maintenance-control
cat >/usr/local/sbin/avian-update-control <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
touch /tmp/avian-maintenance-smoke/update.called
EOF
cat >/usr/local/sbin/avian-service-refresh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
touch /tmp/avian-maintenance-smoke/services.called
EOF
cat >"$test_root/repo/scripts/update_birdnet.sh" <<'EOF'
#!/usr/bin/env bash
touch /tmp/avian-maintenance-smoke/mutable-update.called
EOF
cat >"$test_root/repo/scripts/reinstall_services.sh" <<'EOF'
#!/usr/bin/env bash
touch /tmp/avian-maintenance-smoke/mutable-services.called
EOF
chown root:root \
  /usr/local/sbin/avian-maintenance-control \
  /usr/local/sbin/avian-update-control \
  /usr/local/sbin/avian-service-refresh
chmod 0755 \
  /usr/local/sbin/avian-maintenance-control \
  /usr/local/sbin/avian-update-control \
  /usr/local/sbin/avian-service-refresh \
  "$test_root/repo/scripts/"*.sh

cat >/usr/local/bin/systemctl <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  is-active) echo inactive ;;
esac
exit 0
EOF
cat >/usr/local/bin/systemd-run <<'EOF'
#!/usr/bin/env bash
while [ "$#" -gt 0 ] && [ "$1" != /usr/local/sbin/avian-maintenance-control ]; do
  shift
done
[ "$#" -eq 3 ] || exit 1
"$@" >/dev/null 2>&1 || true
exit 0
EOF
chmod 0755 /usr/local/bin/systemctl /usr/local/bin/systemd-run

/usr/local/sbin/avian-maintenance-control | grep -q '"state":"idle"' \
  || fail 'initial status was not idle'
/usr/local/sbin/avian-maintenance-control services | grep -q '"state":"complete"' \
  || fail 'service refresh did not complete'
[ -e "$test_root/services.called" ] || fail 'fixed service helper did not run'
[ ! -e "$test_root/mutable-services.called" ] \
  || fail 'maintenance executed checkout service code as root'

/usr/local/sbin/avian-maintenance-control update | grep -q '"state":"complete"' \
  || fail 'update did not complete'
[ -e "$test_root/update.called" ] || fail 'fixed update helper did not run'
[ ! -e "$test_root/mutable-update.called" ] \
  || fail 'maintenance executed checkout update code as root'

cat >/usr/local/sbin/avian-update-control <<'EOF'
#!/usr/bin/env bash
exit 23
EOF
chown root:root /usr/local/sbin/avian-update-control
chmod 0755 /usr/local/sbin/avian-update-control
/usr/local/sbin/avian-maintenance-control update | grep -q '"state":"failed"' \
  || fail 'failed helper was reported as successful'
/usr/local/sbin/avian-maintenance-control status | grep -q '"detail":"exit 23"' \
  || fail 'failed helper exit status was not retained'

chmod 0775 /usr/local/sbin/avian-update-control
/usr/local/sbin/avian-maintenance-control update | grep -q '"state":"failed"' \
  || fail 'writable root helper was accepted'
/usr/local/sbin/avian-maintenance-control status | grep -q '"detail":"helper unavailable"' \
  || fail 'unsafe helper failure was unclear'

if /usr/local/sbin/avian-maintenance-control unknown >/dev/null 2>&1; then
  fail 'unknown action was accepted'
fi

echo 'maintenance smoke: ok'
