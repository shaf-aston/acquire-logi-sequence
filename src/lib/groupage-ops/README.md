# groupage-ops

Owns the operational lifecycle of a booked groupage shipment: the status state machine, transition guards, manifests (per-leg capacity usage view), and shipment persistence. It does NOT compute routing, capacity-fit, or pricing for a quote (see `groupage`) — it only tracks a shipment after `groupage`'s quote has been booked.

## Key files
| File | Role |
|------|------|
| `lifecycle.types.ts` | `Shipment`, `ShipmentStatus`/`ShipmentAction` enums, `LegAssignment`, `LifecycleError` |
| `state-machine.ts` | Pure transition table: legal from-status per action + guards (e.g. no trunk on a local move, delivery-attempt cap) |
| `transitions.ts` | `applyTransition` — applies one action to a shipment (clock injected), appends an audit event |
| `manifest.ts` | `buildManifests` — pure per-leg data view: active shipments + space/weight used vs leg capacity |
| `shipment.repository.ts` | `ShipmentStore` — JSON-file persistence, always reads fresh (no cache) since multiple routes mutate shipments |
| `service.ts` | `bookGroupageQuote` (quote -> new `Shipment`) and `transitionShipment` (load -> apply -> save) |
| `index.ts` | Public barrel; only this surface should be imported from outside the module |

## How it fits
This is the operational layer behind groupage mode: once `groupage/service.ts` produces a `GroupageQuote` and it's confirmed, `bookGroupageQuote` turns it into a `Shipment` that walks booked -> collected -> ... -> complete/return-to-sender. Called by the shipment API routes and the `ShipmentsBoard` UI; it imports `GroupageQuote`/leg/capacity types from `groupage` but never recomputes routing or price — `groupage` owns the path/capacity/pricing math, `groupage-ops` owns state and history after booking.

## Docs
- [`docs/logistic-modes/groupage.md`](../../../docs/logistic-modes/groupage.md) — blueprint Parts 2-4 cover the shipment lifecycle states and manifest model documented here
- [`docs/logistic-modes/groupage-implementation-plan.md`](../../../docs/logistic-modes/groupage-implementation-plan.md) — deferred boundaries (atomic hold-ledger, timetables) that this module's lifecycle sits on top of
