/**
 * Rule engine for the address seam: the original label + postcode detector,
 * wrapped as an `AddressExtractor`. Kept as the default (no key, no network) and
 * as the fallback the groq engine degrades to when the LLM is unavailable.
 *
 * Fail-soft: a missing/broken config yields an empty result and a warning — it
 * must never fail ingestion (address prefill is a convenience, not a requirement).
 */
import { createLogger } from "@/lib/logger/logger";
import {
  detectAddresses,
  loadAddressDetectionConfig,
  type DetectedAddresses,
} from "@/lib/ingestion/address-detector";
import type { AddressExtractor } from "@/lib/ingestion/address-extractor.types";
import type { StructuredDocument } from "@/lib/conversion/types";

const logger = createLogger("ingestion.address-rule");

export class RuleAddressExtractor implements AddressExtractor {
  readonly provider = "rule";

  async extract(document: StructuredDocument): Promise<DetectedAddresses> {
    try {
      const config = await loadAddressDetectionConfig();
      return detectAddresses(document, config);
    } catch (err) {
      logger.warn("rule address detection failed — continuing without suggestions", {
        error: String(err),
      });
      return { pickup: null, drops: [] };
    }
  }
}
