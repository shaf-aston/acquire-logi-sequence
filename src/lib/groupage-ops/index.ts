/** Groupage-ops (lifecycle tracking) barrel — the public surface for the API/UI layers. */
export { bookGroupageQuote, transitionShipment, shipmentFromQuote } from "./service";
export { FileShipmentStore, InMemoryShipmentStore } from "./shipment.repository";
export type { ShipmentStore } from "./shipment.repository";
export { applyTransition } from "./transitions";
export { nextStatus, ACTIONS_BY_STATUS } from "./state-machine";
export type { LifecycleConfig } from "./state-machine";
export { buildManifests, legKeyOf, assertCapacityAvailable } from "./manifest";
export type { Manifest, ManifestShipment } from "./manifest";
export {
  isTerminal,
  LifecycleError,
  SHIPMENT_STATUSES,
  SHIPMENT_ACTIONS,
  TERMINAL_STATUSES,
} from "./lifecycle.types";
export type { Shipment, ShipmentStatus, ShipmentAction, ShipmentEvent, LegAssignment } from "./lifecycle.types";
