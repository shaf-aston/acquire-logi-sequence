/**
 * Drop-order pack strategy (multi-drop groupage): a stop-aware packer that WRAPS
 * the single-zone packer without editing it, so each van is loaded in delivery
 * order — the earliest-visited stop at the doors (unloaded first), later stops
 * deeper toward the cab. No digging to reach an early drop.
 *
 * The van interior box has x = length (depth, doors at x=0 → cab at x=interior.l),
 * y = width, z = up (packing.types.ts). This packer groups items by their 0-based
 * `stopIndex` and lays one contiguous x-band per stop in ASCENDING stop order from
 * the doors inward. Bands are DYNAMIC: each stop takes only the depth its cargo
 * needs, and the next stop begins at the cab-side edge of the previous one — so a
 * van that straddles a stop boundary still puts the earlier stop at its doors, and
 * no van length is reserved for a stop that isn't there.
 *
 * Each band is packed by the injected inner packer (today's HeuristicPacker,
 * unchanged) into a synthetic sub-van whose interior length IS the remaining depth;
 * placements are translated back by the band's x-offset and merged. Because bands
 * are disjoint x-ranges, a later stop's box can never stack on (or collide with) an
 * earlier stop's — the separation the dense packer would otherwise destroy.
 *
 * Multi-van: this composes with the fleet allocator unchanged. The allocator hands
 * each van the remaining cargo; this fills it stop-order door-first and returns the
 * overflow as `unplaced`, which the allocator carries to the next van — so the
 * fleet fills contiguously (van 1's cab-side stop continues at van 2's doors).
 *
 * Untagged items (no `stopIndex`) form a final, deepest band: they never block an
 * earlier stop and are never dropped merely for lacking a tag. Payload is a
 * whole-van limit, so the remaining payload is threaded across bands rather than
 * each band getting the full van's capacity.
 */
import { computeUtilization } from "@/lib/packing/placement-validator";
import type { Item, Packer, PackingResult, Placement, Van } from "@/lib/packing/packing.types";

export interface ZonedPackerOptions {
  /** The wrapped single-zone packer (today's HeuristicPacker). Used unchanged, once per band. */
  readonly inner: Packer;
}

/** Band key for an item with no stop — a synthetic band packed last (deepest). */
const UNTAGGED_BAND = Number.POSITIVE_INFINITY;

/**
 * A hair of clearance (m) inserted between one stop's band and the next. It keeps
 * the drop zones physically distinct AND guards the band boundary against a
 * floating-point sliver: the previous band's deepest box ends at `xCursor +
 * bandDepth`, and the next band's first box is placed at that same real value —
 * but the two sums associate differently, so without this gap they can round to a
 * ~1-ULP overlap that the strict validator (placement-validator.ts:116) rejects.
 * 1 mm is far above that error yet an order of magnitude below the 5 mm packing
 * tolerance, so it never changes what fits. Calibration knob — keep, do not inline.
 */
const BAND_GAP_M = 0.001;

export class ZonedPacker implements Packer {
  readonly strategy = "zoned-drop-order-3d";

  constructor(private readonly opts: ZonedPackerOptions) {}

  pack(items: Item[], van: Van): PackingResult {
    const { inner } = this.opts;

    // 1) Group by stop. Untagged items fall into a final band so they load deepest,
    //    never blocking an earlier stop and never dropped for lacking a tag.
    const byStop = new Map<number, Item[]>();
    for (const item of items) {
      const key = item.stopIndex ?? UNTAGGED_BAND;
      const band = byStop.get(key);
      if (band) band.push(item);
      else byStop.set(key, [item]);
    }
    const stopsAsc = [...byStop.keys()].sort((a, b) => a - b);

    // 2) Lay dynamic bands from the doors (x=0) inward in ascending stop order.
    const placements: Placement[] = [];
    const unplaced: Item[] = [];
    const reasons: Record<string, string> = {};
    let remainingPayloadKg = van.maxPayloadKg;
    let xCursor = 0;

    for (const stop of stopsAsc) {
      const bandItems = byStop.get(stop)!;
      const bandLength = Math.max(0, van.interior.l - xCursor);
      const subVan: Van = {
        ...van,
        interior: { ...van.interior, l: bandLength },
        maxPayloadKg: remainingPayloadKg,
      };
      const res = inner.pack(bandItems, subVan);

      // Translate this band's placements back into the real van, and measure how
      // deep (local x) the band actually reached so the next stop starts there.
      let bandDepth = 0;
      for (const p of res.placements) {
        placements.push({ ...p, position: { ...p.position, x: p.position.x + xCursor } });
        remainingPayloadKg -= p.weightKg;
        bandDepth = Math.max(bandDepth, p.position.x + p.size.x);
      }
      unplaced.push(...res.unplaced);
      Object.assign(reasons, res.reasons);

      // Advance past this band, plus a hair of clearance to the next stop's zone.
      // A band that placed nothing (bandDepth 0) leaves the cursor put.
      xCursor += bandDepth > 0 ? bandDepth + BAND_GAP_M : 0;
    }

    const { volumeFill: utilization } = computeUtilization(placements, van.interior);
    return { van, placements, utilization, unplaced, reasons };
  }
}
