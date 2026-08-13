/**
 * Groq address extractor — fetch is fully mocked (no real network calls).
 * Verifies: a valid reply is normalised (order kept, dupes + the pickup + blanks
 * dropped); every failure mode (HTTP 5xx, non-JSON, wrong shape) degrades to the
 * injected fallback extractor; an empty document skips the call entirely.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GroqAddressExtractor } from "@/lib/ingestion/groq-address-extractor";
import type { AddressExtractor } from "@/lib/ingestion/address-extractor.types";
import type { DetectedAddresses } from "@/lib/ingestion/address-detector";
import type { StructuredDocument } from "@/lib/conversion/types";

// getConfig() resolves lazily on first extract(); setting these before any test runs
// configures the whole file. Own key namespace, separate from the durability classifier.
process.env.ADDRESS_EXTRACTOR_PROVIDER = "groq";
process.env.ADDRESS_GROQ_API_KEY = "test-key";
process.env.ADDRESS_GROQ_MODEL = "test-model";
process.env.ADDRESS_GROQ_RETRY_BASE_DELAY_MS = "1";

function docFromMarkdown(markdown: string): StructuredDocument {
  return { pageCount: 1, tableCount: 0, pages: [{ index: 0, markdown, tables: [] }] };
}

function groqReply(obj: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), {
    status: 200,
  });
}

class StubExtractor implements AddressExtractor {
  readonly provider = "stub";
  called = 0;
  constructor(private readonly result: DetectedAddresses) {}
  async extract(): Promise<DetectedAddresses> {
    this.called += 1;
    return this.result;
  }
}

const FALLBACK: DetectedAddresses = { pickup: "RULE FALLBACK, LS1 4AB", drops: [] };
const DOC = docFromMarkdown("Collection: A\nDelivery: B");

describe("GroqAddressExtractor", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises a valid reply: keeps order, drops blanks and case-insensitive dupes", async () => {
    const fetchMock = vi.fn(async () =>
      groqReply({
        pickup: "  Depot, Leeds, LS1 4AB  ",
        drops: ["10 First Ave, M1 2AB", "10 first ave, m1 2ab", "", "20 Second Ave, E1 6AN"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GroqAddressExtractor(new StubExtractor(FALLBACK)).extract(DOC);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.pickup).toBe("Depot, Leeds, LS1 4AB");
    expect(result.drops).toEqual(["10 First Ave, M1 2AB", "20 Second Ave, E1 6AN"]);
  });

  it("drops a delivery equal to the pickup, and treats a null pickup as absent", async () => {
    const fetchMock = vi.fn(async () =>
      groqReply({ pickup: null, drops: ["Only Drop, M1 2AB", "only drop, m1 2ab"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GroqAddressExtractor(new StubExtractor(FALLBACK)).extract(DOC);
    expect(result.pickup).toBeNull();
    expect(result.drops).toEqual(["Only Drop, M1 2AB"]);
  });

  it("trusts a genuine empty result from a successful call (no fallback)", async () => {
    const fetchMock = vi.fn(async () => groqReply({ pickup: null, drops: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const fallback = new StubExtractor(FALLBACK);
    const result = await new GroqAddressExtractor(fallback).extract(DOC);

    expect(fallback.called).toBe(0);
    expect(result).toEqual({ pickup: null, drops: [], customer: { name: null, phone: null } });
  });

  it("falls back to the rule extractor on a persistent HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500 })));

    const fallback = new StubExtractor(FALLBACK);
    const result = await new GroqAddressExtractor(fallback).extract(DOC);

    expect(fallback.called).toBe(1);
    expect(result).toEqual(FALLBACK);
  });

  it("falls back when the reply content is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 })),
    );

    const fallback = new StubExtractor(FALLBACK);
    const result = await new GroqAddressExtractor(fallback).extract(DOC);
    expect(fallback.called).toBe(1);
    expect(result).toEqual(FALLBACK);
  });

  it("falls back when the reply shape is wrong (drops not an array)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => groqReply({ pickup: "A, LS1 4AB", drops: "nope" })));

    const fallback = new StubExtractor(FALLBACK);
    const result = await new GroqAddressExtractor(fallback).extract(DOC);
    expect(fallback.called).toBe(1);
    expect(result).toEqual(FALLBACK);
  });

  it("skips the API call for an empty document", async () => {
    const fetchMock = vi.fn(async () => groqReply({ pickup: null, drops: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GroqAddressExtractor(new StubExtractor(FALLBACK)).extract(
      docFromMarkdown("   "),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ pickup: null, drops: [] });
  });
});
