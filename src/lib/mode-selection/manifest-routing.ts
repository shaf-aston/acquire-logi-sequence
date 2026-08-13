/**
 * MANIFEST ROUTING — "which quote form does this uploaded document open in?"
 *
 * A quotation PDF is not one shape. A hub-consolidation manifest states its load in pallets through
 * a hub; a milk-round lists pickups; an ordinary job lists one collection and some drops. Each needs
 * a DIFFERENT form, and the wrong one mis-reads the sheet (the standard packer, handed a groupage
 * manifest, over-counts its per-piece cargo summary and blows the block cap).
 *
 * This decision used to live inside the upload handler in `src/app/page.tsx`, as component code.
 * That made it untestable outside a browser — so "did this manifest open the right planner?", which
 * is exactly the bug class we keep hitting, could never be asserted from a terminal or a unit test.
 * The logic here is that same decision, lifted unchanged; the page now calls it.
 *
 * ADVISORY, always. The operator can switch to any mode from the selector — nothing here silently
 * commits a quote to a route. That is why every branch also returns its plain-language `reasons`:
 * the page shows them as the notice under the mode pills, so the operator sees WHY it moved.
 *
 * Not to be confused with `mode.selector.ts` (`selectMode`), which answers a different question at a
 * different time: AFTER packing, is this a part-load that would be cheaper on a shared truck? That
 * one scores economics; this one reads the document's own shape. Both exist; neither replaces the other.
 *
 * Pure: no I/O, no config reads, no React — so the CLI scenario sweep and the browser get the same
 * answer from the same code.
 */
import type { Direction } from "@/lib/mode-selection/mode.types";

/** The four quote forms a manifest can land on. Mirrors the page's `quoteMode` union. */
export type QuoteMode = "single" | "multi" | "groupage" | "collection";

/** The signals the routing decision reads. Every one is already returned by `ingestPdf()`. */
export interface RoutingSignals {
  /** Ingestion flagged a groupage / hub-consolidation sheet — `IngestionResult.hubManifest.isHubManifest`. */
  readonly isHubManifest: boolean;
  /** Which way the sheet runs — `IngestionResult.direction`. Absent ⇒ treated as a delivery. */
  readonly direction?: Direction;
  /** Distinct delivery addresses read off the sheet — `IngestionResult.addresses.drops.length`. */
  readonly dropCount: number;
  /** True when a collection address was read. Used only to tell "nothing found" from "pickup only". */
  readonly hasPickup: boolean;
  /**
   * Drop count at or above which a job is multi-stop. From config (`env.ts` modeSelection) — never a
   * client constant. `undefined` ⇒ config wasn't supplied, so we do NOT auto-switch to multi-stop
   * rather than invent a threshold.
   */
  readonly minDropsForMultiStop?: number;
}

export interface RoutingDecision {
  /**
   * The form to open — or `null` for "leave the operator where they are". `null` is a real outcome,
   * not a failure: a sheet with no addresses at all, or one with a pickup but no drops, gives us
   * nothing to route on, and guessing a mode there would be worse than doing nothing.
   */
  readonly mode: QuoteMode | null;
  /** Plain-language "why", surfaced to the operator. Empty when `mode` is null and nothing was read. */
  readonly reasons: string[];
}

/**
 * Route a manifest to its quote form. Branch ORDER is load-bearing and must not be reshuffled:
 *
 *  1. Hub manifest wins outright — a consolidation sheet is ALSO a collection run, so if the collect
 *     check came first, every groupage manifest would land on the pickup-round form. The consolidated
 *     trunk load is the quote we actually want.
 *  2. Then collect-direction — a milk-round / pickup schedule.
 *  3. Then drop count against the configured threshold — multi-stop vs single.
 */
export function routeManifest(signals: RoutingSignals): RoutingDecision {
  const { isHubManifest, direction, dropCount, hasPickup, minDropsForMultiStop } = signals;

  if (!hasPickup && dropCount === 0) {
    return { mode: null, reasons: [] };
  }

  if (isHubManifest) {
    return {
      mode: "groupage",
      reasons: ["Reads as a groupage consolidation manifest — its load is stated in pallets through a hub."],
    };
  }

  if (direction === "collect") {
    const pickups = dropCount + (hasPickup ? 1 : 0);
    return {
      mode: "collection",
      reasons: [
        pickups > 0
          ? `Reads as a collection round — ${pickups} pickup${pickups === 1 ? "" : "s"} detected.`
          : "Reads as a collection round.",
      ],
    };
  }

  if (minDropsForMultiStop !== undefined && dropCount >= minDropsForMultiStop) {
    return {
      mode: "multi",
      reasons: [`${dropCount} delivery addresses detected — at or above the ${minDropsForMultiStop}-drop multi-stop threshold.`],
    };
  }

  if (dropCount === 1) {
    return { mode: "single", reasons: ["1 delivery address detected."] };
  }

  // A pickup but no drops: there is a document, but nothing that decides a route. Say so, change nothing.
  return { mode: null, reasons: ["A collection address was detected, but no delivery addresses to route on."] };
}
