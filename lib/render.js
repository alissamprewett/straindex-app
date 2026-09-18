// render.js — tiny server-side HTML templating (template literals, no JSX/bundler needed).

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NAV_ITEMS = [
  { tab: 'home', href: '/', icon: '🏠', label: 'Home' },
  { tab: 'strains', href: '/strains', icon: '🌿', label: 'Strains' },
  { tab: 'recipes', href: '/recipes', icon: '🍯', label: 'Recipes' },
  { tab: 'growing', href: '/growing', icon: '🌱', label: 'Growing' },
  { tab: 'friends', href: '/friends', icon: '🧑\u200d🤝\u200d🧑', label: 'Friends' },
  { tab: 'more', href: '/more', icon: '⭐', label: 'More' },
];
// Optional og* params default to sensible, generic values when omitted, so
// every existing call site keeps rendering exactly as before -- only a page
// that explicitly wants a rich link preview (currently just the public
// shared-check-in page) needs to pass them. ogUrl/ogImage must be absolute
// (the caller builds these from req.headers.host, since layout() itself has
// no access to the request) -- Open Graph consumers ignore relative URLs.
function layout({ title = 'StrainDex', active = '', body = '', isAdmin = false, unreadMessages = 0, showBack = true, ogTitle = null, ogDescription = null, ogImage = null, ogUrl = null }) {
  const metaTitle = ogTitle || `${title} — StrainDex`;
  const metaDescription = ogDescription || 'Track what you actually experience, discover your next favorite strain, and compare notes with real friends.';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<script>
  // Applies a saved manual light/dark choice (see Account Settings >
  // Appearance) before the stylesheet below is even requested, so someone
  // who picked "Dark" never sees a flash of the light theme first while
  // the CSS loads. No attribute at all here (the try block finds nothing,
  // or the person picked "System") just falls through to the
  // prefers-color-scheme media query in app.css, unchanged from before
  // this existed. Wrapped in try/catch since localStorage can throw in
  // some private-browsing/locked-down contexts -- worst case here is
  // just falling back to the system setting, never a broken page.
  (function () {
    try {
      var t = localStorage.getItem('theme');
      if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    } catch (e) {}
  })();
</script>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(title)} — StrainDex</title>
<meta name="description" content="${esc(metaDescription)}">
<meta property="og:title" content="${esc(metaTitle)}">
<meta property="og:description" content="${esc(metaDescription)}">
<meta property="og:type" content="website">
${ogUrl ? `<meta property="og:url" content="${esc(ogUrl)}">` : ''}
<meta property="og:image" content="${esc(ogImage || 'https://www.strain-dex.com/icons/icon-512.png')}">
<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
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
  <div class="disclaimer">For adults 21+ where legal · Not medical advice · <a href="/feedback" style="color:inherit;">Send feedback</a></div>
  <main>
    ${showBack ? `<button type="button" class="back-btn" onclick="history.back()">← Back</button>` : ''}
    ${body}
  </main>
  <nav class="tabbar">
    ${NAV_ITEMS.map(n => `<a class="${active === n.tab ? 'active' : ''}" href="${n.href}" style="position:relative;"><span class="ic">${n.icon}</span>${n.label}${n.tab === 'friends' && unreadMessages > 0 ? `<span class="nav-badge">${unreadMessages > 9 ? '9+' : unreadMessages}</span>` : ''}</a>`).join('')}
  </nav>
  <div id="toast"></div>
  <script src="/app.js"></script>
</div>
</body>
</html>`;
}

module.exports = { layout, esc, NAV_ITEMS };
