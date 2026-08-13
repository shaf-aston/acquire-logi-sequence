/**
 * Rule-based fragility classifier. Walks item tables, matches each row's text
 * against the ruleset (fragile wins ties), defaults the unmatched and flags them
 * as low-confidence for review. No network, no cost — deterministic.
 */
import { createLogger } from "@/lib/logger/logger";
import { loadRuleset, type FragilityRuleset } from "@/lib/classification/ruleset";
import {
  isItemTable,
  rowLabel,
  rowSearchText,
  textColumnIndices,
} from "@/lib/classification/table-selector";
import type { StructuredDocument } from "@/lib/conversion/types";
import type {
  ClassificationResult,
  ClassifiedItem,
  Classifier,
  Fragility,
} from "@/lib/classification/types";

const logger = createLogger("classification.rule");

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word, plural-aware match — avoids substring false positives ("tile" in
 * "ductile") while still matching "tiles"/"screens". Phrases (with spaces or
 * hyphens) match too; the optional plural suffix applies to the trailing word.
 */
function matches(text: string, keyword: string): boolean {
  const re = new RegExp(`\\b${escapeRegex(keyword)}(?:e?s)?\\b`, "i");
  return re.test(text);
}

/** Returns the longest matching keyword (most specific) or null. */
function longestMatch(text: string, keywords: string[]): string | null {
  let best: string | null = null;
  for (const k of keywords) {
    if (matches(text, k) && (best === null || k.length > best.length)) best = k;
  }
  return best;
}

interface Decision {
  fragility: Fragility;
  confident: boolean;
  matchedTerm: string | null;
  reason: string;
}

function decide(searchText: string, rules: FragilityRuleset): Decision {
  // 1) Overrides — exact phrases that force a verdict (e.g. "glass reinforced
  //    plastic" → standard, so the generic "glass" keyword can't misfire).
  for (const o of rules.overrides) {
    if (matches(searchText, o.phrase)) {
      return { fragility: o.fragility, confident: true, matchedTerm: o.phrase, reason: `override "${o.phrase}" → ${o.fragility}` };
    }
  }

  // 2) Fragile precedence. If any fragile term matches, the item IS the fragile
  //    thing (glass/screen/oven/…); a co-matching "steel"/"timber" is just its
  //    structural material. Over-protecting is the safe error for transport.
  //    Specific non-fragile exceptions belong in overrides, not here.
  const fragileHit = longestMatch(searchText, rules.fragileKeywords);
  const standardHit = longestMatch(searchText, rules.standardKeywords);

  if (fragileHit) {
    const note = standardHit ? ` (over standard "${standardHit}")` : "";
    return { fragility: "fragile", confident: true, matchedTerm: fragileHit, reason: `matched fragile term "${fragileHit}"${note}` };
  }
  if (standardHit) {
    return { fragility: "standard", confident: true, matchedTerm: standardHit, reason: `matched standard term "${standardHit}"` };
  }

  // 3) Nothing matched — default and flag for review.
  return {
    fragility: rules.defaultWhenUnmatched,
    confident: false,
    matchedTerm: null,
    reason: `no rule matched — defaulted to "${rules.defaultWhenUnmatched}"`,
  };
}

export class RuleClassifier implements Classifier {
  readonly provider = "rule";

  async classify(doc: StructuredDocument): Promise<ClassificationResult> {
    const rules = await loadRuleset();
    const items: ClassifiedItem[] = [];

    for (const page of doc.pages) {
      for (const table of page.tables) {
        if (!isItemTable(table, rules)) continue;
        const textCols = textColumnIndices(table, rules);

        table.rows.forEach((row, rowIndex) => {
          const searchText = rowSearchText(row, textCols);
          if (searchText.trim() === "") return; // skip blank rows
          const label = rowLabel(row, textCols);
          const d = decide(searchText, rules);
          items.push({
            pageIndex: page.index,
            tableIndex: table.index,
            rowIndex,
            label,
            fragility: d.fragility,
            confident: d.confident,
            matchedTerm: d.matchedTerm,
            reason: d.reason,
          });
        });
      }
    }

    const counts = {
      fragile: items.filter((i) => i.fragility === "fragile").length,
      standard: items.filter((i) => i.fragility === "standard").length,
      lowConfidence: items.filter((i) => !i.confident).length,
    };

    logger.info("classification complete", {
      items: items.length,
      fragile: counts.fragile,
      standard: counts.standard,
      lowConfidence: counts.lowConfidence,
    });

    return { provider: this.provider, items, counts };
  }
}
