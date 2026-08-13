/**
 * ONE process-wide request queue for Nominatim (OpenStreetMap), shared by every
 * caller that talks to it — the coordinate geocoder (routing) AND the address
 * resolver (prefill autocomplete). Nominatim's published policy is ≤ 1 request/second
 * from a single source and it IP-blocks bursts, so this MUST be a single queue: two
 * independent throttles could still fire 2 req/s and trip the block.
 *
 * `throttle(fn)` serialises `fn` behind every prior queued call, spacing actual
 * network hits ≥ MIN_INTERVAL_MS apart. One call failing never stalls the queue.
 */

/** Nominatim published policy: ≤ 1 req/s. Not a domain knob — a hard external constraint. */
export const MIN_INTERVAL_MS = 1000;

let lastRequestAt = 0;
let queueTail: Promise<unknown> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive whether or not this call succeeds, so one failure can't stall the queue.
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test hook — reset the shared queue/clock between runs. */
export function __resetNominatimThrottle(): void {
  lastRequestAt = 0;
  queueTail = Promise.resolve();
}
