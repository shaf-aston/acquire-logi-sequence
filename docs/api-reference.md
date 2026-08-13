# API Reference

All endpoints live under `src/app/api/`. Routes are thin: they validate the
request shape, delegate to a `lib/` service, and shape the JSON response. Every
mutating route returns `{ success: boolean, requestId, error? }` plus its payload.
Response shapes are defined in [`src/types/api.ts`](../src/types/api.ts).

---

## POST `/api/ingest` — Stage 1 + 2

Upload a PDF; returns the extracted document and fragility classification.

- **Request:** `multipart/form-data` with a single field `file` (the PDF).
- **Response:** `IngestResponse` — `{ success, filename, provider, document: { pageCount, tableCount, pages }, classification, perf }`.
- **Errors:** `400` no file · `422` file validation failed · `502` OCR failed · `500` internal.

## POST `/api/pack` — Stage 3

Pack a classified document into the fleet.

- **Request (JSON):** `{ document: StructuredDocument, classification: ClassificationResult, vanId?: string }`. Omit `vanId` to auto-select/allocate a fleet.
- **Response:** `PackResponse` — `{ success, items, packableUnits, fleet, selected, ranking, fitsInSingleVan, unplaced, reasons, totalPerMileRate, perf }`.
- **Errors:** `400` malformed `document`/`classification`, invalid JSON, or `PackingError` · `500` internal.

## POST `/api/pack/direct` — Stage 3 (test harness)

Pack a raw `Item[]` directly, bypassing ingestion. Useful for unit/manual testing.

- **Request (JSON):** `{ items: Item[], vanId?: string }`.
- **Response:** same `PackResponse` shape as `/api/pack`.
- **Errors:** `400` empty `items`, unknown `vanId`, or invalid JSON.

## GET `/api/vans` — fleet config

Returns the configured van presets (source of truth for Stages 3 & 5).

- **Request:** none.
- **Response:** `{ vans: Van[] }` where `Van = { id, label, interior:{l,w,h}, maxPayloadKg, perMileRate }`.
- **Errors:** `500` van config could not be loaded.

## POST `/api/quote` — Stage 5

Price a job over a route for one or more vans.

- **Request (JSON):** `{ vanIds: string[], origin: string, destination: string, fragileCount?: number }`. `vanIds` repeats allowed (two of the same model); `fragileCount` defaults to `0`.
- **Response:** `QuoteResponse` — `{ success, quote: { route, vans, lineItems, subtotal, surcharges, total }, perf }`.
- **Errors:** `400` empty `vanIds` / missing `origin`/`destination` / bad `fragileCount` / `RoutingError` / `PricingError` / invalid JSON · `500` internal.

## POST `/api/quote/send` — Stage 5 (Send Quote)

Emails an already-generated quote to a recipient. Renders the email server-side from
the quote object the client already has — it does not re-price anything.

- **Request (JSON):** `{ to: string, quote?: Quote, groupageQuote?: GroupageQuote }` — exactly one of `quote`/`groupageQuote`.
- **Response:** `{ success: true }`.
- **Errors:** `400` invalid/missing `to`, missing or malformed quote, both quote fields set, or invalid JSON · `502` email provider rejected the send (includes unconfigured — see `EMAIL_SMTP_PASS` in `.env.example`) · `500` internal.

---

### Conventions

- `requestId` is generated per request (UUID) and echoed back for log correlation.
- API keys are read server-side via `config/env.ts`; none are exposed to the client.
- `perf` is a `PerfReport` of timed spans, included on success for observability.
