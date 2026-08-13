/**
 * Mixed-item box consolidation (standard-box.ts). Proves the two things that make
 * it safe AND useful: (1) a diverse huge order collapses to few placeable boxes,
 * and (2) a box's advertised crush caps are honest to the REAL placement-validator
 * — a load at capacity is accepted, just above is refused, and a fragile box bears
 * nothing. The box is opaque to the validator, so if these caps lie, the feature is
 * unsafe, not just imprecise — hence the validator (not a re-implementation) grades it.
 */
import { describe, it, expect } from "vitest";
import { boxLooseItems, type BoxConfig } from "@/lib/packing/standard-box";
import { validatePlacement, stackPressureKpa } from "@/lib/packing/placement-validator";
import type { Item, Placement, Dimensions } from "@/lib/packing/packing.types";
import { makeItem } from "./fixtures";

const G = 9.80665;

const CFG: BoxConfig = {
  enabled: true,
  footprintM: { l: 1.2, w: 1.0 },
  maxHeightM: 1.2,
  maxBoxWeightKg: 500,
  fillFraction: 0.85,
  minUnitsToBox: 100,
};

/** A small distinct SKU (each call a different id) that fits the box footprint. */
const smallSku = (i: number, over: Partial<Item> = {}): Item =>
  makeItem({ id: `sku-${i}`, name: `SKU ${i}`, dimensions: { l: 0.2, w: 0.2, h: 0.2 }, weightKg: 1, quantity: 1, ...over });

/** Turn a produced box Item into a floor Placement so we can stack a test load on it. */
const asFloorPlacement = (box: Item): Placement => ({
  itemId: box.id,
  position: { x: 0, y: 0, z: 0 },
  size: { x: box.dimensions!.l, y: box.dimensions!.w, z: box.dimensions!.h },
  fragile: box.fragility === "fragile",
  weightKg: box.weightKg,
  canSupportWeightKg: box.canSupportWeightKg,
  stackable: box.stackable,
  maxStackPressureKpa: box.maxStackPressureKpa,
  brittle: box.brittle,
});

/** A load box that fully covers the bearer's top face, resting on it (z = bearer height). */
const loadOnTop = (bearer: Item, weightKg: number): { candidate: Parameters<typeof validatePlacement>[0]; ctx: Parameters<typeof validatePlacement>[1] } => {
  const size: Dimensions = bearer.dimensions!;
  return {
    candidate: { position: { x: 0, y: 0, z: size.h }, size: { x: size.l, y: size.w, z: 0.3 }, weightKg, fragile: false },
    ctx: { others: [asFloorPlacement(bearer)], interior: { l: 3, w: 2.4, h: 3 }, toleranceM: 0.01 },
  };
};

describe("boxLooseItems — diverse-order reduction", () => {
  it("collapses thousands of distinct small units into a few placeable boxes", () => {
    // 400 distinct SKUs × 30 units = 12,000 loose placements — would trip the 2,000 cap.
    const items = Array.from({ length: 400 }, (_, i) => smallSku(i, { quantity: 30 }));
    const { items: out, meta } = boxLooseItems(items, CFG);

    const totalRealUnits = items.reduce((n, it) => n + it.quantity, 0);
    expect(totalRealUnits).toBe(12000);
    // Every output is a box; far fewer than the 12,000 raw units and under the 2,000 cap.
    expect(out.length).toBeLessThan(2000);
    expect(out.length).toBeGreaterThan(0);
    // No real units are lost — the boxes' unitsPerBlock sum back to the input total.
    const accounted = out.reduce((n, b) => n + (meta.get(b.id)?.unitsPerBlock ?? b.quantity), 0);
    expect(accounted).toBe(totalRealUnits);
    // A single 1.2×1.0×0.85 box floor holds ~25 of the 0.2×0.2 units → well under cap.
    expect(out.length).toBeLessThan(600);
  });

  it("leaves a small order untouched (below minUnitsToBox — byte-identical)", () => {
    const items = Array.from({ length: 10 }, (_, i) => smallSku(i, { quantity: 5 })); // 50 units < 100
    const { items: out, meta } = boxLooseItems(items, CFG);
    expect(out).toEqual(items);
    expect(meta.size).toBe(0);
  });

  it("passes through items too big for a box (no boxing, no loss)", () => {
    const big = makeItem({ id: "big", dimensions: { l: 2.0, w: 1.5, h: 1.8 }, quantity: 200 });
    const { items: out } = boxLooseItems([big], CFG);
    expect(out).toEqual([big]); // 200 units but each too big to box → untouched
  });
});

describe("boxLooseItems — crush safety is honest to the real validator", () => {
  it("advertises the weakest content's caps; a load AT capacity is accepted, just above is refused", () => {
    // All-sturdy content: min canSupport = 150 kg, min pressure = 40 kPa.
    const items = Array.from({ length: 200 }, (_, i) =>
      smallSku(i, { canSupportWeightKg: i === 0 ? 150 : 300, maxStackPressureKpa: i === 0 ? 40 : 90 }),
    );
    const { items: out } = boxLooseItems(items, CFG);
    const box = out[0]!;
    expect(box.canSupportWeightKg).toBe(150); // the weakest unit governs
    expect(box.maxStackPressureKpa).toBe(40);

    // Weight bound is the binding one here (pressure of 150 kg over 1.2 m² is tiny).
    const atCap = loadOnTop(box, 150);
    expect(validatePlacement(atCap.candidate, atCap.ctx).ok).toBe(true);
    const overCap = loadOnTop(box, 200);
    expect(validatePlacement(overCap.candidate, overCap.ctx).ok).toBe(false);
  });

  it("refuses a load that exceeds the pressure ceiling even when under the weight ceiling", () => {
    // Give a high weight ceiling but a low pressure ceiling so PRESSURE binds first.
    const items = Array.from({ length: 200 }, (_, i) =>
      smallSku(i, { canSupportWeightKg: 5000, maxStackPressureKpa: 5 }),
    );
    const box = boxLooseItems(items, CFG).items[0]!;
    expect(box.maxStackPressureKpa).toBe(5);
    // Pressure ceiling 5 kPa over the 1.2 m² top → max safe load = 5·1000·1.2/G ≈ 612 kg.
    const maxByPressure = (5 * 1000 * 1.2) / G;
    const under = loadOnTop(box, maxByPressure - 20);
    const over = loadOnTop(box, maxByPressure + 50);
    expect(stackPressureKpa(maxByPressure + 50, 1.2)).toBeGreaterThan(5); // sanity
    expect(validatePlacement(under.candidate, under.ctx).ok).toBe(true);
    expect(validatePlacement(over.candidate, over.ctx).ok).toBe(false);
  });

  it("boxes fragile/brittle content SEPARATELY and refuses any load on a fragile box", () => {
    const sturdy = Array.from({ length: 150 }, (_, i) => smallSku(i));
    const fragile = Array.from({ length: 150 }, (_, i) => smallSku(1000 + i, { fragility: "fragile", canSupportWeightKg: 300 }));
    const { items: out } = boxLooseItems([...sturdy, ...fragile], CFG);

    const fragileBoxes = out.filter((b) => b.fragility === "fragile");
    const sturdyBoxes = out.filter((b) => b.fragility === "standard");
    expect(fragileBoxes.length).toBeGreaterThan(0);
    expect(sturdyBoxes.length).toBeGreaterThan(0);

    const fbox = fragileBoxes[0]!;
    expect(fbox.canSupportWeightKg).toBe(0); // nothing on top, regardless of the item's own 300 kg figure
    expect(fbox.maxStackPressureKpa).toBe(0);
    const anyLoad = loadOnTop(fbox, 1);
    expect(validatePlacement(anyLoad.candidate, anyLoad.ctx).ok).toBe(false);
  });

  it("brittle items are treated as fragile for boxing (own box, no top load)", () => {
    const items = Array.from({ length: 120 }, (_, i) => smallSku(i, { brittle: true, fragility: "standard", canSupportWeightKg: 200 }));
    const box = boxLooseItems(items, CFG).items[0]!;
    expect(box.fragility).toBe("fragile");
    expect(box.canSupportWeightKg).toBe(0);
  });
});
