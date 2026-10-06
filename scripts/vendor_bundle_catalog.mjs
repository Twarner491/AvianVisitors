#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repo, 'avian/frontend/assets/bundle-catalog');
const check = process.argv.includes('--check');
const sourceArg = process.argv.slice(2).find((arg) => arg !== '--check');
const source = path.resolve(sourceArg || process.env.BUNDLE_SITE_PUBLIC || path.join(repo, 'assembled/site/public'));
const previewPrefix = '/assets/bundle-catalog/bundle-previews/';

function read(relative) {
  return fs.readFileSync(path.join(source, relative));
}

function text(relative) {
  return read(relative).toString('utf8');
}

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function rebasePreviewPaths(value) {
  return value.replaceAll('/bundle-previews/', previewPrefix);
}

function frameHtml(value) {
  let next = value
    .replaceAll('href="/fonts/', 'href="./fonts/')
    .replaceAll('src="/bundle-theme.js', 'src="./bundle-theme.js')
    .replaceAll('href="/site.css"', 'href="./site.css"')
    .replaceAll('href="/bundle-collage.css?v=20260904a"', 'href="./bundle-collage.css?v=20260904a"')
    .replaceAll('href="/bundles.css', 'href="./bundles.css')
    .replaceAll('src="/bundle-collage.js?v=20260904a"', 'src="./bundle-collage.js?v=20260904a"')
    .replaceAll('src="/bundles.js', 'src="./bundles.js');
  next = next.replace(
    '<script src="./bundle-collage.js?v=20260904a" defer></script>',
    '<script src="./catalog-snapshot.js"></script>\n<script src="./geometry-snapshot.js"></script>\n<script src="./bundle-collage.js?v=20260904a" defer></script>'
  );
  next = next.replace(
    '<a class="catalog-open-full" id="catalog-open-full" href="https://avianvisitors.com/bundles" target="_blank" rel="noopener" aria-label="Open full catalog" aria-describedby="catalog-open-full-tip">',
    '<span class="catalog-open-full catalog-open-full-placeholder" aria-hidden="true">'
  ).replace(
    '        <span class="catalog-open-full-tip" id="catalog-open-full-tip" role="tooltip">Open full catalog</span>\n      </a>',
    '        <span class="catalog-open-full-tip">Open full catalog</span>\n      </span>'
  );
  return next;
}

function frameCss(value) {
  return value
    .replaceAll('url("/fonts/', 'url("./fonts/')
    .replaceAll("url('/fonts/", "url('./fonts/")
    + '\nhtml.embed .catalog-open-full-placeholder { visibility: hidden; pointer-events: none; }\n';
}

function frameBundles(value) {
  let next = rebasePreviewPaths(value)
    .replace(
      '/^\\/bundle-previews\\/[a-z0-9._-]+\\.png$/',
      '/^\\/assets\\/bundle-catalog\\/bundle-previews\\/[a-z0-9._-]+\\.png$/'
    );
  return next;
}

function frameCollage(value) {
  return rebasePreviewPaths(value).replace(
    '/^\\/bundle-previews\\/[a-z0-9/_.-]+\\.png$/',
    '/^\\/assets\\/bundle-catalog\\/bundle-previews\\/[a-z0-9/_.-]+\\.png$/'
  );
}

function staticSnapshot(name, relative) {
  const parsed = JSON.parse(rebasePreviewPaths(text(relative)));
  return Buffer.from(`window.${name} = ${JSON.stringify(parsed)};\n`);
}

if (!fs.existsSync(path.join(source, 'bundles.html'))) {
  console.error(`Bundle catalog source was not found at ${source}`);
  process.exit(2);
}

const outputs = new Map([
  ['index.html', Buffer.from(frameHtml(text('bundles.html')))],
  ['bundles.css', Buffer.from(frameCss(text('bundles.css')))],
  ['bundles.js', Buffer.from(frameBundles(text('bundles.js')))],
  ['bundle-theme.js', read('bundle-theme.js')],
  ['bundle-collage.css', Buffer.from(frameCss(text('bundle-collage.css')))],
  ['bundle-collage.js', Buffer.from(frameCollage(text('bundle-collage.js')))],
  ['site.css', Buffer.from(frameCss(text('site.css')))],
  ['catalog-snapshot.js', staticSnapshot('AVIAN_BUNDLE_CATALOG_SNAPSHOT', 'catalog/bundles-v1.json')],
  ['geometry-snapshot.js', staticSnapshot('AVIAN_BUNDLE_PREVIEW_GEOMETRY', 'catalog/bundle-preview-geometry-v1.json')],
  ['catalog/bundles-v1.json', Buffer.from(rebasePreviewPaths(text('catalog/bundles-v1.json')))],
  ['catalog/bundle-preview-geometry-v1.json', Buffer.from(rebasePreviewPaths(text('catalog/bundle-preview-geometry-v1.json')))],
  ['fonts/JetBrainsMono-Regular.ttf', read('fonts/JetBrainsMono-Regular.ttf')],
  ['fonts/Caveat.ttf', read('fonts/Caveat.ttf')],
  ['fonts/OFL.txt', read('fonts/OFL.txt')],
  ['fonts/OFL-Caveat.txt', read('fonts/OFL-Caveat.txt')],
]);

const previewDir = path.join(source, 'bundle-previews');
function previewFiles(directory, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!/^[a-z0-9._-]+$/.test(entry.name) || entry.isSymbolicLink()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...previewFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith('.png')) files.push(relative);
  }
  return files;
}
const previewNames = previewFiles(previewDir);
for (const name of previewNames) {
  outputs.set(`bundle-previews/${name}`, fs.readFileSync(path.join(previewDir, name)));
}

const sourceFiles = [
  'bundles.html', 'bundles.css', 'bundles.js', 'bundle-theme.js', 'bundle-collage.css',
  'bundle-collage.js', 'site.css', 'catalog/bundles-v1.json',
  'catalog/bundle-preview-geometry-v1.json', 'fonts/JetBrainsMono-Regular.ttf', 'fonts/Caveat.ttf',
  'fonts/OFL.txt', 'fonts/OFL-Caveat.txt',
].concat(previewNames.map((name) => `bundle-previews/${name}`));

const manifest = {
  format: 'avian-station-vendored-bundle-catalog',
  format_version: 1,
  source_sha256: Object.fromEntries(sourceFiles.map((relative) => [relative, sha(read(relative))])),
  output_sha256: Object.fromEntries(Array.from(outputs, ([relative, bytes]) => [relative, sha(bytes)])),
  transformations: [
    'rebase static files beneath /assets/bundle-catalog',
    'load checked-in catalog and collage geometry as classic scripts for an opaque sandbox',
    'reserve the embed toolbar slot for the station-owned full-catalog link',
  ],
};
outputs.set('vendor-manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

let failures = 0;
for (const [relative, expected] of outputs) {
  const destination = path.join(target, relative);
  if (check) {
    if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(expected)) {
      console.error(`Vendored bundle catalog drift: ${relative}`);
      failures += 1;
    }
    continue;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, expected);
}

const expectedPreviews = new Set(Array.from(outputs.keys()).filter((name) => name.startsWith('bundle-previews/')));
const actualPreviews = fs.existsSync(path.join(target, 'bundle-previews'))
  ? previewFiles(path.join(target, 'bundle-previews')).map((name) => `bundle-previews/${name}`)
  : [];
const unexpectedPreviews = actualPreviews.filter((name) => !expectedPreviews.has(name));
if (check) {
  unexpectedPreviews.forEach((name) => {
    console.error(`Unexpected vendored bundle preview: ${name}`);
    failures += 1;
  });
} else {
  unexpectedPreviews.forEach((name) => fs.unlinkSync(path.join(target, name)));
}

if (failures) process.exit(1);
console.log(check ? 'Vendored bundle catalog matches its source.' : `Vendored bundle catalog from ${source}.`);
