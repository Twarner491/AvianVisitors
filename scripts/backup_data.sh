#!/usr/bin/env bash
# Backup and restore BirdNET data

set -e
set -o pipefail

conf=/etc/birdnet/birdnet.conf
[ -r "$conf" ] || { echo "BirdNET-Pi config was not found" >&2; exit 1; }
conf_value() {
  local key=$1
  awk -v wanted="$key" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" wanted "[[:space:]]*=" {
      value=$0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+#[^#]*$/, "", value)
      gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", value)
      found=1
    }
    END { if (found) print value }
  ' "$conf"
}
BIRDNET_USER=$(conf_value BIRDNET_USER)
RECS_DIR=$(conf_value RECS_DIR)
EXTRACTED=$(conf_value EXTRACTED)
CADDY_PWD=$(conf_value CADDY_PWD)
[[ "$BIRDNET_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || { echo "BirdNET-Pi user is invalid" >&2; exit 1; }
[[ "$RECS_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$RECS_DIR" != *'..'* ]] \
  || { echo "BirdNET-Pi recordings path is invalid" >&2; exit 1; }
[[ "$EXTRACTED" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$EXTRACTED" != *'..'* ]] \
  || { echo "BirdNET-Pi extracted path is invalid" >&2; exit 1; }
birdnet_home=$(getent passwd "$BIRDNET_USER" | cut -d: -f6)
[[ "$birdnet_home" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$birdnet_home" != *'..'* ]] \
  || { echo "BirdNET-Pi home is invalid" >&2; exit 1; }
my_dir=$birdnet_home/BirdNET-Pi/scripts

if [ "$EUID" == 0 ]
  then echo "Please run as a non-root user."
  exit
fi

usage() { echo "Usage: $0 -a backup|restore|size -f <backup_file>" 1>&2; exit 1; }

unset -v ACTION
unset -v ARCHIVE
unset -v QUIET
while getopts "a:f:" o; do
  case "${o}" in
    a)
      ACTION=${OPTARG}
      [ $ACTION == "backup" ] || [ $ACTION == "restore" ] || [ $ACTION == "size" ] || usage
      ;;
    f)
      ARCHIVE=${OPTARG}
      ;;
    *)
      usage
      ;;
  esac
done

[ -z "$ACTION" ] && usage && exit 1
if [ $ACTION != "size" ]; then
  [ -z "$ARCHIVE" ] && usage && exit 1
  [ "$ARCHIVE" == '-' ] && [ $ACTION == "backup" ] && QUIET=1
fi

MEG=1048576
UNPACK="$RECS_DIR/tmp"

log() {
  [ -z "${QUIET:-}" ] && echo "$1"
  return 0
}

backup_check() {
  if [ "$ARCHIVE" != '-' ]; then
    [ -f "$ARCHIVE" ] && echo "$ARCHIVE already exists" && exit 1
    estimated_backup_size
    available_space_for_backup
    AVL_MB=$(printf "%1.f" "$(bc <<< "$AVAILABLE / $MEG")")
    EST_MB=$(printf "%1.f" "$(bc <<< "$ESTIMATED / $MEG")")
    log "Estimated space needed: ${EST_MB}M ($ESTIMATED), space available: ${AVL_MB}M ($AVAILABLE)"
    [ $ESTIMATED -gt $AVAILABLE ] && echo "Not enough space available on $(dirname "$ARCHIVE")"  && exit 1
  fi
  return 0
}

backup() {
  log "Starting backup, this might take a while"
  local tar_args=(--create -f "$ARCHIVE") obj
  for obj in "${optional[@]}"; do
    [ ! -f "$obj" ] || tar_args+=(-C "$(dirname "$obj")" "$(basename "$obj")")
  done
  for obj in "${backup_required[@]}"; do
    tar_args+=(-C "$(dirname "$obj")" "$(basename "$obj")")
  done
  tar "${tar_args[@]}" || return 1
  log "Backup done"
}

estimated_backup_size() {
  local size_items=() obj
  for obj in "${optional[@]}"; do
    [ ! -f "$obj" ] || size_items+=("$obj")
  done
  for obj in "${required[@]}"; do
    size_items+=("$obj")
  done
  ESTIMATED=$(du -s -c -b -- "${size_items[@]}" | awk '$2 == "total" { print $1 }')
}

available_space_for_backup() {
  AVAILABLE=$(df --output=avail --block-size=1 "$(dirname "$ARCHIVE")" | grep '[[:digit:]]')
}

available_space_for_restore() {
  AVAILABLE=$(df --output=avail --block-size=1 "$birdnet_home" | grep '[[:digit:]]')
}

estimated_restore_size() {
  TMP=$(du -s -c -b "$ARCHIVE" | grep total | cut -f 1)
  # scale the size up a bit
  ESTIMATED=$(printf "%1.f" "$(bc <<< "$TMP * 1.005")")
}

restore_check() {
  if [ "$ARCHIVE" != '-' ]; then
    [ ! -f "$ARCHIVE" ] && echo "$ARCHIVE" not found && exit 1
    available_space_for_restore
    estimated_restore_size
    AVL_MB=$(printf "%1.f" "$(bc <<< "$AVAILABLE / $MEG")")
    EST_MB=$(printf "%1.f" "$(bc <<< "$ESTIMATED / $MEG")")
    log "Estimated space needed: ${EST_MB}M ($ESTIMATED), space available: ${AVL_MB}M ($AVAILABLE)"
    [ $ESTIMATED -gt $AVAILABLE ] && echo "Not enough space available on $birdnet_home"  && exit 1
    log "Checking backup file"
    arch_list=$(tar --list --exclude="*/*" -f "$ARCHIVE" | sed 's/\///')
    for obj in  "${required[@]}";do
      part2=$(basename "$obj")
      ! (echo $arch_list | grep -F -q "$part2") && echo Missing \'"$part2"\': corrupted backup file? && exit 1
    done
  fi
  return 0
}

late_restore_check() {
  if [ "$ARCHIVE" == '-' ]; then
    log "Checking backup file"
    for obj in  "${required[@]}";do
      part2=$(basename "$obj")
      ! [ -e "${UNPACK}/${part2}" ] && echo Missing \'"$part2"\': corrupted backup file? && exit 1
    done
  fi
  return 0
}

unpack() {
  log "Starting unpacking, this might take a while"
  rm -fr -- "$UNPACK"
  mkdir -- "$UNPACK"
  unpack_created=1
  tar --extract -p -f "$ARCHIVE" -C "${UNPACK}"
}

restore() {
  log "Starting restore"
  if ! sudo /usr/local/sbin/avian-educators restore-staged; then
    echo "Could not restore the paired detections and Educators data" >&2
    exit 1
  fi
  for obj in "${required[@]}"; do
    case "$(basename "$obj")" in birds.db|Charts|By_Date) continue ;; esac
    [ -d "$obj" ] && rm -rf "$obj"
    mv "${UNPACK}/$(basename "$obj")" "$(dirname "$obj")/"
  done
  log "Trying to restore optional files"
  for obj in  "${optional[@]}";do
    if [ -f "${UNPACK}/$(basename "$obj")" ] ; then
      mv "${UNPACK}/$(basename "$obj")" "$(dirname "$obj")/"
    else
      echo "No $(basename "$obj") found, moving on"
    fi
  done
  log "Fixing up configuration file"
  restored_birdnet_user=$(conf_value BIRDNET_USER)
  [[ "$restored_birdnet_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
    || { echo "Restored BirdNET-Pi user is invalid" >&2; exit 1; }
  sed -i "s/BIRDNET_USER=.*/BIRDNET_USER=$BIRDNET_USER/" "$birdnet_home/BirdNET-Pi/birdnet.conf"
  sed -i "s|/home/$restored_birdnet_user/|$birdnet_home/|g" "$birdnet_home/BirdNET-Pi/birdnet.conf"
  "$my_dir/install_language_label.sh"
  rm -fr -- "$UNPACK"
  unpack_created=0
  [ -n "${CADDY_PWD}" ] && sudo /usr/local/bin/update_caddyfile.sh > /dev/null 2>&1
  log "Restore done"
}

required=("$birdnet_home/BirdNET-Pi/birdnet.conf"
"$birdnet_home/BirdNET-Pi/scripts/birds.db"
"$birdnet_home/BirdNET-Pi/BirdDB.txt"
"$EXTRACTED/Charts"
"$EXTRACTED/By_Date")

# these may or may not exist
optional=("$birdnet_home/BirdNET-Pi/apprise.txt"
"$birdnet_home/BirdNET-Pi/body.txt"
"$birdnet_home/BirdNET-Pi/scripts/blacklisted_images.txt"
"$birdnet_home/BirdNET-Pi/scripts/disk_check_exclude.txt"
"$birdnet_home/BirdNET-Pi/exclude_species_list.txt"
"$birdnet_home/BirdNET-Pi/confirmed_species_list.txt"
"$birdnet_home/BirdNET-Pi/include_species_list.txt")

educator_pair=''
backup_required=()

prepare_backup_required() {
  local obj
  backup_required=()
  for obj in "${required[@]}"; do
    if [ "$(basename "$obj")" = birds.db ]; then
      backup_required+=("$educator_pair/birds.db")
    else
      backup_required+=("$obj")
    fi
  done
  if [ -f "$educator_pair/educators.db" ]; then
    backup_required+=("$educator_pair/educators.db")
  fi
}

cleanup_educator_pair() {
  local discard_output
  if [ -n "$educator_pair" ]; then
    if ! discard_output=$(sudo /usr/local/sbin/avian-educators \
      discard-snapshot "$educator_pair" 2>&1); then
      printf '%s\n' "$discard_output" >&2
      return 1
    fi
    educator_pair=''
  fi
}

services_stopped=0
unpack_created=0
cleanup() {
  local status=$?
  trap - EXIT INT TERM SIGABRT
  cleanup_educator_pair || true
  if [ "$unpack_created" = 1 ]; then
    rm -fr -- "$UNPACK"
  fi
  if [ "$services_stopped" = 1 ]; then
    if ! sudo /usr/local/sbin/avian-educators restart-services >/dev/null 2>&1; then
      echo "Services remain stopped until Educators maintenance recovery completes" >&2
    fi
  fi
  exit "$status"
}

[ $ACTION == "backup" ] && backup_check
[ $ACTION == "restore" ] && restore_check
if [ $ACTION == "size" ]; then
  estimated_backup_size
  echo $ESTIMATED
  exit
fi

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 134' SIGABRT

[ $ACTION == "restore" ] && unpack
[ $ACTION == "restore" ] && late_restore_check
log "Stopping services"
services_stopped=1
"$my_dir/stop_core_services.sh"

if [ "$ACTION" = backup ]; then
  if ! educator_pair=$(sudo /usr/local/sbin/avian-educators backup-snapshot); then
    echo "Could not snapshot the detections database for backup" >&2
    exit 1
  fi
  [[ "$educator_pair" =~ ^/var/lib/avian-visitors/educator-backups/\.pair\.[A-Za-z0-9]{6}$ ]] \
    || { echo "Educators backup snapshot path was invalid" >&2; exit 1; }
  prepare_backup_required
  backup || { echo "Backup failed" >&2; exit 1; }
  cleanup_educator_pair
fi
[ $ACTION == "restore" ] && restore

log "Restarting services"
sudo /usr/local/sbin/avian-educators restart-services >/dev/null
services_stopped=0
