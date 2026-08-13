import { getConfig } from "@/config/env";
import { CachingRouteProvider } from "./caching.provider";
import { GoogleMapsProvider } from "./google-maps.provider";
import { StraightLineProvider } from "./straight-line.provider";
import { RoutingError } from "./types";
import type { RouteProvider } from "./types";
export { RoutingError } from "./types";
export type { RouteProvider } from "./types";

let cached: RouteProvider | null = null;

export function getRouteProvider(): RouteProvider {
  if (cached) return cached;
  const { provider, googleMapsApiKey, cache } = getConfig().routing;
  if (provider !== "google") {
    throw new RoutingError(`Unknown ROUTE_PROVIDER: "${provider}" — only "google" is supported`);
  }
  // No API key → fall back to straight-line haversine (modelled scenario).
  const inner = googleMapsApiKey ? new GoogleMapsProvider() : new StraightLineProvider();
  // Transparent memoisation of identical lookups (swap-seam decorator). Disable via config.
  cached = cache.enabled ? new CachingRouteProvider(inner, cache.maxEntries) : inner;
  return cached;
}

/** Reset the module-scope singleton — call between tests that stub routing config. */
export function __resetRouteProviderForTests(): void {
  cached = null;
}
