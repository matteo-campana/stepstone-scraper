/**
 * content.js — estrazione dati dal DOM dei siti supportati (StepStone, TotalJobs: vedi sites.js).
 *
 * Struttura:
 *   1. Utility (query con fallback, pulizia testo)
 *   2. Parser pagina RISULTATI  (parseResultCards, getPagination)
 *   3. Parser pagina DETTAGLIO  (parseDetail, JSON-LD + fallback DOM)
 *   4. Orchestrazione scraping (paginazione via fetch + arricchimento)
 *   5. Evidenziazione in pagina e messaggistica con popup/background
 *
 * I selettori NON sono qui: stanno in selectors.js (base) e sites.js (differenze per sito).
 * Le funzioni di parsing sono pure (ricevono un Document/Element) così
 * funzionano sia sul DOM live sia su pagine scaricate con DOMParser,
 * e sono testabili in Node (vedi test/parse.test.js).
 */
(function (root) {
  'use strict';

  const Sites = root.SSSites || require('./sites.js');
  const Match = root.SSMatch || require('./match.js');
  const Companies = root.SSCompanies || require('./companies.js');

  // Sito attivo e relativi selettori. I parser sono SINCRONI e cambiano sito solo in ingresso
  // (useSite): non mettere mai un `await` tra useSite() e l'ultima lettura di SEL.
  let SITE = Sites.forHost(typeof location !== 'undefined' ? location.hostname : '') || Sites.DEFAULT;
  let SEL = SITE.selectors;
  function useSite(site) { if (site && site !== SITE) { SITE = site; SEL = site.selectors; } return SITE; }
  /** Sito di un URL; senza URL valido resta quello corrente (utile nei test Node). */
  const siteFromUrl = (u) => (u && Sites.forUrl(u)) || SITE;

  // ---------------------------------------------------------------
  // 1. UTILITY
  // ---------------------------------------------------------------

  /** Normalizza spazi e a-capo. */
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /**
   * Testo VISIBILE di un elemento. Non si può usare `textContent`: StepStone (Emotion) inietta
   * elementi <style> dentro le card e persino dentro i singoli span, e textContent ne includerebbe
   * il CSS (".res-8wkck8{box-sizing:…}Titolo dell'annuncio"). Si saltano i nodi non testuali.
   */
  const NON_TEXT = /^(style|script|noscript|svg|template)$/i;
  function visibleText(el) {
    if (!el) return '';
    let out = '';
    const walk = (node) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !NON_TEXT.test(c.nodeName)) walk(c);
      }
    };
    walk(el);
    return clean(out);
  }

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
    return el ? visibleText(el) : '';
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

  /** ID azienda dal link profilo (formato per sito): StepStone .../cmp/de/yoummday-gmbh-217684/jobs → 217684; TotalJobs ...?cmpId=1389546 */
  function companyIdFromUrl(url) {
    return SITE.companyIdFromUrl(url);
  }


  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min, max) => sleep(min + Math.random() * (max - min));

  /** Domini supportati (definiti in sites.js, da ripetere in manifest.json). */
  function isSupportedHost(hostname) {
    return !!Sites.forHost(hostname);
  }


  // ---------------------------------------------------------------
  // 2. PAGINA RISULTATI
  // ---------------------------------------------------------------

  /**
   * 'results' | 'detail' | 'other' in base al DOM (non solo all'URL).
   * Il dettaglio va controllato per primo: contiene a sua volta card di
   * annunci correlati che altrimenti sembrerebbero una lista risultati.
   */
  function detectPageType(doc, baseUrl) {
    useSite(siteFromUrl(baseUrl || (doc && doc.baseURI)));
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
      const t = visibleText(sp);
      if (t.length < 90 && /\d/.test(t) && /[€$£]|eur\b/i.test(t)) return t;
    }
    return '';
  }

  /** ID annuncio: da id="job-item-123" oppure dall'URL (formato per sito). */
  function extractJobId(card, url) {
    const m1 = (card.getAttribute('id') || '').match(/(\d{5,})/);
    return m1 ? m1[1] : SITE.jobIdFromUrl(url);
  }


  /**
   * Estrae tutte le card di una pagina risultati.
   * @param {Document|Element} doc
   * @param {string} baseUrl  per rendere assoluti gli href
   * @param {string[]} warnings  accumula avvisi su selettori mancanti
   */
  function parseResultCards(doc, baseUrl, warnings) {
    useSite(siteFromUrl(baseUrl));
    warnings = warnings || [];
    const container = queryFirst(doc, SEL.results.container);
    if (!container) warnings.push('Contenitore lista non trovato (results.container): uso l\'intero documento.');

    let cards = queryAllFirst(container || doc, SEL.results.card);
    // scarta le card dentro blocchi di raccomandazioni
    cards = cards.filter((c) => !SEL.results.excludeAncestor.some((s) => { try { return c.closest(s); } catch (e) { return false; } }));
    if (!cards.length) {
      warnings.push(`Nessuna card trovata (results.card): ${SITE.label} potrebbe aver cambiato l'HTML.`);
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
        title: titleEl ? visibleText(titleEl) : '',
        company: textOf(card, SEL.results.company),
        companyUrl,
        companyId: companyIdFromUrl(companyUrl),
        location: textOf(card, SEL.results.location),
        remote: textOf(card, SEL.results.remote),
        salary: extractCardSalary(card),
        snippet: textOf(card, SEL.results.snippet).replace(/\s*mehr$/i, ''),
        postedAt: timeEl ? (timeEl.getAttribute('datetime') || visibleText(timeEl)) : '',
        isNew: !!queryFirst(card, SEL.results.topLabel),
        badges: queryAllFirst(card, SEL.results.badges).map((b) => visibleText(b)),
        url,
        currency: '',
        contractType: '', workType: '', description: '', requirements: ''
      };
      job.currency = job.salary ? Match.detectCurrency(job.salary, SITE.currency) : '';
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

  /**
   * Pagina corrente / totale pagine.
   * Il totale si legge da fonti ristrette, MAI dal testo dell'intero <nav>: nel DOM reale
   * "Page 1 of 52" è attaccato senza spazi ai numeri dei pulsanti (1 2 3 4 5) e un'unica
   * regex li fonderebbe in "5212345".
   *   1. elemento di stato (role="status"): "Page 1 of 52"
   *   2. aria-label dei link: "2 von 52"
   *   3. ripiego: numero di pagina più alto negli href (?page=N)
   */
  const OF_RE = /(\d+)\s*(?:of|von|de|van|sur|di)\s*(\d+)\s*$/i;

  function getPagination(doc, url) {
    useSite(siteFromUrl(url));
    let current = 1;
    try { current = parseInt(new URL(url).searchParams.get('page'), 10) || 1; } catch (e) { /* noop */ }
    let total = null;
    let totalSource = null; // 'status' | 'aria' | 'href'

    const nav = queryFirst(doc, SEL.results.pagination);
    if (nav) {
      const status = queryFirst(nav, SEL.results.paginationStatus);
      const m = status && visibleText(status).match(OF_RE);
      if (m) { current = parseInt(m[1], 10); total = parseInt(m[2], 10); totalSource = 'status'; }

      if (!total) {
        const totals = Array.from(nav.querySelectorAll('[aria-label]'))
          .map((el) => (el.getAttribute('aria-label') || '').match(OF_RE))
          .filter(Boolean).map((x) => parseInt(x[2], 10));
        if (totals.length) { total = Math.max(...totals); totalSource = 'aria'; }
      }

      if (!total) {
        const pages = Array.from(nav.querySelectorAll('a[href]')).map((a) => {
          const mm = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
          return mm ? parseInt(mm[1], 10) : 0;
        }).filter((n) => n > 0);
        if (pages.length) { total = Math.max(...pages, current); totalSource = 'href'; }
      }
    }

    const countEl = queryFirst(doc, SEL.results.totalCount);
    const totalResults = countEl ? parseInt(visibleText(countEl).replace(/\D/g, ''), 10) || null : null;
    return { current, total, totalResults, totalSource };
  }

  /**
   * Controllo di coerenza: con N risultati e P annunci per pagina le pagine sono ceil(N/P).
   * Se il totale letto dal DOM è assurdamente più alto, è un errore di lettura: si usa il valore atteso.
   */
  function sanePageTotal(total, totalResults, perPage, slack) {
    if (!total || !totalResults || !perPage) return total;
    const expected = Math.ceil(totalResults / perPage);
    // Si corregge solo un'eccedenza ASSURDA (numeri fusi tipo "5212345"): un sito che dichiara
    // più pagine di ceil(N/perPage) ma entro un fattore ~2 (es. TotalJobs 25 vs 19) conta in modo diverso.
    const limit = Math.max(expected * (slack || 2) + 5, expected + 1);
    return total > limit ? expected : total;
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
      // il valore deve essere un oggetto: con "companyPassportData": null non si deve agganciare l'oggetto successivo
      const colon = t.indexOf(':', i + key.length);
      if (colon < 0) continue;
      let start = colon + 1;
      while (start < t.length && t.charCodeAt(start) <= 32) start++;
      if (t[start] !== '{') continue;
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
    const pp = (SITE.extractCompany ? SITE.extractCompany(doc) : extractCompanyPassport(doc)) || {};
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
    useSite(siteFromUrl(baseUrl || doc.baseURI));
    warnings = warnings || [];
    baseUrl = baseUrl || doc.baseURI || SITE.baseUrl;
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
      // StepStone: minValue/maxValue; TotalJobs: un solo `value`
      const lo = v.minValue ?? v.value, hi = v.maxValue ?? v.value, cur = jp.baseSalary.currency || '';
      if (lo || hi) d.salary = (lo && hi && lo !== hi ? `${lo} - ${hi} ${cur}` : `${lo || hi} ${cur}`).trim();
      if (cur) d.currency = String(cur).toUpperCase();
    }

    const desc = textOf(doc, SEL.detail.description);
    d.currency = d.currency || (d.salary ? Match.detectCurrency(d.salary, SITE.currency) : '');
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

  const state = { running: false, cancel: false };

  /** Pause (ms) tra un tentativo e il successivo su 429/503/errori di rete. */
  const RETRY_DELAYS = [1500, 4000, 8000];

  /**
   * Scarica e analizza una pagina (stessa origine, cookie inclusi).
   * Ritenta fino a 3 volte su 429/503 (rispettando Retry-After) e su errori di rete;
   * gli altri errori HTTP (404, 403…) falliscono subito.
   */
  async function fetchDoc(url, attempts = 3) {
    let lastErr;
    for (let a = 0; a < attempts; a++) {
      if (state.cancel) throw new Error('Interrotto');
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) return new DOMParser().parseFromString(await res.text(), 'text/html');
        lastErr = new Error(`HTTP ${res.status} su ${url}`);
        if (res.status !== 429 && res.status !== 503) { lastErr.fatal = true; throw lastErr; }
        const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
        if (a < attempts - 1) await sleep(retryAfter > 0 ? Math.min(retryAfter, 20) * 1000 : RETRY_DELAYS[a]);
      } catch (e) {
        if (e.fatal) throw e;
        lastErr = e; // errore di rete
        if (a < attempts - 1) await sleep(RETRY_DELAYS[a]);
      }
    }
    throw lastErr;
  }

  const setState = (patch) => chrome.storage.local.set({ [Sites.stateKey(SITE)]: { updatedAt: Date.now(), ...patch } });

  /**
   * Esegue fn su tutti gli elementi con al massimo `concurrency` chiamate in volo.
   * Ogni worker prende il prossimo elemento appena libero (code condivisa) e fa una breve
   * pausa casuale: il ritmo è limitato soprattutto dalla concorrenza. `state.cancel` ferma i worker.
   */
  async function runPool(items, fn, concurrency = 5, pause = [150, 400]) {
    let i = 0;
    const worker = async () => {
      while (i < items.length && !state.cancel) {
        await fn(items[i++]);
        if (i < items.length) await jitter(pause[0], pause[1]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, worker));
  }

  const clampConcurrency = (n) => Math.min(10, Math.max(1, parseInt(n, 10) || 5));

  /** Tetto di sicurezza sul numero di pagine di una ricerca. */
  const MAX_PAGES = 200;

  /**
   * Pagine da scaricare oltre a quella già in mano (`current`), in ordine crescente.
   * Totale noto → tutte le altre fino a `cap` pagine in tutto.
   * Totale ignoto → solo quelle precedenti alla corrente (le successive si scoprono a ondate).
   */
  function pageSequence(current, total, cap = MAX_PAGES) {
    const last = total ? Math.min(total, cap) : current - 1;
    const pages = [];
    for (let p = 1; p <= last; p++) if (p !== current) pages.push(p);
    return pages;
  }

  async function scrapeSearch(options) {
    const opts = { concurrency: 5, enrich: false, companyDetails: true, highlight: true, ...options };
    opts.concurrency = clampConcurrency(opts.concurrency);
    const warnings = [];
    const href = location.href;
    useSite(siteFromUrl(href));

    const { profile = {} } = await chrome.storage.local.get('profile');
    const pg = getPagination(document, href);

    // --- pagina corrente: DOM live
    const byPage = new Map(); // n. pagina -> annunci (così l'ordine finale è deterministico)
    const firstCards = parseResultCards(document, href, warnings);
    byPage.set(pg.current, firstCards);

    // il totale pagine dichiarato deve essere coerente col numero di risultati
    const saneTotal = sanePageTotal(pg.total, pg.totalResults, firstCards.length, SITE.pageTotalSlack);
    if (saneTotal !== pg.total) {
      warnings.push(`Totale pagine letto dal DOM (${pg.total}) incoerente con ${pg.totalResults} risultati: uso ${saneTotal}.`);
      pg.total = saneTotal;
    }
    const failedPages = [];

    const rest = pageSequence(pg.current, pg.total);
    if (pg.total && pg.total > MAX_PAGES) warnings.push(`La ricerca ha ${pg.total} pagine: lette solo le prime ${MAX_PAGES}.`);
    const totalPages = (pg.total ? Math.min(pg.total, MAX_PAGES) : rest.length + 1);
    let pagesDone = 1;
    const progress = () => setState({ status: 'running', text: `Pagine ${pagesDone}/${pg.total ? totalPages : '?'}…`, done: pagesDone, total: pg.total ? totalPages : pagesDone + 1 });
    await progress();

    /** Scarica una pagina in parallelo alle altre; `expectJobs` = la pagina deve esistere (totale noto). */
    const fetchPage = async (p, expectJobs) => {
      try {
        const found = parseResultCards(await fetchDoc(buildPageUrl(href, p)), href, warnings);
        if (found.length) byPage.set(p, found);
        else if (expectJobs) { failedPages.push(p); warnings.push(`Pagina ${p}: nessun annuncio (blocco anti-bot o HTML cambiato).`); }
        return found.length;
      } catch (e) {
        if (!state.cancel) { failedPages.push(p); warnings.push(`Pagina ${p}: ${e.message}`); }
        return 0;
      } finally {
        pagesDone++;
        await progress();
      }
    };

    // Pagine oltre ceil(risultati/per-pagina) possono essere davvero vuote (il sito conta in modo diverso):
    // si leggono lo stesso ma una pagina vuota non è un errore.
    const expectedPages = pg.totalResults && firstCards.length ? Math.ceil(pg.totalResults / firstCards.length) : null;
    await runPool(rest, (p) => fetchPage(p, !!pg.total && (!expectedPages || p <= expectedPages)), opts.concurrency);

    // totale non noto: ondate di `concurrency` pagine in avanti finché una non produce annunci
    if (!pg.total) {
      let start = pg.current + 1;
      while (!state.cancel && start <= MAX_PAGES) {
        const wave = Array.from({ length: Math.min(opts.concurrency, MAX_PAGES - start + 1) }, (_, i) => start + i);
        const counts = await Promise.all(wave.map((p) => fetchPage(p, false)));
        if (counts.every((c) => c === 0)) break; // oltre l'ultima pagina
        start += wave.length;
      }
    }

    // unione in ordine di pagina; dedup per id
    const byId = new Map();
    [...byPage.keys()].sort((a, b) => a - b).forEach((p) => {
      byPage.get(p).forEach((j) => { const k = j.id || j.url; if (k && !byId.has(k)) byId.set(k, j); });
    });
    const readPages = [...byPage.keys()];
    const lastPage = Math.max(...readPages);
    const firstPage = Math.min(...readPages);

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
          job.currency = job.currency || d.currency || '';
          job.description = d.description;
          job.requirements = d.requirements;
          job.benefits = d.benefits;
          job.employmentType = d.employmentType;
          job.companyInfo = d.companyInfo;
        } catch (e) {
          warnings.push(`Dettaglio ${job.id}: ${e.message}`);
        }
        await setState({ status: 'running', text: `Dettagli ${++done}/${jobs.length}…`, done, total: jobs.length });
      }, opts.concurrency);
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
      }, opts.concurrency);
    }

    // --- matching con il profilo
    jobs = jobs.map((j) => ({ ...j, match: Match.computeMatch(j, profile) }));
    jobs.sort((a, b) => (b.match.score ?? -1) - (a.match.score ?? -1));

    const results = {
      jobs,
      companies: Companies.buildCompanies(jobs, location.hostname),
      meta: {
        pageUrl: href,
        siteId: SITE.id,
        siteLabel: SITE.label,
        searchTitle: visibleText(document.querySelector('h1')),
        totalResults: pg.totalResults,
        pagesScraped: [firstPage, lastPage],
        pagesFailed: failedPages.sort((x, y) => x - y),
        scrapedAt: new Date().toISOString(),
        cancelled: state.cancel,
        warnings: Array.from(new Set(warnings))
      }
    };
    await chrome.storage.local.set({ [Sites.resultsKey(SITE)]: results });
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
      const card = document.getElementById(SITE.cardIdPrefix + job.id);
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
    clean, visibleText, queryFirst, detectPageType, parseResultCards, getPagination, sanePageTotal, buildPageUrl,
    pageSequence, runPool, useSite, activeSite: () => SITE, parseDetail, parseCompany, extractCompanyPassport, companyIdFromUrl, findJobPosting, extractCardSalary, isSupportedHost
  };
  root.SSContent = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
