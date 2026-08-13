# pricing

Turns a routed `Route` + a set of vans into a line-itemized `Quote` (distance, fuel, driver labour, fragility surcharge). Does not compute the route itself (that's `lib/routing`) and does not decide van fit — it prices whatever vans/payloads it's given.

## Key files
| File | Role |
|------|------|
| `types.ts` | `Route`/`Leg`, `Quote`, `QuoteLineItem`, `QuoteVan` domain shapes |
| `calculator.ts` | `calculateQuote()` — pure per-van distance/fuel/labour/surcharge math, no I/O |
| `index.ts` | `getQuote()` service — loads vans, fetches the route via `routing`, calls the calculator, perf-tracks + logs |

## How it fits
Stage 5 (routing + pricing), the single-drop path. API routes call `index.ts`'s `getQuote()`; `stop-chain/engine.ts` calls `calculator.ts` directly (bypassing the single-drop service) since a chain already has its own routed totals and van — two call sites into the same pure function, keep that in mind when changing its signature. Per-mile rates and durability-based fuel rates come from `config/vans.json` via `lib/packing`, never hardcoded here.

## Docs
- [`docs/fleet-allocation.md`](../../../docs/fleet-allocation.md) — van choice, per-mile/fuel pricing, cross-van moves
- [`docs/architecture.md`](../../../docs/architecture.md) — overall pipeline and where Stage 5 sits
