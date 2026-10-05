#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'avian', 'frontend', 'apt.js'),
  'utf8'
);

function extractFunction(name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, 'missing function ' + name);
  const body = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = body; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('unterminated function ' + name);
}

function deferred() {
  let resolve;
  const promise = new Promise(function (done) { resolve = done; });
  return { promise: promise, resolve: resolve };
}

function response(status) {
  return {
    status: status,
    json: function () { return Promise.resolve({ items: [], auth: {} }); },
  };
}

function harness() {
  const requests = [];
  const context = {
    Promise: Promise,
    Number: Number,
    Date: Date,
    fetch: function () {
      const request = deferred();
      requests.push(request);
      return request.promise;
    },
    console: console,
  };
  vm.createContext(context);
  vm.runInContext([
    'var adminUnlockProbeGeneration = 0;',
    'var adminAccessState = "locked";',
    'var adminLastActivityAt = 0;',
    'var menuBtn = { classList: { toggle: function () {} } };',
    'function scheduleAdminIdleLock() {}',
    'function showAdminLocked() {',
    '  adminUnlockProbeGeneration += 1;',
    '  adminAccessState = "locked";',
    '}',
    'function renderMenu() {',
    '  adminUnlockProbeGeneration += 1;',
    '  adminAccessState = "unlocked";',
    '}',
    extractFunction('tryAutoUnlock'),
    extractFunction('receiveAdminAuthEvent'),
    'function authState() { return adminAccessState; }',
  ].join('\n'), context);
  return { context: context, requests: requests };
}

function adminFetchHarness() {
  const request = deferred();
  const body = deferred();
  const context = {
    Promise: Promise,
    fetch: function () { return request.promise; },
    console: console,
  };
  vm.createContext(context);
  vm.runInContext([
    'var adminAuthGeneration = 4;',
    'var adminViewGeneration = 8;',
    'var adminAccessState = "unlocked";',
    'var lockCount = 0;',
    'function cancelledAdminRequest(reason) {',
    '  var error = new Error(reason);',
    '  error.adminAuthCancelled = true;',
    '  return Promise.reject(error);',
    '}',
    'function guardAdminResponse(response) { return response; }',
    'function showAdminLocked() { lockCount += 1; adminAuthGeneration += 1; }',
    'function signalAdminLock() {}',
    'function tryAutoUnlock() {}',
    extractFunction('adminFetch'),
    'function replaceSession() { adminAuthGeneration += 1; }',
    'function locks() { return lockCount; }',
  ].join('\n'), context);
  return { context: context, request: request, body: body };
}

function settingsHarness() {
  const requests = [];
  const timers = new Map();
  let nextTimer = 1;
  const context = {
    Promise: Promise,
    JSON: JSON,
    Object: Object,
    console: console,
    setTimeout: function (callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: function (id) { timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext([
    'var pending = {};',
    'var autoSaveT = null;',
    'var settingsSaveBusy = false;',
    'function setSaveState() {}',
    'function adminAuthCancelled(error) { return !!(error && error.adminAuthCancelled); }',
    'function adminFetch(url, options) {',
    '  var request = new Promise(function (resolve, reject) {',
    '    requests.push({ body: options.body, resolve: resolve, reject: reject });',
    '  });',
    '  return request;',
    '}',
    extractFunction('discardPendingSettings'),
    extractFunction('restoreSubmittedSettings'),
    extractFunction('queueSave'),
    extractFunction('saveSettings'),
    'function setPending(value) { pending = value; }',
    'function pendingJson() { return JSON.stringify(pending); }',
    'function timerCount() { return autoSaveT === null ? 0 : 1; }',
  ].join('\n'), context);
  context.requests = requests;
  return { context: context, requests: requests, timers: timers };
}

function idleHarness() {
  const result = deferred();
  const context = {
    Promise: Promise,
    Date: { now: function () { return 1000; } },
    Math: Math,
    clearTimeout: function () {},
    setTimeout: function () { return 1; },
    idleResult: result.promise,
    console: console,
  };
  vm.createContext(context);
  vm.runInContext([
    'var adminIdleTimer = null;',
    'var adminAccessState = "unlocked";',
    'var adminAuthMeta = { required: true };',
    'var adminLastActivityAt = 0;',
    'var ADMIN_IDLE_MS = 100;',
    'var adminAutoLocking = false;',
    'var adminAuthGeneration = 2;',
    'var adminViewGeneration = 3;',
    'var locks = 0;',
    'var reprobes = 0;',
    'function sharedAdminActivity() { return 0; }',
    'function idleLockAdminSession() { return idleResult; }',
    'function tryAutoUnlock() { reprobes += 1; }',
    'function showAdminLocked() { locks += 1; }',
    'function signalAdminLock() {}',
    extractFunction('scheduleAdminIdleLock'),
    'function replaceSession() { adminAuthGeneration += 1; }',
    'function state() { return { locks: locks, reprobes: reprobes }; }',
  ].join('\n'), context);
  return { context: context, result: result };
}

function activityHarness() {
  let clock = 1000;
  let timer = null;
  let writes = 0;
  let messages = 0;
  const context = {
    Date: { now: function () { return clock; } },
    Math: Math,
    localStorage: { setItem: function () { writes += 1; } },
    setTimeout: function (callback) { timer = callback; return 1; },
    clearTimeout: function () { timer = null; },
  };
  vm.createContext(context);
  vm.runInContext([
    'var ADMIN_ACTIVITY_KEY = "activity";',
    'var ADMIN_ACTIVITY_PUBLISH_MS = 1000;',
    'var adminLastActivityAt = 0;',
    'var adminLastActivityPublishedAt = 0;',
    'var adminActivityPublishTimer = null;',
    'var adminChannel = { postMessage: function () { messages += 1; } };',
    extractFunction('writeAdminActivity'),
    extractFunction('publishAdminActivity'),
    'function lastActivity() { return adminLastActivityAt; }',
  ].join('\n'), context);
  context.messages = messages;
  return {
    context: context,
    setClock: function (value) { clock = value; },
    runTimer: function () { const callback = timer; timer = null; callback(); },
    writes: function () { return writes; },
    hasTimer: function () { return !!timer; },
  };
}

function generationHarness(accessState) {
  const status = deferred();
  const button = { textContent: 'generate image', disabled: false, hidden: false };
  const context = {
    Promise: Promise,
    JSON: JSON,
    document: {
      body: { contains: function () { return true; } },
      getElementById: function () { return button; },
    },
    clearTimeout: function () {},
    setTimeout: function () { return 1; },
    console: console,
  };
  vm.createContext(context);
  vm.runInContext([
    'var adminAccessState = ' + JSON.stringify(accessState) + ';',
    'var genPollT = null;',
    'var activeGenerate = null;',
    'var starts = 0;',
    'var opened = 0;',
    'var POSTCARD_POSE_CACHE = {};',
    'function loadTables() {}',
    'function openDd() { opened += 1; }',
    'function focusEl() {}',
    'function adminAuthCancelled(error) { return !!(error && error.adminAuthCancelled); }',
    'function adminFetch() {',
    '  starts += 1;',
    '  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });',
    '}',
    'function adminJson() { return statusPromise; }',
    extractFunction('genBtnState'),
    extractFunction('lockVisibleGenerateForAuth'),
    extractFunction('finishActiveGenerate'),
    extractFunction('watchGenerate'),
    extractFunction('startGenerate'),
    'function state() { return { starts: starts, opened: opened }; }',
  ].join('\n'), context);
  context.statusPromise = status.promise;
  return { context: context, status: status, button: button };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function main() {
  const hint = { textContent: '', children: [], appendChild: function (child) { this.children.push(child); } };
  const recoveryContext = { lockHint: hint, document: { createElement: function () { return {}; } } };
  vm.createContext(recoveryContext);
  vm.runInContext(extractFunction('setAdminLockHint'), recoveryContext);
  recoveryContext.setAdminLockHint('', true, true);
  assert.ok(hint.textContent.includes('installation'), 'missing helper explains installation recovery');
  assert.ok(!hint.textContent.includes('password-reset'), 'missing helper never recommends an unavailable reset command');
  assert.ok(hint.children[0].href.endsWith('#updating-an-existing-station'), 'installation recovery links to verified setup');
  recoveryContext.setAdminLockHint('', true, false);
  assert.ok(hint.textContent.includes('avian-admin-control password-reset'), 'healthy helper retains password recovery');
  const rowContext = {};
  vm.createContext(rowContext);
  vm.runInContext([
    'var ICON_EYE = "<svg aria-hidden=\\"true\\"></svg>";',
    'var ICON_EYE_OFF = "<svg aria-hidden=\\"true\\"></svg>";',
    extractFunction('settingsInfoMarkup'),
    extractFunction('lanAuthRow'),
  ].join('\n'), rowContext);
  const reconciliationRow = rowContext.lanAuthRow({
    lan_admin_auth: false,
    password_configured: true,
    policy_reconciliation_needed: true,
  });
  assert.ok(reconciliationRow.includes('data-lan-auth-reconcile'),
    'Settings exposes a same-value recovery action for a loaded-policy mismatch');
  assert.ok(reconciliationRow.includes('aria-checked="false"'),
    'the recovery action preserves the authoritative saved policy value');
  const lanAuthWire = extractFunction('wireLanAuthControl');
  assert.ok(lanAuthWire.includes('if (error.recovery)')
      && lanAuthWire.includes('if (error.reauth)')
      && lanAuthWire.includes('error.remediation'),
    'stream remediation can rebind the session without showing credential recovery');

  const activity = activityHarness();
  activity.context.publishAdminActivity(1000, false);
  activity.setClock(1100);
  activity.context.publishAdminActivity(1100, false);
  activity.setClock(1200);
  activity.context.publishAdminActivity(1200, false);
  assert.strictEqual(activity.writes(), 1,
    'a burst of admin activity performs only one synchronous storage write');
  assert.strictEqual(activity.context.lastActivity(), 1200,
    'coalescing does not delay the local inactivity clock');
  assert.strictEqual(activity.hasTimer(), true,
    'a burst retains one coalesced cross-tab activity update');
  activity.setClock(2000);
  activity.runTimer();
  assert.strictEqual(activity.writes(), 2,
    'the coalesced activity update eventually reaches other tabs');

  let generation = generationHarness('locked');
  generation.context.startGenerate(
    generation.button, 'Pica pica', function () { return true; }, function () {}
  );
  assert.deepStrictEqual(JSON.parse(JSON.stringify(generation.context.state())),
    { starts: 0, opened: 1 },
    'a locked postcard control opens the unlock surface without starting work');
  assert.strictEqual(generation.button.textContent, 'unlock in menu to generate',
    'a locked postcard control keeps actionable recovery copy');
  assert.strictEqual(generation.button.disabled, false,
    'a locked postcard control is never wedged disabled');

  generation = generationHarness('unlocked');
  generation.context.startGenerate(
    generation.button, 'Pica pica', function () { return true; }, function () {}
  );
  await settle();
  generation.context.lockVisibleGenerateForAuth();
  assert.strictEqual(generation.button.textContent, 'unlock in menu to check progress',
    'locking during generation restores a progress-recovery action immediately');
  assert.strictEqual(generation.button.disabled, false,
    'locking during generation clears the disabled progress state');

  let test = harness();
  test.context.tryAutoUnlock();
  test.context.tryAutoUnlock();
  test.requests[1].resolve(response(200));
  await settle();
  test.requests[0].resolve(response(401));
  await settle();
  assert.strictEqual(test.context.authState(), 'unlocked',
    'an older 401 must not overwrite a newer 200');

  test = harness();
  test.context.tryAutoUnlock();
  test.context.tryAutoUnlock();
  test.requests[1].resolve(response(401));
  await settle();
  test.requests[0].resolve(response(200));
  await settle();
  assert.strictEqual(test.context.authState(), 'locked',
    'an older 200 must not overwrite a newer 401');

  test = harness();
  test.context.receiveAdminAuthEvent({ type: 'lock', at: 1 });
  test.context.receiveAdminAuthEvent({ type: 'session-replaced', at: 2 });
  test.requests[1].resolve(response(200));
  await settle();
  test.requests[0].resolve(response(401));
  await settle();
  assert.strictEqual(test.context.authState(), 'unlocked',
    'session replacement must win after an older stale lock');

  test = harness();
  test.context.receiveAdminAuthEvent({ type: 'session-replaced', at: 1 });
  test.context.receiveAdminAuthEvent({ type: 'lock', at: 2 });
  test.requests[1].resolve(response(200));
  await settle();
  test.requests[0].resolve(response(401));
  await settle();
  assert.strictEqual(test.context.authState(), 'unlocked',
    'a stale lock must recheck the shared replacement session');

  test = harness();
  test.context.receiveAdminAuthEvent({ type: 'lock', at: 1 });
  test.context.receiveAdminAuthEvent({ type: 'lock', at: 1 });
  test.requests[1].resolve(response(200));
  await settle();
  test.requests[0].resolve(response(401));
  await settle();
  assert.strictEqual(test.context.authState(), 'unlocked',
    'duplicate transport delivery must keep only the latest probe');

  test = harness();
  test.context.receiveAdminAuthEvent({ type: 'lock', at: 3 });
  test.requests[0].resolve(response(401));
  await settle();
  assert.strictEqual(test.context.authState(), 'locked',
    'a genuine logout remains locked after its server recheck');

  let fetchTest = adminFetchHarness();
  const stale401 = fetchTest.context.adminFetch('/admin').catch(function (error) { return error; });
  fetchTest.request.resolve({
    status: 401,
    clone: function () { return { json: function () { return fetchTest.body.promise; } }; },
  });
  await settle();
  fetchTest.context.replaceSession();
  fetchTest.body.resolve({ recovery: false });
  await stale401;
  assert.strictEqual(fetchTest.context.locks(), 0,
    'a delayed stale 401 body cannot lock a replacement session');

  fetchTest = adminFetchHarness();
  const current401 = fetchTest.context.adminFetch('/admin').catch(function (error) { return error; });
  fetchTest.request.resolve({
    status: 401,
    clone: function () { return { json: function () { return fetchTest.body.promise; } }; },
  });
  await settle();
  fetchTest.body.resolve({ recovery: false });
  await current401;
  assert.strictEqual(fetchTest.context.locks(), 1,
    'a current 401 still locks privileged controls');

  let settings = settingsHarness();
  settings.context.setPending({ CONFIDENCE: 0.5 });
  settings.context.queueSave(400);
  assert.strictEqual(settings.context.timerCount(), 1, 'queued Settings save has one timer');
  settings.context.discardPendingSettings();
  assert.strictEqual(settings.context.pendingJson(), '{}',
    'locking before a queued save discards unsent Settings values');
  assert.strictEqual(settings.context.timerCount(), 0,
    'locking cancels the queued Settings save timer');

  settings = settingsHarness();
  settings.context.setPending({ CONFIDENCE: 0.5 });
  settings.context.saveSettings();
  assert.strictEqual(settings.requests[0].body, '{"CONFIDENCE":0.5}',
    'an issued Settings request owns a fixed submitted snapshot');
  settings.context.setPending({ CONFIDENCE: 0.7 });
  settings.context.discardPendingSettings();
  const cancelled = new Error('locked after commit');
  cancelled.adminAuthCancelled = true;
  settings.requests[0].reject(cancelled);
  await settle();
  assert.strictEqual(settings.context.pendingJson(), '{}',
    'a cancelled in-flight save cannot replay submitted or newer locked edits');

  settings = settingsHarness();
  settings.context.setPending({ CONFIDENCE: 0.5, SITE_NAME: 'Old' });
  settings.context.saveSettings();
  settings.requests[0].resolve({
    ok: false,
    json: function () { return Promise.resolve({ ok: false }); },
  });
  await settle();
  assert.strictEqual(settings.context.pendingJson(), '{"CONFIDENCE":0.5,"SITE_NAME":"Old"}',
    'HTTP failure preserves the submitted Settings snapshot for a later deliberate edit');

  settings = settingsHarness();
  settings.context.setPending({ CONFIDENCE: 0.5, SITE_NAME: 'Old' });
  settings.context.saveSettings();
  settings.context.setPending({ CONFIDENCE: 0.7 });
  settings.requests[0].resolve({
    ok: false,
    json: function () { return Promise.resolve({ ok: false }); },
  });
  await settle();
  assert.strictEqual(settings.context.pendingJson(), '{"CONFIDENCE":0.7,"SITE_NAME":"Old"}',
    'newer Settings edits win when a failed snapshot is restored');

  settings = settingsHarness();
  settings.context.setPending({ LATITUDE: 37.7 });
  settings.context.saveSettings();
  settings.requests[0].reject(new Error('network down'));
  await settle();
  assert.strictEqual(settings.context.pendingJson(), '{"LATITUDE":37.7}',
    'network failure preserves submitted Settings without automatic replay');

  let idle = idleHarness();
  idle.context.scheduleAdminIdleLock();
  idle.context.replaceSession();
  idle.result.resolve({ locked: true, remaining: 0 });
  await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(idle.context.state())), { locks: 0, reprobes: 1 },
    'a delayed idle result cannot lock a replacement session');

  idle = idleHarness();
  idle.context.scheduleAdminIdleLock();
  idle.result.resolve({ locked: true, remaining: 0 });
  await settle();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(idle.context.state())), { locks: 1, reprobes: 0 },
    'a current confirmed-idle result still locks the admin UI');

  process.stdout.write('admin frontend auth tests passed (34 checks)\n');
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
