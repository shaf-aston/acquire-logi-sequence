/**
 * Block consolidation (Stage 3, huge-order path). Groups genuinely identical
 * rows into palletised BLOCKS — a grid of a×b×c units treated by the packer as
 * ONE Item — so an order of tens of thousands of identical units packs as a
 * few hundred placeable objects instead of one per unit.
 *
 * SAFETY: the whole-arrangement verify gate (placement-validator.ts) sees a
 * block as one opaque box — it cannot see the units stacked inside it. So a
 * block's `canSupportWeightKg`/`maxStackPressureKpa` must already encode the
 * RESIDUAL strength of its weakest (bottom) internal layer, or a block that
 * looks fine to the gate could physically crush whatever is loaded on top of
 * it. See the grid/residual math below — get this wrong and the feature is
 * unsafe, not just imprecise.
 *
 * Pure module: no I/O, no config reads (the caller passes `cfg` resolved from
 * config/consolidation.json via env.ts). Metres/kilograms throughout.
 */
import type { Dimensions, Item } from "@/lib/packing/packing.types";
import { allOrientations, permittedOrientationIndices } from "@/lib/packing/orientation";
import { maxBearableKg } from "@/lib/packing/placement-validator";

/** Per-consolidated-group knobs (resolved from config/consolidation.json). */
export interface ConsolidationConfig {
  /** A group's quantity must be at least this many units before consolidation applies. */
  readonly minUnitsToConsolidate: number;
  /** Hard cap on units packed into a single block (bounds one block's mass/footprint). */
  readonly maxBlockUnits: number;
  /** Block footprint may not exceed this many metres on any grid axis (a·uL, b·uW). */
  readonly footprintCapM: number;
  /** Block stack height may not exceed this many metres (c·uH). */
  readonly heightCapM: number;
  /**
   * Phase 4 — below this fraction of a failed-to-place block's units, `splitBlockInHalf`
   * refuses to split further (returns null) — the remainder is left unplaced rather
   * than recursing into ever-smaller slivers (no infinite loops).
   */
  readonly minSplitFraction: number;
}

/**
 * Per-emitted-block bookkeeping the packer needs to expand a block back into
 * real units for reporting/pricing (Phase 5) — never fed to the packer itself.
 * Keyed by the emitted block Item's id.
 */
export interface BlockMeta {
  readonly sourceItemId: string;
  readonly unitsPerBlock: number;
  readonly grid: { readonly a: number; readonly b: number; readonly c: number };
  readonly unitDims: Dimensions;
  readonly label: string;
  /**
   * The SOURCE unit's own crush/weight facts (not the block's residual figures) —
   * carried so a failed-to-place block can be re-split into a smaller block
   * (Phase 4, fleet-allocator.ts) without needing the original per-row Item, which
   * is no longer available once consolidation has replaced it.
   */
  readonly unitWeightKg: number;
  readonly unitCanSupportWeightKg: number;
  readonly unitMaxStackPressureKpa: number;
}

export interface ConsolidationResult {
  readonly items: Item[];
  readonly meta: Map<string, BlockMeta>;
}

/** Fields that must match exactly for two rows to be "the same SKU" (see module doc). */
function identityKey(item: Item): string | null {
  if (item.dimensions === null) return null;
  const d = item.dimensions;
  return [
    item.id,
    d.l, d.w, d.h,
    item.weightKg,
    item.fragility,
    item.stackable,
    item.canSupportWeightKg,
    item.orientationLock,
    item.maxStackPressureKpa,
    item.durabilityTier,
  ].join("|");
}

/**
 * Chosen (uL, uW, uH) orientation for a unit inside a block: the orientation
 * that maximises units-per-block for a given interior, respecting the item's
 * `orientationLock` (a "fixed" unit may not be laid down to change its height
 * axis). Ties broken deterministically (first candidate wins) so consolidation
 * output is stable.
 */
function bestUnitOrientation(
  dims: Dimensions,
  orientationLock: Item["orientationLock"],
  interior: Dimensions,
  cfg: ConsolidationConfig,
): { uL: number; uW: number; uH: number; a: number; b: number; c: number } | null {
  const perms = allOrientations(dims.l, dims.w, dims.h);
  const allowedIdx = permittedOrientationIndices(orientationLock);

  let best: { uL: number; uW: number; uH: number; a: number; b: number; c: number } | null = null;
  let bestUnits = 0;

  for (const idx of allowedIdx) {
    const [uL, uW, uH] = perms[idx]!;
    if (uL <= 0 || uW <= 0 || uH <= 0) continue;

    const footprintLimL = Math.min(interior.l, cfg.footprintCapM);
    const footprintLimW = Math.min(interior.w, cfg.footprintCapM);
    const heightLim = Math.min(interior.h, cfg.heightCapM);

    const a = Math.max(0, Math.floor(footprintLimL / uL));
    const b = Math.max(0, Math.floor(footprintLimW / uW));
    const c = Math.max(0, Math.floor(heightLim / uH));
    if (a < 1 || b < 1 || c < 1) continue;

    const units = a * b * c;
    if (units > bestUnits) {
      bestUnits = units;
      best = { uL, uW, uH, a, b, c };
    }
  }
  return best;
}

/**
 * Intra-block crush/grid math (see module doc + the caller's spec). Computes
 * the grid (a,b,c capped by weight/pressure/height/config), the block's
 * bounding dimensions, and the RESIDUAL bearing capacity its top face may
 * offer to whatever is stacked ON the block.
 */
function computeBlockGrid(
  item: Item,
  unitDims: { uL: number; uW: number; uH: number },
  maxGrid: { a: number; b: number; c: number },
): {
  a: number;
  b: number;
  c: number;
  blockDims: Dimensions;
  unitsPerBlock: number;
  canSupportWeightKg: number;
} {
  const { uL, uW, uH } = unitDims;
  const areaM2 = uL * uW;
  const unitWeight = item.weightKg;

  // Guard every divisor: unitWeight<=0 skips the weight bound (treated as unlimited
  // layers by weight); area<=0 is impossible here (bestUnitOrientation already
  // rejected non-positive dims), but guard defensively anyway.
  const maxLayersByWeight =
    unitWeight > 0 && item.canSupportWeightKg >= 0
      ? 1 + Math.floor(item.canSupportWeightKg / unitWeight)
      : Number.POSITIVE_INFINITY;
  // capByPressure (below) is the residual weight the unit's own top face may bear —
  // derived via maxBearableKg, the sole inverse of stackPressureKpa. unitWeight<=0
  // means every layer adds zero mass, so pressure can never bind: infinite layers by
  // pressure, same convention as maxLayersByWeight above (min() below picks the real,
  // finite winner from maxGrid.c/maxLayersByHeight regardless).
  const capByPressure = maxBearableKg(item.maxStackPressureKpa, areaM2);
  const maxLayersByPressure =
    areaM2 > 0
      ? unitWeight > 0
        ? 1 + Math.floor(capByPressure / unitWeight)
        : Number.POSITIVE_INFINITY
      : 1;
  const maxLayersByHeight = maxGrid.c;

  const c = Math.max(1, Math.min(maxLayersByWeight, maxLayersByPressure, maxLayersByHeight, maxGrid.c));
  const a = Math.max(1, maxGrid.a);
  const b = Math.max(1, maxGrid.b);

  const capByWeight = item.canSupportWeightKg;
  const residualKg = Math.min(capByWeight, capByPressure) - (c - 1) * unitWeight;

  return {
    a,
    b,
    c,
    blockDims: { l: a * uL, w: b * uW, h: c * uH },
    unitsPerBlock: a * b * c,
    canSupportWeightKg: Math.max(0, residualKg),
  };
}

/** Default (pass-through) config — used only by tests that don't care about tuning. */
export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  minUnitsToConsolidate: 50,
  maxBlockUnits: 500,
  footprintCapM: 1.2,
  heightCapM: 2.0,
  minSplitFraction: 0.25,
};

/**
 * Groups genuinely identical rows (see `identityKey`) whose combined quantity
 * is at least `cfg.minUnitsToConsolidate` into whole blocks + (optionally) one
 * remainder block/pass-through for the leftover units. Non-identical rows, and
 * groups below the threshold, pass through completely untouched — this keeps
 * small orders byte-identical to the pre-consolidation packer output.
 */
export function consolidate(items: Item[], interior: Dimensions, cfg: ConsolidationConfig): ConsolidationResult {
  const meta = new Map<string, BlockMeta>();
  const out: Item[] = [];

  // Group by identity key, preserving first-seen order for deterministic output.
  const groups = new Map<string, Item[]>();
  const order: string[] = [];
  for (const item of items) {
    const key = identityKey(item);
    if (key === null) {
      // No dimensions — nothing to consolidate; pass through untouched.
      out.push(item);
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(item);
  }

  for (const key of order) {
    const rows = groups.get(key)!;
    const totalUnits = rows.reduce((n, r) => n + Math.max(1, r.quantity), 0);
    const template = rows[0]!;

    if (totalUnits < cfg.minUnitsToConsolidate || template.dimensions === null) {
      out.push(...rows);
      continue;
    }

    const orientation = bestUnitOrientation(template.dimensions, template.orientationLock, interior, cfg);
    if (orientation === null) {
      // Can't form even a 1x1x1 grid inside this van's interior — nothing to gain
      // from consolidating; pass through untouched rather than fail loud.
      out.push(...rows);
      continue;
    }

    const maxGrid = { a: orientation.a, b: orientation.b, c: orientation.c };
    // Respect maxBlockUnits by shrinking the tallest axis first (height is the
    // safest to shrink — it directly reduces crush risk too), then width, then length.
    while (maxGrid.a * maxGrid.b * maxGrid.c > cfg.maxBlockUnits && maxGrid.c > 1) maxGrid.c--;
    while (maxGrid.a * maxGrid.b * maxGrid.c > cfg.maxBlockUnits && maxGrid.b > 1) maxGrid.b--;
    while (maxGrid.a * maxGrid.b * maxGrid.c > cfg.maxBlockUnits && maxGrid.a > 1) maxGrid.a--;

    const grid = computeBlockGrid(template, orientation, maxGrid);
    const unitsPerBlock = grid.unitsPerBlock;
    if (unitsPerBlock < 1) {
      out.push(...rows);
      continue;
    }

    const wholeBlocks = Math.floor(totalUnits / unitsPerBlock);
    const remainderUnits = totalUnits - wholeBlocks * unitsPerBlock;

    if (wholeBlocks > 0) {
      const blockId = `${template.id}::block`;
      const label = `${wholeBlocks > 1 ? wholeBlocks + " × " : ""}${(unitsPerBlock).toLocaleString()} × ${template.name}`;
      out.push({
        ...template,
        id: blockId,
        name: label,
        dimensions: grid.blockDims,
        weightKg: unitsPerBlock * template.weightKg,
        quantity: wholeBlocks,
        canSupportWeightKg: grid.canSupportWeightKg,
        maxStackPressureKpa: template.maxStackPressureKpa,
      });
      meta.set(blockId, {
        sourceItemId: template.id,
        unitsPerBlock,
        grid: { a: grid.a, b: grid.b, c: grid.c },
        unitDims: { l: orientation.uL, w: orientation.uW, h: orientation.uH },
        label,
        unitWeightKg: template.weightKg,
        unitCanSupportWeightKg: template.canSupportWeightKg,
        unitMaxStackPressureKpa: template.maxStackPressureKpa,
      });
    }

    if (remainderUnits > 0) {
      // Try a smaller remainder block (same recipe, fewer layers) only when the
      // remainder itself still clears the threshold; otherwise ship loose units
      // (keeps tiny leftovers from silently vanishing or double counting).
      if (remainderUnits >= cfg.minUnitsToConsolidate) {
        // Re-run the grid math capped at the remainder's own unit count so a
        // partial layer isn't fabricated beyond what's actually left.
        const remGrid = computeBlockGrid(template, orientation, {
          a: maxGrid.a,
          b: maxGrid.b,
          c: Math.max(1, Math.min(maxGrid.c, Math.ceil(remainderUnits / (maxGrid.a * maxGrid.b)))),
        });
        const remId = `${template.id}::block-remainder`;
        const remLabel = `${remainderUnits.toLocaleString()} × ${template.name}`;
        out.push({
          ...template,
          id: remId,
          name: remLabel,
          dimensions: {
            l: maxGrid.a * orientation.uL,
            w: maxGrid.b * orientation.uW,
            h: remGrid.c * orientation.uH,
          },
          weightKg: remainderUnits * template.weightKg,
          quantity: 1,
          canSupportWeightKg: remGrid.canSupportWeightKg,
          maxStackPressureKpa: template.maxStackPressureKpa,
        });
        meta.set(remId, {
          sourceItemId: template.id,
          unitsPerBlock: remainderUnits,
          grid: { a: maxGrid.a, b: maxGrid.b, c: remGrid.c },
          unitDims: { l: orientation.uL, w: orientation.uW, h: orientation.uH },
          label: remLabel,
          unitWeightKg: template.weightKg,
          unitCanSupportWeightKg: template.canSupportWeightKg,
          unitMaxStackPressureKpa: template.maxStackPressureKpa,
        });
      } else {
        out.push({ ...template, quantity: remainderUnits });
      }
    }
  }

  return { items: out, meta };
}

/**
 * Phase 4 — minimal-split preference. Given a block Item that FAILED to place
 * whole, halves its layer count (c) to produce ONE smaller block covering half
 * (rounded down) the original's units, plus a second block for the remainder —
 * both re-derived through the same crush/residual math as `consolidate` so the
 * verify gate's opaque-box view stays honest. Never splits below
 * `cfg.minSplitFraction` of the original's units (returns null instead) — the
 * remainder then goes to `unplaced` rather than looping into ever-smaller slivers.
 */
export function splitBlockInHalf(
  block: Item,
  meta: BlockMeta,
  cfg: ConsolidationConfig,
): { items: Item[]; meta: Map<string, BlockMeta> } | null {
  const { a, b, c } = meta.grid;
  if (c <= 1) return null; // nothing left to shrink — caller must give up on this block

  const halfC = Math.max(1, Math.floor(c / 2));
  const restC = c - halfC;
  const halfUnits = a * b * halfC;
  const restUnits = a * b * restC;

  if (halfUnits / meta.unitsPerBlock < cfg.minSplitFraction) return null;

  const template: Pick<Item, "weightKg" | "canSupportWeightKg" | "maxStackPressureKpa"> = {
    weightKg: meta.unitWeightKg,
    canSupportWeightKg: meta.unitCanSupportWeightKg,
    maxStackPressureKpa: meta.unitMaxStackPressureKpa,
  };

  const buildSub = (layers: number, units: number, suffix: string): { item: Item; meta: BlockMeta } => {
    const areaM2 = meta.unitDims.l * meta.unitDims.w;
    const capByWeight = template.canSupportWeightKg;
    const capByPressure = maxBearableKg(template.maxStackPressureKpa, areaM2);
    const residualKg = Math.min(capByWeight, capByPressure) - (layers - 1) * template.weightKg;
    const id = `${block.id}${suffix}`;
    const label = `${units.toLocaleString()} × ${meta.label.replace(/^[\d,]+ × /, "")}`;
    const item: Item = {
      ...block,
      id,
      name: label,
      dimensions: { l: a * meta.unitDims.l, w: b * meta.unitDims.w, h: layers * meta.unitDims.h },
      weightKg: units * template.weightKg,
      quantity: 1,
      canSupportWeightKg: Math.max(0, residualKg),
      maxStackPressureKpa: template.maxStackPressureKpa,
    };
    const newMeta: BlockMeta = {
      sourceItemId: meta.sourceItemId,
      unitsPerBlock: units,
      grid: { a, b, c: layers },
      unitDims: meta.unitDims,
      label,
      unitWeightKg: meta.unitWeightKg,
      unitCanSupportWeightKg: meta.unitCanSupportWeightKg,
      unitMaxStackPressureKpa: meta.unitMaxStackPressureKpa,
    };
    return { item, meta: newMeta };
  };

  const outMeta = new Map<string, BlockMeta>();
  const items: Item[] = [];
  const perBlockQty = Math.max(1, block.quantity);

  for (let i = 0; i < perBlockQty; i++) {
    const half = buildSub(halfC, halfUnits, `::split-a-${i}`);
    items.push(half.item);
    outMeta.set(half.item.id, half.meta);
    if (restUnits > 0) {
      const rest = buildSub(restC, restUnits, `::split-b-${i}`);
      items.push(rest.item);
      outMeta.set(rest.item.id, rest.meta);
    }
  }

  return { items, meta: outMeta };
}
