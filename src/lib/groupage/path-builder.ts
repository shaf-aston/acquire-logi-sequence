/**
 * Build the door-to-door path (blueprint 1.2): `collect → [trunk …] → deliver`.
 *
 * The trunk calls at ordered intermediate hubs ("stops", like train stops): the station chain is
 * `[originHub, ...stops, destinationHub]` and each adjacent pair becomes one trunk leg. With no
 * stops that is a single point-to-point hop — the original behaviour, unchanged. A **local move**
 * (origin hub = destination hub) is the degenerate case with **no trunk leg** and therefore no
 * stops. `maxTrunkHops` is the live ceiling on hops (`stops.length + 1`).
 */
import {
  GroupageError,
  type DualCapacity,
  type GroupageLeg,
  type GroupageLegKind,
  type GroupagePath,
  type Hub,
} from "./groupage.types";

export interface PathEnd {
  readonly postcode: string;
  readonly hub: Hub;
}

export interface PathBuilderConfig {
  readonly legCapacity: Readonly<Record<GroupageLegKind, DualCapacity>>;
  readonly maxTrunkHops: number;
}

export function buildPath(
  origin: PathEnd,
  destination: PathEnd,
  cfg: PathBuilderConfig,
  stops: readonly Hub[] = [],
): GroupagePath {
  const isLocal = origin.hub.id === destination.hub.id;

  // Structural self-validation. `buildPath` is public and has more than one caller, so it may not
  // assume the caller ran `resolveStops` first.
  if (stops.length > 0 && isLocal) {
    throw new GroupageError(
      "stops",
      `Origin and destination share a hub (${origin.hub.name}), so there is no trunk to stop on. Remove the intermediate stops, or pick a destination in another hub's catchment.`,
    );
  }
  const stationChain: Hub[] = isLocal ? [origin.hub] : [origin.hub, ...stops, destination.hub];
  // PAIRWISE distinct, not merely adjacent-distinct: `routePallets` maps a hub id to a station by
  // `findIndex`, so a hub appearing twice anywhere in the chain silently binds a pallet line to the
  // wrong station — a load charged to the wrong hop is a capacity lie. Never collapse a duplicate
  // either; collapsing is precisely what desynchronises the per-leg load profile from `legs`.
  const seen = new Set<string>();
  for (const station of stationChain) {
    if (seen.has(station.id)) {
      throw new GroupageError(
        "stops",
        `${station.name} appears twice on this trunk. Each station — both ends and every stop — must be a different hub.`,
      );
    }
    seen.add(station.id);
  }

  const legs: GroupageLeg[] = [
    {
      kind: "collect",
      from: origin.postcode.trim(),
      to: origin.hub.name,
      toHubId: origin.hub.id,
      capacity: cfg.legCapacity.collect,
    },
  ];

  // One trunk leg per adjacent station pair. With no stops this yields exactly the single
  // origin-hub → destination-hub hop it always did; a local move yields none.
  for (let i = 1; i < stationChain.length; i++) {
    const from = stationChain[i - 1]!;
    const to = stationChain[i]!;
    legs.push({
      kind: "trunk",
      from: from.name,
      to: to.name,
      fromHubId: from.id,
      toHubId: to.id,
      capacity: cfg.legCapacity.trunk,
    });
  }

  legs.push({
    kind: "deliver",
    from: destination.hub.name,
    to: destination.postcode.trim(),
    fromHubId: destination.hub.id,
    capacity: cfg.legCapacity.deliver,
  });

  // One trunk leg per adjacent station pair, so hops = stops + 1 (0 on a local move) by construction.
  const trunkHops = isLocal ? 0 : stops.length + 1;
  if (trunkHops > cfg.maxTrunkHops) {
    // Core states the limit; it does not name the env var that sets it — that is the platform
    // layer's business, and core must not know it.
    throw new GroupageError(
      "path",
      `This route needs ${trunkHops} trunk hops (${stops.length} stop${stops.length === 1 ? "" : "s"}); the configured limit is ${cfg.maxTrunkHops}. Remove a stop, or raise the trunk-hop limit in your groupage routing config.`,
    );
  }

  return {
    originHub: origin.hub,
    destinationHub: destination.hub,
    legs,
    routing: "via-hub",
    kind: isLocal ? "local" : "hub",
    isLocal,
    // Spread conditionally: an absent key is dropped by JSON.stringify, so a stop-free quote
    // serializes exactly as it always has.
    ...(stops.length > 0 ? { stops } : {}),
  };
}

/**
 * Build a DIRECT (hubless) door-to-door path: `collect → deliver`, no hub anchoring and no
 * trunk. Quotable for ANY origin/destination — no catchment lookup. The collect/deliver legs
 * reuse the same per-leg capacity config as the hub route (the shared truck is the same vehicle
 * class); pricing charges the default per-pallet-space line-haul rather than a zone rate.
 */
export function buildDirectPath(
  originPostcode: string,
  destinationPostcode: string,
  cfg: PathBuilderConfig,
): GroupagePath {
  const from = originPostcode.trim();
  const to = destinationPostcode.trim();
  const legs: GroupageLeg[] = [
    { kind: "collect", from, to, capacity: cfg.legCapacity.collect },
    { kind: "deliver", from, to, capacity: cfg.legCapacity.deliver },
  ];
  return {
    originHub: null,
    destinationHub: null,
    legs,
    routing: "direct",
    kind: "direct",
    isLocal: false,
  };
}

/** The minimal leg shape needed to derive a grouping key: leg kind + hub-pair. Both the core
 *  `GroupageLeg` and the ops-layer `LegAssignment` satisfy this structurally, so both layers key
 *  legs through the one function below — the core owns it and ops imports it DOWNWARD. */
export interface LegKeyParts {
  readonly kind: GroupageLegKind;
  readonly from: string;
  readonly to: string;
  readonly fromHubId?: string;
  readonly toHubId?: string;
}

/** Stable identity for a leg: kind + hub-pair (falls back to the display labels when hub-less). */
export function legKeyOf(leg: LegKeyParts): string {
  return `${leg.kind}:${leg.fromHubId ?? leg.from}>${leg.toHubId ?? leg.to}`;
}
