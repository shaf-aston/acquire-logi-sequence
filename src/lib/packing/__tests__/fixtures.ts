/** Shared builders for packing tests (not a test file). */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Dimensions, Item, Van } from "@/lib/packing/packing.types";

let nextId = 0;

export function makeItem(overrides: Partial<Item> = {}): Item {
  const dimensions: Dimensions | null =
    overrides.dimensions !== undefined ? overrides.dimensions : { l: 0.6, w: 0.6, h: 0.7 };
  return {
    id: overrides.id ?? `item-${nextId++}`,
    name: overrides.name ?? "test item",
    dimensions,
    weightKg: overrides.weightKg ?? 10,
    quantity: overrides.quantity ?? 1,
    fragility: overrides.fragility ?? "standard",
    category: overrides.category ?? "base-cabinet",
    stackable: overrides.stackable ?? true,
    canSupportWeightKg: overrides.canSupportWeightKg ?? 80,
    orientationLock: overrides.orientationLock ?? "none",
    maxStackPressureKpa: overrides.maxStackPressureKpa ?? 50,
    material: overrides.material ?? null,
    durabilityTier: overrides.durabilityTier ?? "medium",
    durabilityConfident: overrides.durabilityConfident ?? true,
    brittle: overrides.brittle ?? false,
    deformable: overrides.deformable ?? false,
    stopIndex: overrides.stopIndex,
  };
}

export function makeVan(overrides: Partial<Van> = {}): Van {
  return {
    id: overrides.id ?? "test-van",
    label: overrides.label ?? "Test Van",
    interior: overrides.interior ?? { l: 3.0, w: 1.8, h: 1.9 },
    maxPayloadKg: overrides.maxPayloadKg ?? 1500,
    doorAperture: overrides.doorAperture,
    perMileRate: overrides.perMileRate ?? 1.5,
    fuelCostPerMile: overrides.fuelCostPerMile,
    co2GramsPerMile: overrides.co2GramsPerMile,
    quantity: overrides.quantity,
    sizeClass: overrides.sizeClass,
  };
}

/**
 * Deterministic large cargo list for stress/robustness tests. Mixes box sizes,
 * weights, fragile/stackable flags, plus a few dimensionless and oversized units
 * so the unplaced-accounting invariant is exercised. No randomness — index-driven.
 */
export function makeLargeCargo(count = 200): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 50 === 0) {
      // Dimensionless — must land in unplaced (missing dimensions).
      items.push(makeItem({ id: `dimless-${i}`, dimensions: null }));
      continue;
    }
    if (i % 73 === 0) {
      // Oversized — fits no van.
      items.push(makeItem({ id: `huge-${i}`, dimensions: { l: 9.0, w: 5.0, h: 5.0 } }));
      continue;
    }
    const l = 0.3 + (i % 7) * 0.08;
    const w = 0.3 + (i % 5) * 0.07;
    const h = 0.3 + (i % 4) * 0.09;
    items.push(
      makeItem({
        id: `box-${i}`,
        dimensions: { l, w, h },
        weightKg: 5 + (i % 9) * 4,
        fragility: i % 11 === 0 ? "fragile" : "standard",
        stackable: i % 13 !== 0,
      }),
    );
  }
  return items;
}

/** Sum of remaining quantities across an unplaced list. */
export function totalQuantity(items: Item[]): number {
  return items.reduce((n, i) => n + Math.max(1, i.quantity), 0);
}

/** Read a shipped config JSON from disk (proves the real files parse). */
export function readConfigJson(relative: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), relative), "utf8"));
}
