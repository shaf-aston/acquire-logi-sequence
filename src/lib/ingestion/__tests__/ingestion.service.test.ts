/**
 * Orchestration tests for ingestPdf: validate -> ocr -> convert -> classify ->
 * detect-addresses. Only the OCR engine is faked (via the extractor.factory
 * seam) — validation, table parsing, classification and address detection run
 * for real against the repo's shipped config (fragility-rules.json,
 * address-detection.json), the same way production wires them. Object storage
 * stays at its default (disabled -> NoopObjectStore), so archiving is a real
 * no-op here, not a mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PdfExtractor, OcrDocument, OcrPage } from "@/lib/ocr/extractor.types";
import { OcrExtractionError } from "@/lib/ocr/extractor.types";
import { FileValidationError } from "@/lib/ingestion/file.validator";

vi.mock("@/lib/ocr/extractor.factory", () => ({
  getExtractor: vi.fn(),
}));

import { getExtractor } from "@/lib/ocr/extractor.factory";
import { ingestPdf, type IngestionInput } from "@/lib/ingestion/ingestion.service";

const getExtractorMock = vi.mocked(getExtractor);

function fakeExtractor(pages: OcrPage[]): PdfExtractor & { extract: ReturnType<typeof vi.fn> } {
  return {
    provider: "fake",
    extract: vi.fn(
      async (): Promise<OcrDocument> => ({ model: "fake-model", pages, usage: null }),
    ),
  };
}

function baseInput(overrides: Partial<IngestionInput> = {}): IngestionInput {
  return {
    bytes: new TextEncoder().encode("%PDF-1.4\nfake pdf body\n%%EOF"),
    mimeType: "application/pdf",
    filename: "quote.pdf",
    requestId: "req-1",
    ...overrides,
  };
}

// A single item table (matches column-map.json's header patterns) plus one
// pickup/drop line pair recognisable by the real address detector.
const ITEM_TABLE_MARKDOWN = [
  "| Item Description | Material | Height (m) | Width (m) | Weight (kg) |",
  "| --- | --- | --- | --- | --- |",
  "| Glass Panel | Glass | 1.2 | 0.8 | 45 |",
].join("\n");

const ADDRESS_MARKDOWN =
  "Collection: 5 Main Road, Leeds, LS1 4AB\nDelivery: 22 Oak Street, Bristol, BS1 5TR";

describe("ingestPdf", () => {
  beforeEach(() => {
    getExtractorMock.mockReset();
  });

  it("happy path: one table + one address pair -> full result with real document/classification/addresses/perf", async () => {
    const extractor = fakeExtractor([
      { index: 0, markdown: ITEM_TABLE_MARKDOWN },
      { index: 1, markdown: ADDRESS_MARKDOWN },
    ]);
    getExtractorMock.mockReturnValue(extractor);

    const result = await ingestPdf(baseInput());

    expect(result.provider).toBe("fake");
    expect(result.document.pageCount).toBe(2);
    expect(result.document.tableCount).toBe(1);

    expect(result.classification.items).toHaveLength(1);
    expect(result.classification.counts).toEqual({ fragile: 1, standard: 0, lowConfidence: 0 });

    expect(result.addresses.pickup).toBe("5 Main Road, Leeds, LS1 4AB");
    expect(result.addresses.drops).toEqual(["22 Oak Street, Bristol, BS1 5TR"]);

    const spanNames = result.perf.spans.map((s) => s.name);
    expect(spanNames).toEqual(["validate", "ocr", "convert", "classify", "detect-addresses", "attribute-stops", "detect-direction"]);

    // Single-drop fixture (no Stop column) ⇒ no cargo row is attributed to a drop.
    expect(result.itemStopIndex).toEqual({});

    expect(extractor.extract).toHaveBeenCalledTimes(1);
  });

  it("propagates OcrExtractionError when the extractor fails (does not swallow or rewrap it)", async () => {
    const extractor = fakeExtractor([]);
    extractor.extract.mockRejectedValueOnce(new OcrExtractionError("engine unavailable"));
    getExtractorMock.mockReturnValue(extractor);

    await expect(ingestPdf(baseInput())).rejects.toBeInstanceOf(OcrExtractionError);
  });

  it("short-circuits on validation failure: the OCR extractor is never invoked", async () => {
    const extractor = fakeExtractor([{ index: 0, markdown: ITEM_TABLE_MARKDOWN }]);
    getExtractorMock.mockReturnValue(extractor);

    await expect(
      ingestPdf(baseInput({ bytes: new Uint8Array(0), filename: "empty.pdf" })),
    ).rejects.toBeInstanceOf(FileValidationError);

    expect(getExtractorMock).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it("address detection is fail-soft: no addresses in the document -> ingestion still succeeds with empty addresses", async () => {
    const extractor = fakeExtractor([{ index: 0, markdown: ITEM_TABLE_MARKDOWN }]);
    getExtractorMock.mockReturnValue(extractor);

    const result = await ingestPdf(baseInput());

    expect(result.addresses).toEqual({ pickup: null, drops: [] });
    // Rest of the pipeline is unaffected by the missing addresses.
    expect(result.classification.items).toHaveLength(1);
  });
});
