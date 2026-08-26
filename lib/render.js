// render.js — tiny server-side HTML templating (template literals, no JSX/bundler needed).

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NAV_ITEMS = [
  { tab: 'home', href: '/', icon: '🏠', label: 'Home' },
  { tab: 'strains', href: '/strains', icon: '/docs/leaf-kudos.png', label: 'Strains' },
  { tab: 'recipes', href: '/recipes', icon: '🍯', label: 'Recipes' },
  { tab: 'growing', href: '/growing', icon: '🌱', label: 'Growing' },
  { tab: 'friends', href: '/friends', icon: '🧑\u200d🤝\u200d🧑', label: 'Friends' },
  { tab: 'more', href: '/more', icon: '⭐', label: 'More' },
];
// Icons starting with "/" are real image files (self-hosted artwork); anything
// else is treated as a plain emoji/text glyph, same as before.
function navIcon(icon) {
  return icon.startsWith('/')
    ? `<img src="${icon}" alt="" class="ic-img">`
    : icon;
}

function layout({ title = 'StrainDex', active = '', body = '', isAdmin = false, unreadMessages = 0, showBack = true }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(title)} — StrainDex</title>
<link rel="stylesheet" href="/app.css">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#123a24">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
</head>
<body>
<div class="app">
  <header class="topbar">
    <a class="brand" href="/"><img src="/icons/icon-192.png" alt="" class="brand-logo">StrainDex</a>
    ${isAdmin ? `<a href="/admin" style="color:#fff;font-size:12px;opacity:.85;text-decoration:none;">⚙️ Admin</a>` : ''}
  </header>
  <div class="disclaimer">Beta · For adults 21+ where legal · Not medical advice · <a href="/feedback" style="color:inherit;">Send feedback</a></div>
  <main>
    ${showBack ? `<button type="button" class="back-btn" onclick="history.back()">← Back</button>` : ''}
    ${body}
  </main>
  <nav class="tabbar">
    ${NAV_ITEMS.map(n => `<a class="${active === n.tab ? 'active' : ''}" href="${n.href}" style="position:relative;"><span class="ic">${navIcon(n.icon)}</span>${n.label}${n.tab === 'friends' && unreadMessages > 0 ? `<span class="nav-badge">${unreadMessages > 9 ? '9+' : unreadMessages}</span>` : ''}</a>`).join('')}
  </nav>
  <div id="toast"></div>
  <script src="/app.js"></script>
</div>
</body>
</html>`;
}

module.exports = { layout, esc, NAV_ITEMS };
