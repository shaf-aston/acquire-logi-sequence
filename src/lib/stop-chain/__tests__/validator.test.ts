import { describe, it, expect } from "vitest";
import { deliveryValidator, collectionValidator } from "@/lib/stop-chain/validator";
import { StopChainError, type Stop } from "@/lib/stop-chain/stop.types";

const pickup = (address: string): Stop => ({ address, kind: "pickup" });
const drop = (address: string): Stop => ({ address, kind: "drop" });
const hub = (address: string): Stop => ({ address, kind: "hub" });

describe("deliveryValidator (Check 1)", () => {
  it("accepts one pickup + drops within the cap", () => {
    expect(() => deliveryValidator([pickup("P"), drop("A"), drop("B")], 3)).not.toThrow();
  });

  it("rejects a blank address, naming the stop", () => {
    expect(() => deliveryValidator([pickup("P"), drop("  ")], 3)).toThrow(/Stop 2 is empty/);
  });

  it("rejects duplicate addresses, naming both", () => {
    expect(() => deliveryValidator([pickup("P"), drop("A"), drop("a")], 3)).toThrow(
      /Stop 2 and Stop 3 are the same/,
    );
  });

  it("requires the first stop to be the pickup", () => {
    expect(() => deliveryValidator([drop("A"), drop("B")], 3)).toThrow(/first stop must be the pickup/);
  });

  it("requires at least one drop", () => {
    expect(() => deliveryValidator([pickup("P")], 3)).toThrow(/at least one drop-off/);
  });

  it("rejects more drops than maxStops", () => {
    expect(() => deliveryValidator([pickup("P"), drop("A"), drop("B")], 1)).toThrow(
      /limit is 1/,
    );
  });

  it("throws a StopChainError tagged 'stops'", () => {
    try {
      deliveryValidator([pickup("P")], 3);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StopChainError);
      expect((e as StopChainError).check).toBe("stops");
    }
  });
});

describe("collectionValidator (hub collection run, Check 1)", () => {
  it("accepts hub-first + pickups within the cap; rejects blanks, duplicates and over-cap the same as delivery", () => {
    expect(() => collectionValidator([hub("Depot"), pickup("A"), pickup("B")], 3)).not.toThrow();
    expect(() => collectionValidator([hub("Depot"), pickup("  ")], 3)).toThrow(/Stop 2 is empty/);
    expect(() => collectionValidator([hub("Depot"), pickup("A"), pickup("a")], 3)).toThrow(
      /Stop 2 and Stop 3 are the same/,
    );
    expect(() => collectionValidator([hub("Depot"), pickup("A"), pickup("B")], 1)).toThrow(/limit is 1/);
  });

  it("requires the hub first and only pickups after it", () => {
    expect(() => collectionValidator([pickup("A"), pickup("B")], 3)).toThrow(/first stop must be the hub/);
    expect(() => collectionValidator([hub("Depot"), pickup("A"), hub("Depot 2")], 3)).toThrow(
      /must be a pickup/,
    );
    expect(() => collectionValidator([hub("Depot"), drop("A")], 3)).toThrow(/must be a pickup/);
  });

  it("requires at least one pickup and rejects an empty list, tagged 'stops'", () => {
    expect(() => collectionValidator([hub("Depot")], 3)).toThrow(/at least one pickup/);
    try {
      collectionValidator([], 3);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StopChainError);
      expect((e as StopChainError).check).toBe("stops");
    }
  });
});
