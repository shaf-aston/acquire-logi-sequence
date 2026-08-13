/**
 * POST /api/collection-run/quote — plan a hub pickup loop. Thin wrapper: validate the untrusted
 * request shape at the boundary, delegate to planCollectionRun, shape the JSON response. The
 * pickup-count ceiling is enforced downstream by the collection validator (multiStop.maxStops);
 * here we only bound raw sizes so an oversized body can't reach the router.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { planCollectionRun, CollectionRunError } from "@/lib/collection-run/collection-run.service";
import { PricingError } from "@/lib/pricing";
import { RoutingError } from "@/lib/routing";
import { StopChainError } from "@/lib/stop-chain";
import { parseSessionHubs } from "@/lib/groupage/parse";
import { GroupageError, type Hub } from "@/lib/groupage/groupage.types";
import type { CollectionPickupRequest } from "@/types/api";

export const runtime = "nodejs";

const logger = createLogger("api.collection-run.quote");

/** The normalised, validated request — every pickup resolved to the object form. */
interface ParsedCollectionRun {
  hubId: string;
  pickups: CollectionPickupRequest[];
  vanId: string;
  optimize?: boolean;
  sessionHubs: Hub[];
}

/** Trust-boundary parse. Throws CollectionRunError(check "input") → 400 on any bad field. */
function parseBody(body: unknown): ParsedCollectionRun {
  if (typeof body !== "object" || body === null) {
    throw new CollectionRunError("input", "Request body must be an object.");
  }
  const o = body as Record<string, unknown>;
  const text = (v: unknown, name: string, max: number): string => {
    if (typeof v !== "string" || v.trim() === "") {
      throw new CollectionRunError("input", `'${name}' must be a non-empty string.`);
    }
    if (v.trim().length > max) throw new CollectionRunError("input", `'${name}' is too long (max ${max} characters).`);
    return v.trim();
  };
  if (!Array.isArray(o.pickups) || o.pickups.length === 0) {
    throw new CollectionRunError("input", "Add at least one pickup address.");
  }
  if (o.pickups.length > 100) {
    throw new CollectionRunError("input", "Too many pickups in one request (max 100).");
  }
  // A pickup is either a bare address string or an object { address, company? } — the object form
  // carries the company label from a groupage origin. Validate both shapes at the boundary.
  const pickups = o.pickups.map((p, i) => {
    if (typeof p === "string") return { address: text(p, `pickups[${i + 1}]`, 200) };
    if (typeof p !== "object" || p === null) {
      throw new CollectionRunError("input", `'pickups[${i + 1}]' must be an address string or object.`);
    }
    const po = p as Record<string, unknown>;
    const address = text(po.address, `pickups[${i + 1}].address`, 200);
    if (po.company === undefined || po.company === null) return { address };
    return { address, company: text(po.company, `pickups[${i + 1}].company`, 120) };
  });
  let optimize: boolean | undefined;
  if (o.optimize !== undefined && o.optimize !== null) {
    if (typeof o.optimize !== "boolean") throw new CollectionRunError("input", "'optimize' must be true or false.");
    optimize = o.optimize;
  }
  return {
    hubId: text(o.hubId, "hubId", 80),
    pickups,
    vanId: text(o.vanId, "vanId", 80),
    ...(optimize !== undefined ? { optimize } : {}),
    // Manifest hubs carried back for THIS run (validated by the shared groupage parser).
    sessionHubs: parseSessionHubs(o.sessionHubs),
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = parseBody(await request.json());
    const result = await planCollectionRun({
      hubId: input.hubId,
      pickups: input.pickups,
      vanId: input.vanId,
      optimizeOrder: input.optimize,
      sessionHubs: input.sessionHubs,
    });
    return NextResponse.json({
      success: true,
      hub: result.hub,
      orderedStops: result.orderedStops,
      quote: result.quote,
      warnings: result.warnings,
      perf: result.perf,
    });
  } catch (err) {
    if (err instanceof CollectionRunError) {
      // "hub" = fixable state (missing hub/address) → 422 points the operator at Depots & hubs.
      const status = err.check === "hub" ? 422 : 400;
      return NextResponse.json({ success: false, error: err.message }, { status });
    }
    if (err instanceof GroupageError) {
      // A bad sessionHubs overlay from the client — fail loud with the exact field.
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    if (err instanceof StopChainError || err instanceof PricingError || err instanceof RoutingError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: "Request body is not valid JSON." }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("unexpected collection-run error", { error: msg });
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
