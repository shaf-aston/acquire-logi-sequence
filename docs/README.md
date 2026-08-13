# Docs Index

The constitution is [`../CLAUDE.md`](../CLAUDE.md). These docs hold the detail it points at — one file per concern.

## Foundations (read first)
- [architecture.md](architecture.md) — the five-stage pipeline, layering, swap-seams, and where each stage lives in `src/`.

> Domain types used to have a dedicated `data-model.md`; that file no longer exists and its
> content was never consolidated elsewhere. Type shapes now live inline, next to the stage
> that owns them — see the shapes documented in `implementation-details.md`, `api-reference.md`,
> `admin-van-config.md` (the `Van` shape), and `stacking-item-data.md` (per-item fields).

## Pipeline stage specs
Each spec follows the same shape: **Input · Output · Approach · Edge cases · Definition of done.**

| Stage | Doc | Status |
|-------|-----|--------|
| 1 — PDF ingestion → table | [implementation-details.md](implementation-details.md) | Built |
| 2 — Fragility classification | [implementation-details.md](implementation-details.md) | Built |
| 3 — 3D load / space calculation | [implementation-details.md](implementation-details.md) · [packing-logic.md](packing-logic.md) (long-form, authoritative) · [stacking-item-data.md](stacking-item-data.md) (per-item durability/stacking data feeding the physics) | Built |
| 4 — 3D visualization | [implementation-details.md](implementation-details.md) | Planned |
| 5 — Routing + pricing | [implementation-details.md](implementation-details.md) · `fleet-allocation.md` (van choice + pricing — see Control surface below) | Built |

## Control surface
- [admin-van-config.md](admin-van-config.md) — van presets + per-mile rates (Stages 3 & 5 depend on it). Planned.
- [fleet-allocation.md](fleet-allocation.md) — how vans are chosen, how cargo is distributed, and how the return journey is priced.

## Design
- [code-rules.md](code-rules.md) — colour/spacing/font tokens and the design rules (this file now covers what used to be `design-system.md`).
- [ui-reference.md](ui-reference.md) — the Moverta visual aesthetic spec.
- [ui-components.md](ui-components.md) — React component catalogue.

## Logistics modes
- [logistic-modes/README.md](logistic-modes/README.md) — groupage (shared-truck) and multi-stop mode design: blueprint, implementation plan, cross-mode flows, and the stop-chain engine.

## Reference
- [api-reference.md](api-reference.md) — all API endpoints, request/response shapes.
- [testing-guide.md](testing-guide.md) — running and writing tests, plus the manual end-to-end script.

## Reference assets (non-authoritative)
- [reference/README.md](reference/README.md) — raw source material (sample quotation PDFs, a UI aesthetic screenshot) kept for inspiration/ground-truth comparison, not specs to follow blindly.

## Process
- [agents.md](agents.md) — the three sub-agents, their scope, and what they gate.
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — how to add a feature.
