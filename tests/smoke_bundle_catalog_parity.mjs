#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'avian/frontend/assets/bundle-catalog');
const read = (relative) => fs.readFileSync(path.join(vendor, relative));
const text = (relative) => read(relative).toString('utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(text('vendor-manifest.json'));

assert.equal(manifest.format, 'avian-station-vendored-bundle-catalog');
assert.equal(manifest.format_version, 1);
assert.ok(Object.keys(manifest.source_sha256).length >= 39,
  'the complete public renderer, preview set, fonts, and licenses are tracked');
assert.ok(Object.keys(manifest.output_sha256).length >= 41,
  'the opaque-frame snapshots are tracked in addition to all public assets');
for (const [relative, digest] of Object.entries(manifest.output_sha256)) {
  assert.equal(sha(read(relative)), digest, `vendored SHA drift: ${relative}`);
}
for (const required of [
  'fonts/JetBrainsMono-Regular.ttf', 'fonts/Caveat.ttf', 'fonts/OFL.txt', 'fonts/OFL-Caveat.txt',
  'catalog/bundles-v1.json', 'catalog/bundle-preview-geometry-v1.json'
]) {
  assert.ok(manifest.output_sha256[required], `${required} is missing from the vendor manifest`);
}

const catalog = JSON.parse(text('catalog/bundles-v1.json'));
const geometry = JSON.parse(text('catalog/bundle-preview-geometry-v1.json'));
assert.equal(catalog.format, 'avian-visitors-bundle-catalog');
assert.equal(catalog.format_version, 1);
assert.equal(catalog.packs.length, 11, 'the current public catalog has eleven regional packs');
const styles = new Map();
for (const pack of catalog.packs) {
  if (!styles.has(pack.style.id)) styles.set(pack.style.id, []);
  styles.get(pack.style.id).push(pack);
}
assert.deepEqual([...styles.keys()], ['japanese-woodblock', 'evolutionary-impressionist']);
assert.equal(styles.get('japanese-woodblock').length, 10);
assert.equal(styles.get('evolutionary-impressionist').length, 1);

const official = catalog.packs.filter((pack) => pack.review === 'official');
assert.equal(official.length, 2);
assert.deepEqual(Object.fromEntries(official.map((pack) => [pack.id, pack.availability])), {
  'official-western-us-woodblock': 'installable',
  'official-western-us-impressionist': 'installable',
}, 'both immutable official bundles remain available from the public catalog');
for (const pack of official) {
  assert.ok(pack.manifest && /^[0-9a-f]{64}$/.test(pack.manifest.sha256));
  assert.equal(pack.previews.length, 6, `${pack.id} must retain the six-bird collage`);
  for (const preview of pack.previews) {
    assert.match(preview.url, /^\/assets\/bundle-catalog\/bundle-previews\/[a-z0-9._-]+[.]png$/);
    assert.ok(fs.existsSync(path.join(vendor, preview.url.replace('/assets/bundle-catalog/', ''))));
    assert.ok(preview.common_name && preview.scientific_name);
  }
}
const vendoredPreviews = Object.keys(manifest.output_sha256)
  .filter((relative) => relative.startsWith('bundle-previews/') && relative.endsWith('.png'));
assert.equal(vendoredPreviews.length, 26,
  'all fourteen catalog thumbnails and twelve nested collage renders are vendored');
let collageBytes = 0;
for (const [sourceUrl, item] of Object.entries(geometry.items || {})) {
  for (const url of [sourceUrl, item.render_url]) {
    assert.match(url, /^\/assets\/bundle-catalog\/bundle-previews\/(?:collage\/)?[a-z0-9._-]+[.]png$/);
    const relative = url.replace('/assets/bundle-catalog/', '');
    assert.ok(manifest.output_sha256[relative], `geometry image is absent from SHA manifest: ${relative}`);
    assert.ok(fs.existsSync(path.join(vendor, relative)), `geometry image is absent on disk: ${relative}`);
  }
  const renderRelative = item.render_url.replace('/assets/bundle-catalog/', '');
  const render = read(renderRelative);
  collageBytes += render.length;
  assert.equal(sha(render), item.sha256, `geometry digest drift: ${renderRelative}`);
  assert.equal(render.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(render.readUInt32BE(16), item.dims[0], `geometry width drift: ${renderRelative}`);
  assert.equal(render.readUInt32BE(20), item.dims[1], `geometry height drift: ${renderRelative}`);
  assert.equal(render[24], 8, `collage bit depth drift: ${renderRelative}`);
  assert.equal(render[25], 6, `collage alpha drift: ${renderRelative}`);
}
assert.ok(collageBytes < 3_500_000,
  `twelve lossless collage renders stay beneath the 3.5 MB budget (${collageBytes})`);
const discoveryOnly = catalog.packs.filter((pack) => pack.review !== 'official');
assert.ok(discoveryOnly.length > 0);
for (const pack of discoveryOnly) {
  assert.notEqual(pack.availability, 'installable');
  assert.equal(pack.manifest, undefined,
    `${pack.id} is discovery attribution and must not become a station install authority`);
}

const frameHtml = text('index.html');
const renderer = text('bundles.js');
const themeRenderer = text('bundle-theme.js');
const rendererCss = text('bundles.css');
const collageRenderer = text('bundle-collage.js');
const reservedBlock = renderer.match(/const LEGACY_REPOSITORY_PACK_IDS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(reservedBlock, 'the station renderer carries the protected legacy contributor namespace');
const rendererReservedIds = Array.from(reservedBlock[1].matchAll(/"([a-z0-9._-]+)"/g), (match) => match[1]).sort();
const repositoryIds = catalog.packs
  .filter((pack) => pack.review === 'community' && pack.availability === 'repository')
  .map((pack) => pack.id)
  .sort();
assert.deepEqual(rendererReservedIds, repositoryIds,
  'the browser reservation set stays exact-coupled to the nine credited migration rows');
assert.match(renderer, /PUBLIC_COMMUNITY_CATALOG_URL[\s\S]{0,160}api\/bundles\/catalog\/discovery-v1[.]json/,
  'the station browser uses the confirmed D1 discovery feed separately from its static catalog');
assert.match(renderer, /bundle[.]official && bundle[.]id[.]startsWith\("official-"\)[\s\S]{0,180}bundle[.]availability === "repository"/,
  'the static catalog supplies only official rows and credited repository placeholders');
assert.match(renderer, /LEGACY_REPOSITORY_PACK_IDS[.]has\(bundle[.]id\)[\s\S]{0,100}bundle[.]availability !== "installable"/,
  'confirmed discovery cannot claim official or reserved identities or inject noninstallable rows');
assert.match(renderer, /discoveredBundles\[position\] = bundle/,
  'a confirmed revision can replace only its matching repository placeholder in place');
assert.match(frameHtml, /<span class="catalog-open-full catalog-open-full-placeholder" aria-hidden="true">/);
assert.doesNotMatch(frameHtml, /<a class="catalog-open-full"/);
assert.doesNotMatch(frameHtml, /id="catalog-open-full"/);
assert.doesNotMatch(frameHtml, /downloaded-filter|catalog-downloaded/,
  'the station catalog has no separate Downloaded filter');
assert.doesNotMatch(renderer, /bundle-catalog-open/);
assert.match(rendererCss, /html[.]embed [.]catalog-open-full-placeholder \{ visibility: hidden; pointer-events: none; \}/);
assert.match(rendererCss, /[.]style-toggle \{[\s\S]{0,100}min-height: 94px;[\s\S]{0,180}grid-template-columns: 78px minmax\(0, 1fr\) auto 18px;/,
  'the approved desktop bundle-row height and cover size are preserved');
assert.match(rendererCss, /@media \(max-width: 720px\)[\s\S]*[.]style-toggle \{ min-height: 82px; grid-template-columns: 64px/,
  'the approved compact bundle-row height is preserved');
assert.match(rendererCss, /@media \(max-width: 430px\)[\s\S]*[.]style-toggle \{ grid-template-columns: 58px/,
  'the narrowest bundle-row cover size is preserved');
assert.match(renderer, /exactMessage\(event[.]data, \["v", "type", "handoff", "ids", "activeId", "installableIds", "installedPacks"\]\)/,
  'the opaque frame accepts only the exact parent library and installed-presentation schema');
assert.match(renderer, /event[.]data[.]ids[.]length > 100/,
  'the parent library is capped before the opaque frame consumes it');
assert.match(renderer, /event[.]data[.]installableIds[.]length > 100/,
  'the station-authorized installable-id set is independently capped');
assert.match(renderer, /event[.]data[.]ids[.]every\(\(id\) => typeof id === "string"/,
  'every parent-provided bundle ID is validated before use');
assert.match(renderer, /event[.]data[.]installableIds[.]every\(\(id\) =>[\s\S]{0,100}typeof id === "string"/,
  'every station-authorized installable ID is validated before use');
assert.match(renderer, /event[.]data[.]activeId && !event[.]data[.]ids[.]includes\(event[.]data[.]activeId\)/,
  'the active id must belong to the trusted installed-id snapshot');
assert.match(renderer, /installedPackIds[.]clear\(\)/,
  'new station snapshots replace downloaded state instead of accumulating stale ids');
assert.match(renderer, /const installed = installedById[.]get\(pack[.]id\)/);
assert.match(renderer, /name: installed[.]name[\s\S]{0,700}version: installed[.]version/,
  'the verified local activation version and facts win same-ID presentation');
assert.match(renderer, /matchingPreviewVersion = installed && installed[.]version === pack[.]version/);
assert.match(renderer, /previewUrl: matchingPreviewVersion [?] pack[.]previewUrl : ""[\s\S]{0,300}previews: matchingPreviewVersion [?] pack[.]previews : \[\]/,
  'discovery art is retained only when it is bound to the exact installed activation version');
assert.match(renderer, /installablePackIds[.]clear\(\)/,
  'new station snapshots replace install authority instead of accumulating stale ids');
assert.match(renderer, /const downloadedStyles = \[\];[\s\S]{0,100}const remainingStyles = \[\];/);
assert.match(renderer, /visible[.]some\(\(pack\) => installedPackIds[.]has\(pack[.]id\)\)[\s\S]{0,180}downloadedStyles[.]concat\(remainingStyles\)[.]forEach/,
  'trusted downloaded styles are a stable partition above the remaining catalog');
assert.doesNotMatch(renderer, /downloadedOnly|syncDownloadedFilter|downloaded-filter/);
assert.match(renderer, /visiblePacks[.]some\(\(pack\) => installedPackIds[.]has\(pack[.]id\)\)/);
assert.match(renderer, /className = "bundle-badge bundle-badge-downloaded"[\s\S]{0,140}title = "Downloaded"/,
  'collapsed and expanded style rows retain a titled downloaded indicator');
assert.match(renderer, /downloadedIcon[.]setAttribute\("fill", "none"\)[\s\S]{0,900}downloadedCopy[.]className = "visually-hidden"[\s\S]{0,100}downloadedCopy[.]textContent = "Downloaded"/,
  'the downloaded state uses an outline icon with an accessible text equivalent');
assert.match(renderer, /PUBLIC_CATALOG_URL = "https:\/\/avianvisitors[.]com\/catalog\/bundles-v1[.]json"/,
  'the opaque frame gets official and migration-placeholder presentation from the canonical static catalog');
assert.match(renderer, /fetchCatalog\(\s*embedded [?] PUBLIC_CATALOG_URL : CATALOG_URL\s*\)/);
assert.match(renderer, /credentials: "omit"[\s\S]{0,80}mode: "cors"[\s\S]{0,80}referrerPolicy: "no-referrer"/,
  'the cross-origin discovery fetch carries no station credentials or referrer');
assert.match(renderer, /embedded && window[.]AVIAN_BUNDLE_CATALOG_SNAPSHOT[\s\S]{0,140}parseCatalog\(window[.]AVIAN_BUNDLE_CATALOG_SNAPSHOT\)/,
  'the vendored catalog remains a fail-closed offline fallback');
assert.match(renderer, /activeTarget = visiblePacks[.]find\(\(pack\) => pack[.]id === activePackId\)/,
  'an active regional pack takes precedence as the style action target');
assert.match(renderer, /embedded [?] installablePackIds[.]has\(pack[.]id\) : pack[.]installable/,
  'station install actions require the parent trusted snapshot, never public discovery metadata alone');
assert.match(renderer, /use[.]textContent = "Currently in use"[\s\S]{0,120}use[.]disabled = true/,
  'the active bundle action is visibly non-actionable');
assert.match(renderer, /unavailable[.]textContent = "Unavailable"[\s\S]{0,100}unavailable[.]disabled = true/,
  'untrusted or unavailable station packs render an explicit disabled action');
assert.match(themeRenderer, /exactMessage\(event[.]data, \["v", "type", "handoff", "theme"\]\)/,
  'the opaque frame accepts only the exact parent theme schema');
assert.match(renderer, /function searchPlan\(/);
assert.match(renderer, /function filteredBundles\(/);
assert.match(renderer, /if \(region !== "all" && bundle[.]regionGroup !== region\) return false/);
assert.match(renderer, /return plan[.]tokens[.]every\(\(token\) => haystack[.]includes\(token\)\)/);
assert.match(renderer, /function styleGroups\(/);
assert.match(renderer, /function regionStrip\(/);
assert.match(renderer, /regionStrip\(visiblePacks\)/,
  'the region rail must reflect the region-filtered packs, not every catalog region');
assert.match(renderer, /[.]previews[.]slice\(0, 6\)/);
assert.match(renderer, /className = "style-collage"/);
assert.match(renderer, /group[.]packs[.]find\(\(pack\) => pack[.]previews[.]length\)[\s\S]{0,120}group[.]packs[.]find\(\(pack\) => pack[.]previewUrl\)/,
  'a one-image bundle still selects a visual instead of collapsing the left column');
assert.match(renderer, /gallery[.]classList[.]add\("style-collage-single"\)[\s\S]{0,220}image[.]src = previewPack[.]previewUrl/,
  'a preview-only bundle renders its single image inside the standard collage surface');
assert.match(rendererCss, /[.]style-collage-single\s*\{[\s\S]{0,180}display:\s*grid;[\s\S]{0,100}place-items:\s*center;/,
  'the single-image fallback retains the expanded visual geometry');
assert.match(collageRenderer, /image[.]loading = 'eager'/,
  'disclosed collage renders start immediately');
assert.match(collageRenderer, /image[.]decoding = 'async'/,
  'collage decoding stays off the synchronous render path');
assert.match(collageRenderer, /image[.]width = tile[.]intrinsicWidth/);
assert.match(collageRenderer, /image[.]height = tile[.]intrinsicHeight/);
assert.match(collageRenderer, /[?]v=' [+] tile[.]renderRevision/,
  'immutable collage URLs carry their generated content revision');
assert.match(renderer, /className = "bundle-badge"[\s\S]{0,120}textContent = "Official"/);
assert.match(renderer, /The original hand-reviewed Avian Visitors illustration set[.]/);
assert.match(renderer, /Gemini 2[.]5 Flash Image worked from species photographed and selected print references[.]/);
assert.match(renderer, /Built on Matt DesLauriers’s work, Synthetic Gestures: An Evolutionary Sketching Machine;[\s\S]{0,120}while CLIP compared each bird/,
  'the Evolutionary Impressionist method carries the full credit and concise CLIP wording');
assert.doesNotMatch(renderer, /OpenAI CLIP/,
  'the public-facing method names CLIP without the vendor prefix');
assert.match(renderer, /const selector = typeof pack[?][.]id === "string"[\s\S]{0,180}[?] pack[.]id : ""/,
  'portable commands are coupled to the validated catalog bundle ID');
const manifestTrustBlock = renderer.match(/function safeManifestUrl\([\s\S]*?\n  function catalogBundle\(/)?.[0] || '';
assert.match(manifestTrustBlock, /url[.]hostname === "avianvisitors[.]com"/,
  'install commands trust manifests from the canonical catalog host only');
assert.doesNotMatch(manifestTrustBlock, /www[.]avianvisitors[.]com|assets[.]avianvisitors[.]com/,
  'alias hosts cannot become station install authority');
assert.match(renderer, /const command = `sudo avian-bundle use '\$\{selector\}'`/,
  'the copied command is the same after SSHing into a station or BirdFrame');
assert.match(renderer, /trigger[.]addEventListener\("click", async \(\) => \{[\s\S]{0,260}await copy\(\)/,
  'opening the command dialog copies the universal command immediately');
assert.match(renderer, /icon[.]textContent = ">_"/,
  'the command control uses a terminal glyph instead of a generic copy icon');
assert.doesNotMatch(renderer, /Copy an SSH command|ssh birdnet[.]local|ssh birdframe[.]local/);
assert.doesNotMatch(renderer, /curl[^\n]{0,200}[|]\s*(?:sh|bash)|wget[^\n]{0,200}[|]\s*(?:sh|bash)/,
  'the command menu never emits a remote script pipeline');
assert.match(rendererCss, /[.]catalog-postal-progress\s*\{[\s\S]{0,200}font:\s*500 7[.]25px\/1 var\(--bundle-mono\);[\s\S]{0,100}opacity:\s*[.]52;/,
  'ZIP progress stays small, monospaced, and visually quiet');
assert.match(renderer, /searchProgress[.]textContent = "ZIP " [+] entered [+] "\/5"/);
assert.match(renderer, /shareOpen[.]dataset[.]open = String\(authenticated && sharing\)/);
assert.match(renderer, /shareOpen[.]setAttribute\("aria-label", sharing [?] "Close bundle panel" : "Add a bundle"\)/);
assert.match(rendererCss, /[.]share-open\[data-open="true"\] [.]share-plus \{ transform: rotate\(45deg\); \}/,
  'the authenticated plus communicates the open panel as an X');
assert.match(frameHtml, /Use the Export bundle tool[.]/,
  'the ZIP help points people to the station export tool');
assert.doesNotMatch(frameHtml, /No scripts, no models, or executables/);
assert.match(renderer, /const copy = document[.]createElement\(manageAction [?] "button" : "span"\)/,
  'actionable managed bundles use a native primary button');
assert.match(renderer, /copy[.]className = manageAction [?] "share-manage-copy share-manage-primary"/);
assert.match(renderer, /row[.]append\(copy\)[\s\S]{0,80}actions[.]children[.]length/,
  'the primary manage control and secondary actions remain sibling controls');
assert.match(frameHtml, /id="share-manage-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/,
  'cache-lag feedback is visible and announced inside Manage');
assert.match(renderer, /const correction = preserveReplacement && !!shareReplacementFor[\s\S]{0,220}if \(!preserveReplacement\) shareReplacementFor = ""/,
  'file-selection reset preserves the correction route only when explicitly requested');
assert.match(renderer, /resetShareFlow\(true\)/,
  'removing the last selected correction file remains inside its replacement workflow');
assert.match(renderer, /submission[?][.]publication_status === "published"/,
  'only an active publication gets a public-details action');
assert.match(renderer, /Refreshing public bundle details[.][\s\S]{0,220}await refreshCommunity\(\)/,
  'a missing published card refreshes discovery before reporting cache lag');
assert.match(renderer, /Public details are still syncing[.] Try again shortly[.]/);
assert.match(renderer, /retry[.]textContent = "Retry"[\s\S]{0,220}openPublishedDetails\(retrySubmission\)/,
  'a still-missing publication exposes a visible retry');
assert.match(rendererCss, /[.]share-manage-status \{[\s\S]{0,360}font: 9px\/1[.]45 var\(--bundle-mono\)/,
  'Manage cache feedback remains compact and consistent with the catalog UI');
assert.match(rendererCss, /html[.]embed [.]bundle-catalog[\s\S]*overflow-y: auto/);
assert.match(rendererCss, /html[.]embed [.]share-open[\s\S]*display: none/);
assert.match(rendererCss, /html[.]embed [.]catalog-tools \{ grid-template-columns: minmax\(180px, 1fr\) auto 40px; \}/,
  'the desktop station toolbar reserves responsive room for the region picker and outbound arrow');
assert.match(frameHtml, /id="bundle-catalog"[\s\S]{0,180}id="catalog-state"/,
  'the offline status is rendered beneath the bundle list');
assert.match(rendererCss, /[.]catalog-state \{[\s\S]{0,180}text-align: center;/,
  'the offline status is centered');
assert.match(rendererCss, /[.]bundle-badge-downloaded \{[\s\S]{0,220}border-color: var\(--bundle-line\);[\s\S]{0,120}color: var\(--bundle-muted\);/,
  'the downloaded outline uses the same quiet palette as the Official badge');
assert.match(rendererCss, /[.]bundle-use:disabled,[\s\S]*background: var\(--bundle-surface-2\)/,
  'the current action uses a quiet gray disabled treatment');
assert.match(rendererCss, /@media \(max-width: 720px\)[\s\S]*html[.]embed [.]catalog-search \{ grid-column: 1 \/ -1; \}/,
  'the embed toolbar reflows its search independently on narrow screens');
assert.match(rendererCss, /[.]style-regions::-webkit-scrollbar[\s\S]*display: none/);
assert.match(frameHtml, /catalog-snapshot[.]js[\s\S]*geometry-snapshot[.]js[\s\S]*bundle-collage[.]js/);
assert.doesNotMatch(frameHtml, /(?:href|src)="\/(?:bundles|bundle-collage|bundle-theme|site)[.](?:css|js)(?:[?][^"]*)?"/,
  'all catalog styles and scripts stay relative to the vendored static subtree');
assert.doesNotMatch(frameHtml + text('site.css') + text('bundle-collage.css') + rendererCss,
  /(?:href=|src:\s*url\()["']?\/fonts\//,
  'opaque-frame fonts stay under the scoped CORS-enabled static subtree');

const authGate = renderer.indexOf('if (!embedded) {');
const authInit = renderer.indexOf('refreshShareLauncher().then');
const communityLoad = renderer.indexOf('async function loadCommunity()');
assert.ok(authGate >= 0 && authGate < authInit && authInit < communityLoad,
  'contribution/auth initialization remains outside embedded mode');
assert.match(renderer.slice(authInit, communityLoad), /\n  \}\n\s*$/);
const liveCatalogFetch = renderer.indexOf('embedded ? PUBLIC_CATALOG_URL : CATALOG_URL');
const confirmedCatalogFetch = renderer.indexOf(
  'embedded ? PUBLIC_COMMUNITY_CATALOG_URL : COMMUNITY_CATALOG_URL'
);
const snapshotFallback = renderer.indexOf('embedded && window.AVIAN_BUNDLE_CATALOG_SNAPSHOT');
assert.ok(liveCatalogFetch >= 0 && snapshotFallback > liveCatalogFetch,
  'the opaque frame discovers the live public catalog before its checked-in offline fallback');
assert.ok(confirmedCatalogFetch > snapshotFallback,
  'the confirmed community projection is merged only after the trusted static baseline is selected');

const sourceCandidates = [
  process.env.BUNDLE_SITE_PUBLIC,
  path.join(root, 'assembled/site/public'),
  path.resolve(root, '../AvianVisitors/assembled/site/public')
].filter(Boolean);
const publicSource = sourceCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'bundles.html')));
if (publicSource) {
  const checked = spawnSync(process.execPath, [
    path.join(root, 'scripts/vendor_bundle_catalog.mjs'), '--check', publicSource
  ], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const publicCatalog = JSON.parse(fs.readFileSync(path.join(publicSource, 'catalog/bundles-v1.json'), 'utf8'));
  const normalizedVendor = JSON.parse(JSON.stringify(catalog).replaceAll(
    '/assets/bundle-catalog/bundle-previews/', '/bundle-previews/'
  ));
  assert.deepEqual(normalizedVendor, publicCatalog,
    'station style groups, copy, regions, badges, filters, and collage data must come from the current public catalog');
  for (const [relative, digest] of Object.entries(manifest.source_sha256)) {
    assert.equal(sha(fs.readFileSync(path.join(publicSource, relative))), digest,
      `public source moved without a regenerated station vendor: ${relative}`);
  }
}

console.log('Vendored public bundle catalog parity smoke passed.');
