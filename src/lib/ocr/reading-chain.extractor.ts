/**
 * Fail-soft reading chain — the same "pick-your-engine seam with a graceful
 * fallback" shape used by the durability (Groq→SambaNova→rule) and address
 * (Groq→rule) chains, applied to the PDF *reading* stage.
 *
 * Order: try the primary reader (text layer — digit-perfect, free, local); if it
 * yields too little text (a scanned/image-only PDF) or throws, fall back to the
 * OCR engine. A true text PDF never pays for OCR; a scan still gets read.
 *
 * The yield gate is a per-page non-whitespace character count so the decision is
 * format-agnostic (no reliance on any one layout). Threshold is config-injected.
 */
import { createLogger } from "@/lib/logger/logger";
import type { OcrDocument, OcrInput, PdfExtractor } from "@/lib/ocr/extractor.types";

const logger = createLogger("ocr.chain");

function perPageYield(doc: OcrDocument): number {
  const total = doc.pages.reduce((sum, p) => sum + p.markdown.replace(/\s/g, "").length, 0);
  return total / Math.max(doc.pages.length, 1);
}

export class ReadingChainExtractor implements PdfExtractor {
  readonly provider: string;

  constructor(
    private readonly primary: PdfExtractor,
    private readonly fallback: PdfExtractor,
    private readonly minYieldChars: number,
  ) {
    this.provider = `chain(${primary.provider}->${fallback.provider})`;
  }

  async extract(input: OcrInput): Promise<OcrDocument> {
    let primaryDoc: OcrDocument;
    try {
      primaryDoc = await this.primary.extract(input);
    } catch (err) {
      logger.warn("primary reader threw; falling back to OCR", {
        file: input.filename,
        primary: this.primary.provider,
        fallback: this.fallback.provider,
        error: String(err),
      });
      return this.fallback.extract(input);
    }

    const yieldChars = perPageYield(primaryDoc);
    if (yieldChars >= this.minYieldChars) return primaryDoc;

    logger.info("primary reader low yield; falling back to OCR", {
      file: input.filename,
      perPageChars: Math.round(yieldChars),
      minYieldChars: this.minYieldChars,
      fallback: this.fallback.provider,
    });
    return this.fallback.extract(input);
  }
}
