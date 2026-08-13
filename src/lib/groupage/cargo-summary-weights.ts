/**
 * CONSOLIDATED CARGO SUMMARY → per-company total weight (kg). Offline, pure, no LLM.
 *
 * A groupage manifest states pallet COUNTS in the collection-run table but usually gives
 * no per-pallet weight there. The weight it DOES state lives in a separate per-piece table:
 *
 *   Origin Company        | Material / Goods … | L x W x D (cm)  | Line Weight   | Qty (units)
 *   Elland Metal Pressings| Pressed steel …    | 60 x 40 x 30    | 16 kg/carton  | 150
 *   Elland Metal Pressings| Metal offcuts …    | 100 x 60 x 40   | 34 kg/bundle  | 20
 *
 * The line weight is PER UNIT ("16 kg/carton") and the quantity is the unit count, so a
 * company's total weight = Σ (unit weight × qty) across its lines. That total is exactly
 * what groupage pricing needs (a company is weight- or space-bound on the shared truck),
 * and dividing it across the company's pallet count gives a sound per-pallet figure — the
 * truck total is unchanged however the load actually splits between pallets.
 *
 * This is NOT the "10 000-carton trap": that trap is reading the per-piece QTY as a PALLET
 * COUNT (which explodes the packer). Reading the per-piece weight to SUM a consignment
 * weight is the ordinary, correct way to weigh a load — the collection-run parser still
 * takes its authoritative pallet counts from the `Pallets` column, never from here.
 *
 * Pure module: no I/O, no config, no network. Returns an empty map when the document has
 * no cargo-summary table, so the caller simply leaves weights blank for the operator.
 */
import type { ExtractedTable, StructuredDocument } from "@/lib/conversion/types";

/** The per-piece quantity column of the cargo summary ("Qty (units)", "Quantity", "Units"). */
const isQtyHeader = (h: string): boolean => /\bqty\b|quantit|\bunits?\b/i.test(h);
/** A weight column ("Line Weight", "Weight (kg)", "Gross kg") — but never a cm/size column. */
const isWeightHeader = (h: string): boolean =>
  /weight|\bkg\b|\bwt\b/i.test(h) && !/size|dimension|\bcm\b/i.test(h);
/** The company column ("Origin Company", "Company", "Consignor"). */
const isCompanyHeader = (h: string): boolean => /\b(compan|shipper|consignor|origin)/i.test(h);
/** A pallet-COUNT column — its presence marks the collection-run table, NOT the cargo summary.
 *  Exported: `collection-run-parser.ts` uses the SAME predicate to find its own Pallets column
 *  (byte-identical logic — a pallet-count header means the same thing in both tables). */
export const isPalletCountHeader = (h: string): boolean => /pallet/i.test(h) && !/size|dimension|cm/i.test(h);

/** Find a header index by predicate. Exported: `collection-run-parser.ts` uses the same
 *  byte-identical helper rather than redefining it. */
export function findIndex(headers: readonly string[], pred: (h: string) => boolean): number {
  return headers.findIndex((h) => typeof h === "string" && pred(h));
}

/**
 * A cargo-summary table has a company column, a QTY column and a WEIGHT column, and does
 * NOT have a pallet-count column (that would make it the collection run). The pallet-count
 * exclusion keeps the two tables from ever being confused.
 */
function isCargoSummaryTable(table: ExtractedTable): boolean {
  return (
    findIndex(table.headers, isCompanyHeader) !== -1 &&
    findIndex(table.headers, isQtyHeader) !== -1 &&
    findIndex(table.headers, isWeightHeader) !== -1 &&
    findIndex(table.headers, isPalletCountHeader) === -1 &&
    table.rows.length > 0
  );
}

/** First non-negative integer in a qty cell ("150", "1,200"), or null when unreadable. */
function readQty(cell: string | undefined): number | null {
  if (typeof cell !== "string") return null;
  const m = cell.replace(/,/g, "").match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Read a "Line Weight" cell into a LINE total (kg), given the line's unit quantity.
 * A per-unit cell ("16 kg/carton", "20 kg per roll") is multiplied by the quantity; a
 * cell that already states a line total ("720 kg") is taken as-is. The "/" or "per" marker
 * (or a unit word after the number) is what distinguishes the two. Null when unreadable.
 */
function readLineWeightKg(cell: string | undefined, qty: number | null): number | null {
  if (typeof cell !== "string") return null;
  const m = cell.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const value = Number.parseFloat(m[0]);
  if (!Number.isFinite(value) || value <= 0) return null;
  // Per-unit rate → scale by quantity; a bare total → use directly.
  const perUnit = /\/|\bper\b|kg\s*(?:\/|per|a|each)|\b(each|unit|carton|roll|bundle|piece|box|item|drum|crate|bag|sack|pack|case)s?\b/i.test(
    cell,
  );
  if (perUnit) {
    if (qty === null || qty <= 0) return null; // a rate with no count can't be totalled — leave blank
    return value * qty;
  }
  return value;
}

/** Normalise a company name to significant lowercase tokens, dropping generic legal/suffix
 *  noise so the cargo summary's short name ("Brighouse Textile") matches the collection run's
 *  full name ("Brighouse Textile Finishers Ltd"). */
const SUFFIX_STOPWORDS = new Set(["ltd", "limited", "plc", "llp", "uk", "co", "company", "inc"]);
export function companyTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !SUFFIX_STOPWORDS.has(t));
}

/**
 * Non-anchor token equivalence: identical, OR one a prefix of the other of at least MIN_PREFIX_LEN
 * characters. The prefix rule lets an ABBREVIATED cargo-summary name line up with the collection
 * run's full name — "Mat." (→ "mat") matches "Materials", "Pharma" matches "Pharmaceutical" —
 * without a 1–2 char token gluing unrelated firms together. Applied ONLY to non-first tokens: the
 * distinctive first company word is never abbreviated in these docs, so "van" must not reach
 * "Vantage" (that would attach the wrong firm's weight).
 */
const MIN_PREFIX_LEN = 3;
function tokensPrefixMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= MIN_PREFIX_LEN && longer.startsWith(shorter);
}

/**
 * Do cargo tokens `k` line up with collection tokens `target`? They must share their EXACT first
 * significant token (the anchor), and every token of the shorter list must match some token of the
 * longer. `allowPrefix` enables abbreviation tolerance on the non-first tokens; with it off this is
 * the strict exact-token subset. First-token equality is always exact.
 */
function tokensAlign(k: readonly string[], target: readonly string[], allowPrefix: boolean): boolean {
  if (k.length === 0 || target.length === 0) return false;
  if (k[0] !== target[0]) return false; // exact anchor — never prefix the distinctive first word
  const [shorter, longer] = k.length <= target.length ? [k, target] : [target, k];
  const eq = allowPrefix ? tokensPrefixMatch : (a: string, b: string) => a === b;
  return shorter.every((t) => longer.some((u) => eq(t, u)));
}

/**
 * Match a collection-run company name against the cargo-summary keys. Two passes, exact FIRST:
 * an exact-token subset match is unambiguous and always preferred, so an abbreviated name can never
 * steal an exact one ("Gedling Build" must not grab "Gedling Building Materials"). Only when no exact
 * match exists do we fall back to abbreviation-tolerant matching, which lets "Gedling Building Mat."
 * reach "Gedling Building Materials". Returns the matched key, or null.
 */
export function matchCompany(collectionName: string, keys: readonly string[]): string | null {
  const target = companyTokens(collectionName);
  if (target.length === 0) return null;
  return (
    keys.find((key) => tokensAlign(companyTokens(key), target, false)) ??
    keys.find((key) => tokensAlign(companyTokens(key), target, true)) ??
    null
  );
}

/**
 * Sum the CONSOLIDATED CARGO SUMMARY into a per-company total weight (kg), keyed by the
 * company name exactly as the summary states it. Empty when the document has no such table.
 * The caller matches these keys to its collection-run companies via `matchCompany`.
 */
export function readCargoSummaryWeights(doc: StructuredDocument): Map<string, number> {
  const totals = new Map<string, number>();
  const tables = doc.pages.flatMap((p) => p.tables).filter(isCargoSummaryTable);

  for (const table of tables) {
    const companyIdx = findIndex(table.headers, isCompanyHeader);
    const qtyIdx = findIndex(table.headers, isQtyHeader);
    const weightIdx = findIndex(table.headers, isWeightHeader);

    for (const row of table.rows) {
      const company = typeof row[companyIdx] === "string" ? row[companyIdx]!.trim() : "";
      if (company === "") continue;
      const qty = readQty(row[qtyIdx]);
      const lineKg = readLineWeightKg(row[weightIdx], qty);
      if (lineKg === null) continue;
      totals.set(company, (totals.get(company) ?? 0) + lineKg);
    }
  }

  return totals;
}
