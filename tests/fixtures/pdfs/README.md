# Synthetic quotation-PDF fixtures

Generated, deterministic test PDFs — **not** real-world ground truth (that lives in
[`docs/reference/`](../../../docs/reference/README.md)). Regenerate with:

```bash
npm run fixtures:gen        # scripts/generate-fixtures.mts (Playwright chromium page.pdf)
```

They are the input to the keyless end-to-end pipeline proof
([`tests/e2e/ingestion.e2e.test.ts`](../../e2e/ingestion.e2e.test.ts), run with
`npm run test:e2e`), which reads each one through the real OCR → parse → classify →
address path using the free local `tesseract` provider (no API key).

| File | Scenario it exercises |
|------|-----------------------|
| `06-col-cm.pdf` | Clean 6-column centimetre table, 5 items, varied materials/categories |
| `11-col-metre.pdf` | Clean 11-column metre table with explicit Quantity + Depth |
| `multi-page.pdf` | A 6-column table spanning 2 pages (header repeated on page 2) |
| `missing-dims.pdf` | Rows with blank Height/Width → must yield `dimensions:null`, rest valid |
| `mixed-units.pdf` | One cm table + one metre table in one doc → per-table unit detection |
| `quantity-variants.pdf` | Plain-int, decimal-with-floor, and zero-padded quantities |
| `addresses-collect-deliver.pdf` | A table plus labelled UK collection + delivery addresses |
| `groupage-multidrop.pdf` | One collection + three delivery postcodes |
| `junk-rows.pdf` | Totals row, blank row, and a SUBTOTAL banner mixed with real data |
| `rasterized-scan.pdf` | Image-only PDF (no text layer) → exercises the tesseract raster path |

**OCR tuning:** the e2e suite raises `TESSERACT_SCALE` / `TESSERACT_COL_GAP_FACTOR` above
their `.env.example` defaults for these fixtures' font metrics — this is the documented,
config-driven knob for table alignment, not a code change. Numeric assertions use a
tolerant ±15% band because tesseract introduces real OCR noise.
