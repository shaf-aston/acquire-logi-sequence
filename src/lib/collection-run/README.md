# collection-run

Owns hub collection runs: planning the LTL pickup loop a van drives from a 3PL hub (the hub's
storage address) around nearby pickup addresses and back, plus turning an uploaded pickup-manifest
PDF into candidate addresses. It does NOT own hubs (see `groupage`'s `hub.repository`), the chain
engine (see `stop-chain` — this module is the "collection" configuration of it), or routing.

## Key files
| File | Role |
|------|------|
| `collection-run.service.ts` | `planCollectionRun` — hub gate (fail-loud without a storage address) → `[hub, pickups…]` + hub pinned as final destination → one van priced on the loop → pickups in visit order with advisory catchment verdicts |
| `pickup-list-extractor.ts` | Manifest PDF text → candidate pickup addresses behind a rule/groq seam (reuses `ADDRESS_EXTRACTOR_PROVIDER` + the address Groq key); candidates only, operator confirms |

## How it fits
`src/app/api/collection-run/quote` calls `planCollectionRun`; `…/collection-run/ingest` mirrors
`/api/ingest-hubs` (upload validation → OCR → candidates, never writes state). The stop-mix rule
lives in `stop-chain/validator.ts` (`collectionValidator`), wired by `createCollectionStopChain()`
in `stop-chain/index.ts`. UI: `src/components/collection-run/` (panel + mini-map), mounted as the
"Hub collection run" sidebar card. Knobs: `collectionRun.optimizeOrder` (env.ts, default true);
the pickup ceiling is the shared `multiStop.maxStops` (Google's 25-waypoint limit).
