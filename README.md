# Modulares CMS

Selbst gehostetes, modulares Content-Management-System mit mehrsprachiger Website, Blog, Medienbibliothek,
Menüs, Formularen, Besucherstatistik und integriertem Newslettersystem. Läuft mit **Node.js ≥ 22.13** und der eingebauten SQLite-Datenbank
(`node:sqlite`) – keine externe Datenbank, kein Build-Schritt.

Jede Funktion steckt in einem **Modul**, das sich in der Admin-Oberfläche ein- und ausschalten lässt.
Eigene Module legst du einfach im Ordner `modules/` ab.

## Module im Überblick

| Modul | Funktionen |
|---|---|
| **Seiten** (`pages`) | Hierarchische Seiten mit schönen URLs (`/leistungen/webdesign`), Brotkrumen, Vorlagen (Standard, volle Breite, Landingpage), SEO-Felder, Titelbild, Revisionen mit Wiederherstellen, frei wählbare Startseite, Übersetzungen, Freigabe-Workflow, Baustein `[child_pages]` |
| **Blog** (`blog`) | Beiträge mit Kategorien, Teaser, Titelbild, geplanter Veröffentlichung, RSS-Feed je Sprache (`/blog/feed.xml`), Kategorie-Seiten, Paginierung, Revisionen, Übersetzungen, Freigabe-Workflow, Baustein `[recent_posts]`, „Als Newsletter versenden“ |
| **Medien** (`media`) | Medienbibliothek mit Drag-&-Drop-Upload, Typprüfung anhand der Dateisignatur (JPG, PNG, GIF, WebP, PDF, MP4, MP3), Alternativtexte, Auswahldialog. Mit dem (optionalen) Paket `sharp`: Bilder verkleinern, Metadaten entfernen, WebP-Varianten mit `srcset`, Lazy Loading |
| **Formulare** (`forms`) | Formular-Builder (Text, E-Mail, Auswahl, Checkbox …), Baustein `[form id="…"]`, Einsendungen mit CSV-Export, E-Mail-Benachrichtigung, Spam-Schutz ohne Captcha, optionale Newsletter-Anmeldung. Bei der Einrichtung entsteht eine Kontaktseite |
| **Menüs** (`menus`) | Haupt- und Fußzeilenmenü mit Untermenüs, je Sprache; Einträge verlinken Seiten, Blog, Startseite oder eigene URLs. Entwürfe und gelöschte Seiten werden automatisch ausgeblendet |
| **Weiterleitungen** (`redirects`) | 301/302/410 mit Platzhaltern, automatische Weiterleitungen bei geänderten Adressen von Seiten, Beiträgen und Kategorien (ohne Ketten), Protokoll nicht gefundener Seiten (404) |
| **Statistik** (`stats`) | Besucherstatistik **ohne Cookies und ohne IP-Speicherung**: Aufrufe, eindeutige Besucher (täglich wechselnder Schlüssel), Top-Seiten, Herkunft, Geräte – kein Cookie-Banner nötig |
| **Newsletter** (`newsletter`) | Abonnenten, Listen, **Segmente** nach Regeln, Double-Opt-in, CSV-Import/-Export, Kampagnen mit Vorlagen und Platzhaltern, **A/B-Test des Betreffs**, Testversand, Planung, **Automationen** (z. B. Willkommensserie), Versand-Worker mit Ratenbegrenzung, Öffnungs- und Klick-Tracking (immer, nur mit Einwilligung oder aus), Berichte, Archiv, DSGVO-Präferenzseite, One-Click-Abmeldung, **Bounce-Webhooks** für Amazon SES, Mailgun, Postmark, Brevo und SendGrid, Anmelde-Widget und Baustein `[newsletter_form]` |

**Kern** (immer aktiv): Benutzer mit Rollen (Administrator, Redakteur, Autor), Zwei-Faktor-Anmeldung (TOTP),
Passwort-Reset per E-Mail, Änderungsprotokoll, API-Schlüssel, Einstellungen, Backups, Theme-System,
Mehrsprachigkeit, Shortcodes/Bausteine, Volltextsuche (`/suche`, SQLite FTS5), Seiten-Cache, `sitemap.xml`,
`robots.txt`, Open-Graph-Tags, HTML-Bereinigung aller Inhalte, Dashboard mit Kennzahlen aller Module.

**Admin-Oberfläche**: WYSIWYG-Editor (Formatierung, Links, Bilder aus der Medienbibliothek, YouTube/Vimeo,
Tabellen, Bausteine, HTML-Quelltext, bereinigtes Einfügen aus Word), Vorschau im Website-Design,
Hell-/Dunkelmodus, mobil nutzbar.

## Schnellstart

```bash
npm install
npm start
```

Dann <http://localhost:3000/admin/> öffnen und das erste Administratorkonto anlegen. Dafür wird der
**Einrichtungscode** benötigt, den der Server beim Start ins Log schreibt (bei Docker: `docker compose logs`),
damit niemand anderes eine frisch gestartete Instanz übernehmen kann. Bei der Einrichtung
werden Startinhalte erzeugt: eine Startseite, „Über uns“, Entwürfe für Impressum und Datenschutz, ein erster
Blogbeitrag, Menüs, eine Newsletter-Liste und eine E-Mail-Vorlage.
Die Website ist unter <http://localhost:3000/> erreichbar.

Für die Bildoptimierung wird das Paket `sharp` als optionale Abhängigkeit mitinstalliert. Fehlt es (z. B. auf
Plattformen ohne vorkompilierte Version), funktioniert alles andere weiter – Bilder werden dann unverändert gespeichert.

Ohne SMTP-Konfiguration werden E-Mails nicht verschickt, sondern als `.eml`-Dateien in `data/outbox/`
abgelegt. Für den Echtbetrieb:

```bash
SMTP_URL=smtps://benutzer:passwort@smtp.example.com:465
BASE_URL=https://www.example.com
```

### Docker

```bash
docker compose up -d --build
```

Datenbank, Uploads, Backups und Outbox liegen im Volume `newsletter-data` (`/data`).

## Konfiguration

| Variable | Standard | Beschreibung |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | Öffentliche URL (Links in E-Mails, Sitemap, RSS, kanonische URLs) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server-Adresse |
| `DATABASE_PATH` | `./data/newsletter.db` | SQLite-Datei |
| `UPLOADS_DIR` | `./data/uploads` | Ablage der Medienbibliothek (öffentlich unter `/uploads/`) |
| `BACKUPS_DIR` | `./data/backups` | Ablage der Backups (ZIP mit Datenbank und Uploads) |
| `MODULES_DIR` | `./modules` | Ordner mit eigenen Modulen |
| `THEME` | `default` | Theme-Ordner in `themes/` oder `src/themes/` |
| `TRUST_PROXY` | `false` | Hinter Reverse Proxy auf `true` setzen – dann darf der Port **nur** für den Proxy erreichbar sein, sonst lässt sich die Absender-IP fälschen |
| `MAIL_TRANSPORT` | `smtp` falls SMTP gesetzt, sonst `file` | `smtp`, `file` oder `log` |
| `SMTP_URL` bzw. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | – | SMTP-Zugang |
| `MAIL_OUTBOX_DIR` | `./data/outbox` | Zielordner für `MAIL_TRANSPORT=file` |
| `WORKER_ENABLED`, `WORKER_INTERVAL_MS`, `MAIL_MAX_ATTEMPTS` | `true`, `5000`, `3` | Newsletter-Versand-Worker |
| `SESSION_TTL_HOURS` | `168` | Gültigkeit einer Admin-Sitzung |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | Legt beim ersten Start automatisch einen Administrator an |
| `SETUP_TOKEN` | zufällig | Fester Einrichtungscode für das erste Administratorkonto (sonst steht ein zufälliger im Log) |

Alles Weitere (Website-Name, Sprachen, Startseite, Farben, Logo, Absender, Versandrate, Tracking, automatische
Backups, Seiten-Cache, Texte …) wird in der Admin-Oberfläche unter *Einstellungen* gepflegt.

## Rollen und Freigabe

| Rolle | Rechte |
|---|---|
| **Administrator** | alles, inkl. Benutzer, Module, Einstellungen, API-Schlüssel, Backups, Protokoll |
| **Redakteur** | alle Inhalte, Veröffentlichen, Menüs, Formulare, Weiterleitungen, Newsletter, Statistik |
| **Autor** | nur Seiten, Blog und Medien: eigene Entwürfe schreiben und **zur Prüfung einreichen**, eigene Uploads verwalten |

Reicht ein Autor einen Entwurf ein, bekommen Redakteure und Administratoren eine E-Mail. Sie veröffentlichen ihn
(Status „Veröffentlicht“) oder geben ihn mit einem Hinweis zurück – der Autor wird jeweils per E-Mail informiert.
Veröffentlichte und fremde Inhalte sind für Autoren schreibgeschützt.

Neue Benutzer können mit Passwort oder per **Einladung** (Link zum Festlegen des Passworts) angelegt werden.
Unter *Mein Konto* lässt sich die Zwei-Faktor-Anmeldung mit einer Authenticator-App einrichten (inkl. zehn
Wiederherstellungscodes); Administratoren können sie für andere Konten zurücksetzen.

## Mehrsprachigkeit

Unter *Einstellungen › Website › Sprachen* die Sprachkürzel eintragen, z. B. `de, en`. Die erste ist die
Standardsprache ohne Präfix, weitere Sprachen liegen unter `/en/…`.

- Im Editor von Seiten und Beiträgen wählt man die Sprache und legt mit **„Übersetzung anlegen“** eine Kopie als
  Entwurf in der Zielsprache an. Seiten dürfen in jeder Sprache dieselbe Adresse haben (`/ueber-uns`, `/en/ueber-uns`).
- Die Startseite und ihre Übersetzungen erscheinen unter `/` bzw. `/en`. Blogliste, Feed, Kategorien, Sitemap
  und Suche zeigen jeweils die Inhalte der Sprache.
- Unter *Menüs* gibt es je Sprache eigene Menüs. Bleiben sie leer, wird das Menü der Standardsprache verwendet –
  Einträge für Seiten zeigen dann automatisch auf die Übersetzung.
- Das Theme setzt `<html lang>`, `hreflang`-Verweise (inkl. `x-default`) und zeigt einen Sprachumschalter, der
  auf die Übersetzung der aktuellen Seite führt. Texte des Themes gibt es auf Deutsch, Englisch, Französisch und
  Spanisch.

## Backups und Wiederherstellung

Unter *Einstellungen › Backup & Wartung* lässt sich ein Backup (ZIP mit konsistentem Datenbank-Snapshot und allen
Uploads) herunterladen oder auf dem Server ablegen; automatische Backups mit einstellbarem Abstand und
Aufbewahrungsanzahl landen in `BACKUPS_DIR`. Wiederherstellen bei **gestopptem** Server:

```bash
npm run restore -- data/backups/backup-2026-10-08-0300.zip
```

Die bisherige Datenbank und der Upload-Ordner werden dabei als `*.vor-wiederherstellung` aufbewahrt. Danach den
Suchindex unter *Backup & Wartung* neu aufbauen (geschieht beim Start automatisch, wenn er leer ist).

## Newsletter: Bounces und Tracking

Die Webhook-Adressen für Bounces und Spam-Beschwerden stehen unter *Einstellungen › Newsletter* – je eine für
Amazon SES (SNS-Abonnement wird automatisch bestätigt), Mailgun, Postmark, Brevo, SendGrid und ein allgemeines
JSON-Format. Hard-Bounces und Beschwerden sperren die Adresse sofort, Soft-Bounces nach drei Fehlschlägen in
30 Tagen. Die Adressen enthalten einen geheimen Schlüssel und lassen sich erneuern.

Öffnungs- und Klick-Tracking ist einstellbar: für alle, **nur mit Einwilligung** (zusätzliches Häkchen im
Anmeldeformular, widerrufbar auf der Einstellungsseite der Abonnenten) oder ganz aus.

## Bausteine (Shortcodes)

In Seiten und Beiträgen über das Baustein-Menü des Editors einfügbar:

| Baustein | Modul | Ausgabe |
|---|---|---|
| `[recent_posts limit="3" category="neuigkeiten"]` | Blog | Neueste Beiträge als Karten |
| `[child_pages]` / `[child_pages id="5"]` | Seiten | Liste der Unterseiten |
| `[newsletter_form title="Bleib informiert"]` | Newsletter | Anmeldeformular |
| `[form id="1"]` | Formulare | Formular aus dem Formular-Builder |

Bausteine deaktivierter Module verschwinden automatisch aus der Ausgabe.

## Architektur

```
src/
  server.js            Einstiegspunkt
  app.js               Baut Kern, Module und Express-App zusammen (createCms)
  core/                Modulverwaltung, Hooks, Einstellungen, Benutzer, 2FA, Protokoll, Backups, Suche,
                       Cache, Sprachen, Freigabe, Website/Theme, Inhalte & Bausteine
  tools/restore.js     Wiederherstellung eines Backups (npm run restore)
  modules/             Mitgelieferte Module (pages, blog, media, forms, menus, redirects, stats, newsletter)
    <modul>/index.js   Moduldefinition (Backend)
    <modul>/admin/     Admin-Skripte (werden unter /admin/modules/<modul>/ ausgeliefert)
  themes/default/      Standard-Theme (index.js + assets/)
  db/, lib/, middleware/
public/admin/          Admin-Rahmen: Anmeldung, Navigation, Dashboard, Einstellungen, Editor, Registry
modules/               Eigene Module (werden automatisch geladen)
examples/modules/      Beispielmodul „Hinweisbanner“
test/                  Tests (node:test)
```

Bestehende Datenbanken der reinen Newsletter-Version werden beim Start automatisch übernommen.

## Eigene Module entwickeln

Ein Modul ist ein Ordner mit einer `index.js`, deren Default-Export das Modul beschreibt. Lege ihn in
`modules/` ab und starte den Server neu. Ein vollständiges Beispiel mit Einstellungen, Migration, Hooks,
öffentlicher Route, API und Admin-Skript liegt in [`examples/modules/hinweisbanner`](examples/modules/hinweisbanner).

```js
// modules/termine/index.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
  name: 'termine',                     // eindeutig, Kleinbuchstaben
  label: 'Termine',
  description: 'Veranstaltungskalender',
  version: '1.0.0',
  requires: ['pages'],                 // optionale Abhängigkeiten
  adminDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin'),

  settings: { defaults: { termine_titel: 'Termine' }, rules: { termine_titel: { type: 'string', max: 100 } } },
  migrations: [{ version: 1, sql: 'CREATE TABLE termine (id INTEGER PRIMARY KEY, titel TEXT NOT NULL, datum TEXT NOT NULL)' }],

  setup(ctx) {
    // Services an den Kontext hängen, Hooks und Bausteine registrieren
    ctx.hooks.on('site.search', (q) => [], { module: 'termine' });
    ctx.content.registerShortcode('termine', () => '<ul>…</ul>', { module: 'termine', description: 'Nächste Termine' });
  },
  api(router, ctx) { router.get('/termine', (req, res) => res.json(ctx.db.all('SELECT * FROM termine'))); },
  publicRoutes(router, ctx) { router.get('/termine', (req, res) => ctx.site.send(req, res, { title: 'Termine', content: '…' })); },
};
```

**Bestandteile einer Moduldefinition**

| Eigenschaft | Bedeutung |
|---|---|
| `migrations` | `[{ version, sql }]` – werden pro Modul einmalig ausgeführt |
| `settings` | `{ defaults, rules }` – Einstellungen inkl. Validierung (`string`, `int`, `bool`, `email`, `enum`, `pattern` …) |
| `setup(ctx)` | Initialisierung: Services, Hooks, Bausteine |
| `api(router, ctx)` | Authentifizierte Routen unter `/api` |
| `publicApi(router, ctx)` | Öffentliche Routen unter `/api` |
| `publicRoutes(router, ctx)` | Öffentliche Website-Routen |
| `fallbackRoutes(router, ctx)` | Routen nach allen anderen (z. B. Seiten-Slugs) |
| `start(ctx)` / `stop(ctx)` | Lebenszyklus (z. B. Hintergrund-Worker) |
| `adminDir`, `adminEntry` | Admin-Skripte (Standard-Einstieg `index.js`) |
| `requires`, `core`, `defaultEnabled` | Abhängigkeiten, nicht abschaltbar, Startzustand |

Routen deaktivierter Module antworten automatisch mit 404, ihre Hooks und Bausteine werden übersprungen.

**Der Kontext `ctx`** enthält `db`, `config`, `settings`, `hooks`, `content`, `site`, `users`, `modules`,
`mailer`, `logger` sowie die Services der Module (z. B. `ctx.pages`, `ctx.posts`, `ctx.media`, `ctx.menus`,
`ctx.subscribers`, `ctx.campaigns`).

**Hooks**

| Hook | Art | Zweck |
|---|---|---|
| `site.home` | first | Inhalt der Startseite (Seiten-Modul Priorität 5, Blog 20) |
| `site.menu` | first | Menüeinträge für eine Position (`main`, `footer`) |
| `site.widgets` | collect | HTML für Widget-Bereiche (`top`, `footer`) |
| `site.head` | collect | Zusätzliches HTML im `<head>` |
| `site.search` | collect | Suchtreffer `{ title, url, excerpt, type }` |
| `site.sitemap` | collect | Einträge `{ loc, lastmod }` |
| `site.reserved` | collect | Belegte erste URL-Segmente (verhindert Konflikte mit Seiten-Slugs) |
| `menus.resolve` | first | URL für Menüeinträge eines Typs |
| `admin.dashboard` | collect | Kennzahlen für das Dashboard (`{ modulname: {...} }`) |
| `settings.validate` | collect | Zusätzliche Prüfung beim Speichern von Einstellungen |
| `system.setup` | collect | Startinhalte bei der Ersteinrichtung |
| `blog.post.published` | emit | Ein Beitrag wurde veröffentlicht |

**Admin-Skript** (`admin/index.js`):

```js
import { get } from '/admin/js/api.js';
import { html, setHtml } from '/admin/js/ui.js';

export default function register(cms) {
  cms.nav({ href: '#/termine', label: 'Termine', icon: 'blog', group: 'Inhalte', order: 50 });
  cms.route(/^\/termine$/, async (el) => setHtml(el, html`<h1>Termine</h1>`));
  cms.widget({ id: 'termine', size: 'tile', render: (el, data) => setHtml(el, html`…`) });
  cms.settingsTab({ id: 'termine', label: 'Termine', render: (el) => { /* … */ } });
  const pick = cms.use('mediaPicker'); // Dienste anderer Module
}
```

Gemeinsame Hilfen: `/admin/js/api.js` (REST-Aufrufe), `/admin/js/ui.js` (sicheres `html`-Templating, Dialoge,
Toasts, Formatierung), `/admin/js/editor.js` (WYSIWYG), `/admin/js/content-ui.js` (Titelbild, SEO, Revisionen,
Vorschau), `/admin/js/settings.js` (`saveSettings`).

## Themes

Ein Theme ist ein Ordner mit `index.js` (Default-Export mit `layout(view)`) und `assets/` (unter `/theme/`).
`view` enthält `site` (Name, Slogan, Logo, Akzentfarbe, Anschrift …), `title`, `fullTitle`, `description`,
`canonical`, `image`, `content` (fertiges HTML), `menus.main`/`menus.footer`, `widgets.top`/`widgets.footer`,
`head`, `bodyClass`, `isHome`, `currentPath` und `escape()`.

Module verwenden diese CSS-Klassen, die ein Theme gestalten sollte: `.prose`, `.panel`, `.hero`, `.lead`,
`.breadcrumbs`, `.meta`, `.tag`, `.cover`, `.post-list`, `.post-card`, `.child-pages`, `.pagination`,
`.search-form`, `.search-results`, `.newsletter-box`, `.newsletter-inline`, `.narrow`, `.page-full`.

## REST-API

Alle Endpunkte unter `/api` (außer Anmeldung und `/api/public/*`) erwarten `Authorization: Bearer <token>` –
ein Sitzungstoken aus `POST /api/auth/login` oder einen API-Schlüssel (`nlk_…`, auch als `X-API-Key`).
API-Schlüssel haben Redakteursrechte. Die Admin-Oberfläche nutzt stattdessen ein httpOnly-Sitzungscookie; schreibende
Anfragen mit Cookie brauchen zusätzlich den Header `X-Requested-With` (CSRF-Schutz). Fehler: `{"error": "…", "details": {…}}`.

| Bereich | Endpunkte |
|---|---|
| Anmeldung | `GET /api/auth/status` · `POST /api/auth/setup` · `POST /api/auth/login` (bei 2FA: `{ two_factor, challenge }`, dann `POST /api/auth/login/2fa`) · `POST /api/auth/logout` · `GET/PUT /api/auth/me` · `POST /api/auth/forgot` · `POST /api/auth/reset` · `POST /api/auth/2fa/setup\|enable\|disable` |
| System | `GET /api/system/modules` · `PUT /api/system/modules/:name` *(Admin)* · `GET /api/system/shortcodes` · `GET /api/system/dashboard` · `GET /api/system/audit` · `GET/POST /api/system/backups` · `GET /api/system/backup` · `GET/DELETE /api/system/backups/:name` · `POST /api/system/search/rebuild` · `GET/DELETE /api/system/cache` *(alle Admin)* |
| Einstellungen | `GET /api/settings` · `PUT /api/settings` *(Admin)* · `POST /api/settings/test-email` *(Admin)* |
| Benutzer & Schlüssel | `GET/POST/PUT/DELETE /api/users…` (`invite: true` verschickt einen Einladungslink) · `POST /api/users/:id/reset-2fa` · `POST /api/users/:id/send-reset` · `GET/POST/DELETE /api/api-keys…` *(Admin)* |
| Seiten | `GET/POST /api/pages` · `GET/PUT/DELETE /api/pages/:id` · `POST /api/pages/preview` · `POST /api/pages/:id/translate` (`{ lang }`) · `POST /api/pages/:id/submit` · `POST /api/pages/:id/decline` (`{ note }`) · `GET /api/pages/:id/revisions/:rid` · `POST …/restore` |
| Blog | `GET/POST /api/posts` (`q`, `status=draft\|published\|scheduled\|review`, `category_id`, `lang`, `author_id`) · `GET/PUT/DELETE /api/posts/:id` · `POST /api/posts/preview` · Übersetzen, Einreichen und Revisionen wie bei Seiten · `GET/POST/PUT/DELETE /api/categories…` |
| Medien | `GET /api/media` (`q`, `type=image\|document`) · `POST /api/media` (Rohdaten, Header `X-Filename`) · `GET/PUT/DELETE /api/media/:id` · `POST /api/media/optimize` |
| Menüs | `GET /api/menus` · `PUT /api/menus/:location` (`main`, `footer`, je Sprache `main:en` …; `{ items: [...] }`) |
| Formulare | `GET/POST/PUT/DELETE /api/forms…` · `GET /api/forms/:id/submissions` · `GET /api/forms/:id/export` · öffentlich: `POST /formular/:id` |
| Weiterleitungen | `GET/POST/PUT/DELETE /api/redirects…` · `GET/DELETE /api/redirects/misses` |
| Statistik | `GET /api/analytics?days=30` |
| Newsletter | `/api/subscribers…` (inkl. `import`, `export`, `bulk`) · `/api/lists…` · `/api/segments…` (inkl. `preview`, `fields`) · `/api/templates…` · `/api/campaigns…` (inkl. `audience`, `test`, `send`, `schedule`, `pause`, `resume`, `cancel`, `ab-winner`, `report`, `recipients`) · `/api/automations…` · `POST /api/campaigns/from-post/:postId` · `GET /api/stats/overview` · `GET /api/newsletter/bounce-urls` · `POST /api/webhooks/bounce` · öffentlich: `POST /api/public/subscribe` (Pflichtfeld `consent: true`, optional `tracking_consent`), `GET /api/public/lists`, `POST /api/public/bounces/:provider/:secret` |

**Öffentliche Website** (weitere Sprachen mit Präfix, z. B. `/en/…`): `/` (Startseite), `/<seitenpfad>`, `/blog`, `/blog/<slug>`, `/blog/kategorie/<slug>`,
`/blog/feed.xml`, `/suche`, `/sitemap.xml`, `/robots.txt`, `/uploads/…`, `/subscribe`, `/confirm/:token`,
`/unsubscribe/:token`, `/preferences/:token`, `/archive`, `/view/:token`, `/health`.

## Sicherheit

- Inhalte von Seiten und Beiträgen werden serverseitig bereinigt (keine Skripte, Event-Handler oder `javascript:`-Links;
  iframes nur von YouTube/Vimeo). Zusätzlich verbietet die Content-Security-Policy Inline-Skripte.
- Uploads werden anhand ihrer Dateisignatur geprüft (kein SVG/HTML) und mit `nosniff` und Sandbox-CSP ausgeliefert.
- Passwörter mit scrypt, Sitzungen und API-Schlüssel nur gehasht gespeichert, Ratenbegrenzung für Anmeldung und Formulare.
- Seiten-Slugs können keine System- oder Modulpfade überdecken.
- Anmeldungen brauchen eine ausdrückliche Einwilligung; Bestätigungs-Mails gehen höchstens einmal pro Tag an dieselbe
  Adresse, und abgemeldete Adressen werden nur nach erneuter Bestätigung wieder aktiv. Die Bestätigung erfolgt per
  Knopf (POST), damit Link-Scanner in Mailprogrammen sie nicht auslösen.
- Datenauskunft und Löschung über die Einstellungsseite erfordern einen befristeten Link, der an die Adresse des
  Abonnenten geschickt wird – ein weitergeleiteter Newsletter reicht dafür nicht.
- Login-Sperre nach wiederholten Fehlversuchen pro IP und pro Konto; API-Schlüssel werden mit ihrem Benutzer gelöscht.
- Admin-Sitzung als httpOnly-Cookie (`SameSite=Strict`, `Secure` bei HTTPS) plus Pflicht-Header für schreibende
  Anfragen; optionale Zwei-Faktor-Anmeldung (TOTP, Schutz gegen Wiederverwendung von Codes, Wiederherstellungscodes).
- Passwort-Reset-Links sind 60 Minuten gültig, einmalig verwendbar und beenden alle Sitzungen; die Antwort verrät
  nicht, ob eine Adresse existiert.
- Änderungsprotokoll aller schreibenden Aktionen und Anmeldungen (365 Tage).
- Bounce-Webhooks nur über eine geheime, erneuerbare Adresse; SNS-Bestätigungen nur an AWS-Hosts.
- Besucherstatistik ohne Cookies und ohne Speicherung von IP-Adressen.

## Entwicklung

```bash
npm run dev    # Server mit automatischem Neustart
npm test       # Tests ausführen
```

## Produktivbetrieb

- `BASE_URL` auf die öffentliche HTTPS-Adresse setzen und hinter einem Reverse Proxy mit TLS betreiben (`TRUST_PROXY=true`).
  Den Port 3000 dann nicht öffentlich freigeben (z. B. in `docker-compose.yml` als `127.0.0.1:3000:3000`).
- Für die Absender-Domain SPF, DKIM und DMARC einrichten.
- Automatische Backups einschalten und Kopien zusätzlich außerhalb des Servers aufbewahren.
- Das System ist für **eine** Instanz ausgelegt (Versand-Worker und Ratenbegrenzung laufen im Prozess).

## Lizenz

GPL-3.0 – siehe [LICENSE](LICENSE).
