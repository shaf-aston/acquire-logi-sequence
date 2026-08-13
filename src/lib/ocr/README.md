# OCR

Engine-agnostic OCR swap-seam: turns raw PDF bytes into per-page markdown. Owns provider selection, content-hash caching, and the Tesseract-only image-to-table bridge. Does not parse markdown into structured tables (that's `conversion/`).

## Key files
| File | Role |
|------|------|
| `extractor.types.ts` | `PdfExtractor` interface + `OcrDocument`/`OcrInput` contract every engine implements. |
| `extractor.factory.ts` | Selects the engine from `OCR_PROVIDER` config and wraps it in the cache. |
| `mistral.extractor.ts` | Production engine — Mistral OCR API, retries transient errors, base64 data URI upload. |
| `tesseract.extractor.ts` | Free/local dev engine — rasterizes then OCRs each page with word boxes. |
| `pdf-rasterizer.ts` | Renders PDF pages to PNG via mupdf (WASM); only Tesseract needs this. |
| `tesseract-table.reconstructor.ts` | Clusters OCR word boxes into rows/columns and emits markdown tables so Tesseract output matches Mistral's shape. |
| `caching.extractor.ts` | Decorator: content-hash (sha256) cache wrapping any `PdfExtractor` so a repeat PDF is never re-billed. |

## How it fits
`ingestion.service.ts` calls `getExtractor()` and never names a concrete engine; the returned `OcrDocument` feeds `conversion/document.builder.ts`. This is the OCR engine swap-seam listed in the architecture doc, switched via `OCR_PROVIDER` (mistral | tesseract).

## Docs
- [`docs/architecture.md`](../../../docs/architecture.md) — swap-seam table (`PdfExtractor` / `extractor.factory.ts` / `OCR_PROVIDER`).
- [`docs/implementation-details.md`](../../../docs/implementation-details.md) — Stage 1 spec (input/output/approach/edge cases).
