import { describe, it, expect } from "vitest";
import { allocateFleet } from "@/lib/packing/fleet-allocator";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { makeItem, makeVan, makeLargeCargo, totalQuantity } from "./fixtures";

const packer = new HeuristicPacker({ toleranceM: 0.005 });
const opts = { toleranceM: 0.005 };

describe("allocateFleet", () => {
  it("uses a single van when everything fits", () => {
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
    const vans = [makeVan({ id: "v", perMileRate: 1.5 })];
    const plan = allocateFleet(items, vans, packer, opts);

    expect(plan.vans).toHaveLength(1);
    expect(plan.fitsInSingleVan).toBe(true);
    expect(plan.unplaced).toHaveLength(0);
    expect(plan.placedUnits).toBe(2);
  });

  it("spreads overflow across multiple vans until everything is carried", () => {
    // A tiny van that holds exactly one box; three boxes ⇒ three vans.
    const vans = [makeVan({ id: "tiny", interior: { l: 0.7, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 1 })];
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })];
    const plan = allocateFleet(items, vans, packer, opts);

    expect(plan.vans.length).toBeGreaterThanOrEqual(3);
    expect(plan.placedUnits).toBe(3);
    expect(plan.unplaced).toHaveLength(0);
    expect(plan.fitsInSingleVan).toBe(false);
  });

  it("chooses the cheapest van combination, not the fewest vans", () => {
    // Two boxes. One expensive van holds both (rate 3); a cheap van holds one
    // (rate 1). Cheapest = two cheap vans (2) beats one expensive van (3).
    const cheap = makeVan({ id: "cheap", interior: { l: 0.7, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 1 });
    const big = makeVan({ id: "big", interior: { l: 1.3, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 3 });
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];

    const plan = allocateFleet(items, [cheap, big], packer, opts);

    expect(plan.totalPerMileRate).toBe(2);
    expect(plan.vans).toHaveLength(2);
    expect(plan.vans.every((r) => r.van.id === "cheap")).toBe(true);
    expect(plan.unplaced).toHaveLength(0);
  });

  it("flags dimensionless items as unplaced without searching over them", () => {
    const items = [makeItem({ id: "ok" }), makeItem({ id: "bad", dimensions: null })];
    const vans = [makeVan({ id: "v", perMileRate: 1 })];
    const plan = allocateFleet(items, vans, packer, opts);

    expect(plan.unplaced.map((i) => i.id)).toContain("bad");
    expect(plan.reasons.bad).toMatch(/dimensions/);
    expect(plan.placedUnits).toBe(1);
  });

  it("prefers fewer vans when two fleets cost the same", () => {
    // One box per cheap van (rate 1); a big van holds both (rate 2, no fuel ⇒ exact).
    // Two cheap vans = 2 and one big van = 2: a tie. Tie-break ⇒ the single big van.
    const cheap = makeVan({ id: "cheap", interior: { l: 0.7, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 1 });
    const big = makeVan({ id: "big", interior: { l: 1.3, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 2 });
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];

    const plan = allocateFleet(items, [cheap, big], packer, opts);

    expect(plan.totalPerMileRate).toBeCloseTo(2, 5);
    expect(plan.vans).toHaveLength(1);
    expect(plan.vans[0]!.van.id).toBe("big");
  });

  it("carries a large mixed cargo list with no silent drops", () => {
    const items = makeLargeCargo(200);
    // Generous availability so van capacity never binds — lets us prove every
    // packable unit is actually placed, not merely accounted for.
    const vans = [
      makeVan({ id: "s", interior: { l: 2.05, w: 1.58, h: 1.23 }, maxPayloadKg: 15600, perMileRate: 0.98, quantity: 20 }),
      makeVan({ id: "m", interior: { l: 2.512, w: 1.636, h: 1.397 }, maxPayloadKg: 25000, perMileRate: 1.28, quantity: 20 }),
      makeVan({ id: "l", interior: { l: 3.705, w: 1.87, h: 1.932 }, maxPayloadKg: 30000, perMileRate: 1.8, quantity: 20 }),
    ];

    const start = Date.now();
    const plan = allocateFleet(items, vans, packer, opts);
    const elapsedMs = Date.now() - start;

    // Always-true conservation: every unit is either packable or pre-filtered to
    // unplaced — nothing vanishes from the accounting.
    const unplacedQty = totalQuantity(plan.unplaced);
    expect(plan.packableUnits + unplacedQty).toBe(totalQuantity(items));
    // With capacity to spare, every packable unit is genuinely carried.
    expect(plan.placedUnits).toBe(plan.packableUnits);

    // The pre-filtered unplaced carry plain-English reasons.
    for (const item of plan.unplaced) {
      expect(plan.reasons[item.id]).toBeTruthy();
    }

    // Generous bound — asserts it terminates (exact search + greedy fallback), not perf.
    expect(elapsedMs).toBeLessThan(30_000);
  }, 30_000);

  it("surfaces the shortfall as unplaced when fleet availability runs out", () => {
    // Tiny van holds exactly one box; only one van is available (quantity: 1), but
    // three boxes need carrying — the fleet can only ever take one.
    const vans = [makeVan({ id: "tiny", interior: { l: 0.7, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 1, quantity: 1 })];
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })];
    const plan = allocateFleet(items, vans, packer, opts);

    expect(plan.placedUnits).toBeLessThan(plan.packableUnits);
    const shortfall = totalQuantity(plan.unplaced);
    expect(plan.placedUnits + shortfall).toBe(plan.packableUnits);
    expect(shortfall).toBeGreaterThan(0);
    expect(Object.values(plan.reasons)).toContain(
      "fleet van availability exhausted — add vans or split the order",
    );
  });

  it("flags items larger than every van as unplaced", () => {
    const items = [makeItem({ id: "huge", dimensions: { l: 9.0, w: 5.0, h: 5.0 } })];
    const vans = [makeVan({ id: "v", interior: { l: 3.0, w: 1.8, h: 1.9 }, perMileRate: 1 })];
    const plan = allocateFleet(items, vans, packer, opts);

    expect(plan.vans).toHaveLength(0);
    expect(plan.unplaced.map((i) => i.id)).toContain("huge");
    expect(plan.reasons.huge).toMatch(/exceeds largest van interior/);
  });
});

describe("unplaced reasons never contradict the decision", () => {
  // Regression: a reason must be derived from the SAME per-van logic that rejected
  // the item — it must never claim "too heavy" for an item lighter than the vans it
  // fits, nor blame dimensions for one that fits. Assertions read ground truth off
  // the vans built here — no hardcoded strings or payload numbers.

  it("blames dimensions, not weight, for a light load no single van can hold", () => {
    // A phantom van built from the longest-of-each dimension across the fleet would
    // "fit" this item, but no ONE van does: the long van is too narrow, the wide van
    // too short. The item is trivially light, so weight is provably not the blocker.
    const longNarrow = makeVan({ id: "long", interior: { l: 6.0, w: 1.0, h: 1.0 }, maxPayloadKg: 20_000 });
    const shortWide = makeVan({ id: "wide", interior: { l: 1.0, w: 2.5, h: 3.0 }, maxPayloadKg: 20_000 });
    const heaviestPayload = Math.max(longNarrow.maxPayloadKg, shortWide.maxPayloadKg);

    const item = makeItem({
      id: "abnormal",
      dimensions: { l: 5.0, w: 2.4, h: 2.9 }, // fits neither van as one box
      weightKg: 100, // far under either payload — weight cannot be the reason
      orientationLock: "fixed", // no rotation rescues it
    });
    expect(item.weightKg).toBeLessThan(heaviestPayload); // guard: truly not too heavy

    const plan = allocateFleet([item], [longNarrow, shortWide], packer, opts);

    expect(plan.unplaced.map((i) => i.id)).toContain("abnormal");
    expect(plan.reasons.abnormal).toMatch(/interior|dimension/i);
    expect(plan.reasons.abnormal).not.toMatch(/heav/i); // the lie must not reappear
  });

  it("blames weight only when the item genuinely fits a van's box but is too heavy", () => {
    // Roomy van the item slots into easily, but every van's payload is below its
    // weight — weight is the real, sole blocker.
    const roomy = makeVan({ id: "roomy", interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1_000 });
    const item = makeItem({ id: "dense", dimensions: { l: 0.6, w: 0.6, h: 0.7 }, weightKg: 5_000 });
    expect(item.weightKg).toBeGreaterThan(roomy.maxPayloadKg); // guard: truly too heavy

    const plan = allocateFleet([item], [roomy], packer, opts);

    expect(plan.unplaced.map((i) => i.id)).toContain("dense");
    expect(plan.reasons.dense).toMatch(/heav/i);
  });
});
