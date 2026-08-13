/**
 * GET /api/places?q=<query> — address / postcode autocomplete suggestions.
 *
 * Thin transport: the provider choice (postcodes.io for UK postcodes, Nominatim for
 * free-text streets) and result mapping live in the pure `suggestPlaces` core. Proxied
 * server-side to avoid CORS and to add Nominatim's required User-Agent. Each upstream
 * call is time-boxed so a slow source degrades to "no matches" instead of a hung field.
 */
import { NextResponse } from "next/server";
import { suggestPlaces } from "@/lib/geo/place-autocomplete";

export const runtime = "nodejs";

/** Trust boundary: cap query length before it reaches an upstream geocoder. */
const MAX_QUERY_LEN = 120;
/** postcodes.io normally answers in ~100 ms; a tight deadline means a stall there doesn't
 *  delay the Nominatim fallthrough (bounding a postcode query's worst case, not just no-hang). */
const POSTCODES_IO_TIMEOUT_MS = 2500;
/** Nominatim (worldwide free-text) is slower, so it gets the larger share of the budget. */
const NOMINATIM_TIMEOUT_MS = 4000;

export async function GET(request: Request): Promise<Response> {
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LEN);
  if (q.length < 2) return NextResponse.json({ suggestions: [] });

  const suggestions = await suggestPlaces(q, async (url, headers) => {
    const timeout = url.includes("api.postcodes.io") ? POSTCODES_IO_TIMEOUT_MS : NOMINATIM_TIMEOUT_MS;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });

  return NextResponse.json({ suggestions });
}
