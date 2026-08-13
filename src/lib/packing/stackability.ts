/**
 * Loads + validates the editable stacking matrix from disk (path from config).
 * Maps a transport category to its stacking rules; unknown categories resolve to
 * the conservative `fallback` row (nothing stacks on it, no rotation). Fails loud
 * on a malformed file. Mirrors the ruleset loader pattern (load + parse-from hook).
 */
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import { loadJsonFile } from "@/lib/packing/config-loader";
import type { OrientationLock } from "@/lib/classification/durability.types";
import { PACKING_CATEGORIES, type PackingCategory, type StackRules } from "@/lib/packing/packing.types";

const VALID_ORIENTATION_LOCKS: readonly OrientationLock[] = ["fixed", "partial", "none"];

function isOrientationLock(v: unknown): v is OrientationLock {
  return typeof v === "string" && (VALID_ORIENTATION_LOCKS as readonly string[]).includes(v);
}

export interface StackabilityMatrix {
  readonly version: number;
  readonly fallback: StackRules;
  /**
   * Ruleset for a manifest's declared pallet lines — a packaging fact (flat,
   * structurally stackable transport unit), separate from the contents-category
   * matrix below. See item-assembler.ts's isPalletLine branch for where this
   * overrides a category that would otherwise hard-veto stacking.
   */
  readonly pallet: StackRules;
  readonly categories: Readonly<Record<string, StackRules>>;
}

export class StackabilityError extends Error {
  constructor(message: string) {
    super(`[stackability] ${message}`);
    this.name = "StackabilityError";
  }
}

function parseRules(obj: unknown, where: string): StackRules {
  if (typeof obj !== "object" || obj === null) {
    throw new StackabilityError(`${where} must be an object`);
  }
  const o = obj as Record<string, unknown>;
  const num = (key: string): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new StackabilityError(`${where}.${key} must be a non-negative number`);
    }
    return v;
  };
  const bool = (key: string): boolean => {
    const v = o[key];
    if (typeof v !== "boolean") throw new StackabilityError(`${where}.${key} must be a boolean`);
    return v;
  };
  // Optional: an item with no explicit rule must not be tipped (conservative default).
  const orientationLockOptional = (key: string, fallback: OrientationLock): OrientationLock => {
    const v = o[key];
    if (v === undefined) return fallback;
    if (!isOrientationLock(v)) {
      throw new StackabilityError(`${where}.${key} must be one of: fixed, partial, none`);
    }
    return v;
  };
  return {
    stackable: bool("stackable"),
    canSupportWeightKg: num("canSupportWeightKg"),
    densityKgPerM3: num("densityKgPerM3"),
    orientationLock: orientationLockOptional("orientationLock", "fixed"),
    maxStackPressureKpa: num("maxStackPressureKpa"),
  };
}

function parseMatrix(json: unknown): StackabilityMatrix {
  if (typeof json !== "object" || json === null) {
    throw new StackabilityError("matrix must be a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const fallback = parseRules(obj.fallback, "fallback");
  const pallet = parseRules(obj.pallet, "pallet");

  const rawCategories = obj.categories;
  if (typeof rawCategories !== "object" || rawCategories === null) {
    throw new StackabilityError('"categories" must be an object');
  }
  const categories: Record<string, StackRules> = {};
  for (const [name, value] of Object.entries(rawCategories as Record<string, unknown>)) {
    categories[name] = parseRules(value, `categories.${name}`);
  }

  // A category the code knows but the JSON doesn't would silently pack with the conservative
  // fallback (wrong sizes/prices with no signal) — refuse the config at load instead.
  const missing = PACKING_CATEGORIES.filter((c) => !(c in categories));
  if (missing.length > 0) {
    throw new StackabilityError(`"categories" is missing required entries: ${missing.join(", ")}`);
  }

  return {
    version: typeof obj.version === "number" ? obj.version : 0,
    fallback,
    pallet,
    categories,
  };
}

/** Resolve the stacking rules for a category, falling back to the conservative row. */
export function resolveStackRules(
  matrix: StackabilityMatrix,
  category: PackingCategory,
): StackRules {
  return matrix.categories[category] ?? matrix.fallback;
}

let cached: StackabilityMatrix | null = null;

export async function loadStackabilityMatrix(): Promise<StackabilityMatrix> {
  if (cached) return cached;
  const path = resolve(process.cwd(), getConfig().packing.stackabilityPath);
  cached = await loadJsonFile(path, parseMatrix, StackabilityError);
  return cached;
}

/** Test hook — parse a matrix object without touching disk or the cache. */
export function parseStackabilityFrom(json: unknown): StackabilityMatrix {
  return parseMatrix(json);
}
