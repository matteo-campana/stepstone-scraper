/**
 * geo.js — dalle aziende ai punti sulla mappa.
 * Puro (nessun accesso a DOM/chrome): condiviso da map.js e test.
 *
 * Le coordinate vengono SOLO dalla tabella locale cities.json ({ cities, countries }):
 * nessuna geocodifica in rete. Città sconosciuta → centro del Paese (approx), altrimenti niente punto.
 */
(function (root) {
  const Companies = root.SSCompanies || (typeof require !== 'undefined' ? require('./companies.js') : null);

  /** Chiave di ricerca: minuscolo, senza diacritici ("München" → "munchen"), spazi compressi. */
  function normKey(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();
  }

  // ================================================================
  //  ALIAS — modificabili. Nome alternativo (già normalizzato) → chiave di cities.json.
  //  Servono solo per i nomi che la tabella non contiene già (lì ci sono es. "colonia", "vienna").
  // ================================================================
  const ALIASES = {
    munich: 'munchen', muenchen: 'munchen', monaco: 'munchen',
    cologne: 'koln', koeln: 'koln',
    nuremberg: 'nurnberg', nuernberg: 'nurnberg',
    hanover: 'hannover', francoforte: 'frankfurt',
    zuerich: 'zurich', berna: 'bern', berne: 'bern', basle: 'basel',
    milan: 'milano', rome: 'roma', turin: 'torino', genoa: 'genova',
    brussels: 'bruxelles', brussel: 'bruxelles',
    copenhagen: 'copenaghen', kobenhavn: 'copenaghen', kopenhagen: 'copenaghen',
    parigi: 'paris', bangalore: 'bengaluru'
  };

  /** Varianti da provare, dalla più precisa: "Garching bei München" → anche "garching"; "Alba (Cuneo)" → "alba". */
  function candidates(city) {
    const full = normKey(city);
    const out = [full];
    for (const re of [/\s*\(.*$/, /\s*[,/|].*$/, /\s+bei\s.*$/]) {
      const cut = full.replace(re, '').trim();
      if (cut && !out.includes(cut)) out.push(cut);
    }
    return out;
  }

  const valid = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);

  /**
   * @param {string} city
   * @param {string} country  nome come in companies.js (italiano) o come lo scrive il sito
   * @param {{cities: object, countries: object}} table  contenuto di cities.json
   * @returns {{lat: number, lon: number, approx: boolean}|null}
   */
  function locate(city, country, table) {
    const cities = (table && table.cities) || {};
    const countries = (table && table.countries) || {};
    for (const c of candidates(city)) {
      if (!c) continue;
      const p = cities[c] || cities[ALIASES[c]];
      if (valid(p)) return { lat: p[0], lon: p[1], approx: false };
    }
    // la "città" a volte è già il Paese (annunci con solo "Germania")
    const p = countries[normKey(country)] || countries[normKey(city)];
    return valid(p) ? { lat: p[0], lon: p[1], approx: true } : null;
  }

  /** Aziende nello stesso punto: la k-esima (da 1) si sposta su una spirale ad angolo aureo, così restano cliccabili. */
  function spiral(lat, lon, k) {
    if (k <= 1) return [lat, lon];
    const a = k * 2.39996, r = 0.0025 * Math.sqrt(k);
    const la = lat + Math.sin(a) * r;
    return [la, lon + Math.cos(a) * r / Math.cos(la * Math.PI / 180)];
  }

  /** "Città, Paese"; solo il Paese se la città manca o coincide. */
  function place(c) {
    if (!c.city || c.city === c.country) return c.country || c.city || '';
    return c.country ? c.city + ', ' + c.country : c.city;
  }

  /** Stessa azienda su siti diversi: gli ID sono per-sito, quindi si unisce per nome normalizzato. */
  const nameKey = (name) => Companies.companyKey({ company: name });

  const isProfile = (u) => /linkedin\.com\/company\//i.test(u || '');

  /**
   * Aziende di tutti i siti in un'unica lista.
   * @param {{site: {id: string, label: string}, jobs: object[], host: string}[]} entries
   * @returns {object[]} righe di buildCompanies più: sources[], sourceIds[], jobList[] (jobs = somma, maxScore = massimo)
   */
  function mergeSites(entries) {
    const merged = new Map();
    for (const { site, jobs, host } of entries) {
      const byName = new Map();
      for (const j of jobs || []) {
        if (!j.company) continue;
        const k = nameKey(j.company);
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push({
          title: j.title || '', location: j.location || '', salary: j.salary || '',
          score: j.match && j.match.score != null ? j.match.score : null, url: j.url || ''
        });
      }
      const seen = new Set(); // più ID con lo stesso nome nello stesso sito: gli annunci si attaccano una volta sola
      for (const row of Companies.buildCompanies(jobs || [], host)) {
        const k = nameKey(row.name);
        const list = seen.has(k) ? [] : (byName.get(k) || []);
        seen.add(k);
        const cur = merged.get(k);
        if (!cur) {
          merged.set(k, { ...row, sources: [site.label], sourceIds: [site.id], jobList: list.slice() });
          continue;
        }
        if (!cur.sourceIds.includes(site.id)) { cur.sources.push(site.label); cur.sourceIds.push(site.id); }
        cur.jobs += row.jobs;
        cur.jobList.push(...list);
        if (row.maxScore != null) cur.maxScore = cur.maxScore == null ? row.maxScore : Math.max(cur.maxScore, row.maxScore);
        for (const f of ['url', 'business', 'businessDesc', 'country', 'city', 'employees']) if (!cur[f]) cur[f] = row[f];
        // il profilo vero (da LinkedIn) vince sulla ricerca per nome generata
        if (isProfile(row.linkedin) && !isProfile(cur.linkedin)) cur.linkedin = row.linkedin;
      }
    }
    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
  }

  const api = { ALIASES, normKey, candidates, locate, spiral, place, mergeSites };
  root.SSGeo = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
