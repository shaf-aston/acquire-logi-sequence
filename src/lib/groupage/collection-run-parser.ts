/**
 * Structured COLLECTION-RUN parser (groupage, offline, no LLM).
 *
 * A groupage/hub-consolidation manifest states its load in a clean, labelled table —
 * the COLLECTION RUN: one row per company, with the pallet COUNT in its own column:
 *
 *   Stop | Collection Company / Contact | Collection Address | Est. Arrival | Pallets | Pallet Size (cm)
 *   1    | Elland Metal Pressings ...   | Elland ... HX5 9HT  | 07:45        | 4       | 120 x 80 x 130 (H)
 *
 * That is exactly the kind of structured grid a rule pass reads reliably — no LLM
 * judgement needed. Parsing it here has two payoffs over the LLM roster reader:
 *   1. it works OFFLINE (no key, no network) — the reader can't be knocked out by a
 *      dead/expired API key; and
 *   2. it reads the AUTHORITATIVE `Pallets` column, so it can never be fooled by the
 *      per-piece "Consolidated Cargo Summary" table (a 10,000-carton line there is the
 *      trap that explodes the standard packer — this parser never looks at it).
 *
 * Everything it returns is a SUGGESTION the operator confirms (the never-guess surface).
 * Per-pallet WEIGHT is filled, in order: a dedicated weight column if the run has one; else
 * CALCULATED from the CONSOLIDATED CARGO SUMMARY (a company's Σ unit-weight × qty, spread
 * across its pallet count — see cargo-summary-weights.ts). Only when the manifest states no
 * weight anywhere does it come back 0 and the line is flagged `pallets` for the operator to
 * fill (see rosterToDrafts in TruckStackPlanner.tsx). Company / origin / destination are read
 * where present and flagged where absent — never invented.
 *
 * Pure module: no I/O, no config reads, no network. `parseCollectionRunRoster` returns
 * an EMPTY roster when the document has no collection-run table (e.g. a freeform manifest
 * or a plain single-drop quote), so the caller can fall through to another engine.
 */
import type { ExtractedTable, StructuredDocument } from "@/lib/conversion/types";
import {
  EMPTY_ROSTER,
  type ConsignmentReviewField,
  type ConsignmentRoster,
  type ReadConsignmentDraft,
} from "@/lib/groupage/consignment-reader.types";
import type { GroupagePallet, PalletFootprintClass } from "@/lib/groupage/groupage.types";
import {
  readCargoSummaryWeights,
  matchCompany,
  findIndex,
  isPalletCountHeader,
} from "@/lib/groupage/cargo-summary-weights";
import { UK_POSTCODE, normalisePostcode } from "@/lib/geo/postcode";

/** The company/site column of the collection run. */
const isCompanyHeader = (h: string): boolean => /\b(compan|site|shipper|customer|consignor)/i.test(h);
/**
 * A row that SUMS the rows above it rather than naming a consignment — "Totals", "GRAND TOTAL".
 *
 * On docs/quotation-pdf-examples/02-groupage/intermediate-trunk-stops/stops-single-company.pdf the
 * sheet's "Totals" line was read as a fourth company, carrying the summed pallet count — so a 9-pallet
 * run quoted as 18 pallets across a customer named "Totals". Matched anywhere in the row, since the
 * label may sit in the company column or the line-number column depending on the sheet.
 */
const TOTALS_ROW = /^\s*(sub-?)?totals?\b|^\s*grand\b/i;
const isTotalsRow = (row: readonly (string | undefined)[]): boolean =>
  row.some((c) => typeof c === "string" && TOTALS_ROW.test(c.trim()));

/**
 * Find a cargo-summary key that the collection-run cell NAMES OUTRIGHT.
 *
 * `matchCompany` aligns company names against each other, which is the right tool when both tables
 * name the company. But a sheet may key its cargo summary by SITE instead — one-company.pdf lists
 * "Site A (Parts Store)" against the weights, while the collection run calls the same consignment
 * "Marlowe Distribution Ltd — Site A (Parts Store), Contact: …". Those two are not the same *company
 * name*, so the aligner correctly refuses them — yet the sheet plainly connects them: the key is
 * sitting inside the cell, word for word.
 *
 * So this is the last resort, and it is a strict one: the summary's key must appear verbatim (bar
 * punctuation and spacing) in the collection cell. Longest key first, so "Site A (Parts Store)" is
 * preferred over a shorter key that happens to be a prefix of it. No fuzziness — a weight attached to
 * the wrong consignment is worse than a weight left blank, which the operator would at least be asked
 * to fill in.
 */
function keyNamedInside(cellText: string, keys: readonly string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const haystack = norm(cellText);
  if (haystack === "") return null;
  return (
    [...keys]
      .sort((a, b) => b.length - a.length)
      .find((key) => {
        const needle = norm(key);
        return needle !== "" && haystack.includes(needle);
      }) ?? null
  );
}
/** The collection-address column (carries the origin postcode). */
const isAddressHeader = (h: string): boolean => /address|postcode|location/i.test(h);
/** The pallet-size column ("Pallet Size (cm)") — its L×W gives the footprint class. */
const isPalletSizeHeader = (h: string): boolean => /pallet\s*size|size\s*\(cm\)|dimension/i.test(h);
/** A weight column ("Weight", "Weight (kg)", "Gross kg") — but NOT the "Pallet Size (cm)" column
 *  (dimensions in cm, never kg) and never a per-piece "carton" weight. Optional: most collection
 *  runs omit it, so weight stays blank for the operator (see readWeightKg / the loop below). */
const isWeightHeader = (h: string): boolean =>
  (/weight|\bkg\b|\bwt\b/i.test(h)) && !/size|dimension|\bcm\b|carton|piece|per\s*unit/i.test(h);
/** The destination-hub column of the HUB TRANSFER (line-haul) section. */
const isDestinationHubHeader = (h: string): boolean => /destination\s*hub|outbound\s*hub|to\s*hub/i.test(h);

/** Footprint-class thresholds (base area, cm²). A standard UK/euro full pallet is 120×100
 *  or 120×80 (≥ 9 600 cm²); half ≈ a 100×60/80×60; quarter is smaller again. Base area,
 *  not volume — height doesn't change the floor space a pallet consumes. */
const FULL_MIN_AREA_CM2 = 8_000;
const HALF_MIN_AREA_CM2 = 4_000;
/** Default oversize-side threshold (cm) — the fallback this pure module uses when a caller passes
 *  no option. The live value is config-driven: `footprintClasses.oversize.lengthMm` in
 *  config/pallet-spec.json (the SAME size the 3D stacker packs an oversize pallet at), threaded in
 *  by every caller whose RESULT DEPENDS ON IT — i.e. the quoting path, RuleConsignmentReader.read()
 *  (rule-consignment-reader.ts). The ingestion pipeline calls this parser with no options on
 *  purpose: it reads only `originPostcode`, which no option can change (see ingestion.service.ts).
 *  A base side AT this size is already what the config calls "oversize", so the comparison below
 *  must be `>=`, not `>`, or a pallet stated at exactly the oversize size bills as a standard one. */
export const DEFAULT_OVERSIZE_SIDE_CM = 240;

/** Default sanity ceiling (kg) for a per-pallet weight CALCULATED from the GROUPAGE cargo summary
 *  (`total ÷ pallet count`, below). A palletised groupage load rarely exceeds ~1.5 t/pallet, and the
 *  ceiling sits above that on purpose: it is not the "normal" line, it is the point past which the
 *  summary's piece/qty figures are probably inconsistent with the pallet count. Beyond it the
 *  calculated weight is kept BUT flagged for the operator to confirm (never silently trusted, never
 *  blocked) — so a genuinely heavy pallet is quoted, not discarded. Read weights from a dedicated
 *  column are exempt — those are stated, not derived.
 *
 *  This is the fallback this pure module uses when a caller passes no option. The live value is
 *  config-driven — `maxPlausibleDerivedPalletKg` in config/groupage-rates.json — threaded in by the
 *  quoting path (RuleConsignmentReader.read()), the only caller whose result depends on it. Same
 *  reasoning as `oversizeSideCm` above.
 *
 *  NOT the same rule as item-assembler.ts's `palletDefaults.plausibleMinKg`/`plausibleMaxKg`
 *  (config/column-map.json), which sounds alike but guards a DIFFERENT derivation with a DIFFERENT
 *  failure mode: that one bounds a per-pallet weight worked out from a single manifest's own PROSE
 *  total ("Total: 266 pallets | 35,910 kg"), and a figure outside its band is DISCARDED entirely in
 *  favour of a config default — never kept-and-flagged like this one. Do not unify the two values. */
export const DEFAULT_MAX_PLAUSIBLE_DERIVED_PALLET_KG = 2_500;

/** Tunable knobs for the collection-run parse, sourced from config at the reader boundary. */
export interface CollectionRunParseOptions {
  /** Per-pallet kg above which a CALCULATED weight is flagged doubtful (kept, never blocked). */
  readonly maxPlausibleDerivedPalletKg?: number;
  /** Base-side length (cm) at/above which a pallet-size cell classifies as "oversize" — from
   *  config/pallet-spec.json's `footprintClasses.oversize.lengthMm`. */
  readonly oversizeSideCm?: number;
}

/** Pull the first UK postcode out of an address cell; null when there isn't one. */
function readPostcode(cell: string | undefined): string | null {
  if (typeof cell !== "string") return null;
  const m = cell.match(UK_POSTCODE);
  if (!m) return null;
  return normalisePostcode(m[0]);
}

/** Company name from the "Company / Contact" cell: the text before "Contact:" / a site
 *  suffix ("— Site A") / a phone number. Null when nothing readable remains. */
function readCompany(cell: string | undefined): string | null {
  if (typeof cell !== "string") return null;
  let name = cell.split(/contact\s*:/i)[0] ?? cell;
  name = name.split(/[—–]/)[0] ?? name; // drop a "— Site A (…)" suffix
  name = name.replace(/\+?\d[\d\s]{6,}\d/g, ""); // drop a stray phone number
  name = name.replace(/\s+/g, " ").trim();
  return name.length > 0 ? name : null;
}

/** First positive integer in the Pallets cell (e.g. "12"), or null when unreadable. */
function readPalletCount(cell: string | undefined): number | null {
  if (typeof cell !== "string") return null;
  const m = cell.match(/\d+/);
  if (!m) return null;
  const n = Number.parseInt(m[0], 10);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** First positive weight (kg) in a weight cell (e.g. "500", "1,200 kg", "750.5"), or null when
 *  unreadable/absent. Thousands commas are stripped; a leading pallet-count is not a concern
 *  because this only ever reads the dedicated weight column. Read as the PER-PALLET weight — the
 *  same thing the operator's "Weight (kg)" box means — so the truck total is never understated. */
function readWeightKg(cell: string | undefined): number | null {
  if (typeof cell !== "string") return null;
  const m = cell.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Does this weight cell state a PER-UNIT rate rather than the pallet's weight? The sheet says so
 * itself, in the cell: "16 kg/unit", "12 kg/carton", "18 kg/bundle".
 *
 * That distinction is worth thousands of kilos. On high-volume-two-stops.pdf a line reads
 * "16 kg/unit" against QTY 150 over 6 pallets. Taken at face value the pallet weighs 16 kg; read as
 * the rate it actually is, it weighs 16 × 150 ÷ 6 = 400 kg — exactly what that same sheet's
 * "WEIGHT / PALLET" column independently states. The whole run was quoted at 312 kg instead of
 * 19,500 kg: a 60× under-read, on a truck that would have gone out grossly overweight.
 *
 * The denominator is printed on the cell. We only have to stop ignoring it.
 */
// The DENOMINATOR is whatever the goods happen to be counted in — "kg/unit", "kg/carton", but also
// "kg/section", "kg/bracket", "kg/frame". Listing the nouns is a losing game; the slash is the tell.
// "kg/pallet" is excluded, because a per-pallet rate is already the number we want and multiplying it
// by a piece count would inflate the load instead of correcting it.
const PER_UNIT_RATE = /\/\s*(?!pallets?\b)[a-z]{2,}|\bper\s+(?!pallets?\b)[a-z]{2,}/i;
const isPerUnitRate = (cell: string | undefined): boolean =>
  typeof cell === "string" && PER_UNIT_RATE.test(cell);

/** The piece/unit-count column that a per-unit weight rate has to be multiplied by. */
const isQuantityHeader = (h: string): boolean =>
  /\bqty\b|\bquantit/i.test(h) && !/pallet/i.test(h);

/** Read a plain count ("1,425", "150 units"). */
function readCount(cell: string | undefined): number | null {
  if (typeof cell !== "string") return null;
  const m = cell.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Classify a "L x W x H (H)" pallet-size cell by its base (L×W) footprint. Defaults to
 *  "full" when the size is absent or unparseable — the same safe default the LLM reader
 *  and the manual form use (a stated-but-unreadable size is never dropped). */
function classifyFootprint(cell: string | undefined, oversizeSideCm: number): PalletFootprintClass {
  if (typeof cell !== "string") return "full";
  const nums = (cell.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => n > 0);
  if (nums.length < 2) return "full";
  const [l, w] = nums; // "L x W x H" — first two are the base footprint
  // >= , not > : a pallet stated at EXACTLY the oversize side is already what the config calls
  // oversize (config/pallet-spec.json's oversize.lengthMm is the boundary itself, not a value past it).
  if (l! >= oversizeSideCm || w! >= oversizeSideCm) return "oversize";
  const area = l! * w!;
  if (area >= FULL_MIN_AREA_CM2) return "full";
  if (area >= HALF_MIN_AREA_CM2) return "half";
  return "quarter";
}

/** True when a table's headers look like a collection run: a company column AND a plain
 *  pallet-COUNT column. The per-piece "Consolidated Cargo Summary" has neither (it uses
 *  "Qty (units)", not "Pallets"), so it is never mistaken for the collection run. */
function isCollectionRunTable(table: ExtractedTable): boolean {
  return (
    findIndex(table.headers, isCompanyHeader) !== -1 &&
    findIndex(table.headers, isPalletCountHeader) !== -1 &&
    table.rows.length > 0
  );
}

/* ── Row continuation ────────────────────────────────────────────────────────────────────
 * A manifest cell holds several lines — the company's name, its contact, its phone; the street,
 * then the town + postcode. OCR flattens each of those lines into its OWN table row, with every
 * other cell blank:
 *
 *   ["1", "Salford Textile Mills Ltd", "Regent Trading Estate", "6", "120 x 100 x 150 (H)"]
 *   ["",  "Contact: Nadia Yusuf",      "Salford, M5 4QH, UK",   "",  ""]      ← continuation
 *   ["",  "+44 161 872 3301",          "",                      "",  ""]      ← continuation
 *
 * Read row-by-row that is a disaster: company row 1 loses its POSTCODE (it sits on the next
 * line), and each continuation surfaces as a phantom company-less consignment. Both were live
 * bugs — every card came back flagged for a missing origin, the pallet totals were inflated by
 * the phantoms, and the leg-balance below could never match.
 *
 * So we rebuild the LOGICAL rows first: a row that starts a new entry begins a group; every
 * continuation row after it is folded into that group, cell by cell. Newline-joined, so the
 * downstream readers (postcode regex, `readCompany`'s "Contact:" split) see the whole cell.
 */

/** The leading ordinal column of a run table ("#", "Stop", "No."). Its cell is filled on a new
 *  entry and blank on a continuation line — the most reliable new-row marker when present. */
const isRowIndexHeader = (h: string): boolean => /^\s*(#|no\.?|stop|item|line)\s*$/i.test(h);

/**
 * Fold OCR continuation lines into the row they belong to. A new row starts where the ordinal
 * column is filled; with no ordinal column, where the pallet-COUNT column is filled (a real
 * entry always states its pallets — that is the column this parser exists to read). The first
 * row always starts a group, so a table can never lose its opening entry to a merge.
 */
function mergeContinuationRows(table: ExtractedTable): string[][] {
  const idxCol = findIndex(table.headers, isRowIndexHeader);
  const palletsCol = findIndex(table.headers, isPalletCountHeader);
  const markerCol = idxCol !== -1 ? idxCol : palletsCol;
  // No usable marker column ⇒ we can't tell a continuation from an entry. Leave the rows alone
  // rather than merge blind (a wrong merge silently welds two companies into one).
  if (markerCol === -1) return table.rows.map((r) => [...r]);

  const groups: string[][] = [];
  for (const row of table.rows) {
    const startsEntry = typeof row[markerCol] === "string" && row[markerCol]!.trim() !== "";
    const previous = groups[groups.length - 1];
    if (startsEntry || previous === undefined) {
      groups.push([...row]);
      continue;
    }
    for (let i = 0; i < row.length; i++) {
      const cell = typeof row[i] === "string" ? row[i]!.trim() : "";
      if (cell === "") continue;
      previous[i] = previous[i] ? `${previous[i]}\n${cell}` : cell;
    }
  }
  return groups;
}

/* ── Collection leg vs delivery leg ──────────────────────────────────────────────────────
 * A hub manifest describes the SAME freight twice: a COLLECTION RUN (pick up from N companies,
 * into the hub) and a DELIVERY RUN (out of the hub, to M companies). Both tables have a company
 * column and a Pallets column, so both look like a collection run to `isCollectionRunTable`.
 *
 * Reading both doubles the truck's load — 20 pallets collected + 20 delivered read as 40 — and
 * the delivery companies carry NO weight, because the Consolidated Cargo Summary is keyed by the
 * ORIGIN companies. That is why a hub manifest came back with half its cards unweighed.
 *
 * So when a document has both legs, only the COLLECTION leg becomes consignments: it is the leg
 * the cargo summary weighs, and its pallets are the freight the truck actually carries. A
 * delivery-only manifest (multi-drop out of one hub) still reads normally — the rule only fires
 * when both legs are present, so nothing is ever dropped without its mirror being read instead.
 */
const isDeliveryRunHeader = (h: string): boolean => /deliver|drop|consignee/i.test(h);
const isCollectionRunHeader = (h: string): boolean => /collect|pick\s*-?\s*up|origin|shipper/i.test(h);
const tableLeg = (table: ExtractedTable): "collection" | "delivery" | "unknown" => {
  const headers = table.headers.filter((h): h is string => typeof h === "string");
  if (headers.some(isDeliveryRunHeader)) return "delivery";
  if (headers.some(isCollectionRunHeader)) return "collection";
  return "unknown";
};

/** Read the destination-hub postcode from the HUB TRANSFER section (shared by every
 *  consignment on the trunk). Null when the document names no such hub. */
function readDestinationHubPostcode(doc: StructuredDocument): string | null {
  for (const page of doc.pages) {
    for (const table of page.tables) {
      const idx = findIndex(table.headers, isDestinationHubHeader);
      if (idx === -1) continue;
      for (const row of table.rows) {
        const pc = readPostcode(row[idx]);
        if (pc) return pc;
      }
    }
  }
  return null;
}

/**
 * Parse a groupage collection-run manifest into a roster of consignments — one per
 * company row. Returns EMPTY_ROSTER when the document has no collection-run table, so a
 * chain reader can fall through to the LLM engine for freeform manifests.
 */
export function parseCollectionRunRoster(
  doc: StructuredDocument,
  options: CollectionRunParseOptions = {},
): ConsignmentRoster {
  const maxPlausibleDerivedPalletKg =
    options.maxPlausibleDerivedPalletKg ?? DEFAULT_MAX_PLAUSIBLE_DERIVED_PALLET_KG;
  const oversizeSideCm = options.oversizeSideCm ?? DEFAULT_OVERSIZE_SIDE_CM;
  // ALL collection-run tables, not just the first — a long run can be split across a
  // page break into two tables (both with a company + Pallets column). Taking only the
  // first would silently drop the rest (a fail-loud violation). Columns are resolved
  // per table because a paginated second table may repeat the headers in a different order.
  const runTables = doc.pages.flatMap((p) => p.tables).filter(isCollectionRunTable);
  if (runTables.length === 0) return EMPTY_ROSTER;

  // Two-leg hub manifest ⇒ read the COLLECTION leg only (see the leg note above): the delivery
  // table is the same freight going out, and it is the collection companies the cargo summary
  // weighs. With only one leg present, whatever is there is the freight — read it as before.
  const collectionTables = runTables.filter((t) => tableLeg(t) === "collection");
  const deliveryTables = runTables.filter((t) => tableLeg(t) === "delivery");
  const twoLeg = collectionTables.length > 0 && deliveryTables.length > 0;
  const tables = twoLeg ? collectionTables : runTables;
  const notes = twoLeg
    ? [
        "This manifest lists the load twice — once as a collection run into the hub, once as a " +
          "delivery run out of it. The truck carries those pallets once, so I've read the " +
          "collection companies only. Their weights come from the manifest's cargo summary; the " +
          "delivery side states none.",
      ]
    : undefined;

  const destinationPostcode = readDestinationHubPostcode(doc);
  // Per-company total weight (kg) summed from the CONSOLIDATED CARGO SUMMARY (unit weight × qty).
  // Used only to CALCULATE a per-pallet weight when the collection run states no weight column —
  // the authoritative pallet COUNT still comes from the Pallets column, never from here.
  const cargoWeights = readCargoSummaryWeights(doc);
  const cargoWeightKeys = [...cargoWeights.keys()];
  const consignments: ReadConsignmentDraft[] = [];

  for (const table of tables) {
    const companyIdx = findIndex(table.headers, isCompanyHeader);
    const addressIdx = findIndex(table.headers, isAddressHeader);
    const palletsIdx = findIndex(table.headers, isPalletCountHeader);
    const sizeIdx = findIndex(table.headers, isPalletSizeHeader);
    const weightIdx = findIndex(table.headers, isWeightHeader);
    const qtyIdx = findIndex(table.headers, isQuantityHeader);

    for (const row of mergeContinuationRows(table)) {
      // A "Totals" line is not a company. Left in, it becomes a consignment of its own whose pallet
      // count is the sum of all the real ones — so a 9-pallet run reads as 18, on a roster that also
      // shows a phantom customer called "Totals". Skipped here, at the row level, because the sum it
      // restates is already accounted for by the rows above it.
      if (isTotalsRow(row)) continue;

      const company = readCompany(row[companyIdx]);
      const originPostcode = addressIdx === -1 ? null : readPostcode(row[addressIdx]);
      const count = readPalletCount(row[palletsIdx]);
      const footprint = classifyFootprint(sizeIdx === -1 ? undefined : row[sizeIdx], oversizeSideCm);

      // Weight, in priority order:
      //   1. a dedicated weight column on the collection run — read verbatim, UNLESS the cell states
      //      a per-unit RATE ("16 kg/unit"), in which case it is multiplied by the row's quantity and
      //      spread across its pallets, exactly as the cell's own denominator instructs; else
      //   2. CALCULATED from the CONSOLIDATED CARGO SUMMARY — the company's total weight
      //      (Σ unit-weight × qty) divided across its pallet count. The truck total is exact
      //      however the load splits between pallets, which is all groupage pricing needs.
      // Only when NEITHER is present does weight stay blank + flagged for the operator to fill.
      // (Reading per-piece weight to SUM a consignment weight is standard; it is NOT the
      // "count cartons as pallets" trap — the pallet COUNT still comes from the Pallets column.)
      const rawWeight = weightIdx === -1 ? undefined : row[weightIdx];
      const readRate = readWeightKg(rawWeight);
      const rowQty = qtyIdx === -1 ? null : readCount(row[qtyIdx]);
      let columnWeightKg: number | null = readRate;
      if (readRate !== null && isPerUnitRate(rawWeight)) {
        // "16 kg/unit" × 150 units ÷ 6 pallets = 400 kg a pallet. Without the quantity we cannot
        // honour the rate, and taking 16 kg as the pallet's weight would under-read the load 60-fold —
        // so we refuse it and leave the weight blank for the operator rather than quote a number we
        // know to be wrong.
        columnWeightKg =
          rowQty !== null && count !== null && count > 0 ? (readRate * rowQty) / count : null;
      }
      let derivedWeightKg: number | null = null;
      let derivedIsDoubtful = false;
      if (columnWeightKg === null && company !== null && count !== null && count > 0) {
        // Match on the CLEANED company name first, then fall back to the raw cell.
        //
        // The two tables don't always agree on what to call a consignment. On one-company.pdf the
        // collection run says "Marlowe Distribution Ltd — Site A (Parts Store), Contact: …" while the
        // cargo summary keys the very same load as just "Site A (Parts Store)" — one company, three
        // sites. Matching only the extracted company name ("Marlowe Distribution Ltd") finds nothing
        // in the summary, so every pallet came back weighing 0 kg and the whole 1,430 kg run priced as
        // empty. The site name was in the cell all along; the raw text simply has to be offered too.
        const rawCell = (row[companyIdx] ?? "").replace(/\s+/g, " ").trim();
        const key =
          matchCompany(company, cargoWeightKeys) ??
          matchCompany(rawCell, cargoWeightKeys) ??
          keyNamedInside(rawCell, cargoWeightKeys);
        const total = key === null ? undefined : cargoWeights.get(key);
        if (total !== undefined && total > 0) {
          // Per-pallet = company total ÷ pallet count, rounded to a clean kg the operator can read.
          const perPallet = Math.round(total / count);
          if (perPallet > 0) {
            derivedWeightKg = perPallet;
            // Keep an implausibly heavy per-pallet figure but mark it doubtful so it's confirmed,
            // not silently priced (the summary's qty likely disagrees with the pallet count).
            derivedIsDoubtful = perPallet > maxPlausibleDerivedPalletKg;
          }
        }
      }
      const weightKg = columnWeightKg ?? derivedWeightKg;
      const pallets: GroupagePallet[] = [{ footprint, weightKg: weightKg ?? 0, quantity: count ?? 1 }];

      const needsReview: ConsignmentReviewField[] = [];
      if (company === null) needsReview.push("company");
      if (originPostcode === null) needsReview.push("originPostcode");
      if (destinationPostcode === null) needsReview.push("destinationPostcode");
      // Flag the pallet line when weight is UNKNOWN (neither read nor calculated), a calculated
      // weight is physically doubtful, OR the pallet COUNT itself could not be read — a smudged/
      // blank Pallets cell silently became "1" below, and quoting a 12-pallet consignment as one
      // is worse than an unweighed line, so it MUST be surfaced too. A confidently-read or
      // cleanly-calculated, plausible weight+count needs no ⚠ and adds on a single confirm.
      if (weightKg === null || derivedIsDoubtful || count === null) needsReview.push("pallets");

      // Skip a wholly-empty row (a stray separator line) rather than surface a blank card.
      if (company === null && originPostcode === null && count === null) continue;

      consignments.push({ company, originPostcode, destinationPostcode, pallets, needsReview });
    }
  }

  return notes
    ? { consignments: mergeComplementaryViews(consignments), notes }
    : { consignments: mergeComplementaryViews(consignments) };
}

/**
 * Fuse the two VIEWS a manifest can give of the same consignment.
 *
 * A groupage sheet often states each company twice, in two tables that answer different questions:
 * the collection run says WHERE to collect (company, address, pallet count) and the consolidated cargo
 * summary says WHAT it weighs (company, pallet count, weight). Read naively, the same three companies
 * come back as six consignments and a 9-pallet truck is quoted as 18 — the load double-booked and the
 * price doubled with it (docs/quotation-pdf-examples/02-groupage/hub-and-trunk/multi-company-no-stops.pdf).
 *
 * Two rows are fused only when they are genuinely COMPLEMENTARY: same company, same pallet count, and
 * each supplies exactly what the other lacks (one has the origin postcode, the other the weight). That
 * is deliberately strict, because the same company legitimately appears more than once on other
 * sheets — one-company.pdf lists ONE company collecting from THREE sites, each with its own postcode
 * and pallet count. Those rows conflict rather than complement, so they are left alone, as they must be.
 */
function mergeComplementaryViews(consignments: ReadConsignmentDraft[]): ReadConsignmentDraft[] {
  const out: ReadConsignmentDraft[] = [];

  const palletsOf = (c: ReadConsignmentDraft) => c.pallets.reduce((n, p) => n + p.quantity, 0);
  const weightOf = (c: ReadConsignmentDraft) => c.pallets.reduce((n, p) => n + p.weightKg * p.quantity, 0);

  for (const next of consignments) {
    const match = out.find((prev) => {
      if (prev.company === null || next.company === null) return false;
      if (matchCompany(next.company, [prev.company]) === null) return false;
      if (palletsOf(prev) !== palletsOf(next)) return false;
      // Complementary, not duplicate: exactly one side knows the origin, exactly one knows the weight.
      const originComplements =
        (prev.originPostcode === null) !== (next.originPostcode === null);
      const weightComplements = (weightOf(prev) === 0) !== (weightOf(next) === 0);
      return originComplements && weightComplements;
    });

    if (match === undefined) {
      out.push(next);
      continue;
    }

    // Keep whichever side actually knows each fact, and re-derive the review flags from the fused
    // result — a field that was missing on one view is no longer missing once the other supplies it.
    const weighted = weightOf(match) > 0 ? match : next;
    const merged: ReadConsignmentDraft = {
      company: match.company ?? next.company,
      originPostcode: match.originPostcode ?? next.originPostcode,
      destinationPostcode: match.destinationPostcode ?? next.destinationPostcode,
      pallets: weighted.pallets,
      needsReview: [...new Set([...match.needsReview, ...next.needsReview])].filter((f) => {
        if (f === "originPostcode") return (match.originPostcode ?? next.originPostcode) === null;
        // "pallets" is re-derived from the FUSED result, not carried over blind — a weight that was
        // missing on one view is no longer missing once the other supplies it. But `weighted` (the
        // side the fused pallets/quantity come from) may ITSELF have an unreadable pallet count —
        // that cause has nothing to do with weight, and merging must never launder it away. Only a
        // "pallets" flag pushed for a weight-related reason predates this: `weighted.needsReview`
        // still carrying "pallets" despite a known weight can only mean the count (or a doubtful
        // derived weight) is why it was flagged, so it must survive the merge.
        if (f === "pallets") return weightOf(weighted) === 0 || weighted.needsReview.includes("pallets");
        return true;
      }),
    };
    out[out.indexOf(match)] = merged;
  }

  return out;
}
