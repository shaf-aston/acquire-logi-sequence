/**
 * GET /api/groupage/consignments — recent groupage quotes, remembered as consignments, for the
 * shared-truck planner's "recent quotes" pick-list. DELETE clears the log. Read-only surfacing of
 * what POST /api/groupage already persisted; no computation here. Mirrors /api/history.
 */
import { NextResponse } from "next/server";
import { GroupageConsignmentStore } from "@/lib/groupage/consignment.store";

export const runtime = "nodejs";

const store = new GroupageConsignmentStore();

export async function GET(): Promise<Response> {
  const consignments = await store.list();
  return NextResponse.json({ consignments });
}

export async function DELETE(): Promise<Response> {
  await store.clear();
  return NextResponse.json({ ok: true });
}
