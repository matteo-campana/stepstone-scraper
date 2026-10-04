// Test del service worker (background.js) in un contesto vm con chrome.* e importScripts simulati.
// Uso: cd extension/test && node background.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** Carica background.js; `tabUrl` = URL della scheda attiva (null = nessuna scheda). */
function boot({ tabUrl, store = {}, tabSendFails = false }) {
  const listeners = { installed: null, message: null };
  const sentToTab = [];
  const injected = [];
  const ctx = {
    console, URL,
    chrome: {
      runtime: {
        onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
        onMessage: { addListener: (fn) => { listeners.message = fn; } }
      },
      storage: { local: {
        get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
        set: async (o) => Object.assign(store, o),
        remove: async (keys) => [].concat(keys).forEach((k) => delete store[k])
      } },
      tabs: {
        query: async () => (tabUrl ? [{ id: 7, url: tabUrl }] : []),
        sendMessage: async (id, msg) => {
          sentToTab.push({ id, msg: JSON.parse(JSON.stringify(msg)) });
          if (tabSendFails && !injected.length) throw new Error('Receiving end does not exist');
          return { ok: true, echoed: msg.type };
        }
      },
      scripting: {
        executeScript: async (o) => { injected.push([...o.files]); },
        insertCSS: async () => {}
      }
    },
    importScripts: (...files) => files.forEach((f) => vm.runInContext(read(f), ctx))
  };
  vm.createContext(ctx);
  vm.runInContext(read('background.js'), ctx);
  const send = (msg) => new Promise((resolve) => {
    const async = listeners.message(msg, {}, (r) => resolve(r === undefined ? r : JSON.parse(JSON.stringify(r)))); // JSON: oggetti di un altro realm
    if (!async) resolve(undefined);
  });
  return { ctx, listeners, store, sentToTab, injected, send };
}

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

(async () => {
  await test('ACTIVE_SITE: riconosce StepStone e TotalJobs, null per altri host o nessuna scheda', async () => {
    assert.deepEqual(await boot({ tabUrl: 'https://www.totaljobs.com/jobs/x' }).send({ type: 'ACTIVE_SITE' }), { ok: true, host: 'www.totaljobs.com', siteId: 'totaljobs' });
    assert.equal((await boot({ tabUrl: 'https://www.stepstone.nl/vacatures' }).send({ type: 'ACTIVE_SITE' })).siteId, 'stepstone');
    const other = await boot({ tabUrl: 'https://example.com/' }).send({ type: 'ACTIVE_SITE' });
    assert.deepEqual(other, { ok: true, host: 'example.com', siteId: null });
    assert.deepEqual(await boot({ tabUrl: null }).send({ type: 'ACTIVE_SITE' }), { ok: true, host: '', siteId: null });
  });

  await test('ACTIVE_SITE non viene inoltrato alla scheda', async () => {
    const b = boot({ tabUrl: 'https://www.totaljobs.com/jobs/x' });
    await b.send({ type: 'ACTIVE_SITE' });
    assert.equal(b.sentToTab.length, 0);
  });

  await test('START_SCRAPE su TotalJobs: inoltrato come SCRAPE', async () => {
    const b = boot({ tabUrl: 'https://www.totaljobs.com/jobs/dynamics-365?page=2' });
    const res = await b.send({ type: 'START_SCRAPE', options: { concurrency: 3 } });
    assert.equal(res.ok, true);
    assert.equal(b.sentToTab[0].msg.type, 'SCRAPE');
    assert.deepEqual(b.sentToTab[0].msg.options, { concurrency: 3 });
  });

  await test('START_SCRAPE su host non supportati: WRONG_DOMAIN, nessun inoltro', async () => {
    for (const url of ['https://example.com/', 'https://www.totaljobs.com.evil.example/', 'https://www.stepstone.ch/jobs', 'chrome://extensions']) {
      const b = boot({ tabUrl: url });
      assert.deepEqual(await b.send({ type: 'START_SCRAPE' }), { ok: false, error: 'WRONG_DOMAIN' }, url);
      assert.equal(b.sentToTab.length, 0, url);
    }
    assert.deepEqual(await boot({ tabUrl: null }).send({ type: 'START_SCRAPE' }), { ok: false, error: 'NO_TAB' });
  });

  await test('content script assente: inietta selectors.js, sites.js, … nell\'ordine giusto e riprova', async () => {
    const b = boot({ tabUrl: 'https://www.totaljobs.com/jobs/x', tabSendFails: true });
    const res = await b.send({ type: 'PING' });
    assert.equal(res.ok, true);
    assert.deepEqual(b.injected[0], ['selectors.js', 'sites.js', 'match.js', 'companies.js', 'content.js']);
    assert.equal(b.sentToTab.length, 2);
  });

  await test('i file iniettati coincidono con content_scripts del manifest', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const src = read('background.js');
    const m = src.match(/CONTENT_FILES = (\[[^\]]*\])/);
    assert.deepEqual(eval(m[1]), manifest.content_scripts[0].js);
  });

  await test('onInstalled: default di profilo/opzioni e migrazione delle chiavi a slot unico', async () => {
    const b = boot({ tabUrl: null, store: {
      lastResults: { jobs: [], meta: { pageUrl: 'https://www.stepstone.fr/emploi' } },
      scrapeState: { status: 'done' }
    } });
    await b.listeners.installed({ reason: 'update' });
    assert.ok(b.store.profile && b.store.options);
    assert.equal('lastResults' in b.store, false);
    assert.equal(b.store['results:stepstone'].meta.siteId, 'stepstone');
    assert.deepEqual(b.store['scrapeState:stepstone'], { status: 'done' });
  });

  await test('onInstalled non sovrascrive profilo e opzioni esistenti', async () => {
    const b = boot({ tabUrl: null, store: { profile: { skills: 'x' }, options: { concurrency: 9 } } });
    await b.listeners.installed({ reason: 'update' });
    assert.deepEqual(b.store.profile, { skills: 'x' });
    assert.deepEqual(b.store.options, { concurrency: 9 });
  });

  console.log(`\n${n} test del service worker passati`);
})().catch((e) => { console.error(e); process.exit(1); });
