/**
 * /api/hubs — the hub network CRUD surface (hub-sourcing tiers 1 + 2). Thin wrapper: validate the
 * shape, delegate to FileHubRepository, shape the response. Mirrors /api/vans. The repository
 * enforces the disjoint-catchment invariant on save, so a bad edit fails loud with a 400.
 */
import { NextResponse } from "next/server";
import { FileHubRepository, HubConfigError } from "@/lib/groupage/hub.repository";
import type { Hub } from "@/lib/groupage/groupage.types";
import { requireAdmin } from "@/lib/security/admin-auth";

export const runtime = "nodejs";

const repo = new FileHubRepository();

function parseHubBody(body: unknown): Hub {
  if (typeof body !== "object" || body === null) throw new HubConfigError("request body must be an object");
  const o = body as Record<string, unknown>;
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value.trim() === "") throw new HubConfigError(`${name} must be a non-empty string`);
    if (value.trim().length > 80) throw new HubConfigError(`${name} is too long (max 80 characters)`);
    return value.trim();
  };
  // Cap the array + each area so an oversized body can't bloat hubs.json (UK has ~120 postcode areas).
  if (!Array.isArray(o.catchment) || o.catchment.length === 0) {
    throw new HubConfigError("catchment must be a non-empty array of postcode areas");
  }
  if (o.catchment.length > 200) throw new HubConfigError("catchment has too many areas (max 200)");
  const catchment = o.catchment.map((area, j) => {
    if (typeof area !== "string" || area.trim() === "") throw new HubConfigError(`catchment[${j}] must be a non-empty string`);
    if (area.trim().length > 4) throw new HubConfigError(`catchment[${j}] "${area}" is not a valid postcode area (max 4 chars)`);
    return area.trim().toUpperCase();
  });
  // Empty/whitespace address from the form means "not set" — store no field at all, so the
  // collection run's has-address check stays honest. Present ⇒ same bounds as other text fields
  // but longer (a full postal address), capped so a huge body can't bloat hubs.json.
  let address: string | undefined;
  if (o.address !== undefined && o.address !== null && String(o.address).trim() !== "") {
    if (typeof o.address !== "string") throw new HubConfigError("address must be a string");
    if (o.address.trim().length > 200) throw new HubConfigError("address is too long (max 200 characters)");
    address = o.address.trim();
  }
  return { id: text(o.id, "id"), name: text(o.name, "name"), catchment, ...(address !== undefined ? { address } : {}) };
}

export async function GET(): Promise<Response> {
  try {
    const hubs = await repo.listHubs();
    return NextResponse.json({ hubs });
  } catch (err) {
    const message = err instanceof HubConfigError ? err.message : "Failed to load hub config.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const hub = parseHubBody(await request.json());
    await repo.upsertHub(hub);
    return NextResponse.json({ success: true, hub });
  } catch (err) {
    const message = err instanceof HubConfigError ? err.message : "Failed to save hub.";
    const conflict = err instanceof HubConfigError ? err.conflict : undefined;
    return NextResponse.json({ success: false, error: message, ...(conflict ? { conflict } : {}) }, { status: 400 });
  }
}

export async function PUT(request: Request): Promise<Response> {
  return POST(request);
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = (await request.json()) as { id?: unknown };
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) throw new HubConfigError("id is required");
    const deleted = await repo.deleteHub(id);
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    const message = err instanceof HubConfigError ? err.message : "Failed to delete hub.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
