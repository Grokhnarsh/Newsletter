# Modulares CMS

Selbst gehostetes, modulares Content-Management-System mit Website, Blog, Medienbibliothek, Menüs und
integriertem Newslettersystem. Läuft mit **Node.js ≥ 22.13** und der eingebauten SQLite-Datenbank
(`node:sqlite`) – keine externe Datenbank, kein Build-Schritt.

Jede Funktion steckt in einem **Modul**, das sich in der Admin-Oberfläche ein- und ausschalten lässt.
Eigene Module legst du einfach im Ordner `modules/` ab.

## Module im Überblick

| Modul | Funktionen |
|---|---|
| **Seiten** (`pages`) | Hierarchische Seiten mit schönen URLs (`/leistungen/webdesign`), Brotkrumen, Vorlagen (Standard, volle Breite, Landingpage), SEO-Felder, Titelbild, Revisionen mit Wiederherstellen, frei wählbare Startseite, Baustein `[child_pages]` |
| **Blog** (`blog`) | Beiträge mit Kategorien, Teaser, Titelbild, geplanter Veröffentlichung, RSS-Feed (`/blog/feed.xml`), Kategorie-Seiten, Paginierung, Revisionen, Baustein `[recent_posts]`, „Als Newsletter versenden“ |
| **Medien** (`media`) | Medienbibliothek mit Drag-&-Drop-Upload, Typprüfung anhand der Dateisignatur (JPG, PNG, GIF, WebP, PDF, MP4, MP3), Bildmaße, Alternativtexte, Auswahldialog für Editor und Titelbilder |
| **Menüs** (`menus`) | Haupt- und Fußzeilenmenü mit Untermenüs; Einträge verlinken Seiten, Blog, Startseite oder eigene URLs. Entwürfe und gelöschte Seiten werden automatisch ausgeblendet |
| **Newsletter** (`newsletter`) | Abonnenten, Listen, Double-Opt-in, CSV-Import/-Export, Kampagnen mit Vorlagen und Platzhaltern, Testversand, Planung, Versand-Worker mit Ratenbegrenzung, Öffnungs- und Klick-Tracking, Berichte, Archiv, DSGVO-Präferenzseite, One-Click-Abmeldung, Bounce-Webhook, Anmelde-Widget und Baustein `[newsletter_form]` |

**Kern** (immer aktiv): Benutzer mit Rollen (Administrator/Redakteur), API-Schlüssel, Einstellungen,
Theme-System, Shortcodes/Bausteine, Website-Suche (`/suche`), `sitemap.xml`, `robots.txt`, Open-Graph-Tags,
HTML-Bereinigung aller Inhalte, Dashboard mit Kennzahlen aller Module.

**Admin-Oberfläche**: WYSIWYG-Editor (Formatierung, Links, Bilder aus der Medienbibliothek, YouTube/Vimeo,
Tabellen, Bausteine, HTML-Quelltext, bereinigtes Einfügen aus Word), Vorschau im Website-Design,
Hell-/Dunkelmodus, mobil nutzbar.

## Schnellstart

```bash
npm install
npm start
```

Dann <http://localhost:3000/admin/> öffnen und das erste Administratorkonto anlegen. Bei der Einrichtung
werden Startinhalte erzeugt: eine Startseite, „Über uns“, Entwürfe für Impressum und Datenschutz, ein erster
Blogbeitrag, Menüs, eine Newsletter-Liste und eine E-Mail-Vorlage.
Die Website ist unter <http://localhost:3000/> erreichbar.

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

Datenbank, Uploads und Outbox liegen im Volume `newsletter-data` (`/data`).

## Konfiguration

| Variable | Standard | Beschreibung |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | Öffentliche URL (Links in E-Mails, Sitemap, RSS, kanonische URLs) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Server-Adresse |
| `DATABASE_PATH` | `./data/newsletter.db` | SQLite-Datei |
| `UPLOADS_DIR` | `./data/uploads` | Ablage der Medienbibliothek (öffentlich unter `/uploads/`) |
| `MODULES_DIR` | `./modules` | Ordner mit eigenen Modulen |
| `THEME` | `default` | Theme-Ordner in `themes/` oder `src/themes/` |
| `TRUST_PROXY` | `false` | Hinter Reverse Proxy auf `true` setzen |
| `MAIL_TRANSPORT` | `smtp` falls SMTP gesetzt, sonst `file` | `smtp`, `file` oder `log` |
| `SMTP_URL` bzw. `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | – | SMTP-Zugang |
| `MAIL_OUTBOX_DIR` | `./data/outbox` | Zielordner für `MAIL_TRANSPORT=file` |
| `WORKER_ENABLED`, `WORKER_INTERVAL_MS`, `MAIL_MAX_ATTEMPTS` | `true`, `5000`, `3` | Newsletter-Versand-Worker |
| `SESSION_TTL_HOURS` | `168` | Gültigkeit einer Admin-Sitzung |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | Legt beim ersten Start automatisch einen Administrator an |

Alles Weitere (Website-Name, Startseite, Farben, Logo, Absender, Versandrate, Texte …) wird in der
Admin-Oberfläche unter *Einstellungen* gepflegt.

## Bausteine (Shortcodes)

In Seiten und Beiträgen über das Baustein-Menü des Editors einfügbar:

| Baustein | Modul | Ausgabe |
|---|---|---|
| `[recent_posts limit="3" category="neuigkeiten"]` | Blog | Neueste Beiträge als Karten |
| `[child_pages]` / `[child_pages id="5"]` | Seiten | Liste der Unterseiten |
| `[newsletter_form title="Bleib informiert"]` | Newsletter | Anmeldeformular |

Bausteine deaktivierter Module verschwinden automatisch aus der Ausgabe.

## Architektur

```
src/
  server.js            Einstiegspunkt
  app.js               Baut Kern, Module und Express-App zusammen (createCms)
  core/                Modulverwaltung, Hooks, Einstellungen, Benutzer, Website/Theme, Inhalte & Bausteine
  modules/             Mitgelieferte Module (pages, blog, media, menus, newsletter)
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
API-Schlüssel haben Redakteursrechte. Fehler: `{"error": "…", "details": {…}}`.

| Bereich | Endpunkte |
|---|---|
| Anmeldung | `GET /api/auth/status` · `POST /api/auth/setup` · `POST /api/auth/login` · `POST /api/auth/logout` · `GET/PUT /api/auth/me` |
| System | `GET /api/system/modules` · `PUT /api/system/modules/:name` *(Admin)* · `GET /api/system/shortcodes` · `GET /api/system/dashboard` |
| Einstellungen | `GET /api/settings` · `PUT /api/settings` *(Admin)* · `POST /api/settings/test-email` *(Admin)* |
| Benutzer & Schlüssel | `GET/POST/PUT/DELETE /api/users…` · `GET/POST/DELETE /api/api-keys…` *(Admin)* |
| Seiten | `GET/POST /api/pages` · `GET/PUT/DELETE /api/pages/:id` · `POST /api/pages/preview` · `GET /api/pages/:id/revisions/:rid` · `POST …/restore` |
| Blog | `GET/POST /api/posts` (`q`, `status=draft\|published\|scheduled`, `category_id`) · `GET/PUT/DELETE /api/posts/:id` · `POST /api/posts/preview` · Revisionen wie bei Seiten · `GET/POST/PUT/DELETE /api/categories…` |
| Medien | `GET /api/media` (`q`, `type=image\|document`) · `POST /api/media` (Rohdaten, Header `X-Filename`) · `GET/PUT/DELETE /api/media/:id` |
| Menüs | `GET /api/menus` · `PUT /api/menus/:location` (`{ items: [...] }`) |
| Newsletter | `/api/subscribers…` (inkl. `import`, `export`, `bulk`) · `/api/lists…` · `/api/templates…` · `/api/campaigns…` (inkl. `test`, `send`, `schedule`, `pause`, `resume`, `cancel`, `report`, `recipients`) · `POST /api/campaigns/from-post/:postId` · `GET /api/stats/overview` · `POST /api/webhooks/bounce` · öffentlich: `POST /api/public/subscribe`, `GET /api/public/lists` |

**Öffentliche Website**: `/` (Startseite), `/<seitenpfad>`, `/blog`, `/blog/<slug>`, `/blog/kategorie/<slug>`,
`/blog/feed.xml`, `/suche`, `/sitemap.xml`, `/robots.txt`, `/uploads/…`, `/subscribe`, `/confirm/:token`,
`/unsubscribe/:token`, `/preferences/:token`, `/archive`, `/view/:token`, `/health`.

## Sicherheit

- Inhalte von Seiten und Beiträgen werden serverseitig bereinigt (keine Skripte, Event-Handler oder `javascript:`-Links;
  iframes nur von YouTube/Vimeo). Zusätzlich verbietet die Content-Security-Policy Inline-Skripte.
- Uploads werden anhand ihrer Dateisignatur geprüft (kein SVG/HTML) und mit `nosniff` und Sandbox-CSP ausgeliefert.
- Passwörter mit scrypt, Sitzungen und API-Schlüssel nur gehasht gespeichert, Ratenbegrenzung für Anmeldung und Formulare.
- Seiten-Slugs können keine System- oder Modulpfade überdecken.

## Entwicklung

```bash
npm run dev    # Server mit automatischem Neustart
npm test       # Tests ausführen
```

## Produktivbetrieb

- `BASE_URL` auf die öffentliche HTTPS-Adresse setzen und hinter einem Reverse Proxy mit TLS betreiben (`TRUST_PROXY=true`).
- Für die Absender-Domain SPF, DKIM und DMARC einrichten.
- `data/` (Datenbank und Uploads) regelmäßig sichern.
- Das System ist für **eine** Instanz ausgelegt (Versand-Worker und Ratenbegrenzung laufen im Prozess).

## Lizenz

GPL-3.0 – siehe [LICENSE](LICENSE).
