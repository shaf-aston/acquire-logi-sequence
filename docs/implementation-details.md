# Implementation Details

This document collates the implementation notes for all five pipeline stages in one place.

## Stage 1 - PDF Ingestion

Turn an uploaded PDF into a `StructuredDocument` of machine-readable tables, with a visual "what you uploaded is what gets processed" check at the front.

### Input

A PDF upload: raw bytes + MIME type + filename. HTTP entry is `POST /api/ingest` (multipart, field `file`); the same path is callable headless via `src/cli/ingest.ts` (`npm run ingest`).

### Output

`StructuredDocument` - `{ pageCount, tableCount, pages[] }`, each page carrying its raw `markdown` (for preview/audit) and parsed `tables`. Wrapped by the service as `IngestionResult { filename, provider, document, classification, perf }`.

### Approach

Orchestrated by `src/lib/ingestion/ingestion.service.ts` as four timed steps:

1. Validate (`ingestion/file.validator.ts`) - trust-boundary guard: non-empty, <= `INGEST_MAX_FILE_BYTES`, MIME in `INGEST_ALLOWED_MIME`, and a `%PDF-` magic-byte sniff against spoofed MIME.
2. OCR (`ocr/` behind `PdfExtractor`) - the selected engine returns `OcrDocument`. `mistral.extractor.ts` (`POST /v1/ocr`, model `mistral-ocr-latest`) for production; `tesseract.extractor.ts` for dev. Engine chosen by `OCR_PROVIDER` via `extractor.factory.ts`. Transient failures retry (`util/retry.ts`).
3. Convert (`conversion/document.builder.ts` + `markdown-table.parser.ts`) - OCR markdown to `StructuredDocument`. The parser's job is narrow: markdown tables to grids.
4. Classify - hands off to Stage 2.

Visual upload + preview (`src/app/page.tsx`): the user drops a PDF, sees it rendered, and confirms before anything runs.

### Edge Cases

- Empty / oversized / non-PDF (spoofed MIME) -> `FileValidationError` -> HTTP 422.
- OCR fails after retries -> `OcrExtractionError` -> HTTP 502.
- Merged cells, multi-line descriptions, missing dimensions -> produce a flagged row, never a silent guess.
- Unexpected failure -> HTTP 500, logged with `requestId`.

### Definition of Done

User uploads a PDF through the UI, sees the rendered preview, confirms, and gets back an editable table of extracted rows.

## Stage 2 - Fragility Classification

Tag each extracted item `fragile` or `standard`, with an audit trail for why.

### Input

A `StructuredDocument` from Stage 1.

### Output

`ClassificationResult { provider, items: ClassifiedItem[], counts }`. Each `ClassifiedItem` carries its `pageIndex/tableIndex/rowIndex` position, the `label` used, the `fragility` verdict, `confident`, the `matchedTerm`, and a human-readable `reason`.

### Approach

Behind the `Classifier` interface, selected by `CLASSIFIER_PROVIDER` via `classifier.factory.ts`. Current engine: `rule-classifier.ts`.

1. Pick the item table (`table-selector.ts`) - among all parsed tables, choose the one whose headers match `itemTableHeaderKeywords` at least `minHeaderMatches` times.
2. Build each row's text from the columns named in `textColumnKeywords`.
3. Decide, in priority order:
   - Override - an exact `overrides[].phrase` match wins outright.
   - Keyword - first hit in `fragile.keywords` / `standard.keywords` sets the verdict and records `matchedTerm`.
   - Default - no match -> `defaultWhenUnmatched`, with `confident=false`.

The ruleset is editable config, not code: `config/fragility-rules.json` (path from `FRAGILITY_RULES_PATH`), loaded + validated by `ruleset.ts`.

### Edge Cases

- No table matches the header keywords -> empty `items`.
- Row matches both a fragile and standard keyword -> first match by scan order wins.
- Unmatched row -> defaulted + `confident=false` so the UI can prompt a manual override.
- Malformed `fragility-rules.json` -> `RulesetError` at load, fail loud.

### Future Work

- LLM second pass for rows the rules don't confidently match, behind the same `Classifier` interface.
- Manual override path writing `fragilitySource = override`.

### Definition of Done

The extracted table renders with each row tagged fragile/standard, low-confidence rows visibly flagged, and editing `config/fragility-rules.json` changes the result on the next run.

## Stage 3 - 3D Load / Space Calculation

Given the job's items and a van, decide whether and how they fit.

### Input

`Item[]` (dimensions + weight + quantity + `fragility` + stacking rules) and a `Van` (interior `l/w/h` + `maxPayloadKg`) from the fleet repository.

### Output

`PackingResult { van, placements: { itemId, position:{x,y,z}, size, rotation, fragile, weightKg, canSupportWeightKg }[], utilization, unplaced[], reasons }`.

### Module Map

```text
StructuredDocument + ClassificationResult
        |  item-assembler.ts  (+ column-map.ts, stackability.ts, weight-estimator.ts, geometry.ts)
        v
     Item[]
   van.repository.ts -> Van[]
        v
   packer.service.ts  (assemble -> rank fleet)
        |  heuristic-packer.ts  (3D first-fit-decreasing + fragility/support)
        v
   PackingResult (+ van ranking, fitsInSingleVan) -> app/api/pack/route.ts
```

### Approach

- Greedy heuristic: 3D first-fit-decreasing.
- Fragility as a constraint layer on top of pure geometry.
- Van ranking fallback: the service packs every configured van and ranks fits-first then tightest-pack.
- Config-driven knobs live in `src/config/env.ts`.

### Edge Cases

- A single item larger than the interior in every orientation -> `unplaced`.
- Total weight over `maxPayloadKg` though volume fits -> `unplaced`.
- Missing/merged dimensions -> `dimensions: null`, never guessed -> `unplaced`.
- Quantity > 1 -> expanded into N placements.
- Nothing fits any van -> ranked best-effort + `fitsInSingleVan = false`.

### Definition of Done

Against fixed sample `Item[]` and a configured `Van`, the engine returns a deterministic `PackingResult` with sane non-overlapping placements, correct `unplaced`, and verifiable `utilization`.

## Stage 4 - 3D Visualization

A pure rendering layer. Consumes `PackingResult` and draws it.

### Input

A `PackingResult` from Stage 3.

### Output

An interactive 3D view: the van as a wireframe/box, each item as a labelled box at its `position`/`rotation`, colour-coded by fragility.

### Approach

- Three.js.
- A dumb, swappable view: it only ever reads the `PackingResult` shape.
- Colour legend: fragile vs standard; highlight `unplaced` items separately.

### Edge Cases

- Empty `placements` -> render the empty van + a clear "nothing packed" state.
- `unplaced` non-empty -> show them distinctly.
- Degenerate dimensions (zero/negative) -> guard at the boundary; never crash the canvas.

### Definition of Done

Given a Stage 3 `PackingResult`, the viewer renders the van and every placed item in correct relative position, colour-coded by fragility, and the user can orbit/inspect it in the running UI.

## Stage 5 - Routing + Pricing

The end of the pipeline: trace the route and quote a final client price from the mileage rate.

### Input

Origin + destination for routing; the selected `Van` for the per-mile rate; and the job's `Item[]` for surcharges.

### Output

- A `Route { origin, destination, distance, duration }`, shown to the client.
- A `Quote { route, van, lineItems, subtotal, surcharges, total }` where `total = distance x van.perMileRate (+ fragility surcharges)`.

### Approach

- Routing behind a `RouteProvider` interface, with Google Maps Distance Matrix as the first implementation.
- API key via `src/config/env.ts` - never hardcoded, never shipped to the client.
- Pricing as its own pure module: `calculateQuote(route, van, items) -> Quote`.

### Edge Cases

- No route found / unroutable address -> surface a clear error, no quote.
- Maps API failure or quota -> fail loud; retry transient errors; never fabricate a distance.
- Zero fragile items -> surcharge is 0, not an error.
- Missing/zero `perMileRate` on the van -> reject with a config error.

### Definition of Done

A user uploads a PDF, the pipeline runs end-to-end, and the screen shows the traced route plus a final client price.
