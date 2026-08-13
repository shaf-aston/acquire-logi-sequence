/** Quote-level shared-truck grouping — who shares a vehicle with whom. */
import { describe, it, expect } from "vitest";
import { groupConsignments, type Consignment, type GroupingConfig } from "../truck-grouping";
import { mergeSessionHubs } from "../hub.repository";
import { widenCollectionHubCatchment, type ManifestHub } from "../manifest-hub-reader";
import type { Hub } from "../groupage.types";
import type { GroupageRates } from "../groupage-rates";

const HUBS: Hub[] = [
  { id: "hub-mid", name: "Birmingham", catchment: ["CV", "B", "LE"] },
  { id: "hub-scot", name: "Glasgow", catchment: ["EH", "G"] },
];

const RATES: GroupageRates = {
  footprintUnits: { full: 1, half: 0.5, quarter: 0.25, oversize: 2 },
  legCapacity: {
    collect: { palletSpaces: 10, maxPayloadKg: 3500 },
    trunk: { palletSpaces: 26, maxPayloadKg: 24000 },
    deliver: { palletSpaces: 10, maxPayloadKg: 3500 },
  },
  legVehicle: { collect: "luton-tail-lift", trunk: "curtainsider-truck", deliver: "luton-tail-lift" },
  ratePerFootprint: { default: 45, zones: {} },
  firstMileSurcharge: 25,
  lastMileSurcharge: 25,
  perTrunkStopFee: 0,
  heavyPallet: { thresholdKgPerFootprint: 700, surchargePerPallet: 40 },
  maxPalletWeightKg: 1500,
  enforcePerPalletCeiling: false,
  enforceLegCapacity: false,
  chargeableSpaceBasis: "weight-adjusted",
  maxPlausibleDerivedPalletKg: 2500,
};

const CFG: GroupingConfig = { maxTrunkHops: 2, maxPalletsPerBooking: 100, defaultRouting: "via-hub" };

const consignment = (company: string, origin: string, dest: string, qty: number): Consignment => ({
  company,
  originPostcode: origin,
  destinationPostcode: dest,
  pallets: [{ footprint: "full", weightKg: 500, quantity: qty }],
});

describe("groupConsignments", () => {
  it("puts two consignments on the same hub-pair onto ONE shared truck", () => {
    const trucks = groupConsignments(
      [consignment("Acme", "CV1 2AB", "EH1 1AA", 3), consignment("Beta", "B15 2TT", "G1 1AA", 4)],
      HUBS,
      RATES,
      CFG,
    );
    expect(trucks).toHaveLength(1);
    expect(trucks[0]!.legKind).toBe("trunk");
    expect(trucks[0]!.members.map((m) => m.company)).toEqual(["Acme", "Beta"]);
    expect(trucks[0]!.usedFootprints).toBe(7);
    expect(trucks[0]!.vehicleId).toBe("curtainsider-truck");
    expect(trucks[0]!.fits).toBe(true);
    expect(trucks[0]!.overBy).toBeNull();
  });

  it("keeps consignments on different hub-pairs as separate trucks", () => {
    const trucks = groupConsignments(
      [consignment("Acme", "CV1 2AB", "EH1 1AA", 2), consignment("Gamma", "EH1 1AA", "CV1 2AB", 2)],
      HUBS,
      RATES,
      CFG,
    );
    expect(trucks).toHaveLength(2);
    expect(trucks[0]!.legKey).not.toBe(trucks[1]!.legKey);
  });

  it("splits an over-capacity group across trucks so each one fits (space-bound)", () => {
    // 20 + 20 = 40 pallets > 26 spaces, but 20×500 + 20×500 = 20000 kg < 24000 → space is the limit.
    const trucks = groupConsignments(
      [consignment("Acme", "CV1 2AB", "EH1 1AA", 20), consignment("Beta", "B15 2TT", "G1 1AA", 20)],
      HUBS,
      RATES,
      CFG,
    );
    expect(trucks).toHaveLength(2);
    expect(trucks.every((t) => t.fits)).toBe(true);
    expect(trucks.every((t) => t.overBy === null)).toBe(true);
    expect(trucks.map((t) => t.splitCount)).toEqual([2, 2]);
    expect(trucks.map((t) => t.splitIndex)).toEqual([1, 2]);
    // Pallet-level packing fills the first truck (26 spaces) then spills the rest — fewest trucks.
    expect(trucks.map((t) => t.usedFootprints)).toEqual([26, 14]);
    // Same leg, but unique keys so the UI/edit-map never collide.
    expect(trucks[0]!.legKey).not.toBe(trucks[1]!.legKey);
    expect(trucks.every((t) => t.legKind === "trunk")).toBe(true);
  });

  it("splits by WEIGHT when weight is the binding limit (spaces would otherwise fit)", () => {
    const heavy = (co: string, o: string, d: string, qty: number, kg: number): Consignment => ({
      company: co,
      originPostcode: o,
      destinationPostcode: d,
      pallets: [{ footprint: "full", weightKg: kg, quantity: qty }],
    });
    // 10 + 10 = 20 spaces < 26 (fits on space), but 15000 + 15000 = 30000 kg > 24000 → weight-bound.
    const trucks = groupConsignments(
      [heavy("Acme", "CV1 2AB", "EH1 1AA", 10, 1500), heavy("Beta", "B15 2TT", "G1 1AA", 10, 1500)],
      HUBS,
      RATES,
      CFG,
    );
    expect(trucks).toHaveLength(2);
    expect(trucks.every((t) => t.fits)).toBe(true);
    expect(trucks.every((t) => t.usedWeightKg <= 24000)).toBe(true);
  });

  it("splits ONE high-volume company's identical pallets across trucks (pallets are divisible)", () => {
    // 30 full pallets @500 kg > 26 spaces. The pallets are discrete and interchangeable, so they
    // spread 26 + 4 across two trucks that each fit — not "flagged forever" for being one company.
    const trucks = groupConsignments(
      [consignment("Acme", "CV1 2AB", "EH1 1AA", 30)],
      HUBS,
      RATES,
      CFG,
    );
    expect(trucks).toHaveLength(2);
    expect(trucks.every((t) => t.fits)).toBe(true);
    expect(trucks.map((t) => t.usedFootprints)).toEqual([26, 4]);
    expect(trucks.map((t) => t.splitCount)).toEqual([2, 2]);
    // Every truck still carries the one company (same firm, split load).
    expect(trucks.every((t) => t.members.map((m) => m.company).join() === "Acme")).toBe(true);
    // Total pallets are conserved across the split — none dropped, none invented.
    expect(trucks.reduce((n, t) => n + t.members[0]!.pallets[0]!.quantity, 0)).toBe(30);
  });

  it("keeps a single INDIVISIBLE pallet on its own FLAGGED truck (one pallet too heavy to split)", () => {
    // One pallet at 25 t alone exceeds the 24 t payload — no algorithm can halve a single pallet,
    // so it stays on its own over-capacity truck, surfaced for the operator, never silently dropped.
    const trucks = groupConsignments(
      [{ company: "Acme", originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 25000, quantity: 1 }] }],
      HUBS,
      RATES,
      CFG,
    );
    expect(trucks).toHaveLength(1);
    expect(trucks[0]!.fits).toBe(false);
    expect(trucks[0]!.overBy!.weightKg).toBe(1000);
    expect(trucks[0]!.splitCount).toBe(1);
  });

  it("handles a HIGH-VOLUME multi-company run (simple5-scale) — splits into fitting trucks, no pallet lost", () => {
    // simple5 at its real volume: Colwick 12, Netherfield 40, Carlton 15, Gedling 10 = 77 pallets,
    // all on the same trunk (fixture areas map origins→hub-mid, dests→hub-scot). 77 > 26 spaces, so
    // it must span ceil(77/26)=3 trucks that each fit.
    const trucks = groupConsignments(
      [
        consignment("Colwick", "CV1 2AB", "EH1 1AA", 12),
        consignment("Netherfield", "B15 2TT", "G1 1AA", 40),
        consignment("Carlton", "LE1 1AA", "EH2 2BB", 15),
        consignment("Gedling", "CV2 3CC", "G2 2BB", 10),
      ],
      HUBS,
      RATES,
      CFG,
    );
    expect(trucks).toHaveLength(3);
    expect(trucks.every((t) => t.fits)).toBe(true);
    expect(trucks.every((t) => t.usedFootprints <= 26)).toBe(true);
    expect(trucks.map((t) => t.splitCount)).toEqual([3, 3, 3]);
    // Every one of the 77 pallets lands on exactly one truck — none dropped, none duplicated.
    const totalPallets = trucks.reduce(
      (n, t) => n + t.members.reduce((mn, m) => mn + m.pallets.reduce((pn, p) => pn + p.quantity, 0), 0),
      0,
    );
    expect(totalPallets).toBe(77);
  });

  it("does NOT split when autoSplitOverCapacity is off — flags one truck (old behaviour)", () => {
    const trucks = groupConsignments(
      [consignment("Acme", "CV1 2AB", "EH1 1AA", 20), consignment("Beta", "B15 2TT", "G1 1AA", 20)],
      HUBS,
      RATES,
      { ...CFG, autoSplitOverCapacity: false },
    );
    expect(trucks).toHaveLength(1);
    expect(trucks[0]!.usedFootprints).toBe(40);
    expect(trucks[0]!.fits).toBe(false);
    expect(trucks[0]!.overBy!.footprints).toBe(14);
  });
});

/**
 * Regression for the real bug: a groupage manifest (simple4_groupage_multicompany.pdf) collects 4
 * companies from HD/HX/WF into ONE Huddersfield hub, yet the plan split them across two trucks. Cause:
 * the manifest's collection hub only claimed its own area (HD), so Elland (HX) and Mirfield (WF) fell
 * to the saved Leeds hub and formed a second truck. Widening the collection hub to cover every origin
 * area (the fix) must put all four on ONE truck.
 */
describe("collection-run manifest — all companies share one truck once the hub is widened", () => {
  // Mirrors config/hubs.json: Leeds owns HD/HX/WF, Nottingham owns NG.
  const BASE: Hub[] = [
    { id: "hub-leeds", name: "Leeds", catchment: ["LS", "BD", "HD", "HX", "WF", "YO"] },
    { id: "hub-nottingham", name: "Nottingham", catchment: ["NG", "DE", "LE"] },
  ];
  // The two hubs read off the manifest (collection = Huddersfield HD1, destination = Nottingham NG4).
  const MANIFEST_HUBS: ManifestHub[] = [
    { id: "hub-huddersfield", name: "Huddersfield Consolidation Centre", catchment: ["HD"], role: "collection", postcode: "HD1 6EJ" },
    { id: "hub-nottingham-dist", name: "Nottingham Distribution Hub", catchment: ["NG"], role: "destination", postcode: "NG4 2JT" },
  ];
  const ORIGINS = ["HD6 1UB", "HX5 9HT", "HD1 6PQ", "WF14 8HE"]; // Brighouse, Elland, Huddersfield, Mirfield

  const roster: Consignment[] = [
    consignment("Brighouse Textile", "HD6 1UB", "NG4 2JT", 3),
    consignment("Elland Metal Pressings", "HX5 9HT", "NG4 2JT", 4),
    consignment("Huddersfield Pharma", "HD1 6PQ", "NG4 2JT", 2),
    consignment("Mirfield Joinery", "WF14 8HE", "NG4 2JT", 3),
  ];

  it("BEFORE the fix (HD-only collection hub) the load splits into two trucks", () => {
    const network = mergeSessionHubs(BASE, MANIFEST_HUBS); // HD only on the collection hub
    const trucks = groupConsignments(roster, network, RATES, CFG);
    expect(trucks.length).toBe(2); // HX + WF fall to Leeds → a second truck
  });

  it("AFTER the fix (widened collection hub) all four ride one truck", () => {
    const widened = widenCollectionHubCatchment(MANIFEST_HUBS, ORIGINS);
    expect(widened[0]!.catchment).toEqual(["HD", "HX", "WF"]);

    const network = mergeSessionHubs(BASE, widened);
    const trucks = groupConsignments(roster, network, RATES, CFG);

    expect(trucks).toHaveLength(1);
    expect(trucks[0]!.legKind).toBe("trunk");
    expect(trucks[0]!.members.map((m) => m.company)).toEqual([
      "Brighouse Textile",
      "Elland Metal Pressings",
      "Huddersfield Pharma",
      "Mirfield Joinery",
    ]);
    expect(trucks[0]!.usedFootprints).toBe(12); // 3 + 4 + 2 + 3 pallets
    expect(trucks[0]!.fits).toBe(true); // 12 of 26 spaces
  });
});
