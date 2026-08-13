/**
 * Display-only postcode-area centroids — the shared reference data behind every map
 * (the SVG mini-maps and the live Google map). These are coarse AREA centres, never
 * street-level, and never feed routing/pricing: the live map refines them client-side
 * with the Google geocoder, and the SVG maps use them as-is. Single source so the two
 * map families can never drift on "where is area X".
 */
import areasFile from "../../../config/postcode-areas.json";

export type LatLng = { lat: number; lng: number };

/** area prefix ("CV") → its centre. */
const AREAS: Record<string, { name: string; lat: number; lng: number }> = areasFile.areas;

/** Centre of one postcode area, or null when the area is absent / the input is null. */
export function areaCentroid(area: string | null | undefined): LatLng | null {
  if (!area) return null;
  const a = AREAS[area.toUpperCase()];
  return a ? { lat: a.lat, lng: a.lng } : null;
}

/** Centre of a hub = mean of its catchment areas' centres (the rule every map uses). */
export function hubCentroid(catchment: readonly string[]): LatLng | null {
  const pts = catchment.map((a) => areaCentroid(a)).filter((p): p is LatLng => p !== null);
  if (pts.length === 0) return null;
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
  };
}

/** Every area centre — the faint UK-context dots on the SVG maps. */
export function allAreaCentres(): ReadonlyArray<{ name: string; lat: number; lng: number }> {
  return Object.values(AREAS);
}
