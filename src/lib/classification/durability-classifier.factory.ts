/**
 * Selects the durability classifier engine from config (DURABILITY_CLASSIFIER_PROVIDER).
 * Default is "rule" — no network, no key required, fully inert until an operator
 * opts in. Mirrors classifier.factory.ts (Stage 2 fragility classifier).
 */
import { getConfig } from "@/config/env";
import { createLogger } from "@/lib/logger/logger";
import { DurabilityRuleClassifier } from "@/lib/classification/durability-rule-classifier";
import { DurabilityGroqClassifier } from "@/lib/classification/durability-groq-classifier";
import type { DurabilityClassifier } from "@/lib/classification/durability.types";

const logger = createLogger("classification.durability-factory");

/**
 * Builds the LLM fallback chain: Groq → SambaNova → rule. SambaNova (an OpenAI-compatible
 * backup endpoint) is only inserted when its key + model are configured; otherwise Groq
 * falls straight through to the rule classifier. SambaNova reuses Groq's tuning knobs
 * (timeouts/retries/chunk size) — only the endpoint (apiKey/model/baseUrl) differs.
 *
 * If Groq itself is unconfigured (no key/model) but SambaNova IS configured, Groq is
 * skipped entirely and SambaNova becomes the primary — there is no point instantiating
 * a Groq layer that will only ever fail loud. If neither LLM is configured, today's
 * fail-loud behaviour is unchanged: the Groq layer throws at classify()-time.
 */
function buildGroqChain(): DurabilityClassifier {
  const rule = new DurabilityRuleClassifier();
  const { groq, sambanova } = getConfig().durability;
  const sambanovaConfigured = Boolean(sambanova.apiKey && sambanova.model);
  const backup: DurabilityClassifier = sambanovaConfigured
    ? new DurabilityGroqClassifier({
        provider: "sambanova",
        fallback: rule,
        cfg: () => {
          const d = getConfig().durability;
          return { ...d.groq, ...d.sambanova };
        },
      })
    : rule;

  const groqConfigured = Boolean(groq.apiKey && groq.model);
  if (!groqConfigured && sambanovaConfigured) {
    logger.warn("groq key/model unset — sambanova is primary");
    return backup;
  }

  return new DurabilityGroqClassifier({ fallback: backup });
}

const registry: Record<string, () => DurabilityClassifier> = {
  rule: () => new DurabilityRuleClassifier(),
  groq: buildGroqChain,
  // Allow SambaNova as the primary provider too (its own key), still backed by the rule classifier.
  sambanova: () =>
    new DurabilityGroqClassifier({
      provider: "sambanova",
      cfg: () => {
        const d = getConfig().durability;
        return { ...d.groq, ...d.sambanova };
      },
    }),
};

let cached: DurabilityClassifier | null = null;

export function getDurabilityClassifier(): DurabilityClassifier {
  if (cached) return cached;
  const provider = getConfig().durability.provider.toLowerCase();
  const factory = registry[provider];
  if (!factory) {
    throw new Error(
      `[classification.durability] Unknown DURABILITY_CLASSIFIER_PROVIDER "${provider}". Known: ${Object.keys(registry).join(", ")}`,
    );
  }
  cached = factory();
  return cached;
}
