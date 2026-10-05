#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apt = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../avian/frontend/styles.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../avian/frontend/index.html', import.meta.url), 'utf8');

function functionSource(name) {
  const start = apt.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is present`);
  const body = apt.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = body; index < apt.length; index += 1) {
    const char = apt[index];
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
    if (char === '}' && --depth === 0) return apt.slice(start, index + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

function style(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    setProperty(name, value) { values.set(name, String(value)); },
    removeProperty(name) { values.delete(name); },
    getPropertyValue(name) { return values.get(name) || ''; },
  };
}

function classes(...names) {
  const values = new Set(names);
  return {
    values,
    add(...items) { items.forEach((item) => values.add(item)); },
    remove(...items) { items.forEach((item) => values.delete(item)); },
    contains(item) { return values.has(item); },
  };
}

// Preference behavior: stamps by default, strict migration, immediate local
// persistence, and no dependency on the Pi config API.
const preferenceStore = new Map();
const preferenceWrites = [];
let preferenceSyncs = 0;
const preferenceContext = {
  readLS(key, fallback) { return preferenceStore.get(key) || fallback; },
  writeLS(key, value) { preferenceStore.set(key, value); preferenceWrites.push([key, value]); },
  syncAtlasStyle() { preferenceSyncs += 1; },
};
vm.createContext(preferenceContext);
vm.runInContext(`
  var ATLAS_STYLE_KEY = 'bird:atlasStyle:v1';
  var sessionAtlasStyle = null;
  ${functionSource('atlasStyle')}
  ${functionSource('atlasUsesClassicCards')}
  ${functionSource('applyAtlasStyle')}
  this.preference = { atlasStyle, atlasUsesClassicCards, applyAtlasStyle };
`, preferenceContext);

assert.equal(preferenceContext.preference.atlasStyle(), 'stamps', 'fresh browsers default to stamps');
preferenceStore.set('bird:atlasStyle:v1', 'unexpected');
vm.runInContext('sessionAtlasStyle = null', preferenceContext);
assert.equal(preferenceContext.preference.atlasStyle(), 'stamps', 'unknown stored values migrate safely to stamps');
preferenceStore.set('bird:atlasStyle:v1', 'classic');
vm.runInContext('sessionAtlasStyle = null', preferenceContext);
assert.equal(preferenceContext.preference.atlasUsesClassicCards(), true, 'saved Classic mode restores');
preferenceContext.preference.applyAtlasStyle(false);
assert.deepEqual(preferenceWrites.at(-1), ['bird:atlasStyle:v1', 'stamps'], 'turning Classic off persists stamps');
preferenceContext.preference.applyAtlasStyle(true);
assert.deepEqual(preferenceWrites.at(-1), ['bird:atlasStyle:v1', 'classic'], 'turning Classic on persists classic');
assert.equal(preferenceSyncs, 2, 'each preference change performs one immediate local sync');

const rowContext = { atlasUsesClassicCards() { return true; } };
vm.createContext(rowContext);
vm.runInContext(`${functionSource('atlasClassicRow')}; this.markup = atlasClassicRow();`, rowContext);
assert.match(rowContext.markup, />Classic Atlas cards</, 'Settings uses the requested concise label');
assert.match(rowContext.markup, /data-atlas-classic/, 'Settings exposes a dedicated local switch');
assert.match(rowContext.markup, /aria-checked="true"/, 'the switch reflects the saved preference');
assert.doesNotMatch(rowContext.markup, /hint/, 'the preference adds no helper-copy clutter');
assert.match(apt, /atlasAlwaysAllRow\(\)\s*\+ atlasClassicRow\(\)\s*\+ settingsText\('SITE_NAME', 'Station name'/,
  'Classic Atlas cards stays in the first preference group immediately above Station name');
assert.match(apt, /\.switch:not\(\[data-labels-switch\]\):not\(\[data-atlas-always-all\]\):not\(\[data-atlas-classic\]\)/,
  'the local preference is excluded from Pi config autosave');

// Packed stamp state is cleared before the historical CSS grid takes over.
const nestedGrid = { classList: classes('atlas-fam-grid', 'is-packed'), style: style({ height: '500px', '--pack-gap': '6px' }) };
const fit = { style: style({ '--fit-scale': '.8' }) };
const card = {
  style: style({ left: '10px', top: '20px', position: 'absolute', '--slot-w': '188px', '--slot-h': '236px' }),
  querySelector(selector) { return selector === '.stamp-fit' ? fit : null; },
};
const packedRoot = {
  classList: classes('atlas-grid', 'is-packed'),
  style: style({ height: '900px', '--pack-gap': '5px' }),
  querySelectorAll(selector) {
    if (selector === '.atlas-fam-grid') return [nestedGrid];
    if (selector === '.bird-card') return [card];
    return [];
  },
};
const packedContext = {};
vm.createContext(packedContext);
vm.runInContext(`${functionSource('clearAtlasPackedState')}; this.clearAtlasPackedState = clearAtlasPackedState;`, packedContext);
packedContext.clearAtlasPackedState(packedRoot);
assert.equal(packedRoot.classList.contains('is-packed'), false, 'root packed class is removed');
assert.equal(nestedGrid.classList.contains('is-packed'), false, 'family packed class is removed');
assert.equal(packedRoot.style.getPropertyValue('height'), '', 'root packed height is removed');
assert.equal(card.style.getPropertyValue('position'), '', 'absolute card positioning is removed');
assert.equal(card.style.getPropertyValue('--slot-w'), '', 'stamp slot width is removed');
assert.equal(fit.style.getPropertyValue('--fit-scale'), '', 'stamp fit scale is removed');

let packClearCalls = 0;
let overflowCalls = 0;
const packContext = {
  clearAtlasPackedState() { packClearCalls += 1; },
  queueAtlasOverflowState() { overflowCalls += 1; },
};
vm.createContext(packContext);
vm.runInContext(`${functionSource('packAtlasGrids')}; this.packAtlasGrids = packAtlasGrids;`, packContext);
packContext.packAtlasGrids({ id: 'atlasGrid', dataset: { layout: 'classic' } });
assert.equal(packClearCalls, 1, 'the packer clears stale state in Classic mode');
assert.equal(overflowCalls, 1, 'the packer still refreshes Atlas scrolling in Classic mode');

const commitTemplate = { content: {} };
Object.defineProperty(commitTemplate, 'innerHTML', {
  set(value) { this.content.html = value; },
});
const committed = [];
const commitGrid = {
  dataset: {},
  attrs: {},
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  replaceChildren(content) { committed.push(content.html); },
};
let commitClears = 0;
const commitContext = {
  clearAtlasPackedState() { commitClears += 1; },
  document: { createElement(name) { assert.equal(name, 'template'); return commitTemplate; } },
};
vm.createContext(commitContext);
vm.runInContext(`${functionSource('commitClassicAtlasMarkup')}; this.commitClassicAtlasMarkup = commitClassicAtlasMarkup;`, commitContext);
commitContext.commitClassicAtlasMarkup(commitGrid, '<article>one</article>', 'family', true);
assert.equal(commitGrid.dataset.layout, 'classic', 'Classic commits publish the layout class hook');
assert.equal(commitGrid.dataset.sort, 'family', 'Classic commits preserve the active sort');
assert.equal(commitGrid.attrs['data-mode'], 'family', 'Classic commits preserve family grouping');
assert.equal(commitClears, 1, 'Classic commits clear packed state before replacement');
assert.equal(committed[0], '<article>one</article>', 'Classic markup is committed without a stamp transplant');

// Render the real Classic branch with a small data set. This validates the
// historical card structure and proves stamp-only subsystems remain dormant.
const renderStart = apt.indexOf('function renderAtlas(');
const renderEnd = apt.indexOf('\n  function handleAtlasResize', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, 'renderAtlas source is present');
const renderSource = apt.slice(renderStart, renderEnd);
const renderGrid = {
  dataset: {},
  querySelectorAll() { return []; },
};
let effectiveHours = 1000000;
let classicCommits = [];
let stampCommits = 0;
let packCalls = 0;
let flipCalls = 0;
let fxCalls = 0;
let arrivalCalls = 0;
let stopCalls = 0;
let audioWires = 0;
let scrubWires = 0;
const renderContext = {
  document: { getElementById(id) { return id === 'atlasGrid' ? renderGrid : null; } },
  window: {
    __atlasSort: 'count',
    STAMPS: {
      familyOf(sci) { return sci.startsWith('A') ? 'Alpha family' : 'Zeta family'; },
      markup() { throw new Error('stamp markup ran in Classic mode'); },
    },
    FX: { run() { fxCalls += 1; } },
  },
  DATA: {
    lifelist: { species: [
      { sci: 'Aves alpha', com: 'Alpha Bird', n: 3, first_seen: '2024-01-01 08:00:00' },
      { sci: 'Zosterops zeta', com: 'Zeta Bird', n: 8, first_seen: '2024-01-02 08:00:00' },
    ] },
    recent: { species: [
      { sci: 'Aves alpha', n: 2 },
      { sci: 'Zosterops zeta', n: 1 },
    ] },
  },
  atlasUsesClassicCards() { return true; },
  atlasRects() { throw new Error('stamp rectangle capture ran in Classic mode'); },
  stopAtlasCardAudio() { stopCalls += 1; },
  clearAtlasPackedState() {},
  atlasWindowHours() { return effectiveHours; },
  educatorScopeId() { return ''; },
  educatorScopeGeneration: 0,
  educatorScopeLabel() { return 'Listening period'; },
  effectiveEducatorScope: null,
  educatorDetectionId() { return null; },
  adminAttr(value) { return String(value); },
  mediaApiUrl(endpoint, params) { return `./avian/api/${endpoint}.php?sci=${encodeURIComponent(params.sci || '')}`; },
  EMPTY_WINDOW_COPY: 'none',
  fmtNK(value) { return String(value); },
  windowLabel() { return '24h'; },
  artRevision() { return 'r12'; },
  SKETCH_VERSION: 'r12',
  tablesReady: false,
  DIMS: {},
  slugify(value) { return value; },
  justGenerated: {},
  wikiUrl(sci) { return `https://example.test/wiki/${encodeURIComponent(sci)}`; },
  ebirdUrl() { return 'https://example.test/ebird'; },
  escHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); },
  ICON_PLAY: '<svg class="play-icon"></svg>',
  commitClassicAtlasMarkup(grid, markup, sortMode, familyMode) {
    classicCommits.push({ markup, sortMode, familyMode });
  },
  commitAtlasMarkup() { stampCommits += 1; },
  packAtlasGrids() { packCalls += 1; },
  animateAtlasFlip() { flipCalls += 1; },
  maybeStickNewStamps() { arrivalCalls += 1; },
  queueAtlasOverflowState() {},
  queueCompactHeader() {},
  requestAnimationFrame(callback) { callback(); return 1; },
  setTimeout(callback) { callback(); return 1; },
  wireAtlasCardAudio() { audioWires += 1; },
  wireAtlasSpectrogramScrub() { scrubWires += 1; },
  playAtlasEntrance() {},
};
vm.createContext(renderContext);
vm.runInContext(`${renderSource}; this.renderAtlas = renderAtlas;`, renderContext);
renderContext.renderAtlas(false);
assert.equal(stopCalls, 1, 'each render stops any card audio before replacing nodes');
assert.equal(classicCommits.length, 1, 'Classic mode uses its dedicated commit path');
assert.equal(classicCommits[0].sortMode, 'count', 'current count sort reaches the Classic renderer');
assert.equal(classicCommits[0].familyMode, false, 'flat sorts stay flat');
assert.ok(classicCommits[0].markup.indexOf('Zeta Bird') < classicCommits[0].markup.indexOf('Alpha Bird'),
  'current count ordering is preserved');
assert.match(classicCommits[0].markup, /class="bird-card classic-atlas-card"/, 'pre-stamp card markup is rendered');
assert.match(classicCommits[0].markup, /class="stat"/, 'Classic cards retain historical counts');
assert.match(classicCommits[0].markup, /class="img-wrap"/, 'Classic cards retain historical artwork structure');
assert.match(classicCommits[0].markup, /class="spectro-wrap"/, 'Classic cards retain historical spectrogram structure');
assert.match(classicCommits[0].markup, /class="actions"/, 'Classic cards retain historical actions');
assert.doesNotMatch(classicCommits[0].markup, /stamp-card|stamp-fit/, 'Classic card markup contains no stamp issue');
assert.equal(stampCommits + packCalls + flipCalls + fxCalls + arrivalCalls, 0,
  'Classic rendering skips every stamp-only subsystem');
assert.equal(audioWires, 1, 'Classic cards keep delegated audio playback');
assert.equal(scrubWires, 1, 'Classic cards keep audio scrubbing');

effectiveHours = 24;
renderContext.DATA.recent.species = [{ sci: 'Aves alpha', n: 2 }];
renderContext.renderAtlas(false);
assert.equal(stopCalls, 2, 'a rerender also stops a now-detached audio source');
assert.match(classicCommits.at(-1).markup, /Alpha Bird/, 'windowed species remain visible');
assert.doesNotMatch(classicCommits.at(-1).markup, /Zeta Bird/, 'current Atlas window filtering remains intact');

effectiveHours = 1000000;
renderContext.DATA.recent.species = [
  { sci: 'Aves alpha', n: 2 },
  { sci: 'Zosterops zeta', n: 1 },
];
renderContext.window.__atlasSort = 'family';
renderContext.renderAtlas(false);
assert.equal(classicCommits.at(-1).familyMode, true, 'family mode remains grouped in Classic mode');
assert.match(classicCommits.at(-1).markup, /fam-block/, 'family sections remain in the rendered structure');

// The delegated scrub handler is installed exactly once and follows the
// current module-wide audio source after any number of card rerenders.
let delegatedListener = null;
let delegatedAdds = 0;
const scrubGrid = {
  addEventListener(type, listener) {
    assert.equal(type, 'click');
    delegatedAdds += 1;
    delegatedListener = listener;
  },
};
let playClicks = 0;
const playButton = { click() { playClicks += 1; } };
const scrubCard = { querySelector() { return playButton; } };
const scrubWrap = {
  firstChild: {},
  closest() { return scrubCard; },
  getBoundingClientRect() { return { left: 10, width: 100 }; },
};
const scrubContext = {
  atlasCardAudioButton: playButton,
  atlasCardAudio: { duration: 80, currentTime: 0 },
};
vm.createContext(scrubContext);
vm.runInContext(`${functionSource('wireAtlasSpectrogramScrub')}; this.wire = wireAtlasSpectrogramScrub;`, scrubContext);
scrubContext.wire(scrubGrid);
scrubContext.wire(scrubGrid);
assert.equal(delegatedAdds, 1, 'rerenders cannot accumulate spectrogram handlers');
delegatedListener({ clientX: 60, target: { closest() { return scrubWrap; } } });
assert.equal(scrubContext.atlasCardAudio.currentTime, 40, 'the delegated handler scrubs the active recording');
scrubContext.atlasCardAudioButton = null;
delegatedListener({ clientX: 60, target: { closest() { return scrubWrap; } } });
assert.equal(playClicks, 1, 'the delegated handler restarts an inactive card');

// The Atlas root survives refreshes while commitAtlasMarkup can transplant an
// unchanged stamp card back into it. Re-running the render wiring with that
// exact button must still leave one play handler, not one handler per poll.
let playListener = null;
let playListenerAdds = 0;
let retainedStops = 0;
let retainedClaims = 0;
let retainedLoads = 0;
const retainedStates = [];
const retainedSpectrogram = { firstChild: {} };
const retainedStampCard = {
  dataset: { audio: '/avian/api/recording.php?sci=Retained' },
  querySelector(selector) { return selector === '.spectro-wrap' ? retainedSpectrogram : null; },
};
const retainedStampButton = {
  id: 'retained-stamp-play',
  closest(selector) { return selector === '.bird-card' ? retainedStampCard : null; },
};
const retainedStampGrid = {
  contains(node) { return node === retainedStampButton; },
  addEventListener(type, listener) {
    assert.equal(type, 'click');
    playListenerAdds += 1;
    playListener = listener;
  },
};
const retainedStampContext = {
  atlasCardAudio: null,
  atlasCardAudioButton: null,
  _decodedCache: {},
  stopAtlasCardAudio() {
    retainedStops += 1;
  },
  audioClaim() { retainedClaims += 1; },
  setAtlasCardButtonState(button, state) {
    assert.equal(button, retainedStampButton);
    retainedStates.push(state);
  },
  Audio: class {
    addEventListener() {}
    load() { retainedLoads += 1; }
  },
};
vm.createContext(retainedStampContext);
vm.runInContext(`
  ${functionSource('activateAtlasCardAudio')}
  ${functionSource('wireAtlasCardAudio')}
  this.wire = wireAtlasCardAudio;
`, retainedStampContext);
retainedStampContext.wire(retainedStampGrid);
retainedStampContext.wire(retainedStampGrid);
retainedStampContext.wire(retainedStampGrid);
assert.equal(playListenerAdds, 1, 'three unchanged-card refreshes keep one delegated play listener');
playListener({ target: { closest(selector) {
  return selector === '[data-action="play"]' ? retainedStampButton : null;
} } });
assert.equal(retainedStops, 1, 'one retained stamp play click performs one initial stop');
assert.equal(retainedClaims, 1, 'one retained stamp play click claims audio exactly once');
assert.deepEqual(retainedStates, ['loading'], 'one retained stamp play click cannot toggle itself back to idle');
assert.equal(retainedLoads, 1, 'one retained stamp play click creates one recording load');
assert.equal(retainedStampContext.atlasCardAudioButton, retainedStampButton,
  'the retained stamp remains the active source after one click');

// A retained button can be stopped and restarted before its first Audio object
// finishes dispatching events. Those stale callbacks must key on the exact
// Audio identity, not only the button that the new recording reuses.
const raceAudios = [];
let raceClaims = 0;
let raceReleases = 0;
const raceStates = [];
const raceProgress = style({ '--prog': '0%' });
const raceSpectrogram = { firstChild: {}, style: raceProgress };
const raceCard = {
  attrs: {},
  dataset: { audio: '/avian/api/recording.php?sci=Race' },
  querySelector(selector) { return selector === '.spectro-wrap' ? raceSpectrogram : null; },
  setAttribute(name, value) { this.attrs[name] = String(value); },
  removeAttribute(name) { delete this.attrs[name]; },
};
const raceButton = {
  attrs: {},
  innerHTML: '',
  closest(selector) { return selector === '.bird-card' ? raceCard : null; },
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'data-state') raceStates.push(String(value));
  },
  getAttribute(name) { return this.attrs[name] || null; },
};
class RaceAudio {
  constructor(source) {
    this.source = source;
    this.listeners = {};
    this.duration = 8;
    this.currentTime = 0;
    this.loads = 0;
    this.pauses = 0;
    this.plays = 0;
    raceAudios.push(this);
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  emit(type) { this.listeners[type](); }
  load() { this.loads += 1; }
  pause() { this.pauses += 1; }
  play() { this.plays += 1; }
}
const raceContext = {
  Audio: RaceAudio,
  ICON_PLAY: '<play>',
  ICON_PAUSE: '<pause>',
  _decodedCache: {},
  audioClaim() { raceClaims += 1; },
  audioRelease() { raceReleases += 1; },
  setTimeout() { return 1; },
};
vm.createContext(raceContext);
vm.runInContext(`
  var atlasCardAudio = null;
  var atlasCardAudioButton = null;
  ${functionSource('setAtlasCardButtonState')}
  ${functionSource('clearAtlasCardProgress')}
  ${functionSource('stopAtlasCardAudio')}
  ${functionSource('activateAtlasCardAudio')}
  this.activate = activateAtlasCardAudio;
`, raceContext);

raceContext.activate(raceButton);
const staleAudio = raceAudios[0];
raceContext.activate(raceButton); // stop A
raceContext.activate(raceButton); // restart the same button as B
const currentAudio = raceAudios[1];
assert.equal(raceAudios.length, 2, 'same-button restart creates exactly Audio A and Audio B');
assert.equal(staleAudio.pauses, 1, 'stopping the first click pauses Audio A');
assert.equal(currentAudio.loads, 1, 'the restarted button loads Audio B');
assert.equal(raceClaims, 2, 'only A and B claim the shared audio coordinator');

const releasesBeforeStale = raceReleases;
const guardedStates = raceStates.length;
raceProgress.setProperty('--prog', '17%');
staleAudio.duration = 10;
staleAudio.currentTime = 5;
staleAudio.emit('canplay');
staleAudio.emit('timeupdate');
staleAudio.emit('ended');
staleAudio.emit('error');
assert.equal(staleAudio.plays, 0, 'stale Audio A canplay cannot start playback');
assert.equal(raceProgress.getPropertyValue('--prog'), '17%', 'stale Audio A cannot move Audio B progress');
assert.equal(raceReleases, releasesBeforeStale, 'stale Audio A cannot release Audio B');
assert.equal(currentAudio.pauses, 0, 'stale Audio A ended cannot stop Audio B');
assert.equal(raceContext.atlasCardAudio, currentAudio, 'stale Audio A cannot clear the active Audio B reference');
assert.equal(raceContext.atlasCardAudioButton, raceButton, 'stale Audio A cannot clear the reused button');
assert.equal(raceStates.length, guardedStates, 'stale Audio A cannot change the button state');

currentAudio.currentTime = 2;
currentAudio.emit('canplay');
currentAudio.emit('timeupdate');
assert.equal(currentAudio.plays, 1, 'current Audio B canplay starts playback');
assert.equal(raceCard.attrs['data-playing'], 'true', 'current Audio B publishes playing state');
assert.equal(raceProgress.getPropertyValue('--prog'), '25.0%', 'current Audio B updates progress');
currentAudio.emit('ended');
assert.equal(currentAudio.pauses, 1, 'current Audio B ended stops its own source');
assert.equal(raceContext.atlasCardAudio, null, 'current Audio B ended clears the active audio');
assert.equal(raceContext.atlasCardAudioButton, null, 'current Audio B ended clears the active button');
assert.equal(raceButton.getAttribute('data-state'), 'idle', 'current Audio B ended restores the play control');

let pauses = 0;
let releases = 0;
const progressStyle = style({ '--prog': '44%' });
const audioCard = {
  playing: true,
  querySelector() { return { style: progressStyle }; },
  removeAttribute(name) { if (name === 'data-playing') this.playing = false; },
};
const audioButton = {
  attrs: {},
  innerHTML: '',
  setAttribute(name, value) { this.attrs[name] = String(value); },
  getAttribute(name) { return this.attrs[name] || null; },
  closest() { return audioCard; },
};
const audioContext = {
  ICON_PLAY: '<play>',
  ICON_PAUSE: '<pause>',
  atlasCardAudio: { pause() { pauses += 1; } },
  atlasCardAudioButton: audioButton,
  audioRelease() { releases += 1; },
  setTimeout() { return 1; },
};
vm.createContext(audioContext);
vm.runInContext(`
  ${functionSource('setAtlasCardButtonState')}
  ${functionSource('clearAtlasCardProgress')}
  ${functionSource('stopAtlasCardAudio')}
  this.stop = stopAtlasCardAudio;
`, audioContext);
audioContext.stop();
assert.equal(pauses, 1, 'a detached Classic recording is paused on rerender');
assert.equal(releases, 1, 'the shared audio coordinator is released');
assert.equal(audioContext.atlasCardAudio, null, 'the detached audio reference is cleared');
assert.equal(audioContext.atlasCardAudioButton, null, 'the detached button reference is cleared');
assert.equal(progressStyle.getPropertyValue('--prog'), '0%', 'detached playback progress is reset');
assert.equal(audioCard.playing, false, 'detached playing state is reset');

// Pointer activation expands the historical card into the current postcard
// using a short, interruptible transform. The source is restored on either
// completion or cancellation, so a fast close never leaves a hole in Atlas.
let classicFrames = null;
const classicSheet = {
  getBoundingClientRect() { return { left: 220, top: 100, width: 800, height: 500 }; },
  animate(frames, options) {
    classicFrames = { frames, options };
    return { onfinish: null, oncancel: null, cancel() {} };
  },
};
const classicModal = {
  classList: classes('is-positioned', 'is-blurring'),
};
const classicSource = { style: { opacity: '' } };
const classicMotionContext = {
  activeClassicPostcardAnimation: null,
  activeClassicPostcardSource: null,
  postcardModal: classicModal,
  postcardDrawerSheet() { return classicSheet; },
  revealPostcardShell() { throw new Error('measurable pointer motion should not fall back'); },
  window: { matchMedia() { return { matches: false }; } },
  getComputedStyle() { return { getPropertyValue() { return '.2deg'; } }; },
  requestAnimationFrame(callback) { callback(); },
};
vm.createContext(classicMotionContext);
vm.runInContext(`
  ${functionSource('releaseClassicPostcardMotion')}
  ${functionSource('finishClassicPostcardMotion')}
  ${functionSource('revealClassicPostcardShell')}
  this.reveal = revealClassicPostcardShell;
  this.release = releaseClassicPostcardMotion;
`, classicMotionContext);
classicMotionContext.reveal(classicSource,
  { left: 20, top: 40, width: 250, height: 280 }, true);
assert.equal(classicFrames.options.duration, 260, 'Classic expansion stays below the 300ms UI-motion ceiling');
assert.equal(classicFrames.options.easing, 'cubic-bezier(.23,1,.32,1)', 'Classic expansion starts responsively with a strong ease-out');
assert.match(classicFrames.frames[0].transform, /translate3d\([^)]*\) scale\([^)]*\) rotate\(0\.2deg\)/,
  'Classic expansion begins at the clicked card geometry');
assert.match(classicFrames.frames[1].transform, /translate3d\(0,0,0\) scale\(1,1\) rotate\(0\.2deg\)/,
  'Classic expansion lands on the natural postcard transform');
assert.equal(classicSource.style.opacity, '0', 'the source card cannot double-paint beneath the expanding postcard');
assert.equal(classicModal.classList.contains('is-open'), true, 'the postcard is interactive throughout the shared transition');
classicMotionContext.activeClassicPostcardAnimation.onfinish();
assert.equal(classicSource.style.opacity, '0', 'completion keeps the obscured source hidden behind the open postcard');
assert.equal(classicModal.classList.contains('is-classic-entering'), false, 'completion removes the temporary transition owner');
classicMotionContext.release();
assert.equal(classicSource.style.opacity, '', 'close or replacement restores the Classic Atlas source');
classicSheet.animate = undefined;
classicMotionContext.window.matchMedia = () => ({ matches: true });
classicMotionContext.reveal(classicSource,
  { left: 20, top: 40, width: 250, height: 280 }, true);
assert.equal(classicSource.style.opacity, '', 'reduced motion never hides or moves the Classic source card');
assert.equal(classicModal.classList.contains('is-open'), true, 'reduced motion still publishes the postcard state immediately');

assert.match(functionSource('openClassicPostcard'), /setPostcardAtlasSource\('classic'\)[\s\S]*populatePostcard[\s\S]*preparePostcardShell[\s\S]*revealClassicPostcardShell/,
  'Classic cards enter the current postcard directly instead of round-tripping through the hash router');
assert.match(apt, /classic-atlas-card[\s\S]{0,180}openClassicPostcard\(card, \{ animate: ev\.detail !== 0 \}\)/,
  'pointer clicks animate while keyboard-generated clicks skip spatial travel');
assert.match(functionSource('closePostcard'), /releasePostcardFlight\(\);[\s\S]*releaseClassicPostcardMotion\(\);/,
  'closing during expansion cancels both shared-element motion paths safely');
assert.match(css, /#postcard-modal\.is-classic-entering \.postcard-sheet \{ transition: none; \}/,
  'Classic WAAPI motion has one transform owner and cannot fight the sheet CSS transition');

// Classic deep links open the current postcard without carrying a stamp into
// the reserved corner from an earlier stamp-mode visit.
let slotClears = 0;
const postcardSlot = { replaceChildren() { slotClears += 1; } };
const postcardModal = {
  attrs: {},
  setAttribute(name, value) { this.attrs[name] = String(value); },
  querySelector(selector) { return selector === '.postcard-stamp-slot' ? postcardSlot : null; },
};
const postcardContext = {
  postcardModal,
  postcardSlot,
  document: { getElementById() { return postcardModal; } },
};
vm.createContext(postcardContext);
vm.runInContext(`${functionSource('setPostcardAtlasSource')}; this.setSource = setPostcardAtlasSource;`, postcardContext);
postcardContext.setSource('classic');
assert.equal(postcardModal.attrs['data-atlas-source'], 'classic', 'Classic postcards publish their source mode');
assert.equal(slotClears, 1, 'Classic postcards clear any previously landed stamp');
postcardContext.setSource('stamps');
assert.equal(postcardModal.attrs['data-atlas-source'], 'stamps', 'stamp postcards restore the current source mode');

assert.match(css, /#postcard-modal\[data-atlas-source="classic"\] \.postcard-stamp-slot \{ display: none; \}/,
  'Classic postcards hide the stamp corner');
assert.match(css, /#postcard-modal\[data-atlas-source="classic"\] \.postcard-identity[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
  'Classic postcards reclaim the stamp column without reverting the expanded layout');
assert.match(css, /#atlasGrid\[data-layout="classic"\][\s\S]*?repeat\(auto-fill, minmax\(240px, 1fr\)\)/,
  'Classic mode restores the historical responsive desktop grid');
assert.match(css, /#atlasGrid\[data-layout="classic"\][\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/,
  'Classic mode restores the historical two-up mobile grid');
assert.match(html, /styles\.css\?v=r196/, 'Classic Atlas styles have a fresh cache key');
assert.match(html, /apt\.js\?v=r235/, 'Classic Atlas and admin recovery behavior have a fresh cache key');

console.log('classic Atlas smoke: ok');
