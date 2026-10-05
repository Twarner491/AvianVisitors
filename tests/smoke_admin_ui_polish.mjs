#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../avian/frontend/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../avian/frontend/styles.css', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../avian/api/birdnet-api.php', import.meta.url), 'utf8');
const archiveApi = fs.readFileSync(new URL('../avian/api/archive.php', import.meta.url));
const archiveHelper = fs.readFileSync(new URL('../scripts/archive_control.sh', import.meta.url));

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
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return apt.slice(start, index + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const markupContext = {
  ICON_EYE: '<svg aria-hidden="true"></svg>',
  ICON_EYE_OFF: '<svg aria-hidden="true"></svg>',
};
vm.createContext(markupContext);
vm.runInContext([
  functionSource('settingsInfoMarkup'),
  functionSource('lanAuthRow'),
  functionSource('birdweatherRow'),
].join('\n'), markupContext);

const preferenceMarkupContext = {
  themePreference() { return 'auto'; },
  readLS() { return 'on'; },
};
vm.createContext(preferenceMarkupContext);
vm.runInContext([
  functionSource('themeRow'),
  functionSource('labelsRow'),
].join('\n'), preferenceMarkupContext);
const themeMarkup = preferenceMarkupContext.themeRow();
const labelsMarkup = preferenceMarkupContext.labelsRow();
assert.match(themeMarkup, /data-theme-seg role="group" aria-label="Theme"/,
  'Theme exposes one named group without claiming radio-keyboard behavior');
assert.equal((themeMarkup.match(/data-theme=/g) || []).length, 3,
  'Theme keeps all three explicit choices');
assert.equal((themeMarkup.match(/<svg /g) || []).length, 3,
  'Theme choices use icons instead of visible words');
assert.match(themeMarkup, /aria-label="Follow system theme"[^>]*aria-describedby="themeAutoTip"/,
  'the system icon has an accessible name and tooltip relationship');
assert.match(themeMarkup, /role="tooltip">follow system<\/span>/,
  'the system icon explains itself on hover or focus');
assert.match(themeMarkup, /aria-label="Use light theme"[\s\S]*role="tooltip">light<\/span>/,
  'the light icon has matching accessible and visible tooltip copy');
assert.match(themeMarkup, /aria-label="Use dark theme"[\s\S]*role="tooltip">dark<\/span>/,
  'the dark icon has matching accessible and visible tooltip copy');
assert.doesNotMatch(themeMarkup, />\s*(auto|light|dark)\s*<\/button>/i,
  'Theme option names are not rendered as button text');
assert.match(labelsMarkup, /class="switch" role="switch" aria-label="Show bird names"[\s\S]*aria-checked="true"[\s\S]*data-labels-switch/,
  'Bird names uses the standard Settings switch and keeps its on-by-default state');
assert.doesNotMatch(labelsMarkup, /data-labels-seg|>off<|>on</,
  'Bird names no longer renders a bespoke off-on segmented picker');

function labelsSwitchHarness() {
  const attrs = { 'aria-checked': 'true' };
  let listener = null;
  const writes = [];
  let renders = 0;
  const button = {
    addEventListener(type, next) { if (type === 'click') listener = next; },
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = String(value); },
  };
  const context = {
    document: { fonts: null },
    labelFontReady: false,
    writeLS(key, value) { writes.push([key, value]); },
    renderCollageFromData() { renders += 1; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('wireLabelsPreference'), context);
  context.wireLabelsPreference({ querySelector() { return button; } });
  listener();
  assert.equal(attrs['aria-checked'], 'false', 'Bird names switches off on the first press');
  assert.deepEqual(writes[0], ['bird:labels', 'off'], 'the off state persists locally');
  listener();
  assert.equal(attrs['aria-checked'], 'true', 'Bird names switches back on');
  assert.deepEqual(writes[1], ['bird:labels', 'on'], 'the on state persists locally');
  assert.equal(renders, 2, 'each state change redraws the collage once');
}
labelsSwitchHarness();

const accessOff = markupContext.lanAuthRow({
  lan_admin_auth: false,
  password_configured: true,
});
assert.match(accessOff, /role="tooltip"/, 'Access details use a tooltip');
assert.match(accessOff, /aria-describedby="lanAuthTip"/, 'the switch exposes tooltip copy to assistive technology');
assert.doesNotMatch(accessOff, /lan-auth-warning/, 'Access no longer reserves a warning paragraph');
assert.doesNotMatch(markupContext.lanAuthRow({
  lan_admin_auth: false,
  password_configured: true,
}), /data-password-change-open/, 'password change stays hidden while local password protection is off');
assert.match(markupContext.lanAuthRow({
  lan_admin_auth: true,
  password_configured: true,
}), /data-password-change-open[^>]*>change admin password</,
  'the inline admin-password action appears only while local protection is on');
const accessOn = markupContext.lanAuthRow({
  lan_admin_auth: true,
  password_configured: true,
});
assert.match(accessOn, /data-lan-password-visibility[^>]*aria-label="Show admin password"[^>]*aria-pressed="false"/,
  'the LAN confirmation includes an accessible, initially concealed password reveal');
assert.match(accessOn, /data-lan-password-visibility[\s\S]*<svg aria-hidden="true"><\/svg>/,
  'the LAN confirmation uses an aria-hidden eye icon instead of visible show text');
assert.doesNotMatch(accessOn, /data-lan-password-visibility[^>]*>\s*(show|hide)\s*</i,
  'the password reveal has no visible show or hide label');

const birdweatherOff = markupContext.birdweatherRow({
  ok: true,
  enabled: false,
  token_configured: false,
  upload_audio: false,
  privacy_threshold: 0,
});
assert.match(birdweatherOff, /type="text" data-birdweather-token/, 'BirdWeather token stays readable inside protected Settings');
assert.doesNotMatch(birdweatherOff, /data-birdweather-token[^>]*\svalue=/, 'BirdWeather never puts a saved token in the DOM');
assert.match(birdweatherOff, /data-v="1" aria-current="true"/, 'a fresh station starts at local privacy level one');
assert.match(birdweatherOff, /Level 0 checks the top 10 model candidates for Human, 1 about 60, 2 about 120, and 3 about 180/,
  'privacy disclosure defines every level using the analyzer candidate counts');
assert.match(birdweatherOff, /BirdNET still analyzes the audio[\s\S]*suppresses local bird detections for that 3-second window and its neighbors/,
  'privacy disclosure describes local post-analysis suppression accurately');
assert.match(birdweatherOff, /Full recordings are not redacted/,
  'privacy disclosure preserves the full-recording caveat');
assert.doesNotMatch(birdweatherOff, /data-birdweather-save|Save settings/, 'BirdWeather settings have no manual save action');
assert.doesNotMatch(birdweatherOff, /create a BirdWeather station and paste|higher checks more candidates/i,
  'the BirdWeather disclosure omits redundant helper copy');
assert.match(birdweatherOff, /data-birdweather-details-shell data-open="false" data-settled="false" aria-hidden="true" hidden inert/,
  'the closed details disclosure starts noninteractive and out of layout');
const birdweatherUnavailable = markupContext.birdweatherRow({ ok: false });
assert.match(birdweatherUnavailable, /data-birdweather-disclosure[^>]* disabled/, 'unavailable BirdWeather Details action is disabled');
assert.match(birdweatherUnavailable, /class="birdweather-unavailable"[^>]*>BirdWeather controls are unavailable/,
  'an endpoint failure remains visible while the unavailable details panel is closed');
assert.match(birdweatherOff, /href="https:\/\/app\.birdweather\.com\/account\/stations"/,
  'BirdWeather account settings use the direct station-management link');
assert.match(birdweatherOff, /<a id="birdweatherTokenLabel"[^>]*>Station token<\/a>/,
  'the Station token label itself opens BirdWeather station settings');
assert.match(birdweatherOff, /data-birdweather-token-editor(?![^>]* hidden)/,
  'an unconfigured station shows the empty token editor');
assert.match(birdweatherOff, /data-birdweather-token-actions hidden/,
  'an unconfigured station keeps the configured-token actions out of view');
const birdweatherConfigured = markupContext.birdweatherRow({
  ok: true,
  enabled: true,
  token_configured: true,
  configuration_valid: true,
  upload_audio: false,
  privacy_threshold: 1,
});
assert.match(birdweatherConfigured, /data-birdweather-token-editor hidden/,
  'a configured station replaces the token field instead of retaining the credential');
assert.match(birdweatherConfigured, /data-birdweather-token-actions[^>]*>[\s\S]*view station on BirdWeather[\s\S]*forget token/,
  'a configured station shows the view and forget actions inline');
assert.doesNotMatch(birdweatherConfigured, /data-birdweather-forget[^>]* hidden/,
  'forget remains available while BirdWeather sharing is active');
assert.doesNotMatch(birdweatherConfigured, /class="birdweather-station"|Checking BirdWeather|Add a valid station token|View station #/,
  'BirdWeather has no visible station or save-status footer copy');
assert.doesNotMatch(birdweatherOff, /birdweather-actions|BirdWeather privacy and station settings/,
  'BirdWeather no longer reserves a footer row for the account link');

function lanRevealHarness() {
  function element(attributes = {}) {
    const attrs = { ...attributes };
    const listeners = {};
    return {
      attrs,
      hidden: true,
      disabled: false,
      value: '',
      type: attributes.type || '',
      textContent: '',
      focused: false,
      classList: { toggle() {}, remove() {} },
      addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
      dispatch(type, event = {}) {
        (listeners[type] || []).forEach((listener) => listener({
          preventDefault() {}, stopPropagation() {}, ...event,
        }));
      },
      getAttribute(name) { return attrs[name] ?? null; },
      setAttribute(name, value) { attrs[name] = String(value); },
      focus() { if (!this.disabled) this.focused = true; },
    };
  }
  const sw = element({ 'aria-checked': 'false' });
  const form = element();
  const password = element({ type: 'password' });
  const visibility = element({ 'aria-pressed': 'false', 'aria-label': 'Show admin password' });
  const status = element();
  const cancel = element();
  const submit = element();
  form.querySelector = (selector) => selector === '[type="submit"]' ? submit : null;
  const map = {
    '[data-lan-auth]': sw,
    '[data-lan-auth-confirm]': form,
    '#lanAuthPassword': password,
    '[data-lan-password-visibility]': visibility,
    '[data-lan-auth-status]': status,
    '[data-lan-auth-cancel]': cancel,
    '[data-lan-auth-reconcile]': null,
    '[data-password-change-form]': null,
    '[data-password-change-open]': null,
  };
  const control = { querySelector(selector) { return map[selector] ?? null; } };
  const scope = { querySelector(selector) { return selector === '[data-lan-auth-control]' ? control : null; } };
  const context = {
    stopLiveAudioNow: null,
    closeDd() {},
    confirm() { return true; },
    fetch() { throw new Error('reveal-only harness must not send a request'); },
    adminBasicAuthorization() { return ''; },
    sessionReplaced() {},
    showAdminLocked() {},
    tryAutoUnlock() {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource('wireLanAuthControl'), context);
  context.wireLanAuthControl(scope, {});
  return { sw, form, password, visibility, cancel };
}

const lanReveal = lanRevealHarness();
lanReveal.sw.dispatch('click');
lanReveal.password.value = 'StationReview26';
lanReveal.visibility.dispatch('click');
assert.equal(lanReveal.password.type, 'text', 'Show exposes the pending password without changing its value');
assert.equal(lanReveal.visibility.attrs['aria-pressed'], 'true', 'Show publishes its pressed state');
assert.equal(lanReveal.visibility.attrs['aria-label'], 'Hide admin password', 'Show becomes an explicit Hide action');
lanReveal.cancel.dispatch('click');
assert.equal(lanReveal.password.value, '', 'Cancel clears the pending password');
assert.equal(lanReveal.password.type, 'password', 'Cancel always reconceals the password field');
assert.equal(lanReveal.visibility.attrs['aria-pressed'], 'false', 'Cancel resets the reveal state');

function birdweatherHarness(initialState, fetcher, options = {}) {
  let activeNode = null;
  function node(attributes = {}) {
    const listeners = {};
    const attrs = { ...attributes };
    return {
      attrs,
      dataset: {},
      disabled: false,
      readOnly: false,
      hidden: false,
      value: '',
      placeholder: '',
      textContent: '',
      children: [],
      focused: false,
      classList: { toggle() {} },
      addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
      dispatch(type, event = {}) {
        (listeners[type] || []).forEach((listener) => listener({
          preventDefault() {}, stopPropagation() {}, ...event,
        }));
      },
      getAttribute(name) { return attrs[name] ?? null; },
      setAttribute(name, value) { attrs[name] = String(value); },
      removeAttribute(name) { delete attrs[name]; },
      focus() {
        if (this.disabled) return;
        if (activeNode) activeNode.focused = false;
        activeNode = this;
        this.focused = true;
      },
      replaceChildren() { this.children = []; this.textContent = ''; },
      appendChild(child) { this.children.push(child); },
      setCustomValidity(message) { this.validationMessage = String(message); },
      reportValidity() {
        if (this.disabled) return false;
        this.validityReports = (this.validityReports || 0) + 1;
        return false;
      },
    };
  }

  const mainSwitch = node({ 'aria-checked': initialState.enabled ? 'true' : 'false' });
  const disclosure = node({ 'aria-expanded': initialState.enabled ? 'true' : 'false' });
  const detailsShell = node({
    'data-open': initialState.enabled ? 'true' : 'false',
    'data-settled': initialState.enabled ? 'true' : 'false',
    'aria-hidden': initialState.enabled ? 'false' : 'true',
  });
  detailsShell.hidden = !initialState.enabled;
  detailsShell.inert = !initialState.enabled;
  const details = node();
  const tokenEditor = node();
  const tokenActions = node();
  const tokenInput = node();
  const audioSwitch = node({ 'aria-checked': initialState.upload_audio ? 'true' : 'false' });
  const privacyButtons = [0, 1, 2, 3].map((level) => {
    const button = node({ 'aria-current': level === (initialState.privacy_threshold ?? 1) ? 'true' : 'false' });
    button.dataset.v = String(level);
    return button;
  });
  const privacy = node();
  privacy.querySelectorAll = (selector) => selector === 'button' ? privacyButtons : [];
  privacy.querySelector = (selector) => selector === 'button[aria-current="true"]'
    ? privacyButtons.find((button) => button.getAttribute('aria-current') === 'true')
    : null;
  const stationLink = node();
  stationLink.href = 'https://app.birdweather.com/account/stations';
  const status = node();
  const forget = node();
  const selectors = {
    '[data-birdweather-toggle]': mainSwitch,
    '[data-birdweather-disclosure]': disclosure,
    '[data-birdweather-details-shell]': detailsShell,
    '[data-birdweather-details]': details,
    '[data-birdweather-token-editor]': tokenEditor,
    '[data-birdweather-token-actions]': tokenActions,
    '[data-birdweather-token]': tokenInput,
    '[data-birdweather-audio]': audioSwitch,
    '[data-birdweather-privacy]': privacy,
    '[data-birdweather-station]': stationLink,
    '[data-birdweather-status]': status,
    '[data-birdweather-forget]': forget,
  };
  const control = node();
  control.querySelector = (selector) => selectors[selector] || null;
  const scope = { querySelector(selector) { return selector === '[data-birdweather-control]' ? control : null; } };
  let pillSyncs = 0;
  const lockCalls = [];
  const context = {
    adminFetch: fetcher,
    fetch: fetcher,
    adminAuthCancelled() { return false; },
    adminAuthGeneration: 0,
    adminViewGeneration: 0,
    pendingBirdweatherReveal: !!options.pendingReveal,
    document: { get activeElement() { return activeNode; } },
    showAdminLocked(message, recovery) { lockCalls.push({ message, recovery }); },
    confirm() { return true; },
    syncPill() { pillSyncs += 1; },
    requestAnimationFrame(callback) { callback(); return 1; },
    clearTimeout() {},
    setTimeout(callback) { callback(); return 1; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('wireBirdweatherControl'), context);
  context.wireBirdweatherControl(scope, initialState);
  return {
    mainSwitch, disclosure, detailsShell, details, tokenInput, audioSwitch, privacyButtons,
    tokenEditor, tokenActions, stationLink, status, forget, context, lockCalls,
    pillSyncs() { return pillSyncs; },
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json() { return Promise.resolve(body); } };
}

async function flushPromises() {
  for (let count = 0; count < 16; count += 1) await Promise.resolve();
}

const firstTokenPosts = [];
const firstTokenResponses = [
  jsonResponse(503, { ok: false, error: 'BirdWeather could not verify the station token' }),
  jsonResponse(200, {
    ok: true, enabled: true, token_configured: true, configuration_valid: true,
    upload_audio: false, privacy_threshold: 1,
    station: { state: 'connected', station_id: 222 },
  }),
];
const firstToken = birdweatherHarness({
  ok: true, enabled: false, token_configured: false,
  configuration_valid: true, upload_audio: false, privacy_threshold: 1,
}, (url, options = {}) => {
  assert.equal(options.method, 'POST', `unexpected first-token request: ${url}`);
  firstTokenPosts.push(JSON.parse(options.body));
  return Promise.resolve(firstTokenResponses.shift());
});
firstToken.mainSwitch.dispatch('click');
assert.equal(firstToken.mainSwitch.getAttribute('aria-checked'), 'false',
  'opening the first-token draft does not claim sharing is enabled');
assert.equal(firstToken.detailsShell.hidden, false, 'the first-token draft still expands');
assert.equal(firstToken.detailsShell.getAttribute('data-open'), 'true',
  'the first-token disclosure enters its visible state');
assert.equal(firstToken.detailsShell.getAttribute('data-settled'), 'true',
  'the open disclosure releases overflow after its transition');
assert.ok(firstToken.pillSyncs() >= 2,
  'opening hidden BirdWeather details synchronizes the human-filter pill after layout');
firstToken.tokenInput.value = '\tunsafe-token';
firstToken.tokenInput.dispatch('input');
firstToken.tokenInput.dispatch('change');
assert.equal(firstToken.tokenInput.readOnly, true,
  'token verification keeps the focused editor readonly without disabling it');
await flushPromises();
assert.equal(firstTokenPosts[0].token, '\tunsafe-token',
  'the client preserves control characters for the API strict validator to reject');
assert.equal(firstTokenPosts[0].enabled, true, 'the draft asks the server to enable only with its token write');
assert.equal(firstTokenPosts[0].upload_audio, false, 'a first token carries the displayed audio choice');
assert.equal(firstTokenPosts[0].privacy_threshold, 1, 'a first token carries the displayed privacy choice');
assert.equal(firstToken.mainSwitch.getAttribute('aria-checked'), 'false',
  'failed or unavailable token verification leaves the backend-off switch visually off');
assert.equal(firstToken.tokenInput.value, '\tunsafe-token',
  'a rejected token stays available for correction');
assert.equal(firstToken.tokenInput.getAttribute('aria-invalid'), 'true',
  'a rejected token marks the editor invalid without adding visible footer copy');
assert.equal(firstToken.tokenInput.disabled, false,
  'the token editor is re-enabled before presenting a validation failure');
assert.equal(firstToken.tokenInput.readOnly, false,
  'the token editor becomes editable again after validation completes');
assert.equal(firstToken.tokenInput.validityReports, 1,
  'the native validation bubble is requested only after the token editor is usable');
firstToken.tokenInput.value = 'verified-token';
firstToken.tokenInput.dispatch('input');
firstToken.tokenInput.dispatch('change');
await flushPromises();
assert.equal(firstToken.mainSwitch.getAttribute('aria-checked'), 'true',
  'the switch turns on only after the verified token save succeeds');
assert.equal(firstToken.tokenInput.value, '', 'a verified token is cleared from the DOM');
assert.equal(firstToken.tokenEditor.hidden, true, 'a verified token hides the editor');
assert.equal(firstToken.tokenActions.hidden, false, 'a verified token reveals the compact actions');
assert.equal(firstToken.stationLink.href, 'https://app.birdweather.com/stations/222',
  'the station action targets the verified public station');
assert.equal(firstToken.stationLink.focused, false,
  'a blur autosave does not steal focus back to the station action');
assert.equal(firstToken.status.textContent, '', 'successful autosave leaves no visible status copy');

let savedWithoutSettingsPost = null;
const savedWithoutSettings = birdweatherHarness({
  ok: true, enabled: false, token_configured: false,
  configuration_valid: true, upload_audio: false, privacy_threshold: 1,
}, (url, options = {}) => {
  if (options.method === 'POST') {
    savedWithoutSettingsPost = JSON.parse(options.body);
    return Promise.resolve(jsonResponse(500, {
      ok: false, saved: true,
      error: 'settings saved, but station config could not be re-read',
    }));
  }
  return Promise.resolve(jsonResponse(503, {
    ok: false, error: 'BirdWeather config is unavailable',
  }));
});
savedWithoutSettings.audioSwitch.setAttribute('aria-checked', 'true');
savedWithoutSettings.privacyButtons.forEach((button) => {
  button.setAttribute('aria-current', button.dataset.v === '3' ? 'true' : 'false');
});
savedWithoutSettings.mainSwitch.dispatch('click');
savedWithoutSettings.tokenInput.value = 'durably-saved-token';
savedWithoutSettings.tokenInput.focus();
savedWithoutSettings.tokenInput.dispatch('input');
savedWithoutSettings.tokenInput.dispatch('change');
savedWithoutSettings.audioSwitch.focus();
await flushPromises();
assert.deepEqual(savedWithoutSettingsPost, {
  token: 'durably-saved-token', upload_audio: true, privacy_threshold: 3, enabled: true,
}, 'the saved-without-settings regression exercises the complete first-token draft');
assert.equal(savedWithoutSettings.tokenInput.value, '',
  'a durably saved token is cleared even when the canonical response cannot be read');
assert.equal(savedWithoutSettings.tokenEditor.hidden, true,
  'saved-without-settings falls back to the configured action state');
assert.equal(savedWithoutSettings.tokenActions.hidden, false,
  'saved-without-settings never leaves the credential editor stale');
assert.equal(savedWithoutSettings.tokenInput.getAttribute('aria-invalid'), 'false',
  'a saved token restart error is not misreported as credential validation');
assert.equal(savedWithoutSettings.mainSwitch.getAttribute('aria-checked'), 'true',
  'saved-without-settings reflects the durably enabled sharing state');
assert.equal(savedWithoutSettings.audioSwitch.getAttribute('aria-checked'), 'true',
  'saved-without-settings reflects the durable audio choice');
assert.equal(savedWithoutSettings.privacyButtons[3].getAttribute('aria-current'), 'true',
  'saved-without-settings reflects the durable human-filter level');
assert.equal(savedWithoutSettings.stationLink.focused, false,
  'a delayed saved-state recovery does not steal focus after blur');
assert.equal(savedWithoutSettings.audioSwitch.focused, true,
  'the control reached after blur keeps focus through saved-state recovery');

let resolveOldProbe;
const oldProbe = new Promise((resolve) => { resolveOldProbe = resolve; });
const stationRace = birdweatherHarness({
  ok: true, enabled: true, token_configured: true,
  configuration_valid: true, upload_audio: false, privacy_threshold: 1,
}, (url, options = {}) => {
  if (options.method === 'POST') {
    const body = JSON.parse(options.body);
    if (body.forget_token) {
      return Promise.resolve(jsonResponse(200, {
        ok: true, enabled: false, token_configured: false, configuration_valid: true,
        upload_audio: false, privacy_threshold: 1,
      }));
    }
    return Promise.resolve(jsonResponse(200, {
      ok: true, enabled: false, token_configured: true, configuration_valid: true,
      upload_audio: false, privacy_threshold: 1,
      station: { state: 'connected', station_id: 222 },
    }));
  }
  assert.match(url, /probe=1/);
  return oldProbe;
});
stationRace.forget.dispatch('click');
await flushPromises();
assert.equal(stationRace.tokenActions.hidden, true, 'forget removes the configured actions immediately after save');
assert.equal(stationRace.tokenEditor.hidden, false, 'forget restores the empty token editor');
assert.equal(stationRace.detailsShell.hidden, false, 'forget keeps the details disclosure open');
assert.equal(stationRace.tokenInput.focused, true, 'forget moves focus to the replacement field');
stationRace.tokenInput.value = 'replacement-token';
stationRace.tokenInput.dispatch('input');
stationRace.tokenInput.dispatch('change');
await flushPromises();
assert.equal(stationRace.stationLink.href, 'https://app.birdweather.com/stations/222',
  'a successful replacement displays the newly verified station');
resolveOldProbe(jsonResponse(200, {
  ok: true, configuration_valid: true,
  station: { state: 'connected', station_id: 111 },
}));
await flushPromises();
assert.equal(stationRace.stationLink.href, 'https://app.birdweather.com/stations/222',
  'an old-token probe cannot overwrite the replacement station link');

const disableRequests = [];
const disableResponses = [
  jsonResponse(200, {
    ok: true, enabled: false, token_configured: true, configuration_valid: true,
    upload_audio: false, privacy_threshold: 1,
  }),
  jsonResponse(200, {
    ok: true, enabled: false, token_configured: false, configuration_valid: true,
    upload_audio: false, privacy_threshold: 1,
  }),
];
const disableAndForget = birdweatherHarness({
  ok: true, enabled: true, token_configured: true,
  configuration_valid: true, upload_audio: false, privacy_threshold: 1,
}, (url, options = {}) => {
  if (options.method === 'POST') {
    disableRequests.push(JSON.parse(options.body));
    return Promise.resolve(disableResponses.shift());
  }
  return Promise.resolve(jsonResponse(200, {
    ok: true, configuration_valid: true,
    station: { state: 'connected', station_id: 222 },
  }));
});
disableAndForget.mainSwitch.dispatch('click');
assert.equal(disableAndForget.mainSwitch.getAttribute('aria-checked'), 'true',
  'a disable request keeps the persisted on-state visible while saving');
await flushPromises();
assert.equal(disableAndForget.mainSwitch.getAttribute('aria-checked'), 'false',
  'the switch turns off after the disable succeeds');
assert.equal(disableAndForget.detailsShell.hidden, true, 'successful disable closes details');
assert.equal(disableAndForget.forget.hidden, false, 'configured station offers explicit token removal');
disableAndForget.forget.dispatch('click');
await flushPromises();
assert.equal(disableRequests[1].forget_token, true, 'forget uses the explicit credential-removal contract');
assert.equal(disableAndForget.mainSwitch.getAttribute('aria-checked'), 'false',
  'forgetting the token cannot enable sharing');
assert.equal(disableAndForget.detailsShell.hidden, false,
  'forgetting keeps details open for a replacement token');
assert.equal(disableAndForget.tokenEditor.hidden, false,
  'forgetting swaps the configured actions back to the token editor');

const choicePosts = [];
const choices = birdweatherHarness({
  ok: true, enabled: false, token_configured: false,
  configuration_valid: true, upload_audio: false, privacy_threshold: 1,
}, (url, request = {}) => {
  assert.equal(request.method, 'POST', `unexpected first-choice request: ${url}`);
  const body = JSON.parse(request.body);
  choicePosts.push(body);
  return Promise.resolve(jsonResponse(200, {
    ok: true,
    enabled: !!body.enabled,
    token_configured: Object.hasOwn(body, 'token'),
    configuration_valid: true,
    upload_audio: Object.hasOwn(body, 'upload_audio') ? body.upload_audio : false,
    privacy_threshold: Object.hasOwn(body, 'privacy_threshold') ? body.privacy_threshold : 1,
  }));
});
choices.audioSwitch.setAttribute('aria-checked', 'true');
choices.privacyButtons.forEach((button) => {
  button.setAttribute('aria-current', button.dataset.v === '3' ? 'true' : 'false');
});
choices.mainSwitch.dispatch('click');
choices.tokenInput.value = '#explicit-choice-token';
choices.tokenInput.dispatch('input');
choices.tokenInput.dispatch('change');
await flushPromises();
assert.deepEqual(choicePosts[0], {
  token: '#explicit-choice-token', upload_audio: true, privacy_threshold: 3, enabled: true,
}, 'the first-token write preserves privacy and audio choices made before entry');
assert.equal(choices.tokenInput.value, '', 'a successful save removes the normalized token from the DOM');
assert.doesNotMatch(functionSource('wireBirdweatherControl'), /reveal=1|revealToken|pendingBirdweatherReveal/,
  'the Settings UI never requests the saved BirdWeather credential');

let resolveDoubleSubmit;
let doubleSubmitPosts = 0;
const doubleSubmit = birdweatherHarness({
  ok: true, enabled: false, token_configured: false,
  configuration_valid: true, upload_audio: false, privacy_threshold: 1,
}, () => {
  doubleSubmitPosts += 1;
  return new Promise((resolve) => { resolveDoubleSubmit = resolve; });
});
doubleSubmit.tokenInput.value = 'single-submit-token';
doubleSubmit.tokenInput.focus();
doubleSubmit.tokenInput.dispatch('input');
doubleSubmit.tokenInput.dispatch('keydown', { key: 'Enter' });
doubleSubmit.tokenInput.dispatch('change');
assert.equal(doubleSubmitPosts, 1, 'Enter followed by change submits one token request per edit');
assert.equal(doubleSubmit.tokenInput.readOnly, true,
  'a pending keyboard submission cannot be overwritten during remote verification');
resolveDoubleSubmit(jsonResponse(200, {
  ok: true, enabled: false, token_configured: true, configuration_valid: true,
  upload_audio: false, privacy_threshold: 1,
  station: { state: 'connected', station_id: 222 },
}));
await flushPromises();
assert.equal(doubleSubmit.tokenInput.readOnly, false,
  'the keyboard token editor leaves readonly state after verification');
assert.equal(doubleSubmit.stationLink.focused, true,
  'an Enter submission moves focus from the removed editor to its visible station action');

assert.match(html, /<div class="menu-footer">[\s\S]*id="adminLock" hidden[\s\S]*<\/div>/,
  'the lock action lives in the static footer and starts hidden');
assert.match(css, /\.menu-lock\s*\{[\s\S]*color:\s*var\(--danger\)/,
  'the footer lock action uses the restrained destructive color');
assert.match(css, /\.admin-settings input\.secret\s*\{[\s\S]*outline:\s*0/,
  'secret inputs suppress the browser blue outline');
assert.match(css, /\.admin-settings input\.secret:focus-visible\s*\{[\s\S]*var\(--ink-soft\)/,
  'secret inputs restore a theme-aware keyboard focus indicator');
assert.match(css, /\.password-change-form input:focus-visible,[\s\S]*var\(--ink-soft\)/,
  'password inputs use the same restrained theme-aware focus indicator');
assert.match(css, /\.lan-password-visibility\s*\{[\s\S]*position:\s*absolute[\s\S]*min-height:\s*24px/,
  'the password reveal is a compact but usable in-field action');
assert.match(css, /\.lan-password-visibility::before\s*\{[\s\S]*inset:\s*3px 2px/,
  'the eye keeps its full target while its visible hover field stays inset');
assert.match(css, /\.settings-tip\s*\{[\s\S]*color:\s*var\(--ink-2\)/,
  'tooltip copy has stronger contrast than muted helper text');
assert.match(css, /\.access-copy\[data-tip-open="true"\] \.settings-tip/,
  'tooltip visibility follows the explicit open state');
assert.doesNotMatch(css, /\.access-copy:hover \.settings-tip/,
  'hover cannot independently reopen a tooltip after Escape');
assert.match(css, /\.menu-lock\s*\{[\s\S]*min-height:\s*24px/,
  'the footer lock action keeps a usable target height');
assert.match(css, /\.birdweather-details-shell\s*\{[\s\S]*grid-template-rows:\s*1fr[\s\S]*210ms cubic-bezier\(\.23,1,\.32,1\)/,
  'BirdWeather details use a short ease-out disclosure transition');
assert.match(css, /\.birdweather-details-shell\[data-open="false"\]\s*\{[\s\S]*grid-template-rows:\s*0fr/,
  'the closed disclosure collapses without leaving a tall empty card');
assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*\.birdweather-details-shell/,
  'the disclosure respects reduced-motion preferences');
assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*\.birdweather-details-shell\[data-open="true"\]\s*\{\s*overflow:\s*visible/,
  'reduced-motion details expose tooltips immediately without waiting for a transition timer');
assert.match(css, /\.birdweather-details-shell\[data-settled="false"\]\s*\{\s*overflow:\s*hidden/,
  'the disclosure clips during motion but releases expanded tooltips afterward');
assert.match(css, /\.birdweather-details-shell\[data-settled="false"\]\s+\.seg-pill\s*\{\s*transition:\s*none/,
  'the first-open privacy pill does not animate from its hidden zero-width measurement');
assert.match(css, /\.birdweather-details\s*\{[\s\S]*gap:\s*0[\s\S]*padding:\s*6px 8px 4px/,
  'BirdWeather details use compact internal spacing after removing the footer');
assert.match(css, /:root\[data-theme="dark"\][\s\S]*--control-track:\s*#212329[\s\S]*--control-thumb:\s*#3a3e48/,
  'dark mode publishes dark control surfaces instead of inheriting light tracks');
assert.match(css, /\.slider-track input\[type="range"\]::\-webkit-slider-runnable-track\s*\{[\s\S]*background:\s*var\(--control-track\)/,
  'WebKit Settings sliders consume the theme-aware track token');
assert.match(css, /\.slider-track input\[type="range"\]::\-moz-range-track\s*\{[\s\S]*background:\s*var\(--control-track\)/,
  'Firefox Settings sliders consume the theme-aware track token');
assert.doesNotMatch(apt, /<h2>Access<\/h2>|<h2>Sharing<\/h2>/,
  'Settings no longer introduces unmatched Access or Sharing headings');
assert.doesNotMatch(apt, /live audio is unavailable while local password protection is on/i,
  'the drawer does not reserve a live-audio policy warning');
assert.match(apt, /<section class="settings-retention">[\s\S]{0,180}lanAuthRow\(security\)[\s\S]{0,120}birdweatherRow\(birdweather\)[\s\S]{0,120}archiveSettingsRow\(archive\)[\s\S]{0,160}settingsToggle\('preserve',[\s\S]{0,200}settingsSegmented\('FULL_DISK'/,
  'LAN access, BirdWeather, nightly backup, retention, and disk behavior share the final ordered group');
assert.doesNotMatch(functionSource('renderAdminTools'), /archiveSettingsRow|data-archive|Drive archive|Nightly Drive/,
  'Tools no longer owns a duplicate archive controller');
assert.equal((apt.match(/setInterval\(loadArchiveStatus,\s*10000\)/g) || []).length, 1,
  'Nightly Drive backup has one status poller');
assert.match(functionSource('prepareArchiveRetention'), /flushPendingSettings\(\)[\s\S]*saveArchiveRetention\(\{ preserve: true, FULL_DISK: 'keep' \}\)/,
  'archive preparation serializes pending autosaves before enforcing safe retention');
assert.match(functionSource('wireSettingsControls'), /:not\(\[data-archive-toggle\]\)/,
  'the generic Settings binder cannot submit the archive switch as an undefined config key');
assert.match(functionSource('wireSettingsAccessDismissal'), /Escape[\s\S]*pointerdown/,
  'password disclosures clean up on outside interaction and Escape');
assert.match(functionSource('wireLanAuthControl'), /closePasswordChange\(\);[\s\S]*closeDd\(\);/,
  'opening the LAN confirmation closes the password disclosure and drawer');
assert.match(functionSource('wireLanAuthControl'), /function showPassword\(show\)[\s\S]*password\.type = show \? 'text' : 'password'[\s\S]*aria-pressed/,
  'the LAN confirmation reveal updates both the field and accessible state');
assert.doesNotMatch(functionSource('wireLanAuthControl'), /passwordVisibility\.textContent|passwordVisibility\.innerHTML/,
  'the reveal state never replaces its static eye icons');
assert.match(functionSource('wireSettingsAccessDismissal'), /#lanAuthPassword[\s\S]*input\.type = 'password'[\s\S]*aria-pressed', 'false'/,
  'dismissing the LAN confirmation clears and reconceals its password');
assert.match(functionSource('wirePasswordChange'), /data-lan-auth-confirm[\s\S]*closeDd\(\);/,
  'opening password change closes the LAN confirmation and drawer');
assert.match(functionSource('sessionReplaced'), /closeDd\(\);[\s\S]*showAdminLocked\('', false, false\)/,
  'same-tab session replacement keeps the drawer closed while Settings reauthenticates');
assert.match(functionSource('renderMenu'), /showAdminLocked\('', false\);[\s\S]*signalAdminLock\(''\);/,
  'manual lock leaves the password field without redundant locked-state copy');
assert.match(html, /id="lockHint" role="status" aria-live="polite" aria-atomic="true"><\/p>/,
  'a fresh locked drawer has no explanatory copy beneath the password field');
assert.doesNotMatch(apt, /Unlock Settings, System, Logs, and Tools\./,
  'normal locked-state paths do not reintroduce drawer copy');
assert.match(css, /\.lock-hint:empty\s*\{\s*display:\s*none/,
  'the empty live region leaves no visual gap in the locked drawer');
assert.match(css, /\.settings-theme-seg button:hover \.tip,[\s\S]*\.settings-theme-seg button:focus-visible \.tip\s*\{\s*opacity:\s*1/,
  'Theme icon tooltips open for both pointer and keyboard users');
assert.match(css, /\.settings-theme-seg button:focus-visible \.tip\s*\{\s*transition-duration:\s*0ms/,
  'keyboard theme navigation does not wait for tooltip animation');
assert.match(functionSource('wireSettingsControls'), /\.switch:not\(\[data-labels-switch\]\)/,
  'the browser-only Bird names switch stays out of the Pi settings queue');
assert.match(functionSource('renderAdminSettings'), /wireLabelsPreference\(adminBody\)/,
  'Settings wires the dedicated Bird names switch controller');

assert.match(apt, /themeRow\(\)[\s\S]{0,100}labelsRow\(\)[\s\S]{0,100}atlasAlwaysAllRow\(\)[\s\S]{0,100}atlasClassicRow\(\)[\s\S]{0,120}settingsText\('SITE_NAME', 'Station name'/,
  'Station name finishes the appearance group beneath Classic Atlas cards');
assert.match(apt, /settingsSlider\('OVERLAP',[\s\S]{0,180}settingsToggle\('RESET_AT_MIDNIGHT', 'Reset at midnight'/,
  'Reset at midnight uses the standard Settings switch beside detection controls');
assert.match(functionSource('saveSettings'), /resetAtMidnightChanged[\s\S]*!Object\.prototype\.hasOwnProperty\.call\(pending, 'RESET_AT_MIDNIGHT'\)[\s\S]*refreshAll\(\)/,
  'a saved midnight preference refreshes data unless a newer toggle value is pending');
assert.match(functionSource('renderAtlas'), /DATA\.recent && DATA\.recent\.window_start[\s\S]*Date\.parse/,
  'Atlas lifer badges use the server-owned window start');
const windowLabelContext = {};
vm.createContext(windowLabelContext);
vm.runInContext(functionSource('windowLabel'), windowLabelContext);
assert.equal(windowLabelContext.windowLabel(24, { midnight_clamped: true }), 'since midnight',
  'a clamped window is labeled from station midnight');
assert.equal(windowLabelContext.windowLabel(24, { midnight_clamped: false }), 'past 24h',
  'an unclamped 24 hour window keeps its rolling label');
assert.equal(windowLabelContext.windowLabel(168, null), 'past 7d',
  'the seven day label stays explicitly rolling');
assert.match(css, /\.admin-settings \.menu-row\s*\{\s*border-radius:\s*0/,
  'Settings row separators have square ends instead of card-like rounded caps');
assert.match(css, /\.admin-settings section > \.menu-row \+ \.menu-row\s*\{[\s\S]*border-top:\s*1px solid var\(--hairline\);\s*box-shadow:\s*none/,
  'appearance, API, recording, and disk rows share one edge-to-edge theme hairline');
assert.match(css, /\.settings-retention > \.birdweather-control,[\s\S]*\.settings-retention > \.archive-settings-control\s*\{[\s\S]*border-top:\s*1px solid var\(--hairline\);\s*box-shadow:\s*none/,
  'LAN, BirdWeather, and Nightly Drive boundaries use the same straight theme hairline');
assert.match(css, /\.admin-settings \.settings-retention > \.archive-settings-control \+ \.menu-row\s*\{[\s\S]*border-top:\s*1px solid var\(--hairline\);\s*box-shadow:\s*none/,
  'Preserve all recordings begins with the same square-ended retention divider');
assert.doesNotMatch(css, /\.settings-retention > \.birdweather-control,[\s\S]{0,260}box-shadow:\s*inset[^}]*rgba\(26,22,18/,
  'retention separators do not leak light-only shadow colors into dark mode');
assert.match(functionSource('archiveDetail'), /class="archive-button quiet archive-run-button"/,
  'Nightly Drive Run now uses the same light secondary treatment as nearby controls');
const archiveMarkupContext = {
  adminEsc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
};
vm.createContext(archiveMarkupContext);
vm.runInContext([
  functionSource('settingsInfoMarkup'),
  functionSource('archiveConfiguredState'),
  functionSource('archiveSettingsRow'),
].join('\n'), archiveMarkupContext);
const archiveRowMarkup = archiveMarkupContext.archiveSettingsRow({
  ok: true,
  installed: false,
  dependencies: { rclone: true, sqlite3: true },
  remote: { name: 'gdrive', configured: false },
  timer: { enabled: 'disabled' },
});
assert.equal((archiveRowMarkup.match(/data-settings-info/g) || []).length, 1,
  'Nightly Drive has one stable information control beside its row label');
assert.match(archiveRowMarkup, /Nightly Drive backup<\/span>[\s\S]*id="archiveBackupTip" role="tooltip">Back up completed days to Google Drive\.[\s\S]*run rclone config[\s\S]*name the remote gdrive[\s\S]*choose drive\.file[\s\S]*button beside the command/,
  'the Nightly Drive tooltip gives the complete first-use sequence');
assert.match(archiveRowMarkup, /data-archive-toggle[^>]*aria-describedby="archiveBackupTip"/,
  'the archive switch shares the stable workflow explanation');
assert.match(functionSource('archiveDetail'), /var setupAction = state\.installed \? 'refresh' : 'install'[\s\S]*archiveCode\('rclone config'\)[\s\S]*data-archive-action="' \+ setupAction/,
  'an uninstalled archive shows rclone config with Set up archive while an installed archive shows Check again');
assert.doesNotMatch(functionSource('archiveDetail'), /settingsInfoMarkup|archiveRcloneTip|data-settings-info/,
  'the repainted archive details contain no disposable tooltip control');
assert.doesNotMatch(functionSource('archiveDetail'), /Install the archive service|It stays off until|install archive/,
  'archive setup omits the old helper paragraph and install wording');
assert.match(css, /\.archive-detail\s*\{[\s\S]*margin-top:\s*0;\s*padding-top:\s*0;\s*box-shadow:\s*none/,
  'the compact archive disclosure removes its inset divider');
assert.match(css, /\.archive-setup-row\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/,
  'archive commands and actions share one compact row');
assert.match(css, /\.password-change-form \.chip,[\s\S]*\.archive-setup-button\s*\{[\s\S]*background:\s*var\(--paper-2\)[\s\S]*box-shadow:\s*var\(--raised\)/,
  'Set up archive uses the same raised paper action style as password controls');
assert.match(css, /\.archive-setup-button\s*\{[\s\S]*min-height:\s*32px;[\s\S]*white-space:\s*nowrap/,
  'archive setup actions match the one-line rclone field height');
assert.match(css, /\.archive-settings-details \.archive-setup-row \.code \.copy\s*\{\s*top:\s*50%;\s*transform:\s*translateY\(-50%\)/,
  'the rclone copy affordance is vertically centered in its field');
assert.match(functionSource('syncAdminTitlePin'), /adminSect === 'settings'[\s\S]*adminEl\.scrollTop > threshold/,
  'only the long Settings page activates the compact admin title state');
assert.match(css, /\.admin-screen\s*\{[\s\S]*inset:\s*0 0 60px 0;[\s\S]*\.admin-frame\s*\{[\s\S]*padding:\s*60px 28px 40px/,
  'the admin frame starts below the fixed controls while its title can travel through the scroller');
assert.match(css, /\.admin-screen\[data-admin-section="settings"\] \.admin-title\s*\{[\s\S]*position:\s*sticky;\s*top:\s*18px/,
  'the desktop Settings title sticks on the fixed control line without shrinking');
assert.match(css, /\.admin-screen\[data-admin-section="settings"\] \.admin-title::before\s*\{[\s\S]*top:\s*-18px;[\s\S]*background:\s*var\(--paper\);[\s\S]*pointer-events:\s*auto/,
  'the Settings header is continuously opaque and blocks hidden controls');
assert.doesNotMatch(css, /\.admin-screen\[data-admin-section="settings"\] \.admin-title::before\s*\{[\s\S]{0,500}backdrop-filter/,
  'the Settings header does not reveal rows through a translucent blur');
assert.match(css, /@media \(max-width:\s*700px\)[\s\S]*\.admin-screen\[data-admin-section="settings"\] \.admin-title\s*\{\s*top:\s*10px;/,
  'the mobile Settings title uses the matching compact header position');
assert.match(css, /@media \(max-width:\s*700px\)[\s\S]*\.admin-screen\[data-admin-section="settings"\] \.admin-title::before\s*\{\s*top:\s*-10px;/,
  'the mobile header mask reaches the top edge without covering the title');

function adminTitlePinHarness() {
  const attrs = { 'data-title-pinned': 'false' };
  const context = {
    adminTitleFrame: 0,
    adminSect: 'settings',
    adminEl: {
      scrollTop: 0,
      getAttribute(name) { return attrs[name] ?? null; },
      setAttribute(name, value) { attrs[name] = String(value); },
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('syncAdminTitlePin'), context);
  const at = (scrollTop, section = 'settings') => {
    context.adminEl.scrollTop = scrollTop;
    context.adminSect = section;
    context.syncAdminTitlePin();
    return attrs['data-title-pinned'];
  };
  assert.equal(at(0), 'false', 'Settings begins with its title in the document row');
  assert.equal(at(41), 'false', 'the header backdrop waits until the title reaches the control line');
  assert.equal(at(43), 'true', 'the Settings title pins after completing its 42px travel');
  assert.equal(at(35), 'true', 'a small upward scroll does not chatter the pinned title');
  assert.equal(at(34), 'false', 'the backdrop releases as the title leaves the header');
  assert.equal(at(80, 'tools'), 'false', 'other admin pages do not inherit the Settings pin state');
}
adminTitlePinHarness();
assert.equal(crypto.createHash('sha256').update(archiveApi).digest('hex'),
  '746cc9259d7d05366d756442142584c81d8d3b0ad7386e75c71b68c9e1946b69',
  'the frontend polish pass does not change the Nightly Drive API backend');
assert.equal(crypto.createHash('sha256').update(archiveHelper).digest('hex'),
  'ac9d8c617b91068f177571f8884a290cea9e5a97b2d00516f385f068f796bf2a',
  'the frontend polish pass does not change the Nightly Drive privileged helper');
assert.match(html, /id="aboutLink" data-site-name/, 'the collage masthead consumes the canonical station name');
assert.match(api, /'site_name'\s*=>\s*publicSiteName\(\$CONF_PATH\)/,
  'the public recent response exposes only the canonical station title');
assert.match(api, /function publicSiteName[\s\S]*SITE_NAME/,
  'the public endpoint uses a narrow SITE_NAME-only reader');

function tooltipHarness() {
  const buttonListeners = {};
  const documentListeners = {};
  const attrs = { 'aria-expanded': 'false' };
  const wrapperAttrs = {};
  const wrapper = {
    setAttribute(name, value) { wrapperAttrs[name] = String(value); },
    contains(value) { return value === button; },
  };
  const button = {
    addEventListener(type, listener) { (buttonListeners[type] ||= []).push(listener); },
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    closest(selector) { return selector === '.access-copy' ? wrapper : null; },
  };
  const documentStub = {
    activeElement: button,
    addEventListener(type, listener) { (documentListeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) {
      documentListeners[type] = (documentListeners[type] || []).filter((item) => item !== listener);
    },
  };
  const scope = { querySelectorAll() { return [button]; } };
  const context = {
    document: documentStub,
    setTimeout(callback) { callback(); },
  };
  vm.createContext(context);
  vm.runInContext(`var settingsInfoCleanup = null; ${functionSource('wireSettingsInfo')}`, context);
  context.wireSettingsInfo(scope);
  return {
    attrs,
    wrapperAttrs,
    dispatchButton(type) {
      (buttonListeners[type] || []).forEach((listener) => listener({
        preventDefault() {}, stopPropagation() {},
      }));
    },
    dispatchDocument(type, event) {
      (documentListeners[type] || []).forEach((listener) => listener(event));
    },
  };
}

const tooltip = tooltipHarness();
tooltip.dispatchButton('pointerenter');
assert.equal(tooltip.attrs['aria-expanded'], 'true', 'pointer hover opens the tooltip explicitly');
tooltip.dispatchDocument('keydown', { key: 'Escape', stopPropagation() {} });
assert.equal(tooltip.attrs['aria-expanded'], 'false', 'Escape closes a hover-only tooltip without focus reopening it');
tooltip.dispatchButton('pointerleave');
tooltip.dispatchButton('pointerenter');
tooltip.dispatchButton('click');
assert.equal(tooltip.attrs['aria-expanded'], 'true', 'first click pins the visible tooltip');
tooltip.dispatchButton('click');
assert.equal(tooltip.attrs['aria-expanded'], 'false', 'second click dismisses the tooltip');

function segmentedControl(initial) {
  const listeners = [];
  const buttons = ['keep', 'purge'].map(function (value) {
    const attrs = {
      'aria-current': value === initial ? 'true' : 'false',
      'data-unavailable': null,
    };
    return {
      dataset: { v: value },
      disabled: false,
      getAttribute(name) { return attrs[name] ?? null; },
      setAttribute(name, next) { attrs[name] = String(next); },
    };
  });
  const container = {
    __advanceWired: false,
    querySelectorAll(selector) { return selector === 'button' ? buttons : []; },
    addEventListener(type, listener, capture) {
      assert.equal(type, 'click');
      listeners.push({ listener, capture: !!capture });
    },
  };
  function dispatch(button) {
    let stopped = false;
    const event = {
      target: { closest() { return button; } },
      stopImmediatePropagation() { stopped = true; },
    };
    listeners.filter(function (entry) { return entry.capture; })
      .forEach(function (entry) { if (!stopped) entry.listener(event); });
    if (stopped || !button) return;
    buttons.forEach(function (candidate) {
      candidate.setAttribute('aria-current', candidate === button ? 'true' : 'false');
    });
  }
  buttons.forEach(function (button) { button.click = function () { dispatch(button); }; });
  return { container, buttons, dispatch, listeners };
}

const segmentedContext = {};
vm.createContext(segmentedContext);
vm.runInContext(functionSource('wireToggleAdvance'), segmentedContext);
const disk = segmentedControl('keep');
segmentedContext.wireToggleAdvance(disk.container);
assert.equal(disk.listeners[0].capture, true,
  'two-option advance observes the old selection before the button handler runs');
disk.dispatch(disk.buttons[1]);
assert.equal(disk.buttons[1].getAttribute('aria-current'), 'true',
  'clicking Purge moves the disk selector to Purge');
disk.dispatch(disk.buttons[1]);
assert.equal(disk.buttons[0].getAttribute('aria-current'), 'true',
  'clicking the selected side advances the two-option selector');

let adminVisible = true;
let frame = null;
let packCount = 0;
let frameRequests = 0;
let settleCallback = null;
const atlasContext = {
  document: {
    body: { classList: { contains() { return adminVisible; } } },
    getElementById() { return {}; },
  },
  requestAnimationFrame(callback) { frame = callback; frameRequests += 1; return frameRequests; },
  cancelAnimationFrame() { frame = null; },
  setTimeout(callback) { settleCallback = callback; return 1; },
  clearTimeout() { settleCallback = null; },
  packAtlasGrids() { packCount += 1; },
};
vm.createContext(atlasContext);
vm.runInContext([
  'var atlasVisibilityPackFrame = 0;',
  'var atlasVisibilityPackSettleTimer = 0;',
  'var atlasResizeSettling = false;',
  functionSource('queueVisibleAtlasPack'),
  functionSource('handleAtlasResize'),
].join('\n'), atlasContext);
atlasContext.queueVisibleAtlasPack();
frame();
assert.equal(packCount, 0, 'Atlas does not measure while the admin overlay hides it');
adminVisible = false;
atlasContext.queueVisibleAtlasPack();
frame();
assert.equal(packCount, 1, 'Atlas repacks as soon as the admin overlay releases it');
const coalescedFrameStart = frameRequests;
const coalescedPackStart = packCount;
atlasContext.handleAtlasResize();
atlasContext.queueVisibleAtlasPack();
atlasContext.queueVisibleAtlasPack();
assert.equal(frameRequests - coalescedFrameStart, 1,
  'resize and admin-close requests share one immediate Atlas frame');
frame();
assert.equal(packCount - coalescedPackStart, 1,
  'the shared immediate frame measures Atlas once');
assert.equal(typeof settleCallback, 'function', 'resize retains one trailing settled measurement');
settleCallback();
frame();
assert.equal(packCount - coalescedPackStart, 2,
  'resize plus admin close produce one immediate and one settled pack, never a duplicate third pack');
assert.doesNotMatch(functionSource('handleAtlasResize'), /packAtlasGrids|requestAnimationFrame/,
  'the resize path delegates to the shared admin-aware scheduler');

function closeAdminPackCount(wasAdminOn, section) {
  let count = 0;
  const classes = new Set(wasAdminOn ? ['admin-on'] : []);
  const context = {
    document: { body: { classList: {
      contains(value) { return classes.has(value); },
      remove(value) { classes.delete(value); },
    } } },
    adminSect: section,
    adminViewGeneration: 0,
    adminEl: { scrollTop: 0, setAttribute() {}, removeAttribute() {} },
    adminPollT: null,
    settingsInfoCleanup: null,
    discardPendingSettings() {},
    clearInterval() {},
    syncAdminTitlePin() {},
    queueVisibleAtlasPack() { count += 1; },
  };
  vm.createContext(context);
  vm.runInContext(functionSource('closeAdmin'), context);
  context.closeAdmin();
  return count;
}
assert.equal(closeAdminPackCount(true, null), 1,
  'releasing an actual overlay repacks even if its section was cleared by a race');
assert.equal(closeAdminPackCount(false, null), 0,
  'ordinary non-admin hash navigation does not schedule an Atlas repack');

const adminHashContext = {
  location: { hash: '#admin=settings' },
  educatorsAvailable: true,
  ADMIN_TITLES: { settings: 'Settings', system: 'System', logs: 'Logs', tools: 'Tools', educators: 'Educators' },
};
vm.createContext(adminHashContext);
vm.runInContext(functionSource('readAdminHash'), adminHashContext);
assert.equal(adminHashContext.readAdminHash(), 'settings', 'a current native admin hash still resolves');
adminHashContext.location.hash = '#admin=educators';
assert.equal(adminHashContext.readAdminHash(), 'educators', 'the enabled Educators deep link resolves exactly');
adminHashContext.educatorsAvailable = false;
assert.equal(adminHashContext.readAdminHash(), null, 'a stale Educators deep link stays closed while the profile is disabled');
adminHashContext.educatorsAvailable = true;
adminHashContext.location.hash = '#admin=constructor';
assert.equal(adminHashContext.readAdminHash(), null, 'inherited object names cannot become admin routes');
adminHashContext.location.hash = '#admin=tools-extra';
assert.equal(adminHashContext.readAdminHash(), null, 'admin hashes must match a complete whitelisted route');

const gateSelectors = css.match(/[^{}]+\{/g) || [];
gateSelectors.forEach(function (selector) {
  if (!/body\.av-(?:local|forwarded)/.test(selector)) return;
  assert.doesNotMatch(selector, /atlas/i,
    'gate off and gate on must not select or reposition the Atlas');
});

assert.match(html, /styles\.css\?v=r196/, 'the polished styles have a fresh cache key');
assert.match(html, /apt\.js\?v=r234/, 'the polished behavior has a fresh cache key');

console.log('admin UI polish smoke: ok');
