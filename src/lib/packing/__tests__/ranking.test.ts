/** S3.8 — van ranking: fits-first, then tightest pack; partials by units placed. */
import { describe, it, expect } from "vitest";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { rankVans, compareRankings, type VanRanking } from "@/lib/packing/packer.service";
import { makeItem, makeVan } from "./fixtures";

const packer = new HeuristicPacker({ toleranceM: 0.005 });

describe("rankVans", () => {
  it("prefers a van that fits the whole job over one that doesn't", () => {
    const items = Array.from({ length: 10 }, (_, i) => makeItem({ id: `b${i}`, weightKg: 20 }));
    const packable = items.length;
    const small = makeVan({ id: "small", interior: { l: 0.7, w: 0.7, h: 0.8 }, maxPayloadKg: 1000 });
    const big = makeVan({ id: "big", interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1000 });

    const ranking = rankVans(items, [small, big], packable, packer);
    expect(ranking[0]!.vanId).toBe("big");
    expect(ranking[0]!.fits).toBe(true);
    expect(ranking[1]!.fits).toBe(false);
  });

  it("when nothing fits, surfaces the best-effort van by units placed", () => {
    const items = Array.from({ length: 20 }, (_, i) => makeItem({ id: `b${i}`, weightKg: 20 }));
    const tiny = makeVan({ id: "tiny", interior: { l: 0.7, w: 0.7, h: 0.8 }, maxPayloadKg: 1000 });
    const mid = makeVan({ id: "mid", interior: { l: 1.4, w: 0.7, h: 0.8 }, maxPayloadKg: 1000 });

    const ranking = rankVans(items, [tiny, mid], items.length, packer);
    expect(ranking.every((r) => !r.fits)).toBe(true);
    expect(ranking[0]!.placedUnits).toBeGreaterThanOrEqual(ranking[1]!.placedUnits);
  });
});

describe("compareRankings", () => {
  const base = (o: Partial<VanRanking>): VanRanking => ({
    vanId: "v", label: "V", utilization: 0.5, fits: false, placedUnits: 0, packableUnits: 10,
    result: { van: makeVan(), placements: [], utilization: 0.5, unplaced: [], reasons: {} },
    ...o,
  });

  it("orders fits before non-fits, then higher utilization", () => {
    const fitLow = base({ fits: true, utilization: 0.6 });
    const fitHigh = base({ fits: true, utilization: 0.9 });
    const noFit = base({ fits: false, utilization: 0.99 });
    const sorted = [noFit, fitLow, fitHigh].sort(compareRankings);
    expect(sorted.map((r) => r.utilization)).toEqual([0.9, 0.6, 0.99]);
  });
});
