/**
 * POST /api/pack/direct — Stage 3 test endpoint.
 * Accepts a pre-assembled Item[] (skipping the PDF/classification pipeline) and
 * runs the packer directly. Supports single-van mode (vanId provided → force one
 * van, overflow reported unplaced) and auto mode (no vanId → cheapest multi-van
 * fleet allocation, mirroring the real /api/pack flow).
 */
import { NextResponse } from "next/server";
import { getConfig } from "@/config/env";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import { FileVanRepository } from "@/lib/packing/van.repository";
import { allocateFleet } from "@/lib/packing/fleet-allocator";
import { PackingError } from "@/lib/packing/packer.service";
import type { Item } from "@/lib/packing/packing.types";

export const runtime = "nodejs";

function countPackableUnits(items: Item[]): number {
  return items.reduce((n, i) => (i.dimensions !== null ? n + Math.max(1, i.quantity) : n), 0);
}

/** True if `v` is a finite, positive number. */
function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Trust-boundary check on a single body item: this endpoint skips the PDF/
 * classification pipeline and casts the body straight to Item[], so a
 * malformed entry (missing id, garbage dimensions, non-integer quantity) must
 * be rejected loudly here rather than silently reaching the packer/allocator.
 */
function validateRawItem(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return "not an object";
  const { id, dimensions, quantity } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0) return "missing or invalid 'id'";
  if (dimensions !== null && dimensions !== undefined) {
    if (typeof dimensions !== "object") return "malformed 'dimensions'";
    const { l, w, h } = dimensions as Record<string, unknown>;
    if (!isPositiveFinite(l) || !isPositiveFinite(w) || !isPositiveFinite(h)) {
      return "'dimensions' must have positive finite l/w/h";
    }
  }
  if (quantity !== undefined && (!Number.isInteger(quantity) || (quantity as number) <= 0)) {
    return "'quantity' must be a positive integer";
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  let body: { items?: unknown; vanId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Request body is not valid JSON." }, { status: 400 });
  }

  if (!Array.isArray(body?.items) || body.items.length === 0) {
    return NextResponse.json({ success: false, error: "Body must include a non-empty 'items' array." }, { status: 400 });
  }

  for (let i = 0; i < body.items.length; i++) {
    const reason = validateRawItem(body.items[i]);
    if (reason) {
      return NextResponse.json(
        { success: false, error: `Malformed item at index ${i}: ${reason}.` },
        { status: 400 },
      );
    }
  }

  const items = body.items as Item[];
  const vanId = typeof body.vanId === "string" ? body.vanId : undefined;

  try {
    const cfg = getConfig().packing;
    const packer = new HeuristicPacker({ toleranceM: cfg.toleranceM, maxReachHeightM: cfg.maxReachHeightM });
    const repo = new FileVanRepository();
    const packableUnits = countPackableUnits(items);
    if (packableUnits > cfg.maxPackableUnits) {
      return NextResponse.json(
        {
          success: false,
          error: `${packableUnits} exceeds the max packable units (${cfg.maxPackableUnits})`,
        },
        { status: 400 },
      );
    }

    if (vanId) {
      const van = await repo.getVan(vanId);
      if (!van) {
        return NextResponse.json({ success: false, error: `Unknown van id "${vanId}".` }, { status: 400 });
      }
      const selected = packer.pack(items, van);
      return NextResponse.json({
        success: true,
        items,
        fleet: [selected],
        selected,
        fitsInSingleVan: selected.unplaced.length === 0,
        unplaced: selected.unplaced,
        reasons: selected.reasons,
        totalPerMileRate: van.perMileRate,
        packableUnits,
        toleranceM: cfg.toleranceM,
        maxReachHeightM: cfg.maxReachHeightM,
      });
    }

    const allVans = await repo.listVans();
    const vans = allVans.slice(0, cfg.maxVansToConsider);
    if (vans.length === 0) {
      return NextResponse.json({ success: false, error: "No vans configured." }, { status: 400 });
    }
    const plan = allocateFleet(items, vans, packer, { toleranceM: cfg.toleranceM });
    // When nothing is placeable (all oversized / dimensionless), still succeed and
    // report the unplaced cargo — fall back to an empty pack so the UI has a van to
    // render. Mirrors packer.service so both endpoints behave consistently.
    const selected = plan.vans[0] ?? packer.pack(items, vans[0]!);

    return NextResponse.json({
      success: true,
      items,
      fleet: plan.vans,
      selected,
      fitsInSingleVan: plan.fitsInSingleVan,
      unplaced: plan.unplaced,
      reasons: plan.reasons,
      totalPerMileRate: plan.totalPerMileRate,
      packableUnits,
      toleranceM: cfg.toleranceM,
    });
  } catch (err) {
    if (err instanceof PackingError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
  }
}
