#!/usr/bin/env bash
# Root-owned control plane for the two maintenance actions exposed in Tools.

set -Eeuo pipefail
IFS=$'\n\t'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

readonly CONTROL_VERSION=2
readonly CONTROL_HELPER=/usr/local/sbin/avian-maintenance-control
readonly UPDATE_HELPER=/usr/local/sbin/avian-update-control
readonly REFRESH_HELPER=/usr/local/sbin/avian-service-refresh
readonly state_dir=/var/lib/avian-maintenance
readonly state_file=$state_dir/status
readonly unit=avian-maintenance

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
  local message=${1:-maintenance control failed}
  printf '{"ok":false,"error":"%s"}\n' "$(json_escape "$message")"
  exit 1
}

[ "${EUID:-$(id -u)}" -eq 0 ] || fail 'maintenance control must run as root'
[ "$(readlink -f "$0")" = "$CONTROL_HELPER" ] \
  || fail "maintenance must use $CONTROL_HELPER"

safe_root_helper() {
  local helper=$1 owner mode
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] || return 1
  owner=$(stat -c '%u:%g' "$helper")
  mode=$(stat -c '%a' "$helper")
  [ "$owner" = 0:0 ] && [ "$mode" = 755 ]
}

state_value() {
  local key=$1 fallback=${2-} value=''
  if [ -r "$state_file" ]; then
    value=$(awk -F= -v wanted="$key" \
      '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$state_file")
  fi
  printf '%s' "${value:-$fallback}"
}

write_state() {
  local state=$1 action=$2 detail=$3 started=$4 finished=${5-} temp
  install -d -o root -g root -m 0755 "$state_dir"
  temp=$(mktemp "$state_dir/.status.XXXXXX") \
    || fail 'could not create maintenance state'
  {
    printf 'state=%s\n' "$state"
    printf 'action=%s\n' "$action"
    printf 'detail=%s\n' "$detail"
    printf 'started=%s\n' "$started"
    printf 'finished=%s\n' "$finished"
  } >"$temp"
  install -o root -g root -m 0644 "$temp" "$state_file"
  rm -f "$temp"
}

print_status() {
  local state action detail started finished active
  state=$(state_value state idle)
  action=$(state_value action '')
  detail=$(state_value detail '')
  started=$(state_value started '')
  finished=$(state_value finished '')
  active=$(systemctl is-active "$unit.service" 2>/dev/null || true)
  if [ "$active" = active ] || [ "$active" = activating ]; then
    state=running
  fi
  printf '{"ok":true,"version":%s,"state":"%s","action":"%s","detail":"%s","started":"%s","finished":"%s"}\n' \
    "$CONTROL_VERSION" "$(json_escape "$state")" "$(json_escape "$action")" \
    "$(json_escape "$detail")" "$(json_escape "$started")" "$(json_escape "$finished")"
}

helper_for_action() {
  case "$1" in
    update) printf '%s' "$UPDATE_HELPER" ;;
    services) printf '%s' "$REFRESH_HELPER" ;;
    *) return 64 ;;
  esac
}

run_work() {
  local action=$1 helper started rc=0
  helper=$(helper_for_action "$action") || return $?
  if ! safe_root_helper "$helper"; then
    started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    write_state failed "$action" 'helper unavailable' "$started" "$started"
    return 1
  fi

  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  write_state running "$action" running "$started" ''
  "$helper" || rc=$?
  if [ "$rc" -eq 0 ]; then
    write_state complete "$action" complete "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    write_state failed "$action" "exit $rc" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
  return "$rc"
}

start_work() {
  local action=$1 active started
  helper_for_action "$action" >/dev/null || fail 'unknown action'
  active=$(systemctl is-active "$unit.service" 2>/dev/null || true)
  if [ "$active" = active ] || [ "$active" = activating ]; then
    fail 'maintenance is already running'
  fi
  systemctl reset-failed "$unit.service" >/dev/null 2>&1 || true
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  write_state queued "$action" queued "$started" ''
  if ! systemd-run --quiet --collect --unit="$unit" \
    --property=Type=oneshot --property=UMask=0077 \
    "$CONTROL_HELPER" __work "$action"; then
    write_state failed "$action" 'could not start' "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    fail 'could not start maintenance'
  fi
  print_status
}

action=${1:-status}
case "$action" in
  status)
    [ "$#" -le 1 ] || fail 'unexpected arguments'
    print_status
    ;;
  update|services)
    [ "$#" -eq 1 ] || fail 'unexpected arguments'
    start_work "$action"
    ;;
  __work)
    [ "$#" -eq 2 ] || exit 64
    run_work "$2"
    ;;
  *) fail 'unknown action' ;;
esac
