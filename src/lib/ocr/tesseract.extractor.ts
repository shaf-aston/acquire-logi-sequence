/**
 * Tesseract OCR engine (tesseract.js, WASM) implementation of PdfExtractor.
 *
 * Free + fully local. Flow: rasterize PDF → OCR each page image (with word
 * boxes) → reconstruct markdown tables from word coordinates. The reconstructed
 * markdown flows through the same parser as Mistral's, so tables work for free.
 * Mistral stays the production default (faster, higher table fidelity).
 */
import { createWorker } from "tesseract.js";
import { getConfig } from "@/config/env";
import { createLogger } from "@/lib/logger/logger";
import { rasterizePdf } from "@/lib/ocr/pdf-rasterizer";
import { reconstructMarkdown, type OcrWord } from "@/lib/ocr/tesseract-table.reconstructor";
import {
  OcrExtractionError,
  type OcrDocument,
  type OcrInput,
  type OcrPage,
  type PdfExtractor,
} from "@/lib/ocr/extractor.types";

const logger = createLogger("ocr.tesseract");

interface TessBbox { x0: number; y0: number; x1: number; y1: number }
interface TessWord { text: string; confidence: number; bbox: TessBbox }
interface TessLine { words: TessWord[] }
interface TessParagraph { lines: TessLine[] }
interface TessBlock { paragraphs: TessParagraph[] }

/** Flatten Tesseract's block→paragraph→line→word tree into flat words with coords. */
function flattenWords(blocks: TessBlock[] | null): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          words.push({
            text: w.text,
            x0: w.bbox.x0,
            y0: w.bbox.y0,
            x1: w.bbox.x1,
            y1: w.bbox.y1,
            confidence: w.confidence,
          });
        }
      }
    }
  }
  return words;
}

/** Mean word confidence for a page (0–100), or null if the page had no words. */
function meanConfidence(words: OcrWord[]): number | null {
  if (words.length === 0) return null;
  return words.reduce((sum, w) => sum + w.confidence, 0) / words.length;
}

export class TesseractExtractor implements PdfExtractor {
  readonly provider = "tesseract";

  async extract(input: OcrInput): Promise<OcrDocument> {
    const t = getConfig().ocr.tesseract;
    const reconstructOpts = {
      minConfidence: t.minConfidence,
      rowGapFactor: t.rowGapFactor,
      colGapFactor: t.colGapFactor,
      minColumns: t.minColumns,
      minTableRows: t.minTableRows,
    };

    try {
      const rasters = rasterizePdf(input.bytes, t.scale);
      logger.info("rasterized pdf", { file: input.filename, pages: rasters.length, scale: t.scale });

      // One reused worker for all pages — loading language data per page is the
      // dominant cost, so we pay it once.
      const worker = await createWorker(t.lang);
      try {
        const pages: OcrPage[] = [];
        for (const raster of rasters) {
          // blocks:true exposes the word-level bounding boxes we cluster into tables.
          const { data } = await worker.recognize(Buffer.from(raster.png), {}, { blocks: true });
          const words = flattenWords(data.blocks);
          pages.push({
            index: raster.index,
            markdown: reconstructMarkdown(words, reconstructOpts),
            confidence: meanConfidence(words),
          });
        }
        logger.info("ocr complete", { file: input.filename, pages: pages.length, lang: t.lang });
        return { model: `tesseract:${t.lang}`, pages, usage: null, source: "ocr" };
      } finally {
        await worker.terminate();
      }
    } catch (err) {
      logger.error("ocr failed", { file: input.filename, error: String(err) });
      throw new OcrExtractionError(`Tesseract OCR failed for ${input.filename}`, err);
    }
  }
}
