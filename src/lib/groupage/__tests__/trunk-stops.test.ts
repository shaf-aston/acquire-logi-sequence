import { describe, it, expect } from "vitest";
import { resolveStops, stationsOf } from "../trunk-stops";
import { buildPath, buildDirectPath } from "../path-builder";
import { GroupageError, type Hub } from "../groupage.types";

const HUBS: Hub[] = [
  { id: "hub-mid", name: "Birmingham", catchment: ["CV", "B"] },
  { id: "hub-nw", name: "Manchester", catchment: ["M"] },
  { id: "hub-ne", name: "Leeds", catchment: ["LS"] },
  { id: "hub-scot", name: "Glasgow", catchment: ["G"] },
];
const [MID, NW, NE, SCOT] = HUBS as [Hub, Hub, Hub, Hub];
const CFG = {
  legCapacity: {
    collect: { palletSpaces: 10, maxPayloadKg: 3500 },
    trunk: { palletSpaces: 26, maxPayloadKg: 24000 },
    deliver: { palletSpaces: 10, maxPayloadKg: 3500 },
  },
  maxTrunkHops: 3,
};

describe("resolveStops", () => {
  it("resolves ordered ids to hubs", () => {
    expect(resolveStops(["hub-nw", "hub-ne"], HUBS, MID, SCOT).map((h) => h.id)).toEqual(["hub-nw", "hub-ne"]);
  });
  it("empty in, empty out", () => {
    expect(resolveStops([], HUBS, MID, SCOT)).toEqual([]);
  });
  it("fails loud on an unknown hub id, listing the known ones", () => {
    expect(() => resolveStops(["nowhere"], HUBS, MID, SCOT)).toThrow(/no hub with id "nowhere".*Known hubs: hub-mid, hub-nw/s);
  });
  it("fails loud on a repeated stop", () => {
    expect(() => resolveStops(["hub-nw", "hub-nw"], HUBS, MID, SCOT)).toThrow(/Stop 2 \(hub-nw\) appears twice/);
  });
  it("fails loud when a stop is the origin hub", () => {
    expect(() => resolveStops(["hub-mid"], HUBS, MID, SCOT)).toThrow(/is the origin hub/);
  });
  it("fails loud when a stop is the destination hub", () => {
    expect(() => resolveStops(["hub-scot"], HUBS, MID, SCOT)).toThrow(/is the destination hub/);
  });
  it("throws GroupageError with check 'stops'", () => {
    try {
      resolveStops(["nowhere"], HUBS, MID, SCOT);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GroupageError);
      expect((e as GroupageError).check).toBe("stops");
    }
  });
});

describe("stationsOf", () => {
  it("hub path with stops → origin, stops…, destination", () => {
    const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW, NE]);
    expect(stationsOf(path).map((h) => h.id)).toEqual(["hub-mid", "hub-nw", "hub-ne", "hub-scot"]);
  });
  it("hub path with no stops → the two end hubs", () => {
    const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG);
    expect(stationsOf(path).map((h) => h.id)).toEqual(["hub-mid", "hub-scot"]);
  });
  it("local path has no stations (no trunk to stop on)", () => {
    const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "B15 2TT", hub: MID }, CFG);
    expect(stationsOf(path)).toEqual([]);
  });
  it("direct path has no stations", () => {
    expect(stationsOf(buildDirectPath("CV1 2AB", "G1 1AA", CFG))).toEqual([]);
  });
});
