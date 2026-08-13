/**
 * Groupage pricing (blueprint 1.4) — a flat rate-card lookup, no 3D volume maths:
 *
 *   Price = (Σ footprints × zone-to-zone rate)   ← line-haul; ZERO for a local (same-hub) move
 *         + per-stop fee × intermediate trunk stops
 *         + first-mile surcharge + last-mile surcharge
 *         + heavy-pallet surcharge (per pallet that is "weight-out")
 *
 * A "weight-out" pallet consumes more of the truck's weight budget than an average pallet of its
 * footprint, so it draws a surcharge. Pure function — hands totals back; never reads config itself.
 *
 * FOOTPRINT BASIS — deliberate, do not "optimise": line-haul multiplies the UNION of every pallet
 * line on the booking, wherever each one boards or alights on a multi-stop trunk. Not the origin
 * leg's load (a line joining at a stop is real freight burning real spaces — it would ride free),
 * and not the peak load across hops (two sets riding different hops would price as one set, handing
 * the customer the resale of a space we freed at a stop; peak is also non-additive, so merging two
 * bookings into one quote would price lower than quoting them separately — a straight arbitrage).
 * Union is additive and monotone: every pallet is billed exactly once, at load. It is also exactly
 * `demand.footprints`, so a stop-free quote prices identically to before stops existed.
 *
 * The rate is ONE end-to-end origin-hub → destination-hub lookup: intermediate stops never enter
 * it. A line riding one short hop therefore pays what a line riding the whole trunk pays — the
 * accepted consequence of end-to-end pricing, not a bug. Distance-fair pricing would need per-hop
 * rates; that is not this rate card.
 *
 * Same asymmetry on the ends: the first/last-mile surcharges are flat, per booking. A line that
 * joins the trunk mid-route never rode our collection van (it is excluded from the `collect` leg's
 * load, see `leg-loads.ts`) yet the booking still carries one first-mile charge — and symmetrically
 * for a line that alights early. Making those per-line would need a per-line surcharge basis; not
 * this rate card either.
 */
import {
  type GroupageDemand,
  type GroupageLineItem,
  type GroupagePallet,
  type GroupagePath,
  type PalletFootprintClass,
} from "./groupage.types";
import type { GroupageRates } from "./groupage-rates";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Per-footprint rate for a hub pair, falling back to the default when no zone override is set. */
export function zoneRate(rates: GroupageRates, originHubId: string, destHubId: string): number {
  return rates.ratePerFootprint.zones[`${originHubId}>${destHubId}`] ?? rates.ratePerFootprint.default;
}

/**
 * Billable pallet-spaces for the line-haul. A truck sells TWO things at once — floor space and
 * payload — and a groupage load can exhaust either. Charging on floor space alone means a load of
 * 15 pallets weighing 61 t buys three trucks and pays for 15 spaces (one third of one truck): a
 * straight under-charge, and precisely the "high-volume" case.
 *
 * So under `"weight-adjusted"` the weight is converted into the space it effectively consumes —
 * `Σ kg ÷ (payload ÷ spaces)`, the reference vehicle's kg-per-space — and the GREATER of the two
 * bases is billed. Continuous, not a step function, so a load 1 kg over a truck's payload costs 1 kg
 * more, not a whole extra truck. Monotone and additive, exactly like the footprint basis it extends,
 * so the anti-arbitrage argument in this module's header still holds.
 *
 * The reference vehicle is the TRUNK: it is the line-haul vehicle, and a `direct` move's pooled
 * carrier prices on the same line-haul economics (its path has no trunk leg to read a capacity off).
 * Identical to `"footprints"` for any load that is not weight-out, so ordinary quotes are unchanged.
 */
export function chargeableFootprints(demand: GroupageDemand, rates: GroupageRates): number {
  if (rates.chargeableSpaceBasis === "footprints") return demand.footprints;
  const { palletSpaces, maxPayloadKg } = rates.legCapacity.trunk;
  // Both are validated positive at the config boundary; guard anyway rather than divide by zero and
  // bill Infinity.
  if (palletSpaces <= 0 || maxPayloadKg <= 0) return demand.footprints;
  const kgPerSpace = maxPayloadKg / palletSpaces;
  return round2(Math.max(demand.footprints, demand.weightKg / kgPerSpace));
}

/** Pallets that are "weight-out": weight-per-footprint-unit over the heavy threshold. */
export function heavyPalletCount(
  pallets: readonly GroupagePallet[],
  footprintUnits: Readonly<Record<PalletFootprintClass, number>>,
  thresholdKgPerFootprint: number,
): number {
  let count = 0;
  for (const p of pallets) {
    const unit = footprintUnits[p.footprint];
    if (unit > 0 && p.weightKg / unit > thresholdKgPerFootprint) count += p.quantity;
  }
  return count;
}

export interface GroupagePriceResult {
  readonly lineItems: GroupageLineItem[];
  readonly subtotal: number;
  readonly surcharges: number;
  readonly total: number;
}

export function priceGroupage(input: {
  readonly pallets: readonly GroupagePallet[];
  readonly demand: GroupageDemand;
  readonly path: GroupagePath;
  readonly rates: GroupageRates;
  readonly currencySymbol: string;
}): GroupagePriceResult {
  const { pallets, demand, path, rates, currencySymbol } = input;
  const lineItems: GroupageLineItem[] = [];

  // Line-haul, priced per pallet-space. Three cases:
  //   • local (same hub)  → no trunk movement → £0.
  //   • hub (distinct hubs) → the zone-to-zone rate for that hub pair.
  //   • direct (no hub) → the default per-space rate (a hubless pooled move still consumes
  //     truck pallet-spaces; there is no hub pair to look a zone rate up by).
  let subtotal = 0;
  if (path.kind !== "local") {
    const rate =
      path.kind === "hub" && path.originHub && path.destinationHub
        ? zoneRate(rates, path.originHub.id, path.destinationHub.id)
        : rates.ratePerFootprint.default;
    const spaces = chargeableFootprints(demand, rates);
    const haul = round2(spaces * rate);
    // Name the weight-adjustment when it bites, so the operator can see WHY a 15-pallet load bills
    // 66 spaces rather than being handed an unexplained number.
    const basis =
      spaces > demand.footprints
        ? `${spaces} pallet-spaces, weight-adjusted from ${demand.footprints}`
        : `${spaces} pallet-spaces`;
    const label =
      path.kind === "direct"
        ? `Line-haul · direct (${basis} × ${currencySymbol}${rate}/pallet-space)`
        : `Line-haul (${basis} × ${currencySymbol}${rate}/pallet-space)`;
    lineItems.push({ label, amount: haul, leg: "trunk" });
    subtotal += haul;
  }

  // Intermediate trunk stops. Billed per stop, on the trunk (so the UI shows it under the trunk
  // map). Silent when the fee is 0 — the default — so enabling stops never changes a price by itself.
  const stopCount = path.stops?.length ?? 0;
  if (stopCount > 0 && rates.perTrunkStopFee > 0) {
    const stopFee = round2(stopCount * rates.perTrunkStopFee);
    lineItems.push({
      label: `Intermediate stops (${stopCount} × ${currencySymbol}${rates.perTrunkStopFee}/stop)`,
      amount: stopFee,
      leg: "trunk",
    });
    subtotal += stopFee;
  }

  lineItems.push({ label: "First-mile collection", amount: round2(rates.firstMileSurcharge), leg: "collection" });
  // Last-mile delivery runs AFTER the trunk, past the destination hub — neither of the two mapped
  // legs (collection round, hub-to-hub trunk) covers it, so it lands in "other" alongside surcharges.
  lineItems.push({ label: "Last-mile delivery", amount: round2(rates.lastMileSurcharge), leg: "other" });
  subtotal += round2(rates.firstMileSurcharge) + round2(rates.lastMileSurcharge);

  // Heavy-pallet surcharge (the only "surcharge" line; first/last mile are base transport).
  const heavy = heavyPalletCount(pallets, rates.footprintUnits, rates.heavyPallet.thresholdKgPerFootprint);
  let surcharges = 0;
  if (heavy > 0) {
    surcharges = round2(heavy * rates.heavyPallet.surchargePerPallet);
    lineItems.push({
      label: `Heavy-pallet surcharge (${heavy} weight-out pallet${heavy === 1 ? "" : "s"})`,
      amount: surcharges,
      leg: "other",
    });
  }

  subtotal = round2(subtotal);
  return { lineItems, subtotal, surcharges, total: round2(subtotal + surcharges) };
}
