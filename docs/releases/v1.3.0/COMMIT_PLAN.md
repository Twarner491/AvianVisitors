# Avian Visitors v1.3.0 commit map

Teddy authorized the branch, squash merge, and v1.3.0 release on October 6. The release branch is `alpha/bundles-v1.3.0`, based on upstream `543c4473`. These subjects define the focused commit groups. Stage explicit paths and inspect each staged patch. Shared frontend changes stay together in group 3; shared BirdWeather changes stay together in group 5.

The candidate preserves upstream capture and interrupted-upgrade fixes through `543c4473`. Integration also aligns the pre-v1 prepared payload, isolates test imports, and rejects same-revision image-source changes during capture. Upstream commits are not recreated as bundle work. Recheck upstream before merge and require green candidate CI.

## Station and BirdFrame

1. `feat(bundles): add a verified station illustration library`
   - Add the versioned catalog, immutable manifests and local selection profiles, bounded downloads, atomic activation, and rollback.
   - Resolve year-round birds with the saved location and local metadata model; retain an explicit full-set option.
   - Paths: `avian/bundles/catalog-v1.json`, `avian/scripts/bundle_{manager,species}.py`, `avian/api/bundle-{assets,preview,runtime,species}.php`, `avian/api/bundles.php`, and the active-bundle identity, table-loading, artwork-refresh, and postcard-pose runtime hunks in `avian/frontend/apt.js`.

2. `chore(bundles): lock the official publication payload`
   - Freeze the official station and public manifests with their content-addressed objects and read-only verification plan.
   - Paths: `avian/bundles/publication-lock-v1.json`, `scripts/verify_official_bundle_publication.py`, `tests/test_official_bundle_publication.py`, `docs/official-bundle-publication.md`.

3. `feat(settings): browse and select illustration bundles`
   - Add **Bird bundle** below Theme, a sandboxed catalog drawer, coarse region filtering, downloaded-first ordering, and a clear active state.
   - Keep the station parent as the install authority. The embedded catalog can request only a bundle ID.
   - Paths: the bundle-browser hunk in `avian/frontend/apt.js`, `avian/frontend/index.html`, `avian/frontend/bundle-ui.js`, `avian/frontend/bundles.css`, `avian/frontend/assets/bundle-catalog/**`, `.gitattributes`, and `scripts/vendor_bundle_catalog.mjs`. The exact-path whitespace exception preserves the checksum-verified upstream font license verbatim.

4. `feat(tools): export an upload-ready illustration bundle`
   - Review the local illustration set and download one deterministic ZIP with its manifest, license, and canonical PNGs.
   - Keep export local and explicit. Align export with 768 MiB archives and 1,500 objects while retaining 640 MiB expanded content, 4 MiB images, the station 4 MP guard, and disk headroom. Never upload from the station automatically.
   - Paths: `avian/api/export.php`, `avian/scripts/bundle_export.py`, `avian/scripts/bundle-taxonomy-v1.json`, the Export bundle hunk in `avian/frontend/apt.js`, and `avian/scripts/test_bundle_export.py`.

5. `feat(frame): install verified bundles with the station command`
   - Support `sudo avian-bundle use '<BUNDLE_ID>'` on both a station and BirdFrame.
   - Verify the manifest and selected local artwork before rendering; restore the prior selection if rendering fails.
   - Paths: `scripts/avian-bundle`, `frame/bundle_runtime.py`, `frame/vendor/**`, `frame/birdweather.py`, `frame/config.example.toml`, `frame/display.py`, `frame/shoot.py`, `frame/generate_illustrations.py`.

6. `fix(frame): harden the installed command and installer`
   - Install a root-owned, setup-account-bound launcher that drops privileges with a reset environment and no-new-privileges before entering checkout code.
   - Pin the installer parse boundary, keep the eBird key out of long-running argv, preserve it for CLI renders in a private file, and generate fixed units.
   - Paths: `.github/workflows/frame-installer-security.yml`, `frame/Dockerfile.install-security`, `frame/check_install_security.sh`, `frame/avian-bundle`, `frame/avian-bundle-installed`, `frame/install.sh`, `frame/requirements-{shoot,bundle-species}.txt`, `frame/systemd/birdframe.service`, `frame/test_install_security.py`, `frame/test_ebird_credentials.py`, the credential hunk in `frame/birdweather.py`, the security hunks in `frame/test_bundle_render_integration.py`, and `tests/test_frame_birdweather.py`.

7. `fix(install): persist and expose bundle state`
   - Preserve the managed library across update and reinstall paths, then render only the required local routes and fixed privileged actions.
   - Paths: `scripts/bootstrap_v1.sh`, `scripts/install_services.sh`, `scripts/link_webroot.sh`, `scripts/reinstall_services.sh`, `scripts/security_refresh.sh`, `scripts/update_birdnet.sh`, `scripts/update_caddyfile.sh`, `scripts/generation_runtime_control.sh`, the selection/revision boundary in `avian/api/cutout.php`, and the included-art transaction hunks in `avian/scripts/{build_masks,generate_one,pregen,cutout,upgrade_cutouts,install_upgraded_cutouts}.py` and `avian/api/generate.php`.

8. `test(bundles): cover trust, export, lifecycle, and rendering`
   - Cover manager, feed, PHP, sandbox, Settings handoff, export, installer, update, Caddy, frame, rollback, and catalog parity boundaries.
   - Paths: remaining `tests/*bundle*` files, `avian/scripts/test_bundle_species.py`, `tests/test_frame_capture.py`, `tests/test_frame_capture_browser.py`, `tests/test_image_publication.py`, `tests/test_build_masks_transaction.py`, `tests/test_generate_one_revision.py`, `tests/test_upgrade_cutouts.py`, `tests/test_issue_80_art.py`, `tests/smoke_coordination_policy.sh`, `tests/smoke_admin_control.sh`, `tests/smoke_admin_ui_polish.mjs`, `tests/smoke_atlas_classic.mjs`, `tests/smoke_educators_ui.mjs`, `tests/test_generation_install_fixes.py`, `tests/test_wikipedia_reference_urls.py`, affected installer, generation, and Caddy smoke files, and `frame/test_bundle_*.py`.

9. `docs(bundles): document the complete bundle workflow`
   - Make the README the primary guide for browsing, installing, exporting, sharing, restyling, and low-memory cutouts.
   - Keep `illustration-bundles.md` only as a migration record until every legacy listing has an outcome.
   - Paths: `README.md`, `illustration-bundles.md`, `docs/bundle-catalog-migration.md`, `avian/scripts/README.md`, `frame/README.md`.

10. `ops(review): pin the maintainer review boundary`
    - Keep the review UI and API behind exact-email Cloudflare Access with one-time PIN authentication.
    - Paths: `ops/cloudflare/bundle-review-access.json`, `ops/cloudflare/bundle-review-access-receipt.json`, `scripts/provision_bundle_review_access.py`, `tests/test_provision_bundle_review_access.py`, `docs/bundle-review-zero-trust.md`. The config and receipt intentionally record reviewed non-secret operational identifiers; no credentials, tokens, or sessions belong in either file.

## Validation and publication

These public-repository sources are not the secret-bearing workflow authority. The separately authorized October 5 rollout uses private `Twarner491/avian-visitors-bundle-acceptance` protected tag `bundle-acceptance-v1.0.5` at `1ed16095dbbe20eb06c04d9ae10b19d2465454fd`; private CI and production rollout verification passed. The October 3 `v1.0.4` audit is historical. Keep the private/public boundary unchanged. This software release does not authorize adding secrets, dispatching public workflows, or promoting another acceptance tag.

11. `feat(review): validate and triage submitted bundles`
    - Add deterministic archive, manifest, and PNG hard gates plus bounded bird and style review.
    - Keep secret-bearing steps byte-bound to the validated inventory. Admit 768 MiB archives and 1,500 objects; use a dedicated 3 MiB UTF-8 review index across producer and readers without widening uploaded text, moderation reports, image/content limits, or decoder imports.
    - Paths: `.github/workflows/validate-bundle.yml`, `.github/workflows/bundle-validation-requirements.txt`, `avian/scripts/bundle_{validation_contract,validate,submission_check,canonical,review_package,moderate,ai_review,review_assets,canonical_upload,validation_report,http}.py`.

12. `feat(bundles): publish only approved canonical artwork`
    - Build the exact approved object inventory and bounded previews without reopening or re-encoding the contributor ZIP. Align publication workflow/client inventory checks to 1,500 objects and ordinal 1499 while retaining canonical and publication index caps.
    - Paths: `.github/workflows/publish-bundle.yml`, `avian/scripts/bundle_{inventory_commitment,preview_geometry,publication_package,publish}.py`.

13. `test(review): enforce submission and workflow boundaries`
    - Cover ZIP bombs, path collisions, PNG polyglots, hidden-alpha payloads, inventory binding, stale attempts, private artifacts, and publication authorization. Include real 1,500-image capacity, maximum supported names, exact byte/count boundaries, and unchanged decoder guards.
    - Paths: new `avian/scripts/test_bundle_limit_capacity.py`; the validation, submission-check, review-package, moderation, AI-review, review-assets, canonical-upload, validation-report, HTTP, preview-geometry, publication-package, publish, and workflow-security `avian/scripts/test_bundle_*.py` files. Export-capacity tests remain in group 4.

## Hosted catalog

The hosted work belongs in `/Users/twarn/Repositories/avianvisitors-bundle-worker`, not the ignored `assembled/site` copy. Its baseline `ac607d2` already contains the original intake and acceptance v1.0.4 implementation. The groups below cover the current changes, not that existing history. The October 5 capacity/advisory rollout and production migration 0008 passed verification. Later publishing-credential renewal and Germany's separately authorized publication are recorded in [SOURCE_EVIDENCE.md](SOURCE_EVIDENCE.md), including the rollback credential caveat. Code integration is authorized; another deployment is not.

14. `feat(site): refine bundle selection and account controls`
    - Refine catalog selection, attribution, account controls, and review presentation with their UI regressions. Show only hosted, installable listings; preserve verified downloaded sets in the station library. Align browser capacity, bounded cancellable 429 retry, and advisory bird/style presentation with server hard gates.
    - Paths: `public/bundles/assets/{bundles.js,bundles.css,bundle-review.js}`, `public/bundles/index.html`, `public/bundles/review/index.html`, `public/catalog/bundles-v1.json`, `test_bundle_review_ui.mjs`, `test_bundles_behavior.mjs`, `test_bundles_ui.mjs`, `docs/bundle-service.md`.

15. `feat(bundles): expand bounded intake and preserve approval gates`
    - Admit 768 MiB archives and 1,500 canonical objects; retain image/content budgets and reject colliding runtime slugs. Make bird/style quality advisory while technical validation, supported licensing, complete clean safety moderation, and human approval remain required.
    - Add only forward migration 0008, preserving populated state and rollback; do not rewrite historical migrations.
    - Paths: `src/bundles.js`, `src/bundle_review.js`, `migrations/0008_bundle_intake_limits.sql`, `test_bundle_limits.mjs`, `test_bundle_station_catalog.mjs`, `test_bundle_review_api.mjs`, `test/schema.test.mjs`, `scripts/http_acceptance.py`, `scripts/test_http_acceptance.sh`.

16. `docs(ops): lock versioned bundle maintenance procedure`
    - Pin the dedicated account and require strict, versioned intake-off/intake-on rollout, exact-resource equality, and immutable rollback. Keep plain deployment blocked.
    - Pin protected acceptance `v1.0.5` and retain the intake-off migration, invariant verification, and rollback requirements.
    - Paths: `DEPLOYMENT.md`, `scripts/deploy-blocked.mjs`, `wrangler.toml`, and `test_bundle_validation_dispatch.mjs`. Committing these files does not authorize deployment.

## Release documentation

17. `docs(release): prepare Avian Visitors v1.3.0`
    - Add the final README section, station and Worker pull-request drafts, release notes, source evidence, reviewed media, and commit map. The Worker draft documents changes owned by the Worker repository; keeping its review copy here does not move that source into the station repository.
    - Paths under `docs/releases/v1.3.0/`: `COMMIT_PLAN.md`, `CONTRIBUTOR_OUTREACH.md`, `LAUNCH_MEDIA.md`, `PHYSICAL_FRAME_ACCEPTANCE.md`, `PULL_REQUEST.md`, `WORKER_PULL_REQUEST.md`, `RELEASE_CHECKLIST.md`, `RELEASE_NOTES.md`, `RELEASE_PREVIEW.html`, `SOURCE_EVIDENCE.md`, `MEDIA_SHA256SUMS.txt`, `images/evolutionary-impressionist-station.jpg`, `images/station-impressionist-active.jpg`, and `images/evolutionary-impressionist-frame.jpg`.
    - Do not stage this directory recursively. Every other image, video, GIF, and rendered preview in it is an excluded local-only draft. Review screenshots have unconfirmed synthetic provenance; other captures contain stale UI. Do not commit or upload them.

18. `test(export): isolate peak memory and station runtime fixtures`
    - Measure current-exec Linux peak RSS without inherited TensorFlow history; retain the 192 MiB limit.
    - Provision the production-shaped PHP test site with the test interpreter. Keep the production runtime allowlist unchanged.
    - Paths: `avian/scripts/test_bundle_export.py`, `docs/releases/v1.3.0/{COMMIT_PLAN.md,RELEASE_CHECKLIST.md,SOURCE_EVIDENCE.md}`.

## Gates before any commit or release

- Verify the integrated station baseline still contains current upstream without rewriting contributor commits.
- Inspect every staged patch and run `git diff --cached --check` for each commit.
- Run the settled station, frame, validation, hosted Worker, HTTP, and browser matrices.
- Teddy accepted the iPhone Safari preview on October 6. No mobile code fix is claimed. The frame switch is separately recorded as software-confirmed, not a software upgrade or fresh human visual acceptance.
- Verify the public catalog, immutable resources, strict station feed, routes, and CORS against the deployed Worker.
- Confirm no source ZIP, private review data, secret, token, local fixture, or ignored assembled output enters a commit.
- Physical installation, refresh, rollback, scheduled-service checks, and human visual confirmation passed on October 3. Woodblock was restored for filming with an unchanged config and enabled timer; see `PHYSICAL_FRAME_ACCEPTANCE.md`.
- Complete [the release checklist](RELEASE_CHECKLIST.md) before merge and publication. Teddy authorized the commit, push, CI, squash merge, tag, asset-upload, and publication workflow on October 6. Worker deployment, acceptance-tag changes, social posts, and outreach remain outside that workflow.
