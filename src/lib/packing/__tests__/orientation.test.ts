/** Shared rotation-policy logic consumed by both heuristic-packer.ts and fleet-allocator.ts. */
import { describe, it, expect } from "vitest";
import { allOrientations, permittedOrientationIndices } from "@/lib/packing/orientation";

describe("allOrientations", () => {
  it("returns all 6 axis permutations, index 0 natural", () => {
    const perms = allOrientations(1, 2, 3);
    expect(perms).toHaveLength(6);
    expect(perms[0]).toEqual([1, 2, 3]);
  });
});

describe("permittedOrientationIndices", () => {
  it("fixed -> natural orientation only", () => {
    expect(permittedOrientationIndices("fixed")).toEqual([0]);
  });

  it("partial -> exactly the 2 upright permutations (h stays vertical)", () => {
    const indices = permittedOrientationIndices("partial");
    expect(indices).toEqual([0, 2]);
    // Confirm those two really do keep h last (vertical) for an asymmetric box.
    const perms = allOrientations(1, 2, 3);
    for (const i of indices) expect(perms[i]![2]).toBe(3);
  });

  it("none -> all 6 permutations", () => {
    expect(permittedOrientationIndices("none")).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
