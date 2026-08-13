/**
 * Thin HTTP wrapper over the packing service. No business logic — it validates
 * the request shape, delegates to packJob, and shapes the JSON response. Body is
 * the ingest endpoint's output: { document, classification, vanId? }.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { packJob, PackingError } from "@/lib/packing/packer.service";
import { parseVansFrom } from "@/lib/packing/van.repository";
import { getConfig } from "@/config/env";
import type { StructuredDocument } from "@/lib/conversion/types";
import type { ClassificationResult } from "@/lib/classification/types";
import type { DurabilityOverride } from "@/lib/classification/durability.types";
import type { Van } from "@/lib/packing/packing.types";

export const runtime = "nodejs";

const logger = createLogger("api.pack");

const DURABILITY_TIERS = new Set(["none", "low", "medium", "high"]);
const ORIENTATION_LOCKS = new Set(["fixed", "partial", "none"]);

/**
 * Validate and convert the optional per-row durability corrections from the JSON
 * body into a typed Map. Trust-boundary check: every entry must carry a valid
 * enum tier, boolean brittle, and valid orientation — a malformed correction is
 * rejected loudly (never silently coerced into bad safety facts for the packer).
 * Throws PackingError (→ 400) on any bad entry; returns undefined when absent.
 */
function parseDurabilityOverrides(raw: unknown): ReadonlyMap<string, DurabilityOverride> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PackingError("Malformed 'durabilityOverrides' — expected an object keyed by row id.");
  }
  const map = new Map<string, DurabilityOverride>();
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new PackingError(`Malformed durability correction for row "${id}".`);
    }
    const { durabilityTier, brittle, orientationLock } = value as Record<string, unknown>;
    if (typeof durabilityTier !== "string" || !DURABILITY_TIERS.has(durabilityTier)) {
      throw new PackingError(`Invalid durabilityTier for row "${id}".`);
    }
    if (typeof brittle !== "boolean") {
      throw new PackingError(`Invalid brittle flag for row "${id}".`);
    }
    if (typeof orientationLock !== "string" || !ORIENTATION_LOCKS.has(orientationLock)) {
      throw new PackingError(`Invalid orientationLock for row "${id}".`);
    }
    map.set(id, {
      durabilityTier: durabilityTier as DurabilityOverride["durabilityTier"],
      brittle,
      orientationLock: orientationLock as DurabilityOverride["orientationLock"],
    });
  }
  return map.size > 0 ? map : undefined;
}

/**
 * Validate and convert the optional client-supplied fleet override (the session
 * "Fleet setup" catalogue) into a typed Van[]. Trust-boundary check: reuses the
 * same validation `parseVansFrom` applies to config/vans.json — a malformed
 * override is rejected loudly rather than silently packed against garbage vans.
 * Throws PackingError (→ 400) on any bad entry; returns undefined when absent.
 */
function parseVansOverride(raw: unknown): Van[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PackingError("Malformed 'vans' override — expected a non-empty array.");
  }
  // Reject an oversized override before the per-element validation loop runs —
  // mirrors the maxPackableUnits guard in packer.service.ts, which rejects an
  // oversized item list up front rather than doing the bulk parse work first.
  const { maxVansToConsider } = getConfig().packing;
  if (raw.length > maxVansToConsider) {
    throw new PackingError(
      `Malformed 'vans' override — ${raw.length} vans supplied, more than the ${maxVansToConsider} we accept in one request.`,
    );
  }
  try {
    // Collapse duplicate ids: this override is a definition catalogue looked up by id, so a
    // fleet with two identical vans repeats the same definition rather than being malformed.
    return parseVansFrom({ vans: raw }, { collapseDuplicateIds: true });
  } catch (err) {
    throw new PackingError(`Malformed vans override - ${err instanceof Error ? err.message : String(err)}`);
  }
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}`;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  try {
    const body = (await request.json()) as {
      document?: StructuredDocument;
      classification?: ClassificationResult;
      vanId?: string;
      durabilityOverrides?: unknown;
      vans?: unknown;
      respectReachLimit?: unknown;
    };

    if (!body?.document || !Array.isArray(body.document.pages)) {
      return NextResponse.json(
        { success: false, requestId, error: "Missing or malformed 'document'." },
        { status: 400 },
      );
    }
    if (!body?.classification || !Array.isArray(body.classification.items)) {
      return NextResponse.json(
        { success: false, requestId, error: "Missing or malformed 'classification'." },
        { status: 400 },
      );
    }

    const durabilityOverrides = parseDurabilityOverrides(body.durabilityOverrides);
    const vans = parseVansOverride(body.vans);
    // Trust-boundary check: only an explicit `false` disables the reach limit —
    // anything else (missing, true, a stray string) keeps the safety default on.
    const respectReachLimit = body.respectReachLimit === false ? false : undefined;

    const result = await packJob({
      doc: body.document,
      classification: body.classification,
      vanId: body.vanId,
      durabilityOverrides,
      vans,
      respectReachLimit,
      requestId,
    });

    return NextResponse.json({ success: true, requestId, ...result });
  } catch (err) {
    if (err instanceof PackingError) {
      return NextResponse.json({ success: false, requestId, error: err.message }, { status: 400 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { success: false, requestId, error: "Request body is not valid JSON." },
        { status: 400 },
      );
    }
    logger.error("unexpected packing error", { requestId, error: String(err) });
    return NextResponse.json(
      { success: false, requestId, error: "Internal error." },
      { status: 500 },
    );
  }
}
