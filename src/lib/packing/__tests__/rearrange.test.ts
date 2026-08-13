/**
 * REARRANGE — the operator's "tidy this van up again" button.
 *
 * It re-runs the real packer over a hand-edited van, so the three things it must NOT do are the
 * three things a naive re-pack WOULD do: quote an overweight van, lie down an item that must stay
 * upright, and shuffle a multi-drop load out of its door-first drop order.
 */
import { describe, it, expect } from "vitest";
import { rearrangeVan, isMultiStop, vansNeededFor, suggestVansFor } from "@/lib/packing/rearrange";
import type { Item, Van } from "@/lib/packing/packing.types";

const van = (maxPayloadKg: number): Van => ({
  id: "v1",
  label: "Test van",
  interior: { l: 4, w: 2, h: 2 },
  maxPayloadKg,
  perMileRate: 1,
});

const item = (over: Partial<Item> & Pick<Item, "id">): Item => ({
  name: over.id,
  dimensions: { l: 1, w: 1, h: 1 },
  weightKg: 100,
  quantity: 1,
  fragility: "standard",
  category: "accessory",
  stackable: true,
  canSupportWeightKg: 1000,
  orientationLock: "none",
  maxStackPressureKpa: 500,
  material: null,
  durabilityTier: "medium",
  durabilityConfident: true,
  brittle: false,
  deformable: false,
  ...over,
});

describe("rearrangeVan — the van's weight limit is a real limit", () => {
  it("refuses the units that would make the van overweight, and says why", () => {
    // 10 × 500 kg = 5,000 kg of cargo offered to a van rated for 2,000 kg. Space is not the
    // constraint (they all fit easily) — payload is. A re-pack that ignores it would hand the
    // operator a load plan for an illegal vehicle.
    const items = [item({ id: "heavy", weightKg: 500, quantity: 10 })];
    const result = rearrangeVan(items, van(2000), { toleranceM: 0.005 });

    const carriedKg = result.placements.reduce((n, p) => n + p.weightKg, 0);
    expect(carriedKg).toBeLessThanOrEqual(2000);
    expect(result.placements).toHaveLength(4); // 4 × 500 kg = 2,000 kg exactly
    // The other 6 come back out, named, with the packer's own reason — never dropped silently.
    expect(result.unplaced.reduce((n, u) => n + u.quantity, 0)).toBe(6);
    expect(result.reasons.heavy).toMatch(/heavy|payload/i);
  });

  it("an ordinary load is unaffected by the ceiling", () => {
    const items = [item({ id: "light", weightKg: 10, quantity: 6 })];
    const result = rearrangeVan(items, van(2000), { toleranceM: 0.005 });
    expect(result.placements).toHaveLength(6);
    expect(result.unplaced).toHaveLength(0);
  });
});

describe("rearrangeVan — an item's own limits survive the re-pack", () => {
  it("never lays down an upright-locked item to make it fit", () => {
    // "partial" = upright, any facing (orientation.ts) — h must stay on the vertical axis. The
    // packer may turn and reposition it, but tipping it over is exactly the "optimisation" that
    // breaks the cargo. A non-square base, so a mere turn is visible but a tip-over is unmistakable.
    const items = [item({ id: "upright", dimensions: { l: 1.2, w: 0.8, h: 1.8 }, orientationLock: "partial", quantity: 2 })];
    const result = rearrangeVan(items, van(5000), { toleranceM: 0.005 });
    expect(result.placements).toHaveLength(2);
    expect(result.placements.every((p) => p.size.z === 1.8)).toBe(true);
  });
});

describe("rearrangeVan — a multi-drop van keeps its drop order", () => {
  it("packs stop 1 nearer the doors than stop 2 (the ZonedPacker rule)", () => {
    // The regression this guards: PackedItem used to lose `stopIndex` on the way to the browser, so
    // a client-side re-pack dropped every item into one band and silently destroyed the door-first
    // unload order the server had packed.
    const items = [
      item({ id: "stop2", stopIndex: 1, quantity: 3 }),
      item({ id: "stop1", stopIndex: 0, quantity: 3 }),
    ];
    expect(isMultiStop(items)).toBe(true);
    const result = rearrangeVan(items, van(5000), { toleranceM: 0.005 });

    const deepestOfStop1 = Math.max(...result.placements.filter((p) => p.itemId === "stop1").map((p) => p.position.x + p.size.x));
    const nearestOfStop2 = Math.min(...result.placements.filter((p) => p.itemId === "stop2").map((p) => p.position.x));
    // x = 0 is the doors. Every stop-1 box must sit in front of every stop-2 box, so the first drop
    // comes off without unloading the second.
    expect(deepestOfStop1).toBeLessThanOrEqual(nearestOfStop2);
  });

  it("a single-drop load is packed by the bare packer — no banding, no behaviour change", () => {
    const items = [item({ id: "a", quantity: 2 })];
    expect(isMultiStop(items)).toBe(false);
    expect(rearrangeVan(items, van(5000), { toleranceM: 0.005 }).placements).toHaveLength(2);
  });
});

/**
 * A big job is a BIG JOB, not a bad one. When a rearrange leaves cargo over, the answer the operator
 * needs is "add N of van X", proved by really packing it — not a bare "12 units didn't fit".
 */
describe("suggestVansFor — what would carry the leftovers", () => {
  const opts = { toleranceM: 0.005 };
  const small: Van = { id: "s", label: "Small", interior: { l: 2, w: 2, h: 2 }, maxPayloadKg: 400, perMileRate: 1 };
  const big: Van = { id: "b", label: "Big", interior: { l: 8, w: 2, h: 2 }, maxPayloadKg: 4000, perMileRate: 2 };

  it("counts the vans by packing them, so a weight-bound load isn't under-counted", () => {
    // 8 × 100 kg cubes. They'd all FIT in one Small by volume (8 m³ of cargo, 8 m³ van) but 800 kg is
    // double its 400 kg payload — a naive volume estimate would say "1 van" and be wrong by half.
    const items = [item({ id: "cube", weightKg: 100, quantity: 8 })];
    expect(vansNeededFor(items, small, opts)).toBe(2);
    expect(vansNeededFor(items, big, opts)).toBe(1);
    // Fewest vehicles wins.
    expect(suggestVansFor(items, [small, big], opts)).toEqual({ van: big, vansNeeded: 1 });
  });

  it("prefers the SMALLER van when both need the same number — never over-sell a vehicle", () => {
    const items = [item({ id: "cube", weightKg: 10, quantity: 2 })];
    expect(suggestVansFor(items, [big, small], opts)).toEqual({ van: small, vansNeeded: 1 });
  });

  it("offers nothing when no van in the fleet can carry the cargo — an honest 'no', not a wrong yes", () => {
    // A 3 m box cannot go in a 2 m van in ANY orientation. More vans would not help, so the operator
    // must be told that plainly rather than sent to Add-van on a fool's errand.
    const items = [item({ id: "monolith", dimensions: { l: 3, w: 1, h: 1 }, quantity: 1 })];
    expect(vansNeededFor(items, small, opts)).toBeNull();
    expect(suggestVansFor(items, [small], opts)).toBeNull();
  });
});
