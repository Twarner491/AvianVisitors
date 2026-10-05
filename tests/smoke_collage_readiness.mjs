import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
function between(start, end) {
  const offset = apt.indexOf(start);
  assert.ok(offset >= 0);
  return apt.slice(offset, apt.indexOf(end, offset));
}
const draws = [];
const context = {
  DATA: { recent: null },
  renderCollage(items) { draws.push(items); },
};
vm.createContext(context);
vm.runInContext(between('  function renderCollageFromData(', '  var rTimer;'), context);
context.renderCollageFromData();
assert.equal(draws.length, 0, 'loading is not a successful empty detection window');
context.DATA.recent = { error: 'database unavailable' };
context.renderCollageFromData();
assert.equal(draws.length, 0, 'malformed detections cannot clear the collage');
context.DATA.recent = { species: [] };
context.renderCollageFromData();
assert.equal(draws.length, 1, 'a successful zero-detection result clears old birds');
assert.deepEqual(draws[0], []);

let finishStats;
let earlyDraws = 0;
let siteName = 'BirdNET-Pi';
const bird = { sci: 'Corvus brachyrhynchos', com: 'American Crow', n: 2 };
const delayedStats = new Promise(resolve => { finishStats = resolve; });
const refresh = {
  window: {},
  DATA: { calendar: {}, recent: null },
  educatorScopeBlocked: false, educatorDataLoading: false, educatorScopeGeneration: 0,
  currentHours: 24, hourlyDate: null, console,
  educatorScopeId() { return ''; },
  educatorScopeRequest() { return { generation: 0, scopeId: '' }; },
  scopedFetchJson(action) {
    return action === 'stats' ? delayedStats : Promise.resolve(
      action === 'recent' ? { species: [bird], site_name: 'Garden birds' } : {});
  },
  educatorBatchIsCurrent() { return true; },
  applySiteName(name) { siteName = name; }, recomputeDerived() {}, renderTimeIndependent() {},
  renderHourly() {}, updateStatsDateNav() {},
  renderCollageFromData() { earlyDraws++; },
  document: { getElementById() { return null; } },
};
vm.createContext(refresh);
vm.runInContext(between('  function refreshAll(', '\n  // Kick off the initial fetch.'), refresh);
const pending = refresh.refreshAll();
await new Promise(resolve => setImmediate(resolve));
assert.equal(refresh.DATA.recent.species[0].sci, bird.sci,
  'ordinary collage detections do not wait for an unrelated stats response');
assert.equal(earlyDraws, 1);
assert.equal(siteName, 'Garden birds', 'the early collage carries its station title');
finishStats({});
await pending;

for (const mode of ['transactional', 'changed-scope', 'changed-window', 'frame', 'frame-stats-error']) {
  let finishRecent;
  refresh.DATA.recent = null;
  refresh.educatorDataLoading = mode === 'transactional';
  refresh.window.__avianFrameCapture = mode.startsWith('frame');
  refresh.educatorScopeGeneration = 0;
  refresh.currentHours = 24;
  refresh.setEducatorDataLoading = loading => { refresh.educatorDataLoading = loading; };
  refresh.scopedFetchJson = action => action === 'stats' ? new Promise(resolve => { finishStats = resolve; })
    : action === 'recent' ? new Promise(resolve => { finishRecent = resolve; }) : Promise.resolve({});
  const before = earlyDraws;
  const inFlight = refresh.refreshAll();
  if (mode === 'changed-scope') refresh.educatorScopeGeneration++;
  if (mode === 'changed-window') refresh.currentHours = 12;
  finishRecent({ species: [bird] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(earlyDraws, before, `${mode} cannot use the ordinary early-render path`);
  finishStats(mode === 'frame-stats-error' ? Promise.reject(new Error('stats unavailable')) : {});
  await inFlight;
  if (mode.startsWith('frame')) {
    assert.equal(earlyDraws, before + 1, 'frame capture renders once after the initial batch settles');
    assert.equal(refresh.DATA.recent.species[0].sci, bird.sci);
  }
}

const shooter = fs.readFileSync(new URL('../frame/shoot.py', import.meta.url), 'utf8');
const readySource = shooter.match(/FRAME_READY = """([\s\S]*?)"""/)[1];
const frameAttrs = { frameToken: '1', frameRevision: '1', frameCount: '1' };
const classes = new Set();
const viewsAttrs = {};
const scopeContext = {
  DATA: { recent: { species: [bird] } }, educatorScopeGeneration: 0,
  educatorDataLoading: false, educatorScopeBlocked: false,
  document: {
    body: { classList: {
      contains(name) { return classes.has(name); },
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
    } },
    getElementById(id) {
      if (id === 'views') return { setAttribute(name, value) { viewsAttrs[name] = value; } };
      if (id === 'collage') return {
        dataset: frameAttrs,
        removeAttribute(name) { if (name === 'data-frame-token') delete frameAttrs.frameToken; },
        querySelectorAll(selector) {
          return selector === '.gtile' ? [{}] : [{ complete: true, naturalWidth: 100 }];
        },
      };
      return null;
    },
  },
};
vm.createContext(scopeContext);
vm.runInContext(between('  function setEducatorDataLoading(', '  function educatorScopeRequestCurrent(')
  + between('  function resetScopedDataCaches(', '  function applyEducatorScope(')
  + `\nvar frameReady = ${readySource};`, scopeContext);
assert.ok(scopeContext.frameReady(), 'a visible, complete collage is ready');
scopeContext.resetScopedDataCaches();
assert.equal(scopeContext.DATA.recent, null);
assert.equal(viewsAttrs['aria-hidden'], 'true');
assert.equal(scopeContext.frameReady(), false, 'a hidden old scope cannot be captured');
scopeContext.setEducatorDataLoading(false);
assert.equal(scopeContext.frameReady(), false, 'showing the view cannot restore the obsolete token');
console.log('collage readiness tests passed');
