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
# Caddy and the station user may lock this inode, but only root can replace it.
# It serializes asynchronous illustration workers with checkout updates.
generation_lock=/run/lock/avian-generation.lock
if [ ! -e "$generation_lock" ] && [ ! -L "$generation_lock" ]; then
  install -o root -g "$birdnet_gid" -m 0660 /dev/null "$generation_lock"
fi
if [ ! -f "$generation_lock" ] || [ -L "$generation_lock" ] \
  || [ "$(stat -c '%u:%g:%a:%h' "$generation_lock")" != "0:$birdnet_gid:660:1" ]; then
  echo "Unsafe illustration generation lock: $generation_lock" >&2
  exit 1
fi

# /run is cleared at boot. Keep the policy root-owned and preserve the live
# lock inode when refreshing an existing installation.
tmpfiles_dir=/etc/tmpfiles.d
generation_policy=$tmpfiles_dir/avian-generation.conf
if [ ! -e "$tmpfiles_dir" ] && [ ! -L "$tmpfiles_dir" ]; then
  install -d -o root -g root -m 0755 "$tmpfiles_dir"
fi
[ -d "$tmpfiles_dir" ] && [ ! -L "$tmpfiles_dir" ] \
  && [ "$(stat -c '%u:%g:%a' -- "$tmpfiles_dir")" = '0:0:755' ] \
  || { echo "Unsafe tmpfiles directory" >&2; exit 1; }
if [ -e "$generation_policy" ] || [ -L "$generation_policy" ]; then
  [ -f "$generation_policy" ] && [ ! -L "$generation_policy" ] \
    && [ "$(stat -c '%u:%g:%a:%h' -- "$generation_policy")" = '0:0:644:1' ] \
    || { echo "Unsafe generation tmpfiles policy" >&2; exit 1; }
fi
generation_policy_temp=$(mktemp "$tmpfiles_dir/.avian-generation.XXXXXX")
# Create-only metadata must not chmod/chown a preexisting hard-linked inode.
printf 'f /run/lock/avian-generation.lock :0660 :root :%s -\n' "$birdnet_gid" \
  >"$generation_policy_temp"
chmod 0644 "$generation_policy_temp"
mv -fT -- "$generation_policy_temp" "$generation_policy"

# SQLite needs a writable directory for its journal, not writable PHP code.
image_cache_dir=$auth_state_dir/image-cache
if [ -e "$image_cache_dir" ] || [ -L "$image_cache_dir" ]; then
  [ -d "$image_cache_dir" ] && [ ! -L "$image_cache_dir" ] \
    && [ "$(stat -c '%U:%G:%a' -- "$image_cache_dir")" = 'caddy:caddy:700' ] \
    || { echo "Unsafe image cache directory" >&2; exit 1; }
else
  install -d -o caddy -g caddy -m 0700 "$image_cache_dir"
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

for helper in \
  /usr/local/sbin/avian-admin-control \
  /usr/local/sbin/avian-archive-control \
  /usr/local/sbin/avian-maintenance-control \
  /usr/local/sbin/avian-update-control \
  /usr/local/sbin/avian-service-refresh \
  /usr/local/sbin/avian-caddy-refresh \
  /usr/local/sbin/avian-link-webroot; do
  if [ ! -f "$helper" ] || [ ! -x "$helper" ] \
    || [ "$(stat -c '%U:%G:%a' "$helper")" != root:root:755 ]; then
    echo "Unsafe or missing helper: $helper" >&2
    exit 1
  fi
done

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
    /usr/local/sbin/avian-maintenance-control services
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

rm -f "$sudoers_temp"
trap - EXIT
echo "security refresh: ok"
