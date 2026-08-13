/**
 * Injected stop-mix validators (§1A, Check 1). The engine calls a supplied "are these stops
 * allowed?" test — there is NO baked-in "must start with a pickup". Delivery and hub collection
 * both live here, each a predicate over the same Stop shape.
 *
 * `maxStops` is the DROP ceiling (stops after the pickup), not the total: maxStops = 1 means
 * single-drop only. Each rejection names the offending stop and the exact fix.
 */
import { StopChainError, type Stop } from "./stop.types";

/** Throws {@link StopChainError} with check="stops" on an invalid stop list; returns cleanly otherwise. */
export type StopValidator = (stops: readonly Stop[], maxStops: number) => void;

function assertNoBlanksOrDuplicates(stops: readonly Stop[]): void {
  const seen = new Map<string, number>();
  stops.forEach((s, i) => {
    const address = s.address?.trim() ?? "";
    if (address === "") {
      throw new StopChainError("stops", `Stop ${i + 1} is empty — type an address or remove it.`);
    }
    const key = address.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new StopChainError(
        "stops",
        `Stop ${prev + 1} and Stop ${i + 1} are the same — change one or drop it.`,
      );
    }
    seen.set(key, i);
  });
}

/** Delivery: exactly 1 pickup (first) + 1..maxStops drops. */
export const deliveryValidator: StopValidator = (stops, maxStops) => {
  if (stops.length === 0) {
    throw new StopChainError("stops", "Add a pickup and at least one drop-off.");
  }
  assertNoBlanksOrDuplicates(stops);

  const pickups = stops.filter((s) => s.kind === "pickup");
  const drops = stops.filter((s) => s.kind === "drop");

  if (stops[0]!.kind !== "pickup") {
    throw new StopChainError("stops", "The first stop must be the pickup.");
  }
  if (pickups.length !== 1) {
    throw new StopChainError(
      "stops",
      `A delivery has exactly one pickup; you have ${pickups.length}. Remove the extra pickup(s).`,
    );
  }
  if (drops.length < 1) {
    throw new StopChainError("stops", "Add at least one drop-off after the pickup.");
  }
  if (drops.length > maxStops) {
    throw new StopChainError(
      "stops",
      `You've entered ${drops.length} drop-offs; the limit is ${maxStops} — remove ${drops.length - maxStops}, or split into a second job.`,
    );
  }
};

/**
 * Hub collection run: the hub first (the van departs from the depot), then 1..maxStops pickups.
 * The RETURN to the hub is not a stop — the service pins it as the route's final destination, so
 * the hub appears in `stops` exactly once and the duplicate check stays meaningful.
 */
export const collectionValidator: StopValidator = (stops, maxStops) => {
  if (stops.length === 0) {
    throw new StopChainError("stops", "Pick a hub and add at least one pickup.");
  }
  assertNoBlanksOrDuplicates(stops);

  if (stops[0]!.kind !== "hub") {
    throw new StopChainError("stops", "The first stop must be the hub the run departs from.");
  }
  const strays = stops.slice(1).filter((s) => s.kind !== "pickup");
  if (strays.length > 0) {
    throw new StopChainError(
      "stops",
      `Every stop after the hub must be a pickup — found a "${strays[0]!.kind}" at ${strays[0]!.address}.`,
    );
  }
  const pickups = stops.length - 1;
  if (pickups < 1) {
    throw new StopChainError("stops", "Add at least one pickup after the hub.");
  }
  if (pickups > maxStops) {
    throw new StopChainError(
      "stops",
      `You've entered ${pickups} pickups; the limit is ${maxStops} — remove ${pickups - maxStops}, or split into a second run.`,
    );
  }
};
