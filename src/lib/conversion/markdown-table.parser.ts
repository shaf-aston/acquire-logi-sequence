/**
 * Parses GitHub-flavoured markdown tables (the form Mistral OCR emits) into a
 * grid. Pure and deterministic — no I/O, no config — so it is trivially
 * verifiable in isolation.
 *
 * A markdown table is:
 *   | A | B |
 *   | - | - |
 *   | 1 | 2 |
 * The second row is the header/body separator (dashes, optional colons).
 */
import type { ExtractedTable, TableRow } from "@/lib/conversion/types";

const SEPARATOR_CELL = /^:?-{1,}:?$/;

/**
 * Strip markdown emphasis wrapping a cell. OCR engines reproduce the bold a manifest prints on its
 * subtotal lines, so a cell arrives as `**122**` rather than `122` — and every numeric parser
 * downstream then reads it as "not a number". That is how a sheet's own stated totals became
 * invisible, taking with them the only proof of what its weight column meant.
 *
 * Only wrapping markers are removed, so an asterisk used inside a description survives.
 */
function stripEmphasis(cell: string): string {
  return cell
    .replace(/^(?:\*\*|__|\*|_)+/, "")
    .replace(/(?:\*\*|__|\*|_)+$/, "")
    .trim();
}

/** Splits one markdown table line into trimmed cells, honouring escaped pipes. */
function splitRow(line: string): TableRow {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      buf += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(stripEmphasis(buf.trim()));
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(stripEmphasis(buf.trim()));
  return cells;
}

function isTableLine(line: string): boolean {
  return line.trim().startsWith("|");
}

function isSeparatorRow(cells: TableRow): boolean {
  return cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c.trim()));
}

/** Extracts every markdown table found in `markdown`, in document order. */
export function parseMarkdownTables(markdown: string): ExtractedTable[] {
  const lines = markdown.split(/\r?\n/);
  const tables: ExtractedTable[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!isTableLine(lines[i] ?? "")) {
      i++;
      continue;
    }

    // Collect a contiguous block of table lines.
    const block: string[] = [];
    while (i < lines.length && isTableLine(lines[i] ?? "")) {
      block.push(lines[i] as string);
      i++;
    }

    // Need at least header + separator to be a real table. A single stray pipe-prefixed line (no
    // second line at all) carries no data to lose, so it is simply not a table.
    if (block.length < 2) continue;
    const headerCells = splitRow(block[0] as string);
    if (!isSeparatorRow(splitRow(block[1] as string))) {
      // The header/separator framing never made it through the scan — block[0] might be a real
      // header whose "|---|" line got glued together with a preceding paragraph, or it might be
      // prose that merely starts with "|". Either way we do NOT know which line (if any) is the
      // header, and guessing block[0] is one is the exact sin table-normaliser.ts refuses (it once
      // produced a 760-tonne quote). So the block is kept, not dropped — headerless, no header
      // claimed — and handed downstream for a real reader (table-normaliser's header-promotion) to
      // recover it, or for every column-position reader to refuse it (see conversion/types.ts).
      tables.push({ index: tables.length, headers: [], rows: block.map(splitRow), headerless: true });
      continue;
    }

    const width = headerCells.length;
    const rows: TableRow[] = block
      .slice(2)
      .map(splitRow)
      .map((cells) => normaliseWidth(cells, width));

    tables.push({ index: tables.length, headers: normaliseWidth(headerCells, width), rows });
  }

  return tables;
}

/** Pads/truncates a row so every row matches the header width (handles ragged OCR output). */
function normaliseWidth(cells: TableRow, width: number): TableRow {
  if (cells.length === width) return cells;
  if (cells.length > width) return cells.slice(0, width);
  return [...cells, ...Array<string>(width - cells.length).fill("")];
}
