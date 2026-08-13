/**
 * Fall-through logic for the fail-soft reading chain. Pure — stub extractors, no
 * PDF — so the branch behaviour (use primary / fall back on low yield / fall back
 * on throw) is verified in isolation.
 */
import { describe, it, expect, vi } from "vitest";
import { ReadingChainExtractor } from "@/lib/ocr/reading-chain.extractor";
import { OcrExtractionError, type OcrDocument, type OcrInput, type PdfExtractor } from "@/lib/ocr/extractor.types";

const input: OcrInput = { bytes: new Uint8Array(), mimeType: "application/pdf", filename: "x.pdf" };

function docOf(provider: string, markdown: string): OcrDocument {
  return { model: provider, pages: [{ index: 0, markdown }], usage: null };
}

function stub(provider: string, impl: () => Promise<OcrDocument>): PdfExtractor {
  return { provider, extract: vi.fn(impl) };
}

describe("ReadingChainExtractor", () => {
  it("uses the primary result when its per-page yield clears the threshold", async () => {
    const primary = stub("textlayer", async () => docOf("textlayer", "a".repeat(300)));
    const fallback = stub("mistral", async () => docOf("mistral", "should not be used"));
    const chain = new ReadingChainExtractor(primary, fallback, 200);

    const out = await chain.extract(input);
    expect(out.model).toBe("textlayer");
    expect(fallback.extract).not.toHaveBeenCalled();
  });

  it("falls back to OCR when the primary yields too little text (a scan)", async () => {
    const primary = stub("textlayer", async () => docOf("textlayer", "  \n ")); // ~0 real chars
    const fallback = stub("mistral", async () => docOf("mistral", "ocr result"));
    const chain = new ReadingChainExtractor(primary, fallback, 200);

    const out = await chain.extract(input);
    expect(out.model).toBe("mistral");
    expect(fallback.extract).toHaveBeenCalledOnce();
  });

  it("falls back to OCR when the primary reader throws", async () => {
    const primary = stub("textlayer", async () => {
      throw new OcrExtractionError("boom");
    });
    const fallback = stub("mistral", async () => docOf("mistral", "ocr result"));
    const chain = new ReadingChainExtractor(primary, fallback, 200);

    const out = await chain.extract(input);
    expect(out.model).toBe("mistral");
    expect(fallback.extract).toHaveBeenCalledOnce();
  });

  it("advertises the composed provider identity for cache namespacing", () => {
    const chain = new ReadingChainExtractor(stub("textlayer", async () => docOf("textlayer", "")), stub("mistral", async () => docOf("mistral", "")), 200);
    expect(chain.provider).toBe("chain(textlayer->mistral)");
  });
});
