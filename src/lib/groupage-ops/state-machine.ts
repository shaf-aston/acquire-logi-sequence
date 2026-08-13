/**
 * The shipment lifecycle transition table (pure). One place defines every allowed status change
 * and its guard, so the flow can never take an illegal step and always reaches a terminal state
 * (blueprint Rule 5). No I/O, no clock — `applyTransition` (transitions.ts) supplies those.
 */
import {
  LifecycleError,
  SHIPMENT_STATUSES,
  type Shipment,
  type ShipmentAction,
  type ShipmentStatus,
} from "./lifecycle.types";

export interface LifecycleConfig {
  /** Bounded redelivery dispatch cap — reaching it forces Return-to-Sender (blueprint 4.4). */
  readonly maxDeliveryAttempts: number;
}

interface Rule {
  readonly from: readonly ShipmentStatus[];
  /** Resolve the next status; may throw LifecycleError for a guard failure. */
  readonly next: (shipment: Shipment, cfg: LifecycleConfig) => ShipmentStatus;
}

const RULES: Record<ShipmentAction, Rule> = {
  collect: { from: ["booked"], next: () => "collected" },
  arriveOriginDepot: { from: ["collected"], next: () => "at-origin-depot" },
  loadTrunk: {
    from: ["at-origin-depot"],
    next: (s) => {
      if (s.isLocal) {
        throw new LifecycleError(
          "loadTrunk",
          "This is a local move (same hub) — there is no trunk leg. Send it out for delivery instead.",
        );
      }
      return "in-transit";
    },
  },
  // A pallet rolls (missed cut-off / no onward space) → parked at the hub awaiting a departure.
  // `transitions.ts` records WHICH hub it is held at so re-plan can send it back correctly.
  roll: { from: ["at-origin-depot", "at-destination-hub"], next: () => "at-hub-awaiting-space" },
  // Re-plan found a fresh departure → back to where it was parked (blueprint 3.1a): the destination
  // hub (awaiting last-mile) or the origin depot (awaiting trunk). Never forces a second trunk.
  replan: {
    from: ["at-hub-awaiting-space"],
    next: (s) => (s.heldAtHubId && s.heldAtHubId === s.destinationHubId ? "at-destination-hub" : "at-origin-depot"),
  },
  arriveDestinationHub: { from: ["in-transit"], next: () => "at-destination-hub" },
  outForDelivery: {
    from: ["at-destination-hub", "at-origin-depot"],
    next: (s, cfg) => {
      if (!s.isLocal && s.status === "at-origin-depot") {
        throw new LifecycleError(
          "outForDelivery",
          "This shipment still has a trunk leg to run — load the trunk first.",
        );
      }
      if (s.deliveryAttempts >= cfg.maxDeliveryAttempts) {
        throw new LifecycleError(
          "outForDelivery",
          `Delivery attempt cap (${cfg.maxDeliveryAttempts}) reached — this booking must go Return-to-Sender.`,
        );
      }
      return "out-for-delivery";
    },
  },
  deliver: { from: ["out-for-delivery"], next: () => "complete" },
  failDelivery: { from: ["out-for-delivery"], next: () => "failed-delivery" },
  reattempt: {
    from: ["failed-delivery"],
    next: (s, cfg) => {
      if (s.deliveryAttempts >= cfg.maxDeliveryAttempts) {
        throw new LifecycleError(
          "reattempt",
          `Delivery attempt cap (${cfg.maxDeliveryAttempts}) reached — this booking must go Return-to-Sender.`,
        );
      }
      return "out-for-delivery";
    },
  },
  // A booking parked awaiting space that never gets an onward leg must still reach a terminal state
  // (Rule 5) — RTS is its escape hatch, so it can never sit non-terminal forever.
  returnToSender: {
    from: ["out-for-delivery", "failed-delivery", "at-hub-awaiting-space"],
    next: () => "return-to-sender",
  },
  // Void a mis-booking (typo, duplicate, wrong customer) BEFORE the driver has actually collected
  // it. Once collected the pallet is physically in the network — that's a return-to-sender, not a
  // cancel — so this is only legal from "booked", never later.
  cancel: { from: ["booked"], next: () => "cancelled" },
};

/** Resolve the status a shipment moves to under `action`, or throw if the step is illegal. */
export function nextStatus(shipment: Shipment, action: ShipmentAction, cfg: LifecycleConfig): ShipmentStatus {
  const rule = RULES[action];
  if (!rule) throw new LifecycleError(action, `Unknown action "${action}".`);
  if (!rule.from.includes(shipment.status)) {
    throw new LifecycleError(action, `Cannot "${action}" from status "${shipment.status}".`);
  }
  return rule.next(shipment, cfg);
}

/** Which actions are legal from each status (for the UI to render only valid buttons). */
export const ACTIONS_BY_STATUS: Record<ShipmentStatus, ShipmentAction[]> = (() => {
  const map = {} as Record<ShipmentStatus, ShipmentAction[]>;
  for (const status of SHIPMENT_STATUSES) map[status] = [];
  for (const [action, rule] of Object.entries(RULES) as [ShipmentAction, Rule][]) {
    for (const from of rule.from) map[from].push(action);
  }
  return map;
})();
