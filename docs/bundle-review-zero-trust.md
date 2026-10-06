# Bundle review Zero Trust provisioning

This package defines the Cloudflare Access boundary for the hosted review UI
and API only. It does not deploy the site, alter Worker routes, create DNS
records, enable bundle intake, or write Worker variables or secrets.

The pinned desired state is:

- one self-hosted Access application covering the exact and nested
  `/bundles/review` and `/api/bundles/review` routes;
- email one-time-PIN authentication restricted to exactly
  `twarner491@gmail.com`;
- a 24-hour Access session;
- no App Launcher entry, iframe loading, WARP authentication, or unauthenticated
  `OPTIONS` bypass; and
- one exclusive precedence-one Allow policy. Any additional policy or
  overlapping application stops reconciliation for manual review.

Cloudflare documents that a wildcard child path does not include its parent,
so the configuration deliberately lists all four public destinations. It uses
the current `destinations` API instead of deprecated `self_hosted_domains`.

## Provisioned boundary receipt

The Access boundary was created manually and verified without deploying the
Worker or enabling bundle intake. Its non-secret identifiers are pinned in
`ops/cloudflare/bundle-review-access-receipt.json`:

- account ID: `557e541291a977fc1683c53376eb56a0`;
- team domain: `twarner.cloudflareaccess.com`;
- application ID: `d44da5de-5e1c-4e38-9021-d4f5eccab1f9`;
- application AUD: `9f674c29c33e83ef8ca758ae10d611c944c09d3669734ed517df5b29e4d2ecc5`;
- policy ID: `3a50bb48-b7ae-4584-a084-81b7bfd678a2`; and
- reviewer: `twarner491@gmail.com`.

Signed-out requests to the exact and nested UI and API scopes all returned the
Cloudflare Access `302` challenge. The receipt contains no credential, token,
secret, or session cookie. Recording these future Worker configuration values
does not write them to Cloudflare or alter the deployed Worker.

## Offline plan

Run this first. It validates and prints the complete desired state without
reading credentials or making a network request:

```sh
python3 scripts/provision_bundle_review_access.py
```

## Apply gate

The Access boundary may be provisioned before the review routes are deployed;
until then it protects ordinary 404 responses and does not change the Worker.
Keep the Worker migration, secrets, and deployment in their separately
reviewed activation. Create a short-lived, account-scoped API token with these
Cloudflare permissions:

- `Access: Apps and Policies Write`
- `Access: Organizations, Identity Providers, and Groups Write`

Supply the token from a secret manager or protected environment. Do not place
it in this repository or paste it into a command argument. Applying requires
all three environment variables and the literal two-part command gate:

```sh
export CLOUDFLARE_ACCOUNT_ID='557e541291a977fc1683c53376eb56a0'
export CLOUDFLARE_TEAM_DOMAIN='twarner.cloudflareaccess.com'
read -s 'CLOUDFLARE_API_TOKEN?Cloudflare Access API token: '
export CLOUDFLARE_API_TOKEN
printf '\n'
python3 scripts/provision_bundle_review_access.py --apply --confirm APPLY
unset CLOUDFLARE_API_TOKEN
```

The apply path reuses an unambiguous existing OTP provider, creates one only
when none exists, and creates or updates the named application and policy. A
second run is a no-op apart from verification. New applications begin with no
Allow policy and therefore remain denied while the exact-email policy is being
created. Existing applications have their policy tightened before route scope
is changed. The supplied team hostname must also match the account's Access
organization before any mutation is attempted.

The script prints an environment checklist containing:

- `BUNDLE_REVIEWER_EMAIL=twarner491@gmail.com`
- `BUNDLE_REVIEW_ACCESS_TEAM_DOMAIN=twarner.cloudflareaccess.com`
- `BUNDLE_REVIEW_ACCESS_AUD=<verified application AUD>`

Those values must be configured separately on the hosted Worker. The script
does not do so. The API token is never printed, returned, or persisted.

## Verification before enabling intake

Keep the hosted sharing gate disabled until all four paths have been tested:

1. Signed-out requests to each exact route and a nested route must receive the
   Cloudflare Access challenge and must not reach the Worker.
2. An OTP sent to `twarner491@gmail.com` must admit each route.
3. A different email must be denied.
4. Direct-origin access, if an origin hostname exists, must be blocked.
5. The Worker must still reject a missing, invalid, wrong-audience, or
   wrong-email `CF-Access-Jwt-Assertion`; Access is an additional edge boundary,
   not a replacement for origin verification.

Authoritative API references:

- <https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/>
- <https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/methods/create/>
- <https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/methods/create/>
- <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/>
