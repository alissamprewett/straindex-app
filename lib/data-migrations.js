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
  ['s1091', 's1240'],   // Exodus Cheese into UK Cheese (2026-10-21: Leafly's UK Cheese page says "also known as Exodus Cheese" and its Exodus Cheese page lists UK Cheese as an alias; SeedFinder's Exodus (UK) Cheese is the same Skunk #1 Cheese cut; alias Exodus Cheese added to the kept entry; no check-in impact expected)
  ['s3626', 's799'],    // Champion City Chocolate (Chocolate OG) into Chocolate OG (2026-10-21: Leafly + GrowDiaries list Chocolate OG as THClones, True OG x Chocolate Rain, the same breeder and parents stored on s3626; kept entry now carries those plus alias Champion City Chocolate; no check-in impact expected)
  ['s4414', 's3687'],   // second Glazed Cherries into Glazed Cherries (2026-10-21: identical name, breeder Kief Sweat and parents Cherry OG x Forum Cut Cookies; Leafly lists one Glazed Cherries, Forum Cut GSC x Cherry OG; kept entry has alias Cherry Glaze)
  ['s4227', 's326'],   // Flowerbomb (Flowerbomb Kush) into Flowerbomb Kush (2026-10-26, user-approved: same strain, Green Crack x OG Kush; Leafly Flowerbomb Kush and the Strain Hunters seedbank page; alias Flowerbomb added to the kept entry)
  ['s4960', 's1581'],   // Lemon Tree Kush (Lemon Tree Kush (aka Lemon Tree)) into Lemon Tree (2026-10-26, user-approved: same strain, Sour Diesel x Lemon Skunk; Leafly lists Lemon Tree Kush as an alias; alias added to the kept entry)
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

// 2026-10-20 (sheet row-by-row research, S32): Sour Apple Killer s5872 THC (SeedFinder + AllBud 14-29%); Fruity Pebbles/FPOG s1094 carried sample-style data (AllBud + Leafly: THC ~18-21%, effects Euphoric + Giggly, tropical/berry flavor; the terpene set and Talkative/Focused were unsupported); Boston Cream Pie s3472 (AllBud + SeedFinder: Uplifted/Creative/Happy/Hungry, vanilla/cream/orange; mint and the terpene set unsupported).
const STRAIN_CORRECTIONS_BATCH15 = [
 { "id": "s5872", "col": "thc", "from": "14-30%", "to": "14–29%" },
 { "id": "s1094", "col": "thc", "from": "23–31%", "to": "18–21%" },
 { "id": "s1094", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s1094", "col": "effects", "from": "[\"Talkative\",\"Focused\",\"Happy\"]", "to": "[\"Euphoric\",\"Giggly\"]" },
 { "id": "s1094", "col": "flavor", "from": "Linalool-forward with a humulene undertone.", "to": "tropical fruit and berry" },
 { "id": "s3472", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.2},{\"n\":\"Caryophyllene\",\"p\":0.15},{\"n\":\"Limonene\",\"p\":0.1}]", "to": "[]" },
 { "id": "s3472", "col": "effects", "from": "[\"Relaxed\",\"Stimulated\"]", "to": "[\"Uplifted\",\"Creative\",\"Happy\",\"Hungry\"]" },
 { "id": "s3472", "col": "flavor", "from": "Creamy vanilla, mint, floral.", "to": "creamy vanilla with orange citrus" }
];
const applyBatch15Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH15);

// 2026-10-21 (sheet row-by-row research, S33): Sunburn s489 and Jamaican Pearl s397 carried sample-style data. Sunburn (Leafly + AllBud + SeedFinder): Island Sweet Skunk x Rug Burn OG x Gupta Kush, Colorado Seed Inc, effects Uplifted/Creative/Energetic, citrus; THC sources conflict (20% vs 16-17%) so blanked. Jamaican Pearl (Leafly + AllBud + SeedFinder): THC 22%, effects Euphoric/Uplifted/Creative, sweet and tropical; Sensi Seeds, Marley's Collie x Early Pearl. Generic terpene sets, Happy and unsupported ailments removed.
const STRAIN_CORRECTIONS_BATCH16 = [
 { "id": "s489", "col": "breeder", "from": "Helping Hands Herbals", "to": "Colorado Seed Inc" },
 { "id": "s489", "col": "thc", "from": "17–26%", "to": "" },
 { "id": "s489", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]" },
 { "id": "s489", "col": "effects", "from": "[\"Happy\",\"Uplifted\",\"Energetic\",\"Creative\"]", "to": "[\"Uplifted\",\"Creative\",\"Energetic\"]" },
 { "id": "s489", "col": "flavor", "from": "Citrus and earthy on the palate with a limonene-leaning finish.", "to": "citrus" },
 { "id": "s489", "col": "ailments", "from": "[\"Inflammation\",\"Pain\",\"Stress\",\"Depression\"]", "to": "[]" },
 { "id": "s397", "col": "thc", "from": "15–19%", "to": "22%" },
 { "id": "s397", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s397", "col": "effects", "from": "[\"Euphoric\",\"Happy\",\"Uplifted\",\"Creative\"]", "to": "[\"Euphoric\",\"Uplifted\",\"Creative\"]" },
 { "id": "s397", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "sweet and tropical" },
 { "id": "s397", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\",\"Nausea\"]", "to": "[]" }
];
const applyBatch16Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH16);

// 2026-10-21 (sheet row-by-row research, S34): Hawaiian Haze s454, Legend Orange Apricot s4896 and UK Cheese s1240 (Exodus Cheese merged in) carried sample-style or conflicting data.
// Hawaiian Haze (Leafly + AllBud + SeedFinder): sativa, Haze x Hawaiian, Creative/Euphoric, tropical pineapple; THC conflicts (17% vs 26%) so blanked.
// Legend Orange Apricot (Leafly + GrowDiaries): THC 23%, effects Uplifted/Relaxed.
// UK Cheese / Exodus Cheese (Leafly x2 + AllBud + SeedFinder): THC 17-20%, effects Happy/Relaxed/Euphoric, pungent cheese and skunk; unsupported ailments removed; alias Exodus Cheese added.
const STRAIN_CORRECTIONS_BATCH17 = [
 { "id": "s454", "col": "type", "from": "Hybrid", "to": "Sativa" },
 { "id": "s454", "col": "thc", "from": "17–22%", "to": "" },
 { "id": "s454", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Terpinolene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]" },
 { "id": "s454", "col": "effects", "from": "[\"Uplifted\",\"Happy\",\"Talkative\",\"Hungry\"]", "to": "[\"Creative\",\"Euphoric\"]" },
 { "id": "s454", "col": "flavor", "from": "Skunk on the palate with a myrcene-leaning finish.", "to": "tropical pineapple" },
 { "id": "s454", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Nausea\",\"Insomnia\"]", "to": "[]" },
 { "id": "s4896", "col": "thc", "from": "16-19%", "to": "23%" },
 { "id": "s4896", "col": "effects", "from": "[\"Energetic\",\"Creative\",\"Aroused\"]", "to": "[\"Uplifted\",\"Relaxed\"]" },
 { "id": "s1240", "col": "thc", "from": "20–23%", "to": "17–20%" },
 { "id": "s1240", "col": "effects", "from": "[\"Energetic\",\"Euphoric\",\"Relaxed\"]", "to": "[\"Happy\",\"Relaxed\",\"Euphoric\"]" },
 { "id": "s1240", "col": "flavor", "from": "Berry and spicy cheese undertones.", "to": "pungent cheese and skunk" },
 { "id": "s1240", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Anxiety\",\"Insomnia\"]", "to": "[]" },
 { "id": "s1240", "col": "aka", "from": "Cheese, Cognitiva", "to": "Cheese, Cognitiva, Exodus Cheese" }
];
const applyBatch17Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH17);

// 2026-10-21 (sheet row-by-row research, S35): Orange Crush s1168, Champagne Kush s2006 and Chem Tange s3656 carried sample-style or mixed-up data.
// Orange Crush (Leafly + AllBud + SeedFinder): California Orange x Blueberry, THC 15-22%, Happy/Uplifted, sweet and tangy orange.
// Champagne Kush (Leafly + AllBud): Hindu Kush x Hash Plant, breeder unknown (the Seedism Seeds breeder belonged to a different Super Silver Haze x Pot of Gold strain), THC sources conflict.
// Chem Tange (Leafly + AllBud): hybrid, Euphoric/Focused, THC sources conflict (9% vs an untested 21-29% estimate).
const STRAIN_CORRECTIONS_BATCH18 = [
 { "id": "s1168", "col": "thc", "from": "13–18%", "to": "15–22%" },
 { "id": "s1168", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Terpinolene\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s1168", "col": "effects", "from": "[\"Talkative\",\"Tingly\",\"Hungry\"]", "to": "[\"Happy\",\"Uplifted\"]" },
 { "id": "s1168", "col": "flavor", "from": "Myrcene-forward with a terpinolene undertone.", "to": "sweet and tangy orange" },
 { "id": "s2006", "col": "breeder", "from": "Seedism Seeds", "to": "" },
 { "id": "s2006", "col": "thc", "from": "14-29%", "to": "" },
 { "id": "s2006", "col": "effects", "from": "[\"Euphoric\",\"Happy\",\"Talkative\",\"Relaxed\"]", "to": "[\"Euphoric\",\"Happy\"]" },
 { "id": "s2006", "col": "flavor", "from": "Pear and tea with lavender and sweet earth.", "to": "sweet" },
 { "id": "s3656", "col": "type", "from": "Sativa", "to": "Hybrid" },
 { "id": "s3656", "col": "thc", "from": "21-29%", "to": "" },
 { "id": "s3656", "col": "effects", "from": "[\"Uplifting\",\"Focused\",\"Motivated\"]", "to": "[\"Euphoric\",\"Focused\"]" }
];
const applyBatch18Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH18);

// 2026-10-21 (sheet row-by-row research, S36): Snow Monster s562 carried sample-style data. Leafly + AllBud + GrowDiaries: The White x Starfighter, Exotic Genetix, indica-dominant, THC 17-25%, effects Relaxed/Sleepy/Giggly, earthy skunk and blue cheese. Generic terpene set, Happy/Hungry/Uplifted and unsupported ailments removed.
const STRAIN_CORRECTIONS_BATCH19 = [
 { "id": "s562", "col": "thc", "from": "12–19%", "to": "17–25%" },
 { "id": "s562", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s562", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Hungry\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Giggly\"]" },
 { "id": "s562", "col": "flavor", "from": "Sweet and earthy on the palate with a linalool-leaning finish.", "to": "earthy skunk and blue cheese" },
 { "id": "s562", "col": "ailments", "from": "[\"Pain\",\"Insomnia\",\"Stress\",\"Lack of Appetite\"]", "to": "[]" }
];
const applyBatch19Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH19);

// 2026-10-21 (sheet row-by-row research, S37): Cherry Thai s1347 and Mother of Berries s36 carried sample-style data.
// Cherry Thai (AllBud + GrowDiaries): Cherry Bomb x Oregon Purple Thai, sativa-dominant 70/30, THC 16-19%, Euphoric/Uplifted/Tingly, sour diesel with spicy herbal notes; GrowDiaries says the original breeder is unknown, so the Reeferman Seeds credit is cleared.
// Mother of Berries (Leafly + AllBud + GrowDiaries): Blueberry x Jerry Berry, THC 18-21%, sweet blueberry; the 10-21% CBD and the ailments were unsupported.
const STRAIN_CORRECTIONS_BATCH20 = [
 { "id": "s1347", "col": "breeder", "from": "Reeferman Seeds", "to": "" },
 { "id": "s1347", "col": "thc", "from": "14–22%", "to": "16–19%" },
 { "id": "s1347", "col": "terps", "from": "[{\"n\":\"Pinene\",\"p\":0.4},{\"n\":\"Ocimene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s1347", "col": "effects", "from": "[\"Energetic\",\"Clear-headed\",\"Creative\"]", "to": "[\"Euphoric\",\"Uplifted\",\"Tingly\"]" },
 { "id": "s1347", "col": "flavor", "from": "Pinene-forward with a ocimene undertone.", "to": "sour diesel with spicy herbal notes" },
 { "id": "s36", "col": "thc", "from": "16–24%", "to": "18–21%" },
 { "id": "s36", "col": "cbd", "from": "10–21%", "to": "" },
 { "id": "s36", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s36", "col": "flavor", "from": "Berry and blueberry on the palate with a myrcene-leaning finish.", "to": "sweet blueberry" },
 { "id": "s36", "col": "ailments", "from": "[\"Stress\",\"Insomnia\",\"Pain\",\"Depression\",\"Lack of Appetite\"]", "to": "[]" }
];
const applyBatch20Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH20);

// 2026-10-21 (sheet row-by-row research, S38): Alien Kush s1013 and Alien Technology s939 carried sample-style data.
// Alien Kush (AllBud + GrowDiaries + Leafly): LVPK x Alien Dawg, 50/50 hybrid, THC ~20-21%, Euphoric/Happy/Relaxed, earthy pine with spicy herbal notes; the Cali Connection breeder credit had no support (GrowDiaries credits Franchise Genetics/Obsoul33t, single source).
// Alien Technology (AllBud + GrowDiaries + Leafly): Afghan landrace indica, THC 13-19%, Happy/Relaxed/Euphoric/Sleepy, spicy herbal and woody with mint.
const STRAIN_CORRECTIONS_BATCH21 = [
 { "id": "s1013", "col": "breeder", "from": "The Cali Connection", "to": "" },
 { "id": "s1013", "col": "thc", "from": "21–27%", "to": "20–21%" },
 { "id": "s1013", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s1013", "col": "effects", "from": "[\"Uplifted\",\"Aroused\",\"Tingly\"]", "to": "[\"Euphoric\",\"Happy\",\"Relaxed\"]" },
 { "id": "s1013", "col": "flavor", "from": "Earthy on the palate with a myrcene-leaning finish.", "to": "earthy pine with spicy herbal notes" },
 { "id": "s939", "col": "thc", "from": "22–30%", "to": "13–19%" },
 { "id": "s939", "col": "terps", "from": "[{\"n\":\"Terpinolene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s939", "col": "effects", "from": "[\"Happy\",\"Relaxed\",\"Uplifted\",\"Talkative\"]", "to": "[\"Happy\",\"Relaxed\",\"Euphoric\",\"Sleepy\"]" },
 { "id": "s939", "col": "flavor", "from": "Terpinolene-forward with a pinene undertone.", "to": "spicy herbal and woody with mint" }
];
const applyBatch21Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH21);

// 2026-10-21 (sheet row-by-row research, S40): Chocolate OG s799 (sample-style data), Soul Assassin OG s2259 lean, Malverde s5059 THC.
// Chocolate OG (Leafly + GrowDiaries): THClones, True OG x Chocolate Rain, Relaxed/Sleepy, nutty and coffee with earthy notes, myrcene dominant; THC sources disagree (12-36%) so it is blanked.
// Soul Assassin OG (AllBud + Leafly): both say indica-dominant.
// Malverde (AllBud 28-29% THC contradicts the stored 20-25%; SeedFinder gives none) so THC is blanked.
const STRAIN_CORRECTIONS_BATCH22 = [
 { "id": "s799", "col": "thc", "from": "16–25%", "to": "" },
 { "id": "s799", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]" },
 { "id": "s799", "col": "effects", "from": "[\"Happy\",\"Relaxed\",\"Sleepy\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Sleepy\"]" },
 { "id": "s799", "col": "flavor", "from": "Sweet and earthy on the palate with a linalool-leaning finish.", "to": "nutty and coffee with earthy notes" },
 { "id": "s799", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Inflammation\"]", "to": "[\"Pain\"]" },
 { "id": "s2259", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant" },
 { "id": "s5059", "col": "thc", "from": "20-25%", "to": "" }
];
const applyBatch22Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH22);

// 2026-10-21 (sheet row-by-row research, S41): Cookie Monster s689 and Chocolate Chunk s222 carried sample-style data.
// Cookie Monster (AllBud + Leafly + GrowDiaries): indica, Girl Scout Cookies x OG Kush, THC 17-21%, sweet vanilla and mint with woody pine notes; only Pain is in two ailment lists.
// Chocolate Chunk (AllBud + Leafly + GrowDiaries): pure indica from Afghani (T.H.Seeds per Leafly + GrowDiaries), THC 18-23%, Relaxed/Sleepy/Hungry, coffee and nutty with earthy pine notes, myrcene dominant.
const STRAIN_CORRECTIONS_BATCH23 = [
 { "id": "s689", "col": "type", "from": "Hybrid", "to": "Indica" },
 { "id": "s689", "col": "thc", "from": "17–22%", "to": "17–21%" },
 { "id": "s689", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s689", "col": "flavor", "from": "Grape on the palate with a myrcene-leaning finish.", "to": "sweet vanilla and mint with woody pine notes" },
 { "id": "s689", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Insomnia\",\"Lack of Appetite\",\"Muscle Spasms\"]", "to": "[\"Pain\"]" },
 { "id": "s222", "col": "type", "from": "Hybrid", "to": "Indica" },
 { "id": "s222", "col": "thc", "from": "13–19%", "to": "18–23%" },
 { "id": "s222", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]" },
 { "id": "s222", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Happy\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Hungry\"]" },
 { "id": "s222", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "coffee and nutty with earthy pine notes" },
 { "id": "s222", "col": "ailments", "from": "[\"Insomnia\",\"Pain\",\"Stress\",\"Depression\",\"Nausea\"]", "to": "[]" }
];
const applyBatch23Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH23);

// 2026-10-21 (sheet row-by-row research, S42): Chocolate Thai s94 (sample-style data), T.I.T.S. s2351 type, Cookies and Cream s1523 terps/flavor.
// Chocolate Thai (AllBud + Leafly + GrowDiaries): Thai sativa landrace, no breeder given by any source, CBD 0-1%, Creative/Focused/Uplifted/Aroused, coffee and nutty with spicy notes, alias Thai Sticks (AllBud + GrowDiaries).
// T.I.T.S. (AllBud + Leafly + GrowDiaries): all three list it as a hybrid.
// Cookies and Cream (AllBud + Leafly + GrowDiaries): vanilla, nutty, sweet; the stored linalool terpene had no support.
const STRAIN_CORRECTIONS_BATCH24 = [
 { "id": "s94", "col": "type", "from": "Hybrid", "to": "Sativa" },
 { "id": "s94", "col": "breeder", "from": "DJ Short", "to": "" },
 { "id": "s94", "col": "cbd", "from": "16–20%", "to": "" },
 { "id": "s94", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s94", "col": "effects", "from": "[\"Relaxed\",\"Uplifted\",\"Happy\",\"Focused\"]", "to": "[\"Creative\",\"Focused\",\"Uplifted\",\"Aroused\"]" },
 { "id": "s94", "col": "flavor", "from": "Earthy and coffee on the palate with a myrcene-leaning finish.", "to": "coffee and nutty with spicy notes" },
 { "id": "s94", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\",\"Insomnia\",\"Nausea\"]", "to": "[\"Anxiety\",\"Depression\",\"Stress\"]" },
 { "id": "s2351", "col": "type", "from": "Sativa", "to": "Hybrid" },
 { "id": "s1523", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.3},{\"n\":\"Linalool\",\"p\":0.2},{\"n\":\"Limonene\",\"p\":0.15}]", "to": "[]" },
 { "id": "s1523", "col": "flavor", "from": "Sweet vanilla and earthy cookie notes.", "to": "sweet vanilla and nutty" }
];
const applyBatch24Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH24);

// 2026-10-21 (sheet row-by-row research, S43): Pre-98 Bubba Kush s139, Don Shula s4015, Princess Leia s2829.
// Pre-98 Bubba Kush (AllBud + Leafly + GrowDiaries): Relaxed/Sleepy/Hungry in all three; Pain/Stress/Insomnia in Leafly + GrowDiaries (Inflammation had no source, appetite loss only GrowDiaries).
// Don Shula (AllBud + Leafly + GrowDiaries): all list a hybrid; caryophyllene dominant in Leafly + GrowDiaries; CBD "low" replaced by <1% (GrowDiaries 0.1%).
// Princess Leia (AllBud + Leafly): both list a hybrid.
const STRAIN_CORRECTIONS_BATCH25 = [
 { "id": "s139", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Hungry\"]" },
 { "id": "s139", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Insomnia\",\"Inflammation\",\"Lack of Appetite\"]", "to": "[\"Pain\",\"Stress\",\"Insomnia\"]" },
 { "id": "s4015", "col": "type", "from": "Indica", "to": "Hybrid" },
 { "id": "s4015", "col": "cbd", "from": "low", "to": "<1%" },
 { "id": "s4015", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.2},{\"n\":\"Myrcene\",\"p\":0.15},{\"n\":\"Caryophyllene\",\"p\":0.1}]", "to": "[{\"n\":\"Caryophyllene\",\"p\":0.4}]" },
 { "id": "s2829", "col": "type", "from": "Sativa", "to": "Hybrid" }
];
const applyBatch25Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH25);

// 2026-10-21 (sheet row-by-row research, S44): Colombian s1286 and Double G s1399 carried sample-style data; White Poison s6381 THC/flavor.
// Colombian: only GrowDiaries has a page (sativa landrace, 17% THC); the stored THC, terps, effects and flavor had no support, so they are blanked.
// Double G: the name covers different strains (SeedFinder: Ripper Seeds Afghani indica; Unknown or Legendary G13HP x Gum13); DMan Seeds' breeder list has no Double G, so the breeder and the sample-style values are blanked.
// White Poison (Leafly + GrowDiaries): THC 22-27% (AllBud 24-27%), flavor diesel, cheese, sage.
const STRAIN_CORRECTIONS_BATCH26 = [
 { "id": "s1286", "col": "thc", "from": "23–31%", "to": "" },
 { "id": "s1286", "col": "terps", "from": "[{\"n\":\"Humulene\",\"p\":0.4},{\"n\":\"Terpinolene\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s1286", "col": "effects", "from": "[\"Talkative\",\"Sleepy\",\"Creative\"]", "to": "[]" },
 { "id": "s1286", "col": "flavor", "from": "Humulene-forward with a terpinolene undertone.", "to": "" },
 { "id": "s1399", "col": "breeder", "from": "DMan Seeds", "to": "" },
 { "id": "s1399", "col": "thc", "from": "23–31%", "to": "" },
 { "id": "s1399", "col": "cbd", "from": "<1%", "to": "" },
 { "id": "s1399", "col": "terps", "from": "[{\"n\":\"Terpinolene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]" },
 { "id": "s1399", "col": "effects", "from": "[\"Giggly\",\"Euphoric\",\"Talkative\"]", "to": "[]" },
 { "id": "s1399", "col": "flavor", "from": "Terpinolene-forward with a humulene undertone.", "to": "" },
 { "id": "s6381", "col": "thc", "from": "22%", "to": "22–27%" },
 { "id": "s6381", "col": "flavor", "from": "Pine, skunk.", "to": "diesel and cheese with sage" }
];
const applyBatch26Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH26);

// 2026-10-21 (sheet row-by-row research, S45): Illuminati OG s808, Panama Red s407, Face Off OG s324 carried sample-style data.
// Illuminati OG (AllBud + Leafly + GrowDiaries): direct cut of Josh D's Club 33 OG, indica-dominant, THC 22%, Relaxed/Sleepy/Euphoric/Giggly, pine and spicy herbal with sweet notes.
// Panama Red (AllBud + Leafly + GrowDiaries): sativa landrace, THC 16-22%, Energetic/Happy/Talkative/Euphoric, earthy and woody with tea and pepper; no source credits Sensi Seeds (Leafly: Reeferman).
// Face Off OG (Leafly + GrowDiaries): OG Kush phenotype, THC 21-22%, Relaxed/Tingly, pine, Pain/Stress; aliases Face Off, OG Face Off, Faceoff OG Kush.
const STRAIN_CORRECTIONS_BATCH27 = [
 { "id": "s808", "col": "thc", "from": "12–17%", "to": "22%" },
 { "id": "s808", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s808", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Euphoric\",\"Happy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Euphoric\",\"Giggly\"]" },
 { "id": "s808", "col": "flavor", "from": "Earthy and pine on the palate with a myrcene-leaning finish.", "to": "pine and spicy herbal with sweet notes" },
 { "id": "s808", "col": "ailments", "from": "[\"Depression\",\"Insomnia\",\"Stress\"]", "to": "[\"Stress\",\"Insomnia\"]" },
 { "id": "s407", "col": "type", "from": "Hybrid", "to": "Sativa" },
 { "id": "s407", "col": "thc", "from": "23–32%", "to": "16–22%" },
 { "id": "s407", "col": "breeder", "from": "Sensi Seeds", "to": "" },
 { "id": "s407", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]" },
 { "id": "s407", "col": "effects", "from": "[\"Happy\",\"Uplifted\",\"Energetic\",\"Focused\"]", "to": "[\"Energetic\",\"Happy\",\"Talkative\",\"Euphoric\"]" },
 { "id": "s407", "col": "flavor", "from": "Citrus and pine on the palate with a limonene-leaning finish.", "to": "earthy and woody with tea and pepper notes" },
 { "id": "s407", "col": "ailments", "from": "[\"Depression\",\"Stress\",\"Pain\"]", "to": "[]" },
 { "id": "s324", "col": "thc", "from": "23–31%", "to": "21–22%" },
 { "id": "s324", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]" },
 { "id": "s324", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Hungry\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Tingly\"]" },
 { "id": "s324", "col": "flavor", "from": "Earthy and citrus on the palate with a myrcene-leaning finish.", "to": "pine" },
 { "id": "s324", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Insomnia\",\"Lack of Appetite\",\"Depression\"]", "to": "[\"Pain\",\"Stress\"]" },
 { "id": "s324", "col": "aka", "from": "Face-Off OG", "to": "Face-Off OG, Face Off, OG Face Off, Faceoff OG Kush, Face Off OG Kush" }
];
const applyBatch27Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH27);

const STRAIN_CORRECTIONS_BATCH28 = [
 {"id": "s494", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s494", "col": "terps", "from": "[{\"n\":\"Pinene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s494", "col": "effects", "from": "[\"Uplifted\",\"Focused\",\"Relaxed\",\"Hungry\"]", "to": "[\"Euphoric\",\"Uplifted\"]"},
 {"id": "s494", "col": "flavor", "from": "Pine and citrus on the palate with a pinene-leaning finish.", "to": "citrus and pine"},
 {"id": "s494", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Nausea\"]", "to": "[]"},
 {"id": "s853", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s853", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Creative\",\"Hungry\"]", "to": "[\"Creative\",\"Energetic\"]"},
 {"id": "s853", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "nutty and berry with woody notes"},
 {"id": "s853", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Nausea\"]", "to": "[\"Stress\",\"Depression\"]"},
 {"id": "s2422", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s2422", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s2422", "col": "effects", "from": "[\"Relaxed\",\"Calm\",\"Happy\"]", "to": "[\"Relaxed\",\"Focused\",\"Sleepy\"]"},
 {"id": "s2422", "col": "flavor", "from": "Sweet and tangy with a touch of kush and pine.", "to": "woody and buttery"}
];
const applyBatch28Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH28);

const STRAIN_CORRECTIONS_BATCH29 = [
 {"id": "s228", "col": "thc", "from": "21–28%", "to": "15–23%"},
 {"id": "s228", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s228", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Sleepy\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Euphoric\"]"},
 {"id": "s228", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "sweet and earthy with blueberry notes"},
 {"id": "s228", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Insomnia\"]", "to": "[\"Stress\",\"Pain\"]"},
 {"id": "s2881", "col": "effects", "from": "[\"Energetic\",\"Relaxed\"]", "to": "[\"Energetic\",\"Uplifted\",\"Focused\"]"},
 {"id": "s2881", "col": "flavor", "from": "Unique grapefruit essence.", "to": "grapefruit and citrus with diesel"},
 {"id": "s4741", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s4741", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s4741", "col": "thc", "from": "18-36.5%", "to": "22–26%"},
 {"id": "s4741", "col": "effects", "from": "[\"Creative\",\"Relaxed\",\"Uplifted\"]", "to": "[\"Creative\",\"Relaxed\"]"},
 {"id": "s4741", "col": "flavor", "from": "Dank spicy fuel.", "to": "pine and spicy with diesel notes"}
];
const applyBatch29Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH29);

const STRAIN_CORRECTIONS_BATCH30 = [
 {"id": "s3893", "col": "effects", "from": "[\"Lifted\",\"Munchies\",\"Relaxed\"]", "to": "[\"Happy\",\"Hungry\",\"Uplifted\"]"},
 {"id": "s3893", "col": "flavor", "from": "Sweet creamy vanilla ice cream, nutty chocolate.", "to": "sweet and creamy with vanilla"},
 {"id": "s6779", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s6779", "col": "flavor", "from": "Piney kush with sweet grape.", "to": "earthy and pine with grape sweetness"},
 {"id": "s5571", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s5571", "col": "effects", "from": "[\"Happy\",\"Sleepy\",\"Relaxed\"]", "to": "[\"Relaxed\",\"Uplifted\"]"},
 {"id": "s5571", "col": "flavor", "from": "Spicy grapes, dank diesel, earthy berry.", "to": "grape with spicy notes"},
 {"id": "s1222", "col": "thc", "from": "23–31%", "to": "18–23%"},
 {"id": "s1222", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Ocimene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s1222", "col": "effects", "from": "[\"Sleepy\",\"Relaxed\",\"Giggly\"]", "to": "[\"Euphoric\",\"Happy\",\"Uplifted\"]"},
 {"id": "s1222", "col": "flavor", "from": "Limonene-forward with a ocimene undertone.", "to": "sweet strawberry with berry notes"},
 {"id": "s1222", "col": "breeder", "from": "Royal Dutch Genetics", "to": ""}
];
const applyBatch30Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH30);

const STRAIN_CORRECTIONS_BATCH31 = [
 {"id": "s696", "col": "thc", "from": "23–29%", "to": "17–24%"},
 {"id": "s696", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]", "to": "[{\"n\":\"Caryophyllene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]"},
 {"id": "s696", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Euphoric\",\"Happy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Focused\"]"},
 {"id": "s696", "col": "flavor", "from": "Citrus on the palate with a limonene-leaning finish.", "to": "citrus with floral notes"},
 {"id": "s696", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Insomnia\",\"Nausea\"]", "to": "[\"Insomnia\",\"Stress\",\"Migraines\"]"}
];
const applyBatch31Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH31);

const STRAIN_CORRECTIONS_BATCH32 = [
 {"id": "s168", "col": "thc", "from": "19–24%", "to": "14–19%"},
 {"id": "s168", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s168", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Happy\",\"Euphoric\"]", "to": "[\"Sleepy\"]"},
 {"id": "s168", "col": "flavor", "from": "Earthy and coffee on the palate with a myrcene-leaning finish.", "to": "coffee and nutty"},
 {"id": "s168", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Insomnia\",\"Lack of Appetite\"]", "to": "[]"},
 {"id": "s168", "col": "breeder", "from": "DNA Genetics", "to": ""}
];
const applyBatch32Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH32);

const STRAIN_CORRECTIONS_BATCH33 = [
 {"id": "s1584", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s1584", "col": "thc", "from": "18–23%", "to": "19–22%"},
 {"id": "s1584", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Happy\",\"Sleepy\"]"},
 {"id": "s1584", "col": "flavor", "from": "Sweet lime candy and citrus over a peppery, earthy base.", "to": "sweet lime candy and citrus with chocolate notes"},
 {"id": "s138", "col": "type", "from": "Hybrid", "to": "Indica"},
 {"id": "s138", "col": "thc", "from": "15–24%", "to": "18–22%"},
 {"id": "s138", "col": "terps", "from": "[{\"n\":\"Pinene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s138", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Euphoric\",\"Hungry\"]"},
 {"id": "s138", "col": "flavor", "from": "Pine and earthy on the palate with a pinene-leaning finish.", "to": "pine and woody"},
 {"id": "s138", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\",\"Insomnia\",\"Inflammation\"]", "to": "[\"Pain\",\"Insomnia\"]"},
 {"id": "s1109", "col": "thc", "from": "32–35%", "to": "17–24%"},
 {"id": "s1109", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1109", "col": "effects", "from": "[\"Social\",\"Euphoric\",\"Talkative\"]", "to": "[\"Euphoric\",\"Creative\",\"Relaxed\"]"},
 {"id": "s1109", "col": "flavor", "from": "Limonene-forward with a pinene undertone.", "to": "diesel and lemon with sweet notes"},
 {"id": "s1109", "col": "aka", "from": "HB, Underdog OG, Underdog", "to": "HB"},
 {"id": "s291", "col": "type", "from": "Hybrid", "to": "Sativa"},
 {"id": "s291", "col": "thc", "from": "20–28%", "to": "22%"},
 {"id": "s291", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s291", "col": "effects", "from": "[\"Happy\",\"Euphoric\",\"Creative\",\"Energetic\"]", "to": "[\"Creative\",\"Uplifted\",\"Euphoric\"]"},
 {"id": "s291", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "citrus and pine with earthy notes"},
 {"id": "s291", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\",\"Nausea\"]", "to": "[\"Stress\",\"Depression\"]"},
 {"id": "s2303", "col": "thc", "from": "30-37%", "to": "21–23%"}
];
const applyBatch33Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH33);

const STRAIN_CORRECTIONS_BATCH34 = [
 {"id": "s5865", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s5865", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s5865", "col": "flavor", "from": "Sweet sour flowery, spicy skunky.", "to": "citrus and sour with spicy notes"},
 {"id": "s4326", "col": "effects", "from": "[\"Happy\",\"Talkative\"]", "to": "[\"Euphoric\",\"Relaxed\",\"Uplifted\"]"}
];
const applyBatch34Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH34);

const STRAIN_CORRECTIONS_BATCH35 = [
 {"id": "s3870", "col": "parents", "from": "[\"Cookie Crumbles\",\"White Fire Alien OG\"]", "to": "[\"Cookies\",\"White Fire Alien OG\"]"},
 {"id": "s3870", "col": "effects", "from": "[\"Uplifted\",\"Tingly\",\"Relaxed\"]", "to": "[\"Euphoric\",\"Relaxed\"]"},
 {"id": "s3870", "col": "flavor", "from": "Sharp lemon, earthy, pungent.", "to": "lemon and sweet"},
 {"id": "s2234", "col": "lean", "from": "Indica-leaning", "to": ""},
 {"id": "s2234", "col": "thc", "from": "18-24%", "to": "19%"},
 {"id": "s2234", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.3},{\"n\":\"Humulene\",\"p\":0.2},{\"n\":\"Limonene\",\"p\":0.15}]", "to": "[]"}
];
const applyBatch35Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH35);

const STRAIN_CORRECTIONS_BATCH36 = [
 {"id": "s5252", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s5252", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s5252", "col": "effects", "from": "[\"Focused\",\"Energetic\",\"Relaxed\"]", "to": "[\"Uplifted\",\"Focused\",\"Relaxed\",\"Happy\"]"},
 {"id": "s5252", "col": "flavor", "from": "Berries, diesel undertones.", "to": "menthol and pine with skunk and woody notes"},
 {"id": "s82", "col": "thc", "from": "14–20%", "to": "15–18%"},
 {"id": "s82", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s82", "col": "effects", "from": "[\"Happy\",\"Euphoric\",\"Aroused\",\"Focused\"]", "to": "[\"Aroused\",\"Euphoric\",\"Energetic\"]"},
 {"id": "s82", "col": "flavor", "from": "Earthy and citrus on the palate with a myrcene-leaning finish.", "to": "lemon and citrus with floral notes"},
 {"id": "s82", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Nausea\"]", "to": "[\"Stress\",\"Depression\",\"Anxiety\"]"}
];
const applyBatch36Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH36);

const STRAIN_CORRECTIONS_BATCH37 = [
 {"id": "s1866", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s1866", "col": "thc", "from": "21-29%", "to": "21–27%"},
 {"id": "s1866", "col": "effects", "from": "[\"Energetic\",\"Uplifted\",\"Relaxed\"]", "to": "[\"Relaxed\",\"Creative\",\"Euphoric\"]"},
 {"id": "s1866", "col": "flavor", "from": "Velvety kush with pepper, sour lemon, and pine.", "to": "lemon and pine with citrus notes"}
];
const applyBatch37Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH37);

const STRAIN_CORRECTIONS_BATCH38 = [
 {"id": "s1229", "col": "thc", "from": "26–28%", "to": "20–21%"},
 {"id": "s1229", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1229", "col": "effects", "from": "[\"Hungry\",\"Energetic\",\"Talkative\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s1229", "col": "flavor", "from": "Caryophyllene-forward with a limonene undertone.", "to": "pine and lemon with earthy, woody notes"},
 {"id": "s1229", "col": "breeder", "from": "Cultivation Specialists", "to": ""}
];
const applyBatch38Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH38);

const STRAIN_CORRECTIONS_BATCH39 = [
 {"id": "s119", "col": "lean", "from": "", "to": "Indica-dominant"},
 {"id": "s119", "col": "thc", "from": "13–17%", "to": "15–22%"},
 {"id": "s119", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s119", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Happy\",\"Sleepy\"]"},
 {"id": "s119", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "peppery with citrus notes"},
 {"id": "s119", "col": "breeder", "from": "TGA Seeds", "to": ""},
 {"id": "s119", "col": "ailments", "from": "[\"Pain\",\"Lack of Appetite\",\"Stress\",\"Insomnia\",\"Inflammation\"]", "to": "[\"Pain\",\"Insomnia\"]"},
 {"id": "s7098", "col": "flavor", "from": "Pineapple and tropical fruit over gentle sweetness.", "to": "pineapple and tropical fruit"},
 {"id": "s1155", "col": "lean", "from": "", "to": "Indica-dominant"},
 {"id": "s1155", "col": "thc", "from": "17–25%", "to": "18–23%"},
 {"id": "s1155", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1155", "col": "effects", "from": "[\"Talkative\",\"Aroused\",\"Calm\"]", "to": "[\"Happy\",\"Sleepy\"]"},
 {"id": "s1155", "col": "flavor", "from": "Limonene-forward with a pinene undertone.", "to": "berry and sweet"}
];
const applyBatch39Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH39);

const STRAIN_CORRECTIONS_BATCH40 = [
 {"id": "s2136", "col": "lean", "from": "", "to": "Balanced"},
 {"id": "s2136", "col": "thc", "from": "18-27%", "to": "18–25%"},
 {"id": "s2136", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.3},{\"n\":\"Limonene\",\"p\":0.2},{\"n\":\"Myrcene\",\"p\":0.15}]", "to": "[]"},
 {"id": "s2136", "col": "effects", "from": "[\"Relaxed\",\"Hungry\",\"Calm\"]", "to": "[\"Relaxed\",\"Euphoric\",\"Giggly\",\"Hungry\"]"},
 {"id": "s2136", "col": "flavor", "from": "Chestnut, coffee, and diesel.", "to": "coffee and nutty with skunky notes"}
];
const applyBatch40Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH40);

const STRAIN_CORRECTIONS_BATCH41 = [
 {"id": "s616", "col": "effects", "from": "[\"Happy\",\"Relaxed\",\"Uplifted\",\"Euphoric\"]", "to": "[\"Energetic\",\"Creative\",\"Focused\",\"Euphoric\"]"},
 {"id": "s616", "col": "flavor", "from": "Fruity, citrus aroma.", "to": "citrus and earthy with woody notes"},
 {"id": "s616", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\"]", "to": "[\"Stress\",\"Depression\",\"Inflammation\"]"},
 {"id": "s1594", "col": "effects", "from": "[\"Energetic\"]", "to": "[\"Happy\",\"Euphoric\",\"Creative\"]"}
];
const applyBatch41Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH41);

const STRAIN_CORRECTIONS_BATCH42 = [
 {"id": "s6777", "col": "flavor", "from": "Earthy, floral, sweet notes.", "to": "earthy and pine"},
 {"id": "s6844", "col": "lean", "from": "", "to": "Balanced"},
 {"id": "s6844", "col": "thc", "from": "20-24%", "to": "18–20%"},
 {"id": "s6844", "col": "effects", "from": "[\"Energetic\",\"Relaxed\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Creative\",\"Energetic\"]"},
 {"id": "s6844", "col": "flavor", "from": "Sweet grassy berries with an earthy OG finish.", "to": "blueberry with earthy notes"}
];
const applyBatch42Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH42);

const STRAIN_CORRECTIONS_BATCH43 = [
 {"id": "s7017", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s4262", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s4262", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s4262", "col": "thc", "from": "23%", "to": "16–23%"},
 {"id": "s4262", "col": "effects", "from": "[\"Happy\",\"Hungry\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Euphoric\",\"Happy\"]"},
 {"id": "s4262", "col": "flavor", "from": "Sweet, earthy, minty, citrus, vanilla.", "to": "sweet vanilla with mint and citrus"}
];
const applyBatch43Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH43);

const STRAIN_CORRECTIONS_BATCH44 = [
 {"id": "s1156", "col": "effects", "from": "[\"Relaxed\"]", "to": "[\"Relaxed\",\"Giggly\",\"Hungry\",\"Happy\"]"}
];
const applyBatch44Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH44);

const STRAIN_CORRECTIONS_BATCH45 = [
 {"id": "s7186", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Euphoric\",\"Happy\",\"Uplifted\"]"},
 {"id": "s7186", "col": "flavor", "from": "Sweet citrus candy and cream with gassy pine.", "to": "citrus and pine with woody notes"},
 {"id": "s7309", "col": "ailments", "from": "[\"Depression\",\"Pain\"]", "to": "[\"Depression\",\"Pain\",\"Stress\"]"}
];
const applyBatch45Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH45);

const STRAIN_CORRECTIONS_BATCH46 = [
 {"id": "s7386", "col": "flavor", "from": "pine and gas", "to": "sweet berry and cream with diesel and pine"},
 {"id": "s7386", "col": "parents", "from": "[\"Zawtz\",\"Gelatti\"]", "to": "[\"Zawtz\",\"Gelatti BX\"]"},
 {"id": "s2125", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s2125", "col": "thc", "from": "18-25%", "to": "24–25%"},
 {"id": "s2125", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.3},{\"n\":\"Pinene\",\"p\":0.2}]", "to": "[]"},
 {"id": "s2125", "col": "effects", "from": "[\"Uplifted\",\"Happy\",\"Energetic\"]", "to": "[\"Uplifted\",\"Focused\",\"Creative\"]"},
 {"id": "s2125", "col": "flavor", "from": "Fresh tart orange and lemon with kush.", "to": "lemon and orange citrus with pine notes"}
];
const applyBatch46Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH46);

const STRAIN_CORRECTIONS_BATCH47 = [
 {"id": "s7204", "col": "flavor", "from": "Sweet berries and grapes with roasted nuts and citrus.", "to": "sweet berry and grape with nutty notes"}
];
const applyBatch47Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH47);

const STRAIN_CORRECTIONS_BATCH48 = [
 {"id": "s4172", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s4172", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s4172", "col": "effects", "from": "[\"Uplifted\",\"Energized\",\"Sociable\"]", "to": "[\"Creative\",\"Uplifted\"]"},
 {"id": "s4172", "col": "breeder", "from": "Jigga (unconfirmed)", "to": "Jigga"},
 {"id": "s6857", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.3},{\"n\":\"Caryophyllene\",\"p\":0.15},{\"n\":\"Limonene\",\"p\":0.1}]", "to": "[]"},
 {"id": "s6857", "col": "effects", "from": "[\"Euphoric\",\"Relaxed\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Happy\",\"Euphoric\"]"},
 {"id": "s6857", "col": "flavor", "from": "Gassy kush with sweet cookie and berry notes.", "to": "sweet berry and spicy herbal with gassy kush notes"}
];
const applyBatch48Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH48);

const STRAIN_CORRECTIONS_BATCH49 = [
 {"id": "s6912", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Uplifted\"]"},
 {"id": "s6912", "col": "flavor", "from": "Pine, citrus and diesel, smooth and creamy.", "to": "citrus and pine with diesel and tropical notes"}
];
const applyBatch49Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH49);

const STRAIN_CORRECTIONS_BATCH50 = [
 {"id": "s7135", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s1593", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s1593", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.3},{\"n\":\"Limonene\",\"p\":0.2},{\"n\":\"Caryophyllene\",\"p\":0.15}]", "to": "[]"},
 {"id": "s1593", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\",\"Talkative\"]", "to": "[\"Relaxed\",\"Euphoric\",\"Tingly\"]"},
 {"id": "s1593", "col": "flavor", "from": "Pungent citrus, sweet earth, pine, and fuel.", "to": "pungent chemical with pine notes"}
];
const applyBatch50Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH50);

const STRAIN_CORRECTIONS_BATCH51 = [
 {"id": "s1236", "col": "effects", "from": "[\"Euphoric\",\"Creative\",\"Happy\"]", "to": "[\"Euphoric\",\"Creative\",\"Happy\",\"Uplifted\"]"},
 {"id": "s1236", "col": "flavor", "from": "Sweet lemon and spicy pine.", "to": "pine and lemon with earthy notes"},
 {"id": "s81", "col": "thc", "from": "19–28%", "to": "20%"},
 {"id": "s81", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s81", "col": "effects", "from": "[\"Happy\",\"Uplifted\",\"Relaxed\",\"Creative\"]", "to": "[\"Happy\",\"Creative\",\"Euphoric\"]"},
 {"id": "s81", "col": "flavor", "from": "Sweet and citrus on the palate with a linalool-leaning finish.", "to": "sweet citrus and pineapple with tropical notes"},
 {"id": "s81", "col": "breeder", "from": "Super Sativa Seed Club", "to": ""},
 {"id": "s81", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\",\"Lack of Appetite\",\"Nausea\"]", "to": "[\"Stress\",\"Depression\",\"Pain\",\"Anxiety\"]"},
 {"id": "s81", "col": "lean", "from": "", "to": "Sativa-leaning"}
];
const applyBatch51Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH51);

const STRAIN_CORRECTIONS_BATCH52 = [
 {"id": "s7177", "col": "flavor", "from": "Pine, tea and citrus.", "to": "orange and citrus with coffee and pine notes"},
 {"id": "s648", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s648", "col": "effects", "from": "[\"Energetic\",\"Focused\",\"Uplifted\",\"Relaxed\"]", "to": "[\"Energetic\",\"Uplifted\",\"Creative\"]"},
 {"id": "s648", "col": "flavor", "from": "Earthy on the palate with a myrcene-leaning finish.", "to": "sweet lemon and woody"},
 {"id": "s648", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Nausea\"]", "to": "[\"Stress\",\"Depression\"]"}
];
const applyBatch52Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH52);

const STRAIN_CORRECTIONS_BATCH53 = [
 {"id": "s5179", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s5179", "col": "effects", "from": "[\"Energetic\"]", "to": "[\"Happy\",\"Focused\",\"Relaxed\"]"},
 {"id": "s5179", "col": "flavor", "from": "Sweet floral, herbal citrus.", "to": "sweet citrus with floral notes"}
];
const applyBatch53Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH53);

const STRAIN_CORRECTIONS_BATCH54 = [
 {"id": "s6922", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s56", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s56", "col": "effects", "from": "[\"Energetic\",\"Uplifted\",\"Focused\"]", "to": "[\"Euphoric\",\"Creative\",\"Energetic\"]"},
 {"id": "s56", "col": "flavor", "from": "Strong lemon, more sweet than tart.", "to": "lemon citrus with diesel and pine notes"},
 {"id": "s56", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Depression\",\"Inflammation\",\"Nausea\"]", "to": "[\"Stress\",\"Anxiety\",\"Depression\",\"Pain\"]"},
 {"id": "s6748", "col": "thc", "from": "20-26%", "to": "25–26%"},
 {"id": "s6748", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0},{\"n\":\"Limonene\",\"p\":0},{\"n\":\"Myrcene\",\"p\":0}]", "to": "[]"},
 {"id": "s6748", "col": "effects", "from": "[\"Euphoric\",\"Happy\",\"Relaxed\"]", "to": "[\"Happy\",\"Talkative\",\"Relaxed\",\"Focused\"]"},
 {"id": "s6748", "col": "aka", "from": "Sour Double, Sour Dubble", "to": "Sour Double, Sour Dubble, Sour Dubs, Sour Dubb Dawg"}
];
const applyBatch54Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH54);

const STRAIN_CORRECTIONS_BATCH55 = [
 {"id": "s394", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\"]", "to": "[\"Stress\",\"Depression\",\"Migraines\"]"}
];
const applyBatch55Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH55);

const STRAIN_CORRECTIONS_BATCH56 = [
 {"id": "s1617", "col": "thc", "from": "20–25%", "to": "23%"},
 {"id": "s1617", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.3},{\"n\":\"Caryophyllene\",\"p\":0.25},{\"n\":\"Linalool\",\"p\":0.15}]", "to": "[]"},
 {"id": "s1617", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Uplifted\"]", "to": "[\"Euphoric\",\"Uplifted\",\"Creative\",\"Relaxed\"]"},
 {"id": "s1617", "col": "flavor", "from": "Sweet cream and citrus with a smooth, gassy finish.", "to": "diesel and vanilla with sweet notes"},
 {"id": "s7152", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s7312", "col": "parents", "from": "[\"Paris OG\",\"Face Off OG\"]", "to": "[\"Paris OG\"]"},
 {"id": "s7312", "col": "lean", "from": "Indica-dominant", "to": ""}
];
const applyBatch56Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH56);

const STRAIN_CORRECTIONS_BATCH57 = [
 {"id": "s835", "col": "thc", "from": "21–29%", "to": "20–21%"},
 {"id": "s835", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s835", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Talkative\",\"Creative\"]", "to": "[\"Euphoric\",\"Happy\",\"Sleepy\"]"},
 {"id": "s835", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "blueberry and grape"},
 {"id": "s835", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Depression\",\"Insomnia\"]", "to": "[\"Stress\",\"Insomnia\",\"Pain\"]"},
 {"id": "s410", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Insomnia\",\"Depression\",\"Inflammation\"]", "to": "[\"Pain\",\"Stress\",\"Anxiety\"]"},
 {"id": "s593", "col": "thc", "from": "21–28%", "to": "18–19%"},
 {"id": "s593", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s593", "col": "effects", "from": "[\"Happy\",\"Uplifted\",\"Energetic\",\"Euphoric\"]", "to": "[\"Uplifted\",\"Euphoric\",\"Happy\"]"},
 {"id": "s593", "col": "flavor", "from": "Sweet and skunk on the palate with a linalool-leaning finish.", "to": "sweet and skunky with grapefruit and tropical notes"}
];
const applyBatch57Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH57);

const STRAIN_CORRECTIONS_BATCH58 = [
 {"id": "s7071", "col": "lean", "from": "Indica-leaning", "to": ""}
];
const applyBatch58Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH58);

const STRAIN_CORRECTIONS_BATCH59 = [
 {"id": "s7111", "col": "aka", "from": "Lowryder #1, Original Lowryder", "to": "Lowryder #1, Original Lowryder, Low Ryder, Lowrider"}
];
const applyBatch59Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH59);

const STRAIN_CORRECTIONS_BATCH60 = [
 {"id": "s269", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\",\"Nausea\",\"Insomnia\"]", "to": "[\"Stress\",\"Depression\",\"Pain\"]"},
 {"id": "s269", "col": "flavor", "from": "Sweet and citrusy with floral lavender, earthy spice and a woody, hash-like finish.", "to": "sweet and citrusy with floral and earthy notes"},
 {"id": "s1159", "col": "thc", "from": "21–25%", "to": ""},
 {"id": "s1159", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1159", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1159", "col": "effects", "from": "[\"Creative\",\"Giggly\",\"Sleepy\"]", "to": "[\"Creative\",\"Euphoric\"]"},
 {"id": "s1159", "col": "flavor", "from": "Myrcene-forward with a linalool undertone.", "to": "diesel and lemon"},
 {"id": "s1159", "col": "lean", "from": "", "to": "Sativa-dominant"}
];
const applyBatch60Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH60);

const STRAIN_CORRECTIONS_BATCH61 = [
 {"id": "s774", "col": "thc", "from": "22–28%", "to": ""},
 {"id": "s774", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s774", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s774", "col": "effects", "from": "[\"Happy\",\"Relaxed\",\"Uplifted\",\"Talkative\"]", "to": "[\"Focused\"]"},
 {"id": "s774", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "skunky"},
 {"id": "s774", "col": "breeder", "from": "Homegrown Fantaseeds", "to": ""},
 {"id": "s774", "col": "ailments", "from": "[\"Lack of Appetite\",\"Stress\",\"Depression\"]", "to": "[\"Lack of Appetite\",\"Stress\",\"Anxiety\"]"}
];
const applyBatch61Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH61);

const STRAIN_CORRECTIONS_BATCH62 = [
 {"id": "s1221", "col": "thc", "from": "15–23%", "to": ""},
 {"id": "s1221", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1221", "col": "effects", "from": "[\"Tingly\",\"Talkative\",\"Social\"]", "to": "[\"Happy\",\"Creative\"]"},
 {"id": "s1221", "col": "flavor", "from": "Linalool-forward with a limonene undertone.", "to": "strawberry and diesel with sweet notes"}
];
const applyBatch62Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH62);

const STRAIN_CORRECTIONS_BATCH63 = [
 {"id": "s925", "col": "type", "from": "Hybrid", "to": "Indica"},
 {"id": "s925", "col": "thc", "from": "16–24%", "to": ""},
 {"id": "s925", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s925", "col": "effects", "from": "[\"Relaxed\",\"Uplifted\",\"Euphoric\",\"Sleepy\"]", "to": "[]"},
 {"id": "s925", "col": "flavor", "from": "Pepper and earthy on the palate with a caryophyllene-leaning finish.", "to": "sweet"},
 {"id": "s925", "col": "ailments", "from": "[\"Depression\",\"Pain\"]", "to": "[\"Depression\",\"Insomnia\"]"}
];
const applyBatch63Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH63);

const STRAIN_CORRECTIONS_BATCH64 = [
 {"id": "s1875", "col": "thc", "from": "18%", "to": ""},
 {"id": "s1875", "col": "effects", "from": "[\"Relaxed\",\"Focused\",\"Happy\"]", "to": "[\"Relaxed\",\"Focused\"]"},
 {"id": "s1875", "col": "flavor", "from": "Pine and citrus with a sweet caramel finish.", "to": "pine and woody"},
 {"id": "s655", "col": "thc", "from": "13–19%", "to": ""},
 {"id": "s655", "col": "cbd", "from": "15–23%", "to": ""},
 {"id": "s655", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s655", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\",\"Happy\",\"Uplifted\"]", "to": "[\"Happy\"]"},
 {"id": "s655", "col": "flavor", "from": "Pineapple and citrus on the palate with a caryophyllene-leaning finish.", "to": "pineapple and citrus"},
 {"id": "s655", "col": "ailments", "from": "[\"Depression\",\"Stress\",\"Lack of Appetite\"]", "to": "[\"Depression\",\"Stress\"]"}
];
const applyBatch64Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH64);

const STRAIN_CORRECTIONS_BATCH65 = [
 {"id": "s1551", "col": "thc", "from": "20–24%", "to": ""},
 {"id": "s1551", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.3},{\"n\":\"Limonene\",\"p\":0.2},{\"n\":\"Myrcene\",\"p\":0.2}]", "to": "[]"},
 {"id": "s1551", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Euphoric\",\"Tingly\"]"},
 {"id": "s1551", "col": "flavor", "from": "Earthy citrus with a spicy, gassy edge.", "to": "pine and lemon"},
 {"id": "s1554", "col": "lean", "from": "Indica-leaning", "to": ""},
 {"id": "s1554", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Euphoric\"]"},
 {"id": "s1554", "col": "flavor", "from": "Mint and chocolate, cookie-like.", "to": "mint and menthol with sweet notes"}
];
const applyBatch65Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH65);

const STRAIN_CORRECTIONS_BATCH66 = [
 {"id": "s7372", "col": "effects", "from": "[\"Focused\",\"Euphoric\",\"Uplifted\"]", "to": "[\"Focused\"]"},
 {"id": "s7372", "col": "flavor", "from": "sweet and skunky with fruity notes", "to": "sweet and fruity"}
];
const applyBatch66Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH66);

const STRAIN_CORRECTIONS_BATCH67 = [
 {"id": "s11", "col": "thc", "from": "23–31%", "to": ""},
 {"id": "s11", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Happy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Euphoric\"]"},
 {"id": "s11", "col": "flavor", "from": "Sweet earthy pine, classic and mellow.", "to": "pine and woody"},
 {"id": "s11", "col": "breeder", "from": "Seed Bank", "to": ""},
 {"id": "s11", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Insomnia\",\"Depression\",\"Lack of Appetite\"]", "to": "[\"Stress\",\"Pain\",\"Insomnia\",\"Depression\",\"Anxiety\"]"},
 {"id": "s193", "col": "thc", "from": "13–17%", "to": ""},
 {"id": "s193", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s193", "col": "effects", "from": "[\"Happy\",\"Euphoric\",\"Uplifted\",\"Relaxed\"]", "to": "[\"Euphoric\",\"Focused\"]"},
 {"id": "s193", "col": "flavor", "from": "Citrus and earthy on the palate with a limonene-leaning finish.", "to": "citrus"},
 {"id": "s193", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\"]", "to": "[\"Stress\",\"Depression\"]"}
];
const applyBatch67Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH67);

const STRAIN_CORRECTIONS_BATCH68 = [
 {"id": "s4", "col": "thc", "from": "19–28%", "to": ""},
 {"id": "s4", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.45},{\"n\":\"Limonene\",\"p\":0.25},{\"n\":\"Humulene\",\"p\":0.15}]", "to": "[]"},
 {"id": "s4", "col": "effects", "from": "[\"Euphoric\",\"Relaxed\",\"Happy\"]", "to": "[\"Euphoric\",\"Relaxed\"]"},
 {"id": "s4", "col": "flavor", "from": "Sweet earthy dough with a minty finish.", "to": "mint and sweet with cherry and lemon notes"},
 {"id": "s4", "col": "aka", "from": "GSC", "to": "GSC, Girl Scout Cookie"}
];
const applyBatch68Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH68);

const STRAIN_CORRECTIONS_BATCH69 = [
 {"id": "s1211", "col": "thc", "from": "19–25%", "to": ""},
 {"id": "s1211", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1211", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Terpinolene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1211", "col": "effects", "from": "[\"Aroused\",\"Creative\",\"Relaxed\"]", "to": "[\"Creative\"]"},
 {"id": "s1211", "col": "flavor", "from": "Limonene-forward with a terpinolene undertone.", "to": "lemon and menthol"},
 {"id": "s1211", "col": "aka", "from": "SnoCap", "to": "SnoCap, Sno Cap"},
 {"id": "s4", "col": "aka", "from": "GSC, Girl Scout Cookie", "to": "GSC, Girl Scout Cookie, Girls Scout Cookies"},
 {"id": "s7280", "col": "aka", "from": "San Fernando Valley OG, San Fernando Valley, SFVOG, SFV O.G.", "to": "San Fernando Valley OG, San Fernando Valley, SFVOG, SFV O.G., San Fernando OG"}
];
const applyBatch69Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH69);

const STRAIN_CORRECTIONS_BATCH70 = [
 {"id": "s7273", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s7273", "col": "cbd", "from": "0–2%", "to": ""},
 {"id": "s7273", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4}]", "to": "[]"},
 {"id": "s7273", "col": "breeder", "from": "TGA Seeds", "to": "TGA Genetics"},
 {"id": "s492", "col": "thc", "from": "12–17%", "to": "<1%"},
 {"id": "s492", "col": "cbd", "from": "<1%", "to": "14%"},
 {"id": "s492", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s492", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Uplifted\",\"Focused\"]", "to": "[\"Happy\",\"Uplifted\"]"},
 {"id": "s492", "col": "flavor", "from": "Citrus and orange on the palate with a limonene-leaning finish.", "to": "citrus, orange and diesel"},
 {"id": "s492", "col": "ailments", "from": "[\"Pain\",\"Depression\",\"Inflammation\",\"Stress\"]", "to": "[\"Pain\",\"Inflammation\",\"Nausea\"]"}
];
const applyBatch70Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH70);

const STRAIN_CORRECTIONS_BATCH71 = [
 {"id": "s4203", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s4203", "col": "lean", "from": "Sativa-leaning", "to": ""},
 {"id": "s4203", "col": "thc", "from": "up to 27%", "to": ""},
 {"id": "s4203", "col": "effects", "from": "[\"Uplifted\"]", "to": "[\"Relaxed\",\"Focused\"]"},
 {"id": "s4203", "col": "flavor", "from": "Pungent skunk, sour lemon, tart citrus.", "to": "citrus"}
];
const applyBatch71Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH71);

const STRAIN_CORRECTIONS_BATCH72 = [
 {"id": "s1518", "col": "thc", "from": "25–30%", "to": ""},
 {"id": "s1518", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.3},{\"n\":\"Limonene\",\"p\":0.25},{\"n\":\"Myrcene\",\"p\":0.2}]", "to": "[]"},
 {"id": "s1518", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Sleepy\"]", "to": "[]"},
 {"id": "s1518", "col": "flavor", "from": "Pungent diesel and earth with a sour, chocolatey undertone.", "to": "pine"},
 {"id": "s7280", "col": "aka", "from": "San Fernando Valley OG, San Fernando Valley, SFVOG, SFV O.G., San Fernando OG", "to": "San Fernando Valley OG, San Fernando Valley, SFVOG, SFV O.G., San Fernando OG, SFV"}
];
const applyBatch72Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH72);

const STRAIN_CORRECTIONS_BATCH73 = [
 {"id": "s286", "col": "thc", "from": "23–27%", "to": ""},
 {"id": "s286", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Ocimene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s286", "col": "effects", "from": "[\"Happy\",\"Uplifted\",\"Euphoric\",\"Relaxed\"]", "to": "[\"Uplifted\",\"Focused\"]"},
 {"id": "s286", "col": "flavor", "from": "Earthy and skunk on the palate with a myrcene-leaning finish.", "to": "skunky and woody"},
 {"id": "s286", "col": "ailments", "from": "[\"Depression\",\"Pain\",\"Stress\",\"Muscle Spasms\"]", "to": "[\"Depression\",\"Stress\",\"Anxiety\"]"},
 {"id": "s1039", "col": "thc", "from": "20–25%", "to": ""},
 {"id": "s1039", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1039", "col": "effects", "from": "[\"Relaxed\",\"Calm\",\"Uplifted\"]", "to": "[\"Focused\",\"Relaxed\"]"},
 {"id": "s1039", "col": "flavor", "from": "Limonene-forward with a pinene undertone.", "to": "pine"}
];
const applyBatch73Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH73);
const STRAIN_CORRECTIONS_BATCH74 = [
 {"id": "s2296", "col": "effects", "from": "[\"Euphoric\",\"Happy\"]", "to": "[\"Relaxed\"]"},
 {"id": "s2296", "col": "flavor", "from": "Heavy, musky and pungent with a slightly piney aroma.", "to": "sweet"}
];
const applyBatch74Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH74);
const STRAIN_CORRECTIONS_BATCH75 = [
 {"id": "s1058", "col": "thc", "from": "23–29%", "to": ""},
 {"id": "s1058", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1058", "col": "terps", "from": "[{\"n\":\"Terpinolene\",\"p\":0.4},{\"n\":\"Ocimene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1058", "col": "effects", "from": "[\"Focused\",\"Sleepy\",\"Social\"]", "to": "[\"Happy\",\"Relaxed\",\"Euphoric\"]"},
 {"id": "s1058", "col": "flavor", "from": "Terpinolene-forward with a ocimene undertone.", "to": "sweet and berry"},
 {"id": "s6082", "col": "lean", "from": "Indica-leaning", "to": ""}
];
const applyBatch75Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH75);
const STRAIN_CORRECTIONS_BATCH76 = [
 {"id": "s6883", "col": "lean", "from": "Indica-leaning", "to": ""},
 {"id": "s6883", "col": "cbd", "from": "11-20%", "to": ""},
 {"id": "s6883", "col": "effects", "from": "[\"Relaxed\",\"Focused\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Focused\"]"},
 {"id": "s6883", "col": "flavor", "from": "Piney, earthy aroma with a sweet flavor.", "to": "earthy"}
];
const applyBatch76Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH76);
const STRAIN_CORRECTIONS_BATCH77 = [
 {"id": "s712", "col": "thc", "from": "13–17%", "to": ""},
 {"id": "s712", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s712", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Ocimene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s712", "col": "effects", "from": "[\"Hungry\",\"Relaxed\",\"Sleepy\",\"Talkative\"]", "to": "[\"Happy\",\"Giggly\",\"Sleepy\"]"},
 {"id": "s712", "col": "flavor", "from": "Blueberry and berry on the palate with a myrcene-leaning finish.", "to": "berry"},
 {"id": "s712", "col": "ailments", "from": "[\"Insomnia\",\"Lack of Appetite\",\"Stress\",\"Depression\"]", "to": "[\"Stress\"]"},
 {"id": "s963", "col": "thc", "from": "21–28%", "to": ""},
 {"id": "s963", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s963", "col": "terps", "from": "[{\"n\":\"Terpinolene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s963", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Uplifted\",\"Happy\"]", "to": "[\"Uplifted\",\"Sleepy\"]"},
 {"id": "s963", "col": "flavor", "from": "Honey and earthy on the palate with a terpinolene-leaning finish.", "to": "honey and sweet"},
 {"id": "s963", "col": "ailments", "from": "[\"Pain\"]", "to": "[\"Stress\",\"Depression\",\"Pain\",\"Anxiety\",\"Insomnia\"]"},
 {"id": "s2099", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s2099", "col": "terps", "from": "[{\"n\":\"Pinene\",\"p\":0.3},{\"n\":\"Caryophyllene\",\"p\":0.2},{\"n\":\"Myrcene\",\"p\":0.15}]", "to": "[]"},
 {"id": "s2099", "col": "effects", "from": "[\"Happy\",\"Relaxed\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s2099", "col": "flavor", "from": "Sweet fruity candy with citrus, berries, and diesel.", "to": "sweet and fruity"}
];
const applyBatch77Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH77);
const STRAIN_CORRECTIONS_BATCH78 = [
 {"id": "s59", "col": "thc", "from": "21–30%", "to": ""},
 {"id": "s59", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s59", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s59", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\",\"Happy\",\"Sleepy\"]", "to": "[\"Euphoric\",\"Hungry\"]"},
 {"id": "s59", "col": "flavor", "from": "Mango and sweet on the palate with a myrcene-leaning finish.", "to": "sweet and tropical"},
 {"id": "s59", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Insomnia\",\"Lack of Appetite\"]", "to": "[\"Pain\"]"},
 {"id": "s1144", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1144", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1144", "col": "effects", "from": "[\"Euphoric\",\"Social\",\"Aroused\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s1144", "col": "flavor", "from": "Myrcene-forward with a humulene undertone.", "to": "lemon and citrus"},
 {"id": "s1144", "col": "breeder", "from": "Bud Rx Delivery", "to": ""}
];
const applyBatch78Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH78);
const STRAIN_CORRECTIONS_BATCH79 = [
 {"id": "s75", "col": "cbd", "from": "18–24%", "to": ""},
 {"id": "s75", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s75", "col": "effects", "from": "[\"Aroused\",\"Euphoric\",\"Happy\",\"Creative\"]", "to": "[\"Euphoric\",\"Creative\"]"},
 {"id": "s75", "col": "flavor", "from": "Berry and sweet on the palate with a myrcene-leaning finish.", "to": "blueberry and sweet"},
 {"id": "s75", "col": "ailments", "from": "[\"Insomnia\",\"Stress\",\"Depression\",\"Pain\"]", "to": "[\"Stress\",\"Anxiety\"]"},
 {"id": "s475", "col": "thc", "from": "15–19%", "to": ""},
 {"id": "s475", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s475", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s475", "col": "effects", "from": "[\"Aroused\",\"Sleepy\",\"Talkative\",\"Tingly\"]", "to": "[\"Aroused\",\"Creative\"]"},
 {"id": "s475", "col": "flavor", "from": "Pepper and blueberry on the palate with a caryophyllene-leaning finish.", "to": ""},
 {"id": "s475", "col": "ailments", "from": "[\"Lack of Appetite\",\"Nausea\",\"Pain\",\"Stress\"]", "to": "[\"Lack of Appetite\",\"Stress\"]"},
 {"id": "s555", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s555", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Hungry\"]"},
 {"id": "s555", "col": "flavor", "from": "Sweet berry and musk with fruity kush notes.", "to": "grape and pine"},
 {"id": "s555", "col": "ailments", "from": "[\"Stress\",\"Insomnia\",\"Depression\",\"Lack of Appetite\"]", "to": "[\"Stress\",\"Pain\"]"}
];
const applyBatch79Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH79);
const STRAIN_CORRECTIONS_BATCH80 = [
 {"id": "s353", "col": "thc", "from": "22–30%", "to": ""},
 {"id": "s353", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s353", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s353", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Hungry\",\"Happy\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s353", "col": "flavor", "from": "Grape and berry on the palate with a myrcene-leaning finish.", "to": "grape"},
 {"id": "s353", "col": "ailments", "from": "[\"Lack of Appetite\",\"Muscle Spasms\",\"Inflammation\",\"Pain\",\"Stress\"]", "to": "[\"Stress\",\"Anxiety\",\"Pain\"]"},
 {"id": "s617", "col": "type", "from": "Hybrid", "to": "Indica"},
 {"id": "s617", "col": "thc", "from": "17–23%", "to": "16–20%"},
 {"id": "s617", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s617", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s617", "col": "effects", "from": "[\"Relaxed\",\"Uplifted\",\"Creative\",\"Happy\"]", "to": "[]"},
 {"id": "s617", "col": "flavor", "from": "Citrus and lime on the palate with a limonene-leaning finish.", "to": "mint and tobacco"},
 {"id": "s617", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Inflammation\",\"Lack of Appetite\"]", "to": "[\"Anxiety\",\"Pain\"]"}
];
const applyBatch80Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH80);

const STRAIN_CORRECTIONS_BATCH81 = [
 {"id": "s7244", "col": "flavor", "from": "Pungent, skunky kush with pine.", "to": "skunky and woody"}
];
const applyBatch81Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH81);

const STRAIN_CORRECTIONS_BATCH82 = [
 {"id": "s2497", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s2497", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s2497", "col": "parents", "from": "[\"White Widow\",\"Malawi x Skunk\"]", "to": "[\"Super Skunk\"]"},
 {"id": "s2497", "col": "effects", "from": "[\"Relaxed\"]", "to": "[\"Euphoric\"]"},
 {"id": "s2497", "col": "flavor", "from": "Skunk and fruit with berries, spice, wood, and minty pine.", "to": "butter"},
 {"id": "s166", "col": "thc", "from": "16–21%", "to": ""},
 {"id": "s166", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s166", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s166", "col": "effects", "from": "[\"Euphoric\",\"Energetic\",\"Uplifted\",\"Happy\"]", "to": "[\"Creative\"]"},
 {"id": "s166", "col": "flavor", "from": "Sweet and earthy on the palate with a linalool-leaning finish.", "to": "citrus and earthy"},
 {"id": "s166", "col": "ailments", "from": "[\"Depression\",\"Stress\",\"Pain\",\"Inflammation\"]", "to": "[\"Stress\",\"Anxiety\",\"Depression\"]"},
 {"id": "s166", "col": "breeder", "from": "Head Seeds", "to": ""}
];
const applyBatch82Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH82);

const STRAIN_CORRECTIONS_BATCH83 = [
 {"id": "s1", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s1", "col": "thc", "from": "17–24%", "to": ""},
 {"id": "s1", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.3},{\"n\":\"Caryophyllene\",\"p\":0.2}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s1", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Creative\",\"Euphoric\"]", "to": "[\"Euphoric\"]"},
 {"id": "s1", "col": "flavor", "from": "Berry-sweet with a mellow herbal exhale.", "to": "blueberry"},
 {"id": "s1069", "col": "effects", "from": "[\"Euphoric\",\"Uplifted\",\"Creative\"]", "to": "[\"Creative\"]"}
];
const applyBatch83Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH83);

const STRAIN_CORRECTIONS_BATCH84 = [
 {"id": "s1522", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s1522", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1522", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.3},{\"n\":\"Caryophyllene\",\"p\":0.25},{\"n\":\"Myrcene\",\"p\":0.2}]", "to": "[]"},
 {"id": "s1522", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Creative\"]", "to": "[\"Relaxed\",\"Happy\"]"},
 {"id": "s1522", "col": "flavor", "from": "Sweet berry and citrus with a creamy finish.", "to": "citrus and sweet"},
 {"id": "s7161", "col": "flavor", "from": "Earthy, citrus and nutty.", "to": ""}
];
const applyBatch84Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH84);

const STRAIN_CORRECTIONS_BATCH85 = [
 {"id": "s1092", "col": "thc", "from": "26–28%", "to": "20–25%"},
 {"id": "s1092", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1092", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1092", "col": "effects", "from": "[\"Hungry\",\"Social\",\"Creative\"]", "to": "[\"Euphoric\"]"},
 {"id": "s1092", "col": "flavor", "from": "Limonene-forward with a humulene undertone.", "to": "lemon and pine"},
 {"id": "s2287", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s2287", "col": "lean", "from": "Indica-leaning", "to": ""},
 {"id": "s2287", "col": "thc", "from": "28-32%", "to": ""},
 {"id": "s2287", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s2287", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.3},{\"n\":\"Limonene\",\"p\":0.2},{\"n\":\"Linalool\",\"p\":0.15}]", "to": "[]"},
 {"id": "s2287", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Happy\",\"Uplifted\"]"},
 {"id": "s2287", "col": "flavor", "from": "Sweet vanilla and cream with earthy kush, pine, and a gassy mint bite.", "to": ""}
];
const applyBatch85Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH85);

const STRAIN_CORRECTIONS_BATCH86 = [
 {"id": "s4", "col": "effects", "from": "[\"Euphoric\",\"Relaxed\"]", "to": "[\"Relaxed\",\"Happy\"]"},
 {"id": "s4", "col": "flavor", "from": "mint and sweet with cherry and lemon notes", "to": "mint, sweet and earthy"},
 {"id": "s4", "col": "ailments", "from": "[\"Stress\",\"Anxiety\",\"Depression\",\"Pain\",\"Nausea\",\"Lack of Appetite\"]", "to": "[\"Stress\",\"Depression\"]"},
 {"id": "s622", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s622", "col": "thc", "from": "14–19%", "to": "18–19%"},
 {"id": "s622", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[{\"n\":\"Caryophyllene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]"},
 {"id": "s622", "col": "effects", "from": "[\"Happy\",\"Uplifted\",\"Euphoric\",\"Energetic\"]", "to": "[\"Happy\",\"Uplifted\"]"},
 {"id": "s622", "col": "flavor", "from": "Sweet and earthy on the palate with a linalool-leaning finish.", "to": "sweet"},
 {"id": "s622", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\"]", "to": "[\"Stress\",\"Depression\"]"}
];
const applyBatch86Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH86);

const STRAIN_CORRECTIONS_BATCH87 = [
 {"id": "s326", "col": "thc", "from": "18–23%", "to": ""},
 {"id": "s326", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s326", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s326", "col": "effects", "from": "[\"Relaxed\",\"Hungry\",\"Sleepy\",\"Tingly\"]", "to": "[]"},
 {"id": "s326", "col": "flavor", "from": "Earthy and citrus on the palate with a myrcene-leaning finish.", "to": "earthy"},
 {"id": "s326", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Lack of Appetite\",\"Muscle Spasms\"]", "to": "[]"}
];
const applyBatch87Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH87);

const STRAIN_CORRECTIONS_BATCH88 = [
 {"id": "s301", "col": "thc", "from": "12–20%", "to": "18–20%"},
 {"id": "s301", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s301", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Happy\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Hungry\"]"},
 {"id": "s301", "col": "flavor", "from": "Berry and earthy on the palate with a myrcene-leaning finish.", "to": "earthy, pine, grape and lemon"},
 {"id": "s301", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Depression\",\"Insomnia\",\"Lack of Appetite\"]", "to": "[]"}
];
const applyBatch88Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH88);

const STRAIN_CORRECTIONS_BATCH89 = [
 {"id": "s677", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s677", "col": "thc", "from": "22–26%", "to": "16–17%"},
 {"id": "s677", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s677", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Humulene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s677", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\",\"Happy\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s677", "col": "flavor", "from": "Berry and earthy on the palate with a myrcene-leaning finish.", "to": "fruity berry"},
 {"id": "s677", "col": "ailments", "from": "[\"Insomnia\",\"Lack of Appetite\",\"Stress\",\"Depression\"]", "to": "[]"},
 {"id": "s677", "col": "parents", "from": "[\"Buckeye Purple\",\"Cherry Sauce\"]", "to": "[]"}
];
const applyBatch89Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH89);

const STRAIN_CORRECTIONS_BATCH90 = [
 {"id": "s435", "col": "thc", "from": "23–30%", "to": "19–21%"},
 {"id": "s435", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s435", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s435", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\",\"Happy\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Giggly\"]"},
 {"id": "s435", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "pine, earthy and lavender"},
 {"id": "s435", "col": "ailments", "from": "[\"Insomnia\",\"Stress\",\"Pain\",\"Depression\",\"Inflammation\"]", "to": "[\"Pain\",\"Insomnia\",\"Anxiety\"]"},
 {"id": "s1075", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s1075", "col": "thc", "from": "14–19%", "to": "18–28%"},
 {"id": "s1075", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1075", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Ocimene\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1075", "col": "effects", "from": "[\"Talkative\",\"Hungry\",\"Calm\"]", "to": "[\"Euphoric\",\"Focused\"]"},
 {"id": "s1075", "col": "flavor", "from": "Myrcene-forward with a ocimene undertone.", "to": "diesel and cheese"},
 {"id": "s1075", "col": "breeder", "from": "Holistic Healing Collective", "to": ""}
];
const applyBatch90Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH90);

const STRAIN_CORRECTIONS_BATCH91 = [
 {"id": "s292", "col": "type", "from": "Hybrid", "to": "Indica"},
 {"id": "s292", "col": "thc", "from": "21–25%", "to": ""},
 {"id": "s292", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s292", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Linalool\",\"p\":0.16}]", "to": "[]"},
 {"id": "s292", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\",\"Euphoric\",\"Happy\"]", "to": "[\"Sleepy\",\"Euphoric\"]"},
 {"id": "s292", "col": "flavor", "from": "Earthy and citrus on the palate with a myrcene-leaning finish.", "to": "tea"},
 {"id": "s292", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Insomnia\",\"Depression\",\"Lack of Appetite\"]", "to": "[\"Pain\",\"Anxiety\"]"}
];
const applyBatch91Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH91);

const STRAIN_CORRECTIONS_BATCH92 = [
 {"id": "s1581", "col": "thc", "from": "20–25%", "to": "17%"},
 {"id": "s1581", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1581", "col": "terps", "from": "[{\"n\":\"Terpinolene\",\"p\":0.3},{\"n\":\"Limonene\",\"p\":0.25},{\"n\":\"Pinene\",\"p\":0.15}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s1581", "col": "effects", "from": "[\"Energetic\",\"Uplifted\",\"Happy\",\"Focused\"]", "to": "[\"Relaxed\",\"Happy\",\"Uplifted\"]"},
 {"id": "s1581", "col": "flavor", "from": "Bright lemon zest over a sweet, earthy base.", "to": "lemon and diesel"}
];
const applyBatch92Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH92);

const STRAIN_CORRECTIONS_BATCH93 = [
 {"id": "s5", "col": "breeder", "from": "PAPA GANJA", "to": "Ken Estes"},
 {"id": "s5", "col": "effects", "from": "[\"Sleepy\",\"Relaxed\",\"Hungry\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s5", "col": "ailments", "from": "[\"Stress\",\"Insomnia\",\"Pain\",\"Depression\",\"Lack of Appetite\"]", "to": "[\"Stress\",\"Anxiety\",\"Pain\"]"}
];
const applyBatch93Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH93);

const STRAIN_CORRECTIONS_BATCH94 = [
 {"id": "s439", "col": "thc", "from": "23–29%", "to": "17–24%"},
 {"id": "s439", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s439", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Terpinolene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s439", "col": "effects", "from": "[\"Happy\",\"Uplifted\",\"Energetic\",\"Relaxed\"]", "to": "[\"Happy\",\"Energetic\",\"Focused\"]"},
 {"id": "s439", "col": "flavor", "from": "Sweet and skunk on the palate with a linalool-leaning finish.", "to": "sweet and pine"},
 {"id": "s439", "col": "breeder", "from": "Grand Daddy Purp", "to": ""},
 {"id": "s439", "col": "ailments", "from": "[\"Depression\",\"Insomnia\",\"Stress\",\"Pain\"]", "to": "[\"Depression\",\"Stress\",\"Pain\"]"}
];
const applyBatch94Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH94);

const STRAIN_CORRECTIONS_BATCH95 = [
 {"id": "s2171", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s2171", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s2171", "col": "effects", "from": "[\"Uplifted\",\"Creative\",\"Relaxed\"]", "to": "[\"Uplifted\",\"Relaxed\",\"Happy\",\"Euphoric\",\"Focused\"]"},
 {"id": "s2171", "col": "flavor", "from": "Sweet tropical fruit with berry and light citrus.", "to": "blueberry and pineapple with tropical sweetness"}
];
const applyBatch95Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH95);

const STRAIN_CORRECTIONS_BATCH96 = [
 {"id": "s57", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s57", "col": "flavor", "from": "Lemon and citrus on the palate with a limonene-leaning finish.", "to": "lemon and citrus"},
 {"id": "s57", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s2315", "col": "thc", "from": "17-29%", "to": "15–22%"},
 {"id": "s2315", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s2315", "col": "effects", "from": "[\"Happy\",\"Relaxed\",\"Energetic\"]", "to": "[\"Happy\",\"Focused\"]"},
 {"id": "s2315", "col": "flavor", "from": "Earthy with notes of citrus and lime.", "to": "lime"},
 {"id": "s238", "col": "type", "from": "Hybrid", "to": "Sativa"},
 {"id": "s238", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s238", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s238", "col": "effects", "from": "[\"Energetic\",\"Happy\",\"Uplifted\",\"Focused\"]", "to": "[\"Creative\",\"Focused\",\"Happy\"]"},
 {"id": "s238", "col": "flavor", "from": "Sweet and earthy on the palate with a linalool-leaning finish.", "to": "fruity and pine"},
 {"id": "s238", "col": "ailments", "from": "[\"Depression\",\"Stress\",\"Lack of Appetite\",\"Pain\"]", "to": "[\"Anxiety\",\"Stress\"]"}
];
const applyBatch96Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH96);

const STRAIN_CORRECTIONS_BATCH97 = [
 {"id": "s620", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s620", "col": "flavor", "from": "Earthy, spicy and sweet.", "to": "earthy and woody"},
 {"id": "s620", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Insomnia\"]", "to": "[\"Stress\",\"Pain\"]"},
 {"id": "s620", "col": "aka", "from": "Mr. Nice Guy, Mister Nice Guy, Mister Nice, Mr. Nice G13 x Hash Plant", "to": "Mr. Nice Guy, Mister Nice Guy, Mister Nice"},
 {"id": "s180", "col": "effects", "from": "[\"Energetic\",\"Uplifted\",\"Happy\"]", "to": "[\"Energetic\",\"Focused\"]"},
 {"id": "s180", "col": "flavor", "from": "Skunk, citrus and mango.", "to": "citrus and mango"}
];
const applyBatch97Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH97);

const STRAIN_CORRECTIONS_BATCH98 = [
 {"id": "s7133", "col": "effects", "from": "[]", "to": "[\"Uplifted\"]"},
 {"id": "s7244", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s234", "col": "type", "from": "Hybrid", "to": "Indica"},
 {"id": "s234", "col": "thc", "from": "21–29%", "to": "18–25%"},
 {"id": "s234", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Happy\",\"Euphoric\",\"Hungry\"]"},
 {"id": "s234", "col": "flavor", "from": "Earthy and piney with a lemony Kush character.", "to": "earthy, woody and sweet"},
 {"id": "s234", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Depression\",\"Insomnia\",\"Lack of Appetite\"]", "to": "[\"Pain\",\"Stress\",\"Insomnia\"]"},
 {"id": "s234", "col": "breeder", "from": "Reserva Privada", "to": "DNA Genetics"},
 {"id": "s463", "col": "type", "from": "Sativa", "to": "Hybrid"},
 {"id": "s463", "col": "thc", "from": "21–27%", "to": "18–22%"},
 {"id": "s463", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s463", "col": "terps", "from": "[{\"n\":\"Limonene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s463", "col": "effects", "from": "[\"Happy\",\"Euphoric\",\"Uplifted\",\"Energetic\"]", "to": "[\"Giggly\"]"},
 {"id": "s463", "col": "flavor", "from": "Citrus and sweet on the palate with a limonene-leaning finish.", "to": "herbal and spicy"},
 {"id": "s463", "col": "ailments", "from": "[\"Depression\",\"Stress\",\"Pain\",\"Lack of Appetite\"]", "to": "[\"Depression\",\"Stress\"]"}
];
const applyBatch98Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH98);

const STRAIN_CORRECTIONS_BATCH99 = [
 {"id": "s1141", "col": "terps", "from": "[]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Caryophyllene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]"},
 {"id": "s1141", "col": "effects", "from": "[\"Energetic\",\"Happy\",\"Focused\"]", "to": "[\"Euphoric\",\"Focused\",\"Uplifted\",\"Relaxed\"]"},
 {"id": "s1141", "col": "flavor", "from": "Intense sour lemon with a diesel finish.", "to": "lemon, diesel and citrus"},
 {"id": "s1141", "col": "breeder", "from": "Green Lantern Seeds", "to": ""},
 {"id": "s22", "col": "thc", "from": "16–23%", "to": "15–16%"},
 {"id": "s22", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s22", "col": "effects", "from": "[\"Energetic\",\"Creative\",\"Happy\",\"Focused\"]", "to": "[\"Creative\",\"Focused\"]"},
 {"id": "s22", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "herbal"},
 {"id": "s22", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Lack of Appetite\",\"Muscle Spasms\"]", "to": "[\"Stress\"]"},
 {"id": "s3", "col": "flavor", "from": "Pungent diesel.", "to": "diesel and skunk"}
];
const applyBatch99Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH99);

const STRAIN_CORRECTIONS_BATCH100 = [
 {"id": "s1519", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1519", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Euphoric\"]"},
 {"id": "s6921", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s6921", "col": "effects", "from": "[\"Focused\"]", "to": "[\"Uplifted\",\"Focused\"]"},
 {"id": "s6921", "col": "flavor", "from": "tropical fruit", "to": "sweet, fruity and creamy"}
];
const applyBatch100Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH100);

const STRAIN_CORRECTIONS_BATCH101 = [
 {"id": "s6861", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s6861", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s6861", "col": "effects", "from": "[\"Energetic\",\"Focused\",\"Happy\"]", "to": "[\"Energetic\",\"Focused\"]"},
 {"id": "s54", "col": "thc", "from": "12–21%", "to": ""},
 {"id": "s54", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s54", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s54", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Tingly\",\"Uplifted\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s54", "col": "flavor", "from": "Sweet and earthy on the palate with a linalool-leaning finish.", "to": "sweet"},
 {"id": "s54", "col": "ailments", "from": "[\"Pain\",\"Stress\",\"Insomnia\",\"Depression\"]", "to": "[\"Stress\",\"Pain\",\"Anxiety\"]"}
];
const applyBatch101Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH101);

const STRAIN_CORRECTIONS_BATCH102 = [
 {"id": "s1229", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Euphoric\"]"},
 {"id": "s1229", "col": "terps", "from": "[]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s1229", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s29", "col": "type", "from": "Indica", "to": "Hybrid"},
 {"id": "s29", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Uplifted\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s29", "col": "ailments", "from": "[\"Stress\",\"Insomnia\",\"Pain\",\"Depression\",\"Lack of Appetite\"]", "to": "[\"Insomnia\",\"Pain\",\"Muscle Spasms\"]"},
 {"id": "s29", "col": "flavor", "from": "Earthy and grape on the palate with a myrcene-leaning finish.", "to": "grape, spicy"},
 {"id": "s29", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s29", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s377", "col": "type", "from": "Hybrid", "to": "Indica"},
 {"id": "s377", "col": "thc", "from": "13–17%", "to": "20–23%"},
 {"id": "s377", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s377", "col": "terps", "from": "[{\"n\":\"Pinene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s377", "col": "effects", "from": "[\"Relaxed\",\"Happy\",\"Euphoric\",\"Sleepy\"]", "to": "[\"Sleepy\"]"},
 {"id": "s377", "col": "ailments", "from": "[\"Insomnia\",\"Stress\",\"Depression\",\"Pain\",\"Lack of Appetite\"]", "to": "[\"Insomnia\",\"Stress\",\"Pain\"]"},
 {"id": "s377", "col": "flavor", "from": "Pine and earthy on the palate with a pinene-leaning finish.", "to": "pine and woody"},
 {"id": "s1092", "col": "ailments", "from": "[\"Stress\",\"Depression\"]", "to": "[\"Stress\",\"Depression\",\"Anxiety\"]"}
];
const applyBatch102Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH102);

const STRAIN_CORRECTIONS_BATCH103 = [
 {"id": "s353", "col": "effects", "from": "[\"Relaxed\",\"Sleepy\"]", "to": "[\"Relaxed\",\"Sleepy\",\"Hungry\"]"},
 {"id": "s1158", "col": "thc", "from": "27–30%", "to": ""},
 {"id": "s1158", "col": "cbd", "from": "<1%", "to": ""},
 {"id": "s1158", "col": "terps", "from": "[{\"n\":\"Humulene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Ocimene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1158", "col": "effects", "from": "[\"Sleepy\",\"Social\",\"Calm\"]", "to": "[]"},
 {"id": "s1158", "col": "flavor", "from": "Humulene-forward with a pinene undertone.", "to": ""}
];
const applyBatch103Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH103);

const STRAIN_CORRECTIONS_BATCH104 = [
 {"id": "s7170", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s7170", "col": "effects", "from": "[]", "to": "[\"Focused\",\"Energetic\"]"},
 {"id": "s7170", "col": "flavor", "from": "Sweet citrus with a subtle diesel aftertaste.", "to": "orange and diesel"},
 {"id": "s1210", "col": "thc", "from": "27–28%", "to": "20%"},
 {"id": "s1210", "col": "terps", "from": "[{\"n\":\"Linalool\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Myrcene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Limonene\",\"p\":0.27},{\"n\":\"Caryophyllene\",\"p\":0.16}]"},
 {"id": "s1210", "col": "effects", "from": "[\"Focused\",\"Clear-headed\",\"Creative\"]", "to": "[\"Relaxed\",\"Sleepy\"]"},
 {"id": "s1210", "col": "flavor", "from": "Linalool-forward with a limonene undertone.", "to": "diesel and spicy"},
 {"id": "s7204", "col": "lean", "from": "Sativa-leaning", "to": "Sativa-dominant"},
 {"id": "s7204", "col": "effects", "from": "[\"Relaxed\",\"Euphoric\",\"Creative\"]", "to": "[\"Relaxed\"]"},
 {"id": "s7204", "col": "flavor", "from": "sweet berry and grape with nutty notes", "to": "sweet and nutty"},
 {"id": "s7204", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\"]", "to": "[\"Pain\",\"Depression\"]"}
];
const applyBatch104Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH104);

const STRAIN_CORRECTIONS_BATCH105 = [
 {"id": "s228", "col": "aka", "from": "Skywalker Kush", "to": ""},
 {"id": "s1210", "col": "aka", "from": "Skywalker OG Kush", "to": "Skywalker OG Kush, Skywalker Kush"},
 {"id": "s7006", "col": "lean", "from": "Indica-leaning", "to": "Indica-dominant"},
 {"id": "s7006", "col": "effects", "from": "[]", "to": "[\"Euphoric\",\"Relaxed\"]"},
 {"id": "s7006", "col": "flavor", "from": "Sour citrus and earthy musk.", "to": "citrus, lemon and pine"},
 {"id": "s131", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s131", "col": "flavor", "from": "Earthy and pine on the palate with a myrcene-leaning finish.", "to": ""}
];
const applyBatch105Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH105);

const STRAIN_CORRECTIONS_BATCH106 = [
 {"id": "s216", "col": "breeder", "from": "Homegrown Fantaseeds", "to": "Nirvana Seeds"},
 {"id": "s216", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s216", "col": "effects", "from": "[\"Relaxed\",\"Uplifted\",\"Focused\",\"Euphoric\"]", "to": "[\"Relaxed\",\"Euphoric\"]"},
 {"id": "s216", "col": "ailments", "from": "[\"Stress\",\"Insomnia\",\"Lack of Appetite\",\"Depression\"]", "to": "[\"Stress\",\"Insomnia\",\"Depression\"]"},
 {"id": "s216", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "skunky and woody"},
 {"id": "s423", "col": "type", "from": "Hybrid", "to": "Sativa"},
 {"id": "s423", "col": "breeder", "from": "Apothecary Seed Company", "to": "Apothecary Genetics"},
 {"id": "s423", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s423", "col": "effects", "from": "[\"Happy\",\"Focused\",\"Uplifted\",\"Euphoric\"]", "to": "[\"Happy\"]"},
 {"id": "s423", "col": "ailments", "from": "[\"Pain\",\"Inflammation\",\"Muscle Spasms\"]", "to": "[\"Stress\"]"},
 {"id": "s423", "col": "flavor", "from": "Berry and sweet on the palate with a myrcene-leaning finish.", "to": "sweet berry"},
 {"id": "s1111", "col": "thc", "from": "22–30%", "to": ""},
 {"id": "s1111", "col": "terps", "from": "[{\"n\":\"Caryophyllene\",\"p\":0.4},{\"n\":\"Pinene\",\"p\":0.27},{\"n\":\"Limonene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1111", "col": "effects", "from": "[\"Uplifted\",\"Talkative\",\"Hungry\"]", "to": "[\"Relaxed\"]"},
 {"id": "s1111", "col": "flavor", "from": "Caryophyllene-forward with a pinene undertone.", "to": ""},
 {"id": "s1111", "col": "breeder", "from": "StructuredHydro", "to": ""}
];
const applyBatch106Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH106);

const STRAIN_CORRECTIONS_BATCH107 = [
 {"id": "s393", "col": "thc", "from": "7–15%", "to": "5–9%"},
 {"id": "s393", "col": "cbd", "from": "4–10%", "to": "6–9%"},
 {"id": "s393", "col": "terps", "from": "[{\"n\":\"Myrcene\",\"p\":0.4},{\"n\":\"Linalool\",\"p\":0.27},{\"n\":\"Humulene\",\"p\":0.16}]", "to": "[{\"n\":\"Myrcene\",\"p\":0.4}]"},
 {"id": "s393", "col": "effects", "from": "[\"Relaxed\",\"Focused\",\"Uplifted\",\"Happy\"]", "to": "[\"Relaxed\",\"Focused\"]"},
 {"id": "s393", "col": "flavor", "from": "Earthy and sweet on the palate with a myrcene-leaning finish.", "to": "earthy, woody, herbal and spicy"},
 {"id": "s393", "col": "ailments", "from": "[\"Stress\",\"Pain\",\"Depression\",\"Inflammation\"]", "to": "[\"Pain\",\"Anxiety\"]"}
];
const applyBatch107Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH107);

const STRAIN_CORRECTIONS_BATCH108 = [
 {"id": "s1426", "col": "thc", "from": "17–23%", "to": ""},
 {"id": "s1426", "col": "terps", "from": "[{\"n\":\"Humulene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s1426", "col": "effects", "from": "[\"Giggly\",\"Clear-headed\",\"Relaxed\"]", "to": "[\"Creative\"]"},
 {"id": "s1426", "col": "flavor", "from": "Humulene-forward with a myrcene undertone.", "to": "spicy and sweet"},
 {"id": "s1426", "col": "breeder", "from": "Chimera & DJ Short", "to": "Chimera Seeds"}
];
const applyBatch108Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH108);

const STRAIN_CORRECTIONS_BATCH109 = [
 {"id": "s167", "col": "thc", "from": "13–20%", "to": ""},
 {"id": "s167", "col": "terps", "from": "[{\"n\":\"Humulene\",\"p\":0.4},{\"n\":\"Myrcene\",\"p\":0.27},{\"n\":\"Pinene\",\"p\":0.16}]", "to": "[]"},
 {"id": "s167", "col": "effects", "from": "[\"Happy\",\"Energetic\",\"Creative\",\"Uplifted\"]", "to": "[]"},
 {"id": "s167", "col": "flavor", "from": "Ammonia and earthy on the palate with a humulene-leaning finish.", "to": "skunky, pine and sweet"},
 {"id": "s167", "col": "ailments", "from": "[\"Stress\",\"Depression\",\"Pain\",\"Lack of Appetite\"]", "to": "[\"Stress\",\"Anxiety\",\"Depression\",\"Pain\",\"Nausea\"]"},
 {"id": "s1092", "col": "breeder", "from": "Dark Heart Nursery", "to": ""},
 {"id": "s7170", "col": "breeder", "from": "TGA Subcool Seeds", "to": ""},
 {"id": "s7204", "col": "breeder", "from": "Grand Daddy Purp", "to": ""},
 {"id": "s12", "col": "lean", "from": "High-CBD", "to": ""},
 {"id": "s13", "col": "lean", "from": "Landrace", "to": ""},
 {"id": "s14", "col": "lean", "from": "Landrace", "to": ""},
 {"id": "s15", "col": "lean", "from": "Landrace · Legendary", "to": ""},
 {"id": "s16", "col": "lean", "from": "Landrace · Legendary", "to": ""},
 {"id": "s192", "col": "lean", "from": "Indica", "to": ""},
 {"id": "s1139", "col": "lean", "from": "Sativa", "to": ""},
 {"id": "s2298", "col": "lean", "from": "Sativa", "to": ""},
 {"id": "s2300", "col": "lean", "from": "Sativa", "to": ""},
 {"id": "s2541", "col": "lean", "from": "Indica landrace", "to": ""},
 {"id": "s2566", "col": "lean", "from": "Sativa landrace", "to": ""},
 {"id": "s3831", "col": "lean", "from": "Pure Sativa", "to": ""},
 {"id": "s4153", "col": "lean", "from": "Pure Sativa", "to": ""},
 {"id": "s5141", "col": "lean", "from": "Sativa", "to": ""},
 {"id": "s5159", "col": "lean", "from": "Indica", "to": ""},
 {"id": "s5251", "col": "lean", "from": "Sativa (landrace)", "to": ""},
 {"id": "s5254", "col": "lean", "from": "Indica (landrace)", "to": ""},
 {"id": "s5275", "col": "lean", "from": "Sativa (landrace)", "to": ""},
 {"id": "s5406", "col": "lean", "from": "Pure Indica", "to": ""},
 {"id": "s5409", "col": "lean", "from": "Pure Indica", "to": ""},
 {"id": "s5474", "col": "lean", "from": "Pure Indica", "to": ""},
 {"id": "s6430", "col": "lean", "from": "Sativa", "to": "Sativa-leaning"},
 {"id": "s6496", "col": "lean", "from": "Indica-heavy", "to": "Indica-dominant"},
 {"id": "s6526", "col": "lean", "from": "Slightly indica-dominant", "to": "Indica-leaning"},
 {"id": "s6532", "col": "lean", "from": "Kush-dominant", "to": ""},
 {"id": "s6551", "col": "lean", "from": "Balanced/Indica-leaning", "to": ""},
 {"id": "s6583", "col": "lean", "from": "Slightly sativa-leaning", "to": "Sativa-leaning"},
 {"id": "s6695", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6696", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6698", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6701", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6703", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6704", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6707", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6708", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6709", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6712", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6713", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6714", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6715", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"},
 {"id": "s6716", "col": "lean", "from": "Balanced hybrid", "to": "Balanced"}
];
const applyBatch109Corrections = makeCorrectionsRunner(STRAIN_CORRECTIONS_BATCH109);

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
  { name: 'strain_research_batch15_2026_10_20', run: applyBatch15Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch16_2026_10_21', run: applyBatch16Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch17_2026_10_21', run: applyBatch17Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch18_2026_10_21', run: applyBatch18Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch19_2026_10_21', run: applyBatch19Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch20_2026_10_21', run: applyBatch20Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch21_2026_10_21', run: applyBatch21Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch22_2026_10_21', run: applyBatch22Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch23_2026_10_21', run: applyBatch23Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch24_2026_10_21', run: applyBatch24Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch25_2026_10_21', run: applyBatch25Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch26_2026_10_21', run: applyBatch26Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch27_2026_10_21', run: applyBatch27Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch28_2026_10_21', run: applyBatch28Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch29_2026_10_21', run: applyBatch29Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch30_2026_10_21', run: applyBatch30Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch31_2026_10_21', run: applyBatch31Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch32_2026_10_21', run: applyBatch32Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch33_2026_10_21', run: applyBatch33Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch34_2026_10_21', run: applyBatch34Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch35_2026_10_21', run: applyBatch35Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch36_2026_10_21', run: applyBatch36Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch37_2026_10_21', run: applyBatch37Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch38_2026_10_21', run: applyBatch38Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch39_2026_10_21', run: applyBatch39Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch40_2026_10_21', run: applyBatch40Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch41_2026_10_21', run: applyBatch41Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch42_2026_10_21', run: applyBatch42Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch43_2026_10_21', run: applyBatch43Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch44_2026_10_21', run: applyBatch44Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch45_2026_10_21', run: applyBatch45Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch46_2026_10_21', run: applyBatch46Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch47_2026_10_21', run: applyBatch47Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch48_2026_10_21', run: applyBatch48Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch49_2026_10_22', run: applyBatch49Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch50_2026_10_22', run: applyBatch50Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch51_2026_10_22', run: applyBatch51Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch52_2026_10_22', run: applyBatch52Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch53_2026_10_22', run: applyBatch53Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch54_2026_10_22', run: applyBatch54Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch55_2026_10_22', run: applyBatch55Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch56_2026_10_22', run: applyBatch56Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch57_2026_10_22', run: applyBatch57Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch58_2026_10_22', run: applyBatch58Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch59_2026_10_22', run: applyBatch59Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch60_2026_10_22', run: applyBatch60Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch61_2026_10_22', run: applyBatch61Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch62_2026_10_22', run: applyBatch62Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch63_2026_10_22', run: applyBatch63Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch64_2026_10_22', run: applyBatch64Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch65_2026_10_22', run: applyBatch65Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch66_2026_10_22', run: applyBatch66Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch67_2026_10_22', run: applyBatch67Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch68_2026_10_22', run: applyBatch68Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch69_2026_10_22', run: applyBatch69Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch70_2026_10_22', run: applyBatch70Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch71_2026_10_22', run: applyBatch71Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch72_2026_10_22', run: applyBatch72Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch73_2026_10_22', run: applyBatch73Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch74_2026_10_22', run: applyBatch74Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch75_2026_10_22', run: applyBatch75Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch76_2026_10_22', run: applyBatch76Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch77_2026_10_22', run: applyBatch77Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch78_2026_10_22', run: applyBatch78Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch79_2026_10_22', run: applyBatch79Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch80_2026_10_22', run: applyBatch80Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch81_2026_10_22', run: applyBatch81Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch82_2026_10_22', run: applyBatch82Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch83_2026_10_22', run: applyBatch83Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch84_2026_10_22', run: applyBatch84Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch85_2026_10_22', run: applyBatch85Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch86_2026_10_22', run: applyBatch86Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch87_2026_10_22', run: applyBatch87Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch88_2026_10_22', run: applyBatch88Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch89_2026_10_22', run: applyBatch89Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch90_2026_10_22', run: applyBatch90Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch91_2026_10_22', run: applyBatch91Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch92_2026_10_22', run: applyBatch92Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch93_2026_10_22', run: applyBatch93Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch94_2026_10_22', run: applyBatch94Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch95_2026_10_22', run: applyBatch95Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch96_2026_10_22', run: applyBatch96Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch97_2026_10_22', run: applyBatch97Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch98_2026_10_22', run: applyBatch98Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch99_2026_10_22', run: applyBatch99Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch100_2026_10_22', run: applyBatch100Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch101_2026_10_22', run: applyBatch101Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch102_2026_10_22', run: applyBatch102Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch103_2026_10_22', run: applyBatch103Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch104_2026_10_22', run: applyBatch104Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch105_2026_10_22', run: applyBatch105Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch106_2026_10_22', run: applyBatch106Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch107_2026_10_22', run: applyBatch107Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch108_2026_10_22', run: applyBatch108Corrections, completeWhen: (r) => r.missing.length === 0 },
  { name: 'strain_research_batch109_2026_10_22', run: applyBatch109Corrections, completeWhen: (r) => r.missing.length === 0 },
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

module.exports = { run, assertValidMerges, STRAIN_MERGES, STRAIN_FIXES, NEW_STRAINS, STRAIN_CORRECTIONS, STRAIN_CORRECTIONS_BATCH1, STRAIN_CORRECTIONS_BATCH1B, STRAIN_CORRECTIONS_BATCH2, STRAIN_CORRECTIONS_BATCH3, STRAIN_CORRECTIONS_BATCH4, STRAIN_CORRECTIONS_BATCH5, STRAIN_CORRECTIONS_BATCH6, STRAIN_CORRECTIONS_BATCH7, STRAIN_CORRECTIONS_BATCH8, STRAIN_CORRECTIONS_BATCH9, STRAIN_CORRECTIONS_BATCH10, STRAIN_CORRECTIONS_BATCH11, STRAIN_CORRECTIONS_BATCH12, STRAIN_CORRECTIONS_BATCH13, STRAIN_CORRECTIONS_BATCH14, STRAIN_CORRECTIONS_BATCH15, STRAIN_CORRECTIONS_BATCH16, STRAIN_CORRECTIONS_BATCH17, STRAIN_CORRECTIONS_BATCH18, STRAIN_CORRECTIONS_BATCH19, STRAIN_CORRECTIONS_BATCH20, STRAIN_CORRECTIONS_BATCH21, STRAIN_CORRECTIONS_BATCH22, STRAIN_CORRECTIONS_BATCH23, STRAIN_CORRECTIONS_BATCH24, STRAIN_CORRECTIONS_BATCH25, STRAIN_CORRECTIONS_BATCH26, STRAIN_CORRECTIONS_BATCH27, STRAIN_CORRECTIONS_BATCH28, STRAIN_CORRECTIONS_BATCH29, STRAIN_CORRECTIONS_BATCH30, STRAIN_CORRECTIONS_BATCH31, STRAIN_CORRECTIONS_BATCH32, STRAIN_CORRECTIONS_BATCH33, STRAIN_CORRECTIONS_BATCH34, STRAIN_CORRECTIONS_BATCH35, STRAIN_CORRECTIONS_BATCH36, STRAIN_CORRECTIONS_BATCH37, STRAIN_CORRECTIONS_BATCH38, STRAIN_CORRECTIONS_BATCH39, STRAIN_CORRECTIONS_BATCH40, STRAIN_CORRECTIONS_BATCH41, STRAIN_CORRECTIONS_BATCH42, STRAIN_CORRECTIONS_BATCH43, STRAIN_CORRECTIONS_BATCH44, STRAIN_CORRECTIONS_BATCH45, STRAIN_CORRECTIONS_BATCH46, STRAIN_CORRECTIONS_BATCH47, STRAIN_CORRECTIONS_BATCH48, STRAIN_CORRECTIONS_BATCH49, STRAIN_CORRECTIONS_BATCH50, STRAIN_CORRECTIONS_BATCH51, STRAIN_CORRECTIONS_BATCH52, STRAIN_CORRECTIONS_BATCH53, STRAIN_CORRECTIONS_BATCH54, STRAIN_CORRECTIONS_BATCH55, STRAIN_CORRECTIONS_BATCH56, STRAIN_CORRECTIONS_BATCH57, STRAIN_CORRECTIONS_BATCH58, STRAIN_CORRECTIONS_BATCH59, STRAIN_CORRECTIONS_BATCH60, STRAIN_CORRECTIONS_BATCH61, STRAIN_CORRECTIONS_BATCH62, STRAIN_CORRECTIONS_BATCH63, STRAIN_CORRECTIONS_BATCH64, STRAIN_CORRECTIONS_BATCH65, STRAIN_CORRECTIONS_BATCH66, STRAIN_CORRECTIONS_BATCH67, STRAIN_CORRECTIONS_BATCH68, STRAIN_CORRECTIONS_BATCH69, STRAIN_CORRECTIONS_BATCH70, STRAIN_CORRECTIONS_BATCH71, STRAIN_CORRECTIONS_BATCH72, STRAIN_CORRECTIONS_BATCH73, STRAIN_CORRECTIONS_BATCH74, STRAIN_CORRECTIONS_BATCH75, STRAIN_CORRECTIONS_BATCH76, STRAIN_CORRECTIONS_BATCH77, STRAIN_CORRECTIONS_BATCH78, STRAIN_CORRECTIONS_BATCH79, STRAIN_CORRECTIONS_BATCH80, STRAIN_CORRECTIONS_BATCH81, STRAIN_CORRECTIONS_BATCH82, STRAIN_CORRECTIONS_BATCH83, STRAIN_CORRECTIONS_BATCH84, STRAIN_CORRECTIONS_BATCH85, STRAIN_CORRECTIONS_BATCH86, STRAIN_CORRECTIONS_BATCH87, STRAIN_CORRECTIONS_BATCH88, STRAIN_CORRECTIONS_BATCH89, STRAIN_CORRECTIONS_BATCH90, STRAIN_CORRECTIONS_BATCH91, STRAIN_CORRECTIONS_BATCH92, STRAIN_CORRECTIONS_BATCH93, STRAIN_CORRECTIONS_BATCH94, STRAIN_CORRECTIONS_BATCH95, STRAIN_CORRECTIONS_BATCH96, STRAIN_CORRECTIONS_BATCH97, STRAIN_CORRECTIONS_BATCH98, STRAIN_CORRECTIONS_BATCH99, STRAIN_CORRECTIONS_BATCH100, STRAIN_CORRECTIONS_BATCH101, STRAIN_CORRECTIONS_BATCH102, STRAIN_CORRECTIONS_BATCH103, STRAIN_CORRECTIONS_BATCH104, STRAIN_CORRECTIONS_BATCH105, STRAIN_CORRECTIONS_BATCH106, STRAIN_CORRECTIONS_BATCH107, STRAIN_CORRECTIONS_BATCH108, STRAIN_CORRECTIONS_BATCH109 };
