/**
 * Remembers each priced groupage quote as a CONSIGNMENT so the shared-truck planner can offer
 * "recent quotes" to group — instead of the operator re-typing every company by hand. The groupage
 * quote flow is otherwise compute-and-return (nothing persisted), and it discards the per-company
 * label + pallet lines a 3D stack needs; this store is the one place both are kept.
 *
 * A record is exactly a `Consignment` (the unit `groupConsignments` already consumes) plus an id +
 * timestamp — so what we save is what the planner groups, no reshaping. JSON-file backed, mirroring
 * `QuoteHistoryStore`: config-driven path + a newest-first cap, fail-soft reads (a missing or
 * corrupt file reads as empty, never throws — a remembered-quotes log must never break quoting).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "@/config/env";
import type { Consignment } from "./truck-grouping";

export interface GroupageConsignmentRecord extends Consignment {
  readonly id: string;
  /** ISO timestamp the quote was remembered — drives recency ordering + display. */
  readonly createdAt: string;
}

export class GroupageConsignmentStore {
  private cache: GroupageConsignmentRecord[] | null = null;

  private path(): string {
    return resolve(process.cwd(), getConfig().groupage.consignmentsPath);
  }

  /** Newest-first. Missing/corrupt file ⇒ empty (fail-soft — never blocks the quote path). */
  async list(): Promise<GroupageConsignmentRecord[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path(), "utf8");
      const parsed = JSON.parse(raw) as GroupageConsignmentRecord[];
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  async clear(): Promise<void> {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "[]", "utf8");
    this.cache = [];
  }

  /** Prepend a consignment, capped newest-first at the configured limit. Returns the saved record. */
  async append(consignment: Consignment): Promise<GroupageConsignmentRecord> {
    const record: GroupageConsignmentRecord = {
      ...consignment,
      id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `cons_${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    const limit = getConfig().groupage.consignmentsMaxEntries;
    const next = [record, ...(await this.list())].slice(0, limit);
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(next, null, 2), "utf8");
    this.cache = next;
    return record;
  }
}
