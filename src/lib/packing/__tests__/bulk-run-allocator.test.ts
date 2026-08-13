import { describe, it, expect } from "vitest";
import { tryBulkAllocate } from "@/lib/packing/bulk-run-allocator";
import { allocateFleet, defaultPackCap, type FleetPlan } from "@/lib/packing/fleet-allocator";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { makeItem, makeVan } from "./fixtures";

const packer = new HeuristicPacker({ toleranceM: 0.005 });
const opts = { toleranceM: 0.005, minDominantUnits: 500 };

/** Sorted van-id multiset — lets us compare two fleets van-for-van, order-independent. */
function vanIds(plan: FleetPlan): string[] {
  return plan.vans.map((r) => r.van.id).sort();
}

/** Blocks one van holds for `item`, using the exact slice the greedy allocator packs. */
function perVanCapacity(item: ReturnType<typeof makeItem>, van: ReturnType<typeof makeVan>): number {
  return packer.pack([{ ...item, quantity: defaultPackCap() }], van).placements.length;
}

describe("tryBulkAllocate", () => {
  it("(a) matches allocateFleet exactly on a single-SKU order — one van type", () => {
    const item = makeItem({ id: "bulk", quantity: 800 });
    const vans = [makeVan({ id: "v", perMileRate: 1.5, quantity: 200 })];

    const bulk = tryBulkAllocate([item], vans, packer, opts);
    const exact = allocateFleet([item], vans, packer, { toleranceM: 0.005 });

    expect(bulk).not.toBeNull();
    expect(bulk!.vans.length).toBe(exact.vans.length);
    expect(vanIds(bulk!)).toEqual(vanIds(exact));
    expect(bulk!.placedUnits).toBe(exact.placedUnits);
    expect(bulk!.totalPerMileRate).toBeCloseTo(exact.totalPerMileRate, 5);
    expect(bulk!.unplaced).toHaveLength(0);
    expect(bulk!.placedUnits).toBe(800);
  });

  it("(a) matches allocateFleet exactly on a single-SKU order — cost-based van choice", () => {
    // Two van types at different rates/sizes: both paths must pick the same fleet.
    const cheap = makeVan({ id: "cheap", interior: { l: 0.7, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 1, quantity: 2000 });
    const big = makeVan({ id: "big", interior: { l: 1.3, w: 0.7, h: 0.8 }, maxPayloadKg: 1000, perMileRate: 3, quantity: 2000 });
    const item = makeItem({ id: "bulk", dimensions: { l: 0.6, w: 0.6, h: 0.7 }, quantity: 700 });

    const bulk = tryBulkAllocate([item], [cheap, big], packer, opts);
    const exact = allocateFleet([item], [cheap, big], packer, { toleranceM: 0.005 });

    expect(bulk).not.toBeNull();
    expect(vanIds(bulk!)).toEqual(vanIds(exact));
    expect(bulk!.totalPerMileRate).toBeCloseTo(exact.totalPerMileRate, 5);
    expect(bulk!.placedUnits).toBe(exact.placedUnits);
  });

  it("(b) defers (null) when there are two distinct high-quantity SKUs", () => {
    const a = makeItem({ id: "a", quantity: 800 });
    const b = makeItem({ id: "b", quantity: 800 });
    const vans = [makeVan({ id: "v", quantity: 2000 })];

    expect(tryBulkAllocate([a, b], vans, packer, opts)).toBeNull();
  });

  it("(b) defers (null) below the dominant-units threshold (ordinary order)", () => {
    const item = makeItem({ id: "small", quantity: 300 }); // < minDominantUnits (500)
    const vans = [makeVan({ id: "v", quantity: 2000 })];

    expect(tryBulkAllocate([item], vans, packer, opts)).toBeNull();
  });

  it("(c) defers (null) when van availability can't cover the full vans", () => {
    const item = makeItem({ id: "bulk", quantity: 800 });
    const k = perVanCapacity(item, makeVan({ id: "v" }));
    const needed = Math.floor(800 / k);
    // Give the fleet fewer than the full vans required ⇒ must defer to the exact allocator.
    const vans = [makeVan({ id: "v", quantity: Math.max(1, needed - 1) })];

    expect(tryBulkAllocate([item], vans, packer, opts)).toBeNull();
  });

  it("(d) allocates a 15,000-block single-SKU order fast and with the correct van count", () => {
    const item = makeItem({ id: "bulk", quantity: 15_000 });
    const van = makeVan({ id: "v", quantity: 1_000_000 });
    const k = perVanCapacity(item, van);
    const expectedVans = Math.ceil(15_000 / k);

    const start = Date.now();
    const bulk = tryBulkAllocate([item], [van], packer, opts);
    const elapsedMs = Date.now() - start;

    expect(bulk).not.toBeNull();
    expect(bulk!.placedUnits).toBe(15_000); // every block carried, nothing dropped
    expect(bulk!.unplaced).toHaveLength(0);
    expect(bulk!.vans.length).toBe(expectedVans);
    expect(bulk!.packableUnits).toBe(15_000);
    // A per-block scan of 15k would take tens of seconds; the multiply is ~two packs.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("(e) places the block remainder plus a small leftover SKU in the tail, conserving units", () => {
    const dominant = makeItem({ id: "main", quantity: 1000 });
    const other = makeItem({ id: "rem", dimensions: { l: 0.5, w: 0.5, h: 0.5 }, quantity: 1 });
    const vans = [makeVan({ id: "v", quantity: 1_000_000 })];

    const bulk = tryBulkAllocate([dominant, other], vans, packer, opts);

    expect(bulk).not.toBeNull();
    expect(bulk!.packableUnits).toBe(1001);
    expect(bulk!.placedUnits).toBe(1001); // dominant remainder + the leftover both carried
    expect(bulk!.unplaced).toHaveLength(0);
  });

  it("(e) surfaces genuinely uncarriable units as unplaced (conservation holds)", () => {
    // Availability exactly covers the full vans but leaves NO van for the remainder,
    // and the only van type can't be reused ⇒ the remainder must surface as unplaced,
    // never silently vanish from the quote.
    const item = makeItem({ id: "bulk", quantity: 820 });
    const k = perVanCapacity(item, makeVan({ id: "v" }));
    const fullVans = Math.floor(820 / k);
    const rem = 820 - fullVans * k;
    // Only run the assertion when there is a genuine remainder to strand.
    if (rem === 0) return;
    const vans = [makeVan({ id: "v", quantity: fullVans })]; // no spare van for the remainder

    const bulk = tryBulkAllocate([item], vans, packer, opts);
    expect(bulk).not.toBeNull();
    const unplacedUnits = bulk!.unplaced.reduce((n, i) => n + Math.max(1, i.quantity), 0);
    // Placed + unplaced must equal the whole order — the invariant the service enforces.
    expect(bulk!.placedUnits + unplacedUnits).toBe(820);
    expect(unplacedUnits).toBe(rem);
  });
});
