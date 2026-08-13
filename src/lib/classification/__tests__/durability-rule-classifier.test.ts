/** Rule-based durability classifier — exercised against the real shipped ruleset (config/durability-rules.json). */
import { describe, it, expect } from "vitest";
import { DurabilityRuleClassifier } from "@/lib/classification/durability-rule-classifier";

describe("DurabilityRuleClassifier", () => {
  const classifier = new DurabilityRuleClassifier();

  it("classifies a solid metal as high tier, not brittle, not deformable", async () => {
    const result = await classifier.classify(["Steel"]);
    const steel = result.get("Steel")!;
    expect(steel.durabilityTier).toBe("high");
    expect(steel.brittle).toBe(false);
    expect(steel.deformable).toBe(false);
    expect(steel.confident).toBe(true);
  });

  it("applies the tempered-glass override: low tier, brittle, unlocked orientation", async () => {
    const result = await classifier.classify(["Tempered Glass"]);
    const glass = result.get("Tempered Glass")!;
    expect(glass.durabilityTier).toBe("low");
    expect(glass.brittle).toBe(true);
    expect(glass.orientationLock).toBe("none");
    expect(glass.confident).toBe(true);
  });

  it("classifies foam as none tier and deformable", async () => {
    const result = await classifier.classify(["Foam"]);
    const foam = result.get("Foam")!;
    expect(foam.durabilityTier).toBe("none");
    expect(foam.deformable).toBe(true);
  });

  it("knocks a matched tier down one step for a hollow-build keyword", async () => {
    const solid = await classifier.classify(["MDF"]);
    const hollow = await classifier.classify(["MDF Cabinet"]);
    expect(solid.get("MDF")!.durabilityTier).toBe("medium");
    expect(hollow.get("MDF Cabinet")!.durabilityTier).toBe("low"); // one step down from medium
  });

  it("sets orientationLock from keyword groups (fixed beats partial)", async () => {
    const motor = await classifier.classify(["Electric Motor"]);
    const appliance = await classifier.classify(["Steel Cabinet"]);
    expect(motor.get("Electric Motor")!.orientationLock).toBe("fixed");
    expect(appliance.get("Steel Cabinet")!.orientationLock).toBe("partial");
  });

  it("resolves a mixed material to its WEAKEST component, not the strongest", async () => {
    // "Solid Wood / Foam" matches both high (solid wood) and none (foam). The
    // weakest component must cap durability so the packer never stacks heavy
    // cargo on the foam — matching the Groq engine's weakest-component rule.
    const result = await classifier.classify(["Solid Wood / Foam", "Steel / Foam"]);
    expect(result.get("Solid Wood / Foam")!.durabilityTier).toBe("none");
    expect(result.get("Solid Wood / Foam")!.deformable).toBe(true); // foam present
    expect(result.get("Steel / Foam")!.durabilityTier).toBe("none");
  });

  it("defaults unmatched materials to the configured tier, flagged unconfident", async () => {
    const result = await classifier.classify(["Unobtainium"]);
    const unknown = result.get("Unobtainium")!;
    expect(unknown.confident).toBe(false);
    expect(unknown.durabilityTier).toBe("medium");
  });

  it("dedupes and skips blank/whitespace-only entries", async () => {
    const result = await classifier.classify(["Steel", "  Steel  ", "", "   "]);
    expect(result.size).toBe(1);
    expect(result.has("Steel")).toBe(true);
  });
});
