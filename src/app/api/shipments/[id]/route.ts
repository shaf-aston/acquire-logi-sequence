/**
 * /api/shipments/[id] — GET a single shipment; PATCH applies a lifecycle action { action, note }.
 * The state machine guards illegal transitions and the attempt cap, so an invalid action is a
 * fail-loud 400 naming the reason.
 */
import { NextResponse } from "next/server";
import { transitionShipment, FileShipmentStore, LifecycleError, SHIPMENT_ACTIONS, type ShipmentAction } from "@/lib/groupage-ops";

export const runtime = "nodejs";

const store = new FileShipmentStore();
const ACTIONS = new Set<string>(SHIPMENT_ACTIONS);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const shipment = await store.get(id);
  if (!shipment) return NextResponse.json({ error: `Unknown shipment "${id}".` }, { status: 404 });
  return NextResponse.json({ shipment });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  try {
    const body = (await request.json()) as { action?: unknown; note?: unknown };
    if (typeof body.action !== "string" || !ACTIONS.has(body.action)) {
      return NextResponse.json(
        { success: false, error: `Missing or unknown 'action'. Expected one of: ${[...ACTIONS].join(", ")}.` },
        { status: 400 },
      );
    }
    // Cap the note so a shipment's history (and shipments.json) can't grow unbounded.
    const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim().slice(0, 500) : undefined;
    const shipment = await transitionShipment(id, body.action as ShipmentAction, note, store);
    return NextResponse.json({ success: true, shipment });
  } catch (err) {
    if (err instanceof LifecycleError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: "Request body is not valid JSON." }, { status: 400 });
    }
    return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
  }
}
