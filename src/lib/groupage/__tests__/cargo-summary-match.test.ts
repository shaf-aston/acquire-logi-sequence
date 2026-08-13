import { describe, expect, it } from "vitest";
import { matchCompany } from "@/lib/groupage/cargo-summary-weights";

/**
 * Company-name matching between the collection run (full name) and the cargo summary (often
 * abbreviated). The load-bearing property: an ABBREVIATION must match ("Gedling Building Mat." →
 * "Gedling Building Materials"), while a merely PREFIX-SHARING but different firm must NOT (else the
 * wrong company's weight is attached — a silent money bug). Guards the two-pass, exact-anchor design.
 */
describe("matchCompany", () => {
  it("matches an abbreviated trailing token (the real Gedling case)", () => {
    expect(matchCompany("Gedling Building Materials", ["Gedling Building Mat."])).toBe("Gedling Building Mat.");
  });

  it("still matches a short name that is an exact prefix of the full name", () => {
    // Netherfield Plastics ⊂ Netherfield Plastics Manufacturing; Huddersfield Pharma ⊂ …Packaging.
    expect(matchCompany("Netherfield Plastics Manufacturing", ["Netherfield Plastics"])).toBe("Netherfield Plastics");
    expect(matchCompany("Huddersfield Pharma Packaging", ["Huddersfield Pharma"])).toBe("Huddersfield Pharma");
  });

  it("does NOT let a lone-token key prefix-match a different first word (Van ≠ Vantage)", () => {
    // Reviewer finding #1: "Van Ltd" → ["van"] must not grab "Vantage Freight" via prefix.
    expect(matchCompany("Vantage Freight", ["Van Ltd"])).toBeNull();
    expect(matchCompany("Sunderland Steel", ["Sun Ltd"])).toBeNull();
    expect(matchCompany("Proctor Group", ["Pro Ltd"])).toBeNull();
  });

  it("prefers an EXACT-token match over an abbreviation match (no key stealing)", () => {
    // Reviewer finding #2: with both present, the exact superset wins regardless of order.
    const keys = ["Gedling Build", "Gedling Building Materials"];
    expect(matchCompany("Gedling Building Materials", keys)).toBe("Gedling Building Materials");
    expect(matchCompany("Gedling Building Materials", [...keys].reverse())).toBe("Gedling Building Materials");
  });

  it("does not match a genuinely different second token", () => {
    expect(matchCompany("Preston Building Supplies", ["Preston Bridge Co"])).toBeNull();
    expect(matchCompany("Huddersfield Joinery", ["Huddersfield Pharma"])).toBeNull();
  });
});
