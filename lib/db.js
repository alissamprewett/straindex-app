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
    source_name TEXT,
    source_url TEXT,
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
  `CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    addressee_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
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
  dispensaryFollows: new Map(), // userId -> Set(dispensary_id)
  eventRsvps: new Map(),        // userId -> Set(event_id)
  cartCounts: new Map(),        // userId -> count
  users: new Map(),             // id -> user object (no password fields exposed beyond hash/salt)
  usernameIndex: new Map(),     // lowercase username -> id
  friendships: [],              // { id, requester_id, addressee_id, status, created_at }
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
  return { ...row, terps: JSON.parse(row.terps), effects: JSON.parse(row.effects), ailments: row.ailments ? JSON.parse(row.ailments) : [] };
}
function rowToRecipe(row) {
  return { ...row, ingredients: JSON.parse(row.ingredients), steps: JSON.parse(row.steps), usesBase: row.uses_base ? JSON.parse(row.uses_base) : null };
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
  const faqCols = rowsToObjects(await client.execute('PRAGMA table_info(faqs)')).map(r => r.name);
  if (!faqCols.includes('source_name')) {
    await client.execute('ALTER TABLE faqs ADD COLUMN source_name TEXT');
  }
  if (!faqCols.includes('source_url')) {
    await client.execute('ALTER TABLE faqs ADD COLUMN source_url TEXT');
  }
  const recipeCols3 = rowsToObjects(await client.execute('PRAGMA table_info(recipes)')).map(r => r.name);
  if (!recipeCols3.includes('uses_base')) {
    await client.execute('ALTER TABLE recipes ADD COLUMN uses_base TEXT');
  }
  const strainCols = rowsToObjects(await client.execute('PRAGMA table_info(strains)')).map(r => r.name);
  if (!strainCols.includes('breeder')) {
    await client.execute('ALTER TABLE strains ADD COLUMN breeder TEXT');
  }
  if (!strainCols.includes('ailments')) {
    await client.execute('ALTER TABLE strains ADD COLUMN ailments TEXT');
  }
  const checkinKudosCols = rowsToObjects(await client.execute('PRAGMA table_info(checkins)')).map(r => r.name);
  if (!checkinKudosCols.includes('kudos')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN kudos INTEGER NOT NULL DEFAULT 0');
  }
  const checkinCols = rowsToObjects(await client.execute('PRAGMA table_info(checkins)')).map(r => r.name);
  if (!checkinCols.includes('user_id')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN user_id INTEGER');
  }
  const cartCols = rowsToObjects(await client.execute('PRAGMA table_info(cart_items)')).map(r => r.name);
  if (!cartCols.includes('user_id')) {
    await client.execute('ALTER TABLE cart_items ADD COLUMN user_id INTEGER');
  }
  // Migration: trades/recipes/grow_tips originally had no concept of "who
  // submitted this" — badges based on them were checking app-wide totals
  // instead of a specific account's own activity. Attach user_id so badges
  // can be genuinely personal.
  const tradeCols = rowsToObjects(await client.execute('PRAGMA table_info(trades)')).map(r => r.name);
  if (!tradeCols.includes('user_id')) {
    await client.execute('ALTER TABLE trades ADD COLUMN user_id INTEGER');
  }
  const recipeCols2 = rowsToObjects(await client.execute('PRAGMA table_info(recipes)')).map(r => r.name);
  if (!recipeCols2.includes('user_id')) {
    await client.execute('ALTER TABLE recipes ADD COLUMN user_id INTEGER');
  }
  const growTipCols2 = rowsToObjects(await client.execute('PRAGMA table_info(grow_tips)')).map(r => r.name);
  if (!growTipCols2.includes('user_id')) {
    await client.execute('ALTER TABLE grow_tips ADD COLUMN user_id INTEGER');
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

  cache.friendships = rowsToObjects(await client.execute('SELECT * FROM friendships'));

  ready = true;
}

// ---------- Strains ----------
// Parses a THC string like "18–22%" or "<7% THC, 10–13% CBD" into a
// representative { min, max } pair — only looks at the part before any
// comma, so CBD-focused strains with a combined "X% THC, Y% CBD" label
// don't get their THC range confused with the CBD numbers.
function parseThcRange(thcStr) {
  const firstPart = String(thcStr || '').split(',')[0];
  const nums = (firstPart.match(/\d+(\.\d+)?/g) || []).map(Number);
  if (!nums.length) return { min: null, max: null };
  if (nums.length === 1) return { min: nums[0], max: nums[0] };
  return { min: nums[0], max: nums[1] };
}
function thcBucket(thcStr) {
  const { max } = parseThcRange(thcStr);
  if (max == null) return null;
  if (max <= 15) return 'Low';
  if (max <= 25) return 'Medium';
  return 'High';
}
function matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment }) {
  if (q) {
    const needle = q.toLowerCase();
    const inName = s.name.toLowerCase().includes(needle);
    const inFlavor = s.flavor && s.flavor.toLowerCase().includes(needle);
    if (!inName && !inFlavor) return false;
  }
  if (type && type !== 'All' && s.type !== type) return false;
  if (rarity && rarity !== 'All' && s.rarity !== rarity) return false;
  if (effect && effect !== 'All' && !(Array.isArray(s.effects) && s.effects.includes(effect))) return false;
  if (thc && thc !== 'All' && thcBucket(s.thc) !== thc) return false;
  if (terpene && terpene !== 'All' && !(Array.isArray(s.terps) && s.terps.some(t => t.n === terpene))) return false;
  if (ailment && ailment !== 'All' && !(Array.isArray(s.ailments) && s.ailments.includes(ailment))) return false;
  return true;
}
function listStrains({ q, type, rarity, effect, thc, terpene, ailment, limit = 60 } = {}) {
  assertReady();
  let arr = [...cache.strains.values()].filter(s => matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment }));
  arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr.slice(0, limit);
}
function countStrains({ q, type, rarity, effect, thc, terpene, ailment } = {}) {
  assertReady();
  return [...cache.strains.values()].filter(s => matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment })).length;
}
function getStrain(id) {
  assertReady();
  return cache.strains.get(id) || null;
}
async function insertStrain(s) {
  const terps = JSON.stringify(s.terps || []);
  const effects = JSON.stringify(s.effects || []);
  const ailments = JSON.stringify(s.ailments || []);
  await client.execute({
    sql: `INSERT OR REPLACE INTO strains (id,name,type,lean,rarity,thc,cbd,terps,effects,flavor,icon,breeder,ailments)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [s.id, s.name, s.type, s.lean || '', s.rarity, s.thc || '', s.cbd || '', terps, effects, s.flavor || '', s.icon || '🌿', s.breeder || null, ailments],
  });
  cache.strains.set(s.id, {
    id: s.id, name: s.name, type: s.type, lean: s.lean || '', rarity: s.rarity,
    thc: s.thc || '', cbd: s.cbd || '', terps: s.terps || [], effects: s.effects || [],
    flavor: s.flavor || '', icon: s.icon || '🌿', breeder: s.breeder || null, ailments: s.ailments || [],
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
function listFaqs(q) {
  assertReady();
  if (!q) return cache.faqs;
  const needle = q.toLowerCase();
  return cache.faqs.filter(f =>
    f.question.toLowerCase().includes(needle) ||
    (f.answer && f.answer.toLowerCase().includes(needle))
  );
}
function getFaq(id) {
  assertReady();
  return cache.faqs.find(f => f.id === id) || null;
}
async function createFaq({ question, answer, sort_order = 0, source_name, source_url }) {
  const rs = await client.execute({
    sql: 'INSERT INTO faqs (question, answer, sort_order, source_name, source_url) VALUES (?,?,?,?,?) RETURNING *',
    args: [question, answer, sort_order, source_name || null, source_url || null],
  });
  const row = rowToObject(rs);
  cache.faqs.push(row);
  sortFaqsInPlace();
  return row;
}
async function updateFaq(id, { question, answer, sort_order, source_name, source_url }) {
  await client.execute({
    sql: 'UPDATE faqs SET question=?, answer=?, sort_order=?, source_name=?, source_url=? WHERE id=?',
    args: [question, answer, sort_order, source_name || null, source_url || null, id],
  });
  const idx = cache.faqs.findIndex(f => f.id === id);
  if (idx !== -1) cache.faqs[idx] = { ...cache.faqs[idx], question, answer, sort_order, source_name, source_url };
  sortFaqsInPlace();
  return getFaq(id);
}
async function deleteFaq(id) {
  await client.execute({ sql: 'DELETE FROM faqs WHERE id = ?', args: [id] });
  cache.faqs = cache.faqs.filter(f => f.id !== id);
}

// ---------- Recipes ----------
function listRecipes({ status = 'approved', category, q } = {}) {
  assertReady();
  let arr = cache.recipes;
  if (status) arr = arr.filter(r => r.status === status);
  if (category && category !== 'All') arr = arr.filter(r => r.category === category);
  if (q) {
    const needle = q.toLowerCase();
    arr = arr.filter(r =>
      r.title.toLowerCase().includes(needle) ||
      (r.desc && r.desc.toLowerCase().includes(needle)) ||
      (Array.isArray(r.ingredients) && r.ingredients.some(i => i.toLowerCase().includes(needle)))
    );
  }
  return status
    ? [...arr].sort((a, b) => (b.kudos - a.kudos) || (b.id - a.id))
    : [...arr].sort((a, b) => b.id - a.id);
}
function getRecipe(id) {
  assertReady();
  return cache.recipes.find(r => r.id === id) || null;
}
// For badges: has this specific user contributed something real, not just
// "does this exist somewhere in the app" (which every account would pass).
function hasUserApprovedRecipe(userId) {
  assertReady();
  return cache.recipes.some(r => r.user_id === userId && r.status === 'approved');
}
function hasUserFavoriteRecipe(userId) {
  assertReady();
  return cache.recipes.some(r => r.user_id === userId && r.status === 'approved' && r.kudos >= 10);
}
function hasUserSubmittedGrowTip(userId) {
  assertReady();
  return cache.growTips.some(g => g.user_id === userId);
}
async function createRecipe({ title, time, icon, source = 'community', author, user_id, desc, ingredients, steps, dosing, category = 'Baked Goods', status = 'approved', kudos = 0, usesBase }) {
  const rs = await client.execute({
    sql: `INSERT INTO recipes (title,time,icon,source,author,user_id,kudos,desc,ingredients,steps,dosing,category,status,uses_base)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [
      title, time || '', icon || '🍽️', source, author || null, user_id || null, kudos,
      desc || '', JSON.stringify(ingredients || []), JSON.stringify(steps || []), dosing || '', category, status,
      usesBase && usesBase.length ? JSON.stringify(usesBase) : null,
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
// Backfill helper: sets uses_base on an existing recipe without touching
// anything else, so already-seeded recipes can pick up the field on a
// later deploy without needing a full re-seed.
async function setRecipeUsesBase(id, usesBase) {
  const json = usesBase && usesBase.length ? JSON.stringify(usesBase) : null;
  await client.execute({ sql: 'UPDATE recipes SET uses_base = ? WHERE id = ?', args: [json, id] });
  const idx = cache.recipes.findIndex(r => r.id === id);
  if (idx !== -1) cache.recipes[idx] = { ...cache.recipes[idx], usesBase: usesBase && usesBase.length ? usesBase : null };
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
async function createGrowTip({ title, category, author, user_id, body, source_name, source_url }) {
  const rs = await client.execute({
    sql: 'INSERT INTO grow_tips (title,category,author,user_id,body,source_name,source_url) VALUES (?,?,?,?,?,?,?) RETURNING *',
    args: [title, category, author || 'You', user_id || null, body, source_name || null, source_url || null],
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
// One-off backfill: sets source_name/source_url on an existing grow tip row
// (used by seed.js to fix rows created before this field existed).
async function setGrowTipSource(id, source_name, source_url) {
  await client.execute({ sql: 'UPDATE grow_tips SET source_name = ?, source_url = ? WHERE id = ?', args: [source_name, source_url, id] });
  const idx = cache.growTips.findIndex(g => g.id === id);
  if (idx !== -1) cache.growTips[idx] = { ...cache.growTips[idx], source_name, source_url };
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
async function giveCheckinKudos(id) {
  await client.execute({ sql: 'UPDATE checkins SET kudos = kudos + 1 WHERE id = ?', args: [id] });
  const idx = cache.checkins.findIndex(c => c.id === id);
  if (idx !== -1) { cache.checkins[idx] = { ...cache.checkins[idx], kudos: (cache.checkins[idx].kudos || 0) + 1 }; }
  return idx !== -1 ? cache.checkins[idx] : null;
}
function listCheckins({ userId, userIds, strain_id, limit = 100 } = {}) {
  assertReady();
  let arr = cache.checkins;
  if (userId != null) arr = arr.filter(c => c.user_id === userId);
  if (Array.isArray(userIds)) { const set = new Set(userIds); arr = arr.filter(c => set.has(c.user_id)); }
  if (strain_id) arr = arr.filter(c => c.strain_id === strain_id);
  return [...arr].sort((a, b) => b.id - a.id).slice(0, limit);
}
function getCheckin(id) {
  assertReady();
  return cache.checkins.find(c => c.id === id) || null;
}
// Lets someone revise a check-in after the fact — genuinely useful with
// edibles, where the felt experience often changes well after logging it.
async function updateCheckin(id, { method, rating, note, effects, photo }) {
  const current = getCheckin(id);
  if (!current) return null;
  const merged = {
    ...current,
    method: method !== undefined ? method : current.method,
    rating: rating !== undefined ? rating : current.rating,
    note: note !== undefined ? note : current.note,
    effects: effects !== undefined ? effects : current.effects,
    photo: photo !== undefined ? photo : current.photo,
  };
  await client.execute({
    sql: `UPDATE checkins SET method=?, rating=?, note=?, effects=?, photo=? WHERE id=?`,
    args: [merged.method || '', merged.rating || 0, merged.note || '', JSON.stringify(merged.effects || []), merged.photo || null, id],
  });
  const idx = cache.checkins.findIndex(c => c.id === id);
  if (idx !== -1) cache.checkins[idx] = merged;
  return merged;
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
async function createTrade({ user_id, friend_name, gave_strain_id, got_strain_id }) {
  const rs = await client.execute({
    sql: 'INSERT INTO trades (user_id, friend_name, gave_strain_id, got_strain_id) VALUES (?,?,?,?) RETURNING *',
    args: [user_id || null, friend_name, gave_strain_id, got_strain_id],
  });
  cache.trades.push(rowToObject(rs));
}
function listTrades(userId, limit = 50) {
  assertReady();
  let arr = cache.trades;
  if (userId != null) arr = arr.filter(t => t.user_id === userId);
  return [...arr].sort((a, b) => b.id - a.id).slice(0, limit);
}
function countTrades(userId) {
  assertReady();
  if (userId != null) return cache.trades.filter(t => t.user_id === userId).length;
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
// Throws if the new username is taken by someone else; no-ops cleanly if
// it's unchanged (e.g. just resubmitting the same form).
async function updateUsername(userId, newUsername) {
  const current = getUserById(userId);
  if (!current) throw new Error('User not found.');
  if (newUsername.toLowerCase() === current.username.toLowerCase()) {
    return publicUser(current); // unchanged, nothing to do
  }
  const existing = getUserByUsername(newUsername);
  if (existing && existing.id !== userId) {
    throw new Error('That username is already taken.');
  }
  await client.execute({ sql: 'UPDATE users SET username = ? WHERE id = ?', args: [newUsername, userId] });
  cache.usernameIndex.delete(current.username.toLowerCase());
  const updated = { ...current, username: newUsername };
  cache.users.set(userId, updated);
  cache.usernameIndex.set(newUsername.toLowerCase(), userId);
  return publicUser(updated);
}
// Verifies the current password before allowing the change — same pattern
// any normal app uses to make sure it's really the account owner making
// the change, not someone with a stolen/left-open session.
async function updatePassword(userId, currentPassword, newPassword) {
  const current = getUserById(userId);
  if (!current) throw new Error('User not found.');
  if (!auth.verifyPassword(currentPassword, current.password_salt, current.password_hash)) {
    throw new Error('Current password is incorrect.');
  }
  const { salt, hash } = auth.hashPassword(newPassword);
  await client.execute({ sql: 'UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', args: [hash, salt, userId] });
  cache.users.set(userId, { ...current, password_hash: hash, password_salt: salt });
}
// Username search for "add a friend" — case-insensitive substring match,
// excludes the searcher themselves.
function searchUsers(query, excludeUserId) {
  assertReady();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return [...cache.users.values()]
    .filter(u => u.id !== excludeUserId && u.username.toLowerCase().includes(q))
    .map(publicUser)
    .slice(0, 20);
}

// ---------------------------------------------------------------- Friendships
function findFriendship(userA, userB) {
  return cache.friendships.find(f =>
    (f.requester_id === userA && f.addressee_id === userB) ||
    (f.requester_id === userB && f.addressee_id === userA)
  ) || null;
}
// 'none' | 'pending_sent' | 'pending_received' | 'friends'
function getFriendshipStatus(userId, otherUserId) {
  assertReady();
  const f = findFriendship(userId, otherUserId);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  if (f.requester_id === userId) return 'pending_sent';
  return 'pending_received';
}
async function sendFriendRequest(requesterId, addresseeId) {
  if (requesterId === addresseeId) throw new Error("You can't friend yourself.");
  if (findFriendship(requesterId, addresseeId)) return; // already pending or friends — no-op
  const rs = await client.execute({
    sql: 'INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?,?,\'pending\') RETURNING *',
    args: [requesterId, addresseeId],
  });
  cache.friendships.push(rowToObject(rs));
}
// currentUserId must be the addressee — you can only accept/decline requests sent TO you.
async function respondToFriendRequest(currentUserId, requesterId, accept) {
  const f = findFriendship(currentUserId, requesterId);
  if (!f || f.status !== 'pending' || f.addressee_id !== currentUserId) return;
  if (accept) {
    await client.execute({ sql: "UPDATE friendships SET status = 'accepted' WHERE id = ?", args: [f.id] });
    const idx = cache.friendships.findIndex(x => x.id === f.id);
    cache.friendships[idx] = { ...f, status: 'accepted' };
  } else {
    await client.execute({ sql: 'DELETE FROM friendships WHERE id = ?', args: [f.id] });
    cache.friendships = cache.friendships.filter(x => x.id !== f.id);
  }
}
async function removeFriendship(userId, otherUserId) {
  const f = findFriendship(userId, otherUserId);
  if (!f) return;
  await client.execute({ sql: 'DELETE FROM friendships WHERE id = ?', args: [f.id] });
  cache.friendships = cache.friendships.filter(x => x.id !== f.id);
}
function listFriends(userId) {
  assertReady();
  return cache.friendships
    .filter(f => f.status === 'accepted' && (f.requester_id === userId || f.addressee_id === userId))
    .map(f => publicUser(getUserById(f.requester_id === userId ? f.addressee_id : f.requester_id)))
    .filter(Boolean);
}
function listIncomingRequests(userId) {
  assertReady();
  return cache.friendships
    .filter(f => f.status === 'pending' && f.addressee_id === userId)
    .map(f => publicUser(getUserById(f.requester_id)))
    .filter(Boolean);
}
function listOutgoingRequests(userId) {
  assertReady();
  return cache.friendships
    .filter(f => f.status === 'pending' && f.requester_id === userId)
    .map(f => publicUser(getUserById(f.addressee_id)))
    .filter(Boolean);
}

module.exports = {
  init,
  listStrains, countStrains, getStrain, insertStrain, deleteStrain, nextStrainId,
  listFaqs, getFaq, createFaq, updateFaq, deleteFaq,
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe, addKudos, setRecipeUsesBase,
  hasUserApprovedRecipe, hasUserFavoriteRecipe, hasUserSubmittedGrowTip,
  listGrowTips, createGrowTip, likeGrowTip, setGrowTipSource,
  createCheckin, listCheckins, getCheckin, updateCheckin, giveCheckinKudos,
  getCollection, getUniqueOwnedCount, getTotalDupes, getMostCheckedInStrains,
  createTrade, listTrades, countTrades,
  isFollowingDispensary, toggleFollowDispensary, anyDispensaryFollowed,
  isRsvped, toggleRsvp, anyRsvped,
  addToCart, getCartCount,
  createUser, getUserByUsername, getUserById, verifyLogin, publicUser, searchUsers,
  updateUsername, updatePassword,
  getFriendshipStatus, sendFriendRequest, respondToFriendRequest, removeFriendship,
  listFriends, listIncomingRequests, listOutgoingRequests,
};
