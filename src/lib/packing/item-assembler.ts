/**
 * Item-assembly bridge (Stage 2 → Stage 3). Stage 2's ClassifiedItem carries
 * fragility + the row's coordinates but no dimensions; this joins each classified
 * row back to its table cells, parses the dimension/quantity/material columns,
 * derives a transport category, resolves stacking rules, estimates weight, and
 * classifies each distinct Material value (once, batched) into durability/
 * brittle/deformable/orientation facts — producing the `Item[]` the packer
 * consumes.
 *
 * "Never guess" (CLAUDE.md): a row with any missing/unparseable dimension yields
 * an Item with `dimensions: null`; the packer reports it as unplaced with a
 * reason rather than fabricating a size.
 */
import { createLogger } from "@/lib/logger/logger";
import { parseNumeric } from "@/lib/packing/numeric";
import { categoryForCode, detectUnitFromCell, detectUnitFromHeader, resolveColumnIndices, toMetres, type ColumnIndices, type ColumnMap, type LengthUnit } from "@/lib/packing/column-map";
import { detectWeightSemantics, statedTotalsIn, type WeightSemantics } from "@/lib/packing/weight-semantics";
import { readStatedPalletTotals, type StatedPalletTotals } from "@/lib/packing/stated-pallet-totals";
import { resolveStackRules, type StackabilityMatrix } from "@/lib/packing/stackability";
import { stopIndexFromRow } from "@/lib/packing/stop-attributor";
import { estimateWeightKg } from "@/lib/packing/weight-estimator";
import { loadDurabilityTierPressures, minTier } from "@/lib/packing/durability-tier-pressure";
import { stricterOrientationLock } from "@/lib/packing/orientation";
import { getDurabilityClassifier } from "@/lib/classification/durability-classifier.factory";
import type { DurabilityOverride, DurabilityTier, OrientationLock } from "@/lib/classification/durability.types";
import type { Dimensions, FlaggedTable, Item, PackingCategory, SkippedTable, StackRules } from "@/lib/packing/packing.types";
import type { ClassificationResult, ClassifiedItem, Fragility } from "@/lib/classification/types";
import type { ExtractedTable, StructuredDocument, TableRow } from "@/lib/conversion/types";

const logger = createLogger("packing.assembler");

/**
 * Parse one dimension cell to metres. A per-cell unit suffix (e.g. "120cm") is an
 * explicit marker the source stated for THIS value, so it takes priority over the
 * column-level unit; a cell with no such suffix (e.g. plain "120") falls back to
 * `columnUnit` (detected from the header, or the config default) exactly as before.
 */
function parseDimensionM(raw: string | undefined, sep: "." | ",", columnUnit: LengthUnit): number | null {
  if (raw === undefined) return null;
  const cellUnit = detectUnitFromCell(raw);
  const n = parseNumeric(cellUnit ? cellUnit.numeric : raw, sep);
  if (n === null || n <= 0) return null;
  return toMetres(n, cellUnit ? cellUnit.unit : columnUnit);
}

/**
 * Parse a SINGLE cell that packs all three extents together, as many groupage
 * quotations print them: "120 x 100 x 110 (H)", "120 x 100 x 110", "120×100×110cm".
 * Splits on the x/× separators, parses each component with the same per-cell-unit
 * rules as one dimension column (so a trailing "cm"/"mm" on the last component, or a
 * "(H)" orientation flag, is tolerated), and returns the first three positive values
 * as l/w/h in stated order. Fewer than three parseable numbers ⇒ null (the row is
 * then flagged unplaced with a reason, never guessed). The packer rotates freely, so
 * the exact axis each extent maps to does not change the fit — only that all three
 * are captured.
 */
function parseCombinedDimensions(raw: string | undefined, sep: "." | ",", columnUnit: LengthUnit): Dimensions | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parseOn = (rx: RegExp): number[] =>
    raw
      .split(rx)
      .map((part) => parseDimensionM(part, sep, columnUnit))
      .filter((n): n is number => n !== null && n > 0);
  // Prefer explicit multiply separators (x / × / *). These keep a trailing "(H)"
  // orientation flag or a per-component unit attached to its number, so
  // "120 x 100 x 110 (H)" and "120×100×110cm" parse exactly as before. Only when
  // that yields fewer than three numbers do we ALSO split on whitespace, so a
  // space-separated sheet ("120 100 110") parses without regressing the common case.
  // "-" is deliberately NOT a separator — it collides with ranges/part-numbers.
  let nums = parseOn(/[x×*]/i);
  if (nums.length < 3) nums = parseOn(/[x×*]|\s+/i);
  if (nums.length < 3) return null;
  return { l: nums[0]!, w: nums[1]!, h: nums[2]! };
}

function cell(row: TableRow, index: number): string | undefined {
  return index >= 0 && index < row.length ? row[index] : undefined;
}

/**
 * Derive the missing depth axis from physics when the source table carries only
 * two dimensions plus a weight: a solid box of mass `m` and material density `ρ`
 * occupies volume `m/ρ`, so depth = volume ÷ (length × height face area). This
 * uses the row's real mass — not a fabricated number — and is clamped to stay a
 * plausible bounding box (never below `minDepthM`, never deeper than the largest
 * known axis) when ρ under/over-estimates. Returns null when mass is unavailable,
 * in which case the item is flagged unplaced rather than guessed.
 * All inputs and the return value are in metres.
 */
function deriveDepthM(
  weightKg: number | null,
  densityKgPerM3: number,
  lengthM: number,
  heightM: number,
  minDepthM: number,
): number | null {
  if (weightKg === null || weightKg <= 0 || densityKgPerM3 <= 0) return null;
  const faceAreaM2 = lengthM * heightM;
  if (faceAreaM2 <= 0) return null;
  const depthM = weightKg / densityKgPerM3 / faceAreaM2;
  return Math.min(Math.max(depthM, minDepthM), Math.max(lengthM, heightM));
}

/**
 * The result of trying to derive a per-pallet weight from the document's own stated total: either a
 * usable figure, or — just as important — WHY none was usable. A bare `null` here is what let a 400 kg
 * config default get used with zero explanation: the caller could not tell "this sheet states no total"
 * apart from "it stated one but the figure was implausible", so neither ever reached the operator.
 */
interface StatedTotalsLookup {
  readonly usable: StatedPalletTotals | null;
  /** Set whenever `usable` is null — the reason the config default had to be used instead. */
  readonly reason: string | null;
}

/**
 * Memo keyed on BOTH the document and the column map, because the answer depends on both: the map
 * supplies the decimal convention the total is read under and the plausibility band it is judged
 * against. Keying on the document alone (as this once did) would hand a second column map the first
 * one's answer — a stale-cache misread of the kind this file exists to prevent. Nested WeakMaps, so
 * neither the document nor the map is kept alive by the cache.
 */
const statedTotalsCache = new WeakMap<StructuredDocument, WeakMap<ColumnMap, StatedTotalsLookup>>();

/**
 * The pallet weight the DOCUMENT states for itself ("Total: 266 pallets | 35,910 kg"), used when a
 * pallet line carries no weight of its own — in preference to the config default, which is a constant
 * and therefore a guess.
 *
 * Guarded for plausibility (`columnMap.palletDefaults.plausibleMinKg`/`plausibleMaxKg`). A derived
 * figure only replaces the default if it could actually be a loaded pallet; a misread total (an OCR'd
 * "35,910" arriving as "3,591,000") must not fabricate a 13-tonne pallet no van can lift. Outside the
 * band we keep the honest default — and say so.
 *
 * NOT the same rule as groupage-rates.json's `maxPlausibleDerivedPalletKg` (collection-run-parser.ts):
 * that guards a per-pallet weight derived from a groupage CARGO SUMMARY (total ÷ pallet count), and on
 * an out-of-band figure it KEEPS the derived value and merely flags it doubtful — it never discards to
 * a default. This band, by contrast, judges a document's own PROSE total, and outside it we discard the
 * figure entirely (there is no per-row surface on which to show a "doubtful" flag beside a number that
 * was never used). Two different derivations, two different failure modes — read the note beside
 * `palletDefaults` in config/column-map.json before ever merging them.
 */
function statedTotalsFor(doc: StructuredDocument, columnMap: ColumnMap): StatedTotalsLookup {
  let perMap = statedTotalsCache.get(doc);
  if (perMap === undefined) {
    perMap = new WeakMap<ColumnMap, StatedTotalsLookup>();
    statedTotalsCache.set(doc, perMap);
  }
  const hit = perMap.get(columnMap);
  if (hit !== undefined) return hit;
  const { plausibleMinKg, plausibleMaxKg } = columnMap.palletDefaults;
  const read = readStatedPalletTotals(doc, columnMap.decimalSeparator);
  let result: StatedTotalsLookup;
  if (read === null) {
    result = { usable: null, reason: "this sheet states no total of its own to derive a weight from" };
  } else if (read.perPalletKg < plausibleMinKg || read.perPalletKg > plausibleMaxKg) {
    result = {
      usable: null,
      reason:
        `its stated total works out to ${Math.round(read.perPalletKg)} kg a pallet, which is outside the ` +
        `plausible ${plausibleMinKg}-${plausibleMaxKg} kg range for a loaded pallet — likely a misread figure`,
    };
  } else {
    result = { usable: read, reason: null };
  }
  perMap.set(columnMap, result);
  return result;
}

/**
 * Total pallets actually READ off the document's cargo tables — the figure to hold against the total
 * the sheet declares for itself, so a scan that quietly dropped cargo lines cannot pass as a clean read.
 */
function palletsReadIn(doc: StructuredDocument, columnMap: ColumnMap): number {
  let total = 0;
  for (const page of doc.pages) {
    for (const table of page.tables) {
      // This scans EVERY table on the document directly (not via classification.items), so a
      // headerless table reaches it even though Stage 2 already refuses to classify one — resolving
      // its Pallets column by fixed position here would silently re-introduce the exact guess
      // `headerless` exists to forbid.
      if (table.headerless) continue;
      const cols = resolveColumnIndices(table.headers, columnMap);
      if (cols.pallets === undefined || !isCargoTable(table.headers, columnMap, table.headerless)) continue;
      for (const row of table.rows) {
        if (isTotalsRow(row, cols, columnMap)) continue; // a subtotal restates cargo, it isn't cargo
        const n = parseNumeric(cell(row, cols.pallets), columnMap.decimalSeparator);
        if (n !== null && n >= 1) total += Math.round(n);
      }
    }
  }
  return total;
}

/**
 * A row that STATES A TOTAL rather than carrying cargo — "Sub-total Stop 1", "GRAND TOTAL", "S1".
 * Matched on its description/code text against `totalsRowPattern` (config), never on shape: a real
 * cargo line whose size cells were left blank has the same shape, and dropping THAT would silently
 * delete a customer's goods.
 *
 * Two things ride on this. Such a row has a weight but no size, so if it survives as an item it is
 * quoted as a phantom unplaceable line AND its weight is added on top of the cargo it was merely
 * summarising — on route-plan/detailed.pdf that alone doubled the job, 2,565 kg → 5,130 kg. It is
 * also the sheet's own arithmetic, which is what proves whether the weight column is a per-unit
 * weight or a line total (see weight-semantics.ts).
 */
function isTotalsRow(row: TableRow, cols: ColumnIndices, columnMap: ColumnMap): boolean {
  // Two guards, and both are needed.
  //
  // The label can sit in ANY column — on route-plan/detailed.pdf the marker "S1" is printed in the
  // line-number column, not the description — so every cell is checked, not just the ones we have
  // named. That alone would be too eager: a real item called "Total Station Kit" would match. So the
  // row must ALSO carry no cargo of its own. A totals line states a weight and nothing else; a real
  // item has a size or a pallet count. Only when both hold do we call it a total and drop it.
  if (rowCarriesCargo(row, cols, columnMap)) return false;
  return row.some((c) => c.trim() !== "" && columnMap.totalsRowPattern.test(c.trim()));
}

/**
 * Does this row carry cargo? A usable dimension or a pallet count — the same rule the row builder
 * applies below. Shared with the weight-semantics reader so the two can't drift apart in deciding
 * what is cargo and what is a subtotal line.
 */
function rowCarriesCargo(row: TableRow, cols: ColumnIndices, columnMap: ColumnMap): boolean {
  const sep = columnMap.decimalSeparator;
  const pallets = cols.pallets !== undefined ? parseNumeric(cell(row, cols.pallets), sep) : null;
  if (pallets !== null && pallets >= 1) return true;
  for (const i of dimensionColumns(cols)) {
    if (i < 0) continue;
    const v = parseNumeric(cell(row, i), sep);
    if (v !== null && v > 0) return true;
  }
  return false;
}

/**
 * Pallet-line rows where the Weight column EXISTS on this table but THIS row's cell is
 * blank/unreadable — the per-row hole that a whole-column check (`cols.weight ===
 * undefined`) cannot see. `parseRow`'s pallet branch falls back to exactly the same
 * default (the sheet's own stated total, else `pd.defaultWeightKg`) for exactly these
 * rows — see its `explicitWeightKg !== null && explicitWeightKg > 0` gate, mirrored here
 * with the same `parseNumeric` read so this can never drift from what actually gets
 * priced. Left unflagged, this one row would be silently guessed while every other row on
 * the same sheet is read for real. Returns each row's description/code (or a positional
 * fallback) so the operator can find them.
 */
function palletRowsMissingWeight(table: ExtractedTable, cols: ColumnIndices, columnMap: ColumnMap): string[] {
  if (cols.pallets === undefined || cols.weight === undefined) return [];
  const sep = columnMap.decimalSeparator;
  const names: string[] = [];
  table.rows.forEach((row, i) => {
    if (isTotalsRow(row, cols, columnMap)) return; // a subtotal restates cargo, it isn't a pallet line
    const pallets = parseNumeric(cell(row, cols.pallets!), sep);
    if (pallets === null || pallets < 1) return; // not a pallet line
    const w = parseNumeric(cell(row, cols.weight!), sep);
    if (w === null || w <= 0) {
      const label = ((cell(row, cols.description) ?? "").trim() || (cell(row, cols.code) ?? "").trim());
      names.push(label || `row ${i + 1}`);
    }
  });
  return names;
}

/**
 * What does this table's weight column MEAN — a per-unit weight, or the line's total? Settled by
 * checking both readings against the totals the sheet states for itself (see weight-semantics.ts).
 * Memoised per table: it is asked once per row, but the answer is a property of the whole table.
 *
 * Reading a line total as a per-unit weight turned a 2,565 kg job into a 760,535 kg one. Nothing is
 * assumed here — when the sheet states no total to check against, this returns null and the caller
 * keeps its existing behaviour.
 */
const weightSemanticsCache = new WeakMap<ExtractedTable, WeightSemantics | null>();

function weightSemanticsFor(
  table: ExtractedTable,
  cols: ColumnIndices,
  columnMap: ColumnMap,
): WeightSemantics | null {
  const hit = weightSemanticsCache.get(table);
  if (hit !== undefined) return hit;

  const sep = columnMap.decimalSeparator;
  const parseWeight = (raw: string | undefined) => parseNumeric(raw, sep);
  // isTotalsRow already requires the row to carry no cargo, so these two are mutually exclusive.
  const isCargo = (row: TableRow) => rowCarriesCargo(row, cols, columnMap);

  let result: WeightSemantics | null = null;
  if (cols.weight !== undefined) {
    const lines = table.rows
      .filter(isCargo)
      .map((row) => {
        const w = parseWeight(cell(row, cols.weight!));
        const q = cols.quantity !== undefined ? parseNumeric(cell(row, cols.quantity), sep) : null;
        return { weightKg: w ?? 0, quantity: q !== null && q >= 1 ? Math.floor(q) : 1 };
      })
      .filter((l) => l.weightKg > 0);

    result = detectWeightSemantics({
      lines,
      statedTotalsKg: statedTotalsIn(table, cols.weight, parseWeight, (row) =>
        isTotalsRow(row, cols, columnMap),
      ),
      tolerance: columnMap.weightTotalTolerance,
    });
  }

  weightSemanticsCache.set(table, result);
  return result;
}

/** Which columns on this table carry a length. Shared by unit detection and unit inference. */
function dimensionColumns(cols: ColumnMap["columns"]): number[] {
  const dimCols: number[] = [cols.dimensionL, cols.dimensionH];
  if (cols.dimensionP !== undefined) dimCols.push(cols.dimensionP);
  // The combined "L x W x D (cm)" column carries its own unit marker; check it too.
  if (cols.dimensionCombined !== undefined) dimCols.unshift(cols.dimensionCombined);
  return dimCols;
}

/**
 * PROVE the unit of an unmarked size column from the numbers in it.
 *
 * A sheet that prints a bare "H | W | D" has not said whether 30 means 30 metres or 30 centimetres,
 * and assuming the config default is a guess that has produced a silent 100× error (a 30×120×100 cm
 * box read as 30×120×100 METRES — unpackable, and its weight multiplied out to nonsense).
 *
 * We don't have to guess, because freight has physical limits. A road-legal item is between a few
 * centimetres and a few metres, so of "metres / centimetres / millimetres" usually only ONE reading
 * puts a whole table inside that range. Score each candidate by how much of the table it makes
 * plausible; the first to clear `minConfidence` wins. Ties go to the earlier candidate, and `m` is
 * listed first, so a well-formed metre sheet is never re-interpreted.
 *
 * Returns null when nothing is proven (too few numbers, or no candidate is convincing) — in which
 * case the caller keeps the configured fallback AND keeps the table flagged for review. Proving
 * nothing is an acceptable outcome; pretending to know is not.
 */
function inferUnitFromMagnitudes(
  table: ExtractedTable,
  cols: ColumnMap["columns"],
  columnMap: ColumnMap,
): LengthUnit | null {
  const cfg = columnMap.unitInference;
  const dimCols = dimensionColumns(cols).filter((i) => i >= 0);
  if (dimCols.length === 0) return null;

  const values: number[] = [];
  for (const row of table.rows) {
    for (const i of dimCols) {
      // A cell that states its OWN unit ("120cm") is evidence, not a puzzle — skip it here; the
      // parser already honours it per-cell and it tells us nothing about the unmarked columns.
      const raw = cell(row, i);
      if (raw === undefined || detectUnitFromCell(raw) !== null) continue;
      const n = parseNumeric(raw, columnMap.decimalSeparator);
      if (n !== null && n > 0) values.push(n);
    }
  }
  if (values.length < cfg.minSamples) return null;

  for (const unit of cfg.candidates) {
    const plausible = values.filter((v) => {
      const m = toMetres(v, unit);
      return m >= cfg.plausibleMinM && m <= cfg.plausibleMaxM;
    }).length;
    if (plausible / values.length >= cfg.minConfidence) return unit;
  }
  return null;
}

/**
 * Settle the length unit for one table's size columns, in order of how much we actually know:
 *   1. the header states it ("Height (cm)")     → `detected`, trusted outright;
 *   2. no header unit, but the magnitudes prove it → `inferred` (see above), used and still flagged;
 *   3. neither                                   → the configured fallback, flagged for review.
 *
 * `detected: false` (cases 2 and 3) always flags the table — the operator is told the sheet never
 * stated its unit, even when we worked it out, because it is their cargo and their liability.
 */
function resolveUnit(
  table: ExtractedTable,
  cols: ColumnMap["columns"],
  columnMap: ColumnMap,
): { unit: LengthUnit; detected: boolean; inferred: LengthUnit | null } {
  for (const i of dimensionColumns(cols)) {
    const h = i >= 0 && i < table.headers.length ? (table.headers[i] ?? "") : "";
    const detected = detectUnitFromHeader(h);
    if (detected !== null) return { unit: detected, detected: true, inferred: null };
  }
  const inferred = inferUnitFromMagnitudes(table, cols, columnMap);
  return { unit: inferred ?? columnMap.inputUnit, detected: false, inferred };
}

/** Locate the table a ClassifiedItem points at, or null if coordinates are stale. */
function tableFor(doc: StructuredDocument, ci: ClassifiedItem) {
  const page = doc.pages.find((p) => p.index === ci.pageIndex);
  return page?.tables.find((t) => t.index === ci.tableIndex) ?? null;
}

/**
 * Header text that identifies a dimension column. Matches dimension words
 * (height/width/depth/length), Italian equivalents (prof/alt/lungh), an explicit
 * unit marker (cm/mm/`(m)`), or a leading single dimension letter — `L`/`W`/`H`/`D`/`P`
 * either bare or followed by a unit, e.g. `"H (m)"`.
 */
const DIMENSION_HEADER = /(height|width|depth|length|dimension|\bcm\b|\bmm\b|\(m\)|prof|alt|lungh|^\s*[lwhdp]\b)/i;

/**
 * A table is a packable cargo manifest only if its configured dimension columns
 * carry dimension headers. This rejects summary/classification tables (e.g. a
 * second table that repeats the items with only Category/Classification columns)
 * which would otherwise yield a flood of dimensionless "unplaced" phantoms.
 *
 * Checks the SAME `headerPatterns.dimensionL`/`dimensionH` regex column-map.ts
 * used to locate the column in the first place — never a second, hand-maintained
 * copy of the pattern. Two independent "what looks like a dimension header"
 * regexes can drift apart (one gets tuned for a new sheet format, the other
 * doesn't), which silently drops an entire real cargo table with zero rows
 * reaching the packer and zero unplaced/reason shown — the fail-loud contract
 * broken invisibly. `DIMENSION_HEADER` only backstops column maps that don't
 * declare a headerPatterns entry for that field.
 */
function isDimensionedTable(headers: string[], cols: ColumnMap["columns"], headerPatterns: ColumnMap["headerPatterns"]): boolean {
  // A combined "L x W x D" column carries all three extents in one cell — its
  // presence alone makes the table dimensioned (it is only ever set when the
  // combined header pattern matched, so no separate H/W column is expected).
  if (cols.dimensionCombined !== undefined) return true;
  const at = (i: number) => (i >= 0 && i < headers.length ? headers[i] ?? "" : "");
  const looksDimensioned = (field: "dimensionL" | "dimensionH", index: number): boolean => {
    const configured = headerPatterns[field];
    return configured ? configured.test(at(index)) : DIMENSION_HEADER.test(at(index));
  };
  return looksDimensioned("dimensionL", cols.dimensionL) && looksDimensioned("dimensionH", cols.dimensionH);
}

/**
 * THE single definition of "the packer can build load units from this table": it
 * carries dimension columns (Height/Width) OR a pallet-count column. Both the
 * per-row drop gate in parseRow and the skipped-table detector below derive from
 * this (via isDimensionedTable + the pallet-column check), so they can never judge
 * "cargo" differently — the divergence that once let a real table vanish into a
 * silent "0/0 placed".
 */
function isCargoTable(headers: string[], columnMap: ColumnMap, headerless?: boolean): boolean {
  // A headerless table proves no column's meaning — `resolveColumnIndices` would fall back to fixed
  // positions, the exact guess `headerless` exists to forbid. Never cargo, whatever the header text.
  if (headerless) return false;
  const cols = resolveColumnIndices(headers, columnMap);
  return isDimensionedTable(headers, cols, columnMap.headerPatterns) || cols.pallets !== undefined;
}

/**
 * Tables that Stage 2 classified as items but the packer must skip WHOLE — no
 * dimension columns AND no pallet column, so `assembleItems`' per-row gate drops
 * every one of their rows. Returned so the load plan can SHOW them (see SkippedTable)
 * instead of a real table collapsing into a silent "0/0 placed" with nothing in the
 * unplaced list to explain it.
 *
 * Shares the one `isCargoTable` predicate with that gate, so "reported here" ⟺
 * "produced no Item in assembleItems". Header inspection only, computed once per
 * distinct table (cached) — never parses a row, never touches the network.
 */
export function skippedCargoTables(
  doc: StructuredDocument,
  classification: ClassificationResult,
  columnMap: ColumnMap,
): SkippedTable[] {
  // Per-table verdict cache: undefined = not yet seen, null = coordinates stale
  // (parseRow logs that per row), else the cargo verdict + headers for the message.
  const verdicts = new Map<string, { isCargo: boolean; headers: string[] } | null>();
  const acc = new Map<string, { pageIndex: number; tableIndex: number; headers: string[]; rowCount: number }>();

  for (const ci of classification.items) {
    const key = `${ci.pageIndex}-${ci.tableIndex}`;
    let v = verdicts.get(key);
    if (v === undefined) {
      const table = tableFor(doc, ci);
      v = table === null ? null : { isCargo: isCargoTable(table.headers, columnMap, table.headerless), headers: table.headers };
      verdicts.set(key, v);
    }
    if (v === null || v.isCargo) continue;
    const found = acc.get(key);
    if (found) found.rowCount += 1;
    else acc.set(key, { pageIndex: ci.pageIndex, tableIndex: ci.tableIndex, headers: v.headers, rowCount: 1 });
  }

  const tables: SkippedTable[] = [...acc.values()].map((t) => ({
    ...t,
    reason:
      "No size columns (Height/Width) or a Pallet column were found in this table, " +
      "so its rows could not be added to the load plan.",
  }));

  // Headerless tables (the scan lost the header/separator framing — see markdown-table.parser.ts)
  // never reach the loop above at all: `isItemTable` refuses them at Stage 2, so they produce no
  // `classification.items` and would otherwise vanish with NOTHING recording that they ever
  // existed — worse than the "no dimension columns" case above, which at least gets classified
  // first. Found by scanning the document directly rather than via classification, since that is
  // the one place their rows still exist.
  //
  // `headerless` is set for TWO different reasons, and only one of them is a lost table:
  //   (a) markdown-table.parser.ts sets it when the '|---|' separator was lost, so no header row
  //       could be identified at all — `headers` is EMPTY. The scan genuinely lost it.
  //   (b) table-normaliser.ts sets it when no CARGO header could be proven. But it scores a header
  //       against the PACKER's vocabulary, so a stop table ("Type | Address | Company") or a
  //       classification-key table has real, meaningful headers that simply are not cargo words.
  //       Nothing was lost — it was never a cargo table, and other readers consume it happily.
  // Reporting (b) as "the header row was lost in the scan" is false, and it cries wolf on manifests
  // that were read perfectly — which is how a real warning gets ignored. So report only (a): a table
  // with NO header text whatsoever. That is the case where cargo could silently vanish.
  //
  // The size floor on top of that is config (see LostTableFloor) and screens out pipe-prefixed prose
  // and letterheads ("| Total: 266 pallets | 35,910 kg |"), which the parser also hands over as
  // headerless blocks. It is a blunt filter and deliberately errs towards reporting.
  const floor = columnMap.lostTableFloor;
  for (const page of doc.pages) {
    for (const table of page.tables) {
      if (!table.headerless || table.rows.length === 0) continue;
      if (table.headers.some((h) => h.trim() !== "")) continue; // case (b) — not lost, just not cargo
      const columnCount = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
      if (table.rows.length < floor.minRows || columnCount < floor.minColumns) continue;
      tables.push({
        pageIndex: page.index,
        tableIndex: table.index,
        headers: table.headers,
        rowCount: table.rows.length,
        reason:
          "This table's header row was lost in the scan, so its columns can't be identified — " +
          "the rows were not added to the load plan.",
      });
    }
  }

  for (const t of tables) {
    logger.warn("cargo table skipped", {
      page: t.pageIndex,
      table: t.tableIndex,
      headers: t.headers,
      rowsSkipped: t.rowCount,
      reason: t.reason,
    });
  }
  return tables;
}

/**
 * Cargo tables the packer read but had to GUESS a header fact for — surfaced so the
 * operator can verify (never silently trusted). Two guess types, per cargo table:
 *   • unit assumed — no cm/mm/m marker in the size headers, so config `inputUnit`
 *     was used (an unmarked mm sheet read as metres is a 100–1000× error);
 *   • column by position — a required size column's header pattern matched nothing,
 *     so a fixed column index was used (it may point at the wrong column).
 * Shares `isCargoTable`/`resolveColumnIndices`/`resolveUnit` with the assembler, and
 * only inspects headers (one verdict per distinct table) — never parses a row.
 * Clean, well-marked sheets (e.g. "(cm)" headers) produce zero flags: no false alarms.
 */
export function flaggedCargoTables(
  doc: StructuredDocument,
  classification: ClassificationResult,
  columnMap: ColumnMap,
): FlaggedTable[] {
  const seen = new Set<string>();
  const out: FlaggedTable[] = [];

  for (const ci of classification.items) {
    const key = `${ci.pageIndex}-${ci.tableIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const table = tableFor(doc, ci);
    if (table === null) continue;
    // Non-cargo tables are handled by skippedCargoTables — don't double-report.
    if (!isCargoTable(table.headers, columnMap, table.headerless)) continue;

    const cols = resolveColumnIndices(table.headers, columnMap);
    const reasons: string[] = [];

    // The sheet never stated its unit. Say so EITHER WAY — even when the magnitudes proved which unit
    // it must be, the operator is told, because it is their cargo. What changes is whether we are
    // reporting a worked-out answer or an outright assumption.
    const u = resolveUnit(table, cols, columnMap);
    if (!u.detected) {
      reasons.push(
        u.inferred !== null
          ? `No size unit (cm/mm/m) was stated in the size-column headers. The sizes only make physical sense as "${u.inferred}", so they were read that way — check that's right.`
          : `No size unit (cm/mm/m) was stated in the size-column headers, so "${columnMap.inputUnit}" was assumed — check the sizes aren't 100× out.`,
      );
    }

    // The sheet's weight column turned out to be each line's TOTAL, not a per-unit weight, so the
    // Qty column was read as a description rather than a package count. That is a big call — it
    // changes both the weight and the van count — so the arithmetic that proves it is shown, never
    // just asserted.
    const ws = weightSemanticsFor(table, cols, columnMap);
    if (ws?.lineTotal === true) reasons.push(ws.proof);

    // A pallet table with no weight column at all: the per-pallet weight either came from the total the
    // sheet declares in its own prose, or — when the sheet gives us nothing to derive from — from the
    // config's standard loaded-pallet average. Both are told to the operator, plainly, because a silent
    // 400 kg-per-pallet assumption is exactly the 3× mis-quote this whole module exists to prevent.
    const st = statedTotalsFor(doc, columnMap);
    // `cols.pallets` is only ever set here when it is a REAL pallet-count column: when a
    // "Pallet Size (cm)" header would otherwise have matched both `pallets` and
    // `dimensionCombined`, resolveColumnIndices (column-map.ts) already resolves `pallets` to
    // undefined for that sheet — so no false alarm is possible here, and no parallel guard
    // is needed against it.
    if (cols.weight === undefined && cols.pallets !== undefined) {
      if (st.usable !== null) {
        reasons.push(
          `This sheet gives no weight per line, so each pallet was weighed from the total it states ` +
            `for itself — ${Math.round(st.usable.weightKg).toLocaleString("en-GB")} kg over ${st.usable.pallets} pallets, ` +
            `about ${Math.round(st.usable.perPalletKg)} kg a pallet. Check that total is right.`,
        );
      } else {
        reasons.push(
          `This sheet gives no weight per line, and ${st.reason}, so every pallet on this sheet was ` +
            `assumed to weigh ${columnMap.palletDefaults.defaultWeightKg} kg — a standard loaded-pallet ` +
            `average, not a figure read from this document. Check the real weight before quoting.`,
        );
      }
    }

    // A pallet line whose Weight CELL is blank/unreadable, even though the table HAS a
    // weight column overall — the per-row hole the header-only check above cannot see
    // (see palletRowsMissingWeight). parseRow falls back to the identical default
    // (stated total, else config default) for exactly these rows; a blank cardboard
    // "48" cell must never be quoted with the same silent confidence as a real "48".
    const blankWeightRows = palletRowsMissingWeight(table, cols, columnMap);
    if (blankWeightRows.length > 0) {
      const named = blankWeightRows.slice(0, 5).join(", ") + (blankWeightRows.length > 5 ? ", …" : "");
      if (st.usable !== null) {
        reasons.push(
          `${blankWeightRows.length} pallet line(s) gave no weight of their own (${named}), so ` +
            `${blankWeightRows.length === 1 ? "it was" : "they were"} weighed from the total the sheet states ` +
            `for itself — about ${Math.round(st.usable.perPalletKg)} kg a pallet. Check that's right.`,
        );
      } else {
        reasons.push(
          `${blankWeightRows.length} pallet line(s) gave no weight of their own (${named}), and ${st.reason}, so ` +
            `${blankWeightRows.length === 1 ? "it was" : "they were"} assumed to weigh ${columnMap.palletDefaults.defaultWeightKg} kg — ` +
            `a standard loaded-pallet average, not a figure read from this document. Check the real weight before quoting.`,
        );
      }
    }

    // DID WE READ THE WHOLE SHEET? The manifest declares how much it contains ("266 PALLETS"), so we
    // can check our own reading against it — and on single-drop/simplified.pdf the scan silently
    // dropped 7 of 20 cargo lines, leaving 161 pallets of a stated 266. Nothing anywhere would have
    // said so: the load plan looked clean, and the customer would have been quoted 40% light for a
    // full truck. Under-reading a manifest is the most expensive failure in this pipeline precisely
    // because it looks like success, so it is called out loudly rather than inferred from a total.
    const shortfall = st.usable !== null ? st.usable.pallets - palletsReadIn(doc, columnMap) : 0;
    if (st.usable !== null && shortfall > 0 && shortfall / st.usable.pallets > columnMap.weightTotalTolerance) {
      reasons.push(
        `⚠ This sheet says it carries ${st.usable.pallets} pallets, but only ${st.usable.pallets - shortfall} were ` +
          `read from it — ${shortfall} are missing. Some cargo lines did not come through the scan. ` +
          `Do not quote this until the missing lines are added by hand.`,
      );
    }

    // A required size column that matched no header (so it fell back to a fixed
    // position) may point at the wrong column. Only meaningful when there is no
    // combined "L x W x D" cell (which supplies the extents directly).
    const hp = columnMap.headerPatterns;
    const fellBackToFixed = (field: "dimensionL" | "dimensionH"): boolean =>
      hp[field] !== undefined && !table.headers.some((h) => hp[field]!.test(h));
    if (cols.dimensionCombined === undefined && (fellBackToFixed("dimensionL") || fellBackToFixed("dimensionH"))) {
      reasons.push(
        "A size column couldn't be identified by its header, so a fixed column position was used — check the sizes came from the right column.",
      );
    }

    if (reasons.length > 0) {
      out.push({ pageIndex: ci.pageIndex, tableIndex: ci.tableIndex, headers: table.headers, reason: reasons.join(" ") });
    }
  }

  for (const t of out) {
    logger.warn("cargo table read with low column/unit confidence", {
      page: t.pageIndex,
      table: t.tableIndex,
      headers: t.headers,
      reason: t.reason,
    });
  }
  return out;
}

export interface AssembleInput {
  readonly doc: StructuredDocument;
  readonly classification: ClassificationResult;
  readonly columnMap: ColumnMap;
  readonly matrix: StackabilityMatrix;
  /**
   * Per-row human corrections of the durability facts, keyed by row id
   * (`${pageIndex}-${tableIndex}-${rowIndex}`). When present for a row, the
   * override replaces that row's auto classification and is fed through the same
   * conservative blend (tighten-only) as an automatic result. Absent → today's
   * behaviour (classifier drives every row).
   */
  readonly durabilityOverrides?: ReadonlyMap<string, DurabilityOverride>;
}

/** Everything about a row except the durability classification, which is batched separately. */
interface ParsedRow {
  readonly id: string;
  readonly name: string;
  readonly dimensions: Dimensions | null;
  readonly weightKg: number;
  readonly quantity: number;
  readonly fragility: Fragility;
  readonly category: PackingCategory;
  readonly rules: StackRules;
  readonly material: string | null;
  /** 0-based delivery stop from the manifest's Stop column; undefined on single-drop sheets. */
  readonly stopIndex?: number;
}

function parseRow(
  doc: StructuredDocument,
  ci: ClassifiedItem,
  columnMap: ColumnMap,
  matrix: StackabilityMatrix,
): ParsedRow | null {
  const table = tableFor(doc, ci);
  const row = table?.rows[ci.rowIndex] ?? null;
  if (table === null || row === null || row === undefined) {
    logger.warn("classified row not found in document", {
      page: ci.pageIndex,
      table: ci.tableIndex,
      row: ci.rowIndex,
    });
    return null;
  }

  // Defense-in-depth: Stage 2's isItemTable already refuses to classify a headerless table (see
  // table-selector.ts), so classification.items should never point here — but this is the one place
  // that resolves columns by header text, so it must refuse too rather than trust the caller.
  if (table.headerless) {
    logger.warn("classified row points at a headerless table — refusing to resolve columns by position", {
      page: ci.pageIndex,
      table: ci.tableIndex,
      row: ci.rowIndex,
    });
    return null;
  }

  // Locate columns by header text per table (falls back to fixed indices), so
  // one config maps differing layouts — a 6-col cm sheet and an 11-col m sheet.
  const cols = resolveColumnIndices(table.headers, columnMap);

  // Multi-drop groupage: the row's Stop column names its delivery stop (0-based),
  // carried onto the Item so the packer can load earlier stops toward the doors.
  const stopIndex = stopIndexFromRow(row, cols);

  const sep = columnMap.decimalSeparator;
  const num = (raw: string | undefined) => parseNumeric(raw, sep);

  const dimensioned = isDimensionedTable(table.headers, cols, columnMap.headerPatterns);
  // A populated Pallets column marks a PALLET line: the load unit is the pallet,
  // not the descriptive piece/unit count that also appears on a groupage manifest.
  const palletsRaw = cols.pallets !== undefined ? num(cell(row, cols.pallets)) : null;
  const isPalletLine = palletsRaw !== null && palletsRaw >= 1;

  // Skip genuinely non-cargo rows — no usable dimensions AND no pallet count (e.g. a
  // subtotal row inside a pallet manifest, or a classification-only table repeating
  // the items with no size columns). A WHOLE non-cargo table (no dimension AND no
  // pallet columns) is detected and surfaced by skippedCargoTables() — which shares
  // isCargoTable with this gate — so the load plan shows it as a warning instead of it
  // vanishing into a silent "0/0 placed" with nothing in unplaced to explain it.
  if (!dimensioned && !isPalletLine) return null;

  const { unit } = resolveUnit(table, cols, columnMap);
  // A single "L x W x D (cm)" / "Pallet Size (cm)" cell, when present, supplies all
  // three extents at once and takes priority over the separate H/W/D columns.
  const combined =
    cols.dimensionCombined !== undefined
      ? parseCombinedDimensions(cell(row, cols.dimensionCombined), sep, unit)
      : null;
  const code = (cell(row, cols.code) ?? "").trim();
  const name = (cell(row, cols.description) ?? ci.label).trim();
  const material = cols.material !== undefined ? (cell(row, cols.material) ?? "").trim() || null : null;

  const category = categoryForCode(columnMap, code);
  const rules = resolveStackRules(matrix, category);

  const explicitWeightKg =
    cols.weight !== undefined ? num(cell(row, cols.weight)) : null;

  // ── Pallet-level quoting ──────────────────────────────────────────────────
  // A groupage manifest states "N pallets" per line PLUS a descriptive piece
  // count ("2,800 pcs"). The load unit is the pallet: quote `N` placeable pallets,
  // never explode the piece count into N thousand loose objects (which both
  // mis-prices the load and blows the packer's block cap). Where the sheet gives a
  // per-pallet Height/Width, use them as the pallet's load height + one footprint
  // axis; fill the missing footprint depth (and any absent height) from the
  // standard pallet in config/column-map.json.
  if (isPalletLine) {
    const pd = columnMap.palletDefaults;
    const pallets = Math.max(1, Math.round(palletsRaw!));

    // Only trust the dimension cells when the table actually HAS dimension
    // headers — otherwise the fixed-index fallback points dimensionH/L at
    // unrelated columns (e.g. the Pallets column itself), fabricating a bogus
    // pallet size. No dimension headers ⇒ full standard pallet from config.
    // A combined "Pallet Size (cm)" cell (e.g. "120 x 100 x 110 (H)") states the
    // full pallet footprint + load height in one cell — use all three extents when
    // present; otherwise the separate H/W columns, then the config standard pallet.
    const hParsed = combined?.h ?? (dimensioned ? parseDimensionM(cell(row, cols.dimensionH), sep, unit) : null);
    const lParsed = combined?.l ?? (dimensioned ? parseDimensionM(cell(row, cols.dimensionL), sep, unit) : null);
    const h = hParsed ?? pd.loadHeightM;
    const l = lParsed ?? pd.footprintM.l;
    const dimensions: Dimensions = { l, w: combined?.w ?? pd.footprintM.w, h };

    // On a groupage manifest the Weight column is the LINE total (its line weights
    // sum to the manifest grand total), so per-pallet weight = line ÷ pallets.
    // Absent ⇒ config's standard loaded-pallet weight. We deliberately do NOT
    // fall back to volume × solid-material density here: a 1.2×1.0×1.2 m pallet of
    // e.g. steel density fabricates a ~7-tonne pallet heavier than any van, which
    // then fails fleet allocation. A sane average pallet weight is the honest
    // default when the sheet states no weight.
    //
    // But before reaching for that default, ask whether the sheet states a weight ANYWHERE. A
    // "simplified" manifest gives pallet counts and no per-line weights, yet declares its own figures
    // in prose above the tables — "Total: 266 pallets | 35,910 kg". 35,910 ÷ 266 = 135 kg a pallet,
    // from the document's own numbers. Falling straight through to the 400 kg default instead quoted
    // that job at 106,400 kg: a 3× error, priced and sent. A constant is the LAST resort, not the
    // first — see stated-pallet-totals.ts.
    const stated = statedTotalsFor(doc, columnMap);
    const weightKg =
      explicitWeightKg !== null && explicitWeightKg > 0
        ? explicitWeightKg / pallets
        : (stated.usable?.perPalletKg ?? pd.defaultWeightKg);

    // A pallet's stacking behaviour is a PACKAGING fact (a flat, structurally
    // stackable transport unit), independent of what its description's matched
    // category says about its CONTENTS. A description that trips a
    // fragile-contents category (e.g. "Pallet of Wine Glasses" -> glass-panel)
    // would otherwise hard-veto stacking on the whole pallet, when only the
    // glassware inside is fragile — use the dedicated pallet ruleset instead
    // whenever the resolved category would zero out stacking.
    const effectiveRules = rules.canSupportWeightKg === 0 ? matrix.pallet : rules;

    return {
      id: `${ci.pageIndex}-${ci.tableIndex}-${ci.rowIndex}`,
      name: name || code || "item",
      dimensions,
      weightKg,
      quantity: pallets,
      fragility: ci.fragility,
      category,
      rules: effectiveRules,
      material,
      stopIndex,
    };
  }

  // Parse the raw dimensions, convert to metres immediately. A combined "L x W x D"
  // cell supplies all three at once; otherwise read the separate columns (depth may
  // be absent in a 2-D source and is then derived from mass + density).
  let dimensions: Dimensions | null;
  if (combined !== null) {
    dimensions = combined;
  } else {
    const l = parseDimensionM(cell(row, cols.dimensionL), sep, unit);
    const h = parseDimensionM(cell(row, cols.dimensionH), sep, unit);
    let w = cols.dimensionP !== undefined ? parseDimensionM(cell(row, cols.dimensionP), sep, unit) : null;

    // No depth column ⇒ derive it from mass + density (see deriveDepthM).
    if (w === null && cols.dimensionP === undefined && l !== null && h !== null) {
      w = deriveDepthM(explicitWeightKg, rules.densityKgPerM3, l, h, columnMap.minDerivedDepthM);
    }

    dimensions = l !== null && h !== null && w !== null && w > 0 ? { l, w, h } : null;
  }

  // A row with no usable dimensions, no pallet count, AND no item text is a
  // STRUCTURAL row — a "STOP N" section header, a "Sub-total", or a "GRAND TOTAL"
  // line that sits inside a dimensioned cargo table (common on groupage multi-drop
  // manifests). It carries no cargo, so drop it rather than emit a phantom "missing
  // dimensions" unit that inflates the load count and trips the packer's conservation
  // gate. A genuine cargo row merely missing its size keeps its description and is
  // still surfaced as unplaced (never guessed).
  const hasText = ((cell(row, cols.description) ?? "").trim() || (cell(row, cols.code) ?? "").trim()) !== "";
  if (dimensions === null && !hasText) return null;

  // A row that merely SUMS the rows above it ("Sub-total Stop 1", "GRAND TOTAL", "S1") is not cargo.
  // It has a weight and no size, so it survives the structural gate above on its label alone, and
  // would then be quoted as a phantom unplaceable item whose weight is added ON TOP of the very
  // cargo it was summarising — double-counting the whole job. Note this is checked AFTER the
  // dimension parse, so a totals row that somehow carries a size is still treated as cargo rather
  // than silently dropped: we only ever delete a row we are sure carries none.
  if (dimensions === null && isTotalsRow(row, cols, columnMap)) return null;

  const qtyParsed =
    cols.quantity !== undefined ? num(cell(row, cols.quantity)) : null;
  let quantity = qtyParsed !== null && qtyParsed >= 1 ? Math.floor(qtyParsed) : 1;

  // The sheet's own subtotals can PROVE that its weight column is each line's TOTAL rather than a
  // per-unit weight (see weight-semantics.ts). When they do, the Qty column is a description of the
  // contents — "Wine Glasses (200 pcs)", Qty 200 — not a count of packages to load. So the line is
  // one package of the stated size and weight. Without this, the weight is multiplied by the piece
  // count AND so is the volume: a 2,565 kg one-van job read as 760,535 kg across 43 vans.
  const semantics = weightSemanticsFor(table, cols, columnMap);
  if (semantics?.lineTotal === true) quantity = 1;

  const weightKg = estimateWeightKg({
    dimensions,
    explicitWeightKg,
    densityKgPerM3: rules.densityKgPerM3,
  });

  return {
    id: `${ci.pageIndex}-${ci.tableIndex}-${ci.rowIndex}`,
    name: name || code || "item",
    dimensions,
    weightKg,
    quantity,
    fragility: ci.fragility,
    category,
    rules,
    material,
    stopIndex,
  };
}

/**
 * Build the packable `Item[]` for a job. Order follows the classification list.
 * Two passes: parse every row first, then classify the DISTINCT Material values
 * in one batched call (see durability-groq-classifier.ts) and combine the result
 * with each row's category defaults.
 */
export async function assembleItems(input: AssembleInput): Promise<Item[]> {
  const { doc, classification, columnMap, matrix } = input;

  const rows: ParsedRow[] = [];
  for (const ci of classification.items) {
    const parsed = parseRow(doc, ci, columnMap, matrix);
    if (parsed) rows.push(parsed);
  }

  const uniqueMaterials = [...new Set(rows.map((r) => r.material).filter((m): m is string => m !== null))];

  const [durabilityByMaterial, tiersConfig] = await Promise.all([
    getDurabilityClassifier().classify(uniqueMaterials),
    loadDurabilityTierPressures(),
  ]);
  const tierPressures = tiersConfig.tiers;

  return rows.map((row): Item => {
    const auto = row.material !== null ? durabilityByMaterial.get(row.material) : undefined;
    const override = input.durabilityOverrides?.get(row.id);

    // Two distinct sources with DIFFERENT authority:
    //  • Automatic (material) fact — a machine guess: it may only TIGHTEN the
    //    category default, never loosen it (conservative min/stricter blend).
    //  • Human override — an explicit review decision: it is authoritative for
    //    this row and applied as-is (mirrors a manual fragility override). Feeding
    //    it through the min-blend would silently ignore a human raising the crush
    //    tier above a low category default — defeating the point of the review.
    let durabilityTier: DurabilityTier;
    let durabilityConfident: boolean;
    let brittle: boolean;
    let orientationLock: OrientationLock;
    let maxStackPressureKpa: number;
    // deformable is preserved from the auto classification in both paths — it has
    // no reviewer override (see DurabilityOverride), but IS enforced below: it
    // softens maxStackPressureKpa via tiersConfig.deformableFactor.
    const deformable = auto?.deformable ?? false;

    if (override) {
      durabilityTier = override.durabilityTier;
      brittle = override.brittle;
      orientationLock = override.orientationLock;
      durabilityConfident = true;
      // A brittle item's PRESSURE LOOKUP (not its displayed tier) is capped at
      // "low" — most brittle materials (marble, granite, stone...) match no tier
      // keyword and fall back to "medium", which would otherwise let an
      // unconfident guess out-rank a properly classified low-tier item once
      // brittleFactor is applied below. See minTier (durability-tier-pressure.ts).
      const pressureTier = brittle ? minTier(override.durabilityTier, "low") : override.durabilityTier;
      maxStackPressureKpa = tierPressures[pressureTier];
    } else {
      brittle = auto?.brittle ?? false;
      const rawTier = auto?.durabilityTier;
      const pressureTier = rawTier === undefined ? undefined : brittle ? minTier(rawTier, "low") : rawTier;
      const tierPressureKpa = pressureTier !== undefined ? tierPressures[pressureTier] : undefined;
      maxStackPressureKpa =
        tierPressureKpa !== undefined
          ? Math.min(row.rules.maxStackPressureKpa, tierPressureKpa)
          : row.rules.maxStackPressureKpa;
      // A material-derived lock may only make the rotation policy STRICTER, never
      // loosen a deliberate category "fixed"/"partial" (a material with no
      // orientation keyword resolves to "none" = absence of evidence, not proof
      // the item is tip-safe).
      orientationLock = auto
        ? stricterOrientationLock(row.rules.orientationLock, auto.orientationLock)
        : row.rules.orientationLock;
      durabilityTier = auto?.durabilityTier ?? tiersConfig.unclassifiedTier;
      durabilityConfident = auto?.confident ?? false;
    }

    // Deformable (foam/fabric — compresses gradually) and brittle (glass/ceramic/
    // stone — cracks) each soften the crush limit by their own factor, applied
    // last, in BOTH paths, tighten-only (factor ≤ 1 apiece — never raises the
    // limit, so a human override can't accidentally loosen safety). An item
    // matching both would take both factors (order doesn't matter, multiplication
    // commutes); the classifier's keyword lists are disjoint so this is not
    // expected in practice, but the math stays correct either way.
    if (deformable) maxStackPressureKpa *= tiersConfig.deformableFactor;
    if (brittle) maxStackPressureKpa *= tiersConfig.brittleFactor;

    return {
      id: row.id,
      name: row.name,
      dimensions: row.dimensions,
      weightKg: row.weightKg,
      quantity: row.quantity,
      fragility: row.fragility,
      category: row.category,
      // Any item may be placed on top of a compatible base — the support rule
      // (fragility compatibility + crush pressure) decides where it can actually
      // go: standards form columns, fragile rests only on fragile. The matrix
      // still owns density + orientation.
      stackable: true,
      canSupportWeightKg: row.rules.canSupportWeightKg,
      orientationLock,
      maxStackPressureKpa,
      material: row.material,
      durabilityTier,
      durabilityConfident,
      brittle,
      deformable,
      stopIndex: row.stopIndex,
    };
  });
}
