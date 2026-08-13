/**
 * Hub network source. `HubRepository` is the swap-seam (mirrors `VanRepository`): a JSON-file
 * reader today, a per-account store later. Callers depend only on the interface.
 *
 * Hub-sourcing tiers (blueprint "Hub Sourcing"): the file at `config/hubs.json` ships the
 * **default 3PL hub set** (tier 1); the same file is edited in place by the CRUD methods
 * (tier 2, manual customisation). Enforces the core invariant on load: **catchments are disjoint**
 * — one postcode area belongs to exactly one hub, so any address resolves without ambiguity.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "@/config/env";
import type { Hub } from "./groupage.types";

export interface HubRepository {
  listHubs(): Promise<Hub[]>;
  getHub(id: string): Promise<Hub | null>;
  upsertHub(hub: Hub): Promise<void>;
  deleteHub(id: string): Promise<boolean>;
}

export class HubConfigError extends Error {
  /** Set only for a disjoint-catchment clash — lets the UI offer a one-click "take the area over"
   *  fix instead of just showing the raw message (mirrors the admin panel's area-reassign action). */
  readonly conflict?: { area: string; owner: string };

  constructor(message: string, conflict?: { area: string; owner: string }) {
    super(`[hubs] ${message}`);
    this.name = "HubConfigError";
    this.conflict = conflict;
  }
}

function parseHub(value: unknown, i: number): Hub {
  if (typeof value !== "object" || value === null) {
    throw new HubConfigError(`hubs[${i}] must be an object`);
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim() === "") {
    throw new HubConfigError(`hubs[${i}].id must be a non-empty string`);
  }
  if (typeof o.name !== "string" || o.name.trim() === "") {
    throw new HubConfigError(`hubs[${i}].name must be a non-empty string`);
  }
  if (!Array.isArray(o.catchment) || o.catchment.length === 0) {
    throw new HubConfigError(`hubs[${i}].catchment must be a non-empty array of postcode areas`);
  }
  const catchment = o.catchment.map((area, j) => {
    if (typeof area !== "string" || area.trim() === "") {
      throw new HubConfigError(`hubs[${i}].catchment[${j}] must be a non-empty string`);
    }
    return area.trim().toUpperCase();
  });
  // Address is optional (groupage never needs it) but may not be present-and-blank — that would
  // read as "has an address" to a collection run and route from an empty string.
  if (o.address !== undefined && (typeof o.address !== "string" || o.address.trim() === "")) {
    throw new HubConfigError(`hubs[${i}].address must be a non-empty string when present`);
  }
  return {
    id: o.id.trim(),
    name: o.name.trim(),
    catchment,
    ...(o.address !== undefined ? { address: o.address.trim() } : {}),
  };
}

/** Parse + validate the whole hub list, enforcing unique ids and disjoint catchments. */
export function parseHubsFrom(json: unknown): Hub[] {
  if (typeof json !== "object" || json === null) {
    throw new HubConfigError("hubs file must be a JSON object");
  }
  const arr = (json as Record<string, unknown>).hubs;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new HubConfigError('"hubs" must be a non-empty array');
  }
  const hubs = arr.map(parseHub);

  const ids = new Set<string>();
  const areaOwner = new Map<string, string>();
  for (const h of hubs) {
    if (ids.has(h.id)) throw new HubConfigError(`duplicate hub id "${h.id}"`);
    ids.add(h.id);
    for (const area of h.catchment) {
      const owner = areaOwner.get(area);
      if (owner !== undefined && owner !== h.id) {
        throw new HubConfigError(
          `postcode area "${area}" is claimed by both "${owner}" and "${h.id}" — catchments must be disjoint (one area → one hub).`,
          { area, owner },
        );
      }
      areaOwner.set(area, h.id);
    }
  }
  return hubs;
}

/** JSON-file implementation. Reads + validates once, then caches. */
export class FileHubRepository implements HubRepository {
  private cache: Hub[] | null = null;

  async listHubs(): Promise<Hub[]> {
    if (this.cache) return this.cache;
    const path = resolve(process.cwd(), getConfig().groupage.hubsPath);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new HubConfigError(`cannot read hubs file at ${path}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new HubConfigError(`hubs file is not valid JSON: ${path}`);
    }
    this.cache = parseHubsFrom(json);
    return this.cache;
  }

  async getHub(id: string): Promise<Hub | null> {
    const hubs = await this.listHubs();
    return hubs.find((h) => h.id === id) ?? null;
  }

  async upsertHub(hub: Hub): Promise<void> {
    const parsed = parseHubsFrom({ hubs: [...(await this.listHubs()).filter((h) => h.id !== hub.id), hub] });
    await this.save(parsed);
  }

  async deleteHub(id: string): Promise<boolean> {
    const hubs = await this.listHubs();
    const next = hubs.filter((h) => h.id !== id);
    if (next.length === hubs.length) return false;
    if (next.length === 0) {
      // Writing an empty list would brick the network: the next parseHubsFrom throws on load and
      // every quote 500s. Refuse — the network must always have at least one hub.
      throw new HubConfigError("cannot delete the last hub — the network must keep at least one hub.");
    }
    await this.save(next);
    return true;
  }

  private async save(hubs: Hub[]): Promise<void> {
    const path = resolve(process.cwd(), getConfig().groupage.hubsPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, hubs }, null, 2), "utf8");
    this.cache = hubs;
  }
}

/**
 * Overlay SESSION hubs (e.g. lifted off an uploaded manifest) on top of a base network, keeping the
 * disjoint-catchment invariant: a session hub WINS for any postcode area it claims, and any base hub
 * left with no areas drops out. Session hubs come first so `resolveHub`'s `find` prefers them. A base
 * hub sharing an id with a session hub is replaced outright (the session one is the newer truth).
 * Pure — the merge policy lives here, the repository below just applies it per call.
 */
export function mergeSessionHubs(base: readonly Hub[], session: readonly Hub[]): Hub[] {
  const sessionIds = new Set(session.map((h) => h.id));
  const sessionAreas = new Set(session.flatMap((h) => h.catchment));
  const rebased = base
    .filter((h) => !sessionIds.has(h.id))
    .map((h) => ({ ...h, catchment: h.catchment.filter((a) => !sessionAreas.has(a)) }))
    .filter((h) => h.catchment.length > 0);
  return [...session, ...rebased];
}

/**
 * Read-only overlay repository: the saved network (base) with per-request session hubs layered on
 * top (see mergeSessionHubs). This is the "client-supplied hub overrides" seam — a quote routes
 * through the hubs THIS session added without ever writing them to the saved network. Writes throw:
 * session hubs are transient by design, and the saved network is edited only via FileHubRepository.
 */
export class SessionOverlayHubRepository implements HubRepository {
  private readonly session: Hub[];

  constructor(private readonly base: HubRepository, sessionHubs: readonly Hub[]) {
    // Validate the session set on its own (well-formed + internally disjoint) so a bad overlay fails
    // loud here, not deep in a quote. Empty ⇒ a transparent pass-through to the base network.
    this.session = sessionHubs.length > 0 ? parseHubsFrom({ hubs: [...sessionHubs] }) : [];
  }

  private async merged(): Promise<Hub[]> {
    if (this.session.length === 0) return this.base.listHubs();
    return mergeSessionHubs(await this.base.listHubs(), this.session);
  }

  async listHubs(): Promise<Hub[]> {
    return this.merged();
  }

  async getHub(id: string): Promise<Hub | null> {
    return (await this.merged()).find((h) => h.id === id) ?? null;
  }

  async upsertHub(_hub: Hub): Promise<void> {
    throw new HubConfigError("session hubs are read-only — edit the saved network via the Hubs screen.");
  }

  async deleteHub(_id: string): Promise<boolean> {
    throw new HubConfigError("session hubs are read-only — edit the saved network via the Hubs screen.");
  }
}

/** In-memory implementation — the swap-seam for tests and client-supplied hub overrides. */
export class InMemoryHubRepository implements HubRepository {
  private hubs: Hub[];

  constructor(hubs: Hub[]) {
    this.hubs = parseHubsFrom({ hubs });
  }

  async listHubs(): Promise<Hub[]> {
    return this.hubs;
  }

  async getHub(id: string): Promise<Hub | null> {
    return this.hubs.find((h) => h.id === id) ?? null;
  }

  async upsertHub(hub: Hub): Promise<void> {
    this.hubs = parseHubsFrom({ hubs: [...this.hubs.filter((h) => h.id !== hub.id), hub] });
  }

  async deleteHub(id: string): Promise<boolean> {
    const next = this.hubs.filter((h) => h.id !== id);
    if (next.length === this.hubs.length) return false;
    if (next.length === 0) {
      throw new HubConfigError("cannot delete the last hub — the network must keep at least one hub.");
    }
    this.hubs = next;
    return true;
  }
}
