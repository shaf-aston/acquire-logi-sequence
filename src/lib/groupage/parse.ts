/**
 * Trust-boundary parsers for groupage request bodies — shared by /api/groupage and /api/shipments
 * so both validate the same untrusted shape identically (MRMR). Throws GroupageError (→400) on any
 * bad field; the domain modules re-validate the semantics downstream.
 */
import { GroupageError, PALLET_FOOTPRINT_CLASSES, type GroupagePallet, type GroupageRouting, type Hub } from "./groupage.types";

const FOOTPRINTS = new Set<string>(PALLET_FOOTPRINT_CLASSES);

// A manifest names a handful of hubs (collection + destination, occasionally a via-hub). Cap the
// client-supplied overlay so a spoofed body can't flood the network; well above any real manifest.
const MAX_SESSION_HUBS = 12;
// Bounds mirror /api/hubs so a session hub can't carry more than a saved one.
const MAX_HUB_NAME = 80;
const MAX_HUB_ADDRESS = 200;
const MAX_CATCHMENT_AREAS = 200;
const MAX_AREA_LEN = 4;

// Longest real UK postcode ("EC1A 1BB"-style) is 8 chars; this leaves slack for stray
// whitespace without letting a postcode-shaped megastring through to storage.
const MAX_POSTCODE_LENGTH = 12;
// Free-text company/customer label — bounded so a megastring can't reach storage. Generous
// enough for a real trading name; the field is optional and purely a display label.
const MAX_COMPANY_LENGTH = 120;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parsePostcode(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new GroupageError("input", `Missing '${field}'.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_POSTCODE_LENGTH) {
    throw new GroupageError("input", `'${field}' is too long (max ${MAX_POSTCODE_LENGTH} characters).`);
  }
  return trimmed;
}

/** Optional company/customer label. Absent/blank ⇒ undefined; trimmed and length-capped. Free
 *  text (a trading name), so no format check — only presence + bound. Purely a display label
 *  used to colour the shared-truck stack and title a saved consignment. */
function parseCustomerName(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length > MAX_COMPANY_LENGTH) {
    throw new GroupageError("input", `'customerName' is too long (max ${MAX_COMPANY_LENGTH} characters).`);
  }
  return trimmed;
}

/** Optional routing choice. Absent ⇒ undefined (service falls back to the config default). */
function parseRouting(raw: unknown): GroupageRouting | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw !== "direct" && raw !== "via-hub") {
    throw new GroupageError("input", "'routing' must be 'direct' or 'via-hub'.");
  }
  return raw;
}

function parseEta(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!isValidIsoDate(trimmed)) {
    throw new GroupageError("input", "'eta' must be a real date in YYYY-MM-DD format.");
  }
  return trimmed;
}

export function parseGroupagePallets(raw: unknown, maxLines: number): GroupagePallet[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new GroupageError("input", "Add at least one pallet line.");
  }
  // Bound the work BEFORE allocating/iterating — a huge array is a DoS vector. Each line is ≥1
  // pallet, so more lines than the per-booking pallet cap is already over the limit.
  if (raw.length > maxLines) {
    throw new GroupageError("input", `Too many pallet lines (${raw.length}); the limit is ${maxLines} — split into a second booking.`);
  }
  return raw.map((p, i) => {
    const o = p as Record<string, unknown>;
    if (typeof o?.footprint !== "string" || !FOOTPRINTS.has(o.footprint)) {
      throw new GroupageError("input", `Pallet line ${i + 1}: footprint must be one of ${[...FOOTPRINTS].join(", ")}.`);
    }
    if (typeof o.weightKg !== "number" || !Number.isFinite(o.weightKg) || o.weightKg <= 0) {
      throw new GroupageError("input", `Pallet line ${i + 1}: weight must be greater than 0 kg.`);
    }
    if (typeof o.quantity !== "number" || !Number.isInteger(o.quantity) || o.quantity < 1) {
      throw new GroupageError("input", `Pallet line ${i + 1}: quantity must be a whole number ≥ 1.`);
    }
    return {
      footprint: o.footprint as GroupagePallet["footprint"],
      weightKg: o.weightKg,
      quantity: o.quantity,
      // Station refs are OMITTED when absent, never set to null: `routePallets` reads `undefined`
      // as "rides the whole trunk", and the saved-consignment round-trip depends on the key set.
      ...(stationRef(o.joinAtHubId, i + 1, "joinAtHubId") ?? {}),
      ...(stationRef(o.leaveAtHubId, i + 1, "leaveAtHubId") ?? {}),
    };
  });
}

/** Optional per-line trunk station ref. Absent/blank ⇒ the key is omitted entirely. */
function stationRef(raw: unknown, lineNo: number, field: "joinAtHubId" | "leaveAtHubId"): Record<string, string> | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.trim() === "" || raw.trim().length > MAX_HUB_NAME) {
    throw new GroupageError("input", `Pallet line ${lineNo}: ${field} must be a non-empty string when present.`);
  }
  return { [field]: raw.trim() };
}

/**
 * Ordered intermediate trunk stops (hub ids). Absent ⇒ [].
 *
 * `maxStops` bounds an untrusted array before it is iterated (a DoS bound), and is DERIVED from the
 * one business ceiling — `maxTrunkHops`, since hops = stops + 1 — so this layer can never reject a
 * stop count the routing config allows. Semantic checks (unknown hub, duplicate, an end hub) belong
 * to `resolveStops`, which knows the network; the hop ceiling itself is re-asserted in `buildPath`,
 * which also guards the callers that never pass through here (a consignment loaded from disk).
 */
export function parseTrunkStopHubIds(raw: unknown, maxStops: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new GroupageError("input", "'trunkStopHubIds' must be an array.");
  if (raw.length > maxStops) {
    throw new GroupageError(
      "input",
      maxStops === 0
        ? `This route allows no intermediate stops; ${raw.length} were given. Raise the trunk-hop limit in your groupage routing config, or remove them.`
        : `Too many intermediate stops (${raw.length}); the limit is ${maxStops}.`,
    );
  }
  return raw.map((v, i) => {
    if (typeof v !== "string" || v.trim() === "" || v.trim().length > MAX_HUB_NAME) {
      throw new GroupageError("input", `trunkStopHubIds[${i}] must be a non-empty string.`);
    }
    return v.trim();
  });
}

/**
 * Trust-boundary parse for client-supplied SESSION hubs (hubs lifted off the uploaded manifest and
 * carried back on the quote request). Validates shape + bounds + uniqueness/disjointness, so a
 * spoofed body can never inject an oversized or ambiguous overlay. Absent/empty ⇒ [] (no overlay).
 * Returns clean domain `Hub`s ready to layer over the saved network (see SessionOverlayHubRepository).
 */
export function parseSessionHubs(raw: unknown): Hub[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new GroupageError("input", "'sessionHubs' must be an array.");
  if (raw.length === 0) return [];
  if (raw.length > MAX_SESSION_HUBS) {
    throw new GroupageError("input", `Too many session hubs (${raw.length}); the limit is ${MAX_SESSION_HUBS}.`);
  }

  const ids = new Set<string>();
  const areaOwner = new Map<string, string>();
  return raw.map((value, i): Hub => {
    const o = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const str = (v: unknown, name: string, max: number): string => {
      if (typeof v !== "string" || v.trim() === "") throw new GroupageError("input", `sessionHubs[${i}].${name} must be a non-empty string.`);
      if (v.trim().length > max) throw new GroupageError("input", `sessionHubs[${i}].${name} is too long (max ${max}).`);
      return v.trim();
    };

    const id = str(o.id, "id", MAX_HUB_NAME);
    if (ids.has(id)) throw new GroupageError("input", `sessionHubs: duplicate hub id "${id}".`);
    ids.add(id);
    const name = str(o.name, "name", MAX_HUB_NAME);

    if (!Array.isArray(o.catchment) || o.catchment.length === 0) {
      throw new GroupageError("input", `sessionHubs[${i}].catchment must be a non-empty array of postcode areas.`);
    }
    if (o.catchment.length > MAX_CATCHMENT_AREAS) {
      throw new GroupageError("input", `sessionHubs[${i}].catchment has too many areas.`);
    }
    const catchment = o.catchment.map((area, j): string => {
      if (typeof area !== "string" || area.trim() === "") throw new GroupageError("input", `sessionHubs[${i}].catchment[${j}] must be a non-empty string.`);
      const a = area.trim().toUpperCase();
      if (a.length > MAX_AREA_LEN) throw new GroupageError("input", `sessionHubs[${i}].catchment[${j}] "${area}" is not a valid postcode area.`);
      const owner = areaOwner.get(a);
      if (owner !== undefined && owner !== id) {
        throw new GroupageError("input", `sessionHubs: postcode area "${a}" is claimed by two hubs — one area belongs to one hub.`);
      }
      areaOwner.set(a, id);
      return a;
    });

    // Address optional; present-and-blank is rejected (a collection run would route from "").
    let address: string | undefined;
    if (o.address !== undefined && o.address !== null && String(o.address).trim() !== "") {
      address = str(o.address, "address", MAX_HUB_ADDRESS);
    }
    return { id, name, catchment, ...(address !== undefined ? { address } : {}) };
  });
}

export interface ParsedGroupageQuoteInput {
  readonly originPostcode: string;
  readonly destinationPostcode: string;
  readonly pallets: GroupagePallet[];
  readonly routing?: GroupageRouting;
  readonly eta: string | null;
  /** Optional company/customer label — drives the saved consignment + per-company colour. */
  readonly customerName?: string;
  /** Ordered intermediate trunk stops (hub ids). `[]` ⇒ a point-to-point trunk, as before. */
  readonly trunkStopHubIds: string[];
}

/** `maxTrunkHops` is the routing config's hop ceiling; a trunk of H hops calls at H-1 stops. */
export function parseGroupageQuoteInput(body: unknown, maxPalletLines: number, maxTrunkHops: number): ParsedGroupageQuoteInput {
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return {
    originPostcode: parsePostcode(o.originPostcode, "originPostcode"),
    destinationPostcode: parsePostcode(o.destinationPostcode, "destinationPostcode"),
    pallets: parseGroupagePallets(o.pallets, maxPalletLines),
    routing: parseRouting(o.routing),
    eta: parseEta(o.eta),
    customerName: parseCustomerName(o.customerName),
    // No routing check here: `routing` may be absent, and only the service knows `defaultRouting`.
    trunkStopHubIds: parseTrunkStopHubIds(o.trunkStopHubIds, Math.max(0, maxTrunkHops - 1)),
  };
}

/** Optional anti-drift guard on POST /api/shipments — the operator's on-screen quote total,
 *  checked against the fresh server-side re-quote before persisting (see bookGroupageQuote).
 *  Absent ⇒ no check (used only by the booking route, never by /api/groupage itself). */
export function parseExpectedTotal(body: unknown): number | null {
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (o.expectedTotal === undefined || o.expectedTotal === null) return null;
  if (typeof o.expectedTotal !== "number" || !Number.isFinite(o.expectedTotal) || o.expectedTotal < 0) {
    throw new GroupageError("input", "'expectedTotal' must be a non-negative number.");
  }
  return o.expectedTotal;
}

/**
 * Reads a request body capped at `maxBytes`, aborting the read mid-stream once the cap is
 * exceeded — a spoofed or missing Content-Length must not let an oversized body be fully
 * materialized in memory before rejection. Falls back to the (cheap, spoofable) declared
 * Content-Length as a fast-path rejection when present.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new GroupageError("input", `Request body is too large (max ${maxBytes} bytes).`);
    }
  }
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new GroupageError("input", `Request body is too large (max ${maxBytes} bytes).`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text);
}
