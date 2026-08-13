/** Pallet-stacker — adapts a shared truck's pallets to the packer and maps placements to companies. */
import { describe, it, expect } from "vitest";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { stackTruck, type PalletStackSpec } from "@/lib/packing/pallet-stacker";
import type { SharedTruck, TruckMember } from "@/lib/groupage/truck-grouping";
import type { GroupagePallet } from "@/lib/groupage/groupage.types";
import { makeVan } from "./fixtures";

const packer = new HeuristicPacker({ toleranceM: 0.005 });

const SPEC: PalletStackSpec = {
  footprintClasses: {
    full: { lengthMm: 1200, widthMm: 1000, loadedHeightMm: 1200, stackable: true },
    half: { lengthMm: 1200, widthMm: 500, loadedHeightMm: 1200, stackable: true },
    quarter: { lengthMm: 600, widthMm: 500, loadedHeightMm: 1000, stackable: true },
    oversize: { lengthMm: 2400, widthMm: 1000, loadedHeightMm: 1400, stackable: false },
  },
  stacking: { canSupportWeightKg: 1500, maxStackPressureKpa: 200 },
};

const member = (company: string, pallets: GroupagePallet[], origin = "CV1 2AB"): TruckMember => ({
  company,
  originPostcode: origin,
  destinationPostcode: "EH1 1AA",
  pallets,
  demand: { footprints: 0, weightKg: 0, palletCount: 0 }, // unused by stackTruck
});

const truck = (members: TruckMember[]): SharedTruck => ({
  legKey: "trunk:hub-mid>hub-scot",
  legKind: "trunk",
  from: "Birmingham",
  to: "Glasgow",
  capacity: { palletSpaces: 26, maxPayloadKg: 24000 },
  vehicleId: "curtainsider-truck",
  members,
  usedFootprints: 0,
  usedWeightKg: 0,
  fits: true,
  overBy: null,
  splitIndex: 1,
  splitCount: 1,
});

// Curtainsider-sized interior (7.5 × 2.44 × 2.5 m) — comfortably holds a handful of pallets.
const bigVan = () => makeVan({ id: "curtainsider-truck", interior: { l: 7.5, w: 2.44, h: 2.5 }, maxPayloadKg: 120000 });

describe("stackTruck", () => {
  it("places every pallet and tags each placement with its owning company", () => {
    const stacked = stackTruck(
      truck([
        member("Acme", [{ footprint: "full", weightKg: 400, quantity: 2 }]),
        member("Beta", [{ footprint: "half", weightKg: 300, quantity: 2 }]),
      ]),
      bigVan(),
      packer,
      SPEC,
    );

    expect(stacked.placements).toHaveLength(4);
    expect(stacked.unplaced).toHaveLength(0);
    expect(stacked.companyKeys).toHaveLength(stacked.placements.length);
    expect(new Set(stacked.companyLabels)).toEqual(new Set(["Acme", "Beta"]));
    expect(stacked.companies.map((c) => c.label)).toEqual(["Acme", "Beta"]);
  });

  it("collapses one company's several collection points into a single legend entry", () => {
    // Same firm, two pickups (different origins) → ONE company (one colour), both origins gathered.
    const stacked = stackTruck(
      truck([
        member("Acme", [{ footprint: "full", weightKg: 400, quantity: 1 }], "CV1 2AB"),
        member("Beta", [{ footprint: "half", weightKg: 300, quantity: 1 }], "B15 2TT"),
        member("Acme", [{ footprint: "full", weightKg: 400, quantity: 1 }], "LE1 1AA"),
      ]),
      bigVan(),
      packer,
      SPEC,
    );

    // Two distinct companies, not three members.
    expect(stacked.companies.map((c) => c.label)).toEqual(["Acme", "Beta"]);
    const acme = stacked.companies.find((c) => c.label === "Acme")!;
    expect(acme.origins).toEqual(["CV1 2AB", "LE1 1AA"]);
    // Every Acme pallet shares one company key/colour across both pickups.
    const acmeKeys = new Set(
      stacked.companyKeys.filter((_, i) => stacked.companyLabels[i] === "Acme"),
    );
    expect(acmeKeys.size).toBe(1);
    expect(stacked.placements).toHaveLength(3);
  });

  it("maps a footprint class to its real metres", () => {
    const stacked = stackTruck(
      truck([member("Acme", [{ footprint: "full", weightKg: 400, quantity: 1 }])]),
      bigVan(),
      packer,
      SPEC,
    );
    const p = stacked.placements[0]!;
    // full = 1.2 × 1.0 × 1.2 m (natural orientation l→x, w→y, h→z).
    expect(p.size.x).toBeCloseTo(1.2);
    expect(p.size.y).toBeCloseTo(1.0);
    expect(p.size.z).toBeCloseTo(1.2);
  });

  it("surfaces pallets that do not fit instead of dropping them", () => {
    // A one-pallet-footprint van: only a couple fit, the rest must surface as unplaced.
    const tiny = makeVan({ id: "tiny", interior: { l: 1.3, w: 1.1, h: 1.3 }, maxPayloadKg: 120000 });
    const stacked = stackTruck(
      truck([member("Acme", [{ footprint: "full", weightKg: 400, quantity: 5 }])]),
      tiny,
      packer,
      SPEC,
    );
    const surfaced = stacked.unplaced.reduce((n, u) => n + u.count, 0);
    expect(stacked.placements.length + surfaced).toBe(5);
    expect(surfaced).toBeGreaterThan(0);
    expect(stacked.unplaced[0]!.company).toBe("Acme");
    expect(stacked.unplaced[0]!.footprint).toBe("full");
  });
});
