#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../avian/frontend/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../avian/frontend/bundles.css', import.meta.url), 'utf8');
const source = fs.readFileSync(new URL('../avian/frontend/bundle-ui.js', import.meta.url), 'utf8');
const linkWebroot = fs.readFileSync(new URL('../scripts/link_webroot.sh', import.meta.url), 'utf8');

const themeAt = apt.indexOf('+ themeRow()');
const bundleAt = apt.indexOf('window.AVIAN_BUNDLES.rowMarkup()', themeAt);
const labelsAt = apt.indexOf('+ labelsRow()', themeAt);
assert.ok(themeAt >= 0 && themeAt < bundleAt && bundleAt < labelsAt,
  'Bird bundle must render directly beneath Theme in the current Settings page');
assert.match(html, /<link rel="stylesheet" href="[.]\/bundles[.]css[?]v=r\d+">/);
assert.match(html, /<script src="[.]\/bundle-ui[.]js[?]v=r\d+"><\/script>\s*<script src="[.]\/apt[.]js/);
for (const asset of ['bundles.css', 'bundle-ui.js']) {
  assert.match(linkWebroot, new RegExp('"\\$\\{frontend_dir\\}/' + asset.replace('.', '[.]') + '"'));
  assert.match(linkWebroot, new RegExp('"' + asset.replace('.', '[.]') + '"'));
}
assert.match(linkWebroot, /"\$\{frontend_dir\}\/assets"/,
  'the vendored catalog subtree must reach the production webroot');
assert.match(apt, /AVIAN_BUNDLES[.]mount\(\{[\s\S]*root: adminBody,[\s\S]*refreshBundleArtwork\(active\)/);
assert.match(apt, /AVIAN_BUNDLES[.]mount\(\{[\s\S]*latitude: v[.]LATITUDE,[\s\S]*longitude: v[.]LONGITUDE/,
  'the catalog filter receives the station coordinates already loaded by Settings');
assert.ok((apt.match(/AVIAN_BUNDLES[.]unmount\(\)/g) || []).length >= 3,
  'Settings rerender, section exit, and admin exit must all unmount the browser');

assert.match(source, /sandbox="allow-scripts"/);
assert.doesNotMatch(source, /allow-same-origin|allow-popups|allow-forms|allow-top-navigation/);
assert.doesNotMatch(source, /Bird bundles<|<h[1-6][^>]*>Bird bundle/i);
assert.doesNotMatch(source, /bundle-browser-close|aria-label="Close"/);
assert.match(source, /event[.]source !== frame[.]contentWindow/);
assert.match(source, /event[.]origin !== 'null'/);
assert.match(source, /event[.]data[.]handoff !== handoff/);
assert.match(source, /exactKeys\(data, \['v', 'type', 'handoff', 'id'\]\)/);
assert.match(source, /new Uint8Array\(16\)/);
assert.match(source, /body: JSON[.]stringify\(\{ action: 'use', id: id \}\)/);
assert.match(source, /postToFrame\('avianvisitors:bundle-library', \{[\s\S]{0,160}ids: ids,[\s\S]{0,160}activeId: activeId,[\s\S]{0,160}installableIds: installableIds\(\),[\s\S]{0,160}installedPacks: installedPacks/,
  'the opaque child receives installed presentation fields plus active and usable ids from the trusted station snapshot');
assert.match(source, /Array[.]isArray\(snapshot[.]library[.]installed\)/,
  'downloaded ids derive from the trusted library inventory, not catalog URL parameters');
assert.match(source, /pack[.]installed === true && typeof pack[.]activation_version === 'string'/,
  'the manager-selected verified local revision remains usable without coupling selection to an update');
assert.match(source, /pack[.]activation_presentation[.]version === activationVersion/,
  'installed presentation is accepted only for the manager-selected activation version');
assert.match(source, /active[.]version === selectedVersion/,
  'Currently in use is sent only when active and displayed activation versions are exact');
assert.match(source, /<a class="bundle-browser-open-full" href="' [+] CATALOG_URL [+] '" target="_blank" rel="noopener noreferrer"/,
  'the station owns a real, exact-URL, opener-isolated full-catalog link');
assert.doesNotMatch(source, /bundle-catalog-open|global[.]open\(/,
  'full-catalog navigation does not rely on an asynchronous popup relay');
assert.doesNotMatch(source, /matches_station/,
  'the catalog region must not be guessed from the active bundle');
assert.doesNotMatch(source, /body: JSON[.]stringify\(\{[^}]*\b(?:url|version|sha256|manifest)\b/);
assert.match(source, /event[.]target === dialog && backdropPointer === event[.]pointerId/);
assert.match(source, /dialog[.]addEventListener\('cancel'/);
assert.match(source, /returnFocus[.]focus\(\{ preventScroll: true \}\)/);
assert.match(source, /Math[.]min\(150, Math[.]max\(88, sheetHeight \* [.]18\)\)/);
assert.match(source, /drawer[.]dragY >= 28 && drawer[.]velocityY >= [.]7/);
assert.match(source, /elapsed <= 90/);
assert.match(source, /\}, 32\)/);
assert.match(source, /job[.]state === 'running'/);
assert.match(source, /Date[.]now\(\) >= pollDeadline/,
  'a nonterminal job at the polling deadline must stay non-successful and move to background reconciliation');
assert.match(source, /Math[.]min\(30000, 1000 \* Math[.]pow/,
  'temporary status failures use bounded background backoff instead of abandoning reconciliation');
assert.match(source, /jobTrackingId && \(!job \|\| job[.]id !== jobTrackingId\)/,
  'status polling is correlated to the job accepted by this page');
assert.match(source, /if \(!jobTracking\) \{[\s\S]*stopPolling\(\);[\s\S]*requestController[.]abort/,
  'leaving Settings preserves an accepted job watcher until its artwork is reconciled');
assert.doesNotMatch(source, /The selected bundle artwork did not refresh[.]/,
  'the redundant large generic artwork error is not user-facing');
assert.match(source, /global[.]setTimeout\(pollJob, 800\)/);
assert.match(source, /prefers-reduced-motion: reduce/);
assert.match(css, /height: calc\(100dvh - 8px\)/);
assert.match(css, /[.]bundle-browser-handle[\s\S]*touch-action: none/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
const bundleRowCss = css.match(/[.]bundle-setting-row \{([^}]*)\}/)?.[1] || '';
const bundleLiveCss = css.match(/[.]bundle-setting-row \[data-bundle-live\] \{([^}]*)\}/)?.[1] || '';
assert.match(bundleRowCss, /padding-block: 5px;/,
  'the Bird bundle row uses equal vertical padding around its selector');
assert.doesNotMatch(bundleRowCss, /padding-(?:top|bottom):/,
  'the Bird bundle row must not reintroduce asymmetric vertical padding');
assert.match(bundleLiveCss, /position: absolute;/,
  'the bundle status live region must not participate in the settings grid');
assert.match(bundleLiveCss, /width: 1px;[\s\S]*height: 1px;[\s\S]*clip-path: inset\(50%\);/,
  'the off-grid bundle status remains available to assistive technology');
assert.match(css, /[.]bundle-setting-trigger \{[\s\S]*min-height: 30px;[\s\S]*padding: 4px 7px 4px 11px;/,
  'the bundle selector no longer makes its Settings row taller than its neighbors');

class EventHub {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((candidate) => candidate !== listener));
  }
  emit(type, values = {}) {
    const event = Object.assign({
      type,
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {}
    }, values);
    (this.listeners.get(type) || []).slice().forEach((listener) => listener(event));
    return event;
  }
}

class TokenList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : !!force;
    if (next) this.values.add(value); else this.values.delete(value);
    return next;
  }
}

class FakeElement extends EventHub {
  constructor(name = 'element') {
    super();
    this.name = name;
    this.attributes = new Map();
    this.classList = new TokenList();
    this.style = {
      values: new Map(),
      setProperty: (key, value) => this.style.values.set(key, value),
      removeProperty: (key) => this.style.values.delete(key)
    };
    this.hidden = false;
    this.textContent = '';
    this.isConnected = true;
    this.focusCount = 0;
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null; }
  removeAttribute(key) { this.attributes.delete(key); }
  toggleAttribute(key, force) {
    const next = force === undefined ? !this.attributes.has(key) : !!force;
    if (next) this.attributes.set(key, ''); else this.attributes.delete(key);
    return next;
  }
  focus() { this.focusCount += 1; fakeDocument.activeElement = this; }
  remove() { this.isConnected = false; }
  getBoundingClientRect() { return { height: 700 }; }
  get offsetWidth() { return 100; }
}

class FakeFrame extends FakeElement {
  constructor() {
    super('iframe');
    this.src = '';
    this.contentWindow = {
      sent: [],
      postMessage: (message, origin) => this.contentWindow.sent.push({ message, origin })
    };
  }
}

class FakeDialog extends FakeElement {
  constructor() {
    super('dialog');
    this.open = false;
    this.sheet = new FakeElement('sheet');
    this.frame = new FakeFrame();
    this.handle = new FakeElement('handle');
    this.markup = '';
  }
  set innerHTML(value) { this.markup = value; }
  get innerHTML() { return this.markup; }
  querySelector(selector) {
    if (selector === '.bundle-browser-sheet') return this.sheet;
    if (selector === '.bundle-browser-frame') return this.frame;
    if (selector === '.bundle-browser-handle') return this.handle;
    return null;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const row = {
  trigger: new FakeElement('trigger'),
  current: new FakeElement('current'),
  note: new FakeElement('note'),
  live: new FakeElement('live'),
  querySelector(selector) {
    return ({
      '[data-bundle-browser-open]': this.trigger,
      '[data-bundle-current]': this.current,
      '[data-bundle-note]': this.note,
      '[data-bundle-live]': this.live
    })[selector] || null;
  }
};

const fakeBody = new FakeElement('body');
fakeBody.children = [];
fakeBody.appendChild = function (element) {
  this.children.push(element);
  element.isConnected = true;
  return element;
};
const fakeRoot = new FakeElement('html');
fakeRoot.setAttribute('data-theme', 'dark');
const fakeDocument = {
  documentElement: fakeRoot,
  body: fakeBody,
  activeElement: row.trigger,
  createElement(tag) { return tag === 'dialog' ? new FakeDialog() : new FakeElement(tag); }
};

const initial = {
  ok: true,
  catalog: {
    packs: [
      { id: 'official-western-us-woodblock', version: '1.0.0', name: 'Japanese Woodblock', availability: 'included', included: true, installed: true, installed_current: true, installed_versions: ['1.0.0'], activation_version: '1.0.0', active: true, active_current: true, matches_station: true, catalog_current: true, coverage: { group: 'western-north-america' }, style: { id: 'japanese-woodblock', name: 'Japanese Woodblock' } },
      { id: 'official-western-us-impressionist', version: '2.0.0', name: 'Evolutionary Impressionist', availability: 'installable', included: false, installed: false, active: false, active_current: false, matches_station: true, catalog_current: true, update_available: false, activation_version: null, installed_versions: [], coverage: { group: 'western-north-america' }, style: { id: 'evolutionary-impressionist', name: 'Evolutionary Impressionist' } },
      { id: 'community-preview', name: 'Preview only', availability: 'preview', included: false, installed: false, active: false, catalog_current: true, coverage: { group: 'europe' }, style: { id: 'japanese-woodblock', name: 'Japanese Woodblock' } },
      { id: 'community-unavailable', name: 'Unavailable', availability: 'unavailable', included: false, installed: false, active: false, catalog_current: true, coverage: { group: 'europe' }, style: { id: 'painterly', name: 'Painterly' } }
    ]
  },
  library: {
    active: {
      id: 'official-western-us-woodblock', version: '1.0.0', revision: 'included-woodblock-v1',
      included: true, name: 'Japanese Woodblock', species_count: 333
    },
    installed: [{ id: 'official-western-us-woodblock', version: '1.0.0' }]
  },
  job: null
};
const changed = structuredClone(initial);
const installedImpressionistV2 = {
  name: 'Evolutionary Impressionist',
  coverage: { label: 'Western North America', group: 'western-north-america' },
  style: { id: 'evolutionary-impressionist', name: 'Evolutionary Impressionist' },
  species_count: 333,
  creator: 'Avian Visitors',
  review: 'official',
  version: '2.0.0',
  license: 'CC-BY-NC-SA-4.0',
  archive_bytes: 298432679
};
changed.catalog.packs[0].active = false;
changed.catalog.packs[0].active_current = false;
changed.catalog.packs[1].installed = true;
changed.catalog.packs[1].installed_current = true;
changed.catalog.packs[1].installed_versions = ['2.0.0'];
changed.catalog.packs[1].activation_version = '2.0.0';
changed.catalog.packs[1].activation_presentation = structuredClone(installedImpressionistV2);
changed.catalog.packs[1].active = true;
changed.catalog.packs[1].active_current = true;
changed.catalog.packs[1].availability = 'unavailable';
changed.catalog.packs[1].catalog_current = false;
changed.library.active = {
  id: 'official-western-us-impressionist', version: '2.0.0', revision: '2'.repeat(64),
  included: false, name: 'Evolutionary Impressionist', species_count: 333
};
changed.library.installed.push({ id: 'official-western-us-impressionist', version: '2.0.0' });
const woodblockWithDownload = structuredClone(initial);
woodblockWithDownload.catalog.packs[1].installed = true;
woodblockWithDownload.catalog.packs[1].version = '3.0.0';
woodblockWithDownload.catalog.packs[1].installed_current = false;
woodblockWithDownload.catalog.packs[1].installed_versions = ['2.0.0'];
woodblockWithDownload.catalog.packs[1].activation_version = '2.0.0';
woodblockWithDownload.catalog.packs[1].activation_presentation = structuredClone(installedImpressionistV2);
woodblockWithDownload.catalog.packs[1].update_available = true;
woodblockWithDownload.library.installed.push({
  id: 'official-western-us-impressionist', version: '2.0.0'
});
const outdatedActive = structuredClone(woodblockWithDownload);
outdatedActive.catalog.packs[0].active = false;
outdatedActive.catalog.packs[0].active_current = false;
outdatedActive.catalog.packs[1].active = true;
outdatedActive.catalog.packs[1].active_current = false;
outdatedActive.catalog.packs[1].active_version = '2.0.0';
outdatedActive.library.active = structuredClone(changed.library.active);
const activeOlderWithNewerInstalled = structuredClone(woodblockWithDownload);
activeOlderWithNewerInstalled.catalog.packs[0].active = false;
activeOlderWithNewerInstalled.catalog.packs[0].active_current = false;
activeOlderWithNewerInstalled.catalog.packs[1].active = true;
activeOlderWithNewerInstalled.catalog.packs[1].active_current = false;
activeOlderWithNewerInstalled.catalog.packs[1].active_version = '1.0.0';
activeOlderWithNewerInstalled.catalog.packs[1].installed_versions = ['1.0.0', '2.0.0'];
activeOlderWithNewerInstalled.library.active = {
  id: 'official-western-us-impressionist', version: '1.0.0', revision: '4'.repeat(64),
  included: false, name: 'Evolutionary Impressionist', species_count: 333
};
activeOlderWithNewerInstalled.library.installed.push({
  id: 'official-western-us-impressionist', version: '1.0.0'
});
const delistedPack = {
  id: 'community-delisted-field-notes',
  version: '1.2.3',
  name: 'Delisted Field Notes',
  description: 'A verified local pack no longer present in discovery.',
  creator: 'Local Birder',
  review: 'community',
  license: 'CC-BY-4.0',
  archive_bytes: 91234,
  species_count: 27,
  availability: 'unavailable',
  included: false,
  installed: true,
  installed_current: true,
  installed_versions: ['1.2.3'],
  activation_version: '1.2.3',
  activation_presentation: {
    name: 'Delisted Field Notes',
    coverage: { label: 'Pacific Northwest', group: 'north-america' },
    style: { id: 'field-notes', name: 'Field Notes' },
    species_count: 27,
    creator: 'Local Birder',
    review: 'community',
    version: '1.2.3',
    license: 'CC-BY-4.0',
    archive_bytes: 91234
  },
  active: false,
  active_current: false,
  catalog_current: false,
  coverage: { group: 'north-america', label: 'Pacific Northwest' },
  style: { id: 'field-notes', name: 'Field Notes' }
};
const delistedSnapshot = structuredClone(initial);
delistedSnapshot.catalog.packs.push(delistedPack);
delistedSnapshot.library.installed.push({ id: delistedPack.id, version: delistedPack.version });
const delistedActive = structuredClone(delistedSnapshot);
delistedActive.catalog.packs[0].active = false;
delistedActive.catalog.packs.at(-1).active = true;
delistedActive.catalog.packs.at(-1).active_current = true;
delistedActive.library.active = {
  id: delistedPack.id,
  version: delistedPack.version,
  revision: '3'.repeat(64),
  included: false,
  name: delistedPack.name,
  species_count: delistedPack.species_count
};

const fetchCalls = [];
let statusReads = 0;
let currentSnapshot = structuredClone(initial);
let pendingSnapshot = null;
let longRunning = false;
let longJobSettled = false;
let longStatusCalls = 0;
let snapshotFailures = 0;
let foreignJob = false;
let fakeNow = 0;
const capturedErrors = [];
const fakeConsole = { ...console, error(...values) { capturedErrors.push(values); } };
async function fakeFetch(url, options = {}) {
  fetchCalls.push({ url: String(url), options });
  if (options.method === 'POST') {
    const target = JSON.parse(options.body).id;
    if (foreignJob) {
      return { ok: true, json: async () => ({ ok: true, accepted: true, job: { id: 'a'.repeat(32), state: 'running' } }) };
    }
    if (longRunning) {
      return { ok: true, json: async () => ({ ok: true, accepted: true, job: { id: 'f'.repeat(32), state: 'running' } }) };
    }
    if (target === 'official-western-us-woodblock') {
      currentSnapshot = structuredClone(woodblockWithDownload);
      pendingSnapshot = null;
      return { ok: true, json: async () => ({ ok: true, unchanged: true, active: currentSnapshot.library.active, job: null }) };
    }
    if (target === delistedPack.id) {
      currentSnapshot = structuredClone(delistedActive);
      pendingSnapshot = null;
      return { ok: true, json: async () => ({ ok: true, unchanged: true, active: currentSnapshot.library.active, job: null }) };
    }
    pendingSnapshot = structuredClone(
      currentSnapshot.catalog.packs[1]?.version === '3.0.0' ? outdatedActive : changed
    );
    statusReads = 0;
    return { ok: true, json: async () => ({ ok: true, accepted: true, job: { id: 'a'.repeat(32), state: 'running' } }) };
  }
  if (String(url).includes('?action=status')) {
    if (foreignJob) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          job: { id: 'b'.repeat(32), state: 'failed', error: 'A different job failed.' },
          active: currentSnapshot.library.active
        })
      };
    }
    if (longRunning) {
      fakeNow = 300001;
      longStatusCalls += 1;
      if (longStatusCalls === 2) throw new Error('temporary loopback interruption');
      if (longJobSettled) {
        currentSnapshot = structuredClone(woodblockWithDownload);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            job: { id: 'f'.repeat(32), state: 'succeeded', phase: 'complete', percent: 100 },
            active: currentSnapshot.library.active
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          job: { id: 'f'.repeat(32), state: 'running', phase: 'checking illustrations', percent: 98 },
          active: currentSnapshot.library.active
        })
      };
    }
    statusReads += 1;
    if (statusReads > 1 && pendingSnapshot) {
      currentSnapshot = pendingSnapshot;
      pendingSnapshot = null;
    }
    return {
      ok: true,
      json: async () => statusReads === 1
        ? ({ ok: true, job: { id: 'a'.repeat(32), state: 'running', phase: 'checking illustrations', percent: 42 }, active: currentSnapshot.library.active })
        : ({ ok: true, job: { id: 'a'.repeat(32), state: 'succeeded', phase: 'complete', percent: 100 }, active: currentSnapshot.library.active })
    };
  }
  if (snapshotFailures > 0) {
    snapshotFailures -= 1;
    return {
      ok: false,
      json: async () => ({ ok: false, error: 'temporary snapshot interruption' })
    };
  }
  return { ok: true, json: async () => structuredClone(currentSnapshot) };
}

let assigned = '';
let randomSeed = 0;
let refreshes = 0;
let refreshedActive = null;
class FakeMutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}
const fakeDate = { now() { return fakeNow; } };
const fakeWindow = new EventHub();
Object.assign(fakeWindow, {
  document: fakeDocument,
  location: {
    href: 'http://birdnet.local/avian/#admin=settings',
    origin: 'http://birdnet.local',
    assign(value) { assigned = value; }
  },
  history: { state: null, replaceState() {} },
  innerHeight: 900,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  crypto: {
    getRandomValues(bytes) {
      randomSeed += 1;
      bytes.forEach((_, index) => { bytes[index] = (randomSeed + index) & 255; });
      return bytes;
    }
  },
  setTimeout(callback, delay) { return setTimeout(callback, Math.min(delay, 5)); },
  clearTimeout,
  requestAnimationFrame(callback) { return setTimeout(callback, 0); },
  performance,
  MutationObserver: FakeMutationObserver,
  AbortController,
  URL,
  URLSearchParams,
  Uint8Array,
  Date: fakeDate,
  console: fakeConsole
});
fakeWindow.window = fakeWindow;

const context = vm.createContext({
  window: fakeWindow,
  document: fakeDocument,
  fetch: fakeFetch,
  MutationObserver: FakeMutationObserver,
  AbortController,
  URL,
  URLSearchParams,
  Uint8Array,
  Date: fakeDate,
  performance,
  requestAnimationFrame: fakeWindow.requestAnimationFrame,
  setTimeout,
  clearTimeout,
  console: fakeConsole
});
vm.runInContext(source, context, { filename: 'bundle-ui.js' });

fakeWindow.AVIAN_BUNDLES.mount({
  root: row,
  latitude: '37.4419',
  longitude: '-122.1430',
  refreshArtwork: (active) => { refreshes += 1; refreshedActive = structuredClone(active); }
});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(row.current.textContent, 'Japanese Woodblock');
assert.equal(refreshes, 1, 'opening Settings reconciles artwork to the exact active snapshot');
assert.equal(refreshedActive.revision, 'included-woodblock-v1');

row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
let modal = fakeBody.children.at(-1);
assert.equal(modal.open, true, 'selected bundle opens a modal dialog');
assert.doesNotMatch(modal.markup, /bundle-browser-close|<h\d/i,
  'modal chrome has only the mobile drag handle and catalog frame');
assert.match(modal.markup, /sandbox="allow-scripts"/);
assert.match(modal.markup, /<a class="bundle-browser-open-full" href="https:\/\/avianvisitors[.]com\/bundles" target="_blank" rel="noopener noreferrer"/);
const frameUrl = new URL(modal.frame.src);
const nonce = frameUrl.searchParams.get('handoff');
assert.match(nonce, /^[0-9a-f]{32}$/);
assert.equal(frameUrl.searchParams.get('theme'), 'dark');
assert.equal(frameUrl.searchParams.get('region'), 'North America');
assert.equal(frameUrl.searchParams.get('style'), 'japanese-woodblock');

modal.frame.emit('load');
assert.ok(modal.frame.contentWindow.sent.some(({ message, origin }) =>
  origin === '*' && message.type === 'avianvisitors:bundle-theme' && message.theme === 'dark' && message.handoff === nonce));
assert.ok(modal.frame.contentWindow.sent.some(({ message, origin }) =>
  origin === '*' && message.type === 'avianvisitors:bundle-library' &&
  message.ids.includes('official-western-us-woodblock') &&
  message.activeId === 'official-western-us-woodblock' &&
  Array.from(message.installableIds).join(',') ===
    'official-western-us-woodblock,official-western-us-impressionist' &&
  message.installedPacks.length === 1 &&
  message.installedPacks[0].id === 'official-western-us-woodblock' &&
  Object.keys(message.installedPacks[0]).sort().join(',') ===
    'archiveBytes,contributor,id,license,name,official,region,regionGroup,species,style,styleId,version' &&
  Object.keys(message).sort().join(',') === 'activeId,handoff,ids,installableIds,installedPacks,type,v'));

const postCount = () => fetchCalls.filter((call) => call.options.method === 'POST').length;
fakeWindow.emit('message', { source: {}, origin: 'null', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: nonce, id: 'official-western-us-impressionist' } });
fakeWindow.emit('message', { source: modal.frame.contentWindow, origin: 'http://birdnet.local', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: nonce, id: 'official-western-us-impressionist' } });
fakeWindow.emit('message', { source: modal.frame.contentWindow, origin: 'null', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: '0'.repeat(32), id: 'official-western-us-impressionist' } });
fakeWindow.emit('message', { source: modal.frame.contentWindow, origin: 'null', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: nonce, id: 'official-western-us-impressionist', version: '9.9.9' } });
fakeWindow.emit('message', { source: modal.frame.contentWindow, origin: 'null', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: nonce, id: 'community-preview' } });
fakeWindow.emit('message', { source: modal.frame.contentWindow, origin: 'null', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: nonce, id: 'community-unavailable' } });
fakeWindow.emit('message', { source: modal.frame.contentWindow, origin: 'null', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: nonce, id: 'community-live-watercolor' } });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(postCount(), 0, 'wrong source/origin/nonce/schema, discovery-only IDs, and live IDs absent from the trusted station feed are rejected');

fakeWindow.emit('message', { source: modal.frame.contentWindow, origin: 'null', data: { v: 1, type: 'avianvisitors:bundle-install', handoff: nonce, id: 'official-western-us-impressionist' } });
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(postCount(), 1);
const post = fetchCalls.find((call) => call.options.method === 'POST');
assert.deepEqual(JSON.parse(post.options.body), { action: 'use', id: 'official-western-us-impressionist' });
assert.equal(post.options.headers['X-Avian-Action'], '1');
assert.ok(statusReads >= 2, 'running jobs are polled through the status endpoint until settled');
assert.equal(row.current.textContent, 'Evolutionary Impressionist');
assert.equal(refreshes, 2);
assert.equal(refreshedActive.revision, '2'.repeat(64),
  'artwork refresh is bound to the exact active revision from the settled station snapshot');
assert.equal(refreshedActive.id, 'official-western-us-impressionist');
assert.ok(row.trigger.focusCount >= 1, 'closing returns focus to the Settings trigger');

row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
const secondNonce = new URL(modal.frame.src).searchParams.get('handoff');
assert.notEqual(secondNonce, nonce, 'every open uses a fresh capability');
modal.frame.emit('load');
const changedLibrary = modal.frame.contentWindow.sent.find(({ message }) => message.type === 'avianvisitors:bundle-library');
assert.equal(Array.from(changedLibrary.message.ids).join(','),
  'official-western-us-impressionist,official-western-us-woodblock');
assert.equal(changedLibrary.message.activeId, 'official-western-us-impressionist',
  'the active bundle is first and explicit in each trusted library snapshot');
assert.deepEqual(Array.from(changedLibrary.message.installableIds),
  ['official-western-us-woodblock', 'official-western-us-impressionist'],
  'the exact installed official revision remains selectable after its feed entry becomes unavailable');
assert.equal(changedLibrary.message.installedPacks[0].id, 'official-western-us-impressionist');
assert.deepEqual(
  Object.fromEntries(Object.entries(changedLibrary.message.installedPacks[0])),
  {
    id: 'official-western-us-impressionist',
    name: 'Evolutionary Impressionist',
    region: 'Western North America',
    regionGroup: 'North America',
    style: 'Evolutionary Impressionist',
    styleId: 'evolutionary-impressionist',
    species: 333,
    contributor: 'Avian Visitors',
    official: true,
    version: '2.0.0',
    license: 'CC-BY-NC-SA-4.0',
    archiveBytes: 298432679
  },
  'the parent exports only bounded facts from the manager-selected installed revision');

fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: secondNonce, id: 'official-western-us-woodblock' }
});
await new Promise((resolve) => setTimeout(resolve, 35));
assert.equal(row.current.textContent, 'Japanese Woodblock');
assert.equal(refreshes, 3);
assert.equal(refreshedActive.revision, 'included-woodblock-v1');

row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
let roundTripNonce = new URL(modal.frame.src).searchParams.get('handoff');
modal.frame.emit('load');
let roundTripLibrary = modal.frame.contentWindow.sent.find(({ message }) => message.type === 'avianvisitors:bundle-library');
assert.deepEqual(Array.from(roundTripLibrary.message.ids),
  ['official-western-us-woodblock', 'official-western-us-impressionist'],
  'downloaded bundles remain installed and are ordered after the active built-in bundle');
assert.ok(roundTripLibrary.message.installableIds.includes('official-western-us-impressionist'),
  'catalog v3 remains selectable offline through the manager-selected installed v2 activation');
assert.equal(roundTripLibrary.message.installedPacks.find((pack) =>
  pack.id === 'official-western-us-impressionist').version, '2.0.0',
  'the opaque catalog labels the verified local activation version instead of unavailable catalog v3');
const beforeOfflineReselect = postCount();
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: roundTripNonce, id: 'official-western-us-impressionist' }
});
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(postCount(), beforeOfflineReselect + 1);
assert.deepEqual(JSON.parse(fetchCalls.filter((call) => call.options.method === 'POST').at(-1).options.body),
  { action: 'use', id: 'official-western-us-impressionist' },
  'offline reselect stays ID-only and never lets the iframe choose installed v2');
assert.equal(row.current.textContent, 'Evolutionary Impressionist');
assert.equal(refreshes, 4);
assert.equal(refreshedActive.revision, '2'.repeat(64));
assert.equal(refreshedActive.version, '2.0.0',
  'switching away and back activates verified local v2 without attempting the unavailable v3 update');

row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
roundTripNonce = new URL(modal.frame.src).searchParams.get('handoff');
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: roundTripNonce, id: 'official-western-us-woodblock' }
});
await new Promise((resolve) => setTimeout(resolve, 35));
assert.equal(row.current.textContent, 'Japanese Woodblock');
assert.equal(refreshes, 5);
assert.equal(refreshedActive.revision, 'included-woodblock-v1',
  'two full Woodblock to Impressionist to Woodblock passes retain exact identity');

// The active identity and the preferred installed activation can share an ID
// while differing by version after rollback or an update without activation.
// In that case the displayed v2 target must remain actionable rather than
// being mislabeled as the active v1 revision.
fakeWindow.AVIAN_BUNDLES.unmount();
currentSnapshot = structuredClone(activeOlderWithNewerInstalled);
fakeWindow.AVIAN_BUNDLES.mount({
  root: row,
  latitude: '37.4419',
  longitude: '-122.1430',
  refreshArtwork: (active) => { refreshes += 1; refreshedActive = structuredClone(active); }
});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(refreshedActive.version, '1.0.0');
row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
const versionExactNonce = new URL(modal.frame.src).searchParams.get('handoff');
modal.frame.emit('load');
const versionExactLibrary = modal.frame.contentWindow.sent.find(({ message }) =>
  message.type === 'avianvisitors:bundle-library');
assert.equal(versionExactLibrary.message.activeId, '',
  'activeId is withheld when active v1 differs from the displayed, manager-selected v2 activation');
assert.equal(versionExactLibrary.message.installedPacks.find((pack) =>
  pack.id === 'official-western-us-impressionist').version, '2.0.0');
const beforeVersionExactUse = postCount();
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: {
    v: 1,
    type: 'avianvisitors:bundle-install',
    handoff: versionExactNonce,
    id: 'official-western-us-impressionist'
  }
});
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(postCount(), beforeVersionExactUse + 1,
  'the v2 presentation remains selectable while v1 of the same ID is active');
assert.deepEqual(JSON.parse(fetchCalls.filter((call) => call.options.method === 'POST').at(-1).options.body),
  { action: 'use', id: 'official-western-us-impressionist' });
assert.equal(refreshedActive.version, '2.0.0',
  'the server-selected verified v2 becomes active after the ID-only request');

// A pack whose immutable installed manifest is still verified remains a valid
// exact activation target after it disappears from both live and vendored
// discovery. Presentation fields are bounded by the parent and do not carry a
// URL, checksum, or version chosen by the opaque child.
fakeWindow.AVIAN_BUNDLES.unmount();
currentSnapshot = structuredClone(delistedSnapshot);
fakeWindow.AVIAN_BUNDLES.mount({
  root: row,
  latitude: '37.4419',
  longitude: '-122.1430',
  refreshArtwork: (active) => { refreshes += 1; refreshedActive = structuredClone(active); }
});
await new Promise((resolve) => setTimeout(resolve, 10));
row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
const delistedNonce = new URL(modal.frame.src).searchParams.get('handoff');
modal.frame.emit('load');
const delistedLibrary = modal.frame.contentWindow.sent.find(({ message }) =>
  message.type === 'avianvisitors:bundle-library');
assert.ok(delistedLibrary.message.ids.includes(delistedPack.id));
assert.ok(delistedLibrary.message.installableIds.includes(delistedPack.id),
  'installed_current remains usable when availability is unavailable and catalog_current is false');
assert.deepEqual(
  Object.fromEntries(Object.entries(delistedLibrary.message.installedPacks.find((pack) =>
    pack.id === delistedPack.id))),
  {
    id: delistedPack.id,
    name: delistedPack.name,
    region: 'Pacific Northwest',
    regionGroup: 'North America',
    style: 'Field Notes',
    styleId: 'field-notes',
    species: 27,
    contributor: 'Local Birder',
    official: false,
    version: '1.2.3',
    license: 'CC-BY-4.0',
    archiveBytes: 91234
  },
  'only the bounded public-safe presentation schema crosses into the opaque frame');
const beforeDelistedPost = postCount();
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: delistedNonce, id: 'community-forged' }
});
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(postCount(), beforeDelistedPost,
  'the opaque child cannot invent an activation target from presentation metadata');
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: delistedNonce, id: delistedPack.id }
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(postCount(), beforeDelistedPost + 1);
assert.deepEqual(JSON.parse(fetchCalls.filter((call) => call.options.method === 'POST').at(-1).options.body),
  { action: 'use', id: delistedPack.id });
assert.equal(row.current.textContent, delistedPack.name);
assert.equal(refreshedActive.revision, '3'.repeat(64));

fakeWindow.AVIAN_BUNDLES.unmount();
currentSnapshot = structuredClone(woodblockWithDownload);
fakeWindow.AVIAN_BUNDLES.mount({
  root: row,
  latitude: '37.4419',
  longitude: '-122.1430',
  refreshArtwork: (active) => { refreshes += 1; refreshedActive = structuredClone(active); }
});
await new Promise((resolve) => setTimeout(resolve, 10));

row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
modal.emit('pointerdown', { target: modal, pointerId: 4 });
modal.emit('pointerup', { target: modal.sheet, pointerId: 4 });
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(modal.open, true, 'a gesture that begins on the backdrop and ends on content does not close');
modal.emit('pointerdown', { target: modal, pointerId: 5 });
modal.emit('pointerup', { target: modal, pointerId: 5 });
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(modal.open, false, 'matching backdrop down/up closes');

row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
assert.equal(assigned, '', 'the station remains in Settings when the full catalog opens');
const cancel = modal.emit('cancel');
assert.equal(cancel.defaultPrevented, true);
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(modal.open, false, 'Escape/cancel closes without visible close chrome');

// A download belongs to the page, not the Settings DOM. Leaving Settings while
// it runs must still reconcile the visible collage to the activated revision.
row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
const backgroundNonce = new URL(modal.frame.src).searchParams.get('handoff');
const beforeBackgroundRefresh = refreshes;
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: backgroundNonce, id: 'official-western-us-impressionist' }
});
fakeWindow.AVIAN_BUNDLES.unmount();
await new Promise((resolve) => setTimeout(resolve, 60));
assert.equal(refreshes, beforeBackgroundRefresh + 1,
  'an accepted job refreshes artwork after Settings has unmounted');
assert.equal(refreshedActive.revision, '2'.repeat(64));

fakeWindow.AVIAN_BUNDLES.mount({
  root: row,
  latitude: '37.4419',
  longitude: '-122.1430',
  refreshArtwork: (active) => { refreshes += 1; refreshedActive = structuredClone(active); }
});
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(row.current.textContent, 'Evolutionary Impressionist');
assert.equal(refreshedActive.revision, '2'.repeat(64),
  'remount reconciles the exact active snapshot even after a background change');

// A still-running job at the deadline is not success. It leaves the current
// identity alone and reports a small actionable timeout instead.
fakeNow = 0;
longRunning = true;
longStatusCalls = 0;
row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
const timeoutNonce = new URL(modal.frame.src).searchParams.get('handoff');
const beforeTimeoutRefresh = refreshes;
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: timeoutNonce, id: 'official-western-us-woodblock' }
});
await new Promise((resolve) => setTimeout(resolve, 35));
assert.equal(refreshes, beforeTimeoutRefresh,
  'deadline expiry cannot refresh stale artwork or report a successful change');
assert.equal(row.current.textContent, 'Evolutionary Impressionist');
assert.match(row.note.textContent, /taking longer than expected/);
assert.equal(row.note.hidden, false);
assert.doesNotMatch(row.live.textContent, /updated|selected/i);
assert.ok(longStatusCalls >= 3,
  'the background watcher survives a temporary status request failure');
snapshotFailures = 1;
longJobSettled = true;
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(refreshes, beforeTimeoutRefresh + 1,
  'the slower reconciliation watcher refreshes exact artwork when a long job eventually succeeds');
assert.equal(snapshotFailures, 0,
  'terminal success keeps reconciling after a temporary active-snapshot failure');
assert.equal(row.current.textContent, 'Japanese Woodblock');
assert.equal(refreshedActive.revision, 'included-woodblock-v1');
assert.equal(row.note.hidden, true);
longRunning = false;
longJobSettled = false;

// A station-wide job started elsewhere must never have its progress or error
// attributed to the job accepted by this page. Reconcile current truth instead.
foreignJob = true;
row.trigger.emit('click');
await new Promise((resolve) => setTimeout(resolve, 10));
modal = fakeBody.children.at(-1);
const foreignNonce = new URL(modal.frame.src).searchParams.get('handoff');
const beforeForeignRefresh = refreshes;
fakeWindow.emit('message', {
  source: modal.frame.contentWindow,
  origin: 'null',
  data: { v: 1, type: 'avianvisitors:bundle-install', handoff: foreignNonce, id: 'official-western-us-impressionist' }
});
await new Promise((resolve) => setTimeout(resolve, 35));
assert.equal(refreshes, beforeForeignRefresh + 1,
  'a superseding foreign job triggers one neutral exact-identity reconciliation');
assert.equal(row.current.textContent, 'Japanese Woodblock');
assert.equal(refreshedActive.revision, 'included-woodblock-v1');
assert.equal(row.live.textContent, 'Bird bundle refreshed.');
assert.equal(row.note.hidden, true);
assert.doesNotMatch(row.live.textContent, /different job failed/i,
  'the foreign job failure is never reported as this page\'s selection failure');
foreignJob = false;

// A persistent artwork-only miss stays out of the row and gets another exact
// attempt on the next mount instead of reproducing the old oversized warning.
fakeWindow.AVIAN_BUNDLES.unmount();
fakeWindow.AVIAN_BUNDLES.mount({
  root: row,
  latitude: '37.4419',
  longitude: '-122.1430',
  refreshArtwork: () => false
});
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(row.note.hidden, true);
assert.doesNotMatch(row.note.textContent, /selected bundle artwork did not refresh/i);
assert.match(row.live.textContent, /Artwork will retry/);
assert.ok(capturedErrors.some((values) => String(values[0]).includes('bundle artwork refresh failed')),
  'an artwork-only miss remains available to diagnostics without enlarging the Settings row');
fakeWindow.AVIAN_BUNDLES.unmount();

async function regionFromFrame(latitude, longitude) {
  fakeWindow.AVIAN_BUNDLES.mount({ root: row, latitude, longitude });
  await new Promise((resolve) => setTimeout(resolve, 10));
  row.trigger.emit('click');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const opened = fakeBody.children.at(-1);
  const region = new URL(opened.frame.src).searchParams.get('region');
  fakeWindow.AVIAN_BUNDLES.unmount();
  return region;
}

for (const [latitude, longitude, expected] of [
  [37.4419, -122.1430, 'North America'],
  [-23.5505, -46.6333, 'South America'],
  [51.5072, -0.1276, 'Europe'],
  [-1.2921, 36.8219, 'Africa'],
  [35.6762, 139.6503, 'Asia'],
  [-33.8688, 151.2093, 'Oceania'],
  [0, 0, null],
]) {
  assert.equal(await regionFromFrame(latitude, longitude), expected,
    `configured coordinates ${latitude},${longitude} should select ${expected || 'All regions'}`);
}

console.log('Bundle Settings catalog behavior and security smoke passed.');
