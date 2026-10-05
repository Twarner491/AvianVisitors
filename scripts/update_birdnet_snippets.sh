#!/usr/bin/env bash
# Compatibility hook for the updater shipped before AvianVisitors v1. The old
# updater invokes this file as root after switching branches. Move immediately
# into the verified, root-owned surgical refresher; future updates do not use
# this hook.

set -euo pipefail
IFS=$'\n\t'
PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

[ "${EUID:-$(id -u)}" -eq 0 ] || { echo "update migration must run as root" >&2; exit 1; }
# Never install root executables from the station-owned checkout, even when
# its local Git index calls them clean. Fetch the bridge from the official tip.
umask 077
work_dir=$(mktemp -d /var/tmp/avian-legacy-bootstrap.XXXXXX)
trap 'rm -rf "$work_dir"' EXIT
trusted_repo=$work_dir/official.git
mkdir "$trusted_repo"
trusted_git() {
  env -i HOME=/root GIT_CONFIG_GLOBAL=/dev/null PATH=/usr/local/bin:/usr/bin:/bin \
    git -C "$trusted_repo" "$@"
}
trusted_git init --bare -q
trusted_git fetch --no-tags https://github.com/Twarner491/AvianVisitors.git \
  refs/heads/avian-visitors:refs/heads/avian-visitors
verified_head=$(trusted_git rev-parse --verify 'refs/heads/avian-visitors^{commit}')
trusted_git show "$verified_head:scripts/bootstrap_v1.sh" >"$work_dir/bootstrap.sh"
bash -n "$work_dir/bootstrap.sh"
bash "$work_dir/bootstrap.sh"
