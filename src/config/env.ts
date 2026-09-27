/**
 * Single source of truth for all runtime configuration.
 *
 * Rule: no other module reads `process.env` directly. Every tunable lives here,
 * is typed, coerced, and validated once at first import. Defaults are explicit
 * and centralised — never scattered as magic literals across the codebase.
 */

type RawEnv = Record<string, string | undefined>;

class ConfigError extends Error {
  constructor(message: string) {
    super(`[config] ${message}`);
    this.name = "ConfigError";
  }
}

function readString(raw: RawEnv, key: string, fallback?: string): string {
  const value = raw[key]?.trim();
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`Missing required env var: ${key}`);
  }
  return value;
}

function readInt(
  raw: RawEnv,
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
): number {
  const value = raw[key]?.trim();
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  const min = opts.min ?? 0;
  if (!Number.isFinite(parsed) || parsed < min || (opts.max !== undefined && parsed > opts.max)) {
    const lower = min === 0 ? "a non-negative integer" : `an integer >= ${min}`;
    const bound = opts.max !== undefined ? `${lower} and <= ${opts.max}` : lower;
    throw new ConfigError(`Env var ${key} must be ${bound}, got "${value}"`);
  }
  return parsed;
}

function readFloat(
  raw: RawEnv,
  key: string,
  fallback: number,
  opts: { min?: number; exclusiveMin?: boolean; max?: number } = {},
): number {
  const value = raw[key]?.trim();
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseFloat(value);
  const min = opts.min ?? 0;
  const belowBound = opts.exclusiveMin ? parsed <= min : parsed < min;
  const aboveBound = opts.max !== undefined && parsed > opts.max;
  if (!Number.isFinite(parsed) || belowBound || aboveBound) {
    const lower = opts.exclusiveMin
      ? `a number > ${min}`
      : min === 0
        ? "a non-negative number"
        : `a number >= ${min}`;
    const bound = opts.max !== undefined ? `${lower} and <= ${opts.max}` : lower;
    throw new ConfigError(`Env var ${key} must be ${bound}, got "${value}"`);
  }
  return parsed;
}

function readBool(raw: RawEnv, key: string, fallback: boolean): boolean {
  const value = raw[key]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new ConfigError(`Env var ${key} must be a boolean, got "${value}"`);
}

function readCsv(raw: RawEnv, key: string, fallback: string[]): string[] {
  const value = raw[key]?.trim();
  if (value === undefined || value === "") return fallback;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

function readLogLevel(raw: RawEnv, key: string, fallback: LogLevel): LogLevel {
  const value = raw[key]?.trim().toLowerCase() as LogLevel | undefined;
  if (!value) return fallback;
  if (!LOG_LEVELS.includes(value)) {
    throw new ConfigError(`Env var ${key} must be one of ${LOG_LEVELS.join("|")}, got "${value}"`);
  }
  return value;
}

export interface AppConfig {
  readonly ocr: {
    readonly provider: string;
    readonly apiKey: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly retryBaseDelayMs: number;
    readonly includeImages: boolean;
    readonly cache: {
      /** Reuse a prior OCR result for an identical PDF instead of re-billing the provider. */
      readonly enabled: boolean;
      /** Directory holding cached OCR results (one JSON per content hash + provider). */
      readonly dir: string;
    };
    readonly tesseract: {
      readonly lang: string;
      readonly scale: number;
      /** Drop OCR words below this confidence (0–100) before reconstructing tables. */
      readonly minConfidence: number;
      /** New row when vertical gap exceeds this × median word height. */
      readonly rowGapFactor: number;
      /** New column when horizontal gap exceeds this × median word height. */
      readonly colGapFactor: number;
      /** A row needs at least this many words to count as tabular. */
      readonly minColumns: number;
      /** A segment needs at least this many rows to be emitted as a table. */
      readonly minTableRows: number;
    };
    /** Embedded-text-layer reader + the `auto` fail-soft chain around it. */
    readonly textlayer: {
      /** `auto` uses the text layer when per-page non-whitespace chars ≥ this; else OCR. */
      readonly minYieldChars: number;
      /** OCR engine the `auto` chain falls back to for scanned/image PDFs. */
      readonly fallbackProvider: string;
      /** Same table-reconstruction knobs as tesseract (relative to text height, so scale-free). */
      readonly rowGapFactor: number;
      readonly colGapFactor: number;
      readonly minColumns: number;
      readonly minTableRows: number;
    };
  };
  readonly ingest: {
    readonly maxFileBytes: number;
    readonly allowedMimeTypes: string[];
    /** Pickup/delivery address-detection ruleset (labels + postcode pattern). */
    readonly addressDetectionPath: string;
  };
  /**
   * Pickup/delivery address extraction from the OCR'd quotation. "rule" uses the
   * label+postcode detector; "groq" reads the whole page with an LLM (its own key,
   * separate from the durability classifier's). See src/lib/ingestion/address-extractor.factory.
   */
  readonly addressExtraction: {
    readonly provider: string;
    readonly groq: {
      readonly apiKey: string;
      readonly model: string;
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly maxRetries: number;
      readonly retryBaseDelayMs: number;
      /** Cap on the document text sent to the LLM — bounds token cost; over-long docs are truncated. */
      readonly maxInputChars: number;
    };
  };
  /**
   * Reads a ROSTER of consignments (several companies, each with its own origin,
   * destination, and pallets) off an OCR'd manifest/quote for the shared-truck
   * planner. "rule" is inert (empty roster); "groq" reads the document with an LLM
   * on its own key. See src/lib/groupage/consignment-reader.factory.
   */
  readonly consignmentReader: {
    readonly provider: string;
    readonly groq: {
      readonly apiKey: string;
      readonly model: string;
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly maxRetries: number;
      readonly retryBaseDelayMs: number;
      /** Cap on the document text sent to the LLM — bounds token cost; over-long docs are truncated. */
      readonly maxInputChars: number;
    };
  };
  readonly classification: {
    readonly provider: string;
    readonly rulesPath: string;
  };
  readonly durability: {
    readonly provider: string;
    readonly rulesPath: string;
    readonly tiersPath: string;
    readonly groq: {
      readonly apiKey: string;
      readonly model: string;
      readonly baseUrl: string;
      readonly timeoutMs: number;
      readonly maxRetries: number;
      readonly retryBaseDelayMs: number;
      /** Unique materials per Groq request; the remainder chunks into further sequential (never parallel) calls. */
      readonly maxItemsPerCall: number;
    };
    /** Backup LLM endpoint (SambaNova, OpenAI-compatible). Tried when Groq fails,
     *  before the rule classifier. Inert unless both apiKey and model are set. */
    readonly sambanova: {
      readonly apiKey: string;
      readonly model: string;
      readonly baseUrl: string;
    };
  };
  readonly packing: {
    /** Stacking matrix file (category → stack rules + fallback density). */
    readonly stackabilityPath: string;
    /** Column-map file (table column indices + category code patterns). */
    readonly columnMapPath: string;
    /** Van fleet presets file. */
    readonly vansPath: string;
    /** Clearance slack (m) allowed when fitting a box into the interior / gaps. */
    readonly toleranceM: number;
    /**
     * Highest a worker may place an item's base by hand, without a ladder or
     * forklift (m). A placement whose base sits above this is refused — the
     * item's own height above that is fine (it was lowered into place, not
     * reached into). Fleet-wide: worker reach doesn't change per vehicle.
     */
    readonly maxReachHeightM: number;
    /** Cap on how many fleet vans the ranking fallback will evaluate. */
    readonly maxVansToConsider: number;
    /**
     * Safety valve, not a business ceiling: the packer runs synchronously inside the
     * request, so a genuinely enormous job could hang the connection until it times out.
     * This is the point past which we'd rather fail with a clear message than leave the
     * page spinning — it is NOT "the biggest order we'll take". Measured against the real
     * fleet + allocator (2026-07-01): ~1,300 units ≈ 6s, ~3,800 ≈ 15s, ~5,800 ≈ 24s; cost
     * tracks the number of vans a job needs more than the raw unit count. The real fix for
     * routinely-large orders is to pack identical SKUs as a pattern (pack one, multiply) or
     * move packing to a background job — see heuristic-packer.ts's stateVersion comment.
     * Until then this is set high enough that ordinary big orders pass; raise via
     * PACKING_MAX_PACKABLE_UNITS if a real job exceeds it.
     */
    readonly maxPackableUnits: number;
    /**
     * Block-consolidation domain knobs file (enabled flag + grid/threshold tuning).
     * See src/lib/packing/consolidation-config.ts / consolidation.ts.
     */
    readonly consolidationPath: string;
    /**
     * Post-consolidation cap on placeable OBJECTS (blocks + any pass-through loose
     * units), not real units — this is what actually bounds packer/allocator
     * runtime, since each object costs one anchor scan regardless of how many real
     * units it represents. Distinct from `maxPackableUnits`, which still gates the
     * pre-consolidation real-unit count used for quoting math. Raise via
     * PACKING_MAX_PACKABLE_BLOCKS if a real job needs more.
     */
    readonly maxPackableBlocks: number;
    /**
     * Real memory/time ceiling on how many individual units one job may expand to
     * in total (pre-consolidation), independent of how few blocks that collapses
     * into — protects against a single pathological SKU (e.g. a 10-million-unit
     * typo) that would consolidate into a handful of blocks yet still require
     * building/holding a huge intermediate unit list. Deliberately far higher than
     * `maxPackableUnits` (which caps the UNCONSOLIDATED path) since consolidation's
     * whole point is to let genuinely huge identical-SKU orders through.
     */
    readonly maxConsolidatedUnits: number;
    /** Fractional fuel uplift at max payload vs empty (UK diesel benchmark ~0.15). */
    readonly fuelLoadUplift: number;
    /**
     * Bulk-run fast-path trigger: when a single dominant SKU consolidates to MORE than
     * this many placeable blocks, the allocator packs one representative van and
     * multiplies it (see bulk-run-allocator.ts) instead of scanning every block — the
     * fix for huge single-SKU orders that would otherwise blow `maxPackableBlocks` and
     * time out. Keep it well above the per-pack cap so ordinary large orders still use
     * the exact/greedy allocator unchanged. Raise/lower via PACKING_BULK_RUN_MIN_UNITS.
     */
    readonly bulkRunMinUnits: number;
    /**
     * Two fleets whose summed per-mile rate differs by less than this (GBP/mile) are
     * treated as cost-equal, so the secondary tie-breaks (fewer vans, then fuller vans)
     * decide. A few pence of rate — small enough that we never pick a meaningfully
     * pricier fleet just to save a van. See fleet-allocator.ts's `betterAllocation` /
     * `pickCheapestVan`.
     */
    readonly costEpsilon: number;
    /**
     * Units handed to any single pack(). A van holds at most a few dozen, so this bounds
     * per-pack cost without ever starving a van of options to fill it — used as the
     * fleet-allocator's default `exactSearchMaxUnits` AND as the bulk fast-path's
     * per-representative-pack slice, so the two van-selection paths stay bit-for-bit
     * consistent. See fleet-allocator.ts / bulk-run-allocator.ts / packer.service.ts.
     */
    readonly packCap: number;
    /**
     * Branch-and-bound search nodes the exact fleet allocator explores before falling
     * back to the cost-efficient greedy completion. See fleet-allocator.ts `allocateFleet`.
     */
    readonly searchNodeBudget: number;
    /**
     * Assumed number of copies of a van a customer owns when its `quantity` field is
     * unset. ONE knob shared by every site that resolves fleet availability (the exact
     * allocator, the bulk fast-path's split-retry, and the admin what-if fleet explorer)
     * — see src/lib/packing/van-quantity.ts. The client-side FleetCostExplorer reads the
     * equivalent NEXT_PUBLIC_DEFAULT_VAN_QUANTITY (public-env.ts), since it cannot import
     * this server-only loader; keep the two in sync if this default ever changes.
     */
    readonly defaultVanQuantity: number;
    /** Operator-facing van-fill diagnostic thresholds (see van-fill.ts `analyzeVanFill`). */
    readonly fill: {
      /** Most of the floor is covered — beyond this, unused HEIGHT is the only way to grow fill. */
      readonly floorFullFraction: number;
      /** Below this volume fill, a floor-full van is flagged as under-using its height. */
      readonly underfilledVolumeFraction: number;
      /** Payload at/above this fraction ⇒ the van is weight-limited, so low volume is expected. */
      readonly weightLimitedFraction: number;
    };
  };
  readonly routing: {
    readonly provider: string;
    readonly googleMapsApiKey: string;
    readonly timeoutMs: number;
    readonly fragilitySurchargePerItem: number;
    readonly currencySymbol: string;
    /** Distance multiplier billed to the customer. 1.0 = one-way, 2.0 = full round trip (van returns to base). Must be > 0 — 0 would zero out every quote's distance. */
    readonly returnFactor: number;
    /** Driver wage billed per hour. UK-realistic loaded cost (wage + employer NI + holiday). One driver per van. */
    readonly driverHourlyRate: number;
    /** Fixed paid handling time per van — loading at origin + unloading at destination. Not doubled on the return leg. */
    readonly loadUnloadMinutesPerVan: number;
    /**
     * Fee added to a DEDICATED (single-drop / multi-stop) quote routed via a hub (cross-dock /
     * store-and-forward). Two parts: a fixed `baseFee` per cross-dock plus `perWeightBlockFee` for
     * every `weightBlockKg` of load (rounded up). e.g. £5 base + £10 per 500 kg. All business
     * numbers — set them in config, never hardcoded. Set baseFee + perWeightBlockFee to 0 to disable.
     */
    readonly hubHandling: {
      readonly baseFee: number;
      readonly perWeightBlockFee: number;
      /** Weight block size (kg) each perWeightBlockFee covers. Must be > 0. */
      readonly weightBlockKg: number;
    };
    /** Assumed average speed (mph) for the straight-line fallback's duration estimate. */
    readonly fallbackAvgSpeedMph: number;
    /**
     * Timeout for the straight-line fallback's Nominatim (OSM) geocode lookup — see
     * src/lib/routing/nominatim-geocoder.ts. Distinct from `places.nominatimTimeoutMs`
     * (the address-autocomplete endpoint's Nominatim call): same upstream provider, but
     * two different call sites that had already drifted (5000ms here vs 4000ms there)
     * before this was config — kept as two separate knobs rather than force-unified.
     */
    readonly nominatimGeocodeTimeoutMs: number;
    /**
     * Route-lookup memoisation. A quote is often re-priced for the same addresses
     * (van/rate tweaks), and the distance can't have changed — so an identical
     * lookup is served from memory instead of re-billing the map provider. Purely
     * a speed/cost win: the cached Route is the exact one the provider returned.
     */
    readonly cache: {
      readonly enabled: boolean;
      /** Bounded LRU size — oldest address pairs are evicted past this, so a long-lived server can't leak memory. */
      readonly maxEntries: number;
    };
  };
  readonly multiStop: {
    /**
     * The most drops one chain may contain. `1` ships single-drop only (today's behaviour
     * exactly); higher enables multi-stop. This is NOT a job's stop count — the item→stop
     * tags define that. Bounded by Google's Routes API, which accepts at most 25 intermediate
     * waypoints per request, so a delivery chain tops out at 25 drops; the reader enforces
     * that ceiling so an over-set value fails at startup rather than mid-quote.
     */
    readonly maxStops: number;
    /**
     * Paid handling minutes added per stop in a chain (load/unload dwell). Billed as driver time
     * so extra stops cost money even when they sit close together. Distinct from
     * `routing.loadUnloadMinutesPerVan`, which is the per-van origin+destination allowance.
     */
    readonly loadUnloadMinutesPerStop: number;
    /**
     * Opt-in: ask the map provider for the drive-optimal visit order (higher API tier).
     * Off = honour the operator's typed order.
     */
    readonly optimizeWaypointOrder: boolean;
  };
  /**
   * Hub collection runs (LTL pickup around a 3PL hub). The pickup ceiling is multiStop.maxStops —
   * the same Google 25-waypoint limit binds both chain shapes.
   */
  readonly collectionRun: {
    /**
     * Default for "let the router pick the cheapest pickup order". ON by default — finding the
     * route is the point of this screen — but per-request overridable, and the delivery chain's
     * own default is untouched.
     */
    readonly optimizeOrder: boolean;
  };
  /**
   * The quotation-driven decision matrix: thresholds that turn a quotation's signals
   * (delivery-address count, van fill) into a recommended mode. Advisory only — the
   * operator can always override. See src/lib/mode-selection.
   */
  readonly modeSelection: {
    /** Delivery-address count at or above which a job is recommended as multi-stop. */
    readonly minDropsForMultiStop: number;
    /**
     * Van volume-fill fraction (0..1) below which a single-van load is a part-load —
     * the point at which sharing a truck through hubs is recommended over a dedicated
     * van. 0.5 ⇒ suggest sharing once a dedicated van would run less than half full.
     */
    readonly partLoadFillThreshold: number;
  };
  readonly groupage: {
    /** Feature flag for the shared-truck (groupage) quote mode. Off hides the mode entirely. */
    readonly enabled: boolean;
    /** Hub network file (id + name + postcode-area catchment). Editable in-place like vans.json. */
    readonly hubsPath: string;
    /** Rate-card + footprint-unit + per-leg-capacity + surcharge knobs. */
    readonly ratesPath: string;
    /**
     * Risk ceiling on trunk hops between origin and destination hub: 1 = point-to-point only,
     * 2 = allow one sortation hub in the middle. Not a job's leg count — the hub pair defines that.
     */
    readonly maxTrunkHops: number;
    /**
     * Sanity guard against absurd input (e.g. a typo'd "9999"), not a proxy for real vehicle
     * capacity — that's a different unit (raw pallet count here vs. footprint-space + weight
     * in groupage-rates.json's legCapacity). Real van limits are MEASURED by the per-leg capacity
     * check (capacity.ts `checkPath`), which reports how many vehicles a too-big load needs on the
     * quote (`fits`, `vehiclesNeeded`) rather than rejecting it — see `enforceLegCapacity`.
     */
    readonly maxPalletsPerBooking: number;
    /**
     * Routing used for a shared-truck quote when the request doesn't specify one:
     * "via-hub" cross-docks at a hub (needs catchment coverage), "direct" is a hubless move on another carrier.
     */
    readonly defaultRouting: "direct" | "via-hub";
    /**
     * When a pooled group's summed demand exceeds the shared vehicle's dual capacity (spaces OR
     * weight), split its consignments across the fewest trucks that each fit — rather than showing
     * one over-capacity truck. A single consignment too big for one vehicle can't be divided, so it
     * stays on its own FLAGGED truck (fail-loud, never silently dropped). Off ⇒ the old behaviour:
     * one truck, flagged over-capacity.
     */
    readonly autoSplitOverCapacity: boolean;
    /** JSON file holding groupage shipment lifecycle records (Parts 2–4 tracking). */
    readonly shipmentsPath: string;
    /** JSON file remembering each priced groupage quote as a consignment, so the shared-truck
     *  planner can surface "recent quotes" to group instead of re-typing them. */
    readonly consignmentsPath: string;
    /** Cap on remembered consignments; oldest dropped when exceeded (newest-first). */
    readonly consignmentsMaxEntries: number;
    /** Bounded redelivery attempt cap before a booking goes Return-to-Sender (blueprint 4.4). */
    readonly maxDeliveryAttempts: number;
    /** Cap on the raw JSON body /api/groupage and /api/shipments will read, enforced while
     *  streaming (not after full buffering) — the form never sends anywhere near this. */
    readonly maxRequestBodyBytes: number;
  };
  /** Address/postcode autocomplete (GET /api/places). See src/lib/geo/place-autocomplete.ts. */
  readonly places: {
    /** Trust boundary: cap query length before it reaches an upstream geocoder. */
    readonly maxQueryLen: number;
    /** postcodes.io normally answers in ~100 ms; a tight deadline means a stall there doesn't
     *  delay the Nominatim fallthrough (bounding a postcode query's worst case, not just no-hang). */
    readonly postcodesIoTimeoutMs: number;
    /** Nominatim (worldwide free-text) is slower, so it gets the larger share of the budget.
     *  Distinct from `routing.nominatimGeocodeTimeoutMs` — see that field's comment. */
    readonly nominatimTimeoutMs: number;
  };
  readonly storage: {
    /** Archive the source PDF + structured document. Off unless explicitly enabled. */
    readonly enabled: boolean;
    /** Folder for the local (no-cloud) backend, used when R2 creds are absent. */
    readonly dir: string;
    readonly accountId: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly bucket: string;
  };
  readonly quoteHistory: {
    /** JSON file holding successful quote snapshots for the admin history list. */
    readonly path: string;
    /** Maximum number of entries kept; oldest are dropped when the cap is exceeded. */
    readonly maxEntries: number;
  };
  /**
   * Outbound "Send Quote" email. Off/unconfigured is fail-loud, not silent — see
   * src/lib/email/email.factory.ts. Only SMTP is registered today (Gmail App
   * Password); add a provider there before adding a switch here.
   */
  readonly email: {
    readonly fromAddress: string;
    /** Optional display name, e.g. "Cargo Express Quotes" — blank sends as the bare address. */
    readonly fromName: string;
    readonly smtp: {
      readonly host: string;
      readonly port: number;
      /** true = implicit TLS (port 465). false = STARTTLS (port 587, Gmail's default). */
      readonly secure: boolean;
      /** The authenticating mailbox. For Gmail this must equal fromAddress (or a configured alias). */
      readonly user: string;
      /** Gmail App Password (16 chars, requires 2FA) — never a normal account password. */
      readonly pass: string;
    };
    readonly timeoutMs: number;
    /** Blank = no copy. Set to always BCC one address (e.g. the sender's own inbox) on every quote sent, so there's a paper trail without exposing that address to the client. */
    readonly bcc: string;
  };
  readonly security: {
    /** Shared secret for fleet/hub config writes (x-admin-key header). Blank = all admin writes refused. */
    readonly adminApiKey: string;
  };
  readonly observability: {
    readonly logLevel: LogLevel;
    readonly logPretty: boolean;
    readonly perfEnabled: boolean;
    /** Emit the per-van packing diagnostic trace ("why isn't this van fuller?"). Dev/ops only. */
    readonly packingDebug: boolean;
  };
}

function buildConfig(raw: RawEnv): AppConfig {
  return {
    ocr: {
      provider: readString(raw, "OCR_PROVIDER", "auto"),
      apiKey: readString(raw, "MISTRAL_API_KEY", ""),
      model: readString(raw, "MISTRAL_OCR_MODEL", "mistral-ocr-latest"),
      timeoutMs: readInt(raw, "OCR_TIMEOUT_MS", 120_000, { min: 1 }),
      maxRetries: readInt(raw, "OCR_MAX_RETRIES", 2),
      retryBaseDelayMs: readInt(raw, "OCR_RETRY_BASE_DELAY_MS", 500),
      includeImages: readBool(raw, "OCR_INCLUDE_IMAGES", false),
      cache: {
        enabled: readBool(raw, "OCR_CACHE_ENABLED", true),
        dir: readString(raw, "OCR_CACHE_DIR", ".ocr-cache"),
      },
      tesseract: {
        lang: readString(raw, "TESSERACT_LANG", "eng"),
        scale: readInt(raw, "TESSERACT_SCALE", 2),
        minConfidence: readFloat(raw, "TESSERACT_MIN_CONFIDENCE", 40),
        rowGapFactor: readFloat(raw, "TESSERACT_ROW_GAP_FACTOR", 0.6),
        colGapFactor: readFloat(raw, "TESSERACT_COL_GAP_FACTOR", 1.2),
        minColumns: readInt(raw, "TESSERACT_MIN_COLUMNS", 2),
        minTableRows: readInt(raw, "TESSERACT_MIN_TABLE_ROWS", 2),
      },
      textlayer: {
        minYieldChars: readInt(raw, "OCR_TEXTLAYER_MIN_YIELD_CHARS", 200, { min: 0 }),
        fallbackProvider: readString(raw, "OCR_TEXTLAYER_FALLBACK_PROVIDER", "mistral"),
        rowGapFactor: readFloat(raw, "OCR_TEXTLAYER_ROW_GAP_FACTOR", 0.6),
        colGapFactor: readFloat(raw, "OCR_TEXTLAYER_COL_GAP_FACTOR", 1.2),
        minColumns: readInt(raw, "OCR_TEXTLAYER_MIN_COLUMNS", 2),
        minTableRows: readInt(raw, "OCR_TEXTLAYER_MIN_TABLE_ROWS", 2),
      },
    },
    ingest: {
      maxFileBytes: readInt(raw, "INGEST_MAX_FILE_BYTES", 26_214_400),
      allowedMimeTypes: readCsv(raw, "INGEST_ALLOWED_MIME", ["application/pdf"]),
      addressDetectionPath: readString(
        raw,
        "ADDRESS_DETECTION_PATH",
        "config/address-detection.json",
      ),
    },
    addressExtraction: {
      provider: readString(raw, "ADDRESS_EXTRACTOR_PROVIDER", "rule"),
      groq: {
        apiKey: readString(raw, "ADDRESS_GROQ_API_KEY", ""),
        // Required when the groq provider is active — no default, so a missing model
        // fails loud (falls back to rule) instead of silently calling an unintended one.
        model: readString(raw, "ADDRESS_GROQ_MODEL", ""),
        baseUrl: readString(raw, "ADDRESS_GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
        timeoutMs: readInt(raw, "ADDRESS_GROQ_TIMEOUT_MS", 30_000, { min: 1 }),
        maxRetries: readInt(raw, "ADDRESS_GROQ_MAX_RETRIES", 2),
        retryBaseDelayMs: readInt(raw, "ADDRESS_GROQ_RETRY_BASE_DELAY_MS", 500),
        maxInputChars: readInt(raw, "ADDRESS_GROQ_MAX_INPUT_CHARS", 20_000, { min: 1 }),
      },
    },
    consignmentReader: {
      provider: readString(raw, "CONSIGNMENT_READER_PROVIDER", "rule"),
      groq: {
        apiKey: readString(raw, "CONSIGNMENT_GROQ_API_KEY", ""),
        // Required when the groq provider is active — no default, so a missing model
        // returns an empty roster instead of silently calling an unintended one.
        model: readString(raw, "CONSIGNMENT_GROQ_MODEL", ""),
        baseUrl: readString(raw, "CONSIGNMENT_GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
        timeoutMs: readInt(raw, "CONSIGNMENT_GROQ_TIMEOUT_MS", 30_000, { min: 1 }),
        maxRetries: readInt(raw, "CONSIGNMENT_GROQ_MAX_RETRIES", 2),
        retryBaseDelayMs: readInt(raw, "CONSIGNMENT_GROQ_RETRY_BASE_DELAY_MS", 500),
        maxInputChars: readInt(raw, "CONSIGNMENT_GROQ_MAX_INPUT_CHARS", 20_000, { min: 1 }),
      },
    },
    classification: {
      provider: readString(raw, "CLASSIFIER_PROVIDER", "rule"),
      rulesPath: readString(raw, "FRAGILITY_RULES_PATH", "config/fragility-rules.json"),
    },
    durability: {
      provider: readString(raw, "DURABILITY_CLASSIFIER_PROVIDER", "rule"),
      rulesPath: readString(raw, "DURABILITY_RULES_PATH", "config/durability-rules.json"),
      tiersPath: readString(raw, "DURABILITY_TIERS_PATH", "config/durability-tiers.json"),
      groq: {
        apiKey: readString(raw, "GROQ_API_KEY", ""),
        model: readString(raw, "GROQ_MODEL", ""),
        baseUrl: readString(raw, "GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
        timeoutMs: readInt(raw, "GROQ_TIMEOUT_MS", 30_000, { min: 1 }),
        maxRetries: readInt(raw, "GROQ_MAX_RETRIES", 2),
        retryBaseDelayMs: readInt(raw, "GROQ_RETRY_BASE_DELAY_MS", 500),
        // Loop stride in the chunker — 0 would spin forever, so reject it loudly.
        maxItemsPerCall: readInt(raw, "GROQ_MAX_ITEMS_PER_CALL", 60, { min: 1 }),
      },
      sambanova: {
        apiKey: readString(raw, "SAMBANOVA_API_KEY", ""),
        model: readString(raw, "SAMBANOVA_MODEL", "Meta-Llama-3.3-70B-Instruct"),
        baseUrl: readString(raw, "SAMBANOVA_BASE_URL", "https://api.sambanova.ai/v1"),
      },
    },
    packing: {
      stackabilityPath: readString(raw, "PACKING_STACKABILITY_PATH", "config/stackability.json"),
      columnMapPath: readString(raw, "PACKING_COLUMN_MAP_PATH", "config/column-map.json"),
      vansPath: readString(raw, "PACKING_VANS_PATH", "config/vans.json"),
      toleranceM: readFloat(raw, "PACKING_TOLERANCE_M", 0.005),
      maxReachHeightM: readFloat(raw, "PACKING_MAX_REACH_HEIGHT_M", 1.8, { min: 0, exclusiveMin: true }),
      maxVansToConsider: readInt(raw, "PACKING_MAX_VANS", 50, { min: 1 }),
      maxPackableUnits: readInt(raw, "PACKING_MAX_PACKABLE_UNITS", 20000, { min: 1 }),
      consolidationPath: readString(raw, "PACKING_CONSOLIDATION_PATH", "config/consolidation.json"),
      maxPackableBlocks: readInt(raw, "PACKING_MAX_PACKABLE_BLOCKS", 2000, { min: 1 }),
      maxConsolidatedUnits: readInt(raw, "PACKING_MAX_CONSOLIDATED_UNITS", 500_000, { min: 1 }),
      fuelLoadUplift: readFloat(raw, "PACKING_FUEL_LOAD_UPLIFT", 0.15),
      bulkRunMinUnits: readInt(raw, "PACKING_BULK_RUN_MIN_UNITS", 500, { min: 1 }),
      // exclusiveMin: an exactly-0 tie-break epsilon still works logically, but 0 signals
      // a knob nobody actually configured — reject it loudly rather than silently no-op.
      costEpsilon: readFloat(raw, "PACKING_COST_EPSILON", 0.02, { min: 0, exclusiveMin: true }),
      packCap: readInt(raw, "PACKING_PACK_CAP", 150, { min: 1 }),
      searchNodeBudget: readInt(raw, "PACKING_SEARCH_NODE_BUDGET", 1500, { min: 1 }),
      defaultVanQuantity: readInt(raw, "PACKING_DEFAULT_VAN_QUANTITY", 5, { min: 1 }),
      fill: {
        floorFullFraction: readFloat(raw, "PACKING_FILL_FLOOR_FULL_FRACTION", 0.8, {
          min: 0,
          exclusiveMin: true,
          max: 1,
        }),
        underfilledVolumeFraction: readFloat(raw, "PACKING_FILL_UNDERFILLED_FRACTION", 0.65, {
          min: 0,
          exclusiveMin: true,
          max: 1,
        }),
        weightLimitedFraction: readFloat(raw, "PACKING_FILL_WEIGHT_LIMITED_FRACTION", 0.9, {
          min: 0,
          exclusiveMin: true,
          max: 1,
        }),
      },
    },
    routing: {
      provider: readString(raw, "ROUTE_PROVIDER", "google"),
      googleMapsApiKey: readString(raw, "GOOGLE_MAPS_API_KEY", ""),
      timeoutMs: readInt(raw, "MAPS_TIMEOUT_MS", 10_000, { min: 1 }),
      fragilitySurchargePerItem: readFloat(raw, "FRAGILITY_SURCHARGE_PER_ITEM", 5),
      currencySymbol: readString(raw, "CURRENCY_SYMBOL", "£"),
      returnFactor: readFloat(raw, "ROUTE_RETURN_FACTOR", 2, { min: 0, exclusiveMin: true }),
      driverHourlyRate: readFloat(raw, "DRIVER_HOURLY_RATE", 15),
      loadUnloadMinutesPerVan: readFloat(raw, "LOAD_UNLOAD_MINUTES_PER_VAN", 45),
      hubHandling: {
        baseFee: readFloat(raw, "HUB_HANDLING_BASE_FEE", 5, { min: 0 }),
        perWeightBlockFee: readFloat(raw, "HUB_HANDLING_PER_WEIGHT_BLOCK_FEE", 10, { min: 0 }),
        weightBlockKg: readFloat(raw, "HUB_HANDLING_WEIGHT_BLOCK_KG", 500, { min: 0, exclusiveMin: true }),
      },
      // min 1: zero would divide-by-zero the duration estimate.
      fallbackAvgSpeedMph: readFloat(raw, "FALLBACK_AVG_SPEED_MPH", 50, { min: 1 }),
      nominatimGeocodeTimeoutMs: readInt(raw, "ROUTING_NOMINATIM_GEOCODE_TIMEOUT_MS", 5000, { min: 1 }),
      cache: {
        enabled: readBool(raw, "ROUTE_CACHE_ENABLED", true),
        // min 1: a zero-size cache would evict every entry immediately (pointless).
        maxEntries: readInt(raw, "ROUTE_CACHE_MAX_ENTRIES", 256, { min: 1 }),
      },
    },
    multiStop: {
      // Default to Google's per-request waypoint ceiling so multi-stop works out of the box;
      // max 25 because the Routes API rejects more than 25 intermediate waypoints.
      maxStops: readInt(raw, "MULTI_STOP_MAX_STOPS", 25, { min: 1, max: 25 }),
      loadUnloadMinutesPerStop: readFloat(raw, "MULTI_STOP_LOAD_UNLOAD_MINUTES_PER_STOP", 15),
      optimizeWaypointOrder: readBool(raw, "MULTI_STOP_OPTIMIZE_WAYPOINT_ORDER", false),
    },
    collectionRun: {
      optimizeOrder: readBool(raw, "COLLECTION_RUN_OPTIMIZE_ORDER", true),
    },
    modeSelection: {
      minDropsForMultiStop: readInt(raw, "MODE_MIN_DROPS_FOR_MULTISTOP", 2, { min: 1 }),
      // A van-fill FRACTION, so it must sit in (0, 1]: 0 would never flag a part-load,
      // and >1 is nonsense that would recommend sharing for every load — reject it loudly
      // at startup rather than silently mis-recommend. 1.0 = "share unless 100% full".
      partLoadFillThreshold: readFloat(raw, "MODE_PART_LOAD_FILL_THRESHOLD", 0.5, {
        min: 0,
        exclusiveMin: true,
        max: 1,
      }),
    },
    groupage: {
      enabled: readBool(raw, "GROUPAGE_ENABLED", true),
      hubsPath: readString(raw, "GROUPAGE_HUBS_PATH", "config/hubs.json"),
      ratesPath: readString(raw, "GROUPAGE_RATES_PATH", "config/groupage-rates.json"),
      maxTrunkHops: readInt(raw, "GROUPAGE_MAX_TRUNK_HOPS", 2, { min: 1 }),
      maxPalletsPerBooking: readInt(raw, "GROUPAGE_MAX_PALLETS", 52, { min: 1 }),
      defaultRouting: ((): "direct" | "via-hub" => {
        const v = readString(raw, "GROUPAGE_DEFAULT_ROUTING", "via-hub");
        if (v !== "direct" && v !== "via-hub") {
          throw new ConfigError(`Env var GROUPAGE_DEFAULT_ROUTING must be "direct" or "via-hub", got "${v}"`);
        }
        return v;
      })(),
      autoSplitOverCapacity: readBool(raw, "GROUPAGE_AUTO_SPLIT_OVER_CAPACITY", true),
      shipmentsPath: readString(raw, "GROUPAGE_SHIPMENTS_PATH", "data/shipments.json"),
      consignmentsPath: readString(raw, "GROUPAGE_CONSIGNMENTS_PATH", "data/groupage-consignments.json"),
      consignmentsMaxEntries: readInt(raw, "GROUPAGE_CONSIGNMENTS_MAX_ENTRIES", 50, { min: 1 }),
      maxDeliveryAttempts: readInt(raw, "GROUPAGE_MAX_DELIVERY_ATTEMPTS", 3, { min: 1 }),
      // 256 KB is generous for a postcode/pallet-line form; guards against a spoofed or
      // missing Content-Length letting an oversized body be fully buffered before rejection.
      maxRequestBodyBytes: readInt(raw, "GROUPAGE_MAX_REQUEST_BODY_BYTES", 262_144, { min: 1 }),
    },
    places: {
      maxQueryLen: readInt(raw, "PLACES_MAX_QUERY_LEN", 120, { min: 1 }),
      postcodesIoTimeoutMs: readInt(raw, "PLACES_POSTCODES_IO_TIMEOUT_MS", 2500, { min: 1 }),
      nominatimTimeoutMs: readInt(raw, "PLACES_NOMINATIM_TIMEOUT_MS", 4000, { min: 1 }),
    },
    storage: {
      enabled: readBool(raw, "STORAGE_ENABLED", false),
      dir: readString(raw, "STORAGE_DIR", "data/uploads"),
      accountId: readString(raw, "R2_ACCOUNT_ID", ""),
      accessKeyId: readString(raw, "R2_ACCESS_KEY_ID", ""),
      secretAccessKey: readString(raw, "R2_SECRET_ACCESS_KEY", ""),
      bucket: readString(raw, "R2_BUCKET", ""),
    },
    quoteHistory: {
      path: readString(raw, "QUOTE_HISTORY_PATH", "data/quote-history.json"),
      maxEntries: readInt(raw, "QUOTE_HISTORY_MAX_ENTRIES", 20),
    },
    email: {
      fromAddress: readString(raw, "EMAIL_FROM_ADDRESS", ""),
      fromName: readString(raw, "EMAIL_FROM_NAME", ""),
      smtp: {
        host: readString(raw, "EMAIL_SMTP_HOST", "smtp.gmail.com"),
        port: readInt(raw, "EMAIL_SMTP_PORT", 587, { min: 1, max: 65535 }),
        secure: readBool(raw, "EMAIL_SMTP_SECURE", false),
        user: readString(raw, "EMAIL_SMTP_USER", ""),
        // No default — a real send requires an explicit App Password; absence is
        // handled fail-loud by email.factory.ts, not silently defaulted here.
        pass: readString(raw, "EMAIL_SMTP_PASS", ""),
      },
      timeoutMs: readInt(raw, "EMAIL_TIMEOUT_MS", 15_000, { min: 1 }),
      bcc: readString(raw, "EMAIL_BCC", ""),
    },
    security: {
      adminApiKey: readString(raw, "ADMIN_API_KEY", ""),
    },
    observability: {
      logLevel: readLogLevel(raw, "LOG_LEVEL", "info"),
      logPretty: readBool(raw, "LOG_PRETTY", true),
      perfEnabled: readBool(raw, "PERF_ENABLED", true),
      packingDebug: readBool(raw, "PACKING_DEBUG", false),
    },
  };
}

let cached: AppConfig | null = null;

/** Lazily builds and caches config. Throws ConfigError on first invalid/missing var. */
export function getConfig(): AppConfig {
  if (cached === null) cached = buildConfig(process.env);
  return cached;
}

/** Test/CLI hook — build config from an explicit source without touching the cache. */
export function buildConfigFrom(raw: RawEnv): AppConfig {
  return buildConfig(raw);
}
