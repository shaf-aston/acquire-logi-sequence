/**
 * Approximate geographic position of a hub — the mean of its catchment areas' centre points
 * (config/postcode-areas.json). Display + nearest-hub-suggestion ONLY; never routing or pricing
 * (those use the hub's real address via the Routes API). A hub whose catchment has no known area
 * centres is dropped rather than pinned at a guessed (0,0).
 */
import areasFile from "../../../config/postcode-areas.json";
import type { Hub } from "./groupage.types";

const AREAS: Record<string, { name: string; lat: number; lng: number }> = areasFile.areas;

export interface HubPoint {
  readonly id: string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
}

/** Positions for every hub whose catchment has at least one known area centre. */
export function hubPoints(hubs: readonly Hub[]): HubPoint[] {
  const points: HubPoint[] = [];
  for (const h of hubs) {
    const centres = h.catchment
      .map((a) => AREAS[a.toUpperCase()])
      .filter((a): a is NonNullable<typeof a> => a != null);
    if (centres.length === 0) continue;
    points.push({
      id: h.id,
      name: h.name,
      lat: centres.reduce((s, a) => s + a.lat, 0) / centres.length,
      lng: centres.reduce((s, a) => s + a.lng, 0) / centres.length,
    });
  }
  return points;
}
