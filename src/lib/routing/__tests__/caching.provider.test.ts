import { describe, it, expect } from "vitest";
import { CachingRouteProvider } from "../caching.provider";
import type { Route } from "@/lib/pricing/types";
import type { RouteChainOptions, RouteChainResult, RouteProvider } from "../types";

/** A counting stub: every call is recorded, and each returns a distinct fresh Route. */
class SpyProvider implements RouteProvider {
  routeCalls: Array<[string, string]> = [];
  chainCalls: Array<{ waypoints: string[]; opts: RouteChainOptions }> = [];

  async getRoute(origin: string, destination: string): Promise<Route> {
    this.routeCalls.push([origin, destination]);
    const distanceMiles = this.routeCalls.length; // distinct per call, so a stale hit is detectable
    return {
      origin,
      destination,
      distanceMiles,
      durationSeconds: 60,
      distanceMethod: "road",
      legs: [{ from: origin, to: destination, distanceMiles, durationSeconds: 60, distanceMethod: "road" }],
    };
  }

  async getRouteChain(waypoints: string[], opts: RouteChainOptions = {}): Promise<RouteChainResult> {
    this.chainCalls.push({ waypoints, opts });
    const distanceMiles = this.chainCalls.length;
    return {
      route: {
        origin: waypoints[0]!,
        destination: waypoints[waypoints.length - 1]!,
        distanceMiles,
        durationSeconds: 60,
        distanceMethod: "road",
        legs: [{ from: waypoints[0]!, to: waypoints[1]!, distanceMiles, durationSeconds: 60, distanceMethod: "road" }],
      },
      order: [1],
    };
  }
}

describe("CachingRouteProvider.getRoute", () => {
  it("serves an identical repeat lookup from cache — inner called once, same value back", async () => {
    const spy = new SpyProvider();
    const cache = new CachingRouteProvider(spy, 256);

    const a = await cache.getRoute("Origin A", "Dest B");
    const b = await cache.getRoute("Origin A", "Dest B");

    expect(spy.routeCalls).toHaveLength(1); // second call hit the cache
    expect(b).toEqual(a);
    expect(b.distanceMiles).toBe(1);
  });

  it("keys on both addresses — different pairs each hit the inner provider", async () => {
    const spy = new SpyProvider();
    const cache = new CachingRouteProvider(spy, 256);

    await cache.getRoute("A", "B");
    await cache.getRoute("A", "C");
    await cache.getRoute("B", "A");

    expect(spy.routeCalls).toHaveLength(3);
  });

  it("does not collide when a space-containing address abuts the separator", async () => {
    const spy = new SpyProvider();
    const cache = new CachingRouteProvider(spy, 256);

    // "A B"+"C" vs "A"+"B C" would share the key "A B C" under a space separator.
    const first = await cache.getRoute("A B", "C");
    const second = await cache.getRoute("A", "B C");

    expect(spy.routeCalls).toHaveLength(2);
    expect(second.distanceMiles).not.toBe(first.distanceMiles);
  });

  it("evicts the least-recently-used pair past the cap", async () => {
    const spy = new SpyProvider();
    const cache = new CachingRouteProvider(spy, 2); // holds 2 pairs

    await cache.getRoute("A", "1"); // fills slot 1
    await cache.getRoute("B", "2"); // fills slot 2
    await cache.getRoute("A", "1"); // touch A→1, making B→2 the LRU
    await cache.getRoute("C", "3"); // over cap → evict B→2
    await cache.getRoute("A", "1"); // hit → A→1 survived (it was the touched one)
    await cache.getRoute("B", "2"); // must re-fetch (was evicted)

    const bFetches = spy.routeCalls.filter(([o]) => o === "B").length;
    const aFetches = spy.routeCalls.filter(([o]) => o === "A").length;
    expect(bFetches).toBe(2); // evicted then re-fetched
    expect(aFetches).toBe(1); // survived as most-recently-used
  });

  it("freezes the cached route so a consumer cannot mutate another quote's copy", async () => {
    const spy = new SpyProvider();
    const cache = new CachingRouteProvider(spy, 256);

    const route = await cache.getRoute("A", "B");
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(route.legs)).toBe(true);
  });
});

describe("CachingRouteProvider.getRouteChain", () => {
  it("caches on the waypoint sequence — a repeat is served from memory", async () => {
    const spy = new SpyProvider();
    const cache = new CachingRouteProvider(spy, 256);

    await cache.getRouteChain(["P", "S1", "S2"]);
    await cache.getRouteChain(["P", "S1", "S2"]);

    expect(spy.chainCalls).toHaveLength(1);
  });

  it("treats different options as different routes", async () => {
    const spy = new SpyProvider();
    const cache = new CachingRouteProvider(spy, 256);

    await cache.getRouteChain(["P", "S1"], { returnToOrigin: true });
    await cache.getRouteChain(["P", "S1"], { returnToOrigin: false });
    await cache.getRouteChain(["P", "S1"], { optimizeOrder: true });

    expect(spy.chainCalls).toHaveLength(3);
  });
});
