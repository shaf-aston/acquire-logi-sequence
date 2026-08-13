/**
 * Groq-backed address extractor. Reads the whole OCR'd quotation with an LLM and
 * returns a clean collection address plus the ordered delivery drops — the job
 * the regex/label detector does badly on real quotation layouts (mashed lines,
 * table columns, stray "Primary"/"Origin" labels bleeding into the value).
 *
 * Uses its OWN Groq key (ADDRESS_GROQ_API_KEY), separate from the durability
 * classifier's, so the two paths can be keyed and rotated independently.
 *
 * Degrade-not-break, like DurabilityGroqClassifier: any failure — no key, network
 * outage, non-JSON reply, or a reply that fails validation — falls back to the
 * rule extractor for this document and logs a warning. It never throws, so it can
 * never fail ingestion. A GENUINE empty result from a successful call is trusted
 * (the quotation really had no collection/delivery block) rather than second-
 * guessed with the weaker rule engine.
 */
import { createLogger } from "@/lib/logger/logger";
import { getConfig, type AppConfig } from "@/config/env";
import { withRetry } from "@/lib/util/retry";
import { RuleAddressExtractor } from "@/lib/ingestion/rule-address-extractor";
import type { AddressExtractor } from "@/lib/ingestion/address-extractor.types";
import type { DetectedAddresses } from "@/lib/ingestion/address-detector";
import type { StructuredDocument } from "@/lib/conversion/types";

const logger = createLogger("ingestion.address-groq");

type AddressGroqConfig = AppConfig["addressExtraction"]["groq"];

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

const SYSTEM_PROMPT = `You extract shipping addresses from a UK logistics quotation that has been OCR'd to text.

Return the COLLECTION (pickup/origin) address and every DELIVERY (drop/destination) address.

Rules:
- Each address must be ONE clean postal address string: site/company name if present, street, town/city, and UK postcode, comma-separated. Merge address fragments that OCR split across lines or table cells into a single string.
- Strip labels and noise: never include words like "Collection", "Delivery", "Pickup", "Origin", "Destination", "Primary", "Ship to", column headers, prices, dates, weights, item descriptions, or reference numbers.
- Keep UK postcodes exactly as written.
- Preserve the order deliveries appear in. Include a repeated delivery address only once.
- If there is genuinely no collection address, use null. If there are no deliveries, use an empty array. Never invent an address that is not in the text.
- Also identify the CUSTOMER the quotation is FOR — the client company or person being invoiced/billed (not the carrier) — and their telephone number if present. Strip labels like "Customer", "Account", "Bill to", "Contact", "Tel". Use null for a field that is genuinely absent. Never invent a name or number that is not in the text.

Respond with strict JSON only, no other text:
{"pickup": "<address or null>", "drops": ["<address>", ...], "customer": {"name": "<name or null>", "phone": "<phone or null>"}}`;

interface GroqAddressReply {
  readonly pickup?: unknown;
  readonly drops?: unknown;
  readonly customer?: unknown;
}

export class GroqAddressExtractor implements AddressExtractor {
  readonly provider = "groq";
  private readonly fallback: AddressExtractor;

  constructor(fallback: AddressExtractor = new RuleAddressExtractor()) {
    this.fallback = fallback;
  }

  async extract(document: StructuredDocument): Promise<DetectedAddresses> {
    const cfg = getConfig().addressExtraction.groq;
    if (!cfg.apiKey || !cfg.model) {
      logger.warn(
        "ADDRESS_GROQ_API_KEY / ADDRESS_GROQ_MODEL not set — falling back to rule extractor",
      );
      return this.fallback.extract(document);
    }

    const text = flattenDocument(document, cfg.maxInputChars);
    if (text.trim().length === 0) return { pickup: null, drops: [] };

    let reply: GroqAddressReply;
    try {
      reply = await withRetry(() => this.callGroq(text, cfg), {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.retryBaseDelayMs,
        isRetryable: isTransient,
        logger,
      });
    } catch (err) {
      logger.warn("groq address extraction failed — falling back to rule extractor", {
        error: String(err),
      });
      return this.fallback.extract(document);
    }

    const parsed = parseReply(reply);
    if (!parsed) {
      logger.warn("groq address reply failed validation — falling back to rule extractor");
      return this.fallback.extract(document);
    }

    logger.info("groq address extraction complete", {
      pickup: parsed.pickup !== null,
      drops: parsed.drops.length,
    });
    return parsed;
  }

  private async callGroq(text: string, cfg: AddressGroqConfig): Promise<GroqAddressReply> {
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
      return JSON.parse(content) as GroqAddressReply;
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
  logger.warn("document text exceeds ADDRESS_GROQ_MAX_INPUT_CHARS — truncating", {
    length: text.length,
    maxChars,
  });
  return text.slice(0, maxChars);
}

/** Validate + normalise the LLM reply. Returns null if the shape is unusable. */
function parseReply(reply: GroqAddressReply): DetectedAddresses | null {
  if (typeof reply !== "object" || reply === null) return null;

  const pickupRaw = reply.pickup;
  const pickup =
    typeof pickupRaw === "string" && pickupRaw.trim().length > 0 ? pickupRaw.trim() : null;

  if (reply.drops !== undefined && !Array.isArray(reply.drops)) return null;
  const rawDrops = Array.isArray(reply.drops) ? reply.drops : [];

  const drops: string[] = [];
  const seen = new Set<string>();
  const pickupKey = pickup?.toLowerCase();
  for (const entry of rawDrops) {
    if (typeof entry !== "string") continue;
    const value = entry.trim();
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (key === pickupKey || seen.has(key)) continue;
    seen.add(key);
    drops.push(value);
  }

  return { pickup, drops, customer: parseCustomer(reply.customer) };
}

/** Validate + normalise the customer sub-object. Never throws — malformed input just yields nulls. */
function parseCustomer(raw: unknown): { name: string | null; phone: string | null } {
  if (typeof raw !== "object" || raw === null) return { name: null, phone: null };
  const obj = raw as { name?: unknown; phone?: unknown };
  const name = typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : null;
  const phone = typeof obj.phone === "string" && obj.phone.trim().length > 0 ? obj.phone.trim() : null;
  return { name, phone };
}
