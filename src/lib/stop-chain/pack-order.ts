/**
 * Injected pack-order strategy (§1A, Step 5). Maps the routing VISIT order (0-based drop indices,
 * in the sequence the van actually drives them) to the BAND order the ZonedPacker lays from the
 * doors inward (first entry = band at the doors, x=0).
 *
 * Delivery: identity — the first-visited drop sits at the doors so it unloads first, the
 * last-visited drop sits deepest. Collection is the mirror: the first pickup loads deepest, the
 * last pickup sits at the doors. Same engine, different injected strategy.
 */
export type PackOrderStrategy = (visitOrder: readonly number[]) => number[];

export const deliveryPackOrder: PackOrderStrategy = (visitOrder) => [...visitOrder];

export const collectionPackOrder: PackOrderStrategy = (visitOrder) => [...visitOrder].reverse();
