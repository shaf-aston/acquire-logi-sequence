# Quotation PDF examples

Sample quotation / manifest PDFs used to exercise the ingestion → classification → quoting pipeline
end to end. All are single-page **image-only** PDFs (no text layer) — they go through the Mistral OCR
path, not text extraction.

## Run all of them at once

```
npm run scenarios              # every manifest below, against saved scans: free, offline, instant
npm run scenarios -- --live    # re-read them through the real OCR (costs a call per file)
npm run scenarios -- --only milk-run
npm run scenarios -- --detail large-multi-hub.pdf
```

`expectations.json` is what that sweep enforces, and it is **the authority on these files** — the
figures in the tables below are prose, written by hand, and several of them disagree with what the
manifests themselves state. Where they disagreed, the manifest's own arithmetic won: `multi-drop.pdf`
is listed below as ~6,340 kg, but its cargo table prints a `Weight/Unit` column against a `Qty`
column, and 12 kg × 90 + 8 × 15 + 22 × 35 + … comes to **9,576 kg**. Trust `expectations.json`, and
`--update` it deliberately when a manifest or a reading genuinely changes.

To run a single file through ingestion only:

```
npm run ingest -- ./docs/quotation-pdf-examples/<folder>/<sub-folder>/<file>.pdf
```

The tree is **two levels**: the top folder is the pipeline **mode**, the sub-folder is the **routing model**
within that mode. Figures below were read directly from each PDF.

## 01-point-to-point — dedicated FTL (one shipper, no hub/trunk)

Single-shipper truckload quotes. Not groupage.

### drops/ — plain collection → delivery, by number of drops
| File | Scenario | Key figures |
|------|----------|-------------|
| `single-drop.pdf` | 1 collection → 1 delivery | 4 cargo lines, ~2,510 kg |
| `multi-drop.pdf` | 1 collection → 4 deliveries | 8 lines, ~6,340 kg |
| `multi-drop-large.pdf` | 1 collection → 4 deliveries | 13 lines, ~6,450 kg |

### special-haul/ — non-standard hauls
| File | Scenario | Key figures |
|------|----------|-------------|
| `abnormal-indivisible-load.pdf` | Oversized indivisible (4.8 m turbine, crane + escort) | 2 collections, 5 lines, ~9,470 kg |
| `long-haul-domestic.pdf` | Long domestic haul, Folkestone → Glasgow | 2 collections + 2 deliveries, 9 lines, ~27,600 kg |

### inventory-classification-key/ — inventory sheet + Fragile/Standard key
Each shipper has two files: the `_full.pdf` (Part 1 inventory + Part 2 classification key) and the
`_inventory-only.pdf` (same document, key page removed) — a fixture for the parser seeing Part 1 alone.

| File | Scenario | Key figures |
|------|----------|-------------|
| `titan-industrial_full.pdf` | Industrial inventory + key | 20 rows, ~8,600 kg |
| `titan-industrial_inventory-only.pdf` | Same, key stripped | 20 rows |
| `northstar-industrial_full.pdf` | Second industrial inventory + key | 20 rows, ~6,800 kg |
| `northstar-industrial_inventory-only.pdf` | Same, key stripped | 20 rows |
| `apex-retail_full.pdf` | Retail/mixed goods + key | 20 rows, lighter mixed cargo |
| `apex-retail_inventory-only.pdf` | Same, key stripped | 20 rows |

## 02-groupage — shared-truck (collection run → hub / trunk)

Collection-run manifests: several companies' pallets pooled onto a shared vehicle. This is the mode the
capacity/pricing engine in `src/lib/groupage/` quotes. Sub-folders are the **routing model**.

### single-hub-no-trunk/ — collection run into one hub, same-day, no trunk leg
| File | Scenario | Key figures |
|------|----------|-------------|
| `one-company.pdf` | One company, 3 sites, single hub | 4 pallets, ~1,494 kg |
| `small-single-hub.pdf` | Same-day, one Leicester hub | 4 pallets, ~1,790 kg |

### hub-and-trunk/ — collection → hub → overnight trunk → delivery
| File | Scenario | Key figures |
|------|----------|-------------|
| `multi-company.pdf` | 4 companies, hub trunk | 12 pallets, ~7,700 kg |
| `multi-company-no-stops.pdf` | Multi-company run, point-to-point trunk | 3 companies, 9 pallets |
| `large-multi-hub.pdf` | 5 collections → 6 deliveries, overnight trunk | 20 pallets, ~50 t |

### intermediate-trunk-stops/ — pallets board / alight at mid-trunk stops
| File | Scenario | Key figures |
|------|----------|-------------|
| `stops-single-company.pdf` | One company, loads/leaves at intermediate stops | 3 pallet lines, 9 pallets |
| `high-volume-two-stops.pdf` | High-volume load across a two-stop trunk | 24 pallets, one 950 kg × 18 line |

### milk-run/ — sequenced multi-stop collection into a single trunk
| File | Scenario | Key figures |
|------|----------|-------------|
| `milk-run.pdf` | 6-stop sequenced collection → single hub trunk | 15 pallets, ~13,800 kg |
| `milk-run-large.pdf` | 8-stop collection, 18 t van → trunk | 21 pallets, ~95 t |

### capacity-edge-cases/ — loads that stress the capacity engine
| File | Scenario | Key figures |
|------|----------|-------------|
| `high-volume.pdf` | 4 companies, tens of tonnes | 45 pallets, ~85 t (10,000-unit line) |
| `oversized.pdf` | Over-height skids (2× pallet space each) | 3.5 pallet-equiv, ~1,680 kg |

`high-volume.pdf` is the manifest behind `src/lib/groupage/__tests__/high-volume.test.ts` (the measure-don't-gate
capacity work).

## 03-manifest-variants — same manifest, detailed vs simplified

Three manifests, each as its own sub-folder holding two flavours of the **same shipment totals** —
`detailed.pdf` (full dims + per-line weights + true piece counts) and `simplified.pdf` (stripped to small
round unit counts). Diffing a pair isolates the reader's tolerance for sparse manifests.

| Sub-folder | `detailed.pdf` | `simplified.pdf` |
|------------|----------------|------------------|
| `single-drop/` | Dims + per-line weights + piece counts. 266 pallets, 35,910 kg | Same totals; no dims/line-weights |
| `multi-drop/` | 3 delivery stops; 266 pallets (91/84/91), 35,910 kg | Same totals, reduced detail |
| `route-plan/` | 5-stop route plan; 2,565 kg | Same totals, reduced detail |

---

### Renamed from the previous layout (2026-07-09)

Started as 6 flat folders (`basic-quote/`, `simple/`, `organised-test-set-advanced/`, `quotes/`,
`many-units/`, `fewer-units/`), first consolidated into three flat mode folders, now split a second level
by routing model so no folder holds an undifferentiated pile. Two files had misleading names, corrected
along the way: old `quoteC_p2p_crossborder` is an entirely **domestic** haul (→ `long-haul-domestic`), and
old `quoteA_p2p_simple` is the hardest cargo in the set, an abnormal indivisible load
(→ `abnormal-indivisible-load`). The only in-repo path reference is the doc-comment in
`high-volume.test.ts`, kept in sync.
