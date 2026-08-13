/**
 * Loader + validator for `config/groupage-rates.json` — the pricing/footprint/capacity knobs.
 *
 * Mirrors `van.repository`'s parse discipline: read once, validate every field at the trust
 * boundary, fail loud on anything malformed, then cache. Nothing downstream reads the raw file.
 */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import {
  PALLET_FOOTPRINT_CLASSES,
  type DualCapacity,
  type GroupageLegKind,
  type PalletFootprintClass,
} from "./groupage.types";
import { DEFAULT_MAX_PLAUSIBLE_DERIVED_PALLET_KG } from "./collection-run-parser";

export class GroupageRatesError extends Error {
  constructor(message: string) {
    super(`[groupage-rates] ${message}`);
    this.name = "GroupageRatesError";
  }
}

/** The validated rate-card + physical knobs a groupage quote runs on. */
export interface GroupageRates {
  readonly footprintUnits: Readonly<Record<PalletFootprintClass, number>>;
  readonly legCapacity: Readonly<Record<GroupageLegKind, DualCapacity>>;
  /**
   * Optional per-leg `config/vans.json` vehicle id — the physical vehicle serving that leg,
   * used ONLY to draw the 3D shared-truck load plan (interior geometry). Never touches pricing
   * or the scalar capacity check. Absent ⇒ that leg has no 3D truck geometry configured.
   */
  readonly legVehicle: Readonly<Record<GroupageLegKind, string | undefined>>;
  readonly ratePerFootprint: {
    /** Fallback per-footprint rate when no zone-specific rate is set. */
    readonly default: number;
    /** Zone overrides keyed "originHubId>destHubId" → per-footprint rate. */
    readonly zones: Readonly<Record<string, number>>;
  };
  readonly firstMileSurcharge: number;
  readonly lastMileSurcharge: number;
  /** Flat fee per intermediate trunk stop — a per-EVENT cost (dock time, cross-dock handling,
   *  driver deviation), never a per-pallet-mile one, so it is charged on the route and not folded
   *  into the per-footprint rate. Absent ⇒ 0: calling at stops costs nothing until set. */
  readonly perTrunkStopFee: number;
  readonly heavyPallet: {
    /** kg-per-footprint-unit above which a pallet is "weight-out" and draws the surcharge. */
    readonly thresholdKgPerFootprint: number;
    readonly surchargePerPallet: number;
  };
  /** Reference ceiling on a single pallet line's weight — a value under this can still be
   *  "weight-out" (heavyPallet) and priced accordingly. See `enforcePerPalletCeiling` for whether
   *  a value ABOVE it is rejected or simply trusted-and-priced. */
  readonly maxPalletWeightKg: number;
  /** When true, a pallet line over `maxPalletWeightKg` is rejected loudly (a fat-finger guard on the
   *  manual form). When false (default), the quotation is TRUSTED: the heavy load is priced (with the
   *  heavyPallet surcharge) and any real overflow is surfaced by the per-leg capacity check, never a
   *  hard block. Flexible by config so a business can tighten or loosen it without a code change. */
  readonly enforcePerPalletCeiling: boolean;
  /** When true, a booking that outgrows ONE vehicle on any leg is rejected loudly (the fat-finger
   *  guard). When false (default), the quotation is TRUSTED: the load is quoted, priced across the
   *  vehicles it really needs, and the overflowing leg is FLAGGED on the quote (`fits`,
   *  `vehiclesNeeded`, `oversizeLines`). A legitimate high-volume booking is never blocked. */
  readonly enforceLegCapacity: boolean;
  /** How a line-haul's billable pallet-spaces are derived from the load.
   *  • `"footprints"`      — Σ footprint units. A weight-out load (few pallets, huge tonnage) then
   *                          buys three trucks and pays for one: a straight under-charge.
   *  • `"weight-adjusted"` — additionally charges the SPACE-EQUIVALENT of the weight consumed,
   *                          `Σ kg ÷ (trunk payload ÷ trunk spaces)`, and bills the greater of the
   *                          two. Identical to `"footprints"` for any load that is not weight-out. */
  readonly chargeableSpaceBasis: ChargeableSpaceBasis;
  /** Sanity ceiling (kg) for a per-pallet weight CALCULATED from a GROUPAGE cargo summary
   *  (`total ÷ pallet count`, in collection-run-parser.ts). A derived weight above this is KEPT but
   *  FLAGGED for the operator to confirm (never silently trusted, never blocked) — a "never guess"
   *  surface. Tunable here so it is not a magic number in source.
   *
   *  NOT the same knob as `config/column-map.json`'s `palletDefaults.plausibleMinKg`/`plausibleMaxKg`
   *  (item-assembler.ts's statedTotalsFor). That one guards a DIFFERENT derivation — a per-pallet
   *  weight worked out from a single manifest's own PROSE total ("Total: 266 pallets | 35,910 kg") —
   *  and on an out-of-band figure it DISCARDS the derived value entirely and falls back to a config
   *  default, rather than keeping it flagged. Same shape of guard, different source data and
   *  different failure mode; do not unify them into one value. */
  readonly maxPlausibleDerivedPalletKg: number;
}

const LEG_KINDS: readonly GroupageLegKind[] = ["collect", "trunk", "deliver"];

/** Basis for a line-haul's billable pallet-spaces. See `GroupageRates.chargeableSpaceBasis`. */
export type ChargeableSpaceBasis = "footprints" | "weight-adjusted";

const CHARGEABLE_SPACE_BASES: readonly ChargeableSpaceBasis[] = ["footprints", "weight-adjusted"];

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GroupageRatesError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positive(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new GroupageRatesError(`${where}.${key} must be a positive number`);
  }
  return v;
}

function nonNegative(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new GroupageRatesError(`${where}.${key} must be a non-negative number`);
  }
  return v;
}

/** Optional boolean knob — a real boolean or absent (defaults applied by the caller). Additive/
 *  back-compatible: a rates file written before this knob existed simply omits it. */
function optionalBool(o: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") {
    throw new GroupageRatesError(`groupage-rates.${key} must be a boolean when present`);
  }
  return v;
}

/** Optional enum knob. Absent ⇒ `"weight-adjusted"`: charging a weight-out load for the truck it
 *  actually fills is the correct default; `"footprints"` is the explicit opt-out. */
function parseChargeableSpaceBasis(value: unknown): ChargeableSpaceBasis {
  if (value === undefined) return "weight-adjusted";
  if (typeof value !== "string" || !CHARGEABLE_SPACE_BASES.includes(value as ChargeableSpaceBasis)) {
    throw new GroupageRatesError(
      `chargeableSpaceBasis must be one of ${CHARGEABLE_SPACE_BASES.map((b) => `"${b}"`).join(" | ")} when present`,
    );
  }
  return value as ChargeableSpaceBasis;
}

function parseCapacity(value: unknown, where: string): DualCapacity {
  const o = asObject(value, where);
  return {
    palletSpaces: positive(o, "palletSpaces", where),
    maxPayloadKg: positive(o, "maxPayloadKg", where),
  };
}

/** Optional `vehicleId` on a leg-capacity entry — a non-empty string or absent. Additive/back-compatible. */
function optionalVehicleId(value: unknown, where: string): string | undefined {
  const o = asObject(value, where);
  const v = o.vehicleId;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.trim() === "") {
    throw new GroupageRatesError(`${where}.vehicleId must be a non-empty string when present`);
  }
  return v;
}

export function parseGroupageRates(json: unknown): GroupageRates {
  const root = asObject(json, "groupage-rates");

  const fpRaw = asObject(root.footprintUnits, "footprintUnits");
  const footprintUnits = {} as Record<PalletFootprintClass, number>;
  for (const cls of PALLET_FOOTPRINT_CLASSES) {
    footprintUnits[cls] = positive(fpRaw, cls, "footprintUnits");
  }

  const capRaw = asObject(root.legCapacity, "legCapacity");
  const legCapacity = {} as Record<GroupageLegKind, DualCapacity>;
  const legVehicle = {} as Record<GroupageLegKind, string | undefined>;
  for (const kind of LEG_KINDS) {
    const where = `legCapacity.${kind}`;
    legCapacity[kind] = parseCapacity(capRaw[kind], where);
    legVehicle[kind] = optionalVehicleId(capRaw[kind], where);
  }

  const rpfRaw = asObject(root.ratePerFootprint, "ratePerFootprint");
  const zonesRaw = asObject(rpfRaw.zones ?? {}, "ratePerFootprint.zones");
  const zones: Record<string, number> = {};
  for (const [key, v] of Object.entries(zonesRaw)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new GroupageRatesError(`ratePerFootprint.zones["${key}"] must be a positive number`);
    }
    zones[key] = v;
  }

  const heavyRaw = asObject(root.heavyPallet, "heavyPallet");

  return {
    footprintUnits,
    legCapacity,
    legVehicle,
    ratePerFootprint: {
      default: positive(rpfRaw, "default", "ratePerFootprint"),
      zones,
    },
    firstMileSurcharge: nonNegative(root, "firstMileSurcharge", "groupage-rates"),
    lastMileSurcharge: nonNegative(root, "lastMileSurcharge", "groupage-rates"),
    perTrunkStopFee:
      root.perTrunkStopFee === undefined ? 0 : nonNegative(root, "perTrunkStopFee", "groupage-rates"),
    heavyPallet: {
      thresholdKgPerFootprint: positive(heavyRaw, "thresholdKgPerFootprint", "heavyPallet"),
      surchargePerPallet: nonNegative(heavyRaw, "surchargePerPallet", "heavyPallet"),
    },
    maxPalletWeightKg: positive(root, "maxPalletWeightKg", "groupage-rates"),
    enforcePerPalletCeiling: optionalBool(root, "enforcePerPalletCeiling", false),
    enforceLegCapacity: optionalBool(root, "enforceLegCapacity", false),
    chargeableSpaceBasis: parseChargeableSpaceBasis(root.chargeableSpaceBasis),
    maxPlausibleDerivedPalletKg:
      root.maxPlausibleDerivedPalletKg === undefined
        ? DEFAULT_MAX_PLAUSIBLE_DERIVED_PALLET_KG
        : positive(root, "maxPlausibleDerivedPalletKg", "groupage-rates"),
  };
}

let cache: { rates: GroupageRates; mtimeMs: number } | null = null;

/** Reads + validates the rates file, cached by file mtime — an on-disk edit is picked
 *  up on the next quote without a restart (matches how hubs stay fresh per request).
 *  Fails loud on a missing/malformed file. */
export async function loadGroupageRates(): Promise<GroupageRates> {
  const path = resolve(process.cwd(), getConfig().groupage.ratesPath);
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    throw new GroupageRatesError(`cannot read rates file at ${path}`);
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.rates;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new GroupageRatesError(`cannot read rates file at ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new GroupageRatesError(`rates file is not valid JSON: ${path}`);
  }
  cache = { rates: parseGroupageRates(json), mtimeMs };
  return cache.rates;
}
