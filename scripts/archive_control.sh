#!/usr/bin/env bash
# Privileged control plane for the optional AvianVisitors Drive archive.
#
# The web UI may invoke only the fixed actions below. OAuth credentials and
# remote paths never cross the API. The archive worker itself always runs as
# the unprivileged BirdNET-Pi user.

set -u -o pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

CONTROL_VERSION=1

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
  local message=${1:-archive control failed}
  printf '{"ok":false,"error":"%s"}\n' "$(json_escape "$message")"
  exit 1
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  fail "archive control must run as root"
fi

birdnet_user=''
if [ -r /etc/birdnet/birdnet.conf ]; then
  birdnet_user=$(awk -F= '
    /^[[:space:]]*BIRDNET_USER[[:space:]]*=/ {
      value=$0; sub(/^[^=]*=/, "", value); gsub(/^[[:space:]"'\'']+|[[:space:]"'\'']+$/, "", value);
      print value; exit
    }
  ' /etc/birdnet/birdnet.conf)
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
[[ "$birdnet_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || fail "could not resolve the BirdNET-Pi user"

passwd_row=$(getent passwd "$birdnet_user")
[ -n "$passwd_row" ] || fail "BirdNET-Pi user does not exist"
birdnet_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
birdnet_uid=$(id -u "$birdnet_user")
birdnet_gid=$(id -g "$birdnet_user")
[[ "$birdnet_home" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "BirdNET-Pi home path is not safe"
[[ "$birdnet_home" != *'..'* ]] || fail "BirdNET-Pi home path is not safe"

repo_dir="$birdnet_home/BirdNET-Pi"
source_dir="$repo_dir/extras/archive"
archive_dir="$birdnet_home/bird-archive"
archive_script="$archive_dir/archive_to_drive.sh"
archive_conf="$archive_dir/archive.conf"
archive_status="$archive_dir/status"
birdnet_conf="$repo_dir/birdnet.conf"
service_path=/etc/systemd/system/bird-archive.service
timer_path=/etc/systemd/system/bird-archive.timer

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

require_safe_archive_dir() {
  path_exists "$archive_dir" || return 0
  [ -d "$archive_dir" ] && [ ! -L "$archive_dir" ] \
    || fail "archive directory is not a regular directory"
  [ "$(readlink -f -- "$archive_dir")" = "$archive_dir" ] \
    || fail "archive directory leaves the station home"
  [ "$(stat -c %U -- "$archive_dir")" = "$birdnet_user" ] \
    || fail "archive directory has the wrong owner"
}

require_safe_regular_file() {
  local path=$1 expected_owner=$2 label=$3
  path_exists "$path" || return 0
  [ -f "$path" ] && [ ! -L "$path" ] \
    || fail "$label is not a regular file"
  [ "$(stat -c %h -- "$path")" = 1 ] \
    || fail "$label has multiple hard links"
  [ "$(stat -c %U -- "$path")" = "$expected_owner" ] \
    || fail "$label has the wrong owner"
}

safe_copy_into_archive() {
  local source=$1 destination_name=$2 owner_id=$3 group_id=$4 mode=$5 label=$6
  case "$destination_name" in
    archive_to_drive.sh|archive.conf) ;;
    *) fail "archive destination is not allowed" ;;
  esac
  /usr/bin/python3 - \
    "$birdnet_home" "$birdnet_uid" "$source" "$destination_name" \
    "$owner_id" "$group_id" "$mode" 2>/dev/null <<'PY' \
    || fail "could not install $label"
import os
import secrets
import stat
import sys

home, station_uid, source, destination, owner, group, mode = sys.argv[1:]
station_uid = int(station_uid)
owner = int(owner)
group = int(group)
mode = int(mode, 8)
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
home_fd = os.open(home, flags | os.O_DIRECTORY)
directory_fd = -1
source_fd = -1
temp_fd = -1
temp_name = ".archive-write-" + secrets.token_hex(12)
try:
    directory_fd = os.open("bird-archive", flags | os.O_DIRECTORY, dir_fd=home_fd)
    directory_stat = os.fstat(directory_fd)
    if directory_stat.st_uid != station_uid:
        raise PermissionError("archive directory owner changed")
    source_fd = os.open(source, flags)
    source_stat = os.fstat(source_fd)
    if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_nlink != 1:
        raise PermissionError("archive source is not a single regular file")
    temp_fd = os.open(
        temp_name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory_fd,
    )
    while True:
        chunk = os.read(source_fd, 1024 * 1024)
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            written = os.write(temp_fd, view)
            view = view[written:]
    os.fchown(temp_fd, owner, group)
    os.fchmod(temp_fd, mode)
    os.fsync(temp_fd)
    os.close(temp_fd)
    temp_fd = -1
    os.replace(temp_name, destination, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
    os.fsync(directory_fd)
except Exception:
    try:
        os.unlink(temp_name, dir_fd=directory_fd)
    except Exception:
        pass
    raise
finally:
    for descriptor in (temp_fd, source_fd, directory_fd, home_fd):
        if descriptor >= 0:
            os.close(descriptor)
PY
}

ensure_archive_dir() {
  /usr/bin/python3 - "$birdnet_home" "$birdnet_uid" "$birdnet_gid" 2>/dev/null <<'PY' \
    || fail "archive directory is unsafe"
import os
import sys

home, owner, group = sys.argv[1:]
owner = int(owner)
group = int(group)
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
home_fd = os.open(home, flags | os.O_DIRECTORY)
directory_fd = -1
created = False
try:
    try:
        os.mkdir("bird-archive", 0o700, dir_fd=home_fd)
        created = True
    except FileExistsError:
        pass
    directory_fd = os.open("bird-archive", flags | os.O_DIRECTORY, dir_fd=home_fd)
    directory_stat = os.fstat(directory_fd)
    if not created and directory_stat.st_uid != owner:
        raise PermissionError("archive directory has the wrong owner")
    os.fchown(directory_fd, owner, group)
    os.fchmod(directory_fd, 0o700)
    os.fsync(directory_fd)
finally:
    if directory_fd >= 0:
        os.close(directory_fd)
    os.close(home_fd)
PY
}

snapshot_archive_file() {
  local source_name=$1 destination=$2 expected_owner_id=$3
  case "$source_name" in
    archive.conf|status) ;;
    *) fail "archive source is not allowed" ;;
  esac
  /usr/bin/python3 - \
    "$birdnet_home" "$birdnet_uid" "$source_name" "$destination" \
    "$expected_owner_id" 2>/dev/null <<'PY'
import os
import stat
import sys

home, station_uid, source_name, destination, expected_owner = sys.argv[1:]
station_uid = int(station_uid)
expected_owner = int(expected_owner)
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
home_fd = os.open(home, flags | os.O_DIRECTORY)
directory_fd = -1
source_fd = -1
destination_fd = -1
try:
    directory_fd = os.open("bird-archive", flags | os.O_DIRECTORY, dir_fd=home_fd)
    if os.fstat(directory_fd).st_uid != station_uid:
        raise PermissionError("archive directory owner changed")
    source_fd = os.open(source_name, flags, dir_fd=directory_fd)
    source_stat = os.fstat(source_fd)
    if (not stat.S_ISREG(source_stat.st_mode) or source_stat.st_nlink != 1
            or source_stat.st_uid != expected_owner):
        raise PermissionError("archive source is unsafe")
    destination_fd = os.open(
        destination,
        os.O_WRONLY | os.O_TRUNC | os.O_CLOEXEC | os.O_NOFOLLOW,
    )
    while True:
        chunk = os.read(source_fd, 1024 * 1024)
        if not chunk:
            break
        view = memoryview(chunk)
        while view:
            written = os.write(destination_fd, view)
            view = view[written:]
    os.fsync(destination_fd)
finally:
    for descriptor in (destination_fd, source_fd, directory_fd, home_fd):
        if descriptor >= 0:
            os.close(descriptor)
PY
}

require_safe_archive_dir
require_safe_regular_file "$archive_script" root "archive worker"
require_safe_regular_file "$archive_conf" "$birdnet_user" "archive config"
require_safe_regular_file "$archive_status" "$birdnet_user" "archive status"

conf_value() {
  local file=$1 key=$2 fallback=${3-}
  local value=''
  if [ -r "$file" ]; then
    value=$(awk -v wanted="$key" '
      $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
        value=$0; sub(/^[^=]*=/, "", value); gsub(/^[[:space:]]+|[[:space:]]+$/, "", value);
        if (value ~ /^".*"$/) { sub(/^"/, "", value); sub(/"$/, "", value) }
        print value; exit
      }
    ' "$file")
  fi
  printf '%s' "${value:-$fallback}"
}

write_conf_value() {
  local key=$1 value=$2
  require_safe_archive_dir
  require_safe_regular_file "$archive_conf" "$birdnet_user" "archive config"
  [ -f "$archive_conf" ] || fail "archive is not installed"
  local snapshot temp
  snapshot=$(mktemp /run/avian-archive-read.XXXXXX) || fail "could not read archive config"
  temp=$(mktemp /run/avian-archive-write.XXXXXX) || { rm -f -- "$snapshot"; fail "could not create archive config"; }
  if ! snapshot_archive_file archive.conf "$snapshot" "$birdnet_uid"; then
    rm -f -- "$snapshot" "$temp"
    fail "could not read archive config"
  fi
  if ! awk -v wanted="$key" -v replacement="$value" '
    BEGIN { found=0 }
    $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
      print wanted "=" replacement; found=1; next
    }
    { print }
    END { if (!found) print wanted "=" replacement }
  ' "$snapshot" >"$temp"; then
    rm -f -- "$snapshot" "$temp"
    fail "could not update archive config"
  fi
  safe_copy_into_archive "$temp" archive.conf \
    "$birdnet_uid" "$birdnet_gid" 0600 "archive config"
  rm -f -- "$snapshot" "$temp"
}

dependency_state() {
  command -v "$1" >/dev/null 2>&1 && printf true || printf false
}

installed=false
if [ -x "$archive_script" ] && [ -f "$archive_conf" ] && [ -f "$service_path" ] && [ -f "$timer_path" ]; then
  installed=true
fi

remote=$(conf_value "$archive_conf" REMOTE 'gdrive:AvianVisitors')
remote_name=${remote%%:*}
remote_configured=false
if [[ "$remote_name" =~ ^[A-Za-z0-9_-]+$ ]]; then
  for rclone_conf in "$birdnet_home/.config/rclone/rclone.conf" "$birdnet_home/.rclone.conf"; do
    if [ -r "$rclone_conf" ] && awk -v section="[$remote_name]" '
      /^\[/ { active = ($0 == section) }
      active && /^[[:space:]]*type[[:space:]]*=[[:space:]]*drive[[:space:]]*$/ { drive = 1 }
      active && /^[[:space:]]*token[[:space:]]*=/ && /"refresh_token"[[:space:]]*:/ { token = 1 }
      END { exit !(drive && token) }
    ' "$rclone_conf"; then
      remote_configured=true
      break
    fi
  done
fi

preserve=false
max_files=$(conf_value "$birdnet_conf" MAX_FILES_SPECIES 0)
if [[ "$max_files" =~ ^[0-9]+$ ]] && [ "$max_files" -ge 10000 ]; then preserve=true; fi
full_disk=$(conf_value "$birdnet_conf" FULL_DISK '')
retention_ready=false
if [ "$preserve" = true ] && [ "$full_disk" = keep ]; then retention_ready=true; fi

last_state=never
last_at=''
last_detail=''
last_verified_files=0
if [ -r "$archive_status" ]; then
  status_line=$(head -n 1 "$archive_status")
  last_state=${status_line%% *}
  [ "$last_state" = OK ] || [ "$last_state" = FAIL ] || last_state=unknown
  last_at=$(printf '%s' "$status_line" | awk '{print $2}')
  last_detail=$(printf '%s' "$status_line" | cut -d' ' -f3-)
  [ "$last_detail" = "$status_line" ] && last_detail=''
  if [[ "$status_line" =~ verified_files=([0-9]+) ]]; then
    last_verified_files=${BASH_REMATCH[1]}
  fi
fi

timer_enabled=$(systemctl is-enabled bird-archive.timer 2>/dev/null || true)
timer_active=$(systemctl is-active bird-archive.timer 2>/dev/null || true)
service_active=$(systemctl is-active bird-archive.service 2>/dev/null || true)
next_run=$(systemctl show bird-archive.timer -p NextElapseUSecRealtime --value 2>/dev/null || true)
purge=$(conf_value "$archive_conf" PURGE false)
[ "$purge" = true ] || purge=false
keep_days=$(conf_value "$archive_conf" KEEP_DAYS 0)
[[ "$keep_days" =~ ^[0-9]+$ ]] || keep_days=0

print_status() {
  printf '{'
  printf '"ok":true,"version":%s,' "$CONTROL_VERSION"
  printf '"installed":%s,' "$installed"
  printf '"dependencies":{"rclone":%s,"sqlite3":%s},' "$(dependency_state rclone)" "$(dependency_state sqlite3)"
  printf '"remote":{"name":"%s","configured":%s},' "$(json_escape "$remote_name")" "$remote_configured"
  printf '"retention":{"preserve":%s,"full_disk":"%s","ready":%s},' "$preserve" "$(json_escape "$full_disk")" "$retention_ready"
  printf '"timer":{"enabled":"%s","active":"%s","next":"%s"},' \
    "$(json_escape "$timer_enabled")" "$(json_escape "$timer_active")" "$(json_escape "$next_run")"
  printf '"service":{"active":"%s"},' "$(json_escape "$service_active")"
  printf '"purge":%s,"keep_days":%s,' "$purge" "$keep_days"
  printf '"last":{"state":"%s","at":"%s","detail":"%s","verified_files":%s}' \
    "$(json_escape "$last_state")" "$(json_escape "$last_at")" "$(json_escape "$last_detail")" "$last_verified_files"
  printf '}\n'
}

require_installed() {
  [ "$installed" = true ] || fail "archive is not installed"
}

require_ready() {
  require_installed
  command -v rclone >/dev/null 2>&1 || fail "rclone is not installed"
  command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 is not installed"
  [ "$remote_configured" = true ] || fail "rclone remote $remote_name is not configured"
  [ "$retention_ready" = true ] || fail "set Preserve all recordings and When disk fills to keep first"
}

action=${1:-status}
case "$action" in
  status)
    print_status
    ;;
  install)
    require_safe_regular_file "$source_dir/archive_to_drive.sh" "$birdnet_user" "archive worker source"
    require_safe_regular_file "$source_dir/archive.conf.example" "$birdnet_user" "archive config template"
    [ -f "$source_dir/archive_to_drive.sh" ] || fail "archive extra is missing from this checkout"
    [ -f "$source_dir/archive.conf.example" ] || fail "archive config template is missing"
    ensure_archive_dir
    require_safe_archive_dir
    require_safe_regular_file "$archive_script" root "archive worker"
    require_safe_regular_file "$archive_conf" "$birdnet_user" "archive config"
    safe_copy_into_archive "$source_dir/archive_to_drive.sh" archive_to_drive.sh \
      0 0 0755 "archive worker"
    if [ ! -f "$archive_conf" ]; then
      safe_copy_into_archive "$source_dir/archive.conf.example" archive.conf \
        "$birdnet_uid" "$birdnet_gid" 0600 "archive config"
    else
      config_snapshot=$(mktemp /run/avian-archive-install.XXXXXX) \
        || fail "could not read archive config"
      if ! snapshot_archive_file archive.conf "$config_snapshot" "$birdnet_uid"; then
        rm -f -- "$config_snapshot"
        fail "could not read archive config"
      fi
      safe_copy_into_archive "$config_snapshot" archive.conf \
        "$birdnet_uid" "$birdnet_gid" 0600 "archive config"
      rm -f -- "$config_snapshot"
    fi
    cat >"$service_path" <<EOF
[Unit]
Description=AvianVisitors nightly Google Drive archive
Wants=network-online.target time-sync.target
After=network-online.target time-sync.target
StartLimitIntervalSec=6h
StartLimitBurst=3

[Service]
Type=oneshot
User=$birdnet_user
UMask=0077
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
ExecStart=$archive_script
TimeoutStartSec=2h
Restart=on-failure
RestartSec=600
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
SystemCallArchitectures=native
EOF
    cat >"$timer_path" <<'EOF'
[Unit]
Description=Nightly AvianVisitors archive at 03:15

[Timer]
OnCalendar=*-*-* 03:15:00
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF
    chmod 0644 "$service_path" "$timer_path"
    systemctl daemon-reload >/dev/null 2>&1 || fail "systemd reload failed"
    installed=true
    print_status
    ;;
  enable)
    require_ready
    # A newly enabled schedule always starts copy-only. Cleanup requires its
    # own visible opt-in after the schedule is running.
    if [ "$purge" = true ]; then
      write_conf_value PURGE false
      purge=false
    fi
    systemctl enable --now bird-archive.timer >/dev/null 2>&1 || fail "could not enable the archive timer"
    timer_enabled=enabled
    timer_active=active
    next_run=$(systemctl show bird-archive.timer -p NextElapseUSecRealtime --value 2>/dev/null || true)
    print_status
    ;;
  disable)
    require_installed
    # Cleanup belongs to the nightly schedule. Clear it first so a failed
    # timer operation can only leave the safer copy-only behavior behind.
    if [ "$purge" = true ]; then
      write_conf_value PURGE false
      purge=false
    fi
    systemctl disable --now bird-archive.timer >/dev/null 2>&1 || fail "could not disable the archive timer"
    timer_enabled=disabled
    timer_active=inactive
    next_run=''
    print_status
    ;;
  run)
    require_ready
    if [ "$service_active" = active ] || [ "$service_active" = activating ]; then
      fail "an archive run is already active"
    fi
    systemctl --no-block start bird-archive.service >/dev/null 2>&1 || fail "could not start the archive"
    service_active=activating
    print_status
    ;;
  purge-on)
    require_ready
    [ "$timer_enabled" = enabled ] || fail "enable the nightly archive before local cleanup"
    if [ "$last_state" != OK ] || [ "$last_verified_files" -le 0 ]; then
      fail "run and verify at least one file before enabling local cleanup"
    fi
    write_conf_value PURGE true
    purge=true
    print_status
    ;;
  purge-off)
    require_installed
    write_conf_value PURGE false
    purge=false
    print_status
    ;;
  *)
    fail "unknown archive action"
    ;;
esac
