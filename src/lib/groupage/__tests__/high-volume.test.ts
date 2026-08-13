/**
 * HIGH-VOLUME groupage — the `02-groupage/capacity-edge-cases/high-volume.pdf` manifest, end to end.
 *
 * The product rule is: TRUST THE QUOTATION. A manifest that states 61 tonnes across 15 pallets is a
 * bigger job, not a bad input. It must be quoted, priced for the vehicles it really consumes, and
 * flagged — never rejected by an internal ceiling. These tests lock all three, plus the two escapes
 * a business may want back (`enforceLegCapacity`, `chargeableSpaceBasis`).
 *
 * Figures are the real ones the collection-run parser derives from that document.
 */
import { describe, it, expect } from "vitest";
import { getGroupageQuote, type GroupageDeps } from "../service";
import { InMemoryHubRepository } from "../hub.repository";
import { chargeableFootprints } from "../pricing";
import { GroupageError, type GroupagePallet, type Hub } from "../groupage.types";
import type { GroupageRates } from "../groupage-rates";

const HUBS: Hub[] = [
  { id: "hub-em", name: "Nottingham", catchment: ["NG"] },
  { id: "hub-nw", name: "Manchester", catchment: ["M"] },
];

const RATES: GroupageRates = {
  footprintUnits: { full: 1, half: 0.5, quarter: 0.25, oversize: 2 },
  legCapacity: {
    collect: { palletSpaces: 10, maxPayloadKg: 3500 },
    trunk: { palletSpaces: 26, maxPayloadKg: 24_000 },
    deliver: { palletSpaces: 10, maxPayloadKg: 3500 },
  },
  legVehicle: { collect: undefined, trunk: undefined, deliver: undefined },
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

/** simple5's collection run: four companies, per-pallet weights as derived from the cargo summary. */
const SIMPLE5: GroupagePallet[] = [
  { footprint: "full", quantity: 2, weightKg: 1250 }, // Colwick
  { footprint: "full", quantity: 8, weightKg: 6390 }, // Netherfield — 51,120 kg over 8 pallets
  { footprint: "full", quantity: 2, weightKg: 720 }, // Carlton
  { footprint: "full", quantity: 3, weightKg: 2004 }, // Gedling
];
const TOTAL_KG = 61_072;
const TOTAL_PALLETS = 15;

function deps(rates: GroupageRates = RATES): GroupageDeps {
  return {
    hubs: new InMemoryHubRepository(HUBS),
    loadRates: async () => rates,
    config: { maxTrunkHops: 2, maxPalletsPerBooking: 52, currencySymbol: "£", defaultRouting: "via-hub" },
  };
}

const quoteSimple5 = (rates?: GroupageRates) =>
  getGroupageQuote(
    { originPostcode: "NG4 2JT", destinationPostcode: "M1 1AE", pallets: SIMPLE5, routing: "via-hub" },
    deps(rates),
  );

describe("simple5 high-volume manifest", () => {
  it("quotes the load instead of rejecting it, and states what it really needs", async () => {
    const { quote } = await quoteSimple5();

    // The document's own tonnage, trusted verbatim.
    expect(quote.demand.weightKg).toBe(TOTAL_KG);
    expect(quote.demand.palletCount).toBe(TOTAL_PALLETS);

    // It does not fit one set of vehicles — and says so, rather than throwing.
    expect(quote.fits).toBe(false);
    expect(quote.bindingLimit).toBe("weight");
    expect(quote.total).toBeGreaterThan(0);

    // The trunk needs ceil(61,072 / 24,000) = 3; the 3.5 t luton legs need ceil(61,072 / 3,500) = 18.
    // `vehiclesNeeded` is the WORST leg, because that is the number the operator must act on.
    const byKind = Object.fromEntries(quote.capacityChecks.map((c) => [c.leg.kind, c]));
    expect(byKind.trunk!.vehiclesNeeded).toBe(3);
    expect(byKind.collect!.vehiclesNeeded).toBe(18);
    expect(quote.vehiclesNeeded).toBe(18);
  });

  it("bills the truck the weight actually fills, not just the floor space it stands on", async () => {
    const { quote } = await quoteSimple5();
    const haul = quote.lineItems.find((li) => li.label.startsWith("Line-haul"))!;

    // 24,000 kg / 26 spaces = 923.08 kg per pallet-space → 61,072 kg ≈ 66.16 chargeable spaces.
    // On the old footprint-only basis this load bought ~2.5 trucks and paid for 15 spaces (£675).
    expect(haul.label).toContain("66.16 pallet-spaces, weight-adjusted from 15");
    expect(haul.amount).toBe(2977.2);

    // Every pallet is over 700 kg/footprint, so every pallet draws the heavy surcharge.
    expect(quote.surcharges).toBe(TOTAL_PALLETS * 40);
    expect(quote.total).toBe(2977.2 + 25 + 25 + 600);
  });

  it("flags the pallet NO number of vehicles can carry — the one overflow a vehicle count cannot answer", async () => {
    const { quote } = await quoteSimple5();

    // Netherfield's 6,390 kg pallet cannot ride a 3,500 kg luton, however many are booked. It fits
    // the 24 t trunk fine, so it must be flagged on the collect and deliver legs only.
    expect(quote.oversizeLines).toHaveLength(2);
    expect(quote.oversizeLines!.every((o) => o.lineNumber === 2 && o.reason === "weight")).toBe(true);
    expect(quote.oversizeLines!.map((o) => o.legKind).sort()).toEqual(["collect", "deliver"]);
    const [first] = quote.oversizeLines!;
    expect(first!.palletValue).toBe(6390);
    expect(first!.vehicleLimit).toBe(3500);
  });

  it("an ordinary booking keeps `fits: true`, one vehicle, and its old footprint-based price", async () => {
    const { quote } = await getGroupageQuote(
      {
        originPostcode: "NG4 2JT",
        destinationPostcode: "M1 1AE",
        pallets: [{ footprint: "full", quantity: 2, weightKg: 500 }],
        routing: "via-hub",
      },
      deps(),
    );
    expect(quote.fits).toBe(true);
    expect(quote.vehiclesNeeded).toBe(1);
    expect(quote.oversizeLines).toBeUndefined();
    // 1,000 kg ÷ 923.08 = 1.08 space-equivalents < 2 footprints, so weight never binds: 2 × £45.
    expect(quote.lineItems[0]!.label).toBe("Line-haul (2 pallet-spaces × £45/pallet-space)");
    expect(quote.lineItems[0]!.amount).toBe(90);
  });
});

describe("the two config escapes", () => {
  it("`enforceLegCapacity: true` reinstates the hard reject as a fat-finger guard", async () => {
    await expect(quoteSimple5({ ...RATES, enforceLegCapacity: true })).rejects.toThrow(GroupageError);
    await expect(quoteSimple5({ ...RATES, enforceLegCapacity: true })).rejects.toThrow(
      /needs at least 18 collect vehicles/,
    );
  });

  it("`chargeableSpaceBasis: 'footprints'` opts back out of the weight adjustment", async () => {
    const { quote } = await quoteSimple5({ ...RATES, chargeableSpaceBasis: "footprints" });
    expect(quote.lineItems[0]!.label).toBe("Line-haul (15 pallet-spaces × £45/pallet-space)");
    expect(quote.lineItems[0]!.amount).toBe(675);
    // Still quoted, still flagged: the basis is a PRICING knob, not a capacity one.
    expect(quote.fits).toBe(false);
  });

  it("chargeableFootprints never bills below the floor space consumed, and rises with weight", () => {
    const light = { footprints: 4, weightKg: 1000, palletCount: 4 };
    const heavy = { footprints: 4, weightKg: 40_000, palletCount: 4 };
    // A light load is space-bound: the weight adjustment is invisible, as it must be.
    expect(chargeableFootprints(light, RATES)).toBe(4);
    // Continuous, not a step function: 40,000 kg ÷ 923.08 kg/space = 43.33 spaces. Adding weight
    // adds spaces gradually — a load just over a truck's payload never jumps a whole truck's price.
    // Billable spaces are rounded to 2dp, so the smallest visible step is 0.01 space ≈ 9.2 kg.
    expect(chargeableFootprints(heavy, RATES)).toBe(43.33);
    expect(chargeableFootprints({ ...heavy, weightKg: 40_100 }, RATES)).toBeCloseTo(43.44, 2);
    // 24,001 kg — one kg past a full trunk — bills ~26 spaces, not 52.
    expect(chargeableFootprints({ footprints: 1, weightKg: 24_001, palletCount: 1 }, RATES)).toBeCloseTo(26, 1);
  });
});
