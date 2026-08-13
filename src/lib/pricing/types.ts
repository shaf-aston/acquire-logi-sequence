/** Stage 5 domain types — routing and pricing output shapes. */

/**
 * One leg of a journey (stop → next stop). A single-drop trip has one leg; a stop chain
 * has one per hop plus the return leg (last drop → origin). `distanceMethod` is per-leg so a
 * single leg falling back to a straight-line guess can be flagged without tainting the rest.
 */
export interface Leg {
  readonly from: string;
  readonly to: string;
  readonly distanceMiles: number;
  readonly durationSeconds: number;
  readonly distanceMethod: "road" | "straight-line";
}

export interface Route {
  readonly origin: string;
  readonly destination: string;
  /** Summed total across every leg (the return leg included). Existing readers use this untouched. */
  readonly distanceMiles: number;
  /** Summed total across every leg (the return leg included). Existing readers use this untouched. */
  readonly durationSeconds: number;
  /** How the distance was calculated. "road" = Google Maps driving distance; "straight-line" = haversine fallback. */
  readonly distanceMethod: "road" | "straight-line";
  /** Per-leg breakdown; totals above are the sum of these. Single-drop = one leg. */
  readonly legs: readonly Leg[];
}

export interface QuoteLineItem {
  readonly label: string;
  readonly amount: number;
}

/** One vehicle in a multi-van quote. `description` is the brand-free capability
 *  string; `id`/`label` are carried for the dedicated fleet-reference table. */
export interface QuoteVan {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly perMileRate: number;
  /** route.distanceMiles × perMileRate — this van's share of the distance cost. */
  readonly distanceCost: number;
  /** This van's CO₂ (kg) over the billed distance. 0 when unconfigured. */
  readonly co2Kg: number;
}

export interface Quote {
  readonly route: Route;
  /** Every vehicle on the job (per-van full-route pricing). */
  readonly vans: QuoteVan[];
  readonly lineItems: QuoteLineItem[];
  readonly subtotal: number;
  readonly surcharges: number;
  readonly total: number;
  /** Σ co2Kg across every van. Undefined when no van in the fleet has a
   *  co2GramsPerMile figure configured — omit the carbon line, don't show a false zero. */
  readonly co2TotalKg?: number;
}
