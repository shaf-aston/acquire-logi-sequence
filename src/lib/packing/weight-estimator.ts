/**
 * Per-item weight. Arredo3 PDFs carry only a shipment-level gross weight, so when
 * a row has no explicit weight we estimate it from volume × the category's
 * fallback density (config/stackability.json). An explicit weight always wins.
 * Pure and deterministic.
 */
import { volumeM3 } from "@/lib/packing/geometry";
import type { Dimensions } from "@/lib/packing/packing.types";

export interface WeightInput {
  readonly dimensions: Dimensions | null;
  /** Weight parsed from the PDF, when present. null/0/undefined ⇒ estimate. */
  readonly explicitWeightKg?: number | null;
  /** Fallback density (kg/m³) from the resolved stacking rules. */
  readonly densityKgPerM3: number;
}

/** Returns a non-negative kg estimate; 0 when there is nothing to measure. */
export function estimateWeightKg(input: WeightInput): number {
  if (typeof input.explicitWeightKg === "number" && input.explicitWeightKg > 0) {
    return input.explicitWeightKg;
  }
  if (input.dimensions === null) return 0;
  return volumeM3(input.dimensions) * input.densityKgPerM3;
}
