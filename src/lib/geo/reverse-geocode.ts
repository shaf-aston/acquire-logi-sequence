/**
 * Reverse-geocode a coordinate (lat/lng) to a human address via OpenStreetMap Nominatim.
 *
 * Needed because the Routes API only accepts address-shaped waypoints, not a raw "lat,lng"
 * string — so a pin dragged to a bare point must be turned into an address before a road-distance
 * lookup. Runs through the shared ≤ 1 req/s Nominatim throttle. Never throws: returns null when the
 * point can't be resolved, so the caller can fail loud with a clear message.
 */
import { throttle } from "./nominatim-throttle";

const NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const TIMEOUT_MS = 5000;

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `${NOMINATIM_REVERSE}?lat=${lat}&lon=${lng}&format=json`;
  try {
    const res = await throttle(() =>
      fetch(url, {
        headers: { "User-Agent": "logistics-quoting-tool/1.0 (demo)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return typeof data.display_name === "string" ? data.display_name : null;
  } catch {
    return null;
  }
}
