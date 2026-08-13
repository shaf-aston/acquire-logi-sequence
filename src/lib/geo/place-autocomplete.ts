/**
 * Address / postcode autocomplete source for the pickup, stop and hub location fields.
 *
 * A UK logistics tool's location boxes are overwhelmingly UK postcodes. For a (partial)
 * postcode the right source is **postcodes.io** — free, key-less, UNLIMITED (no ≤ 1 req/s
 * cap), UK-specific, and ~100 ms — NOT a worldwide Nominatim text search, which is slow,
 * rate-limited/blocked when called from a server, and returns whole districts rather than
 * deliverable postcodes (so "NW9" would sit on "Searching…" then offer a vague area).
 * Free-text street addresses ("Unit 5, Beddington Farm Road") have no postcode shape and
 * still go to Nominatim, which is the correct tool for those.
 *
 * Pure module: the network call is INJECTED as `fetchJson`, so the provider-routing
 * decision and the result mapping are unit-tested with no network. `suggestPlaces` never
 * throws — a failed source yields `[]` (the field shows "no matches"), never a hang.
 */

/** One autocomplete suggestion. `postcode` is null for a Nominatim result that resolved
 *  only to an area (no deliverable postcode); lat/lng are null when the source omits them
 *  rather than a misleading 0,0. Shape matches the client's PlaceSuggestion structurally. */
export interface PlaceSuggestion {
  label: string;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
}

/** Injected JSON fetcher: `(url, headers?) => parsed JSON`. Throws on transport/HTTP error. */
export type FetchJson = (url: string, headers?: Record<string, string>) => Promise<unknown>;

/** Start-of-a-UK-postcode shape: 1–2 letters immediately followed by a digit (NW9, N1, SW1A).
 *  Deliberately loose so the fast postcodes.io path engages the moment the outward code is typed;
 *  a street address has a space or a word before any digit and never matches. */
const POSTCODE_START = /^[a-z]{1,2}\d/i;

/** Whether `q` looks like the beginning of a UK postcode (⇒ use the postcodes.io fast path). */
export function looksLikePostcode(q: string): boolean {
  return POSTCODE_START.test(q.trim());
}

const POSTCODES_IO = "https://api.postcodes.io/postcodes";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
/** Contact-ID User-Agent Nominatim's policy requires — shared with the routing geocoder. */
const NOMINATIM_UA = "logistics-quoting-tool/1.0 (demo)";
/** Enough choices to pick from without a scrolling wall. */
const MAX_SUGGESTIONS = 6;

interface PostcodesIoRecord {
  postcode?: string;
  latitude?: number;
  longitude?: number;
}
interface NominatimRecord {
  display_name?: string;
  lat?: string;
  lon?: string;
  address?: { postcode?: string };
}

/** postcodes.io `?q=` payload → suggestions. Each record already carries a clean postcode
 *  and lat/lng, so a picked suggestion can both confirm the postcode and drop a map pin. */
function fromPostcodesIo(data: unknown): PlaceSuggestion[] {
  const result = (data as { result?: unknown })?.result;
  if (!Array.isArray(result)) return [];
  return (result as PostcodesIoRecord[]).slice(0, MAX_SUGGESTIONS).flatMap((r) => {
    if (typeof r.postcode !== "string" || r.postcode.trim() === "") return [];
    return [
      {
        label: r.postcode,
        postcode: r.postcode,
        lat: typeof r.latitude === "number" && Number.isFinite(r.latitude) ? r.latitude : null,
        lng: typeof r.longitude === "number" && Number.isFinite(r.longitude) ? r.longitude : null,
      },
    ];
  });
}

/** Nominatim search payload → suggestions (lat/lon arrive as strings; parse or null). */
function fromNominatim(data: unknown): PlaceSuggestion[] {
  if (!Array.isArray(data)) return [];
  return (data as NominatimRecord[]).slice(0, MAX_SUGGESTIONS).flatMap((r) => {
    if (typeof r.display_name !== "string") return [];
    // Nominatim sends lat/lon as strings. Guard the empty string explicitly — `"" != null` is
    // true and `Number("")` is 0, which would fabricate the misleading (0,0) this file forbids.
    return [{ label: r.display_name, postcode: r.address?.postcode ?? null, lat: parseCoord(r.lat), lng: parseCoord(r.lon) }];
  });
}

/** A Nominatim coordinate string → finite number, or null when absent/blank/non-numeric. */
function parseCoord(v: string | undefined): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Suggest places for `q`. A postcode-shaped query goes to postcodes.io first (fast,
 * unlimited); if that source errors OR returns nothing — and for any non-postcode text —
 * it falls through to Nominatim. Never throws; a total failure yields `[]`.
 */
export async function suggestPlaces(q: string, fetchJson: FetchJson): Promise<PlaceSuggestion[]> {
  const query = q.trim();
  if (query.length < 2) return [];

  if (looksLikePostcode(query)) {
    try {
      const data = await fetchJson(
        `${POSTCODES_IO}?q=${encodeURIComponent(query)}&limit=${MAX_SUGGESTIONS}`,
      );
      const hits = fromPostcodesIo(data);
      if (hits.length > 0) return hits;
    } catch {
      // postcodes.io unreachable — fall through to Nominatim rather than fail the field.
    }
  }

  try {
    const data = await fetchJson(
      `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=${MAX_SUGGESTIONS}&addressdetails=1`,
      { "User-Agent": NOMINATIM_UA },
    );
    return fromNominatim(data);
  } catch {
    return [];
  }
}
