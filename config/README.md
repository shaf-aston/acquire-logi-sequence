# config

Comment-annotated, tunable domain knobs for the pipeline and its groupage/stop-chain extensions, as plain JSON. This folder owns the *data* (rules, rates, presets); it does not own env-var reading (`src/config/env.ts` resolves the file paths below and can override them) or the parsing/validation logic (each JSON has one owning parser module, e.g. `stackability.ts`, `column-map.ts`).

## Key files
| File | What it configures | Consumed by |
|------|---------------------|-------------|
| `address-detection.json` | Pickup/drop label keywords + UK postcode regex for spotting collection/delivery addresses in ingested text | `src/lib/ingestion/address-detector.ts` (Stage 1) |
| `column-map.json` | Header-pattern + fallback column indices for locating item-table columns, plus material→category regexes | `src/lib/packing/column-map.ts` (Stage 1/2) |
| `durability-rules.json` | Keyword ruleset (overrides → weakest-tier match → hollow/brittle/deformable/orientation flags) for the no-AI durability classifier | `src/lib/classification/durability-ruleset.ts` (Stage 2) |
| `durability-tiers.json` | Maps durability tier → max stack crush pressure (kPa) + deformable softening factor | `src/lib/packing/durability-tier-pressure.ts` (Stage 3) |
| `fragility-rules.json` | Keyword ruleset (overrides → longest-match → tie-break) classifying items as fragile/standard | `src/lib/classification/ruleset.ts` (Stage 2) |
| `groupage-rates.json` | Footprint units, per-leg pallet/payload capacity, rate-per-footprint, first/last-mile + heavy-pallet surcharges | `src/lib/groupage/groupage-rates.ts` (groupage mode) |
| `hubs.json` | Hub network: id/name/postcode-catchment per depot | `src/lib/groupage/hub.repository.ts` + admin `HubConfigPanel.tsx` (groupage mode) |
| `stackability.json` | Category → stacking matrix (stackable, weight-on-top ceiling, density fallback, orientation lock, crush pressure) | `src/lib/packing/stackability.ts` + `weight-estimator.ts` (Stage 3) |
| `vans.json` | Fleet van presets: interior dims, door aperture, payload, fuel/per-mile rates, quantity, size class | `src/lib/packing/van.repository.ts` (Stage 3 packing + Stage 5 pricing) |

## How it fits
`src/config/env.ts` holds the default path to each file (overridable per env var) and hands it to that file's one owning module — nothing else reads these paths directly. Edit these JSONs to retune behaviour (rates, rules, fleet); never hardcode the equivalent values in source.

## Docs
- [`../docs/implementation-details.md`](../docs/implementation-details.md) — Stage 1 (ingestion) & Stage 2 (classification) specs covering address-detection, column-map, durability/fragility rules
- [`../docs/stacking-item-data.md`](../docs/stacking-item-data.md) — deep dive on the stackability matrix + durability-tier crush-pressure model
- [`../docs/packing-logic.md`](../docs/packing-logic.md) — Stage 3 packing engine that consumes vans/stackability/column-map config
- [`../docs/admin-van-config.md`](../docs/admin-van-config.md) — van presets + per-mile rates control surface for `vans.json`
- [`../docs/fleet-allocation.md`](../docs/fleet-allocation.md) — how vans are chosen and the return journey priced (Stage 5)
- [`../docs/logistic-modes/groupage.md`](../docs/logistic-modes/groupage.md) — hub sourcing + freight-profile blueprint behind `hubs.json`/`groupage-rates.json`
