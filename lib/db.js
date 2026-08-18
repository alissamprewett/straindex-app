// db.js — Turso (libSQL) data-access layer, with an in-memory read cache.
//
// Every other file in this app talks to the database ONLY through the
// functions exported here — that hasn't changed. What changed underneath:
// this used to wrap Node's built-in `node:sqlite` (a local file, accessed
// synchronously). It now talks to Turso, a hosted SQLite-compatible
// database, over HTTPS — which means every query is a network round-trip
// and therefore async.
//
// Rather than rewrite every page-building function in server.js to be
// async (there are ~40 of them), this file keeps an in-memory cache of
// everything, loaded once at boot by init(). All the *read* functions below
// are unchanged and still synchronous — they now read from that cache
// instead of querying SQLite directly. All the *write* functions
// (createFaq, createCheckin, toggleRsvp, etc.) are now `async`: they write
// to Turso FIRST, wait for confirmation, and only then update the cache —
// so a failed write surfaces as a real error instead of silently only
// updating memory. server.js awaits these in the handful of places
// (already-async POST handlers) where they're called.
//
// You must call `await db.init()` once, before the server starts
// listening — see the bottom of server.js.
//
// Env vars required: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN
// (get both from https://turso.tech after creating a free database).

const { createClient } = require('@libsql/client');
const auth = require('./auth');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error(
    '\n[db.js] Missing TURSO_DATABASE_URL and/or TURSO_AUTH_TOKEN environment variables.\n' +
    '  Set both (from your Turso dashboard) before starting the server.\n'
  );
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS strains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    lean TEXT,
    rarity TEXT NOT NULL,
    thc TEXT,
    cbd TEXT,
    terps TEXT NOT NULL,
    effects TEXT NOT NULL,
    flavor TEXT,
    icon TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS faqs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    time TEXT,
    icon TEXT,
    source TEXT NOT NULL DEFAULT 'community',
    author TEXT,
    kudos INTEGER NOT NULL DEFAULT 0,
    desc TEXT,
    ingredients TEXT NOT NULL,
    steps TEXT NOT NULL,
    dosing TEXT,
    category TEXT NOT NULL DEFAULT 'Baked Goods',
    status TEXT NOT NULL DEFAULT 'approved',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS grow_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    author TEXT,
    likes INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    source_name TEXT,
    source_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strain_id TEXT NOT NULL,
    method TEXT,
    rating INTEGER,
    note TEXT,
    effects TEXT,
    photo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(strain_id) REFERENCES strains(id)
  )`,
  `CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    friend_name TEXT NOT NULL,
    gave_strain_id TEXT NOT NULL,
    got_strain_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS dispensary_follows (
    dispensary_id TEXT PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS event_rsvps (
    event_id TEXT PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    birth_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS user_dispensary_follows (
    user_id INTEGER NOT NULL,
    dispensary_id TEXT NOT NULL,
    PRIMARY KEY (user_id, dispensary_id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_event_rsvps (
    user_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (user_id, event_id)
  )`,
];

// ---------- cache ----------
let ready = false;
const cache = {
  strains: new Map(),          // id -> strain object
  faqs: [],                    // sorted sort_order asc, id asc
  recipes: [],                 // no fixed order; each read function sorts as needed
  growTips: [],
  checkins: [],
  trades: [],
  dispensaryFollows: new Map(), // userId -> Set(dispensary_id)
  eventRsvps: new Map(),        // userId -> Set(event_id)
  cartCounts: new Map(),        // userId -> count
  users: new Map(),             // id -> user object (no password fields exposed beyond hash/salt)
  usernameIndex: new Map(),     // lowercase username -> id
};

function assertReady() {
  if (!ready) throw new Error('lib/db.js: await db.init() before using the database');
}

// Convert a libSQL ResultSet into plain JS objects. Using positional access
// (row[i] + rs.columns) rather than named property access on the Row proxy,
// so this doesn't depend on exactly how @libsql/client implements Row.
function rowsToObjects(rs) {
  return rs.rows.map(row => {
    const obj = {};
    rs.columns.forEach((col, i) => {
      let v = row[i];
      if (typeof v === 'bigint') v = Number(v);
      obj[col] = v;
    });
    return obj;
  });
}
function rowToObject(rs) {
  const objs = rowsToObjects(rs);
  return objs[0] || null;
}

function rowToStrain(row) {
  return { ...row, terps: JSON.parse(row.terps), effects: JSON.parse(row.effects) };
}
function rowToRecipe(row) {
  return { ...row, ingredients: JSON.parse(row.ingredients), steps: JSON.parse(row.steps) };
}
function rowToCheckin(row) {
  return { ...row, effects: JSON.parse(row.effects || '[]') };
}

function sortFaqsInPlace() {
  cache.faqs.sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
}

async function init() {
  for (const stmt of SCHEMA_STATEMENTS) {
    await client.execute(stmt);
  }
  // Migration: the recipes table originally shipped without a `category`
  // column. Add it if it's not already there — safe to run on every boot.
  const recipeCols = rowsToObjects(await client.execute('PRAGMA table_info(recipes)')).map(r => r.name);
  if (!recipeCols.includes('category')) {
    await client.execute("ALTER TABLE recipes ADD COLUMN category TEXT NOT NULL DEFAULT 'Baked Goods'");
  }
  const growTipCols = rowsToObjects(await client.execute('PRAGMA table_info(grow_tips)')).map(r => r.name);
  if (!growTipCols.includes('source_name')) {
    await client.execute('ALTER TABLE grow_tips ADD COLUMN source_name TEXT');
  }
  if (!growTipCols.includes('source_url')) {
    await client.execute('ALTER TABLE grow_tips ADD COLUMN source_url TEXT');
  }
  const checkinCols = rowsToObjects(await client.execute('PRAGMA table_info(checkins)')).map(r => r.name);
  if (!checkinCols.includes('user_id')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN user_id INTEGER');
  }
  const cartCols = rowsToObjects(await client.execute('PRAGMA table_info(cart_items)')).map(r => r.name);
  if (!cartCols.includes('user_id')) {
    await client.execute('ALTER TABLE cart_items ADD COLUMN user_id INTEGER');
  }

  cache.strains = new Map(
    rowsToObjects(await client.execute('SELECT * FROM strains')).map(r => [r.id, rowToStrain(r)])
  );
  cache.faqs = rowsToObjects(await client.execute('SELECT * FROM faqs'));
  sortFaqsInPlace();
  cache.recipes = rowsToObjects(await client.execute('SELECT * FROM recipes')).map(rowToRecipe);
  cache.growTips = rowsToObjects(await client.execute('SELECT * FROM grow_tips'));
  cache.checkins = rowsToObjects(await client.execute('SELECT * FROM checkins')).map(rowToCheckin);
  cache.trades = rowsToObjects(await client.execute('SELECT * FROM trades'));

  cache.users = new Map(rowsToObjects(await client.execute('SELECT * FROM users')).map(u => [u.id, u]));
  cache.usernameIndex = new Map([...cache.users.values()].map(u => [u.username.toLowerCase(), u.id]));

  cache.dispensaryFollows = new Map();
  for (const r of rowsToObjects(await client.execute('SELECT * FROM user_dispensary_follows'))) {
    if (!cache.dispensaryFollows.has(r.user_id)) cache.dispensaryFollows.set(r.user_id, new Set());
    cache.dispensaryFollows.get(r.user_id).add(r.dispensary_id);
  }
  cache.eventRsvps = new Map();
  for (const r of rowsToObjects(await client.execute('SELECT * FROM user_event_rsvps'))) {
    if (!cache.eventRsvps.has(r.user_id)) cache.eventRsvps.set(r.user_id, new Set());
    cache.eventRsvps.get(r.user_id).add(r.event_id);
  }
  cache.cartCounts = new Map();
  for (const r of rowsToObjects(await client.execute('SELECT user_id, COUNT(*) AS c FROM cart_items WHERE user_id IS NOT NULL GROUP BY user_id'))) {
    cache.cartCounts.set(r.user_id, Number(r.c));
  }

  ready = true;
}

// ---------- Strains ----------
function listStrains({ q, type, rarity, limit = 60 } = {}) {
  assertReady();
  let arr = [...cache.strains.values()];
  if (q) { const needle = q.toLowerCase(); arr = arr.filter(s => s.name.toLowerCase().includes(needle)); }
  if (type && type !== 'All') arr = arr.filter(s => s.type === type);
  if (rarity && rarity !== 'All') arr = arr.filter(s => s.rarity === rarity);
  arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr.slice(0, limit);
}
function countStrains({ q, type, rarity } = {}) {
  assertReady();
  let arr = [...cache.strains.values()];
  if (q) { const needle = q.toLowerCase(); arr = arr.filter(s => s.name.toLowerCase().includes(needle)); }
  if (type && type !== 'All') arr = arr.filter(s => s.type === type);
  if (rarity && rarity !== 'All') arr = arr.filter(s => s.rarity === rarity);
  return arr.length;
}
function getStrain(id) {
  assertReady();
  return cache.strains.get(id) || null;
}
async function insertStrain(s) {
  const terps = JSON.stringify(s.terps || []);
  const effects = JSON.stringify(s.effects || []);
  await client.execute({
    sql: `INSERT OR REPLACE INTO strains (id,name,type,lean,rarity,thc,cbd,terps,effects,flavor,icon)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    args: [s.id, s.name, s.type, s.lean || '', s.rarity, s.thc || '', s.cbd || '', terps, effects, s.flavor || '', s.icon || '🌿'],
  });
  cache.strains.set(s.id, {
    id: s.id, name: s.name, type: s.type, lean: s.lean || '', rarity: s.rarity,
    thc: s.thc || '', cbd: s.cbd || '', terps: s.terps || [], effects: s.effects || [],
    flavor: s.flavor || '', icon: s.icon || '🌿',
  });
}
async function deleteStrain(id) {
  await client.execute({ sql: 'DELETE FROM strains WHERE id = ?', args: [id] });
  cache.strains.delete(id);
}
// Generates the next "sN" id for a strain added through the admin UI —
// existing strains are s1..s1533 (from the seed file), so this just finds
// the highest numeric suffix currently in use and adds one.
function nextStrainId() {
  assertReady();
  let max = 0;
  for (const id of cache.strains.keys()) {
    const m = /^s(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

// ---------- FAQs ----------
function listFaqs() {
  assertReady();
  return cache.faqs;
}
function getFaq(id) {
  assertReady();
  return cache.faqs.find(f => f.id === id) || null;
}
async function createFaq({ question, answer, sort_order = 0 }) {
  const rs = await client.execute({
    sql: 'INSERT INTO faqs (question, answer, sort_order) VALUES (?,?,?) RETURNING *',
    args: [question, answer, sort_order],
  });
  const row = rowToObject(rs);
  cache.faqs.push(row);
  sortFaqsInPlace();
  return row;
}
async function updateFaq(id, { question, answer, sort_order }) {
  await client.execute({
    sql: 'UPDATE faqs SET question=?, answer=?, sort_order=? WHERE id=?',
    args: [question, answer, sort_order, id],
  });
  const idx = cache.faqs.findIndex(f => f.id === id);
  if (idx !== -1) cache.faqs[idx] = { ...cache.faqs[idx], question, answer, sort_order };
  sortFaqsInPlace();
  return getFaq(id);
}
async function deleteFaq(id) {
  await client.execute({ sql: 'DELETE FROM faqs WHERE id = ?', args: [id] });
  cache.faqs = cache.faqs.filter(f => f.id !== id);
}

// ---------- Recipes ----------
function listRecipes({ status = 'approved', category } = {}) {
  assertReady();
  let arr = cache.recipes;
  if (status) arr = arr.filter(r => r.status === status);
  if (category && category !== 'All') arr = arr.filter(r => r.category === category);
  return status
    ? [...arr].sort((a, b) => (b.kudos - a.kudos) || (b.id - a.id))
    : [...arr].sort((a, b) => b.id - a.id);
}
function getRecipe(id) {
  assertReady();
  return cache.recipes.find(r => r.id === id) || null;
}
async function createRecipe({ title, time, icon, source = 'community', author, desc, ingredients, steps, dosing, category = 'Baked Goods', status = 'approved', kudos = 0 }) {
  const rs = await client.execute({
    sql: `INSERT INTO recipes (title,time,icon,source,author,kudos,desc,ingredients,steps,dosing,category,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [
      title, time || '', icon || '🍽️', source, author || null, kudos,
      desc || '', JSON.stringify(ingredients || []), JSON.stringify(steps || []), dosing || '', category, status,
    ],
  });
  const row = rowToRecipe(rowToObject(rs));
  cache.recipes.push(row);
  return row;
}
async function updateRecipe(id, fields) {
  const current = getRecipe(id);
  if (!current) return null;
  const merged = { ...current, ...fields };
  await client.execute({
    sql: `UPDATE recipes SET title=?, time=?, icon=?, source=?, author=?, desc=?, ingredients=?, steps=?, dosing=?, category=?, status=? WHERE id=?`,
    args: [
      merged.title, merged.time, merged.icon, merged.source, merged.author, merged.desc,
      JSON.stringify(merged.ingredients), JSON.stringify(merged.steps), merged.dosing, merged.category, merged.status, id,
    ],
  });
  const idx = cache.recipes.findIndex(r => r.id === id);
  if (idx !== -1) cache.recipes[idx] = merged;
  return getRecipe(id);
}
async function deleteRecipe(id) {
  await client.execute({ sql: 'DELETE FROM recipes WHERE id = ?', args: [id] });
  cache.recipes = cache.recipes.filter(r => r.id !== id);
}
async function addKudos(id) {
  await client.execute({ sql: 'UPDATE recipes SET kudos = kudos + 1 WHERE id = ?', args: [id] });
  const idx = cache.recipes.findIndex(r => r.id === id);
  if (idx !== -1) cache.recipes[idx] = { ...cache.recipes[idx], kudos: cache.recipes[idx].kudos + 1 };
  return getRecipe(id);
}

// ---------- Grow tips ----------
function listGrowTips({ category } = {}) {
  assertReady();
  let arr = cache.growTips;
  if (category && category !== 'All') arr = arr.filter(g => g.category === category);
  return [...arr].sort((a, b) => (b.likes - a.likes) || (b.id - a.id));
}
async function createGrowTip({ title, category, author, body, source_name, source_url }) {
  const rs = await client.execute({
    sql: 'INSERT INTO grow_tips (title,category,author,body,source_name,source_url) VALUES (?,?,?,?,?,?) RETURNING *',
    args: [title, category, author || 'You', body, source_name || null, source_url || null],
  });
  const row = rowToObject(rs);
  cache.growTips.push(row);
  return row;
}
async function likeGrowTip(id) {
  await client.execute({ sql: 'UPDATE grow_tips SET likes = likes + 1 WHERE id = ?', args: [id] });
  const idx = cache.growTips.findIndex(g => g.id === id);
  if (idx !== -1) cache.growTips[idx] = { ...cache.growTips[idx], likes: cache.growTips[idx].likes + 1 };
}

// ---------- Check-ins ----------
async function createCheckin({ user_id, strain_id, method, rating, note, effects, photo }) {
  const rs = await client.execute({
    sql: `INSERT INTO checkins (user_id, strain_id, method, rating, note, effects, photo) VALUES (?,?,?,?,?,?,?) RETURNING *`,
    args: [user_id, strain_id, method || '', rating || 0, note || '', JSON.stringify(effects || []), photo || null],
  });
  const row = rowToCheckin(rowToObject(rs));
  cache.checkins.push(row);
  return row;
}
function listCheckins({ userId, strain_id, limit = 100 } = {}) {
  assertReady();
  let arr = cache.checkins;
  if (userId != null) arr = arr.filter(c => c.user_id === userId);
  if (strain_id) arr = arr.filter(c => c.strain_id === strain_id);
  return [...arr].sort((a, b) => b.id - a.id).slice(0, limit);
}

// ---------- Collection (derived from a user's own check-ins) ----------
function getCollection(userId) {
  assertReady();
  const counts = new Map();
  for (const c of cache.checkins) {
    if (c.user_id !== userId) continue;
    counts.set(c.strain_id, (counts.get(c.strain_id) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([strain_id, copies]) => ({ strain: getStrain(strain_id), copies }))
    .filter(r => r.strain);
}
function getUniqueOwnedCount(userId) {
  assertReady();
  return new Set(cache.checkins.filter(c => c.user_id === userId).map(c => c.strain_id)).size;
}
function getTotalDupes(userId) {
  assertReady();
  const counts = new Map();
  for (const c of cache.checkins) {
    if (c.user_id !== userId) continue;
    counts.set(c.strain_id, (counts.get(c.strain_id) || 0) + 1);
  }
  let total = 0;
  for (const c of counts.values()) total += Math.max(0, c - 1);
  return total;
}
// Unlike the personal collection functions above, this one is intentionally
// GLOBAL (across every user) — it powers the "trending strains" business
// page, which is meant to be an aggregate view, not a personal one.
function getMostCheckedInStrains(limit = 4) {
  assertReady();
  const counts = new Map();
  for (const c of cache.checkins) counts.set(c.strain_id, (counts.get(c.strain_id) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([strain_id, count]) => ({ strain: getStrain(strain_id), count }))
    .filter(r => r.strain);
}

// ---------- Trades ----------
async function createTrade({ friend_name, gave_strain_id, got_strain_id }) {
  const rs = await client.execute({
    sql: 'INSERT INTO trades (friend_name, gave_strain_id, got_strain_id) VALUES (?,?,?) RETURNING *',
    args: [friend_name, gave_strain_id, got_strain_id],
  });
  cache.trades.push(rowToObject(rs));
}
function listTrades(limit = 50) {
  assertReady();
  return [...cache.trades].sort((a, b) => b.id - a.id).slice(0, limit);
}
function countTrades() {
  assertReady();
  return cache.trades.length;
}

// ---------- Dispensary follows (per user) ----------
function isFollowingDispensary(userId, id) {
  assertReady();
  return cache.dispensaryFollows.get(userId)?.has(id) || false;
}
async function toggleFollowDispensary(userId, id) {
  const set = cache.dispensaryFollows.get(userId) || new Set();
  if (set.has(id)) {
    await client.execute({ sql: 'DELETE FROM user_dispensary_follows WHERE user_id = ? AND dispensary_id = ?', args: [userId, id] });
    set.delete(id);
  } else {
    await client.execute({ sql: 'INSERT OR IGNORE INTO user_dispensary_follows (user_id, dispensary_id) VALUES (?,?)', args: [userId, id] });
    set.add(id);
  }
  cache.dispensaryFollows.set(userId, set);
  return set.has(id);
}
function anyDispensaryFollowed(userId) {
  assertReady();
  return (cache.dispensaryFollows.get(userId)?.size || 0) > 0;
}

// ---------- Event RSVPs (per user) ----------
function isRsvped(userId, id) {
  assertReady();
  return cache.eventRsvps.get(userId)?.has(id) || false;
}
async function toggleRsvp(userId, id) {
  const set = cache.eventRsvps.get(userId) || new Set();
  if (set.has(id)) {
    await client.execute({ sql: 'DELETE FROM user_event_rsvps WHERE user_id = ? AND event_id = ?', args: [userId, id] });
    set.delete(id);
  } else {
    await client.execute({ sql: 'INSERT OR IGNORE INTO user_event_rsvps (user_id, event_id) VALUES (?,?)', args: [userId, id] });
    set.add(id);
  }
  cache.eventRsvps.set(userId, set);
  return set.has(id);
}
function anyRsvped(userId) {
  assertReady();
  return (cache.eventRsvps.get(userId)?.size || 0) > 0;
}

// ---------- Shop cart (per user) ----------
async function addToCart(userId, itemId) {
  await client.execute({ sql: 'INSERT INTO cart_items (user_id, item_id) VALUES (?,?)', args: [userId, itemId] });
  cache.cartCounts.set(userId, (cache.cartCounts.get(userId) || 0) + 1);
}
function getCartCount(userId) {
  assertReady();
  return cache.cartCounts.get(userId) || 0;
}

// ---------- User accounts ----------
// Minimum age enforced at signup — self-attested via birth date, matching
// how most cannabis apps handle this (not verified ID). See server.js's
// signup handler for the actual age check; this file just stores what it's given.
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, birth_date: u.birth_date, created_at: u.created_at };
}
function getUserByUsername(username) {
  assertReady();
  const id = cache.usernameIndex.get(String(username || '').toLowerCase());
  return id != null ? cache.users.get(id) : null;
}
function getUserById(id) {
  assertReady();
  return cache.users.get(id) || null;
}
async function createUser({ username, password, birth_date }) {
  if (getUserByUsername(username)) {
    throw new Error('That username is already taken.');
  }
  const { salt, hash } = auth.hashPassword(password);
  const rs = await client.execute({
    sql: 'INSERT INTO users (username, password_hash, password_salt, birth_date) VALUES (?,?,?,?) RETURNING *',
    args: [username, hash, salt, birth_date],
  });
  const row = rowToObject(rs);
  cache.users.set(row.id, row);
  cache.usernameIndex.set(row.username.toLowerCase(), row.id);
  return publicUser(row);
}
// Returns the public user object on success, or null on bad username/password.
function verifyLogin(username, password) {
  assertReady();
  const u = getUserByUsername(username);
  if (!u) return null;
  return auth.verifyPassword(password, u.password_salt, u.password_hash) ? publicUser(u) : null;
}

module.exports = {
  init,
  listStrains, countStrains, getStrain, insertStrain, deleteStrain, nextStrainId,
  listFaqs, getFaq, createFaq, updateFaq, deleteFaq,
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe, addKudos,
  listGrowTips, createGrowTip, likeGrowTip,
  createCheckin, listCheckins,
  getCollection, getUniqueOwnedCount, getTotalDupes, getMostCheckedInStrains,
  createTrade, listTrades, countTrades,
  isFollowingDispensary, toggleFollowDispensary, anyDispensaryFollowed,
  isRsvped, toggleRsvp, anyRsvped,
  addToCart, getCartCount,
  createUser, getUserByUsername, getUserById, verifyLogin, publicUser,
};
