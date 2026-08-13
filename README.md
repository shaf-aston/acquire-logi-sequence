# Logistics Quoting Pipeline

An automated logistics quoting tool: upload a cargo PDF and get back a packed-van
plan and a priced delivery quote. Five stages run end to end —

1. **PDF ingestion** → computer-readable item table (OCR).
2. **Fragility classification** — each item tagged fragile / standard.
3. **3D load calculation** — does it fit, how, and in which van(s).
4. **3D visualization** — interactive render of the packed van.
5. **Route + pricing** — Google Maps distance × per-mile rate → quote.

Built with Next.js 15 (App Router), TypeScript, React Three Fiber, and Vitest.

## Quick start

```bash
npm install
cp .env.example .env      # then fill in API keys (see below)
npm run dev               # http://localhost:3000
```

Then in the UI: drop a PDF → review extracted items → pack into a van → enter
origin/destination → get a quote.

### Required environment

Set these in `.env` (see [`.env.example`](.env.example) for the full list):

- `GOOGLE_MAPS_API_KEY` — Routes API v2 + Maps Embed (Stage 5). Server-side only.
- OCR provider key — for PDF extraction (Stage 1).
- `FRAGILITY_SURCHARGE_PER_ITEM` — £ added per fragile item (default `5`).

Van presets and per-mile rates live in `config/vans.json` (source of truth for
Stages 3 & 5).

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm test` | Run the unit test suite (Vitest) |
| `npm run typecheck` | Type-check the whole project |
| `npm run lint` | Lint |
| `npm run ingest` | CLI: run ingestion against a PDF |

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — project constitution (vision + engineering rules).
- [`docs/README.md`](docs/README.md) — docs index.
- [`docs/architecture.md`](docs/architecture.md) — pipeline, layering, and where each stage lives in the code.
- [`docs/api-reference.md`](docs/api-reference.md) — all API endpoints.
- [`docs/ui-components.md`](docs/ui-components.md) — UI component guide.
- [`docs/testing-guide.md`](docs/testing-guide.md) — running and writing tests.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to add a feature.
