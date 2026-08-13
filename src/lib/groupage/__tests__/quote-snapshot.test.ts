/**
 * REGRESSION LOCK for the multi-stop trunk work.
 *
 * Captures the *serialized* groupage quote — every key, every value, and the KEY ORDER — for the
 * three path kinds. Committed on pre-multi-stop code. A zero-stop quote must serialize
 * byte-for-byte identically after the change: no new keys, no reordered keys, no changed totals.
 * `JSON.stringify` is deliberate: an optional property spread in conditionally (`path.stops`,
 * `quote.legLoads`, `quote.oversizeLines`) is invisible here when absent, which is exactly the
 * contract being locked.
 *
 * Re-baselined once, deliberately, for the high-volume work: `fits` / `vehiclesNeeded` are now
 * always-present keys (a quote must state whether it fits and in how many vehicles). The values
 * these snapshots really guard are the TOTALS — unchanged, which is the proof that weight-adjusted
 * chargeable spaces bill a normal load exactly as the footprint basis always did.
 */
import { describe, it, expect } from "vitest";
import { getGroupageQuote, type GroupageDeps } from "../service";
import { InMemoryHubRepository } from "../hub.repository";
import type { GroupagePallet, Hub } from "../groupage.types";
import type { GroupageRates } from "../groupage-rates";

const HUBS: Hub[] = [
  { id: "hub-mid", name: "Birmingham", catchment: ["CV", "B", "LE"] },
  { id: "hub-nw", name: "Manchester", catchment: ["M", "OL"] },
  { id: "hub-scot", name: "Glasgow", catchment: ["EH", "G"] },
];

const RATES: GroupageRates = {
  footprintUnits: { full: 1, half: 0.5, quarter: 0.25, oversize: 2 },
  legCapacity: {
    collect: { palletSpaces: 10, maxPayloadKg: 3500 },
    trunk: { palletSpaces: 26, maxPayloadKg: 24000 },
    deliver: { palletSpaces: 10, maxPayloadKg: 3500 },
  },
  legVehicle: { collect: undefined, trunk: undefined, deliver: undefined },
  ratePerFootprint: { default: 45, zones: { "hub-mid>hub-scot": 55 } },
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

function deps(): GroupageDeps {
  return {
    hubs: new InMemoryHubRepository(HUBS),
    loadRates: async () => RATES,
    config: { maxTrunkHops: 2, maxPalletsPerBooking: 52, currencySymbol: "£", defaultRouting: "via-hub" },
  };
}

const PALLETS: GroupagePallet[] = [
  { footprint: "full", weightKg: 400, quantity: 2 },
  { footprint: "half", weightKg: 900, quantity: 1 },
];

describe("zero-stop quote serialization (regression lock)", () => {
  it("hub path (distinct hubs, one trunk leg)", async () => {
    const { quote } = await getGroupageQuote(
      { originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: PALLETS, routing: "via-hub", eta: "2026-07-20" },
      deps(),
    );
    expect(JSON.stringify(quote)).toMatchSnapshot();
  });

  it("local path (same hub, no trunk leg)", async () => {
    const { quote } = await getGroupageQuote(
      { originPostcode: "CV1 2AB", destinationPostcode: "B15 2TT", pallets: PALLETS, routing: "via-hub", eta: "2026-07-20" },
      deps(),
    );
    expect(JSON.stringify(quote)).toMatchSnapshot();
  });

  it("direct path (hubless)", async () => {
    const { quote } = await getGroupageQuote(
      { originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: PALLETS, routing: "direct", eta: "2026-07-20" },
      deps(),
    );
    expect(JSON.stringify(quote)).toMatchSnapshot();
  });
});
