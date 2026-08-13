/**
 * Hub collection run — plans an LTL pickup loop around a 3PL hub: the van departs the hub's
 * storage address, visits every pickup, and returns to the hub. Thin orchestration over the
 * kind-blind stop-chain engine (mirrors stop-chain/service.ts): load the hub (fail loud when it
 * has no address — never a guessed origin), build the [hub, pickups…] stop list with the hub
 * pinned again as the route's final destination, price the ONE chosen van on the loop, and
 * annotate each pickup with its catchment verdict.
 *
 * Catchment flags are advisory ("never guess" surfaces, not gates): a pickup outside the hub's
 * catchment — or with no readable postcode — is FLAGGED for the operator, never blocked. The
 * only hard gates are the stop-mix validator and the hub's own address.
 */
import { createLogger } from "@/lib/logger/logger";
import { PerfTracker, type PerfReport } from "@/lib/perf/tracker";
import { getConfig } from "@/config/env";
import { FileVanRepository, type VanRepository } from "@/lib/packing/van.repository";
import { FileHubRepository, SessionOverlayHubRepository, type HubRepository } from "@/lib/groupage/hub.repository";
import { postcodeArea } from "@/lib/groupage/hub-resolver";
import { extractPostcode } from "@/lib/geo/address-resolver";
import { PricingError, type RateOverrides } from "@/lib/pricing";
import type { Hub } from "@/lib/groupage/groupage.types";
import { createCollectionStopChain, quoteStopChain } from "@/lib/stop-chain";
import type { StopChainDeps, StopChainResult } from "@/lib/stop-chain";
import type { Stop } from "@/lib/stop-chain";

const logger = createLogger("collection-run.service");

/** Fail-loud collection-run error. `check` names the gate so the UI points at the right field. */
export type CollectionRunCheck = "hub" | "input";

export class CollectionRunError extends Error {
  readonly check: CollectionRunCheck;
  constructor(check: CollectionRunCheck, message: string) {
    super(message);
    this.name = "CollectionRunError";
    this.check = check;
  }
}

/** One pickup to collect. Company is optional context (e.g. carried from a groupage origin) so the
 *  driver's list can name WHO each stop serves; the router only ever uses `address`. */
export interface CollectionPickup {
  readonly address: string;
  readonly company?: string;
}

export interface CollectionRunInput {
  readonly hubId: string;
  /** Pickups, in the operator's typed order. */
  readonly pickups: CollectionPickup[];
  /** The one van/truck driving the run. */
  readonly vanId: string;
  /** Per-request override of collectionRun.optimizeOrder (config default: true). */
  readonly optimizeOrder?: boolean;
  /** Session rate tweaks from the "Quote settings" panel; undefined ⇒ config defaults. */
  readonly rateOverrides?: RateOverrides;
  /**
   * Hubs lifted off the uploaded manifest, layered over the saved network for THIS run only (never
   * persisted). Lets the run collect into a hub the document names — e.g. its own consolidation
   * centre — even when that hub isn't in the saved network. Empty/absent ⇒ saved network only.
   */
  readonly sessionHubs?: readonly Hub[];
}

/** One pickup with its catchment verdict — shown in visit order. */
export interface CollectionStopInfo {
  readonly address: string;
  /** Company/customer this pickup serves (e.g. from a groupage origin), or null when unlabelled. */
  readonly company: string | null;
  /** Postcode-area prefix ("CV"), or null when the address has no readable UK postcode. */
  readonly postcodeArea: string | null;
  /** True when the area belongs to the chosen hub's catchment. Null area ⇒ false (flagged). */
  readonly inCatchment: boolean;
  /** Which hub DOES cover the area (may be another hub), or null on a gap / unreadable postcode. */
  readonly owningHubId: string | null;
}

export interface CollectionRunResult {
  readonly hub: { id: string; name: string; address: string };
  /** Pickups in VISIT order (post-optimization) with their catchment verdicts. */
  readonly orderedStops: CollectionStopInfo[];
  readonly quote: StopChainResult["quote"];
  readonly warnings: string[];
  readonly perf: PerfReport;
}

export interface CollectionRunDeps {
  readonly hubs: HubRepository;
  readonly vans: VanRepository;
  readonly chain: StopChainDeps;
}

const defaultDeps = (): CollectionRunDeps => ({
  hubs: new FileHubRepository(),
  vans: new FileVanRepository(),
  chain: createCollectionStopChain(),
});

/** Catchment verdict for one pickup address against the chosen hub + the whole network. */
function stopInfo(pickup: CollectionPickup, hub: Hub, allHubs: readonly Hub[]): CollectionStopInfo {
  const { address } = pickup;
  const company = pickup.company ?? null;
  const postcode = extractPostcode(address);
  if (!postcode) return { address, company, postcodeArea: null, inCatchment: false, owningHubId: null };
  const area = postcodeArea(postcode); // extractPostcode output is always postcode-shaped
  const owner = allHubs.find((h) => h.catchment.includes(area)) ?? null;
  return {
    address,
    company,
    postcodeArea: area,
    inCatchment: owner?.id === hub.id,
    owningHubId: owner?.id ?? null,
  };
}

export async function planCollectionRun(
  input: CollectionRunInput,
  deps: CollectionRunDeps = defaultDeps(),
): Promise<CollectionRunResult> {
  const perf = new PerfTracker(logger);
  const cfg = getConfig();

  // Manifest hubs (if any) overlay the saved network for this run only — so a run can collect into
  // a hub the document names that isn't saved yet. Read-only; never touches config/hubs.json.
  const hubs: HubRepository =
    input.sessionHubs && input.sessionHubs.length > 0
      ? new SessionOverlayHubRepository(deps.hubs, input.sessionHubs)
      : deps.hubs;

  const hub = await hubs.getHub(input.hubId);
  if (!hub) {
    throw new CollectionRunError("hub", `Unknown hub "${input.hubId}" — pick a hub from the list.`);
  }
  if (!hub.address) {
    throw new CollectionRunError(
      "hub",
      `${hub.name} has no storage address yet — add it in Depots & hubs before planning a run from it.`,
    );
  }

  const van = await deps.vans.getVan(input.vanId);
  if (!van) throw new PricingError(`unknown van id "${input.vanId}"`);

  // Hub first, pickups after — the return to the hub is the pinned final destination, not a stop,
  // so the validator's duplicate check stays meaningful (the hub appears in `stops` once).
  const stops: Stop[] = [
    { address: hub.address, kind: "hub" },
    ...input.pickups.map((p): Stop => ({ address: p.address, kind: "pickup", company: p.company })),
  ];

  const result = await perf.track("chain", () =>
    quoteStopChain(
      {
        stops,
        vans: [van],
        fragileCount: 0, // nothing is packed yet on a pickup run — no fragility surcharge
        finalDestination: hub.address,
        maxStops: cfg.multiStop.maxStops,
        optimizeWaypointOrder: input.optimizeOrder ?? cfg.collectionRun.optimizeOrder,
        pricing: {
          fragilitySurchargePerItem:
            input.rateOverrides?.fragilitySurchargePerItem ?? cfg.routing.fragilitySurchargePerItem,
          currencySymbol: cfg.routing.currencySymbol,
          driverHourlyRate: input.rateOverrides?.driverHourlyRate ?? cfg.routing.driverHourlyRate,
          loadUnloadMinutesPerVan:
            input.rateOverrides?.loadUnloadMinutesPerVan ?? cfg.routing.loadUnloadMinutesPerVan,
          loadUnloadMinutesPerStop: cfg.multiStop.loadUnloadMinutesPerStop,
        },
      },
      deps.chain,
    ),
  );

  // visitOrder is 0-based over the stops AFTER the first (here: the pickups) — map it back to
  // addresses so the operator reads the run in driving order.
  const allHubs = await hubs.listHubs();
  const orderedStops = result.visitOrder.map((i) => {
    const pickup = input.pickups[i];
    if (pickup === undefined) {
      throw new CollectionRunError("input", `Route came back with an unknown pickup index ${i} — try again.`);
    }
    return stopInfo(pickup, hub, allHubs);
  });
  // Conservation: every pickup must appear in the visit order exactly once — a short or
  // duplicated order would silently drop a stop from the plan the driver follows.
  if (orderedStops.length !== input.pickups.length || new Set(result.visitOrder).size !== input.pickups.length) {
    throw new CollectionRunError(
      "input",
      `Route covered ${orderedStops.length} of ${input.pickups.length} pickups — try again or turn off route optimization.`,
    );
  }

  const outside = orderedStops.filter((s) => !s.inCatchment).length;
  const warnings = [...result.warnings];
  if (outside > 0) {
    warnings.push(
      `${outside} pickup${outside === 1 ? " is" : "s are"} outside ${hub.name}'s catchment — check they belong on this run.`,
    );
  }

  logger.info("collection run planned", {
    hub: hub.id,
    pickups: input.pickups.length,
    outsideCatchment: outside,
    distanceMiles: Math.round(result.quote.route.distanceMiles * 10) / 10,
    total: Math.round(result.quote.total * 100) / 100,
  });

  return {
    hub: { id: hub.id, name: hub.name, address: hub.address },
    orderedStops,
    quote: result.quote,
    warnings,
    perf: perf.report(),
  };
}
