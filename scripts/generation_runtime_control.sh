#!/usr/bin/env bash
# Recreate the ephemeral illustration mutex after boot and recover a durable
# invalid journal before Caddy can expose mutable included artwork.

set -euo pipefail
IFS=$'\n\t'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
umask 077

readonly INSTALLED_HELPER=/usr/local/sbin/avian-generation-runtime
readonly CONFIG_FILE=/etc/birdnet/birdnet.conf
readonly GENERATION_LOCK=/run/lock/avian-generation.lock
readonly ART_REVISION_STATE=/var/lib/avian-visitors/included-art.revision
INVALID_ART_REVISION=$(printf 'invalid%057d' 0 | tr 0 '!')
readonly INVALID_ART_REVISION

die() {
  printf 'Illustration runtime recovery failed: %s\n' "$*" >&2
  exit 1
}

[ "${EUID:-$(id -u)}" -eq 0 ] || die 'root is required'
[ "$(readlink -f "$0")" = "$INSTALLED_HELPER" ] \
  || die "use the installed helper at $INSTALLED_HELPER"
[ -f "$INSTALLED_HELPER" ] && [ ! -L "$INSTALLED_HELPER" ] \
  && [ "$(stat -c '%u:%g:%a:%h' "$INSTALLED_HELPER")" = 0:0:755:1 ] \
  || die 'the installed helper is unsafe'

conf_value() {
  local key=$1
  awk -v wanted="$key" '
    $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
      value=$0
      sub(/^[^=]*=/, "", value)
      gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", value)
      print value
      exit
    }
  ' "$CONFIG_FILE" 2>/dev/null || true
}

[ -r "$CONFIG_FILE" ] || die 'BirdNET-Pi configuration was not found'
station_user=$(conf_value BIRDNET_USER)
[[ "$station_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || die 'BirdNET-Pi user is invalid'
passwd_row=$(getent passwd "$station_user")
[ -n "$passwd_row" ] || die 'BirdNET-Pi user does not exist'
station_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
[[ "$station_home" =~ ^/[A-Za-z0-9._/+@-]+$ && "$station_home" != *'..'* ]] \
  || die 'BirdNET-Pi home path is invalid'
repo_dir=$station_home/BirdNET-Pi
[ -d "$repo_dir" ] && [ ! -L "$repo_dir" ] \
  || die 'BirdNET-Pi checkout was not found'
station_gid=$(id -g "$station_user") || die 'BirdNET-Pi group was not found'
caddy_group=$(getent group caddy | awk -F: 'NR == 1 { print $1 }')
caddy_gid=$(getent group caddy | awk -F: 'NR == 1 { print $3 }')
[ "$caddy_group" = caddy ] || die 'Caddy group was not found'
[ -n "$caddy_gid" ] || die 'Caddy group was not found'

run_as_station() {
  /usr/sbin/runuser -u "$station_user" -- \
    env -i HOME="$station_home" USER="$station_user" LOGNAME="$station_user" \
    PATH=/usr/local/bin:/usr/bin:/bin "$@"
}

if [ ! -e "$GENERATION_LOCK" ] && [ ! -L "$GENERATION_LOCK" ]; then
  install -o root -g "$station_gid" -m 0660 /dev/null "$GENERATION_LOCK"
fi
[ -f "$GENERATION_LOCK" ] && [ ! -L "$GENERATION_LOCK" ] \
  && [ "$(stat -c '%u:%g:%a:%h' "$GENERATION_LOCK")" = "0:$station_gid:660:1" ] \
  || die 'illustration generation lock is unsafe'
exec 8<>"$GENERATION_LOCK"
flock 8

state_parent=${ART_REVISION_STATE%/*}
[ -d "$state_parent" ] && [ ! -L "$state_parent" ] \
  && [ "$(stat -c '%u:%g:%a' "$state_parent")" = 0:0:755 ] \
  || die 'illustration revision state directory is unsafe'
needs_rebuild=false
if [ ! -e "$ART_REVISION_STATE" ] && [ ! -L "$ART_REVISION_STATE" ]; then
  install -o root -g "$station_gid" -m 0660 /dev/null "$ART_REVISION_STATE"
  printf '%s\n' "$INVALID_ART_REVISION" \
    | dd of="$ART_REVISION_STATE" bs=65 count=1 iflag=fullblock \
      conv=notrunc,fsync status=none
  truncate -s 65 "$ART_REVISION_STATE"
  sync -f "$ART_REVISION_STATE"
  needs_rebuild=true
fi
[ -f "$ART_REVISION_STATE" ] && [ ! -L "$ART_REVISION_STATE" ] \
  && [ "$(stat -c '%u:%g:%a:%h' "$ART_REVISION_STATE")" = "0:$station_gid:660:1" ] \
  || die 'illustration revision state is unsafe'
if [ "$(stat -c '%s' "$ART_REVISION_STATE")" -ne 65 ] \
  || ! grep -Eq '^[0-9a-f]{64}$' "$ART_REVISION_STATE"; then
  needs_rebuild=true
fi

if [ "$needs_rebuild" = true ]; then
  builder=$repo_dir/avian/scripts/build_masks.py
  [ -f "$builder" ] && [ ! -L "$builder" ] \
    && grep -Fq 'AVIAN_ART_REVISION_STATE' "$builder" \
    || die 'journal-aware illustration inventory builder is missing'
  python=$repo_dir/birdnet/bin/python3
  [ -x "$python" ] || python=/usr/bin/python3
  [ -x "$python" ] || die 'Python is unavailable'
  run_as_station env \
    AVIAN_GENERATION_LOCK="$GENERATION_LOCK" \
    AVIAN_GENERATION_LOCK_FD=8 \
    AVIAN_ART_REVISION_STATE="$ART_REVISION_STATE" \
    PYTHONDONTWRITEBYTECODE=1 \
    "$python" "$builder" \
    || die 'could not rebuild the illustration inventory'
  [ "$(stat -c '%s' "$ART_REVISION_STATE")" -eq 65 ] \
    && grep -Eq '^[0-9a-f]{64}$' "$ART_REVISION_STATE" \
    || die 'illustration revision was not committed'
fi

# Missing tables rebuilt under umask 077 need their exact runtime group restored
# before the exclusive lock is released and Caddy starts.
for table in \
  "$repo_dir/avian/frontend/dims.json" \
  "$repo_dir/avian/frontend/masks.json"; do
  [ -f "$table" ] && [ ! -L "$table" ] \
    || die "illustration inventory table is missing: $table"
  chown "$station_user:$caddy_group" "$table"
  chmod 0660 "$table"
  sync -f "$table"
done
sync -f "$repo_dir/avian/frontend"

printf 'illustration runtime: ok\n'
