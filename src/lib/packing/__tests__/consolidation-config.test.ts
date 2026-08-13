/** Phase 7 — consolidation config parses, validates, and rejects bad input. */
import { describe, it, expect } from "vitest";
import { parseConsolidationConfigFrom } from "@/lib/packing/consolidation-config";
import { readConfigJson } from "./fixtures";

describe("consolidation config", () => {
  it("parses the shipped config/consolidation.json", () => {
    const cfg = parseConsolidationConfigFrom(readConfigJson("config/consolidation.json"));
    expect(cfg.enabled).toBe(true);
    expect(cfg.minUnitsToConsolidate).toBeGreaterThan(0);
    expect(cfg.maxBlockUnits).toBeGreaterThan(0);
    expect(cfg.minSplitFraction).toBeGreaterThan(0);
    expect(cfg.minSplitFraction).toBeLessThanOrEqual(1);
  });

  it("rejects zero/negative knobs", () => {
    const base = readConfigJson("config/consolidation.json") as Record<string, unknown>;
    expect(() => parseConsolidationConfigFrom({ ...base, minUnitsToConsolidate: 0 })).toThrow();
    expect(() => parseConsolidationConfigFrom({ ...base, maxBlockUnits: -5 })).toThrow();
    expect(() => parseConsolidationConfigFrom({ ...base, footprintCapM: 0 })).toThrow();
    expect(() => parseConsolidationConfigFrom({ ...base, heightCapM: -1 })).toThrow();
  });

  it("rejects minSplitFraction outside (0, 1]", () => {
    const base = readConfigJson("config/consolidation.json") as Record<string, unknown>;
    expect(() => parseConsolidationConfigFrom({ ...base, minSplitFraction: 1.5 })).toThrow();
    expect(() => parseConsolidationConfigFrom({ ...base, minSplitFraction: 0 })).toThrow();
  });

  it("defaults enabled to true when omitted", () => {
    const base = readConfigJson("config/consolidation.json") as Record<string, unknown>;
    const { enabled, ...rest } = base;
    void enabled;
    const cfg = parseConsolidationConfigFrom(rest);
    expect(cfg.enabled).toBe(true);
  });
});
