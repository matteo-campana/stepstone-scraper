// Ricerca delle pagine di esempio salvate (non versionate: vedi .gitignore).
// Cartelle provate, in ordine: SCRAPER_FIXTURES, STEPSTONE_FIXTURES (compatibilità), radice del repo, example/.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = [process.env.SCRAPER_FIXTURES, process.env.STEPSTONE_FIXTURES, ROOT, path.join(ROOT, 'example')].filter(Boolean);

/** Percorso completo del file di esempio, o null se non esiste in nessuna cartella. */
const fixturePath = (name) => {
  for (const d of DIRS) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

const readFixture = (name) => {
  const p = fixturePath(name);
  return p ? fs.readFileSync(p, 'utf8') : null;
};

/** Pagine di esempio per sito. */
const FIXTURES = {
  stepstone: { result: 'stepston-result-page.html', detail: 'stepstone-job-detail-page.html' },
  totaljobs: { result: 'totaljobs-result-page.html', detail: 'totaljobs-job-detail-page.html' },
  // LinkedIn: la lista sta in un iframe (non incluso nel salvataggio): 'resultFrame' e' opzionale, 'page' e' la ricerca senza lista
  workday: { result: 'workday-leonardo.html', detail: 'workday-leonardo-job-detail.html' },
  indeed: { result: 'indeed-result.html', detail: 'indeed-job-detail.html' },
  linkedin: { resultFrame: 'linkedin-result-frame.html', page: 'linkedin-page.html', detail: 'linkedin-job-detail-page.html' }
};

const skip = (what) => console.log('SALTATO: ' + what + ' non trovato/a (cercato in: ' + DIRS.join(', ') + '; impostare SCRAPER_FIXTURES).');

module.exports = { DIRS, FIXTURES, fixturePath, readFixture, skip };
