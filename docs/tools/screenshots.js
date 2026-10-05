// Screenshot della documentazione: apre popup.html e map.html dell'estensione in Chromium (Playwright)
// con chrome.* simulato e DATI DIMOSTRATIVI (aziende inventate), e salva i PNG in docs/screenshots/.
//
// Uso:  cd docs/tools && npm install && npm run screenshots
//       CHROMIUM_PATH=/percorso/chrome npm run screenshots   (se Playwright non ha un browser suo)
//
// Le tessere della mappa (server.arcgisonline.com) non vengono scaricate: lo sfondo è disegnato in
// locale con i confini di world-atlas (Natural Earth, pubblico dominio), così l'output è riproducibile
// anche offline. Nell'estensione vera lo sfondo è quello di Esri.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const topojson = require('topojson-client');

const EXT = path.join(__dirname, '..', '..', 'extension');
const OUT = path.join(__dirname, '..', 'screenshots');
const ORIGIN = 'https://ext.test/'; // finta origine dell'estensione, servita da page.route
const SCALE = 2;

// ---------------------------------------------------------------
// Dati dimostrativi
// ---------------------------------------------------------------
const PROFILE = {
  skills: 'terraform, kubernetes, azure, python', years: '5', position: 'Platform Engineer',
  salaryMin: '65000', salaryMax: '90000', locations: 'Berlin, München, Milano', remote: true
};
const OPTIONS = { concurrency: 5, enrich: false, companyDetails: true, highlight: true };

let seq = 1000;
const companyIds = new Map(); // stesso nome → stesso ID azienda, come sul sito
/** Annuncio con dati azienda; `co` = [nome, città, indirizzo, settore, paese ISO]. */
function job(host, co, title, score, extra = {}) {
  const [company, city, address, industry, country] = co;
  const id = String(++seq);
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!companyIds.has(company)) companyIds.set(company, String(40000 + companyIds.size * 137));
  const cid = companyIds.get(company);
  const skills = ['terraform', 'kubernetes', 'azure', 'python'];
  const matched = skills.slice(0, Math.max(1, Math.round(score / 25)));
  return {
    id, title, company, location: extra.location || city, remote: extra.remote || '', salary: extra.salary || '',
    contractType: extra.contractType || 'Feste Anstellung', currency: extra.currency || 'EUR',
    url: `https://${host}/stellenangebote--${slug}--${id}-inline.html`,
    companyId: cid, companyUrl: `https://${host}/cmp/de/${slug}-${cid}/jobs`,
    companyInfo: { id: cid, name: company, address, city, country, industries: industry ? [industry] : [], industriesFromCompany: !!industry },
    match: { score, matchedSkills: matched, missingSkills: skills.filter((s) => !matched.includes(s)) }
  };
}

const SS = 'www.stepstone.de';
const C = {
  nordlicht: ['Nordlicht Cloud GmbH', 'Hamburg', 'Am Sandtorkai 12, 20457 Hamburg', 'IT & Internet', 'DE'],
  isar: ['Isar Systemhaus AG', 'München', 'Leopoldstraße 50, 80802 München', 'Unternehmensberatung', 'DE'],
  spree: ['Spreewerk Mobility SE', 'Berlin', 'Friedrichstraße 120, 10117 Berlin', 'Automobil', 'DE'],
  rhein: ['Rheinblick Versicherung AG', 'Köln', 'Rheinauhafen 7, 50678 Köln', 'Versicherungen', 'DE'],
  main: ['Mainufer Bank AG', 'Frankfurt', 'Neue Mainzer Str. 20, 60311 Frankfurt am Main', 'Banken', 'DE'],
  neckar: ['Neckartal Maschinenbau GmbH', 'Stuttgart', 'Heilbronner Str. 86, 70191 Stuttgart', 'Maschinenbau', 'DE'],
  elbe: ['Elbtal Personalvermittlung GmbH', 'Dresden', 'Prager Str. 2, 01069 Dresden', 'Personaldienstleistungen', 'DE'],
  donau: ['Donaulog Software GmbH', 'Wien', 'Wiedner Hauptstraße 32, 1040 Wien', 'IT & Internet', 'AT'],
  alster: ['Alster Data Labs GmbH', 'Hamburg', 'Großer Burstah 31, 20457 Hamburg', '', 'DE'],
  pegnitz: ['Pegnitz Pharma AG', 'Nürnberg', 'Südliche Fürther Str. 9, 90429 Nürnberg', 'Pharma', 'DE'],
  leine: ['Leinebogen Energie GmbH', 'Hannover', 'Am Küchengarten 3, 30449 Hannover', 'Energie', 'DE'],
  fjord: ['Fjordbyte GmbH', 'Garching bei München', 'Lichtenbergstraße 8, 85748 Garching', 'IT & Internet', 'DE']
};

const stepstoneJobs = [
  job(SS, C.nordlicht, 'Senior Platform Engineer (m/w/d)', 92, { remote: 'Home-Office möglich', salary: '75.000 - 90.000 €' }),
  job(SS, C.isar, 'Cloud Engineer Azure (m/w/d)', 81, { salary: '68.000 - 82.000 € (geschätzt)' }),
  job(SS, C.spree, 'DevOps Engineer Kubernetes (m/w/d)', 77, { remote: 'Home-Office möglich' }),
  job(SS, C.nordlicht, 'Site Reliability Engineer (m/w/d)', 74, { salary: '70.000 - 85.000 €' }),
  job(SS, C.alster, 'Platform Engineer – Data (m/w/d)', 70, { remote: 'Teilweise Home-Office' }),
  job(SS, C.main, 'Infrastructure Engineer Terraform (m/w/d)', 63, { salary: '72.000 - 88.000 € (geschätzt)' }),
  job(SS, C.fjord, 'Kubernetes Platform Engineer (m/w/d)', 61, { remote: 'Home-Office möglich' }),
  job(SS, C.rhein, 'Cloud Architect (m/w/d)', 55, { salary: '80.000 - 95.000 €' }),
  job(SS, C.neckar, 'IT-Systemadministrator Linux (m/w/d)', 42),
  job(SS, C.pegnitz, 'DevOps Engineer GxP (m/w/d)', 38, { contractType: 'Befristeter Vertrag' }),
  job(SS, C.leine, 'Cloud Operations Engineer (m/w/d)', 34),
  job(SS, C.donau, 'Backend Developer Python (m/w/d)', 31, { location: 'Wien', salary: '55.000 - 65.000 €' }),
  job(SS, C.elbe, 'IT Consultant Cloud (m/w/d)', 22, { contractType: 'Arbeitnehmerüberlassung' })
];

const TJ = 'www.totaljobs.com';
const T = {
  thames: ['Thamesgate Digital Ltd', 'London', '18 Bankside, London SE1 9BU', 'IT & Telecoms', 'GB'],
  mersey: ['Merseyline Recruitment Ltd', 'Manchester', '1 Spinningfields, Manchester M3 3AP', 'Recruitment', 'GB']
};
const totaljobsJobs = [
  job(TJ, T.thames, 'Platform Engineer', 79, { salary: '£70,000 - £85,000 per annum', currency: 'GBP', contractType: 'Permanent' }),
  job(TJ, T.mersey, 'DevOps Contractor (Outside IR35)', 48, { salary: '£550 per day', currency: 'GBP', contractType: 'Contract' })
];

const LI = 'www.linkedin.com';
const L = {
  navigli: ['Navigli Tech S.r.l.', 'Milano', '', 'Software', 'IT'],
  tevere: ['Tevere Cloud S.p.A.', 'Roma', '', 'Servizi IT', 'IT']
};
const linkedinJobs = [
  job(LI, L.navigli, 'Platform Engineer', 73, { location: 'Milano, Lombardia, Italia', remote: 'Ibrido' }),
  job(LI, L.tevere, 'Cloud Engineer Azure', 58, { location: 'Roma, Lazio, Italia', remote: 'Da remoto' }),
  job(LI, C.isar, 'Platform Engineer', 68, { location: 'München, Bayern, Deutschland' })
];
for (const j of linkedinJobs) { j.companyUrl = `https://www.linkedin.com/company/${j.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/`; j.companyInfo.address = ''; }

// ---------------------------------------------------------------
// Pagina con chrome.* simulato
// ---------------------------------------------------------------
async function openPage(browser, file, store, viewport, { activeSite = 'stepstone' } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: SCALE, locale: 'it-IT' });
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN)) {
      const rel = decodeURIComponent(new URL(url).pathname.slice(1));
      let body = fs.readFileSync(path.join(EXT, rel));
      // solo per lo sfondo dimostrativo: rende la mappa Leaflet raggiungibile dall'esterno
      if (rel === 'map.js') body = String(body).replace('const map = L.map(', 'const map = window.__map = L.map(');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }[path.extname(rel)];
      return route.fulfill({ status: 200, contentType: type || 'application/octet-stream', body });
    }
    if (url.startsWith('data:')) return route.continue();
    return route.fulfill({ status: 404, body: '' }); // tessere e qualsiasi rete esterna: niente
  });
  await ctx.addInitScript(({ store, activeSite, origin }) => {
    const listeners = [];
    const pick = (keys) => keys == null ? { ...store } : Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, store[k]]));
    window.chrome = {
      storage: {
        local: {
          get: async (keys) => JSON.parse(JSON.stringify(pick(keys))),
          set: async (o) => { const ch = {}; for (const [k, v] of Object.entries(o)) { ch[k] = { newValue: v }; store[k] = v; } listeners.forEach((fn) => fn(ch, 'local')); },
          remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
          getBytesInUse: async (keys) => [].concat(keys || Object.keys(store)).reduce((n, k) => n + (k in store ? JSON.stringify(store[k]).length : 0), 0)
        },
        onChanged: { addListener: (fn) => listeners.push(fn) }
      },
      runtime: {
        getURL: (p) => origin + p,
        sendMessage: async (m) => m.type === 'ACTIVE_SITE' ? { ok: true, host: 'x', siteId: activeSite } : { ok: true }
      },
      tabs: { create: async () => ({}) }
    };
  }, { store, activeSite, origin: ORIGIN });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${file}]`, e.message));
  await page.goto(ORIGIN + file);
  return page;
}

/** Risultati salvati come li scrive il content script (results:<sito>), aziende calcolate da companies.js. */
function resultsStore() {
  global.SSSites = require(path.join(EXT, 'sites.js'));
  const Companies = require(path.join(EXT, 'companies.js'));
  const entry = (siteId, label, host, jobs, total) => ({
    jobs, companies: Companies.buildCompanies(jobs, host),
    meta: { pageUrl: `https://${host}/jobs/platform-engineer`, siteId, siteLabel: label, pagesScraped: [1, Math.ceil(total / 25)], pagesFailed: [], warnings: [], totalResults: total, scrapedAt: '2026-10-05T08:30:00.000Z' }
  });
  return {
    profile: PROFILE, options: OPTIONS, lastSiteId: 'stepstone',
    'results:stepstone': entry('stepstone', 'StepStone', SS, stepstoneJobs, stepstoneJobs.length),
    'results:totaljobs': entry('totaljobs', 'TotalJobs', TJ, totaljobsJobs, totaljobsJobs.length),
    'results:linkedin': entry('linkedin', 'LinkedIn', LI, linkedinJobs, linkedinJobs.length),
    'scrapeState:stepstone': { status: 'done', text: `Completato: ${stepstoneJobs.length} annunci, ${new Set(stepstoneJobs.map((j) => j.company)).size} aziende.`, updatedAt: Date.now() }
  };
}

/** Sfondo locale al posto delle tessere: mare, terre e confini da world-atlas, nomi di alcune città. */
async function drawBasemap(page) {
  const topo = require('world-atlas/countries-50m.json');
  const geo = topojson.feature(topo, topo.objects.countries);
  const borders = topojson.mesh(topo, topo.objects.countries, (a, b) => a !== b);
  const labels = { Berlin: [52.52, 13.405], Hamburg: [53.551, 9.994], München: [48.137, 11.575], Köln: [50.938, 6.96], Frankfurt: [50.11, 8.682], Stuttgart: [48.776, 9.183], Wien: [48.208, 16.373], Milano: [45.464, 9.19], Roma: [41.903, 12.496], London: [51.507, -0.128], Manchester: [53.48, -2.242], Paris: [48.857, 2.352], Dresden: [51.05, 13.738], Hannover: [52.375, 9.732], Nürnberg: [49.452, 11.077] };
  await page.evaluate(({ geo, borders, labels }) => {
    const map = window.__map;
    document.getElementById('map').style.background = '#d4dadc';
    map.createPane('land').style.zIndex = 250;
    map.createPane('labels').style.zIndex = 350;
    map.getPane('labels').style.pointerEvents = 'none';
    const r = L.svg({ pane: 'land', padding: 1 });
    L.geoJSON(geo, { pane: 'land', renderer: r, interactive: false, style: { stroke: false, fillColor: '#f4f4f2', fillOpacity: 1 } }).addTo(map);
    L.geoJSON(borders, { pane: 'land', renderer: r, interactive: false, style: { color: '#b9bec2', weight: 1, fill: false } }).addTo(map);
    for (const [name, ll] of Object.entries(labels)) {
      L.marker(ll, { pane: 'labels', interactive: false, icon: L.divIcon({ className: '', html: `<span style="font:500 11px/1 Roboto,system-ui,sans-serif;color:#80868b;white-space:nowrap;position:relative;left:10px;top:-14px">${name}</span>`, iconSize: [0, 0] }) }).addTo(map);
    }
  }, { geo, borders, labels });
}

const settle = (page, ms = 400) => page.waitForTimeout(ms);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const shot = async (page, name, opts = {}) => {
    await page.screenshot({ path: path.join(OUT, name), ...opts });
    console.log('  ✓', name);
  };

  // Popup: annunci, aziende, profilo (larghezza fissa 520 px di popup.css; altezza = contenuto)
  {
    const page = await openPage(browser, 'popup.html', resultsStore(), { width: 520, height: 600 });
    await settle(page);
    await shot(page, 'popup-annunci.png', { fullPage: true, clip: { x: 0, y: 0, width: 520, height: 1040 } });
    await page.click('.view[data-view="companies"]');
    await settle(page, 200);
    await page.evaluate(() => document.querySelector('.view[data-view="companies"]').scrollIntoView({ block: 'start' }));
    await shot(page, 'popup-aziende.png', { fullPage: true, clip: { x: 0, y: await page.evaluate(() => document.querySelector('.view[data-view="companies"]').getBoundingClientRect().top + scrollY - 16), width: 520, height: 620 } });
    await page.click('.tab[data-tab="profile"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page, 200);
    await shot(page, 'popup-profilo.png', { fullPage: true });
    await page.context().close();
  }

  // Mappa: panoramica e scheda di un'azienda
  {
    const store = resultsStore();
    const page = await openPage(browser, 'map.html', store, { width: 1280, height: 760 });
    await settle(page, 600);
    await drawBasemap(page);
    await settle(page, 300);
    await shot(page, 'mappa.png');

    // scheda di Nordlicht (Hamburg): clic sul marker
    const pt = await page.evaluate(() => {
      const m = window.__map;
      m.setView([53.551, 9.994], 7, { animate: false });
      return m.latLngToContainerPoint([53.551, 9.994]);
    });
    await settle(page, 300);
    const mapBox = await page.locator('#map').boundingBox();
    await page.mouse.click(mapBox.x + pt.x, mapBox.y + pt.y);
    await settle(page, 1200);
    await shot(page, 'mappa-scheda.png');
    await page.context().close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
