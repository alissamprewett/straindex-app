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

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
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
function starString(n) { n = Number(n) || 0; return '★'.repeat(n) + '☆'.repeat(5 - n); }
function rarityLabel(r) { return { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary' }[r] || r; }

// ---------------------------------------------------------------- pages

function pageHome(req, res) {
  const faqCount = db.listFaqs().length;
  const recipeCount = db.listRecipes().length;
  const strainCount = db.countStrains();
  const growCount = db.listGrowTips().length;
  const recentCheckins = db.listCheckins({ limit: 5 });
  const body = `
    <h1 class="screen-title">Welcome back 🌿</h1>
    <p class="screen-sub">Your personal cannabis journal — strains, recipes, and growing knowledge, all in one place.</p>
    <div class="card"><b>${strainCount.toLocaleString()}</b> strains in the library · <a href="/strains">browse them →</a></div>
    <div class="card"><b>${recipeCount}</b> infused recipes · <a href="/recipes">see recipes →</a></div>
    <div class="card"><b>${growCount}</b> growing tips from the community · <a href="/growing">read them →</a></div>
    <div class="card"><b>${faqCount}</b> FAQ entries · <a href="/faq">strain school →</a></div>
    <h2 class="screen-title" style="margin-top:20px;">Recent check-ins</h2>
    ${recentCheckins.length ? recentCheckins.map(c => {
      const s = db.getStrain(c.strain_id);
      return `<div class="card"><b>${esc(s ? s.name : c.strain_id)}</b> — ${esc(c.method)} · ${starString(c.rating)}<br>
        <span class="empty-note">${esc(c.note || '')}</span></div>`;
    }).join('') : `<div class="empty-note">No check-ins logged yet.</div>`}
  `;
  sendHtml(res, layout({ title: 'Home', active: 'home', body, isAdmin: auth.isAdmin(req) }));
}

function pageStrains(req, res, query) {
  const q = query.get('q') || '';
  const type = query.get('type') || 'All';
  const rarity = query.get('rarity') || 'All';
  const total = db.countStrains({ q, type, rarity });
  const results = db.listStrains({ q, type, rarity, limit: 60 });
  const typeOpts = ['All', 'Indica', 'Sativa', 'Hybrid'];
  const rarityOpts = ['All', 'common', 'uncommon', 'rare', 'legendary'];
  const mk = (params) => '/strains?' + new URLSearchParams({ q, type, rarity, ...params }).toString();

  const body = `
    <h1 class="screen-title">Strain Library</h1>
    <p class="screen-sub">${total.toLocaleString()} strains — search the full database.</p>
    <form method="GET" action="/strains" style="margin-bottom:12px;">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search by name..." oninput="this.form.requestSubmit()">
      <input type="hidden" name="type" value="${esc(type)}">
      <input type="hidden" name="rarity" value="${esc(rarity)}">
    </form>
    <div>${typeOpts.map(t => `<a class="filter-pill ${type === t ? 'active' : ''}" href="${mk({ type: t })}">${t}</a>`).join('')}</div>
    <div style="margin-bottom:10px;">${rarityOpts.map(r => `<a class="filter-pill ${rarity === r ? 'active' : ''}" href="${mk({ rarity: r })}">${r === 'All' ? 'All rarities' : rarityLabel(r)}</a>`).join('')}</div>
    <p class="empty-note">${total > 60 ? `Showing 60 of ${total.toLocaleString()} — refine your search to narrow it down.` : `${total} strain${total === 1 ? '' : 's'}`}</p>
    ${results.map(s => `
      <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
        <span class="icon">${s.icon}</span>
        <div class="info">
          <div class="nm">${esc(s.name)}</div>
          <div class="sub">${esc(s.type)} · ${rarityLabel(s.rarity)} · THC ${esc(s.thc)}</div>
        </div>
        <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>
      </a>`).join('') || `<div class="empty-note">No strains match your filters.</div>`}
  `;
  sendHtml(res, layout({ title: 'Strains', active: 'strains', body, isAdmin: auth.isAdmin(req) }));
}

function pageStrainDetail(req, res, id) {
  const s = db.getStrain(id);
  if (!s) return notFound(res);
  const history = db.listCheckins({ strain_id: id, limit: 10 });
  const body = `
    <a href="/strains" class="empty-note">← Back to library</a>
    <div class="card" style="margin-top:10px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:34px;">${s.icon}</span>
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
        <div class="checkin-photo-thumb">${c.photo ? `<img src="${esc(c.photo)}" alt="Your photo">` : `<span class="photo-placeholder">${s.icon}</span>`}</div>
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
      ${s
        ? `<div class="card">${s.icon} <b>${esc(s.name)}</b><input type="hidden" name="strain_id" value="${s.id}"></div>`
        : `<input type="text" name="strain_name_search" placeholder="Type a strain name..." list="strain-list">
           <datalist id="strain-list">${db.listStrains({ limit: 300 }).map(x => `<option value="${esc(x.name)}" data-id="${x.id}">`).join('')}</datalist>
           <p class="empty-note">Tip: search from <a href="/strains">the Strain Library</a> and tap "Check in" on the strain page for a pre-filled form.</p>`}

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
  const fields = await parseForm(req);
  let strainId = fields.strain_id;
  if (!strainId && fields.strain_name_search) {
    const match = db.listStrains({ q: fields.strain_name_search, limit: 1 })[0];
    strainId = match && match.id;
  }
  if (!strainId) { sendHtml(res, layout({ title: 'Check In', body: `<p>Please pick a valid strain. <a href="/checkin">Try again</a></p>` }), 400); return; }
  let effects = Array.isArray(fields.effects) ? fields.effects : (fields.effects ? [fields.effects] : []);
  effects = effects.filter(Boolean).slice(0, 5);
  if (effects.length < 1) {
    sendHtml(res, layout({ title: 'Check In', body: `<p>Please pick at least 1 mood/effect. <a href="javascript:history.back()">Go back</a></p>` }), 400);
    return;
  }
  db.createCheckin({
    strain_id: strainId, method: fields.method, rating: Number(fields.rating) || 0,
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
        <div class="faq-a">${esc(f.answer)}</div>
      </div>`).join('') || `<div class="empty-note">No FAQ entries yet.</div>`}
    <p class="empty-note" style="margin-top:16px;">Have a question you don't see here? Ask the assistant on the <a href="/chat">Ask</a> tab.</p>
  `;
  sendHtml(res, layout({ title: 'FAQ', active: 'faq', body, isAdmin: auth.isAdmin(req) }));
}

function pageRecipes(req, res) {
  const recipes = db.listRecipes({ status: 'approved' });
  const body = `
    <h1 class="screen-title">Infused Recipes</h1>
    <a class="btn block lilac" href="/recipes/new" style="margin-bottom:14px;">✏️ Submit a Recipe</a>
    ${recipes.map(r => `
      <div class="card">
        <b>${r.icon || '🍽️'} ${esc(r.title)}</b>
        <span class="recipe-source-tag ${r.source}">${r.source === 'official' ? 'Official' : 'Community'}</span>
        <div class="empty-note">${esc(r.time || '')}${r.author ? ' · by ' + esc(r.author) : ''}</div>
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
      </div>`).join('') || `<div class="empty-note">No recipes yet.</div>`}
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
  const f = await parseForm(req);
  db.createRecipe({
    title: f.title, desc: f.desc, author: f.author, source: 'community', status: 'pending',
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
  const f = await parseForm(req);
  db.createGrowTip({ title: f.title, category: f.category, author: f.author, body: f.body });
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

function pageAdminHome(req, res) {
  if (!requireAdmin(req, res)) return;
  const pendingCount = db.listRecipes({ status: 'pending' }).length;
  const body = `
    <h1 class="screen-title">Admin</h1>
    <div class="card"><a href="/admin/faqs">📋 Manage FAQ (${db.listFaqs().length})</a></div>
    <div class="card"><a href="/admin/recipes">🍽️ Manage Recipes (${db.listRecipes({ status: null }).length}${pendingCount ? `, ${pendingCount} pending` : ''})</a></div>
    <div class="card"><a href="/strains">🃏 Strain Library (${db.countStrains().toLocaleString()}, read-only for now)</a></div>
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
        <button class="btn block" type="submit">Add FAQ</button>
      </form>
    </div>
    ${faqs.map(f => `
      <div class="admin-row" style="flex-direction:column;align-items:stretch;">
        <b>${esc(f.question)}</b>
        <p class="empty-note">${esc(f.answer)}</p>
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
  db.createFaq({ question: f.question, answer: f.answer, sort_order: db.listFaqs().length });
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
      <button class="btn block" type="submit">Save</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Edit FAQ', body, isAdmin: true }));
}
async function handleAdminFaqEditSubmit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  const current = db.getFaq(id);
  db.updateFaq(id, { question: f.question, answer: f.answer, sort_order: current ? current.sort_order : 0 });
  redirect(res, '/admin/faqs');
}
async function handleAdminFaqDelete(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.deleteFaq(id);
  redirect(res, '/admin/faqs');
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
        <span>${esc(r.title)} <span class="recipe-source-tag ${r.source}">${r.status}</span></span>
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
  db.createRecipe({
    title: f.title, desc: f.desc, dosing: f.dosing, source: 'official', status: 'approved', author: null,
    ingredients: String(f.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean),
    steps: String(f.steps || '').split('\n').map(s => s.trim()).filter(Boolean),
  });
  redirect(res, '/admin/recipes');
}
async function handleAdminRecipeApprove(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.updateRecipe(id, { status: 'approved' });
  redirect(res, '/admin/recipes');
}
async function handleAdminRecipeDelete(req, res, id) {
  if (!requireAdmin(req, res)) return;
  db.deleteRecipe(id);
  redirect(res, '/admin/recipes');
}

// ---------------------------------------------------------------- API

function apiListStrains(req, res, query) {
  const q = query.get('q') || '';
  const type = query.get('type') || 'All';
  const rarity = query.get('rarity') || 'All';
  const limit = Math.min(Number(query.get('limit')) || 60, 200);
  sendJson(res, { total: db.countStrains({ q, type, rarity }), results: db.listStrains({ q, type, rarity, limit }) });
}
function apiKudos(req, res, id) {
  const r = db.addKudos(id);
  if (!r) return sendJson(res, { error: 'not found' }, 404);
  sendJson(res, { kudos: r.kudos });
}
function apiGrowLike(req, res, id) {
  db.likeGrowTip(id);
  const tip = db.listGrowTips().find(t => t.id === id);
  sendJson(res, { likes: tip ? tip.likes : 0 });
}

// ---------------------------------------------------------------- static

function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
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

    if (method === 'GET' && (pathname.startsWith('/icons/') || ['/app.css', '/app.js', '/manifest.json', '/sw.js'].includes(pathname))) {
      return serveStatic(req, res, pathname);
    }

    let m;
    if (method === 'GET' && pathname === '/') return pageHome(req, res);
    if (method === 'GET' && pathname === '/strains') return pageStrains(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/strains\/([^/]+)$/))) return pageStrainDetail(req, res, m[1]);
    if (method === 'GET' && pathname === '/checkin') return pageCheckinForm(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/checkin') return await handleCheckinSubmit(req, res);
    if (method === 'GET' && pathname === '/faq') return pageFaq(req, res);
    if (method === 'GET' && pathname === '/recipes') return pageRecipes(req, res);
    if (method === 'GET' && pathname === '/recipes/new') return pageRecipeNew(req, res);
    if (method === 'POST' && pathname === '/recipes/new') return await handleRecipeNewSubmit(req, res);
    if (method === 'GET' && pathname === '/growing') return pageGrowing(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/growing/new') return pageGrowingNew(req, res);
    if (method === 'POST' && pathname === '/growing/new') return await handleGrowingNewSubmit(req, res);
    if (method === 'GET' && pathname === '/chat') return pageChat(req, res);
    if (method === 'POST' && pathname === '/api/chat') return await handleChatApi(req, res);

    if (method === 'GET' && pathname === '/admin/login') return pageAdminLogin(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/admin/login') return await handleAdminLoginSubmit(req, res);
    if (method === 'GET' && pathname === '/admin/logout') return handleAdminLogout(req, res);
    if (method === 'GET' && pathname === '/admin') return pageAdminHome(req, res);
    if (method === 'GET' && pathname === '/admin/faqs') return pageAdminFaqs(req, res);
    if (method === 'POST' && pathname === '/admin/faqs/new') return await handleAdminFaqNew(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/admin\/faqs\/(\d+)\/edit$/))) return pageAdminFaqEdit(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/admin\/faqs\/(\d+)\/edit$/))) return await handleAdminFaqEditSubmit(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/admin\/faqs\/(\d+)\/delete$/))) return await handleAdminFaqDelete(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/admin/recipes') return pageAdminRecipes(req, res);
    if (method === 'POST' && pathname === '/admin/recipes/new') return await handleAdminRecipeNew(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/recipes\/(\d+)\/approve$/))) return await handleAdminRecipeApprove(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/admin\/recipes\/(\d+)\/delete$/))) return await handleAdminRecipeDelete(req, res, Number(m[1]));

    if (method === 'GET' && pathname === '/api/strains') return apiListStrains(req, res, url.searchParams);
    if (method === 'POST' && (m = pathname.match(/^\/api\/recipes\/(\d+)\/kudos$/))) return apiKudos(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/api\/growtips\/(\d+)\/like$/))) return apiGrowLike(req, res, Number(m[1]));

    return notFound(res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`StrainDex running at http://localhost:${PORT}`);
});
