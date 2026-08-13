/**
 * Split an already-packed fleet into one bucket per pickup stop, for the collection
 * view's per-stop 3D pallet cards. Pure — no packing, no re-layout: it only regroups
 * the placements the packer already produced.
 *
 * Why per (van, stop) and not just per stop: a placement's position is in ITS van's
 * coordinate space, so a stop whose cargo spills across two vans must render as two
 * cards (each with its own van interior) or the boxes would overlap in one viewer.
 * On a milk-round that fits without splitting a stop, this is simply one card per stop.
 *
 * Stop attribution reuses `stopByItemId` (row id → 0-based manifest stop), the same map
 * that tags cargo rows to drops. A placement's `itemId` IS the row id, except a
 * consolidated block carries a `${rowId}::block` suffix — stripped here. Cargo with no
 * stop tag lands in a `stopIndex: null` bucket so it's surfaced, never silently dropped.
 */
import type { Placement, VanDimensions } from "@/types/api";

export interface FleetVan {
  readonly placements: Placement[];
  readonly interior: VanDimensions;
}

export interface StopPalletGroup {
  /** Stable identity for React keys / ordering: `${vanIndex}:${stopIndex ?? "none"}`. */
  readonly key: string;
  /** 0-based manifest stop this cargo belongs to, or null when untagged. */
  readonly stopIndex: number | null;
  /** Which van in the fleet these placements sit in (their coordinate space). */
  readonly vanIndex: number;
  readonly interior: VanDimensions;
  readonly placements: Placement[];
}

/** The row id behind a placement — drops a consolidated block's `::block` suffix. */
export function rowIdOfPlacement(itemId: string): string {
  const marker = itemId.indexOf("::");
  return marker === -1 ? itemId : itemId.slice(0, marker);
}

/**
 * Group a packed fleet into per-(van, stop) buckets, ordered by van then stop
 * (untagged stops — `null` — last within each van). Returns [] when there's nothing
 * to show (no fleet, or no placements).
 */
export function groupPlacementsByStop(
  fleet: readonly FleetVan[],
  stopByItemId: ReadonlyMap<string, number>,
): StopPalletGroup[] {
  const groups: StopPalletGroup[] = [];
  fleet.forEach((van, vanIndex) => {
    // Preserve first-seen order of stops within the van; `null` collected under one key.
    const buckets = new Map<number | null, Placement[]>();
    for (const p of van.placements) {
      const stop = stopByItemId.has(rowIdOfPlacement(p.itemId))
        ? stopByItemId.get(rowIdOfPlacement(p.itemId))!
        : null;
      const bucket = buckets.get(stop);
      if (bucket) bucket.push(p);
      else buckets.set(stop, [p]);
    }
    // Emit tagged stops in ascending stop order, then any untagged bucket.
    const keys = [...buckets.keys()].sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    });
    for (const stopIndex of keys) {
      groups.push({
        key: `${vanIndex}:${stopIndex ?? "none"}`,
        stopIndex,
        vanIndex,
        interior: van.interior,
        placements: buckets.get(stopIndex)!,
      });
    }
  });
  return groups;
}
