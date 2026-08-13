/**
 * Pickup/delivery address detection — the seam for "intelligent multi-stop
 * recognition". Scans an already-ingested `StructuredDocument` for lines that
 * carry both a UK postcode and a pickup/drop label, and classifies each one.
 *
 * Deliberately simple (label word-match + postcode regex, no NLP): a smarter
 * detector (e.g. an LLM pass) can replace `detectAddresses` behind this same
 * `(document, config) => DetectedAddresses` shape without touching callers.
 *
 * PURE — no I/O, no logging. Config is loaded separately via
 * `loadAddressDetectionConfig` and passed in.
 */
import { resolve } from "node:path";
import { getConfig } from "@/config/env";
import { loadJsonFile } from "@/lib/packing/config-loader";
import type { StructuredDocument } from "@/lib/conversion/types";

export interface CustomerProfile {
  readonly name: string | null;
  readonly phone: string | null;
}

export interface DetectedAddresses {
  readonly pickup: string | null;
  readonly drops: readonly string[];
  readonly customer?: CustomerProfile;
  /**
   * All collection/pickup stop addresses in document order (table reader only). On a collection
   * round these ARE the run; `pickup`/`drops` are a derived [first, …rest] view of them. Optional
   * so the line-scan path and older callers are unaffected.
   */
  readonly pickups?: readonly string[];
  /**
   * All delivery stop addresses in document order (table reader only). Carried so the outbound
   * leg can pick the hub NEAREST these destinations, even on a collection sheet where the primary
   * run is the pickups. Optional (absent on the line-scan path).
   */
  readonly deliveries?: readonly string[];
}

export interface AddressDetectionConfig {
  readonly version: number;
  readonly pickupLabels: readonly string[];
  readonly dropLabels: readonly string[];
  readonly postcodePattern: string;
  readonly maxLineLength: number;
  /** Case-insensitive header regex marking a table's ADDRESS column — the trigger for table reading. */
  readonly addressColumnPattern: string;
  /** Case-insensitive header regex marking a per-row TYPE column (COLLECTION/DELIVERY) when present. */
  readonly typeColumnPattern: string;
  /** Case-insensitive header regex marking the company/contact column, for the stop's display label. */
  readonly companyColumnPattern: string;
  /** Case-insensitive header regex marking the destination/outbound hub column of a hub-transfer
   *  table — its cell's postcode seeds the trunk's destination when the sheet lists no delivery stops. */
  readonly outboundHubColumnPattern: string;
  /** Document-level phrases that mark a PDF as a collection/pickup round. Any hit ⇒ direction "collect". */
  readonly collectionSignals: readonly string[];
}

/** Which way the job runs: collect from many origins into a hub, or deliver out to drops. */
export type Direction = "collect" | "deliver";

export class AddressDetectionError extends Error {
  constructor(message: string) {
    super(`[address-detection] ${message}`);
    this.name = "AddressDetectionError";
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type LabelKind = "pickup" | "drop";

interface LabelMatch {
  readonly kind: LabelKind;
  readonly label: string;
  readonly index: number;
  readonly end: number;
}

/** Find the longest matching label anywhere in `line` (word-boundary, case-insensitive). */
function findBestLabel(
  line: string,
  pickupLabels: readonly string[],
  dropLabels: readonly string[],
): LabelMatch | null {
  let best: LabelMatch | null = null;
  const candidates: Array<[LabelKind, readonly string[]]> = [
    ["pickup", pickupLabels],
    ["drop", dropLabels],
  ];
  for (const [kind, labels] of candidates) {
    for (const label of labels) {
      const re = new RegExp(`\\b${escapeRegExp(label)}\\b`, "i");
      const match = re.exec(line);
      if (!match) continue;
      if (!best || label.length > best.label.length) {
        best = { kind, label, index: match.index, end: match.index + match[0].length };
      }
    }
  }
  return best;
}

/**
 * Find EVERY label in `line`, not just the best one — a single prose sentence can name a pickup
 * AND a delivery ("collection from X … delivery to Y"), and each needs its own address, not one
 * merged blob. Overlapping matches at/near the same spot (e.g. "to" inside "deliver to") keep only
 * the longest, same tie-break as `findBestLabel`; results are left-to-right in document order.
 */
function findAllLabels(
  line: string,
  pickupLabels: readonly string[],
  dropLabels: readonly string[],
): LabelMatch[] {
  const raw: LabelMatch[] = [];
  const candidates: Array<[LabelKind, readonly string[]]> = [
    ["pickup", pickupLabels],
    ["drop", dropLabels],
  ];
  for (const [kind, labels] of candidates) {
    for (const label of labels) {
      const re = new RegExp(`\\b${escapeRegExp(label)}\\b`, "gi");
      for (const match of line.matchAll(re)) {
        raw.push({ kind, label, index: match.index, end: match.index + match[0].length });
      }
    }
  }
  raw.sort((a, b) => a.index - b.index || b.label.length - a.label.length);

  const accepted: LabelMatch[] = [];
  let coveredUntil = -1;
  for (const m of raw) {
    if (m.index < coveredUntil) continue; // starts inside an already-accepted (longer) label
    accepted.push(m);
    coveredUntil = m.end;
  }
  return accepted;
}

/** Strip a matched label prefix + markdown noise from a candidate address line. */
function cleanAddressText(line: string, label: LabelMatch | null): string {
  let text = label ? line.slice(0, label.index) + line.slice(label.end) : line;
  // Drop a leading separator left behind after removing the label (": ", "- ", etc).
  text = text.replace(/^[\s:.\-–—]+/, "");
  // Strip markdown noise characters.
  text = text.replace(/[*#`]/g, "").replace(/\|/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

function buildLines(document: StructuredDocument): string[] {
  const lines: string[] = [];
  for (const page of document.pages) {
    for (const raw of page.markdown.split(/\r?\n/)) {
      lines.push(raw);
    }
    for (const table of page.tables) {
      if (table.headers.length > 0) lines.push(table.headers.join(" "));
      for (const row of table.rows) lines.push(row.join(" "));
    }
  }
  return lines;
}

/** One stop read from a table row: its address (postcode-bearing) plus an optional company label. */
interface StopAddress {
  readonly address: string;
  readonly company: string | null;
}

/** Collapse markdown/whitespace noise in a table cell to one clean line. */
function tidyCell(cell: string | undefined): string {
  return (cell ?? "").replace(/\|/g, " ").replace(/[*#`]/g, "").replace(/\s+/g, " ").trim();
}

/** Company label = the text before "Contact"/a phone number in the company cell (else the whole cell). */
function companyOf(cell: string | undefined): string | null {
  let text = tidyCell(cell);
  if (!text) return null;
  text = text.split(/\bcontact\b/i)[0]!; // drop "Contact: Name +44…"
  text = text.replace(/\+?\d[\d\s]{6,}\d/g, "").replace(/[,;]+\s*$/, "").trim(); // drop phone/trailing sep
  return text.length > 0 ? text : null;
}

/** Kind of a cell/header value from the configured labels — longest match wins, null when unlabelled. */
function kindOfText(text: string, config: AddressDetectionConfig): LabelKind | null {
  return findBestLabel(text, config.pickupLabels, config.dropLabels)?.kind ?? null;
}

/** Dedupe a stop list case-insensitively by address, preserving first-seen order. */
function dedupeStops(stops: readonly StopAddress[]): StopAddress[] {
  const seen = new Set<string>();
  const out: StopAddress[] = [];
  for (const stop of stops) {
    const key = stop.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(stop);
  }
  return out;
}

/**
 * Read stops straight out of structured tables — the reliable path for table-formatted quotations
 * whose rows are too long/multi-field for the line scanner. A table is a stop list only if a header
 * matches `addressColumnPattern`; each row's kind comes from the TYPE column when present, else from
 * the address column's own header ("Collection Address" vs "Delivery Address"). Unlabelled rows are
 * skipped — never guessed. Cargo/hub/bill-to tables have no address-named column, so they're ignored.
 */
function readStopTables(
  document: StructuredDocument,
  config: AddressDetectionConfig,
): { pickups: StopAddress[]; deliveries: StopAddress[] } {
  const addrRe = new RegExp(config.addressColumnPattern, "i");
  const typeRe = new RegExp(config.typeColumnPattern, "i");
  const companyRe = new RegExp(config.companyColumnPattern, "i");
  const postcodeRe = new RegExp(config.postcodePattern);

  const pickups: StopAddress[] = [];
  const deliveries: StopAddress[] = [];

  for (const page of document.pages) {
    for (const table of page.tables) {
      // Deliberately NOT gated on `table.headerless`, unlike isItemTable (table-selector.ts).
      //
      // `headerless` means "no CARGO header could be proven" — table-normaliser scores a header row
      // against the packer's vocabulary (description / weight / qty / dimensions). A stop table's
      // headers are "Collection Address", "Type", "Company": real, meaningful headers that score
      // near zero on cargo words and so get marked headerless. Refusing them here cost us every
      // detected address on four of the example manifests — they still quoted the right weight, but
      // opened in the wrong planner, which is the exact bug class this reader exists to prevent.
      //
      // The flag is safe to ignore here because this reader NEVER resolves a column by position: it
      // requires an actual header-text match (addrRe, below) and skips the table when there is none.
      // A headerless table with no headers at all therefore falls out on its own, one line down.
      const headers = table.headers;
      const addrIdx = headers.findIndex((h) => addrRe.test(h));
      if (addrIdx === -1) continue; // not a stop table
      const typeIdx = headers.findIndex((h) => typeRe.test(h));
      const companyIdx = headers.findIndex((h, i) => i !== addrIdx && companyRe.test(h));
      const headerKind = kindOfText(headers[addrIdx] ?? "", config); // e.g. "Collection Address" ⇒ pickup

      for (const row of table.rows) {
        const address = tidyCell(row[addrIdx]);
        if (!address || !postcodeRe.test(address.toUpperCase())) continue;
        const rowKind = typeIdx !== -1 ? kindOfText(row[typeIdx] ?? "", config) : null;
        const kind = rowKind ?? headerKind;
        if (!kind) continue; // unlabelled row — never guess
        const company = companyIdx !== -1 ? companyOf(row[companyIdx]) : null;
        (kind === "pickup" ? pickups : deliveries).push({ address, company });
      }
    }
  }
  return { pickups: dedupeStops(pickups), deliveries: dedupeStops(deliveries) };
}

/**
 * Postcode of the destination/outbound hub named in a hub-transfer table (header matches
 * `outboundHubColumnPattern`), or null when the sheet has no such table. Used to aim the trunk's
 * destination when a milk-round lists only its collection stops (no delivery addresses to be near).
 * Pure + fail-soft: returns the first postcode found in the outbound-hub column, never guesses.
 */
export function detectOutboundHubPostcode(
  document: StructuredDocument,
  config: AddressDetectionConfig,
): string | null {
  const hubRe = new RegExp(config.outboundHubColumnPattern, "i");
  const postcodeRe = new RegExp(config.postcodePattern);
  for (const page of document.pages) {
    for (const table of page.tables) {
      const idx = table.headers.findIndex((h) => hubRe.test(h));
      if (idx === -1) continue;
      for (const row of table.rows) {
        const cell = tidyCell(row[idx]);
        const match = postcodeRe.exec(cell.toUpperCase());
        if (match) return cell.slice(match.index, match.index + match[0].length).trim();
      }
    }
  }
  return null;
}

/**
 * Scan a structured document for pickup/delivery addresses. Tries the column-aware TABLE reader
 * first (reliable for table-formatted quotations); falls back to the label+postcode LINE scanner
 * for markdown/prose sheets. Fail-soft by contract: never throws — an unclassifiable stop is
 * skipped rather than guessed at.
 */
export function detectAddresses(
  document: StructuredDocument,
  config: AddressDetectionConfig,
): DetectedAddresses {
  const { pickups, deliveries } = readStopTables(document, config);
  if (pickups.length > 0 || deliveries.length > 0) {
    // Which list is the primary run depends on the sheet's direction: a collection round IS its
    // pickups (deliveries, if listed, only steer the outbound hub); a delivery run is pickup → drops.
    const direction = detectDirection(document, config.collectionSignals);
    const pickupAddrs = pickups.map((p) => p.address);
    const deliveryAddrs = deliveries.map((d) => d.address);
    const pickup = pickupAddrs[0] ?? null;
    let drops: string[];
    if (direction === "collect") {
      drops = pickupAddrs.slice(1);
    } else {
      const primaryDrops = deliveryAddrs.length > 0 ? deliveryAddrs : pickupAddrs.slice(1);
      drops = pickup ? primaryDrops.filter((d) => d.toLowerCase() !== pickup.toLowerCase()) : primaryDrops;
    }
    return { pickup, drops, pickups: pickupAddrs, deliveries: deliveryAddrs };
  }
  return detectFromLines(document, config);
}

/** The original label + postcode line scanner — the fallback for markdown/prose sheets. */
function detectFromLines(
  document: StructuredDocument,
  config: AddressDetectionConfig,
): DetectedAddresses {
  const postcodeRe = new RegExp(config.postcodePattern);

  let pickup: string | null = null;
  const dropsOrdered: string[] = [];
  const dropsSeen = new Set<string>();
  let lastLabelKind: LabelKind | null = null;

  const record = (kind: LabelKind, text: string): void => {
    if (!postcodeRe.test(text.toUpperCase())) return;
    const address = cleanAddressText(text, null);
    if (address.length === 0) return;

    if (kind === "pickup") {
      if (pickup === null) pickup = address;
      return;
    }
    const key = address.toLowerCase();
    if (pickup !== null && key === pickup.toLowerCase()) return;
    if (dropsSeen.has(key)) return;
    dropsSeen.add(key);
    dropsOrdered.push(address);
  };

  for (const rawLine of buildLines(document)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > config.maxLineLength) continue;

    // Every label on the line, in order — a prose sentence can name a pickup AND a delivery, so
    // each gets its own segment/kind/postcode rather than the whole line collapsing to one.
    const labels = findAllLabels(line, config.pickupLabels, config.dropLabels);

    if (labels.length === 0) {
      // No label here — an unlabeled postcode only counts under a kind carried from a prior line.
      if (lastLabelKind) record(lastLabelKind, line);
      continue;
    }

    // Text before the first label on this line belongs to whatever kind was last in force.
    if (lastLabelKind && labels[0]!.index > 0) {
      record(lastLabelKind, line.slice(0, labels[0]!.index));
    }
    for (let i = 0; i < labels.length; i++) {
      const start = labels[i]!.end;
      const end = i + 1 < labels.length ? labels[i + 1]!.index : line.length;
      record(labels[i]!.kind, line.slice(start, end));
    }
    lastLabelKind = labels[labels.length - 1]!.kind;
  }

  return { pickup, drops: dropsOrdered };
}

/**
 * Document-level direction hint: "collect" when the sheet reads as a pickup round
 * (any `collectionSignals` phrase appears), else "deliver". Pure + fail-soft — an
 * empty signal list simply always returns "deliver" (today's behaviour). This is a
 * separate pass from address extraction so it works whichever extractor is wired in.
 */
export function detectDirection(
  document: StructuredDocument,
  signals: readonly string[],
): Direction {
  if (signals.length === 0) return "deliver";
  const needles = signals.map((s) => s.toLowerCase());
  for (const rawLine of buildLines(document)) {
    const line = rawLine.toLowerCase();
    if (needles.some((n) => line.includes(n))) return "collect";
  }
  return "deliver";
}

function parseConfig(json: unknown): AddressDetectionConfig {
  if (typeof json !== "object" || json === null) {
    throw new AddressDetectionError("config must be a JSON object");
  }
  const obj = json as Record<string, unknown>;

  const version = typeof obj.version === "number" ? obj.version : 0;

  const labelArray = (key: string): string[] => {
    const value = obj[key];
    if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
      throw new AddressDetectionError(`"${key}" must be a non-empty array of strings`);
    }
    return value as string[];
  };
  const pickupLabels = labelArray("pickupLabels");
  const dropLabels = labelArray("dropLabels");

  if (typeof obj.postcodePattern !== "string" || obj.postcodePattern.length === 0) {
    throw new AddressDetectionError('"postcodePattern" must be a non-empty string');
  }
  try {
    new RegExp(obj.postcodePattern);
  } catch {
    throw new AddressDetectionError(`"postcodePattern" is not a valid regex: ${obj.postcodePattern}`);
  }

  const {maxLineLength} = obj;
  if (typeof maxLineLength !== "number" || !Number.isFinite(maxLineLength) || maxLineLength <= 0) {
    throw new AddressDetectionError('"maxLineLength" must be a positive number');
  }

  // Table-column header patterns. Optional with sensible defaults so configs written before table
  // reading existed still parse. Each must be a valid regex (used case-insensitively on headers).
  const columnPattern = (key: string, fallback: string): string => {
    const value = obj[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value.length === 0) {
      throw new AddressDetectionError(`"${key}" must be a non-empty string`);
    }
    try {
      new RegExp(value);
    } catch {
      throw new AddressDetectionError(`"${key}" is not a valid regex: ${value}`);
    }
    return value;
  };
  const addressColumnPattern = columnPattern("addressColumnPattern", "address");
  const typeColumnPattern = columnPattern("typeColumnPattern", "^type|stop type");
  const companyColumnPattern = columnPattern("companyColumnPattern", "company|contact|origin");
  const outboundHubColumnPattern = columnPattern("outboundHubColumnPattern", "destination hub|outbound hub");

  // Optional — absent ⇒ no collection signals, so direction always resolves to "deliver"
  // (unchanged behaviour for sheets/configs written before this field existed).
  let collectionSignals: string[] = [];
  if (obj.collectionSignals !== undefined) {
    if (!Array.isArray(obj.collectionSignals) || !obj.collectionSignals.every((v) => typeof v === "string")) {
      throw new AddressDetectionError('"collectionSignals" must be an array of strings');
    }
    collectionSignals = obj.collectionSignals as string[];
  }

  return {
    version,
    pickupLabels,
    dropLabels,
    postcodePattern: obj.postcodePattern,
    maxLineLength,
    addressColumnPattern,
    typeColumnPattern,
    companyColumnPattern,
    outboundHubColumnPattern,
    collectionSignals,
  };
}

let cached: AddressDetectionConfig | null = null;

export async function loadAddressDetectionConfig(): Promise<AddressDetectionConfig> {
  if (cached) return cached;
  const path = resolve(process.cwd(), getConfig().ingest.addressDetectionPath);
  cached = await loadJsonFile(path, parseConfig, AddressDetectionError);
  return cached;
}

/** Test hook — parse a config object without touching disk or the cache. */
export function parseAddressDetectionConfigFrom(json: unknown): AddressDetectionConfig {
  return parseConfig(json);
}
