/**
 * Loads + validates the durabilityTier -> maxStackPressureKpa mapping
 * (config/durability-tiers.json). Combined with the category default in
 * item-assembler.ts via Math.min (most conservative wins). Fails loud on a
 * malformed file — mirrors the stackability/column-map loader pattern.
 */
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import { loadJsonFile } from "@/lib/packing/config-loader";
import type { DurabilityTier } from "@/lib/classification/durability.types";

export type DurabilityTierPressures = Readonly<Record<DurabilityTier, number>>;

/** Parsed durability-tiers config: crush pressure per tier + the deformable/brittle softeners. */
export interface DurabilityTiersConfig {
  readonly tiers: DurabilityTierPressures;
  /**
   * Multiplier (0<f≤1) applied to a deformable item's crush limit — foam/fabric
   * compresses, so it bears less on top than a rigid item of the same tier.
   * Tighten-only by construction (≤1); 1 disables softening.
   */
  readonly deformableFactor: number;
  /**
   * Multiplier (0<f≤1) applied to a brittle item's crush limit, on top of the
   * tier cap (see `minTier`) — glass/ceramic/stone cracks rather than crushing
   * gradually, so it bears less on top than a rigid item of the same tier.
   * Tighten-only by construction (≤1); 1 disables softening.
   */
  readonly brittleFactor: number;
  /**
   * Displayed/tracked durabilityTier for a row with no Material text (or one the
   * classifier didn't recognise) — informational only. Crush safety never depends
   * on this: `maxStackPressureKpa` stays at the category default in that case (see
   * item-assembler.ts), it is not derived from this placeholder tier.
   */
  readonly unclassifiedTier: DurabilityTier;
}

export class DurabilityTierPressureError extends Error {
  constructor(message: string) {
    super(`[durability-tiers] ${message}`);
    this.name = "DurabilityTierPressureError";
  }
}

const TIERS: readonly DurabilityTier[] = ["none", "low", "medium", "high"];

/** Fallback unclassified-tier placeholder when config omits it (back-compat). */
export const DEFAULT_UNCLASSIFIED_TIER: DurabilityTier = "medium";

/** The LESS severe (lower-pressure) of two tiers. Tighten-only, mirrors `stricterOrientationLock` (orientation.ts). */
export function minTier(a: DurabilityTier, b: DurabilityTier): DurabilityTier {
  return TIERS.indexOf(a) <= TIERS.indexOf(b) ? a : b;
}

function parseTierPressures(json: unknown): DurabilityTiersConfig {
  if (typeof json !== "object" || json === null) {
    throw new DurabilityTierPressureError("file must be a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const tiersRaw = obj.tiers as Record<string, unknown> | undefined;
  if (!tiersRaw) throw new DurabilityTierPressureError('"tiers" is required');

  const tiers = {} as Record<DurabilityTier, number>;
  for (const tier of TIERS) {
    const v = tiersRaw[tier];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new DurabilityTierPressureError(`tiers.${tier} must be a non-negative number`);
    }
    tiers[tier] = v;
  }

  const deformableFactor = parseSofteningFactor(obj, "deformableFactor");
  const brittleFactor = parseSofteningFactor(obj, "brittleFactor");

  const unclassifiedTierRaw = obj.unclassifiedTier;
  const unclassifiedTier: DurabilityTier =
    unclassifiedTierRaw === undefined
      ? DEFAULT_UNCLASSIFIED_TIER
      : (() => {
          if (typeof unclassifiedTierRaw !== "string" || !TIERS.includes(unclassifiedTierRaw as DurabilityTier)) {
            throw new DurabilityTierPressureError(`"unclassifiedTier" must be one of: ${TIERS.join(", ")}`);
          }
          return unclassifiedTierRaw as DurabilityTier;
        })();

  return { tiers, deformableFactor, brittleFactor, unclassifiedTier };
}

/**
 * Optional (defaults to 1 = no softening). When present it must be a real
 * fraction in (0, 1] — 0 or negative would zero-out a limit silently, >1 would
 * LOOSEN a crush limit, both of which the tighten-only safety rule forbids.
 * Shared by deformableFactor and brittleFactor — same convention, same guardrail.
 */
function parseSofteningFactor(obj: Record<string, unknown>, key: "deformableFactor" | "brittleFactor"): number {
  const raw = obj[key];
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 1) {
    throw new DurabilityTierPressureError(`${key} must be a number in (0, 1]`);
  }
  return raw;
}

let cached: DurabilityTiersConfig | null = null;

export async function loadDurabilityTierPressures(): Promise<DurabilityTiersConfig> {
  if (cached) return cached;
  const path = resolve(process.cwd(), getConfig().durability.tiersPath);
  cached = await loadJsonFile(path, parseTierPressures, DurabilityTierPressureError);
  return cached;
}

/** Test hook — parse a tier-pressure config without touching disk or the cache. */
export function parseDurabilityTierPressuresFrom(json: unknown): DurabilityTiersConfig {
  return parseTierPressures(json);
}
