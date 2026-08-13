/**
 * Decides which tables are *item* tables (vs metadata like company/address) and
 * which columns hold classifiable text. Pure functions driven by the ruleset —
 * this is what stops an address row from ever being labelled fragile.
 */
import type { ExtractedTable } from "@/lib/conversion/types";
import type { FragilityRuleset } from "@/lib/classification/ruleset";

function countHeaderMatches(headers: string[], keywords: string[]): number {
  const lower = headers.map((h) => h.toLowerCase());
  let count = 0;
  for (const h of lower) {
    if (keywords.some((k) => h.includes(k))) count++;
  }
  return count;
}

/**
 * An item table has at least `minHeaderMatches` headers that look like item columns.
 *
 * `headerless` tables are rejected outright, even before the keyword count: the scan lost the real
 * header row, so whatever text sits in `table.headers` (empty, or a banner line table-normaliser
 * could not place) proves nothing about column meaning. Resolving columns by position on it is the
 * exact guess `headerless` exists to forbid — see conversion/types.ts. Gating here means every
 * downstream reader that iterates `classification.items` never sees a row from this table at all.
 */
export function isItemTable(table: ExtractedTable, rules: FragilityRuleset): boolean {
  if (table.headerless) return false;
  return countHeaderMatches(table.headers, rules.itemTableHeaderKeywords) >= rules.minHeaderMatches;
}

/** Indices of columns whose header looks like free text (description/material/…). */
export function textColumnIndices(table: ExtractedTable, rules: FragilityRuleset): number[] {
  const indices: number[] = [];
  table.headers.forEach((header, i) => {
    const h = header.toLowerCase();
    if (rules.textColumnKeywords.some((k) => h.includes(k))) indices.push(i);
  });
  return indices;
}

/** Builds the text used for keyword matching from a row's text columns (fallback: all cells). */
export function rowSearchText(row: string[], textCols: number[]): string {
  const source = textCols.length > 0 ? textCols.map((i) => row[i] ?? "") : row;
  return source.join(" ").toLowerCase();
}

/** Best human label for a row — first text column, else the longest cell. */
export function rowLabel(row: string[], textCols: number[]): string {
  if (textCols.length > 0) {
    return textCols.map((i) => row[i] ?? "").filter(Boolean).join(" — ");
  }
  return [...row].sort((a, b) => b.length - a.length)[0] ?? "";
}
