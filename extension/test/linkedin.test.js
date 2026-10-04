// Test LinkedIn:
//  - dettaglio e lista sulle pagine salvate reali (linkedin-job-detail-page.html, linkedin-result-frame.html);
//  - lettura guidata (scorri + "Avanti") su liste SINTETICHE e su una lista ricavata dalla pagina vera.
// Uso: cd extension/test && node linkedin.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { FIXTURES: FX, fixturePath, readFixture, skip } = require('./fixtures.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const Content = require('../content.js');
const Sites = require('../sites.js');
const Companies = require('../companies.js');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('  ✓', name); };

const DETAIL_URL = 'https://www.linkedin.com/jobs/view/4446202363/';
const SEARCH_URL = 'https://www.linkedin.com/jobs/search/?keywords=Azure';

// ---------------------------------------------------------------
// Pagine salvate
// ---------------------------------------------------------------
const detailTests = async () => {
  if (!fixturePath(FX.linkedin.detail)) return skip(FX.linkedin.detail);
  const doc = new JSDOM(readFixture(FX.linkedin.detail), { url: DETAIL_URL }).window.document;
  const w = [];
  const d = Content.parseDetail(doc, w, DETAIL_URL);

  await test('dettaglio: riconosciuto come pagina di dettaglio e sito linkedin', () => {
    assert.equal(Content.detectPageType(doc, DETAIL_URL), 'detail');
    assert.equal(Content.activeSite().id, 'linkedin');
  });

  await test('dettaglio: titolo/azienda/luogo/data/contratto/modalità', () => {
    assert.equal(d.title, 'Google Cloud Architect Specialist');
    assert.equal(d.company, 'BIP');
    assert.equal(d.location, 'Roma, Lazio, Italia');
    assert.equal(d.postedAt, '3 mesi fa');
    assert.equal(d.contractType, 'A tempo pieno');
    assert.equal(d.workType, 'In sede');
    assert.equal(d.salary, '');
    assert.equal(d.currency, '');
  });

  await test('dettaglio: descrizione completa, senza intestazione e senza "… altro"', () => {
    assert.ok(d.description.length > 3000, String(d.description.length));
    assert.match(d.description, /^Entra nel nostro mondo/);
    assert.match(d.description, /Cloud Architect Specialist/);
    assert.doesNotMatch(d.description, /Informazioni sull’offerta di lavoro/);
    assert.doesNotMatch(d.description, /altro$/);
    assert.deepEqual(w, []);
  });

  await test('dettaglio: scheda azienda (profilo LinkedIn, settore, dimensione)', () => {
    const c = d.companyInfo;
    assert.equal(c.id, 'bip-global');
    assert.equal(c.name, 'BIP');
    assert.equal(c.url, 'https://www.linkedin.com/company/bip-global/');
    assert.deepEqual(c.industries, ['Consulenza e servizi aziendali']);
    assert.equal(c.industriesFromCompany, true);
    assert.equal(c.employees, '5001-10000 dipendenti');
  });

  await test('dettaglio: URL /jobs/view/ vince anche se la pagina contiene altre card', () => {
    assert.equal(Content.detectPageType(doc, 'https://www.linkedin.com/jobs/view/4446202363/?trk=x'), 'detail');
  });
};

const searchPageTests = async () => {
  if (!fixturePath(FX.linkedin.page)) return skip(FX.linkedin.page);
  const url = 'https://www.linkedin.com/jobs/search/?currentJobId=4475063527&keywords=Azure';
  const doc = new JSDOM(readFixture(FX.linkedin.page), { url }).window.document;

  await test('pagina di ricerca salvata senza lista (iframe non incluso): "other", nessuna eccezione, avviso chiaro', () => {
    assert.equal(Content.detectPageType(doc, url), 'other');
    const w = [];
    assert.deepEqual(Content.parseResultCards(doc, url, w), []);
    assert.match(w.join(' '), /Nessuna card trovata.*LinkedIn/);
  });
};

const frameTests = async () => {
  if (!fixturePath(FX.linkedin.resultFrame)) return skip(FX.linkedin.resultFrame);
  const html = readFixture(FX.linkedin.resultFrame);
  const doc = new JSDOM(html, { url: SEARCH_URL }).window.document;

  await test('lista reale: riconosciuta come risultati; 25 card di cui 10 caricate e 15 segnaposto ignorati', () => {
    assert.equal(Content.detectPageType(doc, SEARCH_URL), 'results');
    assert.equal(doc.querySelectorAll('li[data-occludable-job-id]').length, 25);
    const w = [];
    const jobs = Content.parseResultCards(doc, SEARCH_URL, w);
    assert.equal(jobs.length, 10);
    assert.deepEqual(w, ['15 card non ancora caricate (segnaposto) ignorate.']);
  });

  await test('lista reale: ID, titolo (una sola volta), azienda, luogo, modalità, data, URL canonico', () => {
    const jobs = Content.parseResultCards(doc, SEARCH_URL, []);
    const j = jobs[0];
    assert.equal(j.id, '4466910737');
    assert.equal(j.title, 'Azure Engineer');
    assert.equal(j.company, 'Proxima Group');
    assert.equal(j.location, 'Roma, Lazio, Italia');
    assert.equal(j.remote, 'Da remoto');
    assert.equal(j.url, 'https://www.linkedin.com/jobs/view/4466910737/');
    assert.equal(jobs[1].postedAt, '2026-09-04');
    assert.equal(jobs[1].remote, 'In sede');
    assert.equal(jobs[3].remote, 'Ibrido');
    assert.equal(new Set(jobs.map((x) => x.id)).size, 10);
    for (const x of jobs) {
      assert.ok(x.title && x.company && x.location, JSON.stringify(x));
      assert.doesNotMatch(x.location, /\(/, 'modalità tolta dal luogo');
      assert.doesNotMatch(x.title, /^(.+?)\s*\1$/, 'nessun titolo raddoppiato: ' + x.title);
    }
  });

  await test('lista reale: pagina corrente/totale e pulsante "Avanti" giusto (non quello del pannello di dettaglio)', () => {
    assert.deepEqual(Content.readPageInfo(doc), { current: 1, total: 13 });
    const b = Content.nextButton(doc);
    assert.equal(b.getAttribute('aria-label'), 'Visualizza pagina successiva');
    assert.ok(b.closest('.jobs-search-pagination'));
    const decoys = [...doc.querySelectorAll('button[aria-label*="Avanti"]')];
    assert.ok(decoys.length >= 1 && decoys.every((d) => d !== b), 'esiste un pulsante "Avanti" esca nel pannello di dettaglio');
  });

  await test('lista reale: aziende dalle 10 card (senza link azienda: raggruppate per nome)', () => {
    const jobs = Content.parseResultCards(doc, SEARCH_URL, []);
    const rows = Companies.buildCompanies(jobs, 'www.linkedin.com');
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.country === 'Italia' && r.city === 'Roma'));
  });
};

// ---------------------------------------------------------------
// Lettura guidata
// ---------------------------------------------------------------
/** Collega chrome.*, fetch e il content script a una finestra jsdom; ritorna gli strumenti per il test. */
function wire(dom, { profile = { skills: 'cloud architect' }, enrichHtml = null } = {}) {
  const w = dom.window;
  const store = { profile };
  let listener;
  const fetched = [];
  let inFlight = 0, maxInFlight = 0;
  w.chrome = {
    storage: { local: {
      get: async (k) => Object.fromEntries([].concat(k).map((x) => [x, store[x]])),
      set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
    } },
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } }
  };
  w.fetch = async (u) => {
    fetched.push(u);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(40);
    inFlight--;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => enrichHtml || '' };
  };
  ['selectors.js', 'sites.js', 'match.js', 'companies.js', 'content.js'].forEach((f) => w.eval(read(f)));
  const send = (msg) => { let r; listener(msg, null, (x) => { r = JSON.parse(JSON.stringify(x)); }); return r; };
  const finished = async () => {
    const t0 = Date.now();
    while (!(store['scrapeState:linkedin'] && ['done', 'error'].includes(store['scrapeState:linkedin'].status))) {
      if (Date.now() - t0 > 30000) throw new Error('timeout');
      await sleep(15);
    }
    return store['scrapeState:linkedin'];
  };
  return { w, doc: w.document, store, send, finished, fetched, maxInFlight: () => maxInFlight };
}

const card = (id, title, company, loc) =>
  `<li data-occludable-job-id="${id}"><div class="job-card-container">` +
  `<a class="job-card-container__link job-card-list__title--link" href="/jobs/view/${id}/?trk=abc"><span aria-hidden="true"><strong>${title}</strong></span><span class="visually-hidden">${title}</span></a>` +
  `<div class="artdeco-entity-lockup__subtitle"><span>${company}</span></div>` +
  `<div class="artdeco-entity-lockup__caption"><ul><li><span>${loc}</span></li></ul></div>` +
  `<time datetime="2026-09-30">3 giorni fa</time></div></li>`;

/**
 * Pagina finta (markup come quello reale) con `pages` pagine da 3 card. "Avanti" cambia la lista (se `works`),
 * aggiorna "Pagina N di M" (salvo `noStatus`) e si disattiva sull'ultima. Un pulsante esca "Foto dell'azienda - Avanti"
 * fuori dalla paginazione non deve mai essere cliccato. `inFrame`: la lista sta in un iframe, come su LinkedIn.
 */
function boot({ pages = 3, works = true, startUrl = SEARCH_URL, enrichHtml = null, startPage = 1, noStatus = false, inFrame = false, profile } = {}) {
  const pageCards = (p) => [1, 2, 3].map((k) => card(4000000 + p * 10 + k, `Cloud Architect ${p}-${k}`, k === 3 ? 'Beta Srl' : 'Acme Spa',
    k === 1 ? 'Roma, Lazio, Italia (In sede)' : 'Milano, Lombardia, Italia')).join('');
  const status = (p) => (noStatus ? '' : `Pagina ${p} di ${pages}`);
  const listHtml = `<div class="jobs-search-results-list__subtitle"><span>${pages * 3} risultati</span></div>
    <div class="scaffold-layout__list"><ul id="list">${pageCards(startPage)}</ul></div>
    <div class="jobs-search-pagination"><span id="pgstatus">${status(startPage)}</span>
      <button class="artdeco-button jobs-search-pagination__button jobs-search-pagination__button--next" aria-label="Visualizza pagina successiva">Avanti</button></div>
    <button id="decoy" aria-label="Foto dell’azienda - Avanti">Avanti</button>`;
  const dom = new JSDOM(inFrame ? '<html><body><iframe data-testid="interop-iframe"></iframe></body></html>' : `<html><body><main>${listHtml}</main></body></html>`,
    { url: startUrl, runScripts: 'outside-only' });
  const inner = inFrame ? dom.window.document.querySelector('iframe').contentDocument : dom.window.document;
  if (inFrame) inner.body.innerHTML = listHtml;

  let page = startPage;
  const next = inner.querySelector('.jobs-search-pagination__button--next');
  next.addEventListener('click', () => {
    if (!works) return;
    page++;
    inner.getElementById('list').innerHTML = pageCards(page);
    inner.getElementById('pgstatus').textContent = status(page);
    if (page >= pages) next.disabled = true;
  });
  const decoy = { clicked: false };
  inner.getElementById('decoy').addEventListener('click', () => { decoy.clicked = true; });

  const t = wire(dom, { enrichHtml, profile });
  return { ...t, inner, decoy };
}

const FAST = { _timing: { scroll: 1, wait: 300 }, _pause: [1, 5] };
const OPTS = { concurrency: 5, enrich: false, companyDetails: false, highlight: true, ...FAST };

const drivingTests = async () => {
  await test('guidata: 3 pagine → 9 annunci, ID, URL canonici, luogo/modalità separati, mai il pulsante esca', async () => {
    const b = boot();
    assert.equal(b.send({ type: 'PING' }).pageType, 'results');
    assert.equal(b.send({ type: 'SCRAPE', options: OPTS }).ok, true);
    const st = await b.finished();
    assert.equal(st.status, 'done', st.text);
    assert.deepEqual(Object.keys(b.store).sort(), ['profile', 'results:linkedin', 'scrapeState:linkedin']);
    const r = b.store['results:linkedin'];
    assert.equal(r.meta.siteId, 'linkedin');
    assert.equal(r.meta.siteLabel, 'LinkedIn');
    assert.equal(r.meta.totalResults, 9);
    assert.deepEqual(r.meta.pagesScraped, [1, 3]);
    assert.deepEqual(r.meta.pagesFailed, []);
    assert.equal(r.jobs.length, 9);
    assert.equal(new Set(r.jobs.map((j) => j.id)).size, 9);
    const j = r.jobs.find((x) => x.id === '4000011');
    assert.equal(j.title, 'Cloud Architect 1-1', 'titolo letto una sola volta (niente testo per screen reader)');
    assert.equal(j.company, 'Acme Spa');
    assert.equal(j.location, 'Roma, Lazio, Italia');
    assert.equal(j.remote, 'In sede');
    assert.equal(j.url, 'https://www.linkedin.com/jobs/view/4000011/');
    assert.equal(j.currency, '');
    assert.deepEqual(r.companies.map((c) => c.name).sort(), ['Acme Spa', 'Beta Srl']);
    assert.equal(b.fetched.length, 0, 'nessun fetch delle altre pagine');
    assert.equal(b.decoy.clicked, false, 'il pulsante "Foto dell\'azienda - Avanti" non va cliccato');
  });

  await test('guidata: corrispondenza col profilo e badge sulla pagina corrente (findCard), rimossi con CLEAR_HIGHLIGHT', async () => {
    const b = boot();
    b.send({ type: 'SCRAPE', options: OPTS });
    await b.finished();
    const r = b.store['results:linkedin'];
    assert.ok(r.jobs.every((j) => j.match && j.match.score != null));
    assert.ok(b.doc.querySelectorAll('li[data-occludable-job-id] .ss-match-badge').length >= 1);
    b.send({ type: 'CLEAR_HIGHLIGHT' });
    assert.equal(b.doc.querySelectorAll('.ss-match-badge').length, 0);
    assert.equal(b.doc.querySelectorAll('[data-ss-level]').length, 0);
  });

  await test('guidata nell\'iframe: lista letta dall\'iframe, badge con stili propri e rimossi', async () => {
    const b = boot({ inFrame: true });
    assert.equal(b.send({ type: 'PING' }).pageType, 'results');
    b.send({ type: 'SCRAPE', options: OPTS });
    const st = await b.finished();
    assert.equal(st.status, 'done', st.text);
    const r = b.store['results:linkedin'];
    assert.equal(r.jobs.length, 9);
    assert.deepEqual(r.meta.pagesScraped, [1, 3]);
    assert.equal(b.doc.querySelectorAll('.ss-match-badge').length, 0, 'nessun badge nel documento esterno');
    assert.ok(b.inner.getElementById('ss-badge-style'), 'stili dei badge iniettati nell\'iframe');
    assert.ok(b.inner.querySelectorAll('li[data-occludable-job-id] .ss-match-badge').length >= 1);
    assert.equal(b.decoy.clicked, false);
    b.send({ type: 'CLEAR_HIGHLIGHT' });
    assert.equal(b.inner.querySelectorAll('.ss-match-badge').length, 0);
  });

  await test('guidata: pagina corrente e totale dal sito ("Pagina 2 di 4") → si parte dalla 2', async () => {
    const b = boot({ startPage: 2, pages: 4 });
    b.send({ type: 'SCRAPE', options: OPTS });
    await b.finished();
    const r = b.store['results:linkedin'];
    assert.deepEqual(r.meta.pagesScraped, [2, 4]);
    assert.equal(r.jobs.length, 3 * 3);
  });

  await test('guidata: senza "Pagina N di M" si usa il parametro start (start=25 → pagina 2)', async () => {
    const b = boot({ noStatus: true, startUrl: SEARCH_URL + '&start=25', pages: 3 });
    b.send({ type: 'SCRAPE', options: OPTS });
    await b.finished();
    assert.deepEqual(b.store['results:linkedin'].meta.pagesScraped, [2, 4]);
  });

  await test('guidata: "Avanti" che non cambia la lista → timeout segnalato, risultati parziali', async () => {
    const b = boot({ works: false });
    b.send({ type: 'SCRAPE', options: OPTS });
    const st = await b.finished();
    assert.equal(st.status, 'done');
    const r = b.store['results:linkedin'];
    assert.equal(r.jobs.length, 3);
    assert.deepEqual(r.meta.pagesFailed, [2]);
    assert.match(r.meta.warnings.join(' '), /Pagina 2: la lista non è cambiata/);
  });

  await test('guidata: Ferma interrompe e mantiene quanto raccolto', async () => {
    const b = boot({ pages: 10 });
    b.send({ type: 'SCRAPE', options: { ...OPTS, _pause: [120, 120] } });
    await sleep(150);
    b.send({ type: 'CANCEL' });
    await b.finished();
    const r = b.store['results:linkedin'];
    assert.equal(r.meta.cancelled, true);
    assert.ok(r.jobs.length >= 3 && r.jobs.length < 30, String(r.jobs.length));
  });

  await test('guidata: tetto di pagine del sito (maxPages = 40)', async () => {
    const b = boot({ pages: 60 });
    b.send({ type: 'SCRAPE', options: OPTS });
    await b.finished();
    const r = b.store['results:linkedin'];
    assert.equal(r.meta.pagesScraped[1], 40);
    assert.equal(r.jobs.length, 40 * 3);
    assert.match(r.meta.warnings.join(' '), /Lette 40 pagine/);
  });

  await test('senza lista nella pagina o su un dettaglio: SCRAPE rifiutato (NOT_RESULTS_PAGE)', async () => {
    const b = boot();
    b.doc.getElementById('list').innerHTML = '';
    assert.deepEqual(b.send({ type: 'SCRAPE', options: OPTS }), { ok: false, error: 'NOT_RESULTS_PAGE' });
    const d = boot({ startUrl: DETAIL_URL });
    assert.deepEqual(d.send({ type: 'SCRAPE', options: OPTS }), { ok: false, error: 'NOT_RESULTS_PAGE' });
  });

  if (fixturePath(FX.linkedin.resultFrame)) {
    await test('lista REALE, 2 pagine: segnaposto ignorati, "Avanti" giusto, totale 313 risultati', async () => {
      const dom = new JSDOM(readFixture(FX.linkedin.resultFrame), { url: SEARCH_URL, runScripts: 'outside-only' });
      const d = dom.window.document;
      const ul = d.querySelector('.scaffold-layout__list ul') || d.querySelector('li[data-occludable-job-id]').parentElement;
      const filled = [...ul.querySelectorAll('li[data-occludable-job-id]')].filter((l) => l.querySelector('.job-card-container'));
      const nextBtn = d.querySelector('.jobs-search-pagination button.jobs-search-pagination__button--next');
      const decoy = d.querySelector('button[aria-label*="Foto"]');
      let decoyClicked = false;
      if (decoy) decoy.addEventListener('click', () => { decoyClicked = true; });
      const setStatus = (p) => {
        const walker = d.createTreeWalker(d.querySelector('.jobs-search-pagination'), 4);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) t.nodeValue = t.nodeValue.replace(/Pagina \d+ di 13/, `Pagina ${p} di 13`);
      };
      nextBtn.addEventListener('click', () => {
        // pagina 2: le stesse card piene con ID diversi, senza segnaposto
        ul.innerHTML = '';
        for (const l of filled) {
          const c = l.cloneNode(true);
          const id = String(parseInt(l.getAttribute('data-occludable-job-id'), 10) + 1000);
          c.setAttribute('data-occludable-job-id', id);
          c.querySelectorAll('[data-job-id]').forEach((e) => e.setAttribute('data-job-id', id));
          c.querySelectorAll('a[href*="/jobs/view/"]').forEach((a) => a.setAttribute('href', `/jobs/view/${id}/`));
          ul.appendChild(c);
        }
        setStatus(2);
        nextBtn.disabled = true;
      });
      const b = wire(dom);
      assert.equal(b.send({ type: 'PING' }).pageType, 'results');
      assert.equal(b.send({ type: 'SCRAPE', options: OPTS }).ok, true);
      const st = await b.finished();
      assert.equal(st.status, 'done', st.text);
      const r = b.store['results:linkedin'];
      assert.equal(r.jobs.length, 20);
      assert.equal(new Set(r.jobs.map((j) => j.id)).size, 20);
      assert.deepEqual(r.meta.pagesScraped, [1, 2]);
      assert.equal(r.meta.totalResults, 313);
      assert.ok(r.meta.warnings.includes('15 card non ancora caricate (segnaposto) ignorate.'), r.meta.warnings.join(' | '));
      assert.ok(r.jobs.every((j) => j.title && j.company && j.location));
      assert.equal(decoyClicked, false);
    });
  } else skip(FX.linkedin.resultFrame + ' (test end-to-end sulla lista reale)');

  if (fixturePath(FX.linkedin.detail)) {
    await test('guidata + dati aziende: un dettaglio per azienda, a ritmo ridotto (max 2 in parallelo), link LinkedIn dell\'azienda', async () => {
      const b = boot({ pages: 1, enrichHtml: readFixture(FX.linkedin.detail) });
      b.send({ type: 'SCRAPE', options: { ...OPTS, companyDetails: true, concurrency: 10 } });
      const st = await b.finished();
      assert.equal(st.status, 'done', st.text);
      assert.equal(b.fetched.length, 2, 'due aziende (Acme, Beta) → due dettagli');
      assert.ok(b.maxInFlight() <= 2, 'in volo: ' + b.maxInFlight());
      assert.ok(b.fetched.every((u) => /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/.test(u)), b.fetched.join(' '));
      const r = b.store['results:linkedin'];
      const acme = r.companies.find((c) => c.name === 'Acme Spa');
      assert.equal(acme.linkedin, 'https://www.linkedin.com/company/bip-global/');
      assert.equal(acme.businessDesc, 'Consulenza e servizi aziendali');
      assert.equal(acme.country, 'Italia', 'dall\'ultima parte del luogo');
      assert.equal(acme.city, 'Roma');
    });
  }
};

const companyTests = async () => {
  await test('buildCompanies: LinkedIn usa il profilo LinkedIn e il paese dal luogo; gli altri siti no', () => {
    const jobs = [{ company: 'Acme', location: 'Roma, Lazio, Italia', companyInfo: { url: 'https://www.linkedin.com/company/acme/' } }];
    const li = Companies.buildCompanies(jobs, 'www.linkedin.com')[0];
    assert.equal(li.linkedin, 'https://www.linkedin.com/company/acme/');
    assert.equal(li.country, 'Italia');
    const tj = Companies.buildCompanies([{ company: 'Acme', location: 'Leeds' }], 'www.totaljobs.com')[0];
    assert.match(tj.linkedin, /search\/results\/companies/);
    assert.equal(tj.country, 'Regno Unito');
  });

  await test('registro: LinkedIn non cambia StepStone/TotalJobs (nessun gancio)', () => {
    for (const id of ['stepstone', 'totaljobs']) {
      const s = Sites.byId(id);
      for (const k of ['getRoot', 'parseDetail', 'detectPageType', 'jobIdFromCard', 'findCard', 'cleanTitle', 'canonicalUrl', 'splitLocation', 'countryFromLocation', 'isPlaceholder', 'maxConcurrency', 'pause', 'maxPages', 'note']) {
        assert.equal(s[k], undefined, id + '.' + k);
      }
    }
  });
};

(async () => {
  await detailTests();
  await searchPageTests();
  await frameTests();
  await drivingTests();
  await companyTests();
  console.log(`\n${n} test LinkedIn passati`);
})().catch((e) => { console.error(e); process.exit(1); });
