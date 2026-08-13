import { getConfig } from "@/config/env";
import type { Van } from "./packing.types";

/** Fuel-only rate adjusted for payload (for quote line items).
 *  Uplift at max payload comes from config (PACKING_FUEL_LOAD_UPLIFT). */
export function fuelRateForPayload(van: Van, payloadKg: number): number {
  const load = Math.min(1, payloadKg / Math.max(1, van.maxPayloadKg));
  return (van.fuelCostPerMile ?? 0) * (1 + getConfig().packing.fuelLoadUplift * load);
}

/** Effective £/mi for a van at a given placed payload. */
export function computeVanCostRate(van: Van, payloadKg: number): number {
  return van.perMileRate + fuelRateForPayload(van, payloadKg);
}

/** Total CO₂ (kg) a van emits over a billed distance. 0 when the van has no
 *  co2GramsPerMile configured — never guessed, config-only. */
export function co2KgForTrip(van: Van, billedMiles: number): number {
  return ((van.co2GramsPerMile ?? 0) * billedMiles) / 1000;
}
