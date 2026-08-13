# UI Components

React components under `src/components/`, grouped by role. The single page
`src/app/page.tsx` orchestrates state and the stage-by-stage flow; components are
presentational and receive typed props from `src/types/api.ts`. All styling comes
from tokens in `src/styles/tokens.ts` (see [code-rules.md](code-rules.md)).

## layout/
- **AppHeader** — top bar / branding. Static, no props.

## upload/
- **DropZone** — drag-and-drop / file-picker for the PDF. Emits the selected `File` upward; `page.tsx` POSTs it to `/api/ingest`.

## common/
- **FragilityBadge** — coloured pill rendering an item's `Fragility` (`fragile` = warning colour, `standard` = neutral). Reused anywhere an item's fragility is shown.

## results/
Rendered after each stage completes. All take their data as props; none fetch.

- **ResultTables** — Stage 1 output: extracted pages/tables as editable tables. Props: `pages: PageContent[]`, `classMap`.
- **ClassificationSummary** — Stage 2 roll-up: counts of fragile vs standard items.
- **PackingResultPanel** — Stage 3 result: selected van, placements list, utilization %, unplaced items + reasons, fleet/ranking. Props: `PackResponse` fields.
- **Van3DViewer** — Stage 4: react-three-fiber 3D render of the packed van — van as wireframe, items as boxes positioned at placement coords, coloured by fragility.
- **QuotePanel** — Stage 5: route summary, vehicles table, cost breakdown, total. Prop: `quote: Quote`.
- **PerfPanel** — collapsible per-stage timing (`PerfReport`) for dev/observability.

## Flow (in `page.tsx`)

1. **Upload** → `DropZone` → `POST /api/ingest` → `ResultTables` + `ClassificationSummary`.
2. **Pack** → `POST /api/pack` → `PackingResultPanel` + `Van3DViewer`.
3. **Quote** → origin/destination inputs → `POST /api/quote` → `QuotePanel`.

State (`origin`, `destination`, `quoteResult`, `packResult`, etc.) lives in `page.tsx`
and resets via its reset handler. Components stay stateless and reusable.
