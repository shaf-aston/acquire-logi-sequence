/** S3.2 / S3.4 / S3.5 — the shipped config files parse and resolve correctly. */
import { describe, it, expect } from "vitest";
import { parseStackabilityFrom, resolveStackRules } from "@/lib/packing/stackability";
import { parseColumnMapFrom, categoryForCode } from "@/lib/packing/column-map";
import { parseVansFrom } from "@/lib/packing/van.repository";
import { estimateWeightKg } from "@/lib/packing/weight-estimator";
import { surfaceM2, volumeM3 } from "@/lib/packing/geometry";
import { readConfigJson } from "./fixtures";

describe("geometry (reference formulas)", () => {
  it("surface_m2 = l * h, volume_m3 = l * w * h", () => {
    expect(surfaceM2(0.6, 0.7)).toBeCloseTo(0.42, 6);
    expect(volumeM3({ l: 0.6, w: 0.6, h: 0.7 })).toBeCloseTo(0.252, 6);
  });
});

describe("stackability matrix", () => {
  const matrix = parseStackabilityFrom(readConfigJson("config/stackability.json"));

  it("transcribes the documented matrix rows", () => {
    expect(resolveStackRules(matrix, "appliance").canSupportWeightKg).toBe(0);
    expect(resolveStackRules(matrix, "top").stackable).toBe(false);
    expect(resolveStackRules(matrix, "base-cabinet").stackable).toBe(true);
    expect(resolveStackRules(matrix, "base-cabinet").canSupportWeightKg).toBeGreaterThan(0);
    expect(resolveStackRules(matrix, "tall-unit").stackable).toBe(false);
    expect(resolveStackRules(matrix, "wall-cabinet").canSupportWeightKg).toBeLessThan(
      resolveStackRules(matrix, "base-cabinet").canSupportWeightKg,
    );
  });

  it("unknown category resolves to the conservative fallback", () => {
    const r = resolveStackRules(matrix, "mystery" as never);
    expect(r.stackable).toBe(false);
    expect(r.canSupportWeightKg).toBe(0);
  });

  it("exposes a dedicated pallet ruleset, separate from the category matrix", () => {
    expect(matrix.pallet.stackable).toBe(true);
    expect(matrix.pallet.canSupportWeightKg).toBeGreaterThan(0);
  });

  it("rejects a malformed matrix", () => {
    expect(() => parseStackabilityFrom({ fallback: {}, categories: {} })).toThrow();
  });
});

describe("weight estimator", () => {
  const matrix = parseStackabilityFrom(readConfigJson("config/stackability.json"));

  it("uses explicit weight when present", () => {
    expect(estimateWeightKg({ dimensions: { l: 0.6, w: 0.6, h: 0.7 }, explicitWeightKg: 42, densityKgPerM3: 180 })).toBe(42);
  });

  it("estimates from volume * density when no explicit weight", () => {
    const density = resolveStackRules(matrix, "base-cabinet").densityKgPerM3;
    const kg = estimateWeightKg({ dimensions: { l: 1.0, w: 1.0, h: 1.0 }, densityKgPerM3: density });
    expect(kg).toBeCloseTo(density, 6); // 1 m³ × density
  });

  it("returns 0 for dimensionless items", () => {
    expect(estimateWeightKg({ dimensions: null, densityKgPerM3: 500 })).toBe(0);
  });
});

describe("column map", () => {
  const map = parseColumnMapFrom(readConfigJson("config/column-map.json"));

  it("declares metres, English decimals, and explicit depth + quantity columns", () => {
    expect(map.inputUnit).toBe("m");
    expect(map.decimalSeparator).toBe("."); // English/US decimals (1.03 = 1.03 m, not 103)
    expect(map.columns.dimensionP).toBe(6); // explicit depth column (not derived)
    expect(map.columns.quantity).toBe(8); // quantity expanded per-unit by the packer
  });

  it("matches category patterns against the description, else defaults", () => {
    expect(categoryForCode(map, "Flat-Screen TV 55' (boxed)")).toBe("appliance");
    expect(categoryForCode(map, "Cast Iron Machine Gear Assembly")).toBe("heavy-material");
    expect(categoryForCode(map, "Pallet of Wine Glasses (200 pcs)")).toBe("glass-panel");
  });

  it("still supports explicit code-pattern maps (legacy Arredo3)", () => {
    const legacy = parseColumnMapFrom({
      version: 1,
      inputUnit: "mm",
      columns: { code: 1, quantity: 2, description: 3, dimensionL: 4, dimensionH: 5, dimensionP: 6 },
      defaultCategory: "base-cabinet",
      categoryPatterns: [{ category: "appliance", pattern: "^EFOR" }],
    });
    expect(categoryForCode(legacy, "EFOR600")).toBe("appliance");
    expect(categoryForCode(legacy, "XYZ999")).toBe("base-cabinet");
  });
});

describe("van fleet config", () => {
  it("parses the shipped fleet with unique ids", () => {
    const vans = parseVansFrom(readConfigJson("config/vans.json"));
    expect(vans.length).toBeGreaterThanOrEqual(2);
    expect(new Set(vans.map((v) => v.id)).size).toBe(vans.length);
  });

  it("rejects duplicate van ids", () => {
    expect(() =>
      parseVansFrom({
        vans: [
          { id: "a", label: "A", interior: { l: 1, w: 1, h: 1 }, maxPayloadKg: 1, perMileRate: 1 },
          { id: "a", label: "A2", interior: { l: 1, w: 1, h: 1 }, maxPayloadKg: 1, perMileRate: 1 },
        ],
      }),
    ).toThrow();
  });

  it("collapses duplicate van ids to the first occurrence when opted in", () => {
    // A client override is a definition catalogue looked up by id; a fleet with two identical
    // vans repeats the same definition. The count lives in vanIds, so collapse rather than reject.
    const vans = parseVansFrom(
      {
        vans: [
          { id: "a", label: "First", interior: { l: 1, w: 1, h: 1 }, maxPayloadKg: 1, perMileRate: 1 },
          { id: "a", label: "Second", interior: { l: 1, w: 1, h: 1 }, maxPayloadKg: 1, perMileRate: 1 },
        ],
      },
      { collapseDuplicateIds: true },
    );
    expect(vans.length).toBe(1);
    expect(vans[0]!.label).toBe("First");
  });
});
