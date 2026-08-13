/**
 * Shared Nominatim (OSM) geocoder for the straight-line fallback.
 *
 * Nominatim's usage policy is ≤ 1 request/second from a single source, and it IP-blocks bursts.
 * Concurrent `/api/quote` calls — or a single multi-stop chain geocoding several addresses — would
 * otherwise fire in parallel and trip that limit. Rate-limiting lives in the shared
 * nominatim-throttle queue (used by the address resolver too), so ALL Nominatim traffic obeys
 * one ≤ 1 req/s clock. This module adds, on top of that:
 *   • a bounded LRU-ish cache so repeat addresses (e.g. the pickup reused as the return stop) are free,
 *   • in-flight de-duplication so two callers asking for the same address share one fetch.
 */
import { RoutingError } from "./types";
import { throttle, __resetNominatimThrottle } from "@/lib/geo/nominatim-throttle";

export interface Coord {
  readonly lat: number;
  readonly lon: number;
}

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_TIMEOUT_MS = 5000;
/** Cap resident geocode results; oldest evicted first. Bounds memory on long-running processes. */
const MAX_CACHE_ENTRIES = 500;

interface NominatimResult {
  lat: string;
  lon: string;
}

const cache = new Map<string, Coord>();
const inflight = new Map<string, Promise<Coord>>();

function cacheSet(key: string, coord: Coord): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, coord);
}

async function fetchGeocode(address: string): Promise<Coord> {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "logistics-quoting-tool/1.0 (demo)" },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RoutingError(`Geocoding request failed for "${address}": ${String(err)}`);
  }
  if (!res.ok) throw new RoutingError(`Geocoding failed for "${address}": HTTP ${res.status}`);
  const data = (await res.json()) as NominatimResult[];
  if (!data[0]) throw new RoutingError(`No location found for "${address}"`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

/** Cached, de-duplicated, rate-limited geocode. Throws {@link RoutingError} on failure. */
export function geocode(address: string): Promise<Coord> {
  const key = address.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(key);
  if (pending) return pending;

  const p = throttle(() => fetchGeocode(address))
    .then((coord) => {
      cacheSet(key, coord);
      inflight.delete(key);
      return coord;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, p);
  return p;
}

/** Test hook — clear cached state between runs. */
export function __resetGeocoderState(): void {
  cache.clear();
  inflight.clear();
  __resetNominatimThrottle();
}
