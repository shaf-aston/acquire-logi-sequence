/**
 * How each pallet footprint class is PRESENTED and what it COSTS in space — one source of truth
 * so the manual quote form and the shared-truck planner describe pallets identically (MRMR).
 *
 * Config-driven, so a label can never drift from the maths behind the quote:
 *   • the space each class consumes comes from `config/groupage-rates.json` (the SAME numbers the
 *     pricing/demand core sums), and
 *   • the physical size comes from `config/pallet-spec.json` (the SAME the 3D stacker packs with).
 *
 * Pure module (config reads only, no I/O), safe to import into a client component.
 */
import ratesJson from "../../../config/groupage-rates.json";
import specJson from "../../../config/pallet-spec.json";
import { PALLET_FOOTPRINT_CLASSES, type PalletFootprintClass } from "./groupage.types";

const SPACE_UNITS = ratesJson.footprintUnits as Record<PalletFootprintClass, number>;
const DIMS = specJson.footprintClasses as Record<PalletFootprintClass, { lengthMm: number; widthMm: number }>;

/** The plain word an operator recognises for each class. */
const TITLES: Record<PalletFootprintClass, string> = {
  full: "Full pallet",
  half: "Half pallet",
  quarter: "Quarter pallet",
  oversize: "Oversize",
};

/** mm → a "1.2" / "0.5" metre string (one decimal, so 1000mm reads "1.0" not "1"). */
const metres = (mm: number): string => (mm / 1000).toFixed(1);

/** "1 space" · "½ space" · "¼ space" · "2 spaces" — a plain read of the space a pallet eats. */
export const spaceLabel = (units: number): string =>
  units === 0.5 ? "½ space" : units === 0.25 ? "¼ space" : `${units} space${units === 1 ? "" : "s"}`;

export interface FootprintMeta {
  readonly footprint: PalletFootprintClass;
  /** "Full pallet" */
  readonly title: string;
  /** "1.2 × 1.0 m" */
  readonly sizeLabel: string;
  /** Pallet-spaces one such pallet consumes (1, 0.5, 0.25, 2). */
  readonly spaceUnits: number;
  /** "1 space" / "½ space" … */
  readonly spaceLabel: string;
  /** Dropdown text: "Full pallet · 1.2 × 1.0 m · 1 space". */
  readonly optionLabel: string;
}

function build(cls: PalletFootprintClass): FootprintMeta {
  const d = DIMS[cls];
  const sizeLabel = `${metres(d.lengthMm)} × ${metres(d.widthMm)} m`;
  const spaceUnits = SPACE_UNITS[cls];
  const sl = spaceLabel(spaceUnits);
  return { footprint: cls, title: TITLES[cls], sizeLabel, spaceUnits, spaceLabel: sl, optionLabel: `${TITLES[cls]} · ${sizeLabel} · ${sl}` };
}

export const FOOTPRINT_META = Object.fromEntries(
  PALLET_FOOTPRINT_CLASSES.map((c) => [c, build(c)]),
) as Record<PalletFootprintClass, FootprintMeta>;

export const FOOTPRINT_META_LIST: readonly FootprintMeta[] = PALLET_FOOTPRINT_CLASSES.map((c) => FOOTPRINT_META[c]);

/** A UI pallet line while it's being edited (weight/quantity still strings). */
export interface EditablePalletLine {
  footprint: PalletFootprintClass;
  weightKg: string;
  quantity: string;
}

export interface PalletTally {
  /** Σ quantity across lines with a valid quantity. */
  readonly pallets: number;
  /** Σ spaceUnits(footprint) × quantity — what the truck is charged/measured on. */
  readonly spaces: number;
  /** Σ (weight × quantity) over lines that HAVE a weight (kg, rounded). */
  readonly weightKg: number;
  /** Pallets still missing a weight — the honest "not priceable yet" count. */
  readonly unweighedPallets: number;
}

/** Live running totals for a set of editable pallet lines — the at-a-glance read of a load. */
export function tallyPalletLines(lines: readonly EditablePalletLine[]): PalletTally {
  let pallets = 0;
  let spaces = 0;
  let weightKg = 0;
  let unweighedPallets = 0;
  for (const l of lines) {
    const qty = Number.parseInt(l.quantity, 10);
    const q = Number.isFinite(qty) && qty > 0 ? qty : 0;
    if (q === 0) continue;
    pallets += q;
    spaces += (SPACE_UNITS[l.footprint] ?? 0) * q;
    const w = Number.parseFloat(l.weightKg);
    if (Number.isFinite(w) && w > 0) weightKg += w * q;
    else unweighedPallets += q;
  }
  // Round spaces to 2dp to avoid float dust (0.25 × 3 = 0.7500000001 style noise) in the display.
  return { pallets, spaces: Math.round(spaces * 100) / 100, weightKg: Math.round(weightKg), unweighedPallets };
}
