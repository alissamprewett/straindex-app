// db.js — SQLite data-access layer.
//
// Every other file in this app talks to the database ONLY through the
// functions exported here. That's deliberate: when you're ready to move to
// a hosted Postgres database (e.g. Supabase), this is the ONLY file you
// need to rewrite. Swap the `DatabaseSync` calls below for `pg` queries
// with the same function names/signatures and nothing else changes.
//
// Uses Node's built-in `node:sqlite` (stable enough for this use, still
// flagged "experimental" by Node itself) — no npm install required.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'straindex.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS strains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    lean TEXT,
    rarity TEXT NOT NULL,
    thc TEXT,
    cbd TEXT,
    terps TEXT NOT NULL,      -- JSON string: [{n,p}, ...]
    effects TEXT NOT NULL,    -- JSON string: ["Relaxed", ...]
    flavor TEXT,
    icon TEXT
  );

  CREATE TABLE IF NOT EXISTS faqs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    time TEXT,
    icon TEXT,
    source TEXT NOT NULL DEFAULT 'community',   -- 'official' | 'community'
    author TEXT,
    kudos INTEGER NOT NULL DEFAULT 0,
    desc TEXT,
    ingredients TEXT NOT NULL,   -- JSON array of strings
    steps TEXT NOT NULL,         -- JSON array of strings
    dosing TEXT,
    status TEXT NOT NULL DEFAULT 'approved',  -- 'pending' | 'approved' | 'rejected'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS grow_tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    author TEXT,
    likes INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strain_id TEXT NOT NULL,
    method TEXT,
    rating INTEGER,
    note TEXT,
    effects TEXT,      -- JSON array of strings
    photo TEXT,         -- data URL or file path
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(strain_id) REFERENCES strains(id)
  );
`);

// ---------- Strains ----------
function listStrains({ q, type, rarity, limit = 60 } = {}) {
  let sql = 'SELECT * FROM strains WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND name LIKE ?'; params.push(`%${q}%`); }
  if (type && type !== 'All') { sql += ' AND type = ?'; params.push(type); }
  if (rarity && rarity !== 'All') { sql += ' AND rarity = ?'; params.push(rarity); }
  sql += ' ORDER BY name ASC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(rowToStrain);
}
function countStrains({ q, type, rarity } = {}) {
  let sql = 'SELECT COUNT(*) AS c FROM strains WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND name LIKE ?'; params.push(`%${q}%`); }
  if (type && type !== 'All') { sql += ' AND type = ?'; params.push(type); }
  if (rarity && rarity !== 'All') { sql += ' AND rarity = ?'; params.push(rarity); }
  return db.prepare(sql).get(...params).c;
}
function getStrain(id) {
  const row = db.prepare('SELECT * FROM strains WHERE id = ?').get(id);
  return row ? rowToStrain(row) : null;
}
function insertStrain(s) {
  db.prepare(`INSERT OR REPLACE INTO strains (id,name,type,lean,rarity,thc,cbd,terps,effects,flavor,icon)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    s.id, s.name, s.type, s.lean || '', s.rarity, s.thc || '', s.cbd || '',
    JSON.stringify(s.terps || []), JSON.stringify(s.effects || []), s.flavor || '', s.icon || '🌿'
  );
}
function rowToStrain(row) {
  return { ...row, terps: JSON.parse(row.terps), effects: JSON.parse(row.effects) };
}

// ---------- FAQs ----------
function listFaqs() {
  return db.prepare('SELECT * FROM faqs ORDER BY sort_order ASC, id ASC').all();
}
function getFaq(id) {
  return db.prepare('SELECT * FROM faqs WHERE id = ?').get(id);
}
function createFaq({ question, answer, sort_order = 0 }) {
  const info = db.prepare('INSERT INTO faqs (question, answer, sort_order) VALUES (?,?,?)').run(question, answer, sort_order);
  return getFaq(Number(info.lastInsertRowid));
}
function updateFaq(id, { question, answer, sort_order }) {
  db.prepare('UPDATE faqs SET question=?, answer=?, sort_order=? WHERE id=?').run(question, answer, sort_order, id);
  return getFaq(id);
}
function deleteFaq(id) {
  db.prepare('DELETE FROM faqs WHERE id = ?').run(id);
}

// ---------- Recipes ----------
function listRecipes({ status = 'approved' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM recipes WHERE status = ? ORDER BY kudos DESC, id DESC').all(status)
    : db.prepare('SELECT * FROM recipes ORDER BY id DESC').all();
  return rows.map(rowToRecipe);
}
function getRecipe(id) {
  const row = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id);
  return row ? rowToRecipe(row) : null;
}
function createRecipe({ title, time, icon, source = 'community', author, desc, ingredients, steps, dosing, status = 'approved', kudos = 0 }) {
  const info = db.prepare(`INSERT INTO recipes (title,time,icon,source,author,kudos,desc,ingredients,steps,dosing,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    title, time || '', icon || '🍽️', source, author || null, kudos,
    desc || '', JSON.stringify(ingredients || []), JSON.stringify(steps || []), dosing || '', status
  );
  return getRecipe(Number(info.lastInsertRowid));
}
function updateRecipe(id, fields) {
  const current = getRecipe(id);
  if (!current) return null;
  const merged = { ...current, ...fields };
  db.prepare(`UPDATE recipes SET title=?, time=?, icon=?, source=?, author=?, desc=?, ingredients=?, steps=?, dosing=?, status=? WHERE id=?`).run(
    merged.title, merged.time, merged.icon, merged.source, merged.author, merged.desc,
    JSON.stringify(merged.ingredients), JSON.stringify(merged.steps), merged.dosing, merged.status, id
  );
  return getRecipe(id);
}
function deleteRecipe(id) {
  db.prepare('DELETE FROM recipes WHERE id = ?').run(id);
}
function addKudos(id) {
  db.prepare('UPDATE recipes SET kudos = kudos + 1 WHERE id = ?').run(id);
  return getRecipe(id);
}
function rowToRecipe(row) {
  return { ...row, ingredients: JSON.parse(row.ingredients), steps: JSON.parse(row.steps) };
}

// ---------- Grow tips ----------
function listGrowTips({ category } = {}) {
  if (category && category !== 'All') {
    return db.prepare('SELECT * FROM grow_tips WHERE category = ? ORDER BY likes DESC, id DESC').all(category);
  }
  return db.prepare('SELECT * FROM grow_tips ORDER BY likes DESC, id DESC').all();
}
function createGrowTip({ title, category, author, body }) {
  const info = db.prepare('INSERT INTO grow_tips (title,category,author,body) VALUES (?,?,?,?)').run(title, category, author || 'You', body);
  return db.prepare('SELECT * FROM grow_tips WHERE id = ?').get(Number(info.lastInsertRowid));
}
function likeGrowTip(id) {
  db.prepare('UPDATE grow_tips SET likes = likes + 1 WHERE id = ?').run(id);
}

// ---------- Check-ins ----------
function createCheckin({ strain_id, method, rating, note, effects, photo }) {
  const info = db.prepare(`INSERT INTO checkins (strain_id, method, rating, note, effects, photo) VALUES (?,?,?,?,?,?)`).run(
    strain_id, method || '', rating || 0, note || '', JSON.stringify(effects || []), photo || null
  );
  return db.prepare('SELECT * FROM checkins WHERE id = ?').get(Number(info.lastInsertRowid));
}
function listCheckins({ strain_id, limit = 100 } = {}) {
  const rows = strain_id
    ? db.prepare('SELECT * FROM checkins WHERE strain_id = ? ORDER BY id DESC LIMIT ?').all(strain_id, limit)
    : db.prepare('SELECT * FROM checkins ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map(r => ({ ...r, effects: JSON.parse(r.effects || '[]') }));
}

module.exports = {
  db,
  listStrains, countStrains, getStrain, insertStrain,
  listFaqs, getFaq, createFaq, updateFaq, deleteFaq,
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe, addKudos,
  listGrowTips, createGrowTip, likeGrowTip,
  createCheckin, listCheckins,
};
