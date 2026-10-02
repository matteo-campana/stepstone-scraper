/**
 * companies.js — dalla lista di annunci alla lista di aziende.
 * Puro (nessun accesso a DOM/chrome): condiviso da content script, popup e test.
 *
 * Colonne (stesse della tabella di riferimento dell'utente):
 *   Azienda | Link Azienda | LinkedIn | Main Business | Main Business - Descrizione | Country | City
 * più, in coda: N. annunci, Affinità max.
 */
(function (root) {
  // ================================================================
  //  PAROLE CHIAVE PER "MAIN BUSINESS" — modificabili.
  //  Principio: nel dubbio la cella resta VUOTA. Una categoria si assegna
  //  solo con un indizio forte; meglio nessun dato che un dato sbagliato.
  //
  //  - Recruiting / Consulenza: parole nel NOME dell'azienda o nel suo settore.
  //    Si usano solo termini inequivocabili (niente "agentur", "talent",
  //    "service"… che danno falsi positivi).
  //  - Prodotto: SOLO se il settore dichiarato dall'azienda su StepStone
  //    (non quello dell'annuncio) contiene uno di questi settori produttivi.
  //    Un settore generico (IT, Software, Internet, Pubblica amministrazione…)
  //    non basta.
  //  Priorità: Recruiting → Consulenza → Prodotto.
  // ================================================================
  const KEYWORDS = {
    recruiting: [
      'personalvermittlung', 'personaldienstleist', 'personalberatung', 'zeitarbeit',
      'arbeitnehmerüberlassung', 'recruiting', 'recruitment', 'staffing', 'headhunt', 'executive search'
    ],
    consulting: [
      'consulting', 'consultancy', 'consultants', 'unternehmensberatung', 'beratung', 'berater',
      'advisory', 'it-dienstleist', 'systemhaus', 'system integrat'
    ],
    product: [
      'automobil', 'fahrzeug', 'maschinenbau', 'anlagenbau', 'elektrotechnik', 'elektronik', 'halbleiter',
      'luft- und raumfahrt', 'luftfahrt', 'raumfahrt', 'rüstung', 'pharma', 'medizintechnik', 'biotechnologie',
      'chemie', 'telekommunikation', 'konsumgüter', 'lebensmittel', 'banken', 'versicherung'
    ]
  };

  /** Forme giuridiche da togliere dal nome per la ricerca LinkedIn. */
  const LEGAL_FORMS = new Set([
    'gmbh', 'ag', 'se', 'kg', 'ohg', 'mbh', 'kgaa', 'ug', 'gbr', 'ev', 'eg', 'co', 'cokg', 'inc', 'llc', 'ltd', 'limited',
    'plc', 'sa', 'sas', 'spa', 'srl', 'bv', 'nv', 'ab', 'as', 'oy', 'holding', 'group', 'gruppe', 'deutschland', 'germany', 'international'
  ]);

  const COUNTRY_IT = {
    DE: 'Germania', AT: 'Austria', CH: 'Svizzera', IT: 'Italia', NL: 'Paesi Bassi', BE: 'Belgio', FR: 'Francia',
    LU: 'Lussemburgo', ES: 'Spagna', PT: 'Portogallo', GB: 'Regno Unito', UK: 'Regno Unito', IE: 'Irlanda',
    PL: 'Polonia', CZ: 'Repubblica Ceca', DK: 'Danimarca', SE: 'Svezia', NO: 'Norvegia', FI: 'Finlandia',
    US: 'Stati Uniti', CA: 'Canada', IN: 'India'
  };

  /** Paese di ripiego dal dominio StepStone dell'annuncio. */
  const HOST_COUNTRY = { de: 'DE', at: 'AT', be: 'BE', nl: 'NL', fr: 'FR' };

  const norm = (s) => String(s || '').toLowerCase().normalize('NFKC');

  /** Chiave di raggruppamento: ID azienda StepStone, altrimenti nome normalizzato. */
  function companyKey(job) {
    return job.companyId ? 'id:' + job.companyId : 'n:' + norm(job.company).replace(/[^a-z0-9äöüß]+/g, ' ').trim();
  }

  /** Nome senza forma giuridica: "Bechtle AG" → "Bechtle". */
  function shortName(name) {
    const tokens = String(name || '').replace(/\(.*?\)/g, ' ').split(/\s+/).filter(Boolean);
    const kept = tokens.filter((t) => !LEGAL_FORMS.has(t.toLowerCase().replace(/[.,&-]/g, '')) );
    while (kept.length && /^[&+-]$/.test(kept[kept.length - 1])) kept.pop();
    return (kept.join(' ') || String(name || '')).replace(/[,;]+$/, '').trim();
  }

  /** StepStone non espone il profilo LinkedIn: si genera la ricerca aziendale, da cui basta un clic. */
  function linkedinSearchUrl(name) {
    return 'https://www.linkedin.com/search/results/companies/?keywords=' + encodeURIComponent(shortName(name));
  }

  /**
   * 'Recruiting' | 'Consulenza' | 'Prodotto' | '' (vuoto = non abbastanza sicuro).
   * @param {string} name        nome azienda
   * @param {string[]} industries settori dichiarati dall'AZIENDA (non quelli dell'annuncio)
   */
  function classifyBusiness(name, industries) {
    const inds = norm((industries || []).filter(Boolean).join(' | '));
    const text = norm(name) + ' | ' + inds;
    if (KEYWORDS.recruiting.some((k) => text.includes(k))) return 'Recruiting';
    if (KEYWORDS.consulting.some((k) => text.includes(k))) return 'Consulenza';
    if (inds && KEYWORDS.product.some((k) => inds.includes(k))) return 'Prodotto';
    return '';
  }

  function countryName(code, host) {
    const c = String(code || '').toUpperCase() || HOST_COUNTRY[(String(host || '').match(/stepstone\.(\w+)$/) || [])[1]] || '';
    return COUNTRY_IT[c] || c;
  }

  /** Colonne dell'export aziende (key = campo della riga, label = intestazione). */
  const COMPANY_COLUMNS = [
    { key: 'name', label: 'Azienda' },
    { key: 'url', label: 'Link Azienda', link: true },
    { key: 'linkedin', label: 'LinkedIn', link: true },
    { key: 'business', label: 'Main Business' },
    { key: 'businessDesc', label: 'Main Business - Descrizione' },
    { key: 'country', label: 'Country' },
    { key: 'city', label: 'City' },
    { key: 'jobs', label: 'N. annunci', number: true },
    { key: 'maxScore', label: 'Affinità max', number: true }
  ];

  /**
   * @param {object[]} jobs  annunci (con companyId/companyUrl dalle card e, se letto, companyInfo dal dettaglio)
   * @param {string} host    hostname StepStone (per il Paese di ripiego)
   */
  function buildCompanies(jobs, host) {
    const groups = new Map();
    for (const j of jobs) {
      if (!j.company) continue;
      const k = companyKey(j);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(j);
    }

    const rows = [];
    for (const list of groups.values()) {
      const first = list[0];
      const info = (list.find((j) => j.companyInfo) || {}).companyInfo || {};
      const industries = info.industries || [];
      const scores = list.map((j) => j.match && j.match.score).filter((s) => s != null);
      const firstLoc = String((list.find((j) => j.location) || {}).location || '').split(',')[0].trim();

      rows.push({
        name: first.company,
        url: first.companyUrl || info.url || '',
        linkedin: linkedinSearchUrl(first.company),
        // solo i settori dichiarati dall'azienda: quello dell'annuncio (ripiego) è troppo generico per classificare
        business: classifyBusiness(first.company, info.industriesFromCompany ? industries : []),
        businessDesc: industries.join(', '),
        country: countryName(info.country, host || (first.url && safeHost(first.url))),
        city: info.city || firstLoc,
        jobs: list.length,
        maxScore: scores.length ? Math.max(...scores) : null,
        employees: info.employees || '',
        companyId: first.companyId || info.id || ''
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  }

  function safeHost(url) { try { return new URL(url).hostname; } catch (e) { return ''; } }

  const api = { KEYWORDS, COMPANY_COLUMNS, companyKey, shortName, linkedinSearchUrl, classifyBusiness, countryName, buildCompanies };
  root.SSCompanies = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
