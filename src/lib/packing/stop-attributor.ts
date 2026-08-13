/**
 * Cargo → drop attribution for multi-drop groupage manifests.
 *
 * A groupage multi-drop manifest lists every line in ONE cargo table with a
 * "Stop" (or "Drop") column naming the delivery stop each row belongs to
 * (1, 2, 3…). This reads that column and maps each cargo row to a 0-based drop
 * index, so the load plan can zone by stop and the UI can prefill the per-row
 * drop tags — instead of every row silently defaulting to "Drop 1".
 *
 * PURE — no I/O. Deliberately strict: only a cell that is a bare positive integer
 * counts as a stop number, so section-header rows ("**STOP 1 — …**"), sub-total
 * rows ("**Sub-total Stop 1**"), and blanks are skipped rather than guessed at
 * (CLAUDE.md "never guess"). A sheet with no Stop column yields an empty map, so
 * single-drop quoting is completely unaffected.
 */
import { resolveColumnIndices, type ColumnIndices, type ColumnMap } from "@/lib/packing/column-map";
import type { StructuredDocument, TableRow } from "@/lib/conversion/types";
import type { ClassificationResult, ClassifiedItem } from "@/lib/classification/types";

// Row id shape shared with the packer/assembler — single definition in its own leaf so the
// client can reuse it without pulling in config/fs (see row-id.ts).
import { rowId } from "@/lib/packing/row-id";
export { rowId };

/**
 * The 0-based drop index a row belongs to, read from its Stop/Drop cell, or
 * undefined when the table has no stop column or the cell is not a bare positive
 * integer (header/sub-total/blank rows). Stop "1" → 0, "2" → 1, …
 */
export function stopIndexFromRow(row: TableRow, cols: ColumnIndices): number | undefined {
  if (cols.stop === undefined) return undefined;
  const cell = (row[cols.stop] ?? "").trim();
  if (!/^\d+$/.test(cell)) return undefined;
  const n = Number.parseInt(cell, 10);
  return n >= 1 ? n - 1 : undefined;
}

function tableFor(doc: StructuredDocument, ci: ClassifiedItem) {
  const page = doc.pages.find((p) => p.index === ci.pageIndex);
  return page?.tables.find((t) => t.index === ci.tableIndex) ?? null;
}

/**
 * Map each classified cargo row to its 0-based drop index via the Stop column.
 * Iterates the SAME `classification.items` the assembler builds `Item`s from, so
 * the ids here line up exactly with the packed `Item.id`s. Returns only rows that
 * name a stop; empty when the manifest has no stop column (single-drop).
 */
export function attributeStops(
  doc: StructuredDocument,
  classification: ClassificationResult,
  columnMap: ColumnMap,
): Record<string, number> {
  const colsByTable = new Map<string, ColumnIndices | null>();
  const out: Record<string, number> = {};

  for (const ci of classification.items) {
    const table = tableFor(doc, ci);
    if (!table) continue;
    // Defense-in-depth: Stage 2's isItemTable already refuses a headerless table (table-selector.ts),
    // so classification.items should never point here — but resolveColumnIndices below would fall
    // back to a fixed Stop-column position on one, exactly the guess `headerless` exists to forbid.
    if (table.headerless) continue;

    const key = `${ci.pageIndex}-${ci.tableIndex}`;
    let cols = colsByTable.get(key);
    if (cols === undefined) {
      cols = resolveColumnIndices(table.headers, columnMap);
      colsByTable.set(key, cols);
    }
    if (!cols) continue;

    const row = table.rows[ci.rowIndex];
    if (!row) continue;

    const stop = stopIndexFromRow(row, cols);
    if (stop !== undefined) out[rowId(ci.pageIndex, ci.tableIndex, ci.rowIndex)] = stop;
  }

  return out;
}
