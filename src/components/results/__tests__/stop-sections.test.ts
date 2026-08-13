/** Unit coverage for the per-stop cargo-table split (multi-drop manifest segmentation). */
import { describe, it, expect } from "vitest";
import { stopSections } from "@/components/results/ResultTables";
import type { ClassifiedItem, PageContent } from "@/types/api";

const cargo = {} as ClassifiedItem; // only presence in the classMap matters here

function page(rows: string[][]): PageContent {
  return { index: 0, tables: [{ index: 0, headers: ["Item"], rows }] } as PageContent;
}

describe("stopSections", () => {
  it("splits a multi-drop manifest into per-stop sections, lifting marker/sub-total out of the rows", () => {
    // Mirrors the reported manifest: Stop 1 items, its sub-total, then a STOP 2 header, then Stop 2 items.
    const rows = [
      ["Ceramic Floor Tile Pallet"], //                          r0 — Stop 1 cargo
      ["Porcelain Dinner Set"], //                               r1 — Stop 1 cargo
      ["Sub-total Stop 1"], //                                   r2 — footer
      ["STOP 2 — Midlands Wholesale Co. (Northampton, via BHM Hub)"], // r3 — heading
      ["Stainless Steel Cookware Set"], //                       r4 — Stop 2 cargo
    ];
    const p = page(rows);
    const classMap = new Map([
      ["0-0-0", cargo],
      ["0-0-1", cargo],
      ["0-0-4", cargo],
    ]);
    const stopByItemId = new Map([["0-0-4", 1]]); // Stop-column attribution: item 4 → drop index 1

    const secs = stopSections(p, p.tables[0]!, classMap, stopByItemId);

    expect(secs).toHaveLength(2);
    expect(secs[0]!.label).toBe("Stop 1");
    expect(secs[0]!.rows.map((x) => x.r)).toEqual([0, 1]);
    expect(secs[0]!.subtotal).toBe("Sub-total Stop 1");
    // Rich destination label taken from the marker row, which is NOT rendered as a data row.
    expect(secs[1]!.label).toBe("STOP 2 — Midlands Wholesale Co. (Northampton, via BHM Hub)");
    expect(secs[1]!.rows.map((x) => x.r)).toEqual([4]);
    expect(secs[1]!.subtotal).toBeUndefined();
    // Marker (r3) and sub-total (r2) never appear as cargo rows.
    const allRowIndexes = secs.flatMap((s) => s.rows.map((x) => x.r));
    expect(allRowIndexes).toEqual([0, 1, 4]);
  });

  it("returns a single section for a single-stop table so the caller renders one plain table", () => {
    const rows = [["Box A"], ["Box B"]];
    const p = page(rows);
    const classMap = new Map([
      ["0-0-0", cargo],
      ["0-0-1", cargo],
    ]);
    const secs = stopSections(p, p.tables[0]!, classMap);
    expect(secs).toHaveLength(1);
    expect(secs[0]!.rows.map((x) => x.r)).toEqual([0, 1]);
  });
});
