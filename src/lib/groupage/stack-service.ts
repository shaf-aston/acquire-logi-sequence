/**
 * Shared-truck load-plan service — orchestrates the 3D stacking feature end to end:
 *   consignments → group onto shared trucks (truck-grouping) → for each truck, load its vehicle
 *   geometry (config/vans.json) and auto-pack the pallets (pallet-stacker over HeuristicPacker) →
 *   a serializable plan the planner UI renders and lets the operator adjust.
 *
 * Thin, like `getGroupageQuote`: no geometry or grouping logic lives here — it only sequences the
 * pure modules and wires the file-backed config sources + heuristic packer. Fails loud on a
 * consignment whose leg has a configured vehicle id that isn't in the fleet (never a guessed truck).
 */
import { getConfig } from "@/config/env";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { FileVanRepository, type VanRepository } from "@/lib/packing/van.repository";
import { stackTruck, companyRoster, type CompanyRosterEntry, type PalletStackSpec, type StackedTruck } from "@/lib/packing/pallet-stacker";
import { FileHubRepository, type HubRepository } from "./hub.repository";
import { loadGroupageRates, type GroupageRates } from "./groupage-rates";
import { groupConsignments, type Consignment, type GroupingConfig } from "./truck-grouping";
import { GroupageError, PALLET_FOOTPRINT_CLASSES } from "./groupage.types";
import palletSpecJson from "../../../config/pallet-spec.json";

/** A grouped, auto-packed shared truck — everything the planner needs to render + edit one truck. */
export interface PlannedTruck {
  readonly legKey: string;
  readonly legKind: string;
  readonly from: string;
  readonly to: string;
  readonly capacity: { readonly palletSpaces: number; readonly maxPayloadKg: number };
  readonly usedFootprints: number;
  readonly usedWeightKg: number;
  readonly fits: boolean;
  readonly overBy: { readonly footprints: number; readonly weightKg: number } | null;
  /** Distinct companies on this truck, in first-seen order — drives the colour legend. A firm with
   *  more than one collection point appears once, its pickups gathered in `origins`. */
  readonly companies: readonly CompanyRosterEntry[];
  /** Null when the leg has no vehicle configured — the truck can't be drawn, surfaced not hidden. */
  readonly stack: StackedTruck | null;
  readonly vanLabel: string | null;
  /** Clearance + reach the packer used — echoed so the interactive editor validates identically. */
  readonly toleranceM: number;
  readonly maxReachHeightM: number | null;
  /** 1-based position among the trucks an over-capacity group was split into (1 when not split). */
  readonly splitIndex: number;
  /** How many trucks the group was split into (1 when it fit one vehicle) — drives "Truck 1 of 2". */
  readonly splitCount: number;
}

export interface StackPlanDeps {
  readonly hubs: HubRepository;
  readonly vans: VanRepository;
  readonly loadRates: () => Promise<GroupageRates>;
  readonly config: GroupingConfig & { readonly toleranceM: number; readonly maxReachHeightM: number };
}

export function createStackPlanDeps(): StackPlanDeps {
  const cfg = getConfig();
  return {
    hubs: new FileHubRepository(),
    vans: new FileVanRepository(),
    loadRates: loadGroupageRates,
    config: {
      maxTrunkHops: cfg.groupage.maxTrunkHops,
      maxPalletsPerBooking: cfg.groupage.maxPalletsPerBooking,
      defaultRouting: cfg.groupage.defaultRouting,
      autoSplitOverCapacity: cfg.groupage.autoSplitOverCapacity,
      toleranceM: cfg.packing.toleranceM,
      maxReachHeightM: cfg.packing.maxReachHeightM,
    },
  };
}

/** Validate the shape the stacker needs out of config/pallet-spec.json — fail loud on a bad edit.
 *  Exported so any other reader of pallet-spec.json (e.g. rule-consignment-reader.ts's oversize
 *  threshold) goes through the same validated load instead of trusting the raw JSON import. */
export function loadPalletSpec(): PalletStackSpec {
  const spec = palletSpecJson as unknown as PalletStackSpec;
  for (const cls of PALLET_FOOTPRINT_CLASSES) {
    const f = spec.footprintClasses?.[cls];
    if (!f || !(f.lengthMm > 0) || !(f.widthMm > 0) || !(f.loadedHeightMm > 0)) {
      throw new GroupageError("input", `pallet-spec.json is missing valid dimensions for footprint class "${cls}".`);
    }
  }
  if (!(spec.stacking?.canSupportWeightKg > 0) || !(spec.stacking?.maxStackPressureKpa > 0)) {
    throw new GroupageError("input", "pallet-spec.json is missing valid `stacking` limits.");
  }
  return spec;
}

export async function planSharedTrucks(
  consignments: readonly Consignment[],
  deps: StackPlanDeps = createStackPlanDeps(),
): Promise<PlannedTruck[]> {
  if (consignments.length === 0) {
    throw new GroupageError("input", "Add at least one consignment to plan a shared truck.");
  }
  const [hubs, rates, vans] = await Promise.all([deps.hubs.listHubs(), deps.loadRates(), deps.vans.listVans()]);
  const spec = loadPalletSpec();
  const packer = new HeuristicPacker({ toleranceM: deps.config.toleranceM, maxReachHeightM: deps.config.maxReachHeightM });

  const trucks = groupConsignments(consignments, hubs, rates, deps.config);
  const vanById = new Map(vans.map((v) => [v.id, v]));

  return trucks.map((truck): PlannedTruck => {
    const companies = companyRoster(truck.members);
    const base = {
      legKey: truck.legKey,
      legKind: truck.legKind,
      from: truck.from,
      to: truck.to,
      capacity: truck.capacity,
      usedFootprints: truck.usedFootprints,
      usedWeightKg: truck.usedWeightKg,
      fits: truck.fits,
      overBy: truck.overBy,
      companies,
      toleranceM: deps.config.toleranceM,
      maxReachHeightM: deps.config.maxReachHeightM,
      splitIndex: truck.splitIndex,
      splitCount: truck.splitCount,
    };

    if (!truck.vehicleId) {
      return { ...base, stack: null, vanLabel: null };
    }
    const van = vanById.get(truck.vehicleId);
    if (!van) {
      throw new GroupageError(
        "input",
        `The ${truck.legKind} leg is set to vehicle "${truck.vehicleId}", which isn't in the fleet ` +
          `(config/vans.json). Fix the vehicle id in config/groupage-rates.json or add the vehicle.`,
      );
    }
    return { ...base, stack: stackTruck(truck, van, packer, spec), vanLabel: van.label };
  });
}
