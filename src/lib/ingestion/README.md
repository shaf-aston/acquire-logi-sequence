# Ingestion

Stage 1 orchestrator: validates an uploaded PDF at the trust boundary, then wires OCR -> conversion -> classification -> address detection into one result. Does not itself do OCR, table parsing, or classification — it only calls out to `ocr/`, `conversion/`, and `classification/`.

## Key files
| File | Role |
|------|------|
| `ingestion.service.ts` | `ingestPdf()` — the Stage 1 pipeline: validate, OCR, convert, classify, detect addresses, archive artifacts (best-effort), timed via `PerfTracker`. |
| `file.validator.ts` | Trust-boundary guard: size limit, MIME allow-list, PDF magic-byte sniff. Config-driven via `getConfig().ingest`. |
| `address-detector.ts` | Pure scan of a `StructuredDocument` for pickup/drop address lines (label + UK postcode match) — feeds multi-stop form prefill. Fail-soft, never throws. |

## How it fits
Called from the ingestion API route (`src/app/api/ingest/`) with raw upload bytes; internally calls `getExtractor()` (OCR), `buildStructuredDocument()` (conversion), and `getClassifier()` (classification). This is the Stage 1 orchestration layer described in the architecture doc's layering rule — HTTP-free and callable from a CLI too.

## Docs
- [`docs/architecture.md`](../../../docs/architecture.md) — pipeline stages, layering, and swap-seam table.
- [`docs/implementation-details.md`](../../../docs/implementation-details.md) — Stage 1 input/output/approach/edge cases spec.
