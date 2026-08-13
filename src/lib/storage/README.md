# Storage

Object-storage swap-seam for Stage 1 (ingestion) persistence, plus a standalone quote-history log. Owns *where bytes land* (local disk vs Cloudflare R2) and the SigV4 request signing needed to talk to R2 — it does not own what gets archived or when (that's `ingestion.service.ts`'s call).

## Key files
| File | Role |
|------|------|
| `object-store.ts` | `ObjectStore` interface (put-only by design — no read-back path exists yet) + `NoopObjectStore` fallback |
| `local.store.ts` | `LocalObjectStore` — writes to `<baseDir>/<key>` on disk, zero-config default |
| `r2.store.ts` | `R2ObjectStore` — Cloudflare R2 via the S3 API; throws `StorageError` on a failed PUT |
| `sigv4.ts` | Stdlib-only AWS Signature V4 signer for single-shot S3 PutObject requests (no SDK dep) |
| `store.factory.ts` | `getObjectStore()` — resolves + caches the active backend from config (disabled → noop, R2 creds present → r2, otherwise → local; partial R2 config logs a warning and degrades to local) |
| `quote-history.store.ts` | `QuoteHistoryStore` — separate JSON-file append/list/clear log of generated quotes, keyed off `config.quoteHistory`. Does not implement `ObjectStore` — it's a second, unrelated persistence mechanism that happens to live in this folder. |

## How it fits
`ingestion.service.ts` (Stage 1) calls `getObjectStore()` to archive the source PDF and derived structured document by content-addressed (sha256) key, without knowing which backend is active. `quote-history.store.ts` is called at the end of Stage 5 (quoting) to persist a running history of priced quotes, independent of the object-store seam. All backends read their settings from `src/config/env.ts` — no other file touches `process.env`.

## Docs
- [`docs/architecture.md`](../../../docs/architecture.md) — Swap-seams section (interface/factory/switch table) and the cross-cutting module table listing `storage/`
