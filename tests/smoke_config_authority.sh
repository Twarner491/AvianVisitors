#!/usr/bin/env bash
# Run only in a disposable container with /source mounted read-only.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
[ -f /.dockerenv ] \
  || fail 'refusing config authority smoke outside a disposable container'
[ "${AVIAN_CONFIG_AUTHORITY_TEST:-0}" = 1 ] \
  || fail 'refusing config authority smoke without AVIAN_CONFIG_AUTHORITY_TEST=1'
[ "$EUID" = 0 ] || fail 'config authority smoke must run as root'

id configbird >/dev/null 2>&1 || useradd -m -s /bin/bash configbird
station_home=/home/configbird
repo=$station_home/BirdNET-Pi
canonical=/etc/birdnet/birdnet.conf
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$repo/.git" "$repo/scripts" /etc/birdnet "$work/bin"
chown -R configbird:configbird "$repo"
cat >"$work/valid.conf" <<EOF
BIRDNET_USER=configbird
GEMINI_API_KEY=canonical-secret-fixture
SITE_NAME="Current Station"
RESET_AT_MIDNIGHT=1
LATITUDE=37.7
LONGITUDE=-122.4
RECS_DIR=$station_home/recordings
EXTRACTED=$station_home/extracted
EOF
cat >"$work/bin/curl" <<'EOF'
#!/bin/sh
touch /tmp/avian-config-network-called
EOF
chmod 0755 "$work/bin/curl"

reset_config() {
  rm -rf -- "$repo/birdnet.conf" "$canonical"
  rm -f /tmp/avian-config-network-called
}
config_snapshot() {
  find /etc/birdnet "$repo" -maxdepth 1 -printf '%p %y %l\n'
  find /etc/birdnet "$repo" -maxdepth 1 -type f -exec sha256sum {} +
}
install_config() {
  env my_dir="$repo" HOME="$station_home" USER=configbird \
    PATH="$work/bin:$PATH" bash /source/scripts/install_config.sh >"$work/install.out" 2>&1
}
expect_install_refusal() {
  local before
  before=$(config_snapshot)
  if install_config; then fail "$1 install unexpectedly succeeded"; fi
  grep -Eq 'config.*(unsafe|regular|differ|conflict|resolve)' "$work/install.out" \
    || fail "$1 install did not report a config problem"
  [ ! -e /tmp/avian-config-network-called ] || fail "$1 contacted network before refusal"
  ! grep -q 'secret-fixture' "$work/install.out" || fail "$1 exposed config secrets"
  [ "$before" = "$(config_snapshot)" ] || fail "$1 changed config files"
}

reset_config
cp "$work/valid.conf" "$canonical"
chmod 0640 "$canonical"
install_config || fail "canonical-only install failed: $(cat "$work/install.out")"
cmp -s "$work/valid.conf" "$canonical" || fail 'canonical-only install lost settings'
[ ! -L "$canonical" ] && [ ! -e "$repo/birdnet.conf" ] \
  || fail 'canonical-only install replaced config layout'
[ "$(stat -c %a "$canonical")" = 640 ] || fail 'canonical permissions changed'

cp "$work/valid.conf" "$repo/birdnet.conf"
install_config || fail 'equal independent configs were rejected by install'
cmp -s "$work/valid.conf" "$canonical" && cmp -s "$work/valid.conf" "$repo/birdnet.conf" \
  || fail 'equal independent configs changed'
[ ! -L "$canonical" ] || fail 'equal canonical config was replaced by a link'

printf 'GEMINI_API_KEY=stale-secret-fixture\n' >>"$repo/birdnet.conf"
cp "$repo/birdnet.conf" "$work/stale.conf"
rm -f /tmp/avian-config-network-called
expect_install_refusal divergent
cmp -s "$work/valid.conf" "$canonical" && cmp -s "$work/stale.conf" "$repo/birdnet.conf" \
  || fail 'divergent install changed a config'

for kind in dangling outside directory fifo repo-link; do
  reset_config
  cp "$work/valid.conf" "$repo/birdnet.conf"
  case "$kind" in
    dangling) ln -s "$repo/missing.conf" "$canonical" ;;
    outside) ln -s "$work/valid.conf" "$canonical" ;;
    directory) mkdir "$canonical" ;;
    fifo) mkfifo "$canonical" ;;
    repo-link)
      rm "$repo/birdnet.conf"
      ln -s "$work/valid.conf" "$repo/birdnet.conf"
      ln -s "$repo/birdnet.conf" "$canonical"
      ;;
  esac
  expect_install_refusal "$kind"
  cmp -s "$work/valid.conf" "$repo/birdnet.conf" || fail "$kind changed config target"
done

reset_config
cp "$work/valid.conf" "$repo/birdnet.conf"
install_config || fail 'repo-only install failed'
[ -L "$canonical" ] && [ "$(readlink -f "$canonical")" = "$repo/birdnet.conf" ] \
  || fail 'repo-only install did not retain normal symlink layout'
install_config || fail 'normal symlink reinstall failed'
cmp -s "$work/valid.conf" "$canonical" || fail 'normal symlink settings changed'

reset_config
install_config || fail 'fresh config install failed'
[ -L "$canonical" ] && grep -Fxq 'BIRDNET_USER=configbird' "$canonical" \
  || fail 'fresh install did not create the canonical config link'

# A deliberate later blocker proves accepted layouts pass the early guard.
mkdir -p /var/lib/avian-visitors
chmod 0700 /var/lib/avian-visitors
for kind in divergent equal canonical-only normal dangling outside directory fifo repo-link; do
  reset_config
  cp "$work/valid.conf" "$repo/birdnet.conf"
  cp "$work/valid.conf" "$canonical"
  case "$kind" in
    divergent) printf 'GEMINI_API_KEY=stale-secret-fixture\n' >>"$repo/birdnet.conf" ;;
    canonical-only) rm "$repo/birdnet.conf" ;;
    normal) rm "$canonical"; ln -s "$repo/birdnet.conf" "$canonical" ;;
    dangling) rm "$canonical"; ln -s "$repo/missing.conf" "$canonical" ;;
    outside) rm "$canonical"; ln -s "$work/valid.conf" "$canonical" ;;
    directory) rm "$canonical"; mkdir "$canonical" ;;
    fifo) rm "$canonical"; mkfifo "$canonical" ;;
    repo-link) rm "$repo/birdnet.conf"; ln -s "$work/valid.conf" "$repo/birdnet.conf" ;;
  esac
  before=$(config_snapshot)
  if timeout 10 bash /source/scripts/security_refresh.sh >"$work/security.out" 2>&1; then
    fail "$kind security refresh unexpectedly succeeded"
  fi
  case "$kind" in
    equal|canonical-only|normal)
      grep -Fq 'Unsafe admin state directory' "$work/security.out" \
        || fail "$kind failed the early config guard"
      ;;
    *)
      grep -Eqi 'config.*(unsafe|safe|regular|differ|conflict|resolve|found)' "$work/security.out" \
        || fail "$kind reached root state before config refusal"
      ;;
  esac
  [ "$(stat -c %a /var/lib/avian-visitors)" = 700 ] \
    && [ ! -e /var/lib/avian-visitors/admin-auth.lock ] \
    || fail "$kind changed privileged state"
  [ "$before" = "$(config_snapshot)" ] || fail "$kind changed config files"
  ! grep -q 'secret-fixture' "$work/security.out" || fail "$kind exposed secrets"
done

mkdir -p "$station_home/recordings/tmp"
printf 'keep staging\n' >"$station_home/recordings/tmp/sentinel"
cat >"$repo/scripts/stop_core_services.sh" <<'EOF'
#!/bin/sh
touch /tmp/avian-config-services-stopped
EOF
chmod 0755 "$repo/scripts/stop_core_services.sh"
chown -R configbird:configbird "$station_home/recordings"
for layout in divergent equal canonical-only; do
  reset_config
  cp "$work/valid.conf" "$canonical"
  cp "$work/valid.conf" "$repo/birdnet.conf"
  case "$layout" in
    divergent) printf 'GEMINI_API_KEY=stale-secret-fixture\n' >>"$repo/birdnet.conf" ;;
    canonical-only) rm "$repo/birdnet.conf" ;;
  esac
  for action in backup restore; do
    if runuser -u configbird -- bash /source/scripts/backup_data.sh -a "$action" -f - \
      </dev/null >"$work/backup.out" 2>&1; then
      fail "$layout legacy $action unexpectedly succeeded"
    fi
    [ ! -e /tmp/avian-config-services-stopped ] || fail "$layout $action stopped services"
    [ -f "$station_home/recordings/tmp/sentinel" ] || fail "$layout $action unpacked data"
    grep -qi 'config' "$work/backup.out" || fail "$layout $action gave no config diagnostic"
    cmp -s "$work/valid.conf" "$canonical" || fail "$layout $action changed canonical config"
  done
done

reset_config
cp "$work/valid.conf" "$canonical"
printf 'LATITUDE=0\nLONGITUDE=0\nSITE_NAME="Stale Station"\nRESET_AT_MIDNIGHT=0\n' >"$repo/birdnet.conf"
python3 - "$repo" <<'PY'
import importlib.util
import os
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('bundle_manager', '/source/avian/scripts/bundle_manager.py')
manager = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = manager
spec.loader.exec_module(manager)
manager.station_root = lambda: Path(sys.argv[1])
assert manager.station_coordinates() == (37.7, -122.4), 'bundle location used stale config'
os.environ['AVIAN_BUNDLE_CONFIG'] = str(Path(sys.argv[1]) / 'birdnet.conf')
assert manager.station_coordinates() is None, 'explicit bundle config override was lost'
PY
php -r '
define("AVIAN_BIRDNET_API_LIBRARY_ONLY", true);
require "/source/avian/api/birdnet-api.php";
if (publicSiteName($CONF_PATH) !== "Current Station"
    || !publicConfigFlag($CONF_PATH, "RESET_AT_MIDNIGHT")) exit(1);
' || fail 'public API ignored canonical title or midnight policy'
chmod 0755 /var/lib/avian-visitors
id caddy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin caddy
printf 'v1\t0\t0\t-\n' >/var/lib/avian-visitors/admin-auth.state
chown root:caddy /var/lib/avian-visitors/admin-auth.state
chmod 0640 /var/lib/avian-visitors/admin-auth.state
status=$(php -r '
$_SERVER["REMOTE_ADDR"] = "127.0.0.1";
$_SERVER["HTTP_HOST"] = "127.0.0.1";
$_SERVER["REQUEST_METHOD"] = "GET";
$_GET["action"] = "system";
ob_start();
require "/source/avian/api/birdnet-status.php";
$result = json_decode(ob_get_clean(), true);
if (($result["conf"]["values"]["SITE_NAME"] ?? null) !== "Current Station") exit(1);
echo "canonical status";
')
[ "$status" = 'canonical status' ] || fail 'status API ignored canonical settings'

cp /source/scripts/install_services.sh "$repo/scripts/install_services.sh"
cat >"$repo/scripts/install_helpers.sh" <<'EOF'
install_services() { printf '%s\n' "$SITE_NAME"; exit 0; }
EOF
service_title=$(env HOME="$station_home" USER=configbird bash "$repo/scripts/install_services.sh")
[ "$service_title" = 'Current Station' ] || fail 'service install sourced stale settings'
echo 'config authority smoke: ok'
