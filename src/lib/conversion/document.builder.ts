/**
 * Converts raw OCR output (markdown per page) into a StructuredDocument by
 * parsing tables out of each page. Pure transform — OCR-engine agnostic.
 */
import type { OcrDocument } from "@/lib/ocr/extractor.types";
import { parseMarkdownTables } from "@/lib/conversion/markdown-table.parser";
import { normaliseTable, type HeaderVocabulary } from "@/lib/conversion/table-normaliser";
import type { PageContent, StructuredDocument } from "@/lib/conversion/types";

export interface BuildOptions {
  /**
   * The column-heading vocabulary (`headerPatterns` from config/column-map.json), injected by the
   * caller so this layer hardcodes no column names. Supplying it turns on table normalisation:
   * a section banner sitting where the header should be gets demoted, the real header promoted, and
   * in-body stop banners lifted into `sections` (see table-normaliser.ts).
   *
   * OMITTED ⇒ tables are returned exactly as the scan framed them. The groupage roster reader relies
   * on that raw framing — it does its own row-continuation merging — so it deliberately opts out.
   */
  readonly headerVocabulary?: HeaderVocabulary;
}

export function buildStructuredDocument(ocr: OcrDocument, opts: BuildOptions = {}): StructuredDocument {
  const vocab = opts.headerVocabulary ?? [];
  const pages: PageContent[] = ocr.pages.map((page) => ({
    index: page.index,
    markdown: page.markdown,
    tables: parseMarkdownTables(page.markdown).map((t) => normaliseTable(t, vocab)),
  }));

  const tableCount = pages.reduce((sum, p) => sum + p.tables.length, 0);

  // Carry the read-trust signal forward. Absent source ⇒ legacy ⇒ treat as OCR.
  // needsReview is a pure mapping (photo-OCR reads can misread digits); the exact
  // text layer never does, so it is trusted. No config/threshold here keeps the
  // builder pure and engine-agnostic.
  const source = ocr.source ?? "ocr";
  const scored = ocr.pages
    .map((p) => p.confidence)
    .filter((c): c is number => typeof c === "number");
  const confidence = scored.length
    ? scored.reduce((sum, c) => sum + c, 0) / scored.length
    : null;
  const needsReview = source !== "text-layer";

  return { pageCount: pages.length, tableCount, pages, source, confidence, needsReview };
}
