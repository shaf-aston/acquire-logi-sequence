/**
 * Van fleet source. `VanRepository` is the swap-seam: today a JSON-file reader,
 * later the ML-1 admin store — callers (packer service, pricer) depend only on
 * the interface, never on hardcoded vans. Fails loud on a malformed file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getConfig } from "@/config/env";
import type { Dimensions, Van } from "@/lib/packing/packing.types";

export interface VanRepository {
  listVans(): Promise<Van[]>;
  getVan(id: string): Promise<Van | null>;
  upsertVan(van: Van): Promise<void>;
  deleteVan(id: string): Promise<boolean>;
}

export class VanConfigError extends Error {
  constructor(message: string) {
    super(`[vans] ${message}`);
    this.name = "VanConfigError";
  }
}

function parseDimensions(value: unknown, where: string): Dimensions {
  if (typeof value !== "object" || value === null) {
    throw new VanConfigError(`${where} must be an object`);
  }
  const o = value as Record<string, unknown>;
  const dim = (key: string): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new VanConfigError(`${where}.${key} must be a positive number`);
    }
    return v;
  };
  return { l: dim("l"), w: dim("w"), h: dim("h") };
}

function parseVan(value: unknown, i: number): Van {
  if (typeof value !== "object" || value === null) {
    throw new VanConfigError(`vans[${i}] must be an object`);
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim() === "") {
    throw new VanConfigError(`vans[${i}].id must be a non-empty string`);
  }
  if (typeof o.label !== "string" || o.label.trim() === "") {
    throw new VanConfigError(`vans[${i}].label must be a non-empty string`);
  }
  const num = (key: string): number => {
    const v = o[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new VanConfigError(`vans[${i}].${key} must be a non-negative number`);
    }
    return v;
  };

  let doorAperture: Van["doorAperture"];
  if (o.doorAperture !== undefined) {
    const d = o.doorAperture as Record<string, unknown>;
    const ap = (key: string): number => {
      const v = d?.[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        throw new VanConfigError(`vans[${i}].doorAperture.${key} must be a positive number`);
      }
      return v;
    };
    doorAperture = { w: ap("w"), h: ap("h") };
  }

  return {
    id: o.id,
    label: o.label,
    interior: parseDimensions(o.interior, `vans[${i}].interior`),
    maxPayloadKg: num("maxPayloadKg"),
    doorAperture,
    fuelCostPerMile:
      o.fuelCostPerMile === undefined
        ? undefined
        : (() => {
            const v = o.fuelCostPerMile;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              throw new VanConfigError(`vans[${i}].fuelCostPerMile must be a non-negative number`);
            }
            return v;
          })(),
    perMileRate: num("perMileRate"),
    co2GramsPerMile:
      o.co2GramsPerMile === undefined
        ? undefined
        : (() => {
            const v = o.co2GramsPerMile;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
              throw new VanConfigError(`vans[${i}].co2GramsPerMile must be a non-negative number`);
            }
            return v;
          })(),
    quantity:
      o.quantity === undefined
        ? undefined
        : (() => {
            const v = o.quantity;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 1) {
              throw new VanConfigError(`vans[${i}].quantity must be a positive integer`);
            }
            return Math.round(v);
          })(),
    sizeClass:
      o.sizeClass === undefined
        ? undefined
        : (() => {
            if (typeof o.sizeClass !== "string" || o.sizeClass.trim() === "") {
              throw new VanConfigError(`vans[${i}].sizeClass must be a non-empty string`);
            }
            return o.sizeClass.trim();
          })(),
  };
}

/**
 * `collapseDuplicateIds` — how a repeated van id is handled:
 *  - false (default, admin config): duplicate ids are a config error → throw. Each entry in
 *    config/vans.json is a distinct fleet type; a repeat is a genuine authoring mistake.
 *  - true (client override): the payload is a *definition catalogue* looked up by id, not a
 *    fleet roster — the real van count lives in `vanIds`. A fleet with two identical vans
 *    (e.g. two Sprinter L3H2s) legitimately emits the same definition twice, so collapse to
 *    the first occurrence instead of rejecting the quote.
 */
export function parseVansFrom(json: unknown, opts: { collapseDuplicateIds?: boolean } = {}): Van[] {
  if (typeof json !== "object" || json === null) {
    throw new VanConfigError("vans file must be a JSON object");
  }
  const arr = (json as Record<string, unknown>).vans;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new VanConfigError('"vans" must be a non-empty array');
  }
  // Bound validation cost up front — same trust-boundary guard as maxPackableUnits —
  // so both the admin config file and any client-supplied override (e.g. the
  // session Fleet-setup panel) share one enforced ceiling before the parse loop runs.
  const { maxVansToConsider } = getConfig().packing;
  if (arr.length > maxVansToConsider) {
    throw new VanConfigError(`"vans" array too large (${arr.length}) — max ${maxVansToConsider}`);
  }
  const vans = arr.map(parseVan);
  const seen = new Set<string>();
  const unique: Van[] = [];
  for (const v of vans) {
    if (seen.has(v.id)) {
      if (opts.collapseDuplicateIds) continue;
      throw new VanConfigError(`duplicate van id "${v.id}"`);
    }
    seen.add(v.id);
    unique.push(v);
  }
  return unique;
}

/** JSON-file implementation. Reads + validates once, then caches. */
export class FileVanRepository implements VanRepository {
  private cache: Van[] | null = null;

  async listVans(): Promise<Van[]> {
    if (this.cache) return this.cache;
    const path = resolve(process.cwd(), getConfig().packing.vansPath);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      throw new VanConfigError(`cannot read vans file at ${path}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new VanConfigError(`vans file is not valid JSON: ${path}`);
    }
    this.cache = parseVansFrom(json);
    return this.cache;
  }

  async getVan(id: string): Promise<Van | null> {
    const vans = await this.listVans();
    return vans.find((v) => v.id === id) ?? null;
  }

  async upsertVan(van: Van): Promise<void> {
    const vans = await this.listVans();
    const next = vans.filter((v) => v.id !== van.id);
    next.push(van);
    await this.save(next);
  }

  async deleteVan(id: string): Promise<boolean> {
    const vans = await this.listVans();
    const next = vans.filter((v) => v.id !== id);
    if (next.length === vans.length) return false;
    await this.save(next);
    return true;
  }

  private async save(vans: Van[]): Promise<void> {
    const path = resolve(process.cwd(), getConfig().packing.vansPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, vans }, null, 2), "utf8");
    this.cache = vans;
  }
}

/**
 * In-memory implementation — the swap-seam for a client-supplied fleet override
 * (the session "Fleet setup" catalogue) for a single request. No I/O; mirrors
 * FileVanRepository's interface so the packer service never knows which it got.
 */
export class InMemoryVanRepository implements VanRepository {
  private vans: Van[];

  constructor(vans: Van[]) {
    this.vans = vans;
  }

  async listVans(): Promise<Van[]> {
    return this.vans;
  }

  async getVan(id: string): Promise<Van | null> {
    return this.vans.find((v) => v.id === id) ?? null;
  }

  async upsertVan(van: Van): Promise<void> {
    this.vans = [...this.vans.filter((v) => v.id !== van.id), van];
  }

  async deleteVan(id: string): Promise<boolean> {
    const next = this.vans.filter((v) => v.id !== id);
    const changed = next.length !== this.vans.length;
    this.vans = next;
    return changed;
  }
}
