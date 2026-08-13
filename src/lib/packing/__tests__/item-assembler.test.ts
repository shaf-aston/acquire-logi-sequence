/** S3.4 — item-assembly bridge: classified rows + table columns → Item[]. */
import { describe, it, expect, beforeAll } from "vitest";
import { assembleItems, skippedCargoTables } from "@/lib/packing/item-assembler";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { parseColumnMapFrom } from "@/lib/packing/column-map";
import { parseStackabilityFrom } from "@/lib/packing/stackability";
import { readConfigJson } from "./fixtures";
import type { Item } from "@/lib/packing/packing.types";
import type { StructuredDocument } from "@/lib/conversion/types";
import type { ClassificationResult } from "@/lib/classification/types";

const matrix = parseStackabilityFrom(readConfigJson("config/stackability.json"));

// The shipped, header-driven column map must map BOTH real layouts. This guards the
// regression where repointing fixed indices for one sheet broke the other.
describe("assembleItems — shipped config resolves both layouts by header", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const oneRow = (headers: string[], row: string[]): { doc: StructuredDocument; cls: ClassificationResult } => ({
    doc: { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows: [row] }] }] },
    cls: { provider: "rule", counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "x", fragility: "standard", confident: true, matchedTerm: null, reason: "" }] },
  });

  it("6-column cm sheet (INDUSTRIAL): Height/Width by header, depth derived, cm→m", async () => {
    const { doc, cls } = oneRow(
      ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"],
      ["1", "Industrial Steel I-Beam", "Steel", "50", "1200", "850"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.dimensions!.h).toBeCloseTo(0.5, 6); // 50 cm
    expect(items[0]!.dimensions!.l).toBeCloseTo(12, 6); // 1200 cm (Width→l)
    expect(items[0]!.weightKg).toBe(850);
    expect(items[0]!.quantity).toBe(1); // no quantity column
  });

  // Both the full ("Height (m)") and abbreviated ("H (m)") SPLIT header variants
  // exist in real OCR output — both must resolve identically.
  for (const [variant, dimHeaders, wtHeader] of [
    ["full", ["Height (m)", "Width (m)", "Depth (m)"], "Unit Weight (kg)"],
    ["abbreviated", ["H (m)", "W (m)", "D (m)"], "Unit Wt (kg)"],
  ] as const) {
    it(`11-column m sheet (SPLIT, ${variant} headers): H/W/D + weight + quantity, dot decimals`, async () => {
      const { doc, cls } = oneRow(
        ["#", "Item Description", "Category", "Material", ...dimHeaders, wtHeader, "Quantity", "Line Volume (m³)", variant === "full" ? "Line Weight (kg)" : "Line Wt (kg)"],
        ["1", "Sun Lounger Pair (boxed)", "Garden", "Plastic", "1.03", "0.97", "1.05", "79.89", "14", "14.69", "1118.5"],
      );
      const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
      expect(items).toHaveLength(1);
      expect(items[0]!.dimensions!.h).toBeCloseTo(1.03, 6); // dot is decimal, not thousands (was 103)
      expect(items[0]!.dimensions!.l).toBeCloseTo(0.97, 6); // Width→l
      expect(items[0]!.dimensions!.w).toBeCloseTo(1.05, 6); // Depth→w (read, not derived)
      expect(items[0]!.weightKg).toBeCloseTo(79.89, 2); // Unit Weight, not Line Weight (idx wins by first match)
      expect(items[0]!.quantity).toBe(14);
      // Real placement: a correctly-sized item must fit a large van (proves it's no longer a 103 m phantom).
      const packed = new HeuristicPacker({ toleranceM: 0.005 }).pack(
        [{ ...items[0]!, quantity: 1 }],
        { id: "big", label: "Big", interior: { l: 6, w: 2.4, h: 2.4 }, maxPayloadKg: 5000, perMileRate: 2 },
      );
      expect(packed.placements).toHaveLength(1);
    });
  }
});

// Regression (the "4 rows read but not loaded, 0/0 placed" bug): a manifest whose
// dimension columns are headed L / W / D (Length·Width·Depth) — not Height·Width — must
// load. The shipped headerPatterns knew Height/Width/Depth but had no word for
// "Length"/"L", so the required dimensionH slot found no column, isDimensionedTable
// returned false, and the WHOLE cargo table was dropped as a non-cargo summary. It must
// now both produce Items AND not be reported by skippedCargoTables.
describe("assembleItems — shipped config loads an L/W/D (Length·Width·Depth) manifest", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const HEADERS = ["Stop", "Item / Material", "L (cm)", "W (cm)", "D (cm)", "Weight/Unit", "Qty"];
  const build = (rows: string[][]) => ({
    doc: { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers: HEADERS, rows }] }] } as StructuredDocument,
    cls: { provider: "rule" as const, counts: { fragile: 0, standard: rows.length, lowConfidence: 0 },
      items: rows.map((_, rowIndex) => ({ pageIndex: 0, tableIndex: 0, rowIndex, label: "x", fragility: "standard" as const, confident: true, matchedTerm: null, reason: "" })) } as ClassificationResult,
  });

  it("builds a fully-dimensioned Item from L/W/D columns (all three axes captured, cm→m)", async () => {
    const { doc, cls } = build([["1", "Steel Crate", "120", "80", "100", "60", "1"]]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    const dims = items[0]!.dimensions;
    expect(dims).not.toBeNull(); // was null (whole table dropped) before the fix
    // All three source dimensions are captured (volume is correct regardless of which
    // axis each maps to): 120·80·100 cm → 1.2·0.8·1.0 m in some order.
    expect([dims!.l, dims!.w, dims!.h].sort((a, b) => a - b)).toEqual([0.8, 1.0, 1.2]);
    expect(items[0]!.stopIndex).toBe(0); // Stop column still attributes the drop
  });

  it("does NOT report the L/W/D table as a skipped non-cargo table", () => {
    const { doc, cls } = build([["1", "Steel Crate", "120", "80", "100", "60", "1"]]);
    expect(skippedCargoTables(doc, cls, shipped)).toEqual([]);
  });
});

// A quotation sheet occasionally states a value's unit in the cell itself ("120cm")
// rather than (or in addition to) the column header — e.g. a mixed-unit manifest, or
// a header that lost its "(cm)" suffix in OCR. That per-cell marker is an explicit
// statement from the source, not a guess, so it must override the column-level unit
// for that one value instead of being silently discarded.
describe("assembleItems — per-cell unit suffix overrides the column unit", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const oneRow = (headers: string[], row: string[]): { doc: StructuredDocument; cls: ClassificationResult } => ({
    doc: { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows: [row] }] }] },
    cls: { provider: "rule", counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "x", fragility: "standard", confident: true, matchedTerm: null, reason: "" }] },
  });

  it("a metres-header column with a cm-suffixed cell value uses the cell's unit, not the header's", async () => {
    const { doc, cls } = oneRow(
      ["Item #", "Item Description", "Material", "Height (m)", "Width (m)", "Depth (m)", "Weight (kg)"],
      ["1", "Mixed-Unit Crate", "Wood", "0.5", "150cm", "0.4", "20"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.dimensions!.h).toBeCloseTo(0.5, 6); // plain "0.5" → column unit (m), unchanged
    expect(items[0]!.dimensions!.l).toBeCloseTo(1.5, 6); // "150cm" → 1.5 m, NOT 150 m
  });

  it("a value with a space before the unit ('1.2 m') and a mm-suffixed value both parse correctly", async () => {
    const { doc, cls } = oneRow(
      ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"],
      ["1", "Precision Part", "Steel", "1.2 m", "300mm", "5"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.dimensions!.h).toBeCloseTo(1.2, 6); // "1.2 m" → 1.2 m, not 1.2 cm
    expect(items[0]!.dimensions!.l).toBeCloseTo(0.3, 6); // "300mm" → 0.3 m, not 300 cm
  });
});

// A groupage manifest quotes the PALLET, not the descriptive piece count. Each line
// carries both "N pallets" and a piece count ("14,000 units"); the load unit is the
// pallet. Regression guard for the "18,081 placeable blocks" cap explosion — the
// parser used to read the piece column and blow the packer's block cap.
describe("assembleItems — pallet manifest (Pallets column drives quantity)", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const oneRow = (headers: string[], row: string[], fragility: "standard" | "fragile" = "standard") => ({
    doc: { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows: [row] }] }] } as StructuredDocument,
    cls: { provider: "rule" as const, counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "x", fragility, confident: true, matchedTerm: null, reason: "" }] } as ClassificationResult,
  });

  it("dimensioned manifest: quantity = pallet count, weight = line ÷ pallets, footprint from config", async () => {
    // Layout: Stop# | Description | Material | Quantity | Height(cm) | Width(cm) | Weight(kg) | Pallets
    const { doc, cls } = oneRow(
      ["Stop #", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"],
      ["1", "Ceramic Floor Tile Pallet", "Ceramic", "14000", "12", "120", "6720", "14"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(14); // 14 pallets — NOT 14,000 pieces
    expect(items[0]!.dimensions!.h).toBeCloseTo(0.12, 6); // 12 cm sheet height
    expect(items[0]!.dimensions!.l).toBeCloseTo(1.2, 6); // 120 cm sheet width → length axis
    expect(items[0]!.dimensions!.w).toBeCloseTo(1.0, 6); // footprint depth from palletDefaults
    expect(items[0]!.weightKg).toBeCloseTo(480, 6); // 6720 line ÷ 14 pallets
    // "Ceramic" matches heavy-material (non-zero) — a real category match wins,
    // the dedicated pallet ruleset is not substituted.
    expect(items[0]!.category).toBe("heavy-material");
    expect(items[0]!.canSupportWeightKg).toBe(2000);
  });

  it("dimensionless manifest: full standard pallet + config default weight (no fabricated size)", async () => {
    // The EDITED file layout: Item | Description | Material | Qty | Pallets — no size columns.
    const { doc, cls } = oneRow(
      ["Item", "Description", "Material", "Qty", "Pallets"],
      ["1", "Assorted Hardware", "Steel", "9000", "20"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(20);
    // Standard UK pallet from config — never volume × solid density (which fabricates a multi-tonne pallet).
    expect(items[0]!.dimensions).toEqual({ l: 1.2, w: 1.0, h: 1.2 });
    expect(items[0]!.weightKg).toBe(400); // palletDefaults.defaultWeightKg (no Weight column)
    // No pattern match ⇒ defaultCategory "heavy-material" (non-zero) — unaffected.
    expect(items[0]!.category).toBe("heavy-material");
    expect(items[0]!.canSupportWeightKg).toBe(2000);
  });

  it("a pallet line whose description matches a fragile-CONTENTS category still lets the pallet itself be stacked", async () => {
    // "Pallet of Wine Glasses" matches the glass-panel pattern (fragile
    // CONTENTS), which normally hard-vetoes stacking (canSupportWeightKg: 0) —
    // correct for a single glass panel, wrong for a wooden pallet as a physical
    // unit. Regression guard for the "13 identical half-empty 7.5t trucks" bug:
    // a zero-cap category on a pallet line must fall through to the dedicated
    // `pallet` ruleset instead of silently forcing single-layer-only packing.
    const { doc, cls } = oneRow(
      ["Stop #", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"],
      ["1", "Pallet of Wine Glasses (200 pcs)", "Glass", "200", "120", "100", "800", "5"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.category).toBe("glass-panel"); // label still reports the real contents match
    expect(items[0]!.canSupportWeightKg).toBe(500); // pallet ruleset, NOT the glass-panel category's 0
  });

  it("a normal dimensioned order with NO Pallets column is unaffected (packs per piece)", async () => {
    const { doc, cls } = oneRow(
      ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)", "Quantity"],
      ["1", "Steel Bracket", "Steel", "20", "30", "5", "40"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.quantity).toBe(40); // the Quantity column, per-piece — not palletised
    expect(items[0]!.dimensions!.h).toBeCloseTo(0.2, 6);
  });
});

// Shipped schema: | Item # | Item Description | Material | Height (cm) | Width (cm) | Weight (kg) |
const doc: StructuredDocument = {
  pageCount: 1,
  tableCount: 1,
  pages: [
    {
      index: 0,
      markdown: "",
      tables: [
        {
          index: 0,
          headers: ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"],
          rows: [
            ["1", "Industrial Steel I-Beam (12m)", "Structural Steel", "50", "1200", "850"],
            ["6", "Cast Iron Machine Gear Assembly", "Cast Iron", "80", "100", "156"],
            ["7", "Mystery Panel (no weight)", "Foam", "100", "100", ""],
          ],
        },
      ],
    },
  ],
};

const classification: ClassificationResult = {
  provider: "rule",
  counts: { fragile: 0, standard: 3, lowConfidence: 0 },
  items: [
    { pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "I-Beam", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
    { pageIndex: 0, tableIndex: 0, rowIndex: 1, label: "Gear", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
    { pageIndex: 0, tableIndex: 0, rowIndex: 2, label: "Mystery", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
  ],
};

// Groupage/milk-round quotations often print ONE dimension column that packs all
// three extents into a single cell — "L x W x D (cm)" on the consolidated cargo
// summary, "Pallet Size (cm)" (e.g. "120 x 100 x 110 (H)") on the collection run —
// rather than separate Height/Width/Depth columns. The shipped config must split
// that combined cell into l/w/h; before this the whole cargo table was dropped as
// "no size columns" and the collection table fell back to a standard pallet size.
describe("assembleItems — combined 'L x W x D' dimension cell (groupage quote)", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const oneRow = (headers: string[], row: string[]): { doc: StructuredDocument; cls: ClassificationResult } => ({
    doc: { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows: [row] }] }] },
    cls: { provider: "rule", counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "x", fragility: "standard", confident: true, matchedTerm: null, reason: "" }] },
  });

  it("cargo-summary table: splits 'L x W x D (cm)' into all three axes (cm→m) and reads Qty", async () => {
    const { doc, cls } = oneRow(
      ["Stop Origin", "Material / Goods Description", "L x W x D (cm)", "Line Weight", "Qty (units)"],
      ["Avonmouth Marine", "Marine rope coils, boxed", "120 x 100 x 110", "14 kg/carton", "45"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    const dims = items[0]!.dimensions;
    expect(dims).not.toBeNull(); // was null (whole table dropped) before the fix
    expect([dims!.l, dims!.w, dims!.h].sort((a, b) => a - b)).toEqual([1.0, 1.1, 1.2]);
    expect(items[0]!.quantity).toBe(45); // Qty column, per piece
  });

  it("does NOT report the combined-dimension cargo table as skipped", () => {
    const { doc, cls } = oneRow(
      ["Stop Origin", "Material / Goods Description", "L x W x D (cm)", "Line Weight", "Qty (units)"],
      ["Avonmouth Marine", "Marine rope coils, boxed", "120 x 100 x 110", "14 kg/carton", "45"],
    );
    expect(skippedCargoTables(doc, cls, shipped)).toEqual([]);
  });

  it("collection run: a 'Pallet Size (cm)' cell ('120 x 100 x 110 (H)') sizes the pallet, count from Pallets", async () => {
    const { doc, cls } = oneRow(
      ["Stop", "Collection Company / Contact", "Collection Address", "Est. Arrival", "Pallets", "Pallet Size (cm)"],
      ["1", "Avonmouth Marine Supplies Ltd", "Kings Weston Lane", "07:00", "3", "120 x 100 x 110 (H)"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(3); // 3 pallets, NOT a piece count
    const dims = items[0]!.dimensions!;
    // Stated pallet size used verbatim (120×100 footprint, 110 height) — not the standard-pallet fallback.
    expect([dims.l, dims.w, dims.h].sort((a, b) => a - b)).toEqual([1.0, 1.1, 1.2]);
  });

  it("tolerates '×' separators and a trailing unit ('120×100×110cm')", async () => {
    const { doc, cls } = oneRow(
      ["Stop Origin", "Material / Goods Description", "Dimensions (cm)", "Qty (units)"],
      ["Filton", "Machined brackets", "120×100×110", "12"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.dimensions).not.toBeNull();
    expect([items[0]!.dimensions!.l, items[0]!.dimensions!.w, items[0]!.dimensions!.h].sort((a, b) => a - b)).toEqual([1.0, 1.1, 1.2]);
  });
});

// Titan/Apex 2-D schema: cm units, Italian decimals, no depth or quantity column.
// Inline (not the shipped config) so this capability test is independent of the
// deployment's current column map.
const titanMap = parseColumnMapFrom({
  version: 2,
  inputUnit: "cm",
  columns: { code: 1, description: 1, dimensionH: 3, dimensionL: 4, weight: 5 },
  defaultCategory: "heavy-material",
  categoryPatterns: [
    { category: "glass-panel", pattern: "(Glass|Panel)" },
    { category: "heavy-material", pattern: "(Steel|Iron|Concrete|Gear)" },
    { category: "appliance", pattern: "(TV|Machine|Motor|Gear|Appliance)" },
  ],
});

describe("assembleItems — 2-D source (cm) with derived depth", () => {
  let items: Item[];
  beforeAll(async () => {
    items = await assembleItems({ doc, classification, columnMap: titanMap, matrix });
  });

  it("builds one Item per classified row", () => {
    expect(items).toHaveLength(3);
  });

  it("scales cm→m (Width→l, Height→h) and derives a plausible depth", () => {
    const beam = items[0]!;
    expect(beam.dimensions).not.toBeNull();
    expect(beam.dimensions!.l).toBe(12); // 1200 cm → 12 m
    expect(beam.dimensions!.h).toBe(0.5); //  50 cm → 0.5 m
    // Derived depth stays a plausible box: positive, not deeper than the largest axis.
    expect(beam.dimensions!.w).toBeGreaterThan(0);
    expect(beam.dimensions!.w).toBeLessThanOrEqual(12);
    expect(beam.quantity).toBe(1); // no quantity column ⇒ one unit
    expect(beam.weightKg).toBe(850);
  });

  it("derives category from the description and resolves its rules", () => {
    const gear = items[1]!;
    expect(gear.category).toBe("heavy-material"); // "Cast Iron" matches heavy-material (density ~7000 kg/m³)
    expect(gear.dimensions).toEqual({ l: 1.0, h: 0.8, w: expect.any(Number) });
  });

  it("makes a standard item stackable even when its category matrix row says false", () => {
    // Fragility-driven stacking: the gear is a standard 'appliance' (matrix
    // stackable:false), yet a standard item must always stack into columns.
    const gear = items[1]!;
    expect(gear.fragility).toBe("standard");
    expect(gear.stackable).toBe(true);
  });

  it("flags a row whose depth cannot be derived (no weight) instead of guessing", () => {
    const mystery = items[2]!;
    expect(mystery.dimensions).toBeNull();
    expect(mystery.weightKg).toBe(0);
  });

  it("skips rows from a non-cargo summary table (no dimension headers)", async () => {
    const twoTableDoc: StructuredDocument = {
      pageCount: 1,
      tableCount: 2,
      pages: [
        {
          index: 0,
          markdown: "",
          tables: [
            doc.pages[0]!.tables[0]!, // the dimensioned cargo table (3 rows)
            {
              index: 1,
              headers: ["Item #", "Item Description", "Category", "Classification"],
              rows: [["1", "Industrial Steel I-Beam (12m)", "Standard", "Standard"]],
            },
          ],
        },
      ],
    };
    const withSummary: ClassificationResult = {
      ...classification,
      items: [
        ...classification.items,
        { pageIndex: 0, tableIndex: 1, rowIndex: 0, label: "I-Beam", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
      ],
    };
    const result = await assembleItems({ doc: twoTableDoc, classification: withSummary, columnMap: titanMap, matrix });
    expect(result).toHaveLength(3); // the 4th row (summary table) produces no Item…

    // …but the skip is now VISIBLE, not silent: the summary table (index 1) is reported
    // so the load plan can warn instead of showing a bare "0/0 placed".
    const skipped = skippedCargoTables(twoTableDoc, withSummary, titanMap);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.tableIndex).toBe(1);
    expect(skipped[0]!.rowCount).toBe(1);
    expect(skipped[0]!.headers).toEqual(["Item #", "Item Description", "Category", "Classification"]);
    expect(skipped[0]!.reason).toMatch(/size|pallet/i);
  });
});

// Regression: a column map that recognises a NON-standard dimension header word
// (one the fallback DIMENSION_HEADER regex in item-assembler.ts doesn't know)
// must still have its rows treated as cargo, not silently dropped as a "non-cargo
// summary table". Before this fix, isDimensionedTable() re-checked a hardcoded
// regex instead of the very headerPatterns that located the column — so a sheet
// using words this deployment's config recognises, but the hardcoded fallback
// doesn't, lost every row with zero unplaced/reason, even though the column was
// found correctly.
describe("assembleItems — a table recognised only via a custom headerPatterns entry is not treated as non-cargo", () => {
  const customMap = parseColumnMapFrom({
    version: 2,
    inputUnit: "m",
    decimalSeparator: ".",
    headerPatterns: { dimensionH: "vert", dimensionL: "horiz" },
    columns: { code: 1, description: 1, dimensionH: 2, dimensionL: 3, weight: 4 },
    defaultCategory: "heavy-material",
  });

  it("packs the row instead of dropping it (headers match config, not the hardcoded fallback)", async () => {
    const customDoc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [{
        index: 0,
        markdown: "",
        tables: [{ index: 0, headers: ["Item #", "Item Description", "Vert", "Horiz", "Weight"], rows: [["1", "Crate", "0.5", "1.2", "80"]] }],
      }],
    };
    const cls: ClassificationResult = {
      provider: "rule",
      counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "Crate", fragility: "standard", confident: true, matchedTerm: null, reason: "" }],
    };
    const items = await assembleItems({ doc: customDoc, classification: cls, columnMap: customMap, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.dimensions).not.toBeNull();
    expect(items[0]!.dimensions!.h).toBeCloseTo(0.5, 6);
    expect(items[0]!.dimensions!.l).toBeCloseTo(1.2, 6);
  });
});

// The packer skips a whole table with no dimension AND no pallet columns (every row
// would be dropped). skippedCargoTables reports exactly those tables so the load plan
// can WARN instead of collapsing into a silent "0/0 placed". It shares the one
// isCargoTable predicate with the assembler's drop gate, so "reported here" ⟺
// "produced no Item in assembleItems".
describe("skippedCargoTables — surfaces whole tables the packer can't load (no silent 0/0)", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));

  const twoTables = (): { doc: StructuredDocument; cls: ClassificationResult } => ({
    doc: {
      pageCount: 1,
      tableCount: 2,
      pages: [{
        index: 0,
        markdown: "",
        tables: [
          { index: 0, headers: ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"], rows: [["1", "Steel Beam", "Steel", "50", "1200", "850"]] },
          { index: 1, headers: ["Item #", "Item Description", "Category", "Classification"], rows: [["1", "Steel Beam", "Standard", "Standard"]] },
        ],
      }],
    },
    cls: {
      provider: "rule",
      counts: { fragile: 0, standard: 2, lowConfidence: 0 },
      items: [
        { pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "Steel Beam", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
        { pageIndex: 0, tableIndex: 1, rowIndex: 0, label: "Steel Beam", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
      ],
    },
  });

  it("reports exactly the non-cargo table, with its headers and dropped-row count", () => {
    const { doc, cls } = twoTables();
    const skipped = skippedCargoTables(doc, cls, shipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.pageIndex).toBe(0);
    expect(skipped[0]!.tableIndex).toBe(1); // the summary table, not the cargo table
    expect(skipped[0]!.rowCount).toBe(1);
    expect(skipped[0]!.headers).toEqual(["Item #", "Item Description", "Category", "Classification"]);
    expect(skipped[0]!.reason).toBeTruthy();
  });

  it("aggregates rowCount per table (one entry per table, not per row)", () => {
    const { doc, cls } = twoTables();
    const cls2: ClassificationResult = {
      ...cls,
      items: [...cls.items, { pageIndex: 0, tableIndex: 1, rowIndex: 1, label: "X", fragility: "standard", confident: true, matchedTerm: null, reason: "" }],
    };
    const skipped = skippedCargoTables(doc, cls2, shipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.rowCount).toBe(2);
  });

  it("returns [] when every classified table is a real cargo table", () => {
    const { doc, cls } = twoTables();
    const cargoOnly: ClassificationResult = { ...cls, items: [cls.items[0]!] };
    expect(skippedCargoTables(doc, cargoOnly, shipped)).toEqual([]);
  });

  it("treats a pallet-only table (Pallets column, no dimensions) as cargo — not skipped", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers: ["Stop #", "Item Description", "Material", "Pallets"], rows: [["1", "Mixed Goods", "Various", "4"]] }] }],
    };
    const cls: ClassificationResult = {
      provider: "rule",
      counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "Mixed Goods", fragility: "standard", confident: true, matchedTerm: null, reason: "" }],
    };
    expect(skippedCargoTables(doc, cls, shipped)).toEqual([]);
  });

  // Bug 0.6/0.7: a headerless table (the scan lost the header/separator framing — see
  // markdown-table.parser.ts) never enters `classification.items` at all — Stage 2's isItemTable
  // refuses it outright (table-selector.ts). That means the loop skippedCargoTables normally runs
  // (over classification.items) never sees it either, so it would otherwise vanish with NOTHING
  // recording it ever existed. skippedCargoTables must find it by scanning the document directly.
  it("reports a headerless table directly from the document, even though it produced zero classification.items", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [{
        index: 0,
        markdown: "",
        tables: [{
          index: 0,
          headers: [],
          rows: [["1", "Steel Beam", "Steel", "45", "120"], ["2", "Glass Panel", "Glass", "60", "25"]],
          headerless: true,
        }],
      }],
    };
    // Empty classification — exactly what isItemTable produces for a headerless table.
    const cls: ClassificationResult = { provider: "rule", counts: { fragile: 0, standard: 0, lowConfidence: 0 }, items: [] };

    const skipped = skippedCargoTables(doc, cls, shipped);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.pageIndex).toBe(0);
    expect(skipped[0]!.tableIndex).toBe(0);
    expect(skipped[0]!.rowCount).toBe(2);
    expect(skipped[0]!.headers).toEqual([]);
    expect(skipped[0]!.reason).toMatch(/header row was lost in the scan/i);
  });

  it("does not report a headerless table with zero rows (nothing was lost)", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers: [], rows: [], headerless: true }] }],
    };
    const cls: ClassificationResult = { provider: "rule", counts: { fragile: 0, standard: 0, lowConfidence: 0 }, items: [] };
    expect(skippedCargoTables(doc, cls, shipped)).toEqual([]);
  });

  // Defect 3 (adversarial-review fix): markdown-table.parser.ts calls ANY >=2-line block of
  // pipe-prefixed text a "headerless table" — including prose and letterheads like
  // "| Total: 266 pallets | 35,910 kg |" — so skippedCargoTables used to report every one of
  // them as a lost cargo table, burying the real warnings in noise. A plausibility floor
  // (>=2 rows AND >=3 columns) filters out short pipe-prefixed prose without inventing a real
  // cargo detector.
  describe("headerless-table warning — plausibility floor filters pipe-prefixed prose (not real cargo)", () => {
    it("does NOT report a headerless block with fewer than 3 columns (a letterhead/prose line)", () => {
      const doc: StructuredDocument = {
        pageCount: 1,
        tableCount: 1,
        pages: [{
          index: 0,
          markdown: "",
          tables: [{
            index: 0,
            headers: [],
            rows: [
              ["Please see the attached manifest for the full breakdown"],
              ["Contact accounts@example.com with any queries"],
            ],
            headerless: true,
          }],
        }],
      };
      const cls: ClassificationResult = { provider: "rule", counts: { fragile: 0, standard: 0, lowConfidence: 0 }, items: [] };
      expect(skippedCargoTables(doc, cls, shipped)).toEqual([]);
    });

    it("does NOT report a headerless block with fewer than 2 rows, even with many columns", () => {
      const doc: StructuredDocument = {
        pageCount: 1,
        tableCount: 1,
        pages: [{
          index: 0,
          markdown: "",
          tables: [{
            index: 0,
            headers: [],
            rows: [["Total:", "266 pallets", "35,910 kg"]],
            headerless: true,
          }],
        }],
      };
      const cls: ClassificationResult = { provider: "rule", counts: { fragile: 0, standard: 0, lowConfidence: 0 }, items: [] };
      expect(skippedCargoTables(doc, cls, shipped)).toEqual([]);
    });

    it("still reports a headerless block that plausibly carries cargo (>=2 rows, >=3 columns)", () => {
      const doc: StructuredDocument = {
        pageCount: 1,
        tableCount: 1,
        pages: [{
          index: 0,
          markdown: "",
          tables: [{
            index: 0,
            headers: [],
            rows: [
              ["1", "Steel Beam", "Steel", "45", "120"],
              ["2", "Glass Panel", "Glass", "60", "25"],
            ],
            headerless: true,
          }],
        }],
      };
      const cls: ClassificationResult = { provider: "rule", counts: { fragile: 0, standard: 0, lowConfidence: 0 }, items: [] };
      const skipped = skippedCargoTables(doc, cls, shipped);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.rowCount).toBe(2);
    });
  });
});

describe("assembleItems — legacy explicit 3-D source (mm)", () => {
  // Arredo3-style: explicit L/H/P columns, mm units, code-based categories.
  const arredo3Map = parseColumnMapFrom({
    version: 1,
    inputUnit: "mm",
    columns: { code: 1, quantity: 2, description: 3, dimensionL: 4, dimensionH: 5, dimensionP: 6 },
    defaultCategory: "base-cabinet",
    categoryPatterns: [{ category: "appliance", pattern: "^EFOR" }],
  });

  const arredoDoc: StructuredDocument = {
    pageCount: 1,
    tableCount: 1,
    pages: [
      {
        index: 0,
        markdown: "",
        tables: [
          {
            index: 0,
            headers: ["#", "Cod", "Qta", "Descrizione", "L", "H", "P"],
            rows: [
              ["1", "EFOR600", "1", "Forno", "598", "595", "550"],
              ["2", "BASE600", "2", "Base unit", "600", "720", "560"],
              ["3", "TOP120", "1", "Piano cucina", "1.200", "40", ""],
            ],
          },
        ],
      },
    ],
  };
  const arredoClass: ClassificationResult = {
    provider: "rule",
    counts: { fragile: 0, standard: 3, lowConfidence: 0 },
    items: [
      { pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "Forno", fragility: "fragile", confident: true, matchedTerm: "forno", reason: "" },
      { pageIndex: 0, tableIndex: 0, rowIndex: 1, label: "Base unit", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
      { pageIndex: 0, tableIndex: 0, rowIndex: 2, label: "Piano cucina", fragility: "standard", confident: true, matchedTerm: null, reason: "" },
    ],
  };

  let items: Item[];
  beforeAll(async () => {
    items = await assembleItems({ doc: arredoDoc, classification: arredoClass, columnMap: arredo3Map, matrix });
  });

  it("maps L→l, P→w, H→h with no scaling", () => {
    expect(items[0]!.dimensions).toEqual({ l: 0.598, w: 0.55, h: 0.595 });
    expect(items[0]!.category).toBe("appliance");
  });

  it("carries the category's crush limit through to the item", () => {
    const forno = items[0]!; // fragile oven, 'appliance' → maxStackPressureKpa 12
    expect(forno.fragility).toBe("fragile");
    expect(forno.maxStackPressureKpa).toBe(12);
  });

  it("expands quantity from its column", () => {
    expect(items[1]!.quantity).toBe(2);
  });

  it("flags an explicit row with a missing dimension (does not derive)", () => {
    expect(items[2]!.dimensions).toBeNull(); // missing P, no derivation in explicit mode
  });
});

describe("assembleItems — durability classification wiring", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const oneRow = (material: string, description = "Test Row"): { doc: StructuredDocument; cls: ClassificationResult } => ({
    doc: {
      pageCount: 1,
      tableCount: 1,
      pages: [{
        index: 0,
        markdown: "",
        tables: [{
          index: 0,
          headers: ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"],
          rows: [["1", description, material, "50", "50", "20"]],
        }],
      }],
    },
    cls: {
      provider: "rule",
      counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "x", fragility: "standard", confident: true, matchedTerm: null, reason: "" }],
    },
  });

  it("min-blends a low durability tier down against a high category default", async () => {
    // Default category (no matching pattern) is "heavy-material" -> 300 kPa. Foam
    // classifies to tier "none" -> 0 kPa, which must win the conservative blend.
    const { doc, cls } = oneRow("Foam");
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.category).toBe("heavy-material");
    expect(items[0]!.durabilityTier).toBe("none");
    expect(items[0]!.maxStackPressureKpa).toBe(0);
  });

  it("carries brittle through from the Material classification and softens the crush limit", async () => {
    // Tempered Glass -> tier "low" (20 kPa) + brittle:true (durability-rules.json
    // override). Already at "low" so the tier cap is a no-op here; min-blended
    // against the "heavy-material" category default (300 kPa) then x brittleFactor
    // (0.7): min(300, 20) x 0.7 = 14.
    const { doc, cls } = oneRow("Tempered Glass");
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.brittle).toBe(true);
    expect(items[0]!.maxStackPressureKpa).toBeCloseTo(14, 6);
  });

  it("caps a brittle item's PRESSURE lookup at 'low' even when its displayed tier is a higher unconfident fallback", async () => {
    // "Glass" matches brittleKeywords but no tier keyword, so it falls back to the
    // unconfident "medium" tier (60 kPa) — the DISPLAYED durabilityTier fact stays
    // "medium" (informational), but the pressure LOOKUP is capped at "low" (20 kPa)
    // before blending with the category default (heavy-material, 300 kPa) and the
    // brittleFactor (0.7): min(300, 20) x 0.7 = 14. Without the cap this would
    // wrongly compute min(300, 60) x 0.7 = 42 — MORE allowance than a properly
    // classified low-tier item (20 kPa) gets with no brittle penalty at all.
    const { doc, cls } = oneRow("Glass");
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.durabilityTier).toBe("medium");
    expect(items[0]!.brittle).toBe(true);
    expect(items[0]!.durabilityConfident).toBe(false);
    expect(items[0]!.maxStackPressureKpa).toBeCloseTo(14, 6);
  });

  it("leaves a non-brittle item's crush limit untouched by the brittle tier cap/factor", async () => {
    const { doc, cls } = oneRow("Solid Wood");
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.brittle).toBe(false);
    expect(items[0]!.durabilityTier).toBe("high");
    expect(items[0]!.maxStackPressureKpa).toBe(300); // no cap, no factor applied
  });

  it("tightens (never loosens) an unrecognised-but-present material to the placeholder medium tier", async () => {
    // "heavy-material" defaults to 300 kPa; an unrecognised material still gets
    // classified (rule classifier's unconfident default is "medium" -> 60 kPa),
    // so the blend tightens 300 down to 60 rather than trusting the category ceiling.
    const { doc, cls } = oneRow("Unobtainium");
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.durabilityTier).toBe("medium");
    expect(items[0]!.maxStackPressureKpa).toBe(60);
  });

  it("never LOOSENS a category orientation lock via a material with no orientation keyword", async () => {
    // Description "Washing Machine" -> category "appliance" (orientationLock "fixed").
    // Material "Stainless Steel" classifies to tier high but has NO orientation
    // keyword -> orientationLock "none". The blend must keep the stricter "fixed"
    // so the packer can't lay the appliance on its side.
    const { doc, cls } = oneRow("Stainless Steel", "Washing Machine");
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.category).toBe("appliance");
    expect(items[0]!.orientationLock).toBe("fixed");
    // And the crush-pressure min-blend keeps the low category ceiling even though
    // the material tier (high -> 300 kPa) is far above it (appliance -> 12 kPa).
    expect(items[0]!.durabilityTier).toBe("high");
    expect(items[0]!.maxStackPressureKpa).toBe(12);
  });

  it("TIGHTENS a loose category orientation lock when the material demands it", async () => {
    // Description "Steel Beam" -> category "heavy-material" (orientationLock "none").
    // Material "Electric Motor" -> orientationLock "fixed" (motor keyword). The blend
    // must tighten "none" up to "fixed" (a motor must ship upright).
    const { doc, cls } = oneRow("Electric Motor", "Steel Beam");
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.category).toBe("heavy-material");
    expect(items[0]!.orientationLock).toBe("fixed");
  });
});

describe("assembleItems — per-row durability overrides (human review)", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const ROW_ID = "0-0-0";
  const oneRow = (material: string, description = "Test Row"): { doc: StructuredDocument; cls: ClassificationResult } => ({
    doc: {
      pageCount: 1,
      tableCount: 1,
      pages: [{
        index: 0,
        markdown: "",
        tables: [{
          index: 0,
          headers: ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"],
          rows: [["1", description, material, "50", "50", "20"]],
        }],
      }],
    },
    cls: {
      provider: "rule",
      counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "x", fragility: "standard", confident: true, matchedTerm: null, reason: "" }],
    },
  });

  it("applies a human override OUTRIGHT — raising crush and loosening rotation past the category floor", async () => {
    // "Washing Machine" -> appliance (12 kPa, orientation "fixed"). The auto path
    // would min-blend to 12 and keep "fixed"; an explicit human review must win
    // outright: 300 kPa (tier high) and free rotation. Feeding it through the
    // conservative blend would silently ignore the correction.
    const { doc, cls } = oneRow("Stainless Steel", "Washing Machine");
    const overrides = new Map([[ROW_ID, { durabilityTier: "high" as const, brittle: false, orientationLock: "none" as const }]]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix, durabilityOverrides: overrides });
    expect(items[0]!.category).toBe("appliance");
    expect(items[0]!.durabilityTier).toBe("high");
    expect(items[0]!.maxStackPressureKpa).toBe(300); // NOT the 12 kPa category floor
    expect(items[0]!.orientationLock).toBe("none");   // NOT the stricter "fixed"
    expect(items[0]!.durabilityConfident).toBe(true); // a human reviewed it
  });

  it("lets a human turn OFF a wrongly-brittle flag so the packer can stack on top", async () => {
    const { doc, cls } = oneRow("Tempered Glass");
    const auto = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(auto[0]!.brittle).toBe(true); // sanity: auto flags glass brittle

    const overrides = new Map([[ROW_ID, {
      durabilityTier: auto[0]!.durabilityTier,
      brittle: false,
      orientationLock: auto[0]!.orientationLock,
    }]]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix, durabilityOverrides: overrides });
    expect(items[0]!.brittle).toBe(false);
    expect(items[0]!.durabilityConfident).toBe(true);
  });

  it("applies the same brittle tier-cap + factor on the OVERRIDE path as the auto path", async () => {
    // A human marks a row brittle with tier "high" — the override is authoritative
    // for the DISPLAYED tier (stays "high", unlike the auto path there's no
    // category min-blend), but the PRESSURE lookup is still capped at "low" (20
    // kPa) before brittleFactor: 20 x 0.7 = 14 — not 300 x 0.7 = 210.
    const { doc, cls } = oneRow("Stainless Steel", "Washing Machine");
    const overrides = new Map([[ROW_ID, { durabilityTier: "high" as const, brittle: true, orientationLock: "none" as const }]]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix, durabilityOverrides: overrides });
    expect(items[0]!.durabilityTier).toBe("high"); // displayed fact: authoritative, unaffected by the cap
    expect(items[0]!.brittle).toBe(true);
    expect(items[0]!.maxStackPressureKpa).toBeCloseTo(14, 6);
  });

  it("lets a human raise a 'Nothing on top' (0 kPa) row so weight can be stacked", async () => {
    // Foam auto-classifies tier "none" -> 0 kPa. A human who sees a sturdy crate
    // sets Heavy; the crush limit must rise off 0 so weight can be stacked. Foam is
    // deformable, so the physical-softness factor (0.7) still caps it: 300 -> 210.
    // The point stands — it's no longer stuck at 0.
    const { doc, cls } = oneRow("Foam");
    const overrides = new Map([[ROW_ID, { durabilityTier: "high" as const, brittle: false, orientationLock: "none" as const }]]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix, durabilityOverrides: overrides });
    expect(items[0]!.durabilityTier).toBe("high");
    expect(items[0]!.deformable).toBe(true); // foam compresses — softening applies
    expect(items[0]!.maxStackPressureKpa).toBeCloseTo(210, 6); // 300 × 0.7
  });

  it("overrides only the matching row id — a non-matching key leaves the auto path intact", async () => {
    const { doc, cls } = oneRow("Foam"); // auto tier "none" -> 0 kPa
    const overrides = new Map([["9-9-9", { durabilityTier: "high" as const, brittle: false, orientationLock: "none" as const }]]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix, durabilityOverrides: overrides });
    expect(items[0]!.durabilityTier).toBe("none");
    expect(items[0]!.maxStackPressureKpa).toBe(0);
  });
});

// Multi-drop groupage: one cargo table with a "Stop" column naming each row's
// delivery stop, interleaved with "STOP N" section headers, "Sub-total" rows and a
// "GRAND TOTAL" row. Each cargo row must carry its 0-based stopIndex; the structural
// rows must be dropped, not turned into phantom "missing dimensions" units (which
// used to inflate the load count and trip the packer's conservation gate).
describe("assembleItems — multi-drop manifest (Stop column + structural rows)", () => {
  const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));
  const HEADERS = ["Stop", "#", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"];
  const build = (rows: string[][]) => ({
    doc: { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers: HEADERS, rows }] }] } as StructuredDocument,
    cls: { provider: "rule" as const, counts: { fragile: 0, standard: rows.length, lowConfidence: 0 },
      items: rows.map((_, rowIndex) => ({ pageIndex: 0, tableIndex: 0, rowIndex, label: "x", fragility: "standard" as const, confident: true, matchedTerm: null, reason: "" })) } as ClassificationResult,
  });

  it("tags each cargo row with its 0-based stopIndex from the Stop column", async () => {
    const { doc, cls } = build([
      ["1", "1", "Wine Glasses", "Glass", "2800 pcs", "30", "120", "672", "14.0"],
      ["2", "8", "Cookware Set", "Steel", "140 pcs", "40", "60", "252", "7.0"],
      ["3", "15", "Shower Door", "Glass", "70 units", "200", "80", "1330", "21.0"],
    ]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items.map((i) => i.stopIndex)).toEqual([0, 1, 2]);
  });

  it("drops section-header / sub-total / grand-total rows (no phantom items)", async () => {
    const { doc, cls } = build([
      ["**STOP 1 — Solstice Retail Ltd**", "", "", "", "", "", "", "", ""],
      ["1", "1", "Wine Glasses", "Glass", "2800 pcs", "30", "120", "672", "14.0"],
      ["**Sub-total Stop 1**", "", "", "", "", "", "", "**12,782**", "**91.0**"],
      ["**GRAND TOTAL**", "", "", "", "", "", "", "**35,910**", "**266.0**"],
    ]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1); // only the real cargo row survives
    expect(items[0]!.stopIndex).toBe(0);
    expect(items[0]!.dimensions).not.toBeNull();
  });

  it("still surfaces a genuine dimensionless cargo row (has a description) as a null-dims item", async () => {
    const { doc, cls } = build([["1", "5", "Mystery Crate", "Steel", "3 units", "", "", "", ""]]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.dimensions).toBeNull(); // no size given — flagged, never guessed
    expect(items[0]!.stopIndex).toBe(0);
  });
});
