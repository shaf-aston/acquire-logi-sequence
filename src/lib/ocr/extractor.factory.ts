/**
 * Selects the reading engine from config (OCR_PROVIDER). Downstream code calls
 * getExtractor() and never names a concrete engine — swapping providers is a
 * one-line addition here, zero changes elsewhere.
 *
 * `auto` (the default) builds a fail-soft reading chain: the embedded text layer
 * first (digit-perfect, free, local), falling back to an OCR engine for scanned
 * PDFs. `textlayer`/`mistral`/`tesseract` pin a single engine.
 */
import { getConfig } from "@/config/env";
import { MistralExtractor } from "@/lib/ocr/mistral.extractor";
import { TesseractExtractor } from "@/lib/ocr/tesseract.extractor";
import { TextLayerExtractor } from "@/lib/ocr/textlayer.extractor";
import { ReadingChainExtractor } from "@/lib/ocr/reading-chain.extractor";
import { CachingExtractor, cacheNamespace } from "@/lib/ocr/caching.extractor";
import type { PdfExtractor } from "@/lib/ocr/extractor.types";

// Register reading engines here. The active one is chosen by OCR_PROVIDER in .env.
const registry: Record<string, () => PdfExtractor> = {
  mistral: () => new MistralExtractor(), // production OCR — fast, structured tables
  tesseract: () => new TesseractExtractor(), // dev OCR — free, local, plain text
  textlayer: () => new TextLayerExtractor(), // embedded text layer — exact, no OCR
};

function buildEngine(provider: string, cfg: ReturnType<typeof getConfig>["ocr"]): PdfExtractor {
  if (provider === "auto") {
    const fallbackProvider = cfg.textlayer.fallbackProvider.toLowerCase();
    const fallbackFactory = registry[fallbackProvider];
    if (!fallbackFactory) {
      throw new Error(
        `[ocr] Unknown OCR_TEXTLAYER_FALLBACK_PROVIDER "${fallbackProvider}". Known: ${Object.keys(registry).join(", ")}`,
      );
    }
    return new ReadingChainExtractor(
      new TextLayerExtractor(),
      fallbackFactory(),
      cfg.textlayer.minYieldChars,
    );
  }
  const factory = registry[provider];
  if (!factory) {
    throw new Error(
      `[ocr] Unknown OCR_PROVIDER "${provider}". Known: auto, ${Object.keys(registry).join(", ")}`,
    );
  }
  return factory();
}

let cached: PdfExtractor | null = null;

export function getExtractor(): PdfExtractor {
  if (cached) return cached;
  const cfg = getConfig().ocr;
  const provider = cfg.provider.toLowerCase();
  const engine = buildEngine(provider, cfg);
  // Wrap the engine in a content-hash cache so the same PDF is never billed twice.
  // Disabled engines (tesseract) are free, but caching them is still a latency win.
  cached = cfg.cache.enabled
    ? new CachingExtractor(engine, {
        dir: cfg.cache.dir,
        keyNamespace: cacheNamespace(engine.provider, cfg.model),
      })
    : engine;
  return cached;
}
