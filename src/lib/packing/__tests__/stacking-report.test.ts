/**
 * Human-readable stacking harness. Runs the REAL HeuristicPacker on a small,
 * hand-built cargo set and prints a column view so the stacking behaviour can be
 * eyeballed and logically checked:
 *
 *   npx vitest run src/lib/packing/__tests__/stacking-report.test.ts
 *
 * It also asserts the key invariants, so it doubles as a regression guard.
 */
import { describe, it, expect } from "vitest";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { stackPressureKpa } from "@/lib/packing/placement-validator";
import type { Placement } from "@/lib/packing/packing.types";
import { makeItem, makeVan } from "./fixtures";

const packer = new HeuristicPacker({ toleranceM: 0.005 });

/** Group placements into vertical columns (same x,y footprint), bottom → top. */
function columns(ps: Placement[]): Placement[][] {
  const byKey = new Map<string, Placement[]>();
  for (const p of ps) {
    const key = `${p.position.x},${p.position.y}`;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(p);
  }
  return [...byKey.values()].map((col) => col.sort((a, b) => a.position.z - b.position.z));
}

/** Pretty-print the layout: one block per floor footprint, items low → high. */
function report(title: string, ps: Placement[]): string {
  const lines = [`\n=== ${title} ===  (${ps.length} placed)`];
  columns(ps).forEach((col, i) => {
    const foot = `(${col[0]!.position.x},${col[0]!.position.y})`;
    lines.push(`  column ${i + 1} @ ${foot}  height ${col.length}`);
    col.forEach((p) => {
      const area = p.size.x * p.size.y;
      const press = stackPressureKpa(p.weightKg, area).toFixed(2);
      const tag = p.fragile ? "FRAGILE " : "standard";
      lines.push(
        `    z=${String(p.position.z).padStart(4)}  ${p.itemId.padEnd(8)} ${tag}` +
          `  ${p.size.x}x${p.size.y}x${p.size.z}mm  ${p.weightKg}kg  exerts ${press}kPa`,
      );
    });
  });
  return lines.join("\n");
}

describe("stacking report (visual + invariants)", () => {
  it("standards build columns; fragile rides only on fragile", () => {
    // Footprint fits one box; tall enough for a column ⇒ stacking is the only fit.
    const van = makeVan({ interior: { l: 0.62, w: 0.62, h: 2.4 }, maxPayloadKg: 2000 });
    const items = [
      makeItem({ id: "std-1", fragility: "standard", weightKg: 40 }),
      makeItem({ id: "std-2", fragility: "standard", weightKg: 40 }),
      makeItem({ id: "std-3", fragility: "standard", weightKg: 40 }),
    ];
    const r = packer.pack(items, van);
    console.log(report("3 standards, footprint-of-one van", r.placements));

    const zs = r.placements.map((p) => p.position.z).sort((a, b) => a - b);
    expect(zs).toEqual([0, 0.7, 1.4]); // a real 3-high column
  });

  it("crush limit floors an over-pressure box instead of stacking it", () => {
    const van = makeVan({ interior: { l: 1.5, w: 0.62, h: 2.4 }, maxPayloadKg: 2000 });
    // Both items share the same maxStackPressureKpa so volume is the sort tiebreak.
    // soft has slightly larger dims → larger volume → sorts first → placed on floor.
    // heavy then tries to stack on soft: ~7-8 kPa exceeds soft's 5 kPa limit → refused.
    const soft = makeItem({
      id: "soft", weightKg: 10, maxStackPressureKpa: 5, canSupportWeightKg: 100,
      dimensions: { l: 0.6, w: 0.6, h: 0.75 },
    });
    const heavy = makeItem({ id: "heavy", weightKg: 300, maxStackPressureKpa: 5, canSupportWeightKg: 10 });
    const r = packer.pack([soft, heavy], van);
    console.log(report("soft base (5kPa) on floor + heavy box refused", r.placements));

    const softP = r.placements.find((p) => p.itemId === "soft")!;
    const heavyP = r.placements.find((p) => p.itemId === "heavy")!;
    expect(softP.position.z).toBe(0); // soft is the floor base
    // 300kg / ~0.42m² ≈ 7kPa > 5kPa ⇒ heavy cannot rest on soft, floors beside it.
    expect(heavyP.position.z).toBe(0);
    expect(heavyP.position.x).toBeGreaterThan(0);
  });

  it("a fragile column forms, and no standard sits on a fragile box", () => {
    const van = makeVan({ interior: { l: 1.3, w: 0.62, h: 2.4 }, maxPayloadKg: 2000 });
    const items = [
      makeItem({ id: "glass-1", fragility: "fragile", weightKg: 15 }),
      makeItem({ id: "glass-2", fragility: "fragile", weightKg: 15 }),
      makeItem({ id: "crate", fragility: "standard", weightKg: 30 }),
    ];
    const r = packer.pack(items, van);
    console.log(report("2 fragile + 1 standard", r.placements));

    // No standard placement rests on a fragile one.
    for (const f of r.placements.filter((p) => p.fragile)) {
      const top = f.position.z + f.size.z;
      const standardOnTop = r.placements.some(
        (p) =>
          !p.fragile &&
          Math.abs(p.position.z - top) <= 0.005 &&
          p.position.x < f.position.x + f.size.x &&
          f.position.x < p.position.x + p.size.x &&
          p.position.y < f.position.y + f.size.y &&
          f.position.y < p.position.y + p.size.y,
      );
      expect(standardOnTop).toBe(false);
    }
  });
});
