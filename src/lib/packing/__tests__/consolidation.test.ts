/** Phase 1 — pure consolidation module: grid/residual golden math + invariants. */
import { describe, it, expect } from "vitest";
import { consolidate, DEFAULT_CONSOLIDATION_CONFIG, type ConsolidationConfig } from "@/lib/packing/consolidation";
import { makeItem } from "./fixtures";
import type { Dimensions } from "@/lib/packing/packing.types";

const interior: Dimensions = { l: 4.0, w: 2.0, h: 2.0 };

describe("consolidate — golden grid + residual math", () => {
  // Hand-computed SKU: 0.3 x 0.3 x 0.3 m unit, 10 kg, canSupportWeightKg=80,
  // maxStackPressureKpa=50, orientationLock "none" (may lay flat).
  // footprintCapM=1.2, heightCapM=2.0 (defaults).
  // a = floor(min(4.0,1.2)/0.3) = floor(1.2/0.3) = 4
  // b = floor(min(2.0,1.2)/0.3) = floor(1.2/0.3) = 4
  // c candidates capped by height: floor(min(2.0,2.0)/0.3) = 6
  // maxLayersByWeight = 1 + floor(80/10) = 9
  // area = 0.3*0.3 = 0.09 m^2
  // maxLayersByPressure = 1 + floor(50*1000*0.09 / (10*9.80665)) = 1 + floor(4500/98.0665) = 1+45 = 46
  // c = min(9, 46, 6) = 6
  // unitsPerBlock = 4*4*6 = 96
  const cfg: ConsolidationConfig = { ...DEFAULT_CONSOLIDATION_CONFIG, minUnitsToConsolidate: 50, maxBlockUnits: 10000 };

  it("computes the exact grid + residual for a realistic SKU", () => {
    const item = makeItem({
      id: "sku-1",
      dimensions: { l: 0.3, w: 0.3, h: 0.3 },
      weightKg: 10,
      canSupportWeightKg: 80,
      maxStackPressureKpa: 50,
      orientationLock: "none",
      quantity: 96 * 3, // exactly 3 whole blocks, no remainder
    });

    const { items, meta } = consolidate([item], interior, cfg);
    expect(items).toHaveLength(1);
    const block = items[0]!;
    expect(block.quantity).toBe(3);
    expect(block.dimensions!.l).toBeCloseTo(1.2, 9);
    expect(block.dimensions!.w).toBeCloseTo(1.2, 9);
    expect(block.dimensions!.h).toBeCloseTo(1.8, 9); // 4*0.3, 4*0.3, 6*0.3
    expect(block.weightKg).toBeCloseTo(96 * 10, 6);

    // residual: capByWeight=80, capByPressure = 50*1000*0.09/9.80665 = 458.7159...
    // min(80, 458.7...) = 80; residual = 80 - (6-1)*10 = 80-50 = 30
    expect(block.canSupportWeightKg).toBeCloseTo(30, 6);
    expect(block.maxStackPressureKpa).toBe(50);

    const bm = meta.get(block.id);
    expect(bm).toBeDefined();
    expect(bm!.unitsPerBlock).toBe(96);
    expect(bm!.grid).toEqual({ a: 4, b: 4, c: 6 });
  });

  it("conserves total real units: block quantity*unitsPerBlock + remainder + passthrough === original", () => {
    const original = 96 * 5 + 37; // 5 whole blocks + a 37-unit remainder
    const item = makeItem({
      id: "sku-2",
      dimensions: { l: 0.3, w: 0.3, h: 0.3 },
      weightKg: 10,
      canSupportWeightKg: 80,
      maxStackPressureKpa: 50,
      orientationLock: "none",
      quantity: original,
    });

    const { items, meta } = consolidate([item], interior, cfg);
    let accounted = 0;
    for (const out of items) {
      const bm = meta.get(out.id);
      if (bm) {
        accounted += bm.unitsPerBlock * out.quantity;
      } else {
        accounted += Math.max(1, out.quantity);
      }
    }
    expect(accounted).toBe(original);
  });

  it("respects orientationLock=fixed — never lays the unit down to change height axis", () => {
    // Tall thin unit: fixed lock means only the natural orientation (l,w,h) may be
    // used, even though laying it on its side would pack far more per block.
    const item = makeItem({
      id: "sku-fixed",
      dimensions: { l: 0.3, w: 0.3, h: 1.5 },
      weightKg: 5,
      canSupportWeightKg: 40,
      maxStackPressureKpa: 30,
      orientationLock: "fixed",
      quantity: 200,
    });
    const { items, meta } = consolidate([item], interior, cfg);
    const block = items.find((i) => meta.has(i.id));
    expect(block).toBeDefined();
    const bm = meta.get(block!.id)!;
    // Natural orientation only: uH must equal the item's own h (1.5), never 0.3.
    expect(bm.unitDims.h).toBe(1.5);
    // heightCapM=2.0 / 1.5 = 1 layer only (fixed units 1.5m tall can't double-stack
    // within the 2.0m cap), so c must be 1.
    expect(bm.grid.c).toBe(1);
  });

  it("unitWeight=0 is safe — skips the weight bound rather than dividing by zero", () => {
    const item = makeItem({
      id: "sku-weightless",
      dimensions: { l: 0.2, w: 0.2, h: 0.2 },
      weightKg: 0,
      canSupportWeightKg: 100,
      maxStackPressureKpa: 50,
      orientationLock: "none",
      quantity: 500,
    });
    expect(() => consolidate([item], interior, cfg)).not.toThrow();
    const { items, meta } = consolidate([item], interior, cfg);
    const block = items.find((i) => meta.has(i.id));
    expect(block).toBeDefined();
    expect(Number.isFinite(block!.canSupportWeightKg)).toBe(true);
    expect(block!.canSupportWeightKg).toBeGreaterThanOrEqual(0);
  });

  it("passes through groups below the consolidation threshold untouched", () => {
    const item = makeItem({ id: "small-order", quantity: 10 });
    const { items, meta } = consolidate([item], interior, cfg);
    expect(items).toEqual([item]);
    expect(meta.size).toBe(0);
  });

  it("passes through non-identical rows untouched even with high combined quantity", () => {
    const a = makeItem({ id: "row-a", weightKg: 10, quantity: 30 });
    const b = makeItem({ id: "row-b", weightKg: 12, quantity: 30 }); // different weight => not identical
    const { items, meta } = consolidate([a, b], interior, cfg);
    expect(items).toEqual([a, b]);
    expect(meta.size).toBe(0);
  });

  it("dimensionless rows pass through untouched", () => {
    const item = makeItem({ id: "no-dims", dimensions: null, quantity: 500 });
    const { items, meta } = consolidate([item], interior, cfg);
    expect(items).toEqual([item]);
    expect(meta.size).toBe(0);
  });

  it("respects maxBlockUnits — never emits a block bigger than the cap", () => {
    const item = makeItem({
      id: "sku-capped",
      dimensions: { l: 0.3, w: 0.3, h: 0.3 },
      weightKg: 1,
      canSupportWeightKg: 1000,
      maxStackPressureKpa: 1000,
      orientationLock: "none",
      quantity: 37_506,
    });
    const capped: ConsolidationConfig = { ...cfg, maxBlockUnits: 200 };
    const { items, meta } = consolidate([item], interior, capped);
    for (const out of items) {
      const bm = meta.get(out.id);
      if (bm) expect(bm.unitsPerBlock).toBeLessThanOrEqual(200);
    }
  });
});
