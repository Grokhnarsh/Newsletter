/**
 * Standard-Theme. Ein Theme exportiert `layout(view)` und liefert seine
 * statischen Dateien aus `assets/` (unter /theme/ erreichbar).
 * Alle Werte in `view` sind unescaped – außer `content`, `head` und `widgets`,
 * die bereits fertiges HTML enthalten. Mehrsprachig: `lang`, `languages`
 * (Sprachumschalter), `t(key)` für Texte des Themes, `homeUrl`, `searchUrl`.
 */

function languageSwitcher(v, e) {
  if (!v.languages?.length) return '';
  return `<nav class="lang-switch" aria-label="${e(v.t('language'))}"><ul>${v.languages
    .map(
      (l) =>
        `<li><a href="${e(l.url)}" hreflang="${e(l.code)}" lang="${e(l.code)}"${l.current ? ' aria-current="true"' : ''} title="${e(l.label)}">${e(l.code.toUpperCase())}</a></li>`,
    )
    .join('')}</ul></nav>`;
}

function menuHtml(items, e, currentPath, depth = 0) {
  if (!items?.length) return '';
  return `<ul${depth ? ' class="submenu"' : ''}>${items
    .map((item) => {
      const active = item.url === currentPath || (item.url !== '/' && currentPath.startsWith(`${item.url}/`));
      const attrs = `${active ? ' aria-current="page"' : ''}${item.new_tab ? ' target="_blank" rel="noopener noreferrer"' : ''}`;
      return `<li><a href="${e(item.url)}"${attrs}>${e(item.label)}</a>${menuHtml(item.children, e, currentPath, depth + 1)}</li>`;
    })
    .join('')}</ul>`;
}

export default {
  name: 'default',
  label: 'Standard',

  layout(v) {
    const e = v.escape;
    const accent = /^#[0-9a-f]{6}$/i.test(v.site.accent || '') ? v.site.accent : '#2a78d6';
    const brand = v.site.logo
      ? `<img src="${e(v.site.logo)}" alt="${e(v.site.name)}" class="logo">`
      : `<span class="brand-name">${e(v.site.name)}</span>`;
    const footerLinks = [
      ...(v.menus.footer || []),
      ...(v.site.imprintUrl ? [{ label: v.t('imprint'), url: v.site.imprintUrl }] : []),
      ...(v.site.privacyUrl ? [{ label: v.t('privacy'), url: v.site.privacyUrl }] : []),
    ];
    return `<!DOCTYPE html>
<html lang="${e(v.lang || 'de')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(v.fullTitle)}</title>
${v.description ? `<meta name="description" content="${e(v.description)}">` : ''}
${v.noindex ? '<meta name="robots" content="noindex">' : ''}
<link rel="canonical" href="${e(v.canonical)}">
<meta property="og:site_name" content="${e(v.site.name)}">
<meta property="og:title" content="${e(v.title || v.site.name)}">
<meta property="og:type" content="${e(v.type)}">
<meta property="og:url" content="${e(v.canonical)}">
${v.description ? `<meta property="og:description" content="${e(v.description)}">` : ''}
${v.image ? `<meta property="og:image" content="${e(v.image)}"><meta name="twitter:card" content="summary_large_image">` : ''}
<link rel="stylesheet" href="/theme/style.css">
<style>:root{--accent:${accent}}</style>
${v.head}
</head>
<body class="${e(v.bodyClass)}${v.isHome ? ' home' : ''}">
<a class="skip" href="#main">${e(v.t('skip'))}</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${e(v.homeUrl || '/')}">${brand}</a>
    ${
      v.menus.main?.length
        ? `<details class="nav-toggle"><summary aria-label="${e(v.t('menu'))}">${e(v.t('menu'))}</summary><nav class="main-nav" aria-label="${e(v.t('mainNav'))}">${menuHtml(v.menus.main, e, v.currentPath)}</nav></details>
    <nav class="main-nav desktop" aria-label="${e(v.t('mainNav'))}">${menuHtml(v.menus.main, e, v.currentPath)}</nav>`
        : ''
    }
    <form class="header-search" action="${e(v.searchUrl || '/suche')}" method="get" role="search"><input type="search" name="q" placeholder="${e(v.t('search'))}" aria-label="${e(v.t('searchLabel'))}"></form>
    ${languageSwitcher(v, e)}
  </div>
</header>
${v.widgets.top ? `<div class="top-widgets">${v.widgets.top}</div>` : ''}
<main id="main" class="wrap main">
${v.content}
</main>
<footer class="site-footer">
  <div class="wrap footer-grid">
    <div>
      <div class="footer-brand">${e(v.site.name)}</div>
      ${v.site.tagline ? `<p>${e(v.site.tagline)}</p>` : ''}
      ${v.site.companyAddress ? `<address>${e(v.site.companyAddress).replace(/\n/g, '<br>')}</address>` : ''}
    </div>
    ${v.widgets.footer ? `<div class="widgets">${v.widgets.footer}</div>` : ''}
  </div>
  <div class="wrap footer-bottom">
    <span>© ${v.site.year} ${e(v.site.name)}${v.site.footerText ? ` · ${e(v.site.footerText)}` : ''}</span>
    ${footerLinks.length ? `<nav aria-label="${e(v.t('footerNav'))}">${menuHtml(footerLinks, e, v.currentPath)}</nav>` : ''}
  </div>
</footer>
</body>
</html>`;
  },
};
