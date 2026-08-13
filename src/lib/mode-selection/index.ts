/** Public surface of the quotation-driven mode decision. */
export { selectMode } from "./mode.selector";
export type { Direction, ModeRules, ModeSignals, ModeRecommendation } from "./mode.types";
/** Which quote form an uploaded manifest opens in — read off the document's own shape. */
export { routeManifest } from "./manifest-routing";
export type { QuoteMode, RoutingSignals, RoutingDecision } from "./manifest-routing";
