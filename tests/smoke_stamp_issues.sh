#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

node - "$repo" <<'NODE'
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repo = process.argv[2];
const frontend = path.join(repo, 'avian/frontend');
function loadStampSystem(batchCssReady) {
  const attributes = {};
  const document = {
    documentElement: {
      setAttribute(name, value) { attributes[name] = value; }
    },
    createElement() {
      return {
        style: {}, setAttribute() {}, appendChild() {},
        querySelectorAll() { return []; }
      };
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    body: { appendChild() {} }
  };
  const getComputedStyle = () => ({
    getPropertyValue(name) {
      return name === '--avian-stamp-batch-c-ready' && batchCssReady ? '1' : '';
    }
  });
  const window = {
    addEventListener() {},
    matchMedia() { return { matches: false }; },
    getComputedStyle,
    document,
    devicePixelRatio: 1
  };
  const sandbox = {
    window, document, globalThis: null,
    Image: function Image() {},
    IntersectionObserver: undefined,
    ResizeObserver: undefined,
    requestAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    getComputedStyle,
    innerHeight: 800,
    console, Promise, Math, Uint8Array, Uint16Array, Uint32Array, Int32Array,
    Float32Array, Map, Set
  };
  sandbox.globalThis = sandbox;

  [
    'stamps.js',
    'stamp-batch-root.js',
    'stamp-batch-a.js',
    'stamp-batch-b.js',
    'stamp-batch-c.js'
  ].forEach((file) => {
    vm.runInNewContext(fs.readFileSync(path.join(frontend, file), 'utf8'), sandbox, {
      filename: file
    });
  });
  return { stamps: window.STAMPS, attributes };
}

const loaded = loadStampSystem(true);
const stamps = loaded.stamps;
assert.equal(loaded.attributes['data-stamp-batch-c'], 'ready');
const stampSource = fs.readFileSync(path.join(frontend, 'stamps.js'), 'utf8');
assert.doesNotMatch(stampSource, /ORDERED_STYLES|hashPick/,
  'unsupported names must not retain the legacy template hash path');
[
  ['Megaceryle alcyon', 'Kingfishers', 'ribbonbird'],
  ['Mareca strepera', 'Waterfowl', 'linescreen'],
  ['Stelgidopteryx serripennis', 'Swallows', 'ribbonbird'],
  ['Certhia americana', 'Treecreepers', 'ribbonbird'],
  ['Tringa melanoleuca', 'Shorebirds', 'ribbonbird'],
  ['Limnodromus scolopaceus', 'Shorebirds', 'ribbonbird']
].forEach(([sci, family, style]) => {
  assert.equal(stamps.familyOf(sci), family, `${sci} family`);
  assert.equal(stamps.styleFor(sci).id, style, `${sci} style`);
});

[
  ['Megaceryle alcyon', 'Alcedinidae'],
  ['Stelgidopteryx serripennis', 'Hirundinidae'],
  ['Certhia americana', 'Certhiidae'],
  ['Tringa melanoleuca', 'Scolopacidae'],
  ['Limnodromus scolopaceus', 'Scolopacidae']
].forEach(([sci, latin]) => {
  assert.equal(stamps.latinOf(sci), latin, `${sci} Latin family`);
});

const future = 'Futuregenus example';
assert.equal(stamps.familyOf(future), 'Other', 'unknown genera remain Other');
assert.equal(stamps.latinOf(future), '', 'unknown genera have no false Latin family');
assert.equal(stamps.styleFor(future).id, 'ribbonbird', 'unknown genera use ribbonbird');
const futureMarkup = stamps.markup({ sci: future, com: 'Future Bird', index: 1 }, './bird.png');
assert.match(futureMarkup, /data-family="Other"/);
assert.match(futureMarkup, /data-style="ribbonbird"/);

const greatSpotted = 'Dendrocopos major';
assert.equal(stamps.styleFor(greatSpotted).id, 'ribbonbird',
  'Great Spotted Woodpecker uses the complete shared issue');
const greatSpottedMarkup = stamps.markup(
  { sci: greatSpotted, com: 'Great Spotted Woodpecker', index: 1 }, './bird.png'
);
assert.match(greatSpottedMarkup, /class="face tpl-ribbonbird"/);
assert.match(greatSpottedMarkup, /data-style="ribbonbird"/);

[
  'Unknownus alpha', 'Unknownus beta', 'Novelgenus gamma',
  'Anothergenus delta', 'Uncatalogued epsilon'
].forEach((sci) => {
  assert.equal(stamps.styleFor(sci).id, 'ribbonbird',
    `${sci} must not hash into a retired template`);
});

const fallback = stamps.TPL.ribbonbird;
delete stamps.TPL.ribbonbird;
assert.equal(stamps.styleFor(future).id, 'geo',
  'missing shared issue keeps the species on an approved core issue');
assert.match(stamps.markup({ sci: future, com: 'Future Bird', index: 1 }, './bird.png'),
  /data-style="geo"/, 'missing shared issue still emits a complete stamp');
const explicitMarkup = stamps.markup(
  { sci: future, com: 'Future Bird', index: 1 }, './bird.png', stamps.TPL.geo
);
assert.match(explicitMarkup, /data-family="Other"/);
assert.match(explicitMarkup, /data-style="geo"/);
stamps.TPL.ribbonbird = fallback;

const withoutBatchCss = loadStampSystem(false);
assert.equal(withoutBatchCss.attributes['data-stamp-batch-c'], 'css-missing');
assert.equal(withoutBatchCss.stamps.TPL.ribbonbird, undefined,
  'batch C markup is not registered without its complete stylesheet');
assert.equal(withoutBatchCss.stamps.styleFor(future).id, 'geo',
  'unknown species use the styled core geo issue when batch C CSS is missing');
assert.equal(withoutBatchCss.stamps.styleFor(greatSpotted).id, 'geo',
  'Great Spotted Woodpecker uses the styled core fallback when batch C CSS is missing');
assert.match(
  withoutBatchCss.stamps.markup(
    { sci: greatSpotted, com: 'Great Spotted Woodpecker', index: 1 }, './bird.png'
  ),
  /data-style="geo"/,
  'missing batch C CSS cannot emit unstyled ribbonbird markup'
);

const batchCss = fs.readFileSync(path.join(frontend, 'stamp-batch-c.css'), 'utf8').trim();
assert.match(batchCss, /:root\{--avian-stamp-batch-c-ready:1\}$/,
  'the batch C readiness marker must stay at the end of the stylesheet');
assert.match(batchCss,
  /\.tpl-ribbonbird \.wv-head h3\{[^}]*box-sizing:content-box;[^}]*padding-block-end:\.16em;/,
  'shared-family labels must leave room for letters below the baseline');
const indexHtml = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
assert.match(indexHtml, /stamp-batch-c\.css\?v=r231/,
  'the guarded batch C stylesheet must have a fresh cache key');
NODE

printf '%s\n' 'stamp issue smoke test passed'
