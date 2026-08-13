/**
 * The consignment-roster reader seam. One engine turns a `StructuredDocument` (an
 * OCR'd manifest or quote) into a ROSTER of draft consignments — several companies,
 * each with its own origin, destination, and pallet lines — for the shared-truck
 * planner. This is deliberately a DIFFERENT shape from address extraction: the
 * address extractor returns one shipper's pickup + drops, whereas groupage needs
 * N independent companies riding together.
 *
 * Callers depend on this interface, never a concrete engine (see
 * consignment-reader.factory.ts). Mirrors the address-extractor seam.
 *
 * Contract: `read` is fail-soft — it never throws. A bad config, a network outage,
 * or a malformed LLM reply degrades to an EMPTY roster, never a broken request. An
 * empty roster is honest ("couldn't read any companies"), never a guess.
 */
import type { StructuredDocument } from "@/lib/conversion/types";
import type { GroupagePallet } from "@/lib/groupage/groupage.types";

/** A field the reader was NOT confident about — drives the "check this" surface in the UI. */
export type ConsignmentReviewField = "company" | "originPostcode" | "destinationPostcode" | "pallets";

/**
 * One consignment the reader lifted off the document. Every field is nullable and
 * carries a `needsReview` list because a read is a SUGGESTION the operator confirms —
 * never trusted silently onto a truck (the never-guess surface).
 */
export interface ReadConsignmentDraft {
  readonly company: string | null;
  readonly originPostcode: string | null;
  readonly destinationPostcode: string | null;
  readonly pallets: readonly GroupagePallet[];
  /** Which fields the reader couldn't fill or wasn't sure of. Empty ⇒ read cleanly. */
  readonly needsReview: readonly ConsignmentReviewField[];
}

export interface ConsignmentRoster {
  readonly consignments: readonly ReadConsignmentDraft[];
  /** Plain-language "what I did to this document" lines for the operator — e.g. "I read the
   *  collection leg only; the delivery table is the same freight going out." Empty/absent for an
   *  ordinary read. Surfaced as the read notice, never as a silent transformation. */
  readonly notes?: readonly string[];
}

export interface ConsignmentReader {
  /** Engine name for logs/telemetry — "rule" | "groq". */
  readonly provider: string;
  read(document: StructuredDocument): Promise<ConsignmentRoster>;
}

export const EMPTY_ROSTER: ConsignmentRoster = { consignments: [] };
