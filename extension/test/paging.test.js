// Test di integrazione della fase "pagine in parallelo": esegue il vero content.js dentro jsdom,
// con chrome.* e fetch simulati. Ogni pagina finta è la pagina risultati salvata con ID annuncio
// resi univoci per pagina (25 annunci/pagina).
// Uso: cd extension/test && node paging.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FIXTURES = process.env.STEPSTONE_FIXTURES || path.join(ROOT, '..');
if (!fs.existsSync(path.join(FIXTURES, 'stepston-result-page.html'))) {
  console.log('SALTATO: pagina di esempio non trovata in ' + FIXTURES + ' (impostare STEPSTONE_FIXTURES).');
  process.exit(0);
}
const RESULT_HTML = fs.readFileSync(path.join(FIXTURES, 'stepston-result-page.html'), 'utf8');

// 25 card reali della pagina salvata (escluse quelle dei blocchi "raccomandazioni"), riusate in pagine leggere:
// in jsdom il parsing di una pagina da 6 MB è CPU-bound e nasconderebbe l'effetto del parallelismo di rete.
const CARDS = (() => {
  const doc = new JSDOM(RESULT_HTML).window.document;
  return [...doc.querySelectorAll('article[data-at="job-item"][id^="job-item-"]')]
    .filter((c) => !c.closest('[data-at="resultListMainResultsCvRecommender"]'))
    .map((c) => c.outerHTML);
})();
assert.equal(CARDS.length, 25);

/** Pagina N con 25 annunci a ID univoci; `nav` = testo paginazione (null → nessuna paginazione). */
const lightPage = (p, nav = null, count = null) => {
  const cards = CARDS.map((h) => h
    .replace(/job-item-(\d+)/g, (_, id) => `job-item-${id}${p}`)
    .replace(/-(\d{5,})-inline/g, (_, id) => `-${id}${p}-inline`)
    .replace(/(\/cmp\/[^"]*?-)(\d+)(\/jobs)/g, (_, a, id, c) => `${a}${id}${p}${c}`));
  // Come nel DOM reale: stato "Page 1 of N" e numeri dei pulsanti SENZA spazi in mezzo
  // (il vecchio parser li fondeva: 52 + 12345 → 5212345).
  const navHtml = nav
    ? `<h1>Test</h1>${count ? `<span data-at="search-jobs-count">${count}</span>` : ''}` +
      `<nav aria-label="pagination"><span role="status">${nav}</span><ul><li><a href="?page=1">1</a></li><li><a href="?page=2">2</a></li><li><a href="?page=3">3</a></li></ul></nav>`
    : '';
  return `<html><body>${navHtml}` +
    `<div data-at="unified-resultlist">${cards.join('')}</div></body></html>`;
};
const pageHtml = (p) => lightPage(p);
const LATENCY = 150; // ms di rete simulata per richiesta

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} cfg
 *   total: totale pagine dichiarato nella pagina live (null → senza paginazione)
 *   concurrency, fetchImpl(p, call) → {status, html?} | throw
 */
async function run({ total = 37, totalResults = null, concurrency = 5, startPage = 1, fetchImpl }) {
  const html = lightPage(startPage, total === null ? null : `Page ${startPage} of ${total}`, totalResults);

  const url = `https://www.stepstone.de/jobs/platform-engineer${startPage > 1 ? '?page=' + startPage : ''}`;
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const w = dom.window;

  const store = {};
  let listener;
  w.chrome = {
    storage: { local: {
      get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries([].concat(k).map((x) => [x, store[x]]))),
      set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
    } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } }
  };

  let inFlight = 0, maxInFlight = 0;
  const calls = {};
  w.fetch = async (u) => {
    const p = parseInt(new URL(u).searchParams.get('page'), 10);
    calls[p] = (calls[p] || 0) + 1;
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await sleep(LATENCY + (p % 2 ? 0 : 120)); // latenza simulata; le pagine pari sono più lente → completano fuori ordine
      const r = fetchImpl ? fetchImpl(p, calls[p]) : { status: 200, html: pageHtml(p) };
      return { ok: r.status === 200, status: r.status, headers: { get: () => null }, text: async () => r.html || '' };
    } finally { inFlight--; }
  };

  ['selectors.js', 'match.js', 'companies.js', 'content.js'].forEach((f) => w.eval(read(f)));

  let resp;
  listener({ type: 'SCRAPE', options: { concurrency, enrich: false, companyDetails: false, highlight: false } }, null, (r) => { resp = r; });
  assert.equal(resp.ok, true, JSON.stringify(resp));

  const t0 = Date.now();
  while (!(store.scrapeState && ['done', 'error'].includes(store.scrapeState.status))) {
    if (Date.now() - t0 > 60000) throw new Error('timeout');
    await sleep(25);
  }
  assert.equal(store.scrapeState.status, 'done', store.scrapeState.text);
  return { results: store.lastResults, calls, maxInFlight, ms: Date.now() - t0 };
}

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

(async () => {
  await test('totale noto (37): legge TUTTE le pagine, 925 annunci, oltre il vecchio limite di 20', async () => {
    const { results, calls, maxInFlight, ms } = await run({});
    assert.equal(results.jobs.length, 37 * 25);
    assert.deepEqual(results.meta.pagesScraped, [1, 37]);
    assert.deepEqual(results.meta.pagesFailed, []);
    assert.equal(Object.keys(calls).length, 36); // 2..37 (la 1 è il DOM live)
    assert.ok(maxInFlight <= 5 && maxInFlight >= 4, 'in volo: ' + maxInFlight);
    console.log(`     ${results.jobs.length} annunci, ${results.companies.length} aziende, max ${maxInFlight} richieste in parallelo, ${ms} ms`);
  });

  await test('il parallelismo accelera: concorrenza 5 nettamente più veloce di 1', async () => {
    const fast = await run({ total: 12, concurrency: 5 });
    const slow = await run({ total: 12, concurrency: 1 });
    assert.equal(fast.results.jobs.length, slow.results.jobs.length);
    assert.ok(fast.ms * 1.5 < slow.ms, `5x: ${fast.ms} ms, 1x: ${slow.ms} ms`);
    console.log(`     conc.5: ${fast.ms} ms  vs  conc.1: ${slow.ms} ms`);
  });

  await test('una pagina in errore non ferma le altre e viene segnalata', async () => {
    const { results } = await run({ total: 10, fetchImpl: (p) => (p === 4 ? { status: 404 } : { status: 200, html: pageHtml(p) }) });
    assert.deepEqual(results.meta.pagesFailed, [4]);
    assert.equal(results.jobs.length, 9 * 25);
    assert.ok(results.meta.warnings.some((w) => /Pagina 4/.test(w)));
  });

  await test('429 → ritentativo automatico e pagina recuperata', async () => {
    const { results, calls } = await run({ total: 5, fetchImpl: (p, call) => (p === 3 && call === 1 ? { status: 429 } : { status: 200, html: pageHtml(p) }) });
    assert.equal(calls[3], 2);
    assert.deepEqual(results.meta.pagesFailed, []);
    assert.equal(results.jobs.length, 5 * 25);
  });

  await test('ordine finale per pagina anche se le richieste completano fuori ordine', async () => {
    const { results } = await run({ total: 6, concurrency: 5 });
    const pages = results.jobs.map((j) => parseInt(j.id.slice(8), 10)); // l'ID di test termina col n. pagina
    assert.equal(new Set(results.jobs.map((j) => j.id)).size, results.jobs.length); // nessun duplicato
    assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
    assert.deepEqual([...new Set(pages)], [1, 2, 3, 4, 5, 6]);
  });

  await test('partenza da pagina 5: legge anche le precedenti', async () => {
    const { results, calls } = await run({ total: 8, startPage: 5 });
    assert.deepEqual(results.meta.pagesScraped, [1, 8]);
    assert.deepEqual(Object.keys(calls).map(Number).sort((a, b) => a - b), [1, 2, 3, 4, 6, 7, 8]);
    assert.equal(results.jobs.length, 8 * 25);
  });

  await test('totale pagine assurdo (5212345) con 100 risultati → si legge solo fino a pagina 4, senza avvisi per pagine inesistenti', async () => {
    const { results, calls } = await run({ total: 5212345, totalResults: 100 });
    assert.deepEqual(Object.keys(calls).map(Number).sort((a, b) => a - b), [2, 3, 4]);
    assert.equal(results.jobs.length, 4 * 25);
    assert.deepEqual(results.meta.pagesScraped, [1, 4]);
    assert.ok(results.meta.warnings.some((w) => /incoerente/.test(w)));
    assert.ok(!results.meta.warnings.some((w) => /Pagina \d+: nessun annuncio/.test(w)));
    assert.ok(!results.meta.warnings.some((w) => /Nessuna card/.test(w)));
  });

  await test('totale ignoto: scopre le pagine a ondate e si ferma alla prima vuota', async () => {
    const { results } = await run({ total: null, concurrency: 3, fetchImpl: (p) => (p <= 5 ? { status: 200, html: pageHtml(p) } : { status: 200, html: '<html><body>fine</body></html>' }) });
    assert.deepEqual(results.meta.pagesScraped, [1, 5]);
    assert.equal(results.jobs.length, 5 * 25);
    assert.deepEqual(results.meta.pagesFailed, []);
  });

  console.log(`\n${n} test di paginazione passati`);
})().catch((e) => { console.error(e); process.exit(1); });
