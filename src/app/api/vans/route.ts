/**
 * GET /api/vans — returns the configured fleet van list.
 * Thin wrapper: no business logic, just surfaces FileVanRepository to the client.
 */
import { NextResponse } from "next/server";
import { getConfig } from "@/config/env";
import { FileVanRepository, VanConfigError } from "@/lib/packing/van.repository";
import type { Van } from "@/lib/packing/packing.types";

export const runtime = "nodejs";

const repo = new FileVanRepository();

function parseVan(body: unknown): Van {
  if (typeof body !== "object" || body === null) throw new VanConfigError("request body must be an object");
  const o = body as Record<string, unknown>;
  const dim = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new VanConfigError(`${name} must be a positive number`);
    }
    return value;
  };
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new VanConfigError(`${name} must be a non-empty string`);
    }
    return value.trim();
  };
  return {
    id: text(o.id, "id"),
    label: text(o.label, "label"),
    interior: {
      l: dim(o.interior && typeof o.interior === "object" ? (o.interior as Record<string, unknown>).l : undefined, "interior.l"),
      w: dim(o.interior && typeof o.interior === "object" ? (o.interior as Record<string, unknown>).w : undefined, "interior.w"),
      h: dim(o.interior && typeof o.interior === "object" ? (o.interior as Record<string, unknown>).h : undefined, "interior.h"),
    },
    maxPayloadKg: dim(o.maxPayloadKg, "maxPayloadKg"),
    fuelCostPerMile:
      o.fuelCostPerMile === undefined
        ? undefined
        : (() => {
            const v = o.fuelCostPerMile;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              throw new VanConfigError("fuelCostPerMile must be a non-negative number");
            }
            return v;
          })(),
    perMileRate: typeof o.perMileRate === "number" && Number.isFinite(o.perMileRate) && o.perMileRate >= 0
      ? o.perMileRate
      : (() => { throw new VanConfigError("perMileRate must be a non-negative number"); })(),
    co2GramsPerMile:
      o.co2GramsPerMile === undefined
        ? undefined
        : (() => {
            const v = o.co2GramsPerMile;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              throw new VanConfigError("co2GramsPerMile must be a non-negative number");
            }
            return v;
          })(),
    doorAperture:
      o.doorAperture && typeof o.doorAperture === "object"
        ? {
            w: dim((o.doorAperture as Record<string, unknown>).w, "doorAperture.w"),
            h: dim((o.doorAperture as Record<string, unknown>).h, "doorAperture.h"),
          }
        : undefined,
    quantity:
      o.quantity === undefined
        ? undefined
        : (() => {
            const v = o.quantity;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
              throw new VanConfigError("quantity must be a positive integer");
            }
            return Math.round(v);
          })(),
    sizeClass:
      o.sizeClass === undefined || o.sizeClass === ""
        ? undefined
        : (() => {
            if (typeof o.sizeClass !== "string" || o.sizeClass.trim() === "") {
              throw new VanConfigError("sizeClass must be a non-empty string");
            }
            return o.sizeClass.trim();
          })(),
  };
}

export async function GET(): Promise<Response> {
  try {
    const vans = await repo.listVans();
    // A van with no `quantity` means "however many the customer owns by default" — a business knob
    // the SERVER owns (packing.defaultVanQuantity, resolved by vanQuantity()). Sent down explicitly
    // so the browser never has to re-derive it: a client-side `?? 5` is a second copy of the rule,
    // and the fleet-cost estimator silently disagreeing with the allocator about how many vans exist
    // is exactly the drift this codebase keeps paying for.
    return NextResponse.json({ vans, defaultVanQuantity: getConfig().packing.defaultVanQuantity });
  } catch (err) {
    const message = err instanceof VanConfigError ? err.message : "Failed to load van config.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const van = parseVan(await request.json());
    await repo.upsertVan(van);
    return NextResponse.json({ success: true, van });
  } catch (err) {
    const message = err instanceof VanConfigError ? err.message : "Failed to save van.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PUT(request: Request): Promise<Response> {
  return POST(request);
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { id?: unknown };
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!id) throw new VanConfigError("id is required");
    const deleted = await repo.deleteVan(id);
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    const message = err instanceof VanConfigError ? err.message : "Failed to delete van.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
