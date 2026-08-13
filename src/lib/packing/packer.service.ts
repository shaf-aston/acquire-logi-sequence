/**
 * Stage 3 orchestrator. Wires config loaders → item assembly → the packing
 * heuristic across the fleet, then ranks vans so a single best plan plus an
 * explicit "does it fit one van" signal come back. Mirrors the ingestion service
 * shape (perf.track timing, structured logging); no geometry logic lives here.
 */
import { createLogger } from "@/lib/logger/logger";
import { PerfTracker, type PerfReport } from "@/lib/perf/tracker";
import { getConfig } from "@/config/env";
import { assembleItems, flaggedCargoTables, skippedCargoTables } from "@/lib/packing/item-assembler";
import { loadColumnMap } from "@/lib/packing/column-map";
import { vanQuantity } from "@/lib/packing/van-quantity";
import { loadStackabilityMatrix } from "@/lib/packing/stackability";
import { FileVanRepository, InMemoryVanRepository, type VanRepository } from "@/lib/packing/van.repository";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { ZonedPacker } from "@/lib/packing/zoned-packer";
import { allocateFleet, defaultPackCap, totalUnits, type FleetPlan } from "@/lib/packing/fleet-allocator";
import { tryBulkAllocate } from "@/lib/packing/bulk-run-allocator";
import { validateArrangement } from "@/lib/packing/placement-validator";
import { consolidate, splitBlockInHalf, type BlockMeta } from "@/lib/packing/consolidation";
import { boxLooseItems } from "@/lib/packing/standard-box";
import { loadConsolidationConfig } from "@/lib/packing/consolidation-config";
import { logPackDebug } from "@/lib/packing/pack-debug";
import type { FlaggedTable, Item, Packer, PackingResult, SkippedTable, Van } from "@/lib/packing/packing.types";
import type { ClassificationResult } from "@/lib/classification/types";
import type { DurabilityOverride } from "@/lib/classification/durability.types";
import type { StructuredDocument } from "@/lib/conversion/types";

const logger = createLogger("packing.service");

/** Message is shown to the end user as-is (see the red banner in page.tsx) — plain English, no internal names. */
export class PackingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackingError";
  }
}

export interface PackJobInput {
  readonly doc: StructuredDocument;
  readonly classification: ClassificationResult;
  /** Preferred van id; when omitted the whole fleet is ranked. */
  readonly vanId?: string;
  /** Per-row human corrections of the durability facts (see AssembleInput). */
  readonly durabilityOverrides?: ReadonlyMap<string, DurabilityOverride>;
  /**
   * Client-supplied fleet override (the session "Fleet setup" catalogue) — already
   * validated at the API boundary; when present, used INSTEAD of config/vans.json
   * for this pack.
   */
  readonly vans?: Van[];
  /**
   * Quick operator toggle: false ⇒ pack this job with NO reach-height cap (a
   * worker may place a box at any height). Omitted/true ⇒ the configured
   * `PACKING_MAX_REACH_HEIGHT_M` limit applies, as normal.
   */
  readonly respectReachLimit?: boolean;
  /** Correlation id for logs (the API request id); only used by the debug trace. */
  readonly requestId?: string;
}

export interface VanRanking {
  readonly vanId: string;
  readonly label: string;
  readonly utilization: number;
  readonly fits: boolean;
  readonly placedUnits: number;
  readonly packableUnits: number;
  readonly result: PackingResult;
}

export interface PackJobResult {
  readonly items: Item[];
  /**
   * Tables Stage 2 classified as items but the packer skipped whole (no dimension
   * AND no pallet columns). Empty on a clean job; non-empty drives the load-plan
   * warning so a real table never vanishes into a silent "0/0 placed".
   */
  readonly skippedTables: SkippedTable[];
  /**
   * Cargo tables the packer read but had to guess a header fact for (assumed unit,
   * or a size column located by fixed position). Empty on a clean, well-marked
   * sheet; non-empty drives the "verify these sizes" review flag on the load plan.
   */
  readonly flaggedTables: FlaggedTable[];
  /** Units with valid dimensions (missing-dimension rows are never packable). */
  readonly packableUnits: number;
  /** The chosen fleet, in load order — one PackingResult per van used. */
  readonly fleet: PackingResult[];
  /** Convenience alias for fleet[0] (the first/primary van); legacy callers. */
  readonly selected: PackingResult;
  /** Single-van comparison across the fleet (answers "could one van do it"). */
  readonly ranking: VanRanking[];
  /** False ⇒ no single configured van holds the whole job (multi-van plan). */
  readonly fitsInSingleVan: boolean;
  /** Cargo no van in the fleet can carry (oversized / missing dimensions). */
  readonly unplaced: Item[];
  /** itemId → why it (or part of it) could not be carried. */
  readonly reasons: Record<string, string>;
  /** Σ perMileRate across the chosen fleet — drives the multi-van quote. */
  readonly totalPerMileRate: number;
  /** Clearance slack (m) used — echoed so the 3D editor validates identically. */
  readonly toleranceM: number;
  /** Max reach height (m) used — echoed so the 3D editor validates identically.
   *  null ⇒ `respectReachLimit: false` was requested, so no cap applied. */
  readonly maxReachHeightM: number | null;
  /**
   * Consolidated-block id → display metadata, for NAME RESOLUTION ONLY (the 3D
   * viewer's placements reference block ids like "<sourceId>::block", which never
   * appear in `items` — that list stays pre-consolidation for the review table).
   * Empty when consolidation is off — fail-safe, no behaviour change.
   */
  readonly blockLabels: { id: string; name: string; unitsPerBlock: number }[];
  readonly perf: PerfReport;
}

function countPackableUnits(items: Item[]): number {
  return items.reduce((n, i) => (i.dimensions === null ? n : n + Math.max(1, i.quantity)), 0);
}

/**
 * A bounded slice of a (possibly huge) block list — caps the summed placeable-object
 * count so the per-van ranking on a bulk order packs a representative sample instead
 * of re-scanning every block (the very cost the bulk fast-path exists to avoid).
 */
function capItemsToBlocks(items: Item[], cap: number): Item[] {
  const out: Item[] = [];
  let used = 0;
  for (const it of items) {
    if (it.dimensions === null) {
      out.push(it);
      continue;
    }
    if (used >= cap) break;
    const take = Math.min(Math.max(1, it.quantity), cap - used);
    out.push({ ...it, quantity: take });
    used += take;
  }
  return out;
}

/**
 * Real-unit count behind one Item/Placement row — `unitsPerBlock × quantity` for a
 * consolidated block, `quantity` (min 1) otherwise. The single conversion point
 * (Phase 5) so every reported total (placed/unplaced/fragile/pricing) counts REAL
 * units, never the block/placeable-object count the packer actually iterated over.
 */
function realUnitsOf(row: { readonly quantity: number }, id: string, blockMeta: ReadonlyMap<string, BlockMeta>): number {
  const meta = blockMeta.get(id);
  return meta ? meta.unitsPerBlock * Math.max(1, row.quantity) : Math.max(1, row.quantity);
}

/** Σ real units across a placements list (blocks expanded via blockMeta). */
function realUnitsOfPlacements(placements: readonly { itemId: string }[], blockMeta: ReadonlyMap<string, BlockMeta>): number {
  return placements.reduce((n, p) => n + realUnitsOf({ quantity: 1 }, p.itemId, blockMeta), 0);
}

/**
 * Re-expresses an unplaced/reporting Item list in REAL units: a block row's
 * quantity (blocks) becomes real units and its name reads "5,000 × <unit name>"
 * (blockMeta already carries that formatted label from consolidation.ts).
 * Non-block rows pass through unchanged.
 */
function expandItemsToRealUnits(items: readonly Item[], blockMeta: ReadonlyMap<string, BlockMeta>): Item[] {
  return items.map((item) => {
    const meta = blockMeta.get(item.id);
    if (!meta) return item;
    return { ...item, name: `${(meta.unitsPerBlock * Math.max(1, item.quantity)).toLocaleString()} × ${meta.label.replace(/^[\d,]+ × /, "")}`, quantity: meta.unitsPerBlock * Math.max(1, item.quantity) };
  });
}

/** fits-first, then tightest pack; partial packs ranked by units placed. */
export function compareRankings(a: VanRanking, b: VanRanking): number {
  if (a.fits !== b.fits) return a.fits ? -1 : 1;
  if (a.fits && b.fits) return b.utilization - a.utilization;
  if (a.placedUnits !== b.placedUnits) return b.placedUnits - a.placedUnits;
  return b.utilization - a.utilization;
}

export interface PackerServiceDeps {
  readonly vanRepository: VanRepository;
  readonly packer: Packer;
}

/** Default wiring: file-backed fleet (or a client-supplied override) + heuristic packer. */
function defaultDeps(vans?: Van[], respectReachLimit?: boolean): PackerServiceDeps {
  return {
    vanRepository: vans && vans.length > 0 ? new InMemoryVanRepository(vans) : new FileVanRepository(),
    packer: new HeuristicPacker({
      toleranceM: getConfig().packing.toleranceM,
      maxReachHeightM: respectReachLimit === false ? undefined : getConfig().packing.maxReachHeightM,
    }),
  };
}

export async function packJob(
  input: PackJobInput,
  deps: PackerServiceDeps = defaultDeps(input.vans, input.respectReachLimit),
): Promise<PackJobResult> {
  const perf = new PerfTracker(logger);

  const { assembled, skippedTables, flaggedTables } = await perf.track("assemble", async () => {
    const [columnMap, matrix] = await Promise.all([loadColumnMap(), loadStackabilityMatrix()]);
    const items = await assembleItems({
      doc: input.doc,
      classification: input.classification,
      columnMap,
      matrix,
      durabilityOverrides: input.durabilityOverrides,
    });
    // Tables Stage 2 classified but the packer can't build load units from (no
    // dimension AND no pallet columns) — surfaced so the load plan warns instead of
    // showing a bare "0/0 placed". Shares isCargoTable with the assembler's drop gate.
    const skipped = skippedCargoTables(input.doc, input.classification, columnMap);
    // Cargo tables read but with a guessed unit / fixed-position size column — the
    // operator is asked to verify (never silently trusted). Shares its predicates
    // with the assembler, so a table is at most one of skipped vs flagged.
    const flagged = flaggedCargoTables(input.doc, input.classification, columnMap);
    return { assembled: items, skippedTables: skipped, flaggedTables: flagged };
  });

  const realUnits = countPackableUnits(assembled);
  // ALL assembled units, including rows the assembler couldn't read a size for
  // (dimensions: null). Those rows are never packable, but they still exist and
  // must land in `unplaced` with a reason — the conservation gate below has to
  // check against this total, not `realUnits` (which excludes them), or a single
  // unreadable row makes placed+unplaced fall short of "expected" and throws.
  const allUnits = totalUnits(assembled);

  // Multi-drop groupage: when the manifest tagged cargo rows to delivery stops, load
  // each van in drop order (earliest stop at the doors) by wrapping the packer in the
  // zoned packer. Single-drop jobs (no stopIndex anywhere) keep the bare packer, so
  // their load plan stays byte-identical. If consolidation later collapses tagged rows
  // into blocks that lose the tag, the zoned packer degrades to one deepest band — a
  // safe no-op, never a crash or a dropped item.
  const isMultiStop = assembled.some((i) => i.stopIndex !== undefined);
  const packer = isMultiStop ? new ZonedPacker({ inner: deps.packer }) : deps.packer;

  // Real memory/time ceiling on the pre-consolidation unit expansion (Phase 2) — a
  // single pathological SKU (huge typo'd quantity) must fail loud here even though
  // it would consolidate into a handful of blocks, because building/holding the
  // intermediate per-unit accounting still costs real memory. Distinct from the
  // maxPackableUnits check below, which only applies when consolidation is off.
  const {maxConsolidatedUnits} = getConfig().packing;
  if (realUnits > maxConsolidatedUnits) {
    throw new PackingError(
      `This order expands to about ${realUnits.toLocaleString()} individual units — beyond the ` +
        `${maxConsolidatedUnits.toLocaleString()} this quote can account for in a single pass. ` +
        `Split it into two or more quotes for now, and flag it so we can raise the limit for orders this size.`,
    );
  }

  // Block consolidation (Stage 3, huge-order path): identical-SKU rows collapse into
  // palletised blocks BEFORE the cap check and the packer/allocator ever see them, so
  // a 37,506-unit order of one SKU becomes a few hundred placeable blocks. Disabled or
  // a bad config ⇒ items pass through unchanged (fail-safe, no behaviour change).
  const consolidationCfg = await loadConsolidationConfig();
  let items = assembled;
  const blockMeta = new Map<string, BlockMeta>();
  if (consolidationCfg.enabled) {
    // Unbounded synthetic interior: grid sizing is bounded purely by the config's
    // footprintCapM/heightCapM (not any one van's dimensions), since the fleet may
    // hold several van sizes — an over-large block simply goes unplaced in a small
    // van, exactly like any other oversized item, and Phase 4 splitting can recover it.
    const unboundedInterior = { l: Number.POSITIVE_INFINITY, w: Number.POSITIVE_INFINITY, h: Number.POSITIVE_INFINITY };
    const result = consolidate(assembled, unboundedInterior, consolidationCfg);
    items = result.items;
    for (const [k, v] of result.meta) blockMeta.set(k, v);

    // Diverse-order path: identical-SKU consolidation above cannot collapse an order
    // of many DIFFERENT small items (each a distinct SKU). Box those loose units onto
    // shared standard boxes (mixed pallets) so a diverse 10k-unit order becomes a few
    // hundred placeable boxes instead of tripping the block cap. No-op below its own
    // minUnitsToBox threshold, so small/normal orders stay byte-identical.
    // Skip items consolidate() already turned into blocks — their `quantity` is a
    // block count, not real units, so re-boxing them would miscount.
    const boxed = boxLooseItems(items, consolidationCfg.box, new Set(blockMeta.keys()));
    items = boxed.items;
    for (const [k, v] of boxed.meta) blockMeta.set(k, v);
  }

  // Block count (post-consolidation) — what the packer/allocator actually iterate
  // over; distinct from `realUnits` above, which is what the UI/quote reports.
  const blockPackableUnits = countPackableUnits(items);

  const vans = await perf.track("load-vans", async () => {
    const all = await deps.vanRepository.listVans();
    if (input.vanId) {
      const one = all.find((v) => v.id === input.vanId);
      if (!one) throw new PackingError(`unknown van id "${input.vanId}"`);
      return [one];
    }
    return all.slice(0, getConfig().packing.maxVansToConsider);
  });

  // Clearance slack (echoed to the 3D editor so client and packer never desync) and
  // reach-height policy — needed by both the bulk fast-path and the normal allocator.
  const {toleranceM, maxPackableUnits, maxPackableBlocks, bulkRunMinUnits} = getConfig().packing;
  const maxReachHeightM =
    input.respectReachLimit === false ? undefined : getConfig().packing.maxReachHeightM;

  // Bulk-run fast-path (huge single-SKU orders): when one dominant SKU consolidates to
  // thousands of identical blocks, pack ONE representative van and multiply it instead
  // of running an anchor scan per block — an O(1)-pack quote for an order that would
  // otherwise blow `maxPackableBlocks` and time out. Null ⇒ not a clean bulk run, so
  // the block-count cap and the exact/greedy allocator run exactly as before.
  const bulkPlan = consolidationCfg.enabled
    ? await perf.track("bulk-allocate", async () =>
        tryBulkAllocate(items, vans, packer, { toleranceM, minDominantUnits: bulkRunMinUnits }),
      )
    : null;

  let ranking: VanRanking[];
  let plan: FleetPlan;

  if (bulkPlan !== null) {
    plan = bulkPlan;
    // Rank on a bounded representative slice — packing every block into every van is
    // the exact cost this path avoids. `fits` stays false (a bulk order needs many vans).
    ranking = await perf.track("pack", async () =>
      rankVans(capItemsToBlocks(items, defaultPackCap()), vans, blockPackableUnits, packer, blockMeta),
    );
  } else {
    // Safety valve, not a business ceiling: the pack runs synchronously in the request,
    // so an extreme job could hang the connection until it times out. Reached only when
    // the order is too VARIED to auto-optimise into one pass (a single bulk SKU takes the
    // fast-path above) — fail loud with a plain-English explanation rather than leave the
    // page spinning. Tunable via PACKING_MAX_PACKABLE_UNITS / _BLOCKS.
    //
    // Post-consolidation this guard trips on the BLOCK/placeable-object count instead of
    // the raw unit count (maxPackableBlocks) — blocks are what the packer/allocator
    // actually iterate over, so that count (not the real-unit total) is what bounds runtime.
    if (consolidationCfg.enabled) {
      if (blockPackableUnits > maxPackableBlocks) {
        throw new PackingError(
          `This order consolidates to about ${blockPackableUnits.toLocaleString()} placeable blocks across too ` +
            `many different items to auto-optimise into one pass — beyond the ${maxPackableBlocks.toLocaleString()} ` +
            `this quote can pack before the request times out. Split it into two or more quotes for now, and flag ` +
            `it so we can raise the limit for orders this size.`,
        );
      }
    } else if (blockPackableUnits > maxPackableUnits) {
      throw new PackingError(
        `This order expands to about ${blockPackableUnits.toLocaleString()} individual boxes — beyond the ` +
          `${maxPackableUnits.toLocaleString()} this quote can pack in a single pass before the request times out. ` +
          `Split it into two or more quotes for now, and flag it so we can raise the limit for orders this size.`,
      );
    }

    // rankVans/allocateFleet operate on `items` (post-consolidation — blocks, the
    // objects they actually iterate over); the RANKED/reported numbers below are
    // converted back to real units (Phase 5) via blockMeta before they reach the UI.
    ranking = await perf.track("pack", async () =>
      rankVans(items, vans, blockPackableUnits, packer, blockMeta),
    );

    // Cheapest combination of vans that carries the WHOLE job (overflow → +vans).
    plan = await perf.track("allocate", async () =>
      allocateFleet(items, vans, packer, { toleranceM }),
    );
  }

  // Phase 4 — minimal-split preference: blocks are packed WHOLE by default; only a
  // block that failed to place gets ONE split retry (never recursive — no infinite
  // loops) into two smaller sub-blocks, re-run against whatever fleet capacity the
  // first pass didn't already commit. A block that can't be split (already at/below
  // minSplitFraction) or still doesn't fit stays unplaced, exactly like any other item.
  if (consolidationCfg.enabled) {
    const splitItems: Item[] = [];
    const stillUnplaced: Item[] = [];
    for (const u of plan.unplaced) {
      const bm = blockMeta.get(u.id);
      const split = bm ? splitBlockInHalf(u, bm, consolidationCfg) : null;
      if (!split) {
        stillUnplaced.push(u);
        continue;
      }
      splitItems.push(...split.items);
      for (const [k, v] of split.meta) blockMeta.set(k, v);
    }

    if (splitItems.length > 0) {
      // Capacity the first pass didn't already consume — vans it fully used up
      // (quantity exhausted) are excluded so the retry never double-books a vehicle.
      const usedCount = new Map<string, number>();
      for (const r of plan.vans) usedCount.set(r.van.id, (usedCount.get(r.van.id) ?? 0) + 1);
      const retryVans = vans
        .map((v) => ({ ...v, quantity: Math.max(0, vanQuantity(v) - (usedCount.get(v.id) ?? 0)) }))
        .filter((v) => (v.quantity ?? 0) > 0);

      if (retryVans.length > 0) {
        const splitPlan = await perf.track("allocate-split-retry", async () =>
          allocateFleet(splitItems, retryVans, packer, { toleranceM }),
        );
        plan = {
          vans: [...plan.vans, ...splitPlan.vans],
          unplaced: [...stillUnplaced, ...splitPlan.unplaced],
          reasons: { ...plan.reasons, ...splitPlan.reasons },
          packableUnits: plan.packableUnits,
          placedUnits: plan.placedUnits + splitPlan.placedUnits,
          fitsInSingleVan: plan.fitsInSingleVan && splitPlan.unplaced.length === 0,
          totalPerMileRate: plan.totalPerMileRate + splitPlan.totalPerMileRate,
        };
      } else {
        plan = { ...plan, unplaced: [...stillUnplaced, ...splitItems] };
      }
    }
  }

  // Independent verify gate: re-check every emitted van layout from scratch
  // (overlaps, interior bounds, support) with the same whole-arrangement pass the
  // 3D editor uses. The packer validates per-placement while building; this guards
  // against a packer bug or future packer swap emitting an illegal plan. Fail loud.
  await perf.track("verify", async () => {
    // Bulk-run replicas share ONE PackingResult reference (identical layout), so validate
    // each distinct layout once — revalidating thousands of identical vans would reintroduce
    // the very cost the fast-path removes. Non-bulk vans are all distinct refs ⇒ each checked.
    const validated = new Set<PackingResult>();
    for (const vanResult of plan.vans) {
      if (validated.has(vanResult)) continue;
      validated.add(vanResult);
      const check = validateArrangement(vanResult.placements, vanResult.van.interior, toleranceM, maxReachHeightM);
      if (!check.ok) {
        logger.error("verify gate rejected plan", {
          vanId: vanResult.van.id,
          reason: check.reason,
          boxes: vanResult.placements.length,
        });
        // Surface the SPECIFIC rule that fired (not a generic "contact support"): this is an
        // internal ops tool, the packer built this very plan, and a swallowed reason hides
        // whether it's a real packer bug or an over-strict re-check. "Never guess" → make it visible.
        throw new PackingError(
          `The calculated loading plan failed an internal safety re-check and was not issued ` +
            `(${check.reason}; van ${vanResult.van.id}, ${vanResult.placements.length} boxes). ` +
            `Please try again or contact support if this keeps happening.`,
        );
      }
    }
  });

  // selected = primary van; fall back to the best single-van attempt when nothing
  // is packable (so the UI still has a van/interior to render an empty plan).
  const selected = plan.vans[0] ?? ranking[0]?.result;
  if (!selected) throw new PackingError("no vans available to pack into");

  // Phase 5 — expand block placements back to REAL units for every reported total.
  // The packer/allocator only ever saw blocks; everything the UI/quote reads from
  // here on must read like the pre-consolidation order (per-unit counts, fragile
  // flags per row, "5,000 × <unit name>" labels), never the placeable-object count.
  const placedUnitsReal = plan.vans.reduce((n, r) => n + realUnitsOfPlacements(r.placements, blockMeta), 0);
  const unplacedReal = expandItemsToRealUnits(plan.unplaced, blockMeta);
  const unplacedRealUnits = unplacedReal.reduce((n, i) => n + Math.max(1, i.quantity), 0);

  // Conservation invariant (Phase 5): every real unit the order started with is
  // either placed somewhere in the fleet or accounted for in unplaced — never both,
  // never neither. A mismatch here means consolidation/expansion silently dropped
  // or duplicated units — fail loud rather than ship a quote that's wrong.
  if (placedUnitsReal + unplacedRealUnits !== allUnits) {
    throw new PackingError(
      `Internal accounting error: ${placedUnitsReal.toLocaleString()} placed + ` +
        `${unplacedRealUnits.toLocaleString()} unplaced real units does not match the ` +
        `${allUnits.toLocaleString()} the order started with. Please contact support.`,
    );
  }

  logger.info("packing complete", {
    items: items.length,
    packableUnits: realUnits,
    blockPackableUnits,
    vansTried: vans.length,
    vansUsed: plan.vans.length,
    placedUnits: placedUnitsReal,
    unplaced: unplacedReal.length,
    fitsInSingleVan: plan.fitsInSingleVan,
    totalPerMileRate: Math.round(plan.totalPerMileRate * 100) / 100,
  });

  // Per-van "why isn't this van fuller?" trace — no-op unless PACKING_DEBUG is on.
  logPackDebug(
    plan.vans.map((r) => ({
      vanId: r.van.id,
      vanLabel: r.van.label,
      interior: r.van.interior,
      maxPayloadKg: r.van.maxPayloadKg,
      placements: r.placements,
    })),
    {
      jobId: input.requestId ?? "pack",
      maxReachHeightM: maxReachHeightM ?? null,
      unplacedUnits: unplacedRealUnits,
    },
  );

  return {
    items: assembled,
    skippedTables,
    flaggedTables,
    packableUnits: realUnits,
    fleet: plan.vans,
    selected,
    ranking,
    fitsInSingleVan: plan.fitsInSingleVan,
    unplaced: unplacedReal,
    reasons: plan.reasons,
    totalPerMileRate: plan.totalPerMileRate,
    toleranceM,
    maxReachHeightM: maxReachHeightM ?? null,
    blockLabels: Array.from(blockMeta, ([id, meta]) => ({
      id,
      name: meta.label,
      unitsPerBlock: meta.unitsPerBlock,
    })),
    perf: perf.report(),
  };
}

/**
 * `packableUnits`/`blockMeta` are in the SAME units as `items` — real units when
 * called without consolidation (existing callers/tests), block counts + a meta
 * map when called post-consolidation from packJob. `fits` always compares in
 * that native unit (block-for-block or unit-for-unit), so the "does this van
 * take the whole job" signal is unaffected either way; only the reported
 * `placedUnits`/`packableUnits` are expanded to real units for the UI when a
 * blockMeta is supplied.
 */
export function rankVans(
  items: Item[],
  vans: Van[],
  packableUnits: number,
  packer: Packer,
  blockMeta: ReadonlyMap<string, BlockMeta> = new Map(),
): VanRanking[] {
  const realPackableUnits = blockMeta.size > 0
    ? items.reduce((n, i) => n + realUnitsOf(i, i.id, blockMeta), 0)
    : packableUnits;
  const rankings = vans.map((van): VanRanking => {
    const result = packer.pack(items, van);
    const placedReal = blockMeta.size > 0 ? realUnitsOfPlacements(result.placements, blockMeta) : result.placements.length;
    return {
      vanId: van.id,
      label: van.label,
      utilization: result.utilization,
      placedUnits: placedReal,
      packableUnits: realPackableUnits,
      fits: result.placements.length === packableUnits,
      result,
    };
  });
  return rankings.sort(compareRankings);
}
