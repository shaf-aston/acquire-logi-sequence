/**
 * Shared rotation-policy logic — the single source of truth for "which axis
 * permutations may this item be placed in," consumed by both the packer
 * (heuristic-packer.ts) and the coarse fleet-fit check (fleet-allocator.ts) so
 * the two never drift apart on what "upright" means.
 */
import type { OrientationLock } from "@/lib/classification/durability.types";

/** All 6 distinct axis permutations of (l,w,h). Index 0 is the natural orientation. */
export function allOrientations(l: number, w: number, h: number): [number, number, number][] {
  return [[l, w, h], [l, h, w], [w, l, h], [w, h, l], [h, l, w], [h, w, l]];
}

/**
 * Indices into allOrientations()'s result permitted under a rotation policy:
 *  - "fixed"   → natural orientation only (index 0).
 *  - "partial" → upright, any facing — keeps h on the vertical axis (indices 0, 2:
 *    [l,w,h] and [w,l,h] are the only two permutations that leave h last).
 *  - "none"    → all 6.
 */
export function permittedOrientationIndices(lock: OrientationLock): readonly number[] {
  if (lock === "fixed") return [0];
  if (lock === "partial") return [0, 2];
  return [0, 1, 2, 3, 4, 5];
}

/** Restrictiveness rank: fixed (tightest) > partial > none (loosest). */
const RESTRICTIVENESS: Readonly<Record<OrientationLock, number>> = { fixed: 2, partial: 1, none: 0 };

/**
 * The MORE restrictive of two rotation policies. Used to blend a material-derived
 * lock into a category default so material evidence can only TIGHTEN the rotation
 * policy, never loosen it — mirroring the maxStackPressureKpa `Math.min` blend
 * (item-assembler.ts). A material with no orientation keyword resolves to "none"
 * (absence of evidence, not proof it is tip-safe) and must not override a
 * deliberate category "fixed"/"partial".
 */
export function stricterOrientationLock(a: OrientationLock, b: OrientationLock): OrientationLock {
  return RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b;
}
