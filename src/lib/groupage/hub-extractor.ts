/**
 * Best-effort hub extraction from OCR'd document text (hub-sourcing tier 3). Scans for UK
 * postcodes and turns each distinct postcode area into a candidate hub (name from the line, the
 * area as its starting catchment). This is a CONVENIENCE import — its output is shown to the
 * operator to review, edit, and confirm, and lands in the same editable Hubs list, so anything it
 * gets wrong is corrected by hand. It NEVER overwrites the network by itself.
 *
 * The parse is deliberately honest about what it could NOT use: extra depots found in an
 * already-claimed area are returned as `duplicates` (surfaced, not silently dropped), and a
 * candidate whose name could not be read carries a `warning`. Pure + testable.
 */
import type { Hub } from "./groupage.types";
import { hubIdFromName } from "./hub-resolver";

// Full-ish UK postcode: area (1–2 letters) + district digit(s) + optional letter, space, inward code.
const POSTCODE_RE = /\b([A-Z]{1,2})\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;

/** A hub the parser proposes. `warning` is set when the parse is uncertain (e.g. no readable name). */
export interface HubCandidate extends Hub {
  warning?: string;
}

/** A depot line the parser could not turn into a new hub — surfaced so the operator can add it by hand. */
export interface DroppedDepot {
  /** The raw line, trimmed. */
  text: string;
  /** The postcode area it fell into — already claimed by an earlier candidate. */
  area: string;
}

export interface HubExtractionResult {
  candidates: HubCandidate[];
  /** Extra depots found in an area we already claimed. We kept the first; these are shown for manual review. */
  duplicates: DroppedDepot[];
}

export function extractHubCandidates(text: string, maxCandidates = 100): HubExtractionResult {
  const byArea = new Map<string, HubCandidate>();
  const duplicates: DroppedDepot[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    POSTCODE_RE.lastIndex = 0;
    const match = POSTCODE_RE.exec(line);
    if (!match) continue;

    const area = match[1]!.toUpperCase();
    if (byArea.has(area)) {
      duplicates.push({ text: line, area }); // surfaced for review, not silently discarded
      continue;
    }

    // Name = the line minus the postcode + trailing separators; empty name → flag for a rename.
    const name = line.replace(match[0], "").replace(/[,\-–|·•]+\s*$/, "").replace(/\s+/g, " ").trim();
    const candidate: HubCandidate = {
      id: "", // assigned below, once all names are known, so collisions dedupe deterministically
      name: name || `${area} depot`,
      catchment: [area],
    };
    if (!name) candidate.warning = "No name found in the PDF — rename before adding.";
    byArea.set(area, candidate);

    if (byArea.size >= maxCandidates) break;
  }

  // Assign unique ids from each candidate's name (area as the fallback/collision seed).
  const seen = new Set<string>();
  const candidates = [...byArea.values()].map((h) => {
    const id = hubIdFromName(h.name, seen, h.catchment[0]!);
    seen.add(id);
    return { ...h, id };
  });

  return { candidates, duplicates };
}
