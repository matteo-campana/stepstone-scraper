// Test del popup in jsdom con chrome.* simulato: risultati per sito, chip del sito, "Pulisci cache".
// Uso: cd extension/test && node popup.test.js   (non servono le pagine di esempio)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const job = (id, title, company, extra = {}) => ({
  id, title, company, location: 'Berlin', remote: '', salary: '', url: `https://www.stepstone.de/x--${id}-inline.html`,
  match: { score: 80, matchedSkills: ['azure'], missingSkills: [] }, ...extra
});

/**
 * Apre il popup con uno storage iniziale e ritorna finestra, storage, messaggi inviati e download.
 * activeSite: id del sito della scheda attiva (null = scheda non supportata), come risponde ACTIVE_SITE.
 */
async function openPopup(initial, { confirmAnswer = true, activeSite = 'stepstone', replies = {} } = {}) {
  const dom = new JSDOM(read('popup.html'), { runScripts: 'outside-only', url: 'chrome-extension://abc/popup.html' });
  const w = dom.window;
  w.TextEncoder = TextEncoder; // usato da xlsx.js

  const store = JSON.parse(JSON.stringify(initial));
  const listeners = [];
  const sent = [];       // messaggi al background, escluso ACTIVE_SITE
  const downloads = [];  // nomi dei file scaricati
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
    runtime: {
      sendMessage: async (m) => {
        if (m.type === 'ACTIVE_SITE') return { ok: true, host: activeSite ? 'x' : '', siteId: activeSite };
        sent.push(m);
        return replies[m.type] || { ok: true };
      }
    }
  };
  w.confirm = () => confirmAnswer;
  w.URL.createObjectURL = () => 'blob:test';
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); };

  ['selectors.js', 'sites.js', 'match.js', 'companies.js', 'xlsx.js', 'popup.js'].forEach((f) => w.eval(read(f)));
  await tick();
  return { w, doc: w.document, store, sent, downloads, set: (o) => w.chrome.storage.local.set(o) };
}

const PROFILE = { skills: 'azure, terraform', years: '5', position: 'Platform Engineer', salaryMin: '', salaryMax: '', locations: '', remote: false };
const OPTIONS = { concurrency: 7, enrich: true, companyDetails: true, highlight: true };

const SS_RESULTS = (scrapedAt = '2026-10-01T10:00:00.000Z') => ({
  jobs: [job('1', 'Cloud Engineer', 'ACME'), job('2', 'Platform Engineer', 'Beta')],
  companies: [{ name: 'ACME', url: 'https://www.stepstone.de/cmp/de/acme-1/jobs', linkedin: '', business: 'Prodotto', businessDesc: '', country: 'Germania', city: 'Berlin', jobs: 1, maxScore: 80 }],
  meta: { pageUrl: 'https://www.stepstone.de/jobs/x', siteId: 'stepstone', siteLabel: 'StepStone', pagesScraped: [1, 1], pagesFailed: [], warnings: [], totalResults: 2, scrapedAt }
});

const TJ_RESULTS = (scrapedAt = '2026-10-02T10:00:00.000Z') => ({
  jobs: [
    job('108060738', 'Technical Lead - D365', 'Cadence', { location: 'London', salary: '£40000 - £50000 per annum', currency: 'GBP', url: 'https://www.totaljobs.com/job/x-job108060738' }),
    job('108060739', 'Contract Dev', 'Hays', { location: 'Leeds', salary: '£700 per day', currency: 'GBP' }),
    job('108060740', 'Platform Dev', 'Hays', { location: 'Leeds', salary: '57515.00', currency: 'GBP' }),
    job('108060741', 'Eur Dev', 'Hays', { location: 'Dublin', salary: '55.000 €', currency: 'EUR' })
  ],
  companies: [{ name: 'Cadence', url: 'https://www.totaljobs.com/jobs/cadence?cmpId=1', linkedin: 'https://www.linkedin.com/search/results/companies/?keywords=Cadence', business: 'Recruiting', businessDesc: '', country: 'Regno Unito', city: 'London', jobs: 1, maxScore: 80 }],
  meta: { pageUrl: 'https://www.totaljobs.com/jobs/dynamics-365', siteId: 'totaljobs', siteLabel: 'TotalJobs', pagesScraped: [1, 1], pagesFailed: [], warnings: [], totalResults: 4, scrapedAt }
});

const FULL = () => ({
  profile: { ...PROFILE },
  options: { ...OPTIONS },
  'results:stepstone': SS_RESULTS(),
  'scrapeState:stepstone': { status: 'done', text: '2 annunci estratti.', updatedAt: Date.now() }
});

const BOTH = () => ({
  ...FULL(),
  'results:totaljobs': TJ_RESULTS(),
  'scrapeState:totaljobs': { status: 'done', text: '4 annunci estratti.', updatedAt: Date.now() }
});

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const rows = (doc, id = 'table') => doc.querySelector(`#${id} tbody`).rows;

(async () => {
  await test('mostra la dimensione della cache e i risultati salvati', async () => {
    const { doc } = await openPopup(FULL());
    assert.equal(rows(doc).length, 2);
    assert.match(doc.getElementById('cacheSize').textContent, /^\(\d+ B\)$|KB/);
    assert.equal(doc.getElementById('btnClearCache').disabled, false);
  });

  await test('annullando la conferma non cambia nulla', async () => {
    const { doc, store, sent } = await openPopup(FULL(), { confirmAnswer: false });
    doc.getElementById('btnClearCache').click();
    await tick();
    assert.ok(store['results:stepstone'] && store['scrapeState:stepstone']);
    assert.equal(rows(doc).length, 2);
    assert.equal(sent.length, 0);
  });

  await test('Pulisci cache: elimina risultati e stato, tiene profilo e opzioni', async () => {
    const { doc, store, sent } = await openPopup(FULL());
    doc.getElementById('btnClearCache').click();
    await tick();
    assert.equal('results:stepstone' in store, false);
    assert.equal('scrapeState:stepstone' in store, false);
    assert.equal(store.profile.skills, 'azure, terraform');
    assert.equal(store.options.concurrency, 7);
    // interfaccia ripulita
    assert.equal(rows(doc).length, 0);
    assert.equal(rows(doc, 'tableCo').length, 0);
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
    assert.equal(rows(again.doc).length, 0);
    assert.equal(again.doc.getElementById('skills').value, 'azure, terraform');
  });

  await test('pulsanti di pulizia disattivati mentre lo scraping è in corso', async () => {
    const init = FULL();
    init['scrapeState:stepstone'] = { status: 'running', text: 'Pagine 3/10…', done: 3, total: 10, updatedAt: Date.now() };
    const { doc, set } = await openPopup(init);
    assert.equal(doc.getElementById('btnClearCache').disabled, true);
    assert.equal(doc.getElementById('btnClearCacheAll').disabled, true);
    assert.equal(doc.getElementById('btnScrape').disabled, true);
    await set({ 'scrapeState:stepstone': { status: 'done', text: 'ok', updatedAt: Date.now() } });
    await tick();
    assert.equal(doc.getElementById('btnClearCache').disabled, false);
    assert.equal(doc.getElementById('btnClearCacheAll').disabled, false);
  });

  await test('cache già vuota: il pulsante funziona senza errori', async () => {
    const { doc, store } = await openPopup({ profile: PROFILE, options: OPTIONS });
    doc.getElementById('btnClearCache').click();
    await tick();
    assert.match(doc.getElementById('status').textContent, /Cache svuotata/);
    assert.ok(store.profile);
  });

  // ---------- più siti ----------

  await test('chip e testi "il sito" seguono il sito della scheda attiva', async () => {
    const { doc } = await openPopup(BOTH(), { activeSite: 'totaljobs' });
    const chip = doc.getElementById('siteChip');
    assert.equal(chip.hidden, false);
    assert.equal(chip.textContent, 'TotalJobs');
    assert.equal(chip.classList.contains('stale'), false);
    const names = [...doc.querySelectorAll('[data-site-name]')];
    assert.ok(names.length >= 2);
    assert.ok(names.every((el) => el.textContent === 'TotalJobs'));
    assert.match(doc.getElementById('cacheScope').textContent, /TotalJobs/);
    assert.doesNotMatch(doc.body.textContent, /StepStone/);
  });

  await test('con risultati di entrambi i siti, la tabella mostra quelli della scheda attiva', async () => {
    const store = BOTH();
    const ss = await openPopup(store, { activeSite: 'stepstone' });
    assert.equal(rows(ss.doc).length, 2);
    assert.equal(ss.doc.getElementById('siteChip').textContent, 'StepStone');
    const tj = await openPopup(store, { activeSite: 'totaljobs' });
    assert.equal(rows(tj.doc).length, 4);
    assert.match(rows(tj.doc)[0].textContent, /Technical Lead - D365/);
  });

  await test('scheda non supportata: ripiego sull\'ultimo sito usato, chip "ultima estrazione"', async () => {
    const store = { ...BOTH(), lastSiteId: 'stepstone' };
    const { doc } = await openPopup(store, { activeSite: null });
    assert.equal(rows(doc).length, 2);
    const chip = doc.getElementById('siteChip');
    assert.equal(chip.textContent, 'StepStone · ultima estrazione');
    assert.equal(chip.classList.contains('stale'), true);
  });

  await test('scheda non supportata e nessun "ultimo sito": vale l\'estrazione più recente', async () => {
    const { doc } = await openPopup(BOTH(), { activeSite: null }); // TotalJobs è più recente
    assert.equal(rows(doc).length, 4);
    assert.match(doc.getElementById('siteChip').textContent, /^TotalJobs · ultima estrazione$/);
  });

  await test('si ricorda l\'ultimo sito della scheda attiva', async () => {
    const { store } = await openPopup(BOTH(), { activeSite: 'totaljobs' });
    assert.equal(store.lastSiteId, 'totaljobs');
  });

  await test('il link azienda e i nomi dei file seguono il sito dei RISULTATI', async () => {
    const { doc, downloads } = await openPopup(BOTH(), { activeSite: 'totaljobs' });
    const links = [...doc.querySelectorAll('#tableCo tbody a')].map((a) => a.textContent);
    assert.deepEqual(links, ['TotalJobs', 'LinkedIn']);
    doc.getElementById('btnJson').click();
    doc.getElementById('btnCsv').click();
    doc.getElementById('btnCsvCo').click();
    doc.getElementById('btnXlsx').click();
    await tick();
    assert.equal(downloads.length, 4);
    assert.match(downloads[0], /^totaljobs-\d{4}-\d\d-\d\d-\d\d-\d\d\.json$/);
    assert.match(downloads[1], /^totaljobs-annunci-/);
    assert.match(downloads[2], /^totaljobs-aziende-/);
    assert.match(downloads[3], /^totaljobs-.*\.xlsx$/);
    const ss = await openPopup(BOTH(), { activeSite: 'stepstone' });
    assert.deepEqual([...ss.doc.querySelectorAll('#tableCo tbody a')].map((a) => a.textContent), ['StepStone']);
    ss.doc.getElementById('btnJson').click();
    assert.match(ss.downloads[0], /^stepstone-/);
  });

  await test('stipendio: valuta aggiunta solo se manca; tariffa giornaliera con stima annua', async () => {
    const { doc } = await openPopup(BOTH(), { activeSite: 'totaljobs' });
    const sal = [...rows(doc)].map((r) => r.cells[3]);
    assert.equal(sal[0].textContent, '£40000 - £50000 per annum');
    assert.equal(sal[0].title, '');
    assert.equal(sal[1].textContent, '£700 per day');
    assert.match(sal[1].title, /^≈ £154\D?000\/anno \(stima: 220 giorni lavorativi\)$/);
    assert.equal(sal[2].textContent, '£ 57515.00');
    assert.equal(sal[3].textContent, '55.000 €');
  });

  await test('Pulisci cache toglie solo il sito mostrato; "Tutto" li toglie tutti; profilo e opzioni restano', async () => {
    const one = await openPopup(BOTH(), { activeSite: 'totaljobs' });
    one.doc.getElementById('btnClearCache').click();
    await tick();
    assert.equal('results:totaljobs' in one.store, false);
    assert.equal('scrapeState:totaljobs' in one.store, false);
    assert.ok(one.store['results:stepstone'] && one.store['scrapeState:stepstone'], 'StepStone intatto');
    assert.equal(rows(one.doc).length, 0);
    assert.ok(one.store.profile && one.store.options);

    const all = await openPopup(BOTH(), { activeSite: 'totaljobs' });
    assert.match(all.doc.getElementById('cacheSizeAll').textContent, /B\)|KB/);
    all.doc.getElementById('btnClearCacheAll').click();
    await tick();
    for (const k of ['results:totaljobs', 'scrapeState:totaljobs', 'results:stepstone', 'scrapeState:stepstone']) assert.equal(k in all.store, false, k);
    assert.ok(all.store.profile && all.store.options);
    assert.equal(rows(all.doc).length, 0);
    assert.equal(all.doc.getElementById('cacheSizeAll').textContent, '');
  });

  await test('lo stato di un altro sito non blocca i pulsanti del sito mostrato', async () => {
    const { doc, set } = await openPopup(BOTH(), { activeSite: 'stepstone' });
    await set({ 'scrapeState:totaljobs': { status: 'running', text: 'Pagine 1/9…', done: 1, total: 9, updatedAt: Date.now() } });
    await tick();
    assert.equal(doc.getElementById('btnScrape').disabled, false);
    assert.equal(doc.getElementById('progress').hidden, true);
    await set({ 'results:totaljobs': TJ_RESULTS('2026-10-03T00:00:00.000Z') });
    await tick();
    assert.equal(rows(doc).length, 2, 'la tabella resta quella di StepStone');
  });

  await test('chiavi a slot unico di versioni precedenti: migrate in StepStone all\'apertura', async () => {
    const legacy = {
      profile: PROFILE, options: OPTIONS,
      lastResults: { ...SS_RESULTS(), meta: { ...SS_RESULTS().meta, siteId: undefined, siteLabel: undefined } },
      scrapeState: { status: 'done', text: 'ok', updatedAt: Date.now() }
    };
    const { doc, store } = await openPopup(legacy, { activeSite: 'stepstone' });
    assert.equal('lastResults' in store, false);
    assert.equal('scrapeState' in store, false);
    assert.equal(store['results:stepstone'].meta.siteId, 'stepstone');
    assert.equal(rows(doc).length, 2);
  });

  await test('avvio su scheda non supportata: messaggio con i siti supportati', async () => {
    const { doc } = await openPopup(BOTH(), { activeSite: null, replies: { START_SCRAPE: { ok: false, error: 'WRONG_DOMAIN' } } });
    doc.getElementById('btnScrape').click();
    await tick();
    const msg = doc.getElementById('status').textContent;
    assert.match(msg, /non è un sito supportato/);
    assert.match(msg, /StepStone/);
    assert.match(msg, /totaljobs\.com/);
  });

  await test('LinkedIn: nota del sito, chip e limite di concorrenza (anche con opzioni salvate più alte)', async () => {
    const init = {
      ...BOTH(),
      'results:linkedin': {
        jobs: [job('4000011', 'Cloud Architect', 'Acme', { url: 'https://www.linkedin.com/jobs/view/4000011/' })],
        companies: [],
        meta: { pageUrl: 'https://www.linkedin.com/jobs/search/', siteId: 'linkedin', siteLabel: 'LinkedIn', pagesScraped: [1, 1], pagesFailed: [], warnings: [], totalResults: 1, scrapedAt: '2026-10-05T00:00:00.000Z' }
      }
    };
    const li = await openPopup(init, { activeSite: 'linkedin' });
    const d = li.doc;
    assert.equal(d.getElementById('siteChip').textContent, 'LinkedIn');
    assert.equal(d.getElementById('siteNote').hidden, false);
    assert.match(d.getElementById('siteNote').textContent, /lettura guidata/);
    assert.equal(d.getElementById('concurrency').max, '2');
    assert.equal(d.getElementById('concurrency').value, '2', 'opzioni salvate con 7 → ridotte al massimo del sito');
    d.getElementById('concurrency').value = '9';
    d.getElementById('btnScrape').click();
    await tick();
    assert.equal(li.sent.find((m) => m.type === 'START_SCRAPE').options.concurrency, 2);
    d.getElementById('btnJson').click();
    assert.match(li.downloads[0], /^linkedin-/);

    const ss = await openPopup(init, { activeSite: 'stepstone' });
    assert.equal(ss.doc.getElementById('siteNote').hidden, true);
    assert.equal(ss.doc.getElementById('concurrency').max, '10');
    assert.equal(ss.doc.getElementById('concurrency').value, '7');
  });

  await test('errore NOT_RESULTS_PAGE: indica come aprire una ricerca su LinkedIn', async () => {
    const { doc } = await openPopup(BOTH(), { activeSite: 'linkedin', replies: { START_SCRAPE: { ok: false, error: 'NOT_RESULTS_PAGE' } } });
    doc.getElementById('btnScrape').click();
    await tick();
    assert.match(doc.getElementById('status').textContent, /LinkedIn apri Lavoro/);
  });

  console.log(`\n${n} test del popup passati`);
})().catch((e) => { console.error(e); process.exit(1); });
