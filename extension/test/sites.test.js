// Test del registro dei siti (sites.js). Non servono le pagine di esempio.
// Uso: cd extension/test && node sites.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Sites = require('../sites.js');
const BASE = require('../selectors.js');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ✓ ' + name); }, (e) => { console.error('  ✗ ' + name); throw e; });
}

(async () => {
  await test('forHost: riconosce tutti gli host supportati', () => {
    for (const h of ['de', 'at', 'be', 'nl', 'fr']) assert.equal(Sites.forHost('www.stepstone.' + h).id, 'stepstone');
    assert.equal(Sites.forHost('www.totaljobs.com').id, 'totaljobs');
    assert.equal(Sites.forUrl('https://www.totaljobs.com/jobs/x?page=2').id, 'totaljobs');
  });

  await test('forHost: scarta host non supportati o ingannevoli', () => {
    for (const h of ['www.stepstone.ch', 'stepstone.de', 'uk.totaljobs.com', 'totaljobs.com',
      'www.totaljobs.com.evil.example', 'www.stepstone.de.evil.example', '', undefined, null]) {
      assert.equal(Sites.forHost(h), null, String(h));
    }
    assert.equal(Sites.forUrl('not a url'), null);
  });

  await test('mergeSelectors: non muta la base e [] è un override valido', () => {
    const before = JSON.stringify(BASE);
    const tj = Sites.byId('totaljobs');
    assert.equal(JSON.stringify(BASE), before);
    assert.deepEqual(tj.selectors.results.remote, []);
    assert.deepEqual(tj.selectors.results.badges, []);
    assert.deepEqual(tj.selectors.results.salary[0], '[data-at="job-item-salary-info"]');
    assert.deepEqual(Sites.byId('stepstone').selectors.results, BASE.results);
    assert.deepEqual(tj.selectors.results.title, BASE.results.title); // campi non toccati ereditati
  });

  await test('estrattori di ID per sito', () => {
    const ss = Sites.byId('stepstone'), tj = Sites.byId('totaljobs');
    assert.equal(ss.companyIdFromUrl('https://www.stepstone.de/cmp/de/yoummday-gmbh-217684/jobs'), '217684');
    assert.equal(ss.jobIdFromUrl('https://www.stepstone.de/stellenangebote--X--14556359-inline.html'), '14556359');
    assert.equal(tj.companyIdFromUrl('https://www.totaljobs.com/jobs/cadence-resourcing-limited?cmpId=1389546&cmp=1'), '1389546');
    assert.equal(tj.jobIdFromUrl('/job/technical-lead-d365/cadence-resourcing-limited-job108060738'), '108060738');
    // i pattern non si confondono tra siti
    assert.equal(tj.jobIdFromUrl('https://www.stepstone.de/x--14556359-inline.html'), '');
    assert.equal(ss.jobIdFromUrl('/job/x/y-job108060738'), '');
    assert.equal(ss.companyIdFromUrl('https://www.totaljobs.com/jobs/x?cmpId=1'), '');
  });

  await test('paese per sito', () => {
    assert.equal(Sites.byId('stepstone').country('www.stepstone.at'), 'AT');
    assert.equal(Sites.byId('totaljobs').country('www.totaljobs.com'), 'GB');
  });

  await test('chiavi di storage per sito', () => {
    assert.equal(Sites.resultsKey('totaljobs'), 'results:totaljobs');
    assert.equal(Sites.stateKey(Sites.byId('stepstone')), 'scrapeState:stepstone');
    assert.deepEqual(Sites.allCacheKeys().sort(),
      ['results:stepstone', 'results:totaljobs', 'scrapeState:stepstone', 'scrapeState:totaljobs']);
  });

  await test('manifest ⟷ registro: stessi host in host_permissions e content_scripts', () => {
    const fromRegistry = Sites.SITES.flatMap((s) => s.matches).sort();
    assert.deepEqual([...manifest.host_permissions].sort(), fromRegistry);
    assert.deepEqual([...manifest.content_scripts[0].matches].sort(), fromRegistry);
    for (const m of fromRegistry) {
      const host = new URL(m.replace('/*', '/')).hostname;
      assert.ok(Sites.forHost(host), host);
    }
  });

  await test('manifest: sites.js caricato dopo selectors.js e prima di content.js', () => {
    const js = manifest.content_scripts[0].js;
    assert.ok(js.indexOf('selectors.js') < js.indexOf('sites.js'));
    assert.ok(js.indexOf('sites.js') < js.indexOf('content.js'));
  });

  await test('migrateFlatKeys: sposta, marca il sito, è idempotente', async () => {
    const store = {
      lastResults: { jobs: [{ id: '1' }], meta: { pageUrl: 'https://www.stepstone.at/jobs/x' } },
      scrapeState: { status: 'done' }, profile: { skills: 'a' }
    };
    const area = {
      get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
      set: async (o) => Object.assign(store, o),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k])
    };
    assert.equal(await Sites.migrateFlatKeys(area), true);
    assert.equal('lastResults' in store, false);
    assert.equal('scrapeState' in store, false);
    assert.equal(store['results:stepstone'].meta.siteId, 'stepstone');
    assert.deepEqual(store['scrapeState:stepstone'], { status: 'done' });
    assert.deepEqual(store.profile, { skills: 'a' });
    const snapshot = JSON.stringify(store);
    assert.equal(await Sites.migrateFlatKeys(area), false);
    assert.equal(JSON.stringify(store), snapshot);
  });

  await test('migrateFlatKeys: storage vuoto = nessuna operazione', async () => {
    const area = { get: async () => ({}), set: async () => { throw new Error('no'); }, remove: async () => { throw new Error('no'); } };
    assert.equal(await Sites.migrateFlatKeys(area), false);
  });

  console.log(`\n${passed} test del registro siti passati`);
})().catch((e) => { console.error(e); process.exit(1); });
