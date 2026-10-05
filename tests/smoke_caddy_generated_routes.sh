#!/usr/bin/env bash
# Run as root with real Caddy in a disposable Debian container and
# AVIAN_CADDY_GENERATED_ROUTES_TEST=1 set explicitly.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  [ ! -f /tmp/avian-generated-caddy.log ] || tail -n 80 /tmp/avian-generated-caddy.log >&2
  exit 1
}

[ -f /.dockerenv ] \
  || fail "refusing generated Caddy route smoke outside a disposable container"
[ "${AVIAN_CADDY_GENERATED_ROUTES_TEST:-0}" = 1 ] \
  || fail "refusing generated Caddy route smoke without AVIAN_CADDY_GENERATED_ROUTES_TEST=1"
[ "${EUID:-$(id -u)}" -eq 0 ] || fail "test must run as root"
for command in caddy curl php; do command -v "$command" >/dev/null || fail "$command is required"; done
fpm_bin=''
for candidate in php-fpm8.4 php-fpm8.3 php-fpm8.2 php-fpm84 php-fpm83 php-fpm82 php-fpm81 php-fpm; do
  if command -v "$candidate" >/dev/null; then fpm_bin=$candidate; break; fi
done
[ -n "$fpm_bin" ] || fail "PHP-FPM is required"

test_root=$(mktemp -d)
site=$test_root/site
caddy_pid=''
fpm_pid=''
cleanup() {
  [ -z "$caddy_pid" ] || kill "$caddy_pid" 2>/dev/null || true
  [ -z "$fpm_pid" ] || kill "$fpm_pid" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$test_root"
}
trap cleanup EXIT

id caddy >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
id bird >/dev/null 2>&1 || useradd --create-home --shell /bin/bash bird
mkdir -p /etc/birdnet /etc/caddy /var/lib/avian-visitors \
  "$site/Processed/x" "$site/Processed-old" "$site/planted" \
  "$site/nested" "$site/By_Date/x" "$site/Charts/x" \
  "$site/avian/api" "$site/scripts/filemanager" "$site/scripts-old" \
  "$site/phpsysinfo"
chmod 0755 "$test_root" "$site"
printf 'US/Pacific\n' >/etc/timezone
ln -sfn /usr/share/zoneinfo/US/Pacific /etc/localtime
install -o root -g root -m 0600 /dev/null \
  /var/lib/avian-visitors/admin-auth.lock
install -o root -g root -m 0755 /source/scripts/admin_control.sh \
  /usr/local/sbin/avian-admin-control
printf 'audio\n' >"$site/Processed/good.mp3"
printf 'date\n' >"$site/By_Date/good.txt"
printf 'chart\n' >"$site/Charts/good.txt"
printf '<?php echo "processed"; ?>\n' >"$site/Processed/x/index.php"
printf '<?php echo "alias"; ?>\n' >"$site/Processed.php"
printf '<?php echo "old"; ?>\n' >"$site/Processed-old/evil.php"
printf '<?php echo "root"; ?>\n' >"$site/backdoor.php"
printf '<?php echo "index"; ?>\n' >"$site/planted/index.php"
printf '<?php echo "backup"; ?>\n' >"$site/nested/evil.php.bak"
printf '<?php echo "tilde"; ?>\n' >"$site/nested/evil.phtml~"
printf '<?php echo "phps"; ?>\n' >"$site/nested/evil.phps"
printf '<?php echo "text"; ?>\n' >"$site/nested/evil.php.txt"
printf '<?php echo "disabled"; ?>\n' >"$site/nested/evil.php.disabled"
printf '<?php echo "root backup"; ?>\n' >"$site/index.php.bak"
printf '<?php echo "root alias"; ?>\n' >"$site/index.php-old"
printf '<?php echo "scripts alias"; ?>\n' >"$site/scripts.php"
printf '<?php echo "scripts old"; ?>\n' >"$site/scripts-old/evil.php"
printf '<?php echo "info alias"; ?>\n' >"$site/phpsysinfo.php"
printf '<?php echo "stream alias"; ?>\n' >"$site/stream.php"
printf '<?php echo "date"; ?>\n' >"$site/By_Date/x/index.php"
printf '<?php echo "chart"; ?>\n' >"$site/Charts/x/evil.php.bak"

legacy_roots=(index views play spectrogram overview stats todays_detections history weekly_report)
for name in "${legacy_roots[@]}"; do
  printf '<?php echo "legacy"; ?>\n' >"$site/$name.php"
done
legacy_scripts=(
  adminer-de adminer-fr adminer advanced api backup common config ebird history
  overview play restore service_controls species_list species_tools spectrogram
  stats system_controls todays_detections weekly_report
)
for name in "${legacy_scripts[@]}"; do
  printf '<?php echo "script"; ?>\n' >"$site/scripts/$name.php"
done
printf '<?php echo "files"; ?>\n' >"$site/scripts/filemanager/filemanager.php"
printf '<?php echo "info"; ?>\n' >"$site/phpsysinfo/index.php"
printf '<?php echo "js"; ?>\n' >"$site/phpsysinfo/js.php"
printf '<?php echo "info backup"; ?>\n' >"$site/phpsysinfo/js.php.bak"

api_names=(archive birdnet-api birdnet-status birdweather config cutout educator-audio-check educator-audio educators export generate maintenance menu recording spectrogram wiki)
for name in "${api_names[@]}"; do
  printf '<?php echo "api"; ?>\n' >"$site/avian/api/$name.php"
done
cp /source/avian/api/admin-auth.php /source/avian/api/admin-state.php \
  "$site/avian/api/"
cat >"$site/avian/api/config.php" <<'PHP'
<?php
require __DIR__ . '/admin-auth.php';
echo (avian_is_direct_local_request($_SERVER) ? 'direct' : 'forwarded') . '|'
    . ($_SERVER['AVIAN_DIRECT_LOCAL'] ?? 'missing') . '|'
    . ($_SERVER['AVIAN_FORCE_AUTH'] ?? 'missing') . '|'
    . ($_SERVER['AVIAN_EXTRACTED_ROOT'] ?? 'missing') . '|'
    . ($_SERVER['AVIAN_STATION_TIMEZONE'] ?? 'missing');
PHP
printf '<?php echo "unknown"; ?>\n' >"$site/avian/api/unknown.php"
cp /source/avian/api/educator-state.php "$site/avian/api/educator-state.php"
printf '<?php echo "cli only"; ?>\n' >"$site/avian/api/educator-store.php"

cat >/usr/bin/systemctl <<'EOF'
#!/bin/sh
case "$*" in
  'is-active icecast2') printf 'inactive\n'; exit 3 ;;
  'is-active --quiet icecast2'|'is-active --quiet caddy') exit 3 ;;
  'cat icecast2') exit 1 ;;
  'show -p MainPID --value icecast2'|'show -p ControlPID --value icecast2') printf '0\n' ;;
  'show -p ControlGroup --value icecast2') printf '\n' ;;
  *) exit 0 ;;
esac
EOF
chmod 0755 /usr/bin/systemctl

mkdir -p /run/php
cat >/tmp/avian-generated-fpm.conf <<EOF
[global]
pid = /tmp/avian-generated-fpm.pid
error_log = /tmp/avian-generated-fpm.log
daemonize = no

[avian]
user = bird
group = bird
listen = /run/php/php-test-fpm.sock
listen.owner = bird
listen.group = bird
listen.mode = 0660
pm = static
pm.max_children = 2
catch_workers_output = yes
clear_env = no
EOF
"$fpm_bin" -F -y /tmp/avian-generated-fpm.conf >/tmp/avian-generated-fpm.stdout 2>&1 &
fpm_pid=$!
for _ in $(seq 1 50); do
  find /run/php -maxdepth 1 -type s -name 'php*-fpm.sock' -print -quit \
    | grep -q . && break
  sleep 0.1
done
find /run/php -maxdepth 1 -type s -name 'php*-fpm.sock' -print -quit \
  | grep -q . || fail "PHP-FPM socket did not start"

write_config() {
  cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=bird
EXTRACTED=$site
EOF
  local verifier=-
  case "$2" in
    legacy-safe)
      verifier='$2y$14$FJs8skDlFXw6UEyzPutTQuQBPcFdy0iyGDrL3silEC/X6CwX7aOhi'
      ;;
    new-safe)
      verifier='$2y$14$T/XmVY5eZsHFZIiG2rtyc.5Fs9gWOFyCaeohKRdCmt8qVJqaJgDNa'
      ;;
  esac
  printf 'v1\t%s\t%s\t%s\n' "$1" "${3:-1}" "$verifier" \
    >/var/lib/avian-visitors/admin-auth.state
  chown root:caddy /var/lib/avian-visitors/admin-auth.state
  chmod 0640 /var/lib/avian-visitors/admin-auth.state
}

generate() {
  bash /source/scripts/update_caddyfile.sh >/tmp/avian-generated-render.out
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
}

start_caddy() {
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile \
    >/tmp/avian-generated-caddy.log 2>&1 &
  caddy_pid=$!
  for _ in $(seq 1 50); do
    if curl -sS --max-time 1 -o /dev/null http://127.0.0.1/ 2>/dev/null; then return; fi
    sleep 0.1
  done
  fail "generated Caddyfile did not start"
}

stop_caddy() {
  kill "$caddy_pid" 2>/dev/null || true
  wait "$caddy_pid" 2>/dev/null || true
  caddy_pid=''
}

code() {
  curl -sS -o /dev/null -w '%{http_code}' "$@"
}

body() {
  curl -fsS "$@"
}

assert_notification_image_route() {
  [ "$(code 'http://127.0.0.1/api/v1/image/Calypte%20anna')" = 200 ] \
    || fail "notification image API did not reach its reviewed front controller"
  [ "$(code -H 'Forwarded: for=198.51.100.2' \
    'http://127.0.0.1/api/v1/image/Calypte%20anna')" = 200 ] \
    || fail "notification image API changed its established public behavior"
  for target in /api/v1/image /api/v1/other/bird /api/v1/image.php; do
    [ "$(code "http://127.0.0.1$target")" = 404 ] \
      || fail "unreviewed legacy API route was published: $target"
  done
}

assert_unknowns_closed() {
  local target result
  for target in \
    /backdoor.php \
    /planted/ \
    /planted/index.php \
    /Processed.php \
    /Processed-old/evil.php \
    /nested/evil.php.bak \
    /nested/evil.phtml~ \
    /nested/evil.phps \
    /nested/evil.php.txt \
    /nested/evil.php.disabled \
    /index.php.bak \
    /index.php-old \
    /scripts.php \
    /scripts-old/evil.php \
    /phpsysinfo.php \
    /By_Date/x/index.php \
    /Charts/x/evil.php.bak \
    /stream.php; do
    result=$(code "http://127.0.0.1$target")
    [ "$result" = 404 ] || fail "served planted or stale executable path $target as $result"
  done
}

assert_password_transition_lock() {
  local label=$1 credential target result
  for credential in legacy-safe new-safe; do
    for target in \
      /Processed/good.mp3 \
      /index.php \
      /scripts/adminer.php \
      /phpsysinfo/index.php \
      /log \
      /terminal; do
      result=$(code -u "birdnet:$credential" "http://127.0.0.1$target")
      [ "$result" = 404 ] \
        || fail "$label exposed $target to $credential as $result"
    done
    [ "$(code -u "birdnet:$credential" \
      http://127.0.0.1/avian/api/menu.php)" = 200 ] \
      || fail "$label blocked the native API before its PHP proof check"
  done
  [ "$(code http://127.0.0.1/stream)" = 404 ] \
    || fail "$label exposed a new live audio request"
}

# Trusted default mode keeps reviewed local legacy pages and static recordings,
# but never sends writable recording trees through PHP-FPM.
cat >/etc/birdnet/birdnet.conf <<'EOF'
BIRDNET_USER=bird
EXTRACTED=/
EOF
if bash /source/scripts/update_caddyfile.sh \
    >/tmp/avian-generated-invalid-webroot.out 2>&1; then
  fail "filesystem root was accepted as the BirdNET-Pi webroot"
fi
grep -Fq "Invalid BirdNET-Pi webroot" \
  /tmp/avian-generated-invalid-webroot.out \
  || fail "unsafe webroot returned the wrong validation error"
cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=bird
EXTRACTED=$site/../site
EOF
if bash /source/scripts/update_caddyfile.sh \
    >/tmp/avian-generated-traversal-webroot.out 2>&1; then
  fail "traversal webroot was accepted"
fi
grep -Fq "Invalid BirdNET-Pi webroot" \
  /tmp/avian-generated-traversal-webroot.out \
  || fail "traversal webroot returned the wrong validation error"
printf '../UTC\n' >/etc/timezone
ln -sfn /usr/share/zoneinfo/Etc/UTC /etc/localtime
write_config 0 ''
if bash /source/scripts/update_caddyfile.sh \
    >/tmp/avian-generated-invalid-timezone.out 2>&1; then
  fail "invalid station timezone was accepted"
fi
grep -Fq "Station timezone is invalid" \
  /tmp/avian-generated-invalid-timezone.out \
  || fail "invalid timezone returned the wrong validation error"
printf 'US/Pacific\n' >/etc/timezone
ln -sfn /usr/share/zoneinfo/US/Pacific /etc/localtime
write_config 0 ''
generate
start_caddy
shell_headers=$(curl -sS -D - -o /dev/null \
  'http://127.0.0.1/?edu=c_0123456789abcdef0123456789abcdef')
printf '%s\n' "$shell_headers" | tr -d '\r' | grep -Fqi 'Cache-Control: no-store' \
  || fail "saved-view shell response was cacheable"
printf '%s\n' "$shell_headers" | tr -d '\r' | grep -Fqi 'Referrer-Policy: no-referrer' \
  || fail "saved-view shell response could leak its capability in a referrer"
[ "$(code http://127.0.0.1/Processed/good.mp3)" = 200 ] \
  || fail "trusted mode did not serve a recording"
[ "$(code http://127.0.0.1/Processed/x/)" = 404 ] \
  || fail "trusted mode exposed a Processed index.php rewrite"
[ "$(code -H 'Forwarded: for=198.51.100.2' http://127.0.0.1/Processed/good.mp3)" = 404 ] \
  || fail "proxied request reached direct Processed access"
[ "$(code -H 'X-Forwarded-Prefix: /station' http://127.0.0.1/Processed/good.mp3)" = 404 ] \
  || fail "forwarding prefix reached direct Processed access"
[ "$(code http://127.0.0.1/scripts/adminer.php)" = 404 ] \
  || fail "trusted mode exposed scripts without a configured password"
[ "$(code http://127.0.0.1/phpsysinfo/index.php)" = 404 ] \
  || fail "trusted mode exposed phpSysInfo without a configured password"
[ "$(code http://127.0.0.1/By_Date/good.txt)" = 200 ] \
  || fail "trusted mode blocked a normal By_Date file"
[ "$(code http://127.0.0.1/Charts/good.txt)" = 200 ] \
  || fail "trusted mode blocked a normal Charts file"
for name in "${api_names[@]}"; do
  [ "$(code "http://127.0.0.1/avian/api/$name.php")" = 200 ] \
    || fail "trusted mode reviewed API did not reach PHP-FPM: $name"
done
[ "$(code http://127.0.0.1/avian/api/unknown.php)" = 404 ] \
  || fail "trusted mode sent an unknown API to PHP-FPM"
[ "$(code http://127.0.0.1/avian/api/educator-state.php)" = 404 ] \
  || fail "trusted mode exposed the include-only Educators state"
[ "$(code http://127.0.0.1/avian/api/educator-store.php)" = 404 ] \
  || fail "trusted mode exposed the CLI-only Educators store"
[ "$(code http://127.0.0.1/log)" = 502 ] \
  || fail "trusted mode blocked the local log proxy"
[ "$(code http://127.0.0.1/terminal)" = 404 ] \
  || fail "trusted mode exposed the terminal without a password"
[ "$(code -H 'Forwarded: for=198.51.100.2' http://127.0.0.1/log)" = 404 ] \
  || fail "trusted mode exposed the log proxy through a forwarding marker"
[ "$(code -H 'X-Forwarded-Prefix: /station' http://127.0.0.1/log)" = 404 ] \
  || fail "trusted mode exposed the log proxy through a forwarding prefix"
[ "$(code http://127.0.0.1/stream)" = 502 ] \
  || fail "trusted mode blocked direct live audio"
[ "$(code -H 'Forwarded: for=198.51.100.2' http://127.0.0.1/stream)" = 404 ] \
  || fail "trusted mode exposed proxied live audio"
[ "$(code -H 'Host: public.example' http://127.0.0.1/stream)" = 404 ] \
  || fail "trusted mode exposed live audio for a public Host"
[ "$(code -H 'X-Forwarded-Prefix: /station' http://127.0.0.1/stream)" = 404 ] \
  || fail "trusted mode exposed live audio through a forwarding prefix"
direct_marker=$(body http://127.0.0.1/avian/api/config.php)
[ "$direct_marker" = "direct|1|0|$site|US/Pacific" ] \
  || fail "trusted mode direct API marker was: $direct_marker"
[ "$(body -H 'X-Forwarded-Prefix: /station' \
  http://127.0.0.1/avian/api/config.php)" = "forwarded|0|1|$site|US/Pacific" ] \
  || fail "forwarding prefix received the direct API marker"
[ "$(body -H 'Host: public.example' \
  http://127.0.0.1/avian/api/config.php)" = "forwarded|0|1|$site|US/Pacific" ] \
  || fail "public Host received the direct API marker"
assert_notification_image_route
assert_unknowns_closed
stop_caddy

# Compatibility mode retains the old password-gated legacy PHP surface.
write_config 0 legacy-safe
generate
grep -Fc 'env AVIAN_LEGACY_AUTH 1' /etc/caddy/Caddyfile | grep -Fxq 2 \
  || fail "password mode did not mark both Caddy-authenticated PHP handlers"
grep -Fc 'env AVIAN_LEGACY_AUTH_EPOCH 1' /etc/caddy/Caddyfile | grep -Fxq 2 \
  || fail "password mode did not bind PHP proof to the current auth epoch"
start_caddy
[ "$(code http://127.0.0.1/index.php)" = 401 ] \
  || fail "password mode exposed legacy PHP without credentials"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/index.php)" = 200 ] \
  || fail "password mode blocked the reviewed legacy PHP route after auth"
[ "$(code http://127.0.0.1/Processed/good.mp3)" = 401 ] \
  || fail "password mode exposed Processed without credentials"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/Processed/good.mp3)" = 200 ] \
  || fail "password mode blocked a recording after auth"
for name in "${legacy_roots[@]}"; do
  [ "$(code -u birdnet:legacy-safe "http://127.0.0.1/$name.php")" = 200 ] \
    || fail "password mode blocked reviewed legacy root $name"
  [ "$(code -u birdnet:legacy-safe "http://127.0.0.1/$name.php/path-info")" = 200 ] \
    || fail "password mode blocked reviewed root PATH_INFO $name"
done
for name in "${legacy_scripts[@]}"; do
  [ "$(code -u birdnet:legacy-safe "http://127.0.0.1/scripts/$name.php")" = 200 ] \
    || fail "password mode blocked reviewed legacy script $name"
done
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/scripts/filemanager/filemanager.php)" = 200 ] \
  || fail "password mode blocked the reviewed file manager route"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo/index.php)" = 200 ] \
  || fail "password mode blocked the reviewed phpSysInfo entry point"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo)" = 200 ] \
  || fail "password mode blocked the phpSysInfo base path"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo/)" = 200 ] \
  || fail "password mode blocked the phpSysInfo directory path"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo/js.php?name=jquery)" = 200 ] \
  || fail "password mode blocked a phpSysInfo helper"
[ "$(code http://127.0.0.1/phpsysinfo/js.php.bak)" = 401 ] \
  || fail "password mode exposed phpSysInfo source without credentials"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo/js.php.bak)" = 404 ] \
  || fail "password mode served authenticated phpSysInfo source"
[ "$(code http://127.0.0.1/log)" = 401 ] \
  || fail "password mode exposed the log proxy without credentials"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/log)" = 502 ] \
  || fail "password mode blocked the authenticated log proxy"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/terminal)" = 502 ] \
  || fail "password mode blocked the authenticated terminal proxy"
[ "$(code http://127.0.0.1/stream)" = 502 ] \
  || fail "password compatibility mode blocked direct live audio"
[ "$(code -H 'Host: public.example' http://127.0.0.1/stream)" = 404 ] \
  || fail "password compatibility mode exposed live audio for a public Host"
[ "$(code -H 'X-Forwarded-Prefix: /station' http://127.0.0.1/stream)" = 404 ] \
  || fail "password compatibility mode exposed live audio through a forwarding prefix"
assert_notification_image_route
assert_unknowns_closed
stop_caddy

# Password changes first install a required-mode Caddy barrier. Model both
# abrupt-death boundaries with the real generated configuration: old live
# state before commit, then new live state before the final render. Legacy
# static, proxy, and PHP surfaces stay closed in both states.
write_config 1 new-safe 2
generate
write_config 0 legacy-safe 1
start_caddy
assert_password_transition_lock "pre-commit password barrier"
stop_caddy

write_config 0 new-safe 2
start_caddy
assert_password_transition_lock "post-commit password barrier"
stop_caddy

# An exact retry renders the authoritative new password and reopens only the
# compatibility surface selected by trusted mode.
generate
start_caddy
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/Processed/good.mp3)" = 401 ] \
  || fail "final password render retained the revoked credential"
[ "$(code -u birdnet:new-safe http://127.0.0.1/Processed/good.mp3)" = 200 ] \
  || fail "final password render rejected the new credential"
[ "$(code -u birdnet:new-safe http://127.0.0.1/index.php)" = 200 ] \
  || fail "final password render did not restore reviewed legacy PHP"
[ "$(code -u birdnet:new-safe http://127.0.0.1/log)" = 502 ] \
  || fail "final password render did not restore the reviewed log proxy"
stop_caddy

# Required mode closes the complete legacy surface, even with the password.
write_config 1 legacy-safe
generate
start_caddy
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/index.php)" = 404 ] \
  || fail "required mode exposed legacy PHP"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/Processed/good.mp3)" = 404 ] \
  || fail "required mode exposed legacy Processed data"
for name in "${legacy_roots[@]}"; do
  [ "$(code -u birdnet:legacy-safe "http://127.0.0.1/$name.php")" = 404 ] \
    || fail "required mode exposed legacy root $name"
done
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/scripts/adminer.php)" = 404 ] \
  || fail "required mode exposed legacy scripts"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo/index.php)" = 404 ] \
  || fail "required mode exposed phpSysInfo"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo/js.php)" = 404 ] \
  || fail "required mode exposed a phpSysInfo helper"
[ "$(code -u birdnet:legacy-safe http://127.0.0.1/phpsysinfo/js.php.bak)" = 404 ] \
  || fail "required mode exposed phpSysInfo source"
assert_unknowns_closed

for name in "${api_names[@]}"; do
  [ "$(code "http://127.0.0.1/avian/api/$name.php")" = 200 ] \
    || fail "reviewed API did not reach PHP-FPM in required mode: $name"
  [ "$(code -H 'Forwarded: for=198.51.100.2' "http://127.0.0.1/avian/api/$name.php")" = 200 ] \
    || fail "proxied reviewed API did not reach PHP-FPM: $name"
done
[ "$(code http://127.0.0.1/avian/api/unknown.php)" = 404 ] \
  || fail "unknown API reached PHP-FPM"
[ "$(code http://127.0.0.1/avian/api/educator-state.php)" = 404 ] \
  || fail "required mode exposed the include-only Educators state"
[ "$(code http://127.0.0.1/avian/api/educator-store.php)" = 404 ] \
  || fail "required mode exposed the CLI-only Educators store"
[ "$(code http://127.0.0.1/avian/api/admin-state.php)" = 404 ] \
  || fail "include-only admin state reached PHP-FPM"
[ "$(code http://127.0.0.1/stream)" = 404 ] \
  || fail "required mode exposed live audio"
[ "$(code -H 'Host: public.example' http://127.0.0.1/stream)" = 404 ] \
  || fail "required mode changed behavior for a public Host"
[ "$(body http://127.0.0.1/avian/api/config.php)" = "direct|1|1|$site|US/Pacific" ] \
  || fail "required mode did not preserve its direct force-auth marker"
[ "$(body -H 'X-Forwarded-Prefix: /station' \
  http://127.0.0.1/avian/api/config.php)" = "forwarded|0|1|$site|US/Pacific" ] \
  || fail "required mode forwarding prefix received the direct marker"
assert_notification_image_route

echo "generated Caddy route smoke: ok"
