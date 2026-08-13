/**
 * Bug 0.6/0.7 gate: `isItemTable` is the FIRST place a headerless table can be refused, and gating
 * here means every downstream reader that iterates `classification.items` never sees one of its rows
 * at all — no fixed-index column guess reaches the packer, the stop-attributor, or the address
 * detector's table reader.
 */
import { describe, it, expect } from "vitest";
import { isItemTable } from "@/lib/classification/table-selector";
import type { ExtractedTable } from "@/lib/conversion/types";
import type { FragilityRuleset } from "@/lib/classification/ruleset";

const RULES: FragilityRuleset = {
  version: 1,
  itemTableHeaderKeywords: ["description", "material", "height", "weight"],
  minHeaderMatches: 2,
  textColumnKeywords: ["description", "material"],
  overrides: [],
  fragileKeywords: [],
  standardKeywords: [],
  defaultWhenUnmatched: "standard",
};

describe("isItemTable — headerless gate", () => {
  it("accepts a normal, well-headed cargo table (baseline — unaffected by the gate)", () => {
    const table: ExtractedTable = {
      index: 0,
      headers: ["Item Description", "Material", "Height (cm)", "Weight (kg)"],
      rows: [["Steel Beam", "Steel", "45", "120"]],
    };
    expect(isItemTable(table, RULES)).toBe(true);
  });

  it("refuses a table flagged headerless, even though its (unproven) header text would otherwise match", () => {
    // The scan lost the real header row (see markdown-table.parser.ts / table-normaliser.ts). Whatever
    // text ended up in `headers` here — even keyword-rich text — proves nothing about column meaning,
    // so resolving columns against it would be exactly the position-guess `headerless` exists to forbid.
    const table: ExtractedTable = {
      index: 0,
      headers: ["Item Description", "Material", "Height (cm)", "Weight (kg)"],
      rows: [["Steel Beam", "Steel", "45", "120"]],
      headerless: true,
    };
    expect(isItemTable(table, RULES)).toBe(false);
  });

  it("refuses a headerless table with genuinely empty headers (the common case emitted by the parser)", () => {
    const table: ExtractedTable = {
      index: 0,
      headers: [],
      rows: [["Steel Beam", "Steel", "45", "120"]],
      headerless: true,
    };
    expect(isItemTable(table, RULES)).toBe(false);
  });
});
