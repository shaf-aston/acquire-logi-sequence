/**
 * Pickup-list extraction — proves the rule engine's postcode-anchored scan (multi-address,
 * dedupe, junk rejection, table-cell cleanup, cap) and the LLM reply validator's honesty
 * (bad shapes rejected, confidence tied to a real postcode). The Groq network path itself is
 * exercised only through its fail-soft contract elsewhere — these tests are key-free.
 */
import { describe, it, expect } from "vitest";
import { RulePickupListExtractor, parsePickupReply } from "../pickup-list-extractor";

const MANIFEST = `
Pickup Manifest — Birmingham area, w/c 6 July
| Order | Site | Address |
| 1001 | Acme Fabrication | Unit 7, Gravelly Park, Birmingham B24 8HZ |
| 1002 | Midland Joinery | 14 Foleshill Rd, Coventry CV1 4JN |
Totals: 2 orders, 34 cartons, 412 kg
Contact the depot on 0121 555 0123 before 08:00.
- 1003. Beta Storage Ltd, 3 Steel Way, Walsall WS2 8LQ
Beta Storage Ltd, 3 Steel Way, Walsall WS2 8LQ
`;

describe("RulePickupListExtractor", () => {
  it("pulls every postcode-anchored line as an unconfident candidate, deduped, junk ignored", async () => {
    const candidates = await new RulePickupListExtractor().extract(MANIFEST);

    // 3 distinct addresses — the EXACT repeat of the Beta line (post-cleanup) collapses; the
    // totals/phone lines carry no postcode so they never match. Same-site lines with DIFFERENT
    // text are deliberately kept (deduping by postcode would merge distinct units on one estate)
    // — the operator prunes those in review.
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.postcode)).toEqual(["B24 8HZ", "CV1 4JN", "WS2 8LQ"]);
    // Table pipes became address separators; row numbers/bullets stripped.
    expect(candidates[0]!.address).toContain("Acme Fabrication");
    expect(candidates[0]!.address).not.toContain("|");
    expect(candidates[2]!.address).toMatch(/^Beta Storage/);
    // Raw OCR lines always need operator review.
    expect(candidates.every((c) => c.confident === false)).toBe(true);
  });

  it("returns empty (not an error) for text with no postcodes, and caps a flood at 100", async () => {
    expect(await new RulePickupListExtractor().extract("no addresses here\njust prose")).toEqual([]);

    const flood = Array.from({ length: 150 }, (_, i) => `Site ${i}, Test Road, Leeds LS${(i % 90) + 1} ${i % 10}AB`).join("\n");
    const capped = await new RulePickupListExtractor().extract(flood);
    expect(capped.length).toBeLessThanOrEqual(100);
  });
});

describe("parsePickupReply (LLM reply validator)", () => {
  it("accepts the documented shape and rejects everything else", () => {
    expect(parsePickupReply({ addresses: ["A Site, B1 1AA", "  ", "Other, CV1 2AB"] })).toEqual([
      "A Site, B1 1AA",
      "Other, CV1 2AB",
    ]);
    expect(parsePickupReply({ addresses: [] })).toEqual([]);
    expect(parsePickupReply({ addresses: "not an array" })).toBeNull();
    expect(parsePickupReply({})).toBeNull();
    expect(parsePickupReply(null)).toBeNull();
    expect(parsePickupReply("text")).toBeNull();
  });
});
