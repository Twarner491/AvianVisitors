# Avian Visitors v1.1.0 commit map

Owner review is complete. The candidate history was preserved, and the approved delta was committed in focused groups without rewriting earlier work.

## Existing candidate history

- Atlas and postcard follow-up: `9a571f88` through `16c7217d`, including the full-life-list option, postcard-title descender fix, approved-issue guard, updater preservation, and tests prompted by #75.
- Raspberry Pi setup fixes: `817c7de0`, covering the `tmp.mount` and direct ALSA reports in #78 and #79.
- Woodhouse's Scrub-Jay art: `a0457c10` and `96374c45`, prompted by #80.
- Local administrator protection: `ad120002`, `6bdbdb43`, `55126a9c`, and `2d6d38a2`, prompted by #71.
- Sharing and access foundation: `39593d06`, `9b950207`, `c97d7a29`, and `92abe2f6`.

## Owner-approved delta

1. `0af62a36 fix(birdweather): make station sharing explicit and recoverable`
   - Normalizes one optional token prefix, verifies strict remote response shapes, rejects path segments, and keeps patch responses canonical.
   - Preserves separate sharing, recording-upload, and privacy choices with focused PHP and Python coverage.

2. `0f10744f fix(atlas): preserve stamp label descenders`
   - Reserves space below shared-family stamp headings for letters such as g, p, and y.
   - Refreshes the guarded stylesheet key and adds the #76 regression.

3. `360b1f41 feat(frontend): refine settings and offer classic Atlas`
   - Brings station identity, local access, BirdWeather, Nightly Drive, and recording retention into one compact autosaving Settings surface.
   - Adds accessible theme icons, a standard bird-name switch, Classic Atlas cards, current postcard behavior, and bounded audio handling.

4. `b740fcab fix(caddy): reject the filesystem root as a webroot`
   - Rejects `EXTRACTED=/` before rendering Caddy configuration and covers the exact unsafe value.

5. `abe9fda9 test(release): cover version 1.1 integration boundaries`
   - Gates destructive install tests, pins the four-item administrator menu, and proves deferred endpoints remain closed.

6. `docs(release): prepare Avian Visitors v1.1.0`
   - Adds the pull-request body, release notes, seven reviewed photographs, upgrade guidance, credits, and publication checks.

## Release checks

- Inspect each complete staged patch and run `git diff --cached --check` before committing.
- Run the focused suite for each implementation group, then rerun the complete matrix from a clean worktree.
- Target the repository's production branch, `avian-visitors`.
- Upload all seven JPGs with the `v1.1.0` release and verify every published asset returns HTTP 200.
