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
  return pw === ADMIN_PASSWORD;
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

module.exports = { sign, verify, checkPassword, parseCookies, isAdmin, ADMIN_PASSWORD };
