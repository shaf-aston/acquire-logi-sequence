/**
 * Multi-stop trunk: path shape, the per-stop fee, the union pricing basis, the hop ceiling, and
 * the end-to-end service wiring. The zero-stop back-compat guarantee lives in `quote-snapshot.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { buildPath } from "../path-builder";
import { priceGroupage } from "../pricing";
import { checkPath } from "../capacity";
import { parseGroupageRates } from "../groupage-rates";
import { computeDemand } from "../demand";
import { routePallets, legLoads } from "../leg-loads";
import { stationsOf } from "../trunk-stops";
import { getGroupageQuote, type GroupageDeps } from "../service";
import { InMemoryHubRepository } from "../hub.repository";
import { groupConsignments, type Consignment } from "../truck-grouping";
import { shipmentFromQuote } from "@/lib/groupage-ops/service";
import { parseGroupageQuoteInput } from "../parse";
import { GroupageError, type GroupagePallet, type Hub } from "../groupage.types";
import type { GroupageRates } from "../groupage-rates";

const HUBS: Hub[] = [
  { id: "hub-mid", name: "Birmingham", catchment: ["CV", "B"] },
  { id: "hub-nw", name: "Manchester", catchment: ["M"] },
  { id: "hub-ne", name: "Leeds", catchment: ["LS"] },
  { id: "hub-scot", name: "Glasgow", catchment: ["G"] },
];
const [MID, NW, NE, SCOT] = HUBS as [Hub, Hub, Hub, Hub];
const UNITS = { full: 1, half: 0.5, quarter: 0.25, oversize: 2 } as const;

const RATES: GroupageRates = {
  footprintUnits: UNITS,
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

const CFG = { legCapacity: RATES.legCapacity, maxTrunkHops: 3 };
const deps = (rates: GroupageRates = RATES, maxTrunkHops = 3): GroupageDeps => ({
  hubs: new InMemoryHubRepository(HUBS),
  loadRates: async () => rates,
  config: { maxTrunkHops, maxPalletsPerBooking: 52, currencySymbol: "£", defaultRouting: "via-hub" },
});

const full = (quantity: number, extra: Partial<GroupagePallet> = {}): GroupagePallet => ({
  footprint: "full",
  weightKg: 100,
  quantity,
  ...extra,
});

// One line rides the whole way, one alights at the stop, one boards there — so the stop is used
// and every hop carries freight.
const STOPPING_PALLETS: GroupagePallet[] = [
  full(2),
  full(3, { leaveAtHubId: "hub-nw" }),
  full(4, { joinAtHubId: "hub-nw" }),
];

describe("buildPath with stops", () => {
  it("one stop → two trunk legs, chained through the stop", () => {
    const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW]);
    expect(path.legs.map((l) => [l.kind, l.from, l.to])).toEqual([
      ["collect", "CV1 2AB", "Birmingham"],
      ["trunk", "Birmingham", "Manchester"],
      ["trunk", "Manchester", "Glasgow"],
      ["deliver", "Glasgow", "G1 1AA"],
    ]);
    expect(path.stops?.map((h) => h.id)).toEqual(["hub-nw"]);
    expect(path.kind).toBe("hub");
  });

  it("two stops → three trunk legs", () => {
    const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW, NE]);
    expect(path.legs.filter((l) => l.kind === "trunk")).toHaveLength(3);
  });

  it("omits `stops` entirely when there are none", () => {
    const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG);
    expect("stops" in path).toBe(false);
    expect(JSON.parse(JSON.stringify(path))).not.toHaveProperty("stops");
  });

  it("enforces maxTrunkHops — hops = stops + 1", () => {
    const cfg = { ...CFG, maxTrunkHops: 2 };
    expect(() => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, cfg, [NW])).not.toThrow();
    expect(() => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, cfg, [NW, NE])).toThrow(
      /needs 3 trunk hops \(2 stops\); the configured limit is 2/,
    );
  });

  it("rejects stops on a local move", () => {
    expect(() => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "B15 2TT", hub: MID }, CFG, [NW])).toThrow(
      /share a hub \(Birmingham\), so there is no trunk to stop on/,
    );
  });

  it("rejects an adjacent duplicate rather than silently collapsing it", () => {
    expect(() => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW, NW])).toThrow(
      /Manchester appears twice on this trunk/,
    );
  });

  // Non-adjacent, so an adjacency-only check would let it through — and `routePallets` resolves a
  // hub id to a station by findIndex, so the second NW would silently bind to the first's station.
  it("rejects a NON-adjacent duplicate station", () => {
    expect(() => buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, { ...CFG, maxTrunkHops: 9 }, [NW, NE, NW])).toThrow(
      /Manchester appears twice on this trunk/,
    );
  });
});

describe("perTrunkStopFee", () => {
  const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW, NE]);
  const demand = computeDemand([full(4)], UNITS, 52, 1500);

  it("adds no line item when the fee is 0 (the default)", () => {
    const { lineItems } = priceGroupage({ pallets: [full(4)], demand, path, rates: RATES, currencySymbol: "£" });
    expect(lineItems.some((li) => li.label.includes("Intermediate stops"))).toBe(false);
  });

  it("charges the fee per stop, on the trunk leg", () => {
    const rates = { ...RATES, perTrunkStopFee: 15 };
    const { lineItems, total } = priceGroupage({ pallets: [full(4)], demand, path, rates, currencySymbol: "£" });
    const stopLine = lineItems.find((li) => li.label.includes("Intermediate stops"))!;
    expect(stopLine).toMatchObject({ label: "Intermediate stops (2 × £15/stop)", amount: 30, leg: "trunk" });
    // 4 spaces × £55 zone rate + £30 stops + £25 + £25
    expect(total).toBe(300);
  });

  it("never charges a stop fee on a stop-free path, whatever the fee", () => {
    const noStops = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG);
    const rates = { ...RATES, perTrunkStopFee: 99 };
    const { total } = priceGroupage({ pallets: [full(4)], demand, path: noStops, rates, currencySymbol: "£" });
    expect(total).toBe(4 * 55 + 25 + 25);
  });
});

describe("pricing basis is the UNION of every pallet line", () => {
  const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW]);

  it("bills a mid-trunk joiner — it never rides free", () => {
    const withJoiner = computeDemand(STOPPING_PALLETS, UNITS, 52, 1500);
    expect(withJoiner.footprints).toBe(9); // 2 + 3 + 4
    const { subtotal } = priceGroupage({ pallets: STOPPING_PALLETS, demand: withJoiner, path, rates: RATES, currencySymbol: "£" });
    expect(subtotal).toBe(9 * 55 + 25 + 25);
  });

  it("is additive — merging two bookings never prices below quoting them apart", () => {
    // The peak-load basis would price these as 4 (each set rides a different hop); union prices 8.
    const setA = full(4, { leaveAtHubId: "hub-nw" });
    const setB = full(4, { joinAtHubId: "hub-nw" });
    const merged = computeDemand([setA, setB], UNITS, 52, 1500);
    expect(merged.footprints).toBe(8);
    const haul = priceGroupage({ pallets: [setA, setB], demand: merged, path, rates: RATES, currencySymbol: "£" })
      .lineItems.find((li) => li.label.startsWith("Line-haul"))!;
    expect(haul.amount).toBe(8 * 55);
  });
});

describe("checkPath with per-leg loads", () => {
  const path = buildPath({ postcode: "CV1 2AB", hub: MID }, { postcode: "G1 1AA", hub: SCOT }, CFG, [NW]);

  it("reports the binding limit of the leg tightest under ITS OWN load", () => {
    // A heavy line boards at the stop: hop 2 goes weight-out while hop 1 is comfortable.
    const pallets: GroupagePallet[] = [
      full(1, { weightKg: 100 }),
      full(1, { leaveAtHubId: "hub-nw", weightKg: 100 }),
      { footprint: "full", weightKg: 11_000, quantity: 2, joinAtHubId: "hub-nw" },
    ];
    const loads = legLoads(routePallets(pallets, stationsOf(path)), path, UNITS);
    expect(loads.map((l) => l.weightKg)).toEqual([200, 200, 22_100, 22_100]);
    expect(checkPath(loads, path).bindingLimit).toBe("weight");
  });

  it("fails loud, never NaN, when the load profile and the path disagree", () => {
    expect(() => checkPath([{ footprints: 1, weightKg: 1, palletCount: 1 }], path)).toThrow(
      /1 leg loads for 4 legs.*This is a bug/s,
    );
  });
});

describe("parseGroupageRates.perTrunkStopFee", () => {
  const base = {
    footprintUnits: UNITS,
    legCapacity: RATES.legCapacity,
    ratePerFootprint: { default: 45, zones: {} },
    firstMileSurcharge: 25,
    lastMileSurcharge: 25,
    heavyPallet: { thresholdKgPerFootprint: 700, surchargePerPallet: 40 },
    maxPalletWeightKg: 1500,
  };
  it("defaults to 0 when absent — an old rates file still loads", () => {
    expect(parseGroupageRates(base).perTrunkStopFee).toBe(0);
  });
  it("accepts a non-negative number", () => {
    expect(parseGroupageRates({ ...base, perTrunkStopFee: 12.5 }).perTrunkStopFee).toBe(12.5);
  });
  it("rejects a negative fee", () => {
    expect(() => parseGroupageRates({ ...base, perTrunkStopFee: -1 })).toThrow(/perTrunkStopFee/);
  });
});

describe("parseTrunkStopHubIds (trust boundary)", () => {
  const body = (extra: object) => ({
    originPostcode: "CV1 2AB",
    destinationPostcode: "G1 1AA",
    pallets: [{ footprint: "full", weightKg: 100, quantity: 1 }],
    ...extra,
  });
  // hops = stops + 1, so a 4-hop ceiling allows 3 stops.
  const parse = (b: object, maxTrunkHops = 4) => parseGroupageQuoteInput(b, 52, maxTrunkHops);

  it("absent ⇒ []", () => {
    expect(parse(body({})).trunkStopHubIds).toEqual([]);
  });
  it("rejects a non-array", () => {
    expect(() => parse(body({ trunkStopHubIds: "hub-nw" }))).toThrow(/must be an array/);
  });
  it("rejects a blank entry", () => {
    expect(() => parse(body({ trunkStopHubIds: ["  "] }))).toThrow(/trunkStopHubIds\[0\]/);
  });
  it("bounds the array before iterating, at the stop count the hop ceiling implies", () => {
    expect(() => parse(body({ trunkStopHubIds: ["a", "b", "c", "d"] }))).toThrow(/Too many intermediate stops \(4\); the limit is 3/);
    expect(() => parse(body({ trunkStopHubIds: ["a", "b", "c"] }))).not.toThrow();
  });
  // The boundary must never reject a stop count the routing config allows, nor accept one it forbids.
  it("tracks maxTrunkHops rather than a fixed cap", () => {
    expect(() => parse(body({ trunkStopHubIds: ["a", "b"] }), 3)).not.toThrow();
    expect(() => parse(body({ trunkStopHubIds: ["a", "b", "c"] }), 3)).toThrow(/the limit is 2/);
    expect(() => parse(body({ trunkStopHubIds: Array(20).fill("h") }), 21)).not.toThrow();
  });
  it("says so plainly when the config allows no stops at all", () => {
    expect(() => parse(body({ trunkStopHubIds: ["hub-nw"] }), 1)).toThrow(/allows no intermediate stops/);
  });
  it("omits absent station refs on a pallet line rather than setting null", () => {
    const [line] = parse(body({})).pallets;
    expect("joinAtHubId" in line!).toBe(false);
    expect("leaveAtHubId" in line!).toBe(false);
  });
  it("passes through present station refs", () => {
    const parsed = parse(body({ pallets: [{ footprint: "full", weightKg: 100, quantity: 1, joinAtHubId: " hub-nw " }] }));
    expect(parsed.pallets[0]).toMatchObject({ joinAtHubId: "hub-nw" });
  });
});

describe("getGroupageQuote with stops (end to end)", () => {
  it("prices the stop, reports the per-leg load, and carries the stops on the path", async () => {
    const { quote } = await getGroupageQuote(
      {
        originPostcode: "CV1 2AB",
        destinationPostcode: "G1 1AA",
        pallets: STOPPING_PALLETS,
        routing: "via-hub",
        trunkStopHubIds: ["hub-nw"],
      },
      deps({ ...RATES, perTrunkStopFee: 20 }),
    );
    expect(quote.path.stops?.map((h) => h.name)).toEqual(["Manchester"]);
    expect(quote.legLoads).toEqual([
      { footprints: 5, weightKg: 500, palletCount: 5 }, // collect: 2 + 3
      { footprints: 5, weightKg: 500, palletCount: 5 }, // MID → NW
      { footprints: 6, weightKg: 600, palletCount: 6 }, // NW → SCOT: 2 + 4
      { footprints: 6, weightKg: 600, palletCount: 6 }, // deliver
    ]);
    // union 9 spaces × £55 + £20 stop + £25 + £25
    expect(quote.total).toBe(9 * 55 + 20 + 25 + 25);
  });

  it("omits `legLoads` when there are no stops", async () => {
    const { quote } = await getGroupageQuote(
      { originPostcode: "CV1 2AB", destinationPostcode: "G1 1AA", pallets: [full(2)], routing: "via-hub" },
      deps(),
    );
    expect("legLoads" in quote).toBe(false);
  });

  it("rejects stops on a direct route with an actionable fix", async () => {
    await expect(
      getGroupageQuote(
        { originPostcode: "CV1 2AB", destinationPostcode: "G1 1AA", pallets: [full(2)], routing: "direct", trunkStopHubIds: ["hub-nw"] },
        deps(),
      ),
    ).rejects.toThrow(/need routing "via-hub".*Switch routing, or remove the stops/s);
  });

  it("rejects stops when the config default routing is direct", async () => {
    const d = { ...deps(), config: { ...deps().config, defaultRouting: "direct" as const } };
    await expect(
      getGroupageQuote(
        { originPostcode: "CV1 2AB", destinationPostcode: "G1 1AA", pallets: [full(2)], trunkStopHubIds: ["hub-nw"] },
        d,
      ),
    ).rejects.toThrow(/need routing "via-hub"/);
  });

  it("surfaces an over-capacity HOP naming that exact hop", async () => {
    // 30 full pallets ride ONLY the middle hop — they board at Manchester and alight at Leeds. So the
    // collect, deliver and outer hops all stay light and the middle hop alone blows: exactly the hop
    // the operator must be told about, and one a whole-booking check would never have seen.
    const pallets: GroupagePallet[] = [full(2), full(30, { joinAtHubId: "hub-nw", leaveAtHubId: "hub-ne" })];
    const { quote } = await getGroupageQuote(
      {
        originPostcode: "CV1 2AB",
        destinationPostcode: "G1 1AA",
        pallets,
        routing: "via-hub",
        trunkStopHubIds: ["hub-nw", "hub-ne"],
      },
      deps(),
    );

    // Quoted, not rejected — but the breach is on the quote, hop by hop.
    expect(quote.fits).toBe(false);
    expect(quote.vehiclesNeeded).toBe(2);
    const bad = quote.capacityChecks.filter((c) => !c.fits);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.leg.from).toBe("Manchester");
    expect(bad[0]!.leg.to).toBe("Leeds");
    expect(bad[0]!.vehiclesNeeded).toBe(2);
    // Every pallet fits A truck; the load merely needs two of them.
    expect(quote.oversizeLines).toBeUndefined();
  });

  it("fails loud with check 'stops' on an unknown stop hub", async () => {
    try {
      await getGroupageQuote(
        { originPostcode: "CV1 2AB", destinationPostcode: "G1 1AA", pallets: [full(2)], routing: "via-hub", trunkStopHubIds: ["nope"] },
        deps(),
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GroupageError);
      expect((e as GroupageError).check).toBe("stops");
    }
  });
});

describe("booking refuses a multi-stop quote rather than over-reserving hops", () => {
  it("fails loud, naming the stop count and the fix", async () => {
    const { quote } = await getGroupageQuote(
      {
        originPostcode: "CV1 2AB",
        destinationPostcode: "G1 1AA",
        pallets: STOPPING_PALLETS,
        routing: "via-hub",
        trunkStopHubIds: ["hub-nw"],
      },
      deps(),
    );
    expect(() => shipmentFromQuote(quote, "shp_1", "2026-07-08T00:00:00.000Z")).toThrow(
      /calls at 1 intermediate stop\(s\).*over-reserve the hops/s,
    );
  });

  // A bare Error would fall through /api/shipments' error map to a generic 500 "Internal error.",
  // swallowing the actionable message above. GroupageError is what makes it a 400 carrying the fix.
  it("throws a GroupageError so the operator sees the fix, not a 500", async () => {
    const { quote } = await getGroupageQuote(
      {
        originPostcode: "CV1 2AB",
        destinationPostcode: "G1 1AA",
        pallets: STOPPING_PALLETS,
        routing: "via-hub",
        trunkStopHubIds: ["hub-nw"],
      },
      deps(),
    );
    try {
      shipmentFromQuote(quote, "shp_1", "2026-07-08T00:00:00.000Z");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GroupageError);
      expect((e as GroupageError).check).toBe("path");
    }
  });

  it("still books a stop-free via-hub quote", async () => {
    const { quote } = await getGroupageQuote(
      { originPostcode: "CV1 2AB", destinationPostcode: "G1 1AA", pallets: [full(2)], routing: "via-hub" },
      deps(),
    );
    expect(shipmentFromQuote(quote, "shp_1", "2026-07-08T00:00:00.000Z").status).toBe("booked");
  });
});

describe("shared-truck planner rejects a multi-stop consignment", () => {
  const cfg = { maxTrunkHops: 3, maxPalletsPerBooking: 52, defaultRouting: "via-hub" as const };

  it("refuses to stack it rather than silently pricing one hop", () => {
    const c: Consignment = {
      company: "Acme",
      originPostcode: "CV1 2AB",
      destinationPostcode: "G1 1AA",
      pallets: STOPPING_PALLETS,
      routing: "via-hub",
      trunkStopHubIds: ["hub-nw"],
    };
    expect(() => groupConsignments([c], HUBS, RATES, cfg)).toThrow(
      /"Acme" routes via 1 intermediate stop\(s\); the shared-truck planner models point-to-point trunks only/,
    );
  });

  it("still stacks a stop-free consignment", () => {
    const c: Consignment = {
      company: "Acme",
      originPostcode: "CV1 2AB",
      destinationPostcode: "G1 1AA",
      pallets: [full(2)],
      routing: "via-hub",
    };
    expect(groupConsignments([c], HUBS, RATES, cfg)).toHaveLength(1);
  });
});
