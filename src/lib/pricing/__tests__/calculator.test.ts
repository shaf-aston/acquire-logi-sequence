import { describe, it, expect } from "vitest";
import { calculateQuote, withFlatFee, hubHandlingCharge, PricingError } from "@/lib/pricing/calculator";
import type { Route } from "@/lib/pricing/types";
import type { Van } from "@/lib/packing/packing.types";

const route: Route = {
  origin: "London",
  destination: "Manchester",
  distanceMiles: 200,
  durationSeconds: 7200,
  distanceMethod: "road",
  legs: [{ from: "London", to: "Manchester", distanceMiles: 200, durationSeconds: 7200, distanceMethod: "road" }],
};

function makeVan(overrides: Partial<Van> = {}): Van {
  return {
    id: overrides.id ?? "transit",
    label: overrides.label ?? "Transit L3",
    interior: overrides.interior ?? { l: 4.32, w: 1.78, h: 1.94 },
    maxPayloadKg: overrides.maxPayloadKg ?? 1600,
    perMileRate: overrides.perMileRate ?? 2.5,
  };
}

describe("calculateQuote", () => {
  it("computes subtotal and total with no fragile items", () => {
    const q = calculateQuote(route, [makeVan()], 0, 5);
    expect(q.subtotal).toBe(500);
    expect(q.surcharges).toBe(0);
    expect(q.total).toBe(500);
    expect(q.lineItems).toHaveLength(1);
    expect(q.vans).toHaveLength(1);
  });

  it("withFlatFee appends a hub-handling line and folds it into subtotal + total", () => {
    const q = calculateQuote(route, [makeVan()], 0, 5); // subtotal 500
    const withFee = withFlatFee(q, "Hub cross-dock handling", 30);
    expect(withFee.subtotal).toBe(530);
    expect(withFee.total).toBe(530);
    expect(withFee.lineItems.at(-1)).toEqual({ label: "Hub cross-dock handling", amount: 30 });
  });

  it("hubHandlingCharge = base + per-block, weight rounded UP to whole blocks", () => {
    const rates = { baseFee: 5, perWeightBlockFee: 10, weightBlockKg: 500 };
    expect(hubHandlingCharge(0, rates)).toEqual({ amount: 5, blocks: 0 }); // base only, no weight
    expect(hubHandlingCharge(500, rates)).toEqual({ amount: 15, blocks: 1 }); // exactly one block
    expect(hubHandlingCharge(501, rates)).toEqual({ amount: 25, blocks: 2 }); // part-block rounds up
    expect(hubHandlingCharge(800, rates)).toEqual({ amount: 25, blocks: 2 }); // £5 + £10 × 2
  });

  it("withFlatFee is a no-op for a zero/negative fee (no phantom line)", () => {
    const q = calculateQuote(route, [makeVan()], 0, 5);
    expect(withFlatFee(q, "Hub cross-dock handling", 0)).toBe(q);
    expect(withFlatFee(q, "Hub cross-dock handling", -5)).toBe(q);
  });

  it("adds fragility surcharge line when fragileCount > 0", () => {
    const q = calculateQuote(route, [makeVan()], 3, 5);
    expect(q.surcharges).toBe(15);
    expect(q.total).toBe(515);
    expect(q.lineItems).toHaveLength(2);
    expect(q.lineItems[1]?.label).toMatch(/Fragility/);
  });

  it("prices each van on the full route and sums the distance cost", () => {
    const q = calculateQuote(
      route,
      [makeVan({ id: "a", perMileRate: 0.9 }), makeVan({ id: "b", perMileRate: 1.0 })],
      0,
      5,
    );
    // 200 mi × (0.9 + 1.0) = 380
    expect(q.subtotal).toBe(380);
    expect(q.total).toBe(380);
    expect(q.vans).toHaveLength(2);
    expect(q.vans[0]?.distanceCost).toBe(180);
    expect(q.vans[1]?.distanceCost).toBe(200);
    expect(q.lineItems).toHaveLength(2);
    expect(q.lineItems[0]?.label).toMatch(/Van 1/);
  });

  it("charges the fragility surcharge once across a multi-van job", () => {
    const q = calculateQuote(
      route,
      [makeVan({ id: "a", perMileRate: 1 }), makeVan({ id: "b", perMileRate: 1 })],
      4,
      5,
    );
    expect(q.surcharges).toBe(20);
    expect(q.total).toBe(400 + 20);
  });

  it("describes vans by capability (no brand name in the description)", () => {
    const q = calculateQuote(route, [makeVan({ interior: { l: 4.32, w: 1.78, h: 1.94 }, maxPayloadKg: 1600 })], 0, 5);
    expect(q.vans[0]?.description).toBe("4.32 × 1.78 × 1.94 m · up to 1600 kg");
  });

  it("throws PricingError when perMileRate is 0", () => {
    expect(() => calculateQuote(route, [makeVan({ perMileRate: 0 })], 0, 5)).toThrow(PricingError);
  });

  it("throws PricingError when perMileRate is negative", () => {
    expect(() => calculateQuote(route, [makeVan({ perMileRate: -1 })], 0, 5)).toThrow(PricingError);
  });

  it("throws PricingError when no vans are supplied", () => {
    expect(() => calculateQuote(route, [], 0, 5)).toThrow(PricingError);
  });

  it("defaults to one-way pricing (returnFactor 1)", () => {
    const q = calculateQuote(route, [makeVan({ perMileRate: 2.5 })], 0, 5);
    expect(q.subtotal).toBe(500); // 200 mi × 2.5
    expect(q.lineItems[0]?.label).not.toMatch(/round trip/);
  });

  it("doubles billed distance for a round trip (returnFactor 2)", () => {
    const q = calculateQuote(route, [makeVan({ perMileRate: 2.5 })], 0, 5, "£", undefined, 2);
    expect(q.subtotal).toBe(1000); // 200 mi × 2 × 2.5
    expect(q.vans[0]?.distanceCost).toBe(1000);
    // Reported one-way distance is unchanged; only the billed miles scale.
    expect(q.route.distanceMiles).toBe(200);
    expect(q.lineItems[0]?.label).toMatch(/× 2 round trip/);
    expect(q.lineItems[0]?.label).toMatch(/200\.0 mi/);
  });

  it("scales the payload-adjusted fuel line by the return factor too", () => {
    const fuelVan = { ...makeVan({ perMileRate: 2.5, maxPayloadKg: 1600 }), fuelCostPerMile: 0.3 };
    const oneWay = calculateQuote(route, [fuelVan], 0, 5, "£", [800], 1);
    const roundTrip = calculateQuote(route, [fuelVan], 0, 5, "£", [800], 2);
    // A fuel line must exist (distance + fuel = 2 line items), and the whole quote doubles.
    expect(oneWay.lineItems).toHaveLength(2);
    expect(roundTrip.subtotal).toBeCloseTo(oneWay.subtotal * 2, 5);
  });

  it("throws PricingError when returnFactor is not positive", () => {
    expect(() => calculateQuote(route, [makeVan()], 0, 5, "£", undefined, 0)).toThrow(PricingError);
  });

  it("adds a driver labour line: one driver per van paid for drive + handling time", () => {
    // route is 7200 s = 2 h drive (one-way). returnFactor 1, 30 min handling, £15/hr.
    const q = calculateQuote(route, [makeVan({ perMileRate: 2.5 })], 0, 5, "£", undefined, 1, {
      hourlyRate: 15,
      loadUnloadMinutesPerVan: 30,
    });
    // hoursPerDriver = 2 h drive + 0.5 h handling = 2.5 h; 1 driver × £15 × 2.5 = £37.50
    expect(q.subtotal).toBe(500 + 37.5);
    expect(q.lineItems.at(-1)?.label).toMatch(/Driver labour \(1 driver × 2.5h @ £15.00\/hr\)/);
  });

  it("scales drive time by the return factor but not the handling allowance", () => {
    const q = calculateQuote(route, [makeVan({ perMileRate: 2.5 })], 0, 5, "£", undefined, 2, {
      hourlyRate: 15,
      loadUnloadMinutesPerVan: 30,
    });
    // drive 2 h × 2 = 4 h + 0.5 h handling = 4.5 h; £15 × 4.5 = £67.50 labour
    const labour = q.lineItems.find((l) => /Driver labour/.test(l.label));
    expect(labour?.amount).toBe(67.5);
  });

  it("charges one driver per van across a multi-van job", () => {
    const q = calculateQuote(
      route,
      [makeVan({ id: "a", perMileRate: 1 }), makeVan({ id: "b", perMileRate: 1 })],
      0,
      5,
      "£",
      undefined,
      1,
      { hourlyRate: 15, loadUnloadMinutesPerVan: 30 },
    );
    // 2 drivers × £15 × 2.5 h = £75
    const labour = q.lineItems.find((l) => /Driver labour/.test(l.label));
    expect(labour?.amount).toBe(75);
    expect(labour?.label).toMatch(/2 drivers/);
  });

  it("omits the labour line when no labour rates are supplied (back-compatible)", () => {
    const q = calculateQuote(route, [makeVan({ perMileRate: 2.5 })], 0, 5);
    expect(q.lineItems.some((l) => /Driver labour/.test(l.label))).toBe(false);
    expect(q.subtotal).toBe(500);
  });

  it("throws PricingError when the driver hourly rate is negative", () => {
    expect(() =>
      calculateQuote(route, [makeVan()], 0, 5, "£", undefined, 1, { hourlyRate: -1, loadUnloadMinutesPerVan: 30 }),
    ).toThrow(PricingError);
  });
});
