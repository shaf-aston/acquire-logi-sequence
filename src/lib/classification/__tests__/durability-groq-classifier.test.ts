/**
 * Groq durability classifier — fetch is fully mocked (no real network calls).
 * Verifies: dedupe-into-one-call, per-material fallback on malformed entries,
 * 429 retry-then-success, chunking above the per-call cap, and the in-memory
 * cache skipping repeat materials entirely.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DurabilityGroqClassifier } from "@/lib/classification/durability-groq-classifier";

// getConfig() resolves lazily (first call inside classify()), so setting these
// here — before any test runs — is enough to configure the whole file.
process.env.GROQ_API_KEY = "test-key";
process.env.GROQ_MODEL = "test-model";
process.env.GROQ_RETRY_BASE_DELAY_MS = "1";

function groqResponse(results: unknown[]): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results }) } } ] }), {
    status: 200,
  });
}

/** Generic success mock: returns one valid entry per material actually sent in the request. */
function mockGenericSuccess(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: string }[] };
    const userMsg = body.messages.find((m) => m.role === "user")!.content;
    const count = userMsg.split("\n").filter(Boolean).length;
    const results = Array.from({ length: count }, (_, i) => ({
      index: i,
      durabilityTier: "medium",
      brittle: false,
      deformable: false,
      orientationLock: "none",
    }));
    return groqResponse(results);
  });
}

describe("DurabilityGroqClassifier", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("dedupes duplicate materials into one request", async () => {
    const fetchMock = mockGenericSuccess();
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new DurabilityGroqClassifier();
    const result = await classifier.classify(["DedupeAlpha", "DedupeAlpha", "DedupeBeta"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(2);
    expect(result.get("DedupeAlpha")!.durabilityTier).toBe("medium");
  });

  it("falls back to the rule classifier per-material when an entry is malformed/missing", async () => {
    const fetchMock = vi.fn(async () =>
      groqResponse([{ index: 0, durabilityTier: "high", brittle: false, deformable: false, orientationLock: "none" }]),
      // index 1 ("FallbackBadInput") deliberately omitted from the mocked response.
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new DurabilityGroqClassifier();
    const result = await classifier.classify(["FallbackSteel", "FallbackBadInput"]);

    expect(result.get("FallbackSteel")!.durabilityTier).toBe("high");
    expect(result.get("FallbackSteel")!.confident).toBe(true);
    // Unmatched by the rule classifier too → its documented unconfident default.
    expect(result.get("FallbackBadInput")!.confident).toBe(false);
    expect(result.get("FallbackBadInput")!.durabilityTier).toBe("medium");
  });

  it("falls back to the rule classifier when a present entry has an invalid field", async () => {
    // Both entries are PRESENT at their index but fail parseEntry validation
    // (bad tier / non-boolean brittle) — the sanitiser must reject them and use
    // the rule fallback rather than injecting garbage safety facts into the packer.
    const fetchMock = vi.fn(async () =>
      groqResponse([
        { index: 0, durabilityTier: "bogus", brittle: false, deformable: false, orientationLock: "none" },
        { index: 1, durabilityTier: "high", brittle: "yes", deformable: false, orientationLock: "none" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new DurabilityGroqClassifier();
    const result = await classifier.classify(["Malformed Steel", "Malformed Glass"]);

    expect(result.get("Malformed Steel")!.reason).not.toBe("groq classification");
    expect(result.get("Malformed Glass")!.reason).not.toBe("groq classification");
    expect(result.get("Malformed Steel")!.durabilityTier).toBe("high"); // rule: steel → high
  });

  it("does not cache a transient-failure fallback (cache is not poisoned)", async () => {
    // First quote: groq is down (persistent 5xx) → whole batch degrades to the rule classifier.
    const downFetch = vi.fn(async () => new Response("server error", { status: 500 }));
    vi.stubGlobal("fetch", downFetch);
    const first = new DurabilityGroqClassifier();
    const r1 = await first.classify(["PoisonProbe Steel"]);
    expect(downFetch).toHaveBeenCalled();
    expect(r1.get("PoisonProbe Steel")!.reason).not.toBe("groq classification"); // rule fallback

    // Groq recovers — a later quote for the SAME material must re-hit groq, proving
    // the fallback was never cached (a cache HIT here would skip fetch entirely).
    const upFetch = mockGenericSuccess();
    vi.stubGlobal("fetch", upFetch);
    const second = new DurabilityGroqClassifier();
    const r2 = await second.classify(["PoisonProbe Steel"]);
    expect(upFetch).toHaveBeenCalledTimes(1);
    expect(r2.get("PoisonProbe Steel")!.reason).toBe("groq classification");
  });

  it("retries on 429 and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return groqResponse([{ index: 0, durabilityTier: "low", brittle: true, deformable: false, orientationLock: "none" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new DurabilityGroqClassifier();
    const result = await classifier.classify(["RetryGlass"]);

    expect(calls).toBe(2);
    expect(result.get("RetryGlass")!.brittle).toBe(true);
  });

  it("chunks unique materials into multiple sequential calls above the per-call cap", async () => {
    const fetchMock = mockGenericSuccess();
    vi.stubGlobal("fetch", fetchMock);

    // Default GROQ_MAX_ITEMS_PER_CALL is 60 — 65 unique values force a second chunk.
    const materials = Array.from({ length: 65 }, (_, i) => `ChunkMaterial-${i}`);
    const classifier = new DurabilityGroqClassifier();
    const result = await classifier.classify(materials);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(65);
  });

  it("never re-fetches a material already resolved by a previous call (in-memory cache)", async () => {
    const fetchMock = mockGenericSuccess();
    vi.stubGlobal("fetch", fetchMock);

    const first = new DurabilityGroqClassifier();
    await first.classify(["CachedMaterial"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const throwingFetch = vi.fn(async () => {
      throw new Error("should never be called for a cached material");
    });
    vi.stubGlobal("fetch", throwingFetch);

    const second = new DurabilityGroqClassifier();
    const result = await second.classify(["CachedMaterial"]);

    expect(throwingFetch).not.toHaveBeenCalled();
    expect(result.get("CachedMaterial")!.durabilityTier).toBe("medium");
  });
});
