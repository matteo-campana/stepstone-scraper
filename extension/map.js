/**
 * map.js — pagina "Mappa aziende": legge i risultati di tutti i siti da chrome.storage.local,
 * li unisce per azienda (geo.js), li mette sulla mappa Leaflet e applica i filtri.
 * Tooltip e scheda sono costruiti con nodi DOM (textContent): i dati vengono dalle pagine scrapate.
 * Con «Indirizzi esatti» (opzionale, spento di default) gli indirizzi delle sedi vengono geocodificati
 * con Nominatim, una richiesta al secondo, e i risultati restano in cache (chiave GEO_CACHE_KEY).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const DEFAULT_VIEW = [48, 10], DEFAULT_ZOOM = 4;
  // colori dei token di map.css (--src-*), usati per i marker del canvas
  const SOURCE_COLOR = { stepstone: '#1a73e8', totaljobs: '#1e8e3e', linkedin: '#7627bb' };
  const INK = '#202124', WHITE = '#fff';
  const GEO_CACHE_KEY = 'geocache', MAP_OPTIONS_KEY = 'mapOptions';
  const GEOCODE_GAP_MS = 1100; // policy di Nominatim: al massimo 1 richiesta al secondo

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  const link = (href, label) => {
    const a = el('a', '', label);
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    return a;
  };
  const plural = (n, one, many) => (n === 1 ? one : many);

  // ---------------------------------------------------------------
  // Stato
  // ---------------------------------------------------------------
  let table = null;          // cities.json
  let companies = [];        // righe unite per azienda, con .geo
  let visible = [];          // righe filtrate e localizzate (sono sulla mappa)
  const f = { country: '', sector: '', source: '', search: '' };
  let exact = false;         // «Indirizzi esatti» attivo
  let geocache = {};         // query indirizzo → [lat, lon] | null (non trovato)

  // ---------------------------------------------------------------
  // Mappa
  // ---------------------------------------------------------------
  const map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 16, preferCanvas: true })
    .setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  const tiles = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  L.tileLayer(tiles + 'World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: '© OpenStreetMap contributors · Tiles © Esri'
  }).addTo(map);
  L.tileLayer(tiles + 'World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16 }).addTo(map);

  const renderer = L.canvas({ padding: 0.5, tolerance: 4 });
  const layer = L.layerGroup().addTo(map);

  function tooltipNode(c) {
    const box = el('div', 'tipbox');
    box.append(el('div', 'tn', c.name), el('div', 'sub', SSGeo.place(c)));
    const sector = [c.business, c.businessDesc].filter(Boolean).join(' · ');
    if (sector) box.append(el('div', 'sub', sector));
    const n = c.jobs;
    if (n) box.append(el('div', 'hits', `${n} ${plural(n, 'annuncio', 'annunci')}`));
    return box;
  }

  function popupNode(c) {
    const card = el('div', 'card');
    card.append(el('div', 'k', (c.sources || []).join(' · ')), el('div', 'n', c.name));
    if (c.address) card.append(el('div', 'm', c.address));
    card.append(el('div', 'm', SSGeo.place(c)));
    const sector = [c.business, c.businessDesc].filter(Boolean).join(' — ');
    if (sector) card.append(el('div', 'm', sector));

    const list = c.jobList || [];
    if (list.length) {
      const rows = el('div', 'jobs');
      for (const j of list.slice(0, 5)) {
        const row = el('div', 'job');
        row.append(el('strong', '', j.title || 'Ruolo n/d'));
        const meta = [j.location, j.salary, j.score != null ? j.score + '%' : ''].filter(Boolean).join(' · ');
        if (meta) row.append(el('br'), meta);
        const u = safeUrl(j.url);
        if (u) { row.append(' · '); row.append(link(u, 'annuncio')); }
        rows.append(row);
      }
      card.append(rows);
      if (list.length > 5) card.append(el('div', 'more', `+${list.length - 5} altri`));
    }
    if (c.geo && c.geo.approx) card.append(el('div', 'm approx', 'Posizione approssimata'));
    else if (exact && c.geo && !c.geo.exact) card.append(el('div', 'm approx', 'Posizione della città'));

    const links = el('div', 'links');
    const site = safeUrl(c.url), li = safeUrl(c.linkedin);
    if (site) links.append(link(site, 'Profilo azienda →'));
    if (li) links.append(link(li, 'LinkedIn →'));
    if (links.childNodes.length) card.append(links);
    return card;
  }

  /** Ridisegna i marker in base ai filtri. Aziende nello stesso punto → spirale (SSGeo.spiral). */
  function render() {
    layer.clearLayers();
    visible = [];
    const seen = new Map();
    for (const c of companies) {
      if (!c.geo || !matches(c)) continue; // senza posizione: solo nel conteggio
      const key = c.geo.lat.toFixed(4) + ',' + c.geo.lon.toFixed(4);
      const k = (seen.get(key) || 0) + 1;
      seen.set(key, k);
      const [lat, lon] = SSGeo.spiral(c.geo.lat, c.geo.lon, k);
      visible.push([lat, lon]);

      const color = SOURCE_COLOR[(c.sourceIds || [])[0]] || INK;
      const m = L.circleMarker([lat, lon], { renderer, radius: 6, weight: 2, color: WHITE, fillColor: color, fillOpacity: 0.95 });
      m.bindTooltip(() => tooltipNode(c), { className: 'tip', direction: 'top', offset: [0, -8], opacity: 1 });
      m.bindPopup(() => popupNode(c), { maxWidth: 300, autoPanPadding: [24, 24] });
      m.on('mouseover', () => { m.setRadius(9); m.setStyle({ color: INK }); if (m.isPopupOpen()) m.closeTooltip(); });
      m.on('mouseout', () => { m.setRadius(6); m.setStyle({ color: WHITE }); });
      m.on('popupopen', () => { m.closeTooltip(); m.getTooltip().setOpacity(0); });
      m.on('popupclose', () => m.getTooltip().setOpacity(1));
      layer.addLayer(m);
    }
    updateCounts();
  }

  function fit() {
    if (visible.length) map.fitBounds(L.latLngBounds(visible), { padding: [40, 40], maxZoom: 12 });
    else map.setView(DEFAULT_VIEW, DEFAULT_ZOOM);
  }

  // ---------------------------------------------------------------
  // Filtri
  // ---------------------------------------------------------------
  const sectorOf = (c) => c.business || c.businessDesc || '';

  function matches(c) {
    return (!f.country || c.country === f.country) &&
      (!f.sector || sectorOf(c) === f.sector) &&
      (!f.source || (c.sourceIds || []).includes(f.source)) &&
      (!f.search || (c.name || '').toLowerCase().includes(f.search));
  }

  /** Riempie un <select> mantenendo il valore scelto, se ancora presente. */
  function fillSelect(id, options, placeholder) {
    const s = $(id), prev = s.value;
    s.textContent = '';
    s.append(new Option(placeholder, ''));
    for (const [value, label] of options) s.append(new Option(label, value));
    s.value = options.some(([v]) => v === prev) ? prev : '';
    f[id.slice(2)] = s.value;
  }

  function sortIt(list) { return list.sort((a, b) => a[1].localeCompare(b[1], 'it')); }

  function refreshSelects() {
    const countries = [...new Set(companies.map((c) => c.country).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
    const sectors = [...new Set(companies.map(sectorOf).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
    const sources = sortIt(Object.entries(sourceLabels));
    fillSelect('f-country', countries.map((v) => [v, v]), 'Tutti i paesi');
    fillSelect('f-sector', sectors.map((v) => [v, v]), 'Tutti i settori');
    fillSelect('f-source', sources, 'Tutte le fonti');
  }

  // ---------------------------------------------------------------
  // Dati
  // ---------------------------------------------------------------
  let sourceLabels = {}; // id sito → etichetta, solo per siti con risultati

  function updateCounts() {
    const located = companies.filter((c) => c.geo).length;
    $('count').textContent = `${visible.length} / ${located} ${plural(located, 'azienda', 'aziende')}`;
    const missing = companies.length - located;
    $('noPos').hidden = missing === 0;
    $('noPos').textContent = `${missing} senza posizione`;
  }

  /** Legge i risultati di tutti i siti e ricostruisce righe, select e vista. `keepView` non rifa il fit. */
  async function load(keepView) {
    const keys = SSSites.SITES.map((s) => SSSites.resultsKey(s));
    const stored = await chrome.storage.local.get(keys);
    const entries = [];
    sourceLabels = {};
    for (const s of SSSites.SITES) {
      const r = stored[SSSites.resultsKey(s)];
      if (!r || !(r.jobs || []).length) continue;
      sourceLabels[s.id] = s.label;
      let host = '';
      try { host = new URL(r.meta.pageUrl).hostname; } catch (e) { /* noop */ }
      entries.push({ site: s, jobs: r.jobs, host });
    }

    const merged = SSGeo.mergeSites(entries);
    companies = merged.map((c) => ({ ...c, geo: null }));
    relocate();
    refreshSelects();
    render();
    if (exact) geocodeQueue();

    const hasAny = companies.length > 0;
    $('map').hidden = !hasAny;
    $('empty').hidden = hasAny;
    $('legend').hidden = !hasAny;
    if (hasAny && !keepView) fit();
    updateLegend();
  }

  /** Ricalcola le posizioni: indirizzo geocodificato (solo con «Indirizzi esatti») o città. */
  function relocate() {
    for (const c of companies) c.geo = SSGeo.resolve(c, table, exact ? geocache : null);
  }

  // ---------------------------------------------------------------
  // Geocodifica degli indirizzi (opzionale)
  // ---------------------------------------------------------------
  let geoRun = 0; // incrementato per interrompere un giro in corso (toggle spento, nuovo load)

  function geoStatus(text, warn) {
    const s = $('geoStatus');
    s.hidden = !text;
    s.textContent = text || '';
    s.classList.toggle('warn', !!warn);
  }

  /** Indirizzi non ancora in cache, uno alla volta; la mappa si aggiorna a ogni risultato senza spostare la vista. */
  async function geocodeQueue() {
    const run = ++geoRun;
    const todo = [...new Set(companies.map(SSGeo.addressQuery).filter((q) => q && !(q in geocache)))];
    if (!todo.length) { geoStatus(''); return; }
    for (let i = 0; i < todo.length; i++) {
      if (run !== geoRun) return;
      geoStatus(`Indirizzi ${i + 1}/${todo.length}…`);
      const t0 = Date.now();
      try {
        const res = await fetch(SSGeo.geocodeUrl(todo[i]), { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        geocache[todo[i]] = SSGeo.parseGeocode(await res.json());
      } catch (e) {
        if (run === geoRun) geoStatus('Indirizzi: servizio non raggiungibile, uso le città', true);
        return;
      }
      if (run !== geoRun) return;
      await chrome.storage.local.set({ [GEO_CACHE_KEY]: geocache });
      relocate();
      render();
      const wait = GEOCODE_GAP_MS - (Date.now() - t0);
      if (wait > 0 && i < todo.length - 1) await new Promise((r) => setTimeout(r, wait));
    }
    if (run === geoRun) geoStatus('');
  }

  function updateLegend() {
    const legend = $('legend');
    legend.textContent = '';
    for (const s of SSSites.SITES) {
      if (!sourceLabels[s.id]) continue;
      const row = el('div', 'row');
      row.append(el('span', 'lg-dot src-' + s.id), sourceLabels[s.id]);
      legend.append(row);
    }
    legend.append(el('div', 'hint', 'Passa sopra per i dettagli · clic per i link'));
  }

  // ---------------------------------------------------------------
  // Eventi
  // ---------------------------------------------------------------
  const bind = (id, key, ev, fitAfter) => $(id).addEventListener(ev, (e) => {
    f[key] = key === 'search' ? e.target.value.trim().toLowerCase() : e.target.value;
    render();
    if (fitAfter) fit();
  });
  bind('f-country', 'country', 'change', true);
  bind('f-sector', 'sector', 'change', true);
  bind('f-source', 'source', 'change', true);
  bind('f-search', 'search', 'input', false);

  $('reset').addEventListener('click', () => {
    Object.keys(f).forEach((k) => { f[k] = ''; });
    ['f-country', 'f-sector', 'f-source', 'f-search'].forEach((id) => { $(id).value = ''; });
    map.closePopup();
    render();
    fit();
  });
  $('fit').addEventListener('click', fit);

  $('f-exact').addEventListener('change', (e) => {
    exact = e.target.checked;
    chrome.storage.local.set({ [MAP_OPTIONS_KEY]: { exact } });
    geoRun++;
    geoStatus('');
    relocate();
    render();
    if (exact) geocodeQueue();
  });

  // Vista iniziale solo quando il contenitore ha dimensioni reali (prima il fit sbaglia zoom)
  let fitted = false;
  new ResizeObserver(([en]) => {
    map.invalidateSize();
    if (!fitted && en.contentRect.width > 0 && en.contentRect.height > 0) {
      fitted = true;
      if (companies.length) fit();
    }
  }).observe($('map'));

  // Aggiornamento live: un'estrazione in un'altra scheda aggiorna la mappa, senza spostare la vista
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k.startsWith('results:'))) load(true);
  });

  (async function init() {
    await SSSites.migrateFlatKeys(chrome.storage.local).catch(() => { /* ritenta alla prossima apertura */ });
    table = await fetch(chrome.runtime.getURL('cities.json')).then((r) => r.json());
    const saved = await chrome.storage.local.get([GEO_CACHE_KEY, MAP_OPTIONS_KEY]);
    geocache = saved[GEO_CACHE_KEY] || {};
    exact = !!(saved[MAP_OPTIONS_KEY] && saved[MAP_OPTIONS_KEY].exact);
    $('f-exact').checked = exact;
    await load(false);
  })();
})();
