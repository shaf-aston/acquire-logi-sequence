# Conversion

Pure transform from raw OCR markdown into the structured, computer-readable document/table types the rest of the pipeline consumes. No I/O, no config, no engine knowledge — OCR-provider agnostic.

## Key files
| File | Role |
|------|------|
| `document.builder.ts` | `buildStructuredDocument()` — maps each `OcrPage` into a `PageContent` by parsing its markdown for tables. |
| `markdown-table.parser.ts` | `parseMarkdownTables()` — parses GitHub-flavoured markdown tables into header/row grids; deterministic and independently testable. |
| `types.ts` | `StructuredDocument` / `PageContent` / `ExtractedTable` — the shape every later stage (classification, packing) reads. |

## How it fits
Called by `ingestion.service.ts` right after OCR, on the `OcrDocument` returned by whichever engine `ocr/extractor.factory.ts` selected. Its output, `StructuredDocument`, is the Stage 1 contract handed to Stage 2 classification (`classification/`) and to `ingestion/address-detector.ts`.

## Docs
- [`docs/architecture.md`](../../../docs/architecture.md) — pipeline diagram; `StructuredDocument` as the Stage 1 -> Stage 2 contract.
- [`docs/implementation-details.md`](../../../docs/implementation-details.md) — Stage 1 spec (input/output/approach/edge cases).
