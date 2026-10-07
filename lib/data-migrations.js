// data-migrations.js -- one-time data fixes that run automatically at boot.
//
// Why this exists: merging duplicate strains and applying library corrections used to
// mean someone running SQL by hand in the Turso shell. Instead, the app now does it
// itself the first time it boots after a deploy, then records the migration in
// `migrations_applied` so it never runs again.
//
// Safety rules every migration here follows:
//   * ALL-OR-NOTHING: each migration's writes go in one client.batch() transaction.
//   * NEVER REMAP ONTO A MISSING STRAIN: a duplicate is only merged if the strain it
//     is merged INTO exists. Otherwise that pair is skipped, a warning is logged, and
//     the migration is NOT recorded as done, so it retries on the next boot.
//   * IDEMPOTENT: re-running after success (or partial success) changes nothing more.
//   * NEVER BLOCKS STARTUP: any failure is logged and boot continues.
//
// Future merges: just append a [duplicate, kept] pair to STRAIN_MERGES. The merge step is not
// a one-shot -- on every boot it first runs ONE cheap probe query and does nothing at all unless a
// listed duplicate (or anything still pointing at one) is still in the database. Corrections
// (STRAIN_FIXES / NEW_STRAINS) are one-shot and recorded by name; add future ones as a new,
// differently-named entry in MIGRATIONS -- never edit the name of one that already ran.

// [duplicate, kept]: everything that referenced the duplicate moves to the kept strain,
// then the duplicate strain row is deleted. Every pair was merged only after sources
// confirmed both names are the same plant (see remap_duplicate_strains.sql addenda 1-43).
const STRAIN_MERGES = [
  ['s6576', 's1531'],
  ['s6588', 's1546'],
  ['s6584', 's1887'],
  ['s6592', 's1914'],
  ['s6580', 's1946'],
  ['s6591', 's2029'],
  ['s6555', 's2494'],
  ['s6585', 's5839'],
  ['s6760', 's2159'],
  ['s1181', 's139'],
  ['s6581', 's3167'],
  ['s5178', 's192'],
  ['s5219', 's101'],
  ['s6448', 's864'],
  ['s48', 's19'],
  ['s700', 's2641'],
  ['s4938', 's6636'],
  ['s147', 's2091'],
  ['s2107', 's1554'],
  ['s6088', 's1875'],
  ['s156', 's17'],
  ['s1099', 's5'],
  ['s4931', 's1549'],
  ['s5557', 's428'],
  ['s2278', 's1139'],
  ['s6637', 's4982'],
  ['s822', 's2718'],
  ['s109', 's2215'],
  ['s2308', 's1093'],
  ['s1591', 's1863'],
  ['s1068', 's1240'],
  ['s1036', 's1769'],
  ['s3101', 's2394'],
  ['s1558', 's1989'],
  ['s4077', 's6629'],
  ['s1404', 's13'],
  ['s1900', 's1630'],
  ['s5250', 's1045'],
  ['s6841', 's1045'],
  ['s1556', 's1573'],
  ['s3148', 's1573'],
  ['s4935', 's645'],
  ['s6582', 's6986'],
  ['s1247', 's619'],
  ['s3985', 's3984'],
  ['s3560', 's1143'],
  ['s5348', 's7186'],
  ['s6766', 's1566'],
  ['s2986', 's6778'],
  ['s6814', 's1877'],
  ['s1070', 's1593'],   // Chemdawg #4 into Chem 4 (addendum 18; that addendum used the IN (...) form)
  ['s2145', 's1593'],   // Chem Dog #4 into Chem 4 (addendum 18)
];

// Corrections from the 2026-10-07 audit (only the columns that changed).
const STRAIN_FIXES = [
  { id: 's86', column: 'aka', value: 'Dosidos, Do Si Dos' },
  { id: 's1523', column: 'aka', value: 'Cookies & Cream, Cookies N Cream' },
  { id: 's1787', column: 'aka', value: 'Dead Head, Deadhead, Deadhead OG Kush' },
  { id: 's249', column: 'breeder', value: 'Crockett Family Farms' },
  { id: 's7186', column: 'aka', value: 'Oz Kush, OZK' }
];
const NEW_STRAINS = [{
  "id": "s7248",
  "name": "Chillz",
  "type": "Hybrid",
  "lean": "",
  "rarity": "rare",
  "thc": "",
  "cbd": "",
  "terps": [],
  "effects": [],
  "flavor": "",
  "icon": "🌿",
  "breeder": "Capulator",
  "parents": [
    "Freezer Burn",
    "Pakistani Chitral Kush"
  ],
  "aka": "",
  "ailments": null
}];

// Guard against a malformed list. A missing comma between two entries is VALID JavaScript that quietly
// turns the pair into an array-index expression (['a','b']\n['c','d'] === undefined), so verify the
// shape instead of trusting the syntax: every entry must be exactly [duplicate_id, kept_id].
function assertValidMerges() {
  const bad = STRAIN_MERGES.map((p, i) => ({ p, i })).filter(({ p }) =>
    !Array.isArray(p) || p.length !== 2 || !/^s\d+$/.test(p[0]) || !/^s\d+$/.test(p[1]) || p[0] === p[1]);
  if (bad.length) throw new Error(`STRAIN_MERGES has ${bad.length} malformed entr${bad.length === 1 ? 'y' : 'ies'} (first at index ${bad[0].i}) -- check for a missing comma`);
  const dups = STRAIN_MERGES.map(p => p[0]);
  if (new Set(dups).size !== dups.length) throw new Error('STRAIN_MERGES lists the same duplicate twice');
  const kept = new Set(STRAIN_MERGES.map(p => p[1]));
  const chain = dups.filter(d => kept.has(d));
  if (chain.length) throw new Error(`STRAIN_MERGES has chained merges (a kept strain that is itself a duplicate): ${chain.join(', ')}`);
}

async function alreadyApplied(client, name) {
  const rs = await client.execute({ sql: 'SELECT 1 FROM migrations_applied WHERE name = ?', args: [name] });
  return rs.rows.length > 0;
}
async function markApplied(client, name) {
  await client.execute({ sql: 'INSERT OR IGNORE INTO migrations_applied (name) VALUES (?)', args: [name] });
}
const placeholders = (n) => Array(n).fill('?').join(',');

// "CASE col WHEN ? THEN ? ... END" plus its arguments, mapping each duplicate id to its kept id.
function caseMap(column, pairs) {
  return {
    sql: `CASE ${column} ${pairs.map(() => 'WHEN ? THEN ?').join(' ')} END`,
    args: pairs.flatMap(([dup, kept]) => [dup, kept]),
  };
}

async function mergeDuplicateStrains(client) {
  assertValidMerges();
  // Cheap "is there anything to do?" probe: one round trip, stops at the first hit.
  const dupsAll = STRAIN_MERGES.map(p => p[0]); const ph = placeholders(dupsAll.length);
  const probe = await client.execute({
    sql: `SELECT 1 AS hit FROM strains WHERE id IN (${ph})
          UNION ALL SELECT 1 AS hit FROM checkins WHERE strain_id IN (${ph})
          UNION ALL SELECT 1 AS hit FROM trades WHERE gave_strain_id IN (${ph}) OR got_strain_id IN (${ph})
          UNION ALL SELECT 1 AS hit FROM messages WHERE shared_strain_id IN (${ph})
          UNION ALL SELECT 1 AS hit FROM wishlist WHERE strain_id IN (${ph})
          UNION ALL SELECT 1 AS hit FROM custom_list_items WHERE strain_id IN (${ph}) LIMIT 1`,
    args: Array(7).fill(dupsAll).flat(),   // the id list appears 7 times in the SQL above
  });
  if (!probe.rows.length) return { merged: 0, skipped: [], idle: true };
  const ids = [...new Set(STRAIN_MERGES.flat())];
  const existing = new Set((await client.execute({ sql: `SELECT id FROM strains WHERE id IN (${placeholders(ids.length)})`, args: ids })).rows.map(r => r[0]));
  const usable = STRAIN_MERGES.filter(([dup, kept]) => existing.has(kept));
  const skipped = STRAIN_MERGES.filter(([dup, kept]) => !existing.has(kept));
  if (!usable.length) return { merged: 0, skipped, moved: {} };
  const dups = usable.map(p => p[0]);
  const inDups = (col) => ({ sql: `${col} IN (${placeholders(dups.length)})`, args: dups });

  const count = async (table, col) => Number((await client.execute({ sql: `SELECT COUNT(*) FROM ${table} WHERE ${col} IN (${placeholders(dups.length)})`, args: dups })).rows[0][0]);
  const moved = {
    checkins: await count('checkins', 'strain_id'), wishlist: await count('wishlist', 'strain_id'),
    custom_list_items: await count('custom_list_items', 'strain_id'), messages: await count('messages', 'shared_strain_id'),
    trades: await count('trades', 'gave_strain_id') + await count('trades', 'got_strain_id'),
  };

  // Undo trail, written in the SAME transaction as the merge: the full row of every strain removed and
  // the ids of the check-ins moved off it. To reverse a merge: re-insert dup_row into strains, then set
  // checkins.strain_id back to dup_id for the ids in checkin_ids.
  await client.execute(`CREATE TABLE IF NOT EXISTS strain_merge_log (
    dup_id TEXT NOT NULL, kept_id TEXT NOT NULL, dup_row TEXT, checkin_ids TEXT,
    merged_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const stmts = [];
  for (const [dup, kept] of usable) {
    const row = (await client.execute({ sql: 'SELECT * FROM strains WHERE id = ?', args: [dup] })).rows[0];
    const cols = row ? (await client.execute({ sql: 'SELECT * FROM strains WHERE id = ?', args: [dup] })).columns : [];
    const asObj = row ? Object.fromEntries(cols.map((c, i) => [c, row[i]])) : null;
    const ckIds = (await client.execute({ sql: 'SELECT id FROM checkins WHERE strain_id = ?', args: [dup] })).rows.map(r => Number(r[0]));
    stmts.push({ sql: 'INSERT INTO strain_merge_log (dup_id, kept_id, dup_row, checkin_ids) VALUES (?,?,?,?)', args: [dup, kept, asObj ? JSON.stringify(asObj) : null, JSON.stringify(ckIds)] });
  }
  const update = (table, col, orIgnore) => {
    const c = caseMap(col, usable), w = inDups(col);
    stmts.push({ sql: `UPDATE ${orIgnore ? 'OR IGNORE ' : ''}${table} SET ${col} = ${c.sql} WHERE ${w.sql}`, args: [...c.args, ...w.args] });
  };
  update('checkins', 'strain_id');
  update('trades', 'gave_strain_id');
  update('trades', 'got_strain_id');
  update('messages', 'shared_strain_id');
  // wishlist / list items: a person may already hold the kept strain, so OR IGNORE, then drop the leftovers.
  update('wishlist', 'strain_id', true);
  stmts.push({ sql: `DELETE FROM wishlist WHERE strain_id IN (${placeholders(dups.length)})`, args: dups });
  update('custom_list_items', 'strain_id', true);
  stmts.push({ sql: `DELETE FROM custom_list_items WHERE strain_id IN (${placeholders(dups.length)})`, args: dups });
  stmts.push({ sql: `DELETE FROM strains WHERE id IN (${placeholders(dups.length)})`, args: dups });
  await client.batch(stmts, 'write');
  return { merged: usable.length, skipped, moved };
}

async function applyAuditSync(client) {
  // Only count as done when every strain being corrected actually exists. On a database whose
  // library hasn't been loaded yet (fresh install, boot before seeding) the UPDATEs would match
  // nothing, and recording that as "applied" would silently skip the corrections forever.
  const ids = [...new Set(STRAIN_FIXES.map(f => f.id))];
  const present = new Set((await client.execute({ sql: `SELECT id FROM strains WHERE id IN (${placeholders(ids.length)})`, args: ids })).rows.map(r => r[0]));
  const missing = ids.filter(id => !present.has(id));
  const stmts = [];
  for (const f of STRAIN_FIXES) {
    if (!present.has(f.id)) continue;
    // column names come from this file's own constants, never from user input
    stmts.push({ sql: `UPDATE strains SET ${f.column} = ? WHERE id = ?`, args: [f.value || null, f.id] });
  }
  for (const s of NEW_STRAINS) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO strains (id,name,type,lean,rarity,thc,cbd,terps,effects,flavor,icon,breeder,ailments,parents,aka,awards)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [s.id, s.name, s.type, s.lean || '', s.rarity, s.thc || '', s.cbd || '', JSON.stringify(s.terps || []), JSON.stringify(s.effects || []),
             s.flavor || '', s.icon || '🌿', s.breeder || null, JSON.stringify(s.ailments || []), JSON.stringify(s.parents || []), s.aka || null, '[]'],
    });
  }
  if (stmts.length) await client.batch(stmts, 'write');
  return { fixes: STRAIN_FIXES.length - missing.length, added: NEW_STRAINS.length, missing };
}

const MIGRATIONS = [
  // Order matters only in that both are independent; sync first so merge targets are final.
  { name: 'strains_audit_sync_2026_10_07', run: applyAuditSync, completeWhen: (r) => r.missing.length === 0 },
  { name: 'merge_duplicate_strains', run: mergeDuplicateStrains, recorded: false },   // self-checking; see header
];

async function run(client, log = console) {
  for (const m of MIGRATIONS) {
    try {
      const tracked = m.recorded !== false;
      if (tracked && await alreadyApplied(client, m.name)) continue;
      const result = await m.run(client);
      if (result.idle) continue;                                   // nothing to do: stay silent
      const complete = m.completeWhen ? m.completeWhen(result) : true;
      if (tracked && complete) await markApplied(client, m.name);
      const skippedNote = result.skipped && result.skipped.length ? ` SKIPPED ${result.skipped.length} (kept strain missing): ${result.skipped.map(p => p.join('->')).join(', ')} -- will retry next boot.` : '';
      const missingNote = result.missing && result.missing.length ? ` NOT YET APPLIED to missing strains: ${result.missing.join(', ')} -- will retry next boot.` : '';
      log.log(`[migrations] ${m.name}${complete ? '' : ' (incomplete)'}: ${JSON.stringify({ ...result, skipped: undefined, missing: undefined })}${skippedNote}${missingNote}`);
    } catch (err) {
      log.error(`[migrations] ${m.name} FAILED (nothing was changed by this migration; boot continues):`, err && err.message);
    }
  }
}

module.exports = { run, assertValidMerges, STRAIN_MERGES, STRAIN_FIXES, NEW_STRAINS };
