/**
 * POST /api/groupage — the shared-truck (groupage) quote. Thin wrapper: validate the untrusted
 * request shape at the boundary, delegate to getGroupageQuote, shape the JSON response. A
 * GroupageError (catchment gap / capacity / bad input) is a fail-loud 400 carrying the exact fix.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { getConfig } from "@/config/env";
import { getGroupageQuote, createGroupageDeps } from "@/lib/groupage";
import { parseGroupageQuoteInput, parseSessionHubs, readJsonBody } from "@/lib/groupage/parse";
import { SessionOverlayHubRepository } from "@/lib/groupage/hub.repository";
import { GroupageConsignmentStore } from "@/lib/groupage/consignment.store";
import { GroupageError } from "@/lib/groupage/groupage.types";

export const runtime = "nodejs";

const logger = createLogger("api.groupage");
const consignments = new GroupageConsignmentStore();

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request, getConfig().groupage.maxRequestBodyBytes);
    const input = parseGroupageQuoteInput(body, getConfig().groupage.maxPalletsPerBooking, getConfig().groupage.maxTrunkHops);

    // Session hubs lifted off the uploaded manifest (if any) route THIS quote through the hubs the
    // document names — layered over the saved network, never persisted. Absent ⇒ saved network only.
    const sessionHubs = parseSessionHubs((body as Record<string, unknown> | null)?.sessionHubs);
    const deps = createGroupageDeps();
    const quoteDeps = sessionHubs.length > 0
      ? { ...deps, hubs: new SessionOverlayHubRepository(deps.hubs, sessionHubs) }
      : deps;

    const { quote } = await getGroupageQuote(input, quoteDeps);
    // Remember this quote as a consignment for the shared-truck planner's "recent quotes" list.
    // Best-effort: a persistence failure must never fail the quote the operator just priced.
    try {
      await consignments.append({
        company: input.customerName ?? `${input.originPostcode} → ${input.destinationPostcode}`,
        originPostcode: input.originPostcode,
        destinationPostcode: input.destinationPostcode,
        pallets: input.pallets,
        routing: input.routing,
        // `pallets` already carry their join/leave station refs, so saving the stop list makes a
        // re-quote from "recent quotes" re-price identically.
        ...(input.trunkStopHubIds.length > 0 ? { trunkStopHubIds: input.trunkStopHubIds } : {}),
      });
    } catch (persistErr) {
      logger.warn("failed to remember groupage consignment", {
        error: persistErr instanceof Error ? persistErr.message : String(persistErr),
      });
    }
    return NextResponse.json({ success: true, quote });
  } catch (err) {
    if (err instanceof GroupageError) {
      return NextResponse.json({ success: false, check: err.check, error: err.message }, { status: 400 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: "Request body is not valid JSON." }, { status: 400 });
    }
    logger.error("unexpected groupage error", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
  }
}
