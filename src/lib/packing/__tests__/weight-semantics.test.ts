/**
 * The 300× bug. A sheet prints "Qty 200 | Wt 48" and never says whether 48 kg is what ONE of the 200
 * weighs or what the whole line weighs. Read it the wrong way and a 2,565 kg job is quoted at
 * 760,535 kg across 43 vans — confidently, silently, and completely wrong.
 *
 * We don't guess: the sheet does its own arithmetic in its subtotal rows, and only one reading agrees
 * with it. These tests pin that, and pin the refusal to assert anything when the sheet stays silent.
 */
import { describe, it, expect } from "vitest";
import { detectWeightSemantics } from "@/lib/packing/weight-semantics";

const TOL = 0.02;

describe("detectWeightSemantics", () => {
  it("proves the weight column is a LINE TOTAL when the sheet's own subtotal agrees with it", () => {
    // The real line from route-plan/detailed.pdf: 48 + 22 + 28 + 24 = 122, the stated "S1" subtotal.
    // Multiplied by the Qty column it would be 9,600 + 528 + 28 + 48 = 10,204 — nowhere near.
    const result = detectWeightSemantics({
      lines: [
        { weightKg: 48, quantity: 200 },
        { weightKg: 22, quantity: 24 },
        { weightKg: 28, quantity: 1 },
        { weightKg: 24, quantity: 2 },
      ],
      statedTotalsKg: [122],
      tolerance: TOL,
    });
    expect(result?.lineTotal).toBe(true);
    expect(result?.proof).toMatch(/122/);
  });

  it("proves the weight column is PER UNIT when THAT is the reading the sheet's total agrees with", () => {
    // 10 boxes at 21 kg = 210 kg. Here the quantity genuinely is a package count, and nothing changes.
    const result = detectWeightSemantics({
      lines: [{ weightKg: 21, quantity: 10 }],
      statedTotalsKg: [210],
      tolerance: TOL,
    });
    expect(result?.lineTotal).toBe(false);
  });

  it("says NOTHING when the sheet states no total — silence is not permission to assume", () => {
    const result = detectWeightSemantics({
      lines: [{ weightKg: 48, quantity: 200 }],
      statedTotalsKg: [],
      tolerance: TOL,
    });
    expect(result).toBeNull();
  });

  it("says nothing when every quantity is 1 — the two readings are identical, so there is nothing to prove", () => {
    const result = detectWeightSemantics({
      lines: [
        { weightKg: 50, quantity: 1 },
        { weightKg: 70, quantity: 1 },
      ],
      statedTotalsKg: [120],
      tolerance: TOL,
    });
    expect(result).toBeNull();
  });

  it("says nothing when NEITHER reading matches — a total we can't reconcile proves nothing either way", () => {
    // Refusing to answer here matters: a mismatch means we have misread something, and picking the
    // "closer" reading would dress a misread up as a decision.
    const result = detectWeightSemantics({
      lines: [{ weightKg: 48, quantity: 200 }],
      statedTotalsKg: [999999],
      tolerance: TOL,
    });
    expect(result).toBeNull();
  });
});
