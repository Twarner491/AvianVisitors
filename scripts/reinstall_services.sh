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
readonly BUNDLE_HELPER='/usr/local/sbin/avian-bundle-control'
readonly BUNDLE_CLI='/usr/local/bin/avian-bundle'
readonly BUNDLE_CATALOG='/usr/share/avian-visitors/bundles/catalog-v1.json'
readonly BUNDLE_SPECIES_HELPER='/usr/share/avian-visitors/bundles/bundle_species.py'
readonly BUNDLE_STATE_PARENT='/var/lib/avian-visitors'
readonly BUNDLE_MARKER='/var/lib/avian-visitors/bundles-v1.enabled'
readonly BUNDLE_EXPORT_LOCK='/run/lock/avian-bundle-export.lock'
readonly GENERATION_LOCK='/run/lock/avian-generation.lock'
readonly BUNDLE_LOCK_POLICY='/etc/tmpfiles.d/avian-bundle-locks.conf'
readonly PREPARED_DIR='/var/lib/avian-update-prepared'

refresh_mode=full
selected_head=''
case "$#" in
  0) ;;
  1)
    case "$1" in
      --legacy-migration) ;;
      --audio-policy) refresh_mode=audio-policy ;;
      --helper-bootstrap) refresh_mode='helper-bootstrap' ;;
      --bundle-bootstrap) refresh_mode='bundle-bootstrap' ;;
      *) echo 'Usage: avian-service-refresh [--legacy-migration|--audio-policy|--helper-bootstrap|--bundle-bootstrap]' >&2; exit 64 ;;
    esac
    ;;
  2)
    case "$1" in
      --prepare-update) refresh_mode=prepare ;;
      --apply-prepared) refresh_mode=apply ;;
      *) exit 64 ;;
    esac
    selected_head=$2
    [[ "$selected_head" =~ ^[0-9a-f]{40}$ ]] || exit 64
    ;;
  *) echo 'Usage: avian-service-refresh [--legacy-migration|--audio-policy|--helper-bootstrap|--bundle-bootstrap|--prepare-update SHA|--apply-prepared SHA]' >&2; exit 64 ;;
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

ensure_bundle_sandbox_user() {
  local row uid gid home shell groups group_row group_gid group_members
  if ! getent passwd avian-bundle >/dev/null; then
    /usr/sbin/useradd --system --user-group --home-dir /nonexistent \
      --shell /usr/sbin/nologin avian-bundle
  fi
  row=$(getent passwd avian-bundle) || die 'bundle image sandbox account is unavailable'
  IFS=: read -r _ _ uid gid _ home shell <<<"$row"
  group_row=$(getent group avian-bundle) || die 'bundle image sandbox group is unavailable'
  IFS=: read -r _ _ group_gid group_members <<<"$group_row"
  groups=$(id -G avian-bundle)
  [ "$uid" != 0 ] && [ "$gid" != 0 ] \
    && [ "$home" = /nonexistent ] \
    && [ "$shell" = /usr/sbin/nologin ] \
    && [ "$group_gid" = "$gid" ] && [ -z "$group_members" ] \
    && [ "$groups" = "$gid" ] \
    || die 'bundle image sandbox account is unsafe'
}

ensure_bundle_sandbox_root() {
  local path mode
  for path in /var/empty /var/empty/avian-bundle; do
    mode=0755
    [ "$path" != /var/empty/avian-bundle ] || mode=0555
    if [ -e "$path" ] || [ -L "$path" ]; then
      [ -d "$path" ] && [ ! -L "$path" ] \
        && [ "$(stat -c '%u:%g:%a' -- "$path")" = "0:0:${mode#0}" ] \
        || die 'bundle image sandbox root is unsafe'
    else
      install -d -o root -g root -m "$mode" "$path"
    fi
  done
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  safe_root_helper "$FIXED_HELPER" \
    || die "root-owned service refresher is missing or unsafe: $FIXED_HELPER"
  exec sudo "$FIXED_HELPER" "$@"
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

apply_livestream_policy() {
  local livestream_dropin_dir livestream_dropin_mode livestream_dropin_owner
  local livestream_dropin_path livestream_dropin_temp recording_card rtsp_stream
  local recording_user

  [ -r "$CONFIG_FILE" ] || die 'BirdNET-Pi configuration was not found'
  # A direct ALSA PCM cannot be shared reliably between the recorder and the
  # optional live stream. Keep recording authoritative, and give existing
  # installs the same restart policy used by a new install.
  livestream_dropin_dir=/etc/systemd/system/livestream.service.d
  if [ -L "$livestream_dropin_dir" ] \
    || { [ -e "$livestream_dropin_dir" ] && [ ! -d "$livestream_dropin_dir" ]; }; then
    die "live stream drop-in path is unsafe: $livestream_dropin_dir"
  fi
  [ -d "$livestream_dropin_dir" ] \
    || install -d -o root -g root -m 0755 "$livestream_dropin_dir"
  livestream_dropin_owner=$(stat -c '%u:%g' "$livestream_dropin_dir")
  livestream_dropin_mode=$(stat -c '%a' "$livestream_dropin_dir")
  if [ "$livestream_dropin_owner" != 0:0 ] \
    || (( (8#$livestream_dropin_mode & 0022) != 0 )); then
    die "live stream drop-in directory is unsafe: $livestream_dropin_dir"
  fi
  livestream_dropin_path=$livestream_dropin_dir/10-avian-visitors-restart.conf
  if { [ -e "$livestream_dropin_path" ] || [ -L "$livestream_dropin_path" ]; } \
    && { [ ! -f "$livestream_dropin_path" ] \
      || [ -L "$livestream_dropin_path" ] \
      || [ "$(stat -c '%u:%g' "$livestream_dropin_path")" != 0:0 ]; }; then
    die "live stream drop-in file is unsafe: $livestream_dropin_path"
  fi
  livestream_dropin_temp=$(mktemp "$livestream_dropin_dir/.avian-visitors.XXXXXX")
  printf '%s\n' \
    '[Service]' \
    'Restart=always' \
    'ExecCondition=/usr/local/bin/livestream.sh --check' \
    >"$livestream_dropin_temp"
  chown root:root "$livestream_dropin_temp"
  chmod 0644 "$livestream_dropin_temp"
  mv -f "$livestream_dropin_temp" "$livestream_dropin_path"

  systemctl daemon-reload
  recording_card=$(conf_value "$CONFIG_FILE" REC_CARD)
  rtsp_stream=$(conf_value "$CONFIG_FILE" RTSP_STREAM)
  case "${rtsp_stream}:${recording_card}" in
    :hw:*|:plughw:*)
      systemctl stop livestream.service
      printf 'Live stream policy: %s is reserved for bird recording; the live stream was stopped.\n' \
        "$recording_card"
      recording_user=$(conf_value "$CONFIG_FILE" BIRDNET_USER)
      [[ "$recording_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
        || die 'BirdNET-Pi user is invalid'
      getent passwd "$recording_user" >/dev/null \
        || die 'BirdNET-Pi user does not exist'
      if pgrep -u "$recording_user" -x pulseaudio >/dev/null 2>&1; then
        printf 'Warning: PulseAudio is still running for %s and may still own the direct ALSA device. Bird recording is not yet confirmed recovered. Reboot the station, then check birdnet_recording.service. Stop PulseAudio manually only after confirming that no other audio service needs it.\n' \
          "$recording_user" >&2
      fi
      ;;
    *)
      printf '%s\n' 'Live stream policy: shared audio or RTSP remains available.'
      ;;
  esac
}

if [ "$refresh_mode" = audio-policy ]; then
  apply_livestream_policy
  echo 'AvianVisitors live stream policy refreshed.'
  exit 0
fi

[ -r "$CONFIG_FILE" ] || die 'BirdNET-Pi configuration was not found'
station_user=$(conf_value "$CONFIG_FILE" BIRDNET_USER)
[[ "$station_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || die 'BirdNET-Pi user is invalid'
passwd_row=$(getent passwd "$station_user")
[ -n "$passwd_row" ] || die 'BirdNET-Pi user does not exist'
station_gid=$(id -g "$station_user")
[ -n "$station_gid" ] || die 'BirdNET-Pi group does not exist'
station_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
if [[ ! "$station_home" =~ ^/[A-Za-z0-9._/+@-]+$ ]] \
  || [[ "$station_home" = *'..'* ]]; then
  die 'BirdNET-Pi home path is invalid'
fi
repo_dir=$station_home/BirdNET-Pi
[ -d "$repo_dir/.git" ] || die 'BirdNET-Pi checkout was not found'

for coordination_lock in "$GENERATION_LOCK" "$BUNDLE_EXPORT_LOCK"; do
  if [ -e "$coordination_lock" ] || [ -L "$coordination_lock" ]; then
    [ -f "$coordination_lock" ] && [ ! -L "$coordination_lock" ] \
      && [ "$(stat -c '%u:%h' -- "$coordination_lock")" = '0:1' ] \
      || die 'Avian Visitors coordination lock is unsafe'
    # Explicit account migration may update a verified live inode; boot may not.
    chgrp "$station_gid" "$coordination_lock"
    chmod 0660 "$coordination_lock"
  fi
done
tmpfiles_dir=/etc/tmpfiles.d
if [ ! -e "$tmpfiles_dir" ] && [ ! -L "$tmpfiles_dir" ]; then
  install -d -o root -g root -m 0755 "$tmpfiles_dir"
fi
[ -d "$tmpfiles_dir" ] && [ ! -L "$tmpfiles_dir" ] \
  && [ "$(stat -c '%u:%g:%a' -- "$tmpfiles_dir")" = '0:0:755' ] \
  || die 'Unsafe tmpfiles directory'
if [ -e "$BUNDLE_LOCK_POLICY" ] || [ -L "$BUNDLE_LOCK_POLICY" ]; then
  [ -f "$BUNDLE_LOCK_POLICY" ] && [ ! -L "$BUNDLE_LOCK_POLICY" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$BUNDLE_LOCK_POLICY")" = '0:0:644:1' ] \
    || die 'Avian Visitors tmpfiles policy is unsafe'
fi
lock_policy_temp=$(mktemp "$tmpfiles_dir/.avian-bundle-locks.XXXXXX")
if ! {
  printf 'f %s :0660 :root :%s -\n' "$GENERATION_LOCK" "$station_gid"
  printf 'f %s :0660 :root :%s -\n' "$BUNDLE_EXPORT_LOCK" "$station_gid"
} >"$lock_policy_temp"; then
  rm -f "$lock_policy_temp"
  die 'could not render Avian Visitors tmpfiles policy'
fi
if ! chown root:root "$lock_policy_temp" \
  || ! chmod 0644 "$lock_policy_temp" \
  || ! mv -fT -- "$lock_policy_temp" "$BUNDLE_LOCK_POLICY"; then
  rm -f "$lock_policy_temp"
  die 'could not install Avian Visitors tmpfiles policy'
fi
/usr/bin/systemd-tmpfiles --create "$BUNDLE_LOCK_POLICY" \
  || die 'could not apply Avian Visitors tmpfiles policy'
for coordination_lock in "$GENERATION_LOCK" "$BUNDLE_EXPORT_LOCK"; do
  [ "$(stat -c '%u:%g:%a:%h' -- "$coordination_lock")" = \
    "0:$station_gid:660:1" ] \
    || die 'Avian Visitors coordination lock policy failed'
done

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
[ "$current_branch" = "$RELEASE_BRANCH" ] || [ "$refresh_mode:$current_branch" = prepare:main ] \
  || die "checkout must be on $RELEASE_BRANCH"
current_head=$(git_station rev-parse --verify HEAD)

helper_sources=(
  scripts/update_birdnet.sh
  scripts/reinstall_services.sh
  scripts/maintenance_control.sh
  scripts/archive_control.sh
  scripts/security_refresh.sh
  scripts/generation_runtime_control.sh
  scripts/admin_control.sh
  scripts/link_webroot.sh
  scripts/update_caddyfile.sh
  scripts/educators_control.sh
  scripts/avian-bundle
)
helper_targets=(
  /usr/local/sbin/avian-update-control
  /usr/local/sbin/avian-service-refresh
  /usr/local/sbin/avian-maintenance-control
  /usr/local/sbin/avian-archive-control
  /usr/local/sbin/avian-security-refresh
  /usr/local/sbin/avian-generation-runtime
  /usr/local/sbin/avian-admin-control
  /usr/local/sbin/avian-link-webroot
  /usr/local/sbin/avian-caddy-refresh
  /usr/local/sbin/avian-educators
  /usr/local/bin/avian-bundle
)
bundle_sources=(
  avian/scripts/bundle_manager.py
  avian/bundles/catalog-v1.json
  avian/scripts/bundle_species.py
)
prepared_sources=("${helper_sources[@]}" "${bundle_sources[@]}")

validate_prepared() {
  local file helper_source expected_manifest
  [ -d "$PREPARED_DIR" ] && [ ! -L "$PREPARED_DIR" ] \
    && [ "$(stat -c '%u:%g:%a' "$PREPARED_DIR")" = 0:0:700 ] \
    || die 'prepared release directory is unsafe'
  for file in release manifest phase "${prepared_sources[@]##*/}"; do
    [ -f "$PREPARED_DIR/$file" ] && [ ! -L "$PREPARED_DIR/$file" ] \
      && [ "$(stat -c '%u:%g:%a:%h' "$PREPARED_DIR/$file")" = 0:0:600:1 ] \
      || die "prepared release file is unsafe: $file"
  done
  verified_head=$(cat "$PREPARED_DIR/release")
  [[ "$verified_head" =~ ^[0-9a-f]{40}$ ]] || die 'prepared release identity is invalid'
  [ -z "$selected_head" ] || [ "$selected_head" = "$verified_head" ] \
    || die 'another release is pending; run sudo /usr/local/sbin/avian-update-control to resume'
  case "$(cat "$PREPARED_DIR/phase")" in prepared|applying) ;; *) die 'prepared release phase is invalid' ;; esac
  # Recompute the complete manifest, rather than accepting paths supplied by it.
  expected_manifest=$(cd "$PREPARED_DIR" && sha256sum release "${prepared_sources[@]##*/}")
  [ "$(cat "$PREPARED_DIR/manifest")" = "$expected_manifest" ] \
    || die 'prepared release manifest does not match'
  for helper_source in "${helper_sources[@]}"; do
    bash -n "$PREPARED_DIR/${helper_source##*/}" || die 'prepared helper syntax is invalid'
  done
  PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -c \
    'import pathlib, sys; [compile(pathlib.Path(p).read_bytes(), p, "exec") for p in sys.argv[1:]]' \
    "$PREPARED_DIR/bundle_manager.py" "$PREPARED_DIR/bundle_species.py" \
    || die 'prepared bundle helper syntax is invalid'
}

created_preparation=false
if [ -e "$PREPARED_DIR" ] || [ -L "$PREPARED_DIR" ]; then
  validate_prepared
else
  [ "$refresh_mode" != apply ] || die 'no prepared release; run verified update setup'
  work_dir=$(mktemp -d /var/tmp/avian-service-refresh.XXXXXX)
  trusted_repo=$work_dir/official.git
  snapshot_temp=''
  cleanup() {
    [ -z "$snapshot_temp" ] || rm -rf -- "$snapshot_temp"
    rm -rf -- "$work_dir"
  }
  trap cleanup EXIT
  mkdir "$trusted_repo"
  git_trusted init --bare -q
  if ! git_trusted fetch --no-tags "${OFFICIAL_ORIGIN}.git" \
    "refs/heads/$RELEASE_BRANCH:refs/heads/$RELEASE_BRANCH"; then
    die "could not verify origin/$RELEASE_BRANCH"
  fi
  verified_head=$(git_trusted rev-parse --verify "refs/heads/$RELEASE_BRANCH^{commit}")
  [ "${selected_head:-$current_head}" = "$verified_head" ] \
    || die "checkout is not the current official $RELEASE_BRANCH release; update first"
  snapshot_temp=$(mktemp -d /var/lib/.avian-update-prepared.XXXXXX)
  stage_dir=$snapshot_temp
  printf '%s\n' "$verified_head" >"$stage_dir/release"
  printf 'prepared\n' >"$stage_dir/phase"
  for helper_source in "${prepared_sources[@]}"; do
    staged_helper=$stage_dir/${helper_source##*/}
    git_trusted show "$verified_head:$helper_source" >"$staged_helper"
    chmod 0600 "$staged_helper"
  done
  (cd "$stage_dir" && sha256sum release "${prepared_sources[@]##*/}") >"$stage_dir/manifest"
  mv "$stage_dir" "$PREPARED_DIR"
  snapshot_temp=''
  validate_prepared
  created_preparation=true
fi
stage_dir=$PREPARED_DIR
if [ "$refresh_mode" = prepare ]; then
  if [ "$(cat "$PREPARED_DIR/phase")" = applying ] && [ "$current_head" != "$verified_head" ]; then
    die 'partially applied release does not match checkout; restore the selected checkout before resuming'
  fi
  echo "Prepared AvianVisitors release $verified_head."
  exit 0
fi
[ "$current_head" = "$verified_head" ] \
  || die 'prepared release does not match checkout; run sudo /usr/local/sbin/avian-update-control to resume'
for helper_source in "${helper_sources[@]}"; do
  git_station ls-files --error-unmatch -- "$helper_source" >/dev/null \
    || die "privileged helper is not tracked: $helper_source"
  git_station diff --quiet --no-ext-diff "$current_head" -- "$helper_source" \
    || die "privileged helper has local changes: $helper_source"
done
phase_temp=$(mktemp "$PREPARED_DIR/.phase.XXXXXX")
printf 'applying\n' >"$phase_temp"
mv -f "$phase_temp" "$PREPARED_DIR/phase"

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

for release_source in "${bundle_sources[@]}"; do
  git_station ls-files --error-unmatch -- "$release_source" >/dev/null \
    || die "bundle release file is not tracked: $release_source"
  git_station diff --quiet --no-ext-diff "$current_head" -- "$release_source" \
    || die "bundle release file has local changes: $release_source"
done
staged_bundle_manager=$stage_dir/bundle_manager.py
staged_bundle_catalog=$stage_dir/catalog-v1.json
staged_bundle_species=$stage_dir/bundle_species.py
if [ -e "$BUNDLE_STATE_PARENT" ] || [ -L "$BUNDLE_STATE_PARENT" ]; then
  [ -d "$BUNDLE_STATE_PARENT" ] && [ ! -L "$BUNDLE_STATE_PARENT" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$BUNDLE_STATE_PARENT")" = '0:0:755' ] \
    || die 'bundle state parent is unsafe'
else
  install -d -o root -g root -m 0755 "$BUNDLE_STATE_PARENT"
fi
if ! /usr/bin/python3 -c 'from PIL import Image' >/dev/null 2>&1; then
  /usr/bin/apt-get -qq update \
    || die 'could not refresh packages for bundle image validation'
  /usr/bin/apt-get install --no-install-recommends -qqy python3-pil \
    || die 'could not install bundle image validation support'
fi
ensure_bundle_sandbox_user
ensure_bundle_sandbox_root
install_root_helper "$staged_bundle_manager" "$BUNDLE_HELPER"
install -d -o root -g root -m 0755 "$(dirname "$BUNDLE_CATALOG")"
bundle_catalog_temp=$(mktemp "$(dirname "$BUNDLE_CATALOG")/.catalog-v1.XXXXXX")
install -o root -g root -m 0644 "$staged_bundle_catalog" "$bundle_catalog_temp"
mv -f "$bundle_catalog_temp" "$BUNDLE_CATALOG"
bundle_species_temp=$(mktemp "$(dirname "$BUNDLE_CATALOG")/.bundle-species.XXXXXX")
install -o root -g root -m 0644 "$staged_bundle_species" "$bundle_species_temp"
mv -f "$bundle_species_temp" "$BUNDLE_SPECIES_HELPER"
env -i LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  "$BUNDLE_HELPER" configure-station --user "$station_user" --root "$repo_dir" --json \
  || die 'could not configure local bundle species lookup'
bundle_init_output=$(env -i HOME=/root LC_ALL=C \
  PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  "$BUNDLE_HELPER" initialize --json) \
  || die "could not initialize bundle storage: $bundle_init_output"
if [ -e "$BUNDLE_MARKER" ] || [ -L "$BUNDLE_MARKER" ]; then
  [ -f "$BUNDLE_MARKER" ] && [ ! -L "$BUNDLE_MARKER" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$BUNDLE_MARKER")" = '0:0:644:1' ] \
    || die 'bundle provisioning marker is unsafe'
else
  install -o root -g root -m 0644 /dev/null "$BUNDLE_MARKER"
fi

if [ "$refresh_mode" = bundle-bootstrap ]; then
  if [ "$created_preparation" = true ]; then
    rm -rf "$PREPARED_DIR"
  fi
  echo 'AvianVisitors bundle storage initialized.'
  exit 0
fi

# A pre-Educators refresher installs this release's security helper before it
# knows about the newly added helper target. The security helper may re-enter
# this verified installer under the inherited update lock for this one narrow
# completion pass.
if [ "$refresh_mode" = helper-bootstrap ]; then
  # The historical caller owns the remaining refresh. Retain any pre-existing
  # full-update recovery snapshot, but do not leave this completed helper-only
  # pass pinned as an interrupted application.
  if [ "$created_preparation" = true ]; then
    rm -rf "$PREPARED_DIR"
  fi
  echo 'AvianVisitors privileged helpers refreshed.'
  exit 0
fi

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
      [ "$script_name" != avian-bundle ] || continue
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

rm -rf "$PREPARED_DIR"
echo 'AvianVisitors service refresh complete.'
