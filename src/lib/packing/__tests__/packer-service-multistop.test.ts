/**
 * Integration: a multi-drop groupage manifest through the real packJob orchestrator.
 *
 * Proves that when cargo rows carry a Stop column, every van in the chosen fleet is
 * loaded in drop order — the earliest stop's cargo sits at the doors (low x), later
 * stops deeper — so nothing has to be dug out to reach an early drop. A single-drop
 * job (no Stop column) is left packing exactly as before.
 */
import { describe, it, expect } from "vitest";
import { packJob } from "@/lib/packing/packer.service";

// Three stops, three pallet lines each, two pallets per line — small enough to skip
// consolidation (so placement ids stay row ids) but enough to spill across vans.
const STOP_HEADERS = ["Stop", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"];
function palletRow(stop: number, name: string) {
  return [String(stop), name, "Steel", "100", "120", "300", "2"];
}
const STOP_ROWS = [
  palletRow(1, "Alpha"), palletRow(1, "Bravo"), palletRow(1, "Charlie"),
  palletRow(2, "Delta"), palletRow(2, "Echo"), palletRow(2, "Foxtrot"),
  palletRow(3, "Golf"), palletRow(3, "Hotel"), palletRow(3, "India"),
];

const MULTISTOP_DOC = {
  pageCount: 1,
  tableCount: 1,
  pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers: STOP_HEADERS, rows: STOP_ROWS }] }],
};

function classify(rows: string[][]) {
  return {
    items: rows.map((_, rowIndex) => ({
      pageIndex: 0, tableIndex: 0, rowIndex, label: "x",
      fragility: "standard", confident: true, matchedTerm: null, reason: "standard",
    })),
    counts: { fragile: 0, standard: rows.length, lowConfidence: 0 },
  };
}

// A modest van that holds only a handful of pallets, so the 18-pallet load needs
// several vans and the multi-van drop-order path is exercised.
const VAN = {
  id: "luton", label: "Luton", interior: { l: 4.0, w: 2.0, h: 2.2 },
  maxPayloadKg: 3000, perMileRate: 1.5, quantity: 10,
};

/** stop index (0-based) for a placement id `0-0-<rowIndex>`, via the Stop column. */
function stopOf(itemId: string): number {
  const rowIndex = Number(itemId.split("-")[2]);
  return Number(STOP_ROWS[rowIndex]![0]) - 1;
}

describe("packJob — multi-drop drop-order loading", () => {
  it("loads every van earliest-stop-first (no later stop sits ahead of an earlier one)", async () => {
    const result = await packJob({
      doc: MULTISTOP_DOC as never,
      classification: classify(STOP_ROWS) as never,
      vans: [VAN as never],
      respectReachLimit: false,
    });

    // All 18 pallets carried, spread across more than one van.
    expect(result.unplaced).toHaveLength(0);
    expect(result.packableUnits).toBe(18);
    expect(result.fleet.length).toBeGreaterThan(1);

    // Per van: no box for a later stop sits ahead of (smaller x than the cab-side edge
    // of) any earlier stop's box. i.e. the stops form clean door→cab bands.
    const EPS = 1e-6;
    for (const van of result.fleet) {
      const byStop = new Map<number, { minX: number; maxEnd: number }>();
      for (const p of van.placements) {
        const s = stopOf(p.itemId);
        const cur = byStop.get(s) ?? { minX: Infinity, maxEnd: -Infinity };
        cur.minX = Math.min(cur.minX, p.position.x);
        cur.maxEnd = Math.max(cur.maxEnd, p.position.x + p.size.x);
        byStop.set(s, cur);
      }
      const stops = [...byStop.keys()].sort((a, b) => a - b);
      for (let i = 0; i + 1 < stops.length; i++) {
        const earlier = byStop.get(stops[i]!)!;
        const later = byStop.get(stops[i + 1]!)!;
        expect(earlier.maxEnd).toBeLessThanOrEqual(later.minX + EPS);
      }
    }
  });

  it("leaves a single-drop job (no Stop column) packing unchanged", async () => {
    const headers = ["Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)", "Pallets"];
    const rows = [["Alpha", "Steel", "100", "120", "300", "2"], ["Bravo", "Steel", "100", "120", "300", "2"]];
    const doc = { pageCount: 1, tableCount: 1, pages: [{ index: 0, markdown: "", tables: [{ index: 0, headers, rows }] }] };
    const result = await packJob({
      doc: doc as never,
      classification: classify(rows) as never,
      vans: [VAN as never],
      respectReachLimit: false,
    });
    expect(result.unplaced).toHaveLength(0);
    expect(result.packableUnits).toBe(4);
  });
});
