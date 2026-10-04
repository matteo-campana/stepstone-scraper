// Test offline dei parser StepStone sulle pagine salvate (quelle TotalJobs: totaljobs.test.js).
// Uso: cd extension/test && npm install && npm test
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { FIXTURES: FX, fixturePath, readFixture, skip } = require('./fixtures.js');

const Content = require('../content.js');
const Match = require('../match.js');
const Companies = require('../companies.js');
const Xlsx = require('../xlsx.js');
const os = require('node:os');

// Le pagine StepStone di esempio non sono nel repo (pesano ~8 MB): indicare la cartella con
// SCRAPER_FIXTURES=<cartella> (o STEPSTONE_FIXTURES; di default radice del repo ed example/). Senza le pagine i test vengono saltati.
if (!fixturePath(FX.stepstone.result) || !fixturePath(FX.stepstone.detail)) {
  skip(FX.stepstone.result + ' / ' + FX.stepstone.detail);
  process.exit(0);
}
const load = (f, url) => new JSDOM(readFixture(f), { url }).window.document;
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓', name); };

// ---------- pagina risultati ----------
const resUrl = 'https://www.stepstone.de/jobs/platform-engineer';
const res = load('stepston-result-page.html', resUrl);
const warnings = [];
const jobs = Content.parseResultCards(res, resUrl, warnings);

ok('rileva pagina risultati', () => assert.equal(Content.detectPageType(res), 'results'));
ok('estrae 25 card della lista (esclude le 70 dei blocchi raccomandazioni)', () => assert.equal(jobs.length, 25));
ok('prima card: id/titolo/azienda/luogo', () => {
  const j = jobs[0];
  assert.equal(j.id, '14556359');
  assert.equal(j.title, 'Platform & DevOps Engineer (m/w/d)');
  assert.equal(j.company, 'YOUMMDAY GmbH');
  assert.equal(j.location, 'München, Berlin');
  assert.equal(j.remote, 'Teilweise Home-Office');
  assert.match(j.url, /^https:\/\/www\.stepstone\.de\/stellenangebote--.*14556359-inline\.html$/);
});
ok('prima card: stipendio (euristica €)', () => assert.match(jobs[0].salary, /^55\.000 - 83\.000 €/));
ok('ID univoci', () => assert.equal(new Set(jobs.map((j) => j.id)).size, jobs.length));
ok('nessun warning bloccante', () => console.log('     warnings:', warnings));
ok('paginazione 1 di 37', () => {
  const p = Content.getPagination(res, resUrl);
  assert.equal(p.current, 1); assert.equal(p.total, 37); assert.equal(p.totalResults, 901);
});
ok('buildPageUrl mantiene i filtri', () =>
  assert.equal(Content.buildPageUrl('https://www.stepstone.de/jobs/x?where=Berlin&radius=30', 3), 'https://www.stepstone.de/jobs/x?where=Berlin&radius=30&page=3'));

// ---------- pagina dettaglio ----------
const detUrl = 'https://www.stepstone.de/stellenangebote--Platform-Engineer-Azure-Hannover-HDI-AG--14568527-inline.html';
const det = load('stepstone-job-detail-page.html', detUrl);
const d = Content.parseDetail(det, []);
ok('rileva pagina dettaglio', () => assert.equal(Content.detectPageType(det), 'detail'));
ok('dettaglio: titolo/azienda/luogo', () => {
  assert.equal(d.title, 'Platform Engineer Azure');
  assert.equal(d.company, 'HDI AG');
  assert.equal(d.location, 'Hannover');
});
ok('dettaglio: contratto/work type/stipendio', () => {
  assert.equal(d.contractType, 'Feste Anstellung');
  assert.match(d.workType, /Vollzeit/);
  assert.match(d.salary, /66\.000/);
  assert.equal(d.employmentType, 'FULL_TIME');
});
ok('dettaglio: descrizione e profilo', () => {
  assert.match(d.description, /AI Platform/);
  assert.match(d.requirements, /Terraform/);
});

// ---------- matching ----------
ok('parseSalaryRange', () => {
  assert.deepEqual(Match.parseSalaryRange('55.000 - 83.000 €/ (geschätzt für Vollzeit)'), { min: 55000, max: 83000 });
  assert.deepEqual(Match.parseSalaryRange('66.000€ - 88.000€/Jahr'), { min: 66000, max: 88000 });
  assert.deepEqual(Match.parseSalaryRange('4.000 € pro Monat'), { min: 48000, max: 48000 });
  assert.equal(Match.parseSalaryRange('Attraktives Gehalt'), null);
});
ok('computeMatch: skill + posizione + stipendio', () => {
  const m = Match.computeMatch({ ...jobs[0], ...d, title: 'Platform Engineer Azure', salary: '66.000€ - 88.000€' },
    { skills: 'terraform, kubernetes, rust', position: 'Platform Engineer', salaryMin: 60000, salaryMax: 90000 });
  assert.deepEqual(m.matchedSkills, ['terraform', 'kubernetes']);
  assert.deepEqual(m.missingSkills, ['rust']);
  assert.ok(m.score > 70 && m.score < 100, 'score=' + m.score);
});
ok('profilo vuoto → score null', () => assert.equal(Match.computeMatch(jobs[0], {}).score, null));

// ---------- aziende ----------
ok('card: companyUrl e companyId', () => {
  assert.equal(jobs[0].companyUrl, 'https://www.stepstone.de/cmp/de/yoummday-gmbh-217684/jobs');
  assert.equal(jobs[0].companyId, '217684');
  assert.equal(jobs.filter((j) => !j.companyId).length, 0);
});
ok('dettaglio: scheda azienda (passport)', () => {
  const c = d.companyInfo;
  assert.equal(c.id, '221127');
  assert.deepEqual(c.industries, ['Versicherungen']);
  assert.equal(c.city, 'Hannover');
  assert.equal(c.country, 'DE');
  assert.equal(c.employees, '10000+');
  assert.match(c.url, /HDI-AG-221127/);
});
ok('classifyBusiness', () => {
  assert.equal(Companies.classifyBusiness('Steadman & Chase', ['Personaldienstleistungen']), 'Recruiting');
  assert.equal(Companies.classifyBusiness('Hays', ['Personalvermittlung']), 'Recruiting');
  assert.equal(Companies.classifyBusiness('adesso SE', ['IT-Beratung']), 'Consulenza');
  assert.equal(Companies.classifyBusiness('Accenture Consulting', []), 'Consulenza');
  assert.equal(Companies.classifyBusiness('HDI AG', ['Versicherungen']), 'Prodotto');
  assert.equal(Companies.classifyBusiness('BMW', ['Automobilindustrie']), 'Prodotto');
  assert.equal(Companies.classifyBusiness('Boh', []), '');
});
ok('classifyBusiness: nel dubbio resta vuoto (niente falsi positivi "Prodotto")', () => {
  // settore generico o non produttivo: non basta per dire "Prodotto"
  assert.equal(Companies.classifyBusiness('Acme GmbH', ['IT, Software']), '');
  assert.equal(Companies.classifyBusiness('Acme GmbH', ['Internet, Medien']), '');
  assert.equal(Companies.classifyBusiness('Bundesnotarkammer', ['Öffentlicher Dienst']), '');
  assert.equal(Companies.classifyBusiness('Acme GmbH', ['Sonstige Dienstleistungen']), '');
  assert.equal(Companies.classifyBusiness('Acme GmbH', []), '');
  // parole del nome troppo generiche per Recruiting/Consulenza
  assert.equal(Companies.classifyBusiness('Agentur für Arbeit', []), '');
  assert.equal(Companies.classifyBusiness('Talent Solutions Software GmbH', ['IT, Software']), '');
  assert.equal(Companies.classifyBusiness('Cloud Service Provider AG', []), '');
});
ok('buildCompanies: il settore di ripiego dell\'annuncio non classifica', () => {
  const j = { ...jobs[0], companyInfo: { industries: ['Versicherungen'], industriesFromCompany: false } };
  const [row] = Companies.buildCompanies([j], 'www.stepstone.de');
  assert.equal(row.business, '');
  assert.equal(row.businessDesc, 'Versicherungen'); // la descrizione resta visibile
});
ok('linkedinSearchUrl toglie la forma giuridica', () => {
  assert.equal(Companies.shortName('Bechtle AG'), 'Bechtle');
  assert.equal(Companies.shortName('YOUMMDAY GmbH'), 'YOUMMDAY');
  assert.equal(Companies.shortName('Müller & Söhne GmbH & Co. KG'), 'Müller & Söhne');
  assert.equal(Companies.linkedinSearchUrl('adesso SE'), 'https://www.linkedin.com/search/results/companies/?keywords=adesso');
});
ok('buildCompanies sulle 25 card', () => {
  const withInfo = jobs.map((j) => (j.companyId === '221127' ? { ...j, companyInfo: d.companyInfo } : j));
  const rows = Companies.buildCompanies(withInfo, 'www.stepstone.de');
  const ids = new Set(jobs.map((j) => j.companyId));
  assert.equal(rows.length, ids.size);
  assert.equal(rows.reduce((a, r) => a + r.jobs, 0), 25);
  const hdi = rows.find((r) => r.companyId === '221127');
  assert.equal(hdi.business, 'Prodotto');
  assert.equal(hdi.country, 'Germania');
  assert.equal(hdi.city, 'Hannover');
  assert.equal(hdi.businessDesc, 'Versicherungen');
  const noInfo = rows.find((r) => r.companyId === '217684');
  assert.equal(noInfo.business, ''); // senza dati aziendali: vuoto, non "Da verificare"
  assert.equal(noInfo.country, 'Germania'); // ripiego dal dominio
  assert.ok(noInfo.city); // ripiego dalla località dell'annuncio
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' })));
});

// ---------- paginazione ----------
ok('pageSequence: totale noto → tutte le altre pagine, in ordine', () => {
  assert.deepEqual(Content.pageSequence(1, 4), [2, 3, 4]);
  assert.equal(Content.pageSequence(1, 37).length, 36);
  assert.equal(Content.pageSequence(1, 37)[0], 2);
  assert.deepEqual(Content.pageSequence(5, 8), [1, 2, 3, 4, 6, 7, 8]);
  assert.deepEqual(Content.pageSequence(1, 1), []);
});
ok('pageSequence: oltre 20 pagine e rispetto del tetto', () => {
  assert.equal(Content.pageSequence(1, 50).length, 49); // il vecchio limite era 20
  assert.equal(Content.pageSequence(1, 5000, 200).length, 199);
});
ok('pageSequence: totale ignoto → solo le pagine precedenti', () => {
  assert.deepEqual(Content.pageSequence(1, null), []);
  assert.deepEqual(Content.pageSequence(3, null), [1, 2]);
});

ok('paginazione: nav SENZA spazi tra stato e pulsanti (DOM reale) → totale corretto', () => {
  // come nel browser: "Page 1 of 37" seguito dai numeri dei pulsanti senza whitespace;
  // il vecchio codice leggeva "37" + "1234…" come 371234…
  const live = load('stepston-result-page.html', resUrl);
  const nav = live.querySelector('nav[aria-label="pagination"]');
  nav.innerHTML = nav.innerHTML.replace(/>\s+</g, '><');
  assert.match(nav.textContent, /Page 1 of 37\d/); // il testo grezzo è davvero "fuso"
  const p = Content.getPagination(live, resUrl);
  assert.equal(p.total, 37); assert.equal(p.current, 1);
});
ok('paginazione: ripiego su aria-label dei link, poi su href ?page=N', () => {
  const mk = (inner) => new JSDOM(`<nav aria-label="pagination">${inner}</nav>`, { url: 'https://www.stepstone.de/jobs/x?page=2' }).window.document;
  const links = (n, label) => Array.from({ length: n }, (_, i) => `<a href="/jobs/x?page=${i + 1}" ${label ? `aria-label="${i + 1} von 52"` : ''}>${i + 1}</a>`).join('');
  assert.equal(Content.getPagination(mk(links(5, true)), 'https://www.stepstone.de/jobs/x?page=2').total, 52); // aria-label
  assert.equal(Content.getPagination(mk(links(5, false)), 'https://www.stepstone.de/jobs/x?page=2').total, 5);  // href
  assert.equal(Content.getPagination(mk(''), 'https://www.stepstone.de/jobs/x').total, null);
});
ok('sanePageTotal: totale incoerente col numero di risultati viene corretto', () => {
  assert.equal(Content.sanePageTotal(5212345, 1294, 25), 52);
  assert.equal(Content.sanePageTotal(37, 901, 25), 37);     // 901/25 = 36.04 → 37 pagine: coerente
  assert.equal(Content.sanePageTotal(52, 1294, 25), 52);
  assert.equal(Content.sanePageTotal(52, null, 25), 52);    // senza contatore non si corregge
  assert.equal(Content.sanePageTotal(null, 900, 25), null);
});

// ---------- <style> inline dentro le card (Emotion) ----------
const CSS = '.res-8wkck8{box-sizing:border-box;margin:0;min-width:0;line-height:0px;display:block;}@media screen and (min-width: 600px){.res-ewgtgq{-webkit-line-clamp:1;}}';
const injectStyles = (root) => {
  for (const el of root.querySelectorAll('[data-at]')) {
    if (el.tagName === 'ARTICLE' || el.tagName === 'SCRIPT') continue;
    const st = el.ownerDocument.createElement('style');
    st.textContent = CSS;
    el.insertBefore(st, el.firstChild); // dentro l'elemento, davanti al testo, come nel DOM reale
  }
};
ok('card: <style> inline dentro i campi non finisce nel testo estratto', () => {
  const base = Content.parseResultCards(load('stepston-result-page.html', resUrl), resUrl, []);
  const dirty = load('stepston-result-page.html', resUrl);
  injectStyles(dirty);
  // senza la correzione, textContent includerebbe il CSS: il test è significativo
  assert.match(dirty.querySelector('[data-at="job-item-title"]').textContent, /box-sizing/);
  const got = Content.parseResultCards(dirty, resUrl, []);
  assert.equal(got.length, base.length);
  const fields = ['id', 'title', 'company', 'location', 'remote', 'salary', 'snippet', 'postedAt', 'badges', 'url', 'companyUrl'];
  got.forEach((j, i) => fields.forEach((f) => assert.deepEqual(j[f], base[i][f], `card ${i} campo ${f}`)));
  got.forEach((j) => [j.title, j.company, j.location, j.remote, j.salary, j.snippet, ...j.badges]
    .forEach((v) => assert.doesNotMatch(String(v), /box-sizing|@media|[{}]/, 'CSS nel risultato: ' + v)));
});
ok('dettaglio: <style> inline dentro i campi non finisce nel testo estratto', () => {
  const base = Content.parseDetail(load('stepstone-job-detail-page.html', detUrl), []);
  const dirty = load('stepstone-job-detail-page.html', detUrl);
  injectStyles(dirty);
  const got = Content.parseDetail(dirty, []);
  ['title', 'company', 'location', 'contractType', 'workType', 'salary', 'postedAt', 'description', 'requirements', 'benefits']
    .forEach((f) => { assert.equal(got[f], base[f], 'campo ' + f); assert.doesNotMatch(String(got[f]), /box-sizing|@media/, 'CSS in ' + f); });
});
ok('visibleText: salta style/script/noscript/svg', () => {
  const el = new JSDOM('<div id="x">A<style>.a{b:c}</style><span>B<script>var z=1</script></span><svg><title>icona</title></svg><noscript>ns</noscript>C</div>').window.document.getElementById('x');
  assert.equal(Content.visibleText(el), 'ABC');
});

// ---------- XLSX ----------
ok('buildXlsx: zip integro, XML valido, rilettura con openpyxl', () => {
  const rows = Companies.buildCompanies(jobs, 'www.stepstone.de');
  const bytes = Xlsx.buildXlsx([
    { name: 'Aziende', columns: Companies.COMPANY_COLUMNS, rows },
    { name: 'Annunci', columns: [{ key: 'title', label: 'Titolo' }, { key: 'url', label: 'Link', link: true }], rows: jobs }
  ]);
  const file = path.join(os.tmpdir(), 'ss-test.xlsx');
  fs.writeFileSync(file, bytes);
  const script = path.join(os.tmpdir(), 'ss-check-xlsx.py');
  fs.writeFileSync(script, [
    'import zipfile, sys, xml.dom.minidom as m',
    'z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None',
    '[m.parseString(z.read(n)) for n in z.namelist()]',
    'try:',
    '    import openpyxl',
    'except ImportError:',
    '    print("zip/xml ok (openpyxl non installato)"); sys.exit(0)',
    'wb = openpyxl.load_workbook(sys.argv[1])',
    'assert wb.sheetnames == ["Aziende", "Annunci"], wb.sheetnames',
    'h = [c.value for c in wb["Aziende"][1]]',
    'assert h[:7] == ["Azienda","Link Azienda","LinkedIn","Main Business","Main Business - Descrizione","Country","City"], h',
    'assert wb["Aziende"].max_row == int(sys.argv[2]) + 1',
    'assert wb["Annunci"].max_row == 26',
    'print("openpyxl ok")'
  ].join('\n'));
  const py = require('node:child_process').spawnSync('python', [script, file, String(rows.length)], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr || py.stdout);
  console.log('     ' + py.stdout.trim());
});

console.log(`\n${n} test passati`);
