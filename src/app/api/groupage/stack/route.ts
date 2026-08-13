/**
 * POST /api/groupage/stack — the shared-truck 3D load plan. Takes several consignments (each one
 * company's quote detail), groups the ones that can share a vehicle, and returns an auto-packed
 * pallet layout per shared truck for the planner to render + let the operator adjust.
 *
 * Thin transport: validate the untrusted request at the boundary, delegate to planSharedTrucks,
 * shape the JSON. A GroupageError (bad input / catchment gap / missing vehicle) is a fail-loud 400.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { getConfig } from "@/config/env";
import { readJsonBody, parseSessionHubs } from "@/lib/groupage/parse";
import { planSharedTrucks, createStackPlanDeps } from "@/lib/groupage/stack-service";
import { SessionOverlayHubRepository } from "@/lib/groupage/hub.repository";
import type { Consignment } from "@/lib/groupage/truck-grouping";
import {
  GroupageError,
  PALLET_FOOTPRINT_CLASSES,
  type GroupagePallet,
  type GroupageRouting,
  type PalletFootprintClass,
} from "@/lib/groupage/groupage.types";

export const runtime = "nodejs";

const logger = createLogger("api.groupage.stack");

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new GroupageError("input", `${where}: "${key}" is required.`);
  }
  return v.trim();
}

function num(v: unknown, where: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new GroupageError("input", `${where}: must be a number.`);
  return n;
}

function parsePallet(value: unknown, where: string): GroupagePallet {
  if (typeof value !== "object" || value === null) throw new GroupageError("input", `${where}: must be an object.`);
  const o = value as Record<string, unknown>;
  const { footprint } = o;
  if (typeof footprint !== "string" || !PALLET_FOOTPRINT_CLASSES.includes(footprint as PalletFootprintClass)) {
    throw new GroupageError("input", `${where}: "footprint" must be one of ${PALLET_FOOTPRINT_CLASSES.join(", ")}.`);
  }
  return {
    footprint: footprint as PalletFootprintClass,
    weightKg: num(o.weightKg, `${where}.weightKg`),
    quantity: num(o.quantity, `${where}.quantity`),
  };
}

function parseConsignment(value: unknown, i: number): Consignment {
  if (typeof value !== "object" || value === null) throw new GroupageError("input", `consignments[${i}] must be an object.`);
  const o = value as Record<string, unknown>;
  const where = `consignments[${i}]`;
  if (!Array.isArray(o.pallets) || o.pallets.length === 0) {
    throw new GroupageError("input", `${where}: "pallets" must be a non-empty array.`);
  }
  const { routing } = o;
  if (routing !== undefined && routing !== "direct" && routing !== "via-hub") {
    throw new GroupageError("input", `${where}: "routing" must be "direct" or "via-hub".`);
  }
  return {
    company: str(o, "company", where),
    originPostcode: str(o, "originPostcode", where),
    destinationPostcode: str(o, "destinationPostcode", where),
    pallets: o.pallets.map((p, pi) => parsePallet(p, `${where}.pallets[${pi}]`)),
    routing: routing as GroupageRouting | undefined,
  };
}

function parseConsignments(body: unknown): Consignment[] {
  if (typeof body !== "object" || body === null) throw new GroupageError("input", "Request body must be an object.");
  const arr = (body as Record<string, unknown>).consignments;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new GroupageError("input", "Provide a non-empty `consignments` array.");
  }
  return arr.map(parseConsignment);
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request, getConfig().groupage.maxRequestBodyBytes);
    const consignments = parseConsignments(body);

    // Session hubs (from the uploaded manifest) let the packer resolve the manifest's own hubs when
    // grouping consignments onto a shared truck — layered over the saved network, never persisted.
    const sessionHubs = parseSessionHubs((body as Record<string, unknown> | null)?.sessionHubs);
    const deps = createStackPlanDeps();
    const stackDeps = sessionHubs.length > 0
      ? { ...deps, hubs: new SessionOverlayHubRepository(deps.hubs, sessionHubs) }
      : deps;

    const trucks = await planSharedTrucks(consignments, stackDeps);
    return NextResponse.json({ success: true, trucks });
  } catch (err) {
    if (err instanceof GroupageError) {
      return NextResponse.json({ success: false, check: err.check, error: err.message }, { status: 400 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: "Request body is not valid JSON." }, { status: 400 });
    }
    logger.error("unexpected stack-plan error", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
  }
}
