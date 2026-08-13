/**
 * Cost guard: a content-addressed cache that wraps any PdfExtractor. The same
 * PDF bytes are OCR'd once; every later re-run / repeat upload of that file is
 * served from disk instead of re-billing the provider (Mistral, Groq, …).
 *
 * Engine-agnostic by construction: the cache key folds in provider + model, so
 * switching engines (or model versions) is a cache miss and re-OCRs correctly.
 * A read/write failure never breaks ingestion — it just degrades to a live call.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "@/lib/logger/logger";
import type { OcrDocument, OcrInput, PdfExtractor } from "@/lib/ocr/extractor.types";

const logger = createLogger("ocr.cache");

export interface OcrCacheOptions {
  readonly dir: string;
  /** Folded into the key so different engines/models never share an entry. */
  readonly keyNamespace: string;
}

/** sha256 of the bytes — the document's stable identity, independent of filename. */
function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class CachingExtractor implements PdfExtractor {
  readonly provider: string;
  private readonly inner: PdfExtractor;
  private readonly opts: OcrCacheOptions;

  constructor(inner: PdfExtractor, opts: OcrCacheOptions) {
    this.inner = inner;
    this.provider = inner.provider;
    this.opts = opts;
  }

  private cachePath(bytes: Uint8Array): string {
    const hash = contentHash(bytes);
    return resolve(process.cwd(), this.opts.dir, `${this.opts.keyNamespace}-${hash}.json`);
  }

  async extract(input: OcrInput): Promise<OcrDocument> {
    const path = this.cachePath(input.bytes);

    try {
      const hit = await readFile(path, "utf8");
      logger.info("ocr cache hit — provider call skipped", { file: input.filename, path });
      return JSON.parse(hit) as OcrDocument;
    } catch {
      // Miss (or unreadable) — fall through to a live extraction.
    }

    const doc = await this.inner.extract(input);

    try {
      await mkdir(resolve(process.cwd(), this.opts.dir), { recursive: true });
      await writeFile(path, JSON.stringify(doc), "utf8");
      logger.info("ocr result cached", { file: input.filename, path });
    } catch (err) {
      logger.warn("ocr cache write failed — continuing without cache", { error: String(err) });
    }

    return doc;
  }
}

/** Build a namespace that invalidates the cache when the engine or model changes. */
export function cacheNamespace(provider: string, model: string): string {
  // Keep it filesystem-safe.
  return `${provider}_${model}`.replace(/[^a-zA-Z0-9._-]/g, "-");
}
