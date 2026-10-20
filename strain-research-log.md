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
