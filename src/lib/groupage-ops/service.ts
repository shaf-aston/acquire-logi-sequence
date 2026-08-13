/**
 * Groupage-ops service — books a confirmed quote into a Shipment and applies lifecycle actions,
 * persisting each step. No transition logic here (that is the pure state machine); this only wires
 * the store + clock + config to the pure functions.
 */
import { getConfig } from "@/config/env";
import { GroupageError, type GroupageQuote } from "@/lib/groupage";
import { applyTransition } from "./transitions";
import { FileShipmentStore, type ShipmentStore } from "./shipment.repository";
import { LifecycleError, type Shipment, type ShipmentAction } from "./lifecycle.types";
import { assertCapacityAvailable } from "./manifest";
import type { LifecycleConfig } from "./state-machine";

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? `shp_${crypto.randomUUID()}` : `shp_${Date.now()}`;
}

function lifecycleConfig(): LifecycleConfig {
  return { maxDeliveryAttempts: getConfig().groupage.maxDeliveryAttempts };
}

/** Build the initial booked Shipment from a confirmed groupage quote (pure — clock injected). */
export function shipmentFromQuote(quote: GroupageQuote, id: string, now: string): Shipment {
  // The hub lifecycle (arrive-depot → load-trunk → arrive-hub → deliver) assumes a hub at each
  // end. A DIRECT (hubless) quote has no hub journey to track — fail loud rather than book a
  // shipment with null hubs into a state machine that will dereference them.
  const { originHub, destinationHub } = quote.path;
  if (!originHub || !destinationHub) {
    // GroupageError, not Error: /api/shipments maps it to a 400 carrying this message. A bare Error
    // becomes a generic 500 "Internal error." and the operator never sees the fix.
    throw new GroupageError(
      "path",
      "A direct (hubless) quote can't be booked into the hub shipment lifecycle — only via-hub shared-truck quotes have a hub journey to track.",
    );
  }
  // A Shipment carries ONE demand, which `buildManifests` sums against EVERY one of its legs. On a
  // multi-stop trunk the load differs per hop (pallets alight and board at the stops), so booking
  // one would reserve the whole booking's space on hops its dropped pallets never ride — silently
  // over-reserving the shared vehicle and turning away bookings that would have fitted. Per-leg
  // demand on Shipment is the fix; until then, refuse rather than reserve the wrong thing.
  if (quote.path.stops?.length) {
    throw new GroupageError(
      "path",
      `This quote calls at ${quote.path.stops.length} intermediate stop(s), and the shipment lifecycle reserves one load across every leg — booking it would over-reserve the hops your pallets leave before. Quote it without stops to book it.`,
    );
  }
  return {
    id,
    createdAt: now,
    updatedAt: now,
    status: "booked",
    isLocal: quote.path.isLocal,
    originPostcode: quote.originPostcode,
    destinationPostcode: quote.destinationPostcode,
    originHubId: originHub.id,
    destinationHubId: destinationHub.id,
    legs: quote.path.legs.map((l) => ({
      kind: l.kind,
      from: l.from,
      to: l.to,
      fromHubId: l.fromHubId,
      toHubId: l.toHubId,
      capacity: l.capacity,
    })),
    demand: quote.demand,
    total: quote.total,
    currencySymbol: quote.currencySymbol,
    eta: quote.eta,
    deliveryAttempts: 0,
    history: [{ at: now, action: "book", from: null, to: "booked" }],
  };
}

export async function bookGroupageQuote(quote: GroupageQuote, store: ShipmentStore = new FileShipmentStore()): Promise<Shipment> {
  const shipment = shipmentFromQuote(quote, newId(), new Date().toISOString());
  // Re-derive the shared-leg manifest (this booking + every other active one) and reject if it
  // would push a leg over capacity — checked and written atomically so a second booking can't
  // race in between (see ShipmentStore.saveWithCheck).
  await store.saveWithCheck(shipment, (existing) => assertCapacityAvailable(shipment, existing));
  return shipment;
}

export async function transitionShipment(
  id: string,
  action: ShipmentAction,
  note?: string,
  store: ShipmentStore = new FileShipmentStore(),
  cfg = lifecycleConfig(),
): Promise<Shipment> {
  const current = await store.get(id);
  if (!current) throw new LifecycleError(action, `Unknown shipment "${id}".`);
  const next = applyTransition(current, action, cfg, new Date().toISOString(), note);
  await store.save(next);
  return next;
}
