#!/usr/bin/env bash
# Pull Pi-generated bird art back into this Mac repo so it can be committed.
#
# The Pi's cron runs fillgaps.py and generates new illustrations + rebuilds
# the collage masks (apt.js) ON THE DEVICE. The live site serves those
# straight off the Pi's disk, so this sync is purely for backing the
# generated files up into the fork. It never deletes anything locally.
#
# Usage:
#   avian/scripts/sync-from-pi.sh           # pull files, then show git status
#   avian/scripts/sync-from-pi.sh --push    # pull, commit, and push to your branch
#
# Override the host/path with env vars if they ever change:
#   AV_PI=nate@192.168.1.223  AV_PI_AVIAN=/home/nate/BirdNET-Pi/avian
set -euo pipefail

PI="${AV_PI:-nate@192.168.1.223}"
PI_AVIAN="${AV_PI_AVIAN:-/home/nate/BirdNET-Pi/avian}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "Pulling illustrations + apt.js from $PI ..."
# No --delete: only add/update, never remove local files. Plain -a keeps
# this portable across GNU rsync and macOS's openrsync.
rsync -a "$PI:$PI_AVIAN/assets/illustrations/" \
  "$REPO/avian/assets/illustrations/"
rsync -a "$PI:$PI_AVIAN/frontend/apt.js" "$REPO/avian/frontend/apt.js"

cd "$REPO"
echo
echo "Changes now in the repo:"
git status --short avian/assets/illustrations avian/frontend/apt.js || true

if [ "${1:-}" != "--push" ]; then
  echo
  echo "Review above, then commit yourself, or re-run with --push to commit + push."
  exit 0
fi

git add avian/assets/illustrations avian/frontend/apt.js
if git diff --cached --quiet; then
  echo "Nothing new to push."
  exit 0
fi
n=$(git diff --cached --name-only --diff-filter=A -- avian/assets/illustrations \
    | grep -c '\.png$' || true)
branch="$(git branch --show-current)"
git commit -m "[ASSET] avian: sync ${n} new Pi-generated illustration file(s) + collage masks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git push origin "$branch"
echo "Pushed to origin/$branch."
