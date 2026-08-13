/**
 * Per-leg load profile — what each leg of a multi-stop path ACTUALLY carries.
 *
 * A pallet line boards the trunk at one station and alights at another. So a hop between two
 * stations carries only the lines whose itinerary spans it. Space freed by a line alighting at a
 * stop is available to a line boarding at that same stop — reselling that space is the entire
 * commercial point of calling at stops, and it falls out of the span test below with no special
 * case: a dropper (`alight === k`) is excluded from hop `k`, so a joiner (`board === k`) may take
 * its place on that hop.
 *
 * Pure, no I/O. Pricing is deliberately NOT computed from these loads (see `pricing.ts`): every
 * pallet is billed once, at load, on the end-to-end rate. This module is about physics — what fits
 * on the truck — not commerce.
 */
import { sumDemand } from "./demand";
import {
  GroupageError,
  type GroupageDemand,
  type GroupagePallet,
  type GroupagePath,
  type Hub,
  type PalletFootprintClass,
  type RoutedPallet,
} from "./groupage.types";

/**
 * Resolve each line's station refs to indices into `stations`. Absent refs default to the ends
 * (board at the origin hub, alight at the destination hub) — which is every line on a stop-free
 * route, and is why nothing changes when no stops are given.
 *
 * `stations` is `[]` on a local/direct path: there is no trunk, so no line may name a station.
 */
export function routePallets(pallets: readonly GroupagePallet[], stations: readonly Hub[]): readonly RoutedPallet[] {
  const last = stations.length - 1;

  const indexOf = (hubId: string, lineNo: number): number => {
    // resolveStops guarantees pairwise-distinct station ids, so this match is unambiguous.
    const idx = stations.findIndex((s) => s.id === hubId);
    if (idx === -1) {
      throw new GroupageError(
        "stops",
        `Pallet line ${lineNo}: "${hubId}" is not a stop on this route. Stations are: ${stations
          .map((s) => s.name)
          .join(" → ")}.`,
      );
    }
    return idx;
  };

  return pallets.map((p, i) => {
    const lineNo = i + 1;

    if (stations.length === 0) {
      if (p.joinAtHubId !== undefined || p.leaveAtHubId !== undefined) {
        throw new GroupageError(
          "stops",
          `Pallet line ${lineNo} names a trunk stop, but this route has no trunk stations. Remove its join/leave stop, or route via-hub with intermediate stops.`,
        );
      }
      // No trunk leg exists on this path, so these indices are never used to span a hop.
      return { ...p, boardStation: 0, alightStation: 0, lineNumber: lineNo };
    }

    const boardStation = p.joinAtHubId === undefined ? 0 : indexOf(p.joinAtHubId, lineNo);
    const alightStation = p.leaveAtHubId === undefined ? last : indexOf(p.leaveAtHubId, lineNo);

    if (boardStation >= alightStation) {
      throw new GroupageError(
        "stops",
        `Pallet line ${lineNo} leaves at ${stations[alightStation]!.name} but joins at ${stations[boardStation]!.name} — a line cannot leave before, or at, where it joins.`,
      );
    }
    return { ...p, boardStation, alightStation, lineNumber: lineNo };
  });
}

/**
 * Project routed lines onto every leg of the path, yielding the LINES each leg carries, in
 * `path.legs` order. Always returns exactly `path.legs.length` entries — `checkPath` depends on it.
 * `legLoads` sums these into per-leg demand; `oversizeLines` needs the lines themselves, because a
 * pallet that alone exceeds a vehicle is invisible once the bucket is summed.
 *
 * Buckets (stations = `[originHub, ...stops, destinationHub]`):
 *   • `collect`      → lines boarding at station 0. A line joining mid-trunk reached its stop on
 *                      someone else's run, never our collection van.
 *   • trunk hop `k`  → lines spanning station `k → k+1`.
 *   • `deliver`      → lines alighting at the last station.
 */
export function legBuckets(
  routed: readonly RoutedPallet[],
  path: GroupagePath,
): readonly (readonly RoutedPallet[])[] {
  const stationCount = path.kind === "hub" ? (path.stops?.length ?? 0) + 2 : 0;
  const last = stationCount - 1;

  // Re-assert the invariant `routePallets` established. `RoutedPallet` is structurally typed, so a
  // hand-built object could reach here with nonsense indices; a wrong index is a silent capacity
  // lie, which is the one failure this module exists to prevent.
  if (stationCount > 0) {
    routed.forEach((p, i) => {
      if (!Number.isInteger(p.boardStation) || !Number.isInteger(p.alightStation) || p.boardStation < 0 || p.boardStation >= p.alightStation || p.alightStation > last) {
        throw new GroupageError(
          "stops",
          `Pallet line ${i + 1} has an out-of-range itinerary (joins at station ${p.boardStation}, leaves at ${p.alightStation}, ${stationCount} stations). This is a bug; report it.`,
        );
      }
    });
  }

  const buckets: (readonly RoutedPallet[])[] = [];
  let hop = 0;

  for (const leg of path.legs) {
    let bucket: readonly RoutedPallet[];
    if (stationCount === 0) {
      // Local / direct: no trunk, so every line rides both legs the path has.
      bucket = routed;
    } else if (leg.kind === "collect") {
      bucket = routed.filter((p) => p.boardStation === 0);
      if (bucket.length === 0) {
        throw new GroupageError(
          "stops",
          `No pallets leave ${leg.from} — every line joins the trunk at a later stop. Set the origin to where freight actually starts, or add a line that boards at the start.`,
        );
      }
    } else if (leg.kind === "deliver") {
      // An empty deliver bucket is unreachable: a line that does not alight at the last station
      // cannot span the last hop either, so the hop guard below fires first with a sharper message.
      bucket = routed.filter((p) => p.alightStation === last);
    } else {
      const k = hop++;
      bucket = routed.filter((p) => p.boardStation <= k && p.alightStation >= k + 1);
      if (bucket.length === 0) {
        throw new GroupageError(
          "stops",
          `No pallets travel ${leg.from} → ${leg.to}. Remove that stop, or load freight for the hop.`,
        );
      }
    }
    buckets.push(bucket);
  }

  // A stop that neither gains nor sheds freight is a pointless detour the operator is paying a
  // per-stop fee for. Say so rather than quietly billing it.
  const stops = path.stops ?? [];
  stops.forEach((hub, s) => {
    const station = s + 1; // stops start at station index 1
    const touched = routed.some((p) => p.boardStation === station || p.alightStation === station);
    if (!touched) {
      throw new GroupageError(
        "stops",
        `Stop ${s + 1} (${hub.name}) has no pallets joining or leaving. Remove it, or set a pallet line to join or leave there.`,
      );
    }
  });

  // Exactly one push per leg above, so `buckets.length === path.legs.length` holds by construction.
  // The cross-module restatement of that contract lives in `checkPath`, where it can actually fail.
  return buckets;
}

/**
 * The demand each leg carries — `legBuckets` summed. One entry per `path.legs`, same order.
 * Kept as the module's headline export because every caller wants the totals, not the lines;
 * `legBuckets` is exposed only for the per-LINE checks (`oversizeLines`) that totals cannot answer.
 */
export function legLoads(
  routed: readonly RoutedPallet[],
  path: GroupagePath,
  footprintUnits: Readonly<Record<PalletFootprintClass, number>>,
): readonly GroupageDemand[] {
  return legBuckets(routed, path).map((bucket) => sumDemand(bucket, footprintUnits));
}
