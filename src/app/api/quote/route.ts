/**
 * Thin HTTP wrapper over the pricing service. No business logic — validates the
 * request shape, delegates to getQuote, shapes the JSON response.
 * Body: { vanIds: string[], origin, destination, fragileCount }
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { getQuote, PricingError, type RateOverrides } from "@/lib/pricing";
import { RoutingError } from "@/lib/routing";
import { QuoteHistoryStore, type QuoteHistoryMeta } from "@/lib/storage/quote-history.store";
import { parseVansFrom } from "@/lib/packing/van.repository";
import type { Van } from "@/lib/packing/packing.types";
import { getChainQuote } from "@/lib/stop-chain/service";
import { StopChainError, type Stop } from "@/lib/stop-chain/stop.types";

export const runtime = "nodejs";

const logger = createLogger("api.quote");
const history = new QuoteHistoryStore();

/**
 * Validate and convert the optional client-supplied fleet override (the session
 * "Fleet setup" catalogue, or the exact vans the packer just chose) into a typed
 * Van[]. Trust-boundary check: mirrors parseVansOverride in api/pack/route.ts so
 * both endpoints get the same validation on the same untrusted shape. Throws
 * PricingError (→ 400) on any bad entry; returns undefined when absent.
 */
function parseVansOverride(raw: unknown): Van[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PricingError("Malformed 'vans' override — expected a non-empty array.");
  }
  try {
    // Collapse duplicate ids: this override is a definition catalogue looked up by id, and a
    // fleet with two identical vans repeats the same definition — the count lives in `vanIds`.
    return parseVansFrom({ vans: raw }, { collapseDuplicateIds: true });
  } catch (err) {
    throw new PricingError(`Malformed vans override - ${err instanceof Error ? err.message : String(err)}`);
  }
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}`;
}

/** Parse + validate the untrusted multi-stop chain request shape. Throws PricingError (→400) on bad input. */
function parseChainRequest(body: Record<string, unknown>) {
  const rawStops = body.stops;
  if (!Array.isArray(rawStops) || rawStops.length === 0) {
    throw new PricingError("Missing or empty 'stops'.");
  }
  const stops: Stop[] = rawStops.map((s, i) => {
    const stop = s as { address?: unknown; kind?: unknown };
    if (typeof stop?.address !== "string" || (stop.kind !== "pickup" && stop.kind !== "drop")) {
      throw new PricingError(`Stop ${i + 1} is malformed — needs an 'address' and 'kind' of pickup|drop.`);
    }
    return { address: stop.address, kind: stop.kind };
  });

  // The whole fleet (already packed by /api/pack) drives the same route — mirror the single-drop
  // fleet contract: van ids + aligned per-van payloads for fuel, plus a fragile tally.
  const vanIds = Array.isArray(body.vanIds)
    ? body.vanIds.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
    : [];
  if (vanIds.length === 0) {
    throw new PricingError("Missing or empty 'vanIds' — the multi-stop quote prices the whole fleet.");
  }

  const rawPayloads = Array.isArray(body.vanPayloads)
    ? (body.vanPayloads as unknown[]).filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
      )
    : undefined;
  const vanPayloads = rawPayloads?.length === vanIds.length ? rawPayloads : undefined;

  const fragileCount = body.fragileCount ?? 0;
  if (typeof fragileCount !== "number" || !Number.isFinite(fragileCount) || fragileCount < 0) {
    throw new PricingError("'fragileCount' must be a non-negative number.");
  }

  // Optional pinned final destination the run ends at (a depot, or a specific place). Absent ⇒ the
  // last drop is the endpoint. Blank/whitespace is treated as absent.
  const finalDestination =
    typeof body.finalDestination === "string" && body.finalDestination.trim() !== ""
      ? body.finalDestination.trim()
      : undefined;

  return {
    stops,
    vanIds,
    vanPayloads,
    fragileCount,
    finalDestination,
    viaHub: parseViaHub(body.viaHub),
    vans: parseVansOverride(body.vans),
    // Opt-in only; a non-boolean is rejected loudly rather than silently coerced.
    optimizeWaypointOrder: parseOptimizeFlag(body.optimize),
    rateOverrides: parseRateOverrides(body.rateOverrides),
  };
}

/** Optional hub address to route through (cross-dock). Blank/whitespace ⇒ absent (direct). */
function parseViaHub(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/** Validate the optional per-request "let the router pick the order" flag. */
function parseOptimizeFlag(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") throw new PricingError("'optimize' must be true or false.");
  return raw;
}

/**
 * Validate the optional "Quote settings" rate overrides at the trust boundary. Each field is
 * optional (undefined ⇒ use the config default downstream). Every supplied value must be a
 * finite number; rates/times must be ≥ 0 and returnFactor > 0 (0 would zero-out the drive).
 * Fails loud (→400) on any bad field rather than silently clamping. Returns undefined when empty.
 */
function parseRateOverrides(raw: unknown): RateOverrides | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PricingError("Malformed 'rateOverrides' — expected an object.");
  }
  const src = raw as Record<string, unknown>;
  const out: {
    driverHourlyRate?: number;
    loadUnloadMinutesPerVan?: number;
    returnFactor?: number;
    fragilitySurchargePerItem?: number;
  } = {};
  const num = (key: string, min: number, exclusive: boolean): number | undefined => {
    const v = src[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new PricingError(`'${key}' must be a number.`);
    }
    if (exclusive ? v <= min : v < min) {
      throw new PricingError(`'${key}' must be ${exclusive ? "greater than" : "at least"} ${min}.`);
    }
    return v;
  };
  const driverHourlyRate = num("driverHourlyRate", 0, false);
  if (driverHourlyRate !== undefined) out.driverHourlyRate = driverHourlyRate;
  const loadUnload = num("loadUnloadMinutesPerVan", 0, false);
  if (loadUnload !== undefined) out.loadUnloadMinutesPerVan = loadUnload;
  const returnFactor = num("returnFactor", 0, true);
  if (returnFactor !== undefined) out.returnFactor = returnFactor;
  const fragility = num("fragilitySurchargePerItem", 0, false);
  if (fragility !== undefined) out.fragilitySurchargePerItem = fragility;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Fail-soft parse of the optional filename/customer the client sends alongside a quote
 * request (carried over from PDF ingestion). Malformed input is ignored, never 400s —
 * this is CRM/duplicate-detection metadata, not something that should block a quote.
 */
function parseHistoryMeta(rawFilename: unknown, rawCustomer: unknown): QuoteHistoryMeta | undefined {
  const filename =
    typeof rawFilename === "string" && rawFilename.trim().length > 0 ? rawFilename.trim() : undefined;

  let customer: { name: string | null; phone: string | null } | undefined;
  if (typeof rawCustomer === "object" && rawCustomer !== null) {
    const obj = rawCustomer as { name?: unknown; phone?: unknown };
    const name = typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : null;
    const phone = typeof obj.phone === "string" && obj.phone.trim().length > 0 ? obj.phone.trim() : null;
    customer = { name, phone };
  }

  if (filename === undefined && customer === undefined) return undefined;
  return { ...(filename !== undefined ? { filename } : {}), ...(customer !== undefined ? { customer } : {}) };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  try {
    const body = (await request.json()) as {
      vanIds?: unknown;
      origin?: string;
      destination?: string;
      fragileCount?: number;
      vanPayloads?: unknown;
      vans?: unknown;
      stops?: unknown;
      filename?: unknown;
      customer?: unknown;
    };

    const meta = parseHistoryMeta(body.filename, body.customer);

    // Multi-stop chain path: present only when the client sends an ordered stop list. The
    // single-drop origin/destination path below is left exactly as it was.
    if (Array.isArray(body?.stops)) {
      const chain = parseChainRequest(body as Record<string, unknown>);
      const result = await getChainQuote(chain);
      await history.append(result.quote, meta);
      return NextResponse.json({
        success: true,
        requestId,
        quote: result.quote,
        warnings: result.warnings,
        visitOrder: result.visitOrder,
        perf: result.perf,
      });
    }

    const vanIds = Array.isArray(body?.vanIds)
      ? body.vanIds.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim())
      : [];
    if (vanIds.length === 0) {
      return NextResponse.json(
        { success: false, requestId, error: "Missing or empty 'vanIds'." },
        { status: 400 },
      );
    }
    if (typeof body?.origin !== "string" || body.origin.trim() === "") {
      return NextResponse.json(
        { success: false, requestId, error: "Missing or empty 'origin'." },
        { status: 400 },
      );
    }
    if (typeof body?.destination !== "string" || body.destination.trim() === "") {
      return NextResponse.json(
        { success: false, requestId, error: "Missing or empty 'destination'." },
        { status: 400 },
      );
    }
    const fragileCount = body.fragileCount ?? 0;
    if (typeof fragileCount !== "number" || !Number.isFinite(fragileCount) || fragileCount < 0) {
      return NextResponse.json(
        { success: false, requestId, error: "'fragileCount' must be a non-negative number." },
        { status: 400 },
      );
    }

    const rawPayloads = Array.isArray(body?.vanPayloads)
      ? (body.vanPayloads as unknown[]).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0)
      : undefined;
    const vanPayloads = rawPayloads?.length === vanIds.length ? rawPayloads : undefined;

    const vans = parseVansOverride(body.vans);

    const result = await getQuote({
      vanIds,
      origin: body.origin.trim(),
      destination: body.destination.trim(),
      fragileCount: Math.round(fragileCount),
      vanPayloads,
      vans,
      viaHub: parseViaHub((body as Record<string, unknown>).viaHub),
      rateOverrides: parseRateOverrides((body as Record<string, unknown>).rateOverrides),
    });

    await history.append(result.quote, meta);

    return NextResponse.json({ success: true, requestId, ...result });
  } catch (err) {
    if (err instanceof RoutingError || err instanceof PricingError || err instanceof StopChainError) {
      return NextResponse.json({ success: false, requestId, error: err.message }, { status: 400 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { success: false, requestId, error: "Request body is not valid JSON." },
        { status: 400 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("unexpected quote error", { requestId, error: msg });
    return NextResponse.json(
      { success: false, requestId, error: msg },
      { status: 500 },
    );
  }
}
