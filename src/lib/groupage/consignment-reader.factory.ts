/**
 * Selects the consignment-roster reader from config (CONSIGNMENT_READER_PROVIDER):
 *   - "rule" : parse the structured collection-run table only (offline, no key). Empty
 *              roster for a freeform manifest it can't split.
 *   - "groq" : read the whole document with an LLM (freeform manifests, its own key).
 *   - "auto" : rule first, falling through to groq for freeform manifests — structured
 *              runs read offline, the LLM handles only what a regex pass genuinely can't.
 * Default is "rule" (key-free, offline). Mirrors address-extractor.factory.ts.
 */
import { getConfig } from "@/config/env";
import { RuleConsignmentReader } from "@/lib/groupage/rule-consignment-reader";
import { GroqConsignmentReader } from "@/lib/groupage/groq-consignment-reader";
import type { ConsignmentReader } from "@/lib/groupage/consignment-reader.types";

const registry: Record<string, () => ConsignmentReader> = {
  rule: () => new RuleConsignmentReader(),
  groq: () => new GroqConsignmentReader(),
  auto: () => new RuleConsignmentReader({ fallback: new GroqConsignmentReader() }),
};

let cached: ConsignmentReader | null = null;

export function getConsignmentReader(): ConsignmentReader {
  if (cached) return cached;
  const provider = getConfig().consignmentReader.provider.toLowerCase();
  const factory = registry[provider];
  if (!factory) {
    throw new Error(
      `[groupage.consignment-reader] Unknown CONSIGNMENT_READER_PROVIDER "${provider}". Known: ${Object.keys(registry).join(", ")}`,
    );
  }
  cached = factory();
  return cached;
}
