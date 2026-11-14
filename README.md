# Presenze Impianti

App web per la timbratura dei dipendenti con controllo di **orario** e **posizione GPS**,
avvisi di ritardo su **Telegram** e **dashboard** con statistiche per ogni dipendente.

## Come funziona
- **Dipendente**: apre il link dal telefono, inserisce il suo PIN, preme "Timbra ingresso".
  L'ora viene presa dal server (non dal telefono, quindi non si può falsificare cambiando l'orologio)
  e la posizione viene confrontata con quella dell'impianto assegnato.
- **Titolare**: accede con password e vede chi è puntuale, in ritardo o non ha timbrato,
  le statistiche (7/30/90 giorni), può gestire impianti, dipendenti, turni e giustificare assenze.
- **Avvisi**: messaggio Telegram quando qualcuno arriva in ritardo, timbra fuori zona,
  o non timbra entro l'orario di turno + tolleranza (controllo ogni 5 minuti).

## Struttura
- `public/index.html` – l'app (dipendenti e titolare)
- `netlify/functions/api.mjs` – API (login, timbratura, dati)
- `netlify/functions/controllo-ritardi.mjs` – controllo automatico ogni 5 minuti
- `netlify/lib/core.mjs` – logica condivisa
- I dati sono salvati in Netlify Blobs (nessun database da gestire).

Se aperta senza server, l'app parte in **modalità demo** con dati di prova.

## Variabili d'ambiente (su Netlify)
| Nome | Obbligatoria | Cosa è |
|---|---|---|
| `ADMIN_PASSWORD` | sì | password del titolare |
| `SESSION_SECRET` | consigliata | stringa casuale lunga per firmare gli accessi |
| `TELEGRAM_BOT_TOKEN` | per gli avvisi | token del bot creato con @BotFather |
| `TELEGRAM_CHAT_ID` | per gli avvisi | il tuo chat ID (più ID separati da virgola) |

## Limiti da conoscere
- Un'app con GPS falso installata sul telefono può ingannare la posizione: le timbrature
  "fuori zona" e la precisione del GPS vengono comunque registrate.
- Privacy: la posizione è letta solo al momento della timbratura. Prima dell'uso serve
  un'informativa ai dipendenti (GDPR) e il rispetto dell'art. 4 dello Statuto dei Lavoratori.
