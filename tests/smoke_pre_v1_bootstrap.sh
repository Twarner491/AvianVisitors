#!/usr/bin/env bash
# Run as root in the disposable Debian release container. This starts with
# the updater currently shipped before v1, then proves its handoff into the
# new root-owned service and security refreshers.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  [ ! -f "$test_root/update.log" ] || sed -n '1,240p' "$test_root/update.log" >&2
  exit 1
}

[ "${EUID:-$(id -u)}" -eq 0 ] || fail 'run this smoke test as root'

test_root=/tmp/avian-pre-v1-bootstrap
station_user=birdbootstrap
station_home=/home/$station_user
seed=$test_root/seed
repo=$station_home/BirdNET-Pi
remote=$test_root/official.git
webroot=$station_home/BirdSongs/Extracted
official=https://github.com/Twarner491/AvianVisitors.git
old_release=4515065dd38a3f5e4c244398d30a6f872384cb87

rm -rf "$test_root" "$station_home"
mkdir -p "$seed/scripts" "$seed/avian/frontend/fonts" \
  "$seed/avian/frontend/assets" "$seed/avian/assets/illustrations" \
  "$seed/avian/assets/cutouts" "$webroot" \
  /etc/birdnet /etc/sudoers.d /usr/local/bin /usr/local/sbin
id "$station_user" >/dev/null 2>&1 \
  || useradd -M -d "$station_home" -s /bin/bash "$station_user"
id caddy >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin caddy

git -c safe.directory=/source -C /source \
  show "$old_release:scripts/update_birdnet.sh" >"$seed/scripts/update_birdnet.sh" \
  || fail 'pre-v1 updater fixture is unavailable'
cat >"$seed/scripts/pre_update.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
printf 'pre-v1\n' >"$seed/version.txt"
chmod 0755 "$seed/scripts/"*.sh

git -C "$seed" init -q -b main
git -C "$seed" config user.name 'Bootstrap smoke'
git -C "$seed" config user.email bootstrap@example.test
git -C "$seed" add .
git -C "$seed" commit -qm 'pre-v1 station'
git -C "$seed" switch -qc avian-visitors

for script in \
  admin_control.sh archive_control.sh link_webroot.sh maintenance_control.sh \
  reinstall_services.sh security_refresh.sh update_birdnet.sh \
  update_birdnet_snippets.sh; do
  cp "/source/scripts/$script" "$seed/scripts/$script"
done
cat >"$seed/scripts/update_caddyfile.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
touch /tmp/avian-pre-v1-bootstrap/caddy.called
EOF
for frontend_file in \
  index.html styles.css apt.js masks.json dims.json nest.webp nest-eggs.webp \
  stamps.css stamps.js stamp-batch-root.css stamp-batch-root.js \
  stamp-batch-a.css stamp-batch-a.js stamp-batch-b.css stamp-batch-b.js \
  stamp-batch-c.css stamp-batch-c.js grain.png stats-press.png; do
  printf '%s\n' "$frontend_file" >"$seed/avian/frontend/$frontend_file"
done
printf '{"shared-bird":{"w":1,"h":1,"bits":"AA=="}}\n' \
  >"$seed/avian/frontend/masks.json"
printf '{"shared-bird":[1,1]}\n' >"$seed/avian/frontend/dims.json"
printf 'official shared bird\n' \
  >"$seed/avian/assets/illustrations/shared-bird.png"
printf 'fixture\n' >"$seed/avian/frontend/fonts/.keep"
printf 'fixture\n' >"$seed/avian/frontend/assets/.keep"
printf 'favicon\n' >"$seed/avian/assets/favicon.png"
printf 'v1\n' >"$seed/version.txt"
chmod 0755 "$seed/scripts/"*.sh
git -C "$seed" add .
git -C "$seed" commit -qm 'v1 release fixture'
release_head=$(git -C "$seed" rev-parse HEAD)

git clone -q --bare "$seed" "$remote"
git -C "$remote" symbolic-ref HEAD refs/heads/main
chmod -R a+rX "$remote"
cat >/etc/gitconfig <<EOF
[url "file://$remote"]
    insteadOf = $official
[safe]
    directory = $remote
EOF

mkdir -p "$station_home"
chown "$station_user:$station_user" "$station_home"
runuser -u "$station_user" -- env HOME="$station_home" \
  git clone -q "$remote" "$repo"
runuser -u "$station_user" -- env HOME="$station_home" \
  git -C "$repo" remote set-url origin "$official"
runuser -u "$station_user" -- env HOME="$station_home" \
  git -C "$repo" switch -q main
printf 'local tracked edit\n' >"$repo/version.txt"
printf 'keep local note\n' >"$repo/local-note.txt"
chown -R "$station_user:$station_user" "$station_home"

if [ -L /etc/birdnet/birdnet.conf ]; then
  unlink /etc/birdnet/birdnet.conf
fi
cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=$station_user
EXTRACTED=$webroot
AUTOMATIC_UPDATE=0
CADDY_PWD=
EOF

cat >/etc/sudoers.d/avian-bootstrap-test <<EOF
$station_user ALL=(ALL) NOPASSWD: ALL
EOF
chmod 0440 /etc/sudoers.d/avian-bootstrap-test
visudo -cf /etc/sudoers.d/avian-bootstrap-test >/dev/null
printf 'caddy ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/010_caddy-nopasswd
chmod 0440 /etc/sudoers.d/010_caddy-nopasswd

cat >/usr/local/bin/systemctl <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>/tmp/avian-pre-v1-bootstrap/systemctl.log
exit 0
EOF
cat >/usr/local/bin/mktemp <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
  case "$argument" in
    /tmp/avian-v1-bootstrap.*|/tmp/avian-service-refresh.*)
      echo 'large verified fetch attempted to use /tmp' >&2
      exit 88
      ;;
  esac
done
printf '%s\n' "$*" >>/tmp/avian-pre-v1-bootstrap/mktemp.log
exec /usr/bin/mktemp "$@"
EOF
chmod 0755 /usr/local/bin/systemctl /usr/local/bin/mktemp

runuser -u "$station_user" -- env HOME="$station_home" \
  USER="$station_user" PATH=/usr/local/bin:/usr/bin:/bin \
  "$repo/scripts/update_birdnet.sh" >"$test_root/update.log" 2>&1 \
  || fail 'pre-v1 updater did not complete its v1 handoff'

[ "$(runuser -u "$station_user" -- git -C "$repo" branch --show-current)" = avian-visitors ] \
  || fail 'pre-v1 updater did not select the release branch'
[ "$(runuser -u "$station_user" -- git -C "$repo" rev-parse HEAD)" = "$release_head" ] \
  || fail 'pre-v1 updater did not reach the release commit'
grep -qx v1 "$repo/version.txt" \
  || fail 'documented pre-v1 tracked reset did not occur'
grep -qx 'keep local note' "$repo/local-note.txt" \
  || fail 'pre-v1 handoff removed a noncolliding untracked file'
[ ! -e /etc/sudoers.d/010_caddy-nopasswd ] \
  || fail 'pre-v1 handoff retained unrestricted Caddy sudo'
visudo -cf /etc/sudoers.d/020_avian-admin >/dev/null \
  || fail 'pre-v1 handoff did not install the narrow sudo policy'
[ -e "$test_root/caddy.called" ] \
  || fail 'pre-v1 handoff did not refresh Caddy'

for helper in \
  avian-admin-control avian-archive-control avian-maintenance-control \
  avian-update-control avian-service-refresh avian-security-refresh \
  avian-link-webroot avian-caddy-refresh; do
  [ "$(stat -c '%U:%G:%a' "/usr/local/sbin/$helper")" = root:root:755 ] \
    || fail "unsafe helper after pre-v1 handoff: $helper"
done
for target in avian index.html styles.css apt.js masks.json dims.json fonts assets favicon.png favicon.ico; do
  [ -L "$webroot/$target" ] || fail "missing webroot link after handoff: $target"
done

# A standard older Avian Visitors station keeps the overlay as untracked files
# on main. The one-time bootstrap must reach the new updater before Git tries
# to switch across those collisions.
collision_user=birdcollision
collision_home=/home/$collision_user
collision_repo=$collision_home/BirdNET-Pi
collision_webroot=$collision_home/BirdSongs/Extracted
rm -rf "$collision_home"
rm -f /run/lock/avian-generation.lock
id "$collision_user" >/dev/null 2>&1 \
  || useradd -M -d "$collision_home" -s /bin/bash "$collision_user"
mkdir -p "$collision_home"
chown "$collision_user:$collision_user" "$collision_home"
runuser -u "$collision_user" -- env HOME="$collision_home" \
  git clone -q "$remote" "$collision_repo"
runuser -u "$collision_user" -- env HOME="$collision_home" \
  git -C "$collision_repo" remote set-url origin "$official"
runuser -u "$collision_user" -- env HOME="$collision_home" \
  git -C "$collision_repo" switch -q main
mkdir -p "$collision_repo/avian/frontend" \
  "$collision_repo/avian/assets/illustrations" \
  "$collision_repo/custom" "$collision_webroot"
printf 'legacy page\n' >"$collision_repo/avian/frontend/index.html"
printf '{"shared-bird":{"w":2,"h":2,"bits":"AA=="}}\n' \
  >"$collision_repo/avian/frontend/masks.json"
printf '{"shared-bird":[2,2]}\n' \
  >"$collision_repo/avian/frontend/dims.json"
printf 'local regional shared bird\n' \
  >"$collision_repo/avian/assets/illustrations/shared-bird.png"
printf 'keep local\n' >"$collision_repo/avian/frontend/local-note.txt"
printf 'keep outside\n' >"$collision_repo/custom/notes.txt"
chown -R "$collision_user:$collision_user" "$collision_home"
cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=$collision_user
EXTRACTED=$collision_webroot
AUTOMATIC_UPDATE=0
CADDY_PWD=
EOF
printf 'caddy ALL=(ALL) NOPASSWD: ALL\n' >/etc/sudoers.d/010_caddy-nopasswd
chmod 0440 /etc/sudoers.d/010_caddy-nopasswd

bash /source/scripts/bootstrap_v1.sh >"$test_root/bootstrap.log" 2>&1 \
  || { cp "$test_root/bootstrap.log" "$test_root/update.log"; fail 'v1 bootstrap could not migrate untracked overlay files'; }

grep -q '/var/tmp/avian-v1-bootstrap.' "$test_root/mktemp.log" \
  || fail 'v1 bootstrap did not place its verified fetch on persistent storage'
grep -q '/var/tmp/avian-service-refresh.' "$test_root/mktemp.log" \
  || fail 'service refresh did not place its verified fetch on persistent storage'
if find /var/tmp -maxdepth 1 -type d \
  \( -name 'avian-v1-bootstrap.*' -o -name 'avian-service-refresh.*' \) \
  -print -quit | grep -q .; then
  fail 'verified fetch workspace survived a successful v1 handoff'
fi

[ "$(runuser -u "$collision_user" -- git -C "$collision_repo" branch --show-current)" = avian-visitors ] \
  || fail 'v1 bootstrap did not select the release branch'
[ "$(runuser -u "$collision_user" -- git -C "$collision_repo" rev-parse HEAD)" = "$release_head" ] \
  || fail 'v1 bootstrap did not reach the release commit'
grep -qx index.html "$collision_repo/avian/frontend/index.html" \
  || fail 'release page did not replace its legacy collision'
grep -q '"shared-bird"' "$collision_repo/avian/frontend/masks.json" \
  || fail 'v1 bootstrap did not preserve legacy masks'
grep -q '"shared-bird"' "$collision_repo/avian/frontend/dims.json" \
  || fail 'v1 bootstrap did not preserve legacy dimensions'
grep -qx 'local regional shared bird' \
  "$collision_repo/avian/assets/illustrations/shared-bird.png" \
  || fail 'v1 bootstrap did not preserve a regional illustration collision'
grep -qx 'keep local' "$collision_repo/avian/frontend/local-note.txt" \
  || fail 'v1 bootstrap removed a nested noncollision'
grep -qx 'keep outside' "$collision_repo/custom/notes.txt" \
  || fail 'v1 bootstrap removed an unrelated file'
[ ! -e /etc/sudoers.d/010_caddy-nopasswd ] \
  || fail 'v1 bootstrap retained unrestricted Caddy sudo'
collision_backup=$(find "$collision_home/.local/state/avian-visitors/update-backups" \
  -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$collision_backup" ] || fail 'v1 bootstrap did not back up collisions'
(cd "$collision_backup" && sha256sum -c SHA256SUMS >/dev/null) \
  || fail 'v1 bootstrap collision backup checksum failed'
mkdir -p "$test_root/collision-restore"
tar -C "$test_root/collision-restore" -xf "$collision_backup/legacy-collisions.tar"
grep -qx 'legacy page' "$test_root/collision-restore/avian/frontend/index.html" \
  || fail 'v1 bootstrap backup omitted the replaced page'

echo 'pre-v1 bootstrap smoke: ok'
