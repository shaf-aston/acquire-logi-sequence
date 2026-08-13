/**
 * Groupage (shared-truck / LTL) domain types — the QUOTE core (blueprint Part 1).
 *
 * Groupage differs from the single-drop / stop-chain modes at its core: freight is measured in
 * **pallet-space units** (not 3D boxes), a leg is capped by **two** limits (spaces AND weight),
 * and price is a **per-pallet-space rate-card** lookup (not per-mile). So this is a sibling module
 * to `stop-chain`, reusing its *patterns* (config-driven, swap-seam factory, fail-loud) — never a
 * config of that engine.
 *
 * Timetables and the atomic-hold ledger are deferred (see groupage-implementation-plan.md §0):
 * leg capacity is a **given input** (config default), and feasibility is checked against that.
 */

/**
 * A fixed depot / cross-dock that owns a **catchment**. Every postcode resolves to exactly one
 * hub, so a `catchment` is a set of postcode-area prefixes (the leading letters of a UK postcode,
 * e.g. "CV", "B", "EH"). Catchments must be disjoint across hubs — enforced at load.
 */
export interface Hub {
  readonly id: string;
  readonly name: string;
  /** Postcode-area prefixes this hub collects from and delivers to (uppercase, e.g. ["CV","B","LE"]). */
  readonly catchment: readonly string[];
  /**
   * Physical 3PL storage location (full address). Optional: groupage quoting never needs it, but a
   * COLLECTION RUN starts and ends here — planning one for an address-less hub fails loud with a
   * pointer to fill this in, never a guessed origin.
   */
  readonly address?: string;
}

/** Pallet footprint class → floor-space units it consumes (units live in config/groupage-rates.json). */
export type PalletFootprintClass = "full" | "half" | "quarter" | "oversize";

export const PALLET_FOOTPRINT_CLASSES: readonly PalletFootprintClass[] = [
  "full",
  "half",
  "quarter",
  "oversize",
] as const;

/**
 * One line of a groupage booking: N pallets of a given footprint class, each of a given weight.
 * A booking is a list of these — its demand is the sum of footprint units and the sum of weights.
 *
 * `joinAtHubId`/`leaveAtHubId` name the STATION (a hub on the trunk) where this line boards and
 * where it alights — the "train stop" model. Both omitted ⇒ origin hub → destination hub, i.e. the
 * line rides the whole trunk, which is the only possibility on a stop-free route. Stops therefore
 * carry no pallet lists of their own: a pallet cannot be dropped at a stop it never reached, and
 * `maxPalletsPerBooking` still gates one single pallet array.
 */
export interface GroupagePallet {
  readonly footprint: PalletFootprintClass;
  /** Weight of ONE pallet in this line (kg). */
  readonly weightKg: number;
  readonly quantity: number;
  /** Hub id where this line JOINS the trunk. Omitted ⇒ the origin hub. */
  readonly joinAtHubId?: string;
  /** Hub id where this line LEAVES the trunk. Omitted ⇒ the destination hub. */
  readonly leaveAtHubId?: string;
}

/**
 * A pallet line whose station refs have been resolved to indices into `stationsOf(path)`.
 * ONLY `routePallets()` constructs one. TypeScript is structurally typed, so `boardStation <
 * alightStation` is a CONVENTION here, not an enforcement — `legLoads()` therefore RE-ASSERTS it
 * rather than trusting the type.
 */
export interface RoutedPallet extends GroupagePallet {
  /** Index into the station chain where this line boards. 0 = origin hub. */
  readonly boardStation: number;
  /** Index into the station chain where this line alights. `stations.length - 1` = destination hub. */
  readonly alightStation: number;
  /** 1-based position of this line in the booking's pallet array — the number the operator sees.
   *  Carried here because `legBuckets` filters and reorders lines, losing the array index. */
  readonly lineNumber: number;
}

/** The two limits a leg (and a booking) is measured against — whichever exhausts first binds. */
export interface DualCapacity {
  readonly palletSpaces: number;
  readonly maxPayloadKg: number;
}

/** A booking's total demand across all its pallet lines. */
export interface GroupageDemand {
  /** Σ (footprintUnits(class) × quantity). */
  readonly footprints: number;
  /** Σ (weightKg × quantity). */
  readonly weightKg: number;
  /** Total pallet count (Σ quantity) — for display and manifests. */
  readonly palletCount: number;
}

export type GroupageLegKind = "collect" | "trunk" | "deliver";

/**
 * One hop in a door-to-door path. `from`/`to` are human-readable labels (address for the customer
 * ends, hub name for hub ends). `fromHubId`/`toHubId` carry the resolved hub id where a hub is
 * involved, so downstream code (manifests, pricing) keys off ids, not display strings.
 */
export interface GroupageLeg {
  readonly kind: GroupageLegKind;
  readonly from: string;
  readonly to: string;
  readonly fromHubId?: string;
  readonly toHubId?: string;
  /** Capacity of the vehicle serving this leg (given input; config default until timetables land). */
  readonly capacity: DualCapacity;
}

/**
 * The full door-to-door path. Two families:
 *   • via-hub: `collect → [trunk …] → deliver`, anchored on hubs. The trunk may call at ordered
 *     intermediate hubs ("stops"), one trunk leg per hop. A **local move** (origin hub =
 *     destination hub) is the degenerate case with **no trunk leg** — just collect → deliver.
 *   • direct: `collect → deliver` with **no hubs** — a hubless pooled move on another carrier. `originHub`/
 *     `destinationHub` are `null` here, so every consumer must treat them as optional.
 */
export interface GroupagePath {
  /** Null on a direct (hubless) path. */
  readonly originHub: Hub | null;
  /** Null on a direct (hubless) path. */
  readonly destinationHub: Hub | null;
  readonly legs: readonly GroupageLeg[];
  readonly routing: GroupageRouting;
  readonly kind: GroupagePathKind;
  /** True when origin hub === destination hub (local move, no trunk leg). Derived alias of `kind === "local"`. */
  readonly isLocal: boolean;
  /**
   * Ordered intermediate trunk stops, between origin hub and destination hub. Only ever present on
   * `kind === "hub"`. OMITTED (not `[]`) when there are none — an absent key is dropped by
   * `JSON.stringify`, which is what keeps a stop-free quote serializing exactly as it always has.
   */
  readonly stops?: readonly Hub[];
}

/**
 * How a shared load is routed. `via-hub` cross-docks at one of our hubs (collect → hub → [trunk] →
 * deliver); `direct` is a hubless door-to-door pooled move on another carrier — quotable for ANY
 * postcode, no catchment required.
 */
export type GroupageRouting = "direct" | "via-hub";

/**
 * The shape of a built path: `hub` = distinct origin/destination hubs (has a trunk leg);
 * `local` = same hub both ends (no trunk); `direct` = no hubs at all (collect → deliver).
 */
export type GroupagePathKind = "direct" | "hub" | "local";

/** Which of a leg's two limits leans hardest (blueprint Rule 1). A load is always "space-out" or "weight-out". */
export type BindingLimit = "spaces" | "weight";

export interface LegCapacityCheck {
  readonly leg: GroupageLeg;
  readonly fits: boolean;
  /** Whichever limit is tighter on this leg — the one that binds (or is breached). */
  readonly bindingLimit: BindingLimit;
  readonly spacesRemaining: number;
  readonly payloadRemainingKg: number;
  /**
   * How many of this leg's vehicles the load needs — 1 when it fits, the ceiling of utilisation on
   * the tighter axis otherwise. An AGGREGATE answer: it says nothing about whether the load can be
   * DIVIDED across that many vehicles. A single pallet heavier than one vehicle cannot be, and is
   * reported separately by `GroupageQuote.oversizeLines` — never conflate the two.
   */
  readonly vehiclesNeeded: number;
}

/**
 * One pallet line that ALONE exceeds a leg's vehicle — no number of vehicles can carry it, so it is
 * the one overflow `vehiclesNeeded` cannot answer. A "never guess" surface: reported to the operator
 * (re-palletise, or put a bigger vehicle on that leg), never silently priced as if it fitted.
 */
export interface OversizeLine {
  /** 1-based position in the booking's pallet array. */
  readonly lineNumber: number;
  readonly legKind: GroupageLegKind;
  /** Human label of the leg it cannot ride (`GroupageLeg.from → GroupageLeg.to`). */
  readonly legFrom: string;
  readonly legTo: string;
  /** Which of the vehicle's two limits ONE of these pallets breaches. */
  readonly reason: BindingLimit;
  /** The pallet's own figure on the breached axis (kg, or footprint units). */
  readonly palletValue: number;
  /** The vehicle's limit on that axis. */
  readonly vehicleLimit: number;
}

/** Which real-world leg a price line belongs to — lets the UI show collection billing right after
 *  the collection map, trunk billing right after the trunk map, and bucket anything outside those
 *  two mapped legs (last-mile delivery, heavy-pallet surcharge) as "other" at the very end. */
export type BillingLeg = "collection" | "trunk" | "other";

/** One line of the groupage price breakdown (label + amount), mirroring pricing QuoteLineItem. */
export interface GroupageLineItem {
  readonly label: string;
  readonly amount: number;
  readonly leg: BillingLeg;
}

/** The finished groupage quote returned to the customer. Price is never shown without an ETA. */
export interface GroupageQuote {
  readonly originPostcode: string;
  readonly destinationPostcode: string;
  readonly path: GroupagePath;
  readonly demand: GroupageDemand;
  readonly capacityChecks: readonly LegCapacityCheck[];
  /** Whichever single limit binds hardest across the path — drives the "weight-out" surcharge note. */
  readonly bindingLimit: BindingLimit;
  /**
   * True when every leg fits one of its vehicles. FALSE IS NOT AN ERROR: a legitimate high-volume
   * booking is quoted, priced and returned with `fits: false` and the vehicle count it really needs
   * (config `enforceLegCapacity` flips this back to a hard reject — see groupage-rates.ts).
   */
  readonly fits: boolean;
  /** Vehicles needed on the hardest-pressed leg — 1 when the booking fits. See `LegCapacityCheck`. */
  readonly vehiclesNeeded: number;
  /**
   * Pallet lines no vehicle on their leg can carry, whatever the vehicle count. Omitted (not `[]`)
   * when there are none, so an ordinary quote serializes with exactly the key set it always had.
   */
  readonly oversizeLines?: readonly OversizeLine[];
  readonly lineItems: readonly GroupageLineItem[];
  readonly currencySymbol: string;
  readonly subtotal: number;
  readonly surcharges: number;
  readonly total: number;
  /**
   * Committed delivery date/ETA. A GIVEN INPUT under the deferred-timetable boundary — echoed
   * back so the quote always carries an arrival, never a bare price. Null when the caller supplied
   * none (surfaced to the operator, never silently omitted).
   */
  readonly eta: string | null;
  /**
   * What each leg ACTUALLY carries, one entry per `path.legs[i]`, same order. Pallets alight and
   * board at the stops, so every hop has its own demand — the "never guess" surface: the operator
   * sees what is on board hop by hop rather than assuming the booking total rides the whole way.
   *
   * Present only on a multi-stop path (on a stop-free one every leg carries `demand`, so it would
   * be noise). Omitted otherwise, so a stop-free quote serializes with exactly the key set it
   * always had. The stop count is `path.stops.length` — never duplicated here, so it cannot drift.
   */
  readonly legLoads?: readonly GroupageDemand[];
}

/**
 * A fail-loud groupage error. `check` says which gate stopped the quote so the UI can point the
 * operator at the right field with an exact fix (mirrors `StopChainError`).
 * `stops` covers the intermediate-stop list and the per-pallet-line join/leave station refs.
 */
export type GroupageCheck = "catchment" | "capacity" | "path" | "input" | "stops";

export class GroupageError extends Error {
  readonly check: GroupageCheck;
  constructor(check: GroupageCheck, message: string) {
    super(message);
    this.name = "GroupageError";
    this.check = check;
  }
}
