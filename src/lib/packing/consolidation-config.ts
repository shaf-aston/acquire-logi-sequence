/**
 * Loads + validates the editable block-consolidation knobs from disk (path from
 * config). Mirrors the stackability.ts loader pattern (load + parse-from hook,
 * fail loud on a malformed file). Config-not-constants per CLAUDE.md — every
 * tunable here lives in config/consolidation.json, never hardcoded in the
 * consolidation/packer modules that consume it.
 */
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import { loadJsonFile } from "@/lib/packing/config-loader";
import type { ConsolidationConfig } from "@/lib/packing/consolidation";
import type { BoxConfig } from "@/lib/packing/standard-box";

export class ConsolidationConfigError extends Error {
  constructor(message: string) {
    super(`[consolidation-config] ${message}`);
    this.name = "ConsolidationConfigError";
  }
}

/** Default (disabled) box config — used when the file omits the "box" block (older configs stay valid). */
const DEFAULT_BOX_CONFIG: BoxConfig = {
  enabled: false,
  footprintM: { l: 1.2, w: 1.0 },
  maxHeightM: 1.2,
  maxBoxWeightKg: 500,
  fillFraction: 0.85,
  minUnitsToBox: 100,
};

/** The on-disk shape: domain knobs (incl. minSplitFraction — see consolidation.ts) plus the feature flag and the box block. */
export interface ConsolidationFileConfig extends ConsolidationConfig {
  readonly enabled: boolean;
  /** Mixed-item box consolidation knobs (standard-box.ts). */
  readonly box: BoxConfig;
}

function parseConsolidationFileConfig(json: unknown): ConsolidationFileConfig {
  if (typeof json !== "object" || json === null) {
    throw new ConsolidationConfigError("file must be a JSON object");
  }
  const o = json as Record<string, unknown>;

  const bool = (key: string, fallback: boolean): boolean => {
    const v = o[key];
    if (v === undefined) return fallback;
    if (typeof v !== "boolean") throw new ConsolidationConfigError(`"${key}" must be a boolean`);
    return v;
  };
  // Every numeric knob here is a physical divisor or a hard cap somewhere in
  // consolidation.ts — zero or negative would silently produce nonsense grids
  // (divide-by-zero, 0-unit blocks) rather than failing loud, so reject at load.
  const positiveNum = (key: string): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new ConsolidationConfigError(`"${key}" must be a positive number`);
    }
    return v;
  };
  const fraction01 = (key: string): number => {
    const v = positiveNum(key);
    if (v > 1) throw new ConsolidationConfigError(`"${key}" must be in (0, 1]`);
    return v;
  };
  const positiveInt = (key: string): number => {
    const v = positiveNum(key);
    if (!Number.isInteger(v)) throw new ConsolidationConfigError(`"${key}" must be a positive integer`);
    return v;
  };

  return {
    enabled: bool("enabled", true),
    minUnitsToConsolidate: positiveInt("minUnitsToConsolidate"),
    maxBlockUnits: positiveInt("maxBlockUnits"),
    minSplitFraction: fraction01("minSplitFraction"),
    footprintCapM: positiveNum("footprintCapM"),
    heightCapM: positiveNum("heightCapM"),
    box: parseBoxConfig(o.box),
  };
}

/**
 * Parse the mixed-item box block. Absent ⇒ disabled default (keeps older config
 * files valid). Present ⇒ every physical knob must be a positive number and
 * fillFraction a (0,1] fraction — a zero/negative footprint or fill would produce
 * nonsense boxes (divide-by-zero, infinite bins) rather than failing loud.
 */
function parseBoxConfig(value: unknown): BoxConfig {
  if (value === undefined) return DEFAULT_BOX_CONFIG;
  if (typeof value !== "object" || value === null) {
    throw new ConsolidationConfigError('"box" must be an object');
  }
  const o = value as Record<string, unknown>;
  const pos = (v: unknown, key: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new ConsolidationConfigError(`box.${key} must be a positive number`);
    }
    return v;
  };
  const fp = o.footprintM;
  if (typeof fp !== "object" || fp === null) {
    throw new ConsolidationConfigError('"box.footprintM" must be an object');
  }
  const f = fp as Record<string, unknown>;
  const fill = pos(o.fillFraction, "fillFraction");
  if (fill > 1) throw new ConsolidationConfigError("box.fillFraction must be in (0, 1]");
  const minUnits = pos(o.minUnitsToBox, "minUnitsToBox");
  if (!Number.isInteger(minUnits)) throw new ConsolidationConfigError("box.minUnitsToBox must be a positive integer");
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : true,
    footprintM: { l: pos(f.l, "footprintM.l"), w: pos(f.w, "footprintM.w") },
    maxHeightM: pos(o.maxHeightM, "maxHeightM"),
    maxBoxWeightKg: pos(o.maxBoxWeightKg, "maxBoxWeightKg"),
    fillFraction: fill,
    minUnitsToBox: minUnits,
  };
}

let cached: ConsolidationFileConfig | null = null;

export async function loadConsolidationConfig(): Promise<ConsolidationFileConfig> {
  if (cached) return cached;
  const path = resolve(process.cwd(), getConfig().packing.consolidationPath);
  cached = await loadJsonFile(path, parseConsolidationFileConfig, ConsolidationConfigError);
  return cached;
}

/** Test hook — parse a config object without touching disk or the cache. */
export function parseConsolidationConfigFrom(json: unknown): ConsolidationFileConfig {
  return parseConsolidationFileConfig(json);
}
