import { describe, it, expect } from "vitest";
import { ZonedPacker } from "@/lib/packing/zoned-packer";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { makeItem, makeVan } from "./fixtures";

const inner = () => new HeuristicPacker({ toleranceM: 0.005 });

describe("ZonedPacker (drop-order loading)", () => {
  it("lays the earlier stop at the doors (x=0) and later stops deeper", () => {
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1500 });
    const a = makeItem({ id: "a", stopIndex: 0, dimensions: { l: 0.6, w: 0.6, h: 0.7 } });
    const b = makeItem({ id: "b", stopIndex: 1, dimensions: { l: 0.6, w: 0.6, h: 0.7 } });

    const r = new ZonedPacker({ inner: inner() }).pack([a, b], van);

    expect(r.unplaced).toHaveLength(0);
    const pa = r.placements.find((p) => p.itemId === "a")!;
    const pb = r.placements.find((p) => p.itemId === "b")!;
    // Stop 0 (a) at the doors, stop 1 (b) begins beyond a's cab-side edge — no overlap.
    expect(pb.position.x).toBeGreaterThanOrEqual(pa.position.x + pa.size.x - 1e-6);
    for (const p of r.placements) {
      expect(p.position.x + p.size.x).toBeLessThanOrEqual(van.interior.l + 1e-6);
    }
  });

  it("orders bands by stop regardless of item input order", () => {
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1500 });
    // Feed stops out of order: stop 2 first, then 0, then 1.
    const items = [
      makeItem({ id: "s2", stopIndex: 2, dimensions: { l: 0.6, w: 0.6, h: 0.7 } }),
      makeItem({ id: "s0", stopIndex: 0, dimensions: { l: 0.6, w: 0.6, h: 0.7 } }),
      makeItem({ id: "s1", stopIndex: 1, dimensions: { l: 0.6, w: 0.6, h: 0.7 } }),
    ];
    const r = new ZonedPacker({ inner: inner() }).pack(items, van);
    const x = (id: string) => r.placements.find((p) => p.itemId === id)!.position.x;
    expect(x("s0")).toBeLessThan(x("s1"));
    expect(x("s1")).toBeLessThan(x("s2"));
  });

  it("packs an untagged item deepest (last band) instead of dropping it", () => {
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 1500 });
    const tagged = makeItem({ id: "t", stopIndex: 0, dimensions: { l: 0.6, w: 0.6, h: 0.7 } });
    const untagged = makeItem({ id: "u", dimensions: { l: 0.6, w: 0.6, h: 0.7 } }); // no stopIndex

    const r = new ZonedPacker({ inner: inner() }).pack([tagged, untagged], van);

    // Untagged is placed, not surfaced as unplaced — and sits behind the tagged stop.
    expect(r.unplaced).toHaveLength(0);
    const pt = r.placements.find((p) => p.itemId === "t")!;
    const pu = r.placements.find((p) => p.itemId === "u")!;
    expect(pu.position.x).toBeGreaterThanOrEqual(pt.position.x + pt.size.x - 1e-6);
  });

  it("with no stops set, behaves like the inner packer (single band from the doors)", () => {
    const van = makeVan();
    const items = [makeItem({ id: "a" }), makeItem({ id: "b" }), makeItem({ id: "c" })];
    const zoned = new ZonedPacker({ inner: inner() }).pack(items, van);
    const plain = inner().pack(items, van);
    expect(zoned.placements.map((p) => p.itemId).sort()).toEqual(plain.placements.map((p) => p.itemId).sort());
    expect(zoned.unplaced).toHaveLength(0);
  });

  it("surfaces overflow as unplaced (never crushes a band to honour drop-order)", () => {
    // A van long enough for exactly one 0.6 m band: stop 0 fills it, stop 1 overflows.
    const shortVan = makeVan({ interior: { l: 0.62, w: 1.8, h: 1.9 }, maxPayloadKg: 1500 });
    const a = makeItem({ id: "a", stopIndex: 0, dimensions: { l: 0.6, w: 0.6, h: 0.7 } });
    const b = makeItem({ id: "b", stopIndex: 1, dimensions: { l: 0.6, w: 0.6, h: 0.7 } });

    const r = new ZonedPacker({ inner: inner() }).pack([a, b], shortVan);
    expect(r.placements.map((p) => p.itemId)).toEqual(["a"]);
    expect(r.unplaced.map((i) => i.id)).toContain("b");
  });

  it("threads the payload budget across bands (whole-van limit, not per-band)", () => {
    const van = makeVan({ interior: { l: 3.0, w: 1.8, h: 1.9 }, maxPayloadKg: 50 });
    const h1 = makeItem({ id: "h1", stopIndex: 0, weightKg: 40, dimensions: { l: 0.6, w: 0.6, h: 0.7 } });
    const h2 = makeItem({ id: "h2", stopIndex: 1, weightKg: 40, dimensions: { l: 0.6, w: 0.6, h: 0.7 } });

    const r = new ZonedPacker({ inner: inner() }).pack([h1, h2], van);
    expect(r.placements).toHaveLength(1);
    expect(r.unplaced.map((i) => i.id)).toContain("h2");
  });
});
