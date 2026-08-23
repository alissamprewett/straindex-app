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
const crypto = require('node:crypto');
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
  `CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    message TEXT NOT NULL,
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
  if (!checkinCols.includes('is_private')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0');
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
  // Migration: check-in "pairings" -- tasting notes and what food/drink,
  // music/entertainment, or activity went well with a strain. All optional.
  const checkinPairingCols = rowsToObjects(await client.execute('PRAGMA table_info(checkins)')).map(r => r.name);
  if (!checkinPairingCols.includes('tasting_notes')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN tasting_notes TEXT');
  }
  if (!checkinPairingCols.includes('pairing_food')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN pairing_food TEXT');
  }
  if (!checkinPairingCols.includes('pairing_entertainment')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN pairing_entertainment TEXT');
  }
  if (!checkinPairingCols.includes('pairing_activity')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN pairing_activity TEXT');
  }
  // Migration: password resets need somewhere to send the reset link, and
  // the original schema never collected an email address at all.
  const userCols = rowsToObjects(await client.execute('PRAGMA table_info(users)')).map(r => r.name);
  if (!userCols.includes('email')) {
    await client.execute('ALTER TABLE users ADD COLUMN email TEXT');
  }
  await client.execute(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Google sign-in: a nullable, unique link from a user row to their Google
  // account ID ("sub" in Google's OAuth response). Nullable because most
  // existing accounts predate this and signed up with a password instead --
  // both paths coexist on the same users table rather than needing a
  // separate accounts table.
  if (!userCols.includes('google_id')) {
    await client.execute('ALTER TABLE users ADD COLUMN google_id TEXT');
  }
  // Tolerance breaks: a simple start/end log, one active (ended_at IS NULL)
  // break per user at a time. Deliberately minimal -- just a timestamp and
  // an optional note, surfaced on the Your Patterns page.
  await client.execute(`CREATE TABLE IF NOT EXISTS tolerance_breaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    note TEXT
  )`);
  // Lightweight comment thread on check-ins, alongside the existing kudos
  // button -- lets the friend feed feel like a conversation, not just a
  // one-way broadcast with a like count.
  await client.execute(`CREATE TABLE IF NOT EXISTS checkin_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkin_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Wishlist: strains a person wants to try, distinct from their Collection
  // (which is derived from actual check-ins -- things they've already had).
  await client.execute(`CREATE TABLE IF NOT EXISTS wishlist (
    user_id INTEGER NOT NULL,
    strain_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, strain_id)
  )`);
  // Grow journal: a private, chronological photo/note log per user for
  // tracking a plant (or several) from seedling to harvest. Deliberately
  // simple -- no separate "plants" table, since a plant nickname in the
  // title field is enough to group related entries visually without
  // forcing structure on someone who's just logging loosely.
  await client.execute(`CREATE TABLE IF NOT EXISTS grow_journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT,
    note TEXT,
    photo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Custom personal lists ("Morning strains", "Date night", "Sleep"), as
  // many as someone wants -- distinct from the single fixed Wishlist,
  // which answers "what do I want to try" rather than "how do I organize
  // what I already know."
  await client.execute(`CREATE TABLE IF NOT EXISTS custom_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS custom_list_items (
    list_id INTEGER NOT NULL,
    strain_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (list_id, strain_id)
  )`);
  // Basic abuse protection -- reports go to a simple admin review queue;
  // blocks are one-directional (only the blocker's own view changes) and
  // also stop the blocked person from sending a new friend request.
  await client.execute(`CREATE TABLE IF NOT EXISTS content_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    content_id TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (blocker_id, blocked_id)
  )`);

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
  cache.emailIndex = new Map([...cache.users.values()].filter(u => u.email).map(u => [u.email.toLowerCase(), u.id]));
  cache.googleIdIndex = new Map([...cache.users.values()].filter(u => u.google_id).map(u => [u.google_id, u.id]));

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
  cache.feedback = rowsToObjects(await client.execute('SELECT * FROM feedback'));
  cache.toleranceBreaks = rowsToObjects(await client.execute('SELECT * FROM tolerance_breaks'));
  cache.checkinComments = rowsToObjects(await client.execute('SELECT * FROM checkin_comments'));
  cache.wishlist = rowsToObjects(await client.execute('SELECT * FROM wishlist'));
  cache.growJournalEntries = rowsToObjects(await client.execute('SELECT * FROM grow_journal_entries'));
  cache.customLists = rowsToObjects(await client.execute('SELECT * FROM custom_lists'));
  cache.customListItems = rowsToObjects(await client.execute('SELECT * FROM custom_list_items'));
  cache.contentReports = rowsToObjects(await client.execute('SELECT * FROM content_reports'));
  cache.userBlocks = rowsToObjects(await client.execute('SELECT * FROM user_blocks'));

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
function matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment, breeder }) {
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
  if (breeder && breeder !== 'All' && s.breeder !== breeder) return false;
  return true;
}
function listStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder, limit = 60 } = {}) {
  assertReady();
  let arr = [...cache.strains.values()].filter(s => matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment, breeder }));
  arr.sort((a, b) => a.name.localeCompare(b.name));
  return arr.slice(0, limit);
}
function countStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder } = {}) {
  assertReady();
  return [...cache.strains.values()].filter(s => matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment, breeder })).length;
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
function listGrowTips({ category, viewerId } = {}) {
  assertReady();
  let arr = cache.growTips;
  if (category && category !== 'All') arr = arr.filter(g => g.category === category);
  if (viewerId != null) arr = arr.filter(g => g.user_id == null || !isBlocked(viewerId, g.user_id));
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
async function createCheckin({ user_id, strain_id, method, rating, note, effects, photo, tasting_notes, pairing_food, pairing_entertainment, pairing_activity, is_private }) {
  const rs = await client.execute({
    sql: `INSERT INTO checkins (user_id, strain_id, method, rating, note, effects, photo, tasting_notes, pairing_food, pairing_entertainment, pairing_activity, is_private) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [user_id, strain_id, method || '', rating || 0, note || '', JSON.stringify(effects || []), photo || null, tasting_notes || '', pairing_food || '', pairing_entertainment || '', pairing_activity || '', is_private ? 1 : 0],
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
// Filters a mixed-ownership list of check-ins (e.g. a feed combining
// several people) down to what `viewerId` is actually allowed to see:
// anyone's public check-ins, plus the viewer's own regardless of privacy.
// Not applied to single-owner self-views (Check-In History, Your Patterns,
// a strain's "Your history" section) since a person always sees all of
// their own data -- and not applied to anonymous aggregates (community
// ratings, Trending) since those never attach a name to a private entry.
function filterVisibleCheckins(checkins, viewerId) {
  return checkins.filter(c => !c.is_private || c.user_id === viewerId);
}
function getCheckin(id) {
  assertReady();
  return cache.checkins.find(c => c.id === id) || null;
}
// Lets someone revise a check-in after the fact — genuinely useful with
// edibles, where the felt experience often changes well after logging it.
async function updateCheckin(id, { method, rating, note, effects, photo, tasting_notes, pairing_food, pairing_entertainment, pairing_activity, is_private }) {
  const current = getCheckin(id);
  if (!current) return null;
  const merged = {
    ...current,
    method: method !== undefined ? method : current.method,
    rating: rating !== undefined ? rating : current.rating,
    note: note !== undefined ? note : current.note,
    effects: effects !== undefined ? effects : current.effects,
    photo: photo !== undefined ? photo : current.photo,
    tasting_notes: tasting_notes !== undefined ? tasting_notes : current.tasting_notes,
    pairing_food: pairing_food !== undefined ? pairing_food : current.pairing_food,
    pairing_entertainment: pairing_entertainment !== undefined ? pairing_entertainment : current.pairing_entertainment,
    pairing_activity: pairing_activity !== undefined ? pairing_activity : current.pairing_activity,
    is_private: is_private !== undefined ? (is_private ? 1 : 0) : current.is_private,
  };
  await client.execute({
    sql: `UPDATE checkins SET method=?, rating=?, note=?, effects=?, photo=?, tasting_notes=?, pairing_food=?, pairing_entertainment=?, pairing_activity=?, is_private=? WHERE id=?`,
    args: [merged.method || '', merged.rating || 0, merged.note || '', JSON.stringify(merged.effects || []), merged.photo || null, merged.tasting_notes || '', merged.pairing_food || '', merged.pairing_entertainment || '', merged.pairing_activity || '', merged.is_private ? 1 : 0, id],
  });
  const idx = cache.checkins.findIndex(c => c.id === id);
  if (idx !== -1) cache.checkins[idx] = merged;
  return merged;
}
async function deleteCheckin(id) {
  await client.execute({ sql: 'DELETE FROM checkins WHERE id = ?', args: [id] });
  cache.checkins = cache.checkins.filter(c => c.id !== id);
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
function getUserByEmail(email) {
  assertReady();
  const id = cache.emailIndex.get(String(email || '').toLowerCase());
  return id != null ? cache.users.get(id) : null;
}
function getUserByGoogleId(googleId) {
  assertReady();
  const id = cache.googleIdIndex.get(googleId);
  return id != null ? cache.users.get(id) : null;
}
// Links a Google account to an EXISTING user row -- used when someone who
// already signed up with a password later signs in with Google using the
// same (Google-verified) email address, so the two paths converge onto one
// account rather than silently creating a duplicate.
async function linkGoogleId(userId, googleId) {
  await client.execute({ sql: 'UPDATE users SET google_id = ? WHERE id = ?', args: [googleId, userId] });
  const u = cache.users.get(userId);
  if (u) { u.google_id = googleId; cache.googleIdIndex.set(googleId, userId); }
  return u ? publicUser(u) : null;
}
// Creates a brand-new account from a Google sign-in. Google doesn't provide
// a birth date, so the caller collects that separately first (age
// verification is a real compliance requirement, not optional). Since the
// users table requires a password hash/salt, a random one is generated
// here that the person will simply never use -- "Forgot password" still
// works as a fallback if they ever want a real one later.
async function createUserFromGoogle({ username, birth_date, email, google_id }) {
  if (getUserByUsername(username)) {
    throw new Error('That username is already taken.');
  }
  const randomPassword = crypto.randomBytes(32).toString('hex');
  const { salt, hash } = auth.hashPassword(randomPassword);
  const rs = await client.execute({
    sql: 'INSERT INTO users (username, password_hash, password_salt, birth_date, email, google_id) VALUES (?,?,?,?,?,?) RETURNING *',
    args: [username, hash, salt, birth_date, email || null, google_id],
  });
  const row = rowToObject(rs);
  cache.users.set(row.id, row);
  cache.usernameIndex.set(row.username.toLowerCase(), row.id);
  if (row.email) cache.emailIndex.set(row.email.toLowerCase(), row.id);
  cache.googleIdIndex.set(google_id, row.id);
  return publicUser(row);
}
function getUserById(id) {
  assertReady();
  return cache.users.get(id) || null;
}
async function createUser({ username, password, birth_date, email }) {
  if (getUserByUsername(username)) {
    throw new Error('That username is already taken.');
  }
  if (email && getUserByEmail(email)) {
    throw new Error('That email is already in use.');
  }
  const { salt, hash } = auth.hashPassword(password);
  const rs = await client.execute({
    sql: 'INSERT INTO users (username, password_hash, password_salt, birth_date, email) VALUES (?,?,?,?,?) RETURNING *',
    args: [username, hash, salt, birth_date, email || null],
  });
  const row = rowToObject(rs);
  cache.users.set(row.id, row);
  cache.usernameIndex.set(row.username.toLowerCase(), row.id);
  if (row.email) cache.emailIndex.set(row.email.toLowerCase(), row.id);
  return publicUser(row);
}
// Returns the public user object on success, or null on bad username/password.
// Accepts either a username or an email in the same field -- existing
// accounts that already have an email on file (from signup, or linked via
// Google sign-in) can use either going forward; a plain username lookup
// still works exactly as before for anyone without an email set.
function verifyLogin(usernameOrEmail, password) {
  assertReady();
  const u = getUserByUsername(usernameOrEmail) || getUserByEmail(usernameOrEmail);
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
async function updateEmail(userId, email) {
  const current = getUserById(userId);
  if (!current) throw new Error('User not found.');
  const existing = getUserByEmail(email);
  if (existing && existing.id !== userId) throw new Error('That email is already in use.');
  const oldEmail = current.email;
  await client.execute({ sql: 'UPDATE users SET email = ? WHERE id = ?', args: [email, userId] });
  cache.users.set(userId, { ...current, email });
  if (oldEmail) cache.emailIndex.delete(oldEmail.toLowerCase());
  if (email) cache.emailIndex.set(email.toLowerCase(), userId);
}
// ---------- password reset tokens ----------
// Tokens are queried directly against Turso rather than the in-memory
// cache -- they're rare, security-sensitive, and single-use, so there's
// no real benefit to caching them, and it sidesteps any staleness risk.
async function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  await client.execute({
    sql: 'INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)',
    args: [token, userId, expiresAt],
  });
  return token;
}
// Validates a token (exists, not expired) and deletes it so it can't be
// reused, in one step. Returns the user_id on success, or null if the
// token is missing, already used, or expired.
async function consumePasswordResetToken(token) {
  const rs = await client.execute({ sql: 'SELECT * FROM password_reset_tokens WHERE token = ?', args: [token] });
  const row = rowToObject(rs);
  if (!row) return null;
  await client.execute({ sql: 'DELETE FROM password_reset_tokens WHERE token = ?', args: [token] });
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}
// Sets a new password directly, no current-password check -- this is
// specifically for the "forgot password" flow, where proving identity
// already happened via the emailed token, not by knowing the old password.
async function resetPasswordWithToken(userId, newPassword) {
  const current = getUserById(userId);
  if (!current) throw new Error('User not found.');
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
  if (isBlocked(addresseeId, requesterId)) throw new Error("This person isn't accepting friend requests.");
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

// ---------- account data export / deletion ----------
// Gathers everything tied to a user account into one plain object,
// suitable for JSON.stringify and a direct download — covers the
// "export my data" request a privacy policy commits to. Excludes
// password_hash/password_salt, since those aren't "your data" in the
// sense someone asking for an export means -- they're auth internals.
function getUserExportData(userId) {
  assertReady();
  const user = cache.users.get(userId);
  if (!user) return null;
  const profile = { id: user.id, username: user.username, birth_date: user.birth_date, created_at: user.created_at };

  const checkins = cache.checkins.filter(c => c.user_id === userId);
  const trades = cache.trades.filter(t => t.user_id === userId);
  const recipesAuthored = cache.recipes.filter(r => r.user_id === userId);
  const growTipsAuthored = cache.growTips.filter(g => g.user_id === userId);
  const followedDispensaries = [...(cache.dispensaryFollows.get(userId) || [])];
  const eventRsvps = [...(cache.eventRsvps.get(userId) || [])];
  const friendships = cache.friendships.filter(f => f.requester_id === userId || f.addressee_id === userId);

  return {
    exported_at: new Date().toISOString(),
    profile, checkins, trades, recipes_authored: recipesAuthored,
    grow_tips_authored: growTipsAuthored, followed_dispensaries: followedDispensaries,
    event_rsvps: eventRsvps, friendships,
  };
}

// Deletes a user's account and all personal data tied to it. Community
// contributions (recipes, grow tips) are kept but de-linked from the
// account (user_id set to NULL, author name replaced) rather than
// deleted outright -- other users may have engaged with that content,
// and it's no longer personal data once it can't be traced back to
// anyone. Everything genuinely personal (check-ins, trades, follows,
// RSVPs, friendships, cart, the account itself) is fully removed.
async function deleteUserAccount(userId) {
  assertReady();
  const user = cache.users.get(userId);
  if (!user) return false;

  await client.execute({ sql: 'DELETE FROM checkins WHERE user_id = ?', args: [userId] });
  await client.execute({ sql: 'DELETE FROM trades WHERE user_id = ?', args: [userId] });
  await client.execute({ sql: 'DELETE FROM cart_items WHERE user_id = ?', args: [userId] });
  await client.execute({ sql: 'DELETE FROM user_dispensary_follows WHERE user_id = ?', args: [userId] });
  await client.execute({ sql: 'DELETE FROM user_event_rsvps WHERE user_id = ?', args: [userId] });
  await client.execute({ sql: 'DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?', args: [userId, userId] });
  await client.execute({ sql: "UPDATE recipes SET user_id = NULL, author = 'Former user' WHERE user_id = ?", args: [userId] });
  await client.execute({ sql: "UPDATE grow_tips SET user_id = NULL, author = 'Former user' WHERE user_id = ?", args: [userId] });
  await client.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userId] });

  // Mirror all of the above in the in-memory cache.
  cache.checkins = cache.checkins.filter(c => c.user_id !== userId);
  cache.trades = cache.trades.filter(t => t.user_id !== userId);
  cache.cartCounts.delete(userId);
  cache.dispensaryFollows.delete(userId);
  cache.eventRsvps.delete(userId);
  cache.friendships = cache.friendships.filter(f => f.requester_id !== userId && f.addressee_id !== userId);
  cache.recipes.forEach(r => { if (r.user_id === userId) { r.user_id = null; r.author = 'Former user'; } });
  cache.growTips.forEach(g => { if (g.user_id === userId) { g.user_id = null; g.author = 'Former user'; } });
  cache.users.delete(userId);
  cache.usernameIndex.delete(user.username.toLowerCase());

  return true;
}

// ---------- analytics snapshot (for the Google Sheets automation) ----------
// Builds everything the daily analytics pull needs from the already-loaded
// cache -- no extra Turso round-trip, since the server already has all of
// this in memory. Mirrors what the standalone analytics.js script computes
// via raw SQL, just sourced from cache instead.
function getAnalyticsSnapshot() {
  assertReady();
  const todayStr = new Date().toISOString().slice(0, 10);
  const isToday = (isoString) => (isoString || '').slice(0, 10) === todayStr;

  const allUsers = [...cache.users.values()];
  const totalUsers = allUsers.length;
  const totalCheckins = cache.checkins.length;

  const activeUserIds7d = new Set();
  const activeUserIds30d = new Set();
  const activatedUserIds = new Set();
  const now = Date.now();
  cache.checkins.forEach(c => {
    if (c.user_id == null) return;
    activatedUserIds.add(c.user_id);
    const ageMs = now - new Date(c.created_at + 'Z').getTime();
    if (ageMs <= 7 * 24 * 60 * 60 * 1000) activeUserIds7d.add(c.user_id);
    if (ageMs <= 30 * 24 * 60 * 60 * 1000) activeUserIds30d.add(c.user_id);
  });
  const activationRate = totalUsers > 0 ? ((activatedUserIds.size / totalUsers) * 100).toFixed(1) : '0.0';

  const contacts = allUsers
    .map(u => ({ id: u.id, username: u.username, email: u.email || '', birth_date: u.birth_date, created_at: u.created_at }))
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

  const newSignupsToday = contacts.filter(u => isToday(u.created_at));

  const checkinsToday = cache.checkins
    .filter(c => isToday(c.created_at))
    .map(c => {
      const user = c.user_id != null ? cache.users.get(c.user_id) : null;
      return {
        username: user ? user.username : '(no account)',
        strain_id: c.strain_id, method: c.method, rating: c.rating,
        note: c.note || '', kudos: c.kudos, created_at: c.created_at,
      };
    });

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_users: totalUsers,
      total_checkins: totalCheckins,
      new_signups_today: newSignupsToday.length,
      checkins_today: checkinsToday.length,
      active_last_7_days: activeUserIds7d.size,
      active_last_30_days: activeUserIds30d.size,
      activation_rate_percent: Number(activationRate),
    },
    contacts,
    new_signups_today: newSignupsToday,
    checkins_today: checkinsToday,
  };
}

// ---------- feedback ----------
// Anyone can submit feedback (logged in or not, though the form requires
// login same as most of the app). Kept dead simple on purpose while in
// beta -- a free-text box, a timestamp, and who sent it if known.
async function createFeedback({ user_id, message }) {
  const rs = await client.execute({
    sql: 'INSERT INTO feedback (user_id, message) VALUES (?, ?) RETURNING *',
    args: [user_id || null, message],
  });
  const row = rowToObject(rs);
  cache.feedback.push(row);
  return row;
}
function listFeedback() {
  assertReady();
  return [...cache.feedback].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// Community rating: average + count of all check-ins ever logged for a
// strain, across every user -- not just the viewer's own history. Ratings
// with no value (0) are excluded so they don't drag the average down.
function getStrainRatingStats(strainId) {
  assertReady();
  const ratings = cache.checkins.filter(c => c.strain_id === strainId && c.rating > 0).map(c => c.rating);
  if (!ratings.length) return { avg: null, count: 0 };
  const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  return { avg: Math.round(avg * 10) / 10, count: ratings.length };
}

// "Similar strains" for a single strain's detail page -- same terpene-
// overlap scoring idea as getRecommendations() in server.js, but centered
// on one strain's own terpene profile rather than a user's whole owned
// collection, so it works for logged-out browsing too.
function getSimilarStrains(strain, limit = 4) {
  assertReady();
  const terpWeight = {};
  (strain.terps || []).forEach(t => { terpWeight[t.n] = (terpWeight[t.n] || 0) + t.p; });
  const candidates = [...cache.strains.values()].filter(s => s.id !== strain.id);
  const scored = candidates.map(s => {
    let score = 0, topShared = null, topShareVal = 0;
    (s.terps || []).forEach(t => {
      const w = (terpWeight[t.n] || 0) * t.p;
      score += w;
      if (terpWeight[t.n] && w > topShareVal) { topShareVal = w; topShared = t.n; }
    });
    return { s, why: topShared, score };
  }).sort((a, b) => b.score - a.score);
  return scored.filter(x => x.score > 0).slice(0, limit);
}

// Personal insights for a single user -- distinct from getAnalyticsSnapshot
// (which is app-wide, for the business dashboard). This looks only at one
// account's own check-ins: what effects come up most, what type/rarity they
// gravitate toward, their highest-rated strain, and their most logged one.
function getUserInsights(userId) {
  assertReady();
  const checkins = cache.checkins.filter(c => c.user_id === userId);
  if (!checkins.length) return null;

  const effectCounts = {};
  checkins.forEach(c => (c.effects || []).forEach(e => { effectCounts[e] = (effectCounts[e] || 0) + 1; }));
  const topEffects = Object.entries(effectCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

  const typeCounts = {};
  const strainCheckinCounts = {};
  const strainRatingSums = {};
  checkins.forEach(c => {
    const s = cache.strains.get(c.strain_id);
    if (s) typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
    strainCheckinCounts[c.strain_id] = (strainCheckinCounts[c.strain_id] || 0) + 1;
    if (c.rating > 0) {
      if (!strainRatingSums[c.strain_id]) strainRatingSums[c.strain_id] = { sum: 0, n: 0 };
      strainRatingSums[c.strain_id].sum += c.rating;
      strainRatingSums[c.strain_id].n += 1;
    }
  });
  const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
  const mostLoggedId = Object.entries(strainCheckinCounts).sort((a, b) => b[1] - a[1])[0];
  const mostLoggedStrain = mostLoggedId ? cache.strains.get(mostLoggedId[0]) : null;

  let topRatedStrain = null, topRatedAvg = 0;
  Object.entries(strainRatingSums).forEach(([id, { sum, n }]) => {
    const avg = sum / n;
    if (avg > topRatedAvg) { topRatedAvg = avg; topRatedStrain = cache.strains.get(id); }
  });

  const methodCounts = {};
  checkins.forEach(c => { methodCounts[c.method] = (methodCounts[c.method] || 0) + 1; });
  const topMethod = Object.entries(methodCounts).sort((a, b) => b[1] - a[1])[0];

  const terpWeight = {};
  checkins.forEach(c => {
    const s = cache.strains.get(c.strain_id);
    if (s) (s.terps || []).forEach(t => { terpWeight[t.n] = (terpWeight[t.n] || 0) + t.p; });
  });
  const topTerpene = Object.entries(terpWeight).sort((a, b) => b[1] - a[1])[0];

  return {
    totalCheckins: checkins.length,
    topEffects,
    topType: topType ? { name: topType[0], count: topType[1] } : null,
    topMethod: topMethod ? { name: topMethod[0], count: topMethod[1] } : null,
    topTerpene: topTerpene ? topTerpene[0] : null,
    mostLoggedStrain: mostLoggedStrain ? { strain: mostLoggedStrain, count: mostLoggedId[1] } : null,
    topRatedStrain: topRatedStrain ? { strain: topRatedStrain, avg: Math.round(topRatedAvg * 10) / 10 } : null,
  };
}

// Tolerance breaks -- one active break per user (ended_at IS NULL).
function getActiveBreak(userId) {
  assertReady();
  return cache.toleranceBreaks.find(b => b.user_id === userId && !b.ended_at) || null;
}
function listToleranceBreaks(userId) {
  assertReady();
  return cache.toleranceBreaks.filter(b => b.user_id === userId).sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
}
async function startToleranceBreak(userId, note) {
  assertReady();
  const existing = getActiveBreak(userId);
  if (existing) return existing; // already on one -- don't start a second
  const rs = await client.execute({
    sql: 'INSERT INTO tolerance_breaks (user_id, note) VALUES (?, ?) RETURNING *',
    args: [userId, note || null],
  });
  const row = rowToObject(rs);
  cache.toleranceBreaks.push(row);
  return row;
}
async function endToleranceBreak(userId) {
  assertReady();
  const active = getActiveBreak(userId);
  if (!active) return null;
  await client.execute({
    sql: "UPDATE tolerance_breaks SET ended_at = datetime('now') WHERE id = ?",
    args: [active.id],
  });
  active.ended_at = new Date().toISOString();
  return active;
}

// Check-in comments -- a lightweight reply thread, separate from kudos.
function listCheckinComments(checkinId, viewerId) {
  assertReady();
  let arr = cache.checkinComments.filter(c => c.checkin_id === checkinId);
  if (viewerId != null) arr = arr.filter(c => !isBlocked(viewerId, c.user_id));
  return arr.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}
async function createCheckinComment({ checkin_id, user_id, body }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO checkin_comments (checkin_id, user_id, body) VALUES (?, ?, ?) RETURNING *',
    args: [checkin_id, user_id, body],
  });
  const row = rowToObject(rs);
  cache.checkinComments.push(row);
  return row;
}

// Wishlist -- strains someone wants to try, kept separate from Collection
// (which only reflects strains they've actually checked into).
function getWishlist(userId) {
  assertReady();
  return cache.wishlist
    .filter(w => w.user_id === userId)
    .sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''))
    .map(w => cache.strains.get(w.strain_id))
    .filter(Boolean);
}
function isInWishlist(userId, strainId) {
  assertReady();
  return cache.wishlist.some(w => w.user_id === userId && w.strain_id === strainId);
}
async function addToWishlist(userId, strainId) {
  assertReady();
  if (isInWishlist(userId, strainId)) return;
  await client.execute({ sql: 'INSERT INTO wishlist (user_id, strain_id) VALUES (?, ?)', args: [userId, strainId] });
  cache.wishlist.push({ user_id: userId, strain_id: strainId, added_at: new Date().toISOString() });
}
async function removeFromWishlist(userId, strainId) {
  assertReady();
  await client.execute({ sql: 'DELETE FROM wishlist WHERE user_id = ? AND strain_id = ?', args: [userId, strainId] });
  cache.wishlist = cache.wishlist.filter(w => !(w.user_id === userId && w.strain_id === strainId));
}

// Grow journal -- a private per-user timeline, newest first.
function listGrowJournal(userId) {
  assertReady();
  return cache.growJournalEntries
    .filter(e => e.user_id === userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
function getGrowJournalEntry(id) {
  assertReady();
  return cache.growJournalEntries.find(e => e.id === id) || null;
}
async function createGrowJournalEntry({ user_id, title, note, photo }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO grow_journal_entries (user_id, title, note, photo) VALUES (?, ?, ?, ?) RETURNING *',
    args: [user_id, title || null, note || null, photo || null],
  });
  const row = rowToObject(rs);
  cache.growJournalEntries.push(row);
  return row;
}
async function deleteGrowJournalEntry(id) {
  assertReady();
  await client.execute({ sql: 'DELETE FROM grow_journal_entries WHERE id = ?', args: [id] });
  cache.growJournalEntries = cache.growJournalEntries.filter(e => e.id !== id);
}

// Social discovery: strains a person's friends have rated highly that
// they haven't tried themselves yet. Pure recombination of data already
// collected for friends, check-ins, and ratings -- no new tracking needed.
function getFriendsPicks(userId, limit = 12) {
  assertReady();
  const friendIds = listFriends(userId).map(f => f.id);
  if (!friendIds.length) return [];
  const ownTried = new Set(listCheckins({ userId, limit: 100000 }).map(c => c.strain_id));
  const friendCheckins = listCheckins({ userIds: friendIds, limit: 100000 }).filter(c => c.rating >= 4 && !c.is_private && !ownTried.has(c.strain_id));
  const byStrain = {};
  friendCheckins.forEach(c => {
    if (!byStrain[c.strain_id]) byStrain[c.strain_id] = { friendIds: new Set(), ratingSum: 0, count: 0 };
    byStrain[c.strain_id].friendIds.add(c.user_id);
    byStrain[c.strain_id].ratingSum += c.rating;
    byStrain[c.strain_id].count += 1;
  });
  return Object.entries(byStrain)
    .map(([strainId, data]) => {
      const s = getStrain(strainId);
      if (!s) return null;
      const friendNames = [...data.friendIds].map(id => { const u = getUserById(id); return u ? u.username : null; }).filter(Boolean);
      return { strain: s, friendCount: data.friendIds.size, avgRating: Math.round((data.ratingSum / data.count) * 10) / 10, friendNames };
    })
    .filter(Boolean)
    .sort((a, b) => b.friendCount - a.friendCount || b.avgRating - a.avgRating)
    .slice(0, limit);
}

// Custom personal lists -- as many as someone wants, distinct from the
// single fixed Wishlist.
function listCustomLists(userId) {
  assertReady();
  return cache.customLists.filter(l => l.user_id === userId).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
function getCustomList(id) {
  assertReady();
  return cache.customLists.find(l => l.id === id) || null;
}
async function createCustomList(userId, name) {
  assertReady();
  const rs = await client.execute({ sql: 'INSERT INTO custom_lists (user_id, name) VALUES (?, ?) RETURNING *', args: [userId, name] });
  const row = rowToObject(rs);
  cache.customLists.push(row);
  return row;
}
async function deleteCustomList(id) {
  assertReady();
  await client.execute({ sql: 'DELETE FROM custom_lists WHERE id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM custom_list_items WHERE list_id = ?', args: [id] });
  cache.customLists = cache.customLists.filter(l => l.id !== id);
  cache.customListItems = cache.customListItems.filter(i => i.list_id !== id);
}
function listCustomListItems(listId) {
  assertReady();
  return cache.customListItems
    .filter(i => i.list_id === listId)
    .map(i => getStrain(i.strain_id))
    .filter(Boolean);
}
function isStrainInList(listId, strainId) {
  assertReady();
  return cache.customListItems.some(i => i.list_id === listId && i.strain_id === strainId);
}
async function addStrainToList(listId, strainId) {
  assertReady();
  if (isStrainInList(listId, strainId)) return;
  await client.execute({ sql: 'INSERT INTO custom_list_items (list_id, strain_id) VALUES (?, ?)', args: [listId, strainId] });
  cache.customListItems.push({ list_id: listId, strain_id: strainId, added_at: new Date().toISOString() });
}
async function removeStrainFromList(listId, strainId) {
  assertReady();
  await client.execute({ sql: 'DELETE FROM custom_list_items WHERE list_id = ? AND strain_id = ?', args: [listId, strainId] });
  cache.customListItems = cache.customListItems.filter(i => !(i.list_id === listId && i.strain_id === strainId));
}

// Basic abuse protection: reports (go to a simple admin queue) and blocks
// (one-directional -- only the blocker's own view changes, and it stops
// the blocked person from sending a new friend request).
async function createReport({ reporter_id, content_type, content_id, reason }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO content_reports (reporter_id, content_type, content_id, reason) VALUES (?, ?, ?, ?) RETURNING *',
    args: [reporter_id, content_type, String(content_id), reason || ''],
  });
  const row = rowToObject(rs);
  cache.contentReports.push(row);
  return row;
}
function listReports({ status } = {}) {
  assertReady();
  let arr = cache.contentReports;
  if (status) arr = arr.filter(r => r.status === status);
  return [...arr].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
async function markReportReviewed(id) {
  assertReady();
  await client.execute({ sql: "UPDATE content_reports SET status = 'reviewed' WHERE id = ?", args: [id] });
  const r = cache.contentReports.find(x => x.id === id);
  if (r) r.status = 'reviewed';
}
function isBlocked(blockerId, otherId) {
  assertReady();
  return cache.userBlocks.some(b => b.blocker_id === blockerId && b.blocked_id === otherId);
}
function listBlockedUsers(blockerId) {
  assertReady();
  return cache.userBlocks
    .filter(b => b.blocker_id === blockerId)
    .map(b => getUserById(b.blocked_id))
    .filter(Boolean);
}
async function blockUser(blockerId, blockedId) {
  assertReady();
  if (blockerId === blockedId || isBlocked(blockerId, blockedId)) return;
  await client.execute({ sql: 'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)', args: [blockerId, blockedId] });
  cache.userBlocks.push({ blocker_id: blockerId, blocked_id: blockedId, created_at: new Date().toISOString() });
  // Blocking ends any existing friendship in either direction -- a block
  // is a stronger, more deliberate signal than just removing a friend.
  if (findFriendship(blockerId, blockedId)) await removeFriendship(blockerId, blockedId);
}
async function unblockUser(blockerId, blockedId) {
  assertReady();
  await client.execute({ sql: 'DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', args: [blockerId, blockedId] });
  cache.userBlocks = cache.userBlocks.filter(b => !(b.blocker_id === blockerId && b.blocked_id === blockedId));
}

module.exports = {
  init,
  listStrains, countStrains, getStrain, insertStrain, deleteStrain, nextStrainId,
  listFaqs, getFaq, createFaq, updateFaq, deleteFaq,
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe, addKudos, setRecipeUsesBase,
  hasUserApprovedRecipe, hasUserFavoriteRecipe, hasUserSubmittedGrowTip,
  listGrowTips, createGrowTip, likeGrowTip, setGrowTipSource,
  createCheckin, listCheckins, filterVisibleCheckins, getCheckin, updateCheckin, deleteCheckin, giveCheckinKudos,
  getCollection, getUniqueOwnedCount, getTotalDupes, getMostCheckedInStrains,
  createTrade, listTrades, countTrades,
  isFollowingDispensary, toggleFollowDispensary, anyDispensaryFollowed,
  isRsvped, toggleRsvp, anyRsvped,
  addToCart, getCartCount,
  createUser, getUserByUsername, getUserByEmail, getUserById, verifyLogin, publicUser, searchUsers,
  updateUsername, updatePassword, updateEmail,
  createPasswordResetToken, consumePasswordResetToken, resetPasswordWithToken,
  getFriendshipStatus, sendFriendRequest, respondToFriendRequest, removeFriendship,
  listFriends, listIncomingRequests, listOutgoingRequests,
  getUserExportData, deleteUserAccount, getAnalyticsSnapshot,
  createFeedback, listFeedback,
  getStrainRatingStats, getSimilarStrains, getUserInsights,
  getActiveBreak, listToleranceBreaks, startToleranceBreak, endToleranceBreak,
  listCheckinComments, createCheckinComment,
  getUserByGoogleId, linkGoogleId, createUserFromGoogle,
  getWishlist, isInWishlist, addToWishlist, removeFromWishlist,
  listGrowJournal, getGrowJournalEntry, createGrowJournalEntry, deleteGrowJournalEntry,
  getFriendsPicks,
  listCustomLists, getCustomList, createCustomList, deleteCustomList,
  listCustomListItems, isStrainInList, addStrainToList, removeStrainFromList,
  createReport, listReports, markReportReviewed,
  isBlocked, listBlockedUsers, blockUser, unblockUser,
};
