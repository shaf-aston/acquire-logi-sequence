import { describe, expect, it } from "vitest";
import { haversineKm, nearestHubId } from "../nearest-hub";

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm({ lat: 51.5, lng: -0.12 }, { lat: 51.5, lng: -0.12 })).toBeCloseTo(0, 5);
  });

  it("matches the known London–Manchester distance (~260km)", () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const manchester = { lat: 53.4808, lng: -2.2426 };
    expect(haversineKm(london, manchester)).toBeCloseTo(262, -1);
  });
});

describe("nearestHubId", () => {
  const hubs = [
    { id: "hub-london", lat: 51.5, lng: -0.12 },
    { id: "hub-manchester", lat: 53.48, lng: -2.24 },
    { id: "hub-newcastle", lat: 54.97, lng: -1.61 },
  ];

  it("picks the closest hub to a point near Leeds (nearer Manchester than Newcastle or London)", () => {
    expect(nearestHubId({ lat: 53.8, lng: -1.55 }, hubs)).toBe("hub-manchester");
  });

  it("picks the closest hub to a point right on a hub's own centroid", () => {
    expect(nearestHubId({ lat: 54.97, lng: -1.61 }, hubs)).toBe("hub-newcastle");
  });

  it("returns null when no hubs are given", () => {
    expect(nearestHubId({ lat: 51.5, lng: -0.12 }, [])).toBeNull();
  });
});
