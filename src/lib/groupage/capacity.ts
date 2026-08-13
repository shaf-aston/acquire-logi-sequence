/**
 * Dual-capacity check (blueprint Rule 1) — a leg is full when **either** its pallet spaces
 * **or** its payload weight is exhausted; a booking fits ONE vehicle per leg only if **every** leg
 * passes on both. Pure functions, no I/O. Timetables/dates are deferred, so this checks a booking's
 * demand against each leg's given per-vehicle capacity (not a live per-date remaining balance — that
 * is the deferred hold-ledger's job).
 *
 * MEASURING, not gate-keeping: a booking that outgrows a vehicle gets `fits: false` plus the vehicle
 * count it needs, and the quote carries both. The only hard reject is `assertPathFits` under the
 * opt-in `enforceLegCapacity` config flag. Two DIFFERENT overflows live here and must not be
 * conflated: an AGGREGATE one (`vehiclesNeeded` — divisible across vehicles) and an INDIVISIBLE one
 * (`oversizeLines` — a single pallet no vehicle on that leg can carry, whatever the count).
 */
import {
  GroupageError,
  type BindingLimit,
  type DualCapacity,
  type GroupageDemand,
  type GroupageLeg,
  type GroupagePath,
  type LegCapacityCheck,
  type OversizeLine,
  type PalletFootprintClass,
  type RoutedPallet,
} from "./groupage.types";

/** Utilisation fraction on the tighter of the two axes (>1 means it does not fit). */
function maxUtilisation(demand: GroupageDemand, cap: DualCapacity): number {
  const spaceFrac = cap.palletSpaces === 0 ? Infinity : demand.footprints / cap.palletSpaces;
  const weightFrac = cap.maxPayloadKg === 0 ? Infinity : demand.weightKg / cap.maxPayloadKg;
  return Math.max(spaceFrac, weightFrac);
}

/** Which axis leans hardest. Ties → "weight" (the flagged "weight-out" case). */
function bindingOf(demand: GroupageDemand, cap: DualCapacity): BindingLimit {
  const spaceFrac = cap.palletSpaces === 0 ? Infinity : demand.footprints / cap.palletSpaces;
  const weightFrac = cap.maxPayloadKg === 0 ? Infinity : demand.weightKg / cap.maxPayloadKg;
  return weightFrac >= spaceFrac ? "weight" : "spaces";
}

/**
 * How many of this leg's vehicles the demand needs — the ceiling of utilisation on the tighter
 * axis, never below 1. A 0/0 axis (misconfigured capacity) contributes nothing rather than an
 * Infinity. AGGREGATE only: see `LegCapacityCheck.vehiclesNeeded` on why an indivisible pallet is a
 * different question, answered by `oversizeLines`.
 */
function vehiclesFor(demand: GroupageDemand, cap: DualCapacity): number {
  const bySpace = cap.palletSpaces > 0 ? Math.ceil(demand.footprints / cap.palletSpaces) : 0;
  const byWeight = cap.maxPayloadKg > 0 ? Math.ceil(demand.weightKg / cap.maxPayloadKg) : 0;
  return Math.max(1, bySpace, byWeight);
}

/** Dual-limit check for one leg. Passes only if BOTH spaces and weight hold. */
export function checkLeg(demand: GroupageDemand, leg: GroupageLeg): LegCapacityCheck {
  const spacesRemaining = leg.capacity.palletSpaces - demand.footprints;
  const payloadRemainingKg = leg.capacity.maxPayloadKg - demand.weightKg;
  return {
    leg,
    fits: spacesRemaining >= 0 && payloadRemainingKg >= 0,
    bindingLimit: bindingOf(demand, leg.capacity),
    spacesRemaining,
    payloadRemainingKg,
    vehiclesNeeded: vehiclesFor(demand, leg.capacity),
  };
}

export interface PathCapacityResult {
  readonly checks: LegCapacityCheck[];
  readonly fits: boolean;
  /** Binding axis on the tightest leg — drives the quote-level "weight-out"/"space-out" note. */
  readonly bindingLimit: BindingLimit;
  /**
   * Vehicles needed on the hardest-pressed leg. Reported (not thrown) so the quote can carry the
   * number the operator acts on. WORST leg, not first: hop 1 can need 2 vehicles while hop 2 needs
   * 4 — reporting the first would hand them a number that is simply the wrong answer.
   */
  readonly vehiclesNeeded: number;
}

/**
 * Check each leg against **its own load** (`loads[i]` ↔ `path.legs[i]`) — pallets alight and board
 * at the trunk's intermediate stops, so a hop rarely carries the whole booking. Feasible only if
 * EVERY leg passes on both axes (Rule 1). `bindingLimit` is the binding axis of the leg with the
 * highest utilisation *under its own load*, so a hop that only goes weight-out after a heavy line
 * boards is reported correctly.
 *
 * On a stop-free path every load is the booking demand, so this reduces to the original behaviour.
 */
export function checkPath(loads: readonly GroupageDemand[], path: GroupagePath): PathCapacityResult {
  if (loads.length !== path.legs.length) {
    // Guard before `checkLeg(undefined, …)` turns into NaN arithmetic and an operator-facing
    // "NaN pallet-spaces over".
    throw new GroupageError(
      "path",
      `Internal: ${loads.length} leg loads for ${path.legs.length} legs — the load profile and the path disagree. This is a bug; report it.`,
    );
  }
  const checks = path.legs.map((leg, i) => checkLeg(loads[i]!, leg));
  // Index-carrying reduce: a LegCapacityCheck does not carry its load, so `worst` alone cannot
  // recompute its own utilisation.
  const worst = checks.reduce(
    (w, _c, i) => (maxUtilisation(loads[i]!, checks[i]!.leg.capacity) > maxUtilisation(loads[w]!, checks[w]!.leg.capacity) ? i : w),
    0,
  );
  return {
    checks,
    fits: checks.every((c) => c.fits),
    bindingLimit: checks[worst]!.bindingLimit,
    vehiclesNeeded: Math.max(...checks.map((c) => c.vehiclesNeeded)),
  };
}

/**
 * Pallet lines that ALONE exceed the vehicle on a leg they ride — the one overflow no vehicle count
 * can fix. Checked per SINGLE pallet (`quantity` is irrelevant: if one is too heavy, ten are too),
 * and only against the legs the line actually rides — `buckets[i]` are the lines on `path.legs[i]`,
 * so a line joining the trunk mid-route is never judged against a collection van it never boards.
 *
 * Pure. Returns `[]` for a normal booking, which is why the quote omits the key entirely.
 */
export function oversizeLines(
  buckets: readonly (readonly RoutedPallet[])[],
  path: GroupagePath,
  footprintUnits: Readonly<Record<PalletFootprintClass, number>>,
): OversizeLine[] {
  const found: OversizeLine[] = [];
  path.legs.forEach((leg, i) => {
    for (const p of buckets[i] ?? []) {
      const base = { lineNumber: p.lineNumber, legKind: leg.kind, legFrom: leg.from, legTo: leg.to };
      if (p.weightKg > leg.capacity.maxPayloadKg) {
        found.push({ ...base, reason: "weight", palletValue: p.weightKg, vehicleLimit: leg.capacity.maxPayloadKg });
      }
      const units = footprintUnits[p.footprint]!;
      if (units > leg.capacity.palletSpaces) {
        found.push({ ...base, reason: "spaces", palletValue: units, vehicleLimit: leg.capacity.palletSpaces });
      }
    }
  });
  return found;
}

/**
 * The over-capacity GUARD, not the over-capacity POLICY.
 *
 * A booking that outgrows one vehicle is NOT an error — it is a bigger job. The product rule is to
 * trust the customer's paperwork: the load is quoted, priced across the vehicles it really needs
 * (see `PathCapacityResult.vehiclesNeeded` and `pricing.ts`'s chargeable spaces), and any leg it
 * overflows is FLAGGED on the quote. So this is a no-op unless the business explicitly opts back in
 * to a hard reject via config `enforceLegCapacity` — the fat-finger guard, symmetric with
 * `enforcePerPalletCeiling` in `demand.ts`.
 *
 * When enforced, it fails loud on the WORST over-capacity leg (highest `vehiclesNeeded`, ties keep
 * the earliest), naming it, the exact overflow, and the vehicle count the operator must act on.
 * Other failing legs are counted in the message, so nothing over capacity is ever hidden.
 */
export function assertPathFits(result: PathCapacityResult, enforce = false): void {
  if (!enforce || result.fits) return;
  const failing = result.checks.filter((c) => !c.fits);
  const bad = failing.reduce((worst, c) => (c.vehiclesNeeded > worst.vehiclesNeeded ? c : worst));
  const reasons: string[] = [];
  if (bad.spacesRemaining < 0) reasons.push(`${(-bad.spacesRemaining).toFixed(2)} pallet-spaces over`);
  if (bad.payloadRemainingKg < 0) reasons.push(`${Math.round(-bad.payloadRemainingKg)} kg over`);
  const n = bad.vehiclesNeeded;
  const others = failing.length - 1;
  throw new GroupageError(
    "capacity",
    `This booking needs at least ${n} ${bad.leg.kind} vehicles on the ${bad.leg.from} → ${bad.leg.to} leg ` +
      `(${reasons.join(" and ")} for one). Split it across ${n} or more bookings/vans, or reduce the load.` +
      (others > 0 ? ` ${others} other leg${others === 1 ? " is" : "s are"} also over capacity.` : ""),
  );
}
