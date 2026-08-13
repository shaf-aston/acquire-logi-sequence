/**
 * Pickup-list extraction — turns an uploaded manifest PDF's OCR text into CANDIDATE pickup
 * addresses for a hub collection run. Candidates only: nothing is trusted or saved until the
 * operator confirms each row in the UI (same contract as hub-extractor.ts / /api/ingest-hubs).
 *
 * Two engines behind one seam (mirrors address-extractor.factory.ts, and reuses ITS provider
 * knob + Groq key/config — a manifest is the same kind of document, keyed the same way):
 *   - rule: postcode-anchored line scan. No key, no network; every hit is marked unconfident
 *     because a raw OCR line usually drags junk along with the address.
 *   - groq: LLM reads the whole text and returns clean address strings; degrades to the rule
 *     engine on any failure (no key, outage, bad reply) — never throws, never blocks ingest.
 *
 * "Never guess": `confident` is true only for an LLM-cleaned address that carries a UK
 * postcode. Everything else is flagged for the operator to check before it joins a run.
 */
import { createLogger } from "@/lib/logger/logger";
import { getConfig, type AppConfig } from "@/config/env";
import { withRetry } from "@/lib/util/retry";
import { extractPostcode } from "@/lib/geo/address-resolver";
import type { PickupCandidate } from "@/types/api";

const logger = createLogger("collection-run.pickup-extractor");

/** Hard cap on candidates from one document — a runaway OCR can't flood the review UI. */
const MAX_CANDIDATES = 100;

export interface PickupListExtractor {
  /** Engine name for logs — "rule" | "groq". */
  readonly provider: string;
  /** Fail-soft: never throws; a failure degrades to a weaker (possibly empty) candidate list. */
  extract(text: string): Promise<PickupCandidate[]>;
}

/** Dedupe (case-insensitive), drop blanks, cap the list. Shared by both engines. */
function normalise(raw: { address: string; confident: boolean }[]): PickupCandidate[] {
  const seen = new Set<string>();
  const out: PickupCandidate[] = [];
  for (const { address, confident } of raw) {
    const value = address.trim().replace(/\s+/g, " ");
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const postcode = extractPostcode(value);
    out.push({ address: value, postcode, confident: confident && postcode !== null });
    if (out.length >= MAX_CANDIDATES) {
      logger.warn("pickup candidate cap reached — remaining lines dropped", { cap: MAX_CANDIDATES });
      break;
    }
  }
  return out;
}

/** Postcode-anchored line scan. Pure and synchronous inside; every hit needs operator review. */
export class RulePickupListExtractor implements PickupListExtractor {
  readonly provider = "rule";

  async extract(text: string): Promise<PickupCandidate[]> {
    const raw = text
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/\|/g, ", ") // markdown table cells → address fragments
          .replace(/^[\s•\-*\d.)]+/, "") // leading bullets / row numbers
          .replace(/\s*,\s*,+/g, ", ") // collapse empty fragments left by the above
          .trim(),
      )
      .filter((line) => extractPostcode(line) !== null)
      .map((address) => ({ address, confident: false }));
    return normalise(raw);
  }
}

type AddressGroqConfig = AppConfig["addressExtraction"]["groq"];

/** Transient = network blips, rate limits, 5xx. 4xx (bad key/payload) is not. */
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

const SYSTEM_PROMPT = `You extract PICKUP site addresses from a UK logistics manifest or order list that has been OCR'd to text.

The document lists places a van must collect goods from. Return every distinct site address.

Rules:
- Each address must be ONE clean postal address string: site/company name if present, street, town/city, and UK postcode, comma-separated. Merge fragments that OCR split across lines or table cells.
- Strip labels and noise: never include words like "Pickup", "Collection", "Site", "Address", column headers, order numbers, dates, quantities, weights, item descriptions, or prices.
- Keep UK postcodes exactly as written.
- Preserve the order addresses appear in. Include a repeated address only once.
- If the text contains no addresses, return an empty array. Never invent an address that is not in the text.

Respond with strict JSON only, no other text:
{"addresses": ["<address>", ...]}`;

/** Validate the LLM reply shape. Exported for tests. Returns null when unusable. */
export function parsePickupReply(reply: unknown): string[] | null {
  if (typeof reply !== "object" || reply === null) return null;
  const addresses = (reply as { addresses?: unknown }).addresses;
  if (!Array.isArray(addresses)) return null;
  return addresses.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
}

/** LLM engine: clean multi-address extraction, degrading to the rule scan on any failure. */
export class GroqPickupListExtractor implements PickupListExtractor {
  readonly provider = "groq";
  private readonly fallback: PickupListExtractor;

  constructor(fallback: PickupListExtractor = new RulePickupListExtractor()) {
    this.fallback = fallback;
  }

  async extract(text: string): Promise<PickupCandidate[]> {
    const cfg = getConfig().addressExtraction.groq;
    if (!cfg.apiKey || !cfg.model) {
      logger.warn("ADDRESS_GROQ_API_KEY / ADDRESS_GROQ_MODEL not set — falling back to rule scan");
      return this.fallback.extract(text);
    }
    const input = text.length > cfg.maxInputChars ? text.slice(0, cfg.maxInputChars) : text;
    if (input.trim().length === 0) return [];

    let addresses: string[] | null;
    try {
      const reply = await withRetry(() => this.callGroq(input, cfg), {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.retryBaseDelayMs,
        isRetryable: isTransient,
        logger,
      });
      addresses = parsePickupReply(reply);
    } catch (err) {
      logger.warn("groq pickup extraction failed — falling back to rule scan", { error: String(err) });
      return this.fallback.extract(text);
    }
    if (addresses === null) {
      logger.warn("groq pickup reply failed validation — falling back to rule scan");
      return this.fallback.extract(text);
    }

    logger.info("groq pickup extraction complete", { addresses: addresses.length });
    return normalise(addresses.map((address) => ({ address, confident: true })));
  }

  private async callGroq(text: string, cfg: AddressGroqConfig): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
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
      return JSON.parse(content);
    } catch {
      throw new Error("Groq response content is not valid JSON");
    }
  }
}

const registry: Record<string, () => PickupListExtractor> = {
  rule: () => new RulePickupListExtractor(),
  groq: () => new GroqPickupListExtractor(),
};

let cached: PickupListExtractor | null = null;

/** Engine from the SAME provider knob as quotation address extraction (one opt-in, one key). */
export function getPickupListExtractor(): PickupListExtractor {
  if (cached) return cached;
  const provider = getConfig().addressExtraction.provider.toLowerCase();
  const factory = registry[provider];
  if (!factory) {
    throw new Error(
      `[collection-run.pickup-extractor] Unknown ADDRESS_EXTRACTOR_PROVIDER "${provider}". Known: ${Object.keys(registry).join(", ")}`,
    );
  }
  cached = factory();
  return cached;
}
