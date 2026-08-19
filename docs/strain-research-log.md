# StrainDex Strain Name/Data Research Log

Purpose: track candidate strain-name sources found so far, what's actually
usable in each, and what's queued up for future batches.

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

