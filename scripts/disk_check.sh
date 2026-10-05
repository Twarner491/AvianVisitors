#!/usr/bin/env bash
source /etc/birdnet/birdnet.conf
if [ "${BIRDNET_DISK_DEBUG:-0}" = 1 ]; then
  set -x
fi
used="$(df -h ${EXTRACTED} | tail -n1 | awk '{print $5}')"
purge_threshold="${PURGE_THRESHOLD:-95}"

if [ "${used//%}" -ge "$purge_threshold" ]; then

  case $FULL_DISK in
    purge) echo "Removing oldest data"
        refresh_marker=$(mktemp "${TMPDIR:-/tmp}/avian-disk-refresh.XXXXXX") || exit 1
        refresh_token=${refresh_marker##*/}
        cleanup_refresh_marker() {
            rm -f -- "$refresh_marker"
        }
        trap cleanup_refresh_marker EXIT HUP INT TERM
        if ! (cd "$EXTRACTED" && \
            AVIAN_DISK_REFRESH_MARKER="$refresh_marker" \
            AVIAN_DISK_REFRESH_TOKEN="$refresh_token" \
            /usr/bin/php -r '
                require_once "scripts/common.php";
                set_timezone();
                require "stats.php";
                $payload = getenv("AVIAN_DISK_REFRESH_TOKEN") . "\n";
                $written = @file_put_contents(
                    getenv("AVIAN_DISK_REFRESH_MARKER"),
                    $payload,
                    LOCK_EX
                );
                if ($written !== strlen($payload)) {
                    exit(1);
                }
            ' >/dev/null); then
            echo "Could not refresh the protected recording list" >&2
            exit 1
        fi
        if ! grep -qxF "$refresh_token" "$refresh_marker"; then
            echo "Protected recording refresh did not complete" >&2
            exit 1
        fi
        cleanup_refresh_marker
        trap - EXIT HUP INT TERM
        cd "${EXTRACTED}/By_Date/" || exit 1
        exclude_file="$HOME/BirdNET-Pi/scripts/disk_check_exclude.txt"
        if [ ! -f "$exclude_file" ] || [ -L "$exclude_file" ] || \
            ! grep -qxFe \#\#start "$exclude_file" || \
            ! grep -qxFe \#\#end "$exclude_file"; then
            echo "Protected recording list is invalid" >&2
            exit 1
        fi
        filestodelete=$(($(find ${EXTRACTED}/By_Date/* -type f | wc -l) / $(find ${EXTRACTED}/By_Date/* -maxdepth 0 -type d | wc -l)))
        iter=0
        for i in */*/*; do
            if [ $iter -ge $filestodelete ]; then
                break
            fi
            if ! grep -qxFe "$i" "$HOME/BirdNET-Pi/scripts/disk_check_exclude.txt"; then
                rm "$i"
            fi
            ((iter++))
        done
        find ~/BirdSongs/ -type d -empty -mtime +90 -delete
        find ${EXTRACTED}/By_Date/ -empty -type d -delete;;

       #rm -drfv "$(find ${EXTRACTED}/By_Date/* -maxdepth 1 -type d -prune \
        # | sort -r | tail -n1)";;
    keep) echo "Stopping Core Services"
       /usr/local/bin/stop_core_services.sh;;
  esac
fi
sleep 1
if [ "${used//%}" -ge "$purge_threshold" ]; then
  case $FULL_DISK in
    purge) echo "Removing more data"
       case "${PROCESSED:-}" in ''|/) exit 1 ;; esac
       rm -rfv -- "${PROCESSED:?}/"*;;
    keep) echo "Stopping Core Services"
       /usr/local/bin/stop_core_services.sh;;
  esac
fi
