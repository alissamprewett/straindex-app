// seed.js — one-time (idempotent) import of the starter content into the database.
// Run with: node seed.js
// (Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN set in the environment —
// same as the server. Inserts ~1,500 strains one at a time over the
// network, so this takes a couple of minutes; that's normal.)
const fs = require('node:fs');
const path = require('node:path');
const db = require('./lib/db');

function loadJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', name), 'utf8'));
}

async function main() {
  await db.init();

  const strains = loadJSON('strains.json');
  const faqs = loadJSON('faqs.json');
  const recipes = loadJSON('recipes.json');
  const growTips = loadJSON('growtips.json');

  console.log(`Seeding ${strains.length} strains (this takes a minute or two)...`);
  for (const s of strains) await db.insertStrain(s);

  {
    const existingQuestions = new Set(db.listFaqs().map(f => f.question));
    const toAdd = faqs.filter(f => f.a !== '__TERPLEGEND__' && !existingQuestions.has(f.q));
    if (toAdd.length) {
      console.log(`Seeding ${toAdd.length} new FAQ entr${toAdd.length === 1 ? 'y' : 'ies'} (${existingQuestions.size} already in DB)...`);
      let nextSort = db.listFaqs().length;
      for (const f of toAdd) {
        await db.createFaq({ question: f.q, answer: f.a, sort_order: nextSort++, source_name: f.source_name, source_url: f.source_url });
      }
    } else {
      console.log('No new FAQ entries to add.');
    }
  }

  {
    const existingTitles = new Set(db.listRecipes({ status: null }).map(r => r.title));
    const toAdd = recipes.filter(r => !existingTitles.has(r.title));
    if (toAdd.length) {
      console.log(`Seeding ${toAdd.length} new recipe(s) (${existingTitles.size} already in DB)...`);
      for (const r of toAdd) {
        await db.createRecipe({
          title: r.title, time: r.time, icon: r.icon, source: r.source || 'official',
          author: r.author, desc: r.desc, ingredients: r.ingredients, steps: r.steps,
          dosing: r.dosing, category: r.category || 'Baked Goods', status: 'approved', kudos: r.kudos || 0,
          usesBase: r.usesBase,
        });
      }
    } else {
      console.log('No new recipes to add.');
    }
    // Backfill: recipes seeded before the usesBase field existed won't have
    // it yet even though the JSON file does — bring them up to date in place.
    const byTitle = new Map(db.listRecipes({ status: null }).map(r => [r.title, r]));
    let backfilled = 0;
    for (const r of recipes) {
      if (!r.usesBase || !r.usesBase.length) continue;
      const existing = byTitle.get(r.title);
      if (existing && !existing.usesBase) {
        await db.setRecipeUsesBase(existing.id, r.usesBase);
        backfilled++;
      }
    }
    if (backfilled) console.log(`Backfilled usesBase on ${backfilled} existing recipe(s).`);
  }

  {
    const existingTipTitles = new Set(db.listGrowTips().map(g => g.title));
    const tipsToAdd = growTips.filter(g => !existingTipTitles.has(g.title));
    if (tipsToAdd.length) {
      console.log(`Seeding ${tipsToAdd.length} new grow tip(s) (${existingTipTitles.size} already in DB)...`);
      for (const g of tipsToAdd) {
        await db.createGrowTip({
          title: g.title, category: g.category, author: g.author, body: g.body,
          source_name: g.source_name, source_url: g.source_url,
        });
      }
    } else {
      console.log('No new grow tips to add.');
    }
    // Backfill: tips created before source_name/source_url existed (or before
    // seed.js actually passed them through — an earlier bug here) won't have
    // a source yet even though the JSON file has one. Fix those in place.
    const byTitle = new Map(db.listGrowTips().map(t => [t.title, t]));
    let backfilled = 0;
    for (const g of growTips) {
      if (!g.source_url) continue;
      const existing = byTitle.get(g.title);
      if (existing && !existing.source_url) {
        await db.setGrowTipSource(existing.id, g.source_name, g.source_url);
        backfilled++;
      }
    }
    if (backfilled) console.log(`Backfilled sources on ${backfilled} existing grow tip(s).`);
  }

  console.log('Seed complete.');
  console.log('Strains in DB:', db.countStrains());
  console.log('FAQs in DB:', db.listFaqs().length);
  console.log('Recipes in DB:', db.listRecipes({ status: null }).length);
  console.log('Grow tips in DB:', db.listGrowTips().length);
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
