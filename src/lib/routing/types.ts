import type { Route } from "@/lib/pricing/types";

export interface RouteChainOptions {
  /** Append a final leg back to `waypoints[0]` (the drive home, counted once). Default true. */
  readonly returnToOrigin?: boolean;
  /** Ask the provider for the drive-optimal order of the intermediate stops. Default false. */
  readonly optimizeOrder?: boolean;
}

export interface RouteChainResult {
  /** Legs (in visiting order, return leg last if requested) + summed totals. `destination` is the last real stop, never the return-to-origin. */
  readonly route: Route;
  /**
   * Visiting order of the stops after the pickup, as original `waypoints` indices (1-based into `waypoints`).
   * Identity `[1,2,…,n]` unless the provider re-optimised the order. Drives the packing bands.
   */
  readonly order: number[];
}

export interface RouteProvider {
  /** One-way origin→destination leg. The return trip is applied downstream via `returnFactor`. */
  getRoute(origin: string, destination: string): Promise<Route>;
  /**
   * Route an ordered chain of `waypoints` = [pickup, stop₁, …, stopₙ] in ONE call, returning per-leg
   * distance+time plus summed totals. The stored `route.destination` stays the last real stop; the
   * optional drive-home leg (→ `waypoints[0]`) is the final entry in `route.legs`.
   */
  getRouteChain(waypoints: string[], opts?: RouteChainOptions): Promise<RouteChainResult>;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(`[routing] ${message}`);
    this.name = "RoutingError";
  }
}
