// Percorso StepStone senza pagine di esempio: una card sintetica con la stessa struttura (data-at, /cmp/, --ID-inline),
// più il passaggio di sito tra una chiamata e l'altra (il sito attivo dipende dall'URL passato al parser).
// Uso: cd extension/test && node synthetic.test.js
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const Content = require('../content.js');
const Companies = require('../companies.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const SS_URL = 'https://www.stepstone.de/jobs/platform-engineer';
const TJ_URL = 'https://www.totaljobs.com/jobs/dynamics-365';

const ssPage = (withId = true) => new JSDOM(`<html><body>
  <h1>901 Platform Engineer Jobs</h1><span data-at="search-jobs-count">901</span>
  <nav aria-label="pagination"><span role="status">Page 1 of 37</span><ul><li><a href="?page=1" aria-label="1 von 37">1</a></li></ul></nav>
  <div data-at="unified-resultlist">
    <article data-at="job-item" ${withId ? 'id="job-item-14556359"' : ''}>
      <a data-at="job-item-title" href="/stellenangebote--Platform-DevOps-Engineer--14556359-inline.html"><div>Platform &amp; DevOps Engineer (m/w/d)</div></a>
      <a data-at="company-logo" href="/cmp/de/yoummday-gmbh-217684/jobs"></a>
      <span data-at="job-item-company-name">YOUMMDAY GmbH</span>
      <span data-at="job-item-location">München, Berlin</span>
      <span data-at="job-item-work-from-home">Teilweise Home-Office</span>
      <span>55.000 - 83.000 €/ (geschätzt für Vollzeit)</span>
      <div data-at="jobcard-content">Snippet mit 5 € Bonus mehr</div>
      <span data-at="job-item-badge">Neu</span>
    </article>
  </div>
  <div data-at="resultListMainResultsCvRecommender"><article data-at="job-item" id="job-item-99999999"><a data-at="job-item-title" href="/x--99999999-inline.html">Raccomandato</a></article></div>
</body></html>`, { url: SS_URL }).window.document;

ok('StepStone: card, ID azienda da /cmp/, stipendio con euristica €, valuta EUR', () => {
  const w = [];
  const jobs = Content.parseResultCards(ssPage(), SS_URL, w);
  assert.equal(Content.activeSite().id, 'stepstone');
  assert.equal(jobs.length, 1, 'la card dei raccomandati è esclusa');
  const j = jobs[0];
  assert.equal(j.id, '14556359');
  assert.equal(j.title, 'Platform & DevOps Engineer (m/w/d)');
  assert.equal(j.company, 'YOUMMDAY GmbH');
  assert.equal(j.companyId, '217684');
  assert.equal(j.remote, 'Teilweise Home-Office');
  assert.deepEqual(j.badges, ['Neu']);
  assert.match(j.salary, /^55\.000 - 83\.000 €/);
  assert.equal(j.currency, 'EUR');
  assert.equal(j.url, 'https://www.stepstone.de/stellenangebote--Platform-DevOps-Engineer--14556359-inline.html');
  assert.deepEqual(w, []);
});

ok('StepStone: ID dall\'URL (--ID-inline) quando la card non ha id', () => {
  const jobs = Content.parseResultCards(ssPage(false), SS_URL, []);
  assert.equal(jobs[0].id, '14556359');
});

ok('StepStone: paginazione "Page 1 of 37" e 901 risultati', () => {
  const p = Content.getPagination(ssPage(), SS_URL);
  assert.deepEqual(p, { current: 1, total: 37, totalResults: 901, totalSource: 'status' });
  assert.equal(Content.sanePageTotal(p.total, p.totalResults, 25, 2), 37);
});

ok('il sito attivo segue l\'URL: StepStone → TotalJobs → StepStone', () => {
  const tj = new JSDOM(`<div data-at="unified-resultlist">
    <article data-at="job-item" id="job-item-108060738">
      <a data-at="job-item-title" href="/job/x/y-job108060738">Dev</a>
      <a data-at="company-logo" href="https://www.totaljobs.com/jobs/y?cmpId=55&cmp=1"></a>
      <span data-at="job-item-company-name">Y</span>
      <span data-at="job-item-salary-info">£700 per day</span>
    </article></div>`, { url: TJ_URL }).window.document;
  const a = Content.parseResultCards(ssPage(), SS_URL, []);
  const b = Content.parseResultCards(tj, TJ_URL, []);
  const c = Content.parseResultCards(ssPage(), SS_URL, []);
  assert.equal(a[0].companyId, '217684');
  assert.equal(b[0].companyId, '55');
  assert.equal(b[0].salary, '£700 per day');
  assert.equal(b[0].currency, 'GBP');
  assert.equal(c[0].companyId, '217684', 'tornando su StepStone il cmp/ è letto di nuovo con il formato giusto');
  assert.equal(Content.activeSite().id, 'stepstone');
  // l'elemento salary-info non è un selettore di StepStone: lì conta solo l'euristica
  assert.equal(c[0].salary.includes('£'), false);
});

ok('card TotalJobs senza data-at remote/badge: nessuna eccezione, campi vuoti', () => {
  const tj = new JSDOM(`<div data-at="unified-resultlist"><article data-at="job-item" id="job-item-108060738">
    <a data-at="job-item-title" href="/job/x/y-job108060738">Dev</a><span data-at="job-item-company-name">Y</span></article></div>`, { url: TJ_URL }).window.document;
  const [j] = Content.parseResultCards(tj, TJ_URL, []);
  assert.equal(j.remote, '');
  assert.deepEqual(j.badges, []);
  assert.equal(j.salary, '');
  assert.equal(j.currency, '');
});

ok('country di ripiego dal dominio, per sito', () => {
  const rows = (host, j) => Companies.buildCompanies([j], host)[0];
  assert.equal(rows('www.stepstone.at', { company: 'A', location: 'Wien' }).country, 'Austria');
  assert.equal(rows('www.totaljobs.com', { company: 'A', location: 'Leeds' }).country, 'Regno Unito');
});

console.log(`\n${n} test sintetici passati`);
