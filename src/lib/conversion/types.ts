/** Structured, computer-readable representation of extracted content. */

import type { ReadSource } from "@/lib/ocr/extractor.types";

export type TableCell = string;
export type TableRow = TableCell[];

export interface ExtractedTable {
  /** 0-based index of this table within its page. */
  readonly index: number;
  readonly headers: TableRow;
  readonly rows: TableRow[];
  /** Text that sat ABOVE the real header (a section banner, a letterhead) — see table-normaliser.ts. */
  readonly caption?: readonly string[];
  /** In-body section banners ("STOP 2: …" + its address) and the rows each introduces. */
  readonly sections?: readonly TableSection[];
  /**
   * True when the scan lost this table's header row entirely, so no column's meaning is known.
   * Readers MUST surface this rather than fall back to reading columns by position — that fallback
   * is a guess, and it has produced a silent 300× wrong weight. See table-normaliser.ts.
   */
  readonly headerless?: boolean;
}

/** A banner inside a table and the rows beneath it that it introduces. */
export interface TableSection {
  /** The banner lines in document order — typically a stop/company name, then its address. */
  readonly lines: string[];
  /** Index into `ExtractedTable.rows` of the first row this section owns. */
  readonly startRow: number;
}

export interface PageContent {
  /** 0-based page index as returned by the OCR engine. */
  readonly index: number;
  /** Raw markdown for this page (kept for the visual preview / audit trail). */
  readonly markdown: string;
  /** Tables parsed out of the markdown into a grid form. */
  readonly tables: ExtractedTable[];
}

export interface StructuredDocument {
  readonly pageCount: number;
  readonly tableCount: number;
  readonly pages: PageContent[];
  /** How the document was read (exact text layer vs photographed + OCR'd). */
  readonly source?: ReadSource;
  /** Mean read confidence across pages (0–100), or null when the engine reports none. */
  readonly confidence?: number | null;
  /** True when read by photo-OCR — the operator should verify digits/addresses. A
   *  text-layer read is exact, so it is false. Drives the review-surface trust banner. */
  readonly needsReview?: boolean;
}
