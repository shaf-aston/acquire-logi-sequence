/**
 * Mistral OCR engine implementation of PdfExtractor.
 *
 * Speed choices: bytes are sent inline as a base64 data URI (no separate upload
 * round-trip), images are off by default (smaller payload), and a hard timeout
 * bounds every call. All knobs come from config — nothing hardcoded here.
 */
import { Mistral } from "@mistralai/mistralai";
import { getConfig } from "@/config/env";
import { createLogger } from "@/lib/logger/logger";
import { withRetry } from "@/lib/util/retry";
import {
  OcrExtractionError,
  type OcrDocument,
  type OcrInput,
  type OcrPage,
  type PdfExtractor,
} from "@/lib/ocr/extractor.types";

const logger = createLogger("ocr.mistral");

/** Transient = network blips, rate limits, and 5xx. 4xx (bad key/payload) is not. */
function isTransient(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number })?.statusCode
    ?? (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return true; // no status → assume network-level, worth a retry
}

function toDataUri(input: OcrInput): string {
  const base64 = Buffer.from(input.bytes).toString("base64");
  return `data:${input.mimeType};base64,${base64}`;
}

interface RawPage {
  index?: number;
  markdown?: string;
}

export class MistralExtractor implements PdfExtractor {
  readonly provider = "mistral";
  private readonly client: Mistral;

  constructor() {
    const { apiKey } = getConfig().ocr;
    this.client = new Mistral({ apiKey });
  }

  async extract(input: OcrInput): Promise<OcrDocument> {
    const cfg = getConfig().ocr;
    const documentUrl = toDataUri(input);

    const run = () =>
      this.client.ocr.process(
        {
          model: cfg.model,
          document: { type: "document_url", documentUrl },
          includeImageBase64: cfg.includeImages,
        },
        { timeoutMs: cfg.timeoutMs },
      );

    try {
      const response = await withRetry(run, {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.retryBaseDelayMs,
        isRetryable: isTransient,
        logger,
      });

      const rawPages = (response.pages ?? []) as RawPage[];
      const pages: OcrPage[] = rawPages.map((p, i) => ({
        index: typeof p.index === "number" ? p.index : i,
        markdown: p.markdown ?? "",
      }));

      logger.info("ocr complete", {
        file: input.filename,
        model: cfg.model,
        pages: pages.length,
      });

      return {
        model: cfg.model,
        pages,
        usage: (response.usageInfo as Record<string, unknown> | undefined) ?? null,
        source: "ocr", // Mistral photographs the page — digits can be misread.
      };
    } catch (err) {
      logger.error("ocr failed", { file: input.filename, error: String(err) });
      throw new OcrExtractionError(`Mistral OCR failed for ${input.filename}`, err);
    }
  }
}
