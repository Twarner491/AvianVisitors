#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
const birdnet = fs.readFileSync(new URL('../avian/api/birdnet-api.php', import.meta.url), 'utf8');

function functionSource(name) {
  const start = apt.indexOf(`function ${name}(`);
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

let intervalCallback = null;
let intervalsStarted = 0;
let intervalsStopped = 0;
let refreshCalls = 0;
let resolveRefresh = null;
const context = {
  Promise,
  console,
  window: {},
  document: { hidden: false },
  educatorScopeBlocked: false,
  effectiveEducatorScope: null,
  POLL_MS: 30000,
  pollTimer: null,
  periodicRefreshInFlight: null,
  visibilityRefreshQueued: false,
  realtimePollingReady: true,
  educatorScopeNeedsProbe() { return false; },
  cancelEducatorScopeProbe() {},
  setInterval(callback, delay) {
    assert.equal(delay, 30000, 'the live refresh cadence remains 30 seconds');
    intervalCallback = callback;
    intervalsStarted += 1;
    return intervalsStarted;
  },
  clearInterval() { intervalsStopped += 1; },
  refreshAll() {
    refreshCalls += 1;
    return new Promise((resolve) => { resolveRefresh = resolve; });
  },
};
vm.createContext(context);
vm.runInContext([
  functionSource('educatorScopeNeedsRealtimePolling'),
  functionSource('runPeriodicRefresh'),
  functionSource('startPolling'),
  functionSource('stopPolling'),
  functionSource('syncRealtimePolling'),
].join('\n'), context);

assert.equal(context.educatorScopeNeedsRealtimePolling(), true,
  'the station-wide live view keeps realtime polling');
context.effectiveEducatorScope = { id: 'active', automatic: true, status: 'paused' };
assert.equal(context.educatorScopeNeedsRealtimePolling(), true,
  'the automatic current-period route keeps realtime state validation');
context.effectiveEducatorScope = { id: `c_${'1'.repeat(32)}`, automatic: false, status: 'running' };
assert.equal(context.educatorScopeNeedsRealtimePolling(), true,
  'an explicitly selected running capture remains live');
context.effectiveEducatorScope = { id: `c_${'1'.repeat(32)}`, automatic: false, status: 'stopped' };
assert.equal(context.educatorScopeNeedsRealtimePolling(), false,
  'a stopped saved capture leaves the heavyweight polling path');
context.effectiveEducatorScope = { id: `f_${'2'.repeat(32)}`, automatic: false, status: 'saved' };
assert.equal(context.educatorScopeNeedsRealtimePolling(), false,
  'a saved folder leaves the heavyweight polling path');
context.educatorScopeBlocked = true;
assert.equal(context.educatorScopeNeedsRealtimePolling(), false,
  'an unavailable capability cannot start a retry loop');

context.educatorScopeBlocked = false;
context.effectiveEducatorScope = { id: 'active', automatic: true, status: 'running' };
context.startPolling();
context.startPolling();
assert.equal(intervalsStarted, 1, 'syncing a live scope never stacks interval timers');
intervalCallback();
await Promise.resolve();
assert.equal(refreshCalls, 1, 'the first timer tick starts one refresh batch');
intervalCallback();
await Promise.resolve();
assert.equal(refreshCalls, 1, 'a timer tick is dropped while the prior batch is in flight');
resolveRefresh(true);
await context.periodicRefreshInFlight;
assert.equal(refreshCalls, 1, 'a dropped timer tick does not run back to back after completion');

context.effectiveEducatorScope = { id: `c_${'3'.repeat(32)}`, automatic: false, status: 'stopped' };
context.syncRealtimePolling();
assert.equal(context.pollTimer, null, 'selecting a stopped capture stops the live interval');
assert.equal(intervalsStopped, 1, 'the existing live interval is cleared once');
const savedVisibilityPromise = context.runPeriodicRefresh(true);
await Promise.resolve();
assert.equal(refreshCalls, 2, 'visibility return forces one saved-view refresh');
resolveRefresh(true);
await savedVisibilityPromise;

context.effectiveEducatorScope = { id: 'active', automatic: true, status: 'running' };
context.startPolling();
intervalCallback();
await Promise.resolve();
assert.equal(refreshCalls, 3, 'the next live interval can start after the prior batch settles');
const visibilityPromise = context.runPeriodicRefresh(true);
assert.equal(refreshCalls, 3, 'visibility return does not overlap an active periodic batch');
resolveRefresh(true);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(refreshCalls, 4, 'visibility return queues exactly one follow-up refresh');
resolveRefresh(true);
await visibilityPromise;
assert.equal(context.periodicRefreshInFlight, null, 'the queued visibility refresh releases its guard');

context.document.hidden = true;
context.syncRealtimePolling();
const beforeHidden = refreshCalls;
await context.runPeriodicRefresh(true);
assert.equal(refreshCalls, beforeHidden, 'hidden tabs never start a scoped batch');

assert.match(apt,
  /document\.addEventListener\('visibilitychange',[\s\S]*syncRealtimePolling\(\{ resetProbe: true \}\)[\s\S]*runEducatorScopeProbe\(true\)[\s\S]*runPeriodicRefresh\(true\)/,
  'visibility return resumes with one immediate saved probe or live refresh');
assert.match(functionSource('applyEducatorScope'),
  /resetScopedDataCaches\(\);[\s\S]*refreshAll\(true\)/,
  'scope selection and admin mutation refresh the selected dataset directly');

const cSaved = `c_${'3'.repeat(32)}`;
const fSaved = `f_${'4'.repeat(32)}`;
let probeClock = 1000;
let nextProbeTimer = 1;
const probeTimers = new Map();
const probeRequests = [];
let probeRefreshes = 0;
let probeBlocks = 0;
let probeGlobalFallbacks = 0;
let probeStorageWrites = 0;
function deferredProbe(url) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const request = { url, promise, resolve, reject };
  probeRequests.push(request);
  return promise;
}
const probeContext = {
  Promise,
  JSON,
  Number,
  Object,
  Array,
  window: {},
  Date: { now() { return probeClock; } },
  document: { hidden: false },
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  EDUCATOR_SCOPE_KEY: 'scope',
  POLL_MS: 30000,
  EDUCATOR_SCOPE_PROBE_SLOW_MS: 120000,
  EDUCATOR_SCOPE_PROBE_GRACE_MS: 120000,
  educatorScopeBlocked: false,
  educatorScopeShared: true,
  educatorScopesAuthorized: true,
  educatorScopeGeneration: 3,
  effectiveEducatorScope: {
    id: cSaved, kind: 'capture', automatic: false, status: 'stopped',
    revision: 2, state_key: 'a'.repeat(24), state_revision: 7,
  },
  explicitEducatorScope: null,
  educatorScopeProbeTimer: null,
  educatorScopeProbeInFlight: null,
  educatorScopeProbeQueued: false,
  educatorScopeProbeEpoch: 0,
  educatorScopeProbeIdentity: '',
  educatorScopeProbeSnapshot: null,
  educatorScopeProbeFastUntil: 0,
  periodicRefreshInFlight: null,
  visibilityRefreshQueued: false,
  realtimePollingReady: true,
  pollTimer: null,
  educatorRequestScopeId() {
    return probeContext.explicitEducatorScope ? probeContext.explicitEducatorScope.id : '';
  },
  writeLS() { probeStorageWrites += 1; },
  fetchJson(url) { return deferredProbe(url); },
  birdApiUrl(action, params, scopeId) { return `${action}?edu=${scopeId}`; },
  runPeriodicRefresh() { probeRefreshes += 1; return Promise.resolve(true); },
  blockEducatorScope() { probeBlocks += 1; probeContext.educatorScopeBlocked = true; },
  applyEducatorScope() { probeGlobalFallbacks += 1; },
  startPolling() {},
  stopPolling() {},
  setTimeout(callback, delay) {
    const id = nextProbeTimer++;
    probeTimers.set(id, { callback, delay });
    return id;
  },
  clearTimeout(id) { probeTimers.delete(id); },
};
probeContext.explicitEducatorScope = probeContext.effectiveEducatorScope;
vm.createContext(probeContext);
vm.runInContext([
  functionSource('validEducatorId'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeNeedsRealtimePolling'),
  functionSource('educatorScopeNeedsProbe'),
  functionSource('educatorScopeProbeKey'),
  functionSource('cancelEducatorScopeProbe'),
  functionSource('educatorScopeProbeCurrent'),
  functionSource('educatorScopeProbeResponse'),
  functionSource('acceptEducatorScopeProbe'),
  functionSource('educatorScopeTooLargeMessage'),
  functionSource('handleEducatorScopeProbeFailure'),
  functionSource('educatorScopeProbeDelay'),
  functionSource('scheduleEducatorScopeProbe'),
  functionSource('runEducatorScopeProbe'),
  functionSource('syncEducatorScopeProbe'),
  functionSource('syncRealtimePolling'),
].join('\n'), probeContext);

function probePayload({ open = false, fingerprint = 'b'.repeat(24), key = 'a'.repeat(24),
  kind = 'capture', status = 'stopped', revision = 2, stateRevision = 7 } = {}) {
  return {
    open,
    fingerprint,
    educator_scope: {
      kind, revision, status, automatic: false,
      state_revision: stateRevision, state_key: key,
    },
  };
}
function fireOnlyProbeTimer() {
  assert.equal(probeTimers.size, 1, 'the saved scope owns one timeout');
  const [id, timer] = probeTimers.entries().next().value;
  probeTimers.delete(id);
  timer.callback();
  return timer.delay;
}
function flushProbe() {
  return new Promise((resolve) => setImmediate(resolve));
}

probeContext.syncEducatorScopeProbe(true);
assert.equal(fireOnlyProbeTimer(), 30000,
  'a newly selected stopped capture probes at 30 seconds during its grace window');
assert.match(probeRequests[0].url, new RegExp(`^scope-probe\\?edu=${cSaved}$`),
  'the lightweight probe carries only the opaque saved capability');
probeRequests[0].resolve(probePayload());
await probeRequests[0].promise;
await flushProbe();
assert.equal(probeRefreshes, 1,
  'the first unknown probe triggers one coherent full refresh');
assert.equal(probeTimers.size, 1, 'a successful probe schedules one successor');
probeClock += 120001;
assert.equal(fireOnlyProbeTimer(), 30000,
  'the already-owned grace timer keeps its original 30-second cadence');
probeRequests[1].resolve(probePayload());
await probeRequests[1].promise;
await flushProbe();
assert.equal(probeRefreshes, 1, 'an unchanged fingerprint does not rebuild public views');
assert.equal(fireOnlyProbeTimer(), 120000,
  'a closed stopped capture settles to one probe every two minutes after grace');
probeRequests[2].resolve(probePayload({ fingerprint: 'c'.repeat(24) }));
await probeRequests[2].promise;
await flushProbe();
assert.equal(probeRefreshes, 2,
  'a late post-Stop analyzer insert changes the fingerprint and refreshes once');

probeContext.educatorScopeGeneration += 1;
probeContext.effectiveEducatorScope = {
  id: fSaved, kind: 'folder', automatic: false, status: 'saved',
  revision: 1, state_key: 'd'.repeat(24), state_revision: 8,
};
probeContext.explicitEducatorScope = probeContext.effectiveEducatorScope;
probeContext.syncEducatorScopeProbe(true);
assert.equal(fireOnlyProbeTimer(), 30000, 'a new saved folder starts in the short grace cadence');
const folderInitial = probeRequests.at(-1);
folderInitial.resolve(probePayload({
  open: true, fingerprint: 'e'.repeat(24), key: 'd'.repeat(24),
  kind: 'folder', status: 'saved', revision: 1, stateRevision: 8,
}));
await folderInitial.promise;
await flushProbe();
assert.equal(probeRefreshes, 3, 'a folder containing a running capture refreshes on initial discovery');
probeClock += 300000;
assert.equal(fireOnlyProbeTimer(), 30000,
  'an open folder stays on the lightweight 30-second probe');
const folderLateInsert = probeRequests.at(-1);
folderLateInsert.resolve(probePayload({
  open: true, fingerprint: 'f'.repeat(24), key: 'd'.repeat(24),
  kind: 'folder', status: 'saved', revision: 1, stateRevision: 8,
}));
await folderLateInsert.promise;
await flushProbe();
assert.equal(probeRefreshes, 4, 'an open-folder fingerprint change refreshes exactly once');
assert.equal(fireOnlyProbeTimer(), 30000, 'the open folder keeps exactly one fast successor');
const folderDeletion = probeRequests.at(-1);
folderDeletion.resolve(probePayload({
  open: true, fingerprint: '0'.repeat(24), key: 'e'.repeat(24),
  kind: 'folder', status: 'saved', revision: 1, stateRevision: 9,
}));
await folderDeletion.promise;
await flushProbe();
assert.equal(probeRefreshes, 5,
  'a deletion reflected in fingerprint and state key triggers one full refresh');

fireOnlyProbeTimer();
const overlapA = probeRequests.at(-1);
const sameFlight = probeContext.runEducatorScopeProbe(true);
assert.equal(probeRequests.at(-1), overlapA, 'an overlapping forced probe joins the in-flight request');
overlapA.resolve(probePayload({
  open: true, fingerprint: '0'.repeat(24), key: 'e'.repeat(24),
  kind: 'folder', status: 'saved', revision: 1, stateRevision: 9,
}));
await overlapA.promise;
await flushProbe();
const overlapB = probeRequests.at(-1);
assert.notEqual(overlapB, overlapA, 'one queued forced probe starts after the first settles');
probeContext.educatorScopeGeneration += 1;
probeContext.effectiveEducatorScope = {
  id: cSaved, kind: 'capture', automatic: false, status: 'stopped',
  revision: 3, state_key: '1'.repeat(24), state_revision: 10,
};
probeContext.explicitEducatorScope = probeContext.effectiveEducatorScope;
probeContext.syncEducatorScopeProbe(true);
const refreshesBeforeStale = probeRefreshes;
overlapB.resolve(probePayload({ fingerprint: '9'.repeat(24), key: '9'.repeat(24) }));
await sameFlight;
await overlapB.promise;
await flushProbe();
assert.equal(probeRefreshes, refreshesBeforeStale,
  'a stale probe response after a scope generation switch cannot refresh data');
assert.equal(probeTimers.size, 1,
  'scope cancellation leaves only the new capability timer');

fireOnlyProbeTimer();
const temporaryFailure = probeRequests.at(-1);
temporaryFailure.reject({ status: 503 });
await temporaryFailure.promise.catch(() => {});
await flushProbe();
assert.equal(probeBlocks, 0, 'a transient probe failure keeps rendered data available');
assert.equal(probeRefreshes, refreshesBeforeStale, 'a transient probe failure does not start a full retry batch');
assert.equal(probeTimers.size, 1, 'a transient probe failure schedules only the normal successor');

probeContext.document.hidden = true;
probeContext.cancelEducatorScopeProbe(true);
assert.equal(probeTimers.size, 0, 'visibility loss cancels the saved-scope timer');
probeContext.document.hidden = false;
probeContext.syncEducatorScopeProbe(true);
const beforeResumeRequests = probeRequests.length;
probeContext.runEducatorScopeProbe(true);
assert.equal(probeRequests.length, beforeResumeRequests + 1,
  'visibility resume performs one immediate saved-scope probe');
const resumed = probeRequests.at(-1);
resumed.resolve(probePayload({
  fingerprint: '1'.repeat(24), key: '1'.repeat(24), revision: 3, stateRevision: 10,
}));
await resumed.promise;
await flushProbe();
assert.equal(probeGlobalFallbacks, 0, 'saved probe scheduling never exposes station-wide data');

probeContext.cancelEducatorScopeProbe(true);
probeContext.educatorScopesAuthorized = false;
probeContext.educatorScopeGeneration += 1;
probeContext.effectiveEducatorScope = {
  id: fSaved, kind: 'folder', automatic: false, status: 'saved',
  revision: 4, state_key: '2'.repeat(24), state_revision: 11,
};
probeContext.explicitEducatorScope = probeContext.effectiveEducatorScope;
probeContext.syncEducatorScopeProbe(true);
probeContext.runEducatorScopeProbe(true);
const anonymousProbe = probeRequests.at(-1);
const writesBeforeAnonymousProbe = probeStorageWrites;
anonymousProbe.resolve(probePayload({
  fingerprint: '2'.repeat(24), key: '2'.repeat(24), kind: 'folder',
  status: 'saved', revision: 4, stateRevision: 11,
}));
await anonymousProbe.promise;
await flushProbe();
assert.equal(probeStorageWrites, writesBeforeAnonymousProbe,
  'an anonymous shared capability probe never persists its bearer ID');

probeContext.cancelEducatorScopeProbe(true);
probeContext.educatorScopesAuthorized = true;
probeContext.educatorScopeGeneration += 1;
probeContext.effectiveEducatorScope = {
  id: cSaved, kind: 'capture', automatic: false, status: 'stopped',
  revision: 5, state_key: '3'.repeat(24), state_revision: 12,
};
probeContext.explicitEducatorScope = probeContext.effectiveEducatorScope;
probeContext.syncEducatorScopeProbe(true);
probeContext.runEducatorScopeProbe(true);
const authLossProbe = probeRequests.at(-1);
probeContext.educatorScopesAuthorized = false;
const writesBeforeAuthLossResponse = probeStorageWrites;
authLossProbe.resolve(probePayload({
  fingerprint: '3'.repeat(24), key: '3'.repeat(24), revision: 5, stateRevision: 12,
}));
await authLossProbe.promise;
await flushProbe();
assert.equal(probeStorageWrites, writesBeforeAuthLossResponse,
  'a probe resolving after auth loss cannot restore the saved bearer capability');
assert.match(functionSource('adoptEducatorScope'),
  /explicitEducatorScope\.id === returned\.id[\s\S]*if \(educatorScopesAuthorized\)[\s\S]*writeLS\(EDUCATOR_SCOPE_KEY/,
  'full scoped responses follow the same no-storage boundary after auth loss');

probeContext.cancelEducatorScopeProbe(true);
probeContext.educatorScopeBlocked = false;
probeContext.educatorScopeShared = true;
probeContext.educatorScopeGeneration += 1;
probeContext.effectiveEducatorScope = {
  id: fSaved, kind: 'folder', automatic: false, status: 'saved',
  revision: 6, state_key: '4'.repeat(24), state_revision: 13,
};
probeContext.explicitEducatorScope = probeContext.effectiveEducatorScope;
probeContext.syncEducatorScopeProbe(true);
probeContext.runEducatorScopeProbe(true);
const deletedProbe = probeRequests.at(-1);
const blocksBeforeDeletedProbe = probeBlocks;
deletedProbe.reject({ status: 404, body: { error: 'not found', educator_scope: null } });
await deletedProbe.promise.catch(() => {});
await flushProbe();
assert.equal(probeBlocks, blocksBeforeDeletedProbe + 1,
  'a saved-scope probe 404 enters the existing permanent fail-closed state');
assert.equal(probeTimers.size, 0, 'a deleted saved scope cannot retain a probe timer');
assert.equal(probeGlobalFallbacks, 0, 'a deleted saved scope cannot fall through to global data');

async function overCapMessage(authorized) {
  const messages = [];
  let globalFallbacks = 0;
  const scopeId = `f_${'a'.repeat(32)}`;
  const errorContext = {
    AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
    educatorScopeGeneration: 7,
    educatorScopeShared: true,
    educatorScopesAuthorized: authorized,
    adminAccessState: authorized ? 'unlocked' : 'locked',
    fetchJson() {
      return Promise.reject({
        status: 413,
        body: { error: 'saved view unavailable', educator_scope: null },
      });
    },
    birdApiUrl() { return '/scoped'; },
    adoptEducatorScope() { throw new Error('an over-cap response must not be adopted'); },
    validEducatorId(value) { return /^[cf]_[a-f0-9]{32}$/.test(value); },
    blockEducatorScope(message) { messages.push(message); },
    applyEducatorScope() { globalFallbacks += 1; },
    setTimeout() { globalFallbacks += 1; },
    showAdminLocked() {},
    signalAdminLock() {},
  };
  vm.createContext(errorContext);
  vm.runInContext([
    functionSource('validEducatorScopeKey'),
    functionSource('normalizeEducatorScope'),
    functionSource('educatorScopeFromPayload'),
    functionSource('educatorScopeTooLargeMessage'),
    functionSource('automaticEducatorScopeTooLarge'),
    functionSource('scopedFetchJson'),
  ].join('\n'), errorContext);
  await assert.rejects(errorContext.scopedFetchJson('stats', {}, {
    generation: 7,
    scopeId,
  }));
  assert.equal(globalFallbacks, 0, 'an over-cap capability never falls back to station-wide data');
  assert.equal(messages.length, 1, 'an over-cap capability enters one permanent blocked state');
  return messages[0];
}

assert.equal(await overCapMessage(false), 'listening period unavailable',
  'a shared over-cap capability fails with generic copy');
assert.equal(await overCapMessage(true), 'saved view is too large; split it into a smaller folder',
  'an authenticated over-cap scope gives the educator an honest recovery path');
let activeCapMessage = '';
let activeCapFallbacks = 0;
let activeCapRetries = 0;
const activeCapContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  educatorScopeGeneration: 18,
  educatorScopeShared: false,
  educatorScopesAuthorized: true,
  adminAccessState: 'unlocked',
  fetchJson() { return Promise.reject({ status: 413, body: { error: 'saved view unavailable' } }); },
  birdApiUrl() { return '/active'; },
  adoptEducatorScope() { throw new Error('an over-cap current period cannot be adopted'); },
  validEducatorId(value) { return /^[cf]_[a-f0-9]{32}$/.test(value); },
  blockEducatorScope(message) { activeCapMessage = message; },
  applyEducatorScope() { activeCapFallbacks += 1; },
  setTimeout() { activeCapFallbacks += 1; },
  noteEducatorScopeFailure() { activeCapRetries += 1; },
  showAdminLocked() {},
  signalAdminLock() {},
};
vm.createContext(activeCapContext);
vm.runInContext([
  functionSource('validEducatorScopeKey'),
  functionSource('normalizeEducatorScope'),
  functionSource('educatorScopeFromPayload'),
  functionSource('educatorScopeTooLargeMessage'),
  functionSource('automaticEducatorScopeTooLarge'),
  functionSource('scopedFetchJson'),
].join('\n'), activeCapContext);
await assert.rejects(activeCapContext.scopedFetchJson('stats', {}, {
  generation: 18, scopeId: 'active',
}));
assert.equal(activeCapMessage,
  'current listening period is too large; stop it and start a new period',
  'an over-cap active period fails closed with an honest recovery instruction');
assert.equal(activeCapFallbacks, 0, 'an over-cap active period never falls back to global data');
assert.equal(activeCapRetries, 0, 'a permanent active-period 413 does not enter the 5xx retry controller');
activeCapMessage = '';
activeCapContext.fetchJson = function () {
  return Promise.reject({
    status: 413,
    body: {
      error: 'educator scope is too large',
      educator_scope: {
        kind: 'capture', revision: 1, status: 'running', automatic: true,
        state_revision: 4, state_key: 'a'.repeat(24),
      },
    },
  });
};
await assert.rejects(activeCapContext.scopedFetchJson('stats', {}, {
  generation: 18, scopeId: '',
}));
assert.equal(activeCapMessage,
  'current listening period is too large; stop it and start a new period',
  'a fresh no-edu request recognizes an automatic active-period 413 safely');
assert.equal(activeCapFallbacks, 0,
  'a fresh automatic active-period 413 cannot fall through to global data');
assert.equal(activeCapRetries, 0,
  'a fresh automatic active-period 413 cannot create a transient retry loop');
activeCapMessage = '';
activeCapContext.fetchJson = function () {
  return Promise.reject({
    status: 413,
    body: { educator_scope: { kind: 'capture', automatic: true, status: 'running' } },
  });
};
await assert.rejects(activeCapContext.scopedFetchJson('stats', {}, {
  generation: 18, scopeId: '',
}));
assert.equal(activeCapMessage, '',
  'an incomplete error payload cannot spoof the automatic active-scope discriminator');
assert.match(birdnet,
  /\$educatorPublicCapability\s*=\s*\$educatorSavedRequest\s*;/,
  'all opaque saved capabilities receive the generic error contract');
assert.match(birdnet,
  /'educator_scope'\s*=>\s*\$educatorPublicCapability\s*\?\s*null/,
  'a public materialization failure returns no scoped metadata');

let retryRefreshes = 0;
let retryClears = 0;
const retryTimers = [];
const retryStatus = { textContent: '' };
const retryContext = {
  AUTOMATIC_EDUCATOR_SCOPE_ID: 'active',
  EDUCATOR_SCOPE_RETRY_MS: 1400,
  educatorScopeRetry: null,
  educatorScopeCompletedAttempt: 0,
  educatorScopeGeneration: 7,
  effectiveEducatorScope: {
    id: `f_${'b'.repeat(32)}`, status: 'saved', state_key: 'a'.repeat(24), state_revision: 4,
  },
  educatorDataLoading: false,
  document: {
    hidden: false,
    getElementById(id) { return id === 'educatorDataLoading' ? retryStatus : null; },
  },
  educatorRequestScopeId() { return retryContext.effectiveEducatorScope.id; },
  validEducatorId(value) { return /^[cf]_[a-f0-9]{32}$/.test(value); },
  setEducatorDataLoading(value) { retryContext.educatorDataLoading = !!value; },
  setTimeout(callback, delay) {
    retryTimers.push({ callback, delay, cleared: false });
    return retryTimers.length;
  },
  clearTimeout(id) {
    retryClears += 1;
    if (retryTimers[id - 1]) retryTimers[id - 1].cleared = true;
  },
  refreshAll() { retryRefreshes += 1; return Promise.resolve(true); },
};
vm.createContext(retryContext);
vm.runInContext([
  functionSource('validEducatorScopeKey'),
  functionSource('educatorScopeRequestCurrent'),
  functionSource('educatorScopeRetryable'),
  functionSource('educatorScopeRetryKey'),
  functionSource('setEducatorScopeFailureStatus'),
  functionSource('cancelEducatorScopeRetry'),
  functionSource('noteEducatorScopeFailure'),
  functionSource('clearEducatorScopeFailure'),
].join('\n'), retryContext);
const savedRetryRequest = {
  attempt: 1,
  scopeId: retryContext.effectiveEducatorScope.id,
  generation: 7,
  stateKey: 'a'.repeat(24),
  stateRevision: 4,
};
assert.equal(retryContext.noteEducatorScopeFailure(savedRetryRequest), true,
  'the first saved-scope 5xx schedules one bounded retry');
assert.equal(retryTimers.length, 1, 'the first failure owns one timer');
assert.equal(retryTimers[0].delay, 1400, 'the retry is short and bounded');
assert.equal(retryStatus.textContent, 'birds are temporarily unavailable; retrying...',
  'the blank scoped view honestly announces its pending retry');
retryContext.noteEducatorScopeFailure(savedRetryRequest);
retryContext.noteEducatorScopeFailure(savedRetryRequest);
assert.equal(retryTimers.length, 1, 'parallel 5xx responses coalesce onto the same retry timer');
retryTimers[0].callback();
assert.equal(retryRefreshes, 1, 'the saved scope retries exactly once');
const successfulRetryRequest = { ...savedRetryRequest, attempt: 2 };
assert.equal(retryContext.clearEducatorScopeFailure(successfulRetryRequest), true,
  'the coherent retry success clears the bounded failure state');
assert.equal(retryContext.educatorScopeRetry, null,
  'success leaves no retry ownership behind');
retryContext.setEducatorDataLoading(false);
retryStatus.textContent = '';
const timersAfterSuccess = retryTimers.length;
assert.equal(retryContext.noteEducatorScopeFailure(savedRetryRequest), false,
  'a late failure from the original batch is older than the completed retry watermark');
assert.equal(retryTimers.length, timersAfterSuccess,
  'a late original failure cannot recreate retry ownership or add a timer');
assert.equal(retryContext.educatorDataLoading, false,
  'a late original failure cannot hide views restored by the successful retry');
assert.equal(retryStatus.textContent, '',
  'a late original failure cannot replace the recovered view with stale status copy');
assert.equal(retryContext.educatorScopeRetry, null,
  'a late original failure leaves retry ownership cleared');

retryContext.educatorScopeGeneration = 8;
retryContext.effectiveEducatorScope = {
  id: `f_${'c'.repeat(32)}`, status: 'saved', state_key: 'b'.repeat(24), state_revision: 5,
};
const repeatedFailureRequest = {
  attempt: 3,
  scopeId: retryContext.effectiveEducatorScope.id,
  generation: 8,
  stateKey: 'b'.repeat(24),
  stateRevision: 5,
};
retryContext.noteEducatorScopeFailure(repeatedFailureRequest);
const repeatedFailureTimer = retryTimers.at(-1);
repeatedFailureTimer.callback();
assert.equal(retryRefreshes, 2, 'a separate saved scope still receives its one retry');
retryContext.noteEducatorScopeFailure({ ...repeatedFailureRequest, attempt: 4 });
assert.equal(retryTimers.length, 2, 'a repeated 5xx after the retry cannot schedule an endless loop');
assert.equal(retryStatus.textContent, 'birds are temporarily unavailable; try again shortly',
  'a repeated 5xx resolves retrying copy to an honest temporary-unavailable state');
retryContext.clearEducatorScopeFailure({ ...repeatedFailureRequest, attempt: 4 });

retryContext.educatorScopeGeneration = 9;
retryContext.effectiveEducatorScope = {
  id: `f_${'f'.repeat(32)}`, status: 'saved', state_key: 'e'.repeat(24), state_revision: 8,
};
const switchedRequest = {
  attempt: 5,
  scopeId: retryContext.effectiveEducatorScope.id,
  generation: 9,
  stateKey: 'e'.repeat(24),
  stateRevision: 8,
};
retryContext.noteEducatorScopeFailure(switchedRequest);
const switchedTimer = retryTimers.at(-1);
retryContext.educatorScopeGeneration = 10;
switchedTimer.callback();
assert.equal(retryRefreshes, 2,
  'a scope generation switch cancels the stale retry before it can fetch');
assert.equal(retryContext.educatorScopeRetry, null,
  'a stale scope timer releases its retry state');

retryContext.educatorScopeGeneration = 11;
retryContext.effectiveEducatorScope = {
  id: `c_${'d'.repeat(32)}`, status: 'stopped', state_key: 'c'.repeat(24), state_revision: 6,
};
const hiddenRequest = {
  attempt: 6,
  scopeId: retryContext.effectiveEducatorScope.id,
  generation: 11,
  stateKey: 'c'.repeat(24),
  stateRevision: 6,
};
retryContext.noteEducatorScopeFailure(hiddenRequest);
retryContext.document.hidden = true;
retryContext.cancelEducatorScopeRetry();
assert.equal(retryContext.educatorScopeRetry, null,
  'visibility loss cancels a pending saved-count retry');
assert.ok(retryClears >= 1, 'visibility and lifecycle cancellation clear the owned timer');

retryContext.document.hidden = false;
retryContext.educatorScopeGeneration = 12;
retryContext.effectiveEducatorScope = {
  id: 'active', automatic: true, status: 'running', state_key: 'd'.repeat(24), state_revision: 7,
};
const activeFailure = {
  attempt: 7,
  scopeId: 'active', generation: 12, stateKey: 'd'.repeat(24), stateRevision: 7,
};
const timersBeforeActive = retryTimers.length;
assert.equal(retryContext.noteEducatorScopeFailure(activeFailure), false,
  'the active live scope fails closed without an automatic saved-view retry');
assert.equal(retryTimers.length, timersBeforeActive,
  'active and global datasets cannot start a saved-scope retry timer');
assert.match(functionSource('scopedFetchJson'),
  /error\.status >= 500 && error\.status <= 599[\s\S]*noteEducatorScopeFailure\(request\)/,
  'scoped 5xx responses enter the bounded temporary-failure controller');
let integratedTemporaryFailures = 0;
let integratedGlobalFallbacks = 0;
const integratedFailureContext = {
  educatorScopeGeneration: 14,
  educatorScopeShared: true,
  educatorScopesAuthorized: true,
  adminAccessState: 'unlocked',
  fetchJson() { return Promise.reject({ status: 503, body: { error: 'temporary' } }); },
  birdApiUrl() { return '/scoped'; },
  adoptEducatorScope() { return true; },
  educatorScopeFromPayload() { return undefined; },
  validEducatorId(value) { return /^[cf]_[a-f0-9]{32}$/.test(value); },
  noteEducatorScopeFailure() { integratedTemporaryFailures += 1; },
  blockEducatorScope() {},
  applyEducatorScope() { integratedGlobalFallbacks += 1; },
  refreshAll() { integratedGlobalFallbacks += 1; },
  showAdminLocked() {},
  signalAdminLock() {},
  setTimeout() { integratedGlobalFallbacks += 1; },
};
vm.createContext(integratedFailureContext);
vm.runInContext(functionSource('scopedFetchJson'), integratedFailureContext);
await assert.rejects(integratedFailureContext.scopedFetchJson('recent', {}, {
  scopeId: `f_${'e'.repeat(32)}`, generation: 14,
}));
assert.equal(integratedTemporaryFailures, 1,
  'a real scoped 503 enters the temporary-failure controller once');
assert.equal(integratedGlobalFallbacks, 0,
  'a scoped 503 cannot expose station-wide data while retrying');
assert.match(functionSource('refreshAll'),
  /clearEducatorScopeFailure\(request\)[\s\S]*setEducatorDataLoading\(false\)/,
  'a coherent retry success restores the hidden bird views');
assert.match(apt,
  /document\.addEventListener\('visibilitychange',[\s\S]*cancelEducatorScopeRetry\(\)[\s\S]*stopPolling\(\)/,
  'visibility loss cancels scoped retry ownership before polling stops');

probeContext.cancelEducatorScopeProbe(true);
probeContext.document.hidden = false;
probeContext.educatorScopeBlocked = false;
probeContext.window.__avianFrameCapture = true;
for (const [id, status] of [[cSaved, 'stopped'], [fSaved, 'saved']]) {
  probeContext.explicitEducatorScope = probeContext.effectiveEducatorScope = { id, automatic: false, status };
  assert.equal(probeContext.educatorScopeNeedsRealtimePolling(), false, 'frame snapshots do not poll');
  assert.equal(probeContext.educatorScopeNeedsProbe(), false, 'frame snapshots do not probe saved scopes');
  assert.equal(probeContext.scheduleEducatorScopeProbe(), false);
  const before = probeRequests.length;
  await probeContext.runEducatorScopeProbe(false);
  await probeContext.runEducatorScopeProbe(true);
  probeContext.syncRealtimePolling();
  assert.equal(probeRequests.length, before, 'neither timed nor forced probes change a frame snapshot');
  assert.equal(probeContext.educatorScopeProbeTimer, null);
}
probeContext.window.__avianFrameCapture = false;
assert.equal(probeContext.educatorScopeNeedsProbe(), true, 'ordinary saved views still probe');
assert.equal(probeContext.scheduleEducatorScopeProbe(), true);
probeContext.cancelEducatorScopeProbe(true);

console.log('Educator scope polling smoke: ok');
