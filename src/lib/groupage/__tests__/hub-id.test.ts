import { describe, expect, it } from "vitest";
import { hubIdFromName, hubSlug } from "../hub-resolver";

describe("hubSlug", () => {
  it("lowercases and dashes a normal name", () => {
    expect(hubSlug("Coventry Hub")).toBe("coventry-hub");
  });

  it("collapses runs of non-alphanumerics into single dashes and trims them", () => {
    expect(hubSlug("A/B  &  C!")).toBe("a-b-c");
  });

  it("caps the slug at 40 characters", () => {
    expect(hubSlug("x".repeat(60))).toHaveLength(40);
  });

  it("returns an empty string when the name has no usable characters", () => {
    expect(hubSlug("—/&!")).toBe("");
  });
});

describe("hubIdFromName", () => {
  it("derives a hub- prefixed id from the name", () => {
    expect(hubIdFromName("Coventry Hub")).toBe("hub-coventry-hub");
  });

  it("falls back to the supplied fallback (e.g. a postcode area) when the name is unsluggable", () => {
    expect(hubIdFromName("", [], "CV")).toBe("hub-cv");
  });

  it("uses hub-hub as a last resort when both name and fallback are empty", () => {
    expect(hubIdFromName("", [], "")).toBe("hub-hub");
  });

  it("appends a numeric suffix on collision with an existing id", () => {
    expect(hubIdFromName("Coventry Hub", ["hub-coventry-hub"])).toBe("hub-coventry-hub-2");
  });

  it("increments the suffix past several existing collisions", () => {
    expect(
      hubIdFromName("Coventry Hub", ["hub-coventry-hub", "hub-coventry-hub-2", "hub-coventry-hub-3"]),
    ).toBe("hub-coventry-hub-4");
  });

  it("does not collide when the base id is free even if a suffixed variant exists", () => {
    expect(hubIdFromName("Coventry Hub", ["hub-coventry-hub-2"])).toBe("hub-coventry-hub");
  });
});
