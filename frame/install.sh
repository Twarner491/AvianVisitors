#!/bin/bash -p
# Install the AvianVisitors e-ink frame (display side) on a Raspberry Pi.
# Enables SPI + I2C, installs deps, makes a venv, installs the systemd timer.
#
# Four ways to feed the frame, pick one:
#   ./install.sh                            mirror the BirdNET-Pi on your network
#                                           (birdnet.local), rendered on this Pi
#   ./install.sh --image-url <URL>          fetch a ready-made frame PNG instead
#                                           (e.g. a public Cloudflare Worker)
#   ./install.sh --bird-weather --zip <ZIP> standalone from BirdWeather, no mic
#                                           (add --ebird-key <KEY> for remote ZIPs)
#   ./install.sh --station-id <ID>           follow one public BirdWeather station
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

install_fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

OWNER_TEMP=""
ENVIRONMENT_TEMP=""
EBIRD_KEY_FILE=""
cleanup_private_temps() {
  if [ -n "$OWNER_TEMP" ]; then
    /bin/rm -f -- "$OWNER_TEMP"
  fi
  if [ -n "$ENVIRONMENT_TEMP" ]; then
    /bin/rm -f -- "$ENVIRONMENT_TEMP"
  fi
  if [ -n "$EBIRD_KEY_FILE" ]; then
    /bin/rm -f -- "$EBIRD_KEY_FILE"
  fi
}

restart_without_ebird_key_in_argv() {
  exec /bin/bash -p "$FRAME/${0##*/}" \
    "${SANITIZED_ARGS[@]}" --internal-ebird-key-file "$EBIRD_KEY_FILE"
}

main() {
# Bash parses this complete function before executing it. Keeping every later
# privileged step in the parsed command tree prevents same-UID dependency code
# from rewriting unread installer bytes after pip or Playwright returns.
INSTALL_UID=$(/usr/bin/id -u)
if [ "$INSTALL_UID" = 0 ]; then
  install_fail "run install.sh as a regular user, without sudo"
fi
INSTALL_USER=$(/usr/bin/id -un) || install_fail "could not resolve the current user"
ACCOUNT=$(/usr/bin/getent passwd "$INSTALL_USER") \
  || install_fail "could not resolve the current user's home directory"
IFS=: read -r ACCOUNT_USER _ ACCOUNT_UID _ _ ACCOUNT_HOME _ <<< "$ACCOUNT"
if [ "$ACCOUNT_USER" != "$INSTALL_USER" ] || [ "$ACCOUNT_UID" != "$INSTALL_UID" ]; then
  install_fail "the current account identity is inconsistent"
fi
case "$ACCOUNT_HOME" in
  /*) ;;
  *) install_fail "the current user's home directory is unsafe" ;;
esac
INSTALL_HOME=$(CDPATH='' cd -P -- "$ACCOUNT_HOME" && pwd -P) \
  || install_fail "the current user's home directory is unavailable"
case "$INSTALL_USER" in
  ''|*[!A-Za-z0-9_.-]*)
    install_fail "the current user name contains unsupported characters"
    ;;
esac
case "$INSTALL_HOME" in
  *[!A-Za-z0-9_./-]*)
    install_fail "the current user's home path contains unsupported characters"
    ;;
esac
HOME=$INSTALL_HOME
USER=$INSTALL_USER
LOGNAME=$INSTALL_USER
export HOME USER LOGNAME

cd -P -- "$(/usr/bin/dirname -- "$0")"
FRAME=$(pwd -P)
case "$FRAME" in
  *[!A-Za-z0-9_./-]*)
    install_fail "the checkout path contains unsupported characters"
    ;;
esac

# No UID other than root or the invoking user may be able to replace a checkout
# path component while sudo is prompting. Root-owned sticky directories such as
# /tmp are safe because their sticky bit prevents cross-UID replacement.
CHECKOUT_COMPONENT=$FRAME
while :; do
  if [ ! -d "$CHECKOUT_COMPONENT" ] || [ -L "$CHECKOUT_COMPONENT" ]; then
    install_fail "the checkout path contains an unsafe directory"
  fi
  CHECKOUT_METADATA=$(/usr/bin/stat -c '%u:%a' -- "$CHECKOUT_COMPONENT") \
    || install_fail "could not inspect the checkout path"
  CHECKOUT_OWNER=${CHECKOUT_METADATA%%:*}
  CHECKOUT_MODE=${CHECKOUT_METADATA#*:}
  if [ "$CHECKOUT_OWNER" != 0 ] && [ "$CHECKOUT_OWNER" != "$INSTALL_UID" ]; then
    install_fail "the checkout path has unsafe ownership"
  fi
  CHECKOUT_PERMISSIONS=${CHECKOUT_MODE: -3}
  CHECKOUT_GROUP_MODE=${CHECKOUT_PERMISSIONS:1:1}
  CHECKOUT_OTHER_MODE=${CHECKOUT_PERMISSIONS:2:1}
  CHECKOUT_WRITABLE=0
  case "$CHECKOUT_GROUP_MODE" in
    2|3|6|7) CHECKOUT_WRITABLE=1 ;;
  esac
  case "$CHECKOUT_OTHER_MODE" in
    2|3|6|7) CHECKOUT_WRITABLE=1 ;;
  esac
  if [ "$CHECKOUT_WRITABLE" = 1 ]; then
    case "$CHECKOUT_OWNER:$CHECKOUT_MODE" in
      0:[1357][0-7][0-7][0-7]) ;;
      *) install_fail "the checkout path has unsafe permissions" ;;
    esac
  fi
  if [ "$CHECKOUT_COMPONENT" = / ]; then
    break
  fi
  CHECKOUT_COMPONENT=${CHECKOUT_COMPONENT%/*}
  if [ -z "$CHECKOUT_COMPONENT" ]; then
    CHECKOUT_COMPONENT=/
  fi
done
FRAME_OWNER=$(/usr/bin/stat -c '%u' -- "$FRAME") \
  || install_fail "could not inspect the checkout directory"
if [ "$FRAME_OWNER" != "$INSTALL_UID" ]; then
  install_fail "the checkout directory is not owned by $INSTALL_USER"
fi

preflight_directory() {
  local path=$1
  local metadata
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return
  fi
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    install_fail "$path exists but is not a managed directory"
  fi
  metadata=$(/usr/bin/stat -c '%u:%g:%a' -- "$path") \
    || install_fail "could not inspect $path"
  [ "$metadata" = 0:0:755 ] \
    || install_fail "$path has unsafe ownership or permissions"
}

preflight_managed_file() {
  local path=$1
  local expected_mode=$2
  local metadata
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    return
  fi
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    install_fail "$path exists but is not a managed file"
  fi
  metadata=$(/usr/bin/stat -c '%u:%g:%a' -- "$path") \
    || install_fail "could not inspect $path"
  [ "$metadata" = "0:0:$expected_mode" ] \
    || install_fail "$path has unsafe ownership or permissions"
}

preflight_managed_link() {
  local destination=$1
  local existing
  local allowed
  shift
  if [ ! -e "$destination" ] && [ ! -L "$destination" ]; then
    return
  fi
  if [ ! -L "$destination" ]; then
    install_fail "$destination exists and was not installed by BirdFrame"
  fi
  existing=$(/usr/bin/readlink -- "$destination") \
    || install_fail "could not inspect $destination"
  for allowed in "$@"; do
    if [ "$existing" = "$allowed" ]; then
      return
    fi
  done
  install_fail "$destination points somewhere not managed by BirdFrame"
}

MODE=local            # local | image | birdweather
BIRD_WEATHER=0
ZIP=""
STATION_ID=""
IMAGE_URL=""
EBIRD_KEY=""
EBIRD_KEY_FILE=""
EBIRD_KEY_SOURCE=none
SANITIZED_ARGS=()
PLAYWRIGHT_VERSION=1.62.0
while [ $# -gt 0 ]; do
  case "$1" in
    --bird-weather)
      BIRD_WEATHER=1
      MODE=birdweather
      SANITIZED_ARGS+=(--bird-weather)
      shift
      ;;
    --zip) [ $# -ge 2 ] || { echo "--zip needs a value, e.g. --zip 94107" >&2; exit 1; }
           ZIP="$2"; SANITIZED_ARGS+=(--zip "$2"); shift 2 ;;
    --zip=*) ZIP="${1#*=}"; SANITIZED_ARGS+=(--zip "$ZIP"); shift ;;
    --station-id) [ $# -ge 2 ] || { echo "--station-id needs a value, e.g. --station-id 12345" >&2; exit 1; }
                  MODE=birdweather; STATION_ID="$2"; SANITIZED_ARGS+=(--station-id "$2"); shift 2 ;;
    --station-id=*) MODE=birdweather; STATION_ID="${1#*=}"; SANITIZED_ARGS+=(--station-id "$STATION_ID"); shift ;;
    --image-url) [ $# -ge 2 ] || { echo "--image-url needs a URL, e.g. --image-url https://bird.example/frame.png" >&2; exit 1; }
                 MODE=image; IMAGE_URL="$2"; SANITIZED_ARGS+=(--image-url "$2"); shift 2 ;;
    --image-url=*) MODE=image; IMAGE_URL="${1#*=}"; SANITIZED_ARGS+=(--image-url "$IMAGE_URL"); shift ;;
    --ebird-key) [ $# -ge 2 ] || { echo "--ebird-key needs a value (a free key from ebird.org/api/keygen)" >&2; exit 1; }
                 [ "$EBIRD_KEY_SOURCE" = none ] || install_fail "--ebird-key may only be supplied once"
                 EBIRD_KEY="$2"; EBIRD_KEY_SOURCE=argument; shift 2 ;;
    --ebird-key=*) [ "$EBIRD_KEY_SOURCE" = none ] || install_fail "--ebird-key may only be supplied once"
                   EBIRD_KEY="${1#*=}"; EBIRD_KEY_SOURCE=argument; shift ;;
    --internal-ebird-key-file)
      [ $# -ge 2 ] || install_fail "invalid private eBird key handoff"
      [ "$EBIRD_KEY_SOURCE" = none ] || install_fail "--ebird-key may only be supplied once"
      EBIRD_KEY_FILE=$2
      EBIRD_KEY_SOURCE="file"
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ "$EBIRD_KEY_SOURCE" = file ]; then
  case "$EBIRD_KEY_FILE" in
    /tmp/avian-birdframe-ebird.*) ;;
    *) install_fail "invalid private eBird key handoff" ;;
  esac
  if [ ! -f "$EBIRD_KEY_FILE" ] || [ -L "$EBIRD_KEY_FILE" ]; then
    install_fail "invalid private eBird key handoff"
  fi
  EBIRD_KEY_FILE_METADATA=$(/usr/bin/stat -c '%u:%a' -- "$EBIRD_KEY_FILE") \
    || install_fail "invalid private eBird key handoff"
  if [ "$EBIRD_KEY_FILE_METADATA" != "$INSTALL_UID:600" ]; then
    install_fail "invalid private eBird key handoff"
  fi
  EBIRD_KEY=$(<"$EBIRD_KEY_FILE")
  /bin/rm -f -- "$EBIRD_KEY_FILE"
  EBIRD_KEY_FILE=""
fi

if [ -n "$IMAGE_URL" ] && { [ "$BIRD_WEATHER" = 1 ] || [ -n "$ZIP" ] || [ -n "$STATION_ID" ] || [ -n "$EBIRD_KEY" ]; }; then
  echo "--image-url cannot be combined with BirdWeather options" >&2
  exit 1
fi
if [ -n "$ZIP" ] && [ "$BIRD_WEATHER" != 1 ]; then
  echo "--zip only applies with --bird-weather" >&2
  exit 1
fi
if [ -n "$EBIRD_KEY" ] && [ "$MODE" != birdweather ]; then
  echo "--ebird-key only applies with --bird-weather" >&2
  exit 1
fi
if [ -n "$ZIP" ] && [ -n "$STATION_ID" ]; then
  echo "use either --zip or --station-id, not both" >&2
  exit 1
fi
if [ -n "$STATION_ID" ] && [ -n "$EBIRD_KEY" ]; then
  echo "--ebird-key only applies to BirdWeather ZIP mode" >&2
  exit 1
fi

# Validate inputs up front: a bad value would otherwise land in a config file or
# a systemd unit verbatim. These checks also reject a flag passed as a value
# (e.g. "--zip --image-url"), which would fail the format below.
if [ "$MODE" = birdweather ]; then
  if [ -z "$ZIP" ] && [ -z "$STATION_ID" ]; then
    echo "BirdWeather mode needs --zip <ZIP code> or --station-id <ID>" >&2
    exit 1
  fi
  if [ -n "$ZIP" ] && ! printf '%s' "$ZIP" | LC_ALL=C grep -qE '^[A-Za-z0-9][A-Za-z0-9 -]{0,8}[A-Za-z0-9]$'; then
    echo "--zip should look like a postal code, e.g. 94107 or SW1A 1AA" >&2
    exit 1
  fi
  if [ -n "$STATION_ID" ]; then
    if ! printf '%s' "$STATION_ID" | LC_ALL=C grep -qE '^[1-9][0-9]{0,9}$' \
        || [ "$STATION_ID" -gt 2147483647 ]; then
      echo "--station-id must be a number from 1 through 2147483647" >&2
      exit 1
    fi
  fi
  if [ "$EBIRD_KEY_SOURCE" != none ]; then
    case "$EBIRD_KEY" in
      ''|*[!A-Za-z0-9]*)
        install_fail "--ebird-key should be the alphanumeric token from ebird.org/api/keygen" ;;
    esac
    [ "${#EBIRD_KEY}" -le 4095 ] || install_fail "--ebird-key is too long"
  fi
fi
if [ "$MODE" = image ]; then
  if [ -z "$IMAGE_URL" ]; then
    echo "--image-url needs a URL, e.g. install.sh --image-url https://bird.example/frame.png" >&2
    exit 1
  fi
  case "$IMAGE_URL" in
    http://*|https://*) ;;
    *) echo "--image-url must start with http:// or https://" >&2; exit 1 ;;
  esac
  if printf '%s' "$IMAGE_URL" | LC_ALL=C grep -q '[^A-Za-z0-9._~:/?#@!$&()*+,;=%-]'; then
    echo "--image-url has characters that are not allowed in a URL" >&2
    exit 1
  fi
fi

if [ "$EBIRD_KEY_SOURCE" = argument ]; then
  EBIRD_KEY_FILE=$(/usr/bin/mktemp /tmp/avian-birdframe-ebird.XXXXXX) \
    || install_fail "could not create the private eBird key handoff"
  trap cleanup_private_temps EXIT
  printf '%s\n' "$EBIRD_KEY" > "$EBIRD_KEY_FILE"
  /bin/chmod 0600 "$EBIRD_KEY_FILE"
  restart_without_ebird_key_in_argv
fi

CONFIG="$HOME/.birdframe/config.toml"
CONFIG_EXISTS=0
verify_existing_config() {
  local command_prefix=("$@")
  local config_python=""
  local config_args=("$CONFIG" --mode "$MODE")
  CONFIG_EXISTS=0
  if [ ! -f "$CONFIG" ]; then
    return
  fi
  CONFIG_EXISTS=1
  if "${command_prefix[@]}" python3 -I -c 'import tomllib' >/dev/null 2>&1 \
      || "${command_prefix[@]}" python3 -I -c 'import tomli' >/dev/null 2>&1; then
    config_python=python3
  else
    echo "Cannot safely verify the existing frame config without Python tomllib or tomli." >&2
    echo "Install system Python 3.11 or the system python3-tomli package before running the installer again." >&2
    exit 1
  fi
  if [ -n "$STATION_ID" ]; then config_args+=(--station-id "$STATION_ID"); fi
  if [ -n "$ZIP" ]; then config_args+=(--zip "$ZIP"); fi
  if [ -n "$IMAGE_URL" ]; then config_args+=(--image-url "$IMAGE_URL"); fi
  if ! "${command_prefix[@]}" "$config_python" -I \
      "$FRAME/config_contract.py" "${config_args[@]}" >/dev/null 2>&1; then
    case "$MODE" in
      birdweather)
        if [ -n "$STATION_ID" ]; then
          echo "$CONFIG does not select BirdWeather station $STATION_ID." >&2
        else
          echo "$CONFIG does not select BirdWeather ZIP $ZIP." >&2
        fi
        ;;
      image) echo "$CONFIG does not select image URL $IMAGE_URL." >&2 ;;
      local) echo "$CONFIG does not select a supported local or preserved image source." >&2 ;;
    esac
    echo "Review the file, or remove it and re-run the installer to switch sources." >&2
    exit 1
  fi
}

# Validate an existing source before the first privileged change. Run the same
# semantic check under no-new-privileges after dependency setup to catch races.
verify_existing_config

if [ -n "$STATION_ID" ] && [ "$CONFIG_EXISTS" = 0 ]; then
  echo "Checking public BirdWeather station $STATION_ID..."
  if ! python3 -I "$FRAME/birdweather.py" \
      --station-id "$STATION_ID" --check-station >/dev/null; then
    echo "BirdWeather station $STATION_ID could not be verified. Check the public station-page URL and try again." >&2
    exit 1
  fi
fi

LAUNCHER_DIR=/usr/local/lib/avian-birdframe
INSTALLED_LAUNCHER=$LAUNCHER_DIR/avian-bundle
OWNER_FILE=$LAUNCHER_DIR/owner-uid
CONTROL_LINK=$LAUNCHER_DIR/control
ENVIRONMENT_DIR=/etc/avian-birdframe
ENVIRONMENT_FILE=$ENVIRONMENT_DIR/environment
BUNDLE_COMMAND=/usr/local/bin/avian-bundle
NAMES_COMMAND=/usr/local/bin/birdframe-names
SERVICE_UNIT=/etc/systemd/system/birdframe.service
TIMER_UNIT=/etc/systemd/system/birdframe.timer
LAUNCHER_SOURCE=$FRAME/avian-bundle-installed
CONTROL_SOURCE=$FRAME/vendor/avian-bundle-control

if [ ! -f "$LAUNCHER_SOURCE" ] || [ -L "$LAUNCHER_SOURCE" ]; then
  install_fail "$LAUNCHER_SOURCE is missing or unsafe"
fi
LAUNCHER_SOURCE_METADATA=$(/usr/bin/stat -c '%u:%a' -- "$LAUNCHER_SOURCE") \
  || install_fail "could not inspect $LAUNCHER_SOURCE"
LAUNCHER_SOURCE_OWNER=${LAUNCHER_SOURCE_METADATA%%:*}
LAUNCHER_SOURCE_MODE=${LAUNCHER_SOURCE_METADATA#*:}
if [ "$LAUNCHER_SOURCE_OWNER" != "$INSTALL_UID" ]; then
  install_fail "$LAUNCHER_SOURCE is not owned by $INSTALL_USER"
fi
case "$LAUNCHER_SOURCE_MODE" in
  [4567][0145][0145]) ;;
  *) install_fail "$LAUNCHER_SOURCE has unsafe permissions" ;;
esac
if [ ! -f "$CONTROL_SOURCE" ] || [ -L "$CONTROL_SOURCE" ] || [ ! -x "$CONTROL_SOURCE" ]; then
  install_fail "$CONTROL_SOURCE is missing or unsafe"
fi
CONTROL_METADATA=$(/usr/bin/stat -c '%u:%a' -- "$CONTROL_SOURCE") \
  || install_fail "could not inspect $CONTROL_SOURCE"
CONTROL_OWNER=${CONTROL_METADATA%%:*}
CONTROL_MODE=${CONTROL_METADATA#*:}
if [ "$CONTROL_OWNER" != "$INSTALL_UID" ]; then
  install_fail "$CONTROL_SOURCE is not owned by $INSTALL_USER"
fi
case "$CONTROL_MODE" in
  [57][0145][0145]) ;;
  *) install_fail "$CONTROL_SOURCE has unsafe executable permissions" ;;
esac
preflight_directory "$LAUNCHER_DIR"
preflight_managed_file "$INSTALLED_LAUNCHER" 755
preflight_managed_file "$OWNER_FILE" 644
preflight_directory "$ENVIRONMENT_DIR"
preflight_managed_file "$ENVIRONMENT_FILE" 600
preflight_managed_file "$SERVICE_UNIT" 644
preflight_managed_file "$TIMER_UNIT" 644
preflight_managed_link "$NAMES_COMMAND" "$FRAME/birdframe-names"
preflight_managed_link "$CONTROL_LINK" "$CONTROL_SOURCE"
preflight_managed_link \
  "$BUNDLE_COMMAND" \
  ../lib/avian-birdframe/avian-bundle \
  /usr/local/lib/avian-birdframe/avian-bundle \
  "$FRAME/avian-bundle"

PRIVATE_EBIRD_DIR=$HOME/.birdframe
PRIVATE_EBIRD_FILE=$PRIVATE_EBIRD_DIR/ebird-api-key
PRIVATE_EBIRD_KEY=""
preflight_private_credential_directory() {
  if [ ! -e "$PRIVATE_EBIRD_DIR" ] && [ ! -L "$PRIVATE_EBIRD_DIR" ]; then
    return
  fi
  if [ ! -d "$PRIVATE_EBIRD_DIR" ] || [ -L "$PRIVATE_EBIRD_DIR" ]; then
    install_fail "the private eBird credential directory is unsafe"
  fi
  PRIVATE_DIR_METADATA=$(/usr/bin/stat -c '%u:%a' -- "$PRIVATE_EBIRD_DIR")
  case "$PRIVATE_DIR_METADATA" in
    "$INSTALL_UID":[1357][0145][0145]) ;;
    *) install_fail "the private eBird credential directory is unsafe" ;;
  esac
}

read_credential_text() {
  local raw=""
  # read -d rejects embedded NUL rather than silently removing it, and preserves
  # newlines so only one final LF is accepted by the literal token check.
  if IFS= read -r -d '' raw < "$1"; then
    install_fail "the stored eBird credential is invalid"
  fi
  CREDENTIAL_TEXT=${raw%$'\n'}
}

if [ -e "$PRIVATE_EBIRD_FILE" ] || [ -L "$PRIVATE_EBIRD_FILE" ]; then
  preflight_private_credential_directory
  if [ ! -f "$PRIVATE_EBIRD_FILE" ] || [ -L "$PRIVATE_EBIRD_FILE" ]; then
    install_fail "the private eBird credential is unsafe"
  fi
  [ "$(/usr/bin/stat -c '%u:%a:%h' -- "$PRIVATE_EBIRD_FILE")" = "$INSTALL_UID:600:1" ] \
    || install_fail "the private eBird credential is unsafe"
  PRIVATE_KEY_SIZE=$(/usr/bin/stat -c '%s' -- "$PRIVATE_EBIRD_FILE")
  if [ "$PRIVATE_KEY_SIZE" -le 0 ] || [ "$PRIVATE_KEY_SIZE" -gt 4096 ]; then
    install_fail "the private eBird credential is invalid"
  fi
  read_credential_text "$PRIVATE_EBIRD_FILE"
  PRIVATE_EBIRD_KEY=$CREDENTIAL_TEXT
  case "$PRIVATE_EBIRD_KEY" in
    ''|*[!A-Za-z0-9]*) install_fail "the private eBird credential is invalid" ;;
  esac
  [ "${#PRIVATE_EBIRD_KEY}" -le 4095 ] || install_fail "the private eBird credential is invalid"
fi

if [ "$EBIRD_KEY_SOURCE" = none ]; then
  if [ -f "$ENVIRONMENT_FILE" ]; then
    ENVIRONMENT_TEMP=$(/usr/bin/mktemp /tmp/avian-birdframe-environment.XXXXXX)
    trap cleanup_private_temps EXIT
    { /usr/bin/sudo /usr/bin/head -c 4111 -- "$ENVIRONMENT_FILE"; } > "$ENVIRONMENT_TEMP"
    read_credential_text "$ENVIRONMENT_TEMP"
    case "$CREDENTIAL_TEXT" in
      '')
        [ ! -s "$ENVIRONMENT_TEMP" ] || install_fail "the stored service eBird credential is invalid"
        [ -z "$PRIVATE_EBIRD_KEY" ] || install_fail "the stored eBird credentials disagree" ;;
      EBIRD_API_KEY=*)
        EBIRD_KEY=${CREDENTIAL_TEXT#EBIRD_API_KEY=}
        [ -n "$EBIRD_KEY" ] || install_fail "the stored service eBird credential is invalid" ;;
      *) install_fail "the stored service eBird credential is invalid" ;;
    esac
    /bin/rm -f -- "$ENVIRONMENT_TEMP"
    ENVIRONMENT_TEMP=""
    trap - EXIT
  elif [ -f "$SERVICE_UNIT" ]; then
    # Migrate only the exact line emitted by the old installer, never evaluate it.
    LEGACY_EBIRD_LINE=$(/usr/bin/grep '^Environment=EBIRD_API_KEY=' "$SERVICE_UNIT" || true)
    if [ -n "$LEGACY_EBIRD_LINE" ]; then
      EBIRD_KEY=${LEGACY_EBIRD_LINE#Environment=EBIRD_API_KEY=}
    else
      EBIRD_KEY=$PRIVATE_EBIRD_KEY
    fi
  else
    EBIRD_KEY=$PRIVATE_EBIRD_KEY
  fi
  case "$EBIRD_KEY" in
    *[!A-Za-z0-9]*) install_fail "the stored service eBird credential is invalid" ;;
  esac
  [ "${#EBIRD_KEY}" -le 4095 ] || install_fail "the stored service eBird credential is invalid"
fi
if [ -n "$EBIRD_KEY" ]; then
  preflight_private_credential_directory
fi

# Capture the trusted launcher in its root-owned location before any Python
# package tooling can modify the user-writable checkout.
/usr/bin/sudo /usr/bin/install -d -o root -g root -m 0755 "$LAUNCHER_DIR"
/usr/bin/sudo /usr/bin/install -T -o root -g root -m 0755 \
  "$LAUNCHER_SOURCE" "$INSTALLED_LAUNCHER"
OWNER_TEMP=$(/usr/bin/mktemp /tmp/avian-birdframe-owner.XXXXXX) \
  || install_fail "could not create the owner metadata"
trap cleanup_private_temps EXIT
printf '%s\n' "$INSTALL_UID" > "$OWNER_TEMP"
/usr/bin/sudo /usr/bin/install -T -o root -g root -m 0644 \
  "$OWNER_TEMP" "$OWNER_FILE"
/bin/rm -f -- "$OWNER_TEMP"
OWNER_TEMP=
trap - EXIT

# Store the optional eBird credential outside the world-readable unit. The
# value is never placed in sudo's argv, and the user-owned staging file exists
# only before third-party package code is run.
ENVIRONMENT_TEMP=$(/usr/bin/mktemp /tmp/avian-birdframe-environment.XXXXXX) \
  || install_fail "could not create the service environment"
trap cleanup_private_temps EXIT
if [ -n "$EBIRD_KEY" ]; then
  printf 'EBIRD_API_KEY=%s\n' "$EBIRD_KEY" > "$ENVIRONMENT_TEMP"
else
  : > "$ENVIRONMENT_TEMP"
fi
/bin/chmod 0600 "$ENVIRONMENT_TEMP"
/usr/bin/sudo /usr/bin/install -d -o root -g root -m 0755 "$ENVIRONMENT_DIR"
/usr/bin/sudo /usr/bin/install -T -o root -g root -m 0600 \
  "$ENVIRONMENT_TEMP" "$ENVIRONMENT_FILE"
/bin/rm -f -- "$ENVIRONMENT_TEMP"
ENVIRONMENT_TEMP=
trap - EXIT

if [ -n "$EBIRD_KEY" ]; then
  if [ ! -d "$PRIVATE_EBIRD_DIR" ]; then
    /bin/mkdir -m 0700 -- "$PRIVATE_EBIRD_DIR"
  fi
  EBIRD_KEY_FILE=$(/usr/bin/mktemp "$PRIVATE_EBIRD_DIR/.ebird-api-key.XXXXXX")
  trap cleanup_private_temps EXIT
  printf '%s\n' "$EBIRD_KEY" > "$EBIRD_KEY_FILE"
  /bin/chmod 0600 "$EBIRD_KEY_FILE"
  /bin/mv -fT -- "$EBIRD_KEY_FILE" "$PRIVATE_EBIRD_FILE"
  EBIRD_KEY_FILE=""
  trap - EXIT
fi

/usr/bin/sudo /usr/bin/ln -sfnT "$FRAME/birdframe-names" "$NAMES_COMMAND"
/usr/bin/sudo /usr/bin/ln -sfnT "$CONTROL_SOURCE" "$CONTROL_LINK"
/usr/bin/sudo /usr/bin/ln -sfnT \
  ../lib/avian-birdframe/avian-bundle "$BUNDLE_COMMAND"

# Render fixed unit definitions entirely inside a root-owned shell, before any
# user-writable Python package code runs. The units remain inert until the final
# systemctl step succeeds.
/usr/bin/sudo /bin/sh -c '
  set -eu
  unit_user=$1
  frame=$2
  home=$3
  service_temp=$(/usr/bin/mktemp /etc/systemd/system/.birdframe.service.XXXXXX)
  timer_temp=$(/usr/bin/mktemp /etc/systemd/system/.birdframe.timer.XXXXXX) || {
    /bin/rm -f -- "$service_temp"
    exit 1
  }
  cleanup() {
    /bin/rm -f -- "$service_temp" "$timer_temp"
  }
  trap cleanup EXIT
  {
    printf "%s\n" "[Unit]"
    printf "%s\n" "Description=AvianVisitors e-ink frame update"
    printf "%s\n" "Documentation=https://github.com/Twarner491/AvianVisitors"
    printf "%s\n" "Wants=network-online.target"
    printf "%s\n\n" "After=network-online.target"
    printf "%s\n" "[Service]"
    printf "%s\n" "Type=oneshot"
    printf "User=%s\n" "$unit_user"
    printf "WorkingDirectory=%s\n" "$frame"
    printf "ExecStart=%s/.venv/bin/python %s/display.py --config %s/.birdframe/config.toml\n" \
      "$frame" "$frame" "$home"
    printf "%s\n" "Environment=PYTHONUNBUFFERED=1"
    printf "%s\n" "EnvironmentFile=-/etc/avian-birdframe/environment"
    printf "%s\n" "NoNewPrivileges=true"
    printf "%s\n" "Nice=10"
    printf "%s\n" "TimeoutStartSec=300"
  } > "$service_temp"
  {
    printf "%s\n" "[Unit]"
    printf "%s\n\n" "Description=Update the e-ink bird frame on a schedule"
    printf "%s\n" "[Timer]"
    printf "%s\n" "OnActiveSec=2min"
    printf "%s\n" "OnBootSec=2min"
    printf "%s\n" "OnUnitActiveSec=15min"
    printf "%s\n\n" "Persistent=true"
    printf "%s\n" "[Install]"
    printf "%s\n" "WantedBy=timers.target"
  } > "$timer_temp"
  /usr/bin/install -T -o root -g root -m 0644 "$service_temp" \
    /etc/systemd/system/birdframe.service
  /usr/bin/install -T -o root -g root -m 0644 "$timer_temp" \
    /etc/systemd/system/birdframe.timer
' birdframe-units "$USER" "$FRAME" "$HOME"

# local + birdweather render on the Pi (need a browser); image only fetches.
NEEDS_BROWSER=1
if [ "$MODE" = image ]; then NEEDS_BROWSER=0; fi

CONFIG_TXT=/boot/firmware/config.txt
[ -f "$CONFIG_TXT" ] || CONFIG_TXT=/boot/config.txt

echo "1/5  Enabling SPI + I2C (Inky needs both; SPI with no chip-select)..."
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_i2c 0
grep -q "^dtoverlay=spi0-0cs" "$CONFIG_TXT" || echo "dtoverlay=spi0-0cs" | sudo tee -a "$CONFIG_TXT" >/dev/null

echo "2/5  Installing system packages (build tools to compile spidev, libatlas3-base for numpy)..."
SYSTEM_PACKAGES=(
  python3-venv
  python3-dev
  build-essential
  libatlas3-base
  util-linux
)
if [ "$NEEDS_BROWSER" = 1 ]; then
  # Keep the privileged side of Playwright setup inside apt. Never execute the
  # user-writable venv's install-deps helper through sudo.
  SYSTEM_PACKAGES+=(
    xvfb
    fonts-noto-color-emoji
    fonts-unifont
    libfontconfig1
    libfreetype6
    xfonts-scalable
    fonts-liberation
    fonts-ipafont-gothic
    fonts-wqy-zenhei
    fonts-tlwg-loma-otf
    fonts-freefont-ttf
    libasound2
    libatk-bridge2.0-0
    libatk1.0-0
    libatspi2.0-0
    libcairo2
    libcups2
    libdbus-1-3
    libdrm2
    libgbm1
    libglib2.0-0
    libnspr4
    libnss3
    libpango-1.0-0
    libx11-6
    libxcb1
    libxcomposite1
    libxdamage1
    libxext6
    libxfixes3
    libxkbcommon0
    libxrandr2
  )
fi
sudo /usr/bin/apt-get update -qq
sudo /usr/bin/apt-get install -y --no-install-recommends "${SYSTEM_PACKAGES[@]}"

echo "3/5  Creating venv and installing Python deps..."
[ -x /usr/bin/setpriv ] || install_fail "util-linux did not install setpriv"
/usr/bin/setpriv --no-new-privs -- python3 -m venv .venv
/usr/bin/setpriv --no-new-privs -- .venv/bin/pip install -q --upgrade pip
/usr/bin/setpriv --no-new-privs -- .venv/bin/pip install -q -r requirements-frame.txt
if [ "$MODE" = birdweather ]; then
  /usr/bin/setpriv --no-new-privs -- \
    .venv/bin/pip install -q -r requirements-bundle-species.txt
fi
if [ "$NEEDS_BROWSER" = 1 ]; then
  echo "     Installing Playwright + Chromium so the Pi can render the collage (a few minutes)..."
  /usr/bin/setpriv --no-new-privs -- \
    .venv/bin/pip install -q "playwright==$PLAYWRIGHT_VERSION"
  /usr/bin/setpriv --no-new-privs -- .venv/bin/playwright install chromium
  echo "     Verifying that Chromium launches with the installed native libraries..."
  /usr/bin/setpriv --no-new-privs -- .venv/bin/python - <<'PY'
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    browser.close()
PY
fi

echo "4/5  Writing config..."
mkdir -p "$HOME/.birdframe"
verify_existing_config /usr/bin/setpriv --no-new-privs --
if [ "$CONFIG_EXISTS" = 1 ]; then
  echo "     $CONFIG already exists, leaving it untouched."
elif [ "$MODE" = local ]; then
  cat > "$CONFIG" <<'CFG'
# birdframe-mode: local
# AvianVisitors frame, local mode: mirrors the BirdNET-Pi on your network.
# This Pi screenshots birdnet.local itself, so there is nothing else to set up.
base_url = "http://birdnet.local"
shoot = true
shoot_title = "Avian Visitors"
shoot_subtitle = "Heard Today"
bird_names = false
rotate = 90          # flip to 270 if the frame hangs the other way up
saturation = 0.6
timeout = 180        # a Zero 2 W needs ~70-120s to shoot the collage
# If your BirdNET-Pi is behind basic-auth, uncomment and set these:
# basic_user = "..."
# basic_pass = "..."
CFG
elif [ "$MODE" = image ]; then
  BASE="$(printf '%s' "$IMAGE_URL" | sed -E 's#^(https?://[^/]+).*#\1#')"
  # printf, not a heredoc: the URL is written literally, never shell-expanded.
  {
    printf '%s\n' '# birdframe-mode: image'
    printf '%s\n' '# AvianVisitors frame, image mode: fetches a ready-made frame PNG.'
    printf 'base_url = "%s"\n' "$BASE"
    printf 'image_url = "%s"\n' "$IMAGE_URL"
    printf '%s\n' 'shoot = false'
    printf '%s\n' 'rotate = 90          # flip to 270 if the frame hangs the other way up'
    printf '%s\n' 'saturation = 0.6'
  } > "$CONFIG"
else
  # BirdWeather renders on this Pi and redraws only when that source changes.
  {
    printf '%s\n' '# birdframe-mode: birdweather'
    printf '%s\n' 'species_source = "birdweather"'
    if [ -n "$STATION_ID" ]; then
      printf '%s\n' '# AvianVisitors frame, BirdWeather mode: follows one public station.'
      printf 'bw_station_id = "%s"\n' "$STATION_ID"
    else
      printf '%s\n' '# AvianVisitors frame, BirdWeather mode: renders the top birds near a ZIP.'
      printf 'zip = "%s"\n' "$ZIP"
      printf '%s\n' 'bw_country = "us"    # geocoder country for the ZIP'
    fi
    printf '%s\n' 'bw_days = 7          # BirdWeather lookback window, in days'
    printf '%s\n' 'shoot = true         # this Pi renders the collage'
    printf '%s\n' 'shoot_title = "Avian Visitors"'
    printf '%s\n' 'shoot_subtitle = "Heard Today"'
    printf '%s\n' 'bird_names = false'
    printf '%s\n' 'rotate = 90          # flip to 270 if the frame hangs the other way up'
    printf '%s\n' 'saturation = 0.6'
  } > "$CONFIG"
fi

echo "5/5  Enabling systemd service + timer..."
/usr/bin/sudo systemctl daemon-reload
/usr/bin/sudo systemctl enable --now birdframe.timer  # --now starts it immediately, not only on the next boot

if [ "$CONFIG_EXISTS" = 1 ]; then
  cat <<DONE

Installed. The existing frame source and settings in
  $CONFIG
were left unchanged. The frame refreshes every 15 minutes.
DONE
else
case "$MODE" in
  local)
    cat <<DONE

Installed. The frame mirrors birdnet.local on your network and refreshes every
15 min, only when the birds change. Until the mic has heard its first bird it
shows a plain title card. If the panel hangs upside down, set rotate = 270 in
~/.birdframe/config.toml.
DONE
    ;;
  image)
    cat <<DONE

Installed. The frame fetches its image from
  $IMAGE_URL
and refreshes every 15 min, only when the birds change.
DONE
    ;;
  birdweather)
    if [ -n "$STATION_ID" ]; then
      SOURCE_LABEL="BirdWeather station $STATION_ID"
      MISSING_ARGS=(--station-id "$STATION_ID" --missing)
      GENERATE_ARG="--station-id $STATION_ID"
      cat <<DONE

Installed for BirdWeather station $STATION_ID. The frame renders that station's
birds and refreshes every 15 min, only when its top birds change.
DONE
    else
      SOURCE_LABEL="the area near $ZIP"
      MISSING_ARGS=("$ZIP" --missing)
      GENERATE_ARG="--zip $ZIP"
      cat <<DONE

Installed in BirdWeather ZIP mode for $ZIP. The frame renders the top birds near
you and refreshes every 15 min, only when the local top birds change.
DONE
    fi
    # Surface drawable-species gaps and point at the matching generator mode.
    MISSING="$(/usr/bin/setpriv --no-new-privs -- \
      "$FRAME/.venv/bin/python" "$FRAME/birdweather.py" "${MISSING_ARGS[@]}" \
      2>/dev/null || true)"
    if [ -n "$MISSING" ]; then
      N="$(printf '%s\n' "$MISSING" | grep -c . || true)"
      NAMES="$(printf '%s\n' "$MISSING" | head -8 | sed 's/.*|/    /')"
      if [ "$N" -gt 8 ]; then NAMES="$NAMES
    ... and $((N - 8)) more"; fi
      cat <<FLAG
Heads up: $N bird(s) from $SOURCE_LABEL aren't in the illustration set you cloned, so
the frame will skip them:
$NAMES
To add them, run this on a laptop or workstation (it needs rembg, which the Pi
can't fit) and commit or copy the new cutouts over:
  python3 $FRAME/generate_illustrations.py $GENERATE_ARG --gemini-key <KEY>
A paid Google Gemini API key is needed: https://ai.google.dev
FLAG
    fi
    ;;
esac
fi

# SPI only takes effect on a reboot, so do it for the user. Skip if SPI is
# already up (e.g. a re-run) so we don't bounce a working frame.
if [ -e /dev/spidev0.0 ]; then
  echo "SPI already active, no reboot needed."
else
  echo "Rebooting to bring SPI up (back on its own in ~1 min)..."
  sleep 4
  sudo reboot
fi
cleanup_private_temps
}

{ main "$@"; exit; }
