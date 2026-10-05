#!/usr/bin/env bash
# A comprehensive log dumper
# set -x # Uncomment to debug
set -o pipefail
umask 077
repo_dir=${HOME}/BirdNET-Pi
config_file=${repo_dir}/birdnet.conf
my_dir=${repo_dir}/scripts
redactor=${my_dir}/redact_diagnostics.py
systemd_wants_dir=${AVIAN_DIAGNOSTIC_SYSTEMD_WANTS_DIR:-/etc/systemd/system/multi-user.target.wants}

# A caller's environment can contain the same credentials as birdnet.conf.
# Remove every known credential before any diagnostic child process starts.
unset BIRDWEATHER_ID CADDY_PWD ICE_PWD GEMINI_API_KEY GEMINI_KEY \
  EBIRD_API_KEY EBIRD_KEY FLICKR_API_KEY HEARTBEAT_URL RTSP_STREAM DB_PWD \
  WMI_PASSWORD AVIAN_DISK_REFRESH_TOKEN HTTP_AUTHORIZATION \
  REDIRECT_HTTP_AUTHORIZATION AUTHORIZATION

[ -r "$config_file" ] || { echo "BirdNET-Pi config is unavailable" >&2; exit 1; }
[ -r "$redactor" ] || { echo "Diagnostic redactor is unavailable" >&2; exit 1; }
if ! RECS_DIR=$(python3 "$redactor" --mode path --config "$config_file" \
  --key RECS_DIR --home "$HOME"); then
  echo "BirdNET-Pi recordings path is invalid" >&2
  exit 1
fi
[ -d "$RECS_DIR" ] && [ -r "$RECS_DIR" ] && [ -x "$RECS_DIR" ] \
  || { echo "BirdNET-Pi recordings path is unavailable" >&2; exit 1; }
if ! [[ "$systemd_wants_dir" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || [[ "/$systemd_wants_dir/" == *"/../"* ]]; then
  echo "System service directory is invalid" >&2
  exit 1
fi
if { [ -e "$systemd_wants_dir" ] || [ -L "$systemd_wants_dir" ]; } \
  && { [ ! -d "$systemd_wants_dir" ] || [ -L "$systemd_wants_dir" ]; }; then
  echo "System service directory is invalid" >&2
  exit 1
fi

# A fresh private directory prevents an interrupted older run, removed service,
# or pre-redaction install log from being silently included in this archive.
LOG_DIR=$(mktemp -d "${repo_dir}/.avian-logs.XXXXXX") \
  || { echo "Could not create a private diagnostic directory" >&2; exit 1; }
archive_temp=''
cleanup() {
  if [ -n "${archive_temp:-}" ]; then rm -f -- "$archive_temp"; fi
  case "${LOG_DIR:-}" in
    "${repo_dir}"/.avian-logs.*)
      if [ -d "$LOG_DIR" ] && [ ! -L "$LOG_DIR" ]; then
        find "$LOG_DIR" -xdev -mindepth 1 -delete
        rmdir "$LOG_DIR" 2>/dev/null || true
      fi
      ;;
  esac
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

# Create service logs. Read one unit per line; the previous scalar expansion
# collapsed the complete list into a single invalid unit name.
while IFS= read -r i; do
  [[ "$i" =~ ^[A-Za-z0-9_.@-]+$ ]] || continue
  unit_path=${systemd_wants_dir}/${i}
  if [ -L "$unit_path" ];then
    if ! journalctl -u "$i" -n 100 --no-pager \
      | python3 "$redactor" --mode journal --config "$config_file" > "${LOG_DIR}/${i}.log"; then
      rm -f -- "${LOG_DIR}/${i}.log"
      echo "Could not safely redact ${i} logs" >&2
      exit 1
    fi
    if ! python3 "$redactor" --mode journal --config "$config_file" \
      < "$unit_path" > "${LOG_DIR}/${i}"; then
      rm -f -- "${LOG_DIR}/${i}"
      echo "Could not safely redact ${i} service definition" >&2
      exit 1
    fi
  fi
done < <(awk '/service/ && /systemctl/ && !/php/ {print $3}' "${my_dir}/install_services.sh" | sort)

# Copy the config only through the same credential redactor used for journals.
if ! python3 "$redactor" --mode config < "$config_file" > "${LOG_DIR}/birdnet.conf"; then
  rm -f -- "${LOG_DIR}/birdnet.conf"
  echo "Could not safely redact BirdNET-Pi config" >&2
  exit 1
fi

# Create password-removed Caddyfile
if [ -f /etc/caddy/Caddyfile ];then
  if ! sed -e '/basicauth/,+2d' /etc/caddy/Caddyfile \
    | python3 "$redactor" --mode journal --config "$config_file" > "${LOG_DIR}/Caddyfile"; then
    rm -f -- "${LOG_DIR}/Caddyfile"
    echo "Could not safely redact Caddy configuration" >&2
    exit 1
  fi
fi  

# Get sound card specs
SOUND_CARD="$(aplay -L \
  | awk -F, '/^hw:/ {print $1}' \
  | grep -ve 'vc4' -e 'Head' -e 'PCH' \
  | uniq)"
printf 'SOUND_CARD=%s\n' "$SOUND_CARD" > "${LOG_DIR}/soundcard"
script -c "arecord -D ${SOUND_CARD} --dump-hw-params" -a "${LOG_DIR}/soundcard" &> /dev/null

# Get system info. Keep commands and arguments separate so a configured path
# is never reparsed as shell syntax.
append_separator() {
  printf '\n
===============================================================================
===============================================================================

' >> "${LOG_DIR}/sysinfo"
}
df -h >> "${LOG_DIR}/sysinfo"; append_separator
free -h >> "${LOG_DIR}/sysinfo"; append_separator
ifconfig >> "${LOG_DIR}/sysinfo"; append_separator
find "$RECS_DIR" >> "${LOG_DIR}/sysinfo"; append_separator

# Build beside the destination and rename only after the complete archive is
# closed. The old $repo_dir/logs directory is intentionally never traversed.
archive_temp=$(mktemp "${repo_dir}/.logs.tar.gz.XXXXXX") \
  || { echo "Could not create a private diagnostic archive" >&2; exit 1; }
if ! tar -C "$LOG_DIR" -czf "$archive_temp" .; then
  echo "Could not create diagnostic archive" >&2
  exit 1
fi
chmod 0600 "$archive_temp"
mv -f -- "$archive_temp" "${repo_dir}/logs.tar.gz"
archive_temp=''
# Finished
echo "Your compressed logs are located at ${repo_dir}/logs.tar.gz"
