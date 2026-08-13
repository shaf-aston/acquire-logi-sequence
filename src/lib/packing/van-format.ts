/**
 * Client-safe van presentation helpers. Pure functions over plain dimensions, so
 * both the server (pricing calculator) and the browser (result panels) share one
 * description format instead of re-implementing it. No I/O, no config reads.
 */
import type { Dimensions } from "@/lib/packing/packing.types";

/**
 * Human description of a van WITHOUT its commercial model name, e.g.
 * "4.32 × 1.78 × 1.94 m · up to 1600 kg". Used wherever the client-facing UI
 * refers to a selected vehicle by capability rather than brand; the brand/id
 * lives only in the dedicated fleet-reference table.
 */
export function describeVan(interior: Dimensions, maxPayloadKg: number): string {
  return `${interior.l.toFixed(2)} × ${interior.w.toFixed(2)} × ${interior.h.toFixed(2)} m · up to ${maxPayloadKg} kg`;
}
