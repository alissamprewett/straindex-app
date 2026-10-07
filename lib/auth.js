// auth.js — minimal signed-cookie admin session, no external deps.
const crypto = require('node:crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-only-secret-change-in-production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'straindex-admin';

function sign(value) {
  const h = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${h}`;
}
function verify(token) {
  if (!token) return false;
  const idx = token.lastIndexOf('.');
  if (idx === -1) return false;
  const value = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? value : false;
  } catch {
    return false;
  }
}
function checkPassword(pw) {
  // Compare fixed-length digests in constant time, so response timing can't
  // reveal how many leading characters of a guess were right.
  const a = crypto.createHash('sha256').update(String(pw ?? '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}
function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function isAdmin(req) {
  const cookies = parseCookies(req);
  const val = verify(cookies.admin_session);
  return val === 'admin';
}

// ---------------------------------------------------------------- CSRF protection
// A stateless "signed derivation" token: rather than storing a separate
// per-session secret anywhere, the CSRF token is just an HMAC of the
// person's own already-signed session cookie value. A browser holding the
// real, HttpOnly session cookie gets handed a matching, JS-readable CSRF
// cookie at the same time (see the csrf_token / admin_csrf_token cookies
// set alongside user_session / admin_session in server.js); a cross-site
// attacker forging a request has neither cookie to read, so can't produce
// a token that verifies. This sits on top of SameSite=Lax, already set on
// every auth cookie in this app, which alone blocks the classic
// cross-site form-POST attack on any modern browser -- this adds a
// second, independent layer that doesn't depend on SameSite enforcement
// being correct or even present (older browsers, future browser bugs,
// non-browser HTTP clients that don't honor SameSite at all).
function csrfTokenFor(sessionValue) {
  if (!sessionValue) return null;
  return sign(`csrf:${sessionValue}`);
}
function csrfToken(req) {
  const cookies = parseCookies(req);
  return csrfTokenFor(cookies.user_session) || csrfTokenFor(cookies.admin_session);
}
function verifyCsrfToken(req, submitted) {
  const expected = csrfToken(req);
  if (!expected || !submitted) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- user accounts
// Passwords are hashed with Node's built-in scrypt (no extra dependency) —
// a random salt per user, salt+hash both stored, never the raw password.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}
// The user session cookie just stores a signed user id — same signing
// mechanism as the admin cookie, but a separate cookie name so admin and
// regular-user sessions are completely independent of each other.
// Session cookies are `user:<id>` (version 0) or `user:<id>:<version>`. A
// user's version is bumped whenever their password changes or is reset
// (see bumpSessionVersion in db.js), which instantly invalidates every
// session cookie issued before that -- on every device. Cookies issued before
// this existed are plain `user:<id>` and stay valid until the next password
// change. The lookup is injected by db.js (this file can't require it
// without a circular import); until it is set, versions aren't checked.
let sessionVersionLookup = null;
function setSessionVersionLookup(fn) { sessionVersionLookup = fn; }
function currentUserId(req) {
  const cookies = parseCookies(req);
  const val = verify(cookies.user_session);
  if (!val || !val.startsWith('user:')) return null;
  const parts = val.slice('user:'.length).split(':');
  const id = Number(parts[0]);
  const version = parts.length > 1 ? Number(parts[1]) : 0;
  if (!Number.isFinite(id) || !Number.isFinite(version)) return null;
  if (sessionVersionLookup) {
    const current = sessionVersionLookup(id);
    if (current == null || current !== version) return null;   // unknown/deleted user, or revoked
  }
  return id;
}
function signUserSessionValue(userId) {
  const v = sessionVersionLookup ? (sessionVersionLookup(userId) || 0) : 0;
  return sign(v ? `user:${userId}:${v}` : `user:${userId}`);
}

module.exports = {
  sign, verify, checkPassword, parseCookies, isAdmin, ADMIN_PASSWORD, setSessionVersionLookup,
  hashPassword, verifyPassword, currentUserId, signUserSessionValue,
  csrfTokenFor, csrfToken, verifyCsrfToken,
};
