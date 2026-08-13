/**
 * Bulk-run fast-path (Stage 3.5 optimisation) — "pack one, multiply".
 *
 * A single dominant SKU consolidated into thousands of identical blocks would make
 * the greedy allocator re-pack the SAME van with the SAME cargo thousands of times
 * (heuristic-packer expands quantity → one anchor scan per block). That is quadratic
 * and the reason a huge single-SKU order times out.
 *
 * Since every full van of an identical SKU is identical, we pack ONE representative
 * van for real — real geometry, real crush, via the injected packer — then MULTIPLY
 * it arithmetically. Only the partial last van (the block remainder plus any small
 * leftover SKUs) is packed for real again, through the proven `allocateFleet`.
 *
 * Guarantee: for a single-SKU order this returns a fleet IDENTICAL to what
 * `allocateFleet`'s greedy completion produces (same van count, types, per-mile
 * rate) — because it selects the representative van with the exact same
 * `pickCheapestVan` rule and the same per-pack slice (`defaultPackCap()`). See
 * bulk-run-allocator.test.ts. When the order is NOT a clean single-dominant-SKU
 * bulk run, or fleet availability can't cover the full vans, it returns null and the
 * caller falls back to `allocateFleet` with ZERO behaviour change.
 *
 * Pure module: no I/O, no config reads (the caller passes thresholds resolved from
 * env.ts). Blocks/units throughout — a "unit" here is one placeable object (block).
 */
import { computeVanCostRate } from "@/lib/packing/van-cost";
import {
  allocateFleet,
  pickCheapestVan,
  fitsAnyVan,
  exceedReason,
  unitsOf,
  totalUnits,
  defaultPackCap,
  type FleetPlan,
} from "@/lib/packing/fleet-allocator";
import { vanQuantity } from "@/lib/packing/van-quantity";
import type { Item, Packer, PackingResult, Van } from "@/lib/packing/packing.types";

export interface BulkAllocateOptions {
  /** Clearance slack (m), matched to the packer's tolerance. */
  readonly toleranceM: number;
  /**
   * The dominant SKU's placeable-object count must EXCEED this for the fast-path to
   * engage. Keep it comfortably above `defaultPackCap()` so ordinary large orders
   * still flow through the exact/greedy allocator unchanged and only genuinely huge
   * single-SKU runs take this path. Config-driven (PACKING_BULK_RUN_MIN_UNITS).
   */
  readonly minDominantUnits: number;
  /** Per-representative-pack slice; defaults to the allocator's own cap. */
  readonly packCap?: number;
}

/** Placed-block count across a fleet's vans. */
function placedIn(vans: readonly PackingResult[]): number {
  return vans.reduce((n, r) => n + r.placements.length, 0);
}

/**
 * Attempt the bulk fast-path. Returns a complete FleetPlan when the order is a clean
 * single-dominant-SKU bulk run the fleet can cover, else null (caller falls back).
 */
export function tryBulkAllocate(
  items: Item[],
  vans: Van[],
  packer: Packer,
  opts: BulkAllocateOptions,
): FleetPlan | null {
  const tol = opts.toleranceM;
  const packCap = opts.packCap ?? defaultPackCap();

  // 1) Partition packable vs never-fits — IDENTICAL rule to allocateFleet, so the
  //    unplaced/reasons for un-carriable cargo match the fallback path exactly.
  const unplaced: Item[] = [];
  const reasons: Record<string, string> = {};
  const packable: Item[] = [];
  for (const item of items) {
    if (item.dimensions === null) {
      unplaced.push(item);
      reasons[item.id] = "missing or unparseable dimensions";
    } else if (!fitsAnyVan(item, vans, tol)) {
      unplaced.push(item);
      reasons[item.id] = exceedReason(item, vans, tol);
    } else {
      packable.push(item);
    }
  }
  if (packable.length === 0) return null; // nothing to optimise — let the normal path build it

  // 2) Trigger: exactly one dominant SKU (by object count) above threshold, with only
  //    a small leftover set (≤ one pack slice) — the shape a consolidated huge order
  //    takes (one big block Item + at most a remainder block). Anything more varied is
  //    the diverse case this fast-path deliberately does not handle → defer.
  const sorted = [...packable].sort((a, b) => unitsOf(b) - unitsOf(a));
  const dominant = sorted[0]!;
  const Q = unitsOf(dominant);
  if (Q <= opts.minDominantUnits) return null;
  const others = sorted.slice(1);
  if (totalUnits(others) > packCap) return null;

  const initAvail: Record<string, number> = Object.fromEntries(vans.map((v) => [v.id, vanQuantity(v)]));

  // 3) Representative pack: choose the van for a saturating slice of the dominant SKU
  //    with the exact greedy rule, then read how many blocks that van holds (k).
  const head: Item[] = [{ ...dominant, quantity: Math.min(Q, packCap) }];
  const pick = pickCheapestVan(head, vans, initAvail, packer);
  if (pick === null) return null; // no van holds even one — let the normal path flag it precisely

  const V = pick.van;
  const k = pick.result.placements.length;
  if (k < 1) return null;

  const fullVans = Math.floor(Q / k);
  const remB = Q - fullVans * k;

  // 4) Availability guard: we can only multiply if the fleet actually has that many of
  //    V. If not, the cost-optimal mix is genuinely a search problem → defer.
  if (fullVans > (initAvail[V.id] ?? 0)) return null;

  // A clean full-van layout of exactly k blocks (strip the surplus the oversized head
  // left unplaced — each replica van carries k and nothing spills on it).
  const replica: PackingResult = {
    van: V,
    placements: pick.result.placements,
    utilization: pick.result.utilization,
    unplaced: [],
    reasons: {},
  };
  const replicaPayload = replica.placements.reduce((s, p) => s + p.weightKg, 0);
  const replicaVanCost = computeVanCostRate(V, replicaPayload);

  // Reuse the SAME result object for every full van — identical layout, so the verify
  // gate (and any renderer) can dedupe by reference instead of revalidating thousands.
  const fullResults: PackingResult[] = Array.from({ length: fullVans }, () => replica);

  // 5) Tail: the block remainder + any small leftover SKUs, packed for real by the
  //    proven allocator against the fleet capacity the full vans didn't consume. The
  //    remainder van is chosen by the same cost rule (may be a smaller, cheaper van
  //    than V) — this is why single-SKU output matches greedy exactly.
  const tailCargo: Item[] = [
    ...(remB > 0 ? [{ ...dominant, quantity: remB }] : []),
    ...others,
  ];

  let tailVans: PackingResult[] = [];
  let tailRate = 0;
  if (tailCargo.length > 0) {
    const reducedVans = vans.map((v) => (v.id === V.id ? { ...v, quantity: vanQuantity(v) - fullVans } : v));
    const tailPlan = allocateFleet(tailCargo, reducedVans, packer, { toleranceM: tol });
    tailVans = tailPlan.vans;
    tailRate = tailPlan.totalPerMileRate;

    // allocateFleet already reconciles placed-vs-packable (it surfaces anything the fleet
    // couldn't carry as unplaced), so its unplaced is authoritative — just fold it in.
    // This keeps the service's placed + unplaced === total invariant intact.
    for (const u of tailPlan.unplaced) {
      unplaced.push(u);
      reasons[u.id] = reasons[u.id] ?? tailPlan.reasons[u.id] ?? "could not be placed";
    }
  }

  const vansOut = [...fullResults, ...tailVans];
  const placedUnits = placedIn(vansOut);

  return {
    vans: vansOut,
    unplaced,
    reasons,
    packableUnits: totalUnits(packable),
    placedUnits,
    fitsInSingleVan: vansOut.length === 1 && unplaced.length === 0,
    totalPerMileRate: fullVans * replicaVanCost + tailRate,
  };
}
