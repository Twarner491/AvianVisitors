# [RELEASE] Avian Visitors v1.3.0 illustration bundles

## Summary

This release adds one reviewed illustration bundle flow across the station, BirdFrame, and [avianvisitors.com/bundles](https://avianvisitors.com/bundles). People can browse and install a set, export their local illustrations as one upload-ready ZIP, share it for review, and manage the result from the same catalog.

## Product changes

- Add **Settings > Bird bundle** with search, region filters, downloaded-first ordering, and a clear active state.
- Keep the public catalog and its station embed visually and behaviorally aligned.
- Add **Tools > Your data > Export bundle** for a reviewed, upload-ready ZIP.
- Keep **Use on my local station** as the primary action and add one command button that opens and copies `sudo avian-bundle use '<BUNDLE_ID>'` for stations and BirdFrames.
- Add GitHub sign-in, one-ZIP upload, validation status, changes-requested follow-up, and published bundle views.
- Support archives up to 768 MiB and 1,500 PNG objects while retaining the 4 MiB per-image, 640 MiB expanded-content, and 1,000-species limits.
- Keep Japanese Woodblock included and make Evolutionary Impressionist an optional verified download.
- Keep downloaded bundles and the active selection across normal updates and reinstalls.
- Use the saved device location to select year-round local birds, with an explicit full-set option.
- Link catalog contributors to their GitHub profiles.

## Security and privacy

- Resolve installs by trusted catalog ID and immutable manifest hash.
- Bound catalog, archive, file-count, image, and expanded-size inputs.
- Decode and inspect PNGs without executing bundle content.
- Stage and verify every object before atomic activation, with rollback on failure.
- Keep the BirdFrame launcher root-owned, bind it to the setup account, and drop privileges before checkout code runs.
- Send only a broad region to the public catalog, never station coordinates.
- Keep contributor ZIPs private during automated checks and maintainer review.
- Use identity-only GitHub OAuth with no repository scopes.
- Require explicit maintainer approval before immutable publication.
- Treat bird/style quality findings as advisory. Technical validation, supported licensing, complete clean safety moderation, and human approval remain required.

## Compatibility

- Preserve Japanese Woodblock as the included offline default.
- Preserve the active bundle and managed library during updates and reinstalls.
- Use the same command on a station and BirdFrame after SSH.
- Keep generated artwork compatible with the existing restyle, cutout, and mask pipeline.

## Test plan

Unless dated otherwise, the checked items below record October 3 acceptance, with scoped October 5 and 6 evidence in the release checklist. They are not a fresh pass on the final release tree.

- [x] Station bundle manager, catalog refresh, PHP endpoint, export, and runtime suites
- [x] Station Settings, catalog parity, image sandbox, installer, update, and Caddy smoke suites
- [x] Hosted catalog, upload, review, publication, CORS, and HTTP suites
- [x] October 3 localhost desktop, phone, keyboard, disclosure, upload, and one-image collage browser QA
- [x] October 6 iPhone Safari preview accepted by Teddy; no mobile code fix claimed
- [x] BirdFrame local and ARM64 bundle runtime suites
- [x] Independent adversarial security review with no open Critical, High, or Medium findings
- [x] `git diff --check`
- [x] No em dash characters in release-facing Markdown
- [x] Location-aware station and frame selection, retained images, and real-model integration checks
- [x] Physical BirdFrame install, panel refresh, rollback, repeat install, integrity, and scheduled-service checks
- [x] Human visual confirmation of the physical Impressionist panel
- [x] Restore Woodblock for filming with verified artwork, unchanged config, and enabled timer
- [x] Integrate upstream through `265d7e7f` and record the October 3 local gates
- [x] Integrate current upstream `543c4473` without rewriting contributor history or losing candidate changes
- [x] October 6 software-confirmed Impressionist panel update, installed-artwork verification, unchanged config, and enabled timer; no software upgrade or fresh human visual acceptance
- [x] Rerun affected local gates and independently review the explicit 195-file source inventory
- [ ] Run candidate-branch GitHub CI after an approved push

October 6 integrated results: 667 Python passes (65 environment/privilege skips), 57 isolated publication tests, 38 browser capture tests, 65 installer security checks, 11 frontend smokes, six taxonomy tests, and 56 PHP runtime checks. Fresh install, update, reinstall, pre-v1 migration, interrupted/offline recovery, generation, Caddy, coordination, and image-sandbox smokes passed. Worker checks passed 229 JavaScript tests, four uploader tests, 12 preview checks, and 52 HTTP checks. Exact-candidate CI remains the merge gate.

## Review artifacts

- Release notes: `docs/releases/v1.3.0/RELEASE_NOTES.md`
- Commit map: `docs/releases/v1.3.0/COMMIT_PLAN.md`
- Owning Worker PR draft: `docs/releases/v1.3.0/WORKER_PULL_REQUEST.md`
- Remaining checklist: `docs/releases/v1.3.0/RELEASE_CHECKLIST.md`
- Source evidence: `docs/releases/v1.3.0/SOURCE_EVIDENCE.md`
- Physical frame acceptance: `docs/releases/v1.3.0/PHYSICAL_FRAME_ACCEPTANCE.md`
- Reviewed media: the three-file allowlist and checksums in `docs/releases/v1.3.0/LAUNCH_MEDIA.md`, including Teddy's physical-frame photo; all other local captures are excluded from commits and release assets
- Catalog browsing excludes GitHub-only migration listings, regions, and credits; verified downloaded sets remain available. The public-site change was deployed and verified on 2026-10-03. All nine contributor invitations were sent.

## Release gate

Teddy authorized the release on October 6 after checking the preview in iPhone Safari. `alpha/bundles-v1.3.0` includes upstream `543c4473`; final local results are recorded in the release checklist. Merge requires green CI on the exact candidate. Physical visual acceptance remains the October 3 check; the October 6 Impressionist switch was verified in software. No Worker deployment or private acceptance change is included.
