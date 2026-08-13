/**
 * Resolves a free-text address (e.g. one the LLM pulled off a quotation) to a
 * canonical, geocodable location string — the same thing a user gets by picking
 * a suggestion from the autocomplete dropdown, done automatically.
 *
 * Accuracy guard ("never guess"): a match is only `confident` when it is anchored
 * on the address's UK POSTCODE. We prefer a full-address hit whose postcode equals
 * the query's; failing that we resolve the postcode alone (always area-accurate).
 * With no postcode, or nothing found, we return `confident: false` and the caller
 * leaves the field flagged for the operator rather than auto-selecting a guess.
 *
 * All Nominatim traffic goes through the shared ≤ 1 req/s throttle.
 */
import { throttle } from "@/lib/geo/nominatim-throttle";
import { extractPostcode } from "@/lib/geo/postcode";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 5000;

export interface ResolvedAddress {
  readonly query: string;
  /** Canonical location string, or null when nothing usable was found. */
  readonly match: string | null;
  /** True only when the match is postcode-verified — the caller auto-selects only these. */
  readonly confident: boolean;
}

/** Pull a UK postcode out of free text, normalised (upper-case, single internal space).
 *  Re-exported from `@/lib/geo/postcode` (the canonical home) for existing callers/tests. */
export { extractPostcode };

/** Case/space-insensitive postcode equality. */
function samePostcode(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.replace(/\s+/g, "").toUpperCase() === b.replace(/\s+/g, "").toUpperCase();
}

/**
 * Choose the candidate that carries the query's postcode. Pure — no I/O.
 * Returns null when no candidate matches (caller then falls back to postcode-only search).
 */
export function pickByPostcode(
  queryPostcode: string | null,
  candidates: readonly string[],
): string | null {
  if (!queryPostcode) return null;
  for (const c of candidates) {
    if (samePostcode(extractPostcode(c), queryPostcode)) return c;
  }
  return null;
}

const cache = new Map<string, ResolvedAddress>();

async function nominatimSearch(query: string, limit: number): Promise<string[]> {
  // countrycodes=gb: these are UK addresses (UK postcode regex, UK fleet) — keeping results
  // in Great Britain stops a bare postcode from fuzzy-matching a same-looking token abroad.
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=${limit}&addressdetails=0&countrycodes=gb`;
  const res = await throttle(() =>
    fetch(url, {
      headers: { "User-Agent": "logistics-quoting-tool/1.0 (demo)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ display_name?: string }>;
  return data.map((r) => r.display_name).filter((s): s is string => typeof s === "string");
}

/** Resolve one address. Never throws — a failure yields `{ match: null, confident: false }`. */
export async function resolveAddress(address: string): Promise<ResolvedAddress> {
  const query = address.trim();
  if (query.length === 0) return { query: address, match: null, confident: false };

  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  const postcode = extractPostcode(query);
  let result: ResolvedAddress;
  try {
    const candidates = await nominatimSearch(query, 5);
    const byPostcode = pickByPostcode(postcode, candidates);
    if (byPostcode) {
      result = { query, match: byPostcode, confident: true };
    } else if (postcode) {
      // Full-address search missed the postcode — resolve the postcode alone. Verify the
      // hit ACTUALLY carries that postcode before trusting it (Nominatim can fuzzy-match a
      // bare postcode to an unrelated place); if it doesn't, stay unconfident → manual pick.
      const [pcMatch] = await nominatimSearch(`${postcode}, UK`, 1);
      result =
        pcMatch && samePostcode(extractPostcode(pcMatch), postcode)
          ? { query, match: pcMatch, confident: true }
          : { query, match: candidates[0] ?? null, confident: false };
    } else {
      // No postcode to verify against — surface the top hit but do NOT claim confidence.
      result = { query, match: candidates[0] ?? null, confident: false };
    }
  } catch {
    result = { query, match: null, confident: false };
  }

  cache.set(key, result);
  return result;
}

/** Test hook — clear the resolve cache between runs. */
export function __resetAddressResolverCache(): void {
  cache.clear();
}
