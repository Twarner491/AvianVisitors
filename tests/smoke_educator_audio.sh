#!/usr/bin/env bash
# Run only as root in a disposable Debian container with the explicit opt-in.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  if [ -n "${test_root:-}" ] && [ -d "$test_root" ]; then
    ls -l "$test_root"/*.out "$test_root"/*.err "$test_root"/*.headers 2>/dev/null >&2 || true
    for artifact in "$test_root"/*.err "$test_root"/*.headers; do
      [ ! -f "$artifact" ] || { echo "--- $(basename "$artifact")" >&2; sed -n '1,80p' "$artifact" >&2; }
    done
  fi
  [ ! -f /tmp/avian-educator-audio-caddy.log ] \
    || tail -n 60 /tmp/avian-educator-audio-caddy.log >&2
  [ ! -f /tmp/avian-educator-audio-fpm.log ] \
    || tail -n 60 /tmp/avian-educator-audio-fpm.log >&2
  [ ! -f /tmp/avian-educator-audio-icecast.log ] \
    || tail -n 60 /tmp/avian-educator-audio-icecast.log >&2
  exit 1
}

[ -f /.dockerenv ] \
  || fail 'refusing Educators audio smoke outside a disposable container'
[ "${AVIAN_EDUCATOR_AUDIO_TEST:-0}" = 1 ] \
  || fail 'refusing Educators audio smoke without AVIAN_EDUCATOR_AUDIO_TEST=1'
[ "${EUID:-$(id -u)}" -eq 0 ] || fail 'test must run as root'
for command in caddy curl php runuser; do
  command -v "$command" >/dev/null || fail "$command is required"
done
fpm_bin=''
for candidate in php-fpm8.4 php-fpm8.3 php-fpm8.2 php-fpm; do
  if command -v "$candidate" >/dev/null; then fpm_bin=$candidate; break; fi
done
[ -n "$fpm_bin" ] || fail 'PHP-FPM is required'

test_root=$(mktemp -d)
caddy_pid=''
fpm_pid=''
icecast_pid=''
stream_a=''
stream_b=''
stream_c=''
stream_d=''
cleanup() {
  for pid in "$stream_a" "$stream_b" "$stream_c" "$stream_d" \
      "$icecast_pid" "$fpm_pid" "$caddy_pid"; do
    [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -rf "$test_root"
}
trap cleanup EXIT

getent group caddy >/dev/null || groupadd --system caddy
id caddy >/dev/null 2>&1 \
  || useradd --system --gid caddy --no-create-home --shell /usr/sbin/nologin caddy
mkdir -p /run/php /var/lib/avian-visitors "$test_root/sessions"
chown caddy:caddy "$test_root/sessions"
chmod 0700 "$test_root/sessions"
chmod 0755 "$test_root"
admin_verifier_a='$2y$14$FJs8skDlFXw6UEyzPutTQuQBPcFdy0iyGDrL3silEC/X6CwX7aOhi'
admin_verifier_b='$2y$14$FJs8skDlFXw6UEyzPutTQuQBPcFdy0iyGDrL3silEC/X6CwX7aOhj'

write_profile() {
  local enabled=$1 epoch=$2 temp
  temp=$(mktemp /var/lib/avian-visitors/.educators.state.XXXXXX)
  printf 'v1\t%s\t%s\n' "$enabled" "$epoch" >"$temp"
  chown root:caddy "$temp"
  chmod 0640 "$temp"
  mv -fT "$temp" /var/lib/avian-visitors/educators.state
}

write_admin_state() {
  local epoch=$1 required=${2:-1} verifier=${3:-$admin_verifier_a} temp
  temp=$(mktemp /var/lib/avian-visitors/.admin-auth.state.XXXXXX)
  printf 'v1\t%s\t%s\t%s\n' "$required" "$epoch" "$verifier" >"$temp"
  chown root:caddy "$temp"
  chmod 0640 "$temp"
  mv -fT "$temp" /var/lib/avian-visitors/admin-auth.state
}

write_corrupt_state() {
  local path=$1 prefix=$2 temp
  temp=$(mktemp "/var/lib/avian-visitors/.${prefix}.XXXXXX")
  printf 'corrupt\n' >"$temp"
  chown root:caddy "$temp"
  chmod 0640 "$temp"
  mv -fT "$temp" "$path"
}

write_profile 1 7
write_admin_state 1
for slot in /var/lib/avian-visitors/educator-audio-{0,1}.lock; do
  install -o root -g caddy -m 0660 /dev/null "$slot"
done

cat >"$test_root/mock_icecast.php" <<'PHP'
<?php
declare(strict_types=1);
pcntl_async_signals(true);
$children = [];
pcntl_signal(SIGCHLD, function () use (&$children): void {
    while (($pid = pcntl_waitpid(-1, $status, WNOHANG)) > 0) unset($children[$pid]);
});
pcntl_signal(SIGTERM, function () use (&$children): void {
    foreach (array_keys($children) as $pid) @posix_kill($pid, SIGTERM);
    exit;
});
$server = stream_socket_server('tcp://127.0.0.1:8000', $errno, $error);
if (!is_resource($server)) exit(1);
while (true) {
    $client = @stream_socket_accept($server, 1);
    if (!is_resource($client)) continue;
    $pid = pcntl_fork();
    if ($pid === 0) {
        fclose($server);
        stream_set_timeout($client, 2);
        while (($line = fgets($client)) !== false && trim($line) !== '') {}
        fwrite($client, "HTTP/1.0 200 OK\r\nContent-Type: audio/mpeg\r\nConnection: close\r\n\r\n");
        for ($index = 0; $index < 1200; $index++) {
            if (@fwrite($client, "audio-frame\n") === false) break;
            usleep(50000);
        }
        fclose($client);
        exit;
    }
    if ($pid > 0) $children[$pid] = true;
    fclose($client);
}
PHP
php "$test_root/mock_icecast.php" >/tmp/avian-educator-audio-icecast.log 2>&1 &
icecast_pid=$!

cat >"$test_root/fpm.conf" <<EOF
[global]
pid = $test_root/fpm.pid
error_log = /tmp/avian-educator-audio-fpm.log
daemonize = no

[avian]
user = caddy
group = caddy
listen = /run/php/avian-educator-audio.sock
listen.owner = caddy
listen.group = caddy
listen.mode = 0660
pm = static
pm.max_children = 6
catch_workers_output = yes
php_admin_value[session.save_path] = $test_root/sessions
php_admin_value[output_buffering] = 0
php_admin_flag[zlib.output_compression] = off
EOF
"$fpm_bin" -F -y "$test_root/fpm.conf" >/tmp/avian-educator-audio-fpm.stdout 2>&1 &
fpm_pid=$!

cat >"$test_root/Caddyfile" <<'EOF'
{
  admin off
  auto_https off
}
http:// {
  root * /source
  @directEducatorApi {
    path /avian/api/educator-audio.php /avian/api/educator-audio-check.php
    remote_ip private_ranges
    header_regexp localHost Host (?i)^(localhost|127[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3})(:[0-9]{1,5})?$
    not header Forwarded *
    not header X-Forwarded-For *
    not header X-Forwarded-Host *
    not header X-Forwarded-Proto *
    not header X-Forwarded-Port *
    not header X-Forwarded-Server *
    not header X-Forwarded-Scheme *
    not header X-Forwarded-Prefix *
    not header X-Real-Ip *
    not header Cf-Connecting-Ip *
    not header Cf-Connecting-IPv6 *
    not header Cf-Pseudo-IPv4 *
    not header Cf-Ray *
    not header Cf-Visitor *
  }
  handle @directEducatorApi {
    php_fastcgi unix//run/php/avian-educator-audio.sock {
      env AVIAN_DIRECT_LOCAL 1
      env AVIAN_FORCE_AUTH 1
      flush_interval -1
    }
  }
  handle /avian/api/* {
    php_fastcgi unix//run/php/avian-educator-audio.sock {
      env AVIAN_DIRECT_LOCAL 0
      env AVIAN_FORCE_AUTH 1
    }
  }
  respond 404
}
EOF
caddy validate --config "$test_root/Caddyfile" --adapter caddyfile >/dev/null
caddy run --config "$test_root/Caddyfile" --adapter caddyfile \
  >/tmp/avian-educator-audio-caddy.log 2>&1 &
caddy_pid=$!

for _ in $(seq 1 60); do
  [ -S /run/php/avian-educator-audio.sock ] \
    && curl -sS --max-time 0.2 http://127.0.0.1:8000/ >/dev/null 2>&1 \
    && curl -sS --max-time 0.2 http://127.0.0.1/ >/dev/null 2>&1 \
    && break
  sleep 0.1
done
kill -0 "$fpm_pid" 2>/dev/null || fail 'PHP-FPM did not start'
kill -0 "$caddy_pid" 2>/dev/null || fail 'Caddy did not start'
kill -0 "$icecast_pid" 2>/dev/null || fail 'mock Icecast did not start'

cat >"$test_root/grants.php" <<'PHP'
<?php
declare(strict_types=1);
ini_set('session.save_path', $argv[1]);
require '/source/avian/api/admin-auth.php';
$cookie = $argv[2];
$count = (int)$argv[3];
$requestMode = $argv[4] ?? 'direct';
$server = [
    'REQUEST_METHOD' => 'GET',
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_HOST' => 'localhost',
    'REQUEST_SCHEME' => 'http',
];
if ($requestMode === 'forwarded') $server['HTTP_FORWARDED'] = 'for=198.51.100.2';
if ($requestMode === 'public-host') $server['HTTP_HOST'] = 'public.example';
if ($cookie === '-') {
    if (!avian_create_admin_session($server)) {
        fwrite(STDERR, "could not create admin session\n");
        exit(2);
    }
    $cookie = session_id();
}
$_COOKIE[AVIAN_ADMIN_SESSION_NAME] = $cookie;
$lines = [$cookie];
if (!avian_admin_session_valid($server, null, false, false, true, false)) {
    fwrite(STDERR, "new admin session failed validation\n");
    exit(4);
}
for ($index = 0; $index < $count; $index++) {
    $token = avian_create_educator_audio_grant($server);
    if (!is_string($token)) {
        fwrite(STDERR, 'could not create audio grant; direct=' . (avian_is_direct_local_request($server) ? '1' : '0')
            . '; protected=' . (avian_lan_admin_auth_required($server) ? '1' : '0')
            . '; profile=' . json_encode(educator_profile_state()) . "\n");
        exit(3);
    }
    $lines[] = $token;
}
echo implode("\n", $lines) . "\n";
PHP
chown caddy:caddy "$test_root/grants.php"
chmod 0644 "$test_root/grants.php"

issue_grants() {
  local cookie=$1 count=$2 mode=${3:-direct}
  runuser -u caddy -- php "$test_root/grants.php" \
    "$test_root/sessions" "$cookie" "$count" "$mode"
}

cat >"$test_root/session.php" <<'PHP'
<?php
declare(strict_types=1);
ini_set('session.save_path', $argv[1]);
require '/source/avian/api/admin-auth.php';
$cookie = $argv[2];
$mode = $argv[3];
$server = [
    'REQUEST_METHOD' => 'GET',
    'REMOTE_ADDR' => '127.0.0.1',
    'HTTP_HOST' => 'localhost',
    'REQUEST_SCHEME' => 'http',
];
$_COOKIE[AVIAN_ADMIN_SESSION_NAME] = $cookie;
if ($mode === 'logout') {
    avian_logout_admin_session($server);
    exit;
}
if ($mode === 'idle'
    && avian_admin_session_valid($server, null, false, true, false, false)) {
    $_SESSION[AVIAN_ADMIN_SESSION_SEEN_KEY] = time() - AVIAN_ADMIN_SESSION_IDLE_SECONDS - 1;
    session_write_close();
    exit;
}
exit(2);
PHP
chown caddy:caddy "$test_root/session.php"
chmod 0644 "$test_root/session.php"

mutate_session() {
  local cookie=$1 mode=$2
  runuser -u caddy -- php "$test_root/session.php" "$test_root/sessions" "$cookie" "$mode"
}

start_stream() {
  local variable=$1 cookie=$2 token=$3 stem=$4 headers=${5:-}
  if [ -n "$headers" ]; then
    curl -sS --no-buffer --max-time 30 -D "$headers" -b "avian_admin=$cookie" \
      "$audio_url?grant=$token" >"$test_root/$stem.out" 2>"$test_root/$stem.err" &
  else
    curl -sS --no-buffer --max-time 30 -b "avian_admin=$cookie" \
      "$audio_url?grant=$token" >"$test_root/$stem.out" 2>"$test_root/$stem.err" &
  fi
  printf -v "$variable" '%s' "$!"
  for _ in $(seq 1 30); do
    [ -s "$test_root/$stem.out" ] && break
    sleep 0.1
  done
  kill -0 "${!variable}" 2>/dev/null || fail "$stem protected audio stream ended early"
  [ -s "$test_root/$stem.out" ] || fail "$stem protected audio stream did not establish"
}

wait_closed() {
  local label=$1; shift
  local started ended now elapsed pid all_closed
  started=$(php -r 'echo hrtime(true);')
  ended=0
  for _ in $(seq 1 50); do
    all_closed=1
    for pid in "$@"; do
      if kill -0 "$pid" 2>/dev/null; then all_closed=0; break; fi
    done
    if [ "$all_closed" = 1 ]; then ended=1; break; fi
    sleep 0.1
  done
  now=$(php -r 'echo hrtime(true);')
  elapsed=$(( (now - started) / 1000000 ))
  [ "$ended" = 1 ] || fail "$label did not close protected audio within five seconds"
  for pid in "$@"; do wait "$pid" 2>/dev/null || true; done
  echo "$label revocation: ${elapsed}ms"
}

audio_url=http://127.0.0.1/avian/api/educator-audio.php
code=$(curl -sS --head --max-time 3 -o /dev/null -w '%{http_code}' "$audio_url")
[ "$code" = 405 ] || fail "HEAD returned $code instead of 405"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$audio_url")
[ "$code" = 405 ] || fail "POST returned $code instead of 405"
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-1' "$audio_url")
[ "$code" = 416 ] || fail "Range returned $code instead of 416"
forward_headers=(
  'Forwarded: for=198.51.100.2'
  'X-Forwarded-For: 198.51.100.2'
  'X-Forwarded-Host: public.example'
  'X-Forwarded-Proto: https'
  'X-Forwarded-Port: 443'
  'X-Forwarded-Server: proxy.example'
  'X-Forwarded-Scheme: https'
  'X-Forwarded-Prefix: /public'
  'X-Real-Ip: 198.51.100.2'
  'Cf-Connecting-Ip: 198.51.100.2'
  'Cf-Connecting-IPv6: 2001:db8::2'
  'Cf-Pseudo-IPv4: 192.0.2.2'
  'Cf-Ray: test'
  'Cf-Visitor: {"scheme":"https"}'
)
for header in "${forward_headers[@]}"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -H "$header" "$audio_url")
  [ "$code" = 404 ] || fail "$header audio returned $code instead of 404"
done
code=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: public.example' "$audio_url")
[ "$code" = 404 ] || fail "public Host audio returned $code instead of 404"

mapfile -t first < <(issue_grants - 1)
[ "${#first[@]}" = 2 ] || fail 'could not create the first audio grant'
cookie=${first[0]}
token_a=${first[1]}
if issue_grants "$cookie" 1 forwarded >/dev/null 2>&1; then
  fail 'forwarded authenticated request minted an audio grant'
fi
if issue_grants "$cookie" 1 public-host >/dev/null 2>&1; then
  fail 'public-host authenticated request minted an audio grant'
fi
start_stream stream_a "$cookie" "$token_a" a "$test_root/a.headers"
grep -Eiq '^Cache-Control: private, no-store, max-age=0' "$test_root/a.headers" \
  || fail 'protected stream omitted private no-store caching policy'
grep -Eiq '^Referrer-Policy: no-referrer' "$test_root/a.headers" \
  || fail 'protected stream omitted the no-referrer policy'
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "avian_admin=$cookie" \
  "$audio_url?grant=$token_a")
[ "$code" = 401 ] || fail "reused one-use grant returned $code instead of 401"
for log in /tmp/avian-educator-audio-caddy.log /tmp/avian-educator-audio-fpm.log; do
  ! grep -Fq "$token_a" "$log" || fail "one-use grant leaked into $(basename "$log")"
done

mapfile -t more < <(issue_grants "$cookie" 2)
[ "${#more[@]}" = 3 ] || fail 'could not create slot-limit grants'
token_b=${more[1]}
token_c=${more[2]}
start_stream stream_b "$cookie" "$token_b" b
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "avian_admin=$cookie" \
  "$audio_url?grant=$token_c")
[ "$code" = 429 ] || fail "third protected audio stream returned $code instead of 429"
echo 'Protected audio slot limit: two active, third returned 429.'

write_profile 0 8
wait_closed 'profile disable' "$stream_a" "$stream_b"
stream_a=''
stream_b=''

write_profile 1 9
mapfile -t cross_session < <(issue_grants - 1)
cross_cookie=${cross_session[0]}
cross_token=${cross_session[1]}
mapfile -t other_session < <(issue_grants - 0)
other_cookie=${other_session[0]}
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "avian_admin=$other_cookie" \
  "$audio_url?grant=$cross_token")
[ "$code" = 401 ] || fail "cross-session grant returned $code instead of 401"
start_stream stream_c "$cross_cookie" "$cross_token" cross
mutate_session "$cross_cookie" logout
wait_closed 'logout' "$stream_c"
stream_c=''

mapfile -t idle_session < <(issue_grants - 1)
idle_cookie=${idle_session[0]}
start_stream stream_c "$idle_cookie" "${idle_session[1]}" idle
mutate_session "$idle_cookie" idle
wait_closed 'idle expiry' "$stream_c"
stream_c=''

mapfile -t password_session < <(issue_grants - 1)
password_cookie=${password_session[0]}
start_stream stream_c "$password_cookie" "${password_session[1]}" password
write_admin_state 2 1 "$admin_verifier_b"
wait_closed 'password change' "$stream_c"
stream_c=''

mapfile -t policy_session < <(issue_grants - 1)
policy_cookie=${policy_session[0]}
start_stream stream_c "$policy_cookie" "${policy_session[1]}" policy
write_admin_state 3 0 "$admin_verifier_b"
wait_closed 'LAN password policy disable' "$stream_c"
stream_c=''
write_admin_state 4 1 "$admin_verifier_b"

mapfile -t corrupt_admin_session < <(issue_grants - 1)
corrupt_admin_cookie=${corrupt_admin_session[0]}
start_stream stream_c "$corrupt_admin_cookie" "${corrupt_admin_session[1]}" corrupt-admin
write_corrupt_state /var/lib/avian-visitors/admin-auth.state admin-auth.state
wait_closed 'corrupt admin state' "$stream_c"
stream_c=''
write_admin_state 5 1 "$admin_verifier_b"

mapfile -t corrupt_profile_session < <(issue_grants - 1)
corrupt_profile_cookie=${corrupt_profile_session[0]}
start_stream stream_c "$corrupt_profile_cookie" "${corrupt_profile_session[1]}" corrupt-profile
write_corrupt_state /var/lib/avian-visitors/educators.state educators.state
wait_closed 'corrupt Educators state' "$stream_c"
stream_c=''
write_profile 1 10

mapfile -t epoch_grant < <(issue_grants - 1)
epoch_cookie=${epoch_grant[0]}
epoch_token=${epoch_grant[1]}
write_profile 1 11
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "avian_admin=$epoch_cookie" \
  "$audio_url?grant=$epoch_token")
[ "$code" = 401 ] || fail "stale profile-epoch grant returned $code instead of 401"

mapfile -t expired_grant < <(issue_grants - 1)
expired_cookie=${expired_grant[0]}
expired_token=${expired_grant[1]}
sleep 16
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "avian_admin=$expired_cookie" \
  "$audio_url?grant=$expired_token")
[ "$code" = 401 ] || fail "expired 15-second grant returned $code instead of 401"

echo 'Educators protected audio smoke passed.'
