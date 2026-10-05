#!/usr/bin/env bash
# Run inside a disposable Debian container with the repository at /source.

set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

[ "${EUID:-$(id -u)}" -eq 0 ] || fail "run this smoke in a disposable container as root"
id caddy >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
mkdir -p /var/lib/avian-visitors
chown root:root /var/lib/avian-visitors
chmod 0755 /var/lib/avian-visitors
legacy_hash='$2y$14$FJs8skDlFXw6UEyzPutTQuQBPcFdy0iyGDrL3silEC/X6CwX7aOhi'
printf 'v1\t0\t0\t%s\n' "$legacy_hash" \
  >/var/lib/avian-visitors/admin-auth.state
chown root:caddy /var/lib/avian-visitors/admin-auth.state
chmod 0640 /var/lib/avian-visitors/admin-auth.state
printf '{"version":1,"entries":{}}\n' \
  >/var/lib/avian-visitors/admin-auth.rate
chown root:caddy /var/lib/avian-visitors/admin-auth.rate
chmod 0660 /var/lib/avian-visitors/admin-auth.rate

cat >/tmp/maintenance-control-test <<'EOF'
#!/bin/sh
printf '{"ok":true,"action":"%s","state":"queued"}\n' "$1"
EOF
chmod 0755 /tmp/maintenance-control-test
mkdir -p /tmp/maintenance-api-bin
cat >/tmp/maintenance-api-bin/sudo <<'EOF'
#!/bin/sh
[ "${1:-}" = -n ] && shift
exec "$@"
EOF
chmod 0755 /tmp/maintenance-api-bin/sudo
export PATH="/tmp/maintenance-api-bin:$PATH"

AV_MAINTENANCE_CONTROL=/tmp/maintenance-control-test php -S 127.0.0.1:8898 -t /source \
  >/tmp/maintenance-api-server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT

for _ in 1 2 3 4 5; do
  curl -fsS http://127.0.0.1:8898/avian/api/maintenance.php >/tmp/maintenance-api-body 2>/dev/null && break
  sleep 1
done
grep -q '"action":"status"' /tmp/maintenance-api-body || fail "local GET status"

code=$(curl -sS -o /tmp/maintenance-api-body -w '%{http_code}' \
  -H 'X-Forwarded-For: 203.0.113.8' http://127.0.0.1:8898/avian/api/maintenance.php)
[ "$code" = 401 ] || fail "forwarded request guard"

code=$(curl -sS -o /tmp/maintenance-api-body -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' --data '{}' \
  http://127.0.0.1:8898/avian/api/maintenance.php)
[ "$code" = 403 ] || fail "action header guard"

code=$(curl -sS -o /tmp/maintenance-api-body -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'X-Avian-Action: 1' \
  --data '{"action":"update"}' http://127.0.0.1:8898/avian/api/maintenance.php)
[ "$code" = 400 ] || fail "confirmation guard"

code=$(curl -sS -o /tmp/maintenance-api-body -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H 'X-Avian-Action: 1' \
  --data '{"action":"update","confirm":"update-station"}' \
  http://127.0.0.1:8898/avian/api/maintenance.php)
[ "$code" = 200 ] || fail "confirmed update"
grep -q '"action":"update"' /tmp/maintenance-api-body || fail "fixed action routing"

kill "$server_pid"
wait "$server_pid" 2>/dev/null || true
trap - EXIT
printf 'v1\t1\t1\t%s\n' "$legacy_hash" \
  >/var/lib/avian-visitors/admin-auth.state
AV_MAINTENANCE_CONTROL=/tmp/maintenance-control-test \
  php -S 127.0.0.1:8897 -t /source >/tmp/maintenance-auth-server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for _ in 1 2 3 4 5; do
  code=$(curl -sS -o /tmp/maintenance-api-body -w '%{http_code}' \
    http://127.0.0.1:8897/avian/api/maintenance.php) && [ "$code" = 401 ] && break
  sleep 1
done
[ "$code" = 401 ] || fail "configured auth gate"
curl -fsS -c /tmp/maintenance-api-cookie \
  -X POST -H 'Content-Type: application/json' \
  -H 'X-Avian-Action: 1' -H 'X-Avian-Credential: 1' \
  -u 'birdnet:legacy-safe' \
  http://127.0.0.1:8897/avian/api/menu.php >/tmp/maintenance-login-body
curl -fsS -b /tmp/maintenance-api-cookie \
  http://127.0.0.1:8897/avian/api/maintenance.php >/tmp/maintenance-api-body
grep -q '"action":"status"' /tmp/maintenance-api-body || fail "authenticated status"

echo 'maintenance api smoke: ok'
