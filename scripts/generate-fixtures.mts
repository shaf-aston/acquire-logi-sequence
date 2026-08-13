/**
 * Synthetic-PDF fixture generator for the ingestion e2e suite.
 *
 * Renders plain HTML quotation tables to text-layer PDFs via Playwright's
 * Chromium (page.pdf()) so the fixtures are deterministic and reproducible
 * without depending on any real customer document.
 *
 * Tuned for Tesseract legibility based on EMPIRICAL testing against the real
 * OCR → table-reconstruction pipeline (see tests/fixtures/pdfs/README.md):
 *  - No vertical/full-grid borders. A full bordered grid (the "obvious"
 *    reading of a quotation table) gets partially OCR'd as literal "|" glyphs
 *    by Tesseract and destroys table reconstruction entirely — proven by
 *    direct testing, not assumed. Ruled tables (border-bottom only) OCR
 *    cleanly instead, so that is what these fixtures use.
 *  - A multi-word title/heading placed directly above a table gets swallowed
 *    into the table's own header row by the reconstructor (both satisfy the
 *    ">= minColumns words per row" rule with nothing to break the segment).
 *    Every fixture therefore uses a single-token banner (`divider()`) as its
 *    heading, never a multi-word `<h1>`.
 *  - Column headers whose unit suffix must line up with the data below them
 *    ("Height (cm)", "Unit Weight (kg)", …) are written WITHOUT the internal
 *    space ("Height(cm)", "UnitWeight(kg)") — the OCR reconstructor buckets
 *    columns per rendered word, and a numeric data cell (one token) only
 *    lines up with a header's FIRST word-bucket. `column-map.json`'s regexes
 *    match by substring, so this is a no-op for the real parser contract.
 *  - Item descriptions are deliberately short, category-keyword pairs
 *    ("Steel Beam", "Glass Panel", …) where EITHER word alone is an
 *    unambiguous `categoryPatterns` match — this makes classification robust
 *    even on the rare row where the two words land in different OCR column
 *    buckets (word-length-dependent OCR drift, observed directly).
 *
 * Run: `npm run fixtures:gen`
 */
import { chromium, type Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "tests", "fixtures", "pdfs");

// ─────────────────────────────────────────────────────────────────────────
// Shared page shell + table renderer
// ─────────────────────────────────────────────────────────────────────────

const STYLE = `
  @page { size: A4; margin: 16mm 12mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 18px;
    color: #000;
    background: #fff;
  }
  .divider { font-size: 18px; font-weight: 700; letter-spacing: 2px; margin: 0 0 6mm 0; }
  .addr { font-size: 18px; margin: 3mm 0; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 6mm; }
  th, td { padding: 10px 16px; text-align: left; white-space: nowrap; border-bottom: 1px solid #666; }
  th { font-size: 20px; font-weight: 700; border-bottom: 2px solid #000; }
  td { font-size: 18px; font-weight: 400; }
  .page-break { break-before: page; }
`;

const STYLE_LANDSCAPE = STYLE.replace("@page { size: A4;", "@page { size: A4 landscape;");

function shell(bodyHtml: string, landscape = false): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>${landscape ? STYLE_LANDSCAPE : STYLE}</style></head>
<body>${bodyHtml}</body>
</html>`;
}

/** Renders one <table> given a header row and body rows (each a plain string array). */
function table(headers: string[], rows: string[][]): string {
  const th = headers.map((h) => `<th>${h}</th>`).join("");
  const trs = rows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n");
  return `<table><thead><tr>${th}</tr></thead><tbody>\n${trs}\n</tbody></table>`;
}

/** A single-token banner — keeps titles/section breaks from being swallowed into
 *  the adjacent table's OCR segment (see file header comment). */
function divider(word: string): string {
  return `<div class="divider">${word}</div>`;
}

function addressLine(label: string, text: string): string {
  return `<div class="addr"><b>${label}:</b> ${text}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Column headers (regex-matched by config/column-map.json; unit suffixes are
// written without an internal space — see file header comment)
// ─────────────────────────────────────────────────────────────────────────

const HEADERS_6COL_CM = ["Item #", "Item Description", "Material", "Height(cm)", "Width(cm)", "Weight(kg)"];

const HEADERS_11COL_M = [
  "#",
  "Item Description",
  "Category",
  "Material",
  "Height(m)",
  "Width(m)",
  "Depth(m)",
  "UnitWeight(kg)",
  "Quantity",
  "Line Volume",
  "Line Weight",
];

// ─────────────────────────────────────────────────────────────────────────
// Fixture definitions
// ─────────────────────────────────────────────────────────────────────────

interface Fixture {
  readonly name: string;
  readonly html: string;
}

const fixtures: Fixture[] = [];

// 1. 06-col-cm.pdf — clean 6-col cm table, 5 items, varied materials/categories.
fixtures.push({
  name: "06-col-cm",
  html: shell(
    divider("QUOTATION") +
      table(HEADERS_6COL_CM, [
        ["1", "Steel Beam", "Steel", "25", "300", "200"],
        ["2", "Glass Panel", "Glass", "150", "100", "90"],
        ["3", "PVC Conduit", "PVC", "10", "200", "8"],
        ["4", "Aluminum Channel", "Aluminum", "15", "250", "45"],
        ["5", "TV Monitor", "Plastic", "60", "90", "8"],
      ]),
  ),
});

// 2. 11-col-metre.pdf — clean 11-col metre table, 5 items, explicit Quantity + Depth.
fixtures.push({
  name: "11-col-metre",
  html: shell(
    divider("QUOTATION") +
      table(HEADERS_11COL_M, [
        ["1", "Steel Beam", "Racking", "Steel", "2.0", "0.9", "0.6", "25", "4", "4.32", "100"],
        ["2", "Glass Panel", "Glazing", "Glass", "1.9", "0.8", "0.1", "22", "2", "0.30", "44"],
        ["3", "PVC Conduit", "Electrical", "PVC", "0.3", "1.5", "0.3", "6", "10", "1.35", "60"],
        ["4", "Aluminum Channel", "Access Equip", "Aluminum", "2.5", "0.5", "0.1", "12", "3", "0.38", "36"],
        ["5", "TV Monitor", "Electronics", "Steel", "0.4", "0.3", "0.3", "3", "6", "0.22", "18"],
      ]),
    true,
  ),
});

// 3. multi-page.pdf — 6-col table spanning 2 pages, header repeated on page 2.
fixtures.push({
  name: "multi-page",
  html: shell(
    divider("PAGEONE") +
      table(HEADERS_6COL_CM, [
        ["1", "Steel Beam", "Steel", "25", "300", "200"],
        ["2", "Glass Panel", "Glass", "150", "100", "90"],
        ["3", "PVC Conduit", "PVC", "10", "200", "8"],
      ]) +
      `<div class="page-break"></div>` +
      divider("PAGETWO") +
      table(HEADERS_6COL_CM, [
        ["4", "Aluminum Channel", "Aluminum", "15", "250", "45"],
        ["5", "TV Monitor", "Plastic", "60", "90", "8"],
        ["6", "Steel Pillar", "Steel", "30", "400", "260"],
      ]),
  ),
});

// 4. missing-dims.pdf — rows 2 and 4 omit a dimension → dimensions:null for those, valid for the rest.
fixtures.push({
  name: "missing-dims",
  html: shell(
    divider("QUOTATION") +
      table(HEADERS_6COL_CM, [
        ["1", "Steel Beam", "Steel", "20", "300", "180"],
        ["2", "Glass Panel", "Glass", "150", "", "50"],
        ["3", "PVC Conduit", "PVC", "10", "200", "9"],
        ["4", "Aluminum Channel", "Aluminum", "", "250", "40"],
        ["5", "TV Monitor", "Plastic", "60", "90", "10"],
      ]),
  ),
});

// 5. mixed-units.pdf — one cm table + one metre table on the same page, to prove
// per-table unit detection. A single-token divider forces the reconstructor to
// end the first table's segment before the second table begins.
fixtures.push({
  name: "mixed-units",
  html: shell(
    divider("CENTIMETRES") +
      table(HEADERS_6COL_CM, [
        ["1", "Steel Beam", "Steel", "20", "300", "150"],
        ["2", "Glass Panel", "Glass", "100", "80", "60"],
      ]) +
      divider("METRES") +
      table(HEADERS_11COL_M, [
        ["1", "Aluminum Channel", "Access Equip", "Aluminum", "1.0", "0.5", "0.2", "20", "2", "0.20", "40"],
        ["2", "PVC Conduit", "Electrical", "PVC", "0.2", "1.0", "0.2", "5", "5", "0.20", "25"],
      ]),
    true,
  ),
});

// 6. quantity-variants.pdf — 11-col table exercising the quantity forms parseNumeric
// actually accepts (plain int, decimal-with-floor, zero-padded) per item-assembler.ts.
fixtures.push({
  name: "quantity-variants",
  html: shell(
    divider("QUOTATION") +
      table(HEADERS_11COL_M, [
        ["1", "Steel Beam", "Racking", "Steel", "2.0", "0.9", "0.6", "25", "5", "5.40", "125"],
        ["2", "Glass Panel", "Glazing", "Glass", "1.9", "0.8", "0.1", "22", "3.0", "0.46", "66"],
        ["3", "Aluminum Channel", "Access Equip", "Aluminum", "2.5", "0.5", "0.1", "12", "08", "1.00", "96"],
      ]),
    true,
  ),
});

// 7. addresses-collect-deliver.pdf — 6-col table plus labelled UK collection + delivery
// addresses. Single-word dividers isolate the address lines from the item table so the
// OCR reconstructor doesn't swallow them into the table segment.
fixtures.push({
  name: "addresses-collect-deliver",
  html: shell(
    divider("ITEMS") +
      table(HEADERS_6COL_CM, [
        ["1", "Steel Beam", "Steel", "20", "300", "150"],
        ["2", "Glass Panel", "Glass", "100", "80", "60"],
        ["3", "TV Monitor", "Plastic", "60", "90", "8"],
      ]) +
      divider("ADDRESSES") +
      addressLine("Collection Address", "12 Foundry Road, Birmingham, B33 8TH") +
      addressLine("Delivery Address", "45 Deansgate, Manchester, M1 1AE"),
  ),
});

// 8. groupage-multidrop.pdf — one collection + 3 delivery postcodes (multi-drop reading).
fixtures.push({
  name: "groupage-multidrop",
  html: shell(
    divider("ADDRESSES") +
      addressLine("Collection Address", "8 Trinity Street, Coventry, CV1 1AA") +
      addressLine("Delivery Address 1", "20 Market Street, Manchester, M1 1AE") +
      addressLine("Delivery Address 2", "5 Boar Lane, Leeds, LS1 4DY") +
      addressLine("Delivery Address 3", "12 Foundry Road, Birmingham, B33 8TH") +
      divider("ITEMS") +
      table(HEADERS_6COL_CM, [
        ["1", "Steel Beam", "Steel", "20", "300", "150"],
        ["2", "PVC Conduit", "PVC", "10", "200", "9"],
      ]),
  ),
});

// 9. junk-rows.pdf — 5 valid rows + an embedded totals/footer row (phantom item,
// dimensions:null expected) + a blank row (invisible to OCR) + a single-token
// "SUBTOTAL" banner (excluded from the table entirely) — proves junk tolerance.
fixtures.push({
  name: "junk-rows",
  html: shell(
    divider("QUOTATION") +
      table(HEADERS_6COL_CM, [
        ["1", "Steel Beam", "Steel", "25", "300", "200"],
        ["2", "Glass Panel", "Glass", "150", "100", "90"],
        ["3", "PVC Conduit", "PVC", "10", "200", "8"],
        ["4", "Aluminum Channel", "Aluminum", "15", "250", "45"],
        ["5", "TV Monitor", "Plastic", "60", "90", "8"],
        ["", "Total Weight", "", "", "", "253"],
        ["", "", "", "", "", ""],
      ]) +
      divider("SUBTOTAL"),
  ),
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 10 (optional) — rasterized (image-only, no text layer) version of
// scenario 1, produced by screenshotting the HTML table to PNG and embedding
// it in a bare PDF (no <text>, so Chromium's print path draws it as an image
// XObject, not selectable text).
// ─────────────────────────────────────────────────────────────────────────

async function generateRasterizedScan(browser: Browser): Promise<void> {
  const source = fixtures.find((f) => f.name === "06-col-cm");
  if (!source) throw new Error("06-col-cm fixture must exist before rasterizing it");

  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  try {
    await page.setContent(source.html);
    const png = (await page.screenshot({ fullPage: true })).toString("base64");
    const wrapper = shell(`<img src="data:image/png;base64,${png}" style="width:100%;" />`);
    await page.setContent(wrapper);
    await page.pdf({
      path: join(OUT_DIR, "rasterized-scan.pdf"),
      printBackground: true,
      preferCSSPageSize: true,
    });
    console.log("  rasterized-scan.pdf (image-only, no text layer)");
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const fixture of fixtures) {
      const page = await browser.newPage();
      try {
        await page.setContent(fixture.html);
        const outPath = join(OUT_DIR, `${fixture.name}.pdf`);
        await page.pdf({ path: outPath, printBackground: true, preferCSSPageSize: true });
        console.log(`  ${fixture.name}.pdf`);
      } finally {
        await page.close();
      }
    }

    try {
      await generateRasterizedScan(browser);
    } catch (err) {
      console.warn(`  SKIPPED rasterized-scan.pdf: ${String(err)}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`\nGenerated ${fixtures.length + 1} fixture(s) → ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
