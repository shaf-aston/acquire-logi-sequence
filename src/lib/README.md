# src/lib

All business logic — no HTTP, no React, no direct `process.env` access (that's `src/config/`). Each subfolder is one bounded concern with its own README; this file is just the map.

## Core pipeline (Stages 1–5)
| Folder | Owns |
|--------|------|
| [`ingestion/`](ingestion/README.md) | Stage 1 orchestrator: validates the upload, wires OCR → conversion → classification → address detection |
| [`ocr/`](ocr/README.md) | OCR engine swap-seam (Mistral / Tesseract) with content-hash caching |
| [`conversion/`](conversion/README.md) | Pure parser: OCR markdown → structured document/table types |
| [`classification/`](classification/README.md) | Stage 2 fragility + Stage 3 durability classification (rule engines + optional Groq) |
| [`packing/`](packing/README.md) | Stage 3: 3D van-loading engine, fleet allocation, config loaders |
| [`routing/`](routing/README.md) | Stage 5 swap-seam: Google Maps / straight-line / geocoder |
| [`pricing/`](pricing/README.md) | Stage 5: routed distance → line-itemized quote |

## Logistics modes (extend the core pipeline)
| Folder | Owns |
|--------|------|
| [`stop-chain/`](stop-chain/README.md) | One reusable multi-stop engine; delivery and collection are configurations of it |
| [`groupage/`](groupage/README.md) | Shared-truck (LTL) quoting: hub resolution, dual-capacity, rate-card pricing |
| [`groupage-ops/`](groupage-ops/README.md) | Booked-shipment lifecycle: state machine, manifests, persistence |

## Infrastructure
| Folder | Owns |
|--------|------|
| [`storage/`](storage/README.md) | Object-store swap-seam (local disk / Cloudflare R2) + quote-history log |
| `logger/` | Structured scoped logger (debug/info/warn/error + child bindings), pretty or JSON-lines output |
| `perf/` | `PerfTracker` — times named async spans per request, gated by `PERF_ENABLED` |
| `util/` | `withRetry()` — exponential-backoff helper for transient failures |
| `hooks/` | `useVanSession` — session-scoped, in-memory van fleet shared by the admin panels |

## Docs
- [`../../docs/architecture.md`](../../docs/architecture.md) — the five-stage pipeline, layering rule, and full swap-seam table
- [`../../docs/README.md`](../../docs/README.md) — full docs index
