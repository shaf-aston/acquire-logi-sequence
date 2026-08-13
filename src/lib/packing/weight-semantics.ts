/**
 * WEIGHT SEMANTICS — is the sheet's weight column a PER-UNIT weight, or the LINE'S TOTAL?
 *
 * Both conventions are common and neither is labelled, but the difference is enormous. Take a real
 * line from docs/quotation-pdf-examples/03-manifest-variants/route-plan/detailed.pdf:
 *
 *     | # | Item Description        | Material           | H  | W   | D   | Qty | Wt |
 *     | 1 | Wine Glasses (200 pcs)  | Borosilicate Glass | 30 | 120 | 100 | 200 | 48 |
 *
 * Read "Wt" as per-unit and the line weighs 200 × 48 = 9,600 kg. Read it as the line's total and it
 * weighs 48 kg. Across that one sheet the difference was 760,535 kg versus 2,565 kg — a 300× error,
 * quoted with total confidence.
 *
 * WE DO NOT GUESS, AND WE DO NOT NEED TO — the sheet does its own arithmetic and we can check it:
 *
 *     |  |  | S1 |  |  |  |  |  |  | 122 |     <- the stop's stated subtotal
 *
 * and 48 + 22 + 28 + 24 = 122. The sum of the raw weights matches the stated subtotal exactly, while
 * the quantity-multiplied sum misses it by two orders of magnitude. That is proof, not a heuristic.
 *
 * WHEN IT IS PROVEN, the Qty column is descriptive, not a package count — and the item names say so
 * outright ("200 pcs", "24pc", "10u", "2u"). So each line is loaded as ONE package of the stated
 * size and weight. Multiplying the volume by a piece count is what turned a one-van job into 43 vans.
 *
 * WHEN IT IS NOT PROVEN — no subtotal on the sheet, or the sums match neither reading — this returns
 * null and the assembler keeps its existing per-unit behaviour and flags the table. An unproven
 * sheet is left exactly as it was; this module only ever speaks when it can show its working.
 *
 * Pure: no I/O, no config reads (the tolerance is passed in), no packing knowledge.
 */
import type { ExtractedTable, TableRow } from "@/lib/conversion/types";

export interface WeightSemanticsInput {
  /** Weight of each cargo row as printed, and that row's quantity (defaulting to 1). */
  readonly lines: ReadonlyArray<{ readonly weightKg: number; readonly quantity: number }>;
  /** Totals the sheet states for itself — subtotal / total rows inside the same table. */
  readonly statedTotalsKg: readonly number[];
  /** How close a sum must be to the stated total to count as matching it (0.02 = 2%). */
  readonly tolerance: number;
}

export interface WeightSemantics {
  /** True ⇒ the weight column is the line's TOTAL, so it must not be multiplied by the quantity. */
  readonly lineTotal: boolean;
  /** The arithmetic, in words, for the operator — we never assert without showing why. */
  readonly proof: string;
}

/**
 * Decide what the weight column means by checking both readings against the sheet's own stated
 * totals. Returns null when the sheet offers no total to check against, or when neither reading
 * matches it — in which case nothing has been proven and the caller must not change its behaviour.
 */
export function detectWeightSemantics(input: WeightSemanticsInput): WeightSemantics | null {
  const { lines, statedTotalsKg, tolerance } = input;
  if (lines.length === 0) return null;

  const stated = statedTotalsKg.reduce((n, v) => n + v, 0);
  if (stated <= 0) return null; // the sheet states no total — nothing to prove anything against

  const asLineTotal = lines.reduce((n, l) => n + l.weightKg, 0);
  const asPerUnit = lines.reduce((n, l) => n + l.weightKg * Math.max(1, l.quantity), 0);

  const matches = (sum: number): boolean => Math.abs(sum - stated) <= stated * tolerance;

  const lineTotalMatches = matches(asLineTotal);
  const perUnitMatches = matches(asPerUnit);

  // Both readings match ⇒ every quantity is 1, so the distinction is meaningless here. Say nothing
  // and leave the existing behaviour alone rather than assert a difference that does not exist.
  if (lineTotalMatches === perUnitMatches) return null;

  const round = (n: number) => Math.round(n).toLocaleString("en-GB");
  if (lineTotalMatches) {
    return {
      lineTotal: true,
      proof:
        `The weights on this sheet add up to ${round(asLineTotal)} kg, which is the total it states ` +
        `for itself (${round(stated)} kg). Multiplying them by the Qty column would give ` +
        `${round(asPerUnit)} kg instead — so the weight column is each line's TOTAL, and Qty is a ` +
        `description of what's inside, not a count of packages to load.`,
    };
  }
  return {
    lineTotal: false,
    proof:
      `Each weight × its Qty adds up to ${round(asPerUnit)} kg, matching the total the sheet states ` +
      `for itself (${round(stated)} kg) — so the weight column is per unit, as assumed.`,
  };
}

/**
 * Pull the totals a table states for itself: "Sub-total Stop 1", "GRAND TOTAL", or a bare section
 * marker like "S1". They are the only independent check on the sheet's arithmetic that the sheet
 * itself provides — and the reason we can settle the weight question by proof rather than by guess.
 *
 * `isTotalsRow` is injected (the assembler owns it, driven by `totalsRowPattern` in config) so this
 * module holds no opinion about how a source labels its totals. Deliberately NOT "any row with a
 * weight but no size": a genuine cargo line whose dimensions were left blank looks exactly like that,
 * and treating it as a total would both corrupt this check and silently delete the cargo.
 */
export function statedTotalsIn(
  table: ExtractedTable,
  weightColumn: number | undefined,
  parseWeight: (raw: string | undefined) => number | null,
  isTotalsRow: (row: TableRow) => boolean,
): number[] {
  if (weightColumn === undefined) return [];
  const totals: number[] = [];
  for (const row of table.rows) {
    if (!isTotalsRow(row)) continue;
    const w = parseWeight(row[weightColumn]);
    if (w !== null && w > 0) totals.push(w);
  }
  return totals;
}
