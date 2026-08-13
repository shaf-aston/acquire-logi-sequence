/**
 * Tests for inferSizeClass — the logic that auto-assigns size bands to session-added vans.
 *
 * Test philosophy: model real operator flows, not code branches.
 * If a scenario wouldn't happen in real life, skip it.
 */
import { describe, it, expect } from "vitest";
import { inferSizeClass } from "@/lib/packing/van-classifier";
import { makeVan } from "./fixtures";
import type { Van } from "@/lib/packing/packing.types";

// ── Fleet fixture ────────────────────────────────────────────────────────────
// Matches the rough real-world vans.json bands (volumes in m³: l×w×h).
// Small  ~ 3.2–4.1 m³  (1.75×1.50×1.21 = 3.17, 2.05×1.58×1.23 = 3.98)
// Medium ~ 4.4–5.5 m³  (2.16×1.63×1.24 = 4.37, 2.50×1.70×1.30 = 5.53)
// Large  ~ 8–12 m³     (3.00×1.90×1.95 = 11.1)
// Luton  ~ 15–20 m³    (4.00×2.10×2.00 = 16.8)

function makeFleet(): Van[] {
  return [
    makeVan({ id: "small-1", sizeClass: "Small",  interior: { l: 1.75, w: 1.50, h: 1.21 } }), // 3.17
    makeVan({ id: "small-2", sizeClass: "Small",  interior: { l: 2.05, w: 1.58, h: 1.23 } }), // 3.98
    makeVan({ id: "med-1",   sizeClass: "Medium", interior: { l: 2.16, w: 1.63, h: 1.24 } }), // 4.37
    makeVan({ id: "med-2",   sizeClass: "Medium", interior: { l: 2.50, w: 1.70, h: 1.30 } }), // 5.53
    makeVan({ id: "large-1", sizeClass: "Large",  interior: { l: 3.00, w: 1.90, h: 1.95 } }), // 11.1
    makeVan({ id: "luton-1", sizeClass: "Luton",  interior: { l: 4.00, w: 2.10, h: 2.00 } }), // 16.8
  ];
}

// ── Real-life scenarios ──────────────────────────────────────────────────────

describe("inferSizeClass — real operator flows", () => {

  // The most common case: operator adds a van of an obvious size.
  it("assigns Small when van volume is clearly within Small band", () => {
    const fleet = makeFleet();
    const van = makeVan({ interior: { l: 1.90, w: 1.55, h: 1.22 } }); // ~3.60 m³
    expect(inferSizeClass(van, fleet)).toBe("Small");
  });

  it("assigns Medium when van volume sits in Medium band", () => {
    const fleet = makeFleet();
    const van = makeVan({ interior: { l: 2.30, w: 1.65, h: 1.27 } }); // ~4.82 m³
    expect(inferSizeClass(van, fleet)).toBe("Medium");
  });

  it("assigns Large when van volume is well above Medium", () => {
    const fleet = makeFleet();
    const van = makeVan({ interior: { l: 3.10, w: 2.00, h: 1.90 } }); // ~11.8 m³
    expect(inferSizeClass(van, fleet)).toBe("Large");
  });

  it("assigns Luton for a high-roof long wheelbase van", () => {
    const fleet = makeFleet();
    const van = makeVan({ interior: { l: 4.10, w: 2.15, h: 2.05 } }); // ~18.1 m³
    expect(inferSizeClass(van, fleet)).toBe("Luton");
  });

  // A giant van nobody in the fleet can match — should still land in biggest class.
  it("assigns the closest (largest) band for a van bigger than any existing class", () => {
    const fleet = makeFleet();
    const boxTruck = makeVan({ interior: { l: 6.00, w: 2.40, h: 2.50 } }); // 36 m³
    // Luton median is 16.8, nearest of the 4 bands by distance.
    expect(inferSizeClass(boxTruck, fleet)).toBe("Luton");
  });

  // A tiny van — smaller than any existing class, should land in smallest.
  it("assigns the closest (smallest) band for a van smaller than any existing class", () => {
    const fleet = makeFleet();
    const micro = makeVan({ interior: { l: 1.20, w: 1.20, h: 1.10 } }); // 1.58 m³
    expect(inferSizeClass(micro, fleet)).toBe("Small");
  });

  // Edge: only one size class in the fleet — everything maps to it.
  it("assigns the only available sizeClass when fleet has a single band", () => {
    const fleet = [
      makeVan({ id: "a", sizeClass: "Transit", interior: { l: 2.5, w: 1.7, h: 1.8 } }),
      makeVan({ id: "b", sizeClass: "Transit", interior: { l: 2.6, w: 1.7, h: 1.8 } }),
    ];
    const hugeTruck = makeVan({ interior: { l: 8.0, w: 2.5, h: 2.5 } });
    expect(inferSizeClass(hugeTruck, fleet)).toBe("Transit");
  });

  // Edge: no van in the fleet has a sizeClass at all — returns fallback.
  it("returns 'Other' when no fleet van carries a sizeClass", () => {
    const fleet = [
      makeVan({ id: "a", sizeClass: undefined }),
      makeVan({ id: "b", sizeClass: undefined }),
    ];
    const van = makeVan({ interior: { l: 2.5, w: 1.7, h: 1.8 } });
    expect(inferSizeClass(van, fleet)).toBe("Other");
  });

  // Edge: empty fleet (operator hasn't configured any vans yet).
  it("returns 'Other' for an empty fleet", () => {
    const van = makeVan({ interior: { l: 2.5, w: 1.7, h: 1.8 } });
    expect(inferSizeClass(van, [])).toBe("Other");
  });

  // Tie-break: van volume exactly equidistant between Small and Medium medians.
  // Small median ~ 3.58 m³, Medium median ~ 4.95 m³ → midpoint ~ 4.26 m³.
  // We expect the SMALLER class to win (tie-break sorts by ascending median).
  it("tie-breaks toward the smaller size class when equidistant", () => {
    const smallMedian = (3.17 + 3.98) / 2; // 3.575
    const medMedian = (4.37 + 5.53) / 2;   // 4.95
    const midpoint = (smallMedian + medMedian) / 2; // 4.2625

    // Build a van whose volume is exactly at the midpoint.
    // l×w×h = 4.2625 → use l=2.0, w=1.6, h=midpoint/(2.0*1.6)
    const h = midpoint / (2.0 * 1.6); // ~1.332
    const van = makeVan({ interior: { l: 2.0, w: 1.6, h } });
    const result = inferSizeClass(van, makeFleet());
    // Tie breaks to Small (smaller median wins).
    expect(result).toBe("Small");
  });

  // Real operator scenario: operator adds a Medium van to a fleet that only has Small/Large.
  // The new Medium-volume van should land in whichever of Small/Large is closer.
  it("handles a fleet with a gap in the middle (no Medium class)", () => {
    const fleet = [
      makeVan({ id: "s1", sizeClass: "Small", interior: { l: 1.75, w: 1.50, h: 1.21 } }), // 3.17
      makeVan({ id: "l1", sizeClass: "Large", interior: { l: 3.00, w: 1.90, h: 1.95 } }), // 11.1
    ];
    const medVan = makeVan({ interior: { l: 2.30, w: 1.65, h: 1.27 } }); // 4.82
    // Distance to Small: |4.82 - 3.17| = 1.65
    // Distance to Large: |4.82 - 11.1| = 6.28
    // → Small
    expect(inferSizeClass(medVan, fleet)).toBe("Small");
  });

  // Vans without sizeClass in the fleet should be ignored (not contaminate inference).
  it("ignores fleet vans that have no sizeClass", () => {
    const fleet = [
      makeVan({ id: "a", sizeClass: "Large",   interior: { l: 3.00, w: 1.90, h: 1.95 } }), // 11.1
      makeVan({ id: "b", sizeClass: undefined,  interior: { l: 1.50, w: 1.40, h: 1.10 } }), // noise
    ];
    // Tiny van — only class available is Large.
    const micro = makeVan({ interior: { l: 1.20, w: 1.20, h: 1.10 } });
    expect(inferSizeClass(micro, fleet)).toBe("Large");
  });

  // Sanity: adding a van to the fleet does not mutate the fleet array.
  it("does not mutate the fleet array", () => {
    const fleet = makeFleet();
    const copy = fleet.map((v) => ({ ...v }));
    const van = makeVan({ interior: { l: 2.0, w: 1.6, h: 1.3 } });
    inferSizeClass(van, fleet);
    expect(fleet).toHaveLength(copy.length);
    fleet.forEach((v, i) => {
      expect(v.id).toBe(copy[i]!.id);
      expect(v.sizeClass).toBe(copy[i]!.sizeClass);
    });
  });
});

// ── Volume scale sanity (catches the old / 1e9 bug) ─────────────────────────
describe("volume scale sanity", () => {
  it("interior volumes from vans.json are in m³ (not mm³ or cm³)", () => {
    // City Compact: 1.75×1.50×1.21 = 3.176 m³
    // If the packer mistakenly uses / 1e9 it would be 3.18e-9 m³ — clearly wrong.
    const van = makeVan({ interior: { l: 1.75, w: 1.50, h: 1.21 } });
    // volumeM3 is called inside inferSizeClass — just verify the median
    // computation doesn't collapse everything to near-zero (which would make
    // all vans equidistant and tie-break nondeterministic).
    const fleet = makeFleet();
    // A large Luton should NOT be classified as Small.
    const luton = makeVan({ interior: { l: 4.00, w: 2.10, h: 2.00 } }); // 16.8 m³
    expect(inferSizeClass(luton, fleet)).not.toBe("Small");
    expect(inferSizeClass(van, fleet)).toBe("Small");
  });
});
