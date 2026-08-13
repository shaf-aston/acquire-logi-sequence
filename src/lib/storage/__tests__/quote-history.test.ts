import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuoteHistoryStore } from "@/lib/storage/quote-history.store";

const originalCwd = process.cwd();
let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quote-history-"));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("QuoteHistoryStore", () => {
  const quote = {
    route: { origin: "A", destination: "B", distanceMiles: 12, durationSeconds: 600, distanceMethod: "road" as const },
    vans: [],
    lineItems: [],
    subtotal: 0,
    surcharges: 0,
    total: 0,
  };

  it("appends and reads back quote history", async () => {
    const store = new QuoteHistoryStore();
    await store.append(quote);
    const entries = await store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.quote.route.origin).toBe("A");
  });

  // Regression: /api/quote and /api/history run as separate store singletons that
  // share the file but not memory. A stale in-process cache used to hide an order
  // saved by one instance from the other until restart — customer history looked lost.
  it("makes an appended order visible to a separate store instance without a restart", async () => {
    const writer = new QuoteHistoryStore();
    await writer.append(quote, { customer: { name: "Apex Freight", phone: null } });

    const reader = new QuoteHistoryStore();
    const seen = await reader.list();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.customer?.name).toBe("Apex Freight");
  });

  // Reader that observed an empty store must still see a later append (no cached [] ).
  it("reflects a later append after an earlier empty read", async () => {
    const reader = new QuoteHistoryStore();
    expect(await reader.list()).toHaveLength(0);

    await new QuoteHistoryStore().append(quote, { customer: { name: "Late Corp", phone: null } });
    const seen = await reader.list();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.customer?.name).toBe("Late Corp");
  });
});
