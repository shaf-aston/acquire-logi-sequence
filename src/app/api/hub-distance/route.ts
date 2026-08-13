/**
 * POST /api/hub-distance — on-demand road distance/time between a point and a hub, for the
 * "Get driving distance" button on the Depots & hubs map. Thin transport: it just calls the
 * shared routing provider (Routes API v2, server-side key) and returns miles + minutes.
 *
 * `from` may be a "lat,lng" string (a dragged/searched pin) or a plain address; `to` is the
 * hub's address. Straight-line nearest-hub stays client-side and free — this endpoint is only
 * hit when the operator explicitly asks for the real road number.
 */
import { NextResponse } from "next/server";
import { getRouteProvider, RoutingError } from "@/lib/routing";
import { reverseGeocode } from "@/lib/geo/reverse-geocode";

export const runtime = "nodejs";

const MAX_LEN = 300; // trust boundary: reject absurdly long inputs rather than forward them.
// A pin dragged/clicked to a bare point arrives as "lat,lng"; the Routes API only takes an address,
// so we reverse-geocode these first. Ranges are validated so a junk pair fails loud, not silently.
const COORD = /^\s*(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Turn a "lat,lng" origin into an address; pass a plain address through unchanged. */
async function toAddress(value: string): Promise<string | null> {
  const m = COORD.exec(value);
  if (!m) return value; // already an address string
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return reverseGeocode(lat, lng);
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 });
  }

  const from = (body as { from?: unknown })?.from;
  const to = (body as { to?: unknown })?.to;
  if (typeof from !== "string" || typeof to !== "string" || from.trim() === "" || to.trim() === "") {
    return NextResponse.json(
      { success: false, error: "both 'from' and 'to' are required" },
      { status: 400 },
    );
  }
  if (from.length > MAX_LEN || to.length > MAX_LEN) {
    return NextResponse.json({ success: false, error: "location too long" }, { status: 400 });
  }

  const fromAddress = await toAddress(from.trim());
  if (!fromAddress) {
    return NextResponse.json(
      { success: false, error: "Couldn't resolve that point to an address — try the search box." },
      { status: 422 },
    );
  }

  try {
    const route = await getRouteProvider().getRoute(fromAddress, to.trim());
    return NextResponse.json({
      success: true,
      miles: route.distanceMiles,
      minutes: route.durationSeconds / 60,
    });
  } catch (err) {
    const message = err instanceof RoutingError ? err.message : "Could not get driving distance.";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
