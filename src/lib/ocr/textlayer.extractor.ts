/**
 * Text-layer PdfExtractor — reads a PDF's *embedded* text (via mupdf) instead of
 * photographing the page. For PDFs that carry a real text layer (most generated
 * quotes/invoices) this is digit-perfect: no OCR misreads (the `9→0` class),
 * free, and local — no API round-trip.
 *
 * mupdf's structured text already sits at cell granularity (each column cell is
 * its own positioned line), so we map those lines straight onto the SAME word
 * contract the Tesseract path uses and reuse `reconstructMarkdown` verbatim —
 * one reconstructor, one downstream markdown-table parser, no special-casing.
 *
 * Scanned/image-only PDFs have no text layer → this yields little/no text; the
 * reading chain detects that and falls back to an OCR engine.
 */
import * as mupdf from "mupdf";
import { getConfig } from "@/config/env";
import { createLogger } from "@/lib/logger/logger";
import { reconstructMarkdown, type OcrWord } from "@/lib/ocr/tesseract-table.reconstructor";
import {
  OcrExtractionError,
  type OcrDocument,
  type OcrInput,
  type OcrPage,
  type PdfExtractor,
} from "@/lib/ocr/extractor.types";

const logger = createLogger("ocr.textlayer");

/** Confidence the text layer carries — it is exact, so the reconstructor's
 * confidence filter (tuned for fuzzy OCR) is a deliberate no-op here. */
const EXACT = 100;

interface StBBox { x: number; y: number; w: number; h: number }
interface StLine { bbox?: StBBox; text?: string }
interface StBlock { type?: string; lines?: StLine[] }

/** Map mupdf structured-text lines (one per cell) to positioned tokens. */
function pageWords(json: { blocks?: StBlock[] }): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of json.blocks ?? []) {
    if (block.type !== "text") continue;
    for (const line of block.lines ?? []) {
      const text = (line.text ?? "").trim();
      const bb = line.bbox;
      if (!text || !bb) continue;
      words.push({ text, x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h, confidence: EXACT });
    }
  }
  return words;
}

export class TextLayerExtractor implements PdfExtractor {
  readonly provider = "textlayer";

  async extract(input: OcrInput): Promise<OcrDocument> {
    const t = getConfig().ocr.textlayer;
    const opts = {
      minConfidence: 0, // text layer is exact — keep every token
      rowGapFactor: t.rowGapFactor,
      colGapFactor: t.colGapFactor,
      minColumns: t.minColumns,
      minTableRows: t.minTableRows,
    };

    try {
      const doc = mupdf.Document.openDocument(input.bytes, input.mimeType || "application/pdf");
      try {
        const pageCount = doc.countPages();
        const pages: OcrPage[] = [];
        for (let i = 0; i < pageCount; i++) {
          const page = doc.loadPage(i);
          const st = page.toStructuredText("preserve-whitespace");
          try {
            const words = pageWords(JSON.parse(st.asJSON()) as { blocks?: StBlock[] });
            pages.push({ index: i, markdown: reconstructMarkdown(words, opts), confidence: EXACT });
          } finally {
            st.destroy?.();
            page.destroy?.();
          }
        }
        logger.info("text-layer extract complete", { file: input.filename, pages: pages.length });
        return { model: "textlayer:mupdf", pages, usage: null, source: "text-layer" };
      } finally {
        doc.destroy();
      }
    } catch (err) {
      logger.error("text-layer extract failed", { file: input.filename, error: String(err) });
      throw new OcrExtractionError(`Text-layer extraction failed for ${input.filename}`, err);
    }
  }
}
