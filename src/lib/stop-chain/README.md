# stop-chain

One kind-blind engine for a full load visiting an ordered list of stops (validate stop mix -> route the chain -> pack by drop-order -> price on summed totals). Delivery (1 pickup, N drops) and collection (N pickups, 1 drop) are meant to be the same engine with a different injected validator + pack-order — this folder does not own routing or pricing math, it orchestrates them.

## Key files
| File | Role |
|------|------|
| `stop.types.ts` | `Stop`/`StopKind`, `StopChainError` (carries which check failed) |
| `validator.ts` | Injected `StopValidator` predicates; `deliveryValidator` ships now — a `collectionValidator` counterpart is not implemented yet |
| `pack-order.ts` | Injected `PackOrderStrategy`; maps routing visit order to ZonedPacker band order (delivery = identity, `collectionPackOrder` = reverse, already implemented) |
| `engine.ts` | `quoteStopChain()` — the reusable core: Check 1 (stops) -> route -> Check 2 (pack, with a free-packer fallback rung) -> Check 3 (price) |
| `index.ts` | `createDeliveryStopChain()` — the one place delivery-specific deps (validator, pack-order, ZonedPacker+HeuristicPacker, real route provider) are wired onto the engine |
| `service.ts` | `getChainQuote()` — Stage orchestrator: assembles items, loads the van, reads config, runs the engine (mirrors `pricing/service.ts` in shape) |

**Known gap:** collection mode is designed-for but not wired — `pack-order.ts` already exports `collectionPackOrder`, but `validator.ts` has no matching `collectionValidator`, and `index.ts` has no `createCollectionStopChain()` factory. V1 scope is delivery (multi-drop) only.

## How it fits
Multi-stop mode, sitting above Stage 5. API routes call `service.ts`; the engine calls into `lib/routing` (`getRouteProvider().getRouteChain`) and `lib/pricing/calculator` (`calculateQuote`) rather than duplicating either. Config (`maxStops`, `optimizeWaypointOrder`, per-stop handling minutes) flows in via `StopChainJob`/`src/config/env.ts` — the engine itself stays config-free.

## Docs
- [`docs/logistic-modes/multi-stop-full-load-plan.md`](../../../docs/logistic-modes/multi-stop-full-load-plan.md) — full design: engine shape, injected validator/pack-order, fail-loud checks
- [`docs/architecture.md`](../../../docs/architecture.md) — overall pipeline and how multi-stop extends Stage 5
