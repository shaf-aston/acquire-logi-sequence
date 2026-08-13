/**
 * Selects the address-extraction engine from config (ADDRESS_EXTRACTOR_PROVIDER).
 * Default is "rule" — no network, no key required, inert until an operator opts
 * in. Set to "groq" to read addresses with an LLM. Mirrors
 * durability-classifier.factory.ts.
 */
import { getConfig } from "@/config/env";
import { RuleAddressExtractor } from "@/lib/ingestion/rule-address-extractor";
import { GroqAddressExtractor } from "@/lib/ingestion/groq-address-extractor";
import type { AddressExtractor } from "@/lib/ingestion/address-extractor.types";

const registry: Record<string, () => AddressExtractor> = {
  rule: () => new RuleAddressExtractor(),
  groq: () => new GroqAddressExtractor(),
};

let cached: AddressExtractor | null = null;

export function getAddressExtractor(): AddressExtractor {
  if (cached) return cached;
  const provider = getConfig().addressExtraction.provider.toLowerCase();
  const factory = registry[provider];
  if (!factory) {
    throw new Error(
      `[ingestion.address] Unknown ADDRESS_EXTRACTOR_PROVIDER "${provider}". Known: ${Object.keys(registry).join(", ")}`,
    );
  }
  cached = factory();
  return cached;
}
