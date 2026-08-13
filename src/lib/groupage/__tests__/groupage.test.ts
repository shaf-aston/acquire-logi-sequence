import { describe, it, expect } from "vitest";
import { postcodeArea, resolveHub, resolveHubOrNull } from "../hub-resolver";
import { buildPath, buildDirectPath } from "../path-builder";
import { computeDemand } from "../demand";
import { checkLeg, checkPath, assertPathFits } from "../capacity";
import { priceGroupage, heavyPalletCount, zoneRate } from "../pricing";
import { parseHubsFrom } from "../hub.repository";
import { parseGroupageRates } from "../groupage-rates";
import { getGroupageQuote, type GroupageDeps } from "../service";
import { InMemoryHubRepository } from "../hub.repository";
import { parseGroupageQuoteInput, parseExpectedTotal, readJsonBody } from "../parse";
import { GroupageError, type GroupagePallet, type Hub } from "../groupage.types";
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

describe("postcodeArea", () => {
  it("extracts the area prefix from varied postcodes", () => {
    expect(postcodeArea("CV1 2AB")).toBe("CV");
    expect(postcodeArea("b15 2tt")).toBe("B");
    expect(postcodeArea("EH12 5BJ")).toBe("EH");
    expect(postcodeArea(" wc1a 1aa ")).toBe("WC");
  });
  it("fails loud on a non-postcode", () => {
    expect(() => postcodeArea("hello")).toThrow(GroupageError);
    expect(() => postcodeArea("")).toThrow(/recognisable UK postcode/);
  });
});

describe("resolveHub", () => {
  it("maps a postcode to its catchment hub", () => {
    expect(resolveHub("CV1 2AB", HUBS).id).toBe("hub-mid");
    expect(resolveHub("EH1 1AA", HUBS).id).toBe("hub-scot");
  });
  it("fails loud on a catchment gap", () => {
    expect(() => resolveHub("M1 1AA", HUBS)).toThrow(/No hub covers postcode area "M"/);
  });
});

describe("resolveHubOrNull (soft — for direct/hubless routing)", () => {
  it("returns the hub on a hit", () => {
    expect(resolveHubOrNull("CV1 2AB", HUBS)?.id).toBe("hub-mid");
  });
  it("returns null on a catchment gap (no throw)", () => {
    expect(resolveHubOrNull("M1 1AA", HUBS)).toBeNull();
  });
  it("still fails loud on a non-postcode", () => {
    expect(() => resolveHubOrNull("hello", HUBS)).toThrow(GroupageError);
  });
});

describe("buildDirectPath (hubless)", () => {
  it("builds collect → deliver with no hubs and no trunk", () => {
    const path = buildDirectPath("M1 1AA", "PL1 1AA", { legCapacity: RATES.legCapacity, maxTrunkHops: 2 });
    expect(path.routing).toBe("direct");
    expect(path.kind).toBe("direct");
    expect(path.isLocal).toBe(false);
    expect(path.originHub).toBeNull();
    expect(path.destinationHub).toBeNull();
    expect(path.legs.map((l) => l.kind)).toEqual(["collect", "deliver"]);
  });
});

describe("buildPath", () => {
  const cfg = { legCapacity: RATES.legCapacity, maxTrunkHops: 2 };
  it("builds collect → trunk → deliver for different hubs", () => {
    const path = buildPath(
      { postcode: "CV1 2AB", hub: HUBS[0]! },
      { postcode: "EH1 1AA", hub: HUBS[1]! },
      cfg,
    );
    expect(path.isLocal).toBe(false);
    expect(path.legs.map((l) => l.kind)).toEqual(["collect", "trunk", "deliver"]);
  });
  it("builds a local move (no trunk) when hubs match", () => {
    const path = buildPath(
      { postcode: "CV1 2AB", hub: HUBS[0]! },
      { postcode: "B15 2TT", hub: HUBS[0]! },
      cfg,
    );
    expect(path.isLocal).toBe(true);
    expect(path.legs.map((l) => l.kind)).toEqual(["collect", "deliver"]);
  });
});

describe("computeDemand", () => {
  it("sums footprints, weight, and pallet count", () => {
    const pallets: GroupagePallet[] = [
      { footprint: "full", weightKg: 500, quantity: 3 },
      { footprint: "half", weightKg: 200, quantity: 2 },
    ];
    const d = computeDemand(pallets, RATES.footprintUnits, 52, RATES.maxPalletWeightKg);
    expect(d.footprints).toBe(4); // 3×1 + 2×0.5
    expect(d.weightKg).toBe(1900); // 3×500 + 2×200
    expect(d.palletCount).toBe(5);
  });
  it("rejects bad lines and over-limit bookings", () => {
    expect(() => computeDemand([], RATES.footprintUnits, 52, RATES.maxPalletWeightKg)).toThrow(/at least one pallet/);
    expect(() =>
      computeDemand([{ footprint: "full", weightKg: 0, quantity: 1 }], RATES.footprintUnits, 52, RATES.maxPalletWeightKg),
    ).toThrow(/greater than 0 kg/);
    expect(() =>
      computeDemand([{ footprint: "full", weightKg: 100, quantity: 60 }], RATES.footprintUnits, 52, RATES.maxPalletWeightKg),
    ).toThrow(/single-booking limit is 52/);
  });
  it("TRUSTS a pallet over the ceiling by default (soft ceiling) — priced, not rejected", () => {
    // enforce flag defaults false: a document's stated heavy tonnage is trusted and priced, never
    // blocked. The heavyPallet surcharge + leg capacity check surface the weight downstream.
    const heavy = [{ footprint: "full" as const, weightKg: 6390, quantity: 8 }];
    const d = computeDemand(heavy, RATES.footprintUnits, 52, RATES.maxPalletWeightKg);
    expect(d.weightKg).toBe(51120); // 6390 × 8 — the quotation's total, trusted
    expect(d.palletCount).toBe(8);
  });
  it("rejects a pallet over the ceiling ONLY when enforcement is opted in", () => {
    expect(() =>
      computeDemand([{ footprint: "full", weightKg: 1600, quantity: 1 }], RATES.footprintUnits, 52, RATES.maxPalletWeightKg, true),
    ).toThrow(/exceeds the per-pallet ceiling of 1500 kg/);
  });
});

describe("capacity — dual limit (Rule 1)", () => {
  it("passes when both limits hold, reports the binding axis", () => {
    const c = checkLeg({ footprints: 4, weightKg: 1900, palletCount: 5 }, {
      kind: "trunk",
      from: "A",
      to: "B",
      capacity: { palletSpaces: 26, maxPayloadKg: 24000 },
    });
    expect(c.fits).toBe(true);
    expect(c.spacesRemaining).toBe(22);
    expect(c.payloadRemainingKg).toBe(22100);
    expect(c.bindingLimit).toBe("spaces"); // 4/26 > 1900/24000
  });
  it("fails on weight even when space is fine (weight-out)", () => {
    const c = checkLeg({ footprints: 2, weightKg: 4000, palletCount: 2 }, {
      kind: "collect",
      from: "A",
      to: "B",
      capacity: { palletSpaces: 10, maxPayloadKg: 3500 },
    });
    expect(c.fits).toBe(false);
    expect(c.bindingLimit).toBe("weight");
    expect(c.payloadRemainingKg).toBe(-500);
  });
  it("assertPathFits names an over-capacity leg and counts the others", () => {
    const path = buildPath(
      { postcode: "CV1 2AB", hub: HUBS[0]! },
      { postcode: "EH1 1AA", hub: HUBS[1]! },
      { legCapacity: RATES.legCapacity, maxTrunkHops: 2 },
    );
    // 12 full pallets overflow the collect leg (10 spaces) before the trunk (26).
    const demand = { footprints: 12, weightKg: 3000, palletCount: 12 };
    const result = checkPath(path.legs.map(() => demand), path);
    expect(result.fits).toBe(false);
    expect(result.vehiclesNeeded).toBe(2);
    // Default (enforceLegCapacity off): the overflow is MEASURED, never thrown — a legitimate
    // high-volume booking must still get a quote.
    expect(() => assertPathFits(result)).not.toThrow();
    // Opted in, it is the fat-finger guard it was built to be.
    expect(() => assertPathFits(result, true)).toThrow(/collect vehicle/);
    // The deliver leg is equally over: nothing over capacity is hidden.
    expect(() => assertPathFits(result, true)).toThrow(/1 other leg is also over capacity/);
  });

  it("assertPathFits reports the WORST leg, not the first — the vehicle count must be actionable", () => {
    const legs = [
      { kind: "collect" as const, from: "A", to: "H1", capacity: { palletSpaces: 10, maxPayloadKg: 100_000 } },
      { kind: "trunk" as const, from: "H1", to: "H2", capacity: { palletSpaces: 4, maxPayloadKg: 100_000 } },
    ];
    // 11 spaces: 2 collect vehicles, but 3 trunk vehicles. Reporting "2" would be the wrong answer.
    const demand = { footprints: 11, weightKg: 1000, palletCount: 11 };
    const result = checkPath([demand, demand], {
      originHub: null,
      destinationHub: null,
      legs,
      routing: "via-hub",
      kind: "hub",
      isLocal: false,
    });
    expect(result.vehiclesNeeded).toBe(3);
    expect(() => assertPathFits(result, true)).toThrow(/at least 3 trunk vehicles on the H1 → H2 leg/);
  });
});

describe("pricing (1.4)", () => {
  it("prices line-haul + first/last mile with a zone rate", () => {
    const path = buildPath(
      { postcode: "CV1 2AB", hub: HUBS[0]! },
      { postcode: "EH1 1AA", hub: HUBS[1]! },
      { legCapacity: RATES.legCapacity, maxTrunkHops: 2 },
    );
    const demand = { footprints: 4, weightKg: 1900, palletCount: 5 };
    const p = priceGroupage({
      pallets: [{ footprint: "full", weightKg: 475, quantity: 4 }],
      demand,
      path,
      rates: RATES,
      currencySymbol: "£",
    });
    // 4 × 55 (zone) + 25 + 25 = 270; no heavy pallet (475 < 700).
    expect(p.subtotal).toBe(270);
    expect(p.surcharges).toBe(0);
    expect(p.total).toBe(270);
  });
  it("local move is first + last mile only (no line-haul)", () => {
    const path = buildPath(
      { postcode: "CV1 2AB", hub: HUBS[0]! },
      { postcode: "B15 2TT", hub: HUBS[0]! },
      { legCapacity: RATES.legCapacity, maxTrunkHops: 2 },
    );
    const demand = { footprints: 2, weightKg: 400, palletCount: 2 };
    const p = priceGroupage({
      pallets: [{ footprint: "full", weightKg: 200, quantity: 2 }],
      demand,
      path,
      rates: RATES,
      currencySymbol: "£",
    });
    expect(p.subtotal).toBe(50); // 25 + 25 only
    expect(p.total).toBe(50);
  });
  it("adds the heavy-pallet surcharge for weight-out pallets", () => {
    // 900 kg on a full (1 unit) pallet → 900 > 700 threshold.
    expect(heavyPalletCount([{ footprint: "full", weightKg: 900, quantity: 2 }], RATES.footprintUnits, 700)).toBe(2);
    const path = buildPath(
      { postcode: "CV1 2AB", hub: HUBS[0]! },
      { postcode: "EH1 1AA", hub: HUBS[1]! },
      { legCapacity: RATES.legCapacity, maxTrunkHops: 2 },
    );
    const p = priceGroupage({
      pallets: [{ footprint: "full", weightKg: 900, quantity: 2 }],
      demand: { footprints: 2, weightKg: 1800, palletCount: 2 },
      path,
      rates: RATES,
      currencySymbol: "£",
    });
    // 2 × 55 + 25 + 25 = 160 subtotal; 2 × 40 = 80 surcharge; 240 total.
    expect(p.subtotal).toBe(160);
    expect(p.surcharges).toBe(80);
    expect(p.total).toBe(240);
  });
  it("zoneRate falls back to default off-zone", () => {
    expect(zoneRate(RATES, "hub-mid", "hub-scot")).toBe(55);
    expect(zoneRate(RATES, "hub-scot", "hub-mid")).toBe(45);
  });
  it("direct (hubless) move prices line-haul at the default per-space rate", () => {
    const path = buildDirectPath("M1 1AA", "PL1 1AA", { legCapacity: RATES.legCapacity, maxTrunkHops: 2 });
    const p = priceGroupage({
      pallets: [{ footprint: "full", weightKg: 200, quantity: 4 }],
      demand: { footprints: 4, weightKg: 800, palletCount: 4 },
      path,
      rates: RATES,
      currencySymbol: "£",
    });
    // 4 × 45 (default, no zone) + 25 + 25 = 230; no heavy pallet (200 < 700).
    expect(p.subtotal).toBe(230);
    expect(p.total).toBe(230);
  });
});

describe("getGroupageQuote (end to end)", () => {
  it("produces a full quote with ETA echoed", async () => {
    const { quote } = await getGroupageQuote(
      {
        originPostcode: "CV1 2AB",
        destinationPostcode: "EH1 1AA",
        pallets: [{ footprint: "full", weightKg: 475, quantity: 4 }],
        eta: "2026-07-05",
      },
      deps(),
    );
    expect(quote.path.legs.map((l) => l.kind)).toEqual(["collect", "trunk", "deliver"]);
    expect(quote.total).toBe(270);
    expect(quote.eta).toBe("2026-07-05");
    expect(quote.demand.footprints).toBe(4);
  });
  it("fails loud on a catchment gap before pricing", async () => {
    await expect(
      getGroupageQuote(
        { originPostcode: "M1 1AA", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }] },
        deps(),
      ),
    ).rejects.toThrow(/No hub covers/);
  });
  it("routing:'direct' quotes an off-catchment postcode without a hub", async () => {
    const { quote } = await getGroupageQuote(
      {
        originPostcode: "M1 1AA", // no hub covers "M"
        destinationPostcode: "PL1 1AA", // no hub covers "PL"
        pallets: [{ footprint: "full", weightKg: 200, quantity: 4 }],
        routing: "direct",
      },
      deps(),
    );
    expect(quote.path.routing).toBe("direct");
    expect(quote.path.originHub).toBeNull();
    expect(quote.path.legs.map((l) => l.kind)).toEqual(["collect", "deliver"]);
    // 4 × 45 default line-haul + 25 + 25 = 230.
    expect(quote.total).toBe(230);
  });
});

describe("config parsers fail loud", () => {
  it("rejects overlapping catchments (one area → two hubs)", () => {
    expect(() =>
      parseHubsFrom({ hubs: [
        { id: "a", name: "A", catchment: ["CV"] },
        { id: "b", name: "B", catchment: ["CV"] },
      ] }),
    ).toThrow(/disjoint/);
  });
  it("rejects a non-positive rate", () => {
    expect(() =>
      parseGroupageRates({ ...RATES, ratePerFootprint: { default: 0, zones: {} } }),
    ).toThrow(/must be a positive number/);
  });
  it("defaults the flexible ceiling knobs when absent (back-compat) and reads them when present", () => {
    const { enforcePerPalletCeiling: _e, maxPlausibleDerivedPalletKg: _m, ...bare } = RATES;
    const dflt = parseGroupageRates(bare);
    expect(dflt.enforcePerPalletCeiling).toBe(false); // trust the quotation by default
    expect(dflt.maxPlausibleDerivedPalletKg).toBe(2500);
    const set = parseGroupageRates({ ...bare, enforcePerPalletCeiling: true, maxPlausibleDerivedPalletKg: 4000 });
    expect(set.enforcePerPalletCeiling).toBe(true);
    expect(set.maxPlausibleDerivedPalletKg).toBe(4000);
  });
  it("rejects a non-boolean enforce flag and a non-positive doubtful ceiling", () => {
    expect(() => parseGroupageRates({ ...RATES, enforcePerPalletCeiling: "yes" })).toThrow(/must be a boolean/);
    expect(() => parseGroupageRates({ ...RATES, maxPlausibleDerivedPalletKg: 0 })).toThrow(/must be a positive number/);
  });
  it("hub address: absent OK, present round-trips trimmed, present-and-blank rejected", () => {
    // Absent — a groupage-only hub needs no address.
    const noAddr = parseHubsFrom({ hubs: [{ id: "a", name: "A", catchment: ["CV"] }] })[0]!;
    expect(noAddr.address).toBeUndefined();
    // Present — kept, trimmed.
    const withAddr = parseHubsFrom({
      hubs: [{ id: "a", name: "A", catchment: ["CV"], address: "  Unit 3, Hams Hall, B46 1AL  " }],
    })[0]!;
    expect(withAddr.address).toBe("Unit 3, Hams Hall, B46 1AL");
    // Present-and-blank would read as "has an address" to a collection run — refuse it.
    expect(() =>
      parseHubsFrom({ hubs: [{ id: "a", name: "A", catchment: ["CV"], address: "   " }] }),
    ).toThrow(/address/);
  });
});

describe("parseGroupageQuoteInput — trust boundary", () => {
  it("rejects an over-long postcode instead of storing a megastring", () => {
    expect(() =>
      parseGroupageQuoteInput(
        { originPostcode: "CV1" + "X".repeat(20), destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }] },
        52,
        2,
      ),
    ).toThrow(/too long/);
  });
  it("accepts a well-formed ISO eta and echoes it trimmed", () => {
    const parsed = parseGroupageQuoteInput(
      { originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }], eta: " 2026-07-05 " },
      52,
      2,
    );
    expect(parsed.eta).toBe("2026-07-05");
  });
  it("rejects a malformed or non-calendar eta", () => {
    const base = { originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }] };
    expect(() => parseGroupageQuoteInput({ ...base, eta: "not-a-date" }, 52, 2)).toThrow(/YYYY-MM-DD/);
    expect(() => parseGroupageQuoteInput({ ...base, eta: "2026-13-40" }, 52, 2)).toThrow(/YYYY-MM-DD/);
    expect(() => parseGroupageQuoteInput({ ...base, eta: "2026-01-01T00:00:00Z" + "x".repeat(50) }, 52, 2)).toThrow(/YYYY-MM-DD/);
  });
  it("treats a null/missing eta as no commitment", () => {
    const base = { originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }] };
    expect(parseGroupageQuoteInput(base, 52, 2).eta).toBeNull();
  });
  it("captures an optional company name, trimmed; absent/blank ⇒ undefined", () => {
    const base = { originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }] };
    expect(parseGroupageQuoteInput({ ...base, customerName: "  Acme Ltd  " }, 52, 2).customerName).toBe("Acme Ltd");
    expect(parseGroupageQuoteInput(base, 52, 2).customerName).toBeUndefined();
    expect(parseGroupageQuoteInput({ ...base, customerName: "   " }, 52, 2).customerName).toBeUndefined();
  });
  it("rejects an over-long company name instead of storing a megastring", () => {
    const base = { originPostcode: "CV1 2AB", destinationPostcode: "EH1 1AA", pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }] };
    expect(() => parseGroupageQuoteInput({ ...base, customerName: "A".repeat(121) }, 52, 2)).toThrow(/too long/);
  });
});

describe("parseExpectedTotal", () => {
  it("returns null when absent, the number when present, and rejects garbage", () => {
    expect(parseExpectedTotal({})).toBeNull();
    expect(parseExpectedTotal({ expectedTotal: 270 })).toBe(270);
    expect(() => parseExpectedTotal({ expectedTotal: "270" })).toThrow(/non-negative number/);
    expect(() => parseExpectedTotal({ expectedTotal: -5 })).toThrow(/non-negative number/);
  });
});

describe("readJsonBody", () => {
  it("parses a normal body under the cap", async () => {
    const req = new Request("http://x", { method: "POST", body: JSON.stringify({ a: 1 }) });
    await expect(readJsonBody(req, 1024)).resolves.toEqual({ a: 1 });
  });
  it("rejects an oversized body while streaming, not after fully buffering it", async () => {
    // The runtime computes its own Content-Length from the real body — this exercises the
    // stream-cap path (the case a spoofed/missing header can't be relied on to catch).
    const bigBody = JSON.stringify({ a: "x".repeat(1000) });
    const req = new Request("http://x", { method: "POST", body: bigBody });
    await expect(readJsonBody(req, 50)).rejects.toThrow(/too large/);
  });
});

describe("hub repository — last-hub guard", () => {
  it("refuses to delete the final hub (would brick resolution)", async () => {
    const repo = new InMemoryHubRepository([{ id: "only", name: "Only", catchment: ["CV"] }]);
    await expect(repo.deleteHub("only")).rejects.toThrow(/cannot delete the last hub/);
    // A non-last delete still works.
    const repo2 = new InMemoryHubRepository(HUBS);
    expect(await repo2.deleteHub("hub-scot")).toBe(true);
    expect((await repo2.listHubs()).map((h) => h.id)).toEqual(["hub-mid"]);
  });
});
