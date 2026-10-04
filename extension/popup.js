/**
 * popup.js — UI: profilo utente, avvio scraping, tabella risultati, export.
 *
 * Il lavoro pesante avviene nel content script; qui si legge solo lo stato
 * da chrome.storage.local (scrapeState:<sito>, results:<sito>), quindi chiudere il
 * popup durante lo scraping non interrompe nulla. Si mostrano i risultati di UN sito
 * alla volta: quello della scheda attiva (o l'ultimo usato).
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const PROFILE_FIELDS = ['skills', 'years', 'position', 'salaryMin', 'salaryMax', 'locations'];

  const ERRORS = {
    WRONG_DOMAIN: 'La scheda attiva non è un sito supportato. Siti supportati: ' + SSSites.hostList().join('; ') + '.',
    NOT_RESULTS_PAGE: 'Questa non è una pagina di risultati di ricerca. Apri una ricerca (es. /jobs/...) e riprova.',
    NO_TAB: 'Nessuna scheda attiva trovata.',
    ALREADY_RUNNING: 'Uno scraping è già in corso su questa scheda.',
    NO_RESPONSE: 'La pagina non risponde. Ricarica la scheda (F5) e riprova.'
  };
  const errText = (code) => ERRORS[code] || `Errore: ${code}`;

  let results = null; // { jobs, meta } del sito visualizzato
  let viewSite = SSSites.DEFAULT; // sito di cui si mostrano risultati, stato e cache

  /** Etichetta del sito dei risultati mostrati (i link azienda puntano a quel sito, non a quello della scheda). */
  const resultSite = () => SSSites.byId(results && results.meta && results.meta.siteId) || viewSite;
  const filePrefix = () => resultSite().id;

  /** Stipendio per la tabella: simbolo della valuta solo se il testo non ne ha già uno (es. "57515.00"). */
  function formatSalary(j) {
    const raw = (j.salary || '').replace(/\s*\(.*\)/, '');
    if (!raw) return '';
    const sym = SSMatch.CURRENCY_SYMBOL[j.currency] || '';
    return sym && !/[€£$]|CHF/.test(raw) && /\d/.test(raw) ? `${sym} ${raw}` : raw;
  }

  /** Tooltip con la stima annua quando la cifra non è annuale (tariffa giornaliera, mensile, oraria). */
  function salaryEstimate(j) {
    const basis = SSMatch.salaryBasis(j.salary || '');
    const r = basis === 'year' ? null : SSMatch.parseSalaryRange(j.salary);
    if (!r) return '';
    const sym = SSMatch.CURRENCY_SYMBOL[j.currency] || '';
    const fmt = (v) => sym + v.toLocaleString('it-IT');
    const how = basis === 'day' ? `stima: ${SSMatch.WORK_DAYS_PER_YEAR} giorni lavorativi` : 'stima';
    return `≈ ${fmt(r.min)}${r.max !== r.min ? '–' + fmt(r.max) : ''}/anno (${how})`;
  }

  // ---------------------------------------------------------------
  // Tab
  // ---------------------------------------------------------------
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $('tab-jobs').hidden = btn.dataset.tab !== 'jobs';
    $('tab-profile').hidden = btn.dataset.tab !== 'profile';
  }));

  // ---------------------------------------------------------------
  // Profilo
  // ---------------------------------------------------------------
  function readProfile() {
    const p = {};
    PROFILE_FIELDS.forEach((f) => { p[f] = $(f).value.trim(); });
    p.remote = $('remote').checked;
    return p;
  }

  function fillProfile(p) {
    PROFILE_FIELDS.forEach((f) => { $(f).value = (p && p[f]) ?? ''; });
    $('remote').checked = !!(p && p.remote);
  }

  $('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const profile = readProfile();
    await chrome.storage.local.set({ profile });
    // Ricalcola l'affinità dei risultati già estratti senza rifare lo scraping
    if (results && results.jobs.length) {
      results.jobs = rescore(results.jobs, profile);
      results.companies = buildCompanies();
      await chrome.storage.local.set({ [SSSites.resultsKey(viewSite)]: results });
      render();
    }
    setMsg('profileMsg', 'Profilo salvato ✓', 'ok');
  });

  function setMsg(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = 'status ' + (cls || '');
    if (cls === 'ok') setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500);
  }

  /** Righe aziende dagli annunci correnti (l'host serve solo per il Paese di ripiego). */
  function buildCompanies() {
    let host = '';
    try { host = new URL(results.meta.pageUrl).hostname; } catch (e) { /* noop */ }
    return SSCompanies.buildCompanies(results.jobs, host);
  }

  function rescore(jobs, profile) {
    return jobs
      .map((j) => ({ ...j, match: SSMatch.computeMatch(j, profile) }))
      .sort((a, b) => (b.match.score ?? -1) - (a.match.score ?? -1));
  }

  // ---------------------------------------------------------------
  // Scraping
  // ---------------------------------------------------------------
  function readOptions() {
    return {
      concurrency: Math.min(10, Math.max(1, parseInt($('concurrency').value, 10) || 5)),
      enrich: $('enrich').checked,
      companyDetails: $('companyDetails').checked,
      highlight: $('highlight').checked
    };
  }

  $('btnScrape').addEventListener('click', async () => {
    const options = readOptions();
    await chrome.storage.local.set({ options });
    setStatus('Avvio…');
    renderWarnings([]);
    const res = await chrome.runtime.sendMessage({ type: 'START_SCRAPE', options });
    if (!res || !res.ok) setStatus(errText(res && res.error), 'err');
  });

  $('btnCancel').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CANCEL' }));

  $('btnHighlight').addEventListener('click', async () => {
    if (!results) return setStatus('Nessun risultato da evidenziare: avvia prima l\'estrazione.', 'err');
    const res = await chrome.runtime.sendMessage({ type: 'HIGHLIGHT', jobs: results.jobs });
    if (!res || !res.ok) setStatus(errText(res && res.error), 'err');
  });

  $('btnClear').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CLEAR_HIGHLIGHT' }));

  function setStatus(text, cls) {
    $('status').textContent = text || '';
    $('status').className = 'status ' + (cls || '');
  }

  /** Aggiorna barra di stato/progresso da scrapeState. */
  function applyState(st) {
    const stale = st && st.status === 'running' && Date.now() - st.updatedAt > 180000;
    const running = st && st.status === 'running' && !stale;
    $('btnScrape').disabled = running;
    $('btnClearCache').disabled = running; // altrimenti lo scraping in corso riscriverebbe i risultati subito dopo
    $('btnClearCacheAll').disabled = running;
    $('btnCancel').hidden = !running;
    $('progress').hidden = !running;
    if (running && st.total) { $('progress').max = st.total; $('progress').value = st.done || 0; }
    if (st) setStatus(st.text, st.status === 'error' ? 'err' : st.status === 'done' ? 'ok' : '');
  }

  // ---------------------------------------------------------------
  // Tabella e riepilogo
  // ---------------------------------------------------------------
  document.querySelectorAll('.view').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.view').forEach((b) => b.classList.toggle('active', b === btn));
    $('view-jobs').hidden = btn.dataset.view !== 'jobs';
    $('view-companies').hidden = btn.dataset.view !== 'companies';
  }));

  function renderCompanies() {
    const tbody = $('tableCo').tBodies[0];
    tbody.textContent = '';
    const rows = (results && results.companies) || [];
    $('cntCompanies').textContent = rows.length ? `(${rows.length})` : '';
    for (const c of rows) {
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      name.textContent = c.name;
      const nJobs = document.createElement('small');
      nJobs.textContent = c.jobs === 1 ? '1 annuncio' : `${c.jobs} annunci`;
      name.appendChild(nJobs);

      const biz = document.createElement('td');
      if (c.business) { // vuoto = non classificato con sicurezza: nessun chip
        const chip = document.createElement('span');
        chip.className = 'chip ' + c.business;
        chip.textContent = c.business;
        biz.appendChild(chip);
      }
      if (c.businessDesc) { // settore sotto il chip
        const desc = document.createElement('small');
        desc.textContent = c.businessDesc;
        biz.appendChild(desc);
      }

      const place = document.createElement('td'); place.textContent = [c.city, c.country].filter(Boolean).join(', ');

      const links = document.createElement('td');
      links.className = 'links';
      [[c.url, resultSite().label], [c.linkedin, 'LinkedIn']].forEach(([href, label]) => {
        if (!href) return;
        const a = document.createElement('a');
        a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label;
        links.appendChild(a);
      });

      tr.append(name, biz, place, links);
      tbody.appendChild(tr);
    }
  }

  /** Avvisi in un riquadro comprimibile con il conteggio (le liste lunghe non invadono più il popup). */
  function renderWarnings(list) {
    $('warnings').textContent = '';
    list.forEach((w) => {
      const li = document.createElement('li');
      li.textContent = w + (/selettor|card|Campo|Contenitore|Dettaglio/i.test(w) ? ' → vedi selectors.js' : '');
      $('warnings').appendChild(li);
    });
    $('warnBox').hidden = list.length === 0;
    $('warnCount').textContent = list.length === 1 ? '1 avviso' : `${list.length} avvisi`;
  }

  function render() {
    const tbody = $('table').tBodies[0];
    tbody.textContent = '';
    const jobs = (results && results.jobs) || [];
    $('cntJobs').textContent = jobs.length ? `(${jobs.length})` : '';
    renderCompanies();

    renderWarnings((results && results.meta.warnings) || []);

    if (!jobs.length) { $('summary').textContent = 'Nessun risultato.'; return; }
    const m = results.meta;
    $('summary').textContent =
      `${jobs.length} annunci (pagine ${m.pagesScraped[0]}–${m.pagesScraped[1]}` +
      (m.totalResults ? ` di ~${m.totalResults} risultati totali` : '') + ')' + (m.pagesFailed && m.pagesFailed.length ? ` — ⚠ pagine non lette: ${m.pagesFailed.join(', ')}` : '') + (m.cancelled ? ' — interrotto' : '');

    for (const j of jobs) {
      const tr = document.createElement('tr');

      const score = document.createElement('td');
      const s = j.match && j.match.score;
      const pill = document.createElement('span');
      pill.className = 'pill ' + (s == null ? 'low' : s >= 70 ? 'high' : s >= 40 ? 'mid' : 'low');
      pill.textContent = s == null ? '–' : s + '%';
      if (j.match && j.match.matchedSkills.length) pill.title = 'Skill: ' + j.match.matchedSkills.join(', ');
      score.appendChild(pill);

      const title = document.createElement('td');
      const a = document.createElement('a');
      a.href = j.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = j.title || '(senza titolo)';
      const small = document.createElement('small');
      small.textContent = [j.company, j.contractType, j.remote].filter(Boolean).join(' · ');
      title.append(a, small);

      const loc = document.createElement('td'); loc.textContent = j.location;
      const sal = document.createElement('td'); sal.textContent = formatSalary(j);
      const est = salaryEstimate(j);
      if (est) sal.title = est;

      tr.append(score, title, loc, sal);
      tbody.appendChild(tr);
    }
  }

  // ---------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------
  function download(filename, mime, content) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

  $('btnJson').addEventListener('click', () => {
    if (!results) return;
    download(`${filePrefix()}-${stamp()}.json`, 'application/json', JSON.stringify(results, null, 2));
  });

  // Colonne annunci per CSV/XLSX (le colonne aziende vengono da companies.js)
  const JOB_COLUMNS = [
    { key: 'score', label: 'Affinità %', number: true },
    { key: 'title', label: 'Titolo' },
    { key: 'company', label: 'Azienda' },
    { key: 'location', label: 'Luogo' },
    { key: 'remote', label: 'Home office' },
    { key: 'contractType', label: 'Contratto' },
    { key: 'workType', label: 'Modalità' },
    { key: 'salary', label: 'Stipendio' },
    { key: 'currency', label: 'Valuta' },
    { key: 'postedAt', label: 'Data' },
    { key: 'matchedSkills', label: 'Skill trovate' },
    { key: 'missingSkills', label: 'Skill mancanti' },
    { key: 'url', label: 'Link', link: true },
    { key: 'id', label: 'ID' }
  ];

  /** Annuncio → riga piatta (score e skill dal match). */
  const jobRow = (j) => ({
    ...j,
    score: j.match && j.match.score,
    matchedSkills: j.match ? j.match.matchedSkills.join(', ') : '',
    missingSkills: j.match ? j.match.missingSkills.join(', ') : ''
  });

  function toCsv(columns, rows) {
    const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = [columns.map((c) => cell(c.label)).join(';'), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(';'))];
    // BOM + ";" come separatore: Excel (locale IT/DE) apre il file correttamente
    return '\ufeff' + lines.join('\r\n');
  }

  $('btnCsv').addEventListener('click', () => {
    if (!results) return;
    download(`${filePrefix()}-annunci-${stamp()}.csv`, 'text/csv;charset=utf-8', toCsv(JOB_COLUMNS, results.jobs.map(jobRow)));
  });

  $('btnCsvCo').addEventListener('click', () => {
    if (!results || !results.companies) return;
    download(`${filePrefix()}-aziende-${stamp()}.csv`, 'text/csv;charset=utf-8', toCsv(SSCompanies.COMPANY_COLUMNS, results.companies));
  });

  // XLSX: un solo file con due fogli. "Aziende" per primo: è la tabella di lavoro dell'utente.
  $('btnXlsx').addEventListener('click', () => {
    if (!results) return;
    const bytes = SSXlsx.buildXlsx([
      { name: 'Aziende', columns: SSCompanies.COMPANY_COLUMNS, rows: results.companies || [] },
      { name: 'Annunci', columns: JOB_COLUMNS, rows: results.jobs.map(jobRow) }
    ]);
    download(`${filePrefix()}-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes);
  });

  // ---------------------------------------------------------------
  // Cache: risultati e stato salvati. Profilo e opzioni NON sono cache e restano.
  // ---------------------------------------------------------------
  const siteKeys = (site) => [SSSites.resultsKey(site), SSSites.stateKey(site)];
  const allCacheKeys = () => SSSites.allCacheKeys().concat(SSSites.LEGACY_KEYS);

  const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  async function updateCacheSize() {
    const bytes = await chrome.storage.local.getBytesInUse(siteKeys(viewSite));
    $('cacheSize').textContent = bytes > 0 ? `(${formatBytes(bytes)})` : '';
    const total = await chrome.storage.local.getBytesInUse(allCacheKeys());
    $('cacheSizeAll').textContent = total > 0 ? `(${formatBytes(total)})` : '';
  }

  /** Svuota le chiavi date dopo conferma; `scope` dice nel messaggio cosa viene eliminato. */
  async function clearCache(keys, scope) {
    if (!window.confirm(`Eliminare gli annunci e le aziende estratti e lo stato salvato${scope}?\nIl profilo e le opzioni non vengono toccati.`)) return;
    await chrome.storage.local.remove(keys);
    chrome.runtime.sendMessage({ type: 'CLEAR_HIGHLIGHT' }).catch(() => { /* nessuna scheda supportata attiva */ });
    results = keys.includes(SSSites.resultsKey(viewSite)) ? null : results;
    render();
    setStatus('Cache svuotata ✓', 'ok');
    updateCacheSize();
  }

  $('btnClearCache').addEventListener('click', () => clearCache(siteKeys(viewSite), ` di ${viewSite.label}`));
  $('btnClearCacheAll').addEventListener('click', () => clearCache(allCacheKeys(), ' di tutti i siti'));

  // ---------------------------------------------------------------
  // Init + aggiornamenti live
  // ---------------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const rk = SSSites.resultsKey(viewSite), sk = SSSites.stateKey(viewSite);
    if (changes[sk]) applyState(changes[sk].newValue);
    if (changes[rk]) { results = changes[rk].newValue || null; render(); }
    // i risultati di un altro sito non cambiano la tabella, solo la dimensione della cache
    if (Object.keys(changes).some((k) => allCacheKeys().includes(k))) updateCacheSize();
  });

  /** Sito della scheda attiva (null se non è supportato). Passa dal service worker: il popup non ha il permesso "tabs". */
  async function activeTabSite() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ACTIVE_SITE' });
      return (res && res.ok && SSSites.byId(res.siteId)) || null;
    } catch (e) { return null; }
  }

  /** Etichetta sito: chip nell'intestazione e testi "il sito". `stale` = non è la scheda attiva. */
  function applySiteCopy(site, stale) {
    document.querySelectorAll('[data-site-name]').forEach((el) => { el.textContent = site.label; });
    const chip = $('siteChip');
    chip.textContent = stale ? `${site.label} · ultima estrazione` : site.label;
    chip.classList.toggle('stale', !!stale);
    chip.hidden = false;
    $('cacheScope').textContent = ' · ' + site.label;
  }

  (async function init() {
    // chiavi dello storage a slot unico (versioni precedenti) → per-sito; idempotente
    await SSSites.migrateFlatKeys(chrome.storage.local).catch(() => { /* ritenta alla prossima apertura */ });
    const [stored, tabSite] = await Promise.all([
      chrome.storage.local.get(['profile', 'options', 'lastSiteId'].concat(SSSites.allCacheKeys())),
      activeTabSite()
    ]);
    const { profile, options, lastSiteId } = stored;

    // sito mostrato: scheda attiva → ultimo usato → estrazione più recente → predefinito
    const scrapedAt = (s) => (stored[SSSites.resultsKey(s)].meta || {}).scrapedAt || '';
    const recent = SSSites.SITES.filter((s) => stored[SSSites.resultsKey(s)])
      .sort((a, b) => scrapedAt(b).localeCompare(scrapedAt(a)))[0];
    viewSite = tabSite || SSSites.byId(lastSiteId) || recent || SSSites.DEFAULT;
    applySiteCopy(viewSite, !tabSite);
    if (tabSite && tabSite.id !== lastSiteId) chrome.storage.local.set({ lastSiteId: tabSite.id });

    fillProfile(profile);
    if (options) {
      $('concurrency').value = options.concurrency || 5;
      $('enrich').checked = !!options.enrich;
      $('companyDetails').checked = options.companyDetails !== false;
      $('highlight').checked = options.highlight !== false;
    }
    results = stored[SSSites.resultsKey(viewSite)] || null;
    render();
    applyState(stored[SSSites.stateKey(viewSite)]);
    updateCacheSize();
  })();
})();
