# StrainDex Strain Name/Data Research Log

Purpose: track candidate strain-name sources found so far, what's actually
usable in each, and what's queued up for future batches.

## Research methodology: multi-version / ambiguous-lineage strains

Applies whenever independent sources report *different* parentage for the
same strain name — extremely common for popular/generic names (fruit names,
color names, single-word names) that multiple unrelated breeders have all
used at some point. This is not the same problem as "no one knows the
parents" (a single strain with a genuinely undocumented lineage) — it's
"multiple different strains happen to share this name."

**The rule: use it if 2+ independent sources agree on the same specific
cross, even when other unrelated cuts exist under the same name. Skip it
if no single version clears that bar.**

- "Independent" means separate publishers, not two articles quoting the
  same original press release — e.g. Leafly and Weedmaps both stating the
  same breeder + parents independently counts; two SEO-farm articles that
  are clearly the same syndicated content do not.
- A specific parent-strain pairing (e.g. "Gelato #33 x 1991 Triangle Kush")
  counts as convergence. A vague shared theme (e.g. "some kind of OG
  Kush descendant") does not — that's just everyone agreeing the name
  sounds like an OG, not confirmation of an actual cross.
- If breeder attribution is disputed but the *parents* are consistent
  across sources, use the parents and either state the most-cited breeder
  or leave breeder blank — don't let breeder-name disagreement alone sink
  an otherwise well-corroborated cross.
- When a genuine winner emerges among several named versions (e.g. one
  cut is explicitly the origin and the "well known"/most documented cut,
  or is a well known/named breeder collaboration), use that version and
  note in the entry's flavor/effects that other cuts exist under the same
  name, rather than trying to average conflicting data together.

**Worked examples from actual research (for calibration):**
- *Used, multi-version but convergent*: Jungle Juice (3+ sources agree on
  Golden State Genetics' Animal Cookies x Tangie, despite at least two
  other unrelated "Jungle Juice" cuts existing), Tire Fire (Archive Seed
  Bank's Hi-Octane x Do-Si-Dos is far more documented than the other
  Weedmaps-acknowledged version), Wild Cherry, Kiwi Kush, Unicorn Piss,
  Tropical Punch, Bob Marley (genuinely unattributed lineage across every
  source, but the sensory profile itself was still consistent enough to
  document honestly as "breeder/parents unconfirmed").
- *Skipped, no convergence*: Pomegranate, Midnight, Paloma, Lucky, Boss —
  see "Unconfirmed / skipped strains" below for specifics on each.

**Practical note**: don't spend more than 2-3 searches trying to resolve
a name past this point — if the first couple of searches show 3+ clearly
unrelated confirmed crosses with no majority, it's faster and more honest
to log it as skipped (see below) than to keep digging for a tiebreaker
that may not exist.

## Source 1 — openthc/vdb (GPL-3.0)
GitHub: github.com/openthc/vdb — a purpose-built, community-submitted
directory of strain *names only* (no descriptions, effects, or potency
data). Explicitly published so other cannabis software can reuse it.

- Pulled: 12,804 total names, 11,175 not already in our library after
  filtering junk/duplicates.
- Quality: names only — real research still required per strain before
  writing an entry. Quality varies (from famous strains to obscure local
  one-off submissions).
- Status: saved, partially used (Lamb's Bread turned out to be a dupe,
  Blackwater OG added). ~11,100 names still unused.

## Source 2 — Kushy Cannabis Dataset (MIT license)
GitHub: github.com/kushyapp/cannabis-dataset — a much richer schema
(name, type, description, effects, flavor, crosses, cannabinoid %s), but
in practice mostly sparse:

- Pulled: 9,524 total strains, 7,951 not already in our library.
- **Type (Indica/Sativa/Hybrid) is well-populated: 7,928 of the 7,951 new
  names have it.** This is genuinely useful — it means future batches
  from this list don't need to research type from scratch, just THC
  range, terpenes, effects, and flavor.
- **Descriptions are essentially absent** — only 1 of 9,524 rows has a
  real description. Not a usable source for written content.
- **Effects/flavor are only populated for 4 of the new candidates** —
  not a meaningful bulk source, though those 4 are usable as-is.
- **THC/cannabinoid numeric fields are unreliable** — values are
  inconsistently scaled (appear to be percentage × 100, e.g. "1500"
  probably means 15%) and one value (127, likely meaning ~1.27%) repeats
  suspiciously often (157 times) in a way that looks like a leftover
  default/placeholder rather than 157 real identical measurements.
  **Recommendation: don't trust this field at all; research THC
  independently per strain the way we've been doing.**
- Status: saved (name + type + whatever effects/flavor/crosses exist) to
  a local candidate list, not yet used in a batch.

## Source 3 — Cannlytics Lab Results (CC BY 4.0)
Hugging Face: huggingface.co/datasets/cannlytics/cannabis_results — real
lab-tested COA (Certificate of Analysis) data across 14 states, with a
`strain_name` field and genuine measured `total_thc`/`total_cbd`/
`total_terpenes` values. Far more scientifically grounded than any
"guessed" figure, since these are real test results, not marketing copy.

- Not yet pulled — 6.28GB total, requires Python + the `datasets` library
  rather than a simple file download. In progress: Alissa is running a
  local pull script starting with the smallest state (NY, ~330 records)
  before scaling to a bigger one.
- Once pulled: this is the best candidate for *upgrading accuracy* of
  THC/CBD/terpene numbers on strains already in the library, not just
  adding new names.

---

## Up next
- Combine the openthc/vdb name list with Kushy's type-tagged list where
  they overlap, to prioritize names with at least a Type already known.
- Once Cannlytics NY data lands, check how many rows have a `strain_name`
  that matches something already in the library, as a first real-data
  accuracy check.

---

## Real lab-data validation (Cannlytics NY results, first batch)

Alissa successfully pulled `data/ny/ny-results-latest.csv` directly from
the Cannlytics dataset repo (330 real lab-tested cannabis products in
New York). Note: this file does **not** have a clean `strain_name`
column despite the dataset card describing one — strain names have to
be matched by searching within `product_name` text instead (e.g.
"Apple Fritter - .5g Disposable Vape").

**Method:** cross-referenced our strain library's names against
`product_name`, restricted to flower/preroll product types only
(concentrates and vape carts test 3-4x higher than flower for the same
strain, since they're extracted/concentrated — comparing those against
our flower-based THC ranges would be misleading).

**Result: found and fixed 2 confirmed bad entries.**
- Green Crack was listed as 1–6% THC. Real lab tests: 17.07–23.06%.
  Fixed to 15–25%.
- Diesel was listed as 1–6% THC. Real lab tests: 19.39–21.62%.
  Fixed to 15–21%.

**Most other matches confirmed our existing estimates were accurate**
(Gelato, Gary Payton, Hash Burger, Tropicana Cookies, Slurricane,
Jealousy, Durban Poison, Apple Fritter all landed within or very close
to our stated ranges).

**Bigger finding: 75 strains in the library (mostly from the original
pre-existing starter dataset, not from any batch added during this
project) share the exact same "1–6%" THC value.** This is almost
certainly a leftover placeholder/default from however the original
1,500-strain seed data was built, the same bug pattern caught in Green
Crack and Diesel above. Important caveat: **not all 75 are necessarily
wrong** — a few (like ACDC) are genuinely real high-CBD, low-THC
strains where 1–6% is accurate. Each one needs individual verification
before changing it, the same way Green Crack and Diesel were confirmed
with real lab data before fixing. Full list saved for future batches.

**Up next:** work through the 75-strain "1–6%" suspect list a batch at
a time, verifying each individually (real research or more Cannlytics
state pulls) before correcting. Also worth pulling a bigger state next
(e.g. `ca` or `wa`) now that the direct-CSV-download approach is
confirmed working, for a larger validation sample.

---

## Real lab-data validation (Cannlytics CA results, second batch)

Alissa pulled `data/ca/ca-results-latest.csv` (71,000+ real lab-tested
products) directly from the repo — file was 1.59GB, too large to
upload, so we wrote a script to strip out the heavy per-compound
`results` column and keep just the summary fields, bringing it down to
~9MB (85,487 rows) as `ca-results-slim.csv`.

**Method:** same as the NY batch — flower/preroll product types only,
excluding concentrates/infused/resin (which test 3-4x higher for the
same strain since they're extracted). Also filtered out physically
impossible THC values (some rows showed 100%+, even 300%+ — clearly a
data quality issue in the source file itself, not real measurements).
Required at least 8 real samples per strain before drawing any
conclusion.

**Results, out of 128 strains with enough samples to check:**
- **96 confirmed accurate** — real median THC fell right within what
  we already had. Good validation of the earlier research work.
- **32 strains updated** to real current-market ranges (25th-75th
  percentile of actual lab results), since Alissa's call was to reflect
  current real data rather than older "classic" reference ranges. This
  mostly pushed ranges up by 8-15 points (e.g. Diesel 15–21% → 25–28%,
  Headband 12–20% → 32–35%) — consistent with the well-documented
  industry-wide potency increase over the past decade, not a sign the
  old numbers were "wrong," just dated.
- **1 real outlier investigated individually: Space Queen.** Real CA
  data showed a suspiciously low 8.1% median (n=12), while every
  independent published source (Strainpedia, Leafly, Hytiva, StrainHub)
  consistently cites 15-22%. Traced the anomaly to hemp-derived
  "Space Queen" products (<0.3% THC by law) being sold under the same
  name and polluting the product-name match. Adjusted our own figure
  slightly (23–27% → 16–22%) to align with the well-corroborated
  published consensus — did not use either the real-data anomaly or
  the original figure as-is.

**Also fixed from the earlier NY batch:** Green Crack (1–6% → 15–25%)
and Diesel (1–6% → then further updated to 25–28% with the larger CA
sample above).

**Lesson for future batches:** raw "real lab data" isn't automatically
more trustworthy than researched estimates — it still needs the same
scrutiny (physically impossible values, product-type mismatches,
mislabeled/hemp variants polluting name matches). Real data is best
used to *cross-check* research, not replace judgment.

## Up next
- 74 of the original 75 "1–6% THC" suspects are still unverified
  (Green Crack and Diesel are now fixed). Continue working through that
  list a batch at a time.
- Consider pulling one more state (WA has the largest sample at
  202,812 records) for a broader validation pass once useful.

---

## Unconfirmed / skipped strains (revisit later)

Names pulled from the Weedmaps directory audit's "missing strain" lists
that were researched but **not added**, per the multi-version methodology
above. Logged here so future sessions don't burn searches re-discovering
the same dead ends — check this list before re-researching a name below.
Each entry can be revisited if a future search turns up a breeder
publishing an official lineage, or a second independent source starts
agreeing with one of the versions already found.

- **Pomegranate** (plain name) — no data exists for the plain name itself.
  Only unrelated *named variants* are documented: Pomegranate Shake
  (Weedmaps confirms this itself is two different crosses), Black
  Pomegranate (Massive Seeds), Purple Pomegranate, Berry Pomegranate.
  None of these establish anything about a plain "Pomegranate."
- **Midnight** (plain name) — at least 3 unrelated confirmed cultivars:
  Tikun Olam's secret-formula medical strain (CBD-dominant, Israel),
  3rd Coast Genetics' indica-leaning cut (parents undisclosed), and an
  "unknown combination" per AllBud. No convergence between any two.
- **Paloma** (plain name) — at least 4 unrelated confirmed crosses:
  1937 Farms/Raw Genetics' "Cherry Paloma" (Tropicanna Cherries x
  Georgia Pie), Green Dot Labs' (Pirate Milk x ROYGBIV Red), Symbiotic
  Genetics' (Grapefruit x Durban Poison), Weedys' (Grapefruit Fly x
  Durban Poison). Four different specific crosses, no majority.
- **Lucky** (plain name) — no confirmable lineage at all. Weedmaps'
  own strain page explicitly states they're "still gathering
  information." The one other result found (GrowDiaries) appears to be
  a data/content mismatch — it describes Bodhi Seeds' "Ice Cream Cake"
  genetics under a page titled "Lucky," which reads like a template or
  indexing error rather than real data about a strain called Lucky.
- **Boss** (plain name) — even the closest-matching named version,
  "Boss OG," has 3 conflicting confirmed parentages across sources:
  OG Kush x Fire OG, Dark Heart Nursery's backcrossed OG Kush phenotype
  (no named second parent), and OG Kush x Strawberry Diesel. No majority
  among the three, and the plain "Boss" (without "OG") wasn't confirmably
  distinguished from "Boss OG" in any source, adding another layer of
  ambiguity on top of the parentage conflict itself.

---

## Rules added 2026-10-19 (Alissa)
- **Speed never influences research integrity.** Never bulk search. Every strain name is searched on its own, and each source is fetched and read separately.
- **If a finding helps another entry, fix that entry too** (and report it). Goal: as much corroborated information per strain as possible.
- Only write a value when 2+ independent sources agree. Single-source facts are logged and held back, not written.
- Terpene *names* are held back for now (see open question below); never write percentages that are not real measurements.

## Batch 1 — s7269 to s7273 (2026-10-19)
Changes ship as blank-fills via seed.js plus compare-and-set migration `strain_research_batch1_2026_10_19`.
- **s7269 Red Velvet Runtz**: breeder LIT Farms; THC 15–31% -> 28–31% (AllBud header 31%, Weedmaps 30.7%, LAX 28.1%); effects, flavor, ailments added; parents/type confirmed by 7 sources.
- **s7270 Redneck Wedding**: breeder Surfr Seeds; THC 22–29%; effects Relaxed/Giggly/Uplifted; flavor; ailment Anxiety. Parents confirmed (AllBud, SeedFinder, Surfr, Weedmaps, Cropking). Rejected: jointcommerce blog (self-contradicting).
- **s7271 Reina Madre (aka Queen Mother)**: breeder Delicatessen Seeds; parents La Reunion x Congo #1 (AllBud, SeedFinder, Cannapedia, Strainpedia agree in substance); THC 17–18% -> 17–22%; effects/flavor added. Conflicting versions NOT used: Mexican sativa parent (marijuanaseeds), Spanish landrace x (Jack Herer x Black Domina) (PiffinTen).
- **s7272 Reunion OG**: breeder Skunk House Genetics (SeedFinder; single source); parents confirmed (AllBud + SeedFinder). Effects/flavor/ailments HELD (AllBud only).
- **s7273 Ripped Bubba**: CBD 0–2%; effects Creative/Relaxed; flavor; ailments Stress/Pain. THC HELD BLANK (Leafly 16%, AllBud 22–26% [maybe parent's], BC retail 28–32%). Breeder kept as "TGA Seeds" (library convention).

### Unconfirmed / held back
- Terpenes for all five (names corroborated for some, but storage convention undecided).
- Ailments "Depression" (s7270, s7273), "Cramps" (s7270), "Migraines/Headaches" (s7271): not written pending Alissa's decision.
- Reunion OG effects/flavor; Ripped Bubba THC.

### Follow-ups applied 2026-10-19 (Alissa approved)
- Ailments Depression/Cramps/Migraines now written: s7270 Anxiety+Depression+Cramps, s7273 Stress+Pain+Depression, s7271 Migraines (AllBud+Cannapedia). "Headaches" for Reina Madre held (AllBud only). Ripped Bubba Headaches NOT added (Leafly lists it as a negative effect). Strain pages show an asterisk + "not medical advice" note beside "Users report relief from".
- New library entry **s7341 La Reunion** (sativa landrace; aka La Reunion Sativa). Sources: SeedFinder, Cannapot x2, Leafly (Zamaldelica). THC/flavor held (data only exists for Mangu Karot/Zamal products). Library K1 (s4801) is a different strain from French Touch's K1.
- Open: add "Zamal" entry (parent of Zamaldelica s6440); reconcile Congo #1 vs Congo s900.

### Terpene convention + open items closed (2026-10-19)
- **Terpene convention (Alissa approved):** terps are stored as ranked names; a % is displayed only when the entry carries `m:true` (real lab measurement; admin form accepts "Name:Percent" for that). All 2,818 existing terpene lists use rank-style weights (120 distinct patterns, none look measured), so they now show names only. `p` stays as an internal rank weight for sorting/recommendations.
- Terpene names written: s7269 Caryophyllene, Limonene, Linalool; s7271 Terpinolene, Myrcene, Pinene; s7273 Myrcene. Held: s7270 (Leafly only), s7272 (no sources).
- **Congo #1:** SeedFinder identifies it as ACE Seeds' Congo [pheno #1] (Bangi Congo x (Kongo #3 x Chitral)). Library only has generic Congo (s900), so Reina Madre's parent is recorded as "Congo" (migration corrects it if "Congo #1" was already live).
- **s7342 Zamal** added (sativa landrace of La Reunion; Energetic/Uplifted; mango+carrot flavor). THC held (25% is one breeder's claim for Mangu' Karot). Zamaldelica (s6440) parent now resolves.

### Cross-check fixes from the s7270 flags (2026-10-19)
- **Trophy Wife (s2067)** parents ["Triangle Mints","Triangle Mints F2"] -> ["Triangle Mints"]. SeedFinder genealogy + Surfr Seeds both describe it as Triangle Mints F2 (Triangle Mints x Triangle Mints); "F2" is the generation, not a second parent. Triangle Mints (Seed Junky) = Triangle Kush x Animal Mints, matching the library's Wedding Cake (s9) / "Triangle Mints" alias. AllBud's "The Wife x Cherry Wine, THC 1-10%" page was rejected (hemp lookalike).
- **GMO (s1535)** Chemdawg x Girl Scout Cookies: CONFIRMED (Leafly, AllBud; SeedFinder is Chem D x Forum GSC cut, consistent). No change.

### Mangu' Karot / Mango Pepper (2026-10-19)
- **s7343 Mangu' Karot** (French Touch Seeds): "also known as Zamal" per SeedFinder, Cannapot and a retailer page; SeedFinder tree = Sativa > La Reunion > Zamal > Mangu Karot, so parents ["Zamal"] and Zamal (s7342) now has parents ["La Reunion"]. Effects Energetic/Uplifted; flavor mango + light carrot. THC HELD: 25% / 25-30% appears only in retailer copy of the breeder's own claim. Flowering conflicts (8-10 wk header vs 100-130 days) so not recorded.
- **s7344 Mango Pepper** (French Touch Seeds; bred by Bourbon): Mangu' Karot x Mauve Poivree (Mafate line), confirmed by SeedFinder, a retailer, Alchimia, OA Seeds. Effects Energetic/Uplifted; flavor spicy/peppery with fruity notes. THC HELD (20-25% single retailer claim).
- **Mauve Poivree** not added as its own entry: no standalone data exists beyond "a La Reunion landrace line".
- Note: all source text here is breeder-derived (no user reports exist), so these entries are only as good as French Touch's own description.

## Batch 2 — s7274 to s7278 (2026-10-19)
Each strain searched and read separately; blank-fills only (no migration needed).
- **s7274 Ripper Haze**: parents ["Amnesia Haze"] (a selection of the 2002 original: SeedFinder, Zamnesia, GrowDiaries, retailer); flavor citrus/lemon. Held: THC 22% / CBD 0.1% (GrowDiaries only), terps (Zamnesia only), effects, awards.
- **s7275 Road Kill Skunk**: effects Relaxed/Happy/Sleepy; flavor skunk/diesel/earthy. Parents (Afghanica x Skunk #1), breeder CannaVenture, indica-leaning confirmed (Leafly + SeedFinder). Held: ailments, coffee/ammonia notes.
- **s7276 Root Beer Float**: CBD 0-1%; terps [Limonene] (only terpene two sources share); flavor root beer + vanilla. Parents confirmed (Leafly, OCS, BC). Breeder left blank (Leafly: unknown; Bold Growth is only the producer). THC held: Leafly 19% vs one producer's 30-36%.
- **s7277 Ros'e**: no changes; parents Do-Si-Dos x Unicorn confirmed (SeedFinder + Neptune). No THC/effects data exists beyond the breeder's own text.
- **s7278 Rozé**: terps [Myrcene]; flavor sweet floral/rose. Parents Zkittlez confirmed (SeedFinder + Leafly). Held: THC 21% (Leafly), effects, lean (sources conflict), Emerald Cup 2017 award (single source).
- Cross-checks: Hippy Slayer (s4673), Root Beer Cream Cake (s5687), Sundae Float (s6037), Toxic (s6189), Velvet Roze (s6307), California Black Roze (s3562) all match their sources. SeedFinder-listed Purple Roze / Banana Roze / Lemon Roze are not in the library (not added; no data gathered yet).

## Roze family additions (2026-10-19): s7345-s7347
- **s7345 Purple Roze** (Ethos Genetics): Purple Punch x Roze (Leafly, SeedFinder, AllBud); effects Euphoric/Relaxed; flavor sweet floral, earthy. Held: lean, THC (20% vs 14-19%), terps, ailments.
- **s7346 Banana Roze**: UNCONFIRMED LINEAGE. Leafly = Banana Pudding x Roze (Dying Breed Seeds); SeedFinder = Banana OG (Orgn Kid's Banana Kush) x The Real Roze (South Bay Genetics). One source each, so no parents or breeder recorded. Only type (Hybrid) and banana flavor are agreed.
- **s7347 Lemon Roze** (Dying Breed Seeds): Roze x (Lemonade x Oz Kush) (Leafly + SeedFinder). All Leafly-only data (60/40 sativa lean, THC 18-22%, limonene, effects, flavor) held.
- Not added: Hollywood Roze, Royal Rainbowz (South Bay Genetics), The Real Roze (Emerald Mountain), Banana Pudding, Halle Berry x Lemon Roze.

## Batch 3 — s7279 to s7283 (2026-10-19)
Blank-fills only (no migration needed).
- **s7279 Samoas**: effects Relaxed/Happy/Creative; flavor chocolate-mint cookie + skunky nutty kush funk; ailments Stress, Depression. Parents (Forum Cut GSC x Face Off OG BX1) and Archive Seed Bank confirmed. THC 27% kept (AllBud ~27%; Leafly avg 19%). Held: CBD, terps, lean (balanced 50/50), eye pressure/migraine ailments.
- **s7280 SFV OG**: THC 17-22%; effects Focused/Relaxed/Happy; flavor lemon, pine, earthy, woody; ailments Stress, Pain, Anxiety. Parent OG Kush and The Cali Connection confirmed. Lean blank (Leafly sativa-dominant vs AllBud 70% indica). Consistent with s144 SFV OG Kush (SFV OG x Afghani).
- **s7281 Scott's OG**: breeder Rare Dankness Seeds (Leafly, SeedFinder, retailer); effects Relaxed/Sleepy; flavor lemon + earthy kush. THC 23-28% kept. Held: ailments, terps, award.
- **s7282 Secret Recipe (aka Secret OG)**: THC 20-24%; effects Creative/Relaxed; flavor fruity pine, sweet diesel; ailments Stress, Pain, Depression. Parents confirmed (Leafly + AllBud x2). Breeder "Connoisseur Genetics" HELD (Leafly only; Growers Notebook copies Leafly).
- **s7283 Sensiburn OG**: breeder Covert Genetics (SeedFinder only, flagged). Only two sources exist (AllBud, SeedFinder); effects/flavor/ailments held.
- Not in library (SeedFinder/Leafly descendants, not added): MBH Motorbreath, Log Larry OG, Siren Song, Riff OG, Gizmo OG, Klingon Kandy, Mem Mean Misty, Black Scott's OG.

## Batch 4 — s7284 to s7288 (2026-10-19)
Blank-fills only (no migration needed).
- **s7284 Shangri-La** (JinxProof): parents Fudo Myo-o x 9 Pound Hammer confirmed (Leafly + Maven Genetics text); effects Energetic/Uplifted; flavor earthy, citrus, sweet. Held: THC (Leafly 17% vs Maven 30%), terps (Leafly only), ailments (Leafly only), lean (60/40 sativa vs "indica-dominant").
- **s7285 Sherb Crasher** (Seed Junky): parents + breeder confirmed (SeedFinder, GrowDiaries, Leafly product). No changes. Held: THC (23% vs 25%), CBD, limonene, effects, lean (sources conflict).
- **s7286 Silver Buddha Haze**: parents Super Silver Haze x Super Lemon Haze confirmed (AllBud + SeedFinder). Breeder Sumo Seeds held (SeedFinder only; AllBud silent). Effects/ailments held (AllBud only).
- **s7287 Skystomper**: flavor sweet grape (Leafly + SeedFinder/breeder text). Parents Stomper F4 x Skywalker F4 confirmed (Leafly, GrowDiaries); SeedFinder spells it "Sour Stomper F4" so left as is. THC 16% (Leafly) fits existing range. Held: effects/ailments (Leafly = 7 reports; no overlap).
- **s7288 Slimer OG**: effects Euphoric/Creative/Relaxed; ailments Stress, Depression (Leafly + AllBud). Parents confirmed. Breeder NOT recorded: multiple versions exist (Greenlife Seeds US, Green Gene, Twisty, Lost River). Flavors did not overlap.
- Already in library: Dayglow (s3915, Slimer OG offspring), Amnesia Ganja Haze (s3081, Silver Buddha Haze offspring).
- Not in library (added to sheet): Wedding Sunset, Sunset Bride, Peanut Butter Crashers, GMO x Sherb Crasher, Orange Cookies x Sherb Crasher.

## Batch 5 — s7289 to s7293 (2026-10-19)
Blank-fills only (no migration needed).
- **s7289 Sorbetto** (Aficionado): parents + breeder confirmed (Leafly, AllBud, SeedFinder "The Original Z"). Effects Relaxed; flavor lemon + honey. Held: THC (19% vs 17-23%), lean (AllBud 60/40 indica only), terps (Leafly only), ailments (Leafly: anxiety/inflammation/stress; AllBud: pain, glaucoma, inflammation, etc. - only inflammation overlaps and it is not in the standard list).
- **s7290 Sonic Fly** (Mosca): flavor fruity pineapple (AllBud + SeedFinder). Parents undisclosed ("Unknown Hybrid" both sources). Indica-leaning already agrees. Held: THC 20% (AllBud only), effects, ailments.
- **s7291 Sour Garlic (Sour Garlic Bud, Mosca)**: parents AJ's Sour Diesel x GMO Fuel confirmed (Mosca + Irish Seed Bank); flavor pungent sour garlic/diesel/earthy. Held: lean (breeder label + retailer copy), effects, flowering. Leafly "Illicit Sour Garlic" is a different (GMO) product and was not used.
- **s7292 Star Pebbles**: effects Creative/Happy/Uplifted; flavor sweet berry; ailments Stress, Depression, Nausea (Leafly + AllBud). Parents Fruity Pebbles OG x Stardawg confirmed (Leafly, AllBud, SeedFinder). Held: breeder Capulator (SeedFinder only; Leafly shows retailer CRU), THC (24% vs 24-32%), terps (Leafly only), lean (both sources self-conflict).
- **s7293 Studio 54 (RS54)**: breeder DEO Farms confirmed. Effects Creative/Relaxed; flavor tropical fruity; ailments Depression. Parents left as library has them: sources agree on Sunset Sherbet but name the other parent as Pink Guava, OZ Kush #54 or "Pink Guava OZ Kush" (same cut, different names). Held: THC (18-22, 31, 35%), terps, lean.
- Not in library/not added: none new (Bellini, Velato etc. are SeedFinder Sorbetto relatives, not researched).

## Batch 6 — s7294 to s7298 (2026-10-19)
Blank-fills only (no migration needed), plus one lean.
- **s7294 Strawberry Pie** (Raw Genetics): parents + breeder confirmed (Leafly, SeedFinder, GrowDiaries). Terps [Caryophyllene] (Leafly + GrowDiaries); flavor sweet strawberry; ailments Anxiety, Pain. Held: THC (26% vs 16%), lean (indica-dominant vs balanced), effects (no overlap between Leafly and GrowDiaries).
- **s7295 Styrofoam Cup (MSG)**: parents GMO x Sunset Sherbet, breeder Cannarado, aka MSG all confirmed (Leafly x2, GrowDiaries). Lean Indica-leaning (Leafly + GrowDiaries); effects Energetic/Creative; flavor citrus; ailments Anxiety, Stress, Depression, Pain. Held: THC (18/24/25%), terps (Caryophyllene is Leafly-only, both pages), cheese/garlic flavors (Leafly only). Note Leafly's two pages for this strain disagree on effects.
- **s7296 Strawberry Banana Cream (Karma Genetics)**: NAME MISMATCH. SeedFinder lists the Karma Genetics strain as "Strawbanana Cream" (aka Straw Banana Cream), Strawberry Banana (Reserva Privada) x White OG V2.0, a 2014 freebie. Only SeedFinder (single source), so no parents/aka written. A different "Strawberry Banana Cream" exists from Copycat Genetix.
- **s7297 Sour Hound** (Mephisto): parents Sour Crack x Chemdogging confirmed (SeedFinder + GrowDiaries description). Held: flavor (GrowDiaries only), lean (reviewer opinion).
- **s7298 Strawberry Cola Auto** (Exotic Seed): parents confirmed (SeedFinder + Zamnesia); indica-dominant already agrees. Effects Relaxed; flavor sweet red fruit and cola (both breeder-derived; no user data exists). Held: Ocimene (Zamnesia only), THC.
- Relatives already in library: Georgia Pie s1630, Guava Pie s4609, Sour Crack s5882, Chemdogging s6926, Monster Mash s5198, White OG s580, Strawberry Banana s1544.
- Not in library (added to sheet): Cherry Cola Auto RF3, Vanilla Fizz, Mango Cream Auto, Strawbanana Cream, Strawnana Wifi.

## Batch 7 — s7299 to s7303 (2026-10-19)
Blank-fills only (no migration needed).
- **s7299 Sour Lemon Haze** (Cannabella): only SeedFinder has data (Super Lemon Haze x Pineapple Gold F1, regular seeds, mostly sativa, ~50-60 day flower, lemon/pine). Single source, so NOTHING written. Not to be confused with Cannabella's Super Sour Lemon Haze.
- **s7300 Sour StrawburieD** (Twenty20 Mendocino): parents (Sour Diesel x Strawberry Kush) and breeder confirmed (Leafly, AllBud, SeedFinder). Effects Happy/Uplifted; flavor citrus + fruity. Held: THC 19-20% (AllBud only), ailments (Leafly = one reader), lean 60/40 indica (AllBud only; existing Indica-dominant left), terps.
- **s7301 Star Pupil** (Mass Medical Strains): breeder confirmed (GrowDiaries + Leafly). Effects Energetic; flavor grape/berry/floral; ailments Stress. Held: parents (Leafly "supposed Afghani x Thai"; GrowDiaries lists Thai/Afghan/Pakistan landraces - not a clean match), THC (21% vs 18%), terps (Leafly: Myrcene, Limonene, Linalool, single), lean. PuTang (s7010) already lists Star Pupil as a parent.
- **s7302 Stardawg IX** (Top Dawg): only SeedFinder (Stardawg Corey Haim F x Stardawg M, mostly indica). Single source, nothing written.
- **s7303 Starfighter F2** (Exotic Genetix): SeedFinder says F2 of Alien Genetics' Starfighter (indica-dominant); Leafly describes the original Starfighter only and does not mention F2. Nothing written. Cross-check: library Starfighter s6750 (Alien Tahoe OG x Lemon Alien Dawg, Alien Genetics, Indica-dominant) matches Leafly.
- Not in library (to add to sheet): Prayer Pupil, Super Sour Lemon Haze, Sour Amnesia Haze, Ave, Strawberry Biscotti Auto, ZOgreberry, Pineapple Gold, Tahoe Alien.

## Batch 8 — s7304 to s7308 (2026-10-20)
Blank-fills only (no migration needed).
- **s7304 Stir Fry**: parents GMO x Orange Cookies confirmed (Leafly + AllBud). THC 26-27% (Leafly 26.5%, AllBud 26-27%); effects Happy/Uplifted; ailments Depression. Breeder unknown on both. Held: flavor (sage vs citrus, no overlap), terps (Leafly only), lean (both say 50/50 so left blank).
- **s7305 Strawberry Cadillac** (Lovin' in Her Eyes): parents Pearl Cadillac x Dreamers Disease (Blue Bubba x Strawberry OG) from SeedFinder + GrowDiaries; flavor strawberry and plum. Dreamers Disease is not in the library (added to sheet). Held: THC 22% / sativa lean / caryophyllene (GrowDiaries only).
- **s7306 Strawberry Fritter** (Raw Genetics): parents Apple Fritter x Strawberries and Cream (F2) (SeedFinder + GrowDiaries). Held: everything else is GrowDiaries only (THC 20%, caryophyllene, effects, flavor, anxiety/depression/stress). A Raw Genetics seed-shop URL redirected to an unrelated domain and was not used. Jointcommerce blog is generic and unsourced; ignored.
- **s7307 Strawberry OG** (The Cali Connection): parents Bruce Banner #3 x SFV OG and breeder confirmed (SeedFinder + GrowDiaries). Flavor strawberry with tart citrus. Held: lean (SeedFinder mostly sativa vs GrowDiaries indica-dominant), THC (23% / 17-25%), effects, ailments (GrowDiaries only).
- **s7308 Strawberry Stardawg** (Holy Smoke): parents + breeder confirmed (SeedFinder, GrowDiaries). Flavor strawberry. Held: effects (both pages just quote the breeder), THC, lean (no source states one).
- Not in library (to add to sheet): Dreamers Disease, Strawberries and Cream F2 is covered by s1950; Rainbow Berries, Runtz Berries, Strawberry Cherry Gelato, Strawberry Pancakes, Strawberry Strudel, Stuffed Strawberries, Zlushiez, Barry Payton (Raw Genetics descendants of Strawberry Fritter, SeedFinder).

## Batch 9 — s7309 to s7313 (2026-10-20)
Blank-fills only (no migration needed).
- **s7309 Strawberry Milk** (Bodhi): parents Nepali OG x Instant Karma (SeedFinder: male Bubba D = Instant Karma; AllBud) and breeder (SeedFinder, GrowDiaries) confirmed. Effects Euphoric/Uplifted/Focused; flavor sweet strawberry; ailments Depression, Pain (AllBud + GrowDiaries). Held: THC (24-28% vs up to 26%), lean (50/50), terps.
- **s7310 Strawberry Milkshake**: parents Strawberry Soda x White Fire Alien OG confirmed (Leafly + AllBud). Effects Relaxed/Happy; flavor strawberry + berry; ailments Stress, Depression. No breeder on either source. Held: THC (Leafly = one reviewer's batch, 24.9%, vs AllBud 15-20%), lean (both say balanced), terps.
- **s7311 Street Guru** (Purple City): ONLY SeedFinder has data (Gush Mints x Oreoz, ~60/40 indica, 23-27% THC, all breeder claims). Single source, nothing written.
- **s7312 French Toast** (Archive Seed Bank): parents Paris OG x Face Off OG confirmed (Leafly + OCS "BX2" listing); indica-dominant agrees. Held: terps (Myrcene/Caryophyllene/Limonene appear in both Leafly and a producer COA, but ranking is Leafly-only), THC (16% vs 28-32%), effects/flavor/ailments (Leafly only). FLAG: SeedFinder lists Archive Seed Bank's French Toast as Paris OG x Face On Fire, and lists "Stuffed French Toast" as a SEPARATE Raw Genetics strain (Paris OG x Cookies & Cream). Leafly calls French Toast "also Stuffed French Toast", which is what the library aka uses. That aka may conflate two strains; not changed (needs more evidence).
- **s7313 Sugaree** (Head Seeds): ONLY SeedFinder (Cinderella 99 x ECSD v3, mostly sativa, grapefruit; breeder claims only). Single source, nothing written.
- Not in library (to add to sheet): Face On Fire, Formula One, Stuffed French Toast (Raw Genetics), Strawberry Soda (if missing).

## Batch 10 — s7314 to s7318 (2026-10-20)
Blank-fills only (no migration needed).
- **s7314 Sunset MAC**: effects Creative/Focused; flavor citrus + grapefruit; ailments Anxiety, Depression, Stress (Leafly + AllBud). Held: THC (17% vs 17-29%), terps (Leafly inconsistent), lean (Leafly indica-dominant vs AllBud 50/50; existing Indica-dominant left). FLAGS: (1) Leafly credits Qwest Reserve as breeder, library says Capulator (unchanged, single-source conflict). (2) Library parent "Sunset" does not resolve to any library strain; AllBud spells the cross Alien Cookies x (Colombian x Starfighter) x Sunset Sherbet, Leafly just says "Sunset". Likely Sunset Sherbet, but not changed (would need a compare-and-set migration and a second source).
- **s7315 Secret Weapon**: parents Cheese Quake x White Widow confirmed (Leafly, AllBud, SeedFinder). Effects Creative; ailments Depression. Held: breeder Vandal Genetics (SeedFinder only), THC (17% vs 23-28%), lean, terps, flavor (no overlap).
- **s7316 Super Secret Weapon** (Fresh Coast): SeedFinder only, "lineage unknown", clone-only. Nothing written.
- **s7317 Sweat Helmet**: parents Sunset Sherbet x Grease Monkey confirmed (Leafly, AllBud, SeedFinder); Indica-dominant agrees (AllBud 80/20, SeedFinder 70/30). Effects Euphoric/Uplifted/Relaxed/Sleepy; flavor diesel + citrus; ailments Insomnia, Pain. Held: breeder Exotic Genetix (SeedFinder only), THC (21% vs 24-26%), terps (Leafly only).
- **s7318 Sweet Cherry Pie** (In House Genetics): SeedFinder only (OGKB x Black Cherry Pie, 90% indica). Nothing written.
- Relatives already in library: Cheese Quake s2336, White Widow s6, Grease Monkey s1626, Black Cherry Pie s2324, OGKB s2113, Garlic Icing s2344, Secret Cheese s5749, Undercover Butter s6276, MAC s1614.
- Not in library (to add to sheet): Secret Weapon #103, Big Pun, Odd Job, Sticky Situation.

### Follow-up (2026-10-20): Sunset MAC parents fixed
- s7314 parents ["Sunset","MAC"] -> ["Sunset Sherbet","MAC"] (user-approved). Applied to live DB via compare-and-set migration `strain_research_batch2_2026_10_20` in lib/data-migrations.js, and in data/strains.json for fresh installs. Tested: live-state sim applied 1 correction.

## Batch 11 — s7319 to s7323 (2026-10-20)
Blank-fills only (no migration needed).
- **s7319 Sweet Mendo Kush**: only AllBud has data (MBOG x Chem Valley LSD, 20-22% THC, 50/50). SeedFinder has no entry under this name; its "Sweet Chem Kush" (Bohemia Seeds) lists Sweet Mendo Kush as a parent and has conflicting lineage. Single source, nothing written. Existing parents left as is.
- **s7320 Sweet Retreat**: AllBud and a seed-shop review say the same thing (Zangria x Illmatic, 70/30 indica, 18-23% THC); the shop text appears copied from AllBud, so treated as ONE source. Nothing new written; existing parents and Indica-dominant lean agree with it.
- **s7321 Sweet Tart** (Twisty Seeds): breeder confirmed; parents Afghani x Purple Thai x ATF (Leafly + SeedFinder). Held: everything else is Leafly only (THC 24%, Myrcene/Caryophyllene/Pinene, effects, ailments); flavor does not overlap.
- **s7322 Sweets** (Karma Genetics): parents Guava Gelato x Karma Sour Diesel and breeder confirmed (Leafly, SeedFinder). Neither source states a lean, so existing Sativa-dominant is unsupported (left, flag). Effects/flavor/ailments Leafly only.
- **s7323 Tahiti Lime** (Archive Seed Bank): flavor lime (Leafly + SeedFinder). Breeder confirmed. Parents NOT changed: SeedFinder says (Dosidos x Zkittles #25) x unknown lemon-lime strain; Leafly lists Dosidos and Zkittlez. Held: THC (16% vs 26.5%), terps (Leafly self-contradicts), effects (no overlap), lean (Leafly only).
- Not in library (to add to sheet): Karma Sour Diesel, Illmatic, Sweet Mendo B.O.G, Chem Valley LSD, Sweet Chem Kush, Sweets Biker, Secret Weapon #103, Big Pun, Odd Job, Sticky Situation.

## Batch 12 — s7324 to s7328 (2026-10-20)
Blank-fills only (no migration needed).
- **s7324 Tahitian Punch**: parents (Sour Tangie x Sour Apple, SeedFinder marks Sour Apple "probably") and Sativa-dominant lean confirmed (Leafly, AllBud, SeedFinder). THC 20-21% (Leafly 20.5%, AllBud 20-21%); effects Uplifted; ailments Anxiety, Cramps, Depression. Held: flavor (no overlap), terps, breeder (none; SeedFinder lists "Unknown or Legendary").
- **s7325 Tangerine Borealis** (Bred by 42): SeedFinder only ((Northern Lights x G-13) x London Pound Cake, 75% indica). Single source, nothing written.
- **s7326 Tangie Cookie Burger** (Skunk House): breeder and parents (Han Solo Burger x Tangimal = Animal Cookies x Tangie) confirmed by SeedFinder + a retail listing; Indica-dominant matches the retail listing (70%). Effects/flavor are retail-copy only; nothing new written.
- **s7327 Tangistan**: AllBud lists 1% THC / ~17% CBD, which looks like the CBD-rich "Tangistan R4" (SeedFinder: (Dudes Diesel x Pakistani Chitral Kush) x R4), not necessarily this cross. Version ambiguity plus single source, so nothing written. Library parents match AllBud.
- **s7328 Temptation** (LIT Farms): parents and breeder confirmed (Leafly + SeedFinder). All other data is Leafly only (20% THC, caryophyllene/limonene/pinene, 50/50, effects, flavor, anxiety/stress/pain). Multiple filial versions exist (F2/F3), so nothing written.
- Not in library (to add to sheet): Satsuma Tree, Tangimal, Bazooka Burgers, Chets Freebie, Grape Boogers, Key West Dump Truck, Stoner's Delight, Whopper with Pickles, Tangistan R4, Shaolin Gleaux, Dudes Diesel.
- Possible library duplicate: Pakistani Chitral Kush exists twice (s348 and s5548); not investigated yet.

### Follow-up (2026-10-20): Purple Citral merged into Pakistani Chitral Kush
- s5548 Purple Citral carried exactly the same aliases as s348 Pakistani Chitral Kush (PCK, Purple Pakistani, Purple Chitral...), and "Citral" appears to be a misspelling of "Chitral"; user approved combining them.
- Merge pair ['s5548','s348'] added to STRAIN_MERGES (check-ins etc. move to s348; undo trail written to strain_merge_log). Alias "Purple Citral" added to s348 via compare-and-set migration `strain_research_batch3_2026_10_20`. s5548 removed from data/strains.json so seed.js cannot re-insert it. Tested on a live-state sim: s5548 gone, aka updated.
- s5548's own values (effects Relaxed/Sleepy) were not copied; s348 keeps Relaxed. Sleepy not added (single entry).
- Standing rule (user, 2026-10-20): add newly discovered names to the Discovered Candidates sheet after EVERY batch.

## Batch 13 — s7329 to s7333 (2026-10-20)
Blank-fills only (no migration needed).
- **s7329 Terpee Slurpee**: parents GMO x Orange Zkittlez confirmed (Leafly "GMOG", GrowDiaries "GMO Cookies"); Indica-dominant agrees. THC 26-27% (26% vs 27%); flavor citrus (grapefruit vs lime/lemon); ailments Pain. Held: breeder Surfr Seeds (GrowDiaries only; Leafly "unknown"), terps (Leafly limonene vs GrowDiaries myrcene), effects (no overlap).
- **s7330 Terple** (In House Genetics): parents Tropicana Cookies x Slurricane #7 and breeder confirmed (SeedFinder, GrowDiaries; GrowDiaries says "supposedly"). Lean Indica-leaning (SeedFinder "mostly indica" + GrowDiaries); flavor blueberry. Held: THC 23%, effects, ailments (GrowDiaries only).
- **s7331 Thanoz** (Dark Horse): parents Zkittlez x Bitch Slap and breeder confirmed (Leafly + SeedFinder description; SeedFinder's lineage tree says The Original Z, same plant). No change. Held: THC 24%, myrcene, 60/40 indica, effects (Leafly only).
- **s7332 Black 84** (UW Black '84): effects Relaxed; flavor berry; ailments Insomnia, Pain, Stress (Leafly + AllBud). No parents (sources only say "believed Afghani-family"). Held: THC (13% vs 22%), terps (Leafly only), breeder (none; University of Washington escape), lean (type Indica already).
- **s7333 The Bling** (Humboldt Seed Company): parents Humboldt Frost x Humboldt OG x Humboldt Gelato (SeedFinder + GrowDiaries; Leafly says "Reserve OG" instead of Humboldt OG); THC 18-19%; effects Euphoric/Focused; flavor sweet and floral with lime; ailments Depression. Held: lean (50/50 vs 75% vs indica-dominant), terps (Leafly only), Leafly's Reserve OG variant.
- Not in library (added to sheet below): Humboldt Gelato, Slurricane #7, BC Bling Cheesecake, UW, UW Purp.

## Self-added check-ins (2026-10-20)
Alissa's three self-added check-ins (Vanilla Sky, Sweet lemon gilato, Purple Pop Rocks) researched individually.
- **Purple Pop Rocks → new entry s7348.** Parents Rainbow Belts (library s1624; sources spell "Rainbow Beltz") x Permanent Marker (s1539) confirmed by AllBud, StarFire Genetix listing (seed-city), Floyd's Cannabis. Breeder StarFire Genetix (seed-city, puresativa listing title). Effects Creative (AllBud + breeder listing). Flavor sweet grape candy with berry and gas (AllBud, Floyd's, SeedsHereNow). Held: THC 30-31% (AllBud, SeedsHereNow which copies it), lean (balanced vs indica-leaning), other effects/ailments (AllBud only), terps (none shared).
- **Vanilla Sky: not added.** Name belongs to unrelated strains: Wanted Seeds (GG4 x UK Monkey, 70% sativa), Eskobar (Vanilluna x G13 Haze, balanced), AskGrowers (Blueberry x White Widow), and a Gelato-brand indica joint with no published genetics. No two sources agree. Needs the product/brand she had.
- **Sweet lemon gilato: not added.** No strain by that name found; closest is Lemon Gelato (several unrelated versions, not in library). Needs the brand/product.

## Batch 14 — s7334 to s7338 (2026-10-20)
Blank-fills only.
- **s7334 The Creature** (Beleaf Cannabis, Sativa-dominant already set): effects Euphoric/Creative (Leafly + GrowDiaries); flavor tropical with nectarine and peach (Leafly, SeedFinder, GrowDiaries); ailments Depression/Stress (Leafly + GrowDiaries). Parents unknown in all sources (left empty). Held: THC (Leafly 25 vs GrowDiaries 28), terps (Leafly myrcene only).
- **s7335 The Guice** (Exotic Genetix; parents GG4 [Leafly "Original Glue"] x Orange Valley OG already set; Leafly only, GrowDiaries lists no direct parents): THC 21–23% (Leafly 21, GrowDiaries 23); effects Euphoric (both); flavor orange and citrus; ailments Stress (both). Held: lean, terps (Leafly myrcene/limonene/caryophyllene only), other effects (Giggly/Talkative vs Creative/Relaxed), Depression (Leafly 33% vs GrowDiaries "low mood" only).
- **s7336 The Loops** (Insanity Strains; parents GDP/OG Kush/Volcano Hash confirmed by Leafly + AllBud; Indica-dominant confirmed): effects Creative/Happy/Giggly; flavor berry and grape; ailments Depression/Insomnia. Held: THC 22% (AllBud only), terps (Leafly myrcene only), Stress, Euphoric, Sleepy.
- **s7337 Tina** (Exotic Genetix; parents Constantine x Triple OG confirmed by SeedFinder + GrowDiaries; Leafly instead lists StarBud as parent, not used; Indica-dominant confirmed by all three): effects Relaxed/Euphoric/Sleepy; flavor earthy and diesel; ailments Insomnia/Anxiety/Stress. Held: THC (20–24 / 19 / 22), terps (limonene/caryophyllene order differs).
- **s7338 TK BX1** (Indica-dominant confirmed AllBud + GrowDiaries): effects Euphoric/Relaxed; flavor lemon; ailments Stress/Pain. Held: parents conflict (AllBud Triangle Kush x Triangle Larry BX1; GrowDiaries TK x Triangle Mints), breeder conflict (SeedFinder Jungle Boys; GrowDiaries Seed Junky Genetics), THC (30–33 vs 27). Existing parents/breeder left unchanged.
- Sheet: no new names. Triangle Mints (aka of Wedding Cake s9), Triangle Larry s2916, StarBud s567 and Original Glue (Gorilla Glue #4 s1518) are all already in the library.

## Batch 15 — s7339 to s7343 (2026-10-20)
Blank-fills only.
- **s7339 Topanga Canyon OG**: breeder Jungle Boys (SeedFinder + GrowDiaries); parents Topanga OG x Sweatband (AllBud, GrowDiaries, SeedFinder product text); THC 28–30% (AllBud 28–30, GrowDiaries ~29); effects Happy/Uplifted/Relaxed (AllBud + GrowDiaries); flavor sweet and woody with orange notes (AllBud, GrowDiaries, SeedFinder); ailments Depression/Pain/Stress (AllBud + GrowDiaries, pain also SeedFinder). Lean Indica-dominant left as is (SeedFinder "mostly indica", AllBud 50/50). FLAG: existing aka "91 Hollywood Pure Kush, HPK" is not supported by any source found (Leafly's Topanga OG lists only "Topanga Canyon" as aka); left unchanged, needs a migration to remove if she wants it gone. Leafly's Topanga OG page lists diesel/blueberry flavor, which conflicts; not used.
- **s7340 Triangle Wookies**: nothing written. Only AllBud has a page (Indica-dominant 70/30, TK x Wookies, THC 20–26, calming/happy/hungry/tingly, lemon/mint/pine, ailments anxiety/pain/stress); Leafly, GrowDiaries and Weedmaps pages not reachable or absent. Existing parents/lean match AllBud only.
- **s7341 La Reunion**: flavor tropical mango with herbal and spicy notes (Newsweed, Cannapot, AllBud "Zamal"). Held: THC (none), SeedFinder effects (activating/aphrodisiac/frightening, single source). Note: sources describe "Zamal" as the Creole name for the Réunion landrace family, with Mangu' Karot one "kality"; library keeps La Reunion -> Zamal -> Mangu' Karot as is.
- **s7342 Zamal**: no change. Could add Euphoric (AllBud + Newsweed "sometimes euphoric") but effects are already populated, so that needs a compare-and-set migration; held. THC 14–24% and ailments Depression/Stress/Fatigue held (AllBud only).
- **s7343 Mangu' Karot**: no change; already complete, SeedFinder/breeder text agrees (Zamal parent, Sativa, energizing/uplifting, mango and carrot).
- Sheet additions: Sweatband, Topanga OG (separate from Topanga Canyon? Leafly lists them as the same).

### Follow-up: Topanga Canyon OG alias (2026-10-20)
Alissa asked to remove "91 Hollywood Pure Kush, HPK" after confirmation. Confirmed: Hollywood Pure Kush has its own pages on Leafly, AllBud and GrowDiaries (and is in the library as LA Pure Kush s4863); no source links it to Topanga Canyon OG (Jungle Boys, Topanga x Sweatband). Removed via compare-and-set migration strain_research_batch4_2026_10_20; aka is now "Topanga OG, Topanga Canyon".

## Batch 16 — s7344 to s7347 (2026-10-20, final strains in the 72-strain set)
- **s7344 Mango Pepper**: no change; already complete (parents Mangu' Karot x Mauve Poivrée confirmed by SeedFinder + breeder retailer; spicy/peppery + fruity; stimulating/uplifting). Held: THC 20–25% (single retailer listing; a third site only estimates 16–22% from similar strains), SeedFinder lineage tree lists the second parent as "La Reunion Landrace" while its text says Mafate "Mauve Poivrée".
- **s7345 Purple Rozé → MERGED into s2414 Purple Roze** (same strain: Ethos Genetics, Purple Punch x Roze, confirmed by Leafly + AllBud). s7345 removed from strains.json and `['s7345','s2414']` added to STRAIN_MERGES; "Purple Rozé" added as aka on s2414. Held on s2414: lean (Leafly hybrid / AllBud sativa / SeedFinder mostly indica), THC (20 vs 14–19), ailments (no overlap).
- **s7346 Banana Roze**: two versions exist. Version A (Dying Breed Seeds): Banana Pudding x Roze, 60/40 indica, per Leafly + AllBud (AllBud names no breeder). Version B (South Bay Genetics, SeedFinder): Banana OG x The Real Roze, not corroborated. Wrote version A (2 sources agree): lean Indica-leaning, parents Banana Pudding/Roze, THC 20–21% (Leafly 20, AllBud 20–21), effects Euphoric/Relaxed, ailments Anxiety/Insomnia/Pain. Breeder left blank (Leafly says Dying Breed, SeedFinder says South Bay). Terps held (Leafly only).
- **s7347 Lemon Roze**: no change. Parents and breeder (Dying Breed Seeds) confirmed by Leafly + SeedFinder. Everything else (60/40 sativa, limonene, THC 18–22%, effects, ailments) is Leafly-only; AllBud and GrowDiaries have no page. Held.
- Sheet additions: Roze, Banana Pudding, The Real Roze, Mauve Poivrée (Mafate landrace).

### Follow-up: French Toast s7312 (2026-10-20, user said go ahead)
- Alias "Stuffed French Toast" REMOVED (migration strain_research_batch5_2026_10_20): only Leafly calls it an alias; AllBud has a separate Stuffed French Toast page (alternates Stuffd/Stuff'D/Stuff't) and SeedFinder lists it as a separate Raw Genetics strain (Paris OG x Cookies & Cream). Already on the sheet as a candidate.
- Filled from Leafly + AllBud (French Toast pages): effects Relaxed/Happy; flavor sweet and earthy; ailments Stress/Anxiety/Depression (AllBud lists depression under user reports). Held: THC (16% vs 24-29%), terps (Leafly only), Hungry/Giggly/Creative (no vocab or no overlap).

## Relative research: new library entries s7349–s7352 (2026-10-20)
Researched individually from the Discovered Candidates sheet (names found during batches 13–16). Fields written only where 2+ independent sources agreed.
- **s7349 Rozé** (aka Roze): breeder Dying Breed Seeds (SeedFinder + GrowDiaries; Leafly says 3rd Gen Fam); parents Zkittlez (Leafly, AllBud, GrowDiaries; SeedFinder lists The Original Z = Zkittlez; second parent unknown everywhere); lean Indica-leaning (AllBud 60/40 indica, GrowDiaries indica-leaning, SeedFinder mostly indica); THC 19–21% (AllBud 19–20, GrowDiaries 20, Leafly 21); effects Euphoric/Creative/Happy/Uplifted; flavor sweet and floral with strawberry; ailments Stress/Depression/Nausea/Anxiety. Held: terps (Leafly unverified review COA only), Leafly's other aliases (Roz, Rozay, Rosay; single source).
- **s7350 Banana Pudding**: TWO versions. Leafly + AllBud agree on GSC x Banana OG (wrote this); SeedFinder lists a Dying Breed Seeds Banana Pudding as Banana x OG Eddy ("probably"). Library's Banana Roze (Dying Breed, Leafly) cites "Banana Pudding" without saying which. Written: parents GSC/Banana OG, effects Giggly (both), flavor vanilla (both), ailments Stress/Depression (both). Held: lean (AllBud 70/30 vs Leafly hybrid), THC (AllBud 30–31 only), other effects/ailments.
- **s7351 Slurricane #7**: In House Genetics selection; parents Do-Si-Dos x Purple Punch (GrowDiaries + SeedFinder lineage); lean Indica-leaning (GrowDiaries "indica", SeedFinder both phenos indica-dominant). Related to library Slurricane s1536 (same cross) and used as a parent of Terple s7330 and Slurricane IX s5833. Kept separate (specific breeder cut). Held: THC, effects, flavor, ailments (GrowDiaries only; Leafly unreachable; AllBud page was a search listing).
- **s7352 Sweatband**: parents 707 Headband x Chemdawg (SeedFinder + AllBud); lean Sativa-dominant (both); flavor sour and chemical (SeedFinder sour/skunky, AllBud chemical/sour). Held: breeder Jungle Boys (SeedFinder only), THC, effects, ailments (AllBud only). JointCommerce post gave a conflicting parent (East Coast OG Kush) and was not used.
- **UK Monkey: NOT added.** Only SeedFinder (Wanted Seeds: Cheese x Grease Monkey). Conflicts with the SeedFinder Wanted Seeds Vanilla Sky claim of GG4 x UK Monkey being a different cross from Grease Monkey. Single source; stays on the sheet.

## Sheet row-by-row research — Batch S1 (Discovered Candidates rows 2812, 2813, 2820, 2821, 2822; 2026-10-20)
Alissa asked to start at the first "needs research" row (2812, Tropical Papayaz) and work through in batches of five. Statuses on the sheet: needs research / added / skip.
- **Tropical Papayaz → ADDED s7353.** 808 Genetics (breeder's own page + Lazy River product page); parents Papaya x Zkittlez (AllBud, Lazy River, 808 Genetics post; 808 says BX3); Indica-dominant (AllBud 70/30, Lazy River); THC 23–25% (AllBud 23–25, Lazy River 23.99); effects Relaxed (AllBud, Lazy River); flavor sweet tropical papaya (all); ailments Stress (AllBud, Lazy River). Held: other effects/ailments (AllBud only). Note: 808's own page says "Tropical Papayaz" is a menu of crosses, not one strain.
- **Tropical Souffle → stays "needs research".** No page found on Leafly, AllBud, SeedFinder or via search (only unrelated Souffle strains).
- **True Chocolate → ADDED s7354.** Copycat Genetix (Leafly + SeedFinder); parents (Chocolate Diesel x Chocolate Thai) x Chocolate Strawberry (Leafly + SeedFinder lineage). Held: THC (26% Leafly, 26–31% breeder), flavor (milk chocolate, but both are breeder wording), effects/ailments (none).
- **True Kush → stays "needs research".** Only Leafly (22% THC, lemon/berry, myrcene); AllBud and GrowDiaries unreachable; many unrelated "True ... Kush" strains share the name. Single source.
- **"True Mintz is Triangle Kush" → ADDED as True Mints s7355; library correction.** SeedFinder, AllBud and Weedmaps all list "True Mintz" as an alternate name of True Mints = True OG x Kush Mints (Jungle Boys per SeedFinder). Written: lean Indica-leaning (all three), THC 30–32% (SeedFinder, AllBud), effects Focused/Relaxed/Uplifted, flavor mint with sweet and sour citrus, aka True Mint/True Mintz. Held: breeder (SeedFinder only), ailments (AllBud only). The library's TMZ (s2913) had "True Mintz" as its alias/name; Leafly and AllBud list Triangle Mints (TK x Animal Mints) without any True Mintz/TMZ alias. Alias removed and name trimmed to "TMZ" via migration strain_research_batch6_2026_10_20 (and strains.json updated to match). TMZ's own parents/breeder/THC left as they were; TMZ itself is unverified and worth a look later.
- Sheet additions: Chocolate Strawberry (parent of True Chocolate; not in library).

## Sheet row-by-row research — Batch S2 (rows 2823, 2824, 2826, 2827, 2828; 2026-10-20)
- **True OG (row 2823) → already in library as s422.** Filled blank parents: OG Kush (Leafly + SeedFinder; Weedmaps also says developed from OG Kush genetics by self-pollination). Held: breeder (library Caveman; Weedmaps/SeedFinder say Elemental Seeds / unknown), aka "Kobe OG" (SeedFinder only), THC (Leafly 20, Weedmaps 20–27). Weedmaps' "Chemdog x Lemon Thai" parent claim conflicts and was not used. Existing effects/flavor/ailments untouched.
- **True OG selfcross Emerald Mountain (row 2824) → skip.** Descriptor, not a separate strain: it is 707 Truthband (Emerald Mountain), already in the library as s2985 with True OG x True OG (confirmed by Humboldt Seeds and Leafly).
- **Truffle OG (row 2826) → stays "needs research".** Only a Weedmaps page (AI-generated from inventory, parents unknown); Leafly/AllBud pages unreachable. Single source.
- **Turbo Diesel (row 2827) → ADDED s7356.** Parents Sour Diesel x Sour Kush (AllBud, GrowDiaries, SeedFinder MTG Seeds); breeder MTG Seeds (SeedFinder + GrowDiaries); lean Sativa-leaning (AllBud 75/25, GrowDiaries sativa-leaning); effects Energetic/Uplifted/Happy (Leafly, GrowDiaries; Uplifted in all three); flavor diesel (all three); ailments Depression (all three). Held: THC (19 / 20–30 / 24), terps (Leafly limonene only), other ailments/flavors (single source). Library's Cherry Diesel (s2026, aka Cherry Turbo Diesel) already lists Turbo Diesel as a parent, which now resolves.
- **Tutti-Frutti (row 2828) → stays "needs research".** Two unrelated strains share the name: Flash Seeds autoflower (Leafly only: Blue Haze, tropical/berry) and Hang On! Genetics (SeedFinder only: Orange Bud x Bannanita Dolka). Each version has a single source, so neither is written.

## Sheet row-by-row research — Batch S3 (rows 2829, 2833, 2834, 2835, 2836; 2026-10-20)
- **Twisted Cherries (row 2829) → stays "needs research".** Two versions, each with two sources: Turpene Time (SeedFinder + THCFarmer: (Dark Horse x Tigers Milk) x Cherry West Bx1) vs Twisted Velvet x Cherry Cookies (AllBud + Maven Genetics rosin; indica-dominant, 26–30% THC, cherry/berry). Cannot tell which the library/user means, so nothing written. Relatives: Twisted Velvet, Cherry Cookies and Tiger's Milk are in the library; Dark Horse and Cherry West Bx1 are not.
- **UK Cheese (row 2833) → already in library as s1240.** Filled blank THC 20–23% (Leafly 20, AllBud 20–23) and ailments Stress/Pain/Anxiety/Insomnia (Leafly + AllBud, both name pain/stress/anxiety/insomnia). Held: lean (AllBud 80/20 indica vs Leafly hybrid), breeder (none named; "Exodus" collective credited by Leafly/AllBud reviewer only), terps (Leafly only). Existing effects/flavor/parents (Skunk #1, confirmed by Leafly + AllBud) untouched.
- **UK Cheese Exodus Cheese (row 2834) → skip (flag).** Descriptor row. Leafly lists Exodus Cheese as an alias of UK Cheese, and SeedFinder's "Exodus (UK) Cheese" = Cheese, the Exodus cut. The library has a separate Exodus Cheese (s1091, Green House Seed Co., 22–31% THC, linalool-forward) that may be the same strain as UK Cheese s1240. Not merged because only Leafly + SeedFinder wording supports it and s1091's data looks unsourced; worth a decision later.
- **Ultimate Purple (row 2835) → ADDED s7357.** Breeder BC Bud Depot and parents The Purps, Purple Urkle, Granddaddy Purple, Grape Ape, SR71 Purple Kush (AllBud, GrowDiaries, SeedFinder; SeedFinder marks GDP/Grape Ape "probably"); Indica-dominant (AllBud, GrowDiaries 80/20); THC 19–24% (AllBud, GrowDiaries typical range); effects Relaxed/Euphoric/Sleepy; flavor sweet grape; ailments Pain/Stress/Insomnia. Held: terps (Leafly only), Creative/Uplifted/Happy (single source). "The Purps" and "SR71 Purple Kush" are not in the library (library has Mendocino Purps s1156, not assumed to be the same).
- **Ultra Love (row 2836) → stays "needs research".** No strain by that name found (closest hits: Ultra Early Love, LA Ultra, Ultra Violet).
- Sheet additions: The Purps, SR71 Purple Kush, Dark Horse, Cherry West Bx1.

## Sheet row-by-row research — Batch S4 (rows 2838, 2839, 2840, 2841, 2842; 2026-10-20)
- **undocumented parent (2838), unnamed OG (2840), unspecified Sativa (2841) → skip.** Placeholder text from the source data, not strains.
- **Unicorn Kush, ILLICIT brand (2839) → stays "needs research".** "Illicit" is a brand (its product is Unicorn Poop). "Unicorn Kush" is a name used for several different breeder cuts (SFV/Triangle Kush/Ghost OG backbones with a Unicorn parent; JointCommerce is the only substantive source and says there is no single strain). Nothing to corroborate.
- **Urkel (2842) → skip; alias of Purple Urkle s69.** SeedFinder lists "Urkel" as an alternate name of Purple Urkel; Leafly (alias "Pu") and AllBud do not. Single source, so "Urkel" was not added to aka (library aka is "Purple Urkel"). Filled blank THC on s69: 18–21% (Leafly 19, AllBud 18–21). Held: lean (library Indica-leaning; Leafly indica, AllBud 70/30, SeedFinder mostly indica agree broadly), parents (library Mendocino Purps from Leafly; AllBud says phenotype association only; SeedFinder "Unknown Mostly Indica"), breeder (none; clone-only).

## Sheet row-by-row research — Batch S5 (rows 2843–2848)

- **UW Purple** (added s7358): Indica-dominant (AllBud, GrowDiaries, Leafly "indica"); THC 19–21% (AllBud 19–21, GrowDiaries ~20; Leafly says 14%, held); effects Relaxed, Sleepy (all three); flavor sweet grape and berry (AllBud + GrowDiaries); ailments Insomnia, Stress, Pain (AllBud + GrowDiaries); alias UW Purp (AllBud). Origin Washington/University of Washington is rumor only; no parents or breeder anywhere. Held: "UW" alias — Leafly and GrowDiaries treat UW and UW Purple as one page, but AllBud lists UW as a separate sister strain (50/50, 19–24%), so no alias; sheet row "UW" stays needs research.
- **Uzbeki Hashplant**: no strain by this name; only SeedFinder lists a landrace "Uzbekistan Hash Plant" (Nomad Seed Bank). Single source, not written. Status no data.
- **Valentine Clone**: no strain by this name found. Only unrelated Valentine X (CBD) shows up (not in library). Status no data.
- **Valley Kush**: only SeedFinder has "Valley Kush 1.0" (Accelerator Seeds, Emerald Triangle x Hindu Kush). Single source, not written. Status no data.
- **Valley OG** (added s7359): own strain, descendant of SFV OG (AllBud, GrowDiaries; Leafly lists Sherb Valley as its child). THC 24–25% (Leafly 24, AllBud 24–25; GrowDiaries 20 held); effects Creative, Happy, Energetic (Leafly + AllBud); flavor lemon and citrus with cheesy skunk note (Leafly + AllBud); parents [SFV OG]. Held: lean (50/50 vs indica-driven), ailments, alias VOG (Leafly only).
- **Correction**: "Valley OG" removed from s7280 SFV OG aka (migration batch7). Weedmaps SFV OG lists no such alias and three sources treat Valley OG as a separate strain. s5769 Sherb Valley parent "Valley OG" now points at a real entry.

## Sheet row-by-row research — Batch S6 (rows 2849–2858)

- **Vanilla Cheesecake** (added s7360): breeder Happy Dreams Genetics (GrowDiaries + SeedFinder breeder listing); parent Vanilla Frosting (AllBud + GrowDiaries); effects Relaxed (both); flavor sweet vanilla cream with a cheesy note (both); ailments Pain, Stress, Migraines (both). Held: second parent (AllBud Cheesecake vs GrowDiaries MAC and Cheese), THC (14–19% vs 20–25%), lean (70/30 vs 50/50). Two versions of the cross exist; only the shared parts written.
- **Vanilla Cream**: no strain page anywhere; only a Castle Rock Farms retail product (Pink Rntz x Grape Gas / Velvet Cream pheno), single source. No data.
- **Venkman OG**: only SeedFinder (Lost River Seeds; Doc's OG x Rugburn OG, Indica-dominant); jointcommerce copies it. Single source. No data.
- **Venus Flytrap Skunk Special**: not one strain. SeedFinder lists Venus Flytrap (Nirvana Seeds; Skunk Special x (Jack Horror x Skunk #1)) and Skunk Special separately. Single source. No data.
- **Very Berry Kush**: no such page. Only SeedFinder's "VerryBerry Kush" (Nasty Nugz, regular, indica, no parents) and unrelated Very Berry (Green Hornet) / Very Berry Haze (already s423). No data.

## Sheet row-by-row research — Batch S7 (rows 2858–2862)

- **Victoria's Secret**: no strain found anywhere (only the lingerie brand and unrelated Victoria, BC producers). No data.
- **Vietnam Black / Vietnamese Black** (one entry, s7361 Vietnamese Black, alias Vietnam Black): Southeast Asian sativa landrace. Type Sativa (Leafly, AllBud, GrowDiaries; SeedFinder "mostly sativa"); effects Energetic, Focused, Creative (Leafly + GrowDiaries; AllBud "focus, uplifting energy"); flavor citrus with earthy, spicy herbal notes (AllBud + GrowDiaries; Leafly grapefruit); ailments Depression, Stress (AllBud + GrowDiaries); alias Vietnam Black (GrowDiaries, SeedFinder, Leafly). Held: THC (AllBud 24–25% vs GrowDiaries 20%), lean, breeder (several preservers: Snow High, Landrace Team, Blackbird, etc.), alias VBk (Leafly only), Migraines (AllBud only).
- **Virginia Beach Afghani**: no strain page found anywhere. No data.
- **Voltron**: two unrelated strains share the name (Nerds Genetics: WhoOody Tribe x Blazing Sword; Bio Vortex: (Athene Sour Kush x Holy Crack) x (Sapphire Scout x Black DOG)), each SeedFinder only. No data.

## Sheet row-by-row research — Batch S8 (rows 2863–2868)

- **Wagyu** (added s7362): Clout King's Wagyu (Meat Breath x Lemon Cherry Terdz per Leafly and Weedmaps; GrowDiaries says x Lemon Cherry Airheadz). Written: breeder Clout King (GrowDiaries + Weedmaps), parent Meat Breath (all three), effect Relaxed (Leafly + GrowDiaries), flavor gassy diesel (Leafly chemical, GrowDiaries diesel, Weedmaps gassy). Held: second parent (Terdz vs Airheadz; Leafly's Terdz page lists Airheadz as its child, not Wagyu), lean (indica-dominant / indica-leaning / balanced), THC (19% vs 27%), ailments (GrowDiaries only). A different Wagyu exists from Surfr Seeds (Cow God x Redneck Wedding), SeedFinder only; not used.
- **Wakanda** → alias of **Wakanda OG** (added s7363, alias Wakanda per Leafly + AllBud): parents Cookies, OG Kush, Gorilla Glue #4 (Leafly + AllBud); effects Creative, Happy (both). Held: lean (AllBud 50/50), THC (AllBud only), flavor (Leafly earthy/woody/lemon vs AllBud peppery/skunky/spicy/sweet), alias Wakanda Kush (AllBud only), alias Wkd (Leafly only).
- **Warheadz**: only a sponsored dispensary article (Kaboom x Sour Pez); Galactic Warheadz s1708 and Cherry Warheadz are different strains. Single source. No data.
- **Wedding Cake #13**: no source for a #13 cut; generic Wedding Cake is s9. No data.
- **Wedding Cake F4**: already in library as s6535 (Seed Junky Genetics, Triangle Kush x Animal Mints, Indica-dominant); SeedFinder confirms breeder and "mostly indica"; no effects/THC data to add.

## Sheet row-by-row research — Batch S9 (rows 2869–2873)

- **Wedding Cake pheno #20**: no source mentions a #20 cut (SeedFinder's Pheno Finder Seeds Wedding Cake lists no phenotypes). No data.
- **Wedding Cake sharing the name** and **Wedding Cake under the same name**: placeholder text, not strains. Skip.
- **Wedding Cake Triangle Kush**: descriptor for Wedding Cake (Triangle Kush x Animal Mints), already s9. Skip.
- **Wedding Cheesecake**: two unrelated products share the name: White Label (SeedFinder: (God's Gift x Purple Urkel) x (Hindu Kush x Big Bud x Durban), mostly indica) and Fast Buds ((Wedding Cake x Cheese) x Wedding Cheesecake Auto, ~65% sativa; Leafly product page); each single source and they disagree. No data.
- No library changes this batch.

## Sheet row-by-row research — Batch S10 (rows 2876–2883)

- **Weird Science**: no strain page found. No data.
- **Wellness OG** (added s7364): parent OG Kush (Leafly + AllBud); Sativa-dominant (both descriptions; AllBud's info box says 50/50); effect Euphoric (both); flavor pine and diesel with lime (both); ailments Depression, Pain, Stress (both). Held: THC (AllBud 26% vs Leafly ~20% reviewer), other effects, breeder. Alias "Mega Wellness OG" NOT added: Leafly lists it as an alias, but AllBud has separate pages (Mega Wellness OG = OG Kush phenotype, 50/50, 18–33%). Library s5118 Mega Wellness OG (Nameless Genetics, Chemdawg x OG Kush) untouched. Open question whether they are the same strain.
- **Western Winds**: no strain page found. No data.
- **Wet Dream F3**: nothing for an F3 cut; generic Wet Dream is s754. No data.
- **White Alien** (added s7365): Martian Mean Green x White Widow (AllBud + SeedFinder); breeder DNA Genetics (SeedFinder + seed retailer). Held: lean (AllBud 60% indica vs SeedFinder 60% sativa), THC, effects, flavor, ailments (AllBud only; Leafly page unreachable).

## Sheet row-by-row research — Batch S11 (rows 2885–2890)

- **White Cherry Truffle** (added s7366): Cherry Noir x Highland Afghani, Aficionado Seed Collection (SeedFinder, GrowDiaries, Leafly; AllBud gives the same lineage); Indica-leaning (AllBud + GrowDiaries 60/40, SeedFinder mostly indica); THC 20–25% (GrowDiaries 20–25 / ~23, Leafly 21, AllBud 15–25); effects Euphoric, Uplifted, Relaxed; flavor sweet cherry and chocolate over diesel and rose; ailments Insomnia, Pain (AllBud + GrowDiaries). Held: Stress/Depression/Migraines (one source each), alias WCT (Leafly only).
- **Correction**: "White Cherry Truffle" removed from s2198 White Cherry Gelato aka (migration batch8). It is a different strain (Aficionado), and AllBud's White Cherry Gelato page lists no alternate names. The other alias "White Cherry" on s2198 left as is (not checked).
- **White Chocolate** (added s7367): Chocolope x White Moonshine (Leafly + AllBud); effect Creative (both); flavor coffee with cherry notes. Held: lean (Leafly sativa-dominant vs AllBud 50/50), THC (AllBud only), other effects (Energetic vs Uplifted), ailments (AllBud only), alias Wch (Leafly only).
- **White Crack Walter White** (row names two strains): **Walter White** added s7368 (Mephisto Genetics; parent The White; flavor citrus; Leafly + SeedFinder). Held: effects (Leafly only), THC, lean. **White Crack** not written: AllBud says The White x Tres Dawg, SeedFinder (Riot Seeds, aka Baltimore Kush) says Green Crack x White Dawg; two versions, one source each.
- **White Dwarf**: several unrelated seed-company strains (Buddha Seeds, Bulk Seeds, Riot Seeds), SeedFinder only. No data.
- **White Dwarf three-way cross**: descriptor, not a strain. Skip.

## Sheet row-by-row research — Batch S12 (rows 2894–2900)

- **White Fire OG #3 WiFi #3**: no source for a #3 cut; generic White Fire OG is s1588 (aka WiFi). Library s6401 WiFi Sunset already uses "White Fire OG #3" as a parent name. No data.
- **White Flo**: no strain by this name; only the differently named Flo White (Flo x The White, AllBud + Leafly; aliases Flo White #7/FloWhite and Flow White, no "White Flo"). Not added or aliased. No data.
- **White Forest**: only SeedFinder (Cabin Fever Seed Breeders); single source. No data.
- **White Gummies** (added s7369): Compound Genetics, White Runtz x Gummiez (Leafly + Weedmaps); aliases White Gummiez (both), White Gummy (Weedmaps; AllBud/Leafly page slug); Indica-dominant (Weedmaps + AllBud); THC 26–28% (AllBud 26–28, Leafly 26); effects Relaxed, Uplifted (Weedmaps + AllBud; Leafly adds Relaxed); flavor sweet blueberry and vanilla candy (Weedmaps + AllBud). Held: ailments (AllBud only). AllBud's older text gives Jillybean x Bubblegum parents; Weedmaps notes those as roots. s6419 XO Gummiez parent "White Gummies" now points at a real entry.
- **White Hot Guava #14**: no source for a #14 cut. Leafly lists "White Guava" with alias White Hot Guava (Stardawg x Tres Dawg), GrowDiaries says Stardawg guava x White Hashplant, AllBud says unclear (Guava Diesel x White Hashplant). Conflicting; no alias made. White Guava itself not added (genetics disagree). s2687 High Octane Guava still lists "White Hot Guava #14" as a parent. No data.

## Sheet row-by-row research — Batch S13 (rows 2901–2907)

- **White Indica**: only SeedFinder (Ceres Seeds, mostly indica); single source. No data.
- **White Label Bubblegum female**: descriptor for a seed-company feminized Bubblegum; no strain page. No data.
- **White MAC #51 GC Uniques line**: no source mentions a #51 or GC Uniques cut. Base White MAC s6872 enriched: ailments Anxiety, Depression, Pain (AllBud + Leafly). Held: lean (AllBud 70/30 only, Leafly hybrid), breeder (neither lists one), THC, other fields already set.
- **White OG** (s580 filled): The White x SFV OG Kush (Leafly, AllBud, SeedFinder); Karma Genetics breeder already set; lean Indica-dominant (Leafly indica, AllBud description, SeedFinder). Held: alias White OG Kush (Leafly only), THC (existing 22–29% vs Leafly 21% / AllBud 24%).
- **White OG is a distinct strain**: descriptor text, not a strain. Skip.

## Sheet row-by-row research — Batch S14 (rows 2908–2912)

- **White OG+ Cannarado Genetics**: no strain found (only unrelated Cannarado strains and White Octane OG). No data.
- **White Rhino** (s214 filled): White Widow x North American Indica (Leafly + AllBud; SeedFinder Green House says White Widow x Afghan); lean Indica-dominant (AllBud 80/20, Leafly indica, SeedFinder indica-dominant phenotypes). Breeder Green House Seeds already set (SeedFinder confirms). Held: alias Wr (Leafly only), THC (14–20% existing vs 18–22 / 21 / 11).
- **White Rhino single source**: descriptor text, not a strain. Skip.
- **White Runtz S1**: seed-seller listings only (Atlas Seed, Elite Clone); no independent strain data. Base White Runtz is s1568. No data.
- **White Stomper**: three different strains share the name: White Stomper V3 (Night Owl Seeds, Walter White x Tyrone Stomper; SeedFinder only), White Grape Stomper (AllBud: White Widow x Grape Stomper) and Grape Stomper x The White (Leafly product, Khush Kush). Conflicting and single-source each. No data.

## Sheet row-by-row research — Batch S15 (rows 2914–2919)

- **White Taffi** (added s7370): breeder Doja Seeds (GrowDiaries + SeedFinder); flavor creamy menthol with nutty and tropical fruit notes (both). Parents unknown per both (mislabeled cut, possibly a Zoap S1; once thought to be P41). Held: lean (GrowDiaries sativa-leaning only), THC, effects Creative/Energetic/Tingly, ailments (GrowDiaries only; AllBud and Leafly pages unavailable). s5662 Red Taffy's parent "White Taffi" now points at a real entry.
- **White Tangerine Haze**: no strain by this name; only SeedFinder's differently named White TangHaze Outerspace (Karma Genetics). No data.
- **White Triangle OG**: no source; no source lists it as an alias of The White (Leafly lists "White" only). s2697 Iron Triangle uses the name as a parent. No data.
- **White Truffle S1 cut**: only a seed listing (Beleaf Cannabis, White Truffle x White Truffle, Gorilla Butter pheno); single source. No data. Base White Truffle (s1618) enriched: lean corrected Indica-leaning -> Indica-dominant via migration batch9 (Leafly + AllBud), THC 23–28% (AllBud 23–28, Leafly 24). Held: ailments (AllBud only), alias WTr (Leafly only). Leafly notes Parabellum Genetics has a different White Truffle.
- **White Truffle, Triple Chocolate Chip**: descriptor for White Chocolate Chip (Triple Chocolate Chip x White Truffle), already s6359. Skip.

## Sheet row-by-row research — Batch S16 (rows 2921–2925)

- **White Uchem**: only AllBud (Chem 91 phenotype, 50/50, 15–20%); Leafly page unreachable; single source. No data.
- **White Widow Colorado**: no Colorado-specific cut documented. No data.
- **White Widow female**: descriptor text, not a strain. Skip.
- **White Widow Ingemar cut**: already covered: s6 White Widow aka includes Ingemar White Widow / Ingemar's White Widow (SeedFinder breeder statement: Ingemar of De Sjamaan; Green House Seeds). s6 enriched: ailments Pain, Stress, Anxiety (Leafly + AllBud). Held: lean (Leafly 60% sativa and AllBud sativa-dominant vs SeedFinder mostly indica), THC (15 / 18–25 / 12), alias WW (Leafly + SeedFinder abbreviation only), Depression/Migraines (AllBud only).
- **White Widow, or Gelato 45**: descriptor text; Gelato #45 is s1599. Skip.

## Sheet row-by-row research — Batch S17 (rows 2926–2931)

- **White Widow, per Red Cross CWM single source**: descriptor text. Skip.
- **WiFi #3**: no source for a #3 cut (AllBud's White Fire page lists WiFi OG / White Fire OG, no "#3"). Base White Fire OG is s1588. No data.
- **WiFi #43 / WiFi 43 / White Fire 43** (s742 filled): #43 phenotype of White Fire OG, OG Raskal Genetics (Leafly + GrowDiaries; SeedFinder: originally OG Raskal); lean Indica-dominant (AllBud 70/30, Leafly Indica, GrowDiaries leans indica, SeedFinder indica-dominant); parent White Fire OG (Leafly + AllBud + SeedFinder); alias WiFi 43 (Leafly + GrowDiaries). THC 22–28% already set (Leafly 22, GrowDiaries 25, AllBud 25). **Correction**: CBD "19–21%" on s742 was wrong (Leafly none, GrowDiaries 0.1%, AllBud ~5%); blanked via migration batch10. Held: effects/ailments already set.
- **Wifi 43 Archive Seed Bank or The White**: descriptor text. Skip. (SeedFinder's White Fire 43 is under "Unknown or Legendary", not Archive.)

## Sheet row-by-row research — Batch S18 (rows 2932–2939)

- **Wifi 43 White Fire #43**: alias of White Fire 43 s742 (see S17). Nothing new.
- **Wifi Cheese aka White Fire Cheese**: no strain page found (AllBud URL guess returns nothing). No data.
- **William's Wonder / William's Wonder Mayiam's Wonder / Williams Wonder** (one entry, added s7371): breeder Super Sativa Seed Club (AllBud + Weedmaps; SeedFinder also lists SickMeds, BC Bud Depot versions); parent Afghani (Leafly + Weedmaps); type Indica (AllBud 100% indica, Leafly indica-dominant, Weedmaps indica); THC 19–23% (Leafly 19, Weedmaps 18.5–23.5, AllBud 17–26); effects Relaxed (all three), Euphoric (AllBud + Weedmaps); flavor sweet citrus and tropical fruit (AllBud + Leafly, Weedmaps sweet citrus); aliases Willy's Wonder (Leafly + Weedmaps), Willie's Wonder (AllBud + Leafly). Held: alias M31 (Weedmaps only), "Mayiam's Wonder" (no source found; s2980 60 Day Wonder uses it as a parent label), lean (100% vs indica-dominant), ailments (AllBud only). Now parents of s2314, s2980, s6411 etc. point at a real entry.

## Sheet row-by-row research — Batch S19 (rows 2941–2945)

No library changes. Every fact found came from one source (SeedFinder, which repeats the breeder's own description), so all is held per the 2-independent-source rule.

- **Winni**: no strain page found on any source. No data.
- **Winterberry**: SeedFinder lists a Winterberry by Lovin' in Her Eyes with unknown genetics and no data; it is a parent of Frozen Peaches s4291, Pearl Cadillac s5388, Kaleidoscope Eyes s6666 (plus Life On Mars, Silver Stream, Soul Kitchen, not in the library). A different Winter Berry (HillBilly Herb Grower, "squatty indica-leaning", mixed berry) exists; not the same strain. Leafly/AllBud no page. No data, no entry added.
- **Witches Brew**: several unrelated strains share the name. Ocean Grown Seeds version (Zenfandel OG x Merlot OG, per SeedFinder only), The Bakery Genetics version (SeedFinder only), and an AllBud concentrate listing (Mountain Top, indica, no genetics). No two sources agree on one version. Held; no data.
- **Wizard's Apprentice**: Night Owl Seeds autoflower, Cheech Wizard x Auto Skywalker (SeedFinder only; F4, F5 versions listed). Parent of Heartbreaker s2684. Held; no data.
- **Wizard's Glue**: Ocean Grown Seeds, GG #4 x Wizard's Potion male (SeedFinder only; jointcommerce copy not independent). Parent of Cthulhu s3882. Held; no data.

## Sheet row-by-row research — Batch S20 (rows 2946–2950)

- **Wizard's Glue F1**: same Ocean Grown Seeds strain as Wizard's Glue (S19, GG #4 x Wizard's Potion male, SeedFinder only). Held; no data.
- **Wizard's Potion**: Ocean Grown Seeds; SeedFinder lineage "Widow G13 x SFV OG x 619 Bullrider" marked "probably", breeder calls it indica-dominant with sativa undertones. SeedFinder only (breeder text). Parent of B-Witched s3144. Held; no data.
- **Wonder Diesel**: AllBud only (William's Wonder x East Coast Sour Diesel, 60% sativa, THC 27% header vs 15–19% text, spicy/diesel). No second independent source (jointcommerce/theorywellness copy). Parent of Wrecking Ball s2950. Held; no data.
- **Wonder Woman, Blueberry**: descriptor row listing two strains. Blueberry is already s19. Wonder Woman added as s7372: THC 16–18% (Leafly 18, AllBud 16–18), effects Focused (Leafly + AllBud), Euphoric + Uplifted (AllBud, Leafly reviews), flavor sweet + skunky + fruity (Leafly, AllBud, Weedmaps all sweet/skunky; peach/berry fruit). Held: lean (AllBud 60% sativa vs Weedmaps indica-dominant vs Leafly hybrid), parents (Weedmaps Nirvana Super Skunk x White Widow vs Leafly "possibly Ice"), breeder Nirvana (Weedmaps only), ailments (AllBud only). Not to be confused with Wonder Woman OG s581.
- **Wookie #15**: Bodhi Seeds' Wookie (s2325, Big Buddy's Lavender x Appalachia, SeedFinder) is a different listing; no source describes "#15" itself. It is a parent of Guava Wookie s4610, Lavender Aura s4881, Lavender Jack s4887, Purple Wookie s5609, Sakura s5723, Terpenado s6121, Twin Flames s6256. Held; no data. Next-batch rows 2951/2952 are variants of this.

## Sheet row-by-row research — Batch S21 (rows 2951–2955)

- **Wookie 15 Nepali OG** / **Wookie 15 Weedmaps**: no source describes a Wookie 15 x Nepali OG cross or a separate "Weedmaps" version; Weedmaps page not reachable. Nepali OG is already s6915 (Bodhi, sparse); Wookie #15 held in S20. No data.
- **Wowzers** (added s7373): breeder Exotic Genetix and Runtz x Strawberries & Cream (Leafly, SeedFinder, Weedmaps all agree); type Hybrid (lean blank: SeedFinder 50/50, Weedmaps balanced); flavor sweet strawberry candy and berry with gassy notes (Leafly berry/sweet/fruity/diesel, Weedmaps candy strawberry/gassy). Parents point to Runtz s1517 and Strawberries and Cream s1950. Held (single source, Leafly): THC 25–30% (a reviewer reports ~18%), effects Euphoric/Uplifted/Happy, ailments Stress/Anxiety/Depression, aliases Wwz/Wwzrs, terpene caryophyllene. Parent of Gooberry Moonshine s4471.
- **Wubba**: Raw Garden's cultivar (The White x Bubba Kush, indica-dominant, kush/diesel/earthy), Leafly product page only; the AllBud Wubba Punch (Purple Punch F2 x White Bubba x GG4) is a different strain. Parent of Wubba Cookies s6413. Held; no data.
- **X01**: AllBud only (Pre-98 Bubba Kush x Chitrali #1, indica-dominant 65/35, 19–21%, coffee/herbal/woody). No second independent source found. Parent of Diamond Daze s3955. Held; no data.

## Sheet row-by-row research — Batch S22 (rows 2957–2964)

- **XXX**: AllBud lists a "XXX" (indica-dominant 70/30, ~15% THC, herbal/spicy, user reviews guess Afgoo x Skunk #1) that may be a placeholder name. Library already has XXX 420 s379 and XXX OG s380; no source ties "XXX" to either. Single source. No data. (Note: s379 XXX 420 carries the old "Talkative" effect and sample-style terps/flavor from the original seed; left unchanged, flag for a later cleanup.)
- **Yellow Benches**: no strain page found. Only a parent label of Los Altos s5014. No data.
- **Yellow Brick Road Ghost Train Haze** (added s7375 Yellow Brick Road): parents Ghost Train Haze x OZ Kush BX1 (AllBud + Bedford Grow review); sativa side (AllBud sativa-dominant 70/30, review "sativa") -> Sativa-dominant; THC 14–21% (AllBud 14–20, review 20.77 THCa); effects Energetic and Relaxed (both); flavor spicy (both). Held: breeder (Bedford Grow is the product brand in the review, not confirmed as breeder), aliases YBR / The Yellow Brick Road (AllBud only), ailments (AllBud only), terpenes (review only), the rest of the flavor lists (the two sources disagree). Now a real entry behind Blue Brick Road s3344 and Brick House s3484 parents.
- **Yeska**: no strain page found. Only a parent label of Cure OG s3883. No data.
- **Yeti OG** (added s7374): breeder Loompa Farms (Leafly + SeedFinder), type Indica (Leafly "indica", SeedFinder "mostly indica"), alias Headband BX (both), THC 20–23% (Leafly 21, SeedFinder "above 20%", one lab 23), flavor gassy diesel (Leafly diesel, SeedFinder gas). Held: parents (Leafly OG Kush x Sour Diesel vs SeedFinder/breeder Loompa Headband x NorCal mountain strain, conflict), effects (Leafly only), alias "Yeti" (Leafly only), lean. Parent of Forest Fire s2612, Samsquanch s5725.

## XXX cleanup (user request)

XXX 420 s379 and XXX OG s380 held sample-style placeholder data from the original seed (generic terpene sets, five-ailment lists, "Talkative", "linalool-leaning finish" flavor text). Researched each (Leafly + AllBud) and replaced with agreed values via migration batch11 (compare-and-set), json synced.
- **XXX 420 s379**: Sweet Tooth #3 x Chemo, Indica, Ontario origin (Leafly + AllBud; no breeder named). Effects Relaxed + Euphoric (Leafly description, AllBud) + Talkative (Leafly lists it, AllBud "sociability"; restored after the user confirmed Talkative stays valid); flavor sweet honey and berry (both). Blanked as unsupported: THC 16–24% (AllBud alone says 16–19%), CBD <1%, terpenes, ailments. Held: alias 420 Kush (AllBud only), Leafly effects Aroused/Talkative/Energetic (Leafly only, contradicts its own description), Leafly ailments anxiety/eye pressure/depression.
- **XXX OG s380**: OG Kush x XXX, Indica / 75% indica (Leafly + AllBud). THC 12–21% (AllBud 12–20, Leafly 21); effects Sleepy, Relaxed, Euphoric (Leafly; AllBud has Euphoria, Relaxing, Sleepy; Happy is AllBud only so dropped); flavor pine and woody with lemon (both). Blanked: terpenes, ailments (Stress/Pain Leafly only). Held: breeder Maven Genetics, 2014 LA Cannabis Cup first place (Leafly only).
- Talkative: the app already supports it (EFFECT_VOCAB, emoji, description, Socialize mood). The research-side "no Talkative" note was a mistake; user confirmed Talkative is valid. The 362 entries carrying it are fine. Talkative is now allowed in research (2 sources, same as any effect).

## Sheet row-by-row research — Batch S23 (rows 2965–2970)

- **Yeti OG Headband BX**: alias of Yeti OG s7374 (Leafly + SeedFinder). Nothing new.
- **Z Animal**: only a parent label (Seed Junky Genetics) of La Pop Rocks s2155 and Grape Zorilla s4556; Leafly/AllBud/SeedFinder pages not reachable or empty. No data.
- **Z OG** (added s7376): Original Z (= Zkittlez s381) x OG Kush (Leafly + AllBud; AllBud says "OG strains"), Hybrid, effects Euphoric/Happy/Uplifted (both), flavor berry/blueberry/pineapple (both), aliases Z-OG / ZOG (Leafly + AllBud). Held: THC (AllBud 20–35%, Leafly 20%), lean (AllBud 50/50), terpenes (Leafly only), breeder (none). Not added as alias: "Zkittlez OG" (Leafly's page name, but a separate Nasha Genetics strain of that name exists per SeedFinder-derived listings).
- **Z The Original Z/Z3**: descriptor row for two strains already in the library: The Original Z is an alias of Zkittlez s381; Z3 is s6437 (Terp Hogz, Zkittlez x Hindu Kush BC3, SeedFinder). SeedFinder also lists The Original Z as a Dying Breed Seeds strain; library Zkittlez breeder says 3rd Gen Family / Terp Hogz. Flag only, unchanged.
- **Z Zkittlez**: variant spelling of Zkittlez s381 (aka already has Z, Z Skittles). Nothing new.

## Sheet row-by-row research — Batch S24 (rows 2972–2976)

- **Zacatecas Purple** (added s7378 Purple Zacatecas): Sativa and a Jalisco, Mexico heirloom landrace line (AllBud "100% pure sativa", SeedFinder Hyp3rids "Mexican Sativa Landrace from Jalisco"). Alias Zacatecas Purple (AllBud reviewer; also the library's parent label on Big Sur Holy s3259). Held (single source): THC 14–16%, effects Creative/Euphoric/Happy/Uplifted, flavor herbal/spicy/sweet, breeder (Hyp3rids repopulated the line from a private breeder, not the original breeder). Reviewer warns many products sold under the name are not genuine.
- **Zainbow Runtz**: Zainbow sources conflict. SeedFinder (Cranebow City page): Zainbow = (Runtz x Z-Cube) x (Zkittlez x undisclosed), bred by Crane City Cannabis. AllBud: ZR3 x The Zhit strains, sativa-dominant 60/40, 25–30%. No source for "Zainbow Runtz" as a separate strain. No data; no entry. Zainbow is a parent of Cranebow City s2448.
- **Zamal**: already in the library as s7342 (Sativa, La Reunion; added earlier). No change. ACE Seeds page not reachable this pass.
- **Zeclair** (added s7377): Cold Heat x Zonuts (Leafly + Cannabis Business Times), breeder Umami Seed Co (both; Leafly adds Watson Supply collaboration), Hybrid; effects Euphoric + Relaxed (Leafly "calming", CBT calming/relaxing/euphoric); flavor vanilla, sweet, gassy (Leafly diesel/vanilla/sweet; CBT chocolate gas, vanilla frosting). Held: THC (CBT 33–34%, up to 36; Leafly none), terpenes ~2% (CBT only), Energetic/Creative (Leafly only), alias ZEC (Leafly only). Parent of Jelly Zappers s4775, Zeclair x Delusion s6446. Parents point to Cold Heat s6925; Zonuts has no entry yet (row 2999).
- **Zephyr**: two unrelated strains share the name: Blue Bloods Grow (Grateful Breath F2 x Grape Stomper X) and Lucky Dog Seed Co (Royal Apple x Chemdog 91 BX3), each single-source (SeedFinder). No data. Parent label on Blue Z Girls s3403.

## Sheet row-by-row research — Batch S25 (rows 2977–2983)

- **ZFace**: Z Face s6434 already in library. Sources: Leafly, AllBud, SeedFinder (Archive Seed Bank). Fixes: breeder Archive Seed Bank filled (Leafly + SeedFinder), aliases Z-Face and ZFace (AllBud, SeedFinder; Leafly lists ZFc), THC "20-29%" -> "20–26%" (AllBud 20–26, Leafly ~20; 29 had no support), lean Sativa-dominant -> Sativa-leaning (60/40 per AllBud + Leafly). Effects and flavor already matched. Held: terpene limonene (Leafly only). Note SeedFinder's lineage lists The Original Z as the Zkittlez parent.
- **Zin**: no strain page found for a plain Zin (results were Frosted Zinn, Zinn, Zion, etc., different strains). No data.
- **Zkittles, per Rocket Seeds also exists**: descriptor row noting another Zkittles by Rocket Seeds; SeedFinder page not reachable. No data. Zkittlez itself improved (below).
- **Zkittlez, by Flower Power Cannabis**: no source found for a Flower Power Cannabis version. No data.
- **Zkittlez autoflowering**: many unrelated autoflower versions by different breeders (Linda Seeds, Semyanich, Seeds66, Advanced Seeds, United Cannabis Seeds, Sensible Seeds, etc.), each single-source (jointcommerce copies not independent). No single version supported by 2 sources. No data. Auto crosses already in library (Amnesia Zkittlez Auto s3083, Gorilla Zkittlez Auto s4499).
- **Zkittlez s381 (existing entry, fixed because the research helped it)**: Leafly, AllBud, Weedmaps all call it a hybrid (library had Indica) -> type Hybrid, lean left blank (Leafly indica-leaning, AllBud indica-dominant 70/30, Weedmaps indica-heavy: sources disagree on degree). Effects Relaxed + Happy + Sleepy (Relaxed all three; Happy AllBud + Weedmaps; Sleepy Leafly + AllBud). Flavor filled: sweet berry and grape with tropical grapefruit (all three). Parents Grape Ape x Grapefruit confirmed (Leafly, AllBud, Weedmaps). Aliases Z, The Original Z (Leafly + Weedmaps) already present. Held: THC (conflict: AllBud 13–15, Weedmaps 17–26, Leafly ~20, breeder 15–23), terpenes (Leafly only), and the existing ailments (not re-audited). Corrections via migration batch12.

## Sheet row-by-row research — Batch S26 (rows 2984–2989)

No library changes. All five rows are cuts, backcrosses, brand versions or descriptor text built on Zkittlez (already covered, s381); none has two independent sources for its own data.

- **Zkittlez Baller Ben Cut**: a named cut; no strain page or product source found. Only a parent label of Dirty Z s3984. No data.
- **Zkittlez BX2**: no page for it. SeedFinder lists ZBX2 (Doja Seeds, derived from an Original Z phenotype, ~27% THC) but does not say "BX2" means Zkittlez BX2; single source, not confirmed as the same thing. Parent label of Tropical Burst s2194 and Blackberry Gary s3309. No data.
- **Zkittlez Grape Ape**: no strain of that name found; Grape Ape is one of Zkittlez's parents (Grape Ape x Grapefruit, s381). No data.
- **Zkittlez High Supply**: High Supply is a Texas cannabis brand; no Zkittlez product page found. No data.
- **Zkittlez Pheno Zkittles**: descriptor-style name for a Zkittlez phenotype; no source. No data.

## Sheet row-by-row research — Batch S27 (rows 2990–2994)

- **Zkittlez The Original Z**: The Original Z is already an alias of Zkittlez s381 (Leafly + Weedmaps). Nothing new. (SeedFinder lists The Original Z as a Dying Breed Seeds strain and as Zkittlez's ancestor; flagged in S23.)
- **Zkittlez Z OG**: same as Z OG s7376 (Leafly names it Zkittlez OG / Z OG). Alias "Zkittlez OG" still held (a separate Nasha Genetics Zkittlez OG exists).
- **Zkittlez aka Gorittlez**: AllBud lists Gorittlez as its own strain (Gorilla Glue #4 x Zkittlez, indica-dominant 60/40, 20–30%, creative/euphoric/giggly/happy/sleepy/sociable, berry/candy/grape/sweet), single source; no source says Gorittlez = Gorilla Zkittlez, though the genetics match. Held; no data. Possible duplicate of Gorilla Zkittlez s7379 if a second source confirms.
- **Zkittlez aka Sticky Zkittlez Glue**: SeedFinder only (Cream of the Crop Seeds, "Gorilla Glue #4 x Zkittlez" in the description, Original Glue x The Original Z in the tree, mostly indica, super-sweet). Zkittlez Glue s6456 (Expert Seeds) is a different breeder's version. Single source. No data.
- **Zkittzy Gorilla Gorilla Glue #4**: descriptor for the Gorilla Glue #4 x Zkittlez cross. Added as **Gorilla Zkittlez s7379** (four sources): breeder Barney's Farm (Leafly, SeedFinder, Weedmaps), parents Gorilla Glue #4 (Original Glue) x Zkittlez (Leafly, SeedFinder, Weedmaps, AllBud), Hybrid, Indica-leaning (SeedFinder and AllBud 60/40, Weedmaps slightly indica-forward, Leafly indica), THC 20–24% (Leafly 20, AllBud 20–24, breeder 24), effects Relaxed/Happy/Giggly/Sleepy, flavor sweet tropical fruit and chocolate (AllBud, Weedmaps; SeedFinder fruity sugar). Held: terpenes (Leafly only), aliases Gorilla Z / Goz (Leafly lists them, Weedmaps says Gorilla Z is distinct), Gorilla Zkittles (Weedmaps only). Leafly's flavor tags (tar, tobacco, earthy) disagree with the other three and were dropped. Other breeders' versions (Philosopher Seeds, GG4 x Zkittlez) not merged in. Related: Gorilla Zkittlez Auto s4499.

## Gorittlez duplicate check

Searched for a second source tying Gorittlez to Gorilla Zkittlez (s7379): none found (AllBud alone lists Gorittlez; Leafly's Gorilla Zkittlez page does not mention it). No merge. Stays a flagged possible duplicate.

## Sheet row-by-row research — Batch S28 (rows 2996–3000)

- **Zoap**: already in library as s1658 (Deo Farms). Research (Leafly + AllBud) fixed sample-style data via migration batch13: THC 20–26% -> 21–26% (Leafly 21, AllBud 25–26); effects Euphoric/Relaxed/Happy -> Relaxed/Giggly/Hungry (both sources); flavor -> sweet and fruity with an earthy finish (replaced "soapy-clean finish"); generic terpene set cleared; parents Pink Guava x Rainbow Sherbet filled (both sources). Held: alias Zop (Leafly only), terpenes caryophyllene/limonene/humulene (Leafly only), lean (AllBud 50/50). Parent of Space Lemonade s1856, Zealousy s6444, Croissant s6509, Cherry Zoap s6633, Platinum Zoap s5497, Pink Kitty s7234, Sex Panther s5757, Bubbly Boof s3519.
- **Zoda collab with Raw Genetics**: Zoda is already s6460 (Umami Seed Co; Zkittlez x Acai Gelato x Seattle Soda). Leafly credits Umami Seed Co + Super Seed Co and does not mention Raw Genetics; no source for a Raw Genetics collab. s6460 unchanged. No data for the collab claim.
- **Zombie Virus** (added s7381): Indica (Leafly "indica", SeedFinder "mostly indica"), flavor diesel with grape undertones (Leafly diesel/grape/chemical, SeedFinder diesel taste with grape undertones). Held: parents pure indica x Diesel (SeedFinder only, with "probably"; a Leafly reviewer says the same, unverified), breeder Lineage Genetics (SeedFinder only), THC 22% and CBD 0.05% (breeder), effects (Leafly sleepy/euphoric/energetic only), alias ZVr (Leafly only). Parent of Black Zombie s3313 and Sweet Zombie s6102.
- **Zonuts** (added s7380): Umami Seed Co, Runtz x Zuchi, Hybrid (Leafly + SeedFinder); flavor creamy and sweet (Leafly vanilla/butter/sweet/creamy dough, SeedFinder creamy sweet fruit and gas). Held: effects (Leafly energetic/talkative/happy, "mostly calming"), THC, alias Zut, ailments (all Leafly only). Parent of Zeclair s7377, Kreme Pie s2714, Blue Ivory s3365, Gumi s4616 and Cheetah Mintz (not in library). Parent label Zuchi has no entry yet.
- **Zoolander's Banana OG BX1**: SeedFinder's Zoolander Seeds Banana OG page has no BX1 version (Wedding Cake BX1 is only a Banana Mints parent). Parent label of Banana Mints s3180. No data.

## Sheet row-by-row research — Batch S29 (rows 3001–3006)

- **ZOZ**: sources conflict on genetics. SeedFinder (Dying Breed Seeds): OZ Kush x The Original Z. AllBud ("Zkittlez ZOZ"): Zkittlez x (Zkittlez x OG Eddy Lepp), indica-dominant 70/30, 20–33%, giggly/happy/hungry/sleepy, berry/citrus/sour. Parent-label name only in library (Dozicot s4062 uses Dozizoz). No data.
- **Zuava**: SeedFinder only (Terp Hogz; description says Zkittlez x Guava, lineage tree says The Original Z x Guava Gelato; effects and flavor on the page are speculative). Parent of Honey Banana Zuava s4684 and So Fresa s5855. No data.
- **Monkey Bunz**: SeedFinder only (The Bakery Genetics; GG#4 Josey Whales cut x Wedding Cake F2 male; no effects, flavor or THC). No data.
- **Gummy Bunz** (added s7382): aliases Gummy Buns (Leafly, SeedFinder, GrowDiaries), breeder Exotic Genetix (SeedFinder, GrowDiaries), parents Biscotti x Grease Monkey (SeedFinder, GrowDiaries), Hybrid, effects Happy + Energetic + Focused (Leafly happy/focused/energetic; GrowDiaries happy, "energizing and focusing" early), flavor sweet (Leafly, GrowDiaries). Held: lean (SeedFinder indica 70/30, GrowDiaries leaning indica, Leafly "mostly energizing"), THC ~22% (GrowDiaries only), alias GuB (Leafly only), Relaxed/Creative (GrowDiaries only), the other flavor notes (sources differ: honey/diesel vs earthy/spicy/cinnamon). AllBud had no page. Premium Cultivars also sells a Gummy Buns version. Not the same as White Gummies s7369.
- **Honey Bunz**: no page under this name. Two different Honey Bun strains exist: Cookies' (Leafly: 23% THC, hungry/tingly/relaxed, honey/tobacco/sage) and Taylormade Selections' (SeedFinder: Honey B x Wedding Cake); a jointcommerce article says Gelatti x Honey B (not independent). No two sources agree on one version. No data.

## Sheet row-by-row research — Batch S30 (rows 3007–3012)

- **Blue Burnout**: already in library as s6566 (Bio Bomb Selections; Bubba Blumese x Purple 710 Gum; SeedFinder + AllBud agree; AllBud 20–21% THC, indica-dominant 70/30, relaxing/euphoric/sleepy, blueberry/grape candy). No changes. Note: library type is "Indica" while AllBud calls it an indica-dominant hybrid (single source), so type left as is.
- **Burnout Cookies**: no strain page under this name on Leafly, AllBud, SeedFinder or GrowDiaries; only a LivWell dispensary product listing. Burnt Cookies (s3540, Fire OG x GSC) is a different name and was not merged. No data.
- **Burnout Chem**: SeedFinder only (Dominion Seed Company; Chemdog [D] x Dominion Skunk; breeder's description of a head high and chem/hash flavor). No second source. No data.
- **Princess Buttercup** (added s7383): breeder Twenty 20 Genetics and parents Dirty Blonde (A5) x Gorilla Butter agreed by SeedFinder + GrowDiaries. Type Hybrid. Held: lean (SeedFinder sativa-dominant, GrowDiaries indica-driven), THC 20% and effects happy/relaxed/sleepy (GrowDiaries only), flavor (both repeat the breeder's raisins/garlic butter/French onion soup line, so not independent). Dirty Blonde (A5) has no library entry.
- **Butter Cup**: SeedFinder only (SubCool's The Dank, by Badger; Cookies & Cream x Goji OG; 60/40 sativa). No second source. Different from Banana Butter Cup s3167. No data.

## Sheet row-by-row research — Batch S31 (rows 3014–3019)

- **Caked Up Candy** (existing s3552, corrected): AllBud + Weedmaps agree Runtz x Caked Up Cherries, Relentless Genetics (Weedmaps also lists a second, unrelated Captain Seeds Gelato x Wedding Cake version, ignored), and both call it a hybrid. Both report relaxation and appetite. Type Indica → Hybrid; effects Euphoric/Uplifted/Sociable → Relaxed + Hungry; unsupported Caryophyllene/Limonene terps blanked (migration batch14). Kept: lean Indica-leaning (AllBud 60/40), THC 30–38% (AllBud only, left as is), flavor, breeder, parents.
- **Double Baked Cake**: AllBud only (Layer Cake x Wedding Cake, 31–32% THC, hybrid 50/50). Binske/IKHCO listings are brand products, not strain sources. Leafly page unreachable. No data.
- **Hellcat #15**: only a Kings & Queens dispensary product listing (no genetics). AllBud's Hellcat (Raskal's OG x SFV OG Kush) does not mention a #15 cut. No data.
- **RO93**: no strain page found on any source. No data.
- **Runtz S1**: SeedFinder lists Nasha Genetics, Turn It Up Genetics (also Exotic Genetix and Clone Quest guides exist), each a Runtz x Runtz reversal/selfing with no effects, flavor or THC. Different breeders' versions of the same name, and the only source is SeedFinder. Plain Runtz s1517 unchanged. No data.
