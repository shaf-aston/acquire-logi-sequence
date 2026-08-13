# Classification

Stage 2 (fragility) and part of Stage 3 (durability) classification: turns item-table rows / material strings into stacking-safety facts. Two independent swap-seams, each with a rule engine (no network) and one has an optional LLM engine (Groq); does not own the packing math itself (`packing/` reads these results).

## Key files
| File | Role |
|------|------|
| `types.ts` | Stage 2 fragility domain types (`Fragility`, `ClassifiedItem`, `Classifier` interface). |
| `classifier.factory.ts` | Selects the fragility engine via `CLASSIFIER_PROVIDER` (currently `rule` only). |
| `rule-classifier.ts` | Fragility rule engine: matches item-table rows against `ruleset.ts`, fragile wins ties, unmatched rows flagged low-confidence. |
| `ruleset.ts` | Loads/validates the fragility rules file (`config/fragility-rules.json`, path from config) — overrides, fragile/standard keywords. |
| `table-selector.ts` | Decides which parsed tables are item tables vs metadata, and which columns hold classifiable text. |
| `durability.types.ts` | Stage 3 durability domain types (`DurabilityTier`, `OrientationLock`, `DurabilityClassifier` interface, brittle/deformable facts). |
| `durability-classifier.factory.ts` | Selects the durability engine via `DURABILITY_CLASSIFIER_PROVIDER` (`rule` default \| `groq`). |
| `durability-rule-classifier.ts` | Durability rule engine: weakest-matched-tier wins, hollow-build knockdown, brittle/deformable/orientation keyword checks. |
| `durability-ruleset.ts` | Loads/validates `config/durability-rules.json` (tiers, overrides, hollow/brittle/deformable/orientation keywords). |
| `durability-groq-classifier.ts` | Optional LLM engine: batches unique materials into one Groq call, falls back to the rule engine per-material on failure/malformed output, in-memory result cache (process-lifetime only, no TTL/persistence). |

## How it fits
`ingestion.service.ts` calls `getClassifier()` for Stage 2 fragility right after conversion. The durability seam (`getDurabilityClassifier()`) is consumed later, by Stage 3 packing (`packing/`), which needs brittle/durabilityTier/orientationLock facts per material before computing stacking and crush limits.

Note: fragility rules (`config/fragility-rules.json`) and durability rules (`config/durability-rules.json`) are two separate config files despite both being read from this folder — don't confuse `ruleset.ts` (fragility) with `durability-ruleset.ts` (durability).

## Docs
- [`docs/architecture.md`](../../../docs/architecture.md) — swap-seam table (`Classifier` / `classifier.factory.ts` / `CLASSIFIER_PROVIDER`).
- [`docs/stacking-item-data.md`](../../../docs/stacking-item-data.md) — per-item data enrichment: durability tiers, brittle/deformable fields, why the Groq call is single-batched.
- [`docs/implementation-details.md`](../../../docs/implementation-details.md) — Stage 1-2 input/output/approach/edge cases.
