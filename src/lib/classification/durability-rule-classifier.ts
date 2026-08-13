/**
 * Rule-based durability classifier — the no-AI default. Matches a material string
 * against config/durability-rules.json: overrides first, then the WEAKEST matched
 * tier (a weak component caps durability — same weakest-component semantics the
 * Groq engine's prompt uses, so the two swap-seam engines agree), knocked down one
 * tier for a hollow-build keyword, plus independent brittle/deformable/orientation
 * keyword checks. No network, no cost, deterministic — same decision-order
 * convention as the fragility rule-classifier.
 */
import { createLogger } from "@/lib/logger/logger";
import { loadDurabilityRuleset, type DurabilityRuleset } from "@/lib/classification/durability-ruleset";
import type {
  DurabilityClassification,
  DurabilityClassifier,
  DurabilityTier,
  OrientationLock,
} from "@/lib/classification/durability.types";

const logger = createLogger("classification.durability-rule");

const TIER_ORDER: readonly DurabilityTier[] = ["none", "low", "medium", "high"];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, plural-aware match — same convention as the fragility classifier. */
function matches(text: string, keyword: string): boolean {
  const re = new RegExp(`\\b${escapeRegex(keyword)}(?:e?s)?\\b`, "i");
  return re.test(text);
}

function longestMatch(text: string, keywords: string[]): string | null {
  let best: string | null = null;
  for (const k of keywords) {
    if (matches(text, k) && (best === null || k.length > best.length)) best = k;
  }
  return best;
}

function anyMatch(text: string, keywords: string[]): boolean {
  return keywords.some((k) => matches(text, k));
}

function stepDown(tier: DurabilityTier): DurabilityTier {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.max(0, i - 1)]!;
}

function classifyOne(material: string, rules: DurabilityRuleset): DurabilityClassification {
  const text = material.toLowerCase();

  for (const o of rules.overrides) {
    if (matches(text, o.phrase)) {
      return {
        material,
        durabilityTier: o.durabilityTier,
        brittle: o.brittle,
        deformable: o.deformable,
        orientationLock: o.orientationLock,
        confident: true,
        reason: `override "${o.phrase}"`,
      };
    }
  }

  // Weakest matched tier wins. TIER_ORDER runs weakest → strongest, so the first
  // tier with any keyword hit caps durability — e.g. "Solid Wood / Foam" resolves
  // to "none" (foam), never "high". This matches the Groq engine's WEAKEST-
  // component rule and the conservative-bias principle (material facts must
  // tighten, never loosen). longestMatch only picks the reason keyword within the
  // selected tier; a single-material string still resolves to its one tier.
  let bestTier: DurabilityTier | null = null;
  let bestMatch: string | null = null;
  for (const tier of TIER_ORDER) {
    const hit = longestMatch(text, rules.tiers[tier]);
    if (hit) {
      bestTier = tier;
      bestMatch = hit;
      break;
    }
  }

  const brittle = anyMatch(text, rules.brittleKeywords);
  const deformable = anyMatch(text, rules.deformableKeywords);
  const fixedHit = anyMatch(text, rules.orientationKeywords.fixed);
  const partialHit = anyMatch(text, rules.orientationKeywords.partial);
  const orientationLock: OrientationLock = fixedHit ? "fixed" : partialHit ? "partial" : "none";

  if (bestTier === null) {
    return {
      material,
      durabilityTier: rules.defaultTier,
      brittle,
      deformable,
      orientationLock,
      confident: false,
      reason: `no tier keyword matched — defaulted to "${rules.defaultTier}"`,
    };
  }

  const hollow = anyMatch(text, rules.hollowKeywords);
  const finalTier = hollow ? stepDown(bestTier) : bestTier;

  return {
    material,
    durabilityTier: finalTier,
    brittle,
    deformable,
    orientationLock,
    confident: true,
    reason: hollow
      ? `matched "${bestMatch}" (${bestTier}), knocked down for hollow build`
      : `matched "${bestMatch}"`,
  };
}

export class DurabilityRuleClassifier implements DurabilityClassifier {
  readonly provider = "rule";

  async classify(materials: readonly string[]): Promise<Map<string, DurabilityClassification>> {
    const rules = await loadDurabilityRuleset();
    const out = new Map<string, DurabilityClassification>();
    for (const raw of materials) {
      const key = raw.trim();
      if (key === "" || out.has(key)) continue;
      out.set(key, classifyOne(key, rules));
    }
    logger.info("durability classification complete", { materials: out.size });
    return out;
  }
}
