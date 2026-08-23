#!/usr/bin/env bash
# Focused validation for the Atlas illustration generation endpoint.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v flock >/dev/null 2>&1 || fail "flock is required for this smoke test"

work=$(mktemp -d "${TMPDIR:-/tmp}/avian-generate-test.XXXXXX")
fixture="$work/station"
worker_log="$work/workers.log"
nohup_argv="$work/nohup-argv.txt"
nohup_env="$work/nohup-env.txt"
ps_snapshot="$work/ps.txt"
server_log="$work/server.log"
test_key='generator-key-that-must-never-appear-in-argv-4f881d6e'
server_pid=
locker_pid=

cleanup() {
  if [ -n "$locker_pid" ]; then
    kill "$locker_pid" 2>/dev/null || true
    wait "$locker_pid" 2>/dev/null || true
  fi
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

mkdir -p \
  "$fixture/avian/api" \
  "$fixture/avian/assets/illustrations" \
  "$fixture/avian/scripts" \
  "$fixture/scripts" \
  "$fixture/birdnet/bin"
cp avian/api/admin-auth.php "$fixture/avian/api/admin-auth.php"
cp avian/api/generate.php "$fixture/avian/api/generate.php"

printf 'GEMINI_API_KEY="%s"\n' "$test_key" >"$fixture/birdnet.conf"
printf '%s\n' '# test worker path' >"$fixture/avian/scripts/generate_one.py"
sqlite3 "$fixture/scripts/birds.db" <<'SQL'
CREATE TABLE detections (Sci_Name TEXT, Com_Name TEXT, Date TEXT);
INSERT INTO detections VALUES ('Calypte anna', 'Anna''s Hummingbird', '2026-08-18');
SQL

cat >"$fixture/birdnet/bin/python3" <<'SH'
#!/bin/sh
exec 7<>"$AVIAN_GENERATION_LOCK"
flock 7
printf '%s\n' "$*" >>"$FAKE_WORKER_LOG"
sleep 2
SH
chmod 0755 "$fixture/birdnet/bin/python3"

mkdir -p "$work/bin"
cat >"$work/bin/nohup" <<'SH'
#!/bin/sh
printf '%s\n' "$@" >"$FAKE_NOHUP_ARGV"
printf '%s' "$GEMINI_API_KEY" >"$FAKE_NOHUP_ENV"
ps -axo command= >"$FAKE_PS_SNAPSHOT"
sleep 1
exec "$@"
SH
chmod 0755 "$work/bin/nohup"

# The release-test image intentionally omits php-sqlite3. The production
# query is outside this test's scope, so provide its one expected row there.
cat >"$work/sqlite-prepend.php" <<'PHP'
<?php
if (!class_exists('SQLite3')) {
    define('SQLITE3_OPEN_READONLY', 1);
    define('SQLITE3_TEXT', 3);
    define('SQLITE3_ASSOC', 1);
    class SQLite3 {
        public function __construct(string $path, int $flags) {}
        public function busyTimeout(int $milliseconds): bool { return true; }
        public function prepare(string $query): SQLite3Stmt { return new SQLite3Stmt(); }
        public function close(): bool { return true; }
    }
    class SQLite3Stmt {
        public function bindValue(string $name, mixed $value, int $type): bool { return true; }
        public function execute(): SQLite3Result { return new SQLite3Result(); }
    }
    class SQLite3Result {
        public function fetchArray(int $mode): array {
            return ['Com_Name' => "Anna's Hummingbird"];
        }
    }
}
PHP

port=$(php -r '
  $socket = stream_socket_server("tcp://127.0.0.1:0", $errno, $error);
  if ($socket === false) exit(1);
  $name = stream_socket_get_name($socket, false);
  echo substr(strrchr($name, ":"), 1);
')
[ -n "$port" ] || fail "could not reserve a local port"
base="http://127.0.0.1:$port/avian/api/generate.php"

PATH="$work/bin:$PATH" \
FAKE_WORKER_LOG="$worker_log" \
FAKE_NOHUP_ARGV="$nohup_argv" \
FAKE_NOHUP_ENV="$nohup_env" \
FAKE_PS_SNAPSHOT="$ps_snapshot" \
AVIAN_GENERATION_LOCK="$fixture/avian/assets/illustrations/.generate.lock" \
PHP_CLI_SERVER_WORKERS=8 \
  php -d "auto_prepend_file=$work/sqlite-prepend.php" \
  -S "127.0.0.1:$port" -t "$fixture" >"$server_log" 2>&1 &
server_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 2 "$base?action=status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
curl -fsS --max-time 2 "$base?action=status" >/dev/null \
  || fail "PHP test server did not start: $(cat "$server_log")"

post_case() {
  local label=$1 expected_code=$2 expected_text=$3 payload=$4
  local response="$work/response.json"
  local code
  code=$(curl -sS --max-time 5 -o "$response" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -H 'X-Avian-Action: 1' \
    --data-binary "$payload" \
    "$base?action=start")
  if [ "$code" != "$expected_code" ]; then
    fail "$label returned HTTP $code, expected $expected_code: $(cat "$response"); server: $(tail -n 8 "$server_log")"
  fi
  grep -Fq "$expected_text" "$response" \
    || fail "$label returned the wrong body: $(cat "$response")"
}

post_case "malformed JSON" 400 'invalid JSON body' '{'
post_case "array body" 400 'JSON object required' '[]'
post_case "scalar body" 400 'JSON object required' '"Calypte anna"'
post_case "unknown field" 400 'unexpected field' \
  '{"sci":"Calypte anna","extra":true}'
post_case "non-string species" 400 'bad sci name' '{"sci":42}'
post_case "string force" 400 'force must be boolean' \
  '{"sci":"Calypte anna","force":"false"}'
post_case "null force" 400 'force must be boolean' \
  '{"sci":"Calypte anna","force":null}'
[ ! -s "$worker_log" ] || fail "an invalid request started a worker"

lock="$fixture/avian/assets/illustrations/.generate.lock"
lock_ready="$work/lock.ready"
php -r '
  $handle = fopen($argv[1], "c");
  if ($handle === false || !flock($handle, LOCK_EX)) exit(1);
  file_put_contents($argv[2], "ready\n");
  sleep(10);
' "$lock" "$lock_ready" &
locker_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$lock_ready" ] && break
  sleep 0.1
done
[ -s "$lock_ready" ] || fail "could not hold the generation lock"
post_case "held generation lock" 409 'busy' '{"sci":"Calypte anna"}'
[ ! -e "$fixture/avian/assets/illustrations/.generate.state.json" ] \
  || fail "lock contention changed generation state"
[ ! -e "$fixture/avian/assets/illustrations/.generate.starts" ] \
  || fail "lock contention changed rate-limit state"
[ ! -s "$worker_log" ] || fail "lock contention started a worker"
kill "$locker_pid"
wait "$locker_pid" 2>/dev/null || true
locker_pid=

printf '%s\n' '{' >"$fixture/avian/assets/illustrations/.generate.state.json"
post_case "corrupt running state" 500 'generation state unavailable' \
  '{"sci":"Calypte anna"}'
rm -f "$fixture/avian/assets/illustrations/.generate.state.json"
printf '%s\n' 'not-a-timestamp' >"$fixture/avian/assets/illustrations/.generate.starts"
post_case "corrupt rate-limit state" 500 'generation state unavailable' \
  '{"sci":"Calypte anna"}'
rm -f "$fixture/avian/assets/illustrations/.generate.starts"
[ ! -s "$worker_log" ] || fail "corrupt state started a worker"

request_count=16
pids=()
for i in $(seq 1 "$request_count"); do
  (
    code=$(curl -sS --max-time 8 -o "$work/parallel-body.$i" -w '%{http_code}' \
      -H 'Content-Type: application/json' \
      -H 'X-Avian-Action: 1' \
      --data-binary '{"sci":"Calypte anna","force":false}' \
      "$base?action=start")
    printf '%s\n' "$code" >"$work/parallel-code.$i"
  ) &
  pids+=("$!")
done
for pid in "${pids[@]}"; do
  wait "$pid" || fail "parallel request failed"
done

accepted=$(awk '$0 == "200" { count++ } END { print count + 0 }' "$work"/parallel-code.*)
busy=$(awk '$0 == "409" { count++ } END { print count + 0 }' "$work"/parallel-code.*)
if [ "$accepted" -ne 1 ] || [ "$busy" -ne $((request_count - 1)) ]; then
  echo "parallel codes:" >&2
  paste "$work"/parallel-code.* >&2
  echo "generation state:" >&2
  cat "$fixture/avian/assets/illustrations/.generate.state.json" >&2 || true
  echo "server log:" >&2
  tail -n 40 "$server_log" >&2
  fail "parallel requests produced $accepted accepted starts and $busy busy responses"
fi

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$nohup_argv" ] && [ -s "$nohup_env" ] && [ -s "$ps_snapshot" ] && break
  sleep 0.1
done
[ "$(cat "$nohup_env")" = "$test_key" ] \
  || fail "the worker did not receive the API key through its environment"
case "$(cat "$nohup_argv")" in
  *"$test_key"*) fail "the API key appeared in the worker argv" ;;
esac
case "$(cat "$ps_snapshot")" in
  *"$test_key"*) fail "the API key appeared in the process table" ;;
esac

for i in $(seq 1 "$request_count"); do
  code=$(cat "$work/parallel-code.$i")
  if [ "$code" = 200 ]; then
    grep -Fq '"ok":true' "$work/parallel-body.$i" \
      || fail "accepted request did not report success"
  else
    grep -Fq '"error":"busy"' "$work/parallel-body.$i" \
      || fail "rejected parallel request did not report busy"
  fi
done

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$worker_log" ] && break
  sleep 0.1
done
[ -s "$worker_log" ] || fail "accepted request did not start a worker"
[ "$(wc -l <"$worker_log" | tr -d ' ')" -eq 1 ] \
  || fail "parallel requests started more than one worker"
if flock -n "$lock" true; then
  fail "spawned worker did not retain the generation lock"
fi
[ "$(wc -l <"$fixture/avian/assets/illustrations/.generate.starts" | tr -d ' ')" -eq 1 ] \
  || fail "parallel requests recorded more than one start"
php -r '
  $state = json_decode(file_get_contents($argv[1]), true, 16, JSON_THROW_ON_ERROR);
  if (($state["running"] ?? null) !== true
      || ($state["sci"] ?? null) !== "Calypte anna"
      || ($state["step"] ?? null) !== "starting") exit(1);
' "$fixture/avian/assets/illustrations/.generate.state.json" \
  || fail "accepted request wrote invalid state"
if find "$fixture/avian/assets/illustrations" -maxdepth 1 -name '.generate.*.tmp.*' -print -quit \
    | grep -q .; then
  fail "atomic write left a temporary file"
fi

sleep 2
: >"$worker_log"
rm -f \
  "$fixture/avian/assets/illustrations/.generate.state.json" \
  "$fixture/avian/assets/illustrations/.generate.starts"
post_case "boolean force" 200 '"ok":true' \
  '{"sci":"Calypte anna","force":true}'
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$worker_log" ] && break
  sleep 0.1
done
grep -Fq -- '--force' "$worker_log" \
  || fail "boolean force was not passed to the worker"

sleep 3
: >"$worker_log"
before_state="$work/before-state.json"
before_starts="$work/before-starts"
printf '%s\n' '{"running":false,"sci":"Calypte anna","at":1787110000}' \
  >"$fixture/avian/assets/illustrations/.generate.state.json"
printf '%s\n' '1787110000' \
  >"$fixture/avian/assets/illustrations/.generate.starts"
cp "$fixture/avian/assets/illustrations/.generate.state.json" "$before_state"
cp "$fixture/avian/assets/illustrations/.generate.starts" "$before_starts"
rm -f "$fixture/avian/assets/illustrations/.generate.log"
mkdir "$fixture/avian/assets/illustrations/.generate.log"
post_case "failed spawn" 500 'could not start generator' \
  '{"sci":"Calypte anna"}'
cmp -s "$before_state" "$fixture/avian/assets/illustrations/.generate.state.json" \
  || fail "failed spawn did not restore generation state"
cmp -s "$before_starts" "$fixture/avian/assets/illustrations/.generate.starts" \
  || fail "failed spawn did not restore rate-limit state"
[ ! -s "$worker_log" ] || fail "failed spawn started a worker"

echo "generate api smoke: ok"
