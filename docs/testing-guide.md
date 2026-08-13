# Testing Guide

How to run and extend the test suite. Tests use [Vitest](https://vitest.dev/);
tests live in `__tests__/` folders beside the code they cover.

## Running

```bash
npm test           # run all unit tests once (vitest run)
npm run test:watch # watch mode while developing
npm run typecheck  # tsc --noEmit — type safety across the whole project
npm run lint       # eslint . — lint all TypeScript/TSX
```

## Current coverage

104+ unit tests across 14 files (all passing):

| Area | File |
|------|------|
| Geometry formulas | `src/lib/packing/__tests__/config.test.ts` |
| Stackability matrix | `src/lib/packing/__tests__/config.test.ts` |
| Weight estimator | `src/lib/packing/__tests__/config.test.ts` |
| Column map parsing | `src/lib/packing/__tests__/config.test.ts` |
| Van fleet config | `src/lib/packing/__tests__/config.test.ts` |
| Heuristic packer (19 tests) | `src/lib/packing/__tests__/heuristic-packer.test.ts` |
| Fleet allocator | `src/lib/packing/__tests__/fleet-allocator.test.ts` |
| Item assembly | `src/lib/packing/__tests__/item-assembler.test.ts` |
| Placement validator | `src/lib/packing/__tests__/placement-validator.test.ts` |
| Stacking report | `src/lib/packing/__tests__/stacking-report.test.ts` |
| Van repository (file I/O) | `src/lib/packing/__tests__/van.repository.test.ts` |
| Van ranking | `src/lib/packing/__tests__/ranking.test.ts` |
| **Pipeline integration** (Stage 1→5) | `src/lib/packing/__tests__/pipeline.test.ts` |
| Pricing calculator | `src/lib/pricing/__tests__/calculator.test.ts` |
| Google Maps provider | `src/lib/routing/__tests__/google-maps.provider.test.ts` |
| Storage SigV4 signing | `src/lib/storage/__tests__/sigv4.test.ts` |

Shared fixtures: `src/lib/packing/__tests__/fixtures.ts`.

## Writing a test

1. Put it in a `__tests__/` folder next to the module.
2. Test pure `lib/` logic directly — no Next.js runtime needed.
3. For code that calls external APIs (Mistral, Google Maps), inject or mock
   the dependency; services accept injectable deps for this reason
   (see `pricing/index.ts` `PricingServiceDeps`).
4. Prefer one comprehensive scenario test over many single-assertion tests.

## Pre-existing environment failures

Two test files may fail if the env is not configured:

| File | Condition |
|------|-----------|
| `src/lib/storage/__tests__/sigv4.test.ts` | Requires crypto / Node 18+ |
| `src/lib/routing/__tests__/google-maps.provider.test.ts` | Mocks fetch — passes in isolation, check vitest env |

Neither failure indicates a regression in packing or pricing logic.

## Manual UI verification

Per the project's non-negotiable rule, a stage isn't "done" until clicked through
in the running UI: `npm run dev`, then upload → classify → pack → quote.

Required env vars for live stages:
- `MISTRAL_API_KEY` — OCR (Stage 1)
- `GOOGLE_MAPS_API_KEY` — routing (Stage 5)

All other stages (classification, packing, pricing math) work without external keys.

## Integration test

`src/lib/packing/__tests__/pipeline.test.ts` exercises the full Stage 1→5 chain
in-process (no network, no PDF parsing):

1. `assembleItems` — builds `Item[]` from a minimal `StructuredDocument`
2. `HeuristicPacker` — places items in a test van
3. `allocateFleet` — picks the cheapest van fleet
4. `calculateQuote` — prices the job by distance × rate
5. Full chain: assembly → allocation → pricing → asserts positive total

---

## Manual end-to-end script

Run after any significant change. Dev server: `npm run dev` (port 3000); `.env` with
`MISTRAL_API_KEY` + `GOOGLE_MAPS_API_KEY`; sample `shafs/INDUSTRIAL_QUOTATION.pdf`.

| Step | Action | Pass if | Fail if |
|------|--------|---------|---------|
| 1 — Upload | Drop the PDF on the drop zone | Spinner → item table (~20 items, ~11 fragile); perf timings show | Error banner / no table / spinner stuck |
| 2 — Classification | Override a fragile item's badge to standard | Badge flips, "manual override" on hover, packing re-runs | Override has no effect |
| 3 — Packing | Scroll to Packing section | Fleet card + 3D viewer render; some items `z>0`; volume % shown | Viewer blank / all at z=0 / NaN |
| 4 — Oversized | Inspect "Unplaced items" | 12 m I-Beam listed unplaced with "exceeds largest van interior" reason; fitting items placed | Beam reported as placed |
| 5 — Quote | Origin "London, UK" → Destination "Manchester, UK", Get Quote | ~212 mi, per-van line items, surcharges, positive total | Total £0 / route not found |
| 6 — Reset | "Start Over / New Quote" | All fields + tables + viewer clear | Old results persist |
| 7 — History | Refresh, expand Quote History | Last quote is first entry; count grows | Empty after a success |
| 8 — Admin | Edit a van's per-mile rate ±0.10, save | List updates; re-quote reflects new rate | Not persisted / total unchanged |

Edge cases: PDF with no tables → "No tables found"; all-fragile → high surcharge line;
heavy items over payload → fleet adds a van; origin = destination → distance 0, total =
surcharges only; missing `GOOGLE_MAPS_API_KEY` → "Routing API not configured" but packing
still works.
