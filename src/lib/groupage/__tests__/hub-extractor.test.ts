import { describe, it, expect } from "vitest";
import { extractHubCandidates } from "../hub-extractor";

describe("extractHubCandidates", () => {
  it("pulls one candidate hub per distinct postcode area", () => {
    const text = [
      "Cargo Express Depot Network",
      "Birmingham Hub, Unit 5 Trading Estate, B15 2TT",
      "Manchester Cross-Dock, M1 1AE",
      "Glasgow Terminal — G2 8DL",
    ].join("\n");
    const { candidates } = extractHubCandidates(text);
    expect(candidates.map((h) => h.catchment[0]).sort()).toEqual(["B", "G", "M"]);
    const brum = candidates.find((h) => h.catchment[0] === "B")!;
    expect(brum.name).toContain("Birmingham");
    expect(brum.id.startsWith("hub-")).toBe(true);
    expect(brum.warning).toBeUndefined();
  });

  it("keeps the first depot per area and surfaces the rest as duplicates (no silent drop)", () => {
    const text = "Head office notes\nB15 2TT first\nB1 1AA second same area\nNo postcode here";
    const { candidates, duplicates } = extractHubCandidates(text);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.catchment).toEqual(["B"]);
    expect(candidates[0]!.name).toContain("first");
    // The second B-area depot is not dropped silently — it comes back for manual review.
    expect(duplicates).toEqual([{ text: "B1 1AA second same area", area: "B" }]);
  });

  it("falls back to '<AREA> depot' and flags a warning when the line is just a postcode", () => {
    const { candidates } = extractHubCandidates("EH12 5BJ");
    expect(candidates[0]!.name).toBe("EH depot");
    expect(candidates[0]!.catchment).toEqual(["EH"]);
    expect(candidates[0]!.warning).toMatch(/rename/i);
  });

  it("returns no candidates and no duplicates for text with no postcodes", () => {
    expect(extractHubCandidates("just some prose\nno depots listed")).toEqual({
      candidates: [],
      duplicates: [],
    });
  });
});
