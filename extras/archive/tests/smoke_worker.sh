#!/usr/bin/env bash
# Run inside a disposable Debian container with the repository at /source.
# Exercises the archive worker against a local fake Drive. No network, OAuth,
# systemd, or host files are involved.

set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

root=/tmp/archive-worker-test
test_bin=$root/bin
remote_root=$root/remote
mkdir -p "$test_bin" "$remote_root"

cat >"$test_bin/timedatectl" <<'EOF'
#!/bin/sh
if [ "$1" = show ]; then
  echo yes
  exit 0
fi
exit 2
EOF

# A fresh Docker VM has less than an hour of uptime, which correctly activates
# the production backlog-drain delay. This matrix is not a boot-timing test, so
# report a stable host only for the worker's exact /proc/uptime read.
cat >"$test_bin/awk" <<'EOF'
#!/bin/sh
if [ "${2:-}" = /proc/uptime ]; then
  echo 7200
  exit 0
fi
exec /usr/bin/awk "$@"
EOF

cat >"$test_bin/rclone" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

map_remote() {
  case "$1" in
    gdrive:*) printf '%s/%s' "$ARCHIVE_FAKE_REMOTE" "${1#gdrive:}" ;;
    *) printf '%s' "$1" ;;
  esac
}

command_name=$1
shift
case "$command_name" in
  mkdir)
    mkdir -p "$(map_remote "$1")"
    ;;
  copy)
    source_path=$1
    target_path=$(map_remote "$2")
    shift 2
    files_from=''
    while [ $# -gt 0 ]; do
      case "$1" in
        --files-from|--files-from-raw)
          files_from=$2
          shift 2
          ;;
        *) shift ;;
      esac
    done
    mkdir -p "$target_path"
    if [ -d "$source_path" ]; then
      if [ "${RCLONE_ADD_STRAGGLER:-0}" = 1 ] && [ ! -e "$ARCHIVE_FAKE_REMOTE/.straggler-added" ]; then
        printf 'late\n' >"$source_path/late.mp3"
        touch "$ARCHIVE_FAKE_REMOTE/.straggler-added"
      fi
      if [ -n "$files_from" ]; then
        while IFS= read -r relative; do
          [ -n "$relative" ] || continue
          mkdir -p "$target_path/$(dirname "$relative")"
          cp -- "$source_path/$relative" "$target_path/$relative"
        done <"$files_from"
      else
        cp -R "$source_path"/. "$target_path"/
      fi
    else
      cp "$source_path" "$target_path"/
    fi
    ;;
  check)
    [ "${RCLONE_FAIL_CHECK:-0}" != 1 ] || exit 9
    source_path=$1
    target_path=$(map_remote "$2")
    shift 2
    files_from=''
    while [ $# -gt 0 ]; do
      if [ "$1" = --files-from ] || [ "$1" = --files-from-raw ]; then
        files_from=$2
        shift 2
      else
        shift
      fi
    done
    if [ -n "$files_from" ]; then
      while IFS= read -r relative; do
        [ -n "$relative" ] || continue
        cmp "$source_path/$relative" "$target_path/$relative"
      done <"$files_from"
    else
      while IFS= read -r -d '' local_file; do
        cmp "$local_file" "$target_path/$(basename "$local_file")"
      done < <(find "$source_path" -mindepth 1 -maxdepth 1 -type f -print0)
    fi
    if [ "${RCLONE_MUTATE_FILE:-0}" = 1 ] && [ -f "$source_path/call.mp3" ]; then
      printf 'changed after verification\n' >"$source_path/call.mp3"
    fi
    ;;
  *)
    echo "unexpected rclone command: $command_name" >&2
    exit 2
    ;;
esac
EOF
chmod 0755 "$test_bin/timedatectl" "$test_bin/awk" "$test_bin/rclone"
export PATH="$test_bin:/usr/bin:/bin"
export ARCHIVE_FAKE_REMOTE=$remote_root

make_case() {
  case_name=$1
  day=$2
  purge=$3
  case_home=$root/$case_name/home
  case_archive=$case_home/bird-archive
  case_dates=$case_home/BirdSongs/Extracted/By_Date
  case_db=$case_home/BirdNET-Pi/scripts/birds.db
  mkdir -p "$case_archive" "$case_dates/$day/American_Crow" "$(dirname "$case_db")"
  cp /source/extras/archive/archive_to_drive.sh "$case_archive/archive_to_drive.sh"
  chmod 0755 "$case_archive/archive_to_drive.sh"
  printf 'audio\n' >"$case_dates/$day/American_Crow/call.mp3"
  printf 'image\n' >"$case_dates/$day/American_Crow/call.png"
  sqlite3 "$case_db" <<EOF
CREATE TABLE detections (
  Date TEXT, Time TEXT, Sci_Name TEXT, Com_Name TEXT,
  Confidence REAL, File_Name TEXT
);
INSERT INTO detections VALUES
  ('$day', '08:15:00', 'Corvus brachyrhynchos', 'American Crow', 0.91, 'call.mp3');
EOF
  cat >"$case_archive/archive.conf" <<EOF
REMOTE=gdrive:AvianVisitors-$case_name
PURGE=$purge
KEEP_DAYS=0
BY_DATE=$case_dates
DB=$case_db
LOG=$case_archive/archive.log
EOF
  printf '%s' "$case_home"
}

safe_home=$(make_case safe 2000-01-01 false)
safe_species=$safe_home/BirdSongs/Extracted/By_Date/2000-01-01/American_Crow
printf 'spaced audio\n' >"$safe_species/call with space.mp3"
printf 'spaced image\n' >"$safe_species/call with space.mp3.png"
sqlite3 "$safe_home/BirdNET-Pi/scripts/birds.db" \
  "INSERT INTO detections VALUES ('2000-01-01', '08:16:00', 'Corvus brachyrhynchos', 'American Crow', 0.90, 'call with space.mp3');"
HOME=$safe_home "$safe_home/bird-archive/archive_to_drive.sh"
[ -f "$safe_home/BirdSongs/Extracted/By_Date/2000-01-01/American_Crow/call.mp3" ] \
  || fail "safe mode removed a recording"
[ -f "$remote_root/AvianVisitors-safe/Recordings/American_Crow/call.mp3" ] \
  || fail "safe mode did not upload a recording"
if ! { [ -f "$remote_root/AvianVisitors-safe/Recordings/American_Crow/call with space.mp3" ] \
  && [ -f "$remote_root/AvianVisitors-safe/Recordings/American_Crow/call with space.mp3.png" ]; }; then
  fail "safe mode did not preserve spaces in recording names"
fi
[ -f "$remote_root/AvianVisitors-safe/Analytics/2000-01-01-detections.csv" ] \
  || fail "safe mode did not upload detections analytics"
[ -f "$remote_root/AvianVisitors-safe/Analytics/2000-01-01-summary.csv" ] \
  || fail "safe mode did not upload summary analytics"
grep -q '^OK .*verified_files=4$' "$safe_home/bird-archive/status" \
  || fail "safe mode status"
HOME=$safe_home "$safe_home/bird-archive/archive_to_drive.sh"
grep -q '^OK .*verified_files=4$' "$safe_home/bird-archive/status" \
  || fail "idempotent safe rerun"

purge_home=$(make_case purge 2000-01-02 true)
HOME=$purge_home "$purge_home/bird-archive/archive_to_drive.sh"
[ ! -e "$purge_home/BirdSongs/Extracted/By_Date/2000-01-02" ] \
  || fail "verified purge left the completed day"
grep -q '^OK .*verified_files=2$' "$purge_home/bird-archive/status" \
  || fail "purge status"

failure_home=$(make_case failure 2000-01-03 true)
if HOME=$failure_home RCLONE_FAIL_CHECK=1 "$failure_home/bird-archive/archive_to_drive.sh"; then
  fail "remote verification failure returned success"
fi
[ -f "$failure_home/BirdSongs/Extracted/By_Date/2000-01-03/American_Crow/call.mp3" ] \
  || fail "verification failure removed a recording"
grep -q '^FAIL ' "$failure_home/bird-archive/status" \
  || fail "verification failure status"

straggler_home=$(make_case straggler 2000-01-04 true)
if HOME=$straggler_home RCLONE_ADD_STRAGGLER=1 "$straggler_home/bird-archive/archive_to_drive.sh"; then
  fail "late file did not keep the day pending"
fi
[ -f "$straggler_home/BirdSongs/Extracted/By_Date/2000-01-04/American_Crow/late.mp3" ] \
  || fail "late file was removed"
[ -f "$straggler_home/BirdSongs/Extracted/By_Date/2000-01-04/American_Crow/call.mp3" ] \
  || fail "late file allowed an incomplete day purge"
[ ! -e "$remote_root/AvianVisitors-straggler/Recordings/American_Crow/late.mp3" ] \
  || fail "late unenumerated file was uploaded"
grep -q '^FAIL ' "$straggler_home/bird-archive/status" \
  || fail "late-file retention status"

unknown_home=$(make_case unknown 2000-01-07 true)
unknown_species=$unknown_home/BirdSongs/Extracted/By_Date/2000-01-07/American_Crow
unknown_day=$unknown_home/BirdSongs/Extracted/By_Date/2000-01-07
printf 'private note\n' >"$unknown_species/notes with spaces.txt"
printf 'hidden\n' >"$unknown_species/.secret.mp3"
newline_file=$unknown_species/$'line\nbreak.mp3'
printf 'newline\n' >"$newline_file"
mkdir "$unknown_species/nested"
printf 'nested audio\n' >"$unknown_species/nested/inside.mp3"
ln -s call.mp3 "$unknown_species/alias.mp3"
mkfifo "$unknown_species/pipe.mp3"
printf 'loose audio\n' >"$unknown_day/loose.mp3"
printf 'day metadata\n' >"$unknown_day/.day-note"
if HOME=$unknown_home "$unknown_home/bird-archive/archive_to_drive.sh"; then
  fail "unexpected entries did not keep the day pending"
fi
if ! { [ -f "$unknown_species/call.mp3" ] && [ -f "$unknown_species/call.png" ]; }; then
  fail "unexpected entries allowed recording cleanup"
fi
if ! { [ -f "$unknown_species/notes with spaces.txt" ] && [ -f "$unknown_species/.secret.mp3" ] \
  && [ -f "$newline_file" ] && [ -f "$unknown_species/nested/inside.mp3" ] \
  && [ -L "$unknown_species/alias.mp3" ] && [ -f "$unknown_day/loose.mp3" ] \
  && [ -p "$unknown_species/pipe.mp3" ] && [ -f "$unknown_day/.day-note" ]; }; then
  fail "an unexpected local entry was removed"
fi
unknown_remote=$remote_root/AvianVisitors-unknown/Recordings/American_Crow
if ! { [ -f "$unknown_remote/call.mp3" ] && [ -f "$unknown_remote/call.png" ]; }; then
  fail "allowlisted recordings were not archived"
fi
[ "$(find "$unknown_remote" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 2 ] \
  || fail "an unexpected entry reached Drive"
if ! { [ ! -e "$unknown_remote/notes with spaces.txt" ] && [ ! -e "$unknown_remote/.secret.mp3" ] \
  && [ ! -e "$unknown_remote/nested/inside.mp3" ] && [ ! -e "$unknown_remote/alias.mp3" ] \
  && [ ! -e "$unknown_remote/pipe.mp3" ]; }; then
  fail "an explicitly unexpected entry reached Drive"
fi
grep -q '^FAIL ' "$unknown_home/bird-archive/status" \
  || fail "unexpected-entry retention status"

changed_home=$(make_case changed 2000-01-06 true)
if HOME=$changed_home RCLONE_MUTATE_FILE=1 "$changed_home/bird-archive/archive_to_drive.sh"; then
  fail "changed recording returned success"
fi
[ -f "$changed_home/BirdSongs/Extracted/By_Date/2000-01-06/American_Crow/call.mp3" ] \
  || fail "changed recording was removed"
grep -q '^FAIL ' "$changed_home/bird-archive/status" \
  || fail "changed recording status"

config_home=$(make_case config 2000-01-05 false)
sed -i 's/^PURGE=false$/PURGE=perhaps/' "$config_home/bird-archive/archive.conf"
if HOME=$config_home "$config_home/bird-archive/archive_to_drive.sh"; then
  fail "invalid purge value returned success"
fi
[ -f "$config_home/BirdSongs/Extracted/By_Date/2000-01-05/American_Crow/call.mp3" ] \
  || fail "invalid config removed a recording"
grep -q '^FAIL .*config' "$config_home/bird-archive/status" \
  || fail "invalid config status"

echo 'archive worker smoke: ok'
