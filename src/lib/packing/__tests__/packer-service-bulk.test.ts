/**
 * Integration: the bulk-run fast-path through the real packJob orchestrator.
 *
 * Proves a huge single-SKU order that consolidates to WELL OVER the `maxPackableBlocks`
 * cap (2,000) — which previously threw "consolidates to ~N placeable blocks … times
 * out" — now returns a valid, conserving fleet plan quickly, because one representative
 * van is packed and multiplied instead of scanning every block.
 */
import { describe, it, expect } from "vitest";
import { packJob } from "@/lib/packing/packer.service";

// One row, 250,000 identical 0.6 m cubes. Consolidation collapses them into blocks;
// at ~12 units/block that is ~20k placeable blocks — an order of magnitude past the cap.
const HUGE_DOC = {
  pageCount: 1,
  tableCount: 1,
  pages: [
    {
      index: 0,
      markdown: "",
      tables: [
        {
          index: 0,
          headers: ["Item Description", "Material", "Height (cm)", "Width (cm)", "Depth (cm)", "Unit Weight (kg)", "Quantity"],
          rows: [["Widget", "Steel", "60", "60", "60", "8", "250000"]],
        },
      ],
    },
  ],
};

const HUGE_CLASSIFICATION = {
  items: [
    { pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "Widget", fragility: "standard", confident: true, matchedTerm: null, reason: "standard" },
  ],
  counts: { fragile: 0, standard: 1, lowConfidence: 0 },
};

// A large vehicle with abundant availability so fleet capacity never binds — this test
// isolates the bulk fast-path, not fleet exhaustion.
const BIG_VAN = {
  id: "artic",
  label: "Articulated",
  interior: { l: 13.6, w: 2.4, h: 2.6 },
  maxPayloadKg: 26_000,
  perMileRate: 2,
  quantity: 100_000,
};

describe("packJob — bulk-run fast-path (huge single-SKU order)", () => {
  it("quotes a >2,000-block single-SKU order without throwing, fast, conserving every unit", async () => {
    const start = Date.now();
    const result = await packJob({
      doc: HUGE_DOC as never,
      classification: HUGE_CLASSIFICATION as never,
      vans: [BIG_VAN as never],
      respectReachLimit: false,
    });
    const elapsedMs = Date.now() - start;

    // Reported totals are REAL units (Phase 5 expansion), not the block count.
    expect(result.packableUnits).toBe(250_000);
    // A quarter-million cubes cannot ride one van.
    expect(result.fitsInSingleVan).toBe(false);
    expect(result.fleet.length).toBeGreaterThan(1);
    // Reaching this line at all proves the service's internal placed + unplaced ===
    // total conservation gate passed (it throws otherwise). Assert it carried the job.
    expect(result.unplaced).toHaveLength(0);
    // Per-block scanning of ~20k blocks would take tens of seconds and time out; the
    // multiply keeps it to a couple of real packs. Generous bound for CI noise.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
