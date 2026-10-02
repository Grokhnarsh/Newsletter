# Newsletter

Selbst gehostetes, DSGVO-freundliches Newslettersystem mit REST-Backend, Versand-Worker und Admin-Oberfläche.
Läuft mit **Node.js ≥ 22.13** und der eingebauten SQLite-Datenbank (`node:sqlite`) – keine externe Datenbank, kein Build-Schritt.

## Funktionen

**Abonnenten & Listen**
- Abonnenten mit Status (aktiv, unbestätigt, abgemeldet, Bounce, Beschwerde), Vor-/Nachname und beliebigen eigenen Feldern
- Beliebig viele Listen (öffentlich wählbar oder intern), Mehrfachzuordnung
- Suche, Filter, Paginierung, Massenaktionen (Liste zuweisen/entfernen, Status setzen, löschen)
- CSV-Import (Trennzeichen-Erkennung, deutsche Spaltennamen, eigene Felder) und CSV-Export
- Aktivitätsprotokoll pro Abonnent (Anmeldung, Bestätigung, Öffnungen, Klicks, Abmeldung …)

**Anmeldung & Datenschutz**
- Gehostete Anmeldeseite (`/subscribe`), einbettbares HTML-Formular und JSON-API mit CORS
- Double-Opt-in mit anpassbarer Bestätigungs-E-Mail, optionale Willkommens-E-Mail
- Speicherung von Einwilligungszeitpunkt und IP-Adresse
- Honeypot-Spamschutz und Ratenbegrenzung, keine Preisgabe bereits eingetragener Adressen
- Präferenzseite für Abonnenten: Themen wählen, Namen ändern, abmelden, **Datenauskunft (JSON)** und **Löschung aller Daten**
- Abmeldelink in jeder Mail (wird automatisch ergänzt), `List-Unsubscribe` + One-Click-Abmeldung nach RFC 8058

**Kampagnen**
- HTML-Editor mit Werkzeugleiste, Platzhaltern und Live-Vorschau (Desktop/Mobil)
- Platzhalter wie `{{first_name}}`, `{{first_name | "Leser"}}`, `{{attributes.firma}}`, `{{unsubscribe_url}}` …
- Layout-Vorlagen mit `{{{content}}}`, Standardvorlage, automatische Textversion
- Testversand, sofortiger Versand oder Planung, Pausieren/Fortsetzen/Abbrechen, Duplizieren
- Öffentliches Newsletter-Archiv (`/archive`) und Webansicht pro Empfänger

**Versand & Auswertung**
- Hintergrund-Worker mit einstellbarer Rate (Token-Bucket), parallelem Versand und automatischen Wiederholungen mit Backoff
- Empfänger-Momentaufnahme beim Start; zwischenzeitlich abgemeldete Adressen werden übersprungen
- Öffnungs- und Klick-Tracking (abschaltbar), Klickzählung pro Link, kein offener Redirect
- Kampagnenberichte (Öffnungs-, Klick-, Klick-zu-Öffnungs-Rate, Abmeldungen, Bounces) und Dashboard mit Wachstumsdiagramm
- Bounce-/Beschwerde-Webhook (Hard-Bounce sperrt sofort, 3 Soft-Bounces in 30 Tagen ebenfalls)

**Administration**
- Benutzer mit Rollen *Administrator* und *Redakteur*, Passwort-Hashing mit scrypt
- API-Schlüssel für Integrationen (nur gehasht gespeichert)
- Einstellungen für Absender, Impressum/Fußzeile, Datenschutzlink, Versandrate, System-E-Mails

## Schnellstart

```bash
npm install
cp .env.example .env      # optional anpassen
npm start
```

Dann <http://localhost:3000/admin/> öffnen und das erste Administratorkonto anlegen.
Die Anmeldeseite für Abonnenten liegt unter <http://localhost:3000/subscribe>.

Ohne SMTP-Konfiguration werden E-Mails **nicht verschickt**, sondern als `.eml`-Dateien in `data/outbox/` abgelegt –
praktisch für die Entwicklung. Für den Echtbetrieb einen SMTP-Server angeben:

```bash
SMTP_URL=smtps://benutzer:passwort@smtp.example.com:465
BASE_URL=https://newsletter.example.com
```

### Docker

```bash
docker compose up -d --build
```

Daten (Datenbank und Outbox) liegen im Volume `newsletter-data`. Konfiguration über `.env` (siehe `.env.example`).

## Konfiguration

| Variable | Standard | Beschreibung |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | Öffentliche URL – wird für alle Links in E-Mails genutzt |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server-Adresse |
| `DATABASE_PATH` | `./data/newsletter.db` | SQLite-Datei |
| `TRUST_PROXY` | `false` | Hinter Reverse Proxy auf `true` setzen (korrekte Client-IP) |
| `MAIL_TRANSPORT` | `smtp` falls SMTP gesetzt, sonst `file` | `smtp`, `file` oder `log` |
| `SMTP_URL` | – | z. B. `smtp://user:pass@host:587` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | – | Alternative zu `SMTP_URL` |
| `MAIL_OUTBOX_DIR` | `./data/outbox` | Zielordner für `MAIL_TRANSPORT=file` |
| `WORKER_ENABLED` | `true` | Versand-Worker im Prozess starten |
| `WORKER_INTERVAL_MS` | `5000` | Takt des Workers |
| `MAIL_MAX_ATTEMPTS` | `3` | Versuche pro Empfänger, bevor er als fehlgeschlagen gilt |
| `SESSION_TTL_HOURS` | `168` | Gültigkeit einer Admin-Sitzung |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | Legt beim ersten Start automatisch einen Administrator an |

Die Versandrate (E-Mails pro Minute), Absender und alle Texte werden in der Admin-Oberfläche unter *Einstellungen* gepflegt.

## Platzhalter

| Platzhalter | Inhalt |
|---|---|
| `{{email}}`, `{{first_name}}`, `{{last_name}}`, `{{name}}` | Daten des Abonnenten |
| `{{attributes.feld}}` | Eigenes Feld (z. B. aus dem CSV-Import) |
| `{{first_name \| "Leser"}}` | Standardwert, falls das Feld leer ist |
| `{{unsubscribe_url}}`, `{{preferences_url}}`, `{{webview_url}}`, `{{archive_url}}` | Links |
| `{{site_name}}`, `{{company_address}}`, `{{privacy_url}}`, `{{subject}}`, `{{date}}`, `{{year}}` | Allgemeines |
| `{{confirm_url}}` | Bestätigungslink (nur in der Double-Opt-in-Mail) |
| `{{{content}}}` | Kampagneninhalt (nur in Vorlagen) |

Werte werden HTML-escaped; `{{{dreifache}}}` Klammern geben sie unverändert aus.

## REST-API

Alle Endpunkte unter `/api` erwarten `Authorization: Bearer <token>` – entweder ein Sitzungstoken aus
`POST /api/auth/login` oder einen API-Schlüssel (`nlk_…`, alternativ im Header `X-API-Key`).
API-Schlüssel haben Redakteursrechte. Fehler werden als `{"error": "…", "details": {…}}` geliefert.

| Methode & Pfad | Beschreibung |
|---|---|
| `GET /api/auth/status` · `POST /api/auth/setup` · `POST /api/auth/login` · `POST /api/auth/logout` | Einrichtung & Anmeldung |
| `GET/PUT /api/auth/me` | Eigenes Konto, Passwort ändern |
| `GET/POST /api/subscribers` | Liste (`q`, `status`, `list_id`, `page`, `per_page`, `sort`, `dir`) / anlegen |
| `GET/PUT/DELETE /api/subscribers/:id` | Details inkl. Aktivität / ändern / löschen |
| `POST /api/subscribers/import` | `{csv, list_ids, status, update_existing}` oder `{records: [...]}` |
| `GET /api/subscribers/export` | CSV-Export (gleiche Filter wie die Liste) |
| `POST /api/subscribers/bulk` | `{action: add_to_list \| remove_from_list \| set_status \| delete, ids, list_id, status}` |
| `POST /api/subscribers/:id/resend-confirmation` | Bestätigungs-Mail erneut senden |
| `GET/POST /api/lists`, `GET/PUT/DELETE /api/lists/:id` | Listen |
| `GET/POST /api/templates`, `GET/PUT/DELETE /api/templates/:id`, `POST …/duplicate` | Vorlagen |
| `GET/POST /api/campaigns`, `GET/PUT/DELETE /api/campaigns/:id` | Kampagnen |
| `POST /api/campaigns/preview` · `POST /api/campaigns/audience` | Vorschau beliebiger Inhalte · Empfängeranzahl für Listen |
| `GET /api/campaigns/:id/preview` | Gerenderte Vorschau (HTML oder `?format=json`) |
| `POST /api/campaigns/:id/{test,send,schedule,unschedule,pause,resume,cancel,duplicate}` | Aktionen |
| `GET /api/campaigns/:id/report` · `GET /api/campaigns/:id/recipients` | Bericht · Empfänger (`status=sent\|opened\|clicked\|failed…`) |
| `GET /api/stats/overview?days=30` | Dashboard-Kennzahlen |
| `POST /api/webhooks/bounce` | `{email, type: hard \| soft \| complaint, reason}` |
| `GET/PUT /api/settings`, `POST /api/settings/test-email` | Einstellungen *(Admin)* |
| `GET/POST/PUT/DELETE /api/users…` · `GET/POST/DELETE /api/api-keys…` | Benutzer & API-Schlüssel *(Admin)* |

Öffentliche Endpunkte (ohne Anmeldung):

| Pfad | Beschreibung |
|---|---|
| `GET /subscribe`, `POST /subscribe` | Gehostete Anmeldeseite / Formularziel |
| `POST /api/public/subscribe` | JSON- oder Formular-Anmeldung, CORS aktiviert |
| `GET /api/public/lists` | Öffentliche Listen |
| `GET /confirm/:token` | Double-Opt-in-Bestätigung |
| `GET/POST /unsubscribe/:token` | Abmeldung (POST unterstützt RFC 8058 One-Click) |
| `GET/POST /preferences/:token`, `…/export`, `…/delete` | Präferenzen, Datenauskunft, Löschung |
| `GET /t/o/:token.gif`, `GET /t/c/:token/:linkId` | Öffnungs- und Klick-Tracking |
| `GET /view/:token`, `GET /archive`, `GET /archive/:id` | Webansicht und Archiv |
| `GET /health` | Health-Check |

Beispiel:

```bash
curl -X POST https://newsletter.example.com/api/subscribers \
  -H "Authorization: Bearer nlk_…" -H "Content-Type: application/json" \
  -d '{"email":"anna@example.com","first_name":"Anna","list_ids":[1],"attributes":{"firma":"ACME"}}'
```

## Projektstruktur

```
src/
  server.js            Einstiegspunkt (HTTP-Server + Versand-Worker)
  app.js               Express-App und Service-Verdrahtung
  config.js            Konfiguration aus Umgebungsvariablen
  db/                  SQLite-Wrapper und Migrationen
  lib/                 Rendering, Mailer, CSV, Validierung, Sicherheit, Seiten
  services/            Geschäftslogik (Abonnenten, Listen, Kampagnen, Versand, Statistik …)
  routes/              REST-API und öffentliche Seiten
  middleware/          Authentifizierung und Fehlerbehandlung
public/admin/          Admin-Oberfläche (Vanilla-JS-Module, kein Build nötig)
test/                  Tests (node:test)
```

## Entwicklung

```bash
npm run dev    # Server mit automatischem Neustart
npm test       # Tests ausführen
```

## Hinweise für den Produktivbetrieb

- `BASE_URL` auf die öffentliche HTTPS-Adresse setzen und den Dienst hinter einem Reverse Proxy mit TLS betreiben (`TRUST_PROXY=true`).
- Für die Absender-Domain SPF, DKIM und DMARC einrichten, sonst landen Mails im Spam.
- Die Versandrate an die Limits des SMTP-Anbieters anpassen.
- Das Verzeichnis mit der SQLite-Datenbank regelmäßig sichern.
- Der Versand-Worker und die Ratenbegrenzung laufen im Prozess – das System ist für **eine** Instanz ausgelegt.

## Lizenz

GPL-3.0 – siehe [LICENSE](LICENSE).
