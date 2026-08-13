/**
 * Stop-chain engine — shared domain types (§1A of multi-stop-full-load-plan.md).
 *
 * A run is an ordered list of stops. Each stop carries an address and a kind (pickup, drop, or
 * hub — a 3PL depot a collection run departs from). The engine is BLIND to the kind; the kind-mix
 * rule is supplied by an injected validator, and the packing band order by an injected strategy —
 * so the same engine drives delivery (1 pickup, N drops) and a hub collection loop
 * (hub, N pickups, back to the hub) by swapping config, not code.
 * Interleaved milk-runs are deliberately OUT of V1 — they would need interleaved zoning, not the
 * reversed-band strategy; revisit only with a validated need.
 */
export type StopKind = "pickup" | "drop" | "hub";

export interface Stop {
  readonly address: string;
  readonly kind: StopKind;
  /** Optional company/customer label the stop serves — carried through so a collection loop can
   *  show WHO each pickup is for (e.g. groupage origins). Purely informational: the engine is
   *  blind to it, exactly as it is to `kind`. Undefined ⇒ an anonymous address, as before. */
  readonly company?: string;
}

/** Which fail-loud check tripped — lets the transport layer point the operator at the right field. */
export type StopChainCheck = "stops" | "leg" | "fit";

/**
 * A fixable pause, never a dead end: carries which check failed and a plain-English message that
 * names the offending stop/leg and the exact thing to change (§4).
 */
export class StopChainError extends Error {
  constructor(
    readonly check: StopChainCheck,
    message: string,
  ) {
    super(message);
    this.name = "StopChainError";
  }
}
