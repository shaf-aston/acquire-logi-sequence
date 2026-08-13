/**
 * Pure geometry helpers. All linear inputs are metres; outputs are m² / m³.
 */
import type { Dimensions, Vec3 } from "@/lib/packing/packing.types";

/** surface_m2 = l × h */
export function surfaceM2(l: number, h: number): number {
  return l * h;
}

/** volume_m3 = l × w × h */
export function volumeM3(d: Dimensions): number {
  return d.l * d.w * d.h;
}

/** volume_m3 for a Vec3 (x/y/z) — used for placement and interior volumes. */
export function volumeM3Vec3(v: Vec3): number {
  return v.x * v.y * v.z;
}
