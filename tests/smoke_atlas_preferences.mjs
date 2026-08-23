#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../avian/frontend/index.html', import.meta.url), 'utf8');
const stampsCss = fs.readFileSync(new URL('../avian/frontend/stamps.css', import.meta.url), 'utf8');

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is present`);
  const body = source.indexOf('{', start);
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no closing brace`);
}

const store = new Map();
let renderCount = 0;
let overflowCount = 0;
let fullAtlasSyncCount = 0;
const context = {
  currentHours: 24,
  readLS(key, fallback) { return store.get(key) || fallback; },
  writeLS(key, value) { store.set(key, value); },
  renderAtlas() { renderCount += 1; },
  queueAtlasOverflowState() { overflowCount += 1; },
  syncAtlasAlwaysAll() { fullAtlasSyncCount += 1; },
};
vm.createContext(context);
vm.runInContext(`
  var ATLAS_ARTWORK_STORAGE_KEY = 'bird:atlasArtwork:v1';
  var ATLAS_ALWAYS_ALL_KEY = 'bird:atlasAlwaysAll:v1';
  var sessionAtlasAlwaysAll = null;
  ${functionSource('atlasArtworkPreference')}
  ${functionSource('applyAtlasArtwork')}
  ${functionSource('atlasAlwaysAll')}
  ${functionSource('atlasWindowHours')}
  ${functionSource('applyAtlasAlwaysAll')}
  this.preferences = {
    atlasArtworkPreference, applyAtlasArtwork,
    atlasAlwaysAll, atlasWindowHours, applyAtlasAlwaysAll
  };
`, context);

assert.match(index, /id="atlasArtwork"/, 'Atlas offers the artwork control');
assert.match(index, /data-atlas-artwork="cutouts"/, 'Atlas artwork control includes cutouts');
assert.match(stampsCss, /\.atlas-grid\[data-artwork="cutouts"\]/,
  'cutouts restore the responsive Atlas grid');

assert.equal(context.preferences.atlasArtworkPreference(), 'stamps', 'artwork defaults to stamps');
assert.equal(context.preferences.atlasAlwaysAll(), false, 'full atlas defaults off');
assert.equal(context.preferences.atlasWindowHours(), 24, 'default Atlas follows the shared window');

context.preferences.applyAtlasArtwork('cutouts');
assert.equal(store.get('bird:atlasArtwork:v1'), 'cutouts', 'cutout selection persists');
assert.equal(context.preferences.atlasArtworkPreference(), 'cutouts', 'cutout selection restores');
assert.equal(renderCount, 1, 'changing artwork rerenders the Atlas');
assert.equal(overflowCount, 1, 'changing artwork refreshes overflow state');

context.preferences.applyAtlasAlwaysAll(true);
assert.equal(context.preferences.atlasArtworkPreference(), 'cutouts', 'full-list preference leaves artwork untouched');
assert.equal(context.preferences.atlasWindowHours(), 1000000, 'full-list preference resolves Atlas to ALL');
assert.equal(fullAtlasSyncCount, 1, 'full-list preference performs one Atlas-only sync');

context.preferences.applyAtlasAlwaysAll(false);
context.currentHours = 168;
assert.equal(context.preferences.atlasArtworkPreference(), 'cutouts', 'turning full-list off preserves artwork');
assert.equal(context.preferences.atlasWindowHours(), 168, 'turning full-list off restores the shared window');

const renderStart = source.indexOf('function renderAtlas(');
const renderEnd = source.indexOf('\n  var atlasResizeFrame', renderStart);
const renderAtlasSource = source.slice(renderStart, renderEnd);
assert.match(renderAtlasSource, /var atlasHours = atlasWindowHours\(\)/,
  'rendering resolves an Atlas-specific window');
assert.doesNotMatch(renderAtlasSource, /currentHours/,
  'rendering does not bypass the Atlas-specific window');
const imageCardStart = source.indexOf('function atlasImageCardMarkup(');
const imageCardEnd = source.indexOf('\n  function renderAtlas(', imageCardStart);
const imageCardSource = source.slice(imageCardStart, imageCardEnd);
assert.match(imageCardSource, /atlasHours/,
  'cutout cards receive the Atlas-specific window');
assert.doesNotMatch(imageCardSource, /currentHours/,
  'cutout cards do not bypass the Atlas-specific window');

console.log('atlas combined-preferences smoke: ok');
