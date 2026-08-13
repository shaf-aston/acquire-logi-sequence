/**
 * Mixed-item box consolidation (Stage 3, diverse-huge-order path).
 *
 * `consolidate()` (consolidation.ts) collapses IDENTICAL high-quantity SKUs into
 * blocks. It cannot help a DIVERSE order — hundreds of different small items,
 * none identical enough to group — so every one of, say, 10,000 loose units stays
 * an individual placeable object and trips the packer's `maxPackableBlocks` cap.
 *
 * This module boxes those loose small items onto SHARED standard boxes (a "box"
 * here is a mixed pallet — exactly what a 3PL does: assorted cartons shrink-wrapped
 * onto one pallet). Each box becomes ONE placeable object holding many real units,
 * so a diverse 10,000-unit order packs as a few hundred boxes.
 *
 * SAFETY — why this needs no internal-crush model. Items are placed in a SINGLE
 * layer on the box floor; nothing is stacked *inside* a box, so no internal item
 * can crush another. The only crush question is what may be stacked ON the box:
 *   - Weight: an external load spreads across the floor items by area; the share
 *     any one item bears is ≤ the whole load, so bounding the whole external load
 *     by `min(content.canSupportWeightKg)` is safe (conservative).
 *   - Pressure: a load W over the box's top area A applies W·G/A to EVERY floor
 *     item equally (each item's share W·areaᵢ/A over its own areaᵢ = W/A). So the
 *     box's honest pressure ceiling is exactly `min(content.maxStackPressureKpa)`.
 * The box advertises those two minima; the existing placement-validator then keeps
 * whatever stacks on the box honest. Fragile/brittle content ⇒ min is 0 ⇒ nothing
 * stacks on the box. Fragile items are boxed separately so one fragile unit doesn't
 * make an otherwise-stackable sturdy box unstackable.
 *
 * Pure module: no I/O, no config reads (caller passes `cfg` resolved via env.ts).
 * Metres / kilograms throughout. Emits BlockMeta so the packer expands a box back
 * into real units for reporting/pricing (Phase 5), same contract as consolidate().
 */
import type { Dimensions, Item } from "@/lib/packing/packing.types";
import type { BlockMeta } from "@/lib/packing/consolidation";

/** Editable knobs (resolved from config/consolidation.json `box`). */
export interface BoxConfig {
  readonly enabled: boolean;
  /** Standard box floor footprint (metres). Default: full UK pallet 1.2 × 1.0. */
  readonly footprintM: { readonly l: number; readonly w: number };
  /** An item taller than this (in its best box orientation) is NOT boxable — it stays a normal item. */
  readonly maxHeightM: number;
  /** Cap on total loaded box weight (kg) — bounds one box's mass for the allocator. */
  readonly maxBoxWeightKg: number;
  /** Usable fraction of the floor area (0,1]; leaves slack for real-world gaps between cartons. */
  readonly fillFraction: number;
  /** Only kick in once at least this many boxable units exist — small/normal orders pass through untouched. */
  readonly minUnitsToBox: number;
}

export interface BoxResult {
  readonly items: Item[];
  readonly meta: Map<string, BlockMeta>;
}

/** Floor area (m²) a unit occupies standing UPRIGHT (its natural l×w footprint). */
function footprintAreaM2(dims: Dimensions): number {
  return dims.l * dims.w;
}

/**
 * True when the unit is genuinely a "small" boxable item: it sits UPRIGHT on the
 * box floor (never tipped onto a side — that would violate a real "this way up"
 * cargo and, for a loaded pallet, is physically wrong), within the height cap, AND
 * at least two of it fit per box. The ≥2 rule keeps boxing from pointlessly wrapping
 * a near-box-sized item (e.g. a whole pallet) into a box of one — which reduces
 * nothing and would tip the pallet.
 */
function fitsBox(dims: Dimensions, cfg: BoxConfig): boolean {
  const { l: fl, w: fw } = cfg.footprintM;
  const uprightFits =
    dims.h <= cfg.maxHeightM &&
    ((dims.l <= fl && dims.w <= fw) || (dims.w <= fl && dims.l <= fw));
  if (!uprightFits) return false;
  const usableAreaM2 = fl * fw * cfg.fillFraction;
  return footprintAreaM2(dims) * 2 <= usableAreaM2; // at least two fit ⇒ boxing actually reduces count
}

/** One box under construction, accumulating single-layer floor contents. */
interface BoxBin {
  areaUsedM2: number;
  weightKg: number;
  maxContentHeightM: number;
  minCanSupportKg: number;
  minPressureKpa: number;
  count: number;
  template: Item; // representative item, for category/orientation carry-through
}

/**
 * Expands each boxable item into its real units and bins them (first-fit) into
 * shared single-layer boxes. `fragile` boxes are built from the fragile/brittle
 * pool separately so they don't spoil a sturdy box's stackability.
 */
function packBins(units: Item[], cfg: BoxConfig, fragile: boolean): { boxes: BoxBin[] } {
  const usableAreaM2 = cfg.footprintM.l * cfg.footprintM.w * cfg.fillFraction;
  // Largest footprint first — first-fit-decreasing packs floors tighter.
  const sorted = [...units].sort((x, y) => footprintAreaM2(y.dimensions!) - footprintAreaM2(x.dimensions!));
  const boxes: BoxBin[] = [];

  for (const u of sorted) {
    const dims = u.dimensions!;
    const area = footprintAreaM2(dims);
    const heightM = dims.h; // upright — the item keeps its natural height axis (no tipping)

    let bin = boxes.find(
      (bx) => bx.areaUsedM2 + area <= usableAreaM2 && bx.weightKg + u.weightKg <= cfg.maxBoxWeightKg,
    );
    if (!bin) {
      bin = { areaUsedM2: 0, weightKg: 0, maxContentHeightM: 0, minCanSupportKg: Infinity, minPressureKpa: Infinity, count: 0, template: u };
      boxes.push(bin);
    }
    bin.areaUsedM2 += area;
    bin.weightKg += u.weightKg;
    bin.maxContentHeightM = Math.max(bin.maxContentHeightM, heightM);
    // A fragile box may bear nothing on top regardless of content figures.
    bin.minCanSupportKg = fragile ? 0 : Math.min(bin.minCanSupportKg, u.canSupportWeightKg);
    bin.minPressureKpa = fragile ? 0 : Math.min(bin.minPressureKpa, u.maxStackPressureKpa);
    bin.count += 1;
  }
  return { boxes };
}

/** Build one box Item + its BlockMeta from a filled bin. */
function boxToItem(bin: BoxBin, cfg: BoxConfig, idx: number, fragile: boolean): { item: Item; meta: BlockMeta } {
  const dimensions: Dimensions = { l: cfg.footprintM.l, w: cfg.footprintM.w, h: bin.maxContentHeightM };
  const id = `box::${fragile ? "fragile" : "std"}::${idx}`;
  const label = `${bin.count.toLocaleString()} assorted items${fragile ? " (fragile — nothing on top)" : ""}`;
  const item: Item = {
    ...bin.template,
    id,
    name: label,
    dimensions,
    weightKg: bin.weightKg,
    quantity: 1,
    fragility: fragile ? "fragile" : "standard",
    // Single-layer floor load ⇒ the box top may bear the weakest content's limit (0 if fragile).
    canSupportWeightKg: Number.isFinite(bin.minCanSupportKg) ? bin.minCanSupportKg : 0,
    maxStackPressureKpa: Number.isFinite(bin.minPressureKpa) ? bin.minPressureKpa : 0,
    stackable: true, // a box may itself be placed on the floor or on a sturdy box
  };
  const meta: BlockMeta = {
    sourceItemId: id,
    unitsPerBlock: bin.count,
    grid: { a: bin.count, b: 1, c: 1 }, // single floor layer; not a uniform grid, so splitting is refused downstream
    unitDims: dimensions,
    label,
    unitWeightKg: bin.weightKg / Math.max(1, bin.count),
    unitCanSupportWeightKg: item.canSupportWeightKg,
    unitMaxStackPressureKpa: item.maxStackPressureKpa,
  };
  return { item, meta };
}

/**
 * Box the diverse loose small items in `items` into shared standard boxes.
 * Non-boxable items (too big for the box, or dimensionless) pass through
 * untouched. Returns byte-identical input when boxing is disabled or the boxable
 * unit count is below `minUnitsToBox` (small orders stay exactly as before).
 *
 * `alreadyConsolidatedIds` are the ids of items that upstream identical-SKU
 * consolidation already turned into blocks — a block's `quantity` is a block
 * count, not a real-unit count, so re-boxing it would miscount its units. Those
 * ids pass through untouched (they are already reduced to few placeable objects).
 */
export function boxLooseItems(
  items: Item[],
  cfg: BoxConfig,
  alreadyConsolidatedIds: ReadonlySet<string> = new Set(),
): BoxResult {
  const meta = new Map<string, BlockMeta>();
  if (!cfg.enabled) return { items, meta };

  const passthrough: Item[] = [];
  const boxable: Item[] = [];
  for (const it of items) {
    if (it.dimensions !== null && !alreadyConsolidatedIds.has(it.id) && fitsBox(it.dimensions, cfg)) boxable.push(it);
    else passthrough.push(it);
  }

  const boxableUnits = boxable.reduce((n, it) => n + Math.max(1, it.quantity), 0);
  if (boxableUnits < cfg.minUnitsToBox) return { items, meta }; // untouched — not a huge diverse order

  // Expand each boxable item into individual units (one per quantity) for binning.
  const explode = (pool: Item[]): Item[] =>
    pool.flatMap((it) => Array.from({ length: Math.max(1, it.quantity) }, () => ({ ...it, quantity: 1 })));

  const fragileUnits = explode(boxable.filter((it) => it.fragility === "fragile" || it.brittle));
  const sturdyUnits = explode(boxable.filter((it) => it.fragility !== "fragile" && !it.brittle));

  const out: Item[] = [...passthrough];
  let boxIdx = 0;
  for (const [pool, isFragile] of [[sturdyUnits, false], [fragileUnits, true]] as const) {
    if (pool.length === 0) continue;
    const { boxes } = packBins(pool, cfg, isFragile);
    for (const bin of boxes) {
      const { item, meta: m } = boxToItem(bin, cfg, boxIdx++, isFragile);
      out.push(item);
      meta.set(item.id, m);
    }
  }
  return { items: out, meta };
}
