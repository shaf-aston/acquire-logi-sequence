/**
 * Unit coverage for the GFM markdown table parser (Stage 1 seam).
 * Every expectation below is derived from reading markdown-table.parser.ts
 * directly (splitRow / isSeparatorRow / normaliseWidth) — not guessed.
 */
import { describe, it, expect } from "vitest";
import { parseMarkdownTables } from "@/lib/conversion/markdown-table.parser";

describe("parseMarkdownTables — well-formed GFM table (Mistral OCR shape)", () => {
  it("parses the 6-column cm layout into a clean grid: headers, row count, cell trimming, separator excluded", () => {
    // Mirrors config/column-map.json's documented 6-col cm sheet, with the kind
    // of ragged inner whitespace and leading indentation OCR output actually has.
    const markdown = [
      "| Item # | Item Description | Material | Height (cm) | Width (cm) | Weight (kg) |",
      "| --- | --- | --- | --- | --- | --- |",
      "  | 1 | Steel Beam | Steel | 45 | 30 | 120 |  ",
      "| 2 |  Glass Panel  | Glass | 60 | 40 | 25 |",
    ].join("\n");

    const tables = parseMarkdownTables(markdown);

    expect(tables).toHaveLength(1);
    const table = tables[0]!;
    expect(table.index).toBe(0);
    expect(table.headers).toEqual([
      "Item #",
      "Item Description",
      "Material",
      "Height (cm)",
      "Width (cm)",
      "Weight (kg)",
    ]);
    // Separator row ("| --- | ... |") must never surface as data.
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toEqual(["1", "Steel Beam", "Steel", "45", "30", "120"]);
    // Indented row + doubled inner spacing around "Glass Panel" both collapse to trimmed cells.
    expect(table.rows[1]).toEqual(["2", "Glass Panel", "Glass", "60", "40", "25"]);
    // Parser is a pure string-grid layer: values stay strings, never coerced to numbers.
    expect(typeof table.rows[0]![3]).toBe("string");
  });

  it("parses the 11-column metre layout the same way (header-count driven, not hardcoded to 6 cols)", () => {
    const markdown = [
      "| # | Item Description | Category | Material | Height (m) | Width (m) | Depth (m) | Unit Weight (kg) | Quantity | Line Volume | Line Weight |",
      "| - | - | - | - | - | - | - | - | - | - | - |",
      "| 1 | Server Rack | Electronics | Aluminum | 2.0 | 0.6 | 0.8 | 150 | 2 | 0.96 | 300 |",
    ].join("\n");

    const table = parseMarkdownTables(markdown)[0]!;
    expect(table.headers).toHaveLength(11);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual([
      "1",
      "Server Rack",
      "Electronics",
      "Aluminum",
      "2.0",
      "0.6",
      "0.8",
      "150",
      "2",
      "0.96",
      "300",
    ]);
  });
});

describe("parseMarkdownTables — malformed / junk input contract", () => {
  it("pads short rows and truncates long rows to the header width (documented normaliseWidth behaviour)", () => {
    const markdown = [
      "| A | B | C | D |",
      "| - | - | - | - |",
      "| 1 | 2 | 3 |", // one cell short
      "| 1 | 2 | 3 | 4 | 5 | 6 |", // two cells over
    ].join("\n");

    const table = parseMarkdownTables(markdown)[0]!;
    expect(table.headers).toHaveLength(4);
    // Short row: right-padded with empty strings, not left-padded, not dropped.
    expect(table.rows[0]).toEqual(["1", "2", "3", ""]);
    // Long row: silently truncated to the first `width` cells — extras discarded, no error.
    expect(table.rows[1]).toEqual(["1", "2", "3", "4"]);
  });

  it("treats a totals/footer-shaped row as an ordinary data row — the parser has no footer detection", () => {
    const markdown = [
      "| Item | Qty | Weight |",
      "| - | - | - |",
      "| Steel Beam | 2 | 120 |",
      "|  |  | Total: 120 |", // footer-style row, blank cells + label
    ].join("\n");

    const table = parseMarkdownTables(markdown)[0]!;
    expect(table.rows).toHaveLength(2);
    // No special-casing: blank cells stay blank, footer text passes through untouched.
    expect(table.rows[1]).toEqual(["", "", "Total: 120"]);
  });

  it("keeps a header-only table (no data rows) as a valid, counted table with an empty rows array", () => {
    const markdown = ["| X | Y |", "| - | - |"].join("\n");
    const tables = parseMarkdownTables(markdown);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.headers).toEqual(["X", "Y"]);
    expect(tables[0]!.rows).toEqual([]);
  });

  it("does not parse an isolated pipe-prefixed line lacking a real separator row", () => {
    // Only ONE line — there is no second line to even check for a separator, so this is a stray
    // note, not a header whose framing was lost. Nothing to preserve.
    const markdown = "| This is just a note, not a table";
    expect(parseMarkdownTables(markdown)).toEqual([]);
  });

  it("a genuine 2-row block with a real header but no '|---|' separator is kept as headerless data, not dropped", () => {
    // The plainest case of bug 0.6: a real header row + real data rows, but the OCR scan lost the
    // separator line entirely (no dashes row survived at all). Regression pin for the "silently
    // lost a real table" defect described in item-assembler.ts's flaggedCargoTables comments.
    const markdown = [
      "| Item # | Item Description | Height (cm) | Weight (kg) |",
      "| 1 | Steel Beam | 45 | 120 |",
    ].join("\n");
    const tables = parseMarkdownTables(markdown);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.headerless).toBe(true);
    expect(tables[0]!.headers).toEqual([]); // never assume block[0] is the header
    expect(tables[0]!.rows).toEqual([
      ["Item #", "Item Description", "Height (cm)", "Weight (kg)"],
      ["1", "Steel Beam", "45", "120"],
    ]);
  });

  it("FIXED: a non-table paragraph whose lines start with '|' no longer swallows an adjacent real table — it is kept, headerless", () => {
    // block-collection is purely contiguity-based (isTableLine on every line in a
    // run of '|'-prefixed lines), and the header/separator validity check happens
    // only ONCE, after the whole contiguous run has already been consumed and `i`
    // advanced past it. So a non-table pipe-prefixed note directly preceding a real
    // table (no blank line between them) fails the separator check for the WHOLE
    // block — this used to discard it outright (the file's own tests pinned that as
    // a known "real data-loss risk"). It no longer does: the parser cannot tell
    // which line, if any, is the real header, so it claims none (headers: []),
    // flags `headerless: true`, and keeps every raw line for a downstream reader
    // (table-normaliser's header-promotion) to recover, or refuse, rather than
    // losing it before anyone gets the chance.
    const glued = [
      "| Please see notes below |",
      "| item 1 |",
      "| Item # | Item Description | Material |",
      "| - | - | - |",
      "| 1 | Steel Beam | Steel |",
    ].join("\n");
    const gluedTables = parseMarkdownTables(glued);
    expect(gluedTables).toHaveLength(1);
    expect(gluedTables[0]!.headerless).toBe(true);
    expect(gluedTables[0]!.headers).toEqual([]); // no header invented — none was proven
    expect(gluedTables[0]!.rows).toEqual([
      ["Please see notes below"],
      ["item 1"],
      ["Item #", "Item Description", "Material"],
      ["-", "-", "-"],
      ["1", "Steel Beam", "Steel"],
    ]);

    // Same content, but a blank line breaks contiguity -> the two blocks are parsed independently:
    // the noise ("Please see notes below" / "item 1") is its own small headerless block, and the
    // real table — now unglued from it — parses clean with a proper header.
    const withBreak = [
      "| Please see notes below |",
      "| item 1 |",
      "",
      "| Item # | Item Description | Material |",
      "| - | - | - |",
      "| 1 | Steel Beam | Steel |",
    ].join("\n");
    const tables = parseMarkdownTables(withBreak);
    expect(tables).toHaveLength(2);
    expect(tables[0]!.headerless).toBe(true);
    expect(tables[1]!.headerless).toBeUndefined();
    expect(tables[1]!.headers).toEqual(["Item #", "Item Description", "Material"]);
    expect(tables[1]!.rows).toEqual([["1", "Steel Beam", "Steel"]]);
  });

  it("text that merely contains a pipe character but never starts a line with one is never treated as a table", () => {
    const markdown = "Rate: $10 | $12 depending on tier. No table here.";
    expect(parseMarkdownTables(markdown)).toEqual([]);
  });
});

describe("parseMarkdownTables — whitespace/formatting fidelity (parser must not destroy content)", () => {
  it("unwraps markdown emphasis (markup, not content) but preserves units, currency and separators verbatim", () => {
    const markdown = [
      "| **Item #** | **Item Description** | Height (cm) | Width (cm) | Cost |",
      "| - | - | - | - | - |",
      "| 1 | Steel Beam | 45 | 30 | £1,234.56 |",
    ].join("\n");

    const table = parseMarkdownTables(markdown)[0]!;
    // Bold is how the SHEET was printed, not part of the value. Manifests bold their subtotal lines,
    // so a cell arrives as "**122**" — and every numeric parser downstream then reads it as "not a
    // number", which is how a sheet's stated totals became invisible to us. Emphasis is unwrapped
    // here, once, rather than left for each reader to trip over.
    expect(table.headers[0]).toBe("Item #");
    expect(table.headers[1]).toBe("Item Description");
    // Units-in-parens preserved intact for downstream column-map header matching.
    expect(table.headers[2]).toBe("Height (cm)");
    expect(table.headers[3]).toBe("Width (cm)");
    // Currency symbol + thousands comma + decimal point all pass through unchanged.
    expect(table.rows[0]![4]).toBe("£1,234.56");
  });

  it("a bolded subtotal cell survives as a readable number", () => {
    // The regression this guards: "**122**" parsed as text, so the sheet's own subtotal — the only
    // proof of whether its weight column is per-unit or a line total — was never seen.
    const markdown = ["| # | Wt |", "| - | - |", "| **S1** | **122** |"].join("\n");
    const row = parseMarkdownTables(markdown)[0]!.rows[0]!;
    expect(row[0]).toBe("S1");
    expect(row[1]).toBe("122");
    expect(Number(row[1])).toBe(122);
  });

  it("leaves an asterisk INSIDE a description alone — only wrapping markers are markup", () => {
    const markdown = ["| # | Note |", "| - | - |", "| 1 | Grade A*B mix |"].join("\n");
    expect(parseMarkdownTables(markdown)[0]!.rows[0]![1]).toBe("Grade A*B mix");
  });

  it("resolves an escaped pipe inside a cell back to a literal pipe without splitting the cell in two", () => {
    // Built via String.fromCharCode(92) to avoid any ambiguity about backslash counts in
    // this source file: escapedPipe is exactly two runtime chars, backslash then pipe.
    const escapedPipe = String.fromCharCode(92) + "|";
    const markdown = [
      "| Code | Note |",
      "| - | - |",
      `| A1 | ratio 60 ${escapedPipe} 40 blend |`,
    ].join(String.fromCharCode(10));

    const table = parseMarkdownTables(markdown)[0]!;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual(["A1", "ratio 60 | 40 blend"]);
  });
});
