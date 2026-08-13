/**
 * Route-provider decorator that memoises identical lookups (swap-seam: wraps ANY
 * RouteProvider without the callers knowing). A quote is often priced more than
 * once for the same addresses — the operator tweaks van selection or rate
 * overrides and re-runs — and today each re-run re-hits the map provider (a paid,
 * latency-bearing call) for a distance that cannot have changed. Keyed on the
 * exact address set, this returns the SAME Route the inner provider would have,
 * so no quote or price can differ — only the repeat network call is skipped.
 *
 * Bounded LRU (config `ROUTE_CACHE_MAX_ENTRIES`): a long-running server must not
 * grow this map without limit, so the least-recently-used key is evicted past the
 * cap. Cached values are frozen on store — the inner provider hands back a fresh
 * object per call today, so freezing preserves that "a caller can't mutate another
 * quote's route" guarantee once the object is shared.
 */
import type { Route } from "@/lib/pricing/types";
import type { RouteChainOptions, RouteChainResult, RouteProvider } from "./types";

/** Key separator — a NUL byte never appears in an address, so joined keys can't collide. */
const SEP = String.fromCharCode(0);

/** Freeze a Route (and its legs) so a shared cached instance is immutable. */
function freezeRoute(route: Route): Route {
  route.legs.forEach((leg) => Object.freeze(leg));
  Object.freeze(route.legs);
  return Object.freeze(route);
}

export class CachingRouteProvider implements RouteProvider {
  private readonly routeCache = new Map<string, Route>();
  private readonly chainCache = new Map<string, RouteChainResult>();

  constructor(
    private readonly inner: RouteProvider,
    private readonly maxEntries: number,
  ) {}

  async getRoute(origin: string, destination: string): Promise<Route> {
    const key = origin + SEP + destination;
    const hit = this.touch(this.routeCache, key);
    if (hit) return hit;
    const route = freezeRoute(await this.inner.getRoute(origin, destination));
    this.store(this.routeCache, key, route);
    return route;
  }

  async getRouteChain(waypoints: string[], opts: RouteChainOptions = {}): Promise<RouteChainResult> {
    // The visiting order and the options change the route, so both are part of the key.
    const returnToOrigin = opts.returnToOrigin ?? true;
    const optimizeOrder = opts.optimizeOrder ?? false;
    const key = [returnToOrigin, optimizeOrder, ...waypoints].join(SEP);
    const hit = this.touch(this.chainCache, key);
    if (hit) return hit;
    const result = await this.inner.getRouteChain(waypoints, opts);
    freezeRoute(result.route);
    Object.freeze(result);
    this.store(this.chainCache, key, result);
    return result;
  }

  /** LRU read: re-insert the hit key so it counts as most-recently-used. */
  private touch<V>(cache: Map<string, V>, key: string): V | undefined {
    const value = cache.get(key);
    if (value !== undefined) {
      cache.delete(key);
      cache.set(key, value);
    }
    return value;
  }

  /** Insert, then evict the least-recently-used key once the map exceeds the cap. */
  private store<V>(cache: Map<string, V>, key: string, value: V): void {
    cache.set(key, value);
    if (cache.size > this.maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
}
