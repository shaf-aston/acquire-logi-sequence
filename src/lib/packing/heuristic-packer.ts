/**
 * 3D first-fit-decreasing packer (van-calculation.md:71-87). Greedy by design —
 * true optimal 3D bin packing is NP-hard. Pure and deterministic: no clock, no
 * randomness, stable sorts everywhere, so Stage 4 can render its output directly.
 *
 * Strategy:
 *   1. expand quantities into units; items with no dimensions are unplaceable;
 *   2. sort non-fragile and non-brittle first, then sturdiest base first (high
 *      maxStackPressureKpa), then largest volume — so rated bases land on the
 *      floor before the lighter items that stack on them; fragile and brittle
 *      items fall to the end so nothing is stacked on them;
 *   3. for each unit, score every valid (anchor × orientation) candidate and pick
 *      the best: stackable items are rewarded for building vertically on a rated
 *      base, all items are nudged toward the origin to keep the load compact. This
 *      replaces the old floor-first scan that spread stackables across the floor
 *      and left the vertical space empty.
 */
import { volumeM3 } from "@/lib/packing/geometry";
import { computeUtilization, reachLimitReason, validatePlacement, type Neighbors } from "@/lib/packing/placement-validator";
import { FootprintIndex } from "@/lib/packing/footprint-index";
import { allOrientations as axisPermutations, permittedOrientationIndices } from "@/lib/packing/orientation";
import type {
  Dimensions,
  Item,
  Packer,
  PackingResult,
  Placement,
  Van,
  Vec3,
} from "@/lib/packing/packing.types";
import type { OrientationLock } from "@/lib/classification/durability.types";

/**
 * Anchor-scoring knobs (physical-world calibration — keep, do not inline).
 * Scaled so the support bonus dominates the height reward, which dominates the
 * compaction nudge; ties never hinge on floating-point noise.
 */
const W_Z = 1_000_000;        // reward per m of height for a stackable item
const SUPPORT_BONUS = 1_000_000; // flat reward for resting on a rated base (z>0)
const W_COMPACT = 1_000;      // penalty per m of (x+y) distance from the origin
const W_FLAT = 1_000;         // penalty per m of z-dimension for stackable floor items — prefers flat orientations so items can stack on top of each other rather than standing tall and blocking the ceiling

/**
 * Cap on the active extreme-point anchor set (calibration knob — keep, do not
 * inline). The scorer always prefers the lowest, most-compact anchors, so once
 * the set grows past this we keep only the best (lowest z, then y, then x) and
 * drop the far corners that would never win. Bounds a single pack to O(units ×
 * MAX_ANCHORS) instead of O(units²) on large jobs; small jobs never reach the
 * cap, so their placement is byte-for-byte unchanged. 128 comfortably exceeds
 * the anchor count of any realistic single-van fill.
 */
const MAX_ANCHORS = 128;

/**
 * Higher is better. Rewards a stackable item for sitting high on a rated base
 * (build columns) and nudges every item toward the origin corner (stay compact,
 * leaving no stranded floor gaps). For stackable items at floor level, prefers
 * the flat orientation (smallest z-dimension) so subsequent items have room to
 * stack without hitting the ceiling — "intelligent vertical stacking".
 * Deterministic — no clock, no randomness.
 */
function scoreCandidate(pos: Vec3, size: Vec3, stackable: boolean): number {
  const verticalReward = stackable ? pos.z * W_Z : 0;
  const supportBonus = pos.z > 0 ? SUPPORT_BONUS : 0;
  const compaction = (pos.x + pos.y) * W_COMPACT;
  // Prefer flat orientations for stackable items: a tall item on the floor wastes
  // vertical space; a flat item leaves room for a column of stacked boxes above it.
  const flatBonus = stackable ? -size.z * W_FLAT : 0;
  return verticalReward + supportBonus - compaction + flatBonus;
}

/** A candidate box orientation and which of the 6 axis permutations produced it. */
interface Orientation {
  readonly size: Vec3;
  readonly rotationIndex: number;
}

/**
 * Axis permutations of (l,w,h) mapped to (x,y,z), restricted to those permitted
 * by the item's rotation policy (see orientation.ts). Index 0 is always the
 * natural orientation. Boxes with repeated dimensions collapse to fewer unique
 * orientations, deterministically.
 */
function orientations(d: Dimensions, orientationLock: OrientationLock): Orientation[] {
  const perms = axisPermutations(d.l, d.w, d.h);
  const seen = new Set<string>();
  const out: Orientation[] = [];
  // rotationIndex is the permutation's true index (0-5, 0 = natural) — NOT its
  // position in the filtered list — so viewer round-tripping stays meaningful
  // regardless of which orientations this item's lock permitted.
  for (const rotationIndex of permittedOrientationIndices(orientationLock)) {
    const p = perms[rotationIndex]!;
    const key = `${p[0]}:${p[1]}:${p[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ size: { x: p[0], y: p[1], z: p[2] }, rotationIndex });
  }
  return out;
}

interface Unit {
  readonly item: Item;
  readonly dims: Dimensions;
  readonly volume: number;
}

/** Reasons surfaced on `unplaced`, in detection order. */
const REASON = {
  missingDims: "missing dimensions — cannot be packed",
  exceedsInterior: "exceeds van interior — item cannot fit in any orientation",
  overPayload: "too heavy — would exceed van payload limit",
  noSpace: "no space left in this van",
} as const;

export interface HeuristicOptions {
  /** Clearance slack (m) when fitting into the interior and matching support faces. */
  readonly toleranceM: number;
  /** Highest a worker may place an item's base by hand (m) — undefined ⇒ no limit. */
  readonly maxReachHeightM?: number;
  /**
   * Spatial-index cell edge (m) for the neighbour lookup. Perf-only calibration —
   * omit for the default. It changes only HOW FAST overlap/support checks run, never
   * the placements they produce, so tuning it can't alter a quote.
   */
  readonly indexCellM?: number;
}

export class HeuristicPacker implements Packer {
  readonly strategy = "first-fit-decreasing-3d";

  constructor(private readonly opts: HeuristicOptions) {}

  pack(items: Item[], van: Van): PackingResult {
    const tol = this.opts.toleranceM;
    const {maxReachHeightM} = this.opts;
    const {interior} = van;
    const placements: Placement[] = [];
    // Spatial index kept in lockstep with `placements` — it narrows the overlap/support
    // scans in tryPlace to nearby boxes. A superset in insertion order, so identical result.
    const index = new FootprintIndex(this.opts.indexCellM);
    const reasons: Record<string, string> = {};
    /** itemId → count of units that failed to place. */
    const unplacedCounts = new Map<string, number>();
    const itemById = new Map(items.map((item) => [item.id, item]));

    const recordFailure = (item: Item, reason: string) => {
      unplacedCounts.set(item.id, (unplacedCounts.get(item.id) ?? 0) + 1);
      // Keep the first (most specific) reason per item.
      if (!(item.id in reasons)) reasons[item.id] = reason;
    };

    // 1) Expand quantities; route dimensionless items straight to unplaced.
    const units: Unit[] = [];
    for (const item of items) {
      if (item.dimensions === null) {
        for (let i = 0; i < Math.max(1, item.quantity); i++) recordFailure(item, REASON.missingDims);
        continue;
      }
      for (let i = 0; i < Math.max(1, item.quantity); i++) {
        units.push({ item, dims: item.dimensions, volume: volumeM3(item.dimensions) });
      }
    }

    // 2) Base-eligible first, then sturdiest of that group first (highest
    //    maxStackPressureKpa — these go on the floor and other items build on top
    //    of them), then largest volume; stable tie-break by id. "Base-eligible"
    //    excludes anything the gate would refuse a stack on: fragile (Stage 2,
    //    whole-item description) and brittle (Stage 3, material-derived) are two
    //    independent "cannot be a general base" signals, so both sink to the end
    //    together — the crush-limit number itself is untouched by this change.
    units.sort((a, b) => {
      const aNotBase = a.item.fragility === "fragile" || a.item.brittle ? 1 : 0;
      const bNotBase = b.item.fragility === "fragile" || b.item.brittle ? 1 : 0;
      if (aNotBase !== bNotBase) return aNotBase - bNotBase;
      if (b.item.maxStackPressureKpa !== a.item.maxStackPressureKpa) {
        return b.item.maxStackPressureKpa - a.item.maxStackPressureKpa;
      }
      if (b.volume !== a.volume) return b.volume - a.volume;
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
    });

    // Extreme-point anchors; seed at the origin corner.
    let anchors: Vec3[] = [{ x: 0, y: 0, z: 0 }];
    let payloadKg = 0;
    // Free-volume bound: a unit larger than the volume still unused cannot fit, no
    // matter how it's rotated. Once the van is full this gates the rest cheaply,
    // instead of running the full anchor scan on hundreds of doomed units.
    const interiorVolume = interior.l * interior.w * interior.h;
    let placedVolume = 0;

    // tryPlace's result for a given item shape is a pure function of (anchors,
    // placements) — both change ONLY on a successful placement. So once a unit of
    // item X fails against the current anchor set, every subsequent unit sharing
    // X's id is *provably* going to fail too, until the next successful placement
    // changes anchors/placements. Bulk single-line orders (thousands of identical
    // units once the van is full) would otherwise re-run the full O(anchors ×
    // orientations × placements-so-far) scan per doomed unit — quadratic and the
    // reason a 13k-unit job never finished. `stateVersion` bumps on every success;
    // a memoized failure only short-circuits while the version it failed at still
    // matches, so this never skips a placement that could actually now succeed.
    let stateVersion = 0;
    const noSpaceAtVersion = new Map<string, number>();

    for (const unit of units) {
      // Weight gate first — position-independent.
      if (payloadKg + unit.item.weightKg > van.maxPayloadKg) {
        recordFailure(unit.item, REASON.overPayload);
        continue;
      }

      // Can it fit the van interior in ANY allowed orientation?
      const orients = orientations(unit.dims, unit.item.orientationLock);
      const fitsInterior = orients.some(
        (o) =>
          o.size.x <= interior.l + tol &&
          o.size.y <= interior.w + tol &&
          o.size.z <= interior.h + tol,
      );
      if (!fitsInterior) {
        recordFailure(unit.item, REASON.exceedsInterior);
        continue;
      }

      // Hard necessary condition: can't fit a unit bigger than the free volume.
      if (unit.volume > interiorVolume - placedVolume) {
        recordFailure(unit.item, REASON.noSpace);
        continue;
      }

      if (noSpaceAtVersion.get(unit.item.id) === stateVersion) {
        recordFailure(unit.item, REASON.noSpace);
        continue;
      }

      const placed = this.tryPlace(unit, anchors, placements, index.query, interior, tol, maxReachHeightM);
      if (placed === null) {
        noSpaceAtVersion.set(unit.item.id, stateVersion);
        // Only re-checked on an actual failure (not the hot success path, and
        // memoized per item id so a run of identical units re-checks once) —
        // tells a genuinely full van apart from one that had room, just too
        // high to reach by hand.
        const reason =
          maxReachHeightM !== undefined &&
          this.tryPlace(unit, anchors, placements, index.query, interior, tol, undefined) !== null
            ? reachLimitReason(maxReachHeightM)
            : REASON.noSpace;
        recordFailure(unit.item, reason);
        continue;
      }

      placements.push(placed);
      index.insert(placed); // keep the neighbour index in step with placements
      payloadKg += unit.item.weightKg;
      placedVolume += unit.volume;
      anchors = this.nextAnchors(anchors, placed);
      stateVersion++;
    }

    const { volumeFill: utilization } = computeUtilization(placements, interior);

    const unplaced: Item[] = [...unplacedCounts.entries()].map(([id, count]) => ({
      ...itemById.get(id)!,
      quantity: count,
    }));

    return { van, placements, utilization, unplaced, reasons };
  }

  /**
   * Best-scoring valid (anchor × orientation) candidate; null ⇒ no fit. Anchors
   * are visited lowest-then-nearest and a candidate only displaces the incumbent
   * on a *strictly* higher score, so ties resolve to the lowest, most compact,
   * lowest-rotation placement — keeping the packer deterministic.
   */
  private tryPlace(
    unit: Unit,
    anchors: Vec3[],
    placements: Placement[],
    neighbors: Neighbors,
    interior: Dimensions,
    tol: number,
    maxReachHeightM: number | undefined,
  ): Placement | null {
    const orients = orientations(unit.dims, unit.item.orientationLock);
    const sorted = [...anchors].sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);

    let best: Placement | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const pos of sorted) {
      // Item-policy gate: a non-stackable item may only sit on the floor.
      if (pos.z > 0 && !unit.item.stackable) continue;
      for (const o of orients) {
        const verdict = validatePlacement(
          {
            position: pos,
            size: o.size,
            weightKg: unit.item.weightKg,
            fragile: unit.item.fragility === "fragile",
          },
          { others: placements, neighbors, interior, toleranceM: tol, maxReachHeightM },
        );
        if (!verdict.ok) continue;
        const score = scoreCandidate(pos, o.size, unit.item.stackable);
        if (score > bestScore) {
          bestScore = score;
          best = {
            itemId: unit.item.id,
            position: pos,
            size: o.size,
            fragile: unit.item.fragility === "fragile",
            weightKg: unit.item.weightKg,
            canSupportWeightKg: unit.item.canSupportWeightKg,
            stackable: unit.item.stackable,
            maxStackPressureKpa: unit.item.maxStackPressureKpa,
            brittle: unit.item.brittle,
            orientationLock: unit.item.orientationLock,
            rotationIndex: o.rotationIndex,
          };
        }
      }
    }
    return best;
  }

  /** Extreme points spawned by a placement: right (+x), beside (+y), atop (+z). */
  private nextAnchors(anchors: Vec3[], p: Placement): Vec3[] {
    const spawned: Vec3[] = [
      { x: p.position.x + p.size.x, y: p.position.y, z: p.position.z },
      { x: p.position.x, y: p.position.y + p.size.y, z: p.position.z },
      { x: p.position.x, y: p.position.y, z: p.position.z + p.size.z },
    ];
    const merged = [...anchors, ...spawned];
    // De-duplicate identical anchors to keep the list bounded + deterministic.
    const seen = new Set<string>();
    const unique = merged.filter((a) => {
      const key = `${a.x}:${a.y}:${a.z}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length <= MAX_ANCHORS) return unique;
    // Keep the best (lowest, most-compact) anchors — the only ones the scorer ever
    // prefers — and drop the far corners. Bounds large-job cost; small jobs never
    // reach the cap so this is a no-op for them.
    return unique.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x).slice(0, MAX_ANCHORS);
  }
}
