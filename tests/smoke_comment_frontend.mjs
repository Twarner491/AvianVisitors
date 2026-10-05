import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
function between(start, end) {
  const offset = apt.indexOf(start);
  assert.ok(offset >= 0);
  return apt.slice(offset, apt.indexOf(end, offset));
}

const sliders = { v: { SF_THRESH: 0.0005 } };
vm.createContext(sliders);
vm.runInContext(between('  function settingsSlider(', '  function settingsSegmented('), sliders);
const call = apt.match(/settingsSlider\('SF_THRESH'[^\n]+\)/)[0];
const html = vm.runInContext(call, sliders);
assert.match(html, /min="0.0005"/);
assert.match(html, /step="0.0005"/);
assert.match(html, /value="0.0005"/);
assert.match(html, /data-value-for="SF_THRESH">0.0005</);

const children = [];
const attrs = {};
const bird = { sci: 'Corvus brachyrhynchos', com: 'Crow" onerror="bad()', n: 2 };
const collage = {
  clientWidth: 600, clientHeight: 800,
  removeAttribute(name) { delete attrs[name]; },
  setAttribute(name, value) { attrs[name] = String(value); },
  appendChild(child) { children.push(child); },
};
const render = {
  collage, collageRenderRevision: 0, collagePlaced: [], collageHovered: null,
  DATA: { recent: { species: [bird], frame_capture_id: 3 } },
  tablesReady: true, labelFontReady: true, collagePose: {},
  DIMS: { 'corvus-brachyrhynchos': [100, 100] },
  FLY_PROB: 0, COLLAGE_PAD: 1, currentHours: 24,
  EMPTY_WINDOW_COPY: 'No birds heard',
  labelsOn() { return false; }, loadMask() { return {}; },
  slugify(sci) { return sci.toLowerCase().replaceAll(' ', '-'); },
  tuning() { return { packingBudgetFrac: 0.3, minTileAreaFrac: 0.01, countExp: 0.4 }; },
  assignLabels() {},
  maskPack(tiles) { return tiles.map(tile => ({ ...tile, x: 30, y: 30 })); },
  collageImageSrc() { return '/crow.png'; },
  educatorScopeId() { return ''; }, windowLabel() { return 'today'; }, fmtN(n) { return String(n); },
  document: { createElement() { return { style: {}, setAttribute() {} }; } },
};
vm.createContext(render);
vm.runInContext(between('  function escHtml(', '\n  }') + '\n  }', render);
vm.runInContext(between('  function finishFrameRender(', '\n  // Staggered centre-out entrance:'), render);
render.renderCollage(render.DATA.recent.species, false);
assert.equal(children[0].innerHTML,
  '<img loading="lazy" decoding="async" src="/crow.png" alt="Crow&quot; onerror=&quot;bad()">',
  'a name cannot create a second HTML attribute');
assert.equal(attrs['data-frame-count'], '1');
assert.equal(attrs['data-frame-token'], '3');
const firstRevision = attrs['data-frame-revision'];
render.DATA.recent = { species: [], frame_capture_id: 4 };
render.renderCollage(render.DATA.recent.species, false);
assert.equal(attrs['data-frame-count'], '0');
assert.equal(attrs['data-frame-token'], '4');
assert.notEqual(attrs['data-frame-revision'], firstRevision);
render.renderCollage([bird], false);
assert.equal(attrs['data-frame-token'], undefined, 'stale data cannot claim the current response token');
for (const name of ['Anna\'s Hummingbird', 'Mésange & mésange', 'Crow "visitor"']) {
  bird.com = name;
  render.DATA.recent = { species: [bird], frame_capture_id: 5 };
  render.renderCollage(render.DATA.recent.species, false);
  assert.equal(children.at(-2).innerHTML,
    '<img loading="lazy" decoding="async" src="/crow.png" alt="' + render.escHtml(name) + '">');
}
const unknown = { sci: 'Unknown example', com: 'Unknown', n: 1 };
render.loadMask = slug => slug === 'corvus-brachyrhynchos' ? {} : null;
render.DATA.recent = { species: [bird, unknown], frame_capture_id: 6 };
render.renderCollage(render.DATA.recent.species, false);
assert.equal(attrs['data-frame-count'], '1', 'individual missing illustrations stay excluded');
assert.equal(attrs['data-frame-token'], '6');
render.DATA.recent = { species: [unknown], frame_capture_id: 7 };
render.renderCollage(render.DATA.recent.species, false);
assert.equal(attrs['data-frame-token'], undefined, 'no drawable birds is not a completed empty window');
render.maskPack = tiles => tiles.map(tile => ({ ...tile, x: -99999, y: -99999 }));
render.DATA.recent = { species: [bird], frame_capture_id: 8 };
render.renderCollage(render.DATA.recent.species, false);
assert.equal(attrs['data-frame-token'], undefined, 'unplaced tiles cannot acknowledge a completed capture');
console.log('comment frontend tests passed');
