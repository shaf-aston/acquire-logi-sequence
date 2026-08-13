import { describe, it, expect } from "vitest";
import { quoteStopChain, type StopChainDeps, type StopChainJob } from "@/lib/stop-chain/engine";
import { deliveryValidator } from "@/lib/stop-chain/validator";
import { StopChainError, type Stop } from "@/lib/stop-chain/stop.types";
import type { RouteChainOptions, RouteChainResult, RouteProvider } from "@/lib/routing/types";
import { makeVan } from "@/lib/packing/__tests__/fixtures";

const pricing = {
  fragilitySurchargePerItem: 5,
  currencySymbol: "£",
  driverHourlyRate: 15,
  loadUnloadMinutesPerVan: 45,
  loadUnloadMinutesPerStop: 15,
};

function providerReturning(result: RouteChainResult): RouteProvider {
  return {
    getRoute: async () => {
      throw new Error("getRoute should not be called by the chain engine");
    },
    getRouteChain: async () => result,
  };
}

/** Captures the waypoints + options the engine hands the router, to assert the routing contract. */
function capturingProvider(result: RouteChainResult) {
  const calls: { waypoints: string[]; opts: RouteChainOptions }[] = [];
  const provider: RouteProvider = {
    getRoute: async () => {
      throw new Error("unused");
    },
    getRouteChain: async (waypoints, opts = {}) => {
      calls.push({ waypoints, opts });
      return result;
    },
  };
  return { provider, calls };
}

function deps(provider: RouteProvider): StopChainDeps {
  return { routeProvider: provider, validate: deliveryValidator };
}

// One-way P → A(10mi) → B(5mi): 15mi / 900s, no return leg. B is the endpoint.
const roadChain: RouteChainResult = {
  route: {
    origin: "P",
    destination: "B",
    distanceMiles: 15,
    durationSeconds: 900,
    distanceMethod: "road",
    legs: [
      { from: "P", to: "A", distanceMiles: 10, durationSeconds: 600, distanceMethod: "road" },
      { from: "A", to: "B", distanceMiles: 5, durationSeconds: 300, distanceMethod: "road" },
    ],
  },
  order: [1, 2],
};

const stops: Stop[] = [
  { address: "P", kind: "pickup" },
  { address: "A", kind: "drop" },
  { address: "B", kind: "drop" },
];

function job(overrides: Partial<StopChainJob> = {}): StopChainJob {
  return {
    stops,
    vans: [makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1500, perMileRate: 1.5 })],
    vanPayloads: [40],
    fragileCount: 0,
    maxStops: 3,
    optimizeWaypointOrder: false,
    pricing,
    ...overrides,
  };
}

describe("quoteStopChain", () => {
  it("prices the chain one-way (returnFactor 1.0, no return leg)", async () => {
    const { quote, warnings, visitOrder } = await quoteStopChain(
      job(),
      deps(providerReturning(roadChain)),
    );

    expect(warnings).toHaveLength(0);
    expect(quote.route.distanceMiles).toBe(15);
    // billed distance = 15 × 1.0 × perMileRate(1.5); no round-trip doubling.
    expect(quote.vans[0]!.distanceCost).toBeCloseTo(15 * 1.5, 6);
    expect(quote.total).toBeGreaterThan(0);
    expect(visitOrder).toEqual([0, 1]);
  });

  it("prices the WHOLE fleet on the shared route — one driver per van", async () => {
    const vans = [
      makeVan({ id: "vanA", interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1500, perMileRate: 1.5 }),
      makeVan({ id: "vanB", interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1500, perMileRate: 2.0 }),
    ];
    const { quote } = await quoteStopChain(
      job({ vans, vanPayloads: [40, 30] }),
      deps(providerReturning(roadChain)),
    );
    expect(quote.vans).toHaveLength(2);
    expect(quote.vans[0]!.distanceCost).toBeCloseTo(15 * 1.5, 6);
    expect(quote.vans[1]!.distanceCost).toBeCloseTo(15 * 2.0, 6);
    // Labour bills one driver per van, so two vans cost strictly more than one.
    const one = await quoteStopChain(job({ vans: [vans[0]!], vanPayloads: [40] }), deps(providerReturning(roadChain)));
    expect(quote.total).toBeGreaterThan(one.quote.total);
  });

  it("appends a pinned final destination as the terminal waypoint, no return", async () => {
    const { provider, calls } = capturingProvider({ ...roadChain, order: [1, 2, 3] });
    const { visitOrder } = await quoteStopChain(
      job({ finalDestination: "DEPOT" }),
      deps(provider),
    );
    expect(calls[0]!.waypoints).toEqual(["P", "A", "B", "DEPOT"]);
    expect(calls[0]!.opts.returnToOrigin).toBe(false);
    // The depot is a routing waypoint, not a drop — it never appears in the drop visit order.
    expect(visitOrder).toEqual([0, 1]);
  });

  it("inserts a via-hub right after the pickup and forces optimisation off", async () => {
    const { provider, calls } = capturingProvider({ ...roadChain, order: [1, 2, 3] });
    await quoteStopChain(
      job({ viaHub: "HUB", optimizeWaypointOrder: true }),
      deps(provider),
    );
    // Pickup → hub → drops: the hub is a pinned leading waypoint, not reordered.
    expect(calls[0]!.waypoints).toEqual(["P", "HUB", "A", "B"]);
    expect(calls[0]!.opts.optimizeOrder).toBe(false);
  });

  it("stops and names a zero-mile leg (Check 3)", async () => {
    const zeroLeg: RouteChainResult = {
      ...roadChain,
      route: {
        ...roadChain.route,
        legs: [
          { from: "P", to: "A", distanceMiles: 0, durationSeconds: 0, distanceMethod: "road" },
          ...roadChain.route.legs.slice(1),
        ],
      },
    };
    await expect(
      quoteStopChain(job(), deps(providerReturning(zeroLeg))),
    ).rejects.toMatchObject({ check: "leg" });
  });

  it("flags a straight-line fallback loudly instead of hiding it", async () => {
    const slChain: RouteChainResult = {
      ...roadChain,
      route: {
        ...roadChain.route,
        distanceMethod: "straight-line",
        legs: roadChain.route.legs.map((l) => ({ ...l, distanceMethod: "straight-line" as const })),
      },
    };
    const { warnings } = await quoteStopChain(job(), deps(providerReturning(slChain)));
    expect(warnings.join(" ")).toMatch(/straight-line/i);
  });

  it("rejects an invalid stop mix before routing (Check 1)", async () => {
    const { provider, calls } = capturingProvider(roadChain);
    await expect(
      quoteStopChain(job({ stops: [{ address: "P", kind: "pickup" }] }), deps(provider)),
    ).rejects.toBeInstanceOf(StopChainError);
    expect(calls).toHaveLength(0);
  });
});
