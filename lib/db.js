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
  dispensaryFollows: new Set(),
  eventRsvps: new Set(),
  cartCount: 0,
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

  cache.strains = new Map(
    rowsToObjects(await client.execute('SELECT * FROM strains')).map(r => [r.id, rowToStrain(r)])
  );
  cache.faqs = rowsToObjects(await client.execute('SELECT * FROM faqs'));
  sortFaqsInPlace();
  cache.recipes = rowsToObjects(await client.execute('SELECT * FROM recipes')).map(rowToRecipe);
  cache.growTips = rowsToObjects(await client.execute('SELECT * FROM grow_tips'));
  cache.checkins = rowsToObjects(await client.execute('SELECT * FROM checkins')).map(rowToCheckin);
  cache.trades = rowsToObjects(await client.execute('SELECT * FROM trades'));
  cache.dispensaryFollows = new Set(
    rowsToObjects(await client.execute('SELECT dispensary_id FROM dispensary_follows')).map(r => r.dispensary_id)
  );
  cache.eventRsvps = new Set(
    rowsToObjects(await client.execute('SELECT event_id FROM event_rsvps')).map(r => r.event_id)
  );
  const cartRow = rowToObject(await client.execute('SELECT COUNT(*) AS c FROM cart_items'));
  cache.cartCount = cartRow ? Number(cartRow.c) : 0;

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
function listRecipes({ status = 'approved' } = {}) {
  assertReady();
  if (status) {
    return cache.recipes
      .filter(r => r.status === status)
      .sort((a, b) => (b.kudos - a.kudos) || (b.id - a.id));
  }
  return [...cache.recipes].sort((a, b) => b.id - a.id);
}
function getRecipe(id) {
  assertReady();
  return cache.recipes.find(r => r.id === id) || null;
}
async function createRecipe({ title, time, icon, source = 'community', author, desc, ingredients, steps, dosing, status = 'approved', kudos = 0 }) {
  const rs = await client.execute({
    sql: `INSERT INTO recipes (title,time,icon,source,author,kudos,desc,ingredients,steps,dosing,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [
      title, time || '', icon || '🍽️', source, author || null, kudos,
      desc || '', JSON.stringify(ingredients || []), JSON.stringify(steps || []), dosing || '', status,
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
    sql: `UPDATE recipes SET title=?, time=?, icon=?, source=?, author=?, desc=?, ingredients=?, steps=?, dosing=?, status=? WHERE id=?`,
    args: [
      merged.title, merged.time, merged.icon, merged.source, merged.author, merged.desc,
      JSON.stringify(merged.ingredients), JSON.stringify(merged.steps), merged.dosing, merged.status, id,
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
async function createGrowTip({ title, category, author, body }) {
  const rs = await client.execute({
    sql: 'INSERT INTO grow_tips (title,category,author,body) VALUES (?,?,?,?) RETURNING *',
    args: [title, category, author || 'You', body],
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
async function createCheckin({ strain_id, method, rating, note, effects, photo }) {
  const rs = await client.execute({
    sql: `INSERT INTO checkins (strain_id, method, rating, note, effects, photo) VALUES (?,?,?,?,?,?) RETURNING *`,
    args: [strain_id, method || '', rating || 0, note || '', JSON.stringify(effects || []), photo || null],
  });
  const row = rowToCheckin(rowToObject(rs));
  cache.checkins.push(row);
  return row;
}
function listCheckins({ strain_id, limit = 100 } = {}) {
  assertReady();
  let arr = cache.checkins;
  if (strain_id) arr = arr.filter(c => c.strain_id === strain_id);
  return [...arr].sort((a, b) => b.id - a.id).slice(0, limit);
}

// ---------- Collection (derived from check-ins) ----------
function getCollection() {
  assertReady();
  const counts = new Map();
  for (const c of cache.checkins) counts.set(c.strain_id, (counts.get(c.strain_id) || 0) + 1);
  return [...counts.entries()]
    .map(([strain_id, copies]) => ({ strain: getStrain(strain_id), copies }))
    .filter(r => r.strain);
}
function getUniqueOwnedCount() {
  assertReady();
  return new Set(cache.checkins.map(c => c.strain_id)).size;
}
function getTotalDupes() {
  assertReady();
  const counts = new Map();
  for (const c of cache.checkins) counts.set(c.strain_id, (counts.get(c.strain_id) || 0) + 1);
  let total = 0;
  for (const c of counts.values()) total += Math.max(0, c - 1);
  return total;
}
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

// ---------- Dispensary follows ----------
function isFollowingDispensary(id) {
  assertReady();
  return cache.dispensaryFollows.has(id);
}
async function toggleFollowDispensary(id) {
  if (cache.dispensaryFollows.has(id)) {
    await client.execute({ sql: 'DELETE FROM dispensary_follows WHERE dispensary_id = ?', args: [id] });
    cache.dispensaryFollows.delete(id);
  } else {
    await client.execute({ sql: 'INSERT INTO dispensary_follows (dispensary_id) VALUES (?)', args: [id] });
    cache.dispensaryFollows.add(id);
  }
  return cache.dispensaryFollows.has(id);
}
function anyDispensaryFollowed() {
  assertReady();
  return cache.dispensaryFollows.size > 0;
}

// ---------- Event RSVPs ----------
function isRsvped(id) {
  assertReady();
  return cache.eventRsvps.has(id);
}
async function toggleRsvp(id) {
  if (cache.eventRsvps.has(id)) {
    await client.execute({ sql: 'DELETE FROM event_rsvps WHERE event_id = ?', args: [id] });
    cache.eventRsvps.delete(id);
  } else {
    await client.execute({ sql: 'INSERT INTO event_rsvps (event_id) VALUES (?)', args: [id] });
    cache.eventRsvps.add(id);
  }
  return cache.eventRsvps.has(id);
}
function anyRsvped() {
  assertReady();
  return cache.eventRsvps.size > 0;
}

// ---------- Shop cart ----------
async function addToCart(itemId) {
  await client.execute({ sql: 'INSERT INTO cart_items (item_id) VALUES (?)', args: [itemId] });
  cache.cartCount += 1;
}
function getCartCount() {
  assertReady();
  return cache.cartCount;
}

module.exports = {
  init,
  listStrains, countStrains, getStrain, insertStrain,
  listFaqs, getFaq, createFaq, updateFaq, deleteFaq,
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe, addKudos,
  listGrowTips, createGrowTip, likeGrowTip,
  createCheckin, listCheckins,
  getCollection, getUniqueOwnedCount, getTotalDupes, getMostCheckedInStrains,
  createTrade, listTrades, countTrades,
  isFollowingDispensary, toggleFollowDispensary, anyDispensaryFollowed,
  isRsvped, toggleRsvp, anyRsvped,
  addToCart, getCartCount,
};
