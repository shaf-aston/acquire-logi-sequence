# groupage

Owns groupage (shared-truck / LTL) quoting: postcode-to-hub resolution, freight demand, the collect-trunk-deliver path, dual-capacity (space + weight) checks, and rate-card pricing. It does NOT own shipment state once booked (see `groupage-ops`) or 3D box packing (that's the single-drop `packing` stage).

## Key files
| File | Role |
|------|------|
| `groupage.types.ts` | Domain types: `Hub`, `GroupagePallet`, `DualCapacity`, `GroupagePath`, `GroupageQuote`, `GroupageError` |
| `hub-resolver.ts` | Postcode -> postcode-area -> owning `Hub`; fail-loud on catchment gap |
| `path-builder.ts` | Builds the `collect -> [trunk] -> deliver` path; local move = no trunk leg |
| `demand.ts` | Sums a booking's pallet lines into footprint units + weight (freight profile) |
| `capacity.ts` | Dual-limit (pallet-spaces AND weight) check per leg and across the path. **Measures, doesn't gate**: an over-capacity load is quoted with `fits: false` + `vehiclesNeeded`, and any pallet no vehicle can carry is listed in `oversizeLines`. Hard reject only under `enforceLegCapacity` |
| `pricing.ts` | Rate-card lookup: line-haul + first/last-mile + heavy-pallet surcharge. Line-haul bills the greater of floor space and the space-equivalent of weight (`chargeableSpaceBasis`), so a weight-out load doesn't buy three trucks and pay for one |
| `groupage-rates.ts` | Loads + validates `config/groupage-rates.json` (rates, footprint units, leg capacities) |
| `hub.repository.ts` | `HubRepository` swap-seam: `FileHubRepository` (backs `config/hubs.json`) + `InMemoryHubRepository` |
| `hub-extractor.ts` | Best-effort hub candidates scraped from OCR'd PDF text (tier-3 hub sourcing, needs operator confirmation) — not currently re-exported from `index.ts`, import it directly if needed |
| `parse.ts` | Trust-boundary parsing of untrusted groupage request bodies (shared by quote + shipment API routes) |
| `service.ts` | `getGroupageQuote` — orchestrates resolve -> demand -> path -> capacity -> price into a `GroupageQuote` |
| `index.ts` | Public barrel; only this surface should be imported from outside the module |

## How it fits
This is the groupage mode's quoting engine (a sibling to the single-drop pipeline and to `stop-chain`, not a config of either). `service.ts` is called by `src/app/api/groupage/route.ts` and by `groupage-ops` when booking a confirmed quote into a `Shipment`. Once a quote is booked, `groupage-ops` takes over — this module never tracks status after that point.

## Docs
- [`docs/logistic-modes/groupage.md`](../../../docs/logistic-modes/groupage.md) — the groupage blueprint (hub network, dual-capacity rule, pricing formula)
- [`docs/logistic-modes/groupage-implementation-plan.md`](../../../docs/logistic-modes/groupage-implementation-plan.md) — build plan, deferred boundaries (timetables, hold-ledger, multi-hop trunk)
- [`docs/logistic-modes/logistics-modes-flows.md`](../../../docs/logistic-modes/logistics-modes-flows.md) — how groupage relates to the other logistics modes
