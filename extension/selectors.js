/**
 * ============================================================
 *  SELETTORI CSS DI STEPSTONE  —  UNICO PUNTO DA AGGIORNARE
 * ============================================================
 * Se StepStone cambia l'HTML e l'estrazione smette di funzionare:
 *   1. Apri una pagina di ricerca, DevTools (F12) → ispeziona una card.
 *   2. Cerca gli attributi `data-at="..."` (sono stabili, a differenza
 *      delle classi `res-xxxx` che sono hash generati da Emotion).
 *   3. Aggiorna/aggiungi il selettore QUI, poi ricarica l'estensione
 *      da chrome://extensions.
 *
 * Ogni campo è un array: i selettori vengono provati in ordine e vince
 * il primo che trova un elemento (fallback automatico).
 * Riferimento: pagine salvate stepston-result-page.html e
 * stepstone-job-detail-page.html.
 */
const SS_SELECTORS = {
  // ---------- Pagina RISULTATI ----------
  results: {
    // Contenitore della lista principale (esclude i caroselli "consigliati")
    container: ['[data-at="unified-resultlist"]', '[data-at="resultlist-flex-container"]'],
    // Singola card annuncio. L'id ha forma "job-item-<ID>".
    card: ['article[data-at="job-item"][id^="job-item-"]', 'article[data-at="job-item"]'],
    title: ['[data-at="job-item-title"]'],
    company: ['[data-at="job-item-company-name"]'],
    // Link al profilo aziendale StepStone (/cmp/<lang>/<nome>-<ID>/jobs)
    companyLink: ['a[data-at="company-logo"]', 'a[href*="/cmp/"]'],
    location: ['[data-at="job-item-location"]'],
    remote: ['[data-at="job-item-work-from-home"]'],
    snippet: ['[data-at="jobcard-content"]'],
    postedAt: ['[data-at="job-item-timeago"] time', '[data-at="job-item-timeago"]'],
    badges: ['[data-at="job-item-badge"]'],
    topLabel: ['[data-at="job-item-top-label"]'],
    // Lo stipendio NON ha un data-at nella card: si cerca uno <span> foglia
    // che contiene "€" (vedi extractCardSalary in content.js). Selettore
    // opzionale se StepStone aggiungesse un attributo dedicato:
    salary: ['[data-at="job-item-salary"]'],
    totalCount: ['[data-at="search-jobs-count"]'],
    pagination: ['nav[aria-label="pagination"]'],
    // Elementi da escludere (card dentro caroselli di raccomandazioni)
    excludeAncestor: ['[data-at="resultListMainResultsCvRecommender"]', '[data-at="related-jobs"]']
  },

  // ---------- Pagina DETTAGLIO ----------
  detail: {
    title: ['[data-at="header-job-title"]'],
    company: ['[data-at="metadata-company-name"]'],
    companyLink: ['a[data-at="job-ad-company-logo-link"]', 'a[href*="/cmp/"]'],
    location: ['[data-at="metadata-location"]'],
    contractType: ['[data-at="metadata-contract-type"]'],
    workType: ['[data-at="metadata-work-type"]'],
    postedAt: ['[data-at="metadata-online-date"]'],
    salary: ['[data-at="salary-range"]', '[data-at="metadata-salary"]'],
    description: ['[data-at="section-text-description-content"]', '[data-at="section-text-introduction-content"]'],
    requirements: ['[data-at="section-text-profile-content"]'],
    benefits: ['[data-at="section-text-benefits-content"]'],
    jsonLd: ['script[type="application/ld+json"]']
  }
};

if (typeof globalThis !== 'undefined') globalThis.SS_SELECTORS = SS_SELECTORS;
if (typeof module !== 'undefined') module.exports = SS_SELECTORS;
