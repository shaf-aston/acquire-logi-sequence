/**
 * Hub-consolidation manifest detector (ingest-time, cheap, no LLM).
 *
 * A groupage/consolidation manifest (collect from N companies → hub → trunk →
 * deliver to M companies) states its load as PALLETS moving through a hub — not as
 * the loose per-piece cargo the standard load-plan packer expects. Fed to that
 * packer, a piece-level summary explodes (a 10,000-carton line blows the block cap).
 * The right home is the shared-truck (groupage) planner, which quotes pallet-space.
 *
 * This spots the manifest at UPLOAD from cheap document signals so the UI can NUDGE
 * the operator there (never auto-route — advisory, mirroring the mode selector's
 * "real signal → plain-language why → operator decides" pattern). Header + markdown
 * scan only: no LLM, no row parsing.
 */
import type { StructuredDocument } from "@/lib/conversion/types";

/** A header that marks a pallet-manifest table (the load is counted in pallets). */
const PALLET_HEADER = /pallet/i;

/** Words that mark a hub-consolidation / groupage manifest (collect → hub → trunk → deliver). */
const CONSOLIDATION_SIGNAL =
  /(groupage|consolidation|consolidated cargo|line[-\s]?haul|cross[-\s]?dock|hub\s*transfer|trunk|distribution hub|collection hub|outbound hub)/i;

/**
 * A header that marks the ROSTER — the per-consignment collection column that only a shared load has.
 *
 * This is the signal that separates a real groupage manifest from a single shipper who merely happens
 * to move pallets through a hub. Groupage means several consignments POOLED onto one truck, so the
 * sheet must say, per line, whose goods these are and where to collect them ("Collection Company",
 * "Collection Address", "Origin Company"). One shipper delivering its own pallets to three shops says
 * none of that — it just lists cargo — however often the word "hub" or "groupage" appears on it.
 *
 * Without this check the detector fired on any pallet sheet with the word "trunk" in it, and sent a
 * perfectly readable single-shipper job to the shared-truck planner, which found no companies on it
 * and quoted NOTHING: docs/quotation-pdf-examples/03-manifest-variants/multi-drop/detailed.pdf reads
 * as a clean 266 pallets / 35,910 kg in the standard packer, but came back empty through groupage.
 */
const ROSTER_HEADER = /(collection|pickup|origin|consignor|shipper)\s*(company|address|site)|company\s*\/|consignor|shipper\b/i;

export interface HubManifestSignal {
  /** True when the document looks like a hub-consolidation / groupage manifest. */
  readonly isHubManifest: boolean;
  /** Plain-language "why" lines for the operator nudge. Empty when not detected. */
  readonly reasons: readonly string[];
}

const NOT_HUB: HubManifestSignal = { isHubManifest: false, reasons: [] };

/**
 * Detect a hub-consolidation manifest. ALL THREE signals are required, so an ordinary quote — and,
 * just as importantly, a single shipper's own pallet job — is never dragged into the shared-truck
 * planner:
 *   1. a table with a "Pallet" column (the load is counted in pallets), AND
 *   2. consolidation/hub/trunk wording somewhere in the document, AND
 *   3. a ROSTER column naming whose goods these are / where to collect them (see ROSTER_HEADER) —
 *      which is what makes a load SHARED rather than merely palletised.
 *
 * Signal 3 is the one that was missing. Signals 1 and 2 alone flag any pallet sheet that mentions a
 * hub, including one shipper's straightforward multi-drop — and routing that to a planner which reads
 * companies off the page produces an EMPTY quote, the worst possible failure: not a wrong number, but
 * no number, on a job the standard packer reads perfectly.
 */
export function detectHubConsolidationManifest(doc: StructuredDocument): HubManifestSignal {
  let hasPalletTable = false;
  let hasRosterColumn = false;
  const consolidationHits = new Set<string>();

  for (const page of doc.pages) {
    const markdownMatch = page.markdown.match(CONSOLIDATION_SIGNAL);
    if (markdownMatch) consolidationHits.add(markdownMatch[0].toLowerCase());

    for (const table of page.tables) {
      if (table.headers.some((h) => PALLET_HEADER.test(h))) hasPalletTable = true;
      if (table.headers.some((h) => ROSTER_HEADER.test(h))) hasRosterColumn = true;
      // A consolidation summary may live in a table header/label rather than prose.
      for (const h of table.headers) {
        const m = h.match(CONSOLIDATION_SIGNAL);
        if (m) consolidationHits.add(m[0].toLowerCase());
      }
    }
  }

  if (!hasPalletTable || !hasRosterColumn || consolidationHits.size === 0) return NOT_HUB;

  return {
    isHubManifest: true,
    reasons: [
      "This looks like a groupage consolidation manifest — several companies' pallets pooled onto one " +
        "truck through a hub, not one shipper's loose boxes.",
      "The standard load-plan packer reads the per-piece cargo summary and can over-count it " +
        "(a large piece line blows the packing limit). Quote the consolidated trunk load in the " +
        "shared-truck planner instead.",
    ],
  };
}
