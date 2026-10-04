# Come contribuire

Saremo felici di ricevere patch e contributi per questo progetto. Poche semplici
linee guida ti aiuteranno a farlo senza intoppi.

## Prima di iniziare

### Licenza dei contributi

Questo progetto è distribuito con licenza
[GNU Affero General Public License v3.0 o successiva](LICENSE) (AGPL-3.0-or-later).
Non è richiesto alcun Contributor License Agreement (CLA): inviando un contributo
(pull request, patch, ecc.) dichiari di averne i diritti e accetti che venga
distribuito con la stessa licenza del progetto. Se il tuo datore di lavoro o la tua
scuola potrebbero rivendicare diritti sul codice che scrivi, assicurati di avere la
loro autorizzazione prima di inviarlo.

### Linee guida della community

Sii rispettoso e costruttivo con chi partecipa al progetto: nelle issue, nelle
revisioni e in ogni altra discussione, critica il codice e non le persone.

### Dati e chiavi che non vanno nel repository

L'estensione lavora su pagine di StepStone e TotalJobs, quindi presta attenzione a cosa
committi:

- **Non committare pagine salvate dei siti** (StepStone, TotalJobs) (HTML di ricerca o di dettaglio): contengono
  chiavi pubbliche di terzi (analytics, Google…) che innescano gli alert di secret scanning
  di GitHub, oltre a dati personali come cookie, ID utente e annunci. Tienile in una cartella
  esterna e indicala con `SCRAPER_FIXTURES` (vedi [README](README.md#test-dei-parser)).
  Il `.gitignore` esclude già i nomi usati dai test.
- **Non includere nelle issue o nelle PR** cookie, token, il tuo profilo salvato o l'export dei
  tuoi risultati se contiene dati personali.
- Nessuna chiave API o credenziale nel codice: l'estensione non ne ha bisogno.

## Processo di contribuzione

### Segnalare un problema

Apri una issue indicando: sito e dominio (StepStone `.de`, `.at`…, TotalJobs), tipo di pagina (ricerca o
dettaglio), versione di Chrome, cosa ti aspettavi e cosa è successo. Se l'estrazione
non funziona, copia gli **avvisi gialli** mostrati nel popup: dicono quale selettore
manca. Se il sito ha cambiato l'HTML, spesso basta aggiornare
[`extension/selectors.js`](extension/selectors.js) o, per le differenze di un solo sito,
la sua voce in [`extension/sites.js`](extension/sites.js) (guida nel README, sezione «Aggiornare i selettori»).

### Preparare una modifica

1. Fai un fork del repository e crea un branch dedicato a una sola modifica.
2. Carica l'estensione non pacchettizzata (`chrome://extensions` → Modalità sviluppatore →
   cartella `extension/`) e provala su una ricerca reale.
3. Scrivi il codice nello stile di quello circostante: JavaScript senza dipendenze o
   build, commenti in italiano, selettori solo in `selectors.js` e `sites.js`, un nuovo sito solo come voce di `sites.js` (e host nel manifest), parole chiave di
   classificazione solo in `companies.js`, pesi del punteggio solo in `match.js`.
4. Aggiungi o aggiorna i test e fai girare l'intera suite prima di inviare la PR:

   ```bash
   cd extension/test
   npm install
   SCRAPER_FIXTURES=/percorso/alle/pagine npm test
   ```

   Per le nuove regole di estrazione, aggiungi un caso in `parse.test.js` (StepStone) o
   `totaljobs.test.js`; per un nuovo sito, un test come `totaljobs.test.js` e i suoi host in
   `sites.test.js`; per la paginazione e le richieste parallele, in `paging.test.js`.
5. Controlla che `node --check` passi su tutti i file `.js` e che l'estensione si
   carichi in Chrome senza errori.
6. Aggiorna il README se cambia il comportamento visibile all'utente.

Per modifiche ampie (nuove funzioni, nuovi domini, cambio di architettura) apri prima una
issue per discuterne: eviterai lavoro che poi non potremmo accettare.

### Revisione del codice

Ogni contributo viene sottoposto a revisione. Per questo si usano le pull request di
GitHub: consulta la [documentazione di GitHub sulle pull request](https://docs.github.com/articles/about-pull-requests)
se non ti sono familiari. Rispondi ai commenti con nuovi commit sullo stesso branch.
Messaggi di commit brevi e descrittivi (una riga di sintesi, poi il perché se non è ovvio).

### Uso responsabile

Il progetto è pensato per uso personale nella ricerca di lavoro. Non accettiamo modifiche
che aumentino in modo aggressivo il carico sui server dei siti (più richieste in
parallelo, meno pause, ritentativi infiniti), aggirino blocchi o autenticazione, o
raccolgano dati in modo massivo.
