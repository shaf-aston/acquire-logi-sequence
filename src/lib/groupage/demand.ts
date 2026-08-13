/**
 * Compute a booking's demand (blueprint "Freight Profile"): the sum of footprint units and the
 * sum of weights across every pallet line. Validates each line at the boundary — reject zero /
 * negative quantities and weights loudly rather than silently pricing a bad load.
 *
 * The per-pallet weight CEILING is deliberately soft: a document's own stated tonnage is TRUSTED,
 * not rejected (config `enforcePerPalletCeiling`, default false). A heavy load is still priced (the
 * heavyPallet surcharge) and any genuine overflow is surfaced by the per-leg capacity check, never
 * a hard block. Flip the config flag on to reinstate the ceiling as a fat-finger guard.
 */
import {
  GroupageError,
  type GroupageDemand,
  type GroupagePallet,
  type PalletFootprintClass,
} from "./groupage.types";

/**
 * Sum footprint units, weight and pallet count over already-validated lines. Pure arithmetic: no
 * validation and no empty-check, because it is also the per-leg summariser — a leg that carries
 * nothing is a legitimate zero, not an error. `computeDemand` validates; this only adds up.
 */
export function sumDemand(
  pallets: readonly GroupagePallet[],
  footprintUnits: Readonly<Record<PalletFootprintClass, number>>,
): GroupageDemand {
  let footprints = 0;
  let weightKg = 0;
  let palletCount = 0;
  for (const p of pallets) {
    footprints += footprintUnits[p.footprint]! * p.quantity;
    weightKg += p.weightKg * p.quantity;
    palletCount += p.quantity;
  }
  return { footprints, weightKg, palletCount };
}

export function computeDemand(
  pallets: readonly GroupagePallet[],
  footprintUnits: Readonly<Record<PalletFootprintClass, number>>,
  maxPallets: number,
  maxPalletWeightKg: number,
  enforcePerPalletCeiling = false,
): GroupageDemand {
  // `!pallets?.length`, not `pallets.length === 0`: this is public and is also fed disk-loaded
  // consignments (`truck-grouping.ts`), whose JSON is trusted by the type only. A record missing its
  // pallet lines would otherwise be a TypeError — a generic 500 — instead of this actionable 400.
  if (!pallets?.length) {
    throw new GroupageError("input", "Add at least one pallet to quote.");
  }

  let palletCount = 0;

  pallets.forEach((p, i) => {
    if (!Number.isInteger(p.quantity) || p.quantity < 1) {
      throw new GroupageError("input", `Pallet line ${i + 1}: quantity must be a whole number ≥ 1.`);
    }
    if (!Number.isFinite(p.weightKg) || p.weightKg <= 0) {
      throw new GroupageError("input", `Pallet line ${i + 1}: weight must be greater than 0 kg.`);
    }
    // Soft ceiling: only a hard block when the business has explicitly opted in. Otherwise the
    // quotation's tonnage is trusted (priced via the heavyPallet surcharge, overflow surfaced by
    // the leg capacity check) — a legitimate high-volume load is never rejected here.
    if (enforcePerPalletCeiling && p.weightKg > maxPalletWeightKg) {
      throw new GroupageError(
        "input",
        `Pallet line ${i + 1}: ${p.weightKg} kg exceeds the per-pallet ceiling of ${maxPalletWeightKg} kg.`,
      );
    }
    // `hasOwn`, not `!== undefined`: a footprint of "constructor"/"toString" would inherit a
    // function off Object.prototype, pass an undefined-check, and then multiply into NaN.
    if (!Object.hasOwn(footprintUnits, p.footprint)) {
      throw new GroupageError("input", `Pallet line ${i + 1}: unknown pallet footprint "${p.footprint}".`);
    }
    palletCount += p.quantity;
  });

  if (palletCount > maxPallets) {
    throw new GroupageError(
      "input",
      `This booking has ${palletCount} pallets; the single-booking limit is ${maxPallets} — split into a second booking.`,
    );
  }

  // Every line is validated above, so the summariser may assume well-formed input.
  return sumDemand(pallets, footprintUnits);
}
