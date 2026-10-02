import { escapeHtml } from './render.js';

const STYLE = `
:root{--bg:#f5f6f8;--card:#fff;--text:#1d2433;--muted:#5b6475;--border:#dfe3ea;--accent:#2457d6;--accent-text:#fff;--danger:#c0392b;--ok:#1e7d4f}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--text:#e7eaf0;--muted:#9aa3b2;--border:#2c3340;--accent:#5b8cff;--accent-text:#0d1117;--danger:#ff7b6b;--ok:#4cc38a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:48px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:1.45rem;margin:0 0 12px}
.site{color:var(--muted);font-size:.9rem;margin-bottom:12px;text-align:center}
p{margin:0 0 14px}
label{display:block;font-weight:600;font-size:.9rem;margin:14px 0 6px}
input[type=email],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin:8px 0}
.check input{margin-top:5px}
.row{display:flex;gap:12px}.row>div{flex:1}
button,.btn{display:inline-block;margin-top:18px;padding:11px 18px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.secondary{background:transparent;color:var(--danger);border:1px solid var(--border)}
.muted{color:var(--muted);font-size:.875rem}
.ok{color:var(--ok)}.err{color:var(--danger)}
.hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
hr{border:0;border-top:1px solid var(--border);margin:24px 0}
ul.archive{list-style:none;padding:0;margin:0}ul.archive li{padding:12px 0;border-bottom:1px solid var(--border)}
ul.archive a{color:var(--accent);font-weight:600;text-decoration:none}
a{color:var(--accent)}
`;

export function page({ title, siteName, body }) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} – ${escapeHtml(siteName)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="site">${escapeHtml(siteName)}</div>
<div class="card">
${body}
</div>
</main>
</body>
</html>`;
}

export function messagePage({ title, message, siteName, tone = '' }) {
  return page({
    title,
    siteName,
    body: `<h1 class="${tone}">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
  });
}
