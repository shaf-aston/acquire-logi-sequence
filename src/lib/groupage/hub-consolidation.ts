/**
 * Hub-consolidation collapse (groupage, huge-manifest path).
 *
 * A HUB CONSOLIDATION manifest (collect from N companies → hub → trunk → deliver to
 * M companies) describes the SAME consolidated load twice: once as collection legs
 * (origin known, destination is the hub) and once as delivery legs (destination
 * known, origin is the hub). The roster reader (groq-consignment-reader.ts) honestly
 * reads BOTH, so a 20-pallet trunk load comes back as ~40 pallets across N+M
 * consignments. Feeding that to the shared-truck planner double-counts the load.
 *
 * This module collapses that two-leg roster to the SINGLE trunk load the truck
 * actually carries: one consignment of the consolidated pallets, hub → hub. It is a
 * strict no-op for a normal groupage roster (every consignment has BOTH postcodes),
 * so simple manifests pass through byte-identical.
 *
 * Never guesses: the hub postcodes are a best-effort read off the document and are
 * always flagged in `needsReview` (a suggestion the operator confirms, never trusted
 * silently onto a truck — the same never-guess surface the reader uses). If the two
 * legs' pallet totals don't match, the pattern is NOT treated as a clean consolidation
 * and the roster is returned unchanged rather than picking a leg arbitrarily.
 *
 * Pure module: no I/O, no config reads. Operates on an already-read roster + the
 * structured document (for the hub postcodes only).
 */
import type {
  ConsignmentRoster,
  ConsignmentReviewField,
  ReadConsignmentDraft,
} from "@/lib/groupage/consignment-reader.types";
import type { GroupagePallet, PalletFootprintClass } from "@/lib/groupage/groupage.types";

export interface HubCollapse {
  /** True when the roster matched the two-leg hub pattern and was collapsed to a trunk load. */
  readonly collapsed: boolean;
  /** Plain-language "why" lines for the operator — empty when no collapse happened. */
  readonly reasons: readonly string[];
}

export interface HubCollapseResult {
  readonly roster: ConsignmentRoster;
  readonly collapse: HubCollapse;
}

const NO_COLLAPSE: HubCollapse = { collapsed: false, reasons: [] };

/** Total pallet quantity across a consignment's lines. */
function palletCount(c: ReadConsignmentDraft): number {
  return c.pallets.reduce((n, p) => n + p.quantity, 0);
}

/** Sum a set of consignments' pallet lines by footprint class (weight carried when known). */
function aggregatePallets(consignments: readonly ReadConsignmentDraft[]): GroupagePallet[] {
  const byClass = new Map<PalletFootprintClass, { quantity: number; weightKg: number; weighted: number }>();
  for (const c of consignments) {
    for (const p of c.pallets) {
      const acc = byClass.get(p.footprint) ?? { quantity: 0, weightKg: 0, weighted: 0 };
      acc.quantity += p.quantity;
      // Preserve a per-pallet weight: keep the max stated (0 when unknown) so the
      // aggregated line is never lighter than a real pallet in it.
      acc.weightKg = Math.max(acc.weightKg, p.weightKg);
      byClass.set(p.footprint, acc);
    }
  }
  return [...byClass.entries()].map(([footprint, acc]) => ({
    footprint,
    weightKg: acc.weightKg,
    quantity: acc.quantity,
  }));
}

/**
 * Collapse a hub-consolidation roster to its single trunk load, or return it
 * unchanged. The pattern holds ONLY when:
 *   • every consignment is one-sided — a collection leg (origin, no destination) or
 *     a delivery leg (destination, no origin); AND
 *   • both legs are non-empty; AND
 *   • the two legs carry the SAME total pallet count (the consolidation invariant —
 *     what was collected is what gets delivered).
 * Any deviation ⇒ not a clean consolidation ⇒ roster returned unchanged (fail safe:
 * never invent a trunk load from an ambiguous roster).
 */
export function collapseHubJourneyToTrunk(roster: ConsignmentRoster): HubCollapseResult {
  const cs = roster.consignments;
  if (cs.length < 2) return { roster, collapse: NO_COLLAPSE };

  const collection = cs.filter((c) => c.originPostcode !== null && c.destinationPostcode === null);
  const delivery = cs.filter((c) => c.destinationPostcode !== null && c.originPostcode === null);

  // Every consignment must be cleanly one-sided (no two-sided or empty ones), and
  // both legs present — otherwise this isn't a collect→hub→deliver manifest.
  if (collection.length + delivery.length !== cs.length) return { roster, collapse: NO_COLLAPSE };
  if (collection.length === 0 || delivery.length === 0) return { roster, collapse: NO_COLLAPSE };

  const collectPallets = collection.reduce((n, c) => n + palletCount(c), 0);
  const deliverPallets = delivery.reduce((n, c) => n + palletCount(c), 0);
  if (collectPallets === 0 || collectPallets !== deliverPallets) return { roster, collapse: NO_COLLAPSE };

  // The two hub postcodes are NOT reliably tied to a company row (they live in the
  // manifest's hub-transfer section, often OCR-merged with the customer address), so we
  // do NOT guess them — a wrong-but-flagged origin is worse than a blank the operator
  // fills from the manifest. Both are left null and flagged (prefer null over a guess).
  const needsReview: ConsignmentReviewField[] = ["originPostcode", "destinationPostcode"];

  const trunk: ReadConsignmentDraft = {
    company: "Consolidated trunk load",
    originPostcode: null,
    destinationPostcode: null,
    pallets: aggregatePallets(collection),
    needsReview,
  };

  const reasons = [
    `This manifest consolidates ${collection.length} collection${collection.length === 1 ? "" : "s"} ` +
      `(${collectPallets} pallets) through a hub, then delivers to ${delivery.length} drop${delivery.length === 1 ? "" : "s"}. ` +
      `The truck carries those ${collectPallets} pallets once — showing the trunk load only, so the ` +
      `collection and delivery legs aren't double-counted into ${collectPallets + deliverPallets}.`,
    `Enter the two hub postcodes from the manifest (collection hub → outbound hub) to price the trunk.`,
  ];

  return { roster: { consignments: [trunk] }, collapse: { collapsed: true, reasons } };
}
