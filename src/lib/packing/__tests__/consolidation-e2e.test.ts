/**
 * Phases 3–6 integration: consolidate → pack blocks with the real heuristic
 * packer/fleet-allocator → re-check with the independent verify gate, proving
 * a huge identical-SKU order collapses into a handful of blocks, conserves
 * every real unit, and never lets the verify gate wave through a crushing
 * block-on-block stack.
 */
import { describe, it, expect } from "vitest";
import { consolidate, DEFAULT_CONSOLIDATION_CONFIG, type ConsolidationConfig } from "@/lib/packing/consolidation";
import { boxLooseItems, type BoxConfig } from "@/lib/packing/standard-box";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { allocateFleet } from "@/lib/packing/fleet-allocator";
import { validateArrangement } from "@/lib/packing/placement-validator";
import { makeItem, makeVan } from "./fixtures";
import type { Dimensions, Placement } from "@/lib/packing/packing.types";

const packer = new HeuristicPacker({ toleranceM: 0.005 });
const opts = { toleranceM: 0.005 };

describe("Phase 3/4/5 — huge identical-SKU order via consolidation", () => {
  const cfg: ConsolidationConfig = { ...DEFAULT_CONSOLIDATION_CONFIG, minUnitsToConsolidate: 20, maxBlockUnits: 200 };
  // Large enough (interior + payload + fleet quantity) that fleet CAPACITY itself
  // is never the binding constraint here — this test proves the consolidation +
  // verify-gate math, not the (separate, pre-existing) fleet-exhaustion behaviour.
  const van = makeVan({ id: "big-van", interior: { l: 40, w: 20, h: 20 }, maxPayloadKg: 500_000, perMileRate: 2, quantity: 5 });

  it("packs 37,506 identical small units as a handful of blocks and the verify gate accepts the plan", () => {
    const original = makeItem({
      id: "sku-huge",
      dimensions: { l: 0.3, w: 0.3, h: 0.3 },
      weightKg: 8,
      canSupportWeightKg: 200,
      maxStackPressureKpa: 80,
      orientationLock: "none",
      stackable: true,
      quantity: 37_506,
    });

    const unboundedInterior: Dimensions = { l: Number.POSITIVE_INFINITY, w: Number.POSITIVE_INFINITY, h: Number.POSITIVE_INFINITY };
    const { items: consolidated, meta } = consolidate([original], unboundedInterior, cfg);

    // Collapsed to a small number of placeable objects (blocks), not 37,506 rows.
    expect(consolidated.length).toBeLessThan(50);

    const plan = allocateFleet(consolidated, [van], packer, opts);

    // Verify gate: every van's plan must independently re-check as safe.
    for (const vanResult of plan.vans) {
      const check = validateArrangement(vanResult.placements, vanResult.van.interior, opts.toleranceM);
      expect(check.ok).toBe(true);
    }

    // Conservation: placed (expanded via meta) + unplaced (expanded) === original quantity.
    const realUnitsOf = (id: string, qty: number) => {
      const bm = meta.get(id);
      return bm ? bm.unitsPerBlock * qty : qty;
    };
    const placedReal = plan.vans.reduce(
      (n, r) => n + r.placements.reduce((m, p) => m + realUnitsOf(p.itemId, 1), 0),
      0,
    );
    const unplacedReal = plan.unplaced.reduce((n, i) => n + realUnitsOf(i.id, Math.max(1, i.quantity)), 0);
    expect(placedReal + unplacedReal).toBe(37_506);
  });
});

describe("Phase 3/4/5 — DIVERSE huge order via mixed-item boxing", () => {
  // The pipeline order the packer.service runs: consolidate (identical-SKU) THEN
  // boxLooseItems (diverse remainder). This proves a diverse order that identical-
  // SKU consolidation CANNOT collapse still packs safely instead of tripping the cap.
  // minUnitsToConsolidate 50 so each SKU's 15 units stays LOOSE (identical-SKU
  // consolidation can't touch it) — the exact case boxing exists for.
  const cfg: ConsolidationConfig = { ...DEFAULT_CONSOLIDATION_CONFIG, minUnitsToConsolidate: 50, maxBlockUnits: 200 };
  const boxCfg: BoxConfig = { enabled: true, footprintM: { l: 1.2, w: 1.0 }, maxHeightM: 1.2, maxBoxWeightKg: 500, fillFraction: 0.85, minUnitsToBox: 100 };
  const van = makeVan({ id: "big-van", interior: { l: 40, w: 20, h: 20 }, maxPayloadKg: 500_000, perMileRate: 2, quantity: 20 });

  it("boxes a 6,000-unit order of 400 distinct low-qty SKUs under the block cap; the verify gate accepts the plan", () => {
    // 400 different small SKUs × 15 units each — none identical enough to consolidate,
    // so all 6,000 stay loose placeable units (would trip a 2,000-block cap at scale).
    const diverse = Array.from({ length: 400 }, (_, i) =>
      makeItem({ id: `sku-${i}`, name: `SKU ${i}`, dimensions: { l: 0.2, w: 0.2, h: 0.2 }, weightKg: 1, canSupportWeightKg: 120, maxStackPressureKpa: 60, quantity: 15 }),
    );
    const totalUnits = diverse.reduce((n, it) => n + it.quantity, 0);
    expect(totalUnits).toBe(6_000);

    const unbounded: Dimensions = { l: Number.POSITIVE_INFINITY, w: Number.POSITIVE_INFINITY, h: Number.POSITIVE_INFINITY };
    const step1 = consolidate(diverse, unbounded, cfg);
    expect(step1.meta.size).toBe(0); // nothing consolidated — all still loose
    const step2 = boxLooseItems(step1.items, boxCfg, new Set(step1.meta.keys()));

    // Boxed down to a few hundred placeable objects — comfortably under the cap.
    const placeable = step2.items.reduce((n, it) => n + Math.max(1, it.quantity), 0);
    expect(placeable).toBeLessThan(2_000);
    expect(placeable).toBeLessThan(6_000); // genuinely reduced, not a pass-through

    const meta = new Map([...step1.meta, ...step2.meta]);
    const plan = allocateFleet(step2.items, [van], packer, opts);

    // Verify gate: every packed van re-checks as safe (boxes never crush what's on them).
    for (const vanResult of plan.vans) {
      expect(validateArrangement(vanResult.placements, vanResult.van.interior, opts.toleranceM).ok).toBe(true);
    }

    // Conservation: real units placed + unplaced === the original 6,000.
    const realUnitsOf = (id: string, qty: number) => (meta.get(id)?.unitsPerBlock ?? 1) * qty;
    const placedReal = plan.vans.reduce((n, r) => n + r.placements.reduce((m, p) => m + realUnitsOf(p.itemId, 1), 0), 0);
    const unplacedReal = plan.unplaced.reduce((n, i) => n + realUnitsOf(i.id, Math.max(1, i.quantity)), 0);
    expect(placedReal + unplacedReal).toBe(6_000);
  });
});

describe("Phase 6 — verify gate crush regression on stacked BLOCKS", () => {
  // A block whose top face can bear exactly RESIDUAL_KG more before crushing.
  const RESIDUAL_KG = 40;
  const CONTACT_AREA_M2 = 1.0; // 1m x 1m footprint
  // Pressure headroom chosen generously high so the WEIGHT ceiling (not pressure)
  // is the binding constraint being tested here.
  const bottomBlock: Placement = {
    itemId: "block-bottom",
    position: { x: 0, y: 0, z: 0 },
    size: { x: 1.0, y: 1.0, z: 1.0 },
    fragile: false,
    weightKg: 500,
    canSupportWeightKg: RESIDUAL_KG, // residual capacity already encodes internal crush math
    stackable: true,
    maxStackPressureKpa: 10_000, // effectively unlimited — isolate the weight-ceiling path
    brittle: false,
  };

  const stackedArrangement = (topWeightKg: number): Placement[] => {
    const topBlock: Placement = {
      itemId: "block-top",
      position: { x: 0, y: 0, z: 1.0 },
      size: { x: 1.0, y: 1.0, z: 1.0 },
      fragile: false,
      weightKg: topWeightKg,
      canSupportWeightKg: 0,
      stackable: true,
      maxStackPressureKpa: 10_000,
      brittle: false,
    };
    return [bottomBlock, topBlock];
  };

  const interior: Dimensions = { l: 4, w: 2, h: 3 };

  it("GREEN at the residual limit — a block-on-block stack exactly at capacity is accepted", () => {
    const check = validateArrangement(stackedArrangement(RESIDUAL_KG), interior, 0.005);
    expect(check.ok).toBe(true);
    void CONTACT_AREA_M2;
  });

  it("RED at residual+1 — one unit of load over the block's residual capacity is refused", () => {
    const check = validateArrangement(stackedArrangement(RESIDUAL_KG + 1), interior, 0.005);
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/exceeds what the (base|stack below) can safely carry|too heavy/);
  });
});
