# StepStone Scraper & Matcher

Estensione Chrome (Manifest V3) che legge gli annunci di una **pagina di ricerca StepStone**, li confronta con il tuo **profilo** (skill, esperienza, posizione, stipendio, località) e assegna a ciascuno un **punteggio di affinità** da 0 a 100. Dagli stessi risultati ricava anche la **lista delle aziende** e permette di esportare tutto in **XLSX**, CSV e JSON.

Domini supportati: `stepstone.de`, `.at`, `.be`, `.nl`, `.fr`.

```
extension/
├── manifest.json     Configurazione MV3, permessi, content script
├── selectors.js      ★ Tutti i selettori CSS di StepStone (unico file da aggiornare)
├── content.js        Estrazione dal DOM, paginazione, arricchimento, badge in pagina
├── match.js          Parsing stipendio e calcolo del punteggio (condiviso con il popup)
├── companies.js      Lista aziende: raggruppamento, classificazione Main Business, link LinkedIn
├── xlsx.js           Writer XLSX minimale, senza dipendenze esterne
├── background.js     Service worker: default, verifica tab/dominio, iniezione content script
├── popup.html/.css/.js   Interfaccia: profilo, avvio scraping, tabella, export
├── content.css       Stile dei badge nella pagina StepStone
└── test/             Test dei parser sulle pagine HTML salvate nel repo
```

---

## 1. Installazione (modalità sviluppatore)

1. Apri Chrome e vai su `chrome://extensions`.
2. Attiva **Modalità sviluppatore** (interruttore in alto a destra).
3. Clicca **Carica estensione non pacchettizzata**.
4. Seleziona la cartella **`extension/`** di questo repository (quella che contiene `manifest.json`).
5. (Consigliato) Clicca l'icona a forma di puzzle nella barra di Chrome e **fissa** l'estensione.

Dopo ogni modifica al codice, premi l'icona ↻ sulla scheda dell'estensione in `chrome://extensions` e **ricarica la pagina StepStone** (F5).

## 2. Primo utilizzo

### a) Compila il profilo
Apri il popup → scheda **Profilo**:

| Campo | Esempio | Note |
|---|---|---|
| Competenze | `terraform, kubernetes, azure` | Separate da virgola. Cerca ogni skill in titolo, anteprima, descrizione e requisiti. |
| Anni di esperienza | `5` | Confrontato con "N Jahre/years" nei requisiti (solo con *Leggi anche i dettagli*). |
| Posizione desiderata | `Platform Engineer` | Confrontata con il titolo dell'annuncio. |
| Stipendio min/max | `60000` / `90000` | €/anno. Usato solo per annunci che indicano uno stipendio. |
| Località preferite | `Berlin, München` | Separate da virgola. |
| Remoto | ☑ | Premia gli annunci con "Home-Office". |

Premi **Salva profilo**. Tutto viene salvato in `chrome.storage.local` (solo sul tuo browser). I campi lasciati vuoti **non penalizzano**: vengono semplicemente ignorati nel calcolo.

### b) Estrai gli annunci
1. Su StepStone esegui una ricerca e imposta i filtri che vuoi (parola chiave, luogo, tipo di lavoro, stipendio…). L'estensione usa **l'URL corrente**, quindi tutti i filtri attivi vengono mantenuti.
2. Apri il popup → scheda **Annunci**.
3. Imposta:
   - **Richieste in parallelo** (1–10, default 5): l'estensione legge **sempre tutte le pagine** della ricerca corrente (una pagina ≈ 25 annunci, anche oltre le 20 pagine) scaricandole in parallelo. Più richieste = più veloce, ma StepStone può rallentare o bloccare temporaneamente. Se ottieni errori, abbassa il valore. Le ricerche molto ampie, soprattutto con *Leggi anche i dettagli*, possono richiedere diversi minuti: **Ferma** interrompe mantenendo quanto già raccolto.
   - **Leggi anche i dettagli**: apre in background ogni annuncio per ottenere tipo di contratto, modalità di lavoro, descrizione e requisiti. Più preciso, ma molto più lento (≈ 1–2 s per annuncio).
   - **Dati aziende**: per ogni azienda scarica **un solo** annuncio di dettaglio e ne ricava settore, sede e paese (vedi sezione 4). Attivo di default.
   - **Evidenzia l'affinità nella pagina**: aggiunge un badge colorato alle card della pagina corrente.
4. Premi **Estrai annunci**. Barra di progresso e stato sono visibili nel popup; puoi chiuderlo: l'operazione continua e i risultati restano salvati. **Ferma** interrompe mantenendo quanto già raccolto.

### c) Leggi i risultati
- La tabella è ordinata per **affinità decrescente**; il titolo apre l'annuncio in una nuova scheda.
- **Evidenzia in pagina / Rimuovi**: mostra o toglie i badge (verde ≥ 70, giallo 40–69, grigio < 40).
- Se modifichi il profilo, i punteggi vengono **ricalcolati subito** sui risultati già estratti, senza rifare lo scraping.
- Le viste **Annunci** e **Aziende** sopra la tabella alternano le due liste.
- **Export**:
  - **XLSX**: un unico file con due fogli, **Aziende** e **Annunci** (intestazione in grassetto, riga bloccata, filtro automatico, link cliccabili).
  - **CSV annunci** / **CSV aziende** (separatore `;` con BOM, si aprono correttamente in Excel italiano/tedesco).
  - **JSON**: tutti i dati (annunci, aziende, metadati).

## 3. Come viene calcolato il punteggio

Media pesata dei soli criteri applicabili:

| Criterio | Peso | Punteggio |
|---|---|---|
| Skill | 50 | skill trovate / skill del profilo |
| Posizione | 20 | 1 se il titolo contiene la frase; altrimenti quota di parole trovate |
| Stipendio | 10 | 1 se il range offerto raggiunge il minimo desiderato, altrimenti proporzionale (stipendio stimato per mesi/ore → annualizzato) |
| Località / remoto | 10 | 1 se il luogo corrisponde a una preferenza, o l'annuncio offre home office e lo desideri |
| Esperienza | 10 | `min(1, i tuoi anni / anni richiesti)` — solo se l'annuncio indica gli anni |

Un criterio senza dati (profilo o annuncio) è escluso, non conta come zero. Senza nessun criterio applicabile il punteggio è `–`. I pesi sono in `match.js` (`WEIGHTS`).

Nota: gli stipendi mostrati da StepStone sono spesso **stime** ("geschätzt für Vollzeit"), non dati dichiarati dall'azienda.

## 4. Lista aziende

La vista **Aziende** e il foglio *Aziende* dell'XLSX hanno le colonne della tua tabella di lavoro:

| Colonna | Come viene ricavata |
|---|---|
| **Azienda** | Nome come appare nella card dell'annuncio. |
| **Link Azienda** | Profilo aziendale su StepStone (`/cmp/de/<nome>-<ID>/jobs`). StepStone **non** mostra il sito web dell'azienda. |
| **LinkedIn** | Link alla **ricerca LinkedIn** per il nome (senza GmbH/AG/SE…): StepStone non espone il profilo LinkedIn, quindi serve un clic per scegliere l'azienda giusta. |
| **Main Business** | `Consulenza`, `Prodotto`, `Recruiting` oppure `Da verificare`, vedi sotto. |
| **Main Business - Descrizione** | Settore indicato da StepStone nella scheda aziendale (es. *Versicherungen*); in mancanza, il settore dell'annuncio. |
| **Country** | Dal paese della sede (es. `DE` → *Germania*); in mancanza, dal dominio StepStone. |
| **City** | Città della sede dalla scheda aziendale; in mancanza, la prima località dell'annuncio. |
| *N. annunci*, *Affinità max* | Extra in coda: quanti annunci dell'azienda sono nei risultati e il punteggio migliore. |

Le aziende sono raggruppate per **ID StepStone** (una riga per azienda anche con più annunci) e ordinate alfabeticamente.

**Main Business è una stima automatica**: si cercano parole chiave nel nome e nel settore (priorità Recruiting → Consulenza → Prodotto; se c'è un settore ma nessuna parola chiave → Prodotto; se non c'è nessun dato → *Da verificare*). Controlla sempre i casi dubbi. Le parole chiave sono in cima a `companies.js` (`KEYWORDS`) e si modificano liberamente.

Senza l'opzione **Dati aziende** (o *Leggi anche i dettagli*) settore e sede non sono disponibili e molte righe resteranno *Da verificare*, con città presa dall'annuncio.

## 5. Gestione errori

| Messaggio | Causa / soluzione |
|---|---|
| *La scheda attiva non è StepStone* | Passa a una scheda `www.stepstone.(de/at/be/nl/fr)`. |
| *Non è una pagina di risultati di ricerca* | Apri una ricerca (`/jobs/...`), non un singolo annuncio o la home. |
| *La pagina non risponde* | Ricarica la scheda (F5). |
| Avvisi gialli "Campo … mancante" / "Nessuna card trovata" | StepStone ha cambiato l'HTML: aggiorna i selettori (sezione 5). |
| "Pagina N: …" / "⚠ pagine non lette" | Una pagina non è stata recuperata (blocco, errore di rete o HTML cambiato). Le altre vengono comunque lette; le richieste rifiutate con 429/503 vengono **ritentate automaticamente** (fino a 3 volte, con attesa crescente). Se restano pagine mancanti, abbassa le richieste in parallelo e rilancia. |

## 6. Aggiornare i selettori se StepStone cambia l'HTML

Tutti i selettori sono in **`extension/selectors.js`**, ognuno come elenco di alternative provate in ordine.

1. Apri una pagina di ricerca → `F12` → ispeziona una card annuncio.
2. Cerca gli attributi **`data-at="…"`** (es. `job-item-title`, `job-item-company-name`). Sono molto più stabili delle classi `res-xxxx`, che sono hash generati automaticamente: **non usarle**.
3. Aggiorna o aggiungi il selettore nel campo corrispondente (mettendo quello nuovo per primo e tenendo il vecchio come ripiego).
4. `chrome://extensions` → ↻ sull'estensione, poi F5 sulla pagina StepStone.

Particolarità note, verificate sulle pagine di riferimento:
- **Stipendio nella lista**: non ha un `data-at`; viene riconosciuto come `<span>` foglia contenente `€` (funzione `extractCardSalary` in `content.js`). Se StepStone aggiunge un attributo dedicato, mettilo in `results.salary`.
- **Card "consigliate"**: la pagina contiene altre card `job-item` nei blocchi di raccomandazioni (70 su 95 nella pagina di esempio). Vengono escluse tramite `results.excludeAncestor`; la lista reale ha 25 annunci per pagina.
- **Tipo di contratto**: non è presente nelle card della lista, solo nel dettaglio (`metadata-contract-type`), quindi richiede *Leggi anche i dettagli*.
- **Scheda azienda**: nel dettaglio sta in `window.__PRELOADED_STATE__.JobAdContent` → `companyPassportData` (id, nome, indirizzo, dipendenti, settori). Viene letta con un parser dedicato (`extractCompanyPassport` in `content.js`) e, se manca, si ripiega sul JSON-LD (`hiringOrganization`, `industry`, `addressCountry`). Il link al profilo in lista è `a[data-at="company-logo"]` (`results.companyLink`).
- **Dettaglio**: la fonte primaria è il JSON-LD `JobPosting` della pagina, con ripiego sugli attributi `data-at="metadata-*"` / `section-text-*`.

### Test dei parser
I test verificano i selettori su due pagine StepStone salvate (una di ricerca e una di dettaglio, ~8 MB in tutto, **non incluse nel repository**). Salvale come `stepston-result-page.html` e `stepstone-job-detail-page.html` in una cartella e indicala con `STEPSTONE_FIXTURES` (di default si cerca nella radice del repo; se mancano i test vengono saltati).

```bash
cd extension/test
npm install
STEPSTONE_FIXTURES=/percorso/alle/pagine npm test      # PowerShell: $env:STEPSTONE_FIXTURES="C:\percorso"; npm test
```

`npm test` esegue `parse.test.js` (parser, aziende, XLSX) e `paging.test.js` (lettura di tutte le pagine in parallelo, limite di concorrenza, ritentativi su 429, ordine dei risultati, errori parziali; usa `fetch` simulato dentro jsdom).

I test coprono anche lista aziende, classificazione Main Business e generazione XLSX (rilettura con `openpyxl`, se installato: `pip install openpyxl`).

Dopo aver aggiornato `selectors.js`, salva una nuova pagina di esempio e adatta i valori attesi in `parse.test.js` per verificare subito che l'estrazione funzioni.

## 7. Limiti e uso responsabile

- L'estensione lavora **solo nel tuo browser**, con la tua sessione, e non invia dati a server esterni.
- Le pagine successive, i dettagli e le schede azienda vengono scaricati in parallelo (default 5 richieste contemporanee) con brevi pause casuali (≈ 0,15–0,4 s) e ritentativo su 429/503. Non alzare in modo aggressivo le richieste in parallelo: StepStone può limitare o bloccare traffico anomalo. Tetto di sicurezza: 200 pagine per ricerca.
- Verifica che l'uso sia coerente con i **Termini di servizio di StepStone**; lo strumento è pensato per uso personale nella ricerca di lavoro, non per raccolta massiva o rivendita dei dati.
- Non è prevista la lettura di pagine caricate solo a scorrimento (infinite scroll): StepStone usa paginazione classica (`?page=N`), gestita via URL.
- Permessi richiesti: `storage` (profilo e risultati), `activeTab` + `scripting` (iniettare il content script in schede già aperte), accesso ai soli domini StepStone elencati.
