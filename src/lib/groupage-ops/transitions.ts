/**
 * Apply a lifecycle action to a shipment — pure: takes the shipment + a clock reading, returns the
 * next shipment (never mutates). Increments the delivery-attempt counter on each dispatch so the
 * cap in the state machine is enforced, and appends an audit event to history.
 */
import { nextStatus, type LifecycleConfig } from "./state-machine";
import {
  isTerminal,
  LifecycleError,
  type Shipment,
  type ShipmentAction,
  type ShipmentEvent,
} from "./lifecycle.types";

/** A delivery dispatch (first send or a reattempt) — the events the attempt cap counts. */
function countsAsAttempt(action: ShipmentAction): boolean {
  return action === "outForDelivery" || action === "reattempt";
}

export function applyTransition(
  shipment: Shipment,
  action: ShipmentAction,
  cfg: LifecycleConfig,
  now: string,
  note?: string,
): Shipment {
  if (isTerminal(shipment.status)) {
    throw new LifecycleError(
      action,
      `Shipment is already "${shipment.status}" — a terminal state; no further actions are possible.`,
    );
  }
  const to = nextStatus(shipment, action, cfg);
  const event: ShipmentEvent = { at: now, action, from: shipment.status, to, note };

  // Track where a rolled pallet is parked so re-plan returns it correctly; clear it once re-planned.
  let {heldAtHubId} = shipment;
  if (action === "roll") {
    heldAtHubId = shipment.status === "at-destination-hub" ? shipment.destinationHubId : shipment.originHubId;
  } else if (action === "replan") {
    heldAtHubId = undefined;
  }

  return {
    ...shipment,
    status: to,
    heldAtHubId,
    deliveryAttempts: countsAsAttempt(action) ? shipment.deliveryAttempts + 1 : shipment.deliveryAttempts,
    updatedAt: now,
    history: [...shipment.history, event],
  };
}
