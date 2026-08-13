/**
 * The stop-chain engine (§1A) — the reusable, model-agnostic core.
 *
 * Given an ordered stop list and the already-packed fleet, it: (1) validates the stop mix via the
 * injected validator, (2) routes the whole chain in ONE provider call — one-way, no return leg,
 * ending at the final stop (or an optional pinned custom destination), and (3) prices EVERY van in
 * the fleet on that shared route (one driver each). Every step is kind-blind; delivery/collection
 * differ only by the injected `validate`.
 *
 * Packing is NOT done here: the fleet was already packed by packer.service (`/api/pack`) and is
 * shown in the load panel. The chain reuses that fleet + its per-van payloads, exactly as the
 * single-drop fleet quote does — it only adds the multi-stop route and per-stop handling.
 *
 * Config-free by design: all tunables arrive through `job` so this stays pure core logic (the
 * factory in index.ts reads config and wires the real providers).
 *
 * Fail-loud (§4): a bad stop mix or a zero/failed leg throws {@link StopChainError} — never a
 * quote built on a gap.
 */
import type { Van } from "@/lib/packing/packing.types";
import type { Quote } from "@/lib/pricing/types";
import { calculateQuote } from "@/lib/pricing/calculator";
import type { RouteProvider } from "@/lib/routing";
import { StopChainError, type Stop } from "./stop.types";
import type { StopValidator } from "./validator";

/** One-way chain: the route already excludes any return leg, so billed distance = travelled distance. */
const CHAIN_RETURN_FACTOR = 1.0;

export interface StopChainPricingConfig {
  readonly fragilitySurchargePerItem: number;
  readonly currencySymbol: string;
  readonly driverHourlyRate: number;
  /** Per-van handling allowance (load at origin + unload), minutes. */
  readonly loadUnloadMinutesPerVan: number;
  /** Extra handling allowance charged per stop in the chain, minutes. */
  readonly loadUnloadMinutesPerStop: number;
}

export interface StopChainJob {
  /** Ordered stops. For delivery: [pickup, drop, drop, …]. Kind-mix enforced by the injected validator. */
  readonly stops: readonly Stop[];
  /** The whole fleet — every van drives the same route. Priced one driver each. */
  readonly vans: readonly Van[];
  /** Per-van payload (kg), aligned to `vans`, for the fuel line. Omitted ⇒ no fuel line. */
  readonly vanPayloads?: readonly number[];
  /** Count of fragile units on the load (client-supplied tally), for the fragility surcharge. */
  readonly fragileCount: number;
  /** Optional pinned final destination: a routing waypoint the run ENDS at (e.g. a depot). Not a
   *  delivery stop — it adds a leg but no handling. Absent ⇒ the last drop is the endpoint. */
  readonly finalDestination?: string;
  /** Optional hub the run cross-docks through FIRST: a pinned routing waypoint inserted right
   *  after the pickup (pickup → hub → drops…). Adds a leg, no per-stop handling — the flat hub fee
   *  is added by the service. Present ⇒ drop-order optimisation is forced off so the hub stays first. */
  readonly viaHub?: string;
  /** Drop ceiling (config maxStops). */
  readonly maxStops: number;
  /** Opt-in drive-optimal ordering of the intermediate drops (config). */
  readonly optimizeWaypointOrder: boolean;
  readonly pricing: StopChainPricingConfig;
}

export interface StopChainDeps {
  readonly routeProvider: RouteProvider;
  /** Injected Check-1 predicate (delivery / collection / …). */
  readonly validate: StopValidator;
}

export interface StopChainResult {
  readonly quote: Quote;
  /** Non-fatal notices shown loudly on the quote (e.g. a straight-line fallback under-prices). */
  readonly warnings: string[];
  /** The visited drop sequence as 0-based indices into the original drop list. Identity
   *  ([0,1,2,…]) unless the router re-ordered the waypoints — lets the UI show the picked path. */
  readonly visitOrder: number[];
}

export async function quoteStopChain(job: StopChainJob, deps: StopChainDeps): Promise<StopChainResult> {
  // 1) Check 1 — stop mix (injected).
  deps.validate(job.stops, job.maxStops);

  // 2) Route the whole chain in ONE call, one-way. An optional via-hub is pinned right after the
  //    pickup (pickup → hub → drops…); a pinned final destination (if any) is appended as the
  //    terminal waypoint. returnToOrigin:false ⇒ the provider fixes the last waypoint and optimises
  //    only the middle — so a via-hub run disables optimisation to keep the hub first, not reordered.
  const [pickup, ...drops] = job.stops;
  const leadingWaypoints = [pickup!.address, ...(job.viaHub ? [job.viaHub] : [])];
  const waypoints = [
    ...leadingWaypoints,
    ...drops.map((s) => s.address),
    ...(job.finalDestination ? [job.finalDestination] : []),
  ];
  const { route, order } = await deps.routeProvider.getRouteChain(waypoints, {
    returnToOrigin: false,
    optimizeOrder: job.viaHub ? false : job.optimizeWaypointOrder,
  });

  const warnings: string[] = [];
  for (const leg of route.legs) {
    if (!(leg.distanceMiles > 0)) {
      throw new StopChainError(
        "leg",
        `Leg ${leg.from} → ${leg.to} came back as ${leg.distanceMiles} miles — are these the same place? Check the addresses.`,
      );
    }
  }
  if (route.distanceMethod === "straight-line") {
    warnings.push(
      "Distances are straight-line estimates (the map service was unavailable) — the real driving quote will be higher.",
    );
  }

  // 3) Visit order of the REAL drops (0-based). `order` is 1-based waypoint indices (pickup = 0),
  //    so dropIndex = i - 1. Filter out the pickup (0) and the optional final-destination waypoint
  //    (index ≥ dropCount) — neither is a drop the UI reorders.
  const dropCount = job.stops.length - 1;
  const visitDropOrder = order.map((i) => i - 1).filter((di) => di >= 0 && di < dropCount);

  // 4) Price the whole fleet on the shared one-way route. returnFactor = 1.0 (no return leg exists);
  //    per-stop handling folded into the per-van allowance so extra stops cost driver time.
  const handlingMinutes =
    job.pricing.loadUnloadMinutesPerVan + job.pricing.loadUnloadMinutesPerStop * job.stops.length;

  const quote = calculateQuote(
    route,
    [...job.vans],
    job.fragileCount,
    job.pricing.fragilitySurchargePerItem,
    job.pricing.currencySymbol,
    job.vanPayloads ? [...job.vanPayloads] : undefined,
    CHAIN_RETURN_FACTOR,
    { hourlyRate: job.pricing.driverHourlyRate, loadUnloadMinutesPerVan: handlingMinutes },
  );

  return { quote, warnings, visitOrder: visitDropOrder };
}
