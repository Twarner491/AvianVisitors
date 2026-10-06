#!/usr/bin/env bash
# Install the narrow Caddy privilege policy and lock the checkout so the web
# process cannot replace code later executed by a privileged helper.

set -euo pipefail
IFS=$'\n\t'
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL
umask 077

remove_exact_legacy_file() {
  local path=$1
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -f "$path" ] && [ ! -L "$path" ] || return 1
    rm -f -- "$path"
    [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
  fi
}

remove_legacy_firstrun() {
  local path=$1
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ ! -d "$path" ] || return 1
    rm -f -- "$path"
  fi
}

[ "${EUID:-$(id -u)}" -eq 0 ] || { echo "security refresh must run as root" >&2; exit 1; }

conf_value() {
  local file=$1 key=$2
  awk -v wanted="$key" '
    $0 ~ "^[[:space:]]*" wanted "[[:space:]]*=" {
      value=$0
      sub(/^[^=]*=/, "", value)
      gsub(/^[[:space:]"\047]+|[[:space:]"\047]+$/, "", value)
      found=1
    }
    END { if (found) print value }
  ' "$file" 2>/dev/null || true
}

render_bundle_export_pool() {
  local version=$1
  cat <<EOF
[avian-bundle-export]
user = caddy
group = caddy
listen = /run/php/avian-bundle-export-${version}.sock
listen.owner = caddy
listen.group = caddy
listen.mode = 0600
pm = ondemand
pm.max_children = 2
pm.process_idle_timeout = 10s
pm.max_requests = 1
request_terminate_timeout = 3700s
request_terminate_timeout_track_finished = yes
security.limit_extensions = .php
clear_env = yes
EOF
}

bundle_fpm_fail() {
  printf 'Could not secure bundle export PHP-FPM: %s\n' "$*" >&2
  exit 1
}

install_bundle_export_pools() {
  local pool_dir pool_mode version fpm_binary pool_file pool_temp test_config
  local backup_file had_previous unit socket socket_wait
  local -a active_versions=()
  local found_pool=0

  caddy_uid=$(id -u caddy 2>/dev/null) \
    || bundle_fpm_fail 'Caddy account was not found'
  caddy_gid=$(id -g caddy 2>/dev/null) \
    || bundle_fpm_fail 'Caddy group was not found'
  [ "$caddy_uid" -ne 0 ] && [ "$caddy_gid" -ne 0 ] \
    || bundle_fpm_fail 'Caddy account cannot be privileged'
  usermod -a -G "$birdnet_group" caddy \
    || bundle_fpm_fail 'Caddy could not join the BirdNET-Pi group'
  case " $(id -G caddy) " in
    *" $birdnet_gid "*) ;;
    *) bundle_fpm_fail 'Caddy is missing the BirdNET-Pi group' ;;
  esac

  for pool_dir in /etc/php/[0-9]*.[0-9]*/fpm/pool.d; do
    [ -d "$pool_dir" ] || continue
    [ ! -L "$pool_dir" ] \
      && [ "$(readlink -f -- "$pool_dir")" = "$pool_dir" ] \
      && [ "$(stat -c '%u:%g' -- "$pool_dir")" = 0:0 ] \
      || bundle_fpm_fail "unsafe pool directory: $pool_dir"
    pool_mode=$(stat -c '%a' -- "$pool_dir")
    (( (8#$pool_mode & 8#022) == 0 )) \
      || bundle_fpm_fail "writable pool directory: $pool_dir"

    version=${pool_dir#/etc/php/}
    version=${version%%/*}
    [[ "$version" =~ ^[0-9]+\.[0-9]+$ ]] \
      || bundle_fpm_fail "invalid version directory: $pool_dir"
    fpm_binary=/usr/sbin/php-fpm$version
    [ -x "$fpm_binary" ] || continue

    pool_file=$pool_dir/zz-avian-bundle-export.conf
    if [ -e "$pool_file" ] || [ -L "$pool_file" ]; then
      [ -f "$pool_file" ] && [ ! -L "$pool_file" ] \
        && [ "$(stat -c '%u:%g:%a:%h' -- "$pool_file")" = 0:0:644:1 ] \
        || bundle_fpm_fail "unsafe pool file: $pool_file"
    fi
    "$fpm_binary" -t >/dev/null 2>&1 \
      || bundle_fpm_fail "existing PHP-FPM $version configuration is invalid"

    pool_temp=$(mktemp "$pool_dir/.avian-bundle-export.XXXXXX") \
      || bundle_fpm_fail "could not stage the $version pool"
    if ! render_bundle_export_pool "$version" >"$pool_temp" \
      || ! chown root:root "$pool_temp" \
      || ! chmod 0644 "$pool_temp"; then
      rm -f -- "$pool_temp"
      bundle_fpm_fail "could not render the $version pool"
    fi

    test_config=$(mktemp /tmp/.avian-bundle-fpm-test.XXXXXX) \
      || { rm -f -- "$pool_temp"; bundle_fpm_fail 'could not stage syntax validation'; }
    {
      printf '%s\n' '[global]' 'daemonize = no' 'error_log = /dev/stderr'
      printf 'include = %s\n' "$pool_temp"
    } >"$test_config"
    if ! "$fpm_binary" -t -y "$test_config" >/dev/null 2>&1; then
      rm -f -- "$pool_temp" "$test_config"
      bundle_fpm_fail "PHP-FPM rejected the $version bundle pool"
    fi
    rm -f -- "$test_config"

    had_previous=0
    backup_file=
    if [ -e "$pool_file" ]; then
      had_previous=1
      backup_file=$(mktemp "$pool_dir/.avian-bundle-export-backup.XXXXXX") \
        || { rm -f -- "$pool_temp"; bundle_fpm_fail 'could not stage pool rollback'; }
      if ! cp -p -- "$pool_file" "$backup_file"; then
        rm -f -- "$pool_temp" "$backup_file"
        bundle_fpm_fail 'could not preserve the installed pool'
      fi
    fi
    if ! mv -fT -- "$pool_temp" "$pool_file" \
      || ! sync -f "$pool_file" \
      || ! "$fpm_binary" -t >/dev/null 2>&1; then
      if [ "$had_previous" -eq 1 ]; then
        mv -fT -- "$backup_file" "$pool_file" || true
      else
        rm -f -- "$pool_file"
      fi
      rm -f -- "$pool_temp" "$backup_file"
      bundle_fpm_fail "could not install the $version pool"
    fi
    rm -f -- "$backup_file"
    [ "$(stat -c '%u:%g:%a:%h' -- "$pool_file")" = 0:0:644:1 ] \
      && render_bundle_export_pool "$version" | cmp -s - "$pool_file" \
      || bundle_fpm_fail "installed $version pool did not verify"

    found_pool=1
    unit=php${version}-fpm.service
    if systemctl is-active --quiet "$unit"; then
      active_versions+=("$version")
    fi
  done

  [ "$found_pool" -eq 1 ] \
    || bundle_fpm_fail 'no supported PHP-FPM installation was found'
  [ "${#active_versions[@]}" -gt 0 ] \
    || bundle_fpm_fail 'no PHP-FPM service is active'

  for version in "${active_versions[@]}"; do
    unit=php${version}-fpm.service
    systemctl reload "$unit" \
      || bundle_fpm_fail "could not reload $unit"
    socket=/run/php/avian-bundle-export-${version}.sock
    socket_wait=0
    while [ ! -S "$socket" ] && [ "$socket_wait" -lt 100 ]; do
      sleep 0.1
      socket_wait=$((socket_wait + 1))
    done
    [ -S "$socket" ] && [ ! -L "$socket" ] \
      && [ "$(stat -c '%u:%g:%a:%h' -- "$socket")" = "$caddy_uid:$caddy_gid:600:1" ] \
      || bundle_fpm_fail "dedicated socket is unavailable or unsafe: $socket"
  done
}

conf_link=/etc/birdnet/birdnet.conf
[ -r "$conf_link" ] || { echo "BirdNET-Pi config was not found" >&2; exit 1; }
birdnet_user=$(conf_value "$conf_link" BIRDNET_USER)
[[ "$birdnet_user" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || { echo "Invalid BirdNET-Pi user" >&2; exit 1; }
passwd_row=$(getent passwd "$birdnet_user")
[ -n "$passwd_row" ] || { echo "BirdNET-Pi user does not exist" >&2; exit 1; }
birdnet_home=$(printf '%s\n' "$passwd_row" | cut -d: -f6)
birdnet_group=$(id -gn "$birdnet_user")
birdnet_gid=$(id -g "$birdnet_user")
if ! [[ "$birdnet_home" =~ ^/[A-Za-z0-9._/-]+$ \
  && "$birdnet_home" != *'..'* ]]; then
  echo "Invalid BirdNET-Pi home" >&2
  exit 1
fi
birdnet_home=$(readlink -f -- "$birdnet_home") \
  || { echo "BirdNET-Pi home was not found" >&2; exit 1; }
repo_dir=$birdnet_home/BirdNET-Pi
[ ! -L "$repo_dir" ] \
  || { echo "BirdNET-Pi checkout cannot be a symbolic link" >&2; exit 1; }
[ -d "$repo_dir/.git" ] || { echo "BirdNET-Pi checkout was not found" >&2; exit 1; }

run_as_birdnet() {
  /usr/sbin/runuser -u "$birdnet_user" -- \
    env -i HOME="$birdnet_home" USER="$birdnet_user" LOGNAME="$birdnet_user" \
    PATH=/usr/local/bin:/usr/bin:/bin "$@"
}

# Admin credential mutations share one root-only persistent lock. PHP reads
# the separately group-readable state only after atomic replacement.
auth_state_dir=/var/lib/avian-visitors
auth_lock=$auth_state_dir/admin-auth.lock
if [ -e "$auth_state_dir" ] || [ -L "$auth_state_dir" ]; then
  [ -d "$auth_state_dir" ] && [ ! -L "$auth_state_dir" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$auth_state_dir")" = '0:0:755' ] \
    || { echo "Unsafe admin state directory" >&2; exit 1; }
else
  install -d -o root -g root -m 0755 "$auth_state_dir"
fi
if [ ! -e "$auth_lock" ] && [ ! -L "$auth_lock" ]; then
  install -o root -g root -m 0600 /dev/null "$auth_lock"
fi
[ -f "$auth_lock" ] && [ ! -L "$auth_lock" ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- "$auth_lock")" = '0:0:600:1' ] \
  || { echo "Unsafe admin state lock" >&2; exit 1; }
# A separate fixed inode serializes heavyweight bundle exports without making
# the web process the owner of a replaceable lock path.
bundle_export_lock=/run/lock/avian-bundle-export.lock
generation_lock=/run/lock/avian-generation.lock
tmpfiles_dir=/etc/tmpfiles.d
lock_policy=$tmpfiles_dir/avian-bundle-locks.conf
if [ ! -e "$tmpfiles_dir" ] && [ ! -L "$tmpfiles_dir" ]; then
  install -d -o root -g root -m 0755 "$tmpfiles_dir"
fi
[ -d "$tmpfiles_dir" ] && [ ! -L "$tmpfiles_dir" ] \
  && [ "$(stat -c '%u:%g:%a' -- "$tmpfiles_dir")" = '0:0:755' ] \
  || { echo "Unsafe tmpfiles directory" >&2; exit 1; }
for coordination_lock in "$generation_lock" "$bundle_export_lock"; do
  if [ -e "$coordination_lock" ] || [ -L "$coordination_lock" ]; then
    [ -f "$coordination_lock" ] && [ ! -L "$coordination_lock" ] \
      && [ "$(stat -c '%u:%h' -- "$coordination_lock")" = '0:1' ] \
      || { echo "Unsafe Avian Visitors coordination lock" >&2; exit 1; }
    # Explicit account migration may update a verified live inode; boot may not.
    chgrp "$birdnet_gid" "$coordination_lock"
    chmod 0660 "$coordination_lock"
  fi
done
if [ -e "$lock_policy" ] || [ -L "$lock_policy" ]; then
  [ -f "$lock_policy" ] && [ ! -L "$lock_policy" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$lock_policy")" = '0:0:644:1' ] \
    || { echo "Unsafe Avian Visitors tmpfiles policy" >&2; exit 1; }
fi
lock_policy_temp=$(mktemp "$tmpfiles_dir/.avian-bundle-locks.XXXXXX")
if ! {
  printf 'f %s :0660 :root :%s -\n' "$generation_lock" "$birdnet_gid"
  printf 'f %s :0660 :root :%s -\n' "$bundle_export_lock" "$birdnet_gid"
} >"$lock_policy_temp" \
  || ! chown root:root "$lock_policy_temp" \
  || ! chmod 0644 "$lock_policy_temp" \
  || ! mv -fT -- "$lock_policy_temp" "$lock_policy"; then
  rm -f "$lock_policy_temp"
  echo "Could not install Avian Visitors tmpfiles policy" >&2
  exit 1
fi
/usr/bin/systemd-tmpfiles --create "$lock_policy" \
  || { echo "Could not apply Avian Visitors tmpfiles policy" >&2; exit 1; }
for coordination_lock in "$generation_lock" "$bundle_export_lock"; do
  [ "$(stat -c '%u:%g:%a:%h' -- "$coordination_lock")" = \
    "0:$birdnet_gid:660:1" ] \
    || { echo "Avian Visitors coordination lock policy failed" >&2; exit 1; }
done

install_bundle_export_pools

# SQLite journals belong in writable state, never beside executable PHP code.
image_cache_dir=$auth_state_dir/image-cache
if [ -e "$image_cache_dir" ] || [ -L "$image_cache_dir" ]; then
  [ -d "$image_cache_dir" ] && [ ! -L "$image_cache_dir" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$image_cache_dir")" = 'caddy:caddy:700' ] \
    || { echo "Unsafe image cache directory" >&2; exit 1; }
else
  install -d -o caddy -g caddy -m 0700 "$image_cache_dir"
fi

# Caddy and the station user may lock this inode, but only root can replace it.
# It serializes asynchronous illustration workers with checkout updates.
if [ ! -e "$generation_lock" ] && [ ! -L "$generation_lock" ]; then
  install -o root -g "$birdnet_gid" -m 0660 /dev/null "$generation_lock"
fi
if [ ! -f "$generation_lock" ] || [ -L "$generation_lock" ] \
  || [ "$(stat -c '%u:%g:%a:%h' "$generation_lock")" != "0:$birdnet_gid:660:1" ]; then
  echo "Unsafe illustration generation lock: $generation_lock" >&2
  exit 1
fi
if [ -e /proc/self/fd/8 ] \
  && [ "$(readlink -f /proc/self/fd/8)" = "$generation_lock" ]; then
  flock -n 8 || { echo "Illustration generation is running" >&2; exit 1; }
else
  exec 8<>"$generation_lock"
  flock -n 8 || { echo "Illustration generation is running" >&2; exit 1; }
fi

# Unlike the /run lock, this fixed inode survives reboot. It is invalid until
# a complete PNG scan and both geometry writes have reached disk.
art_revision_state=$auth_state_dir/included-art.revision
art_revision_needs_rebuild=0
invalid_art_revision=$(printf 'invalid%057d' 0 | tr 0 '!')
if [ ! -e "$art_revision_state" ] && [ ! -L "$art_revision_state" ]; then
  install -o root -g "$birdnet_gid" -m 0660 /dev/null "$art_revision_state"
  printf '%s\n' "$invalid_art_revision" \
    | dd of="$art_revision_state" bs=65 count=1 iflag=fullblock \
      conv=notrunc,fsync status=none
  truncate -s 65 "$art_revision_state"
  sync -f "$art_revision_state"
  art_revision_needs_rebuild=1
fi
if [ ! -f "$art_revision_state" ] || [ -L "$art_revision_state" ] \
  || [ "$(stat -c '%u:%g:%a:%h' "$art_revision_state")" != "0:$birdnet_gid:660:1" ]; then
  echo "Unsafe illustration revision state: $art_revision_state" >&2
  exit 1
fi
if [ "$(stat -c '%s' "$art_revision_state")" -ne 65 ] \
  || ! grep -Eq '^[0-9a-f]{64}$' "$art_revision_state"; then
  art_revision_needs_rebuild=1
fi

legacy_state_dir=$repo_dir/scripts
legacy_state_file=$legacy_state_dir/disk_check_exclude.txt
if [ ! -d "$legacy_state_dir" ] || [ -L "$legacy_state_dir" ] \
  || [ "$(readlink -f -- "$legacy_state_dir")" != "$legacy_state_dir" ]; then
  echo "Unsafe runtime directory: $legacy_state_dir" >&2
  exit 1
fi

# Older installers copied every non-comment config assignment, including API
# credentials, into this unused mode-0644 file. Remove only this exact obsolete
# path. A legacy link is unlinked without following it; a directory is unsafe
# and left untouched.
legacy_firstrun=$legacy_state_dir/firstrun.ini
remove_legacy_firstrun "$legacy_firstrun" \
  || { echo "Unsafe legacy first-run config copy: $legacy_firstrun" >&2; exit 1; }

# Pre-redaction diagnostic archives included the full BirdWeather token, and an
# interrupted run could leave the same config plus token-bearing service logs
# under logs/. Remove the exact disposable archive and config copy. Keep any
# other legacy logs recoverable, but close their directory to group and other;
# the restricted mode is re-applied after the checkout-wide permission pass.
legacy_log_archive=$repo_dir/logs.tar.gz
remove_exact_legacy_file "$legacy_log_archive" \
  || { echo "Unsafe legacy diagnostic archive: $legacy_log_archive" >&2; exit 1; }
legacy_log_dir=$repo_dir/logs
legacy_log_quarantine=0
if [ -e "$legacy_log_dir" ] || [ -L "$legacy_log_dir" ]; then
  if [ ! -d "$legacy_log_dir" ] || [ -L "$legacy_log_dir" ] \
    || [ "$(readlink -f -- "$legacy_log_dir")" != "$legacy_log_dir" ]; then
    echo "Unsafe legacy diagnostic directory: $legacy_log_dir" >&2
    exit 1
  fi
  # Pin the validated directory while removing the exact child. This prevents
  # a station-side rename from redirecting root through a replacement link.
  exec {legacy_log_fd}<"$legacy_log_dir" \
    || { echo "Could not open legacy diagnostic directory" >&2; exit 1; }
  legacy_log_fd_path=/proc/$$/fd/$legacy_log_fd
  if [ ! -d "$legacy_log_fd_path" ] \
    || [ "$(readlink -f -- "$legacy_log_fd_path")" != "$legacy_log_dir" ]; then
    exec {legacy_log_fd}<&-
    echo "Unsafe legacy diagnostic directory: $legacy_log_dir" >&2
    exit 1
  fi
  legacy_log_config=$legacy_log_fd_path/birdnet.conf
  remove_exact_legacy_file "$legacy_log_config" \
    || { exec {legacy_log_fd}<&-; echo "Unsafe legacy diagnostic config: $legacy_log_dir/birdnet.conf" >&2; exit 1; }
  exec {legacy_log_fd}<&-
  legacy_log_quarantine=1
fi

legacy_state_file_is_safe() {
  [ -f "$legacy_state_file" ] && [ ! -L "$legacy_state_file" ] \
    && [ "$(readlink -f -- "$legacy_state_file")" = "$legacy_state_file" ] \
    && [ "$(stat -c '%h' -- "$legacy_state_file")" -eq 1 ]
}
if { [ -e "$legacy_state_file" ] || [ -L "$legacy_state_file" ]; } \
  && ! legacy_state_file_is_safe; then
  echo "Unsafe runtime file: $legacy_state_file" >&2
  exit 1
fi

conf_path=$(readlink -f -- "$conf_link") \
  || { echo "BirdNET-Pi config path is not safe" >&2; exit 1; }
case "$conf_path" in
  "$repo_dir/birdnet.conf"|/etc/birdnet/birdnet.conf) ;;
  *) echo "BirdNET-Pi config path is not safe" >&2; exit 1 ;;
esac
if [ ! -f "$conf_path" ] || [ -L "$conf_path" ]; then
  echo "BirdNET-Pi config is not a regular file" >&2
  exit 1
fi

# Root never follows a station-controlled runtime symlink while changing
# ownership or permissions. These are the only paths made writable to Caddy.
for runtime_dir in \
  "$repo_dir/avian/assets/illustrations" \
  "$repo_dir/avian/assets/references"; do
  if [ -e "$runtime_dir" ] || [ -L "$runtime_dir" ]; then
    if [ ! -d "$runtime_dir" ] || [ -L "$runtime_dir" ] \
      || [ "$(readlink -f -- "$runtime_dir")" != "$runtime_dir" ]; then
      echo "Unsafe runtime directory: $runtime_dir" >&2
      exit 1
    fi
  fi
done
for runtime_file in \
  "$repo_dir/avian/frontend/dims.json" \
  "$repo_dir/avian/frontend/masks.json"; do
  if [ -e "$runtime_file" ] || [ -L "$runtime_file" ]; then
    if [ ! -f "$runtime_file" ] || [ -L "$runtime_file" ] \
      || [ "$(readlink -f -- "$runtime_file")" != "$runtime_file" ]; then
      echo "Unsafe runtime file: $runtime_file" >&2
      exit 1
    fi
  fi
done

# A pre-bundle service refresher can install this security helper while its old
# process is still running. Re-enter the newly verified refresher once, under
# the inherited update lock when present, to install and initialize the bundle
# helper before validating the final privilege boundary.
bundle_marker=/var/lib/avian-visitors/bundles-v1.enabled
if [ ! -e "$bundle_marker" ] && [ ! -L "$bundle_marker" ]; then
  service_refresh=/usr/local/sbin/avian-service-refresh
  [ -f "$service_refresh" ] && [ ! -L "$service_refresh" ] \
    && [ -x "$service_refresh" ] \
    && [ "$(stat -c '%u:%g:%a' "$service_refresh")" = 0:0:755 ] \
    || { echo "Unsafe or missing helper: $service_refresh" >&2; exit 1; }
  update_lock=/run/lock/avian-update.lock
  if [ -e /proc/self/fd/9 ] \
    && [ "$(readlink -f /proc/self/fd/9)" = "$update_lock" ]; then
    AVIAN_UPDATE_LOCK_FD=9 "$service_refresh" --bundle-bootstrap
  else
    "$service_refresh" --bundle-bootstrap
  fi
fi

for helper in \
  /usr/local/sbin/avian-admin-control \
  /usr/local/sbin/avian-archive-control \
  /usr/local/sbin/avian-maintenance-control \
  /usr/local/sbin/avian-update-control \
  /usr/local/sbin/avian-service-refresh \
  /usr/local/sbin/avian-generation-runtime \
  /usr/local/sbin/avian-caddy-refresh \
  /usr/local/sbin/avian-link-webroot \
  /usr/local/sbin/avian-bundle-control \
  /usr/local/bin/avian-bundle; do
  if [ ! -f "$helper" ] || [ ! -x "$helper" ] \
    || [ "$(stat -c '%U:%G:%a' "$helper")" != root:root:755 ]; then
    echo "Unsafe or missing helper: $helper" >&2
    exit 1
  fi
done

# Caddy must not expose mutable included artwork until the ephemeral /run lock
# has been recreated and any durable invalid journal has been rebuilt. Install
# root-owned units without embedding a station-controlled path or group name.
generation_unit=/etc/systemd/system/avian-generation-runtime.service
generation_unit_temp=$(mktemp /etc/systemd/system/.avian-generation-runtime.XXXXXX)
cat >"$generation_unit_temp" <<'EOF'
[Unit]
Description=AvianVisitors illustration runtime recovery
After=local-fs.target
Before=caddy.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/avian-generation-runtime

[Install]
WantedBy=multi-user.target
EOF
chown root:root "$generation_unit_temp"
chmod 0644 "$generation_unit_temp"
mv -fT "$generation_unit_temp" "$generation_unit"
sync -f "$generation_unit"

generation_dropin_dir=/etc/systemd/system/caddy.service.d
if [ -e "$generation_dropin_dir" ] || [ -L "$generation_dropin_dir" ]; then
  [ -d "$generation_dropin_dir" ] && [ ! -L "$generation_dropin_dir" ] \
    && [ "$(stat -c '%u:%g:%a' "$generation_dropin_dir")" = 0:0:755 ] \
    || { echo "Unsafe Caddy service drop-in directory" >&2; exit 1; }
else
  install -d -o root -g root -m 0755 "$generation_dropin_dir"
fi
generation_dropin=$generation_dropin_dir/20-avian-generation-runtime.conf
generation_dropin_temp=$(mktemp "$generation_dropin_dir/.avian-generation-runtime.XXXXXX")
cat >"$generation_dropin_temp" <<'EOF'
[Unit]
Requires=avian-generation-runtime.service
After=avian-generation-runtime.service
EOF
chown root:root "$generation_dropin_temp"
chmod 0644 "$generation_dropin_temp"
mv -fT "$generation_dropin_temp" "$generation_dropin"
sync -f "$generation_dropin"

bundle_sandbox_row=$(getent passwd avian-bundle) \
  || { echo "Missing bundle image sandbox account" >&2; exit 1; }
IFS=: read -r _ _ bundle_sandbox_uid bundle_sandbox_gid _ bundle_sandbox_home bundle_sandbox_shell \
  <<<"$bundle_sandbox_row"
bundle_sandbox_group_row=$(getent group avian-bundle) \
  || { echo "Missing bundle image sandbox group" >&2; exit 1; }
IFS=: read -r _ _ bundle_sandbox_group_gid bundle_sandbox_group_members \
  <<<"$bundle_sandbox_group_row"
bundle_sandbox_groups=$(id -G avian-bundle)
[ "$bundle_sandbox_uid" != 0 ] && [ "$bundle_sandbox_gid" != 0 ] \
  && [ "$bundle_sandbox_home" = /nonexistent ] \
  && [ "$bundle_sandbox_shell" = /usr/sbin/nologin ] \
  && [ "$bundle_sandbox_group_gid" = "$bundle_sandbox_gid" ] \
  && [ -z "$bundle_sandbox_group_members" ] \
  && [ "$bundle_sandbox_groups" = "$bundle_sandbox_gid" ] \
  || { echo "Unsafe bundle image sandbox account" >&2; exit 1; }
for bundle_sandbox_path in /var/empty /var/empty/avian-bundle; do
  bundle_sandbox_mode=755
  [ "$bundle_sandbox_path" != /var/empty/avian-bundle ] || bundle_sandbox_mode=555
  [ -d "$bundle_sandbox_path" ] && [ ! -L "$bundle_sandbox_path" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$bundle_sandbox_path")" = "0:0:$bundle_sandbox_mode" ] \
    || { echo "Unsafe bundle image sandbox root" >&2; exit 1; }
done

bundle_catalog=/usr/share/avian-visitors/bundles/catalog-v1.json
bundle_root=/var/lib/avian-visitors/bundles
bundle_lock=$bundle_root/operation.lock
[ -f "$bundle_catalog" ] && [ ! -L "$bundle_catalog" ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- "$bundle_catalog")" = '0:0:644:1' ] \
  || { echo "Unsafe or missing bundle catalog" >&2; exit 1; }
[ -f "$bundle_marker" ] && [ ! -L "$bundle_marker" ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- "$bundle_marker")" = '0:0:644:1' ] \
  || { echo "Unsafe or missing bundle provisioning marker" >&2; exit 1; }
for bundle_directory in \
  "$bundle_root" \
  "$bundle_root/objects" \
  "$bundle_root/objects/sha256" \
  "$bundle_root/packs" \
  "$bundle_root/staging"; do
  [ -d "$bundle_directory" ] && [ ! -L "$bundle_directory" ] \
    && [ "$(stat -c '%u:%g:%a' -- "$bundle_directory")" = '0:0:755' ] \
    || { echo "Unsafe bundle storage directory: $bundle_directory" >&2; exit 1; }
done
[ -f "$bundle_lock" ] && [ ! -L "$bundle_lock" ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- "$bundle_lock")" = '0:0:600:1' ] \
  || { echo "Unsafe bundle operation lock" >&2; exit 1; }
[ -f "$bundle_root/active.json" ] && [ ! -L "$bundle_root/active.json" ] \
  && [ "$(stat -c '%u:%g:%a:%h' -- "$bundle_root/active.json")" = '0:0:644:1' ] \
  || { echo "Unsafe active bundle state" >&2; exit 1; }

educator_helper=/usr/local/sbin/avian-educators
if [ ! -e "$educator_helper" ] && [ ! -L "$educator_helper" ]; then
  update_lock=/run/lock/avian-update.lock
  if [ ! -e /proc/self/fd/9 ] \
    || [ "$(readlink -f /proc/self/fd/9)" != "$update_lock" ]; then
    echo "Missing Educators helper cannot be bootstrapped outside an update" >&2
    exit 1
  fi
  AVIAN_UPDATE_LOCK_FD=9 \
    /usr/local/sbin/avian-service-refresh --helper-bootstrap \
    || { echo "Educators helper bootstrap failed" >&2; exit 1; }
fi
if [ ! -f "$educator_helper" ] || [ -L "$educator_helper" ] \
  || [ ! -x "$educator_helper" ] \
  || [ "$(stat -c '%U:%G:%a' "$educator_helper")" != root:root:755 ]; then
  echo "Unsafe or missing helper: $educator_helper" >&2
  exit 1
fi

# Only the root install/update path may claim an absent state from the legacy
# CADDY_PWD value. Existing state is authoritative and is never resynced here.
if ! admin_init_output=$(/usr/local/sbin/avian-admin-control auth-state-init); then
  printf '%s\n' "$admin_init_output" >&2
  exit 1
fi
if ! educator_recovery_output=$(/usr/local/sbin/avian-educators install-recovery-unit); then
  printf '%s\n' "$educator_recovery_output" >&2
  exit 1
fi
if ! educator_init_output=$(/usr/local/sbin/avian-educators refresh-install); then
  printf '%s\n' "$educator_init_output" >&2
  exit 1
fi

# A running pre-patch service refresher keeps reading its old inode after it
# atomically installs the new helpers. It does invoke this newly installed
# security helper, so use that guaranteed first-hop hook to apply the focused
# live stream policy immediately. The audio-only path exits before calling
# back into security refresh and therefore cannot recurse.
update_lock=/run/lock/avian-update.lock
if [ -e /proc/self/fd/9 ] \
  && [ "$(readlink -f /proc/self/fd/9)" = "$update_lock" ]; then
  AVIAN_UPDATE_LOCK_FD=9 \
    /usr/local/sbin/avian-service-refresh --audio-policy
else
  /usr/local/sbin/avian-service-refresh --audio-policy
fi

sudoers_temp=$(mktemp /etc/sudoers.d/.020_avian-admin.XXXXXX)
trap 'rm -f "${sudoers_temp-}"' EXIT
cat >"$sudoers_temp" <<'EOF'
# AvianVisitors web actions terminate in root-owned, argument-validating helpers.
caddy ALL=(root) NOPASSWD: /usr/local/sbin/avian-admin-control *, \
    /usr/local/sbin/avian-archive-control status, \
    /usr/local/sbin/avian-archive-control install, \
    /usr/local/sbin/avian-archive-control enable, \
    /usr/local/sbin/avian-archive-control disable, \
    /usr/local/sbin/avian-archive-control run, \
    /usr/local/sbin/avian-archive-control purge-on, \
    /usr/local/sbin/avian-archive-control purge-off, \
    /usr/local/sbin/avian-maintenance-control status, \
    /usr/local/sbin/avian-maintenance-control update, \
    /usr/local/sbin/avian-maintenance-control services, \
    /usr/local/sbin/avian-bundle-control *
EOF
chmod 0440 "$sudoers_temp"
visudo -cf "$sudoers_temp" >/dev/null
install -o root -g root -m 0440 "$sudoers_temp" /etc/sudoers.d/020_avian-admin
visudo -cf /etc/sudoers >/dev/null

# Sudo rules are additive. Retire the inherited unrestricted rule only after
# the replacement policy has parsed successfully.
rm -f /etc/sudoers.d/010_caddy-nopasswd
visudo -cf /etc/sudoers >/dev/null
if ! sudo_policy=$(sudo -n -l -U caddy 2>&1); then
  echo "Could not inspect the Caddy sudo policy" >&2
  exit 1
fi
if grep -Eq 'NOPASSWD:.*[[:space:],]ALL([[:space:],]|$)' <<<"$sudo_policy"; then
  echo "An unrestricted Caddy sudo rule is still installed" >&2
  exit 1
fi

# The station owns the checkout. Its group, which Caddy joins on a standard
# install, receives read and traverse access but no ability to replace code.
chown -hR "$birdnet_user:$birdnet_group" "$repo_dir"
chmod -R u+rwX,g+rX,o-w "$repo_dir"
find "$repo_dir" -xdev -type d -exec chmod g-w {} +
find "$repo_dir" -xdev -type f -exec chmod g-w {} +

if [ "$legacy_log_quarantine" = 1 ]; then
  if [ ! -d "$legacy_log_dir" ] || [ -L "$legacy_log_dir" ] \
    || [ "$(readlink -f -- "$legacy_log_dir")" != "$legacy_log_dir" ]; then
    echo "Unsafe legacy diagnostic directory: $legacy_log_dir" >&2
    exit 1
  fi
  exec {legacy_log_fd}<"$legacy_log_dir" \
    || { echo "Could not reopen legacy diagnostic directory" >&2; exit 1; }
  legacy_log_fd_path=/proc/$$/fd/$legacy_log_fd
  if [ ! -d "$legacy_log_fd_path" ] \
    || [ "$(readlink -f -- "$legacy_log_fd_path")" != "$legacy_log_dir" ]; then
    exec {legacy_log_fd}<&-
    echo "Unsafe legacy diagnostic directory: $legacy_log_dir" >&2
    exit 1
  fi
  chmod 0700 -- "$legacy_log_fd_path"
  exec {legacy_log_fd}<&-
fi

chown "$birdnet_user:$birdnet_group" "$conf_path"
chmod 0640 "$conf_path"

# The on-station illustrator writes images and its two generated indexes, not
# executable code. Caddy is denied PHP execution beneath these image paths by
# the generated Caddy configuration.
runtime_group=$birdnet_group
getent group caddy >/dev/null 2>&1 && runtime_group=caddy

# BirdNET-Pi's cleanup job requires this marker file, and its recording page
# stores manual protect/unprotect choices in it. It is fixed-string grep data,
# never executable input. Keep only this file writable while its parent
# directory and every neighboring script remain read-only to Caddy.
if [ ! -e "$legacy_state_file" ] && [ ! -L "$legacy_state_file" ]; then
  if ! (set -o noclobber; printf '##start\n##end\n' >"$legacy_state_file"); then
    echo "Could not create runtime file: $legacy_state_file" >&2
    exit 1
  fi
fi
if ! legacy_state_file_is_safe; then
  echo "Unsafe runtime file: $legacy_state_file" >&2
  exit 1
fi
chown "$birdnet_user:$runtime_group" "$legacy_state_file"
chmod 0660 "$legacy_state_file"

for runtime_dir in \
  "$repo_dir/avian/assets/illustrations" \
  "$repo_dir/avian/assets/references"; do
  [ -d "$runtime_dir" ] || continue
  chown -hR "$birdnet_user:$runtime_group" "$runtime_dir"
  chmod -R u+rwX,g+rwX,o-w "$runtime_dir"
done
for runtime_file in \
  "$repo_dir/avian/frontend/dims.json" \
  "$repo_dir/avian/frontend/masks.json"; do
  [ -f "$runtime_file" ] || continue
  chown "$birdnet_user:$runtime_group" "$runtime_file"
  chmod 0660 "$runtime_file"
done

if [ "$art_revision_needs_rebuild" -eq 1 ]; then
  mask_builder=$repo_dir/avian/scripts/build_masks.py
  [ -f "$mask_builder" ] && [ ! -L "$mask_builder" ] \
    || { echo "Illustration inventory builder is missing" >&2; exit 1; }
  run_as_birdnet env \
    AVIAN_GENERATION_LOCK="$generation_lock" \
    AVIAN_GENERATION_LOCK_FD=8 \
    AVIAN_ART_REVISION_STATE="$art_revision_state" \
    PYTHONDONTWRITEBYTECODE=1 \
    /usr/bin/python3 "$mask_builder" \
    || { echo "Could not rebuild the illustration inventory" >&2; exit 1; }
  [ "$(stat -c '%s' "$art_revision_state")" -eq 65 ] \
    && grep -Eq '^[0-9a-f]{64}$' "$art_revision_state" \
    || { echo "Illustration revision state was not committed" >&2; exit 1; }
fi

# A recovery build may have recreated a missing table under this script's
# restrictive umask. Normalize only these two exact generated files while the
# generation lock is still exclusive, after which PHP's 0660 reader policy is
# immediately usable on the first refresh.
for runtime_file in \
  "$repo_dir/avian/frontend/dims.json" \
  "$repo_dir/avian/frontend/masks.json"; do
  [ -f "$runtime_file" ] && [ ! -L "$runtime_file" ] \
    || { echo "Illustration inventory table is missing: $runtime_file" >&2; exit 1; }
  chown "$birdnet_user:$runtime_group" "$runtime_file"
  chmod 0660 "$runtime_file"
  sync -f "$runtime_file"
done
sync -f "$repo_dir/avian/frontend"

rm -f "$sudoers_temp"
trap - EXIT
echo "security refresh: ok"
