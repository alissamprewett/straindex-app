// mockdata.js — fictional demo data for features that need "other people"
// (dispensaries, events, shop, friends to trade with) that a single-admin
// app with no user-account system doesn't have real data for yet. Ported
// from the original interactive prototype. Strain IDs referenced here
// (s1-s16) are the 16 hand-curated strains and are guaranteed to exist in
// the seeded database.
//
// Honest note: none of this is real dispensary/event data — it's the same
// illustrative demo content the prototype shipped with, so the app has
// something to show these screens with. Swap for a real data source (a
// dispensary API, a real events feed) when/if that's worth doing.

const dispensaries = [
  { id: 'd1', name: 'Green Leaf Collective', distance: '0.4 mi', rating: 4.7, updated: '12m ago', address: '123 Main St', hours: '9am–9pm',
    menu: [{ strainId: 's1', price: '$45/eighth' }, { strainId: 's9', price: '$50/eighth' }, { strainId: 's15', price: '$65/eighth' }], exclusiveCard: 's15' },
  { id: 'd2', name: 'The Herb Room', distance: '1.1 mi', rating: 4.5, updated: '1h ago', address: '456 Oak Ave', hours: '8am–10pm',
    menu: [{ strainId: 's3', price: '$40/eighth' }, { strainId: 's6', price: '$42/eighth' }, { strainId: 's7', price: '$44/eighth' }], exclusiveCard: null },
  { id: 'd3', name: 'Summit Provisions', distance: '2.3 mi', rating: 4.8, updated: '3h ago', address: '789 Pine Rd', hours: '10am–8pm',
    menu: [{ strainId: 's13', price: '$55/eighth' }, { strainId: 's14', price: '$52/eighth' }], exclusiveCard: 's16' },
];

const events = [
  { id: 'e1', title: '4/20 Block Party', venueId: 'd1', month: 'APR', day: '20', desc: 'Live music, food trucks, and drop-only strains all afternoon.' },
  { id: 'e2', title: 'Terpene 101 Workshop', venueId: 'd2', month: 'AUG', day: '24', desc: 'Learn to identify terpene profiles by smell with our budtenders.' },
  { id: 'e3', title: 'Cultivator Meet & Greet: Landrace Series', venueId: 'd3', month: 'SEP', day: '06', desc: 'Meet the growers behind Durban Poison & Hindu Kush.' },
];

// Real product photos for the paraphernalia-category items (grinder, water
// pipe, storage jar) -- swapped in from generic emoji since these are
// genuine accessory categories, not placeholder icons. Tee/cards/pins stay
// as emoji since they're not paraphernalia.
const shopItems = [
  { id: 'sh1', name: 'StrainDex Grinder', price: '$28', icon: '⚙️' },
  { id: 'sh2', name: 'Rolling Tray', price: '$22', icon: '🟫' },
  { id: 'sh3', name: 'Glass Storage Jar', price: '$16', icon: '🫙' },
  { id: 'sh4', name: 'StrainDex Tee', price: '$24', icon: '👕' },
  { id: 'sh5', name: 'Terpene Tasting Cards', price: '$18', icon: '🃏' },
  { id: 'sh6', name: 'Enamel Pin Set', price: '$14', icon: '📌' },
];

// Fake friends with fake collections, for the trading demo — see the honest
// caveat rendered on /trade: there's no real multi-user account system yet,
// so trading against these is illustrative, not a real transfer.
const friends = [
  { id: 'f1', name: 'Jordan', collection: { s9: 2, s6: 2, s7: 1, s13: 1, s1: 1 } },
  { id: 'f2', name: 'Maya', collection: { s12: 1, s10: 2, s14: 1, s5: 1 } },
  { id: 'f3', name: 'Chris', collection: { s15: 1, s6: 1, s3: 1 } },
];

const methodGuide = [
  { name: 'Smoking (Joint / Blunt / Pipe / Bong)', icon: '/docs/method-bong.jpg', onset: '1–5 min', duration: '1–3 hrs',
    desc: 'The classic route — combusted flower inhaled directly into the lungs. Fast-acting and easy to dose hit-by-hit, though combustion also produces byproducts that vaping avoids.' },
  { name: 'Dry Herb Vaporizing', icon: '💨', onset: '5–15 min', duration: '1–3 hrs',
    desc: 'Heats flower to a temperature that releases cannabinoids as vapor without combustion — generally considered gentler on the lungs than smoking, with similar effects.' },
  { name: 'Vape Cartridges / Pens', icon: '🖊️', onset: '3–8 min', duration: '1–2.5 hrs',
    desc: 'Pre-filled oil cartridges heated by a battery. Discreet and portable; potency and quality vary a lot by brand, so buy from licensed, lab-tested sources.' },
  { name: 'Dabbing & Concentrates', icon: '🔥', onset: '1–3 min', duration: '1–3 hrs',
    desc: 'Flash-vaporizing a concentrate (wax, shatter, live resin, rosin) on a hot surface. Very fast onset and high potency per hit — best suited to experienced users.' },
  { name: 'Edibles (Gummies, Baked Goods, Chocolate)', icon: '🍪', onset: '30–120 min', duration: '4–8 hrs',
    desc: "Digested and processed by the liver into 11-hydroxy-THC, which hits harder and lasts longer than inhalation. Start low, and don't redose during the wait." },
  { name: 'Beverages', icon: '🥤', onset: '30–90 min (15–30 min if nano-emulsified)', duration: '3–6 hrs',
    desc: 'Infused drinks work like other edibles for standard formulations; nano-emulsified drinks are broken into tiny particles for noticeably faster onset.' },
  { name: 'Capsules / Pills', icon: '💊', onset: '45–120 min', duration: '4–8 hrs',
    desc: 'A pre-measured, smoke-free edible format — consistent dosing makes them popular for people who want a predictable, repeatable experience.' },
  { name: 'Tinctures (Sublingual)', icon: '💧', onset: '15–45 min', duration: '2–4 hrs',
    desc: "Held under the tongue for 30–60 seconds before swallowing, absorbing partly through the mouth's mucous membranes — faster than a standard edible, easy to dose drop by drop." },
  { name: 'Topicals', icon: '🧴', onset: '15–45 min (localized)', duration: '2–4 hrs',
    desc: "Creams, balms, and salves absorbed through the skin for localized effects only — most formulations don't produce a psychoactive high since THC largely doesn't reach the bloodstream this way." },
  { name: 'Transdermal Patches', icon: '🩹', onset: '30–90 min', duration: '6–12 hrs',
    desc: "Unlike topicals, patches are formulated to push cannabinoids through the skin into the bloodstream for a slow, steady systemic effect over many hours." },
  { name: 'Suppositories', icon: '⚕️', onset: '~10–20 min (anecdotally faster)', duration: '4–8 hrs',
    desc: "Inserted rectally or vaginally, bypassing the liver's first-pass metabolism. Less common and less studied than other methods, but some report strong relief with less of the intoxicating head high." },
  { name: 'RSO (Rick Simpson Oil)', icon: '🟫', onset: '30–120 min (taken like an edible)', duration: '6–8+ hrs',
    desc: 'A very concentrated whole-plant extract, typically dosed in tiny rice-grain-sized amounts taken orally or under the tongue. Strong and long-lasting — start with the smallest dose imaginable.' },
  { name: 'Kief, Hash & Moon Rocks', icon: '/docs/method-grinder.jpg', onset: '1–5 min (smoked/vaped)', duration: '1–3 hrs',
    desc: "Concentrated trichome forms of flower, usually smoked or vaped like flower but noticeably more potent per hit — easy to overdo if you're used to regular flower." },
];

// Real THC ranges below come from actual Washington state lab-testing data
// (Cannlytics cannabis_results dataset, ~95K flower/concentrate samples),
// cross-checked against published industry sources, rather than guessed —
// same standard the strain library's THC-verification project uses.
const concentrateGuide = [
  { name: 'Kief', icon: '✨', thc: '29–40%',
    desc: 'Loose trichomes sifted off dried flower using fine mesh screens — no solvent, no heat, the simplest concentrate to make. Often sprinkled on top of a bowl or joint rather than used on its own.' },
  { name: 'Bubble Hash / Dry Sift Hash', icon: '🟤', thc: '30–70%',
    desc: 'Trichomes separated using ice water and mesh bags (bubble hash) or dry sifting. Solvent-free, but potency swings widely by grade — lower-grade hash sits well under premium "full-melt" hash.' },
  { name: 'Rosin', icon: '🍯', thc: '65–75%',
    desc: 'Heat and pressure squeeze the resin directly out of flower or hash — no solvent at all, which makes it one of the cleanest extraction methods available.' },
  { name: 'Live Rosin', icon: '🧊', thc: '69–75%',
    desc: "Same heat-and-pressure process as rosin, but starting from fresh-frozen (never dried or cured) flower — preserves more of the plant's original terpene profile." },
  { name: 'Live Resin', icon: '🟡', thc: '61–78%',
    desc: 'Solvent-based extraction (typically butane or propane) from fresh-frozen flower, prized for a strong, true-to-plant flavor that dried-flower extracts often lose.' },
  { name: 'Shatter', icon: '🍬', thc: '70–76%',
    desc: 'Butane hash oil purged into a thin, glass-like, brittle slab — one of the most recognizable concentrate textures, and named for how it snaps when broken.' },
  { name: 'Wax / Budder / Badder', icon: '🧈', thc: '69–78%',
    desc: 'Butane hash oil whipped or agitated during purging into a softer, opaque consistency — same base extraction as shatter, easier to handle, similar potency.' },
  { name: 'Sauce / Diamonds', icon: '💠', thc: '50–90%',
    desc: "THCA crystallizes into 'diamonds' suspended in a terpene-rich liquid ('sauce') — the ratio of diamond to sauce varies a lot batch to batch, which is why the potency range is so wide." },
  { name: 'Distillate', icon: '🧴', thc: '76–87%',
    desc: 'Refined through short-path distillation until it\'s nearly pure THC oil — flavorless and terpene-free on its own, so it\'s usually re-infused with terpenes for vape carts and edibles.' },
  { name: 'RSO (Rick Simpson Oil)', icon: '🟫', thc: '46–73%',
    desc: 'A whole-plant ethanol extraction that pulls out everything, including chlorophyll — thick, dark, and typically taken orally in tiny rice-grain-sized doses rather than smoked.' },
];

const terpeneColors = {
  Myrcene: '#2a78d6', Limonene: '#eb6834', Caryophyllene: '#1baf7a', Pinene: '#eda100',
  Linalool: '#e87ba4', Humulene: '#008300', Terpinolene: '#4a3aa7', Ocimene: '#e34948',
};

module.exports = { dispensaries, events, shopItems, friends, methodGuide, concentrateGuide, terpeneColors };
