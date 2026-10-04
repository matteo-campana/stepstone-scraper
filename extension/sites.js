/**
 * sites.js — registro dei siti supportati (UNICO punto da toccare per aggiungerne uno).
 * Puro (nessun accesso a DOM/chrome): condiviso da content script, popup, background e test.
 *
 * Ogni sito dichiara host, valuta, estrattori di ID e i selettori che DIFFERISCONO
 * da quelli di base (selectors.js). Un override `[]` significa "questo sito non ha
 * quell'elemento". Gli host vanno ripetuti in manifest.json (verificato da sites.test.js).
 *
 * Ganci opzionali per i siti che non seguono il flusso standard (tutti con un default in content.js):
 *   getRoot(doc)            dove stanno le card (documento, iframe, shadow root)
 *   paging                  'fetch' (default: scarica le altre pagine) | 'dom' (guida la pagina: scorre e clicca "Avanti")
 *   detectPageType(doc, c)  'results' | 'detail' | null (null = logica standard)
 *   parseDetail(doc, url)   parser del dettaglio alternativo
 *   jobIdFromCard(card)     ID annuncio dalla card (prima di id e URL)
 *   findCard(doc, id)       card di un annuncio nella pagina (per i badge)
 *   cleanTitle, canonicalUrl, splitLocation, countryFromLocation, isPlaceholder
 *   maxConcurrency, pause, maxPages, note
 */
(function (root) {
  const BASE = root.SS_SELECTORS || require('./selectors.js');

  /** Unisce per gruppo e per campo: un array di override SOSTITUISCE quello di base. Non muta BASE. */
  function mergeSelectors(base, over) {
    const out = {};
    for (const group of Object.keys(base)) {
      out[group] = { ...base[group], ...((over && over[group]) || {}) };
    }
    return out;
  }

  const m1 = (re) => (u) => (String(u || '').match(re) || [])[1] || '';

  /** Scheda azienda di TotalJobs: oggetto "reduxPreloadedState" nello script inline della pagina di dettaglio. */
  function extractReduxState(doc) {
    const key = '"reduxPreloadedState"';
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
          try { return JSON.parse(t.slice(start, k + 1).replace(/:\s*undefined/g, ': null')); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  function totaljobsCompany(doc) {
    const st = extractReduxState(doc);
    if (!st) return null;
    const card = st.companyCard || {};
    const sectors = Array.isArray(card.sectors) ? card.sectors.map((s) => s && s.name).filter(Boolean) : [];
    const address = (st.location && st.location.addressText) || '';
    return {
      id: String((st.company && st.company.id) || card.companyLegacyId || ''),
      name: card.name || (st.company && st.company.name) || '',
      resultListUrl: (card.urls && card.urls.resultList) || '',
      address,
      employees: card.employees || '',
      industries: sectors
    };
  }

  // ---------------------------------------------------------------
  //  LinkedIn
  //  - Dettaglio (/jobs/view/<id>): interfaccia "SDUI" nel documento, appigli stabili
  //    (componentkey "JobDetails_AboutTheJob_<id>", data-sdui-component, document.title). Verificato su pagina salvata.
  //  - Lista (/jobs/search/, interfaccia "ember", dentro l'iframe interop-iframe): verificata su
  //    example/linkedin-result-frame.html. Le card non ancora visibili sono segnaposto vuoti (isPlaceholder).
  //    La variante SDUI /jobs/search-results/ NON è verificata: aggiornare qui se non trova card.
  // ---------------------------------------------------------------
  const LI_FRAME = 'iframe[data-testid="interop-iframe"]';
  const LI_CARD = 'li[data-occludable-job-id], [data-occludable-job-id], div[data-job-id]';
  const liText = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const liJobId = (u) => {
    const x = String(u || '');
    const m = x.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{5,})/) || x.match(/[?&]currentJobId=(\d+)/);
    return m ? m[1] : '';
  };

  /** La lista può stare nel documento, nell'iframe /preload/ (stessa origine) o nello shadow root #interop-outlet. */
  function linkedinRoot(doc) {
    const cands = [doc];
    try { const fr = doc.querySelector(LI_FRAME); if (fr && fr.contentDocument) cands.push(fr.contentDocument); } catch (e) { /* cross-origin */ }
    try { const host = doc.querySelector('#interop-outlet'); if (host && host.shadowRoot) cands.push(host.shadowRoot); } catch (e) { /* noop */ }
    return cands.find((c) => { try { return c.querySelector(LI_CARD); } catch (e) { return false; } }) || doc;
  }

  const LI_WORK = /sede|remot|ibrid|hybrid|on-?site|office/i;

  /** Dettaglio LinkedIn (/jobs/view/<id>) → stessa forma di parseDetail di content.js. */
  function linkedinDetail(doc, baseUrl) {
    const main = doc.querySelector('main') || doc.body || doc;
    const parts = String(doc.title || '').split(' | ').map((x) => x.trim()).filter(Boolean);
    // "Titolo | Azienda | LinkedIn"
    const titleFromDoc = parts.length >= 3 ? parts.slice(0, -2).join(' | ') : (parts[0] || '');
    const companyFromDoc = parts.length >= 3 ? parts[parts.length - 2] : '';

    const leaves = Array.from(main.querySelectorAll('p,span,a')).filter((e) => !e.querySelector('p,span,a') && liText(e));
    const titleEl = leaves.find((e) => e.tagName === 'P' && liText(e) === titleFromDoc);
    const about = doc.querySelector('[componentkey^="JobDetails_AboutTheJob_"]') || doc.querySelector('[data-sdui-component$="aboutTheJob"]');

    // dopo il titolo: luogo · data · ... (separati da "·")
    const after = titleEl ? leaves.slice(leaves.indexOf(titleEl) + 1, leaves.indexOf(titleEl) + 9).map(liText).filter((t) => !/^[·•]$/.test(t)) : [];
    const location = after[0] || '';
    const postedAt = after.find((t, i) => i > 0 && /\b(fa|ago)\b/i.test(t)) || '';
    const salary = after.find((t) => /[€£$]/.test(t) && /\d/.test(t)) || '';

    // chip sotto il titolo (link a /jobs/view/ prima della descrizione): "In sede", "A tempo pieno"…
    const chips = Array.from(main.querySelectorAll('a[href*="/jobs/view/"]'))
      .filter((a) => !about || (a.compareDocumentPosition(about) & 4))
      .map(liText).filter((t) => t && t.length < 40);
    const uniq = Array.from(new Set(chips));

    let description = '';
    if (about) {
      description = liText(about);
      const h = about.querySelector('h2');
      if (h && description.startsWith(liText(h))) description = description.slice(liText(h).length).trim();
    }

    const companyBlock = doc.querySelector('[data-sdui-component$="aboutTheCompanyForJobDetails"]') || doc.querySelector('[componentkey^="JobDetails_AboutTheCompany_"]');
    const link = (companyBlock && companyBlock.querySelector('a[href*="/company/"]')) || main.querySelector('a[href*="/company/"]');
    let companyUrl = '', slug = '';
    if (link) {
      try {
        const u = new URL(link.getAttribute('href'), baseUrl || 'https://www.linkedin.com/');
        const m = u.pathname.match(/\/company\/([^/]+)/);
        if (m) { slug = m[1]; companyUrl = u.origin + '/company/' + slug + '/'; }
      } catch (e) { /* url non valido */ }
    }
    const nameLink = Array.from(main.querySelectorAll('a[href*="/company/"]')).find((a) => liText(a));
    const company = (nameLink && liText(nameLink)) || companyFromDoc;

    let industry = '', employees = '';
    if (companyBlock) {
      const spans = Array.from(companyBlock.querySelectorAll('span')).filter((e) => !e.querySelector('span') && liText(e)).map(liText);
      const fi = spans.findIndex((t) => /follower|seguaci/i.test(t));
      const rest = spans.slice(fi + 1).filter((t) => !/^(già segui|segui|following|follow|[·•…]|altro|more|mi interessa)$/i.test(t));
      employees = rest.find((t) => /dipendenti|employees/i.test(t)) || '';
      industry = rest.find((t) => !/dipendenti|employees|su linkedin|on linkedin/i.test(t)) || '';
    }

    return {
      title: titleFromDoc, company, location,
      contractType: uniq.find((t) => !LI_WORK.test(t)) || '',
      workType: uniq.find((t) => LI_WORK.test(t)) || '',
      employmentType: '',
      postedAt, salary,
      description, requirements: '', benefits: '',
      companyInfo: {
        id: slug, name: company, url: companyUrl, address: '', city: '', country: '',
        employees, industries: industry ? [industry] : [], industriesFromCompany: !!industry
      }
    };
  }

  const SITES = [
    {
      id: 'stepstone',
      label: 'StepStone',
      hostRe: /^www\.stepstone\.(de|at|be|nl|fr)$/i,
      matches: ['de', 'at', 'be', 'nl', 'fr'].map((t) => `https://www.stepstone.${t}/*`),
      baseUrl: 'https://www.stepstone.de/',
      currency: 'EUR',
      locale: 'de',
      cardIdPrefix: 'job-item-',
      pageTotalSlack: 2,
      country: (host) => ({ de: 'DE', at: 'AT', be: 'BE', nl: 'NL', fr: 'FR' })[(String(host || '').match(/stepstone\.(\w+)$/) || [])[1]] || '',
      companyIdFromUrl: m1(/\/cmp\/[^/]+\/[^/]*?-(\d+)(?:\/|$|\.)/),
      jobIdFromUrl: m1(/--(\d{5,})-inline/),
      extractCompany: null, // StepStone: "companyPassportData" (vedi content.js)
      selectors: mergeSelectors(BASE, null)
    },
    {
      id: 'totaljobs',
      label: 'TotalJobs',
      hostRe: /^www\.totaljobs\.com$/i,
      matches: ['https://www.totaljobs.com/*'],
      baseUrl: 'https://www.totaljobs.com/',
      currency: 'GBP',
      locale: 'en',
      cardIdPrefix: 'job-item-',
      pageTotalSlack: 2,
      country: () => 'GB',
      companyIdFromUrl: m1(/[?&]cmpId=(\d+)/),
      jobIdFromUrl: m1(/-job(\d{5,})(?:[/?#.]|$)/),
      extractCompany: totaljobsCompany,
      selectors: mergeSelectors(BASE, {
        results: {
          // il logo è un <a data-at="company-logo"> con ?cmpId=; niente /cmp/
          companyLink: ['a[data-at="company-logo"]'],
          salary: ['[data-at="job-item-salary-info"]', '[data-at="job-item-salary"]'],
          remote: [],
          badges: []
        },
        detail: {
          // "company-logo" compare più volte nel dettaglio: qui solo il link dedicato
          companyLink: ['a[data-at="job-ad-company-logo-link"]'],
          description: ['[data-at="section-text-jobDescription-content"]'],
          requirements: [],
          benefits: [],
          workType: []
        }
      })
    }
    ,
    {
      id: 'linkedin',
      label: 'LinkedIn',
      hostRe: /^www\.linkedin\.com$/i,
      matches: ['https://www.linkedin.com/*'],
      baseUrl: 'https://www.linkedin.com/',
      currency: '', // spesso assente: la valuta si ricava dal testo dello stipendio
      locale: 'it',
      cardIdPrefix: '',
      pageTotalSlack: 2,
      country: () => '',
      companyIdFromUrl: m1(/\/company\/([^/?#]+)/),
      jobIdFromUrl: liJobId,
      extractCompany: null,

      // --- ganci (vedi intestazione)
      paging: 'dom',
      getRoot: linkedinRoot,
      maxConcurrency: 2,
      pause: [1500, 3500],
      maxPages: 40, // LinkedIn mostra al massimo ~1000 risultati
      note: 'LinkedIn: lettura guidata (scorre la lista e clicca "Avanti"). Tieni la scheda aperta sulla ricerca; ci vogliono alcuni secondi a pagina.',
      detectPageType(doc, ctx) {
        if (/\/jobs\/view\//.test(String(ctx.url || ''))) return 'detail';
        if (ctx.cards()) return 'results';
        if (doc.querySelector('[data-sdui-screen$="JobDetails"]')) return 'detail';
        return null;
      },
      parseDetail: linkedinDetail,
      jobIdFromCard(card) {
        const own = card.getAttribute('data-occludable-job-id') || card.getAttribute('data-job-id');
        if (own) return own;
        const inner = card.querySelector('[data-job-id]');
        return inner ? inner.getAttribute('data-job-id') : '';
      },
      findCard(doc, id) {
        const root = linkedinRoot(doc);
        return root.querySelector('[data-occludable-job-id="' + id + '"]') || root.querySelector('[data-job-id="' + id + '"]');
      },
      // il titolo nella card compare due volte (testo visibile + testo per screen reader)
      cleanTitle(t) { const m = String(t || '').match(/^(.+?)\s*\1$/); return m ? m[1] : t; },
      canonicalUrl(url, id) { return id ? 'https://www.linkedin.com/jobs/view/' + id + '/' : url; },
      // LinkedIn disegna il contenuto della card solo quando è visibile: fuori schermo resta <li data-occludable-job-id><!----></li>
      isPlaceholder(card) { return !card.querySelector('.job-card-container, a[href*="/jobs/view/"]'); },
      // "Roma, Lazio, Italia (In sede)" → luogo + modalità
      splitLocation(loc) {
        const m = String(loc || '').match(/^(.*?)\s*\(([^)]*)\)\s*$/);
        return m && LI_WORK.test(m[2]) ? { location: m[1], remote: m[2] } : { location: loc || '', remote: '' };
      },
      countryFromLocation(loc) {
        const p = String(loc || '').split(',').map((x) => x.trim()).filter(Boolean);
        return p.length > 1 ? p[p.length - 1] : '';
      },

      selectors: mergeSelectors(BASE, {
        results: {
          container: ['.scaffold-layout__list', '.jobs-search-results-list', 'main'],
          card: ['li[data-occludable-job-id]', 'div[data-job-id]', '[data-occludable-job-id]'],
          title: ['a.job-card-list__title--link strong', 'a.job-card-container__link strong', 'a.job-card-list__title--link', 'a.job-card-container__link', 'a[href*="/jobs/view/"]'],
          company: ['.artdeco-entity-lockup__subtitle span', '.artdeco-entity-lockup__subtitle', '.job-card-container__primary-description'],
          companyLink: [],
          location: ['.artdeco-entity-lockup__caption li span', '.artdeco-entity-lockup__caption', '.job-card-container__metadata-item'],
          remote: [],
          snippet: [],
          postedAt: ['time'],
          badges: [],
          topLabel: [],
          salary: ['.job-card-container__metadata-item--salary', '.salary-main-rail__data-body'],
          totalCount: ['.jobs-search-results-list__subtitle span', '.jobs-search-results-list__subtitle'],
          // contiene "Pagina 1 di 13" e il pulsante Avanti. Tutto SCOPED a .jobs-search-pagination: nel pannello di dettaglio
          // esistono altri pulsanti con "Avanti" (es. "Foto dell'azienda - Avanti") che non vanno mai cliccati.
          pagination: ['.jobs-search-pagination'],
          paginationStatus: [],
          excludeAncestor: [],
          nextButton: ['.jobs-search-pagination button.jobs-search-pagination__button--next', '.jobs-search-pagination button[aria-label="Visualizza pagina successiva"]', '.jobs-search-pagination button[aria-label*="successiva"]', '.jobs-search-pagination button[aria-label="View next page"]'],
          scrollContainer: ['.scaffold-layout__list', '.jobs-search-results-list']
        }
      })
    }
  ];

  const DEFAULT = SITES[0];
  const forHost = (h) => SITES.find((s) => s.hostRe.test(String(h || ''))) || null;
  const forUrl = (u) => { try { return forHost(new URL(u).hostname); } catch (e) { return null; } };
  const byId = (id) => SITES.find((s) => s.id === id) || null;
  const idOf = (s) => (s && s.id ? s.id : s);

  const resultsKey = (s) => 'results:' + idOf(s);
  const stateKey = (s) => 'scrapeState:' + idOf(s);
  const LEGACY_KEYS = ['lastResults', 'scrapeState'];
  const allCacheKeys = () => SITES.flatMap((s) => [resultsKey(s), stateKey(s)]);
  const hostList = () => SITES.map((s) => s.label + ' (' + s.matches.map((m) => m.replace(/^https:\/\/|\/\*$/g, '')).join(', ') + ')');

  /**
   * Sposta i vecchi `lastResults`/`scrapeState` (un solo slot, scritto solo da StepStone)
   * nelle chiavi per-sito. Idempotente. `area` = chrome.storage.local.
   */
  async function migrateFlatKeys(area) {
    const old = await area.get(LEGACY_KEYS);
    if (!old.lastResults && !old.scrapeState) return false;
    const site = forUrl(old.lastResults && old.lastResults.meta && old.lastResults.meta.pageUrl) || DEFAULT;
    const cur = await area.get([resultsKey(site), stateKey(site)]);
    const put = {};
    if (old.lastResults && !cur[resultsKey(site)]) {
      const r = old.lastResults;
      put[resultsKey(site)] = { ...r, meta: { ...(r.meta || {}), siteId: (r.meta && r.meta.siteId) || site.id, siteLabel: (r.meta && r.meta.siteLabel) || site.label } };
    }
    if (old.scrapeState && !cur[stateKey(site)]) put[stateKey(site)] = old.scrapeState;
    if (Object.keys(put).length) await area.set(put);
    await area.remove(LEGACY_KEYS);
    return true;
  }

  const api = { SITES, DEFAULT, LEGACY_KEYS, mergeSelectors, forHost, forUrl, byId, resultsKey, stateKey, allCacheKeys, hostList, migrateFlatKeys, extractReduxState };
  root.SSSites = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
