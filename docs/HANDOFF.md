# StrainDex — Handoff Notes for a Future Claude Session

Written by a prior Claude session for whichever Claude picks this up next.
Read this whole thing before doing anything — it'll save both of you time.

## The absolute basics

- **Live app**: https://straindex-dber.onrender.com
- **GitHub repo**: https://github.com/alissamprewett/straindex-app (public, branch `main`)
- **Render service ID**: `srv-da1qjkht0dsc73ae4rc0`
- **Person**: Alissa — the app's creator, **non-technical**. No git experience,
  minimal terminal experience (has run a couple of Python scripts with very
  literal step-by-step help). Give exact click-paths and exact commands to
  type, never assume familiarity with dev tooling.
- **Stack**: Zero-dependency Node.js (`http` module, no Express), server-
  rendered HTML via template literals, Turso (hosted libSQL/SQLite-compatible)
  for the database, vanilla JS on the client (no framework, no build step).
- **This is a real, live app with real users now** — Alissa's friends are
  actually using it. Placeholder/mock/demo data is no longer acceptable
  anywhere it's user-visible. If something can't show real data, it should
  show an honest empty state, not fake sample content.

## How deploys actually work (important, non-obvious)

Alissa has no local dev environment and no git CLI. The workflow is:
1. Claude edits files in the sandbox at `/home/claude/straindex-new/` (or
   wherever the working copy lives that session).
2. Claude zips changed files **grouped by destination folder** (e.g. one zip
   for root-level files, one for `lib/`, one for `public/`, one for `data/`,
   one for `docs/`) and presents them via `present_files`.
3. Alissa unzips locally, then manually uploads each file via GitHub's web
   UI: `github.com/alissamprewett/straindex-app/upload/main` (or the
   equivalent subfolder path), and clicks "Commit changes."
4. Then she goes to the Render dashboard → the service → "Manual Deploy" →
   "Deploy latest commit."

**Lessons learned the hard way, so you don't repeat them:**
- She has occasionally uploaded files to the wrong folder or missed a file
  in a multi-file round. When something doesn't work after a deploy, check
  the actual GitHub file contents/sizes against your local copy *before*
  assuming the code is wrong — fetch `https://api.github.com/repos/alissamprewett/straindex-app/git/trees/main?recursive=1`
  and compare file sizes, or `web_fetch` specific files.
- When many zips pile up across a long conversation, it gets confusing which
  one is current. If in doubt, **repackage the full current state of every
  touched file into one clean set** and say "ignore everything before this."
- Give explicit numbered steps for GitHub's UI every time — she's done this
  many times now but still appreciates not having to guess.

## Images: a real gotcha, now solved

- Hotlinking to external image hosts **does not work reliably**. Pixabay
  explicitly forbids it in their terms; Unsplash search-result URLs can be
  temporary. Self-hosting is required.
- **Images ended up living at the repo root under `/docs/`** (not
  `/public/images/` as originally planned) — purely because that's where
  Alissa uploaded them once and it was easier to adapt the server than ask
  her to redo it. `server.js` has a special case in `serveStatic()` that
  serves `/docs/*` requests from the actual `docs/` folder at the repo root
  (separate from `PUBLIC_DIR`). **If adding new images, either keep using
  `/docs/` for consistency, or be very explicit with Alissa about which
  exact folder to upload to.**
- Current images living there: `leaf-kudos.png` (a real cannabis leaf,
  transparent background, used as the kudos icon everywhere and as the
  Strains nav tab icon), `joint-icon.png` (cropped from Alissa's own
  rolodex artwork, used on the "Ways to Enjoy It" tile).
- The app icon (`public/icons/icon-192.png` and `icon-512.png`) is Alissa's
  own AI-generated rolodex artwork, center-cropped to a square. This is also
  now used in the page header next to "StrainDex".
- **Strain photos**: every strain shows a real photo via `strainPhotoTag()`
  in `server.js` — a small rotating pool of real, free-licensed Unsplash/
  Pixabay bud photos (self-hosted, same `/docs/` pattern), assigned
  deterministically per strain by name hash, with a CSS hue-rotate filter
  for purple/grape-named strains. This is intentionally a small pool (~7
  photos) reused across 1,649 strains — it's not meant to be strain-accurate,
  just "a real photo instead of an emoji."
- If asked to source more images: Unsplash License and Pixabay Content
  License are both genuinely free/commercial-use with no attribution
  required, but **must be downloaded and self-hosted, never hotlinked**.
  rawpixel.com also has explicitly public-domain photos. Wikimedia Commons
  is usable but licenses vary per-file (often requires attribution).

## Copyright/licensing stance established this project (apply consistently)

- **Never bulk-copy a commercial competitor's curated content** — this was
  explicitly worked through for Leafly and SeedFinder.eu (both declined).
- **Openly-licensed datasets are fair game**: `openthc/vdb` (GPL-3.0, strain
  *names* only, ~11,175 unused candidates saved — see
  `docs/strain-research-log.md`), the Kushy Cannabis Dataset (MIT license,
  name + type + occasional effects/flavor, ~7,928 unused candidates with
  type already tagged, same log), and the Cannlytics lab-results dataset on
  Hugging Face (CC BY 4.0, *real* lab-tested THC/CBD/terpene data — used to
  validate/correct THC ranges, see below).
- **All strain/recipe/FAQ content is written from scratch** informed by
  research, never copy-pasted from any single source, even permissively
  licensed ones — for consistency of voice and to avoid quality issues in
  someone else's data (see the Cannlytics section on THC placeholder bugs).
- Real, named brands baked into Alissa's own artwork (e.g. "RAW" rolling
  papers visible in a couple of crops) were deliberately excluded from reuse
  as icons, even though the surrounding artwork is hers — that's someone
  else's trademark incidentally present in the scene.

## Current feature state (as of this handoff)

**Accounts & social**
- Signup/login/logout, age-gated 21+ (exact age check, not just birth year).
- Account Settings page (`/account`, linked from More) — change username
  (checks uniqueness) and password (requires current password).
- Friends: search by username, send/accept/decline requests, remove,
  friend profiles (`/friends/:id`, gated to actual friends only) showing
  their strain count, badge progress, and recent check-ins.
- **Real activity feed on Home** — pulls check-ins from the user *and*
  their friends together, sorted by recency, labeled with whose post it is.
  This was a real gap (Home used to only ever show the logged-in user's own
  check-ins) — fixed.
- Bottom nav is **exactly 6 tabs**: Home, Strains, Recipes, Growing,
  Friends, More. "Ask" (the FAQ chatbot) and "FAQ" itself both live inside
  More now, not in the main nav.

**Check-ins**
- Mood/effects selection is now **optional** (was previously required,
  removed both server- and client-side validation).
- **Fully editable after the fact** — `/checkin/:id/edit`, same form,
  pre-filled. Important for edibles, where the felt experience often
  changes after the initial log.
- Timestamps are timezone-correct: server sends raw UTC in a `data-utc`
  attribute (`<span class="local-time" data-utc="...">`), and a small
  client-side script in `app.js` converts to each viewer's own local time
  on page load. (Previously this was computed server-side, which baked in
  Render's server timezone for every viewer — a real bug, now fixed.)
- Kudos (leaf icon, see below) on: Home feed, friend profiles, and a
  user's own strain-detail check-in history. **Not** on the compact
  `/history` list page (kept as a dense scannable list, no buttons).
- No photo uploaded → nothing renders in that slot (no placeholder icon
  box). Only real uploaded photos ever show.

**Strain library** (2,005 strains as of the latest Weedmaps directory audit
session -- this count will keep climbing across sessions, treat "1,649"
above as stale rather than current)
- Search by name/flavor text, **and now also alias/aka text** (`lib/db.js`
  `matchesFilters()` -- previously only checked `name` and `flavor`, so a
  strain search for e.g. "Tallyman" or "Better Than Yours OG" returned
  nothing even though the strain existed under a different display name.
  Fixed by also checking the `aka` array field. 200+ strains already have
  real aka data sitting there from prior research batches -- this fix made
  all of it actually searchable), Type (Indica/Sativa/Hybrid), Rarity, THC
  bucket (Low/Medium/High, parsed from the stored range string), dominant
  terpene, and "Looking for relief from..." (ailment tags from the Kushy
  dataset -- 960 strains have real ailment associations; explicitly labeled
  "user-reported, not medical advice").
- Breeder credit shown on strain detail pages where known (798 strains,
  though this number is also stale -- many more added since via the
  Weedmaps audit, most with confirmed breeder + parent strains).
- **Ongoing Weedmaps directory audit**: cross-referencing
  `weedmaps.com/strains?page=N` (1,106 pages total) against the library to
  find missing strains and duplicate/misspelled entries. See
  `docs/strain-research-log.md` for the standing research methodology
  (specifically the "multi-version / ambiguous-lineage strains" section --
  read this before researching any strain whose name is generic enough
  that multiple unrelated breeders might have used it) and the running
  list of names that were researched but couldn't be confirmed well
  enough to add (revisit those before re-researching from scratch).
- Real photos everywhere (see Images section above).
- **Known data-quality issue, not fully resolved**: the original starter
  dataset (pre-dating this session) has ~75 strains with a suspicious
  "1–6%" THC placeholder value. Two (Green Crack, Diesel) were confirmed
  wrong via real Cannlytics lab data and fixed. **74 remain unverified** —
  some may be genuinely accurate (e.g. ACDC really is low-THC/high-CBD),
  so each needs individual checking, not a bulk overwrite. List and method
  are in `docs/strain-research-log.md`.
- 32 other strains had their THC ranges updated to real current-market
  data from a Cannlytics California pull (see that log for the full list
  and reasoning — the old numbers weren't "wrong," just reflecting older/
  more conservative reference ranges vs. today's more potent legal market).

**Recipes** (88 recipes across 6 categories, ~equally distributed)
- Search by name, ingredient, or description text.
- Individual recipe detail pages (`/recipes/:id`).
- **Cross-linking**: recipes that use an infusion base (cannabutter,
  infused oil, tincture, etc.) show a "Uses: X" line linking directly to
  one designated *canonical* recipe for that base (see
  `CANONICAL_BASE_RECIPE` in `server.js`) — not a search results page.
  68 of 88 recipes are tagged via a `usesBase` array field (schema: new
  `uses_base` column on the `recipes` table, JSON-encoded).
- Kudos (leaf icon) on every recipe card and detail page.
- Full sourcing/research history in `docs/recipe-research-log.md` —
  what's covered, what sources were checked (and which were rejected and
  why), and what's queued for the next batch.

**Growing tips** (13 tips, real sourced content with citations)
- Kudos button updated to match the same leaf-icon style as recipes
  (previously a plain "👍 Helpful" button).

**FAQ** (42 entries, real sourced content with citations to NIDA, StatPearls,
Pew Research, NIAAA, CDC-adjacent sources, etc.)
- Restructured: top 8 most-fundamental questions always shown, the other
  34 are searchable (not one long scrolling list).
- The "Ask" chatbot (`/chat`) answers *from this same FAQ content* via
  simple keyword matching in `lib/chat.js` — expanding the FAQ directly
  improves the chatbot too.

**Dispensaries**
- **All placeholder/mock data has been removed.** Previously fell back to
  fake "Green Leaf Collective"-style sample listings when real lookup
  failed or hadn't been searched yet — this is gone. Now shows either real
  Google Places results, or an honest empty/error state.
- Backend: Google Places API (New), using Text Search (not a strict place-
  type filter, since Google doesn't have a clearly documented "cannabis
  dispensary" type). Falls back to the free OpenStreetMap Overpass API
  automatically if `GOOGLE_PLACES_API_KEY` isn't set in the environment.
- **Confirmed working** via live testing (ZIP code search returned 15 real
  dispensaries near Beverly Hills). The "Use my location" GPS button
  couldn't be fully verified in an automated browser (no real GPS access
  in that context) — if Alissa reports it still not working on her actual
  device, the likely cause is a location-permission prompt she's missing
  or denying, not the Google connection itself.
- The Home page no longer shows a fake "nearby dispensaries" preview
  (same reasoning — no real location is known on Home without a location
  flow), replaced with an honest link to the real search.

**Badges** — all 13 are now genuinely personal to the account (this was a
real bug fixed earlier: two badges used to check app-wide totals instead
of the specific user's own activity).

**Hidden-but-not-deleted features**: Events, Shop, and "StrainDex for
Business" are intentionally removed from the More menu (not linked
anywhere) because they still run on demo/mock data with no real backing
yet. Their routes and code still work if hit directly — this was a
deliberate choice ("don't delete, just don't show it until it's real").

## Kudos icon

A small leaf image (`/docs/leaf-kudos.png`), cropped from a second piece
of open-source cannabis leaf art Alissa provided (not the rolodex
artwork) with the white background made transparent. Used via a shared
`KUDOS_BUD_ICON` constant in `server.js`. When updating the kudos count
client-side (`app.js`), the click handlers preserve this icon by grabbing
`btn.querySelector('img, svg')` before rewriting `innerHTML` — if you ever
change the icon back to inline SVG, that selector already handles both.

## Responsive design

Was previously hardcoded to `max-width:520px` with zero media queries,
so desktop/tablet users saw a tiny centered mobile-width column with huge
wasted space on both sides. Fixed with two breakpoints (700px, 1000px)
that widen the container in stages — but this is a basic fix, not a full
desktop redesign. The underlying components (single-column cards, lists)
are still fundamentally mobile-UI patterns reflowed wider, not a true
responsive multi-column layout. Real device testing (actual phone, actual
desktop browser) hasn't been confirmed by Alissa since this fix shipped.

## Things explicitly deferred / good next steps

- **Terpene validation against real data** — same idea as the THC
  validation, but needs a Cannlytics pull that *keeps* the heavy `results`
  column (the slimmed CSVs used so far only have `total_terpenes` as one
  number, not which specific terpenes make it up). Would need a filtered
  pull (Flower type only, to keep file size reasonable) — not yet done.
- **Lab-test FAQ enrichment with real analyte names** — proposed, not done.
  Real examples already seen in Cannlytics data (e.g. specific contaminant/
  quality-check line items) could make the existing "how to read a COA"
  FAQ entry more concrete.
- **Continue the 74-strain "1–6% THC" cleanup** (see Strain library above).
- **More batches from the saved candidate pools** (openthc/vdb ~11,100
  unused names; Kushy ~7,928 unused names with type already tagged) —
  see `docs/strain-research-log.md` for the exact counts and where they're
  saved.
- **More recipes** — every category is now reasonably balanced (11-19
  each), no urgent gap, but `docs/recipe-research-log.md` has a running
  "up next" list (e.g. a dedicated whipped-cream-charger infusion method,
  cold-infusion honey variant).
- **More cartoon-style icons from Alissa's artwork** — only the leaf and
  one joint crop have been pulled in as real UI icons so far. Several
  generic emoji are still used elsewhere (🍯 Recipes nav icon, 🌱 Growing,
  emoji inside various cards) that could be swapped for more crops from
  her rolodex artwork (bud, blunt crops already made once — see if they're
  still in the sandbox, or re-crop from her original uploaded image) if
  she wants a more thorough visual pass.
- Real per-strain terpene/effect accuracy is inherently a research
  bottleneck, not a data-availability one at this point — there's no
  shortcut dataset that removes the need to verify each strain by hand.

## Style/communication notes for working with Alissa

- She's detail-oriented and will screenshot terminal errors, broken UI, or
  anything that looks off — always actually investigate (fetch the live
  site, compare file hashes/sizes) rather than assuming a fix worked.
- She cares a lot about honesty over polish — has explicitly pushed back
  on placeholder/demo content multiple times as the app has gone from
  concept to something real people use. Default to "real data or an
  honest empty state," never fabricated content, even for THC/potency
  numbers (a cannabis app giving made-up potency data is a real harm, not
  just a lazy shortcut).
- Enjoys playful copy (the "Light Up" / "Nug It In" pun brainstorming, the
  cartoon-leaf kudos icon) — worth leaning into when the moment calls for
  it, but keep functional copy (dosing warnings, safety notes) fully clear
  and un-punny.
- Prefers being given a short menu of concrete options (via the
  `ask_user_input_v0` tool) over open-ended "what do you want?" questions,
  especially for visual/creative decisions.
