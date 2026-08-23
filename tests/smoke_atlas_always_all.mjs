#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../avian/frontend/apt.js', import.meta.url), 'utf8');

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
const writes = [];
let syncCount = 0;
const context = {
  currentHours: 24,
  readLS(key, fallback) { return store.get(key) || fallback; },
  writeLS(key, value) { store.set(key, value); writes.push([key, value]); },
  syncAtlasAlwaysAll() { syncCount += 1; },
};
vm.createContext(context);
vm.runInContext(`
  var ATLAS_ALWAYS_ALL_KEY = 'bird:atlasAlwaysAll:v1';
  var sessionAtlasAlwaysAll = null;
  ${functionSource('atlasAlwaysAll')}
  ${functionSource('atlasWindowHours')}
  ${functionSource('applyAtlasAlwaysAll')}
  this.preference = { atlasAlwaysAll, atlasWindowHours, applyAtlasAlwaysAll };
`, context);

assert.equal(context.preference.atlasAlwaysAll(), false, 'fresh browsers follow the shared window');
assert.equal(context.preference.atlasWindowHours(), 24, 'default preserves the current 24-hour Atlas');

store.set('bird:atlasAlwaysAll:v1', 'on');
vm.runInContext('sessionAtlasAlwaysAll = null', context);
assert.equal(context.preference.atlasAlwaysAll(), true, 'saved on preference restores');
assert.equal(context.preference.atlasWindowHours(), 1000000, 'on resolves Atlas to ALL');

store.set('bird:atlasAlwaysAll:v1', 'unexpected');
vm.runInContext('sessionAtlasAlwaysAll = null', context);
context.currentHours = 168;
assert.equal(context.preference.atlasAlwaysAll(), false, 'invalid storage fails closed');
assert.equal(context.preference.atlasWindowHours(), 168, 'invalid storage leaves the shared window alone');

context.preference.applyAtlasAlwaysAll(true);
assert.deepEqual(writes.at(-1), ['bird:atlasAlwaysAll:v1', 'on'], 'toggle persists on');
assert.equal(context.preference.atlasWindowHours(), 1000000, 'toggle applies immediately');
context.preference.applyAtlasAlwaysAll(false);
assert.deepEqual(writes.at(-1), ['bird:atlasAlwaysAll:v1', 'off'], 'toggle persists off');
assert.equal(context.preference.atlasWindowHours(), 168, 'turning it off restores, not replaces, the shared window');
assert.equal(syncCount, 2, 'each toggle performs one Atlas-only sync');

const renderStart = source.indexOf('function renderAtlas(');
const renderEnd = source.indexOf('\n  var atlasResizeFrame', renderStart);
const renderAtlas = source.slice(renderStart, renderEnd);
assert.match(renderAtlas, /var atlasHours = atlasWindowHours\(\)/, 'Atlas resolves its own effective window');
assert.doesNotMatch(renderAtlas, /currentHours/, 'Atlas rendering no longer reads the shared window directly');
assert.match(renderAtlas, /var isAllWindow = atlasHours >= 1000000/, 'ALL controls filtering');
assert.match(renderAtlas, /var statRows = isAllWindow/, 'ALL controls card count copy');

assert.match(source, /Always show full atlas/, 'Settings copy is present');
assert.match(source, /show every unlocked stamp/, 'Settings explains the result');
assert.match(source, /\.switch:not\(\[data-atlas-always-all\]\)/,
  'client preference is excluded from Pi config autosave');
assert.match(source, /var forHours = currentHours;/, 'collage and stats requests still use the shared window');

console.log('atlas always-all smoke: ok');
