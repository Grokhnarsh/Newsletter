// Mehrsprachigkeit: Sprachen der Website, URL-Präfixe (/en/…) und Texte des Themes.

export const LANGUAGE_NAMES = {
  de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', nl: 'Nederlands', pl: 'Polski', pt: 'Português',
  da: 'Dansk', sv: 'Svenska', nb: 'Norsk', fi: 'Suomi', cs: 'Čeština', tr: 'Türkçe', el: 'Ελληνικά', ru: 'Русский', uk: 'Українська',
};

export const I18N_SETTINGS = {
  defaults: { site_languages: 'de' },
  rules: {
    // Kommagetrennte Sprachkürzel (ISO 639-1); das erste ist die Standardsprache ohne URL-Präfix
    site_languages: { type: 'string', max: 100, pattern: /^\s*[a-z]{2}(\s*,\s*[a-z]{2})*\s*$/, patternMessage: 'Sprachkürzel mit Komma getrennt, z. B. „de, en“' },
  },
};

// Texte des Themes und der Kernseiten; fehlende Sprachen fallen auf Englisch zurück
const STRINGS = {
  de: {
    skip: 'Zum Inhalt springen', menu: 'Menü', mainNav: 'Hauptmenü', footerNav: 'Fußzeile', search: 'Suchen …', searchLabel: 'Website durchsuchen',
    imprint: 'Impressum', privacy: 'Datenschutz', language: 'Sprache', notFound: 'Seite nicht gefunden', notFoundText: 'Die angeforderte Seite existiert nicht (mehr).',
    toHome: 'Zur Startseite', searchTitle: 'Suche', searchButton: 'Suchen', results: 'Treffer', noResults: 'Keine Treffer gefunden.', minChars: 'Bitte mindestens zwei Zeichen eingeben.',
    readMore: 'Weiterlesen', noPosts: 'Noch keine Beiträge veröffentlicht.', page: 'Seite', newer: '‹ Neuere', older: 'Ältere ›', home: 'Start',
  },
  en: {
    skip: 'Skip to content', menu: 'Menu', mainNav: 'Main navigation', footerNav: 'Footer', search: 'Search …', searchLabel: 'Search this site',
    imprint: 'Imprint', privacy: 'Privacy', language: 'Language', notFound: 'Page not found', notFoundText: 'The requested page does not exist (anymore).',
    toHome: 'Go to homepage', searchTitle: 'Search', searchButton: 'Search', results: 'results', noResults: 'Nothing found.', minChars: 'Please enter at least two characters.',
    readMore: 'Read more', noPosts: 'No posts published yet.', page: 'Page', newer: '‹ Newer', older: 'Older ›', home: 'Home',
  },
  fr: {
    skip: 'Aller au contenu', menu: 'Menu', mainNav: 'Navigation principale', footerNav: 'Pied de page', search: 'Rechercher …', searchLabel: 'Rechercher sur le site',
    imprint: 'Mentions légales', privacy: 'Confidentialité', language: 'Langue', notFound: 'Page introuvable', notFoundText: "La page demandée n'existe pas (ou plus).",
    toHome: "Retour à l'accueil", searchTitle: 'Recherche', searchButton: 'Rechercher', results: 'résultats', noResults: 'Aucun résultat.', minChars: 'Veuillez saisir au moins deux caractères.',
    readMore: 'Lire la suite', noPosts: 'Aucun article publié.', page: 'Page', newer: '‹ Plus récents', older: 'Plus anciens ›', home: 'Accueil',
  },
  es: {
    skip: 'Ir al contenido', menu: 'Menú', mainNav: 'Navegación principal', footerNav: 'Pie de página', search: 'Buscar …', searchLabel: 'Buscar en el sitio',
    imprint: 'Aviso legal', privacy: 'Privacidad', language: 'Idioma', notFound: 'Página no encontrada', notFoundText: 'La página solicitada no existe.',
    toHome: 'Ir al inicio', searchTitle: 'Búsqueda', searchButton: 'Buscar', results: 'resultados', noResults: 'Sin resultados.', minChars: 'Introduce al menos dos caracteres.',
    readMore: 'Leer más', noPosts: 'Aún no hay entradas.', page: 'Página', newer: '‹ Más recientes', older: 'Más antiguas ›', home: 'Inicio',
  },
};

export class I18n {
  constructor(settings) {
    this.settings = settings;
  }

  /** Konfigurierte Sprachen, erste = Standard. */
  languages() {
    const list = String(this.settings.get('site_languages') || 'de')
      .split(',')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => /^[a-z]{2}$/.test(l));
    return [...new Set(list.length ? list : ['de'])];
  }

  defaultLang() {
    return this.languages()[0];
  }

  isMulti() {
    return this.languages().length > 1;
  }

  /** Sprache eines Inhalts (NULL/leer = Standardsprache). */
  langOf(item) {
    return item?.lang && this.languages().includes(item.lang) ? item.lang : this.defaultLang();
  }

  /** Für die Speicherung: Standardsprache wird als NULL abgelegt. */
  storedLang(lang) {
    if (!lang || lang === this.defaultLang()) return null;
    return lang;
  }

  prefix(lang) {
    return !lang || lang === this.defaultLang() ? '' : `/${lang}`;
  }

  /** Pfad in einer Sprache, z. B. ('/blog', 'en') → '/en/blog'. */
  path(p, lang) {
    const prefix = this.prefix(lang);
    if (!prefix) return p;
    return p === '/' ? prefix : `${prefix}${p}`;
  }

  /** SQL-Bedingung für „Inhalt in Sprache X“ (Standardsprache inkl. NULL). */
  where(lang, column = 'lang') {
    if (!lang || lang === this.defaultLang()) return { sql: `(${column} IS NULL OR ${column} = ?)`, params: [this.defaultLang()] };
    return { sql: `${column} = ?`, params: [lang] };
  }

  /** Sprache einer öffentlichen Adresse anhand ihres Präfixes. */
  langOfPath(url) {
    const m = String(url).match(/^\/([a-z]{2})(?=\/|$|\?)/);
    return m && this.languages().slice(1).includes(m[1]) ? m[1] : this.defaultLang();
  }

  label(lang) {
    return LANGUAGE_NAMES[lang] || lang.toUpperCase();
  }

  t(lang, key) {
    return STRINGS[lang]?.[key] ?? STRINGS[lang === 'de' ? 'de' : 'en']?.[key] ?? STRINGS.de[key] ?? key;
  }

  /** Erkennt das Sprachpräfix, merkt es in req.lang und entfernt es aus der URL. */
  middleware() {
    return (req, res, next) => {
      req.lang = this.defaultLang();
      const m = req.path.match(/^\/([a-z]{2})(?=\/|$)/);
      if (m && m[1] !== req.lang && this.languages().includes(m[1])) {
        req.lang = m[1];
        req.url = req.url.slice(3) || '/';
        if (!req.url.startsWith('/')) req.url = `/${req.url}`;
      }
      next();
    };
  }
}
