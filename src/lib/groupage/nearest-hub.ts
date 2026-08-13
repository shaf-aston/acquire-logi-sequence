/**
 * Nearest-hub-by-distance — a map-editing convenience, NOT a routing rule. Real postcode → hub
 * resolution stays exact-match on catchment (see hub-resolver.ts); this only picks which hub a
 * map click should suggest reassigning a postcode area to.
 */

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two lat/lng points (km). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A candidate hub position — id plus its map marker (mean of its catchment centroids). */
export interface HubPosition {
  readonly id: string;
  readonly lat: number;
  readonly lng: number;
}

/** Id of whichever hub position is geographically closest to the given point, or null if none given. */
export function nearestHubId(point: { lat: number; lng: number }, hubs: readonly HubPosition[]): string | null {
  let bestId: string | null = null;
  let bestDist = Infinity;
  for (const h of hubs) {
    const d = haversineKm(point, h);
    if (d < bestDist) {
      bestDist = d;
      bestId = h.id;
    }
  }
  return bestId;
}
