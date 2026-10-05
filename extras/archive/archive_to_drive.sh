#!/bin/bash
# AvianVisitors: nightly Google Drive archive + optional rolling purge. v3
#
# For every COMPLETED day under ~/BirdSongs/Extracted/By_Date (dates before
# today minus KEEP_DAYS):
#   1. writes two analytics CSVs to <REMOTE>/Analytics/ from a point-in-time
#      SNAPSHOT of birds.db (never holds a lock against the live analyzer),
#      reconciled against the clip count on disk
#   2. uploads only each species' mp3s + spectrogram pngs to
#      <REMOTE>/Recordings/<Species>/  (filenames already carry date+time)
#   3. verifies via rclone check --one-way (Drive stores md5 for all files)
#   4. if PURGE=true: after the whole day verifies, deletes EXACTLY the files
#      that were enumerated before upload, never a blind rm -rf. Directories
#      fall only to rmdir, so anything unexpected (a straggler extraction,
#      a stray file, a dotfile) survives and flags the day for the next run.
#
# Any upload or verification failure leaves that day local. The next night
# retries, and uploads are idempotent. Status: ~/bird-archive/status.
#
# Scope: only dated children of By_Date matching YYYY-MM-DD; symlinks skipped
# at both day and species level; web-root files, cutouts/, Charts/,
# StreamData/, birds.db rows, and BirdDB.txt are never touched.

set -u -o pipefail

CONF="$HOME/bird-archive/archive.conf"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"

REMOTE="${REMOTE:-gdrive:AvianVisitors}"
PURGE="${PURGE:-false}"
KEEP_DAYS="${KEEP_DAYS:-0}"
BY_DATE="${BY_DATE:-$HOME/BirdSongs/Extracted/By_Date}"
DB="${DB:-$HOME/BirdNET-Pi/scripts/birds.db}"
LOG="${LOG:-$HOME/bird-archive/archive.log}"
STATUS="$HOME/bird-archive/status"
TMP="$HOME/bird-archive/tmp"
SNAP="$TMP/birds-snap.db"
RC=(--transfers 4 --checkers 8 --retries 3 --low-level-retries 10
    --contimeout 20s --timeout 5m --stats 0 --log-level ERROR --log-file "$LOG")

if ! mkdir -p "$(dirname "$LOG")" "$TMP"; then
  echo "FATAL: could not create archive working directory" >&2
  exit 1
fi
log()  { echo "$(date -Is) $*" >>"$LOG"; }
sfail(){ echo "FAIL $(date -Is) $*" >"$STATUS"; }
# shellcheck disable=SC2317  # invoked by the EXIT trap
cleanup(){
  rm -f "$SNAP" "$TMP"/*.purge-list "$TMP"/*.analytics-list \
    "$TMP"/*.recordings-list \
    "$TMP"/*-detections.csv "$TMP"/*-summary.csv
}
# shellcheck disable=SC2317  # invoked by the signal traps
on_signal(){
  log "FATAL: archive run interrupted"; sfail interrupted; exit "$1"
}
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# Config validation. A malformed value must not silently no-op the run.
if ! [[ "$KEEP_DAYS" =~ ^[0-9]+$ ]]; then
  log "FATAL: KEEP_DAYS is not a non-negative integer: '$KEEP_DAYS'"; sfail config; exit 1
fi
if [ "$PURGE" != "true" ] && [ "$PURGE" != "false" ]; then
  log "FATAL: PURGE must be true or false: '$PURGE'"; sfail config; exit 1
fi
for command_name in rclone sqlite3 flock timedatectl date find awk wc df sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    log "FATAL: required command is missing: $command_name"; sfail dependency; exit 1
  fi
done
[ -d "$BY_DATE" ] || { log "FATAL: $BY_DATE missing"; sfail layout; exit 1; }
[ -f "$DB" ] || { log "FATAL: $DB missing"; sfail db; exit 1; }

# single-instance lock: a slow upload must never overlap the next run
if ! { exec 9>"$HOME/bird-archive/.lock"; }; then
  log "FATAL: could not open archive lock"; sfail lock; exit 1
fi
if ! flock -n 9; then log "another run still in progress; exiting"; exit 0; fi

# Clock sanity. A Pi 4 has no RTC, so a wrong clock could make today drift.
ntp_ok=0
for _ in $(seq 1 10); do
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] && { ntp_ok=1; break; }
  sleep 30
done
if [ "$ntp_ok" != 1 ]; then log "FATAL: clock not NTP-synchronized"; sfail ntp; exit 1; fi

# Fresh-boot guard. After an outage, Persistent=true fires this at boot while
# the analyzer is still extracting backlog clips INTO yesterday's dir. Wait
# out the first hour of uptime so the backlog drains before we enumerate.
up=$(awk '{print int($1)}' /proc/uptime)
if [ "$up" -lt 3600 ]; then
  log "recent boot (up ${up}s); waiting $((3600 - up))s for analyzer backlog to drain"
  sleep $((3600 - up))
fi

# Patient remote probe for boot-time WiFi, transient DNS, and Drive hiccups.
probe_ok=0
for _ in $(seq 1 20); do
  rclone mkdir "$REMOTE" "${RC[@]}" && { probe_ok=1; break; }
  sleep 60
done
if [ "$probe_ok" != 1 ]; then
  log "FATAL: remote $REMOTE unreachable after 20 attempts (token expired? offline? quota?)"
  sfail remote; exit 1
fi

# cutoff computed ONCE, local time
today=$(date +%F)
if ! cutoff=$(date -d "$today - $KEEP_DAYS day" +%F) || [ -z "$cutoff" ]; then
  log "FATAL: cutoff computation failed"; sfail config; exit 1
fi
log "run start: today=$today cutoff=$cutoff purge=$PURGE remote=$REMOTE"

# ONE point-in-time snapshot of the live DB; all analytics reads hit the copy.
# (.backup yields the lock between pages, so the analyzer's INSERTs never starve)
rm -f "$SNAP"
if ! sqlite3 -cmd ".timeout 3000" "$DB" ".backup '$SNAP'"; then
  log "FATAL: birds.db snapshot failed"; sfail db; exit 1
fi

overall_fail=0
verified_files=0
for daydir in "$BY_DATE"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]; do
  [ -d "$daydir" ] || continue                 # unmatched glob stays literal
  [ -L "$daydir" ] && { log "SKIP symlinked day: $daydir"; continue; }
  day=$(basename "$daydir")
  [[ "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue
  [[ "$day" < "$cutoff" ]] || continue         # ISO dates compare lexically

  day_ok=1
  purge_list="$TMP/$day.purge-list"
  : >"$purge_list"

  # A completed day contains only non-hidden species directories. Enumerate
  # every entry, including dotfiles, before doing any recording work. Anything
  # else keeps the whole day pending and can never enter an rclone source set.
  declare -A day_entries_before=()
  species_dirs=()
  mapfile -d '' -t day_entries < <(find "$daydir" -mindepth 1 -maxdepth 1 -print0)
  for day_entry in "${day_entries[@]}"; do
    day_entries_before["$day_entry"]=1
    entry_name=${day_entry##*/}
    if [[ "$entry_name" == .* ]] || [ -L "$day_entry" ] || [ ! -d "$day_entry" ]; then
      printf -v entry_display '%q' "$day_entry"
      log "ERROR: unexpected day entry retained: $entry_display"
      day_ok=0
      continue
    fi
    species_dirs+=("$day_entry")
  done

  # ---- 1. analytics from the snapshot, reconciled against disk ----
  det_csv="$TMP/$day-detections.csv"
  sum_csv="$TMP/$day-summary.csv"
  analytics_list="$TMP/$day.analytics-list"
  sqlite3 -readonly -csv -header "$SNAP" \
    "SELECT Date, Time, Sci_Name, Com_Name, Confidence, File_Name
     FROM detections WHERE Date = '$day' ORDER BY Time;" >"$det_csv" \
    || { log "ERROR: detections query failed $day"; day_ok=0; }
  sqlite3 -readonly -csv -header "$SNAP" \
    "SELECT Com_Name, Sci_Name, COUNT(*) AS detections, MIN(Time) AS first_heard,
            MAX(Time) AS last_heard, ROUND(MAX(Confidence),4) AS max_confidence
     FROM detections WHERE Date = '$day'
     GROUP BY Sci_Name, Com_Name ORDER BY detections DESC;" >"$sum_csv" \
    || { log "ERROR: summary query failed $day"; day_ok=0; }
  if [ "$day_ok" = 1 ]; then
    # every clip on disk implies a DB row; fewer CSV rows than clips means the
    # analytics are incomplete. Never purge a day whose stats did not export.
    mp3s=$(find "$daydir" -mindepth 2 -maxdepth 2 -type f -name '*.mp3' | wc -l)
    rows=$(wc -l <"$det_csv"); [ "$rows" -gt 0 ] && rows=$((rows - 1))  # minus header
    if [ "$rows" -lt "$mp3s" ]; then
      log "ERROR: $day analytics rows ($rows) < clips on disk ($mp3s); retaining"
      day_ok=0
    fi
  fi
  if [ "$day_ok" = 1 ] && [ "${rows:-0}" -gt 0 ]; then
    printf '%s\n' "$(basename "$det_csv")" "$(basename "$sum_csv")" >"$analytics_list"
    if ! rclone copy "$det_csv" "$REMOTE/Analytics" "${RC[@]}" \
      || ! rclone copy "$sum_csv" "$REMOTE/Analytics" "${RC[@]}"; then
      log "ERROR: analytics upload failed $day"; day_ok=0
    elif ! rclone check "$TMP" "$REMOTE/Analytics" --one-way \
      --files-from "$analytics_list" "${RC[@]}"; then
      log "ERROR: analytics verify failed $day"; day_ok=0
    fi
  fi
  rm -f "$det_csv" "$sum_csv" "$analytics_list"

  # ---- 2+3. per-species: enumerate -> upload -> verify. Deletion is
  #      deferred until every species in the day has verified. ----
  files_done=0
  for sp_path in "${species_dirs[@]}"; do
    sp=${sp_path##*/}
    files_from="$TMP/$day.recordings-list"
    : >"$files_from"
    flist=()
    declare -A species_entries_before=()
    mapfile -d '' -t species_entries < <(find "$sp_path" -mindepth 1 -maxdepth 1 -print0)
    for species_entry in "${species_entries[@]}"; do
      species_entries_before["$species_entry"]=1
      entry_name=${species_entry##*/}
      if [ -f "$species_entry" ] && [ ! -L "$species_entry" ] \
        && [[ "$entry_name" != .* ]] \
        && { [[ "$entry_name" == *.mp3 ]] || [[ "$entry_name" == *.png ]]; } \
        && [[ "$entry_name" != *$'\n'* ]]; then
        flist+=("$species_entry")
        printf '%s\n' "$entry_name" >>"$files_from"
      else
        printf -v entry_display '%q' "$species_entry"
        log "ERROR: unexpected recording entry retained: $entry_display"
        day_ok=0
      fi
    done
    if [ "${#flist[@]}" -eq 0 ]; then
      rm -f "$files_from"
      continue
    fi
    declare -A before_hash=()
    hash_ok=1
    for local_file in "${flist[@]}"; do
      if ! hash_line=$(sha256sum -- "$local_file"); then
        log "ERROR: could not fingerprint $day/$sp before upload"
        hash_ok=0
        break
      fi
      before_hash["$local_file"]=${hash_line:0:64}
    done
    if [ "$hash_ok" != 1 ]; then
      day_ok=0
      rm -f "$files_from"
      continue
    fi
    if ! rclone copy "$sp_path" "$REMOTE/Recordings/$sp" \
      --files-from-raw "$files_from" "${RC[@]}"; then
      log "ERROR: upload failed $day/$sp"; day_ok=0; rm -f "$files_from"; continue
    fi
    if ! rclone check "$sp_path" "$REMOTE/Recordings/$sp" --one-way \
      --files-from-raw "$files_from" "${RC[@]}"; then
      log "ERROR: verify failed $day/$sp"; day_ok=0; rm -f "$files_from"; continue
    fi
    rm -f "$files_from"
    for local_file in "${flist[@]}"; do
      if [ ! -f "$local_file" ] || ! hash_line=$(sha256sum -- "$local_file") \
        || [ "${hash_line:0:64}" != "${before_hash[$local_file]}" ]; then
        log "ERROR: recording changed during archive $day/$sp; retaining the day"
        hash_ok=0
        break
      fi
    done
    # A file created after the first enumeration was not in the upload list.
    # Keep the day intact instead of claiming a complete archive or deleting
    # the files that were present before the race.
    mapfile -d '' -t species_entries_after < <(find "$sp_path" -mindepth 1 -maxdepth 1 -print0)
    for species_entry in "${species_entries_after[@]}"; do
      if [ -z "${species_entries_before["$species_entry"]+present}" ]; then
        printf -v entry_display '%q' "$species_entry"
        log "ERROR: recording entry appeared during archive: $entry_display"
        hash_ok=0
      fi
    done
    if [ "$hash_ok" != 1 ]; then
      day_ok=0
      continue
    fi
    files_done=$((files_done + ${#flist[@]}))
    printf '%s\0' "${flist[@]}" >>"$purge_list"
  done

  # Catch a new top-level entry or species directory created after the day's
  # initial enumeration. It was never eligible for this run.
  mapfile -d '' -t day_entries_after < <(find "$daydir" -mindepth 1 -maxdepth 1 -print0)
  for day_entry in "${day_entries_after[@]}"; do
    if [ -z "${day_entries_before["$day_entry"]+present}" ]; then
      printf -v entry_display '%q' "$day_entry"
      log "ERROR: day entry appeared during archive: $entry_display"
      day_ok=0
    fi
  done

  # ---- day wrap-up ----
  if [ "$day_ok" = 1 ] && [ "$files_done" -gt 0 ]; then
    log "OK: $day archived & verified ($files_done files)"
    verified_files=$((verified_files + files_done))
    if [ "$PURGE" = "true" ]; then
      mapfile -d '' -t purge_files <"$purge_list"
      if [ "${#purge_files[@]}" -gt 0 ] && ! rm -- "${purge_files[@]}"; then
        log "ERROR: delete failed $day; verified files that remain will retry"
        overall_fail=1
      fi
      # rmdir only removes empty directories. Files created after enumeration
      # survive and keep their directory for the next run.
      find "$daydir" -mindepth 1 -maxdepth 1 -type d -exec rmdir -- {} \; 2>/dev/null || true
      if rmdir -- "$daydir" 2>/dev/null; then
        log "PURGED: $day"
      else
        log "RETAINED: $day not empty after purge (unarchived leftovers kept)"; overall_fail=1
      fi
    fi
  elif [ "$day_ok" = 1 ]; then
    log "NOTE: $day contained no archivable files"
    if [ "$PURGE" = "true" ]; then
      find "$daydir" -mindepth 1 -maxdepth 1 -type d -exec rmdir -- {} \; 2>/dev/null || true
      if rmdir -- "$daydir" 2>/dev/null; then
        log "PURGED empty: $day"
      else
        log "RETAINED: $day contains unarchived entries"; overall_fail=1
      fi
    fi
  else
    log "RETAINED: $day had failures; nothing deleted, retrying next night"; overall_fail=1
  fi
done

rm -f "$SNAP"

if [ "$overall_fail" = 0 ]; then
  echo "OK $(date -Is) verified_files=$verified_files" >"$STATUS"
else
  sfail "see archive.log"
fi
log "run complete (fail=$overall_fail); disk: $(df -h "$BY_DATE" | awk 'NR==2{print $5" used, "$4" free"}')"
exit "$overall_fail"
