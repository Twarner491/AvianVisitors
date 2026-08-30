#!/usr/bin/env bash
# Root-owned control plane for the small set of privileged admin actions used
# by the AvianVisitors web interface. The caddy user may invoke this installed
# copy through sudo, but every action and argument is validated here.

set -euo pipefail
IFS=$'\n\t'
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
umask 077

CONTROL_VERSION=3
readonly CADDY_REFRESH=/usr/local/sbin/avian-caddy-refresh
readonly AUTH_DIR=/var/lib/avian-visitors
readonly AUTH_LOCK=$AUTH_DIR/admin-auth.lock
readonly AUTH_STATE=$AUTH_DIR/admin-auth.state
readonly AUTH_MARKER=$AUTH_DIR/admin-auth.initialized
readonly AUTH_RATE=$AUTH_DIR/admin-auth.rate
readonly AUTH_EPOCH_MAX=2147483647

json_escape() {
  local value=${1-}
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '%s' "$value"
}

fail() {
  local message=${1:-admin control failed}
  printf '{"ok":false,"error":"%s"}\n' "$(json_escape "$message")"
  exit 1
}

[ "${EUID:-$(id -u)}" -eq 0 ] || fail "admin control must run as root"

state_temp=''
rate_temp=''
updates_temp=''
config_temp=''
password_config_write=0
cleanup() {
  rm -f -- "${state_temp:-}" "${rate_temp:-}" "${updates_temp:-}" "${config_temp:-}"
}
trap cleanup EXIT INT TERM HUP

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
  local file=$1 wanted=$2 line raw valid=0 found=0 parsed value=''
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

birdnet_user=''
if [ -r /etc/birdnet/birdnet.conf ]; then
  birdnet_user=$(conf_value /etc/birdnet/birdnet.conf BIRDNET_USER) || birdnet_user=''
fi
if [ -z "$birdnet_user" ]; then
  while IFS=: read -r candidate _ uid _ _ candidate_home shell; do
    if [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ] \
      && [[ "$shell" != *nologin ]] && [[ "$shell" != *false ]] \
      && [ -d "$candidate_home/BirdNET-Pi" ]; then
      birdnet_user=$candidate
      break
    fi
  done < <(getent passwd)
fi
[[ "$birdnet_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || fail "could not resolve the BirdNET-Pi user"

passwd_row=$(getent passwd "$birdnet_user")
[ -n "$passwd_row" ] || fail "BirdNET-Pi user does not exist"
birdnet_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
birdnet_group=$(id -gn "$birdnet_user")
if ! [[ "$birdnet_home" =~ ^/[A-Za-z0-9._/-]+$ \
  && "$birdnet_home" != *'..'* ]]; then
  fail "BirdNET-Pi home path is not safe"
fi
birdnet_home=$(readlink -f -- "$birdnet_home") \
  || fail "BirdNET-Pi home path was not found"

repo_dir=$birdnet_home/BirdNET-Pi
if [ -L "$repo_dir" ] || [ ! -d "$repo_dir" ]; then
  fail "BirdNET-Pi checkout path is not safe"
fi
conf_link=/etc/birdnet/birdnet.conf
if [ -e "$conf_link" ] || [ -L "$conf_link" ]; then
  conf_path=$(readlink -f "$conf_link")
else
  conf_path=$repo_dir/birdnet.conf
fi
case "$conf_path" in
  "$repo_dir/birdnet.conf"|/etc/birdnet/birdnet.conf) ;;
  *) fail "BirdNET-Pi config path is not safe" ;;
esac

known_unit() {
  case "${1-}" in
    birdnet_recording|birdnet_analysis|birdnet_log|birdnet_stats|spectrogram_viewer|livestream|chart_viewer|icecast2|caddy|php8.2-fpm|php8.3-fpm|php8.4-fpm) return 0 ;;
    *) return 1 ;;
  esac
}

restartable_unit() {
  case "${1-}" in
    birdnet_recording|birdnet_analysis|birdnet_log|birdnet_stats|spectrogram_viewer|livestream|chart_viewer|icecast2) return 0 ;;
    *) return 1 ;;
  esac
}

valid_number() {
  local value=$1 minimum=$2 maximum=$3
  [ "${#value}" -le 32 ] || return 1
  [[ "$value" =~ ^-?[0-9]+([.][0-9]+)?$ ]] || return 1
  awk -v n="$value" -v lo="$minimum" -v hi="$maximum" \
    'BEGIN { exit !(n >= lo && n <= hi) }'
}

valid_config_value() {
  local key=$1 value=$2
  case "$key" in
    CONFIDENCE) valid_number "$value" 0.05 0.99 ;;
    SENSITIVITY) valid_number "$value" 0.5 1.5 ;;
    SF_THRESH) valid_number "$value" 0.0005 0.99 ;;
    OVERLAP) valid_number "$value" 0 2.5 ;;
    LATITUDE) valid_number "$value" -90 90 ;;
    LONGITUDE) valid_number "$value" -180 180 ;;
    MAX_FILES_SPECIES)
      [[ "$value" =~ ^[0-9]{1,6}$ ]] && [ "$value" -le 100000 ]
      ;;
    PURGE_THRESHOLD)
      [[ "$value" =~ ^[0-9]{1,2}$ ]] && [ "$value" -ge 50 ] && [ "$value" -le 99 ]
      ;;
    FULL_DISK) [ "$value" = purge ] || [ "$value" = keep ] ;;
    BIRDWEATHER_ID)
      [ -z "$value" ] || {
        [ "$value" != . ] && [ "$value" != .. ] \
          && [ "${#value}" -le 160 ] && [[ "$value" =~ ^[A-Za-z0-9._~-]+$ ]]
      }
      ;;
    BIRDWEATHER_ENABLED|BIRDWEATHER_UPLOAD_AUDIO)
      [ "$value" = 0 ] || [ "$value" = 1 ]
      ;;
    PRIVACY_THRESHOLD)
      [[ "$value" =~ ^[0-3]$ ]]
      ;;
    CADDY_PWD)
      [ "$password_config_write" = 1 ] \
        && { [ -z "$value" ] || [[ "$value" =~ ^[A-Za-z0-9]{1,64}$ ]]; }
      ;;
    COLLAGE_LABELS) [ "$value" = on ] || [ "$value" = off ] ;;
    SITE_NAME)
      [ "${#value}" -le 60 ] && [[ "$value" =~ ^[A-Za-z0-9\ _.,\047-]*$ ]]
      ;;
    GEMINI_API_KEY)
      [ "${#value}" -le 200 ] && [[ "$value" =~ ^[A-Za-z0-9_.\/+\=:-]*$ ]]
      ;;
    EBIRD_API_KEY)
      [ "${#value}" -le 120 ] && [[ "$value" =~ ^[A-Za-z0-9_.\/+\=:-]*$ ]]
      ;;
    *) return 1 ;;
  esac
}

safe_root_helper() {
  local helper=$1
  [ ! -L "$helper" ] && [ -f "$helper" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$helper")" = '0:0:755:1' ]
}

web_runtime_caller() {
  local caddy_uid=''
  caddy_uid=$(id -u caddy 2>/dev/null) || caddy_uid=''
  [ "${SUDO_USER:-}" = caddy ] \
    || { [ -n "$caddy_uid" ] && [ "${SUDO_UID:-}" = "$caddy_uid" ]; }
}

lock_auth_state() {
  local before opened
  [ -d "$AUTH_DIR" ] && [ ! -L "$AUTH_DIR" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$AUTH_DIR")" = '0:0:755' ] \
    || fail "admin state directory is unsafe"
  [ -f "$AUTH_LOCK" ] && [ ! -L "$AUTH_LOCK" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$AUTH_LOCK")" = '0:0:600:1' ] \
    || fail "admin state lock is unsafe"
  before=$(stat -c '%d:%i' -- "$AUTH_LOCK") \
    || fail "could not inspect admin state lock"
  exec 9<>"$AUTH_LOCK"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h' -- /proc/self/fd/9) \
    || fail "could not inspect opened admin state lock"
  [ "$opened" = "$before:0:0:600:1" ] \
    || fail "admin state lock changed while opening"
  flock -x 9 || fail "could not lock admin state"
  [ "$(stat -c '%d:%i' -- "$AUTH_LOCK")" = "$before" ] \
    || fail "admin state lock changed while locking"
  export AVIAN_AUTH_LOCK_FD=9
}

read_auth_state() {
  local caddy_gid before opened size raw version required epoch verifier extra
  AUTH_REQUIRED=1
  AUTH_EPOCH=invalid
  AUTH_VERIFIER=-
  if [ ! -e "$AUTH_STATE" ] && [ ! -L "$AUTH_STATE" ]; then
    return 2
  fi
  caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] || return 3
  [ -f "$AUTH_STATE" ] && [ ! -L "$AUTH_STATE" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$AUTH_STATE")" = "0:$caddy_gid:640:1" ] \
    || return 3
  before=$(stat -c '%d:%i' -- "$AUTH_STATE") || return 3
  exec 8<"$AUTH_STATE"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/8) || return 3
  size=${opened##*:}
  [ "$opened" = "$before:0:$caddy_gid:640:1:$size" ] || return 3
  [ "$size" -ge 1 ] && [ "$size" -le 256 ] || return 3
  raw=$(cat <&8)
  [ "$size" -eq $(( ${#raw} + 1 )) ] || return 3
  IFS=$'\t' read -r version required epoch verifier extra <<<"$raw"
  [ -z "${extra:-}" ] \
    && [ "$raw" = "$version"$'\t'"$required"$'\t'"$epoch"$'\t'"$verifier" ] \
    && [ "$version" = v1 ] \
    && { [ "$required" = 0 ] || [ "$required" = 1 ]; } \
    && [[ "$epoch" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$epoch" -le "$AUTH_EPOCH_MAX" ] \
    || return 3
  if [ "$verifier" != - ]; then
    [[ "$verifier" =~ ^\$2y\$14\$[./A-Za-z0-9]{53}$ ]] || return 3
  fi
  [ "$(stat -c '%d:%i' -- "$AUTH_STATE")" = "$before" ] || return 3
  AUTH_REQUIRED=$required
  AUTH_EPOCH=$epoch
  AUTH_VERIFIER=$verifier
  return 0
}

prepare_auth_state() {
  local required=$1 epoch=$2 verifier=$3 caddy_gid
  { [ "$required" = 0 ] || [ "$required" = 1 ]; } \
    || fail "invalid admin auth policy"
  [[ "$epoch" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$epoch" -le "$AUTH_EPOCH_MAX" ] \
    || fail "invalid admin auth epoch"
  if [ "$verifier" != - ]; then
    [[ "$verifier" =~ ^\$2y\$14\$[./A-Za-z0-9]{53}$ ]] \
      || fail "invalid admin password verifier"
  fi
  caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] || fail "caddy group was not found"
  state_temp=$(mktemp "$AUTH_DIR/.admin-auth.state.XXXXXX") \
    || fail "could not create admin state"
  printf 'v1\t%s\t%s\t%s\n' "$required" "$epoch" "$verifier" >"$state_temp" \
    || fail "could not write admin state"
  chown root:"$caddy_gid" "$state_temp" \
    || fail "could not set admin state owner"
  chmod 0640 "$state_temp" \
    || fail "could not set admin state mode"
  sync -f "$state_temp" \
    || fail "could not sync admin state"
}

commit_auth_state() {
  local required=$1 epoch=$2 verifier=$3 candidate=$state_temp
  [ -n "$candidate" ] && [ -f "$candidate" ] && [ ! -L "$candidate" ] \
    || return 1
  mv -fT -- "$state_temp" "$AUTH_STATE" || return 1
  state_temp=''
  sync -f "$AUTH_DIR" || return 1
  read_auth_state || return 1
  [ "$AUTH_REQUIRED:$AUTH_EPOCH:$AUTH_VERIFIER" = "$required:$epoch:$verifier" ] \
    || return 1
}

write_auth_state() {
  prepare_auth_state "$@"
  commit_auth_state "$@" || fail "could not commit admin state"
}

REQUIRED_RECOVERY_STATUS=''
prepare_recovery_auth_state() {
  local required=$1 epoch=$2 verifier=$3 caddy_gid
  { [ "$required" = 0 ] || [ "$required" = 1 ]; } || return 1
  [[ "$epoch" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
    && [ "$epoch" -le "$AUTH_EPOCH_MAX" ] \
    || return 1
  if [ "$verifier" != - ]; then
    [[ "$verifier" =~ ^\$2y\$14\$[./A-Za-z0-9]{53}$ ]] || return 1
  fi
  caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] || return 1
  state_temp=$(mktemp "$AUTH_DIR/.admin-auth.state.XXXXXX") || return 1
  printf 'v1\t%s\t%s\t%s\n' "$required" "$epoch" "$verifier" >"$state_temp" \
    && chown root:"$caddy_gid" "$state_temp" \
    && chmod 0640 "$state_temp" \
    && sync -f "$state_temp"
}

reconcile_required_policy() {
  local epoch=$1 verifier=$2 refresh_status=0
  REQUIRED_RECOVERY_STATUS=state
  rm -f -- "${state_temp:-}"
  state_temp=''
  if ! prepare_recovery_auth_state 1 "$epoch" "$verifier" \
    || ! commit_auth_state 1 "$epoch" "$verifier"; then
    return 0
  fi
  AVIAN_CLOSE_STREAMS=1 "$CADDY_REFRESH" >/dev/null 2>&1 \
    || refresh_status=$?
  REQUIRED_RECOVERY_STATUS=$refresh_status
  if [ "$refresh_status" = 0 ]; then
    if ! read_auth_state \
      || [ "$AUTH_REQUIRED:$AUTH_EPOCH:$AUTH_VERIFIER" != "1:$epoch:$verifier" ]; then
      REQUIRED_RECOVERY_STATUS=state
    fi
  fi
  return 0
}

fail_required_recovery() {
  local context=$1
  case "$REQUIRED_RECOVERY_STATUS" in
    0)
      fail "$context; the required state, Caddy barrier, Icecast start block, and live audio cutoff were restored and verified; LAN password protection remains enabled"
      ;;
    20)
      fail "$context; the required state, Caddy barrier, and Icecast start block were restored, but live audio cutoff could not be verified; over SSH run sudo systemctl stop icecast2, then run sudo /usr/local/sbin/avian-caddy-refresh and verify the service is inactive and /stream returns 404"
      ;;
    *)
      fail "$context; the saved state requires a password, but Caddy, the Icecast start block, and live audio cutoff could not be verified; over SSH run sudo /usr/local/sbin/avian-caddy-refresh and sudo systemctl stop icecast2, then verify the service is inactive and /stream returns 404"
      ;;
  esac
}

auth_marker_status() {
  local before opened size raw
  if [ ! -e "$AUTH_MARKER" ] && [ ! -L "$AUTH_MARKER" ]; then
    return 2
  fi
  [ -f "$AUTH_MARKER" ] && [ ! -L "$AUTH_MARKER" ] \
    && [ "$(stat -c '%u:%g:%a:%h:%s' -- "$AUTH_MARKER")" = '0:0:400:1:3' ] \
    || return 3
  before=$(stat -c '%d:%i' -- "$AUTH_MARKER") || return 3
  exec 7<"$AUTH_MARKER"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/7) || return 3
  size=${opened##*:}
  [ "$opened" = "$before:0:0:400:1:3" ] || return 3
  raw=$(cat <&7)
  [ "$size" = 3 ] && [ "$raw" = v1 ] || return 3
  [ "$(stat -c '%d:%i' -- "$AUTH_MARKER")" = "$before" ] || return 3
}

write_auth_marker() {
  local marker_temp
  marker_temp=$(mktemp "$AUTH_DIR/.admin-auth.initialized.XXXXXX") \
    || fail "could not create admin state marker"
  printf 'v1\n' >"$marker_temp" \
    || fail "could not write admin state marker"
  chown root:root "$marker_temp" \
    || fail "could not set admin state marker owner"
  chmod 0400 "$marker_temp" \
    || fail "could not set admin state marker mode"
  sync -f "$marker_temp" \
    || fail "could not sync admin state marker"
  mv -fT -- "$marker_temp" "$AUTH_MARKER" \
    || fail "could not install admin state marker"
  sync -f "$AUTH_DIR" \
    || fail "could not sync admin state marker directory"
  auth_marker_status || fail "written admin state marker did not validate"
}

reset_admin_rate_state() {
  local caddy_gid before opened raw
  caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] || fail "caddy group was not found"
  if [ -e "$AUTH_RATE" ] || [ -L "$AUTH_RATE" ]; then
    [ -f "$AUTH_RATE" ] && [ ! -L "$AUTH_RATE" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "$AUTH_RATE")" = "0:$caddy_gid:660:1" ] \
      || fail "Unsafe admin rate state"
  fi
  rate_temp=$(mktemp "$AUTH_DIR/.admin-auth.rate.XXXXXX") \
    || fail "could not create admin rate state"
  printf '{"version":1,"entries":{}}\n' >"$rate_temp" \
    || fail "could not write admin rate state"
  chown root:"$caddy_gid" "$rate_temp" \
    || fail "could not set admin rate state owner"
  chmod 0660 "$rate_temp" \
    || fail "could not set admin rate state mode"
  sync -f "$rate_temp" \
    || fail "could not sync admin rate state"
  mv -fT -- "$rate_temp" "$AUTH_RATE" \
    || fail "could not install admin rate state"
  rate_temp=''
  sync -f "$AUTH_DIR" \
    || fail "could not sync admin rate state directory"

  before=$(stat -c '%d:%i' -- "$AUTH_RATE") \
    || fail "could not inspect admin rate state"
  exec 6<"$AUTH_RATE"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/6) \
    || fail "could not inspect opened admin rate state"
  raw=$(cat <&6)
  [ "$opened" = "$before:0:$caddy_gid:660:1:27" ] \
    && [ "$raw" = '{"version":1,"entries":{}}' ] \
    && [ "$(stat -c '%d:%i' -- "$AUTH_RATE")" = "$before" ] \
    || fail "written admin rate state did not validate"
}

valid_admin_password() {
  local password=$1 minimum=${2:-12}
  [ "${#password}" -ge "$minimum" ] && [ "${#password}" -le 64 ] || return 1
  if [ "$minimum" -le 1 ]; then
    [[ ! "$password" =~ [[:cntrl:]] ]]
  else
    [[ "$password" =~ ^[A-Za-z0-9]+$ ]]
  fi
}

hash_admin_password() {
  local password=$1 minimum=${2:-12} verifier
  valid_admin_password "$password" "$minimum" || return 1
  verifier=$(printf '%s\0' "$password" | php -r '
    $raw = stream_get_contents(STDIN);
    if ($raw === "" || substr($raw, -1) !== "\0") exit(1);
    $password = substr($raw, 0, -1);
    $hash = password_hash($password, PASSWORD_BCRYPT, ["cost" => 14]);
    if (!is_string($hash)) exit(1);
    echo $hash;
  ') || return 1
  [[ "$verifier" =~ ^\$2y\$14\$[./A-Za-z0-9]{53}$ ]] || return 1
  printf '%s' "$verifier"
}

admin_password_matches() {
  local verifier=$1 password=$2
  [ "$verifier" != - ] || return 1
  printf '%s\0%s\0' "$verifier" "$password" | php -r '
    $raw = stream_get_contents(STDIN);
    $parts = explode("\0", $raw);
    exit(count($parts) === 3 && $parts[2] === "" && password_verify($parts[1], $parts[0]) ? 0 : 1);
  '
}

read_password_fields() {
  local count=$1
  shift
  [ "$#" -eq "$count" ] || fail "password input policy is invalid"
  local index value minimum trailing
  PASSWORD_FIELDS=()
  for ((index=0; index<count; index++)); do
    minimum=$1
    shift
    IFS= read -r -d '' value || fail "incomplete password input"
    if ! valid_admin_password "$value" "$minimum"; then
      if [ "$minimum" -le 1 ]; then
        fail "current password must use 1 to 64 bytes without control characters"
      fi
      fail "password must use $minimum to 64 letters or numbers"
    fi
    PASSWORD_FIELDS+=("$value")
  done
  trailing=$(od -An -N1 -tx1) || fail "could not read password input"
  [ -z "${trailing//[[:space:]]/}" ] || fail "unexpected password input"
}

quote_config_value() {
  local value=$1
  if [ -z "$value" ] || [[ "$value" =~ [^A-Za-z0-9._/+:-] ]]; then
    value=${value//\\/\\\\}
    value=${value//\"/\\\"}
    printf '"%s"' "$value"
  else
    printf '%s' "$value"
  fi
}

prepare_config_values() {
  if [ "$#" -lt 2 ] || [ $(( $# % 2 )) -ne 0 ]; then
    fail "config update requires key and value pairs"
  fi
  [ "$#" -le 24 ] || fail "too many config values"

  local key value quoted
  declare -A seen=()
  [ -f "$conf_path" ] || fail "BirdNET-Pi config was not found"
  updates_temp=$(mktemp) || fail "could not create config update"
  config_temp=$(mktemp "$(dirname "$conf_path")/.birdnet.conf.XXXXXX") \
    || fail "could not create config update"

  while [ "$#" -gt 0 ]; do
    key=$1
    value=$2
    shift 2
    valid_config_value "$key" "$value" || fail "invalid config value for $key"
    [ -z "${seen[$key]+set}" ] || fail "duplicate config key: $key"
    seen[$key]=1
    quoted=$(quote_config_value "$value")
    printf '%s\t%s\n' "$key" "$quoted" >>"$updates_temp"
  done

  if ! awk -F '\t' '
    NR == FNR {
      replacement[$1]=$2
      order[++count]=$1
      next
    }
    /^[[:space:]]*(export[[:space:]]+)?[A-Z_][A-Z0-9_]*[[:space:]]*=/ {
      key=$0
      sub(/^[[:space:]]*/, "", key)
      sub(/^export[[:space:]]+/, "", key)
      sub(/[[:space:]]*=.*$/, "", key)
      if (key in replacement) {
        print key "=" replacement[key]
        written[key]=1
        next
      }
    }
    { print }
    END {
      for (position=1; position<=count; position++) {
        key=order[position]
        if (!(key in written)) print key "=" replacement[key]
      }
    }
  ' "$updates_temp" "$conf_path" >"$config_temp"; then
    fail "could not update config"
  fi
  chown "$birdnet_user:$birdnet_group" "$config_temp" \
    || fail "could not set config owner"
  chmod 0640 "$config_temp" \
    || fail "could not set config mode"
  sync -f "$config_temp" \
    || fail "could not sync config update"
  rm -f "$updates_temp"
  updates_temp=''
}

commit_config_values() {
  [ -n "$config_temp" ] && [ -f "$config_temp" ] && [ ! -L "$config_temp" ] \
    || return 1
  mv -fT -- "$config_temp" "$conf_path" || return 1
  config_temp=''
  sync -f "$(dirname "$conf_path")" || return 1
}

set_config_values() {
  prepare_config_values "$@"
  commit_config_values || fail "could not commit config update"
}

scrub_legacy_password() {
  local password_status=0 configured_password=''
  configured_password=$(conf_value "$conf_path" CADDY_PWD) || password_status=$?
  if [ "$password_status" = 0 ] && [ -z "$configured_password" ]; then
    return 0
  fi
  if [ "$password_status" = 2 ]; then
    return 0
  fi
  password_config_write=1
  set_config_values CADDY_PWD ''
  password_config_write=0
}

read_config_values() {
  local count=$1 index key value trailing
  local -a values=()
  if ! [[ "$count" =~ ^[1-9][0-9]?$ ]] \
    || [ "$count" -lt 1 ] || [ "$count" -gt 12 ]; then
    fail "config input count is not allowed"
  fi

  for ((index=0; index<count; index++)); do
    IFS= read -r -d '' key || fail "incomplete config input"
    IFS= read -r -d '' value || fail "incomplete config input"
    values+=("$key" "$value")
  done
  trailing=$(od -An -N1 -tx1) || fail "could not read config input"
  if [ -n "${trailing//[[:space:]]/}" ]; then
    fail "unexpected config input"
  fi
  set_config_values "${values[@]}"
}

action=${1:-version}
case "$action" in
  version)
    [ "$#" -eq 1 ] || fail "unexpected arguments"
    printf '{"ok":true,"version":%s}\n' "$CONTROL_VERSION"
    ;;
  icecast-start-allowed)
    [ "$#" -eq 1 ] || fail "live audio start check takes no arguments"
    transition=$AUTH_DIR/icecast-start-blocked
    if [ -e "$transition" ] || [ -L "$transition" ]; then
      [ -f "$transition" ] && [ ! -L "$transition" ] \
        && [ "$(stat -c '%u:%g:%a:%h' -- "$transition")" = '0:0:400:1' ] \
        || fail "live audio start guard state is unsafe"
      transition_before=$(stat -c '%d:%i' -- "$transition") \
        || fail "live audio start guard state is unsafe"
      exec 6<"$transition"
      transition_opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/6) \
        || fail "live audio start guard state is unsafe"
      transition_size=${transition_opened##*:}
      [ "$transition_opened" = "$transition_before:0:0:400:1:$transition_size" ] \
        && [ "$transition_size" -ge 3 ] && [ "$transition_size" -le 64 ] \
        || fail "live audio start guard state is unsafe"
      transition_raw=$(cat <&6)
      [ "$transition_size" -eq $(( ${#transition_raw} + 1 )) ] \
        && [ "$(stat -c '%d:%i' -- "$transition")" = "$transition_before" ] \
        || fail "live audio start guard state is unsafe"
      if [ "$transition_raw" = v1 ]; then
        fail "live audio is disabled while LAN password protection is changing or enabled"
      fi
      IFS=$'\t' read -r transition_version transition_phase transition_restore transition_extra \
        <<<"$transition_raw"
      [ -z "${transition_extra:-}" ] \
        && [ "$transition_version" = v2 ] \
        && [ "$transition_raw" = "$transition_version"$'\t'"$transition_phase"$'\t'"$transition_restore" ] \
        || fail "live audio start guard state is unsafe"
      case "$transition_phase:$transition_restore" in
        restoring:yes) ;;
        blocked:yes|blocked:no|blocked:unknown)
          fail "live audio is disabled while LAN password protection is changing or enabled"
          ;;
        *) fail "live audio start guard state is unsafe" ;;
      esac
    fi
    auth_marker_status \
      || fail "admin credential initialization is incomplete; live audio remains disabled"
    read_auth_state \
      || fail "admin credential state is unsafe or malformed; live audio remains disabled"
    [ "$AUTH_REQUIRED" = 0 ] \
      || fail "live audio is disabled while LAN password protection is enabled"
    printf '{"ok":true,"allowed":true}\n'
    ;;
  restart)
    [ "$#" -eq 2 ] || fail "restart requires one unit"
    restartable_unit "$2" || fail "unit is status-only"
    if [ "$2" = icecast2 ]; then
      lock_auth_state
      auth_marker_status \
        || fail "admin credential initialization is incomplete; Icecast restart remains blocked"
      read_auth_state \
        || fail "admin credential state is unsafe or malformed; Icecast restart remains blocked"
      [ "$AUTH_REQUIRED" = 0 ] \
        || fail "Icecast restart is unavailable while LAN password protection is enabled; turn off Require password on local network first"
    fi
    if /bin/systemctl restart "$2" \
      && { [ "$2" != icecast2 ] || /bin/systemctl is-active --quiet icecast2; }; then
      printf '{"ok":true,"unit":"%s"}\n' "$(json_escape "$2")"
    else
      fail "service restart failed"
    fi
    ;;
  journal)
    [ "$#" -eq 3 ] || fail "journal requires a unit and line count"
    known_unit "$2" || fail "unit is not allowed"
    if ! [[ "$3" =~ ^[0-9]{1,3}$ ]] || [ "$3" -lt 10 ] || [ "$3" -gt 500 ]; then
      fail "journal line count is not allowed"
    fi
    exec /bin/journalctl -u "$2" --no-pager -n "$3" -o short-iso
    ;;
  config-set)
    [ "$#" -eq 3 ] || fail "config-set requires a key and value"
    lock_auth_state
    set_config_values "$2" "$3"
    printf '{"ok":true,"key":"%s"}\n' "$(json_escape "$2")"
    ;;
  config-set-many)
    if [ "$#" -lt 3 ] || [ $(( ($# - 1) % 2 )) -ne 0 ]; then
      fail "config-set-many requires key and value pairs"
    fi
    shift
    lock_auth_state
    set_config_values "$@"
    printf '{"ok":true,"updated":%s}\n' "$(( $# / 2 ))"
    ;;
  config-set-stdin)
    [ "$#" -eq 2 ] || fail "config-set-stdin requires a pair count"
    lock_auth_state
    read_config_values "$2"
    printf '{"ok":true,"updated":%s}\n' "$2"
    ;;
  auth-state-init)
    [ "$#" -eq 1 ] || fail "admin state initialization takes no arguments"
    ! web_runtime_caller \
      || fail "web requests cannot initialize the admin credential"
    lock_auth_state
    reset_admin_rate_state
    marker_status=0
    auth_marker_status || marker_status=$?
    [ "$marker_status" = 0 ] || [ "$marker_status" = 2 ] \
      || fail "admin state initialization marker is unsafe or malformed"
    state_status=0
    read_auth_state || state_status=$?
    if [ "$marker_status" = 0 ]; then
      [ "$state_status" = 0 ] \
        || fail "admin credential state is missing or malformed; recover it from SSH"
      scrub_legacy_password
      printf '{"ok":true,"initialized":false,"password_configured":%s}\n' \
        "$([ "$AUTH_VERIFIER" = - ] && printf false || printf true)"
      exit 0
    fi
    if [ "$state_status" = 2 ]; then
      password_status=0
      initial_password=$(conf_value "$conf_path" CADDY_PWD) || password_status=$?
      if [ "$password_status" = 2 ]; then
        initial_password=''
      elif [ "$password_status" != 0 ]; then
        fail "configured admin password is invalid"
      fi
      if [ -n "$initial_password" ]; then
        valid_admin_password "$initial_password" 1 \
          || fail "configured admin password must use 1 to 64 bytes without control characters"
        initial_verifier=$(hash_admin_password "$initial_password" 1) \
          || fail "could not hash configured admin password"
      else
        initial_verifier=-
      fi
      write_auth_state 0 0 "$initial_verifier"
    elif [ "$state_status" = 0 ]; then
      initial_verifier=$AUTH_VERIFIER
    else
      fail "existing admin credential state is unsafe or malformed"
    fi
    scrub_legacy_password
    write_auth_marker
    printf '{"ok":true,"initialized":true,"password_configured":%s}\n' \
      "$([ "$initial_verifier" = - ] && printf false || printf true)"
    ;;
  lan-auth-set-stdin)
    [ "$#" -eq 2 ] || fail "LAN auth update requires one value"
    [ "$2" = 0 ] || [ "$2" = 1 ] || fail "invalid LAN auth value"
    read_password_fields 1 1
    current_password=${PASSWORD_FIELDS[0]}
    safe_root_helper "$CADDY_REFRESH" \
      || fail "Caddy refresh helper is missing or unsafe"
    lock_auth_state
    auth_marker_status \
      || fail "admin credential initialization is incomplete; recover it from SSH"
    read_auth_state || fail "admin credential state is unsafe or malformed"
    [ "$AUTH_VERIFIER" != - ] \
      || fail "set the admin password from SSH before changing this setting"
    admin_password_matches "$AUTH_VERIFIER" "$current_password" \
      || fail "current admin password is incorrect"
    old_policy=$AUTH_REQUIRED
    old_epoch=$AUTH_EPOCH
    old_verifier=$AUTH_VERIFIER
    if [ "$old_policy" = "$2" ]; then
      refresh_status=0
      if [ "$old_policy" = 1 ]; then
        AVIAN_CLOSE_STREAMS=1 "$CADDY_REFRESH" >/dev/null || refresh_status=$?
        case "$refresh_status" in
          0) ;;
          20) fail "LAN auth remains enabled, but an older live audio connection may remain; over SSH run sudo systemctl stop icecast2 and verify the service is inactive" ;;
          *) fail "Caddy auth refresh failed; LAN password protection remains authoritative" ;;
        esac
      else
        "$CADDY_REFRESH" >/dev/null || refresh_status=$?
        case "$refresh_status" in
          0) ;;
          21) fail "LAN auth remains disabled, but Icecast could not be restored; inspect the service over SSH" ;;
          *) fail "Caddy auth refresh failed; the current access policy remains authoritative" ;;
        esac
      fi
      printf '{"ok":true,"lan_auth":%s,"changed":false}\n' "$2"
      exit 0
    fi
    if [ "$2" = 1 ]; then
      [ "$old_epoch" -le $((AUTH_EPOCH_MAX - 2)) ] \
        || fail "admin auth epoch cannot safely be advanced"
      new_epoch=$((old_epoch + 1))
      prepare_auth_state 1 "$new_epoch" "$old_verifier"
      refresh_status=0
      AVIAN_AUTH_STATE_CANDIDATE="$state_temp" AVIAN_CLOSE_STREAMS=1 \
        "$CADDY_REFRESH" >/dev/null || refresh_status=$?
      case "$refresh_status" in
        0|20) ;;
        *)
          restore_status=0
          "$CADDY_REFRESH" >/dev/null || restore_status=$?
          case "$restore_status" in
            0)
              fail "Caddy auth refresh failed; setting was not changed; the prior access policy and live audio state were restored and verified"
              ;;
            21)
              fail "Caddy auth refresh failed; setting was not changed; the prior access policy was restored, but live audio could not be restored; retry, or inspect Icecast over SSH"
              ;;
            *)
              fail "Caddy auth refresh failed; setting was not changed, but the prior access policy and live audio state could not be verified; over SSH run sudo /usr/local/sbin/avian-caddy-refresh, then verify Icecast and the Caddy route"
              ;;
          esac
          ;;
      esac
      if ! commit_auth_state 1 "$new_epoch" "$old_verifier"; then
        rollback_epoch=$((old_epoch + 2))
        reconcile_required_policy "$rollback_epoch" "$old_verifier"
        fail_required_recovery "admin state commit failed"
      fi
      if [ "$refresh_status" = 20 ]; then
        fail "LAN auth was enabled, but an older live audio connection may remain; access remains locked"
      fi
    else
      [ "$old_epoch" -le $((AUTH_EPOCH_MAX - 2)) ] \
        || fail "admin auth epoch cannot safely be advanced"
      new_epoch=$((old_epoch + 1))
      write_auth_state 0 "$new_epoch" "$old_verifier"
      refresh_status=0
      "$CADDY_REFRESH" >/dev/null || refresh_status=$?
      if [ "$refresh_status" != 0 ]; then
        rollback_epoch=$((old_epoch + 2))
        reconcile_required_policy "$rollback_epoch" "$old_verifier"
        if [ "$refresh_status" = 21 ]; then
          fail_required_recovery "Icecast could not be restored"
        fi
        fail_required_recovery "LAN password protection could not be disabled"
      fi
    fi
    printf '{"ok":true,"lan_auth":%s,"changed":true}\n' "$2"
    ;;
  password-change-stdin)
    [ "$#" -eq 1 ] || fail "password change takes no arguments"
    read_password_fields 2 1 12
    current_password=${PASSWORD_FIELDS[0]}
    new_password=${PASSWORD_FIELDS[1]}
    safe_root_helper "$CADDY_REFRESH" \
      || fail "Caddy refresh helper is missing or unsafe"
    lock_auth_state
    auth_marker_status \
      || fail "admin credential initialization is incomplete; recover it from SSH"
    read_auth_state || fail "admin credential state is unsafe or malformed"
    [ "$AUTH_VERIFIER" != - ] \
      || fail "web requests cannot initialize the admin credential"
    admin_password_matches "$AUTH_VERIFIER" "$current_password" \
      || fail "current admin password is incorrect"
    old_policy=$AUTH_REQUIRED
    old_epoch=$AUTH_EPOCH
    old_verifier=$AUTH_VERIFIER
    if admin_password_matches "$old_verifier" "$new_password"; then
      refresh_status=0
      if [ "$old_policy" = 1 ]; then
        AVIAN_CLOSE_STREAMS=1 "$CADDY_REFRESH" >/dev/null || refresh_status=$?
      else
        "$CADDY_REFRESH" >/dev/null || refresh_status=$?
      fi
      case "$refresh_status" in
        0) ;;
        20) fail "current password remains authoritative, but an older live audio connection may remain; retry the same password" ;;
        21) fail "current password remains authoritative and live audio was closed, but Icecast could not be started again" ;;
        *) fail "Caddy password refresh failed; the current password remains authoritative" ;;
      esac
      printf '{"ok":true,"changed":false}\n'
      exit 0
    fi
    [ "$old_epoch" -le $((AUTH_EPOCH_MAX - 2)) ] \
      || fail "admin auth epoch cannot safely be advanced"
    new_epoch=$((old_epoch + 1))
    new_verifier=$(hash_admin_password "$new_password") \
      || fail "could not hash new admin password"
    # Close every legacy surface before revoking the old verifier. The native
    # API remains available through the current state until the next phase.
    prepare_auth_state 1 "$new_epoch" "$new_verifier"
    transition_status=0
    if [ "$old_policy" = 1 ]; then
      AVIAN_AUTH_STATE_CANDIDATE="$state_temp" AVIAN_CLOSE_STREAMS=1 \
        "$CADDY_REFRESH" >/dev/null || transition_status=$?
    else
      AVIAN_AUTH_STATE_CANDIDATE="$state_temp" "$CADDY_REFRESH" >/dev/null \
        || transition_status=$?
    fi
    case "$transition_status" in
      0|20|21) ;;
      *) fail "Caddy transition lock failed; the password was not changed" ;;
    esac
    rm -f -- "$state_temp"
    state_temp=''

    # The new verifier is authoritative before the final Caddy render. If the
    # process stops here, legacy access stays closed and a same-value retry can
    # reconcile Caddy without reviving the old credential.
    prepare_auth_state "$old_policy" "$new_epoch" "$new_verifier"
    if ! commit_auth_state "$old_policy" "$new_epoch" "$new_verifier"; then
      fail "admin state commit failed; legacy access remains locked"
    fi
    refresh_status=0
    if [ "$old_policy" = 1 ]; then
      AVIAN_CLOSE_STREAMS=1 "$CADDY_REFRESH" >/dev/null || refresh_status=$?
    else
      "$CADDY_REFRESH" >/dev/null || refresh_status=$?
    fi
    case "$refresh_status" in
      0) ;;
      20) fail "password changed, but an older live audio connection may remain; legacy access remains locked" ;;
      21) fail "password changed and live audio was closed, but Icecast could not be started again; legacy access remains locked" ;;
      *) fail "password changed, but Caddy refresh failed; legacy access remains locked; retry the same password" ;;
    esac
    printf '{"ok":true,"changed":true}\n'
    ;;
  password-reset|password-reset-stdin)
    [ "$#" -eq 1 ] || fail "password reset takes no arguments"
    ! web_runtime_caller \
      || fail "web requests cannot reset the admin credential"
    case "${SUDO_USER:-root}" in
      root|"$birdnet_user") ;;
      *) fail "password reset is available only from SSH as the station owner" ;;
    esac
    if [ "$action" = password-reset ]; then
      [ -r /dev/tty ] && [ -w /dev/tty ] \
        || fail "interactive password reset requires a terminal"
      IFS= read -r -s -p 'New admin password: ' new_password </dev/tty
      printf '\n' >/dev/tty
      IFS= read -r -s -p 'Confirm admin password: ' confirmed_password </dev/tty
      printf '\n' >/dev/tty
      [ "$new_password" = "$confirmed_password" ] \
        || fail "passwords did not match"
      valid_admin_password "$new_password" 12 \
        || fail "password must use 12 to 64 letters or numbers"
      unset confirmed_password
    else
      read_password_fields 1 12
      new_password=${PASSWORD_FIELDS[0]}
    fi
    safe_root_helper "$CADDY_REFRESH" \
      || fail "Caddy refresh helper is missing or unsafe"
    lock_auth_state
    reset_admin_rate_state
    state_status=0
    read_auth_state || state_status=$?
    if [ "$state_status" = 0 ]; then
      old_policy=$AUTH_REQUIRED
      old_epoch=$AUTH_EPOCH
      old_verifier=$AUTH_VERIFIER
      [ "$old_epoch" -le $((AUTH_EPOCH_MAX - 2)) ] \
        || fail "admin auth epoch cannot safely be advanced"
      new_epoch=$((old_epoch + 1))
    else
      old_policy=1
      new_epoch=0
    fi
    new_verifier=$(hash_admin_password "$new_password") \
      || fail "could not hash new admin password"
    prepare_auth_state 1 "$new_epoch" "$new_verifier"
    transition_status=0
    if [ "$old_policy" = 1 ]; then
      AVIAN_AUTH_STATE_CANDIDATE="$state_temp" AVIAN_CLOSE_STREAMS=1 \
        "$CADDY_REFRESH" >/dev/null || transition_status=$?
    else
      AVIAN_AUTH_STATE_CANDIDATE="$state_temp" "$CADDY_REFRESH" >/dev/null \
        || transition_status=$?
    fi
    case "$transition_status" in
      0|20|21) ;;
      *) fail "Caddy transition lock failed; the password was not reset" ;;
    esac
    rm -f -- "$state_temp"
    state_temp=''

    prepare_auth_state "$old_policy" "$new_epoch" "$new_verifier"
    if ! commit_auth_state "$old_policy" "$new_epoch" "$new_verifier"; then
      fail "admin state commit failed; legacy access remains locked"
    fi
    if ! auth_marker_status; then
      scrub_legacy_password
      write_auth_marker
    fi
    refresh_status=0
    if [ "$old_policy" = 1 ]; then
      AVIAN_CLOSE_STREAMS=1 "$CADDY_REFRESH" >/dev/null || refresh_status=$?
    else
      "$CADDY_REFRESH" >/dev/null || refresh_status=$?
    fi
    case "$refresh_status" in
      0|20|21) ;;
      *) fail "password reset became authoritative, but Caddy refresh failed; legacy access remains locked; rerun the reset from SSH" ;;
    esac
    if [ "$refresh_status" = 20 ]; then
      fail "password was reset, but an older live audio connection may remain; access remains locked"
    fi
    if [ "$refresh_status" = 21 ]; then
      fail "password was reset and live audio was closed, but Icecast could not be started again"
    fi
    printf '{"ok":true,"changed":true}\n'
    ;;
  *) fail "unknown action" ;;
esac
