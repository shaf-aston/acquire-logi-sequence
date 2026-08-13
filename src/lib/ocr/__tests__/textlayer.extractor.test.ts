/**
 * Golden test for the text-layer reader on a real text PDF (quoteG). Proves the
 * embedded text layer is read digit-perfect — the `9→0` OCR misread class simply
 * cannot occur here — and that cargo tables are reconstructed for the downstream
 * markdown-table parser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { TextLayerExtractor } from "@/lib/ocr/textlayer.extractor";
import { parseMarkdownTables } from "@/lib/conversion/markdown-table.parser";

const FIXTURE = fileURLToPath(new URL("./fixtures/quoteG.pdf", import.meta.url));

function loadInput() {
  return {
    bytes: new Uint8Array(readFileSync(FIXTURE)),
    mimeType: "application/pdf",
    filename: "quoteG.pdf",
  };
}

describe("TextLayerExtractor on a real text PDF", () => {
  it("reads the Bill-To postcode with the correct digit (9, not 0)", async () => {
    const doc = await new TextLayerExtractor().extract(loadInput());
    const all = doc.pages.map((p) => p.markdown).join("\n");
    expect(all).toContain("BS11 9YA"); // the true postcode
    expect(all).not.toContain("BS11 0YA"); // the OCR misread it must never produce
  });

  it("reconstructs cargo tables the markdown parser can read", async () => {
    const doc = await new TextLayerExtractor().extract(loadInput());
    const tables = doc.pages.flatMap((p) => parseMarkdownTables(p.markdown));
    expect(tables.length).toBeGreaterThan(0);

    const flatCells = tables.flatMap((t) => [t.headers, ...t.rows]).flat().join(" | ");
    expect(flatCells).toContain("(cm)"); // unit marker survives into a table cell
    expect(flatCells).toContain("120 x 100 x 110"); // a cargo dimension survives
  });
});
