import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

describe("GoogleMapsProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Google Routes API v2 endpoint and parses distance/duration", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubEnv("MAPS_TIMEOUT_MS", "2500");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [{ distanceMeters: 32186.88, duration: "1800s" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GoogleMapsProvider } = await import("../google-maps.provider");
    const provider = new GoogleMapsProvider();
    const route = await provider.getRoute("London, UK", "Manchester, UK");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Goog-Api-Key": "test-key",
          "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
        }),
        body: JSON.stringify({
          origin: { address: "London, UK" },
          destination: { address: "Manchester, UK" },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
          computeAlternativeRoutes: false,
        }),
      }),
    );
    expect(route).toEqual({
      origin: "London, UK",
      destination: "Manchester, UK",
      durationSeconds: 1800,
      distanceMiles: 20,
      distanceMethod: "road",
      legs: [
        { from: "London, UK", to: "Manchester, UK", distanceMiles: 20, durationSeconds: 1800, distanceMethod: "road" },
      ],
    });
  });

  it("fails fast when the API key is missing", async () => {
    const { GoogleMapsProvider } = await import("../google-maps.provider");
    await expect(new GoogleMapsProvider().getRoute("A", "B")).rejects.toThrow(
      /GOOGLE_MAPS_API_KEY is not configured/,
    );
  });

  it("routes a whole chain in ONE call with per-leg mask, intermediates, and a drive-home leg", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            distanceMeters: 48280.32, // 30 mi total
            duration: "3600s",
            legs: [
              { distanceMeters: 16093.44, duration: "1200s" }, // P→A 10mi
              { distanceMeters: 16093.44, duration: "1200s" }, // A→B 10mi
              { distanceMeters: 16093.44, duration: "1200s" }, // B→P 10mi (home)
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GoogleMapsProvider } = await import("../google-maps.provider");
    const { route, order } = await new GoogleMapsProvider().getRouteChain(["P", "A", "B"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers["X-Goog-FieldMask"]).toContain("routes.legs.distanceMeters");
    const body = JSON.parse(init.body);
    expect(body.origin).toEqual({ address: "P" });
    expect(body.destination).toEqual({ address: "P" }); // drives home
    expect(body.intermediates).toEqual([{ address: "A" }, { address: "B" }]);

    expect(route.legs).toHaveLength(3);
    expect(route.legs[2]!.to).toBe("P"); // return leg home
    expect(route.destination).toBe("B"); // stored destination stays the last real stop
    expect(route.distanceMiles).toBeCloseTo(30, 5);
    expect(order).toEqual([1, 2]);
  });

  it("single-drop chain mirrors the outbound leg home (parity with today's ×2)", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            distanceMeters: 16093.44, // 10 mi outbound
            duration: "1200s",
            legs: [{ distanceMeters: 16093.44, duration: "1200s" }],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { GoogleMapsProvider } = await import("../google-maps.provider");
    const { route, order } = await new GoogleMapsProvider().getRouteChain(["P", "A"]);

    // One call, outbound only — the return is synthesised, never measured on asymmetric roads.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.destination).toEqual({ address: "A" });
    expect(body.intermediates ?? []).toEqual([]);

    expect(route.legs).toHaveLength(2);
    expect(route.legs[1]).toMatchObject({ from: "A", to: "P", distanceMiles: 10 });
    expect(route.distanceMiles).toBeCloseTo(20, 5); // exactly today's outbound ×2
    expect(route.durationSeconds).toBe(2400);
    expect(order).toEqual([1]);
  });
});
