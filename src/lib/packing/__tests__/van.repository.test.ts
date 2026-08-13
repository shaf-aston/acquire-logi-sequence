import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileVanRepository, parseVansFrom } from "@/lib/packing/van.repository";

const originalCwd = process.cwd();
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "van-repo-"));
  process.chdir(tempDir);
  // Repository resolves config/vans.json relative to cwd — mirror that layout.
  mkdirSync("config", { recursive: true });
  writeFileSync(
    join("config", "vans.json"),
    JSON.stringify({ version: 1, vans: [{ id: "one", label: "One", interior: { l: 1, w: 2, h: 3 }, maxPayloadKg: 4, perMileRate: 5 }] }, null, 2),
    "utf8",
  );
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("FileVanRepository", () => {
  it("upserts and deletes vans in the JSON file", async () => {
    const repo = new FileVanRepository();
    await repo.upsertVan({ id: "two", label: "Two", interior: { l: 6, w: 7, h: 8 }, maxPayloadKg: 9, perMileRate: 10 });
    expect((await repo.listVans()).map((v) => v.id)).toEqual(["one", "two"]);

    const deleted = await repo.deleteVan("one");
    expect(deleted).toBe(true);
    expect((await repo.listVans()).map((v) => v.id)).toEqual(["two"]);
  });
});

describe("parseVansFrom", () => {
  it("rejects duplicate ids", () => {
    expect(() =>
      parseVansFrom({
        vans: [
          { id: "a", label: "A", interior: { l: 1, w: 1, h: 1 }, maxPayloadKg: 1, perMileRate: 1 },
          { id: "a", label: "B", interior: { l: 1, w: 1, h: 1 }, maxPayloadKg: 1, perMileRate: 1 },
        ],
      }),
    ).toThrow();
  });
});
