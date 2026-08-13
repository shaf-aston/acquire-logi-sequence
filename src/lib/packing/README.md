# packing

Stage 3 — the 3D van-loading engine. Turns classified line items into an exact
placement plan (position, orientation, stack order) for one van, then decides
which combination of vans carries a whole job. Owns geometry, packing
heuristics, fleet cost/allocation, and the config loaders that feed them. Does
not own PDF ingestion (Stage 1), fragility/durability classification itself
(Stage 2, consumed here), the 3D viewer (Stage 4), or routing/pricing (Stage 5).

## Key files
| File | Role |
|------|------|
| `packer.service.ts` | Stage 3 orchestrator: assemble → rank fleet → allocate → verify gate |
| `item-assembler.ts` | Joins Stage 2 classification to raw table cells → builds `Item[]` |
| `heuristic-packer.ts` | Single-van packer: first-fit-decreasing 3D, extreme-point anchors |
| `zoned-packer.ts` | Wraps the heuristic packer per-stop for multi-stop drop-order loading |
| `fleet-allocator.ts` | Branch-and-bound (+ greedy fallback): cheapest van combo for the whole job |
| `placement-validator.ts` | Single source of truth for "may this box sit here?" (bounds/overlap/support) |
| `van-classifier.ts` | Infers a session-added van's `sizeClass` from the existing fleet |
| `van-cost.ts` | Effective £/mile for a van at a given payload (fuel uplift) |
| `van-format.ts` | Shared human-readable van description (no brand name) |
| `van.repository.ts` | `VanRepository` swap-seam: file-backed fleet, or an in-memory client override |
| `geometry.ts` | Pure area/volume helpers |
| `orientation.ts` | Axis-permutation + rotation-lock logic shared by packer and allocator |
| `weight-estimator.ts` | Per-item weight: explicit value, else volume × category density |
| `durability-tier-pressure.ts` | Loads `config/durability-tiers.json` (tier → crush pressure) |
| `stackability.ts` | Loads `config/stackability.json` (category → stack rules) |
| `column-map.ts` | Loads `config/column-map.json` (table columns, units, category codes) |
| `config-loader.ts` | Generic "read JSON, parse-or-throw" helper reused by the loaders above |
| `packing.types.ts` | Domain types: `Vec3`, `Item`, `Van`, `Placement`, `PackingResult`, `Packer` |

`heuristic-packer.ts` and `zoned-packer.ts` are two `Packer` implementations,
not a legacy/replacement pair: `ZonedPacker` wraps `HeuristicPacker` (or any
`Packer`) unchanged, slicing the van into per-stop bands and packing each band
with the inner packer — used only by the multi-stop stop-chain module.

## How it fits
`packer.service.ts` is called by the API route for a quote job; it takes
Stage 1's `StructuredDocument` + Stage 2's `ClassificationResult` and returns
placements the Stage 4 3D viewer renders directly and Stage 5 prices via
`totalPerMileRate`. Reads `config/vans.json`, `config/stackability.json`,
`config/durability-tiers.json`, and `config/column-map.json` through the
loaders above; never reads `process.env` directly (goes through `@/config/env`).

## Docs
- [`docs/packing-logic.md`](../../../docs/packing-logic.md) — authoritative long-form spec: the full packing algorithm end to end
- [`docs/stacking-item-data.md`](../../../docs/stacking-item-data.md) — per-item data (durability, stacking rules) that feeds this module
- [`docs/fleet-allocation.md`](../../../docs/fleet-allocation.md) — how van choice, cross-van moves, and pricing work
