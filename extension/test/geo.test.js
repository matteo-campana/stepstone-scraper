// Test di geo.js (puro, senza jsdom): coordinate locali, alias, merge tra siti, spirale, tabella.
// Uso: cd extension/test && node geo.test.js
const assert = require('node:assert/strict');
const path = require('node:path');
const EXT = path.join(__dirname, '..');
const G = require(path.join(EXT, 'geo.js'));
const TABLE = require(path.join(EXT, 'cities.json'));

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ✓', name); };

test('città esatta → coordinate, approx false', () => {
  const p = G.locate('Berlin', 'Germania', TABLE);
  assert.deepEqual(p, { lat: 52.52, lon: 13.405, approx: false });
});

test('maiuscole, diacritici e alias (MÜNCHEN, Munich, Koln, Cologne)', () => {
  const muc = G.locate('Munich', '', TABLE);
  assert.equal(G.locate('MÜNCHEN', '', TABLE).lat, muc.lat);
  assert.equal(G.locate('München', '', TABLE).lat, muc.lat);
  assert.equal(G.locate('Koln', '', TABLE).lat, G.locate('Cologne', '', TABLE).lat);
  assert.equal(G.locate('Cologne', '', TABLE).approx, false);
});

test('suffisso "bei …" e tra parentesi → città base', () => {
  assert.equal(G.locate('Garching bei München', '', TABLE).approx, false);
  assert.equal(G.locate('Alba (Cuneo)', '', TABLE).approx, false);
  assert.equal(G.locate('Roma, Lazio', '', TABLE).approx, false);
});

test('città sconosciuta → centro del Paese con approx true', () => {
  const p = G.locate('Atlantis', 'Germania', TABLE);
  assert.equal(p.approx, true);
  assert.ok(isNum(p.lat) && isNum(p.lon));
});

test('città sconosciuta e Paese sconosciuto → null', () => {
  assert.equal(G.locate('Atlantis', 'Narnia', TABLE), null);
  assert.equal(G.locate('', '', TABLE), null);
});

test('"città" che è in realtà un Paese → centroide', () => {
  assert.equal(G.locate('Germania', '', TABLE).approx, true);
});

test('normKey: minuscolo, senza diacritici, ß → ss', () => {
  assert.equal(G.normKey('  Düsseldorf  Süd '), 'dusseldorf sud');
  assert.equal(G.normKey('Straße'), 'strasse');
});

test('spirale: k=1 invariato, k>1 spostato di poco e sempre distinto', () => {
  assert.deepEqual(G.spiral(45, 9, 1), [45, 9]);
  const pts = [2, 3, 4, 5].map((k) => G.spiral(45, 9, k));
  for (const [la, lo] of pts) {
    assert.ok(Math.abs(la - 45) < 0.01 && Math.abs(lo - 9) < 0.02);
  }
  assert.equal(new Set(pts.map((p) => p.join(','))).size, pts.length);
});

test('place: "Città, Paese", solo Paese se città vuota o uguale', () => {
  assert.equal(G.place({ city: 'Berlin', country: 'Germania' }), 'Berlin, Germania');
  assert.equal(G.place({ city: '', country: 'Germania' }), 'Germania');
  assert.equal(G.place({ city: 'Germania', country: 'Germania' }), 'Germania');
});

const stepstone = { id: 'stepstone', label: 'StepStone' };
const linkedin = { id: 'linkedin', label: 'LinkedIn' };
const job = (company, extra = {}) => ({
  company, title: 'Dev ' + company, location: 'Berlin', url: 'https://x.test/' + company, match: { score: 60 }, ...extra
});

test('merge: stessa azienda su StepStone e LinkedIn → una riga, due fonti, annunci sommati', () => {
  const rows = G.mergeSites([
    { site: stepstone, host: 'www.stepstone.de', jobs: [
      job('Bechtle AG', { companyId: '111', match: { score: 70 } }),
      job('Bechtle AG', { companyId: '111', match: { score: 40 } })
    ] },
    { site: linkedin, host: 'www.linkedin.com', jobs: [
      job('Bechtle AG', { companyId: '', match: { score: 85 }, companyUrl: 'https://www.linkedin.com/company/bechtle/' })
    ] }
  ]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual(r.sources, ['StepStone', 'LinkedIn']);
  assert.equal(r.jobs, 3);
  assert.equal(r.maxScore, 85);
  assert.equal(r.jobList.length, 3);
  assert.equal(r.linkedin, 'https://www.linkedin.com/company/bechtle/');
});

test('merge: aziende diverse restano separate e ordinate per nome', () => {
  const rows = G.mergeSites([{ site: stepstone, host: 'www.stepstone.de', jobs: [job('Zeta GmbH'), job('Alpha SE')] }]);
  assert.deepEqual(rows.map((r) => r.name), ['Alpha SE', 'Zeta GmbH']);
  assert.deepEqual(rows[0].sources, ['StepStone']);
});

test('cities.json: chiavi già normalizzate e coordinate valide', () => {
  for (const group of ['cities', 'countries']) {
    for (const [k, p] of Object.entries(TABLE[group])) {
      assert.equal(G.normKey(k), k, `chiave non normalizzata: ${k}`);
      assert.ok(Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]), `coordinate invalide: ${k}`);
      assert.ok(Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180, `fuori range: ${k}`);
    }
  }
  assert.ok(Object.keys(TABLE.cities).length > 100);
});

console.log(`geo.test.js: ${n} test OK`);
