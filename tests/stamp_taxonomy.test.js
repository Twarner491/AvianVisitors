const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const sandbox = {
  document: { documentElement: { setAttribute() {} } },
  window: { addEventListener() {} },
  requestAnimationFrame() {},
};
for (const file of ['stamps.js', 'stamp-batch-root.js']) {
  vm.runInNewContext(fs.readFileSync(
    path.join(__dirname, '../avian/frontend', file), 'utf8'
  ), sandbox);
}
const stamps = sandbox.window.STAMPS;

test('reported species use biological families without changing visual issues', () => {
  for (const [sci, latin, group, style] of [
    ['Falco tinnunculus', 'Falconidae', 'Hawks', 'raptor'],
    ['Tyto alba', 'Tytonidae', 'Owls', 'opart'],
    ['Sturnus vulgaris', 'Sturnidae', 'Blackbirds & Orioles', 'dither'],
    ['Passer domesticus', 'Passeridae', 'Sparrows', 'sparrowGuide'],
  ]) {
    assert.equal(stamps.latinOf(sci), latin, sci);
    assert.equal(stamps.familyOf(sci), group, sci);
    assert.equal(stamps.styleFor(sci).id, style, sci);
  }
});

test('every mixed visual group keeps distinct biological families', () => {
  for (const [sci, latin] of [
    ['Bubo virginianus', 'Strigidae'], ['Tyto alba', 'Tytonidae'],
    ['Buteo jamaicensis', 'Accipitridae'], ['Cathartes aura', 'Cathartidae'],
    ['Pandion haliaetus', 'Pandionidae'], ['Falco tinnunculus', 'Falconidae'],
    ['Larus argentatus', 'Laridae'], ['Charadrius vociferus', 'Charadriidae'],
    ['Actitis macularius', 'Scolopacidae'], ['Himantopus mexicanus', 'Recurvirostridae'],
    ['Pelecanus occidentalis', 'Pelecanidae'], ['Nannopterum auritum', 'Phalacrocoracidae'],
    ['Zonotrichia leucophrys', 'Passerellidae'], ['Passer domesticus', 'Passeridae'],
    ['Bombycilla cedrorum', 'Bombycillidae'], ['Phainopepla nitens', 'Ptiliogonatidae'],
    ['Agelaius phoeniceus', 'Icteridae'], ['Sturnus vulgaris', 'Sturnidae'],
    ['Poecile atricapillus', 'Paridae'], ['Psaltriparus minimus', 'Aegithalidae'],
    ['Sitta carolinensis', 'Sittidae'], ['Troglodytes aedon', 'Troglodytidae'],
    ['Regulus satrapa', 'Regulidae'], ['Chamaea fasciata', 'Paradoxornithidae'],
    ['Setophaga petechia', 'Parulidae'], ['Vireo gilvus', 'Vireonidae'],
    ['Cardinalis cardinalis', 'Cardinalidae'], ['Colaptes auratus', 'Picidae'],
    ['Callipepla californica', 'Odontophoridae'],
  ]) assert.equal(stamps.latinOf(sci), latin, sci);
});

test('homogeneous visual groups retain their verified biological families', () => {
  for (const [sci, latin] of [
    ['Calypte anna', 'Trochilidae'], ['Corvus corax', 'Corvidae'],
    ['Ardea herodias', 'Ardeidae'], ['Anas platyrhynchos', 'Anatidae'],
    ['Haemorhous mexicanus', 'Fringillidae'], ['Zenaida macroura', 'Columbidae'],
    ['Turdus migratorius', 'Turdidae'], ['Sayornis nigricans', 'Tyrannidae'],
    ['Mimus polyglottos', 'Mimidae'], ['Megaceryle alcyon', 'Alcedinidae'],
    ['Tringa melanoleuca', 'Scolopacidae'], ['Limnodromus scolopaceus', 'Scolopacidae'],
    ['Stelgidopteryx serripennis', 'Hirundinidae'], ['Certhia americana', 'Certhiidae'],
  ]) assert.equal(stamps.latinOf(sci), latin, sci);
});

test('unknown and unverified genera never inherit a visual-group family', () => {
  for (const sci of ['', null, 'Futuregenus example', 'Zenaidura macroura', 'constructor']) {
    assert.equal(stamps.latinOf(sci), '', String(sci));
  }
});

test('rendered taxonomic caption uses biology while keeping visual group metadata', () => {
  const html = stamps.markup(
    {sci: 'Sturnus vulgaris', com: 'Common Starling', index: 1}, './starling.png',
    {id: 'taxonomy-test', ar: 1, html: '<span>{{ORDER}}</span>'}
  );
  assert.match(html, /<span>Sturnidae<\/span>/);
  assert.match(html, /data-family="Blackbirds &amp; Orioles"/);
});

test('raptor artwork does not mislabel falcons with a hardcoded hawk family', () => {
  for (const [sci, com, family] of [
    ['Falco tinnunculus', 'Common Kestrel', 'Falconidae'],
    ['Buteo jamaicensis', 'Red-tailed Hawk', 'Accipitridae'],
  ]) {
    const html = stamps.markup({sci, com, index: 1}, './raptor.png');
    assert.match(html, new RegExp('<div class="hi-field-copy"><b>' + family + '</b>'));
    if (family === 'Falconidae') assert.doesNotMatch(html, /Accipitridae/i);
    assert.match(html, /data-style="raptor"/);
  }
});
