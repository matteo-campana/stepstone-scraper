// Test offline dei parser sulle pagine salvate nella radice del repo.
// Uso: cd extension/test && npm install && npm test
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const Content = require('../content.js');
const Match = require('../match.js');
const Companies = require('../companies.js');
const Xlsx = require('../xlsx.js');
const os = require('node:os');

// Le pagine StepStone di esempio non sono nel repo (pesano ~8 MB): indicare la cartella con
// STEPSTONE_FIXTURES=<cartella> (di default la radice del repo). Senza le pagine i test vengono saltati.
const FIXTURES = process.env.STEPSTONE_FIXTURES || path.join(__dirname, '..', '..');
if (!fs.existsSync(path.join(FIXTURES, 'stepston-result-page.html'))) {
  console.log('SALTATO: pagine di esempio non trovate in ' + FIXTURES + ' (impostare STEPSTONE_FIXTURES).');
  process.exit(0);
}
const load = (f, url) => new JSDOM(fs.readFileSync(path.join(FIXTURES, f), 'utf8'), { url }).window.document;
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
