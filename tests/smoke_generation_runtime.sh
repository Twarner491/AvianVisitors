#!/usr/bin/env bash
# Run only in a disposable Linux container with /source mounted read-only.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
[ -f /.dockerenv ] || fail "refusing generation runtime smoke outside a container"
[ "${AVIAN_GENERATION_RUNTIME_TEST:-0}" = 1 ] \
  || fail "refusing generation runtime smoke without explicit opt-in"
[ "$EUID" = 0 ] || fail "test requires container root"

# This fixture exercises the whole installed security-refresh entry point.
AVIAN_SECURITY_DIAGNOSTIC_TEST=1 bash /source/tests/smoke_security_diagnostic_cleanup.sh
station_gid=$(id -g aviandiag)
repo=/home/aviandiag/BirdNET-Pi

case "${1:-all}" in
lock|all)
  policy=/etc/tmpfiles.d/avian-generation.conf
  lock=/run/lock/avian-generation.lock
  [ -f "$policy" ] || fail "generation lock has no boot recreation policy"
  [ "$(stat -c '%u:%g:%a' "$policy")" = 0:0:644 ] || fail "unsafe tmpfiles policy"
  inode=$(stat -c '%i' "$lock")
  /source/scripts/security_refresh.sh >/dev/null
  [ "$(stat -c '%i' "$lock")" = "$inode" ] || fail "refresh replaced active lock inode"
  rm -- "$lock"
  systemd-tmpfiles --create "$policy"
  [ "$(stat -c '%u:%g:%a:%h' "$lock")" = "0:$station_gid:660:1" ] \
    || fail "reboot did not restore the protected lock"
  runuser -u caddy -- php -r '$h = fopen("/run/lock/avian-generation.lock", "r+"); if (!$h || !flock($h, LOCK_EX | LOCK_NB)) exit(1);'
  if runuser -u caddy -- rm "$lock" 2>/dev/null; then
    fail "Caddy can replace the root-owned lock"
  fi
  target=/tmp/avian-generation-sentinel
  printf 'untouched\n' >"$target"
  chmod 0600 "$target"
  rm -- "$lock"
  ln -s "$target" "$lock"
  if /source/scripts/security_refresh.sh >/dev/null 2>&1; then
    fail "refresh accepted a lock symlink"
  fi
  systemd-tmpfiles --create "$policy" >/dev/null 2>&1 || true
  [ "$(cat "$target")" = untouched ] || fail "boot policy modified symlink target"
  [ "$(stat -c '%u:%g:%a' "$target")" = 0:0:600 ] \
    || fail "boot policy changed symlink target permissions"
  rm -- "$lock"
  ln "$target" "$lock"
  if /source/scripts/security_refresh.sh >/dev/null 2>&1; then
    fail "refresh accepted a hard-linked lock"
  fi
  systemd-tmpfiles --create "$policy" >/dev/null 2>&1 || true
  [ "$(stat -c '%u:%g:%a' "$target")" = 0:0:600 ] \
    || fail "boot policy changed hard-link target permissions"
  rm -- "$lock"
  systemd-tmpfiles --create "$policy"
  mv "$policy" "$policy.saved"
  ln -s "$target" "$policy"
  if /source/scripts/security_refresh.sh >/dev/null 2>&1; then
    fail "refresh accepted a tmpfiles policy symlink"
  fi
  [ "$(cat "$target")" = untouched ] || fail "policy symlink target changed"
  rm -- "$policy"
  mv "$policy.saved" "$policy"
  ;;
esac

case "${1:-all}" in
cache|all)
  cache=/var/lib/avian-visitors/image-cache
  [ -d "$cache" ] || fail "image cache directory was not provisioned"
  [ "$(stat -c '%U:%G:%a' "$cache")" = caddy:caddy:700 ] || fail "unsafe cache permissions"
  cp /source/scripts/common.php "$repo/scripts/common.php"
  mkdir -p "$repo/avian/api"
  cp /source/avian/api/admin-state.php "$repo/avian/api/admin-state.php"
  /source/scripts/security_refresh.sh >/dev/null
  printf 'old cache is retained\n' >"$repo/scripts/flickr.db"
  runuser -u caddy -- php -r '
    require "/home/aviandiag/BirdNET-Pi/scripts/common.php";
    class CachedWikipedia extends Wikipedia {
      public function store() {
        $this->set_image_in_db("Pica pica", "Magpie", "image.jpg", "Magpie", "pica", "author", "license");
      }
    }
    $provider = new CachedWikipedia();
    $provider->store();
    if ($provider->get_image("Pica pica")["image_url"] !== "image.jpg") exit(1);
    class CachedFlickr extends Flickr {
      public function __construct() { $this->set_db(); }
      public function store() {
        $this->set_image_in_db("Pica pica", "Magpie", "flickr.jpg", "Magpie", "pica", "author", "license");
      }
    }
    $provider = new CachedFlickr();
    $provider->store();
    if ($provider->get_image("Pica pica")["image_url"] !== "flickr.jpg") exit(1);
  '
  [ -s "$cache/wikipedia.db" ] || fail "SQLite cache was not written outside scripts"
  [ -s "$cache/flickr.db" ] || fail "Flickr cache was not written outside scripts"
  [ "$(cat "$repo/scripts/flickr.db")" = 'old cache is retained' ] \
    || fail "legacy cache was modified"
  [ ! -e "$repo/scripts/wikipedia.db" ] || fail "SQLite cache still created under scripts"
  if runuser -u caddy -- test -w "$repo/scripts"; then
    fail "scripts became writable by Caddy"
  fi
  /source/scripts/security_refresh.sh >/dev/null
  runuser -u caddy -- php -r '
    $db = new SQLite3("/var/lib/avian-visitors/image-cache/wikipedia.db");
    if ($db->querySingle("SELECT image_url FROM images") !== "image.jpg") exit(1);
  '
  mv "$cache" "$cache.saved"
  ln -s /tmp "$cache"
  if /source/scripts/security_refresh.sh >/dev/null 2>&1; then
    fail "refresh accepted an image cache symlink"
  fi
  rm -- "$cache"
  mv "$cache.saved" "$cache"
  chmod 0777 "$cache"
  if /source/scripts/security_refresh.sh >/dev/null 2>&1; then
    fail "refresh accepted a world-writable cache directory"
  fi
  ;;
esac

case "${1:-all}" in
cron|all)
  my_dir=/source
  USER=aviandiag
  sudo() { command "$@"; }
  for function_name in install_cron_template install_cleanup_cron install_weekly_cron install_automatic_update_cron; do
    eval "$(sed -n "/^$function_name() {/,/^}/p" /source/scripts/install_services.sh)"
  done
  eval "$(sed -n '/^remove_crons() {/,/^}/p' /source/scripts/uninstall.sh)"
  printf '1 2 * * * root /usr/local/bin/local-before\n' >/etc/crontab
  for repeat in 1 2; do
    install_cleanup_cron
    install_weekly_cron
    install_automatic_update_cron
  done
  printf '3 4 * * * root /usr/local/bin/local-after\n' >>/etc/crontab
  sed -i 's|^\*/5 |*/10 |;s|^0 3 \* \* 0 |15 8 * * 1 |' /etc/crontab
  cp /etc/crontab /tmp/avian-cron-customized
  install_cleanup_cron
  install_weekly_cron
  install_automatic_update_cron
  cmp -s /tmp/avian-cron-customized /etc/crontab \
    || fail "installer duplicated or overwrote an operator-customized schedule"
  awk '!/^#/ && NF { count++ } END { exit count != 8 }' /etc/crontab \
    || fail "cron fixture did not install exactly six managed jobs"
  sed -i 's|^\*/10 |  # */10 |;s|^@reboot |# @reboot |' /etc/crontab
  cp /etc/crontab /tmp/avian-cron-disabled
  install_cleanup_cron
  cmp -s /tmp/avian-cron-disabled /etc/crontab \
    || fail "installer re-enabled a commented-out managed job"
  remove_crons
  printf '1 2 * * * root /usr/local/bin/local-before\n3 4 * * * root /usr/local/bin/local-after\n' \
    >/tmp/avian-cron-expected
  cmp -s /tmp/avian-cron-expected /etc/crontab \
    || fail "uninstall left managed cron jobs or deleted unrelated jobs"
  ;;
esac
echo "generation runtime smoke: ok"
