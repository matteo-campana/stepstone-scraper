// Test del popup in jsdom con chrome.* simulato: pulsante "Pulisci cache".
// Uso: cd extension/test && node popup.test.js   (non servono le pagine StepStone)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const job = (id, title, company) => ({
  id, title, company, location: 'Berlin', remote: '', salary: '', url: `https://www.stepstone.de/x--${id}-inline.html`,
  match: { score: 80, matchedSkills: ['azure'], missingSkills: [] }
});

/** Apre il popup con uno storage iniziale e ritorna finestra, storage e messaggi inviati. */
async function openPopup(initial, { confirmAnswer = true } = {}) {
  const dom = new JSDOM(read('popup.html'), { runScripts: 'outside-only', url: 'chrome-extension://abc/popup.html' });
  const w = dom.window;
  w.TextEncoder = TextEncoder; // usato da xlsx.js

  const store = JSON.parse(JSON.stringify(initial));
  const listeners = [];
  const sent = [];
  const notify = (changes) => listeners.forEach((fn) => fn(changes, 'local'));

  w.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries([].concat(keys).map((k) => [k, store[k]])),
        set: async (o) => {
          const ch = {};
          for (const [k, v] of Object.entries(o)) { ch[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
          notify(ch);
        },
        remove: async (keys) => {
          const ch = {};
          for (const k of [].concat(keys)) if (k in store) { ch[k] = { oldValue: store[k] }; delete store[k]; }
          notify(ch);
        },
        getBytesInUse: async (keys) => [].concat(keys).reduce((n, k) => n + (k in store ? JSON.stringify(store[k]).length : 0), 0)
      },
      onChanged: { addListener: (fn) => listeners.push(fn) }
    },
    runtime: { sendMessage: async (m) => { sent.push(m); return { ok: true }; } }
  };
  w.confirm = () => confirmAnswer;

  ['match.js', 'companies.js', 'xlsx.js', 'popup.js'].forEach((f) => w.eval(read(f)));
  await tick();
  return { w, doc: w.document, store, sent, set: (o) => w.chrome.storage.local.set(o) };
}

const FULL = () => ({
  profile: { skills: 'azure, terraform', years: '5', position: 'Platform Engineer', salaryMin: '', salaryMax: '', locations: '', remote: false },
  options: { concurrency: 7, enrich: true, companyDetails: true, highlight: true },
  lastResults: {
    jobs: [job('1', 'Cloud Engineer', 'ACME'), job('2', 'Platform Engineer', 'Beta')],
    companies: [{ name: 'ACME', url: '', linkedin: '', business: 'Prodotto', businessDesc: '', country: 'Germania', city: 'Berlin', jobs: 1, maxScore: 80 }],
    meta: { pageUrl: 'https://www.stepstone.de/jobs/x', pagesScraped: [1, 1], pagesFailed: [], warnings: [], totalResults: 2 }
  },
  scrapeState: { status: 'done', text: '2 annunci estratti.', updatedAt: Date.now() }
});

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

(async () => {
  await test('mostra la dimensione della cache e i risultati salvati', async () => {
    const { doc } = await openPopup(FULL());
    assert.equal(doc.querySelector('#table tbody').rows.length, 2);
    assert.match(doc.getElementById('cacheSize').textContent, /^\(\d+ B\)$|KB/);
    assert.equal(doc.getElementById('btnClearCache').disabled, false);
  });

  await test('annullando la conferma non cambia nulla', async () => {
    const { doc, store, sent } = await openPopup(FULL(), { confirmAnswer: false });
    doc.getElementById('btnClearCache').click();
    await tick();
    assert.ok(store.lastResults && store.scrapeState);
    assert.equal(doc.querySelector('#table tbody').rows.length, 2);
    assert.equal(sent.length, 0);
  });

  await test('Pulisci cache: elimina risultati e stato, tiene profilo e opzioni', async () => {
    const { doc, store, sent } = await openPopup(FULL());
    doc.getElementById('btnClearCache').click();
    await tick();
    assert.equal('lastResults' in store, false);
    assert.equal('scrapeState' in store, false);
    assert.equal(store.profile.skills, 'azure, terraform');
    assert.equal(store.options.concurrency, 7);
    // interfaccia ripulita
    assert.equal(doc.querySelector('#table tbody').rows.length, 0);
    assert.equal(doc.querySelector('#tableCo tbody').rows.length, 0);
    assert.equal(doc.getElementById('summary').textContent, 'Nessun risultato.');
    assert.equal(doc.getElementById('cntJobs').textContent, '');
    assert.equal(doc.getElementById('cacheSize').textContent, '');
    assert.match(doc.getElementById('status').textContent, /Cache svuotata/);
    // badge rimossi dalla pagina
    assert.deepEqual(sent.map((m) => m.type), ['CLEAR_HIGHLIGHT']);
    // il profilo resta visibile nel form
    assert.equal(doc.getElementById('skills').value, 'azure, terraform');
  });

  await test('dopo la pulizia il popup riaperto parte vuoto ma col profilo', async () => {
    const first = await openPopup(FULL());
    first.doc.getElementById('btnClearCache').click();
    await tick();
    const again = await openPopup(first.store);
    assert.equal(again.doc.querySelector('#table tbody').rows.length, 0);
    assert.equal(again.doc.getElementById('skills').value, 'azure, terraform');
  });

  await test('pulsante disattivato mentre lo scraping è in corso', async () => {
    const init = FULL();
    init.scrapeState = { status: 'running', text: 'Pagine 3/10…', done: 3, total: 10, updatedAt: Date.now() };
    const { doc, set } = await openPopup(init);
    assert.equal(doc.getElementById('btnClearCache').disabled, true);
    assert.equal(doc.getElementById('btnScrape').disabled, true);
    await set({ scrapeState: { status: 'done', text: 'ok', updatedAt: Date.now() } });
    await tick();
    assert.equal(doc.getElementById('btnClearCache').disabled, false);
  });

  await test('cache già vuota: il pulsante funziona senza errori', async () => {
    const { doc, store } = await openPopup({ profile: FULL().profile, options: FULL().options });
    doc.getElementById('btnClearCache').click();
    await tick();
    assert.match(doc.getElementById('status').textContent, /Cache svuotata/);
    assert.ok(store.profile);
  });

  console.log(`\n${n} test del popup passati`);
})().catch((e) => { console.error(e); process.exit(1); });
