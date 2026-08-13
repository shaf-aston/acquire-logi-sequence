/**
 * Google Maps Routes API v2 implementation of RouteProvider.
 * Server-side only — GOOGLE_MAPS_API_KEY must never reach the client bundle.
 *
 * Endpoint: POST routes.googleapis.com/directions/v2:computeRoutes
 * Field mask: request only the fields we bill for (distance + duration, plus per-leg for chains).
 * Accepts plain-text address strings — no separate Geocoding API call needed.
 *
 * A whole stop chain is ONE request: origin + intermediates[] + destination. This keeps the call
 * count at 1 regardless of stop count (Routes Advanced tier, ~2× a single leg — still far cheaper
 * than N separate calls).
 */
import { getConfig } from "@/config/env";
import type { Leg, Route } from "@/lib/pricing/types";
import { RoutingError } from "./types";
import type { RouteChainOptions, RouteChainResult, RouteProvider } from "./types";

const ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = "routes.distanceMeters,routes.duration";
const CHAIN_FIELD_MASK =
  "routes.distanceMeters,routes.duration,routes.legs.distanceMeters,routes.legs.duration";
const METRES_PER_MILE = 1609.344;

interface ApiLeg {
  distanceMeters?: number;
  duration?: string;
}
interface RoutesApiResponse {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string; // e.g. "3600s"
    legs?: ApiLeg[];
    optimizedIntermediateWaypointIndex?: number[];
  }>;
  error?: { message: string };
}

/** Parse a proto Duration string like "3600s" → 3600. */
function parseDurationSeconds(duration: string): number {
  const seconds = Number.parseInt(duration.replace("s", ""), 10);
  if (!Number.isFinite(seconds)) {
    throw new RoutingError(`Routes API returned unparseable duration: "${duration}"`);
  }
  return seconds;
}

export class GoogleMapsProvider implements RouteProvider {
  async getRoute(origin: string, destination: string): Promise<Route> {
    const data = await this.call(FIELD_MASK, {
      origin: { address: origin },
      destination: { address: destination },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      computeAlternativeRoutes: false,
    });

    const route = data.routes?.[0];
    if (!route) throw new RoutingError("Routes API returned no routes");
    if (route.distanceMeters == null || route.duration == null) {
      throw new RoutingError("Routes API returned no distance/duration");
    }

    const distanceMiles = route.distanceMeters / METRES_PER_MILE;
    const durationSeconds = parseDurationSeconds(route.duration);
    return {
      origin,
      destination,
      distanceMiles,
      durationSeconds,
      distanceMethod: "road",
      legs: [{ from: origin, to: destination, distanceMiles, durationSeconds, distanceMethod: "road" }],
    };
  }

  async getRouteChain(waypoints: string[], opts: RouteChainOptions = {}): Promise<RouteChainResult> {
    if (waypoints.length < 2) {
      throw new RoutingError("A route chain needs at least a pickup and one stop");
    }
    const returnToOrigin = opts.returnToOrigin ?? true;
    const optimize = opts.optimizeOrder ?? false;

    const pickup = waypoints[0]!;
    const lastStop = waypoints[waypoints.length - 1]!;

    // Single-drop parity: with one drop, today's price doubles the OUTBOUND leg — it never
    // measures drop→pickup separately (asymmetric roads would drift the number). Route just the
    // outbound and mirror it for the drive home, so maxStops=1 matches today exactly.
    if (waypoints.length === 2 && returnToOrigin) {
      const { route } = await this.getRouteChain(waypoints, { ...opts, returnToOrigin: false });
      const out = route.legs![0]!;
      const back: Leg = { ...out, from: out.to, to: out.from };
      return {
        route: {
          ...route,
          distanceMiles: out.distanceMiles * 2,
          durationSeconds: out.durationSeconds * 2,
          legs: [out, back],
        },
        order: [1],
      };
    }
    // returnToOrigin: every stop is an intermediate and we drive home to the pickup.
    // otherwise: the last stop is the destination and only the middle ones are intermediates.
    const intermediateAddrs = returnToOrigin
      ? waypoints.slice(1)
      : waypoints.slice(1, waypoints.length - 1);
    const apiDestination = returnToOrigin ? pickup : lastStop;

    const fieldMask = optimize
      ? `${CHAIN_FIELD_MASK},routes.optimizedIntermediateWaypointIndex`
      : CHAIN_FIELD_MASK;

    const data = await this.call(fieldMask, {
      origin: { address: pickup },
      destination: { address: apiDestination },
      intermediates: intermediateAddrs.map((address) => ({ address })),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      computeAlternativeRoutes: false,
      optimizeWaypointOrder: optimize,
    });

    const route = data.routes?.[0];
    if (!route) throw new RoutingError("Routes API returned no routes");
    if (!route.legs?.length) throw new RoutingError("Routes API returned no per-leg breakdown");

    // Resolve the visiting order of the intermediates (identity unless Google re-optimised).
    const perm =
      optimize && route.optimizedIntermediateWaypointIndex?.length === intermediateAddrs.length
        ? route.optimizedIntermediateWaypointIndex
        : intermediateAddrs.map((_, i) => i);
    const visitedIntermediates = perm.map((i) => intermediateAddrs[i]!);

    // Full travelled address sequence, one entry per node the van actually visits.
    const travelSeq = [pickup, ...visitedIntermediates, apiDestination];
    if (route.legs.length !== travelSeq.length - 1) {
      throw new RoutingError(
        `Routes API returned ${route.legs.length} legs for ${travelSeq.length - 1} hops`,
      );
    }

    const legs: Leg[] = route.legs.map((leg, i) => {
      if (leg.distanceMeters == null || leg.duration == null) {
        throw new RoutingError(`Routes API leg ${i + 1} missing distance/duration`);
      }
      return {
        from: travelSeq[i]!,
        to: travelSeq[i + 1]!,
        distanceMiles: leg.distanceMeters / METRES_PER_MILE,
        durationSeconds: parseDurationSeconds(leg.duration),
        distanceMethod: "road",
      };
    });

    // Visiting order of the stops-after-pickup, as original 1-based waypoint indices.
    const order = perm.map((i) => i + 1);
    if (!returnToOrigin) order.push(waypoints.length - 1); // the destination stop wasn't an intermediate

    const assembled: Route = {
      origin: pickup,
      destination: lastStop, // stays the last real stop, never the return-to-origin
      distanceMiles: legs.reduce((s, l) => s + l.distanceMiles, 0),
      durationSeconds: legs.reduce((s, l) => s + l.durationSeconds, 0),
      distanceMethod: "road",
      legs,
    };
    return { route: assembled, order };
  }

  /** Shared POST wrapper: auth, field mask, timeout, HTTP + JSON error handling. */
  private async call(fieldMask: string, body: unknown): Promise<RoutesApiResponse> {
    const cfg = getConfig().routing;
    if (!cfg.googleMapsApiKey) {
      throw new RoutingError("GOOGLE_MAPS_API_KEY is not configured");
    }

    let res: Response;
    try {
      res = await fetch(ROUTES_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": cfg.googleMapsApiKey,
          "X-Goog-FieldMask": fieldMask,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new RoutingError(`Routes API request failed: ${String(err)}`);
    }

    let data: RoutesApiResponse;
    try {
      data = (await res.json()) as RoutesApiResponse;
    } catch {
      throw new RoutingError("Routes API returned invalid JSON");
    }

    if (!res.ok) {
      throw new RoutingError(`Routes API HTTP ${res.status}: ${data.error?.message ?? "unknown error"}`);
    }
    return data;
  }
}
