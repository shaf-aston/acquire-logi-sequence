/**
 * Groq-backed durability classifier. Dedupes materials and batches everything
 * into ONE request — chunking only if the unique count exceeds
 * GROQ_MAX_ITEMS_PER_CALL, and even then sequentially, never in parallel (see
 * docs/stacking-item-data.md, "why one Groq call"). Results are cached in-memory
 * by material string for the life of the process, so a repeat material — within
 * this manifest or across a later quote — never re-hits the API.
 *
 * A malformed/missing entry for one material falls back to the rule classifier's
 * result for just that material and logs a warning — one bad entry never fails
 * the whole batch or the quote (mirrors CachingExtractor's degrade-not-break style).
 */
import { createLogger } from "@/lib/logger/logger";
import { getConfig, type AppConfig } from "@/config/env";
import { withRetry } from "@/lib/util/retry";
import { DurabilityRuleClassifier } from "@/lib/classification/durability-rule-classifier";
import type {
  DurabilityClassification,
  DurabilityClassifier,
  DurabilityTier,
  OrientationLock,
} from "@/lib/classification/durability.types";

const logger = createLogger("classification.durability-groq");

/**
 * In-memory result cache, shared across requests for the life of the process.
 * Only GENUINE Groq classifications are stored here — never a rule-classifier
 * fallback produced by a transient outage or a malformed entry. Caching a
 * fallback would permanently pin those materials to rule-based facts for the
 * rest of the process even after Groq recovers, silently degrading a paid path.
 */
const cache = new Map<string, DurabilityClassification>();

const VALID_TIERS: readonly DurabilityTier[] = ["none", "low", "medium", "high"];
const VALID_LOCKS: readonly OrientationLock[] = ["fixed", "partial", "none"];

type GroqConfig = AppConfig["durability"]["groq"];

interface GroqResultEntry {
  readonly index?: number;
  readonly durabilityTier?: string;
  readonly brittle?: boolean;
  readonly deformable?: boolean;
  readonly orientationLock?: string;
}

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

const SYSTEM_PROMPT = `You classify furniture/cargo materials for a logistics stacking-safety system.
For each input material description, return:
- durabilityTier: "none" | "low" | "medium" | "high" — how much weight it can bear before caving. Ceiling from material (foam/fabric=none, cardboard/thin plastic=low, engineered wood=medium, solid wood/metal=high, glass=low+brittle), knocked down one step if the build is hollow (cabinet, appliance shell, drawer).
- brittle: true if it snaps instead of deforming (glass, ceramic, stone, plasterboard).
- deformable: true if it compresses and recovers rather than breaking (foam, fabric).
- orientationLock: "fixed" (must stay upright — motors, liquids, batteries), "partial" (upright but any facing — appliances, cabinets), or "none" (any orientation).
Resolve mixed materials (e.g. "Wood / Fabric / Foam") to the WEAKEST component.
Respond with strict JSON only, no other text: {"results":[{"index":0,"durabilityTier":"...","brittle":false,"deformable":false,"orientationLock":"..."}]}. One entry per input, indexed from 0, same order as given.`;

export class DurabilityGroqClassifier implements DurabilityClassifier {
  readonly provider: string;
  private readonly fallback: DurabilityClassifier;
  /** Resolves this strategy's endpoint config at call time. Defaults to Groq, but any
   *  OpenAI-compatible endpoint (e.g. SambaNova) plugs in by passing its own resolver. */
  private readonly cfgOf: () => GroqConfig;

  constructor(
    opts: {
      fallback?: DurabilityClassifier;
      /** Endpoint config resolver — defaults to the Groq block. */
      cfg?: () => GroqConfig;
      /** Provider label for logs/keys (e.g. "groq", "sambanova"). */
      provider?: string;
    } = {},
  ) {
    this.fallback = opts.fallback ?? new DurabilityRuleClassifier();
    this.cfgOf = opts.cfg ?? (() => getConfig().durability.groq);
    this.provider = opts.provider ?? "groq";
  }

  async classify(materials: readonly string[]): Promise<Map<string, DurabilityClassification>> {
    const out = new Map<string, DurabilityClassification>();

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of materials) {
      const key = raw.trim();
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      const hit = cache.get(key);
      if (hit) out.set(key, hit);
      else unique.push(key);
    }
    if (unique.length === 0) return out;

    const cfg = this.cfgOf();
    if (!cfg.apiKey || !cfg.model) {
      throw new Error(
        `[classification.durability-${this.provider}] apiKey and model must be set for the "${this.provider}" durability provider`,
      );
    }

    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += cfg.maxItemsPerCall) {
      chunks.push(unique.slice(i, i + cfg.maxItemsPerCall));
    }

    // Sequential, never concurrent — see module doc comment.
    for (const chunk of chunks) {
      const { classified, fromGroq } = await this.classifyChunk(chunk, cfg);
      for (const [material, result] of classified) {
        out.set(material, result);
        // Persist only real Groq results — fallbacks satisfy this quote but must
        // not poison future ones (see the cache doc comment).
        if (fromGroq.has(material)) cache.set(material, result);
      }
    }

    logger.info(`${this.provider} durability classification complete`, {
      requested: materials.length,
      unique: unique.length,
      calls: chunks.length,
    });
    return out;
  }

  /**
   * Classifies one chunk, returning the results plus the set of materials that
   * came from GENUINE Groq output (`fromGroq`). Materials absent from that set
   * were served by the rule fallback (transient failure or malformed entry) and
   * the caller must not cache them.
   */
  private async classifyChunk(
    chunk: string[],
    cfg: GroqConfig,
  ): Promise<{ classified: Map<string, DurabilityClassification>; fromGroq: Set<string> }> {
    let entries: GroqResultEntry[];
    try {
      entries = await withRetry(() => this.callGroq(chunk, cfg), {
        maxRetries: cfg.maxRetries,
        baseDelayMs: cfg.retryBaseDelayMs,
        isRetryable: isTransient,
        logger,
      });
    } catch (err) {
      logger.warn(`${this.provider} call failed — falling back to ${this.fallback.provider} classifier for this batch`, {
        error: String(err),
        items: chunk.length,
      });
      return { classified: await this.fallback.classify(chunk), fromGroq: new Set() };
    }

    const byIndex = new Map(
      entries.filter((e): e is GroqResultEntry & { index: number } => typeof e.index === "number")
        .map((e) => [e.index, e] as const),
    );

    const classified = new Map<string, DurabilityClassification>();
    const fromGroq = new Set<string>();
    const fallbackNeeded: string[] = [];

    chunk.forEach((material, i) => {
      const entry = byIndex.get(i);
      const parsed = entry ? parseEntry(material, entry, this.provider) : null;
      if (parsed) {
        classified.set(material, parsed);
        fromGroq.add(material);
      } else {
        fallbackNeeded.push(material);
      }
    });

    if (fallbackNeeded.length > 0) {
      logger.warn(`${this.provider} returned malformed/missing entries — using ${this.fallback.provider} fallback`, {
        count: fallbackNeeded.length,
      });
      const fallback = await this.fallback.classify(fallbackNeeded);
      for (const [material, result2] of fallback) classified.set(material, result2);
    }

    return { classified, fromGroq };
  }

  private async callGroq(chunk: string[], cfg: GroqConfig): Promise<GroqResultEntry[]> {
    const userContent = chunk.map((m, i) => `${i}: ${m}`).join("\n");

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
            { role: "user", content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      throw new Error(`${this.provider} request failed: ${String(err)}`);
    }

    if (!response.ok) {
      throw new GroqHttpError(`${this.provider} request failed with status ${response.status}`, response.status);
    }

    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error(`${this.provider} response missing message content`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`${this.provider} response content is not valid JSON`);
    }
    const results = (parsed as { results?: unknown })?.results;
    if (!Array.isArray(results)) throw new Error(`${this.provider} response JSON missing "results" array`);
    return results as GroqResultEntry[];
  }
}

function parseEntry(material: string, e: GroqResultEntry, provider: string): DurabilityClassification | null {
  if (!VALID_TIERS.includes(e.durabilityTier as DurabilityTier)) return null;
  if (typeof e.brittle !== "boolean") return null;
  if (typeof e.deformable !== "boolean") return null;
  if (!VALID_LOCKS.includes(e.orientationLock as OrientationLock)) return null;
  return {
    material,
    durabilityTier: e.durabilityTier as DurabilityTier,
    brittle: e.brittle,
    deformable: e.deformable,
    orientationLock: e.orientationLock as OrientationLock,
    confident: true,
    reason: `${provider} classification`,
  };
}
