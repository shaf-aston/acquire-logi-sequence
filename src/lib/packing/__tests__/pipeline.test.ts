/**
 * End-to-end pipeline integration test — exercises the full Stage 1→5 chain
 * using pure in-process calls (no network, no PDF OCR) so this runs offline.
 *
 * The fixture represents a simple two-item quotation in the Titan/Apex format
 * (cm units, derived depth). Asserts on the shape of every stage's output to
 * prove the stages are wired together correctly — not just that each one exists.
 */
import { describe, it, expect } from "vitest";
import { parseStackabilityFrom } from "@/lib/packing/stackability";
import { parseColumnMapFrom } from "@/lib/packing/column-map";
import { assembleItems } from "@/lib/packing/item-assembler";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { allocateFleet } from "@/lib/packing/fleet-allocator";
import { parseVansFrom } from "@/lib/packing/van.repository";
import { calculateQuote } from "@/lib/pricing/calculator";
import { readConfigJson } from "./fixtures";

// ── Shared test fixtures ──────────────────────────────────────────────────────

const COLUMN_MAP_JSON = readConfigJson("config/column-map.json");
const STACKABILITY_JSON = readConfigJson("config/stackability.json");
const VANS_JSON = readConfigJson("config/vans.json");

/** A minimal StructuredDocument matching the Titan/Apex industrial format. */
const TWO_ITEM_DOC = {
  pageCount: 1,
  tableCount: 1,
  pages: [
    {
      index: 0,
      markdown: "",
      tables: [
        {
          index: 0,
          headers: ["Item #", "Item Description", "Material", "Height (cm)", "Width (cm)", "Weight (kg)"],
          rows: [
            ["1", "Steel Angle Bar", "Structural Steel", "40", "120", "85"],
            ["2", "Polycarbonate Roof Sheet", "Polycarbonate", "30", "200", "18"],
          ],
        },
      ],
    },
  ],
};

/** Classification output matching the two-item doc. */
const TWO_ITEM_CLASSIFICATION = {
  items: [
    { pageIndex: 0, tableIndex: 0, rowIndex: 0, label: "Steel Angle Bar", fragility: "standard", confident: true, matchedTerm: null, reason: "standard" },
    { pageIndex: 0, tableIndex: 0, rowIndex: 1, label: "Polycarbonate Roof Sheet", fragility: "standard", confident: true, matchedTerm: null, reason: "standard" },
  ],
  counts: { fragile: 0, standard: 2, lowConfidence: 0 },
};

// ── Stage 1→3: assemble items from document + classification ─────────────────

describe("pipeline: Stage 1→3 item assembly", () => {
  it("assembles two rows into packable items with non-null dimensions", async () => {
    const columnMap = parseColumnMapFrom(COLUMN_MAP_JSON);
    const matrix = parseStackabilityFrom(STACKABILITY_JSON);

    const items = await assembleItems({
      doc: TWO_ITEM_DOC as never,
      classification: TWO_ITEM_CLASSIFICATION as never,
      columnMap,
      matrix,
    });

    expect(items).toHaveLength(2);
    const item0 = items[0]!;
    const item1 = items[1]!;
    expect(item0.dimensions).not.toBeNull();
    expect(item1.dimensions).not.toBeNull();

    // cm→m scaling: height 40cm → 0.4m, width (l) 120cm → 1.2m
    expect(item0.dimensions!.l).toBe(1.2);
    expect(item0.dimensions!.h).toBe(0.4);
    expect(item0.weightKg).toBe(85);

    // Category from pattern: "Polycarbonate" → glass-panel
    expect(item1.category).toBe("glass-panel");
  });
});

// ── Stage 3: heuristic packer ─────────────────────────────────────────────────

describe("pipeline: Stage 3 heuristic packing", () => {
  it("places both items in a large van without overlap", async () => {
    const columnMap = parseColumnMapFrom(COLUMN_MAP_JSON);
    const matrix = parseStackabilityFrom(STACKABILITY_JSON);
    const items = await assembleItems({
      doc: TWO_ITEM_DOC as never,
      classification: TWO_ITEM_CLASSIFICATION as never,
      columnMap,
      matrix,
    });

    const van = { id: "test", label: "Test Van", interior: { l: 6.0, w: 2.4, h: 2.4 }, maxPayloadKg: 5000, perMileRate: 2.5 };
    const packer = new HeuristicPacker({ toleranceM: 0.005 });
    const result = packer.pack(items, van);

    expect(result.placements).toHaveLength(2);
    expect(result.unplaced).toHaveLength(0);
    // No two placements overlap
    const a = result.placements[0]!;
    const b = result.placements[1]!;
    const overlapOnAxis = (aMin: number, aMax: number, bMin: number, bMax: number) =>
      aMin < bMax && bMin < aMax;
    const overlapX = overlapOnAxis(a.position.x, a.position.x + a.size.x, b.position.x, b.position.x + b.size.x);
    const overlapY = overlapOnAxis(a.position.y, a.position.y + a.size.y, b.position.y, b.position.y + b.size.y);
    const overlapZ = overlapOnAxis(a.position.z, a.position.z + a.size.z, b.position.z, b.position.z + b.size.z);
    expect(overlapX && overlapY && overlapZ).toBe(false);
  });
});

// ── Stage 3.5: fleet allocation ───────────────────────────────────────────────

describe("pipeline: Stage 3.5 fleet allocation", () => {
  it("selects a single van for a small job and reports no unplaced items", async () => {
    const columnMap = parseColumnMapFrom(COLUMN_MAP_JSON);
    const matrix = parseStackabilityFrom(STACKABILITY_JSON);
    const items = await assembleItems({
      doc: TWO_ITEM_DOC as never,
      classification: TWO_ITEM_CLASSIFICATION as never,
      columnMap,
      matrix,
    });

    const vans = parseVansFrom(VANS_JSON);
    const packer = new HeuristicPacker({ toleranceM: 0.005 });
    const plan = allocateFleet(items, vans, packer, { toleranceM: 0.005 });

    expect(plan.unplaced).toHaveLength(0);
    expect(plan.vans.length).toBeGreaterThanOrEqual(1);
    expect(plan.placedUnits).toBe(2);
    expect(plan.fitsInSingleVan).toBe(true);
    expect(plan.totalPerMileRate).toBeGreaterThan(0);
  });
});

// ── Stage 5: pricing ──────────────────────────────────────────────────────────

describe("pipeline: Stage 5 pricing", () => {
  it("produces a quote with a positive total from distance × rate + surcharges", () => {
    const vans = parseVansFrom(VANS_JSON);
    const smallVan = vans.find((v) => v.id === "small-panel") ?? vans[0]!;

    const quote = calculateQuote(
      { origin: "London, UK", destination: "Birmingham, UK", distanceMiles: 120, durationSeconds: 5400, distanceMethod: "road", legs: [] },
      [smallVan],
      0,
      5,
      "£",
    );

    expect(quote.total).toBeGreaterThan(0);
    expect(quote.route.distanceMiles).toBe(120);
    expect(quote.vans).toHaveLength(1);
    expect(quote.vans[0]!.id).toBe(smallVan.id);
  });

  it("adds a fragility surcharge when fragile items are present", () => {
    const vans = parseVansFrom(VANS_JSON);
    const van = vans[0]!;

    const base = calculateQuote(
      { origin: "A", destination: "B", distanceMiles: 100, durationSeconds: 3600, distanceMethod: "road", legs: [] },
      [van],
      0,
      5,
      "£",
    );
    const withFragile = calculateQuote(
      { origin: "A", destination: "B", distanceMiles: 100, durationSeconds: 3600, distanceMethod: "road", legs: [] },
      [van],
      3,
      5,
      "£",
    );

    expect(withFragile.total - base.total).toBeCloseTo(15, 2);
  });
});

// ── Full chain: Stage 1→5 wired end-to-end ───────────────────────────────────

describe("pipeline: full Stage 1→5 chain", () => {
  it("produces a positive-total quote from a raw document + classification", async () => {
    const columnMap = parseColumnMapFrom(COLUMN_MAP_JSON);
    const matrix = parseStackabilityFrom(STACKABILITY_JSON);
    const vans = parseVansFrom(VANS_JSON);
    const packer = new HeuristicPacker({ toleranceM: 0.005 });

    const items = await assembleItems({
      doc: TWO_ITEM_DOC as never,
      classification: TWO_ITEM_CLASSIFICATION as never,
      columnMap,
      matrix,
    });

    const plan = allocateFleet(items, vans, packer, { toleranceM: 0.005 });
    expect(plan.placedUnits).toBeGreaterThan(0);

    const vanList = plan.vans.map((r) => ({
      van: r.van,
      payloadKg: r.placements.reduce((s, p) => s + p.weightKg, 0),
    }));

    const fragileCount = plan.vans.reduce((n, r) => n + r.placements.filter((p) => p.fragile).length, 0);
    const quote = calculateQuote(
      { origin: "London, UK", destination: "Manchester, UK", distanceMiles: 212, durationSeconds: 14400, distanceMethod: "road", legs: [] },
      vanList.map((v) => v.van),
      fragileCount,
      5,
      "£",
      vanList.map((v) => v.payloadKg),
    );

    expect(quote.total).toBeGreaterThan(0);
    expect(quote.route.origin).toBe("London, UK");
    expect(quote.vans.length).toBe(plan.vans.length);
    expect(plan.unplaced).toHaveLength(0);
  });
});
