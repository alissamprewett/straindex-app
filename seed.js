// seed.js — one-time (idempotent) import of the starter content into the database.
// Run with: node seed.js
const fs = require('node:fs');
const path = require('node:path');
const db = require('./lib/db');

function loadJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', name), 'utf8'));
}

const strains = loadJSON('strains.json');
const faqs = loadJSON('faqs.json');
const recipes = loadJSON('recipes.json');
const growTips = loadJSON('growtips.json');

console.log(`Seeding ${strains.length} strains...`);
for (const s of strains) db.insertStrain(s);

if (db.listFaqs().length === 0) {
  console.log(`Seeding ${faqs.length} FAQ entries...`);
  faqs.forEach((f, i) => {
    if (f.a === '__TERPLEGEND__') return; // that entry was a UI hook in the old prototype, not real content
    db.createFaq({ question: f.q, answer: f.a, sort_order: i });
  });
} else {
  console.log('FAQs already present, skipping (edit them via /admin instead).');
}

if (db.listRecipes({ status: null }).length === 0) {
  console.log(`Seeding ${recipes.length} recipes...`);
  for (const r of recipes) {
    db.createRecipe({
      title: r.title, time: r.time, icon: r.icon, source: r.source || 'official',
      author: r.author, desc: r.desc, ingredients: r.ingredients, steps: r.steps,
      dosing: r.dosing, status: 'approved', kudos: r.kudos || 0,
    });
  }
} else {
  console.log('Recipes already present, skipping (edit them via /admin instead).');
}

if (db.listGrowTips().length === 0) {
  console.log(`Seeding ${growTips.length} grow tips...`);
  for (const g of growTips) {
    db.createGrowTip({ title: g.title, category: g.category, author: g.author, body: g.body });
  }
} else {
  console.log('Grow tips already present, skipping.');
}

console.log('Seed complete.');
console.log('Strains in DB:', db.countStrains());
console.log('FAQs in DB:', db.listFaqs().length);
console.log('Recipes in DB:', db.listRecipes({ status: null }).length);
console.log('Grow tips in DB:', db.listGrowTips().length);
