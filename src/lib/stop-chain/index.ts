/**
 * Model-configuration wiring for the stop-chain engine.
 *
 * This is the ONE place model-specific choices are bolted onto the kind-blind engine: a stop-mix
 * validator + the real route provider per model. Delivery (1 pickup, N drops) and hub collection
 * (hub, N pickups, back to the hub) each get a factory; the engine never changes.
 *
 * The chain no longer packs (the fleet is packed by packer.service and reused), so there is no
 * packer/pack-order to wire here — only the route provider and the stop-mix validator.
 */
import { getRouteProvider } from "@/lib/routing";
import { deliveryValidator, collectionValidator } from "./validator";
import type { StopChainDeps } from "./engine";

export { quoteStopChain } from "./engine";
export type { StopChainJob, StopChainResult, StopChainDeps, StopChainPricingConfig } from "./engine";
export { StopChainError } from "./stop.types";
export type { Stop, StopKind } from "./stop.types";

/** Default delivery wiring: real route provider + the delivery stop-mix validator. */
export function createDeliveryStopChain(): StopChainDeps {
  return {
    routeProvider: getRouteProvider(),
    validate: deliveryValidator,
  };
}

/** Hub collection wiring: same route provider, collection stop-mix validator. */
export function createCollectionStopChain(): StopChainDeps {
  return {
    routeProvider: getRouteProvider(),
    validate: collectionValidator,
  };
}
