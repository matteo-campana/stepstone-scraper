/**
 * match.js — parsing dello stipendio e calcolo dell'affinità annuncio/profilo.
 * Caricato sia dal content script sia dal popup (e dai test Node).
 *
 * Punteggio 0–100 = media pesata dei soli criteri applicabili:
 *   un campo del profilo lasciato vuoto (o un dato assente nell'annuncio)
 *   non penalizza, semplicemente non entra nel calcolo.
 */
(function (root) {
  // Pesi dei criteri (modificabili)
  const WEIGHTS = { skills: 50, position: 20, salary: 10, location: 10, experience: 10 };

  /** Giorni lavorativi/anno per annualizzare una tariffa giornaliera (stima: ~200–230 reali). */
  const WORK_DAYS_PER_YEAR = 220;
  const CURRENCY_SYMBOL = { EUR: '€', GBP: '£', USD: '$', CHF: 'CHF' };
  const DAY_RE = /\bper day\b|\bday rate\b|\bdaily\b|\/ ?day\b|\bper diem\b|\bpro tag\b|\btagessatz\b|\bpar jour\b|\bper dag\b|\bal giorno\b|\bgiornalier|\b(?:al|por) d[ií]a\b/;
  const MONTH_RE = /monat|month|mois|maand|\bal mese\b|\bmensil|\bmes\b/;
  const HOUR_RE = /stunde|hour|heure|uur|(?:all|l)['’]ora\b|\bpor hora\b/;

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = (s) => (s || '').toLowerCase().normalize('NFKC');

  /** Divide una stringa "a, b; c" in elementi puliti. */
  function splitList(str) {
    return (Array.isArray(str) ? str : String(str || '').split(/[,;\n]/))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** True se `term` compare in `text` come parola/token intero (gestisce c++, c#, .net). */
  function containsTerm(text, term) {
    const t = norm(term);
    if (!t) return false;
    const re = new RegExp('(^|[^a-z0-9äöüß+#])' + esc(t) + '($|[^a-z0-9äöüß+#])', 'i');
    return re.test(norm(text));
  }

  /**
   * Estrae un range annuo da testi tipo "55.000 - 83.000 €/ (geschätzt für Vollzeit)",
   * "66.000€ - 88.000€/Jahr", "4.500 € pro Monat". Ritorna {min,max} in €/anno o null.
   */
  function parseSalaryRange(text) {
    if (!text) return null;
    const nums = [];
    const re = /(\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:[.,]\d+)?\s*(k\b)?/gi;
    let m;
    while ((m = re.exec(text))) {
      let v = parseInt(m[1].replace(/[.,\s]/g, ''), 10);
      if (m[2]) v *= 1000;
      if (!isNaN(v)) nums.push(v);
    }
    if (!nums.length) return null;
    let [min, max] = [nums[0], nums.length > 1 ? nums[1] : nums[0]];
    if (min > max) [min, max] = [max, min];
    const t = norm(text);
    if (MONTH_RE.test(t)) { min *= 12; max *= 12; }
    else if (DAY_RE.test(t)) { min *= WORK_DAYS_PER_YEAR; max *= WORK_DAYS_PER_YEAR; }
    else if (HOUR_RE.test(t)) { min *= 1800; max *= 1800; }
    // valori irrealistici → scarta (es. numeri che non sono stipendi)
    if (max < 1000) return null;
    return { min, max };
  }

  /** Periodo in cui è espressa la cifra: 'year' | 'month' | 'day' | 'hour' (stessa logica di parseSalaryRange). */
  function salaryBasis(text) {
    const t = norm(text);
    if (MONTH_RE.test(t)) return 'month';
    if (DAY_RE.test(t)) return 'day';
    if (HOUR_RE.test(t)) return 'hour';
    return 'year';
  }

  /** Codice ISO della valuta dal testo dello stipendio; se assente, quella di ripiego (del sito). Nessuna conversione. */
  function detectCurrency(text, fallback) {
    const t = String(text || '');
    if (/£|\bGBP\b/i.test(t)) return 'GBP';
    if (/€|\bEUR\b/i.test(t)) return 'EUR';
    if (/\$|\bUSD\b/i.test(t)) return 'USD';
    if (/\bCHF\b/i.test(t)) return 'CHF';
    return fallback || '';
  }

  /** Cerca "N Jahre/years Erfahrung" nel testo; ritorna il minimo di anni richiesti o null. */
  function requiredYears(text) {
    const t = norm(text);
    const m = t.match(/(\d{1,2})\s*\+?\s*(?:jahre|jahren|years|yrs|ans)\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * @param {object} job     annuncio estratto (title, snippet, location, remote, salary, description, requirements…)
   * @param {object} profile {skills, years, position, salaryMin, salaryMax, locations, remote}
   * @returns {{score:number, matchedSkills:string[], missingSkills:string[], parts:object}}
   */
  function computeMatch(job, profile) {
    const p = profile || {};
    const parts = {}; // criterio -> {w, s}
    const text = [job.title, job.snippet, job.description, job.requirements].filter(Boolean).join(' \n ');

    // 1) Skill
    const skills = splitList(p.skills);
    const matchedSkills = skills.filter((s) => containsTerm(text, s));
    const missingSkills = skills.filter((s) => !matchedSkills.includes(s));
    if (skills.length) parts.skills = { w: WEIGHTS.skills, s: matchedSkills.length / skills.length };

    // 2) Posizione desiderata vs titolo
    const pos = norm(p.position).trim();
    if (pos) {
      const title = norm(job.title);
      let s = 0;
      if (title.includes(pos)) s = 1;
      else {
        const toks = pos.split(/[\s/,-]+/).filter((t) => t.length > 2);
        if (toks.length) s = toks.filter((t) => containsTerm(title, t)).length / toks.length;
      }
      parts.position = { w: WEIGHTS.position, s };
    }

    // 3) Stipendio (solo se l'annuncio lo riporta)
    const range = parseSalaryRange(job.salary);
    const uMin = Number(p.salaryMin) || 0;
    const uMax = Number(p.salaryMax) || 0;
    if (range && (uMin || uMax)) {
      // Se il massimo offerto è sotto il minimo desiderato, punteggio proporzionale;
      // altrimenti (overlap o stipendio sopra le attese) è un match pieno.
      const s = uMin && range.max < uMin ? range.max / uMin : 1;
      parts.salary = { w: WEIGHTS.salary, s };
    }

    // 4) Località / remoto
    const locs = splitList(p.locations);
    if (locs.length || p.remote) {
      const jobLoc = norm(job.location);
      const locOk = locs.some((l) => jobLoc.includes(norm(l)));
      const remoteOk = !!p.remote && !!job.remote && /home|remote|télétravail|thuiswerk/i.test(job.remote);
      parts.location = { w: WEIGHTS.location, s: locOk || remoteOk ? 1 : 0 };
    }

    // 5) Esperienza (solo se l'annuncio indica gli anni, di solito dopo l'arricchimento)
    const reqYears = requiredYears([job.requirements, job.description, job.snippet].filter(Boolean).join(' '));
    const years = p.years === '' || p.years == null ? null : Number(p.years);
    if (reqYears != null && years != null && !isNaN(years)) {
      parts.experience = { w: WEIGHTS.experience, s: Math.min(1, years / reqYears) };
    }

    const totW = Object.values(parts).reduce((a, x) => a + x.w, 0);
    const score = totW ? Math.round((Object.values(parts).reduce((a, x) => a + x.w * x.s, 0) / totW) * 100) : null;
    return { score, matchedSkills, missingSkills, parts };
  }

  const api = { WEIGHTS, WORK_DAYS_PER_YEAR, CURRENCY_SYMBOL, splitList, containsTerm, parseSalaryRange, salaryBasis, detectCurrency, requiredYears, computeMatch };
  root.SSMatch = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
