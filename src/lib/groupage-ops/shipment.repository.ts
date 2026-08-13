/**
 * Shipment persistence. `ShipmentStore` is the swap-seam (interface + File impl), mirroring
 * `HubRepository`; callers depend on the interface. Unlike the append-only QuoteHistoryStore,
 * shipments are MUTATED across several API routes, so the file impl:
 *   - reads FRESH on every call (a stale per-instance cache would silently lose another route's write), and
 *   - SERIALISES writes through a process-wide queue, re-reading inside the lock, so two concurrent
 *     PATCHes to different shipments can't clobber each other (read-modify-write lost-update race).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "@/config/env";
import type { Shipment } from "./lifecycle.types";

export interface ShipmentStore {
  list(): Promise<Shipment[]>;
  get(id: string): Promise<Shipment | null>;
  save(shipment: Shipment): Promise<void>;
  /** Like `save`, but runs `check` against a freshly-read list of every OTHER shipment first,
   *  inside the same write-serialization as the write itself — so a validation that depends on
   *  the full shipment set (e.g. cross-booking capacity) can't be defeated by a second booking
   *  racing in between the check and the write. `check` throws to abort (no write happens). */
  saveWithCheck(shipment: Shipment, check: (existing: Shipment[]) => void): Promise<void>;
}

/** Process-wide write queue: chains save operations so they never interleave file reads/writes. */
let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

export class FileShipmentStore implements ShipmentStore {
  private path(): string {
    return resolve(process.cwd(), getConfig().groupage.shipmentsPath);
  }

  private async readAll(): Promise<Shipment[]> {
    try {
      const raw = await readFile(this.path(), "utf8");
      const parsed = JSON.parse(raw) as Shipment[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async list(): Promise<Shipment[]> {
    return this.readAll();
  }

  async get(id: string): Promise<Shipment | null> {
    return (await this.readAll()).find((s) => s.id === id) ?? null;
  }

  /** Insert or replace by id, newest first — serialised + re-reads inside the lock so concurrent
   *  writes to different shipments merge rather than clobber. */
  async save(shipment: Shipment): Promise<void> {
    await this.saveWithCheck(shipment, () => {});
  }

  async saveWithCheck(shipment: Shipment, check: (existing: Shipment[]) => void): Promise<void> {
    await serialize(async () => {
      const list = await this.readAll();
      const existing = list.filter((s) => s.id !== shipment.id);
      check(existing);
      const next = [shipment, ...existing];
      await mkdir(dirname(this.path()), { recursive: true });
      await writeFile(this.path(), JSON.stringify(next, null, 2), "utf8");
    });
  }
}

/** In-memory test double — mirrors FileShipmentStore's contract (including saveWithCheck's
 *  check-then-write semantics) without touching disk. */
export class InMemoryShipmentStore implements ShipmentStore {
  private shipments: Shipment[];

  constructor(initial: readonly Shipment[] = []) {
    this.shipments = [...initial];
  }

  async list(): Promise<Shipment[]> {
    return [...this.shipments];
  }

  async get(id: string): Promise<Shipment | null> {
    return this.shipments.find((s) => s.id === id) ?? null;
  }

  async save(shipment: Shipment): Promise<void> {
    await this.saveWithCheck(shipment, () => {});
  }

  async saveWithCheck(shipment: Shipment, check: (existing: Shipment[]) => void): Promise<void> {
    const existing = this.shipments.filter((s) => s.id !== shipment.id);
    check(existing);
    this.shipments = [shipment, ...existing];
  }
}
