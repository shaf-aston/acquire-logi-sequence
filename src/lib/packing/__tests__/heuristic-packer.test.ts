/** S3.6 / S3.7 — packing engine + fragility/support constraint layer. */
import { describe, it, expect } from "vitest";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import type { Placement } from "@/lib/packing/packing.types";
import { makeItem, makeVan } from "./fixtures";

const packer = new HeuristicPacker({ toleranceM: 0.005 });

/** Pairwise strict-overlap check (touching faces allowed). */
function anyOverlap(ps: Placement[]): boolean {
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i]!;
      const b = ps[j]!;
      const o =
        a.position.x < b.position.x + b.size.x && b.position.x < a.position.x + a.size.x &&
        a.position.y < b.position.y + b.size.y && b.position.y < a.position.y + a.size.y &&
        a.position.z < b.position.z + b.size.z && b.position.z < a.position.z + a.size.z;
      if (o) return true;
    }
  }
  return false;
}

describe("HeuristicPacker — basics", () => {
  it("places everything, never overlaps, reports sane utilization", () => {
    const van = makeVan();
    const items = Array.from({ length: 6 }, (_, i) =>
      makeItem({ id: `b${i}`, weightKg: 20 }),
    );
    const r = packer.pack(items, van);

    expect(r.placements).toHaveLength(6);
    expect(r.unplaced).toHaveLength(0);
    expect(anyOverlap(r.placements)).toBe(false);
    expect(r.utilization).toBeGreaterThan(0);
    expect(r.utilization).toBeLessThanOrEqual(1);
  });

  it("is deterministic — identical input yields identical placements", () => {
    const van = makeVan();
    const items = Array.from({ length: 8 }, (_, i) => makeItem({ id: `b${i}`, weightKg: 15 }));
    const a = packer.pack(items, van);
    const b = packer.pack(items, van);
    expect(b.placements).toEqual(a.placements);
  });
});

describe("HeuristicPacker — edge cases", () => {
  it("flags an item larger than the interior", () => {
    const van = makeVan({ interior: { l: 1.0, w: 1.0, h: 1.0 } });
    const big = makeItem({ id: "big", dimensions: { l: 4.0, w: 0.9, h: 0.9 } });
    const r = packer.pack([big], van);
    expect(r.placements).toHaveLength(0);
    expect(r.unplaced).toHaveLength(1);
    expect(r.reasons.big).toMatch(/interior/i);
  });

  it("fails on payload when volume would otherwise fit", () => {
    const van = makeVan({ maxPayloadKg: 50 });
    const heavy = makeItem({ id: "heavy", weightKg: 500 });
    const r = packer.pack([heavy], van);
    expect(r.placements).toHaveLength(0);
    expect(r.reasons.heavy).toMatch(/payload/i);
  });

  it("flags dimensionless items as unplaced without guessing", () => {
    const van = makeVan();
    const noDims = makeItem({ id: "nd", dimensions: null });
    const r = packer.pack([noDims], van);
    expect(r.placements).toHaveLength(0);
    expect(r.reasons.nd).toMatch(/dimension/i);
  });

  it("flags an orientation-fixed item too tall to stand and barred from tipping", () => {
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 } });
    const tooTall = makeItem({
      id: "tall",
      category: "tall-unit",
      dimensions: { l: 0.6, w: 0.6, h: 2.5 },
      orientationLock: "fixed",
    });
    const r = packer.pack([tooTall], van);
    expect(r.placements).toHaveLength(0);
    expect(r.reasons.tall).toMatch(/interior/i);
  });
});

describe("HeuristicPacker — pallet stacking (regression: many identical half-empty box trucks)", () => {
  // Reproduces the real scenario: a 7.5t Box Truck interior (config/vans.json)
  // loaded with standard UK pallets (config/column-map.json palletDefaults).
  const truck = makeVan({ interior: { l: 6.0, w: 2.4, h: 2.4 }, maxPayloadKg: 56000 });
  const pallets = (canSupportWeightKg: number) =>
    Array.from({ length: 20 }, (_, i) =>
      makeItem({
        id: `pallet-${i}`,
        dimensions: { l: 1.2, w: 1.0, h: 1.2 },
        weightKg: 400,
        canSupportWeightKg,
        maxStackPressureKpa: 150,
        orientationLock: "fixed",
      }),
    );

  it("a zero stacking ceiling traps pallets in a single floor layer (the bug being guarded against)", () => {
    const r = packer.pack(pallets(0), truck);
    expect(r.placements).toHaveLength(10); // 5x2 floor grid; the top ~half of the van's height goes unused
  });

  it("a realistic pallet ceiling lets a second layer stack, roughly doubling what one truck carries", () => {
    const r = packer.pack(pallets(500), truck);
    expect(r.placements.length).toBeGreaterThan(10); // a second tier now fits within the same truck
  });
});

describe("HeuristicPacker — reach limit reason", () => {
  // Single-column van: footprint matches the cube exactly, so units can only
  // stack straight up — no other anchor has room. h=3.0 fits 6 × 0.5m units;
  // a 1.8m reach cap physically blocks the top two.
  const reachVan = makeVan({ interior: { l: 0.6, w: 0.6, h: 3.0 }, maxPayloadKg: 1000 });
  const cubes = () =>
    Array.from({ length: 6 }, () =>
      makeItem({
        id: "cube",
        dimensions: { l: 0.6, w: 0.6, h: 0.5 },
        orientationLock: "fixed",
        weightKg: 5,
        canSupportWeightKg: 200,
        maxStackPressureKpa: 200,
      }),
    );

  it("distinguishes reach-blocked from genuinely-full: space existed, just too high", () => {
    const capped = new HeuristicPacker({ toleranceM: 0.005, maxReachHeightM: 1.8 });
    const r = capped.pack(cubes(), reachVan);
    expect(r.placements).toHaveLength(4); // z = 0, 0.5, 1.0, 1.5 — all base ≤ 1.8m
    expect(r.placements.every((p) => p.position.z <= 1.8)).toBe(true);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0]!.quantity).toBe(2); // z = 2.0 and 2.5 both blocked
    expect(r.reasons.cube).toMatch(/reach limit/i);
  });

  it("the same layout with no reach cap places every unit", () => {
    const uncapped = new HeuristicPacker({ toleranceM: 0.005 });
    const r = uncapped.pack(cubes(), reachVan);
    expect(r.placements).toHaveLength(6);
    expect(r.unplaced).toHaveLength(0);
  });

  it("a genuinely full van still reports plain no-space, not reach-limited", () => {
    // Interior height itself is the ceiling here — well under the 1.8m reach cap,
    // so reach is never the actual cause; the generic reason must still apply.
    const shortVan = makeVan({ interior: { l: 0.6, w: 0.6, h: 1.0 }, maxPayloadKg: 1000 });
    const capped = new HeuristicPacker({ toleranceM: 0.005, maxReachHeightM: 1.8 });
    const r = capped.pack(cubes(), shortVan);
    expect(r.placements).toHaveLength(2); // z = 0, 0.5 — z = 1.0 exceeds the 1.0m interior
    expect(r.unplaced[0]!.quantity).toBe(4);
    expect(r.reasons.cube).toMatch(/no space/i);
    expect(r.reasons.cube).not.toMatch(/reach limit/i);
  });
});

describe("HeuristicPacker — stacking & rotation", () => {
  it("builds upward: stackable items in a wide, tall van produce z>0 placements", () => {
    // Floor easily fits all items side by side, so only an upward preference yields
    // stacking — this would be all-floor (z=0) under the old floor-first scan.
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 } });
    const items = Array.from({ length: 6 }, (_, i) =>
      makeItem({ id: `c${i}`, weightKg: 10, canSupportWeightKg: 80 }),
    );
    const r = packer.pack(items, van);
    expect(r.placements).toHaveLength(6);
    expect(anyOverlap(r.placements)).toBe(false);
    expect(r.placements.some((p) => p.position.z > 0)).toBe(true);
  });

  it("keeps non-stackable items on the floor", () => {
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 } });
    const items = Array.from({ length: 4 }, (_, i) =>
      makeItem({ id: `a${i}`, category: "appliance", stackable: false, canSupportWeightKg: 0 }),
    );
    const r = packer.pack(items, van);
    expect(r.placements).toHaveLength(4);
    expect(r.placements.every((p) => p.position.z === 0)).toBe(true);
  });

  it("'partial' lock never tips h off the vertical axis (unlike 'none')", () => {
    // Same too-tall box as the 'fixed' case, but with 'partial': since l===w here,
    // swapping them changes nothing — h stays vertical either way, so it must
    // still be reported unplaced, proving 'partial' is not treated as 'none'.
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 } });
    const tooTall = makeItem({
      id: "tall-partial",
      category: "tall-unit",
      dimensions: { l: 0.6, w: 0.6, h: 2.5 },
      orientationLock: "partial",
    });
    const r = packer.pack([tooTall], van);
    expect(r.placements).toHaveLength(0);
    expect(r.reasons["tall-partial"]).toMatch(/interior/i);
  });

  it("'partial' lock may swap l/w (rotationIndex 2) to fit a narrow van", () => {
    // Natural [l,w,h]=[0.5,2.5,0.6] is too wide (van width 0.6). The upright swap
    // [w,l,h]=[2.5,0.5,0.6] fits: proves 'partial' tries index 2, not just 0.
    const van = makeVan({ interior: { l: 3.0, w: 0.6, h: 0.7 } });
    const item = makeItem({
      id: "swap",
      dimensions: { l: 0.5, w: 2.5, h: 0.6 },
      orientationLock: "partial",
    });
    const r = packer.pack([item], van);
    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]!.rotationIndex).toBe(2);
  });

  it("tips a box that only fits rotated when orientation is free", () => {
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 } });
    const tippable = makeItem({
      id: "tip",
      dimensions: { l: 0.6, w: 0.6, h: 2.5 }, // stands too tall (2.5 > 1.9)…
      orientationLock: "none", // …but may lie down (2.5 along the 3.0 length)
    });
    const r = packer.pack([tippable], van);
    expect(r.placements).toHaveLength(1);
    const p = r.placements[0]!;
    expect(p.size.z).toBeLessThanOrEqual(van.interior.h);
    expect(p.rotationIndex).toBeGreaterThan(0); // not the natural orientation
  });

  it("is deterministic with rotation enabled", () => {
    const van = makeVan();
    const items = Array.from({ length: 7 }, (_, i) =>
      makeItem({ id: `d${i}`, dimensions: { l: 0.5, w: 0.4, h: 0.7 }, weightKg: 12 }),
    );
    expect(packer.pack(items, van).placements).toEqual(packer.pack(items, van).placements);
  });
});

describe("HeuristicPacker — standard stacking (fragility-driven)", () => {
  // Footprint of exactly one box ⇒ the only way to place N is a vertical column.
  const columnVan = (h: number) => makeVan({ interior: { l: 0.62, w: 0.62, h }, maxPayloadKg: 5000 });

  it("stacks standard-on-standard into a vertical column", () => {
    // Headline behaviour: three identical standard boxes can only fit by stacking.
    const items = Array.from({ length: 3 }, (_, i) =>
      makeItem({ id: `s${i}`, fragility: "standard", weightKg: 30 }),
    );
    const r = packer.pack(items, columnVan(2.4)); // 3 × 0.7 = 2.1 < 2.4

    expect(r.placements).toHaveLength(3);
    expect(r.unplaced).toHaveLength(0);
    expect(anyOverlap(r.placements)).toBe(false);
    const zs = r.placements.map((p) => p.position.z).sort((a, b) => a - b);
    expect(zs).toEqual([0, 0.7, 1.4]); // strictly increasing column, flush faces
  });

  it("refuses to stack a heavy box on a base rated to hold far less", () => {
    // canSupportWeightKg(5) ≪ weightKg(200): the weight ceiling is a HARD cap now —
    // a base rated for 5 kg cannot bear a 200 kg box, so the second box can't stack
    // and there's no floor room for it in a single-column van → it goes unplaced.
    const items = [
      makeItem({ id: "a", fragility: "standard", weightKg: 200, canSupportWeightKg: 5 }),
      makeItem({ id: "b", fragility: "standard", weightKg: 200, canSupportWeightKg: 5 }),
    ];
    const r = packer.pack(items, columnVan(2.0)); // payload 5000 ≥ 2×200

    expect(r.placements).toHaveLength(1);
    expect(r.placements[0]!.position.z).toBe(0); // the one that fit sits on the floor
    expect(r.unplaced).toHaveLength(1); // the second has nowhere safe to go
  });

  it("overflows when the column hits the van roof", () => {
    // Floor fits one footprint; height fits exactly two boxes (2×0.7 < 1.5 < 3×0.7).
    const items = Array.from({ length: 4 }, (_, i) =>
      makeItem({ id: `o${i}`, fragility: "standard", weightKg: 20 }),
    );
    const r = packer.pack(items, columnVan(1.5));

    expect(r.placements).toHaveLength(2);
    expect(r.unplaced).toHaveLength(2); // two boxes have nowhere to go
    for (const u of r.unplaced) expect(r.reasons[u.id]).toMatch(/space/i);
  });

  it("does not stack a box onto a base too small to cover it (single-base support)", () => {
    // Small base sorts to the floor first (higher rating); the larger box cannot
    // rest on its partial footprint and must take the floor beside it.
    const small = makeItem({
      id: "small",
      fragility: "standard",
      dimensions: { l: 0.3, w: 0.3, h: 0.3 },
      canSupportWeightKg: 100,
    });
    const big = makeItem({
      id: "big",
      fragility: "standard",
      dimensions: { l: 0.6, w: 0.6, h: 0.7 },
      canSupportWeightKg: 10,
    });
    const van = makeVan({ interior: { l: 2.0, w: 0.62, h: 2.0 } });
    const r = packer.pack([small, big], van);

    expect(r.placements).toHaveLength(2);
    const bigP = r.placements.find((p) => p.itemId === "big")!;
    expect(bigP.position.z).toBe(0); // floored beside, never balanced on the small base
  });

  it("stacks standards but leaves a non-stackable fragile item on the floor", () => {
    // Two-footprint floor + height for a column: standards build up, the fragile
    // (non-stackable) box rides on the floor — nothing rests on it.
    const items = [
      makeItem({ id: "std0", fragility: "standard", weightKg: 20 }),
      makeItem({ id: "std1", fragility: "standard", weightKg: 20 }),
      makeItem({ id: "glass", fragility: "fragile", stackable: false, weightKg: 20 }),
    ];
    const van = makeVan({ interior: { l: 1.3, w: 0.62, h: 1.6 } });
    const r = packer.pack(items, van);

    expect(r.placements).toHaveLength(3);
    const glass = r.placements.find((p) => p.itemId === "glass")!;
    expect(glass.position.z).toBe(0);
    expect(r.placements.filter((p) => !p.fragile).some((p) => p.position.z > 0)).toBe(true);
  });
});

describe("HeuristicPacker — crush pressure & fragile compatibility", () => {
  it("stacks fragile-on-fragile into a column", () => {
    const van = makeVan({ interior: { l: 0.62, w: 0.62, h: 2.0 }, maxPayloadKg: 1000 });
    const items = Array.from({ length: 2 }, (_, i) =>
      makeItem({ id: `f${i}`, fragility: "fragile", weightKg: 10 }),
    );
    const r = packer.pack(items, van);
    expect(r.placements).toHaveLength(2);
    expect(r.placements.some((p) => p.position.z > 0)).toBe(true); // fragile rests on fragile
  });

  it("does not stack a box whose pressure would crush its base", () => {
    // Two-footprint tall van: stacking is preferred, but the heavy box's pressure
    // (300 kg / 0.36 m² ≈ 8.2 kPa) exceeds the soft base's 3 kPa limit, so it floors.
    const base = makeItem({ id: "a-soft", weightKg: 10, maxStackPressureKpa: 3 });
    const heavy = makeItem({ id: "z-heavy", weightKg: 300, maxStackPressureKpa: 50 });
    const van = makeVan({ interior: { l: 1.3, w: 0.62, h: 2.0 }, maxPayloadKg: 1000 });
    const r = packer.pack([base, heavy], van);

    expect(r.placements).toHaveLength(2);
    const heavyP = r.placements.find((p) => p.itemId === "z-heavy")!;
    expect(heavyP.position.z).toBe(0); // crush limit forced it onto the floor
  });
});

describe("HeuristicPacker — fragility / support invariants", () => {
  // Narrow tall van forces vertical stacking (floor footprint fits one item).
  const stackVan = makeVan({ interior: { l: 0.62, w: 0.62, h: 2.0 }, maxPayloadKg: 1000 });

  it("the load-bearing (lower) placement is never fragile", () => {
    const items = [
      makeItem({ id: "base", weightKg: 10, fragility: "standard" }),
      makeItem({ id: "top", weightKg: 10, fragility: "standard" }),
    ];
    const r = packer.pack(items, stackVan);
    expect(r.placements).toHaveLength(2);
    const lower = r.placements.find((p) => p.position.z === 0)!;
    expect(lower.fragile).toBe(false);
  });

  it("never rests another item on top of a fragile item", () => {
    const items = [
      makeItem({ id: "glass", weightKg: 10, fragility: "fragile", stackable: false }),
      makeItem({ id: "box", weightKg: 10, fragility: "standard" }),
    ];
    const r = packer.pack(items, stackVan);

    // Invariant: for every fragile placement, nothing overlaps its top face.
    for (const f of r.placements.filter((p) => p.fragile)) {
      const top = f.position.z + f.size.z;
      const resting = r.placements.filter(
        (p) =>
          p !== f &&
          Math.abs(p.position.z - top) <= 0.005 &&
          p.position.x < f.position.x + f.size.x &&
          f.position.x < p.position.x + p.size.x &&
          p.position.y < f.position.y + f.size.y &&
          f.position.y < p.position.y + p.size.y,
      );
      expect(resting).toHaveLength(0);
    }
  });
});

describe("HeuristicPacker — brittle sinks in the base-priority sort (Stage 3)", () => {
  it("does not let a brittle item with a high crush limit win the floor slot over a non-brittle base", () => {
    // Single-footprint column (l=w=0.62 forces the natural orientation, as in the
    // other columnVan-style tests) so the floor pick is unambiguous. Before the
    // fix, the sort only looked at fragility ("standard" for both here), so the
    // higher maxStackPressureKpa (brittle-high) would win the floor slot purely
    // on crush-limit ranking, and the gate would then refuse to stack anything on
    // it. brittle must now sink regardless of its crush limit.
    const van = makeVan({ interior: { l: 0.62, w: 0.62, h: 2.0 }, maxPayloadKg: 1000 });
    const items = [
      makeItem({ id: "brittle-high", brittle: true, maxStackPressureKpa: 100 }),
      makeItem({ id: "sturdy-low", brittle: false, maxStackPressureKpa: 50 }),
    ];
    const r = packer.pack(items, van);

    expect(r.placements).toHaveLength(2);
    expect(r.unplaced).toHaveLength(0);
    const floor = r.placements.find((p) => p.position.z === 0)!;
    expect(floor.itemId).toBe("sturdy-low");
    const brittleP = r.placements.find((p) => p.itemId === "brittle-high")!;
    expect(brittleP.position.z).toBeGreaterThan(0); // stacked atop the non-brittle base instead
  });

  it("lets ordinary items stack on the non-brittle base instead of stranding behind a high-crush brittle item", () => {
    const van = makeVan({ interior: { l: 1.3, w: 0.62, h: 1.6 }, maxPayloadKg: 1000 });
    const items = [
      makeItem({ id: "base-good", brittle: false, maxStackPressureKpa: 100 }),
      makeItem({ id: "base-brittle", brittle: true, maxStackPressureKpa: 100 }), // equal crush limit
      makeItem({ id: "filler1" }),
      makeItem({ id: "filler2" }),
    ];
    const r = packer.pack(items, van);

    expect(r.placements).toHaveLength(4);
    expect(r.unplaced).toHaveLength(0); // nothing stranded behind the brittle item

    // Invariant: nothing rests on top of the brittle item's footprint.
    const brittleP = r.placements.find((p) => p.itemId === "base-brittle")!;
    const brittleTop = brittleP.position.z + brittleP.size.z;
    const restingOnBrittle = r.placements.filter(
      (p) =>
        p !== brittleP &&
        Math.abs(p.position.z - brittleTop) <= 0.005 &&
        p.position.x < brittleP.position.x + brittleP.size.x &&
        brittleP.position.x < p.position.x + p.size.x &&
        p.position.y < brittleP.position.y + brittleP.size.y &&
        brittleP.position.y < p.position.y + p.size.y,
    );
    expect(restingOnBrittle).toHaveLength(0);

    // At least one ordinary filler stacks on the non-brittle base rather than
    // being left unplaced.
    const fillerStacked = r.placements.some(
      (p) => (p.itemId === "filler1" || p.itemId === "filler2") && p.position.z > 0,
    );
    expect(fillerStacked).toBe(true);
  });
});
