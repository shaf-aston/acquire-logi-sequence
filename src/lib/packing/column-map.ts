/**
 * Loads + validates the line-item column map (column indices + category code
 * patterns) from disk. Mirrors the ruleset loader pattern (load + parse-from
 * hook); fails loud on a malformed file.
 */
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import { loadJsonFile } from "@/lib/packing/config-loader";
import type { PackingCategory } from "@/lib/packing/packing.types";

/** Recognised source length units. */
export type LengthUnit = "m" | "cm" | "mm" | "in";

/** Multiplier to convert one unit to metres. */
export const TO_METRES: Record<LengthUnit, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  in: 0.0254,
};

export function toMetres(value: number, unit: LengthUnit): number {
  return value * TO_METRES[unit];
}

/**
 * Detect a length unit from a column header string.
 * Checked in specificity order (mm/cm before bare m) to avoid false matches.
 * Returns null when no recognised marker is found.
 */
const UNIT_HEADER_PATTERNS: ReadonlyArray<[LengthUnit, RegExp]> = [
  ["mm", /\bmm\b|\bmillimet(?:re|er)s?\b/i],
  ["cm", /\bcm\b|\bcentimet(?:re|er)s?\b/i],
  ["in", /\binch(?:es)?\b/i],
  ["m",  /\bmet(?:re|er)s?\b|\(m\)/i],
];

export function detectUnitFromHeader(header: string): LengthUnit | null {
  for (const [unit, rx] of UNIT_HEADER_PATTERNS) {
    if (rx.test(header)) return unit;
  }
  return null;
}

/**
 * Detect an explicit unit suffix embedded in a numeric cell VALUE itself (e.g.
 * "120cm", "1.2 m") rather than inferred from the column header. This reads an
 * explicit marker the source stated for that one value — not a guess — so when
 * present it takes priority over the column-level unit for that cell. Checked
 * mm/cm/in before bare "m" (longest/most-specific suffix first) so "120mm" isn't
 * misread as "120m" + a stray "m". Returns null when the cell carries no such
 * suffix, in which case the caller falls back to the column/header unit unchanged.
 */
const CELL_UNIT_SUFFIX_PATTERNS: ReadonlyArray<[LengthUnit, RegExp]> = [
  ["mm", /mm\.?$/i],
  ["cm", /cm\.?$/i],
  ["in", /(?:inch(?:es)?|in)\.?$/i],
  ["m", /m\.?$/i],
];

export function detectUnitFromCell(raw: string): { unit: LengthUnit; numeric: string } | null {
  const trimmed = raw.trim();
  for (const [unit, rx] of CELL_UNIT_SUFFIX_PATTERNS) {
    const m = trimmed.match(rx);
    if (m && m.index !== undefined && m.index > 0) {
      return { unit, numeric: trimmed.slice(0, m.index).trim() };
    }
  }
  return null;
}

export interface ColumnIndices {
  readonly code: number;
  /** Optional quantity column; absent ⇒ one unit per row. */
  readonly quantity?: number;
  readonly description: number;
  /** Length → van x-axis. */
  readonly dimensionL: number;
  /** Height → van z-axis. */
  readonly dimensionH: number;
  /** Depth → van y-axis. Absent ⇒ derived from mass ÷ (density × face area). */
  readonly dimensionP?: number;
  /**
   * Optional SINGLE column that packs all three extents into one cell
   * (e.g. "120 x 100 x 110 (H)" or "120 x 100 x 110"), common on groupage
   * quotations that print one "L x W x D (cm)" / "Pallet Size (cm)" column
   * instead of separate Height/Width/Depth columns. When present and its cell
   * splits into ≥3 numbers, it supplies l/w/h directly and takes priority over
   * the separate dimensionL/H/P columns (see item-assembler.ts). Header-detected
   * only (no fixed-index fallback) — absent on per-column sheets.
   */
  readonly dimensionCombined?: number;
  /** Optional per-item weight column; absent ⇒ weight is estimated. */
  readonly weight?: number;
  /** Optional material column; absent ⇒ durability/brittle fall back to category defaults. */
  readonly material?: number;
  /**
   * Optional pallet-count column. When present and ≥1 for a row, that row is a
   * PALLET line: the load unit is the pallet (quantity = pallet count), not the
   * descriptive piece/unit count — see item-assembler.ts. Absent ⇒ ordinary
   * per-piece packing.
   */
  readonly pallets?: number;
  /**
   * Optional stop/drop column. On a multi-drop groupage manifest each cargo row
   * names the delivery stop it belongs to (1, 2, 3…); this column carries that
   * value so cargo can be attributed to its drop (see stop-attributor.ts).
   * Header-detected only (no fixed-index fallback) — absent on single-drop sheets.
   */
  readonly stop?: number;
}

/**
 * Standard pallet geometry used when a row is quoted at the pallet level.
 * `footprintM` is the pallet's floor footprint (metres); `loadHeightM` is the
 * assumed loaded height when the sheet gives no per-pallet Height (metres).
 * `defaultWeightKg` is the fallback loaded-pallet weight used only when a pallet
 * line carries no usable Weight cell — a sane average pallet weight, NOT
 * volume × solid-material density (which fabricates multi-tonne pallets heavier
 * than any van payload).
 *
 * `plausibleMinKg`/`plausibleMaxKg` bound the per-pallet weight this reader DERIVES
 * from a document's own stated total ("Total: 266 pallets | 35,910 kg" -> 135
 * kg/pallet — see item-assembler.ts's statedTotalsFor / stated-pallet-totals.ts). A
 * derived figure outside this band is a likely misread and is discarded in favour of
 * `defaultWeightKg`, never priced. This is NOT the same knob as groupage-rates.json's
 * `maxPlausibleDerivedPalletKg` — see the note beside it in config/column-map.json for
 * why the two guard different derivations with different failure modes and must not
 * be merged.
 */
export interface PalletDefaults {
  readonly footprintM: { readonly l: number; readonly w: number };
  readonly loadHeightM: number;
  readonly defaultWeightKg: number;
  readonly plausibleMinKg: number;
  readonly plausibleMaxKg: number;
}

/** Fallback pallet geometry (UK standard 1.2 × 1.0 m) when config omits it. */
export const DEFAULT_PALLET_DEFAULTS: PalletDefaults = {
  footprintM: { l: 1.2, w: 1.0 },
  loadHeightM: 1.2,
  defaultWeightKg: 400,
  plausibleMinKg: 1,
  plausibleMaxKg: 1500,
};

export interface CategoryPattern {
  readonly category: PackingCategory;
  readonly regex: RegExp;
}

export interface ColumnMap {
  readonly version: number;
  /**
   * Declared source unit for dimension columns — used as fallback when no unit
   * marker is found in column headers. The assembler detects from headers first
   * so the same column map works across sources that print "cm" in the header.
   */
  readonly inputUnit: LengthUnit;
  /**
   * Decimal convention of the numeric cells. "," = Italian/European (dot is the
   * thousands separator, comma the decimal point — e.g. "1.234,56" → 1234.56);
   * "." = English/US (comma thousands, dot decimal — e.g. "1,234.56" → 1234.56).
   * Declared per source because the two are genuinely ambiguous (Italian "1.200"
   * means 1200, English "1.200" means 1.2) — guessing corrupts dimensions.
   * Defaults to "," for back-compat with the original Italian importer.
   */
  readonly decimalSeparator: "." | ",";
  readonly columns: ColumnIndices;
  /**
   * Optional per-field header regexes. When present for a field, the column is
   * located by matching the table's header row (first match wins) instead of a
   * fixed index — so one config handles tables whose columns sit in different
   * positions (e.g. a 6-column cm sheet vs an 11-column metres sheet). `columns`
   * stays as the fallback for required fields when no header matches, and for
   * tables with no usable header text.
   */
  readonly headerPatterns: HeaderPatterns;
  /** How to prove the unit of an unmarked size column, instead of assuming `inputUnit`. */
  readonly unitInference: UnitInference;
  /**
   * How close the sum of a table's weights must be to the total the SHEET states for itself before
   * that counts as a match — the check that decides whether the weight column is per-unit or a line
   * total (see weight-semantics.ts). 0.02 = within 2%.
   */
  readonly weightTotalTolerance: number;
  /**
   * Matches the description/code cell of a row that STATES A TOTAL rather than carrying cargo
   * ("Sub-total Stop 1", "GRAND TOTAL", "S1"). Such a row has a weight but no size, so left alone it
   * is quoted as a phantom unplaceable item AND doubles the job's weight. It is also the sheet's own
   * arithmetic, which is what proves whether the weight column is per-unit or a line total.
   */
  readonly totalsRowPattern: RegExp;
  /** How big a table whose header was lost must be before we report it as lost cargo. */
  readonly lostTableFloor: LostTableFloor;
  readonly defaultCategory: PackingCategory;
  readonly categoryPatterns: CategoryPattern[];
  /** Standard pallet geometry for pallet-level quoting (see PalletDefaults). */
  readonly palletDefaults: PalletDefaults;
  /**
   * Floor for a depth DERIVED from mass ÷ (density × face area), metres — avoids
   * fabricating a zero-thickness box when a source table carries only two
   * dimensions plus a weight. NOT pallet-specific (applies to any item with a
   * derived depth), hence top-level rather than under `palletDefaults`.
   */
  readonly minDerivedDepthM: number;
}

/**
 * When a scan loses a table's header row we cannot read its columns, so its rows are not packed —
 * and the operator MUST be told, or cargo disappears in silence. But the parser calls any block of
 * pipe-prefixed lines a headerless table, and that includes ordinary prose and letterheads
 * ("| Total: 266 pallets | 35,910 kg |"). Reporting those as lost cargo buries the real ones.
 *
 * So a lost table is only reported once it is big enough to plausibly BE a cargo table. This is a
 * blunt filter and it is meant to be: it will still miss a wide block of prose, and will still flag
 * a genuinely tiny cargo table. Raise the floor if warnings are noisy; LOWER it if a real table ever
 * slips through unreported — under-reporting lost cargo is far the worse failure of the two.
 */
export interface LostTableFloor {
  readonly minRows: number;
  readonly minColumns: number;
}

export const DEFAULT_LOST_TABLE_FLOOR: LostTableFloor = { minRows: 2, minColumns: 3 };

export type HeaderPatterns = Readonly<Partial<Record<keyof ColumnIndices, RegExp>>>;

/**
 * How to PROVE the length unit of a size column that states none. Reading a bare "H | W | D" as the
 * configured `inputUnit` is a guess, and an unmarked centimetre sheet read as metres is a silent 100×
 * error. Freight has physical limits, so the numbers themselves settle it: only one unit puts a
 * sheet's dimensions inside a plausible range. See the note in config/column-map.json.
 */
export interface UnitInference {
  /** Units to try, in preference order. Ties go to the earlier entry. */
  readonly candidates: readonly LengthUnit[];
  /** A real freight dimension, in metres, lies between these. */
  readonly plausibleMinM: number;
  readonly plausibleMaxM: number;
  /** Fraction of a table's dimension values that must land in range before a unit counts as proven. */
  readonly minConfidence: number;
  /** Fewer readable dimensions than this ⇒ too little evidence to prove anything; don't try. */
  readonly minSamples: number;
}

export const DEFAULT_UNIT_INFERENCE: UnitInference = {
  candidates: ["m", "cm", "mm"],
  plausibleMinM: 0.05,
  plausibleMaxM: 4.0,
  minConfidence: 0.8,
  minSamples: 3,
};

/**
 * Resolve the effective column indices for one table by matching its header row
 * against `headerPatterns`. A field with a pattern uses the first header it
 * matches; required fields fall back to the fixed `columns` index when nothing
 * matches, optional fields (depth/weight/quantity) become absent. Fields without
 * a pattern always use the fixed index.
 */
export function resolveColumnIndices(headers: string[], map: ColumnMap): ColumnIndices {
  const hp = map.headerPatterns;
  const c = map.columns;
  const byHeader = (rx: RegExp | undefined): number | undefined => {
    if (!rx) return undefined;
    const i = headers.findIndex((h) => rx.test(h));
    return i >= 0 ? i : undefined;
  };
  const required = (field: keyof ColumnIndices, fallback: number): number =>
    hp[field] ? (byHeader(hp[field]) ?? fallback) : fallback;
  const optional = (field: keyof ColumnIndices, fallback: number | undefined): number | undefined =>
    hp[field] ? byHeader(hp[field]) : fallback;

  const dimensionCombined = optional("dimensionCombined", c.dimensionCombined);
  // A "Pallet Size (cm)" header matches BOTH the `pallet` and `pallet\s*size` patterns in
  // config/column-map.json. That column states one pallet's SIZE ("120 x 100 x 110"), not how
  // many pallets there are — read as a count it feeds a size cell to parseNumeric, which
  // returns 120 (Number.parseFloat stops at the first non-numeric character) and fabricates
  // "120 pallets × 400 kg default = 48,000 kg" on a sheet that says nothing of the sort.
  //
  // So the pallet-COUNT column is searched with the size column EXCLUDED, rather than simply
  // rejected when the two collide. Rejecting on collision looks equivalent and is not: a plain
  // `findIndex` returns the FIRST /pallet/ header, so on a sheet that prints "Pallet Size (cm)"
  // BEFORE its "Pallets" column the collision test would fire on the size column and discard a
  // real, present count column — and a pallet manifest read without its pallet count explodes
  // into per-piece cargo, which is the 18,000-block failure this codebase already fixed once.
  // Excluding the index is correct in both column orders; equality-testing it is correct in one.
  const palletsRx = hp.pallets;
  const pallets =
    palletsRx === undefined
      ? c.pallets
      : (() => {
          const i = headers.findIndex((h, idx) => idx !== dimensionCombined && palletsRx.test(h));
          return i >= 0 ? i : undefined;
        })();

  return {
    code: required("code", c.code),
    description: required("description", c.description),
    dimensionL: required("dimensionL", c.dimensionL),
    dimensionH: required("dimensionH", c.dimensionH),
    dimensionP: optional("dimensionP", c.dimensionP),
    dimensionCombined,
    weight: optional("weight", c.weight),
    quantity: optional("quantity", c.quantity),
    material: optional("material", c.material),
    pallets,
    stop: optional("stop", c.stop),
  };
}

const VALID_CATEGORIES: readonly PackingCategory[] = [
  "heavy-material",
  "glass-panel",
  "light-industrial",
  "appliance",
  "top",
  "base-cabinet",
  "wall-cabinet",
  "tall-unit",
  "accessory",
];

export class ColumnMapError extends Error {
  constructor(message: string) {
    super(`[column-map] ${message}`);
    this.name = "ColumnMapError";
  }
}

function isCategory(v: unknown): v is PackingCategory {
  return typeof v === "string" && (VALID_CATEGORIES as readonly string[]).includes(v);
}

function parseColumns(value: unknown): ColumnIndices {
  if (typeof value !== "object" || value === null) {
    throw new ColumnMapError('"columns" must be an object');
  }
  const o = value as Record<string, unknown>;
  const idx = (key: string, optional = false): number | undefined => {
    const v = o[key];
    if (v === undefined && optional) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      throw new ColumnMapError(`columns.${key} must be a non-negative integer`);
    }
    return v;
  };
  return {
    code: idx("code")!,
    quantity: idx("quantity", true),
    description: idx("description")!,
    dimensionL: idx("dimensionL")!,
    dimensionH: idx("dimensionH")!,
    dimensionP: idx("dimensionP", true),
    dimensionCombined: idx("dimensionCombined", true),
    weight: idx("weight", true),
    material: idx("material", true),
    pallets: idx("pallets", true),
    stop: idx("stop", true),
  };
}

function parsePatterns(value: unknown): CategoryPattern[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ColumnMapError('"categoryPatterns" must be an array');
  return value.map((entry, i) => {
    const o = entry as Record<string, unknown>;
    if (!isCategory(o.category)) {
      throw new ColumnMapError(`categoryPatterns[${i}].category is not a known category`);
    }
    if (typeof o.pattern !== "string" || o.pattern === "") {
      throw new ColumnMapError(`categoryPatterns[${i}].pattern must be a non-empty string`);
    }
    let regex: RegExp;
    try {
      regex = new RegExp(o.pattern, "i");
    } catch {
      throw new ColumnMapError(`categoryPatterns[${i}].pattern is not a valid regex`);
    }
    return { category: o.category, regex };
  });
}

const VALID_UNITS: ReadonlyArray<LengthUnit> = ["m", "cm", "mm", "in"];

function isLengthUnit(v: unknown): v is LengthUnit {
  return typeof v === "string" && (VALID_UNITS as readonly string[]).includes(v);
}

function parseColumnMap(json: unknown): ColumnMap {
  if (typeof json !== "object" || json === null) {
    throw new ColumnMapError("column map must be a JSON object");
  }
  const obj = json as Record<string, unknown>;
  if (!isCategory(obj.defaultCategory)) {
    throw new ColumnMapError('"defaultCategory" is not a known category');
  }
  if (!isLengthUnit(obj.inputUnit)) {
    throw new ColumnMapError('"inputUnit" must be one of: m, cm, mm, in');
  }
  if (obj.decimalSeparator !== undefined && obj.decimalSeparator !== "." && obj.decimalSeparator !== ",") {
    throw new ColumnMapError('"decimalSeparator" must be "." or ","');
  }
  return {
    version: typeof obj.version === "number" ? obj.version : 0,
    inputUnit: obj.inputUnit,
    decimalSeparator: (obj.decimalSeparator as "." | "," | undefined) ?? ",",
    columns: parseColumns(obj.columns),
    headerPatterns: parseHeaderPatterns(obj.headerPatterns),
    unitInference: parseUnitInference(obj.unitInference),
    weightTotalTolerance: parseWeightTotalTolerance(obj.weightTotalTolerance),
    totalsRowPattern: parseTotalsRowPattern(obj.totalsRowPattern),
    lostTableFloor: parseLostTableFloor(obj.lostTableFloor),
    defaultCategory: obj.defaultCategory,
    categoryPatterns: parsePatterns(obj.categoryPatterns),
    palletDefaults: parsePalletDefaults(obj.palletDefaults),
    minDerivedDepthM: parseMinDerivedDepthM(obj.minDerivedDepthM),
  };
}

/** Fallback depth floor (metres) for a derived depth, when config omits it. 0.02 m = 20 mm. */
export const DEFAULT_MIN_DERIVED_DEPTH_M = 0.02;

function parseMinDerivedDepthM(value: unknown): number {
  if (value === undefined) return DEFAULT_MIN_DERIVED_DEPTH_M;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ColumnMapError('"minDerivedDepthM" must be a positive number');
  }
  return value;
}

function parseLostTableFloor(value: unknown): LostTableFloor {
  if (value === undefined) return DEFAULT_LOST_TABLE_FLOOR;
  if (typeof value !== "object" || value === null) {
    throw new ColumnMapError('"lostTableFloor" must be an object');
  }
  const obj = value as Record<string, unknown>;
  const whole = (key: "minRows" | "minColumns"): number => {
    const n = obj[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new ColumnMapError(`lostTableFloor.${key} must be a whole number of at least 1`);
    }
    return n;
  };
  return { minRows: whole("minRows"), minColumns: whole("minColumns") };
}

/** Default match tolerance when reconciling a table's weights against the sheet's own stated total. */
const DEFAULT_WEIGHT_TOTAL_TOLERANCE = 0.02;

/** Totals-row labels seen across the example manifests. Overridable in config. */
const DEFAULT_TOTALS_ROW_PATTERN = /\btotals?\b|\bsub-?total\b|\bgrand\b|^\s*s\d+\s*$/i;

function parseTotalsRowPattern(value: unknown): RegExp {
  if (value === undefined) return DEFAULT_TOTALS_ROW_PATTERN;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ColumnMapError('"totalsRowPattern" must be a non-empty regex string');
  }
  try {
    return new RegExp(value, "i");
  } catch {
    throw new ColumnMapError(`"totalsRowPattern" is not a valid regular expression: ${value}`);
  }
}

function parseWeightTotalTolerance(value: unknown): number {
  if (value === undefined) return DEFAULT_WEIGHT_TOTAL_TOLERANCE;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ColumnMapError('"weightTotalTolerance" must be a number between 0 and 1');
  }
  return value;
}

/**
 * Parse the unit-inference settings. Absent ⇒ the built-in default (older column-map files stay
 * valid). Present ⇒ validated strictly: a zero/negative/inverted plausible range, or a confidence
 * outside 0–1, would quietly disable the inference and let the 100× misread back in, so it is
 * rejected loudly instead (trust-boundary rule — fail loud, never silently fall back).
 */
function parseUnitInference(value: unknown): UnitInference {
  if (value === undefined) return DEFAULT_UNIT_INFERENCE;
  if (typeof value !== "object" || value === null) {
    throw new ColumnMapError('"unitInference" must be an object');
  }
  const o = value as Record<string, unknown>;

  const candidates = o.candidates ?? DEFAULT_UNIT_INFERENCE.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0 || !candidates.every(isLengthUnit)) {
    throw new ColumnMapError('"unitInference.candidates" must be a non-empty array of: m, cm, mm, in');
  }

  const posNum = (v: unknown, key: string, fallback: number): number => {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new ColumnMapError(`unitInference.${key} must be a positive number`);
    }
    return v;
  };
  const plausibleMinM = posNum(o.plausibleMinM, "plausibleMinM", DEFAULT_UNIT_INFERENCE.plausibleMinM);
  const plausibleMaxM = posNum(o.plausibleMaxM, "plausibleMaxM", DEFAULT_UNIT_INFERENCE.plausibleMaxM);
  if (plausibleMinM >= plausibleMaxM) {
    throw new ColumnMapError("unitInference.plausibleMinM must be less than plausibleMaxM");
  }

  const minConfidence = posNum(o.minConfidence, "minConfidence", DEFAULT_UNIT_INFERENCE.minConfidence);
  if (minConfidence > 1) throw new ColumnMapError("unitInference.minConfidence must be between 0 and 1");

  return {
    candidates: candidates as LengthUnit[],
    plausibleMinM,
    plausibleMaxM,
    minConfidence,
    minSamples: posNum(o.minSamples, "minSamples", DEFAULT_UNIT_INFERENCE.minSamples),
  };
}

/**
 * Parse the standard pallet geometry. Absent ⇒ built-in UK-pallet default (keeps
 * older column-map files valid). Present ⇒ every dimension must be a positive
 * finite number — a zero/negative pallet footprint is rejected loudly rather than
 * silently pricing a zero-volume pallet (trust-boundary rule).
 */
function parsePalletDefaults(value: unknown): PalletDefaults {
  if (value === undefined) return DEFAULT_PALLET_DEFAULTS;
  if (typeof value !== "object" || value === null) {
    throw new ColumnMapError('"palletDefaults" must be an object');
  }
  const o = value as Record<string, unknown>;
  const pos = (v: unknown, key: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new ColumnMapError(`palletDefaults.${key} must be a positive number`);
    }
    return v;
  };
  const fp = o.footprintM;
  if (typeof fp !== "object" || fp === null) {
    throw new ColumnMapError('"palletDefaults.footprintM" must be an object');
  }
  const f = fp as Record<string, unknown>;

  // Optional (older configs / inline test fixtures omit them) — default to the plausibility band
  // that shipped before this was config-driven (1..1500 kg). Present ⇒ validated strictly, same
  // trust-boundary rule as everything else in this loader.
  const plausibleMinKg =
    o.plausibleMinKg === undefined
      ? DEFAULT_PALLET_DEFAULTS.plausibleMinKg
      : pos(o.plausibleMinKg, "plausibleMinKg");
  const plausibleMaxKg =
    o.plausibleMaxKg === undefined
      ? DEFAULT_PALLET_DEFAULTS.plausibleMaxKg
      : pos(o.plausibleMaxKg, "plausibleMaxKg");
  if (plausibleMinKg >= plausibleMaxKg) {
    throw new ColumnMapError("palletDefaults.plausibleMinKg must be less than plausibleMaxKg");
  }

  return {
    footprintM: { l: pos(f.l, "footprintM.l"), w: pos(f.w, "footprintM.w") },
    loadHeightM: pos(o.loadHeightM, "loadHeightM"),
    defaultWeightKg: pos(o.defaultWeightKg, "defaultWeightKg"),
    plausibleMinKg,
    plausibleMaxKg,
  };
}

const HEADER_PATTERN_FIELDS: ReadonlyArray<keyof ColumnIndices> = [
  "code", "description", "dimensionL", "dimensionH", "dimensionP", "dimensionCombined", "weight", "quantity", "material", "pallets", "stop",
];

function parseHeaderPatterns(value: unknown): HeaderPatterns {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) {
    throw new ColumnMapError('"headerPatterns" must be an object');
  }
  const o = value as Record<string, unknown>;
  const out: Record<string, RegExp> = {};
  for (const field of HEADER_PATTERN_FIELDS) {
    const pat = o[field];
    if (pat === undefined) continue;
    if (typeof pat !== "string" || pat === "") {
      throw new ColumnMapError(`headerPatterns.${field} must be a non-empty string`);
    }
    try {
      out[field] = new RegExp(pat, "i");
    } catch {
      throw new ColumnMapError(`headerPatterns.${field} is not a valid regex`);
    }
  }
  return out;
}

/** First pattern whose regex matches the product code wins; else the default. */
export function categoryForCode(map: ColumnMap, code: string): PackingCategory {
  for (const p of map.categoryPatterns) {
    if (p.regex.test(code)) return p.category;
  }
  return map.defaultCategory;
}

let cached: ColumnMap | null = null;

export async function loadColumnMap(): Promise<ColumnMap> {
  if (cached) return cached;
  const path = resolve(process.cwd(), getConfig().packing.columnMapPath);
  cached = await loadJsonFile(path, parseColumnMap, ColumnMapError);
  return cached;
}

/** Test hook — parse a column map object without touching disk or the cache. */
export function parseColumnMapFrom(json: unknown): ColumnMap {
  return parseColumnMap(json);
}
