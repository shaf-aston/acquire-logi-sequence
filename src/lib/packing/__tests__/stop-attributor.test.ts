import { describe, expect, it } from "vitest";
import { attributeStops, stopIndexFromRow } from "@/lib/packing/stop-attributor";
import { parseColumnMapFrom, resolveColumnIndices } from "@/lib/packing/column-map";
import type { StructuredDocument } from "@/lib/conversion/types";
import type { ClassificationResult } from "@/lib/classification/types";

// Minimal column map with a Stop column, mirroring config/column-map.json.
const COLUMN_MAP = parseColumnMapFrom({
  version: 3,
  inputUnit: "cm",
  decimalSeparator: ".",
  headerPatterns: {
    code: "description",
    description: "description",
    dimensionH: "height|^\\s*h\\b",
    dimensionL: "width|^\\s*w\\b",
    weight: "weight|\\bwt\\b",
    quantity: "quantity|\\bqty\\b",
    material: "material",
    pallets: "pallet",
    stop: "\\bstop\\b|\\bdrop\\b",
  },
  columns: { code: 1, description: 1, dimensionH: 5, dimensionL: 6, weight: 7, quantity: 4 },
  defaultCategory: "heavy-material",
  categoryPatterns: [],
});

// The real Groupage_Manifest_V2_MultiDrop layout: ONE cargo table, a Stop column,
// with bold section-header and sub-total rows interleaved between the cargo rows.
const HEADERS = ["Stop", "#", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"];
const cargo = (stop: string, num: string, desc: string) => [stop, num, desc, "Steel", "14 units", "30", "120", "672", "14.0"];
const banner = (text: string) => [text, "", "", "", "", "", "", "", ""];
const subtotal = (text: string) => [text, "", "", "", "", "", "", "**12,782**", "**91.0**"];

const ROWS: string[][] = [
  banner("**STOP 1 — Solstice Retail Ltd (Wiltshire, via SWI Hub)**"), // 0
  cargo("1", "1", "Pallet of Wine Glasses"), // 1
  cargo("1", "2", "Clothing Bale"), // 2
  subtotal("**Sub-total Stop 1**"), // 3
  banner("**STOP 2 — Midlands Wholesale Co.**"), // 4
  cargo("2", "3", "Stainless Steel Cookware Set"), // 5
  subtotal("**Sub-total Stop 2**"), // 6
  banner("**STOP 3 — Thames Valley Distributors**"), // 7
  cargo("3", "4", "Tempered Glass Shower Door"), // 8
  ["**GRAND TOTAL**", "", "", "", "", "", "", "**35,910**", "**266.0**"], // 9
];

function docWith(rows: string[][], headers = HEADERS): StructuredDocument {
  return {
    pageCount: 1,
    tableCount: 1,
    pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows }] }],
  };
}

/** Classify EVERY row as an item (worst case) — the attributor must skip non-cargo rows itself. */
function classifyAllRows(rows: string[][]): ClassificationResult {
  return {
    provider: "test",
    items: rows.map((_, rowIndex) => ({
      pageIndex: 0,
      tableIndex: 0,
      rowIndex,
      label: "x",
      fragility: "standard",
      confident: true,
      matchedTerm: null,
      reason: "",
    })),
    counts: { fragile: 0, standard: rows.length, lowConfidence: 0 },
  };
}

describe("stopIndexFromRow", () => {
  const cols = resolveColumnIndices(HEADERS, COLUMN_MAP);

  it("maps a 1-based Stop cell to a 0-based drop index", () => {
    expect(stopIndexFromRow(cargo("1", "1", "x"), cols)).toBe(0);
    expect(stopIndexFromRow(cargo("2", "1", "x"), cols)).toBe(1);
    expect(stopIndexFromRow(cargo("3", "1", "x"), cols)).toBe(2);
  });

  it("skips bold banner / sub-total / blank cells (not a bare integer)", () => {
    expect(stopIndexFromRow(banner("**STOP 1 — …**"), cols)).toBeUndefined();
    expect(stopIndexFromRow(subtotal("**Sub-total Stop 1**"), cols)).toBeUndefined();
    expect(stopIndexFromRow(["", "", ""], cols)).toBeUndefined();
  });

  it("returns undefined when the table has no Stop column", () => {
    const noStop = resolveColumnIndices(["#", "Item Description", "Height (cm)"], COLUMN_MAP);
    expect(noStop.stop).toBeUndefined();
    expect(stopIndexFromRow(["1", "x", "30"], noStop)).toBeUndefined();
  });
});

describe("attributeStops", () => {
  it("tags only real cargo rows, to their 0-based drop", () => {
    const map = attributeStops(docWith(ROWS), classifyAllRows(ROWS), COLUMN_MAP);
    // Cargo rows 1,2 → stop 1 (drop 0); row 5 → stop 2 (drop 1); row 8 → stop 3 (drop 2).
    expect(map).toEqual({
      "0-0-1": 0,
      "0-0-2": 0,
      "0-0-5": 1,
      "0-0-8": 2,
    });
    // Banner/sub-total/grand-total rows are never tagged.
    expect(map["0-0-0"]).toBeUndefined();
    expect(map["0-0-3"]).toBeUndefined();
    expect(map["0-0-9"]).toBeUndefined();
  });

  it("returns an empty map for a single-drop sheet (no Stop column)", () => {
    const headers = ["#", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)"];
    const rows = [["1", "Widget", "Steel", "5", "30", "40", "12"]];
    const map = attributeStops(docWith(rows, headers), classifyAllRows(rows), COLUMN_MAP);
    expect(map).toEqual({});
  });

  // Bug 0.6/0.7 defense-in-depth: `headerless` should already keep classification.items empty for
  // this table (isItemTable refuses it — table-selector.ts), but attributeStops must ALSO refuse to
  // resolve a Stop column by fixed position here rather than trust the caller blindly.
  it("never resolves a Stop column on a headerless table, even if classification wrongly points at one", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers: [], rows: [cargo("1", "1", "x")], headerless: true }] }],
    };
    const map = attributeStops(doc, classifyAllRows([cargo("1", "1", "x")]), COLUMN_MAP);
    expect(map).toEqual({});
  });
});
