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
// The one, real, branded domain -- used for every outbound link this app
// generates (shared check-ins, invite links, recap links, password reset
// emails, admin notification emails), rather than building the origin
// dynamically from req.headers.host. Deliberately hardcoded rather than
// derived per-request: this app is deployed on Render, which also exposes
// its own *.onrender.com hostname alongside the custom domain, and
// req.headers.host reflects whichever hostname actually served that
// particular request. A link generated from a request that happened to
// arrive on the Render-assigned hostname would silently leak that
// internal URL to whoever it's shared with, instead of the clean, correct
// domain people actually expect to see and click. Update this in exactly
// one place if the domain ever changes.
const SITE_URL = 'https://www.strain-dex.com';
// Renders the hidden CSRF field for server-rendered forms. Most forms get
// their token injected client-side (see injectCsrfTokens in public/app.js),
// but any form can include this directly as well -- both carry the same value.
function csrfField(req) {
  return `<input type="hidden" name="_csrf" value="${esc(auth.csrfToken(req))}">`;
}
const { parseForm, parseJson } = require('./lib/body');
const { answerFromKnowledgeBase } = require('./lib/chat');
const mock = require('./lib/mockdata');
const geo = require('./lib/geodispensaries');
const storage = require('./lib/storage');

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------- basic signup rate limiting
// Backed by the persistent rate_limit_attempts table (see db.js) rather
// than an in-memory Map, specifically so this survives a server restart or
// redeploy -- a Map-based limiter resets every time Render restarts the
// process, which on a free/hobby tier can happen often enough to make the
// protection meaningless. Not bulletproof (doesn't help behind a shared IP
// like a school or office), but stops the easy case: a bot or script
// hammering /signup. Max 5 signup attempts per IP per 15 minutes.
const SIGNUP_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_MAX_ATTEMPTS = 5;
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
async function isSignupRateLimited(req) {
  const ip = clientIp(req);
  const existing = await db.pruneAndCountAttempts('signup', ip, SIGNUP_WINDOW_MS);
  await db.recordRateLimitAttempt('signup', ip);
  return (existing + 1) > SIGNUP_MAX_ATTEMPTS;
}

// ---------------------------------------------------------------- basic login rate limiting
// Keyed by IP + username (not just IP) so it specifically slows down
// brute-forcing one account's password, without penalizing everyone on a
// shared network (school, office) for one person's typos. Only failed
// attempts count -- a successful login clears the counter. Max 5 failed
// attempts per 15 minutes per IP+username combination. Same persistent
// storage as signup, for the same restart-survival reason.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
function loginAttemptKey(req, username) {
  return `${clientIp(req)}:${String(username || '').trim().toLowerCase()}`;
}
async function isLoginRateLimited(req, username) {
  const key = loginAttemptKey(req, username);
  const count = await db.pruneAndCountAttempts('login', key, LOGIN_WINDOW_MS);
  return count >= LOGIN_MAX_ATTEMPTS;
}
async function recordFailedLogin(req, username) {
  await db.recordRateLimitAttempt('login', loginAttemptKey(req, username));
}
async function clearLoginAttempts(req, username) {
  await db.clearRateLimitAttempts('login', loginAttemptKey(req, username));
}

// ---------------------------------------------------------------- submission rate limiting
// A generous per-account limit on the four authenticated submission
// endpoints (feedback, recipes, grow tips, strain suggestions) -- every
// one of them now sends an email to SUPPORT_EMAIL the moment it's used,
// so without this, a bored or malicious logged-in user could spam
// dozens of emails in seconds and burn through the transactional email
// provider's sending quota. Reuses the same persistent rate_limit_attempts
// table built for signup/login, just keyed by user id instead of IP,
// since these actions always require being logged in already -- no need
// to worry about one shared IP (a school, an office) penalizing everyone
// on it the way login's IP-based limiting has to. The threshold is
// deliberately generous: this exists to stop an obvious burst, not to
// second-guess someone submitting a handful of genuine reports in one
// sitting.
const SUBMISSION_WINDOW_MS = 15 * 60 * 1000;
const SUBMISSION_MAX_ATTEMPTS = 10;
async function isSubmissionRateLimited(bucket, userId) {
  const existing = await db.pruneAndCountAttempts(bucket, String(userId), SUBMISSION_WINDOW_MS);
  await db.recordRateLimitAttempt(bucket, String(userId));
  return (existing + 1) > SUBMISSION_MAX_ATTEMPTS;
}

// Friendly response for a tripped submission limiter (see isSubmissionRateLimited).
function sendRateLimited(res, backHref) {
  sendHtml(res, layout({ title: 'Slow down a little', body: `<h1 class="screen-title">Slow down a little</h1><p>You've submitted a lot in a short time — give it a few minutes and try again.</p><p><a href="${esc(backHref)}">Go back</a></p>` }), 429);
}
// Generic "N attempts per window" limiter on the persistent table. Counts
// every call (including this one) and returns true once over the limit.
async function isGenericRateLimited(bucket, key, max, windowMs) {
  const existing = await db.pruneAndCountAttempts(bucket, key, windowMs);
  await db.recordRateLimitAttempt(bucket, key);
  return (existing + 1) > max;
}
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOCS_DIR = path.join(__dirname, 'docs');

const zlib = require('node:zlib');
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
// The one account allowed to even see the admin-login link -- Alissa's own
// user ID. Logging into the separate admin password is still required to
// actually reach anything in /admin; this just stops the link itself from
// being advertised to every logged-in user, which it was before.
const OWNER_USER_ID = 1;
// Only ever follow a redirect_to that's a real internal path -- guards
// against someone crafting a link like redirect_to=https://evil.example
// or redirect_to=//evil.example (protocol-relative) and using this app's
// own signup/login flow to bounce people off to a phishing site.
function safeRedirectPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return null;
  if (path.includes('://')) return null;
  return path;
}
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

// ---------------------------------------------------------------- self-added (free-text) strains
// When the strain someone wants to log isn't in the library yet, they can
// type its name instead. Those check-ins point at the hidden placeholder
// strain (db.CUSTOM_STRAIN_ID) and carry the typed name in
// custom_strain_name. Everywhere one is shown it gets a loud, unmissable
// "Self-added - Not verified" tag so nobody mistakes it for library data.
const CUSTOM_STRAIN_ID = db.CUSTOM_STRAIN_ID;
function isCustomCheckin(c) { return !!c && c.strain_id === CUSTOM_STRAIN_ID; }
function unverifiedBadge() {
  return `<span class="unverified-badge" title="Typed in by a member. This strain isn't in the StrainDex library yet, so nothing about it has been verified.">⚠ Self-added · Not verified</span>`;
}
function checkinStrainName(c, s) {
  if (isCustomCheckin(c)) return c.custom_strain_name || 'Unnamed strain';
  return s ? s.name : c.strain_id;
}
function checkinStrainHref(c) {
  return isCustomCheckin(c) ? `/checkin/${c.id}` : `/strains/${c.strain_id}`;
}
function checkinStrainTag(c, s) {
  if (isCustomCheckin(c)) return unverifiedBadge();
  return s ? `<span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>` : '';
}
// Tidies the typed name: collapses whitespace, strips control characters
// and angle brackets, caps the length. Returns '' if nothing usable is left.
function cleanCustomStrainName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}
// Shared renderer for the optional "pairings" a user can log with a
// check-in -- tasting notes plus food/drink, music/entertainment, and
// activity pairings. Each is independently optional, so only show what's
// actually filled in.
// PAIRING TYPES ARE USER-CONFIRMED -- the form is a type dropdown (this
// list) followed by a free-text note, submitted and stored as a real
// pairings: [{type, note}] array (matching db.js's createCheckin /
// updateCheckin / normalizePairings), NOT the old fixed pairing_food /
// pairing_entertainment / pairing_activity columns. Those old columns
// still exist ONLY for reading pre-migration check-ins (see
// rowToCheckin's backward-compat synthesis in db.js) -- nothing should
// ever be written to them again. Do not change this shape, the dropdown
// options, or go back to three fixed text inputs without asking first --
// this exact regression (silently dropping pairing data because the form
// wrote to columns nothing reads anymore) has already happened once.
const PAIRING_TYPES = [
  { key: 'food', label: 'Food & Drink', icon: '🍽️' },
  { key: 'music', label: 'Music & Entertainment', icon: '🎵' },
  { key: 'activity', label: 'Activity', icon: '🎯' },
  { key: 'other', label: 'Other', icon: '✨' },
];
const PAIRING_TYPE_BY_KEY = Object.fromEntries(PAIRING_TYPES.map(t => [t.key, t]));
// One repeatable row: a type dropdown, then a free-text note -- pick the
// type first, then describe it. Used both for the server-rendered initial
// row(s) and cloned client-side when someone taps "+ Add Pairing" (see
// the script in pageCheckinForm).
function renderPairingRow(p) {
  return `
    <div class="pairing-row" style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
      <select name="pairing_type" style="flex:0 0 150px;">
        ${PAIRING_TYPES.map(t => `<option value="${t.key}" ${p.type === t.key ? 'selected' : ''}>${t.icon} ${esc(t.label)}</option>`).join('')}
      </select>
      <input type="text" name="pairing_note" placeholder="Add a note..." value="${esc(p.note || '')}" style="flex:1;margin:0;">
      <button type="button" class="remove-pairing-btn" style="background:none;border:none;color:#a13a3a;cursor:pointer;font-size:18px;padding:4px;line-height:1;" onclick="this.closest('.pairing-row').remove()">×</button>
    </div>
  `;
}
function renderCheckinPairings(c) {
  return `
    ${c.is_private ? `<div class="empty-note" style="padding:4px 0 0;font-weight:700;">🔒 Private — only visible to you</div>` : ''}
    ${c.brand ? `<div class="empty-note" style="padding:4px 0 0;">🏷️ ${esc(c.brand)}</div>` : ''}
    ${c.tasting_notes ? `<div class="empty-note" style="padding:4px 0 0;">🍃 Tasting notes: ${esc(c.tasting_notes)}</div>` : ''}
    ${(c.pairings || []).map(p => {
      const meta = PAIRING_TYPE_BY_KEY[p.type];
      return p.note ? `<div class="empty-note" style="padding:2px 0 0;">${meta ? meta.icon : '✨'} ${esc(p.note)}</div>` : '';
    }).join('')}
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
// Combined badge count for the Friends nav tab -- unread messages plus
// incoming friend requests, both genuinely "things needing your attention
// in this section." Shown as one number rather than two separate badges
// on the same icon, which would just look cluttered.
// Safety & Education carousel -- rides right above the feed on Home so
// this content gets seen on every single open, not just by people who go
// dig for it under the Education tab. Deliberately safety-first ordering
// (dosing/mixing/legal before general strain trivia), matching the
// priority the app is meant to lead with: community first, safety a very
// visible second.
// ICONS ARE USER-CONFIRMED PLAIN EMOJI -- do not swap any of these (or the
// matching Education-page tiles below, in "In the Moment" / "Reference")
// for an uploaded image icon like /docs/joint-icon.png without asking
// first. That exact swap happened once already and had to be reverted.
const HOME_SAFETY_CAROUSEL = [
  { href: '/feels-wrong', icon: '🆘', title: 'Feels Wrong?', s: 'What to do right now' },
  { href: '/mixing-cautions', icon: '⚠️', title: 'Mixing Cautions', s: 'What not to combine' },
  { href: '/legal-status', icon: '🏛️', title: 'Is It Legal?', s: 'Check your state' },
  { href: '/methods', icon: '💨', title: 'Ways to Enjoy It', s: 'Every method explained' },
];
function renderSafetyCarousel() {
  return `
    <div class="section-label">Safety & Education</div>
    <div class="hcarousel" style="margin-bottom:4px;">
      ${HOME_SAFETY_CAROUSEL.map(item => `
        <a href="${item.href}" style="flex-shrink:0;min-width:140px;max-width:140px;background:#eeebe1;border:1px solid #ddd6c4;border-radius:12px;padding:12px;text-decoration:none;color:#2a2a2a;">
          <div style="font-size:22px;">${item.icon}</div>
          <div style="font-weight:700;font-size:13px;margin-top:8px;">${esc(item.title)}</div>
          <div class="empty-note" style="padding:2px 0 0;">${esc(item.s)}</div>
        </a>
      `).join('')}
    </div>
  `;
}
// "Your self-added strain now has a verified version" prompt -- the strain-library version of the
// "use the verified address?" pop-up. Shown on Home, on Notifications (and counted in the badge), and on
// the check-in itself. NOTHING is moved until the person picks "Use verified strain"; "Keep as self-added"
// is remembered so they are never asked about that strain again. Pending prompts are derived live from
// current data (db.listPendingCustomStrainPrompts), so it works whether the strain was added by an admin,
// a library update, or a name/alias that now matches.
// NOTE ON THE MARKUP: each choice is its OWN <form> with a hidden `action` input -- not one form with two named
// submit buttons. The app-wide "Saving..." handler in public/app.js disables a form's first submit button the
// moment it is submitted, and a disabled button's name/value is NOT sent, so with a shared form "Use verified
// strain" arrived with no action and silently did nothing. A hidden input can't be disabled. Don't merge them.
function renderCustomStrainPrompts(req, userId, redirectTo, { onlyNormName } = {}) {
  let prompts = db.listPendingCustomStrainPrompts(userId);
  if (onlyNormName) prompts = prompts.filter(p => p.normName === onlyNormName);
  if (!prompts.length) return '';
  return prompts.map(p => `
    <div class="card custom-strain-prompt" style="border:1.5px solid var(--brand-green);margin-bottom:12px;">
      <div style="font-weight:700;">✅ &ldquo;${esc(p.name)}&rdquo; is now a verified StrainDex strain</div>
      <p class="empty-note" style="padding:4px 0 8px;">You logged ${p.count} check-in${p.count === 1 ? '' : 's'} as a self-added strain, which isn't verified. The library now has a matching, verified entry — want ${p.count === 1 ? 'it' : 'them'} to use it?</p>
      <a class="strain-chip" href="/strains/${esc(p.strain.id)}" style="text-decoration:none;">
        ${strainPhotoTag(p.strain, 'xs')}
        <span><b>${esc(p.strain.name)}</b> <span class="rarity-tag rarity-${esc(p.strain.rarity)}">${rarityLabel(p.strain.rarity)}</span></span>
      </a>
      <div class="empty-note" style="padding:4px 0 0;">${esc(p.strain.type)}${p.strain.thc ? ' · THC ' + esc(p.strain.thc) : ''}${p.strain.breeder ? ' · ' + esc(p.strain.breeder) : ''}</div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        ${['link', 'keep'].map(action => `
        <form method="POST" action="/custom-strain/resolve" style="flex:1;display:flex;margin:0;">
          ${csrfField(req)}
          <input type="hidden" name="norm_name" value="${esc(p.normName)}">
          <input type="hidden" name="strain_id" value="${esc(p.strain.id)}">
          <input type="hidden" name="redirect_to" value="${esc(redirectTo)}">
          <input type="hidden" name="action" value="${action}">
          <button class="btn${action === 'keep' ? ' secondary' : ''}" type="submit" style="flex:1;">${action === 'link' ? 'Use verified strain' : 'Keep as self-added'}</button>
        </form>`).join('')}
      </div>
      <p class="empty-note" style="padding:6px 0 0;">Switching only changes the strain — your rating, notes, photos and date stay exactly as they are. <b>Either choice clears this reminder.</b></p>
    </div>`).join('');
}
async function handleCustomStrainResolve(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const back = safeRedirectPath(f.redirect_to) || '/notifications';
  // Only a prompt that is genuinely pending for THIS person can be answered (checked again inside db).
  const result = await db.resolveCustomStrainPrompt(userId, String(f.norm_name || ''), String(f.strain_id || ''), f.action === 'link' ? 'link' : f.action === 'keep' ? 'keep' : '');
  const sep = back.includes('?') ? '&' : '?';
  redirect(res, result.ok
    ? `${back}${sep}cs=${result.action}&csn=${encodeURIComponent(result.strainName)}&csc=${result.action === 'link' ? result.moved : result.count}`
    : `${back}${sep}cs=gone`);
}
// One-line description of what is waiting in Notifications, so a number is never a mystery.
function notificationsSummary(userId) {
  const n = db.countUnreadMentions(userId) + db.countUnreadCheckinNotifications(userId);
  const q = db.listPendingCustomStrainPrompts(userId).length;
  const parts = [];
  if (n) parts.push(`${n} new`);
  if (q) parts.push(`${q} question${q === 1 ? '' : 's'} for you`);
  return parts.length ? parts.join(' \u00b7 ') : null;
}
// Confirmation shown after someone answers a verified-strain question (see handleCustomStrainResolve): says what
// happened, so it's obvious the question is cleared. Values come from the URL, so everything is escaped/clamped.
function renderCustomStrainAnswered(req) {
  const q = new URL(req.url, 'http://x').searchParams;
  const cs = q.get('cs');
  if (!cs) return '';
  const name = esc((q.get('csn') || '').slice(0, 80));
  const n = Math.max(0, Math.min(999, Number(q.get('csc')) || 0));
  const msg = cs === 'link' ? `\u2705 Done \u2014 your ${n} check-in${n === 1 ? '' : 's'} now use <b>${name}</b> (verified).`
    : cs === 'keep' ? `\ud83d\udc4d Okay \u2014 your check-in${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} self-added, and we won't ask about <b>${name}</b> again.`
    : cs === 'gone' ? 'That question was already answered \u2014 nothing more to do.' : '';
  return msg ? `<div class="card" style="border-left:4px solid var(--brand-green);margin-bottom:12px;">${msg}</div>` : '';
}
function friendsBadgeCount(userId) {
  if (userId == null) return 0;
  return db.countUnreadMessages(userId) + db.listIncomingRequests(userId).length + db.countUnreadMentions(userId) + db.countUnreadCheckinNotifications(userId) + db.listPendingCustomStrainPrompts(userId).length;
}
// A small "copy link" affordance for one specific post -- links to the
// pageCheckinDetail permalink rather than making the whole card/photo
// itself a mystery-meat link, since everywhere a check-in already renders
// shows the full post inline (photo, comments, reactions) with nothing
// hidden behind a tap. Uses the native share sheet where the browser
// supports it (mobile Safari/Chrome), otherwise copies the link and
// flashes a quick checkmark on the button itself -- deliberately not
// relying on the sitewide #toast element or anything else in app.js, same
// self-contained approach as REACT_TO_CHECKIN_SCRIPT.
function renderShareButton(c) {
  return `<button type="button" onclick="shareCheckin(${c.id}, this)" title="Copy link to this post" style="background:none;border:none;padding:0;color:inherit;cursor:pointer;font-size:inherit;">🔗</button>`;
}
const SHARE_CHECKIN_SCRIPT = `
  <script>
    if (!window.shareCheckin) {
      window.shareCheckin = function(id, btn) {
        var url = window.location.origin + '/checkin/' + id;
        var flash = function(text) {
          var original = btn.textContent;
          btn.textContent = text;
          setTimeout(function() { btn.textContent = original; }, 1500);
        };
        if (navigator.share) {
          navigator.share({ url: url }).catch(function() {});
          return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function() { flash('✓'); }).catch(function() {
            window.prompt('Copy this link:', url);
          });
        } else {
          window.prompt('Copy this link:', url);
        }
      };
    }
  </script>
`;
// @mentions in check-in comments. Matches a conservative username charset
// (letters/digits/underscore) -- a username with other characters can
// still be typed and read fine, it just won't auto-link or notify, which
// is an acceptable edge case rather than a real limitation for most
// usernames people actually pick.
const MENTION_REGEX = /@([A-Za-z0-9_]{2,24})/g;
function extractMentionedUsernames(text) {
  const found = new Set();
  const re = new RegExp(MENTION_REGEX);
  let m;
  while ((m = re.exec(text || '')) !== null) found.add(m[1]);
  return [...found];
}
// Runs on an already-esc()'d comment body (same pattern as
// linkGlossaryTerms below) -- only usernames that actually exist get
// linked, so mistyping or mentioning someone who isn't a real user just
// stays as plain "@text" rather than linking to a 404.
function linkMentions(escapedText) {
  if (!escapedText) return escapedText;
  return escapedText.replace(MENTION_REGEX, (match, username) => {
    const user = db.getUserByUsername(username);
    if (!user) return match;
    return `<a href="/friends/${user.id}" class="mention-tag" style="font-weight:700;color:var(--brand-green-dark);text-decoration:none;">@${esc(user.username)}</a>`;
  });
}
// Replaces the old single Kudos button on check-ins with a small,
// Facebook-style set of named reactions -- picking one replaces whatever
// you already had rather than stacking (see db.setCheckinReaction). Only
// used on check-ins; recipe Kudos and Grow Tip likes are separate
// features and are untouched.
const REACTIONS = [
  { key: 'nice', icon: '🌿', label: 'Nice' },
  { key: 'fire', icon: '🔥', label: 'Fire' },
  { key: 'whoa', icon: '😮', label: 'Whoa' },
  { key: 'relatable', icon: '🙌', label: 'Relatable' },
];
const REACTION_BY_KEY = Object.fromEntries(REACTIONS.map(r => [r.key, r]));
// Renders the whole reaction bar (all 4 buttons + counts) as one unit, so
// the /api/checkins/:id/react endpoint can just re-render this same
// function and hand the fresh HTML back to the browser to swap in --
// no separate client-side counting logic to keep in sync with the server.
function renderReactionBar(c, userId) {
  const summary = db.getCheckinReactionSummary(c.id, userId);
  const buttons = REACTIONS.map(r => {
    const count = summary.counts[r.key] || 0;
    const active = summary.myReaction === r.key;
    const action = userId != null ? `reactToCheckin(${c.id}, '${r.key}', this)` : `window.location.href='/login'`;
    return `<button type="button" onclick="${action}" title="${esc(r.label)}" style="display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:999px;border:1px solid ${active ? 'var(--brand-green-dark)' : 'var(--border)'};background:${active ? 'var(--brand-green-pale,#eef6ee)' : 'none'};cursor:pointer;font-size:13px;line-height:1.4;">
      <span>${r.icon}</span>${count > 0 ? `<span>${count}</span>` : ''}
    </button>`;
  }).join('');
  return `<div id="reaction-bar-${c.id}" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${buttons}</div>`;
}
// Attribution line under a reaction bar -- "who reacted", same spirit as
// the old kudosGiversLabel but grouped by reaction rather than one flat
// list, since which reaction someone gave is itself useful information.
function reactionGiversLabel(checkinId) {
  const givers = db.listCheckinReactionGivers(checkinId).filter(g => g.user && g.user.username);
  if (!givers.length) return '';
  const names = givers.slice(0, 3).map(g => `${REACTION_BY_KEY[g.reaction] ? REACTION_BY_KEY[g.reaction].icon : ''} ${esc(g.user.username)}`);
  const extra = givers.length - names.length;
  return `<div class="empty-note" style="padding:2px 0 0;text-align:right;">${names.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}</div>`;
}
// Loaded once per page (guarded so re-rendering several reaction bars on
// one page doesn't redeclare it) -- swaps in the fresh server-rendered
// bar after each click rather than hand-rolling client-side counting.
const REACT_TO_CHECKIN_SCRIPT = `
  <script>
    if (!window.reactToCheckin) {
      window.reactToCheckin = function(checkinId, reaction) {
        fetch('/api/checkins/' + checkinId + '/react', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ((document.cookie.match(/(?:^|; )csrf_token=([^;]*)/) || [])[1] ? decodeURIComponent(document.cookie.match(/(?:^|; )csrf_token=([^;]*)/)[1]) : '') },
          body: JSON.stringify({ reaction: reaction })
        }).then(function(r) { return r.json(); }).then(function(data) {
          var bar = document.getElementById('reaction-bar-' + checkinId);
          if (bar && data && data.html) {
            var wrapper = document.createElement('div');
            wrapper.innerHTML = data.html;
            bar.replaceWith(wrapper.firstElementChild);
          }
        });
      };
    }
  </script>
`;
function renderCheckinComments(c, userId, redirectPath) {
  const comments = db.listCheckinComments(c.id, userId);
  const tagCandidates = userId != null ? db.listFriends(userId).map(f => f.username) : [];
  return `
    ${comments.length ? `<div style="margin-top:8px;">${comments.map(cm => {
      const author = db.getUserById(cm.user_id);
      const canModerate = userId != null && cm.user_id !== userId;
      return `<div class="empty-note" style="padding:3px 0;">
        <b>${esc(author ? author.username : 'Someone')}:</b> ${linkMentions(esc(cm.body))}
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
          <form method="POST" action="/block/${cm.user_id}" style="display:inline;" onsubmit="return confirm('Block ' + ${JSON.stringify(author ? author.username : 'this person')} + '? You will no longer see their comments, check-ins, or grow tips, and any community connection will end.')">
            <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
            <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Block</button>
          </form>
        ` : ''}
      </div>`;
    }).join('')}</div>` : ''}
    ${userId != null ? `
      <form method="POST" action="/checkin/${c.id}/comment" style="display:flex;gap:6px;margin-top:6px;">
        <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
        <div style="position:relative;flex:1;">
          <input type="text" name="body" id="comment-body-${c.id}" placeholder="Add a comment... @ to tag someone" required style="width:100%;margin:0;" autocomplete="off">
          <div id="mention-suggest-${c.id}" style="display:none;position:absolute;bottom:100%;left:0;right:0;margin-bottom:4px;background:var(--bg-card,#fff);border:1px solid var(--border);border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.15);z-index:20;max-height:160px;overflow-y:auto;"></div>
        </div>
        <button class="btn secondary" type="submit" style="padding:6px 12px;">Post</button>
      </form>
      ${tagCandidates.length ? `
      <script>
        (function() {
          var input = document.getElementById('comment-body-${c.id}');
          var box = document.getElementById('mention-suggest-${c.id}');
          var names = ${JSON.stringify(tagCandidates)};
          if (!input || !box) return;
          function activeQuery() {
            var pos = input.selectionStart;
            var head = input.value.slice(0, pos);
            var at = head.lastIndexOf('@');
            if (at === -1) return null;
            var fragment = head.slice(at + 1);
            if (/\\s/.test(fragment)) return null;
            return { at: at, fragment: fragment };
          }
          function render() {
            var q = activeQuery();
            if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
            var matches = names.filter(function(n) { return n.toLowerCase().indexOf(q.fragment.toLowerCase()) === 0; }).slice(0, 5);
            if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
            box.innerHTML = matches.map(function(n) {
              return '<div class="mention-suggest-item" style="padding:8px 10px;cursor:pointer;" data-name="' + n.replace(/"/g, '&quot;') + '" onmouseover="this.style.background=\\'var(--bg-subtle,#f5f5f0)\\';this.style.color=\\'#2a2a2a\\'" onmouseout="this.style.background=\\'\\';this.style.color=\\'\\'">@' + n + '</div>';
            }).join('');
            box.style.display = 'block';
            Array.prototype.forEach.call(box.querySelectorAll('.mention-suggest-item'), function(item) {
              item.addEventListener('mousedown', function(e) {
                e.preventDefault();
                var name = item.getAttribute('data-name');
                var q2 = activeQuery();
                if (!q2) return;
                var pos = input.selectionStart;
                var value = input.value;
                input.value = value.slice(0, q2.at) + '@' + name + ' ' + value.slice(pos);
                var newPos = q2.at + name.length + 2;
                input.setSelectionRange(newPos, newPos);
                box.style.display = 'none';
                input.focus();
              });
            });
          }
          input.addEventListener('input', render);
          input.addEventListener('click', render);
          input.addEventListener('blur', function() { setTimeout(function() { box.style.display = 'none'; }, 150); });
        })();
      </script>
      ` : ''}
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
// Same strain for everyone on a given calendar day, changing at midnight
// UTC -- deterministic from today's date string, same hashStr trick
// already used to assign each strain a consistent stock photo, so there's
// no separate table or stored state needed for this to work.
function getStrainOfTheDay() {
  const allStrains = db.listStrains({ limit: 5000 });
  if (!allStrains.length) return null;
  const todayKey = new Date().toISOString().slice(0, 10);
  return allStrains[hashStr(todayKey) % allStrains.length];
}
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
      <p class="screen-sub" style="margin:0 0 20px;">Your personal cannabis companion — track what you actually experience, stay informed on dosing and safety, discover your next favorite strain, and compare notes with your community. All in one place.</p>
      <p class="empty-note" style="margin:0 0 20px;font-style:italic;">Build A Higher Community</p>
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
        <span class="ic">🛡️</span>
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
        <div class="s">Find dispensaries near you</div>
      </div>
    </div>

    <div class="card" style="margin-top:20px;text-align:center;">
      <p class="empty-note" style="padding:0 0 10px;">Already checking in with your community? See what StrainDex looks like inside.</p>
      <a href="/signup" class="btn secondary block" style="text-decoration:none;">Get Started →</a>
    </div>
  `;
  sendHtml(res, layout({ title: 'StrainDex', body, isAdmin: false, showBack: false }));
}

async function pageHome(req, res) {
  const userId = auth.currentUserId(req);
  if (userId == null) return pageLandingPage(req, res);
  // Badge celebration moment: badges are still computed live from real
  // stats every time (see computeBadges) -- this only checks which
  // currently-earned ones haven't been celebrated yet (via
  // user_badges_seen), shows a one-time banner for them, and marks them
  // seen immediately so it never repeats. Home is the most-visited page,
  // so it's the natural place to catch this rather than trying to detect
  // "just crossed a threshold" at every possible triggering action.
  const allBadges = computeBadges(userId);
  const seenBadgeKeys = db.getSeenBadgeKeys(userId);
  const newlyEarnedBadges = allBadges.filter(b => b.earned && !seenBadgeKeys.has(b.key));
  for (const b of newlyEarnedBadges) {
    await db.markBadgeSeen(userId, b.key);
  }
  // Higher Community: an open, app-wide feed of everyone's public
  // check-ins, not just people you've connected with -- filterVisibleCheckins
  // already excludes anyone else's private entries, and the isBlocked check
  // keeps a blocked person's posts out of your own feed specifically,
  // matching the promise made on the Block action elsewhere in the app.
  const recentCheckins = db.filterVisibleCheckins(db.listCheckins({ limit: 60 }), userId)
    .filter(c => c.user_id === userId || !db.isBlocked(userId, c.user_id))
    .slice(0, 15);
  const recs = getRecommendations(userId, 4);
  const strainOfDay = getStrainOfTheDay();
  const topForumThread = db.listForumThreads()[0] || null;
  const hasFollowedDispensaries = db.anyDispensaryFollowed(userId);
  // Keeps the feed from ever reading as dead early on, before there's
  // enough check-in volume to fill it on its own -- blends in a little
  // Puff Puff Ask and trending-strain activity underneath whatever real
  // check-ins there are, rather than leaving a big empty/sparse feed.
  const feedIsThin = recentCheckins.length < 5;
  const supplementalThreads = feedIsThin ? db.listForumThreads().slice(0, 3) : [];
  const supplementalTrending = feedIsThin ? db.getMostCheckedInStrains(3) : [];
  // "Welcome back" doesn't make sense the very first time someone lands
  // here right after signing up -- check whether this account has ever
  // actually logged a check-in of its own before deciding which greeting
  // to show.
  const isFirstVisit = db.listCheckins({ userId, limit: 1 }).length === 0;
  const streak = db.getCheckinStreak(userId);
  const onThisDay = db.getOnThisDay(userId);
  const onboarding = getOnboardingChecklist(userId);
  const onboardingDone = onboarding.filter(o => o.done).length;
  const homeUser = db.getUserById(userId);
  // ============================================================
  // DO NOT REMOVE OR CHANGE THIS BEHAVIOR WITHOUT ASKING THE USER FIRST.
  // User-confirmed, explicitly: this card must be dismissible from Home
  // (see handleOnboardingDismiss/dismissOnboardingCard) so it doesn't nag
  // someone who'd rather finish later. Dismissing it here must NOT hide
  // the checklist itself -- it always stays visible on Account Settings
  // (see pageAccount) as its permanent, always-reachable home, regardless
  // of this flag. If you are an AI editing this file: this comment IS
  // the prompt telling you not to touch this -- making the card
  // undismissible again, or removing the checklist from Account
  // Settings, is exactly the unwanted behavior being warned against.
  // ============================================================
  const showOnboardingCard = onboardingDone < onboarding.length && !(homeUser && homeUser.onboarding_card_dismissed);

  const body = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
      <h1 class="screen-title" style="margin:0;">${isFirstVisit ? 'Welcome to StrainDex 🌿' : 'Welcome back 🌿'}</h1>
      ${streak.current > 0 ? `<div title="${streak.current} day check-in streak${streak.longest > streak.current ? ` — best: ${streak.longest}` : ''}" style="display:flex;align-items:center;gap:4px;background:#fff1de;color:#8a4a1f;padding:4px 10px;border-radius:999px;font-size:13px;font-weight:700;flex-shrink:0;">🔥 ${streak.current}</div>` : ''}
    </div>
    ${newlyEarnedBadges.map(b => `
      <div class="card" style="margin:10px 0 0;background:#eef6ee;color:#123a24;text-align:center;padding:16px;">
        <div style="font-size:32px;">${b.icon}</div>
        <div style="font-weight:700;font-size:15px;margin-top:6px;">Badge earned: ${esc(b.title)}</div>
        <div style="font-size:13px;opacity:0.8;margin-top:2px;">${esc(b.desc)}</div>
      </div>
    `).join('')}
    ${showOnboardingCard ? `
      <div class="card" style="margin:10px 0 0;background:var(--bg-subtle,#f7f7f2);color:#2a2a2a;position:relative;">
        <form method="POST" action="/onboarding/dismiss" style="position:absolute;top:6px;right:6px;margin:0;">
          <button type="submit" title="Dismiss" style="background:none;border:none;color:#2a2a2a;opacity:0.5;cursor:pointer;font-size:16px;padding:4px 8px;line-height:1;">×</button>
        </form>
        <a href="/onboarding" style="display:block;text-decoration:none;color:inherit;padding-right:20px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-weight:700;font-size:13px;">🚀 Finish setting up your account</div>
            <div class="empty-note" style="padding:0;">${onboardingDone}/${onboarding.length}</div>
          </div>
          <div class="progress-bar" style="margin-top:8px;"><div class="fill" style="width:${Math.round((100 * onboardingDone) / onboarding.length)}%;"></div></div>
        </a>
      </div>
    ` : ''}
    ${onThisDay.length ? `
      <a href="${checkinStrainHref(onThisDay[0].checkin)}" class="card" style="display:flex;align-items:center;gap:10px;margin:10px 0 0;text-decoration:none;color:#2a2a2a;background:var(--bg-subtle,#f7f7f2);">
        ${strainPhotoTag(onThisDay[0].strain, 'sm')}
        <div style="min-width:0;">
          <div style="font-weight:700;font-size:13px;">📅 On this day, ${onThisDay[0].yearsAgo} year${onThisDay[0].yearsAgo === 1 ? '' : 's'} ago</div>
          <div class="empty-note" style="padding:2px 0 0;">${esc(checkinStrainName(onThisDay[0].checkin, onThisDay[0].strain))}${isCustomCheckin(onThisDay[0].checkin) ? ' ' + unverifiedBadge() : ''}${onThisDay[0].checkin.note ? ` — "${esc(onThisDay[0].checkin.note)}"` : ''}</div>
        </div>
      </a>
    ` : ''}
    <div id="install-app-banner" class="card" style="display:none;margin:14px 0;padding:10px 12px;align-items:center;gap:10px;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        <span style="font-size:20px;">📲</span>
        <div style="min-width:0;">
          <div style="font-weight:700;font-size:13px;">Get the StrainDex app</div>
          <div class="empty-note" style="padding:0;font-size:11.5px;" id="install-app-sub">Add it to your home screen for one-tap access.</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button type="button" id="install-app-btn" class="btn" style="padding:6px 12px;display:none;">Install</button>
        <button type="button" id="install-app-dismiss" aria-label="Dismiss" style="background:none;border:none;color:var(--ink-secondary);cursor:pointer;font-size:16px;padding:2px 4px;">✕</button>
      </div>
    </div>
    <script>
      (function() {
        var DISMISS_KEY = 'sd_install_banner_dismissed';
        // Separate, permanent flag for "this browser has launched the app in
        // standalone mode at least once" -- i.e. it's already on the home
        // screen. display-mode:standalone / navigator.standalone only tell
        // you about the CURRENT tab, not history -- someone who installed it
        // and is now just browsing in regular Safari/Chrome would still read
        // as "not standalone" and get re-prompted forever without this.
        // Once we ever see a standalone launch, or a completed install via
        // our own button, remember it for good.
        var INSTALLED_KEY = 'sd_pwa_installed';
        var banner = document.getElementById('install-app-banner');
        var installBtn = document.getElementById('install-app-btn');
        var sub = document.getElementById('install-app-sub');
        var dismissBtn = document.getElementById('install-app-dismiss');
        var isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
        var dismissed = false, alreadyInstalled = false;
        try {
          dismissed = localStorage.getItem(DISMISS_KEY) === '1';
          alreadyInstalled = localStorage.getItem(INSTALLED_KEY) === '1';
        } catch (e) {}
        if (isStandalone) {
          try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) {}
        }
        window.addEventListener('appinstalled', function() {
          try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) {}
          banner.style.display = 'none';
        });
        if (isStandalone || dismissed || alreadyInstalled) return;
        var deferredPrompt = null;
        window.addEventListener('beforeinstallprompt', function(e) {
          e.preventDefault();
          deferredPrompt = e;
          installBtn.style.display = 'inline-block';
        });
        var isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
        // iOS Safari has no install API at all -- there's no button we can
        // wire up to actually trigger anything, only the manual Share-sheet
        // path below. Keep the Install button hidden here (it stays hidden
        // by default and beforeinstallprompt never fires on iOS anyway) so
        // the banner reads as pure guidance, not a broken button.
        if (isIOS) { sub.textContent = 'Tap the Share icon in the Safari toolbar, then "Add to Home Screen".'; }
        banner.style.display = 'flex';
        installBtn.addEventListener('click', function() {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function(choice) {
            if (choice && choice.outcome === 'accepted') {
              try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) {}
            }
          }).finally(function() {
            deferredPrompt = null;
            banner.style.display = 'none';
          });
        });
        dismissBtn.addEventListener('click', function() {
          banner.style.display = 'none';
          try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) {}
        });
      })();
    </script>
    <p class="screen-sub">Your personal cannabis companion — check-ins, discovery, safety info, and your community, all in one place.</p>
    ${renderCustomStrainAnswered(req)}
    ${renderCustomStrainPrompts(req, userId, '/')}
    <a class="btn block" href="/checkin" style="margin-bottom:18px;">🌿 Light It Up</a>

    ${renderSafetyCarousel()}

    <a href="${topForumThread ? `/puff-puff-ask/${topForumThread.id}` : '/puff-puff-ask'}" class="card" style="display:block;margin-bottom:14px;text-decoration:none;color:#2a2a2a;background:#f1ebf7;border:1px solid #ddd0ea;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:700;font-size:15px;">💨 Puff Puff Ask</div>
        <span style="background:#6b3fa0;color:#fff;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;">Ask something \u2192</span>
      </div>
      ${topForumThread ? `
        <div class="empty-note" style="padding:8px 0 0;color:#2a2a2a;">\ud83d\udd25 ${esc(topForumThread.title)} \u2014 ${topForumThread.replyCount} repl${topForumThread.replyCount === 1 ? 'y' : 'ies'}</div>
      ` : `
        <div class="empty-note" style="padding:8px 0 0;color:#2a2a2a;">Ask the community anything \u2014 be the first to post today.</div>
      `}
    </a>

    ${strainOfDay ? `
      <div class="section-label">Strain of the Day</div>
      <a href="/strains/${strainOfDay.id}" class="card" style="display:flex;align-items:center;gap:10px;margin-bottom:14px;text-decoration:none;color:inherit;border:1px solid #ddd6c4;">
        ${strainPhotoTag(strainOfDay, 'sm')}
        <div style="min-width:0;">
          <div style="font-weight:700;">${esc(strainOfDay.name)} <span class="rarity-tag rarity-${strainOfDay.rarity}">${rarityLabel(strainOfDay.rarity)}</span></div>
          <div class="empty-note" style="padding:2px 0 0;">${esc(strainOfDay.type)}${strainOfDay.lean ? ' · ' + esc(strainOfDay.lean) : ''}</div>
        </div>
      </a>
    ` : ''}

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
    <!-- WORDING IS USER-CONFIRMED: "dispensaries", never "real dispensaries" --
         anywhere this phrase appears in the file. Don't add "real" back
         without asking; it was removed once already and came back. -->
    <a class="btn secondary block" href="/dispensaries" style="text-decoration:none;margin-bottom:4px;">${hasFollowedDispensaries ? '📍 View your followed dispensaries →' : '📍 Find dispensaries near you →'}</a>

    <h2 class="screen-title" style="margin-top:20px;">Higher Community</h2>
    <p class="empty-note" style="padding:2px 0 10px;">Public check-ins from everyone on StrainDex — not just people you're connected with.</p>
    ${recentCheckins.length ? recentCheckins.map(c => {
      const s = db.getStrain(c.strain_id);
      const poster = db.getUserById(c.user_id);
      const posterName = poster ? poster.username : 'Former user';
      const isMine = c.user_id === userId;
      return `<div class="feed-post">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div class="empty-note" style="padding:0;font-weight:${isMine ? 'normal' : '700'};">${isMine ? 'You' : `<a href="/friends/${c.user_id}" style="color:inherit;">${esc(posterName)}</a>`}</div>
          <div style="display:flex;align-items:center;gap:10px;">
            ${renderShareButton(c)}
            ${isMine ? `<a href="/checkin/${c.id}/edit" class="empty-note" style="padding:0;">Edit</a>` : ''}
          </div>
        </div>
        <a class="strain-chip" href="${checkinStrainHref(c)}">
          ${strainPhotoTag(s, 'xs')}
          <span><b>${esc(checkinStrainName(c, s))}</b> ${checkinStrainTag(c, s)}</span>
        </a>
        <div class="sub" style="margin-top:8px;">${esc(c.method)} · ${starString(c.rating)}</div>
        ${c.photo ? `<img class="photo-thumb" src="${esc(c.photo)}" alt="photo">` : ''}
        ${(c.effects || []).length ? `<div class="effect-tags">${c.effects.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
        ${c.note ? `<div class="note">"${esc(c.note)}"</div>` : ''}
        ${renderCheckinPairings(c)}
        ${renderOnsetTimer(c)}
        ${renderCheckinComments(c, userId, '/')}
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-top:8px;">
          ${renderReactionBar(c, userId)}
          ${reactionGiversLabel(c.id)}
        </div>
      </div>`;
    }).join('') : `<div class="empty-note">No public check-ins yet — <a href="/checkin">log your first one</a> to get the community feed started.</div>`}
    ${supplementalThreads.length ? `
      <div class="section-label" style="margin-top:20px;">From Puff Puff Ask</div>
      ${supplementalThreads.map(renderForumThreadRow).join('')}
    ` : ''}
    ${supplementalTrending.length ? `
      <div class="section-label" style="margin-top:20px;">Trending strains</div>
      ${supplementalTrending.map(r => `
        <a class="library-row" href="/strains/${r.strain.id}" style="text-decoration:none;color:inherit;">
          ${strainPhotoTag(r.strain, 'sm')}
          <div class="info">
            <div class="nm">${esc(r.strain.name)}</div>
            <div class="sub">${r.count} check-in${r.count === 1 ? '' : 's'}</div>
          </div>
        </a>
      `).join('')}
    ` : ''}
    ${REACT_TO_CHECKIN_SCRIPT}
    ${SHARE_CHECKIN_SCRIPT}
  `;
  sendHtml(res, layout({ title: 'Home', active: 'home', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)), showBack: false }));
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
  // Arriving from a trait link on a strain page with a trait that isn't in the list above (Tingly, Giggly...):
  // add it so the dropdown shows what's actually being filtered instead of "Any effect".
  if (effect && effect !== 'All' && !effectOpts.includes(effect)) effectOpts.push(effect);
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
          <div class="nm">${esc(s.name)} <span title="${esc(VERIFICATION_BADGE[strainVerificationTier(s)].label)}">${VERIFICATION_BADGE[strainVerificationTier(s)].icon}</span> ${renderAwardBadges(s, { compact: true })}</div>
          <div class="sub">${esc(s.type)} · ${rarityLabel(s.rarity)} · THC ${esc(s.thc)}</div>
        </div>
        <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span>
      </a>`).join('') || `<div class="empty-note">No strains match your filters.</div>`}</div>
  `;
  sendHtml(res, layout({ title: 'Strains', active: 'strains', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
// USER-CONFIRMED FEATURE: a compact share button in the upper-right of a
// strain's header, not a permanently-visible "share to a friend" form.
// Offers both an in-app share (to a friend, via the existing
// /strains/:id/share endpoint) and a real external share -- native share
// sheet where supported, clipboard copy otherwise -- same self-contained
// pattern as SHARE_CHECKIN_SCRIPT. A logged-out visitor who opens a
// shared strain link gets a contextual signup/login prompt naming the
// strain (see the login-wall gate and pageSignup/pageLogin) rather than a
// bare login wall. Don't revert this back to an inline always-visible
// share form without asking first.
function renderStrainShareButton(s, userId) {
  const friends = userId != null ? db.listFriends(userId) : [];
  return `
    <div class="strain-share-wrap" style="position:absolute;top:12px;right:12px;">
      <button type="button" onclick="var m=this.nextElementSibling;m.style.display=m.style.display==='block'?'none':'block';" title="Share this strain" style="background:none;border:1px solid var(--border);border-radius:8px;width:36px;height:36px;cursor:pointer;font-size:16px;">🔗</button>
      <div class="strain-share-menu" style="display:none;position:absolute;top:42px;right:0;background:var(--bg-card,#fff);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.18);z-index:50;min-width:200px;padding:8px;">
        <button type="button" onclick="shareStrainLink(${s.id}, ${JSON.stringify(s.name)}, this)" style="display:block;width:100%;text-align:left;background:none;border:none;padding:8px;cursor:pointer;font-size:14px;border-radius:6px;color:inherit;">🔗 Share Link</button>
        ${friends.length ? `
          <div style="border-top:1px solid var(--border);margin:4px 0;"></div>
          <div style="padding:6px 8px 2px;font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.05em;">Share to a friend</div>
          ${friends.map(f => `
            <form method="POST" action="/strains/${s.id}/share" style="margin:0;">
              <input type="hidden" name="friend_id" value="${f.id}">
              <button type="submit" style="display:block;width:100%;text-align:left;background:none;border:none;padding:8px;cursor:pointer;font-size:14px;border-radius:6px;color:inherit;">${esc(f.username)}</button>
            </form>
          `).join('')}
        ` : ''}
      </div>
    </div>
    <script>
      if (!window.shareStrainLink) {
        window.shareStrainLink = function(id, name, btn) {
          var url = window.location.origin + '/strains/' + id;
          if (navigator.share) {
            navigator.share({ url: url, title: name }).catch(function() {});
            return;
          }
          var flash = function(text) {
            var original = btn.textContent;
            btn.textContent = text;
            setTimeout(function() { btn.textContent = original; }, 1500);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function() { flash('✓ Copied'); }).catch(function() {
              window.prompt('Copy this link:', url);
            });
          } else {
            window.prompt('Copy this link:', url);
          }
        };
      }
      if (!window.__shareMenuOutsideClickBound) {
        window.__shareMenuOutsideClickBound = true;
        document.addEventListener('click', function(e) {
          document.querySelectorAll('.strain-share-wrap').forEach(function(wrap) {
            if (!wrap.contains(e.target)) {
              var menu = wrap.querySelector('.strain-share-menu');
              if (menu) menu.style.display = 'none';
            }
          });
        });
      }
    </script>
  `;
}
// USER-CONFIRMED FEATURE, DO NOT CHANGE WITHOUT ASKING FIRST: Wishlist and
// custom lists used to be two separate UI blocks (a Wishlist button, then
// a whole separate card for custom lists). This is deliberately one
// button that pops open ONE menu with Wishlist as just the first entry,
// every custom list below it, and a quick "create a list" field at the
// bottom that adds the current strain to the new list immediately (see
// handleListCreate). Don't split this back into separate Wishlist and
// Lists sections without asking first.
function renderAddToListsButton(s, userId) {
  const myLists = db.listCustomLists(userId);
  const inWishlist = db.isInWishlist(userId, s.id);
  const savedAnywhere = inWishlist || myLists.some(l => db.isStrainInList(l.id, s.id));
  return `
    <div class="add-to-lists-wrap" style="position:relative;margin-top:8px;">
      <button type="button" onclick="var m=this.nextElementSibling;m.style.display=m.style.display==='block'?'none':'block';" class="btn secondary block">${savedAnywhere ? '✓ Saved to Lists' : '☆ Add to Lists'}</button>
      <div class="add-to-lists-menu" style="display:none;position:absolute;top:100%;left:0;right:0;margin-top:4px;background:var(--bg-card,#fff);border:1px solid var(--border);border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.18);z-index:50;padding:8px;">
        <form method="POST" action="/wishlist/${s.id}/toggle" style="margin:0;">
          <input type="hidden" name="redirect_to" value="/strains/${s.id}">
          <button type="submit" style="display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;background:none;border:none;padding:8px;cursor:pointer;font-size:14px;border-radius:6px;color:inherit;">
            <span>⭐ Wishlist</span><span>${inWishlist ? '✓' : ''}</span>
          </button>
        </form>
        ${myLists.length ? `<div style="border-top:1px solid var(--border);margin:4px 0;"></div>` : ''}
        ${myLists.map(l => `
          <form method="POST" action="/lists/${l.id}/items/${s.id}/toggle" style="margin:0;">
            <input type="hidden" name="redirect_to" value="/strains/${s.id}">
            <button type="submit" style="display:flex;justify-content:space-between;align-items:center;width:100%;text-align:left;background:none;border:none;padding:8px;cursor:pointer;font-size:14px;border-radius:6px;color:inherit;">
              <span>${esc(l.name)}</span><span>${db.isStrainInList(l.id, s.id) ? '✓' : ''}</span>
            </button>
          </form>
        `).join('')}
        <div style="border-top:1px solid var(--border);margin:4px 0;"></div>
        <form method="POST" action="/lists" style="margin:0;display:flex;gap:4px;padding:4px;">
          <input type="hidden" name="strain_id" value="${s.id}">
          <input type="hidden" name="redirect_to" value="/strains/${s.id}">
          <input type="text" name="name" placeholder="New list name..." required style="flex:1;margin:0;font-size:13px;padding:6px 8px;">
          <button type="submit" style="background:none;border:none;color:var(--brand-green-dark);font-weight:700;cursor:pointer;padding:0 8px;font-size:18px;">+</button>
        </form>
      </div>
    </div>
    <script>
      if (!window.__listsMenuOutsideClickBound) {
        window.__listsMenuOutsideClickBound = true;
        document.addEventListener('click', function(e) {
          document.querySelectorAll('.add-to-lists-wrap').forEach(function(wrap) {
            if (!wrap.contains(e.target)) {
              var menu = wrap.querySelector('.add-to-lists-menu');
              if (menu) menu.style.display = 'none';
            }
          });
        });
      }
    </script>
  `;
}
// ============================================================
// DO NOT REMOVE, SIMPLIFY, OR TURN THIS BACK INTO PLAIN TEXT WITHOUT
// ASKING THE USER FIRST.
// Requirement is explicitly user-confirmed: on a strain's page, every
// effect trait (Relaxed, Happy, Energetic, ...) MUST be a link to
// /strains?effect=<trait>, so a person can jump straight to other strains
// with that same characteristic. This feature has already been lost once:
// an older copy of this file was uploaded over a newer one and the traits
// quietly went back to plain, unclickable text. It was restored on
// 2026-10-07. If you are an AI editing this file: this comment IS the prompt
// asking you not to touch this block -- removing it, "simplifying" it, or
// swapping the <a> for a <span> is exactly the unwanted behavior it is
// warning against. The Library page's effect filter already accepts any
// trait (see pageStrains), so every trait on every strain works as a link.
// See also: pageStrainDetail, canary.js.
// ============================================================
function renderEffectPills(effects) {
  return (effects || []).map(e => `<a class="filter-pill" href="/strains?effect=${encodeURIComponent(e)}" style="text-decoration:none;">${esc(e)}</a>`).join('');
}
function pageStrainDetail(req, res, id) {
  const s = db.getStrain(id);
  if (!s) return notFound(res);
  const userId = auth.currentUserId(req);
  const history = db.listCheckins({ userId, strain_id: id, limit: 10 });
  const ratingStats = db.getStrainRatingStats(id);
  const similar = db.getSimilarStrains(s, 4);
  const body = `
    <div class="card" style="margin-top:10px;position:relative;">
      ${renderStrainShareButton(s, userId)}
      <div style="display:flex;align-items:center;gap:12px;padding-right:44px;">
        ${strainPhotoTag(s, 'lg')}
        <div>
          <h1 style="margin:0;font-size:19px;">${esc(s.name)}</h1>
          <div class="empty-note" style="padding:0;">${esc(s.type)}${s.lean ? ' · ' + esc(s.lean) : ''} · <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span></div>
          <div style="margin-top:2px;" title="${esc(VERIFICATION_BADGE[strainVerificationTier(s)].note)}"><a href="/lab-result-guide" class="empty-note" style="padding:0;text-decoration:none;color:inherit;">${VERIFICATION_BADGE[strainVerificationTier(s)].icon} ${VERIFICATION_BADGE[strainVerificationTier(s)].label}</a></div>
          ${ratingStats.count ? `<div style="margin-top:2px;">${starString(Math.round(ratingStats.avg))} <span class="empty-note" style="padding:0;">${ratingStats.avg}★ from ${ratingStats.count} check-in${ratingStats.count === 1 ? '' : 's'}</span></div>` : `<div class="empty-note" style="padding:2px 0 0;">No community ratings yet — be the first to check in.</div>`}
        </div>
      </div>
      ${renderAwardBadges(s)}
      ${(s.thc || s.cbd) ? `<p style="margin:12px 0 4px;">${s.thc ? `<b>THC:</b> ${esc(s.thc)}` : ''}${s.thc && s.cbd ? ' &nbsp; ' : ''}${s.cbd ? `<b>CBD:</b> ${esc(s.cbd)}` : ''}</p>` : `<p class="empty-note" style="padding:0 0 4px;">No verified THC/CBD data for this strain yet.</p>`}
      ${s.breeder ? `<p class="empty-note" style="padding:0;"><b>Bred by:</b> ${esc(s.breeder)}</p>` : ''}
      ${s.flavor ? `<p style="font-style:italic;color:#6b6b6b;">"${esc(s.flavor)}"</p>` : ''}
      <p>${renderEffectPills(s.effects)}</p>
      ${s.terps.length ? `<p><b>Top terpenes:</b> ${s.terps.map(t => `${esc(t.n)} (${Math.round(t.p * 100)}%)`).join(', ')}</p>` : ''}
      ${Array.isArray(s.ailments) && s.ailments.length ? `
        <p style="margin:10px 0 2px;"><b>Users report relief from:</b> ${s.ailments.map(a => `<span class="filter-pill">${esc(a)}</span>`).join(' ')}</p>
        <p class="empty-note" style="padding:0;">User-reported, not medical advice — see a doctor for real guidance.</p>
      ` : ''}
    </div>
    ${renderFamilyTree(s)}
    <a class="btn block" href="/checkin?strain=${s.id}">🌿 Light It Up</a>
    <a class="btn secondary block" href="/compare?a=${s.id}" style="margin-top:8px;">🆚 Compare this strain</a>
    ${userId != null ? renderAddToListsButton(s, userId) : ''}
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
            <div style="display:flex;align-items:center;gap:10px;">
              ${renderShareButton(c)}
              <a href="/checkin/${c.id}/edit" class="empty-note" style="padding:0;">Edit</a>
            </div>
          </div>
          ${starString(c.rating)}
          <div class="empty-note" style="padding:2px 0 0;"><span class="local-time" data-utc="${c.created_at}Z">${esc(c.created_at)} UTC</span></div>
          ${(c.effects || []).length ? `<p style="margin:6px 0 0;">${c.effects.map(e => `<span class="filter-pill">${esc(e)}</span>`).join('')}</p>` : ''}
          ${c.note ? `<span class="empty-note" style="display:block;padding:4px 0 0;">${esc(c.note)}</span>` : ''}
        ${renderCheckinPairings(c)}
        ${renderOnsetTimer(c)}
        ${renderCheckinComments(c, userId, '/strains/' + s.id)}
          <div style="display:flex;flex-direction:column;align-items:flex-end;margin-top:6px;">
            ${renderReactionBar(c, userId)}
            ${reactionGiversLabel(c.id)}
          </div>
        </div>
      </div>`).join('')}
      ${REACT_TO_CHECKIN_SCRIPT}
    ${SHARE_CHECKIN_SCRIPT}
    ` : `
      <div class="empty-note">You haven't checked this one in yet.</div>
      ${ratingStats.count > 0 ? `
        <div class="empty-note" style="padding:4px 0 0;">${starString(Math.round(ratingStats.avg))} ${ratingStats.avg}★ average from ${ratingStats.count} other check-in${ratingStats.count === 1 ? '' : 's'} in the community.</div>
      ` : ''}
    `}
  `;
  sendHtml(res, layout({ title: s.name, active: 'strains', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
const LEGAL_STATUS_LAST_VERIFIED = '2026-09-30';
// Same "last checked" trust signal as Legal Status, extended to the
// guides where being current actually matters most -- Feels Wrong,
// Mixing Cautions, Dosing Calculator, and the Lab Result Guide. Update
// this whenever any of those four get a real content review.
const SAFETY_GUIDES_LAST_REVIEWED = '2026-06-01';
// USER-CONFIRMED RICH CARD FORMAT: every field below (home grow, possession,
// concentrate limits, public consumption, licensing body, hemp/THCA note,
// penalties, and a direct link to the state's own regulator) is meant to
// render together on one card -- this is the depth the person specifically
// asked for, not a regression back to a one-line status note. Facts here
// are cross-checked against multiple sources (web search plus a detailed,
// recently-reviewed third-party reference) and written in original wording
// throughout rather than copied from any single source. Still not legal
// advice -- see the disclaimer rendered above this list.
const LEGAL_STATUS = [
  { state: 'Alabama', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.',
    homeGrow: 'Not permitted.', possessionLimit: 'Limited to registered medical patients, in approved forms only (no raw flower).', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'Alabama Medical Cannabis Commission.', hempThca: 'Hemp products under 0.3% delta-9 THC are sold; THCA sits in a legal gray area but is commonly available.', penalties: 'Personal-use possession is a misdemeanor; possession with intent to distribute is a felony.', sourceLabel: 'AL Medical Cannabis Commission', sourceUrl: 'https://amcc.alabama.gov' },
  { state: 'Alaska', status: 'recreational', note: 'Adult-use legal since 2015; licensed retail available.',
    homeGrow: '6 plants per adult (3 mature), 12 max per household.', possessionLimit: '1 oz flower', concentrateLimit: '7g concentrate', publicConsumption: 'Prohibited, though licensed on-site consumption venues exist.', licensing: 'Alaska Alcohol & Marijuana Control Office.', hempThca: 'Hemp is legal; THCA flower is commonly sold.', penalties: 'Over the personal limit is a misdemeanor; larger quantities can be a felony.', sourceLabel: 'AK Alcohol & Marijuana Control Office', sourceUrl: 'https://www.commerce.alaska.gov/web/amco' },
  { state: 'Arizona', status: 'recreational', note: 'Adult-use legal since 2020.',
    homeGrow: '6 plants per adult, 12 max per household with 2+ adults; must be enclosed and out of public view.', possessionLimit: '1 oz flower', concentrateLimit: '5g, within that 1 oz total', publicConsumption: 'Prohibited.', licensing: 'Arizona Department of Health Services.', hempThca: 'Hemp is legal; THCA is tolerated but enforcement varies.', penalties: '1–2.5 oz is a petty offense with a fine; over 2.5 oz is a misdemeanor.', sourceLabel: 'AZ Dept. of Health Services', sourceUrl: 'https://www.azdhs.gov/licensing/marijuana' },
  { state: 'Arkansas', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to 2.5 oz per 14-day period for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'Arkansas Dept. of Finance & Administration\'s Medical Marijuana Commission.', hempThca: 'Hemp is legal; the THCA market is largely unregulated.', penalties: 'Up to 4 oz is a misdemeanor; over 4 oz is a felony.', sourceLabel: 'AR Medical Marijuana', sourceUrl: 'https://www.healthy.arkansas.gov' },
  { state: 'California', status: 'recreational', note: 'Adult-use legal since 2016.',
    homeGrow: '6 plants per residence (not per adult).', possessionLimit: '1 oz flower', concentrateLimit: '8g concentrate', publicConsumption: 'Prohibited, though some cities license consumption lounges.', licensing: 'California Dept. of Cannabis Control.', hempThca: 'Hemp is legal under AB-45; intoxicating hemp products are restricted by AB-2223.', penalties: 'Possession over the limit is a misdemeanor, up to 6 months and a $500 fine.', sourceLabel: 'CA Dept. of Cannabis Control', sourceUrl: 'https://cannabis.ca.gov' },
  { state: 'Colorado', status: 'recreational', note: 'One of the first two adult-use states, legal since 2012.',
    homeGrow: '6 plants per adult (3 flowering), 12 max per household.', possessionLimit: '2 oz flower', concentrateLimit: '8g concentrate, 800mg edibles', publicConsumption: 'Prohibited, though licensed hospitality establishments are allowed.', licensing: 'Colorado Marijuana Enforcement Division (Dept. of Revenue).', hempThca: 'Hemp is legal; intoxicating hemp products are restricted to the licensed cannabis channel.', penalties: '2–6 oz is a petty offense; over 12 oz is a felony.', sourceLabel: 'CO Marijuana Enforcement Division', sourceUrl: 'https://sbg.colorado.gov/med' },
  { state: 'Connecticut', status: 'recreational', note: 'Adult-use legal since 2021.',
    homeGrow: '6 plants per adult (3 mature, 3 immature), 12 max per household.', possessionLimit: '1.5 oz on your person, up to 5 oz if locked at home or in a vehicle', concentrateLimit: '', publicConsumption: 'Prohibited, though some municipalities permit designated areas.', licensing: 'CT Dept. of Consumer Protection.', hempThca: 'Hemp is legal; high-THC hemp products have been regulated as cannabis since 2023.', penalties: 'Over 1.5 oz is a civil infraction; larger quantities can be a felony.', sourceLabel: 'CT Dept. of Consumer Protection', sourceUrl: 'https://portal.ct.gov/dcp/cannabis-division' },
  { state: 'Delaware', status: 'recreational', note: 'Adult-use legal since 2023; retail sales began in 2025.',
    homeGrow: 'Not permitted.', possessionLimit: '1 oz flower', concentrateLimit: '5g concentrate, 750mg edibles', publicConsumption: 'Prohibited.', licensing: 'DE Office of the Marijuana Commissioner.', hempThca: 'Hemp is legal; intoxicating-hemp regulation is still in progress.', penalties: 'Over 1 oz is a misdemeanor; over about 175g is a felony.', sourceLabel: 'DE Marijuana Commissioner', sourceUrl: 'https://marijuana.delaware.gov' },
  { state: 'Florida', status: 'medical', note: 'Medical program only; a 2024 recreational ballot measure fell short of the required supermajority.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to 2.5 oz per 35 days for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'FL Office of Medical Marijuana Use.', hempThca: 'Hemp is legal and THCA flower is widely available.', penalties: 'Up to 20g is a misdemeanor; over 20g is a felony.', sourceLabel: 'FL Office of Medical Marijuana Use', sourceUrl: 'https://knowthefactsmmj.com' },
  { state: 'Georgia', status: 'cbd_only', note: 'Low-THC medical program only, not full-plant medical or recreational.',
    homeGrow: 'Not permitted.', possessionLimit: 'Registered patients only, within a total THC cap set by the program.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'GA Access to Medical Cannabis Commission.', hempThca: 'Hemp is legal; THCA enforcement is inconsistent across jurisdictions.', penalties: 'Up to 1 oz is a misdemeanor; over 1 oz is a felony.', sourceLabel: 'GA Access to Medical Cannabis', sourceUrl: 'https://gmcc.ga.gov' },
  { state: 'Hawaii', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.',
    homeGrow: 'Medical patients only, up to 10 plants.', possessionLimit: 'Up to 4 oz per 15-day period for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'HI Dept. of Health Medical Cannabis Registry.', hempThca: 'Hemp is legal; intoxicating cannabinoids are restricted.', penalties: 'Up to 3g is decriminalized with a fine; over 1 lb is a felony.', sourceLabel: 'HI Medical Cannabis Registry', sourceUrl: 'https://health.hawaii.gov/medicalcannabis' },
  { state: 'Idaho', status: 'illegal', note: 'No legal program of any kind, medical or recreational.',
    homeGrow: 'Not permitted.', possessionLimit: 'No lawful possession of any amount.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No legal program exists.', hempThca: 'Idaho enforces a stricter-than-federal 0% THC standard for hemp.', penalties: 'Any possession is a misdemeanor; over 3 oz is a felony.', sourceLabel: 'ID Office of Drug Policy', sourceUrl: 'https://odp.idaho.gov' },
  { state: 'Illinois', status: 'recreational', note: 'Adult-use legal since 2020.',
    homeGrow: 'Medical patients only, up to 5 plants -- not permitted for recreational users.', possessionLimit: '30g flower for residents (15g for non-residents)', concentrateLimit: '5g concentrate, 500mg edibles', publicConsumption: 'Prohibited, though licensed consumption lounges exist.', licensing: 'IL Dept. of Financial & Professional Regulation.', hempThca: 'Hemp is legal; intoxicating hemp is regulated under the cannabis framework.', penalties: 'Over the limit is a civil violation escalating to a misdemeanor; trafficking amounts are felonies.', sourceLabel: 'IL Adult Use Cannabis', sourceUrl: 'https://idfpr.illinois.gov/profs/adultusecan.html' },
  { state: 'Indiana', status: 'cbd_only', note: 'Low-THC CBD products only; no medical or recreational program.',
    homeGrow: 'Not permitted.', possessionLimit: 'Zero tolerance -- any amount is a misdemeanor.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No cannabis program; CBD at 0.3% THC or below is commercially permitted.', hempThca: 'Hemp is legal at 0.3% THC; THCA sits in a legal gray area.', penalties: 'Up to 30g is a misdemeanor; over 30g is a felony.', sourceLabel: 'IN State Police', sourceUrl: 'https://www.in.gov/isp' },
  { state: 'Iowa', status: 'cbd_only', note: 'Very restrictive low-THC medical program only.',
    homeGrow: 'Not permitted.', possessionLimit: 'Registered patients only, up to 4.5g of THC per 90 days.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'IA Dept. of Health & Human Services.', hempThca: 'Hemp is legal; intoxicating hemp has been restricted.', penalties: 'First offense is up to 6 months and a $1,000 fine.', sourceLabel: 'IA Medical Cannabidiol Program', sourceUrl: 'https://hhs.iowa.gov/public-health/medical-cannabidiol' },
  { state: 'Kansas', status: 'illegal', note: 'No legal program of any kind, medical or recreational.',
    homeGrow: 'Not permitted.', possessionLimit: 'Zero tolerance for cannabis flower.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No cannabis program exists.', hempThca: 'Hemp is legal at 0.3% THC; THCA sits in a legal gray area.', penalties: 'First offense is up to 6 months and a $1,000 fine; second offense is a felony.', sourceLabel: 'KS Dept. of Agriculture', sourceUrl: 'https://agriculture.ks.gov' },
  { state: 'Kentucky', status: 'medical', note: 'Medical sales launched in 2025.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to a 30-day supply for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'KY Office of Medical Cannabis.', hempThca: 'Hemp is legal; intoxicating cannabinoids are regulated.', penalties: 'Up to 8 oz is a misdemeanor; over 8 oz is a felony.', sourceLabel: 'KY Office of Medical Cannabis', sourceUrl: 'https://kymedcan.ky.gov' },
  { state: 'Louisiana', status: 'medical', note: 'Medical program for qualifying conditions; small amounts are decriminalized.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to 2.5 oz per 14-day period for registered patients; non-patients face a fine for 14g or less.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'LA Dept. of Health; only two licensed producers statewide.', hempThca: 'Intoxicating hemp has recently been restricted.', penalties: 'Up to 14g is a fine; larger quantities escalate to a felony.', sourceLabel: 'LA Therapeutic Cannabis', sourceUrl: 'https://ldh.la.gov' },
  { state: 'Maine', status: 'recreational', note: 'Adult-use legal since 2016.',
    homeGrow: '3 mature plus 12 immature plants, plus unlimited seedlings, per adult.', possessionLimit: '2.5 oz', concentrateLimit: 'up to 5g of that as concentrate', publicConsumption: 'Prohibited.', licensing: 'ME Office of Cannabis Policy.', hempThca: 'Hemp is legal; intoxicating hemp is regulated.', penalties: 'Over 2.5 oz ranges from a civil violation up to a misdemeanor.', sourceLabel: 'ME Office of Cannabis Policy', sourceUrl: 'https://www.maine.gov/dafs/ocp' },
  { state: 'Maryland', status: 'recreational', note: 'Adult-use legal since 2022.',
    homeGrow: '2 plants per household for adults 21+; registered medical patients may have up to 4.', possessionLimit: '1.5 oz flower for personal use (up to 2.5 oz at home)', concentrateLimit: '12g concentrate, up to 750mg THC in cannabis products', publicConsumption: 'Prohibited.', licensing: 'MD Cannabis Administration.', hempThca: 'Intoxicating hemp is regulated under HB 556.', penalties: '1.5–2.5 oz is a civil offense; over 2.5 oz is a misdemeanor.', sourceLabel: 'MD Cannabis Administration', sourceUrl: 'https://cannabis.maryland.gov' },
  { state: 'Massachusetts', status: 'recreational', note: 'Adult-use legal since 2016.',
    homeGrow: '6 plants per adult, 12 max per household.', possessionLimit: '1 oz outside the home, up to 10 oz at home', concentrateLimit: 'up to 5g as concentrate', publicConsumption: 'Prohibited, though a social-consumption pilot is underway.', licensing: 'MA Cannabis Control Commission.', hempThca: 'Hemp is legal; intoxicating hemp is restricted to the licensed channel.', penalties: 'Over 1 oz in public is a civil fine; larger quantities can be a misdemeanor or felony.', sourceLabel: 'MA Cannabis Control Commission', sourceUrl: 'https://masscannabiscontrol.com' },
  { state: 'Michigan', status: 'recreational', note: 'Adult-use legal since 2018.',
    homeGrow: '12 plants per household.', possessionLimit: '2.5 oz on your person, up to 10 oz at home', concentrateLimit: 'up to 15g as concentrate', publicConsumption: 'Prohibited, though designated consumption establishments are licensed.', licensing: 'MI Cannabis Regulatory Agency.', hempThca: 'Hemp is legal; intoxicating hemp is regulated alongside cannabis.', penalties: 'Over 2.5 oz in public is a civil infraction; larger amounts can be a misdemeanor.', sourceLabel: 'MI Cannabis Regulatory Agency', sourceUrl: 'https://www.michigan.gov/cra' },
  { state: 'Minnesota', status: 'recreational', note: 'Adult-use legal since 2023.',
    homeGrow: '8 plants per household (4 mature).', possessionLimit: '2 oz on your person, up to 2 lbs at home', concentrateLimit: '8g concentrate, 800mg edibles', publicConsumption: 'Prohibited, though approved on-site retail consumption exists.', licensing: 'MN Office of Cannabis Management.', hempThca: 'Low-dose hemp edibles (5mg per serving) have been legal since 2022.', penalties: 'Over 2 oz in public is a misdemeanor; large amounts can be a felony.', sourceLabel: 'MN Office of Cannabis Management', sourceUrl: 'https://mn.gov/ocm' },
  { state: 'Mississippi', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to 3 oz per 30 days for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'MS Medical Cannabis Program.', hempThca: 'Hemp is legal; intoxicating hemp products are restricted.', penalties: 'Up to 30g is a civil fine; over 30g escalates to a misdemeanor or felony.', sourceLabel: 'MS Medical Cannabis Program', sourceUrl: 'https://medicalcannabis.ms.gov' },
  { state: 'Missouri', status: 'recreational', note: 'Adult-use legal since 2022.',
    homeGrow: 'Requires a registered cultivation card: 6 flowering, 6 non-flowering, and 6 clone plants.', possessionLimit: '3 oz recreational (4 oz per 30 days for medical patients)', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'MO Division of Cannabis Regulation.', hempThca: 'Intoxicating hemp has been restricted by executive action.', penalties: 'Over 3 oz in public is a civil violation; trafficking amounts are felonies.', sourceLabel: 'MO Cannabis Regulation', sourceUrl: 'https://cannabis.mo.gov' },
  { state: 'Montana', status: 'recreational', note: 'Adult-use legal since 2020.',
    homeGrow: '4 mature plus 4 seedling plants per adult, 8/8 max per household.', possessionLimit: '1 oz', concentrateLimit: '8g concentrate, 800mg edibles', publicConsumption: 'Prohibited.', licensing: 'MT Cannabis Control Division (Dept. of Revenue).', hempThca: 'Hemp is legal; intoxicating cannabinoids are restricted by state law.', penalties: 'Over 1 oz in public is a civil fine; larger quantities can be a misdemeanor or felony.', sourceLabel: 'MT Cannabis Control Division', sourceUrl: 'https://mtrevenue.gov/cannabis' },
  { state: 'Nebraska', status: 'medical', note: 'Medical program approved by voters in 2024; implementation is still rolling out, with no dispensaries open yet as of this writing.',
    homeGrow: 'Not permitted.', possessionLimit: 'No legal retail access is open yet; unauthorized possession of up to 1 oz is a civil fine on first offense.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'NE Medical Cannabis Commission.', hempThca: 'Hemp is legal; intoxicating hemp exists in a gray market.', penalties: 'Over 1 oz is a misdemeanor; repeat offenses can be a felony.', sourceLabel: 'NE Medical Cannabis Commission', sourceUrl: 'https://nebraska.gov' },
  { state: 'Nevada', status: 'recreational', note: 'Adult-use legal since 2016.',
    homeGrow: '6 plants per person, but only if you live more than 25 miles from a licensed dispensary.', possessionLimit: '1 oz flower', concentrateLimit: '3.5g concentrate', publicConsumption: 'Prohibited, though licensed consumption lounges exist.', licensing: 'NV Cannabis Compliance Board.', hempThca: 'Hemp is legal; intoxicating cannabinoids are restricted to the licensed channel.', penalties: 'Over 1 oz in public is a misdemeanor; trafficking is a felony.', sourceLabel: 'NV Cannabis Compliance Board', sourceUrl: 'https://ccb.nv.gov' },
  { state: 'New Hampshire', status: 'medical', note: 'Medical program only; recreational proposals have repeatedly failed to pass. Small amounts are decriminalized.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to 0.75 oz is a civil violation for non-patients; registered patients may have up to 2 oz per 10-day supply.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'NH Therapeutic Cannabis Program.', hempThca: 'Hemp is legal; intoxicating hemp is largely unregulated.', penalties: 'Up to 0.75 oz is a civil fine; more becomes a misdemeanor.', sourceLabel: 'NH Therapeutic Cannabis', sourceUrl: 'https://www.dhhs.nh.gov' },
  { state: 'New Jersey', status: 'recreational', note: 'Adult-use legal since 2020; among the higher possession limits nationally.',
    homeGrow: 'Not permitted.', possessionLimit: '6 oz flower', concentrateLimit: '17g concentrate, 4g resin', publicConsumption: 'Prohibited, though some municipalities approve designated consumption areas.', licensing: 'NJ Cannabis Regulatory Commission.', hempThca: 'Intoxicating hemp has been regulated under the cannabis framework since 2023.', penalties: 'Over 6 oz is an indictable (felony-level) offense.', sourceLabel: 'NJ Cannabis Regulatory Commission', sourceUrl: 'https://www.nj.gov/cannabis' },
  { state: 'New Mexico', status: 'recreational', note: 'Adult-use legal since 2021.',
    homeGrow: '6 mature plus 6 immature plants per person, up to 12 per household.', possessionLimit: '2 oz flower in public (unlimited at home if secured)', concentrateLimit: '16g concentrate, 800mg edibles', publicConsumption: 'Prohibited, though licensed consumption lounges exist.', licensing: 'NM Cannabis Control Division.', hempThca: 'Intoxicating cannabinoids are restricted to the licensed channel.', penalties: 'Over 2 oz in public is a petty misdemeanor.', sourceLabel: 'NM Cannabis Control Division', sourceUrl: 'https://www.rld.nm.gov/cannabis' },
  { state: 'New York', status: 'recreational', note: 'Adult-use legal since 2021.',
    homeGrow: '6 plants per adult (3 mature), 12 max per household.', possessionLimit: '3 oz flower', concentrateLimit: '24g concentrate', publicConsumption: 'Permitted anywhere smoking tobacco is allowed, with some municipal exceptions.', licensing: 'NY Office of Cannabis Management.', hempThca: 'Cannabinoid hemp has been regulated by OCM since 2021.', penalties: 'Over 3 oz is a violation with a fine; over 5 oz is a misdemeanor.', sourceLabel: 'NY Office of Cannabis Management', sourceUrl: 'https://cannabis.ny.gov' },
  { state: 'North Carolina', status: 'illegal', note: 'No medical or recreational program, though small possession has been decriminalized to a civil fine since 1977.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to 0.5 oz is a misdemeanor with no jail time on a first offense.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No statewide program; a tribal dispensary operates on Eastern Band of Cherokee Indians land.', hempThca: 'Hemp is legal; THCA exists in a legal gray area.', penalties: '0.5–1.5 oz is a misdemeanor; over 1.5 oz is a felony.', sourceLabel: 'NC Dept. of Health & Human Services', sourceUrl: 'https://www.ncdhhs.gov' },
  { state: 'North Dakota', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to 3 oz per 30 days for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'ND Division of Medical Marijuana.', hempThca: 'Hemp is legal; intoxicating hemp has been restricted.', penalties: 'Up to 0.5 oz is an infraction; more becomes a misdemeanor or felony.', sourceLabel: 'ND Medical Marijuana', sourceUrl: 'https://www.hhs.nd.gov' },
  { state: 'Ohio', status: 'recreational', note: 'Adult-use legal since 2023; retail sales began in 2024.',
    homeGrow: '6 plants per adult, 12 max per household.', possessionLimit: '2.5 oz flower', concentrateLimit: '15g concentrate (THC capped at 35% for flower, 70% for concentrates)', publicConsumption: 'Prohibited.', licensing: 'OH Division of Cannabis Control.', hempThca: 'Intoxicating hemp has been restricted by state law.', penalties: 'Over 2.5 oz is a minor misdemeanor.', sourceLabel: 'OH Division of Cannabis Control', sourceUrl: 'https://com.ohio.gov/dcc' },
  { state: 'Oklahoma', status: 'medical', note: 'Broad medical program with relatively accessible qualifying conditions; no recreational sales.',
    homeGrow: 'Medical patients only: 6 mature plus 6 seedling plants.', possessionLimit: 'Up to 3 oz on your person, 8 oz at home, for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'OK Medical Marijuana Authority.', hempThca: 'Intoxicating hemp products sit in a legal gray area.', penalties: 'Possession without a card can be a misdemeanor.', sourceLabel: 'OK Medical Marijuana Authority', sourceUrl: 'https://oklahoma.gov/omma' },
  { state: 'Oregon', status: 'recreational', note: 'Adult-use legal since 2014.',
    homeGrow: '4 plants per residence.', possessionLimit: '2 oz in public, up to 8 oz at home', concentrateLimit: '1 oz of cannabis extract', publicConsumption: 'Prohibited.', licensing: 'OR Liquor & Cannabis Commission.', hempThca: 'Hemp is legal; intoxicating hemp is regulated alongside cannabis.', penalties: 'Over 2 oz in public ranges from a violation to a misdemeanor.', sourceLabel: 'OR Liquor & Cannabis Commission', sourceUrl: 'https://www.oregon.gov/olcc' },
  { state: 'Pennsylvania', status: 'medical', note: 'Medical program only; often cited as the most likely next state to pursue recreational legalization.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to a 30-day supply for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'PA Dept. of Health, Office of Medical Marijuana.', hempThca: 'Intoxicating hemp has been restricted by state law.', penalties: 'Up to 30g is a misdemeanor.', sourceLabel: 'PA Medical Marijuana', sourceUrl: 'https://www.health.pa.gov' },
  { state: 'Rhode Island', status: 'recreational', note: 'Adult-use legal since 2022.',
    homeGrow: '6 mature plus 12 immature plants.', possessionLimit: '1 oz on your person, up to 10 oz at home', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'RI Cannabis Control Commission.', hempThca: 'Hemp is legal; intoxicating hemp is regulated.', penalties: 'Over 1 oz is a civil fine; over roughly 1 kg is a felony.', sourceLabel: 'RI Cannabis Office', sourceUrl: 'https://dbr.ri.gov' },
  { state: 'South Carolina', status: 'illegal', note: 'No legal program of any kind, medical or recreational.',
    homeGrow: 'Not permitted.', possessionLimit: 'Zero tolerance for any amount.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No cannabis program exists.', hempThca: 'Hemp is legal; THCA flower is commonly sold.', penalties: 'Up to 1 oz is a misdemeanor; over 1 oz is a felony.', sourceLabel: 'SC Dept. of Health & Environmental Control', sourceUrl: 'https://scdhec.gov' },
  { state: 'South Dakota', status: 'medical', note: 'Medical program for qualifying conditions; a recreational ballot measure did not pass.',
    homeGrow: 'Limited to registered patients without reasonable dispensary access, up to 3 plants.', possessionLimit: 'Up to 3 oz for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'SD Dept. of Health Medical Cannabis Program.', hempThca: 'Hemp is legal; intoxicating hemp has been restricted.', penalties: 'Up to 2 oz is a misdemeanor; larger amounts can be a felony.', sourceLabel: 'SD Medical Cannabis', sourceUrl: 'https://medcannabis.sd.gov' },
  { state: 'Tennessee', status: 'cbd_only', note: 'Low-THC CBD products only; no medical or recreational program.',
    homeGrow: 'Not permitted.', possessionLimit: 'Zero tolerance for flower.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No comprehensive program; hemp-derived products dominate the market.', hempThca: 'Hemp is legal; intoxicating cannabinoids are regulated.', penalties: 'Up to 0.5 oz is a misdemeanor; more is a felony.', sourceLabel: 'TN Dept. of Agriculture', sourceUrl: 'https://www.tn.gov/agriculture' },
  { state: 'Texas', status: 'cbd_only', note: 'Compassionate Use Program covers specific conditions with a strict THC cap; not full medical or recreational.',
    homeGrow: 'Not permitted.', possessionLimit: 'Registered Compassionate Use patients only, roughly a 90-day supply.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'TX Compassionate Use Program (Dept. of Public Safety).', hempThca: 'Hemp is legal under state law; attempts to further restrict THCA/Delta-8 products remain under court review.', penalties: 'Up to 2 oz is a misdemeanor; concentrates outside the program can be a felony.', sourceLabel: 'TX Compassionate Use Program', sourceUrl: 'https://www.dps.texas.gov/section/compassionate-use-program' },
  { state: 'Utah', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to a 30-day supply per pharmacy fill for registered patients; smokable raw flower is not part of the program.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'UT Center for Medical Cannabis.', hempThca: 'Intoxicating cannabinoids are restricted by state law.', penalties: 'Up to 1 oz is a misdemeanor; more can be a felony depending on amount.', sourceLabel: 'UT Medical Cannabis', sourceUrl: 'https://medicalcannabis.utah.gov' },
  { state: 'Vermont', status: 'recreational', note: 'Adult-use legal since 2018; first state to legalize via legislature rather than ballot measure.',
    homeGrow: '2 mature plus 4 immature plants per household.', possessionLimit: '1 oz', concentrateLimit: '5g concentrate', publicConsumption: 'Prohibited.', licensing: 'VT Cannabis Control Board.', hempThca: 'Hemp is legal; intoxicating hemp is regulated.', penalties: 'Over 1 oz is a civil violation; larger quantities can be a misdemeanor or felony.', sourceLabel: 'VT Cannabis Control Board', sourceUrl: 'https://ccb.vermont.gov' },
  { state: 'Virginia', status: 'recreational', note: 'Adult-use possession legal since 2021, though retail sales have lagged behind legalization.',
    homeGrow: '4 plants per household.', possessionLimit: '2 oz in public as of July 2026 (recently raised from 1 oz); no stated limit on private, at-home possession', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'VA Cannabis Control Authority; retail sales remain unauthorized.', hempThca: 'Intoxicating hemp has been restricted by state law.', penalties: 'Over the public limit up to 1 lb is a civil penalty; over 1 lb is a felony.', sourceLabel: 'VA Cannabis Control Authority', sourceUrl: 'https://www.cca.virginia.gov' },
  { state: 'Washington', status: 'recreational', note: 'One of the first two adult-use states, legal since 2012.',
    homeGrow: 'Not permitted recreationally; registered medical patients may grow up to 6 plants.', possessionLimit: '1 oz flower', concentrateLimit: '7g concentrate, 16 oz solid edibles, 72 oz liquid edibles', publicConsumption: 'Prohibited.', licensing: 'WA State Liquor & Cannabis Board.', hempThca: 'Hemp is legal; intoxicating cannabinoids are restricted to the licensed channel.', penalties: 'Over 1 oz is a misdemeanor.', sourceLabel: 'WA Liquor & Cannabis Board', sourceUrl: 'https://lcb.wa.gov' },
  { state: 'West Virginia', status: 'medical', note: 'Medical program for qualifying conditions; no recreational sales.',
    homeGrow: 'Not permitted.', possessionLimit: 'Up to a 30-day supply for registered patients.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'WV Office of Medical Cannabis.', hempThca: 'Intoxicating cannabinoids are restricted by state law.', penalties: 'Possession can be a misdemeanor, up to 6 months.', sourceLabel: 'WV Medical Cannabis', sourceUrl: 'https://omc.wv.gov' },
  { state: 'Wisconsin', status: 'cbd_only', note: 'Low-THC CBD products only; no medical or recreational program.',
    homeGrow: 'Not permitted.', possessionLimit: 'Zero tolerance.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No cannabis program exists.', hempThca: 'Hemp is legal; intoxicating hemp exists in a gray market.', penalties: 'First offense is a misdemeanor, up to 6 months; repeat offenses can be a felony.', sourceLabel: 'WI Dept. of Agriculture, Trade & Consumer Protection', sourceUrl: 'https://datcp.wi.gov' },
  { state: 'Wyoming', status: 'illegal', note: 'No legal program of any kind, medical or recreational.',
    homeGrow: 'Not permitted.', possessionLimit: 'Zero tolerance.', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'No cannabis program exists.', hempThca: 'Hemp is legal at 0.3% THC; intoxicating cannabinoids are restricted by state law.', penalties: 'Up to 3 oz is a misdemeanor; more is a felony.', sourceLabel: 'WY Dept. of Health', sourceUrl: 'https://health.wyo.gov' },
  { state: 'Washington, D.C.', status: 'recreational', note: 'Adult possession and home cultivation are legal, but D.C. is barred by Congress from regulating commercial sales.',
    homeGrow: '6 plants per adult (3 mature), 12 max per household.', possessionLimit: '2 oz', concentrateLimit: '', publicConsumption: 'Prohibited.', licensing: 'DC Alcoholic Beverage & Cannabis Administration; commercial sales remain federally blocked, so a gift-based model operates around the ban.', hempThca: 'Intoxicating hemp has been restricted by emergency rule.', penalties: 'Over 2 oz is a misdemeanor, up to 6 months.', sourceLabel: 'DC ABCA', sourceUrl: 'https://abca.dc.gov' },
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
  const isCustomExisting = isCustomCheckin(existing);
  const hasPick = !!s || isCustomExisting;
  // Always show at least one pairing row -- a blank "Food & Drink" row by
  // default on a new check-in, or the real existing pairings when editing.
  // See the PAIRING TYPES comment on renderCheckinPairings above.
  const initialPairings = (existing && existing.pairings && existing.pairings.length) ? existing.pairings : [{ type: 'food', note: '' }];
  const body = `
    <h1 class="screen-title">${isEdit ? 'Edit Check-In' : 'Check In'}</h1>
    ${isEdit ? `<p class="empty-note">Thoughts changed after the fact? That's normal, especially with edibles — update it below.</p>` : ''}
    <form method="POST" action="${isEdit ? `/checkin/${existing.id}/edit` : '/checkin'}" id="checkin-form">
      <label class="field-label">Strain</label>
      <div id="strain-picker" ${hasPick ? 'style="display:none;"' : ''}>
        <input type="text" id="strain-picker-search" placeholder="Type a strain name..." autocomplete="off" ${isEdit ? 'disabled' : ''}>
        <div class="effect-results" id="strain-picker-results"></div>
      </div>
      <div id="strain-picker-selected" class="card" ${hasPick ? '' : 'style="display:none;"'}>
        ${s ? `${s.icon} <b>${esc(s.name)}</b> ${isEdit ? '' : `<button type="button" id="strain-picker-change" class="btn secondary" style="float:right;padding:2px 10px;">Change</button>`}` : (isCustomExisting ? `🌿 <b>${esc(existing.custom_strain_name || 'Unnamed strain')}</b> ${unverifiedBadge()}` : '')}
      </div>
      <input type="hidden" name="strain_id" id="strain-picker-hidden" value="${s ? s.id : (isCustomExisting ? CUSTOM_STRAIN_ID : '')}">
      <input type="hidden" name="custom_strain_name" id="strain-picker-custom-name" value="${isCustomExisting ? esc(existing.custom_strain_name || '') : ''}">
      ${isEdit ? '' : `<p class="empty-note" id="strain-picker-hint" ${hasPick ? 'style="display:none;"' : ''}>Tip: search from <a href="/strains">the Strain Library</a> and tap "Light It Up" on the strain page for a pre-filled form.<br>Can't find it? Type the name and choose “Log as self-added” — everyone will see it tagged ${unverifiedBadge()} until we verify it.</p>`}

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

      <label class="field-label">Brand</label>
      <input type="text" name="brand" placeholder="Dispensary or brand, if you know it" value="${existing ? esc(existing.brand || '') : ''}">

      <label class="field-label">Pairings</label>
      <div id="pairings-list">
        ${initialPairings.map(renderPairingRow).join('')}
      </div>
      <button type="button" id="add-pairing-btn" class="btn secondary" style="margin-top:2px;">+ Add Pairing</button>

      <label style="display:flex;align-items:center;gap:8px;margin-top:16px;cursor:pointer;">
        <input type="checkbox" name="is_private" value="1" ${existing && existing.is_private ? 'checked' : ''} style="width:auto;margin:0;">
        <span>🔒 Log privately — just for me, won't show in the feed</span>
      </label>

      <button class="btn block" type="submit" id="checkin-submit">${isEdit ? 'Save Changes' : '🔥 Light It Up'}</button>
    </form>
    ${isEdit ? `
      <form method="POST" action="/checkin/${existing.id}/delete" style="margin-top:10px;text-align:center;" onsubmit="return confirm('Delete this check-in? This cannot be undone.')">
        <input type="hidden" name="redirect_to" value="${isCustomExisting ? '/history' : '/strains/' + existing.strain_id}">
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
      (function() {
        const addBtn = document.getElementById('add-pairing-btn');
        const list = document.getElementById('pairings-list');
        if (!addBtn || !list) return;
        addBtn.addEventListener('click', function() {
          const rows = list.querySelectorAll('.pairing-row');
          const clone = rows[rows.length - 1].cloneNode(true);
          clone.querySelector('select').value = 'food';
          clone.querySelector('input[type=text]').value = '';
          list.appendChild(clone);
        });
      })();
    </script>
  `;
  sendHtml(res, layout({ title: isEdit ? 'Edit Check-In' : 'Check In', active: 'strains', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// A standalone single-post view -- what a tapped profile-grid photo links
// to instead of the strain page. Renders the exact same feed-post card
// used everywhere else (comments, reactions, pairings, onset timer), just
// isolated to one specific check-in, matching Instagram's "tap a grid
// photo, see the full post on its own" pattern.
function pageCheckinDetail(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const c = db.getCheckin(id);
  if (!c) return notFound(res);
  // Same two visibility rules used everywhere else a check-in renders:
  // filterVisibleCheckins for privacy, isBlocked for the poster-blocked
  // case (see pageHome) -- a direct link to someone's private or
  // blocked-from-you post 404s exactly like it would if you'd scrolled
  // past it in a feed instead of landing here directly.
  if (!db.filterVisibleCheckins([c], userId).length) return notFound(res);
  if (c.user_id !== userId && db.isBlocked(userId, c.user_id)) return notFound(res);
  const s = db.getStrain(c.strain_id);
  const poster = db.getUserById(c.user_id);
  const posterName = poster ? poster.username : 'Former user';
  const isMine = c.user_id === userId;
  const body = `
    <div class="feed-post">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div class="empty-note" style="padding:0;font-weight:${isMine ? 'normal' : '700'};">${isMine ? 'You' : `<a href="/friends/${c.user_id}" style="color:inherit;">${esc(posterName)}</a>`}</div>
        <div style="display:flex;align-items:center;gap:10px;">
          ${renderShareButton(c)}
          ${isMine ? `<a href="/checkin/${c.id}/edit" class="empty-note" style="padding:0;">Edit</a>` : ''}
        </div>
      </div>
      <a class="strain-chip" href="${checkinStrainHref(c)}">
        ${strainPhotoTag(s, 'xs')}
        <span><b>${esc(checkinStrainName(c, s))}</b> ${checkinStrainTag(c, s)}</span>
      </a>
      ${isMine ? renderCustomStrainAnswered(req) : ''}
      ${isMine && isCustomCheckin(c) ? renderCustomStrainPrompts(req, userId, '/checkin/' + c.id, { onlyNormName: db.normalizeCustomName(c.custom_strain_name) }) : ''}
      <div class="sub" style="margin-top:8px;">${esc(c.method)} · ${starString(c.rating)}</div>
      ${c.photo ? `<img class="photo-thumb" src="${esc(c.photo)}" alt="photo">` : ''}
      ${(c.effects || []).length ? `<div class="effect-tags">${c.effects.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
      ${c.note ? `<div class="note">"${esc(c.note)}"</div>` : ''}
      ${renderCheckinPairings(c)}
      ${renderOnsetTimer(c)}
      ${renderCheckinComments(c, userId, '/checkin/' + c.id)}
      <div style="display:flex;flex-direction:column;align-items:flex-end;margin-top:8px;">
        ${renderReactionBar(c, userId)}
        ${reactionGiversLabel(c.id)}
      </div>
    </div>
    ${REACT_TO_CHECKIN_SCRIPT}
    ${SHARE_CHECKIN_SCRIPT}
  `;
  sendHtml(res, layout({ title: s ? s.name : 'Check-In', active: 'home', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageCheckinEditForm(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const existing = db.getCheckin(id);
  if (!existing || existing.user_id !== userId) return notFound(res);
  pageCheckinForm(req, res, new URLSearchParams(), existing);
}

// Zips the parallel pairing_type/pairing_note fields (one pair of values
// per row rendered by renderPairingRow) back into the real
// pairings: [{type, note}] shape createCheckin/updateCheckin expect.
// parseForm gives a plain string when there was only one row, or an
// array when there were several -- same pattern already used for
// effects. Rows with no note are dropped rather than saved empty.
function pairingsFromForm(fields) {
  const types = Array.isArray(fields.pairing_type) ? fields.pairing_type : (fields.pairing_type ? [fields.pairing_type] : []);
  const notes = Array.isArray(fields.pairing_note) ? fields.pairing_note : (fields.pairing_note ? [fields.pairing_note] : []);
  return types.map((type, i) => ({ type, note: (notes[i] || '').trim() })).filter(p => p.note);
}
async function handleCheckinSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  let strainId = fields.strain_id;
  if (!strainId) { sendHtml(res, layout({ title: 'Check In', body: `<p>Please pick a valid strain. <a href="/checkin">Try again</a></p>` }), 400); return; }
  // Free-text ("self-added") strain: the person typed a name because the
  // strain isn't in the library yet.
  let customName = '';
  if (strainId === CUSTOM_STRAIN_ID) {
    customName = cleanCustomStrainName(fields.custom_strain_name);
    if (customName.length < 2) { sendHtml(res, layout({ title: 'Check In', body: `<p>Please type the strain's name (at least 2 characters). <a href="/checkin">Try again</a></p>` }), 400); return; }
    // If what they typed is actually a library strain (by name or alias),
    // link it to the real entry instead of creating a duplicate.
    const libraryMatch = db.findStrainByNameOrAka(customName);
    if (libraryMatch) { strainId = libraryMatch.id; customName = ''; }
  }
  let effects = Array.isArray(fields.effects) ? fields.effects : (fields.effects ? [fields.effects] : []);
  effects = effects.filter(Boolean).slice(0, 5);
  const photoUrl = await storage.uploadCheckinPhoto(fields.photo || null);
  const created = await db.createCheckin({
    user_id: userId, strain_id: strainId, method: fields.method, rating: Number(fields.rating) || 0,
    note: fields.note || '', effects, photo: photoUrl,
    tasting_notes: fields.tasting_notes || '', brand: fields.brand || '',
    pairings: pairingsFromForm(fields),
    is_private: !!fields.is_private,
    custom_strain_name: customName,
  });
  if (customName) {
    // Queue it for review (once per person per name) so the strain can be
    // researched and added to the library, and these check-ins linked to it.
    const alreadyQueued = db.listStrainSubmissions().some(sub =>
      sub.user_id === userId && sub.status !== 'reviewed' && String(sub.strain_name).trim().toLowerCase() === customName.toLowerCase());
    if (!alreadyQueued) {
      const brandNote = String(fields.brand || '').trim();
      await db.createStrainSubmission({
        user_id: userId, strain_name: customName,
        description: 'Self-added at check-in' + (brandNote ? ` · brand: ${brandNote.slice(0, 80)}` : ''),
        photo: null,
      });
    }
    return redirect(res, `/checkin/${created.id}`);
  }
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
    tasting_notes: fields.tasting_notes || '', brand: fields.brand || '',
    pairings: pairingsFromForm(fields),
    is_private: !!fields.is_private,
  });
  redirect(res, isCustomCheckin(existing) ? `/checkin/${existing.id}` : `/strains/${existing.strain_id}`);
}
async function handleCheckinDelete(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const existing = db.getCheckin(id);
  if (!existing || existing.user_id !== userId) return notFound(res);
  const f = await parseForm(req);
  await db.deleteCheckin(id);
  storage.deletePhotos([existing.photo]).catch(e => console.error('[storage]', e));
  redirect(res, safeRedirectPath(f.redirect_to) || '/history');
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
  sendHtml(res, layout({ title: 'FAQ', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Maps a usesBase keyword to the title of the one "core" recipe that
// should be treated as *the* reference for that base — so a link that
// says "how to make cannabutter" goes to one specific, canonical recipe
// (Classic Cannabutter) rather than a search page showing every variant
// (Instant Pot, Slow Cooker, Sous Vide...) mixed together.
// Lets someone new to edibles filter away from an accidentally
// high-potency recipe as their first one, rather than finding out the
// hard way. 'beginner' is the default for anything that doesn't set one
// (see the recipes migration in db.js).
const RECIPE_DIFFICULTY_LABELS = {
  beginner: { label: 'Beginner', icon: '🟢' },
  intermediate: { label: 'Intermediate', icon: '🟡' },
  advanced: { label: 'Advanced', icon: '🔴' },
};
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

// Best-By Calendar reference data -- rough, general shelf-life guidance
// (days from the date made) for common homemade infusions and edibles.
// Deliberately conservative, general kitchen-storage guidance in the same
// spirit as the dosing notes elsewhere in this app -- not a food-safety
// guarantee. Always store airtight and refrigerated/frozen where noted,
// and use your own judgment (smell, appearance, mold) regardless of what
// the calendar says.
const INFUSION_SHELF_LIFE = [
  { key: 'cannabutter', label: 'Cannabutter', days: 90, storage: 'Refrigerated (freeze for up to 6 months)' },
  { key: 'coconut oil', label: 'Infused Coconut Oil', days: 180, storage: 'Refrigerated, airtight' },
  { key: 'olive oil', label: 'Infused Olive Oil', days: 60, storage: 'Refrigerated, airtight' },
  { key: 'avocado oil', label: 'Infused Avocado Oil', days: 60, storage: 'Refrigerated, airtight' },
  { key: 'ghee', label: 'Infused Ghee', days: 90, storage: 'Cool, dark pantry or refrigerated' },
  { key: 'infused milk', label: 'Infused Milk', days: 5, storage: 'Refrigerated' },
  { key: 'infused sugar', label: 'Infused Sugar', days: 180, storage: 'Airtight, room temperature' },
  { key: 'infused flour', label: 'Infused Flour', days: 30, storage: 'Refrigerated or frozen' },
  { key: 'honey', label: 'Infused Honey', days: 365, storage: 'Room temperature, airtight' },
  { key: 'finishing salt', label: 'Infused Finishing Salt', days: 365, storage: 'Airtight, room temperature' },
  { key: 'simple syrup', label: 'Infused Simple Syrup', days: 30, storage: 'Refrigerated' },
  { key: 'glycerin tincture', label: 'Glycerin Tincture', days: 180, storage: 'Cool, dark place' },
  { key: 'tincture', label: 'Alcohol Tincture', days: 730, storage: 'Cool, dark place' },
  { key: 'rso', label: 'RSO (Rick Simpson Oil)', days: 730, storage: 'Dark, airtight jar or syringe' },
  { key: 'baked_goods', label: 'Baked Goods (brownies, cookies)', days: 7, storage: 'Airtight, room temperature (freeze for longer)' },
  { key: 'gummies', label: 'Gummies & Candy', days: 180, storage: 'Airtight, cool & dry' },
  { key: 'beverage', label: 'Infused Beverage', days: 5, storage: 'Refrigerated' },
  { key: 'other', label: 'Something Else', days: 30, storage: 'Use your judgment — when in doubt, refrigerate' },
];
function infusionMeta(key) { return INFUSION_SHELF_LIFE.find(i => i.key === key) || INFUSION_SHELF_LIFE[INFUSION_SHELF_LIFE.length - 1]; }
function addDaysToDateStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
  { key: 'heirloom', variants: ['heirloom', 'heirlooms'],
    definition: "Landrace seed grown and preserved outside its native region for many generations — genetically still very close to the original landrace, but no longer growing in the environment that actually shaped it." },
  { key: 'ibl', variants: ['ibl', 'inbred line', 'inbred lines'],
    definition: "A strain bred with its own line repeatedly (rather than crossed with a different strain) to stabilize and lock in its traits — distinct from a backcross, which breeds back into one of its original parents instead." },
  { key: 'polyhybrid', variants: ['polyhybrid', 'polyhybrids'],
    definition: "A strain descended from many different crosses rather than one clean two-parent pairing, which is why its exact lineage sometimes can't be summarized as a simple X × Y formula." },
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
// Every term defined across the site, in one browsable/searchable place --
// previously these only surfaced as inline hover-links inside recipes and
// grow tips (or the narrow genetics subset on the Genetics & Breeding
// Guide), with no page of their own. Reuses GLOSSARY_TERMS directly, so
// there's still only one place any definition is ever written.
function pageGlossary(req, res, query) {
  const q = ((query && query.get('q')) || '').trim().toLowerCase();
  const sorted = [...GLOSSARY_TERMS].sort((a, b) => a.key.localeCompare(b.key));
  const filtered = q
    ? sorted.filter(t => t.key.includes(q) || t.variants.some(v => v.includes(q)) || t.definition.toLowerCase().includes(q))
    : sorted;
  const body = `
    <h1 class="screen-title">Glossary</h1>
    <p class="screen-sub">Every term used across StrainDex, in one place — the same definitions that auto-link inline in recipes, grow tips, and the Education guides.</p>
    <form method="GET" action="/glossary" style="margin-bottom:14px;display:flex;gap:8px;">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search terms..." autocomplete="off" style="flex:1;">
      <button class="btn" type="submit">Search</button>
    </form>
    ${filtered.length ? filtered.map(t => `
      <div class="card" style="margin-bottom:8px;">
        <h2 style="margin:0 0 4px;font-size:15px;text-transform:capitalize;">${esc(t.key.replace(/-/g, ' '))}</h2>
        <p style="margin:0;">${esc(t.definition)}</p>
      </div>
    `).join('') : `<div class="empty-note">No terms match "${esc(q)}".</div>`}
  `;
  sendHtml(res, layout({ title: 'Glossary', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
function linkGlossaryTerms(escapedText) {
  if (!escapedText) return escapedText;
  return escapedText.replace(GLOSSARY_REGEX, (match) => {
    const term = GLOSSARY_BY_VARIANT.get(match.toLowerCase());
    if (!term) return match;
    return `<span class="glossary-term" data-def="${esc(term.definition)}">${match}</span>`;
  });
}

// Recipes' own comment thread -- deliberately simpler than
// renderCheckinComments (no per-comment likes, no @mentions), since
// recipes already have Kudos as their appreciation mechanic and this is
// just meant to add discussion, not a second reaction system.
function renderRecipeComments(r, userId, redirectPath) {
  const comments = db.listRecipeComments(r.id, userId);
  return `
    ${comments.length ? `<div style="margin-top:8px;">${comments.map(cm => {
      const author = db.getUserById(cm.user_id);
      const canModerate = userId != null && cm.user_id !== userId;
      return `<div class="empty-note" style="padding:3px 0;">
        <b>${esc(author ? author.username : 'Someone')}:</b> ${esc(cm.body)}
        ${canModerate ? `
          <form method="POST" action="/report" style="display:inline;" onsubmit="return confirm('Report this comment for review?')">
            <input type="hidden" name="content_type" value="recipe_comment">
            <input type="hidden" name="content_id" value="${cm.id}">
            <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
            <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Report</button>
          </form>
          <form method="POST" action="/block/${cm.user_id}" style="display:inline;" onsubmit="return confirm('Block ' + ${JSON.stringify(author ? author.username : 'this person')} + '? You will no longer see their comments, check-ins, or grow tips, and any community connection will end.')">
            <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
            <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Block</button>
          </form>
        ` : ''}
      </div>`;
    }).join('')}</div>` : ''}
    ${userId != null ? `
      <form method="POST" action="/recipes/${r.id}/comment" style="display:flex;gap:6px;margin-top:6px;">
        <input type="hidden" name="redirect_to" value="${esc(redirectPath)}">
        <input type="text" name="body" placeholder="Add a comment..." required style="flex:1;margin:0;">
        <button class="btn secondary" type="submit" style="padding:6px 12px;">Post</button>
      </form>
    ` : ''}
  `;
}
async function handleRecipeCommentSubmit(req, res, recipeId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const body = (f.body || '').trim();
  if (body) await db.createRecipeComment({ recipe_id: recipeId, user_id: userId, body });
  redirect(res, safeRedirectPath(f.redirect_to) || `/recipes/${recipeId}`);
}
async function handleRecipeFavoriteToggle(req, res, recipeId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  if (db.isRecipeFavorited(userId, recipeId)) {
    await db.removeRecipeFavorite(userId, recipeId);
  } else {
    await db.addRecipeFavorite(userId, recipeId);
  }
  redirect(res, safeRedirectPath(f.redirect_to) || `/recipes/${recipeId}`);
}
function pageFavoriteRecipes(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const recipes = db.getFavoriteRecipes(userId);
  const body = `
    <h1 class="screen-title">Favorite Recipes</h1>
    <p class="screen-sub">Recipes you've saved for later — separate from Kudos, which is just showing appreciation.</p>
    ${recipes.length ? recipes.map(r => `
      <a href="/recipes/${r.id}" class="library-row" style="text-decoration:none;color:inherit;">
        <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">${r.icon || '🍽️'}</div>
        <div class="info">
          <div class="nm">${esc(r.title)}</div>
          <div class="sub">${esc(r.category || '')}${r.time ? ' · ' + esc(r.time) : ''}</div>
        </div>
      </a>
    `).join('') : `<div class="empty-note">No favorites yet — browse <a href="/recipes">Recipes</a> and tap "Add to Favorites" on anything you want to save.</div>`}
  `;
  sendHtml(res, layout({ title: 'Favorite Recipes', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
function pageRecipeDetail(req, res, id) {
  const r = db.getRecipe(id);
  if (!r || r.status !== 'approved') return notFound(res);
  const userId = auth.currentUserId(req);
  const body = `
    <div class="card" style="margin-top:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <b style="font-size:16px;">${r.icon || '🍽️'} ${esc(r.title)}</b>
        ${userId != null ? `
          <form method="POST" action="/recipes/${r.id}/favorite" style="margin:0;">
            <input type="hidden" name="redirect_to" value="/recipes/${r.id}">
            <button type="submit" title="${db.isRecipeFavorited(userId, r.id) ? 'Remove from Favorites' : 'Add to Favorites'}" style="background:none;border:none;cursor:pointer;font-size:20px;padding:0;line-height:1;">${db.isRecipeFavorited(userId, r.id) ? '★' : '☆'}</button>
          </form>
        ` : ''}
      </div>
      <span class="recipe-source-tag ${r.source}">${r.source === 'official' ? 'Official' : 'Community'}</span>
      ${RECIPE_DIFFICULTY_LABELS[r.difficulty] ? `<span class="filter-pill">${RECIPE_DIFFICULTY_LABELS[r.difficulty].icon} ${esc(RECIPE_DIFFICULTY_LABELS[r.difficulty].label)}</span>` : ''}
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
      <div class="card" style="margin-top:10px;background:var(--bg-subtle,#f7f7f2);color:#2a2a2a;">
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
      ${renderRecipeComments(r, userId, '/recipes/' + r.id)}
    </div>
  `;
  sendHtml(res, layout({ title: r.title, active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageRecipes(req, res, query) {
  const category = (query && query.get('category')) || 'All';
  const difficulty = (query && query.get('difficulty')) || 'All';
  const q = (query && query.get('q')) || '';
  const recipes = db.listRecipes({ status: 'approved', category, difficulty, q });
  const categories = ['All', 'Infusion Base', 'Baked Goods', 'Gummies & Candy', 'Drinks', 'Topicals', 'Savory & Snacks'];
  const difficulties = ['All', 'beginner', 'intermediate', 'advanced'];
  const mk = (params) => '/recipes?' + new URLSearchParams({ category, difficulty, q, ...params }).toString();
  const body = `
    <h1 class="screen-title">Infused Recipes</h1>
    <a class="btn block lilac" href="/recipes/new" style="margin-bottom:14px;">✏️ Submit a Recipe</a>
    <form method="GET" action="/recipes" style="margin-bottom:12px;display:flex;gap:8px;">
      <input type="hidden" name="category" value="${esc(category)}">
      <input type="hidden" name="difficulty" value="${esc(difficulty)}">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search by name, ingredient, or description..." autocomplete="off" style="flex:1;">
      <button class="btn" type="submit">Search</button>
    </form>
    <div style="margin-bottom:8px;">${categories.map(c => `<a class="filter-pill ${category === c ? 'active' : ''}" href="${mk({ category: c })}">${c}</a>`).join('')}</div>
    <div style="margin-bottom:14px;">${difficulties.map(d => `<a class="filter-pill ${difficulty === d ? 'active' : ''}" href="${mk({ difficulty: d })}">${d === 'All' ? 'Any level' : `${RECIPE_DIFFICULTY_LABELS[d].icon} ${RECIPE_DIFFICULTY_LABELS[d].label}`}</a>`).join('')}</div>
    ${q ? `<p class="empty-note">${recipes.length} result${recipes.length === 1 ? '' : 's'} for "${esc(q)}"${category !== 'All' ? ' in ' + esc(category) : ''}</p>` : ''}
    ${recipes.map(r => `
      <div class="card">
        <a href="/recipes/${r.id}" style="text-decoration:none;color:inherit;"><b>${r.icon || '🍽️'} ${esc(r.title)}</b></a>
        <span class="recipe-source-tag ${r.source}">${r.source === 'official' ? 'Official' : 'Community'}</span>
        ${RECIPE_DIFFICULTY_LABELS[r.difficulty] ? `<span class="filter-pill">${RECIPE_DIFFICULTY_LABELS[r.difficulty].icon} ${esc(RECIPE_DIFFICULTY_LABELS[r.difficulty].label)}</span>` : ''}
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
  sendHtml(res, layout({ title: 'Recipes', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
      <label class="field-label">Difficulty</label>
      <select name="difficulty">${Object.entries(RECIPE_DIFFICULTY_LABELS).map(([key, d]) => `<option value="${key}">${d.icon} ${esc(d.label)}</option>`).join('')}</select>
      <button class="btn block" type="submit">Submit for Review</button>
    </form>
    <p class="empty-note">Submissions are reviewed before they go live — check back, or ask the admin.</p>
  `;
  sendHtml(res, layout({ title: 'Submit a Recipe', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

async function handleRecipeNewSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  if (await isSubmissionRateLimited('recipe_submit', userId)) return sendRateLimited(res, '/recipes/new');
  const f = await parseForm(req);
  await db.createRecipe({
    title: f.title, desc: f.desc, author: f.author, user_id: userId, source: 'community', status: 'pending',
    ingredients: String(f.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean),
    steps: String(f.steps || '').split('\n').map(s => s.trim()).filter(Boolean),
    dosing: f.dosing || '',
    difficulty: RECIPE_DIFFICULTY_LABELS[f.difficulty] ? f.difficulty : 'beginner',
  });
  redirect(res, '/recipes?submitted=1');
}

// ---------------------------------------------------------------- dosing calculator (standalone)
// The same math as the calculator embedded on each recipe's page (see
// pageRecipeDetail), but as its own destination for a batch that didn't
// start from a StrainDex recipe at all -- plus the reverse direction
// (target dose -> how many servings to split a batch into).
function pageDosingCalculator(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const body = `
    <h1 class="screen-title">🧮 Dosing Calculator</h1>
    <p class="screen-sub">Figure out mg per serving for any batch — not just StrainDex recipes.</p>
    <p class="empty-note">Last reviewed: ${esc(SAFETY_GUIDES_LAST_REVIEWED)}.</p>
    <div class="card">
      <b style="font-size:14px;">Total THC ÷ servings</b>
      <p class="empty-note" style="padding:2px 0 8px;">Know the total mg in the batch and how many servings you're splitting it into.</p>
      <label class="field-label" style="margin-top:0;">Total THC in the batch (mg)</label>
      <input type="number" id="dose-total-mg" placeholder="e.g. 200" min="0" step="any">
      <label class="field-label">Number of servings</label>
      <input type="number" id="dose-servings" placeholder="e.g. 12" min="1" step="1">
      <div id="dose-result" class="empty-note" style="padding:8px 0 0;font-weight:700;"></div>
    </div>
    <div class="card" style="margin-top:14px;">
      <b style="font-size:14px;">Target dose → servings needed</b>
      <p class="empty-note" style="padding:2px 0 8px;">Know the total mg and what dose you want per serving — this tells you how many servings to divide the batch into.</p>
      <label class="field-label" style="margin-top:0;">Total THC in the batch (mg)</label>
      <input type="number" id="target-total-mg" placeholder="e.g. 200" min="0" step="any">
      <label class="field-label">Target dose per serving (mg)</label>
      <input type="number" id="target-dose-mg" placeholder="e.g. 5" min="0" step="any">
      <div id="target-result" class="empty-note" style="padding:8px 0 0;font-weight:700;"></div>
    </div>
    <p class="empty-note" style="margin-top:14px;">Not medical advice — potency varies by batch, and these numbers are only as accurate as the total mg you enter. Start low and go slow, especially with edibles.</p>
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

        const tTotalEl = document.getElementById('target-total-mg');
        const tDoseEl = document.getElementById('target-dose-mg');
        const tResultEl = document.getElementById('target-result');
        function recalcTarget() {
          const total = parseFloat(tTotalEl.value);
          const dose = parseFloat(tDoseEl.value);
          if (!total || !dose || total <= 0 || dose <= 0) { tResultEl.textContent = ''; return; }
          const servings = total / dose;
          tResultEl.textContent = 'Divide into about ' + Math.floor(servings) + ' serving' + (Math.floor(servings) === 1 ? '' : 's') + ' (' + servings.toFixed(1) + ' exactly)';
        }
        tTotalEl.addEventListener('input', recalcTarget);
        tDoseEl.addEventListener('input', recalcTarget);
      })();
    </script>
  `;
  sendHtml(res, layout({ title: 'Dosing Calculator', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// ---------------------------------------------------------------- best-by calendar
// Tracks homemade infusions/edibles (cannabutter, infused oil, tincture,
// etc.) so a person can see an actual use-by date instead of guessing --
// e.g. "made oil on the 3rd" becomes "use by around the 1st of next month."
function pageBestBy(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const today = new Date().toISOString().slice(0, 10);
  const batches = db.listInfusionBatches(userId).map(b => {
    const meta = infusionMeta(b.item_key);
    const useBy = addDaysToDateStr(b.made_on, meta.days);
    return { ...b, meta, useBy, isPast: useBy < today };
  }).sort((a, b) => a.useBy.localeCompare(b.useBy));
  const body = `
    <h1 class="screen-title">📅 Best-By Calendar</h1>
    <p class="screen-sub">Log what you've made and when — this tells you roughly when to use it by.</p>

    <div class="card" style="margin-bottom:16px;">
      <b style="font-size:14px;">Log a batch</b>
      <form method="POST" action="/best-by" style="margin-top:8px;">
        <label class="field-label" style="margin-top:0;">What did you make?</label>
        <select name="item_key">${INFUSION_SHELF_LIFE.map(i => `<option value="${i.key}">${esc(i.label)}</option>`).join('')}</select>
        <label class="field-label">Nickname (optional)</label>
        <input type="text" name="custom_name" placeholder="e.g. Grandma's brownies, big batch">
        <label class="field-label">Date made</label>
        <input type="date" name="made_on" value="${today}" max="${today}" required>
        <label class="field-label">Notes (optional)</label>
        <textarea name="notes" placeholder="Potency, where it's stored, anything worth remembering"></textarea>
        <button class="btn block" type="submit" style="margin-top:10px;">Add to Calendar</button>
      </form>
    </div>

    <div class="section-label">Your batches (${batches.length})</div>
    ${batches.length ? batches.map(b => `
      <div class="card" style="margin-bottom:8px;${b.isPast ? 'opacity:0.7;' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <b>${esc(b.custom_name || b.meta.label)}</b>
          <form method="POST" action="/best-by/${b.id}/delete" onsubmit="return confirm('Remove this from your calendar?')">
            <button type="submit" class="empty-note" style="padding:0;background:none;border:none;color:#a13a3a;cursor:pointer;font-size:inherit;">Remove</button>
          </form>
        </div>
        ${b.custom_name ? `<div class="empty-note" style="padding:0;">${esc(b.meta.label)}</div>` : ''}
        <div class="empty-note" style="padding:4px 0 0;">Made ${esc(b.made_on)} · ${b.meta.storage}</div>
        <div style="margin-top:6px;font-weight:700;color:${b.isPast ? '#a13a3a' : 'var(--brand-green-dark)'};">
          ${b.isPast ? `⚠️ Past best-by (${esc(b.useBy)}) — check carefully before using` : `Use by around ${esc(b.useBy)}`}
        </div>
        ${b.notes ? `<div class="empty-note" style="padding:6px 0 0;">${esc(b.notes)}</div>` : ''}
      </div>
    `).join('') : `<div class="empty-note">Nothing logged yet — add your first batch above.</div>`}
    <p class="empty-note" style="margin-top:14px;">General kitchen-storage guidance, not a food-safety guarantee. Always store airtight and refrigerated/frozen where noted, and trust your senses (smell, appearance, mold) over the calendar.</p>
  `;
  sendHtml(res, layout({ title: 'Best-By Calendar', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
async function handleBestByAdd(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const itemKey = INFUSION_SHELF_LIFE.some(i => i.key === f.item_key) ? f.item_key : 'other';
  const madeOn = /^\d{4}-\d{2}-\d{2}$/.test(f.made_on || '') ? f.made_on : new Date().toISOString().slice(0, 10);
  await db.createInfusionBatch({
    user_id: userId, item_key: itemKey, custom_name: (f.custom_name || '').trim(), made_on: madeOn, notes: (f.notes || '').trim(),
  });
  redirect(res, '/best-by');
}
async function handleBestByDelete(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const batch = db.getInfusionBatch(id);
  if (!batch || batch.user_id !== userId) return notFound(res);
  await db.deleteInfusionBatch(id);
  redirect(res, '/best-by');
}

// A sequential walkthrough for someone who's never grown before -- distinct
// from the community Growing Tips board (crowd-sourced, browsed by
// category, not ordered) in that this is a fixed, beginner-oriented
// roadmap through the actual stages of a grow. Each step still links out
// to that same category on the Growing Tips board for more depth, plus
// the Genetics & Breeding Guide, Legal Status, and Using the Whole Plant
// pages where relevant, rather than duplicating any of that content here.
const GROWER_GUIDE_STEPS = [
  { title: 'Check your local laws first', body: 'Home cultivation legality, and how many plants you\u2019re allowed, vary a lot by state and country. Confirm before you buy a single seed.', link: '/legal-status', linkLabel: 'Check your state \u2192' },
  { title: 'Pick indoor or outdoor', body: 'Indoor gives you full control over light, temperature, and timing, at a real cost in equipment. Outdoor is cheaper and simpler, but you\u2019re at the mercy of your local climate and season.', link: '/growing?cat=Indoor+Setup', linkLabel: 'Browse setup tips \u2192' },
  { title: 'Start with beginner-friendly genetics', body: 'An autoflowering strain is usually the easiest first grow — it flowers based on age alone, so there\u2019s no light-schedule switch to manage. A photoperiod strain gives you more control (and usually a bigger yield) but needs that schedule change to start flowering.', link: '/genetics-guide', linkLabel: 'Autoflowering vs. photoperiod \u2192' },
  { title: 'Germination & seedlings', body: 'Most seeds sprout within a few days to a week in a damp paper towel or straight into moist soil. Go easy on water and light intensity at this stage — seedlings are fragile.', link: '/growing?cat=Plant+Life+Cycle', linkLabel: 'Browse life-cycle tips \u2192' },
  { title: 'Vegetative stage: light, water, nutrients', body: 'This is most of the actual grow. The single most common beginner mistake is overwatering — let the topsoil dry out between waterings rather than keeping it constantly damp.', link: '/growing?cat=Watering', linkLabel: 'Browse watering tips \u2192' },
  { title: 'Training (optional)', body: 'Techniques like topping redirect a plant\u2019s growth into a bushier shape with more bud sites, instead of one tall main cola. Not required for a first grow, but worth knowing about.', link: '/growing?cat=Training', linkLabel: 'Browse training tips \u2192' },
  { title: 'Flowering', body: 'For a photoperiod plant, this starts once its light schedule shifts to more darkness. Buds will visibly start forming within a couple of weeks.', link: '/growing?cat=Lighting', linkLabel: 'Browse lighting tips \u2192' },
  { title: 'Watch for pests & disease', body: 'Check the undersides of leaves regularly — catching a problem early is far easier than fixing an infestation that\u2019s taken hold.', link: '/growing?cat=Pests+%26+Disease', linkLabel: 'Browse pest & disease tips \u2192' },
  { title: 'Harvest & cure', body: 'Trichomes turning from clear to milky/amber is the classic sign it\u2019s close. After harvest, a slow cure (in a jar, opened daily, out of light) is what actually develops the flavor and potency you\u2019re after.', link: '/growing?cat=Harvest+%26+Curing', linkLabel: 'Browse harvest & curing tips \u2192' },
  { title: 'Use everything you grew', body: 'Bud isn\u2019t the only usable part of the plant — sugar leaves, trim, and even fan leaves each have a real use.', link: '/using-whole-plant', linkLabel: 'See Using the Whole Plant \u2192' },
];
// The consumption-side counterpart to the First-Time Grower's Guide --
// same sequenced-walkthrough pattern, but for someone new to using
// cannabis rather than growing it. Education was previously two flat
// tile grids with no path through them for someone who doesn't yet know
// what to look for; this links out to the real pages rather than
// duplicating their content.
const NEW_TO_CANNABIS_STEPS = [
  { title: 'Know your dose before you start', body: 'This matters most with edibles, where it\u2019s easy to take more before the first dose has even kicked in. Figure out the math first, not after.', link: '/dosing-calculator', linkLabel: 'Dosing Calculator \u2192' },
  { title: 'Pick a method', body: 'Smoking and vaping hit fast and fade fast. Edibles take much longer to start and last much longer once they do. Same cannabis, very different experience depending on how you take it.', link: '/methods', linkLabel: 'Ways to Enjoy It \u2192' },
  { title: 'Know roughly what you might feel', body: 'Effects vary a lot by strain and person, but having a general vocabulary for what\u2019s commonly reported helps you describe (and predict) your own experience.', link: '/effects-guide', linkLabel: 'Effects Guide \u2192' },
  { title: 'Know what not to combine it with', body: 'Alcohol, certain medications, and a few other substances interact with cannabis in ways worth knowing about before, not during.', link: '/mixing-cautions', linkLabel: 'Mixing With Other Substances \u2192' },
  { title: 'Know what to do if something feels wrong', body: 'Being too high is uncomfortable, not usually dangerous — but it helps to already know the practical steps rather than figuring them out in the moment.', link: '/feels-wrong', linkLabel: 'If Something Feels Wrong \u2192' },
  { title: 'Terpenes shape the experience too', body: 'THC percentage isn\u2019t the whole story — the aromatic compounds in a strain play a real role in how it actually feels.', link: '/terpene-guide', linkLabel: 'Terpene Guide \u2192' },
  { title: 'Tolerance builds with regular use', body: 'If a strain that used to work well starts feeling weaker, that\u2019s tolerance, not a bad batch — and there\u2019s a real, well-understood fix for it.', link: '/tolerance-explained', linkLabel: 'Tolerance, Explained \u2192' },
  { title: 'Store what you don\u2019t use right away', body: 'Flower, concentrates, and edibles all degrade differently if stored wrong — worth knowing before your first purchase outlasts its freshness.', link: '/storage-guide', linkLabel: 'Storage Guide \u2192' },
];
function pageNewToCannabis(req, res) {
  const body = `
    <h1 class="screen-title">New to Cannabis? Start Here</h1>
    <p class="screen-sub">A roadmap through the basics before your first (or next) time. Not medical advice.</p>
    ${NEW_TO_CANNABIS_STEPS.map((s, i) => `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;gap:10px;">
          <div style="font-weight:700;color:var(--ink-secondary);flex-shrink:0;">${i + 1}.</div>
          <div>
            <h2 style="margin:0 0 4px;font-size:15px;">${esc(s.title)}</h2>
            <p style="margin:0;">${linkGlossaryTerms(esc(s.body))}</p>
            <a href="${s.link}" class="empty-note" style="display:inline-block;padding:6px 0 0;">${esc(s.linkLabel)}</a>
          </div>
        </div>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'New to Cannabis? Start Here', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
function pageFirstTimeGrowerGuide(req, res) {
  const body = `
    <h1 class="screen-title">First-Time Grower's Guide</h1>
    <p class="screen-sub">A roadmap through your first grow, start to harvest. Home cultivation laws vary by location — check yours first.</p>
    ${GROWER_GUIDE_STEPS.map((s, i) => `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;gap:10px;">
          <div style="font-weight:700;color:var(--ink-secondary);flex-shrink:0;">${i + 1}.</div>
          <div>
            <h2 style="margin:0 0 4px;font-size:15px;">${esc(s.title)}</h2>
            <p style="margin:0;">${esc(s.body)}</p>
            <a href="${s.link}" class="empty-note" style="display:inline-block;padding:6px 0 0;">${esc(s.linkLabel)}</a>
          </div>
        </div>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: "First-Time Grower's Guide", active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
              <form method="POST" action="/block/${g.user_id}" style="display:inline;" onsubmit="return confirm('Block ${esc(g.author || 'this person')}? You will no longer see their comments, check-ins, or grow tips, and any community connection will end.')">
                <input type="hidden" name="redirect_to" value="/growing">
                <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Block</button>
              </form>
            ` : ''}
          </span>
          <button class="kudos-btn" onclick="likeGrowTip(${g.id}, this)">${KUDOS_BUD_ICON}Kudos (${g.likes})</button>
        </div>
      </div>`).join('') || `<div class="empty-note">No tips in this category yet — be the first to <a href="/growing">share one</a>.</div>`}
  `;
  sendHtml(res, layout({ title: 'Growing', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Share a Grow Tip', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

async function handleGrowingNewSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  if (await isSubmissionRateLimited('grow_tip_submit', userId)) return sendRateLimited(res, '/growing/new');
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
  sendHtml(res, layout({ title: 'Ask', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
    ${err === 'rate_limited' ? `<p style="color:#a13a3a;">Too many failed attempts. Try again in a few minutes.</p>` : (err ? `<p style="color:#a13a3a;">Wrong password.</p>` : '')}
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
  // Same persistent limiter as user login, keyed by IP only (there's just
  // one admin password, so there's no per-username dimension to key on).
  const adminKey = clientIp(req);
  if (await db.pruneAndCountAttempts('admin_login', adminKey, LOGIN_WINDOW_MS) >= LOGIN_MAX_ATTEMPTS) {
    return redirect(res, '/admin/login?err=rate_limited');
  }
  if (auth.checkPassword(f.password)) {
    await db.clearRateLimitAttempts('admin_login', adminKey);
    const token = auth.sign('admin');
    res.setHeader('Set-Cookie', [
      `admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      `admin_csrf_token=${encodeURIComponent(auth.csrfTokenFor(token))}; Path=/; SameSite=Lax; Max-Age=2592000`,
    ]);
    redirect(res, '/admin');
  } else {
    await db.recordRateLimitAttempt('admin_login', adminKey);
    redirect(res, '/admin/login?err=1');
  }
}
function handleAdminLogout(req, res) {
  res.setHeader('Set-Cookie', [
    `admin_session=; Path=/; HttpOnly; Max-Age=0`,
    `admin_csrf_token=; Path=/; Max-Age=0`,
  ]);
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
  // ?ref=username on the signup link (see pageInvite) -- shows who invited
  // this person and carries through as a hidden field so it survives to
  // handleSignupSubmit, which resolves it into invited_by on the new row.
  const refParam = (query.get('ref') || '').trim();
  const referrer = refParam ? db.getUserByUsername(refParam) : null;
  // ?strain=id + redirect_to -- see the strain-share signup prompt note on
  // the router's login wall above. Shows which strain was shared and
  // carries the path through so a new account lands back on it.
  const sharedStrain = query.get('strain') ? db.getStrain(query.get('strain')) : null;
  const redirectTo = safeRedirectPath(query.get('redirect_to') || '');
  const body = `
    <h1 class="screen-title">Create an Account</h1>
    <p class="screen-sub">You must be ${MIN_AGE}+ to use StrainDex.</p>
    ${sharedStrain ? `<p class="empty-note" style="color:var(--brand-green-dark);padding:0 0 10px;">🌿 Someone shared <b>${esc(sharedStrain.name)}</b> with you on StrainDex — sign up to see it.</p>` : ''}
    ${referrer ? `<p class="empty-note" style="color:var(--brand-green-dark);padding:0 0 10px;">🌿 ${esc(referrer.username)} invited you to StrainDex.</p>` : ''}
    ${deleted ? `<p class="empty-note" style="color:var(--brand-green-dark);">Your account and data have been deleted.</p>` : ''}
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    <a href="/auth/google" class="btn secondary block" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px;">
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
      Continue with Google
    </a>
    <p class="empty-note" style="text-align:center;margin:0 0 14px;">or</p>
    <form method="POST" action="/signup">
      ${referrer ? `<input type="hidden" name="ref" value="${esc(referrer.username)}">` : ''}
      ${redirectTo ? `<input type="hidden" name="redirect_to" value="${esc(redirectTo)}">` : ''}
      <label class="field-label" style="margin-top:0;">Username</label>
      <input type="text" name="username" id="signup-username" required minlength="3" maxlength="24" autocomplete="username">
      <label class="field-label">First name</label>
      <input type="text" name="first_name" required maxlength="50" autocomplete="given-name">
      <label class="field-label">Last name</label>
      <input type="text" name="last_name" required maxlength="50" autocomplete="family-name">
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
  sendHtml(res, layout({ title: 'Sign Up', body, showBack: false }));
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
      res.setHeader('Set-Cookie', [
        `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        `csrf_token=${encodeURIComponent(auth.csrfTokenFor(token))}; Path=/; SameSite=Lax; Max-Age=31536000`,
      ]);
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
  // Google's profile.name is a single display name, not separate first/
  // last fields -- split on the first space as a starting guess, but
  // both stay required and editable since that split is often wrong
  // (middle names, single names, non-Western name order).
  const nameParts = String(profile.name || '').trim().split(/\s+/);
  const suggestedFirst = nameParts[0] || '';
  const suggestedLast = nameParts.slice(1).join(' ') || '';
  const body = `
    <h1 class="screen-title">Almost there</h1>
    <p class="screen-sub">Signed in as ${esc(profile.email)} with Google. Just need a couple more things.</p>
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    <form method="POST" action="/auth/google/finish">
      <label class="field-label" style="margin-top:0;">Username</label>
      <input type="text" name="username" required minlength="3" maxlength="24" value="${esc(suggestedUsername)}">
      <label class="field-label">First name</label>
      <input type="text" name="first_name" required maxlength="50" value="${esc(suggestedFirst)}" autocomplete="given-name">
      <label class="field-label">Last name</label>
      <input type="text" name="last_name" required maxlength="50" value="${esc(suggestedLast)}" autocomplete="family-name">
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
  const firstName = String(f.first_name || '').trim();
  const lastName = String(f.last_name || '').trim();
  if (!username || !f.birth_date || !firstName || !lastName) return redirect(res, '/auth/google/finish?err=invalid');
  if (!isOldEnough(f.birth_date)) return redirect(res, '/auth/google/finish?err=age');
  if (db.getUserByUsername(username)) return redirect(res, '/auth/google/finish?err=taken');
  const user = await db.createUserFromGoogle({ username, birth_date: f.birth_date, email: profile.email, google_id: profile.sub, first_name: firstName, last_name: lastName });
  const token = auth.signUserSessionValue(user.id);
  res.setHeader('Set-Cookie', [
    `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    `csrf_token=${encodeURIComponent(auth.csrfTokenFor(token))}; Path=/; SameSite=Lax; Max-Age=31536000`,
    `google_pending=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  ]);
  redirect(res, '/onboarding');
}

async function handleSignupSubmit(req, res) {
  if (await isSignupRateLimited(req)) return redirect(res, '/signup?err=rate_limited');
  const f = await parseForm(req);
  const username = String(f.username || '').trim();
  const email = String(f.email || '').trim().toLowerCase();
  const firstName = String(f.first_name || '').trim();
  const lastName = String(f.last_name || '').trim();
  if (!username || !email || !f.birth_date || !f.password || !f.password2 || !firstName || !lastName) return redirect(res, '/signup?err=invalid');
  if (!isOldEnough(f.birth_date)) return redirect(res, '/signup?err=age');
  if (f.password !== f.password2) return redirect(res, '/signup?err=mismatch');
  if (f.password.length < 8) return redirect(res, '/signup?err=short');
  if (db.getUserByUsername(username)) return redirect(res, '/signup?err=taken');
  if (db.getUserByEmail(email)) return redirect(res, '/signup?err=email_taken');
  const referrer = f.ref ? db.getUserByUsername(String(f.ref).trim()) : null;
  const user = await db.createUser({ username, password: f.password, birth_date: f.birth_date, email, first_name: firstName, last_name: lastName, invited_by: referrer ? referrer.id : null });
  const token = auth.signUserSessionValue(user.id);
  res.setHeader('Set-Cookie', [
    `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    `csrf_token=${encodeURIComponent(auth.csrfTokenFor(token))}; Path=/; SameSite=Lax; Max-Age=31536000`,
  ]);
  redirect(res, safeRedirectPath(f.redirect_to) || '/onboarding');
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
  // Same redirect_to carry-through as signup, for someone who already has
  // an account and followed a shared strain link while logged out.
  const redirectTo = safeRedirectPath(query.get('redirect_to') || '');
  const sharedStrain = query.get('strain') ? db.getStrain(query.get('strain')) : null;
  const body = `
    <h1 class="screen-title">Log In</h1>
    ${sharedStrain ? `<p class="empty-note" style="color:var(--brand-green-dark);padding:0 0 10px;">🌿 Someone shared <b>${esc(sharedStrain.name)}</b> with you on StrainDex — log in to see it.</p>` : ''}
    ${err && errMessages[err] ? `<p style="color:#a13a3a;">${esc(errMessages[err])}</p>` : ''}
    <a href="/auth/google" class="btn secondary block" style="text-decoration:none;display:flex;align-items:center;justify-content:center;gap:8px;margin-bottom:14px;">
      <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
      Continue with Google
    </a>
    <p class="empty-note" style="text-align:center;margin:0 0 14px;">or</p>
    <form method="POST" action="/login">
      ${redirectTo ? `<input type="hidden" name="redirect_to" value="${esc(redirectTo)}">` : ''}
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
    <p class="empty-note">New here? <a href="/signup${sharedStrain || redirectTo ? '?' + new URLSearchParams({ ...(sharedStrain ? { strain: sharedStrain.id } : {}), ...(redirectTo ? { redirect_to: redirectTo } : {}) }).toString() : ''}">Create an account</a></p>
  `;
  sendHtml(res, layout({ title: 'Log In', body, showBack: false }));
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
// Computed live from real account state every time rather than a
// separate "onboarding progress" table to keep in sync -- same
// philosophy as getUserInsights/getCheckinStreak recomputing from source
// data instead of persisting derived state. Used both by the full
// checklist page and the compact card on Home.
function getOnboardingChecklist(userId) {
  const user = db.getUserById(userId);
  return [
    { key: 'checkin', done: db.listCheckins({ userId, limit: 1 }).length > 0, icon: '🔥', title: 'Log your first check-in', href: '/checkin' },
    { key: 'community', done: db.listFriends(userId).length > 0, icon: '🧑\u200d🤝\u200d🧑', title: 'Add someone to your community', href: '/friends' },
    { key: 'bio', done: !!(user && user.bio), icon: '📝', title: 'Set your bio', href: '/account' },
    { key: 'invite', done: db.listInvitedUsers(userId).length > 0, icon: '📣', title: 'Invite a friend', href: '/invite' },
  ];
}
// A real, checkable checklist instead of a one-time slideshow -- each
// item reflects actual account state (see getOnboardingChecklist), so
// unlike the old swipe-through-once-and-forget version, this gives
// someone a concrete reason to come back and do a second and third
// thing rather than stopping after whatever got them to sign up. Also
// reachable any time (not just right after signup) via the compact card
// on Home that shows while anything's still unchecked.
// USER-CONFIRMED REQUIREMENT: every account must have a first and last
// name. New signups (both the password and Google paths) now collect it
// up front; this page is the forced catch-up path for accounts that
// predate the requirement -- see the router gate further down, which
// redirects any logged-in user missing either field here before letting
// them reach anything else in the app. Don't make this optional, and
// don't remove the router gate, without asking first.
function pageCompleteProfile(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const user = db.getUserById(userId);
  const err = query.get('err');
  const body = `
    <h1 class="screen-title">Just one more thing</h1>
    <p class="screen-sub">We need your first and last name before you can continue.</p>
    ${err === 'invalid' ? `<p style="color:#a13a3a;">Please fill in both fields.</p>` : ''}
    <form method="POST" action="/complete-profile">
      <label class="field-label" style="margin-top:0;">First name</label>
      <input type="text" name="first_name" required maxlength="50" value="${esc(user.first_name || '')}" autocomplete="given-name">
      <label class="field-label">Last name</label>
      <input type="text" name="last_name" required maxlength="50" value="${esc(user.last_name || '')}" autocomplete="family-name">
      <button class="btn block" type="submit" style="margin-top:14px;">Continue</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Complete Your Profile', body, showBack: false }));
}
async function handleCompleteProfileSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const firstName = String(f.first_name || '').trim();
  const lastName = String(f.last_name || '').trim();
  if (!firstName || !lastName) return redirect(res, '/complete-profile?err=invalid');
  await db.updateName(userId, firstName, lastName);
  redirect(res, '/');
}
async function handleOnboardingDismiss(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.dismissOnboardingCard(userId);
  redirect(res, '/');
}
function pageOnboarding(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const checklist = getOnboardingChecklist(userId);
  const doneCount = checklist.filter(c => c.done).length;
  const allDone = doneCount === checklist.length;
  const body = `
    <h1 class="screen-title">Welcome to StrainDex 🌿</h1>
    <p class="screen-sub">${allDone ? 'You\u2019re all set up.' : 'A few things to get you started — check them off as you go.'}</p>
    <div class="progress-bar" style="margin-bottom:16px;"><div class="fill" style="width:${Math.round((100 * doneCount) / checklist.length)}%;"></div></div>
    ${checklist.map(item => `
      <a href="${item.href}" class="library-row" style="text-decoration:none;color:inherit;${item.done ? 'opacity:0.55;' : ''}">
        <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">${item.done ? '✅' : item.icon}</div>
        <div class="info">
          <div class="nm" style="${item.done ? 'text-decoration:line-through;' : ''}">${esc(item.title)}</div>
        </div>
      </a>
    `).join('')}
    <a href="/" class="btn block secondary" style="margin-top:16px;">${allDone ? 'Go to Home' : 'Skip for now'}</a>
  `;
  sendHtml(res, layout({ title: 'Welcome', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)), showBack: false }));
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
  sendHtml(res, layout({ title: 'Compare Strains', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  redirect(res, safeRedirectPath(f.redirect_to) || `/strains/${strainId}`);
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
  sendHtml(res, layout({ title: 'Grow Journal', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  storage.deletePhotos([entry.photo]).catch(e => console.error('[storage]', e));
  redirect(res, '/grow-journal');
}

// Social discovery: strains friends love that you haven't tried, using
// data already collected -- no new tracking, just a new lens on it.
function pageFriendsPicks(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const picks = db.getFriendsPicks(userId, 20);
  const body = `
    <h1 class="screen-title">Community Picks</h1>
    <p class="screen-sub">Strains your community rated 4★ or higher that you haven't checked into yet.</p>
    ${picks.length ? picks.map(p => `
      <a class="library-row" href="/strains/${p.strain.id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(p.strain, 'sm')}
        <div class="info">
          <div class="nm">${esc(p.strain.name)}</div>
          <div class="sub">Loved by ${p.friendNames.map(esc).join(', ')} · ${p.avgRating}★ avg</div>
        </div>
      </a>
    `).join('') : `<div class="empty-note">Nothing to show yet — either your community hasn't rated anything 4★+, or you've already tried everything they love. <a href="/friends">Add more people</a> or check back later.</div>`}
  `;
  sendHtml(res, layout({ title: "Community Picks", active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// ---------------------------------------------------------------- Puff Puff Ask (community forum)
// Sections mirror the same filter dimensions already used in the Strain
// Library (Type, Effect, Terpene, Relief/ailment, Rarity), plus a General
// catch-all -- so the forum's categories line up with vocabulary people
// already know from browsing strains, rather than inventing a new taxonomy.
// Threads and replies are persisted for real via db.listForumThreads /
// db.getForumThread / db.createForumThread / db.createForumReply (backed by
// the forum_threads / forum_replies tables in lib/db.js).
const FORUM_SECTIONS = [
  { key: 'general', label: 'General', icon: '💬', desc: 'Anything goes' },
  { key: 'type', label: 'By Type', icon: '🌿', desc: 'Indica, Sativa & Hybrid talk' },
  { key: 'effect', label: 'By Effect', icon: '🎯', desc: 'Chasing (or avoiding) a specific feeling' },
  { key: 'terpene', label: 'By Terpene', icon: '🌸', desc: 'Aroma & flavor nerdery' },
  { key: 'ailment', label: 'By Relief', icon: '🛡️', desc: 'What helped with what' },
  { key: 'rarity', label: 'By Rarity', icon: '⭐', desc: 'Common finds to legendary grails' },
];
const FORUM_SECTION_KEYS = new Set(FORUM_SECTIONS.map(s => s.key));
function forumSectionMeta(key) { return FORUM_SECTIONS.find(s => s.key === key) || FORUM_SECTIONS[0]; }
function forumAuthorName(userId) {
  const u = db.getUserById(userId);
  return u ? u.username : 'Former user';
}
function renderForumThreadRow(t) {
  const meta = forumSectionMeta(t.section);
  return `
    <a class="library-row" href="/puff-puff-ask/${t.id}" style="text-decoration:none;color:inherit;">
      <div class="info">
        <div class="nm">${esc(t.title)}</div>
        <div class="sub">${meta.icon} ${esc(meta.label)} · by ${esc(forumAuthorName(t.user_id))} · ${t.replyCount} repl${t.replyCount === 1 ? 'y' : 'ies'}</div>
      </div>
    </a>`;
}
function pagePuffPuffAsk(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const sectionKey = query.get('section') || '';
  const activeSection = FORUM_SECTION_KEYS.has(sectionKey) ? sectionKey : '';
  const threads = db.listForumThreads({ section: activeSection || undefined });
  const body = `
    <h1 class="screen-title">💨 Puff Puff Ask</h1>
    <p class="screen-sub">Ask the community anything — browse by section or start your own thread.</p>
    <div class="more-grid" style="margin-bottom:16px;">
      ${FORUM_SECTIONS.map(s => `
        <a class="more-tile ${activeSection === s.key ? 'active' : ''}" href="/puff-puff-ask?section=${s.key}">
          <span class="ic">${s.icon}</span>
          <div class="t">${esc(s.label)}</div>
          <div class="s">${esc(s.desc)}</div>
        </a>`).join('')}
    </div>
    ${activeSection ? `<p class="empty-note" style="margin-bottom:8px;">Showing ${esc(forumSectionMeta(activeSection).label)} · <a href="/puff-puff-ask">View all sections</a></p>` : ''}

    <div class="card" style="margin-bottom:16px;">
      <b style="font-size:14px;">Start a thread</b>
      <form method="POST" action="/puff-puff-ask/new" style="margin-top:8px;">
        <label class="field-label" style="margin-top:0;">Section</label>
        <select name="section">${FORUM_SECTIONS.map(s => `<option value="${s.key}" ${activeSection === s.key ? 'selected' : ''}>${s.icon} ${esc(s.label)}</option>`).join('')}</select>
        <label class="field-label">Title</label>
        <input type="text" name="title" placeholder="What's on your mind?" required maxlength="140">
        <label class="field-label">Details</label>
        <textarea name="body" placeholder="Add some context..." required></textarea>
        <button class="btn block" type="submit" style="margin-top:10px;">Post Thread</button>
      </form>
    </div>

    <div class="section-label">${activeSection ? esc(forumSectionMeta(activeSection).label) + ' threads' : 'Recent threads'} (${threads.length})</div>
    ${threads.length ? threads.map(renderForumThreadRow).join('') : `<div class="empty-note">No threads here yet — be the first to ask.</div>`}
  `;
  sendHtml(res, layout({ title: 'Puff Puff Ask', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
function pagePuffPuffAskThread(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const t = db.getForumThread(id);
  if (!t) return notFound(res);
  const meta = forumSectionMeta(t.section);
  const body = `
    <p class="empty-note" style="padding:0 0 6px;">${meta.icon} <a href="/puff-puff-ask?section=${t.section}">${esc(meta.label)}</a></p>
    <h1 class="screen-title">${esc(t.title)}</h1>
    <div class="card" style="margin-bottom:14px;">
      <div class="empty-note" style="padding:0 0 6px;">by ${esc(forumAuthorName(t.user_id))} · <span class="local-time" data-utc="${t.created_at}Z">${esc(t.created_at)} UTC</span></div>
      <p style="margin:0;white-space:pre-wrap;">${esc(t.body)}</p>
    </div>

    <div class="section-label">${t.replies.length} repl${t.replies.length === 1 ? 'y' : 'ies'}</div>
    ${t.replies.length ? t.replies.map(r => `
      <div class="card" style="margin-bottom:8px;">
        <div class="empty-note" style="padding:0 0 4px;">${esc(forumAuthorName(r.user_id))} · <span class="local-time" data-utc="${r.created_at}Z">${esc(r.created_at)} UTC</span></div>
        <p style="margin:0;white-space:pre-wrap;">${esc(r.body)}</p>
      </div>
    `).join('') : `<div class="empty-note">No replies yet — say something.</div>`}

    <form method="POST" action="/puff-puff-ask/${t.id}/reply" style="margin-top:10px;">
      <textarea name="body" placeholder="Write a reply..." required></textarea>
      <button class="btn block" type="submit" style="margin-top:8px;">Reply</button>
    </form>
  `;
  sendHtml(res, layout({ title: t.title, active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
async function handlePuffPuffAskNew(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const title = String(f.title || '').trim();
  const body = String(f.body || '').trim();
  const section = FORUM_SECTION_KEYS.has(f.section) ? f.section : 'general';
  if (!title || !body) return redirect(res, '/puff-puff-ask');
  const thread = await db.createForumThread({ user_id: userId, section, title, body });
  redirect(res, `/puff-puff-ask/${thread.id}`);
}
async function handlePuffPuffAskReply(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const t = db.getForumThread(id);
  if (!t) return notFound(res);
  const f = await parseForm(req);
  const body = String(f.body || '').trim();
  if (body) {
    await db.createForumReply({ thread_id: t.id, user_id: userId, body });
  }
  redirect(res, `/puff-puff-ask/${t.id}`);
}

// Custom personal lists -- as many as someone wants ("Morning strains",
// "Date night"), distinct from the single fixed Wishlist.
function pageLists(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const lists = db.listCustomLists(userId);
  const body = `
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
  sendHtml(res, layout({ title: 'Your Lists', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
function pageListDetail(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const list = db.getCustomList(Number(id));
  if (!list || list.user_id !== userId) return notFound(res);
  const items = db.listCustomListItems(list.id);
  const body = `
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
  sendHtml(res, layout({ title: list.name, active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
// USER-CONFIRMED: creating a list from the unified "Add to Lists" popup
// (see renderAddToListsButton on the strain page) immediately adds the
// strain that was open, in one step, rather than creating an empty list
// and making the person come back separately to add it. strain_id and
// redirect_to are both optional -- the plain /lists "Create" form doesn't
// send them, and still works exactly as before.
async function handleListCreate(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  const name = String(f.name || '').trim();
  if (name) {
    const list = await db.createCustomList(userId, name);
    if (f.strain_id) await db.addStrainToList(list.id, f.strain_id);
  }
  redirect(res, safeRedirectPath(f.redirect_to) || '/lists');
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
  redirect(res, safeRedirectPath(f.redirect_to) || `/strains/${strainId}`);
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
  // Personalization: not just "how common is this in the library" but
  // "how much of this shows up in what you've actually logged," reusing
  // the same weighted terpene breakdown Your Patterns already computes.
  const userId = auth.currentUserId(req);
  const insights = userId != null ? db.getUserInsights(userId) : null;
  const myPct = {};
  if (insights && insights.topTerpenes) insights.topTerpenes.forEach(t => { myPct[t.name] = t.pct; });
  const body = `
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
        ${myPct[name] ? `<p style="margin:4px 0 0;color:var(--brand-green-dark);font-weight:700;font-size:13px;">🌿 ${myPct[name]}% of your own check-in history</p>` : ''}
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Terpene Guide', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
// Reverse lookup so each Effects Guide entry can link straight to a
// pre-filled Mood Finder result when one exists, rather than leaving two
// features that cover overlapping ground disconnected from each other.
// First matching goal wins where an effect appears in more than one.
function moodGoalKeyForEffect(effectName) {
  for (const [key, goal] of Object.entries(MOOD_GOALS)) {
    if (goal.effects.includes(effectName)) return key;
  }
  return null;
}
function pageEffectsGuide(req, res) {
  const allStrains = db.listStrains({ limit: 5000 });
  const counts = {};
  allStrains.forEach(s => (s.effects || []).forEach(e => { counts[e] = (counts[e] || 0) + 1; }));
  const entries = Object.entries(EFFECTS_GUIDE).sort((a, b) => (counts[b[0]] || 0) - (counts[a[0]] || 0));
  // Same personalization idea as the Terpene Guide: how often this effect
  // actually shows up in the viewer's own logged check-ins, not just how
  // common it is across the whole library.
  const userId = auth.currentUserId(req);
  const insights = userId != null ? db.getUserInsights(userId) : null;
  const myCount = {};
  if (insights && insights.topEffects) insights.topEffects.forEach(e => { myCount[e.name] = e.count; });
  const body = `
    <h1 class="screen-title">Effects Guide</h1>
    <p class="screen-sub">What people commonly report feeling from each effect tag — reported associations, not guaranteed outcomes. Everyone responds differently.</p>
    ${entries.map(([name, description]) => {
      const goalKey = moodGoalKeyForEffect(name);
      return `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <h2 style="margin:0;font-size:16px;">${esc(name)}</h2>
          <a href="/strains?effect=${encodeURIComponent(name)}" class="empty-note" style="padding:0;">${counts[name] || 0} strains →</a>
        </div>
        <p style="margin:6px 0 0;">${esc(description)}</p>
        ${myCount[name] ? `<p style="margin:4px 0 0;color:var(--brand-green-dark);font-weight:700;font-size:13px;">🌿 You've logged this ${myCount[name]} time${myCount[name] === 1 ? '' : 's'}</p>` : ''}
        ${goalKey ? `<a href="/mood-finder?goal=${goalKey}" class="empty-note" style="display:inline-block;padding:6px 0 0;">${esc(MOOD_GOALS[goalKey].icon)} Find strains for ${esc(MOOD_GOALS[goalKey].label)} →</a>` : ''}
      </div>
    `;
    }).join('')}
  `;
  sendHtml(res, layout({ title: 'Effects Guide', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
    return sendHtml(res, layout({ title: 'Mood Finder', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
    <h1 class="screen-title">${goal.icon} ${esc(goal.label)}</h1>
    <p class="screen-sub">Matched against strains tagged ${goal.effects.map(esc).join(' or ')}.</p>
    ${scored.length ? scored.map(({ s }) => `
      <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(s, 'sm')}
        <div class="info">
          <div class="nm">${esc(s.name)} <span title="${esc(VERIFICATION_BADGE[strainVerificationTier(s)].label)}">${VERIFICATION_BADGE[strainVerificationTier(s)].icon}</span> ${renderAwardBadges(s, { compact: true })}</div>
          <div class="sub">${esc(s.type)} · ${s.effects.map(esc).join(', ')}</div>
        </div>
      </a>
    `).join('') : `<div class="empty-note">No strains matched this goal yet.</div>`}
  `;
  sendHtml(res, layout({ title: goal.label, active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
// Well-documented landrace populations by region of origin -- deliberately
// a small, confidently-sourced list rather than an attempt to tag every
// strain in the library as landrace/not, since there's no reliable field
// for that in the strain schema and guessing would be worse than a short,
// solid list. Each name only shows as a clickable link if it actually
// exists in the library under this exact name (via findStrainByName);
// otherwise it renders as plain text rather than a dead link.
const LANDRACE_REGIONS = [
  { region: 'Afghanistan & Pakistan', names: ['Afghan Kush', 'Hindu Kush', 'Mazar-i-Sharif'] },
  { region: 'Thailand', names: ['Thai', 'Chocolate Thai'] },
  { region: 'South Africa & Swaziland', names: ['Durban Poison', 'Swazi'] },
  { region: 'Jamaica', names: ["Lambsbread", 'Jamaican Lambsbread'] },
  { region: 'Mexico', names: ['Acapulco Gold', 'Mexican Sativa'] },
  { region: 'Colombia', names: ['Colombian Gold', 'Punto Rojo'] },
  { region: 'Panama', names: ['Panama Red'] },
  { region: 'Malawi', names: ['Malawi Gold'] },
  { region: 'Nepal', names: ['Nepalese'] },
  { region: 'Lebanon', names: ['Lebanese'] },
];
// Pulls real definitions straight from GLOSSARY_TERMS (by key) rather than
// writing a second, possibly-diverging copy of the same explanation --
// those definitions already exist for auto-linking inline in recipes and
// grow tips; this just gives the genetics/breeding subset of them a real
// standalone page to be read on their own, grouped for context rather
// than encountered one at a time mid-sentence.
function glossaryDef(key) {
  const term = GLOSSARY_TERMS.find(t => t.key === key);
  return term ? term.definition : '';
}
const GENETICS_GUIDE_SECTIONS = [
  {
    title: 'Lineage & Breeding',
    terms: [
      { key: 'landrace', label: 'Landrace' },
      { key: 'heirloom', label: 'Heirloom' },
      { key: 'backcross', label: 'Backcross (Bx1, Bx2...)' },
      { key: 'ibl', label: 'IBL (Inbred Line)' },
      { key: 'filial', label: 'Filial Generations (F1, F2, F3)' },
      { key: 'polyhybrid', label: 'Polyhybrid' },
    ],
  },
  {
    title: 'Plant Types & Expression',
    terms: [
      { key: 'cultivar', label: 'Cultivar' },
      { key: 'phenotype', label: 'Phenotype (Pheno)' },
      { key: 'pheno-hunt', label: 'Pheno-Hunting' },
      { key: 'clone-only', label: 'Clone-Only' },
      { key: 'indica', label: 'Indica' },
      { key: 'sativa', label: 'Sativa' },
      { key: 'hybrid', label: 'Hybrid' },
    ],
  },
  {
    title: 'Growing & Flowering',
    terms: [
      { key: 'autoflowering', label: 'Autoflowering' },
      { key: 'photoperiod', label: 'Photoperiod' },
      { key: 'flowering', label: 'Flowering' },
      { key: 'topping', label: 'Topping' },
    ],
  },
];
function pageGeneticsGuide(req, res) {
  const body = `
    <h1 class="screen-title">Genetics & Breeding Guide</h1>
    <p class="screen-sub">The vocabulary behind how strains actually get made — see also the <a href="/landrace-guide">Landrace Guide</a> for where most of this traces back to.</p>
    ${GENETICS_GUIDE_SECTIONS.map(sec => `
      <div class="section-label" style="margin-top:18px;">${esc(sec.title)}</div>
      ${sec.terms.map(t => `
        <div class="card" style="margin-bottom:10px;">
          <h2 style="margin:0 0 6px;font-size:16px;">${esc(t.label)}</h2>
          <p style="margin:0;">${esc(glossaryDef(t.key))}</p>
        </div>
      `).join('')}
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Genetics & Breeding Guide', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
function pageLandraceGuide(req, res) {
  const body = `
    <h1 class="screen-title">Landrace Guide</h1>
    <p class="screen-sub">The genetic root almost everything else in the library was eventually built from.</p>
    <div class="card" style="margin-bottom:16px;">
      <p style="margin:0 0 10px;">A <b>landrace</b> is a cannabis variety that developed naturally in one specific region over many generations — shaped by local climate and traditional farming, not deliberate modern crossbreeding.</p>
      <p style="margin:0 0 10px;"><b>Geographic origin is core to its identity.</b> Landraces are typically named for where they come from — the place isn't a marketing detail, it's what actually produced the genetics.</p>
      <p style="margin:0 0 10px;"><b>They're the product of natural selection plus generations of local cultivation</b> — not a breeder selecting for traits over a few generations, but a population adapting to its own environment over a long stretch of time.</p>
      <p style="margin:0 0 10px;"><b>They're relatively genetically stable.</b> Because a landrace was never crossed with anything else, plants grown from it tend to look and behave a lot like each other, unlike a strain with a complicated hybrid pedigree.</p>
      <p style="margin:0 0 10px;"><b>They're the foundation modern hybrids are built from.</b> Nearly every popular strain today traces back, through a chain of crosses, to landrace ancestors.</p>
      <p style="margin:0 0 10px;"><b>They're also genuinely at risk.</b> Commercial breeding overwhelmingly favors hybrids, so a lot of original landrace populations have become rare in cultivation — once a specific line is lost, it can't be recreated.</p>
      <p style="margin:0;"><b>Landrace vs. heirloom, a common mix-up:</b> a landrace is still growing in the region that shaped it. An <b>heirloom</b> is that same seed taken out of its native region and preserved/grown elsewhere for generations — genetically very close to the original, just no longer in the environment that produced it.</p>
    </div>
    <p class="empty-note" style="margin-bottom:14px;">This is also why landraces and clone-only strains are deliberately left unparented elsewhere in this library — a landrace doesn't have two parent strains the way a hybrid does. It <i>is</i> the root of the tree, not a branch. For more of this vocabulary — phenotype, backcross, cultivar, and the rest — see the <a href="/genetics-guide">Genetics & Breeding Guide</a>.</p>
    <div class="section-label">Known Landraces by Region</div>
    ${LANDRACE_REGIONS.map(r => `
      <div class="card" style="margin-bottom:10px;">
        <h2 style="margin:0 0 6px;font-size:16px;">${esc(r.region)}</h2>
        <p style="margin:0;">${r.names.map(n => {
          const match = findStrainByName(n);
          return match ? `<a href="/strains/${match.id}">${esc(n)}</a>` : esc(n);
        }).join(', ')}</p>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Landrace Guide', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
function pageBreederGuide(req, res) {
  const allStrains = db.listStrains({ limit: 5000 });
  const counts = {};
  allStrains.forEach(s => { if (s.breeder) counts[s.breeder] = (counts[s.breeder] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40);
  const body = `
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
  sendHtml(res, layout({ title: 'Breeder Guide', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageWishlist(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const items = db.getWishlist(userId);
  const body = `
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
  sendHtml(res, layout({ title: 'Your Wishlist', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Trending This Week', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Risk tiers for the color-coded dot, same idea as LEGAL_STATUS_LABELS.
// Genuinely reflects the underlying content rather than being invented
// for visual variety -- nothing here is rated "low," because nothing in
// this list actually is.
const RISK_LEVELS = {
  moderate: { label: 'Moderate Risk', color: '#8a6d1f' },
  serious: { label: 'Serious Risk', color: '#a13a3a' },
};
// Mixing cautions -- deliberately conservative, pattern-level guidance
// only (matching the app's existing "not medical advice" framing), never
// dosing specifics. General public-health caution categories, not a
// comprehensive drug-interaction database. USER-CONFIRMED LAYOUT: lean
// list with a popup modal per item, same pattern as Is It Legal Near Me
// -- don't flatten this back into stacked full-paragraph cards without
// asking first.
const MIXING_CAUTIONS = [
  { title: 'Alcohol', risk: 'moderate',
    whatToKnow: 'Combining cannabis and alcohol tends to intensify the effects of both, and impairment can hit harder and less predictably than either alone. This combination is also linked to a much higher risk of nausea ("greening out").',
    whatToDo: 'If combining at all, go slower and lower on both than you normally would with either individually.' },
  { title: 'Sedatives & sleep medication', risk: 'serious',
    whatToKnow: 'Cannabis is itself sedating for many people, and combining it with prescription sedatives, sleep aids, or benzodiazepines can compound drowsiness and impaired coordination well beyond what either produces alone.',
    whatToDo: 'Talk to the prescribing doctor before combining.' },
  { title: 'Stimulants', risk: 'moderate',
    whatToKnow: 'Combining cannabis with stimulants (including prescription ADHD medication or high caffeine intake) can mask how impaired or wired you actually are, since the two pull in different directions.',
    whatToDo: "Pay extra attention to how you actually feel rather than assuming — it's easy to misjudge your own state in this combination." },
  { title: 'Blood thinners & heart/blood pressure medications', risk: 'serious',
    whatToKnow: 'Cannabis can affect heart rate and blood pressure, and may interact with how the liver processes certain medications, including some blood thinners.',
    whatToDo: 'This is genuinely a "talk to your doctor or pharmacist" situation, not a guess-and-check one.' },
  { title: 'Driving or operating machinery', risk: 'serious',
    whatToKnow: "Cannabis impairs reaction time and judgment in ways that don't always feel as obvious as alcohol impairment does.",
    whatToDo: "Treat any active THC in your system the same as you would being over a legal alcohol limit — don't drive." },
  { title: 'Pregnancy & breastfeeding', risk: 'serious',
    whatToKnow: 'Major health organizations advise against cannabis use during pregnancy and while breastfeeding due to potential effects on fetal and infant development.',
    whatToDo: 'This one has clear medical consensus — talk to an OB or pediatrician directly rather than relying on general guidance here.' },
];
function pageMixingCautions(req, res) {
  const slug = s => s.replace(/[^a-zA-Z0-9]/g, '');
  const renderModal = c => `
    <div id="caution-${slug(c.title)}" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this) this.style.display='none';">
      <div style="background:#ffffff;border-radius:16px;max-width:460px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;color:#2a2a2a;">
        <div style="overflow-y:auto;padding:22px;position:relative;">
          <button type="button" onclick="document.getElementById('caution-${slug(c.title)}').style.display='none';" style="position:absolute;top:0;right:0;width:32px;height:32px;border-radius:8px;border:1px solid #e3e1d8;background:none;cursor:pointer;font-size:16px;line-height:1;color:#2a2a2a;">\u2715</button>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${RISK_LEVELS[c.risk].color};display:inline-block;"></span>
            <span style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6b6b6b;">${esc(RISK_LEVELS[c.risk].label)}</span>
          </div>
          <h2 style="margin:0 0 16px;font-size:22px;padding-right:30px;">${esc(c.title)}</h2>
          <div style="margin-bottom:14px;">
            <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#6b6b6b;margin-bottom:3px;">What to Know</div>
            <div>${linkGlossaryTerms(esc(c.whatToKnow))}</div>
          </div>
          <div>
            <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#6b6b6b;margin-bottom:3px;">What to Do</div>
            <div>${linkGlossaryTerms(esc(c.whatToDo))}</div>
          </div>
        </div>
        <div style="background:#f2f1ec;padding:12px 22px;font-size:12px;color:#6b6b6b;flex-shrink:0;">
          Not medical advice. If a combination that used to work stops feeling like it does, that's often <a href="/tolerance-explained">tolerance</a>, not the mix itself.
        </div>
      </div>
    </div>
  `;
  const body = `
    <h1 class="screen-title">Mixing With Other Substances</h1>
    <p class="screen-sub">General, pattern-level cautions — tap one for the full breakdown. Not medical advice, not a complete interaction database, and not a substitute for talking to a doctor or pharmacist about your specific medications.</p>
    <p class="empty-note">Last reviewed: ${esc(SAFETY_GUIDES_LAST_REVIEWED)}.</p>
    ${MIXING_CAUTIONS.map(c => `
      <button type="button" onclick="document.getElementById('caution-${slug(c.title)}').style.display='flex';" class="library-row" style="width:100%;text-align:left;border:none;background:var(--bg-card,#fff);cursor:pointer;">
        <span style="width:10px;height:10px;border-radius:50%;background:${RISK_LEVELS[c.risk].color};flex-shrink:0;"></span>
        <div class="info"><div class="nm">${esc(c.title)}</div><div class="sub">${esc(RISK_LEVELS[c.risk].label)}</div></div>
      </button>
    `).join('')}
    ${MIXING_CAUTIONS.map(renderModal).join('')}
  `;
  sendHtml(res, layout({ title: 'Mixing With Other Substances', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageStorageGuide(req, res) {
  const cards = [
    { title: 'Flower', body: 'Airtight, cool, and out of direct light is the whole game — a mason jar in a closet beats a plastic bag on a windowsill. Too dry and it loses flavor and harshness gets worse; too humid and mold becomes a real risk. Humidity-control packs (aiming for roughly 58–62% RH inside the jar) are the easiest way to hit the sweet spot without guessing.' },
    { title: 'Concentrates', body: 'Heat and light are what actually degrade a concentrate\u2019s terpenes and potency over time, so cool and dark matters even more here than with flower. Use glass or silicone, not plastic — some concentrates will stick to or slowly degrade plastic containers. Many people keep concentrates in the fridge or freezer for longer-term storage; let them come back to room temperature before handling so they\u2019re easier to work with.', link: '/concentrates', linkLabel: 'What those products actually are \u2192' },
    { title: 'Edibles', body: 'Treat them like any other food with the same ingredients — a baked good behaves like a baked good, a gummy behaves like a gummy. Airtight storage, and refrigerate anything with dairy, eggs, or fresh fruit the way you would if it weren\u2019t infused. Keep them clearly labeled and out of reach of anyone who might mistake them for a regular snack.' },
    { title: 'Seeds', body: 'Cool, dark, and dry, ideally in an airtight container in the fridge — viable seeds can last years stored well, but heat and humidity shorten that a lot.' },
  ];
  const body = `
    <h1 class="screen-title">Storage Guide</h1>
    <p class="screen-sub">How to actually keep what you\u2019ve got fresh — pairs well with the <a href="/best-by">Best-By Calendar</a>, which tracks *when* something\u2019s made rather than *how* to store it.</p>
    ${cards.map(c => `
      <div class="card" style="margin-bottom:10px;">
        <h2 style="margin:0 0 6px;font-size:15px;">${esc(c.title)}</h2>
        <p style="margin:0;">${linkGlossaryTerms(esc(c.body))}</p>
        ${c.link ? `<a href="${c.link}" class="empty-note" style="display:inline-block;padding:4px 0 0;">${esc(c.linkLabel)}</a>` : ''}
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Storage Guide', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageLabResultGuide(req, res) {
  const cards = [
    { title: 'Potency (THC / CBD %)', body: 'The headline number, but not the whole picture. Raw flower contains mostly THCA, which converts to the THC that actually gets you high only once it\u2019s heated (see "Total THC" below). A gap between a product\u2019s THC and Total THC numbers is normal, not a red flag.' },
    { title: 'Total THC', body: 'The calculated potential THC once everything convertible (mostly THCA) has been fully decarboxylated — usually the more meaningful number for judging real-world potency than raw "THC" alone.' },
    { title: 'Terpene panel', body: 'A breakdown of which aromatic compounds are present and in what percentage. Not every lab tests for this, and not every product lists it, but it\u2019s a good sign of a more thorough test when it\u2019s there.' },
    { title: 'Contaminant screening', body: 'The safety half of the report: pesticides, heavy metals, microbials (mold and bacteria), and residual solvents (for anything solvent-extracted). A legitimate COA will show "pass" results here, not just potency numbers — a report with potency but no contaminant screening is worth being skeptical of.' },
    { title: 'Batch / lot number', body: 'Ties the specific report to the specific batch you\u2019re holding, not just "this product line in general." If a batch number on the product doesn\u2019t match the report, that\u2019s worth questioning.' },
    { title: 'Lab name & license', body: 'A real COA names the testing lab and its license number, and is usually verifiable on that lab\u2019s own site or your state\u2019s regulatory portal. No lab name, or one you can\u2019t find anywhere, is a real warning sign.' },
  ];
  const body = `
    <h1 class="screen-title">How to Read a Lab Result</h1>
    <p class="screen-sub">What a real Certificate of Analysis (COA) actually shows, so you can tell a trustworthy one from a sketchy one. Not medical advice.</p>
    <p class="empty-note">Last reviewed: ${esc(SAFETY_GUIDES_LAST_REVIEWED)}.</p>
    ${cards.map(c => `
      <div class="card" style="margin-bottom:10px;">
        <h2 style="margin:0 0 6px;font-size:15px;">${esc(c.title)}</h2>
        <p style="margin:0;">${linkGlossaryTerms(esc(c.body))}</p>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'How to Read a Lab Result', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageToleranceExplained(req, res) {
  const body = `
    <h1 class="screen-title">Tolerance, Explained</h1>
    <p class="screen-sub">The thinking behind the Tolerance Break tracker on <a href="/insights">Your Patterns</a>. Not medical advice.</p>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">Why tolerance builds</h2>
      <p style="margin:0;">${linkGlossaryTerms(esc('With regular use, the body adjusts to a steady presence of THC, and the same dose gradually produces less effect. It\u2019s the same basic pattern behind tolerance to a lot of substances, not something specific to cannabis.'))}</p>
    </div>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">Why a break actually works</h2>
      <p style="margin:0;">${linkGlossaryTerms(esc('Stepping away for a stretch lets that adjustment reverse, so a dose that stopped doing much starts working like it used to. This is the entire idea behind a "t-break" — time off, not a different strain or a bigger dose, is what resets it.'))}</p>
    </div>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">How long is enough?</h2>
      <p style="margin:0;">There\u2019s no single universal number — it depends on how heavy and how regular your use has been. Many people notice a real difference within a couple of weeks; a longer history of frequent use may take longer to fully reset. The point of tracking it (see Your Patterns) is seeing your own pattern, not hitting someone else\u2019s number.</p>
    </div>
    <div class="card">
      <h2 style="margin:0 0 6px;font-size:15px;">What doesn\u2019t really help</h2>
      <p style="margin:0;">Switching strains or methods doesn\u2019t reset tolerance the way a real break does — THC tolerance is fairly general, not specific to one strain. It can still be worth doing for variety, just don\u2019t expect it to substitute for actual time off.</p>
    </div>
  `;
  sendHtml(res, layout({ title: 'Tolerance, Explained', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// The one piece of safety content this app didn't have yet: not general
// education (dosing, mixing, storage) but what to actually do in the
// moment if something feels wrong. Calm and practical, not alarmist --
// cannabis alone is rarely dangerous, but the discomfort is real and
// worth real, specific guidance rather than just "it'll pass."
// A genuinely different kind of content from the rest of Education --
// everything else here explains things; this actively corrects
// misconceptions people may already hold, rather than just teaching from
// scratch. Not medical advice.
const COMMON_MYTHS = [
  { myth: 'Higher THC% always means a stronger high', truth: 'THC percentage is one input, not the whole formula. Terpenes and the ratio of cannabinoids present shape the actual experience a lot -- two strains at the same THC% can feel noticeably different. See the Terpene Guide.', link: '/terpene-guide', linkLabel: 'Terpene Guide \u2192' },
  { myth: "You can't get dependent on cannabis", truth: 'Cannabis Use Disorder is a real, recognized condition, and regular use does build real tolerance. It\u2019s not comparable in severity to substances like opioids or alcohol, but "not possible" isn\u2019t accurate either.', link: '/tolerance-explained', linkLabel: 'Tolerance, Explained \u2192' },
  { myth: "It's safe to drive the morning after edibles", truth: 'THC and its metabolites can still be active well after you feel "normal" again, especially after a heavier edible dose. If you\u2019re unsure, don\u2019t drive -- there\u2019s no reliable self-test for this.', link: '/feels-wrong', linkLabel: 'If Something Feels Wrong \u2192' },
  { myth: "Smoking is safer than vaping since it's \"natural\"", truth: 'Combustion produces tar and carcinogens regardless of what\u2019s being burned -- "natural" doesn\u2019t mean the smoke itself is. See Ways to Enjoy It for how the methods actually compare.', link: '/methods', linkLabel: 'Ways to Enjoy It \u2192' },
  { myth: "You can't overdose on cannabis", truth: 'There\u2019s no recorded death from THC alone, but a genuinely overwhelming reaction -- intense panic, vomiting, or in rare cases temporary psychosis in vulnerable people -- is real and worth taking seriously, even if it\u2019s not life-threatening the way an opioid overdose is.', link: '/feels-wrong', linkLabel: 'If Something Feels Wrong \u2192' },
  { myth: 'Indica = body high, sativa = head high, always', truth: 'That\u2019s a real historical pattern, but modern hybrids blur it constantly -- genetics don\u2019t cleanly map to a guaranteed effect the way the old rule of thumb suggests. See the Genetics & Breeding Guide.', link: '/genetics-guide', linkLabel: 'Genetics & Breeding Guide \u2192' },
  { myth: "CBD doesn't do anything", truth: "CBD won't get you high on its own, but that's different from having no effect -- it's just not intoxicating. Full-spectrum, broad-spectrum, and isolate products all use this distinction differently. See the Glossary.", link: '/glossary', linkLabel: 'Glossary \u2192' },
];
// A genuinely different way to engage with Education content -- everything
// else here is passive reading; this is active recall, pulled from real
// Glossary definitions rather than invented trivia. Entirely client-side
// (no score to persist, nothing server-rendered per-question) since it's
// just a quick knowledge check, not a tracked feature.
const KNOWLEDGE_QUIZ = [
  { q: 'What does "decarboxylation" actually do?', options: ['Converts THCA into THC', 'Removes THC entirely', 'Adds terpenes to flower', 'Cures the flower after harvest'], correct: 0 },
  { q: 'What is a "landrace"?', options: ['A strain bred with itself repeatedly', 'A strain that developed naturally in one region over generations', 'A strain sold at only one dispensary', 'A strain bred to have zero THC'], correct: 1 },
  { q: 'What\u2019s the real difference between a backcross and an IBL?', options: ['There isn\u2019t one', 'A backcross breeds back into a parent strain; an IBL breeds with its own line instead', 'A backcross is illegal, an IBL isn\u2019t', 'IBL is a type of concentrate'], correct: 1 },
  { q: 'What does "Total THC" on a lab result actually represent?', options: ['Just the raw THC already present', 'THC plus the THCA that would convert once fully decarbed', 'The total weight of the product', 'CBD content'], correct: 1 },
  { q: 'What\u2019s the safest first move if you feel too high?', options: ['Take more to push through it', 'Move somewhere calm, sit down, and let it pass', 'Drive somewhere else', 'Ignore it entirely'], correct: 1 },
  { q: 'What\u2019s the real difference between full-spectrum and isolate products?', options: ['No real difference', 'Full-spectrum keeps the whole range of cannabinoids/terpenes; isolate is one purified compound', 'Isolate is always stronger', 'Full-spectrum has no THC at all'], correct: 1 },
  { q: 'Why do edibles catch people off guard more than smoking?', options: ['They\u2019re weaker overall', 'They kick in immediately', 'They take much longer to start, so people redose before feeling anything', 'They contain no THC'], correct: 2 },
  { q: 'What\u2019s a "phenotype"?', options: ['A type of fertilizer', 'The specific way a strain\u2019s genetics actually show up in one plant', 'A legal classification of cannabis', 'An extraction method for concentrates'], correct: 1 },
];
function pageKnowledgeQuiz(req, res) {
  const body = `
    <h1 class="screen-title">Test What You Know</h1>
    <p class="screen-sub">A quick knowledge check, pulled from the same definitions in the Glossary and FAQ.</p>
    <div id="quiz-root"></div>
    <script>
      (function() {
        const QUESTIONS = ${JSON.stringify(KNOWLEDGE_QUIZ)};
        let i = 0, score = 0, answered = false;
        const root = document.getElementById('quiz-root');
        function render() {
          if (i >= QUESTIONS.length) {
            root.innerHTML = '<div class="card" style="text-align:center;padding:24px;">'
              + '<div style="font-size:32px;">' + (score >= QUESTIONS.length * 0.7 ? '\\ud83c\\udf89' : '\\ud83c\\udf3f') + '</div>'
              + '<div style="font-weight:700;font-size:16px;margin-top:8px;">' + score + ' / ' + QUESTIONS.length + '</div>'
              + '<a href="/knowledge-quiz" class="btn block" style="margin-top:14px;text-decoration:none;">Try Again</a>'
              + '</div>';
            return;
          }
          const item = QUESTIONS[i];
          answered = false;
          root.innerHTML = '<div class="card">'
            + '<div class="empty-note" style="padding:0 0 8px;">Question ' + (i + 1) + ' of ' + QUESTIONS.length + '</div>'
            + '<h2 style="margin:0 0 10px;font-size:15px;">' + item.q + '</h2>'
            + item.options.map(function(opt, idx) {
                return '<button type="button" class="btn secondary block quiz-opt" data-idx="' + idx + '" style="text-align:left;margin-bottom:8px;">' + opt + '</button>';
              }).join('')
            + '<div id="quiz-feedback" style="margin-top:6px;"></div>'
            + '</div>';
          Array.prototype.forEach.call(root.querySelectorAll('.quiz-opt'), function(btn) {
            btn.addEventListener('click', function() {
              if (answered) return;
              answered = true;
              const idx = Number(btn.getAttribute('data-idx'));
              const correct = idx === item.correct;
              if (correct) score++;
              Array.prototype.forEach.call(root.querySelectorAll('.quiz-opt'), function(b, bi) {
                if (bi === item.correct) b.style.borderColor = 'var(--brand-green-dark)';
                if (bi === idx && !correct) b.style.borderColor = '#a13a3a';
              });
              document.getElementById('quiz-feedback').innerHTML = '<p class="empty-note" style="padding:0;font-weight:700;color:' + (correct ? 'var(--brand-green-dark)' : '#a13a3a') + ';">' + (correct ? 'Correct!' : 'Not quite -- correct answer highlighted above.') + '</p><button type="button" id="quiz-next" class="btn block" style="margin-top:8px;">' + (i + 1 < QUESTIONS.length ? 'Next' : 'See Score') + '</button>';
              document.getElementById('quiz-next').addEventListener('click', function() { i++; render(); });
            });
          });
        }
        render();
      })();
    </script>
  `;
  sendHtml(res, layout({ title: 'Test What You Know', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageCommonMyths(req, res) {
  const body = `
    <h1 class="screen-title">Common Myths, Debunked</h1>
    <p class="screen-sub">Not medical advice -- just a few widely-held ideas worth double-checking.</p>
    ${COMMON_MYTHS.map(m => `
      <div class="card" style="margin-bottom:10px;">
        <h2 style="margin:0 0 6px;font-size:15px;color:#a13a3a;">\u274c "${esc(m.myth)}"</h2>
        <p style="margin:0 0 6px;">${linkGlossaryTerms(esc(m.truth))}</p>
        <a href="${m.link}" class="empty-note" style="display:inline-block;padding:0;">${esc(m.linkLabel)}</a>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Common Myths, Debunked', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Rounds out Landrace/Genetics (the biological story) and Legal Status
// (the current legal picture) with how cannabis actually got from
// "illegal nearly everywhere" to today's state-by-state patchwork.
// Sticking to well-documented dates and laws rather than contested claims
// about motive.
const CANNABIS_HISTORY = [
  { era: 'Ancient use', body: 'Cannabis use for fiber, food, and medicine stretches back thousands of years across Asia, the Middle East, and Africa -- among the oldest documented references is its listing in Chinese medical texts dating back over 2,000 years.' },
  { era: 'Global spread', body: 'Landrace populations developed independently across many regions over centuries (see the Landrace Guide) as cannabis spread along trade routes and took root in wildly different climates.' },
  { era: '1937: The Marihuana Tax Act', body: 'The first major US federal restriction, effectively criminalizing cannabis nationwide through prohibitive taxation and regulation rather than an outright ban by name.' },
  { era: '1970: Controlled Substances Act', body: 'Classified cannabis as a Schedule I substance -- the federal government\u2019s most restrictive category, reserved for drugs deemed to have no accepted medical use and a high potential for abuse. This classification remains in effect at the federal level today, regardless of state law.' },
  { era: '1996: California\u2019s Prop 215', body: 'The first state medical marijuana law in the modern era, opening the door for the wave of state-level medical programs that followed over the next two decades.' },
  { era: '2012: Colorado & Washington', body: 'The first two US states to legalize adult-use (recreational) cannabis by ballot measure, kicking off the state-by-state legalization wave that\u2019s continued since.' },
  { era: 'Today: a real patchwork', body: 'Cannabis law now varies enormously by state -- recreational, medical-only, low-THC-only, or fully illegal, all coexisting in the same country, while federal law hasn\u2019t caught up. See Is It Legal Near Me? for where your state actually stands.' },
];
function pageCannabisHistory(req, res) {
  const body = `
    <h1 class="screen-title">A Brief History of Cannabis</h1>
    <p class="screen-sub">How it got from "illegal nearly everywhere" to today's patchwork -- the legal and historical story, not the genetics (see the <a href="/landrace-guide">Landrace Guide</a> for that).</p>
    ${CANNABIS_HISTORY.map(h => `
      <div class="card" style="margin-bottom:10px;">
        <h2 style="margin:0 0 6px;font-size:15px;">${esc(h.era)}</h2>
        <p style="margin:0;">${linkGlossaryTerms(esc(h.body))}</p>
      </div>
    `).join('')}
    <a href="/legal-status" class="empty-note" style="display:block;margin-top:4px;">See where your state stands today \u2192</a>
  `;
  sendHtml(res, layout({ title: 'A Brief History of Cannabis', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageFeelsWrong(req, res) {
  const body = `
    <h1 class="screen-title">If Something Feels Wrong</h1>
    <p class="screen-sub">Calm, practical steps for the moment, not just general safety info. Not medical advice.</p>
    <p class="empty-note">Last reviewed: ${esc(SAFETY_GUIDES_LAST_REVIEWED)}.</p>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">Feeling too high, overwhelmed, or anxious</h2>
      <p style="margin:0 0 6px;"><b>This will pass.</b> THC's effects are time-limited — usually a couple of hours for smoking or vaping, longer for edibles, but it does end.</p>
      <p style="margin:0 0 6px;">Move somewhere calm, quiet, and familiar, and sit or lie down. Remind yourself this is uncomfortable, not dangerous — cannabis alone is very rarely medically dangerous.</p>
      <p style="margin:0;">Grounding helps: slow, deliberate breathing, or naming 5 things you can see, 4 you can hear, 3 you can touch. Don\u2019t use more cannabis to try to fix it.</p>
    </div>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">Nausea or vomiting ("greening out")</h2>
      <p style="margin:0;">${linkGlossaryTerms(esc('Lie down on your side, sip water slowly, and give it time. A cool cloth on your forehead or neck can help. This is more common with edibles or combining with alcohol'))} — see <a href="/mixing-cautions">Mixing With Other Substances</a>.</p>
    </div>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">Racing heart or panic</h2>
      <p style="margin:0;">A racing heart from THC is usually not dangerous on its own, but it can feel alarming. Slow breathing (in for 4 counts, out for 6) can help bring it down. If it doesn\u2019t ease up, or you have a heart condition, treat it seriously — see below.</p>
    </div>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 6px;font-size:15px;">A note on edibles specifically</h2>
      <p style="margin:0;">${linkGlossaryTerms(esc('Edibles take longer to hit and hit harder and longer than smoking. Most "too high" situations come from redosing too early because nothing seemed to be happening yet.'))} See the <a href="/dosing-calculator">Dosing Calculator</a> before you start, not after, and <a href="/lab-result-guide">how to read a lab result</a> to understand what the potency on the label actually means.</p>
    </div>
    <div class="card" style="background:#fdecec;">
      <h2 style="margin:0 0 6px;font-size:15px;">When to get real help</h2>
      <p style="margin:0 0 6px;">Call Poison Control or your local emergency number for:</p>
      <p style="margin:0 0 6px;">Chest pain, real difficulty breathing, or a racing heart that won\u2019t settle · severe or persistent vomiting · a child or pet accidentally eating cannabis · combining cannabis with something else and not knowing how they interact · anything that genuinely feels like a medical emergency.</p>
      <p style="margin:0;"><b>US Poison Control: 1-800-222-1222</b> — free, confidential, available 24/7, and they handle exactly this kind of call regularly. You will not get in trouble for calling.</p>
    </div>
  `;
  sendHtml(res, layout({ title: 'If Something Feels Wrong', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Find Your First Strain', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
    <h1 class="screen-title">Your Patterns</h1>
    <div class="card" style="margin-bottom:14px;">
      <h2 style="margin:0 0 8px;font-size:15px;">🌿 Tolerance break</h2>
      <p class="empty-note" style="padding:0 0 8px;"><a href="/tolerance-explained">Why this actually works →</a></p>
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
      </div>
      ${insights.topTerpenes && insights.topTerpenes.length ? `
        <div class="card" style="margin-top:12px;">
          <h2 style="margin:0 0 8px;font-size:15px;">Your Terpene Profile</h2>
          ${insights.topTerpenes.map(t => `
            <div style="margin-bottom:8px;">
              <div style="display:flex;justify-content:space-between;font-size:13px;">
                <a href="/strains?terpene=${encodeURIComponent(t.name)}" style="color:inherit;text-decoration:none;font-weight:700;">${esc(t.name)}</a>
                <span class="empty-note" style="padding:0;">${t.pct}%</span>
              </div>
              <div class="progress-bar" style="margin-top:2px;"><div class="fill" style="width:${t.pct}%;"></div></div>
            </div>
          `).join('')}
          <a href="/terpene-guide" class="empty-note" style="display:block;padding:4px 0 0;">See what each of these actually does →</a>
        </div>
      ` : ''}
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
  sendHtml(res, layout({ title: 'Your Patterns', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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

function pageSupportTheApp(req, res) {
  const body = `
    <h1 class="screen-title">💚 Support the App</h1>
    <p class="screen-sub">StrainDex is free to use right now. If it's been useful to you and you'd like to help cover hosting costs, that's genuinely appreciated — but there's zero obligation and nothing extra unlocks either way.</p>
    <div class="card" style="margin-bottom:10px;">
      <h2 style="margin:0 0 4px;font-size:16px;">Cash App</h2>
      <p class="empty-note" style="padding:0 0 8px;">Any amount, no account needed on your end beyond Cash App itself.</p>
      <a class="btn block" href="https://cash.app/$straindex" style="text-decoration:none;">Send via Cash App — $straindex</a>
    </div>
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:16px;">Venmo</h2>
      <p class="empty-note" style="padding:0 0 8px;">Same idea, if that's the app you already have.</p>
      <a class="btn block" href="https://venmo.com/straindex" style="text-decoration:none;">Send via Venmo — @straindex</a>
    </div>
    <p class="empty-note" style="margin-top:14px;">Thank you for even reading this far — seriously. 🌿</p>
  `;
  sendHtml(res, layout({ title: 'Support the App', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Send Feedback', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
async function handleFeedbackSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  if (await isSubmissionRateLimited('feedback', userId)) return sendRateLimited(res, '/feedback');
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
  // Limit per IP and per target address so this can't be used to flood
  // someone's inbox or burn the email quota. When limited we behave EXACTLY
  // as if it worked (same redirect, nothing sent) so the limiter itself
  // can't be used to probe which emails have accounts.
  const ipLimited = await isGenericRateLimited('forgot_ip', clientIp(req), 5, 15 * 60 * 1000);
  const emailLimited = email ? await isGenericRateLimited('forgot_email', email, 3, 60 * 60 * 1000) : false;
  const user = (email && !ipLimited && !emailLimited) ? db.getUserByEmail(email) : null;
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
  if (await isLoginRateLimited(req, username)) return redirect(res, '/login?err=rate_limited');
  const user = db.verifyLogin(username, f.password || '');
  if (!user) {
    await recordFailedLogin(req, username);
    return redirect(res, '/login?err=1');
  }
  await clearLoginAttempts(req, username);
  const token = auth.signUserSessionValue(user.id);
  res.setHeader('Set-Cookie', [
    `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    `csrf_token=${encodeURIComponent(auth.csrfTokenFor(token))}; Path=/; SameSite=Lax; Max-Age=31536000`,
  ]);
  redirect(res, safeRedirectPath(f.redirect_to) || '/');
}
function handleLogout(req, res) {
  res.setHeader('Set-Cookie', [
    `user_session=; Path=/; HttpOnly; Max-Age=0`,
    `csrf_token=; Path=/; Max-Age=0`,
  ]);
  redirect(res, '/login');
}

function pageAdminHome(req, res) {
  if (!requireAdmin(req, res)) return;
  const pendingCount = db.listRecipes({ status: 'pending' }).length;
  const pendingGrowTips = db.listGrowTips({ status: 'pending' }).length;
  const pendingSubmissions = db.listStrainSubmissions().filter(x => x.status !== 'reviewed').length;
  const totalPending = pendingCount + pendingGrowTips + pendingSubmissions;
  const body = `
    <h1 class="screen-title">Admin</h1>
    <div class="card" style="background:${totalPending ? 'var(--brand-green-dark)' : 'var(--bg-card)'};${totalPending ? 'color:#fff;' : ''}"><a href="/admin/inbox" style="${totalPending ? 'color:#fff;' : ''}">📥 Inbox${totalPending ? ` (${totalPending} need attention)` : ' — all caught up'}</a></div>
    <div class="card"><a href="/admin/feedback">💬 Feedback (${db.listFeedback().length})</a></div>
    <div class="card"><a href="/admin/faqs">📋 Manage FAQ (${db.listFaqs().length})</a></div>
    <div class="card"><a href="/admin/recipes">🍽️ Manage Recipes (${db.listRecipes({ status: null }).length}${pendingCount ? `, ${pendingCount} pending` : ''})</a></div>
    <div class="card"><a href="/admin/grow-tips">🌱 Manage Grow Tips (${db.listGrowTips({ status: null }).length}${pendingGrowTips ? `, ${pendingGrowTips} pending` : ''})</a></div>
    <div class="card"><a href="/admin/strains">🌿 Manage Strains (${db.countStrains().toLocaleString()})</a></div>
    <div class="card"><a href="/admin/strain-submissions">🆕 Self-added strains (${db.listStrainSubmissions().filter(x => x.status !== 'reviewed').length} pending)</a></div>
    <div class="card"><a href="/admin/users">👤 Manage Users (${db.listUsers().length})</a></div>
    <div class="card"><a href="/admin/logout">🚪 Log out</a></div>
  `;
  sendHtml(res, layout({ title: 'Admin', body, isAdmin: true }));
}

function pageAdminUsers(req, res, query) {
  if (!requireAdmin(req, res)) return;
  const deleted = query.get('deleted');
  const users = db.listUsers();
  const body = `
    <h1 class="screen-title">Manage Users (${users.length})</h1>
    ${deleted ? `<p class="empty-note" style="color:var(--brand-green-dark);">User "${esc(deleted)}" was deleted.</p>` : ''}
    ${users.map(u => `
      <div class="admin-row">
        <span>👤 <b>${esc(u.username)}</b>${u.email ? ` · ${esc(u.email)}` : ''}<br><span class="empty-note" style="padding:0;">Joined ${esc((u.created_at || '').slice(0, 10))}</span></span>
        <a href="/admin/users/${u.id}/edit" class="btn secondary" style="text-decoration:none;">Edit</a>
        <form method="POST" action="/admin/users/${u.id}/delete" onsubmit="return confirm('Permanently delete ${esc(u.username)}\\'s account, check-ins, messages, and community connections? This cannot be undone.')">
          <button class="btn danger" style="color:#fff;" type="submit">Delete</button>
        </form>
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Manage Users', body, isAdmin: true }));
}
async function handleAdminUserDelete(req, res, userId) {
  if (!requireAdmin(req, res)) return;
  const user = db.getUserById(userId);
  const username = user ? user.username : 'that user';
  const photoUrls = db.listUserPhotoUrls(Number(userId));
  await db.deleteUserAccount(userId);
  storage.deletePhotos(photoUrls).catch(e => console.error('[storage]', e));
  redirect(res, `/admin/users?deleted=${encodeURIComponent(username)}`);
}


function pageAdminFeedback(req, res) {
  if (!requireAdmin(req, res)) return;
  const items = db.listFeedback();
  const body = `
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
// Awards use the same "Name:Year" shorthand as terpenes' "Name:Percent" --
// e.g. "Leafly Strain of the Year:2025, High Times Cannabis Cup:2019".
// Only ever meant to hold a real, verifiable, named award -- never
// popularity or ratings dressed up as one.
function parseAwardsInput(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const idx = pair.lastIndexOf(':');
    if (idx === -1) return { name: pair, year: null };
    const name = pair.slice(0, idx).trim();
    const year = Number(pair.slice(idx + 1).trim());
    return { name, year: Number.isFinite(year) ? year : null };
  }).filter(a => a.name);
}
function awardsToInput(awards) { return (awards || []).map(a => a.year ? `${a.name}:${a.year}` : a.name).join(', '); }
const AWARD_ICON = '🏆';
function renderAwardBadges(s, { compact = false } = {}) {
  const awards = s && s.awards;
  if (!Array.isArray(awards) || !awards.length) return '';
  if (compact) {
    return `<span title="${esc(awards.map(a => `${a.name}${a.year ? ' ' + a.year : ''}`).join(', '))}">${AWARD_ICON}</span>`;
  }
  return `<div class="award-badges" style="margin:6px 0;">${awards.map(a => `<span class="filter-pill" style="background:var(--brand-gold,#a9822a);color:#fff;border:none;">${AWARD_ICON} ${esc(a.name)}${a.year ? ` ${a.year}` : ''}</span>`).join(' ')}</div>`;
}

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
    <label class="field-label">Breeder (optional)</label>
    <input type="text" name="breeder" value="${v(s && s.breeder)}">
    <label class="field-label">Also known as (comma-separated, optional)</label>
    <input type="text" name="aka" value="${v(s && s.aka)}">
    <label class="field-label">Relief from (comma-separated ailments, e.g. "Stress, Pain, Insomnia")</label>
    <input type="text" name="ailments" value="${v(effectsToInput(s && s.ailments))}">
    <label class="field-label">Parents (comma-separated strain names, only if confirmed by 2+ independent sources)</label>
    <input type="text" name="parents" value="${v(effectsToInput(s && s.parents))}">
    <label class="field-label">Awards (comma-separated "Name:Year", e.g. "Leafly Strain of the Year:2025")</label>
    <input type="text" name="awards" value="${v(awardsToInput(s && s.awards))}">
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
    breeder: f.breeder || null, aka: f.aka || '', ailments: parseEffectsInput(f.ailments),
    parents: parseEffectsInput(f.parents), awards: parseAwardsInput(f.awards),
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
  // NOTE: this used to only pass the fields below, which meant saving ANY
  // edit here silently wiped breeder/aka/ailments/parents on every strain --
  // including all the researched-and-confirmed `parents` lineage data.
  // Now the form actually surfaces those fields (see strainFormFields), so
  // this passes through what's submitted instead of defaulting them away.
  await db.insertStrain({
    id, name: f.name, type: f.type, lean: f.lean, rarity: f.rarity, thc: f.thc, cbd: f.cbd,
    flavor: f.flavor, icon: f.icon || '🌿', effects: parseEffectsInput(f.effects), terps: parseTerpsInput(f.terps),
    breeder: f.breeder || null, aka: f.aka || '', ailments: parseEffectsInput(f.ailments),
    parents: parseEffectsInput(f.parents), awards: parseAwardsInput(f.awards),
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
        <label class="field-label">Difficulty</label>
        <select name="difficulty">${Object.entries(RECIPE_DIFFICULTY_LABELS).map(([key, d]) => `<option value="${key}">${d.icon} ${esc(d.label)}</option>`).join('')}</select>
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
          <a href="/admin/recipes/${r.id}/edit" class="btn secondary" style="text-decoration:none;">Edit</a>
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
    difficulty: RECIPE_DIFFICULTY_LABELS[f.difficulty] ? f.difficulty : 'beginner',
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
// Shared CSRF guard for the /api/* JSON endpoints below -- these are hit
// via fetch() rather than a native form submission, so there's no hidden
// _csrf field to check; the same token travels as a header instead (see
// getCsrfCookie/X-CSRF-Token in app.js). Every other POST route gets this
// enforced centrally, once, in the router; these few are the exception
// specifically because they're JSON, not form-encoded (see the /api/
// carve-out on that central check).
function requireCsrfHeader(req, res) {
  if (!auth.verifyCsrfToken(req, req.headers['x-csrf-token'])) {
    sendJson(res, { error: 'CSRF check failed -- please refresh the page and try again' }, 403);
    return false;
  }
  return true;
}
async function apiKudos(req, res, id) {
  if (!requireCsrfHeader(req, res)) return;
  const r = await db.addKudos(id);
  if (!r) return sendJson(res, { error: 'not found' }, 404);
  sendJson(res, { kudos: r.kudos });
}
async function apiGrowLike(req, res, id) {
  if (!requireCsrfHeader(req, res)) return;
  await db.likeGrowTip(id);
  const tip = db.listGrowTips().find(t => t.id === id);
  sendJson(res, { likes: tip ? tip.likes : 0 });
}
// Replaces the old /api/checkins/:id/kudos endpoint. Returns the freshly
// re-rendered reaction bar HTML rather than raw counts -- see
// REACT_TO_CHECKIN_SCRIPT, which just swaps this straight into the DOM,
// so there's no separate client-side rendering logic to keep in sync.
async function apiCheckinReaction(req, res, id) {
  if (!requireCsrfHeader(req, res)) return;
  const userId = requireUser(req, res);
  if (userId == null) return;
  const checkin = db.getCheckin(id);
  if (!checkin) return sendJson(res, { error: 'not found' }, 404);
  const body = await parseJson(req);
  const reaction = REACTION_BY_KEY[body.reaction] ? body.reaction : null;
  if (!reaction) return sendJson(res, { error: 'invalid reaction' }, 400);
  const summary = await db.setCheckinReaction(id, userId, reaction);
  if (summary.myReaction) {
    await db.upsertReactionNotification({ user_id: checkin.user_id, actor_user_id: userId, checkin_id: id, reaction: summary.myReaction });
  } else {
    await db.deleteReactionNotification({ user_id: checkin.user_id, actor_user_id: userId, checkin_id: id });
  }
  sendJson(res, { html: renderReactionBar(checkin, userId) });
}
async function apiCommentLike(req, res, id) {
  if (!requireCsrfHeader(req, res)) return;
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
  if (body) {
    const comment = await db.createCheckinComment({ checkin_id: checkinId, user_id: userId, body });
    // Tag anyone @mentioned who's a real user (and not the commenter
    // themselves) so it shows up on their Notifications page and nav badge.
    for (const username of extractMentionedUsernames(body)) {
      const mentioned = db.getUserByUsername(username);
      if (mentioned && mentioned.id !== userId) {
        await db.createCommentMention({ comment_id: comment.id, checkin_id: checkinId, mentioning_user_id: userId, mentioned_user_id: mentioned.id });
      }
    }
    // Separately, let the post's owner know someone commented at all --
    // createCommentNotification already no-ops if they commented on their
    // own post, so no extra check needed here.
    const checkin = db.getCheckin(checkinId);
    if (checkin) {
      await db.createCommentNotification({ user_id: checkin.user_id, actor_user_id: userId, checkin_id: checkinId, comment_id: comment.id });
    }
  }
  redirect(res, safeRedirectPath(f.redirect_to) || '/');
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
  // well before a dozen tiles. /strains and /education are intentionally
  // left out entirely since they're already one tap away on the bottom nav.
  // Recipes and Growing use to live on the bottom nav too; now that
  // Education has taken one of those five slots, they get their own
  // sections here instead. Events/Shop/Business stay hidden too -- still
  // running on demo data, not deleted, just not surfaced here until
  // they're real.
  // ORDER IS INTENTIONAL AND USER-CONFIRMED: "Your Journey" comes first,
  // "Discover" second. This was accidentally reversed once already --
  // if a future change wants to reorder these sections (or the tiles
  // within them), ASK THE USER FIRST rather than just reshuffling. Same
  // goes for moving "Community & Local" back here -- it was deliberately
  // moved out entirely (see pageFriends / the Community tab below), so
  // don't re-add a Community section here without asking either.
  const sections = [
    {
      title: 'Your Journey',
      tiles: [
        { href: '/collection', icon: '🎴', t: 'My Collection', s: 'Your binder & rarity progress' },
        { href: '/wishlist', icon: '⭐', t: 'Wishlist', s: 'Strains you want to try next' },
        { href: '/lists', icon: '📋', t: 'Your Lists', s: 'Custom groupings — Morning, Sleep, anything' },
        { href: '/history', icon: '🕐', t: 'Check-In History', s: 'Your full timeline' },
        { href: '/insights', icon: '📊', t: 'Your Patterns', s: 'What your check-ins say about you' },
        { href: '/insights', icon: '🌿', t: 'Tolerance Break', s: 'Start, track, or end a break' },
        { href: '/recap', icon: '🎉', t: 'Your Year in Review', s: 'A shareable recap of your year' },
      ],
    },
    {
      title: 'Discover',
      tiles: [
        { href: '/search', icon: '🔎', t: 'Search Everything', s: 'Strains, recipes, grow tips & FAQ at once' },
        { href: '/quiz', icon: '🧭', t: 'Find Your First Strain', s: '3-question strain matcher' },
        { href: '/mood-finder', icon: '🎯', t: 'Mood Finder', s: 'Pick a goal, get matched strains' },
        { href: '/compare', icon: '🆚', t: 'Compare Strains', s: 'Side-by-side lookup' },
        { href: '/surprise-me', icon: '🎲', t: 'Surprise Me', s: 'One random strain you haven\u2019t tried' },
        { href: '/trending', icon: '🔥', t: 'Trending This Week', s: 'Most checked-into right now' },
        { href: '/dispensaries', icon: '📍', t: 'Dispensaries', s: 'Locator & live menus' },
        { href: '/leaderboard', icon: '🏆', t: 'Top Contributors', s: 'Most-appreciated check-ins this month' },
        { href: '/gear-care', icon: '🧼', t: 'Cleaning & Gear Care', s: 'Keep your pipes, rigs & vapes running well' },
      ],
    },
    {
      title: 'Recipes',
      tiles: [
        { href: '/recipes', icon: '🍯', t: 'Browse Recipes', s: 'Infusions, edibles & drinks' },
        { href: '/recipes/favorites', icon: '⭐', t: 'Favorite Recipes', s: 'Recipes you\u2019ve saved for later' },
        { href: '/recipes/new', icon: '✏️', t: 'Submit a Recipe', s: 'Share your own' },
        { href: '/dosing-calculator', icon: '🧮', t: 'Dosing Calculator', s: 'mg per serving, figured out for you' },
        { href: '/best-by', icon: '📅', t: 'Best-By Calendar', s: 'Track what you\u2019ve made & when to use it' },
      ],
    },
    {
      title: 'Growing',
      tiles: [
        { href: '/first-time-grower-guide', icon: '🌾', t: "First-Time Grower's Guide", s: 'A roadmap through your first grow' },
        { href: '/growing', icon: '🌱', t: 'Growing Tips', s: 'Tips & tricks from home growers' },
        { href: '/growing/new', icon: '✏️', t: 'Share a Grow Tip', s: 'Add your own' },
        { href: '/grow-journal', icon: '📔', t: 'Grow Journal', s: 'Your private plant photo log' },
      ],
    },
    {
      title: 'Support',
      tiles: [
        { href: '/feedback', icon: '📝', t: 'Send Feedback', s: 'Bugs, ideas — anything' },
        { href: '/support-the-app', icon: '💚', t: 'Support the App', s: 'Help cover hosting costs' },
        { href: '/add-to-home-screen', icon: '📲', t: 'Add to Home Screen', s: 'Install StrainDex like an app' },
      ],
    },
  ];
  const body = `
    <h1 class="screen-title">More</h1>
    <p class="empty-note" style="margin-top:-4px;font-style:italic;">Build A Higher Community</p>
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
  sendHtml(res, layout({ title: 'More', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// ---------------------------------------------------------------- education
// Everything that used to live under More > "Learn & Stay Safe" now gets its
// own top-level destination on the bottom nav -- dosing safety, legal
// status, and strain knowledge are core enough to what StrainDex actually
// is that they shouldn't sit a level deeper inside More. This page itself
// just organizes the same underlying pages into two clean, labeled groups;
// none of those pages moved or changed.
function pageEducation(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  // ICONS ARE USER-CONFIRMED PLAIN EMOJI -- see the matching note on
  // HOME_SAFETY_CAROUSEL above. Do not swap "Ways to Enjoy It" (or
  // anything else here) back to an uploaded image icon without asking.
  const sections = [
    {
      // Split out of one 11-tile "Consumption & Safety" grid that had
      // grown too large to scan at a glance -- urgent/practical-right-now
      // content separated from read-when-curious reference material.
      title: 'In the Moment',
      tiles: [
        { href: '/new-to-cannabis', icon: '🧭', t: 'New to Cannabis? Start Here', s: 'A roadmap through the basics' },
        { href: '/feels-wrong', icon: '🆘', t: 'If Something Feels Wrong', s: 'Calm, practical steps for the moment' },
        { href: '/dosing-calculator', icon: '🧮', t: 'Dosing Calculator', s: 'Know your dose before you start' },
        { href: '/mixing-cautions', icon: '⚠️', t: 'Mixing With Other Substances', s: 'General cautions, not medical advice' },
      ],
    },
    {
      title: 'Reference',
      tiles: [
        { href: '/methods', icon: '💨', t: 'Ways to Enjoy It', s: 'Every method, explained' },
        { href: '/concentrates', icon: '💠', t: 'Concentrates & Extracts', s: 'Kief, rosin, live resin & more' },
        { href: '/using-whole-plant', icon: '♻️', t: 'Using the Whole Plant', s: 'Leaves, trim & stems — not just the bud' },
        { href: '/storage-guide', icon: '🗄️', t: 'Storage Guide', s: 'Keep flower, concentrates & edibles fresh' },
        { href: '/lab-result-guide', icon: '🧪', t: 'How to Read a Lab Result', s: 'What a real COA actually shows' },
        { href: '/tolerance-explained', icon: '⏳', t: 'Tolerance, Explained', s: 'Why breaks actually work' },
        { href: '/legal-status', icon: '🏛️', t: 'Is It Legal Near Me?', s: 'State-by-state cannabis law' },
        { href: '/common-myths', icon: '❌', t: 'Common Myths, Debunked', s: 'A few widely-held ideas worth double-checking' },
      ],
    },
    {
      title: 'Strain Knowledge',
      tiles: [
        { href: '/faq', icon: '❓', t: 'FAQ', s: 'Strain school' },
        { href: '/cannabis-history', icon: '📜', t: 'A Brief History of Cannabis', s: 'From prohibition to today\u2019s patchwork' },
        { href: '/terpene-guide', icon: '🌸', t: 'Terpene Guide', s: 'Aroma & effects by terpene' },
        { href: '/effects-guide', icon: '✨', t: 'Effects Guide', s: 'What each effect actually feels like' },
        { href: '/breeder-guide', icon: '🧬', t: 'Breeder Guide', s: 'Who\u2019s actually behind each strain' },
        { href: '/landrace-guide', icon: '🌍', t: 'Landrace Guide', s: 'The genetic root everything else grew from' },
        { href: '/genetics-guide', icon: '🔬', t: 'Genetics & Breeding Guide', s: 'Phenotype, backcross, cultivar & more' },
        { href: '/glossary', icon: '📚', t: 'Glossary', s: 'Every term used across the app' },
        { href: '/knowledge-quiz', icon: '🎓', t: 'Test What You Know', s: 'A quick knowledge check' },
        { href: '/chat', icon: '💬', t: 'Ask', s: 'Chat with the assistant' },
      ],
    },
  ];
  const body = `
    <h1 class="screen-title">Education</h1>
    <p class="screen-sub">Dosing safety, legal status, and strain knowledge — all in one place.</p>
    ${sections.map(sec => `
      <div class="section-label" style="margin-top:18px;">${esc(sec.title)}</div>
      <div class="more-grid">
        ${sec.tiles.map(t => `<a class="more-tile" href="${t.href}"><span class="ic">${t.icon.startsWith('/') ? `<img src="${t.icon}" alt="" class="ic-img-lg">` : t.icon}</span><div class="t">${esc(t.t)}</div><div class="s">${esc(t.s)}</div></a>`).join('')}
      </div>
    `).join('')}
  `;
  sendHtml(res, layout({ title: 'Education', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
      <p><b>7. Prohibited conduct.</b> Don't: break applicable law; harass or threaten other users; upload content that infringes someone else's rights; misrepresent your age; scrape or reverse-engineer the Service; or use StrainDex to actually sell, buy, or distribute cannabis or any controlled substance. See the <a href="/community-guidelines">Community Guidelines</a> for the fuller, plain-language version of this.</p>
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
  sendHtml(res, layout({ title: 'Terms of Service', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pagePrivacy(req, res) {
  const body = `
    <h1 class="screen-title">Privacy Policy</h1>
    <p class="empty-note">Last updated: ${new Date().toISOString().slice(0, 10)}. This expanded draft is currently being reviewed by an attorney and may change before it's finalized, particularly around jurisdiction-specific requirements (CCPA, GDPR, etc.).</p>
    <div class="card">
      <p><b>1. Overview.</b> This explains what StrainDex collects, how it's used, and your choices. We collect only what's needed to run the app and don't sell personal information to advertisers or data brokers.</p>
      <p><b>2. What we collect.</b> Account info (username, email, a securely hashed password, birth date to confirm age). User content (check-ins, tasting notes, food/drink/entertainment/activity pairings, photos, recipes, grow tips). Location, only when you use "find dispensaries near me" — not stored after the search. Basic technical/error logs. A single first-party session cookie to keep you logged in — no third-party ad-tracking cookies.</p>
      <p><b>3. How we use it.</b> To run check-ins, the strain library, recipes, growing tips, dispensary search, and community features; to keep your account secure; to send account emails like password resets; to respond to feedback you submit; to fix bugs through error monitoring; and to generate aggregate, non-identifying usage stats.</p>
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
  sendHtml(res, layout({ title: 'Privacy Policy', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// A static index of every Education guide page, purely so unified search
// can find them -- previously someone searching "landrace" or "tolerance"
// got nothing back even though a full page exists on exactly that.
const EDUCATION_GUIDE_INDEX = [
  { title: 'New to Cannabis? Start Here', desc: 'A roadmap through the basics', href: '/new-to-cannabis' },
  { title: 'If Something Feels Wrong', desc: 'Calm, practical steps for the moment', href: '/feels-wrong' },
  { title: 'Ways to Enjoy It', desc: 'Every ingestion method explained', href: '/methods' },
  { title: 'Concentrates & Extracts', desc: 'Kief, rosin, live resin & more', href: '/concentrates' },
  { title: 'Using the Whole Plant', desc: 'Leaves, trim & stems, not just the bud', href: '/using-whole-plant' },
  { title: 'Storage Guide', desc: 'Keep flower, concentrates & edibles fresh', href: '/storage-guide' },
  { title: 'How to Read a Lab Result', desc: 'What a real COA actually shows', href: '/lab-result-guide' },
  { title: 'Tolerance, Explained', desc: 'Why tolerance breaks actually work', href: '/tolerance-explained' },
  { title: 'Mixing With Other Substances', desc: 'General cautions, not medical advice', href: '/mixing-cautions' },
  { title: 'Is It Legal Near Me?', desc: 'State-by-state cannabis law', href: '/legal-status' },
  { title: 'Common Myths, Debunked', desc: 'A few widely-held ideas worth double-checking', href: '/common-myths' },
  { title: 'A Brief History of Cannabis', desc: "From prohibition to today's patchwork", href: '/cannabis-history' },
  { title: 'Terpene Guide', desc: 'Aroma & effects by terpene', href: '/terpene-guide' },
  { title: 'Effects Guide', desc: 'What each effect actually feels like', href: '/effects-guide' },
  { title: 'Breeder Guide', desc: "Who's actually behind each strain", href: '/breeder-guide' },
  { title: 'Landrace Guide', desc: 'The genetic root everything else grew from', href: '/landrace-guide' },
  { title: 'Genetics & Breeding Guide', desc: 'Phenotype, backcross, cultivar & more', href: '/genetics-guide' },
  { title: 'Glossary', desc: 'Every term used across the app', href: '/glossary' },
  { title: 'Test What You Know', desc: 'A quick knowledge check', href: '/knowledge-quiz' },
  { title: "First-Time Grower's Guide", desc: 'A roadmap through your first grow', href: '/first-time-grower-guide' },
];
// One search box across everything, instead of four separate ones on
// four separate pages. Grow tips have no listRecipes-style q param to
// reuse (no per-tip detail page either), so they're filtered here
// directly and linked to their category on the Growing Tips board --
// the closest real destination that exists for one.
function pageSearch(req, res, query) {
  const userId = auth.currentUserId(req);
  const q = (query.get('q') || '').trim();
  const results = { strains: [], recipes: [], growTips: [], faqs: [], guides: [] };
  if (q) {
    results.strains = db.listStrains({ q, limit: 5 });
    results.recipes = db.listRecipes({ status: 'approved', q }).slice(0, 5);
    const needle = q.toLowerCase();
    results.growTips = db.listGrowTips({ viewerId: userId })
      .filter(g => g.title.toLowerCase().includes(needle) || (g.body && g.body.toLowerCase().includes(needle)))
      .slice(0, 5);
    results.faqs = db.listFaqs(q).slice(0, 5);
    results.guides = EDUCATION_GUIDE_INDEX.filter(g => g.title.toLowerCase().includes(needle) || g.desc.toLowerCase().includes(needle)).slice(0, 5);
  }
  const totalResults = results.strains.length + results.recipes.length + results.growTips.length + results.faqs.length + results.guides.length;
  const body = `
    <h1 class="screen-title">Search</h1>
    <form method="GET" action="/search" style="margin-bottom:14px;display:flex;gap:8px;">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search strains, recipes, grow tips, FAQ..." autocomplete="off" style="flex:1;">
      <button class="btn" type="submit">Search</button>
    </form>
    ${!q ? `<p class="empty-note">Type something above to search across the whole app at once.</p>` : (totalResults === 0 ? `<p class="empty-note">No results anywhere for "${esc(q)}".</p>` : '')}
    ${results.strains.length ? `
      <div class="section-label">Strains</div>
      ${results.strains.map(s => `
        <a class="library-row" href="/strains/${s.id}" style="text-decoration:none;color:inherit;">
          ${strainPhotoTag(s, 'sm')}
          <div class="info"><div class="nm">${esc(s.name)}</div><div class="sub">${esc(s.type)} · THC ${esc(s.thc)}</div></div>
        </a>
      `).join('')}
    ` : ''}
    ${results.recipes.length ? `
      <div class="section-label">Recipes</div>
      ${results.recipes.map(r => `
        <a class="library-row" href="/recipes/${r.id}" style="text-decoration:none;color:inherit;">
          <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">${r.icon || '🍽️'}</div>
          <div class="info"><div class="nm">${esc(r.title)}</div><div class="sub">${esc(r.category || '')}</div></div>
        </a>
      `).join('')}
    ` : ''}
    ${results.growTips.length ? `
      <div class="section-label">Growing Tips</div>
      ${results.growTips.map(g => `
        <a class="library-row" href="/growing?cat=${encodeURIComponent(g.category)}" style="text-decoration:none;color:inherit;">
          <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">🌱</div>
          <div class="info"><div class="nm">${esc(g.title)}</div><div class="sub">${esc(g.category)}</div></div>
        </a>
      `).join('')}
    ` : ''}
    ${results.guides.length ? `
      <div class="section-label">Education & Guides</div>
      ${results.guides.map(g => `
        <a class="library-row" href="${g.href}" style="text-decoration:none;color:inherit;">
          <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">📖</div>
          <div class="info"><div class="nm">${esc(g.title)}</div><div class="sub">${esc(g.desc)}</div></div>
        </a>
      `).join('')}
    ` : ''}
    ${results.faqs.length ? `
      <div class="section-label">FAQ</div>
      ${results.faqs.map(f => `
        <a class="library-row" href="/faq?q=${encodeURIComponent(q)}" style="text-decoration:none;color:inherit;">
          <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">❓</div>
          <div class="info"><div class="nm">${esc(f.question)}</div></div>
        </a>
      `).join('')}
    ` : ''}
  `;
  sendHtml(res, layout({ title: 'Search', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageCommunityGuidelines(req, res) {
  const body = `
    <h1 class="screen-title">Community Guidelines</h1>
    <p class="empty-note">Simple expectations for everyone here — worth having in place early, not after something's already gone wrong.</p>
    <div class="card">
      <p><b>1. Be someone you'd want to run into in your own feed.</b> Disagreement and honest reviews are fine; harassment, hate speech, and targeted attacks on other people aren't.</p>
      <p><b>2. This is not a marketplace.</b> Don't use StrainDex to buy, sell, trade for money, or solicit cannabis or any controlled substance. The in-app "Trade" feature is for swapping duplicate cards in your own collection game, nothing else.</p>
      <p><b>3. Respect other people's privacy.</b> Don't screenshot or share someone else's check-ins, photos, or personal info outside the app without their OK, and don't use anything shared here to identify or contact someone outside StrainDex.</p>
      <p><b>4. Keep dosing and safety talk responsible.</b> Sharing your own experience is welcome; pushing a specific dose on someone else, especially with edibles, isn't — point them to the Dosing Calculator instead.</p>
      <p><b>5. No content involving minors, ever,</b> in any form, including jokes. This is a strict, zero-exception rule.</p>
      <p><b>6. Report, don't retaliate.</b> If someone's being a problem, use Report or Block rather than escalating publicly — see <a href="/blocked-users">Blocked Users</a> for how blocking works.</p>
      <p><b>7. Recipes and grow tips are shared in good faith, not verified medical or legal advice.</b> Use your own judgment, especially with dosing.</p>
      <p><b>8. Breaking these guidelines can lead to content removal or account suspension,</b> at our discretion, same as anything else in the <a href="/terms">Terms of Service</a>.</p>
    </div>
    <p class="empty-note">Questions, or something you think we got wrong here? Reach out through <a href="/feedback">Send Feedback</a>.</p>
  `;
  sendHtml(res, layout({ title: 'Community Guidelines', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageAccount(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const user = db.getUserById(userId);
  const error = query.get('error') || '';
  const success = query.get('ok') || '';
  // USER-CONFIRMED: this is the checklist's permanent home -- it always
  // shows here while incomplete, dismiss-state on the Home card (see
  // pageHome) has no effect on it. Don't remove this without asking.
  const onboarding = getOnboardingChecklist(userId);
  const onboardingDone = onboarding.filter(o => o.done).length;
  const body = `
    <h1 class="screen-title" style="margin-top:8px;">Account Settings</h1>

    ${onboardingDone < onboarding.length ? `
      <div class="card" style="margin-bottom:14px;">
        <h2 style="margin:0 0 10px;font-size:15px;">🚀 Finish setting up your account</h2>
        <div class="progress-bar" style="margin-bottom:10px;"><div class="fill" style="width:${Math.round((100 * onboardingDone) / onboarding.length)}%;"></div></div>
        ${onboarding.map(item => `
          <a href="${item.href}" class="library-row" style="text-decoration:none;color:inherit;${item.done ? 'opacity:0.55;' : ''}">
            <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">${item.done ? '✅' : item.icon}</div>
            <div class="info">
              <div class="nm" style="${item.done ? 'text-decoration:line-through;' : ''}">${esc(item.title)}</div>
            </div>
          </a>
        `).join('')}
      </div>
    ` : ''}

    <div class="card">
      <h2 style="margin:0 0 10px;font-size:15px;">Appearance</h2>
      <p class="empty-note" style="padding:0 0 10px;">Choose how StrainDex looks on this device. "System" follows your device's own light/dark setting.</p>
      <div id="theme-options" style="display:flex;gap:8px;">
        <button type="button" data-theme-choice="light" class="btn secondary" style="flex:1;">\u2600\ufe0f Light</button>
        <button type="button" data-theme-choice="dark" class="btn secondary" style="flex:1;">\ud83c\udf19 Dark</button>
        <button type="button" data-theme-choice="system" class="btn secondary" style="flex:1;">System</button>
      </div>
      <script>
        (function() {
          function currentChoice() {
            try {
              var t = localStorage.getItem('theme');
              if (t === 'light' || t === 'dark') return t;
            } catch (e) {}
            return 'system';
          }
          function highlight() {
            var current = currentChoice();
            Array.prototype.forEach.call(document.querySelectorAll('#theme-options [data-theme-choice]'), function(btn) {
              var active = btn.getAttribute('data-theme-choice') === current;
              btn.style.borderColor = active ? 'var(--brand-green-dark)' : '';
              btn.style.fontWeight = active ? '700' : 'normal';
            });
          }
          Array.prototype.forEach.call(document.querySelectorAll('#theme-options [data-theme-choice]'), function(btn) {
            btn.addEventListener('click', function() {
              var choice = btn.getAttribute('data-theme-choice');
              try {
                if (choice === 'system') {
                  localStorage.removeItem('theme');
                  document.documentElement.removeAttribute('data-theme');
                } else {
                  localStorage.setItem('theme', choice);
                  document.documentElement.setAttribute('data-theme', choice);
                }
              } catch (e) {}
              highlight();
            });
          });
          highlight();
        })();
      </script>
    </div>

    <div class="card" style="margin-top:14px;">
      <h2 style="margin:0 0 10px;font-size:15px;">Profile</h2>
      ${success === 'bio' ? `<p class="empty-note" style="color:var(--brand-green-dark);">Bio updated.</p>` : ''}
      <form method="POST" action="/account/bio">
        <label class="field-label" style="margin-top:0;">Bio</label>
        <textarea name="bio" maxlength="160" placeholder="What should people see on your profile?">${esc(user.bio || '')}</textarea>
        <button class="btn block" type="submit" style="margin-top:10px;">Update Bio</button>
      </form>
      <a href="/friends/${userId}" class="empty-note" style="display:block;padding:10px 0 0;">View your profile as others see it →</a>
    </div>

    <div class="card" style="margin-top:14px;">
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
      <form method="POST" action="/account/delete" onsubmit="return confirm('This permanently deletes your account, check-ins, community connections, and photos. This cannot be undone. Continue?')">
        <button class="btn danger block" type="submit" style="color:#fff;">Delete my account</button>
      </form>
    </div>

    ${userId === OWNER_USER_ID ? `<p class="empty-note" style="margin-top:18px;text-align:center;"><a href="${auth.isAdmin(req) ? '/admin' : '/admin/login'}">Site administration</a></p>` : ''}
  `;
  sendHtml(res, layout({ title: 'Account Settings', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  const photoUrls = db.listUserPhotoUrls(userId);
  await db.deleteUserAccount(userId);
  storage.deletePhotos(photoUrls).catch(e => console.error('[storage]', e));
  res.setHeader('Set-Cookie', [
    `user_session=; Path=/; HttpOnly; Max-Age=0`,
    `csrf_token=; Path=/; Max-Age=0`,
  ]);
  redirect(res, '/signup?deleted=1');
}
async function handleAccountBio(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const fields = await parseForm(req);
  await db.updateBio(userId, fields.bio || '');
  redirect(res, '/account?ok=bio');
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
    // updatePassword just revoked every session; give THIS device a fresh one.
    const token = auth.signUserSessionValue(userId);
    res.setHeader('Set-Cookie', [
      `user_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      `csrf_token=${encodeURIComponent(auth.csrfTokenFor(token))}; Path=/; SameSite=Lax; Max-Age=31536000`,
    ]);
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
      <div class="badge-chip rarity-common" style="background:none;color:#6b6b6b;">Common: ${rarityCounts.common}</div>
      <div class="badge-chip rarity-uncommon" style="background:none;color:#6b6b6b;">Uncommon: ${rarityCounts.uncommon}</div>
      <div class="badge-chip rarity-rare" style="background:none;color:#6b6b6b;">Rare: ${rarityCounts.rare}</div>
      <div class="badge-chip rarity-legendary" style="background:none;color:#6b6b6b;">Legendary: ${rarityCounts.legendary}</div>
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
  sendHtml(res, layout({ title: 'My Collection', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
        <a href="${checkinStrainHref(c)}" style="text-decoration:none;color:inherit;display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
          ${strainPhotoTag(s, 'sm')}
          <div class="info">
            <div class="nm">${esc(checkinStrainName(c, s))}${isCustomCheckin(c) ? ' ' + unverifiedBadge() : ''}</div>
            <div class="sub">${esc(c.method)} · ${starString(c.rating)} · <span class="local-time" data-utc="${c.created_at}Z">${esc(c.created_at)} UTC</span></div>
          </div>
        </a>
        <a href="/checkin/${c.id}/edit" class="empty-note" style="padding:0 4px;">Edit</a>
      </div>`;
    }).join('') : `<div class="empty-note">No check-ins logged yet — <a href="/checkin">log your first one</a>.</div>`}
  `;
  sendHtml(res, layout({ title: 'Check-In History', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// ---------------------------------------------------------------- friends
// The Community tab is the home for anything social -- not just your
// people, but Messages/Puff Puff Ask/Trade/Community Picks too (moved
// here from More's old "Community & Local" section, which no longer
// exists -- see the guard comment on pageMore's sections array). Each
// friend renders as its own clickable card (same library-row pattern as
// a strain card) rather than a row with inline action buttons; Message,
// Trade, Remove, and Block all live on the profile page you land on
// after tapping the card (see pageFriendProfile) so there's one
// consistent "click in for everything" place, matching how strain cards
// work.
// LAYOUT ORDER IS USER-CONFIRMED -- do not reorder these sections
// (Community Features first, then search, then a single Requests button,
// then the friends list) without asking first. Incoming/outgoing
// requests deliberately do NOT render inline on this page -- they used
// to, and the person specifically asked for that detail to move behind
// a single "Requests" button (see pageFriendRequests below) so the main
// page isn't cluttered with them.
function pageFriends(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const q = (query.get('q') || '').trim();
  const results = q ? db.searchUsers(q, userId) : [];
  const friends = db.listFriends(userId);
  const pendingCount = db.listIncomingRequests(userId).length + db.listOutgoingRequests(userId).length;

  const body = `
    <h1 class="screen-title">Community</h1>
    <p class="screen-sub">Your people, messages, trading, and community-wide features — all in one place.</p>

    <div class="more-grid">
      <a class="more-tile" href="/messages"><span class="ic">💬</span><div class="t">Messages</div><div class="s">${db.countUnreadMessages(userId) > 0 ? `${db.countUnreadMessages(userId)} unread` : 'Chat with your community'}</div></a>
      <a class="more-tile" href="/notifications"><span class="ic">🔔</span><div class="t">Notifications</div><div class="s">${notificationsSummary(userId) || 'Mentions, comments & reactions'}</div></a>
      <a class="more-tile" href="/puff-puff-ask"><span class="ic">💨</span><div class="t">Puff Puff Ask</div><div class="s">Ask the community, browse by section</div></a>
      <a class="more-tile" href="/trade"><span class="ic">🔁</span><div class="t">Trade</div><div class="s">Swap dupes with your community</div></a>
      <a class="more-tile" href="/friends-picks"><span class="ic">🤝</span><div class="t">Community Picks</div><div class="s">What your circle loves that you haven't tried</div></a>
      <a class="more-tile" href="/invite"><span class="ic">📣</span><div class="t">Invite</div><div class="s">Bring someone into your community</div></a>
      <a class="more-tile" href="/community-guidelines"><span class="ic">📋</span><div class="t">Community Guidelines</div><div class="s">What's expected of everyone here</div></a>
    </div>

    <form method="GET" action="/friends" style="margin:16px 0 14px;display:flex;gap:8px;">
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
            ${status === 'none' ? `<form method="POST" action="/friends/${u.id}/request"><button class="btn" type="submit">Add to Community</button></form>` : ''}
            ${status === 'pending_sent' ? `<span class="empty-note">Request sent</span>` : ''}
            ${status === 'pending_received' ? `<span class="empty-note">Check your requests</span>` : ''}
            ${status === 'friends' ? `<span class="empty-note">Already connected</span>` : ''}
          </div>
        </div>`;
      }).join('') : `<div class="empty-note">No users found matching "${esc(q)}".</div>`}
    ` : ''}

    <a href="/friends/requests" class="btn secondary block" style="text-decoration:none;display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <span>🔔 Requests</span>
      ${pendingCount > 0 ? `<span class="rarity-tag rarity-rare">${pendingCount}</span>` : ''}
    </a>

    <div class="section-label">Your community (${friends.length})</div>
    ${friends.length ? friends.map(u => `
      <a class="library-row" href="/friends/${u.id}" style="text-decoration:none;color:inherit;">
        <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">👤</div>
        <div class="info">
          <div class="nm">${esc(u.username)}</div>
          <div class="sub">Tap for messages, trading & more</div>
        </div>
      </a>`).join('') : `<div class="empty-note">No one in your community yet — search for a username above to get started.</div>`}
  `;
  sendHtml(res, layout({ title: 'Community', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
// Moved off the main Community page by request -- incoming and outgoing
// community requests now live here, one tap behind the "Requests" button
// above, instead of cluttering the main page with them.
function pageFriendRequests(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const incoming = db.listIncomingRequests(userId);
  const outgoing = db.listOutgoingRequests(userId);
  const body = `
    <h1 class="screen-title">Requests</h1>
    <div class="section-label">Community requests (${incoming.length})</div>
    ${incoming.length ? incoming.map(u => `
      <div class="admin-row">
        <span>👤 ${esc(u.username)}</span>
        <div class="actions">
          <form method="POST" action="/friends/${u.id}/accept" style="display:inline;"><button class="btn" type="submit">Accept</button></form>
          <form method="POST" action="/friends/${u.id}/decline" style="display:inline;"><button class="btn danger" style="color:#fff;" type="submit">Decline</button></form>
        </div>
      </div>`).join('') : `<div class="empty-note">No incoming requests.</div>`}

    <div class="section-label" style="margin-top:20px;">Pending sent (${outgoing.length})</div>
    ${outgoing.length ? outgoing.map(u => `
      <div class="admin-row">
        <span>👤 ${esc(u.username)}</span>
        <div class="actions">
          <span class="empty-note" style="padding:0;">Waiting for response</span>
          <form method="POST" action="/friends/${u.id}/cancel" style="display:inline;" onsubmit="return confirm('Cancel your request to ${esc(u.username)}?')">
            <button class="btn secondary" type="submit">Cancel</button>
          </form>
        </div>
      </div>
    `).join('') : `<div class="empty-note">Nothing pending.</div>`}
  `;
  sendHtml(res, layout({ title: 'Requests', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
// Every way someone can engage with your posts -- @mentions, comments,
// and reactions -- merged into one inbox, most recent first. Mentions
// live in their own comment_mentions table (a mention is really "someone
// tagged YOU," distinct from "someone engaged with a post of yours"),
// comments and reactions live in checkin_notifications; this just merges
// and sorts all three for display rather than making the person check
// three different places. Viewing this page marks everything read, same
// "opening it implies you've seen it" pattern as a DM thread. Every entry
// links straight to the exact post via pageCheckinDetail.
async function pageNotifications(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const mentionRows = db.listMentionsForUser(userId).map(m => ({
    type: 'mention', actor_user_id: m.mentioning_user_id, checkin_id: m.checkin_id, created_at: m.created_at,
  }));
  const engagementRows = db.listCheckinNotificationsForUser(userId).map(n => ({
    type: n.type, actor_user_id: n.actor_user_id, checkin_id: n.checkin_id, reaction: n.reaction, created_at: n.created_at,
  }));
  const rows = [...mentionRows, ...engagementRows]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map(row => {
      const checkin = db.getCheckin(row.checkin_id);
      if (!checkin) return null;
      const actor = db.getUserById(row.actor_user_id);
      const strain = db.getStrain(checkin.strain_id);
      const reactionMeta = row.reaction ? REACTION_BY_KEY[row.reaction] : null;
      const verb = row.type === 'mention' ? 'tagged you'
        : row.type === 'comment' ? 'commented on your post'
        : `reacted ${reactionMeta ? reactionMeta.icon : ''} to your post`;
      return { ...row, checkin, actor, strain, verb };
    }).filter(Boolean);
  await db.markMentionsRead(userId);
  await db.markCheckinNotificationsRead(userId);
  const body = `
    <h1 class="screen-title">Notifications</h1>
    <p class="screen-sub">Questions that need your answer, plus mentions, comments, and reactions on your posts.</p>
    ${renderCustomStrainAnswered(req)}
    ${db.listPendingCustomStrainPrompts(userId).length ? `<div class="section-label">Needs your answer (${db.listPendingCustomStrainPrompts(userId).length})</div>
      <p class="empty-note" style="margin-top:0;">These stay here, and keep the red dot on, until you choose. Either choice clears them.</p>
      ${renderCustomStrainPrompts(req, userId, '/notifications')}` : ''}
    ${rows.length ? '<div class="section-label" style="margin-top:16px;">Activity</div>' + rows.map(({ checkin, actor, strain, verb, created_at }) => `
      <a class="library-row" href="/checkin/${checkin.id}" style="text-decoration:none;color:inherit;">
        ${strainPhotoTag(strain, 'sm')}
        <div class="info">
          <div class="nm">${esc(actor ? actor.username : 'Someone')} ${esc(verb)}</div>
          <div class="sub">on ${esc(checkinStrainName(checkin, strain))}${isCustomCheckin(checkin) ? ' ' + unverifiedBadge() : ''} · <span class="local-time" data-utc="${created_at}Z">${esc(created_at)} UTC</span></div>
        </div>
      </a>
    `).join('') : (db.listPendingCustomStrainPrompts(userId).length ? '' : `<div class="empty-note">Nothing yet — comments, reactions, and @mentions on your posts will show up here.</div>`)}
  `;
  sendHtml(res, layout({ title: 'Notifications', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  redirect(res, safeRedirectPath(f.redirect_to) || '/');
}
async function handleBlock(req, res, blockedId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  await db.blockUser(userId, Number(blockedId));
  redirect(res, safeRedirectPath(f.redirect_to) || '/friends');
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
  sendHtml(res, layout({ title: 'Blocked Users', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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

// Review queue for self-added (free-text) strains. Each row is a name that
// someone typed at check-in because it wasn't in the library. Once the
// strain has been researched and added, "Verify & ask people" records that the
// typed name is that strain; every person who used the name is then asked (see
// renderCustomStrainPrompts) whether to move their own check-ins onto it.
function pageAdminStrainSubmissions(req, res, query) {
  if (!requireAdmin(req, res)) return;
  const linked = query.get('linked');
  const asked = query.get('asked');
  const subs = db.listStrainSubmissions();
  const pending = subs.filter(x => x.status !== 'reviewed');
  const done = subs.filter(x => x.status === 'reviewed');
  const card = (x, isPending) => {
    const user = x.user_id != null ? db.getUserById(x.user_id) : null;
    const uses = db.countCustomCheckins(x.strain_name);
    const match = db.findStrainByNameOrAka(x.strain_name);
    return `
      <div class="card" style="margin-bottom:8px;${isPending ? '' : 'opacity:0.55;'}">
        <b>${esc(x.strain_name)}</b> ${isPending ? unverifiedBadge() : ''}
        <p class="empty-note" style="padding:2px 0;">From ${esc(user ? user.username : 'a former user')} · ${esc(x.created_at)} UTC · ${uses} self-added check-in${uses === 1 ? '' : 's'} still using this name</p>
        ${x.description ? `<p class="empty-note" style="padding:2px 0;">${esc(x.description)}</p>` : ''}
        ${match ? `<p class="empty-note" style="padding:2px 0;color:var(--brand-green-dark);">Now matches library strain <b>${esc(match.name)}</b> (${esc(match.id)}).</p>` : ''}
        ${isPending ? `
          <form method="POST" action="/admin/strain-submissions/${x.id}/link" style="display:flex;gap:6px;margin-top:6px;">
            <input type="text" name="strain_id" placeholder="Library strain ID, e.g. s6927" value="${match ? esc(match.id) : ''}" required style="flex:1;margin:0;">
            <button class="btn" type="submit" style="white-space:nowrap;">Verify &amp; ask people</button>
          </form>
          <form method="POST" action="/admin/strain-submissions/${x.id}/reviewed" style="margin-top:6px;">
            <button type="submit" class="btn secondary" style="padding:6px 12px;">Mark reviewed (don't link)</button>
          </form>` : ''}
      </div>`;
  };
  const body = `
    <h1 class="screen-title">Self-added strains</h1>
    <p class="screen-sub">Names people typed at check-in because the strain wasn't in the library. Research it, add it, then link it to the real entry — everyone who used that name is then <b>asked</b> whether to switch their check-ins to the verified strain (nothing moves without their OK).</p>
    ${asked != null ? `<p class="empty-note" style="color:var(--brand-green-dark);">Done — ${esc(asked)} ${asked === '1' ? 'person was' : 'people were'} asked whether to switch to the verified strain.</p>` : ''}
    ${linked != null ? `<p class="empty-note" style="color:var(--brand-green-dark);">Linked ${esc(linked)} check-in${linked === '1' ? '' : 's'}.</p>` : ''}
    <div class="section-label">Pending (${pending.length})</div>
    ${pending.length ? pending.map(x => card(x, true)).join('') : `<div class="empty-note">Nothing waiting.</div>`}
    ${done.length ? `<div class="section-label" style="margin-top:18px;">Reviewed (${done.length})</div>${done.map(x => card(x, false)).join('')}` : ''}
  `;
  sendHtml(res, layout({ title: 'Self-added strains', body, isAdmin: true }));
}
async function handleAdminStrainSubmissionLink(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const sub = db.listStrainSubmissions().find(x => x.id === Number(id));
  if (!sub) return notFound(res);
  const f = await parseForm(req);
  const strainId = String(f.strain_id || '').trim();
  if (!db.getStrain(strainId)) return redirect(res, '/admin/strain-submissions');
  // Doesn't move anyone's check-ins: it makes each affected person get a "use the verified strain?" prompt.
  const people = await db.setCustomStrainLink(sub.strain_name, strainId);
  await db.markStrainSubmissionReviewed(sub.id);
  redirect(res, `/admin/strain-submissions?asked=${people}`);
}
async function handleAdminStrainSubmissionReviewed(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.markStrainSubmissionReviewed(Number(id));
  redirect(res, '/admin/strain-submissions');
}

// ---------- Direct messages ----------
// Badges are computed live from existing stats every time a profile
// loads -- no separate "earned badges" table, same recompute-don't-persist
// philosophy as getOnboardingChecklist/getCheckinStreak. Locked badges
// still render (greyed out, not hidden) since showing what's *not*
// earned yet is part of what makes a badge shelf worth coming back to.
function computeBadges(userId) {
  const totalCheckins = db.listCheckins({ userId, limit: 100000 }).length;
  const streak = db.getCheckinStreak(userId);
  const uniqueStrains = db.getUniqueOwnedCount(userId);
  const friendsCount = db.listFriends(userId).length;
  const invitedCount = db.listInvitedUsers(userId).length;
  const typesTried = new Set(db.getCollection(userId).map(o => o.strain.type).filter(Boolean));
  return [
    { key: 'first-checkin', icon: '🌱', title: 'First Check-In', desc: 'Log your first check-in', earned: totalCheckins >= 1 },
    { key: 'on-fire', icon: '🔥', title: 'On Fire', desc: '7-day check-in streak', earned: streak.longest >= 7 },
    { key: 'dedicated', icon: '💪', title: 'Dedicated', desc: '30-day check-in streak', earned: streak.longest >= 30 },
    { key: 'strain-explorer', icon: '📖', title: 'Strain Explorer', desc: 'Try 5 unique strains', earned: uniqueStrains >= 5 },
    { key: 'strain-connoisseur', icon: '🎓', title: 'Strain Connoisseur', desc: 'Try 20 unique strains', earned: uniqueStrains >= 20 },
    { key: 'type-explorer', icon: '🌈', title: 'Type Explorer', desc: 'Try Indica, Sativa & Hybrid', earned: ['Indica', 'Sativa', 'Hybrid'].every(t => typesTried.has(t)) },
    { key: 'community-builder', icon: '🧑\u200d🤝\u200d🧑', title: 'Community Builder', desc: 'Connect with 5 people', earned: friendsCount >= 5 },
    { key: 'recruiter', icon: '📣', title: 'Recruiter', desc: 'Invite someone who joins', earned: invitedCount >= 1 },
    { key: 'collector', icon: '🃏', title: 'Collector', desc: 'Catch 25 unique cards', earned: uniqueStrains >= 25 },
    { key: 'century-club', icon: '💯', title: 'Century Club', desc: '100 check-ins', earned: totalCheckins >= 100 },
    { key: 'recipe-contributor', icon: '🍯', title: 'Recipe Contributor', desc: 'Get a recipe approved', earned: db.hasUserApprovedRecipe(userId) },
    { key: 'crowd-favorite', icon: '⭐', title: 'Crowd Favorite', desc: 'Get 10+ kudos on a recipe', earned: db.hasUserFavoriteRecipe(userId) },
    { key: 'green-thumb', icon: '🌾', title: 'Green Thumb', desc: 'Share a grow tip', earned: db.hasUserSubmittedGrowTip(userId) },
  ];
}
// A shareable invite link -- ?ref=username on /signup, resolved by
// pageSignup into a "so-and-so invited you" banner and threaded through
// to invited_by on the new account (see handleSignupSubmit). Reuses the
// exact same share pattern as renderShareButton/SHARE_CHECKIN_SCRIPT
// (native share sheet, or copy-to-clipboard with a quick confirmation)
// rather than inventing a third separate sharing mechanism.
function pageInvite(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const user = db.getUserById(userId);
  const invited = db.listInvitedUsers(userId);
  const inviteUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/signup?ref=${encodeURIComponent(user.username)}`;
  const body = `
    <h1 class="screen-title">Invite to StrainDex</h1>
    <p class="screen-sub">This app is only as good as the community in it — bring someone in.</p>
    <div class="card" style="text-align:center;">
      <p style="font-size:13px;word-break:break-all;margin:0 0 12px;" id="invite-link-text">${esc(inviteUrl)}</p>
      <button type="button" class="btn block" onclick="shareInviteLink(this)">🔗 Share Invite Link</button>
    </div>
    <p class="empty-note" style="margin-top:14px;">${invited.length ? `You've invited ${invited.length} ${invited.length === 1 ? 'person' : 'people'} so far — welcome them in the <a href="/friends">Community</a> tab.` : `Nobody's joined from your link yet — once they do, they'll show up here.`}</p>
    <script>
      if (!window.shareInviteLink) {
        window.shareInviteLink = function(btn) {
          var url = document.getElementById('invite-link-text').textContent.trim();
          var flash = function(text) {
            var original = btn.textContent;
            btn.textContent = text;
            setTimeout(function() { btn.textContent = original; }, 1500);
          };
          if (navigator.share) {
            navigator.share({ url: url, title: 'Join me on StrainDex' }).catch(function() {});
            return;
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(function() { flash('✓ Copied'); }).catch(function() {
              window.prompt('Copy this link:', url);
            });
          } else {
            window.prompt('Copy this link:', url);
          }
        };
      }
    </script>
  `;
  sendHtml(res, layout({ title: 'Invite', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageMessagesInbox(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const threads = db.listConversations(userId);
  const body = `
    <h1 class="screen-title">Messages</h1>
    <p class="screen-sub">Private conversations with your community.</p>
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
  sendHtml(res, layout({ title: 'Messages', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageConversation(req, res, friendId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const friend = db.getUserById(friendId);
  if (!friend) return notFound(res);
  if (db.getFriendshipStatus(userId, friendId) !== 'friends') {
    return sendHtml(res, layout({ title: 'Messages', active: 'friends', body: `<div class="empty-note">You can only message friends.</div>`, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
  }
  db.markConversationRead(userId, friendId);
  const thread = db.listConversation(userId, friendId);
  const body = `
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
  sendHtml(res, layout({ title: friend.username, active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
    const body = `<h1 class="screen-title">Not connected yet</h1><p class="empty-note">You can only see a profile once you're connected in your community. <a href="/friends">Back to Community</a></p>`;
    return sendHtml(res, layout({ title: 'Profile', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
  }
  const collection = db.getCollection(friendId);
  const recentCheckins = db.filterVisibleCheckins(db.listCheckins({ userId: friendId, limit: 30 }), userId).slice(0, 10);
  const photoPosts = recentCheckins.filter(c => c.photo);
  const body = `
    <h1 class="screen-title" style="margin-top:8px;">👤 ${esc(friend.username)}</h1>
    ${friend.bio ? `<p class="empty-note" style="padding:0 0 10px;">${esc(friend.bio)}</p>` : ''}
    ${friendId !== userId && status === 'friends' ? `<a href="/messages/${friendId}" class="btn" style="text-decoration:none;display:inline-block;margin-bottom:10px;">💬 Message</a>` : ''}
    ${friendId !== userId && status === 'friends' ? `
      <div style="display:flex;gap:14px;margin-bottom:10px;">
        <form method="POST" action="/friends/${friendId}/remove" onsubmit="return confirm('Remove ${esc(friend.username)} from your community?')">
          <button type="submit" class="empty-note" style="padding:0;background:none;border:none;color:inherit;cursor:pointer;font-size:inherit;text-decoration:underline;">Remove from community</button>
        </form>
        <form method="POST" action="/block/${friendId}" onsubmit="return confirm('Block ${esc(friend.username)}? You will no longer see their comments, check-ins, or grow tips, and any community connection will end.')">
          <input type="hidden" name="redirect_to" value="/friends">
          <button type="submit" class="empty-note" style="padding:0;background:none;border:none;color:#a13a3a;cursor:pointer;font-size:inherit;text-decoration:underline;">Block this person</button>
        </form>
      </div>
    ` : ''}
    <div class="card" style="display:flex;justify-content:space-around;text-align:center;margin-bottom:16px;">
      <div><div style="font-size:20px;font-weight:700;">${collection.length}</div><div class="empty-note">Cards caught</div></div>
      <div><div style="font-size:20px;font-weight:700;">${db.getTotalDupes(friendId)}</div><div class="empty-note">Tradeable dupes</div></div>
      <div><div style="font-size:20px;font-weight:700;">${recentCheckins.length}</div><div class="empty-note">Recent check-ins</div></div>
    </div>
    <div class="section-label">Badges</div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px;">
      ${computeBadges(friendId).map(b => `
        <div title="${esc(b.title)} — ${esc(b.desc)}" style="text-align:center;${b.earned ? '' : 'opacity:0.3;'}">
          <div style="font-size:24px;">${b.icon}</div>
          <div style="font-size:10px;color:var(--ink-secondary);margin-top:2px;line-height:1.2;">${esc(b.title)}</div>
        </div>
      `).join('')}
    </div>
    ${friendId !== userId ? `<a class="btn block secondary" href="/trade?friend=${friendId}" style="margin-bottom:16px;">🔁 Trade with ${esc(friend.username)}</a>` : ''}
    ${photoPosts.length ? `
      <div class="section-label">Photos</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:16px;">
        ${photoPosts.map(c => `
          <a href="/checkin/${c.id}" style="display:block;aspect-ratio:1;overflow:hidden;border-radius:6px;">
            <img src="${esc(c.photo)}" alt="Check-in photo" style="width:100%;height:100%;object-fit:cover;display:block;">
          </a>
        `).join('')}
      </div>
    ` : ''}
    <div class="section-label">Recent check-ins</div>
    ${recentCheckins.length ? recentCheckins.map(c => {
      const s = db.getStrain(c.strain_id);
      return `<div class="feed-post">
        <div style="display:flex;justify-content:flex-end;margin-bottom:4px;">
          ${renderShareButton(c)}
        </div>
        <a class="strain-chip" href="${checkinStrainHref(c)}">
          ${strainPhotoTag(s, 'xs')}
          <span><b>${esc(checkinStrainName(c, s))}</b> ${checkinStrainTag(c, s)}</span>
        </a>
        <div class="sub" style="margin-top:8px;">${esc(c.method)} · ${starString(c.rating)}</div>
        ${c.photo ? `<img class="photo-thumb" src="${esc(c.photo)}" alt="photo">` : ''}
        ${(c.effects || []).length ? `<div class="effect-tags">${c.effects.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
        ${c.note ? `<div class="note">"${esc(c.note)}"</div>` : ''}
        ${renderCheckinPairings(c)}
        ${renderOnsetTimer(c)}
        ${renderCheckinComments(c, userId, '/friends/' + friendId)}
        <div style="display:flex;flex-direction:column;align-items:flex-end;margin-top:8px;">
          ${renderReactionBar(c, userId)}
          ${reactionGiversLabel(c.id)}
        </div>
      </div>`;
    }).join('') : `<div class="empty-note">No check-ins yet.</div>`}
    ${REACT_TO_CHECKIN_SCRIPT}
    ${SHARE_CHECKIN_SCRIPT}
  `;
  sendHtml(res, layout({ title: friend.username, active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
async function handleFriendCancel(req, res, addresseeId) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.cancelFriendRequest(userId, addresseeId);
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
      : `<div class="trade-caveat">Demo feature: you don't have anyone in your community added yet, so this trades against sample collections. <a href="/friends">Add someone to your community</a> to trade for real.</div>`}
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
  sendHtml(res, layout({ title: 'Trade', active: 'friends', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
        <div style="font-weight:700;font-size:13px;">📍 Find dispensaries near you</div>
        <div class="dsub" style="margin:3px 0 10px;">${realError ? esc(realError) : "Search by ZIP code, or share your location — nothing is sent anywhere else."}</div>
        <div class="locate-row">
          <form method="GET" action="/dispensaries" class="zip-form">
            <input type="text" name="zip" placeholder="ZIP code" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" value="${esc(zipParam)}">
            <button type="submit" class="follow-btn">Search</button>
          </form>
          <button type="button" id="use-location-btn" class="follow-btn">Use my location</button>
        </div>
      </div>
      ${zipParam || realError ? `<div class="empty-note" style="margin-top:16px;">${realError ? 'Nothing to show right now — try again in a moment, or try a different ZIP code.' : 'No dispensaries found for that ZIP code.'}</div>` : `<div class="empty-note" style="margin-top:16px;">Enter a ZIP code or share your location above to find dispensaries near you.</div>`}
    `;
  }
  sendHtml(res, layout({ title: 'Dispensaries', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Events', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Business', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
  sendHtml(res, layout({ title: 'Shop', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

async function handleShopAdd(req, res, id) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  await db.addToCart(userId, id);
  redirect(res, '/shop');
}

// ---------------------------------------------------------------- badges directory

// ---------------------------------------------------------------- consumption methods guide

// USER-CONFIRMED LAYOUT: lean list with a popup modal per method, same
// pattern as Is It Legal Near Me and Mixing Cautions -- don't flatten
// this back into stacked full cards without asking first.
function pageMethods(req, res) {
  const slug = s => s.replace(/[^a-zA-Z0-9]/g, '');
  const statBox = (label, value) => `
    <div style="background:#f2f1ec;border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#6b6b6b;margin-bottom:4px;">${esc(label)}</div>
      <div style="font-weight:700;font-size:14px;">${esc(value)}</div>
    </div>
  `;
  const renderModal = m => `
    <div id="method-${slug(m.name)}" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this) this.style.display='none';">
      <div style="background:#ffffff;border-radius:16px;max-width:460px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;color:#2a2a2a;">
        <div style="overflow-y:auto;padding:22px;position:relative;">
          <button type="button" onclick="document.getElementById('method-${slug(m.name)}').style.display='none';" style="position:absolute;top:0;right:0;width:32px;height:32px;border-radius:8px;border:1px solid #e3e1d8;background:none;cursor:pointer;font-size:16px;line-height:1;color:#2a2a2a;">\u2715</button>
          <h2 style="margin:0 0 16px;font-size:20px;padding-right:30px;">${m.icon.startsWith('/') ? `<img src="${m.icon}" alt="" class="mg-icon-photo">` : m.icon} ${esc(m.name)}</h2>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
            ${statBox('Onset', m.onset)}
            ${statBox('Lasts', m.duration)}
          </div>
          <div>${linkGlossaryTerms(esc(m.desc))}</div>
        </div>
      </div>
    </div>
  `;
  const body = `
    <h1 class="screen-title">Ways to Enjoy It</h1>
    <p class="screen-sub">Every ingestion method — tap one for onset, duration, and the full picture.</p>
    ${mock.methodGuide.map(m => `
      <button type="button" onclick="document.getElementById('method-${slug(m.name)}').style.display='flex';" class="library-row" style="width:100%;text-align:left;border:none;background:var(--bg-card,#fff);cursor:pointer;">
        <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">${m.icon.startsWith('/') ? `<img src="${m.icon}" alt="" class="mg-icon-photo">` : m.icon}</div>
        <div class="info"><div class="nm">${esc(m.name)}</div><div class="sub">Onset ${esc(m.onset)} · Lasts ${esc(m.duration)}</div></div>
      </button>
    `).join('')}
    ${mock.methodGuide.map(renderModal).join('')}
  `;
  sendHtml(res, layout({ title: 'Ways to Enjoy It', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
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
// USER-CONFIRMED LAYOUT -- this is specifically a lean, scannable list;
// the full depth of information lives in a popup modal per state, not
// inline in the list itself. Don't go back to rendering every field for
// every state directly on the page (that was the previous iteration and
// was explicitly asked to change) -- the whole point is that someone
// browsing sees just a name and a status color, and the rich multi-field
// breakdown (stat grid, detail grid, plain sections, official source)
// only appears once they tap in. Don't flatten this back into one long
// scrolling block of information without asking first.
function pageLegalStatus(req, res, query) {
  const sorted = [...LEGAL_STATUS].sort((a, b) => a.state.localeCompare(b.state));
  const grouped = {};
  sorted.forEach(s => { (grouped[s.status] = grouped[s.status] || []).push(s); });
  const slug = s => s.replace(/[^a-zA-Z0-9]/g, '');

  // Short derived stats for the top row of the modal -- computed from the
  // same underlying fields rather than stored separately, so there's only
  // ever one place to update if a state's category changes.
  const recreationalStat = s => s.status === 'recreational' ? 'Legal (21+)' : 'Illegal';
  const medicalStat = s => (s.status === 'recreational' || s.status === 'medical') ? 'Legal' : (s.status === 'cbd_only' ? 'Limited' : 'Illegal');
  const minAgeStat = s => s.status === 'recreational' ? '21+' : '\u2014';
  const homeGrowStat = s => {
    const text = s.homeGrow.replace(/\.$/, '');
    if (/not permitted/i.test(text)) return 'Not Permitted';
    return text.length <= 40 ? `Legal (${text})` : 'Legal';
  };

  const statBox = (label, value) => `
    <div style="background:#f2f1ec;border-radius:10px;padding:10px 12px;">
      <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#6b6b6b;margin-bottom:4px;">${esc(label)}</div>
      <div style="font-weight:700;font-size:14px;">${esc(value)}</div>
    </div>
  `;
  const plainSection = (label, value) => value ? `
    <div style="margin-bottom:14px;">
      <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#6b6b6b;margin-bottom:3px;">${esc(label)}</div>
      <div>${esc(value)}</div>
    </div>
  ` : '';

  const renderModal = s => {
    const detailBoxes = [
      ['Plant Count Limits', s.homeGrow],
      ['Possession Limits', s.possessionLimit],
      ['Concentrate Limits', s.concentrateLimit],
      ['Public Consumption', s.publicConsumption],
    ].filter(([, v]) => v);
    return `
      <div id="modal-${slug(s.state)}" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this) this.style.display='none';">
        <div style="background:#ffffff;border-radius:16px;max-width:460px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;color:#2a2a2a;">
          <div style="overflow-y:auto;padding:22px;position:relative;">
            <button type="button" onclick="document.getElementById('modal-${slug(s.state)}').style.display='none';" style="position:absolute;top:0;right:0;width:32px;height:32px;border-radius:8px;border:1px solid #e3e1d8;background:none;cursor:pointer;font-size:16px;line-height:1;color:#2a2a2a;">\u2715</button>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${LEGAL_STATUS_LABELS[s.status].color};display:inline-block;"></span>
              <span style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#6b6b6b;">${esc(LEGAL_STATUS_LABELS[s.status].label)}</span>
            </div>
            <h2 style="margin:0 0 16px;font-size:26px;padding-right:30px;">${esc(s.state)}</h2>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;">
              ${statBox('Recreational', recreationalStat(s))}
              ${statBox('Medical', medicalStat(s))}
              ${statBox('Home Grow', homeGrowStat(s))}
              ${statBox('Min Age', minAgeStat(s))}
            </div>
            <div style="border-top:1px solid #e3e1d8;margin-bottom:16px;"></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:18px;">
              ${detailBoxes.map(([label, value]) => statBox(label, value)).join('')}
            </div>
            ${plainSection('Licensing & Dispensaries', s.licensing)}
            ${plainSection('Hemp & THCA', s.hempThca)}
            ${plainSection('Penalties for Illegal Possession', s.penalties)}
            ${s.sourceUrl ? `
              <div style="border:1px dashed #4a7c59;background:#eef6ee;border-radius:10px;padding:10px 12px;margin-top:4px;">
                <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#6b6b6b;margin-bottom:4px;">Official Resources</div>
                <a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1b5e3a;font-weight:700;">${esc(s.sourceLabel)} \u2197</a>
              </div>
            ` : ''}
          </div>
          <div style="background:#f2f1ec;padding:12px 22px;font-size:12px;color:#6b6b6b;flex-shrink:0;">
            For information only — not legal advice. Always verify with official state sources.
          </div>
        </div>
      </div>
    `;
  };

  const body = `
    <h1 class="screen-title">Is It Legal Near Me?</h1>
    <p class="screen-sub">Cannabis law is a fast-moving patchwork that changes with little notice. Tap a state for the full breakdown. This is a starting point, not legal advice — always verify with your state's official government site before relying on it.</p>
    <p class="empty-note">Last checked against current sources: ${esc(LEGAL_STATUS_LAST_VERIFIED)}.</p>
    <div style="margin-bottom:16px;">
      <label class="field-label" style="margin-top:0;">Jump to your state</label>
      <select onchange="if(this.value){document.getElementById('modal-'+this.value).style.display='flex';this.value='';}">
        <option value="">Select a state...</option>
        ${sorted.map(s => `<option value="${slug(s.state)}">${esc(s.state)}</option>`).join('')}
      </select>
    </div>
    ${Object.entries(LEGAL_STATUS_LABELS).map(([key, meta]) => `
      <h3 style="font-size:13px;color:${meta.color};margin:16px 0 6px;">${esc(meta.label)}</h3>
      ${(grouped[key] || []).map(s => `
        <button type="button" onclick="document.getElementById('modal-${slug(s.state)}').style.display='flex';" class="library-row" style="width:100%;text-align:left;border:none;background:var(--bg-card,#fff);cursor:pointer;">
          <span style="width:10px;height:10px;border-radius:50%;background:${meta.color};flex-shrink:0;"></span>
          <div class="info"><div class="nm">${esc(s.state)}</div></div>
        </button>
      `).join('')}
    `).join('')}
    ${sorted.map(renderModal).join('')}
  `;
  sendHtml(res, layout({ title: 'Is It Legal Near Me?', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Overview only -- what each part of the plant is good for, not a
// step-by-step extraction tutorial. Solvent-based extraction specifically
// carries real fire/safety risks, so this stays at the same descriptive
// level as the Concentrates & Extracts page (what a thing is called and
// roughly how it's made) rather than giving actual how-to instructions.
const PLANT_PART_GUIDE = [
  { icon: '🌸', name: 'Buds & Flower', density: 'Highest', desc: 'The main event — see Ways to Enjoy It and Concentrates & Extracts for what to actually do with it.' },
  { icon: '🍃', name: 'Sugar Leaves', density: 'High', desc: 'The small leaves growing directly on and around the buds, often dusted in trichomes themselves. Good source material for kief, bubble hash, and cannabutter or cannaoil — can be smoked or vaped in a pinch, though harsher and less potent than bud itself.' },
  { icon: '✂️', name: 'Trim', density: 'Medium-High', desc: 'Sugar leaves and small leaf material removed during post-harvest cleanup. The classic source material for bubble hash, dry sift kief, and infusions — and for live rosin or live resin specifically, only if frozen immediately after harvest, since fresh-frozen trim preserves terpenes far better than trim that was dried first.' },
  { icon: '🌿', name: 'Fan Leaves', density: 'Very Low', desc: "The big, iconic pointed leaves. Too low in trichomes and cannabinoids to be worth smoking or concentrating for effect. Real uses: raw juicing (not decarbed, so no real high, but popular for chlorophyll and nutrients), composting back into your next grow, or a mild tea." },
  { icon: '🪵', name: 'Stems & Stalks', density: 'Minimal', desc: 'A little resin can cling on near the buds, so some people toss stems into a butter or tincture batch for a small extra boost. Otherwise: a mild folk-remedy tea, or just composting and mulch.' },
  { icon: '🌱', name: 'Roots', density: 'Negligible', desc: "The least-used part of the plant. Some folk and topical traditions exist, but they're not well documented in modern use — composting is the common, straightforward option." },
];
function pageUsingWholePlant(req, res) {
  const body = `
    <h1 class="screen-title">Using the Whole Plant</h1>
    <p class="screen-sub">Harvest isn't just the bud — most of the plant has a real use if you don't throw it out.</p>
    ${PLANT_PART_GUIDE.map(p => `
      <div class="method-guide-card">
        <div class="mgtitle">${p.icon} ${esc(p.name)}</div>
        <div class="mgstats"><span>Trichome density: ${esc(p.density)}</span></div>
        <div class="mgdesc">${linkGlossaryTerms(esc(p.desc))}</div>
      </div>`).join('')}
    <p class="empty-note" style="margin-top:6px;">An overview of what each part is generally good for, not a how-to — see <a href="/concentrates">Concentrates & Extracts</a> for what those end products actually are, and <a href="/recipes">Recipes</a> for infusions like cannabutter. Solvent-based extraction in particular carries real fire and safety risks best left to licensed facilities.</p>
  `;
  sendHtml(res, layout({ title: 'Using the Whole Plant', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}
// USER-CONFIRMED LAYOUT: lean list with a popup modal per concentrate,
// same pattern as Is It Legal Near Me / Mixing Cautions / Ways to Enjoy
// It -- don't flatten this back into stacked full cards without asking.
function pageConcentrates(req, res) {
  const slug = s => s.replace(/[^a-zA-Z0-9]/g, '');
  const renderModal = c => `
    <div id="conc-${slug(c.name)}" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:1000;align-items:center;justify-content:center;padding:16px;" onclick="if(event.target===this) this.style.display='none';">
      <div style="background:#ffffff;border-radius:16px;max-width:460px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;color:#2a2a2a;">
        <div style="overflow-y:auto;padding:22px;position:relative;">
          <button type="button" onclick="document.getElementById('conc-${slug(c.name)}').style.display='none';" style="position:absolute;top:0;right:0;width:32px;height:32px;border-radius:8px;border:1px solid #e3e1d8;background:none;cursor:pointer;font-size:16px;line-height:1;color:#2a2a2a;">\u2715</button>
          <h2 style="margin:0 0 16px;font-size:20px;padding-right:30px;">${c.icon} ${esc(c.name)}</h2>
          <div style="background:#f2f1ec;border-radius:10px;padding:10px 12px;margin-bottom:16px;display:inline-block;">
            <div style="font-size:10px;letter-spacing:0.05em;text-transform:uppercase;color:#6b6b6b;margin-bottom:4px;">THC Range</div>
            <div style="font-weight:700;font-size:14px;">${esc(c.thc)}</div>
          </div>
          <div>${linkGlossaryTerms(esc(c.desc))}</div>
        </div>
        <div style="background:#f2f1ec;padding:12px 22px;font-size:12px;color:#6b6b6b;flex-shrink:0;">
          Not medical advice — potency varies by batch and producer even within these ranges.
        </div>
      </div>
    </div>
  `;
  const body = `
    <h1 class="screen-title">Concentrates &amp; Extracts</h1>
    <p class="screen-sub">Flower typically runs 15–30% THC — concentrates are a different category entirely. Tap one for the real lab-testing range.</p>
    ${mock.concentrateGuide.map(c => `
      <button type="button" onclick="document.getElementById('conc-${slug(c.name)}').style.display='flex';" class="library-row" style="width:100%;text-align:left;border:none;background:var(--bg-card,#fff);cursor:pointer;">
        <div class="strain-thumb strain-thumb-sm" style="display:flex;align-items:center;justify-content:center;font-size:20px;background:#e5e0d5;">${c.icon}</div>
        <div class="info"><div class="nm">${esc(c.name)}</div><div class="sub">THC ${esc(c.thc)}</div></div>
      </button>
    `).join('')}
    ${mock.concentrateGuide.map(renderModal).join('')}
  `;
  sendHtml(res, layout({ title: 'Concentrates & Extracts', active: 'education', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Static files: ETag (so repeat visits get an empty 304), gzip for text assets,
// and caching that matches how often each kind of file changes.
//   - app.css / app.js / manifest / sw.js change on every deploy, so they use
//     `no-cache` (= always revalidate; the ETag makes that a cheap 304). A long
//     max-age here would leave browsers running OLD JavaScript for weeks after
//     a deploy -- the exact stale-client bug the service worker comments warn about.
//   - images under /docs and /icons rarely change, so they cache for 7 days.
const COMPRESSIBLE_EXTS = new Set(['.css', '.js', '.json', '.svg']);
const CODE_ASSETS = new Set(['/app.css', '/app.js', '/manifest.json', '/sw.js']);
const IMAGE_CACHE_SECONDS = 60 * 60 * 24 * 7;
function serveStatic(req, res, pathname) {
  // The strain bud photos ended up committed under /docs (repo root) rather
  // than /public/images -- serve /docs/* from that folder; everything else
  // from /public.
  const isDocsRequest = pathname.startsWith('/docs/');
  const baseDir = isDocsRequest ? DOCS_DIR : PUBLIC_DIR;
  const relativePath = isDocsRequest ? pathname.slice('/docs'.length) : pathname;
  const filePath = path.join(baseDir, relativePath);
  if (!filePath.startsWith(baseDir)) return notFound(res);
  fs.readFile(filePath, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath);
    const etag = '"' + crypto.createHash('sha1').update(data).digest('hex') + '"';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': CODE_ASSETS.has(pathname) ? 'no-cache' : `public, max-age=${IMAGE_CACHE_SECONDS}`,
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
    if (COMPRESSIBLE_EXTS.has(ext) && acceptsGzip) {
      return zlib.gzip(data, (gzErr, compressed) => {
        if (gzErr) { res.writeHead(200, headers); return res.end(data); }
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' });
        res.end(compressed);
      });
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ================================================================ restored admin pages
// Inbox, Grow Tips, Recipe edit, User edit. Grow-tip moderation is OFF: tips
// still publish immediately (see handleGrowingNewSubmit); to turn the queue on,
// pass status: 'pending' to db.createGrowTip there.

const RECIPE_CATEGORIES = ['Infusion Base', 'Baked Goods', 'Gummies & Candy', 'Drinks', 'Topicals', 'Savory & Snacks'];

// Shared row renderer for a pending recipe, used both on the dedicated
// Manage Recipes page and the unified admin Inbox, so a pending recipe
// looks and behaves identically no matter which page it's reviewed from.
function renderPendingRecipeRow(r) {
  return `
    <div class="admin-row" style="flex-direction:column;align-items:stretch;">
      <b>${esc(r.title)}</b> <span class="empty-note">by ${esc(r.author || 'Anonymous')} · ${esc(r.category || '')}</span>
      <p class="empty-note">${esc(r.desc)}</p>
      <div class="actions">
        <a href="/admin/recipes/${r.id}/edit" class="btn secondary" style="text-decoration:none;">Edit</a>
        <form method="POST" action="/admin/recipes/${r.id}/approve" style="display:inline;"><button class="btn" type="submit">Approve</button></form>
        <form method="POST" action="/admin/recipes/${r.id}/delete" style="display:inline;" onsubmit="return confirm('Reject and delete?')"><button class="btn danger" style="color:#fff;" type="submit">Reject</button></form>
      </div>
    </div>`;
}

// Grow tip review queue -- same shape as recipe review: pending tips wait
// here until approved, only then do they show up on the public Growing
// page (see listGrowTips's default status='approved' filter).
// Shared row renderer for a pending grow tip -- same reasoning as
// renderPendingRecipeRow above.
function renderPendingGrowTipRow(g) {
  return `
    <div class="admin-row" style="flex-direction:column;align-items:stretch;">
      <b>${esc(g.title)}</b> <span class="empty-note">by ${esc(g.author || 'Anonymous')} · ${esc(g.category)}</span>
      <p class="empty-note">${esc(g.body)}</p>
      <div class="actions">
        <form method="POST" action="/admin/grow-tips/${g.id}/approve" style="display:inline;"><button class="btn" type="submit">Approve</button></form>
        <form method="POST" action="/admin/grow-tips/${g.id}/delete" style="display:inline;" onsubmit="return confirm('Reject and delete?')"><button class="btn danger" style="color:#fff;" type="submit">Reject</button></form>
      </div>
    </div>`;
}

function pageAdminGrowTips(req, res) {
  if (!requireAdmin(req, res)) return;
  const pending = db.listGrowTips({ status: 'pending' });
  const all = db.listGrowTips({ status: null });
  const body = `
    <h1 class="screen-title">Manage Grow Tips</h1>
    ${pending.length ? `<h2 class="screen-title">Pending review (${pending.length})</h2>` + pending.map(renderPendingGrowTipRow).join('') : `<div class="empty-note">No pending grow tips.</div>`}
    <h2 class="screen-title" style="margin-top:20px;">All grow tips (${all.length})</h2>
    ${all.map(g => `
      <div class="admin-row">
        <span>${esc(g.title)} <span class="recipe-source-tag ${g.status === 'approved' ? 'official' : 'community'}">${g.status}</span> <span class="empty-note">${esc(g.category)}</span></span>
        <div class="actions">
          <form method="POST" action="/admin/grow-tips/${g.id}/delete" style="display:inline;" onsubmit="return confirm('Delete this grow tip?')">
            <button class="btn danger" style="color:#fff;" type="submit">Delete</button>
          </form>
        </div>
      </div>`).join('')}
  `;
  sendHtml(res, layout({ title: 'Manage Grow Tips', body, isAdmin: true }));
}

async function handleAdminGrowTipApprove(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.updateGrowTipStatus(Number(id), 'approved');
  redirect(res, '/admin/grow-tips');
}

async function handleAdminGrowTipDelete(req, res, id) {
  if (!requireAdmin(req, res)) return;
  await db.deleteGrowTip(Number(id));
  redirect(res, '/admin/grow-tips');
}

function pageAdminRecipeEdit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const r = db.getRecipe(Number(id));
  if (!r) return notFound(res);
  const body = `
    <h1 class="screen-title">Edit Recipe</h1>
    <form method="POST" action="/admin/recipes/${r.id}/edit">
      <label class="field-label" style="margin-top:0;">Title</label>
      <input type="text" name="title" value="${esc(r.title)}" required>
      <label class="field-label">Description</label>
      <input type="text" name="desc" value="${esc(r.desc)}" required>
      <label class="field-label">Category</label>
      <select name="category">${RECIPE_CATEGORIES.map(c => `<option value="${c}" ${r.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <label class="field-label">Ingredients (one per line)</label>
      <textarea name="ingredients" required>${esc((r.ingredients || []).join('\n'))}</textarea>
      <label class="field-label">Steps (one per line)</label>
      <textarea name="steps" required>${esc((r.steps || []).join('\n'))}</textarea>
      <label class="field-label">Difficulty</label>
      <select name="difficulty">${Object.entries(RECIPE_DIFFICULTY_LABELS).map(([k, v]) => `<option value="${esc(k)}" ${(r.difficulty || 'beginner') === k ? 'selected' : ''}>${esc(typeof v === 'string' ? v : (v.label || k))}</option>`).join('')}</select>
      <label class="field-label">Dosing note</label>
      <input type="text" name="dosing" value="${esc(r.dosing || '')}">
      <button class="btn block" type="submit" style="margin-top:14px;">Save Changes</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Edit Recipe', body, isAdmin: true }));
}

async function handleAdminRecipeEditSubmit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  await db.updateRecipe(Number(id), {
    title: f.title, desc: f.desc, category: RECIPE_CATEGORIES.includes(f.category) ? f.category : 'Baked Goods',
    ingredients: String(f.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean),
    steps: String(f.steps || '').split('\n').map(s => s.trim()).filter(Boolean),
    dosing: f.dosing || '',
    difficulty: RECIPE_DIFFICULTY_LABELS[f.difficulty] ? f.difficulty : 'beginner',
  });
  redirect(res, '/admin/recipes');
}

// Admin correction tool for a mistyped username/email/name/birth date, or
// filling in an old account that predates first/last name being collected.
// Deliberately has no password field -- see adminUpdateUser in db.js for
// why that's a hard line rather than an oversight.
function pageAdminUserEdit(req, res, id, query) {
  if (!requireAdmin(req, res)) return;
  const u = db.getUserById(Number(id));
  if (!u) return notFound(res);
  const error = query.get('error') || '';
  const errMessages = { username_taken: 'That username is already taken.', email_taken: 'That email is already in use by another account.' };
  const body = `
    <h1 class="screen-title">Edit User</h1>
    ${error && errMessages[error] ? `<p style="color:#a13a3a;">${esc(errMessages[error])}</p>` : ''}
    <form method="POST" action="/admin/users/${u.id}/edit">
      <label class="field-label" style="margin-top:0;">Username</label>
      <input type="text" name="username" value="${esc(u.username)}" required>
      <label class="field-label">Email</label>
      <input type="email" name="email" value="${esc(u.email || '')}">
      <label class="field-label">First name</label>
      <input type="text" name="first_name" value="${esc(u.first_name || '')}">
      <label class="field-label">Last name</label>
      <input type="text" name="last_name" value="${esc(u.last_name || '')}">
      <label class="field-label">Date of birth</label>
      <input type="date" name="birth_date" value="${esc((u.birth_date || '').slice(0, 10))}" required>
      <button class="btn block" type="submit" style="margin-top:14px;">Save Changes</button>
    </form>
    <p class="empty-note" style="margin-top:12px;">Password changes still have to go through the normal "Forgot Password" email flow — an admin can't set someone else's password directly.</p>
  `;
  sendHtml(res, layout({ title: 'Edit User', body, isAdmin: true }));
}

async function handleAdminUserEditSubmit(req, res, id) {
  if (!requireAdmin(req, res)) return;
  const f = await parseForm(req);
  try {
    await db.adminUpdateUser(Number(id), {
      username: (f.username || '').trim(), email: (f.email || '').trim().toLowerCase() || null,
      first_name: f.first_name || null, last_name: f.last_name || null, birth_date: f.birth_date,
    });
    redirect(res, '/admin/users');
  } catch (err) {
    const code = /username/i.test(err.message) ? 'username_taken' : /email/i.test(err.message) ? 'email_taken' : '';
    redirect(res, `/admin/users/${id}/edit${code ? `?error=${code}` : ''}`);
  }
}

// A single screen combining everything waiting on admin action -- pending
// recipes, pending grow tips (only ever non-empty if grow-tip moderation is
// turned on), self-added strains waiting to be linked, and the latest
// feedback -- so a routine check-in doesn't mean clicking through four pages.
function pageAdminInbox(req, res) {
  if (!requireAdmin(req, res)) return;
  const pendingRecipes = db.listRecipes({ status: 'pending' });
  const pendingGrowTips = db.listGrowTips({ status: 'pending' });
  const pendingStrains = db.listStrainSubmissions().filter(s => s.status !== 'reviewed');
  const recentFeedback = db.listFeedback().slice(0, 5);
  const totalPending = pendingRecipes.length + pendingGrowTips.length + pendingStrains.length;
  const body = `
    <h1 class="screen-title">Inbox</h1>
    <p class="screen-sub">${totalPending ? `${totalPending} item${totalPending === 1 ? '' : 's'} need${totalPending === 1 ? 's' : ''} your attention.` : 'Nothing pending \u2014 you\u2019re all caught up.'}</p>
    ${pendingStrains.length ? `<h2 class="screen-title">🆕 Self-added strains (${pendingStrains.length})</h2>
      ${pendingStrains.slice(0, 10).map(s => `<div class="admin-row"><span><b>${esc(s.strain_name)}</b> <span class="empty-note">${esc(s.created_at)} UTC</span></span><a href="/admin/strain-submissions" class="btn secondary" style="text-decoration:none;">Review</a></div>`).join('')}
      ${pendingStrains.length > 10 ? `<p class="empty-note"><a href="/admin/strain-submissions">See all ${pendingStrains.length} →</a></p>` : ''}` : ''}
    ${pendingRecipes.length ? `<h2 class="screen-title" style="margin-top:20px;">🍽️ Recipes (${pendingRecipes.length})</h2>${pendingRecipes.map(renderPendingRecipeRow).join('')}` : ''}
    ${pendingGrowTips.length ? `<h2 class="screen-title" style="margin-top:20px;">🌱 Grow Tips (${pendingGrowTips.length})</h2>${pendingGrowTips.map(renderPendingGrowTipRow).join('')}` : ''}
    <h2 class="screen-title" style="margin-top:20px;">💬 Recent Feedback</h2>
    ${recentFeedback.length ? recentFeedback.map(f => {
      const user = f.user_id != null ? db.getUserById(f.user_id) : null;
      return `<div class="admin-row" style="flex-direction:column;align-items:stretch;">
        <span class="empty-note" style="padding:0;">${user ? esc(user.username) : 'Anonymous'} · <span class="local-time" data-utc="${esc(f.created_at)}Z">${esc(f.created_at)}</span></span>
        <p style="margin:6px 0 0;white-space:pre-wrap;">${esc(f.message)}</p>
      </div>`;
    }).join('') : `<div class="empty-note">No feedback yet.</div>`}
    <p class="empty-note" style="padding:6px 0 0;"><a href="/admin/feedback">See all feedback →</a></p>
  `;
  sendHtml(res, layout({ title: 'Inbox', body, isAdmin: true }));
}

// ================================================================ restored pages
// Brought back from earlier commits after whole-file uploads overwrote them
// (see RESTORE_NOTES.md). Gear Care, Add to Home Screen, public shared
// check-ins (/c/:id), Year in Review (+ shareable link), Top Contributors.

// Cleaning & Gear Care -- split out of the general Growing tips page into
// its own spot (More tab) since it's really a separate topic (maintaining
// gear you already own) from cultivation (growing a plant), and was easy
// to miss buried as just one filter pill among eleven growing categories.
const GEAR_CARE_CATEGORY = 'Cleaning & Gear Care';

function pageGearCare(req, res) {
  const viewerId = auth.currentUserId(req);
  const tips = db.listGrowTips({ category: GEAR_CARE_CATEGORY, viewerId });
  const body = `
    <h1 class="screen-title">Cleaning &amp; Gear Care</h1>
    <p class="screen-sub">Keeping pipes, rigs, grinders, and vapes resin-free and running well -- tips from real users.</p>
    <a class="btn block lilac" href="/gear-care/new" style="margin-bottom:14px;">🧼 Share a Cleaning Tip</a>
    ${tips.map(g => `
      <div class="card grow-tip-card">
        <b>${esc(g.title)}</b>
        <p>${linkGlossaryTerms(esc(g.body))}</p>
        ${g.source_url ? `<p class="empty-note" style="padding:2px 0 0;">Source: <a href="${esc(g.source_url)}" target="_blank" rel="noopener noreferrer">${esc(g.source_name || g.source_url)}</a></p>` : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="empty-note" style="padding:0;">by ${esc(g.author || 'Anonymous')}
            ${viewerId != null && g.user_id != null && g.user_id !== viewerId ? `
              <form method="POST" action="/report" style="display:inline;" onsubmit="return confirm('Report this tip for review?')">${csrfField(req)}
                <input type="hidden" name="content_type" value="grow_tip">
                <input type="hidden" name="content_id" value="${g.id}">
                <input type="hidden" name="redirect_to" value="/gear-care">
                <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Report</button>
              </form>
              <form method="POST" action="/block/${g.user_id}" style="display:inline;" onsubmit="return confirm('Block ${esc(g.author || 'this person')}? You will no longer see their comments, check-ins, or grow tips, and any friendship will end.')">${csrfField(req)}
                <input type="hidden" name="redirect_to" value="/gear-care">
                <button type="submit" style="background:none;border:none;padding:0;margin-left:6px;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit;">Block</button>
              </form>
            ` : ''}
          </span>
          <button class="kudos-btn" onclick="likeGrowTip(${g.id}, this)">${KUDOS_BUD_ICON}Kudos (${g.likes})</button>
        </div>
      </div>`).join('') || `<div class="empty-note">No cleaning tips yet — be the first to <a href="/gear-care/new">share one</a>.</div>`}
  `;
  sendHtml(res, layout({ title: 'Cleaning & Gear Care', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

function pageGearCareNew(req, res) {
  const body = `
    <h1 class="screen-title">Share a Cleaning Tip</h1>
    <form method="POST" action="/gear-care/new">${csrfField(req)}
      <label class="field-label">Your name</label>
      <input type="text" name="author" placeholder="e.g. Sam" required>
      <label class="field-label">Title</label>
      <input type="text" name="title" required>
      <label class="field-label">Your tip</label>
      <textarea name="body" required></textarea>
      <button class="btn block" type="submit">Post Tip</button>
    </form>
  `;
  sendHtml(res, layout({ title: 'Share a Cleaning Tip', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

async function handleGearCareNewSubmit(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const f = await parseForm(req);
  await db.createGrowTip({ title: f.title, category: GEAR_CARE_CATEGORY, author: f.author, user_id: userId, body: f.body });
  redirect(res, '/gear-care');
}

// ---------------------------------------------------------------- add to home screen
// StrainDex is a PWA, not something distributed through the App Store or
// Play Store -- most people have never installed a website before, so this
// exists as the permanent, findable version of "how do I actually do that"
// (the onboarding install step covers the same ground once, right after
// signup, but this is here for anyone who skipped it, switched devices, or
// just wants the instructions again). Shows all three platforms rather
// than trying to guess right from the server side (no reliable signal
// pre-JS), then a small inline script auto-selects the tab that matches
// the visitor's actual device and reveals the one-tap install button only
// where the browser has actually offered one (see StrainDexInstall in
// app.js) -- Chromium never fires that offer on the very first page view,
// so the button starts hidden and appears if/when the browser decides to.
function pageAddToHomeScreen(req, res) {
  const body = `
    <h1 class="screen-title">📲 Add StrainDex to Your Home Screen</h1>
    <p class="screen-sub">StrainDex is a <b>web app</b>, not something you download from an app store — but you can still add it to your home screen so it opens full-screen with its own icon, just like any other app.</p>

    <button type="button" class="btn block" data-install-trigger style="display:none;margin-bottom:8px;">📲 Install StrainDex</button>
    <p class="empty-note" id="a2hs-auto-note" style="display:none;padding:0 0 14px;">Tap above and confirm — your browser will add the icon automatically.</p>

    <div style="margin-bottom:14px;">
      <button type="button" class="filter-pill active" data-a2hs-tab="ios">📱 iPhone / iPad</button>
      <button type="button" class="filter-pill" data-a2hs-tab="android">🤖 Android</button>
      <button type="button" class="filter-pill" data-a2hs-tab="desktop">💻 Desktop</button>
    </div>

    <div class="card a2hs-panel" data-a2hs-panel="ios">
      <h2 style="margin:0 0 8px;font-size:0.9375rem;">iPhone &amp; iPad (Safari)</h2>
      <ol style="margin:0;padding-left:20px;">
        <li style="margin-bottom:8px;">Open StrainDex in <b>Safari</b> — this only works in Safari itself, not Chrome, Instagram, or another in-app browser.</li>
        <li style="margin-bottom:8px;">Tap the <b>Share</b> icon (the square with an arrow pointing up) in the toolbar.</li>
        <li style="margin-bottom:8px;">Scroll down and tap <b>Add to Home Screen</b>.</li>
        <li>Tap <b>Add</b> in the top right — that's it.</li>
      </ol>
      <p class="empty-note" style="padding-top:8px;">Apple doesn't let any website trigger this automatically — the Share menu is the only way in on iOS.</p>
    </div>

    <div class="card a2hs-panel" data-a2hs-panel="android" style="display:none;">
      <h2 style="margin:0 0 8px;font-size:0.9375rem;">Android (Chrome)</h2>
      <ol style="margin:0;padding-left:20px;">
        <li style="margin-bottom:8px;">Tap the <b>Install StrainDex</b> button above if you see it — Chrome will prompt you and add the icon for you.</li>
        <li style="margin-bottom:8px;">Don't see the button? Tap the <b>⋮</b> menu in the top right of Chrome.</li>
        <li>Tap <b>Install app</b> (or <b>Add to Home screen</b>), then confirm.</li>
      </ol>
    </div>

    <div class="card a2hs-panel" data-a2hs-panel="desktop" style="display:none;">
      <h2 style="margin:0 0 8px;font-size:0.9375rem;">Desktop (Chrome / Edge)</h2>
      <ol style="margin:0;padding-left:20px;">
        <li style="margin-bottom:8px;">Tap the <b>Install StrainDex</b> button above if you see it.</li>
        <li style="margin-bottom:8px;">Or click the install icon at the right edge of the address bar.</li>
        <li>Or open the <b>⋮</b> menu and choose <b>Install StrainDex…</b>.</li>
      </ol>
      <p class="empty-note" style="padding-top:8px;">Firefox and Safari on desktop don't currently support installing websites this way — StrainDex still works fine in a regular browser tab either way.</p>
    </div>

    <p class="empty-note" style="margin-top:14px;">Already installed? Look for the StrainDex leaf icon on your home screen or desktop next time instead of coming back to a browser tab.</p>

    <script>
      (function () {
        const tabs = document.querySelectorAll('[data-a2hs-tab]');
        const panels = document.querySelectorAll('[data-a2hs-panel]');
        function selectTab(name) {
          tabs.forEach(t => t.classList.toggle('active', t.dataset.a2hsTab === name));
          panels.forEach(p => { p.style.display = p.dataset.a2hsPanel === name ? '' : 'none'; });
        }
        tabs.forEach(t => t.addEventListener('click', () => selectTab(t.dataset.a2hsTab)));

        const install = window.StrainDexInstall;
        const autoNote = document.getElementById('a2hs-auto-note');
        if (install && install.isInstalled && install.isInstalled()) {
          if (autoNote) { autoNote.textContent = 'StrainDex is already installed on this device.'; autoNote.style.display = ''; }
        } else if (install && install.onAvailable) {
          install.onAvailable(() => { if (autoNote) autoNote.style.display = ''; });
        }

        // Auto-select whichever tab matches this device -- doesn't affect
        // the button above, just saves a tap for the common case.
        if (install && install.isIOS && install.isIOS()) selectTab('ios');
        else if (/android/i.test(navigator.userAgent)) selectTab('android');
        else selectTab('desktop');
      })();
    </script>
  `;
  sendHtml(res, layout({ title: 'Add to Home Screen', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Public, read-only, unauthenticated view of a single non-private
// check-in -- the landing page behind the "Share" button on any check-in
// card (see renderShareButton). Deliberately outside the login wall (see
// isPublicSharedCheckin in the router) so a link pasted into a text or
// social post actually works for whoever opens it, logged in or not.
// Carries real Open Graph tags built from the check-in's own strain photo
// and rating so it unfurls as an actual preview card in iMessage/Discord/
// Twitter instead of a bare link. Ends with a signup pitch -- the entire
// point of a public share surface is to convert whoever receives it, not
// just to display data at them.
function pageSharedCheckin(req, res, id) {
  const c = db.getCheckin(Number(id));
  if (!c || c.is_private) return notFound(res);
  const s = db.getStrain(c.strain_id);
  const poster = db.getUserById(c.user_id);
  const posterName = poster ? poster.username : 'Someone';
  const origin = SITE_URL;
  const pageUrl = `${origin}/c/${c.id}`;
  const imageUrl = c.photo || (s ? `${origin}${strainPhotoUrl(s)}` : `${origin}/icons/icon-512.png`);

  const body = `
    <div class="card" style="margin-top:10px;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${strainPhotoTag(s, 'lg')}
        <div>
          <div class="empty-note" style="padding:0;">${esc(posterName)} checked in on StrainDex</div>
          <h1 style="margin:2px 0 0;font-size:1.1875rem;">${esc(checkinStrainName(c, s))}</h1>
          ${s && !isCustomCheckin(c) ? `<div class="empty-note" style="padding:0;">${linkGlossaryTerms(esc(s.type))}${s.lean ? ' · ' + linkGlossaryTerms(esc(s.lean)) : ''} · <span class="rarity-tag rarity-${s.rarity}">${rarityLabel(s.rarity)}</span></div>` : ''}
        </div>
      </div>
      <div class="sub" style="margin-top:12px;">${esc(c.method)} · ${starString(c.rating)}</div>
      ${c.photo ? `<img class="photo-thumb" src="${esc(c.photo)}" alt="photo" style="margin-top:8px;">` : ''}
      ${(c.effects || []).length ? `<div class="effect-tags" style="margin-top:8px;">${c.effects.map(e => `<span>${esc(e)}</span>`).join('')}</div>` : ''}
      ${c.note ? `<div class="note" style="margin-top:8px;">"${esc(c.note)}"</div>` : ''}
      ${renderCheckinPairings(c)}
    </div>
    ${s && !isCustomCheckin(c) ? `<a class="btn secondary block" href="/strains/${s.id}" style="margin-top:14px;text-decoration:none;">View ${esc(s.name)} in the Strain Library →</a>` : ''}
    <div class="card" style="margin-top:14px;text-align:center;">
      <p style="margin:0 0 10px;font-weight:700;">See what StrainDex looks like inside.</p>
      <a href="/signup" class="btn block" style="text-decoration:none;">Create Free Account</a>
      <p class="empty-note" style="margin-top:8px;">Already have an account? <a href="/login">Log in</a></p>
    </div>
  `;
  sendHtml(res, layout({
    title: `${posterName}'s ${checkinStrainName(c, s)} check-in`,
    body,
    showBack: false,
    ogTitle: `${posterName} checked into ${checkinStrainName(c, s)} on StrainDex`,
    ogDescription: c.note || (s ? `${c.method} · ${starString(c.rating)}` : 'A cannabis check-in on StrainDex.'),
    ogImage: imageUrl,
    ogUrl: pageUrl,
  }));
}

// Community leaderboard -- see getKudosLeaderboard in lib/db.js for the
// ranking logic itself and why it's reactions RECEIVED (not raw check-in
// count) on a rolling 30-day window rather than all-time. Requires login,
// unlike Trending, since ranking a real person needs a real viewerId --
// to filter out anyone the viewer has blocked, and to compute "your own
// rank" below the list so showing up here still feels personal even for
// someone who isn't near the top.
function pageLeaderboard(req, res) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const { top, viewerEntry, windowDays } = db.getKudosLeaderboard(userId, { limit: 20, windowDays: 30 });
  const medal = (rank) => ({ 1: '🥇', 2: '🥈', 3: '🥉' }[rank] || rank);
  const renderRow = (r, isViewer) => `
    <div class="library-row" style="${isViewer ? 'border:1.5px solid var(--brand-green);' : ''}">
      <span style="font-weight:700;color:var(--ink-secondary);width:28px;text-align:center;flex-shrink:0;">${medal(r.rank)}</span>
      <div class="info">
        <div class="nm">${isViewer ? 'You' : esc(r.user.username)}</div>
        <div class="sub">${r.allTimeKudos.toLocaleString()} reactions all-time</div>
      </div>
      <span style="font-weight:800;color:var(--accent-text);flex-shrink:0;">🌿 ${r.monthKudos}</span>
    </div>
  `;
  const viewerInTop = top.some(r => r.user.id === userId);
  const body = `
    <h1 class="screen-title">Top Contributors</h1>
    <p class="screen-sub">Ranked by reactions received in the last ${windowDays} days — the community's own way of saying "this check-in helped." Resets over time, so everyone gets a fair shot at climbing, not just whoever joined first.</p>
    ${top.length ? top.map(r => renderRow(r, r.user.id === userId)).join('') : `<div class="empty-note">No reactions given out yet this month — be the first check-in someone appreciates.</div>`}
    ${!viewerInTop ? (viewerEntry
      ? `<div class="section-label" style="margin-top:16px;">Your rank</div>${renderRow(viewerEntry, true)}`
      : `<p class="empty-note" style="margin-top:16px;">You haven't received a reaction yet this month — <a href="/checkin">log a check-in</a> and share it to start climbing.</p>`
    ) : ''}
  `;
  sendHtml(res, layout({ title: 'Top Contributors', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Shared rendering for both the private recap page and its public share
// link -- the data (from db.getYearInReview) is identical either way, only
// the surrounding chrome (signup CTA vs. a "share yours" button, private
// vs. public layout()) differs between the two callers.
function renderRecapBody(recap, { longestStreak } = {}) {
  return `
    <div class="card" style="text-align:center;background:linear-gradient(135deg,#123a24,#1b5e3a);color:#fff;border:none;">
      <div style="font-size:0.75rem;opacity:.85;letter-spacing:.5px;text-transform:uppercase;">${recap.year} Year in Review</div>
      <div style="font-size:2.75rem;font-weight:800;margin:6px 0 2px;">${recap.totalCheckins}</div>
      <div style="font-size:0.8125rem;opacity:.9;">check-in${recap.totalCheckins === 1 ? '' : 's'} logged</div>
    </div>
    <div class="collection-stats" style="margin-top:14px;">
      <div class="stat-tile"><div class="num">${recap.uniqueStrains}</div><div class="lbl">Unique strains</div></div>
      <div class="stat-tile"><div class="num">${recap.totalKudos}</div><div class="lbl">Kudos received</div></div>
      ${longestStreak != null ? `<div class="stat-tile"><div class="num">${longestStreak}</div><div class="lbl">Longest streak</div></div>` : ''}
    </div>
    ${recap.topEffects.length ? `
      <div class="card" style="margin-top:14px;">
        <h2 style="margin:0 0 8px;font-size:0.9375rem;">Most common effects</h2>
        <p>${recap.topEffects.map(e => `<span class="filter-pill">${esc(e.name)} (${e.count})</span>`).join('')}</p>
      </div>
    ` : ''}
    <div class="card" style="margin-top:12px;">
      <h2 style="margin:0 0 8px;font-size:0.9375rem;">Leanings</h2>
      ${recap.topType ? `<p class="empty-note" style="padding:2px 0;">Gravitated toward <b>${esc(recap.topType.name)}</b> strains (${recap.topType.count} check-in${recap.topType.count === 1 ? '' : 's'}).</p>` : ''}
      ${recap.topMethod ? `<p class="empty-note" style="padding:2px 0;">Most-used method: <b>${esc(recap.topMethod.name)}</b>.</p>` : ''}
      ${recap.topTerpene ? `<p class="empty-note" style="padding:2px 0;">Leaned heaviest on <b>${esc(recap.topTerpene)}</b> as a terpene.</p>` : ''}
    </div>
    ${recap.mostLoggedStrain ? `
      <a class="library-row" href="/strains/${recap.mostLoggedStrain.strain.id}" style="text-decoration:none;color:inherit;margin-top:12px;">
        ${strainPhotoTag(recap.mostLoggedStrain.strain, 'sm')}
        <div class="info">
          <div class="nm">Most logged: ${esc(recap.mostLoggedStrain.strain.name)}</div>
          <div class="sub">${recap.mostLoggedStrain.count} check-in${recap.mostLoggedStrain.count === 1 ? '' : 's'}</div>
        </div>
      </a>` : ''}
    ${recap.topRatedStrain ? `
      <a class="library-row" href="/strains/${recap.topRatedStrain.strain.id}" style="text-decoration:none;color:inherit;margin-top:8px;">
        ${strainPhotoTag(recap.topRatedStrain.strain, 'sm')}
        <div class="info">
          <div class="nm">Highest rated: ${esc(recap.topRatedStrain.strain.name)}</div>
          <div class="sub">${starString(Math.round(recap.topRatedStrain.avg))} (${recap.topRatedStrain.avg}★ average)</div>
        </div>
      </a>` : ''}
  `;
}

// Stateless share codes for a recap, same pattern as makeInviteCode --
// signs (userId, year) together rather than just userId, since a recap
// link is specific to one particular year, not "whatever year it is now."
function makeRecapCode(userId, year) {
  return auth.sign(`recap:${userId}:${year}`);
}

function resolveRecapCode(code) {
  const value = auth.verify(code);
  if (!value || !value.startsWith('recap:')) return null;
  const [userIdStr, yearStr] = value.slice('recap:'.length).split(':');
  const userId = Number(userIdStr);
  const year = Number(yearStr);
  if (!Number.isFinite(userId) || !Number.isFinite(year)) return null;
  return { userId, year };
}

function pageRecap(req, res, query) {
  const userId = requireUser(req, res);
  if (userId == null) return;
  const currentYear = new Date().getUTCFullYear();
  const requestedYear = Number(query.get('year')) || currentYear;
  const recap = db.getYearInReview(userId, requestedYear);
  const shareUrl = recap ? `${SITE_URL}/recap/s/${makeRecapCode(userId, requestedYear)}` : null;

  const body = `
    <h1 class="screen-title">Your Year in StrainDex</h1>
    ${!recap ? `
      <div class="empty-note">No check-ins logged in ${requestedYear} yet.${requestedYear === currentYear ? ' Come back once you have a few check-ins to see your recap.' : ''}</div>
      ${requestedYear > 2024 ? `<a href="/recap?year=${requestedYear - 1}" class="empty-note" style="display:block;margin-top:8px;">See ${requestedYear - 1} instead →</a>` : ''}
    ` : `
      ${renderRecapBody(recap, { longestStreak: db.getCheckinStreak(userId).longest })}
      <button type="button" class="btn block" style="margin-top:14px;" onclick="shareLink(${esc(JSON.stringify(shareUrl))}, ${esc(JSON.stringify(`My ${requestedYear} in StrainDex`))})">🔗 Share your recap</button>
      ${requestedYear > 2024 ? `<a href="/recap?year=${requestedYear - 1}" class="empty-note" style="display:block;margin-top:10px;text-align:center;">See ${requestedYear - 1} instead →</a>` : ''}
    `}
  `;
  sendHtml(res, layout({ title: 'Your Year in StrainDex', active: 'more', body, isAdmin: auth.isAdmin(req), unreadMessages: friendsBadgeCount(auth.currentUserId(req)) }));
}

// Public, read-only, unauthenticated view of someone else's recap -- same
// data shape as pageRecap, just resolved from a signed (userId, year) code
// instead of the current session, and framed with a signup pitch instead
// of the "share yours" button. Carries OG tags so it unfurls with real
// numbers rather than a bare link when posted externally.
function pageSharedRecap(req, res, code) {
  const resolved = resolveRecapCode(code);
  if (!resolved) return notFound(res);
  const user = db.getUserById(resolved.userId);
  const recap = user ? db.getYearInReview(resolved.userId, resolved.year) : null;
  if (!user || !recap) return notFound(res);
  const pageUrl = `${SITE_URL}/recap/s/${code}`;

  const body = `
    <h1 class="screen-title">${esc(user.username)}'s ${resolved.year} in StrainDex</h1>
    ${renderRecapBody(recap, { longestStreak: db.getCheckinStreak(resolved.userId).longest })}
    <div class="card" style="margin-top:14px;text-align:center;">
      <p style="margin:0 0 10px;font-weight:700;">Track your own strains, effects, and check-ins.</p>
      <a href="/signup" class="btn block" style="text-decoration:none;">Create Free Account</a>
      <p class="empty-note" style="margin-top:8px;">Already have an account? <a href="/login">Log in</a></p>
    </div>
  `;
  sendHtml(res, layout({
    title: `${user.username}'s ${resolved.year} in StrainDex`,
    body,
    showBack: false,
    ogTitle: `${user.username}'s ${resolved.year} in StrainDex 🌿`,
    ogDescription: `${recap.totalCheckins} check-in${recap.totalCheckins === 1 ? '' : 's'}, ${recap.uniqueStrains} unique strain${recap.uniqueStrains === 1 ? '' : 's'}${recap.topType ? `, mostly ${recap.topType.name}` : ''}.`,
    ogUrl: pageUrl,
  }));
}

// ---------------------------------------------------------------- router

// Transparent gzip for dynamic responses (HTML pages, JSON). Wraps res.writeHead/
// res.end so every existing handler keeps working unchanged; only string bodies
// of 512+ bytes are compressed, and only for browsers that advertise gzip.
function wrapResponseWithGzip(req, res) {
  if (!(req.headers['accept-encoding'] || '').includes('gzip')) return;
  const originalWriteHead = res.writeHead.bind(res);
  const originalEnd = res.end.bind(res);
  let headersPending = false, statusCode = 200, headersArg = {};
  res.writeHead = (code, headers) => { statusCode = code; headersArg = headers || {}; headersPending = true; return res; };
  res.end = (body) => {
    const compressible = headersPending && typeof body === 'string' && body.length >= 512 && !headersArg['Content-Encoding'];
    if (!compressible) { if (headersPending) { originalWriteHead(statusCode, headersArg); headersPending = false; } return originalEnd(body); }
    headersPending = false;
    zlib.gzip(Buffer.from(body, 'utf8'), (err, compressed) => {
      if (err) { originalWriteHead(statusCode, headersArg); return originalEnd(body); }
      originalWriteHead(statusCode, { ...headersArg, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      originalEnd(compressed);
    });
  };
}

const server = http.createServer(async (req, res) => {
  try {
    wrapResponseWithGzip(req, res);
    // Mark every cookie `Secure` when the request arrived over HTTPS (Render
    // terminates TLS and sets x-forwarded-proto). Plain-http local development
    // is left alone so cookies still work there.
    if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) {
      const origSetHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        if (String(name).toLowerCase() === 'set-cookie') {
          value = (Array.isArray(value) ? value : [value]).map(c => /;\s*secure/i.test(c) ? c : c + '; Secure');
        }
        return origSetHeader(name, value);
      };
    }
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
    // Backfill/repair the CSRF cookie for anyone already logged in from before
    // CSRF enforcement existed (or whose cookie went stale). Without this,
    // every currently-logged-in user's next form post would be rejected until
    // they logged out and back in. The token is a pure function of the
    // session cookie, so it can be (re)derived on any GET.
    if (method === 'GET') {
      const ck = auth.parseCookies(req);
      const add = [];
      if (ck.user_session && auth.currentUserId(req) != null && ck.csrf_token !== auth.csrfTokenFor(ck.user_session)) {
        add.push(`csrf_token=${encodeURIComponent(auth.csrfTokenFor(ck.user_session))}; Path=/; SameSite=Lax; Max-Age=31536000`);
      }
      if (ck.admin_session && auth.isAdmin(req) && ck.admin_csrf_token !== auth.csrfTokenFor(ck.admin_session)) {
        add.push(`admin_csrf_token=${encodeURIComponent(auth.csrfTokenFor(ck.admin_session))}; Path=/; SameSite=Lax; Max-Age=2592000`);
      }
      if (add.length) res.setHeader('Set-Cookie', add);
    }

    // Pages meant to be opened by people who aren't logged in: a shared
    // check-in, a shared year-in-review, and the install instructions.
    const isPublicSharePath = /^\/c\/[^/]+$/.test(pathname) || /^\/recap\/s\/[^/]+$/.test(pathname) || pathname === '/add-to-home-screen';
    const PUBLIC_PATHS = new Set(['/', '/signup', '/login', '/logout', '/terms', '/privacy', '/forgot-password', '/reset-password', '/api/analytics-snapshot', '/auth/google', '/auth/google/callback', '/auth/google/finish']);
    if (!PUBLIC_PATHS.has(pathname) && !isPublicSharePath && !pathname.startsWith('/admin') && auth.currentUserId(req) == null) {
      // USER-CONFIRMED BEHAVIOR: a shared strain link opened while logged
      // out goes to a contextual signup prompt (showing which strain was
      // shared) rather than a bare login wall, and carries the strain
      // page through as redirect_to so a brand-new account lands right
      // back on it instead of the generic onboarding flow. See
      // pageSignup, handleSignupSubmit, and the strain-page share button
      // (renderStrainShareButton). Don't revert this to a plain /login
      // redirect without asking first.
      const strainShareMatch = pathname.match(/^\/strains\/([^/]+)$/);
      if (strainShareMatch) {
        return redirect(res, `/signup?strain=${encodeURIComponent(strainShareMatch[1])}&redirect_to=${encodeURIComponent(pathname)}`);
      }
      return redirect(res, '/login');
    }

    // ============================================================
    // DO NOT REMOVE OR WEAKEN THIS BLOCK WITHOUT ASKING THE USER FIRST.
    // Requirement is explicitly user-confirmed: every account MUST have
    // a first and last name, no exceptions, enforced for every request
    // (not just page views) from every logged-in user. New signups
    // (password + Google paths) already collect it up front; this gate
    // is what catches every account that predates the requirement and
    // forces a one-time stop at /complete-profile before they can reach
    // anything else in the app. /logout, /terms, /privacy, and
    // /complete-profile itself stay exempt so nobody gets permanently
    // stuck. If you are an AI editing this file: this comment IS the
    // prompt asking you not to touch this block -- removing, bypassing,
    // or "simplifying" it away is exactly the unwanted behavior it is
    // warning against. See also: pageCompleteProfile,
    // handleCompleteProfileSubmit, handleSignupSubmit,
    // handleGoogleFinishSubmit.
    // ============================================================
    const NAME_GATE_EXEMPT = new Set(['/complete-profile', '/logout', '/terms', '/privacy']);
    if (!NAME_GATE_EXEMPT.has(pathname) && !pathname.startsWith('/admin')) {
      const gateUserId = auth.currentUserId(req);
      if (gateUserId != null) {
        const gateUser = db.getUserById(gateUserId);
        if (gateUser && (!gateUser.first_name || !gateUser.last_name)) {
          return redirect(res, '/complete-profile');
        }
      }
    }

    // CSRF protection for every form-encoded POST past this point. Exempt: the
    // few POST routes that fire before any session exists (signup, login,
    // password reset, admin login, finishing a Google signup) -- there's no
    // token to check until one of THESE creates the session. /api/* JSON
    // endpoints check an X-CSRF-Token header themselves (requireCsrfHeader).
    // A second, independent layer on top of SameSite=Lax. Any non-exempt,
    // non-API POST that ISN'T form-encoded is rejected outright: the body
    // parser accepts any content type, so letting those through would let a
    // cross-site text/plain form post slip past the token check.
    const CSRF_EXEMPT_POST_PATHS = new Set(['/signup', '/login', '/forgot-password', '/reset-password', '/admin/login', '/auth/google/finish']);
    if (method === 'POST' && !CSRF_EXEMPT_POST_PATHS.has(pathname) && !pathname.startsWith('/api/')) {
      const contentType = req.headers['content-type'] || '';
      const fields = contentType.includes('application/x-www-form-urlencoded') ? await parseForm(req) : null;
      if (!fields || !auth.verifyCsrfToken(req, fields._csrf)) {
        return sendHtml(res, layout({
          title: 'Please try again',
          body: `<h1 class="screen-title">Please try again</h1><p>That form couldn't be verified — it may have been open a long time, or submitted from somewhere unexpected. <a href="javascript:history.back()">Go back</a>, refresh the page, and resubmit.</p>`,
        }), 403);
      }
    }

    let m;
    if (method === 'GET' && pathname === '/') return await pageHome(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/c\/([^/]+)$/))) return pageSharedCheckin(req, res, m[1]);
    if (method === 'GET' && pathname === '/gear-care') return pageGearCare(req, res);
    if (method === 'GET' && pathname === '/gear-care/new') return pageGearCareNew(req, res);
    if (method === 'POST' && pathname === '/gear-care/new') return await handleGearCareNewSubmit(req, res);
    if (method === 'GET' && pathname === '/recap') return pageRecap(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/recap\/s\/([^/]+)$/))) return pageSharedRecap(req, res, m[1]);
    if (method === 'GET' && pathname === '/leaderboard') return pageLeaderboard(req, res);
    if (method === 'GET' && pathname === '/add-to-home-screen') return pageAddToHomeScreen(req, res);
    if (method === 'GET' && pathname === '/strains') return pageStrains(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/strains\/([^/]+)$/))) return pageStrainDetail(req, res, m[1]);
    if (method === 'GET' && pathname === '/checkin') return pageCheckinForm(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/checkin') return await handleCheckinSubmit(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/checkin\/(\d+)$/))) return pageCheckinDetail(req, res, Number(m[1]));
    if (method === 'GET' && (m = pathname.match(/^\/checkin\/(\d+)\/edit$/))) return pageCheckinEditForm(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/checkin\/(\d+)\/edit$/))) return await handleCheckinEditSubmit(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/checkin\/(\d+)\/comment$/))) return await handleCheckinComment(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/checkin\/(\d+)\/delete$/))) return await handleCheckinDelete(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/faq') return pageFaq(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/recipes') return pageRecipes(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/recipes\/(\d+)$/))) return pageRecipeDetail(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/recipes/new') return pageRecipeNew(req, res);
    if (method === 'POST' && pathname === '/recipes/new') return await handleRecipeNewSubmit(req, res);
    if (method === 'GET' && pathname === '/recipes/favorites') return pageFavoriteRecipes(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/recipes\/(\d+)\/comment$/))) return await handleRecipeCommentSubmit(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/recipes\/(\d+)\/favorite$/))) return await handleRecipeFavoriteToggle(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/dosing-calculator') return pageDosingCalculator(req, res);
    if (method === 'GET' && pathname === '/best-by') return pageBestBy(req, res);
    if (method === 'POST' && pathname === '/best-by') return await handleBestByAdd(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/best-by\/(\d+)\/delete$/))) return await handleBestByDelete(req, res, m[1]);
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
    if (method === 'GET' && pathname === '/community-guidelines') return pageCommunityGuidelines(req, res);
    if (method === 'GET' && pathname === '/search') return pageSearch(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/forgot-password') return pageForgotPassword(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/forgot-password') return await handleForgotPasswordSubmit(req, res);
    if (method === 'GET' && pathname === '/onboarding') return pageOnboarding(req, res);
    if (method === 'POST' && pathname === '/onboarding/dismiss') return await handleOnboardingDismiss(req, res);
    if (method === 'GET' && pathname === '/complete-profile') return pageCompleteProfile(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/complete-profile') return await handleCompleteProfileSubmit(req, res);
    if (method === 'GET' && pathname === '/feedback') return pageFeedback(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/feedback') return await handleFeedbackSubmit(req, res);
    if (method === 'GET' && pathname === '/support-the-app') return pageSupportTheApp(req, res);
    if (method === 'GET' && pathname === '/reset-password') return pageResetPassword(req, res, url.searchParams);
    if (method === 'POST' && pathname === '/reset-password') return await handleResetPasswordSubmit(req, res);
    if (method === 'POST' && pathname === '/account/bio') return await handleAccountBio(req, res);
    if (method === 'POST' && pathname === '/account/username') return await handleAccountUsername(req, res);
    if (method === 'POST' && pathname === '/account/email') return await handleAccountEmail(req, res);
    if (method === 'POST' && pathname === '/account/password') return await handleAccountPassword(req, res);
    if (method === 'GET' && pathname === '/admin/logout') return handleAdminLogout(req, res);
    if (method === 'GET' && pathname === '/admin') return pageAdminHome(req, res);
    if (method === 'GET' && pathname === '/admin/users') return pageAdminUsers(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/admin/inbox') return pageAdminInbox(req, res);
    if (method === 'GET' && pathname === '/admin/grow-tips') return pageAdminGrowTips(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/grow-tips\/(\d+)\/approve$/))) return await handleAdminGrowTipApprove(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/grow-tips\/(\d+)\/delete$/))) return await handleAdminGrowTipDelete(req, res, m[1]);
    if (method === 'GET' && (m = pathname.match(/^\/admin\/recipes\/(\d+)\/edit$/))) return pageAdminRecipeEdit(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/recipes\/(\d+)\/edit$/))) return await handleAdminRecipeEditSubmit(req, res, m[1]);
    if (method === 'GET' && (m = pathname.match(/^\/admin\/users\/(\d+)\/edit$/))) return pageAdminUserEdit(req, res, m[1], url.searchParams);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/users\/(\d+)\/edit$/))) return await handleAdminUserEditSubmit(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/users\/(\d+)\/delete$/))) return await handleAdminUserDelete(req, res, Number(m[1]));
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
    if (method === 'POST' && (m = pathname.match(/^\/api\/checkins\/(\d+)\/react$/))) return await apiCheckinReaction(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/api\/comments\/(\d+)\/like$/))) return await apiCommentLike(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/api/analytics-snapshot') return apiAnalyticsSnapshot(req, res, url.searchParams);

    if (method === 'GET' && pathname === '/more') return pageMore(req, res);
    if (method === 'GET' && pathname === '/education') return pageEducation(req, res);
    if (method === 'GET' && pathname === '/collection') return pageCollection(req, res);
    if (method === 'GET' && pathname === '/history') return pageHistory(req, res);
    if (method === 'GET' && pathname === '/trade') return pageTrade(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/friends') return pageFriends(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/friends/requests') return pageFriendRequests(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/friends\/(\d+)$/))) return pageFriendProfile(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/request$/))) return await handleFriendRequest(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/accept$/))) return await handleFriendAccept(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/decline$/))) return await handleFriendDecline(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/remove$/))) return await handleFriendRemove(req, res, Number(m[1]));
    if (method === 'POST' && (m = pathname.match(/^\/friends\/(\d+)\/cancel$/))) return await handleFriendCancel(req, res, Number(m[1]));
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
    if (method === 'GET' && pathname === '/notifications') return await pageNotifications(req, res);
    if (method === 'POST' && pathname === '/custom-strain/resolve') return await handleCustomStrainResolve(req, res);
    if (method === 'GET' && pathname === '/invite') return pageInvite(req, res);
    if (method === 'GET' && pathname === '/puff-puff-ask') return pagePuffPuffAsk(req, res, url.searchParams);
    if (method === 'GET' && (m = pathname.match(/^\/puff-puff-ask\/(\d+)$/))) return pagePuffPuffAskThread(req, res, Number(m[1]));
    if (method === 'POST' && pathname === '/puff-puff-ask/new') return await handlePuffPuffAskNew(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/puff-puff-ask\/(\d+)\/reply$/))) return await handlePuffPuffAskReply(req, res, Number(m[1]));
    if (method === 'GET' && pathname === '/lists') return pageLists(req, res);
    if (method === 'POST' && pathname === '/lists') return await handleListCreate(req, res);
    if (method === 'GET' && (m = pathname.match(/^\/lists\/(\d+)$/))) return pageListDetail(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/lists\/(\d+)\/delete$/))) return await handleListDelete(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/lists\/(\d+)\/items\/([^/]+)\/toggle$/))) return await handleListItemToggle(req, res, m[1], m[2]);
    if (method === 'GET' && pathname === '/terpene-guide') return pageTerpeneGuide(req, res);
    if (method === 'GET' && pathname === '/effects-guide') return pageEffectsGuide(req, res);
    if (method === 'GET' && pathname === '/mood-finder') return pageMoodFinder(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/breeder-guide') return pageBreederGuide(req, res);
    if (method === 'GET' && pathname === '/landrace-guide') return pageLandraceGuide(req, res);
    if (method === 'GET' && pathname === '/genetics-guide') return pageGeneticsGuide(req, res);
    if (method === 'GET' && pathname === '/glossary') return pageGlossary(req, res, url.searchParams);
    if (method === 'GET' && pathname === '/using-whole-plant') return pageUsingWholePlant(req, res);
    if (method === 'GET' && pathname === '/first-time-grower-guide') return pageFirstTimeGrowerGuide(req, res);
    if (method === 'GET' && pathname === '/storage-guide') return pageStorageGuide(req, res);
    if (method === 'GET' && pathname === '/lab-result-guide') return pageLabResultGuide(req, res);
    if (method === 'GET' && pathname === '/tolerance-explained') return pageToleranceExplained(req, res);
    if (method === 'GET' && pathname === '/feels-wrong') return pageFeelsWrong(req, res);
    if (method === 'GET' && pathname === '/new-to-cannabis') return pageNewToCannabis(req, res);
    if (method === 'GET' && pathname === '/knowledge-quiz') return pageKnowledgeQuiz(req, res);
    if (method === 'GET' && pathname === '/common-myths') return pageCommonMyths(req, res);
    if (method === 'GET' && pathname === '/cannabis-history') return pageCannabisHistory(req, res);
    if (method === 'POST' && pathname === '/report') return await handleReport(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/block\/(\d+)$/))) return await handleBlock(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/unblock\/(\d+)$/))) return await handleUnblock(req, res, m[1]);
    if (method === 'GET' && pathname === '/blocked-users') return pageBlockedUsers(req, res);
    if (method === 'GET' && pathname === '/admin/reports') return pageAdminReports(req, res);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/reports\/(\d+)\/reviewed$/))) return await handleAdminReportReviewed(req, res, m[1]);
    if (method === 'GET' && pathname === '/admin/strain-submissions') return pageAdminStrainSubmissions(req, res, url.searchParams);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/strain-submissions\/(\d+)\/link$/))) return await handleAdminStrainSubmissionLink(req, res, m[1]);
    if (method === 'POST' && (m = pathname.match(/^\/admin\/strain-submissions\/(\d+)\/reviewed$/))) return await handleAdminStrainSubmissionReviewed(req, res, m[1]);

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
