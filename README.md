# Cervellone online

Quiz multiplayer con conduttore, schermo TV/proiettore e telefoni a quattro pulsanti.

## Utilizzo

1. Apri la home e crea una stanza: sullo stesso browser resta disponibile il controllo conduttore.
2. Apri lo schermo TV con il pulsante dedicato.
3. I partecipanti entrano con il link condiviso o il PIN e scelgono il nome.
4. Seleziona le domande e le regole, quindi avvia il quiz.

Le stanze durano 24 ore e accolgono fino a 100 partecipanti. I nuovi giocatori entrano nella lobby; chi perde la connessione può rientrare sullo stesso browser durante la partita. Le chiavi di rientro sono credenziali locali: cancellare i dati del browser le elimina.

## Architettura

- `dist/`: frontend statico in HTML, CSS e JavaScript, senza dipendenze npm.
- `backend/schema.sql`: schema di riferimento completo per un database nuovo.
- `backend/seed.sql`: pacchetto iniziale di 30 domande; migliorabile e sostituibile.
- `backend/index.ts`: Edge Function `quiz`, configurata con verifica JWT abilitata.
- `tests/integration.py`: verifica completa contro il gateway reale. Crea una stanza temporanea.
- `tests/database.sql`: verifica deterministica dei confini temporali, autorizzazioni e punteggi, con rollback finale.

Il database conserva stanze, giocatori e risposte in uno schema privato. Il client non può leggere direttamente tabelle o risposte corrette. La Edge Function usa la chiave server di Supabase, senza inserirla nel frontend, e chiama un unico comando database con blocco per stanza. I comandi del conduttore e le risposte dei giocatori richiedono credenziali casuali separate. Solo la chiave pubblica `anon`, necessaria per la compatibilità con la verifica JWT del gateway, è in `dist/config.js`.

Il server decide se una risposta è puntuale e calcola i punti: 60% base + fino al 40% di bonus velocità. Le risposte duplicate non cambiano la prima scelta. I salti gratuiti vengono conteggiati per manche; la penalità non porta il punteggio totale sotto zero. I risultati sono assegnati una volta sola. Le correzioni manuali del conduttore riguardano il totale.

La sincronizzazione usa richieste ogni secondo (ogni 3 secondi con la pagina in background). I timer vengono disegnati localmente, sincronizzati con l'orario del server. Le fasi scadute si aggiornano alla prima richiesta successiva; il tempo di accettazione rimane quello del database. Questo è un primo impianto semplice per serate quiz, non una validazione di carico per eventi di grandi dimensioni. Con molti eventi simultanei, misurare il carico prima di introdurre notifiche Realtime.

## Domande JSON

Un array di oggetti nel formato seguente, oppure un oggetto con una proprietà `questions` contenente l'array:

```json
[{"category":"Scienze","difficulty":"facile","question":"Quale pianeta è rosso?","options":["Venere","Marte","Giove","Saturno"],"correctIndex":1}]
```

Da 1 a 100 domande per partita, quattro opzioni distinte, indice corretto da 0 a 3. Per file più lunghi, l'interfaccia permette di selezionare categoria, quantità e ordine casuale. Il pacchetto originale da 5.000 domande non è usato come set predefinito perché contiene molti quesiti artificiali; non è stato sottoposto a revisione editoriale.

## Pubblicazione e manutenzione

`dist/` è pubblicabile su un hosting statico. `dist/index.html` usa percorsi relativi, adatti anche a GitHub Pages in una sottocartella. Il backend richiede il progetto Supabase Cervellone e la funzione `quiz` attiva. La configurazione Sites in `.openai/hosting.json` identifica la pubblicazione gestita da questa versione.

Per un progetto Supabase nuovo applicare `schema.sql` e `seed.sql`, distribuire la funzione `quiz` con verifica JWT, aggiornare URL e chiave pubblica in `dist/config.js`. Le variabili server `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` sono quelle fornite da Supabase. Non pubblicare mai la chiave `service_role`.

Lo schema privato ha RLS attiva senza politiche client per scelta: ogni accesso passa dal gateway. Il comando SQL pubblico è revocato a `anon` e `authenticated`, autorizzato esclusivamente a `service_role`.

Limitazioni attuali: niente account del conduttore o recupero da un altro dispositivo; limite richieste di base per IP; niente test di carico; domande iniziali da rivedere prima di competizioni ufficiali. Le stanze scadute e i limiti vecchi vengono rimossi alla creazione di una nuova stanza. La versione originale LAN è conservata in `legacy/` per riferimento.
