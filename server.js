// server.js — the whole app. Plain Node `http`, no framework, no build step.
// Run: node server.js   (or PORT=4000 node server.js)
//
// Why no Express/Next.js here: this project was built in a sandboxed
// environment with no access to the npm registry, so everything below uses
// only Node's built-ins. It's a deliberate, testable-today choice — but
// nothing about the *architecture* (routes, db.js data layer, server-rendered
// HTML) requires staying dependency-free once you deploy somewhere with
// normal internet access. See README.md for the upgrade path.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { layout, esc } = require('./lib/render');
const { parseForm, parseJson } = require('./lib/body');
const { answerFromKnowledgeBase } = require('./lib/chat');
const mock = require('./lib/mockdata');
const geo = require('./lib/geodispensaries');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOCS_DIR = path.join(__dirname, 'docs');

const MIME = {
  '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

// ---------------------------------------------------------------- helpers

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}
function notFound(res) {
  sendHtml(res, layout({ title: 'Not found', body: `<h2 class="screen-title">Page not found</h2><p><a href="/">Go home</a></p>` }), 404);
}
function requireAdmin(req, res) {
  if (!auth.isAdmin(req)) { redirect(res, '/admin/login'); return false; }
  return true;
}
// Returns the logged-in user's id, or redirects to /login and returns null.
function requireUser(req, res) {
  const id = auth.currentUserId(req);
  if (id == null) { redirect(res, '/login'); return null; }
  return id;
}
const MIN_AGE = 21;
function isOldEnough(birthDateStr) {
  const dob = new Date(birthDateStr);
  if (isNaN(dob.getTime())) return false;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const hadBirthdayThisYear = (now.getMonth() > dob.getMonth()) || (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
  if (!hadBirthdayThisYear) age -= 1;
  return age >= MIN_AGE;
}
function starString(n) { n = Number(n) || 0; return '★'.repeat(n) + '☆'.repeat(5 - n); }
function rarityLabel(r) { return { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary' }[r] || r; }

// Real cannabis bud photos, all free-for-commercial-use / no-attribution-required
// under the Unsplash License (https://unsplash.com/license). These are generic
// stock photos, not photos of the specific named strain — getting a genuine,
// licensed photo of every individual strain isn't something free stock photography
// can offer, so instead we pick a real photo deterministically per strain (same
// strain always shows the same photo) and shift the color for grape/purple-named
// strains using a CSS filter, so the library has real photographic variety
// instead of one single repeated stock photo everywhere.
const STRAIN_PHOTOS = [
  '/docs/spencer-gray-N9w237MCZxU-unsplash.jpg',
  '/docs/ndispensable-7-VhhCfFtzk-unsplash.jpg',
  '/docs/hakuna-matata-oYgXPGZui98-unsplash.jpg',
  '/docs/crystalweed-cannabis-papBPuF484I-unsplash.jpg',
  '/docs/ndispensable-zwc6BD4_RDE-unsplash.jpg',
  '/docs/rexmedlen-flower-2677505_640.jpg',
  '/docs/gjbmiller-weed-2174302_640.jpg',
];
function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
  return Math.abs(h);
}
function strainPhotoUrl(strain) {
  return STRAIN_PHOTOS[hashStr(strain.id || strain.name || '') % STRAIN_PHOTOS.length];
}
function strainPhotoStyle(strain) {
  // A purple/violet color shift for grape- or purple-associated strains, so
  // real color variety exists without needing a separately licensed photo.
  return /purple|grape|grap|violet|urkle/i.test(strain.name || '')
    ? 'filter:hue-rotate(220deg) saturate(1.4);'
    : '';
}
// sizeClass controls the CSS box size; see .strain-thumb-* rules in app.css.
function strainPhotoTag(strain, sizeClass = 'md') {
  if (!strain) return `<div class="strain-thumb strain-thumb-${sizeClass}" style="display:flex;align-items:center;justify-content:center;font-size:20px;">🌿</div>`;
  return `<img class="strain-thumb strain-thumb-${sizeClass}" src="${strainPhotoUrl(strain)}" style="${strainPhotoStyle(strain)}" alt="${esc(strain.name)} bud" loading="lazy" onerror="this.onerror=null;this.replaceWith(Object.assign(document.createElement('div'),{className:this.className,textContent:'🌿',style:'display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;'}))">`;
}

// Terpene-overlap recommendations, ported from the prototype: score every
// unowned strain by how much its terpene profile echoes what you already
// own. With no check-ins yet, fall back to surfacing rare/legendary strains
// so the carousel isn't empty on a fresh install.
function getRecommendations(userId, limit = 4) {
  const owned = db.getCollection(userId);
  const ownedIds = new Set(owned.map(o => o.strain.id));
  const terpWeight = {};
  owned.forEach(o => o.strain.terps.forEach(t => { terpWeight[t.n] = (terpWeight[t.n] || 0) + t.p; }));
  const candidates = db.listStrains({ limit: 2000 }).filter(s => !ownedIds.has(s.id));
  const scored = candidates.map(s => {
    let score = 0, topShared = null, topShareVal = 0;
    s.terps.forEach(t => {
      const w = (terpWeight[t.n] || 0) * t.p;
      score += w;
      if (terpWeight[t.n] && w > topShareVal) { topShareVal = w; topShared = t.n; }
    });
    return { s, why: topShared, score };
  }).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0) {
    const highlight = candidates.filter(s => s.rarity === 'legendary' || s.rarity === 'rare').slice(0, limit);
    if (highlight.length) return highlight.map(s => ({ s, why: null }));
  }
  return scored.slice(0, limit);
}

// Badges, computed live from real app state (check-ins, trades, follows,
// RSVPs, submitted recipes/grow-tips, cart) rather than hardcoded flags.
function computeBadges(userId) {
  const owned = db.getCollection(userId).map(o => o.strain);
  const types = new Set(owned.map(s => s.type));
  const checkinCount = db.listCheckins({ userId, limit: 1 }).length;
  const anyPhoto = db.listCheckins({ userId, limit: 1000 }).some(c => c.photo);
  return [
    { id: 'b1', label: 'First Check-In', icon: '🌱', done: checkinCount >= 1 },
    { id: 'b2', label: 'Explorer (5 cards)', icon: '🧭', done: db.getUniqueOwnedCount(userId) >= 5 },
    { id: 'b3', label: 'Type Trifecta', icon: '🎯', done: types.has('Indica') && types.has('Sativa') && types.has('Hybrid') },
    { id: 'b4', label: 'Landrace Hunter', icon: '🗺️', done: owned.some(s => s.rarity === 'rare' || s.rarity === 'legendary') },
    { id: 'b5', label: 'Legendary Collector', icon: '👑', done: owned.some(s => s.rarity === 'legendary') },
    { id: 'b6', label: 'First Trade', icon: '🔁', done: db.countTrades(userId) >= 1 },
    { id: 'b7', label: 'Dispensary Scout', icon: '📍', done: db.anyDispensaryFollowed(userId) },
    { id: 'b8', label: 'Event Goer', icon: '🎉', done: db.anyRsvped(userId) },
    { id: 'b9', label: 'Recipe Contributor', icon: '✏️', done: db.hasUserApprovedRecipe(userId) },
    { id: 'b10', label: 'Community Favorite', icon: '🌟', done: db.hasUserFavoriteRecipe(userId) },
    { id: 'b11', label: 'Shopper', icon: '🛍️', done: db.getCartCount(userId) >= 1 },
    { id: 'b12', label: 'Home Grower', icon: '🌱', done: db.hasUserSubmittedGrowTip(userId) },
    { id: 'b13', label: 'Photographer', icon: '📸', done: anyPhoto },
  ];
}

// ---------------------------------------------------------------- pages

function pageHome(req, res) {
  const userId = auth.currentUserId(req);
  const recentCheckins = db.listCheckins({ userId, limit: 5 });
  const recs = getRecommendations(userId, 4);
  const dispTeaser = mock.dispensaries.slice(0, 3);

  const body = `
    <h1 class="screen-title">Welcome back 🌿</h1>
    <p class="screen-sub">Your personal cannabis journal — strains, recipes, and growing knowledge, all in one place.</p>
    <a class="btn block" href="/checkin" style="margin-bottom:18px;">＋ Log a Check-In</a>

    <div class="section-label">Recommended for you</div>
    <div class="hcarousel">
      ${recs.map(r => `
        <a class="rec-card rarity-${r.s.rarity}" href="/strains/${r.s.id}">
          ${strainPhotoTag(r.s, 'sm')}
          <span class="n">${esc(r.s.name)}</span>
          <span class="why">${r.why ? 'Because you like ' + esc(r.why) : 'New for you'}</span>
        </a>`).join('')}
    </div>

    <div class="section-label">Nearby dispensaries <a class="link" href="/dispensaries">See all →</a></div>
    <div class="disp-strip">
      ${dispTeaser.map(d => `
        <a class="disp-chip" href="/dispensaries">
          <div class="dn">${esc(d.name)}</div>
          <div class="dm">${d.distance} · ★${d.rating}</div>
          ${db.isFollowingDispensary(userId, d.id) ? `<span class="dbadge">Following</span>` : ''}
        </a>`).join('')}
    </div>

    <h2 class="screen-title" style="margin-top:20px;">Recent check-ins</h2>
    ${recentCheckins.length ? recentCheckins.map(c => {
      const s = db.getStrain(c.strain_id);
      return `<div class="feed-post">
        <a class="strain-chip" href="/strains/${c.strain_id}">
          ${strainPhotoTag(s, 'xs')}
          <span><b>${esc(s ? s.name : c.strain_id)}</b> ${s ? `<span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>` : ''}</span>
        </a>
        <div class="sub" style="margin-top:8px;">${esc(c.method)} · ${starString(c.rating)}</div>
        ${c.photo ? `<img class="photo-thumb" src="${esc(c.photo)}" alt="photo">` : ''}
        ${(c.effects || []).length ? `<div class="effect-tags">${c.effects.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
        ${c.note ? `<div class="note">"${esc(c.note)}"</div>` : ''}
      </div>`;
    }).join('') : `<div class="empty-note">No check-ins logged yet.</div>`}
  `;
  sendHtml(res, layout({ title: 'Home', active: 'home', body, isAdmin: auth.isAdmin(req) }));
}

function pageStrains(req, res, query) {
  const q = query.get('q') || '';
  const type = query.get('type') || 'All';
  const rarity = query.get('rarity') || 'All';
  const effect = query.get('effect') || 'All';
  const thc = query.get('thc') || 'All';
  const terpene = query.get('terpene') || 'All';
  const total = db.countStrains({ q, type, rarity, effect, thc, terpene });
  const results = db.listStrains({ q, type, rarity, effect, thc, terpene, limit: 60 });
  const typeOpts = ['All', 'Indica', 'Sativa', 'Hybrid'];
  const rarityOpts = ['All', 'common', 'uncommon', 'rare', 'legendary'];
  const effectOpts = ['All', 'Happy', 'Relaxed', 'Euphoric', 'Uplifted', 'Sleepy', 'Energetic', 'Creative', 'Focused', 'Hungry', 'Talkative', 'Calm', 'Social'];
  const thcOpts = ['All', 'Low', 'Medium', 'High'];
  const terpeneOpts = ['All', 'Myrcene', 'Limonene', 'Caryophyllene', 'Pinene', 'Linalool', 'Terpinolene', 'Humulene', 'Ocimene'];
  const thcLabel = { All: 'Any THC', Low: 'Low (≤15%)', Medium: 'Medium (15–25%)', High: 'High (25%+)' };
  const mk = (params) => '/strains?' + new URLSearchParams({ q, type, rarity, effect, thc, terpene, ...params }).toString();

  const body = `
    <h1 class="screen-title">Strain Library</h1>
    <p class="screen-sub">${total.toLocaleString()} strains — search by name, flavor, effect, THC level, or terpene.</p>
    <form method="GET" action="/strains" id="strain-search-form" style="margin-bottom:12px;">
      <input type="search" name="q" id="strain-search-input" value="${esc(q)}" placeholder="Search by name or flavor..." autocomplete="off">
      <input type="hidden" name="type" id="strain-search-type" value="${esc(type)}">
      <input type="hidden" name="rarity" id="strain-search-rarity" value="${esc(rarity)}">
      <input type="hidden" name="effect" id="strain-search-effect" value="${esc(effect)}">
      <input type="hidden" name="thc" id="strain-search-thc" value="${esc(thc)}">
      <input type="hidden" name="terpene" id="strain-search-terpene" value="${esc(terpene)}">
    </form>
    <div>${typeOpts.map(t => `<a class="filter-pill ${type === t ? 'active' : ''}" href="${mk({ type: t })}">${t}</a>`).join('')}</div>
    <div style="margin-bottom:10px;">${rarityOpts.map(r => `<a class="filter-pill ${rarity === r ? 'active' : ''}" href="${mk({ rarity: r })}">${r === 'All' ? 'All rarities' : rarityLabel(r)}</a>`).join('')}</div>
    <div class="section-label" style="margin-bottom:4px;">THC level</div>
    <div style="margin-bottom:10px;">${thcOpts.map(t => `<a class="filter-pill ${thc === t ? 'active' : ''}" href="${mk({ thc: t })}">${thcLabel[t]}</a>`).join('')}</div>
    <div class="section-label" style="margin-bottom:4px;">Feeling like...</div>
    <div style="margin-bottom:10px;">${effectOpts.map(e => `<a class="filter-pill ${effect === e ? 'active' : ''}" href="${mk({ effect: e })}">${e === 'All' ? 'Any effect' : e}</a>`).join('')}</div>
    <div class="section-label" style="margin-bottom:4px;">Dominant terpene</div>
    <div style="margin-bottom:10px;">${terpeneOpts.map(t => `<a class="filter-pill ${terpene === t ? 'active' : ''}" href="${mk({ terpene: t })}">${t === 'All' ? 'Any terpene' : t}</a>`).join('')}</div>
    <p class="empty-note" id="strain-search-count">${total > 60 ? `Showing 60 of ${total.toLocaleString()} — refine your search to narrow it down.` : `${total} strain${total === 1 ? '' : 's'}`}</p>
    <div id="strain-search-results">${results.map(s => `
      <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(s, 'sm')}
        <div class="info">
          <div class="nm">${esc(s.name)}</div>
          <div class="sub">${esc(s.type)} · ${rarityLabel(s.rarity)} · THC ${esc(s.thc)}</div>
        </div>
        <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>
      </a>`).join('') || `<div class="empty-note">No strains match your filters.</div>`}</div>
  `;
  sendHtml(res, layout({ title: 'Strains', active: 'strains', body, isAdmin: auth.isAdmin(req) }));
}

function pageStrainDetail(req, res, id) {
  const s = db.getStrain(id);
  if (!s) return notFound(res);
  const userId = auth.currentUserId(req);
  const history = db.listCheckins({ userId, strain_id: id, limit: 10 });
  const body = `
    <a href="/strains" class="empty-note">← Back to library</a>
    <div class="card" style="margin-top:10px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${strainPhotoTag(s, 'lg')}
        <div>
          <h1 style="margin:0;font-size:19px;">${esc(s.name)}</h1>
          <div class="empty-note" style="padding:0;">${esc(s.type)}${s.lean ? ' · ' + esc(s.lean) : ''} · <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span></div>
        </div>
      </div>
      <p style="margin:12px 0 4px;"><b>THC:</b> ${esc(s.thc)} &nbsp; <b>CBD:</b> ${esc(s.cbd)}</p>
      <p style="font-style:italic;color:var(--ink-secondary);">"${esc(s.flavor)}"</p>
      <p>${s.effects.map(e => `<span class="filter-pill">${esc(e)}</span>`).join('')}</p>
      <p><b>Top terpenes:</b> ${s.terps.map(t => `${esc(t.n)} (${Math.round(t.p * 100)}%)`).join(', ')}</p>
    </div>
    <a class="btn block" href="/checkin?strain=${s.id}">＋ Check in this strain</a>
    <h2 class="screen-title" style="margin-top:20px;">Your history with this strain</h2>
    ${history.length ? `
      <p class="empty-note">Last had: ${new Date(history[0].created_at + 'Z').toLocaleString()}</p>
      ${history.map(c => `<div class="card checkin-history-row">
        ${c.photo ? `<div class="checkin-photo-thumb"><img src="${esc(c.photo)}" alt="Your photo"></div>` : ''}
        <div style="flex:1;min-width:0;">
          <b>${esc(c.method)}</b> · ${starString(c.rating)}
          <div class="empty-note" style="padding:2px 0 0;">${new Date(c.created_at + 'Z').toLocaleString()}</div>
          ${(c.effects || []).length ? `<p style="margin:6px 0 0;">${c.effects.map(e => `<span class="filter-pill">${esc(e)}</span>`).join('')}</p>` : ''}
          ${c.note ? `<span class="empty-note" style="display:block;padding:4px 0 0;">${esc(c.note)}</span>` : ''}
        </div>
      </div>`).join('')}
    ` : `<div class="empty-note">You haven't checked this one in yet.</div>`}
  `;
  sendHtml(res, layout({ title: s.name, active: 'strains', body, isAdmin: auth.isAdmin(req) }));
}

// Full 85-term mood/effects/relief vocabulary — matched against the
// original prototype's picker so nothing was lost in the port.
const EFFECT_VOCAB = [
  'Relaxed', 'Happy', 'Euphoric', 'Uplifted', 'Creative', 'Energetic', 'Focused', 'Talkative', 'Sleepy', 'Hungry',
  'Calm', 'Clear-headed', 'Giggly', 'Social', 'Tingly', 'Aroused', 'Anxious', 'Paranoid', 'Dry Mouth', 'Dry Eyes',
  'Dizzy', 'Mellow', 'Chill', 'Zoned-out', 'Introspective', 'Blissful', 'Sedated', 'Couch-locked', 'Buzzy', 'Floaty',
  'Grounded', 'Present', 'Warm', 'Light-headed', 'Heavy-limbed', 'Alert', 'Sharp', 'Inspired', 'Playful', 'Silly',
  'Confident', 'Chatty', 'Cuddly', 'Dreamy', 'Nostalgic', 'Peaceful', 'Serene', 'Refreshed', 'Rejuvenated', 'Cozy',
  'Sociable', 'Easygoing', 'Adventurous', 'Curious', 'Observant', 'In-the-zone', 'Productive', 'Wired', 'Jittery', 'Foggy',
  'Groggy', 'Spacey', 'Munchies', 'Thirsty', 'Red-eyed', 'Lightweight', 'Heavy-eyed', 'Yawny', 'Motivated', 'Amorous',
  'Loose', 'Free-spirited', 'Tranquil', 'Elevated', 'Airy', 'Slowed-down', 'Spirited', 'Numb (localized)',
  'Stress relief', 'Pain relief', 'Sleep support', 'Nausea relief', 'Appetite boost', 'Inflammation relief', 'Muscle relief', 'Mood lift',
];

// Every ingestion method the original research turned up, grouped exactly
// like the prototype (rendered here as <optgroup>s so it stays a plain,
// dependency-free <select>).
const METHOD_GROUPS = [
  { group: 'Smoking', items: ['Joint', 'Blunt', 'Pipe / Bowl', 'Bong / Bubbler', 'One-Hitter / Chillum', 'Gravity Bong', 'Infused Pre-Roll'] },
  { group: 'Vaping', items: ['Dry Herb Vaporizer', 'Vape Cartridge (510)', 'Disposable Vape Pen', 'Live Resin Cart', 'Desktop Vaporizer'] },
  { group: 'Dabbing & Concentrates', items: ['Dab Rig (Wax/Shatter)', 'Live Resin Dab', 'Rosin Dab', 'Dab Pen / E-Rig', 'Moon Rocks', 'Kief', 'Hash'] },
  { group: 'Edibles', items: ['Gummy', 'Baked Good', 'Chocolate', 'Beverage / Drink', 'Hard Candy', 'Capsule / Pill'] },
  { group: 'Tinctures & Sublingual', items: ['Tincture (Alcohol-Based)', 'Tincture (Oil-Based)', 'Sublingual Spray'] },
  { group: 'Topicals & Other', items: ['Topical Cream / Balm', 'Transdermal Patch', 'Suppository', 'RSO (Rick Simpson Oil)', 'Cannabis Bath Soak'] },
];

function pageCheckinForm(req, res, query) {
  const strainId = query.get('strain') || '';
  const s = strainId ? db.getStrain(strainId) : null;
  const body = `
    <h1 class="screen-title">Check In</h1>
    <form method="POST" action="/checkin" id="checkin-form">
      <label class="field-label">Strain</label>
      <div id="strain-picker" ${s ? 'style="display:none;"' : ''}>
        <input type="text" id="strain-picker-search" placeholder="Type a strain name..." autocomplete="off">
        <div class="effect-results" id="strain-picker-results"></div>
      </div>
      <div id="strain-picker-selected" class="card" ${s ? '' : 'style="display:none;"'}>
        ${s ? `${s.icon} <b>${esc(s.name)}</b> <button type="button" id="strain-picker-change" class="btn secondary" style="float:right;padding:2px 10px;">Change</button>` : ''}
      </div>
      <input type="hidden" name="strain_id" id="strain-picker-hidden" value="${s ? s.id : ''}">
      <p class="empty-note" id="strain-picker-hint" ${s ? 'style="display:none;"' : ''}>Tip: search from <a href="/strains">the Strain Library</a> and tap "Check in" on the strain page for a pre-filled form.</p>

      <label class="field-label">Method</label>
      <select name="method">${METHOD_GROUPS.map(g => `<optgroup label="${esc(g.group)}">${g.items.map(m => `<option>${esc(m)}</option>`).join('')}</optgroup>`).join('')}</select>

      <label class="field-label">Rating</label>
      <select name="rating">${[5, 4, 3, 2, 1].map(n => `<option value="${n}">${starString(n)}</option>`).join('')}</select>

      <label class="field-label">Mood / Effects (pick 1–5, at least 1 required)</label>
      <div class="effect-picker" id="effect-picker">
        <input type="text" id="effect-search" placeholder="Search 85+ moods, feelings &amp; relief tags..." autocomplete="off">
        <div class="effect-results" id="effect-results"></div>
        <div class="effect-chips" id="effect-chips"></div>
        <div class="empty-note" id="effect-note" style="padding:4px 0 0;">0 of 5 selected — pick at least 1</div>
      </div>
      <div id="effect-hidden-inputs"></div>

      <label class="field-label">Photo</label>
      <div class="photo-picker" id="photo-picker">
        <div class="photo-upload-box" id="photo-upload-box" onclick="document.getElementById('photo-file-input').click()">
          <div class="up-ic">📷</div>
          <div class="up-txt">Tap to snap or upload a photo of your bud<br>(optional — we'll show a placeholder if you skip it)</div>
        </div>
        <input type="file" id="photo-file-input" accept="image/*" capture="environment" style="display:none;">
        <input type="hidden" name="photo" id="photo-data-input">
      </div>

      <label class="field-label">Notes</label>
      <textarea name="note" placeholder="How was it?"></textarea>
      <button class="btn block" type="submit" id="checkin-submit">Log It</button>
    </form>
    <script>window.EFFECT_VOCAB = ${JSON.stringify(EFFECT_VOCAB)};</script>
  `;
  sendHtml(res, layout({ title: 'Check In', active: 'strains', body, isAdmin: auth.isAdmin(req) }));
}

async function handleCheckinSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const strainId = fields.strain_id;
  if (!strainId) { sendHtml(res, layout({ title: 'Check In', body: `<p>Please pick a valid strain. <a href="/checkin">Try again</a></p>` }), 400); return; }
  let effects = Array.isArray(fields.effects) ? fields.effects : (fields.effects ? [fields.effects] : []);
  effects = effects.filter(Boolean).slice(0, 5);
  if (effects.length < 1) {
    sendHtml(res, layout({ title: 'Check In', body: `<p>Please pick at least 1 mood/effect. <a href="javascript:history.back()">Go back</a></p>` }), 400);
    return;
  }
  await db.createCheckin({
    user_id: userId, strain_id: strainId, method: fields.method, rating: Number(fields.rating) || 0,
    note: fields.note || '', effects, photo: fields.photo || null,
  });
  redirect(res, `/strains/${strainId}`);
}

function pageFaq(req, res) {
  const faqs = db.listFaqs();
  const body = `
    <h1 class="screen-title">FAQ &amp; Strain School</h1>
    ${faqs.map(f => `
      <div class="faq-item">
        <div class="faq-q" onclick="toggleFaq(this)"><span>${esc(f.question)}</span><span>⌄</span></div>
        <div class="faq-a">${esc(f.answer)}${f.source_url ? `<div class="empty-note" style="padding:6px 0 0;">Source: <a href="${esc(f.source_url)}" target="_blank" rel="noopener noreferrer">${esc(f.source_name || f.source_url)}</a></div>` : ''}</div>
      </div>`).join('') || `<div class="empty-note">No FAQ entries yet.</div>`}
    <p class="empty-note" style="margin-top:16px;">Have a question you don't see here? Ask the assistant on the <a href="/chat">Ask</a> tab.</p>
  `;
  sendHtml(res, layout({ title: 'FAQ', active: 'faq', body, isAdmin: auth.isAdmin(req) }));
}

function pageRecipes(req, res, query) {
  const category = (query && query.get('category')) || 'All';
  const recipes = db.listRecipes({ status: 'approved', category });
  const categories = ['All', 'Infusion Base', 'Baked Goods', 'Gummies & Candy', 'Drinks', 'Topicals', 'Savory & Snacks'];
  const body = `
    <h1 class="screen-title">Infused Recipes</h1>
    <a class="btn block lilac" href="/recipes/new" style="margin-bottom:14px;">✏️ Submit a Recipe</a>
    <div style="margin-bottom:14px;">${categories.map(c => `<a class="filter-pill ${category === c ? 'active' : ''}" href="/recipes?category=${encodeURIComponent(c)}">${c}</a>`).join('')}</div>
    ${recipes.map(r => `
      <div class="card">
        <b>${r.icon || '🍽️'} ${esc(r.title)}</b>
        <span class="recipe-source-tag ${r.source}">${r.source === 'official' ? 'Official' : 'Community'}</span>
        <div class="empty-note">${esc(r.category || '')}${r.time ? ' · ' + esc(r.time) : ''}${r.author ? ' · by ' + esc(r.author) : ''}</div>
        <p>${esc(r.desc)}</p>
        <details>
          <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--brand-green-dark);">Ingredients &amp; steps</summary>
          <p><b>Ingredients:</b></p>
          <ul>${r.ingredients.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
          <p><b>Steps:</b></p>
          <ol>${r.steps.map(i => `<li>${esc(i)}</li>`).join('')}</ol>
          ${r.dosing ? `<div class="dosing-note">⚠️ ${esc(r.dosing)}</div>` : ''}
        </details>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
          <span class="empty-note" style="padding:0;">${r.kudos} people found this helpful</span>
          <button class="kudos-btn" onclick="giveKudos(${r.id}, this)">👏 Kudos</button>
        </div>
      </div>`).join('') || `<div class="empty-note">No recipes in this category yet.</div>`}
  `;
  sendHtml(res, layout({ title: 'Recipes', active: 'recipes', body, isAdmin: auth.isAdmin(req) }));
}

function pageRecipeNew(req, res) {
  const body = `
    <h1 class="screen-title">Submit a Recipe</h1>
    <form method="POST" action="/recipes/new">
      <label class="field-label">Your name</label>
      <input type="text" name="author" placeholder="e.g. Jordan" required>
      <label class="field-label">Recipe title</label>
      <input type="text" name="title" required>
      <label class="field-label">Short description</label>
      <input type="text" name="desc" required>
      <label class="field-label">Ingredients (one per line)</label>
      <textarea name="ingredients" required></textarea>
      <label class="field-label">Steps (one per line)</label>
      <textarea name="steps" required></textarea>
      <label class="field-label">Dosing note</label>
      <input type="text" name="dosing" placeholder="e.g. ~10mg THC per slice">
      <button class="btn block" type="submit">Submit for Review</button>
    </form>
    <p class="empty-note">Submissions are reviewed before they go live — check back, or ask the admin.</p>
  `;
  sendHtml(res, layout({ title: 'Submit a Recipe', active: 'recipes', body, isAdmin: auth.isAdmin(req) }));
}

async function handleRecipeNewSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  await db.createRecipe({
    title: f.title, desc: f.desc, author: f.author, user_id: userId, source: 'community', status: 'pending',
    ingredients: String(f.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean),
    steps: String(f.steps || '').split('\n').map(s => s.trim()).filter(Boolean),
    dosing: f.dosing || '',
  });
  redirect(res, '/recipes?submitted=1');
}

function pageGrowing(req, res, query) {
  const CATEGORIES = ['Lighting', 'Nutrients & Feeding', 'Pests & Disease', 'Training', 'Harvest & Curing', 'Genetics & Seeds', 'Indoor Setup', 'Outdoor Growing'];
  const cat = query.get('cat') || 'All';
  const tips = db.listGrowTips({ category: cat });
  const body = `
    <h1 class="screen-title">Growing</h1>
    <p class="screen-sub">Tips &amp; tricks from home growers. Home cultivation laws vary by location — check yours first.</p>
    <a class="btn block lilac" href="/growing/new" style="margin-bottom:14px;">🌱 Share a Grow Tip</a>
    <div>
      <a class="filter-pill ${cat === 'All' ? 'active' : ''}" href="/growing?cat=All">All</a>
      ${CATEGORIES.map(c => `<a class="filter-pill ${cat === c ? 'active' : ''}" href="/growing?cat=${encodeURIComponent(c)}">${c}</a>`).join('')}
    </div>
    ${tips.map(g => `
      <div class="card grow-tip-card">
        <b>${esc(g.title)}</b>
        <div class="gcat">${esc(g.category)}</div>
        <p>${esc(g.body)}</p>
        ${g.source_url ? `<p class="empty-note" style="padding:2px 0 0;">Source: <a href="${esc(g.source_url)}" target="_blank" rel="noopener noreferrer">${esc(g.source_name || g.source_url)}</a></p>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="empty-note" style="padding:0;">by ${esc(g.author || 'Anonymous')}</span>
          <button class="kudos-btn" onclick="likeGrowTip(${g.id}, this)">👍 Helpful (${g.likes})</button>
        </div>
      </div>`).join('') || `<div class="empty-note">No tips in this category yet.</div>`}
  `;
  sendHtml(res, layout({ title: 'Growing', active: 'growing', body, isAdmin: auth.isAdmin(req) }));
}

function pageGrowingNew(req, res) {
  const CATEGORIES = ['Lighting', 'Nutrients & Feeding', 'Pests & Disease', 'Training', 'Harvest & Curing', 'Genetics & Seeds', 'Indoor Setup', 'Outdoor Growing'];
  const body = `
    <h1 class="screen-title">Share a Grow Tip</h1>
    <form method="POST" action="/growing/new">
      <label class="field-label">Your name</label>
      <input type="text" name="author" placeholder="e.g. Sam" required>
      <label class="field-label">Title</label>
      <input type="text" name="title" required>
      <label class="field-label">Category</label>
      <select name="category">${CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select>
      <label class="field-label">Your tip</label>
      <textarea name="body" required></textarea>
      <button class="btn block" type="submit">Post Tip</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Share a Grow Tip', active: 'growing', body, isAdmin: auth.isAdmin(req) }));
}

async function handleGrowingNewSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  await db.createGrowTip({ title: f.title, category: f.category, author: f.author, user_id: userId, body: f.body });
  redirect(res, '/growing');
}

function pageChat(req, res) {
  const body = `
    <h1 class="screen-title">Ask StrainDex</h1>
    <p class="screen-sub">Ask a question about strains, effects, or anything in the FAQ. Answers are generated from StrainDex's own content.</p>
    <div class="chat-box" id="chat-log"><div class="chat-msg bot">Hi! Ask me something like "what's a good strain for sleep?" or "how long do edibles take to kick in?"</div></div>
    <form id="chat-form" onsubmit="return sendChat(event)">
      <input type="text" id="chat-input" placeholder="Type your question..." autocomplete="off">
      <button class="btn block" type="submit" style="margin-top:10px;">Ask</button>
    </form>
    <script>
      async function sendChat(evt){
        evt.preventDefault();
        const input = document.getElementById('chat-input');
        const log = document.getElementById('chat-log');
        const q = input.value.trim();
        if(!q) return false;
        log.innerHTML += '<div class="chat-msg user">'+q.replace(/</g,'&lt;')+'</div>';
        input.value = '';
        log.innerHTML += '<div class="chat-msg bot" id="thinking">Thinking...</div>';
        log.scrollTop = log.scrollHeight;
        const res = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message: q }) });
        const data = await res.json();
        const escaped = data.reply.replace(/</g,'&lt;').replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>');
        document.getElementById('thinking').outerHTML = '<div class="chat-msg bot">'+escaped+'</div>';
        log.scrollTop = log.scrollHeight;
        return false;
      }
    </script>
  `;
  sendHtml(res, layout({ title: 'Ask', active: 'chat', body, isAdmin: auth.isAdmin(req) }));
}

async function handleChatApi(req, res) {
  const { message } = await parseJson(req);
  const reply = await answerFromKnowledgeBase(message || '');
  sendJson(res, { reply });
}

// ---------------------------------------------------------------- admin

function pageAdminLogin(req, res, query) {
  const err = query.get('err');
  const body = `
    <h1 class="screen-title">Admin Login</h1>
    ${err ? `<p style="color:#a13a3a;">Wrong password.</p>` : ''}
    <form method="POST" action="/admin/login">
      <label class="field-label">Password</label>
      <input type="password" name="password" required>
      <button class="btn block" type="submit">Log In</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Admin Login', body }));
}
async function handleAdminLoginSubmit(req, res) {
  const f = await parseForm(req);
  if (auth.checkPassword(f.password)) {
    const token = auth.sign('admin');
    res.setHeader('Set-Cookie', `admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    redirect(res, '/admin');
  } else {
    redirect(res, '/admin/login?err=1');
  }
}
function handleAdminLogout(req, res) {
  res.setHeader('Set-Cookie', `admin_session=; Path=/; HttpOnly; Max-Age=0`);
  redirect(res, '/');
}

// ---------------------------------------------------------------- user accounts (signup / login / logout)
function pageSignup(req, res, query) {
  const err = query.get('err');
  const errMessages = {
    taken: 'That username is already taken.',
    age: `You must be ${MIN_AGE} or older to create an account.`,
    mismatch: 'Passwords did not match.',
    short: 'Password must be at least 8 characters.',
    invalid: 'Please fill in every field.',
  };
  const body = `
    <h1 class="screen-title">Create an Account</h1>
    <p class="screen-sub">You must be ${MIN_AGE}+ to use StrainDex.</p>
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    <form method="POST" action="/signup">
      <label class="field-label" style="margin-top:0;">Username</label>
      <input type="text" name="username" required minlength="3" maxlength="24" autocomplete="username">
      <label class="field-label">Date of birth</label>
      <input type="date" name="birth_date" required>
      <label class="field-label">Password</label>
      <input type="password" name="password" required minlength="8" autocomplete="new-password">
      <label class="field-label">Confirm password</label>
      <input type="password" name="password2" required minlength="8" autocomplete="new-password">
      <button class="btn block" type="submit" style="margin-top:14px;">Create Account</button>
    </form>
    <p class="empty-note" style="margin-top:12px;">Already have an account? <a href="/login">Log in</a></p>
  `;
  sendHtml(res, layout({ title: 'Sign Up', body }));
}
async function handleSignupSubmit(req, res) {
  const f = await parseForm(req);
  const username = String(f.username || '').trim();
  if (!username || !f.birth_date || !f.password || !f.password2) return redirect(res, '/signup?err=invalid');
  if (!isOldEnough(f.birth_date)) return redirect(res, '/signup?err=age');
  if (f.password !== f.password2) return redirect(res, '/signup?err=mismatch');
  if (f.password.length < 8) return redirect(res, '/signup?err=short');
  if (db.getUserByUsername(username)) return redirect(res, '/signup?err=taken');
  const user = await db.createUser({ username, password: f.password, birth_date: f.birth_date });
  const token = auth.signUserSessionValue(user.id);
  res.setHeader('Set-Cookie', `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  redirect(res, '/');
}
function pageLogin(req, res, query) {
  const err = query.get('err');
  const body = `
    <h1 class="screen-title">Log In</h1>
    ${err ? `<p style="color:#a13a3a;">Wrong username or password.</p>` : ''}
    <form method="POST" action="/login">
      <label class="field-label" style="margin-top:0;">Username</label>
      <input type="text" name="username" required autocomplete="username">
      <label class="field-label">Password</label>
      <input type="password" name="password" required autocomplete="current-password">
      <button class="btn block" type="submit" style="margin-top:14px;">Log In</button>
    </form>
    <p class="empty-note" style="margin-top:12px;">New here? <a href="/signup">Create an account</a></p>
  `;
  sendHtml(res, layout({ title: 'Log In', body }));
}
async function handleLoginSubmit(req, res) {
  const f = await parseForm(req);
  const user = db.verifyLogin(String(f.username || '').trim(), f.password || '');
  if (!user) return redirect(res, '/login?err=1');
  const token = auth.signUserSessionValue(user.id);
  res.setHeader('Set-Cookie', `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  redirect(res, '/');
}
function handleLogout(req, res) {
  res.setHeader('Set-Cookie', `user_session=; Path=/; HttpOnly; Max-Age=0`);
  redirect(res, '/login');
}

function pageAdminHome(req, res) {
  if (!requireAdmin(req, res)) return;
  const pendingCount = db.listRecipes({ status: 'pending' }).length;
  const body = `
    <h1 class="screen-title">Admin</h1>
    <div class="card"><a href="/admin/faqs">📋 Manage FAQ (${db.listFaqs().length})</a></div>
    <div class="card"><a href="/admin/recipes">🍽️ Manage Recipes (${db.listRecipes({ status: null }).length}${pendingCount ? `, ${pendingCount} pending` : ''})</a></div>
    <div class="card"><a href="/admin/strains">🃏 Manage Strains (${db.countStrains().toLocaleString()})</a></div>
    <div class="card"><a href="/admin/logout">🚪 Log out</a></div>
  `;
  sendHtml(res, layout({ title: 'Admin', body, isAdmin: true }));
}

function pageAdminFaqs(req, res) {
  if (!requireAdmin(req, res)) return;
  const faqs = db.listFaqs();
  const body = `
    <h1 class="screen-title">Manage FAQ</h1>
    <div class="card">
      <form method="POST" action="/admin/faqs/new">
        <label class="field-label" style="margin-top:0;">Question</label>
        <input type="text" name="question" required>
        <label class="field-label">Answer</label>
        <textarea name="answer" required></textarea>
        <label class="field-label">Source name (optional)</label>
        <input type="text" name="source_name" placeholder="e.g. Harvard Health">
        <label class="field-label">Source URL (optional)</label>
        <input type="text" name="source_url" placeholder="https://...">
        <button class="btn block" type="submit">Add FAQ</button>
      </form>
    </div>
    ${faqs.map(f => `
      <div class="admin-row" style="flex-direction:column;align-items:stretch;">
        <b>${esc(f.question)}</b>
        <p class="empty-note">${esc(f.answer)}</p>
        ${f.source_url ? `<p class="empty-note">Source: ${esc(f.source_name || f.source_url)}</p>` : ''}
        <div class="actions">
          <a href="/admin/faqs/${f.id}/edit" class="btn secondary" style="text-decoration:none;">Edit</a>
          <form method="POST" action="/admin/faqs/${f.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this FAQ entry?')">
            <button class="btn danger" type="submit" style="color:#fff;">Delete</button>
          </form>
        </div>
      </div>`).join('')}
  `;
  sendHtml(res, layout({ title: 'Manage FAQ', body, isAdmin: true }));
}
async function handleAdminFaqNew(req, res) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  await db.createFaq({ question: f.question, answer: f.answer, sort_order: db.listFaqs().length, source_name: f.source_name, source_url: f.source_url });
  redirect(res, '/admin/faqs');
}
function pageAdminFaqEdit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const f = db.getFaq(id);
  if (!f) return notFound(res);
  const body = `
    <h1 class="screen-title">Edit FAQ</h1>
    <form method="POST" action="/admin/faqs/${f.id}/edit">
      <label class="field-label" style="margin-top:0;">Question</label>
      <input type="text" name="question" value="${esc(f.question)}" required>
      <label class="field-label">Answer</label>
      <textarea name="answer" required>${esc(f.answer)}</textarea>
      <label class="field-label">Source name (optional)</label>
      <input type="text" name="source_name" value="${esc(f.source_name)}" placeholder="e.g. Harvard Health">
      <label class="field-label">Source URL (optional)</label>
      <input type="text" name="source_url" value="${esc(f.source_url)}" placeholder="https://...">
      <button class="btn block" type="submit">Save</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Edit FAQ', body, isAdmin: true }));
}
async function handleAdminFaqEditSubmit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  const current = db.getFaq(id);
  await db.updateFaq(id, { question: f.question, answer: f.answer, sort_order: current ? current.sort_order : 0, source_name: f.source_name, source_url: f.source_url });
  redirect(res, '/admin/faqs');
}
async function handleAdminFaqDelete(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.deleteFaq(id);
  redirect(res, '/admin/faqs');
}

// ---------------------------------------------------------------- admin: strains
// Simple text inputs for effects/terpenes rather than dynamic add/remove rows —
// easiest to fill in by hand: "Relaxed, Happy, Euphoric" and "Myrcene:30, Limonene:25".
function parseEffectsInput(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}
function parseTerpsInput(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const [n, p] = pair.split(':').map(x => (x || '').trim());
    return { n: n || '', p: p ? Number(p) / 100 : 0 };
  }).filter(t => t.n);
}
function effectsToInput(effects) { return (effects || []).join(', '); }
function terpsToInput(terps) { return (terps || []).map(t => `${t.n}:${Math.round((t.p || 0) * 100)}`).join(', '); }

function strainFormFields(s) {
  const v = (val) => esc(val ?? '');
  const opt = (val, label) => `<option value="${v(val)}" ${s && s.type === val ? 'selected' : ''}>${label}</option>`;
  const ropt = (val, label) => `<option value="${v(val)}" ${s && s.rarity === val ? 'selected' : ''}>${label}</option>`;
  return `
    <label class="field-label" style="margin-top:0;">Name</label>
    <input type="text" name="name" value="${v(s && s.name)}" required>
    <label class="field-label">Type</label>
    <select name="type">${opt('Indica', 'Indica')}${opt('Sativa', 'Sativa')}${opt('Hybrid', 'Hybrid')}</select>
    <label class="field-label">Lean (optional, e.g. "Sativa-leaning")</label>
    <input type="text" name="lean" value="${v(s && s.lean)}">
    <label class="field-label">Rarity</label>
    <select name="rarity">${ropt('common', 'Common')}${ropt('uncommon', 'Uncommon')}${ropt('rare', 'Rare')}${ropt('legendary', 'Legendary')}</select>
    <label class="field-label">THC range (e.g. "19–29%")</label>
    <input type="text" name="thc" value="${v(s && s.thc)}">
    <label class="field-label">CBD range (e.g. "<1%")</label>
    <input type="text" name="cbd" value="${v(s && s.cbd)}">
    <label class="field-label">Flavor description</label>
    <input type="text" name="flavor" value="${v(s && s.flavor)}">
    <label class="field-label">Icon (a single emoji)</label>
    <input type="text" name="icon" value="${v(s ? s.icon : '🌿')}" maxlength="4">
    <label class="field-label">Effects (comma-separated, e.g. "Relaxed, Happy, Euphoric")</label>
    <input type="text" name="effects" value="${v(effectsToInput(s && s.effects))}">
    <label class="field-label">Top terpenes (comma-separated "Name:Percent", e.g. "Myrcene:30, Limonene:25")</label>
    <input type="text" name="terps" value="${v(terpsToInput(s && s.terps))}">
  `;
}

function pageAdminStrains(req, res, query) {
  if (!requireAdmin(req, res)) return;
  const q = (query && query.get('q')) || '';
  const results = q ? db.listStrains({ q, limit: 50 }) : db.listStrains({ limit: 50 });
  const total = db.countStrains();
  const body = `
    <h1 class="screen-title">Manage Strains</h1>
    <p class="screen-sub">${total.toLocaleString()} strains in the library.</p>
    <div class="card">
      <h2 style="margin-top:0;font-size:16px;">Add a strain</h2>
      <form method="POST" action="/admin/strains/new">
        ${strainFormFields(null)}
        <button class="btn block" type="submit">Add Strain</button>
      </form>
    </div>
    <form method="GET" action="/admin/strains" style="margin:16px 0 8px;">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search strains to edit or delete...">
    </form>
    <p class="empty-note">${q ? `${results.length} match${results.length === 1 ? '' : 'es'}` : `Showing 50 of ${total.toLocaleString()} — search to find a specific one`}</p>
    ${results.map(s => `
      <div class="admin-row">
        ${strainPhotoTag(s, 'sm')}
        <div style="flex:1;min-width:0;">
          <b>${esc(s.name)}</b>
          <div class="empty-note" style="padding:0;">${esc(s.type)} · ${rarityLabel(s.rarity)}</div>
        </div>
        <div class="actions">
          <a href="/admin/strains/${s.id}/edit" class="btn secondary" style="text-decoration:none;">Edit</a>
          <form method="POST" action="/admin/strains/${s.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this strain? This cannot be undone.')">
            <button class="btn danger" type="submit" style="color:#fff;">Delete</button>
          </form>
        </div>
      </div>`).join('')}
  `;
  sendHtml(res, layout({ title: 'Manage Strains', body, isAdmin: true }));
}
async function handleAdminStrainNew(req, res) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  const id = db.nextStrainId();
  await db.insertStrain({
    id, name: f.name, type: f.type, lean: f.lean, rarity: f.rarity, thc: f.thc, cbd: f.cbd,
    flavor: f.flavor, icon: f.icon || '🌿', effects: parseEffectsInput(f.effects), terps: parseTerpsInput(f.terps),
  });
  redirect(res, '/admin/strains');
}
function pageAdminStrainEdit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const s = db.getStrain(id);
  if (!s) return notFound(res);
  const body = `
    <h1 class="screen-title">Edit Strain</h1>
    <form method="POST" action="/admin/strains/${s.id}/edit">
      ${strainFormFields(s)}
      <button class="btn block" type="submit">Save</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Edit Strain', body, isAdmin: true }));
}
async function handleAdminStrainEditSubmit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  await db.insertStrain({
    id, name: f.name, type: f.type, lean: f.lean, rarity: f.rarity, thc: f.thc, cbd: f.cbd,
    flavor: f.flavor, icon: f.icon || '🌿', effects: parseEffectsInput(f.effects), terps: parseTerpsInput(f.terps),
  });
  redirect(res, '/admin/strains');
}
async function handleAdminStrainDelete(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.deleteStrain(id);
  redirect(res, '/admin/strains');
}

function pageAdminRecipes(req, res) {
  if (!requireAdmin(req, res)) return;
  const pending = db.listRecipes({ status: 'pending' });
  const all = db.listRecipes({ status: null });
  const body = `
    <h1 class="screen-title">Manage Recipes</h1>
    <div class="card">
      <form method="POST" action="/admin/recipes/new">
        <label class="field-label" style="margin-top:0;">Title</label>
        <input type="text" name="title" required>
        <label class="field-label">Description</label>
        <input type="text" name="desc" required>
        <label class="field-label">Category</label>
        <select name="category">${['Infusion Base', 'Baked Goods', 'Gummies & Candy', 'Drinks', 'Topicals', 'Savory & Snacks'].map(c => `<option value="${c}">${c}</option>`).join('')}</select>
        <label class="field-label">Ingredients (one per line)</label>
        <textarea name="ingredients" required></textarea>
        <label class="field-label">Steps (one per line)</label>
        <textarea name="steps" required></textarea>
        <label class="field-label">Dosing note</label>
        <input type="text" name="dosing">
        <button class="btn block" type="submit">Add Recipe (published immediately)</button>
      </form>
    </div>
    ${pending.length ? `<h2 class="screen-title">Pending review (${pending.length})</h2>` + pending.map(r => `
      <div class="admin-row" style="flex-direction:column;align-items:stretch;">
        <b>${esc(r.title)}</b> <span class="empty-note">by ${esc(r.author || 'Anonymous')}</span>
        <p class="empty-note">${esc(r.desc)}</p>
        <div class="actions">
          <form method="POST" action="/admin/recipes/${r.id}/approve" style="display:inline;"><button class="btn" type="submit">Approve</button></form>
          <form method="POST" action="/admin/recipes/${r.id}/delete" style="display:inline;" onsubmit="return confirm('Reject and delete?')"><button class="btn danger" style="color:#fff;" type="submit">Reject</button></form>
        </div>
      </div>`).join('') : ''}
    <h2 class="screen-title">All recipes</h2>
    ${all.map(r => `
      <div class="admin-row">
        <span>${esc(r.title)} <span class="recipe-source-tag ${r.source}">${r.status}</span> <span class="empty-note">${esc(r.category || '')}</span></span>
        <div class="actions">
          <form method="POST" action="/admin/recipes/${r.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this recipe?')">
            <button class="btn danger" style="color:#fff;" type="submit">Delete</button>
          </form>
        </div>
      </div>`).join('')}
  `;
  sendHtml(res, layout({ title: 'Manage Recipes', body, isAdmin: true }));
}
async function handleAdminRecipeNew(req, res) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  await db.createRecipe({
    title: f.title, desc: f.desc, dosing: f.dosing, category: f.category || 'Baked Goods', source: 'official', status: 'approved', author: null,
    ingredients: String(f.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean),
    steps: String(f.steps || '').split('\n').map(s => s.trim()).filter(Boolean),
  });
  redirect(res, '/admin/recipes');
}
async function handleAdminRecipeApprove(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.updateRecipe(id, { status: 'approved' });
  redirect(res, '/admin/recipes');
}
async function handleAdminRecipeDelete(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.deleteRecipe(id);
  redirect(res, '/admin/recipes');
}

// ---------------------------------------------------------------- API

function apiListStrains(req, res, query) {
  const q = query.get('q') || '';
  const type = query.get('type') || 'All';
  const rarity = query.get('rarity') || 'All';
  const effect = query.get('effect') || 'All';
  const thc = query.get('thc') || 'All';
  const terpene = query.get('terpene') || 'All';
  const limit = Math.min(Number(query.get('limit')) || 60, 200);
  sendJson(res, {
    total: db.countStrains({ q, type, rarity, effect, thc, terpene }),
    results: db.listStrains({ q, type, rarity, effect, thc, terpene, limit }),
  });
}
async function apiKudos(req, res, id) {
  const r = await db.addKudos(id);
  if (!r) return sendJson(res, { error: 'not found' }, 404);
  sendJson(res, { kudos: r.kudos });
}
async function apiGrowLike(req, res, id) {
  await db.likeGrowTip(id);
  const tip = db.listGrowTips().find(t => t.id === id);
  sendJson(res, { likes: tip ? tip.likes : 0 });
}

// ---------------------------------------------------------------- static

// ---------------------------------------------------------------- more hub

function pageMore(req, res) {
  const userId = auth.currentUserId(req);
  const user = userId != null ? db.getUserById(userId) : null;
  // Only genuinely working features show up here. Features still using demo/
  // mock data (Events, Shop, the Business preview) are intentionally left out
  // of this list so people don't think they can do something real there —
  // their routes/handlers still work if linked to directly, so nothing is
  // deleted, just hidden from the main menu until they're actually built out.
  // To bring one back: move its entry from comingSoonTiles into tiles below.
  const tiles = [
    { href: '/collection', icon: '🃏', t: 'My Collection', s: 'Binder, badges & progress' },
    { href: '/friends', icon: '🧑\u200d🤝\u200d🧑', t: 'Friends', s: 'Find people & manage requests' },
    { href: '/trade', icon: '🔁', t: 'Trade', s: 'Swap dupes with real friends' },
    { href: '/history', icon: '🕐', t: 'Check-In History', s: 'Your full timeline' },
    { href: '/dispensaries', icon: '📍', t: 'Dispensaries', s: 'Locator & live menus' },
    { href: '/badges', icon: '🏅', t: 'Badges', s: 'Full directory' },
    { href: '/strains', icon: '📇', t: 'Strain Library', s: `${db.countStrains().toLocaleString()}-strain rolodex` },
    { href: '/growing', icon: '🌱', t: 'Growing', s: 'Home-grow tips' },
    { href: '/faq', icon: '❓', t: 'FAQ', s: 'Strain school' },
    { href: '/methods', icon: '💨', t: 'Ways to Enjoy It', s: 'Every method, explained' },
  ];
  // Hidden from this menu for now (not deleted — routes below still work if
  // linked to directly): /events, /shop, /business. All three still run on
  // demo/mock data rather than anything real yet. To bring one back, add its
  // tile object to the array above.
  const body = `
    <h1 class="screen-title">More</h1>
    ${user ? `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <span>👤 Logged in as <b>${esc(user.username)}</b></span>
        <form method="POST" action="/logout"><button class="btn secondary" type="submit">Log out</button></form>
      </div>` : ''}
    <div class="more-grid">
      ${tiles.map(t => `<a class="more-tile" href="${t.href}"><span class="ic">${t.icon}</span><div class="t">${esc(t.t)}</div><div class="s">${esc(t.s)}</div></a>`).join('')}
    </div>
  `;
  sendHtml(res, layout({ title: 'More', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

// ---------------------------------------------------------------- collection / binder

function pageCollection(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const owned = db.getCollection(userId).sort((a, b) => a.strain.name.localeCompare(b.strain.name));
  const uniqueCount = db.getUniqueOwnedCount(userId);
  const totalStrains = db.countStrains();
  const badges = computeBadges(userId);
  const doneBadges = badges.filter(b => b.done).length;
  const pct = totalStrains ? Math.round((100 * uniqueCount) / totalStrains) : 0;

  const body = `
    <h1 class="screen-title">My Collection</h1>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <a class="follow-btn" style="flex:1;text-align:center;" href="/strains">🔍 Browse Strain Library</a>
      <a class="follow-btn" style="flex:1;text-align:center;" href="/history">🕐 Check-In History</a>
    </div>
    <div class="collection-stats">
      <div class="stat-tile"><div class="num">${uniqueCount}/${totalStrains.toLocaleString()}</div><div class="lbl">Cards caught</div></div>
      <div class="stat-tile"><div class="num">${db.getTotalDupes(userId)}</div><div class="lbl">Tradeable dupes</div></div>
      <div class="stat-tile"><div class="num">${doneBadges}/${badges.length}</div><div class="lbl">Badges</div></div>
    </div>
    <div class="progress-bar"><div class="fill" style="width:${pct}%;"></div></div>

    ${owned.length ? `<div class="binder-grid">
      ${owned.map(o => `
        <a class="card-slot rarity-${o.strain.rarity}" href="/strains/${o.strain.id}">
          ${o.copies > 1 ? `<div class="copies">×${o.copies}</div>` : ''}
          ${strainPhotoTag(o.strain, 'md')}
          <div class="name">${esc(o.strain.name)}</div>
        </a>`).join('')}
    </div>` : `<div class="empty-note">No cards caught yet — <a href="/checkin">log a check-in</a> to unlock your first one.</div>`}

    <h2 class="screen-title" style="margin-top:20px;">Badges</h2>
    <div class="badge-row">${badges.map(b => `<div class="badge-chip ${b.done ? '' : 'locked'}">${b.icon} ${esc(b.label)}</div>`).join('')}</div>
  `;
  sendHtml(res, layout({ title: 'My Collection', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

function pageHistory(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const history = db.listCheckins({ userId, limit: 200 });
  const body = `
    <h1 class="screen-title">Check-In History</h1>
    <p class="screen-sub">Your full timeline, newest first.</p>
    ${history.length ? history.map(c => {
      const s = db.getStrain(c.strain_id);
      return `<a class="library-row" href="/strains/${c.strain_id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(s, 'sm')}
        <div class="info">
          <div class="nm">${esc(s ? s.name : c.strain_id)}</div>
          <div class="sub">${esc(c.method)} · ${starString(c.rating)} · ${new Date(c.created_at + 'Z').toLocaleString()}</div>
        </div>
      </a>`;
    }).join('') : `<div class="empty-note">No check-ins logged yet — <a href="/checkin">log your first one</a>.</div>`}
  `;
  sendHtml(res, layout({ title: 'Check-In History', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

// ---------------------------------------------------------------- friends
function pageFriends(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const q = (query.get('q') || '').trim();
  const results = q ? db.searchUsers(q, userId) : [];
  const friends = db.listFriends(userId);
  const incoming = db.listIncomingRequests(userId);
  const outgoing = db.listOutgoingRequests(userId);

  const body = `
    <h1 class="screen-title">Friends</h1>
    <p class="screen-sub">Find people by username, then trade dupes once you're connected.</p>
    <form method="GET" action="/friends" style="margin-bottom:14px;display:flex;gap:8px;">
      <input type="text" name="q" value="${esc(q)}" placeholder="Search by username..." autocomplete="off" style="flex:1;">
      <button class="btn" type="submit">Search</button>
    </form>
    ${q ? `
      <div class="section-label">Search results</div>
      ${results.length ? results.map(u => {
        const status = db.getFriendshipStatus(userId, u.id);
        return `<div class="admin-row">
          <span>👤 ${esc(u.username)}</span>
          <div class="actions">
            ${status === 'none' ? `<form method="POST" action="/friends/${u.id}/request"><button class="btn" type="submit">Add Friend</button></form>` : ''}
            ${status === 'pending_sent' ? `<span class="empty-note">Request sent</span>` : ''}
            ${status === 'pending_received' ? `<span class="empty-note">Check your requests below</span>` : ''}
            ${status === 'friends' ? `<span class="empty-note">Already friends</span>` : ''}
          </div>
        </div>`;
      }).join('') : `<div class="empty-note">No users found matching "${esc(q)}".</div>`}
    ` : ''}

    ${incoming.length ? `
      <div class="section-label" style="margin-top:20px;">Friend requests (${incoming.length})</div>
      ${incoming.map(u => `
        <div class="admin-row">
          <span>👤 ${esc(u.username)}</span>
          <div class="actions">
            <form method="POST" action="/friends/${u.id}/accept" style="display:inline;"><button class="btn" type="submit">Accept</button></form>
            <form method="POST" action="/friends/${u.id}/decline" style="display:inline;"><button class="btn danger" style="color:#fff;" type="submit">Decline</button></form>
          </div>
        </div>`).join('')}
    ` : ''}

    ${outgoing.length ? `
      <div class="section-label" style="margin-top:20px;">Pending sent (${outgoing.length})</div>
      ${outgoing.map(u => `<div class="admin-row"><span>👤 ${esc(u.username)}</span><span class="empty-note">Waiting for response</span></div>`).join('')}
    ` : ''}

    <div class="section-label" style="margin-top:20px;">Your friends (${friends.length})</div>
    ${friends.length ? friends.map(u => `
      <div class="admin-row">
        <span>👤 ${esc(u.username)}</span>
        <div class="actions">
          <a href="/trade?friend=${u.id}" class="btn secondary" style="text-decoration:none;">Trade</a>
          <form method="POST" action="/friends/${u.id}/remove" style="display:inline;" onsubmit="return confirm('Remove this friend?')">
            <button class="btn danger" style="color:#fff;" type="submit">Remove</button>
          </form>
        </div>
      </div>`).join('') : `<div class="empty-note">No friends yet — search for a username above to get started.</div>`}
  `;
  sendHtml(res, layout({ title: 'Friends', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}
async function handleFriendRequest(req, res, otherId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.sendFriendRequest(userId, otherId);
  redirect(res, '/friends');
}
async function handleFriendAccept(req, res, otherId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.respondToFriendRequest(userId, otherId, true);
  redirect(res, '/friends');
}
async function handleFriendDecline(req, res, otherId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.respondToFriendRequest(userId, otherId, false);
  redirect(res, '/friends');
}
async function handleFriendRemove(req, res, otherId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.removeFriendship(userId, otherId);
  redirect(res, '/friends');
}

// ---------------------------------------------------------------- trading (real friends, or demo)

function pageTrade(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const realFriends = db.listFriends(userId);
  const usingReal = realFriends.length > 0;

  // Normalize both real and demo friends to the same shape: { id, name, collection }
  // where collection is { strainId: copiesOwned }, so the rest of this function
  // doesn't need two separate code paths.
  const friendOptions = usingReal
    ? realFriends.map(u => ({
        id: String(u.id), name: u.username,
        collection: Object.fromEntries(db.getCollection(u.id).map(o => [o.strain.id, o.copies])),
      }))
    : mock.friends.map(f => ({ id: f.id, name: f.name, collection: f.collection }));

  const friendId = query.get('friend') || friendOptions[0].id;
  const friend = friendOptions.find(f => f.id === friendId) || friendOptions[0];
  const yourPick = query.get('your') || '';
  const theirPick = query.get('their') || '';

  const collection = db.getCollection(userId);
  const yourDupes = collection.filter(o => o.copies > 1 && !friend.collection[o.strain.id]);
  const theirDupeIds = Object.entries(friend.collection).filter(([id, c]) => c > 1 && !collection.some(o => o.strain.id === id));

  const mk = (params) => '/trade?' + new URLSearchParams({ friend: friendId, your: yourPick, their: theirPick, ...params }).toString();

  const body = `
    <h1 class="screen-title">Trade</h1>
    ${usingReal
      ? `<div class="trade-caveat">Trading against ${esc(friend.name)}'s real collection.</div>`
      : `<div class="trade-caveat">Demo feature: you don't have any real friends added yet, so this trades against sample collections. <a href="/friends">Add a real friend</a> to trade for real.</div>`}
    <div class="friend-strip">
      ${friendOptions.map(f => `<a class="friend-chip ${f.id === friendId ? 'selected' : ''}" href="${'/trade?friend=' + f.id}"><div class="avatar">${f.name[0]}</div><div class="fname">${esc(f.name)}</div></a>`).join('')}
    </div>
    <div class="trade-cols">
      <div class="trade-col">
        <h4>Your offer</h4>
        ${yourDupes.length ? yourDupes.map(o => `
          <a class="trade-item ${yourPick === o.strain.id ? 'selected' : ''}" href="${mk({ your: o.strain.id })}">
            ${strainPhotoTag(o.strain, 'sm')}
            <div class="info"><span class="n">${esc(o.strain.name)}</span><span class="c">×${o.copies} owned</span></div>
          </a>`).join('') : `<div class="empty-note">No spare duplicates ${esc(friend.name)} needs right now.</div>`}
      </div>
      <div class="trade-col">
        <h4>${esc(friend.name)}'s offer</h4>
        ${theirDupeIds.length ? theirDupeIds.map(([id, c]) => {
          const s = db.getStrain(id);
          if (!s) return '';
          return `<a class="trade-item ${theirPick === id ? 'selected' : ''}" href="${mk({ their: id })}">
            ${strainPhotoTag(s, 'sm')}
            <div class="info"><span class="n">${esc(s.name)}</span><span class="c">×${c} owned</span></div>
          </a>`;
        }).join('') : `<div class="empty-note">${esc(friend.name)} has nothing spare you're missing.</div>`}
      </div>
    </div>
    <form method="POST" action="/trade/propose">
      <input type="hidden" name="friend" value="${esc(friendId)}">
      <input type="hidden" name="your" value="${esc(yourPick)}">
      <input type="hidden" name="their" value="${esc(theirPick)}">
      <button class="propose-btn" type="submit" ${(!yourPick || !theirPick) ? 'disabled' : ''}>Propose Trade</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Trade', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

async function handleTradePropose(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const mockFriend = mock.friends.find(f => f.id === fields.friend);
  const realFriend = /^\d+$/.test(fields.friend || '') ? db.getUserById(Number(fields.friend)) : null;
  const friendName = mockFriend ? mockFriend.name : (realFriend ? realFriend.username : null);
  if (friendName && fields.your && fields.their) {
    await db.createTrade({ user_id: userId, friend_name: friendName, gave_strain_id: fields.your, got_strain_id: fields.their });
  }
  redirect(res, '/trade?friend=' + encodeURIComponent(fields.friend || ''));
}

// ---------------------------------------------------------------- dispensaries

async function pageDispensaries(req, res, searchParams) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const zipParam = (searchParams.get('zip') || '').trim();
  let lat = Number(searchParams.get('lat'));
  let lon = Number(searchParams.get('lon'));
  let hasLocation = searchParams.has('lat') && searchParams.has('lon') && !Number.isNaN(lat) && !Number.isNaN(lon);
  let locationLabel = 'you';
  let realError = null;

  if (zipParam) {
    const geocoded = await geo.geocodeZip(zipParam);
    if (geocoded.ok) {
      lat = geocoded.lat;
      lon = geocoded.lon;
      hasLocation = true;
      locationLabel = geocoded.label;
    } else {
      realError = geocoded.reason;
    }
  }

  let realResults = null;
  if (hasLocation) {
    const outcome = await geo.findNearbyDispensaries(lat, lon);
    if (outcome.ok) realResults = outcome.results;
    else realError = outcome.reason;
  }

  let body;
  if (realResults) {
    const sourceLabel = process.env.GOOGLE_PLACES_API_KEY ? 'Google Places' : 'OpenStreetMap';
    body = `
      <h1 class="screen-title">Dispensaries</h1>
      <p class="screen-sub geo-live"><span class="dot"></span> Showing ${realResults.length} real dispensar${realResults.length === 1 ? 'y' : 'ies'} near ${esc(locationLabel)}, via ${esc(sourceLabel)}. <a href="/dispensaries">Use sample listings instead</a></p>
      ${realResults.map(d => {
        const following = db.isFollowingDispensary(userId, d.id);
        const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lon}`;
        return `<div class="dispensary-card">
          <div class="dtop">
            <div>
              <div class="dname">${esc(d.name)}${d.rating ? ` <span class="empty-note" style="padding:0;">★${d.rating}</span>` : ''}</div>
              <div class="dsub">${d.distanceLabel ? esc(d.distanceLabel) + ' · ' : ''}${esc(d.address || 'Address not listed')}</div>
              ${d.hours ? `<div class="dsub">${sourceLabel === 'Google Places' ? esc(d.hours) : 'Hours: ' + esc(d.hours)}</div>` : ''}
              ${d.phone ? `<div class="dsub">${esc(d.phone)}</div>` : ''}
            </div>
            <form method="POST" action="/dispensaries/${encodeURIComponent(d.id)}/follow?lat=${lat}&lon=${lon}">
              <button class="follow-btn ${following ? 'following' : ''}" type="submit">${following ? 'Following' : 'Follow'}</button>
            </form>
          </div>
          <div style="margin-top:10px;display:flex;gap:14px;">
            <a href="${mapsUrl}" target="_blank" rel="noopener">Get directions →</a>
            ${d.website ? `<a href="${esc(d.website)}" target="_blank" rel="noopener">Website →</a>` : ''}
          </div>
        </div>`;
      }).join('')}
      <p class="screen-sub" style="margin-top:16px;">Real name, address, and location — pulled live from ${esc(sourceLabel)}. No live menu or pricing data exists for these yet (that lives inside each dispensary's own point-of-sale system), so menus aren't shown here.</p>
    `;
  } else {
    body = `
      <h1 class="screen-title">Dispensaries</h1>
      <div class="locate-banner">
        <div style="font-weight:700;font-size:13px;">📍 Find real dispensaries near you</div>
        <div class="dsub" style="margin:3px 0 10px;">${realError ? esc(realError) + ' Showing sample listings below instead.' : "Search by ZIP code, or share your location — nothing is sent anywhere else."}</div>
        <div class="locate-row">
          <form method="GET" action="/dispensaries" class="zip-form">
            <input type="text" name="zip" placeholder="ZIP code" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" value="${esc(zipParam)}">
            <button type="submit" class="follow-btn">Search</button>
          </form>
          <button type="button" id="use-location-btn" class="follow-btn">Use my location</button>
        </div>
      </div>
      <p class="screen-sub">Sample listings below for the demo — swap in a real dispensary feed when you're ready.</p>
      ${mock.dispensaries.map(d => {
        const following = db.isFollowingDispensary(userId, d.id);
        const exclusiveStrain = d.exclusiveCard ? db.getStrain(d.exclusiveCard) : null;
        const hasExclusive = exclusiveStrain && !db.getCollection(userId).some(o => o.strain.id === exclusiveStrain.id);
        return `<div class="dispensary-card">
          <div class="dtop">
            <div>
              <div class="dname">${esc(d.name)}</div>
              <div class="dsub">${d.distance} · ★${d.rating} · ${esc(d.address)}</div>
              <div class="dsub">Hours: ${esc(d.hours)}</div>
            </div>
            <form method="POST" action="/dispensaries/${d.id}/follow">
              <button class="follow-btn ${following ? 'following' : ''}" type="submit">${following ? 'Following' : 'Follow'}</button>
            </form>
          </div>
          <div class="live-menu-tag"><span class="dot"></span> Live menu updated ${d.updated}</div>
          <div style="margin-top:10px;">
            ${d.menu.map(m => { const s = db.getStrain(m.strainId); return s ? `<div class="menu-row"><span>${s.icon} ${esc(s.name)}</span><span>${esc(m.price)}</span></div>` : ''; }).join('')}
          </div>
          ${hasExclusive ? `<div class="exclusive-banner">
            <span>📍 Location-exclusive card: <b>${esc(exclusiveStrain.name)}</b></span>
            <a href="/checkin?strain=${exclusiveStrain.id}">Check In Here</a>
          </div>` : ''}
        </div>`;
      }).join('')}
    `;
  }
  sendHtml(res, layout({ title: 'Dispensaries', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

async function handleDispensaryFollow(req, res, id, searchParams) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.toggleFollowDispensary(userId, id);
  const lat = searchParams.get('lat');
  const lon = searchParams.get('lon');
  redirect(res, lat && lon ? `/dispensaries?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}` : '/dispensaries');
}

// ---------------------------------------------------------------- events

function pageEvents(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const body = `
    <h1 class="screen-title">Events</h1>
    <p class="screen-sub">Sample local events for the demo.</p>
    ${mock.events.map(e => {
      const venue = mock.dispensaries.find(d => d.id === e.venueId);
      const going = db.isRsvped(userId, e.id);
      return `<div class="event-card">
        <div class="event-date">${e.month}<br>${e.day}</div>
        <div>
          <div class="event-title">${esc(e.title)}</div>
          <div class="event-venue">${venue ? esc(venue.name) : ''}</div>
          <div class="event-desc">${esc(e.desc)}</div>
          <form method="POST" action="/events/${e.id}/rsvp">
            <button class="rsvp-btn ${going ? 'going' : ''}" type="submit">${going ? "✓ You're going" : 'RSVP'}</button>
          </form>
        </div>
      </div>`;
    }).join('')}
  `;
  sendHtml(res, layout({ title: 'Events', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

async function handleEventRsvp(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.toggleRsvp(userId, id);
  redirect(res, '/events');
}

// ---------------------------------------------------------------- business dashboard

function pageBusiness(req, res) {
  const trending = db.getMostCheckedInStrains(5);
  const max = trending.length ? Math.max(...trending.map(t => t.count)) : 1;
  const body = `
    <h1 class="screen-title">StrainDex for Business</h1>
    <div class="biz-banner">
      <div class="bt">Partner dashboard preview</div>
      <div class="bs">A look at what a dispensary partner would see: what's trending with your actual check-in data, in real time.</div>
    </div>
    <h2 class="screen-title">Trending strains (from real check-ins)</h2>
    ${trending.length ? trending.map(t => `
      <div class="trend-row">
        <div class="trend-label">${esc(t.strain.name)}</div>
        <div class="trend-track"><div class="trend-fill" style="width:${Math.round((100 * t.count) / max)}%;"></div></div>
        <div class="trend-val">${t.count}</div>
      </div>`).join('') : `<div class="empty-note">No check-in data yet — trends will appear here once check-ins start coming in.</div>`}
  `;
  sendHtml(res, layout({ title: 'Business', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

// ---------------------------------------------------------------- shop

function pageShop(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const cartCount = db.getCartCount(userId);
  const body = `
    <h1 class="screen-title">Shop</h1>
    <p class="screen-sub">Sample merch for the demo — not a real store yet.</p>
    <div class="shop-grid">
      ${mock.shopItems.map(i => `
        <div class="shop-item">
          <div class="ic">${i.icon}</div>
          <div class="sn">${esc(i.name)}</div>
          <div class="sp">${esc(i.price)}</div>
          <form method="POST" action="/shop/${i.id}/add"><button type="submit">Add to Cart</button></form>
        </div>`).join('')}
    </div>
    <div class="cart-note">Cart: ${cartCount} item${cartCount === 1 ? '' : 's'}</div>
  `;
  sendHtml(res, layout({ title: 'Shop', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

async function handleShopAdd(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.addToCart(userId, id);
  redirect(res, '/shop');
}

// ---------------------------------------------------------------- badges directory

function pageBadges(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const badges = computeBadges(userId);
  const body = `
    <h1 class="screen-title">Badges</h1>
    <p class="screen-sub">${badges.filter(b => b.done).length} of ${badges.length} earned.</p>
    <div class="badge-row">${badges.map(b => `<div class="badge-chip ${b.done ? '' : 'locked'}">${b.icon} ${esc(b.label)}</div>`).join('')}</div>
  `;
  sendHtml(res, layout({ title: 'Badges', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

// ---------------------------------------------------------------- consumption methods guide

function pageMethods(req, res) {
  const body = `
    <h1 class="screen-title">Ways to Enjoy It</h1>
    <p class="screen-sub">Every ingestion method, with realistic onset and duration windows.</p>
    ${mock.methodGuide.map(m => `
      <div class="method-guide-card">
        <div class="mgtitle">${m.icon} ${esc(m.name)}</div>
        <div class="mgstats"><span>Onset: ${esc(m.onset)}</span><span>Lasts: ${esc(m.duration)}</span></div>
        <div class="mgdesc">${esc(m.desc)}</div>
      </div>`).join('')}
  `;
  sendHtml(res, layout({ title: 'Ways to Enjoy It', active: 'more', body, isAdmin: auth.isAdmin(req) }));
}

function serveStatic(req, res, pathname) {
  // The strain bud photos ended up committed under /docs (repo root) rather
  // than /public/images — rather than requiring a re-upload, serve requests
  // for /docs/* directly from that folder. Everything else still serves from
  // /public as before.
  const isDocsRequest = pathname.startsWith('/docs/');
  const baseDir = isDocsRequest ? DOCS_DIR : PUBLIC_DIR;
  const relativePath = isDocsRequest ? pathname.slice('/docs'.length) : pathname;
  const filePath = path.join(baseDir, relativePath);
  if (!filePath.startsWith(baseDir)) return notFound(res);
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- router

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && (pathname.startsWith('/icons/') || pathname.startsWith('/docs/') || ['/app.css', '/app.js', '/manifest.json', '/sw.js'].includes(pathname))) {
      return serveStatic(req, res, pathname);
    }

    // Global login wall: almost every page here is personal (check-ins,
    // collection, recommendations, follows...), so rather than gate each one
    // individually, everything requires a logged-in user except the
    // signup/login/logout routes themselves and the separate admin panel
    // (which has its own, unrelated password gate below).
    const PUBLIC_PATHS = new Set(['/signup', '/login', '/logout']);
    if (!PUBLIC_PATHS.has(pathname) && !pathname.startsWith('/admin') && auth.currentUserId(req) == null) {
      return redirect(res, '/login');
    }

    let m;
    if (method === 'GET' && pathname === '/') return pageHome(req, res);
    if (method === 'GET' && pathname === '/strains') return pageStrains(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/strains\/([^/]+)$/))) return pageStrainDetail(req, res, m[1]);
    if (method === 'GET' && pathname === '/checkin') return pageCheckinForm(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/checkin') return await handleCheckinSubmit(req, res);
    if (method === 'GET' && pathname === '/faq') return pageFaq(req, res);
    if (method === 'GET' && pathname === '/recipes') return pageRecipes(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/recipes/new') return pageRecipeNew(req, res);
    if (method === 'POST' && pathname === '/recipes/new') return await handleRecipeNewSubmit(req, res);
    if (method === 'GET' && pathname === '/growing') return pageGrowing(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/growing/new') return pageGrowingNew(req, res);
    if (method === 'POST' && pathname === '/growing/new') return await handleGrowingNewSubmit(req, res);
    if (method === 'GET' && pathname === '/chat') return pageChat(req, res);
    if (method === 'POST' && pathname === '/api/chat') return await handleChatApi(req, res);

    if (method === 'GET' && pathname === '/admin/login') return pageAdminLogin(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/admin/login') return await handleAdminLoginSubmit(req, res);
    if (method === 'GET' && pathname === '/signup') return pageSignup(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/signup') return await handleSignupSubmit(req, res);
    if (method === 'GET' && pathname === '/login') return pageLogin(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/login') return await handleLoginSubmit(req, res);
    if (method === 'POST' && pathname === '/logout') return handleLogout(req, res);
    if (method === 'GET' && pathname === '/admin/logout') return handleAdminLogout(req, res);
    if (method === 'GET' && pathname === '/admin') return pageAdminHome(req, res);
    if (method === 'GET' && pathname === '/admin/faqs') return pageAdminFaqs(req, res);
    if (method === 'POST' && pathname === '/admin/faqs/new') return await handleAdminFaqNew(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/admin\/faqs\/(\d+)\/edit$/))) return pageAdminFaqEdit(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/admin\/faqs\/(\d+)\/edit$/))) return await handleAdminFaqEditSubmit(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/admin\/faqs\/(\d+)\/delete$/))) return await handleAdminFaqDelete(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/admin/strains') return pageAdminStrains(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/admin/strains/new') return await handleAdminStrainNew(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/admin\/strains\/([^/]+)\/edit$/))) return pageAdminStrainEdit(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/strains\/([^/]+)\/edit$/))) return await handleAdminStrainEditSubmit(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/strains\/([^/]+)\/delete$/))) return await handleAdminStrainDelete(req, res, m[1]);
    if (method === 'GET' && pathname === '/admin/recipes') return pageAdminRecipes(req, res);
    if (method === 'POST' && pathname === '/admin/recipes/new') return await handleAdminRecipeNew(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/recipes\/(\d+)\/approve$/))) return await handleAdminRecipeApprove(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/admin\/recipes\/(\d+)\/delete$/))) return await handleAdminRecipeDelete(req, res, Number(m[1]));

    if (method === 'GET' && pathname === '/api/strains') return apiListStrains(req, res, url.searchParams);
    if (method === 'POST' && (m = pathname.match(/^\/api\/recipes\/(\d+)\/kudos$/))) return await apiKudos(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/api\/growtips\/(\d+)\/like$/))) return await apiGrowLike(req, res, Number(m[1]));

    if (method === 'GET' && pathname === '/more') return pageMore(req, res);
    if (method === 'GET' && pathname === '/collection') return pageCollection(req, res);
    if (method === 'GET' && pathname === '/history') return pageHistory(req, res);
    if (method === 'GET' && pathname === '/trade') return pageTrade(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/friends') return pageFriends(req, res, url.searchParams);
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/request$/))) return await handleFriendRequest(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/accept$/))) return await handleFriendAccept(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/decline$/))) return await handleFriendDecline(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/remove$/))) return await handleFriendRemove(req, res, Number(m[1]));
    if (method === 'POST' && pathname === '/trade/propose') return await handleTradePropose(req, res);
    if (method === 'GET' && pathname === '/dispensaries') return await pageDispensaries(req, res, url.searchParams);
    if (method === 'POST' && (m = pathname.match(/^\/dispensaries\/([^/]+)\/follow$/))) return await handleDispensaryFollow(req, res, m[1], url.searchParams);
    if (method === 'GET' && pathname === '/events') return pageEvents(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/events\/([^/]+)\/rsvp$/))) return await handleEventRsvp(req, res, m[1]);
    if (method === 'GET' && pathname === '/business') return pageBusiness(req, res);
    if (method === 'GET' && pathname === '/shop') return pageShop(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/shop\/([^/]+)\/add$/))) return await handleShopAdd(req, res, m[1]);
    if (method === 'GET' && pathname === '/badges') return pageBadges(req, res);
    if (method === 'GET' && pathname === '/methods') return pageMethods(req, res);

    return notFound(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error: ' + err.message);
  }
});

db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`StrainDex running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to connect to the database — check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
    console.error(err);
    process.exit(1);
  });
