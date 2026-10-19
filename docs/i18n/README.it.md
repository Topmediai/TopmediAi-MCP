# TopMediAi-MCP

[English](../../README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · **Italiano** · [繁體中文](README.zh-TW.md)

Server MCP locale TypeScript tramite stdio e plugin Codex per TopMediai. La versione **1.0.0** supporta generazione di immagini, immagine a immagine, musica, video, video con riferimenti multimediali, sintesi vocale (TTS) e conversione vocale (STS). Include cataloghi, stime dei costi, verifica del budget, recupero delle attività e anteprime di immagini, audio e video. Riduzione del rumore, clonazione vocale e video musicali non sono disponibili.

La generazione utilizza i diritti dell’account connesso. Consulta i modelli e ottieni un preventivo esatto prima dell’invio, rispettando budget e preferenze di conferma della conversazione. Il caricamento richiede il consenso alla memorizzazione esterna; gli URL possono essere accessibili pubblicamente. Vedi [Dati e privacy (inglese)](../privacy.md).

## Installazione e accesso

Servono Node.js >= 22.18, Codex CLI e accesso alla pagina ufficiale di connessione. Attualmente l’accesso tramite browser supporta browser e MCP sullo stesso computer Windows. Usa `npm.cmd` in PowerShell; nelle altre shell supportate puoi usare `npm`.

Nella cartella del progetto:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

Il plugin appare come `TopMediAi-MCP`, con identificatore `topmediai-mcp@topmediai-local`. L’installazione crea localmente `plugin/.mcp.json` senza token o cookie nel plugin. Il file contiene percorsi di eseguibili locali: non inserirlo nei commit e non distribuirlo. Reinstalla dopo aver spostato il progetto o cambiato computer.

Chiama `get_service_status` nella chat corrente. Se occorre l’accesso, usa `start_login`, verifica l’account sulla pagina ufficiale e approva la connessione. Ripeti `wait_for_login` con lo stesso `login_id` fino al salvataggio o alla fine della sessione. Poi chiama `get_service_status` e `get_balance` nella stessa chat e riprendi la richiesta. Non serve riavviare Codex o MCP.

Comandi CLI alternativi:

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

L’accesso attende al massimo dieci minuti. I link privati sono nascosti per impostazione predefinita. Se il browser non si apre, usa `--show-private-link` solo in locale. Non condividere il link, non acquisirlo in screenshot e non incollarlo nella chat.

Il controllo d’installazione dimostra soltanto che un processo MCP separato si avvia, non che la chat abbia caricato gli strumenti o che le credenziali siano valide. Se mancano strumenti, verifica l’attivazione del plugin, aggiorna il pacchetto e riconnetti MCP; se necessario apri un’altra chat. Non attribuire a TopMediai risultati di altri generatori.

## Ambiente e configurazione

Installer pubblico, server e CLI supportano **solo la produzione**, con sito e API ufficiali integrati. I nuovi utenti non devono creare `.env`, scegliere ambienti, inserire host o copiare token. Opzioni: [.env.example](../../.env.example). Dettagli in [Configurazione di produzione (inglese)](../production-switch.md).

- Si usano API dirette per impostazione predefinita. Gli indirizzi devono essere origini HTTPS valide; i valori obbligatori esplicitamente vuoti vengono rifiutati. Il gateway precedente, limitato, si abilita solo impostando `TOPMEDIAI_PRODUCTION_GATEWAY_HOST`.
- L’installazione legge le impostazioni della shell e fissa indirizzi, ambiente e caricamenti. Imposta eventuali sostituzioni prima di installare. I commenti dell’esempio spiegano avvio diretto e CLI di accesso.
- Le installazioni normali usano credenziali private salvate. `TOPMEDIAI_TOKEN` è una sostituzione esplicita e non deve comparire in file pubblici, screenshot o segnalazioni. L’installazione standard cancella le sostituzioni precedenti.
- In Windows le credenziali si trovano in `%LOCALAPPDATA%\TopMediai\credentials\` e vengono riconvalidate prima di ogni chiamata. Cambiare account seleziona la cartella delle attività corrispondente; le richieste già in corso mantengono l’account originale.
- Generazione e caricamenti non richiedono interruttori aggiuntivi. I caricamenti richiedono sempre consenso per i file specifici e una cartella dedicata. Dopo modifiche ad API, impostazioni o codice, aggiorna configurazione e pacchetto e riconnetti MCP.
- La disconnessione locale elimina le credenziali salvate senza uscire dal sito, revocare token lato server o annullare attività inviate.

```powershell
npm.cmd run setup:plugin
```

Dopo gli aggiornamenti verifica `get_service_status.server_version`. Non presumere che sia necessario riavviare l’intera applicazione.

## Strumenti e flusso creativo

| Uso | Strumenti principali |
| --- | --- |
| Stato e accesso | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| Account e pianificazione | `get_balance`, `review_generation_plan` |
| Immagini | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| Riferimenti e anteprima immagini | `upload_reference_image`, `preview_image_task` |
| Musica | `list_music_models`, `estimate_music_cost`, `generate_music` |
| Video | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| Voce | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| Stato multimediale e riproduzione | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

Fa fede l’elenco effettivamente caricato. Se non viene indicato un modello, usa quello predefinito del catalogo corrente senza cambiarlo per prezzo o stile. Leggi parametri, limiti, lingue e capacità dal catalogo. La presenza di un modello non garantisce disponibilità del preventivo o della generazione.

Invia con preventivo valido, `request_id` stabile e budget esplicito. `review_generation_plan` riepiloga il flusso corrente. Per impostazione predefinita serve conferma per determinati modelli costosi o un totale stimato **strettamente superiore a 1000 crediti**. Le preferenze esplicite dell’utente prevalgono. Rivaluta preventivi scaduti, input cambiati o prezzi aumentati. Lo strumento non sostituisce il consenso e il budget locale non è un limite imposto dal server.

Timeout, annullamenti, disconnessioni e invii dall’esito sconosciuto non provano l’assenza di generazione o addebiti. Conserva gli identificatori originali, verifica la cronologia dell’account e non rigenerare automaticamente. Verifica la cronologia anche quando account o configurazione diversi nascondono vecchie attività.

Preferisci anteprime per le immagini completate. Per link scaduti richiama l’attività originale con `get_image_task({request_id, refresh_result:true})`; il rinnovo non è garantito. Consegna audio tramite player o link nominati e video tramite player integrato e link originali. Distingui errori di anteprima da errori di generazione e consegna i risultati riusciti anche in caso di fallimenti parziali.

## Anteprima video

Al completamento chiama `preview_video_task` con il `task_handle` originale e aggiungi link nominati ai video originali. Il player di sola lettura supporta avvio al clic, pausa, ricerca, volume, schermo intero e nuovi tentativi. Mostra i risultati parziali senza riaprire schede invariate.

L’anteprima legge attività salvate dell’account senza interrogare il backend, scaricare file in locale, generare, addebitare o modificare attività. Carica media solo da CDN video autorizzate, senza credenziali. Errori di interfaccia, formato o riproduzione mantengono i link originali e non giustificano nuove generazioni. Navigazione, screenshot e download richiedono una richiesta esplicita.

Aggiorna il pacchetto, riconnetti MCP e verifica `server_version=1.0.0`, 35 strumenti e `preview_video_task`. Visualizzazione e schermo intero dipendono dall’host.

## Caricamento dei riferimenti

Seleziona solo file autorizzati da una cartella dedicata, senza estendere l’accesso a cartelle personali o di credenziali.

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

Crea la cartella e inserisci i file autorizzati, poi aggiorna la configurazione e riconnetti MCP.

- **Immagini:** PNG/JPEG, massimo 5 MiB. Usa il `reference_image_id` restituito senza inventarlo o riutilizzarlo tra account. [Caricamento immagini (inglese)](../image-to-image-security.md).
- **Riferimenti video:** MP4/WAV/MP3. Servono cartella dedicata e FFmpeg/FFprobe locali. Consulta i limiti di numero, dimensioni, durata e combinazioni per modello/operazione. ID e ordine sono legati al preventivo.
- **Audio sorgente STS:** MP3/WAV/AAC/FLAC/AIFF/OGG, massimo 50 MiB e 300 secondi. Servono la stessa cartella e FFmpeg/FFprobe. [Guida vocale (inglese)](../speech-integration.md).

La validazione locale e la rimozione dei metadati non rendono privati i file cloud. Non copiare direttamente URL di caricamento, risultati o rapporti completi nelle segnalazioni pubbliche.

## Diagnostica e rapporti condivisi

```powershell
# Sola lettura, senza inviare generazioni
npm.cmd run diagnose
# Crea anche una copia depurata da condividere
npm.cmd run diagnose -- --share-report
```

La console mostra un riepilogo per impostazione predefinita. Il rapporto completo `.data/diagnostic-runs/latest-production.json` è privato. `.data/diagnostic-runs/shared-production.json` nasconde ID account, prompt, importi, URL multimediali, link privati e percorsi locali. Controllalo prima di condividerlo: rinominare il rapporto completo non lo depura. I normali risultati MCP continuano a mostrare saldi reali e link utilizzabili.

## Sviluppo e controlli di pubblicazione

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public` crea una copia indipendente dei file verificati e inizializza un repository Git locale senza la cronologia originale. Pubblica solo copie che superano i controlli. Modificare i file attuali non elimina la cronologia precedente. Vedi [Controlli di pubblicazione (inglese)](../releasing.md).

## Licenza

Il codice originale è distribuito con [MIT License](../../LICENSE), copyright TopMediai. Codice di terzi e dipendenze conservano le rispettive licenze e note.

La licenza del codice non concede l’uso gratuito dei servizi cloud TopMediai. Accesso, generazione, caricamenti e altri servizi restano soggetti a diritti dell’account, prezzi e condizioni applicabili. Nome, marchi e icona del brand sono esclusi da questa concessione MIT e richiedono l’autorizzazione appropriata.
