/**
 * REARRANGE — re-optimise the contents of ONE container that the operator has edited by hand.
 *
 * After a session of dragging boxes, moving items between vans and unplacing things, a van's layout
 * drifts: holes open up, boxes sit where they were dropped rather than where they pack best. This
 * re-runs the REAL packer over exactly what is in that van now, so the operator gets an optimised
 * load back without losing the van-to-van decisions they made.
 *
 * It invents NO packing rules. It assembles the packer's inputs and picks the packer — everything
 * that decides where a box may sit (interior fit, overlap, support, crush pressure, reach height,
 * orientation locks, fragility) lives in placement-validator.ts, the single gate both the packer and
 * the manual drag editor already go through. So a rearranged layout is, by construction, one the
 * operator could have built by hand.
 *
 * Two things it does that the old in-viewer auto-stack did not:
 *   • the van's REAL payload ceiling is enforced. Over-weight units are refused and returned as
 *     `unplaced` with the packer's own reason, rather than quietly producing an illegal van.
 *   • DROP ORDER survives. A multi-drop van is packed by the ZonedPacker (earliest stop nearest the
 *     doors) whenever any item carries a `stopIndex` — the same rule the server applies in
 *     packer.service.ts. Without this, a rearrange would silently destroy the drop-order banding.
 *
 * Pure: no I/O, no config reads, no React. The packer is deterministic, so the same van rearranged
 * twice gives the same layout, and a rearrange with nothing to gain is a no-op.
 */
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { ZonedPacker } from "@/lib/packing/zoned-packer";
import type { Item, PackingResult, Van } from "@/lib/packing/packing.types";

export interface RearrangeOptions {
  /** Clearance slack (m) — the same value the server packed with. */
  readonly toleranceM: number;
  /** Highest a worker may place an item's base by hand (m); undefined ⇒ no limit. */
  readonly maxReachHeightM?: number;
}

/** True when this load is multi-drop, so it must be packed in drop order. Mirrors the server's rule
 *  (packer.service.ts) rather than inventing a second one. */
export function isMultiStop(items: readonly Item[]): boolean {
  return items.some((i) => i.stopIndex !== undefined);
}

/**
 * Re-pack `items` into `van` from scratch. The packer cannot pack into pre-occupied space, so
 * re-packing the WHOLE set is what makes a one-click tidy-up safe: the result can't overlap the
 * layout it replaces, because it replaces all of it.
 *
 * Anything that no longer fits — no space, too tall to reach, or over the van's payload — comes back
 * in `unplaced` with the reason. The caller must surface that; an item must never vanish silently.
 */
export function rearrangeVan(items: Item[], van: Van, opts: RearrangeOptions): PackingResult {
  const inner = new HeuristicPacker({ toleranceM: opts.toleranceM, maxReachHeightM: opts.maxReachHeightM });
  const packer = isMultiStop(items) ? new ZonedPacker({ inner }) : inner;
  return packer.pack(items, van);
}

/** A van type that would carry the leftovers, and how many of it that takes. */
export interface VanSuggestion {
  readonly van: Van;
  readonly vansNeeded: number;
}

/**
 * How many vans of `van`'s type it would REALLY take to carry `items` — by packing them, one van at
 * a time, until nothing is left. Not an estimate off total weight ÷ payload: that lies whenever the
 * load is bulky rather than heavy (or the reverse), and a load plan the operator can't actually
 * build is worse than no suggestion at all.
 *
 * Returns null when this van type cannot carry the load AT ALL — either a van packs nothing (an item
 * is too big, too tall, or too heavy for this type, so more of them would not help), or it would
 * take more than `maxVans`. Null means "don't offer this type", never "zero vans needed".
 */
export function vansNeededFor(items: Item[], van: Van, opts: RearrangeOptions, maxVans = 20): number | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  let remaining = items;
  for (let n = 1; n <= maxVans; n++) {
    const result = rearrangeVan(remaining, van, opts);
    if (result.unplaced.length === 0) return n;
    if (result.placements.length === 0) return null; // this van takes nothing — more of them won't either
    remaining = result.unplaced
      .map((u) => {
        const item = byId.get(u.id);
        return item ? { ...item, quantity: u.quantity } : null;
      })
      .filter((i): i is Item => i !== null && i.quantity > 0);
    if (remaining.length === 0) return n;
  }
  return null;
}

/**
 * The van type that clears the leftovers in the FEWEST vehicles (ties broken by the smaller van, so
 * we never suggest a 7.5-tonner where a Luton does). `candidates` is the operator's own fleet — only
 * types they actually have spare. Empty ⇒ nothing in the fleet can carry this cargo, which is itself
 * the honest answer and must be surfaced, not hidden behind a cheerier one.
 */
export function suggestVansFor(
  items: Item[],
  candidates: readonly Van[],
  opts: RearrangeOptions,
): VanSuggestion | null {
  const volume = (v: Van) => v.interior.l * v.interior.w * v.interior.h;
  let best: VanSuggestion | null = null;
  for (const van of candidates) {
    const vansNeeded = vansNeededFor(items, van, opts);
    if (vansNeeded === null) continue;
    if (
      best === null ||
      vansNeeded < best.vansNeeded ||
      (vansNeeded === best.vansNeeded && volume(van) < volume(best.van))
    ) {
      best = { van, vansNeeded };
    }
  }
  return best;
}
