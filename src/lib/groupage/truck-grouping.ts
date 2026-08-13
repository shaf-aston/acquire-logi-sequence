/**
 * Group multiple quotes/consignments onto SHARED TRUCKS (the 3D load-plan feature's brain).
 *
 * There are no "bookings" arriving into the system — the full detail lives in each quote. This
 * module takes a set of consignments (each = one company's quote detail) and works out which of
 * them can travel on the SAME vehicle, so the manager who stacks the truck sees who shares with
 * whom. It is the quote-level sibling of `groupage-ops/manifest.ts` (which does the same math over
 * BOOKED shipments): two consignments share a truck iff their shared leg produces the same
 * `legKey` (leg kind + hub-pair), and a group is feasible only if the summed demand fits that
 * leg's dual capacity (pallet-spaces AND weight).
 *
 * Pure: no I/O. The caller passes the resolved hub network + rate card + config knobs in, exactly
 * like `getGroupageQuote` receives its deps — so this stays unit-testable and store-agnostic.
 * REUSES `resolveHub`/`buildPath` (path), `legKeyOf` (grouping key), `computeDemand` (freight
 * profile) and `checkLeg` (dual-capacity) — no new routing/capacity math lives here.
 */
import { resolveHub, resolveHubOrNull } from "./hub-resolver";
import { buildPath, buildDirectPath, legKeyOf } from "./path-builder";
import { resolveStops } from "./trunk-stops";
import { computeDemand } from "./demand";
import { checkLeg } from "./capacity";
import { GroupageError } from "./groupage.types";
import type {
  DualCapacity,
  GroupageDemand,
  GroupageLeg,
  GroupageLegKind,
  GroupagePallet,
  GroupagePath,
  GroupageRouting,
  Hub,
} from "./groupage.types";
import type { GroupageRates } from "./groupage-rates";

/** One company's quote detail — the unit that gets grouped. */
export interface Consignment {
  /** Company / customer label. Drives the per-company colour in the 3D stack; free text. */
  readonly company: string;
  readonly originPostcode: string;
  readonly destinationPostcode: string;
  readonly pallets: readonly GroupagePallet[];
  /** Route family; omitted ⇒ the config default (mirrors `GroupageQuoteInput.routing`). */
  readonly routing?: GroupageRouting;
  /** Ordered intermediate trunk stops (hub ids), as quoted. Present ⇒ this consignment cannot be
   *  stacked (see `primaryLeg`); carried so the rejection is honest rather than silent. */
  readonly trunkStopHubIds?: readonly string[];
}

/** One consignment placed on a shared truck, with its resolved freight profile. */
export interface TruckMember {
  readonly company: string;
  readonly originPostcode: string;
  readonly destinationPostcode: string;
  readonly pallets: readonly GroupagePallet[];
  readonly demand: GroupageDemand;
}

/** A set of consignments that travel together on one vehicle (one shared leg). */
export interface SharedTruck {
  /** Stable identity of the shared leg (kind + hub-pair) — the grouping key. */
  readonly legKey: string;
  readonly legKind: GroupageLegKind;
  readonly from: string;
  readonly to: string;
  /** The leg's dual capacity (pallet-spaces + weight) the members are summed against. */
  readonly capacity: DualCapacity;
  /** `config/vans.json` vehicle id serving this leg — the 3D truck geometry. Undefined ⇒ none configured. */
  readonly vehicleId: string | undefined;
  readonly members: TruckMember[];
  readonly usedFootprints: number;
  readonly usedWeightKg: number;
  /** Both axes hold. */
  readonly fits: boolean;
  /** Overflow on each axis when `fits` is false (0 on an axis that's within limit); null when it fits. */
  readonly overBy: { readonly footprints: number; readonly weightKg: number } | null;
  /** 1-based position among the trucks a single over-capacity group was split into (1 when not split). */
  readonly splitIndex: number;
  /** How many trucks this group was split into (1 when it fit on one vehicle). */
  readonly splitCount: number;
}

export interface GroupingConfig {
  readonly maxTrunkHops: number;
  readonly maxPalletsPerBooking: number;
  readonly defaultRouting: GroupageRouting;
  /** Split an over-capacity group across the fewest feasible trucks instead of flagging one
   *  overloaded truck. Defaults to `true` when omitted (the caller's config default is on). */
  readonly autoSplitOverCapacity?: boolean;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Sum a set of members' demand on both axes (plus pallet count) — the truck's total load. */
function sumDemand(members: readonly TruckMember[]): GroupageDemand {
  return members.reduce(
    (acc, m) => ({
      footprints: acc.footprints + m.demand.footprints,
      weightKg: acc.weightKg + m.demand.weightKg,
      palletCount: acc.palletCount + m.demand.palletCount,
    }),
    { footprints: 0, weightKg: 0, palletCount: 0 },
  );
}

/** One physical pallet lifted off a member's line — the atomic unit the splitter bin-packs. A line
 *  of N identical pallets explodes into N of these, so a big consignment can be spread across trucks
 *  (the pallets are discrete and interchangeable). `seq` is the pallet's original position, keeping
 *  bins and the reassembled lines in a stable, testable order. */
interface PalletUnit {
  readonly memberIdx: number;
  readonly lineIdx: number;
  readonly footprintUnits: number; // footprint cost of ONE pallet
  readonly weightKg: number; // weight of ONE pallet
  readonly seq: number;
}

/** Explode every member's pallet LINES into individual pallet units (quantity → that many units). */
function explodeToUnits(
  members: readonly TruckMember[],
  footprintUnits: Readonly<Record<GroupagePallet["footprint"], number>>,
): PalletUnit[] {
  const units: PalletUnit[] = [];
  let seq = 0;
  members.forEach((m, memberIdx) => {
    m.pallets.forEach((line, lineIdx) => {
      const fu = footprintUnits[line.footprint] ?? 0;
      for (let q = 0; q < line.quantity; q++) {
        units.push({ memberIdx, lineIdx, footprintUnits: fu, weightKg: line.weightKg, seq: seq++ });
      }
    });
  });
  return units;
}

/** Rebuild a bin's pallet units back into TruckMembers: units regroup by their original member (so a
 *  firm keeps ONE colour/legend row) and line (so distinct footprints stay separate), quantities are
 *  summed, and each member's demand is recomputed from only the pallets it carries on THIS truck.
 *  Members and lines keep their original order for a stable 3D layout. */
function unitsToMembers(units: readonly PalletUnit[], source: readonly TruckMember[]): TruckMember[] {
  const order: number[] = [];
  const acc = new Map<number, { lines: Map<number, number>; footprints: number; weightKg: number; palletCount: number }>();
  for (const u of units) {
    let a = acc.get(u.memberIdx);
    if (!a) {
      a = { lines: new Map(), footprints: 0, weightKg: 0, palletCount: 0 };
      acc.set(u.memberIdx, a);
      order.push(u.memberIdx);
    }
    a.lines.set(u.lineIdx, (a.lines.get(u.lineIdx) ?? 0) + 1);
    a.footprints += u.footprintUnits;
    a.weightKg += u.weightKg;
    a.palletCount += 1;
  }
  return order
    .sort((x, y) => x - y)
    .map((mi): TruckMember => {
      const src = source[mi]!;
      const a = acc.get(mi)!;
      const pallets: GroupagePallet[] = [...a.lines.keys()]
        .sort((x, y) => x - y)
        .map((li) => ({ ...src.pallets[li]!, quantity: a.lines.get(li)! }));
      return {
        company: src.company,
        originPostcode: src.originPostcode,
        destinationPostcode: src.destinationPostcode,
        pallets,
        demand: { footprints: round1(a.footprints), weightKg: round1(a.weightKg), palletCount: a.palletCount },
      };
    });
}

/**
 * Split members across the fewest trucks that each fit the leg's DUAL capacity (spaces AND weight),
 * via First-Fit-Decreasing bin-packing on both axes. The unit is a SINGLE PALLET, so one company's
 * many identical pallets spread across trucks when they exceed one vehicle (26 + 14, not "flagged
 * forever") — the key to handling high-volume consignments. The only thing that can't be divided is
 * a single pallet that ALONE exceeds a truck (too heavy or oversize): it lands in its own bin, which
 * stays over-capacity and is FLAGGED downstream — never silently dropped; the geometric packer then
 * surfaces exactly which pallet doesn't fit.
 *
 * Deterministic: pallets are placed largest-first (by their tighter-axis utilisation), ties keep
 * original order, bins are ordered by their earliest pallet, and each bin's pallets are regrouped
 * back into ordered members for a stable 3D layout.
 */
function splitIntoFeasibleTrucks(
  members: readonly TruckMember[],
  cap: DualCapacity,
  footprintUnits: Readonly<Record<GroupagePallet["footprint"], number>>,
): TruckMember[][] {
  const util = (u: PalletUnit): number => {
    const s = cap.palletSpaces > 0 ? u.footprintUnits / cap.palletSpaces : Infinity;
    const w = cap.maxPayloadKg > 0 ? u.weightKg / cap.maxPayloadKg : Infinity;
    return Math.max(s, w);
  };
  const ordered = explodeToUnits(members, footprintUnits).sort((a, b) => util(b) - util(a) || a.seq - b.seq);

  const bins: { units: PalletUnit[]; footprints: number; weightKg: number }[] = [];
  for (const u of ordered) {
    const bin = bins.find(
      (b) => b.footprints + u.footprintUnits <= cap.palletSpaces && b.weightKg + u.weightKg <= cap.maxPayloadKg,
    );
    if (bin) {
      bin.units.push(u);
      bin.footprints += u.footprintUnits;
      bin.weightKg += u.weightKg;
    } else {
      bins.push({ units: [u], footprints: u.footprintUnits, weightKg: u.weightKg });
    }
  }
  const firstSeq = (b: { units: PalletUnit[] }) => Math.min(...b.units.map((u) => u.seq));
  return bins.sort((a, b) => firstSeq(a) - firstSeq(b)).map((b) => unitsToMembers(b.units, members));
}

/** Finalise ONE truck from a member subset: sum demand, run the dual-capacity check, tag its split
 *  position. The single source of a `SharedTruck`'s used/fits/overBy fields (split or not). */
function finalizeTruck(
  base: { legKind: GroupageLegKind; from: string; to: string; capacity: DualCapacity; vehicleId: string | undefined },
  members: readonly TruckMember[],
  legKey: string,
  splitIndex: number,
  splitCount: number,
): SharedTruck {
  const summed = sumDemand(members);
  const check = checkLeg(summed, { kind: base.legKind, from: base.from, to: base.to, capacity: base.capacity });
  return {
    legKey,
    legKind: base.legKind,
    from: base.from,
    to: base.to,
    capacity: base.capacity,
    vehicleId: base.vehicleId,
    members: [...members],
    usedFootprints: round1(summed.footprints),
    usedWeightKg: round1(summed.weightKg),
    fits: check.fits,
    overBy: check.fits
      ? null
      : {
          footprints: round1(Math.max(0, -check.spacesRemaining)),
          weightKg: Math.round(Math.max(0, -check.payloadRemainingKg)),
        },
    splitIndex,
    splitCount,
  };
}

/**
 * The single leg on a path that represents the SHARED vehicle the manager stacks: the trunk
 * (hub → hub line-haul) when the path has one, else the first leg (collect) — which is the pooled
 * vehicle for a local or direct move. This is the leg whose `legKey` two consignments must match
 * to share a truck, and whose capacity + vehicle the 3D stack is drawn against.
 *
 * A multi-stop trunk has no single such leg: the planner sums a consignment's WHOLE demand against
 * one leg, so picking the first hop would stack two consignments that share hop 0 but diverge after
 * it, against a capacity neither of them actually loads. That is a silent capacity lie — reject it
 * loudly instead. Making the planner stop-aware is separate work.
 */
function primaryLeg(path: GroupagePath, company: string): GroupageLeg {
  const trunks = path.legs.filter((l) => l.kind === "trunk");
  if (trunks.length > 1) {
    throw new GroupageError(
      "path",
      `"${company}" routes via ${trunks.length - 1} intermediate stop(s); the shared-truck planner models point-to-point trunks only. Remove the stops from that quote, or deselect it from this plan.`,
    );
  }
  return trunks[0] ?? path.legs[0]!;
}

/** Resolve one consignment's door-to-door path — mirrors `getGroupageQuote`'s routing choice exactly. */
function pathFor(
  c: Consignment,
  hubs: readonly Hub[],
  rates: GroupageRates,
  cfg: GroupingConfig,
): GroupagePath {
  const routing = c.routing ?? cfg.defaultRouting;
  const pathCfg = { legCapacity: rates.legCapacity, maxTrunkHops: cfg.maxTrunkHops };
  if (routing === "via-hub") {
    const oHub = resolveHubOrNull(c.originPostcode, hubs) ?? resolveHub(c.originPostcode, hubs);
    const dHub = resolveHubOrNull(c.destinationPostcode, hubs) ?? resolveHub(c.destinationPostcode, hubs);
    // Build the path the consignment was actually quoted on, stops included — an honest path is
    // what lets `primaryLeg` see the extra hops and refuse to stack them.
    const stopIds = c.trunkStopHubIds ?? [];
    const stops = stopIds.length > 0 ? resolveStops(stopIds, hubs, oHub, dHub) : [];
    return buildPath(
      { postcode: c.originPostcode, hub: oHub },
      { postcode: c.destinationPostcode, hub: dHub },
      pathCfg,
      stops,
    );
  }
  return buildDirectPath(c.originPostcode, c.destinationPostcode, pathCfg);
}

/**
 * Group consignments into shared trucks. Each consignment's demand is computed and validated (bad
 * pallet lines fail loud via `computeDemand`), its path resolved, and it is bucketed by its shared
 * leg's `legKey`. Per bucket the summed demand is checked against the leg's dual capacity: a group
 * that fits rides one truck; an over-capacity group is auto-split across the fewest trucks that each
 * fit (pallet-level bin-packing — so even one high-volume company spreads across trucks) unless
 * `autoSplitOverCapacity` is off, when the single truck is FLAGGED (`fits: false`, `overBy`) as
 * before. Overflow that genuinely can't be divided (a single pallet too big for any truck) is always
 * surfaced, never silently dropped — hiding it would be a "never guess" breach.
 *
 * Returned trucks are ordered by first appearance of their leg, and members within a truck keep
 * input order — deterministic output for a stable 3D layout and testable assertions.
 */
export function groupConsignments(
  consignments: readonly Consignment[],
  hubs: readonly Hub[],
  rates: GroupageRates,
  cfg: GroupingConfig,
): SharedTruck[] {
  const order: string[] = [];
  const byKey = new Map<string, SharedTruck & { members: TruckMember[] }>();

  for (const c of consignments) {
    const demand = computeDemand(
      c.pallets,
      rates.footprintUnits,
      cfg.maxPalletsPerBooking,
      rates.maxPalletWeightKg,
      rates.enforcePerPalletCeiling,
    );
    const path = pathFor(c, hubs, rates, cfg);
    const leg = primaryLeg(path, c.company);
    const key = legKeyOf(leg);

    let truck = byKey.get(key);
    if (!truck) {
      truck = {
        legKey: key,
        legKind: leg.kind,
        from: leg.from,
        to: leg.to,
        capacity: leg.capacity,
        vehicleId: rates.legVehicle[leg.kind],
        members: [],
        usedFootprints: 0,
        usedWeightKg: 0,
        fits: true,
        overBy: null,
        splitIndex: 1,
        splitCount: 1,
      };
      byKey.set(key, truck);
      order.push(key);
    }
    truck.members.push({
      company: c.company,
      originPostcode: c.originPostcode,
      destinationPostcode: c.destinationPostcode,
      pallets: c.pallets,
      demand,
    });
  }

  // Finalise each bucket. A group that fits rides one truck (unchanged). An over-capacity group is
  // split across the fewest trucks that each fit (auto-split on) — so the operator sees "Truck 1 of
  // 2, both fit" instead of one overloaded truck — unless splitting is disabled, when the single
  // truck is flagged over-capacity as before. Splitting a single indivisible consignment is never
  // silent: it stays on its own flagged truck.
  const autoSplit = cfg.autoSplitOverCapacity !== false; // default on
  return order.flatMap((key): SharedTruck[] => {
    const t = byKey.get(key)!;
    const base = { legKind: t.legKind, from: t.from, to: t.to, capacity: t.capacity, vehicleId: t.vehicleId };
    const whole = checkLeg(sumDemand(t.members), { kind: t.legKind, from: t.from, to: t.to, capacity: t.capacity });

    if (whole.fits || !autoSplit) {
      return [finalizeTruck(base, t.members, key, 1, 1)];
    }

    const bins = splitIntoFeasibleTrucks(t.members, t.capacity, rates.footprintUnits);
    return bins.map((members, i) =>
      finalizeTruck(base, members, bins.length === 1 ? key : `${key}#${i + 1}`, i + 1, bins.length),
    );
  });
}
