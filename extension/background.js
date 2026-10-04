/**
 * background.js — Service Worker (MV3).
 *
 * Compiti:
 *  - onInstalled: inizializza profilo e opzioni di default e migra le vecchie
 *    chiavi di storage (un solo slot) in chiavi per-sito.
 *  - START_SCRAPE (dal popup): verifica dominio/tab, si assicura che il
 *    content script sia presente (lo inietta se la tab era aperta prima
 *    dell'installazione), poi avvia lo scraping nella tab.
 *    Il lavoro lungo gira nel content script e scrive progresso e risultati
 *    in chrome.storage.local ("scrapeState:<sito>", "results:<sito>"): il popup
 *    può quindi essere chiuso e riaperto senza perdere nulla.
 *  - ACTIVE_SITE (dal popup): dice a quale sito appartiene la scheda attiva.
 *  - Inoltra CANCEL / HIGHLIGHT / CLEAR_HIGHLIGHT / PING alla tab attiva.
 *
 * I siti supportati sono definiti in sites.js (da ripetere in manifest.json).
 */

importScripts('selectors.js', 'sites.js');

const CONTENT_FILES = ['selectors.js', 'sites.js', 'match.js', 'companies.js', 'content.js'];

const DEFAULT_PROFILE = { skills: '', years: '', position: '', salaryMin: '', salaryMax: '', locations: '', remote: false };
const DEFAULT_OPTIONS = { concurrency: 5, enrich: false, companyDetails: true, highlight: true };

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(['profile', 'options']);
  await chrome.storage.local.set({
    profile: cur.profile || DEFAULT_PROFILE,
    options: cur.options || DEFAULT_OPTIONS
  });
  await SSSites.migrateFlatKeys(chrome.storage.local);
});

/** Tab attiva della finestra corrente (nessuna validazione del dominio). */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) throw new Error('NO_TAB');
  return tab;
}

/** Tab attiva + validazione: deve essere un sito supportato. */
async function getSupportedTab() {
  const tab = await getActiveTab();
  let host;
  try { host = new URL(tab.url).hostname; } catch (e) { throw new Error('WRONG_DOMAIN'); }
  if (!SSSites.forHost(host)) throw new Error('WRONG_DOMAIN');
  return tab;
}

/** Manda un messaggio al content script; se non risponde lo inietta e riprova. */
async function sendToTab(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

const FORWARDED = {
  START_SCRAPE: 'SCRAPE',
  CANCEL: 'CANCEL',
  HIGHLIGHT: 'HIGHLIGHT',
  CLEAR_HIGHLIGHT: 'CLEAR_HIGHLIGHT',
  PING: 'PING'
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Non inoltrato e NON passa da getSupportedTab: una scheda qualsiasi è una risposta valida (siteId: null).
  if (msg && msg.type === 'ACTIVE_SITE') {
    (async () => {
      try {
        const tab = await getActiveTab();
        let host = '';
        try { host = new URL(tab.url).hostname; } catch (e) { /* url non valido */ }
        const site = SSSites.forHost(host);
        sendResponse({ ok: true, host, siteId: site ? site.id : null });
      } catch (e) {
        sendResponse({ ok: true, host: '', siteId: null });
      }
    })();
    return true;
  }

  const forward = FORWARDED[msg && msg.type];
  if (!forward) return false;

  (async () => {
    try {
      const tab = await getSupportedTab();
      const res = await sendToTab(tab, { ...msg, type: forward });
      sendResponse(res || { ok: false, error: 'NO_RESPONSE' });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // risposta asincrona
});
