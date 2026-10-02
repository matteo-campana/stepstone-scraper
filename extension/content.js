/**
 * content.js — estrazione dati dal DOM di StepStone.
 *
 * Struttura:
 *   1. Utility (query con fallback, pulizia testo)
 *   2. Parser pagina RISULTATI  (parseResultCards, getPagination)
 *   3. Parser pagina DETTAGLIO  (parseDetail, JSON-LD + fallback DOM)
 *   4. Orchestrazione scraping (paginazione via fetch + arricchimento)
 *   5. Evidenziazione in pagina e messaggistica con popup/background
 *
 * I selettori NON sono qui: stanno in selectors.js.
 * Le funzioni di parsing sono pure (ricevono un Document/Element) così
 * funzionano sia sul DOM live sia su pagine scaricate con DOMParser,
 * e sono testabili in Node (vedi test/parse.test.js).
 */
(function (root) {
  'use strict';

  const SEL = root.SS_SELECTORS || require('./selectors.js');
  const Match = root.SSMatch || require('./match.js');
  const Companies = root.SSCompanies || require('./companies.js');

  // ---------------------------------------------------------------
  // 1. UTILITY
  // ---------------------------------------------------------------

  /** Normalizza spazi e a-capo. */
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /** Prova i selettori in ordine, ritorna il primo elemento trovato (o null). */
  function queryFirst(rootEl, selectors) {
    for (const sel of selectors) {
      try {
        const el = rootEl.querySelector(sel);
        if (el) return el;
      } catch (e) { /* selettore invalido: passa al prossimo */ }
    }
    return null;
  }

  /** Prova i selettori in ordine, ritorna la prima NodeList non vuota. */
  function queryAllFirst(rootEl, selectors) {
    for (const sel of selectors) {
      try {
        const list = rootEl.querySelectorAll(sel);
        if (list.length) return Array.from(list);
      } catch (e) { /* ignora */ }
    }
    return [];
  }

  const textOf = (rootEl, selectors) => {
    const el = queryFirst(rootEl, selectors);
    return el ? clean(el.textContent) : '';
  };

  const attrOf = (rootEl, selectors, attr) => {
    const el = queryFirst(rootEl, selectors);
    return el ? el.getAttribute(attr) || '' : '';
  };

  /** href relativo → assoluto ('' se non valido). */
  function absUrl(href, baseUrl) {
    if (!href) return '';
    try { return new URL(href, baseUrl).href; } catch (e) { return ''; }
  }

  /** ID azienda dal link profilo: .../cmp/de/yoummday-gmbh-217684/jobs → 217684 */
  function companyIdFromUrl(url) {
    const m = (url || '').match(/\/cmp\/[^/]+\/[^/]*?-(\d+)(?:\/|$|\.)/);
    return m ? m[1] : '';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => sleep(min + Math.random() * (max - min));

  /** Domini StepStone supportati (devono coincidere con manifest.json). */
  function isSupportedHost(hostname) {
    return /^www\.stepstone\.(de|at|be|nl|fr)$/i.test(hostname);
  }

  // ---------------------------------------------------------------
  // 2. PAGINA RISULTATI
  // ---------------------------------------------------------------

  /**
   * 'results' | 'detail' | 'other' in base al DOM (non solo all'URL).
   * Il dettaglio va controllato per primo: contiene a sua volta card di
   * annunci correlati che altrimenti sembrerebbero una lista risultati.
   */
  function detectPageType(doc) {
    const hasJobPosting = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))
      .some((s) => /"@type"\s*:\s*"JobPosting"/.test(s.textContent));
    if (queryFirst(doc, SEL.detail.title) || hasJobPosting) return 'detail';
    if (queryAllFirst(doc, SEL.results.card).length) return 'results';
    return 'other';
  }

  /**
   * Lo stipendio nella card non ha data-at: cerchiamo uno <span> foglia con "€"
   * fuori dallo snippet (che può contenere "€" in frasi di marketing).
   */
  function extractCardSalary(card) {
    const direct = textOf(card, SEL.results.salary);
    if (direct) return direct;
    const snippet = queryFirst(card, SEL.results.snippet);
    const spans = card.querySelectorAll('span');
    for (const sp of spans) {
      if (snippet && snippet.contains(sp)) continue;
      if (sp.querySelector('span')) continue; // solo foglie
      const t = clean(sp.textContent);
      if (t.length < 90 && /\d/.test(t) && /[€$£]|eur\b/i.test(t)) return t;
    }
    return '';
  }

  /** ID annuncio: da id="job-item-123" oppure dall'URL "...--123-inline.html". */
  function extractJobId(card, url) {
    const m1 = (card.getAttribute('id') || '').match(/(\d{5,})/);
    if (m1) return m1[1];
    const m2 = (url || '').match(/--(\d{5,})-inline/);
    return m2 ? m2[1] : '';
  }

  /**
   * Estrae tutte le card di una pagina risultati.
   * @param {Document|Element} doc
   * @param {string} baseUrl  per rendere assoluti gli href
   * @param {string[]} warnings  accumula avvisi su selettori mancanti
   */
  function parseResultCards(doc, baseUrl, warnings) {
    warnings = warnings || [];
    const container = queryFirst(doc, SEL.results.container);
    if (!container) warnings.push('Contenitore lista non trovato (results.container): uso l\'intero documento.');

    let cards = queryAllFirst(container || doc, SEL.results.card);
    // scarta le card dentro blocchi di raccomandazioni
    cards = cards.filter((c) => !SEL.results.excludeAncestor.some((s) => { try { return c.closest(s); } catch (e) { return false; } }));
    if (!cards.length) {
      warnings.push('Nessuna card trovata (results.card): StepStone potrebbe aver cambiato l\'HTML.');
      return [];
    }

    const missing = {}; // campo -> n. card senza valore
    const miss = (f) => { missing[f] = (missing[f] || 0) + 1; };

    const jobs = cards.map((card) => {
      const titleEl = queryFirst(card, SEL.results.title);
      let anchor = titleEl && (titleEl.tagName === 'A' ? titleEl : titleEl.closest('a') || titleEl.querySelector('a'));
      let url = '';
      if (anchor && anchor.getAttribute('href')) {
        try { url = new URL(anchor.getAttribute('href'), baseUrl).href; } catch (e) { /* url invalido */ }
      }
      const timeEl = queryFirst(card, SEL.results.postedAt);
      const companyUrl = absUrl(attrOf(card, SEL.results.companyLink, 'href'), baseUrl);

      const job = {
        id: extractJobId(card, url),
        title: titleEl ? clean(titleEl.textContent) : '',
        company: textOf(card, SEL.results.company),
        companyUrl,
        companyId: companyIdFromUrl(companyUrl),
        location: textOf(card, SEL.results.location),
        remote: textOf(card, SEL.results.remote),
        salary: extractCardSalary(card),
        snippet: textOf(card, SEL.results.snippet).replace(/\s*mehr$/i, ''),
        postedAt: timeEl ? (timeEl.getAttribute('datetime') || clean(timeEl.textContent)) : '',
        isNew: !!queryFirst(card, SEL.results.topLabel),
        badges: Array.from(card.querySelectorAll(SEL.results.badges[0])).map((b) => clean(b.textContent)),
        url,
        contractType: '', workType: '', description: '', requirements: ''
      };
      if (!job.title) miss('title (results.title)');
      if (!job.company) miss('company (results.company)');
      if (!job.location) miss('location (results.location)');
      if (!job.url) miss('url (results.title → href)');
      if (!job.id) miss('id');
      return job;
    });

    for (const [f, n] of Object.entries(missing)) {
      warnings.push(`Campo "${f}" mancante in ${n}/${jobs.length} card.`);
    }
    return jobs;
  }

  /** Pagina corrente / totale pagine. */
  function getPagination(doc, url) {
    let current = 1;
    try { current = parseInt(new URL(url).searchParams.get('page'), 10) || 1; } catch (e) { /* noop */ }
    let total = null;
    const nav = queryFirst(doc, SEL.results.pagination);
    if (nav) {
      const m = clean(nav.textContent).match(/(\d+)\s*(?:of|von|de|van|sur|di)\s*(\d+)/i);
      if (m) { current = parseInt(m[1], 10); total = parseInt(m[2], 10); }
      else {
        const nums = Array.from(nav.querySelectorAll('a,button')).map((a) => parseInt(clean(a.textContent), 10)).filter((n) => n > 0);
        if (nums.length) total = Math.max(...nums, current);
      }
    }
    const countEl = queryFirst(doc, SEL.results.totalCount);
    const totalResults = countEl ? parseInt(clean(countEl.textContent).replace(/\D/g, ''), 10) || null : null;
    return { current, total, totalResults };
  }

  /** Stesso URL di ricerca (filtri inclusi) ma con ?page=N. */
  function buildPageUrl(href, page) {
    const u = new URL(href);
    u.searchParams.set('page', String(page));
    u.searchParams.delete('action');
    return u.href;
  }

  // ---------------------------------------------------------------
  // 3. PAGINA DETTAGLIO
  // ---------------------------------------------------------------

  const stripHtml = (html) => clean(String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '));

  /** Cerca il blocco JobPosting nei JSON-LD (gestisce array e @graph). */
  function findJobPosting(doc) {
    for (const s of doc.querySelectorAll(SEL.detail.jsonLd[0])) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : data['@graph'] || [data];
        const jp = items.find((x) => x && x['@type'] === 'JobPosting');
        if (jp) return jp;
      } catch (e) { /* JSON non valido: prossimo */ }
    }
    return null;
  }

  /**
   * Scheda azienda ("company passport") nello stato precaricato della pagina di dettaglio:
   *   "companyPassportData": { id, name, resultListUrl, address, employees, industries[] }
   * È un oggetto JS (può contenere `undefined`), quindi lo si isola con un conteggio
   * delle graffe che rispetta le stringhe e poi si fa JSON.parse.
   */
  function extractCompanyPassport(doc) {
    const key = '"companyPassportData"';
    for (const sc of doc.querySelectorAll('script:not([src])')) {
      const t = sc.textContent;
      const i = t.indexOf(key);
      if (i < 0) continue;
      const start = t.indexOf('{', i + key.length);
      if (start < 0) continue;
      let depth = 0, inStr = false, esc = false;
      for (let k = start; k < t.length; k++) {
        const c = t[k];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try { return JSON.parse(t.slice(start, k + 1).replace(/:\s*undefined/g, ': null')); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /** Dati azienda dal dettaglio: passport (preferito) + JSON-LD + link DOM come ripiego. */
  function parseCompany(doc, jp, baseUrl) {
    const pp = extractCompanyPassport(doc) || {};
    const org = (jp && jp.hiringOrganization) || {};
    const loc = jp && (Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation);
    const addr = (loc && loc.address) || {};

    const url = absUrl(pp.resultListUrl || attrOf(doc, SEL.detail.companyLink, 'href') || org.url, baseUrl);
    // "HDI-Platz 1, Hannover" / "Str. 5, 30659 Hannover" → "Hannover"
    const lastPart = pp.address ? String(pp.address).split(',').pop().replace(/^\s*\d{4,5}\s+/, '').trim() : '';
    const industries = Array.isArray(pp.industries) && pp.industries.length ? pp.industries
      : jp && jp.industry ? [String(jp.industry)] : [];

    return {
      id: String(pp.id || companyIdFromUrl(url) || ''),
      name: pp.name || org.name || '',
      url,
      address: pp.address || '',
      city: lastPart || addr.addressLocality || '',
      country: addr.addressCountry || '',
      employees: pp.employees || '',
      industries,
      industriesFromCompany: Array.isArray(pp.industries) && pp.industries.length > 0
    };
  }

  /** Dettagli completi di un annuncio. JSON-LD come fonte robusta, DOM come arricchimento/fallback. */
  function parseDetail(doc, warnings, baseUrl) {
    warnings = warnings || [];
    baseUrl = baseUrl || doc.baseURI || 'https://www.stepstone.de/';
    const jp = findJobPosting(doc);
    const d = {};

    d.title = textOf(doc, SEL.detail.title) || (jp && jp.title) || '';
    d.company = textOf(doc, SEL.detail.company) || (jp && jp.hiringOrganization && jp.hiringOrganization.name) || '';
    d.location = textOf(doc, SEL.detail.location)
      || (jp && jp.jobLocation && jp.jobLocation.address && jp.jobLocation.address.addressLocality) || '';
    d.contractType = textOf(doc, SEL.detail.contractType);
    d.workType = textOf(doc, SEL.detail.workType);
    d.employmentType = (jp && jp.employmentType) || '';
    d.postedAt = (jp && jp.datePosted) || textOf(doc, SEL.detail.postedAt);

    d.salary = textOf(doc, SEL.detail.salary);
    if (!d.salary && jp && jp.baseSalary && jp.baseSalary.value) {
      const v = jp.baseSalary.value;
      if (v.minValue || v.maxValue) d.salary = `${v.minValue || ''} - ${v.maxValue || ''} ${jp.baseSalary.currency || '€'}`;
    }

    const desc = textOf(doc, SEL.detail.description);
    d.description = desc || stripHtml(jp && jp.description);
    d.requirements = textOf(doc, SEL.detail.requirements);
    d.benefits = textOf(doc, SEL.detail.benefits);
    d.company = textOf(doc, SEL.detail.company) || d.company; // nome
    d.companyInfo = parseCompany(doc, jp, baseUrl);

    if (!jp) warnings.push('JSON-LD JobPosting non trovato nel dettaglio: uso solo il DOM.');
    if (!d.title && !d.description) warnings.push('Dettaglio vuoto: controllare i selettori "detail.*".');
    return d;
  }

  // ---------------------------------------------------------------
  // 4. ORCHESTRAZIONE SCRAPING (solo browser)
  // ---------------------------------------------------------------

  async function fetchDoc(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }

  const state = { running: false, cancel: false };

  const setState = (patch) => chrome.storage.local.set({ scrapeState: { updatedAt: Date.now(), ...patch } });

  /** Esegue fn su ogni elemento con concorrenza limitata e pause casuali (cortesia verso il server). */
  async function runPool(items, fn, concurrency = 2) {
    let i = 0;
    const worker = async () => {
      while (i < items.length && !state.cancel) {
        await fn(items[i++]);
        await jitter(500, 1100);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  async function scrapeSearch(options) {
    const opts = { maxPages: 3, enrich: false, companyDetails: true, highlight: true, ...options };
    const warnings = [];
    const href = location.href;

    const { profile = {} } = await chrome.storage.local.get('profile');
    const pg = getPagination(document, href);
    const lastPage = pg.total ? Math.min(pg.total, pg.current + opts.maxPages - 1) : pg.current + opts.maxPages - 1;

    const byId = new Map();
    const add = (jobs) => jobs.forEach((j) => { const k = j.id || j.url; if (k && !byId.has(k)) byId.set(k, j); });

    // --- pagina corrente: DOM live
    await setState({ status: 'running', text: `Pagina ${pg.current}…`, done: 0, total: lastPage - pg.current + 1 });
    add(parseResultCards(document, href, warnings));

    // --- pagine successive: fetch + DOMParser (stessa origine, cookie inclusi)
    for (let p = pg.current + 1; p <= lastPage && !state.cancel; p++) {
      await jitter(800, 1500);
      await setState({ status: 'running', text: `Pagina ${p}/${lastPage}…`, done: p - pg.current, total: lastPage - pg.current + 1 });
      try {
        const doc = await fetchDoc(buildPageUrl(href, p));
        const found = parseResultCards(doc, href, warnings);
        if (!found.length) { warnings.push(`Pagina ${p}: nessun annuncio (fine risultati o blocco anti-bot).`); break; }
        add(found);
      } catch (e) {
        warnings.push(`Pagina ${p}: ${e.message}`);
        break;
      }
    }

    let jobs = Array.from(byId.values());

    // --- arricchimento opzionale con le pagine di dettaglio
    if (opts.enrich && !state.cancel) {
      let done = 0;
      await runPool(jobs.filter((j) => j.url), async (job) => {
        try {
          const d = parseDetail(await fetchDoc(job.url), [], job.url);
          job.contractType = d.contractType || job.contractType;
          job.workType = d.workType || job.workType;
          job.salary = job.salary || d.salary;
          job.description = d.description;
          job.requirements = d.requirements;
          job.benefits = d.benefits;
          job.employmentType = d.employmentType;
          job.companyInfo = d.companyInfo;
        } catch (e) {
          warnings.push(`Dettaglio ${job.id}: ${e.message}`);
        }
        await setState({ status: 'running', text: `Dettagli ${++done}/${jobs.length}…`, done, total: jobs.length });
      });
    }

    // --- dati aziende (settore, sede, paese): UN solo dettaglio per azienda non ancora coperta
    if (opts.companyDetails && !state.cancel) {
      const groups = new Map();
      jobs.forEach((j) => { const k = Companies.companyKey(j); (groups.get(k) || groups.set(k, []).get(k)).push(j); });
      const todo = Array.from(groups.values()).filter((g) => !g.some((j) => j.companyInfo) && g.some((j) => j.url));
      let done = 0;
      await runPool(todo, async (group) => {
        try {
          const d = parseDetail(await fetchDoc(group.find((j) => j.url).url), [], href);
          group.forEach((j) => { j.companyInfo = d.companyInfo; });
        } catch (e) {
          warnings.push(`Azienda ${group[0].company}: ${e.message}`);
        }
        await setState({ status: 'running', text: `Aziende ${++done}/${todo.length}…`, done, total: todo.length });
      });
    }

    // --- matching con il profilo
    jobs = jobs.map((j) => ({ ...j, match: Match.computeMatch(j, profile) }));
    jobs.sort((a, b) => (b.match.score ?? -1) - (a.match.score ?? -1));

    const results = {
      jobs,
      companies: Companies.buildCompanies(jobs, location.hostname),
      meta: {
        pageUrl: href,
        searchTitle: clean((document.querySelector('h1') || {}).textContent),
        totalResults: pg.totalResults,
        pagesScraped: [pg.current, lastPage],
        scrapedAt: new Date().toISOString(),
        cancelled: state.cancel,
        warnings: Array.from(new Set(warnings))
      }
    };
    await chrome.storage.local.set({ lastResults: results });
    if (opts.highlight) highlightCards(jobs);
    await setState({ status: 'done', text: `${jobs.length} annunci, ${results.companies.length} aziende estratti.`, done: 1, total: 1 });
    return results;
  }

  // ---------------------------------------------------------------
  // 5. EVIDENZIAZIONE E MESSAGGISTICA
  // ---------------------------------------------------------------

  /** Aggiunge un badge con il punteggio alle card visibili nella pagina corrente. */
  function highlightCards(jobs) {
    clearHighlight();
    for (const job of jobs) {
      if (!job.id || !job.match || job.match.score == null) continue;
      const card = document.getElementById('job-item-' + job.id);
      if (!card) continue;
      const level = job.match.score >= 70 ? 'high' : job.match.score >= 40 ? 'mid' : 'low';
      const badge = document.createElement('div');
      badge.className = 'ss-match-badge ss-' + level;
      badge.textContent = `Affinità ${job.match.score}%` + (job.match.matchedSkills.length ? ` · ${job.match.matchedSkills.join(', ')}` : '');
      badge.title = job.match.missingSkills.length ? 'Skill mancanti: ' + job.match.missingSkills.join(', ') : 'Tutte le skill trovate';
      card.setAttribute('data-ss-level', level);
      card.prepend(badge);
    }
  }

  function clearHighlight() {
    document.querySelectorAll('.ss-match-badge').forEach((b) => b.remove());
    document.querySelectorAll('[data-ss-level]').forEach((c) => c.removeAttribute('data-ss-level'));
  }

  function init() {
    if (root.__ssContentLoaded) return; // evita doppia registrazione se re-iniettato
    root.__ssContentLoaded = true;

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      switch (msg && msg.type) {
        case 'PING':
          sendResponse({ ok: true, pageType: detectPageType(document), host: location.hostname });
          break;

        case 'SCRAPE': {
          if (!isSupportedHost(location.hostname)) { sendResponse({ ok: false, error: 'WRONG_DOMAIN' }); break; }
          if (detectPageType(document) !== 'results') { sendResponse({ ok: false, error: 'NOT_RESULTS_PAGE' }); break; }
          if (state.running) { sendResponse({ ok: false, error: 'ALREADY_RUNNING' }); break; }
          state.running = true; state.cancel = false;
          sendResponse({ ok: true });
          scrapeSearch(msg.options)
            .catch((e) => setState({ status: 'error', text: e.message }))
            .finally(() => { state.running = false; });
          break;
        }

        case 'CANCEL':
          state.cancel = true;
          sendResponse({ ok: true });
          break;

        case 'HIGHLIGHT':
          highlightCards(msg.jobs || []);
          sendResponse({ ok: true });
          break;

        case 'CLEAR_HIGHLIGHT':
          clearHighlight();
          sendResponse({ ok: true });
          break;
      }
      // risposte tutte sincrone: nessun "return true" necessario
    });
  }

  const api = {
    clean, queryFirst, detectPageType, parseResultCards, getPagination, buildPageUrl,
    parseDetail, parseCompany, extractCompanyPassport, companyIdFromUrl, findJobPosting, extractCardSalary, isSupportedHost
  };
  root.SSContent = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
