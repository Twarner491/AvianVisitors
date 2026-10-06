# [DRAFT] Bundle catalog, intake capacity, and review policy

Owning repository: `Twarner491/avianvisitors-bundle-worker`. Release branch: `alpha/bundles-v1.3.0`, based on `ac607d2bdbc470f6273094b2062e78c4b58bbc2e`. Code integration is part of the October 6 release approval; deployment remains separate.

## Summary

Refine catalog selection and account controls, increase bounded upload capacity, and make bird/style quality findings advisory without weakening publication gates. The original intake implementation is already in the baseline; this PR covers the changes since it.

## Changes

- Show hosted, installable catalog listings while preserving verified downloaded sets in the station library. Keep attribution, account controls, and review presentation aligned with browser behavior.
- Support 768 MiB archives and 1,500 canonical objects, with bounded cancellable retries for upload rate limits. Retain 4 MiB per-image, 640 MiB expanded/canonical-content, and 1,000-species limits; reject colliding runtime illustration slugs.
- Keep bird/style quality findings advisory. Technical validation, supported licensing, complete clean safety moderation, matching inventory commitments, and explicit human approval remain required for publication.
- Add forward migration `0008_bundle_intake_limits.sql`; preserve existing rows and historical migrations.
- Pin private protected acceptance `bundle-acceptance-v1.0.5` and keep strict versioned intake-off/intake-on deployment, exact-resource checks, and rollback controls. Plain deployment remains blocked.

## Verification

Historical October 5 evidence records 226 Worker JavaScript tests, four uploader tests, 12 preview records, production migration invariant checks, and 23 anonymous HTTP checks over 26 requests. Later credential-recovery checks recorded 229 Node tests. These results describe their tested checkpoints, not a fresh pass on this final PR tree.

Fresh October 6 checks passed 229 JavaScript tests, four uploader tests, 12 preview checks, and 52 HTTP checks with zero failures. Teddy accepted the iPhone Safari preview. No mobile code fix is claimed.

- [x] Record iPhone Safari acceptance and passing hosted behavior, UI, and vendored parity checks.
- [x] Include the independently reviewed dispatch diagnostic: only an HTTP status or `network`, never response bodies or credentials. This source change has not been deployed.
- [x] Run `npm run check` and `npm run check:http`: 229 JavaScript tests, four uploader tests, 12 previews, and 52 HTTP checks passed.
- [ ] Freeze and scan the explicit source inventory. Exclude secrets, private review records, source uploads, local fixtures, and generated output.
- [ ] After approval, create the focused commits, push the reviewed branch, and run the repository's applicable CI/review gates.

## Operations boundary

The separately authorized October 5 capacity rollout and credential renewals are historical operations, not actions authorized by this PR. Earlier rollback versions lack one or both renewed dispatch credentials; review that constraint before any rollback. Public software-release approval does not authorize another Worker deployment, protected acceptance-tag change, secret change, bundle approval, or publication.

Iberian validation workflow `37380235706` completed with conclusion `success` on October 5 at 22:21:03 UTC. A separate October 6 public-discovery check found Germany and Iberia installable at `1.0.0`, with no QA listing. This verifies public discovery, not Iberia's approval actor/history or a device installation.

## Review artifacts

- [Commit groups 14 through 16](COMMIT_PLAN.md#hosted-catalog)
- [Station PR draft](PULL_REQUEST.md)
- [Dated source and operational evidence](SOURCE_EVIDENCE.md)
- [Remaining release gates](RELEASE_CHECKLIST.md)
