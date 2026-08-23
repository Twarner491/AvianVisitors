#!/usr/bin/env bash
# Run as root in a disposable Debian container with the repository at /source.
# Every scenario uses a real Git repository and a local transport rewrite while
# the checkout itself still records the production GitHub origin.

set -euo pipefail
IFS=$'\n\t'

fail() {
  echo "FAIL: $*" >&2
  [ ! -f "$case_log" ] || cat "$case_log" >&2
  exit 1
}

[ "${EUID:-$(id -u)}" -eq 0 ] || { echo 'run this smoke test as root' >&2; exit 1; }
command -v git >/dev/null
command -v runuser >/dev/null
command -v flock >/dev/null
command -v sha256sum >/dev/null

test_root=/tmp/avian-update-smoke
case_log=$test_root/current.log
official=https://github.com/Twarner491/AvianVisitors.git
rm -rf "$test_root"
mkdir -p "$test_root" /etc/birdnet /usr/local/sbin

cp /source/scripts/update_birdnet.sh /usr/local/sbin/avian-update-control
cat >/usr/local/sbin/avian-service-refresh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ ! -e /tmp/avian-update-smoke/refresh.fail ] || exit 23
[ "${AVIAN_UPDATE_LOCK_FD:-}" = 9 ] || exit 24
[ -e /proc/self/fd/9 ] || exit 25
[ "$(readlink -f /proc/self/fd/9)" = /run/lock/avian-update.lock ] || exit 26
flock -n 9 || exit 27
touch /tmp/avian-update-smoke/refresh.called
EOF
chown root:root /usr/local/sbin/avian-update-control /usr/local/sbin/avian-service-refresh
chmod 0755 /usr/local/sbin/avian-update-control /usr/local/sbin/avian-service-refresh

seed=$test_root/seed
remote=$test_root/remote.git
missing_remote=$test_root/missing.git
mkdir -p "$seed"
git -C "$seed" init -q -b main
git -C "$seed" config user.name 'Update smoke'
git -C "$seed" config user.email update@example.test
mkdir -p "$seed/avian/frontend"
printf 'base\n' >"$seed/version.txt"
git -C "$seed" add .
git -C "$seed" commit -qm base

git -C "$seed" switch -qc avian-visitors
mkdir -p "$seed/avian/frontend" "$seed/avian/assets/illustrations" \
  "$seed/avian/assets/cutouts"
printf 'one\n' >"$seed/version.txt"
printf '{"shared-bird":{"w":1,"h":1,"bits":"AA=="},"identical-bird":{"w":1,"h":1,"bits":"AA=="}}\n' \
  >"$seed/avian/frontend/masks.json"
printf '{"shared-bird":[1,1],"identical-bird":[1,1]}\n' \
  >"$seed/avian/frontend/dims.json"
printf 'official shared art\n' >"$seed/avian/assets/illustrations/shared-bird.png"
printf 'official identical art\n' >"$seed/avian/assets/illustrations/identical-bird.png"
printf 'official shared cutout\n' >"$seed/avian/assets/cutouts/shared-photo.png"
printf 'official collision\n' >"$seed/avian/legacy.txt"
printf 'fail-filter.txt filter=fail\n' >"$seed/.gitattributes"
printf 'filter content\n' >"$seed/fail-filter.txt"
git -C "$seed" add .
git -C "$seed" commit -qm release-one
release_one=$(git -C "$seed" rev-parse HEAD)
printf 'two\n' >"$seed/version.txt"
git -C "$seed" add version.txt
git -C "$seed" commit -qm release-two
release_two=$(git -C "$seed" rev-parse HEAD)
printf 'three\n' >"$seed/version.txt"
printf 'release-three shared art\n' >"$seed/avian/assets/illustrations/shared-bird.png"
printf 'release-three Swiss collision\n' >"$seed/avian/assets/illustrations/swiss-only.png"
printf '{"shared-bird":{"w":1,"h":1,"bits":"AA=="},"identical-bird":{"w":1,"h":1,"bits":"AA=="},"swiss-only":{"w":1,"h":1,"bits":"AA=="}}\n' \
  >"$seed/avian/frontend/masks.json"
printf '{"shared-bird":[1,1],"identical-bird":[1,1],"swiss-only":[1,1]}\n' \
  >"$seed/avian/frontend/dims.json"
git -C "$seed" add .
git -C "$seed" commit -qm release-three
release_three=$(git -C "$seed" rev-parse HEAD)

git clone -q --bare "$seed" "$remote"
git -C "$remote" update-ref refs/heads/avian-visitors "$release_two"
git -C "$remote" symbolic-ref HEAD refs/heads/main
git clone -q --bare "$seed" "$missing_remote"
git -C "$missing_remote" update-ref -d refs/heads/avian-visitors
git -C "$missing_remote" symbolic-ref HEAD refs/heads/main
chmod -R a+rX "$remote" "$missing_remote"

as_station() {
  local account=$1 station_home=$2
  shift 2
  runuser -u "$account" -- env HOME="$station_home" USER="$account" LOGNAME="$account" \
    PATH=/usr/local/bin:/usr/bin:/bin "$@"
}

setup_case() {
  local name=$1 start=$2 selected_remote=${3:-$remote} clone_mode=${4:-full}
  station_user=bird${name}
  station_home=$test_root/$name/home
  repo_dir=$station_home/BirdNET-Pi
  case_log=$test_root/$name.log
  rm -f /run/lock/avian-generation.lock
  id "$station_user" >/dev/null 2>&1 \
    || useradd -M -d "$station_home" -s /bin/bash "$station_user"
  mkdir -p "$station_home"
  chown "$station_user:$station_user" "$station_home"
  cat >/etc/gitconfig <<EOF
[url "file://$selected_remote"]
    insteadOf = $official
[safe]
    directory = $selected_remote
EOF
  case "$clone_mode" in
    full)
      as_station "$station_user" "$station_home" \
        git clone -q "$selected_remote" "$repo_dir"
      ;;
    shallow-main)
      as_station "$station_user" "$station_home" \
        git clone -q --depth=1 --branch main "file://$selected_remote" "$repo_dir"
      ;;
    *) fail "unknown clone mode: $clone_mode" ;;
  esac
  as_station "$station_user" "$station_home" \
    git -C "$repo_dir" remote set-url origin "$official"
  as_station "$station_user" "$station_home" git -C "$repo_dir" config user.name 'Station'
  as_station "$station_user" "$station_home" git -C "$repo_dir" config user.email station@example.test
  case "$start" in
    main) as_station "$station_user" "$station_home" git -C "$repo_dir" switch -q main ;;
    release-one)
      as_station "$station_user" "$station_home" \
        git -C "$repo_dir" switch -qc avian-visitors "$release_one"
      as_station "$station_user" "$station_home" \
        git -C "$repo_dir" branch --set-upstream-to=origin/avian-visitors avian-visitors >/dev/null
      ;;
    *) fail "unknown fixture start: $start" ;;
  esac
  cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=$station_user
AUTOMATIC_UPDATE=1
EOF
  rm -f "$test_root/refresh.called" "$test_root/refresh.fail"
}

expect_success() {
  : >"$case_log"
  /usr/local/sbin/avian-update-control >"$case_log" 2>&1 \
    || fail "$1 should have succeeded"
}

expect_failure() {
  : >"$case_log"
  if /usr/local/sbin/avian-update-control >"$case_log" 2>&1; then
    fail "$1 should have failed"
  fi
  [ ! -e "$test_root/refresh.called" ] \
    || fail "$1 reached the privileged refresh step"
}

setup_case clean release-one
expect_success 'clean fast-forward'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_two" ] \
  || fail 'clean update did not fast-forward to origin'
[ -e "$test_root/refresh.called" ] || fail 'clean update omitted service refresh'

setup_case automatic release-one
cat >/etc/birdnet/birdnet.conf <<EOF
BIRDNET_USER=$station_user
AUTOMATIC_UPDATE=0
touch $test_root/config-sourced
EOF
: >"$case_log"
/usr/local/sbin/avian-update-control -a >"$case_log" 2>&1 \
  || fail 'disabled automatic update should exit cleanly'
[ ! -e "$test_root/config-sourced" ] || fail 'BirdNET-Pi config was executed as shell code'
[ ! -e "$test_root/refresh.called" ] || fail 'disabled automatic update ran refresh'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_one" ] \
  || fail 'disabled automatic update moved HEAD'

setup_case generated release-one
printf 'local masks\n' >"$repo_dir/avian/frontend/masks.json"
printf 'local dims\n' >"$repo_dir/avian/frontend/dims.json"
chown "$station_user:$station_user" "$repo_dir/avian/frontend/"{masks,dims}.json
expect_success 'generated-index preservation'
grep -qx 'local masks' "$repo_dir/avian/frontend/masks.json" \
  || fail 'masks.json was not preserved'
grep -qx 'local dims' "$repo_dir/avian/frontend/dims.json" \
  || fail 'dims.json was not preserved'
backup_root=$station_home/.local/state/avian-visitors/update-backups
generated_backup=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$generated_backup" ] || fail 'generated files were not backed up'
(cd "$generated_backup" && sha256sum -c SHA256SUMS >/dev/null) \
  || fail 'generated backup checksum failed'

setup_case dirty release-one
printf 'local edit\n' >"$repo_dir/version.txt"
chown "$station_user:$station_user" "$repo_dir/version.txt"
dirty_head=$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)
expect_failure 'dirty tracked checkout'
[ "$(cat "$repo_dir/version.txt")" = 'local edit' ] || fail 'dirty file was changed'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$dirty_head" ] \
  || fail 'dirty checkout moved HEAD'

setup_case staged release-one
printf 'staged edit\n' >"$repo_dir/version.txt"
chown "$station_user:$station_user" "$repo_dir/version.txt"
as_station "$station_user" "$station_home" git -C "$repo_dir" add version.txt
expect_failure 'staged tracked checkout'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" diff --cached --name-only)" = version.txt ] \
  || fail 'staged change was not preserved'

setup_case deleted release-one
rm -f "$repo_dir/avian/frontend/masks.json"
expect_failure 'deleted generated file'
[ ! -e "$repo_dir/avian/frontend/masks.json" ] \
  || fail 'deleted generated file was recreated'

setup_case detached release-one
as_station "$station_user" "$station_home" git -C "$repo_dir" switch -q --detach
expect_failure 'detached checkout'

setup_case unsupported release-one
as_station "$station_user" "$station_home" git -C "$repo_dir" switch -qc custom
expect_failure 'unsupported branch'

setup_case locked release-one
install -o root -g root -m 0600 /dev/null /run/lock/avian-update.lock
exec 8<>/run/lock/avian-update.lock
flock -n 8 || fail 'could not hold update lock for test'
expect_failure 'concurrent update lock'
grep -q 'another update is already running' "$case_log" \
  || fail 'concurrent update error was unclear'
flock -u 8
exec 8>&-

setup_case generating release-one
generation_lock=/run/lock/avian-generation.lock
install -o root -g "$(id -g "$station_user")" -m 0660 /dev/null "$generation_lock"
generation_ready=$station_home/generation.ready
rm -f "$generation_ready"
as_station "$station_user" "$station_home" \
  flock "$generation_lock" sh -c "touch '$generation_ready'; sleep 10" &
generation_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "$generation_ready" ] && break
  sleep 0.1
done
[ -e "$generation_ready" ] || fail 'could not hold the generation lock'
expect_failure 'active illustration generation'
grep -q 'bird illustration generation is running' "$case_log" \
  || fail 'generation-lock error was unclear'
kill "$generation_pid" 2>/dev/null || true
wait "$generation_pid" 2>/dev/null || true

setup_case generationhandoff release-one
install -o root -g "$(id -g "$station_user")" -m 0660 /dev/null "$generation_lock"
printf '{"running":true,"at":%s}\n' "$(date +%s)" \
  >"$repo_dir/avian/assets/illustrations/.generate.state.json"
chown "$station_user:$station_user" \
  "$repo_dir/avian/assets/illustrations/.generate.state.json"
expect_failure 'illustration worker handoff'
grep -q 'bird illustration generation is starting' "$case_log" \
  || fail 'generation-handoff error was unclear'
printf '{"running":true,"at":1}\n' \
  >"$repo_dir/avian/assets/illustrations/.generate.state.json"
expect_success 'stale generation handoff'

setup_case unsafegenerationlock release-one
ln -s /etc/passwd /run/lock/avian-generation.lock
expect_failure 'unsafe illustration generation lock'
grep -q 'illustration generation lock is unsafe' "$case_log" \
  || fail 'unsafe generation-lock error was unclear'
rm -f /run/lock/avian-generation.lock

setup_case hardlinkedgenerationlock release-one
generation_lock_peer=/run/lock/avian-generation-lock-peer
rm -f "$generation_lock_peer"
install -o root -g "$(id -g "$station_user")" -m 0660 /dev/null \
  "$generation_lock_peer"
ln "$generation_lock_peer" /run/lock/avian-generation.lock
expect_failure 'hard-linked illustration generation lock'
grep -q 'illustration generation lock is unsafe' "$case_log" \
  || fail 'hard-linked generation-lock error was unclear'
rm -f /run/lock/avian-generation.lock "$generation_lock_peer"

setup_case missinghelper release-one
cp /usr/local/sbin/avian-service-refresh "$test_root/service-refresh.saved"
rm -f /usr/local/sbin/avian-service-refresh
expect_failure 'missing service refresher'
cp "$test_root/service-refresh.saved" /usr/local/sbin/avian-service-refresh
chown root:root /usr/local/sbin/avian-service-refresh
chmod 0755 /usr/local/sbin/avian-service-refresh

setup_case unsafehelper release-one
chmod 0775 /usr/local/sbin/avian-service-refresh
expect_failure 'unsafe service refresher'
chmod 0755 /usr/local/sbin/avian-service-refresh

setup_case origin release-one
as_station "$station_user" "$station_home" \
  git -C "$repo_dir" remote set-url origin https://example.test/not-official.git
expect_failure 'wrong origin'
grep -q 'origin must be' "$case_log" || fail 'wrong origin error was unclear'

setup_case transport release-one
as_station "$station_user" "$station_home" git -C "$repo_dir" config \
  url."file://$test_root/not-official.git".insteadOf "$official"
expect_failure 'local transport rewrite'
grep -q 'local Git transport setting is not allowed' "$case_log" \
  || fail 'local transport rewrite error was unclear'

setup_case worktreecfg release-one
as_station "$station_user" "$station_home" git -C "$repo_dir" config \
  extensions.worktreeConfig true
as_station "$station_user" "$station_home" git -C "$repo_dir" config --worktree \
  remote.origin.proxy proxy-command
expect_failure 'worktree transport setting'
grep -q 'local Git transport setting is not allowed' "$case_log" \
  || fail 'worktree transport setting error was unclear'

setup_case globalignored release-one
as_station "$station_user" "$station_home" git config --global \
  url."file://$test_root/not-official.git".insteadOf "$official"
expect_success 'ignored user-level transport rewrite'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_two" ] \
  || fail 'user-level transport rewrite affected the verified fetch'

setup_case refspec release-one
as_station "$station_user" "$station_home" git -C "$repo_dir" config \
  remote.origin.fetch '+refs/heads/main:refs/remotes/origin/avian-visitors'
as_station "$station_user" "$station_home" git -C "$repo_dir" update-ref \
  refs/remotes/origin/avian-visitors "$release_one"
expect_success 'tampered default refspec'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_two" ] \
  || fail 'default refspec redirected the release fetch'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" \
  config --get-all remote.origin.fetch)" \
  = '+refs/heads/avian-visitors:refs/remotes/origin/avian-visitors' ] \
  || fail 'tampered default refspec survived the verified update'

setup_case wrapperauto release-one
cp /source/scripts/update_birdnet.sh "$station_home/update-wrapper.sh"
chown "$station_user:$station_user" "$station_home/update-wrapper.sh"
chmod 0755 "$station_home/update-wrapper.sh"
cat >/etc/sudoers.d/avian-update-smoke <<EOF
$station_user ALL=(root) NOPASSWD: /usr/local/sbin/avian-update-control -a
EOF
chmod 0440 /etc/sudoers.d/avian-update-smoke
visudo -cf /etc/sudoers.d/avian-update-smoke >/dev/null
: >"$case_log"
as_station "$station_user" "$station_home" "$station_home/update-wrapper.sh" -a \
  >"$case_log" 2>&1 || fail 'station-user automatic wrapper failed'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_two" ] \
  || fail 'station-user wrapper did not update through fixed root helper'
[ -e "$test_root/refresh.called" ] \
  || fail 'station-user wrapper omitted service refresh'
rm -f /etc/sudoers.d/avian-update-smoke

setup_case missing main "$missing_remote"
expect_failure 'missing release ref'
grep -q 'could not fetch origin/avian-visitors' "$case_log" \
  || fail 'missing ref error was unclear'

setup_case divergent release-one
printf 'local commit\n' >"$repo_dir/local.txt"
chown "$station_user:$station_user" "$repo_dir/local.txt"
as_station "$station_user" "$station_home" git -C "$repo_dir" add local.txt
as_station "$station_user" "$station_home" git -C "$repo_dir" commit -qm divergent
divergent_head=$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)
expect_failure 'divergent release branch'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$divergent_head" ] \
  || fail 'divergent checkout moved HEAD'

setup_case fetchfail release-one
cat >/etc/gitconfig <<EOF
[url "file://$test_root/not-there.git"]
    insteadOf = $official
EOF
expect_failure 'fetch failure'

setup_case badartindexes release-one
printf 'preflight must preserve this art\n' \
  >"$repo_dir/avian/assets/illustrations/shared-bird.png"
printf '{"different-bird":{"w":2,"h":2,"bits":"AA=="}}\n' \
  >"$repo_dir/avian/frontend/masks.json"
printf '{"different-bird":[2,2]}\n' >"$repo_dir/avian/frontend/dims.json"
chown "$station_user:$station_user" \
  "$repo_dir/avian/assets/illustrations/shared-bird.png" \
  "$repo_dir/avian/frontend/masks.json" "$repo_dir/avian/frontend/dims.json"
bad_indexes_head=$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" rev-parse HEAD)
expect_failure 'custom illustration with stale generated indexes'
grep -q 'masks.json is missing custom illustration: shared-bird' "$case_log" \
  || fail 'stale custom-index error was unclear'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" \
  = "$bad_indexes_head" ] \
  || fail 'custom-index preflight failure moved HEAD'
grep -qx 'preflight must preserve this art' \
  "$repo_dir/avian/assets/illustrations/shared-bird.png" \
  || fail 'custom-index preflight failure changed local art'
grep -q '"different-bird"' "$repo_dir/avian/frontend/masks.json" \
  || fail 'custom-index preflight failure changed masks.json'
grep -q '"different-bird"' "$repo_dir/avian/frontend/dims.json" \
  || fail 'custom-index preflight failure changed dims.json'

setup_case standardrollback release-one
printf '{"shared-bird":{"w":2,"h":2,"bits":"AA=="}}\n' \
  >"$repo_dir/avian/frontend/masks.json"
printf '{"shared-bird":[2,2]}\n' >"$repo_dir/avian/frontend/dims.json"
printf 'rollback custom art\n' >"$repo_dir/avian/assets/illustrations/shared-bird.png"
chown "$station_user:$station_user" \
  "$repo_dir/avian/frontend/masks.json" "$repo_dir/avian/frontend/dims.json" \
  "$repo_dir/avian/assets/illustrations/shared-bird.png"
cat >"$repo_dir/.git/hooks/post-merge" <<EOF
#!/usr/bin/env bash
touch "$repo_dir/.git/config.lock"
EOF
chown "$station_user:$station_user" "$repo_dir/.git/hooks/post-merge"
chmod 0755 "$repo_dir/.git/hooks/post-merge"
expect_failure 'release-branch rollback'
rm -f "$repo_dir/.git/config.lock"
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_one" ] \
  || fail 'failed release update did not restore its branch ref'
grep -qx 'one' "$repo_dir/version.txt" \
  || fail 'failed release update did not restore its worktree'
grep -q '"shared-bird"' "$repo_dir/avian/frontend/masks.json" \
  || fail 'failed release update did not restore generated data'
grep -q '"shared-bird"' "$repo_dir/avian/frontend/dims.json" \
  || fail 'failed release update did not restore generated dimensions'
grep -qx 'rollback custom art' \
  "$repo_dir/avian/assets/illustrations/shared-bird.png" \
  || fail 'failed release update did not restore custom bird art'

setup_case repair release-one
touch "$test_root/refresh.fail"
expect_failure 'post-update refresh failure'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_two" ] \
  || fail 'successful Git update was rolled back after refresh failure'
rm -f "$test_root/refresh.fail"
expect_success 'up-to-date service repair'
grep -q 'Already up to date.' "$case_log" \
  || fail 'repair rerun did not recognize current checkout'
[ -e "$test_root/refresh.called" ] \
  || fail 'up-to-date rerun did not repair services'

setup_case artwithoutindexes main
mkdir -p "$repo_dir/avian/assets/illustrations"
printf 'local Swiss art\n' >"$repo_dir/avian/assets/illustrations/shared-bird.png"
chown -R "$station_user:$station_user" "$repo_dir/avian"
expect_failure 'custom illustration without generated indexes'
grep -q 'custom illustrations require local masks.json and dims.json' "$case_log" \
  || fail 'missing custom-index error was unclear'
[ "$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" branch --show-current)" = main ] \
  || fail 'custom-index refusal switched branches'
grep -qx 'local Swiss art' "$repo_dir/avian/assets/illustrations/shared-bird.png" \
  || fail 'custom-index refusal changed local art'

setup_case identicalart main
mkdir -p "$repo_dir/avian/assets/illustrations"
printf 'official identical art\n' \
  >"$repo_dir/avian/assets/illustrations/identical-bird.png"
chown -R "$station_user:$station_user" "$repo_dir/avian"
expect_success 'byte-identical illustration collision'
[ "$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" branch --show-current)" = avian-visitors ] \
  || fail 'byte-identical collision did not migrate'
as_station "$station_user" "$station_home" git -C "$repo_dir" diff --quiet -- \
  avian/assets/illustrations/identical-bird.png \
  || fail 'byte-identical collision became a dirty override'

setup_case legacy main
mkdir -p "$repo_dir/avian/frontend" "$repo_dir/avian/assets/illustrations" \
  "$repo_dir/avian/assets/cutouts" "$repo_dir/custom"
printf 'legacy local copy\n' >"$repo_dir/avian/legacy.txt"
printf '{"shared-bird":{"w":2,"h":2,"bits":"AA=="},"identical-bird":{"w":1,"h":1,"bits":"AA=="},"swiss-only":{"w":2,"h":2,"bits":"AA=="}}\n' \
  >"$repo_dir/avian/frontend/masks.json"
printf '{"shared-bird":[2,2],"identical-bird":[1,1],"swiss-only":[2,2]}\n' \
  >"$repo_dir/avian/frontend/dims.json"
printf 'local Swiss shared art\n' \
  >"$repo_dir/avian/assets/illustrations/shared-bird.png"
printf 'official identical art\n' \
  >"$repo_dir/avian/assets/illustrations/identical-bird.png"
printf 'local Swiss-only art\n' \
  >"$repo_dir/avian/assets/illustrations/swiss-only.png"
printf 'local German shared cutout\n' \
  >"$repo_dir/avian/assets/cutouts/shared-photo.png"
printf 'local German-only cutout\n' \
  >"$repo_dir/avian/assets/cutouts/german-only.png"
printf 'keep inside avian\n' >"$repo_dir/avian/custom-local.txt"
printf 'keep inside frontend\n' >"$repo_dir/avian/frontend/custom-local.json"
printf 'keep me\n' >"$repo_dir/custom/notes.txt"
chown -R "$station_user:$station_user" "$repo_dir/avian" "$repo_dir/custom"
expect_success 'legacy migration'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" branch --show-current)" = avian-visitors ] \
  || fail 'legacy migration did not select release branch'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$release_two" ] \
  || fail 'legacy migration did not reach the fetched release commit'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" \
  rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" = origin/avian-visitors ] \
  || fail 'legacy migration did not set the release upstream'
grep -qx 'official collision' "$repo_dir/avian/legacy.txt" \
  || fail 'release file did not replace legacy collision'
grep -q '"swiss-only"' "$repo_dir/avian/frontend/masks.json" \
  || fail 'legacy masks.json was not preserved'
grep -q '"swiss-only"' "$repo_dir/avian/frontend/dims.json" \
  || fail 'legacy dims.json was not preserved'
grep -qx 'local Swiss shared art' \
  "$repo_dir/avian/assets/illustrations/shared-bird.png" \
  || fail 'modified regional illustration collision was not preserved'
grep -qx 'official identical art' \
  "$repo_dir/avian/assets/illustrations/identical-bird.png" \
  || fail 'byte-identical regional illustration collision was not preserved'
grep -qx 'local Swiss-only art' \
  "$repo_dir/avian/assets/illustrations/swiss-only.png" \
  || fail 'unique regional illustration was not preserved'
grep -qx 'local German shared cutout' \
  "$repo_dir/avian/assets/cutouts/shared-photo.png" \
  || fail 'modified regional cutout collision was not preserved'
grep -qx 'local German-only cutout' \
  "$repo_dir/avian/assets/cutouts/german-only.png" \
  || fail 'unique regional cutout was not preserved'
grep -qx 'keep inside avian' "$repo_dir/avian/custom-local.txt" \
  || fail 'noncolliding file inside a release directory was not preserved'
grep -qx 'keep inside frontend' "$repo_dir/avian/frontend/custom-local.json" \
  || fail 'nested noncolliding file was not preserved'
grep -qx 'keep me' "$repo_dir/custom/notes.txt" \
  || fail 'unrelated untracked file was not preserved'
legacy_backup=$(find "$station_home/.local/state/avian-visitors/update-backups" \
  -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$legacy_backup" ] || fail 'legacy collision backup was not created'
(cd "$legacy_backup" && sha256sum -c SHA256SUMS >/dev/null) \
  || fail 'legacy backup checksum failed'
mkdir -p "$test_root/legacy-restore"
tar -C "$test_root/legacy-restore" -xf "$legacy_backup/legacy-collisions.tar"
grep -qx 'legacy local copy' "$test_root/legacy-restore/avian/legacy.txt" \
  || fail 'legacy backup did not preserve the collided file'
tar -C "$test_root/legacy-restore" -xf "$legacy_backup/custom-bird-art.tar"
grep -qx 'local Swiss shared art' \
  "$test_root/legacy-restore/avian/assets/illustrations/shared-bird.png" \
  || fail 'custom-art backup did not preserve the modified collision'
grep -qx 'local German shared cutout' \
  "$test_root/legacy-restore/avian/assets/cutouts/shared-photo.png" \
  || fail 'custom-art backup did not preserve the cutout collision'

# The next release updates an already-overridden tracked illustration and starts
# tracking a formerly unique Swiss file. Both local assets must remain active.
git -C "$remote" update-ref refs/heads/avian-visitors "$release_three"
expect_success 'subsequent update with regional overrides'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" \
  = "$release_three" ] \
  || fail 'subsequent regional update did not reach the new release'
grep -qx 'local Swiss shared art' \
  "$repo_dir/avian/assets/illustrations/shared-bird.png" \
  || fail 'subsequent update replaced a tracked regional override'
grep -qx 'local Swiss-only art' \
  "$repo_dir/avian/assets/illustrations/swiss-only.png" \
  || fail 'subsequent update replaced a newly colliding regional illustration'
grep -qx 'local German shared cutout' \
  "$repo_dir/avian/assets/cutouts/shared-photo.png" \
  || fail 'subsequent update replaced a tracked regional cutout override'
grep -qx 'local German-only cutout' \
  "$repo_dir/avian/assets/cutouts/german-only.png" \
  || fail 'subsequent update changed a unique regional cutout'
grep -q '"swiss-only"' "$repo_dir/avian/frontend/masks.json" \
  || fail 'subsequent update replaced regional masks.json'
grep -q '"swiss-only"' "$repo_dir/avian/frontend/dims.json" \
  || fail 'subsequent update replaced regional dims.json'
git -C "$remote" update-ref refs/heads/avian-visitors "$release_two"

# Model a legacy Pi that first cloned main at depth one, then shallow-fetched
# an early AvianVisitors release. Both boundaries remain in .git/shallow, so a
# normal fetch of a later release cannot prove that main is its ancestor.
git -C "$remote" update-ref refs/heads/avian-visitors "$release_one"
setup_case shallowlegacy main "$remote" shallow-main
as_station "$station_user" "$station_home" git -C "$repo_dir" fetch -q \
  --no-tags --depth=1 origin \
  refs/heads/avian-visitors:refs/remotes/origin/avian-visitors
git -C "$remote" update-ref refs/heads/avian-visitors "$release_two"
[ "$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" rev-parse --is-shallow-repository)" = true ] \
  || fail 'shallow legacy fixture is not shallow'
[ "$(wc -l <"$repo_dir/.git/shallow")" -eq 2 ] \
  || fail 'shallow legacy fixture does not have both history boundaries'
if as_station "$station_user" "$station_home" git -C "$repo_dir" \
  merge-base --is-ancestor main origin/avian-visitors; then
  fail 'shallow legacy fixture did not hide the valid ancestor'
fi
mkdir -p "$repo_dir/avian/frontend"
printf 'shallow legacy masks\n' >"$repo_dir/avian/frontend/masks.json"
printf 'shallow legacy dims\n' >"$repo_dir/avian/frontend/dims.json"
chown -R "$station_user:$station_user" "$repo_dir/avian"
expect_success 'shallow legacy migration'
[ "$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" rev-parse --is-shallow-repository)" = false ] \
  || fail 'shallow legacy migration did not complete the history'
[ "$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" branch --show-current)" = avian-visitors ] \
  || fail 'shallow legacy migration did not select the release branch'
[ "$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" rev-parse HEAD)" = "$release_two" ] \
  || fail 'shallow legacy migration did not reach the fetched release commit'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" \
  config --get-all remote.origin.fetch)" \
  = '+refs/heads/avian-visitors:refs/remotes/origin/avian-visitors' ] \
  || fail 'shallow legacy migration did not constrain its future fetches'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" \
  rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" \
  = origin/avian-visitors ] \
  || fail 'shallow legacy migration did not set the release upstream'
grep -qx 'shallow legacy masks' "$repo_dir/avian/frontend/masks.json" \
  || fail 'shallow legacy migration did not preserve masks.json'
grep -qx 'shallow legacy dims' "$repo_dir/avian/frontend/dims.json" \
  || fail 'shallow legacy migration did not preserve dims.json'

setup_case refrollback main
as_station "$station_user" "$station_home" git -C "$repo_dir" config \
  remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'
cat >/usr/local/bin/git <<'EOF'
#!/bin/sh
if [ "${1:-}" = -C ] && [ "${3:-}" = branch ] \
  && [ "${4:-}" = --set-upstream-to=origin/avian-visitors ]; then
  exit 73
fi
exec /usr/bin/git "$@"
EOF
chmod 0755 /usr/local/bin/git
expect_failure 'fetch mapping rollback'
rm -f /usr/local/bin/git
[ "$(as_station "$station_user" "$station_home" \
  git -C "$repo_dir" branch --show-current)" = main ] \
  || fail 'fetch mapping failure did not restore main'
if as_station "$station_user" "$station_home" git -C "$repo_dir" \
  show-ref --verify --quiet refs/heads/avian-visitors; then
  fail 'fetch mapping failure left its release branch'
fi
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" \
  config --get-all remote.origin.fetch)" \
  = '+refs/heads/main:refs/remotes/origin/main' ] \
  || fail 'failed migration did not restore the original fetch mapping'

setup_case rollback main
mkdir -p "$repo_dir/avian/frontend" "$repo_dir/avian/assets/illustrations" \
  "$repo_dir/avian/assets/cutouts" "$repo_dir/custom"
printf 'restore this copy\n' >"$repo_dir/avian/legacy.txt"
printf '{"shared-bird":{"w":2,"h":2,"bits":"AA=="}}\n' \
  >"$repo_dir/avian/frontend/masks.json"
printf '{"shared-bird":[2,2]}\n' >"$repo_dir/avian/frontend/dims.json"
printf 'restore custom Swiss art\n' \
  >"$repo_dir/avian/assets/illustrations/shared-bird.png"
printf 'restore custom German cutout\n' \
  >"$repo_dir/avian/assets/cutouts/shared-photo.png"
printf 'keep this too\n' >"$repo_dir/custom/notes.txt"
chown -R "$station_user:$station_user" "$repo_dir/avian" "$repo_dir/custom"
cat >"$repo_dir/.git/hooks/post-merge" <<EOF
#!/usr/bin/env bash
touch "$repo_dir/.git/config.lock"
EOF
chown "$station_user:$station_user" "$repo_dir/.git/hooks/post-merge"
chmod 0755 "$repo_dir/.git/hooks/post-merge"
rollback_head=$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)
expect_failure 'legacy switch rollback'
rm -f "$repo_dir/.git/config.lock"
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" branch --show-current)" = main ] \
  || fail 'failed migration did not restore main branch'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" rev-parse HEAD)" = "$rollback_head" ] \
  || fail 'failed migration moved the legacy HEAD'
if as_station "$station_user" "$station_home" git -C "$repo_dir" \
  show-ref --verify --quiet refs/heads/avian-visitors; then
  fail 'failed migration left its newly created release branch'
fi
grep -qx 'restore this copy' "$repo_dir/avian/legacy.txt" \
  || fail 'failed migration did not restore collision'
grep -q '"shared-bird"' "$repo_dir/avian/frontend/masks.json" \
  || fail 'failed migration did not restore masks.json'
grep -q '"shared-bird"' "$repo_dir/avian/frontend/dims.json" \
  || fail 'failed migration did not restore dims.json'
grep -qx 'restore custom Swiss art' \
  "$repo_dir/avian/assets/illustrations/shared-bird.png" \
  || fail 'failed migration did not restore custom illustration collision'
grep -qx 'restore custom German cutout' \
  "$repo_dir/avian/assets/cutouts/shared-photo.png" \
  || fail 'failed migration did not restore custom cutout collision'
grep -qx 'keep this too' "$repo_dir/custom/notes.txt" \
  || fail 'failed migration changed unrelated file'

setup_case existingrollback main
as_station "$station_user" "$station_home" git -C "$repo_dir" branch \
  avian-visitors "$release_one"
mkdir -p "$repo_dir/avian/frontend"
printf 'existing branch masks\n' >"$repo_dir/avian/frontend/masks.json"
chown -R "$station_user:$station_user" "$repo_dir/avian"
cat >"$repo_dir/.git/hooks/post-merge" <<EOF
#!/usr/bin/env bash
touch "$repo_dir/.git/config.lock"
EOF
chown "$station_user:$station_user" "$repo_dir/.git/hooks/post-merge"
chmod 0755 "$repo_dir/.git/hooks/post-merge"
expect_failure 'preexisting legacy release rollback'
rm -f "$repo_dir/.git/config.lock"
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" branch --show-current)" = main ] \
  || fail 'failed preexisting-branch migration did not restore main'
[ "$(as_station "$station_user" "$station_home" git -C "$repo_dir" \
  rev-parse refs/heads/avian-visitors)" = "$release_one" ] \
  || fail 'failed migration did not restore the preexisting release ref'
grep -qx 'existing branch masks' "$repo_dir/avian/frontend/masks.json" \
  || fail 'failed preexisting-branch migration did not restore generated data'

echo 'update smoke: ok'
