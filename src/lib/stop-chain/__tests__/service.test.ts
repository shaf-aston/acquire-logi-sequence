import { describe, it, expect } from "vitest";
import { getChainQuote } from "@/lib/stop-chain/service";
import { deliveryValidator } from "@/lib/stop-chain/validator";
import type { StopChainDeps } from "@/lib/stop-chain/engine";
import type { RouteChainResult, RouteProvider } from "@/lib/routing/types";
import type { Van } from "@/lib/packing/packing.types";

const BIG_VAN: Van = {
  id: "big",
  label: "Big Van",
  interior: { l: 6.0, w: 2.4, h: 2.4 },
  maxPayloadKg: 5000,
  perMileRate: 2.5,
};

function fakeDeps(chain: RouteChainResult): StopChainDeps {
  const provider: RouteProvider = {
    getRoute: async () => {
      throw new Error("unused");
    },
    getRouteChain: async () => chain,
  };
  return { routeProvider: provider, validate: deliveryValidator };
}

// One-way P → D (10mi), no return leg.
const chain: RouteChainResult = {
  route: {
    origin: "P",
    destination: "D",
    distanceMiles: 10,
    durationSeconds: 600,
    distanceMethod: "road",
    legs: [{ from: "P", to: "D", distanceMiles: 10, durationSeconds: 600, distanceMethod: "road" }],
  },
  order: [1],
};

describe("getChainQuote (service wiring)", () => {
  it("loads the fleet by id and prices the chain end to end", async () => {
    const res = await getChainQuote(
      {
        stops: [{ address: "P", kind: "pickup" }, { address: "D", kind: "drop" }],
        vanIds: ["big"],
        vanPayloads: [1000],
        fragileCount: 0,
        vans: [BIG_VAN],
      },
      fakeDeps(chain),
    );

    expect(res.quote.route.distanceMiles).toBe(10);
    expect(res.quote.vans).toHaveLength(1);
    expect(res.quote.total).toBeGreaterThan(0);
    expect(res.perf.spans.length).toBeGreaterThan(0);
  });

  it("prices every van id in the fleet", async () => {
    const secondVan: Van = { ...BIG_VAN, id: "big2", label: "Big Van 2", perMileRate: 3.0 };
    const res = await getChainQuote(
      {
        stops: [{ address: "P", kind: "pickup" }, { address: "D", kind: "drop" }],
        vanIds: ["big", "big2"],
        vanPayloads: [1000, 800],
        fragileCount: 0,
        vans: [BIG_VAN, secondVan],
      },
      fakeDeps(chain),
    );
    expect(res.quote.vans.map((v) => v.id)).toEqual(["big", "big2"]);
  });

  it("fails loud on an unknown van id", async () => {
    await expect(
      getChainQuote(
        {
          stops: [{ address: "P", kind: "pickup" }, { address: "D", kind: "drop" }],
          vanIds: ["ghost"],
          vanPayloads: [0],
          fragileCount: 0,
          vans: [BIG_VAN],
        },
        fakeDeps(chain),
      ),
    ).rejects.toThrow(/unknown van id/i);
  });
});
