/** Unit coverage for the shared placement-constraint module (Stage 3/4 seam). */
import { describe, it, expect } from "vitest";
import {
  cascadeAfterRemoval,
  computeUtilization,
  firstFitStacked,
  fitsInterior,
  hasOverlap,
  isSupported,
  maxBearableKg,
  reconcileFlags,
  resolveDrop,
  stackLoadByPlacement,
  stackPressureKpa,
  validateArrangement,
  validatePlacement,
} from "@/lib/packing/placement-validator";
import type { Dimensions, Placement } from "@/lib/packing/packing.types";

const interior: Dimensions = { l: 3.0, w: 1.8, h: 1.9 };
const tol = 0.005;

function place(over: Partial<Placement> = {}): Placement {
  return {
    itemId: over.itemId ?? "p",
    position: over.position ?? { x: 0, y: 0, z: 0 },
    size: over.size ?? { x: 0.6, y: 0.6, z: 0.7 },
    fragile: over.fragile ?? false,
    weightKg: over.weightKg ?? 10,
    // High by default so the pressure-focused tests aren't clipped by the weight
    // ceiling — the ceiling has its own dedicated tests below (set it low there).
    canSupportWeightKg: over.canSupportWeightKg ?? 5000,
    stackable: over.stackable ?? true,
    maxStackPressureKpa: over.maxStackPressureKpa ?? 50,
    brittle: over.brittle ?? false,
  };
}

describe("maxBearableKg — sole inverse of stackPressureKpa", () => {
  // consolidation.ts used to hand-derive this inverse three times to compute a
  // block's residual top-face capacity. Round-trip a few (weight, area) pairs
  // through both directions to prove they're the exact same crush model.
  it.each([
    [10, 0.36],
    [250, 1.44],
    [1, 0.01],
    [4200, 2.0],
  ])("round-trips weight=%dkg area=%dm2 through stackPressureKpa <-> maxBearableKg", (weightKg, areaM2) => {
    const pressureKpa = stackPressureKpa(weightKg, areaM2);
    expect(maxBearableKg(pressureKpa, areaM2)).toBeCloseTo(weightKg, 9);
  });

  it.each([
    [50, 0.36],
    [12.5, 1.44],
    [0, 1.0],
  ])("round-trips pressure=%dkPa area=%dm2 through maxBearableKg <-> stackPressureKpa", (pressureKpa, areaM2) => {
    const weightKg = maxBearableKg(pressureKpa, areaM2);
    expect(stackPressureKpa(weightKg, areaM2)).toBeCloseTo(pressureKpa, 9);
  });

  it("treats non-positive area as zero bearable weight (mirrors stackPressureKpa's infinite-pressure refusal)", () => {
    expect(maxBearableKg(50, 0)).toBe(0);
    expect(maxBearableKg(50, -1)).toBe(0);
  });
});

describe("fitsInterior", () => {
  it("accepts a box wholly inside", () => {
    expect(fitsInterior({ x: 0, y: 0, z: 0 }, { x: 0.6, y: 0.6, z: 0.7 }, interior, tol)).toBe(true);
  });
  it("rejects a box past the far wall and a box at negative coords", () => {
    expect(fitsInterior({ x: 2.8, y: 0, z: 0 }, { x: 0.6, y: 0.6, z: 0.7 }, interior, tol)).toBe(false);
    expect(fitsInterior({ x: -0.05, y: 0, z: 0 }, { x: 0.6, y: 0.6, z: 0.7 }, interior, tol)).toBe(false);
  });
});

describe("hasOverlap", () => {
  const existing = [place({ itemId: "a", position: { x: 0, y: 0, z: 0 } })];
  it("detects intersection", () => {
    expect(hasOverlap({ x: 0.3, y: 0.3, z: 0 }, { x: 0.6, y: 0.6, z: 0.7 }, existing)).toBe(true);
  });
  it("treats flush faces as non-overlapping", () => {
    expect(hasOverlap({ x: 0.6, y: 0, z: 0 }, { x: 0.6, y: 0.6, z: 0.7 }, existing)).toBe(false);
  });
  it("ignores a sub-nanometre phantom overlap from non-associative band-translation noise", () => {
    // Regression: dense multi-drop loads are packed flush, then the zoned packer TRANSLATES
    // each band by a cursor. FP addition is non-associative, so a flush pair drifts by ~1 ULP
    // and the old zero-epsilon `<` read that femtometre gap as a real overlap — falsely
    // rejecting an otherwise-legal plan at the verify gate. Values proven to drift.
    const a = 0.31, s = 0.29, c = 0.089;
    const aStartX = a + c; //        A translated: (a + c)
    const bStartX = a + s + c; //    B, flush in local coords, translated: (a + s) + c
    // The overlap is real under strict `<`: bStart lands just short of A's end face.
    expect(bStartX < aStartX + s).toBe(true);
    const shifted = [place({ itemId: "a", position: { x: aStartX, y: 0, z: 0 }, size: { x: s, y: 0.6, z: 0.7 } })];
    // The fix: overlap must EXCEED OVERLAP_EPS_M, so this noise-scale gap is not an overlap.
    expect(hasOverlap({ x: bStartX, y: 0, z: 0 }, { x: s, y: 0.6, z: 0.7 }, shifted)).toBe(false);
  });
  it("still catches a real interpenetration well above the noise floor", () => {
    // 5 mm deep overlap — 50× the 0.1 mm epsilon — must still be flagged.
    expect(hasOverlap({ x: 0.595, y: 0, z: 0 }, { x: 0.6, y: 0.6, z: 0.7 }, existing)).toBe(true);
  });
});

describe("isSupported", () => {
  const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, maxStackPressureKpa: 50 });
  const top = { x: 0, y: 0, z: 0.7 };
  const size = { x: 0.6, y: 0.6, z: 0.7 }; // footprint 0.36 m²

  it("supports a standard box resting fully on a non-fragile base", () => {
    expect(isSupported(top, size, 10, false, [base], tol)).toBe(true);
  });
  it("rejects a standard box on a fragile base", () => {
    const fragileBase = place({ itemId: "g", fragile: true });
    expect(isSupported(top, size, 10, false, [fragileBase], tol)).toBe(false);
  });
  it("allows a fragile box to rest on a fragile base", () => {
    const fragileBase = place({ itemId: "g", fragile: true });
    expect(isSupported(top, size, 10, true, [fragileBase], tol)).toBe(true);
  });
  it("supports a heavy box while its pressure stays within the crush limit", () => {
    // 200 kg over 0.36 m² ≈ 5.45 kPa ≤ 50 kPa.
    expect(isSupported(top, size, 200, false, [base], tol)).toBe(true);
  });
  it("rejects a box whose pressure exceeds the base's crush limit", () => {
    // 200 kg over 0.36 m² ≈ 5.45 kPa > 3 kPa.
    const weakBase = place({ itemId: "soft", maxStackPressureKpa: 3 });
    expect(isSupported(top, size, 200, false, [weakBase], tol)).toBe(false);
  });
  it("rejects partial overhang (base does not fully cover footprint)", () => {
    const small = place({ itemId: "s", size: { x: 0.3, y: 0.3, z: 0.7 } });
    expect(isSupported(top, size, 10, false, [small], tol)).toBe(false);
  });

  it("sums weight down the whole column, not just against the immediate base", () => {
    // Base(z=0, limit 2 kPa) <- Middle(z=0.7, 30kg, limit 5 kPa) <- Candidate(z=1.4, 80kg).
    // Middle alone on Base: 30kg/0.36m² ≈ 0.82 kPa — fine (this is how Middle got placed).
    // Candidate alone against Middle's own 5 kPa limit: 80kg/0.36m² ≈ 2.18 kPa — passes,
    // so a single-level (immediate-base-only) check would wrongly allow the candidate.
    // Summed down to Base: (30+80)kg/0.36m² ≈ 3.0 kPa > Base's 2 kPa limit — must be refused.
    const base = place({ itemId: "floor", position: { x: 0, y: 0, z: 0 }, weightKg: 20, maxStackPressureKpa: 2 });
    const middle = place({ itemId: "mid", position: { x: 0, y: 0, z: 0.7 }, weightKg: 30, maxStackPressureKpa: 5 });
    const candidatePos = { x: 0, y: 0, z: 1.4 };
    expect(isSupported(candidatePos, size, 80, false, [base, middle], tol)).toBe(false);
  });

  it("allows a column whose cumulative pressure stays within every level's limit", () => {
    const base = place({ itemId: "floor", position: { x: 0, y: 0, z: 0 }, weightKg: 20, maxStackPressureKpa: 10 });
    const middle = place({ itemId: "mid", position: { x: 0, y: 0, z: 0.7 }, weightKg: 30, maxStackPressureKpa: 5 });
    const candidatePos = { x: 0, y: 0, z: 1.4 };
    expect(isSupported(candidatePos, size, 80, false, [base, middle], tol)).toBe(true);
  });

  it("counts sibling boxes sharing a wide base when checking a lower item's crush limit", () => {
    // N(floor, crush 4 kPa) <- P(wide, crush 300) carrying two heavy boxes side by side.
    // Each box alone transmits (box+P)=210 kg over P's 0.72 m² face ≈ 2.86 kPa < 4.
    // Both together transmit (A+B+P)=410 kg ≈ 5.58 kPa > 4 — the second must be refused
    // because N truly bears the sibling too, not just the single chain above it.
    const n = place({ itemId: "N", position: { x: 0, y: 0, z: 0 }, size: { x: 1.2, y: 0.6, z: 0.2 }, weightKg: 10, maxStackPressureKpa: 4 });
    const p = place({ itemId: "P", position: { x: 0, y: 0, z: 0.2 }, size: { x: 1.2, y: 0.6, z: 0.2 }, weightKg: 10, maxStackPressureKpa: 300 });
    const a = place({ itemId: "A", position: { x: 0, y: 0, z: 0.4 }, size: { x: 0.6, y: 0.6, z: 0.3 }, weightKg: 200, maxStackPressureKpa: 300 });
    const bPos = { x: 0.6, y: 0, z: 0.4 };
    const bSize = { x: 0.6, y: 0.6, z: 0.3 };
    // Control: with no sibling on P, box B is fine.
    expect(isSupported(bPos, bSize, 200, false, [n, p], tol)).toBe(true);
    // With sibling A already on P, N is over-pressured — B must be refused.
    expect(isSupported(bPos, bSize, 200, false, [n, p, a], tol)).toBe(false);
  });

  it("a brittle base is judged by ordinary crush-pressure math, not a separate veto", () => {
    // `brittle` is informational only here (see weightRestingOn/supportCheck docs) —
    // brittleness is already folded into maxStackPressureKpa upstream
    // (item-assembler.ts). A brittle bearer with a low (post-factor) limit refuses
    // an over-limit load exactly like any other item...
    const brittleBase = place({ itemId: "glass", maxStackPressureKpa: 5, brittle: true });
    // 200 kg over 0.36 m² ≈ 5.45 kPa > 5 kPa.
    expect(isSupported(top, size, 200, false, [brittleBase], tol)).toBe(false);
    // ...and — the actual behavior change — accepts a light-enough load instead of
    // refusing unconditionally the way the old veto did regardless of pressure.
    expect(isSupported(top, size, 1, false, [brittleBase], tol)).toBe(true);
  });
});

describe("isSupported — composite (resting across several bases)", () => {
  // Two 0.6-wide bases side by side (0..0.6 and 0.6..1.2), tops at z=0.7.
  const a = place({ itemId: "a", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
  const b = place({ itemId: "b", position: { x: 0.6, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
  // A wide box spanning both, resting at z=0.7.
  const wide = { x: 0, y: 0, z: 0.7 };
  const wideSize = { x: 1.2, y: 0.6, z: 0.3 }; // footprint 0.72 m²

  it("supports a box that spans two adjacent bases (the old ONE-base rule wrongly rejected this)", () => {
    expect(isSupported(wide, wideSize, 20, false, [a, b], tol)).toBe(true);
  });

  it("rejects when the two bases leave a gap the footprint isn't covered over", () => {
    const gapped = place({ itemId: "b", position: { x: 0.7, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
    // Gap x=0.6..0.7 under the 1.3-wide footprint is unsupported.
    expect(isSupported({ x: 0, y: 0, z: 0.7 }, { x: 1.3, y: 0.6, z: 0.3 }, 20, false, [a, gapped], tol)).toBe(false);
  });

  it("rejects when one of the two bases would be over-pressured (weak bearer)", () => {
    const weakB = place({ itemId: "b", position: { x: 0.6, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, maxStackPressureKpa: 3 });
    // 300 kg / 0.72 m² ≈ 4.09 kPa: fine on a (50) but over weak b's 3 kPa.
    expect(isSupported(wide, wideSize, 300, false, [a, weakB], tol)).toBe(false);
  });

  it("a brittle spanned base is judged by its (reduced) crush limit, not an automatic reject", () => {
    const weakBrittleB = place({ itemId: "b", position: { x: 0.6, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, brittle: true, maxStackPressureKpa: 3 });
    // 300 kg / 0.72 m² ≈ 4.09 kPa > weak brittle b's 3 kPa — refused on pressure, same as `weakB` above.
    expect(isSupported(wide, wideSize, 300, false, [a, weakBrittleB], tol)).toBe(false);
    const roomyBrittleB = place({ itemId: "b", position: { x: 0.6, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, brittle: true, maxStackPressureKpa: 300 });
    // Same load against a brittle bearer with headroom: accepted — no separate veto.
    expect(isSupported(wide, wideSize, 300, false, [a, roomyBrittleB], tol)).toBe(true);
  });

  it("rejects a standard box spanning onto a fragile base", () => {
    const fragileB = place({ itemId: "b", position: { x: 0.6, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, fragile: true });
    expect(isSupported(wide, wideSize, 20, false, [a, fragileB], tol)).toBe(false);
  });

  describe("a pre-existing composite item's weight must still count against its bearers", () => {
    // Bearer q is 1.0 wide, bearer r is 0.6 wide, side by side. d spans both:
    // it covers q's right 0.4m (x:0.6..1.0) and all of r (x:1.0..1.6), so d is
    // NOT fully contained in either bearer alone (the old full-containment rule
    // in weightRestingOn would have missed its weight on both).
    const q = place({ itemId: "q", position: { x: 0, y: 0, z: 0 }, size: { x: 1.0, y: 0.6, z: 0.7 }, canSupportWeightKg: 100, maxStackPressureKpa: 10000 });
    const r = place({ itemId: "r", position: { x: 1.0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, canSupportWeightKg: 100, maxStackPressureKpa: 10000 });
    const d = place({ itemId: "d", position: { x: 0.6, y: 0, z: 0.7 }, size: { x: 1.0, y: 0.6, z: 0.3 }, weightKg: 120, canSupportWeightKg: 10000, maxStackPressureKpa: 10000 });
    // d's footprint over q is 0.4x0.6=0.24 of its own 1.0x0.6=0.6 m^2, i.e. 40% ->
    // 48kg charged to q's 100kg ceiling. A new box e rests solely on the part of
    // q that d doesn't cover (x:0..0.6).
    const ePos = { x: 0, y: 0, z: 0.7 };
    const eSize = { x: 0.6, y: 0.6, z: 0.3 };

    it("refuses a new box once it plus the composite item's share would exceed the bearer's ceiling", () => {
      // True total on q = 48 (d's share) + 55 (e) = 103kg > 100kg ceiling.
      expect(isSupported(ePos, eSize, 55, false, [q, r, d], tol)).toBe(false);
    });

    it("still allows a new box that keeps the bearer within its ceiling once the composite share is counted", () => {
      // True total on q = 48 (d's share) + 40 (e) = 88kg <= 100kg ceiling.
      expect(isSupported(ePos, eSize, 40, false, [q, r, d], tol)).toBe(true);
    });
  });
});

describe("isSupported — weight ceiling (canSupportWeightKg)", () => {
  const top = { x: 0, y: 0, z: 0.7 };
  const size = { x: 0.6, y: 0.6, z: 0.7 };

  it("allows a stack within the base's weight ceiling", () => {
    const base = place({ itemId: "base", canSupportWeightKg: 50, maxStackPressureKpa: 1000 });
    expect(isSupported(top, size, 40, false, [base], tol)).toBe(true);
  });

  it("rejects a stack that exceeds the base's weight ceiling even with pressure headroom", () => {
    const base = place({ itemId: "base", canSupportWeightKg: 50, maxStackPressureKpa: 1000 });
    // 60 kg over 0.36 m² ≈ 1.63 kPa — well under 1000 kPa, but 60 kg > the 50 kg ceiling.
    expect(isSupported(top, size, 60, false, [base], tol)).toBe(false);
  });

  it("counts an existing box on the base toward the ceiling for the newcomer", () => {
    // Wide base (cap 50) already holding a 30 kg box; a second 30 kg box would make 60 > 50.
    const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: { x: 1.2, y: 0.6, z: 0.7 }, canSupportWeightKg: 50, maxStackPressureKpa: 1000 });
    const sitting = place({ itemId: "s", position: { x: 0, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.3 }, weightKg: 30 });
    expect(isSupported({ x: 0.6, y: 0, z: 0.7 }, { x: 0.6, y: 0.6, z: 0.3 }, 30, false, [base, sitting], tol)).toBe(false);
  });

  it("tolerates float-noise at exactly the ceiling (regression: large orders falsely rejected)", () => {
    // Three 0.1 kg boxes sum to 0.30000000000000004 in IEEE-754 — a hair over a 0.3 kg
    // ceiling. Physically at capacity, so a strict `>` would wrongly reject; the epsilon
    // absorbs the noise. This is the exact class of failure seen on ~1000-item orders.
    const wide = place({ itemId: "wide", position: { x: 0, y: 0, z: 0 }, size: { x: 1.8, y: 0.6, z: 0.7 }, canSupportWeightKg: 0.3, maxStackPressureKpa: 100000 });
    const a = place({ itemId: "a", position: { x: 0, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.3 }, weightKg: 0.1, canSupportWeightKg: 100000, maxStackPressureKpa: 100000 });
    const b = place({ itemId: "b", position: { x: 0.6, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.3 }, weightKg: 0.1, canSupportWeightKg: 100000, maxStackPressureKpa: 100000 });
    const c = place({ itemId: "c", position: { x: 1.2, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.3 }, weightKg: 0.1, canSupportWeightKg: 100000, maxStackPressureKpa: 100000 });
    expect(0.1 + 0.1 + 0.1).toBeGreaterThan(0.3); // the noise is real
    expect(validateArrangement([wide, a, b, c], interior, tol).ok).toBe(true);
  });
});

describe("validatePlacement", () => {
  it("passes a valid floor placement", () => {
    expect(validatePlacement(
      { position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, weightKg: 10, fragile: false },
      { others: [], interior, toleranceM: tol },
    )).toEqual({ ok: true });
  });
  it("names the overlapping item", () => {
    const r = validatePlacement(
      { position: { x: 0.1, y: 0.1, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, weightKg: 10, fragile: false },
      { others: [place({ itemId: "blocker" })], interior, toleranceM: tol },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("blocker");
  });
  it("rejects an unsupported airborne box", () => {
    const r = validatePlacement(
      { position: { x: 0, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.7 }, weightKg: 10, fragile: false },
      { others: [], interior, toleranceM: tol },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/support/i);
  });
  it("reports out-of-bounds", () => {
    const r = validatePlacement(
      { position: { x: 5.0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, weightKg: 10, fragile: false },
      { others: [], interior, toleranceM: tol },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/bounds/i);
  });
});

describe("resolveDrop (drag snapping)", () => {
  const size = { x: 0.6, y: 0.6, z: 0.7 };
  const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });

  it("lands on the floor (z=0, x/y unchanged) when nothing is underneath", () => {
    expect(resolveDrop(0.9, 0.4, size, [])).toEqual({ x: 0.9, y: 0.4, z: 0 });
  });

  it("snaps a roughly-aligned box onto the support so it rests fully on it", () => {
    // Dropped 0.04m/0.03m off the base → snapped back onto the base, lifted to its top.
    expect(resolveDrop(0.04, 0.03, size, [base])).toEqual({ x: 0, y: 0, z: 0.7 });
  });

  it("clamps onto a larger support's footprint instead of overhanging", () => {
    const big = place({ itemId: "big", position: { x: 0, y: 0, z: 0 }, size: { x: 1.2, y: 1.2, z: 0.7 } });
    // Dropped near the far corner → clamped so the 0.6-box stays fully on the 1.2-base.
    expect(resolveDrop(1.1, 1.1, size, [big])).toEqual({ x: 0.6, y: 0.6, z: 0.7 });
  });

  it("does not snap a box too large to be covered (stays put for the validator to reject)", () => {
    const small = place({ itemId: "small", position: { x: 0, y: 0, z: 0 }, size: { x: 0.3, y: 0.3, z: 0.3 } });
    expect(resolveDrop(0.05, 0.05, size, [small])).toEqual({ x: 0.05, y: 0.05, z: 0.3 });
  });

  it("rests on the highest support when footprints overlap a stack", () => {
    const lower = place({ itemId: "low", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
    const upper = place({ itemId: "up", position: { x: 0, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
    expect(resolveDrop(0.02, 0.02, size, [lower, upper]).z).toBe(1.4);
  });

  it("snaps a wide box into the combined footprint of two side-by-side bases (composite)", () => {
    const a = place({ itemId: "a", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
    const b = place({ itemId: "b", position: { x: 0.6, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
    // A 1.2-wide box (too big for either base alone) dropped 0.05 off → snaps to span both.
    expect(resolveDrop(0.05, 0, { x: 1.2, y: 0.6, z: 0.3 }, [a, b])).toEqual({ x: 0, y: 0, z: 0.7 });
  });
});

describe("validateArrangement (whole-layout gate — interactive edit commit)", () => {
  // A long base on the floor with a small box resting fully on its top — a valid
  // packer output and the exact stack the "orphaned dependent" bug operates on.
  const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: { x: 1.0, y: 0.4, z: 0.3 } });
  const onTop = place({ itemId: "top", position: { x: 0.5, y: 0, z: 0.3 }, size: { x: 0.4, y: 0.4, z: 0.3 } });

  it("accepts a valid stack (base + box resting fully on it)", () => {
    expect(validateArrangement([base, onTop], interior, tol).ok).toBe(true);
  });

  it("refuses an edit that orphans a dependent — rotating the base out from under its stack", () => {
    // Spin the base to (0.4 × 1.0): its footprint (x 0..0.4) no longer covers the
    // box at x 0.5..0.9, so the box is left floating. A per-box check of the base
    // alone would pass (it's back on the floor); the whole-layout gate must not.
    const rotatedBase = { ...base, size: { x: 0.4, y: 1.0, z: 0.3 } };
    const r = validateArrangement([rotatedBase, onTop], interior, tol);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/support/i);
  });

  it("refuses a non-stackable item resting off the floor even when geometrically supported", () => {
    const wideBase = place({ itemId: "b", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
    const noStack = place({ itemId: "ns", position: { x: 0, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.5 }, stackable: false });
    const r = validateArrangement([wideBase, noStack], interior, tol);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/non-stackable/i);
  });
});

describe("stackLoadByPlacement (UI load report — flag is the validator's own verdict)", () => {
  // Base 0.6×0.6 (footprint 0.36 m²) carrying a 36 kg box on its top face.
  // 36 kg / 0.36 m² → 36·g/0.36/1000 ≈ 0.9807 kPa pressing on the base.
  const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } });
  const onTop = place({ itemId: "top", position: { x: 0, y: 0, z: 0.7 }, size: { x: 0.6, y: 0.6, z: 0.3 }, weightKg: 36 });

  it("reports resting weight + correct interface pressure on the bearer, nothing on the top box", () => {
    const [b, t] = stackLoadByPlacement([base, onTop], tol);
    expect(b!.restingKg).toBe(36);
    expect(b!.pressureKpa).toBeCloseTo(0.980665, 5); // pressing box's own 0.36 m² footprint
    expect(b!.overloaded).toBe(false); // 0.98 kPa ≪ 50 kPa limit
    expect(t!.restingKg).toBe(0);
    expect(t!.pressureKpa).toBe(0);
    expect(t!.ratio).toBe(0);
    expect(t!.overloaded).toBe(false);
  });

  it("flags overloaded once the bearer's crush limit is edited DOWN below the load", () => {
    const weak = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, maxStackPressureKpa: 0.5 });
    const [b] = stackLoadByPlacement([weak, onTop], tol);
    expect(b!.overloaded).toBe(true);
    expect(b!.ratio).toBeCloseTo(0.980665 / 0.5, 5);
    // The flag is definitionally the validator's verdict.
    expect(validateArrangement([weak, onTop], interior, tol).ok).toBe(false);
  });

  it("flags a SMALL heavy box on a big bearer — the bug the old bearer-area pressure missed", () => {
    // Bearer 1.0×1.0 (cap 5 kPa) with a 0.2×0.2 box @40 kg on top.
    // Correct interface pressure = 40 kg / 0.04 m² ≈ 9.81 kPa > 5 → unsafe.
    // The OLD metric (40 kg / bearer's 1.0 m²) read 0.39 kPa and stayed green.
    const bigBearer = place({ itemId: "shelf", position: { x: 0, y: 0, z: 0 }, size: { x: 1.0, y: 1.0, z: 0.3 }, maxStackPressureKpa: 5 });
    const smallHeavy = place({ itemId: "brick", position: { x: 0.4, y: 0.4, z: 0.3 }, size: { x: 0.2, y: 0.2, z: 0.2 }, weightKg: 40 });
    const [b] = stackLoadByPlacement([bigBearer, smallHeavy], tol);
    expect(b!.pressureKpa).toBeCloseTo(9.80665, 4);
    expect(b!.overloaded).toBe(true);
    expect(validateArrangement([bigBearer, smallHeavy], interior, tol).ok).toBe(false);
  });

  it("treats a zero-capacity bearer with anything on top as overloaded, empty as fine", () => {
    const zeroCap = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 }, maxStackPressureKpa: 0 });
    const loaded = stackLoadByPlacement([zeroCap, onTop], tol)[0]!;
    expect(loaded.ratio).toBe(Infinity);
    expect(loaded.overloaded).toBe(true);
    const alone = stackLoadByPlacement([zeroCap], tol)[0]!;
    expect(alone.ratio).toBe(0);
    expect(alone.overloaded).toBe(false);
  });

  it("charges a bearer only the load structurally resting THROUGH it — not a box on an adjacent column", () => {
    // Regression: the packer builds a legal plan that the whole-arrangement verify
    // gate then rejects ("too heavy for the stack below — would crush it"), because
    // weightRestingOn used to charge ANY box overhanging a bearer in x/y and floating
    // above its top — even a box whose weight runs down a DIFFERENT column.
    //
    // Layout: two floor bases side by side — F (x 0..0.6, the bearer we measure) and
    // G (x 0.6..1.8). A spanner S (x 0..1.2, 10 kg) rests across BOTH at z=0.3, so
    // only HALF of S (and half of anything on S) is carried by F. A 100 kg box Z
    // rests on S at z=0.6 over F's side (x 0..0.6). Z's load flows into S, which
    // splits it 50/50 to F and G. So F truly carries 0.5·(S + Z) = 0.5·110 = 55 kg,
    // NOT S's share + Z's full 100 kg (= 105) the old x/y-overlap rule counted.
    const F = place({ itemId: "F", position: { x: 0, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.3 } });
    const G = place({ itemId: "G", position: { x: 0.6, y: 0, z: 0 }, size: { x: 1.2, y: 0.6, z: 0.3 } });
    const S = place({ itemId: "S", position: { x: 0, y: 0, z: 0.3 }, size: { x: 1.2, y: 0.6, z: 0.3 }, weightKg: 10 });
    const Z = place({ itemId: "Z", position: { x: 0, y: 0, z: 0.6 }, size: { x: 0.6, y: 0.6, z: 0.3 }, weightKg: 100 });
    const [f] = stackLoadByPlacement([F, G, S, Z], tol);
    expect(f!.restingKg).toBeCloseTo(55, 6); // structural load, not the phantom 105
  });
});

describe("cascadeAfterRemoval", () => {
  // A roomy van (10 x 10 x 5 m) so the fixtures below can spread items into
  // separate lanes without interior-bounds noise; 1m cubes keep the arithmetic
  // (heights, footprint areas) simple to hand-verify.
  const bigInterior: Dimensions = { l: 10, w: 10, h: 5 };
  const cube = { x: 1, y: 1, z: 1 };

  it("settles the top of a [base, top] stack onto the floor when the base is removed", () => {
    const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: cube });
    const top = place({ itemId: "top", position: { x: 0, y: 0, z: 1 }, size: cube });
    const { settled, displaced } = cascadeAfterRemoval([base, top], 0, bigInterior, tol);
    expect(displaced).toEqual([]);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.itemId).toBe("top");
    expect(settled[0]!.position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("settles the top of a 3-level stack onto the base when the middle is removed", () => {
    const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 }, size: cube });
    const middle = place({ itemId: "middle", position: { x: 0, y: 0, z: 1 }, size: cube });
    const top = place({ itemId: "top", position: { x: 0, y: 0, z: 2 }, size: cube });
    const { settled, displaced } = cascadeAfterRemoval([base, middle, top], 1, bigInterior, tol);
    expect(displaced).toEqual([]);
    expect(settled).toHaveLength(2);
    // Onto the base's own top face (base height = 1m) — the middle is gone.
    expect(settled.find((p) => p.itemId === "top")!.position).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("leaves an unrelated second stack untouched (deep-equal to the originals)", () => {
    const baseA = place({ itemId: "baseA", position: { x: 0, y: 0, z: 0 }, size: cube });
    const topA = place({ itemId: "topA", position: { x: 0, y: 0, z: 1 }, size: cube });
    const baseB = place({ itemId: "baseB", position: { x: 5, y: 0, z: 0 }, size: cube });
    const topB = place({ itemId: "topB", position: { x: 5, y: 0, z: 1 }, size: cube });
    const { settled, displaced } = cascadeAfterRemoval([baseA, topA, baseB, topB], 0, bigInterior, tol);
    expect(displaced).toEqual([]);
    expect(settled.find((p) => p.itemId === "baseB")).toEqual(baseB);
    expect(settled.find((p) => p.itemId === "topB")).toEqual(topB);
  });

  it("displaces a rider whose only support fails once removal strips its load-spreading base", () => {
    // weak (crush limit 0.6 kPa) <- spreader (2x1 footprint, removed) <- rider (1x1, 100kg).
    // With the spreader present, rider's weight spreads over its 2 m² footprint before
    // reaching weak (~0.5 kPa, passes). Once the spreader is removed, rider's own 1 m²
    // footprint presses directly on weak (~0.98 kPa) — over the 0.6 kPa limit — refused.
    const weak = place({
      itemId: "weak", position: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 1 },
      weightKg: 10, maxStackPressureKpa: 0.6,
    });
    const spreader = place({
      itemId: "spreader", position: { x: 0, y: 0, z: 1 }, size: { x: 2, y: 1, z: 0.1 },
      weightKg: 1, maxStackPressureKpa: 1000,
    });
    const rider = place({
      itemId: "rider", position: { x: 0, y: 0, z: 1.1 }, size: cube,
      weightKg: 100, maxStackPressureKpa: 1000,
    });
    const { settled, displaced } = cascadeAfterRemoval([weak, spreader, rider], 1, bigInterior, tol);
    expect(displaced).toHaveLength(1);
    expect(displaced[0]!.itemId).toBe("rider");
    expect(settled.map((p) => p.itemId)).toEqual(["weak"]);
    expect(validateArrangement(settled, bigInterior, tol).ok).toBe(true);
  });

  it("preserves the caller's original order of survivors even though processing runs in ascending-z order (FIX regression)", () => {
    // Input order: mid2 (z=1, rests on base2), base1 (z=0, unrelated), throwaway
    // (removed), base2 (z=0, base2 for mid2) — deliberately NOT in z order, so
    // processing (ascending z: base1, base2, then mid2 last) differs from input
    // order (mid2, base1, base2). The returned `settled` must match input order,
    // not processing order — this is exactly what the fix guards against.
    const mid2 = place({ itemId: "mid2", position: { x: 2, y: 0, z: 1 }, size: cube });
    const base1 = place({ itemId: "base1", position: { x: 0, y: 0, z: 0 }, size: cube });
    const throwaway = place({ itemId: "throwaway", position: { x: 5, y: 0, z: 0 }, size: cube });
    const base2 = place({ itemId: "base2", position: { x: 2, y: 0, z: 0 }, size: cube });
    const { settled, displaced } = cascadeAfterRemoval([mid2, base1, throwaway, base2], 2, bigInterior, tol);
    expect(displaced).toEqual([]);
    expect(settled.map((p) => p.itemId)).toEqual(["mid2", "base1", "base2"]);
  });
});

describe("computeUtilization", () => {
  it("reports volume fill and floor footprint", () => {
    const placements = [
      place({ position: { x: 0, y: 0, z: 0 } }),
      place({ position: { x: 0, y: 0, z: 0.7 } }), // stacked — not on floor
    ];
    const u = computeUtilization(placements, interior);
    expect(u.volumeFill).toBeGreaterThan(0);
    expect(u.volumeFill).toBeLessThanOrEqual(1);
    // Only the floor box counts toward footprint: (0.6 * 0.6) / (3.0 * 1.8).
    expect(u.floorFootprint).toBeCloseTo((0.6 * 0.6) / (3.0 * 1.8), 6);
  });
  it("is zero for an empty van", () => {
    expect(computeUtilization([], interior)).toEqual({ volumeFill: 0, floorFootprint: 0 });
  });
});

describe("firstFitStacked (manual placement: floor first, then stack)", () => {
  // A box that tiles the 3.0 x 1.8 floor as 2 x 2 = 4, leaving room for a 2nd tier
  // under the 1.9 m ceiling (0.6 + 0.6 = 1.2 m).
  const box = { x: 1.5, y: 0.9, z: 0.6 };
  const fullFloor = (over: Partial<Placement> = {}): Placement[] =>
    [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 0, y: 0.9 }, { x: 1.5, y: 0.9 }].map((p, i) =>
      place({ itemId: `base${i}`, position: { x: p.x, y: p.y, z: 0 }, size: box, ...over }),
    );

  it("empty van → lands on the floor (z = 0)", () => {
    const spot = firstFitStacked(box, interior, [], tol, 10, false);
    expect(spot).not.toBeNull();
    expect(spot!.z).toBe(0);
  });

  it("floor still has room → fills the floor, does not stack early", () => {
    const spot = firstFitStacked(box, interior, [place({ position: { x: 0, y: 0, z: 0 }, size: box })], tol, 10, false);
    expect(spot).not.toBeNull();
    expect(spot!.z).toBe(0);
  });

  it("floor full → stacks onto the tier below (z > 0)", () => {
    const spot = firstFitStacked(box, interior, fullFloor(), tol, 10, false);
    expect(spot).not.toBeNull();
    expect(spot!.z).toBeCloseTo(0.6, 5);
  });

  it("would crush the base → refuses rather than stack (null)", () => {
    const weakBases = fullFloor({ maxStackPressureKpa: 0.01 });
    const spot = firstFitStacked(box, interior, weakBases, tol, 1000, false);
    expect(spot).toBeNull();
  });

  it("stacked spot above the reach limit → refuses (null)", () => {
    // Bases top out at z = 0.6; a 0.5 m reach cap forbids placing a base that high.
    const spot = firstFitStacked(box, interior, fullFloor(), tol, 10, false, 0.5);
    expect(spot).toBeNull();
  });

  it("reach limit clears the tier height → still stacks", () => {
    const spot = firstFitStacked(box, interior, fullFloor(), tol, 10, false, 1.5);
    expect(spot).not.toBeNull();
    expect(spot!.z).toBeCloseTo(0.6, 5);
  });
});

describe("reconcileFlags (manual-override honesty)", () => {
  it("leaves a valid floor + valid stack untouched (identity preserved)", () => {
    const base = place({ itemId: "base", position: { x: 0, y: 0, z: 0 } });
    const top = place({ itemId: "top", position: { x: 0, y: 0, z: 0.7 } });
    const out = reconcileFlags([base, top], interior, tol);
    expect(out[0]).toBe(base); // same reference — no needless re-render
    expect(out[1]).toBe(top);
    expect(out.some((p) => p.flagged)).toBe(false);
  });

  it("flags BOTH boxes of an overlapping pair", () => {
    const a = place({ itemId: "a", position: { x: 0, y: 0, z: 0 } });
    const b = place({ itemId: "b", position: { x: 0.3, y: 0.3, z: 0 } }); // overlaps a
    const out = reconcileFlags([a, b], interior, tol);
    expect(out[0]!.flagged).toBe(true);
    expect(out[1]!.flagged).toBe(true);
    expect(out[0]!.flagReason).toMatch(/overlaps/);
  });

  it("flags a floating (unsupported) box off the floor", () => {
    const floater = place({ itemId: "f", position: { x: 1.0, y: 0.5, z: 0.7 } }); // nothing under it
    const out = reconcileFlags([floater], interior, tol);
    expect(out[0]!.flagged).toBe(true);
  });

  it("CLEARS a stale flag once the box is back in a valid spot", () => {
    // place() ignores unknown keys, so set the stale flag explicitly.
    const wasFlagged: Placement = { ...place({ itemId: "x", position: { x: 0, y: 0, z: 0 } }), flagged: true, flagReason: "overlaps y" };
    const out = reconcileFlags([wasFlagged], interior, tol); // alone on the floor → valid
    expect(out[0]!.flagged).toBe(false);
    expect(out[0]!.flagReason).toBeUndefined();
  });

  it("does not let one flagged box taint a separate, valid box", () => {
    const bad = place({ itemId: "bad", position: { x: 2.7, y: 0, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.7 } }); // past far wall
    const good = place({ itemId: "good", position: { x: 0, y: 0, z: 0 } });
    const out = reconcileFlags([bad, good], interior, tol);
    expect(out[0]!.flagged).toBe(true); // out of bounds
    expect(out[1]!.flagged).toBeFalsy(); // untouched — a valid box keeps no flag field
  });
});
