/**
 * Milestone C — format-robust column/unit recognition:
 *   • flaggedCargoTables surfaces a table whose size UNIT had to be assumed (no
 *     cm/mm/m marker), so an unmarked mm sheet read as metres is never silent;
 *   • a clean, unit-marked sheet produces NO flag (no false alarms);
 *   • the combined "L x W x D" cell now also splits on "*" and whitespace, so
 *     more quote formats parse without regressing the "x"/"(H)" cases.
 */
import { describe, it, expect } from "vitest";
import { assembleItems, flaggedCargoTables } from "@/lib/packing/item-assembler";
import { parseColumnMapFrom } from "@/lib/packing/column-map";
import { parseStackabilityFrom } from "@/lib/packing/stackability";
import { readConfigJson } from "./fixtures";
import type { StructuredDocument } from "@/lib/conversion/types";
import type { ClassificationResult } from "@/lib/classification/types";

const matrix = parseStackabilityFrom(readConfigJson("config/stackability.json"));
const shipped = parseColumnMapFrom(readConfigJson("config/column-map.json"));

function oneRow(headers: string[], row: string[]): { doc: StructuredDocument; cls: ClassificationResult } {
  return {
    doc: { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows: [row] }] }] },
    cls: {
      provider: "rule",
      counts: { fragile: 0, standard: 1, lowConfidence: 0 },
      items: [{ pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "x", fragility: "standard", confident: true, matchedTerm: null, reason: "" }],
    },
  };
}

describe("flaggedCargoTables — the 'had to guess' review surface", () => {
  it("does NOT flag a sheet whose size headers state the unit (cm)", () => {
    const { doc, cls } = oneRow(
      ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"],
      ["1", "Steel Crate", "Steel", "50", "120", "850"],
    );
    expect(flaggedCargoTables(doc, cls, shipped)).toEqual([]);
  });

  it("flags a sheet with bare size headers (no cm/mm/m) — unit was assumed", () => {
    const { doc, cls } = oneRow(
      ["Item #", "Item Description", "Material", "Height", "Width", "Weight"],
      ["1", "Steel Crate", "Steel", "50", "120", "850"],
    );
    const flagged = flaggedCargoTables(doc, cls, shipped);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toMatch(/no size unit/i);
    expect(flagged[0]!.reason).toContain(shipped.inputUnit); // says what was assumed
  });

  it("does NOT flag a combined 'Pallet Size (cm)' sheet — unit is on the combined header", () => {
    const { doc, cls } = oneRow(["Item", "Pallet Size (cm)"], ["Widget", "120 x 100 x 110 (H)"]);
    expect(flaggedCargoTables(doc, cls, shipped)).toEqual([]);
  });
});

// Defect 1 (adversarial-review fix, live money bug): a "Pallet Size (cm)" header matches BOTH the
// `pallets` and `dimensionCombined` headerPatterns. On a sheet with no DISTINCT pallet-count column,
// the previous code let `cols.pallets` resolve to that same size-cell index, and parseNumeric("120 x
// 100 x 110") is Number.parseFloat, which returns 120 (it stops at the first non-numeric character) —
// so the row was quoted as 120 pallets x 400 kg = 48,000 kg out of a single "Pallet Size" cell. The
// fix makes `pallets` resolve to undefined whenever it would collide with `dimensionCombined`
// (column-map.ts), so the row is read as one ordinary dimensioned item instead.
describe("resolveColumnIndices / assembleItems — a lone 'Pallet Size (cm)' column is a SIZE, never a COUNT", () => {
  it("does not fabricate a 120-pallet quantity from a size cell that starts with a numeral", async () => {
    const { doc, cls } = oneRow(["Item", "Pallet Size (cm)"], ["Widget", "120 x 100 x 110 (H)"]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(1); // NOT 120 — this cell states a size, not a count
    const dims = items[0]!.dimensions!;
    expect([dims.l, dims.w, dims.h].sort((a, b) => a - b)).toEqual([1.0, 1.1, 1.2]);
  });

  it("still uses the pallet-count path when Pallets is a genuinely DISTINCT column from Pallet Size", async () => {
    const { doc, cls } = oneRow(
      ["Stop", "Collection Company / Contact", "Collection Address", "Est. Arrival", "Pallets", "Pallet Size (cm)"],
      ["1", "Avonmouth Marine Supplies Ltd", "Kings Weston Lane", "07:00", "3", "120 x 100 x 110 (H)"],
    );
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[0]!.quantity).toBe(3); // the real Pallets column still drives the count
  });
});

// Bug 0.2: a pallet manifest with no weight column AND no total the sheet states for itself used to
// be silently priced at the config's 400 kg default (item-assembler.ts:695-698 before the fix) — a
// clean load plan, zero warnings, and (on a 266-pallet sheet) a 3× mis-quote. The default is still
// USED — we must still quote something — but it must never again be silent.
describe("flaggedCargoTables — bug 0.2: silent 400 kg pallet-weight default", () => {
  it("flags a pallet sheet with no weight column and no stated total: every pallet assumed 400 kg", () => {
    const { doc, cls } = oneRow(
      ["Item", "Description", "Material", "Qty", "Pallets"],
      ["1", "Assorted Hardware", "Steel", "9000", "20"],
    );
    const flagged = flaggedCargoTables(doc, cls, shipped);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toMatch(/no weight per line/i);
    expect(flagged[0]!.reason).toMatch(/states no total/i);
    expect(flagged[0]!.reason).toContain("400 kg");
  });

  it("flags with the IMPLAUSIBLE-total reason (not the no-total reason) when the sheet states one but it's out of range", () => {
    const { doc, cls } = oneRow(
      ["Item", "Description", "Material", "Qty", "Pallets"],
      ["1", "Assorted Hardware", "Steel", "9000", "20"],
    );
    // A misread total: "3,591,000 kg over 20 pallets" implies 179,550 kg/pallet — no van could carry
    // it, so it must be rejected as implausible rather than trusted (see palletDefaults.plausibleMaxKg).
    (doc.pages[0] as { markdown: string }).markdown = "Total: 20 pallets | 3,591,000 kg";
    const flagged = flaggedCargoTables(doc, cls, shipped);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toMatch(/no weight per line/i);
    expect(flagged[0]!.reason).toMatch(/outside the plausible/i);
    expect(flagged[0]!.reason).toContain("400 kg");
  });

  it("does NOT use the 400 kg-assumed reason when the sheet states a usable total — uses the derived-weight reason instead", () => {
    const { doc, cls } = oneRow(
      ["Item", "Description", "Material", "Qty", "Pallets"],
      ["1", "Assorted Hardware", "Steel", "9000", "20"],
    );
    (doc.pages[0] as { markdown: string }).markdown = "Total: 20 pallets | 2,700 kg";
    const flagged = flaggedCargoTables(doc, cls, shipped);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toMatch(/weighed from the total it states/i);
    expect(flagged[0]!.reason).not.toContain("400 kg");
  });

  it("does NOT flag ANY weight-default reason for a sheet with a weight column and every cell filled", () => {
    const { doc, cls } = oneRow(
      ["Stop #", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"],
      ["1", "Ceramic Floor Tile Pallet", "Ceramic", "14000", "12", "120", "6720", "14"],
    );
    const flagged = flaggedCargoTables(doc, cls, shipped);
    for (const f of flagged) {
      expect(f.reason).not.toContain("400 kg");
      expect(f.reason).not.toMatch(/gave no weight of their own/i);
    }
  });
});

// Defect 2 (adversarial-review fix): a blank weight CELL on one pallet line used to be
// silently priced at the 400 kg default even though the table HAS a real weight column —
// flaggedCargoTables only checked whether the whole column was missing, so a per-row hole
// reached zero operator-facing warning. parseRow's fallback is unchanged (a default is still
// USED so the job can still be quoted); what changed is that it is now never SILENT.
describe("flaggedCargoTables — a per-row blank weight cell on a pallet line is never silent", () => {
  it("flags exactly the pallet line whose weight cell is blank, naming it, even though the column exists", () => {
    const { doc, cls } = oneRow(
      ["Stop #", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"],
      ["1", "Smudged Manifest Line", "Ceramic", "14000", "12", "120", "", "14"],
    );
    const flagged = flaggedCargoTables(doc, cls, shipped);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toMatch(/gave no weight of their own/i);
    expect(flagged[0]!.reason).toContain("Smudged Manifest Line");
  });

  it("does not flag rows that DO carry a weight, only the blank one, in a mixed table", async () => {
    const headers = ["Stop #", "Item Description", "Material", "Quantity", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"];
    const rows = [
      ["1", "Good Row", "Ceramic", "14000", "12", "120", "6720", "14"],
      ["2", "Smudged Row", "Ceramic", "9000", "12", "120", "", "9"],
    ];
    const doc: StructuredDocument = { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows }] }] };
    const cls: ClassificationResult = {
      provider: "rule",
      counts: { fragile: 0, standard: 2, lowConfidence: 0 },
      items: rows.map((_, rowIndex) => ({ pageIndex: 0, tableIndex: 0, rowIndex, label: "x", fragility: "standard", confident: true, matchedTerm: null, reason: "" })),
    };
    const flagged = flaggedCargoTables(doc, cls, shipped);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toContain("1 pallet line");
    expect(flagged[0]!.reason).toContain("Smudged Row");
    expect(flagged[0]!.reason).not.toContain("Good Row");

    // And the same fallback the flag describes is what actually gets priced onto that row.
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    expect(items[1]!.weightKg).toBe(shipped.palletDefaults.defaultWeightKg); // no stated total on this doc
  });
});

// Bug: readStatedPalletTotals used to strip commas ONLY (English convention hardcoded), ignoring
// the column map's declared decimalSeparator. On a European source a stated "35.910 kg" (dot =
// thousands) was misread as 35.91 kg, so 35.91 / 266 pallets fell far outside the plausibility
// band and silently fell back to the 400 kg default — the very failure this module exists to
// prevent. Fixed by reading the prose total through the SAME parseNumeric(raw, decimalSeparator)
// every other cell in the pipeline uses.
describe("readStatedPalletTotals — honours the column map's decimalSeparator (not hardcoded English)", () => {
  const europeanMap = parseColumnMapFrom({ ...readConfigJson("config/column-map.json") as object, decimalSeparator: "," });

  it("reads a European '35.910 kg' (dot=thousands) as 35910, not 35.91", () => {
    const { doc, cls } = oneRow(
      ["Item", "Description", "Material", "Qty", "Pallets"],
      ["1", "Assorted Hardware", "Steel", "9000", "266"],
    );
    (doc.pages[0] as { markdown: string }).markdown = "Total: 266 pallets | 35.910 kg";
    const flagged = flaggedCargoTables(doc, cls, europeanMap);
    expect(flagged).toHaveLength(1);
    // 35910 / 266 = ~135 kg/pallet, inside the plausible band — derived weight used, not 400 kg default.
    expect(flagged[0]!.reason).toMatch(/weighed from the total it states/i);
    expect(flagged[0]!.reason).toContain("135 kg");
    expect(flagged[0]!.reason).not.toContain("400 kg");
  });

  it("does NOT drop the derived weight to the 400 kg default under the '.' (English) column map", () => {
    // Sanity: on the SHIPPED (English, '.') column map the same "35.910" is read as 35.91 kg — a
    // genuinely tiny, implausible pallet weight — so it correctly falls back to the 400 kg default.
    // Proves the fix is convention-aware, not just "always treat dots as thousands".
    const { doc, cls } = oneRow(
      ["Item", "Description", "Material", "Qty", "Pallets"],
      ["1", "Assorted Hardware", "Steel", "9000", "266"],
    );
    (doc.pages[0] as { markdown: string }).markdown = "Total: 266 pallets | 35.910 kg";
    const flagged = flaggedCargoTables(doc, cls, shipped);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.reason).toContain("400 kg");
  });
});

describe("parseCombinedDimensions — extra separators for more quote formats", () => {
  async function dimsFor(cell: string): Promise<number[]> {
    const { doc, cls } = oneRow(["Item", "Pallet Size (cm)"], ["Widget", cell]);
    const items = await assembleItems({ doc, classification: cls, columnMap: shipped, matrix });
    const d = items[0]!.dimensions;
    expect(d).not.toBeNull();
    return [d!.l, d!.w, d!.h].sort((a, b) => a - b);
  }

  it("splits on '*' (120 * 100 * 110 cm → 1.0/1.1/1.2 m)", async () => {
    expect(await dimsFor("120 * 100 * 110")).toEqual([1.0, 1.1, 1.2]);
  });

  it("splits on whitespace only (120 100 110 cm → 1.0/1.1/1.2 m)", async () => {
    expect(await dimsFor("120 100 110")).toEqual([1.0, 1.1, 1.2]);
  });

  it("still parses the 'x' + trailing (H) form unchanged", async () => {
    expect(await dimsFor("120 x 100 x 110 (H)")).toEqual([1.0, 1.1, 1.2]);
  });
});
