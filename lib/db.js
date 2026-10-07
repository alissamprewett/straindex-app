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

// Every "self-added" (free-text) check-in points at this one placeholder
// strain row, and carries the name the person typed in its own
// custom_strain_name column. The placeholder exists only so the
// checkins.strain_id foreign key stays satisfied -- it is deliberately
// NEVER loaded into cache.strains, so it can't show up in search, the
// library, Collection, Trending, recommendations, or any other list.
const CUSTOM_STRAIN_ID = 'custom';

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
    icon TEXT,
    aka TEXT
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
  // User-submitted "this strain is missing" reports -- a photo of the
  // packaging and/or a text description, reviewed by hand before anything
  // gets added to the real strain library. Deliberately a SEPARATE table
  // from `strains` itself, not a half-verified row inserted directly into
  // it, so an unreviewed submission can never accidentally show up in
  // search results before someone's actually looked at it.
  `CREATE TABLE IF NOT EXISTS strain_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    strain_name TEXT NOT NULL,
    description TEXT,
    photo TEXT,
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
  checkinKudos: [],              // { checkin_id, user_id, created_at } -- who gave kudos to what
  commentLikes: [],              // { comment_id, user_id, created_at } -- who liked which comment
  messages: [],                   // { id, sender_id, recipient_id, body, shared_strain_id, created_at, read_at }
  forumThreads: [],                // { id, user_id, section, title, body, created_at }
  forumReplies: [],                // { id, thread_id, user_id, body, created_at }
  infusionBatches: [],             // { id, user_id, item_key, custom_name, made_on, notes, created_at }
  commentMentions: [],             // { id, comment_id, checkin_id, mentioning_user_id, mentioned_user_id, created_at, read_at }
  checkinReactions: [],            // { id, checkin_id, user_id, reaction, created_at }
  checkinNotifications: [],        // { id, user_id, type, actor_user_id, checkin_id, comment_id, reaction, created_at, read_at }
  userBadgesSeen: [],              // { user_id, badge_key, created_at }
  recipeFavorites: [],             // { user_id, recipe_id, added_at }
  recipeComments: [],              // { id, recipe_id, user_id, body, created_at }
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
  return { ...row, terps: JSON.parse(row.terps), effects: JSON.parse(row.effects), ailments: row.ailments ? JSON.parse(row.ailments) : [], parents: row.parents ? JSON.parse(row.parents) : [], awards: row.awards ? JSON.parse(row.awards) : [] };
}
function rowToRecipe(row) {
  return { ...row, ingredients: JSON.parse(row.ingredients), steps: JSON.parse(row.steps), usesBase: row.uses_base ? JSON.parse(row.uses_base) : null };
}
function rowToCheckin(row) {
  let pairings = row.pairings ? JSON.parse(row.pairings) : [];
  // Backward compatibility: a check-in logged before the pairings migration
  // has its data sitting in the three old fixed columns instead. Synthesize
  // an equivalent pairings array from whichever of those are actually
  // filled in, so old check-ins keep displaying correctly without a data
  // migration script touching every row.
  if (!pairings.length) {
    if (row.pairing_food) pairings.push({ type: 'food', note: row.pairing_food });
    if (row.pairing_entertainment) pairings.push({ type: 'music', note: row.pairing_entertainment });
    if (row.pairing_activity) pairings.push({ type: 'activity', note: row.pairing_activity });
  }
  return { ...row, effects: JSON.parse(row.effects || '[]'), pairings };
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
  // 'beginner' | 'intermediate' | 'advanced' -- lets someone new to edibles
  // filter away from an accidentally high-potency recipe as their first one.
  const recipeCols4 = rowsToObjects(await client.execute('PRAGMA table_info(recipes)')).map(r => r.name);
  if (!recipeCols4.includes('difficulty')) {
    await client.execute("ALTER TABLE recipes ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'beginner'");
  }
  const strainCols = rowsToObjects(await client.execute('PRAGMA table_info(strains)')).map(r => r.name);
  if (!strainCols.includes('breeder')) {
    await client.execute('ALTER TABLE strains ADD COLUMN breeder TEXT');
  }
  if (!strainCols.includes('ailments')) {
    await client.execute('ALTER TABLE strains ADD COLUMN ailments TEXT');
  }
  if (!strainCols.includes('parents')) {
    await client.execute('ALTER TABLE strains ADD COLUMN parents TEXT');
  }
  if (!strainCols.includes('aka')) {
    await client.execute('ALTER TABLE strains ADD COLUMN aka TEXT');
  }
  if (!strainCols.includes('awards')) {
    // JSON array of { name, year } -- e.g. [{ "name": "Leafly Strain of the Year", "year": 2025 }].
    // Only ever populated from a real, verifiable, named award; never inferred.
    await client.execute('ALTER TABLE strains ADD COLUMN awards TEXT');
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
  // Migration: self-added strains. A check-in logged against a strain that
  // isn't in the library yet stores the name the person typed here, and
  // points strain_id at the hidden CUSTOM_STRAIN_ID placeholder row.
  if (!checkinCols.includes('custom_strain_name')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN custom_strain_name TEXT');
  }
  await client.execute({
    sql: 'INSERT OR IGNORE INTO strains (id,name,type,rarity,terps,effects,icon) VALUES (?,?,?,?,?,?,?)',
    args: [CUSTOM_STRAIN_ID, 'Self-added strain', 'Hybrid', 'common', '[]', '[]', '🌿'],
  });
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
  // Migration: grow tips now go through the same pending/approved review
  // queue recipes already use, instead of publishing the moment someone
  // hits submit. Defaults existing rows to 'approved' so every tip already
  // on the site (seeded editorial content, anything submitted before this
  // migration) stays visible without needing anyone to manually re-approve
  // a backlog.
  if (!growTipCols2.includes('status')) {
    await client.execute("ALTER TABLE grow_tips ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
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
  // Migration: pairings moved from three fixed fields (food/entertainment/
  // activity) to an open-ended list -- someone can now log as many pairings
  // as they want, each with a type (chosen from a small fixed vocabulary,
  // see PAIRING_TYPES in server.js) and a free-text note. Stored as a single
  // JSON array column rather than a separate table since it's small,
  // read-mostly, and always loaded together with the rest of the check-in.
  // The old three columns are left in place (unread by new code, but still
  // there) so existing check-ins made before this migration keep their data
  // -- rowToCheckin() below synthesizes a pairings array from them on read
  // for any row that predates this column.
  if (!checkinPairingCols.includes('pairings')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN pairings TEXT');
  }
  // Migration: brand -- the same strain can taste and hit differently
  // depending on who grew/processed it, so let people optionally note
  // which brand's version of a strain they're logging. Free text rather
  // than a fixed list since there's no canonical brand directory here.
  if (!checkinPairingCols.includes('brand')) {
    await client.execute('ALTER TABLE checkins ADD COLUMN brand TEXT');
  }
  // Migration: password resets need somewhere to send the reset link, and
  // the original schema never collected an email address at all.
  const userCols = rowsToObjects(await client.execute('PRAGMA table_info(users)')).map(r => r.name);
  if (!userCols.includes('email')) {
    await client.execute('ALTER TABLE users ADD COLUMN email TEXT');
  }
  // Migration: first/last name -- collected at signup starting now so
  // contact exports (e.g. the analytics Google Sheet) have a real name to
  // show, not just a username. Existing accounts predate this and will
  // have NULL here until/unless they update their profile.
  if (!userCols.includes('first_name')) {
    await client.execute('ALTER TABLE users ADD COLUMN first_name TEXT');
  }
  if (!userCols.includes('last_name')) {
    await client.execute('ALTER TABLE users ADD COLUMN last_name TEXT');
  }
  // A short, self-written profile blurb -- what turns a profile page into
  // an identity instead of just a stats readout.
  if (!userCols.includes('bio')) {
    await client.execute('ALTER TABLE users ADD COLUMN bio TEXT');
  }
  // Whether the person dismissed the "finish setting up your account"
  // card on Home specifically -- the checklist itself never goes away
  // (it's always reachable, and always shown, on Account Settings), this
  // just stops the Home card from nagging once they've said not now.
  if (!userCols.includes('onboarding_card_dismissed')) {
    await client.execute('ALTER TABLE users ADD COLUMN onboarding_card_dismissed INTEGER DEFAULT 0');
  }
  // Who referred this signup, captured from the ?ref=username invite link
  // (see pageInvite/pageSignup) -- nullable since most existing accounts
  // predate this and most future ones will still sign up unreferred.
  if (!userCols.includes('invited_by')) {
    await client.execute('ALTER TABLE users ADD COLUMN invited_by INTEGER');
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
  // Rate limiting, persisted rather than kept in an in-memory Map. The
  // original in-memory version reset its whole counter on every Render
  // restart or redeploy -- meaning the "5 attempts per 15 minutes" limit
  // was really more like "5 attempts per 15 minutes, unless the free-tier
  // service happened to spin down and back up in the meantime," which
  // defeats the point against a patient attacker. created_at is written
  // explicitly as a JS ISO string (not the SQL default) so it can be
  // compared the same way expires_at is elsewhere in this file -- by
  // parsing in JS, not comparing raw date strings in SQL.
  await client.execute(`CREATE TABLE IF NOT EXISTS rate_limit_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket TEXT NOT NULL,
    rl_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
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
  // Comments on recipes -- recipes already have Kudos as their
  // appreciation mechanic, so this is comments only, not a second
  // reaction system. A simpler mirror of checkin_comments: no
  // per-comment likes (not asked for here), but blocked users are still
  // filtered out, same moderation model as everywhere else.
  await client.execute(`CREATE TABLE IF NOT EXISTS recipe_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Replaces the old single-button Kudos on check-ins with a small set of
  // named reactions (nice/fire/whoa/relatable -- see REACTIONS in
  // server.js for icons/labels). One reaction per person per check-in,
  // Facebook-style: picking a different one replaces your old pick rather
  // than stacking. The legacy checkin_kudos table/column are left alone
  // (old data, no longer written to) rather than migrated or dropped.
  await client.execute(`CREATE TABLE IF NOT EXISTS checkin_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkin_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    reaction TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(checkin_id, user_id)
  )`);
  // Alerts the owner of a check-in when someone comments on or reacts to
  // it -- @mentions already have their own dedicated comment_mentions
  // table/page, this covers the other two engagement types so people
  // actually find out their post got a response instead of only
  // discovering it by re-scrolling past it later. One row per comment
  // (each is a genuinely distinct event); reactions instead update the
  // existing row for that (checkin, reactor) pair rather than stacking a
  // new one every time someone flips between reaction types.
  await client.execute(`CREATE TABLE IF NOT EXISTS checkin_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor_user_id INTEGER NOT NULL,
    checkin_id INTEGER NOT NULL,
    comment_id INTEGER,
    reaction TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  )`);
  // Tracks which badges (see computeBadges in server.js) a person has
  // already had a celebration moment for, so crossing a threshold only
  // triggers the toast once rather than every time Home loads afterward.
  // Badges themselves are still computed live from real stats every time
  // (see computeBadges) -- this table only remembers "has this one
  // already been celebrated," not whether it's currently earned.
  await client.execute(`CREATE TABLE IF NOT EXISTS user_badges_seen (
    user_id INTEGER NOT NULL,
    badge_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, badge_key)
  )`);
  // @mentions inside a comment -- checkin_id is denormalized onto the row
  // (rather than joined through comment_id every time) since the main
  // read pattern is "every post I've been tagged in", not "every mention
  // on this one comment". read_at is null until the mentioned person
  // views their Mentions page.
  await client.execute(`CREATE TABLE IF NOT EXISTS comment_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id INTEGER NOT NULL,
    checkin_id INTEGER NOT NULL,
    mentioning_user_id INTEGER NOT NULL,
    mentioned_user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  )`);
  // Attribution log for check-in kudos -- the `kudos` counter column on
  // checkins stays as-is for backward compatibility with anything reading
  // it directly, but this table is the source of truth for *who* gave
  // kudos, and also naturally enforces one kudos per person per check-in
  // (previously the raw counter could be incremented repeatedly by the
  // same person with no record of it).
  await client.execute(`CREATE TABLE IF NOT EXISTS checkin_kudos (
    checkin_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (checkin_id, user_id)
  )`);
  // Likes on individual check-in comments -- toggleable (like/unlike),
  // unlike kudos which is a one-way appreciation action.
  await client.execute(`CREATE TABLE IF NOT EXISTS comment_likes (
    comment_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (comment_id, user_id)
  )`);
  // Direct messages between friends. shared_strain_id is set when a
  // message is really a strain share -- body can be null in that case (a
  // pure share, no extra note) or hold a caption the sender added
  // alongside the shared strain. Messaging is restricted to accepted
  // friendships (enforced in sendMessage, not at the schema level).
  await client.execute(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    body TEXT,
    shared_strain_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at TEXT
  )`);
  // Wishlist: strains a person wants to try, distinct from their Collection
  // (which is derived from actual check-ins -- things they've already had).
  await client.execute(`CREATE TABLE IF NOT EXISTS wishlist (
    user_id INTEGER NOT NULL,
    strain_id TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, strain_id)
  )`);
  // Recipe favorites -- the same "save for later" bookmark Wishlist gives
  // strains, just for recipes. Deliberately separate from Kudos: Kudos is
  // community appreciation (anyone can see the count), a favorite is a
  // private personal bookmark, same distinction Wishlist already draws
  // against check-in history for strains.
  await client.execute(`CREATE TABLE IF NOT EXISTS recipe_favorites (
    user_id INTEGER NOT NULL,
    recipe_id INTEGER NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, recipe_id)
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
  // Puff Puff Ask: a lightweight community forum. Sections deliberately
  // reuse the same filter dimensions already used in the Strain Library
  // (Type, Effect, Terpene, Ailment/Relief, Rarity) plus a General
  // catch-all, rather than inventing a separate taxonomy -- stored as a
  // free-text column (not a foreign key) since the section list is small,
  // fixed in code (FORUM_SECTIONS in server.js), and never user-authored.
  await client.execute(`CREATE TABLE IF NOT EXISTS forum_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    section TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS forum_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Best-By Calendar: tracks homemade infusions/edibles a person has made
  // (cannabutter, infused oil, tincture, etc.) so they can see a use-by date
  // instead of guessing. item_key maps to INFUSION_SHELF_LIFE in server.js;
  // custom_name is an optional personal label (e.g. "Grandma's brownies").
  await client.execute(`CREATE TABLE IF NOT EXISTS infusion_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_key TEXT NOT NULL,
    custom_name TEXT,
    made_on TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Migration: every grow tip and community recipe created through the app
  // itself requires a logged-in submitter (see createGrowTip/createRecipe
  // callers), so user_id is always set going forward. Any row with no
  // user_id predates real accounts -- leftover early-testing content, like
  // a grow tip attributed to an invented name ("Jordan") rather than a real
  // person. Rather than let that read as a real user's post, attribute it
  // honestly to Admin. Safe to run every boot: once relabeled, these rows
  // no longer match the WHERE clause.
  await client.execute("UPDATE grow_tips SET author = 'Admin' WHERE user_id IS NULL AND (author IS NULL OR author != 'Admin')");
  await client.execute("UPDATE recipes SET author = 'Admin' WHERE user_id IS NULL AND source = 'community' AND (author IS NULL OR author != 'Admin')");

  // Migration: 19 of the "official" starter recipes shipped with fabricated
  // kudos counts baked into the seed data (e.g. Classic Cannabutter started
  // at 41, Classic Weed Brownies at 58) -- fake "X people found this
  // helpful" social proof that was never real. Recipe kudos has no
  // per-click history (just one counter, bumped anonymously by
  // apiKudos/addKudos), so a live recipe's current count could now be
  // partly or entirely real clicks from actual users since launch. Zeroing
  // the column outright would erase any of that genuine engagement, so
  // instead this subtracts exactly the known fake starting amount from
  // each -- honest either way: 0 if nobody's clicked it since, or the real
  // number of genuine clicks if they have. Tracked in migrations_applied
  // so it only ever runs once, rather than repeatedly subtracting on every
  // boot.
  await client.execute(`CREATE TABLE IF NOT EXISTS migrations_applied (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const FAKE_KUDOS_MIGRATION = 'strip_fake_official_recipe_kudos_2026_09';
  const alreadyRan = rowsToObjects(await client.execute({
    sql: 'SELECT 1 FROM migrations_applied WHERE name = ?', args: [FAKE_KUDOS_MIGRATION],
  })).length > 0;
  if (!alreadyRan) {
    const FAKE_RECIPE_KUDOS = {
      'Classic Cannabutter': 41, 'Canna-Infused Olive Oil': 27, 'No-Bake Cannabutter Bites': 33,
      'Classic Weed Brownies': 58, 'DIY Cannabis Tincture': 19, 'Cannabis Fruit Gummies': 44,
      'Cannabis-Infused Coconut Oil': 22, 'Cannabis-Infused Honey': 15, 'Firecrackers': 26,
      'Cannabis Chocolate Bark': 31, 'Cannabis-Infused Peanut Butter': 18, 'Cannabis Golden Milk Tea': 21,
      'Cannabis Tincture Lemonade': 24, 'Cannabis Chocolate Chip Cookies': 37, 'Cannabis Caramels': 20,
      'Cannabis Topical Salve': 16, 'Cannabis Bath Soak': 13, 'Cannabis-Infused Popcorn': 28,
      'Cannabis-Infused Pesto': 17,
    };
    for (const [title, fakeAmount] of Object.entries(FAKE_RECIPE_KUDOS)) {
      await client.execute({
        sql: "UPDATE recipes SET kudos = MAX(0, kudos - ?) WHERE title = ? AND source = 'official'",
        args: [fakeAmount, title],
      });
    }
    await client.execute({ sql: 'INSERT INTO migrations_applied (name) VALUES (?)', args: [FAKE_KUDOS_MIGRATION] });
  }

  cache.strains = new Map(
    rowsToObjects(await client.execute({ sql: 'SELECT * FROM strains WHERE id != ?', args: [CUSTOM_STRAIN_ID] })).map(r => [r.id, rowToStrain(r)])
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
  cache.strainSubmissions = rowsToObjects(await client.execute('SELECT * FROM strain_submissions'));
  cache.toleranceBreaks = rowsToObjects(await client.execute('SELECT * FROM tolerance_breaks'));
  cache.checkinComments = rowsToObjects(await client.execute('SELECT * FROM checkin_comments'));
  cache.recipeComments = rowsToObjects(await client.execute('SELECT * FROM recipe_comments'));
  cache.commentMentions = rowsToObjects(await client.execute('SELECT * FROM comment_mentions'));
  cache.checkinReactions = rowsToObjects(await client.execute('SELECT * FROM checkin_reactions'));
  cache.checkinNotifications = rowsToObjects(await client.execute('SELECT * FROM checkin_notifications'));
  cache.userBadgesSeen = rowsToObjects(await client.execute('SELECT * FROM user_badges_seen'));
  cache.checkinKudos = rowsToObjects(await client.execute('SELECT * FROM checkin_kudos'));
  cache.commentLikes = rowsToObjects(await client.execute('SELECT * FROM comment_likes'));
  cache.messages = rowsToObjects(await client.execute('SELECT * FROM messages'));
  cache.wishlist = rowsToObjects(await client.execute('SELECT * FROM wishlist'));
  cache.recipeFavorites = rowsToObjects(await client.execute('SELECT * FROM recipe_favorites'));
  cache.growJournalEntries = rowsToObjects(await client.execute('SELECT * FROM grow_journal_entries'));
  cache.customLists = rowsToObjects(await client.execute('SELECT * FROM custom_lists'));
  cache.customListItems = rowsToObjects(await client.execute('SELECT * FROM custom_list_items'));
  cache.contentReports = rowsToObjects(await client.execute('SELECT * FROM content_reports'));
  cache.userBlocks = rowsToObjects(await client.execute('SELECT * FROM user_blocks'));
  cache.forumThreads = rowsToObjects(await client.execute('SELECT * FROM forum_threads'));
  cache.forumReplies = rowsToObjects(await client.execute('SELECT * FROM forum_replies'));
  cache.infusionBatches = rowsToObjects(await client.execute('SELECT * FROM infusion_batches'));

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
// Duplicated from server.js's strainVerificationTier -- kept in sync
// manually since db.js and server.js don't share a module boundary here.
// Computed live from data completeness, not a stored flag.
function verificationTier(s) {
  const hasThc = !!s.thc;
  const hasBreeder = !!s.breeder;
  const hasDetail = !!s.flavor || (Array.isArray(s.terps) && s.terps.length > 0);
  const hasGenetics = Array.isArray(s.parents) && s.parents.length > 0;
  // "Verified" keeps its original meaning (thc + breeder + flavor/terps) so
  // nothing already showing that badge quietly loses it. A strain that
  // clears that bar *and* has a documented cross gets bumped to
  // "fully-verified" instead -- genetics is some of the hardest-won data
  // in this library and deserves to visibly rank above a strain that's
  // missing it, without punishing everything that came before this field
  // was tracked.
  if (hasThc && hasBreeder && hasDetail) return hasGenetics ? 'fully-verified' : 'verified';
  const score = [hasThc, hasBreeder, hasDetail, hasGenetics].filter(Boolean).length;
  if (score >= 1) return 'partial';
  return 'listed';
}
// Lowercase, accent-stripped, letters-and-digits-only form of a string,
// used to compare names without caring about punctuation or spacing.
function normSearch(str) {
  return String(str || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');
}
// Lower rank = better match. Exact name, then name starts-with, then name
// contains, then alias exact, then alias contains, then flavor-only.
function searchRank(s, raw, needle) {
  const name = s.name.toLowerCase();
  const nName = normSearch(s.name);
  if (name === raw || (needle && nName === needle)) return 0;
  if (name.startsWith(raw) || (needle && nName.startsWith(needle))) return 1;
  if (name.includes(raw) || (needle && nName.includes(needle))) return 2;
  const aka = s.aka ? String(s.aka) : '';
  if (aka) {
    const tokens = aka.split(',').map(t => t.trim()).filter(Boolean);
    if (tokens.some(t => t.toLowerCase() === raw || (needle && normSearch(t) === needle))) return 3;
    if (aka.toLowerCase().includes(raw) || (needle && normSearch(aka).includes(needle))) return 4;
  }
  return 5;
}
function matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment, breeder, verified }) {
  if (q) {
    // Matches the name, any alias (aka), or the flavor text. Punctuation,
    // spacing, accents and case are ignored on both sides, so "gelato 33"
    // finds "Gelato #33" and "garlic butter" finds the strain listed as
    // Garlic Budder (Garlic Butter is one of its aliases).
    const raw = q.toLowerCase().trim();
    const needle = normSearch(q);
    const hit = (text) => {
      if (!text) return false;
      const t = String(text);
      return t.toLowerCase().includes(raw) || (needle !== '' && normSearch(t).includes(needle));
    };
    if (!hit(s.name) && !hit(s.flavor) && !hit(s.aka)) return false;
  }
  if (type && type !== 'All' && s.type !== type) return false;
  if (rarity && rarity !== 'All' && s.rarity !== rarity) return false;
  if (effect && effect !== 'All' && !(Array.isArray(s.effects) && s.effects.includes(effect))) return false;
  if (thc && thc !== 'All' && thcBucket(s.thc) !== thc) return false;
  if (terpene && terpene !== 'All' && !(Array.isArray(s.terps) && s.terps.some(t => t.n === terpene))) return false;
  if (ailment && ailment !== 'All' && !(Array.isArray(s.ailments) && s.ailments.includes(ailment))) return false;
  if (breeder && breeder !== 'All' && s.breeder !== breeder) return false;
  if (verified && verified !== 'All') {
    const tier = verificationTier(s);
    // "verified" is treated as a floor, not an exact tier match -- a
    // fully-verified strain (verified + documented genetics) still counts
    // as satisfying a plain "Verified" filter. "fully-verified" itself is
    // still selectable separately for someone who specifically wants only
    // the strains with a documented cross.
    const ok = verified === 'verified' ? (tier === 'verified' || tier === 'fully-verified') : tier === verified;
    if (!ok) return false;
  }
  return true;
}
function listStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder, verified, limit = 60, offset = 0 } = {}) {
  assertReady();
  let arr = [...cache.strains.values()].filter(s => matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment, breeder, verified }));
  if (q) {
    // Best matches first (exact name, name prefix, alias...), alphabetical within a tier.
    const raw = q.toLowerCase().trim();
    const needle = normSearch(q);
    const ranked = arr.map(s => ({ s, r: searchRank(s, raw, needle) }));
    ranked.sort((a, b) => a.r - b.r || a.s.name.localeCompare(b.s.name));
    arr = ranked.map(x => x.s);
  } else {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return arr.slice(offset, offset + limit);
}
// The unsorted, unfiltered escape hatch for internal callers that want
// "every strain" rather than a page of search results -- recommendations,
// the quiz, family-tree lookups, the terpene/effects/breeder guides, and
// so on. listStrains({ limit: 5000 }) technically works for this but pays
// for a full localeCompare-based sort of the whole library on every call,
// even though every one of those callers either throws that ordering away
// immediately (a scoring sort, a random shuffle) or never depended on it
// in the first place (a plain .find(), a random pick, a tally by name).
// Sorting is real, measurable work at this scale -- collation-aware string
// comparison across ~5,500 items, every time -- so skipping it here is a
// straightforward win with no behavior change for any of those callers.
// Return it as a plain array (not the live Map) so a caller filtering or
// sorting it in place can never mutate the shared cache by accident.
function listAllStrains() {
  assertReady();
  return [...cache.strains.values()];
}
function countStrains({ q, type, rarity, effect, thc, terpene, ailment, breeder, verified } = {}) {
  assertReady();
  return [...cache.strains.values()].filter(s => matchesFilters(s, { q, type, rarity, effect, thc, terpene, ailment, breeder, verified })).length;
}
function getStrain(id) {
  assertReady();
  return cache.strains.get(id) || null;
}
async function insertStrain(s) {
  const terps = JSON.stringify(s.terps || []);
  const effects = JSON.stringify(s.effects || []);
  const ailments = JSON.stringify(s.ailments || []);
  const parents = JSON.stringify(s.parents || []);
  // Only ever set from a real, verifiable, named award ({ name, year }) --
  // never inferred from popularity, ratings, or anything else.
  const awards = JSON.stringify(s.awards || []);
  // aka (alternate/nickname strain names) is stored as a single plain
  // comma-separated string rather than JSON, matching how it's edited in
  // the admin form and displayed on the strain page -- but accept an
  // array here too (some batch-import data still has it as an array)
  // so callers don't have to think about the on-disk format.
  const aka = Array.isArray(s.aka) ? s.aka.filter(Boolean).join(', ') : (s.aka || '');
  await client.execute({
    sql: `INSERT OR REPLACE INTO strains (id,name,type,lean,rarity,thc,cbd,terps,effects,flavor,icon,breeder,ailments,parents,aka,awards)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [s.id, s.name, s.type, s.lean || '', s.rarity, s.thc || '', s.cbd || '', terps, effects, s.flavor || '', s.icon || '🌿', s.breeder || null, ailments, parents, aka || null, awards],
  });
  cache.strains.set(s.id, {
    id: s.id, name: s.name, type: s.type, lean: s.lean || '', rarity: s.rarity,
    thc: s.thc || '', cbd: s.cbd || '', terps: s.terps || [], effects: s.effects || [],
    flavor: s.flavor || '', icon: s.icon || '🌿', breeder: s.breeder || null, ailments: s.ailments || [],
    parents: s.parents || [], aka: aka || '', awards: s.awards || [],
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
function listRecipes({ status = 'approved', category, difficulty, q } = {}) {
  assertReady();
  let arr = cache.recipes;
  if (status) arr = arr.filter(r => r.status === status);
  if (category && category !== 'All') arr = arr.filter(r => r.category === category);
  if (difficulty && difficulty !== 'All') arr = arr.filter(r => r.difficulty === difficulty);
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
async function createRecipe({ title, time, icon, source = 'community', author, user_id, desc, ingredients, steps, dosing, category = 'Baked Goods', difficulty = 'beginner', status = 'approved', kudos = 0, usesBase }) {
  const rs = await client.execute({
    sql: `INSERT INTO recipes (title,time,icon,source,author,user_id,kudos,desc,ingredients,steps,dosing,category,difficulty,status,uses_base)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [
      title, time || '', icon || '🍽️', source, author || null, user_id || null, kudos,
      desc || '', JSON.stringify(ingredients || []), JSON.stringify(steps || []), dosing || '', category, difficulty, status,
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
    sql: `UPDATE recipes SET title=?, time=?, icon=?, source=?, author=?, desc=?, ingredients=?, steps=?, dosing=?, category=?, difficulty=?, status=? WHERE id=?`,
    args: [
      merged.title, merged.time, merged.icon, merged.source, merged.author, merged.desc,
      JSON.stringify(merged.ingredients), JSON.stringify(merged.steps), merged.dosing, merged.category, merged.difficulty || 'beginner', merged.status, id,
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
function listGrowTips({ category, viewerId, status = 'approved' } = {}) {
  assertReady();
  let arr = cache.growTips;
  if (status) arr = arr.filter(g => g.status === status);
  if (category && category !== 'All') arr = arr.filter(g => g.category === category);
  if (viewerId != null) arr = arr.filter(g => g.user_id == null || !isBlocked(viewerId, g.user_id));
  return [...arr].sort((a, b) => (b.likes - a.likes) || (b.id - a.id));
}
async function createGrowTip({ title, category, author, user_id, body, source_name, source_url, status = 'approved' }) {
  const rs = await client.execute({
    sql: 'INSERT INTO grow_tips (title,category,author,user_id,body,source_name,source_url,status) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
    args: [title, category, author || 'You', user_id || null, body, source_name || null, source_url || null, status],
  });
  const row = rowToObject(rs);
  cache.growTips.push(row);
  return row;
}
async function updateGrowTipStatus(id, status) {
  await client.execute({ sql: 'UPDATE grow_tips SET status = ? WHERE id = ?', args: [status, id] });
  const idx = cache.growTips.findIndex(g => g.id === id);
  if (idx !== -1) cache.growTips[idx] = { ...cache.growTips[idx], status };
}
async function deleteGrowTip(id) {
  await client.execute({ sql: 'DELETE FROM grow_tips WHERE id = ?', args: [id] });
  cache.growTips = cache.growTips.filter(g => g.id !== id);
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
// pairings: an array of { type, note } -- as many as the person logged.
// Entries with no type selected are dropped before saving (a note with no
// category attached isn't useful to show back later). The old three
// fixed pairing_* columns are intentionally left blank on new rows; they
// only still exist so pre-migration check-ins keep their data (see
// rowToCheckin's backward-compat synthesis above).
// USER-CONFIRMED SHAPE -- the checkin form (server.js pageCheckinForm)
// submits pairing_type/pairing_note pairs that get zipped into exactly
// this array shape (see pairingsFromForm in server.js). Don't reintroduce
// pairing_food/pairing_entertainment/pairing_activity as live write
// targets -- that mismatch already happened once and silently discarded
// everyone's pairing data since nothing here reads those fields anymore.
function normalizePairings(pairings) {
  return (Array.isArray(pairings) ? pairings : [])
    .map(p => ({ type: String(p.type || '').trim(), note: String(p.note || '').trim() }))
    .filter(p => p.type);
}
async function createCheckin({ user_id, strain_id, method, rating, note, effects, photo, tasting_notes, pairings, is_private, brand, custom_strain_name }) {
  const rs = await client.execute({
    sql: `INSERT INTO checkins (user_id, strain_id, method, rating, note, effects, photo, tasting_notes, pairings, is_private, brand, custom_strain_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    args: [user_id, strain_id, method || '', rating || 0, note || '', JSON.stringify(effects || []), photo || null, tasting_notes || '', JSON.stringify(normalizePairings(pairings)), is_private ? 1 : 0, brand || '', strain_id === CUSTOM_STRAIN_ID ? (custom_strain_name || null) : null],
  });
  const row = rowToCheckin(rowToObject(rs));
  cache.checkins.push(row);
  return row;
}
// Toggles kudos on a check-in for the given user: gives kudos if not
// already given, removes it if already given (so an accidental tap is
// easy to undo). Returns { checkin, given } -- given tells the caller
// which direction the toggle just went.
async function toggleCheckinKudos(id, userId) {
  const idx = cache.checkins.findIndex(c => c.id === id);
  if (userId == null || idx === -1) return { checkin: idx !== -1 ? cache.checkins[idx] : null, given: false };
  const alreadyGiven = cache.checkinKudos.some(k => k.checkin_id === id && k.user_id === userId);
  if (alreadyGiven) {
    await client.execute({ sql: 'DELETE FROM checkin_kudos WHERE checkin_id = ? AND user_id = ?', args: [id, userId] });
    await client.execute({ sql: 'UPDATE checkins SET kudos = MAX(kudos - 1, 0) WHERE id = ?', args: [id] });
    cache.checkinKudos = cache.checkinKudos.filter(k => !(k.checkin_id === id && k.user_id === userId));
    cache.checkins[idx] = { ...cache.checkins[idx], kudos: Math.max((cache.checkins[idx].kudos || 0) - 1, 0) };
    return { checkin: cache.checkins[idx], given: false };
  }
  await client.execute({ sql: 'INSERT INTO checkin_kudos (checkin_id, user_id) VALUES (?, ?)', args: [id, userId] });
  await client.execute({ sql: 'UPDATE checkins SET kudos = kudos + 1 WHERE id = ?', args: [id] });
  cache.checkinKudos.push({ checkin_id: id, user_id: userId, created_at: new Date().toISOString() });
  cache.checkins[idx] = { ...cache.checkins[idx], kudos: (cache.checkins[idx].kudos || 0) + 1 };
  return { checkin: cache.checkins[idx], given: true };
}
function hasUserGivenKudos(checkinId, userId) {
  return userId != null && cache.checkinKudos.some(k => k.checkin_id === checkinId && k.user_id === userId);
}
// Who actually gave kudos to a check-in -- the point of the checkin_kudos
// attribution table. Returns public user objects, newest first.
function listCheckinKudosGivers(checkinId) {
  return cache.checkinKudos
    .filter(k => k.checkin_id === checkinId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map(k => publicUser(getUserById(k.user_id)))
    .filter(Boolean);
}
// Sets (or, if it's already the same one, clears) the current user's
// reaction on a check-in. Only one reaction per person per check-in --
// picking a different reaction replaces whatever they had, matching how
// Facebook-style reactions behave rather than independent toggle buttons.
async function setCheckinReaction(checkinId, userId, reaction) {
  assertReady();
  const existing = cache.checkinReactions.find(r => r.checkin_id === checkinId && r.user_id === userId);
  if (existing) {
    await client.execute({ sql: 'DELETE FROM checkin_reactions WHERE checkin_id = ? AND user_id = ?', args: [checkinId, userId] });
    cache.checkinReactions = cache.checkinReactions.filter(r => !(r.checkin_id === checkinId && r.user_id === userId));
    if (existing.reaction === reaction) return getCheckinReactionSummary(checkinId, userId);
  }
  const rs = await client.execute({
    sql: 'INSERT INTO checkin_reactions (checkin_id, user_id, reaction) VALUES (?, ?, ?) RETURNING *',
    args: [checkinId, userId, reaction],
  });
  cache.checkinReactions.push(rowToObject(rs));
  return getCheckinReactionSummary(checkinId, userId);
}
// Per-type counts plus the viewer's own current reaction (or null) --
// everything a reaction bar needs to render itself in one call.
function getCheckinReactionSummary(checkinId, viewerId) {
  assertReady();
  const rows = cache.checkinReactions.filter(r => r.checkin_id === checkinId);
  const counts = {};
  rows.forEach(r => { counts[r.reaction] = (counts[r.reaction] || 0) + 1; });
  const mine = viewerId != null ? rows.find(r => r.user_id === viewerId) : null;
  return { counts, total: rows.length, myReaction: mine ? mine.reaction : null };
}
// Who reacted, and with what -- newest first.
function listCheckinReactionGivers(checkinId) {
  assertReady();
  return cache.checkinReactions
    .filter(r => r.checkin_id === checkinId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map(r => ({ user: publicUser(getUserById(r.user_id)), reaction: r.reaction }))
    .filter(x => x.user);
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
async function updateCheckin(id, { method, rating, note, effects, photo, tasting_notes, pairings, is_private, brand }) {
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
    pairings: pairings !== undefined ? normalizePairings(pairings) : current.pairings,
    is_private: is_private !== undefined ? (is_private ? 1 : 0) : current.is_private,
    brand: brand !== undefined ? brand : current.brand,
  };
  await client.execute({
    sql: `UPDATE checkins SET method=?, rating=?, note=?, effects=?, photo=?, tasting_notes=?, pairings=?, is_private=?, brand=? WHERE id=?`,
    args: [merged.method || '', merged.rating || 0, merged.note || '', JSON.stringify(merged.effects || []), merged.photo || null, merged.tasting_notes || '', JSON.stringify(merged.pairings || []), merged.is_private ? 1 : 0, merged.brand || '', id],
  });
  const idx = cache.checkins.findIndex(c => c.id === id);
  if (idx !== -1) cache.checkins[idx] = merged;
  return merged;
}
async function deleteCheckin(id) {
  // Also remove what other people attached to this check-in (comments,
  // reactions, kudos, notifications, mentions, likes on those comments) --
  // otherwise it lingers in the database with nothing left pointing at it.
  const commentIds = cache.checkinComments.filter(c => c.checkin_id === id).map(c => c.id);
  await client.execute({ sql: 'DELETE FROM checkin_comments WHERE checkin_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM checkin_reactions WHERE checkin_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM checkin_kudos WHERE checkin_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM checkin_notifications WHERE checkin_id = ?', args: [id] });
  await client.execute({ sql: 'DELETE FROM comment_mentions WHERE checkin_id = ?', args: [id] });
  for (const cid of commentIds) await client.execute({ sql: 'DELETE FROM comment_likes WHERE comment_id = ?', args: [cid] });
  await client.execute({ sql: 'DELETE FROM checkins WHERE id = ?', args: [id] });
  const gone = new Set(commentIds);
  cache.checkinComments = cache.checkinComments.filter(c => c.checkin_id !== id);
  cache.checkinReactions = cache.checkinReactions.filter(r => r.checkin_id !== id);
  cache.checkinKudos = cache.checkinKudos.filter(k => k.checkin_id !== id);
  cache.checkinNotifications = cache.checkinNotifications.filter(n => n.checkin_id !== id);
  cache.commentMentions = cache.commentMentions.filter(m => m.checkin_id !== id);
  cache.commentLikes = cache.commentLikes.filter(l => !gone.has(l.comment_id));
  cache.checkins = cache.checkins.filter(c => c.id !== id);
}

// ---------- Self-added (free-text) strains ----------
// Finds a library strain whose name or any alias matches `name` exactly
// (ignoring case, spacing and punctuation). Used so that someone typing an
// existing strain's name -- or one of its aliases -- as free text gets
// linked to the real library entry instead of creating a duplicate.
function findStrainByNameOrAka(name) {
  assertReady();
  const target = normSearch(name);
  if (!target) return null;
  for (const s of cache.strains.values()) {
    if (normSearch(s.name) === target) return s;
    if (s.aka && String(s.aka).split(',').some(t => normSearch(t) === target)) return s;
  }
  return null;
}
function countCustomCheckins(name) {
  assertReady();
  const target = normSearch(name);
  return cache.checkins.filter(c => c.strain_id === CUSTOM_STRAIN_ID && normSearch(c.custom_strain_name) === target).length;
}
// Once a self-added strain has been researched and added to the library,
// this moves every check-in logged under that typed name onto the real
// strain (and clears the self-added marker). Returns how many moved.
async function relinkCustomCheckins(customName, strainId) {
  assertReady();
  if (!getStrain(strainId)) return 0;
  const target = normSearch(customName);
  const ids = cache.checkins
    .filter(c => c.strain_id === CUSTOM_STRAIN_ID && normSearch(c.custom_strain_name) === target)
    .map(c => c.id);
  for (const id of ids) {
    await client.execute({ sql: 'UPDATE checkins SET strain_id = ?, custom_strain_name = NULL WHERE id = ?', args: [strainId, id] });
  }
  const moved = new Set(ids);
  cache.checkins = cache.checkins.map(c => moved.has(c.id) ? { ...c, strain_id: strainId, custom_strain_name: null } : c);
  return ids.length;
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
  return new Set(cache.checkins.filter(c => c.user_id === userId && c.strain_id !== CUSTOM_STRAIN_ID).map(c => c.strain_id)).size;
}
function getTotalDupes(userId) {
  assertReady();
  const counts = new Map();
  for (const c of cache.checkins) {
    if (c.user_id !== userId || c.strain_id === CUSTOM_STRAIN_ID) continue;
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

// Community leaderboard -- ranks users by kudos RECEIVED (not given),
// deliberately, since that's the clearest "the community found this
// person's check-ins genuinely valuable" signal, distinct from a raw
// activity count like total check-ins (which would just reward whoever
// logs the most, not whoever's actually helpful to other people). Two
// numbers per person: a rolling "this month" count -- so someone who
// joined yesterday has a real, fair shot at climbing the board, rather
// than it being permanently frozen in favor of whoever happened to join
// first and has been racking up kudos the longest -- and an all-time
// total alongside it for context. checkin_kudos only records who GAVE a
// kudos and when, not who received it, so the month count has to look up
// each kudos's check-in to find its owner; the all-time count instead
// just sums the running `kudos` counter already kept on every check-in,
// which is cheaper and doesn't need the per-kudos timestamp at all.
// viewerId is used only to filter out anyone the viewer has blocked,
// matching the same one-directional convention already used for comments
// and the strain-page community section (hide people I've blocked from
// my own view, without requiring the reverse).
function getKudosLeaderboard(viewerId, { limit = 20, windowDays = 30 } = {}) {
  assertReady();
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const ownerByCheckin = new Map(cache.checkins.map(c => [c.id, c.user_id]));

  // The app moved from a single "kudos" button to emoji reactions, so the
  // leaderboard counts BOTH: legacy kudos (checkin_kudos / the per-check-in
  // running counter) and reactions (checkin_reactions). A person reacting to
  // their own check-in doesn't count toward their own rank.
  const monthCounts = new Map();
  for (const k of cache.checkinKudos) {
    if ((k.created_at + 'Z') < cutoff) continue;
    const owner = ownerByCheckin.get(k.checkin_id);
    if (owner == null) continue;
    monthCounts.set(owner, (monthCounts.get(owner) || 0) + 1);
  }
  for (const r of cache.checkinReactions) {
    const owner = ownerByCheckin.get(r.checkin_id);
    if (owner == null || owner === r.user_id) continue;
    if ((r.created_at + 'Z') < cutoff) continue;
    monthCounts.set(owner, (monthCounts.get(owner) || 0) + 1);
  }

  const allTimeCounts = new Map();
  for (const c of cache.checkins) {
    allTimeCounts.set(c.user_id, (allTimeCounts.get(c.user_id) || 0) + (c.kudos || 0));
  }
  for (const r of cache.checkinReactions) {
    const owner = ownerByCheckin.get(r.checkin_id);
    if (owner == null || owner === r.user_id) continue;
    allTimeCounts.set(owner, (allTimeCounts.get(owner) || 0) + 1);
  }

  const userIds = new Set([...monthCounts.keys(), ...allTimeCounts.keys()]);
  let ranked = [...userIds]
    .filter(uid => viewerId == null || !isBlocked(viewerId, uid))
    .map(uid => ({ user: getUserById(uid), monthKudos: monthCounts.get(uid) || 0, allTimeKudos: allTimeCounts.get(uid) || 0 }))
    // Only rank people with at least one kudos this window -- an all-zero
    // entry isn't a "contributor" yet, and would just pad the list with
    // arbitrarily-ordered noise below the people who actually earned a spot.
    .filter(r => r.user && r.monthKudos > 0)
    .sort((a, b) => b.monthKudos - a.monthKudos || b.allTimeKudos - a.allTimeKudos || a.user.username.localeCompare(b.user.username));

  ranked = ranked.map((r, i) => ({ ...r, rank: i + 1 }));
  const top = ranked.slice(0, limit);
  const viewerEntry = viewerId != null ? (ranked.find(r => r.user.id === viewerId) || null) : null;
  return { top, viewerEntry, windowDays };
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
  return {
    id: u.id, username: u.username, birth_date: u.birth_date, created_at: u.created_at,
    first_name: u.first_name || null, last_name: u.last_name || null, bio: u.bio || '',
  };
}
// For the admin user-management page -- newest signups first.
function listUsers() {
  assertReady();
  return [...cache.users.values()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
// Bypasses the in-memory cache and queries Turso directly. Every other
// read function in this file is synchronous and reads from the snapshot
// loaded once at boot -- fine for strains, recipes, etc., but wrong for
// the admin Users page, where "current as of the last restart" isn't
// good enough. Same pattern already used for password reset tokens,
// which also skip the cache for the same reason: staleness here is a
// real problem, not just a rare edge case.
async function listUsersLive() {
  assertReady();
  return rowsToObjects(await client.execute('SELECT * FROM users ORDER BY created_at DESC'));
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
async function createUserFromGoogle({ username, birth_date, email, google_id, first_name, last_name }) {
  if (getUserByUsername(username)) {
    throw new Error('That username is already taken.');
  }
  const randomPassword = crypto.randomBytes(32).toString('hex');
  const { salt, hash } = auth.hashPassword(randomPassword);
  const rs = await client.execute({
    sql: 'INSERT INTO users (username, password_hash, password_salt, birth_date, email, google_id, first_name, last_name) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
    args: [username, hash, salt, birth_date, email || null, google_id, first_name || null, last_name || null],
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
async function createUser({ username, password, birth_date, email, first_name, last_name, invited_by }) {
  if (getUserByUsername(username)) {
    throw new Error('That username is already taken.');
  }
  if (email && getUserByEmail(email)) {
    throw new Error('That email is already in use.');
  }
  const { salt, hash } = auth.hashPassword(password);
  const rs = await client.execute({
    sql: 'INSERT INTO users (username, password_hash, password_salt, birth_date, email, first_name, last_name, invited_by) VALUES (?,?,?,?,?,?,?,?) RETURNING *',
    args: [username, hash, salt, birth_date, email || null, first_name || null, last_name || null, invited_by || null],
  });
  const row = rowToObject(rs);
  cache.users.set(row.id, row);
  cache.usernameIndex.set(row.username.toLowerCase(), row.id);
  if (row.email) cache.emailIndex.set(row.email.toLowerCase(), row.id);
  return publicUser(row);
}
// Everyone who signed up through this person's invite link -- feeds the
// "you've invited N people" count on pageInvite, and doubles as the
// completion check for the "Invite a friend" onboarding item.
function listInvitedUsers(userId) {
  assertReady();
  return [...cache.users.values()].filter(u => u.invited_by === userId).map(publicUser);
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
// Lets someone fill in or correct their first/last name from Account
// Settings -- covers both older accounts that predate this field existing
// at all, and anyone who just wants to update it later. No uniqueness
// constraint here (unlike username/email), so this is a simple overwrite.
async function updateName(userId, firstName, lastName) {
  const current = getUserById(userId);
  if (!current) throw new Error('User not found.');
  await client.execute({ sql: 'UPDATE users SET first_name = ?, last_name = ? WHERE id = ?', args: [firstName, lastName, userId] });
  cache.users.set(userId, { ...current, first_name: firstName, last_name: lastName });
}
async function dismissOnboardingCard(userId) {
  const current = getUserById(userId);
  if (!current) return;
  await client.execute({ sql: 'UPDATE users SET onboarding_card_dismissed = 1 WHERE id = ?', args: [userId] });
  cache.users.set(userId, { ...current, onboarding_card_dismissed: 1 });
}
async function updateBio(userId, bio) {
  const current = getUserById(userId);
  if (!current) throw new Error('User not found.');
  const trimmed = String(bio || '').trim().slice(0, 160);
  await client.execute({ sql: 'UPDATE users SET bio = ? WHERE id = ?', args: [trimmed, userId] });
  cache.users.set(userId, { ...current, bio: trimmed });
  return trimmed;
}
// Admin-only correction tool for someone who mistyped something at signup
// (or an old account missing first/last name) and doesn't fix it
// themselves. Deliberately does NOT touch password -- an admin silently
// being able to set someone else's password is a real trust/security
// issue even on a small app, so a password reset still has to go through
// the normal "Forgot Password" email flow, which at least notifies the
// account owner. Validates username/email uniqueness the same way the
// individual update functions do, and applies every field in one atomic
// UPDATE so a mid-way failure never leaves the row half-changed.
async function adminUpdateUser(userId, { username, email, first_name, last_name, birth_date }) {
  const current = getUserById(userId);
  if (!current) throw new Error('User not found.');
  const existingUsername = getUserByUsername(username);
  if (existingUsername && existingUsername.id !== userId) throw new Error('That username is already taken.');
  if (email) {
    const existingEmail = getUserByEmail(email);
    if (existingEmail && existingEmail.id !== userId) throw new Error('That email is already in use.');
  }
  await client.execute({
    sql: 'UPDATE users SET username = ?, email = ?, first_name = ?, last_name = ?, birth_date = ? WHERE id = ?',
    args: [username, email || null, first_name || null, last_name || null, birth_date, userId],
  });
  if (current.username.toLowerCase() !== username.toLowerCase()) {
    cache.usernameIndex.delete(current.username.toLowerCase());
    cache.usernameIndex.set(username.toLowerCase(), userId);
  }
  if ((current.email || '').toLowerCase() !== (email || '').toLowerCase()) {
    if (current.email) cache.emailIndex.delete(current.email.toLowerCase());
    if (email) cache.emailIndex.set(email.toLowerCase(), userId);
  }
  const updated = { ...current, username, email: email || null, first_name: first_name || null, last_name: last_name || null, birth_date };
  cache.users.set(userId, updated);
  return publicUser(updated);
}
// ---------- password reset tokens ----------
// Tokens are queried directly against Turso rather than the in-memory
// cache -- they're rare, security-sensitive, and single-use, so there's
// no real benefit to caching them, and it sidesteps any staleness risk.
// ---------- rate limiting ----------
// Queried directly against Turso rather than the in-memory cache -- same
// reasoning as password reset tokens: this is security-sensitive and
// staleness (or a reset-on-restart) genuinely defeats the purpose.
async function pruneAndCountAttempts(bucket, rlKey, windowMs) {
  const cutoff = Date.now() - windowMs;
  const rows = rowsToObjects(await client.execute({
    sql: 'SELECT id, created_at FROM rate_limit_attempts WHERE bucket = ? AND rl_key = ?',
    args: [bucket, rlKey],
  }));
  const stale = rows.filter(r => new Date(r.created_at).getTime() <= cutoff);
  const fresh = rows.filter(r => new Date(r.created_at).getTime() > cutoff);
  if (stale.length) {
    // Opportunistic cleanup, scoped to just this bucket+key -- enough to
    // keep the table from growing unbounded, since a key that's gone
    // quiet simply never gets queried (and therefore never pruned)
    // again, which is fine since it's no longer contributing rows anyway.
    await client.execute({
      sql: `DELETE FROM rate_limit_attempts WHERE id IN (${stale.map(() => '?').join(',')})`,
      args: stale.map(r => r.id),
    });
  }
  return fresh.length;
}
async function recordRateLimitAttempt(bucket, rlKey) {
  await client.execute({
    sql: 'INSERT INTO rate_limit_attempts (bucket, rl_key, created_at) VALUES (?, ?, ?)',
    args: [bucket, rlKey, new Date().toISOString()],
  });
}
async function clearRateLimitAttempts(bucket, rlKey) {
  await client.execute({ sql: 'DELETE FROM rate_limit_attempts WHERE bucket = ? AND rl_key = ?', args: [bucket, rlKey] });
}
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
// Cancels a request YOU sent, before the other person has responded.
// Distinct from respondToFriendRequest (which is for the addressee to
// accept/decline) -- only the original requester can cancel, and only
// while it's still pending, so this can't be used to sneakily end an
// already-accepted friendship.
async function cancelFriendRequest(requesterId, addresseeId) {
  const f = findFriendship(requesterId, addresseeId);
  if (!f || f.status !== 'pending' || f.requester_id !== requesterId) return;
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

// ---------- Direct messages ----------
// Restricted to accepted friendships -- checked here rather than at the
// schema level, matching the same trust boundary already used for
// comments and private check-ins elsewhere in the app.
async function sendMessage({ sender_id, recipient_id, body, shared_strain_id }) {
  if (sender_id === recipient_id) throw new Error("You can't message yourself.");
  if (getFriendshipStatus(sender_id, recipient_id) !== 'friends') throw new Error('You can only message friends.');
  if (isBlocked(recipient_id, sender_id)) throw new Error("This person isn't accepting messages.");
  const cleanBody = (body || '').trim();
  if (!cleanBody && !shared_strain_id) throw new Error('A message needs some text or a shared strain.');
  const rs = await client.execute({
    sql: 'INSERT INTO messages (sender_id, recipient_id, body, shared_strain_id) VALUES (?,?,?,?) RETURNING *',
    args: [sender_id, recipient_id, cleanBody || null, shared_strain_id || null],
  });
  const row = rowToObject(rs);
  cache.messages.push(row);
  return row;
}
// Full message history between two specific people, oldest first (ready
// to render top-to-bottom like a normal chat thread).
function listConversation(userIdA, userIdB, limit = 200) {
  assertReady();
  return cache.messages
    .filter(m => (m.sender_id === userIdA && m.recipient_id === userIdB) || (m.sender_id === userIdB && m.recipient_id === userIdA))
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .slice(-limit);
}
// One row per friend you've ever exchanged messages with, for an inbox
// view -- latest message preview + unread count, newest conversation first.
function listConversations(userId) {
  assertReady();
  const partnerIds = new Set();
  cache.messages.forEach(m => {
    if (m.sender_id === userId) partnerIds.add(m.recipient_id);
    if (m.recipient_id === userId) partnerIds.add(m.sender_id);
  });
  const threads = [...partnerIds].map(partnerId => {
    const thread = cache.messages.filter(m =>
      (m.sender_id === userId && m.recipient_id === partnerId) || (m.sender_id === partnerId && m.recipient_id === userId)
    ).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    const last = thread[thread.length - 1];
    const unread = thread.filter(m => m.recipient_id === userId && !m.read_at).length;
    return { partner: publicUser(getUserById(partnerId)), last, unread };
  }).filter(t => t.partner && t.last);
  threads.sort((a, b) => (b.last.created_at || '').localeCompare(a.last.created_at || ''));
  return threads;
}
async function markConversationRead(userId, friendId) {
  assertReady();
  const toMark = cache.messages.filter(m => m.sender_id === friendId && m.recipient_id === userId && !m.read_at);
  if (!toMark.length) return;
  const now = new Date().toISOString();
  await client.execute({
    sql: 'UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL',
    args: [now, friendId, userId],
  });
  toMark.forEach(m => { m.read_at = now; });
}
function countUnreadMessages(userId) {
  assertReady();
  return cache.messages.filter(m => m.recipient_id === userId && !m.read_at).length;
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
  const profile = {
    id: user.id, username: user.username, first_name: user.first_name || null, last_name: user.last_name || null,
    email: user.email || null, bio: user.bio || null,
    birth_date: user.birth_date, created_at: user.created_at,
  };

  const checkins = cache.checkins.filter(c => c.user_id === userId);
  const trades = cache.trades.filter(t => t.user_id === userId);
  const recipesAuthored = cache.recipes.filter(r => r.user_id === userId);
  const growTipsAuthored = cache.growTips.filter(g => g.user_id === userId);
  const followedDispensaries = [...(cache.dispensaryFollows.get(userId) || [])];
  const eventRsvps = [...(cache.eventRsvps.get(userId) || [])];
  const friendships = cache.friendships.filter(f => f.requester_id === userId || f.addressee_id === userId);
  const growJournal = listGrowJournal(userId);
  const wishlist = getWishlist(userId);
  const customLists = listCustomLists(userId).map(l => ({ ...l, strains: listCustomListItems(l.id) }));
  const messages = cache.messages.filter(m => m.sender_id === userId || m.recipient_id === userId);
  const toleranceBreaks = listToleranceBreaks(userId);
  const feedbackSubmitted = cache.feedback.filter(f => f.user_id === userId);
  const strainSuggestions = cache.strainSubmissions.filter(s => s.user_id === userId);

  return {
    exported_at: new Date().toISOString(),
    profile, checkins, trades, recipes_authored: recipesAuthored,
    grow_tips_authored: growTipsAuthored, followed_dispensaries: followedDispensaries,
    event_rsvps: eventRsvps, friendships, grow_journal: growJournal, wishlist,
    custom_lists: customLists, messages, tolerance_breaks: toleranceBreaks,
    feedback_submitted: feedbackSubmitted, strain_suggestions: strainSuggestions,
    checkin_comments_written: cache.checkinComments.filter(c => c.user_id === userId),
    reactions_given: cache.checkinReactions.filter(r => r.user_id === userId),
    recipe_comments_written: cache.recipeComments.filter(c => c.user_id === userId),
    recipe_favorites: cache.recipeFavorites.filter(f => f.user_id === userId),
    forum_threads: cache.forumThreads.filter(t => t.user_id === userId),
    forum_replies: cache.forumReplies.filter(r => r.user_id === userId),
    infusion_batches: cache.infusionBatches.filter(b => b.user_id === userId),
    blocked_user_ids: cache.userBlocks.filter(b => b.blocker_id === userId).map(b => b.blocked_id),
  };
}

// Deletes a user's account and all personal data tied to it. Community
// contributions (recipes, grow tips) are kept but de-linked from the
// account (user_id set to NULL, author name replaced) rather than
// deleted outright -- other users may have engaged with that content,
// and it's no longer personal data once it can't be traced back to
// anyone. Everything genuinely personal (check-ins, trades, follows,
// RSVPs, friendships, cart, the account itself) is fully removed.
// Removes a person and everything that is theirs. Two kinds of data are
// handled: (1) things the person created or took part in, which go with them,
// and (2) things OTHER people attached to the person's content -- comments,
// reactions, likes and notifications on their check-ins, replies on their forum
// threads -- which would otherwise be left orphaned (and, for comments,
// still readable). Posts the person shared publicly as recipes/grow tips are
// kept but re-attributed to "Former user", as the Privacy Policy says.
// Every statement here is mirrored in the in-memory cache below.
//
// Not covered: photo files already uploaded to R2 (storage.js has no delete
// call yet), so the files themselves remain in the bucket even though no
// database row points at them any more.
async function deleteUserAccount(userId) {
  assertReady();
  const user = cache.users.get(userId);
  if (!user) return false;

  const run = (sql, args = []) => client.execute({ sql, args });
  const inList = (n) => Array(n).fill('?').join(',');
  // Chunked so a prolific user can't exceed SQLite's bound-variable limit.
  const runIn = async (sqlTemplate, ids) => {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      await run(sqlTemplate.replace('(?)', `(${inList(chunk.length)})`), chunk);
    }
  };

  // ---- ids of the person's own content, gathered up front
  const myCheckinIds = cache.checkins.filter(c => c.user_id === userId).map(c => c.id);
  const myCheckinSet = new Set(myCheckinIds);
  const commentsOnMyCheckins = cache.checkinComments.filter(c => myCheckinSet.has(c.checkin_id)).map(c => c.id);
  const commentOnMineSet = new Set(commentsOnMyCheckins);
  const myListIds = cache.customLists.filter(l => l.user_id === userId).map(l => l.id);
  const myListSet = new Set(myListIds);
  const myThreadIds = cache.forumThreads.filter(t => t.user_id === userId).map(t => t.id);
  const myThreadSet = new Set(myThreadIds);

  // ---- other people's activity on this person's check-ins
  if (myCheckinIds.length) {
    await runIn('DELETE FROM checkin_comments WHERE checkin_id IN (?)', myCheckinIds);
    await runIn('DELETE FROM checkin_reactions WHERE checkin_id IN (?)', myCheckinIds);
    await runIn('DELETE FROM checkin_kudos WHERE checkin_id IN (?)', myCheckinIds);
    await runIn('DELETE FROM checkin_notifications WHERE checkin_id IN (?)', myCheckinIds);
    await runIn('DELETE FROM comment_mentions WHERE checkin_id IN (?)', myCheckinIds);
  }
  if (commentsOnMyCheckins.length) await runIn('DELETE FROM comment_likes WHERE comment_id IN (?)', commentsOnMyCheckins);
  if (myThreadIds.length) await runIn('DELETE FROM forum_replies WHERE thread_id IN (?)', myThreadIds);
  if (myListIds.length) await runIn('DELETE FROM custom_list_items WHERE list_id IN (?)', myListIds);

  // ---- the person's own rows
  await run('DELETE FROM checkins WHERE user_id = ?', [userId]);
  await run('DELETE FROM trades WHERE user_id = ?', [userId]);
  await run('DELETE FROM cart_items WHERE user_id = ?', [userId]);
  await run('DELETE FROM user_dispensary_follows WHERE user_id = ?', [userId]);
  await run('DELETE FROM user_event_rsvps WHERE user_id = ?', [userId]);
  await run('DELETE FROM friendships WHERE requester_id = ? OR addressee_id = ?', [userId, userId]);
  await run('DELETE FROM checkin_kudos WHERE user_id = ?', [userId]);
  await run('DELETE FROM checkin_reactions WHERE user_id = ?', [userId]);
  await run('DELETE FROM checkin_notifications WHERE user_id = ? OR actor_user_id = ?', [userId, userId]);
  await run('DELETE FROM comment_mentions WHERE mentioning_user_id = ? OR mentioned_user_id = ?', [userId, userId]);
  await run('DELETE FROM comment_likes WHERE user_id = ?', [userId]);
  await run('DELETE FROM checkin_comments WHERE user_id = ?', [userId]);
  await run('DELETE FROM recipe_comments WHERE user_id = ?', [userId]);
  await run('DELETE FROM recipe_favorites WHERE user_id = ?', [userId]);
  await run('DELETE FROM wishlist WHERE user_id = ?', [userId]);
  await run('DELETE FROM custom_lists WHERE user_id = ?', [userId]);
  await run('DELETE FROM grow_journal_entries WHERE user_id = ?', [userId]);
  await run('DELETE FROM tolerance_breaks WHERE user_id = ?', [userId]);
  await run('DELETE FROM infusion_batches WHERE user_id = ?', [userId]);
  await run('DELETE FROM user_badges_seen WHERE user_id = ?', [userId]);
  await run('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [userId, userId]);
  await run('DELETE FROM content_reports WHERE reporter_id = ?', [userId]);
  await run('DELETE FROM forum_replies WHERE user_id = ?', [userId]);
  await run('DELETE FROM forum_threads WHERE user_id = ?', [userId]);
  await run('DELETE FROM password_reset_tokens WHERE user_id = ?', [userId]);
  await run('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?', [userId, userId]);
  await run('DELETE FROM feedback WHERE user_id = ?', [userId]);
  await run('DELETE FROM strain_submissions WHERE user_id = ?', [userId]);
  // Rate-limit rows are keyed by user id (submissions) or "ip:username" (login).
  const likeSafe = String(user.username || '').toLowerCase().replace(/[\\%_]/g, c => '\\' + c);
  await run("DELETE FROM rate_limit_attempts WHERE rl_key = ? OR (bucket = 'login' AND rl_key LIKE ? ESCAPE '\\')", [String(userId), '%:' + likeSafe]);
  await run('UPDATE users SET invited_by = NULL WHERE invited_by = ?', [userId]);
  await run("UPDATE recipes SET user_id = NULL, author = 'Former user' WHERE user_id = ?", [userId]);
  await run("UPDATE grow_tips SET user_id = NULL, author = 'Former user' WHERE user_id = ?", [userId]);
  await run('DELETE FROM users WHERE id = ?', [userId]);

  // ---- mirror everything in the in-memory cache
  cache.checkins = cache.checkins.filter(c => c.user_id !== userId);
  cache.trades = cache.trades.filter(t => t.user_id !== userId);
  cache.cartCounts.delete(userId);
  cache.dispensaryFollows.delete(userId);
  cache.eventRsvps.delete(userId);
  cache.friendships = cache.friendships.filter(f => f.requester_id !== userId && f.addressee_id !== userId);
  cache.checkinKudos = cache.checkinKudos.filter(k => k.user_id !== userId && !myCheckinSet.has(k.checkin_id));
  cache.checkinReactions = cache.checkinReactions.filter(r => r.user_id !== userId && !myCheckinSet.has(r.checkin_id));
  cache.checkinNotifications = cache.checkinNotifications.filter(n => n.user_id !== userId && n.actor_user_id !== userId && !myCheckinSet.has(n.checkin_id));
  cache.commentMentions = cache.commentMentions.filter(m => m.mentioning_user_id !== userId && m.mentioned_user_id !== userId && !myCheckinSet.has(m.checkin_id));
  cache.commentLikes = cache.commentLikes.filter(l => l.user_id !== userId && !commentOnMineSet.has(l.comment_id));
  cache.checkinComments = cache.checkinComments.filter(c => c.user_id !== userId && !myCheckinSet.has(c.checkin_id));
  cache.recipeComments = cache.recipeComments.filter(c => c.user_id !== userId);
  cache.recipeFavorites = cache.recipeFavorites.filter(f => f.user_id !== userId);
  cache.wishlist = cache.wishlist.filter(w => w.user_id !== userId);
  cache.customListItems = cache.customListItems.filter(i => !myListSet.has(i.list_id));
  cache.customLists = cache.customLists.filter(l => l.user_id !== userId);
  cache.growJournalEntries = cache.growJournalEntries.filter(e => e.user_id !== userId);
  cache.toleranceBreaks = cache.toleranceBreaks.filter(b => b.user_id !== userId);
  cache.infusionBatches = cache.infusionBatches.filter(b => b.user_id !== userId);
  cache.userBadgesSeen = cache.userBadgesSeen.filter(b => b.user_id !== userId);
  cache.userBlocks = cache.userBlocks.filter(b => b.blocker_id !== userId && b.blocked_id !== userId);
  cache.contentReports = cache.contentReports.filter(r => r.reporter_id !== userId);
  cache.forumReplies = cache.forumReplies.filter(r => r.user_id !== userId && !myThreadSet.has(r.thread_id));
  cache.forumThreads = cache.forumThreads.filter(t => t.user_id !== userId);
  cache.messages = cache.messages.filter(m => m.sender_id !== userId && m.recipient_id !== userId);
  cache.feedback = cache.feedback.filter(f => f.user_id !== userId);
  cache.strainSubmissions = cache.strainSubmissions.filter(s => s.user_id !== userId);
  cache.recipes.forEach(r => { if (r.user_id === userId) { r.user_id = null; r.author = 'Former user'; } });
  cache.growTips.forEach(g => { if (g.user_id === userId) { g.user_id = null; g.author = 'Former user'; } });
  cache.users.forEach(u => { if (u.invited_by === userId) u.invited_by = null; });
  cache.users.delete(userId);
  cache.usernameIndex.delete(user.username.toLowerCase());
  if (user.email) cache.emailIndex.delete(user.email.toLowerCase());
  if (user.google_id) cache.googleIdIndex.delete(user.google_id);

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
    .map(u => ({
      id: u.id, username: u.username, email: u.email || '',
      first_name: u.first_name || '', last_name: u.last_name || '',
      birth_date: u.birth_date, created_at: u.created_at,
    }))
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

// "Can't find your strain?" reports -- a name plus an optional photo
// and/or description, reviewed by hand before anything gets added to the
// real strain library. See the strain_submissions table comment for why
// this is deliberately separate from the strains table itself.
async function createStrainSubmission({ user_id, strain_name, description, photo }) {
  const rs = await client.execute({
    sql: 'INSERT INTO strain_submissions (user_id, strain_name, description, photo) VALUES (?, ?, ?, ?) RETURNING *',
    args: [user_id || null, strain_name, description || null, photo || null],
  });
  const row = rowToObject(rs);
  cache.strainSubmissions.push(row);
  return row;
}
function listStrainSubmissions() {
  assertReady();
  return [...cache.strainSubmissions].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
async function markStrainSubmissionReviewed(id) {
  await client.execute({ sql: "UPDATE strain_submissions SET status = 'reviewed' WHERE id = ?", args: [id] });
  const row = cache.strainSubmissions.find(s => s.id === id);
  if (row) row.status = 'reviewed';
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
    if (c.strain_id !== CUSTOM_STRAIN_ID) strainCheckinCounts[c.strain_id] = (strainCheckinCounts[c.strain_id] || 0) + 1;
    if (c.rating > 0 && c.strain_id !== CUSTOM_STRAIN_ID) {
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
  const sortedTerps = Object.entries(terpWeight).sort((a, b) => b[1] - a[1]);
  const topTerpene = sortedTerps[0];
  // A fuller breakdown alongside the single top terpene (kept for
  // whatever already reads that field) -- same terpWeight data, just
  // exposing the top 5 with their relative share rather than only #1.
  const totalTerpWeight = sortedTerps.reduce((sum, [, w]) => sum + w, 0);
  const topTerpenes = sortedTerps.slice(0, 5).map(([name, weight]) => ({
    name,
    pct: totalTerpWeight ? Math.round((weight / totalTerpWeight) * 100) : 0,
  }));

  return {
    totalCheckins: checkins.length,
    topEffects,
    topType: topType ? { name: topType[0], count: topType[1] } : null,
    topMethod: topMethod ? { name: topMethod[0], count: topMethod[1] } : null,
    topTerpene: topTerpene ? topTerpene[0] : null,
    topTerpenes,
    mostLoggedStrain: mostLoggedStrain ? { strain: mostLoggedStrain, count: mostLoggedId[1] } : null,
    topRatedStrain: topRatedStrain ? { strain: topRatedStrain, avg: Math.round(topRatedAvg * 10) / 10 } : null,
  };
}

// A user's current and longest daily check-in streak, computed from the
// distinct UTC calendar days they've logged at least one check-in on.
// "Current" doesn't reset just because today has no check-in yet -- only
// once a full day passes with nothing logged does it actually break, the
// same way Duolingo-style streaks work: check in once before your day
// rolls over and the streak holds, so someone checking in every evening
// isn't punished for a request that happens to land at 11pm vs 1am.
// Deliberately UTC-based rather than the viewer's local timezone -- this
// app doesn't store a per-user timezone anywhere else either (see the
// client-side .local-time/data-utc convention used for display), and a
// day boundary that's "wrong" by a few hours for some users is a much
// smaller problem than needing new user state just to fix it.
function getCheckinStreak(userId) {
  assertReady();
  const checkins = cache.checkins.filter(c => c.user_id === userId);
  if (!checkins.length) return { current: 0, longest: 0 };

  const DAY_MS = 86400000;
  const dayNumbers = new Set(
    checkins.map(c => Math.floor(new Date(c.created_at + 'Z').getTime() / DAY_MS))
  );
  const sortedDesc = [...dayNumbers].sort((a, b) => b - a);

  const todayNum = Math.floor(Date.now() / DAY_MS);
  let current = 0;
  if (dayNumbers.has(todayNum) || dayNumbers.has(todayNum - 1)) {
    let cursor = dayNumbers.has(todayNum) ? todayNum : todayNum - 1;
    while (dayNumbers.has(cursor)) { current++; cursor--; }
  }

  let longest = 0, run = 0, prevDay = null;
  for (const d of sortedDesc) {
    run = (prevDay !== null && prevDay - d === 1) ? run + 1 : 1;
    if (run > longest) longest = run;
    prevDay = d;
  }

  return { current, longest };
}

// A calendar-year-scoped summary of one user's activity, for the "Your
// Year in StrainDex" recap page. Deliberately its own function rather than
// a year filter bolted onto getUserInsights above -- the two serve
// different purposes (an always-current dashboard vs. a point-in-time
// snapshot of one specific year) and diverge slightly in what they return
// (recap adds unique-strain count, kudos received, and a first-check-in
// date that the dashboard has no use for), so a little duplication here is
// simpler than threading optional params through logic that already does
// a lot. Returns null for a year with zero check-ins, same convention as
// getUserInsights returning null for an account with none at all.
function getYearInReview(userId, year) {
  assertReady();
  const checkins = cache.checkins.filter(c => c.user_id === userId && new Date(c.created_at + 'Z').getUTCFullYear() === year);
  if (!checkins.length) return null;

  const effectCounts = {};
  checkins.forEach(c => (c.effects || []).forEach(e => { effectCounts[e] = (effectCounts[e] || 0) + 1; }));
  const topEffects = Object.entries(effectCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

  const typeCounts = {};
  const strainCheckinCounts = {};
  const strainRatingSums = {};
  const uniqueStrainIds = new Set();
  let totalKudos = 0;
  checkins.forEach(c => {
    const s = cache.strains.get(c.strain_id);
    if (s) typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
    if (c.strain_id !== CUSTOM_STRAIN_ID) strainCheckinCounts[c.strain_id] = (strainCheckinCounts[c.strain_id] || 0) + 1;
    if (c.strain_id !== CUSTOM_STRAIN_ID) uniqueStrainIds.add(c.strain_id);
    totalKudos += c.kudos || 0;
    if (c.rating > 0 && c.strain_id !== CUSTOM_STRAIN_ID) {
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

  const sortedByDate = [...checkins].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return {
    year,
    totalCheckins: checkins.length,
    uniqueStrains: uniqueStrainIds.size,
    totalKudos,
    firstCheckinDate: sortedByDate[0].created_at,
    topEffects,
    topType: topType ? { name: topType[0], count: topType[1] } : null,
    topMethod: topMethod ? { name: topMethod[0], count: topMethod[1] } : null,
    topTerpene: topTerpene ? topTerpene[0] : null,
    mostLoggedStrain: mostLoggedStrain ? { strain: mostLoggedStrain, count: mostLoggedId[1] } : null,
    topRatedStrain: topRatedStrain ? { strain: topRatedStrain, avg: Math.round(topRatedAvg * 10) / 10 } : null,
  };
}

// Facebook's "On This Day" pattern -- check-ins logged on this same
// month/day in a past year. Can return more than one match if someone's
// used the app across several years and happened to check in on the same
// calendar day more than once; most recent year first.
function getOnThisDay(userId) {
  assertReady();
  const now = new Date();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const currentYear = now.getUTCFullYear();
  return cache.checkins
    .filter(c => {
      if (c.user_id !== userId) return false;
      const d = new Date(c.created_at + 'Z');
      return d.getUTCMonth() === month && d.getUTCDate() === day && d.getUTCFullYear() < currentYear;
    })
    .map(c => ({ checkin: c, strain: cache.strains.get(c.strain_id), yearsAgo: currentYear - new Date(c.created_at + 'Z').getUTCFullYear() }))
    .sort((a, b) => b.checkin.created_at.localeCompare(a.checkin.created_at));
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
  arr = arr.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  // Attach live like count + whether the current viewer has liked each
  // comment, computed from comment_likes rather than a stored counter.
  return arr.map(c => ({
    ...c,
    likeCount: cache.commentLikes.filter(l => l.comment_id === c.id).length,
    likedByMe: viewerId != null && cache.commentLikes.some(l => l.comment_id === c.id && l.user_id === viewerId),
  }));
}
// Toggles a like on a comment for the given user (like if not already
// liked, unlike if already liked). Returns the new { liked, count } state.
async function toggleCommentLike(commentId, userId) {
  assertReady();
  const already = cache.commentLikes.some(l => l.comment_id === commentId && l.user_id === userId);
  if (already) {
    await client.execute({ sql: 'DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?', args: [commentId, userId] });
    cache.commentLikes = cache.commentLikes.filter(l => !(l.comment_id === commentId && l.user_id === userId));
  } else {
    await client.execute({ sql: 'INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)', args: [commentId, userId] });
    cache.commentLikes.push({ comment_id: commentId, user_id: userId, created_at: new Date().toISOString() });
  }
  return { liked: !already, count: cache.commentLikes.filter(l => l.comment_id === commentId).length };
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
function listRecipeComments(recipeId, viewerId) {
  assertReady();
  let arr = cache.recipeComments.filter(c => c.recipe_id === recipeId);
  if (viewerId != null) arr = arr.filter(c => !isBlocked(viewerId, c.user_id));
  return arr.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
}
async function createRecipeComment({ recipe_id, user_id, body }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO recipe_comments (recipe_id, user_id, body) VALUES (?, ?, ?) RETURNING *',
    args: [recipe_id, user_id, body],
  });
  const row = rowToObject(rs);
  cache.recipeComments.push(row);
  return row;
}

// @mentions -- see the comment_mentions CREATE TABLE comment above for why
// checkin_id is denormalized here.
async function createCommentMention({ comment_id, checkin_id, mentioning_user_id, mentioned_user_id }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO comment_mentions (comment_id, checkin_id, mentioning_user_id, mentioned_user_id) VALUES (?, ?, ?, ?) RETURNING *',
    args: [comment_id, checkin_id, mentioning_user_id, mentioned_user_id],
  });
  const row = rowToObject(rs);
  cache.commentMentions.push(row);
  return row;
}
// One row per comment -- see the comment_mentions table above for why
// mentions have their own separate system instead of living here too.
async function createCommentNotification({ user_id, actor_user_id, checkin_id, comment_id }) {
  assertReady();
  if (user_id === actor_user_id) return null; // commenting on your own post doesn't notify you
  const rs = await client.execute({
    sql: 'INSERT INTO checkin_notifications (user_id, type, actor_user_id, checkin_id, comment_id) VALUES (?, ?, ?, ?, ?) RETURNING *',
    args: [user_id, 'comment', actor_user_id, checkin_id, comment_id],
  });
  const row = rowToObject(rs);
  cache.checkinNotifications.push(row);
  return row;
}
// Updates the existing notification for this (checkin, reactor) pair
// rather than inserting a new one, so flipping between reactions doesn't
// spam the post owner with a fresh alert every time.
async function upsertReactionNotification({ user_id, actor_user_id, checkin_id, reaction }) {
  assertReady();
  if (user_id === actor_user_id) return null;
  const existing = cache.checkinNotifications.find(n => n.type === 'reaction' && n.checkin_id === checkin_id && n.actor_user_id === actor_user_id && n.user_id === user_id);
  if (existing) {
    await client.execute({
      sql: "UPDATE checkin_notifications SET reaction = ?, created_at = datetime('now'), read_at = NULL WHERE id = ?",
      args: [reaction, existing.id],
    });
    existing.reaction = reaction;
    existing.created_at = new Date().toISOString();
    existing.read_at = null;
    return existing;
  }
  const rs = await client.execute({
    sql: 'INSERT INTO checkin_notifications (user_id, type, actor_user_id, checkin_id, reaction) VALUES (?, ?, ?, ?, ?) RETURNING *',
    args: [user_id, 'reaction', actor_user_id, checkin_id, reaction],
  });
  const row = rowToObject(rs);
  cache.checkinNotifications.push(row);
  return row;
}
// Removes the reaction notification for this pair when someone clears
// their reaction entirely (as opposed to switching to a different one,
// which upsertReactionNotification already handles) -- otherwise a stale
// "X reacted" alert would outlive the reaction it was about.
async function deleteReactionNotification({ user_id, actor_user_id, checkin_id }) {
  assertReady();
  await client.execute({
    sql: 'DELETE FROM checkin_notifications WHERE type = ? AND checkin_id = ? AND actor_user_id = ? AND user_id = ?',
    args: ['reaction', checkin_id, actor_user_id, user_id],
  });
  cache.checkinNotifications = cache.checkinNotifications.filter(n => !(n.type === 'reaction' && n.checkin_id === checkin_id && n.actor_user_id === actor_user_id && n.user_id === user_id));
}
function listCheckinNotificationsForUser(userId) {
  assertReady();
  return cache.checkinNotifications
    .filter(n => n.user_id === userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
function countUnreadCheckinNotifications(userId) {
  assertReady();
  return cache.checkinNotifications.filter(n => n.user_id === userId && !n.read_at).length;
}
async function markCheckinNotificationsRead(userId) {
  assertReady();
  await client.execute({
    sql: "UPDATE checkin_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL",
    args: [userId],
  });
  const now = new Date().toISOString();
  cache.checkinNotifications.forEach(n => { if (n.user_id === userId && !n.read_at) n.read_at = now; });
}

function getSeenBadgeKeys(userId) {
  assertReady();
  return new Set(cache.userBadgesSeen.filter(b => b.user_id === userId).map(b => b.badge_key));
}
async function markBadgeSeen(userId, badgeKey) {
  assertReady();
  if (cache.userBadgesSeen.some(b => b.user_id === userId && b.badge_key === badgeKey)) return;
  await client.execute({ sql: 'INSERT INTO user_badges_seen (user_id, badge_key) VALUES (?, ?)', args: [userId, badgeKey] });
  cache.userBadgesSeen.push({ user_id: userId, badge_key: badgeKey, created_at: new Date().toISOString() });
}

// Every post someone's been tagged in, most recent first -- each entry
// carries its own comment_id/checkin_id so the caller can build a direct
// link back to that specific comment thread.
function listMentionsForUser(userId) {
  assertReady();
  return cache.commentMentions
    .filter(m => m.mentioned_user_id === userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}
function countUnreadMentions(userId) {
  assertReady();
  return cache.commentMentions.filter(m => m.mentioned_user_id === userId && !m.read_at).length;
}
async function markMentionsRead(userId) {
  assertReady();
  await client.execute({
    sql: "UPDATE comment_mentions SET read_at = datetime('now') WHERE mentioned_user_id = ? AND read_at IS NULL",
    args: [userId],
  });
  const now = new Date().toISOString();
  cache.commentMentions.forEach(m => { if (m.mentioned_user_id === userId && !m.read_at) m.read_at = now; });
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
function getFavoriteRecipes(userId) {
  assertReady();
  return cache.recipeFavorites
    .filter(f => f.user_id === userId)
    .sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''))
    .map(f => getRecipe(f.recipe_id))
    .filter(Boolean);
}
function isRecipeFavorited(userId, recipeId) {
  assertReady();
  return cache.recipeFavorites.some(f => f.user_id === userId && f.recipe_id === recipeId);
}
async function addRecipeFavorite(userId, recipeId) {
  assertReady();
  if (isRecipeFavorited(userId, recipeId)) return;
  await client.execute({ sql: 'INSERT INTO recipe_favorites (user_id, recipe_id) VALUES (?, ?)', args: [userId, recipeId] });
  cache.recipeFavorites.push({ user_id: userId, recipe_id: recipeId, added_at: new Date().toISOString() });
}
async function removeRecipeFavorite(userId, recipeId) {
  assertReady();
  await client.execute({ sql: 'DELETE FROM recipe_favorites WHERE user_id = ? AND recipe_id = ?', args: [userId, recipeId] });
  cache.recipeFavorites = cache.recipeFavorites.filter(f => !(f.user_id === userId && f.recipe_id === recipeId));
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

// Puff Puff Ask: a lightweight community forum. See the forum_threads /
// forum_replies CREATE TABLE statements above for why sections are a
// free-text column rather than a foreign key.
function listForumThreads({ section } = {}) {
  assertReady();
  let threads = cache.forumThreads;
  if (section) threads = threads.filter(t => t.section === section);
  return threads
    .map(t => {
      const replies = cache.forumReplies.filter(r => r.thread_id === t.id);
      const lastActivityAt = replies.reduce((max, r) => (r.created_at > max ? r.created_at : max), t.created_at);
      return { ...t, replyCount: replies.length, lastActivityAt };
    })
    .sort((a, b) => (b.lastActivityAt || '').localeCompare(a.lastActivityAt || ''));
}
function getForumThread(id) {
  assertReady();
  const t = cache.forumThreads.find(t => t.id === Number(id));
  if (!t) return null;
  const replies = cache.forumReplies
    .filter(r => r.thread_id === t.id)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  return { ...t, replies };
}
async function createForumThread({ user_id, section, title, body }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO forum_threads (user_id, section, title, body) VALUES (?, ?, ?, ?) RETURNING *',
    args: [user_id, section || 'general', title, body],
  });
  const row = rowToObject(rs);
  cache.forumThreads.push(row);
  return row;
}
async function createForumReply({ thread_id, user_id, body }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO forum_replies (thread_id, user_id, body) VALUES (?, ?, ?) RETURNING *',
    args: [thread_id, user_id, body],
  });
  const row = rowToObject(rs);
  cache.forumReplies.push(row);
  return row;
}

// Best-By Calendar: see the infusion_batches CREATE TABLE comment above.
function listInfusionBatches(userId) {
  assertReady();
  return cache.infusionBatches.filter(b => b.user_id === userId).sort((a, b) => (a.made_on || '').localeCompare(b.made_on || ''));
}
function getInfusionBatch(id) {
  assertReady();
  return cache.infusionBatches.find(b => b.id === Number(id)) || null;
}
async function createInfusionBatch({ user_id, item_key, custom_name, made_on, notes }) {
  assertReady();
  const rs = await client.execute({
    sql: 'INSERT INTO infusion_batches (user_id, item_key, custom_name, made_on, notes) VALUES (?, ?, ?, ?, ?) RETURNING *',
    args: [user_id, item_key, custom_name || null, made_on, notes || null],
  });
  const row = rowToObject(rs);
  cache.infusionBatches.push(row);
  return row;
}
async function deleteInfusionBatch(id) {
  assertReady();
  await client.execute({ sql: 'DELETE FROM infusion_batches WHERE id = ?', args: [id] });
  cache.infusionBatches = cache.infusionBatches.filter(b => b.id !== Number(id));
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
  listStrains, countStrains, listAllStrains, matchesFilters, getStrain, insertStrain, deleteStrain, nextStrainId,
  listFaqs, getFaq, createFaq, updateFaq, deleteFaq,
  listRecipes, getRecipe, createRecipe, updateRecipe, deleteRecipe, addKudos, setRecipeUsesBase,
  hasUserApprovedRecipe, hasUserFavoriteRecipe, hasUserSubmittedGrowTip,
  listGrowTips, createGrowTip, likeGrowTip, setGrowTipSource, updateGrowTipStatus, deleteGrowTip,
  createCheckin, listCheckins, filterVisibleCheckins, getCheckin, updateCheckin, deleteCheckin, toggleCheckinKudos, hasUserGivenKudos,
  setCheckinReaction, getCheckinReactionSummary, listCheckinReactionGivers,
  getCollection, getUniqueOwnedCount, getTotalDupes, getMostCheckedInStrains, getKudosLeaderboard,
  createTrade, listTrades, countTrades,
  isFollowingDispensary, toggleFollowDispensary, anyDispensaryFollowed,
  isRsvped, toggleRsvp, anyRsvped,
  addToCart, getCartCount,
  createUser, getUserByUsername, getUserByEmail, getUserById, verifyLogin, publicUser, searchUsers,
  updateUsername, updatePassword, updateEmail, updateName, updateBio, dismissOnboardingCard, adminUpdateUser, listInvitedUsers,
  pruneAndCountAttempts, recordRateLimitAttempt, clearRateLimitAttempts,
  createPasswordResetToken, consumePasswordResetToken, resetPasswordWithToken,
  getFriendshipStatus, sendFriendRequest, respondToFriendRequest, removeFriendship, cancelFriendRequest,
  listFriends, listIncomingRequests, listOutgoingRequests,
  sendMessage, listConversation, listConversations, markConversationRead, countUnreadMessages,
  getUserExportData, deleteUserAccount, getAnalyticsSnapshot, listUsers, listUsersLive,
  createFeedback, listFeedback,
  createStrainSubmission, listStrainSubmissions, markStrainSubmissionReviewed,
  CUSTOM_STRAIN_ID, findStrainByNameOrAka, countCustomCheckins, relinkCustomCheckins,
  getStrainRatingStats, getSimilarStrains, getUserInsights, getCheckinStreak, getYearInReview, getOnThisDay,
  getActiveBreak, listToleranceBreaks, startToleranceBreak, endToleranceBreak,
  listCheckinComments, createCheckinComment, toggleCommentLike, listCheckinKudosGivers,
  listRecipeComments, createRecipeComment,
  createCommentMention, listMentionsForUser, countUnreadMentions, markMentionsRead,
  getSeenBadgeKeys, markBadgeSeen,
  createCommentNotification, upsertReactionNotification, deleteReactionNotification, listCheckinNotificationsForUser, countUnreadCheckinNotifications, markCheckinNotificationsRead,
  getUserByGoogleId, linkGoogleId, createUserFromGoogle,
  getWishlist, isInWishlist, addToWishlist, removeFromWishlist,
  getFavoriteRecipes, isRecipeFavorited, addRecipeFavorite, removeRecipeFavorite,
  listGrowJournal, getGrowJournalEntry, createGrowJournalEntry, deleteGrowJournalEntry,
  getFriendsPicks,
  listForumThreads, getForumThread, createForumThread, createForumReply,
  listInfusionBatches, getInfusionBatch, createInfusionBatch, deleteInfusionBatch,
  listCustomLists, getCustomList, createCustomList, deleteCustomList,
  listCustomListItems, isStrainInList, addStrainToList, removeStrainFromList,
  createReport, listReports, markReportReviewed,
  isBlocked, listBlockedUsers, blockUser, unblockUser,
};
