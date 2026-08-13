/**
 * Factory chain regression test — exercises the FACTORY wiring (buildGroqChain),
 * not a hand-built classifier, so it catches a future merge-order swap of
 * `{...d.groq, ...d.sambanova}` inside the factory. Both Groq and SambaNova are
 * configured; Groq's endpoint 5xxs and the chain must degrade to SambaNova
 * (never straight to the rule classifier) — and the SambaNova call must use
 * SambaNova's own key, never Groq's.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getDurabilityClassifier } from "@/lib/classification/durability-classifier.factory";

// getConfig() resolves lazily (first call inside classify()), so setting these
// here — before any test runs — is enough to configure the whole file (mirrors
// durability-groq-classifier.test.ts's pattern).
process.env.DURABILITY_CLASSIFIER_PROVIDER = "groq";
process.env.GROQ_API_KEY = "groq-fake-key";
process.env.GROQ_MODEL = "groq-fake-model";
process.env.GROQ_BASE_URL = "https://groq.test/v1";
process.env.GROQ_MAX_RETRIES = "0";
process.env.GROQ_RETRY_BASE_DELAY_MS = "1";
process.env.SAMBANOVA_API_KEY = "samba-fake-key";
process.env.SAMBANOVA_MODEL = "samba-fake-model";
process.env.SAMBANOVA_BASE_URL = "https://samba.test/v1";

function sambaResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [
                { index: 0, durabilityTier: "medium", brittle: false, deformable: false, orientationLock: "none" },
              ],
            }),
          },
        },
      ],
    }),
    { status: 200 },
  );
}

describe("durability classifier factory — groq→sambanova chain", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("degrades from a failing Groq to SambaNova via the factory-wired chain, never leaking the groq key", async () => {
    const fetchMock = vi.fn(async (...[url]: [string, RequestInit?]) => {
      if (url.startsWith("https://groq.test")) return new Response("server error", { status: 500 });
      if (url.startsWith("https://samba.test")) return sambaResponse();
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const classifier = getDurabilityClassifier();
    const out = await classifier.classify(["ChainAlloy"]);

    // Served by SambaNova, not the rule fallback.
    expect(out.get("ChainAlloy")!.durabilityTier).toBe("medium");
    expect(out.get("ChainAlloy")!.reason).toBe("sambanova classification");
    expect(out.get("ChainAlloy")!.confident).toBe(true);

    // Groq was attempted first (both configured), then SambaNova was reached.
    const groqCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith("https://groq.test"));
    const sambaCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith("https://samba.test"));
    expect(groqCall).toBeDefined();
    expect(sambaCall).toBeDefined();

    // The SambaNova request must carry SambaNova's key — never Groq's.
    const [, sambaInit] = sambaCall!;
    const authHeader = (sambaInit as RequestInit).headers as Record<string, string>;
    expect(authHeader.Authorization).toBe("Bearer samba-fake-key");
    expect(authHeader.Authorization).not.toBe("Bearer groq-fake-key");

    // Degrade path logged (via console.warn) rather than throwing.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
