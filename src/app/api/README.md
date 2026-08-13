# API Routes

Next.js route handlers — thin HTTP wrappers that validate the request shape and delegate to a service module in `src/lib/`; no business logic lives here (see the layering rule in `docs/architecture.md`).

## Key files
| Route folder | Methods | Purpose |
|---------------|---------|---------|
| `groupage/` | POST | Groupage (shared-truck) pallet quote — delegates to `getGroupageQuote` |
| `history/` | GET, DELETE | List / clear the saved quote history |
| `hubs/` | GET, POST, PUT, DELETE | CRUD over the groupage hub network (`FileHubRepository`), enforces disjoint-catchment invariant |
| `ingest/` | POST | Stage 1+2: PDF upload → OCR → item table + classification |
| `ingest-hubs/` | POST | Hub-sourcing tier 3: OCR a depot-list PDF into candidate hubs for operator confirmation (never writes the network directly) |
| `manifests/` | GET | Per-leg load view — active shipments grouped by leg vs. that leg's capacity |
| `map/` | GET | Stage 5 embed helper — builds a Google Maps embed URL (supports multi-stop waypoints) |
| `pack/` | POST | Stage 3: packs ingest output into a van/fleet via `packJob` |
| `pack/direct/` | POST | Stage 3 test harness: packs a pre-assembled `Item[]` directly, skipping ingest/classification |
| `places/` | GET | Address autocomplete, proxied to OpenStreetMap Nominatim |
| `quote/` | POST | Stage 5: routing + pricing quote (single-drop or multi-stop chain) |
| `shipments/` | GET, POST | List shipments; book a confirmed groupage quote into a lifecycle `Shipment` (server re-quotes, never trusts client-sent price) |
| `shipments/[id]/` | GET, PATCH | Read one shipment; apply a lifecycle action (state-machine-guarded) |
| `vans/` | GET, POST, PUT, DELETE | CRUD over the fleet van config (`FileVanRepository`) |

## How it fits
Called by `src/app/page.tsx` and the components in `src/components/` (each route name matches the component/feature that calls it, e.g. `GroupagePanel` -> `groupage/`, `VanConfigPanel` -> `vans/`). Every handler follows the same shape: parse/validate untrusted input at this boundary, call one service in `src/lib/`, map its typed error to a fail-loud HTTP status.

## Docs
- [`docs/api-reference.md`](../../../docs/api-reference.md) — request/response shapes (currently documents `ingest`, `pack`, `pack/direct`, `vans`, `quote`, `map` only — the groupage-mode and quote-history routes are not yet covered there)
