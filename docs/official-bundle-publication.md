# Official bundle publication gate

The checked-in publication lock keeps two deliberately distinct authorities:

- `station-install` is the exact v1.0.0 payload already used by the station
  catalog (`019d…` woodblock and `e069…` impressionist).
- `public-discovery` is the exact payload bound to the public catalog and its
  preview geometry (`31fc…` woodblock and `9d07…` impressionist).

The duplicate logical IDs and versions do not make these manifests
interchangeable. All four manifests must be published at their own immutable
checksum URLs. Their shared objects are deduplicated by checksum.

## Frozen payload

`avian/bundles/publication-lock-v1.json` commits to:

- 4 manifests and 1,999 unique PNG objects
- 977,739,928 total bytes
- publication plan SHA-256
  `f18737e16d969aa02c711f1e6440c40a7853c14c077224328f7aac75d495d8d1`

The local verifier reads the old station object tree and the newer public ZIPs
without extracting or copying either set:

```sh
python3 scripts/verify_official_bundle_publication.py \
  --station-publication-root /Users/twarn/Repositories/AvianVisitors-bundles-rc/.avian/bundle-publication \
  --discovery-publication-root /Users/twarn/Repositories/AvianVisitors/.avian/publication \
  --discovery-catalog /Users/twarn/Repositories/AvianVisitors/assembled/site/public/catalog/bundles-v1.json
```

Add `--emit-plan` to obtain the exact source locator, destination R2 key, public
URL, checksum, and byte count for every file. The verifier is read-only and has
no publication credential or mutation path.

## External publication and release order

Publication remains a separately approved external action. Upload exactly the
emitted plan to the dedicated `avianvisitors-bundles` R2 bucket, preserving the destination keys
under `bundles/{manifests,objects}/sha256/`. Do not change a checksum URL in
place and do not substitute one authority's manifest for the other.

After upload, first check availability and response policy without downloading
all PNG bodies:

```sh
python3 scripts/verify_official_bundle_publication.py --live --head-only
```

Then run the release gate, which downloads and hashes all 977,739,928 published
bytes:

```sh
python3 scripts/verify_official_bundle_publication.py --live
```

Only after the full live-content gate succeeds may
`official-western-us-impressionist` change from `unavailable` to `installable`
in both the station catalog and the public discovery catalog. Make those two
availability-only changes together; do not alter either manifest identity or
its preview geometry. Until then, the station and standalone catalog UIs stay
fail-closed rather than offering a download that returns 404.

The optional community catalog refresh uses the canonical mutable Worker route
`https://avianvisitors.com/api/bundles/catalog/community-v1.json`. The Worker
materializes each strict station-only entry while its checksum-addressed
manifest and preview geometry are already verified, then atomically selects the
highest confirmed SemVer head in D1. Anonymous GET/HEAD rechecks that committed
snapshot and published-state join without reading R2; it does not reuse the
looser browser-discovery catalog as installation authority. The route is
bounded to 2 MiB and 1,000 current packs, returns only public bundle metadata,
and fails closed if a persisted publication cannot satisfy the station
manifest contract.

This route is locally implemented and tested, but it is not operational until
the matching Worker build has been deployed and a live GET/HEAD smoke confirms
its JSON, CORS, cache policy, and exact immutable manifest/object URLs. A failed
or absent live route leaves the station on its checksum-tracked bundled catalog.
