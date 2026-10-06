#!/usr/bin/env bash
# One-time bridge from the pre-v1 BirdNET-Pi checkout to AvianVisitors v1.
# It installs only the verified updater and service refresher, then hands the
# checkout to the normal migration path.

set -Eeuo pipefail
IFS=$'\n\t'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

readonly OFFICIAL_ORIGIN='https://github.com/Twarner491/AvianVisitors'
readonly RELEASE_BRANCH='avian-visitors'
readonly CONFIG_FILE='/etc/birdnet/birdnet.conf'
readonly UPDATE_HELPER='/usr/local/sbin/avian-update-control'
readonly REFRESH_HELPER='/usr/local/sbin/avian-service-refresh'
readonly PREPARED_DIR='/var/lib/avian-update-prepared'

die() {
  printf 'v1 update setup stopped: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 0 ] || die 'this setup does not accept arguments'
[ "${EUID:-$(id -u)}" -eq 0 ] || die 'run this setup with sudo'
[ -r "$CONFIG_FILE" ] || die 'BirdNET-Pi configuration was not found'

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
  ' "$CONFIG_FILE"
}

station_user=$(conf_value BIRDNET_USER)
[[ "$station_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || die 'BirdNET-Pi user is invalid'
passwd_row=$(getent passwd "$station_user")
[ -n "$passwd_row" ] || die 'BirdNET-Pi user does not exist'
station_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
[[ "$station_home" =~ ^/[A-Za-z0-9._/+@-]+$ ]] \
  && [[ "$station_home" != *'..'* ]] \
  || die 'BirdNET-Pi home path is invalid'
repo_dir=$station_home/BirdNET-Pi
[ -d "$repo_dir/.git" ] || die 'BirdNET-Pi checkout was not found'

configured_origin=$(runuser -u "$station_user" -- \
  env -i HOME="$station_home" USER="$station_user" LOGNAME="$station_user" \
  GIT_CONFIG_GLOBAL=/dev/null PATH=/usr/local/bin:/usr/bin:/bin \
  git -C "$repo_dir" config --get remote.origin.url || true)
case "$configured_origin" in
  "$OFFICIAL_ORIGIN"|"$OFFICIAL_ORIGIN.git") ;;
  *) die "origin must be $OFFICIAL_ORIGIN" ;;
esac

lock_file=/run/lock/avian-update.lock
if [ ! -e "$lock_file" ] && [ ! -L "$lock_file" ]; then
  install -o root -g root -m 0600 /dev/null "$lock_file"
fi
[ -f "$lock_file" ] && [ ! -L "$lock_file" ] \
  && [ "$(stat -c '%u:%g:%a' "$lock_file")" = 0:0:600 ] || die 'update lock is unsafe'
exec 9<>"$lock_file"
flock -n 9 || die 'another update is already running'

# This is the same protected snapshot consumed by the fixed refresher. Never
# discard pending application state just because the official branch advanced.
helper_sources=(
  scripts/update_birdnet.sh scripts/reinstall_services.sh
  scripts/maintenance_control.sh scripts/archive_control.sh
  scripts/security_refresh.sh scripts/generation_runtime_control.sh
  scripts/admin_control.sh scripts/link_webroot.sh
  scripts/update_caddyfile.sh scripts/educators_control.sh scripts/avian-bundle
)
bundle_sources=(
  avian/scripts/bundle_manager.py avian/bundles/catalog-v1.json
  avian/scripts/bundle_species.py
)
sources=("${helper_sources[@]}" "${bundle_sources[@]}")
work_dir=$(mktemp -d /var/tmp/avian-v1-bootstrap.XXXXXX)
trusted_repo=$work_dir/official.git
snapshot_temp=''
cleanup() {
  [ -z "$snapshot_temp" ] || rm -rf -- "$snapshot_temp"
  rm -rf -- "$work_dir"
}
trap cleanup EXIT
mkdir "$trusted_repo"

trusted_git() {
  env -i HOME=/root GIT_CONFIG_GLOBAL=/dev/null \
    PATH=/usr/local/bin:/usr/bin:/bin git -C "$trusted_repo" "$@"
}

if [ ! -e "$PREPARED_DIR" ] && [ ! -L "$PREPARED_DIR" ]; then
  trusted_git init --bare -q
  if ! trusted_git fetch --no-tags "${OFFICIAL_ORIGIN}.git" \
    "refs/heads/$RELEASE_BRANCH:refs/heads/$RELEASE_BRANCH"; then
    die "could not fetch the official $RELEASE_BRANCH release"
  fi
  verified_head=$(trusted_git rev-parse --verify "refs/heads/$RELEASE_BRANCH^{commit}")
  snapshot_temp=$(mktemp -d /var/lib/.avian-update-prepared.XXXXXX)
  stage_dir=$snapshot_temp
  printf '%s\n' "$verified_head" >"$stage_dir/release"
  printf 'prepared\n' >"$stage_dir/phase"
  for source in "${sources[@]}"; do
    staged=$stage_dir/${source##*/}
    trusted_git show "$verified_head:$source" >"$staged"
    chmod 0600 "$staged"
  done
  (cd "$stage_dir" && sha256sum release "${sources[@]##*/}") >"$stage_dir/manifest"
  mv "$stage_dir" "$PREPARED_DIR"
  snapshot_temp=''
fi

# Validate before executing even one byte from a previous interrupted setup.
[ -d "$PREPARED_DIR" ] && [ ! -L "$PREPARED_DIR" ] \
  && [ "$(stat -c '%u:%g:%a' "$PREPARED_DIR")" = 0:0:700 ] || die 'prepared release directory is unsafe'
for file in release phase manifest "${sources[@]##*/}"; do
  [ -f "$PREPARED_DIR/$file" ] && [ ! -L "$PREPARED_DIR/$file" ] \
    && [ "$(stat -c '%u:%g:%a:%h' "$PREPARED_DIR/$file")" = 0:0:600:1 ] \
    || die "prepared release file is unsafe: $file"
done
verified_head=$(cat "$PREPARED_DIR/release")
[[ "$verified_head" =~ ^[0-9a-f]{40}$ ]] || die 'prepared release identity is invalid'
case "$(cat "$PREPARED_DIR/phase")" in prepared|applying) ;; *) die 'prepared release phase is invalid' ;; esac
expected_manifest=$(cd "$PREPARED_DIR" && sha256sum release "${sources[@]##*/}")
[ "$(cat "$PREPARED_DIR/manifest")" = "$expected_manifest" ] || die 'prepared release manifest does not match'
for source in "${helper_sources[@]}"; do
  bash -n "$PREPARED_DIR/${source##*/}" || die "invalid release helper: $source"
done
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -c \
  'import pathlib, sys; [compile(pathlib.Path(p).read_bytes(), p, "exec") for p in sys.argv[1:]]' \
  "$PREPARED_DIR/bundle_manager.py" "$PREPARED_DIR/bundle_species.py" \
  || die 'invalid prepared bundle runtime'

targets=("$UPDATE_HELPER" "$REFRESH_HELPER")
for index in 0 1; do
  staged=$PREPARED_DIR/${sources[$index]##*/}
  bash -n "$staged" || die "invalid release helper: ${sources[$index]}"
  target=${targets[$index]}
  temp_target=$(mktemp "$(dirname "$target")/.$(basename "$target").XXXXXX")
  install -o root -g root -m 0755 "$staged" "$temp_target"
  mv -f "$temp_target" "$target"
done

cleanup
trap - EXIT
exec 9>&-
if [ "$(cat "$PREPARED_DIR/phase")" = applying ]; then
  exec "$REFRESH_HELPER" --apply-prepared "$verified_head"
fi
exec "$UPDATE_HELPER"
