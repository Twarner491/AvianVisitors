#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../avian/frontend/index.html', import.meta.url), 'utf8');
assert.match(index, /[.]\/apt[.]js[?]v=r240["']/,
  'the shell requests the content-revision-aware frontend under a fresh cache key');
const start = apt.indexOf('function bundleRecord(');
const end = apt.indexOf('function tuning(', start);
assert.ok(start >= 0 && end > start, 'active bundle art runtime is present');
let runtime = apt.slice(start, end);
const withoutInitialLoad = runtime.replace(/\n  loadTablesAtStartup\(\);\n/, '\n');
assert.notEqual(withoutInitialLoad, runtime, 'test harness suppresses only the eager page load');
runtime = withoutInitialLoad;

assert.doesNotMatch(apt, /if \(!tablesReady\) \{ setTimeout\(function \(\) \{ renderCollage/,
  'missing startup tables do not leave a 12.5 Hz render retry loop');

assert.equal((apt.match(/[.]\/avian\/api\/cutout[.]php[?]sci=/g) || []).length, 1,
  'every collage, Atlas, and postcard cutout URL goes through one revision-bound builder');
assert.match(apt, /var sketchSrc = defaultCutoutSrc\(s[.]sci, 1, SKETCH_VERSION, s[.]com\)/,
  'Atlas cards use the shared revision-bound cutout URL');
assert.match(apt, /function sketchSrc\(sci, pose\)[\s\S]{0,360}return defaultCutoutSrc\(sci, [+]pose \|\| 1, SKETCH_VERSION, com\)/,
  'postcards and their pose probes use the shared revision-bound cutout URL');
assert.match(apt, /refreshArtwork: function \(active\) \{ return refreshBundleArtwork\(active\); \}/,
  'a completed Settings selection supplies the settled active identity to the art refresh');
assert.match(apt, /var BUNDLE_SCIENTIFIC_SLUG_MAX = 163;/,
  'the active-table validator shares the accepted scientific-slug maximum');
assert.match(apt, /tablesReady && !DIMS\[slugify\(s[.]sci\)\]/,
  'Atlas artwork availability resolves through the active bundle table by canonical slug');

const revisionA = 'a'.repeat(64);
const revisionB = 'b'.repeat(64);
const localRevisionA = 'c'.repeat(64);
const localRevisionB = 'd'.repeat(64);
const included = {
  id: 'official-western-us-woodblock',
  version: '1.0.0',
  revision: 'included-woodblock-v1',
  included: true,
  name: 'Japanese Woodblock'
};
const externalA = {
  id: 'community-a', version: '1.2.3', revision: revisionA,
  included: false, name: 'Community A'
};
const externalB = {
  id: 'community-b', version: '2.0.0', revision: revisionB,
  included: false, name: 'Community B'
};
const dims = { 'corvus-corax': [10, 10] };
const masks = { 'corvus-corax': { w: 1, h: 1, bits: 'gA==' } };
const maxScientificName = [
  `A${'a'.repeat(39)}`, 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)
].join(' ');
const maxScientificSlug = maxScientificName.toLowerCase().replaceAll(' ', '-');
assert.equal(maxScientificName.length, 163);
assert.equal(maxScientificSlug.length, 163);

function payload(active, contentRevision) {
  return {
    ok: true,
    active: {
      ...active,
      content_revision: contentRevision || (active.included ? localRevisionA : active.revision),
      species_count: 1,
      pose_count: 1
    },
    dims: structuredClone(dims),
    masks: structuredClone(masks)
  };
}

function response(status, value, headers = {}) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = new TextEncoder().encode(raw);
  const lowered = Object.fromEntries(Object.entries(headers).map(([key, item]) => [key.toLowerCase(), String(item)]));
  if (!('content-type' in lowered)) lowered['content-type'] = 'application/json; charset=utf-8';
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return lowered[String(name).toLowerCase()] ?? null; } },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

const queued = [];
const fetchCalls = [];
const timers = new Map();
let nextTimer = 1;
const visibilityListeners = [];
function fakeFetch(url, options = {}) {
  fetchCalls.push({ url: String(url), options });
  assert.ok(queued.length, `unexpected fetch ${url}`);
  const next = queued.shift();
  return typeof next === 'function' ? next(url, options) : Promise.resolve(next);
}

let collageRenders = 0;
let atlasRenders = 0;
const context = vm.createContext({
  Promise,
  JSON,
  Object,
  Array,
  Number,
  Date,
  RegExp,
  Error,
  TextDecoder,
  atob,
  encodeURIComponent,
  fetch: fakeFetch,
  setTimeout(callback, delay) {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) { timers.delete(id); },
  document: {
    hidden: false,
    addEventListener(type, callback) {
      if (type === 'visibilitychange') visibilityListeners.push(callback);
    }
  },
  console: { error() {} },
  TABLE_VERSION: 'r13',
  BUNDLE_ASSETS_MAX_BYTES: 32 * 1024 * 1024,
  BUNDLE_ASSETS_MAX_POSES: 10000,
  BUNDLE_SCIENTIFIC_SLUG_MAX: 163,
  INCLUDED_BUNDLE_ID: included.id,
  INCLUDED_BUNDLE_VERSION: included.version,
  INCLUDED_BUNDLE_REVISION: included.revision,
  LEGACY_INCLUDED_CONTENT_REVISION: '0'.repeat(64),
  ACTIVE_BUNDLE: { ...included, contentRevision: '0'.repeat(64) },
  ART_REVISIONS: {},
  SKETCH_VERSION: 'r12',
  IMG_VERSION: 'r12',
  DIMS: {},
  MASKS: {},
  tablesReady: false,
  tableRequest: 0,
  tableLoadPromise: null,
  artworkRefreshRequest: 0,
  maskCache: { stale: true },
  justGenerated: {},
  POSTCARD_POSE_CACHE: { 'Corvus corax': [{ pose: 1, ok: true }] },
  DATA: { lifelist: { species: [{ sci: 'Corvus corax', com: 'Common Raven' }] } },
  activePostcardSci: '',
  activePostcardEducatorScope: '',
  postcardModal: null,
  renderCollageFromData() { collageRenders += 1; },
  renderAtlas() { atlasRenders += 1; },
  populatePostcard() {},
  artRevision(_sci, fallback) { return fallback; },
  slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
});
context.window = context;
vm.runInContext(runtime, context, { filename: 'apt-bundle-art-runtime.js' });

queued.push(response(503, { ok: false }));
assert.equal(await context.loadTablesAtStartup(), false);
assert.equal(timers.size, 1, 'a transient startup failure queues one retry');
let retry = [...timers.entries()][0];
timers.delete(retry[0]);
assert.equal(retry[1].delay, 250, 'startup recovery begins with a short backoff');
queued.push(response(200, payload(externalA)));
await retry[1].callback();
assert.equal(context.tablesReady, true, 'startup tables recover after the writer releases its lock');
assert.equal(timers.size, 0, 'successful recovery stops the retry loop');

context.tablesReady = false;
context.tableLoadPromise = null;
context.tableRequest = 0;
context.ACTIVE_BUNDLE = { ...included, contentRevision: '0'.repeat(64) };
context.DIMS = {};
context.MASKS = {};
context.tableStartupRetryStep = 0;
context.maskCache = { stale: true };
context.POSTCARD_POSE_CACHE = { 'Corvus corax': [{ pose: 1, ok: true }] };
fetchCalls.length = 0;
collageRenders = 0;
atlasRenders = 0;

queued.push(response(200, payload(externalA)));
assert.equal(await context.loadTables(false), true);
assert.match(fetchCalls[0].url, /^[.]\/avian\/api\/bundle-assets[.]php[?]v=r13$/);
assert.equal(fetchCalls[0].options.method, 'GET');
assert.equal(fetchCalls[0].options.credentials, 'same-origin');
assert.equal(fetchCalls[0].options.cache, 'default');
assert.equal(context.ACTIVE_BUNDLE.revision, revisionA);
assert.equal(context.ACTIVE_BUNDLE.contentRevision, revisionA);
assert.equal(collageRenders, 1);
assert.equal(atlasRenders, 1);
assert.equal(Object.keys(context.POSTCARD_POSE_CACHE).length, 0,
  'pose availability from the old revision is discarded');

const maxPayload = payload(externalA);
maxPayload.dims = { [maxScientificSlug]: [10, 10] };
maxPayload.masks = { [maxScientificSlug]: { w: 1, h: 1, bits: 'gA==' } };
assert.equal(context.validBundleTables(maxPayload.dims, maxPayload.masks, maxPayload.active), true,
  'validBundleTables accepts the exact 163-character canonical scientific slug');
const atlasBeforeMax = atlasRenders;
queued.push(response(200, maxPayload));
assert.equal(await context.loadTables(true, externalA), true,
  'the active bundle-assets response accepts the exact scientific-slug maximum');
assert.deepEqual(Array.from(context.DIMS[maxScientificSlug]), [10, 10],
  'the exact maximum slug remains addressable for the Atlas lookup');
assert.equal(atlasRenders, atlasBeforeMax + 1,
  'loading maximum-length active geometry refreshes the Atlas path');

const overlongPayload = payload(externalA);
const overlongSlug = `${maxScientificSlug}e`;
overlongPayload.dims = { [overlongSlug]: [10, 10] };
overlongPayload.masks = { [overlongSlug]: { w: 1, h: 1, bits: 'gA==' } };
assert.equal(context.validBundleTables(
  overlongPayload.dims, overlongPayload.masks, overlongPayload.active
), false, 'a 164-character base slug remains rejected');

const oldUrl = context.defaultCutoutSrc('Corvus corax', 2, 'r12', 'Common Raven');
const parsedOld = new URL(oldUrl, 'https://station.test/');
assert.equal(parsedOld.searchParams.get('bundle'), revisionA);
assert.equal(parsedOld.searchParams.get('v'), revisionA);
assert.equal(parsedOld.searchParams.has('content'), false,
  'immutable downloaded art does not carry a second mutable revision');
assert.equal(parsedOld.searchParams.get('pose'), '2');
assert.equal(parsedOld.searchParams.get('com'), 'Common Raven');

const selectedA = { ...externalA, selection_revision: 'e'.repeat(64) };
queued.push(response(200, payload(selectedA, selectedA.selection_revision)));
assert.equal(await context.loadTables(true, selectedA), true,
  'a local selection keeps manifest and selection identities separate');
const selectedUrl = new URL(context.defaultCutoutSrc('Corvus corax', 1, 'r12', ''), 'https://station.test/');
assert.equal(selectedUrl.searchParams.get('bundle'), revisionA);
assert.equal(selectedUrl.searchParams.get('content'), selectedA.selection_revision);
assert.equal(selectedUrl.searchParams.get('v'), selectedA.selection_revision);
const selectedB = { ...selectedA, selection_revision: 'f'.repeat(64) };
queued.push(response(200, payload(selectedB, selectedB.selection_revision)));
assert.equal(await context.loadTables(true, selectedA), false,
  'same manifest from another location cannot satisfy the expected selection');
assert.equal(context.ACTIVE_BUNDLE.contentRevision, selectedA.selection_revision);
queued.push(response(200, payload(externalA)));
assert.equal(await context.loadTables(true, externalA), true);

queued.push(response(200, payload(externalB)));
assert.equal(await context.loadTables(true, externalA), false);
assert.equal(context.ACTIVE_BUNDLE.revision, revisionA,
  'a response for a different active identity cannot replace current geometry');

let resolveSlow;
let resolveFast;
queued.push(() => new Promise((resolve) => { resolveSlow = resolve; }));
queued.push(() => new Promise((resolve) => { resolveFast = resolve; }));
const slow = context.loadTables(true, externalA);
const fast = context.loadTables(true, externalB);
resolveFast(response(200, payload(externalB)));
assert.equal(await fast, true);
resolveSlow(response(200, payload(externalA)));
assert.equal(await slow, false, 'an older in-flight table response cannot overwrite a newer switch');
assert.equal(context.ACTIVE_BUNDLE.revision, revisionB);
const switchedUrl = context.defaultCutoutSrc('Corvus corax', 2, 'r12', 'Common Raven');
const parsedSwitched = new URL(switchedUrl, 'https://station.test/');
assert.equal(parsedSwitched.searchParams.get('bundle'), revisionB);
assert.equal(parsedSwitched.searchParams.get('v'), revisionB);
assert.notEqual(switchedUrl, oldUrl, 'switching revisions cannot reuse a stale bird image URL');

let resolveSameSlow;
let resolveSameFast;
queued.push(() => new Promise((resolve) => { resolveSameSlow = resolve; }));
queued.push(() => new Promise((resolve) => { resolveSameFast = resolve; }));
const sameSlow = context.loadTables(true, externalA);
const sameFast = context.loadTables(true, externalA);
resolveSameFast(response(200, payload(externalA)));
assert.equal(await sameFast, true);
resolveSameSlow(response(200, payload(externalA)));
assert.equal(await sameSlow, true,
  'a superseded exact refresh adopts the newer success instead of surfacing a false failure');
assert.equal(context.ACTIVE_BUNDLE.revision, revisionA);

const newUrl = context.collageImageSrc('Corvus corax', 1, 'Common Raven');
const parsedNew = new URL(newUrl, 'https://station.test/');
assert.equal(parsedNew.searchParams.get('bundle'), revisionA);
assert.equal(parsedNew.searchParams.get('v'), revisionA);

queued.push(response(404, { ok: false }));
assert.equal(await context.loadTables(true, externalB), false);
assert.equal(queued.length, 0, 'downloaded bundles never fall back to included geometry');

queued.push(response(404, { ok: false }));
queued.push(response(200, dims));
queued.push(response(200, masks));
assert.equal(await context.loadTables(true, included), true,
  'only a missing endpoint may use the pre-bundle included tables');
assert.equal(fetchCalls.at(-3).url.startsWith('./avian/api/bundle-assets.php'), true);
assert.equal(fetchCalls.at(-2).url.startsWith('./dims.json'), true);
assert.equal(fetchCalls.at(-1).url.startsWith('./masks.json'), true);
context.justGenerated['Corvus corax'] = 12345;
const generatedUrl = new URL(context.defaultCutoutSrc('Corvus corax', 1, 'r12', 'Common Raven'), 'https://station.test/');
assert.equal(generatedUrl.searchParams.has('bundle'), false,
  'the staged legacy-table fallback keeps using the historical included resolver');
assert.equal(generatedUrl.searchParams.get('v'), `${included.revision}-${'0'.repeat(64)}-r12`);
assert.equal(generatedUrl.searchParams.has('content'), false);
assert.equal(generatedUrl.searchParams.get('t'), '12345',
  'included on-demand generation keeps its one-species freshness key');

delete context.justGenerated['Corvus corax'];
queued.push(response(200, payload(included, localRevisionA)));
assert.equal(await context.loadTables(true, included), true);
const localUrlA = context.defaultCutoutSrc('Corvus corax', 1, 'r12', 'Common Raven');
assert.match(localUrlA, new RegExp(localRevisionA));
assert.equal(new URL(localUrlA, 'https://station.test/').searchParams.get('content'), localRevisionA);
queued.push(response(200, payload(included, localRevisionB)));
assert.equal(await context.loadTables(true, included), true);
const localUrlB = context.defaultCutoutSrc('Corvus corax', 1, 'r12', 'Common Raven');
assert.equal(context.ACTIVE_BUNDLE.revision, included.revision,
  'mutable local artwork does not change the built-in bundle identity');
assert.notEqual(localUrlB, localUrlA,
  'a changed included content revision invalidates persistent bird-image cache keys');
assert.match(localUrlB, new RegExp(localRevisionB));
assert.equal(new URL(localUrlB, 'https://station.test/').searchParams.get('content'), localRevisionB);

assert.throws(() => context.validateBundleAssets({ ...payload(externalA), unexpected: true }, externalA),
  /response is invalid/, 'unexpected response fields fail closed');
const newlineVersion = payload(externalA);
newlineVersion.active.version = '1.2.3\n';
assert.throws(() => context.validateBundleAssets(newlineVersion, null), /response is invalid/,
  'identity fields use whole-string validation');
const mismatchedExternalContent = payload(externalA);
mismatchedExternalContent.active.content_revision = revisionB;
assert.throws(() => context.validateBundleAssets(mismatchedExternalContent, null), /response is invalid/,
  'immutable downloaded bundles cannot advertise a second mutable cache identity');
await assert.rejects(
  context.boundedResponseText(response(200, '{}', { 'Content-Length': context.BUNDLE_ASSETS_MAX_BYTES + 1 }), context.BUNDLE_ASSETS_MAX_BYTES),
  /too large/,
  'declared oversized responses are rejected before parsing'
);
let streamCancelled = false;
const streamChunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
await assert.rejects(context.boundedResponseText({
  headers: { get() { return null; } },
  body: { getReader() { return {
    read: async () => streamChunks.length ? { done: false, value: streamChunks.shift() } : { done: true },
    cancel: async () => { streamCancelled = true; }
  }; } }
}, 4), /too large/, 'an unannounced oversized stream is stopped before parsing');
assert.equal(streamCancelled, true);

console.log('Bundle artwork runtime smoke passed.');
