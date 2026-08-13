1. **PDF ingestion** → computer-readable table
2. **Fragility classification** (fragile / non-fragile per item)
3. **3D load calculation** Van packing (does it fit, how, in which van)
4. **3D visualization** (show the packed van)
5. **Route + pricing** (Google Maps distance + van's per-mile rate → quote)


## ⚠️ CRITICAL PRINCIPLES (Non-Negotiable)
- **Never guess, always prove** — Every assumption tested before code
- **Never test until manual UI verification** — If not clicked through in running UI, it's not tested
- **Micro-steps execution** — Every micro-step is a small, verifiable unit
- **Every feature = a complete, verifiable milestone** — No accumulation; finish and check each one before the next
- **Documentation-first** — Docs written before feature code starts

---

## PHASE 0: Foundation Setup (Micro-steps 1–15)
### *Goal: Create the scaffolding all five stages will hang off. No feature code yet.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 1 | Create root repo structure: `/docs`, `/core-logic`, `/domain`, `/app` folders | Directory structure (empty folders OK) | |
| 2 | Write `CLAUDE.md` (≤200 lines, root of repo) — purpose, five-stage pipeline named, non-negotiable rules, sub-agent roles | `CLAUDE.md` | |
| 3 | Create `docs/OVERVIEW.md` — one-sentence description of each of the five stages and admin van config (6 sections total, no detail yet) | `docs/OVERVIEW.md` | |
| 4 | Write `docs/architecture.md` — system diagram in words: data flows between stages, what's a server action vs API route vs core logic | `docs/architecture.md` | |
| 5 | Write `docs/data-model.md` — lock down domain types: `Item`, `Quotation`, `Van`, `PackingResult`, `Route`, `Quote` with all fields + relationships | `docs/data-model.md` | |
| 6 | Create TypeScript type definitions for all domain types in `domain/types.ts` — exact match to data-model.md | `domain/types.ts` | |
| 7 | Write `docs/workflow-strategy.md` — the milestone flow: independent milestones, naming convention for work units, how work integrates | `docs/workflow-strategy.md` | |
| 8 | Write `docs/agents.md` — define four sub-agents: architect, security, design, + project lead + their scope | `docs/agents.md` | |
| 9 | Write `docs/claude-code-best-practices.md` — summarize Anthropic docs + best practices for Claude Code project setup | `docs/claude-code-best-practices.md` | |
| 10 | Write `docs/testing-workflow.md` — define "definition of done" for each micro-step: manual verification checklist | `docs/testing-workflow.md` | |
| 11 | Write `docs/admin-van-config.md` — van preset CRUD spec (create, read, update, delete a Van object) | `docs/admin-van-config.md` | |
| 12 | Write `docs/error-handling.md` — error states for all five stages + fallback behavior | `docs/error-handling.md` | |
| 13 | Create `.claude/agents/architect.md` — scope: data model reviews, module boundaries | `.claude/agents/architect.md` | |
| 14 | Create `.claude/agents/security.md` — scope: file upload, API key handling, admin config writes | `.claude/agents/security.md` | |
| 15 | Create `.claude/agents/design.md` — scope: admin UI consistency, 3D viewer look-and-feel | `.claude/agents/design.md` | |

**Milestone 1 Checkpoint**: All 15 micro-steps complete (one deliverable each). Manually open and read `CLAUDE.md` + `docs/OVERVIEW.md` + `domain/types.ts` in a text editor — verify they make sense and are self-consistent.

---

## PHASE 1: Admin Van Configuration (Micro-steps 16–28)
### *Goal: Build the control surface that Stages 3 & 5 depend on. Everything downstream needs real Van data to test against.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 16 | Set up database schema (or mock): `vans` table with fields from `Van` type — id, label, dimensions, max_weight, per_mile_rate | `schema.sql` or `db/schema.ts` | |
| 17 | Seed database with 3 default vans (small, medium, large) | `db/seeds.sql` or `db/seedData.ts` | |
| 18 | Write `core-logic/van-service.ts`: function signatures for `getVans()`, `createVan()`, `updateVan()`, `deleteVan()` (no implementation yet) | `core-logic/van-service.ts` (signatures only) | |
| 19 | Implement van-service.ts functions — read/write from DB | `core-logic/van-service.ts` (full) | |
| 20 | Write `app/api/vans/route.ts` — GET /api/vans (list), POST /api/vans (create), PUT, DELETE | `app/api/vans/route.ts` | |
| 21 | Write `app/admin/VanConfigPanel.tsx` — UI: table of vans, edit/delete buttons, add new van form | `app/admin/VanConfigPanel.tsx` | |
| 22 | **Manual UI test checkpoint**: Run dev server. Click "Add Van" → fill form → submit → verify new van appears in table. Edit a van → verify it updates. Delete a van → verify it's gone. | Test report in comments | |
| 23 | Write input validation for van creation (dimensions must be positive, rate > 0) | `app/api/vans/validation.ts` | |
| 24 | Add error states to VanConfigPanel (show toast/snackbar on API error) | `app/admin/VanConfigPanel.tsx` (updated) | |
| 25 | Write `docs/admin-van-config-impl.md` — implementation details, API contract, field constraints | `docs/admin-van-config-impl.md` | |
| 26 | Write unit tests for van-service.ts (getVans, createVan validation) | `core-logic/van-service.test.ts` | |
| 27 | **Manual test again**: Load the admin panel. Verify vans persist across page reload (check DB). | Test report | |
| 28 | Final review of all van-config work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 2 Checkpoint**: Admin can fully CRUD vans. Open dev server, manually perform all CRUD operations, verify data persists. Admin panel is the "source of truth" for van presets that Stages 3 & 5 will read from.

---

## PHASE 2: Stage 1 — PDF Ingestion & Table Extraction (Micro-steps 29–48)
### *Goal: User uploads PDF → system renders it → Mistral extracts → table appears in UI. Everything is manually verifiable at each sub-step.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 29 | Scaffold `core-logic/pdf-extraction/pdf-config.ts` — Mistral API credentials, endpoint URL, model name (`mistral-ocr-4-0`) | `core-logic/pdf-extraction/pdf-config.ts` | |
| 30 | Write `core-logic/pdf-extraction/mistral-extractor.ts` — function `extractFromPdf(file: File): Promise<RawExtraction>` (calls Mistral API) | `core-logic/pdf-extraction/mistral-extractor.ts` (skeleton) | |
| 31 | Implement mistral-extractor.ts — wire up Mistral OCR API call (use SDK or fetch), handle errors | `core-logic/pdf-extraction/mistral-extractor.ts` (full) | |
| 32 | Write `core-logic/pdf-extraction/table-parser.ts` — convert Mistral's raw JSON into `Item[]` | `core-logic/pdf-extraction/table-parser.ts` (skeleton) | |
| 33 | Implement table-parser.ts: parse column headers, map rows to Item (name, dimensions, weight, quantity, category) | `core-logic/pdf-extraction/table-parser.ts` (full) | |
| 34 | Write `app/api/extraction/route.ts` — POST /api/extraction/upload (receives PDF file, calls mistral-extractor, returns Item[]) | `app/api/extraction/route.ts` | |
| 35 | Build `app/viewer/PdfPreview.tsx` — displays uploaded PDF in an iframe or PDF.js viewer (read-only, "what you see is what gets processed") | `app/viewer/PdfPreview.tsx` | |
| 36 | Build `app/viewer/ItemTable.tsx` — displays Item[] as an editable table (name, L/W/H, weight, qty, category columns) | `app/viewer/ItemTable.tsx` | |
| 37 | Build `app/viewer/UploadFlow.tsx` — step 1: file input, step 2: show PDF preview + "Confirm Upload" button, step 3: parse & show table | `app/viewer/UploadFlow.tsx` | |
| 38 | **Manual UI test checkpoint**: Upload a real PDF. Verify preview renders. Click "Confirm" → Mistral API fires → table appears with extracted items. Can you see item names, dimensions, weights in the table? | Test report | |
| 39 | Add error handling to UploadFlow: invalid file type, Mistral API error, parsing error → show user-friendly messages | `app/viewer/UploadFlow.tsx` (updated) | |
| 40 | Write `docs/stage1-implementation.md` — input/output specs, Mistral API contract, edge cases (merged cells, missing dimensions) | `docs/stage1-implementation.md` | |
| 41 | Add "manual correction" UI to ItemTable — user can edit any cell (name, dimensions, etc.) before moving to Stage 2 | `app/viewer/ItemTable.tsx` (updated) | |
| 42 | Implement edit-save for ItemTable (patches individual Item fields, updates in-memory state) | `app/viewer/ItemTable.tsx` (updated) | |
| 43 | **Manual UI test again**: Upload PDF → confirm → extract → manually edit one item's name in the table → verify it persists in the UI state. | Test report | |
| 44 | Add "Save Quotation" button to UploadFlow → calls POST /api/quotations (persists Item[] to DB as a Quotation record) | `app/api/quotations/route.ts` | |
| 45 | Write Quotation schema: id, created_at, items (JSON), raw_pdf_url or path, status (extracted / classified / packed / quoted) | `schema.sql` or `db/schema.ts` (updated) | |
| 46 | **Manual UI test once more**: Upload → extract → edit → save quotation → reload page → quotation is still there (fetched from DB). | Test report | |
| 47 | Write unit tests for mistral-extractor.ts and table-parser.ts (mock Mistral API, test parsing edge cases) | `core-logic/pdf-extraction/*.test.ts` | |
| 48 | Final review of all Stage 1 work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 3 Checkpoint**: PDF upload flow is end-to-end: user picks file → preview → extract → table → edit → save. Every step manually verified in running UI. Mistral API actually called and working.

---

## PHASE 3: Stage 2 — Fragility Classification (Micro-steps 49–62)
### *Goal: Each Item gets tagged fragile/non-fragile with reason (rule / model / override). Admin can override.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 49 | Write `core-logic/classification/fragility-rules.ts` — keyword lookup table (e.g. { "glass": true, "mirror": true, "book": false, ... }) | `core-logic/classification/fragility-rules.ts` | |
| 50 | Write `core-logic/classification/classifier.ts` — function `classifyItem(item: Item): { fragile: boolean, reason: string }` — uses rules | `core-logic/classification/classifier.ts` | |
| 51 | Implement classifier.ts: match item category/name against fragility-rules, return fragile + reason | `core-logic/classification/classifier.ts` (full) | |
| 52 | Extend `Item` type to include fragile: boolean, classificationReason: "rule" \| "model" \| "override", confidence?: number | `domain/types.ts` (updated) | |
| 53 | Write `app/api/classification/route.ts` — POST /api/classification (takes Item[], returns Item[] with fragile flags + reasons) | `app/api/classification/route.ts` | |
| 54 | Build `app/viewer/FragilityClassifier.tsx` — shows Item[] with fragile flag (colored badge), source (rule/model/override), allow edit | `app/viewer/FragilityClassifier.tsx` | |
| 55 | Add "Click to override fragile flag" UI in FragilityClassifier — user can flip the flag, note reason changes to "override" | `app/viewer/FragilityClassifier.tsx` (updated) | |
| 56 | **Manual UI test checkpoint**: Load classified items from Stage 1. Verify items tagged fragile/non-fragile with reason. Click override → verify flag flips, reason shows "override". | Test report | |
| 57 | Update UploadFlow to chain Stage 1 → Stage 2: after save quotation, button "Classify Fragility" fires API → FragilityClassifier appears | `app/viewer/UploadFlow.tsx` (updated) | |
| 58 | Write `docs/stage2-implementation.md` — fragility rule set, how overrides are stored, LLM classifier option for future | `docs/stage2-implementation.md` | |
| 59 | Add audit trail: store classification reason + timestamp in Item (who overrode, when) | `domain/types.ts` (updated) | |
| 60 | Write unit tests for classifier.ts (various keyword matches, edge cases) | `core-logic/classification/*.test.ts` | |
| 61 | Update Quotation schema to include items' fragility data (status moves to "classified") | `schema.sql` (updated) | |
| 62 | Final review of all Stage 2 work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 4 Checkpoint**: Fragility classification is end-to-end: extracted items → rules applied → override UI works. Quotation status updated to "classified". Next stage (packing) will read these flags.

---

## PHASE 4: Stage 3 — 3D Load Calculation & Packing (Micro-steps 63–80)
### *Goal: Given Item[] (with dimensions/weight), Van, determine if/how it fits. Fragility is a placement constraint.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 63 | Write `core-logic/packing/packing-types.ts` — `PackedItem` type (item, x/y/z position, rotation, reason) | `core-logic/packing/packing-types.ts` | |
| 64 | Write `core-logic/packing/bin-packing.ts` — function signature `packItems(items: Item[], van: Van): PackingResult` | `core-logic/packing/bin-packing.ts` (skeleton) | |
| 65 | Implement bin-packing.ts: 3D first-fit-decreasing algorithm (sort by volume descending, place each item, check constraints) | `core-logic/packing/bin-packing.ts` (full) | |
| 66 | Add fragility constraints to packing: fragile items can't have heavy non-fragile stacked on top, fragile placed on top or last | `core-logic/packing/bin-packing.ts` (updated) | |
| 67 | Add van-candidate ranking: if items don't fit in selected van, algorithm suggests alternate vans from admin config | `core-logic/packing/bin-packing.ts` (updated) | |
| 68 | Extend PackingResult type: selectedVan, packedItems[], utilization%, unpackedItems (if any), alternateVans[] with reason | `domain/types.ts` (updated) | |
| 69 | Write `app/api/packing/route.ts` — POST /api/packing (takes quotationId + selectedVanId, returns PackingResult) | `app/api/packing/route.ts` | |
| 70 | **Manual test checkpoint (non-UI)**: Call packing API directly with sample data. Verify items are placed, utilization calculated, fragile constraints respected. | Test report | |
| 71 | Build `app/viewer/VanSelector.tsx` — dropdown of available vans (fetched from admin config), "Select Van" button | `app/viewer/VanSelector.tsx` | |
| 72 | Build `app/viewer/PackingResults.tsx` — shows PackingResult: selected van, packed items list, utilization %, warnings if any items didn't fit | `app/viewer/PackingResults.tsx` | |
| 73 | Update UploadFlow: after classification, show VanSelector → button "Pack" → calls packing API → PackingResults appears | `app/viewer/UploadFlow.tsx` (updated) | |
| 74 | **Manual UI test checkpoint**: Upload PDF → classify → select van → pack → see results (items listed with positions, utilization %). | Test report | |
| 75 | Add "recalculate with alternate van" UI: if items didn't fit, show alternate van suggestions, click to repack | `app/viewer/PackingResults.tsx` (updated) | |
| 76 | Write `docs/stage3-implementation.md` — packing algorithm details, fragility constraints, utilization calculation | `docs/stage3-implementation.md` | |
| 77 | Update Quotation schema: add packedItems JSON, selectedVanId, utilization%, status → "packed" | `schema.sql` (updated) | |
| 78 | Write unit tests for bin-packing.ts (sample items/vans, verify placement, check fragility constraint logic) | `core-logic/packing/*.test.ts` | |
| 79 | Add error handling to packing API: invalid quotation, van not found, packing fails → show error to user | `app/viewer/PackingResults.tsx` (updated) | |
| 80 | Final review of all Stage 3 work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 5 Checkpoint**: Packing is end-to-end: select van → pack items → see placement results + utilization. Fragility constraints enforced. Alternative vans suggested if needed. Quotation status = "packed".

---

## PHASE 5: Stage 4 — 3D Visualization (Micro-steps 81–92)
### *Goal: Render the PackingResult (van + placed items) in 3D using Three.js.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 81 | Write `app/viewer/Viewer3D.tsx` — Three.js scene setup: camera, lights, renderer | `app/viewer/Viewer3D.tsx` (skeleton) | |
| 82 | Implement Viewer3D: render van as wireframe box (dimensions from PackingResult.selectedVan) | `app/viewer/Viewer3D.tsx` (updated) | |
| 83 | Implement Viewer3D: render each packed item as a box (dimensions from PackingResult.packedItems[].item.dimensions) positioned at x/y/z | `app/viewer/Viewer3D.tsx` (updated) | |
| 84 | Add color coding: fragile items = red, non-fragile = blue (visual distinction) | `app/viewer/Viewer3D.tsx` (updated) | |
| 85 | Add item labels: hover over an item → show name, dimensions, weight, fragile status in a tooltip | `app/viewer/Viewer3D.tsx` (updated) | |
| 86 | Add camera controls: mouse drag to rotate, scroll to zoom, auto-fit to show entire van | `app/viewer/Viewer3D.tsx` (updated) | |
| 87 | **Manual UI test checkpoint**: Open PackingResults → 3D visualization loads. Rotate/zoom. Hover over items → see labels. Fragile items are red. | Test report | |
| 88 | Update UploadFlow: after packing, show Viewer3D below PackingResults | `app/viewer/UploadFlow.tsx` (updated) | |
| 89 | Write `docs/stage4-implementation.md` — Three.js setup, color scheme, interaction design | `docs/stage4-implementation.md` | |
| 90 | Add "Screenshot" button to Viewer3D: user can export current view as PNG (for quoting/documentation) | `app/viewer/Viewer3D.tsx` (updated) | |
| 91 | Write unit tests for Viewer3D (mock Three.js, verify scene structure) | `app/viewer/*.test.ts` | |
| 92 | Final review of all Stage 4 work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 6 Checkpoint**: 3D visualization renders packed van with items. Interactive (rotate/zoom). Color-coded by fragility. Can be exported as image. Quotation status ready for final stage.

---

## PHASE 6: Stage 5 — Google Maps Routing & Price Quoting (Micro-steps 93–110)
### *Goal: Trace route (origin → destination) and calculate final price (distance × van rate + surcharges).*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 93 | Write `core-logic/routing/route-types.ts` — `Route` type (origin, destination, distance, duration, route_polyline) | `core-logic/routing/route-types.ts` | |
| 94 | Write `core-logic/routing/google-maps-provider.ts` — function `getRoute(origin: string, destination: string): Promise<Route>` (calls Google Maps API) | `core-logic/routing/google-maps-provider.ts` (skeleton) | |
| 95 | Implement google-maps-provider.ts: wire up Google Maps Directions API, extract distance + duration + polyline | `core-logic/routing/google-maps-provider.ts` (full) | |
| 96 | Write `core-logic/pricing/quote-calculator.ts` — function `calculateQuote(route: Route, van: Van, items: Item[]): Quote` | `core-logic/pricing/quote-calculator.ts` (skeleton) | |
| 97 | Implement quote-calculator.ts: base price = distance × van.per_mile_rate, add fragility surcharge per fragile item (configurable amount), total | `core-logic/pricing/quote-calculator.ts` (full) | |
| 98 | Extend `Quote` type: route, van, items[], baseCost, fragilitySurcharge, totalCost, breakdown (itemized) | `domain/types.ts` (updated) | |
| 99 | Write `app/api/routing/route.ts` — POST /api/routing (takes origin + destination, returns Route) | `app/api/routing/route.ts` | |
| 100 | Write `app/api/quoting/route.ts` — POST /api/quoting (takes quotationId + origin + destination, returns Quote) | `app/api/quoting/route.ts` | |
| 101 | Build `app/viewer/RoutingForm.tsx` — input fields for origin address + destination address, "Calculate Route" button | `app/viewer/RoutingForm.tsx` | |
| 102 | Build `app/viewer/QuoteDisplay.tsx` — shows Quote: van, route (distance/duration), item list, cost breakdown, total price | `app/viewer/QuoteDisplay.tsx` | |
| 103 | Update UploadFlow: after 3D visualization, show RoutingForm → button "Get Quote" → calls quoting API → QuoteDisplay appears | `app/viewer/UploadFlow.tsx` (updated) | |
| 104 | **Manual UI test checkpoint**: Go through full flow: upload → classify → pack → visualize → enter addresses → get quote. Final screen shows route + price breakdown. | Test report | |
| 105 | Add Google Maps embedded route map to QuoteDisplay (show traced route on map with distance/time info) | `app/viewer/QuoteDisplay.tsx` (updated) | |
| 106 | Write `docs/stage5-implementation.md` — Google Maps API contract, pricing logic, fragility surcharge calculation | `docs/stage5-implementation.md` | |
| 107 | Update Quotation schema: add route JSON, quote JSON, status → "quoted" (final) | `schema.sql` (updated) | |
| 108 | Write unit tests for google-maps-provider.ts and quote-calculator.ts (mock Google Maps, test price math) | `core-logic/routing/*.test.ts` | |
| 109 | Add "Send Quote to Client" button to QuoteDisplay (generates PDF or email link with quote details) | `app/viewer/QuoteDisplay.tsx` (updated) | |
| 110 | Final review of all Stage 5 work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 7 Checkpoint**: Full end-to-end pipeline: PDF upload → extract → classify → pack → visualize → route → quote. User sees final price + route map. Quotation status = "quoted".

---

## PHASE 7: Integration & End-to-End Testing (Micro-steps 111–125)
### *Goal: All five stages work together. Real data through entire pipeline. Manual verification of every step.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 111 | Write `docs/end-to-end-test-plan.md` — step-by-step manual test script (upload PDF → quote) with expected outcomes for each step | `docs/end-to-end-test-plan.md` | |
| 112 | Create 2-3 sample PDFs in `/test-data/pdfs/` with known items (furniture, fragile items, etc.) for reproducible testing | `/test-data/pdfs/*.pdf` | |
| 113 | **Full end-to-end manual test #1**: Use test PDF #1, go through entire flow, document results + screenshots at each stage | Test report + screenshots | |
| 114 | Review UploadFlow for UX gaps: is it clear what step user is on? Are buttons labeled correctly? Errors obvious? | UX audit report | |
| 115 | Refine UploadFlow UI based on audit (add step indicators, clearer button labels, better error messages) | `app/viewer/UploadFlow.tsx` (updated) | |
| 116 | **Full end-to-end manual test #2**: Use test PDF #2, verify refined UX, all steps still work | Test report | |
| 117 | Implement quotation history: user can see list of past quotations, click to re-open and view/re-calculate | `app/admin/QuotationHistory.tsx` | |
| 118 | Add "reset flow" button: user can start over with new PDF without losing previous quotations | `app/viewer/UploadFlow.tsx` (updated) | |
| 119 | Write integration tests: call 5 APIs in sequence (extract → classify → pack → route → quote), verify data flows correctly | `integration-tests/*.test.ts` | |
| 120 | **Full end-to-end manual test #3**: Test all edge cases (very large items, many fragile items, items don't fit, alternate vans, API errors) | Test report (edge cases) | |
| 121 | Write `docs/known-limitations.md` — what works, what doesn't, what needs future work | `docs/known-limitations.md` | |
| 122 | Write `docs/deployment.md` — how to deploy to production (env vars, DB setup, API keys) | `docs/deployment.md` | |
| 123 | Add monitoring/logging: all API calls logged, errors tracked | `app/api/*/logging.ts` or middleware | |
| 124 | Review all code for security (file upload validation, API auth, SQL injection, XSS) | Security audit report | |
| 125 | Final review of all integration work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 8 Checkpoint**: Complete pipeline verified manually with real data. All edge cases tested. Quotations can be viewed/managed. Ready for production.

---

## PHASE 8: Polish & Documentation (Micro-steps 126–138)
### *Goal: Code is clean, documented, and team-ready.*

| # | Micro-step | Deliverable | ✅ |
|---|---|---|---|
| 126 | Write `docs/code-overview.md` — guide to codebase structure, where to find each stage's code | `docs/code-overview.md` | |
| 127 | Add JSDoc comments to all public functions in `core-logic/` and `domain/types.ts` | Updated files with comments | |
| 128 | Write `docs/api-reference.md` — all API endpoints, request/response schemas | `docs/api-reference.md` | |
| 129 | Write `docs/ui-components.md` — description of main UI components, how to use them | `docs/ui-components.md` | |
| 130 | Create `CONTRIBUTING.md` (root level) — how to add a feature, coding rules, review process | `CONTRIBUTING.md` | |
| 131 | Review and update `README.md` — quick start guide, feature overview, how to run locally | `README.md` (comprehensive) | |
| 132 | Write `docs/testing-guide.md` — how to run unit tests, integration tests, manual testing procedure | `docs/testing-guide.md` | |
| 133 | Verify all docs are consistent with actual code (no outdated specs) | Audit report | |
| 134 | Add TODO comments in code for future optimizations (not blockers, but noted) | Code comments | |
| 135 | Run full test suite, verify coverage > 70% for core-logic, > 50% for UI | Test report with coverage | |
| 136 | **Final manual end-to-end test**: One more complete flow through the entire system, all systems operational | Final test report | |
| 137 | Create release notes summarizing what was built | `RELEASE_NOTES.md` | |
| 138 | Final review of all polish work: re-run checks, confirm every deliverable is complete and verified. | Phase complete, all checks pass | |

**Milestone 9 Checkpoint**: Codebase is well-documented, tested, and ready for handoff or team collaboration.

---

## PROJECT STRUCTURE (Final State)

```
root/
├── CLAUDE.md (≤200 lines, constitution)
├── README.md (quick start + overview)
├── CONTRIBUTING.md (how to contribute)
├── RELEASE_NOTES.md
├── package.json
├── tsconfig.json
├── .env.example
│
├── docs/
│   ├── OVERVIEW.md
│   ├── architecture.md
│   ├── data-model.md
│   ├── workflow-strategy.md
│   ├── agents.md
│   ├── claude-code-best-practices.md
│   ├── testing-workflow.md
│   ├── error-handling.md
│   ├── admin-van-config.md
│   ├── stage1-implementation.md
│   ├── stage2-implementation.md
│   ├── stage3-implementation.md
│   ├── stage4-implementation.md
│   ├── stage5-implementation.md
│   ├── end-to-end-test-plan.md
│   ├── known-limitations.md
│   ├── deployment.md
│   ├── code-overview.md
│   ├── api-reference.md
│   ├── ui-components.md
│   ├── testing-guide.md
│
├── .claude/
│   ├── agents/
│   │   ├── architect.md
│   │   ├── security.md
│   │   ├── design.md
│
├── domain/
│   ├── types.ts (all data types)
│
├── core-logic/
│   ├── pdf-extraction/
│   │   ├── pdf-config.ts
│   │   ├── mistral-extractor.ts
│   │   ├── table-parser.ts
│   │   └── *.test.ts
│   ├── classification/
│   │   ├── fragility-rules.ts
│   │   ├── classifier.ts
│   │   └── *.test.ts
│   ├── packing/
│   │   ├── packing-types.ts
│   │   ├── bin-packing.ts
│   │   └── *.test.ts
│   ├── routing/
│   │   ├── route-types.ts
│   │   ├── google-maps-provider.ts
│   │   └── *.test.ts
│   ├── pricing/
│   │   ├── quote-calculator.ts
│   │   └── *.test.ts
│   └── van-service.ts (+ *.test.ts)
│
├── app/
│   ├── api/
│   │   ├── vans/route.ts + validation.ts
│   │   ├── extraction/route.ts
│   │   ├── classification/route.ts
│   │   ├── packing/route.ts
│   │   ├── routing/route.ts
│   │   ├── quoting/route.ts
│   │   └── quotations/route.ts
│   ├── admin/
│   │   ├── VanConfigPanel.tsx
│   │   └── QuotationHistory.tsx
│   └── viewer/
│       ├── UploadFlow.tsx (main orchestrator)
│       ├── PdfPreview.tsx
│       ├── ItemTable.tsx
│       ├── FragilityClassifier.tsx
│       ├── VanSelector.tsx
│       ├── PackingResults.tsx
│       ├── Viewer3D.tsx
│       ├── RoutingForm.tsx
│       └── QuoteDisplay.tsx
│
├── db/
│   ├── schema.sql (or schema.ts)
│   └── seedData.ts
│
├── test-data/
│   └── pdfs/
│       ├── sample-1.pdf
│       ├── sample-2.pdf
│       └── sample-3.pdf
│
└── integration-tests/
    └── *.test.ts

```

---

## ✅ COMPLETION CHECKLIST

Use this to verify the entire plan is satisfied:

### Foundation (Phase 0)
- [ ] CLAUDE.md exists, ≤200 lines, clearly states rules + five stages + sub-agent roles
- [ ] All docs in `/docs` exist and are consistent with code
- [ ] Domain types in `domain/types.ts` match `docs/data-model.md`
- [ ] `.claude/agents/` sub-agent configs exist

### Admin Van Config (Phase 1)
- [ ] Van CRUD UI fully functional
- [ ] Vans persist in database
- [ ] Vans are source of truth for Stages 3 & 5

### Stage 1 (Phase 2)
- [ ] PDF upload UI with preview
- [ ] Mistral API integration working
- [ ] Item[] extracted and displayed in table
- [ ] Manual edits to items possible
- [ ] Quotation saved to database

### Stage 2 (Phase 3)
- [ ] Fragility classification rules applied
- [ ] Fragile/non-fragile flags visible in UI
- [ ] Admin can override classifications
- [ ] Reason tracked (rule / model / override)

### Stage 3 (Phase 4)
- [ ] Van selection UI works
- [ ] Items packed into 3D space
- [ ] Fragility constraints enforced in packing
- [ ] Alternate vans suggested if needed
- [ ] Utilization % calculated

### Stage 4 (Phase 5)
- [ ] 3D scene renders van + items
- [ ] Items color-coded by fragility
- [ ] Interactive controls (rotate, zoom)
- [ ] Item labels on hover
- [ ] Screenshot export works

### Stage 5 (Phase 6)
- [ ] Origin + destination input fields
- [ ] Google Maps API called, distance returned
- [ ] Price calculated: distance × van rate + surcharges
- [ ] Cost breakdown visible
- [ ] Route map displayed

### End-to-End (Phase 7)
- [ ] Full pipeline manual test completed (PDF → Quote)
- [ ] Edge cases tested (large items, no fit, many fragile)
- [ ] Quotation history accessible
- [ ] All 5 API calls chain together correctly

### Polish (Phase 8)
- [ ] All code has JSDoc comments
- [ ] All endpoints documented in `docs/api-reference.md`
- [ ] All UI components documented
- [ ] Test coverage > 70% for core-logic
- [ ] README + CONTRIBUTING guide complete
- [ ] Security audit passed

### Milestones
- [ ] Every micro-step is a complete, testable unit of work (138 total)
- [ ] Every major feature is finished and verified as its own milestone
- [ ] All milestones cleanly integrated into the working system

---

## 🚩 WHAT WAS MISSING FROM THE FOUNDATIONAL PLAN

The second document was comprehensive but had gaps:

1. **Manual UI Testing Workflow** — Emphasized in transcript but not explicitly detailed. Added micro-steps for "manual UI test checkpoint" at each phase.

2. **Claude Code Best Practices Study** — Mentioned in transcript but not in document 2. Added as Phase 0 step 9.

3. **Workflow & Milestone Strategy** — Mentioned but vague. Added Phase 0 step 7 (research + docs).

4. **Sub-agent Configuration** — Document 2 names agents but doesn't show how to set them up in `.claude/agents/`. Added Phase 0 steps 13–15.

5. **Error Handling & Fallbacks** — Only partially covered. Added Phase 0 step 12 (comprehensive error docs).

6. **Manual Correction UI for Extracted Items** — Not explicit in document 2. Added Phase 2 steps 41–42.

7. **Quotation History & Management** — Missing entirely. Added Phase 7 steps 117–118.

8. **Integration Testing Between Stages** — Not mentioned. Added Phase 7 step 119.

9. **"Definition of Done" Clarity** — Document 2 mentions it but doesn't define it per milestone. Added Phase 0 step 10 (testing-workflow.md).

10. **Deployment & Security Audit** — Missing from document 2. Added Phase 7 steps 122–124 and Phase 8 step 124.

11. **Code Comments & Documentation Standards** — Not detailed. Added Phase 8 steps 127–134.

12. **Release Notes & Handoff** — Missing. Added Phase 8 step 137.

---

## 📋 HOW TO USE THIS DOCUMENT

1. **Print or reference** this plan at the start of each day.
2. **Check off micro-steps** as they're completed (update the ✅ column).
3. **At each milestone checkpoint**, manually verify the system works as described.
4. **Label each deliverable** with its micro-step number, e.g. "Micro-step #27: add error states to van config".
5. **If you get stuck** on a step, re-read the phase description and the adjacent micro-steps for context.
6. **Save and back up your work** at every milestone checkpoint, at minimum.

---

## 🎯 FINAL OUTCOME

When complete, you will have:

✅ A **fully functional PDF → Van Packing → Route → Quote system**
✅ **138 micro-steps**, each a small, testable unit of work
✅ **9 major feature milestones**, each fully integrated into the system
✅ **Comprehensive documentation** covering architecture, implementation, testing, and deployment
✅ **Sub-agent structure** ready for collaborative Claude Code work
✅ **Manual test coverage** at every step — nothing is "done" until clicked through in the UI
✅ **Production-ready codebase** with tests, error handling, and security review

