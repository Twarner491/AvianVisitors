#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
function source(from, until) {
  const start = apt.indexOf(from);
  const end = apt.indexOf(until, start);
  assert.ok(start >= 0 && end > start);
  return apt.slice(start, end);
}
const imageCode = [
  source('  function activeArtRevision(', '  function collageImageSrc('),
  source('  function sketchSrc(', '  // ---- On-demand generation'),
  source('  function decodePostcardImage(', '  // Deep links and non-stamp surfaces'),
  source("  document.getElementById('modalPoseToggle').addEventListener('click'", '  // Expose for debugging'),
].join('\n');
const sci = 'Corvus corax';
const manifest = 'a'.repeat(64);
const selection = 'b'.repeat(64);

function element() {
  const attributes = new Map();
  const classes = new Set();
  return {
    dataset: {}, complete: true, naturalWidth: 32, textContent: '',
    setAttribute(key, value) { attributes.set(key, value); },
    getAttribute(key) { return key === 'src' ? this.src || null : attributes.get(key) ?? null; },
    removeAttribute(key) { attributes.delete(key); },
    classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); } },
  };
}

function harness(poses, included = false) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const buttons = [1, 2].map(pose => Object.assign(element(), { dataset: { pose: String(pose) } }));
  const toggle = get('modalPoseToggle');
  toggle.querySelectorAll = () => buttons;
  toggle.querySelector = selector => buttons.find(button => selector.includes(`"${button.dataset.pose}"`));
  let onToggle;
  toggle.addEventListener = (_event, listener) => { onToggle = listener; };
  const requests = [];
  const decoded = [];
  const preferences = new Map();
  const pendingContent = new Promise(() => {});
  const context = vm.createContext({
    console, Promise, Object, Array, Number, JSON, encodeURIComponent,
    ACTIVE_BUNDLE: {
      id: included ? 'official-western-us-woodblock' : 'test-bundle',
      included, revision: included ? 'included-woodblock-v1' : manifest,
      contentRevision: selection, ...(included ? {} : { selection_revision: selection }),
    },
    LEGACY_INCLUDED_CONTENT_REVISION: '0'.repeat(64),
    DIMS: Object.fromEntries(poses.map(pose => ['corvus-corax' + (pose === 2 ? '-2' : ''), [32, 32]])),
    DATA: { lifelist: { species: [{ sci, com: 'Common Raven' }] } },
    POSTCARD_IMAGE_REQUEST: 0, POSTCARD_CONTENT_REQUEST: 0, POSTCARD_POSE_CACHE: {},
    SKETCH_VERSION: 'r12', tablesReady: true, justGenerated: {},
    activePostcardEducatorScope: '', educatorScopeGeneration: 0, adminAccessState: 'locked',
    SPECIES_CACHE: {}, WIKI_CACHE: {},
    document: { getElementById: get, querySelector() { return null; } },
    Image: class {
      set src(value) {
        decoded.push(value);
        const pose = +(new URL(value, 'http://station.test').searchParams.get('pose') || 1);
        queueMicrotask(() => poses.includes(pose) ? this.onload() : this.onerror());
      }
      decode() { return Promise.resolve(); }
    },
    fetch(url, options) {
      requests.push({ url, options });
      const pose = +(new URL(url, 'http://station.test').searchParams.get('pose') || 1);
      return Promise.resolve({ ok: poses.includes(pose) });
    },
    artRevision(_sci, fallback) { return fallback; },
    slugify(value) { return value.toLowerCase().replaceAll(' ', '-'); },
    educatorScopeId() { return ''; }, validEducatorScopeKey() { return true; },
    educatorSpeciesCacheAllowed() { return false; },
    scopedFetchJson() { return pendingContent; }, fetchJson() { return pendingContent; },
    resetPostcardPanels() {}, syncPill() {}, genBtnState() {},
    wikiUrl() { return ''; }, ebirdUrl() { return ''; },
    rememberedPostcardPose(name) { return preferences.get(name); },
    rememberPostcardPose(name, pose) { preferences.set(name, pose); },
    requestAnimationFrame(callback) { callback(); },
  });
  context.window = context;
  vm.runInContext(imageCode, context);
  return {
    context, requests, decoded, get, buttons, preferences,
    async choose(pose) {
      onToggle({ target: { closest() { return buttons[pose - 1]; } } });
      await new Promise(setImmediate);
    },
  };
}

for (const included of [false, true]) {
  const h = harness([1, 2], included);
  await h.context.populatePostcard(sci);
  assert.equal(h.get('modalArtwork').getAttribute('data-art-state'), 'ready');
  assert.equal(h.get('modalPoseToggle').getAttribute('data-unavailable'), null);
  assert.ok(h.requests.every(request => request.options.method === 'HEAD'));
  for (const pose of [1, 2, 1]) {
    await h.choose(pose);
    const url = new URL(h.get('modalImg').src, 'http://station.test');
    assert.equal(+(url.searchParams.get('pose') || 1), pose);
    assert.equal(url.searchParams.get('bundle'), included ? 'included-woodblock-v1' : manifest);
    assert.equal(url.searchParams.get('content'), selection);
    assert.equal(h.buttons[pose - 1].getAttribute('aria-current'), 'true');
    assert.equal(h.preferences.get(sci), pose);
  }
  await h.context.populatePostcard(sci);
  assert.equal(h.buttons[0].getAttribute('aria-current'), 'true', 'reopening restores the confirmed pose');
}

for (const pose of [1, 2]) {
  const h = harness([pose]);
  await h.context.populatePostcard(sci);
  assert.equal(h.get('modalArtwork').getAttribute('data-art-state'), 'ready', `single pose ${pose} remains visible`);
  assert.equal(h.buttons[pose - 1].getAttribute('aria-current'), 'true');
  assert.equal(h.get('modalPoseToggle').getAttribute('data-unavailable'), 'true');
  assert.equal(h.get('modalGenerate').hidden, true);
}

const missing = harness([]);
await missing.context.populatePostcard(sci);
assert.equal(missing.get('modalArtwork').getAttribute('data-art-state'), 'missing');
assert.equal(missing.get('modalImg').src, './nest-eggs.webp');
assert.equal(missing.requests.length, 0);
assert.equal(missing.get('modalGenerate').hidden, true);

const race = harness([1, 2]);
const oldRequests = [];
race.context.fetch = () => new Promise(resolve => oldRequests.push(resolve));
const oldProbe = race.context.postcardPoseAvailability(sci, race.buttons);
race.context.POSTCARD_POSE_CACHE = {};
race.context.fetch = url => Promise.resolve({ ok: !url.includes('pose=2') });
await race.context.postcardPoseAvailability(sci, race.buttons);
oldRequests.forEach(resolve => resolve({ ok: true }));
await oldProbe;
const current = await race.context.postcardPoseAvailability(sci, race.buttons);
assert.equal(current.find(result => result.pose === 2).ok, false,
  'a late probe from the previous bundle cannot overwrite current pose availability');

console.log('Postcard bundle pose, toggle, and selection-race smokes passed.');
