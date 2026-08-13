/**
 * Loads + validates the editable fragility ruleset from disk (path from config).
 * Keywords are lowercased once at load. Fails loud on a malformed file.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import type { Fragility } from "@/lib/classification/types";

export interface FragilityOverride {
  readonly phrase: string;
  readonly fragility: Fragility;
}

export interface FragilityRuleset {
  readonly version: number;
  readonly itemTableHeaderKeywords: string[];
  readonly minHeaderMatches: number;
  readonly textColumnKeywords: string[];
  readonly overrides: FragilityOverride[];
  readonly fragileKeywords: string[];
  readonly standardKeywords: string[];
  readonly defaultWhenUnmatched: Fragility;
}

export class RulesetError extends Error {
  constructor(message: string) {
    super(`[ruleset] ${message}`);
    this.name = "RulesetError";
  }
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new RulesetError(`"${key}" must be an array of strings`);
  }
  return value.map((v) => v.toLowerCase().trim()).filter(Boolean);
}

function parseRuleset(json: unknown): FragilityRuleset {
  if (typeof json !== "object" || json === null) {
    throw new RulesetError("ruleset must be a JSON object");
  }
  const obj = json as Record<string, unknown>;

  const fragileGroup = obj.fragile as Record<string, unknown> | undefined;
  const standardGroup = obj.standard as Record<string, unknown> | undefined;
  if (!fragileGroup || !standardGroup) {
    throw new RulesetError('ruleset needs "fragile" and "standard" groups');
  }

  const def = obj.defaultWhenUnmatched;
  if (def !== "fragile" && def !== "standard") {
    throw new RulesetError('"defaultWhenUnmatched" must be "fragile" or "standard"');
  }

  const overrides = parseOverrides(obj.overrides);

  const minHeaderMatches = typeof obj.minHeaderMatches === "number" ? obj.minHeaderMatches : 2;

  return {
    version: typeof obj.version === "number" ? obj.version : 0,
    itemTableHeaderKeywords: requireStringArray(obj, "itemTableHeaderKeywords"),
    minHeaderMatches,
    textColumnKeywords: requireStringArray(obj, "textColumnKeywords"),
    overrides,
    fragileKeywords: requireStringArray(fragileGroup, "keywords"),
    standardKeywords: requireStringArray(standardGroup, "keywords"),
    defaultWhenUnmatched: def,
  };
}

/** Overrides are optional; each must be { phrase: string, fragility: fragile|standard }. */
function parseOverrides(value: unknown): FragilityOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RulesetError('"overrides" must be an array');
  return value.map((entry, i) => {
    const o = entry as Record<string, unknown>;
    const phrase = typeof o.phrase === "string" ? o.phrase.toLowerCase().trim() : "";
    if (phrase === "") throw new RulesetError(`overrides[${i}].phrase must be a non-empty string`);
    if (o.fragility !== "fragile" && o.fragility !== "standard") {
      throw new RulesetError(`overrides[${i}].fragility must be "fragile" or "standard"`);
    }
    return { phrase, fragility: o.fragility };
  });
}

let cached: FragilityRuleset | null = null;

export async function loadRuleset(): Promise<FragilityRuleset> {
  if (cached) return cached;
  const path = resolve(process.cwd(), getConfig().classification.rulesPath);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new RulesetError(`cannot read ruleset file at ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new RulesetError(`ruleset file is not valid JSON: ${path}`);
  }
  cached = parseRuleset(json);
  return cached;
}

/** Test hook — parse a ruleset object without touching disk or the cache. */
export function parseRulesetFrom(json: unknown): FragilityRuleset {
  return parseRuleset(json);
}
