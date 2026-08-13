import { describe, expect, it } from "vitest";
import { collapseHubJourneyToTrunk } from "@/lib/groupage/hub-consolidation";
import type { ConsignmentRoster, ReadConsignmentDraft } from "@/lib/groupage/consignment-reader.types";
import type { PalletFootprintClass } from "@/lib/groupage/groupage.types";

/**
 * The hub-consolidation collapse: a collect→hub→trunk→deliver manifest is read as BOTH
 * legs (same load twice); we collapse it to the single trunk load. A normal roster
 * (every consignment two-sided) must pass through untouched.
 */

const collect = (company: string, origin: string, pallets: number, footprint: PalletFootprintClass = "full"): ReadConsignmentDraft => ({
  company,
  originPostcode: origin,
  destinationPostcode: null,
  pallets: [{ footprint, weightKg: 0, quantity: pallets }],
  needsReview: ["destinationPostcode"],
});

const deliver = (company: string, dest: string, pallets: number, footprint: PalletFootprintClass = "full"): ReadConsignmentDraft => ({
  company,
  originPostcode: null,
  destinationPostcode: dest,
  pallets: [{ footprint, weightKg: 0, quantity: pallets }],
  needsReview: ["originPostcode"],
});

const doorToDoor = (company: string, origin: string, dest: string, pallets: number): ReadConsignmentDraft => ({
  company,
  originPostcode: origin,
  destinationPostcode: dest,
  pallets: [{ footprint: "full", weightKg: 100, quantity: pallets }],
  needsReview: [],
});

const roster = (...consignments: ReadConsignmentDraft[]): ConsignmentRoster => ({ consignments });

describe("collapseHubJourneyToTrunk — hub consolidation manifest", () => {
  it("collapses collect+deliver legs (equal totals) to ONE trunk load of the consolidated pallets", () => {
    // 5 collections = 20 pallets, 6 deliveries = 20 pallets (the SwiftHaul shape).
    const r = roster(
      collect("Salford", "M5 4QH", 6),
      collect("Pennine", "OL11 1EX", 2),
      collect("Cheshire", "CH1 4QX", 1),
      collect("Trafford", "M17 1JT", 8),
      collect("Wigan", "WN3 4XW", 3),
      deliver("Solent", "SO15 1AA", 5),
      deliver("Wessex", "SO23 7RX", 3),
      deliver("Portsmouth", "PO3 5JZ", 1),
      deliver("New Forest", "BH24 3SB", 4),
      deliver("Basingstoke", "RG21 6XG", 3),
      deliver("Test Valley", "SP10 3FG", 4),
    );
    const { roster: out, collapse } = collapseHubJourneyToTrunk(r);
    expect(collapse.collapsed).toBe(true);
    expect(out.consignments).toHaveLength(1);
    const trunk = out.consignments[0]!;
    expect(trunk.company).toBe("Consolidated trunk load");
    // The truck carries 20, not 40.
    expect(trunk.pallets.reduce((n, p) => n + p.quantity, 0)).toBe(20);
    // Hub postcodes are never guessed — blank and flagged for the operator.
    expect(trunk.originPostcode).toBeNull();
    expect(trunk.destinationPostcode).toBeNull();
    expect(trunk.needsReview).toEqual(["originPostcode", "destinationPostcode"]);
  });

  it("aggregates the collection leg's pallet lines by footprint class", () => {
    const r = roster(
      collect("A", "M1 1AA", 4, "full"),
      collect("B", "M2 2BB", 2, "half"),
      deliver("C", "S1 1AA", 4, "full"),
      deliver("D", "S2 2BB", 2, "half"),
    );
    const { roster: out, collapse } = collapseHubJourneyToTrunk(r);
    expect(collapse.collapsed).toBe(true);
    const byClass = Object.fromEntries(out.consignments[0]!.pallets.map((p) => [p.footprint, p.quantity]));
    expect(byClass).toEqual({ full: 4, half: 2 });
  });
});

describe("collapseHubJourneyToTrunk — no-op cases (fail safe)", () => {
  it("leaves a normal door-to-door roster untouched", () => {
    const r = roster(doorToDoor("Acme", "CV1 2AB", "EH1 1AA", 3), doorToDoor("Beta", "B1 1AA", "M1 1AE", 2));
    const { roster: out, collapse } = collapseHubJourneyToTrunk(r);
    expect(collapse.collapsed).toBe(false);
    expect(out).toBe(r);
  });

  it("does NOT collapse when the two legs' pallet totals disagree (ambiguous — never invent a load)", () => {
    const r = roster(collect("A", "M1 1AA", 10), deliver("B", "S1 1AA", 7));
    const { collapse } = collapseHubJourneyToTrunk(r);
    expect(collapse.collapsed).toBe(false);
  });

  it("does NOT collapse a single-leg roster (only collections, no deliveries)", () => {
    const r = roster(collect("A", "M1 1AA", 5), collect("B", "M2 2BB", 5));
    const { collapse } = collapseHubJourneyToTrunk(r);
    expect(collapse.collapsed).toBe(false);
  });

  it("does NOT collapse when a consignment is two-sided (not a clean leg split)", () => {
    const r = roster(collect("A", "M1 1AA", 5), deliver("B", "S1 1AA", 5), doorToDoor("C", "L1 1AA", "N1 1AA", 3));
    const { collapse } = collapseHubJourneyToTrunk(r);
    expect(collapse.collapsed).toBe(false);
  });
});
