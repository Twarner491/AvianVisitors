#!/usr/bin/env bash
# Refresh the small set of files that can change in an AvianVisitors update.
# This deliberately does not rerun the BirdNET-Pi installer.

set -Eeuo pipefail
IFS=$'\n\t'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

readonly OFFICIAL_ORIGIN='https://github.com/Twarner491/AvianVisitors'
readonly RELEASE_BRANCH='avian-visitors'
readonly CONFIG_FILE='/etc/birdnet/birdnet.conf'
readonly FIXED_HELPER='/usr/local/sbin/avian-service-refresh'
readonly SECURITY_HELPER='/usr/local/sbin/avian-security-refresh'
readonly CADDY_HELPER='/usr/local/sbin/avian-caddy-refresh'
readonly WEBROOT_HELPER='/usr/local/sbin/avian-link-webroot'

case "$#" in
  0) ;;
  1) [ "$1" = --legacy-migration ] \
    || { echo 'Usage: avian-service-refresh [--legacy-migration]' >&2; exit 64; } ;;
  *) echo 'Usage: avian-service-refresh [--legacy-migration]' >&2; exit 64 ;;
esac

die() {
  printf 'Service refresh stopped: %s\n' "$*" >&2
  exit 1
}

safe_root_helper() {
  local helper=$1 owner mode
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] || return 1
  owner=$(stat -c '%u:%g' "$helper")
  mode=$(stat -c '%a' "$helper")
  [ "$owner" = 0:0 ] && [ "$mode" = 755 ]
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  safe_root_helper "$FIXED_HELPER" \
    || die "root-owned service refresher is missing or unsafe: $FIXED_HELPER"
  exec sudo "$FIXED_HELPER"
fi

[ "$(readlink -f "$0")" = "$FIXED_HELPER" ] \
  || die "root refreshes must use $FIXED_HELPER"
safe_root_helper "$FIXED_HELPER" \
  || die "root-owned service refresher is unsafe: $FIXED_HELPER"

# Share the updater's root-owned lock so a cron update and a Tools service
# refresh cannot rewrite helpers or webroot links at the same time. The
# updater passes its inherited descriptor; a standalone refresh acquires the
# same lock itself.
lock_file=/run/lock/avian-update.lock
if [ "${AVIAN_UPDATE_LOCK_FD:-}" = 9 ] \
  && [ -e /proc/self/fd/9 ] \
  && [ "$(readlink -f /proc/self/fd/9)" = "$lock_file" ]; then
  flock -n 9 || die 'another update is already running'
else
  if [ ! -e "$lock_file" ]; then
    install -o root -g root -m 0600 /dev/null "$lock_file"
  fi
  if [ ! -f "$lock_file" ] || [ -L "$lock_file" ] \
    || [ "$(stat -c '%u:%g:%a' "$lock_file")" != 0:0:600 ]; then
    die "update lock is unsafe: $lock_file"
  fi
  exec 9<>"$lock_file"
  flock -n 9 || die 'another update is already running'
fi

conf_value() {
  local file=$1 key=$2
  awk -v wanted="$key" '
    $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
      value=$0
      sub(/^[^=]*=/, "", value)
      gsub(/^[[:space:]\"\047 ]+|[[:space:]\"\047 ]+$/, "", value)
      print value
      exit
    }
  ' "$file" 2>/dev/null || true
}

[ -r "$CONFIG_FILE" ] || die 'BirdNET-Pi configuration was not found'
station_user=$(conf_value "$CONFIG_FILE" BIRDNET_USER)
[[ "$station_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || die 'BirdNET-Pi user is invalid'
passwd_row=$(getent passwd "$station_user")
[ -n "$passwd_row" ] || die 'BirdNET-Pi user does not exist'
station_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
if [[ ! "$station_home" =~ ^/[A-Za-z0-9._/+@-]+$ ]] \
  || [[ "$station_home" = *'..'* ]]; then
  die 'BirdNET-Pi home path is invalid'
fi
repo_dir=$station_home/BirdNET-Pi
[ -d "$repo_dir/.git" ] || die 'BirdNET-Pi checkout was not found'

run_as_station() {
  /usr/sbin/runuser -u "$station_user" -- \
    env -i HOME="$station_home" USER="$station_user" LOGNAME="$station_user" \
    GIT_CONFIG_GLOBAL=/dev/null \
    PATH=/usr/local/bin:/usr/bin:/bin "$@"
}

git_station() {
  run_as_station git -C "$repo_dir" "$@"
}

git_trusted() {
  env -i HOME=/root GIT_CONFIG_GLOBAL=/dev/null \
    PATH=/usr/local/bin:/usr/bin:/bin git -C "$trusted_repo" "$@"
}

read_git_lines() {
  local destination=$1 output
  shift
  output=$(mktemp /tmp/avian-git-output.XXXXXX)
  if ! git_station "$@" >"$output"; then
    rm -f "$output"
    die 'Git could not inspect the checkout'
  fi
  mapfile -t "$destination" <"$output"
  rm -f "$output"
}

origin_url=$(git_station config --get remote.origin.url || true)
case "$origin_url" in
  "$OFFICIAL_ORIGIN"|"$OFFICIAL_ORIGIN.git") ;;
  '') die 'origin is not configured' ;;
  *) die "origin must be $OFFICIAL_ORIGIN" ;;
esac

current_branch=$(git_station symbolic-ref --quiet --short HEAD || true)
[ "$current_branch" = "$RELEASE_BRANCH" ] \
  || die "checkout must be on $RELEASE_BRANCH"
current_head=$(git_station rev-parse --verify HEAD)

# Privileged helper bytes must not be trusted merely because they are clean in
# a station-owned checkout. Fetch the official release into a root-owned
# temporary object store, then require the checkout to be on that exact commit.
work_dir=$(mktemp -d /var/tmp/avian-service-refresh.XXXXXX)
trusted_repo=$work_dir/official.git
cleanup() { rm -rf "$work_dir"; }
trap cleanup EXIT
mkdir "$trusted_repo"
git_trusted init --bare -q
if ! git_trusted fetch --no-tags \
  "${OFFICIAL_ORIGIN}.git" \
  "refs/heads/$RELEASE_BRANCH:refs/heads/$RELEASE_BRANCH"; then
  die "could not verify origin/$RELEASE_BRANCH"
fi
verified_head=$(git_trusted rev-parse --verify "refs/heads/$RELEASE_BRANCH^{commit}")
[ "$current_head" = "$verified_head" ] \
  || die "checkout is not the current official $RELEASE_BRANCH release; update first"

helper_sources=(
  scripts/update_birdnet.sh
  scripts/reinstall_services.sh
  scripts/maintenance_control.sh
  scripts/archive_control.sh
  scripts/security_refresh.sh
  scripts/admin_control.sh
  scripts/link_webroot.sh
  scripts/update_caddyfile.sh
)
helper_targets=(
  /usr/local/sbin/avian-update-control
  /usr/local/sbin/avian-service-refresh
  /usr/local/sbin/avian-maintenance-control
  /usr/local/sbin/avian-archive-control
  /usr/local/sbin/avian-security-refresh
  /usr/local/sbin/avian-admin-control
  /usr/local/sbin/avian-link-webroot
  /usr/local/sbin/avian-caddy-refresh
)

for helper_source in "${helper_sources[@]}"; do
  git_station ls-files --error-unmatch -- "$helper_source" >/dev/null \
    || die "privileged helper is not tracked: $helper_source"
  git_station diff --quiet --no-ext-diff "$current_head" -- "$helper_source" \
    || die "privileged helper has local changes: $helper_source"
done

stage_dir=$work_dir/helpers
mkdir "$stage_dir"

for index in "${!helper_sources[@]}"; do
  helper_source=${helper_sources[$index]}
  staged_helper=$stage_dir/$(basename "$helper_source")
  git_trusted show "$verified_head:$helper_source" >"$staged_helper"
  bash -n "$staged_helper" \
    || die "privileged helper has invalid shell syntax: $helper_source"
  chmod 0700 "$staged_helper"
done

install_root_helper() {
  local source_path=$1 target_path=$2 target_temp
  target_temp=$(mktemp "$(dirname "$target_path")/.$(basename "$target_path").XXXXXX")
  install -o root -g root -m 0755 "$source_path" "$target_temp"
  mv -f "$target_temp" "$target_path"
}

for index in "${!helper_sources[@]}"; do
  install_root_helper \
    "$stage_dir/$(basename "${helper_sources[$index]}")" \
    "${helper_targets[$index]}"
done

# The security helper owns the sudoers policy and targeted checkout modes. It
# validates the replacement policy before retiring the inherited broad rule.
safe_root_helper "$SECURITY_HELPER" \
  || die "root-owned security refresher is unsafe: $SECURITY_HELPER"
"$SECURITY_HELPER"
[ ! -e /etc/sudoers.d/010_caddy-nopasswd ] \
  || die 'legacy unrestricted Caddy sudo rule is still installed'

# Recreate only symlinks backed by committed top-level scripts. Unknown files
# already present in /usr/local/bin are left alone.
tracked_scripts=()
read_git_lines tracked_scripts ls-tree -r --name-only HEAD scripts
for tracked_script in "${tracked_scripts[@]}"; do
  case "$tracked_script" in
    scripts/*/*) continue ;;
    scripts/*)
      script_name=${tracked_script#scripts/}
      [[ "$script_name" =~ ^[A-Za-z0-9._-]+$ ]] || continue
      [ -f "$repo_dir/$tracked_script" ] || continue
      ln -sfn "$repo_dir/$tracked_script" "/usr/local/bin/$script_name"
      ;;
  esac
done

expand_station_path() {
  local value=$1
  value=${value//\$\{HOME\}/$station_home}
  value=${value//\$HOME/$station_home}
  printf '%s' "$value"
}

web_root=$(conf_value "$CONFIG_FILE" EXTRACTED)
[ -n "$web_root" ] || web_root=$station_home/BirdSongs/Extracted
web_root=$(expand_station_path "$web_root")
[[ "$web_root" = /* && "$web_root" != *$'\n'* && "/$web_root/" != *'/../'* ]] \
  || die 'webroot path is invalid'
[ -d "$web_root" ] || die "webroot was not found: $web_root"
run_as_station test -w "$web_root" || die "webroot is not writable by $station_user"

safe_root_helper "$WEBROOT_HELPER" \
  || die "root-owned webroot refresher is unsafe: $WEBROOT_HELPER"
"$WEBROOT_HELPER" "$repo_dir" "$web_root" "$station_user"

# If Drive archive setup already exists, refresh its root-owned worker and
# units through the installed fixed-action helper. First-time setup remains a
# deliberate Tools action.
if [ -x "$station_home/bird-archive/archive_to_drive.sh" ]; then
  for archive_source in \
    extras/archive/archive_to_drive.sh extras/archive/archive.conf.example; do
    git_station ls-files --error-unmatch -- "$archive_source" >/dev/null \
      || die "archive source is not tracked: $archive_source"
    git_station diff --quiet HEAD -- "$archive_source" \
      || die "archive source has local changes: $archive_source"
  done
  /usr/local/sbin/avian-archive-control install >/dev/null
fi

systemctl daemon-reload
safe_root_helper "$CADDY_HELPER" \
  || die "root-owned Caddy refresher is unsafe: $CADDY_HELPER"
"$CADDY_HELPER"

echo 'AvianVisitors service refresh complete.'
