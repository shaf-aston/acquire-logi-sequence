/**
 * /api/places/resolve — trust-boundary validation + a fetch-mocked happy path.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "@/app/api/places/resolve/route";
import { __resetAddressResolverCache } from "@/lib/geo/address-resolver";
import { __resetNominatimThrottle } from "@/lib/geo/nominatim-throttle";

function post(body: unknown): Request {
  return new Request("http://test/api/places/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/places/resolve", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetAddressResolverCache();
    __resetNominatimThrottle();
  });

  it("400s on a non-array addresses field", async () => {
    const res = await POST(post({ addresses: "not an array" }));
    expect(res.status).toBe(400);
  });

  it("400s when addresses contains a non-string", async () => {
    const res = await POST(post({ addresses: ["ok", 42] }));
    expect(res.status).toBe(400);
  });

  it("400s on more than the max addresses", async () => {
    const res = await POST(post({ addresses: Array.from({ length: 31 }, (_, i) => `a${i}`) }));
    expect(res.status).toBe(400);
  });

  it("400s on invalid JSON", async () => {
    const res = await POST(post("{ not json"));
    expect(res.status).toBe(400);
  });

  it("resolves a valid batch, aligned by index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify([{ display_name: "Depot, Leeds, LS1 4AB, United Kingdom" }]), {
          status: 200,
        }),
      ),
    );
    const res = await POST(post({ addresses: ["Warehouse, LS1 4AB"] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: Array<{ confident: boolean; match: string | null }> };
    expect(json.results).toHaveLength(1);
    expect(json.results[0]!.confident).toBe(true);
    expect(json.results[0]!.match).toContain("LS1 4AB");
  });
});
