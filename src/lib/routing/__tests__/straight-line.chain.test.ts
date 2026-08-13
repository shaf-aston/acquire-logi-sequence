import { describe, it, expect, vi } from "vitest";

// Bypass the rate-limited network geocoder with fixed coordinates so the chain math is exercised fast.
vi.mock("../nominatim-geocoder", () => {
  const coords: Record<string, { lat: number; lon: number }> = {
    P: { lat: 51.5, lon: -0.12 }, // London
    A: { lat: 52.48, lon: -1.9 }, // Birmingham
    B: { lat: 53.48, lon: -2.24 }, // Manchester
  };
  return {
    geocode: vi.fn(async (address: string) => {
      const c = coords[address];
      if (!c) throw new Error(`no coord for ${address}`);
      return c;
    }),
  };
});

describe("StraightLineProvider.getRouteChain", () => {
  it("returns a leg per hop plus the drive-home leg, honouring the given order", async () => {
    const { StraightLineProvider } = await import("../straight-line.provider");
    const { route, order } = await new StraightLineProvider().getRouteChain(["P", "A", "B"]);

    // P→A, A→B, B→P
    expect(route.legs).toHaveLength(3);
    expect(route.legs.map((l) => [l.from, l.to])).toEqual([
      ["P", "A"],
      ["A", "B"],
      ["B", "P"],
    ]);
    expect(route.destination).toBe("B"); // last real stop, not the return-to-origin
    expect(route.distanceMethod).toBe("straight-line");
    expect(order).toEqual([1, 2]);

    // Totals are the sum of the legs.
    const sum = route.legs.reduce((s, l) => s + l.distanceMiles, 0);
    expect(route.distanceMiles).toBeCloseTo(sum, 6);
    expect(route.distanceMiles).toBeGreaterThan(0);
  });

  it("omits the home leg when returnToOrigin is false", async () => {
    const { StraightLineProvider } = await import("../straight-line.provider");
    const { route } = await new StraightLineProvider().getRouteChain(["P", "A", "B"], {
      returnToOrigin: false,
    });
    expect(route.legs.map((l) => [l.from, l.to])).toEqual([
      ["P", "A"],
      ["A", "B"],
    ]);
  });
});
