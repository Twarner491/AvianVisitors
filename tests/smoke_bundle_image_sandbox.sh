#!/usr/bin/env bash
# Run as root in a disposable Debian container with CAP_SYS_ADMIN. Proves the
# production-only PNG worker can create a private network namespace, enter its
# empty chroot, drop to the isolated account, and still complete an install.

set -euo pipefail
IFS=$'\n\t'

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f /.dockerenv ] || fail 'refusing bundle sandbox smoke outside a container'
[ "${AVIAN_BUNDLE_SANDBOX_TEST:-0}" = 1 ] \
  || fail 'refusing bundle sandbox smoke without AVIAN_BUNDLE_SANDBOX_TEST=1'
[ "${EUID:-$(id -u)}" -eq 0 ] || fail 'bundle sandbox smoke must run as root'

apt-get -qq update
apt-get install --no-install-recommends -qqy python3 python3-pil >/dev/null

id avian-bundle >/dev/null 2>&1 \
  || useradd --system --user-group --home-dir /nonexistent \
    --shell /usr/sbin/nologin avian-bundle
install -d -o root -g root -m 0755 /var/empty /var/lib/avian-visitors \
  /usr/share/avian-visitors/bundles
install -d -o root -g root -m 0555 /var/empty/avian-bundle
install -o root -g root -m 0755 /source/avian/scripts/bundle_manager.py \
  /usr/local/sbin/avian-bundle-control

publication=/tmp/avian-bundle-sandbox-publication
PYTHONPATH=/source python3 - "$publication" <<'PY'
import json
import sys
from pathlib import Path

from tests.test_bundle_manager import BundleFixture, bundle_manager

publication = Path(sys.argv[1])
fixture = BundleFixture()
fixture.publish(publication)
catalog = Path('/usr/share/avian-visitors/bundles/catalog-v1.json')
catalog.write_bytes(bundle_manager.canonical_json(fixture.catalog))
catalog.chmod(0o644)
PY

/usr/local/sbin/avian-bundle-control initialize --json >/dev/null
AVIAN_BUNDLE_DEV_ROOT="$publication" \
  /usr/local/sbin/avian-bundle-control enqueue \
    --action install --id community-test-birds --activate --json >/dev/null

for _ in $(seq 1 40); do
  snapshot=$(/usr/local/sbin/avian-bundle-control snapshot --json)
  state=$(printf '%s' "$snapshot" | python3 -c \
    'import json,sys; print((json.load(sys.stdin).get("job") or {}).get("state", ""))')
  [ "$state" != succeeded ] || break
  [ "$state" != failed ] || {
    cat /var/lib/avian-visitors/bundles/operation.log >&2
    fail 'sandboxed image validation failed'
  }
  sleep 0.25
done
[ "$state" = succeeded ] || fail 'sandboxed bundle install did not finish'

printf '%s' "$snapshot" | python3 -c '
import json,sys
value=json.load(sys.stdin)
assert value["library"]["active"]["id"] == "community-test-birds"
assert value["job"]["current"] == value["job"]["total"] == 2
' || fail 'sandboxed bundle result is inconsistent'
[ -z "$(find /var/empty/avian-bundle -mindepth 1 -print -quit)" ] \
  || fail 'image sandbox wrote into its chroot'

echo 'bundle image sandbox smoke: ok'
