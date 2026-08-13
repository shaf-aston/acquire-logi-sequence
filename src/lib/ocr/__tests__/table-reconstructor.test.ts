/**
 * Regression net for `reconstructMarkdown`'s sparse-row handling. A stop list
 * whose rows are interrupted by a stray one-token line (a phone number floating
 * on its own line between stops) must NOT be split into separate tables — every
 * stop after the first would otherwise lose its header row and vanish downstream.
 */
import { describe, it, expect } from "vitest";
import { reconstructMarkdown, type OcrWord } from "@/lib/ocr/tesseract-table.reconstructor";
import { parseMarkdownTables } from "@/lib/conversion/markdown-table.parser";

const OPTS = { minConfidence: 0, rowGapFactor: 0.6, colGapFactor: 1.2, minColumns: 2, minTableRows: 2 };

/** Build a word box on a grid: col drives x, rowY drives y, uniform 10-tall glyphs. */
function w(text: string, col: number, rowY: number): OcrWord {
  const x0 = col * 100;
  return { text, x0, y0: rowY, x1: x0 + 40, y1: rowY + 10, confidence: 100 };
}

describe("reconstructMarkdown — interstitial sparse rows", () => {
  it("keeps a stop list as ONE table across a floating phone-number line", () => {
    // Two stops in the same 3-column list, separated by a lone phone-number row.
    const words: OcrWord[] = [
      // header row
      w("Stop", 0, 0), w("Company", 1, 0), w("Address", 2, 0),
      // stop 1
      w("1", 0, 20), w("Acme", 1, 20), w("1 High St, LS1 4AB", 2, 20),
      // stray phone line (single token) — used to split the table
      w("+44 113 555 0101", 1, 40),
      // stop 2 — same three columns
      w("2", 0, 60), w("Beta", 1, 60), w("2 Low Rd, M1 2AB", 2, 60),
    ];

    const md = reconstructMarkdown(words, OPTS);
    const tables = parseMarkdownTables(md);

    // One table, not three; both stop addresses survive in its rows.
    expect(tables).toHaveLength(1);
    const cells = tables[0]!.rows.flat().join(" | ");
    expect(cells).toContain("1 High St, LS1 4AB");
    expect(cells).toContain("2 Low Rd, M1 2AB");
    expect(tables[0]!.headers.join(" ")).toContain("Address");
  });

  it("still SPLITS when a differently-shaped table follows the sparse run", () => {
    // A real second table has its OWN column geometry, not one nested at the exact
    // x-anchors of the first — that distinct geometry is what tells the two apart.
    const words: OcrWord[] = [
      // a 3-col list at x = 0/100/200
      w("Stop", 0, 0), w("Company", 1, 0), w("Address", 2, 0),
      w("1", 0, 20), w("Acme", 1, 20), w("1 High St, LS1 4AB", 2, 20),
      // heading (sparse) then a 2-col table laid out at its own x = 50/150
      w("SUMMARY", 0, 40),
      { text: "Origin", x0: 50, y0: 60, x1: 90, y1: 70, confidence: 100 },
      { text: "Weight", x0: 150, y0: 60, x1: 190, y1: 70, confidence: 100 },
      { text: "Acme", x0: 50, y0: 80, x1: 90, y1: 90, confidence: 100 },
      { text: "10kg", x0: 150, y0: 80, x1: 190, y1: 90, confidence: 100 },
    ];

    const tables = parseMarkdownTables(reconstructMarkdown(words, OPTS));
    expect(tables.length).toBe(2); // the two tables stay separate
  });
});
