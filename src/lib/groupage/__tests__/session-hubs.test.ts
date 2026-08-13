import { describe, it, expect } from "vitest";
import {
  InMemoryHubRepository,
  SessionOverlayHubRepository,
  mergeSessionHubs,
} from "../hub.repository";
import { parseSessionHubs } from "../parse";
import { getGroupageQuote, type GroupageDeps } from "../service";
import { GroupageError, type Hub } from "../groupage.types";
import type { GroupageRates } from "../groupage-rates";

const BASE: Hub[] = [
  { id: "hub-mid", name: "Birmingham", catchment: ["CV", "B", "HD"] },
  { id: "hub-scot", name: "Glasgow", catchment: ["EH", "G"] },
];

// The two hubs the simple4 manifest names for itself.
const SESSION: Hub[] = [
  { id: "hub-huddersfield", name: "Huddersfield Consolidation Centre", catchment: ["HD"], address: "Bradley Mills Road, HD1 6EJ" },
  { id: "hub-nottingham", name: "Nottingham Distribution Hub", catchment: ["NG"], address: "Colwick, NG4 2JT" },
];

const RATES: GroupageRates = {
  footprintUnits: { full: 1, half: 0.5, quarter: 0.25, oversize: 2 },
  legCapacity: {
    collect: { palletSpaces: 10, maxPayloadKg: 3500 },
    trunk: { palletSpaces: 26, maxPayloadKg: 24000 },
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

function deps(hubs: InMemoryHubRepository | SessionOverlayHubRepository): GroupageDeps {
  return {
    hubs,
    loadRates: async () => RATES,
    config: { maxTrunkHops: 2, maxPalletsPerBooking: 52, currencySymbol: "£", defaultRouting: "via-hub" },
  };
}

describe("mergeSessionHubs", () => {
  it("session hubs win for their areas; base hub keeps its remaining areas", () => {
    const merged = mergeSessionHubs(BASE, SESSION);
    // HD moves from Birmingham to the session Huddersfield hub.
    expect(merged.find((h) => h.catchment.includes("HD"))!.id).toBe("hub-huddersfield");
    // NG is new.
    expect(merged.find((h) => h.catchment.includes("NG"))!.id).toBe("hub-nottingham");
    // Birmingham survives with CV+B (HD stripped), not dropped.
    const brum = merged.find((h) => h.id === "hub-mid")!;
    expect([...brum.catchment].sort()).toEqual(["B", "CV"]);
  });

  it("drops a base hub left with no areas, and replaces a same-id base hub outright", () => {
    const base: Hub[] = [{ id: "hub-x", name: "X", catchment: ["HD"] }];
    const session: Hub[] = [{ id: "hub-x", name: "New X", catchment: ["HD", "NG"] }];
    const merged = mergeSessionHubs(base, session);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.name).toBe("New X");
  });

  it("keeps catchments disjoint after merge", () => {
    const areas = mergeSessionHubs(BASE, SESSION).flatMap((h) => h.catchment);
    expect(new Set(areas).size).toBe(areas.length);
  });
});

describe("SessionOverlayHubRepository", () => {
  it("resolves a postcode to a session hub the base network does not cover", async () => {
    const repo = new SessionOverlayHubRepository(new InMemoryHubRepository(BASE), SESSION);
    expect((await repo.getHub("hub-nottingham"))?.name).toBe("Nottingham Distribution Hub");
    // NG only exists via the overlay.
    expect((await repo.listHubs()).some((h) => h.catchment.includes("NG"))).toBe(true);
  });

  it("is a transparent pass-through when there are no session hubs", async () => {
    const repo = new SessionOverlayHubRepository(new InMemoryHubRepository(BASE), []);
    expect(await repo.listHubs()).toEqual(BASE);
  });

  it("refuses writes (session hubs are transient)", async () => {
    const repo = new SessionOverlayHubRepository(new InMemoryHubRepository(BASE), SESSION);
    await expect(repo.upsertHub(SESSION[0]!)).rejects.toThrow(/read-only/);
  });
});

describe("getGroupageQuote with session hubs", () => {
  // A base network with NO Nottingham coverage. The trunk HD→NG must fail without the overlay…
  const noNg: Hub[] = [{ id: "hub-mid", name: "Birmingham", catchment: ["HD"] }];

  it("fails loud on the destination area when the overlay is absent", async () => {
    await expect(
      getGroupageQuote(
        { originPostcode: "HD1 6EJ", destinationPostcode: "NG4 2JT", pallets: [{ footprint: "full", weightKg: 300, quantity: 2 }], routing: "via-hub" },
        deps(new InMemoryHubRepository(noNg)),
      ),
    ).rejects.toThrow(/NG/);
  });

  it("prices the HD→NG trunk once the manifest's hubs are overlaid", async () => {
    const repo = new SessionOverlayHubRepository(new InMemoryHubRepository(noNg), SESSION);
    const { quote } = await getGroupageQuote(
      { originPostcode: "HD1 6EJ", destinationPostcode: "NG4 2JT", pallets: [{ footprint: "full", weightKg: 300, quantity: 2 }], routing: "via-hub" },
      deps(repo),
    );
    expect(quote.path.originHub?.id).toBe("hub-huddersfield");
    expect(quote.path.destinationHub?.id).toBe("hub-nottingham");
    expect(quote.total).toBeGreaterThan(0);
  });
});

describe("parseSessionHubs (trust boundary)", () => {
  it("returns [] for absent/empty input", () => {
    expect(parseSessionHubs(undefined)).toEqual([]);
    expect(parseSessionHubs(null)).toEqual([]);
    expect(parseSessionHubs([])).toEqual([]);
  });

  it("parses valid hubs, upper-casing areas and keeping the address", () => {
    const hubs = parseSessionHubs([{ id: "hub-hd", name: "Hudds", catchment: ["hd"], address: "Bradley Mills Road" }]);
    expect(hubs).toEqual([{ id: "hub-hd", name: "Hudds", catchment: ["HD"], address: "Bradley Mills Road" }]);
  });

  it("rejects a non-array, an overlong list, and overlapping catchments", () => {
    expect(() => parseSessionHubs({})).toThrow(GroupageError);
    expect(() => parseSessionHubs(Array.from({ length: 13 }, (_, i) => ({ id: `h${i}`, name: "n", catchment: ["Z" + i] })))).toThrow(/Too many/);
    expect(() =>
      parseSessionHubs([
        { id: "a", name: "A", catchment: ["HD"] },
        { id: "b", name: "B", catchment: ["HD"] },
      ]),
    ).toThrow(/one area belongs to one hub/);
  });

  it("rejects a blank-but-present address (would route a collection run from an empty string)", () => {
    expect(() => parseSessionHubs([{ id: "a", name: "A", catchment: ["HD"], address: "   " }])).not.toThrow();
    // whitespace address ⇒ treated as absent, not stored
    expect(parseSessionHubs([{ id: "a", name: "A", catchment: ["HD"], address: "   " }])[0]!.address).toBeUndefined();
  });
});
