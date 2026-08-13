/**
 * Pure size-class inference for session-added vans.
 *
 * Groups the existing fleet by sizeClass, computes each band's median volume,
 * then assigns the nearest band to the new van. No hardcoded thresholds — the
 * classification adapts to whatever bands the operator has defined.
 *
 * Returns "Other" when no existing vans carry a sizeClass.
 */
import { volumeM3 } from "@/lib/packing/geometry";
import type { Van } from "@/lib/packing/packing.types";

/** Median of a non-empty sorted array. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

export function inferSizeClass(van: Van, fleet: Van[]): string {
  const groups = new Map<string, number[]>();
  for (const v of fleet) {
    if (!v.sizeClass) continue;
    const arr = groups.get(v.sizeClass) ?? [];
    arr.push(volumeM3(v.interior));
    groups.set(v.sizeClass, arr);
  }
  if (groups.size === 0) return "Other";

  const vol = volumeM3(van.interior);
  let nearest = "";
  let nearestDist = Infinity;

  // Sort entries by median so ties break toward the smaller class (predictable).
  const entries = [...groups.entries()].sort((a, b) => {
    const mA = median([...a[1]].sort((x, y) => x - y));
    const mB = median([...b[1]].sort((x, y) => x - y));
    return mA - mB;
  });

  for (const [cls, vols] of entries) {
    const med = median([...vols].sort((a, b) => a - b));
    const dist = Math.abs(vol - med);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = cls;
    }
  }

  return nearest || "Other";
}
