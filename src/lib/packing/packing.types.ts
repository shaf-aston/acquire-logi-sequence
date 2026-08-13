/**
 * Stage 3 — 3D load / space calculation domain types.
 *
 * Coordinate system: the van interior is an axis-aligned box with its origin at
 * one bottom corner. `x` runs along the van length (`l`), `y` along the width
 * (`w`), `z` upward (`h`). All linear units are metres (m). Mass is kilograms.
 *
 * Reference dimension mapping (Arredo3 `L/H/P` → our `l/w/h`):
 *   L (lunghezza)  → l   (length, van x)
 *   P (profondità) → w   (depth → width, van y)
 *   H (altezza)    → h   (height, van z)
 */
import type { Fragility } from "@/lib/classification/types";
import type { DurabilityTier, OrientationLock } from "@/lib/classification/durability.types";

/** A point or size in van-space (m). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Box dimensions in an item's own frame (m). */
export interface Dimensions {
  readonly l: number;
  readonly w: number;
  readonly h: number;
}

/** Transport category — drives the stackability matrix (config/stackability.json). */
export const PACKING_CATEGORIES = [
  "heavy-material",
  "glass-panel",
  "light-industrial",
  "appliance",
  "top",
  "base-cabinet",
  "wall-cabinet",
  "tall-unit",
  "accessory",
] as const;
export type PackingCategory = (typeof PACKING_CATEGORIES)[number];

/** Stacking rules resolved for a category (config/stackability.json). */
export interface StackRules {
  /** Can this item be placed on top of another item? */
  readonly stackable: boolean;
  /** Max mass (kg) this item can bear on top of it. 0 ⇒ nothing may stack on it. */
  readonly canSupportWeightKg: number;
  /** Estimator fallback density (kg/m³) when the PDF carries no per-item weight. */
  readonly densityKgPerM3: number;
  /** Category-level default rotation policy; overridden per item when Material is classified. */
  readonly orientationLock: OrientationLock;
  /**
   * Internal crush limit (kPa): the most vertical pressure this item can bear on
   * its top face before the box above it is refused. See stackPressureKpa.
   */
  readonly maxStackPressureKpa: number;
}

/**
 * The unit the packer reasons about. Built by the item-assembler from a
 * `ClassifiedItem` (Stage 2) joined with the parsed dimension columns.
 */
export interface Item {
  readonly id: string;
  readonly name: string;
  /** Null when the source row had missing/merged dimensions — excluded from packing, flagged. */
  readonly dimensions: Dimensions | null;
  readonly weightKg: number;
  readonly quantity: number;
  readonly fragility: Fragility;
  readonly category: PackingCategory;
  readonly stackable: boolean;
  readonly canSupportWeightKg: number;
  /** Rotation policy: fixed = natural orientation only, partial = upright/any facing, none = any of the 6 permutations. */
  readonly orientationLock: OrientationLock;
  /** Internal vertical-crush limit (kPa) on this item's top face. */
  readonly maxStackPressureKpa: number;
  /** Raw text from the Material column, null when the source table has no such column. */
  readonly material: string | null;
  /** How much weight this item can bear before it caves — derived from Material + hollow/solid build. */
  readonly durabilityTier: DurabilityTier;
  /**
   * False when the durability facts were an unconfident fallback (material text
   * unrecognised) rather than a keyword/override match. Surfaced in the review
   * table as a "low confidence" flag; a human override sets this true.
   */
  readonly durabilityConfident: boolean;
  /**
   * Snaps instead of deforming (glass, ceramic, stone, plasterboard). Enforced: it
   * caps the durability tier used for the crush-limit lookup at "low" and then
   * softens the result by `brittleFactor` (config/durability-tiers.json) in the
   * assembler — same mechanism as `deformable`, not a separate veto.
   */
  readonly brittle: boolean;
  /**
   * Compresses and recovers rather than breaking (foam, fabric). Enforced: it
   * softens the item's crush limit by `deformableFactor` (config/durability-tiers.json)
   * in the assembler, so less may rest on top than on a rigid item of the same
   * tier. (No lateral-support model — vertical crush + fragility only.)
   */
  readonly deformable: boolean;
  /**
   * 0-based delivery stop this item is bound for on a multi-drop groupage manifest
   * (from the Stop column). Undefined on single-drop jobs. Drives drop-order
   * loading — earlier stops are packed toward the van doors so they unload first
   * (see zoned-packer.ts). Never affects the crush/fit/weight maths.
   */
  readonly stopIndex?: number;
}

/** Interior box of a fleet van (config/vans.json). */
export interface Van {
  readonly id: string;
  readonly label: string;
  readonly interior: Dimensions;
  readonly maxPayloadKg: number;
  /** Loading aperture (m); optional gate constraint. */
  readonly doorAperture?: { readonly w: number; readonly h: number };
  /** Estimated fuel cost per mile for operating-cost views. */
  readonly fuelCostPerMile?: number;
  /** Carried for Stage 5 pricing; unused by the packer. */
  readonly perMileRate: number;
  /** Grams of CO₂ emitted per mile driven; undefined ⇒ no carbon figure quoted for this van. */
  readonly co2GramsPerMile?: number;
  /** Available units in the fleet; undefined → treated as 5 by the allocator. */
  readonly quantity?: number;
  /**
   * Operator-facing size band (e.g. "Small", "Large", "Box truck"). Free-form so
   * new bands need only be typed in Fleet Setup — the Cost Planner groups by this
   * string and orders bands by volume, so nothing here is hardcoded. Unused by the
   * packer/pricer.
   */
  readonly sizeClass?: string;
}

/** One placed unit of an item. Size maps l→x, w→y, h→z (natural orientation). */
export interface Placement {
  readonly itemId: string;
  /** Bottom-near-left corner of the box in van-space (m). */
  readonly position: Vec3;
  /** Size in van axes x/y/z (m): l→x, w→y, h→z. */
  readonly size: Vec3;
  readonly fragile: boolean;
  readonly weightKg: number;
  /** Mass (kg) this placed item can bear on top — used by the support constraint. */
  readonly canSupportWeightKg: number;
  /** Whether this item may itself rest on another (drives manual-drag elevation policy). */
  readonly stackable: boolean;
  /** Internal vertical-crush limit (kPa) on this item's top face. */
  readonly maxStackPressureKpa: number;
  /**
   * Snaps instead of deforming. Informational carry-through only — not read by
   * placement-validator.ts. Brittleness is already folded into `maxStackPressureKpa`
   * (tier cap + brittleFactor, applied once in item-assembler.ts), so this field's
   * effect is fully captured by that one number by the time it reaches this type.
   */
  readonly brittle: boolean;
  /**
   * The item's rotation policy, carried so the interactive editor enforces the
   * SAME lock the packer did: `fixed` may not be re-oriented (not even spun flat),
   * `partial`/`none` may. Optional: absent ⇒ treat as unrestricted (test fixtures).
   */
  readonly orientationLock?: OrientationLock;
  /**
   * Which of the 6 axis permutations of the item's (l,w,h) produced `size`.
   * 0 = natural (l→x, w→y, h→z). Optional: absent ⇒ natural. Carried for viewer
   * fidelity and so manual edits can round-trip the chosen orientation.
   */
  readonly rotationIndex?: number;
  /**
   * Set by a MANUAL override in the interactive 3D editor: the operator forced this box into
   * a spot the validator rejected (overlap / unsupported / over-height / crush). It commits so
   * arranging can continue, but is drawn amber and must never feed a price/capacity number
   * until cleared (moving it to a valid spot clears it). Absent on packer output — the packer
   * only ever emits valid placements. Mirrors the same fields on the API `Placement`.
   */
  readonly flagged?: boolean;
  readonly flagReason?: string;
}

/** Output of packing one job into one van. Pure, serializable geometry. */
export interface PackingResult {
  readonly van: Van;
  readonly placements: Placement[];
  /** Σ placed box volume / van interior volume, 0..1. */
  readonly utilization: number;
  /** Items (or remaining quantity units) that could not be placed. */
  readonly unplaced: Item[];
  /** itemId → human-readable reason it (or part of it) went unplaced. */
  readonly reasons: Record<string, string>;
}

/**
 * A table that Stage 2 classified as an item table but the packer must skip whole —
 * it has neither dimension columns (Height/Width) nor a pallet column, so every one
 * of its rows would be dropped. Surfaced to the operator as a warning on the load
 * plan so a real table can never again vanish into a silent "0/0 placed". Detected by
 * `skippedCargoTables` in item-assembler.ts, which shares the one `isCargoTable`
 * predicate with the packer's per-row drop gate ("reported here" ⟺ "produced no Item").
 */
export interface SkippedTable {
  readonly pageIndex: number;
  readonly tableIndex: number;
  /** The table's header row — shown to the operator to say WHICH table and why. */
  readonly headers: string[];
  /** How many classified rows were dropped with the table. */
  readonly rowCount: number;
  /** Plain-English cause, shown in the UI as-is. */
  readonly reason: string;
}

/**
 * A cargo table the packer DID read, but only after guessing something it could
 * not confirm from the headers — the size unit was assumed (no cm/mm/m marker), or
 * a required size column was located by fixed position rather than its header. The
 * numbers are used, but the operator is asked to verify them (the "never guess"
 * surface for column/unit identity — an unmarked mm sheet read as metres is a
 * silent 100–1000× error). Detected by `flaggedCargoTables` in item-assembler.ts.
 */
export interface FlaggedTable {
  readonly pageIndex: number;
  readonly tableIndex: number;
  /** The table's header row — shown to the operator to say WHICH table. */
  readonly headers: string[];
  /** Plain-English cause(s), shown in the UI as-is. */
  readonly reason: string;
}

/** Swap-seam: the packing heuristic is replaceable without touching callers. */
export interface Packer {
  readonly strategy: string;
  pack(items: Item[], van: Van): PackingResult;
}
