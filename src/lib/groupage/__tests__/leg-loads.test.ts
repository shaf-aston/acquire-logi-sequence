import { describe, it, expect } from "vitest";
import { routePallets, legLoads } from "../leg-loads";
import { buildPath, buildDirectPath } from "../path-builder";
import { stationsOf } from "../trunk-stops";
import { checkPath } from "../capacity";
import { computeDemand } from "../demand";
import { GroupageError, type GroupagePallet, type Hub } from "../groupage.types";

const MID: Hub = { id: "hub-mid", name: "Birmingham", catchment: ["CV", "B"] };
const NW: Hub = { id: "hub-nw", name: "Manchester", catchment: ["M"] };
const SCOT: Hub = { id: "hub-scot", name: "Glasgow", catchment: ["G"] };

const UNITS = { full: 1, half: 0.5, quarter: 0.25, oversize: 2 } as const;

/** Every leg capped at 10 spaces, so "a full truck" is 10 full pallets on any leg. */
const CFG = {
  legCapacity: {
    collect: { palletSpaces: 10, maxPayloadKg: 3500 },
    trunk: { palletSpaces: 10, maxPayloadKg: 24000 },
    deliver: { palletSpaces: 10, maxPayloadKg: 3500 },
  },
  maxTrunkHops: 3,
};

const oneStopPath = () => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW]);
const noStopPath = () => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG);
const localPath = () => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "B15 2TT", hub: MID }, CFG);

/** Load a path's legs, the way the service does. */
function loadsFor(path: ReturnType<typeof oneStopPath>, pallets: readonly GroupagePallet[]) {
  return legLoads(routePallets(pallets, stationsOf(path)), path, UNITS);
}

const full = (quantity: number, extra: Partial<GroupagePallet> = {}): GroupagePallet => ({
  footprint: "full",
  weightKg: 100,
  quantity,
  ...extra,
});

describe("routePallets", () => {
  it("defaults a line with no station refs to origin → destination", () => {
    const [p] = routePallets([full(1)], stationsOf(oneStopPath()));
    expect(p).toMatchObject({ boardStation: 0, alightStation: 2 });
  });

  it("resolves explicit join/leave stations to indices", () => {
    const stations = stationsOf(oneStopPath());
    const [join, leave] = routePallets([full(1, { joinAtHubId: "hub-nw" }), full(1, { leaveAtHubId: "hub-nw" })], stations);
    expect(join).toMatchObject({ boardStation: 1, alightStation: 2 });
    expect(leave).toMatchObject({ boardStation: 0, alightStation: 1 });
  });

  it("rejects a station ref on a route with no trunk stations", () => {
    expect(() => routePallets([full(1, { joinAtHubId: "hub-nw" })], stationsOf(localPath()))).toThrow(
      /names a trunk stop, but this route has no trunk stations/,
    );
    expect(() => routePallets([full(1, { leaveAtHubId: "hub-nw" })], stationsOf(buildDirectPath("CV1 2AB", "G1 1AA", CFG)))).toThrow(
      /no trunk stations/,
    );
  });

  it("rejects a station that is not on this route, naming the chain", () => {
    expect(() => routePallets([full(1, { joinAtHubId: "hub-ne" })], stationsOf(oneStopPath()))).toThrow(
      /"hub-ne" is not a stop on this route.*Birmingham → Manchester → Glasgow/s,
    );
  });

  it("rejects a line that leaves before it joins", () => {
    expect(() => routePallets([full(1, { joinAtHubId: "hub-nw", leaveAtHubId: "hub-mid" })], stationsOf(oneStopPath()))).toThrow(
      /cannot leave before, or at, where it joins/,
    );
  });

  it("rejects a line that leaves exactly where it joins", () => {
    expect(() =>
      routePallets([full(1, { joinAtHubId: "hub-nw", leaveAtHubId: "hub-nw" })], stationsOf(oneStopPath())),
    ).toThrow(/cannot leave before, or at, where it joins/);
  });
});

describe("legLoads", () => {
  it("stop-free hub path: every leg carries the whole booking", () => {
    const path = noStopPath();
    const pallets = [full(3), { footprint: "half", weightKg: 200, quantity: 2 } as GroupagePallet];
    const demand = computeDemand(pallets, UNITS, 52, 1500);
    expect(loadsFor(path, pallets)).toEqual([demand, demand, demand]);
  });

  it("local path: both legs carry the whole booking", () => {
    const path = localPath();
    const pallets = [full(3)];
    const loads = loadsFor(path, pallets);
    expect(loads).toHaveLength(2);
    expect(loads.every((l) => l.palletCount === 3)).toBe(true);
  });

  it("a line joining at a stop is absent from collect and from the first hop", () => {
    const path = oneStopPath();
    const loads = loadsFor(path, [full(2), full(5, { joinAtHubId: "hub-nw" })]);
    // legs: collect, trunk(MID→NW), trunk(NW→SCOT), deliver
    expect(loads.map((l) => l.palletCount)).toEqual([2, 2, 7, 7]);
  });

  it("a line leaving at a stop is absent from the last hop and from deliver", () => {
    const path = oneStopPath();
    const loads = loadsFor(path, [full(2), full(5, { leaveAtHubId: "hub-nw" })]);
    expect(loads.map((l) => l.palletCount)).toEqual([7, 7, 2, 2]);
  });

  it("drop 4 / join 4 on a full truck FITS — the freed space is resold at the stop", () => {
    const path = oneStopPath();
    const pallets = [
      full(6), // rides the whole trunk
      full(4, { leaveAtHubId: "hub-nw" }), // alights at the stop
      full(4, { joinAtHubId: "hub-nw" }), // boards at the stop, taking the freed space
    ];
    const loads = loadsFor(path, pallets);
    // Both hops run at exactly the 10-space ceiling; the union (14) never rides together.
    expect(loads.map((l) => l.footprints)).toEqual([10, 10, 10, 10]);
    expect(checkPath(loads, path).fits).toBe(true);
    // Proof the per-leg model is load-bearing: the whole booking would NOT fit on one leg.
    expect(computeDemand(pallets, UNITS, 52, 1500).footprints).toBe(14);
    expect(checkPath(path.legs.map(() => computeDemand(pallets, UNITS, 52, 1500)), path).fits).toBe(false);
  });

  it("fails loud when no pallets travel a hop", () => {
    const path = oneStopPath();
    expect(() => loadsFor(path, [full(2, { leaveAtHubId: "hub-nw" })])).toThrow(
      /No pallets travel Manchester → Glasgow\. Remove that stop, or load freight for the hop\./,
    );
  });

  it("fails loud when nothing leaves the origin", () => {
    const path = oneStopPath();
    expect(() => loadsFor(path, [full(2, { joinAtHubId: "hub-nw" })])).toThrow(/No pallets leave CV1 2AB/);
  });

  it("fails loud on a stop where nothing joins or leaves", () => {
    const path = oneStopPath();
    expect(() => loadsFor(path, [full(3)])).toThrow(/Stop 1 \(Manchester\) has no pallets joining or leaving/);
  });

  it("re-asserts the routed-pallet invariant rather than trusting the type", () => {
    const path = oneStopPath();
    const bogus = [{ ...full(1), boardStation: 0, alightStation: 9, lineNumber: 1 }];
    expect(() => legLoads(bogus, path, UNITS)).toThrow(/out-of-range itinerary.*This is a bug/s);
  });

  it("throws GroupageError with check 'stops'", () => {
    try {
      loadsFor(oneStopPath(), [full(3)]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GroupageError);
      expect((e as GroupageError).check).toBe("stops");
    }
  });
});
