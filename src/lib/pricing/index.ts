/**
 * Stage 5 orchestrator. Loads the van, fetches the route, calculates the quote.
 * Mirrors packer.service.ts in shape: perf-tracked, structured logging, injectable deps.
 */
import { createLogger } from "@/lib/logger/logger";
import { PerfTracker, type PerfReport } from "@/lib/perf/tracker";
import { getConfig } from "@/config/env";
import { getRouteProvider, type RouteProvider } from "@/lib/routing";
import { FileVanRepository, InMemoryVanRepository, type VanRepository } from "@/lib/packing/van.repository";
import type { Van } from "@/lib/packing/packing.types";
import { calculateQuote, withFlatFee, hubHandlingLineItem, PricingError } from "./calculator";
import type { Quote } from "./types";

export { PricingError };
export type { Quote } from "./types";

const logger = createLogger("pricing.service");

/**
 * Optional per-quote rate overrides — the operator's "Quote settings" tweaks. Any field
 * left undefined falls back to the config default (`getConfig().routing`). Session-scoped:
 * they travel with one request and are NEVER written back to config. Validated at the API
 * boundary; a missing field means "use the default", not "zero".
 */
export interface RateOverrides {
  readonly driverHourlyRate?: number;
  readonly loadUnloadMinutesPerVan?: number;
  readonly returnFactor?: number;
  readonly fragilitySurchargePerItem?: number;
}

export interface QuoteJobInput {
  /** Every van on the job, in load order. Repeats allowed (two of the same model). */
  readonly vanIds: string[];
  readonly origin: string;
  readonly destination: string;
  readonly fragileCount: number;
  /** Payload kg per van, index-aligned with vanIds. Enables fuel line items in the quote. */
  readonly vanPayloads?: number[];
  /** Client-supplied fleet override (the session "Fleet setup" catalogue) — mirrors
   *  PackJobInput.vans so a session-only or in-session-edited van prices correctly
   *  instead of being re-resolved (and possibly missed, or stale) against config/vans.json. */
  readonly vans?: Van[];
  /** Session rate tweaks from the "Quote settings" panel; undefined ⇒ config defaults. */
  readonly rateOverrides?: RateOverrides;
  /**
   * Optional hub address to route THROUGH (cross-dock / store-and-forward): the run goes
   * origin → hub → destination instead of straight there, and a hub-handling fee
   * (config `routing.hubHandling` — base + per-weight-block) is added. Undefined ⇒ a direct quote.
   */
  readonly viaHub?: string;
}

export interface QuoteJobResult {
  readonly quote: Quote;
  readonly perf: PerfReport;
}

export interface PricingServiceDeps {
  readonly vanRepository: VanRepository;
  readonly routeProvider: RouteProvider;
}

/** Default wiring: file-backed fleet (or a client-supplied override) + route provider. */
function defaultDeps(vans?: Van[]): PricingServiceDeps {
  return {
    vanRepository: vans && vans.length > 0 ? new InMemoryVanRepository(vans) : new FileVanRepository(),
    routeProvider: getRouteProvider(),
  };
}

export async function getQuote(
  input: QuoteJobInput,
  deps: PricingServiceDeps = defaultDeps(input.vans),
): Promise<QuoteJobResult> {
  const perf = new PerfTracker(logger);
  const cfg = getConfig().routing;
  // Session overrides win per-field; anything unset falls back to the config default.
  const o = input.rateOverrides ?? {};
  const driverHourlyRate = o.driverHourlyRate ?? cfg.driverHourlyRate;
  const loadUnloadMinutesPerVan = o.loadUnloadMinutesPerVan ?? cfg.loadUnloadMinutesPerVan;
  const returnFactor = o.returnFactor ?? cfg.returnFactor;
  const fragilitySurchargePerItem = o.fragilitySurchargePerItem ?? cfg.fragilitySurchargePerItem;

  const vans = await perf.track("load-vans", async () => {
    if (input.vanIds.length === 0) throw new PricingError("no van ids supplied");
    return Promise.all(
      input.vanIds.map(async (id) => {
        const v = await deps.vanRepository.getVan(id);
        if (!v) throw new PricingError(`unknown van id "${id}"`);
        return v;
      }),
    );
  });

  const viaHub = input.viaHub?.trim();
  const route = await perf.track("route", () =>
    viaHub
      ? // Cross-dock detour: route origin → hub → destination in one chain call, one-way (the
        // returnFactor below still bills the round trip over the whole via-hub distance).
        deps.routeProvider
          .getRouteChain([input.origin, viaHub, input.destination], {
            returnToOrigin: false,
            optimizeOrder: false,
          })
          .then((r) => r.route)
      : deps.routeProvider.getRoute(input.origin, input.destination),
  );

  let quote = calculateQuote(
    route,
    vans,
    input.fragileCount,
    fragilitySurchargePerItem,
    cfg.currencySymbol,
    input.vanPayloads,
    returnFactor,
    { hourlyRate: driverHourlyRate, loadUnloadMinutesPerVan },
  );
  if (viaHub) {
    // Hub handling scales with the load weight (base + per-weight-block). Total = Σ per-van payloads.
    const totalWeightKg = (input.vanPayloads ?? []).reduce((s, w) => s + (w > 0 ? w : 0), 0);
    const fee = hubHandlingLineItem(totalWeightKg, cfg.hubHandling, cfg.currencySymbol);
    quote = withFlatFee(quote, fee.label, fee.amount);
  }

  logger.info("quote generated", {
    vanIds: input.vanIds,
    origin: input.origin,
    destination: input.destination,
    distanceMiles: Math.round(route.distanceMiles * 10) / 10,
    total: Math.round(quote.total * 100) / 100,
  });

  return { quote, perf: perf.report() };
}
