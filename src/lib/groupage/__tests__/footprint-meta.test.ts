import { describe, expect, it } from "vitest";
import { FOOTPRINT_META, tallyPalletLines, type EditablePalletLine } from "@/lib/groupage/footprint-meta";

/**
 * The footprint presentation + tally is the one place the UI describes pallets, so it must
 * mirror the config the pricing/demand core sums (full=1, half=0.5, quarter=0.25, oversize=2
 * pallet-spaces). These lock the space maths and the honest "still needs a weight" count.
 */

describe("FOOTPRINT_META — matches the config the quote is priced on", () => {
  it("carries the config space units and real dimensions", () => {
    expect(FOOTPRINT_META.full.spaceUnits).toBe(1);
    expect(FOOTPRINT_META.half.spaceUnits).toBe(0.5);
    expect(FOOTPRINT_META.quarter.spaceUnits).toBe(0.25);
    expect(FOOTPRINT_META.oversize.spaceUnits).toBe(2);
    expect(FOOTPRINT_META.full.sizeLabel).toBe("1.2 × 1.0 m");
    expect(FOOTPRINT_META.full.optionLabel).toBe("Full pallet · 1.2 × 1.0 m · 1 space");
    expect(FOOTPRINT_META.half.spaceLabel).toBe("½ space");
  });
});

describe("tallyPalletLines", () => {
  const line = (footprint: EditablePalletLine["footprint"], weightKg: string, quantity: string): EditablePalletLine => ({ footprint, weightKg, quantity });

  it("sums pallets, spaces and weight across lines", () => {
    const t = tallyPalletLines([line("full", "250", "2"), line("half", "100", "3")]);
    expect(t.pallets).toBe(5); // 2 + 3
    expect(t.spaces).toBe(3.5); // 1×2 + 0.5×3
    expect(t.weightKg).toBe(800); // 250×2 + 100×3
    expect(t.unweighedPallets).toBe(0);
  });

  it("counts pallets with a blank weight as unweighed, and leaves them out of the weight total", () => {
    const t = tallyPalletLines([line("full", "", "4"), line("quarter", "50", "2")]);
    expect(t.pallets).toBe(6);
    expect(t.spaces).toBe(4.5); // 1×4 + 0.25×2
    expect(t.weightKg).toBe(100); // only the weighed quarter line
    expect(t.unweighedPallets).toBe(4);
  });

  it("ignores lines with a zero/blank/invalid quantity", () => {
    const t = tallyPalletLines([line("full", "300", "0"), line("full", "300", ""), line("full", "300", "abc")]);
    expect(t).toEqual({ pallets: 0, spaces: 0, weightKg: 0, unweighedPallets: 0 });
  });

  it("rounds fractional space dust to 2dp", () => {
    const t = tallyPalletLines([line("quarter", "10", "3")]); // 0.25 × 3 = 0.75
    expect(t.spaces).toBe(0.75);
  });
});
