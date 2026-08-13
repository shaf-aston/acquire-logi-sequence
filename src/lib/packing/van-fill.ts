/**
 * Van fill diagnostics — "why isn't this van fuller?" — PURE geometry, no I/O.
 *
 * Kept free of the logger / config so it can be imported on BOTH sides: the
 * server-side `packing.debug` trace (pack-debug.ts) and the client-side far-right
 * debug panel share this one verdict function — one source of truth, no drift.
 *
 * The single most useful signal is the split between:
 *   - a van whose FLOOR is full but whose HEIGHT is unused, where a like-for-like
 *     unit could physically rest on a floored item (`couldStackLikeForLike`) — the
 *     fill was left on the table by the packer/allocator, not by a safety rule; and
 *   - a van where crush / weight / reach genuinely forbids a second layer.
 * That distinction tells us whether low fill is an optimisation miss (fixable) or a
 * physical limit (correct), without ever weakening a safety veto.
 */
import { computeUtilization, stackPressureKpa } from "@/lib/packing/placement-validator";
import type { Dimensions, Placement } from "@/lib/packing/packing.types";

/** Most of the floor is covered — beyond this, unused HEIGHT is the only way to grow fill. */
const FLOOR_FULL_FRACTION = 0.8;
/** Below this volume fill, a floor-full van is flagged as under-using its height. */
const UNDERFILLED_VOLUME_FRACTION = 0.65;
/** Payload at/above this fraction ⇒ the van is weight-limited, so low volume is expected. */
const WEIGHT_LIMITED_FRACTION = 0.9;
/** A placement sitting on the floor (z at/below this many metres). Mirrors FLOOR_EPS_M. */
const FLOOR_EPS_M = 0.001;

export type FillVerdict =
  | "empty"
  | "ok"
  | "sparse" // few items — neither floor nor height full
  | "weight-limited" // low volume but the payload ceiling is hit — correct, not waste
  | "height-unused-could-stack" // floor full, height free, a like unit COULD rest → left on table
  | "height-unused-blocked"; // floor full, height free, but crush/weight/reach forbids a 2nd layer

export interface VanFillDiagnostic {
  readonly volumeFill: number; // 0..1
  readonly floorFootprint: number; // 0..1
  readonly payloadFraction: number; // 0..1 — Σ weight / van payload limit
  readonly placed: number;
  readonly floored: number;
  readonly stacked: number;
  readonly usedHeightM: number; // highest box top
  readonly headroomM: number; // interior height − usedHeightM
  /** A copy of some floored item could physically rest on it (bear its own weight, under crush + reach). */
  readonly couldStackLikeForLike: boolean;
  readonly verdict: FillVerdict;
  /** One-line plain-English explanation of the verdict. */
  readonly reason: string;
}

/** Can a like-for-like copy of `base` rest on top of it, under crush, weight and reach limits? */
function canBearOwnCopy(base: Placement, maxReachHeightM: number | null): boolean {
  const footprintM2 = base.size.x * base.size.y;
  if (footprintM2 <= 0) return false;
  const topZ = base.position.z + base.size.z; // where the copy's base would sit
  if (maxReachHeightM !== null && topZ > maxReachHeightM) return false; // 2nd-layer base over reach
  if (base.weightKg > base.canSupportWeightKg) return false; // weight ceiling
  if (stackPressureKpa(base.weightKg, footprintM2) > base.maxStackPressureKpa) return false; // crush
  return true;
}

/**
 * Diagnose one van's fill. `hasUnplacedGlobal` = the fleet still has cargo that
 * didn't fit anywhere — it distinguishes "left height unused while cargo spilled
 * to other vans" (an optimisation miss) from "simply nothing left to stack".
 */
export function analyzeVanFill(
  placements: readonly Placement[],
  interior: Dimensions,
  opts: { maxReachHeightM: number | null; hasUnplacedGlobal: boolean; maxPayloadKg?: number },
): VanFillDiagnostic {
  const { volumeFill, floorFootprint } = computeUtilization(placements, interior);
  const totalWeightKg = placements.reduce((s, p) => s + p.weightKg, 0);
  const payloadFraction =
    opts.maxPayloadKg && opts.maxPayloadKg > 0 ? totalWeightKg / opts.maxPayloadKg : 0;
  const floored = placements.filter((p) => p.position.z <= FLOOR_EPS_M);
  const stacked = placements.length - floored.length;
  const usedHeightM = placements.reduce((h, p) => Math.max(h, p.position.z + p.size.z), 0);
  const headroomM = Math.max(0, interior.h - usedHeightM);
  const couldStackLikeForLike = floored.some((p) => canBearOwnCopy(p, opts.maxReachHeightM));

  const floorFull = floorFootprint >= FLOOR_FULL_FRACTION;
  const underfilled = volumeFill < UNDERFILLED_VOLUME_FRACTION;
  const weightLimited = payloadFraction >= WEIGHT_LIMITED_FRACTION;

  let verdict: FillVerdict;
  let reason: string;
  if (placements.length === 0) {
    verdict = "empty";
    reason = "no cargo placed in this van";
  } else if (underfilled && weightLimited) {
    verdict = "weight-limited";
    reason = "heavy cargo fills the weight limit before the space — low volume is expected";
  } else if (floorFull && underfilled && couldStackLikeForLike) {
    verdict = "height-unused-could-stack";
    reason = opts.hasUnplacedGlobal
      ? "floor full, height free, and a like unit could rest here — yet cargo spilled to other vans (fill left on the table)"
      : "floor full, height free, and a like unit could rest here — a second layer was not built";
  } else if (floorFull && underfilled) {
    verdict = "height-unused-blocked";
    reason = "floor full, height free, but crush / weight / reach forbids a second layer here";
  } else if (!floorFull && underfilled) {
    verdict = "sparse";
    reason = "few items — neither floor nor height is full";
  } else {
    verdict = "ok";
    reason = "well filled";
  }

  return {
    volumeFill,
    floorFootprint,
    payloadFraction,
    placed: placements.length,
    floored: floored.length,
    stacked,
    usedHeightM,
    headroomM,
    couldStackLikeForLike,
    verdict,
    reason,
  };
}
