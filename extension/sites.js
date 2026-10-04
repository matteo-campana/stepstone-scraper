/**
 * sites.js — registro dei siti supportati (UNICO punto da toccare per aggiungerne uno).
 * Puro (nessun accesso a DOM/chrome): condiviso da content script, popup, background e test.
 *
 * Ogni sito dichiara host, valuta, estrattori di ID e i selettori che DIFFERISCONO
 * da quelli di base (selectors.js). Un override `[]` significa "questo sito non ha
 * quell'elemento". Gli host vanno ripetuti in manifest.json (verificato da sites.test.js).
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
