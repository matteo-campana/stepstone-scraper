/**
 * popup.js — UI: profilo utente, avvio scraping, tabella risultati, export.
 *
 * Il lavoro pesante avviene nel content script; qui si legge solo lo stato
 * da chrome.storage.local (scrapeState, lastResults), quindi chiudere il
 * popup durante lo scraping non interrompe nulla.
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const PROFILE_FIELDS = ['skills', 'years', 'position', 'salaryMin', 'salaryMax', 'locations'];

  const ERRORS = {
    WRONG_DOMAIN: 'La scheda attiva non è StepStone (domini supportati: .de, .at, .be, .nl, .fr).',
    NOT_RESULTS_PAGE: 'Questa non è una pagina di risultati di ricerca. Apri una ricerca (es. stepstone.de/jobs/...) e riprova.',
    NO_TAB: 'Nessuna scheda attiva trovata.',
    ALREADY_RUNNING: 'Uno scraping è già in corso su questa scheda.',
    NO_RESPONSE: 'La pagina non risponde. Ricarica la scheda StepStone (F5) e riprova.'
  };
  const errText = (code) => ERRORS[code] || `Errore: ${code}`;

  let results = null; // { jobs, meta }

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
      await chrome.storage.local.set({ lastResults: results });
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
    $('warnings').innerHTML = '';
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

  const linkCell = (href, text) => {
    const td = document.createElement('td');
    if (href) {
      const a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
      td.appendChild(a);
    }
    return td;
  };

  function renderCompanies() {
    const tbody = $('tableCo').tBodies[0];
    tbody.textContent = '';
    const rows = (results && results.companies) || [];
    $('cntCompanies').textContent = rows.length ? `(${rows.length})` : '';
    for (const c of rows) {
      const tr = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = c.name;
      const biz = document.createElement('td');
      biz.className = 'biz ' + c.business.split(' ')[0];
      biz.textContent = c.business;
      const desc = document.createElement('td'); desc.textContent = c.businessDesc;
      const country = document.createElement('td'); country.textContent = c.country;
      const city = document.createElement('td'); city.textContent = c.city;
      const n = document.createElement('td'); n.textContent = c.jobs;
      tr.append(name, linkCell(c.url, 'StepStone'), linkCell(c.linkedin, 'cerca'), biz, desc, country, city, n);
      tbody.appendChild(tr);
    }
  }

  function render() {
    const tbody = $('table').tBodies[0];
    tbody.textContent = '';
    const jobs = (results && results.jobs) || [];
    $('cntJobs').textContent = jobs.length ? `(${jobs.length})` : '';
    renderCompanies();

    $('warnings').textContent = '';
    ((results && results.meta.warnings) || []).forEach((w) => {
      const li = document.createElement('li');
      li.textContent = w + (/selettor|card|Campo|Contenitore|Dettaglio/i.test(w) ? ' → vedi selectors.js' : '');
      $('warnings').appendChild(li);
    });

    if (!jobs.length) { $('summary').textContent = 'Nessun risultato.'; return; }
    const m = results.meta;
    $('summary').textContent =
      `${jobs.length} annunci (pagine ${m.pagesScraped[0]}–${m.pagesScraped[1]}` +
      (m.totalResults ? ` di ~${m.totalResults} risultati totali` : '') + ')' + (m.pagesFailed && m.pagesFailed.length ? ` — ⚠ pagine non lette: ${m.pagesFailed.join(', ')}` : '') + (m.cancelled ? ' — interrotto' : '');

    for (const j of jobs) {
      const tr = document.createElement('tr');

      const score = document.createElement('td');
      const s = j.match && j.match.score;
      score.className = 'score ' + (s == null ? '' : s >= 70 ? 'high' : s >= 40 ? 'mid' : 'low');
      score.textContent = s == null ? '–' : s + '%';
      if (j.match && j.match.matchedSkills.length) score.title = 'Skill: ' + j.match.matchedSkills.join(', ');

      const title = document.createElement('td');
      const a = document.createElement('a');
      a.href = j.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = j.title || '(senza titolo)';
      const small = document.createElement('small');
      small.textContent = [j.company, j.contractType, j.remote].filter(Boolean).join(' · ');
      title.append(a, small);

      const loc = document.createElement('td'); loc.textContent = j.location;
      const sal = document.createElement('td'); sal.textContent = (j.salary || '').replace(/\s*\(.*\)/, '');

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
    download(`stepstone-${stamp()}.json`, 'application/json', JSON.stringify(results, null, 2));
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
    download(`stepstone-annunci-${stamp()}.csv`, 'text/csv;charset=utf-8', toCsv(JOB_COLUMNS, results.jobs.map(jobRow)));
  });

  $('btnCsvCo').addEventListener('click', () => {
    if (!results || !results.companies) return;
    download(`stepstone-aziende-${stamp()}.csv`, 'text/csv;charset=utf-8', toCsv(SSCompanies.COMPANY_COLUMNS, results.companies));
  });

  // XLSX: un solo file con due fogli. "Aziende" per primo: è la tabella di lavoro dell'utente.
  $('btnXlsx').addEventListener('click', () => {
    if (!results) return;
    const bytes = SSXlsx.buildXlsx([
      { name: 'Aziende', columns: SSCompanies.COMPANY_COLUMNS, rows: results.companies || [] },
      { name: 'Annunci', columns: JOB_COLUMNS, rows: results.jobs.map(jobRow) }
    ]);
    download(`stepstone-${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes);
  });

  // ---------------------------------------------------------------
  // Init + aggiornamenti live
  // ---------------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.scrapeState) applyState(changes.scrapeState.newValue);
    if (changes.lastResults) { results = changes.lastResults.newValue || null; render(); }
  });

  (async function init() {
    const { profile, options, lastResults, scrapeState } = await chrome.storage.local.get(['profile', 'options', 'lastResults', 'scrapeState']);
    fillProfile(profile);
    if (options) {
      $('concurrency').value = options.concurrency || 5;
      $('enrich').checked = !!options.enrich;
      $('companyDetails').checked = options.companyDetails !== false;
      $('highlight').checked = options.highlight !== false;
    }
    results = lastResults || null;
    render();
    applyState(scrapeState);
  })();
})();
