/**
 * Regression: BUG 0.1 — a single cargo row with no readable size crashed the WHOLE
 * quote. The unit-conservation gate (packer.service.ts) compared placed+unplaced
 * against `realUnits` (countPackableUnits — dimensions:null rows excluded), but
 * assembleItems keeps a dimensionless row (it has description text, so it isn't a
 * structural/totals row — item-assembler.ts:749-750) and fleet-allocator routes it
 * into `unplaced` with a reason. That made placed+unplaced exceed the excluded
 * `realUnits` total and trip "Internal accounting error — contact support".
 *
 * Fix: the gate now compares against `totalUnits(assembled)` (fleet-allocator.ts),
 * which counts every assembled row including dimensionless ones.
 */
import { describe, it, expect } from "vitest";
import { packJob } from "@/lib/packing/packer.service";

const HEADERS = ["Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"];
const ROWS = [
  // Height cell blank ⇒ item-assembler cannot parse dimensions ⇒ dimensions: null,
  // but the row keeps its description text so it is NOT dropped as structural.
  ["Mystery Crate", "Steel", "", "120", "40"],
  ["Steel Angle Bar", "Structural Steel", "40", "120", "85"],
];

const DOC = {
  pageCount: 1,
  tableCount: 1,
  pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers: HEADERS, rows: ROWS }] }],
};

const CLASSIFICATION = {
  items: ROWS.map((_, rowIndex) => ({
    pageIndex: 0, tableIndex: 0, rowIndex, label: "x",
    fragility: "standard", confident: true, matchedTerm: null, reason: "standard",
  })),
  counts: { fragile: 0, standard: ROWS.length, lowConfidence: 0 },
};

const VAN = {
  id: "luton", label: "Luton", interior: { l: 4.0, w: 2.0, h: 2.2 },
  maxPayloadKg: 3000, perMileRate: 1.5, quantity: 5,
};

describe("packJob — dimensionless row (BUG 0.1)", () => {
  it("packs the readable row and reports the unreadable one as unplaced with a reason, instead of throwing", async () => {
    const result = await packJob({
      doc: DOC as never,
      classification: CLASSIFICATION as never,
      vans: [VAN as never],
      respectReachLimit: false,
    });

    // The dimensionless row must surface as unplaced with a legible reason — never
    // silently dropped, never fabricated a size.
    expect(result.unplaced).toHaveLength(1);
    const [unplaced] = result.unplaced;
    expect(unplaced!.dimensions).toBeNull();
    expect(result.reasons[unplaced!.id]).toBe("missing or unparseable dimensions");

    // The other, readable row packs normally.
    expect(result.fleet.length).toBeGreaterThanOrEqual(1);
    const placedIds = result.fleet.flatMap((v) => v.placements.map((p) => p.itemId));
    expect(placedIds).toHaveLength(1);
  });
});
