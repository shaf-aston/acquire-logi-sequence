import { beforeEach, describe, expect, it, vi } from "vitest";

describe("getRouteProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('returns the Google Maps provider when ROUTE_PROVIDER="google" and key is set', async () => {
    vi.stubEnv("ROUTE_PROVIDER", "google");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");
    vi.stubEnv("ROUTE_CACHE_ENABLED", "false"); // assert the concrete selection, not the cache wrapper

    const { getRouteProvider } = await import("../index");
    const provider = getRouteProvider();

    expect(provider.constructor.name).toBe("GoogleMapsProvider");
  });

  it("falls back to StraightLineProvider when GOOGLE_MAPS_API_KEY is not set", async () => {
    vi.stubEnv("ROUTE_PROVIDER", "google");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    vi.stubEnv("ROUTE_CACHE_ENABLED", "false");

    const { getRouteProvider } = await import("../index");
    const provider = getRouteProvider();

    expect(provider.constructor.name).toBe("StraightLineProvider");
  });

  it("wraps the selected provider in the caching decorator when the cache is enabled (default)", async () => {
    vi.stubEnv("ROUTE_PROVIDER", "google");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-key");

    const { getRouteProvider } = await import("../index");
    const provider = getRouteProvider();

    expect(provider.constructor.name).toBe("CachingRouteProvider");
  });

  it("rejects unsupported providers", async () => {
    vi.stubEnv("ROUTE_PROVIDER", "foo");

    const { getRouteProvider } = await import("../index");
    expect(() => getRouteProvider()).toThrow(/only "google" is supported/);
  });
});
