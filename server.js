// server.js — the whole app. Plain Node `http`, no framework, no build step.
// Run: node server.js   (or PORT=4000 node server.js)
//
// Why no Express/Next.js here: this project was built in a sandboxed
// environment with no access to the npm registry, so everything below uses
// only Node's built-ins. It's a deliberate, testable-today choice — but
// nothing about the *architecture* (routes, db.js data layer, server-rendered
// HTML) requires staying dependency-free once you deploy somewhere with
// normal internet access. See README.md for the upgrade path.

const Sentry = require('./instrument');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { layout, esc } = require('./lib/render');
const { parseForm, parseJson } = require('./lib/body');
const { answerFromKnowledgeBase } = require('./lib/chat');
const mock = require('./lib/mockdata');
const geo = require('./lib/geodispensaries');
const storage = require('./lib/storage');

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------- basic signup rate limiting
// A simple in-memory per-IP throttle -- not bulletproof (resets on
// restart, doesn't help behind a shared IP like a school or office), but
// stops the easy case: a bot or script hammering /signup. Max 5 signup
// attempts per IP per 15 minutes.
const signupAttempts = new Map(); // ip -> array of timestamps (ms)
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_MAX_ATTEMPTS = 5;
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function isSignupRateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const attempts = (signupAttempts.get(ip) || []).filter(t => now - t < SIGNUP_WINDOW_MS);
  attempts.push(now);
  signupAttempts.set(ip, attempts);
  return attempts.length > SIGNUP_MAX_ATTEMPTS;
}

// ---------------------------------------------------------------- basic login rate limiting
// Keyed by IP + username (not just IP) so it specifically slows down
// brute-forcing one account's password, without penalizing everyone on a
// shared network (school, office) for one person's typos. Only failed
// attempts count -- a successful login clears the counter. Max 5 failed
// attempts per 15 minutes per IP+username combination.
const loginAttempts = new Map(); // "ip:username" -> array of failed-attempt timestamps
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
function loginAttemptKey(req, username) {
  return `${clientIp(req)}:${String(username || '').trim().toLowerCase()}`;
}
function isLoginRateLimited(req, username) {
  const key = loginAttemptKey(req, username);
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  return attempts.length >= LOGIN_MAX_ATTEMPTS;
}
function recordFailedLogin(req, username) {
  const key = loginAttemptKey(req, username);
  const now = Date.now();
  const attempts = (loginAttempts.get(key) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  attempts.push(now);
  loginAttempts.set(key, attempts);
}
function clearLoginAttempts(req, username) {
  loginAttempts.delete(loginAttemptKey(req, username));
}
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
// Sends a plain-text/HTML email via the Resend API (https://resend.com).
// Uses Node's built-in fetch (no extra dependency). Sends from Resend's
// no-setup test address until a verified custom domain is added -- swap
// RESEND_FROM to something like 'StrainDex <noreply@yourdomain.com>'
// once a domain is verified in the Resend dashboard.
const RESEND_FROM = process.env.RESEND_FROM || 'StrainDex <onboarding@resend.dev>';
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.error('[email] RESEND_API_KEY is not set — cannot send email.');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.error('[email] Resend API error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[email] Failed to send:', err);
    return false;
  }
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
// A real, monitored contact point beyond the feedback form -- for
// anything urgent (account issues, a bad actor, a safety/legal concern)
// that shouldn't sit in a general feedback queue. Using a Gmail "+" alias
// off Alissa's existing address is the zero-setup option: no new inbox to
// check, mail still lands in the same account, and it's easy to filter or
// swap for a real support@ address later if a custom domain gets set up.
const SUPPORT_EMAIL = 'straindex420@gmail.com';
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
// Shared renderer for the optional "pairings" a user can log with a
// check-in -- tasting notes plus food/drink, music/entertainment, and
// activity pairings. Each is independently optional, so only show what's
// actually filled in.
function renderCheckinPairings(c) {
  return `
    ${c.is_private ? `<div class="empty-note" style="padding:4px 0 0;font-weight:700;">🔒 Private — only visible to you</div>` : ''}
    ${c.tasting_notes ? `<div class="empty-note" style="padding:4px 0 0;">🍃 Tasting notes: ${esc(c.tasting_notes)}</div>` : ''}
    ${c.pairing_food ? `<div class="empty-note" style="padding:2px 0 0;">🍽️ Paired with: ${esc(c.pairing_food)}</div>` : ''}
    ${c.pairing_entertainment ? `<div class="empty-note" style="padding:2px 0 0;">🎵 Listening/watching: ${esc(c.pairing_entertainment)}</div>` : ''}
    ${c.pairing_activity ? `<div class="empty-note" style="padding:2px 0 0;">🎯 Doing: ${esc(c.pairing_activity)}</div>` : ''}
  `;
}
// Shows a live "started Xh Ym ago" onset reminder under any check-in logged
// with an edible method, filled in client-side (see initOnsetTimers in
// app.js) so it stays accurate without a page refresh.
function renderOnsetTimer(c) {
  const edibleMethods = METHOD_GROUPS.find(g => g.group === 'Edibles').items;
  if (!edibleMethods.includes(c.method)) return '';
  return `<div class="onset-timer empty-note" style="padding:4px 0 0;" data-utc="${c.created_at}Z">⏱ Calculating onset time…</div>`;
}
// A lightweight comment thread under a check-in, alongside the existing
// kudos button. redirectPath tells the plain-HTML-form submit where to
// bounce back to, since the same check-in can appear on the Home feed,
// a strain's own page, or a friend's profile.
// Short "who gave kudos" label shown under the kudos button -- up to 3
// names, then "and N more" for anything beyond that.
function kudosGiversLabel(checkinId) {
  const givers = db.listCheckinKudosGivers(checkinId);
  if (!givers.length) return '';
  const names = givers.slice(0, 3).map(u => esc(u.username));
  const extra = givers.length - names.length;
  return `<div class="empty-note kudos-givers-label" style="padding:2px 0 0;text-align:right;">🌿 ${names.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}</div>`;
}
// The kudos button itself -- reflects whether the current viewer has
// already given kudos on page load (not just after clicking), and is
// styled/labeled differently in each state so a toggle-off feels
// intentional rather than like the button just broke.
function renderKudosButton(c, userId) {
  const given = db.hasUserGivenKudos(c.id, userId);
  return `<button class="kudos-btn${given ? ' kudos-given' : ''}" id="kudos-btn-${c.id}" data-given="${given}" onclick="giveCheckinKudos(${c.id}, this)">${KUDOS_BUD_ICON}${given ? 'Kudos given' : 'Kudos'}${c.kudos ? ` (${c.kudos})` : ''}</button>`;
}
function renderCheckinComments(c, userId, redirectPath) {
  const comments = db.listCheckinComments(c.id, userId);
  return `
    ${comments.length ? `<div style="margin-top:8px;">${comments.map(cm => {
      const author = db.getUserById(cm.user_id);
      const canModerate = userId != null && cm.user_id !== userId;
      return `<div class="empty-note" style="padding:3px 0;">
        <b>${esc(author ? author.username : 'Someone')}:</b> ${esc(cm.body)}
        ${userId != null ? `
          <button type="button" id="comment-like-${cm.id}" onclick="likeComment(${cm.id}, this)" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:${cm.likedByMe ? 'none' : 'underline'};cursor:pointer;font-size:inherit;">
            ${cm.likedByMe ? '💚 Liked' : '🤍 Like'}${cm.likeCount ? ` (${cm.likeCount})` : ''}
          </button>
        ` : (cm.likeCount ? `<span style="margin-left:6px;">💚 ${cm.likeCount}</span>` : '')}
        ${canModerate ? `
          <form method="POST" action="/report" style="display:inline;" onsubmit="return confirm('Report this comment for review?')">
            <input type="hidden" name="content_type" value="checkin_comment">
            <input type="hidden" name="content_id" value="${cm.id}">
            <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
            <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Report</button>
          </form>
          <form method="POST" action="/block/${cm.user_id}" style="display:inline;" onsubmit="return confirm('Block ' + ${JSON.stringify(author ? author.username : 'this person')} + '? You will no longer see their comments, check-ins, or grow tips, and any friendship will end.')">
            <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
            <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Block</button>
          </form>
        ` : ''}
      </div>`;
    }).join('')}</div>` : ''}
    ${userId != null ? `
      <form method="POST" action="/checkin/${c.id}/comment" style="display:flex;gap:6px;margin-top:6px;">
        <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
        <input type="text" name="body" placeholder="Add a comment..." required style="flex:1;margin:0;">
        <button class="btn secondary" type="submit" style="padding:6px 12px;">Post</button>
      </form>
    ` : ''}
  `;
}
// A small original cartoon-bud icon used on kudos buttons — hand-drawn SVG,
// not a stock asset, so there's no licensing question about using it.
function rarityLabel(r) { return { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', legendary: 'Legendary' }[r] || r; }
// A small original cartoon-bud icon used on kudos buttons — hand-drawn SVG,
// not a stock asset, so there's no licensing question about using it.
const KUDOS_BUD_ICON = `<img src="/docs/leaf-kudos.png" alt="" width="15" height="15" style="vertical-align:-3px;margin-right:4px;">`;

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
  '/docs/avery-meeker.jpg',
  '/docs/esteban-lopez.jpg',
  '/docs/esteban-lopez2.jpg',
  '/docs/tim-foster.jpg',
  '/docs/jeff-w.jpg',
  '/docs/testeur-de-cbd.jpg',
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

// ---------------------------------------------------------------- pages

// ---------------------------------------------------------------- public landing page
// Shown at "/" to anyone not logged in -- previously an unauthenticated
// visit to "/" just bounced straight to /login with no context on what
// StrainDex even is. This gives it a real front door.
function pageLandingPage(req, res) {
  const totalStrains = db.countStrains();
  const body = `
    <div style="text-align:center;padding:20px 4px 8px;">
      <div style="font-size:44px;margin-bottom:8px;">🌿</div>
      <h1 style="margin:0 0 8px;font-size:22px;">StrainDex</h1>
      <p class="screen-sub" style="margin:0 0 20px;">Your personal cannabis companion — track what you actually experience, stay informed on dosing and safety, discover your next favorite strain, and compare notes with real friends. All in one place.</p>
      <a href="/signup" class="btn block" style="text-decoration:none;max-width:280px;margin:0 auto;">Create Free Account</a>
      <p class="empty-note" style="margin-top:10px;">Already have an account? <a href="/login">Log in</a></p>
      <p class="empty-note" style="margin-top:4px;">Beta · For adults 21+ where legal · Not medical advice</p>
    </div>

    <div class="more-grid" style="margin-top:8px;">
      <div class="more-tile">
        <span class="ic">📇</span>
        <div class="t">Strain Library</div>
        <div class="s">${totalStrains.toLocaleString()}+ strains with real THC data</div>
      </div>
      <div class="more-tile">
        <span class="ic">🔥</span>
        <div class="t">Check-Ins</div>
        <div class="s">Tasting notes, pairings &amp; ratings</div>
      </div>
      <div class="more-tile">
        <span class="ic">🧭</span>
        <div class="t">Discover</div>
        <div class="s">A strain quiz, trending picks &amp; friend recommendations</div>
      </div>
      <div class="more-tile">
        <span class="ic">⚖️</span>
        <div class="t">Stay Informed</div>
        <div class="s">Dosing math, legal status &amp; safety cautions</div>
      </div>
      <div class="more-tile">
        <span class="ic">🍯</span>
        <div class="t">Recipes</div>
        <div class="s">Infusions, edibles &amp; scalable dosing</div>
      </div>
      <div class="more-tile">
        <span class="ic">📍</span>
        <div class="t">Dispensaries</div>
        <div class="s">Find real dispensaries near you</div>
      </div>
    </div>

    <div class="card" style="margin-top:20px;text-align:center;">
      <p class="empty-note" style="padding:0 0 10px;">Already checking in with friends? See what StrainDex looks like inside.</p>
      <a href="/signup" class="btn secondary block" style="text-decoration:none;">Get Started →</a>
    </div>
  `;
  sendHtml(res, layout({ title: 'StrainDex', body, isAdmin: false }));
}

function pageHome(req, res) {
  const userId = auth.currentUserId(req);
  if (userId == null) return pageLandingPage(req, res);
  const friends = db.listFriends(userId);
  const feedUserIds = [userId, ...friends.map(f => f.id)];
  const userNames = new Map([[userId, 'You'], ...friends.map(f => [f.id, f.username])]);
  const recentCheckins = db.filterVisibleCheckins(db.listCheckins({ userIds: feedUserIds, limit: 30 }), userId).slice(0, 15);
  const recs = getRecommendations(userId, 4);
  const hasFollowedDispensaries = db.anyDispensaryFollowed(userId);

  const body = `
    <h1 class="screen-title">Welcome back 🌿</h1>
    <p class="screen-sub">Your personal cannabis companion — check-ins, discovery, safety info, and your friends, all in one place.</p>
    <a class="btn block" href="/checkin" style="margin-bottom:18px;">🌿 Light Up</a>

    <div class="section-label">Recommended for you</div>
    <div class="hcarousel">
      ${recs.map(r => `
        <a class="rec-card rarity-${r.s.rarity}" href="/strains/${r.s.id}">
          ${strainPhotoTag(r.s, 'sm')}
          <span class="n">${esc(r.s.name)}</span>
          <span class="why">${r.why ? 'Because you like ' + esc(r.why) : 'New for you'}</span>
        </a>`).join('')}
    </div>

    <div class="section-label">Dispensaries</div>
    <a class="btn secondary block" href="/dispensaries" style="text-decoration:none;margin-bottom:4px;">${hasFollowedDispensaries ? '📍 View your followed dispensaries →' : '📍 Find real dispensaries near you →'}</a>

    <h2 class="screen-title" style="margin-top:20px;">${friends.length ? 'Recent activity' : 'Recent check-ins'}</h2>
    ${friends.length && recentCheckins.every(c => c.user_id === userId) ? `<p class="empty-note">None of your friends have checked in yet — once they do, it'll show up here too.</p>` : ''}
    ${recentCheckins.length ? recentCheckins.map(c => {
      const s = db.getStrain(c.strain_id);
      const posterName = userNames.get(c.user_id) || 'Someone';
      const isMine = c.user_id === userId;
      return `<div class="feed-post">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          ${friends.length ? `<div class="empty-note" style="padding:0;font-weight:${isMine ? 'normal' : '700'};">${isMine ? 'You' : `<a href="/friends/${c.user_id}" style="color:inherit;">${esc(posterName)}</a>`}</div>` : '<div></div>'}
          ${isMine ? `<a href="/checkin/${c.id}/edit" class="empty-note" style="padding:0;">Edit</a>` : ''}
        </div>
        <a class="strain-chip" href="/strains/${c.strain_id}">
          ${strainPhotoTag(s, 'xs')}
          <span><b>${esc(s ? s.name : c.strain_id)}</b> ${s ? `<span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>` : ''}</span>
        </a>
        <div class="sub" style="margin-top:8px;">${esc(c.method)} · ${starString(c.rating)}</div>
        ${c.photo ? `<img class="photo-thumb" src="${esc(c.photo)}" alt="photo">` : ''}
        ${(c.effects || []).length ? `<div class="effect-tags">${c.effects.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
        ${c.note ? `<div class="note">"${esc(c.note)}"</div>` : ''}
        ${renderCheckinPairings(c)}
        ${renderOnsetTimer(c)}
        ${renderCheckinComments(c, userId, '/')}
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-top:8px;">
          ${renderKudosButton(c, userId)}
          ${kudosGiversLabel(c.id)}
        </div>
      </div>`;
    }).join('') : `<div class="empty-note">No check-ins logged yet — <a href="/checkin">log your first one</a> to get your feed started.</div>`}
  `;
  sendHtml(res, layout({ title: 'Home', active: 'home', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageStrains(req, res, query) {
  const q = query.get('q') || '';
  const type = query.get('type') || 'All';
  const rarity = query.get('rarity') || 'All';
  const effect = query.get('effect') || 'All';
  const thc = query.get('thc') || 'All';
  const terpene = query.get('terpene') || 'All';
  const ailment = query.get('ailment') || 'All';
  const breeder = query.get('breeder') || 'All';
  const verified = query.get('verified') || 'All';
  const total = db.countStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder, verified });
  const results = db.listStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder, verified, limit: 60 });
  const typeOpts = ['All', 'Indica', 'Sativa', 'Hybrid'];
  const rarityOpts = ['All', 'common', 'uncommon', 'rare', 'legendary'];
  const effectOpts = ['All', 'Happy', 'Relaxed', 'Euphoric', 'Uplifted', 'Sleepy', 'Energetic', 'Creative', 'Focused', 'Hungry', 'Talkative', 'Calm', 'Social'];
  const thcOpts = ['All', 'Low', 'Medium', 'High'];
  const terpeneOpts = ['All', 'Myrcene', 'Limonene', 'Caryophyllene', 'Pinene', 'Linalool', 'Terpinolene', 'Humulene', 'Ocimene'];
  const ailmentOpts = ['All', 'Stress', 'Pain', 'Depression', 'Insomnia', 'Lack of Appetite', 'Nausea', 'Inflammation', 'Muscle Spasms', 'Seizures'];
  const verifiedOpts = ['All', 'verified', 'partial', 'listed'];
  const verifiedLabel = { All: 'Any data quality', verified: '✅ Verified', partial: '🔹 Partially verified', listed: '⚪ Listed only' };
  const thcLabel = { All: 'Any THC', Low: 'Low (≤15%)', Medium: 'Medium (15–25%)', High: 'High (25%+)' };
  const mk = (params) => '/strains?' + new URLSearchParams({ q, type, rarity, effect, thc, terpene, ailment, ...params }).toString();

  const body = `
    <h1 class="screen-title">Strain Library</h1>
    <p class="screen-sub">${total.toLocaleString()} strains — search by name, flavor, effect, THC level, terpene, or relief.</p>
    <form method="GET" action="/strains" id="strain-search-form" style="margin-bottom:12px;">
      <input type="search" name="q" id="strain-search-input" value="${esc(q)}" placeholder="Search by name or flavor..." autocomplete="off">
    </form>
    <div class="filter-grid">
      <div class="filter-group">
        <div class="section-label" style="margin-bottom:4px;">Type</div>
        <select id="strain-search-type" name="type" form="strain-search-form">${typeOpts.map(t => `<option value="${esc(t)}" ${type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </div>
      <div class="filter-group">
        <div class="section-label" style="margin-bottom:4px;">Rarity</div>
        <select id="strain-search-rarity" name="rarity" form="strain-search-form">${rarityOpts.map(r => `<option value="${esc(r)}" ${rarity === r ? 'selected' : ''}>${r === 'All' ? 'All rarities' : rarityLabel(r)}</option>`).join('')}</select>
      </div>
      <div class="filter-group">
        <div class="section-label" style="margin-bottom:4px;">THC level</div>
        <select id="strain-search-thc" name="thc" form="strain-search-form">${thcOpts.map(t => `<option value="${esc(t)}" ${thc === t ? 'selected' : ''}>${thcLabel[t]}</option>`).join('')}</select>
      </div>
      <div class="filter-group">
        <div class="section-label" style="margin-bottom:4px;">Feeling like...</div>
        <select id="strain-search-effect" name="effect" form="strain-search-form">${effectOpts.map(e => `<option value="${esc(e)}" ${effect === e ? 'selected' : ''}>${e === 'All' ? 'Any effect' : e}</option>`).join('')}</select>
      </div>
      <div class="filter-group">
        <div class="section-label" style="margin-bottom:4px;">Dominant terpene</div>
        <select id="strain-search-terpene" name="terpene" form="strain-search-form">${terpeneOpts.map(t => `<option value="${esc(t)}" ${terpene === t ? 'selected' : ''}>${t === 'All' ? 'Any terpene' : t}</option>`).join('')}</select>
      </div>
      <div class="filter-group">
        <div class="section-label" style="margin-bottom:4px;">Relief from...</div>
        <select id="strain-search-ailment" name="ailment" form="strain-search-form">${ailmentOpts.map(a => `<option value="${esc(a)}" ${ailment === a ? 'selected' : ''}>${a === 'All' ? 'Anything' : a}</option>`).join('')}</select>
      </div>
      <div class="filter-group">
        <div class="section-label" style="margin-bottom:4px;">Data quality</div>
        <select id="strain-search-verified" name="verified" form="strain-search-form">${verifiedOpts.map(v => `<option value="${esc(v)}" ${verified === v ? 'selected' : ''}>${verifiedLabel[v]}</option>`).join('')}</select>
      </div>
    </div>
    <p class="empty-note" style="margin-bottom:2px;">✅ Verified — THC, breeder, and flavor/terpene data all independently confirmed. &nbsp; 🔹 Partial — some details confirmed. &nbsp; ⚪ Listed only — seen on a dispensary menu, nothing independently confirmed yet.</p>
    <p class="empty-note" style="margin-bottom:10px;">User-reported associations, not medical advice — see a doctor for real guidance.</p>
    <p class="empty-note" id="strain-search-count">${total > 60 ? `Showing 60 of ${total.toLocaleString()} — refine your search to narrow it down.` : `${total} strain${total === 1 ? '' : 's'}`}</p>
    <div id="strain-search-results">${results.map(s => `
      <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(s, 'sm')}
        <div class="info">
          <div class="nm">${esc(s.name)} <span title="${esc(VERIFICATION_BADGE[strainVerificationTier(s)].label)}">${VERIFICATION_BADGE[strainVerificationTier(s)].icon}</span></div>
          <div class="sub">${esc(s.type)} · ${rarityLabel(s.rarity)} · THC ${esc(s.thc)}</div>
        </div>
        <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>
      </a>`).join('') || `<div class="empty-note">No strains match your filters.</div>`}</div>
  `;
  sendHtml(res, layout({ title: 'Strains', active: 'strains', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Verification tier is computed live from how complete a strain's actual
// data is, rather than a manually-set flag -- this stays honest and
// automatically accurate as more research gets added, without requiring
// anyone to remember which strains were personally verified versus not.
function strainVerificationTier(s) {
  const hasThc = !!s.thc;
  const hasBreeder = !!s.breeder;
  const hasDetail = !!s.flavor || (Array.isArray(s.terps) && s.terps.length > 0);
  const score = [hasThc, hasBreeder, hasDetail].filter(Boolean).length;
  if (score === 3) return 'verified';
  if (score >= 1) return 'partial';
  return 'listed';
}
const VERIFICATION_BADGE = {
  verified: { icon: '✅', label: 'Verified', note: 'THC, breeder, and flavor/terpene data all independently confirmed.' },
  partial: { icon: '🔹', label: 'Partially verified', note: 'Some details confirmed; the rest wasn\u2019t independently found.' },
  listed: { icon: '⚪', label: 'Listed only', note: 'Seen on a dispensary menu, but no independent data was found for it.' },
};
function findStrainByName(name) {
  const target = name.toLowerCase();
  return db.listStrains({ limit: 5000 }).find(s => s.name.toLowerCase() === target) || null;
}
// Renders parents (linked where the strain exists in the library, plain
// text otherwise), siblings (other strains sharing at least one parent),
// and descendants (other strains that list this strain as a parent). Only
// strains with confirmed, uncontested lineage from research have a
// `parents` field at all -- most of the library has none, and this
// section simply doesn't render for those, rather than guessing at a
// family tree that was never actually verified.
function renderFamilyTree(s) {
  const allStrains = db.listStrains({ limit: 5000 });
  const parents = Array.isArray(s.parents) ? s.parents : [];
  const descendants = allStrains.filter(o => Array.isArray(o.parents) && o.parents.some(p => p.toLowerCase() === s.name.toLowerCase()));
  const siblings = parents.length
    ? allStrains.filter(o => o.id !== s.id && Array.isArray(o.parents) &&
        o.parents.some(p => parents.some(myP => myP.toLowerCase() === p.toLowerCase())))
    : [];
  if (!parents.length && !descendants.length && !siblings.length) return '';
  const renderName = (name) => {
    const match = findStrainByName(name);
    return match ? `<a href="/strains/${match.id}">${esc(name)}</a>` : esc(name);
  };
  const renderStrainLink = (o) => `<a href="/strains/${o.id}">${esc(o.name)}</a>`;
  return `
    <div class="card" style="margin-top:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">🌳 Family Tree</h2>
      ${parents.length ? `<p style="margin:2px 0;"><b>Parents:</b> ${parents.map(renderName).join(' × ')}</p>` : ''}
      ${siblings.length ? `<p style="margin:2px 0;"><b>Shares a parent with:</b> ${siblings.slice(0, 8).map(renderStrainLink).join(', ')}</p>` : ''}
      ${descendants.length ? `<p style="margin:2px 0;"><b>Parent of:</b> ${descendants.map(renderStrainLink).join(', ')}</p>` : ''}
    </div>
  `;
}
function pageStrainDetail(req, res, id) {
  const s = db.getStrain(id);
  if (!s) return notFound(res);
  const userId = auth.currentUserId(req);
  const history = db.listCheckins({ userId, strain_id: id, limit: 10 });
  const ratingStats = db.getStrainRatingStats(id);
  const similar = db.getSimilarStrains(s, 4);
  const body = `
    <a href="/strains" class="empty-note">← Back to library</a>
    <div class="card" style="margin-top:10px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${strainPhotoTag(s, 'lg')}
        <div>
          <h1 style="margin:0;font-size:19px;">${esc(s.name)}</h1>
          <div class="empty-note" style="padding:0;">${esc(s.type)}${s.lean ? ' · ' + esc(s.lean) : ''} · <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span></div>
          <div style="margin-top:2px;" title="${esc(VERIFICATION_BADGE[strainVerificationTier(s)].note)}"><span class="empty-note" style="padding:0;">${VERIFICATION_BADGE[strainVerificationTier(s)].icon} ${VERIFICATION_BADGE[strainVerificationTier(s)].label}</span></div>
          ${ratingStats.count ? `<div style="margin-top:2px;">${starString(Math.round(ratingStats.avg))} <span class="empty-note" style="padding:0;">${ratingStats.avg}★ from ${ratingStats.count} check-in${ratingStats.count === 1 ? '' : 's'}</span></div>` : `<div class="empty-note" style="padding:2px 0 0;">No community ratings yet — be the first to check in.</div>`}
        </div>
      </div>
      ${(s.thc || s.cbd) ? `<p style="margin:12px 0 4px;">${s.thc ? `<b>THC:</b> ${esc(s.thc)}` : ''}${s.thc && s.cbd ? ' &nbsp; ' : ''}${s.cbd ? `<b>CBD:</b> ${esc(s.cbd)}` : ''}</p>` : `<p class="empty-note" style="padding:0 0 4px;">No verified THC/CBD data for this strain yet.</p>`}
      ${s.breeder ? `<p class="empty-note" style="padding:0;"><b>Bred by:</b> ${esc(s.breeder)}</p>` : ''}
      ${s.flavor ? `<p style="font-style:italic;color:var(--ink-secondary);">"${esc(s.flavor)}"</p>` : ''}
      <p>${s.effects.map(e => `<span class="filter-pill">${esc(e)}</span>`).join('')}</p>
      ${s.terps.length ? `<p><b>Top terpenes:</b> ${s.terps.map(t => `${esc(t.n)} (${Math.round(t.p * 100)}%)`).join(', ')}</p>` : ''}
      ${Array.isArray(s.ailments) && s.ailments.length ? `
        <p style="margin:10px 0 2px;"><b>Users report relief from:</b> ${s.ailments.map(a => `<span class="filter-pill">${esc(a)}</span>`).join(' ')}</p>
        <p class="empty-note" style="padding:0;">User-reported, not medical advice — see a doctor for real guidance.</p>
      ` : ''}
    </div>
    ${renderFamilyTree(s)}
    <a class="btn block" href="/checkin?strain=${s.id}">＋ Check in this strain</a>
    <a class="btn secondary block" href="/compare?a=${s.id}" style="margin-top:8px;">⚖️ Compare this strain</a>
    ${userId != null && db.listFriends(userId).length ? `
      <form method="POST" action="/strains/${s.id}/share" style="display:flex;gap:8px;margin-top:8px;">
        <select name="friend_id" style="flex:1;">
          ${db.listFriends(userId).map(f => `<option value="${f.id}">${esc(f.username)}</option>`).join('')}
        </select>
        <button class="btn secondary" type="submit">🌿 Share</button>
      </form>
    ` : ''}
    ${userId != null ? `
      <form method="POST" action="/wishlist/${s.id}/toggle" style="margin-top:8px;">
        <input type="hidden" name="redirect_to" value="/strains/${s.id}">
        <button type="submit" class="btn secondary block">${db.isInWishlist(userId, s.id) ? '★ Remove from Wishlist' : '☆ Add to Wishlist'}</button>
      </form>
      ${(() => {
        const myLists = db.listCustomLists(userId);
        return myLists.length ? `
          <div class="card" style="margin-top:8px;">
            <b style="font-size:13px;">Add to a list</b>
            <p style="margin:6px 0 0;display:flex;flex-wrap:wrap;gap:6px;">
              ${myLists.map(l => `
                <form method="POST" action="/lists/${l.id}/items/${s.id}/toggle" style="display:inline;">
                  <input type="hidden" name="redirect_to" value="/strains/${s.id}">
                  <button type="submit" class="filter-pill ${db.isStrainInList(l.id, s.id) ? 'active' : ''}" style="border:none;cursor:pointer;">${db.isStrainInList(l.id, s.id) ? '✓ ' : '+ '}${esc(l.name)}</button>
                </form>
              `).join('')}
            </p>
            <p class="empty-note" style="padding:6px 0 0;"><a href="/lists">Manage your lists →</a></p>
          </div>
        ` : `<p class="empty-note" style="margin-top:8px;"><a href="/lists">Create a list</a> to organize strains your own way.</p>`;
      })()}
    ` : ''}
    ${similar.length ? `
      <h2 class="screen-title" style="margin-top:20px;">If you like this, try...</h2>
      <div class="hcarousel">
        ${similar.map(r => `
          <a class="rec-card rarity-${r.s.rarity}" href="/strains/${r.s.id}">
            ${strainPhotoTag(r.s, 'sm')}
            <span class="n">${esc(r.s.name)}</span>
            <span class="why">${r.why ? 'Shares ' + esc(r.why) : 'Similar profile'}</span>
          </a>`).join('')}
      </div>
    ` : ''}
    <h2 class="screen-title" style="margin-top:20px;">Your history with this strain</h2>
    ${history.length ? `
      <p class="empty-note">Last had: <span class="local-time" data-utc="${history[0].created_at}Z">${esc(history[0].created_at)} UTC</span></p>
      ${history.map(c => `<div class="card checkin-history-row">
        ${c.photo ? `<div class="checkin-photo-thumb"><img src="${esc(c.photo)}" alt="Your photo"></div>` : ''}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;">
            <b>${esc(c.method)}</b>
            <a href="/checkin/${c.id}/edit" class="empty-note" style="padding:0;">Edit</a>
          </div>
          ${starString(c.rating)}
          <div class="empty-note" style="padding:2px 0 0;"><span class="local-time" data-utc="${c.created_at}Z">${esc(c.created_at)} UTC</span></div>
          ${(c.effects || []).length ? `<p style="margin:6px 0 0;">${c.effects.map(e => `<span class="filter-pill">${esc(e)}</span>`).join('')}</p>` : ''}
          ${c.note ? `<span class="empty-note" style="display:block;padding:4px 0 0;">${esc(c.note)}</span>` : ''}
        ${renderCheckinPairings(c)}
        ${renderOnsetTimer(c)}
        ${renderCheckinComments(c, userId, '/strains/' + s.id)}
          <div style="display:flex;flex-direction:column;align-items:flex-end;margin-top:6px;">
            ${renderKudosButton(c, userId)}
            ${kudosGiversLabel(c.id)}
          </div>
        </div>
      </div>`).join('')}
    ` : `<div class="empty-note">You haven't checked this one in yet.</div>`}
  `;
  sendHtml(res, layout({ title: s.name, active: 'strains', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
// Cannabis legal status by US state/territory. Categories:
//   'recreational' -- adults 21+ can legally purchase/possess without a medical card
//   'medical'      -- legal only for registered patients with qualifying conditions
//   'cbd_only'     -- legal only for very low-THC / high-CBD products, not full medical
//   'illegal'      -- no legal program of any kind (may still have decriminalization,
//                     noted individually where that's true)
// IMPORTANT: this changes often -- ballot measures, legislatures, and court rulings
// shift a state's status with little notice. LEGAL_STATUS_LAST_VERIFIED should be
// updated whenever this list is rechecked against current sources, and the page
// itself carries a strong "verify locally" disclaimer rather than presenting this
// as a legal guarantee. Marijuana remains illegal under federal law everywhere in
// the US regardless of state status.
const LEGAL_STATUS_LAST_VERIFIED = '2026-06-01';
const LEGAL_STATUS = [
  { state: 'Alabama', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Alaska', status: 'recreational', note: 'Adult-use legal since 2015; licensed retail available.' },
  { state: 'Arizona', status: 'recreational', note: 'Adult-use legal since 2020.' },
  { state: 'Arkansas', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'California', status: 'recreational', note: 'Adult-use legal since 2016.' },
  { state: 'Colorado', status: 'recreational', note: 'One of the first two adult-use states, legal since 2012.' },
  { state: 'Connecticut', status: 'recreational', note: 'Adult-use legal since 2021.' },
  { state: 'Delaware', status: 'recreational', note: 'Adult-use legal since 2023.' },
  { state: 'Florida', status: 'medical', note: 'Medical program only; a 2024 recreational ballot measure fell short of the required supermajority.' },
  { state: 'Georgia', status: 'cbd_only', note: 'Low-THC medical program only, not full-plant medical or recreational.' },
  { state: 'Hawaii', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Idaho', status: 'illegal', note: 'No legal program of any kind, medical or recreational.' },
  { state: 'Illinois', status: 'recreational', note: 'Adult-use legal since 2020.' },
  { state: 'Indiana', status: 'cbd_only', note: 'Low-THC CBD products only; no medical or recreational program.' },
  { state: 'Iowa', status: 'cbd_only', note: 'Very restrictive low-THC medical program only.' },
  { state: 'Kansas', status: 'illegal', note: 'No legal program of any kind, medical or recreational.' },
  { state: 'Kentucky', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Louisiana', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Maine', status: 'recreational', note: 'Adult-use legal since 2016.' },
  { state: 'Maryland', status: 'recreational', note: 'Adult-use legal since 2022.' },
  { state: 'Massachusetts', status: 'recreational', note: 'Adult-use legal since 2016.' },
  { state: 'Michigan', status: 'recreational', note: 'Adult-use legal since 2018.' },
  { state: 'Minnesota', status: 'recreational', note: 'Adult-use legal since 2023.' },
  { state: 'Mississippi', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Missouri', status: 'recreational', note: 'Adult-use legal since 2022.' },
  { state: 'Montana', status: 'recreational', note: 'Adult-use legal since 2020.' },
  { state: 'Nebraska', status: 'medical', note: 'Medical program approved by voters; implementation has faced legal challenges, so confirm current availability locally.' },
  { state: 'Nevada', status: 'recreational', note: 'Adult-use legal since 2016.' },
  { state: 'New Hampshire', status: 'medical', note: 'Medical program only; recreational proposals have repeatedly failed to pass.' },
  { state: 'New Jersey', status: 'recreational', note: 'Adult-use legal since 2020; among the higher possession limits nationally.' },
  { state: 'New Mexico', status: 'recreational', note: 'Adult-use legal since 2021.' },
  { state: 'New York', status: 'recreational', note: 'Adult-use legal since 2021.' },
  { state: 'North Carolina', status: 'illegal', note: 'No medical or recreational program, though small possession has been decriminalized to a civil fine since 1977.' },
  { state: 'North Dakota', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Ohio', status: 'recreational', note: 'Adult-use legal since 2023; retail sales began in 2024.' },
  { state: 'Oklahoma', status: 'medical', note: 'Broad medical program with relatively accessible qualifying conditions; no recreational sales.' },
  { state: 'Oregon', status: 'recreational', note: 'Adult-use legal since 2014.' },
  { state: 'Pennsylvania', status: 'medical', note: 'Medical program only; often cited as the most likely next state to pursue recreational legalization.' },
  { state: 'Rhode Island', status: 'recreational', note: 'Adult-use legal since 2022.' },
  { state: 'South Carolina', status: 'illegal', note: 'No legal program of any kind, medical or recreational.' },
  { state: 'South Dakota', status: 'medical', note: 'Medical program for qualifying conditions; a recreational ballot measure did not pass.' },
  { state: 'Tennessee', status: 'cbd_only', note: 'Low-THC CBD products only; no medical or recreational program.' },
  { state: 'Texas', status: 'cbd_only', note: "Compassionate Use Program covers specific conditions with a strict 0.5% THC cap; not full medical or recreational." },
  { state: 'Utah', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Vermont', status: 'recreational', note: 'Adult-use legal since 2018; first state to legalize via legislature rather than ballot measure.' },
  { state: 'Virginia', status: 'recreational', note: 'Adult-use possession legal since 2021, though retail sales have lagged behind legalization.' },
  { state: 'Washington', status: 'recreational', note: 'One of the first two adult-use states, legal since 2012.' },
  { state: 'West Virginia', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.' },
  { state: 'Wisconsin', status: 'cbd_only', note: 'Low-THC CBD products only; no medical or recreational program.' },
  { state: 'Wyoming', status: 'illegal', note: 'No legal program of any kind, medical or recreational.' },
  { state: 'Washington, D.C.', status: 'recreational', note: 'Adult possession and home cultivation are legal, but D.C. is barred by Congress from regulating commercial sales.' },
];
const LEGAL_STATUS_LABELS = {
  recreational: { label: 'Recreational (21+)', color: '#1b5e3a' },
  medical: { label: 'Medical only', color: '#8a6d1f' },
  cbd_only: { label: 'Low-THC / CBD only', color: '#8a4a1f' },
  illegal: { label: 'Illegal', color: '#8a1f2a' },
};

const METHOD_GROUPS = [
  { group: 'Smoking', items: ['Joint', 'Blunt', 'Pipe / Bowl', 'Bong / Bubbler', 'One-Hitter / Chillum', 'Gravity Bong', 'Infused Pre-Roll'] },
  { group: 'Vaping', items: ['Dry Herb Vaporizer', 'Vape Cartridge (510)', 'Disposable Vape Pen', 'Live Resin Cart', 'Desktop Vaporizer'] },
  { group: 'Dabbing & Concentrates', items: ['Dab Rig (Wax/Shatter)', 'Live Resin Dab', 'Rosin Dab', 'Dab Pen / E-Rig', 'Moon Rocks', 'Kief', 'Hash'] },
  { group: 'Edibles', items: ['Gummy', 'Baked Good', 'Chocolate', 'Beverage / Drink', 'Hard Candy', 'Capsule / Pill'] },
  { group: 'Tinctures & Sublingual', items: ['Tincture (Alcohol-Based)', 'Tincture (Oil-Based)', 'Sublingual Spray'] },
  { group: 'Topicals & Other', items: ['Topical Cream / Balm', 'Transdermal Patch', 'Suppository', 'RSO (Rick Simpson Oil)', 'Cannabis Bath Soak'] },
];

function pageCheckinForm(req, res, query, existing) {
  const strainId = existing ? existing.strain_id : (query.get('strain') || '');
  const s = strainId ? db.getStrain(strainId) : null;
  const isEdit = !!existing;
  const backHref = s ? `/strains/${s.id}` : '/';
  const body = `
    <a href="${backHref}" class="empty-note">← Back</a>
    <h1 class="screen-title">${isEdit ? 'Edit Check-In' : 'Check In'}</h1>
    ${isEdit ? `<p class="empty-note">Thoughts changed after the fact? That's normal, especially with edibles — update it below.</p>` : ''}
    <form method="POST" action="${isEdit ? `/checkin/${existing.id}/edit` : '/checkin'}" id="checkin-form">
      <label class="field-label">Strain</label>
      <div id="strain-picker" ${s ? 'style="display:none;"' : ''}>
        <input type="text" id="strain-picker-search" placeholder="Type a strain name..." autocomplete="off" ${isEdit ? 'disabled' : ''}>
        <div class="effect-results" id="strain-picker-results"></div>
      </div>
      <div id="strain-picker-selected" class="card" ${s ? '' : 'style="display:none;"'}>
        ${s ? `${s.icon} <b>${esc(s.name)}</b> ${isEdit ? '' : `<button type="button" id="strain-picker-change" class="btn secondary" style="float:right;padding:2px 10px;">Change</button>`}` : ''}
      </div>
      <input type="hidden" name="strain_id" id="strain-picker-hidden" value="${s ? s.id : ''}">
      ${isEdit ? '' : `<p class="empty-note" id="strain-picker-hint" ${s ? 'style="display:none;"' : ''}>Tip: search from <a href="/strains">the Strain Library</a> and tap "Check in" on the strain page for a pre-filled form.</p>`}

      <label class="field-label">Method</label>
      <select name="method" id="checkin-method-select" onchange="toggleEdibleWarning(this.value)">${METHOD_GROUPS.map(g => `<optgroup label="${esc(g.group)}">${g.items.map(m => `<option ${existing && existing.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</optgroup>`).join('')}</select>
      <div class="dosing-note" id="edible-warning" style="display:none;">⚠️ Edibles can take up to 2 hours to fully kick in. Redosing too early — before you feel the first dose — is the most common cause of an uncomfortable experience. Wait it out before taking more.</div>

      <label class="field-label">Rating</label>
      <select name="rating">${[5, 4, 3, 2, 1].map(n => `<option value="${n}" ${existing && existing.rating === n ? 'selected' : ''}>${starString(n)}</option>`).join('')}</select>

      <label class="field-label">Mood / Effects (pick up to 5, optional)</label>
      <div class="effect-picker" id="effect-picker">
        <input type="text" id="effect-search" placeholder="Search 85+ moods, feelings &amp; relief tags..." autocomplete="off">
        <div class="effect-results" id="effect-results"></div>
        <div class="effect-chips" id="effect-chips"></div>
        <div class="empty-note" id="effect-note" style="padding:4px 0 0;">0 of 5 selected</div>
      </div>
      <div id="effect-hidden-inputs"></div>

      <label class="field-label">Photo</label>
      <div class="photo-picker" id="photo-picker">
        <div class="photo-upload-box" id="photo-upload-box" onclick="document.getElementById('photo-file-input').click()">
          <div class="up-ic">📷</div>
          <div class="up-txt">Tap to snap or upload a photo of your bud<br>(optional — we'll show a placeholder if you skip it)</div>
        </div>
        <input type="file" id="photo-file-input" accept="image/*" style="display:none;">
        <input type="hidden" name="photo" id="photo-data-input">
      </div>

      <label class="field-label">Notes</label>
      <textarea name="note" placeholder="How was it?">${existing ? esc(existing.note || '') : ''}</textarea>

      <label class="field-label">Tasting Notes</label>
      <textarea name="tasting_notes" placeholder="Flavor, smell, smoothness — what stood out?">${existing ? esc(existing.tasting_notes || '') : ''}</textarea>

      <label class="field-label">Food / Drink Pairing</label>
      <input type="text" name="pairing_food" placeholder="What went really well with it?" value="${existing ? esc(existing.pairing_food || '') : ''}">

      <label class="field-label">Music / Entertainment Pairing</label>
      <input type="text" name="pairing_entertainment" placeholder="What you listened to or watched" value="${existing ? esc(existing.pairing_entertainment || '') : ''}">

      <label class="field-label">Activity Pairing</label>
      <input type="text" name="pairing_activity" placeholder="What you did while enjoying it" value="${existing ? esc(existing.pairing_activity || '') : ''}">

      <label style="display:flex;align-items:center;gap:8px;margin-top:16px;cursor:pointer;">
        <input type="checkbox" name="is_private" value="1" ${existing && existing.is_private ? 'checked' : ''} style="width:auto;margin:0;">
        <span>🔒 Log privately — just for me, won't show in the feed</span>
      </label>

      <button class="btn block" type="submit" id="checkin-submit">${isEdit ? 'Save Changes' : '🔥 Light It Up'}</button>
    </form>
    ${isEdit ? `
      <form method="POST" action="/checkin/${existing.id}/delete" style="margin-top:10px;text-align:center;" onsubmit="return confirm('Delete this check-in? This cannot be undone.')">
        <input type="hidden" name="redirect_to" value="/strains/${existing.strain_id}">
        <button type="submit" style="background:none;border:none;color:#a13a3a;cursor:pointer;font-size:12px;padding:4px;">Delete this check-in</button>
      </form>
    ` : ''}
    <script>
      window.EFFECT_VOCAB = ${JSON.stringify(EFFECT_VOCAB)};
      window.INITIAL_EFFECTS = ${JSON.stringify(existing ? existing.effects || [] : [])};
      window.INITIAL_PHOTO = ${JSON.stringify(existing ? existing.photo || '' : '')};
      window.EDIBLE_METHODS = ${JSON.stringify(METHOD_GROUPS.find(g => g.group === 'Edibles').items)};
      function toggleEdibleWarning(method) {
        const box = document.getElementById('edible-warning');
        if (box) box.style.display = window.EDIBLE_METHODS.includes(method) ? 'block' : 'none';
      }
      toggleEdibleWarning(document.getElementById('checkin-method-select').value);
    </script>
  `;
  sendHtml(res, layout({ title: isEdit ? 'Edit Check-In' : 'Check In', active: 'strains', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageCheckinEditForm(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const existing = db.getCheckin(id);
  if (!existing || existing.user_id !== userId) return notFound(res);
  pageCheckinForm(req, res, new URLSearchParams(), existing);
}

async function handleCheckinSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const strainId = fields.strain_id;
  if (!strainId) { sendHtml(res, layout({ title: 'Check In', body: `<p>Please pick a valid strain. <a href="/checkin">Try again</a></p>` }), 400); return; }
  let effects = Array.isArray(fields.effects) ? fields.effects : (fields.effects ? [fields.effects] : []);
  effects = effects.filter(Boolean).slice(0, 5);
  const photoUrl = await storage.uploadCheckinPhoto(fields.photo || null);
  await db.createCheckin({
    user_id: userId, strain_id: strainId, method: fields.method, rating: Number(fields.rating) || 0,
    note: fields.note || '', effects, photo: photoUrl,
    tasting_notes: fields.tasting_notes || '', pairing_food: fields.pairing_food || '',
    pairing_entertainment: fields.pairing_entertainment || '', pairing_activity: fields.pairing_activity || '',
    is_private: !!fields.is_private,
  });
  redirect(res, `/strains/${strainId}`);
}
async function handleCheckinEditSubmit(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const existing = db.getCheckin(id);
  if (!existing || existing.user_id !== userId) return notFound(res);
  const fields = await parseForm(req);
  let effects = Array.isArray(fields.effects) ? fields.effects : (fields.effects ? [fields.effects] : []);
  effects = effects.filter(Boolean).slice(0, 5);
  const photoUrl = await storage.uploadCheckinPhoto(fields.photo || null);
  await db.updateCheckin(id, {
    method: fields.method, rating: Number(fields.rating) || 0,
    note: fields.note || '', effects, photo: photoUrl,
    tasting_notes: fields.tasting_notes || '', pairing_food: fields.pairing_food || '',
    pairing_entertainment: fields.pairing_entertainment || '', pairing_activity: fields.pairing_activity || '',
    is_private: !!fields.is_private,
  });
  redirect(res, `/strains/${existing.strain_id}`);
}
async function handleCheckinDelete(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const existing = db.getCheckin(id);
  if (!existing || existing.user_id !== userId) return notFound(res);
  const f = await parseForm(req);
  await db.deleteCheckin(id);
  redirect(res, f.redirect_to || '/history');
}

function pageFaq(req, res, query) {
  const q = (query && query.get('q') || '').trim();
  const allFaqs = db.listFaqs();
  const topFaqs = allFaqs.slice(0, 8);
  const topIds = new Set(topFaqs.map(f => f.id));
  const searchResults = q ? db.listFaqs(q).filter(f => !topIds.has(f.id)) : [];

  const renderFaq = (f) => `
    <div class="faq-item">
      <div class="faq-q" onclick="toggleFaq(this)"><span>${esc(f.question)}</span><span>⌄</span></div>
      <div class="faq-a">${esc(f.answer)}${f.source_url ? `<div class="empty-note" style="padding:6px 0 0;">Source: <a href="${esc(f.source_url)}" target="_blank" rel="noopener noreferrer">${esc(f.source_name || f.source_url)}</a></div>` : ''}</div>
    </div>`;

  const body = `
    <h1 class="screen-title">FAQ &amp; Strain School</h1>
    <div class="section-label">Most asked</div>
    ${topFaqs.map(renderFaq).join('') || `<div class="empty-note">No FAQ entries yet — try the <a href="/chat">Ask</a> tab, it can answer from the same content base.</div>`}

    <div class="section-label" style="margin-top:20px;">Search everything else (${allFaqs.length - topFaqs.length} more)</div>
    <form method="GET" action="/faq" style="margin-bottom:12px;display:flex;gap:8px;">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search all FAQ topics..." autocomplete="off" style="flex:1;">
      <button class="btn" type="submit">Search</button>
    </form>
    ${q ? (
      searchResults.length
        ? searchResults.map(renderFaq).join('')
        : `<div class="empty-note">No results for "${esc(q)}" — try the <a href="/chat">Ask</a> tab instead, it can answer from all the same content.</div>`
    ) : `<p class="empty-note">Type a question or keyword above to search the rest of the FAQ library.</p>`}

    <p class="empty-note" style="margin-top:16px;">Have a question you don't see here? Ask the assistant on the <a href="/chat">Ask</a> tab.</p>
  `;
  sendHtml(res, layout({ title: 'FAQ', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Maps a usesBase keyword to the title of the one "core" recipe that
// should be treated as *the* reference for that base — so a link that
// says "how to make cannabutter" goes to one specific, canonical recipe
// (Classic Cannabutter) rather than a search page showing every variant
// (Instant Pot, Slow Cooker, Sous Vide...) mixed together.
const CANONICAL_BASE_RECIPE = {
  'coconut oil': 'Cannabis-Infused Coconut Oil',
  'olive oil': 'Canna-Infused Olive Oil',
  'avocado oil': 'Cannabis-Infused Avocado Oil',
  'ghee': 'Cannabis-Infused Ghee',
  'infused milk': 'Cannabis-Infused Milk',
  'infused sugar': 'Cannabis-Infused Sugar',
  'infused flour': 'Cannabis-Infused Flour',
  'honey': 'Cannabis-Infused Honey',
  'finishing salt': 'Cannabis Finishing Salt',
  'simple syrup': 'Cannabis Simple Syrup',
  'glycerin tincture': 'Cannabis Glycerin Tincture (Alcohol-Free)',
  'tincture': 'DIY Cannabis Tincture',
  'cannabutter': 'Classic Cannabutter',
  'rso': 'RSO (Rick Simpson Oil)',
};
function canonicalBaseRecipeId(keyword) {
  const title = CANONICAL_BASE_RECIPE[keyword];
  if (!title) return null;
  const r = db.listRecipes({ status: null }).find(x => x.title === title);
  return r ? r.id : null;
}

// ---------------------------------------------------------------- glossary
// Cannabis/cooking jargon that shows up in recipes and grow tips, made
// tappable so someone unfamiliar with a term can get a plain-language
// definition without leaving the page. Applied to already-esc()'d text,
// so the term words themselves must stay plain (no special HTML chars).
const GLOSSARY_TERMS = [
  { key: 'decarb', variants: ['decarboxylation', 'decarboxylated', 'decarboxylate', 'decarbing', 'decarbed', 'decarb'],
    definition: "Heating raw cannabis converts its non-intoxicating THCA into actual THC — the compound that gets you high. Skip this step and an edible won't work." },
  { key: 'trichome', variants: ['trichomes', 'trichome'],
    definition: 'The tiny, crystal-like hairs coating cannabis buds — this is where THC, CBD, and terpenes are actually produced and stored.' },
  { key: 'terpene', variants: ['terpenes', 'terpene'],
    definition: "Aromatic oils in cannabis that give each strain its distinct smell and flavor, and may influence how a strain's effects actually feel." },
  { key: 'cannabinoid', variants: ['cannabinoids', 'cannabinoid'],
    definition: 'The active compounds in cannabis — THC and CBD are the best known, but there are dozens more, each with different effects.' },
  { key: 'rso', variants: ['rick simpson oil', 'rso'],
    definition: 'A thick, dark, very concentrated cannabis oil made by extracting the whole plant with a solvent. Extremely potent — dosed in tiny amounts, not smoked.' },
  { key: 'kief', variants: ['kief'],
    definition: 'The loose, powdery trichomes that collect at the bottom of a grinder — concentrated potency sifted straight off the flower.' },
  { key: 'curing', variants: ['curing', 'cured'],
    definition: "The slow drying process after harvest (in a jar, opened daily, out of light) that develops flavor and potency and gets rid of a harsh 'fresh grass' taste." },
  { key: 'flowering', variants: ['flowering'],
    definition: "The stage of a plant's life cycle when it actually produces buds — triggered by a change in light schedule, or by age for autoflowering strains." },
  { key: 'photoperiod', variants: ['photoperiod'],
    definition: "A plant that only starts flowering when its daily light schedule shifts to more darkness (typically 12/12) — as opposed to 'autoflowering' strains, which flower based on age alone." },
  { key: 'landrace', variants: ['landraces', 'landrace'],
    definition: "A strain that developed naturally in one region over generations (like Durban Poison or Hindu Kush), without deliberate modern crossbreeding. The genetic foundation most hybrids are ultimately built from." },
  { key: 'backcross', variants: ['backcrosses', 'backcrossed', 'backcrossing', 'backcross', 'bx1', 'bx2', 'bx3'],
    definition: "Breeding a hybrid back with one of its original parent strains to lock in and stabilize a specific trait. Often written as 'Bx1,' 'Bx2,' and so on for each generation of backcrossing." },
  { key: 'phenotype', variants: ['phenotypes', 'phenotype', 'pheno'],
    definition: "The specific way a strain's genetics actually show up in a given plant — smell, color, potency, structure. Two plants grown from the exact same seed line can express noticeably different phenotypes." },
  { key: 'pheno-hunt', variants: ['pheno-hunting', 'pheno hunting', 'pheno-hunted', 'pheno hunted', 'pheno-hunt', 'pheno hunt'],
    definition: "Growing out many seeds or clones from the same genetic line side by side to find the single best-expressing plant, which then becomes the 'cut' that gets kept and reproduced." },
  { key: 'clone-only', variants: ['clone-only', 'clone only'],
    definition: "A strain that only exists as cuttings from one original 'mother' plant, rather than being stabilized into a seed line — meaning every plant is a genetic copy of that same original." },
  { key: 'cultivar', variants: ['cultivars', 'cultivar'],
    definition: "The precise horticultural term for what's casually called a 'strain' — a plant variety bred and selected for specific, repeatable traits." },
  { key: 'indica', variants: ['indica', 'indica-dominant', 'indica-leaning'],
    definition: "One of the two traditional cannabis subspecies, historically associated with relaxing, body-heavy effects — though modern hybrids often blur this distinction more than the old indica/sativa split suggests." },
  { key: 'sativa', variants: ['sativa', 'sativa-dominant', 'sativa-leaning'],
    definition: "The other traditional cannabis subspecies, historically associated with more energizing, cerebral effects — though, like indica, this is a rough guide more than a strict rule with modern hybrids." },
  { key: 'hybrid', variants: ['hybrid', 'hybrids'],
    definition: 'A strain bred from a mix of indica and sativa genetics, aiming to combine traits from both sides of its lineage.' },
  { key: 'autoflowering', variants: ['autoflowering', 'auto-flowering', 'autoflower'],
    definition: "A plant that begins flowering based on age alone, regardless of light schedule — as opposed to a 'photoperiod' plant, which needs a shift to more darkness to start flowering." },
  { key: 'topping', variants: ['topping', 'topped'],
    definition: "A training technique where a plant's main stem is cut early on, redirecting growth into two colas instead of one and encouraging a bushier overall shape." },
  { key: 'sinsemilla', variants: ['sinsemilla'],
    definition: 'Seedless cannabis flower, produced by keeping female plants unpollinated — the standard for essentially all commercial flower today.' },
  { key: 'entourage', variants: ['entourage effect'],
    definition: 'The idea that cannabinoids and terpenes work better together than any single compound would alone — the reasoning behind favoring full-spectrum products over isolated THC.' },
  { key: 'full-spectrum', variants: ['full-spectrum', 'full spectrum'],
    definition: "A product that keeps the plant's whole range of cannabinoids and terpenes intact, rather than isolating a single compound." },
  { key: 'broad-spectrum', variants: ['broad-spectrum', 'broad spectrum'],
    definition: 'Similar to full-spectrum — multiple cannabinoids and terpenes retained — but with THC specifically removed or reduced to trace levels.' },
  { key: 'isolate', variants: ['isolate', 'isolates'],
    definition: 'A product containing a single, purified cannabinoid (most often CBD) with nothing else from the plant left in it.' },
  { key: 'onset', variants: ['onset'],
    definition: "How long it takes to actually start feeling a product's effects — a few minutes for smoking or vaping, often 30–90+ minutes for edibles." },
  { key: 'tolerance', variants: ['tolerance'],
    definition: "The reduced effect of the same dose after repeated regular use, as the body adapts. Usually the reason a strain that used to work well starts to feel weaker over time." },
  { key: 't-break', variants: ['tolerance break', 't-break', 't break'],
    definition: "A deliberate period of not using cannabis to bring tolerance back down, so a given dose (and given strain) starts working like it used to." },
  { key: 'microdosing', variants: ['microdosing', 'microdose', 'microdoses'],
    definition: 'Taking a very small amount of cannabis, aiming for subtle effects — a mood lift or slight relaxation — without a strong high.' },
  { key: 'thca', variants: ['thca'],
    definition: 'The non-intoxicating acidic form of THC found in raw, undried cannabis. Heat (via decarboxylation) converts THCA into the THC that actually produces a high.' },
  { key: 'total-thc', variants: ['total thc'],
    definition: "The calculated potential THC a product could reach once fully decarboxylated, accounting for both existing THC and convertible THCA — usually the more meaningful number on a lab label than raw 'THC' alone." },
  { key: 'solventless', variants: ['solventless'],
    definition: 'Any concentrate made using only heat, pressure, ice water, or agitation — no chemical solvents involved. Rosin and bubble hash are the two most common examples.' },
  { key: 'nug-run', variants: ['nug run', 'nug-run'],
    definition: 'A concentrate made exclusively from whole cured buds rather than trim or shake — generally considered a higher-quality starting material, and priced accordingly.' },
  { key: 'filial', variants: ['f1', 'f2', 'f3'],
    definition: "Shorthand for a cross's generation. F1 is the first-generation offspring of two different parent strains; F2 is grown from F1 seeds, F3 from F2, and so on — each generation further stabilizing (or occasionally destabilizing) the strain's traits." },
];
// Builds one combined regex across every term/variant so each position in
// the text is matched at most once, in a single pass -- this avoids ever
// re-matching text inside a span this same function just inserted.
const GLOSSARY_REGEX = new RegExp(
  '\\b(' + GLOSSARY_TERMS.flatMap(t => t.variants).sort((a, b) => b.length - a.length).join('|') + ')\\b',
  'gi'
);
const GLOSSARY_BY_VARIANT = new Map();
GLOSSARY_TERMS.forEach(t => t.variants.forEach(v => GLOSSARY_BY_VARIANT.set(v.toLowerCase(), t)));
function linkGlossaryTerms(escapedText) {
  if (!escapedText) return escapedText;
  return escapedText.replace(GLOSSARY_REGEX, (match) => {
    const term = GLOSSARY_BY_VARIANT.get(match.toLowerCase());
    if (!term) return match;
    return `<span class="glossary-term" data-def="${esc(term.definition)}">${match}</span>`;
  });
}

function pageRecipeDetail(req, res, id) {
  const r = db.getRecipe(id);
  if (!r || r.status !== 'approved') return notFound(res);
  const body = `
    <a href="/recipes" class="empty-note">← Back to recipes</a>
    <div class="card" style="margin-top:10px;">
      <b style="font-size:16px;">${r.icon || '🍽️'} ${esc(r.title)}</b>
      <span class="recipe-source-tag ${r.source}">${r.source === 'official' ? 'Official' : 'Community'}</span>
      <div class="empty-note">${esc(r.category || '')}${r.time ? ' · ' + esc(r.time) : ''}${r.author ? ' · by ' + esc(r.author) : ''}</div>
      <p>${linkGlossaryTerms(esc(r.desc))}</p>
      ${Array.isArray(r.usesBase) && r.usesBase.length ? `<p class="empty-note" style="padding:0 0 6px;">Uses: ${r.usesBase.map(b => {
        const targetId = canonicalBaseRecipeId(b);
        return targetId ? `<a href="/recipes/${targetId}">${esc(b)}</a>` : esc(b);
      }).join(', ')} <span style="opacity:.7;">(tap to see how to make it)</span></p>` : ''}
      <p><b>Ingredients:</b></p>
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <span class="empty-note" style="padding:6px 0;">Scale:</span>
        ${[0.5, 1, 2, 3].map(f => `<button type="button" class="filter-pill scale-btn" data-factor="${f}" onclick="scaleRecipe(${f}, this)">${f}×</button>`).join('')}
      </div>
      <ul id="ingredients-list">${r.ingredients.map(i => `<li data-original="${esc(i)}">${linkGlossaryTerms(esc(i))}</li>`).join('')}</ul>
      <p><b>Steps:</b></p>
      <ol>${r.steps.map(i => `<li>${linkGlossaryTerms(esc(i))}</li>`).join('')}</ol>
      ${r.dosing ? `<div class="dosing-note">⚠️ ${esc(r.dosing)}</div>` : ''}
      <div class="card" style="margin-top:10px;background:var(--bg-subtle,#f7f7f2);">
        <b style="font-size:14px;">🧮 Dosing calculator</b>
        <p class="empty-note" style="padding:2px 0 8px;">Figure out mg per serving so you're not doing the math in your head.</p>
        <label class="field-label" style="margin-top:0;">Total THC in the batch (mg)</label>
        <input type="number" id="dose-total-mg" placeholder="e.g. 200" min="0" step="any">
        <label class="field-label">Number of servings</label>
        <input type="number" id="dose-servings" placeholder="e.g. 12" min="1" step="1">
        <div id="dose-result" class="empty-note" style="padding:8px 0 0;font-weight:700;"></div>
      </div>
      <script>
        (function() {
          const totalEl = document.getElementById('dose-total-mg');
          const servingsEl = document.getElementById('dose-servings');
          const resultEl = document.getElementById('dose-result');
          function recalc() {
            const total = parseFloat(totalEl.value);
            const servings = parseFloat(servingsEl.value);
            if (!total || !servings || total <= 0 || servings <= 0) { resultEl.textContent = ''; return; }
            resultEl.textContent = (total / servings).toFixed(1) + ' mg THC per serving';
          }
          totalEl.addEventListener('input', recalc);
          servingsEl.addEventListener('input', recalc);
        })();
      </script>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
        <span class="empty-note" style="padding:0;">${r.kudos} people found this helpful</span>
        <button class="kudos-btn" onclick="giveKudos(${r.id}, this)">${KUDOS_BUD_ICON}Kudos</button>
      </div>
    </div>
  `;
  sendHtml(res, layout({ title: r.title, active: 'recipes', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageRecipes(req, res, query) {
  const category = (query && query.get('category')) || 'All';
  const q = (query && query.get('q')) || '';
  const recipes = db.listRecipes({ status: 'approved', category, q });
  const categories = ['All', 'Infusion Base', 'Baked Goods', 'Gummies & Candy', 'Drinks', 'Topicals', 'Savory & Snacks'];
  const mk = (params) => '/recipes?' + new URLSearchParams({ category, q, ...params }).toString();
  const body = `
    <h1 class="screen-title">Infused Recipes</h1>
    <a class="btn block lilac" href="/recipes/new" style="margin-bottom:14px;">✏️ Submit a Recipe</a>
    <form method="GET" action="/recipes" style="margin-bottom:12px;display:flex;gap:8px;">
      <input type="hidden" name="category" value="${esc(category)}">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search by name, ingredient, or description..." autocomplete="off" style="flex:1;">
      <button class="btn" type="submit">Search</button>
    </form>
    <div style="margin-bottom:14px;">${categories.map(c => `<a class="filter-pill ${category === c ? 'active' : ''}" href="${mk({ category: c })}">${c}</a>`).join('')}</div>
    ${q ? `<p class="empty-note">${recipes.length} result${recipes.length === 1 ? '' : 's'} for "${esc(q)}"${category !== 'All' ? ' in ' + esc(category) : ''}</p>` : ''}
    ${recipes.map(r => `
      <div class="card">
        <a href="/recipes/${r.id}" style="text-decoration:none;color:inherit;"><b>${r.icon || '🍽️'} ${esc(r.title)}</b></a>
        <span class="recipe-source-tag ${r.source}">${r.source === 'official' ? 'Official' : 'Community'}</span>
        <div class="empty-note">${esc(r.category || '')}${r.time ? ' · ' + esc(r.time) : ''}${r.author ? ' · by ' + esc(r.author) : ''}</div>
        <p>${linkGlossaryTerms(esc(r.desc))}</p>
        ${Array.isArray(r.usesBase) && r.usesBase.length ? `<p class="empty-note" style="padding:0 0 6px;">Uses: ${r.usesBase.map(b => {
          const targetId = canonicalBaseRecipeId(b);
          return targetId ? `<a href="/recipes/${targetId}">${esc(b)}</a>` : esc(b);
        }).join(', ')} <span style="opacity:.7;">(tap to see how to make it)</span></p>` : ''}
        <details>
          <summary style="cursor:pointer;font-size:12.5px;font-weight:700;color:var(--brand-green-dark);">Ingredients &amp; steps</summary>
          <p><b>Ingredients:</b></p>
          <ul>${r.ingredients.map(i => `<li>${linkGlossaryTerms(esc(i))}</li>`).join('')}</ul>
          <p><b>Steps:</b></p>
          <ol>${r.steps.map(i => `<li>${linkGlossaryTerms(esc(i))}</li>`).join('')}</ol>
          ${r.dosing ? `<div class="dosing-note">⚠️ ${esc(r.dosing)}</div>` : ''}
        </details>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px;">
          <span class="empty-note" style="padding:0;">${r.kudos} people found this helpful</span>
          <button class="kudos-btn" onclick="giveKudos(${r.id}, this)">${KUDOS_BUD_ICON}Kudos</button>
        </div>
      </div>`).join('') || `<div class="empty-note">${q ? 'No recipes match your search.' : 'No recipes in this category yet.'}</div>`}
  `;
  sendHtml(res, layout({ title: 'Recipes', active: 'recipes', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Submit a Recipe', active: 'recipes', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  const viewerId = auth.currentUserId(req);
  const CATEGORIES = ['Plant Life Cycle', 'Watering', 'Lighting', 'Nutrients & Feeding', 'Pests & Disease', 'Training', 'Harvest & Curing', 'Genetics & Seeds', 'Indoor Setup', 'Outdoor Growing', 'Cleaning & Gear Care'];
  const cat = query.get('cat') || 'All';
  const tips = db.listGrowTips({ category: cat, viewerId });
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
        <p>${linkGlossaryTerms(esc(g.body))}</p>
        ${g.source_url ? `<p class="empty-note" style="padding:2px 0 0;">Source: <a href="${esc(g.source_url)}" target="_blank" rel="noopener noreferrer">${esc(g.source_name || g.source_url)}</a></p>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="empty-note" style="padding:0;">by ${esc(g.author || 'Anonymous')}
            ${viewerId != null && g.user_id != null && g.user_id !== viewerId ? `
              <form method="POST" action="/report" style="display:inline;" onsubmit="return confirm('Report this grow tip for review?')">
                <input type="hidden" name="content_type" value="grow_tip">
                <input type="hidden" name="content_id" value="${g.id}">
                <input type="hidden" name="redirect_to" value="/growing">
                <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Report</button>
              </form>
              <form method="POST" action="/block/${g.user_id}" style="display:inline;" onsubmit="return confirm('Block ${esc(g.author || 'this person')}? You will no longer see their comments, check-ins, or grow tips, and any friendship will end.')">
                <input type="hidden" name="redirect_to" value="/growing">
                <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Block</button>
              </form>
            ` : ''}
          </span>
          <button class="kudos-btn" onclick="likeGrowTip(${g.id}, this)">${KUDOS_BUD_ICON}Kudos (${g.likes})</button>
        </div>
      </div>`).join('') || `<div class="empty-note">No tips in this category yet — be the first to <a href="/growing">share one</a>.</div>`}
  `;
  sendHtml(res, layout({ title: 'Growing', active: 'growing', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageGrowingNew(req, res) {
  const CATEGORIES = ['Plant Life Cycle', 'Watering', 'Lighting', 'Nutrients & Feeding', 'Pests & Disease', 'Training', 'Harvest & Curing', 'Genetics & Seeds', 'Indoor Setup', 'Outdoor Growing', 'Cleaning & Gear Care'];
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
  sendHtml(res, layout({ title: 'Share a Grow Tip', active: 'growing', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Ask', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  const deleted = query.get('deleted');
  const errMessages = {
    taken: 'That username is already taken.',
    age: `You must be ${MIN_AGE} or older to create an account.`,
    mismatch: 'Passwords did not match.',
    short: 'Password must be at least 8 characters.',
    invalid: 'Please fill in every field.',
    email_taken: 'That email is already in use.',
    rate_limited: 'Too many signup attempts from this connection. Try again in a few minutes.',
  };
  const body = `
    <h1 class="screen-title">Create an Account</h1>
    <p class="screen-sub">You must be ${MIN_AGE}+ to use StrainDex.</p>
    ${deleted ? `<p class="empty-note" style="color:var(--brand-green-dark);">Your account and data have been deleted.</p>` : ''}
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    <a href="/auth/google" class="btn secondary block" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px;">
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
      Continue with Google
    </a>
    <p class="empty-note" style="text-align:center;margin:0 0 14px;">or</p>
    <form method="POST" action="/signup">
      <label class="field-label" style="margin-top:0;">Username</label>
      <input type="text" name="username" id="signup-username" required minlength="3" maxlength="24" autocomplete="username">
      <label class="field-label">Email</label>
      <input type="email" name="email" required autocomplete="email" placeholder="you@example.com">
      <label class="field-label">Date of birth</label>
      <input type="date" name="birth_date" required>
      <label class="field-label">Password</label>
      <div style="position:relative;">
        <input type="password" name="password" id="signup-password" required minlength="8" autocomplete="new-password" style="padding-right:44px;">
        <button type="button" onclick="['signup-password','signup-password2'].forEach(id=>{const f=document.getElementById(id);f.type=f.type==='password'?'text':'password';});this.textContent=document.getElementById('signup-password').type==='password'?'👁':'🙈';" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:16px;padding:4px;">👁</button>
      </div>
      <label class="field-label">Confirm password</label>
      <input type="password" name="password2" id="signup-password2" required minlength="8" autocomplete="new-password">
      <button class="btn block" type="submit" style="margin-top:14px;">Create Account</button>
    </form>
    <script>document.getElementById('signup-username').focus();</script>
    <p class="empty-note" style="margin-top:12px;">By creating an account, you agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>.</p>
    <p class="empty-note">Already have an account? <a href="/login">Log in</a></p>
  `;
  sendHtml(res, layout({ title: 'Sign Up', body }));
}
// ---------------------------------------------------------------- Google sign-in
// Standard OAuth 2.0 authorization-code flow, no external library -- just
// fetch() against Google's token and userinfo endpoints (Node 18+ has
// fetch built in, same as the Resend email calls elsewhere in this file).
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = 'https://strain-dex.com/auth/google/callback';

function pageGoogleStart(req, res, query) {
  if (!GOOGLE_CLIENT_ID) {
    return sendHtml(res, layout({ title: 'Sign in with Google', body: `<h1 class="screen-title">Google sign-in isn't set up yet</h1><p class="empty-note">Missing GOOGLE_CLIENT_ID on the server. <a href="/login">Back to login</a></p>` }));
  }
  // A random, single-use state value guards against CSRF -- stored in a
  // short-lived cookie, then checked against the value Google echoes back
  // on the callback before we trust anything else in that request.
  const state = crypto.randomBytes(16).toString('hex');
  const isRetry = query && query.get('retry') === '1';
  res.setHeader('Set-Cookie', `google_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state: isRetry ? `retry.${state}` : state,
    prompt: 'select_account',
  });
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

async function handleGoogleCallback(req, res, query) {
  const code = query.get('code');
  const state = query.get('state');
  const cookies = auth.parseCookies(req);
  const alreadyRetried = typeof state === 'string' && state.startsWith('retry.');
  const bareState = alreadyRetried ? state.slice('retry.'.length) : state;
  if (!code || !state || bareState !== cookies.google_oauth_state) {
    console.error('Google sign-in: state mismatch or missing code', { hasCode: !!code, hasState: !!state, cookieState: cookies.google_oauth_state, alreadyRetried });
    // This mismatch is most often a cold-start timing hiccup on Render's
    // free tier (the cookie-setting request and the callback landing far
    // enough apart that something in between didn't stick) rather than an
    // actual attack -- and the previous behavior of dumping the person
    // onto an error page here is exactly the failure mode that makes
    // someone assume Google sign-in is just broken and not bother trying
    // again. So: silently retry the whole flow ONE time automatically
    // before ever showing an error. If it fails twice in a row, something
    // real is wrong and the error page is warranted.
    if (!alreadyRetried) {
      return redirect(res, '/auth/google?retry=1');
    }
    Sentry.captureException(new Error('Google sign-in state mismatch persisted after auto-retry'));
    return redirect(res, '/login?err=google_state');
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Google sign-in: token exchange failed', tokenData);
      Sentry.captureException(new Error('Google token exchange failed: ' + JSON.stringify(tokenData)));
      return redirect(res, '/login?err=google_token');
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profile.sub || !profile.email) {
      console.error('Google sign-in: incomplete profile response', profile);
      Sentry.captureException(new Error('Google userinfo missing sub/email: ' + JSON.stringify(profile)));
      return redirect(res, '/login?err=google_profile');
    }

    // 1) Already linked -- straight login.
    let user = db.getUserByGoogleId(profile.sub);
    // 2) Not linked yet, but an account already exists with this email --
    // link them together rather than making a confusing duplicate account.
    // Not gating on profile.email_verified here: Google itself only ever
    // hands back an email address it has confirmed the person owns as part
    // of completing the OAuth sign-in, so the extra check was redundant --
    // and in practice it was the actual bug: Google's userinfo response
    // doesn't reliably return that field as a strict JS boolean `true` in
    // every case, so the check was silently skipping real matches and
    // sending existing users down the "create a new account" path instead
    // of logging them into the one they already had.
    if (!user) {
      const existing = db.getUserByEmail(profile.email);
      if (existing) user = await db.linkGoogleId(existing.id, profile.sub);
    }
    if (user) {
      const token = auth.signUserSessionValue(user.id);
      res.setHeader('Set-Cookie', `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      return redirect(res, '/');
    }
    // 3) Genuinely new person -- Google doesn't give us a birth date, and
    // this app legally requires one, so stash the verified profile in a
    // short-lived signed cookie and send them to a small finishing form
    // rather than creating an incomplete account.
    const pending = auth.sign(JSON.stringify({ sub: profile.sub, email: profile.email, name: profile.name || '' }));
    res.setHeader('Set-Cookie', `google_pending=${encodeURIComponent(pending)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
    redirect(res, '/auth/google/finish');
  } catch (e) {
    console.error('Google sign-in: unexpected error in callback', e);
    Sentry.captureException(e);
    redirect(res, '/login?err=google_error');
  }
}

function pageGoogleFinish(req, res, query) {
  const cookies = auth.parseCookies(req);
  const raw = auth.verify(cookies.google_pending);
  if (!raw) return redirect(res, '/signup');
  const profile = JSON.parse(raw);
  const err = query.get('err');
  const errMessages = { taken: 'That username is already taken.', age: `You must be ${MIN_AGE} or older to create an account.`, invalid: 'Please fill in every field.' };
  // If the Google-derived suggestion collides with an existing username,
  // append a short random suffix so the pre-filled value in the form is
  // never one the person has to fix themselves just to get past a
  // collision they didn't create -- they can still change it to whatever
  // they actually want.
  let suggestedUsername = (profile.name || profile.email.split('@')[0]).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 24) || 'strainfan';
  if (db.getUserByUsername(suggestedUsername)) {
    suggestedUsername = (suggestedUsername.slice(0, 19) + Math.floor(1000 + Math.random() * 9000));
  }
  const body = `
    <h1 class="screen-title">Almost there</h1>
    <p class="screen-sub">Signed in as ${esc(profile.email)} with Google. Just need a couple more things.</p>
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    <form method="POST" action="/auth/google/finish">
      <label class="field-label" style="margin-top:0;">Username</label>
      <input type="text" name="username" required minlength="3" maxlength="24" value="${esc(suggestedUsername)}">
      <label class="field-label">Date of birth</label>
      <input type="date" name="birth_date" required>
      <button class="btn block" type="submit" style="margin-top:14px;">Finish Creating Account</button>
    </form>
    <p class="empty-note" style="margin-top:12px;">By creating an account, you agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>.</p>
  `;
  sendHtml(res, layout({ title: 'Finish Signing Up', body }));
}

async function handleGoogleFinishSubmit(req, res) {
  const cookies = auth.parseCookies(req);
  const raw = auth.verify(cookies.google_pending);
  if (!raw) return redirect(res, '/signup');
  const profile = JSON.parse(raw);
  const f = await parseForm(req);
  const username = String(f.username || '').trim();
  if (!username || !f.birth_date) return redirect(res, '/auth/google/finish?err=invalid');
  if (!isOldEnough(f.birth_date)) return redirect(res, '/auth/google/finish?err=age');
  if (db.getUserByUsername(username)) return redirect(res, '/auth/google/finish?err=taken');
  const user = await db.createUserFromGoogle({ username, birth_date: f.birth_date, email: profile.email, google_id: profile.sub });
  const token = auth.signUserSessionValue(user.id);
  res.setHeader('Set-Cookie', [
    `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    `google_pending=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ]);
  redirect(res, '/onboarding');
}

async function handleSignupSubmit(req, res) {
  if (isSignupRateLimited(req)) return redirect(res, '/signup?err=rate_limited');
  const f = await parseForm(req);
  const username = String(f.username || '').trim();
  const email = String(f.email || '').trim().toLowerCase();
  if (!username || !email || !f.birth_date || !f.password || !f.password2) return redirect(res, '/signup?err=invalid');
  if (!isOldEnough(f.birth_date)) return redirect(res, '/signup?err=age');
  if (f.password !== f.password2) return redirect(res, '/signup?err=mismatch');
  if (f.password.length < 8) return redirect(res, '/signup?err=short');
  if (db.getUserByUsername(username)) return redirect(res, '/signup?err=taken');
  if (db.getUserByEmail(email)) return redirect(res, '/signup?err=email_taken');
  const user = await db.createUser({ username, password: f.password, birth_date: f.birth_date, email });
  const token = auth.signUserSessionValue(user.id);
  res.setHeader('Set-Cookie', `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  redirect(res, '/onboarding');
}
function pageLogin(req, res, query) {
  const err = query.get('err');
  const errMessages = {
    '1': 'Wrong username or password.',
    rate_limited: 'Too many failed attempts for this account. Try again in a few minutes, or reset your password.',
    google_state: 'That Google sign-in link expired or was already used — try clicking "Continue with Google" again.',
    google_token: "Google sign-in didn't complete on Google's end. Try again in a moment — if it keeps happening, let us know.",
    google_profile: "Google didn't send back enough account info to sign you in. Try again, or use your username and password instead.",
    google_error: "Something went wrong finishing Google sign-in. Try again, or use your username and password instead.",
  };
  const body = `
    <h1 class="screen-title">Log In</h1>
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    <a href="/auth/google" class="btn secondary block" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px;">
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
      Continue with Google
    </a>
    <p class="empty-note" style="text-align:center;margin:0 0 14px;">or</p>
    <form method="POST" action="/login">
      <label class="field-label" style="margin-top:0;">Username or email</label>
      <input type="text" name="username" id="login-username" required autocomplete="username">
      <label class="field-label">Password</label>
      <div style="position:relative;">
        <input type="password" name="password" id="login-password" required autocomplete="current-password" style="padding-right:44px;">
        <button type="button" onclick="const f=document.getElementById('login-password');f.type=f.type==='password'?'text':'password';this.textContent=f.type==='password'?'👁':'🙈';" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:16px;padding:4px;">👁</button>
      </div>
      <button class="btn block" type="submit" style="margin-top:14px;">Log In</button>
    </form>
    <script>document.getElementById('login-username').focus();</script>
    <p class="empty-note" style="margin-top:12px;">Forgot your password? <a href="/forgot-password">Reset it</a></p>
    <p class="empty-note">New here? <a href="/signup">Create an account</a></p>
  `;
  sendHtml(res, layout({ title: 'Log In', body }));
}

// ---------------------------------------------------------------- forgot / reset password
// ---------------------------------------------------------------- feedback
// Free-text feedback while in beta -- deliberately simple (one textarea,
// no categories/ratings) so it's low-friction to actually use. Stored in
// the DB (readable from the admin panel) and, if RESEND_API_KEY and
// FEEDBACK_NOTIFY_EMAIL are both set, also emailed immediately so it
// doesn't require remembering to check the admin panel.
// ---------------------------------------------------------------- onboarding
// A one-time, 4-step walkthrough shown right after signup so a brand-new
// user doesn't land on Home with zero context. No persistent "seen" flag
// needed -- only the signup flow links here, so an existing user would
// only see it again if they typed the URL directly, which is harmless.
function pageOnboarding(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const steps = [
    { icon: '🌿', title: 'Welcome to StrainDex', body: 'Your personal cannabis journal — strains, recipes, growing knowledge, and a lot more, all in one place.' },
    { icon: '🔥', title: 'Log your first check-in', body: 'Tap "Light It Up" any time you try a strain — rate it, add tasting notes, and start your collection.' },
    { icon: '🧭', title: 'Not sure where to start?', body: 'Take the 3-question quiz to get matched to a starter strain, or hit "Surprise Me" for a random pick from the 1,600+ strain library.' },
    { icon: '📊', title: 'See your own patterns', body: 'Your Patterns reflects your check-in history back at you — favorite effects, top strain type, even a tolerance break tracker.' },
    { icon: '🧑\u200d🤝\u200d🧑', title: 'Bring your friends', body: 'Add friends to see their check-ins, trade duplicate strain cards, and compare notes.' },
    { icon: '⭐', title: 'A lot more in "More"', body: 'Compare strains side by side, check what’s trending, look up your state’s cannabis laws, keep a wishlist, and more — it’s all grouped by category in the More tab.' },
  ];
  const body = `
    <div class="card" style="text-align:center;padding:32px 20px;">
      <div id="onboarding-steps">
        ${steps.map((s, i) => `
          <div class="onboarding-step" data-step="${i}" style="${i === 0 ? '' : 'display:none;'}">
            <div style="font-size:44px;margin-bottom:16px;">${s.icon}</div>
            <h2 style="margin:0 0 8px;font-size:18px;">${esc(s.title)}</h2>
            <p style="color:var(--ink-secondary);font-size:13.5px;line-height:1.6;margin:0;">${esc(s.body)}</p>
          </div>`).join('')}
      </div>
      <div style="display:flex;justify-content:center;gap:6px;margin:22px 0 6px;">
        ${steps.map((_, i) => `<span class="onboarding-dot" data-dot="${i}" style="width:6px;height:6px;border-radius:50%;background:${i === 0 ? 'var(--brand-green)' : 'var(--border)'};"></span>`).join('')}
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;">
      <a href="/" class="btn secondary block" style="flex:1;">Skip</a>
      <button type="button" id="onboarding-next" class="btn block" style="flex:1;">Next</button>
    </div>
    <script>
      (function() {
        const total = ${steps.length};
        let i = 0;
        const nextBtn = document.getElementById('onboarding-next');
        function render() {
          document.querySelectorAll('.onboarding-step').forEach(el => { el.style.display = Number(el.dataset.step) === i ? '' : 'none'; });
          document.querySelectorAll('.onboarding-dot').forEach(el => { el.style.background = Number(el.dataset.dot) === i ? 'var(--brand-green)' : 'var(--border)'; });
          nextBtn.textContent = i === total - 1 ? 'Get started' : 'Next';
        }
        nextBtn.addEventListener('click', () => {
          if (i < total - 1) { i++; render(); } else { window.location.href = '/'; }
        });
      })();
    </script>
  `;
  sendHtml(res, layout({ title: 'Welcome', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// "Find your first strain" quiz -- a lightweight 3-question filter over the
// same THC-bucket logic already used by the Strain Library's filters, plus
// simple effect-tag scoring. Not a medical tool, just a starting point for
// someone facing 1,600+ strains with no idea where to begin.
const QUIZ_FEEL_TAGS = {
  relaxed: ['Relaxed', 'Sleepy', 'Calm'],
  happy: ['Happy', 'Social', 'Euphoric'],
  creative: ['Creative', 'Focused', 'Uplifted'],
  energetic: ['Energetic', 'Uplifted', 'Talkative'],
};
const QUIZ_TIME_TAGS = {
  morning: ['Energetic', 'Focused', 'Creative', 'Uplifted'],
  evening: ['Relaxed', 'Sleepy', 'Calm'],
  anytime: [],
};
// Side-by-side strain comparison. Reuses two independent search pickers
// (initComparePickers in app.js) that each redirect back here with their
// own query param once a strain is picked, so the URL itself (?a=ID&b=ID)
// is the whole state -- shareable, bookmarkable, works with back/forward.
function pageCompare(req, res, query) {
  const aId = query.get('a') || '';
  const bId = query.get('b') || '';
  const a = aId ? db.getStrain(aId) : null;
  const b = bId ? db.getStrain(bId) : null;
  const pickerBox = (suffix, current) => `
    <div style="flex:1;min-width:0;position:relative;">
      ${current ? `
        <div class="card" style="display:flex;align-items:center;gap:8px;">
          ${strainPhotoTag(current, 'sm')}
          <b style="flex:1;min-width:0;">${esc(current.name)}</b>
          <a href="/compare?${suffix === 'a' ? 'b=' + esc(bId) : 'a=' + esc(aId)}" class="empty-note" style="padding:0;">Change</a>
        </div>
      ` : `
        <input type="text" id="compare-search-${suffix}" placeholder="Search strain ${suffix.toUpperCase()}..." autocomplete="off">
        <div class="effect-results" id="compare-results-${suffix}"></div>
      `}
    </div>`;
  const rows = a && b ? [
    ['Type', a.type + (a.lean ? ' · ' + a.lean : ''), b.type + (b.lean ? ' · ' + b.lean : '')],
    ['THC', a.thc, b.thc],
    ['CBD', a.cbd, b.cbd],
    ['Rarity', rarityLabel(a.rarity), rarityLabel(b.rarity)],
    ['Effects', a.effects.join(', '), b.effects.join(', ')],
    ['Top terpenes', a.terps.map(t => t.n).join(', '), b.terps.map(t => t.n).join(', ')],
    ['Flavor', a.flavor, b.flavor],
  ] : [];
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Compare Strains</h1>
    <p class="screen-sub">Pick two strains to see them side by side.</p>
    <div style="display:flex;gap:10px;margin-bottom:16px;">
      ${pickerBox('a', a)}
      ${pickerBox('b', b)}
    </div>
    ${a && b ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        ${rows.map(([label, av, bv]) => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px 6px;font-weight:700;color:var(--ink-secondary);width:28%;vertical-align:top;">${esc(label)}</td>
            <td style="padding:8px 6px;vertical-align:top;">${esc(av)}</td>
            <td style="padding:8px 6px;vertical-align:top;">${esc(bv)}</td>
          </tr>`).join('')}
      </table>
    ` : `<div class="empty-note">Pick a strain in each box above to compare them.</div>`}
  `;
  sendHtml(res, layout({ title: 'Compare Strains', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// "Surprise Me" -- picks one random strain the person hasn't checked into
// yet and sends them straight to its page. Deliberately dumber than the
// quiz: no preference-matching, just pure serendipity for someone who
// wants to be shown something they'd never have found by browsing.
function handleSurpriseMe(req, res) {
  const userId = auth.currentUserId(req);
  const all = db.listStrains({ limit: 5000 });
  const tried = new Set(userId != null ? db.listCheckins({ userId, limit: 5000 }).map(c => c.strain_id) : []);
  const untried = all.filter(s => !tried.has(s.id));
  const pool = untried.length ? untried : all; // everyone's tried everything -- fall back to the full library
  const pick = pool[Math.floor(Math.random() * pool.length)];
  redirect(res, pick ? `/strains/${pick.id}` : '/strains');
}

// Wishlist toggle -- add/remove a strain, then bounce back to wherever the
// person was (strain page, wishlist page, etc.) via a hidden redirect_to,
// same pattern as check-in comments.
async function handleWishlistToggle(req, res, strainId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  if (db.isInWishlist(userId, strainId)) {
    await db.removeFromWishlist(userId, strainId);
  } else {
    await db.addToWishlist(userId, strainId);
  }
  redirect(res, f.redirect_to || `/strains/${strainId}`);
}

// Grow journal -- a private photo/note timeline, separate from the public
// Grow Tips community page. Uses its own distinct element IDs for the
// photo picker rather than reusing the check-in form's shared JS, since
// that logic is gated inside initCheckinForm and shouldn't be assumed to
// run on an unrelated page.
function pageGrowJournal(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const entries = db.listGrowJournal(userId);
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Grow Journal</h1>
    <p class="screen-sub">A private photo timeline for tracking a plant from seedling to harvest. Use the title field as a plant nickname to keep entries for the same plant easy to spot.</p>
    <form method="POST" action="/grow-journal" style="margin-bottom:20px;">
      <label class="field-label" style="margin-top:0;">Title (optional)</label>
      <input type="text" name="title" placeholder="e.g. Wedding Cake #1 — Day 12">
      <label class="field-label">Notes</label>
      <textarea name="note" placeholder="What's going on with it today?"></textarea>
      <label class="field-label">Photo</label>
      <div class="photo-picker">
        <div class="photo-upload-box" id="gj-photo-upload-box" onclick="document.getElementById('gj-photo-file-input').click()">
          <div class="up-ic">📷</div>
          <div class="up-txt">Tap to snap or upload a photo (optional)</div>
        </div>
        <input type="file" id="gj-photo-file-input" accept="image/*" style="display:none;">
        <input type="hidden" name="photo" id="gj-photo-data-input">
      </div>
      <button class="btn block" type="submit" style="margin-top:14px;">Add Entry</button>
    </form>
    <script>
      (function() {
        const fileInput = document.getElementById('gj-photo-file-input');
        const photoData = document.getElementById('gj-photo-data-input');
        const uploadBox = document.getElementById('gj-photo-upload-box');
        fileInput.addEventListener('change', () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            photoData.value = reader.result;
            uploadBox.innerHTML = '<div class="photo-preview-wrap"><img src="' + reader.result + '" alt="Preview"></div>';
          };
          reader.readAsDataURL(file);
        });
      })();
    </script>
    ${entries.length ? entries.map(e => `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <b>${esc(e.title || 'Untitled entry')}</b>
          <span class="local-time empty-note" style="padding:0;" data-utc="${e.created_at}Z">${esc(e.created_at)} UTC</span>
        </div>
        ${e.photo ? `<div class="checkin-photo-thumb" style="margin:8px 0;"><img src="${esc(e.photo)}" alt="Grow journal photo"></div>` : ''}
        ${e.note ? `<p style="margin:6px 0 8px;">${esc(e.note)}</p>` : ''}
        <form method="POST" action="/grow-journal/${e.id}/delete" onsubmit="return confirm('Delete this entry? This cannot be undone.')">
          <button type="submit" class="empty-note" style="padding:0;background:none;border:none;color:#a13a3a;cursor:pointer;font-size:inherit;">Delete</button>
        </form>
      </div>
    `).join('') : `<div class="empty-note">No entries yet — log your first one above.</div>`}
  `;
  sendHtml(res, layout({ title: 'Grow Journal', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}
async function handleGrowJournalSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const photoUrl = await storage.uploadPhoto(f.photo || null, 'grow-journal');
  await db.createGrowJournalEntry({ user_id: userId, title: f.title || '', note: f.note || '', photo: photoUrl });
  redirect(res, '/grow-journal');
}
async function handleGrowJournalDelete(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const entry = db.getGrowJournalEntry(Number(id));
  if (!entry || entry.user_id !== userId) return notFound(res);
  await db.deleteGrowJournalEntry(Number(id));
  redirect(res, '/grow-journal');
}

// Social discovery: strains friends love that you haven't tried, using
// data already collected -- no new tracking, just a new lens on it.
function pageFriendsPicks(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const picks = db.getFriendsPicks(userId, 20);
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Friends' Picks</h1>
    <p class="screen-sub">Strains your friends rated 4★ or higher that you haven't checked into yet.</p>
    ${picks.length ? picks.map(p => `
      <a class="library-row" href="/strains/${p.strain.id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(p.strain, 'sm')}
        <div class="info">
          <div class="nm">${esc(p.strain.name)}</div>
          <div class="sub">Loved by ${p.friendNames.map(esc).join(', ')} · ${p.avgRating}★ avg</div>
        </div>
      </a>
    `).join('') : `<div class="empty-note">Nothing to show yet — either your friends haven't rated anything 4★+, or you've already tried everything they love. <a href="/friends">Add more friends</a> or check back later.</div>`}
  `;
  sendHtml(res, layout({ title: "Friends' Picks", active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Custom personal lists -- as many as someone wants ("Morning strains",
// "Date night"), distinct from the single fixed Wishlist.
function pageLists(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const lists = db.listCustomLists(userId);
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Your Lists</h1>
    <p class="screen-sub">Organize strains however makes sense to you — "Morning," "Date night," "Sleep," anything.</p>
    <form method="POST" action="/lists" style="display:flex;gap:8px;margin-bottom:16px;">
      <input type="text" name="name" placeholder="New list name..." required style="flex:1;margin:0;">
      <button class="btn" type="submit" style="white-space:nowrap;">Create</button>
    </form>
    ${lists.length ? lists.map(l => {
      const count = db.listCustomListItems(l.id).length;
      return `
      <div class="library-row">
        <a href="/lists/${l.id}" style="text-decoration:none;color:inherit;flex:1;min-width:0;">
          <div class="info">
            <div class="nm">${esc(l.name)}</div>
            <div class="sub">${count} strain${count === 1 ? '' : 's'}</div>
          </div>
        </a>
        <form method="POST" action="/lists/${l.id}/delete" onsubmit="return confirm('Delete this list? The strains themselves aren\\'t affected, just this list.')">
          <button type="submit" class="empty-note" style="padding:0 6px;background:none;border:none;color:#a13a3a;cursor:pointer;font-size:inherit;">Delete</button>
        </form>
      </div>`;
    }).join('') : `<div class="empty-note">No lists yet — create your first one above.</div>`}
  `;
  sendHtml(res, layout({ title: 'Your Lists', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}
function pageListDetail(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const list = db.getCustomList(Number(id));
  if (!list || list.user_id !== userId) return notFound(res);
  const items = db.listCustomListItems(list.id);
  const body = `
    <a href="/lists" class="empty-note">← Back to your lists</a>
    <h1 class="screen-title">${esc(list.name)}</h1>
    ${items.length ? items.map(s => `
      <div class="library-row">
        <a href="/strains/${s.id}" style="text-decoration:none;color:inherit;display:flex;flex:1;min-width:0;align-items:center;gap:10px;">
          ${strainPhotoTag(s, 'sm')}
          <div class="info">
            <div class="nm">${esc(s.name)}</div>
            <div class="sub">${esc(s.type)} · THC ${esc(s.thc)}</div>
          </div>
        </a>
        <form method="POST" action="/lists/${list.id}/items/${s.id}/toggle">
          <input type="hidden" name="redirect_to" value="/lists/${list.id}">
          <button type="submit" class="empty-note" style="padding:0 6px;background:none;border:none;color:#a13a3a;cursor:pointer;font-size:inherit;">Remove</button>
        </form>
      </div>
    `).join('') : `<div class="empty-note">Nothing here yet — browse the <a href="/strains">strain library</a> and add strains to this list from their page.</div>`}
  `;
  sendHtml(res, layout({ title: list.name, active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}
async function handleListCreate(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const name = String(f.name || '').trim();
  if (name) await db.createCustomList(userId, name);
  redirect(res, '/lists');
}
async function handleListDelete(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const list = db.getCustomList(Number(id));
  if (!list || list.user_id !== userId) return notFound(res);
  await db.deleteCustomList(Number(id));
  redirect(res, '/lists');
}
async function handleListItemToggle(req, res, listId, strainId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const list = db.getCustomList(Number(listId));
  if (!list || list.user_id !== userId) return notFound(res);
  const f = await parseForm(req);
  if (db.isStrainInList(list.id, strainId)) {
    await db.removeStrainFromList(list.id, strainId);
  } else {
    await db.addStrainToList(list.id, strainId);
  }
  redirect(res, f.redirect_to || `/strains/${strainId}`);
}

// Terpene guide -- built directly from the terpenes actually present in
// the strain data, so "X strains" counts stay accurate as the library
// grows rather than being hardcoded numbers that go stale.
const TERPENE_GUIDE = {
  Myrcene: { aroma: 'Earthy, musky, with a hint of ripe fruit', effects: 'Widely associated with relaxed, sedating effects — often cited in the (contested but popular) idea of an "indica couch-lock" feeling.' },
  Linalool: { aroma: 'Floral, like lavender', effects: 'Commonly associated with calming, anti-anxiety effects — the same terpene that gives lavender its reputation for relaxation.' },
  Limonene: { aroma: 'Bright citrus — lemon and orange peel', effects: 'Often associated with uplifted, elevated mood; also found in citrus fruit peels themselves.' },
  Caryophyllene: { aroma: 'Peppery, spicy, woody', effects: 'Unusual among terpenes in that it can bind to the same receptors as cannabinoids; often associated with stress relief.' },
  Pinene: { aroma: 'Sharp pine, like fresh rosemary', effects: 'Associated with alertness and focus; the same terpene responsible for the smell of pine forests.' },
  Humulene: { aroma: 'Earthy, woody, slightly hoppy', effects: 'Also found in hops and used in beer brewing; often associated with mellow, subtle effects.' },
  Terpinolene: { aroma: 'Complex — floral, herbal, with a hint of citrus and pine', effects: 'Less common as a dominant terpene; often associated with uplifted, slightly energetic effects.' },
  Ocimene: { aroma: 'Sweet, herbal, slightly woody', effects: 'Often found alongside Limonene and Pinene; associated with uplifted, energizing effects.' },
};
function pageTerpeneGuide(req, res) {
  const allStrains = db.listStrains({ limit: 5000 });
  const counts = {};
  allStrains.forEach(s => (s.terps || []).forEach(t => { counts[t.n] = (counts[t.n] || 0) + 1; }));
  const entries = Object.entries(TERPENE_GUIDE).sort((a, b) => (counts[b[0]] || 0) - (counts[a[0]] || 0));
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Terpene Guide</h1>
    <p class="screen-sub">Terpenes are the aromatic compounds behind a strain's smell and flavor. Effects here are commonly reported associations, not clinically proven outcomes — everyone responds differently.</p>
    ${entries.map(([name, info]) => `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <h2 style="margin:0;font-size:16px;">${esc(name)}</h2>
          <a href="/strains?terpene=${encodeURIComponent(name)}" class="empty-note" style="padding:0;">${counts[name] || 0} strains →</a>
        </div>
        <p style="margin:6px 0 2px;"><b>Aroma:</b> ${esc(info.aroma)}</p>
        <p style="margin:2px 0 0;"><b>Commonly associated with:</b> ${esc(info.effects)}</p>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Terpene Guide', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Effects Guide -- same spirit as the Terpene Guide, built from the
// effect tags actually present in the strain data rather than a generic
// textbook list. A handful of one-off medical/ailment-style tags that
// leaked into a few older entries (e.g. "Pain relief," "Nausea relief")
// are deliberately excluded here since they're a different category from
// a subjective high-related effect and only appear once or twice each --
// not enough real data behind them to warrant a guide entry.
const EFFECTS_GUIDE = {
  Relaxed: 'A calming, body-easing sensation — tension melts away without necessarily making you drowsy.',
  Happy: 'A general lift in mood, often paired with a simple sense of contentment.',
  Euphoric: 'A stronger, more pronounced sense of elation or bliss than a general mood lift.',
  Uplifted: 'A bright, energizing shift in mood — often felt mentally before anything physical.',
  Sleepy: 'A sedating, drowsy pull, most often reported with indica-leaning strains and evening use.',
  Energetic: 'A physical and mental boost, commonly associated with sativa-leaning strains.',
  Creative: 'A reported increase in imaginative or associative thinking.',
  Focused: 'A sense of sharpened attention or mental clarity.',
  Hungry: 'Increased appetite — sometimes called "the munchies."',
  Talkative: 'An increased urge to socialize and chat.',
  Tingly: 'A physical sensation often reported at the very start of a high, before other effects settle in.',
  Aroused: 'Increased physical sensitivity reported by some users.',
  Social: 'A general ease and enjoyment in group settings.',
  Calm: 'A settled, even-keeled mental state without necessarily being sedating.',
  Giggly: 'A lighthearted, laughter-prone mood.',
  'Clear-headed': 'A functional high without much mental fog, often reported with balanced hybrids.',
};
function pageEffectsGuide(req, res) {
  const allStrains = db.listStrains({ limit: 5000 });
  const counts = {};
  allStrains.forEach(s => (s.effects || []).forEach(e => { counts[e] = (counts[e] || 0) + 1; }));
  const entries = Object.entries(EFFECTS_GUIDE).sort((a, b) => (counts[b[0]] || 0) - (counts[a[0]] || 0));
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Effects Guide</h1>
    <p class="screen-sub">What people commonly report feeling from each effect tag — reported associations, not guaranteed outcomes. Everyone responds differently.</p>
    ${entries.map(([name, description]) => `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <h2 style="margin:0;font-size:16px;">${esc(name)}</h2>
          <a href="/strains?effect=${encodeURIComponent(name)}" class="empty-note" style="padding:0;">${counts[name] || 0} strains →</a>
        </div>
        <p style="margin:6px 0 0;">${esc(description)}</p>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Effects Guide', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Mood-Based Strain Finder -- a goal-first shortcut into the same effects
// data behind the Effects Guide and strain filters, but with real scoring
// (strains matching more of a goal's effects rank higher) rather than a
// single-effect filter link. Verification tier breaks ties so a
// well-documented strain surfaces ahead of a same-scoring one with mostly
// blank fields.
const MOOD_GOALS = {
  sleep: { label: 'Fall Asleep', icon: '😴', effects: ['Sleepy', 'Relaxed'] },
  energize: { label: 'Get Energized', icon: '⚡', effects: ['Energetic', 'Uplifted'] },
  socialize: { label: 'Socialize', icon: '😊', effects: ['Talkative', 'Social', 'Giggly'] },
  focus: { label: 'Focus', icon: '🎯', effects: ['Focused', 'Clear-headed'] },
  relax: { label: 'Relax & Unwind', icon: '😌', effects: ['Relaxed', 'Calm'] },
  create: { label: 'Get Creative', icon: '🎨', effects: ['Creative', 'Uplifted'] },
  mood: { label: 'Lift My Mood', icon: '😄', effects: ['Happy', 'Euphoric'] },
  appetite: { label: 'Boost Appetite', icon: '🍕', effects: ['Hungry', 'Relaxed'] },
};
const TIER_RANK = { verified: 2, partial: 1, listed: 0 };
function pageMoodFinder(req, res, query) {
  const goalKey = query.get('goal');
  const goal = goalKey && MOOD_GOALS[goalKey];
  if (!goal) {
    const body = `
      <a href="/more" class="empty-note">← Back</a>
      <h1 class="screen-title">What's the goal?</h1>
      <p class="screen-sub">Pick what you're going for, and we'll match it against real effect data from your library.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${Object.entries(MOOD_GOALS).map(([key, g]) => `
          <a href="/mood-finder?goal=${key}" class="card" style="text-decoration:none;color:inherit;text-align:center;padding:18px 10px;">
            <div style="font-size:28px;">${g.icon}</div>
            <div style="margin-top:6px;font-weight:600;">${esc(g.label)}</div>
          </a>
        `).join('')}
      </div>
    `;
    return sendHtml(res, layout({ title: 'Mood Finder', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
  }
  const allStrains = db.listStrains({ limit: 5000 });
  const scored = allStrains
    .map(s => {
      const overlap = (s.effects || []).filter(e => goal.effects.includes(e)).length;
      return { s, score: overlap, tier: TIER_RANK[strainVerificationTier(s)] };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.tier - a.tier || a.s.name.localeCompare(b.s.name))
    .slice(0, 20);
  const body = `
    <a href="/mood-finder" class="empty-note">← Pick a different goal</a>
    <h1 class="screen-title">${goal.icon} ${esc(goal.label)}</h1>
    <p class="screen-sub">Matched against strains tagged ${goal.effects.map(esc).join(' or ')}.</p>
    ${scored.length ? scored.map(({ s }) => `
      <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(s, 'sm')}
        <div class="info">
          <div class="nm">${esc(s.name)} <span title="${esc(VERIFICATION_BADGE[strainVerificationTier(s)].label)}">${VERIFICATION_BADGE[strainVerificationTier(s)].icon}</span></div>
          <div class="sub">${esc(s.type)} · ${s.effects.map(esc).join(', ')}</div>
        </div>
      </a>
    `).join('') : `<div class="empty-note">No strains matched this goal yet.</div>`}
  `;
  sendHtml(res, layout({ title: goal.label, active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Breeder Guide -- blurbs are only included where there's real, justified
// knowledge behind them (either well-documented cannabis history for
// classic seed banks, or specifics learned while researching dispensary
// strains for this library). Breeders without a confidently-sourced blurb
// still get listed with their strain count, just without invented detail.
const BREEDER_GUIDE = {
  'TGA Seeds': "Subcool's Oregon-based outfit, known for terpene-forward sativas like Jack the Ripper and Agent Orange.",
  'DNA Genetics': 'Amsterdam-and-LA breeder behind LA Confidential, Chocolope, and Kosher Kush, with multiple Cannabis Cup wins.',
  'Sensi Seeds': 'One of the original Amsterdam seed banks (founded 1985), known for classic genetics like Skunk #1 and Northern Lights.',
  'Dutch Passion Seed Company': 'One of the oldest Dutch seed banks (founded 1987), known for stable, reliable genetics since the earliest days of legal breeding.',
  'Green House Seed Co.': "Arjan Roskam's Amsterdam brand, famous for Super Silver Haze and White Widow, with a long Cannabis Cup history.",
  'Rare Dankness Seeds': 'Colorado breeder known for high-THC hybrids like Moonshine Haze and Ghost Train Haze.',
  'CBX Cannabiotix': 'Boutique California/Nevada brand founded in 2014, known for potent, resin-heavy indica and OG-leaning genetics.',
  'Exotic Genetix': 'Washington-state breeder behind Donkey Butter, Black Mamba, and Cookies and Cream.',
  'Nirvana': 'Dutch seed bank known for affordable, dependable genetics like Bubblelicious and Papaya.',
  'Flying Dutchmen Seed Company': "One of Amsterdam's oldest seed banks, with deep roots in Northern Lights genetics.",
  'The Cali Connection': 'California breeder known for OG Kush-family genetics.',
  'T.H.Seeds': 'Amsterdam-based breeder known for Kushage and Sage \'n Sour.',
  'Paradise Seeds': 'Dutch breeder known for consistent, easy-to-grow genetics.',
  'Soma Seeds': 'Amsterdam breeder behind Somango and NYC Diesel.',
  'Bodhi Seeds': 'West Coast breeder known for weaving rare and landrace genetics into modern crosses.',
  'Big Buddha Seeds': 'UK-based breeder known for Big Buddha Cheese.',
  'DJ Short': 'Legendary breeder widely credited with stabilizing the original Blueberry line.',
  'Royal Queen': 'Large modern European seed bank with a broad, accessible catalog.',
  'Serious Seeds': 'Amsterdam breeder behind AK-47, Chronic, and Kali Mist -- all multiple award winners.',
  'Seed Junky Genetics': "JBeezy's influential Southern California outfit behind Wedding Cake, Ice Cream Cake, Kush Mints, and Jealousy.",
  'Compound Genetics': 'Known for complex multi-generation crosses like Pink Certz and The Menthol.',
  'Mr. Sherbinski': 'San Francisco breeder credited as the root of the entire Sherbet/Gelato/Runtz family tree, starting with Pink Panties.',
  'A Golden State': '"Inhale, Exhale, Elevate" -- Southern California brand behind Moonbeam and Lava Flower.',
  'Claybourne Co.': "Los Angeles brand with an in-house breeding and selection program, known for its Gold Cuts premium line.",
  'Alien Labs': 'Skate-culture-inspired Redding, CA brand known for proprietary, high-potency genetics like Zookies and Atomic Apple.',
  'Craft Farmer Genetics': 'Known for candy-gas hybrids like Galactic Warheads.',
  'Reeferman Seeds': 'Canadian breeder known for preserving landrace and heirloom genetics rather than chasing the newest hybrid trends.',
  'Reserva Privada': "DNA Genetics' more exclusive sister imprint, known for certified cuts of strains like Kosher Kush and OG Kush.",
  'Shantibaba': 'Legendary individual breeder -- co-founder of Green House Seed Co., later founder of Mr. Nice Seedbank and Ceres Seeds.',
  'Sagarmatha Seeds': 'Amsterdam breeder known for high-THC genetics like Yumbolt and Blue Ice.',
  'K.C. Brains': 'One of the older Dutch seed banks, known for its own numbered K.C. strain series.',
};
function pageBreederGuide(req, res) {
  const allStrains = db.listStrains({ limit: 5000 });
  const counts = {};
  allStrains.forEach(s => { if (s.breeder) counts[s.breeder] = (counts[s.breeder] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40);
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Breeder Guide</h1>
    <p class="screen-sub">Who's actually behind the strains in your library — from classic Amsterdam seed banks to the modern California brands you'll find on real dispensary shelves.</p>
    ${sorted.map(([name, count]) => `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <h2 style="margin:0;font-size:16px;">${esc(name)}</h2>
          <a href="/strains?breeder=${encodeURIComponent(name)}" class="empty-note" style="padding:0;">${count} strain${count === 1 ? '' : 's'} →</a>
        </div>
        ${BREEDER_GUIDE[name] ? `<p style="margin:6px 0 0;">${esc(BREEDER_GUIDE[name])}</p>` : ''}
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Breeder Guide', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageWishlist(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const items = db.getWishlist(userId);
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Your Wishlist</h1>
    <p class="screen-sub">Strains you've spotted and want to try next — separate from Collection, which only tracks what you've actually checked into.</p>
    ${items.length ? items.map(s => `
      <div class="library-row">
        <a href="/strains/${s.id}" style="text-decoration:none;color:inherit;display:flex;flex:1;min-width:0;align-items:center;gap:10px;">
          ${strainPhotoTag(s, 'sm')}
          <div class="info">
            <div class="nm">${esc(s.name)}</div>
            <div class="sub">${esc(s.type)} · THC ${esc(s.thc)}</div>
          </div>
        </a>
        <form method="POST" action="/wishlist/${s.id}/toggle">
          <input type="hidden" name="redirect_to" value="/wishlist">
          <button type="submit" class="empty-note" style="padding:0 6px;background:none;border:none;color:#a13a3a;cursor:pointer;font-size:inherit;">Remove</button>
        </form>
      </div>
    `).join('') : `<div class="empty-note">Nothing here yet — browse the <a href="/strains">strain library</a> and tap "Add to Wishlist" on anything that catches your eye.</div>`}
  `;
  sendHtml(res, layout({ title: 'Your Wishlist', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Trending -- what the whole community has been checking into lately,
// using data already collected for community ratings, just aggregated
// over a recent window instead of all-time.
function pageTrending(req, res) {
  const userId = auth.currentUserId(req);
  const windowDays = 7;
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const recent = db.listCheckins({ limit: 100000 }).filter(c => (c.created_at + 'Z') >= cutoff);
  const counts = {};
  recent.forEach(c => { counts[c.strain_id] = (counts[c.strain_id] || 0) + 1; });
  const ranked = Object.entries(counts)
    .map(([id, count]) => ({ s: db.getStrain(id), count }))
    .filter(x => x.s)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Trending This Week</h1>
    <p class="screen-sub">The most checked-into strains across StrainDex in the last ${windowDays} days.</p>
    ${ranked.length ? ranked.map((r, i) => `
      <a class="library-row" href="/strains/${r.s.id}" style="text-decoration:none;color:inherit;">
        <span style="font-weight:700;color:var(--ink-secondary);width:22px;text-align:center;">${i + 1}</span>
        ${strainPhotoTag(r.s, 'sm')}
        <div class="info">
          <div class="nm">${esc(r.s.name)}</div>
          <div class="sub">${r.count} check-in${r.count === 1 ? '' : 's'} this week</div>
        </div>
      </a>
    `).join('') : `<div class="empty-note">No check-in data yet this week — check back soon.</div>`}
  `;
  sendHtml(res, layout({ title: 'Trending This Week', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Mixing cautions -- deliberately conservative, pattern-level guidance
// only (matching the app's existing "not medical advice" framing), never
// dosing specifics. General public-health caution categories, not a
// comprehensive drug-interaction database.
function pageMixingCautions(req, res) {
  const cautions = [
    { title: 'Alcohol', body: 'Combining cannabis and alcohol tends to intensify the effects of both, and impairment can hit harder and less predictably than either alone. This combination is also linked to a much higher risk of nausea ("greening out"). If combining at all, go slower and lower on both than you normally would with either individually.' },
    { title: 'Sedatives & sleep medication', body: 'Cannabis is itself sedating for many people, and combining it with prescription sedatives, sleep aids, or benzodiazepines can compound drowsiness and impaired coordination well beyond what either produces alone. Talk to the prescribing doctor before combining.' },
    { title: 'Stimulants', body: 'Combining cannabis with stimulants (including prescription ADHD medication or high caffeine intake) can mask how impaired or wired you actually are, since the two pull in different directions — makes it easy to misjudge your own state.' },
    { title: 'Blood thinners & some heart/blood pressure medications', body: 'Cannabis can affect heart rate and blood pressure, and may interact with how the liver processes certain medications, including some blood thinners. This is genuinely a "talk to your doctor or pharmacist" situation, not a guess-and-check one.' },
    { title: 'Driving or operating machinery', body: "Cannabis impairs reaction time and judgment in ways that don't always feel as obvious as alcohol impairment does. Treat any active THC in your system the same as you would being over a legal alcohol limit — don't drive." },
    { title: 'Pregnancy & breastfeeding', body: 'Major health organizations advise against cannabis use during pregnancy and while breastfeeding due to potential effects on fetal and infant development. This one has clear medical consensus — talk to an OB or pediatrician directly rather than relying on general guidance here.' },
  ];
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Mixing With Other Substances</h1>
    <p class="screen-sub">General, pattern-level cautions — not medical advice, not a complete interaction database, and not a substitute for talking to a doctor or pharmacist about your specific medications.</p>
    ${cautions.map(c => `
      <div class="card" style="margin-bottom:10px;">
        <h2 style="margin:0 0 6px;font-size:15px;">${esc(c.title)}</h2>
        <p style="margin:0;">${esc(c.body)}</p>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Mixing With Other Substances', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageQuiz(req, res, query) {
  const exp = query.get('exp') || '';
  const feel = query.get('feel') || '';
  const time = query.get('time') || '';
  const answered = exp && feel && time;
  let results = [];
  if (answered) {
    const thcFilter = exp === 'new' ? 'Low' : exp === 'some' ? 'Medium' : 'All';
    // listStrains() always sorts alphabetically before applying `limit` --
    // fine for browsing, but deadly here: a capped limit meant the quiz was
    // only ever scoring the first ~500 strains alphabetically within a THC
    // bucket, and tied scores (common, since there are only a handful of
    // effect tags to match against) fell back to that same alphabetical
    // order via Array.sort's stability. Net effect: results always looked
    // like "the first five A-named strains in this bucket," every time.
    // Fix: pull every strain in the bucket (no meaningful cap at this
    // scale), then shuffle before scoring so ties resolve randomly instead
    // of alphabetically -- so retaking the quiz with the same answers
    // actually surfaces different strains from the library, not the same
    // five every time.
    const candidates = db.listStrains({ thc: thcFilter, limit: 5000 });
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const feelTags = QUIZ_FEEL_TAGS[feel] || [];
    const timeTags = QUIZ_TIME_TAGS[time] || [];
    const scored = candidates.map(s => {
      const feelHits = s.effects.filter(e => feelTags.includes(e)).length;
      const timeHits = s.effects.filter(e => timeTags.includes(e)).length;
      return { s, score: feelHits * 2 + timeHits };
    }).sort((a, b) => b.score - a.score);
    results = (scored[0] && scored[0].score > 0 ? scored.filter(x => x.score > 0) : scored).slice(0, 5).map(x => x.s);
  }
  const radioGroup = (name, opts, current) => opts.map(([val, label]) =>
    `<label style="display:block;padding:10px 12px;margin-bottom:6px;border:1px solid var(--border);border-radius:10px;cursor:pointer;${current === val ? 'border-color:var(--brand-green);background:var(--brand-green-pale,#eef6ee);' : ''}">
      <input type="radio" name="${name}" value="${val}" ${current === val ? 'checked' : ''} style="margin-right:8px;">${esc(label)}
    </label>`).join('');
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Find Your First Strain</h1>
    <p class="screen-sub">Three quick questions, matched against real THC and effect data — a starting point, not a prescription.</p>
    <form method="GET" action="/quiz">
      <label class="field-label" style="margin-top:0;">How much cannabis experience do you have?</label>
      ${radioGroup('exp', [['new', "I'm new to this"], ['some', 'Some experience'], ['experienced', 'Very experienced']], exp)}
      <label class="field-label">What are you hoping to feel?</label>
      ${radioGroup('feel', [['relaxed', 'Relaxed and calm'], ['happy', 'Happy and social'], ['creative', 'Creative and focused'], ['energetic', 'Energetic and active']], feel)}
      <label class="field-label">When will you use it?</label>
      ${radioGroup('time', [['morning', 'Morning / daytime'], ['evening', 'Evening / nighttime'], ['anytime', 'Anytime']], time)}
      <button class="btn block" type="submit" style="margin-top:10px;">${answered ? 'Update Matches' : 'Find Matches'}</button>
    </form>
    ${answered ? `
      <h2 class="screen-title" style="margin-top:20px;">Your matches</h2>
      ${results.length ? results.map(s => `
        <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
          ${strainPhotoTag(s, 'sm')}
          <div class="info">
            <div class="nm">${esc(s.name)}</div>
            <div class="sub">${esc(s.type)} · THC ${esc(s.thc)} · ${s.effects.slice(0, 3).join(', ')}</div>
          </div>
        </a>`).join('') : `<div class="empty-note">No close matches — try a different combination above.</div>`}
    ` : ''}
  `;
  sendHtml(res, layout({ title: 'Find Your First Strain', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Personal "your patterns" page -- distinct from /business, which is an
// app-wide trending dashboard. This reflects one account's own check-in
// history back at them: effects, type, method, and standout strains.
function pageInsights(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const insights = db.getUserInsights(userId);
  const activeBreak = db.getActiveBreak(userId);
  const daysSince = (dateStr) => Math.max(0, Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 86400000));
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Your Patterns</h1>
    <div class="card" style="margin-bottom:14px;">
      <h2 style="margin:0 0 8px;font-size:15px;">🌿 Tolerance break</h2>
      ${activeBreak ? `
        <p class="empty-note" style="padding:0 0 8px;">You're on a break — started ${daysSince(activeBreak.started_at)} day${daysSince(activeBreak.started_at) === 1 ? '' : 's'} ago${activeBreak.note ? `: "${esc(activeBreak.note)}"` : '.'}</p>
        <form method="POST" action="/tolerance-break/end"><button class="btn secondary block" type="submit">End Break</button></form>
      ` : `
        <p class="empty-note" style="padding:0 0 8px;">Not currently on a break.</p>
        <form method="POST" action="/tolerance-break/start">
          <input type="text" name="note" placeholder="Optional note — why are you taking this one?" style="margin-bottom:8px;">
          <button class="btn block" type="submit">Start a Tolerance Break</button>
        </form>
      `}
    </div>
    ${!insights ? `<div class="empty-note">No check-ins logged yet — <a href="/checkin">log your first one</a> to start seeing your patterns here.</div>` : `
      <p class="screen-sub">Based on your ${insights.totalCheckins} check-in${insights.totalCheckins === 1 ? '' : 's'} so far.</p>
      ${insights.topEffects.length ? `
        <div class="card">
          <h2 style="margin:0 0 8px;font-size:15px;">Your most common effects</h2>
          <p>${insights.topEffects.map(e => `<span class="filter-pill">${esc(e.name)} (${e.count})</span>`).join('')}</p>
        </div>
      ` : ''}
      <div class="card" style="margin-top:12px;">
        <h2 style="margin:0 0 8px;font-size:15px;">Your leanings</h2>
        ${insights.topType ? `<p class="empty-note" style="padding:2px 0;">You gravitate toward <b>${esc(insights.topType.name)}</b> strains (${insights.topType.count} check-in${insights.topType.count === 1 ? '' : 's'}).</p>` : ''}
        ${insights.topMethod ? `<p class="empty-note" style="padding:2px 0;">Your most-used method is <b>${esc(insights.topMethod.name)}</b>.</p>` : ''}
        ${insights.topTerpene ? `<p class="empty-note" style="padding:2px 0;">Your check-ins lean heaviest on <b>${esc(insights.topTerpene)}</b> as a terpene.</p>` : ''}
      </div>
      ${insights.mostLoggedStrain ? `
        <a class="library-row" href="/strains/${insights.mostLoggedStrain.strain.id}" style="text-decoration:none;color:inherit;margin-top:12px;">
          ${strainPhotoTag(insights.mostLoggedStrain.strain, 'sm')}
          <div class="info">
            <div class="nm">Most logged: ${esc(insights.mostLoggedStrain.strain.name)}</div>
            <div class="sub">${insights.mostLoggedStrain.count} check-in${insights.mostLoggedStrain.count === 1 ? '' : 's'}</div>
          </div>
        </a>` : ''}
      ${insights.topRatedStrain ? `
        <a class="library-row" href="/strains/${insights.topRatedStrain.strain.id}" style="text-decoration:none;color:inherit;margin-top:8px;">
          ${strainPhotoTag(insights.topRatedStrain.strain, 'sm')}
          <div class="info">
            <div class="nm">Your highest rated: ${esc(insights.topRatedStrain.strain.name)}</div>
            <div class="sub">${starString(Math.round(insights.topRatedStrain.avg))} (${insights.topRatedStrain.avg}★ average)</div>
          </div>
        </a>` : ''}
    `}
  `;
  sendHtml(res, layout({ title: 'Your Patterns', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

async function handleToleranceBreakStart(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  await db.startToleranceBreak(userId, f.note || '');
  redirect(res, '/insights');
}
async function handleToleranceBreakEnd(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.endToleranceBreak(userId);
  redirect(res, '/insights');
}

function pageFeedback(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const sent = query.get('sent');
  const body = `
    <h1 class="screen-title">Send Feedback</h1>
    <p class="screen-sub">StrainDex is in beta — bugs, ideas, confusing screens, anything at all. This goes straight to the person building the app.</p>
    <p class="empty-note">For anything urgent — a compromised account, a safety concern, or a bad actor on the app — email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> directly instead of using the form below, since it's monitored more closely.</p>
    ${sent ? `<p class="empty-note" style="color:var(--brand-green-dark);">Thanks — your feedback was sent.</p>` : ''}
    <form method="POST" action="/feedback">
      <label class="field-label" style="margin-top:0;">Your feedback</label>
      <textarea name="message" required minlength="3" maxlength="4000" placeholder="What's on your mind?" style="min-height:140px;"></textarea>
      <button class="btn block" type="submit" style="margin-top:14px;">Send</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Send Feedback', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}
async function handleFeedbackSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const message = String(fields.message || '').trim();
  if (!message) return redirect(res, '/feedback');
  const feedback = await db.createFeedback({ user_id: userId, message });

  if (process.env.FEEDBACK_NOTIFY_EMAIL) {
    const user = db.getUserById(userId);
    await sendEmail({
      to: process.env.FEEDBACK_NOTIFY_EMAIL,
      subject: `StrainDex feedback from ${user ? user.username : 'a user'}`,
      html: `<p><b>${esc(user ? user.username : 'Unknown user')}</b> (${user && user.email ? esc(user.email) : 'no email on file'}) sent this feedback:</p>
        <p style="white-space:pre-wrap;">${esc(message)}</p>
        <p><a href="https://${req.headers.host}/admin/feedback">View all feedback in the admin panel</a></p>`,
    });
  }

  redirect(res, '/feedback?sent=1');
}

function pageForgotPassword(req, res, query) {
  const sent = query.get('sent');
  const body = `
    <h1 class="screen-title">Forgot Password</h1>
    ${sent
      ? `<p class="empty-note">If that email is on an account, a reset link is on its way — check your inbox (and spam folder).</p>`
      : `<p class="screen-sub">Enter the email on your account and we'll send a link to reset your password.</p>
      <form method="POST" action="/forgot-password">
        <label class="field-label" style="margin-top:0;">Email</label>
        <input type="email" name="email" required autocomplete="email">
        <button class="btn block" type="submit" style="margin-top:14px;">Send Reset Link</button>
      </form>`}
    <p class="empty-note" style="margin-top:12px;"><a href="/login">Back to log in</a></p>
  `;
  sendHtml(res, layout({ title: 'Forgot Password', body }));
}
async function handleForgotPasswordSubmit(req, res) {
  const f = await parseForm(req);
  const email = String(f.email || '').trim().toLowerCase();
  const user = email ? db.getUserByEmail(email) : null;
  // Always show the same "check your inbox" message whether or not the
  // email matched an account -- confirming which emails ARE registered
  // is its own small privacy leak, so this path stays silent either way.
  if (user) {
    const token = await db.createPasswordResetToken(user.id);
    const resetUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/reset-password?token=${token}`;
    await sendEmail({
      to: email,
      subject: 'Reset your StrainDex password',
      html: `<p>Someone requested a password reset for your StrainDex account.</p>
        <p><a href="${esc(resetUrl)}">Click here to set a new password</a> — this link expires in 1 hour.</p>
        <p>If you didn't request this, you can safely ignore this email.</p>`,
    });
  }
  redirect(res, '/forgot-password?sent=1');
}
function pageResetPassword(req, res, query) {
  const token = query.get('token') || '';
  const err = query.get('err');
  const errMessages = {
    mismatch: "Passwords didn't match.",
    short: 'Password must be at least 8 characters.',
    invalid_token: 'This reset link is invalid or has expired — request a new one.',
  };
  const body = `
    <h1 class="screen-title">Reset Password</h1>
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    ${err === 'invalid_token' ? `<p class="empty-note"><a href="/forgot-password">Request a new reset link</a></p>` : `
    <form method="POST" action="/reset-password">
      <input type="hidden" name="token" value="${esc(token)}">
      <label class="field-label" style="margin-top:0;">New password</label>
      <input type="password" name="password" required minlength="8" autocomplete="new-password">
      <label class="field-label">Confirm new password</label>
      <input type="password" name="password2" required minlength="8" autocomplete="new-password">
      <button class="btn block" type="submit" style="margin-top:14px;">Set New Password</button>
    </form>`}
  `;
  sendHtml(res, layout({ title: 'Reset Password', body }));
}
async function handleResetPasswordSubmit(req, res) {
  const f = await parseForm(req);
  const token = String(f.token || '');
  if (f.password !== f.password2) return redirect(res, `/reset-password?token=${encodeURIComponent(token)}&err=mismatch`);
  if ((f.password || '').length < 8) return redirect(res, `/reset-password?token=${encodeURIComponent(token)}&err=short`);
  const userId = await db.consumePasswordResetToken(token);
  if (userId == null) return redirect(res, '/reset-password?err=invalid_token');
  await db.resetPasswordWithToken(userId, f.password);
  redirect(res, '/login');
}
async function handleLoginSubmit(req, res) {
  const f = await parseForm(req);
  const username = String(f.username || '').trim();
  if (isLoginRateLimited(req, username)) return redirect(res, '/login?err=rate_limited');
  const user = db.verifyLogin(username, f.password || '');
  if (!user) {
    recordFailedLogin(req, username);
    return redirect(res, '/login?err=1');
  }
  clearLoginAttempts(req, username);
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
    <div class="card"><a href="/admin/feedback">💬 Feedback (${db.listFeedback().length})</a></div>
    <div class="card"><a href="/admin/faqs">📋 Manage FAQ (${db.listFaqs().length})</a></div>
    <div class="card"><a href="/admin/recipes">🍽️ Manage Recipes (${db.listRecipes({ status: null }).length}${pendingCount ? `, ${pendingCount} pending` : ''})</a></div>
    <div class="card"><a href="/admin/strains">🌿 Manage Strains (${db.countStrains().toLocaleString()})</a></div>
    <div class="card"><a href="/admin/logout">🚪 Log out</a></div>
  `;
  sendHtml(res, layout({ title: 'Admin', body, isAdmin: true }));
}

function pageAdminFeedback(req, res) {
  if (!requireAdmin(req, res)) return;
  const items = db.listFeedback();
  const body = `
    <a href="/admin" class="empty-note">← Back to Admin</a>
    <h1 class="screen-title" style="margin-top:8px;">Feedback (${items.length})</h1>
    ${items.length === 0 ? `<p class="empty-note">No feedback submitted yet.</p>` : items.map(f => {
      const user = f.user_id != null ? db.getUserById(f.user_id) : null;
      return `<div class="admin-row" style="flex-direction:column;align-items:stretch;">
        <div class="empty-note" style="padding:0;">${user ? esc(user.username) : 'Anonymous'} · <span class="local-time" data-utc="${esc(f.created_at)}Z">${esc(f.created_at)}</span></div>
        <p style="margin:6px 0 0;white-space:pre-wrap;">${esc(f.message)}</p>
      </div>`;
    }).join('')}
  `;
  sendHtml(res, layout({ title: 'Feedback', body, isAdmin: true }));
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
  const ailment = query.get('ailment') || 'All';
  const breeder = query.get('breeder') || 'All';
  const verified = query.get('verified') || 'All';
  const limit = Math.min(Number(query.get('limit')) || 60, 200);
  sendJson(res, {
    total: db.countStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder, verified }),
    results: db.listStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder, verified, limit }),
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
async function apiCheckinKudos(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const { checkin, given } = await db.toggleCheckinKudos(id, userId);
  if (!checkin) return sendJson(res, { error: 'not found' }, 404);
  const givers = db.listCheckinKudosGivers(id).map(u => u.username);
  sendJson(res, { kudos: checkin.kudos, given, givers });
}
async function apiCommentLike(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const result = await db.toggleCommentLike(id, userId);
  sendJson(res, result);
}
// Plain-HTML-form submit (not a fetch/API call) since the same check-in can
// render on three different pages (Home, a strain's page, a friend's
// profile) -- redirect_to is a hidden field carrying which page to bounce
// back to, set by renderCheckinComments() at render time.
async function handleCheckinComment(req, res, checkinId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const body = (f.body || '').trim();
  if (body) await db.createCheckinComment({ checkin_id: checkinId, user_id: userId, body });
  redirect(res, f.redirect_to || '/');
}
// Protected analytics endpoint for the Google Sheets automation -- returns
// real usernames, emails, and birth dates, so it's gated behind a shared
// secret (ANALYTICS_API_KEY) rather than being a public JSON endpoint like
// /api/strains. Set ANALYTICS_API_KEY in Render, and use the same value
// in the Apps Script that calls this.
function apiAnalyticsSnapshot(req, res, query) {
  const key = query.get('key') || '';
  const expected = process.env.ANALYTICS_API_KEY;
  if (!expected) return sendJson(res, { error: 'ANALYTICS_API_KEY not configured on the server' }, 500);
  if (key !== expected) return sendJson(res, { error: 'unauthorized' }, 401);
  sendJson(res, db.getAnalyticsSnapshot());
}

// ---------------------------------------------------------------- static

// ---------------------------------------------------------------- more hub

function pageMore(req, res) {
  const userId = auth.currentUserId(req);
  const user = userId != null ? db.getUserById(userId) : null;
  // Grouped into sections rather than one long flat list -- this menu has
  // grown a lot as features shipped, and a flat grid stops being scannable
  // well before a dozen tiles. /strains and /growing are intentionally left
  // out entirely since they're already one tap away on the bottom nav.
  // Events/Shop/Business stay hidden too -- still running on demo data,
  // not deleted, just not surfaced here until they're real.
  const sections = [
    {
      title: 'Discover',
      tiles: [
        { href: '/quiz', icon: '🧭', t: 'Find Your First Strain', s: '3-question strain matcher' },
        { href: '/mood-finder', icon: '🎯', t: 'Mood Finder', s: 'Pick a goal, get matched strains' },
        { href: '/compare', icon: '⚖️', t: 'Compare Strains', s: 'Side-by-side lookup' },
        { href: '/surprise-me', icon: '🎲', t: 'Surprise Me', s: 'One random strain you haven\u2019t tried' },
        { href: '/trending', icon: '🔥', t: 'Trending This Week', s: 'Most checked-into right now' },
      ],
    },
    {
      title: 'Your Journey',
      tiles: [
        { href: '/collection', icon: '/docs/leaf-kudos.png', t: 'My Collection', s: 'Your binder & rarity progress' },
        { href: '/wishlist', icon: '⭐', t: 'Wishlist', s: 'Strains you want to try next' },
        { href: '/grow-journal', icon: '📔', t: 'Grow Journal', s: 'Your private plant photo log' },
        { href: '/lists', icon: '📋', t: 'Your Lists', s: 'Custom groupings — Morning, Sleep, anything' },
        { href: '/history', icon: '🕐', t: 'Check-In History', s: 'Your full timeline' },
        { href: '/insights', icon: '📊', t: 'Your Patterns', s: 'What your check-ins say about you' },
        { href: '/insights', icon: '🌿', t: 'Tolerance Break', s: 'Start, track, or end a break' },
      ],
    },
    {
      title: 'Learn & Stay Safe',
      tiles: [
        { href: '/methods', icon: '/docs/joint-icon.png', t: 'Ways to Enjoy It', s: 'Every method, explained' },
        { href: '/concentrates', icon: '💠', t: 'Concentrates & Extracts', s: 'Kief, rosin, live resin & more' },
        { href: '/legal-status', icon: '⚖️', t: 'Is It Legal Near Me?', s: 'State-by-state cannabis law' },
        { href: '/mixing-cautions', icon: '⚠️', t: 'Mixing With Other Substances', s: 'General cautions, not medical advice' },
        { href: '/faq', icon: '❓', t: 'FAQ', s: 'Strain school' },
        { href: '/terpene-guide', icon: '🌸', t: 'Terpene Guide', s: 'Aroma & effects by terpene' },
        { href: '/effects-guide', icon: '✨', t: 'Effects Guide', s: 'What each effect actually feels like' },
        { href: '/breeder-guide', icon: '🧬', t: 'Breeder Guide', s: 'Who\u2019s actually behind each strain' },
        { href: '/chat', icon: '💬', t: 'Ask', s: 'Chat with the assistant' },
      ],
    },
    {
      title: 'Community & Local',
      tiles: [
        { href: '/trade', icon: '🔁', t: 'Trade', s: 'Swap dupes with real friends' },
        { href: '/friends-picks', icon: '🤝', t: "Friends' Picks", s: 'What your circle loves that you haven\u2019t tried' },
        { href: '/dispensaries', icon: '📍', t: 'Dispensaries', s: 'Locator & live menus' },
      ],
    },
    {
      title: 'Support',
      tiles: [
        { href: '/feedback', icon: '📝', t: 'Send Feedback', s: 'Bugs, ideas — anything' },
      ],
    },
  ];
  const body = `
    <h1 class="screen-title">More</h1>
    ${user ? `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <span>👤 Logged in as <b>${esc(user.username)}</b></span>
        <div style="display:flex;gap:8px;">
          <a href="/account" class="btn secondary" style="text-decoration:none;">Settings</a>
          <form method="POST" action="/logout"><button class="btn secondary" type="submit">Log out</button></form>
        </div>
      </div>` : ''}
    ${sections.map(sec => `
      <div class="section-label" style="margin-top:18px;">${esc(sec.title)}</div>
      <div class="more-grid">
        ${sec.tiles.map(t => `<a class="more-tile" href="${t.href}"><span class="ic">${t.icon.startsWith('/') ? `<img src="${t.icon}" alt="" class="ic-img-lg">` : t.icon}</span><div class="t">${esc(t.t)}</div><div class="s">${esc(t.s)}</div></a>`).join('')}
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'More', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// ---------------------------------------------------------------- terms & privacy
// Plain-language starting points, not a substitute for a lawyer's review --
// especially given the sensitivity of what this app stores (cannabis use
// habits, photos) and that requirements vary by state/country. Get these
// reviewed by an actual attorney before treating them as final.
function pageTerms(req, res) {
  const body = `
    <h1 class="screen-title">Terms of Service</h1>
    <p class="empty-note">Last updated: ${new Date().toISOString().slice(0, 10)}. This expanded draft is currently being reviewed by an attorney and may change before it's finalized.</p>
    <div class="card">
      <p><b>1. Acceptance of terms.</b> By creating an account or otherwise using StrainDex (the "Service"), you agree to be bound by these Terms. If you do not agree, do not use the Service. We may update these Terms from time to time; continued use after an update means you accept the revised Terms.</p>
      <p><b>2. Eligibility.</b> The Service is intended solely for adults 21 and older. By creating an account, you represent that you're at least 21 and that your use of the Service complies with the laws of your jurisdiction. We don't verify the legal status of cannabis where you live — that's on you.</p>
      <p><b>3. What StrainDex is.</b> StrainDex is a personal cannabis journal and informational reference app: check-ins, a strain library, community recipes and growing tips, and a dispensary locator. StrainDex does not sell, deliver, broker, or otherwise facilitate the purchase or transfer of cannabis or cannabis products, and nothing in the app is a marketplace or point of sale.</p>
      <p><b>4. Accounts.</b> You're responsible for keeping your credentials confidential and for all activity under your account. Provide accurate registration information. One account per person — accounts can't be sold, transferred, or shared. We can suspend or terminate accounts that violate these Terms, engage in fraud, or misrepresent age or eligibility.</p>
      <p><b>5. Your content.</b> You keep ownership of what you submit — check-ins, notes, tasting notes, photos, ratings, pairings. By submitting it, you give StrainDex permission to host, store, and display it within the app. You confirm you have the rights to anything you upload.</p>
      <p><b>6. Community-submitted content.</b> Recipes and growing tips are reviewed before publishing, but this is a basic appropriateness check, not a professional or medical certification. Dosing suggestions and techniques reflect individual contributors' opinions, not StrainDex's. You take on the risk of following any community-submitted instructions, especially around dosing.</p>
      <p><b>7. Prohibited conduct.</b> Don't: break applicable law; harass or threaten other users; upload content that infringes someone else's rights; misrepresent your age; scrape or reverse-engineer the Service; or use StrainDex to actually sell, buy, or distribute cannabis or any controlled substance.</p>
      <p><b>8. Not medical advice.</b> Strain effects, THC/CBD percentages, and terpene info come from user reports and published third-party sources, and may not reflect the actual composition of anything you encounter. Nothing here is medical advice or intended to diagnose, treat, cure, or prevent any condition. Talk to a healthcare provider about your own situation.</p>
      <p><b>9. Third-party services.</b> Dispensary information comes from third-party data providers and may be incomplete, outdated, or wrong. We don't verify dispensary licensing, inventory, pricing, or hours — always confirm with the dispensary directly.</p>
      <p><b>10. Intellectual property.</b> The StrainDex name, logo, and underlying software belong to StrainDex and its licensors. Strain photography is used under the Unsplash License and credited to its photographers where applicable.</p>
      <p><b>11. No warranties.</b> The Service is provided "as is" and "as available," without warranties of any kind — including accuracy of strain data, uninterrupted availability, or fitness for a particular purpose.</p>
      <p><b>12. Limitation of liability.</b> To the maximum extent permitted by law, StrainDex is not liable for indirect, incidental, special, consequential, or punitive damages, or loss of data, arising from your use of the Service.</p>
      <p><b>13. Indemnification.</b> You agree to cover StrainDex for claims, damages, or expenses arising from your use of the Service, your content, or your violation of these Terms.</p>
      <p><b>14. Termination.</b> You can delete your account anytime from Account Settings. We can suspend or terminate your access for violating these Terms, with or without notice.</p>
      <p><b>15. Changes.</b> We may modify, suspend, or discontinue any part of the Service, and may revise these Terms, at any time.</p>
      <p><b>16. Governing law.</b> The governing jurisdiction for these Terms is still being finalized with counsel.</p>
      <p><b>17. Severability.</b> If any part of these Terms is found unenforceable, the rest stays in effect.</p>
      <p><b>18. Entire agreement.</b> These Terms plus the Privacy Policy make up the whole agreement between you and StrainDex about the Service.</p>
    </div>
    <p class="empty-note">Questions about these terms? Reach out through <a href="/feedback">Send Feedback</a>.</p>
  `;
  sendHtml(res, layout({ title: 'Terms of Service', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pagePrivacy(req, res) {
  const body = `
    <h1 class="screen-title">Privacy Policy</h1>
    <p class="empty-note">Last updated: ${new Date().toISOString().slice(0, 10)}. This expanded draft is currently being reviewed by an attorney and may change before it's finalized, particularly around jurisdiction-specific requirements (CCPA, GDPR, etc.).</p>
    <div class="card">
      <p><b>1. Overview.</b> This explains what StrainDex collects, how it's used, and your choices. We collect only what's needed to run the app and don't sell personal information to advertisers or data brokers.</p>
      <p><b>2. What we collect.</b> Account info (username, email, a securely hashed password, birth date to confirm age). User content (check-ins, tasting notes, food/drink/entertainment/activity pairings, photos, recipes, grow tips). Location, only when you use "find dispensaries near me" — not stored after the search. Basic technical/error logs. A single first-party session cookie to keep you logged in — no third-party ad-tracking cookies.</p>
      <p><b>3. How we use it.</b> To run check-ins, the strain library, recipes, growing tips, dispensary search, and friends features; to keep your account secure; to send account emails like password resets; to respond to feedback you submit; to fix bugs through error monitoring; and to generate aggregate, non-identifying usage stats.</p>
      <p><b>4. Who we share it with.</b> We don't sell your data. We use service providers who each process data only to provide their service to us: our database host, our app host, our photo storage provider, our transactional email provider, our error-monitoring provider, and a dispensary-location lookup service. We may also disclose information if required by law.</p>
      <p><b>5. How long we keep it.</b> As long as your account is active. If you delete your account, your personal data is removed; any recipe or grow tip you shared publicly stays up but is reattributed to "Former user."</p>
      <p><b>6. Your rights.</b> Export your data or permanently delete your account anytime from Account Settings. Update your info directly in the app.</p>
      <p><b>7. Not for minors.</b> The Service is for adults 21+ only and isn't directed at children. We don't knowingly collect data from anyone under 21.</p>
      <p><b>8. Security.</b> We use industry-standard measures — hashed passwords, encrypted connections — but no method of transmission or storage is perfectly secure.</p>
      <p><b>9. State/international privacy laws.</b> Specific disclosures required under laws like the CCPA or GDPR are being finalized with counsel and will be added here once confirmed.</p>
      <p><b>10. Changes.</b> We may update this policy; meaningful changes will be reflected here with a new "last updated" date.</p>
    </div>
    <p class="empty-note">Questions about this policy? Reach out through <a href="/feedback">Send Feedback</a>.</p>
  `;
  sendHtml(res, layout({ title: 'Privacy Policy', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageAccount(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const user = db.getUserById(userId);
  const error = query.get('error') || '';
  const success = query.get('ok') || '';
  const body = `
    <a href="/more" class="empty-note">← Back to More</a>
    <h1 class="screen-title" style="margin-top:8px;">Account Settings</h1>

    <div class="card">
      <h2 style="margin:0 0 10px;font-size:15px;">Username</h2>
      ${error === 'username_taken' ? `<p class="dosing-note">That username is already taken — try another.</p>` : ''}
      ${success === 'username' ? `<p class="empty-note" style="color:var(--brand-green-dark);">Username updated.</p>` : ''}
      <form method="POST" action="/account/username">
        <label class="field-label" style="margin-top:0;">Username</label>
        <input type="text" name="username" value="${esc(user.username)}" required minlength="2" maxlength="30">
        <button class="btn block" type="submit" style="margin-top:10px;">Update Username</button>
      </form>
    </div>

    <div class="card" style="margin-top:14px;">
      <h2 style="margin:0 0 10px;font-size:15px;">Email</h2>
      <p class="empty-note" style="padding:0 0 10px;">Used for password resets.${!user.email ? ' Your account currently has no email on file.' : ''}</p>
      ${error === 'email_taken' ? `<p class="dosing-note">That email is already in use on another account.</p>` : ''}
      ${success === 'email' ? `<p class="empty-note" style="color:var(--brand-green-dark);">Email updated.</p>` : ''}
      <form method="POST" action="/account/email">
        <label class="field-label" style="margin-top:0;">Email</label>
        <input type="email" name="email" value="${esc(user.email || '')}" required autocomplete="email">
        <button class="btn block" type="submit" style="margin-top:10px;">Update Email</button>
      </form>
    </div>

    <div class="card" style="margin-top:14px;">
      <h2 style="margin:0 0 10px;font-size:15px;">Password</h2>
      ${error === 'wrong_password' ? `<p class="dosing-note">Current password is incorrect.</p>` : ''}
      ${error === 'password_mismatch' ? `<p class="dosing-note">New password and confirmation don't match.</p>` : ''}
      ${error === 'password_short' ? `<p class="dosing-note">New password needs to be at least 8 characters.</p>` : ''}
      ${success === 'password' ? `<p class="empty-note" style="color:var(--brand-green-dark);">Password updated.</p>` : ''}
      <form method="POST" action="/account/password">
        <label class="field-label" style="margin-top:0;">Current password</label>
        <input type="password" name="current_password" required>
        <label class="field-label">New password</label>
        <input type="password" name="new_password" required minlength="8">
        <label class="field-label">Confirm new password</label>
        <input type="password" name="confirm_password" required minlength="8">
        <button class="btn block" type="submit" style="margin-top:10px;">Update Password</button>
      </form>
    </div>

    <div class="card" style="margin-top:14px;">
      <h2 style="margin:0 0 10px;font-size:15px;">Privacy & Safety</h2>
      <a class="btn secondary block" href="/blocked-users" style="text-decoration:none;">🚫 Blocked Users</a>
    </div>

    <div class="card" style="margin-top:14px;">
      <h2 style="margin:0 0 10px;font-size:15px;">Your Data</h2>
      <p class="empty-note" style="padding:0 0 10px;">See our <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a> for what this covers.</p>
      <a class="btn secondary block" href="/account/export" style="text-decoration:none;margin-bottom:10px;">⬇️ Export my data</a>
      <form method="POST" action="/account/delete" onsubmit="return confirm('This permanently deletes your account, check-ins, friends, and photos. This cannot be undone. Continue?')">
        <button class="btn danger block" type="submit" style="color:#fff;">Delete my account</button>
      </form>
    </div>

    <p class="empty-note" style="margin-top:18px;text-align:center;"><a href="${auth.isAdmin(req) ? '/admin' : '/admin/login'}">Site administration</a></p>
  `;
  sendHtml(res, layout({ title: 'Account Settings', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}
async function handleAccountExport(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const data = db.getUserExportData(userId);
  if (!data) return notFound(res);
  const json = JSON.stringify(data, null, 2);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Disposition': 'attachment; filename="straindex-my-data.json"',
  });
  res.end(json);
}
async function handleAccountDelete(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.deleteUserAccount(userId);
  res.setHeader('Set-Cookie', `user_session=; Path=/; HttpOnly; Max-Age=0`);
  redirect(res, '/signup?deleted=1');
}
async function handleAccountUsername(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const newUsername = (fields.username || '').trim();
  if (!newUsername) return redirect(res, '/account');
  try {
    await db.updateUsername(userId, newUsername);
    redirect(res, '/account?ok=username');
  } catch (err) {
    redirect(res, '/account?error=username_taken');
  }
}
async function handleAccountEmail(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const newEmail = (fields.email || '').trim().toLowerCase();
  if (!newEmail) return redirect(res, '/account');
  try {
    await db.updateEmail(userId, newEmail);
    redirect(res, '/account?ok=email');
  } catch (err) {
    redirect(res, '/account?error=email_taken');
  }
}
async function handleAccountPassword(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const { current_password, new_password, confirm_password } = fields;
  if ((new_password || '').length < 8) return redirect(res, '/account?error=password_short');
  if (new_password !== confirm_password) return redirect(res, '/account?error=password_mismatch');
  try {
    await db.updatePassword(userId, current_password || '', new_password);
    redirect(res, '/account?ok=password');
  } catch (err) {
    redirect(res, '/account?error=wrong_password');
  }
}

// ---------------------------------------------------------------- collection / binder

function pageCollection(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const owned = db.getCollection(userId).sort((a, b) => a.strain.name.localeCompare(b.strain.name));
  const uniqueCount = db.getUniqueOwnedCount(userId);
  const totalStrains = db.countStrains();
  const pct = totalStrains ? Math.round((100 * uniqueCount) / totalStrains) : 0;

  const rarityOrder = ['legendary', 'rare', 'uncommon', 'common'];
  const rarityCounts = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
  owned.forEach(o => { if (rarityCounts[o.strain.rarity] != null) rarityCounts[o.strain.rarity]++; });
  const rarestOwned = rarityOrder.map(r => owned.find(o => o.strain.rarity === r)).find(Boolean);

  const body = `
    <h1 class="screen-title">My Collection</h1>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <a class="follow-btn" style="flex:1;text-align:center;" href="/strains">🔍 Browse Strain Library</a>
      <a class="follow-btn" style="flex:1;text-align:center;" href="/history">🕐 Check-In History</a>
    </div>
    <div class="collection-stats">
      <div class="stat-tile"><div class="num">${uniqueCount}/${totalStrains.toLocaleString()}</div><div class="lbl">Cards caught</div></div>
      <div class="stat-tile"><div class="num">${db.getTotalDupes(userId)}</div><div class="lbl">Tradeable dupes</div></div>
      <div class="stat-tile"><div class="num">${rarestOwned ? esc(rarityLabel(rarestOwned.strain.rarity)) : '—'}</div><div class="lbl">Rarest catch</div></div>
    </div>
    <div class="progress-bar"><div class="fill" style="width:${pct}%;"></div></div>

    <div class="badge-row" style="margin-bottom:16px;">
      <div class="badge-chip rarity-common" style="background:none;color:var(--ink-secondary);">Common: ${rarityCounts.common}</div>
      <div class="badge-chip rarity-uncommon" style="background:none;color:var(--ink-secondary);">Uncommon: ${rarityCounts.uncommon}</div>
      <div class="badge-chip rarity-rare" style="background:none;color:var(--ink-secondary);">Rare: ${rarityCounts.rare}</div>
      <div class="badge-chip rarity-legendary" style="background:none;color:var(--ink-secondary);">Legendary: ${rarityCounts.legendary}</div>
    </div>

    ${owned.length ? `<div class="binder-grid">
      ${owned.map(o => `
        <a class="card-slot rarity-${o.strain.rarity}" href="/strains/${o.strain.id}">
          ${o.copies > 1 ? `<div class="copies">×${o.copies}</div>` : ''}
          ${strainPhotoTag(o.strain, 'md')}
          <div class="name">${esc(o.strain.name)}</div>
        </a>`).join('')}
    </div>` : `<div class="empty-note">No cards caught yet — <a href="/checkin">log a check-in</a> to unlock your first one.</div>`}
  `;
  sendHtml(res, layout({ title: 'My Collection', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
      return `<div class="library-row">
        <a href="/strains/${c.strain_id}" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
          ${strainPhotoTag(s, 'sm')}
          <div class="info">
            <div class="nm">${esc(s ? s.name : c.strain_id)}</div>
            <div class="sub">${esc(c.method)} · ${starString(c.rating)} · <span class="local-time" data-utc="${c.created_at}Z">${esc(c.created_at)} UTC</span></div>
          </div>
        </a>
        <a href="/checkin/${c.id}/edit" class="empty-note" style="padding:0 4px;">Edit</a>
      </div>`;
    }).join('') : `<div class="empty-note">No check-ins logged yet — <a href="/checkin">log your first one</a>.</div>`}
  `;
  sendHtml(res, layout({ title: 'Check-In History', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
    <a href="/messages" class="btn secondary block" style="text-decoration:none;margin-bottom:14px;">💬 Messages${db.countUnreadMessages(userId) > 0 ? ` (${db.countUnreadMessages(userId)})` : ''}</a>
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
        <a href="/friends/${u.id}" style="text-decoration:none;color:inherit;">👤 ${esc(u.username)}</a>
        <div class="actions">
          <a href="/messages/${u.id}" class="btn secondary" style="text-decoration:none;">Message</a>
          <a href="/trade?friend=${u.id}" class="btn secondary" style="text-decoration:none;">Trade</a>
          <form method="POST" action="/friends/${u.id}/remove" style="display:inline;" onsubmit="return confirm('Remove this friend?')">
            <button class="btn danger" style="color:#fff;" type="submit">Remove</button>
          </form>
        </div>
      </div>`).join('') : `<div class="empty-note">No friends yet — search for a username above to get started.</div>`}
  `;
  sendHtml(res, layout({ title: 'Friends', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}
// Abuse protection: report + block. Reports go to a simple admin review
// queue; blocking is one-directional and hides the blocked person's
// comments, check-ins, and grow tips from the blocker's own view, ends any
// existing friendship, and stops them from sending a new friend request.
async function handleReport(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  if (f.content_type && f.content_id) {
    await db.createReport({ reporter_id: userId, content_type: f.content_type, content_id: f.content_id, reason: f.reason || '' });
  }
  redirect(res, f.redirect_to || '/');
}
async function handleBlock(req, res, blockedId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  await db.blockUser(userId, Number(blockedId));
  redirect(res, f.redirect_to || '/friends');
}
async function handleUnblock(req, res, blockedId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.unblockUser(userId, Number(blockedId));
  redirect(res, '/blocked-users');
}
function pageBlockedUsers(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const blocked = db.listBlockedUsers(userId);
  const body = `
    <a href="/account" class="empty-note">← Back to Account Settings</a>
    <h1 class="screen-title">Blocked Users</h1>
    ${blocked.length ? blocked.map(u => `
      <div class="library-row">
        <div class="info"><div class="nm">${esc(u.username)}</div></div>
        <form method="POST" action="/unblock/${u.id}">
          <button type="submit" class="empty-note" style="padding:0 6px;background:none;border:none;color:var(--brand-green-dark);cursor:pointer;font-size:inherit;text-decoration:underline;">Unblock</button>
        </form>
      </div>
    `).join('') : `<div class="empty-note">You haven't blocked anyone.</div>`}
  `;
  sendHtml(res, layout({ title: 'Blocked Users', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}
// Admin review queue for reported content -- deliberately simple: see
// what was reported and by whom, mark it reviewed once handled. Actually
// removing bad content still happens through the existing admin tools for
// that content type (or direct DB access at this scale), rather than
// building a duplicate deletion path here.
function pageAdminReports(req, res) {
  if (!requireAdmin(req, res)) return;
  const reports = db.listReports();
  const body = `
    <h1 class="screen-title">Reported Content</h1>
    ${reports.length ? reports.map(r => {
      const reporter = db.getUserById(r.reporter_id);
      return `
      <div class="card" style="margin-bottom:8px;${r.status === 'reviewed' ? 'opacity:0.5;' : ''}">
        <b>${esc(r.content_type)}</b> #${esc(r.content_id)} — reported by ${esc(reporter ? reporter.username : 'unknown')}
        <p class="empty-note" style="padding:2px 0;">${esc(r.reason || 'No reason given')} · ${esc(r.created_at)} UTC · ${esc(r.status)}</p>
        ${r.status !== 'reviewed' ? `
          <form method="POST" action="/admin/reports/${r.id}/reviewed">
            <button type="submit" class="btn secondary" style="padding:6px 12px;">Mark Reviewed</button>
          </form>
        ` : ''}
      </div>`;
    }).join('') : `<div class="empty-note">No reports yet.</div>`}
  `;
  sendHtml(res, layout({ title: 'Reported Content', body, isAdmin: true }));
}
async function handleAdminReportReviewed(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.markReportReviewed(Number(id));
  redirect(res, '/admin/reports');
}

// ---------- Direct messages ----------
function pageMessagesInbox(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const threads = db.listConversations(userId);
  const body = `
    <h1 class="screen-title">Messages</h1>
    <p class="screen-sub">Private conversations with friends.</p>
    ${threads.length ? threads.map(t => `
      <a href="/messages/${t.partner.id}" class="admin-row" style="text-decoration:none;color:inherit;align-items:center;">
        <div>
          <div>${t.unread ? '<b>' : ''}👤 ${esc(t.partner.username)}${t.unread ? '</b>' : ''}</div>
          <div class="empty-note" style="padding:2px 0 0;">${t.last.shared_strain_id ? '🌿 Shared a strain' : esc((t.last.body || '').slice(0, 60))}</div>
        </div>
        ${t.unread ? `<span class="rarity-tag rarity-rare">${t.unread}</span>` : ''}
      </a>
    `).join('') : `<div class="empty-note">No conversations yet — message a friend from their profile to get started.</div>`}
  `;
  sendHtml(res, layout({ title: 'Messages', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageConversation(req, res, friendId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const friend = db.getUserById(friendId);
  if (!friend) return notFound(res);
  if (db.getFriendshipStatus(userId, friendId) !== 'friends') {
    return sendHtml(res, layout({ title: 'Messages', active: 'friends', body: `<div class="empty-note">You can only message friends.</div>`, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
  }
  db.markConversationRead(userId, friendId);
  const thread = db.listConversation(userId, friendId);
  const body = `
    <a href="/messages" class="empty-note">← All conversations</a>
    <h1 class="screen-title">${esc(friend.username)}</h1>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
      ${thread.length ? thread.map(m => {
        const mine = m.sender_id === userId;
        const strain = m.shared_strain_id ? db.getStrain(m.shared_strain_id) : null;
        return `<div style="align-self:${mine ? 'flex-end' : 'flex-start'};max-width:80%;">
          ${strain ? `
            <a href="/strains/${strain.id}" class="library-row" style="text-decoration:none;color:inherit;margin-bottom:0;">
              ${strainPhotoTag(strain, 'sm')}
              <div class="info">
                <div class="nm">${esc(strain.name)}</div>
                <div class="sub">${esc(strain.type)} · THC ${esc(strain.thc)}</div>
              </div>
            </a>
          ` : ''}
          ${m.body ? `<div class="admin-row" style="background:${mine ? 'var(--brand-green-dark)' : 'var(--bg-card)'};color:${mine ? '#fff' : 'inherit'};margin-top:${strain ? '4px' : '0'};">${esc(m.body)}</div>` : ''}
        </div>`;
      }).join('') : `<div class="empty-note">Say hi to ${esc(friend.username)} 👋</div>`}
    </div>
    <form method="POST" action="/messages/${friend.id}/send" style="display:flex;gap:8px;">
      <input type="text" name="body" placeholder="Message ${esc(friend.username)}..." autocomplete="off" style="flex:1;">
      <button class="btn" type="submit">Send</button>
    </form>
  `;
  sendHtml(res, layout({ title: friend.username, active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

async function handleSendMessage(req, res, friendId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  try {
    await db.sendMessage({ sender_id: userId, recipient_id: friendId, body: fields.body, shared_strain_id: fields.shared_strain_id || null });
  } catch (err) {
    // Fall through to redirect either way -- the conversation page itself
    // will look unchanged if the send silently failed validation, which is
    // an acceptable, low-stakes failure mode for a short text message.
  }
  redirect(res, `/messages/${friendId}`);
}
async function handleShareStrain(req, res, strainId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  const friendId = Number(fields.friend_id);
  if (friendId) {
    try {
      await db.sendMessage({ sender_id: userId, recipient_id: friendId, body: null, shared_strain_id: strainId });
    } catch (err) {
      // Same low-stakes fallback as handleSendMessage -- worst case the
      // share silently didn't go through and the person can just try again.
    }
    return redirect(res, `/messages/${friendId}`);
  }
  redirect(res, `/strains/${strainId}`);
}

function pageFriendProfile(req, res, friendId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const friend = db.getUserById(friendId);
  if (!friend) return notFound(res);
  const status = db.getFriendshipStatus(userId, friendId);
  if (status !== 'friends' && friendId !== userId) {
    const body = `<h1 class="screen-title">Not connected yet</h1><p class="empty-note">You can only see a profile once you're friends with them. <a href="/friends">Back to Friends</a></p>`;
    return sendHtml(res, layout({ title: 'Profile', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
  }
  const collection = db.getCollection(friendId);
  const recentCheckins = db.filterVisibleCheckins(db.listCheckins({ userId: friendId, limit: 30 }), userId).slice(0, 10);
  const body = `
    <a href="/friends" class="empty-note">← Back to Friends</a>
    <h1 class="screen-title" style="margin-top:8px;">👤 ${esc(friend.username)}</h1>
    ${friendId !== userId && status === 'friends' ? `<a href="/messages/${friendId}" class="btn" style="text-decoration:none;display:inline-block;margin-bottom:10px;">💬 Message</a>` : ''}
    ${friendId !== userId ? `
      <form method="POST" action="/block/${friendId}" style="margin-bottom:10px;" onsubmit="return confirm('Block ${esc(friend.username)}? You will no longer see their comments, check-ins, or grow tips, and any friendship will end.')">
        <input type="hidden" name="redirect_to" value="/friends">
        <button type="submit" class="empty-note" style="padding:0;background:none;border:none;color:#a13a3a;cursor:pointer;font-size:inherit;text-decoration:underline;">Block this person</button>
      </form>
    ` : ''}
    <div class="card" style="display:flex;justify-content:space-around;text-align:center;margin-bottom:16px;">
      <div><div style="font-size:20px;font-weight:700;">${collection.length}</div><div class="empty-note">Cards caught</div></div>
      <div><div style="font-size:20px;font-weight:700;">${db.getTotalDupes(friendId)}</div><div class="empty-note">Tradeable dupes</div></div>
      <div><div style="font-size:20px;font-weight:700;">${recentCheckins.length}</div><div class="empty-note">Recent check-ins</div></div>
    </div>
    ${friendId !== userId ? `<a class="btn block secondary" href="/trade?friend=${friendId}" style="margin-bottom:16px;">🔁 Trade with ${esc(friend.username)}</a>` : ''}
    <div class="section-label">Recent check-ins</div>
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
        ${renderCheckinPairings(c)}
        ${renderOnsetTimer(c)}
        ${renderCheckinComments(c, userId, '/friends/' + friendId)}
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-top:8px;">
          ${renderKudosButton(c, userId)}
          ${kudosGiversLabel(c.id)}
        </div>
      </div>`;
    }).join('') : `<div class="empty-note">No check-ins yet.</div>`}
  `;
  sendHtml(res, layout({ title: friend.username, active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Trade', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
      <p class="screen-sub geo-live"><span class="dot"></span> Showing ${realResults.length} dispensar${realResults.length === 1 ? 'y' : 'ies'} near ${esc(locationLabel)}.</p>
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
      <p class="screen-sub" style="margin-top:16px;">No live menu or pricing data exists for these yet (that lives inside each dispensary's own point-of-sale system), so menus aren't shown here.</p>
    `;
  } else {
    body = `
      <h1 class="screen-title">Dispensaries</h1>
      <div class="locate-banner">
        <div style="font-weight:700;font-size:13px;">📍 Find real dispensaries near you</div>
        <div class="dsub" style="margin:3px 0 10px;">${realError ? esc(realError) : "Search by ZIP code, or share your location — nothing is sent anywhere else."}</div>
        <div class="locate-row">
          <form method="GET" action="/dispensaries" class="zip-form">
            <input type="text" name="zip" placeholder="ZIP code" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" value="${esc(zipParam)}">
            <button type="submit" class="follow-btn">Search</button>
          </form>
          <button type="button" id="use-location-btn" class="follow-btn">Use my location</button>
        </div>
      </div>
      ${zipParam || realError ? `<div class="empty-note" style="margin-top:16px;">${realError ? 'Nothing to show right now — try again in a moment, or try a different ZIP code.' : 'No dispensaries found for that ZIP code.'}</div>` : `<div class="empty-note" style="margin-top:16px;">Enter a ZIP code or share your location above to find real dispensaries near you.</div>`}
    `;
  }
  sendHtml(res, layout({ title: 'Dispensaries', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Events', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Business', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Shop', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

async function handleShopAdd(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.addToCart(userId, id);
  redirect(res, '/shop');
}

// ---------------------------------------------------------------- badges directory

// ---------------------------------------------------------------- consumption methods guide

function pageMethods(req, res) {
  const body = `
    <h1 class="screen-title">Ways to Enjoy It</h1>
    <p class="screen-sub">Every ingestion method, with realistic onset and duration windows.</p>
    ${mock.methodGuide.map(m => `
      <div class="method-guide-card">
        <div class="mgtitle">${m.icon.startsWith('/') ? `<img src="${m.icon}" alt="" class="mg-icon-photo">` : m.icon} ${esc(m.name)}</div>
        <div class="mgstats"><span>Onset: ${esc(m.onset)}</span><span>Lasts: ${esc(m.duration)}</span></div>
        <div class="mgdesc">${esc(m.desc)}</div>
      </div>`).join('')}
  `;
  sendHtml(res, layout({ title: 'Ways to Enjoy It', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

// Concentrates & Extracts guide — a companion to "Ways to Enjoy It" that
// covers *what* you're consuming (product types, real potency ranges,
// how each is made) rather than *how* (devices/techniques). THC ranges
// come from real Washington state lab-testing data, cross-checked
// against published sources — same standard used for the strain library.
// State-by-state legal status lookup. Deliberately a simple dropdown/search
// rather than GPS auto-detection -- reliably mapping coordinates to state
// boundaries needs real geographic boundary data this app doesn't have, and
// a wrong auto-detected state here is a much worse failure mode than for,
// say, nearby dispensaries. A manual picker is slower by one tap but never
// silently wrong.
function pageLegalStatus(req, res, query) {
  const selected = query.get('state') || '';
  const sorted = [...LEGAL_STATUS].sort((a, b) => a.state.localeCompare(b.state));
  const current = sorted.find(s => s.state === selected);
  const grouped = {};
  sorted.forEach(s => { (grouped[s.status] = grouped[s.status] || []).push(s); });
  const body = `
    <a href="/more" class="empty-note">← Back</a>
    <h1 class="screen-title">Is It Legal Near Me?</h1>
    <p class="screen-sub">Cannabis law is a fast-moving patchwork that changes with little notice. This is a starting point, not legal advice — always verify with your state's official government site before relying on it. Regardless of state law, cannabis remains illegal under federal law everywhere in the US.</p>
    <p class="empty-note">Last checked against current sources: ${esc(LEGAL_STATUS_LAST_VERIFIED)}.</p>
    <form method="GET" action="/legal-status" style="margin-bottom:16px;">
      <label class="field-label" style="margin-top:0;">Pick your state</label>
      <select name="state" onchange="this.form.submit()">
        <option value="">Select a state...</option>
        ${sorted.map(s => `<option value="${esc(s.state)}" ${selected === s.state ? 'selected' : ''}>${esc(s.state)}</option>`).join('')}
      </select>
    </form>
    ${current ? `
      <div class="card" style="border-left:4px solid ${LEGAL_STATUS_LABELS[current.status].color};margin-bottom:20px;">
        <h2 style="margin:0 0 4px;font-size:17px;">${esc(current.state)}</h2>
        <div style="font-weight:700;color:${LEGAL_STATUS_LABELS[current.status].color};margin-bottom:6px;">${esc(LEGAL_STATUS_LABELS[current.status].label)}</div>
        <p style="margin:0;">${esc(current.note)}</p>
      </div>
    ` : ''}
    <h2 class="screen-title" style="margin-top:8px;">Full list</h2>
    ${Object.entries(LEGAL_STATUS_LABELS).map(([key, meta]) => `
      <h3 style="font-size:13px;color:${meta.color};margin:16px 0 6px;">${esc(meta.label)}</h3>
      ${(grouped[key] || []).map(s => `
        <div class="card" style="padding:10px 14px;margin-bottom:6px;">
          <b>${esc(s.state)}</b>
          <p class="empty-note" style="padding:2px 0 0;">${esc(s.note)}</p>
        </div>
      `).join('')}
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Is It Legal Near Me?', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
}

function pageConcentrates(req, res) {
  const body = `
    <h1 class="screen-title">Concentrates &amp; Extracts</h1>
    <p class="screen-sub">Flower typically runs 15–30% THC — concentrates are a different category entirely. Real lab-testing data, cross-checked against published sources.</p>
    ${mock.concentrateGuide.map(c => `
      <div class="method-guide-card">
        <div class="mgtitle">${c.icon} ${esc(c.name)}</div>
        <div class="mgstats"><span>THC: ${esc(c.thc)}</span></div>
        <div class="mgdesc">${esc(c.desc)}</div>
      </div>`).join('')}
    <p class="empty-note" style="margin-top:6px;">Not medical advice — potency varies by batch and producer even within these ranges.</p>
  `;
  sendHtml(res, layout({ title: 'Concentrates & Extracts', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: db.countUnreadMessages(auth.currentUserId(req)) }));
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
    const PUBLIC_PATHS = new Set(['/', '/signup', '/login', '/logout', '/terms', '/privacy', '/forgot-password', '/reset-password', '/api/analytics-snapshot', '/auth/google', '/auth/google/callback', '/auth/google/finish']);
    if (!PUBLIC_PATHS.has(pathname) && !pathname.startsWith('/admin') && auth.currentUserId(req) == null) {
      return redirect(res, '/login');
    }

    let m;
    if (method === 'GET' && pathname === '/') return pageHome(req, res);
    if (method === 'GET' && pathname === '/strains') return pageStrains(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/strains\/([^/]+)$/))) return pageStrainDetail(req, res, m[1]);
    if (method === 'GET' && pathname === '/checkin') return pageCheckinForm(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/checkin') return await handleCheckinSubmit(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/checkin\/(\d+)\/edit$/))) return pageCheckinEditForm(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/checkin\/(\d+)\/edit$/))) return await handleCheckinEditSubmit(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/checkin\/(\d+)\/comment$/))) return await handleCheckinComment(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/checkin\/(\d+)\/delete$/))) return await handleCheckinDelete(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/faq') return pageFaq(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/recipes') return pageRecipes(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/recipes\/(\d+)$/))) return pageRecipeDetail(req, res, Number(m[1]));
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
    if (method === 'GET' && pathname === '/auth/google') return pageGoogleStart(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/auth/google/callback') return await handleGoogleCallback(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/auth/google/finish') return pageGoogleFinish(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/auth/google/finish') return await handleGoogleFinishSubmit(req, res);
    if (method === 'GET' && pathname === '/login') return pageLogin(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/login') return await handleLoginSubmit(req, res);
    if (method === 'POST' && pathname === '/logout') return handleLogout(req, res);
    if (method === 'GET' && pathname === '/account') return pageAccount(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/account/export') return await handleAccountExport(req, res);
    if (method === 'POST' && pathname === '/account/delete') return await handleAccountDelete(req, res);
    if (method === 'GET' && pathname === '/terms') return pageTerms(req, res);
    if (method === 'GET' && pathname === '/privacy') return pagePrivacy(req, res);
    if (method === 'GET' && pathname === '/forgot-password') return pageForgotPassword(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/forgot-password') return await handleForgotPasswordSubmit(req, res);
    if (method === 'GET' && pathname === '/onboarding') return pageOnboarding(req, res);
    if (method === 'GET' && pathname === '/feedback') return pageFeedback(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/feedback') return await handleFeedbackSubmit(req, res);
    if (method === 'GET' && pathname === '/reset-password') return pageResetPassword(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/reset-password') return await handleResetPasswordSubmit(req, res);
    if (method === 'POST' && pathname === '/account/username') return await handleAccountUsername(req, res);
    if (method === 'POST' && pathname === '/account/email') return await handleAccountEmail(req, res);
    if (method === 'POST' && pathname === '/account/password') return await handleAccountPassword(req, res);
    if (method === 'GET' && pathname === '/admin/logout') return handleAdminLogout(req, res);
    if (method === 'GET' && pathname === '/admin') return pageAdminHome(req, res);
    if (method === 'GET' && pathname === '/admin/feedback') return pageAdminFeedback(req, res);
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
    if (method === 'POST' && (m = pathname.match(/^\/api\/checkins\/(\d+)\/kudos$/))) return await apiCheckinKudos(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/api\/comments\/(\d+)\/like$/))) return await apiCommentLike(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/api/analytics-snapshot') return apiAnalyticsSnapshot(req, res, url.searchParams);

    if (method === 'GET' && pathname === '/more') return pageMore(req, res);
    if (method === 'GET' && pathname === '/collection') return pageCollection(req, res);
    if (method === 'GET' && pathname === '/history') return pageHistory(req, res);
    if (method === 'GET' && pathname === '/trade') return pageTrade(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/friends') return pageFriends(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/friends\/(\d+)$/))) return pageFriendProfile(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/request$/))) return await handleFriendRequest(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/accept$/))) return await handleFriendAccept(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/decline$/))) return await handleFriendDecline(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/remove$/))) return await handleFriendRemove(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/messages') return pageMessagesInbox(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/messages\/(\d+)$/))) return pageConversation(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/messages\/(\d+)\/send$/))) return await handleSendMessage(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/strains\/([^/]+)\/share$/))) return await handleShareStrain(req, res, m[1]);
    if (method === 'POST' && pathname === '/trade/propose') return await handleTradePropose(req, res);
    if (method === 'GET' && pathname === '/dispensaries') return await pageDispensaries(req, res, url.searchParams);
    if (method === 'POST' && (m = pathname.match(/^\/dispensaries\/([^/]+)\/follow$/))) return await handleDispensaryFollow(req, res, m[1], url.searchParams);
    if (method === 'GET' && pathname === '/events') return pageEvents(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/events\/([^/]+)\/rsvp$/))) return await handleEventRsvp(req, res, m[1]);
    if (method === 'GET' && pathname === '/business') return pageBusiness(req, res);
    if (method === 'GET' && pathname === '/shop') return pageShop(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/shop\/([^/]+)\/add$/))) return await handleShopAdd(req, res, m[1]);
    if (method === 'GET' && pathname === '/methods') return pageMethods(req, res);
    if (method === 'GET' && pathname === '/quiz') return pageQuiz(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/compare') return pageCompare(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/insights') return pageInsights(req, res);
    if (method === 'POST' && pathname === '/tolerance-break/start') return await handleToleranceBreakStart(req, res);
    if (method === 'POST' && pathname === '/tolerance-break/end') return await handleToleranceBreakEnd(req, res);
    if (method === 'GET' && pathname === '/concentrates') return pageConcentrates(req, res);
    if (method === 'GET' && pathname === '/legal-status') return pageLegalStatus(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/surprise-me') return handleSurpriseMe(req, res);
    if (method === 'GET' && pathname === '/wishlist') return pageWishlist(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/wishlist\/([^/]+)\/toggle$/))) return await handleWishlistToggle(req, res, m[1]);
    if (method === 'GET' && pathname === '/trending') return pageTrending(req, res);
    if (method === 'GET' && pathname === '/mixing-cautions') return pageMixingCautions(req, res);
    if (method === 'GET' && pathname === '/grow-journal') return pageGrowJournal(req, res);
    if (method === 'POST' && pathname === '/grow-journal') return await handleGrowJournalSubmit(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/grow-journal\/(\d+)\/delete$/))) return await handleGrowJournalDelete(req, res, m[1]);
    if (method === 'GET' && pathname === '/friends-picks') return pageFriendsPicks(req, res);
    if (method === 'GET' && pathname === '/lists') return pageLists(req, res);
    if (method === 'POST' && pathname === '/lists') return await handleListCreate(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/lists\/(\d+)$/))) return pageListDetail(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/lists\/(\d+)\/delete$/))) return await handleListDelete(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/lists\/(\d+)\/items\/([^/]+)\/toggle$/))) return await handleListItemToggle(req, res, m[1], m[2]);
    if (method === 'GET' && pathname === '/terpene-guide') return pageTerpeneGuide(req, res);
    if (method === 'GET' && pathname === '/effects-guide') return pageEffectsGuide(req, res);
    if (method === 'GET' && pathname === '/mood-finder') return pageMoodFinder(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/breeder-guide') return pageBreederGuide(req, res);
    if (method === 'POST' && pathname === '/report') return await handleReport(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/block\/(\d+)$/))) return await handleBlock(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/unblock\/(\d+)$/))) return await handleUnblock(req, res, m[1]);
    if (method === 'GET' && pathname === '/blocked-users') return pageBlockedUsers(req, res);
    if (method === 'GET' && pathname === '/admin/reports') return pageAdminReports(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/reports\/(\d+)\/reviewed$/))) return await handleAdminReportReviewed(req, res, m[1]);

    return notFound(res);
  } catch (err) {
    console.error(err);
    Sentry.captureException(err);
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
    Sentry.captureException(err);
    process.exit(1);
  });
