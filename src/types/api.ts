import type { ModeRules } from "@/lib/mode-selection/mode.types";
import type { ReadSource } from "@/lib/ocr/extractor.types";

export type Fragility = "fragile" | "standard" | "uncertain";

export type DurabilityTier = "none" | "low" | "medium" | "high";
export type OrientationLock = "fixed" | "partial" | "none";

/**
 * A per-row human correction of the auto-derived stacking facts, keyed by the
 * row id (`${pageIndex}-${tableIndex}-${rowIndex}`). Sent from the review table
 * to /api/pack, where it overrides the classifier for that row.
 */
export interface RowDurabilityOverride {
  durabilityTier: DurabilityTier;
  brittle: boolean;
  orientationLock: OrientationLock;
}

/** The effective stacking facts shown per row in the review table (override or packer value). */
export interface RowDurabilityView extends RowDurabilityOverride {
  /** False when the facts were an unconfident auto fallback — drives the "low confidence" flag. */
  confident: boolean;
  /** Effective crush limit (kPa) the packer used. `null`/absent until first pack (or
   *  briefly after an override edit); optional so the review table compiles without
   *  the page-level wiring that populates it. */
  maxStackPressureKpa?: number | null;
  /** Whether this item may itself be stacked on top of others. Optional until first pack. */
  stackable?: boolean;
  /** Soft/crushable items that deform under load — flagged so the operator sees why they don't take a clean stack. */
  deformable?: boolean;
}

export interface ExtractedTable {
  index: number;
  headers: string[];
  rows: string[][];
}

export interface PageContent {
  index: number;
  markdown: string;
  tables: ExtractedTable[];
}

export interface ClassifiedItem {
  pageIndex: number;
  tableIndex: number;
  rowIndex: number;
  label: string;
  fragility: Fragility;
  confident: boolean;
  matchedTerm: string | null;
  reason: string;
}

export interface ClassificationResult {
  provider: string;
  items: ClassifiedItem[];
  counts: { fragile: number; standard: number; lowConfidence: number };
}

export interface PerfSpan {
  name: string;
  durationMs: number;
}

export interface PerfReport {
  totalMs: number;
  spans: PerfSpan[];
}

export interface IngestResponse {
  success: boolean;
  requestId?: string;
  error?: string;
  filename?: string;
  provider?: string;
  document?: {
    pageCount: number;
    tableCount: number;
    pages: PageContent[];
    /** How the PDF was read (exact text layer vs photographed + OCR'd). */
    source?: ReadSource;
    /** Mean read confidence (0–100), or null when the engine reports none. */
    confidence?: number | null;
    /** True when read by photo-OCR — operator should verify digits/addresses. */
    needsReview?: boolean;
  };
  classification?: ClassificationResult;
  perf?: PerfReport;
  /** Addresses detected in the uploaded PDF, if any — used to prefill (never auto-select) the quote form. */
  addresses?: {
    pickup: string | null;
    drops: string[];
    customer?: { name: string | null; phone: string | null };
    /** All delivery-stop addresses read from the sheet — used to aim the outbound trunk at the
     *  hub nearest the destinations. Absent on the line-scan path / single-drop sheets. */
    deliveries?: string[];
    /** All collection-stop addresses read from the sheet (a collection round IS these). */
    pickups?: string[];
  };
  /** Postcode of the destination/outbound hub named on the sheet, or null — the trunk's fallback
   *  target on a milk-round that lists only collection stops. */
  outboundHubPostcode?: string | null;
  /** Which way the sheet runs — "collect" pre-selects collection mode on the client (advisory,
   *  operator can switch back). Absent on responses from before this field existed ⇒ treat as "deliver". */
  direction?: "collect" | "deliver";
  /** Config thresholds the client feeds into the mode decision matrix (see src/lib/mode-selection). */
  modeRules?: ModeRules;
  /**
   * Multi-drop only: row id (`${page}-${table}-${row}`) → 0-based drop index, read
   * from the manifest's Stop/Drop column. Seeds each cargo row's drop tag so they
   * show the real stop 1/2/3 instead of all defaulting to "Drop 1". Absent/empty on
   * single-drop sheets.
   */
  itemStopIndex?: Record<string, number>;
  /**
   * Advisory: this upload looks like a groupage/hub-consolidation manifest (pallets
   * through a hub). Drives a nudge to the shared-truck planner instead of the standard
   * packer, which mis-reads such manifests. `isHubManifest: false` on a normal quote.
   */
  hubManifest?: { isHubManifest: boolean; reasons: string[] };
  /**
   * Hubs the uploaded manifest names for itself (see manifest-hub-reader). Held client-side for
   * this session only and layered over the saved network as `sessionHubs` on quote/pack requests —
   * empty/absent when the sheet names none.
   */
  manifestHubs?: SessionHub[];
}

/**
 * Client-side shape of a hub lifted off an uploaded manifest — see `ManifestHub` in
 * `@/lib/groupage/manifest-hub-reader` for the server-side source of truth. Kept as a local type
 * (rather than importing the server type) so this file has no dependency on lib internals.
 */
export interface SessionHub {
  id: string;
  name: string;
  catchment: string[];
  role?: "collection" | "destination";
  postcode?: string;
  address?: string;
  warning?: string;
}

// ── Stage 3 — Packing ───────────────────────────────────────────────────────

export interface VanDimensions { l: number; w: number; h: number; }
export interface Van { id: string; label: string; interior: VanDimensions; maxPayloadKg: number; fuelCostPerMile?: number; perMileRate: number; /** Grams of CO₂ per mile; undefined ⇒ no carbon figure for this van. */ co2GramsPerMile?: number; /** Units of this type the fleet owns; undefined ⇒ unlimited/unset. Drives Add-van availability. */ quantity?: number; }
export interface Vec3 { x: number; y: number; z: number; }
export interface Placement { itemId: string; position: Vec3; size: Vec3; fragile: boolean; weightKg: number; canSupportWeightKg: number; stackable: boolean; maxStackPressureKpa: number; brittle: boolean; orientationLock?: OrientationLock; rotationIndex?: number;
  /** Set by a MANUAL override: the operator hand-placed this box in a spot the validator
   *  rejected (overlap, unsupported, over-height, crush…). It commits so the operator can
   *  keep arranging, but is drawn in a warning colour and must NEVER feed a price/capacity
   *  number until cleared (moving it to a valid spot clears it automatically). */
  flagged?: boolean; flagReason?: string; }
/** An item (or remaining quantity) the packer could not place; `reasons[id]` explains why. */
export interface UnplacedItem { id: string; name: string; quantity: number; }
export interface PackingResult { van: Van; placements: Placement[]; utilization: number; unplaced: UnplacedItem[]; reasons: Record<string, string>; }
export interface VanRanking { vanId: string; label: string; utilization: number; fits: boolean; placedUnits: number; packableUnits: number; }
/** Full item data sent to the client — superset of what the packer builds internally. */
export interface PackedItem {
  id: string;
  name: string;
  quantity: number;
  fragility: Fragility;
  dimensions: VanDimensions | null;
  weightKg: number;
  stackable: boolean;
  canSupportWeightKg: number;
  maxStackPressureKpa: number;
  orientationLock: OrientationLock;
  material: string | null;
  durabilityTier: DurabilityTier;
  /** False when the durability facts were an unconfident fallback — drives the review "low confidence" flag. */
  durabilityConfident: boolean;
  brittle: boolean;
  deformable: boolean;
  /** Multi-drop only: the 0-based delivery stop this item is bound for. Drives door-first drop-order
   *  banding (see ZonedPacker), so a client-side re-pack MUST carry it or the van loses its drop
   *  order. Absent on a single-drop job. */
  stopIndex?: number;
}

/**
 * A table read from the document that the packer skipped whole — no size
 * (Height/Width) or Pallet columns, so its rows couldn't become cargo. Surfaced in
 * the load plan so a real table never disappears into a bare "0/0 placed".
 */
export interface SkippedTable {
  pageIndex: number;
  tableIndex: number;
  headers: string[];
  rowCount: number;
  reason: string;
}

/**
 * A cargo table the packer read but had to guess a header fact for (assumed size
 * unit, or a size column located by fixed position) — surfaced so the operator can
 * verify the sizes rather than silently trust them.
 */
export interface FlaggedTable {
  pageIndex: number;
  tableIndex: number;
  headers: string[];
  reason: string;
}

export interface PackResponse {
  success: boolean;
  requestId?: string;
  error?: string;
  items?: PackedItem[];
  /** Tables read but skipped whole (missing size/pallet columns) — drives the load-plan warning. */
  skippedTables?: SkippedTable[];
  /** Cargo tables read but with a guessed unit / fixed-position size column — drives the "verify sizes" flag. */
  flaggedTables?: FlaggedTable[];
  packableUnits?: number;
  /** Chosen fleet, in load order — one entry per van used. */
  fleet?: PackingResult[];
  selected?: PackingResult;
  ranking?: VanRanking[];
  fitsInSingleVan?: boolean;
  /** Cargo no van can carry (oversized / missing dimensions). */
  unplaced?: UnplacedItem[];
  reasons?: Record<string, string>;
  /** Σ perMileRate across the fleet. */
  totalPerMileRate?: number;
  /** Clearance slack (m) the packer validated with — the interactive editor reuses it. */
  toleranceM?: number;
  /** Max reach height (m) the packer validated with — the interactive editor reuses it.
   *  null ⇒ the operator turned the reach limit off for this pack. */
  maxReachHeightM?: number | null;
  /** Consolidated-block id → display label, for viewer name resolution only (see packer.service.ts). */
  blockLabels?: { id: string; name: string; unitsPerBlock: number }[];
  perf?: PerfReport;
}

// ── Stage 5 — Quote ──────────────────────────────────────────────────────────

export interface Leg { from: string; to: string; distanceMiles: number; durationSeconds: number; distanceMethod: "road" | "straight-line"; }
/** `legs` is optional: quotes persisted before multi-stop shipped have none, so readers must tolerate its absence. readonly to accept the internal Route's readonly legs. */
export interface Route { origin: string; destination: string; distanceMiles: number; durationSeconds: number; distanceMethod: "road" | "straight-line"; legs?: readonly Leg[]; }
export interface QuoteLineItem { label: string; amount: number; }
/** One vehicle in a quote — described by capability + id, never by brand alone. */
export interface QuoteVan { id: string; label: string; description: string; perMileRate: number; distanceCost: number; co2Kg: number; }
/** co2TotalKg is absent (not 0) when no van in the fleet has a co2GramsPerMile figure configured. */
export interface Quote { route: Route; vans: QuoteVan[]; lineItems: QuoteLineItem[]; subtotal: number; surcharges: number; total: number; co2TotalKg?: number; }

export interface QuoteResponse {
  success: boolean;
  requestId?: string;
  error?: string;
  quote?: Quote;
  /** Non-fatal notices shown loudly on the quote (e.g. a straight-line distance fallback under-prices). */
  warnings?: string[];
  /** Multi-stop only: the visited drop sequence as 0-based indices into the submitted drop
   *  list. Identity unless the router re-ordered the stops (opt-in "best order"). */
  visitOrder?: number[];
  perf?: PerfReport;
}

// ── Hub collection run (LTL pickup loop around a 3PL hub) ───────────────────

/** A pickup to collect: an address, optionally tagged with the company it serves (e.g. carried
 *  from a groupage origin). A bare string is accepted as shorthand for `{ address }`. */
export interface CollectionPickupRequest {
  address: string;
  company?: string;
}

export interface CollectionRunQuoteRequest {
  hubId: string;
  /** Pickups in the operator's typed order; the router may re-order them. */
  pickups: (string | CollectionPickupRequest)[];
  vanId: string;
  /** Overrides the config default (collectionRun.optimizeOrder, ships true) when supplied. */
  optimize?: boolean;
}

/** One pickup in VISIT order with its advisory catchment verdict (flagged, never blocked). */
export interface CollectionRunStop {
  address: string;
  /** Company/customer this pickup serves (e.g. from a groupage origin), or null when unlabelled. */
  company: string | null;
  /** Postcode-area prefix ("CV"), or null when the address has no readable UK postcode. */
  postcodeArea: string | null;
  /** True when the area belongs to the chosen hub's catchment. */
  inCatchment: boolean;
  /** The hub that DOES cover the area (may differ from the chosen hub); null on a gap/unreadable. */
  owningHubId: string | null;
}

export interface CollectionRunQuoteResponse {
  success: boolean;
  error?: string;
  hub?: { id: string; name: string; address: string };
  /** Pickups in driving order (post-optimization). */
  orderedStops?: CollectionRunStop[];
  quote?: Quote;
  warnings?: string[];
  perf?: PerfReport;
}

/** One pickup-address candidate extracted from an uploaded PDF — operator confirms before use. */
export interface PickupCandidate {
  address: string;
  /** Postcode found in the source line, normalised — null when the extractor worked without one. */
  postcode: string | null;
  /** False when the extraction is a best-effort guess the operator must check before using. */
  confident: boolean;
}

export interface CollectionIngestResponse {
  success: boolean;
  error?: string;
  candidates?: PickupCandidate[];
}
