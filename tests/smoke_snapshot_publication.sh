#!/usr/bin/env bash
# Disposable container only; mount /var/tmp on a separate filesystem.
set -euo pipefail
[[ -f /.dockerenv && ${EUID:-$(id -u)} = 0 ]] || { echo 'container root required' >&2; exit 1; }
[[ $(stat -c %d /var/tmp) != $(stat -c %d /var/lib) ]] || { echo 'separate /var/tmp filesystem required' >&2; exit 1; }
case "${1:-}" in bootstrap|refresh) mode=$1 ;; *) exit 64 ;; esac
fixture=$(mktemp -d /tmp/avian-snapshot-test.XXXXXX)
chmod 0755 "$fixture"
station_user=birdsnapshot
station_home=$fixture/home
repo=$station_home/BirdNET-Pi
mkdir -p "$repo/scripts" /etc/birdnet /usr/local/sbin /usr/local/bin
useradd -M -d "$station_home" -s /bin/bash "$station_user"
sources=(update_birdnet reinstall_services maintenance_control archive_control security_refresh admin_control link_webroot update_caddyfile educators_control)
for source in "${sources[@]}"; do
  cp "/source/scripts/$source.sh" "$repo/scripts/$source.sh"
done
# Stop bootstrap at its handoff; applying a release is tested by the recovery smokes.
printf '#!/usr/bin/env bash\nexit 0\n' >"$repo/scripts/update_birdnet.sh"
git -C "$repo" init -q -b avian-visitors
git -C "$repo" -c user.name=test -c user.email=test@example.test add .
git -C "$repo" -c user.name=test -c user.email=test@example.test commit -qm fixture
release=$(git -C "$repo" rev-parse HEAD)
git clone -q --bare "$repo" "$fixture/official.git"
chmod -R a+rX "$fixture/official.git"
official=https://github.com/Twarner491/AvianVisitors.git
git -C "$repo" remote add origin "$official"
chown -R "$station_user:$station_user" "$station_home"
printf '[url "file://%s/official.git"]\n insteadOf = %s\n' "$fixture" "$official" >/etc/gitconfig
printf 'BIRDNET_USER=%s\n' "$station_user" >/etc/birdnet/birdnet.conf
install -o root -g root -m 0755 /source/scripts/reinstall_services.sh /usr/local/sbin/avian-service-refresh
cat >/usr/local/bin/mv <<'EOF'
#!/usr/bin/env bash
destination=${!#}
if [ "$destination" = /var/lib/avian-update-prepared ]; then
  source=$1
  [ "$(stat -c '%u:%g:%a' "$source")" = 0:0:700 ] || exit 85
  if [ "$(stat -c %d "$source")" != "$(stat -c %d /var/lib)" ]; then
    echo CROSS_DEVICE_PUBLICATION >&2
    exit 86
  fi
  if [ -e /tmp/avian-stop-snapshot-rename ]; then
    echo INTERRUPTED_BEFORE_RENAME >&2
    kill -TERM "$PPID"
    exit 73
  fi
fi
exec /usr/bin/mv "$@"
EOF
chmod 0755 /usr/local/bin/mv
invoke() {
  if [ "$mode" = bootstrap ]; then
    bash /source/scripts/bootstrap_v1.sh
  else
    /usr/local/sbin/avian-service-refresh --prepare-update "$release"
  fi
}
touch /tmp/avian-stop-snapshot-rename
if invoke >"$fixture/interrupted.log" 2>&1; then
  echo 'interrupted publication reported success' >&2; exit 1
fi
cat "$fixture/interrupted.log"
grep -q INTERRUPTED_BEFORE_RENAME "$fixture/interrupted.log" || { echo 'did not reach same-filesystem rename' >&2; exit 1; }
[ ! -e /var/lib/avian-update-prepared ] || { echo 'partial pending state exposed' >&2; exit 1; }
if find /var/lib -maxdepth 1 -name '.avian-update-prepared.*' -print -quit | grep -q .; then
  echo 'invocation staging was not cleaned after interruption' >&2; exit 1
fi
rm /tmp/avian-stop-snapshot-rename
invoke >"$fixture/retry.log" 2>&1 || { cat "$fixture/retry.log"; exit 1; }
prepared=/var/lib/avian-update-prepared
[ "$(cat "$prepared/release")" = "$release" ]
[ "$(stat -c '%u:%g:%a' "$prepared")" = 0:0:700 ]
(cd "$prepared" && sha256sum -c manifest)
before=$(cd "$prepared" && sha256sum *)
touch /tmp/avian-stop-snapshot-rename
invoke >"$fixture/resume.log" 2>&1 || { cat "$fixture/resume.log"; exit 1; }
[ "$before" = "$(cd "$prepared" && sha256sum *)" ] || { echo 'pending snapshot changed on retry' >&2; exit 1; }
echo "snapshot publication $mode: ok"
