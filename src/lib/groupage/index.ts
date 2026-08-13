/**
 * Groupage module barrel — the public surface the API/service layers depend on. Mirrors
 * `stop-chain/index.ts`: re-export the engine entry points + the fail-loud error + the domain
 * types, keeping internal module paths private.
 */
export { getGroupageQuote, createGroupageDeps } from "./service";
export type { GroupageQuoteInput, GroupageQuoteResult, GroupageDeps } from "./service";
export { GroupageError } from "./groupage.types";
export type {
  Hub,
  GroupagePallet,
  GroupageQuote,
  GroupagePath,
  GroupageLeg,
  GroupageDemand,
  LegCapacityCheck,
  PalletFootprintClass,
  BindingLimit,
  RoutedPallet,
} from "./groupage.types";
export { resolveStops, stationsOf } from "./trunk-stops";
export { routePallets, legLoads } from "./leg-loads";
export { PALLET_FOOTPRINT_CLASSES } from "./groupage.types";
export { FileHubRepository, InMemoryHubRepository, HubConfigError } from "./hub.repository";
export type { HubRepository } from "./hub.repository";
export { loadGroupageRates, parseGroupageRates, GroupageRatesError } from "./groupage-rates";
export type { GroupageRates } from "./groupage-rates";
