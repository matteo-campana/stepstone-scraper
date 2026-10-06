// Test Workday (career site Leonardo): lista e dettaglio sulle pagine salvate, lettura guidata ("next") su una lista ricavata dalla pagina vera.
// Uso: cd extension/test && node workday.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { FIXTURES: FX, fixturePath, readFixture, skip } = require('./fixtures.js');

const Content = require('../content.js');
const Companies = require('../companies.js');
const Sites = require('../sites.js');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const wd = Sites.byId('workday-leonardo');
const HOST = 'leonardocompany.wd3.myworkdayjobs.com';
const SEARCH_URL = 'https://' + HOST + '/it-IT/LeonardoCareerSite';
const DETAIL_URL = 'https://' + HOST + '/it-IT/LeonardoCareerSite/job/IT---Roma---Via-Tiburtina--KM12400/Project-Assurance-Manager_R0030154';

const registryTests = async () => {
  await test('host riconosciuto, host ingannevoli scartati', () => {
    assert.equal(Sites.forHost(HOST).id, 'workday-leonardo');
    for (const h of ['leonardocompany.myworkdayjobs.com', 'other.wd3.myworkdayjobs.com', HOST + '.evil.example', 'www.' + HOST]) assert.equal(Sites.forHost(h), null, h);
  });

  await test('ID annuncio = codice requisizione, dall\'URL', () => {
    assert.equal(wd.jobIdFromUrl('/it-IT/LeonardoCareerSite/job/IT---Varese---Cascina-Costa/ELI---Pricing-Specialist_R0032358-1'), 'R0032358');
    assert.equal(wd.jobIdFromUrl('https://x/job/a/Project-Assurance-Manager_R0030154/apply'), 'R0030154');
    assert.equal(wd.jobIdFromUrl('https://x/it-IT/LeonardoCareerSite'), '');
  });

  await test('luogo: "IT - Roma - sede" → Roma; estero con sigla; "2 Locations" invariato', () => {
    assert.equal(wd.splitLocation('IT - Roma - Via Tiburtina KM12,400').location, 'Roma');
    assert.equal(wd.splitLocation('PL - Varsavia - Ul. X').location, 'Varsavia, PL');
    assert.equal(wd.splitLocation('2 Locations').location, '2 Locations');
    assert.equal(wd.countryFromLocation('Varsavia, PL'), 'Polonia');
    assert.equal(wd.countryFromLocation('Roma'), '');
  });
};

const listTests = async () => {
  if (!fixturePath(FX.workday.result)) return skip(FX.workday.result);
  const doc = new JSDOM(readFixture(FX.workday.result), { url: SEARCH_URL }).window.document;
  const w = [];
  const jobs = Content.parseResultCards(doc, SEARCH_URL, w);

  await test('lista: riconosciuta come risultati, sito e paging', () => {
    assert.equal(Content.detectPageType(doc, SEARCH_URL), 'results');
    assert.equal(Content.activeSite().id, 'workday-leonardo');
    assert.equal(wd.paging, 'dom');
  });

  await test('20 card con ID univoco, nessun avviso, azienda Leonardo', () => {
    assert.equal(jobs.length, 20);
    assert.equal(new Set(jobs.map((j) => j.id)).size, 20);
    assert.deepEqual(w, []);
    for (const j of jobs) {
      for (const f of ['id', 'title', 'company', 'location', 'url', 'postedAt']) assert.ok(j[f], j.id + ' ' + f);
      assert.equal(j.company, 'Leonardo');
      assert.match(j.id, /^R\d{4,}$/);
      assert.match(j.url, /^https:\/\/leonardocompany\.wd3\.myworkdayjobs\.com\/it-IT\/LeonardoCareerSite\/job\//);
    }
  });

  await test('prima card: titolo, luogo ripulito, data, ID', () => {
    const j = jobs[0];
    assert.equal(j.title, 'ELI - Pricing Specialist');
    assert.equal(j.id, 'R0032358');
    assert.equal(j.location, 'Varese');
    assert.equal(j.postedAt, 'Offerta pubblicata oggi');
  });

  await test('totale risultati e pulsante "next" (non quelli del pannello)', () => {
    const root = doc;
    assert.equal(parseInt(Content.queryFirst(root, wd.selectors.results.totalCount).textContent.replace(/\D/g, ''), 10), 736);
    const btn = Content.nextButton(root);
    assert.ok(btn && btn.getAttribute('data-uxi-widget-type') === 'stepToNextButton');
  });

  await test('buildCompanies: una sola azienda, Italia, sede e settore dal sito', () => {
    const rows = Companies.buildCompanies(jobs, HOST);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Leonardo');
    assert.equal(rows[0].country, 'Italia');
    assert.equal(rows[0].jobs, 20);
    assert.match(rows[0].address, /Monte Grappa/);
  });
};

const detailTests = async () => {
  if (!fixturePath(FX.workday.detail)) return skip(FX.workday.detail);
  const doc = new JSDOM(readFixture(FX.workday.detail), { url: DETAIL_URL }).window.document;
  const w = [];
  const d = Content.parseDetail(doc, w, DETAIL_URL);

  await test('dettaglio: riconosciuto (anche con annunci simili nella pagina)', () => {
    assert.equal(Content.detectPageType(doc, DETAIL_URL), 'detail');
    assert.equal(Content.activeSite().id, 'workday-leonardo');
  });

  await test('dettaglio: titolo/azienda/luogo/tipo/data', () => {
    assert.equal(d.title, 'Project Assurance Manager');
    assert.equal(d.company, 'Leonardo');
    assert.equal(d.location, 'Roma');
    assert.equal(d.employmentType, 'Full time');
    assert.equal(d.postedAt, 'Offerta pubblicata 7 giorni fa');
    assert.deepEqual(w, []);
  });

  await test('dettaglio: descrizione completa in testo semplice', () => {
    assert.ok(d.description.length > 1500, String(d.description.length));
    assert.match(d.description, /Project Assurance Manager/);
    assert.match(d.description, /ISO 9001/);
    assert.doesNotMatch(d.description, /<[a-z]/i);
    assert.equal(d.companyInfo.name, 'Leonardo');
  });
};

// ---------- lettura guidata: "next" sostituisce la lista (come l'app Workday) ----------
async function drivingTest({ pages, brokenAt = null }) {
  const src = new JSDOM(readFixture(FX.workday.result)).window.document;
  const tpl = src.documentElement.outerHTML;
  const cardsHtml = (p) => [...src.querySelectorAll('section[data-automation-id="jobResults"] > ul > li')]
    .map((li, i) => li.outerHTML.replace(/_R\d{7}(-\d+)?/g, '_R' + String(p * 100 + i).padStart(7, '0')).replace(/>R\d{7}</g, '>R' + String(p * 100 + i).padStart(7, '0') + '<'));
  const w = new JSDOM(tpl, { url: SEARCH_URL, runScripts: 'outside-only' }).window;
  const ul = () => w.document.querySelector('section[data-automation-id="jobResults"] > ul');
  const render = (p) => { ul().innerHTML = cardsHtml(p).join(''); };
  let page = 1, clicks = 0;
  render(1);
  w.document.querySelector('[data-automation-id="jobFoundText"]').textContent = 'OFFERTE DI LAVORO TROVATE: ' + pages * 20;
  const next = () => w.document.querySelector('nav[aria-label="pagination"] button[data-uxi-widget-type="stepToNextButton"]');
  next().addEventListener('click', () => {
    clicks++;
    if (brokenAt && page + 1 >= brokenAt) return; // il clic non cambia la lista
    page++;
    render(page);
  });

  const store = {};
  let listener;
  w.chrome = { storage: { local: {
    get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : Object.fromEntries([].concat(k).map((x) => [x, store[x]]))),
    set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
  } }, runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } };
  w.fetch = async () => { throw new Error('Workday non deve scaricare pagine'); };
  ['selectors.js', 'sites.js', 'match.js', 'companies.js', 'content.js'].forEach((f) => w.eval(read(f)));

  let resp;
  listener({ type: 'SCRAPE', options: { concurrency: 2, enrich: true, companyDetails: true, highlight: false, _pause: [1, 2], _timing: { wait: 300, scroll: 1 } } }, null, (r) => { resp = r; });
  assert.equal(resp.ok, true, JSON.stringify(resp));
  const t0 = Date.now();
  const key = 'scrapeState:workday-leonardo';
  while (!(store[key] && ['done', 'error'].includes(store[key].status))) {
    if (Date.now() - t0 > 20000) throw new Error('timeout');
    await sleep(10);
  }
  assert.equal(store[key].status, 'done', store[key].text);
  return { results: store['results:workday-leonardo'], clicks };
}

const drivingTests = async () => {
  if (!fixturePath(FX.workday.result)) return;
  let r = await drivingTest({ pages: 3 });
  await test('lettura guidata: 3 pagine = 60 annunci, si ferma all\'ultima stimata dal conteggio, nessun fetch né avviso', () => {
    assert.equal(r.results.jobs.length, 60);
    assert.equal(r.clicks, 2);
    assert.deepEqual(r.results.meta.warnings, []);
    assert.equal(r.results.meta.siteId, 'workday-leonardo');
    assert.equal(r.results.companies.length, 1);
  });

  r = await drivingTest({ pages: 5, brokenAt: 3 });
  await test('"next" senza effetto: si ferma con un avviso e tiene le pagine già lette', () => {
    assert.equal(r.results.jobs.length, 40);
    assert.ok(r.results.meta.warnings.some((x) => /non è cambiata/.test(x)), r.results.meta.warnings.join('|'));
  });
};

(async () => {
  await registryTests();
  await listTests();
  await detailTests();
  await drivingTests();
  console.log(`\n${n} test Workday passati`);
})().catch((e) => { console.error(e); process.exit(1); });
