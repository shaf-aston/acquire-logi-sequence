/**
 * /api/shipments — GET lists shipments; POST books a confirmed groupage quote into a Shipment.
 * Booking RE-QUOTES server-side from the same inputs (never trusts a client-sent price) and then
 * creates the lifecycle record. Thin wrapper: parse → delegate → shape.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { getConfig } from "@/config/env";
import { getGroupageQuote, createGroupageDeps } from "@/lib/groupage";
import { parseGroupageQuoteInput, parseExpectedTotal, parseSessionHubs, readJsonBody } from "@/lib/groupage/parse";
import { SessionOverlayHubRepository } from "@/lib/groupage/hub.repository";
import { GroupageError } from "@/lib/groupage/groupage.types";
import { bookGroupageQuote, FileShipmentStore } from "@/lib/groupage-ops";

export const runtime = "nodejs";

const logger = createLogger("api.shipments");
const store = new FileShipmentStore();

// The two totals must be within a penny of each other to count as "unchanged" — matches the
// float-noise tolerance used elsewhere in the app's price comparisons.
const PRICE_DRIFT_TOLERANCE = 0.005;

export async function GET(): Promise<Response> {
  try {
    const shipments = await store.list();
    return NextResponse.json({ shipments });
  } catch (err) {
    logger.error("list shipments failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request, getConfig().groupage.maxRequestBodyBytes);
    const input = parseGroupageQuoteInput(body, getConfig().groupage.maxPalletsPerBooking, getConfig().groupage.maxTrunkHops);
    const expectedTotal = parseExpectedTotal(body);

    // Booking re-quotes from scratch, so it must route through the SAME session hubs the on-screen
    // quote used — otherwise a manifest-hub route (e.g. HD→NG) would fail the re-quote and block the
    // booking. Layered over the saved network, never persisted (see /api/groupage).
    const sessionHubs = parseSessionHubs((body as Record<string, unknown> | null)?.sessionHubs);
    const deps = createGroupageDeps();
    const quoteDeps = sessionHubs.length > 0
      ? { ...deps, hubs: new SessionOverlayHubRepository(deps.hubs, sessionHubs) }
      : deps;

    const { quote } = await getGroupageQuote(input, quoteDeps);

    // Anti-drift gate: the operator confirmed a price on screen — if the server-side re-quote
    // (rates/hubs may have changed since) disagrees, surface it and stop BEFORE persisting
    // rather than silently booking a different price than what was shown.
    if (expectedTotal !== null && Math.abs(quote.total - expectedTotal) >= PRICE_DRIFT_TOLERANCE) {
      return NextResponse.json(
        {
          success: false,
          priceChanged: true,
          quote,
          error: `The price has changed since you quoted — now ${quote.currencySymbol}${quote.total.toFixed(2)}. Review and click Book again to confirm at the new price.`,
        },
        { status: 409 },
      );
    }

    const shipment = await bookGroupageQuote(quote, store);
    return NextResponse.json({ success: true, shipment });
  } catch (err) {
    if (err instanceof GroupageError) {
      return NextResponse.json({ success: false, check: err.check, error: err.message }, { status: 400 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: "Request body is not valid JSON." }, { status: 400 });
    }
    logger.error("book failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
  }
}
