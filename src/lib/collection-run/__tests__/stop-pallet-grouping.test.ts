import { describe, it, expect } from "vitest";
import { groupPlacementsByStop, rowIdOfPlacement, type FleetVan } from "@/lib/collection-run/stop-pallet-grouping";
import type { Placement, VanDimensions } from "@/types/api";

const INTERIOR_A: VanDimensions = { l: 4, w: 2, h: 2 };
const INTERIOR_B: VanDimensions = { l: 6, w: 2.4, h: 2.4 };

/** Minimal placement — only itemId matters to the grouping. */
function place(itemId: string): Placement {
  return {
    itemId,
    position: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    fragile: false,
    weightKg: 10,
    canSupportWeightKg: 100,
    stackable: true,
    maxStackPressureKpa: 50,
    brittle: false,
  };
}

function van(interior: VanDimensions, ...ids: string[]): FleetVan {
  return { interior, placements: ids.map(place) };
}

describe("rowIdOfPlacement", () => {
  it("returns the id unchanged when there is no block suffix", () => {
    expect(rowIdOfPlacement("0-1-3")).toBe("0-1-3");
  });
  it("strips a ::block consolidation suffix back to the row id", () => {
    expect(rowIdOfPlacement("0-1-3::block")).toBe("0-1-3");
  });
});

describe("groupPlacementsByStop", () => {
  const stops = new Map<string, number>([
    ["0-0-0", 0],
    ["0-0-1", 0],
    ["0-0-2", 1],
    ["0-0-3", 2],
  ]);

  it("buckets one van's placements by stop, in ascending stop order", () => {
    const groups = groupPlacementsByStop([van(INTERIOR_A, "0-0-2", "0-0-0", "0-0-1")], stops);
    expect(groups.map((g) => g.stopIndex)).toEqual([0, 1]);
    expect(groups[0]!.placements).toHaveLength(2); // stop 0 has two rows
    expect(groups[1]!.placements).toHaveLength(1);
    expect(groups[0]!.interior).toBe(INTERIOR_A);
  });

  it("attributes a consolidated block via its stripped row id", () => {
    const groups = groupPlacementsByStop([van(INTERIOR_A, "0-0-3::block")], stops);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.stopIndex).toBe(2);
  });

  it("puts untagged cargo in a trailing null bucket, never dropping it", () => {
    const groups = groupPlacementsByStop([van(INTERIOR_A, "0-0-0", "9-9-9")], stops);
    expect(groups.map((g) => g.stopIndex)).toEqual([0, null]);
    expect(groups[1]!.placements[0]!.itemId).toBe("9-9-9");
  });

  it("keeps each van separate so positions match the interior shown", () => {
    const groups = groupPlacementsByStop(
      [van(INTERIOR_A, "0-0-0"), van(INTERIOR_B, "0-0-0", "0-0-2")],
      stops,
    );
    // Same stop 0 appears in both vans as distinct cards with distinct interiors.
    expect(groups.map((g) => g.key)).toEqual(["0:0", "1:0", "1:1"]);
    expect(groups[0]!.interior).toBe(INTERIOR_A);
    expect(groups[1]!.interior).toBe(INTERIOR_B);
  });

  it("returns [] for an empty fleet", () => {
    expect(groupPlacementsByStop([], stops)).toEqual([]);
  });
});
