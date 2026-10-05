#!/usr/bin/env bash
# This script removes all data that has been collected. It is tantamount to
# starting all data-collection from scratch. Only run this if you are sure
# you are okay will losing all the data that you've collected and processed
# so far.
set -euo pipefail
IFS=$'\n\t'

maintenance_phase=${AVIAN_EDUCATOR_MAINTENANCE_PHASE:-}
boot_recovery=${AVIAN_EDUCATOR_BOOT_RECOVERY:-0}
if [ -z "$maintenance_phase" ]; then
  exec sudo /usr/local/sbin/avian-educators clear-all
fi
case "$maintenance_phase" in core|finish) ;; *)
  echo "Invalid Educators maintenance phase" >&2
  exit 1
esac

maintenance_fd=${AVIAN_EDUCATOR_MAINTENANCE_FD:-}
maintenance_path=$(readlink -f -- /proc/self/fd/12 2>/dev/null || true)
case "$maintenance_path" in /var/lib/avian-visitors/.educators-maintenance.??????) ;; *)
  echo "Educators maintenance authority is missing or unsafe" >&2
  exit 1
  ;;
esac
case "$boot_recovery" in 0|1) ;; *)
  echo "Invalid Educators boot recovery mode" >&2
  exit 1
  ;;
esac
[ "$maintenance_fd" = 12 ] \
  && [ "$(stat -Lc '%u:%g:%a:%h' -- /proc/self/fd/12 2>/dev/null || true)" = \
    "0:$(getent group caddy | awk -F: 'NR == 1 { print $3 }'):400:1" ] \
  && [ "$(stat -c '%d:%i' -- "$maintenance_path" 2>/dev/null || true)" = \
    "$(stat -Lc '%d:%i' -- /proc/self/fd/12 2>/dev/null || true)" ] \
  && IFS= read -r maintenance_version <&12 \
  && [ "$maintenance_version" = v1 ] \
  || { echo "Educators maintenance authority is missing or unsafe" >&2; exit 1; }

BIRDNET_USER=${AVIAN_BIRDNET_USER:-}
BIRDNET_HOME=${AVIAN_BIRDNET_HOME:-}
RECS_DIR=${AVIAN_RECS_DIR:-}
EXTRACTED=${AVIAN_EXTRACTED:-}
PROCESSED=${AVIAN_PROCESSED:-}
IDFILE=${AVIAN_IDFILE:-}
[[ "$BIRDNET_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || { echo "Invalid BirdNET-Pi user" >&2; exit 1; }
[ "$(getent passwd "$BIRDNET_USER" | cut -d: -f6)" = "$BIRDNET_HOME" ] \
  || { echo "Invalid BirdNET-Pi home" >&2; exit 1; }
[[ "$BIRDNET_HOME" =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ "$BIRDNET_HOME" != *'..'* ]] \
  || { echo "Invalid BirdNET-Pi home" >&2; exit 1; }
for path in "$BIRDNET_HOME" "$RECS_DIR" "$EXTRACTED" "$PROCESSED" "$IDFILE"; do
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] && [ "$path" != / ] \
    && [[ "$path" != *'..'* ]] \
    || { echo "Unsafe maintenance path" >&2; exit 1; }
done
case "$RECS_DIR" in "$EXTRACTED"|"$EXTRACTED"/*) echo "Unsafe recordings path" >&2; exit 1 ;; esac
case "$PROCESSED" in "$RECS_DIR/"*) ;; *) echo "Unsafe processed path" >&2; exit 1 ;; esac
case "$IDFILE" in "$BIRDNET_HOME/"*) ;; *) echo "Unsafe identification path" >&2; exit 1 ;; esac
repo_dir=$BIRDNET_HOME/BirdNET-Pi
my_dir=$repo_dir/scripts
[ -d "$repo_dir/.git" ] && [ -d "$my_dir" ] \
  || { echo "BirdNET-Pi checkout was not found" >&2; exit 1; }
if [ "$maintenance_phase" = core ]; then
  echo "Stopping services"
  sudo systemctl stop birdnet_recording.service
  sudo systemctl stop birdnet_analysis.service
  echo "Removing all data . . . "
  # This phase deliberately runs as the BirdNET-Pi account. Storage paths may
  # be customized in birdnet.conf, so never elevate path-based deletion.
  clear_directory_contents() {
    local target=$1
    local -a entries=()
    [ -d "$target" ] && [ ! -L "$target" ] \
      && [ "$(readlink -f -- "$target")" = "$target" ] \
      || { echo "Unsafe maintenance directory" >&2; return 1; }
    shopt -s dotglob nullglob
    entries=("$target"/*)
    shopt -u dotglob nullglob
    [ "${#entries[@]}" -eq 0 ] || rm -rf -- "${entries[@]}"
  }
  clear_directory_contents "${RECS_DIR}"
  case "$EXTRACTED" in "$RECS_DIR"|"$RECS_DIR"/*) ;; *)
    clear_directory_contents "$EXTRACTED"
    ;;
  esac
  rm -f -- "${IDFILE}" "$repo_dir/BirdDB.txt"

  echo "Re-creating necessary directories"
  [ -d "${RECS_DIR}" ] || mkdir -p "${RECS_DIR}"
  [ -d "${EXTRACTED}" ] || mkdir -p "${EXTRACTED}"
  [ -d "${EXTRACTED}/By_Date" ] || mkdir -p "${EXTRACTED}/By_Date"
  [ -d "${EXTRACTED}/Charts" ] || mkdir -p "${EXTRACTED}/Charts"
  [ -d "${PROCESSED}" ] || mkdir -p "${PROCESSED}"

  sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/exclude_species_list.txt" "$my_dir"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/confirmed_species_list.txt" "$my_dir"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/include_species_list.txt" "$my_dir"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/whitelist_species_list.txt" "$my_dir"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/homepage/"* "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/model/labels.txt" "${my_dir}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir/play.php" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir/spectrogram.php" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir/overview.php" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir/stats.php" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir/todays_detections.php" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir/history.php" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$my_dir/weekly_report.php" "${EXTRACTED}"
webroot_helper=/usr/local/sbin/avian-link-webroot
if [ ! -x "$webroot_helper" ]; then
  echo "AvianVisitors webroot helper is not installed" >&2
  exit 1
fi
if ! "$webroot_helper" "$repo_dir" "${EXTRACTED}" "${BIRDNET_USER}"; then
  echo "Could not restore the AvianVisitors webroot" >&2
  exit 1
fi
sudo -u "${BIRDNET_USER}" ln -fs "${BIRDNET_HOME}/phpsysinfo" "${EXTRACTED}"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/templates/phpsysinfo.ini" "${BIRDNET_HOME}/phpsysinfo/"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/templates/green_bootstrap.css" "${BIRDNET_HOME}/phpsysinfo/templates/"
sudo -u "${BIRDNET_USER}" ln -fs "$repo_dir/templates/index_bootstrap.html" "${BIRDNET_HOME}/phpsysinfo/templates/html"
  chmod -R g+rw "${RECS_DIR}"
  case "$EXTRACTED" in "$RECS_DIR"|"$RECS_DIR"/*) ;; *) chmod -R g+rw "$EXTRACTED" ;; esac

  echo "Dropping and re-creating database"
  "$my_dir/createdb.sh"
  exit 0
fi

echo "Re-generating BirdDB.txt"
sudo -u "$BIRDNET_USER" touch "$repo_dir/BirdDB.txt"
echo "Date;Time;Sci_Name;Com_Name;Confidence;Lat;Lon;Cutoff;Week;Sens;Overlap" > "$repo_dir/BirdDB.txt"
ln -sfn "$repo_dir/BirdDB.txt" "$my_dir/BirdDB.txt"
chmod g+rw "$repo_dir/BirdDB.txt"
if [ "$boot_recovery" != 1 ] && ! sudo /usr/local/sbin/avian-caddy-refresh; then
  echo "Could not update the Caddy configuration; services were not restarted" >&2
  exit 1
fi
