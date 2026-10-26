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

## Sheet row-by-row research — Batch S32 (rows 3020–3027)

- **Sour Apple Killer** (existing s5872): SeedFinder + AllBud agree on NBK x Sunset Sherbet x Sour Apple, hybrid 50/50, THC 14–29%, happy/relaxing/sleepy, sour candy apple/lemon. Breeder Jungle Boys (SeedFinder only, kept). THC "14-30%" → "14–29%" (migration batch15); lean set to Balanced.
- **FPOG** (existing as Fruity Pebbles s1094, alias FPOG): AllBud + Leafly agree breeder Alien Genetics, aliases Fruity Pebbles OG/Fruity OG, THC ~18–21%, effects Euphoric + Giggly, flavor berry + tropical. Parents Green Ribbon x Granddaddy Purple x Tahoe Alien already match (AllBud lists Tahoe OG + Alien Kush, same cross). THC 23–31% → 18–21%, generic Linalool/Humulene/Terpinolene terps blanked, effects Talkative/Focused/Happy → Euphoric + Giggly, flavor sentence replaced. Lean left blank (AllBud indica-dominant 55/45, Leafly "mostly energizing").
- **Boston Cream Pie** (existing s3472 "Boston Cream (Boston Cream Pie)"): SeedFinder (MassMedicalStrains) + AllBud agree Mendocino Menage a Trois Vanilla Cream pheno x PuTang. Corrected: effects Relaxed/Stimulated → Uplifted/Creative/Happy/Hungry, flavor mint removed → "creamy vanilla with orange citrus", unsupported terps blanked. THC 26–28% kept (AllBud 26–28, SeedFinder 27). Other versions by Lit Farms and Taylormade Selections exist and were not merged. Lean left blank.
- **Lemon Candy**: SeedFinder (Exotic Seed: probably H.O.G x NYC Diesel, sativa-leaning) is the only independent source; a 710 Genetics Lemon Candy exists too and growers-notebook is not independent. Two versions, no agreement. No data.
- **NYC Diesel** (existing s1160): Leafly + AllBud agree THC ~18–21% (20% / 18–21%), sativa-leaning, grapefruit/diesel flavor. THC filled "18–21%". Parent genetics left as is (Leafly Afghani x Mexican; AllBud Sour Diesel x Afghani/Hawaiian; SeedFinder differs again). Effects kept (Leafly talkative/uplifted/energetic, AllBud euphoric/happy/sociable don't overlap enough to change).

## Sheet row-by-row research — Batch S33 (rows 3028–3032)

- **Sunburn** (existing s489, corrected): Leafly + AllBud agree Island Sweet Skunk x Rug Burn OG, crossed again with Gupta Kush; Colorado Seed Inc named by Leafly + SeedFinder (not Helping Hands Herbals). Effects Uplifted/Creative/Energetic (Happy was AllBud only), flavor citrus. THC blanked (Leafly 20%, AllBud 16–17%, SeedFinder 24% for a different Sunburn x Gupta Kush cross). Generic Limonene/Myrcene/Linalool terps and unsupported ailments removed. Parents filled. Lean left blank (AllBud 80/20, Leafly sativa-leaning). Held: alias Sbn (Leafly only).
- **Green Tea** (added s7385): Forbidden Fruit x Gelato from AllBud + Leafly + SeedFinder (Moscaseeds). Type Hybrid, flavor "citrus and berry" (all three). Held: breeder (SeedFinder's Moscaseeds only; Leafly says brands such as Good Day Farm sell it), lean (AllBud indica-dominant 65/35 only), THC 18–22% (AllBud only), effects (AllBud and Leafly lists barely overlap), alias GrT (Leafly only).
- **Broze**: SeedFinder only (Higher Heights; BanjoRoze x Russian Lemon; breeding line used for Green Apple Gas, Carambola, Pineapple Mojito). No second source. No data.
- **Bluebear OG** (added s7384): AllBud + SeedFinder (SmokeSmith Genetics "Blue Bear OG") agree 3 Bears OG x (Bluestreak x Lowryder). Alias Blue Bear OG, flavor "blueberry and gas" (AllBud berry/blueberry/gas; SeedFinder breeder text). Held: breeder SmokeSmith Genetics (SeedFinder only), THC 14–16%, effects, autoflower status (AllBud calls it an autoflower, SeedFinder unclear).
- **Jamaican Pearl** (existing s397, corrected): Sensi Seeds, Marley's Collie x Early Pearl from Leafly + SeedFinder (AllBud differs: Early Pearly x Jamaican Indica). THC 15–19% → 22% (Leafly + AllBud). Effects Euphoric/Uplifted/Creative (Happy was AllBud only), flavor "sweet and tropical". Generic terps and unsupported ailments removed. Lean left blank (AllBud 60/40, SeedFinder 85/15).

## Sheet row-by-row research — Batch S34 (rows 3033–3039)

- **Hawaiian Haze** (existing s454, corrected): Leafly + SeedFinder (Abraxas) agree Haze x Hawaiian(sativa) and call it a sativa; AllBud agrees on a Hawaiian cross and "primarily sativa". Type Hybrid → Sativa, parents filled, effects Creative + Euphoric (the only ones backed by Leafly user reports and AllBud), flavor "tropical pineapple" (Leafly + AllBud). THC blanked (Leafly 17%, AllBud 26%), generic terps and unsupported ailments removed. Held: breeder (Abraxas Seeds on SeedFinder, Cosmic Wisdom also lists one), alias Hhz (Leafly only), lean.
- **Legend Orange Apricot** (existing s4896, corrected): Leafly + GrowDiaries + SeedFinder agree Legend OG x Orange Apricot, Capulator/Compound Genetics. THC 16-19% (AllBud, which lists the Orange Apricot parent's genetics) → 23% (Leafly + GrowDiaries); effects → Uplifted + Relaxed (Uplifted in all three, Relaxed in GrowDiaries, AllBud and Leafly's text). Flavor "Citrus and apricot." kept. Held: lean, terpene ranking (GrowDiaries inconsistent).
- **Helmand**: SeedFinder only (The Landrace Team and The Real Seed Company pages: south Afghanistan indica landrace). No second source. No data.
- **Exodus Cheese** (existing s1091, merged into UK Cheese s1240): Leafly's UK Cheese page says it is also known as Exodus Cheese, its Exodus Cheese page lists UK Cheese as an alias, and SeedFinder's Exodus (UK) Cheese is the same Skunk #1 Cheese cut, so these are the same strain. Merge [s1091 → s1240]; alias Exodus Cheese added to UK Cheese. Combined data (Leafly x2 + AllBud): THC 17–20%, effects Happy/Relaxed/Euphoric, flavor "pungent cheese and skunk"; unsupported ailments removed; the wrong Green House Seed Co. breeder and the sample-style terpenes on s1091 are gone with the merge. Held: lean (AllBud sativa-dominant, SeedFinder mostly indica), breeder (cut from the Exodus community, unknown). Check-ins on s1091 will move to UK Cheese. Exodus Kush's parent label "Exodus Cheese (UK Cheese)" needs no change.
- **Zawtiatti → Zawtlatti** (added s7386): the sheet name is a misspelling. Cannarado Genetics, Zawtz x Gelatti confirmed by SeedFinder, Leafly and AllBud (SeedFinder and AllBud mark the Gelatti side as BX). Flavor "pine and gas" (Leafly pine/gas/chemical; AllBud pine/diesel). Held: THC 20–25%, effects, and the other flavor notes (AllBud only), alias ZTI (Leafly only).

## Sheet row-by-row research — Batch S35 (rows 3042–3046)

- **Chem Tang**: no page under this name; Leafly and AllBud spell it Chem Tange (alias The Tange; Tangerine x Chemdog; La Coute's North Farms), which is already in the library as s3656. The sheet name was not added as an alias since no source uses it. Row marked no data. s3656 corrected anyway: type Sativa → Hybrid (Leafly hybrid, AllBud sativa-dominant hybrid), effects Uplifting/Focused/Motivated → Euphoric + Focused (both sources), THC blanked (Leafly 9% vs AllBud's untested 21–29% estimate), alias The Tange filled.
- **Orange Crush** (existing s1168, corrected): Leafly + AllBud + SeedFinder (BC Growers Association) agree California Orange x Blueberry. Parents filled, THC 13–18% → 15–22% (Leafly 15, AllBud 15–22, SeedFinder lab 17.8), effects Talkative/Tingly/Hungry → Happy + Uplifted, flavor "sweet and tangy orange" (all three), generic terps blanked. Lean left blank (AllBud sativa-dominant 80/20, SeedFinder mostly indica). Held: alias Oc (Leafly only).
- **Yumbolt**: SeedFinder only, with several different versions (Philosopher Seeds: Afganii x Himalaya, 100% indica; Sagarmatha, Expert Seeds and CBD Seeds editions); Leafly page unreachable. No data.
- **Champagne Kush** (existing s2006, corrected): Leafly + AllBud agree Hindu Kush x Hash Plant, alias Champagne, breeder unknown. The Seedism Seeds breeder on the entry belongs to a different strain (SeedFinder + GrowDiaries: Super Silver Haze Champagne cut x Pot of Gold; GrowDiaries repeats the breeder text so not independent), so the breeder is cleared and that version is not added. Effects → Euphoric + Happy (both sources), THC blanked (Leafly 14%, AllBud 26%), flavor reduced to "sweet" (Leafly pear/lavender/tea vs AllBud berry/citrus/hash/sweet).
- **Magnum Auto**: SeedFinder only (420 Genetics autoflower of Buddha Seeds' Magnum, s7119). No second source. No data.

## Sheet row-by-row research — Batch S36 (rows 3048–3052)

- **Cookie Jar** (existing s6906): SeedFinder (Greenlife Seeds US) + AllBud agree Platinum GSC x a White Fire Alien OG line (SeedFinder "Wifi Alien OG", AllBud "Fire Alien OG"; WiFi OG is White Fire OG, so the existing parents stand) and a sweet baked-cookie flavor, which is now filled as "sweet baked cookies". Held: lean (SeedFinder 60/40 sativa, AllBud 70/30 indica), THC 24% and effects (AllBud only; SeedFinder's couch lock/floating doesn't overlap).
- **Snow Monster** (existing s562, corrected): Leafly + AllBud + GrowDiaries agree The White x Starfighter, Exotic Genetix (AllBud spells it Exotica), indica-dominant. Breeder, parents and lean Indica-dominant filled. THC 12–19% → 17–25% (Leafly 17, AllBud 21–25, GrowDiaries 17–25), effects → Relaxed/Sleepy/Giggly (all three), flavor "earthy skunk and blue cheese" (Leafly + GrowDiaries), generic terps and unsupported ailments removed. Held: alias Snm (Leafly only).
- **Fire Kush**: only a jointcommerce blog (OG Raskal Genetics, Emerald Fire OG x OG Kush; not independent); Leafly pages unreachable and AllBud has no Fire Kush (only Fire OG). No data.
- **Emerald Triangle**: a region and a SeedFinder breeder name (Humboldt/Mendocino/Trinity), not a strain. Skipped.
- **3 Chems** (existing s2473, no change): AllBud + Leafly + SeedFinder agree on a Chem/Tres Dawg cross (AllBud Chem 91 x Chemdog x Tres Dawg; SeedFinder Top Dawg's Stardawg x ONYCD, same lines) and a chemical flavor. Existing entry kept. Held: effects (AllBud sedating vs Leafly energetic/creative/focused), aliases 3Ch.

## Sheet row-by-row research — Batch S37 (rows 3053–3057)

- **Cherry Thai** (existing s1347, corrected): AllBud + GrowDiaries agree Cherry Bomb x Oregon Purple Thai, sativa-dominant 70/30, THC 16–19%, effects Euphoric/Uplifted/Tingly, flavor diesel/sour/spicy herbal. Parents and lean (Sativa-dominant) filled; THC 14–22% → 16–19%; effects Energetic/Clear-headed/Creative → Euphoric/Uplifted/Tingly; flavor → "sour diesel with spicy herbal notes"; generic terps blanked. Reeferman Seeds breeder cleared (GrowDiaries: original breeder unknown; no source found for it). Leafly's own list (Euphoric/Focused/Aroused, one reporter) and alias CTh not used.
- **Mother of All Berries** = Mother of Berries (existing s36, corrected): Leafly + GrowDiaries list the aliases MOB, Mother of All Berries and Maine Original Blueberry (AllBud mentions MOAB/MOB). Blueberry x Jerry Berry (AllBud + GrowDiaries; Leafly gives Blueberry). Aliases and parents filled; THC 16–24% → 18–21% (Leafly 18, GrowDiaries 20, AllBud 19–21); CBD 10–21% blanked (GrowDiaries 0.2%); flavor "sweet blueberry"; generic terps and unsupported ailments removed. Effects kept (Relaxed/Sleepy/Happy/Hungry each in two of three sources). Held: breeder T.H.Seeds (GrowDiaries only), lean (AllBud 90/10).
- **Cherrylicious**: only a jointcommerce blog (not independent); Leafly and AllBud pages missing or unreachable. No data.
- **41 Cherries** (existing s2975, no change): AllBud confirms Gelato 41 x Black Cherry Gelato, aliases 41 Cherry/Cherries 41, THC 20–23%, indica-dominant. Leafly unreachable, so no further changes.
- **Golden Strawberries** (added as Golden Strawberry s7387, alias Golden Strawberries): Golden Goat x (Sour) Strawberry from AllBud + SeedFinder (The Farm Genetics) + Leafly's alternate lineage note. THC 20–23% (SeedFinder, Leafly 23%, AllBud 18–26%), effect Uplifted (Leafly + AllBud), flavor "sweet berry". Held: breeder (SeedFinder's The Farm Genetics; AllBud review says Korova), lean (AllBud 60/40, SeedFinder sativa-dominant), other effects, alias Gds (Leafly only). Leafly also lists a Kosher Kush x Strawberry Banana version.

## Sheet row-by-row research — Batch S38 (rows 3058–3063)

- **Alien Kush** (existing s1013, corrected): AllBud + GrowDiaries + Leafly agree LVPK x Alien Dawg (already stored). AllBud and GrowDiaries give 50/50 (Leafly labels it indica), so lean set to Balanced. THC 21–27% → 20–21% (GrowDiaries ~20, Leafly 21, AllBud 14). Effects → Euphoric/Happy/Relaxed (Euphoric and Relaxed in all three; Happy in AllBud + GrowDiaries). Flavor → "earthy pine with spicy herbal notes" (AllBud + GrowDiaries). Generic terps blanked and the unsupported The Cali Connection breeder cleared. Held: breeder Franchise Genetics/Obsoul33t (GrowDiaries only), terpene ranking (Leafly only), alias Alk (Leafly only), Tingly (Leafly only).
- **Irene Alien OG**: only SeedFinder (Obsoul33t Genetics, mostly indica, probably Irene x Alien OG, lineage flagged uncertain, no effects or flavor, "used for several crosses"). AllBud and Leafly have no page; GrowDiaries has no data. Single source, so no entry. Not merged with Irene OG s7042 (no evidence).
- **Aliendog Cherry**: appears only as a parent in Obsoul33t crosses (SeedFinder, seed retailers) and a Grow West terp sauce; no strain page at AllBud or Leafly, and Leafly's Cherry Alien OG page does not mention the name. No data.
- **Alien Technology** (existing s939, corrected): AllBud + GrowDiaries + Leafly agree Afghan landrace indica, Obsoul33t, alias Alien Tech. THC 22–30% → 13–19% (AllBud 13–19, GrowDiaries up to 19, Leafly 14). Effects → Happy/Relaxed/Euphoric/Sleepy (Happy and Relaxed in all three; Euphoric in AllBud + Leafly; Sleepy in AllBud + GrowDiaries). Flavor → "spicy herbal and woody with mint" (AllBud + GrowDiaries). Generic terps blanked. Ailments left unchanged (AllBud + GrowDiaries list Pain/Stress/Depression among others; Leafly lists none). Held: terpene ranking (Leafly only), lean.
- **Koffeeberry**: only Leafly's Nasha product page and Nasha Hash's own page (same brand, so one source): Pinkleberry x Koffee, Green Source Garden, black cherry/fennel/orange peel flavor. AllBud and Leafly strain pages unreachable. No data. Library has Koffee F5 (s4842), Koffee Cake and Kaya's Koffee but no Koffee Berry.

## Sheet row-by-row research — Batch S39 (rows 3064–3068)

- **Cherry Icee** (added as s7388): AllBud + Leafly agree on a hybrid, 55/45 indica/sativa (Balanced), parents unknown, THC 12–14% (AllBud 12–14, Leafly 12.5), effects Creative/Happy (in both; AllBud also Uplifting/Aroused/Calming, Leafly Energetic), flavor berry/cherry/sweet (Leafly adds citrus). Held: ailments, alias "CI" (Leafly only), CBD. Lemon Cherry Icee and Black Cherry Icee are different strains.
- **Phamer OG**: AllBud page empty, Leafly unreachable, web searches return nothing for the name (not Pharmer's Market OG Kush, which is a brand product). No data.
- **Fireside**: AllBud page empty, Leafly unreachable, no strain pages found. No data.
- **Strawberry Pie Auto**: several versions with different lineage: Fast Buds (GrowDiaries: Strawberry Fields x Blueberry Auto, ~26% THC; Leafly Fast Buds product page lists no parents), Original Sensible Seeds (SeedFinder: Strawberry Pie x unknown ruderalis), Dutch Genetics also lists one. GrowDiaries and the Leafly page repeat Fast Buds' own description, so they are not independent, and AllBud has no page. No data; not merged with Strawberry Pie s7294 (photoperiod, Raw Genetics).
- **Cherry Cola** (added as s7389): type Hybrid per AllBud (indica-dominant hybrid, 70/30); Leafly's breadcrumb says Indica, and degree is single-source, so lean left blank. Effects Relaxed/Hungry/Uplifted (Leafly's own list; AllBud lists all three), flavor berry/sweet/tree fruit in both. Held: parents Cherry Cookies x Zkittlez BX1 (AllBud; Leafly reviewers only guess, one says Brainstew x Runtz), THC 19–20% (AllBud only), breeder (Local Grove is a reviewer comment), ailments, lean. Leafly slug is "cherry-kola", no alias listed.

## Sheet row-by-row research — Batch S40 (rows 3069–3074)

- **Glazed Black Cherries** (existing s4413, no change): Weedmaps + SeedFinder agree Kief Sweat, Glazed Cherries backcrossed to the Forum Cut GSC (already stored). No usable effects or THC (Weedmaps effects are parent reports; SeedFinder only has breeder text), and Leafly has no page. Held: Weedmaps flavor "ripe dark cherry with a sour gassy edge" (single source). Also merged the duplicate Glazed Cherries s4414 into s3687: identical name, breeder Kief Sweat and parents (Cherry OG x Forum Cut Cookies; Leafly lists one Glazed Cherries, alias Cherry Glaze, Forum Cut GSC x Cherry OG). Merge count now 70.
- **Soul Assassin OG** (existing s2259, lean corrected): AllBud + Leafly both indica-dominant, so lean Indica-leaning → Indica-dominant. Breeder Soul Assassins Crew confirmed by both. No other changes: parents conflict (AllBud Sour Diesel x OG Kush; Leafly says unclassified with an unconfirmed Lemon Thai claim), THC conflict (AllBud 15–20%, Leafly 24%), effects only partly shared (Relaxed, Euphoric in both; Happy/Sleepy AllBud only). Held: Leafly terpenes (Caryophyllene, Myrcene, Limonene), alias Sao.
- **Malverde** (existing s5059): AllBud + SeedFinder agree on sativa-dominant 90/10 and Mexican Survivor (a Michoacán sativa; SeedFinder lists Malverde as a clone of it, breeder Breaking Buds Seeds). Lean Sativa-dominant and alias Mexican Survivor filled; stored THC 20–25% blanked (AllBud lists 28–29%, SeedFinder none). Held: breeder (SeedFinder only; a reviewer says Green Dragon), effects (AllBud only), Leafly unreachable.
- **Tropical Gelato** (added as s7390): three versions with conflicting lineage (Leafly Gelato x Pineapple, GrowDiaries LIT Farms Tropicana Cookies x Watermelon Gelato 42, Weedmaps Tropicana Cookies x Gelato by Colombia Genomic), so no parents or breeder. Hybrid in all three. Effects Creative/Euphoric/Relaxed (Creative in all three; Euphoric and Relaxed in Leafly + GrowDiaries), flavor tropical/pineapple/citrus (Leafly, GrowDiaries, Weedmaps). Held: parents, breeder, THC (18–30% by batch), lean (50/50 vs indica-dominant), terpenes (sources disagree), aliases Trop G/Trp. AllBud has no page.
- **Chocolate OG** (existing s799, corrected and merged): Leafly + GrowDiaries agree THClones, True OG x Chocolate Rain, indica-leaning/dominant, Relaxed + Sleepy, flavor nutty/coffee/earthy, myrcene dominant. Breeder, parents filled; sample-style linalool terps replaced with just Myrcene, effects Happy/Relaxed/Sleepy/Uplifted → Relaxed/Sleepy, flavor → "nutty and coffee with earthy notes", ailments → Pain (AllBud + GrowDiaries), THC 16–25% blanked (sources range 12–36% by batch). Merged Champion City Chocolate (Chocolate OG) s3626, which stored the same THClones/True OG x Chocolate Rain, into s799 and added it as an alias. Held: lean (AllBud 0:100, Leafly indica-dominant, GrowDiaries indica-leaning), second and third terpenes, alias Ctg.

## Sheet row-by-row research — Batch S41 (rows 3075–3080)

- **Strawberry Banana Sherbet** (added as s7391, alias Strawberry Banana Sherbert): Hybrid. Effects Creative/Euphoric/Happy (Creative in AllBud, Leafly and GrowDiaries; Euphoric in Leafly + GrowDiaries; Happy in AllBud + Leafly reviewers), flavor "sweet strawberry" (all three). Spelling variant "Sherbert" is in AllBud's URL and GrowDiaries' listing. Held: parents (AllBud Strawberry Banana x Banana Sherbet; GrowDiaries Crockett Family Farms Strawberry Banana x Sour Banana Sherbet; Leafly none), breeder (GrowDiaries only), lean (AllBud 70/30 indica, GrowDiaries indica, Leafly energizing), THC (22–26%, 18%, 25–29%), terpenes and alias SBS (Leafly only).
- **Cookie Monster** (existing s689, corrected): AllBud + Leafly + GrowDiaries all say indica, Girl Scout Cookies x OG Kush. Type Hybrid → Indica, parents filled, THC 17–22% → 17–21% (AllBud 17–21, Leafly 17, GrowDiaries ~18), flavor → "sweet vanilla and mint with woody pine notes", ailments → Pain (Leafly + GrowDiaries), sample-style terps blanked. Effects kept (Sleepy in all three; Euphoric/Happy in AllBud + GrowDiaries; Relaxed in AllBud + Leafly). Held: terpenes (Leafly only), 2014 Seattle Cannabis Cup (Leafly only), alias Cmr, breeder.
- **Chocolate Chunk** (existing s222, corrected): AllBud + Leafly + GrowDiaries all say pure indica from Afghani; breeder T.H.Seeds kept (Leafly + GrowDiaries). Type Hybrid → Indica, parents ["Afghani"] filled, THC 13–19% → 18–23% (Leafly 18, GrowDiaries 19, AllBud 20–23), effects → Relaxed/Sleepy/Hungry (all three), flavor → "coffee and nutty with earthy pine notes", terps reduced to Myrcene (dominant in Leafly + GrowDiaries), unsupported ailments cleared (GrowDiaries only). Held: alias Chk (Leafly only), second/third terpenes, CBD (AllBud 1–3%, GrowDiaries 0.05%).
- **Chem Breath**: the name covers at least two lineages (Weedmaps: Kosher Chem x Garlic Breath, Gramlin's Garlic Breath x Chemdawg #27, Lost River Chem 4 x Rudeboi OG). SeedFinder supports the Lost River cross stored in s3646 (mostly indica, clone only) but has no effects or flavor; AllBud has no page and Leafly is unreachable. No change; stored effects Euphoric/Sedative and flavor "Sweet, dank" remain single-source.
- **Cookie F2** (existing s3824, no change): only Leafly (Purple Caper, Cookie x Cookie, 50/50, THC 20–22%, Relaxed/Happy/Uplifted, sweet earthy cherry, alias CF2); leafly.ca is the same page. AllBud has no page, GrowDiaries and SeedFinder returned nothing. Stored data agrees with Leafly but has no second source. Held: Leafly's terpene data conflicts with its description (caryophyllene vs myrcene).

## Sheet row-by-row research — Batch S42 (rows 3081–3086)

- **Chocolate Thai** (existing s94, corrected): AllBud + Leafly + GrowDiaries all say Thai sativa landrace; none names a breeder. Type Hybrid → Sativa, DJ Short breeder and the 16–20% CBD cleared (Leafly 0%, GrowDiaries 1%), generic terps blanked, effects → Creative/Focused/Uplifted/Aroused (Creative and Aroused in all three; Focused in all three; Uplifted in AllBud + GrowDiaries), flavor → "coffee and nutty with spicy notes", ailments → Anxiety/Depression/Stress (AllBud + GrowDiaries), alias Thai Sticks added (AllBud + GrowDiaries, "formerly known as"). THC 12–16% kept (AllBud, GrowDiaries description, Leafly 16). Held: Leafly's parent "Tha Thai", terpenes, alias Cht.
- **Fire Lady** (added as s7392): AllBud + SeedFinder agree it comes from Purple Caper (AllBud: backcross; SeedFinder: a Purple Caper phenotype by Purple Caper Seeds) and is indica-dominant (AllBud 70/30, SeedFinder mostly indica). Hybrid, parents ["Purple Caper"], effects Happy/Uplifted (AllBud + Leafly). Held: breeder Purple Caper Seeds (SeedFinder only), THC 20–25% (AllBud; SeedFinder's "up to 25%" is the breeder's claim), flavor (sources differ), Leafly's alias FiL. GrowDiaries has no page.
- **T.I.T.S.** (existing s2351, type corrected): AllBud + Leafly + GrowDiaries all list a hybrid, so type Sativa → Hybrid (lean Sativa-leaning kept; GrowDiaries leaning sativa, AllBud 70/30 sativa). Parents Sour Diesel x Forum Cut Cookies confirmed by Leafly + GrowDiaries (AllBud says Sour Diesel x OG Kush Breath). Effects and flavor confirmed. Held: breeder (GrowDiaries Diamondback Genetics vs Leafly West Coast Cure; stored Diamondback), terpenes (Leafly only, inconsistent), THC (23–30% by source).
- **Sour Scout**: not added. AllBud lists it as its own page (Forum GSC cut x Sour Diesel, 50/50, 20–27% THC), while GrowDiaries lists "Sour Scout" as an alias of T.I.T.S. (Sour Diesel x Forum Cut Cookies). The genetics are identical, so it is probably the same strain, but AllBud treats them separately and Leafly's Sour Scout page is unreachable. Held as a possible alias/merge for T.I.T.S. s2351; no entry created, no alias added.
- **Cookies-and-Cream** = Cookies and Cream (existing s1523, corrected): AllBud + Leafly + GrowDiaries agree Starfighter x GSC phenotype; Exotic Genetix (Leafly + GrowDiaries) and the aliases were already stored. Flavor → "sweet vanilla and nutty" (vanilla and nutty in all three), unsupported linalool terps blanked. Kept lean, effects and THC 19–24% unchanged (THC sources disagree: 15%, 20%, 26%). Held: Leafly terpene order (Caryophyllene, Limonene, Myrcene), alias Ccr.

## Sheet row-by-row research — Batch S43 (rows 3087–3091)

- **Pre-98 Bubba Kush** (existing s139, corrected): AllBud + Leafly + GrowDiaries agree on an indica (AllBud 85/15, GrowDiaries indica-dominant). Lean Indica-dominant, THC 20% (AllBud + GrowDiaries; Leafly 15%) and CBD <1% filled; effects → Relaxed/Sleepy/Hungry (all three), ailments → Pain/Stress/Insomnia (Leafly + GrowDiaries; Inflammation had no source, appetite loss GrowDiaries only). Breeder Matt "Bubba" Berger and the aliases were already stored (GrowDiaries only for the breeder; aliases in Leafly + GrowDiaries). Held: parents (stored OG Kush x Northern Lights; GrowDiaries says a Northern Lights phenotype pollinated by a Kush bagseed plant, so OG Kush is unconfirmed), terpenes (Leafly limonene vs GrowDiaries caryophyllene).
- **Don Shula** (existing s4015, corrected): AllBud + Leafly + GrowDiaries all list a hybrid (AllBud 70/30 indica, GrowDiaries indica-heavy), so type Indica → Hybrid, lean kept Indica-leaning. The White x Diagonal confirmed by all three. CBD "low" → <1%, terps → Caryophyllene only (dominant in Leafly + GrowDiaries), ailments Depression filled (AllBud + GrowDiaries). Flavor and THC 22% confirmed. Held: breeder (stored The Bank Genetics; GrowDiaries says Dank by Pank), effects "Energized" (AllBud/Leafly describe energizing), AllBud's migraine/headache and fatigue uses, alias Dsl.
- **Woody Nelson**: skipped. It is a Canadian cannabis brand (Weedmaps brand page, BC Cannabis Stores collection), not a strain.
- **99 Cookiez**: AllBud has no page, Leafly and Weedmaps unreachable, searches return only unrelated Cookiez products. No data.
- **Princess Leia** (existing s2829, type corrected): AllBud lists it as a sativa-dominant hybrid (80/20) and Leafly as Hybrid, so type Sativa → Hybrid. Parents Cinderella 99 x Lemon Alien Dawg confirmed (AllBud; a Leafly reviewer). Stored THC 22–28% matches AllBud; effects Creative/Euphoric/Energetic matched Leafly. Held: lean degree (AllBud 80/20, stored Sativa-leaning), flavor (AllBud pineapple/citrus vs Leafly blue cheese), breeder (a reviewer mentions Terrapin), alias PLi. Leia OG s4897 is a different strain.

## Sheet row-by-row research — Batch S44 (rows 3092–3096)

- **Dagwood** (added as s7393, alias DAG): AllBud + Leafly agree Shoreline Skunk x Whitaker Blues, hybrid, alias DAG. Effects Creative/Happy/Relaxed/Uplifted (Creative and Uplifted in both; Happy and Relaxed in AllBud + Leafly reviewers), flavor "sweet berry with herbal skunk notes" (berry, sweet, herbal, skunk in both). Held: breeder (Leafly: Darren Doherty and Jeff Jamnik of Red River Cannabis Coalition), lean (AllBud 50/50), THC (AllBud 23–25%, one Leafly review 23.6%), terpenes (a Leafly review says terpinolene). Dagwood's Sister is a different strain.
- **Ethos Cookies** (added as s7394): AllBud + Leafly + GrowDiaries + SeedFinder agree Mandarin Cookies #17 x Colin OG #1, hybrid; breeder Ethos Genetics (Leafly, GrowDiaries, SeedFinder). Effects Euphoric/Happy/Relaxed/Uplifted (Euphoric in AllBud + GrowDiaries, Happy in AllBud + Leafly + GrowDiaries, Relaxed and Uplifted in AllBud + Leafly), terpene Caryophyllene dominant (Leafly, GrowDiaries, SeedFinder), flavor "citrus and pepper" (citrus/grapefruit in all three, pepper in AllBud + Leafly). Held: lean (AllBud 50/50, Leafly sativa-dominant), THC (22–30% by source), CBD. Ethos Cookies R2 s4154 (phenos #1 x #16 refinement) stays a separate entry.
- **White Poison** (existing s6381, corrected): breeder Five Trees and White Widow x Durban Poison confirmed by Leafly + GrowDiaries (AllBud says a Durban Poison phenotype); effects Energetic/Focused/Euphoric confirmed by Leafly + GrowDiaries; lean Sativa-dominant confirmed (AllBud 90/10, GrowDiaries 90/10, Leafly). THC 22% → 22–27% (Leafly 22, GrowDiaries 22–27, AllBud 24–27), flavor "Pine, skunk." → "diesel and cheese with sage" (Leafly + GrowDiaries), CBD <1% and Terpinolene dominant filled (Leafly + GrowDiaries description; GrowDiaries' comparison table says caryophyllene). Held: ailments (GrowDiaries only), alias Wpn.
- **Colombian** (existing s1286, sample-style data cleared): only GrowDiaries has a page (100% sativa landrace, 17% THC, Creative/Energetic/Talkative, honey and spicy herbal; also spelled Columbian); AllBud has no Colombian page (only Columbian Gold) and Leafly is unreachable. The stored THC 23–31%, terps, effects Talkative/Sleepy/Creative and flavor had no support and are blanked. Held: GrowDiaries' type (Sativa), effects, flavor, THC; related entries Colombian Gold s223 etc. unchanged.
- **Double G** (existing s1399, sample-style data cleared): the name covers different strains (SeedFinder: Ripper Seeds' 100% indica Afghani cross, and an Unknown or Legendary G13HP x Gum13 line; a Matter indica-hybrid product on Weedmaps). SeedFinder's DMan Seeds breeder page lists no Double G, so the stored DMan Seeds breeder is cleared along with the THC 23–31%, CBD, terps, effects and flavor. AllBud has no page, Leafly and GrowDiaries have nothing. Held: all of it, pending one agreed version.

## Sheet row-by-row research — Batch S45 (rows 3097–3101)

- **Illuminati OG Kush** = Illuminati OG (existing s808, corrected): AllBud + Leafly + GrowDiaries agree it is a direct cut of Josh D's 1996 Club 33 OG; AllBud + GrowDiaries say indica-dominant (70/30), Leafly lists Indica. Lean Indica-dominant filled (type kept Indica); THC 12–17% → 22% (AllBud + GrowDiaries); effects → Relaxed/Sleepy/Euphoric/Giggly (Sleepy in all three, Euphoric and Giggly in AllBud + GrowDiaries, Relaxed in AllBud + Leafly); flavor → "pine and spicy herbal with sweet notes"; ailments → Stress/Insomnia (Leafly + GrowDiaries); generic terps blanked. Held: alias "Illuminati OG Kush" (no source lists it; Leafly says it does not), alias Ill, parents (Club 33 OG cut only), Cocoa Duluce/Northern Lights family-tree links.
- **Panama Red** (existing s407, corrected): AllBud + Leafly + GrowDiaries all say sativa landrace, so type Hybrid → Sativa. THC 23–32% → 16–22% (AllBud 16–22, Leafly 17, GrowDiaries 19); breeder Sensi Seeds cleared (no source; Leafly says Reeferman, GrowDiaries lists several seed sellers); effects → Energetic/Happy/Talkative/Euphoric; flavor → "earthy and woody with tea and pepper notes"; terps → Myrcene dominant (Leafly + GrowDiaries); generic ailments cleared; alias Red added (Leafly + GrowDiaries). Held: parents (Leafly Panama x Colombia), alias Pam/Red Weed/Santa Marta Red, ailments (GrowDiaries only), second and third terpenes.
- **Face Off OG** (existing s324, corrected): Leafly + GrowDiaries agree it is an OG Kush phenotype (Archive Seed Bank, clone only). Parents ["OG Kush"] filled, THC 23–31% → 21–22% (Leafly 22, GrowDiaries 21), effects → Relaxed/Tingly (both), flavor → "pine" (the only flavor in both), ailments → Pain/Stress (both), aliases Face Off, OG Face Off, Faceoff OG Kush, Face Off OG Kush added (both). Generic terps blanked (Leafly myrcene vs GrowDiaries caryophyllene). Held: lean (Leafly 70/30 indica-dominant, GrowDiaries indica-leaning), Sleepy (Leafly only), Euphoric (GrowDiaries only).
- **I-95 Stardawg**: no strain page at AllBud, Leafly unreachable, GrowDiaries nothing. SeedFinder's Star 95 (Top Dawg Seeds, I95 x Purple Star Dawg) does not list it as an alias, and I-95 s6769 and Stardawg s1592 are already separate entries. No data.
- **Tropicana F2**: no strain pages; only product listings (Autumn Brands Tropicana Cookies F2 flower, Massive Seeds MT Tropicana F2 regular seeds), which are different versions. AllBud has no page, Leafly unreachable. No data.

## Sheet row-by-row research — Batch S46 (rows 3104–3108)

- **Project 19**: AllBud has no page, Leafly unreachable, GrowDiaries nothing, searches unrelated. No data.
- **The Cough** (existing s494, corrected): AllBud + Leafly + GrowDiaries agree on Haze x Northern Lights #5, so parents filled and type Sativa → Hybrid (AllBud + GrowDiaries). Effects → Euphoric/Uplifted, flavor → "citrus and pine", unsupported terps and sample-style ailments cleared. THC 15–19% kept (AllBud 15–19, GrowDiaries 15–23, Leafly 23). Lean left blank. Held: aliases (The Coff, Fort Collins Cough, Colorado Cough), terpenes.
- **NL5 Haze Mist** (existing s853, corrected): Leafly + GrowDiaries agree on Northern Lights #5 x Haze (also Kali Mist; AllBud says NL5 x Haze Mist), Green House breeder kept. Lean Sativa-dominant (AllBud 70/30, Leafly "sativa-dominant"); type Hybrid kept (AllBud + GrowDiaries). Effects → Creative/Energetic (Creative in all three, Energetic in Leafly + GrowDiaries), flavor → "nutty and berry with woody notes" (Leafly + AllBud), ailments → Stress/Depression (Leafly + AllBud), generic terps blanked and Nausea cleared. THC 13–19% left (sources 10–15, ~14.6, 23). Held: Kali Mist parent, aliases Nhm/Northern Lights #5 Haze Mist, Uplifted, Euphoric.
- **Jack**: Leafly, AllBud and GrowDiaries pages unreachable or empty; searches only return Jack Herer, which has its own entry. No data.
- **Walker Kush** (existing s2422, corrected): AllBud + Leafly agree on a hybrid, indica-dominant, Albert Walker x Rare Dankness #1. Type Indica → Hybrid, lean → Indica-dominant, effects → Relaxed/Focused/Sleepy, flavor → "woody and buttery" (both). Held: THC (AllBud 15–18, Leafly 20), terpenes (Leafly only), alias Wkk, Scott Walker Kush.

## Sheet row-by-row research — Batch S47 (rows 3109–3114)

- **Skywalker** (existing s228, corrected): AllBud + Leafly + GrowDiaries agree on Blueberry x Mazar I Sharif, hybrid. Lean Indica-dominant (Leafly + GrowDiaries; AllBud 50/50), THC 21–28% → 15–23% (AllBud + Leafly), effects → Relaxed/Sleepy/Euphoric (Happy had one source), flavor → "sweet and earthy with blueberry notes", ailments → Stress/Pain (Leafly + GrowDiaries; Depression and Insomnia had one source each), generic terps blanked. Held: breeder Dutch Passion (GrowDiaries only), alias Skywalker Kush (no source; Sky and Mazar x Blueberry are listed), Myrcene dominance (Leafly only).
- **Sour Pink Grapefruit** (existing s2881, corrected): AllBud + GrowDiaries confirm Sweet Pink Grapefruit x East Coast Sour Diesel v3 and HortiLab (GrowDiaries). Effects → Energetic/Uplifted/Focused, flavor → "grapefruit and citrus with diesel" (all three), ailments Depression/Stress filled (AllBud + GrowDiaries; Leafly Depression). Held: lean (AllBud 50/50, GrowDiaries 60/40), THC (15–23 vs 15–20), Terpinolene lead (GrowDiaries only), alias SPG.
- **Cosmic Sundae**: only SeedFinder has a page (Newt Brothers Genetics, mostly indica, parentage inconsistent: Intergalactic x White Fire x Ice Cream Dream vs Space Force OG x Ice Cream Dream); AllBud, GrowDiaries and Leafly have nothing and the rest are blog copies. No entry created.
- **Intergalactic** (existing s4741, corrected): all three list a hybrid, so type Indica → Hybrid; lean Indica-dominant (AllBud 80/20, GrowDiaries); THC 18–36.5% → 22–26% (AllBud + GrowDiaries); effects → Creative/Relaxed; flavor → "pine and spicy with diesel notes"; ailments Depression/Stress filled (all three). Held: parents (AllBud Constantine x The Cube, GrowDiaries Gorilla Glue x Constantine, Leafly GG4), breeder Exotic Genetix (GrowDiaries only), alias Int.
- **4 LocoZ** (existing s7104, confirmed no change): GrowDiaries + SeedFinder agree on Dying Breed Seeds, Hindu Z (Zkittlez x Hindu Kush) x Eddy OG, which are already stored. Held: type (GrowDiaries Indica), THC, flavor, effects, ailments (GrowDiaries only; AllBud and Leafly unavailable).

## Sheet row-by-row research — Batch S48 (rows 3115–3120)

- **Daily Driver** (existing s3893, corrected): AllBud + GrowDiaries agree on a 50/50 hybrid, THC 19–20% (kept), Sundae Driver as a parent. Lean Balanced filled, effects Lifted/Munchies/Relaxed → Happy/Hungry/Uplifted, flavor → "sweet and creamy with vanilla" (chocolate and nutty were AllBud only), ailments Depression/Pain/Stress filled. Held: second parent (AllBud Cookies 'N Cream, GrowDiaries Zkittlez; stored Cookies 'N Cream), breeder Cannarado (GrowDiaries only), Relaxed and Euphoric (one source each), caryophyllene (GrowDiaries only).
- **501 OG** = 501st OG (existing s6779, corrected): Leafly + GrowDiaries agree on Skywalker OG x Rare Dankness #1, Rare Dankness breeder and alias 501 OG; both list a hybrid, so type Indica → Hybrid. THC 21–22% filled, terps → Myrcene dominant (both), flavor → "earthy and pine with grape sweetness". Effects Relaxed/Sleepy confirmed. Held: lean degree (Leafly indica-dominant, GrowDiaries leaning indica; stored Indica-dominant kept), ailments and alias 501st (GrowDiaries only), second and third terpenes. AllBud unreachable.
- **Purple Jellato** (existing s5571, corrected): AllBud + Weedmaps + SeedFinder agree on Gelato #33 x Purple Vapor, Dungeons Vault Genetics (Weedmaps + SeedFinder). AllBud and Weedmaps list a hybrid, so type Indica → Hybrid. Effects → Relaxed/Uplifted (both), flavor → "grape with spicy notes" (both). Held: lean (AllBud 70/30 only), THC 24–25% (AllBud only, kept), ailments, terpenes (Weedmaps only, matches stored), Happy/Sleepy (AllBud only). Leafly and GrowDiaries have nothing.
- **Strawberry Kush** (existing s1222, corrected): AllBud + Leafly + GrowDiaries agree on OG Kush x Strawberry Cough, hybrid. Parents filled, THC 23–31% → 18–23% (AllBud 18–23, Leafly 19, GrowDiaries 18), effects → Euphoric/Happy/Uplifted (AllBud + GrowDiaries), flavor → "sweet strawberry with berry notes", terps → Myrcene dominant (Leafly + GrowDiaries), generic terps replaced. Breeder Royal Dutch Genetics cleared (GrowDiaries lists it only among many seed sellers). Held: lean (AllBud 70/30 sativa only), ailments (GrowDiaries only), stored aliases OG Strawberry/Strawberry OGz/Strawberry OG Kush (no source lists them; Leafly lists Stk).
- **Panjab landrace**: AllBud, GrowDiaries and Leafly have no page and searches return unrelated results. No data.

## Sheet row-by-row research — Batch S49 (rows 3121–3126)

- **Death Valley**: AllBud, Leafly and GrowDiaries have no usable page; the only search hit is Death Valley OG (Clone Only Strains), a different strain. No data.
- **Glue 75%** (existing s4421, no change): Weedmaps lists it only as a hybrid and says it is still gathering information; AllBud, GrowDiaries, Leafly and SeedFinder returned nothing; the only other hit is a jointcommerce blog. Held: stored type Sativa, lean, THC 27%, parents GG#4 x 99/OG, breeder Equilibrium Genetics, effects and flavor (no independent source either way).
- **Spanish Moon** (existing s5926, checked, no change): Weedmaps + SeedFinder agree on breeder Lovin' in Her Eyes and (Peach Crescendo x Indigo) x Pirate Cake, which matches the stored parents. Held: type (Weedmaps hybrid only; stored Indica), lean, THC, effects Relaxed/Euphoric and flavor (Weedmaps "energized but at ease, sweet and pungent"; SeedFinder candy/berry/chemical/earth), none with two sources. AllBud, Leafly and GrowDiaries have nothing.
- **Dragonsoul**: only SeedFinder's Dragon Soul (Bodhi Seeds: Goji OG F2 x Hawaiian Sativa x 86 Pipeline Hashplant F3) with no effects, flavor or THC; AllBud, GrowDiaries and Leafly have nothing, and it is unconfirmed that the sheet name means that strain. No entry created.
- **Orange Cookie Chem** (added as s7395, alias OCC): Leafly + GrowDiaries agree on FreeWorld Genetics, Orange Cookies x FreeWorld Chem (GrowDiaries writes "Orange Cookies Kush"), hybrid, alias OCC, effects Energetic/Focused/Uplifted, flavor "orange and citrus". Parents stored as Orange Cookies s1579 and FreeWorld Chem s2614. Held: lean (Leafly 50/50 only), THC (23% vs 27%), CBD, terpenes (Leafly limonene, linalool, pinene vs its own description's myrcene), ailments (GrowDiaries only). AllBud has no page.

## Sheet row-by-row research — Batch S50 (rows 3127–3131)

- **Big O**: only AllBud has a page (Cookies N Cream F2 x Black Label, 50/50, 15–18% THC, calming/happy/relaxing/uplifting, vanilla cookie with cinnamon). Leafly and GrowDiaries have nothing under that name, and Leafly's "O" (Cookies and Cream x Secret Weapon, alias Orz) is a different strain. Single source, held; no entry created.
- **9A95 Kunduz** (existing s2991, checked, no change): only AllBud lists it (Kunduz Afghani x I-95, 50/50, 17–20% THC, alias Kunduz 9a95), which matches what is stored. Weedmaps' Kunduz page calls it a regional Afghan name with differing selections and lists Afghani x Afghani, so it does not confirm the 9A95 cross; Leafly and GrowDiaries have nothing. Held, nothing changed.
- **Triangle Durban**: no page on AllBud, Leafly or GrowDiaries; searches only return Durban Triangle/Triangle Poison blog posts. No data.
- **Emerald OG** (existing s696, corrected): AllBud + Leafly + GrowDiaries agree on Fire OG x Emerald Diesel (GrowDiaries and Leafly: backcrossed to Fire OG) and California Breeders Association (Leafly + GrowDiaries, already stored). Parents filled, lean Indica-dominant (AllBud 70/30, Leafly; GrowDiaries leaning indica), type Hybrid kept. THC 23–29% → 17–24% (AllBud 17–19, Leafly 20, GrowDiaries 17–24). Terps → Caryophyllene/Limonene/Myrcene (Leafly + GrowDiaries), effects → Relaxed/Sleepy/Focused, flavor → "citrus with floral notes", ailments → Insomnia/Stress/Migraines (migraines in AllBud + GrowDiaries), alias Emerald OG Kush filled (Leafly + GrowDiaries). Held: Happy, Euphoric and Depression (one source each), Emerald Kush.
- **Deer Creek #1**: only SeedFinder (ITC Genetics, clone only, a bag-seed find with the Flagstaff male, probably Mass Super Skunk or NL, hybrid, ~65 days, no effects or flavor). AllBud and GrowDiaries have nothing. Single source, held.

## Sheet row-by-row research — Batch S51 (rows 3132–3136)

- **Finola Auto**: no strain page on AllBud, GrowDiaries or Leafly; searches only return Finola, a Finnish industrial hemp cultivar (Wikipedia, finola.fi). No data.
- **Chem Dog** = Chemdawg (existing s1069, filled): AllBud + Leafly + GrowDiaries treat Chemdog/Chem Dog as the same strain. THC 18–19% filled (AllBud 19, Leafly 18, GrowDiaries 19), terps Caryophyllene dominant (Leafly + GrowDiaries), ailments Stress/Pain (Leafly + GrowDiaries). Effects, flavor and breeder confirmed. No alias added ("Chem Dog" with a space is only a spelling variant). Held: lean (AllBud 55/45 indica, GrowDiaries slightly indica-leaning), parents (no source lists them), Chem D, Chem 4, Chem Sis.
- **Chocolate Kush** (existing s168, sample-style data cleared): the name covers different versions. AllBud: Chocolope x Kosher Kush, 14–19% THC; Leafly: a 00 Seeds indica from Mazar I Sharif x another indica, 17% THC, and it notes that Chocolope Kush is sometimes called Chocolate Kush (already stored as an alias on s2055). GrowDiaries has nothing. Only what both versions share was kept: THC 14–19%, flavor "coffee and nutty", effect Sleepy. The generic terpenes, effects Relaxed/Happy/Euphoric, ailments and DNA Genetics breeder had no support and were cleared. Held: parents, breeder, lean (AllBud indica-dominant, Leafly indica), type.
- **Exotikz OZ Kush**: no page on AllBud or GrowDiaries, Leafly unreachable; searches return only OZ Kush (a different strain). No data.
- **Gary Poppins** (added as s7396): AllBud + Leafly + GrowDiaries agree on Gary Payton x Red Runtz and a hybrid; Exotic Genetix (Leafly + GrowDiaries). Lean Balanced (AllBud 50/50, GrowDiaries balanced), THC 25–30% (AllBud + Leafly; GrowDiaries 27), effects Euphoric/Relaxed/Creative/Happy (all three), flavor "lemon and spicy with diesel notes" (all three), ailments Depression/Stress/Pain (all three), Lack of Appetite/Nausea (AllBud + GrowDiaries). Held: Caryophyllene dominance (Leafly only), CBD, alias Gry.

## Sheet row-by-row research — Batch S52 (rows 3138–3144)

- **Key Lime Pie** (existing s1584, corrected): AllBud + Leafly + GrowDiaries agree it is a Girl Scout Cookies phenotype and a hybrid. Lean Indica-leaning → Indica-dominant (AllBud 75/25, GrowDiaries), THC 18–23% → 19–22% (AllBud + Leafly), effects → Relaxed/Happy/Sleepy, flavor → "sweet lime candy and citrus with chocolate notes" (lime, citrus and chocolate in all three). Held: parents OG Kush x Durban Poison (Leafly only), breeder (Burning Bush Nurseries, GrowDiaries only), terpenes (Leafly only), ailments (GrowDiaries only), alias "Key Lime" (not listed; Key Lime Cookies and Key Lime GSC confirmed by Leafly + GrowDiaries).
- **Pine Tar Kush** (existing s138, corrected): AllBud + Leafly + GrowDiaries all call it an indica, so type Hybrid → Indica. THC 15–24% → 18–22% (AllBud 18–22, GrowDiaries 21, Leafly 23), terps → Myrcene dominant (Leafly + GrowDiaries), effects → Relaxed/Sleepy/Euphoric/Hungry, flavor → "pine and woody" (all three), ailments → Pain/Insomnia (AllBud + GrowDiaries), aliases Pine Tar and PTK filled (Leafly + GrowDiaries). Held: breeder (stored Tom Hill; GrowDiaries credits Humboldt CSI and Tom Hill), parents (Leafly Purple Monster/Oregon Noble only), second terpene.
- **Underdog OG** (added as s7397, alias Underdawg OG): AllBud + GrowDiaries agree on Sour Diesel x OG Kush, a hybrid leaning indica (AllBud 60/40), 25–28% THC, effects Happy/Relaxed, aroma earthy; Underdawg OG alias in both. It is treated as a separate strain from Headband s1109: AllBud, Leafly and GrowDiaries's Headband pages do not list it as an alias (GrowDiaries only compares them), and only GrowDiaries's Underdog OG page lists "Loompa's Headband" and links to Headband as a separate page. Held: breeder Loompa Farms, aliases Loompa's Headband/LHB/Underdog, terpenes, ailments (GrowDiaries only); a possible Headband relationship is unconfirmed, no merge.
- **Headband** (existing s1109, corrected): AllBud + Leafly + GrowDiaries agree on OG Kush x Sour Diesel, hybrid, alias HB (Leafly + GrowDiaries). THC 32–35% → 17–24% (AllBud 17–24, Leafly 20, GrowDiaries 19), effects → Euphoric/Creative/Relaxed, flavor → "diesel and lemon with sweet notes", generic terps blanked. Aliases Underdog OG and Underdog removed (no Headband page lists them). Held: lean (AllBud 60/40 indica only), terpenes (Leafly caryophyllene only).
- **Willie Nelson** (existing s291, corrected): AllBud + GrowDiaries agree on Vietnamese Black x Highland Nepalese (Leafly: Nepalese and South Asian sativa); Leafly + GrowDiaries call it a sativa, so type Hybrid → Sativa. Parents filled, THC → 22% (AllBud + GrowDiaries), effects → Creative/Uplifted/Euphoric, flavor → "citrus and pine with earthy notes", ailments → Stress/Depression (all three); generic terps blanked. Held: lean (AllBud 60/40 sativa), breeder Reeferman Seeds (GrowDiaries only, stored), award (GrowDiaries only), terpenes, alias Wln.
- **The Future** = Future (existing s2303, corrected): Leafly + GrowDiaries agree on Exotic Genetix, GG4 x Starfighter and a hybrid, both already stored. THC 30–37% → 21–23% (Leafly 23, GrowDiaries 21; 37% was one reviewer), ailments Depression filled (Leafly + GrowDiaries). Held: effects (Leafly aroused/relaxed/tingly vs GrowDiaries euphoric/creative/focused, so no two sources agree), flavor, lean, terpenes (limonene vs myrcene), alias The Future (neither lists it). AllBud has no page.

## Sheet row-by-row research — Batch S53 (rows 3145–3151)

- **Sophisticated Lady** (existing s5865, corrected): AllBud + Leafly + GrowDiaries agree on Ghost OG x Grateful Breath and a 75/25 indica-dominant hybrid. Type Indica → Hybrid, lean Indica-leaning → Indica-dominant, flavor → "citrus and sour with spicy notes" (AllBud + GrowDiaries). THC 15–24% (AllBud + GrowDiaries) and effects Euphoric/Giggly/Relaxed (AllBud + GrowDiaries) confirmed. Held: breeder Gage Green Genetics (GrowDiaries only, stored), ailments (GrowDiaries only), Leafly's differing effects and flavors, alias SL.
- **Subzero OG**: no page on AllBud or GrowDiaries, Leafly unreachable; searches return only Subzero/Sub Zero, which are separate strains. No data.
- **GAK** (existing s4326, corrected): AllBud + GrowDiaries agree on G13 x AK-47, a hybrid, balanced (AllBud 50/50), Massive Creations (GrowDiaries, stored). Lean Balanced filled, THC 20–22% filled (AllBud 20–22, GrowDiaries 21), effects Happy/Talkative → Euphoric/Relaxed/Uplifted (both). Held: flavor (stored sweet berry and skunky kush; only sweet and berry in both), ailments (GrowDiaries only), GrowDiaries' 25–27% typical THC. Leafly unreachable.
- **Alien Life Form**: only SeedFinder (Mogwai Genetics, Animal Pie x Black Raven, indica-dominant, ~65 days, no effects or THC). AllBud and GrowDiaries have nothing, Leafly unreachable. Single source, held.
- **Gas Pedal OG**: no page on AllBud or GrowDiaries, Leafly unreachable. The nearest matches are Gas Pedal (Leafly: SFV OG Kush x East Coast Sour Diesel, hybrid 50/50, bred by unknown breeders; SeedFinder: Dying Breed Seeds, Chemdawg #4 x Fireball OG), which disagree with each other and do not list "Gas Pedal OG". No data.

## Sheet row-by-row research — Batch S54 (rows 3152–3156)

- **Critter's Cookies** = Critters Cookies (existing s3870, corrected): AllBud + Leafly agree on Cookies x White Fire Alien OG and a 60/40 sativa-leaning hybrid. Parents Cookie Crumbles → Cookies (no source lists Cookie Crumbles), effects Uplifted/Tingly/Relaxed → Euphoric/Relaxed (both), flavor → "lemon and sweet" (both). Lean Sativa-leaning confirmed. Held: THC (stored ~23%; AllBud 29%, Leafly 23%), breeder Greenlife Seeds US (neither lists one), Uplifted/Creative (Leafly only), terpenes (Leafly only), alias CCs. GrowDiaries has nothing.
- **Grape Spritzer**: no page on AllBud or GrowDiaries, Leafly unreachable. Searches return only Spritzer (Weedmaps, AllBud) and Spritzkhana, which are different strains. No data.
- **OZ Kush BX**: no separate strain. SeedFinder lists only OZ Kush BX2 (Full Moon Genetics, mostly indica, ~56 days, parents OZ Kush x OZ Kush BX1 in the description vs OZ Kush x (OZ Kush x Peach Ozzz) in the tree), which is already stored as s7187. AllBud, Leafly and GrowDiaries have nothing. No data, nothing changed.
- **Grandi Guava** (existing s2234, corrected): AllBud + Leafly + GrowDiaries agree on a Gelato/Guava cross and 19% THC; Grandiflora breeder (Leafly + GrowDiaries) and parents already stored. THC 18–24% → 19%, lean Indica-leaning cleared (AllBud 50/50, Leafly leaning indica, GrowDiaries none), generic terps cleared (Leafly caryophyllene vs GrowDiaries myrcene). Effects Uplifted/Energetic/Focused and flavor confirmed. Held: ailments (GrowDiaries only), parent "Guava Gelato" (GrowDiaries), aliases Grd/GrdiGva.
- **Franken Cakes** (added as s7398): Leafly + GrowDiaries agree on Phinest Cannabis, GMO Cookies x Lava Cake and a hybrid; THC 22–23% (Leafly 23, GrowDiaries 22), flavor "diesel and fruity" (both). Held: lean (Leafly indica-dominant vs GrowDiaries indica-leaning), effects (Leafly energetic/creative/uplifted vs GrowDiaries happy/relaxed/sleepy), terpenes (myrcene vs caryophyllene), ailments, alias Franken Cake. AllBud has no page.

## Sheet row-by-row research — Batch S55 (rows 3157–3163)

- **Gorilla Diesel** (existing s4483, no change): only Weedmaps has a page (GG4 x Sour Diesel, hybrid, euphoric/relaxed, earthy diesel/pine/herbal, caryophyllene/limonene/humulene; its description is AI-generated). AllBud, Leafly and GrowDiaries are unreachable or empty. Single source, held. The stored type Sativa, Sativa-leaning, THC 18.5–28%, terps, effects "Energized"/Creative/Focused and flavor have no second source either way and were left unchanged.
- **Boil Over**: only AllBud (Purple Emergency x Gorilla Princess, 50/50, 20–25% THC, Creative/Euphoria/Relaxing/Sociable/Uplifting, lemon diesel with chocolate). Leafly unreachable, GrowDiaries and searches return nothing. Single source, held; no entry created.
- **Mt. Rainier** (added as s7399): AllBud + Leafly agree on Northern Lights #5 x White Lotus and a hybrid; effects Aroused/Happy (both), flavor "pine and sweet citrus" (both), ailment Stress (both). Held: breeder RedEyed Genetics (Leafly only), lean (AllBud 50/50 only), THC (AllBud 16–19% only), terpenes, alias Mount Rainier (Leafly), other ailments. GrowDiaries has nothing.
- **Nigerian Silver** (existing s5252, corrected): AllBud + Leafly + GrowDiaries all list a sativa-dominant hybrid (AllBud and GrowDiaries 70/30), so type Sativa → Hybrid and lean Sativa-leaning → Sativa-dominant. Parents Nigerian x Haze confirmed (Leafly, GrowDiaries), THC 19–20% and CBD 0–1% confirmed (AllBud + GrowDiaries). Effects → Uplifted/Focused/Relaxed/Happy, flavor → "menthol and pine with skunk and woody notes", ailments → Stress/Depression (AllBud + Leafly; stress in all three). Held: terpenes (Leafly myrcene only), alias Nigerian Haze, Energetic (Leafly only), diesel and berry flavors (Leafly only).
- **Love Potion** = Love Potion #1 (existing s82, corrected): AllBud + Leafly + GrowDiaries agree on G13 x Colombian Gold (Leafly: Santa Marta Colombian Gold) and Reeferman Seeds (Leafly + GrowDiaries, stored). Parents filled, lean Sativa-dominant (AllBud 70/30, Leafly 70% sativa, GrowDiaries sativa-heavy), type Hybrid kept, THC 14–20% → 15–18% (AllBud 15–18, GrowDiaries 18), effects → Aroused/Euphoric/Energetic, flavor → "lemon and citrus with floral notes", ailments → Stress/Depression/Anxiety, generic terps blanked. Held: limonene (GrowDiaries only), Happy/Creative/Uplifted (one source each), Fatigue.

## Sheet row-by-row research — Batch S56 (rows 3165–3169)

- **F1 Durban** (existing s4172, no change): AllBud, Leafly and GrowDiaries have no usable page (Leafly and AllBud errored, GrowDiaries empty) and searches return only Durban Z and Durban blog posts. The stored breeder "Jigga (unconfirmed)", type, lean, effects and flavor have no support and were left as is. No data.
- **Golden Boy**: only AllBud (unknown indica genetics, 70/30 indica-dominant, 10–15% THC, calming/creative/hungry/uplifting, fruity and woody). Leafly returned only a Sech product page, GrowDiaries and Weedmaps nothing. Single source, held; no entry created.
- **Khalifa Kush** (existing s1866, corrected): AllBud + Leafly + GrowDiaries agree on an OG Kush descendant made for Wiz Khalifa, a hybrid, and alias Wiz Khalifa OG. Lean Indica-leaning → Indica-dominant (AllBud 80/20, GrowDiaries 80% indica-dominant), THC 21–29% → 21–27% (AllBud 24–27, Leafly 21, GrowDiaries up to 26), effects → Relaxed/Creative/Euphoric, flavor → "lemon and pine with citrus notes". Ailments Stress/Depression filled (AllBud + GrowDiaries; the stored list was empty). Held: breeder (Cookies Seed Bank, GrowDiaries only), terpenes (Leafly limonene only), aliases KK (already stored), Kalifa Kush.
- **Lemonchello Haze**: two different versions. AllBud's Limoncello Haze (Lemon Ice x Super Silver Haze, 75/25 sativa, 18–21% THC) is already stored as s4989. Seedsman's Lemonchello Haze (Super Lemon Haze or Super Silver Haze x Amnesia, x UK Cheese, ~70% sativa) has pages only on GrowDiaries's seedbank and SeedFinder, which repeat the breeder's own description and conflict on the first parent. No two independent sources agree, no entry created, no merge.
- **Jungle Diamonds** (added as s7400): AllBud + Leafly agree on a Slurricane cross, a hybrid, 60/40 indica-leaning, and Uplifted. Stored with parents ["Slurricane"] only, effects Uplifted, flavor "sweet" (AllBud sweet, Leafly sweet cream). Held: second parent (AllBud Gorilla Glue #4 vs Leafly Gelato #33), breeder Jungle Boys (Leafly only), THC (17–24% vs 20–25%), alias JDI, berry/chocolate/coffee vs citrus/lavender flavors, ailments (AllBud only). GrowDiaries has nothing.

## Sheet row-by-row research — Batch S57 (rows 3170–3174)

- **Cajun Moon**: only SeedFinder (Lovin' in Her Eyes, genetics unknown, no type, THC, effects or flavor). AllBud and GrowDiaries have nothing, Leafly unreachable; the other hits are Cajun Moon BX / Cajun Mints, which are separate strains. Single source, held; no entry created.
- **Raskal's** = Raskal's OG (existing s5639, no change): AllBud (Royce's Raskal OG, Cali Connection) + Leafly (Raskal OG, Cali Connection, OG Kush x SFV OG Kush) confirm the stored breeder and parents, and Leafly lists the alias Raskal OG Kush (stored). Held: lean (AllBud's Royce version is 50/50), terpenes (Leafly caryophyllene-first vs stored limonene-first; AllBud none), flavor "bright citrus" and effects Happy/Relaxed (one source each). Left unchanged.
- **Tahoe** = Tahoe OG (existing s1229, corrected): Leafly + AllBud agree on sleepy/relaxed effects, pine/lemon/earthy-woody flavor, ~20–21% THC, and insomnia, pain and lack of appetite. Stored sample-style values replaced: THC 26–28% → 20–21%, effects Hungry/Energetic/Talkative → Relaxed/Sleepy, flavor → "pine and lemon with earthy, woody notes", generic terpenes blanked, unsupported breeder Cultivation Specialists blanked, ailments Insomnia/Pain/Lack of Appetite filled. Held: lean (AllBud 90/10 indica-dominant only), parents OG Kush x SFV OG Kush (Leafly only; AllBud says only an OG Kush descendant), terpenes (Leafly myrcene-first only), alias Tahoe OG Kush (Leafly only), Hungry (Leafly only). Other Tahoe-named strains (Buddha Tahoe, Pre-Soviet Tahoe, etc.) are separate.
- **Peanut Butter & Jealous** = PB & Jealous (existing s7197): SeedFinder lists Robin Hood Seeds, Oregon Raspberry x Peanut Butter Breath (already stored); the only other hits are JointCommerce blog copies (not independent). Alias "Peanut Butter & Jealous" added; no other values written.
- **Promiscuous Kush**: only SeedFinder, repeating the breeder's page (MadCat's Backyard Stash, Nightmare OG-based, 30–32% THC, sativa-leaning hybrid, ~90 days). AllBud and GrowDiaries have nothing, Leafly unreachable. Single source, held; no entry created.

## Sheet row-by-row research — Batch S58 (rows 3176–3180)

- **Conspiracy Kush** (existing s119, corrected): AllBud + Leafly agree on Obama Kush x Space Queen and a 70/30 indica-dominant cross. Parents filled, lean Indica-dominant, THC 13–17% → 15–22% (AllBud 15–22, Leafly 19), effects → Relaxed/Happy/Sleepy (both), flavor → "peppery with citrus notes" (both), ailments → Pain/Insomnia (both; the stored Lack of Appetite, Stress, Inflammation each had at most one source). Generic terpenes blanked (Leafly terpinolene-first only). Breeder TGA Seeds blanked (unsupported; Leafly says Heroes of the Farm Genetics, AllBud none). Held: Euphoric (AllBud only), Stress (Leafly only), Depression/Inflammation (AllBud only), alias Csp (Leafly only). GrowDiaries has nothing.
- **Lilly** (existing s7098, corrected): Leafly + GrowDiaries agree on 20–21% THC, effects Energetic/Happy, and a pineapple/tropical-fruit flavor. THC and effects filled, flavor trimmed to "pineapple and tropical fruit". Stored Delicatessen, Jauja x Queen Mother and alias Pina Colada come from GrowDiaries (Leafly lists neither); stored lean Sativa-leaning kept (Leafly sativa, GrowDiaries mostly sativa). Held: ailments (GrowDiaries only), candy-like sweetness, terpenes (the sources disagree). AllBud errored.
- **Medicine Man** (existing s1155, corrected): AllBud + Leafly + GrowDiaries agree on a hybrid with Sleepy effects, berry flavor, and Pain/Stress. Lean Indica-dominant (AllBud 80/20, GrowDiaries indica-dominant), THC 17–25% → 18–23% (Leafly 18, GrowDiaries 20, AllBud 23), effects Talkative/Aroused/Calm → Happy/Sleepy, flavor → "berry and sweet" (AllBud + GrowDiaries), generic terps blanked, ailments Pain/Stress/Anxiety filled (Anxiety: Leafly + GrowDiaries). Held: breeder Shantibaba (GrowDiaries only, stored), parents (the three sources disagree), alias White Rhino (AllBud + GrowDiaries; Leafly calls it a separate relative), Euphoric/Aroused (AllBud only), Tingly/Focused (Leafly only), Insomnia/Depression/Migraines (AllBud only).
- **Sweet Grass**: only AllBud (a hemp/CBD cultivar, Otto II Franklin x (Ringo's Gift x Cobbler), 70/30 sativa-dominant, CBD 12–15%; aliases Sweetgrass, Sweet Grass Hemp). Leafly errored, GrowDiaries empty, searches return only dispensary pages. Single source, held; no entry created.
- **Cherry Uno**: AllBud returned only a generic hybrid listing, Leafly errored, GrowDiaries empty, searches return only generic Cherry strain posts. No data.

## Sheet row-by-row research — Batch S59 (rows 3182–3186)

- **Maui Dawg**: only AllBud (indica-dominant hybrid 80/20, Sour Diesel x Afghani crossed with Maui, Super Skunk and Chem D, 19–30% THC, hungry/relaxing/uplifting). Leafly, Weedmaps and GrowDiaries errored or empty; searches return only Diesel Maui Dawg (Emerald Mountain), Maui Skunk Dawg and other Maui crosses, which are separate. Single source, held; no entry created.
- **Tangelo Kush** (added as s7401): AllBud + Leafly + GrowDiaries agree on Chemdawg x Burmese Kush and a hybrid. Lean Sativa-dominant (AllBud + GrowDiaries 80/20), THC 17–21% (Leafly 17, AllBud and GrowDiaries 21), effect Giggly (AllBud + GrowDiaries), flavor "orange and citrus" (all three), ailments Anxiety/Depression/Stress/Pain/Lack of Appetite (each in two or more). Held: breeder Abakaba Heirlooms (GrowDiaries only), aliases Tak (Leafly) and Tangelo (GrowDiaries), terpenes (Leafly terpinolene vs GrowDiaries myrcene/valencene), effects Euphoric (AllBud only), Energetic/Uplifted/Relaxed (Leafly only), Insomnia (Leafly only).
- **High Society** (existing s2136, corrected): AllBud + Leafly + GrowDiaries agree on Biscotti x Jet Fuel Gelato (stored). Lean Balanced (AllBud 50/50, GrowDiaries balanced), THC 18-27% → 18–25% (Leafly 18, AllBud 21–25, GrowDiaries up to 25), effects → Relaxed/Euphoric/Giggly/Hungry (Euphoric and Relaxed in all three, Giggly and Hungry in AllBud + GrowDiaries), flavor → "coffee and nutty with skunky notes" (diesel had no support), generic terps blanked (Leafly limonene only), ailments Anxiety/Depression/Insomnia/Stress/Pain filled. Held: breeder Compound Genetics (GrowDiaries only, stored), alias HSo, Calm, Focused.
- **Forgotten Cookies** (added as s7402): AllBud + the breeder's pages (Mephisto Genetics, via SeedFinder and the GrowDiaries seedbank) agree on Forum Stomper x Fugue State (AllBud spells it "Fuge State") and a 55/45 sativa split. Stored Balanced, effects Euphoric/Relaxed, flavor "sweet and sour citrus". Held: breeder Mephisto Genetics (breeder pages only; it is an autoflower F1/F4), THC 17–22% (AllBud only), ailments (AllBud and breeder lists do not overlap). Leafly errored.
- **Acai Berry Gelato BX1**: no page for BX1. SeedFinder lists only Acai Berry Gelato BX (Kraken Genetix, Acai Berry Gelato x Crashberry, no other data), which is not confirmed as BX1. Existing s1566 Acai Berry Gelato (Sunset Sherbet x Thin Mint GSC) is a different cut. No data.

## Sheet row-by-row research — Batch S60 (rows 3187–3191)

- **North Fire Cookies**: only SeedFinder (NFC by The NorthFire; parentage given as NFC x NFC in the description and Fortune Cookies x Fortune Cookies "probably" in the tree; ~63 days; birthday-cake/condensed-milk terpene description). AllBud and GrowDiaries have nothing, Leafly unreachable. Single source, held; no entry created.
- **Thai Landrace** = Thai (existing s616, corrected): AllBud + Leafly + GrowDiaries agree on a pure sativa landrace with aliases Thai Stick/Thailand (stored). Effects Happy/Relaxed/Uplifted/Euphoric → Energetic/Creative/Focused/Euphoric (Energetic in all three; the others in two), flavor → "citrus and earthy with woody notes" (AllBud + GrowDiaries, earthy in all three), ailments Stress/Depression/Inflammation (Stress and Depression in all three; Inflammation AllBud + GrowDiaries; the stored Pain was AllBud only). Lean left blank (pure landrace). THC left blank (14%, 19% and 20–24% across sources). Held: terpenes (Leafly only), Tobacco/tea flavor (Leafly only), Anxiety (Leafly only).
- **Caprichosa Thai**: only breeder pages (Élite Seeds via SeedFinder and Zamnesia: Mota Khan Afghana x Super Thai, 12–16% THC, spicy and fresh), plus a JointCommerce blog. AllBud and GrowDiaries have nothing, Leafly has no page. Single source, held; no entry created.
- **Chem 91** = Chemdog 91 (existing s1594, corrected): AllBud ("91 Chemdawg"), Leafly ("Chemdawg 91") and GrowDiaries ("Chemdawg 91") agree on the strain and the stored breeder Greg "Chemdog" Krzanowski (Leafly: unknown East Coast breeder known as Chemdog). THC 20–27% filled (Leafly 21, GrowDiaries 23, AllBud 20–27), effects Energetic → Happy/Euphoric/Creative (each in two sources), ailments Stress/Pain/Depression/Insomnia/Anxiety filled (each in two sources), flavor "diesel with piney-lemon" confirmed. Held: lean (AllBud 50/50 but "sativa dominant", Leafly and GrowDiaries lean sativa), parents (Leafly Tha Thai; others unknown), terpenes (Leafly myrcene vs GrowDiaries caryophyllene), Talkative/Sociable. Flag: s1069 Chemdawg lists Chem 91, Chemdawg 91 and similar as aliases, overlapping with s1594; sources treat "Chem 91" and "Chemdawg 91" as the same strain, but no source says plain Chemdawg and Chemdog 91 are one entry, so no merge.
- **Nepali OG** (existing s6915, no change): AllBud, Leafly and GrowDiaries pages errored or empty, and searches return only JointCommerce blog posts and Nepali Queen (a separate strain, already s5247). The stored breeder Bodhi Seeds is unverified and was left as is. No data.

## Sheet row-by-row research — Batch S61 (rows 3192–3197)

- **Snow Lotus** (existing s6777, corrected): AllBud + Leafly + GrowDiaries agree on Afgooey x Blockhead (stored) and alias Goohead; Leafly + GrowDiaries agree on Bodhi Seeds (stored). THC 16–22% filled (AllBud 16–18, Leafly 22, GrowDiaries ~21), effects Creative/Euphoric/Uplifted/Relaxed filled (each in at least two), ailments Stress/Depression/Anxiety/Pain filled (each in at least two), flavor "Earthy, floral, sweet notes." → "earthy and pine" (AllBud + GrowDiaries; floral had no support). Lean left blank (AllBud 50/50 but "indica dominant", Leafly mostly indica, GrowDiaries indica-leaning). Held: terpenes (Leafly limonene only), Happy/Motivation (AllBud only), chemical/ammonia flavors (Leafly only).
- **Blue Tahoe** = Blueberry Tahoe (existing s6844, corrected): AllBud + Leafly + GrowDiaries agree on Blueberry x Tahoe OG (Kush) and the aliases Blueberry Tahoe/Blue Tahoe OG; Leafly + GrowDiaries agree on New420Guy Seeds (stored). Lean Balanced (AllBud 50/50, GrowDiaries balanced), THC 20-24% → 18–20% (AllBud 20, GrowDiaries 18), effects → Relaxed/Creative/Energetic (Relaxed in AllBud + GrowDiaries and Leafly's "mostly calming", Creative in Leafly + GrowDiaries, Energetic in AllBud + Leafly), flavor → "blueberry with earthy notes", ailments Anxiety/Depression/Pain/Stress filled. Euphoric removed (no source). Held: terpenes (GrowDiaries only), Happy/Uplifted (one source each), alias Bth.
- **Apple Juice** (added as s7403): AllBud + GrowDiaries agree on Sour Apple (GrowDiaries: Orange Sour Apple) x Triple Kush and a 75/25 indica-dominant hybrid; Leafly lists Sour Apple as the parent. Stored with lean Indica-dominant, THC 16–19% (AllBud 16–19, GrowDiaries 16–19/18), effects Relaxed/Euphoric/Creative, flavor "sweet apple with citrus notes" (AllBud + GrowDiaries), ailments Stress/Depression/Anxiety/Pain. Held: breeder (none lists one), alias ApJ (Leafly only), terpenes (GrowDiaries only). Pineapple Juice s6687 already lists Apple Juice as a parent.
- **Maine Pineapple**: AllBud, Leafly and GrowDiaries have no usable page, and searches return only Maine dispensary/vape products and generic Pineapple strains. No data. (Pineapple Juice s6687 lists it as a parent; not verified.)
- **Silver Grapes**: AllBud, Leafly and GrowDiaries have no usable page, and searches return only Silver Grape Sherbet, Super Silver Grape and Super Silver Grapefruit blog posts, which are separate strains. No data.

## Sheet row-by-row research — Batch S62 (rows 3198–3202)

- **Gravy** (existing s7017, corrected): AllBud + Weedmaps (AI-generated from inventory data, used cautiously) agree on Orange Apricot x MAC (stored) and an indica-dominant hybrid (AllBud 70/30). Lean Indica-leaning → Indica-dominant, effect Relaxed filled (AllBud relaxing, Weedmaps relaxed). Held: breeder Good Chemistry (Weedmaps only), THC (AllBud 24–25% only), ailments, Happy/Sleepy/Uplifted (AllBud only). Leafly has no Gravy page (its 5280 Gravy page lists Gravy as a parent) and GrowDiaries is empty.
- **Fried Ice Cream** = Deep Fried Ice Cream (existing s4262, corrected): AllBud + Leafly agree on Ice Cream Cake x Deep Breath and a 70/30 indica hybrid. Type Indica → Hybrid, lean Indica-leaning → Indica-dominant, THC 23% → 16–23% (AllBud 16–22, Leafly 23), effects Happy/Hungry/Sleepy → Relaxed/Euphoric/Happy (all in both), flavor → "sweet vanilla with mint and citrus", ailments Anxiety/Pain/Depression/Insomnia/Stress filled (all in both). Held: breeder Lovena Green Farms (Leafly only, stored), aliases Fried Ice/Fried Ice Cream/Fried Cream (Leafly only; AllBud lists only Deep-Fried Ice Cream; stored), Hungry/Sleepy (Leafly only), Migraines (AllBud only), terpenes. GrowDiaries empty.
- **UK Psychosis**: only AllBud (sativa-dominant 70/30, unknown parentage, 19–21% THC, creative/euphoric/giggly/uplifting, berry and skunky). Leafly errored, GrowDiaries empty, searches return only cannabis-and-mental-health articles. Single source, held; no entry created.
- **Road Dawg** (added as s7405): AllBud + Leafly + GrowDiaries agree on Stardawg x Biker Kush, and Leafly + GrowDiaries on the alias Road Dog. THC 22–26% (AllBud 22–27/26, Leafly and GrowDiaries 22), effects Relaxed/Happy/Focused (all three), flavor "diesel with chemical notes", ailments Stress/Lack of Appetite (AllBud + Leafly). Held: lean (AllBud 70/30 indica, GrowDiaries conflicting, Leafly none), breeder (Karma / Top Dawg Seeds credits differ), terpenes (Leafly myrcene vs GrowDiaries caryophyllene), Depression/Anxiety/Migraines (one source each).
- **Citrus Farmer** (added as s7404): AllBud + Leafly agree on Tangerine Skunk x Grandpa's Breath and a sativa-dominant hybrid. THC 21–30% (Leafly 21, AllBud ~30), effect Energetic (both), flavor "citrus", ailments Depression/Stress. Held: breeder (none listed), alias Cif (Leafly only), terpenes, Focus/Creative/Talkative (one source each), Anxiety. GrowDiaries empty.

## Sheet row-by-row research — Batch S63 (rows 3204–3210)

- **The Purps** = Mendocino Purps (existing s1156, filled): AllBud, Leafly and GrowDiaries all list The Purps as an alias of Mendocino Purps (already stored), and call it a hybrid from Mendocino County. Lean Sativa-leaning (AllBud + GrowDiaries 60% sativa), effects Relaxed → Relaxed/Giggly/Hungry/Happy (each in two or more sources), flavor "grape with caramel coffee and pine notes" (grape, caramel coffee and pine in all three), ailments Stress/Pain/Insomnia/Anxiety (each in two or more). Held: THC ("up to 22%" in AllBud + GrowDiaries only; no range), breeder (BC Bud Depot seeds per Leafly and GrowDiaries, but the cut is clone-only), parents (North American Indica per Leafly, unknown per the others), Depression/PTSD (AllBud only), terpenes (GrowDiaries myrcene only), Cannabis Cup wins (AllBud only). This resolves the Ultimate Purple (s7357) parent "The Purps" to s1156.
- **Turkey**: AllBud returned a generic listing, Leafly errored, GrowDiaries empty, and searches return only Turkish landraces and Turkish Delight, which are separate. Placeholder-like name; no data.
- **Purple Mendo**: AllBud errored/generic, GrowDiaries empty. Leafly has a separate "Mendo Purple" page (17% THC, creative/uplifted/relaxed, diesel/grape/earthy, caryophyllene; no parents, no aliases, and it does not confirm "Purple Mendo" or "Mendocino Purps"). Single source and not a confirmed alias; no data, no change to s1156.
- **Mind Flayer** (added as s7406): AllBud + GrowDiaries agree on Double Tap x Why U Gelly and a balanced hybrid (AllBud 50/50); Leafly lists a hybrid with unclear parents. THC 19–22% (AllBud 19–21, Leafly 22, GrowDiaries ~20), effects Relaxed/Giggly/Uplifted, flavor "sour citrus", ailments Stress/Insomnia/Nausea, terpene Caryophyllene only (Leafly + GrowDiaries dominant). Held: breeder Solfire Gardens (GrowDiaries + SeedFinder breeder listing), alias Mif (Leafly only), Sleepy/Creative (Leafly only), cheese flavor (Leafly + GrowDiaries blue cheese/cheese; one source calls it chemical), Anxiety/Fatigue/Migraines.
- **Secret Cookies** (added as s7407): AllBud + Leafly + GrowDiaries agree on a hybrid. Lean Indica-leaning (AllBud 60/40 indica, GrowDiaries slightly indica-dominant), THC 28–29% (AllBud 28–30, GrowDiaries up to 29), effects Euphoric/Relaxed/Uplifted (each in at least two), flavor "sweet berry with coffee and earthy notes", ailments Stress/Depression/Anxiety (all three). Parents left empty: AllBud Cherry Pie x Girl Scout Cookies, GrowDiaries an Animal Cookies phenotype (Girl Scout Cookies x Fire OG Bx3), Leafly links Confetti Cake and Hidden Pastry. Held: breeder (BC Bud Depot / Bay Exclusives / Seed Junky per GrowDiaries), alias SCk (Leafly only), terpenes (GrowDiaries only).

## Sheet row-by-row research — Batch S64 (rows 3211–3215)

- **Chem Sister** = Chem Sis (existing s6917, filled): Leafly (Chem's Sister) + GrowDiaries (Chem Sis) agree on aliases Chem Sis/Chem's Sister/Chem Sister, a Chemdawg sativa-leaning cut (stored), THC 20–22% (Leafly 22, GrowDiaries up to 20), effect Creative, flavor "diesel and chemical with pungent notes", ailment Depression. Held: breeder Greg "Chemdog" Krzanowski (GrowDiaries only), lean degree (Leafly sativa-leaning, GrowDiaries ~75% sativa; stored Sativa-leaning kept), Energetic/Focused (Leafly only), Euphoric/Giggly (GrowDiaries only), terpenes, Pain/Stress/Inflammation/Lack of Appetite (one source each). AllBud's "Chem Sis" page (Sour Dubb x Chem Sis, no data) was not used.
- **Oz Kush** (existing s7186, filled/corrected): AllBud + Leafly + GrowDiaries agree on Zkittlez x OG Eddy Lepp (stored) and a hybrid; GrowDiaries lists alias OZK (stored). THC 15–24% (AllBud 15–21, GrowDiaries 19, Leafly 24), effects → Relaxed/Euphoric/Happy/Uplifted (each in at least two), flavor → "citrus and pine with woody notes" (replacing the stored sweet candy/cream/gassy wording, which no source supports), ailments Pain/Stress/Anxiety/Muscle Spasms. Held: lean (AllBud 70/30 indica, GrowDiaries leaning indica, Leafly none; degrees differ), breeder (stored Dying Breed Seeds from GrowDiaries; Leafly says 3rd Gen Family Farms and Terp Hogz; left as is), terpenes (Leafly limonene only).
- **TH1**: AllBud generic listing, Leafly errored, GrowDiaries not tried (no results), and searches return only general cannabis genetics articles. No data.
- **Strawberry Milk** (existing s7309, filled): AllBud + GrowDiaries agree on a balanced hybrid (AllBud 50/50), THC 24–26% (AllBud 24–28, GrowDiaries up to 26), and Stress added (AllBud + Leafly) to the stored Depression/Pain. Effects Euphoric/Uplifted/Focused (AllBud + GrowDiaries) and flavor "sweet strawberry" confirmed; both sources say it is not Strawberry Milkshake (s7310). Flag: parents Nepali OG x Instant Karma are from AllBud only; GrowDiaries says Nepalese x Bubba Diesel and Leafly lists Strawberry Headband/Forest Queen, so the stored parents are unconfirmed. Held: breeder Bodhi Seeds (GrowDiaries only, stored), alias StM (Leafly only).
- **Loompa's Headband** (existing s7106, no change): only AllBud has a page (OG Kush x Sour Diesel, 60/40 indica-dominant, 25–28% THC, calming/happy/relaxing/sleepy/uplifting; matches the stored parents and lean). Leafly errored, GrowDiaries empty. Single source; THC, effects and ailments held. The relationship to Headband s1109 (GrowDiaries earlier called Loompa's Headband an alias) is still unresolved; no merge.

## Sheet row-by-row research — Batch S65 (rows 3216–3220)

- **Mango Widow**: only SeedFinder (Mr Nice Seedbank and Omni Seeds listings: Mango Haze x Black Widow, "mostly sativa", ~63 days, no THC, effects or flavor data). AllBud and Leafly errored, GrowDiaries empty. Single source, held; no entry created.
- **Gravy** (second row, 3217): same strain as row 3198, already handled in S62 (existing s7017). Skipped as a duplicate; nothing changed.
- **Zawtlatti** (existing s7386, filled/corrected): AllBud + Leafly + GrowDiaries agree on Zawtz x Gelatti BX (parents "Gelatti" → "Gelatti BX") and Cannarado Genetics (Leafly + GrowDiaries, stored). Lean Balanced (AllBud 50/50, GrowDiaries 50/50), THC 20–25% (AllBud + GrowDiaries), effects Uplifted/Giggly (AllBud + GrowDiaries), flavor "pine and gas" → "sweet berry and cream with diesel and pine" (diesel in all three, sweet/berry/cream in AllBud + GrowDiaries, pine in Leafly + GrowDiaries), ailments Depression/Stress/Lack of Appetite (AllBud + GrowDiaries). Held: aliases ZTI (Leafly) and Zawlatti (GrowDiaries), Talkative/Sociable/Creative/Happy/Hungry (one source each), terpenes (GrowDiaries caryophyllene only).
- **Blue Sonja**: only SeedFinder (GrindHouse Medical Seeds Co., mostly sativa, ~70 days, a BX1 of a select pheno with Block Head/P19 x Sweet Tooth in the tree; no THC or user data). AllBud generic, Leafly errored, GrowDiaries empty; searches return Redhaired Sonja and Blue Dream articles. Single source, held; Ultra Sonja s6271 (GrindHouse) is a separate strain.
- **White '99** = White 99 (existing s2125, corrected): AllBud + Leafly + GrowDiaries agree on Cinderella 99 x The White (stored) and a sativa-dominant hybrid (AllBud 70/30, GrowDiaries 70%). Lean Sativa-leaning → Sativa-dominant, THC 18-25% → 24–25%, effects Uplifted/Happy/Energetic → Uplifted/Focused/Creative (Focused in all three, Uplifted in Leafly + GrowDiaries, Creative in AllBud + GrowDiaries), flavor → "lemon and orange citrus with pine notes", ailments Stress/Depression/Anxiety filled, generic terpenes blanked (Leafly limonene vs stored myrcene/pinene). Held: alias W99 (Leafly only), Euphoric/Energetic (Leafly only), Insomnia/Fatigue (AllBud/GrowDiaries only).

## Sheet row-by-row research — Batch S66 (rows 3221–3228)

- **Wojo Mints** → skip: Wojo Co is a Michigan live-rosin brand and Weedmaps lists "Wojo Mints" and "Wojo Runtz" only as that brand's products. AllBud has no page, Leafly errored, GrowDiaries is empty, and no strain page exists. Brand product line, not a strain.
- **Purple Pebbles**: only AllBud (FPOG x Grape Pie, balanced 50/50, 14–16% THC, calming/happy/mellow/relaxing/uplifting, berry and vanilla; ailments anxiety/depression/PTSD/stress). Leafly errored, GrowDiaries empty, searches return only a JointCommerce blog copy. Single source, held; no entry created.
- **Karmarado 18**: AllBud generic listing, Leafly errored, GrowDiaries not found; searches return only Karmarado OG (s4813), Sour Rado and other Cannarado strains. No data; not assumed to be Karmarado OG.
- **LA Cookies**: GrowDiaries (The Cali Connection, Girl Scout Cookies x LA Affie, 70/30 indica-leaning but labelled indica, 20–25% THC, euphoric/happy/relaxed, earthy and sweet) and SeedFinder's Cali Connection listing (La Affie x Girl Scout Cookies, hybrid/sativa-dominant) both come from the breeder's data. AllBud and Leafly errored. No independent second source, held; no entry created.
- **Phantom Cookies** (existing s7204, filled/corrected): AllBud + Leafly + GrowDiaries agree on Granddaddy Purple x Cherry Pie (stored) and a sativa-leaning hybrid; Leafly + GrowDiaries list the alias Phantom Cookie (stored). THC 20–21% filled (Leafly 20, GrowDiaries 21; AllBud's 12%/15–21% conflict), effects Relaxed/Euphoric/Creative filled (Relaxed in all three, Euphoric and Creative in AllBud + GrowDiaries), flavor → "sweet berry and grape with nutty notes" (stored version added unsupported citrus), ailments Stress/Pain/Depression filled (each in at least two). Lean Sativa-leaning kept (AllBud 70/30, Leafly leaning sativa). Held: breeder Grand Daddy Purp (GrowDiaries only, stored), Hybrid-wide terpenes (Leafly caryophyllene only), alias PHC (Leafly only), Anxiety/ADHD/arthritis (single sources).

## S67 (rows 3229–3235)
- **Ruderalis** → skip: botanical subspecies/descriptor (Wikipedia: low-THC, autoflowering wild Cannabis), not a cultivar. AllBud has no strain page.
- **Grateful Breath** (existing s6857, corrected): Leafly + GrowDiaries agree on OGKB x Joseph OG by Gage Green (stored); AllBud's Cherry Pie Kush x Joseph F1 conflicts and was not used. Effects → Relaxed/Happy/Euphoric (all three share Relaxed and Happy; Euphoric in AllBud + GrowDiaries; Sleepy was Leafly-only). Flavor → "sweet berry and spicy herbal with gassy kush notes" (AllBud + GrowDiaries berry/spicy herbal; gassy kush in Leafly + GrowDiaries). Ailments Depression/Insomnia/Stress filled (each in 2+). Generic Myrcene/Caryophyllene/Limonene terpene set blanked (unsupported). Lean Indica-leaning kept. Held: alias Gfb (Leafly only), THC (stored range kept).
- **Alien Kush F2**: only SeedFinder (OG Raskal Genetics, Alien Kush x Alien Kush, mostly indica, no THC/flavor data) plus a JointCommerce blog copy. Leafly errored, GrowDiaries empty, Weedmaps errored. Single source, held; no entry created.
- **F1 Durban** (existing s4172, corrected): Leafly + GrowDiaries agree on breeder Jigga (confirmed, "unconfirmed" removed), sativa-dominant hybrid (type Sativa → Hybrid, lean → Sativa-dominant), alias F1 Durb, effects Creative/Uplifted (Energized/Sociable were non-vocab). Held: THC (19% vs 23%), flavor (sources conflict; stored text kept), ailments (no overlap), terpenes (Leafly only).
- **Purple Alien Kush**: SeedFinder lists Purple Alien Kush as a parent of Purple Tahoe Alien (Alien Genetics); AllBud has "Purple Alien" (Alien Kush x Tahoe OG, already s2029 Purple Alien OG, aliases Purple Alien); Leafly errored, GrowDiaries empty. No evidence it is the same as s2029, so no merge and no entry. Held.

## S68 (rows 3236–3242)
- **Tahoe Alien** → added as s7408. Leafly + GrowDiaries agree on Alien Genetics and Tahoe OG x Alien Kush (AllBud also lists the cross). Lean Indica-leaning (AllBud and Leafly 60/40, GrowDiaries indica-heavy). THC 20–21% (Leafly 20, GrowDiaries 21; AllBud's "up to 24%" not used). Effects Relaxed/Happy/Euphoric/Hungry (each in 2+). Flavor "lemon and pine with earthy notes" (all three). Ailments Stress/Insomnia/Pain/Nausea (each in 2+). Held: alias "Tah" (Leafly only), terpenes (Leafly only), Lack of Appetite (GrowDiaries only). Note: same cross as Alien OG s1551; no evidence to merge, flagged.
- **Alien Tahoe OG**: AllBud generic hybrid listing, Leafly errored, GrowDiaries empty, Weedmaps errored, search returns only Alien OG / Tahoe Alien guides. No data; not assumed to be Tahoe Alien or Alien OG.
- **Chauffeur** (existing s6912, corrected): AllBud + Leafly + GrowDiaries agree on Wedding Cake x Daily Driver and breeder NorCal's Phinest (stored). Effects add Uplifted (all three; Relaxed/Euphoric in all three, Happy in AllBud + Leafly). Flavor → "citrus and pine with diesel and tropical notes" (stored "smooth and creamy" unsupported). Ailments Anxiety/Depression/Stress filled (all three). Held: lean (AllBud indica-dominant 70/30 vs GrowDiaries indica-leaning), THC (27% vs 34%), aliases Chf/Chffr (Leafly only).
- **Snow Lotus** (row 3241; existing s6777 from S61): Leafly + GrowDiaries both leaning indica, so lean Indica-leaning filled (AllBud 50/50 and "indica dominant" varies by breeder). Terpenes held (same three terpenes in different order, Leafly vs GrowDiaries). Everything else already matched.
- **Razz**: Leafly, AllBud, Weedmaps errored, GrowDiaries empty, searches only return other Razz-named strains. Ambiguous name; no data.

## S69 (rows 3244–3248)
- **Caramel Tsunami**: only AllBud (Animal Tsunami x Caramel OG, indica-dominant 70/30, 15–20% THC). Leafly errored, GrowDiaries empty. Leafly's Animal Tsunami page instead lists Animal Cookies x Caramel Tsunami (matches stored s2137), which conflicts with AllBud's lineage direction. Single source, held; no entry created.
- **Flavor Crystals** → added as s7410. AllBud + GrowDiaries agree on Grape Pie x Legend Orange Apricot (Leafly lists only Orange Apricot); Compound Genetics (Leafly + GrowDiaries); Indica-dominant (AllBud and Leafly label it so, 70/30; GrowDiaries says indica-leaning); THC 21% (Leafly + GrowDiaries; AllBud's 15–20% conflicts); effects Euphoric/Uplifted/Relaxed (each in 2+); flavor "sweet citrus with apricot notes"; ailments Depression/Nausea/Pain (AllBud + GrowDiaries). Held: alias Fcr (Leafly only), terpenes (GrowDiaries only), Anxiety (Leafly only).
- **Grape Octane OG** → added as s7409. AllBud + GrowDiaries agree on Grape Pie x High Octane OG and the alias Grape Octane; THC 24–26% (AllBud 24–26, GrowDiaries 25); effects Creative/Happy/Relaxed/Uplifted (each in both); flavor "grape and berry with diesel and peppery spice"; ailments Insomnia/Pain/Stress (both). Lean blank (AllBud indica-dominant vs GrowDiaries indica-leaning). Held: breeder Cannarado Genetics (GrowDiaries only), terpenes. Leafly errored.
- **Gorilla Dawg** → added as s7411. AllBud + Leafly agree on GG4 x 3 Chems, 70/30 indica-dominant, THC 25–32%, effects Euphoric/Giggly, and sour diesel/chemical with spicy herbal flavor. Held: breeder Mycotek and alias GrD (Leafly only), ailments (Leafly names none; AllBud lists Depression/Inflammation/Nausea/Stress), terpenes (Leafly only). Separate from Gorilla Diesel s4483.
- **Sagarmatha 60/40**: AllBud generic listing, Leafly errored, SeedFinder's Sagarmatha Seeds list has no strain with this name. No data.

## S70 (rows 3249–3253)
- **Guava** (existing s6921, filled): AllBud + Leafly agree on Gelato phenotype (stored parent), sativa-leaning/dominant (degree differs, lean kept), THC 21–22% (Leafly 21, AllBud 22), effect Focused (only effect in both), flavor "tropical fruit" (only flavor in both), ailments Anxiety/Stress (both). Held: terpenes (Leafly only), Depression (Leafly only), breeder Cookie Fam Genetics stays stored (neither source names a breeder). GrowDiaries empty.
- **Sherb Bx** → = Sherb Bx1 s5766 (alias stored). Only AllBud (85/15 indica-dominant, 25–30% THC, creamy/citrus/vanilla gelato flavor) is reachable; Leafly errored, GrowDiaries empty. Single source, nothing changed.
- **Emerald Triangle**: skip, a growing region (NorCal), not a cultivar; AllBud has no strain data and Leafly errored.
- **Chemdawg 91** → alias of existing s1594 Chemdog 91 (and also stored as an alias on s1069 Chemdawg; overlap already flagged). Nothing changed.
- **Lemonchello #28** → = Limoncello s1933 (alias stored). Only AllBud (Original Lemonnade x Cherry Pie, 80/20 sativa-dominant, 15–25% THC) is reachable; Leafly errored, GrowDiaries empty. Single source, nothing changed.

## S71 (rows 3254–3260)
- **Silver Fox** → added as s7412. AllBud + Leafly agree on a sativa-dominant hybrid (70/30), effect Creative, flavor "cheese" (AllBud aroma, Leafly flavor), ailment Stress. Held: parents (AllBud says Exodus Cut UK Cheese phenotype, Leafly says unknown), THC (AllBud 15–22%, Leafly 22%), alias SiF (Leafly only), breeder. GrowDiaries empty.
- **Milk & Cookies** (existing s7135, corrected/filled): AllBud + Leafly + GrowDiaries agree on Cookies and Cream x Triple OG; Leafly + GrowDiaries on Exotic Genetix (stored). Lean Indica-leaning → Indica-dominant (AllBud and Leafly label it indica-dominant at 70/30; GrowDiaries indica-heavy). THC 20% (AllBud + GrowDiaries; Leafly's 15% conflicts). Effects Happy/Sleepy/Hungry/Tingly (each in 2+). Ailments Depression/Stress/Cramps (each in 2+; Arthritis outside the ailment list). Stored flavor kept (creamy/nutty/buttery supported). Held: terpenes (Leafly only), Anxiety (Leafly only).
- **Atom Splitter**: only AllBud (unknown indica-dominant parentage, 70/30, 20% THC); Leafly errored, GrowDiaries empty; searches return only JointCommerce and the 33 Splitter product (Gelato 33 x Atom Splitter). Single source, held.
- **Chem #4** → = Chem 4 s1593 (alias stored). Corrected with Leafly (Chemdawg 4) + GrowDiaries: type Indica → Hybrid (both say hybrid), effects Relaxed/Euphoric/Tingly (Talkative removed), flavor → "pungent chemical with pine notes", ailments Stress/Pain/Anxiety filled, unsupported generic Myrcene/Limonene/Caryophyllene terpene set blanked. Lean Indica-leaning kept (GrowDiaries). Held: parents (Leafly Thai x Nepalese conflicts with GrowDiaries phenotype of original Chemdawg), breeder Greg Krzanowski (GrowDiaries only), THC (25% vs 23%; stored 20–30% kept), terpenes (Leafly only).
- **Chem IBL**: AllBud (Chem D x Chem D BX2, slightly indica-dominant 65/35, 20–26% THC, Euphoric/Giggly/Uplifted, rose/skunky/diesel, aliases IBL Chem/Chem I.B.L.) and SeedFinder's Reservoir Seeds "Chemdog D IBL" (probable Chemdog D x Chemdog D BX#2, listed as indica) agree only on the parentage; SeedFinder repeats breeder data and its name differs. Everything else is single-source, held; no entry created.

## S72 (rows 3261–3265)
- **Gravy**: skip, duplicate of row 3198 Gravy (existing s7017, handled in S62).
- **Gelato #25** → added as s7413. Leafly + GrowDiaries (AllBud errored). Agreed: hybrid, THC 19–20% (20 and 19), effects Talkative/Relaxed/Happy/Euphoric (each in both), flavor "sweet berry and citrus", ailments Depression/Stress/Pain (both). Held: lean (Leafly 50/50 vs GrowDiaries indica-dominant), breeder (Cookie Family Genetics vs Cookies Seed Bank), parents (Leafly Thin Mint GSC x Sunset Sherbet; GrowDiaries gives no full parentage), aliases (no overlap), terpenes (Leafly only).
- **Chem's Sister** → = Chem Sis s6917 (aliases stored; checked in S61). Leafly (Chemdawg parent, Sativa, 22%, creative/energetic/focused, depression/appetite/pain) and GrowDiaries (Greg Krzanowski, 75% sativa, up to 20% THC, creative/euphoric/giggly) were re-read; nothing new reached two-source agreement beyond what is stored. No change.
- **Trainwreck** (existing s1236, corrected/filled): AllBud + Leafly + GrowDiaries agree on a sativa-dominant Thai/Mexican/Afghani landrace cross (parents Mexican, Thai, Afghani filled; AllBud + GrowDiaries list all three, Leafly names Thai and Mexican with Afghani in the description). Effects add Uplifted (all three). Flavor → "pine and lemon with earthy notes" (pine in all three, lemon in AllBud + GrowDiaries, earthy in Leafly/GrowDiaries). Ailments Pain/Depression/Migraines/Anxiety/Stress filled (each in at least two; Migraines in AllBud + GrowDiaries). Held: THC (AllBud 18–25, Leafly 17, GrowDiaries 18), terpenes (Leafly only), alias Tw (Leafly only).
- **Hawaiian** (existing s81, corrected): AllBud + Leafly + GrowDiaries agree on sweet/citrus flavor, Stress/Depression/Pain. Lean filled Sativa-leaning (AllBud 60/40, GrowDiaries leaning sativa, Leafly sativa); THC → 20% (AllBud description + GrowDiaries; Leafly 24%); effects → Happy/Creative/Euphoric (Uplifted and Relaxed removed, unsupported); flavor → "sweet citrus and pineapple with tropical notes"; ailments → Stress/Depression/Pain/Anxiety (Lack of Appetite and Nausea removed); generic Linalool/Limonene/Humulene terpene set and unsupported breeder Super Sativa Seed Club blanked. Held: alias Haw (Leafly only), parents (Leafly lists Pineapple Express/Amnesia Haze as children).

## S73 (rows 3266–3270)
- **Orange Valley OG** (existing s7177, filled/corrected): AllBud + Leafly + GrowDiaries agree on 818 Pure SFV OG x Agent Orange (parents SFV OG, Agent Orange filled); Relentless Genetics (Leafly + GrowDiaries, stored); alias OVO (Leafly + GrowDiaries); THC 20–22% (AllBud 22, Leafly 20, GrowDiaries 18–22); effects Giggly/Talkative/Focused (Leafly + GrowDiaries); flavor → "orange and citrus with coffee and pine notes" (stored "tea" was Leafly-only); ailments Anxiety/Stress (all three); terpenes Caryophyllene > Limonene > Humulene (Leafly + GrowDiaries share the ranking). Lean left blank (AllBud 50/50, GrowDiaries 70/30).
- **Maui Haze**: AllBud generic, Leafly errored, GrowDiaries empty. SeedFinder (Equilibrium Genetics: 1979 Cherry Bomb Maui Wowie x Tom Hill Haze, sativa, musk/pine) plus JointCommerce blog copies only. Single source, held. Separate from Island Maui Haze s458.
- **Pakistani Kush**: AllBud generic, Leafly errored, GrowDiaries empty; search surfaces only Pakistan Valley Kush (s347) and Pakistani Chitral Kush (s348), which exist separately. No data; not assumed to match either.
- **Heirloom Malawi**: no page under that name, and none of the three Malawi pages list it as an alias, so no data for this name. Existing Malawi s648 was corrected from the Malawi pages (AllBud + Leafly + GrowDiaries): effects Energetic/Uplifted/Creative (Creative in all three, Energetic and Uplifted in Leafly + GrowDiaries; Focused and Relaxed removed), flavor "sweet lemon and woody" (sweet and woody in AllBud + GrowDiaries, lemon in AllBud aroma + GrowDiaries), ailments Stress/Depression (all three; Nausea removed), terpenes reduced to Myrcene only (Leafly + GrowDiaries share only the dominant terpene; generic Linalool/Caryophyllene removed). Held: THC (19% / 22% / 26%), breeder ACE Seeds (GrowDiaries only), parents (Leafly African only), type Sativa stays.
- **Durban**: Leafly has a separate Durban page (Sensi Seeds, sativa-dominant, 18% THC) that does not mention Durban Poison; AllBud and GrowDiaries not checked for this name beyond that. Existing Durban Poison s13 is a landrace entry. No evidence the two are the same, so no data and no merge; flagged.

## S74 (rows 3271–3275)
- **KC 33** → added as s7414. AllBud + Leafly + GrowDiaries. Breeder KC Brains (Leafly + GrowDiaries); effects Happy/Focused/Relaxed/Hungry (each in 2+); flavor "sweet lemon and mint" (all three); ailments Pain/Anxiety/Stress (each in 2+). Held: parents (AllBud Afghani Haze x Ukrainian, Leafly Haze and Afghani, GrowDiaries Dutch/Thai/Brazilian), lean (AllBud + Leafly 60/40 indica-dominant, GrowDiaries leaning sativa), THC (14–16% / 19%), alias K33 (Leafly only), terpenes (GrowDiaries only).
- **Mob Boss** (existing s5179, corrected/filled): AllBud + Leafly + GrowDiaries agree on a Chemdawg/Chemdog D x Tang Tang hybrid. Type Sativa → Hybrid; effects Happy/Focused/Relaxed (each in 2+; Energetic removed); flavor → "sweet citrus with floral notes"; ailments Stress/Depression/Anxiety filled. Lean Sativa-leaning kept. Held: THC (20% vs 28%), terpenes (Leafly myrcene vs GrowDiaries caryophyllene), breeder (stored Grindhouse Medical Seeds from Leafly; GrowDiaries says Anesia Seeds, flagged).
- **Bacon**: AllBud generic, Leafly errored, GrowDiaries empty; search returns only JointCommerce blog guides (Bacon by Lupos CannaSeed, Maple Bacon, etc.). Ambiguous name, no data.
- **Northern California Sativa**: skip, a regional/type descriptor, not a cultivar.
- **Russian Ruderalis**: skip, a botanical/type descriptor (see Ruderalis, S67), not a cultivar.

## S75 (rows 3276–3281)
- **Hells Angel OG** → = Hell's OG s6922 (aliases stored). AllBud (Hell's Angel OG) + Leafly (Hell's OG) + GrowDiaries (Hell's Angels OG): parents Blackberry x OG Kush filled (AllBud + GrowDiaries; Leafly OG Kush/Blackberry genetics); lean Indica-leaning → Indica-dominant (AllBud 80/20 and Leafly indica-dominant, GrowDiaries indica-heavy); THC 19–20% (AllBud 20, Leafly 19; GrowDiaries' 33% conflicts); effects Relaxed/Hungry/Happy/Sleepy (each in 2+); flavor "sweet citrus with earthy notes"; ailments Anxiety/Inflammation/Pain/Insomnia (each in 2+). Held: terpenes (Leafly only), Stress, PTSD, breeder (none named).
- **Brazilian Sativa**: skip, a type/landrace descriptor, not a cultivar (named Brazilian strains already exist separately).
- **South Indian Indica**: skip, a type/landrace descriptor; existing South Indian (Indica) s5911 and South Indian Sativa s483.
- **Ohio Lemon G** → = Lemon G s56 (alias stored; Leafly describes Lemon G as Ohio's pride but does not list the alias). AllBud + Leafly + GrowDiaries: lean Sativa-leaning → Sativa-dominant (AllBud 70/30, GrowDiaries and Leafly sativa-dominant), THC 23% (AllBud + GrowDiaries; Leafly 17%), effects Euphoric/Creative/Energetic (each in 2+), flavor → "lemon citrus with diesel and pine notes", ailments Stress/Anxiety/Depression/Pain (each in 2+; Inflammation and Nausea removed). Held: parents (AllBud G13 x Kali Mist, GrowDiaries G13 x Lemon Skunk, Leafly G13 only), terpenes and alias Lmg (Leafly only).
- **Sour Dubble** → = Sour Dubb s6748 (alias stored). AllBud + Leafly + GrowDiaries: parents East Coast Sour Diesel x Sour Bubble and B.O.G. Seeds as stored; lean Sativa-leaning filled (AllBud and GrowDiaries 60/40); THC 25–26% (stored 20-26% unsupported); effects Happy/Talkative/Relaxed/Focused (each in 2+); aliases Sour Dubs (AllBud + GrowDiaries) and Sour Dubb Dawg (Leafly + GrowDiaries) added; ailments Depression/Stress/Anxiety/Pain (each in 2+); meaningless zero-weight terpene set blanked (Leafly only shares terpenes). Stored flavor kept.

## S76 (rows 3282–3286)
- **Tahoe Alien**: skip, duplicate of row 3236 (new s7408, S68).
- **Cajun Moon**: AllBud generic, Leafly errored, GrowDiaries empty. SeedFinder lists Lovin' in Her Eyes, unknown parents, no THC or type; searches return unrelated Moon strains. Single source, held; no entry created.
- **Swiss Sativa**: skip, a regional/landrace-type descriptor (AllBud's generic "pure sativa native to Switzerland" page names no parents or breeder), not a cultivar.
- **Haze** (existing s394, one correction): AllBud + Leafly + GrowDiaries agree Depression and Stress; Migraines in AllBud + GrowDiaries. Pain was AllBud-only and replaced by Migraines. Stored effects (Creative/Uplifted in all three, Energetic in Leafly + GrowDiaries), flavor (spicy herbal, citrus, earthy) and breeder Haze Brothers (GrowDiaries, Leafly review) match. Held: lean (AllBud 80/20 hybrid, GrowDiaries/Leafly sativa; type Sativa kept), THC (14–23% / 18% / 22%), parents (Leafly Thai x South American vs GrowDiaries Punto Rojo x Mexican), aliases OG Haze/Haze OG (Leafly only). Stored alias Ivory Haze is not on any of the three pages (flagged, left unchanged).
- **Genius** (existing s6968, nothing changed): only AllBud (a Jack Herer phenotype, 50/50, 15–23% THC) is reachable; Leafly errored and GrowDiaries is empty. Stored breeder Brothers Grimm matches the G13 Genius seen in searches, which AllBud's Jack Herer phenotype may not be; single source and unclear match, so nothing written.

## S77 (rows 3287–3291)
- **P75**: AllBud (Princess x Princess 50, balanced 50/50, 15–20% THC) and SeedFinder's Unknown or Legendary page (Princess x P.50, "second step to Cinderella 99") agree only on the parentage, which is breeder-side data; Leafly errored, GrowDiaries empty. Held, no entry (same treatment as Chem IBL).
- **Skunk Haze** → added as s7416. AllBud + Leafly + GrowDiaries. Parents Skunk #1 x Haze (all three reference Skunk and Haze; GrowDiaries names Skunk 1 x Original Haze); breeder Mr. Nice Seeds (Leafly + GrowDiaries); effects Focused/Relaxed (Focused in all three, Relaxed in Leafly + GrowDiaries); flavor "skunky and earthy with spicy herbal and citrus notes"; ailments Stress/Depression/Anxiety/Pain (each in 2+). Held: lean (AllBud 70/30 and Leafly sativa-dominant vs GrowDiaries slightly sativa-leaning), THC (1–9% listed / 13% / 18%), aliases Skunk Haze CBD and Skh (Leafly only).
- **Fire Cookies** → added as s7417 (thin). AllBud + Leafly: hybrid, effects Creative/Uplifted, ailment Depression. Held: parents (AllBud GSC x Fire OG vs Leafly review only), flavor (diesel/sweet vs blue cheese/berry/earthy), THC (21–26% / 21%), terpenes and alias FiC (Leafly only). GrowDiaries empty. Existing Banana Fire Cookies s6811 lists Fire Cookies as a parent.
- **TK Skunk**: only AllBud (Triangle Kush x Skunk #1, indica-dominant 70/30, 17–20% THC, body high/happy/relaxing/uplifting, citrus/lemon/pine/skunk); Leafly errored, GrowDiaries empty. Single source, held. Separate from GMO/TK Skunk s6978.
- **Banana Zkittlez** → added as s7415. Leafly + GrowDiaries agree on Banana Punch x Zkittlez, hybrid, effects Energetic/Uplifted/Creative, flavor "berry and tropical fruit", ailment Depression. Held: breeder (Symbiotic Genetics vs Medical Seeds/Dying Breed), THC (20% vs 23%), lean (Leafly 60/40 indica only), Stress/Anxiety/Fatigue (not in both), aliases BZ/Banana ZKZ, terpenes. AllBud errored.

## S78 (rows 3292-3296)
- God: no strain by that name; only God Bud (s50) exists and no alias evidence. No data.
- Bear OG: Leafly (.com/.ca) only for OG Kush x Bear Creek Kush, Cascadia Gardens/Honeydew Farms, 27% THC; jointcommerce not independent. Single source, held. No data.
- Walter White (s7368): Leafly only (The White x unnamed autoflower sativa, 22%, tobacco/citrus/earthy). Held; entry unchanged.
- Reckless Rainbow (s7264): parents Animal Cookies x Sour Apple confirmed by AllBud + Leafly, filled. Other AllBud details single-source, held. Flag: stored breeder Lumpy's Flowers not on either page.
- Lemon Master: only generic pages / Leafly errored. No data.

## S79 (rows 3297-3302)
- Hell's OG (3297): duplicate of s6922, handled in S75. Skip.
- Original Diesel: conflicting versions (SeedFinder: Dr. Underground Daywrecker cut S1 / also called Headband; Canadian Seed Lab Chemdawg x Northern Lights hybrid). No two sources agree on one version. No data.
- OZ Kush (s7186): checked against Leafly + AllBud + SeedFinder. Parents OG Eddy Lepp x Zkittlez confirmed by Leafly + AllBud. Entry unchanged. Flag: Leafly lists breeders 3rd Gen Family Farms / Terp Hogz; stored Dying Breed Seeds matches SeedFinder breeder listing only.
- Black Maduro: no page of its own, only named as a parent of Black Cherry Maduro (s6832). No data.
- Cherry Sauce: new s7418. Cherry Pie x The Sauce (Leafly + AllBud), Hybrid, flavor berry (only flavor both agree on). Effects, ailments, THC, lean, breeder (Andromeda Strains, Leafly only) held.

## S80 (rows 3303-3307)
- Grand Reserve Headband: only AllBud reachable (OG Kush x Sour Diesel x Master Kush, indica-dominant 75/25, 20-25%). Leafly errored, GrowDiaries empty. Single source, held. No data.
- Captain's Cookies: AllBud page is a generic listing, no strain data found anywhere. No data.
- The Pure: search returns only unrelated Pure-named strains. No data.
- Black Trinity: only AllBud (Trinity x Purple Mendocino, indica-dominant 70/30, 15-20%). Leafly errored, GrowDiaries empty, Phylos page redirects off-site (not followed). Single source, held. No data.
- Santa Cruz Haze: Leafly errored; searches return only generic Haze pages. No data.

## S81 (rows 3308-3312)
- Highland Thai: only AllBud (landrace, Sativa, 18-19%); Leafly errored, no second source. Held. No data.
- French Toast (s7312): breeder Archive Seed Bank confirmed (Leafly + SeedFinder). Parent Paris OG agreed; second parent conflicts (Leafly Face Off OG vs SeedFinder Face On Fire), so parents trimmed to Paris OG. Lean blanked (Leafly "leaning toward indica" vs SeedFinder "mostly indica", no ratio). Migration batch 56.
- Snowman (s1617): Leafly + AllBud + GrowDiaries. GSC phenotype (parent Girl Scout Cookies), Sativa-leaning (AllBud + GrowDiaries 60/40), 23% (Leafly + AllBud), effects Euphoric/Uplifted/Creative/Relaxed, flavor diesel/vanilla/sweet, ailments Anxiety/Stress/Migraines. Removed unsupported sample terpenes, Happy, and old flavor/THC. Breeder (Premium Cultivars) GrowDiaries only, held. Migration batch 56.
- Neville's Wreck: alias of existing Nevil's Wreck s7152 (already carries aka). Leafly + AllBud + SeedFinder: parents confirmed, breeder Rare Dankness confirmed, lean corrected to Sativa-dominant (Leafly + AllBud 80/20). Effects Creative and ailments Depression filled (2 sources). Flavor left as stored. Migration batch 56.
- Hawaiian-Romulan: no strain by that name; candidates are different crosses (Classic Seeds Hawaiian Skunk x Romulan, Federation Romulan x Hawaiian Sativa) and Maui Haole (Maui Wowie x Romulan, Leafly nickname Hawaiian Alien). No alias evidence. No data. Maui Haole appended to the Sheet as a new row.

## S82 (rows 3314-3319)
- Gelato #33: alias of existing Gelato s8 (aka already lists Gelato 33 / Gelato #33). Leafly confirms parents Sunset Sherbet x Thin Mint GSC (matches s8). No change. Flag: Leafly and GrowDiaries keep Gelato #33 as its own page (GrowDiaries credits Cookies Seed Bank), so the alias is not proven by them.
- Mimosa V6: new s7419. Leafly (mimosa.6) + GrowDiaries: Clementine x Purple Punch, Symbiotic Genetics (V6 selected by The Village), Hybrid, effects Energetic/Uplifted, flavor citrus and orange. THC (19% vs 22%), lean (GrowDiaries 70/30 sativa only), ailments held.
- OGKB: alias of existing OG Kush Breath s2113. Leafly + AllBud checked; no change. Flag: stored terpenes (Caryophyllene/Limonene) vs Leafly dominant Terpinolene; stored lean Indica-leaning vs AllBud indica-dominant 70/30; THC 25% (Leafly) vs 27% (AllBud) sits inside stored 20-28%. Both call it GSC-descended with no clean parent pair.
- Sherbert Bx1: only GrowDiaries (Seed Junky Genetics, Animal Cookies BX2 x Sunset Sherbet backcross, Indica, 25%); Leafly errored; no SeedFinder page. Single source, held. No data.
- Arjan's Strawberry Haze: new s7420 (Leafly + SeedFinder + GrowDiaries). Green House Seed Co. (SeedFinder + GrowDiaries; Leafly says "Arjan"), Sativa, 19-20% (Leafly + SeedFinder lab 19.72), effect Talkative, flavor strawberry/sweet/berry. Parents conflict (SeedFinder Swiss Sativa x NL5 Haze Mist; Leafly H Haze x NL5; GrowDiaries Haze x NL5 x Swiss Sativa) so held. Flag: library Strawberry Haze s1679 carries the SeedFinder Arjan's parentage but SeedFinder lists them separately; not merged.

## S83 (rows 3320-3324)
- Darth Vader OG: alias of existing Vader OG s835 (Leafly Vader OG + GrowDiaries Darth Vader OG share SFV OG x Larry OG, Ocean Grown Seeds). AllBud's Darth Vader OG lists Afghani x Kush (conflict, not used). s835 rebuilt (Leafly + AllBud + GrowDiaries): parents SFV OG x Larry OG, breeder Ocean Grown Seeds, Indica-dominant, 20-21%, effects Euphoric/Happy/Sleepy, flavor blueberry and grape, ailments Stress/Insomnia/Pain, aka Darth Vader OG. Removed sample terpenes/flavor and unsupported Talkative/Creative/Depression. Migration batch 57.
- Platinum Bubba: alias of existing Platinum Bubba Kush s410 (Leafly alias; AllBud). Parents Bubba Kush x Platinum (OG) Kush confirmed. Ailments cut to Pain/Stress/Anxiety (2 sources); Insomnia, Depression, Inflammation single-source. THC conflicts (16% vs 20%), left blank. Migration batch 57.
- Sweet Island Skunk: not proven alias of Island Sweet Skunk s593 (Leafly says alias; SeedFinder lists BC Bud Depot's Sweet Island Skunk IBL separately). Single source for the separate entry, held. No data. Island Sweet Skunk s593 itself rebuilt (Leafly + AllBud + GrowDiaries + SeedFinder): parent Sweet Skunk, aka ISS, 18-19%, effects Uplifted/Euphoric/Happy, flavor sweet/skunky/grapefruit/tropical, removed sample terpenes and Energetic. Migration batch 57. Flag: breeder Jordan of the Island vs Federation/BC Bud Depot listings; parents disputed (Sweet Skunk x White Widow / Skunk #1 / Hawaiian).
- Kasparov: no strain pages found. No data.
- Kerala Skunk: no strain pages found (only Kerala Krush s842, not proven alias). No data.

## S84 (rows 3325-3329)
- KGB: searches return only Gorilla Glue articles, no strain page. No data.
- Kill Bill: new s7421 (Leafly + GrowDiaries + AllBud). Killer Queen x Willy's Wonder (3 sources), Reservoir Seeds (Leafly + GrowDiaries), Hybrid, Balanced (GrowDiaries balanced, AllBud 50/50), 15-19% (AllBud range + GrowDiaries), effects Hungry/Energetic/Sleepy, flavor rose/tobacco/diesel (Leafly + GrowDiaries; AllBud lists pine/strawberry/sweet, conflict noted), ailments Stress/Anxiety (eye pressure outside vocab).
- Killa Kush: AllBud + SeedFinder (Motarebel) agree only on Bubba Kush x Killa Queen parentage (breeder-side data, SeedFinder says "probably"); Leafly errored. Held. No data.
- Killer Apollo: only unrelated Apollo-named pages. No data.
- Killer Kristalls: no strain pages found. No data.

## S85 (rows 3330-3334)
- Killer Newhaven: only AllBud (Killer New Haven: indica-dominant 80/20, 25-26%, unknown parents). Leafly errored, GrowDiaries empty. Single source, held. No data.
- Killer Queen 2: no distinct strain page; results only for Killer Queen (s1129 exists). No data.
- Killian: only SeedFinder (Motarebel, Killer Queen x NYC Diesel); breeder-side, single source, GrowDiaries empty. Held. No data.
- Killin Garberville: only SeedFinder (British Columbia Seed Company F-4 IBL, believed Hawaii x Afghanistan). Single source, held. No data.
- King's Kross: likely Kings Cross. AllBud (King's Kush x Charles Kush, indica-dominant 95/5, 26%) and SeedFinder (Scott Family Farms, (King x Charles Kush) x King) conflict on the first parent and are breeder-side; Leafly errored, GrowDiaries empty. Held. No data.

## S86 (rows 3335-3339)
- Klingonberry: AllBud + SeedFinder (Dutch Flowers) agree only on (Bubble Gum x Blueberry) x Aloha 98 parentage (breeder-side); Leafly errored. Held. No data.
- Klitschkov: no strain pages found. No data.
- Kolinahr: no strain pages found. No data.
- Kong (s7071, Holy Smoke Seeds): checked against Leafly + AllBud + SeedFinder. Parents Motivation x White Russian confirmed (Leafly + AllBud). Lean Indica-leaning blanked (Leafly indica-dominant vs AllBud 50/50). Effects Relaxed/Happy and ailments Pain/Stress filled (2 sources). THC conflicts (14% vs 20-22%), left blank. Flavor left as stored (compatible). SeedFinder's Kong (Unknown or Legendary) is a different listing. Migration batch 58.
- Kranial Kush: no strain pages found. No data.

## S87 (rows 3340-3344)
- Kwik Kali: only a SeedFinder listing (Sagarmatha Seeds) exists and it errored; AllBud has only a category URL. No data.
- La Nina: new s7422 (Leafly + AllBud). Parents White Widow x Haze, Sativa-dominant (Leafly; AllBud 75/25), 20%, effects Creative/Uplifted, flavor sweet, ailment Depression (both). Breeder not agreed (reviewer claims Green Therapeutics; AllBud says former private reserve). Flag: SeedFinder's La Nina (Mr. Nice Seedbank, formerly El Nino, Mullumbimby Madness Haze x Black Widow) is a different version, not used.
- Lambada: no strain pages found. No data.
- Lambsbread Skunk: no strain pages found; only Lamb's Bread (s1139) results, not a proven alias. No data.
- Lasqueti Haze: AllBud + SeedFinder (BC Bud Depot) agree on Sativa-dominant 80/20, Lasqueti Island x Skunk, but AllBud text mirrors the breeder description (not independent); Leafly errored, GrowDiaries empty. Held. No data.

## S88 (rows 3345-3349)
- Lebanese: only AllBud (Lebanese Landrace, Indica, 22-25%); Leafly errored. Landrace/descriptor-style name; related Red Lebanese s5657 exists. Single source, held. No data.
- Legends Ultimate Indica: SeedFinder (Spice of Life Seeds, Ortega x Sweet Tooth BX2) and AllBud (Ultimate Indica, same breeder and parents) match, but AllBud mirrors the breeder text, so not independent. Held. No data.
- Lemon Bud: only SeedFinder (De Sjamaan, White Widow x Big Bud; a Greenlabel version also exists). Single source, multi-version. No data.
- Lemon Chemo: no strain pages found (only Lemon Chem / Lemon Chemical results, not proven aliases). No data.
- Lemon Freeze: only SeedFinder (SubCool's The Dank, 90/10, Jacks Cleaner Bx x JCB); Leafly errored. Single source, held. No data.

## S89 (rows 3350-3354)
- Leshaze: AllBud (Africa Sativa/Haze/Skunk, Sativa-dominant 90/10) and SeedFinder (Cannabiogen, Lesotho sativa x (Haze x Skunk)) both breeder-side and differ in wording; Leafly errored. Held. No data.
- Lieu Hanh: only a SeedFinder Lieu Hahn listing (Hyp3rids, mostly sativa, Vietnam Black x Nevil's Haze line). Single source, breeder-side. No data.
- Lieu Hanh 99: no strain pages found. No data.
- Life Star: only SeedFinder Lifestar (B.O.G. Seeds, SensiStar x LiveSafer, mostly indica); Leafly errored. Single source, breeder-side. No data.
- Lime Chemo: no strain pages found (only Key Lime Chem / Lime 1 results, not proven aliases). No data.

## S90 (rows 3355-3359)
- Lone Ranger: no strain pages found (only unrelated landrace/Lone Wolf results). No data.
- Low P.T.: no strain pages found. No data.
- Lowland Afghani: no strain pages found; Afghani (s41) and other Afghani entries exist but are not proven aliases. No data.
- Lowrider: alias of existing Lowryder s7111 (Leafly lists aliases Low Ryder / Lowrider / Low Rider; SeedFinder spells it Low Rider). Aliases added. Leafly + AllBud: effects Creative/Relaxed, flavor pine with earthy notes, ailments Stress/Pain filled. THC (AllBud 20% vs review 10-15%) and lean (AllBud 50/50 only) held. Parents unchanged (Leafly: Northern Lights #2 x William's Wonder; stored also lists Mexican Ruderalis). Migration batch 59.
- M3: only AllBud (AK Haze x Hash Plant, indica-dominant 60/40, 25-27%); Leafly errored. Single source, held. No data.

## S91 (rows 3360-3364)
- Mako Shark: no strain pages found (only Mako Haze s400, not a proven alias). No data.
- Malaki: only SeedFinder (Afropips Seeds, Malawi x White Russian, ~70% sativa). Single source, breeder-side. No data.
- Malawi 99: no strain pages found; Leafly errored; Malawi s648 and Malawi Gold s16 exist but not proven aliases. No data.
- Malberino: only SeedFinder (Afropips Seeds, Malberry x Grenadino). Single source, breeder-side. No data.
- Malberry: only SeedFinder, two different breeders (Afropips: Malawi Gold IBL x Blueberry; Nguni Seeds: 50/50, lineage not confirmed). Multi-version, single source. No data.

## S92 (rows 3365-3369)
- Malibu: no strain named Malibu found on Leafly/AllBud (Leafly errored); only variants (Malibu OG s2070, Mirage s2251, Pie s5057, Sunset s5058 exist) and a jointcommerce blog (KushBrothers). No data.
- Magic Carpet Ride: no strain pages found (music results only). No data.
- Magic Crystal: only SeedFinder (De Sjamaan, California Orange x White Widow). Single source, breeder-side. No data.
- Mandarin Punch: NEW s7423. Parents Purple Punch x Mandarin Cookies agree between SeedFinder (Demonic Genetics) and OK Gazette review (Giddy's). AllBud lists a different old-school lineage (Maple Leaf Indica x White Widow x NYC Diesel, 70/30) = other version, not used. Breeder (Demonic only), flavor (sources differ), THC, lean held. Sensi Seeds "Mandarine Punch Auto" is a separate autoflower, not merged.
- Manga Rosa: NEW s7424. Brazilian pure sativa landrace, mango flavor: AllBud (as Magna Rosa, "also known as Manga Rosa") + SeedFinder (Brazilian Seed Co. and MadMac's). Type Sativa, lean blank (landrace), flavor "sweet and mango". THC (AllBud only), effects, ailments, aka Magna Rosa held (single source).

## S93 (rows 3370-3374)
- Mangolian Indica: AllBud + SeedFinder (Sagarmatha) agree on Indica, Afghan Skunk/Afghani/NL parentage, mango aroma, but AllBud mirrors breeder text (breeder-side only, same rule as Chem IBL/P75). Held, no entry. No data.
- Manolito 1: only SeedFinder (Good House Seeds, White Rhino x KGB, 60/40 indica) + jointcommerce blog. Single source. No data.
- Marley's Collie: NEW s7425. Leafly + AllBud + SeedFinder. Breeder Sensi Seeds and parents Maple Leaf Indica x Jamaican (Leafly + SeedFinder; AllBud's Jam #2 x Ort 15T7 differs, not used). Effects Creative (Leafly + AllBud). Ailments Stress/Depression/Insomnia (Leafly + AllBud). Flavor sweet + mint/lemon (Leafly + SeedFinder user note; sweet in all three). Lean blank: Leafly indica-dominant vs AllBud/SeedFinder 60% sativa. THC (AllBud only), Energetic/Uplifted/Focus/Happy held. Bob Marley s2017 not proven alias.
- Master Ice: AllBud + SeedFinder (No Mercy Supply) both say Mind Bender x NL Xtra, but SeedFinder says "most probably" and AllBud mirrors breeder. Held. No data.
- Matanuska Mist: no strain pages found; Matanuska Mint (Sagarmatha) and MTF s267 are different, not aliases. No data.

## S94 (rows 3375-3379)
- Maui Mist: AllBud (Hawaiian Indica x Pure Haze, 70/30 sativa) + SeedFinder (BC Seed Co., Hawaiian Indica x "Unknown Haze", mostly sativa). Breeder-side agreement only, Haze identity differs. Held, no entry. No data.
- Mayhem: no strain named Mayhem found (only Project/Lemon/Purple/Pineapple Mayhem and Mayhem 592 variants). No data.
- MCW: no strain pages found (search returned unrelated results). No data.
- MedMaster: no strain pages found. No data.
- Mendocino Madness: NEW s7426 (minimal). Multi-version: TH Seeds (hybrid, Madness x Kwiksilver father) vs BC Seed Co. (F4 IBL indica). Parent Madness agrees across Leafly, AllBud, SeedFinder TH; Uplifted agrees Leafly + AllBud. Held: breeder (TH vs BC), Kwiksilver father (Leafly mirrors breeder; AllBud says unknown), lean (hybrid vs indica-dominant vs indica), THC (AllBud only), flavor (mint/chemical/earthy vs herbal/nutty/sweet), ailments (no overlap in vocab; fatigue outside vocab).

## S95 (rows 3380-3384)
- Merlins Dream: only SeedFinder (De Sjamaan, Afghani Hindu Kush x Master Widow, mostly indica) + jointcommerce blog. Single source. No data.
- Merville Blueberry: only SeedFinder (BC Bud Depot, Blueberry x (Grapefruit x unknown), 75% sativa) + jointcommerce blog. Single source. No data.
- Mighty Haze Candy: only SeedFinder (Dutch Flowers, Mighty Chemo Widow x Uber Candy Haze). Single source. No data.
- Mikush: only AllBud (Mikado x Kush, indica, up to 17% THC); Leafly Mickey Kush/Micky Kush is a different name, not proven alias. Single source. No data.
- Mind Bender: multi-version. AllBud (Grape Punch/Lifesaver/White Widow/Sweet Skunk, 70/30 indica) vs KC Brains breeder page + Weedmaps brand page (KC 2 x KC 30/33 x Afghani; both breeder-side) conflict; Leafly errored. No version has 2 independent sources. Also bears on Master Ice (Mind Bender x NLX) held in S93. No data.

## S96 (rows 3385-3389)
- Mindfuck: SeedFinder (Cookie Fam Genetics, Gelato x Sunset Sherbet, indica-dominant) + GrowDiaries/Cookies seedbank page repeating breeder text (not independent). Vietnamese Mindfuck is a different strain. Single source. No data.
- Mississippi Sweet Bud: only SeedFinder (Jordan of the Islands, Kush x Birmana, mostly indica). Single source. No data.
- Mississippi Queen: no strain pages found. No data.
- Misty: only SeedFinder (Nirvana, Brazil x Indian, mostly indica, 15-20% THC). Single source; Misty Kush s406, Early Misty s1410, Mean Misty s5114 not proven aliases. No data.
- Moon Shadow: only SeedFinder, two different versions (NorStar Genetics: Old Mendo Haze x Purple Mayhem, 80% sativa; Colors by Cultivar: Moonbow x Undertow). Multi-version, single source each. No data.

## S97 (rows 3390-3394)
- Moonflower: only SeedFinder (The Landrace Team, Aunt of Farouk x Durban Poison polyhybrid, indica-dominant). Single source. Black Moon Flower on GrowDiaries is a different name. No data.
- Morning Dew: NEW s7427. Leafly + AllBud agree: Alien Bubba x Durban Poison; sativa side (Leafly Sativa, AllBud 70/30) -> Hybrid, Sativa-dominant; Creative/Energetic/Uplifted; Depression; flavor citrus + floral. Held: THC (27% vs 30-34%), terpenes (Leafly only), ADHD/fatigue/anxiety (outside vocab or single), breeder. Irie Genetics Morning Dew (Grateful Dawg x Arise) is a separate version, not used.
- Mountain Jam: NEW s7428. Parents Soulshine x Blueberry agree across AllBud, SeedFinder (DJ Short/Chimera) and an independent publish0x review. Lean blank (AllBud 50/50 vs SeedFinder mostly indica vs reviewer heavy indica). Breeder held (DJ Short/Chimera vs Cannabis Cowboy Collective). Effects/flavor/THC held (AllBud only).
- Mountain Lion: AllBud + SeedFinder (Almighty Seeds) agree on Rock Bud x LionHeart but breeder-side only; AllBud 50/50. Held, no entry. No data.
- MP5K: no strain pages found. No data.

## S98 (rows 3395-3399)
- Mr. Bubble: AllBud (Kali Mist x Bubblegum, 50/50) + SeedFinder (TH Seeds, same cross) agree only on breeder-side parentage; no independent source. Held, no entry. Other Mr Bubble listings (33, Babylon Seeds Bank) are different versions. No data.
- Mr. Majestyx: no strain by that spelling; only Mr Majestyk (Afropips, Malberry x Cinderella 99, SeedFinder) and Mr. Majestic (Gage Green). Spelling not proven. Single source each. No data.
- Neon Super Skunk: only SeedFinder (SubCool's The Dank; own parent fields conflict) + jointcommerce blogs; Riot Seeds S1 is a separate listing. Single source. No data.
- Nepal Baba: only SeedFinder (Dr. Atomic Seeds, Nepal x Northern Lights, mostly sativa) + jointcommerce blog. Single source. No data.
- Nepalese Grizzly: no strain pages found (only generic Nepalese results). No data.

## S99 (rows 3400-3404)
- Nepalese Jam: NEW s7429 (minimal). Leafly + SeedFinder (ACE Seeds) agree: breeder ACE Seeds, Nepalese x Jamaican. Type Hybrid (Leafly; ACE calls it sativa), lean blank. Held (Leafly only): THC 23%, terpenes, Creative/Uplifted/Happy, Anxiety/GI. Alias "Nepal Jam" single source, not added.
- Nepali: alias of existing s269 Nepalese (aka already "Nepal, Nepali"). Checked s269 against AllBud + Leafly (migration batch 60): ailments -> Stress/Depression/Pain (Insomnia unsupported; Nausea AllBud only); flavor -> "sweet and citrusy with floral and earthy notes" (dropped unsupported "earthy spice"/"hash-like finish"). Effects Uplifted/Happy kept (AllBud + Leafly Happy; Uplifted AllBud). Nepali OG s6915 and Nepali Queen s5247 are different strains.
- Neville's Haze Hybrid: "Hybrid" is a type suffix on Neville's Haze s1159. Treated as duplicate (skip). s1159 had sample-style values; corrected via migration batch 60 using AllBud + Leafly: THC 21-25% blanked (AllBud 21%, Leafly 15%), CBD <1% blanked, terps Myrcene/Linalool/Humulene blanked (only Leafly lists terps: myrcene, caryophyllene, pinene), flavor -> "diesel and lemon", effects -> Creative/Euphoric (was Creative/Giggly/Sleepy; Sleepy unsupported), lean -> Sativa-dominant (AllBud 75/25 + Leafly sativa), ailments Stress/Depression added. Held: breeder Green House Seeds and parents Haze x NL#5 (Leafly only; SeedFinder errored), 1998 Cup award (AllBud only), Neville's Haze Mango s5249 untouched.
- New Killer Queen: only SeedFinder (Juan Moore, G13 x Cinderella 99 RRS project, mostly indica). Single source; separate project from Killer Queen s1129. No data.
- New Purple Cross: no strain pages found. No data.

## S100 (rows 3405-3409)
- New Purple Power: AllBud (Purple Haze x Skunk, 80/20 sativa, 5-10% THC) + SeedFinder Nirvana (descends from Purple Power = Haze x Skunk, 5-10% THC) agree only breeder-side; SeedFinder Positronics is a separate version (unknown, mostly sativa). Held, no entry. No data.
- New York City Diesel: alias of existing s1160 NYC Diesel (aka already lists it). Checked vs Leafly + AllBud: THC 18-21%, Sativa-leaning, flavor all supported. Ailments blank-filled Stress/Anxiety/Depression (Leafly + AllBud). Held: terpenes (Leafly only), Happy effect (AllBud only; Talkative kept).
- Purple Power s774 (related, fixed per "fix other entries"): had sample-style values. Migration batch 61 vs AllBud + Leafly: THC 22-28% blanked (AllBud 9-13%), CBD blanked, Myrcene/Linalool/Terpinolene blanked, effects -> Focused (Focused in both; Happy/Uplifted AllBud only, Relaxed unsupported), flavor -> "skunky" (only skunk agrees), breeder "Homegrown Fantaseeds" blanked (neither source), ailments -> Lack of Appetite/Stress/Anxiety (Depression AllBud only). Lean stays blank (Leafly sativa-dominant vs AllBud 50/50). Held: parents (Leafly Dutch Dope x Skunk #1; AllBud none; SeedFinder says Haze x Skunk).
- Nirvana Special: AllBud + SeedFinder (Nirvana Seeds) agree only breeder-side (Jock Horror x Oaxacan, mostly sativa). Held. No data.
- No Mercy Special: no strain pages found (only other No Mercy Supply strains). No data.
- North #1: no strain pages found. No data.

## S101 (rows 3410-3414)
- Northern Bright: AllBud (as Northern Brights: Northern Lights x Haze, 50/50, 15-20% THC) + SeedFinder (Nirvana Seeds, same cross, mostly sativa, 15-20% THC) agree only breeder-side; AllBud lean conflicts. Northern Lights #5 x Haze s471 is a different cross. Held. No data.
- Northern Dream: no strain pages found (only a "Northern Dreams" review and other Northern names). No data.
- Northern Lights #1: only SeedFinder listings (Deep Ellum, The Seed Bank, F-3 version); no AllBud/Leafly page. Multi-version, single source. Library NL s11 and NL #5 s60 untouched. No data.
- Northern Lights #2: AllBud (unknown phenotype of Northern Lights, 75/25 indica, 25-28% THC) + SeedFinder (Deep Ellum/Authentic Genetics/The Seed Bank versions, no stated lean). Only AllBud has data; versions differ. Single source. No data.
- Northern Lights #9: only SeedFinder, two versions (AK Bean Brains: NL x NL, mostly indica; Sagarmatha: NL x White Widow x Durban). Multi-version, single source. No data.

## S102 (rows 3415-3419)
- Northern Skunk: NEW s7430. Leafly + AllBud agree: Northern Lights x Super Skunk; Euphoric/Relaxed; flavor skunky + earthy; ailments Stress/Pain/Depression. Held: THC (19% vs 14%), lean (AllBud says 80/20 in text but 50/50 in header; Leafly Hybrid), terpenes (Leafly only), breeder unknown, Anxiety/Insomnia/etc. (single or outside vocab). Annibale Northern Skunk Autoregular is a separate listing.
- Nutcruncher: no strain by that name (only Nut Cracker, Zamnesia x Humboldt, SeedFinder). Not proven alias. No data.
- Oasis: conflicting single-source versions: AllBud (Hindu Kush x Thai, 30% THC, indica) vs SeedFinder Dutch Passion (NL#2 selection, 12.3% THC, mostly indica). Governmint Oasis s1913 and Lemon Oasis s2730 are different. No data.
- Odin's Hammer: no strain pages found. No data.
- Oke 47: only SeedFinder (White Label, Afghani, mostly indica). Single source. No data.

## S103 (rows 3420-3424)
- Optimus Prime: conflicting single-source versions. AllBud (Mayne Island x BC Sweet Tooth, 75/25 indica, 20% THC) vs Leafly 3X Crazy (aka Optimus Prime, Insane OG; OG Kush x Granddaddy Purple, indica, 13% THC); Exotic Genetix is a third listing (jointcommerce only). No version has 2 independent sources. No data.
- Orange Apollo: no strain pages found (Apollo/Apollo 11/Orange Apricot are different names). No data.
- Orange Chemo: no strain pages found (Orange Chem, Orange Cookie Chem are different names, not proven aliases). No data.
- Orange Spice: only AllBud (Double G x White Widow, 50/50, 21-22% THC). Single source. No data.
- Orangina: AllBud (Orange Jam x Orange Cookies, 50/50) + SeedFinder (The Grateful Seeds, same cross) agree only breeder-side; Leafly errored. Held. Orangina 2.0 s5329 is a different strain (Legend Orange Apricot x FreeWorld Chem). No data.

## S104 (rows 3425-3429)
- Original Diesel: already decided earlier (see Original Diesel entry above): conflicting versions (Dr. Underground "Daywrecker cut" S1, aka Daywrecker/Headband vs Canadian Seed Lab Chemdawg x NL hybrid, 60/40 indica). Existing s1384 Daywrecker already carries aka "Original Diesel". Leafly errored. Nothing further. No data.
- Original Gangsta Kush: no strain pages found (only generic OG Kush results). No data.
- Original Green: no strain pages found. No data.
- Original Highway Delight: no strain pages found. No data.
- Original Strawberry Diesel: no page under that name; not proven alias of Strawberry Diesel s1221. But s1221 had sample-style values; fixed via migration batch 62 using Leafly + AllBud: THC 15-23% blanked (19% vs 20-24%), Linalool/Limonene/Humulene terps blanked (Leafly lists caryophyllene/limonene/myrcene, single source), effects -> Happy/Creative (was Tingly/Talkative/Social), flavor -> "strawberry and diesel with sweet notes"; blank-filled parents Strawberry Cough x NYC Diesel (both sources) and ailments Stress/Anxiety/Depression. Held: Uplifted/Euphoric (single), lean (AllBud 50/50 only), "Swd" abbreviation (Leafly only). CBD <1% kept (consistent with both).

## S105 (rows 3430-3434)
- Ortega Indica #1: not proven alias of Ortega s925 (SeedFinder Dutch Passion "Ortega Indica" = NL#1 x unknown indica, a separate variety). No data for the row. But s925 Ortega had sample-style values; fixed via migration batch 63 using Leafly + AllBud: type Hybrid -> Indica (both), THC 16-24% blanked (15% vs 17%), Caryophyllene/Myrcene/Ocimene terps blanked, effects blanked (no overlap), flavor -> "sweet", ailments -> Depression/Insomnia (Pain Leafly only), parents blank-filled Northern Lights (both; AllBud NL#1 x NL#5). Breeder Mr. Nice kept (Leafly supports, AllBud silent). Held: Pain, myrcene/caryophyllene/limonene terps (Leafly only).
- Pakalolo: Hawaiian general term for cannabis, not a strain; only Oahu Grown Pakalolo (AllBud) and Pua Mana Pakalolo (a breeder). Skip (descriptor).
- Pakistani: regional descriptor; Pakistani Chitral Kush s348, Pakistan Valley s347/s5353 already exist. Skip.
- Panama: NEW s7431 (minimal). Leafly + AllBud agree: Sativa, Uplifted, ailments Anxiety/Depression. Held: parents (Leafly three landraces vs AllBud Panama '74 x Green Panama x Colombian Red Dot), breeder ACE Seeds (Leafly only), THC 20% vs 15-22%, flavor (conflict), Creative/Energetic/Focus/Euphoric (single), fatigue (outside vocab). Panama Red s407 is separate and untouched.
- Panama Powerhouse: AllBud + SeedFinder (Dman Seeds) agree only breeder-side (Panama Red x G13 x Widow, mostly sativa). Held. No data.

## S106 (rows 3435-3440)
- Passion Queen: no strain pages found (Night Queen is a different Dutch Passion strain). No data.
- Passion #1: only SeedFinder (Dutch Passion, Amstel Gold line, indica, 18.6% THC) + GrowDiaries seedbank page repeating breeder text (not independent). Single source. No data.
- Peak 19: only SeedFinder, two versions (Sagarmatha, Capricorn Seed Company) + jointcommerce blogs. Multi-version, single source. No data.
- Crystal Cookies 4-BD: the "4-BD" cut label is undocumented, so no claim about it. Base strain Crystal Cookies was not in the library: NEW s7432 from Leafly + AllBud: Platinum GSC x Animal Cookies, ~90/10 indica -> Hybrid, Indica-dominant; Happy effect; flavor citrus + sweet; ailments Stress/Depression. Held: THC (24.5% vs 20-27%), other effects, Anxiety (Leafly only), breeder unknown. Crystal Cookies by In House Genetics / Unicorn Boys auto are separate listings. Parent "Platinum GSC" has no library entry yet (name only).
- Swiss/Tsu 4.1: label not documented; Swiss Tsunami s492 exists but "4.1" not proven to be an alias/ratio of it. Not researched further. No data.

## S107 (rows 3442-3447; 3441 not visible)
- Super Glue by NOTA: "by NOTA" is a producer/brand label on Superglue s1875 (aka already lists Super Glue). Treated as duplicate (skip). s1875 checked vs Leafly + AllBud and corrected (migration batch 64): THC 18% blanked (21% vs 23%), effects -> Relaxed/Focused (Happy AllBud only), flavor -> "pine and woody", ailments Stress/Depression blank-filled. Parents Northern Lights x Afghani, lean Indica-leaning (60/40 both), breeder Seedism (Leafly) kept. Held: terps (Leafly only), Anxiety.
- Pinnaple Haze: misspelling of Pineapple Haze s655 (skip). s655 had sample-style values; corrected via batch 64 using Leafly + AllBud: THC 13-19% and CBD 15-23% blanked (Leafly 16%, CBG 1%), Caryophyllene/Limonene/Pinene terps blanked, effects -> Happy (only overlap), flavor -> "pineapple and citrus", ailments -> Depression/Stress (Lack of Appetite AllBud only). Blank-filled lean Sativa-dominant (Leafly mostly sativa, AllBud 70/30) and parents Haze x Pineapple (both).
- Cross of the Titans- BD: duplicate of Cross Of The Titans s3873 (BD cut label); AllBud also confirms Best Shit Ever x (Medusa x Pegasus), 70/30 indica, 20% THC - consistent with existing entry, left unchanged (skip).
- Crystal Cookies #3 and Crystal Cookies #4- SK: cut/pheno labels of Crystal Cookies s7432; no documentation for the individual cuts (skip).

## S108 (rows 3447-3451)
- Cross of the Titans- SK: cut/seed-company label of Cross Of The Titans s3873; no separate documentation (skip).
- Alien OG #4: numbered pheno of Alien OG s1551; neither Leafly nor AllBud mention a #4 (skip). s1551 had sample-style values, corrected via batch 65 (Leafly + AllBud): THC 20-24% blanked (19% vs 22-28%), Caryophyllene/Limonene/Myrcene terps blanked, effects -> Relaxed/Euphoric/Tingly (both), flavor -> "pine and lemon", ailments Stress/Anxiety/Pain blank-filled (both). Parents Tahoe OG x Alien Kush confirmed. Lean left blank (AllBud 50/50, Leafly none). Held: breeder "The Rising Sun Farm" (not checked this batch).
- Girl Scout Cookies Thin...: name truncated in the sheet; read as Thin Mint GSC s1554 (alias already listed). Corrected via batch 65 (Leafly Thin Mint + AllBud): lean Indica-leaning blanked (unsupported; AllBud 50/50), effects -> Relaxed/Euphoric (overlap), flavor -> "mint and menthol with sweet notes" (chocolate unsupported), ailments Depression/Anxiety blank-filled (both). Parents OG Kush x Durban kept (both). Held: terps (Leafly only), THC.
- Lake of Fire: NEW s7433. Hybrid, Gorilla Glue #4 x Kobain Kush (Leafly + AllBud + SeedFinder, Red Eyed Genetics), effects Euphoric/Happy, flavor "pine, diesel and chocolate". Held: lean (AllBud 60/40 sativa, Leafly none), THC (20% unmeasured vs anecdotal), ailments (no overlap between sources).
- Roosevelt: no strain pages found (no data).

## S109 (rows 3452-3456)
- Jack: ambiguous short name (Jack Herer, Jack the Ripper, Jack Straw, Sannie's Jack all exist); no strain page for plain "Jack" (no data).
- Cookies: generic family descriptor, not a single strain (skip).
- Kush: generic family descriptor (skip).
- Commisioner Gordon: no cannabis strain pages found (searches return only the comic character) (no data).
- Mango x Trainwreck: alias of Mango Trainwreck s5080. Checked: AllBud agrees Mango Kush x Trainwreck, hybrid 50/50, THC 22-29%; Leafly only has a Curio product page (brand listing, not independent; lists Myrcene/Caryophyllene/Limonene). Existing entry left unchanged (single independent source for everything beyond parents). Held: lean (AllBud 50/50 only), effects/flavor (AllBud and product page differ).

## S110 (rows 3457-3461)
- Wonder Woman: existing s7372 (Hybrid) checked vs Leafly + AllBud; corrected via batch 66: effects -> Focused (only overlap; Euphoric/Uplifted AllBud only, Energetic/Giggly Leafly only), flavor -> "sweet and fruity" (skunky AllBud only), ailments Stress/Depression blank-filled (both). Kept THC 16-18% (Leafly 18%). Held: lean (AllBud 60/40 sativa, Leafly none), parents (Leafly only "possible Ice cross"), terps (Leafly only: pinene).
- Wonder Woman OG s581 is a separate entry; it still carries sample-style values (Limonene/Terpinolene/Myrcene terps, THC 23-32%, "limonene-leaning finish" flavor) - to be fixed when its row comes up.
- C2, C1, SH: ambiguous codes with no strain pages (no data).
- Blue Maui: NEW s7434. Hybrid, Blue Dream x Maui Wowie (Leafly + GrowDiaries + OCS BC Doobies listing). Effects Energetic/Creative/Uplifted, flavor "blueberry and pineapple with a pine note", ailments Depression (only overlap). Held: lean (Leafly sativa-dominant vs ~55/45), THC (26% listing vs 27-31% product), breeder (BC Doobies is a brand, not breeder).

## S111 (rows 3462-3470 region: 3462, 3463, 3465, 3466, 3467)
- Black Triangle: NEW s7435. Leafly + AllBud agree Triangle Kush x '88 G13 Hash Plant, 26% THC, effects Relaxed/Sleepy/Euphoric, citrus (both), Depression (both). Hybrid (Leafly "deep indica hybrid"; AllBud Indica / "100% indica") with lean Indica-dominant. Held: breeder (neither lists), terps (Leafly only), other flavors/ailments. POSSIBLE DUPLICATE of existing s1821 Black Triangle OG (same parents, breeder Claybourne Co.); not merged without evidence that the OG-suffixed name is the same strain. s1821 effects/flavor are unsourced - fix when its row comes up.
- Sour Dosi Doe: exact name has no pages; AllBud's Sour Do-Si-Dos (Dosidos x Sour Dubble, 60% indica) is the only source and is not proven to be the same strain (no data).
- Northern Lites: misspelling of Northern Lights s11 (alias added). s11 corrected vs Leafly + AllBud (batch 67): THC 23-31% blanked (18% vs 16-21%), effects -> Relaxed/Sleepy/Euphoric, flavor -> "pine and woody", ailments Stress/Pain/Insomnia/Depression/Anxiety (Lack of Appetite AllBud only dropped), generic breeder "Seed Bank" blanked. Held: terps Myrcene/Caryophyllene/Pinene (no source seen), parents Afghani/Thai kept (Leafly; AllBud lists none).
- Supreme Moby Dick: no "Supreme" version documented anywhere (skip, variant label of Moby Dick s193). s193 corrected vs Leafly + AllBud (batch 67): THC 13-17% blanked (17% vs 27%), sample-style Limonene/Myrcene/Linalool terps blanked, effects -> Euphoric/Focused, flavor -> "citrus", ailments -> Stress/Depression, lean Sativa-dominant blank-filled (AllBud 75/25, Leafly Sativa). Parents White Widow x Haze and breeder Dinafem confirmed. Type kept Hybrid.
- Thai OG: only AllBud (Thai x OG Kush, 70/30 sativa); Leafly not retrievable (no data, single source).

## S112 (rows 3468-3472)
- 13: only "13 by Earthly Pleasures" (jointcommerce blog; parentage proprietary); too ambiguous and single non-independent source (no data). 13 Dawgs s2962 is a different strain.
- Supreme: generic descriptor/brand word (Supreme OG, Supreme Cream, Supreme Runtz etc. exist separately) (skip).
- Girl Scout Cookie: singular form of Girl Scout Cookies s4 (Leafly's /girl-scout-cookie page is the GSC page). Alias "Girl Scout Cookie" added (skip). s4 corrected vs Leafly + AllBud (batch 68): THC 19-28% blanked (25% vs 28%), Caryophyllene/Limonene/Humulene terps blanked (Leafly lists caryophyllene>myrcene>limonene, single source), effects -> Euphoric/Relaxed, flavor -> "mint and sweet with cherry and lemon notes", lean Indica-dominant blank-filled (both label it), ailments Stress/Anxiety/Depression/Pain/Nausea/Lack of Appetite blank-filled (both). Parents OG Kush x F1 Durban confirmed. Held: breeder "Cookie Fam Genetics" (Leafly says Jigga; AllBud none) - not changed.
- Terp Gang OG: only a Michigan brand (Terple Gang) press; no strain pages (no data).
- Platinum Moby Dick: no pages found (searches return only Moby Dick) (no data).

## S113 (rows 3473-3477)
- Humboldt OG: existing s7034 (Happy Dreams Genetics; (SFV OG x Skywalker) x Triangle Kush; Indica-leaning; woody/earthy/floral). Only GrowDiaries (breeder-side, 25% THC, Uplifted/Euphoric/Giggly, Pain/Migraines/Anxiety) + SeedFinder page + jointcommerce blog (not independent); Leafly/AllBud not retrievable. Entry left unchanged; effects, THC, ailments held (single source).
- Purple CBD: no strain page found (only seedbank products Purple CBD Auto / Purple Orange CBD) (no data).
- Master Cookies: AllBud (SoCal Master Kush x Forum Cookies, 50/50, THC 15-19%) + SeedFinder (Mamiko Seeds, two lineage versions, indica-dominant) agree only on breeder-side parentage and disagree on balance; held, no entry (precedent: Chem IBL, Killa Kush etc.) (no data).
- RJ OG: not provable as Rick James OG; no strain pages (no data).
- Kryptilla: no strain pages found (only Krypt/Kryptochronic lookalikes) (no data).

## S114 (rows 3478-3482)
- Snowcap OG: "OG" suffix not documented (Leafly alternate names are Sno Cap, SnoCap) (skip, variant of Snowcap s1211). s1211 corrected vs Leafly + AllBud (batch 69): THC 19-25% and CBD <1% blanked (19% vs 21-24%; AllBud CBD 4%), sample-style Limonene/Terpinolene/Linalool terps blanked (Leafly: terpinolene dominant, single source), effects -> Creative (only overlap), flavor -> "lemon and menthol", ailments Stress/Anxiety/Depression blank-filled, alias "Sno Cap" added. Held: parents (Leafly Haze x Snow White vs existing Humboldt Snow x Haze; AllBud none - left as is, flag), lean (AllBud 50/50, Leafly none).
- Girls Scout Cookies: misspelling of Girl Scout Cookies s4; alias added (skip). s4 already corrected in S112.
- Peanut Butter Cookies: NEW s7436. Leafly + AllBud: Hybrid, Indica-dominant (65/35 both), Peanut Butter Breath parent (Leafly GSC x PBB vs AllBud Forum Cookies x PBB - only PBB stored), effects Happy/Relaxed, flavor nutty, Stress/Depression. Held: THC (22% vs 15-23%), second parent, terps (Leafly only).
- San Fernando OG: alias of SFV OG s7280 (Leafly aka list: San Fernando Valley OG/Kush); alias added (skip). s7280 matches Leafly (Focused/Relaxed/Happy, pine/earthy/woody, parent OG Kush) - unchanged. POSSIBLE DUPLICATE: s144 SFV OG Kush (aka San Fernando Valley OG Kush) - same strain family; not merged without evidence.
- Royal Hillbilly Kush: no strain pages (only Royal Kush, a different strain) (no data).

## S115 (rows 3483-3487)
- Healing Rain, Dube OG, BD 28: no strain pages found (no data).
- AK Hash Plant: no strain pages; Hash Plant s591 exists but "AK" prefix undocumented (no data).
- Platinum OG Kush: Platinum OG was missing from the library, so NEW s7437 Platinum OG added (Leafly + AllBud): Hybrid, Indica-dominant (AllBud 75/25, Leafly "indica-dominant"), OG Kush x Master Kush (both, plus an unknown parent), effects Relaxed/Sleepy, flavor "pine", ailments Stress/Anxiety/Pain. Held: THC (19% vs 20-24%), terps (Leafly only). The name "Platinum OG Kush" is NOT listed as an alias by either source, so no alias was attached (read as Platinum OG, row marked added with this caveat).
- FLAG: existing s62 Platinum Kush carries aka "Platinum OG", but Leafly's Platinum Kush (OG Kush x Afghani, aka Platinum Kush OG) is a different strain from Platinum OG (OG Kush x Master Kush). Single-source (AllBud's Platinum Kush not checked); s62 left unchanged until its own row comes up.

## S116 (rows 3488, 3490, 3491, 3492, 3493)
- Ripped Bubba: existing s7273 checked vs Leafly + AllBud; corrected via batch 70: lean Indica-leaning -> Indica-dominant (both label it indica-dominant hybrid; AllBud 60/40), CBD "0-2%" blanked (unsupported), single Myrcene terp blanked (Leafly: terpinolene dominant), breeder "TGA Seeds" -> "TGA Genetics" (both). Parents Pre-98 Bubba Kush x Jack the Ripper, effects Creative/Relaxed, flavor and ailments Stress/Pain/Depression all confirmed. THC held (16% vs 22-26%). Added (existing entry checked).
- O.D. OG Kush: no strain pages found (no data).
- Swiss Tsu, M0: "Swiss Tsu" is a Leafly alternate name of Swiss Tsunami s492; "M0" label undocumented (skip). s492 was wrong: it is a CBD-dominant strain (CBD ~14%, THC <1%), but carried THC 12-17%, CBD <1% and sample-style Limonene/Myrcene/Caryophyllene terps. Corrected via batch 70 (Leafly + AllBud): THC "<1%", CBD "14%", terps blanked, effects -> Happy/Uplifted, flavor -> "citrus, orange and diesel", ailments -> Pain/Inflammation/Nausea (Stress/Depression single-source dropped), lean Sativa-dominant (AllBud 70/30, Leafly Sativa), parents Swiss Gold x Sour Tsunami, aka Swiss Tsu/Swiss-Tsu blank-filled.
- Purple Skywalker Mango: no strain pages for the exact name (Purple Skywalker and Purple Mango are separate strains; a cross is not proven) (no data).
- LRBL- Purple Urkel x...: name truncated, breeder-code prefix; only Purple Urkle/Jaleel White brand press found (no data).

## S117 (rows 3494, 3495, 3497, 3498, 3499)
- LRBL- GSC and LRBL- SFV OG: breeder-code prefix labels (LRBL undocumented) on Girl Scout Cookies s4 / SFV OG s7280; no separate documentation (skip).
- Thai-Dye: only SeedFinder (Kismet Nursery: Potent Purple x Blue Newgoo Bx2, breeder-side, single source); Chocolate Thai-Dye (AllBud) is a different strain (no data).
- Nando Og: no strain pages found (no data).
- 1ST 48: numeral variant of First 48 s4203 (Leafly alt name F48; aliases "1st 48", "F48" added). s4203 corrected vs Leafly + AllBud (batch 71): type Sativa -> Hybrid (both say hybrid), lean Sativa-leaning blanked (AllBud 70/30, Leafly none), THC "up to 27%" blanked (21% vs 29%), effects -> Relaxed/Focused, flavor -> "citrus", ailments Depression/Stress blank-filled (both). Parents The White x Orange Blossom Trail confirmed. Held: breeder spelling (Leafly "Swamp Boy Seeds" vs entry "Swamp Boys Seeds", single source), terps (Leafly only: myrcene).

## S118 (rows 3500-3504)
- CBD Kush #2: CBD Kush was missing, so NEW s7438 CBD Kush added (Leafly + AllBud): Hybrid, parent Kandy Kush (other parent an unnamed high-CBD strain), effects Relaxed/Focused/Happy, flavor "nutty and woody", ailments Stress/Anxiety/Pain, alias Kush CBD. Held: lean (AllBud 50/50, Leafly none), THC/CBD values (Leafly THC 22% header vs AllBud THC 1-8%/CBD 7%; both only agree on ~1:1 ratio), breeder (Leafly: CBD Crew/Dutch Passion; AllBud none). The "#2" label is undocumented.
- Litt Gorilla Glue #4: "Litt" is a brand/producer label of Gorilla Glue #4 s1518 (skip). s1518 corrected vs Leafly + AllBud (batch 72): THC 25-30% blanked (20% vs 32%), Caryophyllene/Limonene/Myrcene terps blanked (Leafly order caryophyllene>myrcene>limonene, single source), effects blanked (sources share no effect: Leafly Relaxed/Sleepy/Hungry vs AllBud Body High/Euphoria/Happy/Uplifting), flavor -> "pine" (only overlap), lean Indica-leaning blank-filled (63% / 60% indica), ailments Stress/Depression/Pain blank-filled. Parents Chem's Sister x Sour Dubb x Chocolate Diesel confirmed, GG Strains breeder kept.
- Bird Blazer: no strain pages found (only Blaze/The Bird lookalikes) (no data).
- SFV: abbreviation of San Fernando Valley OG s7280; alias "SFV" added (skip).
- O.D. Shreck: no strain page for the exact name; AllBud's Outdoor Shrek not proven to be the same (no data).

## S119 (rows 3505-3509)
- Trinity OG: "OG" suffix undocumented (Leafly alt name is "Tri"); variant of Trinity s286 (skip). s286 corrected vs Leafly + AllBud (batch 73): THC 23-27% blanked (20% vs 17-20%), Myrcene/Ocimene/Linalool terps blanked (Leafly myrcene dominant, single source), effects -> Uplifted/Focused, flavor -> "skunky and woody", ailments -> Depression/Stress/Anxiety (Pain/Muscle Spasms AllBud only dropped), lean Sativa-dominant blank-filled (AllBud 75/25, Leafly Sativa). Parents unconfirmed (AllBud: unclear), left blank. Held: type (Leafly Sativa vs AllBud sativa-dominant hybrid; kept Hybrid).
- Strawberry Tahoe: AllBud only (Tahoe OG x Strawberry Cough, 70/30 sativa); Leafly not retrievable; jointcommerce/Weedmaps not independent (no data, single source).
- Black Jack (R): "(R)" = seed-type label (regular); strain is Black Jack s1039 (skip). s1039 corrected vs Leafly + AllBud (batch 73): THC 20-25% blanked (19% vs 14-24%), Limonene/Pinene/Linalool terps blanked (Leafly terpinolene dominant, single source), effects -> Focused/Relaxed, flavor -> "pine", ailments Stress/Anxiety/Depression blank-filled. Parents Black Domina x Jack Herer confirmed. Held: lean (AllBud 70% indica, Leafly none), breeder Sweet Seeds (Leafly only). AllBud notes a second strain sold as "Blackjack".
- Dube Dee, Dube Doo: no strain pages found (no data).

## S120 (rows 3510-3514)
- King Leet, Daking, Wu Tang: no strain pages found (searches return only unrelated names; direct Leafly/AllBud lookups failed) (no data).
- Key Lime Sherbert: no strain pages; only Key Lime Pie pages (separate entry s1584) and an unrelated 3C Lime Sherbert product; not proven an alias (no data).
- Cookie: generic family descriptor (Leafly lists "Cookies" as an alias of GSC s4) (skip).

## S121 (rows 3515-3519)
- Monkey Cheese: search returned only generic Cheese pages and unrelated Milk/Chunky/Funky Monkey; no strain page (no data).
- Outside Swiss Tsu: grow-location label on Swiss Tsunami s492 (skip). Search returned only Swiss Tsunami pages (Leafly, AllBud, Releaf); s492 already corrected S116 with aliases Swiss Tsu / Swiss-Tsu.
- 0.1 / 4.1 / 4.0 Swiss Tsu: numeric labels with no documented meaning in any source; treated as variant labels of s492, no new aliases written (skip x3).
- Healing Rain M2: searched early, no strain page found; left for S122 with M1 (still needs research).

## S122 (rows 3520-3524)
- Healing Rain M2 / M1: no strain pages (only unrelated Golden Healing / The Sense of Healing CBD / Rainbow results) (no data x2).
- Plat. Cookies: abbreviation of Platinum Cookies s2296. Leafly (Hybrid, 17% THC, OG Kush x Durban Poison + unknown, Relaxed/Euphoric/Happy, sweet/flowery/earthy, caryophyllene>limonene>myrcene, Stress/Pain/Anxiety) vs AllBud (Hybrid 50/50, 18-26% THC, OG Kush x Durban Poison, relaxing/uplifting, candy/sweet, anxiety/pain/migraines/nausea/stress). Agreed and written: effects Relaxed only, flavor "sweet", ailments Stress/Pain/Anxiety (blank-fill). THC disagrees (blank kept), terps single source (held), lean blank. Migration batch 74 (effects, flavor). Breeder "Cookie Fam Genetics" not given by either source (left, flagged).
- 10# Hammer: no page for a 10-pound version; search only returned 9 Pound Hammer s87 pages; not proven same (no data).
- Fireberry: no strain page (search only Fire Berries by Interstate 420 / Blackberry Fire, different names) (no data).

## S123 (rows 3525-3529)
- Bubble Gum (MO) -> s1058 (MO is a label). Leafly (Hybrid, 17% THC, parent Indiana Bubble Gum, Happy/Relaxed/Euphoric, flowery/sweet/berry, caryophyllene>limonene>myrcene, Stress/Anxiety/Depression, aliases Bubba Gum/Bubblegum/Bg) vs AllBud (Hybrid 50/50, 13-19% THC, Indiana BubbeGum x unknown hybrid, Creative/Euphoria/Giggly/Happy/Relaxing/Uplifting, berry/creamy/fruity/sweet, depression/insomnia/nausea/stress...). Agreed and written: effects Happy/Relaxed/Euphoric, flavor "sweet and berry", ailments Stress/Depression, parent Indiana Bubble Gum, aka Bubblegum. Blanked sample-style THC 23-29%, CBD <1%, terps (Terpinolene/Ocimene/Myrcene), effects Focused/Sleepy/Social, flavor. THC disagrees, terps single source, lean blank (Leafly text indica-dominant vs AllBud 50/50). Breeder Serious Seeds kept (SeedFinder/GrowDiaries list a Serious Seeds Bubble Gum, breeder-side only) but flagged: Leafly says Indiana grower origin. Migration batch 75 (5 corrections).
- Sweet Purple (MO) -> s6082. Leafly (Hybrid, 10% THC, Thai x Dutch, Paradise Seeds, Uplifted/Happy/Relaxed, Insomnia/Pain/Stress, pinene>ocimene>limonene) vs AllBud (Hybrid 50/50, desc indica dominant, 10-15% THC, Purple Dutch x unknown, Body High/Relaxing/Uplifting, Anxiety/Pain/Depression/Nausea/Stress/Insomnia). Existing effects/THC/flavor consistent, kept. Filled ailments Stress/Insomnia/Pain. Blanked lean Indica-leaning (AllBud numeric 50/50 vs its own text, Leafly none) via migration 75. Parents disagree (Thai x Dutch vs Purple Dutch x unknown), left. Terps single source, held.
- Atomic Haze (MO): only a CAKE cartridge listing; no strain page. Atomical Haze (Paradise Seeds, s757) is a different name, alias not proven (no data).
- PlanCash #1: search returns only Schedule 1 game pages; no strain page (no data).
- Sweetwater Veterans...: name truncated in the Sheet; search finds only Sweetwater OG and veteran programs/brands; not identifiable as a strain (skip).

## S124 (rows 3530-3534)
- Blue Snow: no strain page (search returns Blue Snowdog by Oregon Green Seed, Blue Raspberry Snow Cone, Snow Dream: different names) (no data).
- OD Jack Herer: no page; only generic Jack Herer s10 pages; "OD" undocumented (no data).
- Harle 4 / Harle 3 / Harle 2: no strain pages; searches return only Harlequin and Harle-Tsu pages; numeric labels undocumented, not proven phenos of either (no data x3).
- Side check, Harle-Tsu s6883 (data helped another entry): Leafly (Hybrid, 0% THC, 11% CBD, Southern Humboldt Seed Collective, Harlequin x Sour Tsunami, Relaxed/Focused/Uplifted, woody/spicy/earthy, myrcene>pinene>terpinolene, Pain/Stress/Anxiety) vs Cannigma (indica-dominant, ~0.6% THC, avg 6.3% CBD (max 15, breeder 20), same parents/breeder, relaxing/sleepy/euphoric/focused, earthy sweet, myrcene+terpinolene dominant, uses Arthritis/Inflammation/Dementia/Anxiety/Epilepsy). Agreed and written: effects Relaxed/Focused (Uplifted dropped), flavor "earthy", terps Myrcene only, ailments Anxiety. Blanked CBD 11-20% (sources disagree) and lean Indica-leaning (single source). THC <1% and parents/breeder/aka kept (agree). Migration batch 76 (4 corrections).

## S125 (rows 3535-3539)
- Wappa (D) and Wappa (W) -> s2099 ((D)/(W) are labels). Leafly (Hybrid, 60% indica-dominant, 24% THC, Paradise Seeds, Relaxed/Sleepy/Giggly, tea/tree fruit/sweet, caryophyllene>myrcene>limonene, Stress/Anxiety/Depression, alias Wpa) vs AllBud (Indica Dominant Hybrid 60/40, 18-19% avg THC, Paradise Seeds, genetics unknown, Euphoria/Happy/Hungry/Relaxing/Sleepy/Sociable, citrus/fruity/sweet, many ailments). Agreed and written: lean Indica-dominant (both label it dominant), effects Relaxed/Sleepy, flavor "sweet and fruity", ailments Stress/Anxiety/Depression. Blanked sample terps (Pinene/Caryophyllene/Myrcene; Leafly only has real ranking). THC 18-24% kept (covers both). Migration 77.
- Magic Bud (W) -> s7117, checked, no change. Leafly (Hybrid, 25% THC, energetic/uplifted/focused, lemon/citrus/lime, myrcene>caryophyllene>limonene, no breeder) conflicts with AllBud (50/50, 16-20% THC, body high/relaxation/euphoric, sweet floral earthy, parent Victory) and SeedFinder Paradise Seeds page (Victory x unknown, 16-20%, indica-dominant, vanilla/floral). Leafly seems to describe a different product; AllBud + SeedFinder only agree on breeder-side parentage so held with no entry. Breeder Paradise Seeds supported by SeedFinder, kept. Lean blank (50/50 vs indica-dominant).
- All Kush (W) -> Allkush s963 (spelling). Leafly (Indica, 75/25 indica-dominant, Paradise Seeds, Uplifted/energetic/sleepy, honey/pungent/sweet, Stress/Depression/Pain, alias Aku) vs AllBud (Indica-dominant hybrid 75/25, 15-18% THC, Happy/Relaxing/Sleepy/Uplifting, herbal/honey/spicy/sweet, Anxiety/Pain/Depression/Insomnia/Stress, OG Kush family uncertain, 2nd place 2005 Highlife Cup). Agreed and written: lean Indica-dominant, effects Uplifted/Sleepy, flavor "honey and sweet", ailments Stress/Depression/Pain/Anxiety/Insomnia, breeder Paradise Seeds (Leafly + SeedFinder). Blanked sample THC 21-28%, CBD <1%, terps (Terpinolene/Myrcene/Humulene). THC disagrees/single, aka Aku single source, parents unknown. Migration 77.
- Lucid Bolt (W) -> s712. Leafly (Paradise Seeds, indica-dominant, Energetic/Uplifted/Talkative + reviewers Relaxed/Happy/Giggly/Hungry/Sleepy, blueberry/berry/pine, Insomnia/Lack of Appetite/Stress) vs AllBud (Sativa-dominant 80/20 header but description indica-dominant 70/30, 21% THC, Body High/Creative/Focus/Happy, dank/diesel/herbal/lemon, Chronic pain/Depression/Fatigue/Headaches/Nausea/Stress). Weak overlap: effects Happy/Giggly/Sleepy, flavor "berry" (AllBud aroma mention), ailments Stress. Blanked sample THC 13-17%, CBD <1%, terps. Lean/type left (AllBud header disagrees). Breeder Paradise Seeds single source, held. Flag: AllBud may be describing a different strain. Migration 77.
- Migration batch 77: 16 corrections (s2099 x5, s712 x6, s963 x5).

## S126 (rows 3540-3544)
- All Kush (D): duplicate label of Allkush s963, corrected in S125 (added).
- Jack Tangie: no Leafly page (Leafly Tangie Jack fetch failed). AllBud has "Tangie Jack" (sativa-dominant 70/30, 20% THC, Tangie x Jack Herer, creative/euphoric/happy/uplifting, citrus/lemon/orange/pine/sweet, depression/fatigue/headaches/migraines/nausea/stress); SeedFinder only lists Crockett Family Farms "Jack Tangie x (Strawberry Banana x Tangie)" with Jack Tangie as an unprofiled parent (Jack Herer x Crockett's Tangie implied). Single usable source, name-reversal alias not proven, breeder-side parentage only: held, no entry (no data).
- Erlich Bachman Slider: no strain page (searches only return Cherry Slyder, Unicorn Sliderz, etc.) (no data).
- Cheese x Lavender: no strain page; only generic cheese and Lavender pages; looks like a cross label (no data).
- Santa Cruz Girl Scout...: name truncated in the Sheet; search returns only generic Girl Scout Cookies s4 pages; not identifiable as a distinct strain (skip).
- No library changes this batch.

## S127 (rows 3545-3549)
- Gelato #1: no strain page; Gelato pheno numbers documented in library are #25/#33/#41/#43/#45/#47/#49, no #1 (no data).
- HD- Mango KCB -> Mango s59 (KC Brains; "HD-" prefix undocumented, label). Leafly (Indica, 17% THC, KC 33 x Afghani, Hungry/Relaxed/Sleepy + euphoric/uplifting, mango/tropical/sweet, myrcene>pinene>caryophyllene, Stress/Anxiety/Pain, aliases Mango OG/Mgo) vs AllBud (Hybrid 50/50, desc indica-leaning, 15-24% THC, CBD 10%, KC 33 + Mango unclear, Euphoria/Happy/Hungry, citrus/fruity/sweet/tropical, Depression/Insomnia/Loss of appetite/Migraines/PTSD). Agreed and written: effects Euphoric/Hungry, flavor "sweet and tropical", ailments Pain. Blanked sample THC 21-30%, CBD <1% (AllBud says 10%), terps. Parents/breeder/aka kept (breeder not on either page, KC Brains is the known seed source). Leafly says Mango aka Mango OG: s59 may duplicate s1802 Mango OG and s5071 Mango Cannabis (also KC 33 x Afghani); single-source evidence, no merge. Migration 78.
- Madusa OG: no strain page (search returns Madman OG, Zeus OG, Medusa dispensary product) (no data).
- Lemon OG Seeded -> Lemon OG s1144 ("Seeded" = seeded flower label). Leafly (Hybrid/indica-dominant, 19% THC, Lemon Skunk x OG #18, Relaxed/Sleepy/Hungry, lemon/citrus/skunk, caryophyllene>myrcene>limonene, Stress/Anxiety/Pain, alias Lemon OG Kush) vs AllBud (Hybrid 50/50, 22% THC, same parents, Creative/Focus/Happy/Relaxing + sleepiness/euphoria, lemon/tangy/citrus, chronic pain/insomnia/appetite/stress, reviews anxiety). Agreed and written: effects Relaxed/Sleepy, flavor "lemon and citrus", ailments Stress/Pain/Anxiety. Blanked CBD <1%, sample terps, breeder "Bud Rx Delivery" (on neither page). Parents, THC 18-23%, aka kept. Migration 78.
- Cooking Nugs Seeded: no strain page; search only returns cooking-with-cannabis articles and unrelated products (no data).
- Migration batch 78: 11 corrections (s59 x6, s1144 x5).

## S128 (rows 3550-3554)
- F-3: no strain page (searches return Temptation F3, Finesse F3, Ciskei F3 etc., different names) (no data).
- Purple OG (D) -> Purple OG Kush s555 (read as the same strain; AllBud has a separate Purple OG #18 page, not used). Leafly (Indica, 19% THC, OG Kush x Purple Kush, Sleepy/Hungry/Relaxed, earthy/grape/pine, myrcene>limonene>caryophyllene, Stress/Pain/Anxiety, alias Pok) vs AllBud (Hybrid 50/50 header, description indica-dominant, 16-20% THC, Purple Kush x Cali OG Kush, Body High/Euphoria/Happy/Hungry/Relaxing + sleepy, berry/diesel/grape/pine/spicy/sweet, many ailments). Agreed and written: lean Indica-dominant (was Indica-leaning), effects Relaxed/Sleepy/Hungry, flavor "grape and pine", ailments Stress/Pain, THC 16-20% (filled). Parents kept. Terps single source, held. Migration 79.
- White Berry (W) -> s75 (Paradise Seeds). Leafly.ca (Indica listing, Euphoric/Creative/Focused, berry/sweet/blueberry, Stress/Anxiety/Pain, no genetics) vs AllBud (indica-dominant 65/35, 16-22% THC, White Widow x DJ Short Blueberry, Body High/Creative/Euphoria/Happy/Relaxing, blueberry/berry/sweet..., Anxiety/Depression/Insomnia/Stress, aliases Blue Widow/Berry White). Agreed and written: effects Euphoric/Creative, flavor "blueberry and sweet", ailments Stress/Anxiety, lean Indica-dominant (AllBud numeric + Leafly same direction). Blanked implausible CBD 18-24% and sample terps. THC 16-22% kept (matches AllBud, Leafly none). Parents held (AllBud only). Flag: AllBud aliases Blue Widow / Berry White overlap Berry White s42 (White Widow x Blueberry); possible duplicate, Leafly keeps separate pages, no merge. Migration 79.
- Nebula 2 (W): = Nebula II CBD (Paradise Seeds x CBD Crew). Leafly (Hybrid 60/40 sativa-dominant, ~7% CBD 1:1, parent Nebula, Focused/Energetic/Talkative, honey/woody/earthy, Anxiety/Stress/Pain, aliases Nebula 2/Nb2) and SeedFinder breeder page found, but no AllBud page and no independent second source, so held with no entry (no data). Existing s1158 Nebula (THC 27-30%) is a different strain and still sample-style.
- Santa Sativa (MO) -> s475 (Dinafem Seeds). Leafly (Sativa 70/30, 13% THC, Northern Lights x Haze, Dinafem, Energetic/Aroused/Creative, blueberry/diesel/berry, caryophyllene>limonene>pinene, Fatigue/Lack of appetite/Stress, alias Ssa) vs AllBud (sativa-dominant 70/30, 16-20% THC, Haze #1 x (Skunk x Northern Lights), Aroused/creative/euphoric/happy/uplifting, citrus/lemon/pine/earth, many ailments). Agreed and written: lean Sativa-dominant, effects Aroused/Creative, ailments Lack of Appetite/Stress, parents Northern Lights + Haze, breeder Dinafem Seeds (Leafly + SeedFinder). Blanked sample THC 15-19%, CBD, terps and flavor (flavors disagree entirely), effects Sleepy/Talkative/Tingly. Migration 79.
- Migration batch 79: 15 corrections (s475 x6, s75 x5, s555 x4).
- Note: this session's fetch tool only accepts URLs returned by WebSearch (constructed Leafly/AllBud URLs were refused), so each strain is searched first.
