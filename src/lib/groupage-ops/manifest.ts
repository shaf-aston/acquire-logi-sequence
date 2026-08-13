/**
 * Manifest — a pure DATA VIEW over shipments (blueprint 3.2). One manifest per distinct leg,
 * compiling every active shipment assigned to that leg and the space + payload it uses against the
 * leg's capacity (e.g. "18 / 26 pallet-spaces"). Terminal shipments (complete / returned) drop off.
 */
import { isTerminal, type Shipment, type ShipmentStatus } from "./lifecycle.types";
import { GroupageError, type DualCapacity, type GroupageLegKind } from "@/lib/groupage/groupage.types";
// `legKeyOf` lives in the quote CORE (path-builder) and is imported DOWNWARD here — ops depends on
// core, never the reverse. Re-exported below so `groupage-ops` keeps exposing it from one place.
import { legKeyOf } from "@/lib/groupage/path-builder";

export interface ManifestShipment {
  readonly id: string;
  readonly status: ShipmentStatus;
  readonly palletCount: number;
  readonly footprints: number;
  readonly weightKg: number;
}

export interface Manifest {
  readonly legKey: string;
  readonly kind: GroupageLegKind;
  readonly from: string;
  readonly to: string;
  readonly capacity: DualCapacity;
  readonly shipments: ManifestShipment[];
  readonly usedFootprints: number;
  readonly usedWeightKg: number;
  readonly count: number;
}

export { legKeyOf };

const round1 = (n: number): number => Math.round(n * 10) / 10;

interface MutableManifest extends Omit<Manifest, "count"> {
  shipments: ManifestShipment[];
  usedFootprints: number;
  usedWeightKg: number;
}

export function buildManifests(shipments: readonly Shipment[]): Manifest[] {
  const byKey = new Map<string, MutableManifest>();
  for (const s of shipments) {
    if (isTerminal(s.status)) continue;
    for (const leg of s.legs) {
      const key = legKeyOf(leg);
      let m = byKey.get(key);
      if (!m) {
        m = {
          legKey: key,
          kind: leg.kind,
          from: leg.from,
          to: leg.to,
          capacity: leg.capacity,
          shipments: [],
          usedFootprints: 0,
          usedWeightKg: 0,
        };
        byKey.set(key, m);
      }
      m.shipments.push({
        id: s.id,
        status: s.status,
        palletCount: s.demand.palletCount,
        footprints: s.demand.footprints,
        weightKg: s.demand.weightKg,
      });
      m.usedFootprints += s.demand.footprints;
      m.usedWeightKg += s.demand.weightKg;
    }
  }
  return [...byKey.values()].map((m) => ({
    ...m,
    usedFootprints: round1(m.usedFootprints),
    usedWeightKg: round1(m.usedWeightKg),
    count: m.shipments.length,
  }));
}

/**
 * Re-derives the SAME per-leg manifest math the shipments board displays, but as-if `incoming`
 * were already booked, and fails loud on the first leg that would go over either capacity limit.
 * Makes consolidation real: a single booking's own demand already gets checked against leg
 * capacity at quote time (groupage/capacity.ts), but that check can't see OTHER active bookings
 * sharing the same trunk leg — this is the check that can, run at booking time so two bookings
 * that each individually fit can't silently overflow the shared vehicle together.
 */
export function assertCapacityAvailable(incoming: Shipment, existing: readonly Shipment[]): void {
  const manifests = buildManifests([...existing, incoming]);
  for (const leg of incoming.legs) {
    const m = manifests.find((x) => x.legKey === legKeyOf(leg));
    if (!m) continue;
    const overSpace = m.usedFootprints > m.capacity.palletSpaces;
    const overWeight = m.usedWeightKg > m.capacity.maxPayloadKg;
    if (!overSpace && !overWeight) continue;
    const reasons: string[] = [];
    if (overSpace) reasons.push(`${round1(m.usedFootprints - m.capacity.palletSpaces)} pallet-spaces over`);
    if (overWeight) reasons.push(`${Math.round(m.usedWeightKg - m.capacity.maxPayloadKg)} kg over`);
    throw new GroupageError(
      "capacity",
      `Booking this would put the ${leg.kind} leg ${leg.from} → ${leg.to} over capacity ` +
        `(${reasons.join(" and ")} — ${m.capacity.palletSpaces} spaces / ${m.capacity.maxPayloadKg} kg shared ` +
        `across ${m.count} active shipments). Split across another run, or reduce this booking.`,
    );
  }
}
