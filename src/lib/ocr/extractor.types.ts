/**
 * Engine-agnostic OCR contract. Downstream code depends only on this — the
 * concrete engine (Mistral today, anything tomorrow) is selected by the factory.
 */

export interface OcrInput {
  /** Raw file bytes. */
  readonly bytes: Uint8Array;
  /** MIME type, e.g. "application/pdf". */
  readonly mimeType: string;
  /** Original filename, for logging/audit only. */
  readonly filename: string;
}

/**
 * How the bytes were read. "text-layer" = the PDF's exact embedded text (no
 * misreads possible); "ocr" = the page was photographed and character-recognised
 * (digits can slip, e.g. 9→0). Drives the operator "verify — read by photo" flag.
 */
export type ReadSource = "text-layer" | "ocr";

export interface OcrPage {
  readonly index: number;
  readonly markdown: string;
  /** Mean recognition confidence (0–100) when the engine reports it (Tesseract);
   *  null/undefined for engines that don't (Mistral) — a text layer is exact (100). */
  readonly confidence?: number | null;
}

export interface OcrDocument {
  readonly model: string;
  readonly pages: OcrPage[];
  /** Engine-reported usage (pages billed, etc.), passed through untouched. */
  readonly usage: Record<string, unknown> | null;
  /** How this document was read. Absent ⇒ legacy result ⇒ treat as "ocr". */
  readonly source?: ReadSource;
}

export interface PdfExtractor {
  /** Engine identifier, e.g. "mistral". */
  readonly provider: string;
  extract(input: OcrInput): Promise<OcrDocument>;
}

/** Raised when extraction fails after exhausting retries. */
export class OcrExtractionError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "OcrExtractionError";
  }
}
