/**
 * GET /api/manifests — the per-leg load view (blueprint 3.2): every active shipment grouped by the
 * leg it travels, with space + payload used against each leg's capacity. Thin read over the store.
 */
import { NextResponse } from "next/server";
import { buildManifests, FileShipmentStore } from "@/lib/groupage-ops";

export const runtime = "nodejs";

const store = new FileShipmentStore();

export async function GET(): Promise<Response> {
  try {
    const manifests = buildManifests(await store.list());
    return NextResponse.json({ manifests });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to build manifests." }, { status: 500 });
  }
}
