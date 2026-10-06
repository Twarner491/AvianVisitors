# BirdFrame acceptance: 2026-10-03

Release candidate tested on the physical ARM64 BirdFrame running Debian 13 and Python 3.13.5. No release, tag, push, or commit was created. The October 3 results below do not certify the still-unintegrated October 6 release tree.

## October 6 switch for filming

At approximately 10:11 PDT on October 6, `sudo avian-bundle use official-western-us-impressionist --json` on the existing frame reported `ok: true`, `changed: true`, and a completed panel update. This switched artwork; it did not upgrade frame software.

- Installed-artwork readback verified 216 species and 432 images, totaling 194,048,832 bytes, from the 333-species official manifest.
- Manifest revision: `e069f2ee62cef44d923e136d8eb2011b36ef45d1da46a4cc441ef1916fc3a402`.
- Selection revision: `6bae141ed3c77306fcea51e4d02a1b2e8a272bd2a8ca34cecbdf226bd2263fd3`.
- Config SHA-256 was identical before and after: `73f881c8707aafb38b9d26089085ede8586454067c76caf94bca4ab2a15ae6cf`.
- The actual `birdframe.timer` was enabled and listed a recent 10:11:03 trigger.

Impressionist is selected for filming at this checkpoint. The panel update is software-confirmed; the recorded human visual acceptance remains October 3. These checks do not close upstream integration, mobile QA, or final release-tree testing. The private receipt is `.avian/physical-frame-20261006.md` in the main workspace; do not include it in release source or assets.

## Verified on October 3

- Backed up the original frame source, Python environment, frontend, settings, display state, service units, and boot configuration. Both archives passed SHA-256 checks on the frame and on the laptop.
- Installed the candidate as the existing setup account. The config stayed byte-for-byte unchanged, including source, location, names, rotation, and saturation.
- Verified the root-owned launcher, setup-account binding, private service environment, and no-new-privileges setting. Invalid invoking identities, direct root checkout execution, and root installer execution were rejected.
- Downloaded both official bundles from the live service using the frame's saved location. Each selected 212 of 333 species, with both poses: 424 images per bundle.
- Independently verified every selected image. Woodblock: 273,732,164 bytes. Impressionist: 190,757,142 bytes.
- Installed Impressionist and completed a real panel refresh. Repeating the command preserved the selection, display state, and config without another refresh.
- Rejected an untrusted manifest URL without changing the active selection, display state, or config.
- Rolled back to Woodblock and completed another real panel refresh.
- Observed a startup redraw racing a later capture. The invalid capture was rejected; the command restored Woodblock and refreshed the previous artwork. No incomplete capture was sent to the panel.
- Installed the independently reviewed, bounded retry fix and successfully refreshed the physical panel with Impressionist again. The final captured image contains all ten birds and labels.
- Repeated the install and invalid-link tests after the fix. Both preserved the exact config, display state, and active selection.
- Ran the systemd service successfully (`Result=success`, `ExecMainStatus=0`); it correctly skipped unchanged artwork. Restored the enabled, active refresh timer and observed its first automatic run pass at 11:44 PDT, with the next run scheduled 15 minutes later. Final device checks showed no throttling, 43.5 C, and 49 GB free.
- Teddy visually accepted the physical Impressionist panel. Restored Woodblock for filming, completed a physical refresh, and verified artwork integrity. The config remained byte-for-byte unchanged and the refresh timer remained enabled.

## October 3 acceptance gates

- [x] Verify the bounded capture-retry fix on the physical frame.
- [x] Confirm the physical Impressionist panel visually.
- [x] Restore Woodblock for filming, verify integrity, and leave the scheduled service enabled.
- [x] Fast-forward the release baseline to then-current upstream `265d7e7f` while preserving the uncommitted candidate.
- [x] Record the October 3 post-integration local test gates in the release checklist. Integration of later upstream `543c4473` and fresh affected gates remain open.

## Supporting checks

These are the recorded acceptance runs. Final post-integration local results are in the [release checklist](RELEASE_CHECKLIST.md); candidate GitHub CI still requires an approved branch push.

- Physical ARM64 unit tests: 62 passed, 13 privilege/environment skips.
- Isolated Linux frame suite: 118 passed, one expected skip.
- Final candidate Python suite with `PYTHONPATH` unset: 562 passed, 59 expected skips. The seven audio-analysis tests passed separately in isolated ARM64 Linux with Python 3.11 and real `tflite-runtime` 2.14.0, including model inference against the checked-in WAV. Combined: 569 distinct tests passed. The bundle's annual LiteRT model also ran successfully on the physical device.
- Installer, reinstall, pre-v1 upgrade, generation/cache/cron, and lock-policy container smokes passed. Independent reviews found no remaining security findings in those changes.
- Capture and bundle regression suite: 75 passed, 12 expected privilege skips, independently reproduced. All three real Chromium tests passed, covering stalled images, complete image decoding, and late startup redraws. Retries have a three-attempt limit and one shared deadline; failures preserve the previous output and metadata.
- Read-only production smoke verified the live catalog and feeds, four official manifests, and nine representative immutable objects. This was not a new full-store audit.
- The localhost Atlas rendered both Impressionist poses in the expanded left panel.

## Recovery and evidence

Private backups and captured output are under `.avian/physical-frame-20261003/` in the main local workspace. The matching backup remains on the frame. Credentials are not included in release notes or command logs.

Final renderer SHA-256: `26f35708d45a30ba161ec08f72765d0fb75b6dcc6bf0a96031da6d39a0f0eca4`, identical on the laptop and frame. `impressionist-final-capture.png` is the renderer output, not a photograph of the panel. Backups cover application files, environment, and configuration, not a full operating-system snapshot.

The tested station-install manifest hashes are:

- Woodblock: `019d21f5f54b1a68a4510b089544eb7316a3db54dfd37fc129b950eeeffa591f`
- Impressionist: `e069f2ee62cef44d923e136d8eb2011b36ef45d1da46a4cc441ef1916fc3a402`

See [source evidence](SOURCE_EVIDENCE.md) for the candidate baseline and earlier release gates.
