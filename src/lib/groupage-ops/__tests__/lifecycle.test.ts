import { describe, it, expect } from "vitest";
import { applyTransition } from "../transitions";
import { nextStatus, ACTIONS_BY_STATUS } from "../state-machine";
import { buildManifests, assertCapacityAvailable } from "../manifest";
import { bookGroupageQuote, shipmentFromQuote } from "../service";
import { InMemoryShipmentStore } from "../shipment.repository";
import { isTerminal, LifecycleError, type Shipment, type ShipmentAction } from "../lifecycle.types";
import { GroupageError } from "@/lib/groupage/groupage.types";
import type { GroupageQuote } from "@/lib/groupage";

const CFG = { maxDeliveryAttempts: 3 };
const NOW = "2026-07-02T10:00:00.000Z";

function makeShipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: "shp_1",
    createdAt: NOW,
    updatedAt: NOW,
    status: "booked",
    isLocal: false,
    originPostcode: "CV1 2AB",
    destinationPostcode: "EH1 1AA",
    originHubId: "hub-mid",
    destinationHubId: "hub-scot",
    legs: [
      { kind: "collect", from: "CV1 2AB", to: "Birmingham", toHubId: "hub-mid", capacity: { palletSpaces: 10, maxPayloadKg: 3500 } },
      { kind: "trunk", from: "Birmingham", to: "Glasgow", fromHubId: "hub-mid", toHubId: "hub-scot", capacity: { palletSpaces: 26, maxPayloadKg: 24000 } },
      { kind: "deliver", from: "Glasgow", to: "EH1 1AA", fromHubId: "hub-scot", capacity: { palletSpaces: 10, maxPayloadKg: 3500 } },
    ],
    demand: { footprints: 4, weightKg: 1900, palletCount: 5 },
    total: 270,
    currencySymbol: "£",
    eta: "2026-07-05",
    deliveryAttempts: 0,
    history: [{ at: NOW, action: "book", from: null, to: "booked" }],
    ...overrides,
  };
}

function chain(s: Shipment, actions: ShipmentAction[]): Shipment {
  return actions.reduce((acc, a) => applyTransition(acc, a, CFG, NOW), s);
}

/** Minimal valid GroupageQuote fixture — enough for shipmentFromQuote/bookGroupageQuote. */
function makeQuote(opts: {
  demand?: { footprints: number; weightKg: number; palletCount: number };
  originPostcode?: string;
  destinationPostcode?: string;
  trunkPalletSpaces?: number;
} = {}): GroupageQuote {
  const originPostcode = opts.originPostcode ?? "CV1 2AB";
  const destinationPostcode = opts.destinationPostcode ?? "EH1 1AA";
  const demand = opts.demand ?? { footprints: 4, weightKg: 1900, palletCount: 5 };
  return {
    originPostcode,
    destinationPostcode,
    path: {
      originHub: { id: "hub-mid", name: "Birmingham", catchment: ["CV"] },
      destinationHub: { id: "hub-scot", name: "Glasgow", catchment: ["EH"] },
      legs: [
        { kind: "collect", from: originPostcode, to: "Birmingham", toHubId: "hub-mid", capacity: { palletSpaces: 10, maxPayloadKg: 3500 } },
        {
          kind: "trunk",
          from: "Birmingham",
          to: "Glasgow",
          fromHubId: "hub-mid",
          toHubId: "hub-scot",
          capacity: { palletSpaces: opts.trunkPalletSpaces ?? 26, maxPayloadKg: 24000 },
        },
        { kind: "deliver", from: "Glasgow", to: destinationPostcode, fromHubId: "hub-scot", capacity: { palletSpaces: 10, maxPayloadKg: 3500 } },
      ],
      routing: "via-hub",
      kind: "hub",
      isLocal: false,
    },
    demand,
    capacityChecks: [],
    bindingLimit: "spaces",
    fits: true,
    vehiclesNeeded: 1,
    lineItems: [],
    currencySymbol: "£",
    subtotal: 270,
    surcharges: 0,
    total: 270,
    eta: null,
  };
}

describe("lifecycle happy path", () => {
  it("walks a network shipment booked → complete", () => {
    const final = chain(makeShipment(), [
      "collect",
      "arriveOriginDepot",
      "loadTrunk",
      "arriveDestinationHub",
      "outForDelivery",
      "deliver",
    ]);
    expect(final.status).toBe("complete");
    expect(isTerminal(final.status)).toBe(true);
    expect(final.history.at(-1)?.action).toBe("deliver");
  });

  it("walks a LOCAL move without a trunk", () => {
    const local = makeShipment({ isLocal: true });
    const final = chain(local, ["collect", "arriveOriginDepot", "outForDelivery", "deliver"]);
    expect(final.status).toBe("complete");
  });

  it("rejects loadTrunk on a local move", () => {
    const local = makeShipment({ isLocal: true, status: "at-origin-depot" });
    expect(() => applyTransition(local, "loadTrunk", CFG, NOW)).toThrow(/local move/);
  });
});

describe("lifecycle guards", () => {
  it("rejects an illegal transition", () => {
    expect(() => applyTransition(makeShipment(), "deliver", CFG, NOW)).toThrow(LifecycleError);
    expect(() => applyTransition(makeShipment(), "deliver", CFG, NOW)).toThrow(/Cannot "deliver" from status "booked"/);
  });

  it("blocks any action once terminal", () => {
    const done = makeShipment({ status: "complete" });
    expect(() => applyTransition(done, "reattempt", CFG, NOW)).toThrow(/terminal state/);
  });

  it("blocks outForDelivery on a network shipment still at origin (must trunk first)", () => {
    const s = makeShipment({ status: "at-origin-depot" });
    expect(() => applyTransition(s, "outForDelivery", CFG, NOW)).toThrow(/load the trunk first/);
  });
});

describe("attempt cap → always terminal (Rule 5)", () => {
  it("caps redelivery at maxDeliveryAttempts then forces return-to-sender", () => {
    // Reach out-for-delivery (attempt 1).
    let s = chain(makeShipment(), ["collect", "arriveOriginDepot", "loadTrunk", "arriveDestinationHub", "outForDelivery"]);
    expect(s.deliveryAttempts).toBe(1);
    // Fail + reattempt twice more → attempts 2, 3.
    s = applyTransition(s, "failDelivery", CFG, NOW);
    s = applyTransition(s, "reattempt", CFG, NOW);
    expect(s.deliveryAttempts).toBe(2);
    s = applyTransition(s, "failDelivery", CFG, NOW);
    s = applyTransition(s, "reattempt", CFG, NOW);
    expect(s.deliveryAttempts).toBe(3);
    // Third failure: reattempt now blocked (cap reached) → must return to sender.
    s = applyTransition(s, "failDelivery", CFG, NOW);
    expect(() => applyTransition(s, "reattempt", CFG, NOW)).toThrow(/attempt cap \(3\) reached/);
    const rts = applyTransition(s, "returnToSender", CFG, NOW);
    expect(rts.status).toBe("return-to-sender");
    expect(isTerminal(rts.status)).toBe(true);
  });
});

describe("roll / re-plan exception branch", () => {
  it("rolls at ORIGIN depot and re-plans back to origin depot (awaiting a trunk)", () => {
    const s = makeShipment({ status: "at-origin-depot" });
    const rolled = applyTransition(s, "roll", CFG, NOW);
    expect(rolled.status).toBe("at-hub-awaiting-space");
    expect(rolled.heldAtHubId).toBe("hub-mid");
    const replanned = applyTransition(rolled, "replan", CFG, NOW);
    expect(replanned.status).toBe("at-origin-depot");
    expect(replanned.heldAtHubId).toBeUndefined();
  });

  it("rolls at DESTINATION hub and re-plans back to the destination hub (never a second trunk)", () => {
    const s = makeShipment({ status: "at-destination-hub" });
    const rolled = applyTransition(s, "roll", CFG, NOW);
    expect(rolled.heldAtHubId).toBe("hub-scot");
    const replanned = applyTransition(rolled, "replan", CFG, NOW);
    expect(replanned.status).toBe("at-destination-hub"); // NOT at-origin-depot → no phantom trunk
  });

  it("lets a pallet stuck awaiting space reach a terminal state via return-to-sender (Rule 5)", () => {
    const rolled = applyTransition(makeShipment({ status: "at-origin-depot" }), "roll", CFG, NOW);
    expect(rolled.status).toBe("at-hub-awaiting-space");
    const rts = applyTransition(rolled, "returnToSender", CFG, NOW);
    expect(rts.status).toBe("return-to-sender");
    expect(isTerminal(rts.status)).toBe(true);
  });
});

describe("nextStatus + ACTIONS_BY_STATUS", () => {
  it("exposes legal actions per status", () => {
    expect(ACTIONS_BY_STATUS.booked).toEqual(["collect", "cancel"]);
    expect(ACTIONS_BY_STATUS["out-for-delivery"]).toContain("deliver");
    expect(ACTIONS_BY_STATUS["out-for-delivery"]).toContain("failDelivery");
    expect(ACTIONS_BY_STATUS.complete).toEqual([]);
  });
  it("nextStatus matches applyTransition", () => {
    expect(nextStatus(makeShipment(), "collect", CFG)).toBe("collected");
  });
});

describe("cancel — void a mis-booking before collection", () => {
  it("cancels a booked shipment to a terminal 'cancelled' state", () => {
    const cancelled = applyTransition(makeShipment(), "cancel", CFG, NOW, "duplicate booking");
    expect(cancelled.status).toBe("cancelled");
    expect(isTerminal(cancelled.status)).toBe(true);
    expect(cancelled.history.at(-1)).toMatchObject({ action: "cancel", to: "cancelled", note: "duplicate booking" });
  });
  it("refuses to cancel once the shipment has been collected", () => {
    const collected = applyTransition(makeShipment(), "collect", CFG, NOW);
    expect(() => applyTransition(collected, "cancel", CFG, NOW)).toThrow(/Cannot "cancel" from status "collected"/);
  });
});

describe("buildManifests", () => {
  it("sums footprints and weight per leg across active shipments, excluding terminal", () => {
    const a = makeShipment({ id: "a", status: "in-transit" });
    const b = makeShipment({ id: "b", status: "at-origin-depot", demand: { footprints: 2, weightKg: 800, palletCount: 2 } });
    const done = makeShipment({ id: "c", status: "complete" });
    const manifests = buildManifests([a, b, done]);
    const trunk = manifests.find((m) => m.kind === "trunk")!;
    // a + b on the trunk leg (both share hub-mid>hub-scot); c excluded (terminal).
    expect(trunk.count).toBe(2);
    expect(trunk.usedFootprints).toBe(6); // 4 + 2
    expect(trunk.usedWeightKg).toBe(2700); // 1900 + 800
    expect(trunk.capacity.palletSpaces).toBe(26);
  });
});

describe("assertCapacityAvailable — cross-booking consolidation gate", () => {
  it("passes when the shared leg has room", () => {
    const incoming = shipmentFromQuote(makeQuote(), "shp_a", NOW);
    expect(() => assertCapacityAvailable(incoming, [])).not.toThrow();
  });

  it("fails loud when two individually-fitting bookings would together overflow the shared trunk leg", () => {
    // Each booking is 4 footprints (well within the 10-space collect/deliver legs on its own),
    // but the trunk leg here is capped at 6 — 4 + 4 = 8 > 6.
    const existing = shipmentFromQuote(
      makeQuote({ originPostcode: "CV2 1AA", destinationPostcode: "EH2 2BB", trunkPalletSpaces: 6 }),
      "shp_existing",
      NOW,
    );
    const incoming = shipmentFromQuote(makeQuote({ trunkPalletSpaces: 6 }), "shp_incoming", NOW);
    expect(() => assertCapacityAvailable(incoming, [existing])).toThrow(GroupageError);
    expect(() => assertCapacityAvailable(incoming, [existing])).toThrow(/trunk leg .* over capacity/);
  });

  it("excludes terminal shipments (cancelled) from the shared-leg total", () => {
    const cancelled: Shipment = {
      ...shipmentFromQuote(makeQuote({ originPostcode: "CV2 1AA", destinationPostcode: "EH2 2BB", trunkPalletSpaces: 6 }), "shp_cancelled", NOW),
      status: "cancelled",
    };
    const incoming = shipmentFromQuote(makeQuote({ trunkPalletSpaces: 6 }), "shp_incoming2", NOW);
    expect(() => assertCapacityAvailable(incoming, [cancelled])).not.toThrow();
  });
});

describe("bookGroupageQuote — capacity enforced at booking time, not just displayed", () => {
  it("books when the shared leg has room", async () => {
    const store = new InMemoryShipmentStore();
    const shipment = await bookGroupageQuote(makeQuote(), store);
    expect(shipment.status).toBe("booked");
    expect(await store.get(shipment.id)).not.toBeNull();
  });

  it("rejects (and does not persist) a booking that would overflow a leg shared with an existing active shipment", async () => {
    const existing = shipmentFromQuote(
      makeQuote({ originPostcode: "CV2 1AA", destinationPostcode: "EH2 2BB", trunkPalletSpaces: 6 }),
      "shp_existing",
      NOW,
    );
    const store = new InMemoryShipmentStore([existing]);
    await expect(bookGroupageQuote(makeQuote({ trunkPalletSpaces: 6 }), store)).rejects.toThrow(/over capacity/);
    expect(await store.list()).toHaveLength(1); // only the pre-existing shipment — nothing written
  });
});
