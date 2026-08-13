/**
 * Unit coverage for buildStructuredDocument (Stage 1 seam: OcrDocument -> StructuredDocument).
 * Expectations derived from reading document.builder.ts directly: it is a thin
 * per-page map over parseMarkdownTables with zero cross-page logic of its own.
 */
import { describe, it, expect } from "vitest";
import { buildStructuredDocument } from "@/lib/conversion/document.builder";
import type { OcrDocument } from "@/lib/ocr/extractor.types";

function ocrDoc(pages: string[], extra?: Partial<OcrDocument>): OcrDocument {
  return {
    model: "test-model",
    usage: null,
    pages: pages.map((markdown, index) => ({ index, markdown })),
    ...extra,
  };
}

describe("buildStructuredDocument", () => {
  it("assembles multiple tables across multiple pages into correct pageCount/tableCount and per-page indexes", () => {
    const cmTable = [
      "| Item # | Item Description | Material | Height (cm) | Width (cm) | Weight (kg) |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 1 | Steel Beam | Steel | 45 | 30 | 120 |",
      "| 2 | Glass Panel | Glass | 60 | 40 | 25 |",
    ].join("\n");

    const prosePage = "# Shipment Summary\n\nNo tables on this page, just descriptive notes.";

    const metreTable = [
      "# Page 3",
      "",
      "| # | Item Description | Category | Material | Height (m) | Width (m) | Depth (m) | Unit Weight (kg) | Quantity | Line Volume | Line Weight |",
      "| - | - | - | - | - | - | - | - | - | - | - |",
      "| 1 | Server Rack | Electronics | Aluminum | 2.0 | 0.6 | 0.8 | 150 | 2 | 0.96 | 300 |",
      "",
      "Notes about handling.",
      "",
      "| Code | Note |",
      "| - | - |",
      "| A1 | Fragile |",
    ].join("\n");

    const doc = buildStructuredDocument(ocrDoc([cmTable, prosePage, metreTable]));

    expect(doc.pageCount).toBe(3);
    // 1 table on page 0, 0 on page 1 (prose only), 2 on page 2 -> 3 total.
    expect(doc.tableCount).toBe(3);

    expect(doc.pages).toHaveLength(3);
    expect(doc.pages[0]!.index).toBe(0);
    expect(doc.pages[0]!.tables).toHaveLength(1);
    expect(doc.pages[0]!.tables[0]!.headers).toHaveLength(6);
    expect(doc.pages[0]!.tables[0]!.rows).toHaveLength(2);
    // Raw markdown is preserved untouched for the visual preview / audit trail.
    expect(doc.pages[0]!.markdown).toBe(cmTable);

    expect(doc.pages[1]!.tables).toHaveLength(0);
    expect(doc.pages[1]!.markdown).toBe(prosePage);

    // Table "index" is a running count of tables pushed during THIS page's
    // parseMarkdownTables call (tables.length at push time) -- it resets per page
    // (page 0's only table is also index 0) but increments across multiple tables
    // on the SAME page, it is not always 0.
    expect(doc.pages[2]!.tables).toHaveLength(2);
    expect(doc.pages[2]!.tables[0]!.index).toBe(0);
    expect(doc.pages[2]!.tables[0]!.headers).toHaveLength(11);
    expect(doc.pages[2]!.tables[1]!.index).toBe(1);
    expect(doc.pages[2]!.tables[1]!.headers).toEqual(["Code", "Note"]);
  });

  it("does NOT merge a table split across pages: builder has no cross-page logic, so header-repeated continuations become separate tables and header-less continuations are kept as headerless data (never silently dropped)", () => {
    const headers = "| Item # | Item Description | Weight (kg) |";
    const separator = "| - | - | - |";

    // Continuation page repeats header + separator, as real multi-page PDF/OCR
    // table exports typically do.
    const page0 = [headers, separator, "| 1 | Steel Beam | 120 |"].join("\n");
    const page1WithHeader = [headers, separator, "| 2 | Glass Panel | 25 |"].join("\n");

    const merged = buildStructuredDocument(ocrDoc([page0, page1WithHeader]));
    expect(merged.pageCount).toBe(2);
    // Two SEPARATE ExtractedTable entries, not one merged 2-row table — the
    // continuation is not stitched back onto the original table.
    expect(merged.tableCount).toBe(2);
    expect(merged.pages[0]!.tables[0]!.rows).toEqual([["1", "Steel Beam", "120"]]);
    expect(merged.pages[1]!.tables[0]!.rows).toEqual([["2", "Glass Panel", "25"]]);

    // Continuation page WITHOUT the repeated header/separator: parseMarkdownTables
    // treats the first data-only line as a would-be header and the second as its
    // separator candidate; since it's not a real dash separator, the block's real
    // header/column meaning is unproven. It USED to be dropped outright here (a
    // real data-loss risk this test used to pin as known-wrong). It no longer is:
    // the rows are kept, flagged `headerless`, with no header claimed — nothing is
    // invented, and nothing is lost. Downstream readers (isItemTable et al.) must
    // refuse to resolve a headerless table's columns by position; they do (see
    // table-selector.ts / item-assembler.ts), so this never reaches the packer as
    // a false read — it surfaces as a "header lost in the scan" skipped-table
    // warning instead of vanishing with zero trace.
    const page1NoHeader = ["| 2 | Glass Panel | 25 |", "| 3 | Copper Wire | 8 |"].join("\n");
    const lossy = buildStructuredDocument(ocrDoc([page0, page1NoHeader]));
    expect(lossy.pageCount).toBe(2);
    expect(lossy.tableCount).toBe(2); // page 0's table + page 1's headerless block, neither lost
    expect(lossy.pages[1]!.tables).toHaveLength(1);
    expect(lossy.pages[1]!.tables[0]!.headerless).toBe(true);
    expect(lossy.pages[1]!.tables[0]!.headers).toEqual([]); // no header invented
    expect(lossy.pages[1]!.tables[0]!.rows).toEqual([
      ["2", "Glass Panel", "25"],
      ["3", "Copper Wire", "8"],
    ]);
    // The raw markdown is still kept for audit either way.
    expect(lossy.pages[1]!.markdown).toBe(page1NoHeader);
  });

  it("handles an OcrDocument with zero pages", () => {
    const empty = buildStructuredDocument(ocrDoc([]));
    // No source on the OCR doc ⇒ legacy ⇒ treated as photo-OCR ⇒ needs review.
    expect(empty).toEqual({
      pageCount: 0,
      tableCount: 0,
      pages: [],
      source: "ocr",
      confidence: null,
      needsReview: true,
    });
  });

  it("carries the read-trust signal: a text-layer read is trusted (no review), OCR is not", () => {
    const md = "| A | B |\n| - | - |\n| 1 | 2 |";

    const textLayer = buildStructuredDocument({
      model: "textlayer:mupdf",
      usage: null,
      source: "text-layer",
      pages: [{ index: 0, markdown: md, confidence: 100 }],
    });
    expect(textLayer.source).toBe("text-layer");
    expect(textLayer.needsReview).toBe(false);
    expect(textLayer.confidence).toBe(100);

    // OCR read with two page scores ⇒ averaged, and flagged for review.
    const ocr = buildStructuredDocument({
      model: "tesseract:eng",
      usage: null,
      source: "ocr",
      pages: [
        { index: 0, markdown: md, confidence: 80 },
        { index: 1, markdown: md, confidence: 90 },
      ],
    });
    expect(ocr.source).toBe("ocr");
    expect(ocr.needsReview).toBe(true);
    expect(ocr.confidence).toBe(85);
  });
});
