/**
 * GOLDEN MASTER for the packing geometry. Snapshots the FULL placement output of
 * the heuristic packer and the fleet allocator across a spread of scenarios
 * (floor packs, composite vertical stacks, fragile/brittle gating, orientation
 * locks, large mixed cargo, and a huge single-SKU line). Captured on the array-
 * scan validator BEFORE the footprint spatial index was added.
 *
 * The index is a pure speed optimisation: it must narrow WHICH placed boxes each
 * overlap/support check looks at without changing the verdict, so every placement
 * — position, size, orientation, which van, utilisation, cost — must stay byte-
 * identical. This test is the proof: if the index alters any decision, the
 * snapshot diff fails. Do NOT `--update` it to make a red run pass; a diff here
 * means the optimisation changed a quote, which is a bug, not a new baseline.
 */
import { describe, it, expect } from "vitest";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { allocateFleet } from "@/lib/packing/fleet-allocator";
import type { Item, PackingResult, Van } from "@/lib/packing/packing.types";
import type { FleetPlan } from "@/lib/packing/fleet-allocator";
import { makeItem, makeVan, makeLargeCargo } from "./fixtures";

const TOL = 0.005;
const packer = new HeuristicPacker({ toleranceM: TOL });

/** Stable, diff-friendly projection of one packed van — every geometric decision. */
function projectResult(r: PackingResult) {
  return {
    vanId: r.van.id,
    utilization: r.utilization,
    placements: r.placements.map((p) => ({
      itemId: p.itemId,
      pos: [p.position.x, p.position.y, p.position.z],
      size: [p.size.x, p.size.y, p.size.z],
      rot: p.rotationIndex,
    })),
    unplaced: r.unplaced.map((u) => ({ id: u.id, qty: Math.max(1, u.quantity) })),
    reasons: r.reasons,
  };
}

function projectPlan(plan: FleetPlan) {
  return {
    vans: plan.vans.map(projectResult),
    unplaced: plan.unplaced.map((u) => ({ id: u.id, qty: Math.max(1, u.quantity) })),
    reasons: plan.reasons,
    packableUnits: plan.packableUnits,
    placedUnits: plan.placedUnits,
    fitsInSingleVan: plan.fitsInSingleVan,
    totalPerMileRate: plan.totalPerMileRate,
  };
}

const bigVan = makeVan({ id: "big", interior: { l: 4.0, w: 2.0, h: 2.2 }, maxPayloadKg: 2000 });
const midVan = makeVan({ id: "mid", interior: { l: 2.6, w: 1.6, h: 1.8 }, maxPayloadKg: 1200, perMileRate: 1.1 });
const smallVan = makeVan({ id: "small", interior: { l: 1.6, w: 1.2, h: 1.4 }, maxPayloadKg: 700, perMileRate: 0.8 });

describe("packing golden master — single-van packs", () => {
  it("mixed floor + stackable boxes", () => {
    const items: Item[] = [
      makeItem({ id: "a", dimensions: { l: 0.8, w: 0.6, h: 0.5 }, weightKg: 30, canSupportWeightKg: 200, maxStackPressureKpa: 120 }),
      makeItem({ id: "b", dimensions: { l: 0.8, w: 0.6, h: 0.5 }, weightKg: 25, canSupportWeightKg: 200, maxStackPressureKpa: 120 }),
      makeItem({ id: "c", dimensions: { l: 0.4, w: 0.4, h: 0.4 }, weightKg: 8, quantity: 6 }),
      makeItem({ id: "d", dimensions: { l: 1.2, w: 0.5, h: 0.3 }, weightKg: 15, quantity: 3 }),
    ];
    expect(projectResult(packer.pack(items, bigVan))).toMatchSnapshot();
  });

  it("composite vertical stacking on wide bases", () => {
    const items: Item[] = [
      makeItem({ id: "base", dimensions: { l: 1.2, w: 1.0, h: 0.4 }, weightKg: 60, canSupportWeightKg: 500, maxStackPressureKpa: 300, quantity: 2 }),
      makeItem({ id: "top", dimensions: { l: 0.5, w: 0.5, h: 0.5 }, weightKg: 10, quantity: 10 }),
    ];
    expect(projectResult(packer.pack(items, midVan))).toMatchSnapshot();
  });

  it("fragile and brittle items are gated to the end / floor", () => {
    const items: Item[] = [
      makeItem({ id: "sturdy", dimensions: { l: 0.7, w: 0.7, h: 0.5 }, weightKg: 40, canSupportWeightKg: 300, maxStackPressureKpa: 200, quantity: 4 }),
      makeItem({ id: "glass", dimensions: { l: 0.6, w: 0.1, h: 0.9 }, weightKg: 12, brittle: true, fragility: "fragile", stackable: false, quantity: 2 }),
      makeItem({ id: "fragile-box", dimensions: { l: 0.5, w: 0.5, h: 0.4 }, weightKg: 6, fragility: "fragile", quantity: 3 }),
    ];
    expect(projectResult(packer.pack(items, midVan))).toMatchSnapshot();
  });

  it("orientation-locked items keep their allowed rotations", () => {
    const items: Item[] = [
      makeItem({ id: "upright", dimensions: { l: 0.9, w: 0.4, h: 1.2 }, weightKg: 20, orientationLock: "fixed", quantity: 3 }),
      makeItem({ id: "flat-ok", dimensions: { l: 0.7, w: 0.5, h: 0.3 }, weightKg: 10, orientationLock: "partial", quantity: 5 }),
    ];
    expect(projectResult(packer.pack(items, midVan))).toMatchSnapshot();
  });

  it("large mixed cargo (200) into one big van", () => {
    expect(projectResult(packer.pack(makeLargeCargo(200), bigVan))).toMatchSnapshot();
  });

  it("huge single-SKU line (400 units) overflowing a small van", () => {
    const items = [makeItem({ id: "sku", dimensions: { l: 0.35, w: 0.3, h: 0.3 }, weightKg: 4, quantity: 400 })];
    expect(projectResult(packer.pack(items, smallVan))).toMatchSnapshot();
  });
});

describe("packing golden master — fleet allocation", () => {
  const fleet: Van[] = [bigVan, midVan, smallVan];

  it("small job that fits one van", () => {
    const items = [makeItem({ id: "x", dimensions: { l: 0.5, w: 0.5, h: 0.5 }, weightKg: 10, quantity: 8 })];
    expect(projectPlan(allocateFleet(items, fleet, packer, { toleranceM: TOL }))).toMatchSnapshot();
  });

  // These allocation snapshots pack 100+ items across a 3-van fleet; the work is
  // deterministic but wall-clock heavy, so under full-suite parallel load they can
  // exceed Vitest's 5s default. The extended timeout guards against a flaky
  // timeout — it does NOT relax the snapshot verdict.
  it("overflow job spread across multiple vans", () => {
    const items = [
      makeItem({ id: "p", dimensions: { l: 0.6, w: 0.5, h: 0.5 }, weightKg: 18, quantity: 60 }),
      makeItem({ id: "q", dimensions: { l: 0.4, w: 0.4, h: 0.6 }, weightKg: 9, quantity: 40 }),
    ];
    expect(projectPlan(allocateFleet(items, fleet, packer, { toleranceM: TOL }))).toMatchSnapshot();
  }, 20000);

  it("mixed cargo with oversized + dimensionless flagged unplaced", () => {
    expect(projectPlan(allocateFleet(makeLargeCargo(120), fleet, packer, { toleranceM: TOL }))).toMatchSnapshot();
  }, 20000);
});
