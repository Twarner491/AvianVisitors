# Avian Visitors v1.3.0 release checklist

Teddy authorized staging, branch pushes, squash merging into `avian-visitors`, and the v1.3.0 release on October 6. Worker deployment, private acceptance changes, social posts, and new contributor messages remain outside this release.

## Current release gates: 2026-10-06

- [x] Integrate upstream `543c44734d65d0769e18d9aa6463ef2d8ccf7a7d` into `alpha/bundles-v1.3.0`, preserving upstream fixes and bundle work. Keep recovery stash `a94b8c036b537af9410cd2c7924a20d5ff491422` and the private source backup.
- [x] Record Teddy's October 6 iPhone Safari acceptance. No mobile code fix is claimed; the earlier Chrome/Firefox report was not independently reproduced.
- [x] Switch the existing physical frame to Impressionist for filming on October 6 and verify installed artwork, unchanged config, and the enabled `birdframe.timer`. This was a software-confirmed panel update, not a software upgrade or fresh human visual acceptance; see [physical acceptance](PHYSICAL_FRAME_ACCEPTANCE.md).
- [x] Record fresh post-integration test results and independently review the explicit 195-file source inventory. Thirteen excluded local media drafts remain untouched; only three approved photos are included.
- [ ] Recheck both [station](PULL_REQUEST.md) and [Worker](WORKER_PULL_REQUEST.md) PR drafts against their final owning-repository diffs.

October 6 Worker checks passed 229 JavaScript tests, four uploader tests, 12 preview checks, and 52 HTTP checks with zero failures. A read-only public-discovery check found Germany and Iberia installable at `1.0.0`, with no QA listing.

Fresh integrated local checks: 667 Python passes and 65 environment/privilege skips; 57 isolated publication/revision tests; 65 installer security checks plus ShellCheck and dependency simulation; all 38 real-browser capture tests; 11 frontend smokes; six taxonomy tests; 56 PHP runtime checks; pre-v1 migration, tampered prepared payloads, offline upgrade recovery, normal reinstall, fresh install, and update smokes passed. Independent review approved the capture, publication, prepared-update, and sanitized dispatch-diagnostic changes. Audio-model and exact-candidate CI remain required before merge.

Generation/cache security, lock coordination, generated Caddy routes, and the isolated image decoder also passed in disposable Linux containers. The final source scan found no credential signatures or private payloads. All three approved media hashes match.

## Historical completed acceptance: 2026-10-03

- [x] Fast-forward the candidate to upstream `265d7e7f8e901ca7ae168ad5f6a84a9b2b6107d4`, zero commits ahead or behind at that checkpoint, with uncommitted candidate changes preserved.
- [x] Preserve recovery stash `0f7a99499c907285a32ddaa1821d2582e2b8f8b9` and the private backup.
- [x] Obtain Teddy's visual acceptance of the physical Impressionist panel.
- [x] Restore Woodblock for filming, refresh the physical panel, verify artwork integrity, and leave the config unchanged and timer enabled.
- [x] Restrict release media to the three reviewed images in [LAUNCH_MEDIA.md](LAUNCH_MEDIA.md), including Teddy's physical-frame photo, with [SHA-256 checksums](MEDIA_SHA256SUMS.txt). Every other local media file is excluded from both commits and release assets.

## Before the release word

- [ ] Refresh the local results after current upstream integration, using [SOURCE_EVIDENCE.md](SOURCE_EVIDENCE.md) for dated hosted acceptance. Freeze the reviewed source and staging inventory before committing.
- [x] Independently review the public publication-workflow credential/route fix and its regressions. Keep dispatch in the private acceptance repository. The separately authorized October 5 rollout uses protected `bundle-acceptance-v1.0.5`; the October 3 `v1.0.4` evidence below is historical. No further operational promotion is authorized by the software release checklist.
- [x] Ensure both frame-installer-security path filters cover the credential implementation, credential tests, and bundle-species requirements as well as the existing installer paths.
- [x] Review the Access config and receipt as intentional non-secret operational artifacts. Retain both explicit filenames in the commit map, matching the provisioner tests and operations documentation; no wildcard staging.
- [ ] Recheck the [explicit commit map](COMMIT_PLAN.md) against the final source inventory after integration. The earlier inventory review is historical. Include the cutout API revision boundary, taxonomy JSON, upgraded-cutout installer, frame illustration helper, owning Worker tests and deployment guards, and both PR drafts. Do not use recursive staging for `docs/releases/v1.3.0/` or `ops/` when creating commits.
- [ ] Repeat the independent final-inventory scan for secrets, private review material, source ZIPs, local fixtures, and generated output. The earlier scan does not freeze today's changed tree. Keep inventories and recovery patches private; leave normal staging indexes unchanged until release approval. `.avian/` is ignored; the current `assembled/` exclusion is local Git configuration, not a portable source guarantee.
- [x] Verify all release links and all three allowlisted media hashes. Keep all other captures local, including reviewer screenshots with unconfirmed synthetic provenance.
- [x] Hide repository-only listings, regions, and credits in the public and embedded catalog code. Preserve migration history and verified local downloads. The separately authorized public rollout passed on October 3; signed-out browser checks at that checkpoint showed only the two hosted official styles and their Western North America coverage. Community publications can change the live listing afterward.
- [x] Unlist the disposable QA Japanese woodblock publication through authenticated review. Both community feeds were empty at the October 3 checkpoint; Germany's authorized October 5 publication now appears. Immutable artwork, ownership, and review history are retained.
- [x] Add the prominent retirement notice to the legacy Markdown index while preserving its historical links.
- [x] Send the nine authorized contributor invitations after public verification. Read back every message and record its exact [GitHub comment link](CONTRIBUTOR_OUTREACH.md). The software release remains on hold.

## Historical integrated evidence: 2026-10-03

- Bare Python test run with `PYTHONPATH` unset: 562 passed, 59 expected skips. Seven audio-analysis tests passed separately with real TFLite: 569 distinct passes total.
- Publication tests in pinned AMD64 Python 3.11.16 with Pillow 12.3.0: 129 passed and 57 subtests passed. Independent review approved the credential/route change.
- Frame root-security gate: 65 checks passed, plus ShellCheck and dependency simulation.
- Generation/cache/coordination, fresh-install, reinstall, and pre-v1 container smokes passed.
- Six frontend smokes, six taxonomy tests, and 56 PHP runtime checks passed.
- Later hosted-only catalog refinement: 194 Worker JavaScript tests, four uploader tests, 12 preview records, 37 vendored behavior tests, and the station catalog parity, Settings, and artwork smokes passed. Local and public browsers confirmed Woodblock shows only its hosted Western North America region and official credit.
- Public rollout: intake-off and intake-on resources match except the reviewed flag. Both phases passed 26 anonymous HTTP requests and 20 assertions; five D1 counts and both community feed hashes stayed unchanged. Uploads are open. All four official manifests and nine sampled image objects passed digest, length, caching, and CORS checks.
- Three capture tests passed on Linux with Playwright 1.62 and system Chromium 154. This is not a claim that the browser binary was Playwright's pinned Chromium build.
- [Upstream Python CI at `265d7e7f`](https://github.com/Twarner491/AvianVisitors/actions/runs/36795665568) is green. Candidate-branch GitHub CI has not run; it follows the branch push after Teddy's release word.

## Scoped capacity evidence: 2026-10-05, hosted rollout complete

- [x] Freeze protected private tag `bundle-acceptance-v1.0.5` at `1ed16095dbbe20eb06c04d9ae10b19d2465454fd`; [private acceptance CI 37360910408](https://github.com/Twarner491/avian-visitors-bundle-acceptance/actions/runs/37360910408) passed.
- [x] Verify 768 MiB archives, 1,500 objects, ordinal 1499, and bounded 3 MiB UTF-8 review indexes. Preserve 4 MiB images, 640 MiB expanded/canonical content, 1,000 species, station 4 MP decoding, isolation, and quotas. The offline 1,500-image proof used a 613,147,696-byte archive; maximum supported names passed all index readers.
- [x] Verify advisory bird/style quality cannot bypass technical validation, supported licensing, complete clean safety moderation, or human publication review. Worker checks passed 226 JavaScript tests, four uploader tests, and 12 preview records; private validation passed 150 lifecycle and 13 security tests; station checks passed 165 tests with two existing skips.
- [x] Complete and verify the separately authorized hosted rollout. Version `e2223126-addc-4acc-90a1-43734773a5f4` served 100% at that checkpoint. Migration 0008 passed production invariant checks with eight migration receipts. The live matrix passed 23 checks over 26 anonymous requests, and both community feeds stayed unchanged. The later credential-only deployment and Germany publication are recorded in [SOURCE_EVIDENCE.md](SOURCE_EVIDENCE.md), including the expired-credential caveat for the original rollback.
- [x] Verify the signed-in uploader and authenticated advisory review UI without approving a bundle. The optional-note interaction was checked and cancelled. The public v1.3.0 software release remains held.
- [x] Complete Teddy's separate approval of Germany after publishing-credential renewal. Both catalog feeds and the public contributor link were verified at that checkpoint; this records no approval of another set.
- [x] Renew the separate validation dispatch credential and verify the blocked Iberian upload resumes through scheduled recovery. Read-only verification on October 6 confirms [protected run `37380235706`](https://github.com/Twarner491/avian-visitors-bundle-acceptance/actions/runs/37380235706) completed with workflow conclusion `success` at October 5, 22:21:03 UTC. Workflow completion alone does not establish the persisted review outcome, human approval, or current publication state.

## After Teddy gives the release word

1. Recheck upstream and the final diff without rewriting contributor history. If upstream advanced, integrate it and rerun affected gates before staging.
2. Stage reviewed hunks and explicit new files in each owning repository. Inspect `git diff --cached`, run `git diff --cached --check`, and verify no excluded local file entered the staged tree. Create the agreed focused commits only.
3. Rerun the approved local gates on the committed tree and record exact commit IDs and results. Keep private backups until release validation is complete.
4. Push the release branches and open the reviewed pull requests. Require green CI on the exact merge candidates, including frame installer security and capture readiness. Do not dispatch secret-bearing bundle workflows as a release test.
5. Merge after the review and CI gates pass, then verify the release commit contains both the upstream fixes and candidate changes. Confirm `v1.3.0` is still unused, then create and push that tag at the reviewed commit.
6. Create a draft GitHub release from [RELEASE_NOTES.md](RELEASE_NOTES.md). Upload only `evolutionary-impressionist-station.jpg`, `station-impressionist-active.jpg`, and `evolutionary-impressionist-frame.jpg`, using those exact names. Check downloaded SHA-256 values and render the draft to verify images and the tagged README link.
7. Publish the GitHub release after its final checks pass. The release word authorizes this sequence, not a Worker deployment, private acceptance-tag change, X post, or contributor outreach; those remain separate work.
