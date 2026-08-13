/**
 * STATED PALLET TOTALS — the weight a pallet manifest declares for itself, in prose.
 *
 * A "simplified" manifest often gives a pallet count per line and no weight at all:
 *
 *     |  Item | Description           | Material           | Qty      | Pallets |
 *     |  1    | Wine Glasses (Boxed)  | Borosilicate Glass | 14 boxes | 14.0    |
 *
 * With no per-line weight the assembler falls back to `palletDefaults.defaultWeightKg` (400 kg), and
 * 266 pallets × 400 kg quotes the job at 106,400 kg. The real figure is 35,910 kg — a 3× error, and
 * one that would be priced and sent.
 *
 * But the sheet is not silent about it. It says, in the prose above the tables:
 *
 *     Total: 266 pallets | 35,910 kg
 *     Via: SWI Hub (Swindon) | ETA: 07 July 2026 | 91 pallets | 12,782 kg
 *
 * So we don't have to fall back to a constant: 35,910 ÷ 266 = 135 kg per pallet, from the document's
 * own numbers. That is derivation from stated fact, not a guess — the same move already made for
 * groupage in cargo-summary-weights.ts, and the reason a default weight should always be the LAST
 * resort rather than the first.
 *
 * Reads only the page markdown (the totals live in prose, not in any table). Pure: no I/O, no config.
 */
import { parseNumeric } from "@/lib/packing/numeric";
import type { StructuredDocument } from "@/lib/conversion/types";

/** "266 pallets", "91.0 pallets" — a pallet count stated in prose. */
const PALLETS = /([\d.,]+)\s*pallets?\b/i;
/** "35,910 kg" — a weight stated in prose. */
const KILOS = /([\d.,]+)\s*kg\b/i;
/** A line that declares the whole document's figures rather than one section's. */
const TOTAL_LINE = /\btotal\b/i;

export interface StatedPalletTotals {
  readonly pallets: number;
  readonly weightKg: number;
  /** Average weight of one pallet, as the document itself states it. */
  readonly perPalletKg: number;
  /** The line(s) this came from — shown to the operator, because we never assert without the source. */
  readonly source: string;
}

/**
 * Parse a figure printed with the document's declared decimal convention ("35,910" → 35910 under
 * "." English/US thousands; "35.910" → 35910 under "," Italian/European thousands). Uses the SAME
 * `parseNumeric` every other reader in this pipeline uses, rather than a second, hand-rolled
 * "strip commas" rule that silently assumes English — the assumption that let a European
 * "35.910 kg" total be misread as 35.91 kg, fall outside the plausibility band, and fall back to
 * the very 400 kg default this module exists to prevent (see item-assembler.ts's statedTotalsFor).
 */
function figure(raw: string | undefined, decimalSeparator: "." | ","): number | null {
  const n = parseNumeric(raw, decimalSeparator);
  return n !== null && n > 0 ? n : null;
}

/**
 * Read the pallet count and weight the document states for itself.
 *
 * A line stating BOTH is the only kind we trust — "266 pallets | 35,910 kg" ties the two figures
 * together, whereas a stray "kg" elsewhere on the page could belong to anything. A line saying
 * "total" wins outright; failing that, the per-section lines are summed (a manifest's stops add up
 * to its total: 91 + 84 + 91 = 266 pallets, 12,782 + 10,472 + 12,656 = 35,910 kg).
 *
 * Returns null when the document states no such pair — in which case the caller keeps its configured
 * default and says so. Silence here means "the sheet didn't say", never "assume".
 *
 * `decimalSeparator` is the same per-source convention declared in the column map
 * (config/column-map.json) — the prose total lives on the same document as the cargo table, so it
 * must be read under the same declared convention as everything else, never guessed independently.
 */
export function readStatedPalletTotals(
  doc: StructuredDocument,
  decimalSeparator: "." | ",",
): StatedPalletTotals | null {
  const candidates: Array<{ pallets: number; weightKg: number; line: string }> = [];

  for (const page of doc.pages) {
    for (const line of page.markdown.split(/\r?\n/)) {
      if (line.trim().startsWith("|")) continue; // a table row, not a prose declaration
      const pallets = figure(line.match(PALLETS)?.[1], decimalSeparator);
      const weightKg = figure(line.match(KILOS)?.[1], decimalSeparator);
      if (pallets === null || weightKg === null) continue;
      candidates.push({ pallets, weightKg, line: line.trim() });
    }
  }
  if (candidates.length === 0) return null;

  const totals = candidates.filter((c) => TOTAL_LINE.test(c.line));
  const chosen =
    totals.length > 0
      ? // A stated total speaks for the whole document — take the largest, so a per-stop line that
        // happens to say "Stop Total" can never outrank the document's own grand total.
        totals.reduce((a, b) => (b.pallets > a.pallets ? b : a))
      : {
          pallets: candidates.reduce((n, c) => n + c.pallets, 0),
          weightKg: candidates.reduce((n, c) => n + c.weightKg, 0),
          line: candidates.map((c) => c.line).join(" ; "),
        };

  if (chosen.pallets <= 0 || chosen.weightKg <= 0) return null;
  return {
    pallets: chosen.pallets,
    weightKg: chosen.weightKg,
    perPalletKg: chosen.weightKg / chosen.pallets,
    source: chosen.line,
  };
}
