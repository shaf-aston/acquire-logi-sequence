/**
 * Loads + validates the editable durability ruleset from disk (config/durability-rules.json).
 * Keywords are lowercased once at load. Fails loud on a malformed file. Mirrors the
 * fragility ruleset loader pattern (ruleset.ts).
 */
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import { loadJsonFile } from "@/lib/packing/config-loader";
import type { DurabilityTier, OrientationLock } from "@/lib/classification/durability.types";

export interface DurabilityOverride {
  readonly phrase: string;
  readonly durabilityTier: DurabilityTier;
  readonly brittle: boolean;
  readonly deformable: boolean;
  readonly orientationLock: OrientationLock;
}

export interface DurabilityRuleset {
  readonly version: number;
  readonly overrides: DurabilityOverride[];
  readonly tiers: Readonly<Record<DurabilityTier, string[]>>;
  readonly hollowKeywords: string[];
  readonly brittleKeywords: string[];
  readonly deformableKeywords: string[];
  readonly orientationKeywords: { readonly fixed: string[]; readonly partial: string[] };
  readonly defaultTier: DurabilityTier;
}

export class DurabilityRulesetError extends Error {
  constructor(message: string) {
    super(`[durability-ruleset] ${message}`);
    this.name = "DurabilityRulesetError";
  }
}

const TIERS: readonly DurabilityTier[] = ["none", "low", "medium", "high"];

function isTier(v: unknown): v is DurabilityTier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

function isOrientationLock(v: unknown): v is OrientationLock {
  return v === "fixed" || v === "partial" || v === "none";
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new DurabilityRulesetError(`"${key}" must be an array of strings`);
  }
  return value.map((v) => v.toLowerCase().trim()).filter(Boolean);
}

function parseOverrides(value: unknown): DurabilityOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DurabilityRulesetError('"overrides" must be an array');
  return value.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new DurabilityRulesetError(`overrides[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    const phrase = typeof o.phrase === "string" ? o.phrase.toLowerCase().trim() : "";
    if (phrase === "") throw new DurabilityRulesetError(`overrides[${i}].phrase must be a non-empty string`);
    if (!isTier(o.durabilityTier)) throw new DurabilityRulesetError(`overrides[${i}].durabilityTier is invalid`);
    if (typeof o.brittle !== "boolean") throw new DurabilityRulesetError(`overrides[${i}].brittle must be a boolean`);
    if (typeof o.deformable !== "boolean") throw new DurabilityRulesetError(`overrides[${i}].deformable must be a boolean`);
    if (!isOrientationLock(o.orientationLock)) throw new DurabilityRulesetError(`overrides[${i}].orientationLock is invalid`);
    return {
      phrase,
      durabilityTier: o.durabilityTier,
      brittle: o.brittle,
      deformable: o.deformable,
      orientationLock: o.orientationLock,
    };
  });
}

function parseRuleset(json: unknown): DurabilityRuleset {
  if (typeof json !== "object" || json === null) {
    throw new DurabilityRulesetError("ruleset must be a JSON object");
  }
  const obj = json as Record<string, unknown>;

  const tiersRaw = obj.tiers as Record<string, unknown> | undefined;
  if (!tiersRaw) throw new DurabilityRulesetError('"tiers" is required');
  const tiers = {} as Record<DurabilityTier, string[]>;
  for (const tier of TIERS) {
    const group = tiersRaw[tier] as Record<string, unknown> | undefined;
    if (!group) throw new DurabilityRulesetError(`"tiers.${tier}" is required`);
    tiers[tier] = requireStringArray(group, "keywords");
  }

  const orientationRaw = obj.orientationKeywords as Record<string, unknown> | undefined;
  if (!orientationRaw) throw new DurabilityRulesetError('"orientationKeywords" is required');

  if (!isTier(obj.defaultTier)) throw new DurabilityRulesetError('"defaultTier" must be a valid tier');

  return {
    version: typeof obj.version === "number" ? obj.version : 0,
    overrides: parseOverrides(obj.overrides),
    tiers,
    hollowKeywords: requireStringArray(obj, "hollowKeywords"),
    brittleKeywords: requireStringArray(obj, "brittleKeywords"),
    deformableKeywords: requireStringArray(obj, "deformableKeywords"),
    orientationKeywords: {
      fixed: requireStringArray(orientationRaw, "fixed"),
      partial: requireStringArray(orientationRaw, "partial"),
    },
    defaultTier: obj.defaultTier,
  };
}

let cached: DurabilityRuleset | null = null;

export async function loadDurabilityRuleset(): Promise<DurabilityRuleset> {
  if (cached) return cached;
  const path = resolve(process.cwd(), getConfig().durability.rulesPath);
  cached = await loadJsonFile(path, parseRuleset, DurabilityRulesetError);
  return cached;
}

/** Test hook — parse a ruleset object without touching disk or the cache. */
export function parseDurabilityRulesetFrom(json: unknown): DurabilityRuleset {
  return parseRuleset(json);
}
