/**
 * Pure coordinate-mapping helpers between van-space metres (our source data —
 * config, packer, placements) and Three.js scene units. No React/Three imports
 * beyond plain type aliases below — safe to reuse anywhere (e.g. a future static
 * export/report) without pulling in the 3D viewer.
 */
import type { Placement, Vec3, VanDimensions } from "@/types/api";

// Three.js works in metres and so does our source data (config, packer, placements
// are all metres) — the mapping is 1:1. `mm`/`MM_TO_M` are kept as the scene-scale
// seam in case a future unit ever needs converting; today they are an identity.
const MM_TO_M = 1;
export function mm(v: number) { return v * MM_TO_M; }

/* ── Coordinate mapping (van mm ⇄ three.js metres, centred on the van) ─────── */

export interface Frame { vanW: number; vanD: number; vanH: number; }

export function frameFor(interior: VanDimensions): Frame {
  return { vanW: mm(interior.l), vanD: mm(interior.w), vanH: mm(interior.h) };
}

/** Three.js box edge lengths for a placement (van y maps to depth, van z to up). */
export function threeSize(size: Vec3) {
  return { sx: mm(size.x), sy: mm(size.z), sz: mm(size.y) };
}

/** Centre of a placement in three.js world space. */
export function threeCenter(p: Pick<Placement, "position" | "size">, f: Frame): [number, number, number] {
  const { sx, sy, sz } = threeSize(p.size);
  return [
    mm(p.position.x) + sx / 2 - f.vanW / 2,
    mm(p.position.z) + sy / 2 - f.vanH / 2,
    mm(p.position.y) + sz / 2 - f.vanD / 2,
  ];
}

/**
 * Invert the floor-plane mapping: a world (x,z) hit → van (x,y) origin.
 * `snapStepM` quantises the result so a dragged box follows the cursor in fine
 * steps instead of jumping a whole metre at a time (the old `Math.round(…)`
 * rounded to 1 m). The step is a config knob (van-3d-scene.json `dragSnapStepM`)
 * passed by the caller — the geometry lib stays free of config/React imports.
 * Kept small so the fine snap never fights `resolveDrop`'s support-extent snap.
 */
export function worldToVanXY(
  worldX: number,
  worldZ: number,
  size: Vec3,
  f: Frame,
  snapStepM = 0.05,
): { x: number; y: number } {
  const { sx, sz } = threeSize(size);
  const snap = (v: number) => (snapStepM > 0 ? Math.round(v / snapStepM) * snapStepM : v);
  return {
    x: snap(worldX + f.vanW / 2 - sx / 2),
    y: snap(worldZ + f.vanD / 2 - sz / 2),
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
