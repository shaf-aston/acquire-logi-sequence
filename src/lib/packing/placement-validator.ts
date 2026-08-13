/**
 * Pure placement-constraint module — the single source of truth for "may this box
 * sit here?". Extracted from the heuristic packer so the auto-packer and the
 * interactive 3D drag (Stage 4) enforce *identical* rules. No Node/DOM deps: this
 * file is imported by both the server packer and the React client.
 *
 * Coordinate system matches packing.types: origin at one bottom corner, x = van
 * length (l), y = width (w), z up (h), all metres. "Touching faces do not
 * overlap" — boxes may sit flush against each other.
 */
import { volumeM3, volumeM3Vec3 } from "@/lib/packing/geometry";
import type { Dimensions, Placement, Vec3 } from "@/lib/packing/packing.types";

/** Items whose base sits within this many m of z=0 count as resting on the floor. 0.001 m = 1 mm. */
export const FLOOR_EPS_M = 0.001;

/**
 * Slack on the crush/weight-ceiling comparisons. The packer sums a bearer's resting
 * load through a spatial index; the whole-arrangement verify gate sums the same boxes
 * via a full scan — a different order, so a stack sitting EXACTLY at capacity rounds to
 * ~1e-14 over on one side and the strict `>` would falsely reject an otherwise-legal
 * plan (observed on large orders). These epsilons absorb that float noise only: a
 * genuine overload is grams-to-kilograms / whole-kPa, orders of magnitude above them.
 */
const WEIGHT_EPS_KG = 1e-6; // 1 milligram
const PRESSURE_EPS_KPA = 1e-6;

/**
 * Slack on the geometric overlap test, the sibling of WEIGHT_EPS_KG / PRESSURE_EPS_KPA above
 * and for the same reason. The packer places boxes flush (a right neighbour's x equals its
 * left box's exact end face), then the zoned packer TRANSLATES each band by `xCursor`
 * (zoned-packer.ts). FP addition is non-associative, so a flush pair both shifted by the same
 * cursor compares `(A.x+A.size.x)+xCursor` against `(A.x+xCursor)+A.size.x` — the same three
 * addends in a different order, differing by ~1 ULP (~3.5e-15 m at a 13 m van; ~2e-6 m after a
 * float32 editor round-trip). The strict `<` below would read that sub-atomic gap as an overlap
 * and the whole-arrangement verify gate would falsely reject an otherwise-legal plan (observed
 * on dense multi-drop loads). 1e-4 m = 0.1 mm swallows both noise scales yet stays 100× under
 * the smallest real box, so a genuine interpenetration (≥ cm) is still caught. NOT `toleranceM`
 * (5 mm) — that would let real boxes interpenetrate 5 mm.
 */
const OVERLAP_EPS_M = 1e-4;

/** Standard gravity (m/s²) for the vertical-pressure model. */
const G = 9.80665;

/**
 * Downward pressure (kPa) that a mass of `weightKg` exerts over a contact face of
 * `areaM2`:  P = (m · g) / A.  Vertical only — horizontal forces and an item's
 * own internal/self weight are out of scope for this model (assumptions stated by
 * design). A non-positive area is treated as infinite pressure (refuse).
 */
export function stackPressureKpa(weightKg: number, areaM2: number): number {
  if (areaM2 <= 0) return Infinity;
  return (weightKg * G) / areaM2 / 1000; // Pa → kPa
}

/**
 * Inverse of `stackPressureKpa`: the SINGLE source of truth for "how much weight
 * (kg) may this face bear before it exceeds `maxStackPressureKpa`?" — used by
 * consolidation.ts's intra-block crush math (residual capacity, layer count) so
 * that math and the forward pressure check above can never drift apart.
 *
 * Algebra (must stay the exact inverse of stackPressureKpa above):
 *   forward:  P = (w · G) / A / 1000                (kPa)
 *   inverse:  w = P · 1000 · A / G                   (kg)
 * `stackPressureKpa` treats a non-positive area as infinite pressure (refuse) —
 * the inverse mirrors that: zero area can bear zero weight before "infinite"
 * pressure is exceeded by any positive load.
 */
export function maxBearableKg(maxStackPressureKpa: number, areaM2: number): number {
  if (areaM2 <= 0) return 0;
  return (maxStackPressureKpa * 1000 * areaM2) / G;
}

/**
 * The reach-limit rejection reason — one short string, shared by the interactive
 * drag/rotate/drop gate here and the auto-packer (heuristic-packer.ts), so the
 * two never drift into two different-length explanations of the same thing.
 */
export function reachLimitReason(maxReachHeightM: number): string {
  return `too high — over the ${maxReachHeightM}m reach limit`;
}

/** A box considered for placement — geometry, mass, and fragility (for the gate). */
export interface PlacementCandidate {
  readonly position: Vec3;
  readonly size: Vec3;
  readonly weightKg: number;
  /** True ⇒ fragile. A fragile item may only rest on another fragile item. */
  readonly fragile: boolean;
}

/**
 * A neighbour lookup: the placed boxes whose footprint may overlap a queried
 * region, in insertion order. When supplied (by the packer, backed by a spatial
 * index) every overlap/support scan consults only nearby boxes instead of the
 * whole list — a pure speed-up that returns a superset the exact predicates then
 * re-filter, so the verdict is unchanged. Absent, the checks scan `others`.
 */
export type Neighbors = (footprint: Rect) => readonly Placement[];

/**
 * Everything a candidate is validated against. `others` is every OTHER placement
 * already in the van — callers exclude the box being moved themselves (by index),
 * which avoids the ambiguity of excluding by itemId when several units share an id.
 */
export interface ValidationContext {
  readonly others: readonly Placement[];
  readonly interior: Dimensions;
  readonly toleranceM: number;
  /**
   * Highest a worker may place an item's BASE by hand (m) — undefined means no
   * limit. Checked against `position.z` only: an item's own height above that is
   * fine, since it was lowered into place rather than reached into.
   */
  readonly maxReachHeightM?: number;
  /**
   * Optional spatial-index neighbour lookup. When present, overlap and support
   * checks query it (a superset of `others` near the region) instead of scanning
   * `others` — identical verdicts, far fewer comparisons on a full van.
   */
  readonly neighbors?: Neighbors;
}

export interface ValidationResult {
  readonly ok: boolean;
  /** Human-readable failure cause, present only when `ok` is false. */
  readonly reason?: string;
}

/** Does the box lie wholly inside the van interior (within clearance slack)? */
export function fitsInterior(
  position: Vec3,
  size: Vec3,
  interior: Dimensions,
  tol: number,
): boolean {
  return (
    position.x >= -tol &&
    position.y >= -tol &&
    position.z >= -tol &&
    position.x + size.x <= interior.l + tol &&
    position.y + size.y <= interior.w + tol &&
    position.z + size.z <= interior.h + tol
  );
}

/**
 * Overlap on all three axes (touching faces do not overlap). The overlap must EXCEED
 * OVERLAP_EPS_M on every axis to count: a flush contact penetrates by ≤1 ULP of float noise
 * and drops out, while a real interpenetration (≥ cm) passes easily. See OVERLAP_EPS_M.
 */
function intersects(pos: Vec3, size: Vec3, p: Placement): boolean {
  return (
    pos.x + OVERLAP_EPS_M < p.position.x + p.size.x && p.position.x + OVERLAP_EPS_M < pos.x + size.x &&
    pos.y + OVERLAP_EPS_M < p.position.y + p.size.y && p.position.y + OVERLAP_EPS_M < pos.y + size.y &&
    pos.z + OVERLAP_EPS_M < p.position.z + p.size.z && p.position.z + OVERLAP_EPS_M < pos.z + size.z
  );
}

/** First placement the box collides with, or null when the space is clear. */
export function firstOverlap(
  pos: Vec3,
  size: Vec3,
  others: readonly Placement[],
): Placement | null {
  for (const p of others) if (intersects(pos, size, p)) return p;
  return null;
}

export function hasOverlap(pos: Vec3, size: Vec3, others: readonly Placement[]): boolean {
  return firstOverlap(pos, size, others) !== null;
}

/** Does `lower` fully cover `upper`'s footprint (within tolerance) at a matching z-interface? */
function coversFootprint(
  lower: Pick<Placement, "position" | "size">,
  upperX0: number,
  upperX1: number,
  upperY0: number,
  upperY1: number,
  upperZ: number,
  tol: number,
): boolean {
  const top = lower.position.z + lower.size.z;
  if (Math.abs(top - upperZ) > tol) return false;
  return (
    lower.position.x - tol <= upperX0 &&
    lower.position.x + lower.size.x + tol >= upperX1 &&
    lower.position.y - tol <= upperY0 &&
    lower.position.y + lower.size.y + tol >= upperY1
  );
}

/**
 * Total weight actually resting THROUGH `bearing` — the load that physically flows
 * down onto its top face. Reaches transitively by walking the real support chain:
 * only boxes whose BASE meets `bearing`'s top face rest on it directly, and each
 * such box carries its own weight PLUS whatever rests on it, prorated by how much
 * of its footprint sits on `bearing`. Composite support is handled by that
 * proration — a box straddling `bearing` and a neighbour charges only its share
 * here, never its full weight (double-charged to both) nor zero.
 *
 * The naive "any box overhanging `bearing` in x/y and floating above its top"
 * rule is WRONG: a box resting on a DIFFERENT pillar in an adjacent column can
 * overhang `bearing`'s footprint while sitting higher, yet its weight runs down
 * its own column and never touches `bearing`. Counting it charged phantom
 * kilograms onto `bearing` — enough to fail the crush check, so the packer would
 * build a legal plan and the whole-arrangement verify gate would then reject that
 * same plan ("too heavy for the stack below"). Walking directly-resting boxes and
 * recursing up the true chain charges each bearer exactly the load it carries, so
 * the two paths agree. Terminates: every recursion steps strictly upward in z.
 * Excludes `bearing` itself (its own self-weight is out of the model).
 */
function weightRestingOn(bearing: Placement, neighbors: Neighbors, tol: number): number {
  const bRect = rectOf(bearing);
  const bTop = bearing.position.z + bearing.size.z;
  let sum = 0;
  for (const p of neighbors(bRect)) {
    if (p === bearing) continue;
    // Only a box whose base is flush with `bearing`'s top rests on it directly;
    // one floating higher is carried by its own column, not by `bearing`.
    if (Math.abs(p.position.z - bTop) > tol) continue;
    const overlapM2 = overlapArea(rectOf(p), bRect);
    if (overlapM2 <= 0) continue;
    const areaM2 = p.size.x * p.size.y;
    const share = areaM2 > 0 ? overlapM2 / areaM2 : 1;
    // p's own weight plus everything stacked on p, prorated to p's contact on `bearing`.
    sum += (p.weightKg + weightRestingOn(p, neighbors, tol)) * share;
  }
  return sum;
}

/** Axis-aligned footprint (m) of a box on the x/y plane. */
interface Rect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

function rectOf(p: Placement): Rect {
  return { x0: p.position.x, x1: p.position.x + p.size.x, y0: p.position.y, y1: p.position.y + p.size.y };
}

/** Overlap area (m²) of two footprints — 0 when they don't intersect. */
function overlapArea(a: Rect, b: Rect): number {
  const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const oy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  return ox * oy;
}

/**
 * Exact "is `foot` fully covered by the union of `bearers`?" for axis-aligned
 * rectangles, via coordinate compression: slice `foot` into sub-cells on every
 * bearer edge that falls inside it, then require each sub-cell's centre to lie in
 * some bearer (expanded by `tol` so sub-millimetre seams between two touching
 * bearers don't read as a gap). This is what lets a box rest across TWO or more
 * boxes side-by-side — the packer's old "must rest fully on ONE base" rule wrongly
 * rejected that. No sampling error: sub-cells are bounded by real edges, so a
 * cell is either wholly inside a bearer or wholly outside it.
 */
function unionCovers(foot: Rect, bearers: readonly Placement[], tol: number): boolean {
  const xs = new Set<number>([foot.x0, foot.x1]);
  const ys = new Set<number>([foot.y0, foot.y1]);
  for (const b of bearers) {
    const r = rectOf(b);
    for (const x of [r.x0, r.x1]) if (x > foot.x0 && x < foot.x1) xs.add(x);
    for (const y of [r.y0, r.y1]) if (y > foot.y0 && y < foot.y1) ys.add(y);
  }
  const xa = [...xs].sort((p, q) => p - q);
  const ya = [...ys].sort((p, q) => p - q);
  for (let i = 0; i < xa.length - 1; i++) {
    if (xa[i + 1]! - xa[i]! <= tol) continue; // sliver within clearance — ignore
    const cx = (xa[i]! + xa[i + 1]!) / 2;
    for (let j = 0; j < ya.length - 1; j++) {
      if (ya[j + 1]! - ya[j]! <= tol) continue;
      const cy = (ya[j]! + ya[j + 1]!) / 2;
      const covered = bearers.some((b) => {
        const r = rectOf(b);
        return r.x0 - tol <= cx && cx <= r.x1 + tol && r.y0 - tol <= cy && cy <= r.y1 + tol;
      });
      if (!covered) return false;
    }
  }
  return true;
}

/**
 * Walks the single-cover support column strictly BELOW `bearing` (bearing →
 * whatever fully covers it → … → floor), charging `candShareKg` — the portion of
 * the new box's weight that flows down through `bearing` — onto every level. At
 * each interface it checks, against that bearing's own limits, the TOTAL it
 * carries (the descending share plus every box already resting on it — siblings
 * on a shared wide base included): the vertical crush pressure AND the absolute
 * weight ceiling (`canSupportWeightKg`). Fails safe: if a level off the floor has
 * no single item fully covering it (a deep composite junction we can't prove the
 * crush path through), it refuses rather than assume the stack below is sound.
 */
function columnBelowHolds(
  bearing: Placement,
  candShareKg: number,
  neighbors: Neighbors,
  tol: number,
): ValidationResult {
  let current = bearing;
  for (;;) {
    if (current.position.z <= FLOOR_EPS_M) return { ok: true }; // reached the floor
    const cx0 = current.position.x;
    const cx1 = current.position.x + current.size.x;
    const cy0 = current.position.y;
    const cy1 = current.position.y + current.size.y;
    const contactAreaM2 = current.size.x * current.size.y;
    // Anything covering `current`'s footprint overlaps it, so it's within this query.
    const next = neighbors({ x0: cx0, x1: cx1, y0: cy0, y1: cy1 }).find(
      (q) => q !== current && coversFootprint(q, cx0, cx1, cy0, cy1, current.position.z, tol),
    );
    if (!next) return { ok: false, reason: "the stack below can't be verified as safe" };
    const loadKg = candShareKg + weightRestingOn(next, neighbors, tol);
    if (stackPressureKpa(loadKg, contactAreaM2) > next.maxStackPressureKpa + PRESSURE_EPS_KPA) {
      return { ok: false, reason: "too heavy for the stack below (would crush it)" };
    }
    if (loadKg > next.canSupportWeightKg + WEIGHT_EPS_KG) {
      return { ok: false, reason: "exceeds what the stack below can safely carry" };
    }
    current = next;
  }
}

/**
 * A stacked box must rest on a set of bearers whose top faces meet its base and
 * whose footprints TOGETHER cover it (one wide base, or several side-by-side).
 * Every contributing bearer must satisfy, for the load it takes:
 *
 *   1. Fragility compatibility — a fragile box may rest only on fragile bases; a
 *      standard box never on a fragile one. An incompatible box under the
 *      footprint can't bear the load and physically blocks any other bearer from
 *      covering that patch, so the box is unsupported there.
 *   2. Crush limit — the interface pressure (uniform = weight / footprint area
 *      across all bearers) must not exceed any bearer's `maxStackPressureKpa`,
 *      cumulatively down each bearer's support column (columnBelowHolds). A
 *      brittle bearer isn't a separate rule here: its crush limit is already cut
 *      by `brittleFactor` upstream (item-assembler.ts), so it's judged by this
 *      same check with a much lower number — never a hard veto.
 *   3. Weight ceiling — the total mass resting on any bearer (its share of this
 *      box plus whatever already sits on it) must not exceed its
 *      `canSupportWeightKg`.
 *
 * Total mass is still bounded globally by the van payload. Returns a reason on
 * failure for the drag UI; callers wanting a plain boolean use `isSupported`.
 */
function supportCheck(
  pos: Vec3,
  size: Vec3,
  weightKg: number,
  fragile: boolean,
  neighbors: Neighbors,
  tol: number,
): ValidationResult {
  const foot: Rect = { x0: pos.x, x1: pos.x + size.x, y0: pos.y, y1: pos.y + size.y };
  const areaM2 = size.x * size.y;
  if (areaM2 <= 0) return { ok: false, reason: "not supported from below" };

  // Boxes whose top face meets this box's base and sit under some of its footprint.
  const atLevel = neighbors(foot).filter(
    (p) => Math.abs(p.position.z + p.size.z - pos.z) <= tol && overlapArea(foot, rectOf(p)) > 0,
  );
  // Only compatible boxes can actually bear the load. Brittle bearers ARE
  // eligible — their reduced crush limit (item-assembler.ts) does the work below.
  const bearers = atLevel.filter((p) => !(p.fragile && !fragile));

  if (!unionCovers(foot, bearers, tol)) {
    if (atLevel.some((p) => p.fragile && !fragile)) {
      return { ok: false, reason: "a standard item can't rest on a fragile one" };
    }
    return { ok: false, reason: "not fully supported from below" };
  }

  const pressureKpa = stackPressureKpa(weightKg, areaM2);
  for (const b of bearers) {
    const share = overlapArea(foot, rectOf(b));
    if (share <= 0) continue;
    if (pressureKpa > b.maxStackPressureKpa + PRESSURE_EPS_KPA) {
      return { ok: false, reason: "too heavy for the item below (would crush it)" };
    }
    const shareKg = weightKg * (share / areaM2);
    if (weightRestingOn(b, neighbors, tol) + shareKg > b.canSupportWeightKg + WEIGHT_EPS_KG) {
      return { ok: false, reason: "exceeds what the base can safely carry" };
    }
    const below = columnBelowHolds(b, shareKg, neighbors, tol);
    if (!below.ok) return below;
  }
  return { ok: true };
}

/** Plain-boolean support test (composite-aware). See `supportCheck` for the rules. */
export function isSupported(
  pos: Vec3,
  size: Vec3,
  weightKg: number,
  fragile: boolean,
  others: readonly Placement[],
  tol: number,
): boolean {
  // No index here: scan all others (the constant-fold fallback preserves old behaviour).
  return supportCheck(pos, size, weightKg, fragile, () => others, tol).ok;
}

/**
 * How much load is currently pressing on one placed box, versus how much it can
 * take — the data behind the UI "weight on top" column and overload flag. The user
 * means crush PRESSURE (`maxStackPressureKpa`), not kilograms.
 */
export interface StackLoad {
  /** Total mass resting on this box's top face (kg) — the "weight on top" number. */
  readonly restingKg: number;
  /** Worst interface crush pressure this box bears (kPa), computed the way the
   *  validator does: each directly-resting box presses over ITS OWN footprint,
   *  carrying its own weight plus whatever sits on it. Drives the meter fill. */
  readonly pressureKpa: number;
  /** This box's crush limit (kPa). */
  readonly capacityKpa: number;
  /** pressureKpa / capacityKpa; 0 when unloaded, Infinity when loaded past a 0 limit. */
  readonly ratio: number;
  /** THE SAFETY FLAG — the validator's own verdict, not a parallel model: true when
   *  some box resting directly on this one fails `isSupported` against the rest of
   *  the layout (i.e. the packer/drag would refuse this stack). Covers both of the
   *  validator's grounds — crush pressure at the correct footprint and weight
   *  ceiling — so it can never read safe where the validator refuses. A brittle
   *  bearer's much-lower crush limit (item-assembler.ts) flows through the same
   *  pressure check, not a separate ground. May fire without `ratio > 1` in
   *  composite stacks; the flag is authoritative, the meter is the human-readable
   *  estimate. */
  readonly overloaded: boolean;
}

/**
 * Per-box load report, aligned index-for-index to `placements` (expanded units may
 * share an itemId, so callers index by position — matching the placements table and
 * the 3D scene). Pure: reuses `weightRestingOn`, `stackPressureKpa`, `isSupported`,
 * and the private `rectOf`/`overlapArea`. Only fires after placement, so it surfaces
 * a stack made unsafe by a later edit (e.g. lowering a bearer's on-top-load tier).
 */
export function stackLoadByPlacement(placements: readonly Placement[], tol: number): StackLoad[] {
  const allPlacements: Neighbors = () => placements;
  return placements.map((p, i) => {
    const restingKg = weightRestingOn(p, allPlacements, tol);
    const pTop = p.position.z + p.size.z;
    const pRect = rectOf(p);
    // Boxes whose base meets p's top face and overlap its footprint.
    const directlyOn = placements.filter(
      (u, j) => j !== i && Math.abs(u.position.z - pTop) <= tol && overlapArea(rectOf(u), pRect) > 0,
    );
    // Interface pressure per the validator: the pressing box's OWN footprint, under
    // its own weight plus whatever rests on it; worst directly-resting box wins.
    let pressureKpa = 0;
    for (const u of directlyOn) {
      const through = u.weightKg + weightRestingOn(u, allPlacements, tol);
      pressureKpa = Math.max(pressureKpa, stackPressureKpa(through, u.size.x * u.size.y));
    }
    const capacityKpa = p.maxStackPressureKpa;
    const ratio = pressureKpa <= 0 ? 0 : capacityKpa <= 0 ? Infinity : pressureKpa / capacityKpa;
    // The flag IS the validator's verdict: does any box resting on p become
    // unsupported (crush / weight ceiling) when checked against the layout?
    const overloaded = directlyOn.some(
      (u) => !isSupported(u.position, u.size, u.weightKg, u.fragile, placements.filter((q) => q !== u), tol),
    );
    return { restingKg, pressureKpa, capacityKpa, ratio, overloaded };
  });
}

/**
 * Full gate: bounds → overlap → support (in detection order, most specific cause
 * wins). A box on the floor (z≈0) skips the support check. Returns the first
 * failure with a human-readable reason for the drag UI; `{ ok: true }` otherwise.
 */
export function validatePlacement(
  candidate: PlacementCandidate,
  ctx: ValidationContext,
): ValidationResult {
  const { position, size, weightKg, fragile } = candidate;
  const { others, interior, toleranceM: tol, maxReachHeightM } = ctx;
  // Prefer the spatial index when the caller supplied one; otherwise scan all others
  // (the fallback returns the full list, so the verdict is identical either way).
  const neighbors: Neighbors = ctx.neighbors ?? (() => others);

  if (!fitsInterior(position, size, interior, tol)) {
    return { ok: false, reason: "exceeds van bounds" };
  }
  if (maxReachHeightM !== undefined && position.z > maxReachHeightM + tol) {
    return { ok: false, reason: reachLimitReason(maxReachHeightM) };
  }
  const foot: Rect = { x0: position.x, x1: position.x + size.x, y0: position.y, y1: position.y + size.y };
  const hit = firstOverlap(position, size, neighbors(foot));
  if (hit !== null) {
    return { ok: false, reason: `overlaps ${hit.itemId}` };
  }
  if (position.z > 0) {
    const support = supportCheck(position, size, weightKg, fragile, neighbors, tol);
    if (!support.ok) return support;
  }
  return { ok: true };
}

/**
 * Whole-layout gate: every placement must independently pass `validatePlacement`
 * against all the others, AND no non-stackable item may rest off the floor. The
 * interactive editor uses this at COMMIT time — a per-box drag/rotate preview only
 * checks the box under the cursor, so it can't see that MOVING a base out from
 * under a stack leaves the upper boxes unsupported. This catches such an edit and
 * refuses it, so a manual edit never silently commits a floating (orphaned) box —
 * the safety invariant a per-box check alone cannot hold. Runs once per edit (not
 * per animation frame), so the O(n²) pass is inexpensive.
 */
export function validateArrangement(
  placements: readonly Placement[],
  interior: Dimensions,
  tol: number,
  maxReachHeightM?: number,
): ValidationResult {
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i]!;
    const others = placements.filter((_, j) => j !== i);
    const v = validatePlacement(
      { position: p.position, size: p.size, weightKg: p.weightKg, fragile: p.fragile },
      { others, interior, toleranceM: tol, maxReachHeightM },
    );
    if (!v.ok) return v;
    if (p.position.z > FLOOR_EPS_M && !p.stackable) {
      return { ok: false, reason: "a non-stackable item is resting off the floor" };
    }
  }
  return { ok: true };
}

/**
 * Recompute every placement's manual-override `flagged` state honestly after an edit.
 * A box is flagged when it fails the per-box gate (bounds / reach / overlap / support /
 * crush) OR is a non-stackable resting off the floor — the exact invariants
 * `validateArrangement` enforces, but instead of rejecting the whole layout it MARKS the
 * offending boxes so the operator's forced ("place it anyway") arrangement can commit while
 * every unsafe box shows amber. Boxes back in a valid spot are cleared. This is what keeps
 * the "never guess" surface truthful: the moved box AND anything it orphaned (e.g. a base
 * pulled out from under a stack) both light up, never a silent floating box. Pure and
 * commit-time only (O(n²), same cost as validateArrangement) — object identity is preserved
 * for any box whose flag state didn't change, so memoized ItemBoxes don't needlessly redraw.
 */
export function reconcileFlags(
  placements: readonly Placement[],
  interior: Dimensions,
  tol: number,
  maxReachHeightM?: number,
): Placement[] {
  return placements.map((p, i) => {
    const others = placements.filter((_, j) => j !== i);
    const v = validatePlacement(
      { position: p.position, size: p.size, weightKg: p.weightKg, fragile: p.fragile },
      { others, interior, toleranceM: tol, maxReachHeightM },
    );
    let ok = v.ok;
    let reason = v.reason;
    if (ok && p.position.z > FLOOR_EPS_M && !p.stackable) {
      ok = false;
      reason = "a non-stackable item is resting off the floor";
    }
    if (ok) return p.flagged ? { ...p, flagged: false, flagReason: undefined } : p;
    return p.flagged && p.flagReason === reason ? p : { ...p, flagged: true, flagReason: reason ?? "outside safe limits" };
  });
}

/**
 * Where a dragged box settles. Finds the highest support under its footprint and
 * snaps x/y so the box rests fully on that support — without the snap, a hand-
 * positioned box almost never aligns within tolerance, so isSupported's coverage
 * check fails and vertical stacking is effectively impossible in the UI. Returns
 * the floor (z=0, x/y unchanged) when nothing is underneath, or when the box is
 * too large to be covered by the support (it then stays put and the caller's
 * validation reports it unsupported).
 */
export function resolveDrop(
  x: number,
  y: number,
  size: Vec3,
  others: readonly Placement[],
): { x: number; y: number; z: number } {
  const overlapsXY = (p: Placement) =>
    x < p.position.x + p.size.x && p.position.x < x + size.x &&
    y < p.position.y + p.size.y && p.position.y < y + size.y;

  let top = 0;
  let found = false;
  for (const p of others) {
    if (overlapsXY(p) && p.position.z + p.size.z >= top) {
      top = p.position.z + p.size.z;
      found = true;
    }
  }
  if (!found) return { x, y, z: 0 };

  // Every support meeting this highest interface under the footprint — one wide
  // base, or several side by side. Snap the box into their COMBINED extent when it
  // fits, so a box too big for any single base still settles across them (composite
  // support). A single support is just the one-element case (old behaviour intact).
  const level = others.filter((p) => overlapsXY(p) && Math.abs(p.position.z + p.size.z - top) < 1e-6);
  const minX = Math.min(...level.map((p) => p.position.x));
  const maxX = Math.max(...level.map((p) => p.position.x + p.size.x));
  const minY = Math.min(...level.map((p) => p.position.y));
  const maxY = Math.max(...level.map((p) => p.position.y + p.size.y));
  if (size.x <= maxX - minX + 1e-9) x = Math.max(minX, Math.min(x, maxX - size.x));
  if (size.y <= maxY - minY + 1e-9) y = Math.max(minY, Math.min(y, maxY - size.y));
  return { x, y, z: top };
}

/**
 * After a placement is removed (unplaced / deleted), whatever was resting on it
 * must not float. Re-settles the REMAINING placements bottom-up: each is
 * re-dropped (via `resolveDrop`) onto whatever now-settled items are underneath
 * it, in ascending original-height order, so a multi-level stack collapses one
 * level at a time rather than only fixing whatever sat directly on the removed
 * box. An item that can no longer be validly supported anywhere (crush/reach/
 * stackability failure — resting on empty floor always validates) is displaced:
 * returned separately so the caller sends it back to Unplaced instead of
 * committing a floating or invalid box. Items whose support didn't change land
 * back at their original position (idempotent no-op for the rest of the stack).
 *
 * The ascending-z order above is a PROCESSING detail only (drop/support checks
 * must see lower items settle first). The returned `settled` array preserves the
 * CALLER's original relative order of the surviving placements — the caller
 * (PackingResultPanel) commits it verbatim and every UI badge/table row is
 * index-based, so silently reordering here would renumber every other item on
 * an unrelated unplace. Achieved by keying each settled result to its original
 * index (`settledAt`) and only reading them back out in that order at the end.
 */
export function cascadeAfterRemoval(
  placements: readonly Placement[],
  removedIndex: number,
  interior: Dimensions,
  tol: number,
  maxReachHeightM?: number,
): { settled: Placement[]; displaced: Placement[] } {
  const remaining = placements.filter((_, i) => i !== removedIndex);
  const order = remaining
    .map((_, i) => i)
    .sort((a, b) => remaining[a]!.position.z - remaining[b]!.position.z);

  // Keyed by original index within `remaining` — read back out in that order
  // at the end so the returned array matches the caller's original ordering.
  const settledAt: (Placement | undefined)[] = new Array(remaining.length);
  // Ascending-z working arrangement, used only to resolve drops/support for
  // items not yet processed — order here is deliberately z-order, not caller order.
  const processed: Placement[] = [];
  const displaced: Placement[] = [];
  for (const i of order) {
    const p = remaining[i]!;
    const drop = resolveDrop(p.position.x, p.position.y, p.size, processed);
    const candidate: Placement = { ...p, position: drop };
    const verdict = validatePlacement(
      { position: candidate.position, size: candidate.size, weightKg: candidate.weightKg, fragile: candidate.fragile },
      { others: processed, interior, toleranceM: tol, maxReachHeightM },
    );
    if (verdict.ok && (drop.z <= FLOOR_EPS_M || candidate.stackable)) {
      settledAt[i] = candidate;
      processed.push(candidate);
    } else {
      displaced.push(p);
    }
  }
  const settled = settledAt.filter((p): p is Placement => p !== undefined);
  return { settled, displaced };
}

/**
 * First free spot on the interior FLOOR (z=0) for a box of `size`, scanning a
 * coarse grid front-to-back. Floor placements need no support check — only bounds
 * and non-overlap. Returns null when the box can't sit anywhere on the floor (too
 * big, or the floor is full). Used by the cross-van "move van" action to seed a
 * safe drop position in the target van, which the caller then re-validates as a
 * whole arrangement.
 */
export function firstFitFloor(
  size: Vec3,
  interior: Dimensions,
  others: readonly Placement[],
  tol: number,
  step = 0.1,
): { x: number; y: number; z: number } | null {
  const maxX = interior.l - size.x;
  const maxY = interior.w - size.y;
  if (maxX < -tol || maxY < -tol || size.z > interior.h + tol) return null;
  for (let y = 0; y <= maxY + tol; y += step) {
    const yy = Math.min(y, Math.max(0, maxY));
    for (let x = 0; x <= maxX + tol; x += step) {
      const xx = Math.min(x, Math.max(0, maxX));
      const pos = { x: xx, y: yy, z: 0 };
      if (!hasOverlap(pos, size, others) && fitsInterior(pos, size, interior, tol)) return pos;
    }
  }
  return null;
}

/**
 * First valid spot for a box, trying the FLOOR first (stable and cheap) and then
 * STACKING on top of what's already loaded when the floor is full — the manual-
 * placement counterpart to the auto-packer's vertical fill. Without it the click-to-
 * place, drop-fallback, and cross-van-move paths only ever reach bare floor, so a
 * truck of stackable pallets tops out at one flat layer (~40% volume) and the
 * operator burns extra vehicles for cargo that would have stacked.
 *
 * Floor-first, so it never disturbs items already placed: it fills the deck, then
 * (only once the floor is full) scans the grid, letting each candidate settle onto
 * the highest support beneath it (resolveDrop) and keeping the first spot that clears
 * the FULL placement gate — support coverage, crush + weight ceiling, reach limit,
 * interior bounds, no overlap. Same gate the auto-packer and 3D editor enforce, so a
 * hand-stacked pallet obeys identical safety rules — no new safety surface here.
 * Deterministic (front-to-back, floor before stack). Returns null when the box fits
 * nowhere, floor or atop.
 */
export function firstFitStacked(
  size: Vec3,
  interior: Dimensions,
  others: readonly Placement[],
  tol: number,
  weightKg: number,
  fragile: boolean,
  maxReachHeightM?: number,
  step = 0.1,
): { x: number; y: number; z: number } | null {
  // 1) Floor first — cheapest, most stable, and needs no support/crush check (z=0).
  const floor = firstFitFloor(size, interior, others, tol, step);
  if (floor) return floor;

  // 2) Floor full → first valid resting spot on top of existing boxes (front-to-back).
  const maxX = interior.l - size.x;
  const maxY = interior.w - size.y;
  if (maxX < -tol || maxY < -tol) return null;
  for (let y = 0; y <= maxY + tol; y += step) {
    for (let x = 0; x <= maxX + tol; x += step) {
      // Let the box settle onto whatever's highest under this footprint; skip cells
      // with nothing underneath (drop.z≈0 is the floor case, already tried above).
      const drop = resolveDrop(x, y, size, others);
      if (drop.z <= FLOOR_EPS_M) continue;
      const verdict = validatePlacement(
        { position: drop, size, weightKg, fragile },
        { others, interior, toleranceM: tol, maxReachHeightM },
      );
      if (verdict.ok) return drop;
    }
  }
  return null;
}

/** Volume-fill (placed m³ / interior m³) and floor coverage, both 0..1. */
export interface UtilizationMetrics {
  /** Σ placed box volume / van interior volume. */
  readonly volumeFill: number;
  /** Σ floor-resting box footprint / van floor area — exposes unused height. */
  readonly floorFootprint: number;
}

export function computeUtilization(
  placements: readonly Placement[],
  interior: Dimensions,
): UtilizationMetrics {
  const interiorVol = volumeM3(interior);
  const placedVol = placements.reduce((sum, p) => sum + volumeM3Vec3(p.size), 0);
  const volumeFill = interiorVol > 0 ? placedVol / interiorVol : 0;

  const floorArea = interior.l * interior.w;
  const floorUsed = placements.reduce(
    (sum, p) => (p.position.z <= FLOOR_EPS_M ? sum + p.size.x * p.size.y : sum),
    0,
  );
  const floorFootprint = floorArea > 0 ? floorUsed / floorArea : 0;

  return { volumeFill, floorFootprint };
}
