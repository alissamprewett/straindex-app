// chat.js — the "Ask" tab's answer engine.
//
// Today this is a dependency-free keyword/relevance matcher over the FAQ
// and strain data already sitting in lib/db.js — no API key, no npm
// package, works fully offline in this sandbox.
//
// WHEN YOU'RE READY FOR A REAL CHATBOT: get an Anthropic API key
// (console.anthropic.com), install the `@anthropic-ai/sdk` package, and
// replace the body of `answerFromKnowledgeBase` below with a call to
// client.messages.create({...}), feeding it the same FAQ/strain context
// as a system prompt. Everything that calls this function (server.js's
// /api/chat route) stays exactly the same — this is the one function to
// swap, same as db.js is the one file to swap for Postgres.
//
// Example future version:
//
//   const Anthropic = require('@anthropic-ai/sdk');
//   const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
//   async function answerFromKnowledgeBase(message) {
//     const faqs = db.listFaqs();
//     const context = faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');
//     const resp = await client.messages.create({
//       model: 'claude-sonnet-4-5',
//       max_tokens: 500,
//       system: `You are StrainDex's assistant. Use this FAQ knowledge base to answer questions:\n\n${context}`,
//       messages: [{ role: 'user', content: message }],
//     });
//     return resp.content[0].text;
//   }

const db = require('./db');

const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','to','of','and','or',
  'in','on','at','for','with','about','as','by','it','this','that','what','which',
  'who','whom','how','do','does','did','can','could','should','would','i','you',
  'my','me','your','if','so','than','then','will','just','not','no','yes','get',
  'good','best','some','any','has','have','had','there','their',
]);

function tokenize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
}

function scoreOverlap(queryTokens, text) {
  const targetTokens = new Set(tokenize(text));
  let hits = 0;
  for (const t of queryTokens) {
    if (targetTokens.has(t)) hits++;
    else {
      // loose partial match (e.g. "sleepy" vs "sleep")
      for (const tt of targetTokens) {
        if (tt.length > 3 && (tt.includes(t) || t.includes(tt))) { hits += 0.5; break; }
      }
    }
  }
  return hits;
}

// Small set of intent shortcuts for very common questions, checked before
// the generic FAQ search so they feel snappy and on-brand.
const INTENTS = [
  {
    keys: ['sleep', 'insomnia', 'bed', 'night'],
    reply: "For sleep, most people reach for **indica** strains high in myrcene and linalool — think heavy, relaxing body highs. Check the Strains tab and filter by type \"Indica\", or look for effects like \"Sleepy\" or \"Relaxed\" in a strain's profile.",
  },
  {
    keys: ['energy', 'focus', 'daytime', 'wake', 'productive'],
    reply: "For daytime energy or focus, look at **sativa** strains — they tend to run higher in limonene/pinene and lean more cerebral/uplifting. Filter the Strains tab by type \"Sativa\" and look for \"Energetic\" or \"Focused\" in the effects list.",
  },
  {
    keys: ['edible', 'edibles', 'kick', 'onset', 'long'],
    reply: "Edibles typically take **30–90 minutes** to kick in (sometimes up to 2 hours on a full stomach) because they have to pass through your digestive system first, versus seconds-to-minutes for smoking or vaping. Start low, go slow, and wait a full 2 hours before considering more.",
  },
  {
    keys: ['thc'],
    reply: "THC (tetrahydrocannabinol) is the main psychoactive compound in cannabis — it's what produces the \"high.\" Each strain page on StrainDex shows an estimated THC% range so you can compare potency before you check in.",
  },
  {
    keys: ['cbd'],
    reply: "CBD (cannabidiol) is non-intoxicating and is associated with relaxation, pain relief, and taking the edge off THC's psychoactivity. Strains with a higher CBD:THC ratio tend to feel milder and more functional.",
  },
  {
    keys: ['terpene', 'terp', 'terpenes'],
    reply: "Terpenes are the aromatic oils that give each strain its distinct smell and flavor — and they also shape the effect alongside THC/CBD (the \"entourage effect\"). Every strain page lists its top terpenes with a percentage breakdown.",
  },
  {
    keys: ['method', 'ingest', 'smoke', 'vape', 'dab', 'ways'],
    reply: "There are a lot of ways to consume — smoking (joint, pipe, bong), vaping (flower or concentrate), dabbing, edibles, tinctures, capsules, topicals, and more. The full list is available whenever you check in on a strain.",
  },
  {
    keys: ['grow', 'growing', 'cultivate', 'cultivation', 'plant'],
    reply: "Check out the Growing tab — it's a community space where growers share tips on everything from lighting and nutrients to training techniques and harvest timing.",
  },
  {
    keys: ['recipe', 'cook', 'cooking', 'edible', 'infuse', 'infusion'],
    reply: "Head to the Recipes tab for infused dishes and drinks. Found a great recipe out in the wild? You can submit it yourself from that tab — it'll go to an admin for approval and can earn kudos from the community once it's live.",
  },
  {
    keys: ['card', 'trading', 'trade', 'collect', 'collection'],
    reply: "Every strain you check in on adds a collectible card to your library, with rarity tiers from Common up to Legendary. You'll be able to trade duplicates with friends as that feature rolls out.",
  },
];

function answerFromKnowledgeBase(message) {
  const q = (message || '').trim();
  if (!q) {
    return Promise.resolve("Ask me anything about strains, effects, methods, growing, or recipes!");
  }
  const queryTokens = tokenize(q);

  // 1) Intent shortcuts
  for (const intent of INTENTS) {
    if (intent.keys.some((k) => queryTokens.includes(k) || q.toLowerCase().includes(k))) {
      return Promise.resolve(intent.reply);
    }
  }

  // 2) Search the FAQ knowledge base for the best-overlapping entry
  const faqs = db.listFaqs();
  let bestFaq = null;
  let bestFaqScore = 0;
  for (const f of faqs) {
    const score = scoreOverlap(queryTokens, `${f.question} ${f.answer}`);
    if (score > bestFaqScore) { bestFaqScore = score; bestFaq = f; }
  }
  if (bestFaq && bestFaqScore >= 1) {
    return Promise.resolve(bestFaq.answer);
  }

  // 3) Maybe they're asking about a specific strain by name
  const strains = db.listStrains({ limit: 2000 });
  let bestStrain = null;
  let bestStrainScore = 0;
  for (const s of strains) {
    const score = scoreOverlap(queryTokens, s.name);
    if (score > bestStrainScore) { bestStrainScore = score; bestStrain = s; }
  }
  if (bestStrain && bestStrainScore >= 1) {
    const topEffects = (bestStrain.effects || []).slice(0, 3).join(', ');
    const topTerp = (bestStrain.terps || [])[0];
    return Promise.resolve(
      `${bestStrain.name} is a ${bestStrain.rarity.toLowerCase()} ${bestStrain.type}${bestStrain.lean ? ` (${bestStrain.lean})` : ''}` +
      `${bestStrain.thc ? `, around ${bestStrain.thc} THC` : ''}. Common effects: ${topEffects || 'varies by person'}.` +
      `${topTerp ? ` Its top terpene is ${topTerp.n} (${topTerp.p}%).` : ''} Check its full card on the Strains tab for the complete profile and your check-in history.`
    );
  }

  // 4) Fallback
  return Promise.resolve(
    "I don't have a great answer for that yet — try browsing the FAQ tab, or ask me about strains, effects, ingestion methods, growing tips, or recipes and I'll do my best!"
  );
}

module.exports = { answerFromKnowledgeBase };
