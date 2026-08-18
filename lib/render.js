// render.js — tiny server-side HTML templating (template literals, no JSX/bundler needed).

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NAV_ITEMS = [
  { tab: 'home', href: '/', icon: '🏠', label: 'Home' },
  { tab: 'strains', href: '/strains', icon: '🃏', label: 'Strains' },
  { tab: 'recipes', href: '/recipes', icon: '🍯', label: 'Recipes' },
  { tab: 'growing', href: '/growing', icon: '🌱', label: 'Growing' },
  { tab: 'faq', href: '/faq', icon: '❓', label: 'FAQ' },
  { tab: 'chat', href: '/chat', icon: '💬', label: 'Ask' },
  { tab: 'more', href: '/more', icon: '⭐', label: 'More' },
];

function layout({ title = 'StrainDex', active = '', body = '', isAdmin = false }) {
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
    <a class="brand" href="/">🌿 StrainDex</a>
    <a href="${isAdmin ? '/admin' : '/admin/login'}" style="color:#fff;font-size:12px;opacity:.85;text-decoration:none;">${isAdmin ? '⚙️ Admin' : 'Admin'}</a>
  </header>
  <div class="disclaimer">Concept build · For adults 21+ where legal · Not medical advice</div>
  <main>
    ${body}
  </main>
  <nav class="tabbar">
    ${NAV_ITEMS.map(n => `<a class="${active === n.tab ? 'active' : ''}" href="${n.href}"><span class="ic">${n.icon}</span>${n.label}</a>`).join('')}
  </nav>
  <div id="toast"></div>
  <script src="/app.js"></script>
</div>
</body>
</html>`;
}

module.exports = { layout, esc, NAV_ITEMS };
