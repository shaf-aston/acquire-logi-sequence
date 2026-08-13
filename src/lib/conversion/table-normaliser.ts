/**
 * TABLE NORMALISER — repairs the two ways a scanned manifest's table comes back mis-framed, before
 * anything downstream tries to read meaning out of it.
 *
 * A markdown table says "the first line is the header". Real quotation scans routinely break that,
 * and Mistral faithfully reproduces what it sees:
 *
 *   1. A SECTION BANNER sits on top, so the banner becomes the "header":
 *        | STOP 1: Cardiff Bay Homeware Ltd | | | 123 Tresillian Way, Cardiff, CF10 5BF | ... |
 *        | # | Item Description | Material | H | W | D | Qty | Wt |     <- the REAL header, now a body row
 *        | 1 | Wine Glasses | Borosilicate Glass | 30 | 120 | 100 | 200 | 48 |
 *      Every column then resolves against the banner instead of the header. `resolveColumnIndices`
 *      finds nothing, silently falls back to FIXED column positions, and reads a weight as a
 *      dimension. On docs/quotation-pdf-examples/03-manifest-variants/route-plan/detailed.pdf that
 *      turned a 2,565 kg job into a 760,535 kg one — a confident, silent, 300× wrong quote.
 *
 *   2. The table runs over several SECTIONS in one grid, each re-stating the header and introducing
 *      itself with a banner + an address row:
 *        | Stop Total: 122 kg |  |  |  |  |
 *        | STOP 2: Midlands Electrical | | | | |          <- which stop the following rows belong to
 *        | 45 Fort Parkway, Birmingham, B24 9FD, UK | | | | |   <- the delivery address for that stop
 *        | Item | Description | Material | Qty | Weight (kg) |  <- the header again, as data
 *      The repeated header rows get read as cargo, and the stop names + addresses — the only place
 *      the drops are stated on that sheet — are never seen, so the job reads as having no deliveries.
 *
 * WHAT THIS DOES. It re-frames the grid and hands the recovered context on, rather than throwing it
 * away: promote the true header row, lift the banners out of the body into `sections` (each knowing
 * which rows it owns, so a row can be attributed to its stop), and drop the repeated header rows.
 *
 * WHAT IT REFUSES TO DO. It never invents a header. A table whose header genuinely never made it
 * through the scan is marked `headerless` and left alone — see `resolveColumnIndices`' fixed-index
 * fallback, which is a GUESS, and a guess is what produced the 760-tonne quote. Downstream must
 * treat `headerless` as "I could not read this table", never as "read it positionally and hope".
 *
 * Pure and config-injected: the vocabulary of what a column heading looks like comes from
 * `config/column-map.json` (`headerPatterns`) via the caller — this module hardcodes no column names.
 */
import type { ExtractedTable, TableRow, TableSection } from "@/lib/conversion/types";

/** Column-heading vocabulary, injected. Values are the `headerPatterns` regexes from column-map.json. */
export type HeaderVocabulary = readonly RegExp[];

/**
 * A row is a header only if it names at least this many DIFFERENT columns. One hit is not enough: a
 * banner reading "STOP 1: …" matches the `stop` pattern on its own and would otherwise pass as a
 * header. Real headers name many columns at once (#, Description, Material, H, W, Qty, Weight…).
 */
const MIN_HEADER_HITS = 3;

/** Rows this far into the body may be promoted to header. A banner is a line or two; beyond that we
 *  are no longer repairing a mis-framed table, we are hunting for one, and would start eating cargo. */
const MAX_PROMOTE_DEPTH = 4;

const NUMERIC_CELL = /^[\s£$€]*[\d.,]+\s*(kg|cm|mm|m|t|pcs|units?|boxes?|pallets?)?\s*$/i;

const isBlank = (c: string): boolean => c.trim() === "";

/** Cells that are pure figures. A header labels columns; a data row fills them with numbers. */
function dataLikeness(row: TableRow): number {
  const filled = row.filter((c) => !isBlank(c));
  if (filled.length === 0) return 1;
  return filled.filter((c) => NUMERIC_CELL.test(c.trim())).length / filled.length;
}

/** How many distinct column headings this row names — with a data-heavy row disqualified outright. */
function headerScore(row: TableRow, vocab: HeaderVocabulary): number {
  // A cargo line can accidentally name columns ("Pallet of Wine Glasses" matches /pallet/, "2,800 pcs"
  // matches /pcs/), so vocabulary alone would promote a data row to header. Numbers are the tell.
  if (dataLikeness(row) > 0.3) return 0;
  return vocab.filter((rx) => row.some((cell) => !isBlank(cell) && rx.test(cell))).length;
}

/** The `stop`/`drop` pattern names the ONE column vocabulary a genuine banner text can legitimately
 *  match ("STOP 2: Midlands Electrical"). Excluding it from the positive-evidence check below stops a
 *  real banner from being spared just because it happens to say "stop". */
function isBannerVocabPattern(rx: RegExp): boolean {
  return /stop|drop/i.test(rx.source);
}

/**
 * A banner: one piece of text spanning an otherwise empty row ("STOP 2: Midlands Electrical", or the
 * address line under it). It carries the section's identity, which is why it must be preserved rather
 * than dropped — on a route-plan sheet it is the ONLY statement of the delivery address.
 *
 * The trap this must avoid is a SPARSE CARGO ROW — a real item whose dimensions were left blank
 * ("| 5 | Widget |  |  |  |"), including manifests whose FIRST column is the description rather than a
 * line number ("| Wine Glasses |  |  |  | 200 |"). Column position is not proof of anything; a banner
 * carries no cargo values, a cargo row does. So before demoting a sparse row to a banner, require
 * POSITIVE evidence it is one: a filled cell that is itself a NUMERIC cargo value ("200", "48 kg") AND
 * sits under a header that names a genuine cargo column (qty/weight/H/W/…). Prose text is not evidence
 * even when it sits under a cargo-vocabulary column — the description column is itself cargo
 * vocabulary (matches /description/), so a banner's own free text in cell 0 would otherwise "prove"
 * itself cargo just by being under an "Item Description" header. Requiring the cell to be NUMERIC closes
 * that hole: a banner never carries a figure, only prose. Only once numeric evidence is absent do we
 * fall back to the leading-cell heuristic (blank/numeric lead ⇒ not a banner) to catch the ordinary
 * "opens with words" case.
 *
 * Residual ambiguity (flagged, not silently resolved): a sparse cargo row whose ONLY filled cell is a
 * bare description ("| Wine Glasses |  |  |  |  |", no qty/weight scanned at all) is structurally
 * IDENTICAL to a banner — both are "one piece of prose spanning an otherwise empty row". Nothing in the
 * row itself distinguishes "an item we only caught the name of" from "a stop banner". This function
 * resolves that case as a banner (favouring the documented failure mode: a lost address is silent and
 * total, a lost description-only line item is a rarer, partial loss). If real manifests are found to
 * carry no-numeric description-only cargo rows, this needs a different signal (e.g. row position
 * relative to a known header), not a guess here.
 */
function isBannerRow(row: TableRow, headers: TableRow, vocab: HeaderVocabulary): boolean {
  if (row.length <= 2) return false;
  const filled = row.filter((c) => !isBlank(c));
  if (filled.length > 2) return false;

  const cargoVocab = vocab.filter((rx) => !isBannerVocabPattern(rx));
  const hasCargoEvidence = row.some((cell, i) => {
    if (isBlank(cell)) return false;
    const trimmed = cell.trim();
    if (!NUMERIC_CELL.test(trimmed)) return false; // prose is never evidence, even under a cargo header
    const header = (headers[i] ?? "").trim();
    if (header === "") return false;
    return cargoVocab.some((rx) => rx.test(header));
  });
  if (hasCargoEvidence) return false; // a real cargo column carries a NUMERIC value here ⇒ cargo

  const lead = (row[0] ?? "").trim();
  if (lead === "" || NUMERIC_CELL.test(lead)) return false; // blank or a line number ⇒ not a banner
  return lead.length > 3;
}

/** Two rows naming the same columns — i.e. the header, re-stated for a new section. */
function sameRow(a: TableRow, b: TableRow): boolean {
  const norm = (r: TableRow) => r.map((c) => c.trim().toLowerCase()).join("");
  return norm(a) === norm(b);
}

/**
 * Re-frame one table: find its real header, lift its section banners out of the body, and drop the
 * repeated headers. Returns the table unchanged when its header is already sound — the overwhelmingly
 * common case, and the one this must never disturb.
 */
export function normaliseTable(table: ExtractedTable, vocab: HeaderVocabulary): ExtractedTable {
  if (vocab.length === 0) return table; // no vocabulary injected ⇒ no opinion; leave it exactly as-is.

  let headers = table.headers;
  let body = table.rows;
  const caption: string[] = [];
  // Set only by the promotion branch below, when a real header was PROVEN to exist in the body. A
  // table that entered this function already `headerless` (markdown-table.parser.ts lost the '|---|'
  // separator) must not stay marked that way once its header has actually been recovered — otherwise
  // table-selector.ts rejects a table this function just successfully repaired.
  let headerRecovered = false;

  // 1. The header is not a header. Look just below it for the real one — a banner is a line or two.
  if (headerScore(headers, vocab) < MIN_HEADER_HITS) {
    let bestIdx = -1;
    let bestScore = MIN_HEADER_HITS - 1;
    for (let i = 0; i < Math.min(MAX_PROMOTE_DEPTH, body.length); i++) {
      const score = headerScore(body[i] as TableRow, vocab);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      // No header here and none below it. Say so loudly; do not let anyone read this by position.
      return { ...table, headerless: true };
    }

    // Everything above the real header was context (a banner, a letterhead). Keep the text.
    for (const row of [headers, ...body.slice(0, bestIdx)]) {
      const text = row.filter((c) => !isBlank(c)).join(" ").trim();
      if (text !== "") caption.push(text);
    }
    headers = body[bestIdx] as TableRow;
    body = body.slice(bestIdx + 1);
    headerRecovered = true;
  }

  // 2. Walk the body: pull out banners and repeated headers, keep the cargo.
  const rows: TableRow[] = [];
  const sections: TableSection[] = [];
  let pending: string[] = [];

  for (const row of body) {
    if (sameRow(row, headers)) continue; // the header, re-stated for a new section — not cargo

    if (isBannerRow(row, headers, vocab)) {
      const text = row.filter((c) => !isBlank(c)).join(" ").trim();
      if (text !== "") pending.push(text);
      continue;
    }

    if (pending.length > 0) {
      // The banner lines we just collected introduce THIS row and the ones after it.
      sections.push({ lines: pending, startRow: rows.length });
      pending = [];
    }
    rows.push(row);
  }
  // Trailing banners (a "Stop Total:" footer, say) own no rows. Keep the text — a total is a fact the
  // operator may want to reconcile against — but anchor it past the end so it claims no cargo.
  if (pending.length > 0) sections.push({ lines: pending, startRow: rows.length });

  const { headerless: _staleHeaderless, ...rest } = table; // deliberately dropped, not spread through

  return {
    ...(headerRecovered ? rest : table),
    headers,
    rows,
    ...(caption.length > 0 ? { caption } : {}),
    ...(sections.length > 0 ? { sections } : {}),
  };
}
