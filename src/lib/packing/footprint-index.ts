/**
 * Uniform-grid spatial index over placed boxes' x/y footprints — the acceleration
 * behind the packer's hot loop. The validator asks the same geometric question
 * thousands of times while filling a van ("which placed boxes could this candidate
 * overlap or rest on?"), and answering it by scanning EVERY placed box is the
 * O(N²) cost that made large orders crawl. This bins each box into the grid cells
 * its footprint covers, so a query visits only the handful of boxes near the
 * region asked about.
 *
 * Correctness contract (this is why the golden-master stays byte-identical):
 *   1. SUPERSET — a query returns every box whose footprint could overlap `rect`
 *      (two footprints that overlap in continuous x/y always share a grid cell),
 *      plus possibly some that don't. The caller re-applies the exact overlap test,
 *      so false positives change nothing.
 *   2. INSERTION ORDER — results come back in the order boxes were placed, matching
 *      a plain array scan. Support checks SUM per-box loads, and floating-point
 *      addition isn't associative, so identical order guarantees an identical total
 *      (and thus an identical accept/reject verdict) down to the last bit.
 *
 * Only x/y is indexed: every question the validator asks (overlap, bearers at a
 * level, weight resting on a bearer, the support column) requires footprint
 * overlap first, so a footprint filter is sufficient and z is checked afterwards.
 */
import type { Placement } from "@/lib/packing/packing.types";

/** An axis-aligned x/y footprint to query for — structurally the validator's Rect. */
export interface FootprintRect {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/**
 * Neighbour lookup: all placed boxes whose footprint may overlap `rect`, in
 * insertion order. The packer passes an index-backed one; absent it, the validator
 * falls back to scanning the full list (identical result, no speed-up).
 */
export type NeighborQuery = (rect: FootprintRect) => readonly Placement[];

/** Default cell edge (m). Perf-only knob — larger = fewer cells but more boxes per query. */
const DEFAULT_CELL_M = 0.5;

interface Entry {
  readonly p: Placement;
  /** Placement order — restored on query so summed loads match an array scan bit-for-bit. */
  readonly idx: number;
}

export class FootprintIndex {
  private readonly cell: number;
  private readonly grid = new Map<string, Entry[]>();
  private count = 0;

  constructor(cellM: number = DEFAULT_CELL_M) {
    // Guard against a non-positive cell (would divide-by-zero the bucket maths).
    this.cell = cellM > 0 ? cellM : DEFAULT_CELL_M;
  }

  /** Register a placement under every grid cell its footprint covers. */
  insert(p: Placement): void {
    const entry: Entry = { p, idx: this.count++ };
    const cx0 = this.cellOf(p.position.x);
    const cy0 = this.cellOf(p.position.y);
    const cx1 = this.cellOf(p.position.x + p.size.x);
    const cy1 = this.cellOf(p.position.y + p.size.y);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = key(cx, cy);
        const bucket = this.grid.get(k);
        if (bucket) bucket.push(entry);
        else this.grid.set(k, [entry]);
      }
    }
  }

  /**
   * All placements whose footprint may overlap `rect`, in insertion order. Bound as
   * a field so it can be handed to the validator directly as a `NeighborQuery`.
   */
  readonly query: NeighborQuery = (rect) => {
    const cx0 = this.cellOf(rect.x0);
    const cy0 = this.cellOf(rect.y0);
    const cx1 = this.cellOf(rect.x1);
    const cy1 = this.cellOf(rect.y1);
    // A box spans several cells, so dedupe by placement index, then restore order.
    const seen = new Set<number>();
    const hits: Entry[] = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = this.grid.get(key(cx, cy));
        if (!bucket) continue;
        for (const e of bucket) {
          if (seen.has(e.idx)) continue;
          seen.add(e.idx);
          hits.push(e);
        }
      }
    }
    hits.sort((a, b) => a.idx - b.idx);
    return hits.map((e) => e.p);
  };

  private cellOf(coord: number): number {
    return Math.floor(coord / this.cell);
  }
}

function key(cx: number, cy: number): string {
  return cx + ":" + cy;
}
