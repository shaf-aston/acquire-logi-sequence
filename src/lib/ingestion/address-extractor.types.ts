/**
 * The address-extraction seam. One engine turns a `StructuredDocument` (the
 * OCR'd quotation) into `DetectedAddresses` — a collection/pickup address plus
 * an ordered list of delivery drops. The rule engine matches labels + postcodes;
 * the groq engine reads the whole page with an LLM. Callers depend on this
 * interface, never a concrete engine (see address-extractor.factory.ts).
 *
 * Contract: `extract` is fail-soft — it never throws. A bad config, a network
 * outage, or a malformed LLM reply degrades to a weaker result (empty, or a
 * rule-based fallback), never a broken ingestion.
 */
import type { StructuredDocument } from "@/lib/conversion/types";
import type { DetectedAddresses } from "@/lib/ingestion/address-detector";

export interface AddressExtractor {
  /** Engine name for logs/telemetry — "rule" | "groq". */
  readonly provider: string;
  extract(document: StructuredDocument): Promise<DetectedAddresses>;
}
