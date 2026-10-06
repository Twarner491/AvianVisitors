# Legacy illustration bundle migration

Tracked follow-up for the move from `illustration-bundles.md` to the reviewed catalog at [avianvisitors.com/bundles](https://avianvisitors.com/bundles). This file records migration work; it is not a public submission queue and does not authorize publishing or installing any linked repository.

## Removal TODO

- [ ] Remove `illustration-bundles.md` only after every row below has a recorded outcome, every accepted set is visible in the reviewed catalog, declined or unreachable entries have an archived attribution record, README and website backlinks no longer depend on the legacy file, and one complete station release has shipped with the catalog link as the primary route.

Until those conditions are met, keep the legacy Markdown page as a read-only failsafe. The public bundle page and station catalog show only hosted, installable artwork. Do not display GitHub-only listings, regions, or contributor credits there before the corresponding bundle is reviewed and published. Keep those historical links in this ledger and the legacy Markdown page, never as station install authority.

## Migration ledger

| Region or set | Maintainer | Evidence | Current status |
| --- | --- | --- | --- |
| Florida, US (`US-FL`) | [@SupraBitKid](https://github.com/SupraBitKid) | [PR #59](https://github.com/Twarner491/AvianVisitors/pull/59) | [Sent 2026-10-03](https://github.com/Twarner491/AvianVisitors/pull/59#issuecomment-5973790233) |
| Bern, Switzerland (`CH-BE`) | [@theskyisthelimit](https://github.com/theskyisthelimit) | [illustration commit](https://github.com/Twarner491/AvianVisitors/commit/028fe1ff0e400a1060db5f47f71c43a8a16ba6f7) | [Sent 2026-10-03](https://github.com/theskyisthelimit/AvianVisitors/commit/028fe1ff0e400a1060db5f47f71c43a8a16ba6f7#commitcomment-203310471) |
| Germany | [@bassrelic](https://github.com/bassrelic) | [first art commit](https://github.com/Twarner491/AvianVisitors/commit/3f6cf1d4f429c344709c95c5c01838c59438eedf), [follow-up art commit](https://github.com/Twarner491/AvianVisitors/commit/32b3e49c720f8b6fd3cdebc928151fcdaf8b666e) | [Sent 2026-10-03](https://github.com/bassrelic/AvianVisitors-German-Fork/pull/1#issuecomment-5973792541) |
| Iberian Peninsula (`ES-MD`, `ES-CM`, partial elsewhere) | [@RoqueAlonso](https://github.com/RoqueAlonso) | [PR #37](https://github.com/Twarner491/AvianVisitors/pull/37) | [Sent 2026-10-03](https://github.com/Twarner491/AvianVisitors/pull/37#issuecomment-5973794378) |
| Derbyshire, UK (`GB-ENG-DBY`) | [@jonnywright](https://github.com/jonnywright) | [PR #39](https://github.com/Twarner491/AvianVisitors/pull/39) | [Sent 2026-10-03](https://github.com/Twarner491/AvianVisitors/pull/39#issuecomment-5973794359) |
| England, UK (`GB-ENG`) | [@lloydalexporter](https://github.com/lloydalexporter) | [PR #50](https://github.com/Twarner491/AvianVisitors/pull/50) | [Sent 2026-10-03](https://github.com/Twarner491/AvianVisitors/pull/50#issuecomment-5973794369) |
| Groningen, Netherlands (`NL-GR`) | [@peterdeboer-nl](https://github.com/peterdeboer-nl) | [PR #82](https://github.com/Twarner491/AvianVisitors/pull/82) | [Sent 2026-10-03](https://github.com/Twarner491/AvianVisitors/pull/82#issuecomment-5973795476) |
| Victoria, Australia (`AU-VIC`) | [@TheWillni](https://github.com/TheWillni) | [PR #40](https://github.com/Twarner491/AvianVisitors/pull/40) | [Sent 2026-10-03](https://github.com/Twarner491/AvianVisitors/pull/40#issuecomment-5973795489) |
| Canberra / ACT, Australia (`AU-ACT`) | [@opurtell](https://github.com/opurtell) | [PR #65](https://github.com/Twarner491/AvianVisitors/pull/65) | [Sent 2026-10-03](https://github.com/Twarner491/AvianVisitors/pull/65#issuecomment-5973795480) |

All nine invitations were verified by readback as @Twarner491 at 21:48:01 UTC on 2026-10-03. They invite submission, not publication approval. The GitHub release remains on hold.

The legacy species totals and coverage descriptions are contributor claims carried forward from the old index. Reconfirm them through the current validator rather than treating this table as verification.

## Attribution follow-up

@cdkl was not contacted in this outreach.

[@cdkl](https://github.com/cdkl) contributed the original Eastern North American artwork later refined into the shipped set; see [commit `60c43d77`](https://github.com/Twarner491/AvianVisitors/commit/60c43d77107f42a927d1d850608ba7dc5476d95f) and the retained credit in [PR #27](https://github.com/Twarner491/AvianVisitors/pull/27). This is not a legacy external listing, but confirm whether there is a separately maintained regional pack they want represented and preserve their authorship in bundle provenance where applicable.

## Migration procedure

1. Contact each maintainer through the public GitHub thread or repository connected to their contribution. Do not use commit-email addresses for unsolicited outreach.
2. Ask the maintainer to choose the public style, region, license, creator credit, source link, and cover bird. Do not infer a license from repository visibility.
3. Invite the maintainer to sign in with GitHub and upload their existing PNGs or bundle ZIP through the hosted contribution flow. No regeneration is needed; the upcoming release adds **Tools > Your data > Export bundle** for creating a ZIP on a station.
4. Keep uploads private through deterministic validation, safety moderation, advisory bird/style review, and maintainer review.
5. Publish only the exact approved manifest and canonical image objects. Record the resulting catalog URL in this ledger.
6. Leave declined, abandoned, or unreachable sources in the legacy file until an archival decision is recorded here.

The sent message and invitation links are recorded in [`docs/releases/v1.3.0/CONTRIBUTOR_OUTREACH.md`](releases/v1.3.0/CONTRIBUTOR_OUTREACH.md).
