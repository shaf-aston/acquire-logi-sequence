/**
 * Groupage quote service — orchestrates the blueprint's Part-1 machine end to end:
 *   1.1 resolve hubs → (freight profile) demand → 1.2 build path → 1.3 dual-capacity check →
 *   1.4 price → assemble the quote (with its committed ETA).
 *
 * Mirrors `stop-chain/service` in shape: perf-tracked, structured logging, injectable deps. No
 * business logic lives here — each numbered step is its own pure module; this only sequences them.
 */
import { createLogger } from "@/lib/logger/logger";
import { PerfTracker, type PerfReport } from "@/lib/perf/tracker";
import { getConfig } from "@/config/env";
import { resolveHub, resolveHubOrNull } from "./hub-resolver";
import { buildPath, buildDirectPath } from "./path-builder";
import { computeDemand, sumDemand } from "./demand";
import { assertPathFits, checkPath, oversizeLines } from "./capacity";
import { priceGroupage } from "./pricing";
import { resolveStops, stationsOf } from "./trunk-stops";
import { legBuckets, routePallets } from "./leg-loads";
import { FileHubRepository, type HubRepository } from "./hub.repository";
import { loadGroupageRates, type GroupageRates } from "./groupage-rates";
import { GroupageError, type GroupagePallet, type GroupagePath, type GroupageQuote, type GroupageRouting } from "./groupage.types";

const logger = createLogger("groupage.service");

export interface GroupageQuoteInput {
  readonly originPostcode: string;
  readonly destinationPostcode: string;
  readonly pallets: readonly GroupagePallet[];
  /**
   * How to route the shared load. `via-hub` cross-docks at a hub (needs a hub at each end —
   * fail-loud on a catchment gap); `direct` is a hubless move on another carrier, quotable for any postcode.
   * Omitted ⇒ the config default (`groupage.defaultRouting`), keeping existing callers working.
   */
  readonly routing?: GroupageRouting;
  /** Committed ETA — a GIVEN INPUT under the deferred-timetable boundary; echoed onto the quote. */
  readonly eta?: string | null;
  /**
   * Optional company/customer label. Not used for pricing — `getGroupageQuote` ignores it — but
   * carried so the API route can persist it on the saved consignment that feeds the shared-truck
   * planner's "recent quotes" pick-list.
   */
  readonly customerName?: string;
  /**
   * Ordered intermediate trunk stops (hub ids) — the "train stops" the trunk calls at between the
   * origin and destination hubs. Omitted/empty ⇒ a point-to-point trunk, exactly as before. Which
   * pallet lines board or alight at each stop is carried on the lines themselves
   * (`GroupagePallet.joinAtHubId` / `leaveAtHubId`).
   */
  readonly trunkStopHubIds?: readonly string[];
}

export interface GroupageDeps {
  readonly hubs: HubRepository;
  readonly loadRates: () => Promise<GroupageRates>;
  readonly config: {
    readonly maxTrunkHops: number;
    readonly maxPalletsPerBooking: number;
    readonly currencySymbol: string;
    /** Routing used when the caller doesn't specify one. */
    readonly defaultRouting: GroupageRouting;
  };
}

export interface GroupageQuoteResult {
  readonly quote: GroupageQuote;
  readonly perf: PerfReport;
}

/** Production wiring: file-backed hub network + validated rate card + config knobs. */
export function createGroupageDeps(): GroupageDeps {
  const cfg = getConfig();
  return {
    hubs: new FileHubRepository(),
    loadRates: loadGroupageRates,
    config: {
      maxTrunkHops: cfg.groupage.maxTrunkHops,
      maxPalletsPerBooking: cfg.groupage.maxPalletsPerBooking,
      currencySymbol: cfg.routing.currencySymbol,
      defaultRouting: cfg.groupage.defaultRouting,
    },
  };
}

export async function getGroupageQuote(
  input: GroupageQuoteInput,
  deps: GroupageDeps = createGroupageDeps(),
): Promise<GroupageQuoteResult> {
  const perf = new PerfTracker(logger);

  const { hubs, rates } = await perf.track("load", async () => {
    const [hubs, rates] = await Promise.all([deps.hubs.listHubs(), deps.loadRates()]);
    return { hubs, rates };
  });

  const routing: GroupageRouting = input.routing ?? deps.config.defaultRouting;

  // Stops only exist on a trunk, and only a via-hub route has one. This is the only place the
  // effective routing is known (the caller may have left it to the config default), so the guard
  // lives here rather than at the request boundary.
  const stopIds = input.trunkStopHubIds ?? [];
  if (stopIds.length > 0 && routing !== "via-hub") {
    throw new GroupageError(
      "stops",
      `Intermediate stops need routing "via-hub" — a direct move has no trunk to stop on. Switch routing, or remove the stops.`,
    );
  }

  // 1.1 Resolve hubs — soft, so a catchment gap only stops a via-hub route, never a direct one.
  const originHub = resolveHubOrNull(input.originPostcode, hubs);
  const destHub = resolveHubOrNull(input.destinationPostcode, hubs);

  // Freight profile → demand (Σ footprints, Σ weight); rejects bad pallet lines.
  const demand = computeDemand(
    input.pallets,
    rates.footprintUnits,
    deps.config.maxPalletsPerBooking,
    rates.maxPalletWeightKg,
    rates.enforcePerPalletCeiling,
  );

  // 1.2 Build the door-to-door path per the chosen routing.
  const pathCfg = { legCapacity: rates.legCapacity, maxTrunkHops: deps.config.maxTrunkHops };
  let path: GroupagePath;
  if (routing === "via-hub") {
    // An explicit hub route needs a hub at each end. `resolveHub` raises the canonical fail-loud
    // catchment error naming the uncovered postcode when the soft resolve came back null.
    const oHub = originHub ?? resolveHub(input.originPostcode, hubs);
    const dHub = destHub ?? resolveHub(input.destinationPostcode, hubs);
    // Resolve stops against the SAME hub list the ends resolved from, so a session-overlay hub
    // (one lifted off the uploaded manifest) is a valid stop. Never a second repository read.
    const stops = stopIds.length > 0 ? resolveStops(stopIds, hubs, oHub, dHub) : [];
    path = buildPath(
      { postcode: input.originPostcode, hub: oHub },
      { postcode: input.destinationPostcode, hub: dHub },
      pathCfg,
      stops,
    );
  } else {
    // Direct (hubless): quotable for any postcode — no catchment lookup. The guard above already
    // rejected stops on this route.
    path = buildDirectPath(input.originPostcode, input.destinationPostcode, pathCfg);
  }

  // 1.3 Dual-capacity check on every leg, each against ITS OWN load — pallets alight and board at
  // the stops, so a hop rarely carries the whole booking (Rule 1).
  //
  // An over-capacity load is MEASURED, not rejected: the quote carries `fits: false`, the vehicle
  // count the load really needs, and any pallet no vehicle can carry (Rule 5's information, without
  // Rule 5's dead end). `assertPathFits` only bites when the business opts in via `enforceLegCapacity`.
  const routed = routePallets(input.pallets, stationsOf(path));
  const buckets = legBuckets(routed, path);
  const loads = buckets.map((bucket) => sumDemand(bucket, rates.footprintUnits));
  const capacity = checkPath(loads, path);
  assertPathFits(capacity, rates.enforceLegCapacity);
  const oversize = oversizeLines(buckets, path, rates.footprintUnits);

  // 1.4 Price on the summed totals.
  const price = priceGroupage({
    pallets: input.pallets,
    demand,
    path,
    rates,
    currencySymbol: deps.config.currencySymbol,
  });

  const quote: GroupageQuote = {
    originPostcode: input.originPostcode.trim(),
    destinationPostcode: input.destinationPostcode.trim(),
    path,
    demand,
    capacityChecks: capacity.checks,
    bindingLimit: capacity.bindingLimit,
    fits: capacity.fits,
    vehiclesNeeded: capacity.vehiclesNeeded,
    lineItems: price.lineItems,
    currencySymbol: deps.config.currencySymbol,
    subtotal: price.subtotal,
    surcharges: price.surcharges,
    total: price.total,
    eta: input.eta ?? null,
    // Only on a multi-stop path — an absent key keeps a stop-free quote's serialization unchanged.
    ...(path.stops?.length ? { legLoads: loads } : {}),
    // Likewise absent on the (overwhelmingly common) booking where every pallet fits its vehicle.
    ...(oversize.length ? { oversizeLines: oversize } : {}),
  };

  logger.info("groupage quote generated", {
    routing: path.routing,
    origin: path.originHub?.id ?? "—",
    dest: path.destinationHub?.id ?? "—",
    kind: path.kind,
    stops: path.stops?.length ?? 0,
    pallets: demand.palletCount,
    footprints: demand.footprints,
    fits: capacity.fits,
    vehiclesNeeded: capacity.vehiclesNeeded,
    oversizeLines: oversize.length,
    total: quote.total,
  });

  return { quote, perf: perf.report() };
}
