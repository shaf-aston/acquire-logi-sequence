/** Consignment-draft domain rules — the validation/transform logic lifted out of the planner UI. */
import { describe, it, expect } from "vitest";
import {
  companyKeyOf,
  consignmentKey,
  draftClean,
  draftReady,
  draftToConsignment,
  linesToPallets,
  recordToConsignment,
  rosterToDrafts,
  type ReadDraft,
} from "@/lib/groupage/consignment-draft";
import type { ReadConsignmentDraft } from "@/lib/groupage/consignment-reader.types";
import type { GroupageConsignmentRecord } from "@/lib/groupage/consignment.store";

const draft = (over: Partial<ReadDraft> = {}): ReadDraft => ({
  company: "Acme",
  originPostcode: "CV1 2AB",
  destinationPostcode: "EH1 1AA",
  lines: [{ footprint: "full", weightKg: "500", quantity: "2" }],
  review: [],
  ...over,
});

describe("draftReady", () => {
  it("is true when company + both postcodes + ≥1 weighed line are present", () => {
    expect(draftReady(draft())).toBe(true);
  });

  it("is false when any required field is missing", () => {
    expect(draftReady(draft({ company: "  " }))).toBe(false);
    expect(draftReady(draft({ originPostcode: "" }))).toBe(false);
    expect(draftReady(draft({ destinationPostcode: "" }))).toBe(false);
  });

  it("is false when every pallet line is still blank-weight (nothing to weigh)", () => {
    expect(draftReady(draft({ lines: [{ footprint: "full", weightKg: "", quantity: "1" }] }))).toBe(false);
  });
});

describe("draftClean", () => {
  it("is true only when the draft is ready AND has no flagged fields", () => {
    expect(draftClean(draft())).toBe(true);
  });

  it("REJECTS a ready draft that still carries a ⚠ flag — never auto-trust a reader's guess", () => {
    // This is the exact rule behind the 'over capacity' surprise: a filled-in-but-flagged weight
    // must stay in the confirm list, not get swept onto a truck just because the fields are non-empty.
    const flagged = draft({ review: ["pallets"] });
    expect(draftReady(flagged)).toBe(true);
    expect(draftClean(flagged)).toBe(false);
  });
});

describe("linesToPallets", () => {
  it("drops lines whose weight is still blank (unconfirmed) and keeps the weighed ones", () => {
    const pallets = linesToPallets([
      { footprint: "full", weightKg: "500", quantity: "2" },
      { footprint: "half", weightKg: "   ", quantity: "1" },
    ]);
    expect(pallets).toEqual([{ footprint: "full", weightKg: 500, quantity: 2 }]);
  });

  it("defaults a blank/zero quantity to 1", () => {
    expect(linesToPallets([{ footprint: "full", weightKg: "500", quantity: "" }])[0]!.quantity).toBe(1);
  });
});

describe("rosterToDrafts", () => {
  it("turns a reader's 0-weight guess into a BLANK weight so the operator must fill it in", () => {
    const roster: ReadConsignmentDraft[] = [
      {
        company: "Acme",
        originPostcode: "CV1 2AB",
        destinationPostcode: "EH1 1AA",
        pallets: [{ footprint: "full", weightKg: 0, quantity: 3 }],
        needsReview: ["pallets"],
      },
    ];
    const [d] = rosterToDrafts(roster);
    expect(d!.lines[0]!.weightKg).toBe("");
    expect(d!.review).toEqual(["pallets"]);
  });

  it("substitutes an empty line when the reader found no pallets, and coerces nullish fields", () => {
    const roster: ReadConsignmentDraft[] = [
      { company: null, originPostcode: null, destinationPostcode: null, pallets: [], needsReview: [] },
    ];
    const [d] = rosterToDrafts(roster);
    expect(d!.company).toBe("");
    expect(d!.lines).toHaveLength(1);
    expect(d!.lines[0]!.weightKg).toBe("");
  });
});

describe("draftToConsignment", () => {
  it("trims text fields and drops review/UI-only data", () => {
    const c = draftToConsignment(draft({ company: "  Acme  ", originPostcode: " CV1 2AB " }));
    expect(c.company).toBe("Acme");
    expect(c.originPostcode).toBe("CV1 2AB");
    expect(c).not.toHaveProperty("review");
    expect(c.pallets).toEqual([{ footprint: "full", weightKg: 500, quantity: 2 }]);
  });
});

describe("consignmentKey", () => {
  it("is case- and space-insensitive so a re-read matches its earlier read", () => {
    const a = consignmentKey({ company: "Acme", originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA" });
    const b = consignmentKey({ company: "  acme ", originPostcode: "cv1 2ab", destinationPostcode: " EH1 1AA" });
    expect(a).toBe(b);
  });

  it("distinguishes the same company on a different route", () => {
    const a = consignmentKey({ company: "Acme", originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA" });
    const b = consignmentKey({ company: "Acme", originPostcode: "CV1 2AB", destinationPostcode: "G1 1AA" });
    expect(a).not.toBe(b);
  });
});

describe("companyKeyOf", () => {
  it("extracts the company key before the '#' in a pallet itemId, else returns the whole id", () => {
    expect(companyKeyOf("acme#full-0")).toBe("acme");
    expect(companyKeyOf("no-hash")).toBe("no-hash");
  });
});

describe("recordToConsignment", () => {
  it("drops id/createdAt and clones the pallet array", () => {
    const rec: GroupageConsignmentRecord = {
      id: "r1",
      createdAt: "2026-01-01T00:00:00Z",
      company: "Acme",
      originPostcode: "CV1 2AB",
      destinationPostcode: "EH1 1AA",
      pallets: [{ footprint: "full", weightKg: 500, quantity: 2 }],
    };
    const c = recordToConsignment(rec);
    expect(c).not.toHaveProperty("id");
    expect(c.pallets).toEqual(rec.pallets);
    expect(c.pallets).not.toBe(rec.pallets);
  });
});
