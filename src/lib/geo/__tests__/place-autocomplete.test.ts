import { describe, expect, it, vi } from "vitest";
import { looksLikePostcode, suggestPlaces, type FetchJson } from "@/lib/geo/place-autocomplete";

/**
 * The autocomplete core routes UK postcodes to postcodes.io (fast/unlimited) and free-text
 * streets to Nominatim, mapping either into a uniform suggestion. Network is injected, so
 * these assert the routing decision + mapping + fail-soft fallthrough with no real fetch.
 */

const postcodesIoPayload = {
  status: 200,
  result: [
    { postcode: "NW9 0AA", latitude: 51.584512, longitude: -0.260389, admin_district: "Brent" },
    { postcode: "NW9 0AB", latitude: 51.584478, longitude: -0.261747, admin_district: "Brent" },
  ],
};

const nominatimPayload = [
  { display_name: "Beddington Farm Road, Croydon, CR0 4XA, UK", lat: "51.38", lon: "-0.13", address: { postcode: "CR0 4XA" } },
];

describe("looksLikePostcode", () => {
  it("matches the start of a UK postcode (letters then a digit)", () => {
    for (const q of ["NW9", "nw9", "N1", "SW1A", "EC1A 1BB", "NW10 7NU"]) {
      expect(looksLikePostcode(q)).toBe(true);
    }
  });
  it("does not match a free-text street address", () => {
    for (const q of ["Unit 5, Beddington Farm Road", "Manchester", "10 Downing Street", "London"]) {
      expect(looksLikePostcode(q)).toBe(false);
    }
  });
});

describe("suggestPlaces — postcode fast path", () => {
  it("queries postcodes.io for a postcode-shaped query and maps postcode + lat/lng", async () => {
    const fetchJson = vi.fn<FetchJson>(async (url) => {
      expect(url).toContain("api.postcodes.io/postcodes?q=NW9");
      return postcodesIoPayload;
    });
    const out = await suggestPlaces("NW9", fetchJson);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      { label: "NW9 0AA", postcode: "NW9 0AA", lat: 51.584512, lng: -0.260389 },
      { label: "NW9 0AB", postcode: "NW9 0AB", lat: 51.584478, lng: -0.261747 },
    ]);
  });

  it("falls through to Nominatim when postcodes.io returns no matches", async () => {
    const fetchJson = vi.fn<FetchJson>(async (url) =>
      url.includes("postcodes.io") ? { status: 200, result: [] } : nominatimPayload,
    );
    const out = await suggestPlaces("NW9", fetchJson);
    expect(fetchJson).toHaveBeenCalledTimes(2); // postcodes.io (empty) → Nominatim
    expect(out[0]!.postcode).toBe("CR0 4XA");
  });

  it("falls through to Nominatim when postcodes.io throws (source down)", async () => {
    const fetchJson = vi.fn<FetchJson>(async (url) => {
      if (url.includes("postcodes.io")) throw new Error("network");
      return nominatimPayload;
    });
    const out = await suggestPlaces("NW9", fetchJson);
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toContain("Beddington Farm Road");
  });
});

describe("suggestPlaces — free-text path", () => {
  it("goes straight to Nominatim for a non-postcode query (no postcodes.io call)", async () => {
    const urls: string[] = [];
    const fetchJson = vi.fn<FetchJson>(async (url) => {
      urls.push(url);
      return nominatimPayload;
    });
    const out = await suggestPlaces("Unit 5, Beddington Farm Road", fetchJson);
    expect(urls.every((u) => !u.includes("postcodes.io"))).toBe(true);
    expect(urls.some((u) => u.includes("nominatim"))).toBe(true);
    expect(out[0]!.postcode).toBe("CR0 4XA");
  });
});

describe("suggestPlaces — Nominatim coordinate mapping", () => {
  it("maps a blank/absent lat/lon to null, never a misleading (0,0)", async () => {
    const fetchJson = vi.fn<FetchJson>(async () => [
      { display_name: "Somewhere, UK", lat: "", lon: "", address: { postcode: "AB1 2CD" } },
    ]);
    const out = await suggestPlaces("Somewhere", fetchJson);
    expect(out[0]).toEqual({ label: "Somewhere, UK", postcode: "AB1 2CD", lat: null, lng: null });
  });

  it("keeps a legitimate '0' coordinate (the prime meridian runs through the UK)", async () => {
    const fetchJson = vi.fn<FetchJson>(async () => [
      { display_name: "On the meridian, UK", lat: "51.48", lon: "0", address: {} },
    ]);
    const out = await suggestPlaces("meridian", fetchJson);
    expect(out[0]!.lat).toBe(51.48);
    expect(out[0]!.lng).toBe(0);
  });
});

describe("suggestPlaces — fail-soft", () => {
  it("returns [] for a too-short query without any fetch", async () => {
    const fetchJson = vi.fn<FetchJson>(async () => nominatimPayload);
    expect(await suggestPlaces("N", fetchJson)).toEqual([]);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("returns [] (never throws) when every source fails", async () => {
    const fetchJson = vi.fn<FetchJson>(async () => {
      throw new Error("down");
    });
    expect(await suggestPlaces("NW9", fetchJson)).toEqual([]);
  });
});
