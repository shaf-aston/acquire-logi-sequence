/**
 * Reads the HUBS a groupage/consolidation manifest names for itself, so a quote can route through
 * the hubs THIS document describes instead of only the saved network. A consolidation sheet states
 * its cross-dock hubs in labelled table columns — "Collection Hub", "Origin Hub", "Destination Hub"
 * (see the hub-transfer + collection-vehicle sections) — each cell carrying the hub's name, storage
 * address, and a postcode. This lifts one `Hub` per distinct postcode area from those cells.
 *
 * Why a postcode is mandatory: a hub's whole job is to own a **catchment** (postcode-area prefixes),
 * and that is derived from its postcode. A cell with no readable postcode yields no catchment, so it
 * is SKIPPED rather than guessed — the same never-guess stance as `hub-extractor`/`hub-consolidation`.
 *
 * Every hub carries the section it came from (`role`) and a `warning` when the name/address parse had
 * to fall back — these are SUGGESTIONS the operator sees and can edit, never silently trusted. Pure +
 * fail-soft: unreadable input returns an empty list, never throws.
 */
import { hubIdFromName, postcodeArea } from "./hub-resolver";
import type { Hub } from "./groupage.types";
import type { StructuredDocument } from "@/lib/conversion/types";
import { UK_POSTCODE } from "@/lib/geo/postcode";

/** Which labelled section named the hub — lets the caller tell the collection end from the trunk end. */
export type ManifestHubRole = "collection" | "destination";

/** A hub lifted off the manifest. A read is a suggestion, so `warning` flags an uncertain parse. */
export interface ManifestHub extends Hub {
  readonly role: ManifestHubRole;
  /**
   * The full postcode that seeded this hub's catchment (e.g. "HD1 6EJ"). Lets the planner prefill a
   * hub-to-hub consignment's blank origin/destination postcode from the manifest, not just its area.
   */
  readonly postcode: string;
  /** Set when the name (and thus address split) was a heuristic fall-back — surface for review. */
  readonly warning?: string;
}

export interface ManifestHubReadOptions {
  /** Case-insensitive regex for a table HEADER that names a hub column. */
  readonly hubColumnPattern: RegExp;
  /** Which hub-header words mean the DESTINATION (trunk) end; everything else is a collection end. */
  readonly destinationPattern: RegExp;
  /** Full-UK-postcode regex (source string reused from address-detection config). */
  readonly postcodePattern: RegExp;
}

const DEFAULTS: ManifestHubReadOptions = {
  // "Collection Hub", "Origin Hub", "Destination Hub", "Outbound Hub", "Nearest Hub".
  hubColumnPattern: /(collection|origin|destination|outbound|nearest)\s+hub/i,
  destinationPattern: /(destination|outbound)/i,
  // Case-sensitive (no "i" flag) to match the caller-supplied default exactly as before: this
  // default only fires when a caller passes no `postcodePattern` option (the production path —
  // ingestion.service.ts — always threads config/address-detection.json's canonical pattern in
  // instead). Built from UK_POSTCODE's source rather than UK_POSTCODE itself, so this stays
  // byte-identical to the pre-refactor default rather than picking up its "i" flag.
  postcodePattern: new RegExp(UK_POSTCODE.source),
};

// Address-line lead-ins: the hub NAME ends where the street address begins. Cutting the cell at the
// earliest of these separates "SwiftHaul Nottingham Distribution Hub" from "Bay 7, Colwick …". Only
// STRUCTURAL street words belong here — not "Depot"/"Warehouse"/"Centre", which are part of hub names.
const ADDRESS_LEAD = /\b(Unit|Units|Bay|Suite|Floor|Building|Block|Bldg|No\.?)\b/i;
// Trailing contact cruft that isn't part of the postal address.
const ADDRESS_TAIL = /\b(Hub\s*Mgr|Manager|Tel|Mobile|Contact|Licence|Reg:)\b|\+\d/i;

/** Split a hub cell into { name, address } at the first address lead-in; fall back to the whole cell. */
function splitNameAddress(cell: string): { name: string; address: string | null; uncertain: boolean } {
  const lead = cell.match(ADDRESS_LEAD);
  if (lead?.index === undefined) {
    // No street lead-in — take up to the first comma as the name, no confident address.
    const comma = cell.indexOf(",");
    const name = (comma > 0 ? cell.slice(0, comma) : cell).replace(/\s+/g, " ").trim();
    return { name, address: null, uncertain: true };
  }
  const name = cell.slice(0, lead.index).replace(/\s+/g, " ").trim();
  let rest = cell.slice(lead.index);
  const tail = rest.match(ADDRESS_TAIL);
  if (tail?.index !== undefined) rest = rest.slice(0, tail.index);
  const address = rest.replace(/\s+/g, " ").replace(/[,\s]+$/, "").trim() || null;
  return { name, address, uncertain: name === "" };
}

/**
 * Read the hubs a consolidation manifest names for itself. Scans every table for hub-named columns,
 * pulls one hub per distinct postcode AREA (a "Collection Hub" and an "Origin Hub" naming the same
 * depot collapse to one), and returns them in document order. Empty when the sheet names none.
 */
export function readManifestHubs(
  document: StructuredDocument,
  options: Partial<ManifestHubReadOptions> = {},
): ManifestHub[] {
  const opts = { ...DEFAULTS, ...options };
  const byArea = new Map<string, ManifestHub>();
  const usedIds = new Set<string>();

  for (const page of document.pages) {
    for (const table of page.tables) {
      table.headers.forEach((header, col) => {
        if (!opts.hubColumnPattern.test(header)) return;
        const role: ManifestHubRole = opts.destinationPattern.test(header) ? "destination" : "collection";

        // One hub per column. OCR splits a hub's identity DOWN its column — name, street, city +
        // postcode, manager each on their own row (and a "merged cell" sheet puts them all in row 0).
        // Joining the column's rows reconstructs the full block either way, so we parse it once.
        const block = table.rows.map((row) => (row[col] ?? "").trim()).filter((c) => c !== "").join(" ").trim();
        if (block === "") return;

        const pcMatch = block.match(opts.postcodePattern);
        if (!pcMatch) return; // no postcode ⇒ no catchment ⇒ never guess one
        const postcode = pcMatch[0].replace(/\s+/g, " ").trim().toUpperCase();
        let area: string;
        try {
          area = postcodeArea(postcode);
        } catch {
          return; // postcode-shaped but not resolvable — skip rather than guess
        }
        if (byArea.has(area)) return; // same depot named twice (collection + origin) ⇒ keep first

        const { name, address, uncertain } = splitNameAddress(block);
        const finalName = name || `${area} hub`;
        const id = hubIdFromName(finalName, usedIds, area);
        usedIds.add(id);

        byArea.set(area, {
          id,
          name: finalName,
          catchment: [area],
          role,
          postcode,
          ...(address ? { address } : {}),
          ...(uncertain ? { warning: "Couldn't cleanly read this hub's name — check it before using." } : {}),
        });
      });
    }
  }

  return [...byArea.values()];
}

/**
 * Widen the manifest's COLLECTION hub so its catchment covers every postcode area the collection
 * run actually collects from. A collection hub's postcode only seeds its OWN area (e.g. HD1 6EJ →
 * "HD"), but a groupage run consolidates companies from several nearby areas (HX, WF, …) into that
 * one hub — the manifest is the authority that they all cross-dock there. Without this, an
 * out-of-area company resolves to a different saved hub and splits off the shared truck (or trips a
 * "no hub covers area X" catchment gap).
 *
 * Only the SINGLE collection hub is widened, and an area already owned by another manifest hub (e.g.
 * the destination) is left alone — so the manifest's own hubs stay disjoint (the invariant
 * `parseSessionHubs`/`mergeSessionHubs` rely on). Pure: returns a new list, never mutates the input.
 */
export function widenCollectionHubCatchment(
  hubs: readonly ManifestHub[],
  originPostcodes: readonly string[],
): ManifestHub[] {
  const collectionIdx = hubs.findIndex((h) => h.role === "collection");
  if (collectionIdx === -1) return [...hubs];

  // Areas already claimed by ANY manifest hub keep their owner (disjoint invariant).
  const owned = new Set(hubs.flatMap((h) => h.catchment));
  const extra: string[] = [];
  for (const pc of originPostcodes) {
    let area: string;
    try {
      area = postcodeArea(pc);
    } catch {
      continue; // an unreadable origin postcode simply adds no coverage
    }
    if (owned.has(area) || extra.includes(area)) continue;
    extra.push(area);
  }
  if (extra.length === 0) return [...hubs];

  return hubs.map((h, i) =>
    i === collectionIdx ? { ...h, catchment: [...h.catchment, ...extra] } : h,
  );
}
