# TopMediAi-MCP

[English](../../README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Deutsch** · [Français](README.fr.md) · [Español](README.es.md) · [Italiano](README.it.md) · [繁體中文](README.zh-TW.md)

Lokaler TypeScript-MCP-Server über stdio und Codex-Plugin für TopMediai. Version **1.0.0** unterstützt Bildgenerierung, Bild-zu-Bild, Musik, Video, Videos mit gemischten Referenzmedien, Text-to-Speech (TTS) und Speech-to-Speech (STS). Enthalten sind Modellkataloge, Kostenschätzungen, Budgetprüfung, Aufgabenwiederherstellung sowie Bild-, Audio- und Videovorschau. Rauschunterdrückung, Stimmenklonen und Musikvideos sind nicht verfügbar.

Die Generierung nutzt die Kontingente des angemeldeten Kontos. Vor dem Absenden den Modellkatalog und ein genaues Angebot abrufen; Budget und Bestätigungspräferenzen des aktuellen Chats beachten. Uploads benötigen die Erlaubnis zur externen Speicherung. Hochgeladene URLs können öffentlich zugänglich sein. Siehe [Daten und Datenschutz (Englisch)](../privacy.md).

## Installation und Anmeldung

Erforderlich sind Node.js >= 22.18 und Zugriff auf die offizielle Verbindungsseite. Nur der Codex-Installer benötigt die Codex CLI, der Cursor-Installer nicht. Browser und MCP müssen auf demselben Computer laufen. In PowerShell `npm.cmd` verwenden, in anderen unterstützten Shells auch `npm`.

Im Projektverzeichnis ausführen:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

Für Cursor nach der Abhängigkeitsinstallation `npm.cmd run install:cursor` ausführen; für ein einzelnes Projekt `-- --project ./my-project` ergänzen. Siehe [Cursor-Anleitung (Englisch)](../cursor.md).

Das Plugin heißt in Codex `TopMediAi-MCP`; seine Installationskennung lautet `topmediai-mcp@topmediai-local`. Die Installation erstellt lokal `plugin/.mcp.json`, ohne Tokens oder Cookies im Plugin abzulegen. Die Datei enthält lokale Programmpfade und darf weder versioniert noch verteilt werden. Nach einem Umzug des Projekts oder Computerwechsel neu installieren.

Im aktuellen Chat `get_service_status` aufrufen. Bei Bedarf mit `start_login` die offizielle Seite öffnen, das Konto prüfen und die Verbindung bestätigen. `wait_for_login` mit derselben `login_id` wiederholen, bis die Zugangsdaten gespeichert sind oder die Sitzung endet. Danach im selben Chat Status und Guthaben mit `get_service_status` und `get_balance` prüfen und die ursprüngliche Anfrage fortsetzen. Kein Neustart von Codex oder MCP erforderlich.

Alternative CLI-Befehle:

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

Die Anmeldung wartet höchstens zehn Minuten. Private Verbindungslinks bleiben standardmäßig verborgen. Öffnet sich der Browser nicht, `--show-private-link` nur lokal verwenden. Den Link niemals teilen, fotografieren oder in den Chat kopieren.

Der Installationstest bestätigt nur den Start eines separaten MCP-Prozesses, nicht die geladenen Chat-Tools oder gültige Zugangsdaten. Bei fehlenden Tools Plugin-Aktivierung prüfen, Paket aktualisieren und MCP neu verbinden; gegebenenfalls einen neuen Chat beginnen. Ergebnisse anderer Generatoren niemals TopMediai zuschreiben.

## Umgebung und Konfiguration

Installer, Server und CLI der öffentlichen Ausgabe unterstützen **nur die Produktionsumgebung** mit eingebauten Website- und API-Adressen. Neue Nutzer müssen weder `.env` anlegen noch Umgebung, Hostnamen oder Tokens eingeben. Optionale Anpassungen: [.env.example](../../.env.example). Details: [Produktionskonfiguration (Englisch)](../production-switch.md).

- Standardmäßig werden direkte APIs genutzt. Adressen müssen gültige HTTPS-Origins sein; ausdrücklich leere Pflichtwerte werden abgelehnt. Das eingeschränkte ältere Gateway wird nur über `TOPMEDIAI_PRODUCTION_GATEWAY_HOST` aktiviert.
- Die Installation liest Shell-Einstellungen und legt Adressen, Umgebung und Upload-Konfiguration fest. Überschreibungen vorher setzen. Unterschiede beim direkten Start und der Login-CLI stehen in den Beispielkommentaren.
- Reguläre Installationen nutzen privat gespeicherte Zugangsdaten. `TOPMEDIAI_TOKEN` ist eine ausdrückliche Überschreibung und gehört nie in öffentliche Dateien, Screenshots oder Fehlerberichte. Die Standardinstallation leert alte Überschreibungen.
- Zugangsdaten werden in Windows Credential Manager, macOS Keychain oder Linux Secret Service gespeichert und vor jedem Aufruf neu gelesen. Geladene gespeicherte Daten melden `credential_source=system-store`; `credential_storage` nennt den Speicher. Kontowechsel wählen das passende Aufgabenverzeichnis; laufende Anfragen behalten ihre ursprünglichen Zugangsdaten.
- **Nach dem Upgrade von JSON-Speicherung erneut anmelden.** Alte JSON-Dateien werden weder gelesen noch migriert oder automatisch gelöscht. Das frühere Verzeichnis enthält nur noch Metadaten für Anmeldesperren; alte geheime Dateien gesondert behandeln und niemals veröffentlichen. Linux benötigt Desktop-D-Bus und Secret Service. Bei gesperrtem, verweigertem oder fehlendem Speicher gibt es keinen Klartext-Fallback. Computerpasswörter nur im Systemdialog eingeben.
- Speichern, Lesen und Löschen unter Windows wurden isoliert geprüft; vollständige macOS/Linux-Clientabläufe benötigen noch Praxistests. Codex/Cursor unter demselben OS-Benutzer teilen Produktionszugangsdaten; Abmelden oder Kontowechsel betrifft folgende Aufrufe beider Clients. Der Speicher isoliert nicht sämtliche Prozesse desselben Benutzers.
- Generierung und Uploads benötigen keine zusätzlichen Funktionsschalter. Uploads verlangen weiterhin Zustimmung für konkrete Dateien und ein eigenes Verzeichnis. Nach Änderungen an Adressen, Upload-Einstellungen oder Code Konfiguration und Paket aktualisieren und MCP neu verbinden.
- Lokales Abmelden löscht nur gespeicherte Zugangsdaten. Es meldet nicht die Website ab, widerruft keine Server-Tokens und storniert keine Aufgaben.

```powershell
npm.cmd run setup:plugin
```

Nach Aktualisierungen `get_service_status.server_version` prüfen; ein Neustart der gesamten Anwendung ist nicht grundsätzlich nötig.

Client-Identität pro Start über `MCP_CLIENT_SOURCE`: Codex `5`, Claude Code `6`, Cursor `7`, unbekannt ohne Header. Installer setzen ihren eigenen Wert; `TOPMEDIAI_SOURCE` im Request-Body bleibt unverändert. Nach Updates Startkonfiguration aktualisieren und neu verbinden. Siehe [Client-Identität (Englisch)](../client-source.md).

Videooperationen mit Audioschalter erzeugen standardmäßig Ton, wenn `generate_audio` fehlt. Für ausdrücklich stumme Videos `false` setzen. Modelle ohne Schalter behalten das Anbieterverhalten; Modelle mit festem Audio lassen sich nicht stummschalten. Katalog, Angebot und Übermittlung müssen übereinstimmen; nach Änderungen neu kalkulieren.

## Tools und Arbeitsablauf

| Zweck | Wichtigste Tools |
| --- | --- |
| Status und Anmeldung | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| Konto und Planung | `get_balance`, `review_generation_plan` |
| Bilder | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| Bildreferenzen und Vorschau | `upload_reference_image`, `preview_image_task` |
| Musik | `list_music_models`, `estimate_music_cost`, `generate_music` |
| Video | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| Sprache | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| Multimedia-Abfragen und Wiedergabe | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

Maßgeblich ist die tatsächlich geladene Tool-Liste. Ohne Modellvorgabe das aktuelle Katalog-Standardmodell verwenden, nicht eigenständig nach Preis oder Stil wechseln. Parameter, Referenzlimits, Sprachen und Fähigkeiten aus dem Katalog lesen. Ein gelistetes Modell garantiert weder Angebot noch Generierung.

Vor dem Absenden ein gültiges Angebot, eine stabile `request_id` und ein ausdrückliches Budget verwenden. `review_generation_plan` fasst den aktuellen Ablauf zusammen. Standardmäßig ist bei festgelegten teuren Modellen oder einer geschätzten Gesamtsumme **über 1000 Credits** eine Bestätigung nötig. Ausdrückliche Nutzerpräferenzen haben Vorrang. Abgelaufene Angebote, geänderte Eingaben oder Preissteigerungen erneut prüfen. Das Tool ersetzt keine Zustimmung; lokale Budgets sind keine serverseitige Ausgabengarantie.

Zeitüberschreitungen, Abbrüche, Verbindungsverluste und unklare Übermittlungen beweisen nicht, dass keine Generierung oder Abbuchung stattfand. Ursprüngliche Kennungen erhalten, Kontoverlauf prüfen und nie automatisch neu generieren. Das gilt auch für nach Konto- oder Konfigurationswechseln nicht auffindbare Aufgaben.

Fertige Bilder bevorzugt als Vorschau zeigen. Abgelaufene Bildlinks über die ursprüngliche Aufgabe mit `get_image_task({request_id, refresh_result:true})` abfragen; eine Verlängerung ist nicht garantiert. Audio über Player oder benannte Links, Video über den eingebetteten Player mit Originallinks liefern. Vorschaufehler von Generierungsfehlern unterscheiden und Teilerfolge ausliefern.

## Videovorschau

Nach Abschluss `preview_video_task` mit dem ursprünglichen `task_handle` aufrufen und benannte Originallinks beifügen. Der schreibgeschützte Player bietet Wiedergabe per Klick, Pause, Spulen, Lautstärke, Vollbild und Wiederholung. Teilerfolge anzeigen; unveränderte Karten nicht erneut öffnen.

Die Vorschau liest gespeicherte kontoabhängige Aufgaben ohne Backend-Abfragen, lokale Mediendownloads, Generierung, Kosten oder Änderungen an Aufgaben. Medien werden nur von genehmigten Video-CDNs ohne Kontozugangsdaten geladen. Fehlende UI-/Formatunterstützung oder Wiedergabefehler erhalten Originallinks und rechtfertigen keine Neugenerierung. Browsernavigation, Screenshots und Downloads erfordern ausdrückliche Nutzeranfragen.

Paket aktualisieren, MCP neu verbinden und `server_version=1.0.0`, 35 Tools sowie `preview_video_task` prüfen. Darstellung und Vollbild hängen vom Host ab.

## Referenzmedien hochladen

Nur genehmigte Dateien aus einem eigenen Verzeichnis auswählen; den Zugriff nicht auf persönliche oder Zugangsdaten-Verzeichnisse ausweiten.

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

Zuerst Verzeichnis erstellen und genehmigte Dateien ablegen, dann Konfiguration aktualisieren und MCP neu verbinden.

- **Bilder:** PNG/JPEG, höchstens 5 MiB. Zurückgegebene `reference_image_id` verwenden; IDs weder erraten noch kontoübergreifend nutzen. [Bild-Uploads (Englisch)](../image-to-image-security.md).
- **Videoreferenzen:** MP4/WAV/MP3. Eigenes Verzeichnis und lokales FFmpeg/FFprobe erforderlich. Mengen-, Größen-, Dauer- und Kombinationsgrenzen im jeweiligen Operationskatalog prüfen. IDs und Reihenfolge sind an das Angebot gebunden.
- **STS-Quellaudio:** MP3/WAV/AAC/FLAC/AIFF/OGG, höchstens 50 MiB und 300 Sekunden. Gleiches Verzeichnis und FFmpeg/FFprobe erforderlich. [Sprachleitfaden (Englisch)](../speech-integration.md).

Lokale Validierung und Metadatenentfernung machen Cloud-Dateien nicht privat. Upload-URLs, Ergebnislinks und vollständige lokale Berichte nicht direkt in öffentliche Fehlerberichte übernehmen.

## Diagnose und freigegebene Berichte

```powershell
# Nur lesende Abfragen, keine Generierung
npm.cmd run diagnose
# Zusätzlich eine bereinigte Kopie zum Teilen erstellen
npm.cmd run diagnose -- --share-report
```

Die Konsole zeigt standardmäßig eine Zusammenfassung. `.data/diagnostic-runs/latest-production.json` ist der private vollständige Bericht. `.data/diagnostic-runs/shared-production.json` verbirgt Konto-IDs, Prompts, Beträge, Medien-URLs, private Links und lokale Pfade. Vor dem Teilen prüfen; bloßes Umbenennen bereinigt den vollständigen Bericht nicht. Normale MCP-Ergebnisse enthalten weiterhin echte Guthaben und Ergebnislinks.

## Entwicklung und Veröffentlichungsprüfung

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public` erstellt aus geprüften Dateien einen unabhängigen öffentlichen Snapshot und ein lokales Git-Repository ohne alte Historie. Nur geprüfte Snapshots veröffentlichen. Änderungen aktueller Dateien löschen keine früheren Commits. Siehe [Veröffentlichungsprüfung (Englisch)](../releasing.md).

## Lizenz

Originalcode steht unter der [MIT License](../../LICENSE), Copyright TopMediai. Fremdcode und Abhängigkeiten behalten ihre eigenen Lizenzen und Urheberrechtshinweise.

Die Quellcodelizenz erlaubt keine kostenlose Nutzung der TopMediai-Cloud. Anmeldung, Generierung, Uploads und andere Dienste unterliegen Kontingenten, Preisen und Nutzungsbedingungen. Name, Marken und Markenlogo sind von dieser MIT-Lizenz ausgenommen und benötigen eine entsprechende Nutzungserlaubnis.
