/**
 * The branch ORDER here is the whole point. A hub-consolidation manifest is also, literally, a
 * collection round — so if the collect check ran first, every groupage sheet would open the
 * pickup-round form and the standard reader would mis-count it. These tests pin that precedence.
 */
import { describe, it, expect } from "vitest";
import { routeManifest, type RoutingSignals } from "@/lib/mode-selection/manifest-routing";

const signals = (over: Partial<RoutingSignals> = {}): RoutingSignals => ({
  isHubManifest: false,
  dropCount: 1,
  hasPickup: true,
  minDropsForMultiStop: 2,
  ...over,
});

describe("routeManifest", () => {
  it("sends a hub-consolidation manifest to the shared-truck planner", () => {
    const d = routeManifest(signals({ isHubManifest: true, dropCount: 6 }));
    expect(d.mode).toBe("groupage");
    expect(d.reasons[0]).toMatch(/groupage|consolidation/i);
  });

  it("hub manifest BEATS collect-direction — a consolidation sheet is also a collection run", () => {
    // The regression guard: this exact combination (hub manifest + collect wording) is what a real
    // consolidation manifest looks like. It must NOT land on the pickup-round form.
    expect(routeManifest(signals({ isHubManifest: true, direction: "collect" })).mode).toBe("groupage");
  });

  it("sends a collection round (milk-run) to collection mode, and counts the pickups", () => {
    const d = routeManifest(signals({ direction: "collect", dropCount: 5, hasPickup: true }));
    expect(d.mode).toBe("collection");
    expect(d.reasons[0]).toMatch(/6 pickups/); // 5 drops + the pickup itself
  });

  it("sends drops at or above the configured threshold to multi-stop", () => {
    expect(routeManifest(signals({ dropCount: 2, minDropsForMultiStop: 2 })).mode).toBe("multi");
    expect(routeManifest(signals({ dropCount: 9, minDropsForMultiStop: 2 })).mode).toBe("multi");
  });

  it("sends a lone drop to single mode", () => {
    expect(routeManifest(signals({ dropCount: 1, minDropsForMultiStop: 2 })).mode).toBe("single");
  });

  it("never auto-switches to multi-stop when the threshold is missing from config", () => {
    // No client-side default: without the configured threshold we do not invent one. 4 drops with no
    // rule is NOT enough to force multi-stop — the operator decides.
    const d = routeManifest(signals({ dropCount: 4, minDropsForMultiStop: undefined }));
    expect(d.mode).not.toBe("multi");
  });

  it("routes nothing when the sheet carries no addresses at all", () => {
    const d = routeManifest(signals({ dropCount: 0, hasPickup: false }));
    expect(d.mode).toBeNull();
    expect(d.reasons).toEqual([]);
  });

  it("leaves the operator where they are on a pickup-only sheet — and says why", () => {
    // There IS a document, but nothing in it decides a route. Changing mode on a guess would be worse
    // than doing nothing, so we do nothing — but never silently.
    const d = routeManifest(signals({ dropCount: 0, hasPickup: true }));
    expect(d.mode).toBeNull();
    expect(d.reasons[0]).toMatch(/no delivery addresses/i);
  });
});
