/**
 * Address resolver — pure postcode matching + a fetch-mocked resolve path.
 * The Nominatim throttle + resolve cache are reset between tests.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  extractPostcode,
  pickByPostcode,
  resolveAddress,
  __resetAddressResolverCache,
} from "@/lib/geo/address-resolver";
import { __resetNominatimThrottle } from "@/lib/geo/nominatim-throttle";

function searchResponse(displayNames: string[]): Response {
  return new Response(JSON.stringify(displayNames.map((n) => ({ display_name: n }))), {
    status: 200,
  });
}

describe("extractPostcode", () => {
  it("pulls and normalises a UK postcode from a full address", () => {
    expect(extractPostcode("Unit 4, Avonmouth Way, Bristol, BS11 0YL")).toBe("BS11 0YL");
  });
  it("normalises a missing/odd internal space", () => {
    expect(extractPostcode("somewhere BS110YL")).toBe("BS11 0YL");
    expect(extractPostcode("12 King St, M1 2AB")).toBe("M1 2AB");
  });
  it("returns null when there is no postcode", () => {
    expect(extractPostcode("just a company name, no postcode")).toBeNull();
  });
});

describe("pickByPostcode", () => {
  const candidates = [
    "Commerce Road, Salford, M50 1AB, United Kingdom",
    "58, Commerce Road, Avonmouth, Bristol, BS11 9HP, United Kingdom",
  ];
  it("selects the candidate carrying the query postcode", () => {
    expect(pickByPostcode("BS11 9HP", candidates)).toBe(candidates[1]);
  });
  it("returns null when no candidate carries it", () => {
    expect(pickByPostcode("SW1A 1AA", candidates)).toBeNull();
  });
  it("returns null when the query has no postcode", () => {
    expect(pickByPostcode(null, candidates)).toBeNull();
  });
});

describe("resolveAddress", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    __resetAddressResolverCache();
    __resetNominatimThrottle();
  });

  it("confidently matches when a full-address hit carries the query postcode", async () => {
    const fetchMock = vi.fn(async () =>
      searchResponse(["58, Commerce Road, Avonmouth, Bristol, BS11 9HP, United Kingdom"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const r = await resolveAddress("Apex Freight Ltd, 58 Commerce Road, Bristol, BS11 9HP");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.confident).toBe(true);
    expect(r.match).toContain("BS11 9HP");
  });

  it("falls back to a postcode-only search when the full hit misses the postcode", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      // 1st: full-address search returns a WRONG-postcode hit; 2nd: postcode-only search.
      return call === 1
        ? searchResponse(["Commerce Road, Salford, M50 1AB, United Kingdom"])
        : searchResponse(["Avonmouth, Bristol, BS11 9HP, United Kingdom"]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await resolveAddress("Apex Freight Ltd, 58 Commerce Road, Bristol, BS11 9HP");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.confident).toBe(true);
    expect(r.match).toContain("BS11 9HP");
  });

  it("returns an unconfident top hit when the query has no postcode", async () => {
    const fetchMock = vi.fn(async () => searchResponse(["Manchester, Greater Manchester, England"]));
    vi.stubGlobal("fetch", fetchMock);

    const r = await resolveAddress("Manchester");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.confident).toBe(false);
    expect(r.match).toBe("Manchester, Greater Manchester, England");
  });

  it("degrades to no match (never throws) when the search errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await resolveAddress("anything, LS1 4AB");
    expect(r).toEqual({ query: "anything, LS1 4AB", match: null, confident: false });
  });

  it("caches a resolved address (no second network hit)", async () => {
    const fetchMock = vi.fn(async () => searchResponse(["X, LS1 4AB, United Kingdom"]));
    vi.stubGlobal("fetch", fetchMock);

    await resolveAddress("Warehouse, LS1 4AB");
    await resolveAddress("Warehouse, LS1 4AB");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
