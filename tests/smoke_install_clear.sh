#!/usr/bin/env bash
# Run inside a disposable Debian container with the repository at /source and
# AVIAN_INSTALL_CLEAR_TEST=1 set explicitly.
# Exercises the Avian Visitors overlay install and clear-all-data recovery
# without touching a host installation or starting real services.

set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f /.dockerenv ] \
  || fail "refusing install and clear smoke outside a disposable container"
[ "${AVIAN_INSTALL_CLEAR_TEST:-0}" = 1 ] \
  || fail "refusing install and clear smoke without AVIAN_INSTALL_CLEAR_TEST=1"

font_source=/source/avian/frontend/fonts/Caveat.ttf
[ -f "$font_source" ] || fail "Caveat release font is missing"
grep -Fq "url('./fonts/Caveat.ttf')" /source/avian/frontend/styles.css \
  || fail "Caveat CSS does not use the public webroot path"
if grep -Fq './avian/frontend/fonts/Caveat.ttf' /source/avian/frontend/styles.css; then
  fail "Caveat CSS uses the private repository path"
fi
awk '
  /^  @privateAvian \{/ { in_matcher=1 }
  in_matcher && /path \/avian\/[*]/ { private_path=1 }
  in_matcher && /not path \/avian\/api\/[*] \/avian\/assets\/[*]/ { reviewed_exceptions=1 }
  in_matcher && /^  }/ { in_matcher=0 }
  /^  handle @privateAvian \{/ { in_handler=1 }
  in_handler && /respond 404/ { private_404=1 }
  in_handler && /^  }/ { in_handler=0 }
  END { exit !(private_path && reviewed_exceptions && private_404) }
' /source/scripts/update_caddyfile.sh \
  || fail "Caddy does not keep repository frontend paths private"

for preview_path in \
  avian/frontend/assets/recording-previews/README.md \
  avian/frontend/assets/recording-previews/private-fixture.mp3 \
  avian/frontend/assets/recording-previews/private-fixture.png; do
  git -c safe.directory=/source -C /source check-ignore -q -- "$preview_path" \
    || fail "private recording preview is not ignored: $preview_path"
done

for stamp_asset in \
  owl-pale-treeline.jpg \
  paper-texture-grey.png \
  rough-concrete-cc0.png; do
  grep -Fq "/assets/stamp/$stamp_asset" /source/scripts/update_caddyfile.sh \
    || fail "Caddy public asset policy does not include: $stamp_asset"
done
if grep -Fq 'path_regexp publicFrontendStamp' /source/scripts/update_caddyfile.sh; then
  fail "Caddy stamp policy is broader than the reviewed asset list"
fi

# Bundle discovery, installation, sharing, and regional generation belong to
# the next release. Keep their endpoints, handoffs, and UI out of this one.
deferred_bundle_pattern='BUNDLE_FEATURE_ENABLED|bird:style|local-packs/|bundles[.]php|bundle-generate[.]php|avianvisitors[.]com/bundles|install-bundle|bundle-catalog|data-bundle-(plan|start|share)|Bird bundle|regional bundle'
for production_frontend in \
  /source/avian/frontend/index.html \
  /source/avian/frontend/apt.js \
  /source/avian/frontend/styles.css; do
  if grep -Eiq "$deferred_bundle_pattern" "$production_frontend"; then
    fail "deferred bundle code leaked into production frontend: $production_frontend"
  fi
done

for blossom in sparrow-blossom-single-v2.png sparrow-blossom-pair-v2.png; do
  asset_path="avian/assets/references/$blossom"
  [ -f "/source/$asset_path" ] || fail "release stamp asset is missing: $asset_path"
  if git -c safe.directory=/source -C /source check-ignore -q -- "$asset_path"; then
    fail "release stamp asset is ignored: $asset_path"
  fi
  grep -Fq "./$asset_path" /source/avian/frontend/stamp-batch-root.js \
    || fail "stamp runtime does not reference: $asset_path"
  grep -Fq "/$asset_path" /source/scripts/update_caddyfile.sh \
    || fail "Caddy public asset policy does not include: $asset_path"
done

test_root=/tmp/avian-release-flow
test_bin=$test_root/bin
bird_home=/home/bird
repo=$bird_home/BirdNET-Pi
recordings=$bird_home/BirdSongs
extracted=$recordings/Extracted
processed=$recordings/Processed
mkdir -p "$test_bin" "$repo/scripts" "$repo/avian/frontend" \
  "$repo/avian/assets/references" \
  "$repo/homepage/images" "$repo/model" "$repo/templates" "$repo/.git" /etc/birdnet
chmod 0777 "$test_root"

id bird >/dev/null 2>&1 || useradd -m bird
id caddy >/dev/null 2>&1 \
  || useradd --system --no-create-home --shell /usr/sbin/nologin caddy

cp /source/scripts/install_services.sh "$repo/scripts/install_services.sh"
cp /source/scripts/clear_all_data.sh "$repo/scripts/clear_all_data.sh"
cp /source/scripts/link_webroot.sh "$repo/scripts/link_webroot.sh"
cp /source/scripts/archive_control.sh "$repo/scripts/archive_control.sh"
cp /source/scripts/maintenance_control.sh "$repo/scripts/maintenance_control.sh"
cp /source/scripts/admin_control.sh "$repo/scripts/admin_control.sh"
cp /source/scripts/update_birdnet.sh "$repo/scripts/update_birdnet.sh"
cp /source/scripts/reinstall_services.sh "$repo/scripts/reinstall_services.sh"
cp /source/scripts/security_refresh.sh "$repo/scripts/security_refresh.sh"
cp /source/scripts/update_caddyfile.sh "$repo/scripts/update_caddyfile.sh"
cp /source/scripts/educators_control.sh "$repo/scripts/educators_control.sh"
cp -R /source/avian/frontend/. "$repo/avian/frontend/"
cp /source/avian/assets/favicon.png "$repo/avian/assets/favicon.png"
cp /source/avian/assets/references/sparrow-blossom-single-v2.png \
  /source/avian/assets/references/sparrow-blossom-pair-v2.png \
  "$repo/avian/assets/references/"
printf 'legacy home\n' >"$repo/homepage/index.php"
printf 'icon\n' >"$repo/homepage/images/favicon.ico"
printf 'labels\n' >"$repo/model/labels.txt"
for file in phpsysinfo.ini green_bootstrap.css index_bootstrap.html; do
  printf 'fixture\n' >"$repo/templates/$file"
done
mkdir -p "$bird_home/phpsysinfo/templates/html"

cat >"$test_bin/sudo" <<'EOF'
#!/usr/bin/env bash
set -e
if [ "${1:-}" = -u ]; then
  target_user=$2
  shift 2
  if [ "$target_user" = "$(id -un)" ]; then
    exec "$@"
  fi
  exec runuser -u "$target_user" -- env PATH="$PATH" "$@"
fi
exec "$@"
EOF
cat >"$test_bin/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >>/tmp/avian-release-flow/systemctl.log
exit 0
EOF
cat >"$test_bin/createdb.sh" <<'EOF'
#!/bin/sh
touch /home/bird/.createdb.called
EOF
cat >"$repo/scripts/update_caddyfile.sh" <<'EOF'
#!/bin/sh
if [ -e /tmp/avian-release-flow/fail-caddy ]; then
  exit 1
fi
[ -d /home/bird/BirdSongs/Extracted ] \
  || { echo "webroot missing before Caddy render" >&2; exit 1; }
touch /tmp/avian-release-flow/caddy.called
printf 'caddy\n' >>/tmp/avian-release-flow/service-order.log
EOF
cat >"$repo/scripts/createdb.sh" <<'EOF'
#!/bin/sh
touch /home/bird/.createdb.called
if [ -e /proc/self/fd/10 ] \
  && [ "$(stat -Lc '%d:%i' /proc/self/fd/10 2>/dev/null || true)" = \
    "$(stat -c '%d:%i' /var/lib/avian-visitors/educators.lock)" ]; then
  touch /tmp/avian-release-flow/clear-lock-inherited
fi
if flock -s -n /var/lib/avian-visitors/educators.lock -c true 2>/dev/null; then
  touch /tmp/avian-release-flow/clear-lock-open
fi
EOF
chmod 0755 "$test_bin"/* "$repo/scripts"/*.sh
export PATH="$test_bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [ -L /etc/birdnet/birdnet.conf ]; then
  unlink /etc/birdnet/birdnet.conf
fi
cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=bird
RECS_DIR=$recordings
EXTRACTED=$extracted
PROCESSED=$processed
IDFILE=$bird_home/IdentifiedSoFar.txt
EOF

chown -R bird:bird "$bird_home"

assert_link() {
  local target=$1
  local source=$2
  [ -L "$target" ] || fail "missing link: $target"
  [ "$(readlink "$target")" = "$source" ] \
    || fail "wrong target for $target"
}

assert_served_file() {
  local target=$1
  local source=$2
  [ -f "$target" ] || fail "missing served file: $target"
  [ "$(readlink -f "$target")" = "$source" ] \
    || fail "wrong source for served file: $target"
}

assert_avian_runtime_links() {
  assert_link "$extracted/avian" "$repo/avian"
  assert_link "$extracted/index.html" "$repo/avian/frontend/index.html"
  assert_link "$extracted/styles.css" "$repo/avian/frontend/styles.css"
  assert_link "$extracted/apt.js" "$repo/avian/frontend/apt.js"
  assert_link "$extracted/masks.json" "$repo/avian/frontend/masks.json"
  assert_link "$extracted/dims.json" "$repo/avian/frontend/dims.json"
  assert_link "$extracted/nest.webp" "$repo/avian/frontend/nest.webp"
  assert_link "$extracted/nest-eggs.webp" "$repo/avian/frontend/nest-eggs.webp"
  assert_link "$extracted/stamps.css" "$repo/avian/frontend/stamps.css"
  assert_link "$extracted/stamps.js" "$repo/avian/frontend/stamps.js"
  assert_link "$extracted/stamp-batch-root.css" "$repo/avian/frontend/stamp-batch-root.css"
  assert_link "$extracted/stamp-batch-root.js" "$repo/avian/frontend/stamp-batch-root.js"
  assert_link "$extracted/stamp-batch-a.css" "$repo/avian/frontend/stamp-batch-a.css"
  assert_link "$extracted/stamp-batch-a.js" "$repo/avian/frontend/stamp-batch-a.js"
  assert_link "$extracted/stamp-batch-b.css" "$repo/avian/frontend/stamp-batch-b.css"
  assert_link "$extracted/stamp-batch-b.js" "$repo/avian/frontend/stamp-batch-b.js"
  assert_link "$extracted/stamp-batch-c.css" "$repo/avian/frontend/stamp-batch-c.css"
  assert_link "$extracted/stamp-batch-c.js" "$repo/avian/frontend/stamp-batch-c.js"
  assert_link "$extracted/grain.png" "$repo/avian/frontend/grain.png"
  assert_link "$extracted/stats-press.png" "$repo/avian/frontend/stats-press.png"
  assert_link "$extracted/fonts" "$repo/avian/frontend/fonts"
  assert_served_file \
    "$extracted/fonts/Caveat.ttf" \
    "$repo/avian/frontend/fonts/Caveat.ttf"
  cmp -s "$extracted/fonts/Caveat.ttf" "$font_source" \
    || fail "installed Caveat font differs from the release asset"
  assert_link "$extracted/assets" "$repo/avian/frontend/assets"
  assert_link "$extracted/favicon.png" "$repo/avian/assets/favicon.png"
  assert_link "$extracted/favicon.ico" "$repo/avian/assets/favicon.png"
  assert_served_file \
    "$extracted/avian/assets/references/sparrow-blossom-single-v2.png" \
    "$repo/avian/assets/references/sparrow-blossom-single-v2.png"
  assert_served_file \
    "$extracted/avian/assets/references/sparrow-blossom-pair-v2.png" \
    "$repo/avian/assets/references/sparrow-blossom-pair-v2.png"
}

assert_stock_runtime_links() {
  assert_link "$extracted/scripts" "$repo/scripts"
  assert_link "$extracted/play.php" "$repo/scripts/play.php"
  assert_link "$extracted/spectrogram.php" "$repo/scripts/spectrogram.php"
  assert_link "$extracted/overview.php" "$repo/scripts/overview.php"
  assert_link "$extracted/stats.php" "$repo/scripts/stats.php"
  assert_link "$extracted/todays_detections.php" "$repo/scripts/todays_detections.php"
  assert_link "$extracted/history.php" "$repo/scripts/history.php"
  assert_link "$extracted/weekly_report.php" "$repo/scripts/weekly_report.php"
}

# A real directory at any manifest target must abort before the helper creates
# even the first link.
collision_root=$test_root/collision-root
mkdir -p "$collision_root/fonts"
chown -R bird:bird "$collision_root"
source "$repo/scripts/link_webroot.sh"
if link_avian_visitors_webroot "$repo" "$collision_root" bird \
    >"$test_root/collision.log" 2>&1; then
  fail "webroot helper replaced a directory collision"
fi
[ -d "$collision_root/fonts" ] && [ ! -L "$collision_root/fonts" ] \
  || fail "directory collision was modified"
[ ! -e "$collision_root/index.html" ] \
  || fail "webroot changed before manifest validation completed"
grep -q "Refusing to replace directory: $collision_root/fonts" "$test_root/collision.log" \
  || fail "directory collision did not report its target"

# Clean overlay installation. Source the installer with no repository config
# so only the bounded functions below run.
[ ! -e "$extracted" ] || fail "fresh-install webroot already exists"
(
  USER=bird
  HOME=$bird_home
  export BIRDNET_USER=bird
  export RECS_DIR=$recordings
  export EXTRACTED=$extracted
  export PROCESSED=$processed
  source "$repo/scripts/install_services.sh"
  install_avian_controls
  prepare_caddy_webroot
  [ "$(stat -c '%U:%G' "$EXTRACTED")" = bird:bird ] \
    || fail "fresh-install webroot has the wrong owner"
  install_Caddyfile
  prepare_caddy_webroot
  create_necessary_dirs
)

[ -e "$test_root/caddy.called" ] \
  || fail "Caddy was not rendered after webroot preparation"
: >"$test_root/systemctl.log"
chown bird:bird "$test_root/systemctl.log"

unsafe_webroot=$test_root/unsafe-webroot
printf 'not a directory\n' >"$unsafe_webroot"
chown bird:bird "$unsafe_webroot"
(
  USER=bird
  HOME=$bird_home
  export BIRDNET_USER=bird
  export EXTRACTED=$unsafe_webroot
  source "$repo/scripts/install_services.sh"
  if prepare_caddy_webroot >"$test_root/unsafe-webroot.log" 2>&1; then
    fail "fresh-install preparation accepted a file as the webroot"
  fi
)
grep -Fq "Could not create the BirdNET-Pi webroot" \
  "$test_root/unsafe-webroot.log" \
  || fail "unsafe fresh-install webroot returned the wrong error"

(
  USER=bird
  HOME=$bird_home
  export BIRDNET_USER=bird
  export EXTRACTED=/
  source "$repo/scripts/install_services.sh"
  if prepare_caddy_webroot >"$test_root/root-webroot.log" 2>&1; then
    fail "fresh-install preparation accepted the filesystem root"
  fi
)
grep -Fq "Invalid BirdNET-Pi webroot" "$test_root/root-webroot.log" \
  || fail "invalid fresh-install webroot returned the wrong error"

assert_avian_runtime_links
assert_stock_runtime_links
[ ! -e "$extracted/local-packs" ] || fail "deferred bundle storage leaked into install"
[ -x /usr/local/sbin/avian-archive-control ] || fail "archive helper was not installed"
[ "$(stat -c '%U:%G:%a' /usr/local/sbin/avian-archive-control)" = root:root:755 ] \
  || fail "archive helper ownership"
[ -x /usr/local/sbin/avian-maintenance-control ] || fail "maintenance helper was not installed"
[ "$(stat -c '%U:%G:%a' /usr/local/sbin/avian-maintenance-control)" = root:root:755 ] \
  || fail "maintenance helper ownership"
[ "$(stat -c '%U:%G:%a' /usr/local/sbin/avian-link-webroot)" = root:root:755 ] \
  || fail "webroot helper ownership"
[ "$(stat -c '%U:%G:%a' /usr/local/sbin/avian-caddy-refresh)" = root:root:755 ] \
  || fail "Caddy helper ownership"
[ "$(stat -c '%U:%G:%a' /usr/local/sbin/avian-educators)" = root:root:755 ] \
  || fail "Educators helper ownership"
[ "$(stat -c '%U:%G:%a:%h' /var/lib/avian-visitors/educators.lock)" = \
  root:caddy:660:1 ] \
  || fail "default install did not provision the Educators coordination lock"
[ ! -e /var/lib/avian-visitors/educators.state ] \
  && [ ! -e /var/lib/avian-visitors/educators ] \
  || fail "default install initialized optional Educators data"
[ ! -e "$bird_home/bird-archive" ] || fail "clean install opted into Drive archive"

# This smoke owns the clear workflow, not the Educators SQLite implementation.
# Replace the verified installed helper with a fixed-action recorder so the
# clear path can prove metadata reset ordering without a second fake database.
cat >/usr/local/sbin/avian-educators <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$#" = 1 ] && [ "$1" = clear-all ] || exit 64
mkdir -p /var/lib/avian-visitors
if [ ! -e /var/lib/avian-visitors/educators.lock ]; then
  install -o root -g caddy -m 0660 /dev/null /var/lib/avian-visitors/educators.lock
fi
exec 10<>/var/lib/avian-visitors/educators.lock
flock -x 10
maintenance_token=/var/lib/avian-visitors/.educators-maintenance.TST123
printf 'v1\n' >"$maintenance_token"
chown root:caddy "$maintenance_token"
chmod 0400 "$maintenance_token"
trap 'rm -f -- "$maintenance_token"' EXIT
common_env=(
  PATH=/tmp/avian-release-flow/bin:/usr/sbin:/usr/bin:/sbin:/bin
  AVIAN_EDUCATOR_MAINTENANCE_FD=12
  AVIAN_BIRDNET_USER=bird
  AVIAN_BIRDNET_HOME=/home/bird
  AVIAN_RECS_DIR=/home/bird/BirdSongs
  AVIAN_EXTRACTED=/home/bird/BirdSongs/Extracted
  AVIAN_PROCESSED=/home/bird/BirdSongs/Processed
  AVIAN_IDFILE=/home/bird/IdentifiedSoFar.txt
)
run_phase() {
  local phase=$1 status=0
  exec 12<"$maintenance_token"
  runuser -u bird -- env -i "${common_env[@]}" \
    AVIAN_EDUCATOR_MAINTENANCE_PHASE="$phase" \
    /bin/bash -c 'exec 9>&- 10>&- 11>&-; exec /bin/bash "$1"' \
    avian-clear /home/bird/BirdNET-Pi/scripts/clear_all_data.sh || status=$?
  exec 12<&-
  return "$status"
}
run_phase core
printf 'educators\n' >>/tmp/avian-release-flow/service-order.log
touch /tmp/avian-release-flow/educators-reset.called
run_phase finish
for service in \
  chart_viewer.service spectrogram_viewer.service icecast2.service \
  birdnet_recording.service birdnet_analysis.service birdnet_log.service \
  birdnet_stats.service; do
  systemctl restart "$service"
done
EOF
chown root:root /usr/local/sbin/avian-educators
chmod 0755 /usr/local/sbin/avian-educators

# Populate data and an independent archive sentinel, then clear only BirdNET
# detections and recordings.
: >"$test_root/service-order.log"
chown bird:bird "$test_root/service-order.log"
mkdir -p "$recordings/Extracted/By_Date/2026-08-15/American_Crow" "$bird_home/bird-archive"
printf 'recording\n' >"$recordings/Extracted/By_Date/2026-08-15/American_Crow/call.mp3"
printf 'keep\n' >"$bird_home/bird-archive/archive.conf"
printf 'identified\n' >"$bird_home/IdentifiedSoFar.txt"
printf 'old database export\n' >"$repo/BirdDB.txt"
chown -R bird:bird "$recordings" "$bird_home/bird-archive" "$bird_home/IdentifiedSoFar.txt" "$repo/BirdDB.txt"

if ! bash "$repo/scripts/clear_all_data.sh" >"$test_root/clear.log" 2>&1; then
  cat "$test_root/clear.log" >&2
  fail "clear-all-data failed"
fi

[ ! -e "$recordings/Extracted/By_Date/2026-08-15/American_Crow/call.mp3" ] \
  || fail "clear-all-data retained a recording"
[ -d "$extracted/By_Date" ] && [ -d "$extracted/Charts" ] && [ -d "$processed" ] \
  || fail "clear-all-data did not rebuild the data layout"
assert_avian_runtime_links
assert_stock_runtime_links
[ ! -e "$extracted/local-packs" ] || fail "clear-all-data restored deferred bundle storage"
[ -f "$bird_home/bird-archive/archive.conf" ] || fail "clear-all-data removed archive configuration"
[ ! -e "$bird_home/IdentifiedSoFar.txt" ] || fail "clear-all-data retained the identification state"
head -n 1 "$repo/BirdDB.txt" | grep -q '^Date;Time;Sci_Name;' \
  || fail "clear-all-data did not rebuild BirdDB.txt"
[ -e "$bird_home/.createdb.called" ] || fail "clear-all-data did not recreate the database"
[ -e "$test_root/caddy.called" ] || fail "clear-all-data did not refresh Caddy"
[ -e "$test_root/educators-reset.called" ] || fail "clear-all-data did not reset Educators metadata"
[ ! -e "$test_root/clear-lock-open" ] \
  || fail "clear-all-data released the Educators lock during database replacement"
[ ! -e "$test_root/clear-lock-inherited" ] \
  || fail "clear-all-data inherited the parent Educators lock descriptor"
[ "$(tr '\n' ' ' <"$test_root/service-order.log")" = "educators caddy " ] \
  || fail "unexpected privileged restart path"
grep -q '^stop birdnet_recording.service$' "$test_root/systemctl.log" \
  || fail "recording service was not stopped"
grep -q '^stop birdnet_analysis.service$' "$test_root/systemctl.log" \
  || fail "analysis service was not stopped"
for service in \
  chart_viewer.service spectrogram_viewer.service icecast2.service \
  birdnet_recording.service birdnet_analysis.service birdnet_log.service \
  birdnet_stats.service; do
  grep -q "^restart $service$" "$test_root/systemctl.log" \
    || fail "service was not restarted: $service"
done

# A bad Caddy refresh must fail before service restart instead of reporting a
# successful reset with stale routing.
touch "$test_root/fail-caddy"
restart_count_before=$(grep -c '^restart ' "$test_root/systemctl.log")
if bash "$repo/scripts/clear_all_data.sh" >"$test_root/clear-caddy-fail.log" 2>&1; then
  fail "clear-all-data ignored a failed Caddy refresh"
fi
[ "$(grep -c '^restart ' "$test_root/systemctl.log")" -eq "$restart_count_before" ] \
  || fail "clear-all-data restarted services after a failed Caddy refresh"
grep -q 'services were not restarted' "$test_root/clear-caddy-fail.log" \
  || fail "clear-all-data did not explain the Caddy failure"

echo 'install and clear-all-data smoke: ok'
