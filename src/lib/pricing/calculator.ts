import { describeVan } from "@/lib/packing/van-format";
import { fuelRateForPayload, co2KgForTrip } from "@/lib/packing/van-cost";
import type { Van } from "@/lib/packing/packing.types";
import type { Quote, QuoteLineItem, QuoteVan, Route } from "./types";

export class PricingError extends Error {
  constructor(message: string) {
    super(`[pricing] ${message}`);
    this.name = "PricingError";
  }
}

export interface HubHandlingRates {
  readonly baseFee: number;
  readonly perWeightBlockFee: number;
  /** Weight block size (kg) each perWeightBlockFee covers. Must be > 0. */
  readonly weightBlockKg: number;
}

/**
 * Hub cross-dock handling charge: a fixed base plus a per-weight-block fee, the load weight rounded
 * UP to whole blocks (any part of a block is charged as a full one — standard freight handling).
 * e.g. £5 base + £10 per 500 kg on an 800 kg load = £5 + £10 × ⌈800/500⌉ = £25. Pure; returns the
 * amount and the block count so the caller can show the breakdown. weightBlockKg ≤ 0 ⇒ 0 blocks.
 */
export function hubHandlingCharge(
  totalWeightKg: number,
  rates: HubHandlingRates,
): { amount: number; blocks: number } {
  const blocks =
    rates.weightBlockKg > 0 ? Math.ceil(Math.max(0, totalWeightKg) / rates.weightBlockKg) : 0;
  const amount = rates.baseFee + rates.perWeightBlockFee * blocks;
  return { amount: Math.round(amount * 100) / 100, blocks };
}

/** The hub-handling charge as a ready-to-append quote line, with a breakdown in the label. */
export function hubHandlingLineItem(
  totalWeightKg: number,
  rates: HubHandlingRates,
  currencySymbol: string,
): QuoteLineItem {
  const { amount, blocks } = hubHandlingCharge(totalWeightKg, rates);
  return {
    label: `Hub cross-dock handling (${currencySymbol}${rates.baseFee} base + ${blocks} × ${currencySymbol}${rates.perWeightBlockFee}/${rates.weightBlockKg}kg)`,
    amount,
  };
}

/**
 * Append a flat base-transport fee (e.g. a hub cross-dock handling charge) to an existing quote,
 * folding it into the subtotal and total. A non-positive fee returns the quote unchanged, so a
 * £0 config default never adds a phantom line. Pure — builds a new Quote, never mutates.
 */
export function withFlatFee(quote: Quote, label: string, amount: number): Quote {
  if (!(amount > 0)) return quote;
  return {
    ...quote,
    lineItems: [...quote.lineItems, { label, amount }],
    subtotal: quote.subtotal + amount,
    total: quote.total + amount,
  };
}

/**
 * Per-van full-route pricing: every vehicle drives the same origin→destination
 * route. Base distance cost = billedMiles × perMileRate. When vanPayloads are
 * supplied, a fuel line item is added per van using the weight-adjusted rate.
 *
 * `returnFactor` scales the billed distance to cover the return drive: 1.0 = one-way,
 * 2.0 = full round trip (the van returns to base empty). `route.distanceMiles` stays
 * the true one-way figure; only the billed miles are multiplied.
 *
 * `labour` (optional) adds a driver-wage line: one driver per van, paid for the drive
 * time (`route.durationSeconds`, scaled by `returnFactor` for the return leg) plus a
 * fixed load/unload allowance per van. Omitted ⇒ no labour line (back-compatible).
 */
export interface LabourRates {
  /** Driver wage billed per hour. */
  readonly hourlyRate: number;
  /** Fixed paid handling time per van (load + unload), in minutes. */
  readonly loadUnloadMinutesPerVan: number;
}

export function calculateQuote(
  route: Route,
  vans: Van[],
  fragileCount: number,
  fragilitySurchargePerItem: number,
  currencySymbol = "£",
  vanPayloads?: number[],
  returnFactor = 1,
  labour?: LabourRates,
): Quote {
  if (vans.length === 0) {
    throw new PricingError("at least one van is required to price a job");
  }
  if (returnFactor <= 0) {
    throw new PricingError("returnFactor must be positive");
  }

  const multi = vans.length > 1;
  const billedMiles = route.distanceMiles * returnFactor;
  const roundTrip = returnFactor !== 1;
  const tripNote = roundTrip ? ` × ${returnFactor} round trip` : "";

  const quoteVans: QuoteVan[] = vans.map((van) => {
    if (van.perMileRate <= 0) {
      throw new PricingError(`van "${van.label}" has no per-mile rate configured`);
    }
    return {
      id: van.id,
      label: van.label,
      description: describeVan(van.interior, van.maxPayloadKg),
      perMileRate: van.perMileRate,
      distanceCost: billedMiles * van.perMileRate,
      co2Kg: co2KgForTrip(van, billedMiles),
    };
  });

  // Carbon total for the tender/quote CO₂ line. Omitted entirely (not shown as 0) when
  // no van in this quote has a co2GramsPerMile figure configured.
  const co2TotalKg = quoteVans.reduce((sum, v) => sum + v.co2Kg, 0);
  const anyVanHasCo2Configured = vans.some((v) => (v.co2GramsPerMile ?? 0) > 0);

  // Base distance line items
  const lineItems: QuoteLineItem[] = quoteVans.map((v, i) => ({
    label: multi
      ? `Van ${i + 1} — distance (${route.distanceMiles.toFixed(1)} mi${tripNote} @ ${currencySymbol}${v.perMileRate.toFixed(2)}/mi)`
      : `Distance (${route.distanceMiles.toFixed(1)} mi${tripNote} @ ${currencySymbol}${v.perMileRate.toFixed(2)}/mi)`,
    amount: v.distanceCost,
  }));

  // Fuel line items (payload-adjusted; omitted when vanPayloads not provided)
  let fuelSubtotal = 0;
  if (vanPayloads) {
    for (let i = 0; i < vans.length; i++) {
      const fuelRate = fuelRateForPayload(vans[i]!, vanPayloads[i] ?? 0);
      if (fuelRate <= 0) continue;
      const amount = billedMiles * fuelRate;
      fuelSubtotal += amount;
      lineItems.push({
        label: multi
          ? `Van ${i + 1} — fuel (${route.distanceMiles.toFixed(1)} mi${tripNote} @ ${currencySymbol}${fuelRate.toFixed(3)}/mi)`
          : `Fuel (${route.distanceMiles.toFixed(1)} mi${tripNote} @ ${currencySymbol}${fuelRate.toFixed(3)}/mi)`,
        amount,
      });
    }
  }

  // Driver labour: one driver per van. Drive time scales with the return factor (the
  // driver drives home too); load/unload is a one-off handling allowance per van.
  let labourSubtotal = 0;
  if (labour) {
    if (labour.hourlyRate < 0 || labour.loadUnloadMinutesPerVan < 0) {
      throw new PricingError("driver labour rate and load/unload time must be non-negative");
    }
    const driveHours = (route.durationSeconds / 3600) * returnFactor;
    const handlingHours = labour.loadUnloadMinutesPerVan / 60;
    const hoursPerDriver = driveHours + handlingHours;
    const drivers = vans.length;
    labourSubtotal = drivers * labour.hourlyRate * hoursPerDriver;
    if (labourSubtotal > 0) {
      lineItems.push({
        label: `Driver labour (${drivers} driver${drivers !== 1 ? "s" : ""} × ${hoursPerDriver.toFixed(1)}h @ ${currencySymbol}${labour.hourlyRate.toFixed(2)}/hr)`,
        amount: labourSubtotal,
      });
    }
  }

  const distanceSubtotal = quoteVans.reduce((sum, v) => sum + v.distanceCost, 0);
  const subtotal = distanceSubtotal + fuelSubtotal + labourSubtotal;

  const surcharges = fragileCount * fragilitySurchargePerItem;
  if (surcharges > 0) {
    lineItems.push({
      label: `Fragility surcharge (${fragileCount} item${fragileCount !== 1 ? "s" : ""} × ${currencySymbol}${fragilitySurchargePerItem.toFixed(2)})`,
      amount: surcharges,
    });
  }

  return {
    route,
    vans: quoteVans,
    lineItems,
    subtotal,
    surcharges,
    total: subtotal + surcharges,
    co2TotalKg: anyVanHasCo2Configured ? co2TotalKg : undefined,
  };
}
