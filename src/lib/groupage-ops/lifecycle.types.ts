/**
 * Groupage shipment lifecycle (blueprint Parts 2–4) — the MODELED operational layer.
 *
 * There is no physical barcode hardware in this system, so a "scan" is a **status transition**
 * driven from the API/UI, and a Shipment is the record that walks the blueprint's states:
 *   booked → collected → at-origin-depot → in-transit → at-destination-hub → out-for-delivery →
 *   complete, with exception branches (roll → awaiting-space, failed-delivery → reattempt, and the
 *   bounded terminal return-to-sender). Holds/ledger (1.5) are deferred — this tracks a booked
 *   shipment, it does not reserve capacity.
 */
import type { DualCapacity, GroupageLegKind } from "@/lib/groupage/groupage.types";

export const SHIPMENT_STATUSES = [
  "booked",
  "collected",
  "at-origin-depot",
  "in-transit",
  "at-hub-awaiting-space",
  "at-destination-hub",
  "out-for-delivery",
  "failed-delivery",
  "complete",
  "return-to-sender",
  "cancelled",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** The states from which no further action is possible (blueprint Rule 5: always terminal). */
export const TERMINAL_STATUSES: readonly ShipmentStatus[] = ["complete", "return-to-sender", "cancelled"];
export function isTerminal(status: ShipmentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const SHIPMENT_ACTIONS = [
  "collect",
  "arriveOriginDepot",
  "loadTrunk",
  "roll",
  "replan",
  "arriveDestinationHub",
  "outForDelivery",
  "deliver",
  "failDelivery",
  "reattempt",
  "returnToSender",
  "cancel",
] as const;
export type ShipmentAction = (typeof SHIPMENT_ACTIONS)[number];

/** One leg the shipment travels, copied from the quote path (carries capacity for manifests). */
export interface LegAssignment {
  readonly kind: GroupageLegKind;
  readonly from: string;
  readonly to: string;
  readonly fromHubId?: string;
  readonly toHubId?: string;
  readonly capacity: DualCapacity;
}

export interface ShipmentEvent {
  readonly at: string;
  readonly action: ShipmentAction | "book";
  readonly from: ShipmentStatus | null;
  readonly to: ShipmentStatus;
  readonly note?: string;
}

export interface Shipment {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: ShipmentStatus;
  /** Same-hub move (no trunk leg) — gates the local delivery short-cut in the state machine. */
  readonly isLocal: boolean;
  readonly originPostcode: string;
  readonly destinationPostcode: string;
  readonly originHubId: string;
  readonly destinationHubId: string;
  /** When rolled to "at-hub-awaiting-space", the hub it is parked at — so re-plan returns it to the
   *  right place (origin vs destination hub) instead of forcing a physically-impossible second trunk. */
  readonly heldAtHubId?: string;
  readonly legs: readonly LegAssignment[];
  readonly demand: { readonly footprints: number; readonly weightKg: number; readonly palletCount: number };
  readonly total: number;
  readonly currencySymbol: string;
  readonly eta: string | null;
  /** Count of delivery dispatches so far — the bounded counter behind the attempt cap. */
  readonly deliveryAttempts: number;
  readonly history: readonly ShipmentEvent[];
}

/** Fail-loud lifecycle error — an illegal transition or a breached cap. `action` names the attempt. */
export class LifecycleError extends Error {
  readonly action: ShipmentAction;
  constructor(action: ShipmentAction, message: string) {
    super(message);
    this.name = "LifecycleError";
    this.action = action;
  }
}
