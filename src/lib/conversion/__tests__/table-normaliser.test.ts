/**
 * A markdown table promises "the first line is the header". Scanned manifests break that promise, and
 * the OCR faithfully reproduces the break — so a section banner or a letterhead ends up where the
 * header should be, every column resolves against the wrong text, and the packer reads a weight as a
 * dimension. On route-plan/detailed.pdf that turned 2,565 kg into 760,535 kg.
 */
import { describe, it, expect } from "vitest";
import { normaliseTable } from "@/lib/conversion/table-normaliser";
import type { ExtractedTable } from "@/lib/conversion/types";

// The real vocabulary from config/column-map.json — this module hardcodes no column names.
const VOCAB = [
  /description/i,
  /height|length|^\s*[hl]\b/i,
  /width|^\s*w\b/i,
  /depth|^\s*d\b/i,
  /weight|\bwt\b/i,
  /quantity|\bqty\b/i,
  /material/i,
  /pallet/i,
  /\bstop\b|\bdrop\b/i,
];

const table = (headers: string[], rows: string[][]): ExtractedTable => ({ index: 0, headers, rows });

describe("normaliseTable", () => {
  it("leaves a well-formed table completely alone", () => {
    // The overwhelmingly common case, and the one this must never disturb.
    const t = table(
      ["#", "Item Description", "Material", "H", "W", "Qty", "Wt"],
      [["1", "Steel Beam", "Steel", "30", "120", "2", "48"]],
    );
    const out = normaliseTable(t, VOCAB);
    expect(out.headers).toEqual(t.headers);
    expect(out.rows).toEqual(t.rows);
    expect(out.caption).toBeUndefined();
    expect(out.headerless).toBeUndefined();
  });

  it("promotes the real header when a STOP banner has taken its place, and keeps the banner", () => {
    const t = table(
      ["STOP 1: Cardiff Bay Homeware Ltd", "", "", "123 Tresillian Way, Cardiff, CF10 5BF", "", "", ""],
      [
        ["#", "Item Description", "Material", "H", "W", "Qty", "Wt"],
        ["1", "Wine Glasses", "Borosilicate Glass", "30", "120", "200", "48"],
      ],
    );
    const out = normaliseTable(t, VOCAB);

    expect(out.headers).toEqual(["#", "Item Description", "Material", "H", "W", "Qty", "Wt"]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]![1]).toBe("Wine Glasses");
    // The banner is not junk — it is the ONLY place this sheet states the delivery address.
    expect(out.caption?.[0]).toMatch(/STOP 1/);
    expect(out.caption?.[0]).toMatch(/CF10 5BF/);
  });

  it("lifts in-body section banners out of the cargo, and remembers which rows each owns", () => {
    const t = table(
      ["Item", "Description", "Material", "Qty", "Weight (kg)"],
      [
        ["1", "Wine Glasses", "Glass", "2", "48"],
        ["STOP 2: Midlands Electrical", "", "", "", ""],
        ["45 Fort Parkway, Birmingham, B24 9FD, UK", "", "", "", ""],
        ["Item", "Description", "Material", "Qty", "Weight (kg)"], // the header, re-stated
        ["3", "Flat-Screen TV", "Glass", "2", "210"],
      ],
    );
    const out = normaliseTable(t, VOCAB);

    // The repeated header row must never be quoted as cargo.
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r[1])).toEqual(["Wine Glasses", "Flat-Screen TV"]);

    const section = out.sections?.[0];
    expect(section?.lines[0]).toMatch(/STOP 2/);
    expect(section?.lines[1]).toMatch(/B24 9FD/);
    expect(section?.startRow).toBe(1); // it introduces the TV, not the wine glasses
  });

  it("never mistakes a sparse CARGO row for a banner — deleting cargo is the worst outcome there is", () => {
    // A real item whose sizes were left blank. It opens with a line number; a banner opens with words.
    const t = table(
      ["#", "Item Description", "Material", "H", "W", "Qty", "Wt"],
      [["5", "Widget", "", "", "", "", ""]],
    );
    const out = normaliseTable(t, VOCAB);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]![1]).toBe("Widget");
    expect(out.sections).toBeUndefined();
  });

  it("never deletes a sparse cargo row when the FIRST column is the description, not a line number", () => {
    // Bug 0.5: isBannerRow assumed a genuine cargo line opens with a line number. On a manifest with no
    // "#" column at all, a sparse item like "| Wine Glasses | | | | 200 |" opens with words — exactly
    // what a banner does — and was silently deleted instead of being kept as cargo. The fix requires
    // POSITIVE evidence (a filled cell under a real cargo column) before demoting a row to a banner.
    const t = table(
      ["Item Description", "Material", "H", "W", "Qty"],
      [["Wine Glasses", "", "", "", "200"]],
    );
    const out = normaliseTable(t, VOCAB);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]![0]).toBe("Wine Glasses");
    expect(out.rows[0]![4]).toBe("200");
    expect(out.sections).toBeUndefined();
  });

  it("never mistakes an in-body STOP banner for cargo just because the description column matches it", () => {
    // Bug 1 (regression from the previous fix): "Item Description" matches the /description/ vocab
    // pattern, so a banner's free text sitting in cell 0 under that header would count as "cargo
    // evidence" on a pure text match — meaning the banner is loaded as cargo and the stop's address,
    // the only place this sheet states it, is silently lost. Evidence must be a NUMERIC value, not
    // merely a non-blank cell under a cargo-vocabulary column.
    const t = table(
      ["Item Description", "Material", "H", "W", "Qty"],
      [
        ["Wine Glasses", "Glass", "30", "120", "200"],
        ["STOP 2: Midlands Electrical", "", "", "", ""],
        ["45 Fort Parkway, Birmingham, B24 9FD, UK", "", "", "", ""],
      ],
    );
    const out = normaliseTable(t, VOCAB);

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]![0]).toBe("Wine Glasses");
    const section = out.sections?.[0];
    expect(section?.lines[0]).toMatch(/STOP 2/);
    expect(section?.lines[1]).toMatch(/B24 9FD/);
  });

  it("clears `headerless` once the real header has been recovered from the body", () => {
    // Bug 2: markdown-table.parser.ts marks a table `headerless: true` when its '|---|' separator was
    // lost, promising table-normaliser will recover the real header out of the body. But the promotion
    // branch used to spread `...table` straight through, carrying `headerless: true` along even after
    // a header WAS found — so table-selector.ts rejected a table this function had just repaired, and
    // its cargo was never packed. Once a header is proven (promoted out of the body), the flag must
    // clear.
    const t: ExtractedTable = {
      index: 0,
      headers: [],
      headerless: true,
      rows: [
        ["#", "Item Description", "Material", "H", "W", "Qty", "Wt"],
        ["1", "Steel Beam", "Steel", "30", "120", "2", "48"],
      ],
    };
    const out = normaliseTable(t, VOCAB);

    expect(out.headerless).toBeUndefined();
    expect(out.headers).toEqual(["#", "Item Description", "Material", "H", "W", "Qty", "Wt"]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]![1]).toBe("Steel Beam");
  });

  it("marks a table HEADERLESS rather than let anyone read its columns by position", () => {
    // The scan lost the header entirely (it can come back as a plain text line above the table). No
    // column's meaning is known. Guessing by position is exactly what produced the 760-tonne quote.
    const t = table(
      ["1", "1", "Pallet of Wine Glasses", "Borosilicate Glass", "2,800 pcs", "30", "672"],
      [["1", "2", "Clothing Bale", "Cotton", "14 bales", "80", "700"]],
    );
    const out = normaliseTable(t, VOCAB);
    expect(out.headerless).toBe(true);
  });

  it("does nothing at all when no vocabulary is injected — no opinion, no change", () => {
    // The groupage roster reader deliberately opts out; it does its own row-continuation merging.
    const t = table(["STOP 1: Somewhere"], [["#", "Item Description"]]);
    expect(normaliseTable(t, [])).toBe(t);
  });
});
