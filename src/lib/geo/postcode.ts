/**
 * UK postcode matching + normalisation — the ONE place this regex and its "OUTWARD INWARD"
 * spacing live. Before this module the same pattern (and the same normalisation logic) was
 * copy-pasted across six call sites; any future fix (an edge case, a stricter/looser match)
 * had to be applied six times or drifted. Pure — no I/O, no config, no network.
 *
 * Pattern precedence: `config/address-detection.json`'s `postcodePattern` is the CANONICAL
 * source for any caller that has config in scope (the ingestion pipeline reads it via
 * `address-detector.ts` and threads it into callers like `manifest-hub-reader.ts`). The
 * `UK_POSTCODE` pattern exported here is the DEFAULT this module (and callers with no config
 * in scope, e.g. pure parsers invoked with no options) falls back to — today it is character-
 * for-character the same regex as the config file, so nothing changes for existing callers.
 *
 * This module must never import anything with I/O (network, fs, config) — `address-resolver.ts`
 * imports the Nominatim throttle (network), so postcode matching is lifted OUT of it, not
 * pulled in from it, to keep this usable by pure offline parsers (collection-run-parser,
 * groq-consignment-reader, manifest-hub-reader) without dragging networking along.
 */

/** Full-ish UK postcode: area (1–2 letters) + district digit(s) + optional letter, optional
 *  space, inward code (digit + 2 letters). Tolerant of a missing/odd internal space. */
export const UK_POSTCODE = /\b[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}\b/i;

/** Re-space a compact/odd-spaced postcode into the canonical "OUTWARD INWARD" form — the
 *  inward code is always the final 3 characters. Assumes `s` already looks like a postcode
 *  (e.g. the text matched by `UK_POSTCODE`); does not itself validate the shape. */
export function normalisePostcode(s: string): string {
  const compact = s.toUpperCase().replace(/\s+/g, "");
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

/** Pull the first UK postcode out of free text, normalised. Null when none is found. */
export function extractPostcode(text: string): string | null {
  const m = UK_POSTCODE.exec(text);
  if (!m) return null;
  return normalisePostcode(m[0]);
}
