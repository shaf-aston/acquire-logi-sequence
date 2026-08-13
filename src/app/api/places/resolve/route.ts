/**
 * POST /api/places/resolve — resolve a batch of free-text addresses (from PDF
 * prefill) to canonical, geocodable location strings, so the UI can auto-confirm
 * the ones that match accurately instead of making the operator re-pick each.
 *
 * Body: { addresses: string[] }. Returns { results: ResolvedAddress[] } aligned by
 * index. Resolution runs through the shared ≤ 1 req/s Nominatim throttle, so this
 * can be slow for many addresses — that's the external rate limit, not a bug.
 */
import { NextResponse } from "next/server";
import { resolveAddress, type ResolvedAddress } from "@/lib/geo/address-resolver";

export const runtime = "nodejs";

/** Trust-boundary guards — reject absurd input rather than hammer Nominatim. */
const MAX_ADDRESSES = 30; // pickup + up to ~25 drops, with slack
const MAX_ADDRESS_LEN = 300;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const addresses = (body as { addresses?: unknown })?.addresses;
  if (!Array.isArray(addresses) || !addresses.every((a) => typeof a === "string")) {
    return NextResponse.json({ error: "addresses must be an array of strings" }, { status: 400 });
  }
  if (addresses.length > MAX_ADDRESSES) {
    return NextResponse.json(
      { error: `too many addresses (max ${MAX_ADDRESSES})` },
      { status: 400 },
    );
  }

  const results: ResolvedAddress[] = [];
  for (const raw of addresses as string[]) {
    // Sequential: the throttle serialises them anyway, and order must be preserved.
    results.push(await resolveAddress(raw.slice(0, MAX_ADDRESS_LEN)));
  }

  return NextResponse.json({ results });
}
