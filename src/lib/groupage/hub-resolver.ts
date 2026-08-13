/**
 * Postcode → Hub resolution (blueprint 1.1). Every postcode belongs to exactly one hub via its
 * **area prefix** (the leading letters of a UK postcode). A missing area is a fail-loud
 * catchment gap, never a silent guess.
 */
import { GroupageError, type Hub } from "./groupage.types";

/**
 * Extract the postcode-area prefix from a UK postcode: the 1–2 letters before the first digit.
 * "CV1 2AB" → "CV", "B15 2TT" → "B", "EH12 5BJ" → "EH". Throws on anything that isn't postcode-shaped.
 */
export function postcodeArea(postcode: string): string {
  const cleaned = postcode.replace(/\s+/g, "").toUpperCase();
  const m = cleaned.match(/^([A-Z]{1,2})\d/);
  if (!m) {
    throw new GroupageError(
      "input",
      `"${postcode}" is not a recognisable UK postcode — type a postcode like "CV1 2AB".`,
    );
  }
  return m[1]!;
}

/** Resolve a postcode to its collecting/delivering hub. Fail-loud on a catchment gap. */
export function resolveHub(postcode: string, hubs: readonly Hub[]): Hub {
  const area = postcodeArea(postcode);
  const hub = hubs.find((h) => h.catchment.includes(area));
  if (!hub) {
    throw new GroupageError(
      "catchment",
      `No hub covers postcode area "${area}" (${postcode.trim()}). Add "${area}" to a hub's catchment on the Hubs screen, or use a covered area.`,
    );
  }
  return hub;
}

/**
 * Soft resolve for the DIRECT (hubless) route: returns the covering hub or `null` on a
 * catchment gap — no throw. A malformed postcode is still a fail-loud `input` error (via
 * `postcodeArea`), because "no readable postcode" is a different problem than "no hub here".
 */
export function resolveHubOrNull(postcode: string, hubs: readonly Hub[]): Hub | null {
  const area = postcodeArea(postcode);
  return hubs.find((h) => h.catchment.includes(area)) ?? null;
}

/**
 * Slugify a hub name into an id fragment: lowercase, non-alphanumerics collapsed to single dashes,
 * trimmed, capped at 40 chars. "Coventry Hub" → "coventry-hub". Empty when the name has no usable
 * characters (callers supply a fallback). Shared by the manual form and the document extractors so
 * hub ids read the same however a hub was created (MRMR).
 */
export function hubSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * Derive a stable, unique hub id from its name — so the operator never has to invent one. Prefixes
 * `hub-`, falls back to `fallback` (e.g. a postcode area) when the name has no sluggable characters,
 * and appends `-2`, `-3`… on collision with an id already in `existingIds`.
 */
export function hubIdFromName(name: string, existingIds: Iterable<string> = [], fallback = "hub"): string {
  const base = `hub-${hubSlug(name) || hubSlug(fallback) || "hub"}`;
  const taken = new Set(existingIds);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
