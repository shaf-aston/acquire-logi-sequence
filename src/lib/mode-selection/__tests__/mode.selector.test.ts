import { describe, it, expect } from "vitest";
import { selectMode } from "../mode.selector";
import type { ModeRules, ModeSignals } from "../mode.types";

const RULES: ModeRules = { minDropsForMultiStop: 2, partLoadFillThreshold: 0.5 };

/** A packed single-van, single-drop, half-empty base signal; override per test. */
const base: ModeSignals = {
  dropCount: 1,
  fitsInSingleVan: true,
  vanFillFraction: 0.3,
  packableUnits: 10,
  unplacedCount: 0,
};

describe("selectMode — multi-stop axis", () => {
  it("recommends multi-stop at or above the drop threshold", () => {
    expect(selectMode({ ...base, dropCount: 2 }, RULES).multiStop).toBe(true);
    expect(selectMode({ ...base, dropCount: 5 }, RULES).multiStop).toBe(true);
  });

  it("stays single below the threshold", () => {
    expect(selectMode({ ...base, dropCount: 1 }, RULES).multiStop).toBe(false);
    expect(selectMode({ ...base, dropCount: 0 }, RULES).multiStop).toBe(false);
  });

  it("honours a re-tuned threshold from config, not a hardcoded 2", () => {
    const rules: ModeRules = { ...RULES, minDropsForMultiStop: 3 };
    expect(selectMode({ ...base, dropCount: 2 }, rules).multiStop).toBe(false);
    expect(selectMode({ ...base, dropCount: 3 }, rules).multiStop).toBe(true);
  });
});

describe("selectMode — hubs (share-a-truck) axis", () => {
  it("recommends hubs for a single-van part-load below the fill threshold", () => {
    const rec = selectMode({ ...base, vanFillFraction: 0.22 }, RULES);
    expect(rec.hubs).toBe(true);
    expect(rec.reasons.some((r) => /22% of a van/.test(r))).toBe(true);
  });

  it("does NOT recommend hubs when the van is fuller than the threshold", () => {
    expect(selectMode({ ...base, vanFillFraction: 0.6 }, RULES).hubs).toBe(false);
  });

  it("does NOT recommend hubs when the load needs more than one van", () => {
    expect(selectMode({ ...base, fitsInSingleVan: false, vanFillFraction: 0.9 }, RULES).hubs).toBe(false);
  });

  it("does NOT recommend hubs when some cargo could not be placed", () => {
    expect(selectMode({ ...base, vanFillFraction: 0.2, unplacedCount: 3 }, RULES).hubs).toBe(false);
  });
});

describe("selectMode — confidence", () => {
  it("is low with no load plan yet (fill unknown) and never recommends hubs then", () => {
    const rec = selectMode({ ...base, vanFillFraction: null, packableUnits: 0 }, RULES);
    expect(rec.confidence).toBe("low");
    expect(rec.hubs).toBe(false);
    expect(rec.reasons.some((r) => /waiting on the load plan/i.test(r))).toBe(true);
  });

  it("is high once the load is packed", () => {
    expect(selectMode(base, RULES).confidence).toBe("high");
  });
});

describe("selectMode — direction (deliver vs collect)", () => {
  it("defaults to deliver and leaves the delivery recommendation unchanged", () => {
    const rec = selectMode({ ...base, dropCount: 3 }, RULES);
    expect(rec.direction).toBe("deliver");
    expect(rec.multiStop).toBe(true);
    expect(rec.reasons.some((r) => /delivery addresses/.test(r))).toBe(true);
  });

  it("routes multiple pickups as a collection round on the same threshold", () => {
    const rec = selectMode({ ...base, direction: "collect", dropCount: 0, pickupCount: 3 }, RULES);
    expect(rec.direction).toBe("collect");
    expect(rec.multiStop).toBe(true);
    expect(rec.reasons.some((r) => /pickup addresses/.test(r) && /collection round/.test(r))).toBe(true);
  });

  it("treats a single pickup as a single collection", () => {
    const rec = selectMode({ ...base, direction: "collect", dropCount: 0, pickupCount: 1 }, RULES);
    expect(rec.multiStop).toBe(false);
    expect(rec.reasons.some((r) => /single collection/.test(r))).toBe(true);
  });

  it("drives the axis off pickupCount, not dropCount, when collecting", () => {
    const rec = selectMode({ ...base, direction: "collect", dropCount: 9, pickupCount: 1 }, RULES);
    expect(rec.multiStop).toBe(false);
  });

  it("honours a re-tuned threshold for pickups too", () => {
    const rules: ModeRules = { ...RULES, minDropsForMultiStop: 3 };
    expect(selectMode({ ...base, direction: "collect", pickupCount: 2 }, rules).multiStop).toBe(false);
    expect(selectMode({ ...base, direction: "collect", pickupCount: 3 }, rules).multiStop).toBe(true);
  });
});

describe("selectMode — the two axes are independent", () => {
  it("recommends BOTH multi-stop and hubs for a multi-drop part-load", () => {
    const rec = selectMode({ ...base, dropCount: 3, vanFillFraction: 0.2 }, RULES);
    expect(rec.multiStop).toBe(true);
    expect(rec.hubs).toBe(true);
  });
});

describe("selectMode — load-sharing vs routing (split axes)", () => {
  it("reports loadSharing='shared' for a part-load, with hubs as its alias", () => {
    const rec = selectMode({ ...base, vanFillFraction: 0.2 }, RULES);
    expect(rec.loadSharing).toBe("shared");
    expect(rec.hubs).toBe(rec.loadSharing === "shared");
  });

  it("reports loadSharing='dedicated' for a full van", () => {
    const rec = selectMode({ ...base, vanFillFraction: 0.6 }, RULES);
    expect(rec.loadSharing).toBe("dedicated");
    expect(rec.hubs).toBe(false);
  });

  it("routing is an independent advisory axis, defaulting to direct", () => {
    expect(selectMode({ ...base, vanFillFraction: 0.2 }, RULES).routing).toBe("direct");
    expect(selectMode({ ...base, vanFillFraction: 0.6 }, RULES).routing).toBe("direct");
  });
});
