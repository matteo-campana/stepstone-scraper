// Test dei parser su TotalJobs: pagina risultati e pagina dettaglio salvate (vedi fixtures.js),
// più salario/valuta che non richiedono pagine di esempio.
// Uso: cd extension/test && node totaljobs.test.js
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { FIXTURES: FX, fixturePath, readFixture, skip } = require('./fixtures.js');

const Content = require('../content.js');
const Match = require('../match.js');
const Companies = require('../companies.js');
const Sites = require('../sites.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓', name); };

// ---------- salario e valuta (senza pagine di esempio) ----------
ok('parseSalaryRange: tariffe giornaliere annualizzate (× WORK_DAYS_PER_YEAR)', () => {
  assert.equal(Match.WORK_DAYS_PER_YEAR, 220);
  assert.deepEqual(Match.parseSalaryRange('£500 - 550 per day'), { min: 110000, max: 121000 });
  assert.deepEqual(Match.parseSalaryRange('£700 per day'), { min: 154000, max: 154000 });
  assert.deepEqual(Match.parseSalaryRange('£700 - £750 per day + IR35 TBC'), { min: 154000, max: 165000 });
  assert.deepEqual(Match.parseSalaryRange('£700 to £765 per day'), { min: 154000, max: 168300 });
});

ok('parseSalaryRange: testi UK annui e non numerici', () => {
  assert.deepEqual(Match.parseSalaryRange('From £85,000 to £110,000 per annum'), { min: 85000, max: 110000 });
  assert.deepEqual(Match.parseSalaryRange('£40000 - £50000 per annum + £40,000-£50,000+ Excellent Benefits'), { min: 40000, max: 50000 });
  assert.deepEqual(Match.parseSalaryRange('£35k - £40k base salary + awesome benefits'), { min: 35000, max: 40000 });
  assert.deepEqual(Match.parseSalaryRange('57515.00'), { min: 57515, max: 57515 });
  for (const t of ['Outside IR35', 'Competitive', 'Negotiable depending on experience', 'Unspecified', '']) {
    assert.equal(Match.parseSalaryRange(t), null, t);
  }
});

ok('parseSalaryRange: i casi StepStone esistenti restano identici (forma {min,max})', () => {
  assert.deepEqual(Match.parseSalaryRange('55.000 - 83.000 €/ (geschätzt für Vollzeit)'), { min: 55000, max: 83000 });
  assert.deepEqual(Match.parseSalaryRange('66.000€ - 88.000€/Jahr'), { min: 66000, max: 88000 });
  assert.deepEqual(Match.parseSalaryRange('4.000 € pro Monat'), { min: 48000, max: 48000 });
});

ok('salaryBasis e detectCurrency', () => {
  assert.equal(Match.salaryBasis('£700 per day'), 'day');
  assert.equal(Match.salaryBasis('£40000 per annum'), 'year');
  assert.equal(Match.salaryBasis('4.000 € pro Monat'), 'month');
  assert.equal(Match.detectCurrency('£40000 per annum', 'EUR'), 'GBP');
  assert.equal(Match.detectCurrency('55.000 €', 'GBP'), 'EUR');
  assert.equal(Match.detectCurrency('57515.00', 'GBP'), 'GBP'); // nessun simbolo → valuta del sito
  assert.equal(Match.detectCurrency('', ''), '');
});

ok('countryName: GB da totaljobs.com, DE da stepstone.de, codice esplicito vince', () => {
  assert.equal(Companies.countryName('', 'www.totaljobs.com'), 'Regno Unito');
  assert.equal(Companies.countryName('', 'www.stepstone.de'), 'Germania');
  assert.equal(Companies.countryName('FR', 'www.totaljobs.com'), 'Francia');
  assert.equal(Companies.countryName('', 'example.com'), '');
});

ok('classifyBusiness: termini UK inequivocabili, niente falsi positivi', () => {
  assert.equal(Companies.classifyBusiness('Cadence Resourcing Limited', []), 'Recruiting');
  assert.equal(Companies.classifyBusiness('Acme Talent Acquisition Ltd', []), 'Recruiting');
  assert.equal(Companies.classifyBusiness('Hays', ['IT & Tech']), '');
  assert.equal(Companies.classifyBusiness('Bright Solutions People Group', []), '');
});

ok('extractCompanyPassport: "companyPassportData": null non aggancia l\'oggetto successivo', () => {
  const doc = new JSDOM('<script>window.x = {"companyPassportData": null, "other": {"id": 7, "name": "X"}}</script>').window.document;
  assert.equal(Content.extractCompanyPassport(doc), null);
  const doc2 = new JSDOM('<script>window.x = {"companyPassportData": {"id": 5, "name": "Y"}, "z": 1}</script>').window.document;
  assert.deepEqual(Content.extractCompanyPassport(doc2), { id: 5, name: 'Y' });
});

ok('sanePageTotal: 25 pagine con 466 risultati non viene corretto; 5212345 sì', () => {
  assert.equal(Content.sanePageTotal(25, 466, 25, 2), 25);
  assert.equal(Content.sanePageTotal(25, 466, 25), 25);
  assert.equal(Content.sanePageTotal(5212345, 466, 25, 2), 19);
  assert.equal(Content.sanePageTotal(5212345, 1294, 25), 52);
});

// ---------- pagina risultati ----------
if (!fixturePath(FX.totaljobs.result)) {
  skip(FX.totaljobs.result);
} else {
  const resUrl = 'https://www.totaljobs.com/jobs/dynamics-365';
  const res = new JSDOM(readFixture(FX.totaljobs.result), { url: resUrl }).window.document;
  const warnings = [];
  const jobs = Content.parseResultCards(res, resUrl, warnings);

  ok('rileva pagina risultati e sito', () => {
    assert.equal(Content.detectPageType(res), 'results');
    assert.equal(Content.activeSite().id, 'totaljobs');
  });

  ok('25 card della lista (125 grezze: le altre sono nei blocchi raccomandazioni), nessun avviso', () => {
    assert.equal(jobs.length, 25);
    assert.deepEqual(warnings, []);
  });

  ok('prima card: id/titolo/azienda/luogo/url', () => {
    const j = jobs[0];
    assert.equal(j.id, '108060738');
    assert.equal(j.title, 'Technical Lead - D365');
    assert.equal(j.company, 'Cadence Resourcing Limited');
    assert.equal(j.location, 'London');
    assert.equal(j.url, 'https://www.totaljobs.com/job/technical-lead-d365/cadence-resourcing-limited-job108060738');
  });

  ok('azienda: companyId da ?cmpId= e link del logo', () => {
    assert.equal(jobs[0].companyId, '1389546');
    assert.match(jobs[0].companyUrl, /^https:\/\/www\.totaljobs\.com\/jobs\/cadence-resourcing-limited\?cmpId=1389546/);
    assert.ok(jobs.every((j) => j.companyId), 'ogni card ha un companyId');
  });

  ok('stipendio da data-at="job-item-salary-info" (anche testi non numerici) + valuta', () => {
    assert.equal(jobs[0].salary, 'Outside IR35');
    assert.equal(jobs[2].salary, 'From £85,000 to £110,000 per annum');
    assert.equal(jobs.filter((j) => j.salary).length, 21);
    for (const j of jobs) assert.equal(j.currency, j.salary ? 'GBP' : '', j.salary);
  });

  ok('remote e badges assenti su TotalJobs: vuoti, senza avvisi', () => {
    assert.ok(jobs.every((j) => j.remote === '' && Array.isArray(j.badges) && j.badges.length === 0));
    assert.ok(!warnings.some((w) => /remote|badge/i.test(w)));
  });

  ok('ID univoci', () => assert.equal(new Set(jobs.map((j) => j.id)).size, jobs.length));

  ok('paginazione: 1 di 25, 466 risultati, fonte "status"', () => {
    const p = Content.getPagination(res, resUrl);
    assert.deepEqual(p, { current: 1, total: 25, totalResults: 466, totalSource: 'status' });
    assert.equal(Content.sanePageTotal(p.total, p.totalResults, jobs.length, Sites.byId('totaljobs').pageTotalSlack), 25);
  });

  ok('buildPageUrl: rimuove action=paging_next e mantiene il percorso', () => {
    assert.equal(Content.buildPageUrl('https://www.totaljobs.com/jobs/dynamics-365?page=2&action=paging_next', 3),
      'https://www.totaljobs.com/jobs/dynamics-365?page=3');
  });

  ok('buildCompanies: Paese GB dal dominio, raggruppamento per cmpId', () => {
    const rows = Companies.buildCompanies(jobs, 'www.totaljobs.com');
    assert.ok(rows.length > 0 && rows.length <= jobs.length);
    assert.ok(rows.every((r) => r.country === 'Regno Unito'));
    const cadence = rows.find((r) => r.name === 'Cadence Resourcing Limited');
    assert.equal(cadence.business, 'Recruiting');
    assert.equal(cadence.companyId, '1389546');
  });

  ok('card: <style> inline dentro i campi non finisce nel testo estratto', () => {
    const css = '.res-8wkck8{box-sizing:border-box;margin:0;}';
    const doc = new JSDOM(readFixture(FX.totaljobs.result), { url: resUrl }).window.document;
    doc.querySelectorAll('article[data-at="job-item"] span, article[data-at="job-item"] h2').forEach((el) => {
      const st = doc.createElement('style'); st.textContent = css; el.prepend(st);
    });
    const dirty = Content.parseResultCards(doc, resUrl, []);
    assert.equal(dirty.length, 25);
    for (const j of dirty) for (const v of [j.title, j.company, j.location, j.salary, j.snippet]) assert.ok(!v.includes('box-sizing'), v);
    assert.equal(dirty[0].title, 'Technical Lead - D365');
    assert.equal(dirty[0].salary, 'Outside IR35');
  });
}

// ---------- pagina dettaglio ----------
if (!fixturePath(FX.totaljobs.detail)) {
  skip(FX.totaljobs.detail);
} else {
  const detUrl = 'https://www.totaljobs.com/job/senior-d365-developer/hays-job107972653';
  const det = new JSDOM(readFixture(FX.totaljobs.detail), { url: detUrl }).window.document;
  const dw = [];
  const d = Content.parseDetail(det, dw, detUrl);

  ok('rileva pagina dettaglio', () => assert.equal(Content.detectPageType(det), 'detail'));

  ok('dettaglio: titolo/azienda/luogo/contratto/stipendio/valuta', () => {
    assert.equal(d.title, 'Senior D365 Developer');
    assert.equal(d.company, 'Hays');
    assert.match(d.location, /^Newcastle/);
    assert.equal(d.contractType, 'Permanent Contract; Hybrid');
    assert.match(d.salary, /^£40000/);
    assert.equal(d.currency, 'GBP');
    assert.equal(d.employmentType, 'TEMPORARY');
  });

  ok('dettaglio: descrizione presente; requisiti/benefit assenti sul sito e senza avviso "vuoto"', () => {
    assert.ok(d.description.length > 3000, String(d.description.length));
    assert.match(d.description, /Dynamics 365/);
    assert.equal(d.requirements, '');
    assert.equal(d.benefits, '');
    assert.ok(!dw.some((w) => /Dettaglio vuoto/.test(w)), dw.join(' | '));
  });

  ok('dettaglio: scheda azienda da reduxPreloadedState (il passport StepStone qui è null)', () => {
    assert.equal(Content.extractCompanyPassport(det), null);
    const c = d.companyInfo;
    assert.equal(c.id, '1341189');
    assert.equal(c.name, 'Hays');
    assert.match(c.url, /cmpId=1341189/);
    assert.deepEqual(c.industries, ['IT & Tech']);
    assert.equal(c.industriesFromCompany, true);
    assert.equal(c.country, 'GB');
    assert.match(c.city, /^Newcastle/);
  });

  ok('job.currency propagato dal dettaglio quando la card non ha stipendio', () => {
    assert.equal(Match.detectCurrency(d.salary, 'EUR'), 'GBP');
  });
}

console.log(`\n${n} test TotalJobs passati`);
