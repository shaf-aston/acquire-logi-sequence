# Components

React UI for the quoting app, organized by role folder. `layout/`, `upload/`, `common/`, and `results/` are presentational (typed props in, no fetching); `admin/` and `groupage/` are self-contained feature panels that fetch/mutate their own data directly. This folder owns rendering only — no packing, pricing, or classification logic lives here.

## Key files
| Folder | Role |
|--------|------|
| `admin/` | Fleet & hub config screens — `FleetCostExplorer` (what-if fleet-cost sandbox, no live routing call), `VanConfigPanel` (CRUD over the fleet via `/api/vans`), `HubConfigPanel` (CRUD over the hub network via `/api/hubs`, plus PDF hub-import candidate review) |
| `common/` | Shared primitives reused across stages — `FragilityBadge` (fragile/standard/review pill) |
| `groupage/` | Groupage-mode panels — `GroupagePanel` (pallet quote + booking via `/api/groupage`), `ShipmentsBoard` (shipment lifecycle board over `/api/shipments` + `/api/manifests`) |
| `layout/` | App chrome — `AppHeader` (static top bar, no props) |
| `results/` | Stage 1–5 result renderers — `ResultTables`, `ClassificationSummary`, `PackingResultPanel`, `Van3DViewer`, `QuotePanel`, `PerfPanel`, `QuotationHistory`, `VanIcon` |
| `upload/` | Stage 1 input — `DropZone` (PDF drag-and-drop / file-picker) |
| `PlacesInput.tsx` | Debounced address-autocomplete input (calls `/api/places`); shared by origin/destination and hub forms |

## How it fits
All components are composed from a single `src/app/page.tsx`, which owns pipeline state (upload → pack → quote) and passes it down as props; `admin/` and `groupage/` panels manage their own state/fetches independently of that flow. Styling comes only from tokens in `src/styles/tokens.ts`.

## Docs
- [`docs/ui-components.md`](../../docs/ui-components.md) — component catalogue and props (currently covers `layout/`, `upload/`, `common/`, `results/` only — `admin/`, `groupage/`, `PlacesInput`, and `QuotationHistory` are not yet in that catalogue)
- [`docs/code-rules.md`](../../docs/code-rules.md) — design tokens / colour system (this file now holds what used to be `design-system.md`)
