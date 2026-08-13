/**
 * Server-side packing diagnostic trace. Thin wrapper over the pure `analyzeVanFill`
 * (van-fill.ts) — this file only adds the logger + the PACKING_DEBUG gate, so it must
 * stay server-only (it imports the config + logger). The client panel imports the
 * pure verdict from van-fill.ts directly.
 */
import { createLogger } from "@/lib/logger/logger";
import { getConfig } from "@/config/env";
import { analyzeVanFill } from "@/lib/packing/van-fill";
import type { Dimensions, Placement } from "@/lib/packing/packing.types";

/** Per-van input for the debug trace (matches what packJob has in scope post-allocate). */
export interface VanDebugRow {
  readonly vanId: string;
  readonly vanLabel: string;
  readonly interior: Dimensions;
  readonly maxPayloadKg: number;
  readonly placements: readonly Placement[];
}

/**
 * Emit the per-van packing diagnostic to the `packing.debug` log — but only when
 * PACKING_DEBUG is on, so production output is byte-identical without the flag.
 * Uses `info` level (not `debug`) so the trace shows regardless of LOG_LEVEL once
 * explicitly enabled.
 */
export function logPackDebug(
  vans: readonly VanDebugRow[],
  ctx: { jobId: string; maxReachHeightM: number | null; unplacedUnits: number },
): void {
  if (!getConfig().observability.packingDebug) return;
  const logger = createLogger("packing.debug").child({ jobId: ctx.jobId });
  const hasUnplacedGlobal = ctx.unplacedUnits > 0;

  logger.info("packing diagnostic — per van", {
    vansUsed: vans.length,
    unplacedUnits: ctx.unplacedUnits,
    maxReachHeightM: ctx.maxReachHeightM,
  });
  vans.forEach((v, i) => {
    const d = analyzeVanFill(v.placements, v.interior, {
      maxReachHeightM: ctx.maxReachHeightM,
      hasUnplacedGlobal,
      maxPayloadKg: v.maxPayloadKg,
    });
    logger.info(`van ${i + 1}: ${v.vanLabel} — ${d.verdict}`, {
      vanId: v.vanId,
      volumeFillPct: Math.round(d.volumeFill * 1000) / 10,
      floorUsedPct: Math.round(d.floorFootprint * 1000) / 10,
      payloadPct: Math.round(d.payloadFraction * 1000) / 10,
      placed: d.placed,
      floored: d.floored,
      stacked: d.stacked,
      headroomM: Math.round(d.headroomM * 100) / 100,
      couldStackLikeForLike: d.couldStackLikeForLike,
      why: d.reason,
    });
  });
}
