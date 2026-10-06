#!/usr/bin/env bash
# Exercise the three real policy writers only in a disposable Linux container.
set -euo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }
[ -f /.dockerenv ] && [ "${AVIAN_COORDINATION_POLICY_TEST:-0}" = 1 ] \
  && [ "$EUID" = 0 ] || fail 'refusing coordination policy smoke without container root and opt-in'

fixture=$(mktemp -d /tmp/avian-coordination-policy.XXXXXX)
station_gid=$(id -g nobody)
for writer in install_services reinstall_services security_refresh; do
  root=$fixture/$writer
  mkdir -p "$root/policies" "$root/locks"
  chmod 0755 "$root/policies"
  script=$root/writer.sh
  {
    printf '%s\n' 'set -euo pipefail' 'die() { echo "$*" >&2; exit 1; }'
    printf 'USER=nobody\nstation_gid=%s\nbirdnet_gid=%s\n' "$station_gid" "$station_gid"
    printf 'GENERATION_LOCK=%q\nBUNDLE_EXPORT_LOCK=%q\nBUNDLE_LOCK_POLICY=%q\n' \
      "$root/locks/avian-generation.lock" "$root/locks/avian-bundle-export.lock" \
      "$root/policies/avian-bundle-locks.conf"
    printf 'tmpfile=%q\npolicy_writer() {\n' "$root/staging"
    case "$writer" in
      install_services)
        awk '/^  station_gid=\$\(id -g / { active=1 }
          active && /^  auth_state_dir=/ { exit }
          active { print }' /source/scripts/install_services.sh ;;
      reinstall_services)
        awk '/^for coordination_lock in / { active=1 }
          active && /^run_as_station\(\)/ { exit }
          active { print }' /source/scripts/reinstall_services.sh ;;
      security_refresh)
        awk '/^bundle_export_lock=/ { active=1 }
          active && /^install_bundle_export_pools$/ { exit }
          active { print }' /source/scripts/security_refresh.sh ;;
    esac | sed "s|/etc/tmpfiles.d|$root/policies|g;s|/run/lock|$root/locks|g"
    printf '}\npolicy_writer\n'
  } >"$script"

  for lock in avian-generation.lock avian-bundle-export.lock; do
    install -o root -g root -m 0600 /dev/null "$root/locks/$lock"
  done
  inode=$(stat -c '%i' "$root/locks/avian-generation.lock")
  bash "$script"
  [ "$(stat -c '%i' "$root/locks/avian-generation.lock")" = "$inode" ] \
    || fail "$writer replaced an existing lock inode"
  for lock in avian-generation.lock avian-bundle-export.lock; do
    [ "$(stat -c '%u:%g:%a:%h' "$root/locks/$lock")" = "0:$station_gid:660:1" ] \
      || fail "$writer did not preserve station-group migration"
  done
  policy=$root/policies/avian-bundle-locks.conf
  [ "$(stat -c '%u:%g:%a:%h' "$policy")" = '0:0:644:1' ] \
    || fail "$writer installed unsafe policy metadata"
  for lock in avian-generation.lock avian-bundle-export.lock; do
    sentinel=$root/$lock.sentinel
    printf 'untouched\n' >"$sentinel"
    chmod 0600 "$sentinel"
    rm -- "$root/locks/$lock"
    ln "$sentinel" "$root/locks/$lock"
    systemd-tmpfiles --create "$policy"
    [ "$(stat -c '%u:%g:%a' "$sentinel")" = '0:0:600' ] \
      || fail "$writer boot policy changed a hard-linked target"
    if bash "$script" >/dev/null 2>&1; then
      fail "$writer accepted a hard-linked lock"
    fi
    rm -- "$root/locks/$lock"
    systemd-tmpfiles --create "$policy"
    [ "$(stat -c '%u:%g:%a:%h' "$root/locks/$lock")" = "0:$station_gid:660:1" ] \
      || fail "$writer boot policy failed to recreate the lock"
  done
  chmod 0777 "$root/policies"
  if bash "$script" >/dev/null 2>&1; then
    fail "$writer accepted a writable policy directory"
  fi
  chmod 0755 "$root/policies"
  mv "$root/policies" "$root/policies.saved"
  ln -s "$root/policies.saved" "$root/policies"
  if bash "$script" >/dev/null 2>&1; then
    fail "$writer accepted a symlinked policy directory"
  fi
done
echo 'coordination policy smoke: ok'
