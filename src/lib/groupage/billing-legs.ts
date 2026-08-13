import type { BillingLeg, GroupageLineItem } from "./groupage.types";

export type { BillingLeg };

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The line items belonging to one leg, in the order the pricing engine produced them. */
export function lineItemsForLeg(
  items: readonly GroupageLineItem[],
  leg: BillingLeg,
): readonly GroupageLineItem[] {
  return items.filter((li) => li.leg === leg);
}

/** Sum of a leg's line items, rounded once so per-leg totals never drift from float noise. */
export function legTotal(items: readonly GroupageLineItem[], leg: BillingLeg): number {
  return round2(lineItemsForLeg(items, leg).reduce((sum, li) => sum + li.amount, 0));
}
