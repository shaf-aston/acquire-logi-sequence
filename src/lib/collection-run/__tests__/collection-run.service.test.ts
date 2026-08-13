/**
 * Collection-run service — proves the loop shape the driver actually gets: waypoints
 * [hub, pickups…, hub], pickups read back in VISIT order, catchment verdicts advisory
 * (flagged, never blocked), and every fail-loud gate (unknown hub, address-less hub,
 * short visit order) actually throws instead of shipping a partial plan.
 */
import { describe, it, expect } from "vitest";
import { planCollectionRun, CollectionRunError, type CollectionRunDeps } from "../collection-run.service";
import { collectionValidator } from "@/lib/stop-chain/validator";
import { InMemoryHubRepository } from "@/lib/groupage/hub.repository";
import { InMemoryVanRepository } from "@/lib/packing/van.repository";
import type { RouteChainOptions, RouteChainResult, RouteProvider } from "@/lib/routing/types";
import type { Van } from "@/lib/packing/packing.types";
import type { Hub } from "@/lib/groupage/groupage.types";

const TRUCK: Van = {
  id: "truck",
  label: "Collection Truck",
  interior: { l: 6.0, w: 2.4, h: 2.4 },
  maxPayloadKg: 5000,
  perMileRate: 2.5,
};

const HUBS: Hub[] = [
  { id: "hub-mid", name: "Birmingham", catchment: ["CV", "B"], address: "Unit 3, Hams Hall, B46 1AL" },
  { id: "hub-nw", name: "Manchester", catchment: ["M"], address: "Trafford Park, M17 1AB" },
  { id: "hub-bare", name: "No Address Depot", catchment: ["LS"] },
];

/** Fake provider that records the exact chain request and returns a fixed 3-leg loop. */
function fakeDeps(order: number[], captured: { waypoints?: string[]; opts?: RouteChainOptions }): CollectionRunDeps {
  const provider: RouteProvider = {
    getRoute: async () => {
      throw new Error("unused");
    },
    getRouteChain: async (waypoints, opts) => {
      captured.waypoints = waypoints;
      captured.opts = opts;
      const legs = waypoints.slice(1).map((to, i) => ({
        from: waypoints[i]!,
        to,
        distanceMiles: 4,
        durationSeconds: 600,
        distanceMethod: "road" as const,
      }));
      const chain: RouteChainResult = {
        route: {
          origin: waypoints[0]!,
          destination: waypoints[waypoints.length - 2]!,
          distanceMiles: 4 * legs.length,
          durationSeconds: 600 * legs.length,
          distanceMethod: "road",
          legs,
        },
        order,
      };
      return chain;
    },
  };
  return {
    hubs: new InMemoryHubRepository(HUBS),
    vans: new InMemoryVanRepository([TRUCK]),
    chain: { routeProvider: provider, validate: collectionValidator },
  };
}

// Two pickups: one in the hub's own catchment, one in ANOTHER hub's catchment.
const IN_AREA = "12 Warwick Rd, Coventry CV1 2AB";
const OTHER_AREA = "5 Deansgate, Manchester M3 4LY";
const NO_POSTCODE = "The Old Mill, somewhere rural";
/** Wrap bare addresses as pickups (the run takes { address, company? } objects). */
const pk = (...addrs: string[]) => addrs.map((address) => ({ address }));

describe("planCollectionRun", () => {
  it("routes hub → pickups → hub, honours the optimized visit order, and prices the loop", async () => {
    const captured: { waypoints?: string[]; opts?: RouteChainOptions } = {};
    // order [2,1]: visit the SECOND pickup first (1-based indices into the waypoint list).
    const res = await planCollectionRun(
      { hubId: "hub-mid", pickups: pk(IN_AREA, OTHER_AREA), vanId: "truck" },
      fakeDeps([2, 1], captured),
    );

    // The loop: hub first, hub again as the pinned terminal waypoint — never a return-leg hack.
    expect(captured.waypoints).toEqual(["Unit 3, Hams Hall, B46 1AL", IN_AREA, OTHER_AREA, "Unit 3, Hams Hall, B46 1AL"]);
    expect(captured.opts?.returnToOrigin).toBe(false);
    expect(captured.opts?.optimizeOrder).toBe(true); // collectionRun config default

    // Pickups come back in VISIT order (Manchester first per order [2,1]).
    expect(res.orderedStops.map((s) => s.address)).toEqual([OTHER_AREA, IN_AREA]);
    expect(res.hub).toEqual({ id: "hub-mid", name: "Birmingham", address: "Unit 3, Hams Hall, B46 1AL" });

    // Whole loop priced: 3 legs × 4 mi at £2.50/mi ⇒ distance cost ≥ £30, total above that.
    expect(res.quote.route.distanceMiles).toBe(12);
    expect(res.quote.total).toBeGreaterThan(30 - 1e-9);
    expect(res.quote.vans).toHaveLength(1);
  });

  it("flags catchment verdicts without blocking: own-area in, other-hub out (named), no-postcode unknown", async () => {
    const res = await planCollectionRun(
      { hubId: "hub-mid", pickups: pk(IN_AREA, OTHER_AREA, NO_POSTCODE), vanId: "truck" },
      fakeDeps([1, 2, 3], {}),
    );

    const byAddress = new Map(res.orderedStops.map((s) => [s.address, s]));
    expect(byAddress.get(IN_AREA)).toMatchObject({ postcodeArea: "CV", inCatchment: true, owningHubId: "hub-mid" });
    expect(byAddress.get(OTHER_AREA)).toMatchObject({ postcodeArea: "M", inCatchment: false, owningHubId: "hub-nw" });
    expect(byAddress.get(NO_POSTCODE)).toMatchObject({ postcodeArea: null, inCatchment: false, owningHubId: null });

    // Advisory, not a gate: the run still quotes, with a warning naming the count.
    expect(res.quote.total).toBeGreaterThan(0);
    expect(res.warnings.join(" ")).toMatch(/2 pickups are outside Birmingham's catchment/);
  });

  it("carries the company label from pickup to its ordered verdict (unlabelled ⇒ null)", async () => {
    const res = await planCollectionRun(
      {
        hubId: "hub-mid",
        pickups: [{ address: IN_AREA, company: "Acme Ltd" }, { address: OTHER_AREA }],
        vanId: "truck",
      },
      fakeDeps([1, 2], {}),
    );
    const byAddress = new Map(res.orderedStops.map((s) => [s.address, s]));
    expect(byAddress.get(IN_AREA)?.company).toBe("Acme Ltd");
    expect(byAddress.get(OTHER_AREA)?.company).toBeNull();
  });

  it("fails loud on an unknown hub and on a hub with no storage address", async () => {
    await expect(
      planCollectionRun({ hubId: "ghost", pickups: pk(IN_AREA), vanId: "truck" }, fakeDeps([1], {})),
    ).rejects.toThrow(/Unknown hub/);

    const bare = planCollectionRun({ hubId: "hub-bare", pickups: pk(IN_AREA), vanId: "truck" }, fakeDeps([1], {}));
    await expect(bare).rejects.toThrow(/no storage address/);
    await expect(bare).rejects.toBeInstanceOf(CollectionRunError);
  });

  it("refuses a visit order that lost a pickup instead of shipping a partial plan", async () => {
    // Provider claims only pickup 1 was visited — pickup 2 would silently vanish from the run.
    await expect(
      planCollectionRun(
        { hubId: "hub-mid", pickups: pk(IN_AREA, OTHER_AREA), vanId: "truck" },
        fakeDeps([1], {}),
      ),
    ).rejects.toThrow(/covered 1 of 2 pickups/);
  });
});
