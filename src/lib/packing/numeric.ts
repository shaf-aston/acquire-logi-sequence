/**
 * NUMERIC CELL PARSING — the one place that turns a manifest's printed number into a real one.
 *
 * A leaf module on purpose. It was originally a function inside `item-assembler.ts`, and when
 * `stated-pallet-totals.ts` needed it too, importing it from there created a cycle (the assembler
 * already imports the totals reader) AND quietly inverted the layering: the totals reader's own
 * header promises "pure: no I/O, no config", yet through the assembler it would have transitively
 * pulled in the logger, the network durability classifier, and the config loaders. A parser that
 * turns "1,234.56" into a number should depend on nothing at all. Now it doesn't.
 */

/**
 * Parse a numeric cell under a DECLARED decimal convention. Returns null for blank/non-numeric input.
 *  - ","  Italian/European: dot = thousands, comma = decimal  ("1.234,56" → 1234.56)
 *  - "."  English/US:       comma = thousands, dot = decimal  ("1,234.56" → 1234.56)
 *
 * The convention must be DECLARED, never guessed: "1.200" is 1200 under "," and 1.2 under ".".
 * There is no way to tell them apart from the digits alone, so auto-detection would silently corrupt
 * one format or the other — and a weight read as 1.2 kg instead of 1,200 kg is a quote sent for a
 * thousandth of the real load.
 *
 * Note it uses `parseFloat`, so the number must START the cell: "16 kg/carton" reads as 16, but
 * "approx 16" reads as null. Callers that need to find a number ANYWHERE in a cell do their own
 * regex scan — see the groupage readers, which deliberately keep that different contract.
 */
export function parseNumeric(raw: string | undefined, decimalSeparator: "." | "," = ","): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const normalized =
    decimalSeparator === ","
      ? trimmed.replace(/\./g, "").replace(",", ".")
      : trimmed.replace(/,/g, "");
  const n = Number.parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}
