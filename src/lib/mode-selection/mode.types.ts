/**
 * Domain types for the quotation-driven mode decision (the "decision matrix").
 *
 * A quotation yields two independent signals — how many delivery addresses it
 * carries, and how full a van the load would fill — and the selector turns those
 * into a recommendation on two axes: multi-stop vs single, and share-a-truck
 * (hubs / groupage) vs a dedicated van. The recommendation is ALWAYS advisory and
 * always carries its plain-language reasons, so the UI surfaces the "why" and the
 * operator can override — it never silently routes a quote.
 *
 * Pure types only (no imports, no I/O) so both server and client can use them.
 */

/** Tunable thresholds that turn quotation signals into a mode. Sourced from config (env.ts modeSelection). */
export interface ModeRules {
  /** Delivery-address count at or above which a job is treated as multi-stop. */
  readonly minDropsForMultiStop: number;
  /**
   * Van volume-fill fraction (0..1) below which a single-van load counts as a
   * part-load — the point at which sharing a truck through hubs typically beats a
   * dedicated van.
   */
  readonly partLoadFillThreshold: number;
}

/**
 * Which way the job runs: a delivery (one pickup → many drops) or a collection
 * (many pickups → one depot). The two are mirror configs of the same routing
 * engine. Direction is DECLARED by the operator/intake — it is not guessed here,
 * because a bare list of addresses is genuinely ambiguous (drops or pickups?).
 */
export type Direction = "deliver" | "collect";

/** The raw signals read off a quotation + its load plan. */
export interface ModeSignals {
  /**
   * The declared job direction. Defaults to "deliver" when omitted, so existing
   * delivery callers are unaffected.
   */
  readonly direction?: Direction;
  /** Distinct delivery addresses detected in the quotation PDF. */
  readonly dropCount: number;
  /**
   * Distinct PICKUP stops when collecting — the collect-direction mirror of
   * `dropCount`. Ignored (and may be omitted) for a delivery. Defaults to 0.
   */
  readonly pickupCount?: number;
  /** Whether the whole load fits one van (from packing). */
  readonly fitsInSingleVan: boolean;
  /**
   * Volume fill (0..1) of the van that would carry the load; `null` before the
   * load plan is known, which is why the hubs axis reports low confidence then.
   */
  readonly vanFillFraction: number | null;
  /** Cargo units the packer could place — 0 means there is nothing to judge yet. */
  readonly packableUnits: number;
  /** Cargo the packer could not carry (oversized / missing dimensions). */
  readonly unplacedCount: number;
}

/** How the load is carried: a dedicated van (FTL, per-mile) vs a shared/pooled truck (LTL, per pallet-space). */
export type LoadSharing = "dedicated" | "shared";

/** How the load is routed: straight door-to-door vs cross-docked through a 3PL hub. */
export type Routing = "direct" | "via-hub";

/** The advisory output — a recommendation per axis, the reasons behind them, and how sure we are. */
export interface ModeRecommendation {
  /**
   * Load-sharing axis: "shared" recommends a shared/pooled truck over a dedicated van for a
   * part-load. This is the axis the old `hubs` boolean really measured.
   */
  readonly loadSharing: LoadSharing;
  /**
   * Routing axis: "via-hub" recommends cross-docking through a 3PL hub. Advisory-only and
   * defaults to "direct" — no current signal forces a hub, and the operator chooses per quote.
   */
  readonly routing: Routing;
  /**
   * @deprecated Derived alias of `loadSharing === "shared"`, kept so existing readers compile.
   * Prefer `loadSharing` (sharing) and `routing` (hub vs direct) — hubs and sharing are now
   * independent axes, not one boolean.
   */
  readonly hubs: boolean;
  /** Recommend multi-stop routing (several delivery drops, or several pickups when collecting). */
  readonly multiStop: boolean;
  /**
   * The effective job direction (echoes the declared `signals.direction`, default
   * "deliver"). Carried so the UI can label the flow and bind the direction toggle.
   */
  readonly direction: Direction;
  /** Plain-language "why" lines — always shown to the operator, never hidden. */
  readonly reasons: string[];
  /** "low" when a signal is missing/weak (e.g. no load plan yet) so the UI can soften the nudge. */
  readonly confidence: "high" | "low";
}
