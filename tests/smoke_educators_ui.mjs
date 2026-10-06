#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../avian/frontend/styles.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../avian/frontend/index.html', import.meta.url), 'utf8');

function functionSource(name, from = 0) {
  const start = apt.indexOf(`function ${name}(`, from);
  assert.notEqual(start, -1, `${name} is present`);
  const body = apt.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = body; index < apt.length; index += 1) {
    const char = apt[index];
    const next = apt[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return apt.slice(start, index + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const c1 = `c_${'1'.repeat(32)}`;
const c2 = `c_${'2'.repeat(32)}`;
const f1 = `f_${'a'.repeat(32)}`;

const scopeContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  effectiveEducatorScope: { id: c1 },
  explicitEducatorScope: null,
  encodeURIComponent,
};
vm.createContext(scopeContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('validEducatorScopeKey'),
  functionSource('educatorScopeId'),
  functionSource('educatorRequestScopeId'),
  functionSource('appendEducatorScope'),
  functionSource('birdApiUrl'),
  functionSource('mediaApiUrl'),
].join('\n'), scopeContext);

assert.equal(scopeContext.educatorRequestScopeId(), '',
  'an automatic dataset scope does not become a sticky request preference');
assert.match(scopeContext.mediaApiUrl('recording', { file: 'clip.mp3', detection: 71 }),
  new RegExp(`recording\\.php\\?file=clip\\.mp3&detection=71&edu=${c1}$`),
  'media binds to the exact effective capture and detection row');
scopeContext.explicitEducatorScope = { id: f1 };
assert.equal(scopeContext.educatorRequestScopeId(), f1, 'a saved folder is explicit on top-level data requests');
assert.match(scopeContext.birdApiUrl('recent', { hours: 1000000 }, f1),
  new RegExp(`birdnet-api\\.php\\?action=recent&hours=1000000&edu=${f1}$`),
  'BirdNET requests carry the selected folder scope');
assert.equal(scopeContext.appendEducatorScope('/stream', 'bad'), '/stream', 'invalid scope IDs are never emitted');
scopeContext.explicitEducatorScope = null;
scopeContext.effectiveEducatorScope = { id: 'active', automatic: true };
assert.equal(scopeContext.mediaApiUrl('recording', { detection: 71 }),
  './avian/api/recording.php?detection=71&edu=active',
  'forwarded automatic media carries the exact row and fail-closed active marker');
assert.equal(scopeContext.educatorRequestScopeId(), 'active',
  'automatic refreshes resolve the current capture instead of pinning a private ID');

let deferredRefreshes = 0;
let deferredResets = 0;
let deferredPostcardScrubs = 0;
let persistedScopeReads = 0;
let deferredScopeClears = 0;
const deferredContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  EDUCATOR_SCOPE_KEY: 'scope',
  EDUCATOR_SCOPE_PARAM: 'edu',
  educatorScopesAuthorized: false,
  educatorScopeShared: false,
  educatorScopeBlocked: false,
  deferredEducatorScope: null,
  explicitEducatorScope: null,
  effectiveEducatorScope: null,
  educatorScopeGeneration: 0,
  encodeURIComponent,
  readLS() {
    persistedScopeReads += 1;
    return JSON.stringify({ id: c1, kind: 'capture', label: 'Sensitive Biology Period' });
  },
  writeLS() {},
  removeLS(key) { if (key === 'scope') deferredScopeClears += 1; },
  location: { search: '', href: 'http://station.local/' },
  URLSearchParams,
  URL,
  window: { history: { replaceState() {} } },
  history: { state: null, replaceState() {} },
  syncEducatorScopePill() {},
  scrubEducatorScopeSurface() { deferredPostcardScrubs += 1; },
  resetScopedDataCaches() { deferredResets += 1; },
  refreshAll() { deferredRefreshes += 1; },
};
vm.createContext(deferredContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('validEducatorScopeKey'),
  functionSource('normalizeEducatorScope'),
  functionSource('loadEducatorScope'),
  functionSource('educatorScopeUrlState'),
  functionSource('syncEducatorScopeUrl'),
  functionSource('educatorScopeId'),
  functionSource('educatorRequestScopeId'),
  functionSource('appendEducatorScope'),
  functionSource('birdApiUrl'),
  functionSource('educatorScopeLabel'),
  functionSource('applyEducatorScope'),
  functionSource('authorizeEducatorScopes'),
  functionSource('suspendEducatorScopes'),
].join('\n'), deferredContext);
assert.equal(persistedScopeReads, 0, 'a locked fresh boot does not read its private saved scope');
assert.equal(deferredContext.educatorScopeLabel(deferredContext.effectiveEducatorScope), '',
  'a locked fresh boot cannot render a private saved label');
assert.equal(deferredContext.birdApiUrl('recent', { hours: 24 }),
  './avian/api/birdnet-api.php?action=recent&hours=24',
  'a locked fresh boot cannot issue a private scoped request');
deferredContext.authorizeEducatorScopes();
assert.equal(persistedScopeReads, 0, 'an authenticated page without ?edu does not revive a stale private preference');
assert.equal(deferredContext.explicitEducatorScope, null, 'missing ?edu is the canonical station-wide selection');
deferredContext.educatorScopesAuthorized = true;
deferredContext.applyEducatorScope({ id: c1, label: 'Sensitive Biology Period' }, { refresh: false });
assert.equal(deferredContext.explicitEducatorScope.id, c1, 'an authenticated row selection becomes the explicit capture');
const scrubsBeforeSuspend = deferredPostcardScrubs;
deferredContext.suspendEducatorScopes({ refresh: true });
assert.equal(deferredPostcardScrubs, scrubsBeforeSuspend + 1,
  'the common auth-suspension path closes any open saved-scope postcard');
assert.equal(deferredContext.explicitEducatorScope.id, c1, 'an auth loss preserves the anonymous URL capability');
assert.equal(deferredContext.explicitEducatorScope.label, '', 'an auth loss strips the private saved-period name');
assert.equal(deferredContext.effectiveEducatorScope.id, c1, 'the public scoped dataset remains selected after auth loss');
assert.equal(deferredContext.educatorRequestScopeId(), c1, 'the public refetch retains only the opaque capability');
assert.equal(deferredScopeClears, 1, 'auth loss removes the saved scope preference while retaining its URL capability');
assert.equal(deferredResets > 0 && deferredRefreshes > 0, true,
  'an auth loss blanks private data and refreshes the safe public dataset');
deferredContext.explicitEducatorScope = null;
deferredContext.effectiveEducatorScope = null;
deferredContext.suspendEducatorScopes({ refresh: false });
assert.equal(deferredScopeClears, 2,
  'auth loss removes a stale saved scope preference even when no scope is active');
assert.match(functionSource('showAdminLocked'), /suspendEducatorScopes\(\{ refresh: true \}\)/,
  'logout, idle expiry, and session replacement suspend private scopes before showing the lock');
assert.match(functionSource('renderMenu'), /if \(educatorsAvailable\) \{[\s\S]*authorizeEducatorScopes\(\)/,
  'only the authenticated native menu response authorizes private preference restoration');

let authLossStorageClears = 0;
let authLossRefreshes = 0;
let authLossRenderLabel = '';
const authLossSanitizeContext = {
  EDUCATOR_SCOPE_KEY: 'scope',
  educatorScopeGeneration: 6,
  educatorScopesAuthorized: true,
  educatorScopeShared: true,
  educatorScopeBlocked: false,
  deferredEducatorScope: { id: c1, label: 'Private period' },
  explicitEducatorScope: { id: c1, label: 'Private period', revision: 8, state_key: 'a'.repeat(24), state_revision: 9 },
  effectiveEducatorScope: { id: c1, label: 'Private period', revision: 8, state_key: 'a'.repeat(24), state_revision: 9 },
  DATA: {
    recent: { educator_scope: { id: c1, label: 'Private period', revision: 8 } },
    stats: { educator_scope: { id: c1, label: 'Private period', revision: 8 } },
  },
  STATS_DAYS: 3,
  STATS: { detPerDay: [1], specPerDay: [1], byHour: [1] },
  speciesTotals: { private: 1 },
  SPECIES_CACHE: { private: {} },
  _decodedCache: { private: {} },
  hourlyDate: '2026-09-01',
  document: {
    body: { classList: { toggle() {} } },
    getElementById() { return null; },
  },
  closeEducatorTransientUi() {},
  requestDisplayMode() {},
  suspendEducatorFolderPreferences() {},
  scrubEducatorScopeSurface() {},
  removeLS(key) { assert.equal(key, 'scope'); authLossStorageClears += 1; },
  syncEducatorScopePill() {},
  renderCollageFromData() { authLossRenderLabel = authLossSanitizeContext.effectiveEducatorScope.label; },
  renderStatsContext() {},
  renderAtlas() {},
  stopAtlasCardAudio() {},
  stopModalAudio() {},
  refreshAll() { authLossRefreshes += 1; },
};
vm.createContext(authLossSanitizeContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeId'),
  functionSource('setEducatorDataLoading'),
  functionSource('resetScopedDataCaches'),
  functionSource('suspendEducatorScopes'),
].join('\n'), authLossSanitizeContext);
authLossSanitizeContext.suspendEducatorScopes({ refresh: true });
assert.equal(authLossSanitizeContext.educatorScopeGeneration, 7,
  'auth loss invalidates every in-flight admin-shaped scope response');
assert.equal(authLossSanitizeContext.explicitEducatorScope.id, c1,
  'auth loss retains the anonymous opaque capability');
assert.equal(authLossSanitizeContext.explicitEducatorScope.label, '',
  'auth loss removes the saved-period label from live scope state');
assert.equal(authLossSanitizeContext.explicitEducatorScope.revision, 0,
  'auth loss removes the private revision from live scope state');
assert.equal(authLossSanitizeContext.deferredEducatorScope, null,
  'auth loss removes the deferred admin-shaped scope object');
assert.equal(Object.values(authLossSanitizeContext.DATA).every((value) => value === null), true,
  'auth loss removes private educator metadata from every cached dataset');
assert.equal(Object.keys(authLossSanitizeContext.speciesTotals).length, 0,
  'auth loss clears derived private bird totals before public refetch');
assert.equal(authLossStorageClears, 1, 'auth loss removes the private browser preference');
assert.equal(authLossRenderLabel, '', 'the synchronous scrub never repaints the private scope name');
assert.equal(authLossRefreshes, 1, 'auth loss refetches the same capability through the public response shape');

const urlScopeContext = {
  EDUCATOR_SCOPE_PARAM: 'edu',
  location: { search: `?edu=${c1}` },
  URLSearchParams,
};
vm.createContext(urlScopeContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeUrlState'),
].join('\n'), urlScopeContext);
assert.equal(urlScopeContext.educatorScopeUrlState().scope.id, c1,
  'one exact capture capability is accepted from the URL');
urlScopeContext.location.search = '';
assert.equal(urlScopeContext.educatorScopeUrlState().present, false,
  'missing ?edu is an explicit station-wide route, not a localStorage fallback');
for (const query of ['?edu=', '?edu=bad', `?edu=${c1}&edu=${c1}`, `?edu=${c1}&edu=${f1}`]) {
  urlScopeContext.location.search = query;
  const parsed = urlScopeContext.educatorScopeUrlState();
  assert.equal(parsed.present, true, `${query} remains an explicit scoped-route attempt`);
  assert.equal(parsed.valid, false, `${query} fails closed instead of selecting unrelated data`);
}

const initialScopeContext = {
  EDUCATOR_SCOPE_PARAM: 'edu',
  educatorScopeBlocked: false,
  educatorScopeShared: false,
  explicitEducatorScope: null,
  effectiveEducatorScope: null,
  location: { search: `?edu=${f1}` },
  URLSearchParams,
  loading: false,
  setEducatorDataLoading(value) { initialScopeContext.loading = value; },
  syncEducatorScopePill() {},
  blockEducatorScope() { initialScopeContext.educatorScopeBlocked = true; },
};
vm.createContext(initialScopeContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeUrlState'),
  functionSource('initializeEducatorScopeFromUrl'),
].join('\n'), initialScopeContext);
assert.equal(initialScopeContext.initializeEducatorScopeFromUrl(), true,
  'a shared URL scope initializes without an admin session');
assert.equal(initialScopeContext.effectiveEducatorScope.id, f1,
  'the shared folder is effective before the first data request');
assert.equal(initialScopeContext.loading, true,
  'the shared route hides station-wide surfaces until its transactional fetch completes');
const initialFetchMarker = apt.indexOf('// Kick off the initial fetch.');
assert.ok(apt.indexOf('initializeEducatorScopeFromUrl();') < initialFetchMarker,
  'URL scope initialization runs before the initial refresh');
assert.match(apt, /if \(readHash\(\) && !educatorScopeBlocked\)/,
  'a #sci route cannot open while a malformed or unavailable scope is blocked');
assert.match(functionSource('openDetailModal'), /querySelectorAll\('\.bird-card\[data-sci\]'\)[\s\S]*candidate\.dataset\.sci === sci/,
  'deep-linked species selection uses exact data equality instead of selector interpolation');
assert.doesNotMatch(functionSource('openDetailModal'), /querySelector\([^\n]*sci|CSS\.escape/,
  'malformed species hash text cannot alter the postcard selector');
const hashContext = { location: { hash: '#sci=Corvus%20brachyrhynchos' }, decodeURIComponent };
vm.createContext(hashContext);
vm.runInContext(functionSource('readHash'), hashContext);
assert.equal(hashContext.readHash(), 'Corvus brachyrhynchos', 'a valid scoped postcard hash decodes normally');
hashContext.location.hash = '#sci=%E0%A4%A';
assert.equal(hashContext.readHash(), null, 'a malformed scoped postcard hash fails closed without throwing');
assert.match(html, /<meta name="referrer" content="no-referrer">/,
  'shared capability URLs are not sent in outbound referrers');

const titleContext = {
  VIEW_TITLES: ['Your Birds', 'Stats', 'Atlas'],
  effectiveEducatorScope: { id: c1, label: 'Period 3' },
  educatorScopeId() { return c1; },
  educatorScopeRouteActive() { return true; },
  educatorScopeLabel(scope) { return scope.label; },
};
vm.createContext(titleContext);
vm.runInContext(functionSource('titleForView'), titleContext);
assert.equal(titleContext.titleForView(0), 'Avian Visitors',
  'the scoped Collage heading keeps the public product title');
assert.equal(titleContext.titleForView(2), 'Atlas', 'scope copy does not replace the Atlas heading');

const titleClasses = new Set();
let titleTimerId = 0;
const titleTimers = new Map();
const staleTitleContext = {
  VIEW_TITLES: ['Heard Recently', 'Heard Recently', 'Avian Atlas'],
  effectiveEducatorScope: { id: c1, label: 'Sensitive Biology Period' },
  staticTitle: { textContent: 'Heard Recently' },
  staticHead: {
    offsetWidth: 100,
    classList: {
      add(value) { titleClasses.add(value); },
      remove(value) { titleClasses.delete(value); },
    },
  },
  titleSwapTimer: 0,
  titleSwapGeneration: 0,
  educatorScopeId() {
    return staleTitleContext.effectiveEducatorScope ? staleTitleContext.effectiveEducatorScope.id : '';
  },
  educatorScopeRouteActive() { return !!staleTitleContext.effectiveEducatorScope; },
  educatorScopeLabel(scope) { return scope.label; },
  setTimeout(callback) {
    titleTimerId += 1;
    titleTimers.set(titleTimerId, callback);
    return titleTimerId;
  },
  clearTimeout(id) { titleTimers.delete(id); },
};
vm.createContext(staleTitleContext);
vm.runInContext([
  functionSource('titleForView'),
  functionSource('setTitleForView'),
].join('\n'), staleTitleContext);
staleTitleContext.setTitleForView(0);
const stalePrivateTitle = titleTimers.get(staleTitleContext.titleSwapTimer);
staleTitleContext.effectiveEducatorScope = null;
staleTitleContext.setTitleForView(0);
stalePrivateTitle();
assert.equal(staleTitleContext.staticTitle.textContent, 'Heard Recently',
  'a pending private scope title cannot repaint after an auth loss clears the scope');
assert.equal(titleClasses.has('swap-out'), false,
  'canceling a stale title swap restores the visible safe heading immediately');
staleTitleContext.staticTitle.textContent = 'Avian Visitors';
staleTitleContext.effectiveEducatorScope = null;
staleTitleContext.setTitleForView(0, { immediate: true });
assert.equal(staleTitleContext.staticTitle.textContent, 'Heard Recently',
  'an already-painted scoped title is scrubbed synchronously on auth loss');
assert.equal(staleTitleContext.titleSwapTimer, 0,
  'the synchronous auth-loss scrub leaves no private title callback queued');
assert.match(functionSource('suspendEducatorScopes'), /syncEducatorScopePill\(\{ immediateTitle: true \}\)/,
  'scope suspension requests the immediate title scrub path');
assert.match(apt, /var titlePeriod = educatorScopeId\(\)[\s\S]*educatorScopeLabel\(effectiveEducatorScope\)/,
  'Collage card titles use the selected scope label');
assert.match(apt, /var period = educatorScopeId\(\)[\s\S]*educatorScopeLabel\(effectiveEducatorScope\)/,
  'Collage hover copy uses the selected scope label');

const scopePillNodes = { returnToEducators: { hidden: true } };
const scopePillContext = {
  effectiveEducatorScope: { id: c1, label: 'Period 3', automatic: false },
  educatorScopeBlocked: false,
  currentView: 0,
  document: {
    body: { classList: { toggle() {} } },
    getElementById(id) { return scopePillNodes[id]; },
  },
  educatorScopeRouteActive() {
    return !!scopePillContext.effectiveEducatorScope || scopePillContext.educatorScopeBlocked;
  },
  setTitleForView() {},
};
vm.createContext(scopePillContext);
vm.runInContext(functionSource('syncEducatorScopePill'), scopePillContext);
scopePillContext.syncEducatorScopePill();
assert.equal(scopePillNodes.returnToEducators.hidden, false,
  'a scoped public view exposes the terse back-to-Educators component');
scopePillContext.effectiveEducatorScope = null;
scopePillContext.syncEducatorScopePill();
assert.equal(scopePillNodes.returnToEducators.hidden, true,
  'the Educators return control withdraws on the station-wide route');
scopePillContext.educatorScopeBlocked = true;
scopePillContext.syncEducatorScopePill();
assert.equal(scopePillNodes.returnToEducators.hidden, false,
  'an unavailable capability retains a safe route back to Educators');
assert.doesNotMatch(html, /educatorScopeLabel|educator-scope-pill/,
  'the public header contains no private folder or listening-period name');
assert.match(html, /id="returnToEducators" href="#admin=educators" aria-label="back to educators"[\s\S]*>\s*educators\s*<\/a>/,
  'the scoped back control exactly mirrors the terse collage component');

function backRouteContext(accessState, available) {
  const order = [];
  const password = {};
  const context = {
    educatorAdminRouteFocus: false,
    educatorScopeBlocked: true,
    pendingAdminSection: null,
    adminAccessState: accessState,
    educatorsAvailable: available,
    location: { hash: '' },
    document: { getElementById(id) { return id === 'lockPass' ? password : null; } },
    applyEducatorScope(value, options) { order.push(['scope', value, options]); },
    openAdmin(section) { order.push(['admin', section]); },
    showAdminLocked(message, recovery, reveal) { order.push(['locked', message, recovery, reveal]); },
    openDd() { order.push(['drawer']); },
    focusEl(target) { order.push(['focus', target]); },
    setTimeout(callback) { callback(); return 1; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('routeToEducators'), context);
  context.order = order;
  context.password = password;
  return context;
}
const lockedBackRoute = backRouteContext('locked', false);
let backPrevented = 0;
let backPropagationStops = 0;
lockedBackRoute.routeToEducators({
  preventDefault() { backPrevented += 1; },
  stopPropagation() { backPropagationStops += 1; },
});
assert.equal(backPrevented, 1, 'Back owns the route so a same-hash click cannot become a no-op');
assert.equal(backPropagationStops, 1,
  'Back cannot bubble into the global outside-click drawer closer');
assert.equal(lockedBackRoute.location.hash, '#admin=educators',
  'Back records the intended Educators route after leaving the shared scope');
assert.equal(lockedBackRoute.pendingAdminSection, 'educators',
  'a protected anonymous Back route survives until authentication completes');
assert.equal(JSON.stringify(lockedBackRoute.order[0]), JSON.stringify(['scope', null, { force: true, refresh: true, immediateTitle: true }]),
  'Back removes the capability before exposing admin navigation');
assert.deepEqual(lockedBackRoute.order[1], ['locked', '', false, true],
  'a locked Back route opens the ordinary unlock surface');
const unlockedBackRoute = backRouteContext('unlocked', true);
unlockedBackRoute.routeToEducators({ preventDefault() {}, stopPropagation() {} });
assert.deepEqual(unlockedBackRoute.order[1], ['admin', 'educators'],
  'an already authorized Back route opens Educators immediately');
const checkingBackRoute = backRouteContext('checking', false);
checkingBackRoute.routeToEducators({ preventDefault() {}, stopPropagation() {} });
assert.deepEqual(checkingBackRoute.order.slice(1), [['drawer'], ['focus', checkingBackRoute.password]],
  'a Back click during the auth probe exposes a deterministic visible unlock destination');

let protectedDrawerOpen = false;
let protectedEventStopped = false;
const protectedPassword = {};
let protectedFocus = null;
const protectedBackContext = {
  educatorAdminRouteFocus: false,
  educatorScopeBlocked: false,
  pendingAdminSection: null,
  adminAccessState: 'locked',
  educatorsAvailable: false,
  location: { search: `?edu=${f1}`, hash: '' },
  document: { getElementById(id) { return id === 'lockPass' ? protectedPassword : null; } },
  applyEducatorScope(value) {
    assert.equal(value, null);
    protectedBackContext.location.search = '';
  },
  openAdmin() {},
  showAdminLocked() {
    protectedDrawerOpen = true;
    protectedFocus = protectedPassword;
  },
  openDd() { protectedDrawerOpen = true; },
  focusEl(target) { protectedFocus = target; },
  setTimeout(callback) { callback(); return 1; },
};
vm.createContext(protectedBackContext);
vm.runInContext(functionSource('routeToEducators'), protectedBackContext);
protectedBackContext.routeToEducators({
  preventDefault() {},
  stopPropagation() { protectedEventStopped = true; },
});
// Mirror the document outside-click listener that receives the same click
// only when the control handler allows it to bubble.
if (!protectedEventStopped) protectedDrawerOpen = false;
assert.equal(protectedBackContext.location.search, '',
  'protected Back removes the shared capability query');
assert.equal(protectedBackContext.location.hash, '#admin=educators',
  'protected Back records the pending Educators route');
assert.equal(protectedDrawerOpen, true,
  'the password drawer remains open after the complete click dispatch');
assert.equal(protectedFocus, protectedPassword,
  'the protected Back route leaves focus on the password field');

const batchContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  educatorScopeGeneration: 4,
  effectiveEducatorScope: {
    id: 'active', automatic: true, revision: 1,
    state_key: 'a'.repeat(24), state_revision: 4,
  },
};
vm.createContext(batchContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeId'),
  functionSource('educatorScopeFromPayload'),
  functionSource('educatorBatchIsCurrent'),
].join('\n'), batchContext);
const privateAutomatic = batchContext.normalizeEducatorScope({
  kind: 'capture', revision: 6, status: 'running', automatic: true,
});
assert.equal(privateAutomatic.id, 'active', 'forwarded automatic scope receives one browser-internal identity');
assert.equal(privateAutomatic.automatic, true, 'forwarded scope stays automatic and non-clearable');
const autoScope = {
  kind: 'capture', automatic: true, revision: 1, status: 'running',
  state_key: 'a'.repeat(24), state_revision: 4,
};
const request = {
  scopeId: 'active', generation: 4, revision: 1,
  stateKey: 'a'.repeat(24), stateRevision: 4,
};
assert.equal(batchContext.educatorBatchIsCurrent([
  { educator_scope: autoScope },
  { educator_scope: autoScope },
], request), true, 'one automatic scope can be committed atomically');
assert.equal(batchContext.educatorBatchIsCurrent([
  { educator_scope: null },
  { educator_scope: autoScope },
], request), false, 'a Stop race cannot mix global and capture data');
assert.equal(batchContext.educatorBatchIsCurrent([
  { educator_scope: autoScope },
  { educator_scope: { ...autoScope, state_key: 'b'.repeat(24), state_revision: 5 } },
], request), false, 'a folder or active transition cannot mix two revisions under one scope key');
batchContext.educatorScopeGeneration = 5;
assert.equal(batchContext.educatorBatchIsCurrent([
  { educator_scope: autoScope },
], request), false, 'a previous automatic capture cannot overwrite a newer one');

let queuedScopeRefresh = null;
const adoptContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  educatorScopeGeneration: 8,
  effectiveEducatorScope: null,
  explicitEducatorScope: null,
  writeLS() {},
  EDUCATOR_SCOPE_KEY: 'scope',
  syncEducatorScopePill() {},
  resetScopedDataCaches() { adoptContext.educatorScopeGeneration += 1; },
  setTimeout(callback) { queuedScopeRefresh = callback; },
  refreshAllCalls: 0,
  refreshAll() { adoptContext.refreshAllCalls += 1; },
};
vm.createContext(adoptContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeFromPayload'),
  functionSource('adoptEducatorScope'),
].join('\n'), adoptContext);
const firstAutomatic = {
  kind: 'capture', automatic: true, revision: 1, status: 'running',
  state_key: 'a'.repeat(24), state_revision: 4,
};
assert.equal(adoptContext.adoptEducatorScope({ educator_scope: firstAutomatic }, '', 8), false,
  'the first automatic capture invalidates the unscoped batch before it paints');
assert.equal(adoptContext.educatorScopeGeneration, 9, 'automatic adoption advances the data generation');
assert.equal(adoptContext.effectiveEducatorScope.id, 'active', 'automatic adoption binds one non-private rendered identity');
queuedScopeRefresh();
assert.equal(adoptContext.refreshAllCalls, 1, 'automatic adoption refetches one coherent full-period dataset');
assert.equal(adoptContext.adoptEducatorScope({ educator_scope: {
  ...firstAutomatic, revision: 2, status: 'paused', state_key: 'b'.repeat(24), state_revision: 5,
} }, 'active', 9), false, 'same-ID pause and replacement metadata invalidates the prior automatic dataset');
assert.equal(adoptContext.educatorScopeGeneration, 10, 'automatic metadata transition advances the generation');

let sharedAdoptWrites = 0;
const sharedAdoptScope = {
  id: c1, kind: 'capture', automatic: false, revision: 4, status: 'stopped',
  state_key: 'c'.repeat(24), state_revision: 9,
};
const sharedAdoptContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  EDUCATOR_SCOPE_KEY: 'scope',
  educatorScopeGeneration: 21,
  educatorScopesAuthorized: false,
  effectiveEducatorScope: { ...sharedAdoptScope },
  explicitEducatorScope: { ...sharedAdoptScope },
  educatorScopeShared: true,
  writeLS() { sharedAdoptWrites += 1; },
  syncEducatorScopePill() {},
  resetScopedDataCaches() {},
  setTimeout() {},
};
vm.createContext(sharedAdoptContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeFromPayload'),
  functionSource('adoptEducatorScope'),
].join('\n'), sharedAdoptContext);
assert.equal(sharedAdoptContext.adoptEducatorScope({
  educator_scope: {
    kind: 'capture', automatic: false, revision: 4, status: 'stopped',
    state_key: 'c'.repeat(24), state_revision: 9,
  },
}, c1, 21), true, 'an anonymous shared response can validate its current capability');
assert.equal(sharedAdoptWrites, 0,
  'an anonymous shared full response never persists its bearer capability');
sharedAdoptContext.educatorScopesAuthorized = true;
sharedAdoptContext.adoptEducatorScope({
  educator_scope: {
    kind: 'capture', automatic: false, revision: 4, status: 'stopped',
    state_key: 'c'.repeat(24), state_revision: 9,
  },
}, c1, 21);
assert.equal(sharedAdoptWrites, 1,
  'an authenticated Educators response may refresh its browser-local selection metadata');
sharedAdoptContext.educatorScopesAuthorized = false;
sharedAdoptContext.adoptEducatorScope({
  educator_scope: {
    kind: 'capture', automatic: false, revision: 4, status: 'stopped',
    state_key: 'c'.repeat(24), state_revision: 9,
  },
}, c1, 21);
assert.equal(sharedAdoptWrites, 1,
  'auth loss prevents a later full response from restoring the removed capability');

const historicalContext = { educatorScopeId() { return c1; } };
vm.createContext(historicalContext);
vm.runInContext(functionSource('backfillDaily'), historicalContext);
const historical = historicalContext.backfillDaily([
  { date: '2022-03-12', detections: 2, species: 1 },
  { date: '2022-03-14', detections: 9, species: 4 },
], 3);
assert.deepEqual(JSON.parse(JSON.stringify(historical)), [
  { detections: 2, species: 1 },
  { detections: 0, species: 0 },
  { detections: 9, species: 4 },
], 'an old saved capture anchors charts to its returned dates');

const renameContext = {
  educatorEditing: null,
  adminAttr(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  adminEsc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
};
vm.createContext(renameContext);
vm.runInContext(functionSource('educatorRenameHtml'), renameContext);
const maliciousName = '<img src=x onerror=alert(1)>';
let rename = renameContext.educatorRenameHtml('capture', { id: c1, name: maliciousName });
assert.doesNotMatch(rename, /<img/, 'capture names are escaped before rendering');
assert.match(rename, /data-rename-form="capture"[\s\S]*data-rename-cancel/,
  'rename is one inline form reached from the row action menu or F2');
assert.doesNotMatch(rename, /Double-click|dblclick/, 'rename does not compete with click-to-view');
renameContext.educatorEditing = { kind: 'capture', id: c1 };
rename = renameContext.educatorRenameHtml('capture', { id: c1, name: 'Period 2' });
assert.match(rename, /data-rename-form="capture"[^>]*>/, 'active rename exposes an inline form');
assert.doesNotMatch(rename, /data-rename-form="capture"[^>]* hidden/, 'active rename form is visible');

const activeContext = {
  educatorEditing: null,
  educatorStartDraft: 'Biology 2',
  adminAttr: String,
  adminEsc: String,
  educatorRenameHtml: renameContext.educatorRenameHtml,
  educatorMoreButton(kind, item, hidden) {
    return `<button data-educator-menu-kind="${kind}" data-educator-menu-id="${item.id}"${hidden ? ' hidden' : ''}></button>`;
  },
  educatorDurationSeconds() { return 65; },
  educatorDurationLabel() { return '1:05'; },
};
vm.createContext(activeContext);
vm.runInContext(functionSource('educatorActiveHtml'), activeContext);
const startMarkup = activeContext.educatorActiveHtml(null);
assert.match(startMarkup, /id="educatorStart"[\s\S]*New listening period[\s\S]*id="educatorStartName"[\s\S]*value="Biology 2"/,
  'idle state offers one named listening-period form with its preserved draft');
assert.match(startMarkup, /placeholder="session name"[\s\S]*type="submit" data-educator-start-submit data-has-name="true" aria-label="Start new listening period"[\s\S]*<svg/,
  'the form exposes a compact accessible arrow submit control');
activeContext.educatorStartDraft = '';
const blankStartMarkup = activeContext.educatorActiveHtml(null);
assert.match(blankStartMarkup, /placeholder="session name"[\s\S]*data-has-name="false" aria-label="Start new listening period with date and time"/,
  'blank Start remains available and explains the server date and time default');
assert.doesNotMatch(blankStartMarkup, /data-educator-start-submit[^>]*disabled/,
  'the subtle blank arrow remains a real submit control');
const running = activeContext.educatorActiveHtml({ id: c1, name: 'Biology', status: 'running', folder_id: null });
assert.match(running, /data-educator-action="pause"/, 'running state offers Pause');
assert.match(running, /data-educator-action="stop"/, 'running state offers Stop');
assert.match(running, /aria-label="Pause Biology"/, 'Pause names its active listening period');
assert.match(running, /aria-label="Stop Biology"/, 'Stop names its active listening period');
assert.match(running, /data-educator-menu-kind="active"/, 'the active period exposes the same compact action menu');
assert.doesNotMatch(running, /<select|data-move-capture/, 'the active card has no permanently visible folder select');
const paused = activeContext.educatorActiveHtml({ id: c1, name: 'Biology', status: 'paused', folder_id: null });
assert.match(paused, /data-educator-action="resume"/, 'paused state offers Resume');

const normalizeContext = {};
vm.createContext(normalizeContext);
vm.runInContext([functionSource('validEducatorId'), functionSource('normalizeEducatorState')].join('\n'), normalizeContext);
const longName = 'x'.repeat(120);
const normalized = normalizeContext.normalizeEducatorState({
  ok: true,
  enabled: true,
  profile_epoch: 7,
  state_revision: 4,
  active: null,
  captures: [{
    id: c1,
    name: longName,
    status: 'stopped',
    folder_id: null,
    revision: 2,
    segment_count: 4,
    duration_seconds: 723,
    detection_count: null,
    species_count: null,
  }],
  folders: [],
  capture_page: { total: 1, more: false, next_cursor: null },
});
assert.equal(normalized.profile_epoch, '7', 'numeric profile epochs normalize to one stable comparison type');
assert.equal(normalized.captures[0].name.length, 80, 'capture names follow the backend 80-character limit');
assert.equal(normalized.captures[0].duration_seconds, 723, 'compact capture rows retain exact duration');
assert.equal(normalized.captures[0].detection_count, null,
  'an intentionally unavailable saved detection count remains unknown rather than becoming zero');
assert.equal(normalized.captures[0].species_count, null,
  'an intentionally unavailable saved species count remains unknown rather than becoming zero');
const normalizedActive = normalizeContext.normalizeEducatorState({
  ok: true,
  enabled: true,
  profile_epoch: '7',
  state_revision: 5,
  active: {
    id: c1,
    name: 'Live',
    status: 'running',
    revision: 3,
    segments: [{ id: 1, started_at: '2026-09-01T09:00:00-07:00', stopped_at: '' }],
  },
  captures: [{ id: c1, name: 'Live', status: 'running', revision: 3, segment_count: 1, duration_seconds: 1 }],
  folders: [],
  capture_page: { total: 1, more: false, next_cursor: null },
});
assert.equal(normalizedActive.captures[0].segments.length, 1,
  'the full active capture replaces its compact matching page row');

const stateContext = {
  educatorState: null,
  educatorCaptureArchiveRevision: null,
  educatorCaptureArchive: Object.create(null),
  educatorCaptureOrder: [],
  educatorCapturePage: { total: 0, more: false, next_cursor: null },
  educatorEditing: null,
  educatorPendingState: null,
  educatorAcceptedSignature: '',
  explicitEducatorScope: { id: `c_${'9'.repeat(32)}`, kind: 'capture', automatic: false },
  effectiveEducatorScope: { id: `c_${'9'.repeat(32)}`, kind: 'capture', automatic: false },
  applyCalls: [],
  window: {},
  normalizeEducatorState(value) { return value; },
  resetEducatorCaptureArchive() {
    stateContext.educatorCaptureArchive = Object.create(null);
    stateContext.educatorCaptureOrder = [];
    stateContext.educatorCapturePage = { total: 0, more: false, next_cursor: null };
    stateContext.educatorCaptureArchiveRevision = null;
  },
  mergeEducatorCaptures(captures, page) {
    stateContext.educatorCapturePage = page;
    stateContext.educatorCaptureOrder = captures.map((capture) => capture.id);
    return captures;
  },
  educatorScopeForEntity(entity) {
    return {
      id: entity.id, kind: entity.id.startsWith('f_') ? 'folder' : 'capture',
      label: entity.name, automatic: false, revision: entity.revision || 0,
      state_key: '', state_revision: 0, status: entity.status || '',
    };
  },
  normalizeEducatorScope(scope) {
    if (!scope.automatic) return scope;
    return { ...scope, id: 'active', entity_id: scope.id };
  },
  applyEducatorScope(value, options = {}) {
    stateContext.applyCalls.push({ value, options });
    stateContext.effectiveEducatorScope = value;
    if (options.explicit !== false) stateContext.explicitEducatorScope = value;
  },
  syncEducatorScopePill() {},
  canonicalizeEducatorExpandedFolders() {},
  educatorStateSignature(value) { return `${value.profile_epoch}|${value.state_revision}`; },
};
vm.createContext(stateContext);
vm.runInContext(functionSource('acceptEducatorState'), stateContext);
const statePage = (revision, active, captures = active ? [active] : []) => ({
  profile_epoch: '7',
  state_revision: revision,
  active,
  captures,
  folders: [],
  capture_page: { total: captures.length, more: false, next_cursor: null },
});
stateContext.acceptEducatorState(statePage(1, null, [{ id: c1, name: 'Recent', revision: 1 }]));
assert.equal(stateContext.explicitEducatorScope.id, `c_${'9'.repeat(32)}`,
  'an explicit older capture survives absence from the bounded head page');
assert.equal(stateContext.applyCalls.length, 0, 'paged absence is not treated as authoritative deletion');
stateContext.explicitEducatorScope = null;
stateContext.effectiveEducatorScope = { id: 'active', entity_id: c1, automatic: true };
stateContext.acceptEducatorState(statePage(2, null, []));
assert.equal(stateContext.effectiveEducatorScope, null, 'a stopped automatic capture clears to the global dataset');
const newlyActive = { id: c2, name: 'New period', revision: 1, status: 'running' };
stateContext.acceptEducatorState(statePage(3, newlyActive));
assert.equal(stateContext.effectiveEducatorScope.id, 'active', 'a later active capture becomes the new automatic dataset');
assert.equal(stateContext.effectiveEducatorScope.entity_id, c2, 'the controller still distinguishes replacement captures internally');
assert.equal(stateContext.effectiveEducatorScope.automatic, true, 'the new active capture remains non-sticky');

const applyContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  EDUCATOR_SCOPE_KEY: 'scope',
  effectiveEducatorScope: {
    id: f1, automatic: false, revision: 1, status: 'saved',
    state_key: 'a'.repeat(24), state_revision: 1, entity_id: '',
  },
  explicitEducatorScope: { id: f1 },
  deferredEducatorScope: null,
  educatorScopesAuthorized: true,
  resets: 0,
  refreshes: 0,
  scrubs: 0,
  writeLS() {},
  removeLS() {},
  syncEducatorScopeUrl() {},
  syncEducatorScopePill() {},
  scrubEducatorScopeSurface() { applyContext.scrubs += 1; },
  resetScopedDataCaches() { applyContext.resets += 1; },
  refreshAll() { applyContext.refreshes += 1; },
};
vm.createContext(applyContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeId'),
  functionSource('applyEducatorScope'),
].join('\n'), applyContext);
applyContext.applyEducatorScope({
  id: f1, revision: 2, status: 'saved', state_key: 'b'.repeat(24), state_revision: 2,
});
assert.equal(applyContext.resets, 1, 'moving a period into or out of a selected folder invalidates scoped caches');
assert.equal(applyContext.refreshes, 1, 'the selected folder refetches after its revision advances');
applyContext.explicitEducatorScope = null;
applyContext.effectiveEducatorScope = {
  id: 'active', automatic: true, revision: 3, status: 'running',
  state_key: 'c'.repeat(24), state_revision: 3, entity_id: c1,
};
applyContext.applyEducatorScope({
  id: c1, automatic: true, revision: 4, status: 'paused',
  state_key: 'd'.repeat(24), state_revision: 4,
}, { explicit: false });
assert.equal(applyContext.resets, 2, 'active pause or resume invalidates the prior scoped dataset');
assert.equal(applyContext.refreshes, 2, 'active status transitions trigger one coherent refetch');

applyContext.explicitEducatorScope = { id: f1 };
applyContext.effectiveEducatorScope = { id: f1, automatic: false, revision: 2 };
const scrubsBeforeInvalidation = applyContext.scrubs;
applyContext.applyEducatorScope(null, { refresh: false });
assert.equal(applyContext.scrubs, scrubsBeforeInvalidation + 1,
  'an explicit saved-scope invalidation closes its private postcard before clearing the dataset');

let failScopedRecent = true;
let scopedRenderCommits = 0;
const loadingNodes = {
  views: {
    busy: '', hidden: '',
    setAttribute(name, value) {
      if (name === 'aria-busy') this.busy = value;
      if (name === 'aria-hidden') this.hidden = value;
    },
  },
  educatorDataLoading: { hidden: true },
};
const transactionContext = {
  window: {},
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  EDUCATOR_SCOPE_KEY: 'scope',
  educatorScopeGeneration: 3,
  educatorScopeRequestAttempt: 0,
  educatorScopesAuthorized: true,
  deferredEducatorScope: { id: c1 },
  explicitEducatorScope: { id: c1 },
  effectiveEducatorScope: { id: c1, automatic: false, revision: 1, state_key: '', state_revision: 1, status: 'stopped' },
  educatorDataLoading: false,
  statsContextSeq: 0,
  currentHours: 24,
  hourlyDate: null,
  DATA: {
    stats: { scope: 'A' }, lifelist: { scope: 'A' }, timeseries: { scope: 'A' },
    firstseen: { scope: 'A' }, recent: { scope: 'A' }, statsRecent: { scope: 'A' },
    rhythm: { scope: 'A' }, hourly: { scope: 'A' }, calendar: { scope: 'A' },
  },
  STATS_DAYS: 30,
  STATS: { detPerDay: [1], specPerDay: [1], byHour: [1] },
  speciesTotals: { bird: 1 },
  SPECIES_CACHE: { old: {} },
  _decodedCache: { old: {} },
  document: {
    body: { classList: { toggle() {} } },
    getElementById(id) { return loadingNodes[id] || null; },
  },
  console: { warn() {} },
  writeLS() {},
  removeLS() {},
  syncEducatorScopeUrl() {},
  syncEducatorScopePill() {},
  scrubEducatorScopeSurface() {},
  stopAtlasCardAudio() {},
  stopModalAudio() {},
  scopedFetchJson(action) {
    if (action === 'recent' && failScopedRecent) return Promise.reject(new Error('scope B unavailable'));
    return Promise.resolve({ action, species: [], site_name: action === 'recent' ? 'School' : undefined });
  },
  educatorBatchIsCurrent() { return true; },
  applySiteName() {},
  recomputeDerived() {},
  renderTimeIndependent() { scopedRenderCommits += 1; },
  renderHourly() {},
  updateStatsDateNav() {},
  renderCollageFromData() {},
  renderStatsCalendar() {},
};
vm.createContext(transactionContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeId'),
  functionSource('educatorRequestScopeId'),
  functionSource('educatorScopeRequest'),
  functionSource('setEducatorDataLoading'),
  functionSource('resetScopedDataCaches'),
  functionSource('applyEducatorScope'),
  functionSource('refreshAll'),
].join('\n'), transactionContext);
transactionContext.applyEducatorScope({ id: c2, kind: 'capture', label: 'Scope B', revision: 1 }, { refresh: false });
assert.equal(Object.values(transactionContext.DATA).every((value) => value === null), true,
  'switching scopes clears every prior dataset field before any Scope B response');
assert.equal(transactionContext.educatorDataLoading, true, 'a scope switch marks the bird views as loading');
assert.equal(loadingNodes.views.busy, 'true', 'the blanked bird views expose their loading state');
assert.equal(loadingNodes.views.hidden, 'true', 'private bird views leave the accessibility tree before public refresh');
await transactionContext.refreshAll(true);
assert.equal(Object.values(transactionContext.DATA).every((value) => value === null), true,
  'a rejected recent response cannot commit a resolved lifelist or any partial Scope B data');
assert.equal(scopedRenderCommits, 0, 'a failed scoped batch does not render a partial or all-null dataset');
failScopedRecent = false;
await transactionContext.refreshAll(true);
assert.equal(Object.values(transactionContext.DATA).every((value) => value !== null), true,
  'one fully resolved scoped batch commits every dataset field together');
assert.equal(transactionContext.educatorDataLoading, false, 'a coherent scoped commit restores the bird views');
assert.equal(loadingNodes.views.hidden, 'false', 'the coherent public replacement restores the bird views to assistive tech');
assert.equal(scopedRenderCommits, 1, 'only the coherent scoped batch renders');

const mergeContext = {
  educatorCaptureArchive: { [c1]: { id: c1, name: 'Current', revision: 5 } },
  educatorCaptureOrder: [c1],
  educatorCapturePage: { total: 1, more: false, next_cursor: null },
  validEducatorId(value) { return /^c_[a-f0-9]{32}$/.test(value); },
};
vm.createContext(mergeContext);
vm.runInContext(functionSource('mergeEducatorCaptures'), mergeContext);
mergeContext.mergeEducatorCaptures([{ id: c1, name: 'Stale', revision: 3 }],
  { total: 1, more: false, next_cursor: null }, 'append');
assert.equal(mergeContext.educatorCaptureArchive[c1].name, 'Current',
  'an older page cannot regress newer capture metadata');
mergeContext.mergeEducatorCaptures([{ id: c1, name: 'Newer', revision: 6 }],
  { total: 1, more: false, next_cursor: null }, 'append');
assert.equal(mergeContext.educatorCaptureArchive[c1].name, 'Newer', 'newer capture metadata can advance');
assert.deepEqual(JSON.parse(JSON.stringify(mergeContext.educatorCaptureOrder)), [c1],
  'paged capture merges deduplicate stable IDs');

function pagingContext(responses) {
  const context = {
    educatorOlderBusy: false,
    educatorState: {
      profile_epoch: 'profile-1', state_revision: 4,
      captures: [{ id: c1, revision: 1 }], capture_page: {},
    },
    educatorCapturePage: { total: 250, more: true, next_cursor: 'cursor-1' },
    educatorCaptureOrder: [c1],
    educatorFocusSelector: '',
    educatorStatusMessage: '',
    educatorStatusError: false,
    adminEl: { scrollTop: 73 },
    paints: [],
    requests: 0,
    mergeCalls: 0,
    adminJson() {
      const response = responses[Math.min(context.requests, responses.length - 1)];
      context.requests += 1;
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
    normalizeEducatorState(value) { return value; },
    resetEducatorCaptureArchive() {},
    educatorLoad() { throw new Error('unexpected head reload'); },
    mergeEducatorCaptures(captures, page) {
      context.mergeCalls += 1;
      context.educatorCapturePage = { ...page };
      return context.educatorState.captures.concat(captures);
    },
    paintEducators() {
      context.paints.push({ busy: context.educatorOlderBusy, focus: context.educatorFocusSelector });
    },
    adminAuthCancelled() { return false; },
    encodeURIComponent,
  };
  vm.createContext(context);
  vm.runInContext(functionSource('educatorLoadOlder'), context);
  return context;
}
const pageResponse = {
  profile_epoch: 'profile-1', state_revision: 4,
  captures: [{ id: c2, revision: 1 }],
  capture_page: { total: 250, more: true, next_cursor: 'cursor-2' },
};
const pagingSuccess = pagingContext([pageResponse]);
await pagingSuccess.educatorLoadOlder();
assert.deepEqual(pagingSuccess.paints.map((paint) => paint.busy), [true, false],
  'successful pagination paints loading immediately and restores the usable control when more remain');
assert.equal(pagingSuccess.educatorOlderBusy, false, 'successful pagination clears its busy guard');
assert.equal(pagingSuccess.educatorFocusSelector, '[data-load-older]',
  'successful pagination keeps keyboard focus on Load older when another page exists');
assert.equal(pagingSuccess.adminEl.scrollTop, 73, 'successful pagination preserves the admin scroll position');

const pagingRetry = pagingContext([new Error('offline'), pageResponse]);
await pagingRetry.educatorLoadOlder();
assert.deepEqual(pagingRetry.paints.map((paint) => paint.busy), [true, false],
  'failed pagination restores the Load older control instead of leaving loading text behind');
assert.equal(pagingRetry.educatorStatusError, true, 'failed pagination announces a retryable error');
await pagingRetry.educatorLoadOlder();
assert.equal(pagingRetry.requests, 2, 'Load older can be retried immediately after an error');
assert.equal(pagingRetry.educatorOlderBusy, false, 'the retry also clears its busy guard');

const delayedOlderPage = deferred();
const supersededPaging = pagingContext([delayedOlderPage.promise]);
const supersededRequest = supersededPaging.educatorLoadOlder();
supersededPaging.educatorState = {
  ...supersededPaging.educatorState,
  state_revision: 5,
  captures: [{ id: c1, revision: 2 }],
};
delayedOlderPage.resolve(pageResponse);
await supersededRequest;
assert.equal(supersededPaging.mergeCalls, 0,
  'an older page matching only its captured revision cannot merge after current state advances');
assert.equal(supersededPaging.educatorState.state_revision, 5,
  'the current cross-tab revision remains authoritative after the stale page returns');
assert.equal(supersededPaging.educatorOlderBusy, false,
  'dropping a superseded page clears the pagination busy guard');
assert.equal(supersededPaging.paints.at(-1).busy, false,
  'dropping a superseded page repaints the current usable Load older state');

const delayedPriorProfilePage = deferred();
const changedProfilePaging = pagingContext([delayedPriorProfilePage.promise]);
const changedProfileRequest = changedProfilePaging.educatorLoadOlder();
changedProfilePaging.educatorState = {
  ...changedProfilePaging.educatorState,
  profile_epoch: 'profile-2',
  captures: [{ id: c1, revision: 2 }],
};
delayedPriorProfilePage.resolve(pageResponse);
await changedProfileRequest;
assert.equal(changedProfilePaging.mergeCalls, 0,
  'an older page cannot merge after the current profile epoch changes in flight');
assert.equal(changedProfilePaging.educatorState.profile_epoch, 'profile-2',
  'the replacement profile remains authoritative after the prior profile page returns');
assert.equal(changedProfilePaging.educatorOlderBusy, false,
  'dropping a prior-profile page restores pagination controls');

assert.match(functionSource('wireEducators'), /startForm\.addEventListener\('submit'[\s\S]*educatorPost\('start', name \? \{ name: name \} : undefined\)/,
  'Enter or the arrow submits the optional typed listening-period name');
assert.match(functionSource('clearSubmittedEducatorStartDraft'), /educatorStartDraft !== submittedDraft[\s\S]*current\.value = ''[\s\S]*educatorStartDraft = ''/,
  'a successful Start clears only the exact unchanged draft');
for (const action of ['pause', 'resume', 'stop', 'move-capture', 'delete-capture',
  'create-folder', 'delete-folder', 'audio-grant']) {
  assert.match(apt, new RegExp(`['"]${action}['"]`), `${action} is wired`);
}
assert.match(apt, /educatorPost\('rename-' \+ kind/, 'capture and folder rename use the hyphenated API actions');
assert.match(apt, /capture_page[\s\S]*next_cursor/, 'capture state consumes the bounded page contract');
assert.match(apt, /action=captures&cursor=/, 'older captures load through the stable cursor endpoint');
assert.match(apt, /educatorOlderBusy \? ' disabled aria-busy="true"'/,
  'the loading pagination control exposes its busy state and rejects duplicate activation');
assert.match(apt, /educatorCaptureArchiveRevision !== next\.state_revision/, 'revision changes invalidate paged captures');
assert.match(apt, /educatorCaptureOrder = educatorCaptureOrder\.concat\(incoming\)/, 'older pages append with ID deduplication');
assert.match(apt, /total \? 'Load older/, 'folder counts stay honest when older rows are not loaded');
const folderContext = {
  educatorEditing: null,
  educatorRenameHtml(kind, folder) { return `<span>${folder.name}</span>`; },
  educatorMoreButton(kind, folder) { return `<button data-educator-menu-kind="${kind}" aria-label="Actions for ${folder.name}"></button>`; },
  educatorCaptureRow(capture) { return `<li>${capture.id}</li>`; },
  educatorFolderKey(id) { return id || 'unfiled'; },
  educatorFolderIsCollapsed() { return false; },
  adminAttr: String,
  adminEsc: String,
};
vm.createContext(folderContext);
vm.runInContext(functionSource('educatorFolderGroup'), folderContext);
const largeFolder = folderContext.educatorFolderGroup({ id: f1, name: 'Biology', capture_count: 150 },
  [{ id: c1 }], 150);
assert.match(largeFolder, /educator-count">1 of 150</, 'paged folder headings show loaded and authoritative totals');
assert.match(largeFolder, /aria-label="View Biology\. 1 of 150 listening periods loaded\."/,
  'paged folder View exposes its visible loaded and authoritative totals');
assert.match(largeFolder, /data-educator-menu-kind="folder"/, 'folder actions live behind one accessible menu button');
assert.match(largeFolder, /data-folder-toggle=.*aria-expanded="true".*aria-controls=/,
  'folder contents have an independent labelled collapse control');
assert.doesNotMatch(largeFolder, />Remove</, 'folder Remove is not a permanent visible control');
assert.match(folderContext.educatorFolderGroup({ id: f1, name: 'Biology' }, [{ id: c1 }, { id: c2 }], 2),
  /aria-label="View Biology\. 2 listening periods\."/,
  'ordinary folder View exposes its complete visible count');
assert.match(folderContext.educatorFolderGroup({ id: f1, name: 'Biology' }, [{ id: c1 }], 1),
  /aria-label="View Biology\. 1 listening period\."/,
  'single-period folder View uses honest singular count copy');
assert.match(folderContext.educatorFolderGroup({ id: f1, name: 'Biology' }, [], 0),
  /aria-label="View Biology\. 0 listening periods\."/,
  'empty folder View exposes its visible zero count');
assert.doesNotMatch(functionSource('paintEducators'), /educatorFolderGroup\(null/,
  'unfiled listening periods render as loose rows instead of a fake folder');
assert.match(functionSource('paintEducators'), /<ol class="educator-unfiled" aria-label="Unfiled listening periods">[\s\S]*unfiled\.map\(educatorCaptureRow\)/,
  'loose unfiled periods retain an accessible list name');
const captureContext = {
  educatorEditing: null,
  educatorRenameHtml(kind, capture) { return `<span>${capture.name}</span>`; },
  educatorMoreButton(kind, capture) { return `<button data-educator-menu-kind="${kind}" aria-label="Actions for ${capture.name}"></button>`; },
  educatorDateLabel() { return 'Sep 1, 9:00 AM'; },
  educatorDurationSeconds() { return 65; },
  educatorDurationLabel() { return '1:05'; },
  adminAttr: String,
  adminEsc: String,
};
vm.createContext(captureContext);
vm.runInContext(functionSource('educatorCaptureRow'), captureContext);
const captureMarkup = captureContext.educatorCaptureRow({
  id: c1, name: 'Period 3', folder_id: null, detection_count: 2, species_count: 1,
});
assert.match(captureMarkup, /aria-label="View Period 3\. Duration 1:05\. 1 bird\. 2 calls\. Started Sep 1, 9:00 AM\."/,
  'capture View exposes every visible metadata value in its accessible name');
assert.match(captureMarkup, /class="sr-only" role="heading" aria-level="3"[^>]*data-capture-heading[^>]*>Period 3<\/span>/,
  'each saved listening period retains a separate accessible heading outside its button');
assert.match(captureMarkup, /class="educator-period-grid" aria-hidden="true"/,
  'the visual metadata grid does not duplicate the complete button name');
assert.match(captureMarkup, /data-educator-menu-kind="capture"/, 'capture actions live behind one accessible menu button');
assert.doesNotMatch(captureMarkup, /<select|>Remove</, 'saved rows stay compact without visible move or remove controls');
const unknownCountMarkup = captureContext.educatorCaptureRow({
  id: c1, name: 'Period 3', folder_id: null, detection_count: null, species_count: null,
});
assert.doesNotMatch(unknownCountMarkup, /0 calls|0 birds/,
  'saved periods with unavailable counts never render fake zero totals');
assert.match(unknownCountMarkup, /Bird count unavailable\. Call count unavailable\./,
  'unavailable metadata is stated honestly in the row accessible name');

const menuItemsContext = {
  ICON_MOVE: '<svg data-icon="move"></svg>',
  ICON_RENAME: '<svg data-icon="rename"></svg>',
  ICON_REMOVE: '<svg data-icon="remove"></svg>',
  ICON_FOLDER_PLUS: '<svg data-icon="folder-plus"></svg>',
};
vm.createContext(menuItemsContext);
vm.runInContext(functionSource('educatorActionMenuItems'), menuItemsContext);
const activeMenu = menuItemsContext.educatorActionMenuItems('active');
assert.match(activeMenu, /data-icon="move"[\s\S]*<span>Move<\/span>[\s\S]*data-icon="rename"[\s\S]*<span>Rename<\/span>/,
  'the active menu contains icon-led Move and Rename actions');
assert.doesNotMatch(activeMenu, /Remove/, 'the active listening period cannot be removed while active');
const savedMenu = menuItemsContext.educatorActionMenuItems('capture');
assert.match(savedMenu, /<span>Move<\/span>[\s\S]*<span>Rename<\/span>[\s\S]*<span>Remove<\/span>/,
  'saved listening periods expose the complete compact action set');
assert.match(menuItemsContext.educatorActionMenuItems('pane'), /Create new folder/,
  'the saved-pane menu exposes the accessible Create new folder path');

const viewHandlers = {};
const viewButton = {
  dataset: { viewCapture: c1 },
  addEventListener(type, handler) { viewHandlers[type] = handler; },
};
let viewedRows = 0;
const rowActivationContext = {
  adminBody: {
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '[data-view-capture]' ? [viewButton] : []; },
  },
  educatorCapture(id) { return id === c1 ? { id: c1 } : null; },
  viewEducatorEntity(capture) { assert.equal(capture.id, c1); viewedRows += 1; },
  beginEducatorRename() {},
  wireEducatorExport() {},
};
vm.createContext(rowActivationContext);
vm.runInContext(functionSource('wireEducators'), rowActivationContext);
rowActivationContext.wireEducators();
viewHandlers.click();
assert.equal(viewedRows, 1, 'clicking the primary saved row views that listening period');

let openedRowMenus = 0;
let menuClickPrevented = 0;
let menuClickStopped = 0;
const rowMenuTrigger = { dataset: { educatorMenuKind: 'capture', educatorMenuId: c1 } };
const rowMenuClickContext = {
  adminSect: 'educators',
  openEducatorActionMenu(kind, id, trigger) {
    assert.equal(kind, 'capture'); assert.equal(id, c1); assert.equal(trigger, rowMenuTrigger);
    openedRowMenus += 1;
  },
};
vm.createContext(rowMenuClickContext);
vm.runInContext(functionSource('handleEducatorAdminClick'), rowMenuClickContext);
rowMenuClickContext.handleEducatorAdminClick({
  target: { closest(selector) { return selector === '[data-educator-menu-trigger]' ? rowMenuTrigger : null; } },
  preventDefault() { menuClickPrevented += 1; },
  stopPropagation() { menuClickStopped += 1; },
});
assert.equal(openedRowMenus, 1, 'clicking three dots opens the singleton menu instead of viewing the row');
assert.equal(menuClickPrevented, 1, 'the menu trigger suppresses its default action');
assert.equal(menuClickStopped, 1, 'the menu trigger cannot bubble into row activation');
assert.equal(viewedRows, 1, 'opening a row menu does not activate the row view');

const collapseWrites = [];
const folderBody = { hidden: false };
const folderName = { textContent: 'Biology' };
const folderSection = {
  attrs: {},
  querySelector(selector) { return selector === '.educator-folder-body' ? folderBody : folderName; },
  setAttribute(name, value) { this.attrs[name] = value; },
};
const caretButton = {
  dataset: { folderToggle: f1 },
  attrs: { 'aria-expanded': 'true' },
  closest() { return folderSection; },
  getAttribute(name) { return this.attrs[name]; },
  setAttribute(name, value) { this.attrs[name] = value; },
};
const collapseContext = {
  setEducatorFolderCollapsed(id, collapsed) { collapseWrites.push([id, collapsed]); },
};
vm.createContext(collapseContext);
vm.runInContext(functionSource('toggleEducatorFolder'), collapseContext);
assert.equal(collapseContext.toggleEducatorFolder(caretButton), true, 'the separate caret collapses a folder');
assert.equal(folderBody.hidden, true, 'collapsed folder children leave the accessible tree');
assert.equal(caretButton.attrs['aria-expanded'], 'false', 'the caret publishes its collapsed state');
collapseContext.toggleEducatorFolder(caretButton);
assert.equal(folderBody.hidden, false, 'the same caret expands the folder again');
assert.deepEqual(collapseWrites, [[f1, true], [f1, false]], 'collapse persistence receives each exact state transition');

const expandedWrites = [];
const expandedContext = {
  EDUCATOR_EXPANDED_KEY: 'expanded-v2',
  educatorExpandedFolders: { unfiled: true, [f1]: true, [`f_${'b'.repeat(32)}`]: true },
  writeLS(key, value) { expandedWrites.push([key, JSON.parse(value)]); },
};
vm.createContext(expandedContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('validEducatorFolderKey'),
  functionSource('canonicalizeEducatorExpandedFolders'),
].join('\n'), expandedContext);
expandedContext.canonicalizeEducatorExpandedFolders([{ id: f1 }], false);
assert.deepEqual(Object.keys(expandedContext.educatorExpandedFolders), [f1],
  'authoritative folder state removes stale expanded IDs while retaining valid local choices');
expandedContext.canonicalizeEducatorExpandedFolders([], true);
assert.deepEqual(Object.keys(expandedContext.educatorExpandedFolders), [],
  'a profile epoch change clears every expanded folder ID');
assert.equal(expandedWrites.length, 2, 'expanded-state cleanup writes only when its canonical value changes');
assert.match(functionSource('acceptEducatorState'), /profileChanged[\s\S]*canonicalizeEducatorExpandedFolders\(next\.folders, profileChanged\)/,
  'profile epoch changes route through authoritative expanded-state cleanup');

let expandedPreferenceReads = 0;
let expandedPreferenceClears = 0;
let expandedPreferenceStorage = JSON.stringify([f1]);
const deferredExpandContext = {
  EDUCATOR_EXPANDED_KEY: 'expanded-v2',
  educatorExpandedFolders: Object.create(null),
  educatorExpandedFoldersLoaded: false,
  readLS(key, fallback) {
    expandedPreferenceReads += 1;
    return expandedPreferenceStorage || fallback;
  },
  removeLS(key) {
    assert.equal(key, 'expanded-v2');
    expandedPreferenceClears += 1;
    expandedPreferenceStorage = '';
  },
};
vm.createContext(deferredExpandContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('validEducatorFolderKey'),
  functionSource('loadEducatorExpandedFolders'),
  functionSource('authorizeEducatorFolderPreferences'),
  functionSource('suspendEducatorFolderPreferences'),
].join('\n'), deferredExpandContext);
assert.equal(expandedPreferenceReads, 0, 'a locked boot does not read private folder IDs from browser storage');
deferredExpandContext.authorizeEducatorFolderPreferences();
assert.equal(expandedPreferenceReads, 1, 'authorization restores expanded folder choices once');
assert.equal(deferredExpandContext.educatorExpandedFolders[f1], true, 'the authorized expanded choice is restored');
deferredExpandContext.suspendEducatorFolderPreferences();
assert.deepEqual(Object.keys(deferredExpandContext.educatorExpandedFolders), [],
  'auth loss removes private folder IDs from live JavaScript state');
assert.equal(expandedPreferenceClears, 1,
  'auth loss removes folder bearer capabilities from browser storage');
deferredExpandContext.authorizeEducatorFolderPreferences();
assert.equal(expandedPreferenceReads, 2, 'reauthorization checks the now-empty browser preference once');
assert.deepEqual(Object.keys(deferredExpandContext.educatorExpandedFolders), [],
  'reauthorization cannot restore folder capability IDs cleared on logout');

const defaultFolderContext = { educatorExpandedFolders: Object.create(null), educatorFolderKey(id) { return id || ''; } };
vm.createContext(defaultFolderContext);
vm.runInContext(functionSource('educatorFolderIsCollapsed'), defaultFolderContext);
assert.equal(defaultFolderContext.educatorFolderIsCollapsed(f1), true, 'a new folder is collapsed by default');

let composerPaints = 0;
let composerFocuses = 0;
let composerSelects = 0;
const composerInput = { value: 'Period 4', select() { composerSelects += 1; } };
const composerContext = {
  educatorFolderComposerOpen: false,
  educatorFolderDraft: 'Period 4',
  educatorFocusSelector: '',
  adminBody: { querySelector(selector) {
    return selector === '#educatorFolderName' && composerContext.educatorFolderComposerOpen ? composerInput : null;
  } },
  paintEducators() { composerPaints += 1; },
  focusEl(target) { assert.equal(target, composerInput); composerFocuses += 1; },
};
vm.createContext(composerContext);
vm.runInContext([
  functionSource('focusEducatorNewFolder'),
  functionSource('cancelEducatorNewFolder'),
].join('\n'), composerContext);
assert.equal(composerContext.focusEducatorNewFolder(), true, 'Create new folder opens the inline composer');
assert.equal(composerContext.educatorFolderComposerOpen, true, 'the new-folder composer records its open state');
assert.equal(composerFocuses, 1, 'the newly revealed folder field receives focus');
assert.equal(composerSelects, 1, 'an existing preserved draft is selected for direct editing');
composerContext.cancelEducatorNewFolder();
assert.equal(composerContext.educatorFolderComposerOpen, false, 'Cancel closes the folder composer');
assert.equal(composerContext.educatorFolderDraft, '', 'Cancel discards the abandoned folder draft');
assert.equal(composerContext.educatorFocusSelector, '[data-folder-create-open]',
  'Cancel returns focus to the direct folder-plus button on repaint');
assert.equal(composerPaints, 2, 'open and Cancel each perform one necessary workspace paint');

const actionDispatches = [];
const menuActionContext = {
  educatorActionMenuState: null,
  adminBody: { contains() { return true; } },
  closeEducatorActionMenu() {},
  focusEducatorNewFolder() { actionDispatches.push('create'); return true; },
  openEducatorMovePopover(id, focus) { actionDispatches.push(`move:${id}:${focus}`); return true; },
  beginEducatorRename(kind, id) { actionDispatches.push(`rename:${kind}:${id}`); },
  removeEducatorCapture() { actionDispatches.push('remove-capture'); return true; },
  removeEducatorFolder() { actionDispatches.push('remove-folder'); return true; },
  focusEl() {},
};
vm.createContext(menuActionContext);
vm.runInContext(functionSource('activateEducatorMenuAction'), menuActionContext);
menuActionContext.educatorActionMenuState = { kind: 'active', id: c1, returnFocus: 'active-trigger' };
menuActionContext.activateEducatorMenuAction('move');
menuActionContext.educatorActionMenuState = { kind: 'active', id: c1, returnFocus: 'active-trigger' };
menuActionContext.activateEducatorMenuAction('rename');
menuActionContext.educatorActionMenuState = { kind: 'active', id: c1, returnFocus: 'active-trigger' };
assert.equal(menuActionContext.activateEducatorMenuAction('remove'), false,
  'dispatch refuses Remove even if an active menu action is forged');
menuActionContext.educatorActionMenuState = { kind: 'pane', id: 'pane', returnFocus: 'pane-trigger' };
menuActionContext.activateEducatorMenuAction('create-folder');
assert.deepEqual(actionDispatches, [`move:${c1}:active-trigger`, `rename:capture:${c1}`, 'create'],
  'active menu actions reuse the proven capture move and rename flows');
assert.match(functionSource('openEducatorMovePopover'), /role', 'dialog'[\s\S]*data-educator-move-select[\s\S]*data-educator-move-cancel/,
  'Move opens one labelled keyboard-operable folder dialog with Cancel');

let singletonRemoved = 0;
const firstMenuItem = {};
const singletonMenu = {
  id: '', style: {}, attrs: {}, innerHTML: '',
  setAttribute(name, value) { this.attrs[name] = value; },
  querySelector(selector) { return selector === '[role="menuitem"]' ? firstMenuItem : null; },
  remove() { singletonRemoved += 1; },
};
const singletonTrigger = {
  attrs: {},
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  matches(selector) { return selector === '[data-educator-menu-trigger]'; },
};
const singletonFocus = [];
const singletonContext = {
  educatorActionMenuState: null,
  document: { createElement() { return singletonMenu; } },
  adminBody: {
    appendChild(element) { assert.equal(element, singletonMenu); },
    contains() { return true; },
  },
  educatorCapture(id) { return id === c1 ? { id } : null; },
  educatorFolder() { return null; },
  educatorActionMenuItems: menuItemsContext.educatorActionMenuItems,
  closeEducatorMovePopover() {},
  positionEducatorPopover() {},
  focusEl(target) { singletonFocus.push(target); },
};
vm.createContext(singletonContext);
vm.runInContext([
  functionSource('closeEducatorActionMenu'),
  functionSource('openEducatorActionMenu'),
].join('\n'), singletonContext);
assert.equal(singletonContext.openEducatorActionMenu('capture', c1, singletonTrigger, null), true,
  'the row trigger opens one singleton menu inside the private admin body');
assert.equal(singletonContext.educatorActionMenuState.menu, singletonMenu, 'the singleton is the only tracked action menu');
assert.equal(singletonTrigger.attrs['aria-expanded'], 'true', 'opening the menu publishes expanded state');
assert.equal(singletonTrigger.attrs['aria-controls'], 'educatorActionMenu', 'the trigger owns the singleton menu ID');
assert.equal(singletonFocus[0], firstMenuItem, 'opening a menu focuses its first action');
singletonContext.closeEducatorActionMenu(true);
assert.equal(singletonRemoved, 1, 'Escape-style close removes the private singleton from the DOM');
assert.equal(singletonTrigger.attrs['aria-expanded'], 'false', 'closing the menu restores collapsed state');
assert.equal(singletonFocus.at(-1), singletonTrigger, 'closing with focus restore returns to the exact trigger');

const keyboardItems = [{ name: 'move' }, { name: 'rename' }, { name: 'remove' }];
const keyboardFocus = [];
let keyboardCloseRestore = null;
let keyboardMenuOpen = null;
const keyboardMenu = {
  contains() { return true; },
  querySelectorAll() { return keyboardItems; },
};
const keyboardContext = {
  adminSect: 'educators',
  educatorActionMenuState: { menu: keyboardMenu },
  educatorMoveState: null,
  focusEl(target) { keyboardFocus.push(target); },
  closeEducatorActionMenu(restore) { keyboardCloseRestore = restore; },
  closeEducatorMovePopover() {},
  educatorContextTarget() { return null; },
  openEducatorActionMenu(kind, id, trigger) { keyboardMenuOpen = { kind, id, trigger }; },
};
vm.createContext(keyboardContext);
vm.runInContext(functionSource('handleEducatorAdminKeydown'), keyboardContext);
let keyboardPrevented = 0;
keyboardContext.handleEducatorAdminKeydown({ key: 'ArrowDown', target: keyboardItems[0], preventDefault() { keyboardPrevented += 1; } });
assert.equal(keyboardFocus.at(-1), keyboardItems[1], 'Arrow Down advances menu focus');
keyboardContext.handleEducatorAdminKeydown({ key: 'End', target: keyboardItems[0], preventDefault() { keyboardPrevented += 1; } });
assert.equal(keyboardFocus.at(-1), keyboardItems[2], 'End focuses the final menu action');
keyboardContext.handleEducatorAdminKeydown({ key: 'Escape', target: keyboardItems[2], preventDefault() { keyboardPrevented += 1; } });
assert.equal(keyboardCloseRestore, true, 'Escape closes the action menu and restores trigger focus');
assert.equal(keyboardPrevented, 3, 'handled menu navigation never leaks browser defaults');
keyboardCloseRestore = null;
keyboardContext.handleEducatorAdminKeydown({ key: 'Tab', target: keyboardItems[1], preventDefault() { throw new Error('Tab must remain native'); } });
assert.equal(keyboardCloseRestore, true,
  'Tab restores the trigger before its native focus move so menu removal is not a dead end');

keyboardContext.educatorActionMenuState = null;
const keyboardTrigger = {
  dataset: { educatorMenuKind: 'folder', educatorMenuId: f1 },
  closest(selector) { return selector === '[data-educator-menu-trigger]' ? this : null; },
};
keyboardContext.handleEducatorAdminKeydown({
  key: 'F10', shiftKey: true, target: keyboardTrigger,
  preventDefault() {},
});
assert.deepEqual(keyboardMenuOpen, { kind: 'folder', id: f1, trigger: keyboardTrigger },
  'Shift and F10 opens the same folder menu for keyboard users');

const contextTargetContext = {};
vm.createContext(contextTargetContext);
vm.runInContext(functionSource('educatorContextTarget'), contextTargetContext);
assert.equal(contextTargetContext.educatorContextTarget({
  closest(selector) { return selector.startsWith('input,') ? {} : null; },
}), null, 'native context menus remain available in editable controls');
const contextRow = { dataset: { educatorRowKind: 'capture', educatorRowId: c1 } };
assert.deepEqual(JSON.parse(JSON.stringify(contextTargetContext.educatorContextTarget({
  closest(selector) {
    if (selector.startsWith('input,')) return null;
    if (selector === '[data-educator-row-kind]') return contextRow;
    return null;
  },
}))), { kind: 'capture', id: c1, anchor: { dataset: contextRow.dataset } },
  'right-click resolves the exact compact row without changing its view scope');
const savedPane = {};
const emptyPaneTarget = contextTargetContext.educatorContextTarget({
  closest(selector) {
    if (selector.startsWith('input,') || selector === '[data-educator-row-kind]' || selector === 'button, a, form') return null;
    if (selector === '[data-educator-saved]') return savedPane;
    return null;
  },
});
assert.equal(emptyPaneTarget.kind, 'pane', 'empty saved-pane space resolves to Create new folder actions');

const activeRenameInput = {};
const hiddenViewButton = {};
const renameReturnContext = {};
vm.createContext(renameReturnContext);
vm.runInContext(functionSource('educatorContextReturnFocus'), renameReturnContext);
const renameRow = {
  querySelector(selector) {
    assert.match(selector, /data-rename-form[^,]*input[\s\S]*educator-row-view:not\(\[hidden\]\)/,
      'context return focus prefers an active rename field over row controls');
    return activeRenameInput;
  },
};
assert.equal(renameReturnContext.educatorContextReturnFocus(renameRow), activeRenameInput,
  'Escape from a context menu opened during rename returns to the visible rename input');
assert.notEqual(renameReturnContext.educatorContextReturnFocus(renameRow), hiddenViewButton,
  'context-menu focus never targets the hidden View button during rename');
assert.match(functionSource('handleEducatorContextMenu'), /educatorContextReturnFocus\(target\.anchor\)/,
  'pointer context menus use the visible row-focus resolver');
assert.match(functionSource('handleEducatorAdminKeydown'), /trigger \|\| educatorContextReturnFocus\(target\.anchor\) \|\| target\.anchor/,
  'keyboard context menus use the same visible row-focus resolver');

let outsideMenuCloses = 0;
let outsideMoveCloses = 0;
const outsideContext = {
  educatorActionMenuState: { menu: { contains() { return false; } }, trigger: { contains() { return false; } } },
  educatorMoveState: { popover: { contains() { return false; } } },
  closeEducatorActionMenu() { outsideMenuCloses += 1; },
  closeEducatorMovePopover() { outsideMoveCloses += 1; },
};
vm.createContext(outsideContext);
vm.runInContext(functionSource('handleEducatorOutsidePointer'), outsideContext);
outsideContext.handleEducatorOutsidePointer({ target: {} });
assert.equal(outsideMenuCloses, 1, 'outside pointer closes the singleton action menu');
assert.equal(outsideMoveCloses, 1, 'outside pointer closes the move dialog');
const scrollFocusedMenuItem = {};
let scrollMenuRestore = null;
let scrollMoveRestore = null;
const transientFocusContext = {
  document: { activeElement: scrollFocusedMenuItem },
  educatorActionMenuState: { menu: { contains(target) { return target === scrollFocusedMenuItem; } } },
  educatorMoveState: { popover: { contains() { return false; } } },
  closeEducatorActionMenu(restore) { scrollMenuRestore = restore; },
  closeEducatorMovePopover(restore) { scrollMoveRestore = restore; },
};
vm.createContext(transientFocusContext);
vm.runInContext(functionSource('closeEducatorTransientUi'), transientFocusContext);
transientFocusContext.closeEducatorTransientUi(true);
assert.equal(scrollMenuRestore, true,
  'scroll cleanup restores a trigger when it removes the focused action menu');
assert.equal(scrollMoveRestore, false,
  'scroll cleanup does not steal focus for a popover that did not contain it');
const scrollAdminEl = {};
let scrollTransientCloses = 0;
let scrollFocusRestores = 0;
const scrollContext = {
  adminSect: 'educators',
  adminEl: scrollAdminEl,
  closeEducatorTransientUi(restore) {
    scrollTransientCloses += 1;
    if (restore) scrollFocusRestores += 1;
  },
};
vm.createContext(scrollContext);
vm.runInContext(functionSource('handleEducatorAdminScroll'), scrollContext);
scrollContext.handleEducatorAdminScroll({ target: {
  matches(selector) { return selector.includes('.educator-controls'); },
} });
scrollContext.handleEducatorAdminScroll({ target: {
  matches(selector) { return selector.includes('[data-educator-saved]'); },
} });
scrollContext.handleEducatorAdminScroll({ target: scrollAdminEl });
scrollContext.handleEducatorAdminScroll({ target: { matches() { return false; } } });
assert.equal(scrollTransientCloses, 3,
  'left-pane, saved-pane, and stacked mobile admin scroll close fixed Educators popovers');
assert.equal(scrollFocusRestores, 3,
  'each scroll path preserves focus when it removes a focused fixed control');
scrollContext.adminSect = 'settings';
scrollContext.handleEducatorAdminScroll({ target: scrollAdminEl });
assert.equal(scrollTransientCloses, 3, 'other admin pages do not disturb Educators popover state');
assert.match(apt, /adminBody\.addEventListener\('scroll', handleEducatorAdminScroll, true\)/,
  'both workspace panes use one captured scroll cleanup');
assert.match(apt, /adminEl\.addEventListener\('scroll', handleEducatorAdminScroll, \{ passive: true \}\)/,
  'the stacked mobile admin scroller uses the same cleanup');
assert.match(apt, /window\.addEventListener\('resize', closeEducatorTransientUi\)/,
  'window resize clears fixed Educators popovers');
assert.match(functionSource('wireEducators'), /created\.id \+ ' \[data-folder-heading\]'/,
  'new-folder completion focuses its heading instead of a noninteractive section');
assert.match(functionSource('removeEducatorCapture'), /capture\.folder_id[\s\S]*\[data-folder-heading\][\s\S]*\[data-folder-create-open\]/,
  'capture removal focuses its surviving folder heading or the visible folder control');
assert.match(functionSource('removeEducatorFolder'), /moved[\s\S]*\[data-view-capture\][\s\S]*\[data-folder-create-open\]/,
  'folder removal restores focus to a moved loose row or the visible folder control');
assert.match(functionSource('educatorLoadOlder'), /firstNew\.id \+ ' \[data-view-capture\]'/,
  'the final older page focuses the first newly loaded View control');

assert.match(apt, /body\.result && body\.result\.capture \|\| body\.active/,
  'Start follows the committed active capture from the mutation snapshot');
assert.match(apt, /clearExplicit:\s*true/, 'Start clears a previously saved explicit period before following live work');
assert.match(functionSource('educatorLoad'), /educatorEditing && educatorPendingState && !options\.force\) return/,
  'background polling does not repaint or reselect text during inline rename');
assert.match(functionSource('acceptEducatorState'), /educatorAcceptedSignature = educatorStateSignature\(value\)/,
  'no-op polling signs the bounded server page instead of the locally merged older archive');

assert.match(apt, /error\.status === 404 \|\| error\.status === 409/, 'stale saved scopes recover before Educators is opened');
assert.match(apt, /educator_scope_unavailable[\s\S]*data_generation_changed/, 'only explicit scope lifecycle failures trigger recovery');
assert.match(functionSource('scopedFetchJson'), /sharedScopeUnavailable = scopeUnavailableStatus[\s\S]*educatorScopeShared[\s\S]*validEducatorId\(request\.scopeId\)/,
  'every unavailable response for a shared opaque saved-scope capability fails closed');
assert.match(functionSource('scopedFetchJson'), /request\.generation !== educatorScopeGeneration[\s\S]*Promise\.reject\(obsolete\)/,
  'a stale rendered card cannot start a request after its dataset generation changes');
let authLockCalls = 0;
let authLockSignals = 0;
const authLossContext = {
  educatorScopeGeneration: 9,
  educatorScopeShared: false,
  adminAccessState: 'unlocked',
  fetchJson() { return Promise.reject({ status: 401, body: { error: 'admin_required' } }); },
  birdApiUrl() { return '/scoped'; },
  validEducatorId(value) { return value === c1 || value === f1; },
  educatorScopeFromPayload() { return undefined; },
  adoptEducatorScope() { return true; },
  applyEducatorScope() {},
  refreshAll() {},
  showAdminLocked() { authLockCalls += 1; },
  signalAdminLock() { authLockSignals += 1; },
  setTimeout,
};
vm.createContext(authLossContext);
vm.runInContext(functionSource('scopedFetchJson'), authLossContext);
await assert.rejects(authLossContext.scopedFetchJson('recent', {}, {
  scopeId: c1, generation: 9,
}));
assert.equal(authLockCalls, 1,
  'a 401 from a saved private scope immediately enters the normal locked state');
assert.equal(authLockSignals, 1,
  'a scoped 401 broadcasts the lock so other tabs cannot retain private data');
await assert.rejects(authLossContext.scopedFetchJson('recent', {}, {
  scopeId: 'active', generation: 9,
}));
assert.equal(authLockCalls, 1,
  'the public automatic active scope does not invent an administrator lock transition');
assert.equal(authLockSignals, 1,
  'a public automatic-scope failure does not broadcast a false admin lock');

const parallelRejects = [];
let parallelLocks = 0;
let parallelSignals = 0;
const parallelAuthContext = {
  educatorScopeGeneration: 12,
  educatorScopeShared: false,
  adminAccessState: 'unlocked',
  fetchJson() {
    return new Promise((resolve, reject) => { parallelRejects.push(reject); });
  },
  birdApiUrl() { return '/scoped'; },
  validEducatorId(value) { return value === c1; },
  educatorScopeFromPayload() { return undefined; },
  adoptEducatorScope() { return true; },
  applyEducatorScope() {},
  refreshAll() {},
  showAdminLocked() { parallelLocks += 1; parallelAuthContext.adminAccessState = 'locked'; },
  signalAdminLock() { parallelSignals += 1; },
  setTimeout,
};
vm.createContext(parallelAuthContext);
vm.runInContext(functionSource('scopedFetchJson'), parallelAuthContext);
const parallelRequests = [
  parallelAuthContext.scopedFetchJson('recent', {}, { scopeId: c1, generation: 12 }),
  parallelAuthContext.scopedFetchJson('lifelist', {}, { scopeId: c1, generation: 12 }),
];
parallelRejects.forEach((reject) => reject({ status: 401, body: { error: 'admin_required' } }));
await Promise.allSettled(parallelRequests);
assert.equal(parallelLocks, 1, 'one expired scoped batch enters the lock state once');
assert.equal(parallelSignals, 1, 'one expired scoped batch broadcasts exactly one cross-tab lock');

let unavailableScrubs = 0;
let unavailableRefreshes = 0;
let unavailableBlocks = 0;
const unavailableScopeContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  EDUCATOR_SCOPE_KEY: 'scope',
  educatorScopeGeneration: 20,
  educatorScopesAuthorized: true,
  educatorScopeShared: true,
  educatorScopeBlocked: false,
  deferredEducatorScope: { id: c1 },
  explicitEducatorScope: { id: c1 },
  effectiveEducatorScope: { id: c1, automatic: false, revision: 1 },
  adminAccessState: 'unlocked',
  fetchJson() {
    return Promise.reject({ status: 404, body: { code: 'educator_scope_unavailable' } });
  },
  birdApiUrl() { return '/scoped'; },
  adoptEducatorScope() { return true; },
  scrubEducatorScopeSurface() { unavailableScrubs += 1; },
  blockEducatorScope() {
    unavailableBlocks += 1;
    unavailableScopeContext.educatorScopeBlocked = true;
    unavailableScopeContext.effectiveEducatorScope = null;
    unavailableScrubs += 1;
  },
  syncEducatorScopePill() {},
  resetScopedDataCaches() { unavailableScopeContext.educatorScopeGeneration += 1; },
  refreshAll() { unavailableRefreshes += 1; },
  writeLS() {},
  removeLS() {},
  showAdminLocked() {},
  signalAdminLock() {},
  setTimeout(callback) { callback(); },
};
vm.createContext(unavailableScopeContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('validEducatorScopeKey'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeFromPayload'),
  functionSource('educatorScopeId'),
  functionSource('applyEducatorScope'),
  functionSource('scopedFetchJson'),
].join('\n'), unavailableScopeContext);
await assert.rejects(unavailableScopeContext.scopedFetchJson('recent', {}, {
  scopeId: c1, generation: 20,
}));
assert.equal(unavailableScopeContext.effectiveEducatorScope, null,
  'a shared saved-scope 404 clears the unavailable dataset');
assert.equal(unavailableBlocks, 1,
  'a shared saved-scope 404 leaves its capability route in a blocked state');
assert.equal(unavailableScrubs, 1,
  'a shared saved-scope 404 closes its postcard before showing unavailable state');
assert.equal(unavailableRefreshes, 0,
  'a deleted or disabled shared scope never falls through to station-wide data');
assert.match(functionSource('blockEducatorScope'), /resetScopedDataCaches\(\)[\s\S]*syncEducatorScopePill/,
  'blocking a shared scope invalidates every concurrent request before unavailable state paints');

for (const response of [
  {
    status: 404,
    body: { error: 'not found', educator_scope: null },
    label: 'disabled Educators profile',
  },
  {
    status: 409,
    body: { error: 'saved view unavailable', educator_scope: null },
    label: 'unavailable saved view',
  },
]) {
  let sharedScopeScrubs = 0;
  let sharedScopeFallbacks = 0;
  const sharedScopeLoading = {
    views: { setAttribute() {} },
    educatorDataLoading: { hidden: false, textContent: 'loading birds...' },
  };
  const sharedScopeContext = {
    AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
    educatorScopeGeneration: 24,
    educatorScopeShared: true,
    educatorScopeBlocked: false,
    explicitEducatorScope: { id: f1 },
    effectiveEducatorScope: { id: f1 },
    educatorDataLoading: true,
    adminAccessState: 'locked',
    document: {
      body: { classList: { toggle() {} } },
      getElementById(id) { return sharedScopeLoading[id] || null; },
    },
    fetchJson() { return Promise.reject(response); },
    birdApiUrl() { return '/?edu=' + f1; },
    adoptEducatorScope() { return true; },
    educatorScopeFromPayload() { return undefined; },
    scrubEducatorScopeSurface() { sharedScopeScrubs += 1; },
    resetScopedDataCaches() { sharedScopeContext.educatorScopeGeneration += 1; },
    syncEducatorScopePill() {},
    applyEducatorScope() { sharedScopeFallbacks += 1; },
    refreshAll() { sharedScopeFallbacks += 1; },
    showAdminLocked() {},
    signalAdminLock() {},
    setTimeout(callback) { callback(); },
  };
  vm.createContext(sharedScopeContext);
  vm.runInContext([
    functionSource('validEducatorId'),
    functionSource('educatorScopeId'),
    functionSource('setEducatorDataLoading'),
    functionSource('blockEducatorScope'),
    functionSource('scopedFetchJson'),
  ].join('\n'), sharedScopeContext);
  await assert.rejects(sharedScopeContext.scopedFetchJson('recent', {}, {
    scopeId: f1, generation: 24,
  }));
  assert.equal(sharedScopeScrubs, 1,
    `${response.label} response scrubs the fresh shared scope`);
  assert.equal(sharedScopeContext.educatorScopeBlocked, true,
    `${response.label} response leaves its shared scope fail closed`);
  assert.equal(sharedScopeLoading.educatorDataLoading.textContent, 'listening period unavailable',
    `${response.label} response resolves the indefinite loading message`);
  assert.equal(sharedScopeFallbacks, 0,
    `${response.label} response never exposes station-wide data`);
}

let privateRouteClears = 0;
let surfaceScrubs = 0;
const scopeSurfaceContext = {
  validEducatorId(value) { return value === c1 || value === f1; },
  readHash() { return 'Private bird'; },
  clearSciHash() { privateRouteClears += 1; },
  scrubPrivateEducatorPostcard() { surfaceScrubs += 1; },
};
vm.createContext(scopeSurfaceContext);
vm.runInContext(functionSource('scrubEducatorScopeSurface'), scopeSurfaceContext);
scopeSurfaceContext.scrubEducatorScopeSurface(c1);
assert.equal(privateRouteClears, 1,
  'private scope loss cancels a delayed species deep link before it can reopen an old card');
assert.equal(surfaceScrubs, 1, 'private scope loss also scrubs an already-open postcard');
scopeSurfaceContext.scrubEducatorScopeSurface('active');
assert.equal(privateRouteClears, 1, 'the generic public active route is not treated as a saved private route');

const cardGuardContext = {
  educatorScopesAuthorized: true,
  educatorScopeShared: false,
  educatorScopeGeneration: 31,
  validEducatorId(value) { return value === c1 || value === f1; },
  educatorScopeId() { return c1; },
};
vm.createContext(cardGuardContext);
vm.runInContext(functionSource('privateEducatorCardCurrent'), cardGuardContext);
const currentPrivateCard = { dataset: { edu: c1, eduGeneration: '31' } };
assert.equal(cardGuardContext.privateEducatorCardCurrent(currentPrivateCard), true,
  'a current authorized saved-scope card can open');
cardGuardContext.educatorScopesAuthorized = false;
assert.equal(cardGuardContext.privateEducatorCardCurrent(currentPrivateCard), false,
  'a queued click cannot reopen a saved-scope card after authorization is lost');
cardGuardContext.educatorScopeShared = true;
assert.equal(cardGuardContext.privateEducatorCardCurrent(currentPrivateCard), true,
  'the same current card remains available through its anonymous shared capability');
currentPrivateCard.dataset.eduGeneration = '30';
assert.equal(cardGuardContext.privateEducatorCardCurrent(currentPrivateCard), false,
  'a card from the previous scoped generation cannot reopen');
assert.equal(cardGuardContext.privateEducatorCardCurrent({ dataset: { edu: 'active' } }), true,
  'the saved-scope guard does not block a generic public active card');
assert.match(apt, /function openClassicPostcard\(card, options\) \{[\s\S]{0,500}privateEducatorCardCurrent\(card\)/,
  'classic cards enforce the saved-scope authorization guard');
assert.match(apt, /function openPostcard\(card, options\) \{[\s\S]{0,500}privateEducatorCardCurrent\(card\)/,
  'stamp cards enforce the saved-scope authorization guard');

const scrubNodes = Object.create(null);
function scrubNode(text = 'private') {
  const attributes = { src: 'private.webp', 'data-sci': 'Private bird' };
  return {
    textContent: text,
    alt: 'private bird',
    hidden: false,
    removed: false,
    childrenCleared: false,
    classList: { add() {}, remove() {} },
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; },
    replaceChildren() { this.childrenCleared = true; },
    remove() { this.removed = true; },
    attributes,
  };
}
for (const id of [
  'modalCommon', 'modalSci', 'modalRecCount', 'modalAllTime', 'modalFirstSeen',
  'modalFamily', 'modalGenus', 'modalSpecies', 'modalRarity', 'modalDesc',
  'modalRecordings', 'modalImg', 'modalWiki', 'modalEbird', 'modalGenerate',
]) scrubNodes[id] = scrubNode();
const scrubSlot = scrubNode();
const scrubModal = scrubNode();
scrubModal.attributes['aria-hidden'] = 'false';
scrubModal.querySelector = () => scrubSlot;
const distinctive = scrubNode();
let scrubHashClears = 0;
let scrubStops = 0;
const scrubContext = {
  activePostcardEducatorScope: c1,
  activePostcardSci: 'Private bird',
  POSTCARD_IMAGE_REQUEST: 4,
  POSTCARD_CONTENT_REQUEST: 7,
  postcardShellSequence: 2,
  postcardCloseTimer: 9,
  postcardModal: scrubModal,
  postcardSlot: scrubSlot,
  document: {
    body: { classList: { remove() {} } },
    getElementById(id) { return id === 'postcard-modal' ? scrubModal : scrubNodes[id] || null; },
    querySelector(selector) { return selector === '.postcard-about .about-distinctive' ? distinctive : null; },
  },
  validEducatorId(value) { return value === c1 || value === f1; },
  stopModalAudio() { scrubStops += 1; },
  resetPostcardDrawer() {},
  releasePostcardFlight() {},
  releaseClassicPostcardMotion() {},
  settlePostcardPanels() {},
  clearSciHash() { scrubHashClears += 1; },
  clearTimeout() {},
};
vm.createContext(scrubContext);
vm.runInContext(functionSource('scrubPrivateEducatorPostcard'), scrubContext);
assert.equal(scrubContext.scrubPrivateEducatorPostcard(), true,
  'a saved-scope postcard is synchronously scrubbed during auth loss');
assert.equal(scrubModal.attributes['aria-hidden'], 'true', 'the private postcard is hidden without a close animation');
assert.equal(scrubNodes.modalCommon.textContent, '', 'the private common name is removed from the hidden modal DOM');
assert.equal(scrubNodes.modalRecordings.childrenCleared, true, 'private recording rows are removed immediately');
assert.equal('src' in scrubNodes.modalImg.attributes, false, 'the private illustration source is removed');
assert.equal(scrubContext.POSTCARD_CONTENT_REQUEST, 8, 'late species responses are invalidated before scrubbing');
assert.equal(scrubContext.activePostcardEducatorScope, '', 'the modal retains no private scope identifier');
assert.equal(scrubStops, 1, 'private postcard audio stops during the synchronous scrub');
assert.equal(scrubHashClears, 1, 'the private species history state is replaced during the scrub');
scrubNodes.modalCommon.textContent = 'Public bird';
scrubContext.activePostcardEducatorScope = 'active';
assert.equal(scrubContext.scrubPrivateEducatorPostcard(), false,
  'the public automatic scope is not mislabeled as a saved private scope');
assert.equal(scrubNodes.modalCommon.textContent, 'Public bird', 'a non-private postcard is not scrubbed by this guard');
assert.match(functionSource('populatePostcard'), /activePostcardEducatorScope = renderedScopeId/,
  'the postcard records the exact scope carried by its rendered card');
assert.match(functionSource('closePostcard'), /setAttribute\('aria-hidden', 'true'\);[\s\S]*activePostcardEducatorScope = ''/,
  'the scope guard survives the close animation until private postcard pixels are hidden');
assert.match(functionSource('suspendEducatorScopes'), /scrubEducatorScopeSurface\(educatorScopeId\(\)\)[\s\S]*effectiveEducatorScope = null/,
  'the common auth-loss path scrubs a private postcard before clearing its scope');
assert.match(functionSource('showAdminLocked'), /dismissAdminMapPickers\(\)[\s\S]*suspendEducatorScopes/,
  'auth loss removes private map and postcard overlays before the public refresh');

const speciesCacheContext = {
  validEducatorScopeKey(value) { return value === 'active' || value === f1 || value === c1; },
};
vm.createContext(speciesCacheContext);
vm.runInContext(functionSource('educatorSpeciesCacheAllowed'), speciesCacheContext);
assert.equal(speciesCacheContext.educatorSpeciesCacheAllowed('active'), false,
  'active listening periods never reuse postcard detections');
assert.equal(speciesCacheContext.educatorSpeciesCacheAllowed(f1), false,
  'folders with an open period never reuse postcard detections');
assert.equal(speciesCacheContext.educatorSpeciesCacheAllowed(''), true,
  'the station-wide postcard cache remains available');
assert.match(functionSource('populatePostcard'), /cacheSpecies = educatorSpeciesCacheAllowed\(speciesScope\)/,
  'postcards use the live-scope cache policy');
assert.match(apt, /data-detection=/, 'species rows retain the exact detection ID');
assert.match(apt, /mediaApiUrl\('spectrogram', \{ file: file, detection: detection \}, rowScope\)/,
  'scoped spectrograms require the exact detection row');
assert.match(apt, /var recentBySci = \{\}/, 'Atlas carries recent detection metadata into cards');
assert.match(apt, /data-edu-generation=/, 'Atlas cards retain the dataset generation that rendered them');
assert.match(functionSource('populatePostcard'), /renderedScopeId[\s\S]*speciesRequest = \{[\s\S]*scopeId: speciesScope,[\s\S]*generation: renderedScopeGeneration,[\s\S]*stateKey: renderedStateKey,[\s\S]*stateRevision: renderedStateRevision/,
  'postcards request the exact scope and generation carried by their source card');
assert.match(apt, /data-detection=[\s\S]*data-edu=/, 'recording rows retain their postcard scope beside the exact detection ID');
assert.match(functionSource('recordingSources'), /mediaApiUrl\('recording',[\s\S]*rowScope\)/,
  'postcard audio remains bound to its rendered dataset if the current scope changes');
const recordingContext = {
  validEducatorScopeKey(value) { return value === c1 || value === c2 || value === 'active'; },
  educatorDetectionId(value) { return Number(value); },
  mediaApiUrl(endpoint, params, scope) { return `${endpoint}:${params.detection}:${scope}`; },
};
vm.createContext(recordingContext);
vm.runInContext(functionSource('recordingSources'), recordingContext);
assert.deepEqual(JSON.parse(JSON.stringify(recordingContext.recordingSources({
  dataset: { file: 'bird.mp3', detection: '77', edu: c1 },
}))), [`recording:77:${c1}`], 'a postcard opened before a scope change keeps its original exact media scope');

assert.match(apt, /var liveAudioController = \(function/, 'drawer and Educators share one live player');
assert.match(apt, /educator-audio\.php/, 'protected audio validates the Educators proxy path');
assert.match(functionSource('mount'), /data-live-audio-toggle/,
  'the shared live control exposes a stable keyboard-focus identity');
assert.match(functionSource('syncCanvasExpansion'), /state !== 'playing'[\s\S]*aria-hidden', 'true'[\s\S]*else if \(expandable\)[\s\S]*setAttribute\('role', 'button'\)[\s\S]*setAttribute\('aria-expanded'/,
  'the spectrogram becomes an announced expansion control only while audio is playing');
assert.match(functionSource('syncCanvasExpansion'), /Restore live microphone spectrogram'[\s\S]*Expand live microphone spectrogram'/,
  'the spectrogram control has an honest size-neutral accessible name at every breakpoint');
assert.doesNotMatch(functionSource('syncCanvasExpansion'), /spectrogram width|Widen live/,
  'narrow screens never announce a width change they cannot show');
assert.match(functionSource('syncCanvasExpansion'), /state !== 'playing'[\s\S]*removeAttribute\('tabindex'\)[\s\S]*setAttribute\('aria-hidden', 'true'\)/,
  'the idle educator spectrogram is removed from keyboard and accessibility navigation');
assert.match(functionSource('mount'), /canvas\.addEventListener\('click'[\s\S]*state === 'playing'[\s\S]*setCanvasExpanded[\s\S]*canvas\.addEventListener\('keydown'[\s\S]*event\.key !== 'Enter'[\s\S]*event\.key !== ' '/,
  'the playing spectrogram widens by pointer, Enter, or Space through one shared controller');
assert.match(apt, /var liveAudioController = \(function[\s\S]*function stop\(preserveAudio\)[\s\S]*options\.expandable && options\.expanded[\s\S]*setCanvasExpanded\(false\)/,
  'stopping live audio always restores the compact educator column');
assert.ok(functionSource('connect').indexOf('blessProtectedAudio()') < functionSource('connect').indexOf('streamUrl().then'),
  'the protected media element is blessed synchronously before awaiting its grant');

function liveNode() {
  return {
    attrs: {},
    innerHTML: '',
    textContent: '',
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
  };
}
const terminalCanvas = liveNode();
terminalCanvas.width = 10;
terminalCanvas.height = 4;
terminalCanvas.getContext = () => ({ fillStyle: '', fillRect() {} });
const terminalButton = liveNode();
const terminalBox = liveNode();
const terminalStatus = liveNode();
let terminalFocusMoves = 0;
const terminalFailureContext = {
  canvas: terminalCanvas,
  button: terminalButton,
  box: terminalBox,
  status: terminalStatus,
  document: { activeElement: terminalCanvas, documentElement: {} },
  options: { expandable: true, expanded: true },
  state: 'playing',
  reconnectTimer: null,
  attempt: 0,
  frame: null,
  audio: null,
  source: null,
  analyser: null,
  playIcon: '<svg></svg>',
  audioRelease() {},
  focusEl(target) {
    terminalFocusMoves += 1;
    terminalFailureContext.document.activeElement = target;
  },
  getComputedStyle() { return { getPropertyValue() { return '#eeeeee'; } }; },
  clearTimeout() {},
  cancelAnimationFrame() {},
};
vm.createContext(terminalFailureContext);
vm.runInContext([
  functionSource('setStatus'),
  functionSource('syncCanvasExpansion'),
  functionSource('setCanvasExpanded'),
  functionSource('quietCanvas'),
  functionSource('stop', apt.indexOf('var liveAudioController')),
  functionSource('unavailable'),
].join('\n'), terminalFailureContext);
terminalFailureContext.syncCanvasExpansion();
assert.equal(terminalCanvas.attrs.role, 'button',
  'a focused playing desktop spectrogram begins as an expansion control');
terminalFailureContext.unavailable();
assert.equal(terminalFailureContext.document.activeElement, terminalButton,
  'terminal stream failure moves focus to the visible Retry control before hiding the canvas');
assert.equal(terminalFocusMoves, 1, 'terminal failure performs one deterministic focus handoff');
assert.equal(terminalCanvas.attrs['aria-hidden'], 'true',
  'the failed stream canvas leaves the accessibility tree after focus moves');
assert.equal('tabindex' in terminalCanvas.attrs, false,
  'the failed stream canvas is no longer keyboard reachable');
assert.equal(terminalButton.attrs['aria-label'], 'Retry live audio',
  'the focus destination exposes the terminal Retry action');

let blessingPlayCalls = 0;
let blessingResumeCalls = 0;
const blessedAudio = {
  play() { blessingPlayCalls += 1; return { catch() {} }; },
};
function MockAudioContext() {
  this.state = 'suspended';
  this.resume = () => { blessingResumeCalls += 1; this.state = 'running'; };
}
const blessingContext = {
  audio: null,
  audioContext: null,
  Audio: function Audio() { return blessedAudio; },
  window: { AudioContext: MockAudioContext },
  silentWav: 'data:audio/wav;base64,test',
};
vm.createContext(blessingContext);
vm.runInContext(functionSource('blessProtectedAudio'), blessingContext);
blessingContext.blessProtectedAudio();
assert.equal(blessingPlayCalls, 1, 'protected playback starts inside the direct click stack');
assert.equal(blessedAudio.src, 'data:audio/wav;base64,test', 'the same media element is primed before the grant fetch');
assert.equal(blessedAudio.muted, false, 'the silent primer grants the persistent element audible playback permission');
assert.equal(blessingResumeCalls, 1, 'the audio context is also resumed inside user activation');

let duplicateMediaSources = 0;
let reconnectPaints = 0;
const graphContext = {
  audio: {},
  audioContext: {
    state: 'running',
    createMediaElementSource() { duplicateMediaSources += 1; throw new Error('duplicate source'); },
  },
  source: { connect() {} },
  analyser: { connect() {} },
  window: { AudioContext() {} },
  paint() { reconnectPaints += 1; },
};
vm.createContext(graphContext);
vm.runInContext(functionSource('attachAnalyser'), graphContext);
graphContext.attachAnalyser();
assert.equal(duplicateMediaSources, 0, 'EOF reconnect reuses the media element graph instead of creating a forbidden second source');
assert.equal(reconnectPaints, 1, 'the preserved graph restarts the spectrogram after regrant');

const cancelledFrames = [];
const paintContext = {
  frame: 44,
  canvas: {
    width: 10,
    height: 4,
    getContext() {
      return {
        fillStyle: '',
        fillRect() {},
        getImageData() { return {}; },
        putImageData() {},
      };
    },
  },
  analyser: { frequencyBinCount: 32, getByteFrequencyData() {} },
  document: { documentElement: {} },
  getComputedStyle() {
    return { getPropertyValue(name) { return name === '--ink' ? '#111111' : '#eeeeee'; } };
  },
  cancelAnimationFrame(id) { cancelledFrames.push(id); },
  requestAnimationFrame() { return 45; },
  Uint8Array,
};
vm.createContext(paintContext);
vm.runInContext([functionSource('rgb'), functionSource('paint')].join('\n'), paintContext);
paintContext.paint();
assert.deepEqual(cancelledFrames, [44], 'theme repaint cancels the previous spectrogram RAF loop');
assert.equal(paintContext.frame, 45, 'theme repaint leaves exactly one replacement RAF loop');

let reconnects = 0;
let unavailableCalls = 0;
const reconnectTimers = [];
const reconnectContext = {
  options: { protectedStream: true },
  earlyFailures: 0,
  attempt: 0,
  reconnectTimer: null,
  host: {},
  stop(preserve) { assert.equal(preserve, true); reconnectContext.attempt += 1; },
  unavailable() { unavailableCalls += 1; },
  connect(retry) { assert.equal(retry, true); reconnects += 1; reconnectContext.attempt += 1; },
  setTimeout(callback, delay) { reconnectTimers.push({ callback, delay }); return reconnectTimers.length; },
};
vm.createContext(reconnectContext);
vm.runInContext(functionSource('recoverStream'), reconnectContext);
reconnectContext.recoverStream(true);
const firstReconnect = reconnectTimers.shift();
assert.equal(firstReconnect.delay, 300, 'established stream EOF uses a small reconnect backoff');
firstReconnect.callback();
reconnectContext.recoverStream(true);
reconnectTimers.shift().callback();
assert.equal(reconnects, 2, 'two consecutive clean proxy caps each obtain a fresh grant');
assert.equal(unavailableCalls, 0, 'established clean EOFs do not strand the live button');

let stableUnmounts = 0;
const stableHost = { contains() { return true; } };
const mountContext = {
  host: stableHost,
  mountProtected: true,
  box: {},
  options: { protectedStream: true },
  syncCanvasExpansion() {},
  unmount() { stableUnmounts += 1; },
};
vm.createContext(mountContext);
vm.runInContext(functionSource('mount'), mountContext);
mountContext.mount(stableHost, { protectedStream: true });
mountContext.mount(stableHost, { protectedStream: true });
assert.equal(stableUnmounts, 0, '10-second polls and state repaints preserve the active singleton stream');
assert.match(functionSource('replaceEducatorBody'), /replaceChild\(currentLive, nextLive\)/,
  'Educators state paints carry the stable live host across renamed and moved rows');
assert.equal((apt.match(/function startAudio\(/g) || []).length, 0, 'the old duplicate drawer player is removed');
assert.match(functionSource('showAdminLocked'), /stopLiveAudioNow\(\)/, 'admin lock revokes the live player immediately');

for (const [datasetKey, attribute, value] of [
  ['viewCapture', 'data-view-capture', c1],
  ['educatorMenuId', 'data-educator-menu-id', c1],
  ['educatorAction', 'data-educator-action', 'stop'],
]) {
  const focused = { dataset: { [datasetKey]: value } };
  if (datasetKey === 'educatorAction') focused.dataset.id = c1;
  const focusContext = {
    educatorFocusSelector: '',
    adminBody: { contains() { return true; } },
    document: { activeElement: focused },
    validEducatorId(candidate) { return candidate === c1; },
  };
  vm.createContext(focusContext);
  vm.runInContext(functionSource('rememberEducatorFocus'), focusContext);
  focusContext.rememberEducatorFocus();
  assert.match(focusContext.educatorFocusSelector, new RegExp(`${attribute}="${value}"`),
    `${attribute} receives a stable logical focus target`);
}

for (const [selector, label] of [
  ['[data-educator-start-submit]', 'Start submit arrow'],
  ['[data-educator-saved]', 'keyboard-scrollable saved pane'],
]) {
  const before = { matches(candidate) { return candidate === selector; } };
  const after = { closest() { return null; } };
  let restored = null;
  const stableControlContext = {
    educatorFocusSelector: '',
    adminBody: {
      contains(candidate) { return candidate === before; },
      querySelector(candidate) { return candidate === selector ? after : null; },
    },
    document: { activeElement: before },
    validEducatorId() { return false; },
    focusEl(target) { restored = target; },
  };
  vm.createContext(stableControlContext);
  vm.runInContext([
    functionSource('rememberEducatorFocus'),
    functionSource('restoreEducatorFocus'),
  ].join('\n'), stableControlContext);
  stableControlContext.rememberEducatorFocus();
  assert.equal(stableControlContext.educatorFocusSelector, selector,
    `${label} receives a stable repaint selector`);
  assert.equal(stableControlContext.restoreEducatorFocus(), true,
    `${label} resolves after an authoritative repaint`);
  assert.equal(restored, after, `${label} regains focus on its replacement control`);
}
assert.match(functionSource('replaceEducatorBody'), /savedScroll[\s\S]*nextSaved\.scrollTop = savedScroll/,
  'a focused saved pane keeps its exact scroll offset through the same repaint');

const focusedMenuItem = {};
const popoverFocusContext = {
  educatorFocusSelector: '',
  educatorActionMenuState: {
    id: c1,
    menu: { contains(candidate) { return candidate === focusedMenuItem; } },
  },
  educatorMoveState: null,
  adminBody: {
    contains(candidate) { return candidate === focusedMenuItem; },
    querySelector() { return null; },
  },
  document: { activeElement: focusedMenuItem },
  validEducatorId(value) { return value === c1; },
};
vm.createContext(popoverFocusContext);
vm.runInContext(functionSource('rememberEducatorFocus'), popoverFocusContext);
popoverFocusContext.rememberEducatorFocus();
assert.equal(popoverFocusContext.educatorFocusSelector,
  `#educator-${c1} [data-educator-menu-trigger]`,
  'a state-changing poll returns action-menu focus to the matching row trigger');
popoverFocusContext.educatorFocusSelector = '';
popoverFocusContext.educatorActionMenuState = null;
popoverFocusContext.educatorMoveState = {
  id: c1,
  popover: { contains(candidate) { return candidate === focusedMenuItem; } },
};
popoverFocusContext.rememberEducatorFocus();
assert.equal(popoverFocusContext.educatorFocusSelector,
  `#educator-${c1} [data-educator-menu-trigger]`,
  'a state-changing poll returns move-dialog focus to its matching row trigger');

const collapsedFocusCaret = {};
const collapsedFocusFolder = { querySelector(selector) {
  return selector === '[data-folder-toggle]' ? collapsedFocusCaret : null;
} };
const collapsedFocusBody = { closest(selector) {
  return selector === '.educator-folder' ? collapsedFocusFolder : null;
} };
const hiddenCaptureControl = { closest(selector) {
  return selector === '.educator-folder-body[hidden]' ? collapsedFocusBody : null;
} };
let collapsedFocusTarget = null;
const collapsedRestoreContext = {
  educatorFocusSelector: `#educator-${c1} [data-view-capture]`,
  adminBody: { querySelector() { return hiddenCaptureControl; } },
  focusEl(target) { collapsedFocusTarget = target; },
};
vm.createContext(collapsedRestoreContext);
vm.runInContext(functionSource('restoreEducatorFocus'), collapsedRestoreContext);
assert.equal(collapsedRestoreContext.restoreEducatorFocus(), true,
  'a valid hidden-row focus request still resolves after paging or a cross-tab move');
assert.equal(collapsedFocusTarget, collapsedFocusCaret,
  'focus for a row inside a collapsed folder falls back to that folder caret');

const draftInput = {
  id: 'educatorFolderName',
  value: 'Period 4 projects',
  dataset: {},
  matches() { return false; },
};
const draftContext = {
  educatorFolderDraft: '',
  educatorFocusSelector: '',
  adminBody: {
    contains(candidate) { return candidate === draftInput; },
    querySelector(selector) { return selector === '#educatorFolderName' ? draftInput : null; },
  },
  document: { activeElement: draftInput },
  validEducatorId() { return false; },
};
vm.createContext(draftContext);
vm.runInContext(functionSource('rememberEducatorFocus'), draftContext);
draftContext.rememberEducatorFocus();
assert.equal(draftContext.educatorFolderDraft, 'Period 4 projects',
  'a state repaint snapshots the unsaved folder draft before replacing the form');
assert.equal(draftContext.educatorFocusSelector, '#educatorFolderName',
  'the preserved folder draft also restores its keyboard focus');
assert.match(functionSource('paintEducators'), /value="' \+ adminAttr\(educatorFolderDraft\)/,
  'the replacement folder input receives the escaped unsaved draft');
assert.match(functionSource('paintEducators'), /educatorFolderComposerOpen[\s\S]*educatorNewFolder[\s\S]*data-folder-create-cancel[\s\S]*:\s*''/,
  'the new-folder composer exists only after Create new folder and includes Cancel');
assert.match(functionSource('wireEducators'), /elements\.name\.addEventListener\('input'[\s\S]*educatorFolderDraft/,
  'typing updates the folder draft before any background poll can repaint');
assert.match(functionSource('wireEducators'), /var submittedDraft[\s\S]*educatorPost\('create-folder'[\s\S]*clearSubmittedEducatorFolderDraft\(submittedDraft\)/,
  'folder creation remembers the exact submitted draft until the request succeeds');
assert.match(functionSource('clearSubmittedEducatorFolderDraft'), /educatorFolderDraft !== submittedDraft[\s\S]*querySelector\('#educatorFolderName'\)[\s\S]*current\.value = ''[\s\S]*educatorFolderDraft = ''/,
  'successful creation clears only an unchanged draft on the current live form');

let liveFolder = null;
const folderPostRequests = [];
let folderFinishCalls = 0;
let folderErrors = 0;
const draftsAtAuthoritativeReload = [];
const focusAtAuthoritativeReload = [];
const createdFolderId = `f_${'b'.repeat(32)}`;
function replaceLiveFolder(value) {
  const handlers = {};
  const input = {
    id: 'educatorFolderName',
    value,
    dataset: {},
    matches() { return false; },
    addEventListener(type, handler) { handlers[type] = handler; },
  };
  const form = {
    elements: { name: input },
    addEventListener(type, handler) { handlers[type] = handler; },
  };
  liveFolder = { input, form, handlers };
  return liveFolder;
}
replaceLiveFolder('Period 4');
const folderWorkflowContext = {
  educatorFolderDraft: '',
  educatorFolderComposerOpen: true,
  educatorFocusSelector: '',
  adminBody: {
    contains(candidate) { return candidate === liveFolder.input; },
    querySelector(selector) {
      if (selector === '#educatorNewFolder') return liveFolder.form;
      if (selector === '#educatorFolderName') return liveFolder.input;
      return null;
    },
    querySelectorAll() { return []; },
  },
  document: { activeElement: liveFolder.input },
  validEducatorId() { return false; },
  focusEl() {},
  educatorPost(action, fields) {
    assert.equal(action, 'create-folder', 'the folder workflow posts the create action');
    return new Promise((resolve, reject) => {
      folderPostRequests.push({ fields, resolve, reject });
    });
  },
  wireEducatorExport() {},
  finishEducatorAction(message) {
    assert.equal(message, 'Folder created.', 'a successful folder workflow reports its result');
    folderFinishCalls += 1;
    folderWorkflowContext.rememberEducatorFocus();
    draftsAtAuthoritativeReload.push(folderWorkflowContext.educatorFolderDraft);
    focusAtAuthoritativeReload.push(folderWorkflowContext.educatorFocusSelector);
    return Promise.resolve();
  },
  handleEducatorActionError() { folderErrors += 1; },
};
vm.createContext(folderWorkflowContext);
vm.runInContext([
  functionSource('rememberEducatorFocus'),
  functionSource('restoreEducatorFocus'),
  functionSource('clearSubmittedEducatorFolderDraft'),
  functionSource('wireEducators'),
].join('\n'), folderWorkflowContext);
folderWorkflowContext.wireEducators();

liveFolder.handlers.input();
folderWorkflowContext.rememberEducatorFocus();
assert.equal(folderWorkflowContext.educatorFolderDraft, 'Period 4',
  'a background poll preserves the current new-folder draft');
assert.equal(folderWorkflowContext.educatorFolderComposerOpen, true,
  'a background poll keeps an open new-folder composer open');
assert.equal(folderWorkflowContext.educatorFocusSelector, '#educatorFolderName',
  'a background poll preserves focus on the new-folder draft');

const submittedFolder = liveFolder;
submittedFolder.handlers.submit({ preventDefault() {} });
assert.equal(folderPostRequests[0].fields.name, 'Period 4',
  'the first folder request captures the submitted name');

folderWorkflowContext.rememberEducatorFocus();
const pollReplacement = replaceLiveFolder(folderWorkflowContext.educatorFolderDraft);
folderWorkflowContext.document.activeElement = pollReplacement.input;
folderWorkflowContext.wireEducators();
folderWorkflowContext.restoreEducatorFocus();
assert.notEqual(pollReplacement.input, submittedFolder.input,
  'the pending poll replaces the form before create-folder succeeds');
assert.equal(pollReplacement.input.value, 'Period 4',
  'the pending poll paints the submitted draft into the replacement form');

folderPostRequests[0].resolve({ result: { folder: { id: createdFolderId } } });
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(submittedFolder.input.value, 'Period 4',
  'the submitted field is detached and cannot be relied on for clearing');
assert.equal(pollReplacement.input.value, '',
  'successful creation clears the matching draft from the current live form');
assert.equal(folderWorkflowContext.educatorFolderDraft, '',
  'successful folder creation leaves no preserved draft to repaint');
assert.equal(folderWorkflowContext.educatorFolderComposerOpen, false,
  'successful folder creation closes the composer');
assert.equal(draftsAtAuthoritativeReload[0], '',
  'the authoritative reload cannot snapshot the submitted folder name again');
assert.equal(focusAtAuthoritativeReload[0], `#educator-${createdFolderId} [data-folder-heading]`,
  'an exact successful create moves focus to the created folder');
assert.equal(folderFinishCalls, 1, 'the successful folder workflow reloads exactly once');
assert.equal(folderErrors, 0, 'the successful folder workflow reports no error');

folderWorkflowContext.educatorFolderComposerOpen = true;
pollReplacement.input.value = 'Period 5';
pollReplacement.handlers.input();
folderWorkflowContext.educatorFocusSelector = '';
pollReplacement.handlers.submit({ preventDefault() {} });
assert.equal(folderPostRequests[1].fields.name, 'Period 5',
  'the second folder request captures its own submitted name');
folderWorkflowContext.rememberEducatorFocus();
const newerDraftReplacement = replaceLiveFolder(folderWorkflowContext.educatorFolderDraft);
folderWorkflowContext.document.activeElement = newerDraftReplacement.input;
folderWorkflowContext.wireEducators();
folderWorkflowContext.restoreEducatorFocus();
newerDraftReplacement.input.value = 'Period 6';
newerDraftReplacement.handlers.input();
folderPostRequests[1].resolve({ result: { folder: { id: `f_${'c'.repeat(32)}` } } });
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(newerDraftReplacement.input.value, 'Period 6',
  'an intentionally different draft survives an earlier request succeeding');
assert.equal(folderWorkflowContext.educatorFolderDraft, 'Period 6',
  'the stored draft also preserves newer text after an earlier success');
assert.equal(folderWorkflowContext.educatorFolderComposerOpen, true,
  'a genuinely newer draft keeps its composer open after the older success');
assert.equal(draftsAtAuthoritativeReload[1], 'Period 6',
  'the authoritative reload keeps a genuinely newer folder draft');
assert.equal(focusAtAuthoritativeReload[1], '#educatorFolderName',
  'the authoritative reload keeps focus in a genuinely newer folder draft');

folderWorkflowContext.educatorFocusSelector = '';
newerDraftReplacement.handlers.submit({ preventDefault() {} });
assert.equal(folderPostRequests[2].fields.name, 'Period 6',
  'the failed folder request captures the retryable name');
folderWorkflowContext.rememberEducatorFocus();
const failedDraftReplacement = replaceLiveFolder(folderWorkflowContext.educatorFolderDraft);
folderWorkflowContext.document.activeElement = failedDraftReplacement.input;
folderWorkflowContext.wireEducators();
folderWorkflowContext.restoreEducatorFocus();
folderPostRequests[2].reject(new Error('offline'));
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(failedDraftReplacement.input.value, 'Period 6',
  'failed folder creation preserves the live field for retry');
assert.equal(folderWorkflowContext.educatorFolderDraft, 'Period 6',
  'failed folder creation preserves the saved draft for retry');
assert.equal(folderWorkflowContext.educatorFolderComposerOpen, true,
  'failed folder creation preserves the open composer for retry');
assert.equal(folderFinishCalls, 2, 'failed folder creation does not request an authoritative reload');
assert.equal(folderErrors, 1, 'failed folder creation reaches the shared error handler once');

let restoredLiveFocus = 0;
const liveToggleBeforePaint = { matches(selector) { return selector === '[data-live-audio-toggle]'; } };
const liveToggleAfterPaint = {};
const liveFocusContext = {
  educatorFocusSelector: '',
  adminBody: {
    contains(candidate) { return candidate === liveToggleBeforePaint; },
    querySelector(selector) {
      return selector === '[data-educator-live] [data-live-audio-toggle]' ? liveToggleAfterPaint : null;
    },
  },
  document: { activeElement: liveToggleBeforePaint },
  validEducatorId() { return false; },
  focusEl(target) { if (target === liveToggleAfterPaint) restoredLiveFocus += 1; },
};
vm.createContext(liveFocusContext);
vm.runInContext([
  functionSource('rememberEducatorFocus'),
  functionSource('restoreEducatorFocus'),
].join('\n'), liveFocusContext);
liveFocusContext.rememberEducatorFocus();
assert.equal(liveFocusContext.educatorFocusSelector, '[data-educator-live] [data-live-audio-toggle]',
  'a focused live-audio control receives a stable repaint selector');
assert.equal(liveFocusContext.restoreEducatorFocus(), true,
  'a real state repaint finds the preserved live-audio control');
assert.equal(restoredLiveFocus, 1, 'the preserved live-audio control regains keyboard focus');
assert.match(functionSource('paintEducators'), /restoreEducatorFocus\(\)/,
  'Educators paints restore logical focus after carrying the live host forward');

const renameFocusContext = {
  educatorEditing: { kind: 'capture', id: c1 },
  educatorFocusSelector: '',
  validEducatorId(value) { return value === c1 || value === f1; },
};
vm.createContext(renameFocusContext);
vm.runInContext(functionSource('closeEducatorRename'), renameFocusContext);
renameFocusContext.closeEducatorRename('capture', c1);
assert.equal(renameFocusContext.educatorEditing, null, 'closing a rename exits edit mode');
assert.equal(renameFocusContext.educatorFocusSelector,
  `#educator-${c1} [data-educator-menu-trigger]`,
  'saved, active, and canceled capture renames return to the item action menu');
renameFocusContext.closeEducatorRename('folder', f1);
assert.equal(renameFocusContext.educatorFocusSelector,
  `#educator-${f1} [data-view-folder]`,
  'saved and canceled folder renames return to the renamed item');
assert.match(functionSource('wireEducators'), /closeEducatorRename\(kind, item\.id\)[\s\S]*finishEducatorAction/,
  'successful rename wiring restores the item focus target before repaint');
assert.match(functionSource('cancelEducatorRename'), /closeEducatorRename\(editing && editing\.kind, editing && editing\.id\)/,
  'Cancel and Escape use the same rename focus return');
let cancelPaintFocus = '';
const cancelRenameContext = {
  educatorEditing: { kind: 'capture', id: c1 },
  educatorFocusSelector: '',
  educatorPendingState: null,
  validEducatorId(value) { return value === c1; },
  paintEducators() { cancelPaintFocus = cancelRenameContext.educatorFocusSelector; },
  acceptEducatorState() {},
};
vm.createContext(cancelRenameContext);
vm.runInContext([
  functionSource('closeEducatorRename'),
  functionSource('cancelEducatorRename'),
].join('\n'), cancelRenameContext);
cancelRenameContext.cancelEducatorRename();
assert.equal(cancelPaintFocus, `#educator-${c1} [data-educator-menu-trigger]`,
  'Cancel paints with focus queued for the item that owned the inline form');

function educatorPollContext(response, acceptedResponse) {
  const status = { textContent: '', classList: { toggle() {} } };
  const context = {
    educatorStateRequest: 0,
    adminSect: 'educators',
    educatorAcceptedSignature: '',
    educatorStatusMessage: 'saved',
    educatorStatusError: false,
    educatorEditing: null,
    educatorPendingState: null,
    rememberCalls: 0,
    acceptCalls: 0,
    paintCalls: 0,
    adminBody: { querySelector(selector) { return selector === '.educator-status' ? status : null; } },
    adminJson() { return Promise.resolve(response); },
    rememberEducatorFocus() { context.rememberCalls += 1; },
    acceptEducatorState(value) {
      context.acceptCalls += 1;
      context.educatorAcceptedSignature = context.educatorStateSignature(value);
      return true;
    },
    paintEducators() { context.paintCalls += 1; },
    disableEducatorsFrontend() {},
    adminAuthCancelled() { return false; },
    liveAudioController: { unmount() {} },
    adminUnreachableHtml() { return 'unavailable'; },
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource('educatorStateSignature'),
    functionSource('updateEducatorStatus'),
    functionSource('educatorLoad'),
  ].join('\n'), context);
  context.educatorAcceptedSignature = context.educatorStateSignature(acceptedResponse || response);
  return context;
}
const baselinePoll = {
  ok: true, enabled: true, profile_epoch: 'profile', state_revision: 4,
  active: {
    id: c1, revision: 2, status: 'running', folder_id: f1,
    detection_count: 8, species_count: 3, segment_count: 1,
  },
  captures: [{
    id: c1, revision: 2, status: 'running', folder_id: f1,
    detection_count: null, species_count: null, segment_count: 1,
  }],
  folders: [{ id: f1, revision: 1, capture_count: 1 }],
  capture_page: { total: 1, more: false, next_cursor: null },
};
const identicalPoll = educatorPollContext(baselinePoll);
await identicalPoll.educatorLoad();
assert.equal(identicalPoll.paintCalls, 0,
  'an identical 10-second poll preserves View, Remove, Stop, and live player DOM focus');
assert.equal(identicalPoll.rememberCalls, 0, 'an identical state snapshot avoids any workspace replacement work');
const changedPoll = educatorPollContext({ ...baselinePoll, state_revision: 5 }, baselinePoll);
await changedPoll.educatorLoad();
assert.equal(changedPoll.rememberCalls, 1, 'a real state change captures the logical focus target before repaint');
assert.equal(changedPoll.paintCalls, 1, 'a real state change still updates the workspace');
const delayedCountPoll = educatorPollContext({
  ...baselinePoll,
  active: { ...baselinePoll.active, detection_count: 9, species_count: 4 },
}, baselinePoll);
await delayedCountPoll.educatorLoad();
assert.equal(delayedCountPoll.paintCalls, 1,
  'live active counts repaint even when the metadata revision is unchanged');
const folderCountPoll = educatorPollContext({
  ...baselinePoll,
  folders: [{ ...baselinePoll.folders[0], capture_count: 2 }],
  capture_page: { total: 2, more: false, next_cursor: null },
}, baselinePoll);
await folderCountPoll.educatorLoad();
assert.equal(folderCountPoll.paintCalls, 1,
  'folder union totals repaint when an active or delayed period changes their count');

let inlineErrorUpdates = 0;
let conflictReloads = 0;
const actionErrorContext = {
  educatorStatusMessage: 'Network unavailable.',
  educatorStatusError: true,
  adminAuthCancelled() { return false; },
  educatorLoad(options) { assert.equal(options.force, true); conflictReloads += 1; },
  updateEducatorStatus() { inlineErrorUpdates += 1; },
};
vm.createContext(actionErrorContext);
vm.runInContext(functionSource('handleEducatorActionError'), actionErrorContext);
actionErrorContext.handleEducatorActionError(new Error('Network unavailable.'));
assert.equal(inlineErrorUpdates, 1,
  'a routine action failure updates the live status region without replacing controls');
actionErrorContext.handleEducatorActionError(Object.assign(new Error('Changed'), { conflict: true }));
assert.equal(conflictReloads, 1, 'a real cross-tab revision conflict still reloads authoritative state');
assert.equal(inlineErrorUpdates, 1, 'a conflict does not announce stale local error copy before reloading');
assert.doesNotMatch(functionSource('wireEducators'), /paintEducators\(\)/,
  'action and full-screen errors do not rebuild the Educators workspace');
assert.match(functionSource('openEducatorMovePopover'), /educatorPost\('move-capture'[\s\S]*\.catch\(handleEducatorActionError\)/,
  'a failed move stays in the focused popover and uses the shared inline error');
assert.doesNotMatch(functionSource('paintEducators'), /data-educator-export|download detections|download recordings/,
  'Educators leaves downloads in Tools instead of duplicating per-scope actions');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const startRequest = deferred();
const startHandlers = {};
const startInputHandlers = {};
const startInput = {
  value: '  Biology 2  ',
  addEventListener(type, handler) { startInputHandlers[type] = handler; },
};
const startSubmitButton = {
  attrs: {},
  setAttribute(name, value) { this.attrs[name] = value; },
};
const startForm = {
  elements: { name: startInput },
  addEventListener(type, handler) { startHandlers[type] = handler; },
  querySelector(selector) { return selector === '[data-educator-start-submit]' ? startSubmitButton : null; },
};
startInput.form = startForm;
let startFetches = 0;
let startPayload = null;
let startScope = null;
let startFinishes = 0;
let startErrors = 0;
const startWorkflowContext = {
  Promise,
  educatorActionBusy: false,
  educatorState: { state_revision: 12 },
  educatorStartDraft: '',
  educatorFocusSelector: '',
  adminBody: {
    attrs: {},
    querySelector(selector) {
      if (selector === '#educatorStart') return startForm;
      if (selector === '#educatorStartName') return startInput;
      return null;
    },
    querySelectorAll() { return []; },
    setAttribute(name, value) { this.attrs[name] = value; },
  },
  adminFetch(url, options) {
    assert.equal(url, './avian/api/educators.php');
    startFetches += 1;
    startPayload = JSON.parse(options.body);
    return startRequest.promise;
  },
  adminAuthCancelled() { return false; },
  educatorScopeForEntity(entity, revision) { return { id: entity.id, label: entity.name, revision }; },
  applyEducatorScope(scope, options) { startScope = { scope, options }; },
  finishEducatorAction(message) {
    assert.equal(message, 'Listening period started.');
    startFinishes += 1;
    return Promise.resolve();
  },
  handleEducatorActionError() { startErrors += 1; },
};
vm.createContext(startWorkflowContext);
vm.runInContext([
  functionSource('educatorPost'),
  functionSource('syncEducatorStartSubmit'),
  functionSource('clearSubmittedEducatorStartDraft'),
  functionSource('wireEducators'),
].join('\n'), startWorkflowContext);
startWorkflowContext.wireEducators();
startInputHandlers.input();
assert.equal(startSubmitButton.attrs['data-has-name'], 'true',
  'typing turns the arrow from subtle to solid without replacing the control');
let startPrevented = 0;
startHandlers.submit({ preventDefault() { startPrevented += 1; } });
startHandlers.submit({ preventDefault() { startPrevented += 1; } });
assert.equal(startPrevented, 2, 'Enter and arrow submissions retain native form prevention');
assert.equal(startFetches, 1, 'a pending Start rejects duplicate keyboard or pointer submission');
assert.deepEqual(startPayload, { action: 'start', state_revision: 12, name: 'Biology 2' },
  'Start sends one atomically trimmed optional name with the current revision');
startInput.value = 'Biology 3';
startInputHandlers.input();
startRequest.resolve({
  ok: true,
  status: 200,
  json() {
    return Promise.resolve({
      ok: true,
      created: false,
      state_revision: 13,
      active: { id: c2, name: 'Already active', status: 'running' },
    });
  },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(startWorkflowContext.educatorStartDraft, 'Biology 3',
  'a newer listening-period draft survives completion of the prior Start');
assert.equal(startInput.value, 'Biology 3', 'the visible newer draft also survives the prior response');
assert.equal(startScope.scope.id, c2,
  'an idempotent Start adopts the active capture returned by the server');
assert.equal(startScope.scope.automatic, true, 'the returned active capture becomes the live automatic scope');
assert.equal(startScope.options.clearExplicit, true,
  'starting clears a stale saved scope before following the active capture');
assert.equal(startWorkflowContext.educatorFocusSelector, '[data-educator-action="pause"]',
  'a successful Start moves logical focus to the new Pause control');
assert.equal(startFinishes, 1, 'the authoritative Start response triggers one reload');
assert.equal(startErrors, 0, 'a valid idempotent Start does not enter the error path');

startInput.value = 'Biology 3';
startWorkflowContext.educatorStartDraft = 'Biology 3';
assert.equal(startWorkflowContext.clearSubmittedEducatorStartDraft('Biology 3'), true,
  'an unchanged submitted draft clears after success');
assert.equal(startInput.value, '', 'the cleared draft is removed from the live field');
assert.equal(startWorkflowContext.educatorStartDraft, '', 'the cleared draft is removed from memory');
assert.equal(startSubmitButton.attrs['data-has-name'], 'false',
  'clearing a submitted name restores the subtle default-name arrow state');

startInput.value = '   ';
startInputHandlers.input();
startHandlers.submit({ preventDefault() {} });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(startPayload, { action: 'start', state_revision: 12 },
  'blank Start omits the name so the server supplies its date and time default');

function displayModeContext({ admin = false, height = 800 } = {}) {
  const classes = new Set(admin ? ['admin-on'] : []);
  const storage = new Map();
  const timers = [];
  const overlays = {
    menu: { hidden: 'true', getAttribute() { return this.hidden; } },
    postcard: { hidden: 'true', getAttribute() { return this.hidden; } },
    about: { hidden: 'true', getAttribute() { return this.hidden; } },
  };
  const button = {
    disabled: false,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
  };
  const title = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const context = {
    DISPLAY_MODE_KEY: 'display-mode',
    DISPLAY_EDGE_PX: 96,
    DISPLAY_TOUCH_HIDE_MS: 2400,
    displayModeOn: false,
    displayPointerEdge: '',
    displayFocusEdge: '',
    displayPointerFocus: false,
    displayTouchEdge: '',
    displayTouchHideTimer: null,
    displayVisibleSignature: '',
    displayOverlayWasOpen: false,
    adminSect: admin ? 'educators' : null,
    closes: 0,
    fullscreenCalls: 0,
    location: { hash: admin ? '#admin=educators' : '', pathname: '/', search: '?edu=scope' },
    history: { replaceState(_state, _title, next) { context.replacedUrl = next; context.location.hash = ''; } },
    window: { innerHeight: height, history: {} },
    staticTitle: title,
    focusEl(target) { context.focused = target; },
    closeAdmin() { context.closes += 1; context.adminSect = null; classes.delete('admin-on'); },
    readLS(key, fallback) { return storage.get(key) || fallback; },
    writeLS(key, value) { storage.set(key, value); },
    removeLS(key) { storage.delete(key); },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    document: {
      documentElement: { requestFullscreen() { context.fullscreenCalls += 1; } },
      exitFullscreen() { context.fullscreenCalls += 1; },
      body: { classList: {
        toggle(name, on) { context.classWrites += 1; if (on) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      } },
      getElementById(id) {
        return id === 'menu-dd' ? overlays.menu
          : id === 'postcard-modal' ? overlays.postcard
            : id === 'about-modal' ? overlays.about : null;
      },
      querySelectorAll(selector) { assert.equal(selector, '[data-display-mode]'); return [button]; },
    },
    classWrites: 0,
  };
  Object.assign(context, { classes, storage, timers, overlays, button, title });
  vm.createContext(context);
  vm.runInContext([
    functionSource('displayModeEnabled'),
    functionSource('displayStoredMode'),
    functionSource('displayControlEdgeForTarget'),
    functionSource('displayEdgeForY'),
    functionSource('displayOverlayOpen'),
    functionSource('syncDisplayControlVisibility'),
    functionSource('syncDisplayOverlayVisibility'),
    functionSource('syncDisplayMode'),
    functionSource('setDisplayMode'),
    functionSource('requestDisplayMode'),
    functionSource('restoreDisplayModePreference'),
    functionSource('clearDisplayTouchEdge'),
    functionSource('showDisplayTouchEdge'),
    functionSource('handleDisplayPointerMove'),
    functionSource('handleDisplayPointerDown'),
    functionSource('handleDisplayKeyDown'),
    functionSource('handleDisplayFocusIn'),
    functionSource('handleDisplayFocusOut'),
    functionSource('toggleEducatorDisplayMode'),
  ].join('\n'), context);
  return context;
}

function displayTarget(edge = '') {
  return { closest(selector) {
    if (edge === 'top' && selector.includes('.top')) return this;
    if (edge === 'bottom' && selector.includes('#slider')) return this;
    return null;
  } };
}

const display = displayModeContext();
assert.equal(display.requestDisplayMode(true), true, 'Display Mode enables synchronously');
assert.equal(display.storage.get('display-mode'), 'on', 'the browser remembers the enabled preference');
assert.equal(display.classes.has('display-mode'), true, 'enabled mode marks the public page');
assert.equal(display.classes.has('display-top-visible'), false, 'top controls hide by default');
assert.equal(display.classes.has('display-bottom-visible'), false, 'bottom controls hide by default');
const writesBeforeTopRepeat = display.classWrites;
display.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 40 });
assert.equal(display.classes.has('display-top-visible'), true, 'the desktop top edge reveals top controls');
const writesAfterTop = display.classWrites;
display.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 40 });
assert.equal(display.classWrites, writesAfterTop, 'repeated pointer events in one edge zone perform no DOM work');
assert.equal(writesAfterTop > writesBeforeTopRepeat, true, 'entering an edge updates visibility once');
display.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 400 });
assert.equal(display.classes.has('display-top-visible'), false, 'moving away hides the top controls immediately');
display.handleDisplayPointerMove({ pointerType: 'pen', clientY: 760 });
assert.equal(display.classes.has('display-bottom-visible'), true, 'the bottom edge reveals the view selector');
display.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 400 });
assert.equal(display.classes.has('display-bottom-visible'), false, 'moving away hides the view selector');
display.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 40 });
display.handleDisplayPointerDown({ pointerType: 'mouse', clientY: 40 });
display.handleDisplayFocusIn({ target: displayTarget('top') });
display.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 400 });
assert.equal(display.classes.has('display-top-visible'), false,
  'pointer-generated focus does not pin controls after the cursor leaves');

display.handleDisplayKeyDown();
display.handleDisplayFocusIn({ target: displayTarget('top') });
assert.equal(display.classes.has('display-top-visible'), true, 'keyboard focus reveals top controls');
display.handleDisplayFocusOut({ relatedTarget: displayTarget('bottom') });
assert.equal(display.classes.has('display-top-visible'), false, 'leaving top controls hides them');
assert.equal(display.classes.has('display-bottom-visible'), true, 'keyboard focus transfers visibility to the bottom controls');
display.handleDisplayFocusOut({ relatedTarget: displayTarget() });
assert.equal(display.classes.has('display-bottom-visible'), false, 'focus leaving the controls restores the clean view');
display.handleDisplayKeyDown();
display.handleDisplayFocusIn({ target: displayTarget('top') });
display.handleDisplayPointerDown({ pointerType: 'touch', clientY: 400 });
assert.equal(display.classes.has('display-top-visible'), false,
  'a touch away from the edges clears prior keyboard-reveal state');

let touchPrevented = 0;
let touchStopped = 0;
const touchEvent = {
  pointerType: 'touch', clientY: 20, target: displayTarget(),
  preventDefault() { touchPrevented += 1; }, stopPropagation() { touchStopped += 1; },
};
display.handleDisplayPointerDown(touchEvent);
assert.equal(display.classes.has('display-top-visible'), true, 'a first touch at the top reveals controls');
assert.equal(touchPrevented, 1, 'the reveal touch cannot activate content underneath hidden controls');
assert.equal(display.timers.length, 1, 'touch reveal owns one bounded hide timer');
display.handleDisplayPointerDown(touchEvent);
assert.equal(display.timers[0].cleared, true, 'a repeated touch clears the prior timer');
assert.equal(display.timers.filter((timer) => !timer.cleared).length, 1,
  'rapid touch reveals never accumulate live timers');
display.handleDisplayFocusIn({ target: displayTarget('top') });
display.timers.at(-1).callback();
assert.equal(display.classes.has('display-top-visible'), false,
  'touch-generated focus does not prevent controls hiding after their bounded interval');

const mobileDisplay = displayModeContext({ height: 844 });
mobileDisplay.requestDisplayMode(true);
mobileDisplay.handleDisplayPointerDown({
  pointerType: 'touch', clientY: 830, target: displayTarget(), preventDefault() {}, stopPropagation() {},
});
assert.equal(mobileDisplay.classes.has('display-bottom-visible'), true,
  'a mobile bottom-edge touch reveals the view selector');
assert.equal(mobileDisplay.timers.at(-1).delay, 2400, 'mobile touch visibility has one short deterministic lifetime');
const mobileHideTimer = mobileDisplay.timers.at(-1);
mobileDisplay.requestDisplayMode(false);
assert.equal(mobileHideTimer.cleared, true, 'turning Display Mode off cancels the sole touch timer');
assert.equal(mobileDisplay.displayTouchHideTimer, null, 'disabled mode retains no timer handle');

for (const kind of ['menu', 'postcard', 'about']) {
  const overlayDisplay = displayModeContext();
  overlayDisplay.requestDisplayMode(true);
  overlayDisplay.overlays[kind].hidden = 'false';
  overlayDisplay.syncDisplayOverlayVisibility();
  assert.equal(overlayDisplay.classes.has('display-top-visible'), true, `${kind} keeps top controls visible`);
  assert.equal(overlayDisplay.classes.has('display-bottom-visible'), true, `${kind} keeps bottom controls visible`);
  overlayDisplay.overlays[kind].hidden = 'true';
  overlayDisplay.syncDisplayOverlayVisibility();
  assert.equal(overlayDisplay.classes.has('display-top-visible'), false, `${kind} close restores hidden top controls`);
  assert.equal(overlayDisplay.classes.has('display-bottom-visible'), false, `${kind} close restores hidden bottom controls`);
}

const persistedDisplay = displayModeContext();
persistedDisplay.storage.set('display-mode', 'on');
persistedDisplay.restoreDisplayModePreference();
assert.equal(persistedDisplay.displayModeOn, true, 'an authorized reload restores the browser-local preference');
persistedDisplay.requestDisplayMode(false);
assert.equal(persistedDisplay.storage.has('display-mode'), false, 'turning Display Mode off clears its preference');
assert.equal(persistedDisplay.classes.has('display-mode'), false, 'turning it off restores ordinary chrome');

const unauthorisedSharedDisplay = displayModeContext();
unauthorisedSharedDisplay.storage.set('display-mode', 'on');
unauthorisedSharedDisplay.setDisplayMode(false, { persist: false });
assert.equal(unauthorisedSharedDisplay.classes.has('display-mode'), false,
  'a fresh public shared scope never inherits hidden chrome before authorization');
assert.equal(unauthorisedSharedDisplay.storage.get('display-mode'), 'on',
  'the locked boot leaves the preference available for a later successful unlock');

const protectedIdleDisplay = displayModeContext();
protectedIdleDisplay.EDUCATOR_SCOPE_KEY = 'private-scope';
protectedIdleDisplay.educatorScopesAuthorized = true;
protectedIdleDisplay.educatorScopeShared = false;
protectedIdleDisplay.explicitEducatorScope = { id: c1 };
protectedIdleDisplay.effectiveEducatorScope = { id: c1 };
protectedIdleDisplay.deferredEducatorScope = null;
protectedIdleDisplay.privateScrubs = 0;
protectedIdleDisplay.cacheResets = 0;
protectedIdleDisplay.closeEducatorTransientUi = function () {};
protectedIdleDisplay.suspendEducatorFolderPreferences = function () {};
protectedIdleDisplay.validEducatorId = function (value) { return value === c1; };
protectedIdleDisplay.educatorScopeId = function () {
  return protectedIdleDisplay.effectiveEducatorScope && protectedIdleDisplay.effectiveEducatorScope.id || '';
};
protectedIdleDisplay.scrubEducatorScopeSurface = function () { protectedIdleDisplay.privateScrubs += 1; };
protectedIdleDisplay.syncEducatorScopePill = function () {};
protectedIdleDisplay.resetScopedDataCaches = function () { protectedIdleDisplay.cacheResets += 1; };
protectedIdleDisplay.refreshAll = function () {};
protectedIdleDisplay.storage.set('private-scope', JSON.stringify({ id: c1, label: 'Private period' }));
protectedIdleDisplay.requestDisplayMode(true);
vm.runInContext(functionSource('suspendEducatorScopes'), protectedIdleDisplay);
protectedIdleDisplay.suspendEducatorScopes({ refresh: false });
assert.equal(protectedIdleDisplay.displayModeOn, true,
  'protected logout and 30-minute idle expiry leave the local display preference active');
assert.equal(protectedIdleDisplay.classes.has('display-mode'), true,
  'protected auth loss keeps dedicated display chrome hidden');
assert.equal(protectedIdleDisplay.storage.get('display-mode'), 'on',
  'protected auth loss keeps the browser-local preference');
assert.equal(protectedIdleDisplay.storage.has('private-scope'), false,
  'protected auth loss independently removes the private scope preference');
assert.equal(protectedIdleDisplay.explicitEducatorScope, null,
  'protected auth loss independently drops the effective private scope');
assert.equal(protectedIdleDisplay.privateScrubs > 0 && protectedIdleDisplay.cacheResets > 0, true,
  'protected auth loss still scrubs the private scope surface and caches');
protectedIdleDisplay.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 20 });
assert.equal(protectedIdleDisplay.classes.has('display-top-visible'), true,
  'edge reveal remains available after protected auth loss');
protectedIdleDisplay.handleDisplayPointerMove({ pointerType: 'mouse', clientY: 400 });
protectedIdleDisplay.handleDisplayKeyDown();
protectedIdleDisplay.handleDisplayFocusIn({ target: displayTarget('bottom') });
assert.equal(protectedIdleDisplay.classes.has('display-bottom-visible'), true,
  'keyboard reveal remains available after protected auth loss');

const rapidDisplay = displayModeContext();
rapidDisplay.requestDisplayMode(true);
rapidDisplay.requestDisplayMode(false);
rapidDisplay.requestDisplayMode(true);
rapidDisplay.requestDisplayMode(false);
assert.equal(rapidDisplay.displayModeOn, false, 'the last rapid toggle wins synchronously');
assert.equal(rapidDisplay.timers.length, 0, 'rapid toggles create no timers');
assert.equal(rapidDisplay.button.disabled, false, 'rapid toggles never leave the switch busy');
assert.equal(rapidDisplay.button.attrs['aria-checked'], 'false', 'the switch exposes the final rapid-toggle state');

const enabledFromEducators = displayModeContext({ admin: true });
assert.equal(enabledFromEducators.toggleEducatorDisplayMode(), true,
  'enabling from Educators applies the chrome preference immediately');
assert.equal(enabledFromEducators.closes, 1, 'enabling immediately closes the Educators workspace');
assert.equal(enabledFromEducators.replacedUrl, '/?edu=scope', 'the public route drops the stale Educators hash');
assert.equal(enabledFromEducators.focused, enabledFromEducators.title,
  'focus lands safely on the selected public page title');
assert.equal(enabledFromEducators.classes.has('display-top-visible'), false,
  'the revealed public page begins with top chrome hidden');
assert.equal(enabledFromEducators.classes.has('display-bottom-visible'), false,
  'the revealed public page begins with bottom chrome hidden');
assert.equal(enabledFromEducators.fullscreenCalls, 0, 'the Display Mode switch never calls a Fullscreen API');

const displaySource = apt.slice(apt.indexOf("var DISPLAY_MODE_KEY"), apt.indexOf('var educatorState'));
assert.doesNotMatch(displaySource, /requestFullscreen|exitFullscreen|fullscreenElement|fullscreenchange/,
  'Display Mode contains no Fullscreen API contract');
assert.doesNotMatch(displaySource, /requestAnimationFrame|cancelAnimationFrame/,
  'Display Mode creates no animation-frame loop');
assert.match(functionSource('renderMenu'), /if \(educatorsAvailable\) \{[\s\S]*restoreDisplayModePreference\(\)/,
  'only an authenticated Educators profile restores the browser-local preference');
assert.doesNotMatch(functionSource('suspendEducatorScopes'), /requestDisplayMode|setDisplayMode/,
  'logout and idle scope scrubbing do not alter the non-sensitive display preference');
assert.match(apt, /var ADMIN_IDLE_MS = 30 \* 60 \* 1000/,
  'the protected regression covers the configured 30-minute idle boundary');
assert.match(functionSource('showAdminLocked'), /suspendEducatorScopes\(\{ refresh: true \}\)/,
  'logout, idle expiry, and session replacement use the scope scrub that preserves Display Mode');
assert.match(functionSource('suspendUnavailableEducatorProfile'), /suspendEducatorScopes[\s\S]*requestDisplayMode\(false\)/,
  'an authoritative missing profile clears the Display Mode preference');
assert.match(functionSource('disableEducatorsFrontend'), /requestDisplayMode\(false\)/,
  'a disabled profile clears the Display Mode preference');
assert.match(apt, /setDisplayMode\(false, \{ persist: false \}\)[\s\S]*addEventListener\('pointermove'/,
  'a fresh public boot starts with normal chrome until Educators authorization completes');
assert.equal((apt.match(/addEventListener\('pointermove', handleDisplayPointerMove/g) || []).length, 1,
  'one passive pointer listener serves every Display Mode toggle');
for (const eventName of ['pointerdown', 'pointerup', 'pointercancel', 'keydown', 'focusin', 'focusout']) {
  assert.equal((apt.match(new RegExp(`addEventListener\\('${eventName}', handleDisplay`, 'g')) || []).length, 1,
    `${eventName} has one long-lived Display Mode listener`);
}

const displayMarkupContext = { displayModeEnabled() { return false; } };
vm.createContext(displayMarkupContext);
vm.runInContext(functionSource('educatorDisplayHtml'), displayMarkupContext);
const displayMarkup = displayMarkupContext.educatorDisplayHtml();
assert.match(displayMarkup, /Hide page controls until you move to an edge\./,
  'Display Mode explains the lightweight edge-reveal behavior');
assert.match(displayMarkup, /role="switch"[\s\S]*aria-disabled="false"[\s\S]*data-display-mode/,
  'Display Mode is available without a Fullscreen API');
assert.equal((displayMarkup.match(/data-display-mode/g) || []).length, 1,
  'Display Mode has one direct switch');

assert.match(functionSource('routeToEducators'), /preventDefault\(\)[\s\S]*pendingAdminSection = 'educators'[\s\S]*applyEducatorScope\(null, \{ force: true, refresh: true, immediateTitle: true \}\)[\s\S]*location\.hash = '#admin=educators'/,
  'the scoped Back control removes the capability and deliberately routes to Educators');
assert.match(functionSource('routeToEducators'), /adminAccessState === 'locked'[\s\S]*showAdminLocked\('', false, true\)/,
  'a protected anonymous Back route exposes the normal unlock UI without losing its pending Educators destination');

function educatorErrorContext(hasLive) {
  const status = { textContent: '', classList: { toggle(name, on) { this[name] = on; } } };
  let bodyHtml = 'workspace';
  const context = {
    educatorStateRequest: 0,
    adminSect: 'educators',
    educatorStatusMessage: '',
    educatorStatusError: false,
    adminBody: {
      querySelector(selector) {
        if (selector === '[data-educator-live]') return hasLive ? {} : null;
        if (selector === '.educator-status') return status;
        return null;
      },
      get innerHTML() { return bodyHtml; },
      set innerHTML(value) { bodyHtml = value; },
    },
    adminJson() { return Promise.reject(Object.assign(new Error('Station offline'), { status: 500 })); },
    adminAuthCancelled() { return false; },
    disableEducatorsFrontend() {},
    liveAudioController: { unmounts: 0, unmount() { this.unmounts += 1; } },
    adminUnreachableHtml(message) { return `unreachable:${message}`; },
  };
  vm.createContext(context);
  vm.runInContext([functionSource('updateEducatorStatus'), functionSource('educatorLoad')].join('\n'), context);
  context.bodyHtml = () => bodyHtml;
  return context;
}
const liveError = educatorErrorContext(true);
await liveError.educatorLoad();
assert.equal(liveError.bodyHtml(), 'workspace', 'a non-auth poll error keeps an operable live-audio workspace visible');
assert.equal(liveError.liveAudioController.unmounts, 0, 'a visible protected player is not left running behind replacement error HTML');
assert.equal(liveError.educatorStatusError, true, 'the retained workspace announces its inline state error');
const initialError = educatorErrorContext(false);
await initialError.educatorLoad();
assert.equal(initialError.liveAudioController.unmounts, 1,
  'an initial unreachable replacement explicitly tears down any prior audio graph');
assert.match(initialError.bodyHtml(), /^unreachable:/, 'initial load failure renders the standard unreachable state');

assert.doesNotMatch(apt, /function educatorExportsHtml|function wireEducatorExport|data-educator-export/,
  'the selected-scope export surface is absent from the Educators frontend');

assert.match(apt, /educatorsAvailable = nextEducatorsAvailable/, 'menu payload owns Educators availability');
assert.match(functionSource('readAdminHash'), /m\[1\] === 'educators' && !educatorsAvailable/,
  'a stale disabled Educators hash fails closed');
const routeContext = {
  location: { hash: '#admin=educators' },
  ADMIN_TITLES: { settings: 'Settings', educators: 'Educators' },
  educatorsAvailable: false,
};
vm.createContext(routeContext);
vm.runInContext(functionSource('readAdminHash'), routeContext);
assert.equal(routeContext.readAdminHash(), null, 'a fresh locked or disabled boot ignores a private Educators history entry');
routeContext.educatorsAvailable = true;
assert.equal(routeContext.readAdminHash(), 'educators', 'the same history entry becomes valid only after menu authorization');
routeContext.location.hash = '';
assert.equal(routeContext.readAdminHash(), null, 'browser Back exits the Educators route cleanly');
assert.match(functionSource('renderMenu'), /educatorsAvailable = nextEducatorsAvailable[\s\S]*else \{\s*suspendUnavailableEducatorProfile\(lostEducators\)/,
  'every unavailable-profile menu response uses the scope suspension transaction');
assert.match(functionSource('suspendUnavailableEducatorProfile'), /suspendEducatorScopes\(\{ refresh: true \}\)[\s\S]*if \(lostEducators\) clearEducatorPrivateFrontendState\(\)/,
  'a removed profile sanitizes scope data before scrubbing its private workspace');
assert.match(functionSource('clearEducatorPrivateFrontendState'), /suspendEducatorFolderPreferences\(\)/,
  'the private scrub clears browser-local folder IDs from the removed profile');
assert.match(functionSource('suspendEducatorFolderPreferences'), /removeLS\(EDUCATOR_EXPANDED_KEY\)/,
  'every folder-preference suspension removes bearer IDs from persistent storage');
assert.doesNotMatch(functionSource('renderMenu'), /!educatorScopeShared[\s\S]*applyEducatorScope/,
  'profile loss cannot bypass shared-scope sanitization behind a negated guard');
assert.match(functionSource('closeAdmin'), /previousAdminSect === 'educators'[\s\S]*liveAudioController\.unmount\(\)/,
  'leaving a disabled Educators page tears down its audio graph and spectrogram loop');

const freshUnavailableStorage = new Map([
  ['scope-key', JSON.stringify({ id: c1, label: 'Stale private period' })],
  ['folders-key', JSON.stringify([f1])],
]);
let freshUnavailablePrivateClears = 0;
let freshUnavailableHistoryClears = 0;
const freshUnavailableContext = {
  EDUCATOR_SCOPE_KEY: 'scope-key',
  EDUCATOR_EXPANDED_KEY: 'folders-key',
  educatorScopesAuthorized: true,
  educatorScopeShared: false,
  educatorExpandedFolders: { [f1]: true },
  educatorExpandedFoldersLoaded: true,
  deferredEducatorScope: null,
  explicitEducatorScope: null,
  effectiveEducatorScope: null,
  pendingAdminSection: 'educators',
  adminSect: null,
  location: { hash: '#admin=educators', pathname: '/', search: '' },
  window: { history: {} },
  history: { replaceState() { freshUnavailableHistoryClears += 1; } },
  removeLS(key) { freshUnavailableStorage.delete(key); },
  closeEducatorTransientUi() {},
  requestDisplayMode() {},
  scrubEducatorScopeSurface() {},
  syncEducatorScopePill() {},
  clearEducatorPrivateFrontendState() { freshUnavailablePrivateClears += 1; },
  closeAdmin() {},
};
vm.createContext(freshUnavailableContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('educatorScopeId'),
  functionSource('suspendEducatorFolderPreferences'),
  functionSource('suspendEducatorScopes'),
  functionSource('suspendUnavailableEducatorProfile'),
].join('\n'), freshUnavailableContext);
freshUnavailableContext.suspendUnavailableEducatorProfile(false);
assert.equal(freshUnavailableStorage.size, 0,
  'a fresh false menu response clears stale scope and folder capability storage');
assert.deepEqual(Object.keys(freshUnavailableContext.educatorExpandedFolders), [],
  'a fresh false menu response also clears folder capability IDs from memory');
assert.equal(freshUnavailablePrivateClears, 0,
  'a fresh false response does not invent a prior private workspace');
assert.equal(freshUnavailableContext.pendingAdminSection, null,
  'a disabled profile cannot remain queued as a private admin destination');
assert.equal(freshUnavailableHistoryClears, 1,
  'a disabled profile removes its stale admin history route');

const lostSharedStorage = new Map([
  ['scope-key', JSON.stringify({ id: c1, label: 'Private period', revision: 8 })],
  ['folders-key', JSON.stringify([f1])],
]);
let lostSharedPrivateClears = 0;
let lostSharedRefreshes = 0;
let lostSharedRenderLabel = 'unread';
const lostSharedContext = {
  EDUCATOR_SCOPE_KEY: 'scope-key',
  EDUCATOR_EXPANDED_KEY: 'folders-key',
  educatorScopesAuthorized: true,
  educatorScopeShared: true,
  educatorScopeBlocked: false,
  educatorScopeGeneration: 11,
  educatorExpandedFolders: { [f1]: true },
  educatorExpandedFoldersLoaded: true,
  deferredEducatorScope: { id: c1, label: 'Private period', revision: 8 },
  explicitEducatorScope: { id: c1, label: 'Private period', revision: 8, state_key: 'a'.repeat(24), state_revision: 9 },
  effectiveEducatorScope: { id: c1, label: 'Private period', revision: 8, state_key: 'a'.repeat(24), state_revision: 9 },
  pendingAdminSection: null,
  adminSect: null,
  DATA: {
    recent: { educator_scope: { label: 'Private period', revision: 8 } },
    stats: { educator_scope: { label: 'Private period', state_key: 'a'.repeat(24) } },
  },
  STATS_DAYS: 3,
  STATS: { detPerDay: [1], specPerDay: [1], byHour: [1] },
  speciesTotals: { private: 1 },
  SPECIES_CACHE: { private: {} },
  _decodedCache: { private: {} },
  hourlyDate: '2026-09-02',
  location: { hash: '', pathname: '/', search: `?edu=${c1}` },
  window: { history: {} },
  history: { replaceState() {} },
  document: {
    body: { classList: { toggle() {} } },
    getElementById() { return null; },
  },
  removeLS(key) { lostSharedStorage.delete(key); },
  closeEducatorTransientUi() {},
  requestDisplayMode() {},
  scrubEducatorScopeSurface() {},
  syncEducatorScopePill() {},
  renderCollageFromData() { lostSharedRenderLabel = lostSharedContext.effectiveEducatorScope.label; },
  renderStatsContext() {},
  renderAtlas() {},
  stopAtlasCardAudio() {},
  stopModalAudio() {},
  refreshAll() { lostSharedRefreshes += 1; },
  clearEducatorPrivateFrontendState() {
    lostSharedPrivateClears += 1;
    assert.equal(lostSharedContext.effectiveEducatorScope.label, '');
    assert.equal(lostSharedContext.effectiveEducatorScope.revision, 0);
    assert.equal(lostSharedContext.effectiveEducatorScope.state_key, '');
    assert.equal(Object.values(lostSharedContext.DATA).every((value) => value === null), true);
  },
  closeAdmin() {},
};
vm.createContext(lostSharedContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeId'),
  functionSource('setEducatorDataLoading'),
  functionSource('resetScopedDataCaches'),
  functionSource('suspendEducatorFolderPreferences'),
  functionSource('suspendEducatorScopes'),
  functionSource('suspendUnavailableEducatorProfile'),
].join('\n'), lostSharedContext);
lostSharedContext.suspendUnavailableEducatorProfile(true);
assert.equal(lostSharedContext.effectiveEducatorScope.id, c1,
  'true-to-false profile loss preserves only the current opaque URL capability');
assert.equal(lostSharedContext.educatorScopeGeneration, 12,
  'true-to-false profile loss invalidates every admin-shaped request');
assert.equal(lostSharedRenderLabel, '',
  'true-to-false profile loss scrubs the private label before repaint');
assert.equal(lostSharedPrivateClears, 1,
  'true-to-false profile loss clears its private Educators workspace after scope sanitization');
assert.equal(lostSharedRefreshes, 1,
  'true-to-false profile loss forces one public-shaped capability refetch');
assert.equal(lostSharedStorage.size, 0,
  'true-to-false profile loss clears both saved scope and folder bearer storage');

const viewExitLog = [];
let viewExitHash = '#admin=educators';
const viewEntityContext = {
  educatorState: { state_revision: 8 },
  validEducatorId(value) { return value === c1 || value === f1; },
  educatorScopeForEntity(entity, revision) { return { id: entity.id, label: entity.name, revision }; },
  applyEducatorScope(scope) { viewExitLog.push(`scope:${scope.id}`); },
  closeAdmin(options) { viewExitLog.push(options.focusPublicEducator ? 'close:focus' : 'close'); },
  location: {
    get hash() { return viewExitHash; },
    set hash(value) { viewExitHash = value; viewExitLog.push('hash:clear'); },
  },
};
vm.createContext(viewEntityContext);
vm.runInContext(functionSource('viewEducatorEntity'), viewEntityContext);
assert.equal(viewEntityContext.viewEducatorEntity({ id: c1, name: 'Period 3' }), true,
  'View capture accepts a valid selected period');
assert.deepEqual(viewExitLog, [`scope:${c1}`, 'close:focus', 'hash:clear'],
  'View capture closes through the public-focus path before clearing its route');
viewExitLog.length = 0;
viewExitHash = '#admin=educators';
assert.equal(viewEntityContext.viewEducatorEntity({ id: f1, name: 'Biology' }), true,
  'View folder uses the same safe public-focus path');
assert.deepEqual(viewExitLog, [`scope:${f1}`, 'close:focus', 'hash:clear'],
  'View folder selects its scope before leaving Educators');
assert.match(functionSource('wireEducators'), /viewEducatorEntity\(capture\)[\s\S]*viewEducatorEntity\(folder\)/,
  'both View controls share the focus-safe exit helper');

const menuButton = {};
const passwordField = {};
let lockFocus = null;
let lockDrawerOpens = 0;
const lockFocusContext = {
  pendingAdminSection: null,
  menuBtn: menuButton,
  document: { getElementById(id) { return id === 'lockPass' ? passwordField : null; } },
  openDd() { lockDrawerOpens += 1; },
  focusEl(target) { lockFocus = target; },
  setTimeout(callback) { callback(); return 1; },
};
vm.createContext(lockFocusContext);
vm.runInContext(functionSource('restoreFocusAfterAdminLock'), lockFocusContext);
assert.equal(lockFocusContext.restoreFocusAfterAdminLock(true, false), 'menu',
  'auth loss moves hidden private-view focus to the closed menu button');
assert.equal(lockFocus, menuButton, 'the visible closed menu button receives focus');
assert.equal(lockDrawerOpens, 0, 'focus recovery does not reopen the navigation drawer');
lockFocusContext.pendingAdminSection = 'educators';
lockFocus = null;
assert.equal(lockFocusContext.restoreFocusAfterAdminLock(true, false), 'menu',
  'a scoped 401 still keeps a deferred Educators route closed');
assert.equal(lockDrawerOpens, 0, 'the scoped 401 focus path leaves the drawer closed');
assert.equal(lockFocusContext.restoreFocusAfterAdminLock(true), 'password',
  'an explicit deferred admin navigation can still reveal its unlock field');
assert.equal(lockFocus, passwordField, 'the revealed unlock field receives focus');
assert.match(functionSource('showAdminLocked'), /scopeReturnBeforeLock[\s\S]*scopeReturnBeforeLock\.contains\(focusBeforeLock\)[\s\S]*sharedPublicFocus[\s\S]*focusEl\(scopeReturnBeforeLock\)/,
  'auth loss keeps focus in an authorized anonymous shared view while private admin surfaces close');

let pickerDismissed = 0;
let pickerRemoved = 0;
const pickerContext = {
  document: {
    querySelectorAll(selector) {
      assert.equal(selector, '.map-modal');
      return [
        { __avianDismiss() { pickerDismissed += 1; } },
        { remove() { pickerRemoved += 1; } },
      ];
    },
  },
};
vm.createContext(pickerContext);
vm.runInContext(functionSource('dismissAdminMapPickers'), pickerContext);
pickerContext.dismissAdminMapPickers();
assert.equal(pickerDismissed, 1, 'auth loss invokes the map picker cleanup hook');
assert.equal(pickerRemoved, 1, 'an older map picker still fails closed by immediate removal');
assert.match(functionSource('openStationPicker'), /window\.removeEventListener\('resize', onResize\)/,
  'closing the map removes its window resize listener');
assert.match(functionSource('openStationPicker'), /host\.__avianDismiss = removeHost/,
  'auth loss can bypass the map close animation and remove exact location data immediately');

let mapActivityPings = 0;
const mapActivityContext = {
  adminAccessState: 'unlocked',
  adminAuthMeta: { required: true },
  shell: { contains() { return false; } },
  adminEl: { contains() { return false; } },
  publishAdminActivity() { mapActivityPings += 1; },
  pingAdminActivity() {},
  scheduleAdminIdleLock() {},
  Date,
};
vm.createContext(mapActivityContext);
vm.runInContext(functionSource('noteAdminActivity'), mapActivityContext);
mapActivityContext.noteAdminActivity({
  isTrusted: true,
  target: { closest(selector) { return selector === '.map-modal' ? {} : null; } },
});
assert.equal(mapActivityPings, 1, 'using the admin-only map resets the idle timeout');

const closeOrder = [];
const closeClasses = new Set(['admin-on']);
const closeBack = { hidden: false };
const closeAdminContext = {
  document: {
    body: { classList: {
      contains(value) { return closeClasses.has(value); },
      remove(value) { closeClasses.delete(value); closeOrder.push('public-visible'); },
    } },
    getElementById(id) { return id === 'returnToEducators' ? closeBack : null; },
  },
  staticTitle: {},
  focusEl(target) {
    assert.equal(target, closeBack, 'the scoped Back control is the public destination');
    assert.equal(closeClasses.has('admin-on'), false, 'public chrome is visible before focus moves');
    assert.equal(closeAdminContext.adminEl.hidden, false, 'focus moves before Educators becomes aria-hidden');
    assert.equal(closeAdminContext.adminEl.inert, false, 'focus moves before the admin subtree becomes inert');
    closeOrder.push('focus-public');
  },
  adminSect: 'educators',
  educatorEditing: null,
  educatorPendingState: null,
  educatorStartDraft: '',
  educatorFolderDraft: '',
  educatorFolderComposerOpen: false,
  educatorLiveWide: false,
  educatorElapsedTimer: null,
  closeEducatorTransientUi() {},
  liveAudioController: { unmount() {} },
  adminViewGeneration: 0,
  adminEl: {
    hidden: false,
    inert: false,
    scrollTop: 0,
    setAttribute(name, value) {
      if (name === 'aria-hidden') { this.hidden = value === 'true'; closeOrder.push('hide-admin'); }
    },
    removeAttribute() {},
  },
  adminPollT: null,
  clearInterval() {},
  syncAdminTitlePin() {},
  queueVisibleAtlasPack() {},
  discardPendingSettings() {},
  settingsInfoCleanup: null,
  settingsAccessCleanup: null,
};
vm.createContext(closeAdminContext);
vm.runInContext([
  functionSource('focusPublicEducatorDestination'),
  functionSource('closeAdmin'),
].join('\n'), closeAdminContext);
closeAdminContext.closeAdmin({ focusPublicEducator: true });
assert.deepEqual(closeOrder.slice(0, 3), ['public-visible', 'focus-public', 'hide-admin'],
  'View moves focus to visible public scope controls before hiding the admin region');
assert.equal(closeAdminContext.adminEl.inert, true,
  'the closed admin subtree is inert after public focus is restored');
assert.match(functionSource('openAdmin'), /adminEl\.inert = false;[\s\S]*removeAttribute\('inert'\)[\s\S]*aria-hidden', 'false'/,
  'opening an admin section removes inert before exposing the subtree');
assert.match(html, /id="adminScreen" aria-hidden="true" inert/,
  'the boot-time closed admin subtree is inert before JavaScript runs');
assert.doesNotMatch(functionSource('menuItemMarkup'), /profile_epoch|profileEpoch|c_\[|f_\[/,
  'the fifth menu row never exposes a profile epoch or private entity identifier');
const menuMarkupContext = { escHtml: String };
vm.createContext(menuMarkupContext);
vm.runInContext(functionSource('menuItemMarkup'), menuMarkupContext);
assert.match(menuMarkupContext.menuItemMarkup({
  label: 'educators', href: '/#admin=educators', native: true, full: true,
}), /^<a class="full" href="\/#admin=educators"><span>educators<\/span><\/a>$/,
  'Educators renders as the conditional full-width fifth menu row without hidden metadata');
assert.match(css, /\.menu-links a\.full\s*\{\s*grid-column:\s*1 \/ -1/,
  'the conditional Educators row spans the existing two-column drawer grid');
assert.match(apt, /educators:\s*'Educators'/, 'the admin title is a fixed label without profile identifiers');
let displayDisabled = false;
let adminClosed = false;
let menuRefreshed = false;
let scopeCleared = false;
let disabledPostcardScrubs = 0;
let expandedStateClears = 0;
let privateAdminText = 'Period 4';
let disableCloseSawText = null;
let disableCloseFocusedPublic = false;
let disabledLiveUnmounts = 0;
let disabledScopeStorageClears = 0;
const disabledContext = {
  EDUCATOR_SCOPE_KEY: 'scope',
  educatorsAvailable: true,
  pendingAdminSection: 'educators',
  adminSect: 'educators',
  educatorStateRequest: 2,
  educatorState: {},
  educatorEditing: {},
  educatorPendingState: {},
  educatorActionBusy: true,
  educatorElapsedTimer: 9,
  educatorStatusMessage: 'old',
  educatorStatusError: true,
  educatorStartDraft: 'Private start draft',
  educatorFolderDraft: 'Private draft',
  educatorFolderComposerOpen: true,
  educatorLiveWide: true,
  educatorFocusSelector: '#private-period',
  educatorAcceptedSignature: '7|2',
  educatorOlderBusy: true,
  educatorExpandedFoldersLoaded: true,
  educatorScopesAuthorized: true,
  educatorScopeShared: false,
  explicitEducatorScope: { id: c1 },
  effectiveEducatorScope: { id: c1 },
  window: { __educatorState: {}, history: {} },
  history: { replaceState() {} },
  location: { hash: '#admin=educators', pathname: '/', search: '' },
  adminBody: {
    attrs: {},
    querySelector() { return {}; },
    replaceChildren() { privateAdminText = ''; },
    setAttribute(name, value) { this.attrs[name] = value; },
  },
  liveAudioController: { unmount() { disabledLiveUnmounts += 1; } },
  closeEducatorTransientUi() {},
  clearInterval() {},
  removeLS(key) { if (key === 'scope') disabledScopeStorageClears += 1; },
  resetEducatorCaptureArchive() {},
  suspendEducatorFolderPreferences() { expandedStateClears += 1; },
  educatorScopeId() { return c1; },
  scrubEducatorScopeSurface() { disabledPostcardScrubs += 1; },
  requestDisplayMode(value) { displayDisabled = value === false; return Promise.resolve(false); },
  applyEducatorScope(value) { scopeCleared = value === null; },
  closeAdmin(options) {
    adminClosed = true;
    disableCloseSawText = privateAdminText;
    disableCloseFocusedPublic = !!(options && options.focusPublicEducator);
  },
  tryAutoUnlock() { menuRefreshed = true; },
};
vm.createContext(disabledContext);
vm.runInContext([
  functionSource('clearEducatorPrivateFrontendState'),
  functionSource('disableEducatorsFrontend'),
].join('\n'), disabledContext);
disabledContext.disableEducatorsFrontend();
assert.equal(displayDisabled && adminClosed && menuRefreshed && scopeCleared, true,
  'a disabled endpoint closes Educators, clears scope, restores chrome, and refreshes the menu');
assert.equal(disableCloseFocusedPublic, true,
  'profile disable returns focus to the visible public view');
assert.equal(disableCloseSawText, '',
  'profile disable removes private admin text synchronously before closing the overlay');
assert.equal(disabledContext.educatorState, null, 'profile disable drops the private in-memory state');
assert.equal(disabledContext.window.__educatorState, null,
  'profile disable drops the public debugging state mirror');
assert.equal(disabledContext.educatorFolderDraft, '',
  'profile disable drops transient private drafts');
assert.equal(disabledContext.educatorStartDraft, '',
  'profile disable drops the private listening-period draft');
assert.equal(disabledContext.educatorActionBusy, false,
  'profile disable drops transient action state');
assert.equal(disabledLiveUnmounts, 1,
  'profile disable tears down the protected live-audio view before closing');
assert.equal(disabledPostcardScrubs, 1,
  'remote profile disable immediately closes an open saved-scope postcard');
assert.equal(expandedStateClears, 1, 'profile disable removes browser-local folder IDs from the old profile');
assert.equal(disabledScopeStorageClears, 1,
  'profile disable removes a stale saved scope preference even before scope state is inspected');
assert.match(functionSource('educatorLoad'), /error\.status === 404[\s\S]*disableEducatorsFrontend\(\)/,
  'a profile-disabled 404 triggers the same cleanup from the background poll');
assert.match(apt, /event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)/,
  'a hidden touch edge reveals controls without activating a card below it');

assert.match(html, /id="returnToEducators" href="#admin=educators" aria-label="back to educators" hidden[\s\S]*educators\s*<\/a>/,
  'scoped public views use the same terse top-left Back component as collage');
assert.doesNotMatch(html, /educatorScopePill|educatorScopeLabel/,
  'private listening-period and folder names have no public top-chrome surface');
assert.match(html, /id="educatorDataLoading"[\s\S]*role="status"/, 'scope changes expose one quiet loading status');
assert.match(css, /body\.educator-data-loading #views[\s\S]*visibility:\s*hidden/,
  'old scope views are blanked while the replacement dataset loads');
assert.match(css, /body\.educator-scoped #winPick\s*\{\s*display:\s*none/, 'scope replaces the rolling picker');
assert.match(css, /\.admin-screen\[data-admin-section="educators"\]\s*\{\s*overflow:\s*hidden/,
  'desktop Educators prevents whole-page scrolling');
assert.match(css, /\.educator-workspace\s*\{[\s\S]*grid-template-columns:[\s\S]*height:\s*100%/,
  'desktop Educators is a fixed two-column workspace');
assert.match(css, /@media \(max-width:\s*1050px\)[\s\S]*\.educator-workspace\.live-wide\s*\{[\s\S]*minmax\(350px, \.9fr\) minmax\(0, 1\.1fr\)[\s\S]*\.educator-workspace\.live-wide \.educator-counts-head[\s\S]*display:\s*block/,
  'small desktop live expansion compacts the saved metadata before the panes stack');
for (const viewport of [901, 1000, 1050]) {
  const tracks = viewport - 56 - 24;
  const savedTrack = tracks * 1.1 / 2;
  const compactGrid = 80 + 42 + 52 + 76 + 15;
  assert.ok(savedTrack - 20 - 36 >= compactGrid,
    `${viewport}px live-wide layout retains enough saved-row width without horizontal overflow`);
}
assert.match(css, /@media \(max-width:\s*384px\)\s*\{[\s\S]*\.educator-table-head\s*\{\s*display:\s*none;\s*\}[\s\S]*\.educator-period-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 42px 52px;[\s\S]*grid-template-rows:\s*auto auto/,
  'the two-row saved-period layout covers every sub-385px viewport');
for (const viewport of [360, 361, 375, 384, 385]) {
  const rowGridWidth = viewport - 28 - 20 - 10 - 44 - 2 - 16;
  const compactSingleRowMinimum = 80 + 42 + 52 + 76 + 15;
  const compactTwoRowMinimum = 42 + 52 + 10;
  if (viewport <= 384) {
    assert.ok(rowGridWidth >= compactTwoRowMinimum,
      `${viewport}px two-row saved period fits without horizontal overflow`);
  } else {
    assert.ok(rowGridWidth >= compactSingleRowMinimum,
      `${viewport}px four-column saved period fits at the breakpoint boundary`);
  }
}
assert.match(css, /\.educator-controls\s*\{\s*overflow-y:\s*auto/,
  'the compact left control column can scroll independently when necessary');
assert.match(css, /\.educator-saved\s*\{[\s\S]*overflow-y:\s*auto/,
  'saved listening periods own the primary independent scroll pane');
assert.match(css, /\.educator-controls\s*\{[\s\S]*scrollbar-width:\s*none[\s\S]*\.educator-controls::\-webkit-scrollbar\s*\{\s*display:\s*none/,
  'the left pane remains scrollable without showing a scrollbar');
assert.match(css, /\.educator-saved\s*\{[\s\S]*scrollbar-width:\s*none[\s\S]*\.educator-saved::\-webkit-scrollbar\s*\{\s*display:\s*none/,
  'the saved pane remains scrollable without showing a scrollbar');
assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*data-admin-section="educators"\]\s*\{\s*overflow-y:\s*auto[\s\S]*\.educator-workspace,[\s\S]*\.educator-workspace\.live-wide\s*\{\s*grid-template-columns:\s*1fr/,
  'narrow screens stack the panes and restore a usable document scroll');
assert.match(functionSource('paintEducators'), /educator-workspace[\s\S]*educator-controls[\s\S]*educatorActiveHtml[\s\S]*educatorLivePanelHtml[\s\S]*educatorDisplayHtml[\s\S]*educator-saved/,
  'the workspace keeps active controls, direct live audio, and Display Mode left of the saved ledger');
assert.match(functionSource('paintEducators'), /<h2 class="sr-only" id="educatorSavedTitle">/,
  'the only saved-period section heading is available to assistive technology without redundant visible copy');
assert.match(css, /\.educator-table-head,[\s\S]*\.educator-period-grid\s*\{[\s\S]*grid-template-columns:\s*minmax\(130px, 1\.7fr\)[\s\S]*\.educator-stat\s*\{[\s\S]*text-align:\s*right/,
  'saved listening periods use the Atlas-derived inline metadata grid');
assert.match(css, /@media \(max-width:\s*700px\)[\s\S]*\.educator-birds,[\s\S]*\.educator-calls,[\s\S]*\.educator-birds-head,[\s\S]*\.educator-calls-head\s*\{\s*display:\s*none[\s\S]*\.educator-counts,[\s\S]*\.educator-counts-head\s*\{\s*display:\s*block/,
  'mobile rows combine low-priority counts instead of overflowing the saved pane');

const livePanelContext = { educatorLiveWide: false };
vm.createContext(livePanelContext);
vm.runInContext(functionSource('educatorLivePanelHtml'), livePanelContext);
const closedLivePanel = livePanelContext.educatorLivePanelHtml();
assert.match(closedLivePanel, /data-live-panel data-wide="false"[\s\S]*data-educator-live/,
  'Live audio mounts directly in the compact control column');
assert.doesNotMatch(closedLivePanel, /data-live-panel-toggle|educator-live-body/,
  'Live audio has no redundant outer disclosure');
livePanelContext.educatorLiveWide = true;
const openLivePanel = livePanelContext.educatorLivePanelHtml();
assert.match(openLivePanel, /data-live-panel data-wide="true"/,
  'the direct live panel reflects the widened spectrogram state');

const liveWorkspaceClasses = new Set();
const liveWidePanel = { value: '', setAttribute(name, value) { if (name === 'data-wide') this.value = value; } };
const liveWideContext = {
  educatorLiveWide: false,
  adminBody: {
    querySelector(selector) {
      if (selector === '.educator-workspace') return {
        classList: { toggle(name, enabled) { if (enabled) liveWorkspaceClasses.add(name); else liveWorkspaceClasses.delete(name); } },
      };
      if (selector === '[data-live-panel]') return liveWidePanel;
      return null;
    },
  },
};
vm.createContext(liveWideContext);
vm.runInContext(functionSource('setEducatorLiveWide'), liveWideContext);
liveWideContext.setEducatorLiveWide(true);
assert.equal(liveWideContext.educatorLiveWide, true, 'widening the live stream updates the controller state');
assert.equal(liveWorkspaceClasses.has('live-wide'), true, 'widening expands the live workspace column');
assert.equal(liveWidePanel.value, 'true', 'widening exposes the panel state to styling');
liveWideContext.setEducatorLiveWide(false);
assert.equal(liveWorkspaceClasses.has('live-wide'), false, 'collapsing restores the compact live workspace');

const breakpointHost = {};
const breakpointMounts = [];
let breakpointCollapses = 0;
const breakpointContext = {
  educatorLiveWide: true,
  educatorLiveWideQuery: { matches: false },
  window: { innerWidth: 800 },
  adminSect: 'educators',
  adminAuthMeta: { required: true },
  adminBody: { querySelector(selector) { return selector === '[data-educator-live]' ? breakpointHost : null; } },
  setEducatorLiveWide(value) {
    breakpointContext.educatorLiveWide = !!value;
    breakpointCollapses += 1;
    return true;
  },
  liveAudioController: { mount(host, options) { breakpointMounts.push({ host, options }); } },
  Number,
};
vm.createContext(breakpointContext);
vm.runInContext([
  functionSource('educatorLiveCanExpand'),
  functionSource('educatorLiveMountOptions'),
  functionSource('syncEducatorLiveBreakpoint'),
].join('\n'), breakpointContext);
assert.equal(breakpointContext.syncEducatorLiveBreakpoint(), true,
  'crossing to a narrow screen resynchronizes the mounted live controller');
assert.equal(breakpointCollapses, 1, 'the narrow breakpoint clears a prior wide state');
assert.equal(breakpointMounts[0].host, breakpointHost, 'resize keeps the singleton live host');
assert.equal(breakpointMounts[0].options.expandable, false,
  'the narrow controller removes spectrogram expansion interaction and aria-expanded');
assert.equal(breakpointMounts[0].options.expanded, false,
  'the narrow controller cannot retain a stale expanded state');
breakpointContext.educatorLiveWideQuery.matches = true;
breakpointContext.syncEducatorLiveBreakpoint();
assert.equal(breakpointMounts[1].options.expandable, true,
  'crossing back to desktop restores spectrogram expansion without remounting audio');
assert.match(apt, /educatorLiveWideQuery\.addEventListener\('change', syncEducatorLiveBreakpoint\)/,
  'the live controller responds to breakpoint changes after initial mount');
assert.match(functionSource('paintEducators'), /liveAudioController\.mount\(liveHost, educatorLiveMountOptions\(\)\)/,
  'initial Educators paint uses the same responsive live options as resize');
assert.match(functionSource('educatorMoreButton'), /aria-haspopup="menu"[\s\S]*aria-expanded="false"[\s\S]*aria-label="Actions for/,
  'every three-dot row action has an accessible name and menu semantics');
assert.match(functionSource('educatorMoreButton'), /ICON_MORE_VERTICAL/,
  'row menus use the shared vertical-ellipsis SVG icon');
assert.doesNotMatch(apt, /&#8230;/, 'Educators contains no Unicode ellipsis menu glyph');
assert.match(css, /\.educator-action-menu button\s*\{[\s\S]*transition:\s*none/,
  'frequent action-menu navigation does not animate');
assert.match(css, /body\.display-mode:not\(\.admin-on\):not\(\.display-top-visible\)/,
  'Display Mode hides top chrome outside overlays');
assert.match(css, /body\.display-mode:not\(\.admin-on\):not\(\.display-bottom-visible\)/,
  'Display Mode hides bottom chrome outside overlays');
assert.match(css, /body\.display-mode:not\(\.admin-on\) \.view\s*\{\s*padding-bottom:\s*24px/,
  'Display Mode reclaims the bottom navigation space for the selected bird view');
assert.match(css, /@media \(max-width:\s*700px\)[\s\S]*\.educator-row-actions button[\s\S]*min-height:\s*44px/,
  'mobile Educators actions retain touch-sized targets');
assert.match(css, /\.educator-return::after\s*\{[\s\S]*inset:\s*calc\(\(var\(--ctl-h\) - 44px\) \/ 2\) -4px/,
  'the compact scoped Back pill retains a 44px hit area without visual bloat');
assert.match(css, /\.return-to-atlas svg\s*\{\s*width:\s*10px;\s*height:\s*10px/,
  'the larger Back hit area does not enlarge the visible arrow');
assert.match(css, /@media \(max-width:\s*700px\)[\s\S]*\.educator-folder-add\s*\{\s*min-width:\s*44px;\s*width:\s*44px;\s*min-height:\s*44px/,
  'the direct folder-plus control keeps a touch-sized mobile target');
assert.match(css, /\.educator-more,[\s\S]*\.educator-load-older button,[\s\S]*min-height:\s*44px/,
  'touch menus, rename controls, and pagination use the same mobile target size');
assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*body\.display-mode/, 'reduced motion removes display transitions');
assert.match(css, /background:\s*var\(--paper\)/, 'Educators controls inherit light and dark theme tokens');
assert.match(css, /\.educator-active\[data-status="running"\][^\n]*var\(--accent\)/,
  'the active period indicator also follows the shared light and dark palette');

let exportEdu = 'active';
const exportContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  adminAuthMeta: { direct_local: true },
  educatorScopeGeneration: 3,
  educatorRequestScopeId() { return exportEdu; },
  validEducatorId(value) { return /^[cf]_[a-f0-9]{32}$/.test(value); },
  encodeURIComponent,
};
vm.createContext(exportContext);
vm.runInContext([
  functionSource('validEducatorScopeKey'),
  functionSource('educatorExportSnapshot'),
  functionSource('educatorExportUrl'),
  functionSource('educatorExportGrantBody'),
  functionSource('educatorExportSnapshotCurrent'),
  functionSource('educatorSavedExportNeedsDirect'),
  functionSource('educatorSavedExportMessage'),
].join('\n'), exportContext);
let exportSnapshot = exportContext.educatorExportSnapshot('detections');
assert.equal(exportContext.educatorExportUrl(exportSnapshot),
  './avian/api/export.php?what=detections&edu=active',
  'an unprotected Tools export follows the automatic active listening period');
assert.deepEqual(JSON.parse(JSON.stringify(exportContext.educatorExportGrantBody(exportSnapshot))),
  { scope: 'detections', edu: 'active' },
  'a protected active export grant contains exactly its export scope and educator scope');
exportEdu = c1;
exportSnapshot = exportContext.educatorExportSnapshot('recordings');
assert.equal(exportContext.educatorSavedExportNeedsDirect(exportSnapshot), false,
  'a direct local saved capture keeps its scoped export');
assert.equal(exportContext.educatorExportUrl(exportSnapshot, 'a'.repeat(48)),
  `./avian/api/export.php?what=recordings&edu=${c1}&grant=${'a'.repeat(48)}`,
  'the granted download URL uses the exact same saved capture capability');
assert.deepEqual(JSON.parse(JSON.stringify(exportContext.educatorExportGrantBody(exportSnapshot))),
  { scope: 'recordings', edu: c1 },
  'the protected saved-capture grant body carries no private display label');
exportEdu = f1;
assert.equal(exportContext.educatorExportSnapshotCurrent(exportSnapshot), false,
  'a scope switch while a grant is in flight prevents the stale download');
exportEdu = c1;
exportContext.educatorScopeGeneration = 4;
assert.equal(exportContext.educatorExportSnapshotCurrent(exportSnapshot), false,
  'switching away and back still invalidates a grant from the prior scope generation');
exportEdu = f1;
const folderExport = exportContext.educatorExportSnapshot('detections');
assert.equal(exportContext.educatorExportUrl(folderExport),
  `./avian/api/export.php?what=detections&edu=${f1}`,
  'folder exports stay bound to the selected folder union');
exportContext.adminAuthMeta = { direct_local: false };
assert.equal(exportContext.educatorSavedExportNeedsDirect(folderExport), true,
  'a remote saved folder is disabled before any grant request');
assert.equal(exportContext.educatorSavedExportMessage(),
  'Saved-view exports require a direct local connection.',
  'remote saved exports explain the direct-local requirement');
exportEdu = 'active';
assert.equal(exportContext.educatorSavedExportNeedsDirect(exportContext.educatorExportSnapshot('detections')), false,
  'a remote active-period export remains available');
exportEdu = '';
const globalExport = exportContext.educatorExportSnapshot('detections');
assert.deepEqual(JSON.parse(JSON.stringify(exportContext.educatorExportGrantBody(globalExport))),
  { scope: 'detections' },
  'a truly global export omits edu instead of inventing a fallback scope');
assert.equal(exportContext.educatorExportUrl(globalExport), './avian/api/export.php?what=detections',
  'a truly global unprotected export also omits edu');
assert.doesNotMatch(JSON.stringify(exportContext.educatorExportGrantBody(folderExport)), /Biology|label|name/i,
  'export grants never disclose educator names or folder labels');
assert.match(functionSource('renderAdminTools'),
  /educatorExportSnapshot\(link\.dataset\.exportScope\)[\s\S]*educatorExportGrantBody\(snapshot\)[\s\S]*educatorExportSnapshotCurrent\(snapshot\)[\s\S]*educatorExportUrl\(snapshot, body\.token\)/,
  'Tools captures one educator scope and reuses it for grant validation and download');
assert.match(functionSource('renderAdminTools'),
  /educatorSavedExportNeedsDirect\(snapshot\)[\s\S]*event\.preventDefault\(\)[\s\S]*SavedExportMessage\(\)[\s\S]*return;[\s\S]*download-grant/,
  'a remote saved export returns before the protected grant request');
assert.match(functionSource('renderAdminTools'),
  /directRequired[\s\S]*aria-disabled="true"[\s\S]*educatorSavedExportMessage\(\)/,
  'Tools renders remote saved exports disabled with an immediate honest message');
assert.match(functionSource('renderAdminTools'),
  /response\.status === 413[\s\S]*Export is too large\. Choose a smaller listening period or folder\./,
  'an over-cap export fails closed with an honest recovery instruction');

const authMetaContext = { Array };
vm.createContext(authMetaContext);
vm.runInContext(functionSource('normalizeAdminAuthMeta'), authMetaContext);
assert.deepEqual(JSON.parse(JSON.stringify(authMetaContext.normalizeAdminAuthMeta({
  required: true,
  lan_policy: true,
  password_configured: true,
  recovery: false,
  direct_local: true,
}))), {
  required: true,
  lan_policy: true,
  password_configured: true,
  recovery: false,
  direct_local: true,
}, 'the menu auth contract accepts an explicit direct-local boolean');
assert.equal(authMetaContext.normalizeAdminAuthMeta({ direct_local: 'true' }).direct_local, false,
  'a string cannot spoof direct-local export authority');
assert.equal(authMetaContext.normalizeAdminAuthMeta(null).direct_local, false,
  'missing auth metadata fails closed for saved exports');
assert.match(functionSource('renderMenu'), /adminAuthMeta = normalizeAdminAuthMeta\(auth\)/,
  'menu auth metadata is normalized before Tools consumes it');

let countNow = 1000;
const countCapture = {
  id: c1, name: 'Period 3', status: 'stopped', revision: 4,
  detection_count: null, species_count: null,
};
const countContext = {
  Date: { now() { return countNow; } },
  EDUCATOR_COUNT_CACHE_TTL_MS: 60000,
  EDUCATOR_COUNT_UNAVAILABLE_TTL_MS: 300000,
  EDUCATOR_COUNT_RETRY_MS: 60000,
  educatorCountCache: Object.create(null),
  educatorCountAttempted: Object.create(null),
  educatorState: {
    profile_epoch: '7', state_revision: 12, active: null,
    captures: [countCapture], folders: [],
  },
  educatorCountRequest: null,
  educatorCountGeneration: 3,
  adminSect: 'educators',
  document: { hidden: false },
  validEducatorId(value) { return /^[cf]_[a-f0-9]{32}$/.test(value); },
  educatorCapture(id) { return countContext.educatorState.captures.find((capture) => capture.id === id); },
};
vm.createContext(countContext);
vm.runInContext([
  functionSource('educatorCountCacheKey'),
  functionSource('educatorCachedCaptureCounts'),
  functionSource('hydrateEducatorCaptureCounts'),
  functionSource('mergeEducatorCaptureCounts'),
  functionSource('educatorCaptureNeedsCounts'),
  functionSource('educatorCountResponse'),
  functionSource('educatorCountRequestCurrent'),
  functionSource('educatorCountRowAvailable'),
].join('\n'), countContext);
const countKey = countContext.educatorCountCacheKey('7', countCapture);
countContext.educatorCountCache[countKey] = {
  revision: 4, detection_count: 8, species_count: 3, fetched_at: countNow,
};
countContext.hydrateEducatorCaptureCounts(countContext.educatorState);
assert.equal(countCapture.detection_count, 8,
  'a same-revision ordinary state poll keeps a cached non-null call count');
assert.equal(countCapture.species_count, 3,
  'a same-revision ordinary state poll keeps a cached non-null bird count');
assert.equal(countContext.educatorCaptureNeedsCounts(countCapture), false,
  'a fresh cached count does not join a 10-second polling storm');
countNow += 60001;
assert.equal(countContext.educatorCaptureNeedsCounts(countCapture), true,
  'a modest TTL makes a same-revision stopped capture eligible after delayed analyzer inserts');
assert.equal(countCapture.detection_count, 8,
  'an expired cache keeps its prior number visible while the fresh count is fetched');
const countRequest = {
  generation: 3, profile: '7', stateRevision: 12,
  ids: [c1], revisions: { [c1]: 4 },
};
countContext.educatorCountRequest = countRequest;
assert.equal(countContext.educatorCountRequestCurrent(countRequest), true,
  'a count response can apply only to the exact current profile, state, and capture revision');
const refreshedCounts = countContext.educatorCountResponse({
  ok: true, enabled: true, profile_epoch: 7, state_revision: 12,
  counts: { [c1]: { revision: 4, detection_count: 9, species_count: 4 } },
}, countRequest);
assert.equal(refreshedCounts[c1].detection_count, 9,
  'a delayed analyzer insert can refresh counts without changing the capture revision');
const countSiblingId = `c_${'6'.repeat(32)}`;
const mixedCountRequest = {
  generation: 3,
  profile: '7',
  stateRevision: 12,
  ids: [c1, countSiblingId],
  revisions: { [c1]: 4, [countSiblingId]: 2 },
};
const mixedCounts = countContext.educatorCountResponse({
  ok: true, enabled: true, profile_epoch: 7, state_revision: 12,
  counts: {
    [c1]: { revision: 4, detection_count: null, species_count: null },
    [countSiblingId]: { revision: 2, detection_count: 17, species_count: 6 },
  },
}, mixedCountRequest);
assert.equal(mixedCounts[c1].unavailable, true,
  'a paired-null over-budget row is accepted as unavailable');
assert.equal(mixedCounts[countSiblingId].detection_count, 17,
  'a numeric sibling survives a mixed-null count batch');
assert.equal(countContext.educatorCountResponse({
  ok: true, enabled: true, profile_epoch: 7, state_revision: 12,
  counts: {
    [c1]: { revision: 4, detection_count: null, species_count: 2 },
    [countSiblingId]: { revision: 2, detection_count: 17, species_count: 6 },
  },
}, mixedCountRequest), null, 'only paired nulls can represent an unavailable count row');

const mixedApplyCaptures = [
  { id: c1, name: 'Large period', status: 'stopped', revision: 4, detection_count: null, species_count: null },
  { id: countSiblingId, name: 'Small period', status: 'stopped', revision: 2, detection_count: null, species_count: null },
];
const patchedCountRows = [];
const mixedApplyContext = {
  Date: { now() { return 5000; } },
  educatorCountRequest: mixedCountRequest,
  educatorCountGeneration: 3,
  educatorCountCache: Object.create(null),
  educatorCaptureArchive: {
    [c1]: { ...mixedApplyCaptures[0] },
    [countSiblingId]: { ...mixedApplyCaptures[1] },
  },
  educatorState: {
    profile_epoch: '7', state_revision: 12, active: null,
    captures: mixedApplyCaptures,
  },
  adminSect: 'educators',
  document: { hidden: false },
  educatorCapture(id) { return mixedApplyCaptures.find((capture) => capture.id === id); },
  educatorCountCacheKey(profile, capture) { return `${profile}|${capture.id}|${capture.revision}`; },
  educatorCountRequestCurrent() { return true; },
  patchEducatorCaptureCounts(capture) { patchedCountRows.push(capture.id); },
  scheduleEducatorCountExpiry() {},
};
vm.createContext(mixedApplyContext);
vm.runInContext(functionSource('applyEducatorCaptureCounts'), mixedApplyContext);
assert.equal(mixedApplyContext.applyEducatorCaptureCounts(mixedCounts, mixedCountRequest), true,
  'a mixed count batch applies atomically to its current request');
assert.equal(mixedApplyContext.educatorCountCache[`7|${c1}|4`].unavailable, true,
  'the over-budget row is cached as unavailable instead of retried immediately');
assert.equal(mixedApplyContext.educatorCountCache[`7|${countSiblingId}|2`].detection_count, 17,
  'the numeric sibling is cached and preserved');
assert.deepEqual(patchedCountRows, [c1, countSiblingId],
  'both the unavailable row and numeric sibling receive an in-place patch');

function countCell() {
  return { textContent: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
}
const unavailableBirdCell = countCell();
const unavailableCallCell = countCell();
const unavailableCompactCell = countCell();
const unavailableView = countCell();
const unavailableRow = {
  dataset: { captureId: c1, captureRevision: '4' },
  attrs: {},
  querySelector(selector) {
    return {
      '.educator-birds': unavailableBirdCell,
      '.educator-calls': unavailableCallCell,
      '.educator-counts': unavailableCompactCell,
      '[data-view-capture]': unavailableView,
    }[selector] || null;
  },
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
};
const unavailableCapture = mixedApplyCaptures[0];
const countPatchContext = {
  Date,
  adminBody: { querySelector() { return unavailableRow; } },
  adminSect: 'educators',
};
vm.createContext(countPatchContext);
vm.runInContext([
  functionSource('educatorDurationSeconds'),
  functionSource('educatorDurationLabel'),
  functionSource('educatorDateLabel'),
  functionSource('educatorCaptureAccessibleLabel'),
  functionSource('patchEducatorCaptureCounts'),
].join('\n'), countPatchContext);
assert.equal(countPatchContext.patchEducatorCaptureCounts(unavailableCapture), true,
  'an unavailable count row is patched without repainting the saved list');
assert.equal(unavailableBirdCell.textContent, 'n/a');
assert.equal(unavailableCallCell.textContent, 'n/a');
assert.equal(unavailableCompactCell.textContent, 'n/a');
assert.equal(unavailableRow.attrs['data-count-unavailable'], 'true',
  'only the over-budget row receives the unavailable marker');
assert.match(unavailableView.attrs['aria-label'], /Bird and call counts unavailable/,
  'the unavailable row exposes an honest accessible summary');

countNow = 3000;
countCapture.detection_count = null;
countCapture.species_count = null;
countCapture._countsUnavailable = false;
countContext.educatorCountCache[countKey] = {
  revision: 4,
  detection_count: null,
  species_count: null,
  unavailable: true,
  fetched_at: countNow,
};
assert.equal(countContext.educatorCaptureNeedsCounts(countCapture), false,
  'a paired-null unavailable row does not immediately retry');
assert.equal(countCapture._countsUnavailable, true,
  'the cached unavailable state survives ordinary head polls');
countNow += 300001;
assert.equal(countContext.educatorCaptureNeedsCounts(countCapture), true,
  'an unavailable row eventually rechecks without entering a polling storm');
countNow = 3100;
countCapture.detection_count = 11;
countCapture.species_count = 5;
countContext.hydrateEducatorCaptureCounts(countContext.educatorState);
assert.equal(countCapture.detection_count, 11,
  'a later numeric server count supersedes a cached unavailable marker');
assert.equal(countCapture._countsUnavailable, false,
  'a numeric server count clears the row unavailable state');
assert.equal(countContext.educatorCountResponse({
  ok: true, enabled: true, profile_epoch: 8, state_revision: 12,
  counts: { [c1]: { revision: 4, detection_count: 99, species_count: 99 } },
}, countRequest), null, 'a response from a replacement educator profile is discarded');
assert.equal(countContext.educatorCountResponse({
  ok: true, enabled: true, profile_epoch: 7, state_revision: 13,
  counts: { [c1]: { revision: 4, detection_count: 99, species_count: 99 } },
}, countRequest), null, 'a response from a newer state snapshot is discarded instead of being mixed in');
assert.equal(countContext.educatorCountResponse({
  ok: true, enabled: true, profile_epoch: 7, state_revision: 12,
  counts: { [c1]: { revision: 5, detection_count: 99, species_count: 99 } },
}, countRequest), null, 'a response for a different capture revision is discarded');
assert.equal(countContext.educatorCountResponse({
  ok: true, enabled: true, profile_epoch: '7', state_revision: '12',
  counts: { [c1]: { revision: '4', detection_count: '9', species_count: '4' } },
}, countRequest), null, 'numeric-looking strings cannot bypass count response shape validation');
countContext.educatorState.state_revision = 13;
assert.equal(countContext.educatorCountRequestCurrent(countRequest), false,
  'a state switch while counts are in flight invalidates the response');
countContext.educatorState.state_revision = 12;
countContext.educatorState.profile_epoch = '8';
assert.equal(countContext.educatorCountRequestCurrent(countRequest), false,
  'a profile switch while counts are in flight invalidates the response');
countContext.educatorState.profile_epoch = '7';
countContext.educatorState.active = countCapture;
assert.equal(countContext.educatorCaptureNeedsCounts(countCapture), false,
  'the active listening period never uses the saved-count endpoint');
countContext.educatorState.active = null;
delete countCapture._countsUnavailable;
const mergedCountCapture = countContext.mergeEducatorCaptureCounts(
  { ...countCapture, detection_count: 9, species_count: 4 },
  { ...countCapture, detection_count: null, species_count: null }
);
assert.equal(mergedCountCapture.detection_count, 9,
  'a same-revision head merge cannot erase a materialized call count with null');
assert.equal(mergedCountCapture.species_count, 4,
  'a same-revision head merge cannot erase a materialized bird count with null');
assert.equal(countContext.educatorCountRowAvailable({ isConnected: true, closest() { return {}; } }), false,
  'collapsed folder children are excluded before any lazy count request');
assert.equal(countContext.educatorCountRowAvailable({ isConnected: true, closest() { return null; } }), true,
  'a loaded visible older row remains eligible for lazy counts');

const requestedCountIds = Array.from({ length: 9 }, (_, index) => `c_${index.toString(16).padStart(32, '0')}`);
let countRequestUrl = '';
const boundedCountContext = {
  EDUCATOR_COUNT_BATCH_MAX: 8,
  Date: { now() { return 1000; } },
  document: { hidden: false },
  adminSect: 'educators',
  educatorCountRequest: null,
  educatorCountGeneration: 2,
  educatorCountAttempted: Object.create(null),
  educatorState: {
    profile_epoch: '7', state_revision: 19,
    captures: requestedCountIds.map((id) => ({ id, status: 'stopped', revision: 1 })),
  },
  educatorCapture(id) { return boundedCountContext.educatorState.captures.find((capture) => capture.id === id); },
  educatorCaptureNeedsCounts() { return true; },
  educatorCountCacheKey(profile, capture) { return `${profile}|${capture.id}|${capture.revision}`; },
  adminJson(url) { countRequestUrl = url; return new Promise(() => {}); },
  encodeURIComponent,
};
vm.createContext(boundedCountContext);
vm.runInContext(functionSource('requestEducatorCaptureCounts'), boundedCountContext);
assert.equal(boundedCountContext.requestEducatorCaptureCounts(requestedCountIds), true,
  'visible stopped rows start one lazy count request');
assert.equal(boundedCountContext.educatorCountRequest.ids.length, 8,
  'one lazy count request is capped at eight captures');
assert.match(countRequestUrl, /action=capture-counts[\s\S]*state_revision=19/,
  'the bounded count request is pinned to the current state revision');
boundedCountContext.educatorCountRequest = null;
boundedCountContext.educatorCaptureNeedsCounts = () => false;
assert.equal(boundedCountContext.requestEducatorCaptureCounts(requestedCountIds), false,
  'active, global, fresh, and otherwise ineligible rows cannot emit a count request');

let countObserverDisconnects = 0;
let countRootRemovals = 0;
let countWindowRemovals = 0;
let countTimerClears = 0;
const countCleanupContext = {
  educatorCountObserver: { disconnect() { countObserverDisconnects += 1; } },
  educatorCountRoot: { removeEventListener() { countRootRemovals += 1; } },
  educatorCountFallbackHandler() {},
  educatorCountFallbackTimer: 1,
  educatorCountExpiryTimer: 2,
  educatorCountQueue: { [c1]: true },
  educatorCountAttempted: { [`7|${c1}|4`]: 1000 },
  educatorCountGeneration: 4,
  educatorCountRequest: countRequest,
  window: { removeEventListener() { countWindowRemovals += 1; } },
  clearTimeout() { countTimerClears += 1; },
  Object,
};
vm.createContext(countCleanupContext);
vm.runInContext(functionSource('stopEducatorCountObservation'), countCleanupContext);
countCleanupContext.stopEducatorCountObservation({ invalidate: true });
assert.equal(countObserverDisconnects, 1, 'count observation disconnects on route or authorization loss');
assert.equal(countRootRemovals, 1, 'the bounded fallback removes its saved-pane scroll listener');
assert.equal(countWindowRemovals, 1, 'the bounded fallback removes its resize listener');
assert.equal(countTimerClears, 2, 'count cleanup clears both its coalescing and freshness timers');
assert.equal(countCleanupContext.educatorCountGeneration, 5,
  'count cleanup invalidates an in-flight response generation');
assert.equal(countCleanupContext.educatorCountRequest, null,
  'count cleanup drops the in-flight request reference');
assert.equal(countCleanupContext.educatorCountAttempted[`7|${c1}|4`], undefined,
  'a canceled request can retry immediately after the Educators view reopens');
assert.match(functionSource('observeEducatorCaptureCounts'),
  /new IntersectionObserver\([\s\S]*\{ root: root, threshold: 0\.01 \}/,
  'lazy counts use the saved pane as their observer root');
assert.match(functionSource('observeEducatorCaptureCounts'),
  /educatorCountObserver !== observer\) return/,
  'a queued callback from a disconnected observer cannot start a stale count request');
assert.doesNotMatch(functionSource('patchEducatorCaptureCounts'),
  /paintEducators|replaceEducatorBody|liveAudioController|focus/,
  'count completion patches only metadata cells and the accessible row summary');
const countCells = {
  birds: { textContent: '' }, calls: { textContent: '' }, compact: { textContent: '' },
  view: { label: '', setAttribute(name, value) { if (name === 'aria-label') this.label = value; } },
};
let pendingCountRemoved = 0;
const patchCountRow = {
  dataset: { captureId: c1, captureRevision: '4' },
  querySelector(selector) {
    if (selector === '.educator-birds') return countCells.birds;
    if (selector === '.educator-calls') return countCells.calls;
    if (selector === '.educator-counts') return countCells.compact;
    if (selector === '[data-view-capture]') return countCells.view;
    return null;
  },
  removeAttribute(name) { if (name === 'data-count-pending') pendingCountRemoved += 1; },
};
const patchCountContext = {
  adminSect: 'educators',
  adminBody: { querySelector(selector) { return selector === `#educator-${c1}` ? patchCountRow : null; } },
  educatorCaptureAccessibleLabel(capture) { return `View ${capture.name}. 4 birds. 9 calls.`; },
  educatorDurationSeconds() { return 60; },
  educatorDurationLabel() { return '1:00'; },
  educatorDateLabel() { return 'Sep 2, 9:00 AM'; },
};
vm.createContext(patchCountContext);
vm.runInContext(functionSource('patchEducatorCaptureCounts'), patchCountContext);
assert.equal(patchCountContext.patchEducatorCaptureCounts({
  ...countCapture, detection_count: 9, species_count: 4,
}), true, 'a fresh count patches the existing saved row in place');
assert.equal(countCells.birds.textContent, '4', 'the existing Birds cell receives the fresh count');
assert.equal(countCells.calls.textContent, '9', 'the existing Calls cell receives the fresh count');
assert.equal(countCells.compact.textContent, '4b / 9c', 'the compact mobile count receives the same values');
assert.equal(countCells.view.label, 'View Period 3. 4 birds. 9 calls.',
  'the existing View control receives a fresh accessible summary');
assert.equal(pendingCountRemoved, 1, 'the patched row leaves the pending observation set');
assert.match(functionSource('suspendEducatorScopes'), /clearEducatorCountState/,
  'admin authorization loss clears private saved-count state');
assert.match(html, /styles\.css\?v=r196/, 'the Educators workspace styles use the frozen cache key');
assert.match(html, /apt\.js\?v=r240/, 'the Educators workspace behavior uses the frozen cache key');

console.log('Educators frontend smoke: ok');
