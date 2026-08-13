/**
 * Intermediate trunk stops — the "train stops" on the way from the origin hub to the destination
 * hub. Two pure concerns, no I/O:
 *
 *   • `resolveStops` — turn the caller's ordered hub ids into `Hub`s, rejecting anything that
 *     cannot be a stop (unknown hub, a repeat, or one of the two end hubs). Its post-condition is
 *     the one every downstream module leans on: **all station ids are pairwise distinct**, which is
 *     what makes an id → station-index lookup unambiguous.
 *   • `stationsOf` — the station chain of a built path: `[originHub, ...stops, destinationHub]`.
 *     Empty for a local or direct path, because neither has a trunk to stop on.
 */
import { GroupageError, type GroupagePath, type Hub } from "./groupage.types";

/**
 * Resolve ordered stop hub ids against the hub network the path's ends were resolved from.
 * Fail-loud on every way a stop can be wrong, naming the stop and the fix.
 */
export function resolveStops(
  stopHubIds: readonly string[],
  hubs: readonly Hub[],
  originHub: Hub,
  destinationHub: Hub,
): readonly Hub[] {
  const seen = new Set<string>();
  return stopHubIds.map((id, i) => {
    const hub = hubs.find((h) => h.id === id);
    if (!hub) {
      throw new GroupageError(
        "stops",
        `Stop ${i + 1}: no hub with id "${id}". Known hubs: ${hubs.map((h) => h.id).join(", ")}.`,
      );
    }
    if (seen.has(id)) {
      throw new GroupageError("stops", `Stop ${i + 1} (${id}) appears twice. Each intermediate stop must be a different hub.`);
    }
    if (id === originHub.id || id === destinationHub.id) {
      const which = id === originHub.id ? "origin" : "destination";
      throw new GroupageError(
        "stops",
        `Stop ${i + 1} (${id}) is the ${which} hub. A stop must be a hub between the two ends — remove it.`,
      );
    }
    seen.add(id);
    return hub;
  });
}

/**
 * The ordered stations a path's trunk calls at. `[]` unless the path actually has a trunk — a
 * `local` path (same hub both ends) and a `direct` path (no hubs at all) have no stations, so a
 * pallet line on either can never name one. Returns real `Hub`s, never `null` entries.
 */
export function stationsOf(path: GroupagePath): readonly Hub[] {
  if (path.kind !== "hub" || !path.originHub || !path.destinationHub) return [];
  return [path.originHub, ...(path.stops ?? []), path.destinationHub];
}
