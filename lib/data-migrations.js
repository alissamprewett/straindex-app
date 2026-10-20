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
  ['s224', 's1111'],   // Herijuana: same name as the library entry
  ['s1095', 's329'],   // G-13 into G13 (spelling; alias G-13 on the kept entry)
  ['s1262', 's783'],   // SpaceJill into Space Jill (spacing)
  ['s1276', 's1592'],   // Star Dawg into Stardawg (spacing)
  ['s1675', 's1139'],   // Lambsbread into Lamb's Bread (apostrophe/spacing; the 2026-09 research log already called it a dupe)
  ['s1797', 's1039'],   // BlackJack into Black Jack (spacing; alias BlackJack on the kept entry)
  ['s1154', 's467'],   // Maui Waui into Maui Wowie (spelling variant; alias on the kept entry)
  ['s1589', 's87'],   // 9lb Hammer into 9 Pound Hammer (alias on the kept entry)
  ['s1202', 's144'],   // SFV OG into SFV OG Kush (alias SFV OG on the kept entry)
  ['s1180', 's410'],   // Platinum Bubba into Platinum Bubba Kush (alias on the kept entry)
  ['s1655', 's1614'],   // Miracle Alien Cookies into MAC (the abbreviation; alias on the kept entry, same breeder Capulator)
  ['s1587', 's1588'],   // WiFi OG into White Fire OG (alias sourced in the 2026-10-07 re-check, row 103)
  ['s5548', 's348'],   // Purple Citral into Pakistani Chitral Kush (2026-10-20, user-approved: "Citral" is a misspelling of Chitral; its aliases were the same as the kept entry's; alias Purple Citral added to the kept entry)
  ['s7345', 's2414'],   // Purple Rozé into Purple Roze (2026-10-20, same strain: Ethos Genetics, Purple Punch x Roze; alias Purple Rozé added to the kept entry)
  ['s1666', 's1535'],   // GMO Cookies into GMO (2026-10-07 re-check of rows 1063-1068: Leafly's GMO and GMO Cookies pages and Weedmaps treat them as the same strain; same breeder Mamiko Seeds; no check-ins)
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

const STRAIN_CORRECTIONS = [
 {
  "id": "s25",
  "col": "breeder",
  "from": "Seed Bank",
  "to": "Sensi Seeds"
 },
 {
  "id": "s88",
  "col": "breeder",
  "from": "DNA Genetics",
  "to": "Crockett Family Farms"
 },
 {
  "id": "s144",
  "col": "type",
  "from": "Indica",
  "to": "Hybrid"
 },
 {
  "id": "s144",
  "col": "aka",
  "from": "San Fernando Valley OG, SFV O.G., San Fernando Valley OG Kush, SFVOG, SFV OG, Valley OG",
  "to": "San Fernando Valley OG Kush"
 },
 {
  "id": "s208",
  "col": "breeder",
  "from": "Seed Bank",
  "to": "Sensi Seeds"
 },
 {
  "id": "s225",
  "col": "type",
  "from": "Hybrid",
  "to": "Indica"
 },
 {
  "id": "s225",
  "col": "thc",
  "from": "19–23%",
  "to": ""
 },
 {
  "id": "s225",
  "col": "cbd",
  "from": "<1%",
  "to": ""
 },
 {
  "id": "s225",
  "col": "terps",
  "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]",
  "to": "[]"
 },
 {
  "id": "s225",
  "col": "flavor",
  "from": "Earthy and sweet on the palate with a myrcene-leaning finish.",
  "to": "Pungent aroma."
 },
 {
  "id": "s282",
  "col": "thc",
  "from": "12–20%",
  "to": ""
 },
 {
  "id": "s282",
  "col": "cbd",
  "from": "<1%",
  "to": ""
 },
 {
  "id": "s282",
  "col": "terps",
  "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]",
  "to": "[]"
 },
 {
  "id": "s418",
  "col": "thc",
  "from": "18–21%",
  "to": "18–24%"
 },
 {
  "id": "s418",
  "col": "cbd",
  "from": "16–22%",
  "to": ""
 },
 {
  "id": "s420",
  "col": "type",
  "from": "Hybrid",
  "to": "Sativa"
 },
 {
  "id": "s420",
  "col": "thc",
  "from": "13–20%",
  "to": ""
 },
 {
  "id": "s420",
  "col": "cbd",
  "from": "<1%",
  "to": ""
 },
 {
  "id": "s420",
  "col": "terps",
  "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]",
  "to": "[]"
 },
 {
  "id": "s420",
  "col": "flavor",
  "from": "Earthy and sweet on the palate with a myrcene-leaning finish.",
  "to": "Pungent diesel with an earthy hint."
 },
 {
  "id": "s490",
  "col": "thc",
  "from": "20–28%",
  "to": ""
 },
 {
  "id": "s490",
  "col": "cbd",
  "from": "<1%",
  "to": ""
 },
 {
  "id": "s490",
  "col": "terps",
  "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]",
  "to": "[]"
 },
 {
  "id": "s564",
  "col": "thc",
  "from": "17–22%",
  "to": ""
 },
 {
  "id": "s564",
  "col": "cbd",
  "from": "<1%",
  "to": ""
 },
 {
  "id": "s564",
  "col": "terps",
  "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]",
  "to": "[]"
 },
 {
  "id": "s564",
  "col": "effects",
  "from": "[\"Relaxed\",\"Euphoric\",\"Uplifted\",\"Talkative\"]",
  "to": "[]"
 },
 {
  "id": "s564",
  "col": "flavor",
  "from": "Sweet and earthy on the palate with a linalool-leaning finish.",
  "to": ""
 },
 {
  "id": "s564",
  "col": "ailments",
  "from": "[\"Pain\",\"Nausea\",\"Stress\",\"Muscle Spasms\"]",
  "to": "[]"
 },
 {
  "id": "s616",
  "col": "thc",
  "from": "20–28%",
  "to": ""
 },
 {
  "id": "s616",
  "col": "cbd",
  "from": "<1%",
  "to": ""
 },
 {
  "id": "s616",
  "col": "terps",
  "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]",
  "to": "[]"
 },
 {
  "id": "s616",
  "col": "flavor",
  "from": "Earthy and sweet on the palate with a myrcene-leaning finish.",
  "to": "Fruity, citrus aroma."
 },
 {
  "id": "s862",
  "col": "breeder",
  "from": "Juan Moore",
  "to": "Riot Seeds"
 },
 {
  "id": "s1087",
  "col": "thc",
  "from": "17–25%",
  "to": ""
 },
 {
  "id": "s1087",
  "col": "cbd",
  "from": "<1%",
  "to": ""
 },
 {
  "id": "s1087",
  "col": "terps",
  "from": "[{\"n\":\"Ocimene\",\"p\":0.4},{\"n\":\"Caryophyllene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]",
  "to": "[]"
 },
 {
  "id": "s1087",
  "col": "flavor",
  "from": "Ocimene-forward with a caryophyllene undertone.",
  "to": "Sweet pineapple punch aroma."
 },
 {
  "id": "s1087",
  "col": "parents",
  "from": "[\"Big Bud\",\"Skunk #1\"]",
  "to": "[]"
 },
 {
  "id": "s1087",
  "col": "aka",
  "from": "Super Bud, SuperBud",
  "to": "ER Super Bud"
 },
 {
  "id": "s1220",
  "col": "breeder",
  "from": "TGA Seeds",
  "to": null
 },
 {
  "id": "s1222",
  "col": "aka",
  "from": "OG Strawberry, Strawberry OGz, Strawberry OG, Strawberry OG Kush",
  "to": "OG Strawberry, Strawberry OGz, Strawberry OG Kush"
 },
 {
  "id": "s1236",
  "col": "lean",
  "from": "Sativa-leaning",
  "to": "Sativa-dominant"
 },
 {
  "id": "s1609",
  "col": "lean",
  "from": "Indica-leaning",
  "to": "Indica-dominant"
 },
 {
  "id": "s1950",
  "col": "aka",
  "from": "Strawberries & Cream",
  "to": "Strawberries & Cream, Strawberry Cream"
 },
 {
  "id": "s2465",
  "col": "parents",
  "from": "[\"Straight Lemonade\",\"Gelato 33\"]",
  "to": "[\"Str8 Lemonade\",\"Gelato 33\"]"
 },
 {
  "id": "s2895",
  "col": "type",
  "from": "Indica",
  "to": "Hybrid"
 },
 {
  "id": "s2895",
  "col": "lean",
  "from": "Indica-leaning",
  "to": ""
 },
 {
  "id": "s5766",
  "col": "aka",
  "from": "Sherbet BX1, Sunset Sherbet Bx1",
  "to": "Sherbet BX1, Sunset Sherbet Bx1, Sherbert Bx1, Sherb Bx"
 },
 {
  "id": "s5780",
  "col": "name",
  "from": "Shocktane (aka Sunset Octane)",
  "to": "Sunset Octane"
 },
 {
  "id": "s5780",
  "col": "breeder",
  "from": "Playboy Genetics",
  "to": "Seed Junky Genetics"
 },
 {
  "id": "s5970",
  "col": "name",
  "from": "Str8 Lemonade (aka Straight Lemonade)",
  "to": "Str8 Lemonade"
 },
 {
  "id": "s7221",
  "col": "aka",
  "from": "Skelly, Skelly Hashplant, The Puck",
  "to": "Skelly, Skelly Hashplant, Super Skelly Hash Plant, The Puck"
 }
];

// Compare-and-set: each correction only applies if the live value is STILL the old value, so an edit
// made in the admin panel is never overwritten. Skipped rows are normal (already corrected, or edited
// by hand). The migration is only recorded as done once every strain it targets exists.
async function applyCorrections(client) {
  const ids = [...new Set(STRAIN_CORRECTIONS.map(c => c.id))];
  const present = new Set((await client.execute({ sql: `SELECT id FROM strains WHERE id IN (${placeholders(ids.length)})`, args: ids })).rows.map(r => r[0]));
  const missing = ids.filter(id => !present.has(id));
  const stmts = [];
  for (const c of STRAIN_CORRECTIONS) {
    if (!present.has(c.id)) continue;
    // column names come from this file's own constants, never from user input
    stmts.push(c.from === null
      ? { sql: `UPDATE strains SET ${c.col} = ? WHERE id = ? AND ${c.col} IS NULL`, args: [c.to, c.id] }
      : { sql: `UPDATE strains SET ${c.col} = ? WHERE id = ? AND ${c.col} = ?`, args: [c.to, c.id, c.from] });
  }
  let applied = 0;
  if (stmts.length) { const res = await client.batch(stmts, 'write'); applied = res.reduce((n, r) => n + (r.rowsAffected || 0), 0); }
  return { corrections: STRAIN_CORRECTIONS.length, applied, missing };
}

// Research batch 1 (s7269-s7273), 2026-10-19. Only values that were ALREADY populated live need a
// compare-and-set; blank fields (breeder, parents, effects, flavor...) are filled by seed.js.
// Evidence for each is in strain-research-log.md.
const STRAIN_CORRECTIONS_BATCH1 = [
 { "id": "s7269", "col": "thc", "from": "15–31%", "to": "28–31%" },
 { "id": "s7271", "col": "thc", "from": "17–18%", "to": "17–22%" }
];

function makeCorrectionsRunner(list) {
  return async function (client) {
    const ids = [...new Set(list.map(c => c.id))];
    const present = new Set((await client.execute({ sql: `SELECT id FROM strains WHERE id IN (${placeholders(ids.length)})`, args: ids })).rows.map(r => r[0]));
    const missing = ids.filter(id => !present.has(id));
    const stmts = [];
    for (const c of list) {
      if (!present.has(c.id)) continue;
      stmts.push({ sql: `UPDATE strains SET ${c.col} = ? WHERE id = ? AND ${c.col} = ?`, args: [c.to, c.id, c.from] });
    }
    let applied = 0;
    if (stmts.length) { const res = await client.batch(stmts, 'write'); applied = res.reduce((n, r) => n + (r.rowsAffected || 0), 0); }
    return { corrections: list.length, applied, missing };
  };
}
const applyBatch1Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH1);

// Alissa approved Depression / Cramps / Migraines as ailments (shown with a "not medical advice" asterisk).
// The ailments column is stored as a JSON string; old value is the exact encoded text.
const STRAIN_CORRECTIONS_BATCH1B = [
 { "id": "s7270", "col": "ailments", "from": "[\"Anxiety\"]", "to": "[\"Anxiety\",\"Depression\",\"Cramps\"]" },
 { "id": "s7271", "col": "parents", "from": "[\"La Reunion\",\"Congo #1\"]", "to": "[\"La Reunion\",\"Congo\"]" },
 { "id": "s2067", "col": "parents", "from": "[\"Triangle Mints\",\"Triangle Mints F2\"]", "to": "[\"Triangle Mints\"]" },
 { "id": "s7273", "col": "ailments", "from": "[\"Stress\",\"Pain\"]", "to": "[\"Stress\",\"Pain\",\"Depression\"]" }
];
const applyBatch1bCorrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH1B);

// Research batch 10 (2026-10-20): Sunset MAC's parent "Sunset" matched no library strain; AllBud spells the cross out as Sunset Sherbet.
const STRAIN_CORRECTIONS_BATCH2 = [
 { "id": "s7314", "col": "parents", "from": "[\"Sunset\",\"MAC\"]", "to": "[\"Sunset Sherbet\",\"MAC\"]" }
];
const applyBatch2Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH2);

// 2026-10-20: keep the searchable name of the merged-away Purple Citral entry as an alias on Pakistani Chitral Kush.
const STRAIN_CORRECTIONS_BATCH3 = [
 { "id": "s348", "col": "aka", "from": "PCK, Pakistan Chitral Kush, Chitral Kush, Purple Pakistani, Purple Chitral, Old Man Purps, Old Man's Purp, Old Man's Purple", "to": "PCK, Pakistan Chitral Kush, Chitral Kush, Purple Pakistani, Purple Chitral, Purple Citral, Old Man Purps, Old Man's Purp, Old Man's Purple" }
];
const applyBatch3Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH3);

// 2026-10-20: Hollywood Pure Kush / HPK is its own strain (LA Pure Kush); no source ties it to Topanga Canyon OG (Jungle Boys Topanga x Sweatband).
const STRAIN_CORRECTIONS_BATCH4 = [
 { "id": "s7339", "col": "aka", "from": "Topanga OG, Topanga Canyon, 91 Hollywood Pure Kush, HPK", "to": "Topanga OG, Topanga Canyon" }
];
const applyBatch4Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH4);

// 2026-10-20: "Stuffed French Toast" is listed as its own strain by AllBud and SeedFinder (Raw Genetics); only Leafly treats it as an alias of French Toast.
const STRAIN_CORRECTIONS_BATCH5 = [
 { "id": "s7312", "col": "aka", "from": "Stuffed French Toast", "to": "" }
];
const applyBatch5Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH5);

// 2026-10-20 (sheet row-by-row research): "True Mintz" is True Mints (True OG x Kush Mints) per SeedFinder, AllBud and Weedmaps, not TMZ. Alias removed from s2913 and the name trimmed; True Mints added as s7355.
const STRAIN_CORRECTIONS_BATCH6 = [
 { "id": "s2913", "col": "aka", "from": "True Mintz", "to": "" },
 { "id": "s2913", "col": "name", "from": "TMZ (True Mintz)", "to": "TMZ" }
];
const applyBatch6Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH6);

// 2026-10-20 (sheet row-by-row research): Valley OG is its own strain (a descendant of SFV OG) per Leafly, AllBud and GrowDiaries; Weedmaps' SFV OG page lists no such alias. Alias removed from s7280; Valley OG added as s7359.
const STRAIN_CORRECTIONS_BATCH7 = [
 { "id": "s7280", "col": "aka", "from": "San Fernando Valley OG, San Fernando Valley, SFVOG, SFV O.G., Valley OG", "to": "San Fernando Valley OG, San Fernando Valley, SFVOG, SFV O.G." }
];
const applyBatch7Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH7);

// 2026-10-20 (sheet row-by-row research): White Cherry Truffle is Cherry Noir x Highland Afghani (Aficionado Seed Collection) per Leafly, AllBud, GrowDiaries and SeedFinder, not White Cherry Gelato. Alias removed from s2198; White Cherry Truffle added as s7366.
const STRAIN_CORRECTIONS_BATCH8 = [
 { "id": "s2198", "col": "aka", "from": "White Gelato, White Cherry, White Cherry Truffle", "to": "White Gelato, White Cherry" }
];
const applyBatch8Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH8);

// 2026-10-20 (sheet row-by-row research): White Truffle lean is Indica-dominant per Leafly and AllBud (80/20). Library had Indica-leaning.
const STRAIN_CORRECTIONS_BATCH9 = [
 { "id": "s1618", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant" }
];
const applyBatch9Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH9);

// 2026-10-20 (sheet row-by-row research): White Fire 43 CBD "19–21%" is wrong; Leafly lists none, GrowDiaries 0.1%, AllBud ~5%. Blanked.
const STRAIN_CORRECTIONS_BATCH10 = [
 { "id": "s742", "col": "cbd", "from": "19–21%", "to": "" }
];
const applyBatch10Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH10);

// 2026-10-20 (XXX cleanup): s379 XXX 420 and s380 XXX OG carried sample-style placeholder data (generic terpenes, ailments). Replaced with values two sources agree on (Leafly + AllBud); unsupported values blanked.
const STRAIN_CORRECTIONS_BATCH11 = [
 { "id": "s379", "col": "thc", "from": "16–24%", "to": "" },
 { "id": "s379", "col": "cbd", "from": "<1%", "to": "" },
 { "id": "s379", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s379", "col": "effects", "from": "[\"Relaxed\",\"Talkative\",\"Happy\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Euphoric\",\"Talkative\"]" },
 { "id": "s379", "col": "flavor", "from": "Sweet and berry on the palate with a linalool-leaning finish.", "to": "sweet honey and berry" },
 { "id": "s379", "col": "ailments", "from": "[\"Depression\",\"Stress\",\"Insomnia\",\"Lack of Appetite\"]", "to": "[]" },
 { "id": "s380", "col": "thc", "from": "12–19%", "to": "12–21%" },
 { "id": "s380", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s380", "col": "effects", "from": "[\"Sleepy\",\"Relaxed\",\"Happy\",\"Euphoric\"]", "to": "[\"Sleepy\",\"Relaxed\",\"Euphoric\"]" },
 { "id": "s380", "col": "flavor", "from": "Earthy and pine on the palate with a myrcene-leaning finish.", "to": "pine and woody with lemon notes" },
 { "id": "s380", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Insomnia\",\"Depression\",\"Lack of Appetite\"]", "to": "[]" }
];
const applyBatch11Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH11);

// 2026-10-20 (sheet row-by-row research): Z Face THC "20-29%" unsupported (AllBud 20-26%, Leafly ~20%); lean Sativa-leaning per 60/40 (AllBud + Leafly). Zkittlez is a Hybrid per Leafly, AllBud, Weedmaps (library had Indica); effects add Happy + Sleepy (2+ sources).
const STRAIN_CORRECTIONS_BATCH12 = [
 { "id": "s6434", "col": "thc", "from": "20-29%", "to": "20–26%" },
 { "id": "s6434", "col": "lean", "from": "Sativa-dominant", "to": "Sativa-leaning" },
 { "id": "s381", "col": "type", "from": "Indica", "to": "Hybrid" },
 { "id": "s381", "col": "effects", "from": "[\"Relaxed\"]", "to": "[\"Relaxed\",\"Happy\",\"Sleepy\"]" }
];
const applyBatch12Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH12);

// 2026-10-20 (sheet row-by-row research): Zoap s1658 carried sample-style data. Leafly + AllBud: THC 21-26%, effects Relaxed + Giggly + Hungry, sweet/fruity/earthy flavor. Euphoric, Happy, soapy-clean finish and the generic terpene set were unsupported.
const STRAIN_CORRECTIONS_BATCH13 = [
 { "id": "s1658", "col": "thc", "from": "20–26%", "to": "21–26%" },
 { "id": "s1658", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.3},{\"n\":\"Limonene\",\"p\":0.25},{\"n\":\"Myrcene\",\"p\":0.2}]", "to": "[]" },
 { "id": "s1658", "col": "effects", "from": "[\"Euphoric\",\"Relaxed\",\"Happy\"]", "to": "[\"Relaxed\",\"Giggly\",\"Hungry\"]" },
 { "id": "s1658", "col": "flavor", "from": "Sweet floral and tropical fruit with a distinctive soapy-clean finish.", "to": "sweet and fruity with an earthy finish" }
];
const applyBatch13Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH13);

// 2026-10-20 (sheet row-by-row research): Caked Up Candy s3552. AllBud + Weedmaps: Runtz x Caked Up Cherries (Relentless Genetics) and both call it a hybrid; both report relaxation and appetite. Euphoric/Uplifted/Sociable were single-source or unsupported and the terpene pair was unsupported.
const STRAIN_CORRECTIONS_BATCH14 = [
 { "id": "s3552", "col": "type", "from": "Indica", "to": "Hybrid" },
 { "id": "s3552", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.2},{\"n\":\"Limonene\",\"p\":0.15}]", "to": "[]" },
 { "id": "s3552", "col": "effects", "from": "[\"Euphoric\",\"Uplifted\",\"Sociable\"]", "to": "[\"Relaxed\",\"Hungry\"]" }
];
const applyBatch14Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH14);

const MIGRATIONS = [
  // Order matters only in that both are independent; sync first so merge targets are final.
  { name: 'strains_audit_sync_2026_10_07', run: applyAuditSync, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_corrections_2026_10_09', run: applyCorrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch1_2026_10_19', run: applyBatch1Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch1b_2026_10_19', run: applyBatch1bCorrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch2_2026_10_20', run: applyBatch2Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch3_2026_10_20', run: applyBatch3Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch4_2026_10_20', run: applyBatch4Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch5_2026_10_20', run: applyBatch5Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch6_2026_10_20', run: applyBatch6Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch7_2026_10_20', run: applyBatch7Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch8_2026_10_20', run: applyBatch8Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch9_2026_10_20', run: applyBatch9Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch10_2026_10_20', run: applyBatch10Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch11_2026_10_20', run: applyBatch11Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch12_2026_10_20', run: applyBatch12Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch13_2026_10_20', run: applyBatch13Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch14_2026_10_20', run: applyBatch14Corrections, completeWhen: (r) => r.missing.length === 0 },
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

module.exports = { run, assertValidMerges, STRAIN_MERGES, STRAIN_FIXES, NEW_STRAINS, STRAIN_CORRECTIONS, STRAIN_CORRECTIONS_BATCH1, STRAIN_CORRECTIONS_BATCH1B, STRAIN_CORRECTIONS_BATCH2, STRAIN_CORRECTIONS_BATCH3, STRAIN_CORRECTIONS_BATCH4, STRAIN_CORRECTIONS_BATCH5, STRAIN_CORRECTIONS_BATCH6, STRAIN_CORRECTIONS_BATCH7, STRAIN_CORRECTIONS_BATCH8, STRAIN_CORRECTIONS_BATCH9, STRAIN_CORRECTIONS_BATCH10, STRAIN_CORRECTIONS_BATCH11, STRAIN_CORRECTIONS_BATCH12, STRAIN_CORRECTIONS_BATCH13, STRAIN_CORRECTIONS_BATCH14 };
