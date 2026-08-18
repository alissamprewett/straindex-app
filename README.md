# StrainDex

A social check-in, strain library, recipe box, and grow-tips community — built as a real, self-updating web app so you (or eventually your team) can keep adding content without needing me to hand-edit files.

This is a deliberately **zero-dependency** Node.js app — no `npm install` required, ever. It uses only what ships inside Node itself (a built-in web server and a built-in SQLite database). That was a constraint of the environment I built it in, but it's actually a feature for you: fewer moving parts, nothing to go out of date, and it'll run anywhere Node runs.

## What's inside

```
straindex-app/
  server.js          the whole app — routes, pages, admin panel, API
  lib/
    db.js             ALL database code lives here (see "Moving to a bigger database" below)
    auth.js           admin login (cookie-based sessions)
    render.js          page layout/shell
    body.js            request body parsing
    chat.js            the "Ask" tab's answer engine (see "Upgrading the chatbot" below)
    mockdata.js         demo content for events/shop/trading (see below)
    geodispensaries.js   real, live nearby-dispensary lookup via OpenStreetMap (see below)
  public/
    app.css, app.js    styling + browser-side behavior
    manifest.json, sw.js, icons/    makes it installable to a phone home screen (PWA)
  data/
    *.json              the original starter content (strains/FAQ/recipes/grow tips)
    straindex.db         the live SQLite database — this is where everything you add actually lives
  seed.js               one-time importer that loads data/*.json into straindex.db
```

## Running it yourself

You need Node.js 22.5 or newer (for the built-in SQLite support). Check with `node -v`.

```
npm run seed     # only needed once, or after deleting data/straindex.db
npm start
```

Then open `http://localhost:3000`. That's it — no build step, no compiling.

## How you update content

Everything you asked to be able to keep adding — FAQ entries, recipes, grow tips — is editable from inside the app itself, not from code:

1. Go to `/admin/login` (there's an "Admin" link in the top bar).
2. **The default password is `straindex-admin` — change this before you show the app to anyone else.** Set your own by running the app with an environment variable: `ADMIN_PASSWORD="something-only-you-know" npm start`. On a real host, you'll set this as an environment variable in that host's dashboard instead (see below).
3. From `/admin` you can add/edit/delete FAQ entries and add/delete recipes. Recipes people submit publicly from the Recipes tab land in a pending queue for you to approve — approving them is a click, no code involved.

Whenever you find a new recipe out in the wild, just log in and add it — same as you'd fill out any form.

## Deploying it somewhere real (so it's not just on your computer)

Right now this only runs on whatever machine you start it on. To get a real URL you and others can open from a phone, you need to put it on a host that keeps a Node process running continuously with a persistent disk (for the SQLite file). Good, cheap options:

- **[Render](https://render.com)** — "Web Service," free/low tier, supports persistent disks. Point it at this folder, set the start command to `npm start`, add a disk mounted at `/data`, and set `DB_PATH=/data/straindex.db` as an environment variable so your data survives redeploys.
- **[Railway](https://railway.app)** — similar model, also supports persistent volumes.
- **[Fly.io](https://fly.io)** — a bit more technical but has a generous free tier and persistent volumes too.

Avoid purely "serverless" hosts (Vercel, Netlify functions) for now — they don't keep a process or a local file alive between requests, which this app currently relies on for its database.

### Environment variables to set on whatever host you pick

| Variable | Purpose | Example |
|---|---|---|
| `PORT` | which port to listen on | usually set automatically by the host |
| `DB_PATH` | where the SQLite file lives | `/data/straindex.db` (point it at your persistent disk) |
| `SESSION_SECRET` | signs admin login cookies — set this to something random | `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | your real admin password | pick something only you know |

## Moving to a bigger database later (optional, only if you outgrow SQLite)

If this ever needs to support lots of simultaneous users, the one file to touch is `lib/db.js`. It's written so every other file in the app calls functions like `db.listStrains()` or `db.createRecipe()` — none of them know or care whether that's backed by SQLite or something else. To move to a hosted Postgres database (e.g. [Supabase](https://supabase.com), which has a generous free tier and is a common next step), you'd rewrite the internals of `lib/db.js` to run Postgres queries instead of SQLite ones, keeping the same function names. Nothing else in the app changes.

## Upgrading the "Ask" tab into a real chatbot

Right now `/chat` answers questions by matching your question's keywords against the FAQ and strain database — genuinely useful, and it works with zero setup or cost. When you're ready for something closer to a real conversational assistant:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com).
2. Install the Claude SDK: `npm install @anthropic-ai/sdk`.
3. Open `lib/chat.js` — there's a comment block at the top with the exact code to drop in, which sends your FAQ content to Claude as context and returns its answer instead of the keyword-matching logic.

Nothing else needs to change — the `/chat` page and its "Ask" button already call this one function.

## Turning this into an iOS app

The path you and I discussed: get this running well as a web app first (done), then wrap it for the App Store using **[Capacitor](https://capacitorjs.com)**, which takes a web app and packages it into a real native iOS project. That step needs a Mac with Xcode installed and an Apple Developer account ($99/year) — once you have both, come back and I can walk you through:

1. `npm install @capacitor/core @capacitor/ios` and `npx cap init`
2. Pointing Capacitor at this app (either bundled locally or pointed at your deployed URL)
3. Opening the generated Xcode project, setting your app icon/launch screen, and running it on a simulator or your own phone
4. Eventually submitting to the App Store through Xcode + App Store Connect

Until then, the app is already installable as a **home-screen PWA** from Safari on an iPhone (Share → Add to Home Screen) — it gets its own icon and opens full-screen without browser chrome, which covers a lot of the "feels like an app" experience in the meantime.

## The "More" tab — collection, trading, dispensaries, events, shop, badges, business

Tap **More** in the bottom nav for everything beyond the core check-in/recipes/FAQ flow:

- **My Collection** — every strain you've checked in shows up as a card in your binder, with rarity-colored borders and a shimmer effect on Legendary pulls. Stats (cards caught, tradeable duplicates, badges earned) and a progress bar sit up top.
- **Trade** — pick a sample friend and propose swapping a spare duplicate for one of theirs.
- **Check-In History** — your full timeline, newest first.
- **Dispensaries** — tap "Use my location" and it looks up **real** nearby dispensaries (name, address, hours where listed, directions) via OpenStreetMap's free Overpass API — no signup or API key needed. Coverage is crowdsourced, so it can be spotty in some areas; if nothing turns up nearby, it falls back to the sample listings below with a note explaining why. No real live menu/pricing data is shown, since that lives inside each dispensary's own point-of-sale system, not a public feed. See "Upgrading dispensary data" below to swap in Google Places for better coverage.
- **Events**, **Shop** — sample listings (`lib/mockdata.js`) so these screens have something to show. Following a dispensary, RSVPing to an event, and adding to cart all persist to the database — they're just not backed by a real events/commerce feed yet.
- **Badges** — 13 badges computed live from your actual activity (check-ins, trades, follows, RSVPs, recipes, grow tips).
- **StrainDex for Business** — a partner-dashboard preview showing *real* trending strains pulled from your actual check-in data.
- **Ways to Enjoy It** — every ingestion method with onset/duration info.

**On trading specifically**: there's no real multi-user account system in this app yet — it's just you, with an admin password. So "Trade" swaps against sample fictional friends (Jordan, Maya, Chris) rather than a real second person, and says so on the page itself. Real friend-to-friend trading would need real user accounts first — a bigger step than this round covered, and worth a dedicated conversation if you want to prioritize it.

### Upgrading dispensary data to Google Places (optional, better coverage)

The free OpenStreetMap lookup (`lib/geodispensaries.js`) works with zero setup, but its coverage depends on volunteers having mapped dispensaries in your area. For more complete, verified coverage (plus real ratings, photos, and hours), you can swap in Google's Places API instead:

1. Create a Google Cloud account and enable the Places API (Google gives a recurring monthly free credit; at low traffic this may stay free, but it's a paid API past that, so keep an eye on usage).
2. Get an API key and set it as an environment variable, e.g. `GOOGLE_PLACES_API_KEY`.
3. In `lib/geodispensaries.js`, replace the body of `findNearbyDispensaries()` with a call to Places Nearby Search (`type=dispensary` or a keyword search for "dispensary"/"cannabis"), keeping the same return shape (`{ ok, results, reason }` with the same fields per result) — nothing else in the app needs to change.

## Known gaps / honest limitations right now

- **Photos** are stored directly in the database as embedded image data — fine for personal use, but if lots of people start uploading photos this should move to a proper file storage service (e.g. Supabase Storage or AWS S3) rather than growing the database file. Flag this to me if usage grows.
- **Admin is single-password**, not per-user accounts — fine for you managing it solo, but would need real accounts if you bring on other admins (and would need to exist before trading can be real).
- **Dispensaries, events, shop, and trading use sample data**, not a live feed — see above.
- This is a **concept/prototype build** — the strain data's THC/CBD/terpene numbers are illustratively generated where the source dataset didn't have reliable real values (documented in the project notes), not lab-verified figures. Worth knowing before treating any specific number as fact.
