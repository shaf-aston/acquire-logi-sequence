/**
 * Selects the classifier engine from config (CLASSIFIER_PROVIDER). Adding an
 * LLM-backed engine later is a one-line registry entry — no downstream change.
 */
import { getConfig } from "@/config/env";
import { RuleClassifier } from "@/lib/classification/rule-classifier";
import type { Classifier } from "@/lib/classification/types";

const registry: Record<string, () => Classifier> = {
  rule: () => new RuleClassifier(),
};

let cached: Classifier | null = null;

export function getClassifier(): Classifier {
  if (cached) return cached;
  const provider = getConfig().classification.provider.toLowerCase();
  const factory = registry[provider];
  if (!factory) {
    throw new Error(
      `[classification] Unknown CLASSIFIER_PROVIDER "${provider}". Known: ${Object.keys(registry).join(", ")}`,
    );
  }
  cached = factory();
  return cached;
}
