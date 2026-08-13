import { describe, expect, it } from "vitest";
import { parseReply, cleanPostcode } from "@/lib/groupage/groq-consignment-reader";
import { RuleConsignmentReader } from "@/lib/groupage/rule-consignment-reader";
import { GroqConsignmentReader } from "@/lib/groupage/groq-consignment-reader";
import type { StructuredDocument } from "@/lib/conversion/types";

/**
 * Covers the roster reader's never-guess normalisation: both document shapes (a single-company
 * quote → a roster of one, and a combined manifest → a roster of N), plus malformed / empty
 * replies. The fail-soft engines (rule + groq-without-key) must degrade to an empty roster.
 */

const emptyDoc: StructuredDocument = { pageCount: 0, tableCount: 0, pages: [] };

describe("cleanPostcode", () => {
  it("pulls a UK postcode out of a full address and standardises the spacing", () => {
    expect(cleanPostcode("Unit 4, Some Estate, Coventry CV12AB")).toBe("CV1 2AB");
    expect(cleanPostcode("eh1 1aa")).toBe("EH1 1AA");
    expect(cleanPostcode("EC1A1BB")).toBe("EC1A 1BB");
  });
  it("returns null for blank / non-string input", () => {
    expect(cleanPostcode("")).toBeNull();
    expect(cleanPostcode(null)).toBeNull();
    expect(cleanPostcode(42)).toBeNull();
  });
  it("keeps a non-postcode string verbatim (flagged for review upstream, never dropped)", () => {
    expect(cleanPostcode("ask the customer")).toBe("ask the customer");
  });
});

describe("parseReply — single company quote (roster of one)", () => {
  it("normalises one clean consignment with no review flags", () => {
    const roster = parseReply({
      consignments: [
        { company: "Acme Ltd", originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 250, quantity: 2 }] },
      ],
    });
    expect(roster).not.toBeNull();
    expect(roster!.consignments).toHaveLength(1);
    const c = roster!.consignments[0]!;
    expect(c.company).toBe("Acme Ltd");
    expect(c.originPostcode).toBe("CV1 2AB");
    expect(c.pallets).toEqual([{ footprint: "full", weightKg: 250, quantity: 2 }]);
    expect(c.needsReview).toEqual([]);
  });
});

describe("parseReply — combined manifest (roster of N)", () => {
  it("returns every distinct company the model found", () => {
    const roster = parseReply({
      consignments: [
        { company: "Acme Ltd", originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 250, quantity: 1 }] },
        { company: "Beta Co", originPostcode: "B1 1AA", destinationPostcode: "M1 1AE", pallets: [{ footprint: "half", weightKg: 120, quantity: 3 }] },
      ],
    });
    expect(roster!.consignments.map((c) => c.company)).toEqual(["Acme Ltd", "Beta Co"]);
  });
});

describe("parseReply — never-guess flagging", () => {
  it("flags a missing company, an unparseable postcode, and defaults an unknown footprint", () => {
    const roster = parseReply({
      consignments: [
        { company: null, originPostcode: "not a postcode", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "banana", weightKg: 100, quantity: 1 }] },
      ],
    });
    const c = roster!.consignments[0]!;
    expect(c.company).toBeNull();
    expect(c.needsReview).toContain("company");
    expect(c.needsReview).toContain("originPostcode");
    expect(c.needsReview).not.toContain("destinationPostcode");
    // Unknown footprint falls back to "full" rather than being invented or dropped.
    expect(c.pallets[0]!.footprint).toBe("full");
  });

  it("flags pallets when a line is dropped or none survive, and normalises bad numbers", () => {
    const roster = parseReply({
      consignments: [
        {
          company: "Acme",
          originPostcode: "CV1 2AB",
          destinationPostcode: "EH1 1AA",
          pallets: [
            "garbage", // not an object → dropped
            { footprint: "full", weightKg: -5, quantity: 0 }, // bad numbers → weight 0, qty 1
          ],
        },
      ],
    });
    const c = roster!.consignments[0]!;
    expect(c.needsReview).toContain("pallets"); // a line was dropped
    expect(c.pallets).toHaveLength(1);
    expect(c.pallets[0]).toEqual({ footprint: "full", weightKg: 0, quantity: 1 });
  });
});

describe("parseReply — malformed / empty", () => {
  it("skips a fully-empty phantom row rather than surfacing a blank consignment", () => {
    const roster = parseReply({
      consignments: [
        { company: null, originPostcode: null, destinationPostcode: null, pallets: [] },
        { company: "Real Co", originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 200, quantity: 1 }] },
      ],
    });
    expect(roster!.consignments).toHaveLength(1);
    expect(roster!.consignments[0]!.company).toBe("Real Co");
  });

  it("returns an empty roster for a missing consignments array", () => {
    expect(parseReply({})!.consignments).toEqual([]);
  });

  it("returns null only when the top-level shape is unusable", () => {
    expect(parseReply({ consignments: "nope" } as never)).toBeNull();
  });
});

describe("fail-soft engines degrade to an empty roster", () => {
  it("RuleConsignmentReader returns empty when there's no collection-run table (no key, no network)", async () => {
    // The rule reader now parses a structured collection-run table offline, but a doc
    // with no such table (and no fallback) still yields an empty roster — never a guess.
    const roster = await new RuleConsignmentReader().read(emptyDoc);
    expect(roster.consignments).toEqual([]);
  });

  it("GroqConsignmentReader returns an empty roster when no key is configured", async () => {
    // With no CONSIGNMENT_GROQ_API_KEY set, read() short-circuits before any network call.
    const roster = await new GroqConsignmentReader().read(emptyDoc);
    expect(roster.consignments).toEqual([]);
  });
});
