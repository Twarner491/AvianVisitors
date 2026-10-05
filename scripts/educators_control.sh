#!/usr/bin/env bash
# Root-owned lifecycle control for the optional Educators profile.

set -euo pipefail
IFS=$'\n\t'
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
umask 077

readonly FIXED_HELPER=/usr/local/sbin/avian-educators
readonly CADDY_REFRESH=/usr/local/sbin/avian-caddy-refresh
readonly AUTH_DIR=/var/lib/avian-visitors
readonly AUTH_LOCK=$AUTH_DIR/admin-auth.lock
readonly PROFILE_LOCK=$AUTH_DIR/educators.lock
readonly BACKUP_LOCK=$AUTH_DIR/educators-backup.lock
readonly PROFILE_STATE=$AUTH_DIR/educators.state
readonly MAINTENANCE_STATE=$AUTH_DIR/educators.maintenance
readonly DATA_DIR=$AUTH_DIR/educators
readonly PROFILE_DB=$DATA_DIR/educators.db
readonly BACKUP_ROOT=$AUTH_DIR/educator-backups
readonly AUDIO_SLOT_0=$AUTH_DIR/educator-audio-0.lock
readonly AUDIO_SLOT_1=$AUTH_DIR/educator-audio-1.lock
readonly EPOCH_MAX=2147483647

fail() {
  printf 'Educators control stopped: %s\n' "$*" >&2
  exit 1
}

safe_root_helper() {
  local helper=$1
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$helper")" = '0:0:755:1' ]
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  safe_root_helper "$FIXED_HELPER" \
    || fail "root-owned helper is missing or unsafe: $FIXED_HELPER"
  exec sudo "$FIXED_HELPER" "$@"
fi

[ "$(readlink -f -- "$0")" = "$FIXED_HELPER" ] \
  || fail "root actions must use $FIXED_HELPER"
safe_root_helper "$FIXED_HELPER" \
  || fail "root-owned helper is unsafe: $FIXED_HELPER"

profile_temp=''
maintenance_state_temp=''
maintenance_token=''
maintenance_work=''
pair_temp=''
restore_active=0
restore_mode=''
restore_birds_old=''
restore_educators_old=''
restore_by_date_old=''
restore_charts_old=''
cleanup() {
  local status=$? rollback_status=0 cleanup_maintenance_status=0
  trap - EXIT INT TERM HUP
  if [ "${restore_active:-0}" = 1 ]; then
    read_maintenance_state || cleanup_maintenance_status=$?
    if [ "$cleanup_maintenance_status" = 0 ] \
      && [ "$MAINTENANCE_MODE" = "$restore_mode" ]; then
      rollback_restore || rollback_status=$?
      if [ "$rollback_status" = 0 ]; then
        remove_maintenance_state "$restore_mode" || true
      fi
    fi
  fi
  rm -f -- "${profile_temp:-}"
  rm -f -- "${maintenance_state_temp:-}"
  if [ -n "${maintenance_token:-}" ]; then
    case "$maintenance_token" in "$AUTH_DIR"/.educators-maintenance.*)
      rm -f -- "$maintenance_token"
      ;;
    esac
  fi
  if [ -n "${maintenance_work:-}" ]; then
    case "$maintenance_work" in "$DATA_DIR"/.maintenance.*|"$AUTH_DIR"/.educators-work.*)
      rm -f -- "$maintenance_work/birds.db" "$maintenance_work/educators.db" \
        "$maintenance_work/educators.db-wal" "$maintenance_work/educators.db-shm"
      rmdir -- "$maintenance_work" 2>/dev/null || true
      ;;
    esac
  fi
  if [ -n "${pair_temp:-}" ]; then
    case "$pair_temp" in "$BACKUP_ROOT"/.pair.*)
      rm -f -- "$pair_temp/birds.db" "$pair_temp/educators.db" \
        "$pair_temp/educators.db-wal" "$pair_temp/educators.db-shm"
      rmdir -- "$pair_temp" 2>/dev/null || true
      ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

parse_conf_raw() {
  local raw=$1 first char next rest value='' index close=-1
  local comment_re='^[[:space:]]*(#.*)?$'
  local bare_re='^([A-Za-z0-9._+,:@%/=-]*)([[:space:]]+#.*)?$'
  [ "${#raw}" -le 1024 ] || return 1
  [ -n "$raw" ] || { printf ''; return 0; }
  first=${raw:0:1}
  if [ "$first" = "'" ]; then
    for ((index=1; index<${#raw}; index++)); do
      char=${raw:index:1}
      if [ "$char" = "'" ]; then close=$index; break; fi
      value+="$char"
    done
    [ "$close" -ge 1 ] || return 1
    rest=${raw:close+1}
    [[ "$rest" =~ $comment_re ]] || return 1
  elif [ "$first" = '"' ]; then
    for ((index=1; index<${#raw}; index++)); do
      char=${raw:index:1}
      if [ "$char" = '"' ]; then close=$index; break; fi
      if [ "$char" = '\' ]; then
        index=$((index + 1))
        [ "$index" -lt "${#raw}" ] || return 1
        next=${raw:index:1}
        case "$next" in
          '\'|'"'|'$'|'`') value+="$next" ;;
          *) value+="\\$next" ;;
        esac
      else
        case "$char" in '$'|'`') return 1 ;; esac
        value+="$char"
      fi
    done
    [ "$close" -ge 1 ] || return 1
    rest=${raw:close+1}
    [[ "$rest" =~ $comment_re ]] || return 1
  else
    [[ "$raw" =~ $bare_re ]] || return 1
    value=${BASH_REMATCH[1]}
  fi
  [ "${#value}" -le 512 ] || return 1
  printf '%s' "$value"
}

conf_value() {
  local file=$1 wanted=$2 line raw parsed value='' found=0 valid=0
  local assignment_re="^[[:space:]]*(export[[:space:]]+)?${wanted}[[:space:]]*=[[:space:]]*(.*)$"
  [ -r "$file" ] || return 4
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ $assignment_re ]]; then
      found=1
      raw=${BASH_REMATCH[2]}
      while [[ "$raw" == *[[:space:]] ]]; do raw=${raw%?}; done
      if parsed=$(parse_conf_raw "$raw"); then
        value=$parsed
        valid=1
      else
        value=''
        valid=0
      fi
    fi
  done <"$file"
  [ "$found" = 1 ] || return 2
  [ "$valid" = 1 ] || return 3
  printf '%s' "$value"
}

resolve_store() {
  local conf=/etc/birdnet/birdnet.conf passwd_row timezone_size timezone_path
  [ -r "$conf" ] || fail 'BirdNET-Pi configuration was not found'
  birdnet_user=$(conf_value "$conf" BIRDNET_USER) \
    || fail 'BirdNET-Pi user is missing or invalid'
  [[ "$birdnet_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
    || fail 'BirdNET-Pi user is invalid'
  passwd_row=$(getent passwd "$birdnet_user")
  [ -n "$passwd_row" ] || fail 'BirdNET-Pi user does not exist'
  birdnet_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
  [[ "$birdnet_home" =~ ^/[A-Za-z0-9._/+@-]+$ ]] \
    && [[ "$birdnet_home" != *'..'* ]] \
    || fail 'BirdNET-Pi home is invalid'
  birdnet_home=$(readlink -f -- "$birdnet_home") \
    || fail 'BirdNET-Pi home was not found'
  repo_dir=$birdnet_home/BirdNET-Pi
  [ -d "$repo_dir" ] && [ ! -L "$repo_dir" ] \
    || fail 'BirdNET-Pi checkout is unsafe or missing'
  store_cli=$repo_dir/avian/api/educator-store.php
  [ -f "$store_cli" ] && [ ! -L "$store_cli" ] \
    && [ "$(readlink -f -- "$store_cli")" = "$store_cli" ] \
    || fail 'Educators data store is unsafe or missing'
  [ -x /usr/bin/php ] && [ -x /usr/sbin/runuser ] \
    || fail 'PHP or runuser is unavailable'
  [ -f /etc/timezone ] && [ ! -L /etc/timezone ] \
    || fail 'Station timezone was not found'
  timezone_size=$(stat -c '%s' -- /etc/timezone) \
    || fail 'Station timezone could not be inspected'
  [ "$timezone_size" -ge 2 ] && [ "$timezone_size" -le 129 ] \
    || fail 'Station timezone is invalid'
  station_timezone=$(cat -- /etc/timezone) \
    || fail 'Station timezone could not be read'
  [ "$timezone_size" -eq $(( ${#station_timezone} + 1 )) ] \
    && [[ "$station_timezone" =~ ^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$ ]] \
    && [ "${#station_timezone}" -le 128 ] \
    && [[ "/$station_timezone/" != *'/../'* ]] \
    && [[ "/$station_timezone/" != *'/./'* ]] \
    || fail 'Station timezone is invalid'
  timezone_path=$(readlink -f -- "/usr/share/zoneinfo/$station_timezone") \
    || fail 'Station timezone is unavailable'
  case "$timezone_path" in /usr/share/zoneinfo/*) ;; *) fail 'Station timezone is unsafe' ;; esac
  [ -f "$timezone_path" ] && [ -f /etc/localtime ] \
    && cmp -s -- "$timezone_path" /etc/localtime \
    || fail 'Station timezone does not match the system clock'
  /usr/bin/php -r '
    try { new DateTimeZone($argv[1]); }
    catch (Throwable $error) { exit(1); }
  ' "$station_timezone" \
    || fail 'Station timezone is not supported by PHP'
  birds_db=$repo_dir/scripts/birds.db
  [ -x /usr/bin/sqlite3 ] || fail 'sqlite3 is unavailable'
  recordings_root=$(conf_value "$conf" RECS_DIR) \
    || fail 'BirdNET-Pi recordings path is missing or invalid'
  extracted=$(conf_value "$conf" EXTRACTED) \
    || fail 'BirdNET-Pi extracted path is missing or invalid'
  processed=$(conf_value "$conf" PROCESSED) \
    || fail 'BirdNET-Pi processed path is missing or invalid'
  identification_file=$(conf_value "$conf" IDFILE) \
    || fail 'BirdNET-Pi identification path is missing or invalid'
  [[ "$recordings_root" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    && [ "$recordings_root" != / ] && [[ "$recordings_root" != *'..'* ]] \
    || fail 'BirdNET-Pi recordings path is invalid'
  [[ "$extracted" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    && [ "$extracted" != / ] && [[ "$extracted" != *'..'* ]] \
    || fail 'BirdNET-Pi extracted path is invalid'
  [[ "$processed" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    && [ "$processed" != / ] && [[ "$processed" != *'..'* ]] \
    || fail 'BirdNET-Pi processed path is invalid'
  [[ "$identification_file" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    && [ "$identification_file" != / ] && [[ "$identification_file" != *'..'* ]] \
    || fail 'BirdNET-Pi identification path is invalid'
  recordings_root=$(readlink -f -- "$recordings_root") \
    || fail 'BirdNET-Pi recordings path was not found'
  extracted=$(readlink -f -- "$extracted") \
    || fail 'BirdNET-Pi extracted path was not found'
  [ -d "$recordings_root" ] && [ ! -L "$recordings_root" ] \
    || fail 'BirdNET-Pi recordings path is unsafe'
  [ -d "$extracted" ] && [ ! -L "$extracted" ] \
    || fail 'BirdNET-Pi extracted path is unsafe'
  case "$recordings_root" in "$extracted"|"$extracted"/*)
    fail 'BirdNET-Pi recordings path cannot be inside the extracted path'
    ;;
  esac
  processed=$(readlink -m -- "$processed") \
    || fail 'BirdNET-Pi processed path could not be resolved'
  case "$processed" in "$recordings_root"/*) ;; *)
    fail 'BirdNET-Pi processed path must be inside the recordings path'
    ;;
  esac
  if [ -e "$processed" ] || [ -L "$processed" ]; then
    [ -d "$processed" ] && [ ! -L "$processed" ] \
      && [ "$(readlink -f -- "$processed")" = "$processed" ] \
      || fail 'BirdNET-Pi processed path is unsafe'
  fi
  identification_file=$(readlink -m -- "$identification_file") \
    || fail 'BirdNET-Pi identification path could not be resolved'
  case "$identification_file" in "$birdnet_home"/*) ;; *)
    fail 'BirdNET-Pi identification path must be inside the BirdNET-Pi home'
    ;;
  esac
  if [ -e "$identification_file" ] || [ -L "$identification_file" ]; then
    [ -f "$identification_file" ] && [ ! -L "$identification_file" ] \
      && [ "$(readlink -f -- "$identification_file")" = "$identification_file" ] \
      && [ "$(stat -c '%h' -- "$identification_file")" = 1 ] \
      || fail 'BirdNET-Pi identification path is unsafe'
  fi
  restore_stage=$recordings_root/tmp
  restore_by_date_old=$extracted/.By_Date.avian-old
  restore_charts_old=$extracted/.Charts.avian-old
  restore_birds_old=$repo_dir/scripts/.birds.db.avian-old
  restore_educators_old=$DATA_DIR/.educators.db.avian-old
}

require_live_birds_database() {
  [ -f "$birds_db" ] && [ ! -L "$birds_db" ] \
    && [ "$(readlink -f -- "$birds_db")" = "$birds_db" ] \
    && [ "$(stat -c '%h' -- "$birds_db")" = 1 ] \
    || fail 'BirdNET-Pi detections database is unsafe or missing'
}

ensure_root_dir() {
  if [ -e "$AUTH_DIR" ] || [ -L "$AUTH_DIR" ]; then
    [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] \
      && [ "$(stat -c '%u:%g:%a' -- "$AUTH_DIR")" = '0:0:755' ] \
      || fail 'Educators state directory is unsafe'
  else
    install -d -o root -g root -m 0755 "$AUTH_DIR"
  fi
  if [ ! -e "$AUTH_LOCK" ] && [ ! -L "$AUTH_LOCK" ]; then
    install -o root -g root -m 0600 /dev/null "$AUTH_LOCK"
  fi
  [ -f "$AUTH_LOCK" ] && [ ! -L "$AUTH_LOCK" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$AUTH_LOCK")" = '0:0:600:1' ] \
    || fail 'Admin state lock is unsafe'
}

open_lock() {
  local path=$1 fd=$2 expected=$3 mode=${4:-exclusive} before opened
  case "$mode" in shared|exclusive) ;; *) fail 'Internal lock mode is invalid' ;; esac
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    case "$fd" in
      9) install -o root -g root -m 0600 /dev/null "$path" ;;
      10) install -o root -g caddy -m 0660 /dev/null "$path" ;;
      11) install -o root -g root -m 0600 /dev/null "$path" ;;
      *) fail 'Internal lock descriptor is invalid' ;;
    esac
  fi
  [ -f "$path" ] && [ ! -L "$path" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$path")" = "$expected" ] \
    || fail "State lock is unsafe: $path"
  before=$(stat -c '%d:%i' -- "$path") \
    || fail "Could not inspect state lock: $path"
  if [ "$fd" = 9 ]; then
    exec 9<>"$path"
  elif [ "$fd" = 10 ]; then
    exec 10<>"$path"
  else
    exec 11<>"$path"
  fi
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h' -- "/proc/self/fd/$fd") \
    || fail "Could not inspect opened state lock: $path"
  [ "$opened" = "$before:$expected" ] \
    || fail "State lock changed while opening: $path"
  if [ "$mode" = shared ]; then
    flock -s "$fd" || fail "Could not lock state: $path"
  else
    flock -x "$fd" || fail "Could not lock state: $path"
  fi
  [ "$(stat -c '%d:%i' -- "$path")" = "$before" ] \
    || fail "State lock changed while locking: $path"
}

ensure_runtime_layout() {
  local slot birdnet_gid
  caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] || fail 'caddy group was not found'
  if [ -e "$DATA_DIR" ] || [ -L "$DATA_DIR" ]; then
    [ -d "$DATA_DIR" ] && [ ! -L "$DATA_DIR" ] \
      && [ "$(stat -c '%u:%g:%a' -- "$DATA_DIR")" = "0:$caddy_gid:770" ] \
      || fail 'Educators data directory is unsafe'
  else
    install -d -o root -g caddy -m 0770 "$DATA_DIR"
  fi
  ensure_backup_layout
  for slot in "$AUDIO_SLOT_0" "$AUDIO_SLOT_1"; do
    if [ ! -e "$slot" ] && [ ! -L "$slot" ]; then
      install -o root -g caddy -m 0660 /dev/null "$slot"
    fi
    [ -f "$slot" ] && [ ! -L "$slot" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "$slot")" = "0:$caddy_gid:660:1" ] \
      || fail "Educators audio slot is unsafe: $slot"
  done
}

ensure_backup_layout() {
  local birdnet_gid
  birdnet_gid=$(id -g "$birdnet_user")
  if [ -e "$BACKUP_ROOT" ] || [ -L "$BACKUP_ROOT" ]; then
    [ -d "$BACKUP_ROOT" ] && [ ! -L "$BACKUP_ROOT" ] \
      && [ "$(stat -c '%u:%g:%a' -- "$BACKUP_ROOT")" = "0:$birdnet_gid:750" ] \
      || fail 'Educators backup directory is unsafe'
  else
    install -d -o root -g "$birdnet_gid" -m 0750 "$BACKUP_ROOT"
  fi
}

read_maintenance_state() {
  local before opened size raw version mode extra
  MAINTENANCE_MODE=''
  if [ ! -e "$MAINTENANCE_STATE" ] && [ ! -L "$MAINTENANCE_STATE" ]; then
    return 2
  fi
  [ -f "$MAINTENANCE_STATE" ] && [ ! -L "$MAINTENANCE_STATE" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$MAINTENANCE_STATE")" = \
      "0:$caddy_gid:640:1" ] \
    || return 3
  before=$(stat -c '%d:%i' -- "$MAINTENANCE_STATE") || return 3
  exec 7<"$MAINTENANCE_STATE"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/7) || return 3
  size=${opened##*:}
  [ "$opened" = "$before:0:$caddy_gid:640:1:$size" ] \
    && [ "$size" -ge 9 ] && [ "$size" -le 32 ] \
    || { exec 7<&-; return 3; }
  raw=$(cat <&7)
  exec 7<&-
  [ "$size" -eq $(( ${#raw} + 1 )) ] || return 3
  IFS=$'\t' read -r version mode extra <<<"$raw"
  [ -z "${extra:-}" ] \
    && [ "$raw" = "$version"$'\t'"$mode" ] \
    && [ "$version" = v1 ] \
    && { [ "$mode" = clear ] || [ "$mode" = clear-base ] \
      || [ "$mode" = restore ] || [ "$mode" = restore-committed ] \
      || [ "$mode" = restore-base ] || [ "$mode" = restore-base-committed ] \
      || [ "$mode" = restore-import ] || [ "$mode" = restore-import-committed ]; } \
    && [ "$(stat -c '%d:%i' -- "$MAINTENANCE_STATE")" = "$before" ] \
    || return 3
  MAINTENANCE_MODE=$mode
}

write_maintenance_state() {
  local mode=$1 expected=${2:-missing} status=0
  case "$mode" in clear|clear-base|restore|restore-committed|restore-base|restore-base-committed|restore-import|restore-import-committed) ;; *)
    fail 'Internal maintenance state is invalid'
    ;;
  esac
  read_maintenance_state || status=$?
  if [ "$expected" = missing ]; then
    [ "$status" = 2 ] || fail 'Another Educators maintenance operation is active'
  else
    [ "$status" = 0 ] && [ "$MAINTENANCE_MODE" = "$expected" ] \
      || fail 'Educators maintenance state changed unexpectedly'
  fi
  maintenance_state_temp=$(mktemp "$AUTH_DIR/.educators.maintenance.XXXXXX") \
    || fail 'Could not create Educators maintenance state'
  printf 'v1\t%s\n' "$mode" >"$maintenance_state_temp"
  chown root:caddy "$maintenance_state_temp"
  chmod 0640 "$maintenance_state_temp"
  sync -f "$maintenance_state_temp"
  mv -fT -- "$maintenance_state_temp" "$MAINTENANCE_STATE"
  maintenance_state_temp=''
  sync -f "$AUTH_DIR"
  read_maintenance_state \
    && [ "$MAINTENANCE_MODE" = "$mode" ] \
    || fail 'Written Educators maintenance state did not validate'
}

remove_maintenance_state() {
  local expected=$1
  read_maintenance_state \
    && [ "$MAINTENANCE_MODE" = "$expected" ] \
    || return 1
  rm -f -- "$MAINTENANCE_STATE" || return 1
  sync -f "$AUTH_DIR" || return 1
  [ ! -e "$MAINTENANCE_STATE" ] && [ ! -L "$MAINTENANCE_STATE" ]
}

require_no_maintenance() {
  local status=0
  read_maintenance_state || status=$?
  case "$status" in
    2) ;;
    0) fail "Educators maintenance recovery is required: $MAINTENANCE_MODE" ;;
    *) fail 'Educators maintenance state is unsafe or malformed' ;;
  esac
}

restore_media_rollback() {
  local live=$1 old=$2 staged=$3
  [ -e "$old" ] || return 0
  [ -d "$old" ] && [ ! -L "$old" ] \
    && [ "$(readlink -f -- "$old")" = "$old" ] \
    || return 1
  if [ -e "$live" ] || [ -L "$live" ]; then
    [ -d "$live" ] && [ ! -L "$live" ] \
      && [ "$(readlink -f -- "$live")" = "$live" ] \
      && [ ! -e "$staged" ] && [ ! -L "$staged" ] \
      || return 1
    /usr/sbin/runuser -u "$birdnet_user" -- mv -T -- "$live" "$staged" \
      || return 1
  fi
  /usr/sbin/runuser -u "$birdnet_user" -- mv -T -- "$old" "$live"
}

rollback_restore() {
  local status=0 birdnet_gid
  birdnet_gid=$(id -g "$birdnet_user") || return 1
  if [ ! -d "$restore_stage" ]; then
    /usr/sbin/runuser -u "$birdnet_user" -- mkdir -p -- "$restore_stage" \
      || return 1
  fi
  [ -d "$restore_stage" ] && [ ! -L "$restore_stage" ] \
    && [ "$(readlink -f -- "$restore_stage")" = "$restore_stage" ] \
    || return 1
  if [ -e "$restore_educators_old" ]; then
    safe_database_file "$restore_educators_old" 536870912 || status=1
    if [ "$status" = 0 ] && { [ -e "$PROFILE_DB" ] || [ -L "$PROFILE_DB" ]; }; then
      [ -f "$PROFILE_DB" ] && [ ! -L "$PROFILE_DB" ] \
        && [ "$(readlink -f -- "$PROFILE_DB")" = "$PROFILE_DB" ] \
        || status=1
      [ "$status" = 1 ] || rm -f -- "$PROFILE_DB" "$PROFILE_DB-wal" "$PROFILE_DB-shm" \
        || status=1
    fi
    [ "$status" = 1 ] || mv -T -- "$restore_educators_old" "$PROFILE_DB" \
      || status=1
  elif [ "$restore_mode" = restore-import ]; then
    if [ -e "$PROFILE_DB" ] || [ -L "$PROFILE_DB" ]; then
      [ -f "$PROFILE_DB" ] && [ ! -L "$PROFILE_DB" ] \
        && [ "$(readlink -f -- "$PROFILE_DB")" = "$PROFILE_DB" ] \
        || status=1
      [ "$status" = 1 ] || rm -f -- "$PROFILE_DB" "$PROFILE_DB-wal" "$PROFILE_DB-shm" \
        || status=1
    fi
    if [ "$status" = 0 ] && { [ -e "$PROFILE_STATE" ] || [ -L "$PROFILE_STATE" ]; }; then
      read_profile \
        && [ "$PROFILE_ENABLED:$PROFILE_EPOCH" = 0:0 ] \
        || status=1
      [ "$status" = 1 ] || rm -f -- "$PROFILE_STATE" || status=1
    fi
  fi
  if [ "$status" = 0 ] && [ -e "$restore_birds_old" ]; then
    safe_database_file "$restore_birds_old" 2147483648 || status=1
    if [ "$status" = 0 ] && { [ -e "$birds_db" ] || [ -L "$birds_db" ]; }; then
      [ -f "$birds_db" ] && [ ! -L "$birds_db" ] \
        && [ "$(readlink -f -- "$birds_db")" = "$birds_db" ] \
        || status=1
      [ "$status" = 1 ] || /usr/sbin/runuser -u "$birdnet_user" -- rm -f -- "$birds_db" \
        || status=1
    fi
    [ "$status" = 1 ] || /usr/sbin/runuser -u "$birdnet_user" -- \
      mv -T -- "$restore_birds_old" "$birds_db" || status=1
  fi
  [ "$status" = 1 ] || restore_media_rollback \
    "$extracted/Charts" "$restore_charts_old" "$restore_stage/Charts" || status=1
  [ "$status" = 1 ] || restore_media_rollback \
    "$extracted/By_Date" "$restore_by_date_old" "$restore_stage/By_Date" || status=1
  if [ "$status" = 0 ]; then
    chown "$birdnet_user:$birdnet_gid" "$birds_db" && chmod 0664 "$birds_db" \
      || status=1
    if [ "$restore_mode" = restore ]; then
      chown caddy:caddy "$PROFILE_DB" && chmod 0660 "$PROFILE_DB" \
        || status=1
    fi
    sync -f "$(dirname "$birds_db")" || status=1
    if [ -d "$DATA_DIR" ] && [ ! -L "$DATA_DIR" ]; then
      sync -f "$DATA_DIR" || status=1
      if [ "$restore_mode" = restore-import ]; then
        rmdir -- "$DATA_DIR" 2>/dev/null || status=1
      fi
    fi
    sync -f "$AUTH_DIR" || status=1
    sync -f "$extracted" || status=1
  fi
  restore_active=0
  return "$status"
}

discard_restore_rollback() {
  local status=0
  if [ -e "$restore_by_date_old" ]; then
    [ -d "$restore_by_date_old" ] && [ ! -L "$restore_by_date_old" ] \
      || return 1
    /usr/sbin/runuser -u "$birdnet_user" -- \
      find "$restore_by_date_old" -xdev -depth -delete || status=1
  fi
  if [ -e "$restore_charts_old" ]; then
    [ -d "$restore_charts_old" ] && [ ! -L "$restore_charts_old" ] \
      || return 1
    /usr/sbin/runuser -u "$birdnet_user" -- \
      find "$restore_charts_old" -xdev -depth -delete || status=1
  fi
  [ ! -e "$restore_birds_old" ] \
    || /usr/sbin/runuser -u "$birdnet_user" -- rm -f -- "$restore_birds_old" \
    || status=1
  [ ! -e "$restore_educators_old" ] \
    || rm -f -- "$restore_educators_old" || status=1
  sync -f "$(dirname "$birds_db")" || status=1
  if [ -d "$DATA_DIR" ] && [ ! -L "$DATA_DIR" ]; then
    sync -f "$DATA_DIR" || status=1
  fi
  sync -f "$extracted" || status=1
  return "$status"
}

read_profile() {
  local before opened size raw version enabled epoch extra
  PROFILE_ENABLED=0
  PROFILE_EPOCH=0
  if [ ! -e "$PROFILE_STATE" ] && [ ! -L "$PROFILE_STATE" ]; then
    return 2
  fi
  [ -f "$PROFILE_STATE" ] && [ ! -L "$PROFILE_STATE" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$PROFILE_STATE")" = "0:$caddy_gid:640:1" ] \
    || return 3
  before=$(stat -c '%d:%i' -- "$PROFILE_STATE") || return 3
  exec 8<"$PROFILE_STATE"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/8) || return 3
  size=${opened##*:}
  [ "$opened" = "$before:0:$caddy_gid:640:1:$size" ] \
    && [ "$size" -ge 7 ] && [ "$size" -le 64 ] \
    || return 3
  raw=$(cat <&8)
  exec 8<&-
  [ "$size" -eq $(( ${#raw} + 1 )) ] || return 3
  IFS=$'\t' read -r version enabled epoch extra <<<"$raw"
  [ -z "${extra:-}" ] \
    && [ "$raw" = "$version"$'\t'"$enabled"$'\t'"$epoch" ] \
    && [ "$version" = v1 ] \
    && { [ "$enabled" = 0 ] || [ "$enabled" = 1 ]; } \
    && [[ "$epoch" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$epoch" -le "$EPOCH_MAX" ] \
    && [ "$(stat -c '%d:%i' -- "$PROFILE_STATE")" = "$before" ] \
    || return 3
  PROFILE_ENABLED=$enabled
  PROFILE_EPOCH=$epoch
}

write_profile() {
  local enabled=$1 epoch=$2
  { [ "$enabled" = 0 ] || [ "$enabled" = 1 ]; } \
    || fail 'Invalid Educators state'
  [[ "$epoch" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$epoch" -le "$EPOCH_MAX" ] \
    || fail 'Invalid Educators epoch'
  profile_temp=$(mktemp "$AUTH_DIR/.educators.state.XXXXXX") \
    || fail 'Could not create Educators state'
  printf 'v1\t%s\t%s\n' "$enabled" "$epoch" >"$profile_temp" \
    || fail 'Could not write Educators state'
  chown root:caddy "$profile_temp" \
    && chmod 0640 "$profile_temp" \
    && sync -f "$profile_temp" \
    || fail 'Could not prepare Educators state'
  mv -fT -- "$profile_temp" "$PROFILE_STATE" \
    || fail 'Could not install Educators state'
  profile_temp=''
  sync -f "$AUTH_DIR" || fail 'Could not sync Educators state'
  read_profile \
    && [ "$PROFILE_ENABLED:$PROFILE_EPOCH" = "$enabled:$epoch" ] \
    || fail 'Written Educators state did not validate'
}

initialize_profile() {
  local status=0
  read_profile || status=$?
  case "$status" in
    0) ;;
    2) write_profile 0 0 ;;
    *) fail 'Existing Educators state is unsafe or malformed' ;;
  esac
}

inspect_profile_readonly() {
  local status=0
  caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] || fail 'Caddy group was not found'
  if [ -e "$AUTH_DIR" ] || [ -L "$AUTH_DIR" ]; then
    [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] \
      && [ "$(stat -c '%u:%g:%a' -- "$AUTH_DIR")" = '0:0:755' ] \
      || fail 'Educators state directory is unsafe'
  else
    PROFILE_ENABLED=0
    PROFILE_EPOCH=0
    PROFILE_STATUS=2
    return 0
  fi
  read_profile || status=$?
  case "$status" in
    0|2) PROFILE_STATUS=$status ;;
    *) fail 'Existing Educators state is unsafe or malformed' ;;
  esac
}

inspect_profile_storage_readonly() {
  local caddy_uid sidecar
  inspect_profile_readonly
  if [ "$PROFILE_STATUS" = 2 ]; then
    if [ -e "$DATA_DIR" ] || [ -L "$DATA_DIR" ]; then
      fail 'Educators profile storage is partially initialized'
    fi
    PROFILE_INITIALIZED=0
    return 0
  fi
  caddy_uid=$(id -u caddy) || fail 'Caddy user was not found'
  [ -d "$DATA_DIR" ] && [ ! -L "$DATA_DIR" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$DATA_DIR")" = "0:$caddy_gid:770" ] \
    || fail 'Educators data directory is unsafe or missing'
  safe_database_file "$PROFILE_DB" 536870912 \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$PROFILE_DB")" = \
      "$caddy_uid:$caddy_gid:660:1" ] \
    || fail 'Educators data store is missing or unsafe'
  for sidecar in "$PROFILE_DB-wal" "$PROFILE_DB-shm"; do
    if [ -e "$sidecar" ] || [ -L "$sidecar" ]; then
      [ -f "$sidecar" ] && [ ! -L "$sidecar" ] \
        && [ "$(readlink -f -- "$sidecar")" = "$sidecar" ] \
        && [ "$(stat -c '%u:%g:%a:%h' -- "$sidecar")" = \
          "$caddy_uid:$caddy_gid:660:1" ] \
        || fail 'Educators data store sidecar is unsafe'
    fi
  done
  PROFILE_INITIALIZED=1
}

require_no_maintenance_readonly() {
  local status=0
  [ -e "$AUTH_DIR" ] || return 0
  read_maintenance_state || status=$?
  case "$status" in
    2) ;;
    0) fail "Educators maintenance recovery is required: $MAINTENANCE_MODE" ;;
    *) fail 'Educators maintenance state is unsafe or malformed' ;;
  esac
}

print_profile_status() {
  printf '{"ok":true,"enabled":%s,"epoch":%s}\n' \
    "$([ "$PROFILE_ENABLED" = 1 ] && printf true || printf false)" "$PROFILE_EPOCH"
}

run_store() {
  local command=$1
  case "$command" in init|stop-current|reset-data|validate) ;; *) fail 'Invalid store action' ;; esac
  /usr/sbin/runuser -u caddy -- \
    /usr/bin/env -i PATH=/usr/bin:/bin AV_EDUCATOR_LOCK_FD=10 \
    AVIAN_STATION_TIMEZONE="$station_timezone" \
    /usr/bin/php "$store_cli" "$command"
}

install_birds_authority() {
  local database=$1 rotate=${2:-0} sql generation
  case "$rotate" in 0|1) ;; *) fail 'Invalid generation action' ;; esac
  if [ "$rotate" = 1 ]; then
    sql="PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS avian_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID; INSERT INTO avian_metadata(key,value) VALUES('educator_generation',lower(hex(randomblob(16)))) ON CONFLICT(key) DO UPDATE SET value=lower(hex(randomblob(16)));"
  else
    sql="PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS avian_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID; INSERT OR IGNORE INTO avian_metadata(key,value) VALUES('educator_generation',lower(hex(randomblob(16))));"
  fi
  sql+=" CREATE INDEX IF NOT EXISTS detections_Date_Time ON detections(Date DESC,Time DESC);"
  sql+=" CREATE TABLE IF NOT EXISTS avian_detection_sequence (sequence INTEGER PRIMARY KEY AUTOINCREMENT,detection_rowid INTEGER NOT NULL UNIQUE);"
  sql+=" INSERT INTO avian_detection_sequence(detection_rowid) SELECT d.rowid FROM detections d LEFT JOIN avian_detection_sequence s ON s.detection_rowid=d.rowid WHERE s.sequence IS NULL ORDER BY d.rowid;"
  sql+=" CREATE TRIGGER IF NOT EXISTS avian_detection_sequence_insert AFTER INSERT ON detections BEGIN INSERT INTO avian_detection_sequence(detection_rowid) VALUES(NEW.rowid); END;"
  sql+=" CREATE TRIGGER IF NOT EXISTS avian_detection_sequence_delete AFTER DELETE ON detections BEGIN DELETE FROM avian_detection_sequence WHERE detection_rowid=OLD.rowid; END;"
  sql+=" CREATE TRIGGER IF NOT EXISTS avian_detection_sequence_update AFTER UPDATE OF rowid ON detections BEGIN UPDATE avian_detection_sequence SET detection_rowid=NEW.rowid WHERE detection_rowid=OLD.rowid; END; COMMIT;"
  /usr/sbin/runuser -u "$birdnet_user" -- \
    /usr/bin/env -i PATH=/usr/bin:/bin \
    /usr/bin/sqlite3 -batch -bail "$database" "$sql" >/dev/null \
    || fail 'Could not update the detections authority'
  generation=$(/usr/sbin/runuser -u "$birdnet_user" -- \
    /usr/bin/env -i PATH=/usr/bin:/bin \
    /usr/bin/sqlite3 -batch -bail "$database" \
      "SELECT value FROM avian_metadata WHERE key='educator_generation';") \
    || fail 'Could not read the detections generation'
  [[ "$generation" =~ ^[a-f0-9]{32}$ ]] \
    || fail 'Detections generation is missing or malformed'
  if [ "$database" != "$birds_db" ]; then
    /usr/sbin/runuser -u "$birdnet_user" -- \
      /usr/bin/sqlite3 -batch -bail "$database" \
      'PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null \
      || fail 'Could not checkpoint the staged detections authority'
  fi
}

ensure_birds_generation() {
  install_birds_authority "$birds_db" "${1:-0}"
}

sqlite_scalar() {
  local database=$1 sql=$2
  /usr/bin/sqlite3 -batch -bail -readonly \
    "file:$database?immutable=1" "$sql"
}

safe_database_file() {
  local path=$1 maximum=$2
  [ -f "$path" ] && [ ! -L "$path" ] \
    && [ "$(readlink -f -- "$path")" = "$path" ] \
    && [ "$(stat -c '%h' -- "$path")" = 1 ] \
    && [ "$(stat -c '%s' -- "$path")" -gt 0 ] \
    && [ "$(stat -c '%s' -- "$path")" -le "$maximum" ]
}

validate_birds_snapshot() {
  local database=$1 check table_count metadata_count generation sequence_columns
  safe_database_file "$database" 2147483648 \
    || fail 'Staged detections database is unsafe'
  check=$(sqlite_scalar "$database" 'PRAGMA quick_check;') \
    || fail 'Staged detections database could not be checked'
  [ "$check" = ok ] || fail 'Staged detections database is corrupt'
  table_count=$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='detections';") \
    || fail 'Staged detections schema could not be checked'
  [ "$table_count" = 1 ] || fail 'Staged detections database has no detections table'
  [ "$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND tbl_name='detections' AND name='detections_Date_Time';")" = 1 ] \
    || fail 'Staged detections Date/Time index is missing'
  metadata_count=$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='avian_metadata';") \
    || fail 'Staged detections metadata could not be checked'
  [ "$metadata_count" = 1 ] || fail 'Staged detections metadata is missing'
  generation=$(sqlite_scalar "$database" \
    "SELECT value FROM avian_metadata WHERE key='educator_generation';") \
    || fail 'Staged detections generation could not be read'
  [[ "$generation" =~ ^[a-f0-9]{32}$ ]] \
    || fail 'Staged detections generation is invalid'
  [ "$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM avian_metadata WHERE key='educator_generation';")" = 1 ] \
    || fail 'Staged detections generation is ambiguous'
  [ "$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='avian_detection_sequence';")" = 1 ] \
    || fail 'Staged detections sequence authority is missing'
  sequence_columns=$(sqlite_scalar "$database" \
    "SELECT group_concat(name||':'||upper(type)||':'||\"notnull\"||':'||pk,',') FROM pragma_table_info('avian_detection_sequence');") \
    || fail 'Staged detections sequence columns could not be checked'
  [ "$sequence_columns" = 'sequence:INTEGER:0:1,detection_rowid:INTEGER:1:0' ] \
    || fail 'Staged detections sequence columns are invalid'
  [ "$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='detections' AND name IN ('avian_detection_sequence_insert','avian_detection_sequence_delete','avian_detection_sequence_update');")" = 3 ] \
    || fail 'Staged detections sequence triggers are missing'
  [ "$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM avian_detection_sequence WHERE typeof(sequence)<>'integer' OR sequence<1 OR typeof(detection_rowid)<>'integer' OR detection_rowid<1;")" = 0 ] \
    || fail 'Staged detections sequence rows are invalid'
  [ "$(sqlite_scalar "$database" \
    "SELECT (SELECT COUNT(*) FROM detections d LEFT JOIN avian_detection_sequence s ON s.detection_rowid=d.rowid WHERE s.sequence IS NULL)+(SELECT COUNT(*) FROM avian_detection_sequence s LEFT JOIN detections d ON d.rowid=s.detection_rowid WHERE d.rowid IS NULL);")" = 0 ] \
    || fail 'Staged detections sequence mapping is incomplete'
  [ "$(sqlite_scalar "$database" \
    "SELECT CASE WHEN (SELECT COUNT(*) FROM sqlite_sequence WHERE name='avian_detection_sequence')=0 THEN CASE WHEN (SELECT COUNT(*) FROM avian_detection_sequence)=0 THEN 1 ELSE 0 END WHEN (SELECT COUNT(*) FROM sqlite_sequence WHERE name='avian_detection_sequence')=1 AND typeof((SELECT seq FROM sqlite_sequence WHERE name='avian_detection_sequence'))='integer' AND (SELECT seq FROM sqlite_sequence WHERE name='avian_detection_sequence')>=COALESCE((SELECT MAX(sequence) FROM avian_detection_sequence),0) THEN 1 ELSE 0 END;")" = 1 ] \
    || fail 'Staged detections sequence floor is invalid'
  SNAPSHOT_GENERATION=$generation
}

validate_base_birds_snapshot() {
  local database=$1 check table_count
  safe_database_file "$database" 2147483648 \
    || fail 'Staged detections database is unsafe'
  check=$(sqlite_scalar "$database" 'PRAGMA quick_check;') \
    || fail 'Staged detections database could not be checked'
  [ "$check" = ok ] || fail 'Staged detections database is corrupt'
  table_count=$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='detections';") \
    || fail 'Staged detections schema could not be checked'
  [ "$table_count" = 1 ] \
    || fail 'Staged detections database has no detections table'
}

validate_educator_snapshot() {
  local database=$1 generation=$2 check application version table_name
  safe_database_file "$database" 536870912 \
    || fail 'Staged Educators database is unsafe'
  check=$(sqlite_scalar "$database" 'PRAGMA quick_check;') \
    || fail 'Staged Educators database could not be checked'
  [ "$check" = ok ] || fail 'Staged Educators database is corrupt'
  application=$(sqlite_scalar "$database" 'PRAGMA application_id;') \
    || fail 'Staged Educators application id could not be checked'
  version=$(sqlite_scalar "$database" 'PRAGMA user_version;') \
    || fail 'Staged Educators schema version could not be checked'
  [ "$application" = 1096172868 ] && [ "$version" = 1 ] \
    || fail 'Staged Educators database has an unsupported schema'
  for table_name in educator_meta folders captures capture_segments; do
    [ "$(sqlite_scalar "$database" \
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$table_name';")" = 1 ] \
      || fail "Staged Educators database is missing $table_name"
  done
  [ -z "$(sqlite_scalar "$database" 'PRAGMA foreign_key_check;')" ] \
    || fail 'Staged Educators database has broken relationships'
  [ "$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM capture_segments WHERE birds_generation<>'$generation';")" = 0 ] \
    || fail 'Staged Educators history belongs to another detections database'
  [ "$(sqlite_scalar "$database" \
    "SELECT COUNT(*) FROM captures WHERE status IN ('running','paused');")" = 0 ] \
    || fail 'Staged Educators database contains an active listening period'
  [ "$(sqlite_scalar "$database" \
    'SELECT COUNT(*) FROM capture_segments WHERE stopped_epoch IS NULL;')" = 0 ] \
    || fail 'Staged Educators database contains an open listening segment'
}

run_snapshot_stop() {
  local educator_database=$1 birds_database=$2
  /usr/sbin/runuser -u caddy -- \
    /usr/bin/env -i PATH=/usr/bin:/bin AV_EDUCATOR_LOCK_FD=10 \
    AVIAN_STATION_TIMEZONE="$station_timezone" \
    AV_EDUCATOR_STORE_FILE="$educator_database" \
    AV_EDUCATOR_BIRDS_DB="$birds_database" \
    /usr/bin/php "$store_cli" stop-current >/dev/null \
    || fail 'The current listening period could not be normalized for backup'
}

run_snapshot_validate() {
  local educator_database=$1 birds_database=$2
  /usr/sbin/runuser -u caddy -- \
    /usr/bin/env -i PATH=/usr/bin:/bin AV_EDUCATOR_LOCK_FD=10 \
    AVIAN_STATION_TIMEZONE="$station_timezone" \
    AV_EDUCATOR_STORE_FILE="$educator_database" \
    AV_EDUCATOR_BIRDS_DB="$birds_database" \
    /usr/bin/php "$store_cli" validate >/dev/null \
    || fail 'The staged detections and Educators authority did not validate'
}

prepare_backup_pair() {
  local birdnet_gid
  birdnet_gid=$(id -g "$birdnet_user")
  pair_temp=$(mktemp -d "$BACKUP_ROOT/.pair.XXXXXX") \
    || fail 'Could not create the Educators backup staging directory'
  chown root:"$birdnet_gid" "$pair_temp" \
    && chmod 0750 "$pair_temp" \
    || fail 'Could not secure the Educators backup staging directory'
  maintenance_work=$(mktemp -d "$AUTH_DIR/.educators-work.XXXXXX") \
    || fail 'Could not create the Educators database work directory'
  chown root:caddy "$maintenance_work" \
    && chmod 0770 "$maintenance_work" \
    || fail 'Could not secure the Educators database work directory'

  /usr/bin/sqlite3 -batch -bail -readonly "$birds_db" \
    ".timeout 5000" ".backup '$pair_temp/birds.db'" >/dev/null \
    || fail 'Could not snapshot the detections database'
  validate_birds_snapshot "$pair_temp/birds.db"
  install -o caddy -g caddy -m 0660 "$pair_temp/birds.db" \
    "$maintenance_work/birds.db"

  /usr/sbin/runuser -u caddy -- /usr/bin/sqlite3 -batch -bail "$PROFILE_DB" \
    'PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(FULL);' >/dev/null \
    || fail 'Could not checkpoint the Educators database'
  /usr/sbin/runuser -u caddy -- /usr/bin/sqlite3 -batch -bail "$PROFILE_DB" \
    ".timeout 5000" ".backup '$maintenance_work/educators.db'" >/dev/null \
    || fail 'Could not snapshot the Educators database'
  chown caddy:caddy "$maintenance_work/educators.db"
  chmod 0660 "$maintenance_work/educators.db"
  run_snapshot_stop "$maintenance_work/educators.db" "$maintenance_work/birds.db"
  /usr/sbin/runuser -u caddy -- /usr/bin/sqlite3 -batch -bail \
    "$maintenance_work/educators.db" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null \
    || fail 'Could not finish the Educators database snapshot'
  validate_educator_snapshot "$maintenance_work/educators.db" "$SNAPSHOT_GENERATION"
  run_snapshot_validate "$maintenance_work/educators.db" "$maintenance_work/birds.db"
  install -o root -g "$birdnet_gid" -m 0640 \
    "$maintenance_work/educators.db" "$pair_temp/educators.db"
  chown root:"$birdnet_gid" "$pair_temp/birds.db"
  chmod 0640 "$pair_temp/birds.db"
  validate_birds_snapshot "$pair_temp/birds.db"
  validate_educator_snapshot "$pair_temp/educators.db" "$SNAPSHOT_GENERATION"
  sync -f "$pair_temp/birds.db"
  sync -f "$pair_temp/educators.db"
  sync -f "$pair_temp"

  sync -f "$BACKUP_ROOT"
  printf '%s\n' "$pair_temp"
  pair_temp=''
}

prepare_base_backup_pair() {
  local birdnet_gid sidecar
  birdnet_gid=$(id -g "$birdnet_user")
  for sidecar in "$birds_db-wal" "$birds_db-shm" "$birds_db-journal"; do
    [ ! -e "$sidecar" ] && [ ! -L "$sidecar" ] \
      || fail 'The detections database did not become quiescent for backup'
  done
  pair_temp=$(mktemp -d "$BACKUP_ROOT/.pair.XXXXXX") \
    || fail 'Could not create the backup staging directory'
  chown root:"$birdnet_gid" "$pair_temp" \
    && chmod 0750 "$pair_temp" \
    || fail 'Could not secure the backup staging directory'
  /usr/bin/sqlite3 -batch -bail -readonly "file:$birds_db?immutable=1" \
    ".timeout 5000" ".backup '$pair_temp/birds.db'" >/dev/null \
    || fail 'Could not snapshot the detections database'
  chown root:"$birdnet_gid" "$pair_temp/birds.db"
  chmod 0640 "$pair_temp/birds.db"
  validate_base_birds_snapshot "$pair_temp/birds.db"
  sync -f "$pair_temp/birds.db"
  sync -f "$pair_temp"
  sync -f "$BACKUP_ROOT"
  printf '%s\n' "$pair_temp"
  pair_temp=''
}

discard_backup_pair() {
  local path=$1 birdnet_gid entry
  birdnet_gid=$(id -g "$birdnet_user")
  if ! [[ "$path" =~ ^/var/lib/avian-visitors/educator-backups/\.pair\.[A-Za-z0-9]{6}$ ]]; then
    fail 'Educators backup snapshot path is invalid'
  fi
  [ -d "$path" ] && [ ! -L "$path" ] \
    && [ "$(readlink -f -- "$path")" = "$path" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$path")" = "0:$birdnet_gid:750:2" ] \
    || fail 'Educators backup snapshot is unsafe'
  for entry in "$path"/*; do
    [ -e "$entry" ] || continue
    case "$(basename "$entry")" in birds.db|educators.db) ;; *)
      fail "Educators backup snapshot contains unexpected data: $(basename "$entry")"
      ;;
    esac
    [ -f "$entry" ] && [ ! -L "$entry" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "$entry")" = "0:$birdnet_gid:640:1" ] \
      || fail 'Educators backup snapshot file is unsafe'
  done
  [ -f "$path/birds.db" ] \
    || fail 'Backup snapshot is incomplete'
  rm -f -- "$path/birds.db"
  [ ! -e "$path/educators.db" ] || rm -f -- "$path/educators.db"
  rmdir -- "$path"
  sync -f "$BACKUP_ROOT"
  printf '{"ok":true,"discarded":true}\n'
}

validate_media_tree() {
  local root=$1 entry relative count=0
  [ -d "$root" ] && [ ! -L "$root" ] \
    && [ "$(readlink -f -- "$root")" = "$root" ] \
    || fail "Staged media directory is unsafe: $root"
  case "$root" in "$restore_stage"/*) ;; *) fail 'Staged media leaves the restore directory' ;; esac
  while IFS= read -r -d '' entry; do
    count=$((count + 1))
    [ "$count" -le 1000000 ] || fail 'Staged media contains too many entries'
    relative=${entry#"$root"}
    [ "${#relative}" -le 4096 ] \
      && [[ "$relative" != *[$'\001'-$'\037'$'\177']* ]] \
      || fail 'Staged media contains an unsafe path'
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then
      continue
    fi
    [ -f "$entry" ] && [ ! -L "$entry" ] \
      && [ "$(stat -c '%h' -- "$entry")" = 1 ] \
      || fail 'Staged media contains a link or special file'
  done < <(find "$root" -xdev -print0)
}

checkpoint_live_databases() {
  local include_profile=${1:-1}
  case "$include_profile" in 0|1) ;; *) fail 'Internal checkpoint mode is invalid' ;; esac
  /usr/sbin/runuser -u "$birdnet_user" -- /usr/bin/sqlite3 -batch -bail "$birds_db" \
    'PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null \
    || fail 'Could not checkpoint the live detections database'
  if [ "$include_profile" = 1 ]; then
    /usr/sbin/runuser -u caddy -- /usr/bin/sqlite3 -batch -bail "$PROFILE_DB" \
      'PRAGMA busy_timeout=5000; PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null \
      || fail 'Could not checkpoint the live Educators database'
  fi
  for sidecar in "$birds_db-wal" "$birds_db-shm"; do
    [ ! -e "$sidecar" ] || { [ -f "$sidecar" ] && [ ! -L "$sidecar" ] \
      && [ "$(stat -c '%u:%h' -- "$sidecar")" = "$(id -u "$birdnet_user"):1" ] \
      || fail 'Live detections database sidecar is unsafe'; }
    rm -f -- "$sidecar"
  done
  if [ "$include_profile" = 1 ]; then
    for sidecar in "$PROFILE_DB-wal" "$PROFILE_DB-shm"; do
      [ ! -e "$sidecar" ] || { [ -f "$sidecar" ] && [ ! -L "$sidecar" ] \
        && [ "$(stat -c '%u:%g:%h' -- "$sidecar")" = \
          "$(id -u caddy):$(id -g caddy):1" ] \
        || fail 'Live Educators database sidecar is unsafe'; }
      rm -f -- "$sidecar"
    done
  fi
}

restore_staged_pair() {
  local staged_birds=$restore_stage/birds.db
  local staged_educators=$restore_stage/educators.db
  local birdnet_gid generation educator_present=0 committed_mode old_path
  [ -d "$restore_stage" ] && [ ! -L "$restore_stage" ] \
    && [ "$(readlink -f -- "$restore_stage")" = "$restore_stage" ] \
    || fail 'Restore staging directory is unsafe'
  if [ -e "$staged_educators" ] || [ -L "$staged_educators" ]; then
    validate_birds_snapshot "$staged_birds"
    generation=$SNAPSHOT_GENERATION
    validate_educator_snapshot "$staged_educators" "$generation"
    educator_present=1
  else
    validate_base_birds_snapshot "$staged_birds"
  fi
  validate_media_tree "$restore_stage/By_Date"
  validate_media_tree "$restore_stage/Charts"

  case "$PROFILE_INITIALIZED:$educator_present" in
    0:0) restore_mode=restore-base ;;
    0:1) restore_mode=restore-import ;;
    1:0|1:1) restore_mode=restore ;;
    *) fail 'Internal restore profile state is invalid' ;;
  esac

  birdnet_gid=$(id -g "$birdnet_user")
  maintenance_work=$(mktemp -d "$AUTH_DIR/.educators-work.XXXXXX") \
    || fail 'Could not create the restore work directory'
  chown root:caddy "$maintenance_work" && chmod 0770 "$maintenance_work" \
    || fail 'Could not secure the restore work directory'
  install -o "$birdnet_user" -g "$birdnet_gid" -m 0664 \
    "$staged_birds" "$maintenance_work/birds.db"
  if [ "$educator_present" = 1 ]; then
    install -o caddy -g caddy -m 0660 \
      "$staged_educators" "$maintenance_work/educators.db"
    validate_birds_snapshot "$maintenance_work/birds.db"
    validate_educator_snapshot "$maintenance_work/educators.db" "$SNAPSHOT_GENERATION"
    run_snapshot_validate "$maintenance_work/educators.db" "$maintenance_work/birds.db"
  elif [ "$PROFILE_INITIALIZED" = 1 ]; then
    [ "$(stat -c '%u:%h' -- "$staged_birds")" = "$(id -u "$birdnet_user"):1" ] \
      || fail 'Legacy staged detections database is not owned by BirdNET-Pi'
    install_birds_authority "$staged_birds" 1
    install -o "$birdnet_user" -g "$birdnet_gid" -m 0664 \
      "$staged_birds" "$maintenance_work/birds.db"
    validate_birds_snapshot "$maintenance_work/birds.db"
  else
    validate_base_birds_snapshot "$maintenance_work/birds.db"
  fi
  sync -f "$maintenance_work/birds.db"
  [ "$educator_present" = 0 ] || sync -f "$maintenance_work/educators.db"

  checkpoint_live_databases "$PROFILE_INITIALIZED"
  for old_path in "$restore_by_date_old" "$restore_charts_old" \
    "$restore_birds_old" "$restore_educators_old"; do
    [ ! -e "$old_path" ] && [ ! -L "$old_path" ] \
      || fail "Restore rollback path already exists: $old_path"
  done
  write_maintenance_state "$restore_mode"
  restore_active=1
  if [ "$restore_mode" = restore-import ]; then
    # Publishing the durable marker before optional storage is created keeps
    # every interrupted first import recoverable as an uninitialized station.
    ensure_runtime_layout
  fi

  /usr/sbin/runuser -u "$birdnet_user" -- mv -T -- "$extracted/By_Date" "$restore_by_date_old" \
    && /usr/sbin/runuser -u "$birdnet_user" -- mv -T -- "$restore_stage/By_Date" "$extracted/By_Date" \
    || fail 'Could not install restored dated recordings'
  /usr/sbin/runuser -u "$birdnet_user" -- mv -T -- "$extracted/Charts" "$restore_charts_old" \
    && /usr/sbin/runuser -u "$birdnet_user" -- mv -T -- "$restore_stage/Charts" "$extracted/Charts" \
    || fail 'Could not install restored charts'
  /usr/sbin/runuser -u "$birdnet_user" -- mv -T -- "$birds_db" "$restore_birds_old" \
    && mv -T -- "$maintenance_work/birds.db" "$birds_db" \
    || fail 'Could not install the restored detections database'
  chown "$birdnet_user:$birdnet_gid" "$birds_db" && chmod 0664 "$birds_db"
  if [ "$PROFILE_INITIALIZED" = 1 ]; then
    mv -T -- "$PROFILE_DB" "$restore_educators_old" \
      || fail 'Could not preserve the current Educators database'
  fi
  if [ "$educator_present" = 1 ]; then
    mv -T -- "$maintenance_work/educators.db" "$PROFILE_DB" \
      || fail 'Could not install the restored Educators database'
  elif [ "$PROFILE_INITIALIZED" = 1 ]; then
    install -o caddy -g caddy -m 0660 /dev/null "$PROFILE_DB"
  fi
  if [ "$restore_mode" != restore-base ]; then
    chown caddy:caddy "$PROFILE_DB" && chmod 0660 "$PROFILE_DB"
    if [ "$educator_present" = 0 ]; then
      run_store init >/dev/null || fail 'Restored Educators history could not be opened'
    fi
    /usr/sbin/runuser -u caddy -- /usr/bin/sqlite3 -batch -bail "$PROFILE_DB" \
      'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null \
      || fail 'Could not finalize restored Educators history'
    validate_birds_snapshot "$birds_db"
    validate_educator_snapshot "$PROFILE_DB" "$SNAPSHOT_GENERATION"
  else
    validate_base_birds_snapshot "$birds_db"
  fi
  if [ "$restore_mode" = restore-import ]; then
    write_profile 0 0
  fi
  sync -f "$birds_db"
  [ "$restore_mode" = restore-base ] || sync -f "$PROFILE_DB"
  sync -f "$(dirname "$birds_db")"
  [ "$restore_mode" = restore-base ] || sync -f "$DATA_DIR"
  sync -f "$extracted"

  committed_mode=$restore_mode-committed
  write_maintenance_state "$committed_mode" "$restore_mode"
  restore_active=0
  discard_restore_rollback \
    || fail 'Could not finalize the restored data transaction'
  remove_maintenance_state "$committed_mode" \
    || fail 'Could not close the restored data transaction'
  if [ "$educator_present" = 1 ]; then
    printf '{"ok":true,"paired":true,"initialized":true}\n'
  elif [ "$PROFILE_INITIALIZED" = 1 ]; then
    printf '%s\n' 'Legacy backup has no Educators history; listening periods and folders were reset.'
    printf '{"ok":true,"paired":false,"initialized":true}\n'
  else
    printf '{"ok":true,"paired":false,"initialized":false}\n'
  fi
}

run_clear_phase() {
  local phase=$1 clear_script=$repo_dir/scripts/clear_all_data.sh status=0 boot_recovery=0
  case "$phase" in core|finish) ;; *) fail 'Internal clear phase is invalid' ;; esac
  if [ "$action" = recover ] && [ "${AVIAN_EDUCATOR_BOOT_RECOVERY:-0}" = 1 ]; then
    boot_recovery=1
  fi
  [ -f "$clear_script" ] && [ ! -L "$clear_script" ] \
    && [ "$(readlink -f -- "$clear_script")" = "$clear_script" ] \
    || fail 'Clear-data script is unsafe or missing'
  exec 12<"$maintenance_token" \
    || fail 'Could not open the Educators maintenance authority'
  /usr/sbin/runuser -u "$birdnet_user" -- \
    /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin \
    AVIAN_EDUCATOR_MAINTENANCE_PHASE="$phase" \
    AVIAN_EDUCATOR_MAINTENANCE_FD=12 \
    AVIAN_EDUCATOR_BOOT_RECOVERY="$boot_recovery" \
    AVIAN_BIRDNET_USER="$birdnet_user" \
    AVIAN_BIRDNET_HOME="$birdnet_home" \
    AVIAN_RECS_DIR="$recordings_root" \
    AVIAN_EXTRACTED="$extracted" \
    AVIAN_PROCESSED="$processed" \
    AVIAN_IDFILE="$identification_file" \
    /bin/bash -c 'exec 9>&- 10>&- 11>&-; exec /bin/bash "$1"' \
    avian-clear "$clear_script" || status=$?
  exec 12<&-
  return "$status"
}

prepare_maintenance_authority() {
  local before opened
  maintenance_token=$(mktemp "$AUTH_DIR/.educators-maintenance.XXXXXX") \
    || fail 'Could not create the Educators maintenance authority'
  printf 'v1\n' >"$maintenance_token"
  chown root:caddy "$maintenance_token"
  chmod 0400 "$maintenance_token"
  sync -f "$maintenance_token"
  before=$(stat -c '%d:%i' -- "$maintenance_token") \
    || fail 'Could not inspect the Educators maintenance authority'
  exec 12<"$maintenance_token" \
    || fail 'Could not verify the Educators maintenance authority'
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h' -- /proc/self/fd/12) \
    || fail 'Could not inspect the opened Educators maintenance authority'
  exec 12<&-
  [ "$opened" = "$before:0:$caddy_gid:400:1" ] \
    || fail 'Educators maintenance authority is unsafe'
}

restart_maintenance_services() {
  local service status=0
  local -a services=(
    chart_viewer.service
    spectrogram_viewer.service
    icecast2.service
    birdnet_recording.service
    birdnet_analysis.service
    birdnet_log.service
    birdnet_stats.service
  )
  for service in "${services[@]}"; do
    systemctl restart "$service" || status=$?
  done
  [ "$status" = 0 ] \
    || fail 'One or more services could not be restarted after data maintenance'
}

clear_all_data() {
  local maintenance_status=0
  read_maintenance_state || maintenance_status=$?
  case "$maintenance_status" in
    2) write_maintenance_state clear ;;
    0) [ "$MAINTENANCE_MODE" = clear ] \
      || fail 'Another Educators maintenance operation is active' ;;
    *) fail 'Educators maintenance state is unsafe or malformed' ;;
  esac
  prepare_maintenance_authority
  run_clear_phase core \
    || fail 'BirdNET-Pi data could not be cleared'
  [ -f "$birds_db" ] && [ ! -L "$birds_db" ] \
    && [ "$(readlink -f -- "$birds_db")" = "$birds_db" ] \
    && [ "$(stat -c '%h' -- "$birds_db")" = 1 ] \
    || fail 'Recreated detections database is unsafe or missing'
  ensure_birds_generation 1
  run_store reset-data >/dev/null \
    || fail 'Educators data could not be reset after clearing detections'
  run_clear_phase finish \
    || fail 'BirdNET-Pi services could not be restored after clearing data'
  remove_maintenance_state clear \
    || fail 'Could not close the data-clearing transaction'
  if [ "$action" = recover ] && [ "${AVIAN_EDUCATOR_BOOT_RECOVERY:-0}" = 1 ]; then
    printf '{"ok":true,"enabled":%s,"epoch":%s,"cleared":true,"boot_recovery":true}\n' \
      "$([ "$PROFILE_ENABLED" = 1 ] && printf true || printf false)" "$PROFILE_EPOCH"
    return
  fi
  restart_maintenance_services
  printf '{"ok":true,"enabled":%s,"epoch":%s,"cleared":true}\n' \
    "$([ "$PROFILE_ENABLED" = 1 ] && printf true || printf false)" "$PROFILE_EPOCH"
}

clear_base_data() {
  local maintenance_status=0
  read_maintenance_state || maintenance_status=$?
  case "$maintenance_status" in
    2) write_maintenance_state clear-base ;;
    0) [ "$MAINTENANCE_MODE" = clear-base ] \
      || fail 'Another Educators maintenance operation is active' ;;
    *) fail 'Educators maintenance state is unsafe or malformed' ;;
  esac
  prepare_maintenance_authority
  run_clear_phase core \
    || fail 'BirdNET-Pi data could not be cleared'
  require_live_birds_database
  validate_base_birds_snapshot "$birds_db"
  run_clear_phase finish \
    || fail 'BirdNET-Pi services could not be restored after clearing data'
  remove_maintenance_state clear-base \
    || fail 'Could not close the data-clearing transaction'
  if [ "$action" = recover ] && [ "${AVIAN_EDUCATOR_BOOT_RECOVERY:-0}" = 1 ]; then
    printf '{"ok":true,"enabled":false,"epoch":0,"cleared":true,"boot_recovery":true}\n'
    return
  fi
  restart_maintenance_services
  printf '{"ok":true,"enabled":false,"epoch":0,"cleared":true}\n'
}

recover_restore_state() {
  local mode=$1 base_mode committed=0
  case "$mode" in
    restore|restore-base|restore-import) base_mode=$mode ;;
    restore-committed|restore-base-committed|restore-import-committed)
      base_mode=${mode%-committed}
      committed=1
      ;;
    *) fail 'Restore recovery state is invalid' ;;
  esac
  restore_mode=$base_mode
  if [ "$committed" = 0 ]; then
    restore_active=1
    rollback_restore \
      || fail 'Interrupted restore could not be rolled back safely'
  fi

  require_live_birds_database
  [ -d "$extracted/By_Date" ] && [ ! -L "$extracted/By_Date" ] \
    && [ "$(readlink -f -- "$extracted/By_Date")" = "$extracted/By_Date" ] \
    && [ -d "$extracted/Charts" ] && [ ! -L "$extracted/Charts" ] \
    && [ "$(readlink -f -- "$extracted/Charts")" = "$extracted/Charts" ] \
    || fail 'Recovered media is incomplete'
  inspect_profile_storage_readonly

  case "$base_mode:$committed:$PROFILE_INITIALIZED" in
    restore:*:1|restore-import:1:1)
      validate_birds_snapshot "$birds_db"
      validate_educator_snapshot "$PROFILE_DB" "$SNAPSHOT_GENERATION"
      run_store validate >/dev/null \
        || fail 'Recovered data authority is invalid'
      if [ "$base_mode" = restore-import ]; then
        [ "$PROFILE_ENABLED:$PROFILE_EPOCH" = 0:0 ] \
          || fail 'Imported Educators profile state is invalid'
      fi
      ;;
    restore-base:*:0|restore-import:0:0)
      validate_base_birds_snapshot "$birds_db"
      ;;
    restore:*|restore-import:*|restore-base:*)
      fail 'Recovered profile storage does not match the restore state'
      ;;
  esac

  if [ "$committed" = 1 ]; then
    discard_restore_rollback \
      || fail 'Committed restore cleanup could not be completed'
  fi
  remove_maintenance_state "$mode" \
    || fail 'Restore recovery could not be closed'
}

install_recovery_unit() {
  local systemd_dir=/etc/systemd/system unit_path unit_temp service dropin_dir dropin_path dropin_temp
  local -a guarded_services=(
    caddy.service
    icecast2.service
    birdnet_recording.service
    birdnet_analysis.service
    birdnet_stats.service
    birdnet_log.service
    chart_viewer.service
    spectrogram_viewer.service
    livestream.service
  )
  [ -d "$systemd_dir" ] && [ ! -L "$systemd_dir" ] \
    && [ "$(stat -c '%u:%g' -- "$systemd_dir")" = 0:0 ] \
    && [ $(( 8#$(stat -c '%a' -- "$systemd_dir") & 0022 )) = 0 ] \
    || fail 'Systemd unit directory is unsafe'
  unit_path=$systemd_dir/avian-educators-recover.service
  if [ -e "$unit_path" ] || [ -L "$unit_path" ]; then
    [ -f "$unit_path" ] && [ ! -L "$unit_path" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "$unit_path")" = 0:0:644:1 ] \
      || fail 'Educators recovery unit is unsafe'
  fi
  unit_temp=$(mktemp "$systemd_dir/.avian-educators-recover.XXXXXX") \
    || fail 'Could not stage the Educators recovery unit'
  printf '%s\n' \
    '[Unit]' \
    'Description=Recover interrupted Avian Visitors data maintenance' \
    'After=local-fs.target' \
    'Before=caddy.service icecast2.service birdnet_recording.service birdnet_analysis.service birdnet_stats.service birdnet_log.service chart_viewer.service spectrogram_viewer.service livestream.service' \
    'ConditionPathExists=/var/lib/avian-visitors/educators.maintenance' \
    '' \
    '[Service]' \
    'Type=oneshot' \
    'Environment=AVIAN_EDUCATOR_BOOT_RECOVERY=1' \
    'ExecStart=/usr/local/sbin/avian-educators recover' \
    'TimeoutStartSec=15min' \
    '' \
    '[Install]' \
    'WantedBy=multi-user.target' \
    >"$unit_temp"
  chown root:root "$unit_temp" && chmod 0644 "$unit_temp" \
    || fail 'Could not secure the Educators recovery unit'
  mv -fT -- "$unit_temp" "$unit_path"
  sync -f "$unit_path"
  for service in "${guarded_services[@]}"; do
    dropin_dir=$systemd_dir/$service.d
    if [ -e "$dropin_dir" ] || [ -L "$dropin_dir" ]; then
      [ -d "$dropin_dir" ] && [ ! -L "$dropin_dir" ] \
        && [ "$(stat -c '%u:%g' -- "$dropin_dir")" = 0:0 ] \
        && [ $(( 8#$(stat -c '%a' -- "$dropin_dir") & 0022 )) = 0 ] \
        || fail "Service recovery drop-in directory is unsafe: $service"
    else
      install -d -o root -g root -m 0755 "$dropin_dir"
    fi
    dropin_path=$dropin_dir/05-avian-educators-recovery.conf
    if [ -e "$dropin_path" ] || [ -L "$dropin_path" ]; then
      [ -f "$dropin_path" ] && [ ! -L "$dropin_path" ] \
        && [ "$(stat -c '%u:%g:%a:%h' -- "$dropin_path")" = 0:0:644:1 ] \
        || fail "Service recovery drop-in is unsafe: $service"
    fi
    dropin_temp=$(mktemp "$dropin_dir/.avian-educators-recovery.XXXXXX") \
      || fail "Could not stage the service recovery drop-in: $service"
    printf '%s\n' \
      '[Unit]' \
      'Requires=avian-educators-recover.service' \
      'After=avian-educators-recover.service' \
      >"$dropin_temp"
    chown root:root "$dropin_temp" && chmod 0644 "$dropin_temp" \
      || fail "Could not secure the service recovery drop-in: $service"
    mv -fT -- "$dropin_temp" "$dropin_path"
  done
  sync -f "$systemd_dir"
  systemctl daemon-reload \
    && systemctl enable avian-educators-recover.service >/dev/null \
    || fail 'Could not enable the Educators recovery unit'
  printf '{"ok":true,"recovery_unit":true}\n'
}

refresh_caddy() {
  local close=${1:-0}
  safe_root_helper "$CADDY_REFRESH" \
    || fail "root-owned Caddy helper is missing or unsafe: $CADDY_REFRESH"
  AVIAN_AUTH_LOCK_FD=9 AVIAN_CLOSE_STREAMS="$close" "$CADDY_REFRESH"
}

action=${1:-status}
if [ "$action" = discard-snapshot ]; then
  [ "$#" -eq 2 ] \
    || fail 'Usage: avian-educators enable|disable|status|reset-data'
else
  [ "$#" -eq 1 ] \
    || fail 'Usage: avian-educators enable|disable|status|reset-data'
fi
case "$action" in enable|disable|status|refresh-install|reset-data|backup-snapshot|restore-staged|clear-all|discard-snapshot|recover|restart-services|install-recovery-unit) ;; *)
  fail 'Usage: avian-educators enable|disable|status|reset-data'
esac

if [ "$action" = install-recovery-unit ]; then
  install_recovery_unit
  exit 0
fi

# Status is deliberately read-only. A missing canonical state is the normal
# disabled state on stations that have never opted into Educators.
if [ "$action" = status ]; then
  inspect_profile_storage_readonly
  require_no_maintenance_readonly
  print_profile_status
  exit 0
fi

# Updates only migrate an already-enabled profile. Disabled and never-enabled
# stations retain their databases and detection schema byte-for-byte.
if [ "$action" = refresh-install ]; then
  inspect_profile_storage_readonly
  require_no_maintenance_readonly
  # Every installed station needs this coordination lock because ordinary
  # global API reads use it to exclude clear and restore transitions even
  # when the optional profile has never been initialized.
  ensure_root_dir
  open_lock "$AUTH_LOCK" 9 '0:0:600:1'
  open_lock "$PROFILE_LOCK" 10 "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):660:1"
  inspect_profile_storage_readonly
  require_no_maintenance
  if [ "$PROFILE_STATUS" = 2 ] || [ "$PROFILE_ENABLED" = 0 ]; then
    print_profile_status
    exit 0
  fi
  resolve_store
  require_live_birds_database
  ensure_runtime_layout
  ensure_birds_generation 0
  run_store init >/dev/null
  printf '{"ok":true,"enabled":true,"epoch":%s,"refreshed":true}\n' \
    "$PROFILE_EPOCH"
  exit 0
fi

# Disable is also a no-op for absent or already-disabled profiles. In
# particular, it must not initialize optional storage just to confirm state.
if [ "$action" = disable ]; then
  inspect_profile_storage_readonly
  require_no_maintenance_readonly
  if [ "$PROFILE_STATUS" = 2 ] || [ "$PROFILE_ENABLED" = 0 ]; then
    printf '{"ok":true,"enabled":false,"changed":false,"epoch":%s}\n' \
      "$PROFILE_EPOCH"
    exit 0
  fi
fi

resolve_store
ensure_root_dir
if [ "$action" = discard-snapshot ]; then
  open_lock "$BACKUP_LOCK" 11 '0:0:600:1'
  ensure_backup_layout
  caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] || fail 'Caddy group was not found'
  require_no_maintenance_readonly
  discard_backup_pair "$2"
  exit 0
fi
if [ "$action" = backup-snapshot ]; then
  open_lock "$BACKUP_LOCK" 11 '0:0:600:1'
  open_lock "$PROFILE_LOCK" 10 "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):660:1" shared
  inspect_profile_storage_readonly
  require_no_maintenance
  require_live_birds_database
  if [ "$PROFILE_INITIALIZED" = 0 ]; then
    ensure_backup_layout
    prepare_base_backup_pair
    exit 0
  fi
  ensure_runtime_layout
  ensure_birds_generation 0
  prepare_backup_pair
  exit 0
fi
if [ "$action" = restore-staged ]; then
  open_lock "$BACKUP_LOCK" 11 '0:0:600:1'
  open_lock "$PROFILE_LOCK" 10 "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):660:1" exclusive
  inspect_profile_readonly
  maintenance_status=0
  read_maintenance_state || maintenance_status=$?
  case "$maintenance_status" in
    2) ;;
    0) case "$MAINTENANCE_MODE" in
      restore|restore-committed|restore-base|restore-base-committed|restore-import|restore-import-committed)
        recover_restore_state "$MAINTENANCE_MODE"
        ;;
      *) fail "Different Educators maintenance recovery is required: $MAINTENANCE_MODE" ;;
    esac ;;
    *) fail 'Educators maintenance state is unsafe or malformed' ;;
  esac
  inspect_profile_storage_readonly
  require_live_birds_database
  if [ "$PROFILE_INITIALIZED" = 1 ]; then
    ensure_runtime_layout
  else
    validate_base_birds_snapshot "$birds_db"
  fi
  restore_staged_pair
  exit 0
fi
if [ "$action" = clear-all ]; then
  open_lock "$BACKUP_LOCK" 11 '0:0:600:1'
  open_lock "$PROFILE_LOCK" 10 "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):660:1" exclusive
  inspect_profile_storage_readonly
  maintenance_status=0
  read_maintenance_state || maintenance_status=$?
  case "$maintenance_status" in
    2) require_live_birds_database ;;
    0) case "$MAINTENANCE_MODE:$PROFILE_INITIALIZED" in
      clear:1|clear-base:0) ;;
      clear:*|clear-base:*) fail 'Data-clearing recovery state does not match the profile storage' ;;
      *) fail "Different Educators maintenance recovery is required: $MAINTENANCE_MODE" ;;
    esac ;;
    *) fail 'Educators maintenance state is unsafe or malformed' ;;
  esac
  if [ "$PROFILE_INITIALIZED" = 1 ]; then
    ensure_runtime_layout
    clear_all_data
  else
    clear_base_data
  fi
  exit 0
fi
if [ "$action" = recover ]; then
  open_lock "$BACKUP_LOCK" 11 '0:0:600:1'
  open_lock "$PROFILE_LOCK" 10 "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):660:1" exclusive
  inspect_profile_readonly
  maintenance_status=0
  read_maintenance_state || maintenance_status=$?
  case "$maintenance_status" in
    2)
      inspect_profile_storage_readonly
      require_live_birds_database
      if [ "$PROFILE_INITIALIZED" = 1 ]; then
        ensure_runtime_layout
        validate_birds_snapshot "$birds_db"
        validate_educator_snapshot "$PROFILE_DB" "$SNAPSHOT_GENERATION"
        run_store validate >/dev/null \
          || fail 'Educators data authority is invalid'
      else
        validate_base_birds_snapshot "$birds_db"
      fi
      printf '{"ok":true,"recovered":false}\n'
      ;;
    0) case "$MAINTENANCE_MODE" in
      clear)
        inspect_profile_storage_readonly
        [ "$PROFILE_INITIALIZED" = 1 ] \
          || fail 'Data-clearing recovery state does not match the profile storage'
        ensure_runtime_layout
        clear_all_data
        ;;
      clear-base)
        inspect_profile_storage_readonly
        [ "$PROFILE_INITIALIZED" = 0 ] \
          || fail 'Data-clearing recovery state does not match the profile storage'
        clear_base_data
        ;;
      restore|restore-committed|restore-base|restore-base-committed|restore-import|restore-import-committed)
        recover_restore_state "$MAINTENANCE_MODE"
        if [ "${AVIAN_EDUCATOR_BOOT_RECOVERY:-0}" != 1 ]; then
          restart_maintenance_services
        fi
        printf '{"ok":true,"recovered":true,"operation":"restore"}\n'
        ;;
    esac ;;
    *) fail 'Educators maintenance state is unsafe or malformed' ;;
  esac
  exit 0
fi
if [ "$action" = restart-services ]; then
  open_lock "$BACKUP_LOCK" 11 '0:0:600:1'
  open_lock "$PROFILE_LOCK" 10 "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):660:1" exclusive
  inspect_profile_storage_readonly
  require_no_maintenance
  require_live_birds_database
  if [ "$PROFILE_INITIALIZED" = 1 ]; then
    ensure_runtime_layout
    ensure_birds_generation 0
    run_store validate >/dev/null \
      || fail 'Data authority is invalid; services remain stopped'
  else
    validate_base_birds_snapshot "$birds_db"
  fi
  restart_maintenance_services
  printf '{"ok":true,"services_restarted":true}\n'
  exit 0
fi
open_lock "$AUTH_LOCK" 9 '0:0:600:1'
open_lock "$PROFILE_LOCK" 10 "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):660:1"
inspect_profile_storage_readonly
require_no_maintenance
require_live_birds_database
if [ "$PROFILE_INITIALIZED" = 1 ]; then
  ensure_runtime_layout
elif [ "$action" != enable ]; then
  fail 'Educators mode has not been initialized'
fi
if [ "$action" = reset-data ]; then
  # Replacing birds.db must invalidate every saved row range before metadata is
  # cleared. A failure after this point remains fail-closed on generation.
  ensure_birds_generation 1
  run_store reset-data >/dev/null \
    || fail 'Educators data could not be reset'
  printf '{"ok":true,"enabled":%s,"epoch":%s,"reset":true}\n' \
    "$([ "$PROFILE_ENABLED" = 1 ] && printf true || printf false)" "$PROFILE_EPOCH"
  exit 0
fi

case "$action" in
  enable)
    changed=false
    if [ "$PROFILE_ENABLED" = 0 ]; then
      [ "$PROFILE_EPOCH" -le $((EPOCH_MAX - 2)) ] \
        || fail 'Educators epoch cannot safely be advanced'
      old_epoch=$PROFILE_EPOCH
      # Close any pre-profile live backend before enabling the protected proxy.
      refresh_caddy 1 >/dev/null \
        || fail 'Could not establish the protected live audio boundary'
      if [ "$PROFILE_INITIALIZED" = 0 ]; then
        ensure_runtime_layout
      fi
      ensure_birds_generation 0
      run_store init >/dev/null \
        || fail 'Educators data could not be initialized'
      write_profile 1 "$((old_epoch + 1))"
      if ! refresh_caddy 0 >/dev/null; then
        write_profile 0 "$((old_epoch + 2))"
        refresh_caddy 1 >/dev/null 2>&1 || true
        fail 'Educators mode could not be enabled; disabled state was restored'
      fi
      changed=true
    else
      ensure_birds_generation 0
      run_store init >/dev/null \
        || fail 'Educators data could not be validated'
      refresh_caddy 0 >/dev/null \
        || fail 'Educators mode is enabled, but live audio policy could not be reconciled'
    fi
    printf '{"ok":true,"enabled":true,"changed":%s,"epoch":%s}\n' \
      "$changed" "$PROFILE_EPOCH"
    ;;
  disable)
    changed=false
    if [ "$PROFILE_ENABLED" = 1 ]; then
      [ "$PROFILE_EPOCH" -lt "$EPOCH_MAX" ] \
        || fail 'Educators epoch cannot be advanced'
      run_store stop-current >/dev/null \
        || fail 'Educators mode remains enabled because the active listening period could not be stopped safely'
      write_profile 0 "$((PROFILE_EPOCH + 1))"
      changed=true
    else
      run_store stop-current >/dev/null \
        || fail 'Educators mode is disabled, but the active listening period could not be stopped safely'
    fi
    refresh_status=0
    refresh_caddy 1 >/dev/null || refresh_status=$?
    [ "$refresh_status" = 0 ] \
      || fail 'Educators mode is disabled, but live audio policy could not be reconciled'
    printf '{"ok":true,"enabled":false,"changed":%s,"epoch":%s}\n' \
      "$changed" "$PROFILE_EPOCH"
    ;;
esac
