/**
 * Fallback RouteProvider when no Google Maps key is configured.
 * Geocodes addresses via Nominatim (OSM) then computes haversine straight-line distance.
 * Duration is estimated at a configured average speed (FALLBACK_AVG_SPEED_MPH) —
 * good enough for cost modelling, not real scheduling.
 *
 * All Nominatim access goes through the shared, rate-limited, cached geocoder so a multi-stop
 * chain (or concurrent quotes) can't burst past Nominatim's ≤1 req/s policy.
 */
import { getConfig } from "@/config/env";
import type { Leg, Route } from "@/lib/pricing/types";
import { geocode, type Coord } from "./nominatim-geocoder";
import { RoutingError } from "./types";
import type { RouteChainOptions, RouteChainResult, RouteProvider } from "./types";

const EARTH_MILES = 3958.8;

function haversineMiles(a: Coord, b: Coord): number {
  const toRad = (d: number) => d * (Math.PI / 180);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return EARTH_MILES * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export class StraightLineProvider implements RouteProvider {
  async getRoute(origin: string, destination: string): Promise<Route> {
    const from = await geocode(origin);
    const to = await geocode(destination);
    const distanceMiles = haversineMiles(from, to);
    const durationSeconds = this.estimateSeconds(distanceMiles);
    return {
      origin,
      destination,
      distanceMiles,
      durationSeconds,
      distanceMethod: "straight-line",
      legs: [{ from: origin, to: destination, distanceMiles, durationSeconds, distanceMethod: "straight-line" }],
    };
  }

  async getRouteChain(waypoints: string[], opts: RouteChainOptions = {}): Promise<RouteChainResult> {
    if (waypoints.length < 2) {
      throw new RoutingError("A route chain needs at least a pickup and one stop");
    }
    const returnToOrigin = opts.returnToOrigin ?? true;
    // Straight-line can't solve for the drive-optimal order (that's a Google Routes feature);
    // it always honours the given order. optimizeOrder is silently ignored here by design.
    const coords = await Promise.all(waypoints.map((w) => geocode(w)));

    // Visiting sequence of addresses: pickup → stops in order → (back to pickup).
    const visited = [...waypoints];
    if (returnToOrigin) visited.push(waypoints[0]!);

    const legs: Leg[] = [];
    for (let i = 0; i < visited.length - 1; i++) {
      const from = visited[i]!;
      const to = visited[i + 1]!;
      const fromCoord = (i < waypoints.length ? coords[i] : coords[0])!;
      const toCoord = (i + 1 < waypoints.length ? coords[i + 1] : coords[0])!;
      const distanceMiles = haversineMiles(fromCoord, toCoord);
      legs.push({
        from,
        to,
        distanceMiles,
        durationSeconds: this.estimateSeconds(distanceMiles),
        distanceMethod: "straight-line",
      });
    }

    return {
      route: this.assemble(waypoints, legs),
      order: waypoints.slice(1).map((_, i) => i + 1),
    };
  }

  private estimateSeconds(distanceMiles: number): number {
    return Math.round((distanceMiles / getConfig().routing.fallbackAvgSpeedMph) * 3600);
  }

  private assemble(waypoints: string[], legs: Leg[]): Route {
    return {
      origin: waypoints[0]!,
      destination: waypoints[waypoints.length - 1]!, // last real stop, never the return-to-origin
      distanceMiles: legs.reduce((s, l) => s + l.distanceMiles, 0),
      durationSeconds: legs.reduce((s, l) => s + l.durationSeconds, 0),
      distanceMethod: "straight-line",
      legs,
    };
  }
}
