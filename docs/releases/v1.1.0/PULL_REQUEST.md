# [RELEASE] Avian Visitors v1.1.0

## Summary

This release adds a root-managed local administrator gate, a compact sharing and retention Settings surface, explicit BirdWeather consent, a Settings-owned Nightly Drive archive, canonical station naming, and a browser choice between stamp and classic Atlas cards.

## Product changes

- Add optional local-network password protection for administrator controls.
- Close continuous live audio and systemd Icecast starts while protection is required.
- Add password setup, change, idle lock, cross-tab replacement, and SSH recovery.
- Add explicit BirdWeather enablement, full-audio consent, privacy level, a verified-token handoff, and inline view-or-forget actions.
- Move Nightly Drive backup from Tools to Settings and serialize it with retention changes.
- Keep only detections and recordings downloads under Tools > Your data.
- Add canonical station-name editing through `SITE_NAME`.
- Use a standard switch for bird-name visibility and an icon theme picker for system, light, and dark modes, with accessible names and tooltips matching the Atlas sort controls.
- Add a per-browser classic Atlas card preference based on the last pre-stamp Atlas.
- Remove redundant Settings headings, copy, and visible live-audio warning.
- Refine disclosure motion, tooltip interaction, focus treatment, segmented controls, and Atlas repacking after admin overlays.

## Security and privacy

- Store the local policy, bcrypt verifier, and monotonic epoch in root-owned state outside config and backups.
- Require explicit proof again inside the privileged helper for policy and password changes.
- Fail closed on missing, corrupt, stale, or unsafe state.
- Keep BirdWeather tokens write-only to ordinary API reads, clear them from Settings after verification, and proof-gate the reveal endpoint.
- Reject token path segments, controls, malformed remote responses, stale probe metadata, redirects, ambient proxy credentials, and netrc credentials.
- Default new BirdWeather stations to sharing off and full-audio uploads off.
- Redact config, journal, service-unit, URL, and historical credential forms from diagnostics.
- Guard Icecast starts at systemd regardless of its XML path, port, or bind address.

## Compatibility

- Preserve migrated BirdWeather behavior for stations that were already sharing.
- Preserve the existing Atlas filters, current time-window behavior, current postcard, and deep links in both Atlas layouts.
- Preserve explicit local-frame title overrides while allowing an unset frame title to inherit `SITE_NAME`.
- Preserve archive setup, run, verification, cleanup, and schedule behavior after moving its interface.
- Validate generated Caddy routes with current Caddy and the supported 2.6.4 baseline.

## Test plan

- [x] PHP syntax and endpoint suites
- [x] Node syntax and frontend interaction suites
- [x] Python architecture, reporting, and diagnostic suites
- [x] Root administrator transaction smoke
- [x] Generated Caddy route smoke on 2.6.4 and current Caddy
- [x] Live policy transition and established-listener EOF smoke
- [x] First-hop update and reinstall smoke
- [x] Installer and security refresh smoke
- [x] BirdWeather migration, token, autosave, and network contract smoke
- [x] Nightly archive control, worker, and API smoke
- [x] Classic Atlas layout, audio, sort, window, and postcard smoke
- [x] Local fixture contract smoke
- [x] Desktop light and dark browser QA
- [x] Narrow viewport, keyboard, touch disclosure, and reduced-motion QA
- [ ] Upload all seven release-note JPGs and verify every published image returns HTTP 200
- [ ] Real PID 1 systemd guard smoke in an explicitly approved privileged disposable container
- [x] `git diff --check`
- [x] No added em dash or en dash bytes
- [x] Owner review completed before release staging and commits

## Review artifacts

- Release-note screenshots: `docs/releases/v1.1.0/screenshots/`
- Draft release notes: `docs/releases/v1.1.0/RELEASE_NOTES.md`

## Follow-up work

- Browser automation can be promoted from the local fixture to CI after the reviewed Pi routes are stable.
- Authenticated continuous microphone streaming remains deliberately deferred.
- Educator tools are deferred to a later discovery-led release. Interview teachers, museum staff, and science-center operators first, then implement the smallest validated classroom workflow step by step.
