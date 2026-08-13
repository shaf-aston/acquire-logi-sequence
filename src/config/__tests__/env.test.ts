import { describe, it, expect } from "vitest";
import { buildConfigFrom } from "@/config/env";

describe("config: ROUTE_RETURN_FACTOR", () => {
  it("rejects 0 at load (would zero out every quote's distance)", () => {
    expect(() => buildConfigFrom({ ROUTE_RETURN_FACTOR: "0" })).toThrow(/ROUTE_RETURN_FACTOR/);
  });

  it("still rejects negatives", () => {
    expect(() => buildConfigFrom({ ROUTE_RETURN_FACTOR: "-1" })).toThrow(/ROUTE_RETURN_FACTOR/);
  });

  it("accepts a positive factor", () => {
    expect(buildConfigFrom({ ROUTE_RETURN_FACTOR: "1.5" }).routing.returnFactor).toBe(1.5);
  });

  it("defaults to 2 when unset", () => {
    expect(buildConfigFrom({}).routing.returnFactor).toBe(2);
  });
});

describe("config: multiStop knobs", () => {
  it("defaults maxStops=25 (Google's waypoint ceiling), per-stop handling=15, optimize=off", () => {
    const cfg = buildConfigFrom({});
    expect(cfg.multiStop.maxStops).toBe(25);
    expect(cfg.multiStop.loadUnloadMinutesPerStop).toBe(15);
    expect(cfg.multiStop.optimizeWaypointOrder).toBe(false);
  });

  it("rejects maxStops < 1", () => {
    expect(() => buildConfigFrom({ MULTI_STOP_MAX_STOPS: "0" })).toThrow(/MULTI_STOP_MAX_STOPS/);
  });

  it("rejects maxStops > 25 (Google's per-request waypoint limit)", () => {
    expect(() => buildConfigFrom({ MULTI_STOP_MAX_STOPS: "26" })).toThrow(/MULTI_STOP_MAX_STOPS/);
  });

  it("reads overrides", () => {
    const cfg = buildConfigFrom({
      MULTI_STOP_MAX_STOPS: "5",
      MULTI_STOP_LOAD_UNLOAD_MINUTES_PER_STOP: "20",
      MULTI_STOP_OPTIMIZE_WAYPOINT_ORDER: "true",
    });
    expect(cfg.multiStop.maxStops).toBe(5);
    expect(cfg.multiStop.loadUnloadMinutesPerStop).toBe(20);
    expect(cfg.multiStop.optimizeWaypointOrder).toBe(true);
  });
});

describe("config: addressExtraction knobs", () => {
  it("defaults to the rule provider with an empty groq key/model", () => {
    const cfg = buildConfigFrom({});
    expect(cfg.addressExtraction.provider).toBe("rule");
    expect(cfg.addressExtraction.groq.apiKey).toBe("");
    expect(cfg.addressExtraction.groq.model).toBe("");
    expect(cfg.addressExtraction.groq.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(cfg.addressExtraction.groq.maxInputChars).toBe(20000);
  });

  it("reads the groq provider + its own separate key/model", () => {
    const cfg = buildConfigFrom({
      ADDRESS_EXTRACTOR_PROVIDER: "groq",
      ADDRESS_GROQ_API_KEY: "addr-key",
      ADDRESS_GROQ_MODEL: "llama-3.3-70b-versatile",
      GROQ_API_KEY: "durability-key",
    });
    expect(cfg.addressExtraction.provider).toBe("groq");
    expect(cfg.addressExtraction.groq.apiKey).toBe("addr-key");
    expect(cfg.addressExtraction.groq.model).toBe("llama-3.3-70b-versatile");
    // Independent from the durability classifier's key — the two never share a value.
    expect(cfg.durability.groq.apiKey).toBe("durability-key");
  });

  it("rejects a non-positive max input char cap", () => {
    expect(() => buildConfigFrom({ ADDRESS_GROQ_MAX_INPUT_CHARS: "0" })).toThrow(
      /ADDRESS_GROQ_MAX_INPUT_CHARS/,
    );
  });
});

describe("config: modeSelection (decision matrix) knobs", () => {
  it("defaults minDrops=2 and partLoadFill=0.5", () => {
    const cfg = buildConfigFrom({});
    expect(cfg.modeSelection.minDropsForMultiStop).toBe(2);
    expect(cfg.modeSelection.partLoadFillThreshold).toBe(0.5);
  });

  it("rejects minDropsForMultiStop < 1", () => {
    expect(() => buildConfigFrom({ MODE_MIN_DROPS_FOR_MULTISTOP: "0" })).toThrow(
      /MODE_MIN_DROPS_FOR_MULTISTOP/,
    );
  });

  it("rejects a fill fraction of 0 (would never flag a part-load)", () => {
    expect(() => buildConfigFrom({ MODE_PART_LOAD_FILL_THRESHOLD: "0" })).toThrow(
      /MODE_PART_LOAD_FILL_THRESHOLD/,
    );
  });

  it("rejects a fill fraction > 1 (nonsense — would recommend sharing for every load)", () => {
    expect(() => buildConfigFrom({ MODE_PART_LOAD_FILL_THRESHOLD: "1.5" })).toThrow(
      /MODE_PART_LOAD_FILL_THRESHOLD/,
    );
  });

  it("accepts exactly 1.0 (share unless the van is 100% full)", () => {
    expect(buildConfigFrom({ MODE_PART_LOAD_FILL_THRESHOLD: "1" }).modeSelection.partLoadFillThreshold).toBe(1);
  });
});
