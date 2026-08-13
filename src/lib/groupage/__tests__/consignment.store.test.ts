import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "@/config/env";
import { GroupageConsignmentStore } from "@/lib/groupage/consignment.store";
import type { Consignment } from "@/lib/groupage/truck-grouping";

// The store resolves its file under process.cwd() + config path, so each test runs in an
// isolated temp cwd (mirrors quote-history.test.ts).
const originalCwd = process.cwd();
let tempDir = "";

const mk = (company: string): Consignment => ({
  company,
  originPostcode: "CV1 2AB",
  destinationPostcode: "EH1 1AA",
  pallets: [{ footprint: "full", weightKg: 250, quantity: 1 }],
});

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "groupage-consignments-"));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("GroupageConsignmentStore", () => {
  it("appends and reads back newest-first, keeping the pallet lines + id + timestamp", async () => {
    const store = new GroupageConsignmentStore();
    await store.append(mk("Acme"));
    await store.append(mk("Beta"));
    const list = await store.list();
    expect(list.map((r) => r.company)).toEqual(["Beta", "Acme"]);
    expect(list[0]?.id).toBeTruthy();
    expect(list[0]?.createdAt).toBeTruthy();
    expect(list[0]?.pallets).toEqual([{ footprint: "full", weightKg: 250, quantity: 1 }]);
  });

  it("caps at the configured max, dropping the oldest", async () => {
    const store = new GroupageConsignmentStore();
    const limit = getConfig().groupage.consignmentsMaxEntries;
    for (let i = 0; i < limit + 3; i++) await store.append(mk(`C${i}`));
    const list = await store.list();
    expect(list).toHaveLength(limit);
    expect(list[0]?.company).toBe(`C${limit + 2}`); // newest first
    expect(list.some((r) => r.company === "C0")).toBe(false); // oldest dropped
  });

  it("clears the log", async () => {
    const store = new GroupageConsignmentStore();
    await store.append(mk("Acme"));
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it("reads a missing file as empty (fail-soft — never blocks quoting)", async () => {
    const store = new GroupageConsignmentStore();
    expect(await store.list()).toEqual([]);
  });

  it("reads a corrupt file as empty (fail-soft)", async () => {
    mkdirSync(join(tempDir, "data"), { recursive: true });
    writeFileSync(join(tempDir, getConfig().groupage.consignmentsPath), "{ not json", "utf8");
    const store = new GroupageConsignmentStore();
    expect(await store.list()).toEqual([]);
  });
});
