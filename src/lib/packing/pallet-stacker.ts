/**
 * Pallet-stacker — turns a SHARED TRUCK (several companies' pallets) into a 3D load plan.
 *
 * This is the truck-level sibling of the pallet-level `GroupagePalletBuilder`: there the "boxes"
 * are loose items and the container is one pallet; here the "boxes" are whole pallets and the
 * container is the shared vehicle. It REUSES the exact same `Packer` (HeuristicPacker) and its
 * validated stack-load / crush rules — a heavy pallet cannot be auto-stacked onto one that can't
 * bear it, because each pallet Item carries a real `weightKg` + `canSupportWeightKg` from config.
 * No new geometry maths lives here; this only adapts pallets → `Item[]` and maps placements back
 * to the company that owns them (for the per-company colour in the viewer).
 *
 * Pure: the `Packer` and the pallet spec are injected, so it runs identically on the server (the
 * stack API) and in a test.
 */
import type { Dimensions, Item, Packer, Placement, Van } from "./packing.types";
import type { PalletFootprintClass } from "@/lib/groupage/groupage.types";
import type { SharedTruck } from "@/lib/groupage/truck-grouping";

const MM_PER_M = 1000;

/** Physical dimensions + stack policy for one footprint class (config/pallet-spec.json). */
export interface FootprintDims {
  readonly lengthMm: number;
  readonly widthMm: number;
  readonly loadedHeightMm: number;
  readonly stackable: boolean;
}

/** The pallet-geometry config the stacker needs (a validated slice of config/pallet-spec.json). */
export interface PalletStackSpec {
  readonly footprintClasses: Readonly<Record<PalletFootprintClass, FootprintDims>>;
  readonly stacking: {
    /** Mass (kg) a pallet can bear on top before the pallet above it is refused. */
    readonly canSupportWeightKg: number;
    /** Vertical-crush limit (kPa) on a pallet's top face. */
    readonly maxStackPressureKpa: number;
  };
}

/** A pallet that couldn't be placed in the truck — surfaced, never silently dropped. */
export interface UnplacedPallet {
  readonly company: string;
  readonly footprint: PalletFootprintClass;
  readonly count: number;
  readonly reason: string;
}

/** One distinct company on a shared truck. A company that ships from more than one collection
 *  point appears ONCE here (one colour, one legend row), with each pickup listed in `origins`. */
export interface CompanyRosterEntry {
  readonly key: string;
  readonly label: string;
  /** Distinct collection points (origin postcodes) this company ships from on this truck. */
  readonly origins: string[];
}

export interface StackedTruck {
  readonly vanId: string;
  readonly interior: Dimensions;
  readonly placements: Placement[];
  /** Company key per placement, index-aligned to `placements` (drives the per-company colour). */
  readonly companyKeys: string[];
  /** Company display label per placement, index-aligned to `placements`. */
  readonly companyLabels: string[];
  /** Distinct companies on this truck, in first-seen order — for the viewer legend. */
  readonly companies: CompanyRosterEntry[];
  readonly unplaced: UnplacedPallet[];
}

/** Normalised company identity — trims and case-folds so "Acme" and "acme " are the same firm. */
const companyIdOf = (name: string): string => name.trim().toLowerCase();

/**
 * Collapse a truck's members into DISTINCT companies (first-seen order). Two members naming the
 * same company — e.g. one firm with more than one collection point — become ONE roster entry, so
 * the legend, colours and per-company 3D read one company once, with every pickup gathered under
 * it. Keys are `c0..cN` in first-seen order and are what the pallet itemIds are prefixed with.
 */
export function companyRoster(members: readonly SharedTruck["members"][number][]): CompanyRosterEntry[] {
  const order: string[] = [];
  const byId = new Map<string, { key: string; label: string; origins: string[] }>();
  for (const m of members) {
    const id = companyIdOf(m.company);
    let entry = byId.get(id);
    if (!entry) {
      entry = { key: `c${order.length}`, label: m.company.trim(), origins: [] };
      byId.set(id, entry);
      order.push(id);
    }
    const origin = m.originPostcode.trim();
    if (origin !== "" && !entry.origins.includes(origin)) entry.origins.push(origin);
  }
  return order.map((id) => byId.get(id)!);
}

const dimsOf = (f: FootprintDims): Dimensions => ({
  l: f.lengthMm / MM_PER_M,
  w: f.widthMm / MM_PER_M,
  h: f.loadedHeightMm / MM_PER_M,
});

/** Company key from a stacker itemId (`<companyKey>#<footprint>`). */
const companyKeyOf = (itemId: string): string => itemId.slice(0, itemId.indexOf("#"));

/**
 * Build a pallet as a packer `Item`. A pallet is a rigid, standard (non-fragile, non-brittle),
 * fixed-orientation base — it ships flat and never tips, so the packer won't re-orient it. Its
 * bearing/crush limits come from config, so the SAME support gate that protects the box view
 * protects this one.
 */
function palletItem(
  id: string,
  label: string,
  dims: Dimensions,
  weightKg: number,
  quantity: number,
  spec: PalletStackSpec,
  stackable: boolean,
): Item {
  return {
    id,
    name: label,
    dimensions: dims,
    weightKg,
    quantity,
    fragility: "standard",
    category: "heavy-material",
    stackable,
    canSupportWeightKg: spec.stacking.canSupportWeightKg,
    orientationLock: "fixed",
    maxStackPressureKpa: spec.stacking.maxStackPressureKpa,
    material: null,
    durabilityTier: "high",
    durabilityConfident: true,
    brittle: false,
    deformable: false,
  };
}

/**
 * Auto-pack a shared truck's pallets into the given vehicle, colour-mapped by company.
 * Each company's pallet lines become packer Items (one Item per line, quantity = line quantity);
 * `packer.pack` produces the suggested placements + any that don't fit. Placements are mapped back
 * to their owning company via the itemId prefix, so the viewer can colour and label each box.
 */
export function stackTruck(truck: SharedTruck, van: Van, packer: Packer, spec: PalletStackSpec): StackedTruck {
  const companies = companyRoster(truck.members);
  // Company → its roster key, so every pickup a firm makes shares one key/colour.
  const keyByCompany = new Map(companies.map((c) => [companyIdOf(c.label), c.key]));
  const labelByKey = new Map(companies.map((c) => [c.key, c.label]));
  const metaById = new Map<string, { company: string; footprint: PalletFootprintClass }>();
  const items: Item[] = [];

  // `mi` (member index) keeps itemIds unique when one company ships from several collection points.
  truck.members.forEach((member, mi) => {
    const key = keyByCompany.get(companyIdOf(member.company))!;
    member.pallets.forEach((line, li) => {
      const fp = spec.footprintClasses[line.footprint];
      const id = `${key}#${mi}-${line.footprint}-${li}`;
      metaById.set(id, { company: member.company, footprint: line.footprint });
      items.push(palletItem(id, member.company, dimsOf(fp), line.weightKg, line.quantity, spec, fp.stackable));
    });
  });

  const result = packer.pack(items, van);

  const companyKeys = result.placements.map((p) => companyKeyOf(p.itemId));
  const companyLabels = companyKeys.map((k) => labelByKey.get(k) ?? k);

  const unplaced: UnplacedPallet[] = result.unplaced.map((item) => {
    const meta = metaById.get(item.id);
    return {
      company: meta?.company ?? companyKeyOf(item.id),
      footprint: meta?.footprint ?? "full",
      count: Math.max(1, item.quantity),
      reason: result.reasons[item.id] ?? "Did not fit the truck.",
    };
  });

  return {
    vanId: van.id,
    interior: van.interior,
    placements: result.placements,
    companyKeys,
    companyLabels,
    companies,
    unplaced,
  };
}
