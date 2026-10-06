// Test dei parser su Indeed: pagina dettaglio salvata (vedi fixtures.js) e funzioni del sito senza pagine di esempio.
// La lista risultati NON è ancora coperta: indeed-result.html salvata non ha il <body> (vedi sites.js).
// Uso: cd extension/test && node indeed.test.js
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { FIXTURES: FX, fixturePath, readFixture, skip } = require('./fixtures.js');

const Content = require('../content.js');
const Companies = require('../companies.js');
const Match = require('../match.js');
const Sites = require('../sites.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓', name); };
const indeed = Sites.byId('indeed');

// ---------- registro (senza pagine di esempio) ----------
ok('host Indeed riconosciuti, host ingannevoli scartati', () => {
  for (const t of ['it', 'de', 'fr', 'es', 'nl', 'at', 'ch', 'be', 'uk']) assert.equal(Sites.forHost(t + '.indeed.com').id, 'indeed', t);
  for (const h of ['www.indeed.com', 'indeed.com', 'it.indeed.com.evil.example', 'xx.indeed.com', 'it.indeed.co']) assert.equal(Sites.forHost(h), null, h);
});

ok('ID annuncio e azienda dagli URL, paese dal sottodominio', () => {
  assert.equal(indeed.jobIdFromUrl('https://it.indeed.com/viewjob?jk=9e38b37ad1050953&tk=x'), '9e38b37ad1050953');
  assert.equal(indeed.jobIdFromUrl('https://it.indeed.com/jobs?q=Azure&vjk=9e38b37ad1050953'), '9e38b37ad1050953');
  assert.equal(indeed.jobIdFromUrl('https://www.linkedin.com/jobs/view/4446202363/'), '');
  assert.equal(indeed.companyIdFromUrl('https://it.indeed.com/cmp/Consorzio-Hunecon?from=x'), 'Consorzio-Hunecon');
  assert.equal(indeed.country('it.indeed.com'), 'IT');
  assert.equal(indeed.country('uk.indeed.com'), 'GB');
  assert.equal(Companies.countryName('', 'de.indeed.com'), 'Germania');
  assert.equal(indeed.canonicalUrl('https://it.indeed.com/rc/clk?jk=1&x=2', '9e38b37ad1050953'), 'https://it.indeed.com/viewjob?jk=9e38b37ad1050953');
});

ok('parseSalaryRange: periodi in italiano (giorno, mese, ora) annualizzati; 1 € annuo scartato', () => {
  assert.deepEqual(Match.parseSalaryRange('140 € al giorno'), { min: 30800, max: 30800 });
  assert.deepEqual(Match.parseSalaryRange('Da 800 € al mese'), { min: 9600, max: 9600 });
  assert.deepEqual(Match.parseSalaryRange("20 € all'ora"), { min: 36000, max: 36000 });
  assert.deepEqual(Match.parseSalaryRange("45.000 € - 50.000 € all'anno"), { min: 45000, max: 50000 });
  assert.equal(Match.parseSalaryRange("1 € all'anno"), null);
  assert.equal(Match.salaryBasis('140 € al giorno'), 'day');
});

ok('extractInlineObject: chiave null non aggancia l\'oggetto successivo', () => {
  const doc = new JSDOM('<script>x = {"k": null, "o": {"a": 1}}</script>').window.document;
  assert.equal(Sites.extractInlineObject(doc, 'k'), null);
  const doc2 = new JSDOM('<script>x = {"k": {"a": "}", "b": [1]}, "z": 2}</script>').window.document;
  assert.deepEqual(Sites.extractInlineObject(doc2, 'k'), { a: '}', b: [1] });
});

// ---------- pagina dettaglio ----------
if (!fixturePath(FX.indeed.detail)) {
  skip(FX.indeed.detail);
} else {
  const detUrl = 'https://it.indeed.com/viewjob?jk=9e38b37ad1050953';
  const det = new JSDOM(readFixture(FX.indeed.detail), { url: detUrl }).window.document;
  const dw = [];
  const d = Content.parseDetail(det, dw, detUrl);

  ok('rileva pagina dettaglio e sito', () => {
    assert.equal(Content.detectPageType(det, detUrl), 'detail');
    assert.equal(Content.activeSite().id, 'indeed');
  });

  ok('dettaglio: titolo/azienda/luogo/contratto/modalità', () => {
    assert.equal(d.title, 'Responsabile Infrastruttura IT');
    assert.equal(d.company, 'Consorzio Hunecon');
    assert.equal(d.location, 'Alba, Piemonte');
    assert.equal(d.contractType, 'Tempo indeterminato');
    assert.equal(d.workType, 'Remoto');
    assert.equal(d.employmentType, 'FULL_TIME');
    assert.match(d.postedAt, /^2026-09-17/);
  });

  ok('dettaglio: stipendio e valuta', () => {
    assert.match(d.salary, /45\.000.*50\.000/);
    assert.equal(d.currency, 'EUR');
  });

  ok('dettaglio: descrizione in testo semplice, benefit, nessun avviso', () => {
    assert.ok(d.description.length > 1500, String(d.description.length));
    assert.match(d.description, /CONSORZIO HUNECON/);
    assert.match(d.description, /Laurea in Ingegneria Informatica/);
    assert.ok(!/[<>]/.test(d.description));
    assert.equal(d.benefits, 'Buoni pasto');
    assert.deepEqual(dw, []);
  });

  ok('dettaglio: scheda azienda dal link /cmp/', () => {
    const c = d.companyInfo;
    assert.equal(c.id, 'Consorzio-Hunecon');
    assert.equal(c.name, 'Consorzio Hunecon');
    assert.equal(c.url, 'https://it.indeed.com/cmp/Consorzio-Hunecon');
    assert.equal(c.city, 'Alba');
    assert.equal(c.country, 'IT');
    assert.deepEqual(c.industries, []);
  });
}

// ---------- lista risultati ----------
// indeed-result.html è il feed "annunci per te" (stessa struttura card della ricerca, senza paginazione né conteggio).
if (!fixturePath(FX.indeed.result)) {
  skip(FX.indeed.result);
} else {
  const resUrl = 'https://it.indeed.com/jobs?q=Azure&l=Italia&start=10';
  const res = new JSDOM(readFixture(FX.indeed.result), { url: resUrl }).window.document;
  const warnings = [];
  const jobs = Content.parseResultCards(res, resUrl, warnings);

  ok('rileva pagina risultati (anche con il pannello dettaglio nel documento)', () => {
    assert.equal(Content.detectPageType(res, resUrl), 'results');
    assert.equal(Content.activeSite().id, 'indeed');
    assert.equal(indeed.paging, 'more');
  });

  ok('177 card (tutte con ID univoco), nessun avviso; il pulsante "Mostra più annunci" è presente', () => {
    assert.equal(jobs.length, 177);
    assert.equal(new Set(jobs.map((j) => j.id)).size, 177);
    assert.deepEqual(warnings, []);
    assert.ok(Content.queryFirst(res, indeed.selectors.results.moreButton), 'pulsante non trovato');
    assert.equal(res.querySelectorAll('a[data-jk]').length, 177, 'nessuna card scartata');
  });

  ok('prima card: id/titolo/azienda/luogo/stipendio/valuta/url canonico', () => {
    const j = jobs[0];
    assert.equal(j.id, '3a7519357d1c31e6');
    assert.equal(j.title, 'SISTEMISTA AWS');
    assert.equal(j.company, 'IDEA IT Srl');
    assert.equal(j.location, 'Roma, Lazio');
    assert.equal(j.salary, "35.000 € - 45.000 € all'anno");
    assert.equal(j.currency, 'EUR');
    assert.equal(j.url, 'https://it.indeed.com/viewjob?jk=3a7519357d1c31e6');
  });

  ok('ogni card ha id, titolo, azienda, luogo e url; lo stipendio manca solo dove Indeed non lo mostra (33 card)', () => {
    for (const j of jobs) for (const f of ['id', 'title', 'company', 'location', 'url']) assert.ok(j[f], j.id + ' ' + f);
    assert.equal(jobs.filter((j) => !j.salary).length, 33);
    for (const j of jobs) assert.equal(j.currency, j.salary ? 'EUR' : '', j.salary);
  });

  ok('stipendi per periodo: annuale, mensile e giornaliero sono annualizzati', () => {
    const sal = (id) => Match.parseSalaryRange(jobs.find((j) => j.id === id).salary);
    assert.deepEqual(sal('3a7519357d1c31e6'), { min: 35000, max: 45000 });
    assert.deepEqual(sal('d2c6342acb162e60'), { min: 43200, max: 52800 }); // 3.600–4.400 € al mese
    assert.ok(jobs.some((j) => /al giorno/.test(j.salary) && Match.parseSalaryRange(j.salary)), 'tariffa giornaliera non riconosciuta');
  });

  ok('"Lavoro da casa" al posto del luogo diventa anche modalità remoto', () => {
    const r = jobs.filter((j) => j.remote);
    assert.ok(r.length >= 1 && r.every((j) => /casa|remot/i.test(j.remote)), JSON.stringify(r.map((j) => j.remote)));
    assert.ok(jobs.filter((j) => !j.remote).every((j) => !/lavoro da casa/i.test(j.location)));
  });

  ok('titolo senza testo accessorio ("Candidati facilmente", "Annuncio")', () => {
    for (const j of jobs) assert.ok(!/Candidati facilmente|^Annuncio/.test(j.title), j.title);
  });

  ok('buildCompanies: paese Italia dal sottodominio', () => {
    const rows = Companies.buildCompanies(jobs, 'it.indeed.com');
    assert.ok(rows.length > 0 && rows.every((r) => r.country === 'Italia'));
  });
}


// ---------- "Mostra più annunci": la lista cresce a ogni clic finché il pulsante sparisce ----------
const read = (f) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUTTON = '<button data-cy="show-more" class="css-ynm87x e8ju0x50"><span>Mostra più annunci</span></button>';

/** Pagina con `first` card; ogni clic ne aggiunge `step` (ID univoci) fino a `total`, poi il pulsante sparisce. */
async function moreTest({ total, first, step, broken = false, maxPages = null }) {
  const cards = [...new JSDOM(readFixture(FX.indeed.result)).window.document.querySelectorAll('div.cardOutline')].slice(0, 6).map((c) => c.outerHTML);
  const cardAt = (i) => cards[i % cards.length].replace(/[0-9a-f]{16}/g, (m) => m.slice(0, 11) + String(i).padStart(5, '0'));
  const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => cardAt(from + i)).join('');
  const html = '<html><body><ul id="mosaic-provider-jobcards-1">' + range(0, first) + '</ul>' + BUTTON + '</body></html>';
  const w = new JSDOM(html, { url: 'https://it.indeed.com/jobs?q=Azure', runScripts: 'outside-only' }).window;

  let shown = first, clicks = 0;
  const btn = w.document.querySelector('button[data-cy="show-more"]');
  if (first >= total) btn.remove(); // lista già completa: nessun pulsante
  btn.addEventListener('click', () => {
    clicks++;
    if (broken) return; // il clic non carica nulla
    const to = Math.min(total, shown + step);
    w.document.getElementById('mosaic-provider-jobcards-1').insertAdjacentHTML('beforeend', range(shown, to));
    shown = to;
    if (shown >= total) btn.remove();
  });

  const store = {};
  let listener;
  w.chrome = { storage: { local: {
    get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries([].concat(k).map((x) => [x, store[x]]))),
    set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
  } }, runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } };
  w.fetch = async () => { throw new Error('Indeed non deve scaricare altre pagine'); };
  ['selectors.js', 'sites.js', 'match.js', 'companies.js', 'content.js'].forEach((f) => w.eval(read(f)));
  if (maxPages) w.SSSites.byId('indeed').maxPages = maxPages;

  let resp;
  listener({ type: 'SCRAPE', options: { concurrency: 2, enrich: false, companyDetails: false, highlight: false, _pause: [1, 2], _timing: { wait: 300 } } }, null, (r) => { resp = r; });
  assert.equal(resp.ok, true, JSON.stringify(resp));
  const t0 = Date.now();
  while (!(store['scrapeState:indeed'] && ['done', 'error'].includes(store['scrapeState:indeed'].status))) {
    if (Date.now() - t0 > 20000) throw new Error('timeout');
    await sleep(10);
  }
  assert.equal(store['scrapeState:indeed'].status, 'done', store['scrapeState:indeed'].text);
  return { results: store['results:indeed'], clicks };
}

async function moreTests() {
  if (!fixturePath(FX.indeed.result)) return;
  let r = await moreTest({ total: 45, first: 15, step: 15 });
  assert.equal(r.results.jobs.length, 45);
  assert.equal(r.clicks, 2);
  assert.deepEqual(r.results.meta.warnings, []);
  assert.equal(r.results.meta.siteId, 'indeed');
  n++; console.log('  ✓ "Mostra più annunci": clicca finché sparisce e legge tutte le 45 card, senza fetch');

  r = await moreTest({ total: 15, first: 15, step: 15 });
  assert.equal(r.results.jobs.length, 15);
  assert.equal(r.clicks, 0);
  n++; console.log('  ✓ senza pulsante: legge le card presenti');

  r = await moreTest({ total: 90, first: 15, step: 15, broken: true });
  assert.equal(r.clicks, 1);
  assert.equal(r.results.jobs.length, 15);
  assert.ok(r.results.meta.warnings.some((w) => /non è cresciuta/.test(w)), r.results.meta.warnings.join('|'));
  n++; console.log('  ✓ clic senza effetto: si ferma con un avviso e tiene le card già caricate');

  r = await moreTest({ total: 300, first: 15, step: 15, maxPages: 3 });
  assert.equal(r.clicks, 3);
  assert.equal(r.results.jobs.length, 60);
  assert.ok(r.results.meta.warnings.some((w) => /limite di sicurezza/.test(w)));
  n++; console.log('  ✓ tetto di clic (maxPages) rispettato, con avviso');
}

moreTests().then(() => {
  console.log(`\n${n} test Indeed passati`);
}).catch((e) => { console.error(e); process.exit(1); });
