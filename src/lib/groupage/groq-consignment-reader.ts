/**
 * Groq-backed consignment-roster reader. Reads the whole OCR'd document with an LLM
 * and returns a ROSTER of consignments — several companies, each with its own origin,
 * destination, and pallet lines — for the shared-truck planner. Handles both a single
 * combined manifest (many companies in one doc) and a single-company quote (a roster
 * of one).
 *
 * Uses its OWN Groq key (CONSIGNMENT_GROQ_API_KEY), separate from the address
 * extractor's and the durability classifier's, so the three paths key and rotate
 * independently.
 *
 * Degrade-not-break, like GroqAddressExtractor: any failure — no key, network outage,
 * non-JSON reply, or a reply that fails validation — degrades to an EMPTY roster and
 * logs a warning. It never throws, so it can never fail the request. A GENUINE empty
 * result from a successful call is trusted (the document really carried no readable
 * consignment) rather than dressed up as a guess.
 *
 * Everything it returns is a SUGGESTION: each field the model couldn't fill or wasn't
 * sure of is flagged in `needsReview`, so the UI can force an operator to confirm it
 * before the consignment goes on a truck (never-guess surface).
 */
import { createLogger } from "@/lib/logger/logger";
import { getConfig, type AppConfig } from "@/config/env";
import { withRetry } from "@/lib/util/retry";
import {
  EMPTY_ROSTER,
  type ConsignmentReader,
  type ConsignmentRoster,
  type ConsignmentReviewField,
  type ReadConsignmentDraft,
} from "@/lib/groupage/consignment-reader.types";
import {
  PALLET_FOOTPRINT_CLASSES,
  type GroupagePallet,
  type PalletFootprintClass,
} from "@/lib/groupage/groupage.types";
import type { StructuredDocument } from "@/lib/conversion/types";
import { UK_POSTCODE, normalisePostcode } from "@/lib/geo/postcode";

const logger = createLogger("groupage.consignment-reader.groq");

type ConsignmentGroqConfig = AppConfig["consignmentReader"]["groq"];

/** Transient = network blips, rate limits, and 5xx. 4xx (bad key/payload) is not. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  return true;
}

class GroqHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GroqHttpError";
    this.status = status;
  }
}

const SYSTEM_PROMPT = `You extract a ROSTER OF CONSIGNMENTS from a UK logistics document that has been OCR'd to text.

The document is EITHER a single combined manifest listing SEVERAL companies' shipments, OR one company's quote. Return EVERY distinct consignment you find.

A consignment = one company shipping pallets from ONE origin to ONE destination.

For each consignment return:
- company: the company/customer name shipping it (null if genuinely absent — never invent one).
- originPostcode: the UK COLLECTION postcode only, not the whole address (null if absent).
- destinationPostcode: the UK DELIVERY postcode only (null if absent).
- pallets: an array of { "footprint", "weightKg", "quantity" }, one entry per pallet line.
    - footprint MUST be one of: "full", "half", "quarter", "oversize". If the size isn't stated, use "full".
    - weightKg is the weight of ONE pallet in that line (number). If not stated, use 0.
    - quantity is how many pallets of that line (number). If not stated, use 1.

Rules:
- GROUP rows by company + origin + destination: rows that share all three are ONE consignment with several pallet lines, not several consignments.
- Keep UK postcodes exactly as written.
- Never invent a company, postcode, weight, or pallet that is not in the text. Prefer null over a guess.
- If the document is a single company's quote, return a roster with exactly ONE consignment.

Respond with strict JSON only, no other text:
{"consignments":[{"company":"<name or null>","originPostcode":"<postcode or null>","destinationPostcode":"<postcode or null>","pallets":[{"footprint":"full","weightKg":250,"quantity":2}]}]}`;

export interface GroqRosterReply {
  readonly consignments?: unknown;
}

export class GroqConsignmentReader implements ConsignmentReader {
  readonly provider = "groq";

  async read(document: StructuredDocument): Promise<ConsignmentRoster> {
    const cfg = getConfig().consignmentReader.groq;
    if (!cfg.apiKey || !cfg.model) {
      logger.warn(
        "CONSIGNMENT_GROQ_API_KEY / CONSIGNMENT_GROQ_MODEL not set — returning an empty roster",
      );
      return EMPTY_ROSTER;
    }

    const text = flattenDocument(document, cfg.maxInputChars);
    if (text.trim().length === 0) return EMPTY_ROSTER;

    let reply: GroqRosterReply;
    try {
      reply = await withRetry(() => this.callGroq(text, cfg), {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.retryBaseDelayMs,
        isRetryable: isTransient,
        logger,
      });
    } catch (err) {
      logger.warn("groq roster read failed — returning an empty roster", { error: String(err) });
      return EMPTY_ROSTER;
    }

    const roster = parseReply(reply);
    if (!roster) {
      logger.warn("groq roster reply failed validation — returning an empty roster");
      return EMPTY_ROSTER;
    }

    logger.info("groq roster read complete", {
      consignments: roster.consignments.length,
      needingReview: roster.consignments.filter((c) => c.needsReview.length > 0).length,
    });
    return roster;
  }

  private async callGroq(text: string, cfg: ConsignmentGroqConfig): Promise<GroqRosterReply> {
    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new Error(`Groq request failed: ${String(err)}`);
    }

    if (!response.ok) {
      throw new GroqHttpError(`Groq request failed with status ${response.status}`, response.status);
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("Groq response missing message content");

    try {
      return JSON.parse(content) as GroqRosterReply;
    } catch {
      throw new Error("Groq response content is not valid JSON");
    }
  }
}

/** Flatten page markdown + table cells to a single text blob, capped at `maxChars`. */
function flattenDocument(document: StructuredDocument, maxChars: number): string {
  const parts: string[] = [];
  for (const page of document.pages) {
    if (page.markdown.trim().length > 0) parts.push(page.markdown);
    for (const table of page.tables) {
      if (table.headers.length > 0) parts.push(table.headers.join(" | "));
      for (const row of table.rows) parts.push(row.join(" | "));
    }
  }
  const text = parts.join("\n");
  if (text.length <= maxChars) return text;
  logger.warn("document text exceeds CONSIGNMENT_GROQ_MAX_INPUT_CHARS — truncating", {
    length: text.length,
    maxChars,
  });
  return text.slice(0, maxChars);
}

/** Trim a string field, returning null for empty/non-string. */
function cleanString(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/** Pull just the UK postcode out of a value that might be a full address; uppercased, single-spaced.
 *  Exported for unit testing the never-guess normalisation. */
export function cleanPostcode(raw: unknown): string | null {
  const s = cleanString(raw);
  if (s === null) return null;
  const m = s.match(UK_POSTCODE);
  if (!m) return s; // no recognisable postcode — keep what the model gave, flagged for review upstream
  return normalisePostcode(m[0]);
}

/** True when a cleaned postcode string actually looks like a UK postcode. */
function looksLikePostcode(pc: string | null): boolean {
  return pc !== null && UK_POSTCODE.test(pc);
}

const FOOTPRINT_SET = new Set<string>(PALLET_FOOTPRINT_CLASSES);

/** Validate one pallet line. Returns null if unusable (dropped, and the line flagged for review). */
function parsePallet(raw: unknown): GroupagePallet | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as { footprint?: unknown; weightKg?: unknown; quantity?: unknown };

  const footprint: PalletFootprintClass =
    typeof obj.footprint === "string" && FOOTPRINT_SET.has(obj.footprint)
      ? (obj.footprint as PalletFootprintClass)
      : "full";

  const weightKg = typeof obj.weightKg === "number" && Number.isFinite(obj.weightKg) && obj.weightKg >= 0
    ? obj.weightKg
    : 0;
  const quantity = typeof obj.quantity === "number" && Number.isFinite(obj.quantity) && obj.quantity >= 1
    ? Math.floor(obj.quantity)
    : 1;

  return { footprint, weightKg, quantity };
}

/** Validate + normalise the LLM reply into a roster. Returns null only if the top-level shape is
 *  unusable. Exported for unit testing (it carries the never-guess flagging + phantom-row skip). */
export function parseReply(reply: GroqRosterReply): ConsignmentRoster | null {
  if (typeof reply !== "object" || reply === null) return null;
  if (reply.consignments !== undefined && !Array.isArray(reply.consignments)) return null;
  const rows = Array.isArray(reply.consignments) ? reply.consignments : [];

  const consignments: ReadConsignmentDraft[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const obj = row as {
      company?: unknown;
      originPostcode?: unknown;
      destinationPostcode?: unknown;
      pallets?: unknown;
    };

    const company = cleanString(obj.company);
    const originPostcode = cleanPostcode(obj.originPostcode);
    const destinationPostcode = cleanPostcode(obj.destinationPostcode);

    const rawPallets = Array.isArray(obj.pallets) ? obj.pallets : [];
    const pallets = rawPallets.map(parsePallet).filter((p): p is GroupagePallet => p !== null);
    const droppedPalletLine = rawPallets.length !== pallets.length;

    // Flag anything the operator must eyeball: a missing/ill-formed field is never trusted.
    const needsReview: ConsignmentReviewField[] = [];
    if (company === null) needsReview.push("company");
    if (!looksLikePostcode(originPostcode)) needsReview.push("originPostcode");
    if (!looksLikePostcode(destinationPostcode)) needsReview.push("destinationPostcode");
    if (pallets.length === 0 || droppedPalletLine) needsReview.push("pallets");

    // Skip a row that carried nothing usable at all — an empty phantom helps no one.
    if (company === null && originPostcode === null && destinationPostcode === null && pallets.length === 0) {
      continue;
    }

    consignments.push({ company, originPostcode, destinationPostcode, pallets, needsReview });
  }

  return { consignments };
}
