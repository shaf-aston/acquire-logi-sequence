/**
 * Stop-chain service — loads the fleet, reads config, and runs the engine. Mirrors
 * pricing.service in shape: perf-tracked, structured logging, injectable deps. No business logic
 * lives here — that's the engine's job.
 *
 * The chain reuses the fleet the caller already packed (`/api/pack`), exactly as the single-drop
 * fleet quote does: it takes van ids + per-van payloads + a fragile tally, never re-assembles or
 * re-packs the load.
 */
import { createLogger } from "@/lib/logger/logger";
import { PerfTracker, type PerfReport } from "@/lib/perf/tracker";
import { getConfig } from "@/config/env";
import {
  FileVanRepository,
  InMemoryVanRepository,
  type VanRepository,
} from "@/lib/packing/van.repository";
import type { Van } from "@/lib/packing/packing.types";
import { PricingError, type RateOverrides } from "@/lib/pricing";
import { withFlatFee, hubHandlingLineItem } from "@/lib/pricing/calculator";
import { createDeliveryStopChain, quoteStopChain } from "./index";
import type { StopChainDeps, StopChainResult } from "./engine";
import type { Stop } from "./stop.types";

const logger = createLogger("stop-chain.service");

export interface ChainQuoteInput {
  /** Ordered stops. For delivery: [pickup, drop, drop, …]. */
  readonly stops: Stop[];
  /** The whole fleet (van ids) that carries the load — all drive the same route. */
  readonly vanIds: string[];
  /** Per-van payload (kg), aligned to `vanIds`, for the fuel line. Undefined ⇒ no fuel line. */
  readonly vanPayloads?: number[];
  /** Count of fragile units on the load (client tally), for the fragility surcharge. */
  readonly fragileCount: number;
  /** Optional pinned final destination address the run ends at (routing only, no handling). */
  readonly finalDestination?: string;
  /** Optional hub address to cross-dock through first (pickup → hub → drops…). Adds a routing leg
   *  plus the hub-handling fee (config `routing.hubHandling` — base + per-weight-block). Undefined ⇒ no hub. */
  readonly viaHub?: string;
  /** Client-supplied fleet override (session catalogue), validated at the API boundary. */
  readonly vans?: Van[];
  /** Per-request opt-in: let the router pick the cheapest visiting order. Overrides the
   *  config default (`multiStop.optimizeWaypointOrder`) only when explicitly supplied. */
  readonly optimizeWaypointOrder?: boolean;
  /** Session rate tweaks from the "Quote settings" panel; undefined ⇒ config defaults.
   *  `returnFactor` is ignored here — a one-way chain has no return leg. */
  readonly rateOverrides?: RateOverrides;
}

export interface ChainQuoteResult {
  readonly quote: StopChainResult["quote"];
  readonly warnings: string[];
  readonly visitOrder: number[];
  readonly perf: PerfReport;
}

export async function getChainQuote(
  input: ChainQuoteInput,
  deps: StopChainDeps = createDeliveryStopChain(),
): Promise<ChainQuoteResult> {
  const perf = new PerfTracker(logger);
  const cfg = getConfig();

  const vans = await perf.track("load-vans", async () => {
    const repo: VanRepository =
      input.vans && input.vans.length > 0 ? new InMemoryVanRepository(input.vans) : new FileVanRepository();
    const loaded: Van[] = [];
    for (const id of input.vanIds) {
      const v = await repo.getVan(id);
      if (!v) throw new PricingError(`unknown van id "${id}"`);
      loaded.push(v);
    }
    return loaded;
  });

  // Fuel line needs one payload per van; a length mismatch means the client's tally is untrustworthy,
  // so drop the fuel line rather than misalign it (mirrors the single-drop fleet quote).
  const vanPayloads =
    input.vanPayloads && input.vanPayloads.length === vans.length ? input.vanPayloads : undefined;

  const result = await perf.track("chain", () =>
    quoteStopChain(
      {
        stops: input.stops,
        vans,
        vanPayloads,
        fragileCount: input.fragileCount,
        finalDestination: input.finalDestination,
        viaHub: input.viaHub?.trim() || undefined,
        maxStops: cfg.multiStop.maxStops,
        // Per-request override wins; fall back to the config default when not supplied.
        optimizeWaypointOrder: input.optimizeWaypointOrder ?? cfg.multiStop.optimizeWaypointOrder,
        pricing: {
          // Session overrides win per-field; anything unset falls back to config. returnFactor
          // is deliberately not overridable here — a one-way chain has no return leg.
          fragilitySurchargePerItem:
            input.rateOverrides?.fragilitySurchargePerItem ?? cfg.routing.fragilitySurchargePerItem,
          currencySymbol: cfg.routing.currencySymbol,
          driverHourlyRate: input.rateOverrides?.driverHourlyRate ?? cfg.routing.driverHourlyRate,
          loadUnloadMinutesPerVan:
            input.rateOverrides?.loadUnloadMinutesPerVan ?? cfg.routing.loadUnloadMinutesPerVan,
          loadUnloadMinutesPerStop: cfg.multiStop.loadUnloadMinutesPerStop,
        },
      },
      deps,
    ),
  );

  // Cross-dock handling: base + per-weight-block fee on top of the routed distance, when via a hub.
  let quote = result.quote;
  if (input.viaHub?.trim()) {
    const totalWeightKg = (input.vanPayloads ?? []).reduce((s, w) => s + (w > 0 ? w : 0), 0);
    const fee = hubHandlingLineItem(totalWeightKg, cfg.routing.hubHandling, cfg.routing.currencySymbol);
    quote = withFlatFee(result.quote, fee.label, fee.amount);
  }

  logger.info("chain quote generated", {
    stops: input.stops.length,
    vans: vans.length,
    viaHub: Boolean(input.viaHub?.trim()),
    distanceMiles: Math.round(quote.route.distanceMiles * 10) / 10,
    total: Math.round(quote.total * 100) / 100,
  });

  return { ...result, quote, perf: perf.report() };
}
