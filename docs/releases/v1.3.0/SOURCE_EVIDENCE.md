# Avian Visitors v1.3.0 release source evidence

Research snapshot: 2026-09-09. Release-state audit updated 2026-10-06. Acceptance results retain their original dates. This file records the sources behind the local release draft; it is not itself release copy.

## Candidate baseline

- Worktree: `/Users/twarn/Repositories/AvianVisitors-station-bundles`
- Branch: `alpha/bundles-v1.3.0`
- Integrated base: `543c44734d65d0769e18d9aa6463ef2d8ccf7a7d`
- Current `origin/avian-visitors`: `543c44734d65d0769e18d9aa6463ef2d8ccf7a7d` (read-only remote verification 2026-10-06)
- Remote: `Twarner491/AvianVisitors`

The candidate integrated upstream `543c4473` on October 6, preserving capture and interrupted-upgrade fixes. Recovery stashes `0f7a99499c907285a32ddaa1821d2582e2b8f8b9` and `a94b8c036b537af9410cd2c7924a20d5ff491422`, plus private backups, remain intact. Teddy accepted the iPhone Safari preview and authorized the branch, squash merge, and v1.3.0 release. The [release checklist](RELEASE_CHECKLIST.md) separates fresh integrated checks from historical evidence and outstanding CI gates.

The earlier scratch rehearsal found nineteen overlapping paths, including fourteen conflicts, and no untracked collisions. Those conflicts are now resolved in the release worktree. Integration checks also corrected the pre-v1 snapshot producer, test import isolation, the security harness's shared validator mount, and retry classification for same-revision image-source changes.

[Upstream Python CI at `543c4473`](https://github.com/Twarner491/AvianVisitors/actions/runs/37149897338) passed. Exact-candidate CI must pass before merge. Pre-staging October 6 inspection confirmed `v1.3.0` was unused and `v1.2.0` was the latest published release; recheck before tagging.

## Prior release structure

The draft follows the project’s established pattern: short opening statement, inline image and italic caption, descriptive `##` sections, update/enable instructions, community credit where relevant, and closing project resources.

- [v1.2.0 GitHub release](https://github.com/Twarner491/AvianVisitors/releases/tag/v1.2.0), published 2026-09-03; local source: [`../v1.2.0/RELEASE_NOTES.md`](../v1.2.0/RELEASE_NOTES.md).
- [v1.1.0 GitHub release](https://github.com/Twarner491/AvianVisitors/releases/tag/v1.1.0), published 2026-08-28; local source: [`../v1.1.0/RELEASE_NOTES.md`](../v1.1.0/RELEASE_NOTES.md).
- [v1.0.0 GitHub release](https://github.com/Twarner491/AvianVisitors/releases/tag/v1.0.0), published 2026-08-19.
- The proposed scoped history also follows [`../v1.1.0/COMMIT_PLAN.md`](../v1.1.0/COMMIT_PLAN.md).

Public release metadata and bodies were read through the GitHub Releases API for `Twarner491/AvianVisitors`. No release or remote state was changed.

## Feature claims and local sources

| Draft claim | Local evidence |
| --- | --- |
| Two official Western North America station packs; Japanese Woodblock included and Evolutionary Impressionist downloaded only on demand | `avian/bundles/catalog-v1.json`, hosted `public/catalog/bundles-v1.json`, immutable-asset gate below |
| 333 species per official pack; `CC-BY-NC-SA-4.0`; version `1.0.0` | `avian/bundles/catalog-v1.json` |
| Settings integration and selected-bundle presentation | `avian/frontend/index.html`, `avian/frontend/apt.js`, `avian/frontend/bundle-ui.js`, `avian/frontend/bundles.css` |
| Downloaded badge, downloaded-first ordering, `Refresh local birds` for the active downloaded set, and native opener-isolated new-tab full-catalog link | `avian/frontend/bundle-ui.js`, `avian/frontend/assets/bundle-catalog/bundles.js`, `tests/smoke_bundle_catalog_settings.mjs`, `tests/smoke_bundle_catalog_parity.mjs` |
| Opaque station frame reads the canonical static official and legacy catalog without credentials or referrer, falls back to its checksum-tracked snapshot, then merges only D1-confirmed installable community rows | hosted `public/bundles/assets/bundles.js`, vendored `avian/frontend/assets/bundle-catalog/bundles.js`, `avian/frontend/assets/bundle-catalog/catalog-snapshot.js`, `tests/smoke_bundle_catalog_parity.mjs`, hosted `test_bundles_behavior.mjs` |
| Public and embedded browsing excludes repository-only migration records before style grouping, search, region filters, and contributor credits; verified local-library presentations remain available | hosted and vendored `bundles.js`, hosted `test_bundles_behavior.mjs`. Deployed and verified while signed out on October 3. |
| Live discovery remains presentation-only and cannot displace official or reserved legacy IDs; the child submits a catalog ID and the station parent rejects IDs absent from its current trusted install catalog | `avian/frontend/bundle-ui.js`, `tests/smoke_bundle_catalog_settings.mjs`, `tests/smoke_bundle_catalog_parity.mjs`, hosted `test_bundles_behavior.mjs` |
| Canonical strict install feed at `https://avianvisitors.com/api/bundles/catalog/community-v1.json` materializes a validated station entry at publication, atomically selects the highest confirmed SemVer head, serves from bounded D1 state without per-request R2 reads, excludes private review state, and fails the whole response closed | hosted `src/bundles.js`, hosted `src/worker.js`, hosted `migrations/0004_bundle_review.sql`, hosted `test_bundle_station_catalog.mjs`, hosted `scripts/http_acceptance.py`, hosted `DEPLOYMENT.md` |
| Station refresh accepts only that fixed HTTPS feed, limits it to 2 MiB and 1,000 packs, prevents community entries from replacing official IDs, blocks rollback/equivocation/future dates, atomically caches verified bytes, and preserves the last verified or bundled catalog on failure | `avian/scripts/bundle_manager.py`, `tests/test_bundle_catalog_refresh.py`, `tests/test_bundle_manager.py`, `tests/test_station_bundle_catalog.py` |
| Twelve official collage previews reduced from 5,601,731 to 3,439,136 bytes with every alpha and visible RGBA pixel preserved | hosted `scripts/build_bundle_preview_geometry.py`, hosted `test_bundle_collage.mjs`, `avian/frontend/assets/bundle-catalog/bundle-previews/collage/**` |
| Content-addressed collage filenames, revisioned URLs, disclosure-time loading, asynchronous decoding, and vendored public-catalog parity | hosted `public/bundles/assets/catalog/bundle-preview-geometry-v1.json`, hosted `public/bundles/assets/bundles.js`, hosted `public/bundles/assets/bundle-collage.js`, hosted `scripts/build_bundle_preview_geometry.py`, `scripts/vendor_bundle_catalog.mjs`, `avian/frontend/assets/bundle-catalog/vendor-manifest.json`, `tests/smoke_bundle_catalog_parity.mjs`, hosted `test_bundle_collage.mjs` |
| Coarse region propagation rather than raw station coordinates | `avian/frontend/apt.js`, `avian/frontend/bundle-ui.js`, `tests/smoke_bundle_catalog_settings.mjs` |
| Saved-location selection uses the annual local BirdNET model plus heard and explicitly included birds; no location selects the full manifest, and `--all-species` is an explicit override | `avian/scripts/bundle_species.py`, `avian/scripts/test_bundle_species.py`, `avian/scripts/bundle_manager.py`, `tests/test_bundle_manager.py`, `frame/bundle_runtime.py`, `frame/test_bundle_runtime.py` |
| Immutable selection receipts bind exact species, images, and geometry to the original manifest; unchanged selections reuse verified profiles and old selections remain addressable | `avian/api/bundle-runtime.php`, `avian/api/bundle-assets.php`, `avian/api/cutout.php`, `avian/frontend/apt.js`, `tests/test_bundle_php_endpoints.py`, `tests/smoke_bundle_art_runtime.mjs`, `frame/shoot.py` |
| The root-owned station helper runs inference as the station account without capabilities; a direct-LAN endpoint shares only species and digests with a mirroring Frame | `scripts/install_services.sh`, `scripts/reinstall_services.sh`, `avian/scripts/bundle_manager.py`, `avian/api/bundle-species.php`, `tests/test_bundle_use_endpoint.py` |
| Catalog-ID-only request, canonical flat Worker object/manifest routes, fixed-host policy, limits, hashes, PNG inspection, staging, activation, and rollback | `avian/bundles/catalog-v1.json`, `avian/scripts/bundle_manager.py`, `avian/api/bundle-runtime.php`, `avian/api/bundles.php`, `tests/test_bundle_manager.py`, `tests/test_bundle_runtime.php`, `tests/smoke_bundle_image_sandbox.sh`, `tests/test_station_bundle_catalog.py` |
| One post-SSH command on a station and BirdFrame | `scripts/avian-bundle`, `frame/avian-bundle`, `frame/vendor/avian-bundle-control`, `tests/test_bundle_manager.py`, `tests/test_station_bundle_catalog.py`, `frame/test_bundle_runtime.py`, `frame/test_bundle_render_integration.py` |
| Root-owned, setup-account-bound BirdFrame launcher; reset environment and no-new-privileges before checkout code; pinned installer parse and private eBird key handoff | `frame/avian-bundle-installed`, `frame/install.sh`, `frame/test_install_security.py`, `frame/test_bundle_render_integration.py`, `frame/check_install_security.sh`, `.github/workflows/frame-installer-security.yml` |
| Local review and deterministic upload-ready ZIP export | `avian/frontend/apt.js`, `avian/api/export.php`, `avian/scripts/bundle_export.py`, `avian/scripts/test_bundle_export.py`, `tests/smoke_caddy_generated_routes.sh` |
| Identity-only GitHub sign-in, one-ZIP upload, private review state, changes-requested follow-up, and published bundle views | hosted `public/bundles/**`, hosted `src/bundles.js`, hosted `src/bundle_review.js`, hosted `test_bundles_ui.mjs`, hosted `test_bundles_behavior.mjs`, hosted `test_bundle_review_ui.mjs`, hosted `test_bundle_review_api.mjs`, hosted `test_bundle_review_access.mjs`, and hosted `scripts/http_acceptance.py` |
| Credential-isolated archive validation, strict PNG canonicalization, bounded review, and exact approved publication | Current protected acceptance source: the private repository at `bundle-acceptance-v1.0.5`, deployed and verified on October 5. Public candidate sources: `.github/workflows/{validate,publish}-bundle.yml`, the `avian/scripts/bundle_*.py` validation/publication modules, and their focused tests. These are not interchangeable deployment authorities. |
| Hosted capacity: 768 MiB archive, 1,500 objects, ordinal 1499, and 3 MiB UTF-8 review index; image, expanded-content, species, and decoder guards retained | `avian/scripts/bundle_{validate,review_package,canonical_upload,publish,export}.py`, `avian/api/export.php`, `.github/workflows/publish-bundle.yml`, `avian/scripts/test_bundle_limit_capacity.py`, `avian/scripts/test_bundle_review_package.py`, `avian/scripts/test_bundle_export.py`; hosted `src/bundles.js`, `migrations/0008_bundle_intake_limits.sql`, `test_bundle_limits.mjs`, and `test/schema.test.mjs`. Hosted rollout verified October 5; matching station source remains unreleased. |
| Bird/style quality is advisory; technical validity, supported licensing, complete clean safety moderation, and human publication approval remain required | Hosted `src/bundle_review.js`, `public/bundles/assets/bundle-review.js`, `test_bundle_review_api.mjs`, and `test_bundle_review_ui.mjs`. Missing or malformed safety evidence remains blocking. Live authenticated review UI verified October 5 without approving a bundle. |
| Frozen four-manifest, 1,999-object publication plan; read-only local verification plus HEAD/full live gates | `avian/bundles/publication-lock-v1.json`, `scripts/verify_official_bundle_publication.py`, `tests/test_official_bundle_publication.py`, `docs/official-bundle-publication.md` |
| Wildcard, credential-free CORS appears only on successful GET/HEAD reads of the exact browser catalog, strict station feed, and immutable object, manifest, and preview-geometry routes | hosted `src/bundles.js`, hosted `src/worker.js`, hosted `test_bundle_public_cors.mjs`, hosted `test_bundle_station_catalog.mjs`, hosted `scripts/http_acceptance.py` |
| Managed library persistence through installer/update paths | `scripts/install_services.sh`, `scripts/reinstall_services.sh`, `tests/smoke_reinstall_services.sh`, `tests/smoke_install_clear.sh` |
| Exact-email, one-time-PIN Cloudflare Access policy and guarded provisioning | `ops/cloudflare/bundle-review-access.json`, `scripts/provision_bundle_review_access.py`, `tests/test_provision_bundle_review_access.py`, `docs/bundle-review-zero-trust.md` |
| Legacy link index retained only as a migration record | `illustration-bundles.md`, `docs/bundle-catalog-migration.md` |

The hosted upload and review implementation lives in
`/Users/twarn/Repositories/avianvisitors-bundle-worker`. Its public behavior is
included in the release notes, while its source stays in its owning repository.

## Workflow ownership and source audit

The historical October 3 owning-repository snapshot was Worker `ac607d2bdbc470f6273094b2062e78c4b58bbc2e` plus uncommitted catalog work, pinned to private `Twarner491/avian-visitors-bundle-acceptance` tag `bundle-acceptance-v1.0.4`, commit `3cac9f07bd5c3f4fa712187d2e6972c2c5d9524c`. The acceptance repository was clean during that audit. These are historical source references, not the new rollout target.

The separately authorized October 5 rollout uses protected private tag `bundle-acceptance-v1.0.5` at `1ed16095dbbe20eb06c04d9ae10b19d2465454fd`. Its [acceptance CI run 37360910408](https://github.com/Twarner491/avian-visitors-bundle-acceptance/actions/runs/37360910408) passed. After both dispatch-credential rotations, Worker version `f723db39-9a93-4fa2-ac55-cd8c5208848b` pinned that exact tag and served 100% of traffic at the October 5 checkpoint. See the operational checkpoints below for rollback constraints.

The public candidate publication workflow was corrected to use the separate canonical-read credential and publication-context route. It is still not the operational acceptance source. The private acceptance tag includes a separate root-owned source closure and namespace sandbox. Do not repoint Worker dispatch, add public-repository secrets, or promote a new acceptance tag as part of the station release. Those changes require their own review, tests, and approval.

The new public workflows use read-only repository permissions, full-SHA action pins, and checkout without persisted credentials. The image validator requirements use exact versions and hashes; the frame security container pins its base image digest. Verify the final workflow patch and trigger coverage before committing.

Selected candidate source SHA-256 values checked on 2026-10-03:

| File | SHA-256 |
| --- | --- |
| `frame/shoot.py` | `26f35708d45a30ba161ec08f72765d0fb75b6dcc6bf0a96031da6d39a0f0eca4` |
| `frame/bundle_runtime.py` | `9bf699198f9590efcaa00807589418e065142ca3d16be76d8c359aab84b0ede7` |
| `avian/scripts/bundle_manager.py` | `579e4253f9d9913cf9c2036a5d83651b4b40613876a52e1ea838dc461492a7bd` |
| `avian/bundles/catalog-v1.json` | `6f5e78c85d42529fdd5f35c8b6836ddfa1dfa291f26bee4e52b6dd6b26601b3f` |
| `avian/bundles/publication-lock-v1.json` | `bb7166df12dab171e92dd44396dc6576bd54f2a6707272b7b6ae9a276a327837` |

These are spot checks, not a complete release-tree digest. Freeze and review the final staged tree after the remaining gates.

## Historical hosted rollout: 2026-09-09

The immutable official object store is also a publication gate. The lock preserves two distinct authorities: two station-install manifests and two public-discovery manifests. They must not be substituted for one another even when their logical bundle ID and version match. Together they deduplicate to 1,999 PNG objects and total exactly 2,003 files and 977,739,928 bytes. The full live verifier downloaded and hashed that complete plan successfully before Evolutionary Impressionist was marked `installable`; a HEAD-only result was not sufficient.

The bundle catalog, intake, immutable assets, and strict station feed are live
at `avianvisitors.com`. The 2026-09-09 maintenance rollout activated Worker
version `15ead982-a3e9-41b1-9e6d-afc3f8d8a571` after the intake-off and
intake-on resources matched except for the reviewed flag. Both dynamic feed
hashes and all four recorded D1 counts stayed unchanged. These version IDs and
proofs describe that September rollout, not a fresh check of the active
deployment. Current deployment and rollback authority remains the Worker
repository's operations record.

The intake-off rollback version is `56bb87bf-b16b-42fe-825e-d79d583695d9`.
The frozen deployable content SHA-256 is
`795ae81a2fe5c6350bf472f1e839ff52b97469238a7646d725c223ee22b874c4`.
Both rollout phases passed 14 production probes; private proofs are in
`/private/tmp/avian-bundle-label-rollout.wC4AMd`.

## Operational checkpoints

The deployment and publication statements below describe their dated checkpoints. The October 6 audit rechecked branch/tag/CI metadata, Iberian workflow completion, and public discovery, not current Worker traffic or private D1 review history. Teddy subsequently accepted the iPhone Safari preview; no mobile code fix is claimed.

- Teddy authorized the public v1.3.0 software release on October 6, subject to final checks and green CI. This does not authorize another hosted deployment, acceptance-tag change, or bundle approval.
- The October 5 hosted capacity/advisory rollout first reached 100% on `e2223126-addc-4acc-90a1-43734773a5f4`, with intake enabled and private acceptance `v1.0.5`. Teddy renewed publishing credentials at 21:46 UTC and validation credentials at 21:58 UTC. Version `f723db39-9a93-4fa2-ac55-cd8c5208848b` then received 100% of traffic. Exact script, runtime and all 28 binding definitions were unchanged, including ten secret bindings. Both tokens were recorded as expiring November 4, 2026. Earlier versions, including intake-off rollback `bf2c5bf0-3728-4eb6-ad4f-078249893df4`, lack one or both renewed credentials; account for rotation before rollback.
- The live anonymous matrix passed 23 checks over 26 GET/HEAD requests, including source parity, route and Access boundaries, and unchanged discovery/station community feeds. The signed-in uploader is available. Authenticated review shows quality as advisory; the optional-note interaction was checked and cancelled. No bundle was approved or published during this rollout.
- Later, Teddy explicitly approved Japanese Woodblock - Germany by @bassrelic. Protected private publication run `37378284472` succeeded; D1 confirms publication at `2026-10-05T21:51:09.065Z`. Both public feeds include version `1.0.0`, 35 species and `CC-BY-NC-SA-4.0`; the browser shows Germany with the contributor's GitHub link. No other community approval is implied.
- Validation recovery dispatched the retained Iberian upload at `22:05:50.091Z` without re-upload or manual state changes. Read-only verification on October 6 confirms [protected run `37380235706`](https://github.com/Twarner491/avian-visitors-bundle-acceptance/actions/runs/37380235706) completed with workflow conclusion `success` at October 5, `22:21:03Z`, using protected commit `1ed16095dbbe20eb06c04d9ae10b19d2465454fd`. That proves workflow completion, not the persisted review outcome, human approval, or current publication state. October 5 local Worker checks passed 229 Node tests, four uploader tests and 12 preview checks; the diagnostic-only audit patch was local and undeployed at that checkpoint.
- A separate read-only public-discovery check on October 6 found Germany and Iberia (`community-roquealonso-e824a0e5dde69d4b`) installable at version `1.0.0`, with no QA listing. This verifies their public discovery state, not the approval actor/history, strict station-feed contents, or installation on a device.
- Scoped October 6 Worker checks passed 229 JavaScript tests, four uploader tests, 12 preview checks, and 52 HTTP checks with zero failures. They ran before any confirmed mobile fix and do not establish final integrated release readiness.
- Independent anonymous publication verification passed for Germany's manifest, geometry, all 70 canonical PNGs, seven derived previews and six inline masks, including hashes, byte lengths, CORS and immutable caching. Private receipt: `.avian/bundle-dispatch-recovery.tPJ4BF/GERMANY-PUBLIC-VERIFICATION.md` in the main workspace. This verifies hosted bytes, not a new physical-frame install.
- Historical October 3 rollout receipts record version `1e03991e-bfe0-4248-b58a-e529cb88ab41` and intake-off rollback `9ec89f00-52d5-4fb3-ae9e-ea3c05c478f9`. Both phases passed 26 anonymous HTTP requests and 20 assertions, source-byte parity, unchanged community feed hashes, and unchanged D1 counts: six submissions, one retained publication, one object, zero catalog heads, one registry entry. Uploads were open after that rollout. Private receipts are in `.avian/public-catalog-rollout.pegNbJ` in the main workspace; they do not verify the October 5 changes.
- No v1.3.0 release asset has been uploaded. Nine separately authorized [contributor invitations](CONTRIBUTOR_OUTREACH.md) were sent on October 3 and read back from GitHub to verify their exact text, author, and destination.
- The QA Japanese woodblock publication was unlisted through authenticated review at `2026-10-03T20:23:46.497Z`; both canonical community feeds returned empty `packs` at that checkpoint. Immutable artwork, ownership, version history, and the review audit remain retained. Germany's October 5 publication now adds its real artwork and credit; QA and legacy-only records remain excluded. No GitHub release action is authorized.
- Physical installation, panel refresh, rollback, integrity, identity boundaries, repeat installation, and scheduled-service checks passed on 2026-10-03. Teddy visually accepted Impressionist. Woodblock was then restored for filming with a physical refresh and integrity verification; the config stayed unchanged and the refresh timer remained enabled.
- On October 6 at approximately 10:11 PDT, the existing frame switched to Impressionist for filming. The command reported a successful panel update; readback verified 216 species, 432 images, and 194,048,832 bytes. Config SHA-256 stayed unchanged and `birdframe.timer` was enabled. This was not a software upgrade or fresh human visual confirmation; see [the separate October 6 frame checkpoint](PHYSICAL_FRAME_ACCEPTANCE.md#october-6-switch-for-filming).

The October 6 frame receipt is private at `.avian/physical-frame-20261006.md` in the main workspace. It is excluded from release source and assets.

## Capacity and advisory-policy source verification: 2026-10-05

- Reviewed ceilings are 805,306,368 archive bytes and 1,500 objects, with ordinals 0 through 1499. The 4 MiB PNG, 640 MiB expanded/canonical, 1,000-species, and station 4 MP guards remain unchanged. Multipart 429 retries are bounded and cancellation stops the wait.
- A real offline 1,500-PNG, 750-species proof used 512 by 384 canvases, a 613,147,696-byte ZIP, and 611,584,271 canonical bytes. It completed in 138.35 seconds with 85,752 KiB peak Python RSS under a network-disabled 2 GiB / 2 CPU container. No external moderation or publication occurred.
- The maximum-name regression uses 163-character scientific names and 100 astral Unicode common-name characters. Its UTF-8 review index is 2,704,791 bytes; producer and all readers accept exactly 3 MiB and reject one byte over. Canonical and publication indexes stay within their unchanged 1 MiB and 512 KiB caps. Uploaded auxiliary text and moderation reports remain capped at 1 MiB; source imports and decoder isolation are unchanged.
- Fresh pinned Python 3.11 / Pillow 12.3.0 checks passed 150 private lifecycle tests and 13 repository/security tests, including the refreshed 36-file source manifest. Station checks passed 165 tests with two existing skips. Worker checks passed 226 JavaScript tests, four uploader tests, and 12 preview records. Independent review approved the index fix after 14 focused tests passed.
- Server and browser approval policy require technical success, supported SPDX licensing, clean moderation of every object plus metadata, and matching SHA-256 commitments. Bird/style review completeness and quality flags are advisory, not safety overrides. Human publication approval remains required.
- Forward migration `0008_bundle_intake_limits.sql` passed populated SQLite/local D1 rehearsals and then applied to production with intake paused: 93 commands in 21.72 ms, with eight migration receipts afterward. Export comparison preserved every source-column row; only the three intended CHECK ceilings changed. Indexes and foreign keys are unchanged, foreign-key violations are zero, and `quick_check` is `ok`. Export comparison does not prove hidden rowids; same-database rehearsal and migration guards cover those separately.

Private commands, resource proof, independent review, and production receipts remain in `.avian/bundle-limit-rollout-20261005.q0vwZP/` in the main workspace: `ACCEPTANCE_CAPACITY.md`, `acceptance-index-final.log`, `worker-check-final.log`, `independent-security-review.md`, `migration-atomicity.md`, `production-migration-proof.json`, `final-deployments.json`, and `intake-on/report.json`. Those files, database exports, local fixtures, and review records are excluded from the public source commit. Hosted completion does not lift the public software-release hold or authorize a bundle approval.

## Physical acceptance on 2026-10-03

See [physical frame acceptance](PHYSICAL_FRAME_ACCEPTANCE.md) for the exact scope and remaining gates.

- Both official styles were downloaded from the live service using the frame's saved location: 212 species and 424 verified images per style.
- A real startup capture race was reproduced in Chromium, fixed with bounded retries, independently reviewed, and retested on the physical frame. Invalid captures never reached the panel; rollback restored the prior bundle.
- Final candidate Python run with `PYTHONPATH` unset: 562 passed, 59 expected skips. All seven audio-analysis tests passed separately in isolated ARM64 Linux with real `tflite-runtime` 2.14.0 and the checked-in model and WAV: 569 distinct passes in total. The earlier focused capture and bundle gate passed 75 tests with 12 expected privilege skips. The final three Linux capture tests also passed with Playwright 1.62 and system Chromium 154.
- Physical ARM64 checks: 62 passed, 13 environment/privilege skips. Isolated Linux frame checks: 118 passed, one expected skip. Installer, reinstall, pre-v1 upgrade, generation/cache/cron, and lock-policy container smokes passed.
- Hosted Worker checks: 191 JavaScript tests, four uploader tests, and 12 preview records passed. Isolated HTTP matrix: 46 passed. Read-only production checks verified the catalog and feeds, all four official manifests, and nine sampled immutable objects; this was not a repeat full-store audit.
- Localhost Atlas browser checks rendered both Impressionist poses in the expanded left panel. The localhost station remains available for review.
- No release, tag, push, or commit was created. Branch-history, visual-confirmation, and local test gates passed at the October 3 checkpoint. Upstream integration, current mobile QA, affected reruns, the final staging inventory, candidate GitHub CI, and publication approval remain open on October 6.

## Prior release gates through 2026-09-08

These results predate the location-aware selection changes. Fresh checks are recorded separately below.

- Hosted Worker tests: 188/188 passed.
- Hosted HTTP matrix: 46/46 passed.
- Hosted browser behavior and UI checks: 41/41 passed.
- Assembled catalog checks: 45/45 passed.
- Station bundle Python tests: 147/147 passed.
- Station PHP tests: 492 checks passed.
- Station browser and catalog smokes: 8/8 passed.
- Bundle exporter tests: 28 passed, with one intentional environment skip.
- Full local-library export: 333 species, 666 PNG objects, and 248,850,027 expanded bytes; strict archive validation passed.
- Live-feed station install: the published one-image QA bundle downloaded, hash-verified, activated, and repeated idempotently in an isolated local store.
- Caddy and PHP-FPM export deadline checks: 7/7 passed.
- Hosted validation and publication tests: 127/127 passed on the pinned Linux Python 3.11 workflow target with hash-verified Pillow 12.3.0.
- BirdFrame runtime, render, and BirdWeather tests: 55 passed with 12 container-only skips locally.
- BirdFrame installer security gate: 50/50 passed with ShellCheck and ARM64 Debian dependency simulation.
- Full BirdFrame ARM64 Debian discovery: 86 passed with one intentional platform skip.

## Location-aware verification on 2026-09-09

- Station bundle suite: 132 tests, 131 passed and one container-only skip. That production test passed separately using the actual annual metadata model, normal config symlink, station-account execution, `NoNewPrivs=1`, zero effective and bounding capabilities, and cache reuse.
- First-install, service-refresh, and pre-v1-upgrade Linux container smokes passed.
- PHP HTTP endpoint suites: 17 passed, including HEAD/GET parity for both poses. Runtime contract: 56 checks passed. API architecture: 13 passed. Artwork runtime, Settings, and vendored-catalog parity smokes passed.
- Annual species helper: 12 unit tests passed. For each model version, species and digests matched across TFLite 2.14.0 and LiteRT 2.1.4/2.1.5 for San Francisco, New York, and London.
- Frame runtime/render suite: 66 tests, 54 passed and 12 privilege-gated skips as an unprivileged Linux user. The isolated-root render/launcher suite then passed 24 of 25 tests with one expected no-setpriv branch skip. Installer security passed 62 of 63 tests with one unprivileged-only skip. ShellCheck passed.
- Independent final review passed all 41 Frame runtime tests, including active-first reuse of equivalent historical profiles and exact rollback after render failure. No actionable findings remained in that change.
- Hosted Worker: 191 JavaScript tests, four uploader tests, and 12 preview records passed. HTTP matrix: 46 passed. Browser behavior/UI: 44 passed. Vendored behavior, assembled UI, and source parity checks passed.
- Live in-app browser review verified GitHub profile links and command disclosure; copying then pasting produced the exact Impressionist install command. The local embedded catalog also preserved the installed QA bundle's human attribution while linking its verified GitHub contributor.
- The durable localhost station used its saved Palo Alto location to select 203 birds and 406 images from the 333-bird, 666-image Impressionist manifest. This reused previously downloaded objects; it was not a fresh network download.
- Browser selection and refresh succeeded. Refresh preserved the same selection revision and profile count. All 23 collage images loaded with selection-bound URLs and no browser warnings or errors.
- Expanded-card regression checks passed for both styles, perched-only and flight-only bundles, remembered poses, missing artwork, and late availability checks after a bundle switch. Six frontend smokes passed; independent review found no actionable issue.
- In-app browser checks rendered both poses from Atlas, Stats, and the collage after switching Woodblock to Impressionist. The local preview now accepts the same HEAD image checks as production. Impressionist remains selected. The live and embedded catalog buttons read `Use on my local station`; the separate command disclosure remains available.
- Existing collage input limitation: pointer clicks use the bird's opaque mask; keyboard activation has no coordinate-free fallback. This is separate from the expanded-artwork fix and remains unchanged.
- An independent read-only check verified all 406 cached PNGs (180,358,725 bytes), exact receipt/index/geometry inventory, six real HTTP image hashes, selection-bound ETags, conditional reads, excluded-species rejection, and retained legacy full-set URLs. Proof: `/Users/twarn/Repositories/AvianVisitors/.avian/local-station/subset-proof-2026-09-09.md`.
- As of September 9, the physical e-ink display was untested. The October 3 acceptance above supersedes that status.

## Legacy bundle contribution evidence

The migration ledger was derived from the tracked [`illustration-bundles.md`](../../../illustration-bundles.md) index, `git log --follow -- illustration-bundles.md`, the named pull requests, and direct artwork commits. Species totals and coverage descriptions in that legacy page are contributor-authored claims and require current validation.

| Contributor | Public evidence |
| --- | --- |
| @SupraBitKid / Kai Bidstrup | [PR #59](https://github.com/Twarner491/AvianVisitors/pull/59), index commit `436cbc99` |
| @theskyisthelimit | [commit `028fe1ff`](https://github.com/Twarner491/AvianVisitors/commit/028fe1ff0e400a1060db5f47f71c43a8a16ba6f7) |
| @bassrelic | [commit `3f6cf1d4`](https://github.com/Twarner491/AvianVisitors/commit/3f6cf1d4f429c344709c95c5c01838c59438eedf), [commit `32b3e49c`](https://github.com/Twarner491/AvianVisitors/commit/32b3e49c720f8b6fd3cdebc928151fcdaf8b666e) |
| @RoqueAlonso | [PR #37](https://github.com/Twarner491/AvianVisitors/pull/37), index commit `6943ea1e` |
| @jonnywright | [PR #39](https://github.com/Twarner491/AvianVisitors/pull/39), index commit `913e71f9` |
| @TheWillni / Nick | [PR #40](https://github.com/Twarner491/AvianVisitors/pull/40), index commit `3c8c2edd` |
| @lloydalexporter / Lloyd Alex Porter | [PR #50](https://github.com/Twarner491/AvianVisitors/pull/50), index commit `ff640bee` |
| @opurtell | [PR #65](https://github.com/Twarner491/AvianVisitors/pull/65), index commit `4515065d` |
| @peterdeboer-nl | [PR #82](https://github.com/Twarner491/AvianVisitors/pull/82), index commit `74b92721` |
| @cdkl / Chris Klein | [commit `60c43d77`](https://github.com/Twarner491/AvianVisitors/commit/60c43d77107f42a927d1d850608ba7dc5476d95f), retained attribution in [PR #27](https://github.com/Twarner491/AvianVisitors/pull/27) |

Names in the table come from public GitHub author or pull-request metadata. Commit email addresses were neither recorded nor selected as contact routes.

## Media provenance

- The release allowlist contains three files. `evolutionary-impressionist-station.jpg` (919×863) and `station-impressionist-active.jpg` (1280×720) are light-mode product captures, visually reviewed on October 3. The first shows the real Collage with Impressionist active; the second shows that active choice in Settings.
- `evolutionary-impressionist-frame.jpg` (4032×3024) is Teddy's own photograph of the physical frame displaying Evolutionary Impressionist, supplied and approved for the release draft on October 3. The release copy preserves the original pixels and Display P3 profile, with EXIF, XMP, and IPTC metadata removed. The Photos original is untouched. Teddy explicitly held publication.
- [Media SHA-256 checksums](MEDIA_SHA256SUMS.txt) bind those three files. No other local media is approved for the source commit or release assets.
- The original captures were made from loopback product pages at `127.0.0.1:8799` and `127.0.0.1:8137` through the Codex in-app browser on 2026-09-03. The old Settings browser capture has stale catalog copy and an unavailable banner. Review-queue captures have not been confirmed to contain only synthetic fixtures.
- The historical MP4 is a 1280×720, 30 fps, 10.20-second H.264 loop with no audio; its GIF fallback is 960×540. Those files, the X still, the review captures, and all other images outside the allowlist remain excluded local-only drafts. Do not stage `images/` recursively.
- No media was uploaded or posted.
