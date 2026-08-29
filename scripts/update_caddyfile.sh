#!/usr/bin/env bash
# Render BirdNET-Pi's Caddyfile without evaluating birdnet.conf as shell code.

set -euo pipefail
IFS=$'\n\t'
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL

conf=/etc/birdnet/birdnet.conf
site_overlay=/etc/caddy/avian-site-overlay.caddy
auth_dir=/var/lib/avian-visitors
auth_lock=$auth_dir/admin-auth.lock
auth_state=$auth_dir/admin-auth.state
[ -r "$conf" ] || { echo "BirdNET-Pi config was not found" >&2; exit 1; }

lock_auth_state() {
  local inherited=${AVIAN_AUTH_LOCK_FD:-} before opened
  if [ -n "$inherited" ]; then
    [ "$inherited" = 9 ] \
      && [ -e "/proc/self/fd/$inherited" ] \
      && [ "$(readlink -f "/proc/self/fd/$inherited")" = "$auth_lock" ] \
      && [ "$(stat -Lc '%u:%g:%a:%h' "/proc/self/fd/$inherited")" = '0:0:600:1' ] \
      && flock -n "$inherited" \
      || { echo "Invalid inherited admin state lock" >&2; exit 1; }
    return
  fi
  [ -d "$auth_dir" ] && [ ! -L "$auth_dir" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$auth_dir")" = '0:0:755' ] \
    || { echo "Admin state directory is unsafe" >&2; exit 1; }
  [ -f "$auth_lock" ] && [ ! -L "$auth_lock" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$auth_lock")" = '0:0:600:1' ] \
    || { echo "Admin state lock is unsafe" >&2; exit 1; }
  before=$(stat -c '%d:%i' -- "$auth_lock") \
    || { echo "Could not inspect admin state lock" >&2; exit 1; }
  exec 9<>"$auth_lock"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h' -- /proc/self/fd/9) \
    || { echo "Could not inspect opened admin state lock" >&2; exit 1; }
  [ "$opened" = "$before:0:0:600:1" ] \
    || { echo "Admin state lock changed while opening" >&2; exit 1; }
  flock -x 9 || { echo "Could not lock admin state" >&2; exit 1; }
  [ "$(stat -c '%d:%i' -- "$auth_lock")" = "$before" ] \
    || { echo "Admin state lock changed while locking" >&2; exit 1; }
}

lock_auth_state

state_input=$auth_state
if [ -n "${AVIAN_AUTH_STATE_CANDIDATE:-}" ]; then
  [ "${AVIAN_AUTH_LOCK_FD:-}" = 9 ] \
    || { echo "Candidate admin state requires the inherited lock" >&2; exit 1; }
  case "$AVIAN_AUTH_STATE_CANDIDATE" in
    "$auth_dir"/.admin-auth.state.*) ;;
    *) echo "Candidate admin state path is unsafe" >&2; exit 1 ;;
  esac
  [ -f "$AVIAN_AUTH_STATE_CANDIDATE" ] && [ ! -L "$AVIAN_AUTH_STATE_CANDIDATE" ] \
    || { echo "Candidate admin state is unsafe" >&2; exit 1; }
  state_input=$AVIAN_AUTH_STATE_CANDIDATE
fi

conf_value() {
  local wanted=$1 line raw valid=0 found=0 parsed
  local assignment_re="^[[:space:]]*(export[[:space:]]+)?${wanted}[[:space:]]*=[[:space:]]*(.*)$"
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
  done <"$conf"
  [ "$found" = 1 ] || return 2
  [ "$valid" = 1 ] || return 3
  printf '%s' "$value"
}

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

BIRDNET_USER=$(conf_value BIRDNET_USER)
EXTRACTED=$(conf_value EXTRACTED)
[[ "$BIRDNET_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || { echo "Invalid BirdNET-Pi user" >&2; exit 1; }
[[ "$EXTRACTED" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  && [ "$EXTRACTED" != / ] && [[ "$EXTRACTED" != *'..'* ]] \
  || { echo "Invalid BirdNET-Pi webroot" >&2; exit 1; }
caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
[ -n "$caddy_gid" ] || { echo "Caddy group was not found" >&2; exit 1; }

policy_invalid=0
AVIAN_REQUIRE_LAN_AUTH=1
hashword=''
state_status=0
if [ ! -e "$state_input" ] && [ ! -L "$state_input" ]; then
  state_status=2
else
  if [ ! -f "$state_input" ] || [ -L "$state_input" ] \
    || [ "$(stat -c '%u:%g:%a:%h' -- "$state_input")" != "0:$caddy_gid:640:1" ]; then
    state_status=3
  else
    state_before=$(stat -c '%d:%i' -- "$state_input") || state_status=3
    if [ "$state_status" = 0 ]; then
      exec 8<"$state_input"
      state_opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/8) \
        || state_status=3
      state_size=${state_opened##*:}
      if [ "$state_status" != 0 ] \
        || [ "$state_opened" != "$state_before:0:$caddy_gid:640:1:$state_size" ] \
        || [ "$state_size" -lt 1 ] || [ "$state_size" -gt 256 ]; then
        state_status=3
      else
        state_raw=$(cat <&8)
        if [ "$state_size" -ne $(( ${#state_raw} + 1 )) ]; then
          state_status=3
        else
          IFS=$'\t' read -r state_version state_policy state_epoch state_hash state_extra <<<"$state_raw"
          if [ -n "${state_extra:-}" ] \
            || [ "$state_raw" != "$state_version"$'\t'"$state_policy"$'\t'"$state_epoch"$'\t'"$state_hash" ] \
            || [ "$state_version" != v1 ] \
            || { [ "$state_policy" != 0 ] && [ "$state_policy" != 1 ]; } \
            || ! [[ "$state_epoch" =~ ^(0|[1-9][0-9]{0,9})$ ]] \
            || [ "$state_epoch" -gt 2147483647 ]; then
            state_status=3
          elif [ "$state_hash" != - ] \
            && ! [[ "$state_hash" =~ ^\$2y\$14\$[./A-Za-z0-9]{53}$ ]]; then
            state_status=3
          elif [ "$(stat -c '%d:%i' -- "$state_input")" != "$state_before" ]; then
            state_status=3
          else
            AVIAN_REQUIRE_LAN_AUTH=$state_policy
            AVIAN_AUTH_EPOCH=$state_epoch
            [ "$state_hash" = - ] || hashword=$state_hash
          fi
        fi
      fi
    fi
  fi
fi
if [ "$state_status" != 0 ]; then
  echo "Admin credential state is missing or invalid; rendering fail-closed" >&2
  policy_invalid=1
fi
if [ "$AVIAN_REQUIRE_LAN_AUTH" = 1 ] && [ -z "$hashword" ]; then
  echo "LAN admin auth is locked until the credential is repaired from SSH" >&2
fi

fpm_sock=$(find /run/php -maxdepth 1 -type s -name 'php*-fpm.sock' -print 2>/dev/null | sort | head -n 1 || true)
fpm_sock=${fpm_sock:-/run/php/php-fpm.sock}

case "${AVIAN_CLOSE_STREAMS:-0}" in
  0|1) ;;
  *) echo "Invalid live audio cutoff request" >&2; exit 1 ;;
esac

icecast_guard_dir=/etc/systemd/system/icecast2.service.d
icecast_guard=$icecast_guard_dir/zz-avian-lan-auth.conf
icecast_transition=$auth_dir/icecast-start-blocked
icecast_legacy_restore=$auth_dir/icecast-restore-on-unlock
ICECAST_PHASE=''
ICECAST_RESTORE=''
ICECAST_LEGACY=0
icecast_restore_needed=0

install_icecast_start_guard() {
  local helper=/usr/local/sbin/avian-admin-control temp
  [ -f "$helper" ] && [ ! -L "$helper" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$helper")" = '0:0:755:1' ] \
    || return 1
  if [ -e "$icecast_guard_dir" ] || [ -L "$icecast_guard_dir" ]; then
    [ -d "$icecast_guard_dir" ] && [ ! -L "$icecast_guard_dir" ] \
      && [ "$(stat -c '%u:%g:%a' -- "$icecast_guard_dir")" = '0:0:755' ] \
      || return 1
  else
    install -d -o root -g root -m 0755 "$icecast_guard_dir" || return 1
  fi
  temp=$(mktemp "$icecast_guard_dir/.zz-avian-lan-auth.XXXXXX") || return 1
  if ! printf '%s\n' \
      '# Managed by AvianVisitors. Live audio follows the authoritative LAN policy.' \
      '[Service]' \
      'ExecCondition=+/usr/local/sbin/avian-admin-control icecast-start-allowed' \
      >"$temp" \
    || ! chown root:root "$temp" \
    || ! chmod 0644 "$temp" \
    || ! sync -f "$temp" \
    || ! mv -fT "$temp" "$icecast_guard" \
    || ! sync -f "$icecast_guard" \
    || ! sync -f "$icecast_guard_dir"; then
    rm -f -- "$temp"
    return 1
  fi
  systemctl daemon-reload >/dev/null 2>&1
}

icecast_transition_status() {
  local before opened size raw version extra
  ICECAST_PHASE=''
  ICECAST_RESTORE=''
  ICECAST_LEGACY=0
  if [ ! -e "$icecast_transition" ] && [ ! -L "$icecast_transition" ]; then
    return 2
  fi
  [ -f "$icecast_transition" ] && [ ! -L "$icecast_transition" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$icecast_transition")" = '0:0:400:1' ] \
    || return 3
  before=$(stat -c '%d:%i' -- "$icecast_transition") || return 3
  exec 7<"$icecast_transition"
  opened=$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- /proc/self/fd/7) || return 3
  size=${opened##*:}
  [ "$opened" = "$before:0:0:400:1:$size" ] \
    && [ "$size" -ge 3 ] && [ "$size" -le 64 ] \
    || return 3
  raw=$(cat <&7)
  [ "$size" -eq $(( ${#raw} + 1 )) ] \
    && [ "$(stat -c '%d:%i' -- "$icecast_transition")" = "$before" ] \
    || return 3
  if [ "$raw" = v1 ]; then
    ICECAST_PHASE=blocked
    ICECAST_RESTORE=unknown
    ICECAST_LEGACY=1
    return 0
  fi
  IFS=$'\t' read -r version ICECAST_PHASE ICECAST_RESTORE extra <<<"$raw"
  [ -z "${extra:-}" ] && [ "$version" = v2 ] \
    && [ "$raw" = "$version"$'\t'"$ICECAST_PHASE"$'\t'"$ICECAST_RESTORE" ] \
    || return 3
  case "$ICECAST_PHASE:$ICECAST_RESTORE" in
    blocked:yes|blocked:no|blocked:unknown|restoring:yes) ;;
    *) return 3 ;;
  esac
}

write_icecast_transition() {
  local phase=$1 restore=$2 temp current_status=0
  case "$phase:$restore" in
    blocked:yes|blocked:no|blocked:unknown|restoring:yes) ;;
    *) return 1 ;;
  esac
  icecast_transition_status || current_status=$?
  if [ "$current_status" = 0 ] && [ "$ICECAST_LEGACY" = 0 ] \
    && [ "$ICECAST_PHASE:$ICECAST_RESTORE" = "$phase:$restore" ]; then
    return 0
  fi
  [ "$current_status" = 0 ] || [ "$current_status" = 2 ] || return 1
  temp=$(mktemp "$auth_dir/.icecast-start-blocked.XXXXXX") || return 1
  if ! printf 'v2\t%s\t%s\n' "$phase" "$restore" >"$temp" \
    || ! chown root:root "$temp" \
    || ! chmod 0400 "$temp" \
    || ! sync -f "$temp" \
    || ! mv -fT "$temp" "$icecast_transition" \
    || ! sync -f "$icecast_transition" \
    || ! sync -f "$auth_dir"; then
    rm -f -- "$temp"
    return 1
  fi
}

clear_icecast_transition() {
  local transition_status=0
  icecast_transition_status || transition_status=$?
  [ "$transition_status" = 2 ] && return 0
  [ "$transition_status" = 0 ] || return 1
  rm -f -- "$icecast_transition" && sync -f "$auth_dir"
}

legacy_restore_status() {
  local content
  if [ ! -e "$icecast_legacy_restore" ] && [ ! -L "$icecast_legacy_restore" ]; then
    return 2
  fi
  [ -f "$icecast_legacy_restore" ] && [ ! -L "$icecast_legacy_restore" ] \
    && [ "$(stat -c '%u:%g:%a:%h:%s' -- "$icecast_legacy_restore")" = '0:0:400:1:3' ] \
    || return 3
  content=$(cat -- "$icecast_legacy_restore") || return 3
  [ "$content" = v1 ] || return 3
}

migrate_icecast_transition() {
  local transition_status=0 restore_status=0
  icecast_transition_status || transition_status=$?
  legacy_restore_status || restore_status=$?
  [ "$transition_status" = 0 ] || [ "$transition_status" = 2 ] || return 1
  [ "$restore_status" = 0 ] || [ "$restore_status" = 2 ] || return 1
  if [ "$restore_status" = 0 ]; then
    case "$transition_status:${ICECAST_PHASE:-}:${ICECAST_RESTORE:-}" in
      0:restoring:yes) ;;
      *) write_icecast_transition blocked yes || return 1 ;;
    esac
    rm -f -- "$icecast_legacy_restore" && sync -f "$auth_dir" || return 1
  elif [ "$transition_status" = 0 ] && [ "$ICECAST_LEGACY" = 1 ]; then
    write_icecast_transition blocked unknown || return 1
  fi
}

read_icecast_restore_intent() {
  local state
  state=$(systemctl is-active icecast2 2>/dev/null || true)
  case "$state" in
    active|activating|reloading|deactivating)
      ICECAST_RESTORE_INTENT=yes
      ;;
    inactive|failed|unknown)
      ICECAST_RESTORE_INTENT=no
      ;;
    '')
      if systemctl cat icecast2 >/dev/null 2>&1; then
        return 1
      fi
      ICECAST_RESTORE_INTENT=no
      ;;
    *) return 1 ;;
  esac
}

ensure_icecast_blocked() {
  local transition_status=0
  icecast_transition_status || transition_status=$?
  if [ "$transition_status" = 2 ]; then
    # Define restore intent at the start of the transition. Only then publish
    # the durable start block, with that intent in the same atomic record.
    read_icecast_restore_intent || return 1
    write_icecast_transition blocked "$ICECAST_RESTORE_INTENT" || return 1
    ICECAST_PHASE=blocked
    ICECAST_RESTORE=$ICECAST_RESTORE_INTENT
  elif [ "$transition_status" != 0 ]; then
    return 1
  fi
  if [ "$ICECAST_PHASE" = restoring ]; then
    write_icecast_transition blocked yes || return 1
    ICECAST_PHASE=blocked
    ICECAST_RESTORE=yes
  fi
  if [ "$ICECAST_RESTORE" = unknown ]; then
    read_icecast_restore_intent || return 1
    write_icecast_transition blocked "$ICECAST_RESTORE_INTENT" || return 1
  fi
}

prepare_icecast_restore() {
  local transition_status=0
  icecast_restore_needed=0
  icecast_transition_status || transition_status=$?
  [ "$transition_status" = 2 ] && return 0
  [ "$transition_status" = 0 ] || return 1
  if [ "$ICECAST_PHASE:$ICECAST_RESTORE" = blocked:unknown ]; then
    read_icecast_restore_intent || return 1
    write_icecast_transition blocked "$ICECAST_RESTORE_INTENT" || return 1
    ICECAST_RESTORE=$ICECAST_RESTORE_INTENT
  fi
  case "$ICECAST_PHASE:$ICECAST_RESTORE" in
    blocked:yes)
      write_icecast_transition restoring yes || return 1
      icecast_restore_needed=1
      ;;
    restoring:yes)
      icecast_restore_needed=1
      ;;
    blocked:no)
      clear_icecast_transition || return 1
      ;;
    *) return 1 ;;
  esac
}

finish_icecast_restore() {
  [ "$icecast_restore_needed" = 1 ] || return 0
  if ! timeout 20s systemctl start icecast2 \
    || ! systemctl is-active --quiet icecast2; then
    return 1
  fi
  clear_icecast_transition
}

icecast_processes_closed() {
  local comm_file process_name
  [ -r /proc/1/comm ] || return 1
  for comm_file in /proc/[0-9]*/comm; do
    [ -r "$comm_file" ] || continue
    process_name=''
    IFS= read -r process_name <"$comm_file" || continue
    case "$process_name" in
      icecast|icecast2) return 1 ;;
    esac
  done
  return 0
}

icecast_backend_closed() {
  local state pid_kind pid cgroup proc
  state=$(systemctl is-active icecast2 2>/dev/null || true)
  case "$state" in
    inactive|failed|unknown) ;;
    '')
      systemctl cat icecast2 >/dev/null 2>&1 && return 1
      ;;
    *) return 1 ;;
  esac
  for pid_kind in MainPID ControlPID; do
    pid=$(systemctl show -p "$pid_kind" --value icecast2 2>/dev/null || true)
    [ -z "$pid" ] || [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    [ -z "$pid" ] || [ "$pid" = 0 ] || return 1
  done
  cgroup=$(systemctl show -p ControlGroup --value icecast2 2>/dev/null || true)
  if [ -n "$cgroup" ] && [ "$cgroup" != / ]; then
    [[ "$cgroup" =~ ^/[A-Za-z0-9_.@:/-]+$ ]] && [[ "$cgroup" != *..* ]] \
      || return 1
    if [ -e "/sys/fs/cgroup$cgroup" ]; then
      [ -r "/sys/fs/cgroup$cgroup/cgroup.procs" ] || return 1
      while IFS= read -r proc; do
        [ -z "$proc" ] || [ "$proc" = 0 ] || return 1
      done <"/sys/fs/cgroup$cgroup/cgroup.procs"
    fi
  fi
  icecast_processes_closed
}

stop_icecast_backend() {
  timeout 20s systemctl stop icecast2 >/dev/null 2>&1 || true
  timeout 10s systemctl kill --kill-who=all --signal=KILL icecast2 \
    >/dev/null 2>&1 || true
  for _ in {1..20}; do
    icecast_backend_closed && return 0
    sleep 0.1
  done
  return 1
}

icecast_protection_check=0
if [ "$AVIAN_REQUIRE_LAN_AUTH" = 1 ] \
  && { [ "${AVIAN_CLOSE_STREAMS:-0}" = 1 ] || [ "$state_input" = "$auth_state" ]; }; then
  icecast_protection_check=1
fi
icecast_restore_check=0
if [ "$AVIAN_REQUIRE_LAN_AUTH" = 0 ] && [ "$state_input" = "$auth_state" ]; then
  icecast_restore_check=1
fi

legacy_gate=''
legacy_handles=''
if [ "$AVIAN_REQUIRE_LAN_AUTH" = 1 ]; then
  # Required mode exposes only AvianVisitors' reviewed native controls.
  # Legacy file editing, terminal, log, and diagnostics surfaces stay closed.
  legacy_handles="  handle @legacySurface {
    respond 404
  }"
elif [ -n "$hashword" ]; then
  legacy_gate="  basicauth @legacySurface {
    birdnet $hashword
  }"
  legacy_handles="  handle @legacyProcessed {
    respond @executableSource 404
    file_server
  }
  handle @legacyAdmin {
    route {
      reverse_proxy @legacyLogProxy localhost:8080
      reverse_proxy @legacyStatsProxy localhost:8501
      reverse_proxy @legacyTerminalProxy localhost:8888
      php_fastcgi @legacyPhp unix/$fpm_sock {
        try_files {path} {path}/index.html {path}/index.php =404
        env AVIAN_LEGACY_AUTH 1
        env AVIAN_LEGACY_AUTH_EPOCH $AVIAN_AUTH_EPOCH
      }
      rewrite @legacyPhpSysInfoIndex /phpsysinfo/index.php
      php_fastcgi @legacyPhpSysInfo unix/$fpm_sock {
        try_files {path} {path}/index.html {path}/index.php =404
        env AVIAN_LEGACY_AUTH 1
        env AVIAN_LEGACY_AUTH_EPOCH $AVIAN_AUTH_EPOCH
      }
      respond @executableSource 404
      file_server
    }
  }"
else
  legacy_handles="  # Keep the stock BirdNET-Pi pages usable on the station's
  # private address when no password is configured. A public hostname or a
  # recognized inbound proxy marker falls through to the terminal legacy 404.
  @directProcessed {
    path /Processed /Processed/*
    remote_ip private_ranges
    header_regexp localProcessedHost Host (?i)^(localhost|[a-z0-9][a-z0-9.-]*[.]local|10[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|127[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|192[.]168[.][0-9]{1,3}[.][0-9]{1,3}|172[.](1[6-9]|2[0-9]|3[01])[.][0-9]{1,3}[.][0-9]{1,3}|169[.]254[.][0-9]{1,3}[.][0-9]{1,3}|[[]::1[]]|[[]f[cd][0-9a-f:]*[]]|[[]fe[89ab][0-9a-f:]*[]])(:[0-9]{1,5})?$
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
  handle @directProcessed {
    respond @executableSource 404
    file_server
  }
  @directLegacyAdmin {
    path /index.php /index.php/* /views.php /views.php/* /play.php /play.php/* /spectrogram.php /spectrogram.php/* /overview.php /overview.php/* /stats.php /stats.php/* /todays_detections.php /todays_detections.php/* /history.php /history.php/* /weekly_report.php /weekly_report.php/* /log /log/* /stats /stats/*
    remote_ip private_ranges
    header_regexp localLegacyHost Host (?i)^(localhost|[a-z0-9][a-z0-9.-]*[.]local|10[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|127[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|192[.]168[.][0-9]{1,3}[.][0-9]{1,3}|172[.](1[6-9]|2[0-9]|3[01])[.][0-9]{1,3}[.][0-9]{1,3}|169[.]254[.][0-9]{1,3}[.][0-9]{1,3}|[[]::1[]]|[[]f[cd][0-9a-f:]*[]]|[[]fe[89ab][0-9a-f:]*[]])(:[0-9]{1,5})?$
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
  handle @directLegacyAdmin {
    route {
      reverse_proxy @legacyLogProxy localhost:8080
      reverse_proxy @legacyStatsProxy localhost:8501
      php_fastcgi @legacyPhp unix/$fpm_sock {
        try_files {path} {path}/index.html {path}/index.php =404
      }
      respond @executableSource 404
      file_server
    }
  }
  handle @legacySurface {
    respond 404
  }"
fi

site_overlay_import=''
if [ -e "$site_overlay" ] || [ -L "$site_overlay" ]; then
  if [ -L "$site_overlay" ] || [ ! -f "$site_overlay" ]; then
    echo "Refusing unsafe Caddy site overlay: expected a regular file" >&2
    exit 1
  fi

  caddy_group=$(getent group caddy) \
    || { echo "Refusing Caddy site overlay: caddy group was not found" >&2; exit 1; }
  caddy_gid=$(printf '%s\n' "$caddy_group" | awk -F: 'NR == 1 { print $3 }')
  [ -n "$caddy_gid" ] \
    || { echo "Refusing Caddy site overlay: caddy group was not found" >&2; exit 1; }
  site_overlay_stat=$(stat -c '%u:%g:%a:%h' -- "$site_overlay")
  [ "$site_overlay_stat" = "0:$caddy_gid:640:1" ] \
    || { echo "Refusing unsafe Caddy site overlay: expected root:caddy 0640 with one link" >&2; exit 1; }

  site_overlay_import="  import $site_overlay"$'\n'
fi

stream_guard=''
if [ "$AVIAN_REQUIRE_LAN_AUTH" = 1 ]; then
  stream_guard='      respond 404'
fi

mkdir -p /etc/caddy
rollback=''
had_active=0
if [ -f /etc/caddy/Caddyfile ]; then
  [ ! -L /etc/caddy/Caddyfile ] \
    || { echo "Refusing a symbolic-link Caddyfile" >&2; exit 1; }
  rollback=$(mktemp /etc/caddy/.Caddyfile.rollback.XXXXXX)
  cp -p /etc/caddy/Caddyfile "$rollback"
  had_active=1
  if [ ! -f /etc/caddy/Caddyfile.original ]; then
    install -o root -g "$caddy_gid" -m 0640 \
      /etc/caddy/Caddyfile /etc/caddy/Caddyfile.original
  fi
  install -o root -g "$caddy_gid" -m 0640 \
    /etc/caddy/Caddyfile /etc/caddy/Caddyfile.previous
fi

temp=$(mktemp /etc/caddy/.Caddyfile.XXXXXX)
trap 'rm -f "$temp" "${rollback-}"' EXIT
cat >"$temp" <<EOF
# Managed by AvianVisitors. The prior file is Caddyfile.previous.
http:// {
${site_overlay_import}  root * $EXTRACTED

  @shell path / /index.html
  header @shell Cache-Control "no-cache"

  # The published frame (frame/install-publish.sh) is re-rendered on a timer, so
  # a heuristically-cached copy shows yesterday's birds. no-cache forces
  # revalidation while still allowing the 304 the frame Pi's conditional GET
  # relies on. A no-op where the publisher was never installed and the path does
  # not exist.
  @frame path /frame.png
  header @frame Cache-Control "no-cache"

  # BirdNET-Pi's older PHP tools and reverse-proxied consoles do not share
  # AvianVisitors' session gate. Protect the whole legacy surface with the
  # configured password, or limit it to direct read pages when none exists.
  @legacySurface {
    path /index.php /index.php/* /views.php /views.php/* /play.php /play.php/* /spectrogram.php /spectrogram.php/* /overview.php /overview.php/* /stats.php /stats.php/* /todays_detections.php /todays_detections.php/* /history.php /history.php/* /weekly_report.php /weekly_report.php/* /scripts /scripts/* /Processed /Processed/* /terminal /terminal/* /log /log/* /stats /stats/* /phpsysinfo /phpsysinfo/*
  }
  @legacyAdmin {
    path /index.php /index.php/* /views.php /views.php/* /play.php /play.php/* /spectrogram.php /spectrogram.php/* /overview.php /overview.php/* /stats.php /stats.php/* /todays_detections.php /todays_detections.php/* /history.php /history.php/* /weekly_report.php /weekly_report.php/* /scripts /scripts/* /terminal /terminal/* /log /log/* /stats /stats/* /phpsysinfo /phpsysinfo/*
  }
  @legacyProcessed path /Processed /Processed/*
  @legacyPhp path /index.php /index.php/* /views.php /views.php/* /play.php /play.php/* /spectrogram.php /spectrogram.php/* /overview.php /overview.php/* /stats.php /stats.php/* /todays_detections.php /todays_detections.php/* /history.php /history.php/* /weekly_report.php /weekly_report.php/* /scripts/adminer-de.php /scripts/adminer-de.php/* /scripts/adminer-fr.php /scripts/adminer-fr.php/* /scripts/adminer.php /scripts/adminer.php/* /scripts/advanced.php /scripts/advanced.php/* /scripts/api.php /scripts/api.php/* /scripts/backup.php /scripts/backup.php/* /scripts/common.php /scripts/common.php/* /scripts/config.php /scripts/config.php/* /scripts/ebird.php /scripts/ebird.php/* /scripts/filemanager/filemanager.php /scripts/filemanager/filemanager.php/* /scripts/history.php /scripts/history.php/* /scripts/overview.php /scripts/overview.php/* /scripts/play.php /scripts/play.php/* /scripts/restore.php /scripts/restore.php/* /scripts/service_controls.php /scripts/service_controls.php/* /scripts/species_list.php /scripts/species_list.php/* /scripts/species_tools.php /scripts/species_tools.php/* /scripts/spectrogram.php /scripts/spectrogram.php/* /scripts/stats.php /scripts/stats.php/* /scripts/system_controls.php /scripts/system_controls.php/* /scripts/todays_detections.php /scripts/todays_detections.php/* /scripts/weekly_report.php /scripts/weekly_report.php/*
  @legacyPhpSysInfoIndex path /phpsysinfo /phpsysinfo/
  @legacyPhpSysInfo path_regexp legacyPhpSysInfo (?i)^/phpsysinfo/(?:[^/]+/)*[^/]+[.]php(?:/|$)
  @legacyLogProxy path /log /log/*
  @legacyStatsProxy path /stats /stats/*
  @legacyTerminalProxy path /terminal /terminal/*
  # Match PHP-family fragments anywhere so backup, disabled, and editor
  # suffixes cannot disclose source from a static tree.
  @executableSource path_regexp executableSource (?i)[.](php[0-9]*|phps|phtml|phar)
$legacy_gate
$legacy_handles

  # BirdNET-Pi's notification worker uses this read-only image lookup on
  # localhost. Keep only its reviewed legacy front-controller route public;
  # every other /api/v1 path remains a static 404.
  @legacyImageApi path /api/v1/image/*
  handle @legacyImageApi {
    rewrite * /scripts/api.php
    php_fastcgi unix/$fpm_sock {
      env REQUEST_URI {http.request.orig_uri}
    }
  }

  # Only finished bird PNGs and the two stamp assets are public beneath the
  # writable artwork tree. Generator state, logs, references, staging files,
  # and anything executable remain private even when they exist on disk.
  @publicIllustration path_regexp publicIllustration ^/avian/assets/illustrations/[A-Za-z0-9][A-Za-z0-9_-]*[.]png$
  handle @publicIllustration {
    file_server
  }
  @publicStampReference path /avian/assets/references/sparrow-blossom-single-v2.png /avian/assets/references/sparrow-blossom-pair-v2.png
  handle @publicStampReference {
    file_server
  }
  handle /avian/assets/* {
    respond 404
  }

  # The webroot also links the frontend asset directory. Publish only the
  # checked-in stamp artwork; local recording previews and future working
  # files beneath /assets remain private.
  @publicFrontendStamp path /assets/stamp/owl-pale-treeline.jpg /assets/stamp/paper-texture-grey.png /assets/stamp/rough-concrete-cc0.png
  handle @publicFrontendStamp {
    file_server
  }
  handle /assets/* {
    respond 404
  }

  # Only the reviewed production API entry points are published. This keeps
  # deferred or locally generated handlers private if they remain in an
  # existing checkout during an update, including their source text.
  @unknownAvianApi {
    path /avian/api/*
    not path /avian/api/archive.php /avian/api/birdnet-api.php /avian/api/birdnet-status.php /avian/api/birdweather.php /avian/api/config.php /avian/api/cutout.php /avian/api/export.php /avian/api/generate.php /avian/api/maintenance.php /avian/api/menu.php /avian/api/recording.php /avian/api/spectrogram.php /avian/api/wiki.php
  }
  handle @unknownAvianApi {
    respond 404
  }

  # The top-level webroot links the repository's avian directory so the API
  # and artwork share stable paths. Everything else beneath it stays private;
  # production frontend files are linked at the site root instead.
  @privateAvian {
    path /avian/*
    not path /avian/api/* /avian/assets/*
  }
  handle @privateAvian {
    respond 404
  }

  # A microphone stream can contain nearby conversation. Reject proxy
  # markers first, then allow only a direct private-network peer.
  @stream path /stream /stream/*
  handle @stream {
    route {
$stream_guard
      @forwarded header Forwarded *
      respond @forwarded 404
      @xForwardedFor header X-Forwarded-For *
      respond @xForwardedFor 404
      @xForwardedHost header X-Forwarded-Host *
      respond @xForwardedHost 404
      @xForwardedProto header X-Forwarded-Proto *
      respond @xForwardedProto 404
      @xForwardedPort header X-Forwarded-Port *
      respond @xForwardedPort 404
      @xForwardedServer header X-Forwarded-Server *
      respond @xForwardedServer 404
      @xForwardedScheme header X-Forwarded-Scheme *
      respond @xForwardedScheme 404
      @xForwardedPrefix header X-Forwarded-Prefix *
      respond @xForwardedPrefix 404
      @xRealIp header X-Real-Ip *
      respond @xRealIp 404
      @cloudflare header Cf-Connecting-Ip *
      respond @cloudflare 404
      @cloudflareIPv6 header Cf-Connecting-IPv6 *
      respond @cloudflareIPv6 404
      @cloudflarePseudoIPv4 header Cf-Pseudo-IPv4 *
      respond @cloudflarePseudoIPv4 404
      @cloudflareRay header Cf-Ray *
      respond @cloudflareRay 404
      @cloudflareVisitor header Cf-Visitor *
      respond @cloudflareVisitor 404
      @directLocal {
        remote_ip private_ranges
        header_regexp directLocalStreamHost Host (?i)^(localhost|[a-z0-9][a-z0-9.-]*[.]local|10[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|127[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|192[.]168[.][0-9]{1,3}[.][0-9]{1,3}|172[.](1[6-9]|2[0-9]|3[01])[.][0-9]{1,3}[.][0-9]{1,3}|169[.]254[.][0-9]{1,3}[.][0-9]{1,3}|[[]::1[]]|[[]f[cd][0-9a-f:]*[]]|[[]fe[89ab][0-9a-f:]*[]])(:[0-9]{1,5})?$
      }
      reverse_proxy @directLocal localhost:8000
      respond 404
    }
  }

  handle /By_Date/* {
    respond @executableSource 404
    file_server
  }
  handle /Charts/* {
    respond @executableSource 404
    file_server
  }

  # Caddy adds X-Forwarded-* fields when it talks to PHP-FPM, even for a
  # direct browser on the LAN. Preserve a decision made from the raw request
  # in a FastCGI variable that the browser cannot forge.
  @directAdminApi {
    path /avian/api/*
    remote_ip private_ranges
    header_regexp localAdminApiHost Host (?i)^(localhost|[a-z0-9][a-z0-9.-]*[.]local|10[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|127[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|192[.]168[.][0-9]{1,3}[.][0-9]{1,3}|172[.](1[6-9]|2[0-9]|3[01])[.][0-9]{1,3}[.][0-9]{1,3}|169[.]254[.][0-9]{1,3}[.][0-9]{1,3}|[[]::1[]]|[[]f[cd][0-9a-f:]*[]]|[[]fe[89ab][0-9a-f:]*[]])(:[0-9]{1,5})?$
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
  handle @directAdminApi {
    php_fastcgi unix/$fpm_sock {
      try_files {path} {path}/index.html {path}/index.php =404
      env AVIAN_DIRECT_LOCAL 1
      env AVIAN_FORCE_AUTH $AVIAN_REQUIRE_LAN_AUTH
    }
  }
  handle /avian/api/* {
    php_fastcgi unix/$fpm_sock {
      try_files {path} {path}/index.html {path}/index.php =404
      env AVIAN_DIRECT_LOCAL 0
      env AVIAN_FORCE_AUTH 1
    }
  }

  # Never publish PHP-family source text from any other static tree.
  handle @executableSource {
    respond 404
  }

  handle {
    reverse_proxy @legacyLogProxy localhost:8080
    reverse_proxy @legacyStatsProxy localhost:8501
    reverse_proxy @legacyTerminalProxy localhost:8888
    file_server
  }
}
EOF

caddy fmt --overwrite "$temp"
caddy validate --config "$temp" --adapter caddyfile
if ! install_icecast_start_guard; then
  echo "Could not install the systemd live audio policy guard" >&2
  exit 1
fi
if ! migrate_icecast_transition; then
  echo "Live audio transition state is unsafe" >&2
  exit 1
fi
if [ "$icecast_protection_check" = 1 ]; then
  ensure_icecast_blocked \
    || { echo "Could not preserve and block the live audio service state" >&2; exit 1; }
elif [ "$icecast_restore_check" = 1 ]; then
  prepare_icecast_restore \
    || { echo "Live audio restore state is unsafe" >&2; exit 1; }
fi
caddy_was_active=0
if systemctl is-active --quiet caddy; then
  caddy_was_active=1
fi
if [ "$caddy_was_active" = 1 ]; then
  caddy_action=reload
else
  caddy_action=start
fi

# Make the candidate durable before Caddy reports a successful reload. The
# same-directory rename keeps readers from observing a partially written file.
candidate_ready=1
chown root:"$caddy_gid" "$temp" || candidate_ready=0
chmod 0640 "$temp" || candidate_ready=0
if [ "$candidate_ready" = 1 ]; then
  sync -f "$temp" || candidate_ready=0
fi
if [ "$candidate_ready" = 1 ]; then
  mv -fT "$temp" /etc/caddy/Caddyfile || candidate_ready=0
  [ "$candidate_ready" != 1 ] || temp=''
fi
if [ "$candidate_ready" = 1 ]; then
  sync -f /etc/caddy/Caddyfile || candidate_ready=0
  sync -f /etc/caddy || candidate_ready=0
fi

if [ "$candidate_ready" != 1 ] || ! systemctl "$caddy_action" caddy; then
  rollback_ready=1
  if [ "$had_active" = 1 ]; then
    chown root:"$caddy_gid" "$rollback" || rollback_ready=0
    chmod 0640 "$rollback" || rollback_ready=0
    if [ "$rollback_ready" = 1 ]; then
      sync -f "$rollback" || rollback_ready=0
    fi
    if [ "$rollback_ready" = 1 ]; then
      mv -fT "$rollback" /etc/caddy/Caddyfile || rollback_ready=0
      [ "$rollback_ready" != 1 ] || rollback=''
    fi
    if [ "$rollback_ready" = 1 ]; then
      sync -f /etc/caddy/Caddyfile || rollback_ready=0
    fi
  else
    rm -f /etc/caddy/Caddyfile || rollback_ready=0
  fi
  sync -f /etc/caddy || rollback_ready=0
  if [ "$rollback_ready" = 1 ] && [ "$caddy_was_active" = 1 ]; then
    systemctl reload caddy >/dev/null 2>&1 || true
  fi
  if [ "$rollback_ready" = 1 ]; then
    echo "Caddy reload failed; prior configuration restored" >&2
  else
    echo "Caddy reload failed and the prior configuration could not be restored" >&2
  fi
  exit 1
fi
if [ "$icecast_protection_check" = 1 ]; then
  # A Caddy reload closes the route for new listeners, but older Caddy
  # versions can keep an established audio proxy alive. A failed unit can
  # also retain a process in its cgroup. Stop the backend without restarting
  # it. The systemd condition keeps every later start blocked while protected.
  if ! stop_icecast_backend; then
    echo "Icecast could not be stopped; an older live audio connection may remain" >&2
    exit 20
  fi
elif [ "$icecast_restore_check" = 1 ]; then
  if ! finish_icecast_restore; then
    echo "Icecast could not be restored after LAN protection was disabled" >&2
    exit 21
  fi
fi
rm -f "$rollback"
rollback=''
trap - EXIT
if [ "$policy_invalid" = 1 ] \
  || { [ "$AVIAN_REQUIRE_LAN_AUTH" = 1 ] && [ -z "$hashword" ]; }; then
  echo "LAN admin auth is fail-closed until the credential state is repaired" >&2
  exit 1
fi
