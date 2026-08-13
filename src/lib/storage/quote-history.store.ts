import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "@/config/env";
import type { Quote } from "@/types/api";

export interface QuoteHistoryEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly quote: Quote;
  /** Source PDF filename, when the quote came from an ingested document — powers duplicate-order detection. */
  readonly filename?: string;
  /** Customer/account detected on the source PDF, if any — powers the CRM card + duplicate detection. */
  readonly customer?: { name: string | null; phone: string | null };
}

export interface QuoteHistoryMeta {
  readonly filename?: string;
  readonly customer?: { name: string | null; phone: string | null };
}

export class QuoteHistoryStore {
  private path(): string {
    return resolve(process.cwd(), getConfig().quoteHistory.path);
  }

  /**
   * Always reads from disk. The store is instantiated as an independent module
   * singleton in each route ({@link /api/quote} appends, {@link /api/history} reads)
   * with no shared in-memory state, so an in-process cache here would go stale:
   * orders saved by one route would stay invisible to the other until a restart.
   * The persisted file is small (capped at `quoteHistory.maxEntries`), so a fresh
   * read per call is cheap and keeps customer history reliably persisted.
   */
  async list(): Promise<QuoteHistoryEntry[]> {
    try {
      const raw = await readFile(this.path(), "utf8");
      const parsed = JSON.parse(raw) as QuoteHistoryEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "[]", "utf8");
  }

  async append(quote: Quote, meta?: QuoteHistoryMeta): Promise<QuoteHistoryEntry> {
    const entry: QuoteHistoryEntry = {
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `quote_${Date.now()}`,
      createdAt: new Date().toISOString(),
      quote,
      // Omit undefined keys so the persisted JSON stays clean for entries with no source PDF.
      ...(meta?.filename !== undefined ? { filename: meta.filename } : {}),
      ...(meta?.customer !== undefined ? { customer: meta.customer } : {}),
    };
    const limit = getConfig().quoteHistory.maxEntries;
    const next = [entry, ...(await this.list())].slice(0, limit);
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(next, null, 2), "utf8");
    return entry;
  }
}
