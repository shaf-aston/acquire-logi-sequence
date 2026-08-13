"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DropZone } from "@/components/upload/DropZone";
import { PerfPanel } from "@/components/results/PerfPanel";
import { ClassificationSummary } from "@/components/results/ClassificationSummary";
import { ResultTables, type DurabilityStatusInfo } from "@/components/results/ResultTables";
import { PackingResultPanel } from "@/components/results/PackingResultPanel";
import { QuotePanel } from "@/components/results/QuotePanel";
import { AppHeader } from "@/components/layout/AppHeader";
import { VanConfigPanel } from "@/components/admin/VanConfigPanel";
import { HubConfigPanel } from "@/components/admin/HubConfigPanel";
import { CollectionRunPanel } from "@/components/collection-run/CollectionRunPanel";
import { PerStopPallets } from "@/components/collection-run/PerStopPallets";
import { GroupagePanel, type GroupageHandoff } from "@/components/groupage/GroupagePanel";
import { ViaHubPicker } from "@/components/quote/ViaHubPicker";
import { ShipmentsBoard } from "@/components/groupage/ShipmentsBoard";
import { FleetCostExplorer } from "@/components/admin/FleetCostExplorer";
import { CollapsibleCard } from "@/components/layout/CollapsibleCard";
import { SortableStack } from "@/components/layout/SortableStack";
import { VanSessionProvider, useVanSession } from "@/lib/hooks/use-van-session";
import { QuotationHistory } from "@/components/results/QuotationHistory";
import { CustomerProfileCard } from "@/components/results/CustomerProfileCard";
import type { QuoteHistoryEntry } from "@/lib/storage/quote-history.store";
import { PlacesInput } from "@/components/PlacesInput";
import { extractPostcode } from "@/lib/geo/postcode";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { color, font, spacing, radius, buttonPrimary, buttonSecondary, card } from "@/styles/tokens";
import { selectMode, routeManifest, type ModeRecommendation } from "@/lib/mode-selection";
import { rowId } from "@/lib/packing/row-id";
import { clearPanelSnapshot, clearPanelSnapshots, PANEL_SNAPSHOT_KEYS, writePanelSnapshot } from "@/lib/session-cache/panel-snapshots";
import type { ClassifiedItem, Fragility, IngestResponse, PackResponse, PageContent, QuoteResponse, RowDurabilityOverride, RowDurabilityView } from "@/types/api";

function itemKey(p: number, t: number, r: number) {
  return `${p}-${t}-${r}`;
}

function applyOverrides(items: ClassifiedItem[], overrides: Map<string, Fragility>): ClassifiedItem[] {
  return items.map((it) => {
    const key = itemKey(it.pageIndex, it.tableIndex, it.rowIndex);
    const val = overrides.get(key);
    if (val == null) return it;
    return { ...it, fragility: val, confident: val !== "uncertain", matchedTerm: null, reason: val === "uncertain" ? "manual — uncertain" : "manual override" };
  });
}

function buildClassMap(items: ClassifiedItem[], overrides: Map<string, Fragility>): Map<string, ClassifiedItem> {
  const m = new Map<string, ClassifiedItem>();
  for (const it of applyOverrides(items, overrides)) {
    m.set(itemKey(it.pageIndex, it.tableIndex, it.rowIndex), it);
  }
  return m;
}

function buildClassification(
  base: NonNullable<IngestResponse["classification"]>,
  items: ClassifiedItem[],
  overrides: Map<string, Fragility>,
) {
  const built = applyOverrides(items, overrides);
  return {
    ...base,
    items: built,
    counts: {
      fragile: built.filter((i) => i.fragility === "fragile").length,
      standard: built.filter((i) => i.fragility !== "fragile").length,
      lowConfidence: built.filter((i) => !i.confident).length,
    },
  };
}

/** Deep-copy a page so draft edits never mutate committed state. */
function clonePage(page: PageContent): PageContent {
  return {
    ...page,
    tables: page.tables.map((t) => ({ ...t, rows: t.rows.map((r) => [...r]) })),
  };
}

type Status = "idle" | "processing" | "done" | "error";

/** The operator-tunable pricing knobs, fetched from /api/config/pricing (config defaults). */
interface PricingDefaults {
  currencySymbol: string;
  driverHourlyRate: number;
  loadUnloadMinutesPerVan: number;
  returnFactor: number;
  fragilitySurchargePerItem: number;
}
type RateField = "driverHourlyRate" | "loadUnloadMinutesPerVan" | "returnFactor" | "fragilitySurchargePerItem";

/** Quote-settings field metadata. Values are NEVER hardcoded here — only labels/units live in
 *  code; the actual default number comes from the fetched config. `multiOnly:false` fields that
 *  don't apply to multi-stop (returnFactor — a chain drives home once) are flagged so the UI can note it. */
const RATE_FIELDS: { key: RateField; label: string; unit: "currency-hr" | "minutes" | "factor" | "currency"; hint: string; singleDropOnly?: boolean }[] = [
  { key: "driverHourlyRate", label: "Driver rate", unit: "currency-hr", hint: "Paid per driver-hour (drive time + handling)." },
  { key: "loadUnloadMinutesPerVan", label: "Load/unload time", unit: "minutes", hint: "Paid handling allowance per van." },
  { key: "returnFactor", label: "Return-trip factor", unit: "factor", hint: "Bills the drive home. 2 = full round trip. Single-drop only.", singleDropOnly: true },
  { key: "fragilitySurchargePerItem", label: "Fragility surcharge", unit: "currency", hint: "Added per fragile item." },
];

function HomeContent() {
  const { vans: sessionVans } = useVanSession();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IngestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientMs, setClientMs] = useState<number | null>(null);
  const [pages, setPages] = useState<PageContent[]>([]);
  const [manualOverrides, setManualOverrides] = useState<Map<string, Fragility>>(new Map());
  // Per-row human corrections of the auto-derived stacking facts (keyed by itemKey).
  const [durabilityOverrides, setDurabilityOverrides] = useState<Map<string, RowDurabilityOverride>>(new Map());
  const [extraItems, setExtraItems] = useState<ClassifiedItem[]>([]);

  // Staged edit mode — drafts are committed only on Save.
  const [editing, setEditing] = useState(false);
  const [draftPages, setDraftPages] = useState<PageContent[]>([]);
  const [draftOverrides, setDraftOverrides] = useState<Map<string, Fragility>>(new Map());
  const [draftDurabilityOverrides, setDraftDurabilityOverrides] = useState<Map<string, RowDurabilityOverride>>(new Map());
  const [draftExtraItems, setDraftExtraItems] = useState<ClassifiedItem[]>([]);

  // Stage 3 — packing
  const [packResult, setPackResult] = useState<PackResponse | null>(null);
  const [packing, setPacking] = useState(false);
  const [packError, setPackError] = useState<string | null>(null);
  // Quick operator toggle: off ⇒ pack with no reach-height cap (allows stacking
  // above what a worker could reach by hand without a ladder/lift). Default OFF —
  // it's an edge-case constraint (no ladder/lift on site), not the main path, so
  // the packer uses the van's full height unless the operator opts the cap back in.
  const [respectReachLimit, setRespectReachLimit] = useState(false);

  // Stage 5 — quote
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  // True only once the value was picked from the suggestion list — free-typed text stays false.
  const [originSelected, setOriginSelected] = useState(false);
  const [destinationSelected, setDestinationSelected] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [quoteResult, setQuoteResult] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  // Non-fatal notices returned with a quote (e.g. straight-line distance fallback).
  const [quoteWarnings, setQuoteWarnings] = useState<string[]>([]);
  // Quote-settings panel: config defaults (fetched once) + the operator's session overrides.
  // Overrides are kept as raw strings (empty ⇒ "use the default") and validated server-side.
  const [pricingDefaults, setPricingDefaults] = useState<PricingDefaults | null>(null);
  const [rateInputs, setRateInputs] = useState<Record<RateField, string>>({
    driverHourlyRate: "",
    loadUnloadMinutesPerVan: "",
    returnFactor: "",
    fragilitySurchargePerItem: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Stage 5b — quote type. Single-drop stays the default; "multi" swaps in an ordered
  // drop list + per-item stop tagging (pickup reuses the `origin` field); "groupage"
  // swaps the whole address form for the shared-truck panel (postcodes + pallets).
  // One state drives the pill toggle, the standalone shared-truck card, and the
  // recommendation banner hand-off — no separate view switch to fall out of sync.
  const [quoteMode, setQuoteMode] = useState<"single" | "multi" | "groupage" | "collection">("single");
  // Optional hub to cross-dock a dedicated (single/multi) run through — its address, or null for
  // a direct door-to-door quote. Set by the ViaHubPicker; sent to /api/quote as `viaHub`.
  const [viaHubAddress, setViaHubAddress] = useState<string | null>(null);
  // Postcodes carried from detected/typed planner addresses into the groupage form.
  const [groupagePrefill, setGroupagePrefill] = useState<
    { originPostcode?: string; destinationPostcode?: string; fromCollectionHub?: boolean } | undefined
  >(undefined);
  // What the shared-truck hand-off had to drop from a multi-drop / multi-van quotation —
  // drives a heads-up banner in the panel (null = nothing dropped, so no warning).
  const [groupageHandoff, setGroupageHandoff] = useState<GroupageHandoff | null>(null);
  // Sidebar ops/admin cards. Hubs is controlled so a failed groupage quote can pop it open.
  const [hubsOpen, setHubsOpen] = useState(false);
  const hubsCardRef = useRef<HTMLDivElement>(null);
  // Optional seed for the Hubs form — set when a catchment-gap error offers "Create a hub covering X",
  // so the operator lands on a ready-to-save Add-hub form instead of an empty one.
  const [hubPrefill, setHubPrefill] = useState<{ catchment?: string[]; address?: string } | undefined>();
  // Open the Depots & hubs card and scroll it into view — it lives far above the
  // groupage form, so opening alone looks like nothing happened.
  const openHubs = (prefill?: { catchment?: string[]; address?: string }) => {
    setHubPrefill(prefill);
    setHubsOpen(true);
    requestAnimationFrame(() =>
      hubsCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };
  const [shipmentsCount, setShipmentsCount] = useState<number | null>(null);
  // Bumped after each booking so an open Shipments card reloads immediately.
  const [shipmentsRefresh, setShipmentsRefresh] = useState(0);
  const [drops, setDrops] = useState<{ value: string; selected: boolean }[]>([{ value: "", selected: false }]);
  // item key (`${page}-${table}-${row}`) → 0-based drop index. Untagged items default to Drop 1.
  const [stopByItemId, setStopByItemId] = useState<Map<string, number>>(new Map());
  // Opt-in: let the router pick the cheapest visiting order instead of the typed order.
  const [optimizeOrder, setOptimizeOrder] = useState(false);
  // Optional pinned final destination for a multi-stop run. "last" (default) = the run ends at the
  // last drop; "drop" = end at a specific existing drop; "custom" = end at a typed depot/address.
  // The multi-stop run never returns to the pickup — it ends at whatever this resolves to.
  const [finalDest, setFinalDest] = useState<
    | { kind: "last" }
    | { kind: "drop"; index: number }
    | { kind: "custom"; value: string; selected: boolean }
  >({ kind: "last" });
  // The order the router actually visited the drops in (0-based drop indices), from the last
  // multi-stop quote. Only surfaced when it differs from the typed order.
  const [visitOrder, setVisitOrder] = useState<number[] | null>(null);
  // Provenance notice for addresses auto-detected in the ingested PDF — dismissible, never blocks quoting.
  const [addressNotice, setAddressNotice] = useState<string | null>(null);
  // The full detected addresses, surfaced wrapped in the notice so a long value clipped
  // by the single-line field is still fully readable before the operator confirms it.
  const [detectedAddresses, setDetectedAddresses] = useState<{
    pickup: string | null;
    drops: string[];
    /** Delivery-stop addresses read from the sheet — aims the outbound trunk at the nearest hub. */
    deliveries?: string[];
    /** Destination/outbound hub postcode named on the sheet — the trunk fallback for a milk-round. */
    outboundHubPostcode?: string | null;
  } | null>(null);
  // Customer/account detected on the ingested PDF, if any — feeds the CRM card + duplicate detection.
  const [customerProfile, setCustomerProfile] = useState<{ name: string | null; phone: string | null } | null>(null);
  // Source PDF filename, carried through ingest → quote so history can key on it.
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  // Dismissible notice when this same file (or same customer+pickup) was quoted before.
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  // Load the pricing defaults once so the Quote-settings panel can show each field's current
  // value as a placeholder. Non-blocking: a failure just leaves the panel with plain placeholders.
  useEffect(() => {
    let live = true;
    void fetch("/api/config/pricing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: PricingDefaults | null) => {
        if (live && d && typeof d.driverHourlyRate === "number") setPricingDefaults(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Collect the operator's non-empty overrides into the request shape. Empty ⇒ omitted ⇒ the
  // server uses the config default. Numeric validation is enforced server-side (fail-loud 400).
  const buildRateOverrides = (): Record<string, number> | undefined => {
    const out: Record<string, number> = {};
    for (const { key } of RATE_FIELDS) {
      const raw = rateInputs[key];
      if (raw != null && raw.trim() !== "") {
        const n = Number(raw);
        if (Number.isFinite(n)) out[key] = n;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const overridesActive = RATE_FIELDS.some(({ key }) => rateInputs[key].trim() !== "");

  const serverItems = useMemo(() => result?.classification?.items ?? [], [result]);

  // What the table renders — draft sources while editing, committed otherwise.
  const viewPages = editing ? draftPages : pages.length ? pages : result?.document?.pages ?? [];
  const viewExtraItems = editing ? draftExtraItems : extraItems;
  const viewOverrides = editing ? draftOverrides : manualOverrides;
  const viewDurabilityOverrides = editing ? draftDurabilityOverrides : durabilityOverrides;

  const classMap = useMemo(
    () => buildClassMap([...serverItems, ...viewExtraItems], viewOverrides),
    [serverItems, viewExtraItems, viewOverrides],
  );

  // Effective stacking facts per row: the packer's computed value (post-pack),
  // overlaid with any human correction for immediate feedback. Overridden rows
  // are shown as confident (a human reviewed them). Empty until the first pack
  // returns — the table shows a "…" placeholder in that window.
  const durabilityView = useMemo(() => {
    const m = new Map<string, RowDurabilityView>();
    for (const it of packResult?.items ?? []) {
      m.set(it.id, {
        durabilityTier: it.durabilityTier,
        brittle: it.brittle,
        orientationLock: it.orientationLock,
        confident: it.durabilityConfident,
        maxStackPressureKpa: it.maxStackPressureKpa,
        stackable: it.stackable,
        deformable: it.deformable,
      });
    }
    for (const [key, ov] of viewDurabilityOverrides) {
      const prev = m.get(key);
      m.set(key, {
        durabilityTier: ov.durabilityTier,
        brittle: ov.brittle,
        orientationLock: ov.orientationLock,
        confident: true,
        maxStackPressureKpa: prev?.maxStackPressureKpa ?? null,
        stackable: prev?.stackable,
        deformable: prev?.deformable,
      });
    }
    return m;
  }, [packResult, viewDurabilityOverrides]);

  // Why the stacking columns may be empty, so the table shows a labeled reason per row
  // instead of a single silent "…". A hub/groupage manifest deliberately skips the
  // per-item packer (see runPack call site), so its rows would otherwise sit on "…"
  // forever with no explanation — the never-guess surface for a whole quote mode.
  const durabilityStatus: DurabilityStatusInfo = packResult
    ? { kind: "ready" }
    : packing
    ? { kind: "packing" }
    : packError
    ? { kind: "error", detail: packError }
    : result?.hubManifest?.isHubManifest
    ? { kind: "skipped" }
    : { kind: "pending" };

  // Committed classification — feeds packing on Save and the item count.
  const classification = useMemo(
    () =>
      result?.classification
        ? buildClassification(result.classification, [...serverItems, ...extraItems], manualOverrides)
        : null,
    [result, serverItems, extraItems, manualOverrides],
  );

  // The quotation-driven mode recommendation (the "decision matrix"). Pure function
  // over two signals that only meet here on the client: the PDF's delivery-address
  // count and the load plan's van fill. Recomputes when either changes; null until a
  // PDF is read (modeRules absent). Advisory only — the operator can still override.
  const modeRecommendation = useMemo<ModeRecommendation | null>(() => {
    const rules = result?.modeRules;
    if (!rules) return null;
    // Every detected address is a candidate pickup when collecting (a collection PDF is a
    // delivery PDF read the other way round — pickup + drops all become pickups).
    const addrs = result?.addresses;
    const pickupCount = addrs
      ? [addrs.pickup, ...addrs.drops].filter((x) => !!x && x.trim() !== "").length
      : 0;
    return selectMode(
      {
        direction: quoteMode === "collection" ? "collect" : "deliver",
        dropCount: result?.addresses?.drops.length ?? 0,
        pickupCount,
        fitsInSingleVan: packResult?.fitsInSingleVan ?? false,
        vanFillFraction: packResult?.selected?.utilization ?? null,
        packableUnits: packResult?.packableUnits ?? 0,
        unplacedCount: packResult?.unplaced?.length ?? 0,
      },
      rules,
    );
  }, [result?.modeRules, result?.addresses, packResult, quoteMode]);

  // The actual quoted load: total packed box volume (m³) + total weight (kg) across
  // every van the packer chose. Feeds the Cost Planner's feasibility check — a simple
  // necessary condition (a vehicle must have at least this much room and payload),
  // not a real 3D pack. Null until a load plan exists.
  const quotedLoad = useMemo<{ volumeM3: number; weightKg: number } | null>(() => {
    const fleet = packResult?.fleet?.length
      ? packResult.fleet
      : packResult?.selected
      ? [packResult.selected]
      : [];
    if (fleet.length === 0) return null;
    let volumeM3 = 0;
    let weightKg = 0;
    for (const r of fleet) {
      for (const p of r.placements) {
        volumeM3 += p.size.x * p.size.y * p.size.z;
        weightKg += p.weightKg;
      }
    }
    return { volumeM3, weightKg };
  }, [packResult]);

  // The 3D pallet builder caps its stack height by the vehicle carrying the load — the
  // SHORTEST interior height across the used fleet (a stack that clears the lowest van clears
  // them all). Undefined until a load plan exists ⇒ the builder falls back to pallet height.
  const palletMaxHeightM = useMemo<number | undefined>(() => {
    const fleet = packResult?.fleet?.length
      ? packResult.fleet
      : packResult?.selected
      ? [packResult.selected]
      : [];
    if (fleet.length === 0) return undefined;
    return Math.min(...fleet.map((r) => r.van.interior.h));
  }, [packResult]);

  // Per-pickup 3D pallet cards for the collection view — regroups the already-packed fleet by
  // manifest stop (needs the load plan + the Stop-column attribution). Null when there's no packed
  // load or no stop tags, so the collection panel simply shows nothing extra.
  const collectionPalletsSlot = useMemo(() => {
    const fleet = packResult?.fleet?.length
      ? packResult.fleet
      : packResult?.selected
      ? [packResult.selected]
      : [];
    if (fleet.length === 0 || stopByItemId.size === 0) return null;
    const nameById = new Map(
      serverItems.map((it) => [rowId(it.pageIndex, it.tableIndex, it.rowIndex), it.label] as const),
    );
    // Pickup address per 0-based stop, in the same [pickup, ...drops] order the collection panel
    // uses — labels each card with its supplier so the stacks read as individual companies.
    const stopLabels = detectedAddresses
      ? [detectedAddresses.pickup, ...detectedAddresses.drops].filter((x): x is string => !!x && x.trim() !== "")
      : [];
    return (
      <PerStopPallets
        fleet={fleet.map((r) => ({ placements: r.placements, interior: r.van.interior }))}
        stopByItemId={stopByItemId}
        nameById={nameById}
        stopLabels={stopLabels}
        toleranceM={packResult?.toleranceM}
        maxReachHeightM={packResult?.maxReachHeightM ?? undefined}
      />
    );
  }, [packResult, stopByItemId, serverItems, detectedAddresses]);

  const status: Status = loading || packing
    ? "processing"
    : error
    ? "error"
    : result
    ? "done"
    : "idle";

  const runIngest = async (f: File) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setClientMs(null);
    setPackResult(null);
    setPackError(null);
    setQuoteResult(null);
    setQuoteError(null);
    setAddressNotice(null);
    setCustomerProfile(null);
    setSourceFilename(null);
    setDuplicateNotice(null);
    const startedAt = performance.now();
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      const data: IngestResponse = await res.json();
      setClientMs(Math.round((performance.now() - startedAt) * 100) / 100);
      if (data.success) {
        setResult(data);
        setPages(data.document?.pages ?? []);
        setManualOverrides(new Map());
        setDurabilityOverrides(new Map());
        setExtraItems([]);
        setEditing(false);
        // Threshold is server config (env.ts modeSelection) — never a client constant.
        // If it's somehow absent, we skip the multi-stop auto-switch rather than invent one.
        applyDetectedAddresses(
          data.addresses,
          data.modeRules?.minDropsForMultiStop,
          data.itemStopIndex,
          data.direction,
          data.outboundHubPostcode,
          data.hubManifest?.isHubManifest ?? false,
        );
        // Hubs the manifest names for itself — held for this session and layered over the saved
        // network on every quote/pack request (see GroupagePanel's session-hub banner).
        if (data.manifestHubs?.length) {
          writePanelSnapshot(PANEL_SNAPSHOT_KEYS.manifestHubs, data.manifestHubs);
        }
        const customer = data.addresses?.customer ?? null;
        setCustomerProfile(customer);
        setSourceFilename(data.filename ?? null);
        void checkDuplicate(data.filename ?? null, customer, data.addresses?.pickup ?? null);
        // A groupage/hub-consolidation manifest states its load in pallets through a hub;
        // the standard packer reads its per-piece cargo summary and either mis-counts it into
        // a wrong load plan or trips the block cap (see hubManifest detector). Skip the auto
        // load-plan for it — the 🚚 nudge steers the operator to the shared-truck planner, which
        // reads the real pallet roster. The operator can still switch to a mode that packs.
        if (!data.hubManifest?.isHubManifest) {
          void runPack(data, new Map());
        }
      } else {
        setError(data.error ?? "Ingestion failed.");
      }
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  // Fail-soft duplicate check against past history: exact filename match is the primary,
  // authoritative signal; same customer name + same pickup is a softer secondary hint.
  // Never blocks ingestion — a failed /api/history fetch just leaves the notice unset.
  const checkDuplicate = async (
    filename: string | null,
    customer: { name: string | null; phone: string | null } | null,
    pickup: string | null,
  ) => {
    try {
      const res = await fetch("/api/history");
      if (!res.ok) return;
      const data: { entries: QuoteHistoryEntry[] } = await res.json();
      const entries = data.entries ?? [];

      if (filename && filename.trim() !== "") {
        const match = entries.find(
          (e) => (e.filename ?? "").toLowerCase() === filename.toLowerCase(),
        );
        if (match) {
          setDuplicateNotice(
            `You quoted this same file ("${filename}") before on ${new Date(match.createdAt).toLocaleDateString()} — £${match.quote.total.toFixed(2)}.`,
          );
          return;
        }
      }

      if (customer?.name && pickup) {
        const match = entries.find(
          (e) =>
            e.customer?.name &&
            e.customer.name.toLowerCase() === customer.name!.toLowerCase() &&
            e.quote.route.origin.toLowerCase() === pickup.toLowerCase(),
        );
        if (match) {
          setDuplicateNotice(`Same customer & pickup as a previous quote for ${customer.name}.`);
          return;
        }
      }
    } catch {
      // Duplicate detection is a convenience surface, not a trust boundary — silently skip.
    }
  };

  const runPack = async (
    ingest: IngestResponse,
    overrides: ReadonlyMap<string, RowDurabilityOverride> = new Map(),
    // Defaults to the current toggle state — callers only pass this explicitly
    // when they need the FRESH value (see toggleReachLimit; setRespectReachLimit
    // is async, so its own next re-pack can't rely on the state closure yet).
    reachLimit: boolean = respectReachLimit,
  ) => {
    if (!ingest.document || !ingest.classification) return;
    setPacking(true);
    setPackResult(null);
    setPackError(null);
    try {
      const res = await fetch("/api/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: ingest.document,
          classification: ingest.classification,
          // Only send corrections when present — an empty object keeps the wire clean.
          ...(overrides.size > 0 ? { durabilityOverrides: Object.fromEntries(overrides) } : {}),
          // Fleet-setup panel is the live source of truth once loaded, so an admin
          // edit (add/remove/resize a van) is reflected on the next pack instead of
          // silently packing against the persisted config file.
          ...(sessionVans.length > 0 ? { vans: sessionVans } : {}),
          // Only sent when OFF — the server default already respects the limit.
          ...(reachLimit === false ? { respectReachLimit: false } : {}),
        }),
      });
      const data: PackResponse = await res.json();
      if (data.success) setPackResult(data);
      else setPackError(data.error ?? "Could not calculate a load plan.");
    } catch {
      setPackError("Network error — could not reach the server to calculate a load plan.");
    } finally {
      setPacking(false);
    }
  };

  const rerunPack = async (
    nextPages: PageContent[],
    nextClassification: NonNullable<typeof classification>,
    overrides: ReadonlyMap<string, RowDurabilityOverride>,
    // Explicit override for callers that must bypass the (possibly stale, since
    // setState is async) `respectReachLimit` closure — see toggleReachLimit.
    reachLimit: boolean = respectReachLimit,
  ) => {
    if (!result?.document) return;
    await runPack(
      {
        ...result,
        document: { ...result.document, pages: nextPages },
        classification: nextClassification,
      },
      overrides,
      reachLimit,
    );
  };

  // Flip the reach-limit toggle and immediately re-pack against the last SAVED
  // state (same "edits only take effect once committed" rule as everywhere else
  // in this page) — passes the flipped value explicitly since setState is async.
  const toggleReachLimit = () => {
    const next = !respectReachLimit;
    setRespectReachLimit(next);
    if (!result?.classification) return;
    const merged = buildClassification(
      result.classification,
      [...(result.classification.items ?? []), ...extraItems],
      manualOverrides,
    );
    void rerunPack(pages.length ? pages : result.document?.pages ?? [], merged, durabilityOverrides, next);
  };

  // ── Staged editing — all mutations target draft state; nothing re-packs until Save ──
  const enterEdit = () => {
    setDraftPages((pages.length ? pages : result?.document?.pages ?? []).map(clonePage));
    setDraftOverrides(new Map(manualOverrides));
    setDraftDurabilityOverrides(new Map(durabilityOverrides));
    setDraftExtraItems(extraItems.map((it) => ({ ...it })));
    setEditing(true);
  };

  const cancelEdit = () => setEditing(false);

  const saveEdit = () => {
    setPages(draftPages);
    setManualOverrides(draftOverrides);
    setDurabilityOverrides(draftDurabilityOverrides);
    setExtraItems(draftExtraItems);
    setEditing(false);
    if (result?.classification) {
      const merged = buildClassification(
        result.classification,
        [...(result.classification.items ?? []), ...draftExtraItems],
        draftOverrides,
      );
      void rerunPack(draftPages, merged, draftDurabilityOverrides);
    }
  };

  const updateCell = (pageIndex: number, tableIndex: number, rowIndex: number, colIndex: number, value: string) => {
    setDraftPages((prev) =>
      prev.map((page) =>
        page.index !== pageIndex
          ? page
          : {
              ...page,
              tables: page.tables.map((table) =>
                table.index !== tableIndex
                  ? table
                  : {
                      ...table,
                      rows: table.rows.map((row, r) =>
                        r !== rowIndex ? row : row.map((cell, c) => (c === colIndex ? value : cell)),
                      ),
                    },
              ),
            },
      ),
    );
  };

  const setFragility = (pageIndex: number, tableIndex: number, rowIndex: number, value: Fragility) => {
    const key = itemKey(pageIndex, tableIndex, rowIndex);
    const autoFragility: Fragility = serverItems.find(
      (it) => it.pageIndex === pageIndex && it.tableIndex === tableIndex && it.rowIndex === rowIndex,
    )?.fragility ?? "standard";
    const update = (prev: Map<string, Fragility>): Map<string, Fragility> => {
      const next = new Map(prev);
      if (value === autoFragility) next.delete(key);
      else next.set(key, value);
      return next;
    };
    if (editing) {
      setDraftOverrides(update);
    } else {
      const nextOverrides = update(manualOverrides);
      setManualOverrides(nextOverrides);
      if (result?.classification) {
        const merged = buildClassification(result.classification, [...serverItems, ...extraItems], nextOverrides);
        // Preserve any committed durability corrections across a fragility edit.
        void rerunPack(pages.length ? pages : result.document?.pages ?? [], merged, durabilityOverrides);
      }
    }
  };

  // Correct an auto-derived stacking fact for one row. `patch` carries just the
  // changed field; it is merged onto the row's current effective facts and stored
  // as a full per-row override (mirrors setFragility; re-packs immediately outside
  // edit mode, drafts inside it).
  const setDurability = (
    pageIndex: number,
    tableIndex: number,
    rowIndex: number,
    patch: Partial<RowDurabilityOverride>,
  ) => {
    const key = itemKey(pageIndex, tableIndex, rowIndex);
    const baseFor = (prev: Map<string, RowDurabilityOverride>): RowDurabilityOverride => {
      const existing = prev.get(key);
      if (existing) return existing;
      const packed = packResult?.items?.find((it) => it.id === key);
      if (packed) {
        return {
          durabilityTier: packed.durabilityTier,
          brittle: packed.brittle,
          orientationLock: packed.orientationLock,
        };
      }
      // Only reachable before the first pack returns — neutral, permissive default.
      return { durabilityTier: "medium", brittle: false, orientationLock: "none" };
    };
    const update = (prev: Map<string, RowDurabilityOverride>): Map<string, RowDurabilityOverride> => {
      const next = new Map(prev);
      next.set(key, { ...baseFor(prev), ...patch });
      return next;
    };
    if (editing) {
      setDraftDurabilityOverrides(update);
    } else {
      const nextOverrides = update(durabilityOverrides);
      setDurabilityOverrides(nextOverrides);
      if (result?.classification && classification) {
        void rerunPack(pages.length ? pages : result.document?.pages ?? [], classification, nextOverrides);
      }
    }
  };

  const addRow = (pageIndex: number, tableIndex: number) => {
    const table = draftPages.find((p) => p.index === pageIndex)?.tables.find((t) => t.index === tableIndex);
    if (!table) return;
    const newRowIndex = table.rows.length;
    const blankRow = Array<string>(table.headers.length).fill("");
    setDraftPages((prev) =>
      prev.map((page) =>
        page.index !== pageIndex
          ? page
          : {
              ...page,
              tables: page.tables.map((t) =>
                t.index !== tableIndex ? t : { ...t, rows: [...t.rows, blankRow] },
              ),
            },
      ),
    );
    setDraftExtraItems((prev) => [
      ...prev,
      {
        pageIndex,
        tableIndex,
        rowIndex: newRowIndex,
        label: "",
        fragility: "standard",
        confident: false,
        matchedTerm: null,
        reason: "manual entry",
      },
    ]);
  };

  const runQuote = async () => {
    if (!packResult?.selected || !originSelected || !destinationSelected) return;
    const fleet = packResult.fleet?.length ? packResult.fleet : [packResult.selected];
    const vanIds = fleet.map((r) => r.van.id);
    if (vanIds.length === 0) return;
    const vanPayloads = fleet.map((r) => r.placements.reduce((s, p) => s + p.weightKg, 0));
    setQuoting(true);
    setQuoteResult(null);
    setQuoteError(null);
    // Fragility surcharge is per fragile unit across the WHOLE fleet, not one van.
    const fragileCount = fleet.reduce(
      (n, r) => n + r.placements.filter((p) => p.fragile).length,
      0,
    );
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vanIds,
          origin: origin.trim(),
          destination: destination.trim(),
          fragileCount,
          vanPayloads,
          // Send the exact van objects the packer just chose (session Fleet-setup
          // vans included) so a session-only or in-session-edited van prices
          // correctly instead of being re-resolved against config/vans.json.
          vans: fleet.map((r) => r.van),
          // Session rate tweaks from the Quote-settings panel (omitted when none set).
          ...(buildRateOverrides() ? { rateOverrides: buildRateOverrides() } : {}),
          // Optional cross-dock through a hub (adds the hub-handling fee); omitted for a direct run.
          ...(viaHubAddress ? { viaHub: viaHubAddress } : {}),
          filename: sourceFilename,
          customer: customerProfile,
        }),
      });
      const data: QuoteResponse = await res.json();
      if (data.success) setQuoteResult(data);
      else setQuoteError(data.error ?? "Quote failed.");
    } catch {
      setQuoteError("Network error — could not reach the server.");
    } finally {
      setQuoting(false);
    }
  };

  // ── Multi-stop drop list + per-item tagging ──────────────────────────────
  const setStopTag = (pageIndex: number, tableIndex: number, rowIndex: number, dropIndex: number) => {
    const key = itemKey(pageIndex, tableIndex, rowIndex);
    setStopByItemId((prev) => {
      const next = new Map(prev);
      next.set(key, dropIndex);
      return next;
    });
  };
  const addDrop = () => setDrops((d) => [...d, { value: "", selected: false }]);
  const removeDrop = (i: number) => setDrops((d) => (d.length > 1 ? d.filter((_, j) => j !== i) : d));
  const setDrop = (i: number, value: string, selected: boolean) =>
    setDrops((d) => d.map((x, j) => (j === i ? { value, selected } : x)));

  // Resolve the prefilled addresses to canonical map locations and auto-confirm the ones
  // that match accurately (postcode-verified) — mimicking a manual pick from the dropdown,
  // so the operator doesn't have to re-select each. Only CONFIDENT matches are applied; the
  // rest stay flagged for a manual pick (never guess). Runs behind Nominatim's ≤1 req/s
  // throttle, so it completes a second or two per address — the fields are usable meanwhile.
  const autoConfirmAddresses = async (
    pickup: string | null,
    detectedDrops: string[],
    isMulti: boolean,
  ) => {
    const dests = isMulti
      ? detectedDrops
      : detectedDrops.length === 1 && detectedDrops[0]
        ? [detectedDrops[0]]
        : [];
    const toResolve = [...(pickup ? [pickup] : []), ...dests];
    if (toResolve.length === 0) return;

    setAddressNotice(
      `Checking ${toResolve.length} address${toResolve.length === 1 ? "" : "es"} against the map…`,
    );

    let results: Array<{ query: string; match: string | null; confident: boolean }> = [];
    try {
      const res = await fetch("/api/places/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: toResolve }),
      });
      if (!res.ok) return;
      results = ((await res.json()) as { results?: typeof results }).results ?? [];
    } catch {
      return; // Leave the fields as unconfirmed prefills — the operator picks manually.
    }

    const matchByQuery = new Map<string, string>();
    for (const r of results) if (r.confident && r.match) matchByQuery.set(r.query, r.match);

    if (pickup) {
      const m = matchByQuery.get(pickup);
      if (m) {
        // Guard against an edit in the resolve window: only replace text still equal to the prefill.
        setOrigin((cur) => (cur === pickup ? m : cur));
        setOriginSelected(true);
      }
    }
    if (isMulti) {
      setDrops((prev) =>
        prev.map((d) => {
          const m = matchByQuery.get(d.value);
          return m ? { value: m, selected: true } : d;
        }),
      );
    } else if (dests.length === 1 && dests[0]) {
      const m = matchByQuery.get(dests[0]);
      if (m) {
        setDestination((cur) => (cur === dests[0] ? m : cur));
        setDestinationSelected(true);
      }
    }

    const confirmed = toResolve.filter((a) => matchByQuery.has(a)).length;
    setAddressNotice(
      confirmed === toResolve.length
        ? `Auto-matched all ${confirmed} address${confirmed === 1 ? "" : "es"} from the PDF — each shows a green ✓. Review, then quote.`
        : `Auto-matched ${confirmed} of ${toResolve.length} addresses (green ✓). The rest need a manual pick from the list.`,
    );
  };

  // Prefills the quote form from PDF-detected addresses, then kicks off auto-confirmation.
  const applyDetectedAddresses = (
    addresses: IngestResponse["addresses"],
    // Undefined ⇒ config wasn't supplied; don't auto-switch to multi-stop (no client-side default).
    minDropsForMultiStop: number | undefined,
    // Row id → 0-based drop index, read server-side from the manifest's Stop column.
    itemStopIndex: Record<string, number> | undefined,
    // Document-level collect-vs-deliver hint from ingestion; absent ⇒ deliver (no change).
    direction: "collect" | "deliver" | undefined,
    // Destination/outbound hub postcode named on the sheet — aims the trunk when no delivery stops.
    outboundHubPostcode: string | null | undefined,
    // True when ingestion flagged this as a groupage/hub-consolidation manifest — routes it to the
    // shared-truck planner instead of the single/multi/collection form (which mis-read such sheets).
    isHubManifest: boolean,
  ) => {
    const pickup = addresses?.pickup ?? null;
    const detectedDrops = addresses?.drops ?? [];
    if (!pickup && detectedDrops.length === 0) {
      setDetectedAddresses(null);
      return;
    }
    setDetectedAddresses({
      pickup,
      drops: detectedDrops,
      deliveries: addresses?.deliveries ?? [],
      outboundHubPostcode: outboundHubPostcode ?? null,
    });

    // Seed each cargo row's stop/drop tag from the server's per-row attribution (read from the
    // manifest's Stop column). This must run BEFORE the collect-mode early return below, because
    // the collection per-pickup 3D groups pallets by this map exactly as multi-drop does — if it
    // only ran on the deliver path, a milk-round would land on Collection with no tags and the 3D
    // would show nothing. Rows the server couldn't confidently map stay untagged (never-guess).
    if (itemStopIndex && Object.keys(itemStopIndex).length > 0) {
      setStopByItemId(new Map(Object.entries(itemStopIndex)));
    }

    // WHICH FORM does this document open in? The decision itself lives in `routeManifest`
    // (lib/mode-selection/manifest-routing.ts) — pure, shared with the CLI scenario sweep, so the
    // browser and the terminal can never disagree about where a manifest lands. Everything below is
    // only the FORM-FILLING that follows from it. Advisory in every branch: the operator can still
    // pick any mode from the selector.
    const route = routeManifest({
      isHubManifest,
      direction,
      dropCount: detectedDrops.length,
      hasPickup: pickup !== null && pickup.trim() !== "",
      minDropsForMultiStop,
    });

    // A groupage/hub-consolidation manifest is quoted in the shared-truck planner: its load is
    // stated in pallets through a hub, which the single/multi/collection forms mis-read (the
    // standard packer over-counts the per-piece cargo summary). That planner reads the company +
    // pallet roster off the uploaded document, so there is nothing to prefill here.
    if (route.mode === "groupage") {
      setQuoteMode("groupage");
      setAddressNotice(
        "This looks like a groupage consolidation manifest — opened the shared-truck planner. " +
          "Click “Use the document I already uploaded” to read each company and its pallet count, " +
          "then fill the pallet weights (the reader won’t invent them) before quoting.",
      );
      return;
    }

    // A collection/pickup-round sheet lands straight on collection mode: every detected
    // address becomes a candidate pickup (collectPickups) and the embedded panel auto-suggests
    // the nearest hub + the packer's sized van. We skip the deliver-mode origin/drop prefill +
    // auto-confirm below, which target the single/multi form the collection panel doesn't use.
    if (route.mode === "collection") {
      setQuoteMode("collection");
      const count = [pickup, ...detectedDrops].filter((x) => x && x.trim() !== "").length;
      setAddressNotice(
        count > 0
          ? `This looks like a collection round — switched to Collection mode with ${count} pickup${count === 1 ? "" : "s"} prefilled. Pick or confirm the hub, then plan the run.`
          : "This looks like a collection round — switched to Collection mode. Add the pickups, then plan the run.",
      );
      return;
    }

    if (pickup) {
      setOrigin(pickup);
      setOriginSelected(false);
    }

    const isMulti = route.mode === "multi";
    let notice = "";
    if (isMulti) {
      setQuoteMode("multi");
      setDrops(detectedDrops.map((v) => ({ value: v, selected: false })));
      notice = `Found ${detectedDrops.length} delivery addresses in the PDF — addresses prefilled below; confirm each one before quoting. Multi-stop mode switched on.`;
    } else if (route.mode === "single" && detectedDrops[0]) {
      setQuoteMode("single");
      setDestination(detectedDrops[0]);
      setDestinationSelected(false);
      notice = "Found 1 delivery address in the PDF — addresses prefilled below; confirm each one before quoting.";
    } else if (pickup) {
      notice = "Found a pickup address in the PDF — prefilled below; confirm it before quoting.";
    }
    setAddressNotice(notice);

    void autoConfirmAddresses(pickup, detectedDrops, isMulti);
  };

  const dropsReady = drops.every((d) => d.value.trim() !== "" && d.selected);
  // A custom final destination must be a resolved address before it can be quoted; "last"/"drop"
  // reuse addresses that are already resolved, so they're always ready.
  const finalDestReady = finalDest.kind !== "custom" || (finalDest.value.trim() !== "" && finalDest.selected);
  // How many vans the current load needs — the whole fleet runs the multi-stop route.
  const fleetVanCount = packResult?.fleet?.length || (packResult?.selected ? 1 : 0);

  // Delivery modes (single/multi) show the origin→drops UI; groupage and collection swap in
  // their own panels, so the delivery-specific fields/pickers are hidden for them.
  const isDeliveryMode = quoteMode === "single" || quoteMode === "multi";
  // Collect direction: every detected address becomes a candidate pickup (a collection PDF is a
  // delivery PDF read the other way round). The packer's sized van (when the load came from a PDF)
  // seeds the collection truck so it comes from real volume; undefined ⇒ the panel's first-van default.
  const collectPickups = detectedAddresses
    ? [detectedAddresses.pickup, ...detectedAddresses.drops].filter(
        (x): x is string => !!x && x.trim() !== "",
      )
    : [];
  const fleetVanId = packResult?.fleet?.[0]?.van.id ?? packResult?.selected?.van.id;

  // Hand-off to the shared-truck flow: flips the quote type and carries over whatever
  // postcodes the planner already knows (detected from the PDF, or typed) so the
  // operator never re-enters what the app has already read.
  const switchToGroupage = () => {
    const keptOrigin = extractPostcode(detectedAddresses?.pickup ?? origin) ?? undefined;
    const keptDest =
      extractPostcode(
        detectedAddresses?.drops?.[0] ?? (quoteMode === "multi" ? drops[0]?.value : destination) ?? "",
      ) ?? undefined;
    setGroupagePrefill({ originPostcode: keptOrigin, destinationPostcode: keptDest });

    // Surface what shared-truck's single-origin→single-destination model had to drop, so
    // the panel warns instead of silently quoting a one-pallet job (see GroupageHandoff).
    const dropCount = detectedAddresses?.drops?.length ?? (quoteMode === "multi" ? drops.length : 0);
    const rec = modeRecommendation;
    const recommendedModeLabel = rec
      ? rec.hubs
        ? "Shared truck"
        : rec.multiStop
        ? "Multi-stop dedicated van"
        : "Single dedicated van"
      : null;
    const shouldWarn = dropCount > 1 || fleetVanCount > 1 || (rec != null && !rec.hubs);
    setGroupageHandoff(
      shouldWarn
        ? {
            dropCount,
            keptDestinationPostcode: keptDest ?? null,
            fleetVanCount,
            recommendedModeLabel,
            reasons: rec?.reasons ?? [],
          }
        : null,
    );

    setQuoteMode("groupage");
    setQuoteResult(null);
    setQuoteError(null);
    setQuoteWarnings([]);
    setVisitOrder(null);
  };

  // After a collection run is planned, move the consolidated load onto the shared-truck flow for the
  // hub-to-hub leg — origin prefilled to the collection hub. The trunk's destination is aimed at the
  // hub NEAREST the delivery locations: prefer a delivery postcode read off the sheet (groupage's own
  // resolver then maps it to the owning/nearest hub), else the outbound hub the sheet names, else left
  // for the operator. Reuses the groupage prefill seam, no new trunk engine.
  const sendCollectionHubToHub = (originHubPostcode: string | null) => {
    // This is a fresh groupage job (origin = the collection hub), so forget any remembered
    // shared-truck quote — otherwise a previously-cached origin would block this new prefill.
    clearPanelSnapshot(PANEL_SNAPSHOT_KEYS.groupage);
    const firstDeliveryPostcode = (detectedAddresses?.deliveries ?? [])
      .map((d) => extractPostcode(d) ?? undefined)
      .find((pc): pc is string => !!pc);
    const destinationPostcode =
      firstDeliveryPostcode ?? detectedAddresses?.outboundHubPostcode ?? undefined;
    setGroupagePrefill({ originPostcode: originHubPostcode ?? undefined, destinationPostcode, fromCollectionHub: true });
    setGroupageHandoff(null);
    setQuoteMode("groupage");
    setQuoteResult(null);
    setQuoteError(null);
    setQuoteWarnings([]);
    setVisitOrder(null);
  };

  const runChainQuote = async () => {
    if (!packResult?.selected || !originSelected || !dropsReady || !finalDestReady) return;
    // Price the WHOLE fleet (same pattern as the single-drop quote) — every van drives the route.
    const fleet = packResult.fleet?.length ? packResult.fleet : [packResult.selected];
    const vanIds = fleet.map((r) => r.van.id);
    if (vanIds.length === 0) return;
    const vanPayloads = fleet.map((r) => r.placements.reduce((s, p) => s + p.weightKg, 0));
    const fragileCount = fleet.reduce((n, r) => n + r.placements.filter((p) => p.fragile).length, 0);

    // Order the drops we send: a pinned existing drop is moved to the end so the one-way route ends
    // there (the last waypoint is the fixed endpoint). sendDropIdx maps sent position → original
    // drop index, so the router's returned visit order can be shown against the operator's numbering.
    const sendDropIdx = drops.map((_, i) => i);
    if (finalDest.kind === "drop" && finalDest.index < drops.length) {
      sendDropIdx.splice(sendDropIdx.indexOf(finalDest.index), 1);
      sendDropIdx.push(finalDest.index);
    }
    const stops = [
      { address: origin.trim(), kind: "pickup" as const },
      ...sendDropIdx.map((i) => ({ address: drops[i]!.value.trim(), kind: "drop" as const })),
    ];
    // A custom endpoint (a depot, not a delivery) is a routing waypoint only — no per-stop handling.
    const finalDestination =
      finalDest.kind === "custom" && finalDest.selected ? finalDest.value.trim() : undefined;

    setQuoting(true);
    setQuoteResult(null);
    setQuoteError(null);
    setQuoteWarnings([]);
    setVisitOrder(null);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stops,
          vanIds,
          vanPayloads,
          fragileCount,
          ...(finalDestination ? { finalDestination } : {}),
          // Optional cross-dock through a hub, inserted after the pickup (adds the hub-handling fee).
          ...(viaHubAddress ? { viaHub: viaHubAddress } : {}),
          // Opt-in: let the router pick the cheapest drop order (endpoint stays fixed).
          optimize: optimizeOrder,
          // Session rate tweaks from the Quote-settings panel (omitted when none set).
          ...(buildRateOverrides() ? { rateOverrides: buildRateOverrides() } : {}),
          // Send the exact van objects the packer chose so session-only vans price correctly.
          vans: fleet.map((r) => r.van),
          filename: sourceFilename,
          customer: customerProfile,
        }),
      });
      const data: QuoteResponse = await res.json();
      if (data.success) {
        setQuoteResult(data);
        setQuoteWarnings(data.warnings ?? []);
        // Map the router's visit order (positions in the sent drop list) back to the operator's
        // original drop numbering so the "picked path" note reads correctly.
        const raw = data.visitOrder ?? null;
        setVisitOrder(raw ? raw.map((pos) => sendDropIdx[pos] ?? pos) : null);
      } else {
        setQuoteError(data.error ?? "Quote failed.");
      }
    } catch {
      setQuoteError("Network error — could not reach the server.");
    } finally {
      setQuoting(false);
    }
  };

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    // A new manifest means the remembered collection/groupage runs no longer describe the load —
    // forget them so a returning operator plans fresh, not against the previous order.
    clearPanelSnapshots();
    setResult(null);
    setError(null);
    setPackResult(null);
    setPackError(null);
    setQuoteResult(null);
    setQuoteError(null);
    setOrigin("");
    setDestination("");
    setOriginSelected(false);
    setDestinationSelected(false);
    setAddressNotice(null);
    setDetectedAddresses(null);
    setExtraItems([]);
    setEditing(false);
    setQuoteWarnings([]);
    setQuoteMode("single");
    setGroupagePrefill(undefined);
    setDrops([{ value: "", selected: false }]);
    setStopByItemId(new Map());
    setOptimizeOrder(false);
    setVisitOrder(null);
    setFile(f);
    if (f) void runIngest(f);
  };

  const handleReset = () => {
    clearPanelSnapshots();
    setFile(null);
    setResult(null);
    setError(null);
    setClientMs(null);
    setPages([]);
    setManualOverrides(new Map());
    setDurabilityOverrides(new Map());
    setExtraItems([]);
    setEditing(false);
    setDraftPages([]);
    setDraftOverrides(new Map());
    setDraftDurabilityOverrides(new Map());
    setDraftExtraItems([]);
    setPackResult(null);
    setPackError(null);
    setOrigin("");
    setDestination("");
    setOriginSelected(false);
    setDestinationSelected(false);
    setAddressNotice(null);
    setDetectedAddresses(null);
    setQuoteResult(null);
    setQuoteError(null);
    setQuoteWarnings([]);
    setQuoteMode("single");
    setGroupagePrefill(undefined);
    setDrops([{ value: "", selected: false }]);
    setStopByItemId(new Map());
  };

  const itemCount = classification?.items.length ?? 0;

  return (
    <>
      <AppHeader status={status} filename={file?.name} />

      <div
        className="page-grid"
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: `${spacing.xl}px ${spacing.xl}px`,
        }}
      >
        {/* ── Left sidebar ──────────────────────────────────────────── */}
        <aside
          className="sidebar-sticky"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: spacing.md,
            position: "sticky",
            top: 56 + spacing.xl,
          }}
        >
          {/* Upload card */}
          <div
            style={{
              background: color.surface,
              border: `1px solid ${color.border}`,
              borderRadius: radius.card,
              padding: spacing.lg,
              boxShadow: color.shadow,
              display: "flex",
              flexDirection: "column",
              gap: spacing.md,
            }}
          >
            <div>
              <p
                style={{
                  fontSize: font.xs,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.07em",
                  color: color.muted,
                  margin: 0,
                  marginBottom: spacing.xs,
                }}
              >
                Upload
              </p>
              <h1
                style={{
                  fontSize: font.lg,
                  fontWeight: 700,
                  margin: 0,
                  color: color.text,
                  letterSpacing: "-0.02em",
                  lineHeight: 1.2,
                }}
              >
                PDF Ingestion
              </h1>
              <p
                style={{
                  fontSize: font.sm,
                  color: color.muted,
                  marginTop: spacing.xs,
                  marginBottom: 0,
                  lineHeight: 1.5,
                }}
              >
                Upload a quotation or cargo PDF to classify items automatically.
              </p>
            </div>

            <DropZone
              loading={loading}
              hasFile={file !== null}
              filename={file?.name}
              error={error}
              onSelect={handleSelect}
              onRerun={() => file && void runIngest(file)}
            />

            {(result || error) && !loading && (
              <button
                type="button"
                onClick={handleReset}
                style={{
                  padding: `${spacing.sm}px ${spacing.md}px`,
                  borderRadius: radius.card - 4,
                  border: `1px solid ${color.border}`,
                  background: color.surfaceSub,
                  color: color.muted,
                  fontSize: font.sm,
                  fontWeight: 500,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                Start Over / New Quote
              </button>
            )}
          </div>

          {/* Reorderable sidebar panels — drag the grip (top-left of each card) to rearrange;
              the chosen order is remembered across reloads. The stats panel keeps its slot even
              while hidden (passed as null → collapsed) so it returns to place once results load. */}
          <SortableStack
            storageKey="fleetview.sidebar.order"
            gap={spacing.md}
            items={[
              {
                id: "fleet",
                node: (
                  <CollapsibleCard title="Fleet setup">
                    <VanConfigPanel embedded />
                  </CollapsibleCard>
                ),
              },
              {
                id: "shipments",
                node: (
                  <CollapsibleCard
                    title="Shipments"
                    badge={shipmentsCount != null ? `(${shipmentsCount})` : undefined}
                  >
                    <ShipmentsBoard embedded onCount={setShipmentsCount} refreshKey={shipmentsRefresh} />
                  </CollapsibleCard>
                ),
              },
              {
                id: "customer",
                node: <CustomerProfileCard customer={customerProfile} filename={sourceFilename} />,
              },
              {
                id: "history",
                node: <QuotationHistory />,
              },
              {
                id: "stats",
                node:
                  classification && result ? (
                    <div
                      style={{
                        background: color.surface,
                        border: `1px solid ${color.border}`,
                        borderRadius: radius.card,
                        padding: spacing.lg,
                        boxShadow: color.shadow,
                        display: "flex",
                        flexDirection: "column",
                        gap: spacing.lg,
                      }}
                    >
                      {/* Summary counts */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: spacing.sm,
                }}
              >
                <StatBox
                  label="Total items"
                  value={String(itemCount)}
                  accent={false}
                />
                <StatBox
                  label="Pages"
                  value={String(result.document?.pageCount ?? "—")}
                  accent={false}
                />
                <StatBox
                  label="Fragile"
                  value={String(classification.counts.fragile)}
                  accent={classification.counts.fragile > 0}
                  accentColor={color.fragile.fg}
                  accentBg={color.fragile.bg}
                />
                <StatBox
                  label="Standard"
                  value={String(classification.counts.standard)}
                  accent={false}
                  accentColor={color.standard.fg}
                  accentBg={color.standard.bg}
                />
              </div>

              {/* Read-trust banner. Shown only when the PDF was photographed + OCR'd
                  (digits can be misread, e.g. 9→0). A text-layer read is exact ⇒ no banner. */}
              {result.document?.needsReview && (
                <div
                  role="status"
                  style={{
                    marginTop: spacing.sm,
                    padding: `${spacing.sm} ${spacing.md}`,
                    background: color.warningBg,
                    border: `1px solid ${color.warningBorder}`,
                    borderRadius: radius.card,
                    color: color.warning,
                    fontSize: font.sm,
                    lineHeight: 1.5,
                  }}
                >
                  <strong>⚠ Read by photo-scan.</strong>{" "}
                  Numbers and postcodes may be misread — please double-check the
                  addresses and cargo figures before quoting.
                  {typeof result.document?.confidence === "number" && (
                    <> (recognition confidence ~{Math.round(result.document.confidence)}%)</>
                  )}
                </div>
              )}

              <ClassificationSummary classification={classification} />

              {result.perf && (
                <PerfPanel
                  perf={result.perf}
                  provider={result.provider}
                  clientMs={clientMs}
                />
              )}
                    </div>
                  ) : null,
              },
            ]}
          />

          {/* Loading skeleton card */}
          {loading && (
            <div
              role="status"
              aria-label="Processing PDF"
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius.card,
                padding: spacing.lg,
                boxShadow: color.shadow,
                display: "flex",
                flexDirection: "column",
                gap: spacing.md,
              }}
            >
              <SkeletonRow width="60%" />
              <SkeletonRow width="80%" />
              <SkeletonRow width="45%" />
            </div>
          )}

          {/* ── Hub network ─────────────────────────────────────────────
              The depot/hub network and the pickup-round planner that runs on
              it, grouped together at the foot of the sidebar — out of the main
              quote flow until needed. Depots & hubs is listed first (set up the
              network) then the collection run (uses it), so the planner's
              "add the address in Depots & hubs first" points at the card above.
              Depots & hubs still auto-opens + scrolls into view on a groupage
              catchment miss (openHubs → hubsCardRef). */}
          <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>
            <p
              style={{
                fontSize: font.xs,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                color: color.muted,
                margin: 0,
              }}
            >
              Hub network
            </p>
            <div ref={hubsCardRef}>
              <CollapsibleCard title="Depots & hubs" open={hubsOpen} onToggle={setHubsOpen}>
                <HubConfigPanel embedded prefill={hubPrefill} onPrefillConsumed={() => setHubPrefill(undefined)} />
              </CollapsibleCard>
            </div>
            <CollapsibleCard title="Hub collection run">
              <CollectionRunPanel />
            </CollapsibleCard>
          </div>
        </aside>

        {/* ── Main content area ─────────────────────────────────────── */}
        <main style={{ display: "flex", flexDirection: "column", gap: spacing.xl, minWidth: 0 }}>
          {/* Empty state when nothing loaded */}
          {!file && !loading && (
            <div
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius.card,
                boxShadow: color.shadow,
                padding: `${spacing.xxl + spacing.xl}px ${spacing.xl}px`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: spacing.md,
                textAlign: "center",
              }}
            >
              {/* UX fix H10: instructive empty state */}
              <div
                aria-hidden="true"
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  background: color.accentMuted,
                  border: `1px solid ${color.accentBorder}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg
                  width={26}
                  height={26}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={color.accent}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </div>
              <div>
                <h2
                  style={{
                    fontSize: font.md + 2,
                    fontWeight: 700,
                    color: color.text,
                    margin: 0,
                    letterSpacing: "-0.01em",
                  }}
                >
                  No PDF loaded
                </h2>
                <p
                  style={{
                    fontSize: font.base,
                    color: color.muted,
                    marginTop: spacing.xs,
                    marginBottom: 0,
                    maxWidth: 380,
                    lineHeight: 1.6,
                  }}
                >
                  Upload a quotation or cargo manifest PDF using the panel on the left.
                  Your items will appear here after classification.
                </p>
              </div>
              {quoteMode !== "groupage" && (
                <button
                  type="button"
                  onClick={switchToGroupage}
                  style={{
                    border: "none",
                    background: "none",
                    padding: 0,
                    color: color.accentDark,
                    fontSize: font.sm,
                    fontWeight: 600,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  No PDF? Quote a shared-truck (groupage) shipment instead →
                </button>
              )}
              {quoteMode !== "collection" && (
                <button
                  type="button"
                  onClick={() => {
                    setQuoteMode("collection");
                    setQuoteResult(null);
                    setQuoteError(null);
                  }}
                  style={{
                    border: "none",
                    background: "none",
                    padding: 0,
                    color: color.accentDark,
                    fontSize: font.sm,
                    fontWeight: 600,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  No PDF? Plan a hub collection (pickup round) instead →
                </button>
              )}
            </div>
          )}

          {/* Collection run without a load plan — a pickup round needs only addresses + a hub,
              so it stays reachable before (or without) a PDF, mirroring the shared-truck block above. */}
          {quoteMode === "collection" && !packResult?.selected && (
            <div style={{ ...card, display: "flex", flexDirection: "column", gap: spacing.lg }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.sm }}>
                <div>
                  <p
                    style={{
                      fontSize: font.xs,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      color: color.muted,
                      margin: 0,
                      marginBottom: spacing.xs,
                    }}
                  >
                    Hub network · collection
                  </p>
                  <h2
                    style={{
                      fontSize: font.lg,
                      fontWeight: 700,
                      margin: 0,
                      color: color.text,
                      letterSpacing: "-0.02em",
                      lineHeight: 1.2,
                    }}
                  >
                    Plan a Collection Run
                  </h2>
                  <p style={{ fontSize: font.sm, color: color.muted, marginTop: spacing.xs, marginBottom: 0 }}>
                    A pickup round: one van leaves a depot, collects every order, and returns — priced per mile.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setQuoteMode("single")}
                  style={buttonSecondary(false)}
                >
                  ← Back
                </button>
              </div>
              <CollectionRunPanel embedded prefillPickups={collectPickups} fleetVanId={fleetVanId} onSendHubToHub={sendCollectionHubToHub} stopPalletsSlot={collectionPalletsSlot} />
            </div>
          )}

          {/* PDF preview */}
          {previewUrl && (
            <div
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius.card,
                boxShadow: color.shadow,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: `${spacing.md}px ${spacing.lg}px`,
                  borderBottom: `1px solid ${color.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <p
                  style={{
                    fontSize: font.xs,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    color: color.muted,
                    margin: 0,
                  }}
                >
                  Preview — {file?.name}
                </p>
                {result?.document && (
                  <span
                    style={{
                      fontSize: font.xs,
                      color: color.muted,
                      background: color.surfaceSub,
                      border: `1px solid ${color.border}`,
                      borderRadius: 999,
                      padding: "2px 10px",
                    }}
                  >
                    {result.document.pageCount} page{result.document.pageCount !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <iframe
                src={previewUrl}
                title="PDF preview"
                style={{
                  width: "100%",
                  height: 520,
                  border: "none",
                  display: "block",
                }}
              />
            </div>
          )}

          {/* Results table */}
          {classification && result && (
            <div
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius.card,
                boxShadow: color.shadow,
                padding: spacing.lg,
                display: "flex",
                flexDirection: "column",
                gap: spacing.lg,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: spacing.sm,
                }}
              >
                <p
                  style={{
                    fontSize: font.xs,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    color: color.muted,
                    margin: 0,
                  }}
                >
                  Classified items
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
                  <span
                    style={{
                      fontSize: font.sm,
                      color: color.muted,
                      background: color.surfaceSub,
                      border: `1px solid ${color.border}`,
                      borderRadius: 999,
                      padding: "2px 10px",
                    }}
                  >
                    {itemCount} item{itemCount !== 1 ? "s" : ""}
                  </span>
                  {editing ? (
                    <>
                      <button type="button" onClick={cancelEdit} style={buttonSecondary(false)}>
                        Cancel
                      </button>
                      <button type="button" onClick={saveEdit} style={buttonPrimary(false)}>
                        Save changes
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={enterEdit} style={buttonSecondary(false)}>
                      Edit table
                    </button>
                  )}
                </div>
              </div>

              <ResultTables
                pages={viewPages}
                classMap={classMap}
                durabilityByKey={durabilityView}
                durabilityStatus={durabilityStatus}
                editing={editing}
                onCellChange={updateCell}
                onSetFragility={setFragility}
                onSetDurability={setDurability}
                onAddRow={addRow}
                stopMode={quoteMode === "multi" && !!packResult?.selected}
                dropCount={drops.length}
                stopByItemId={stopByItemId}
                onSetStop={setStopTag}
              />
            </div>
          )}

          {/* Shared-truck quote panel — sits AFTER the classified-items table so groupage reads in the
              same order as a point-to-point quote (table → 3D/pallet model → quote), never jumping the
              "Get quote" to the top of the page. Renders when shared-truck mode is on and there is no
              standard load plan (a hub manifest skips the standard pack; or a from-scratch groupage quote
              with no PDF, where nothing sits above it anyway). Its own 3D + pallet builder live inside. */}
          {quoteMode === "groupage" && !packResult?.selected && (
            <div style={{ ...card, display: "flex", flexDirection: "column", gap: spacing.lg }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: spacing.sm }}>
                <div>
                  <p
                    style={{
                      fontSize: font.xs,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      color: color.muted,
                      margin: 0,
                      marginBottom: spacing.xs,
                    }}
                  >
                    Shared truck · groupage
                  </p>
                  <h2
                    style={{
                      fontSize: font.lg,
                      fontWeight: 700,
                      margin: 0,
                      color: color.text,
                      letterSpacing: "-0.02em",
                      lineHeight: 1.2,
                    }}
                  >
                    Plan a Shared Truck
                  </h2>
                  <p style={{ fontSize: font.sm, color: color.muted, marginTop: spacing.xs, marginBottom: 0 }}>
                    Build the pallets, load the pooled truck, then price it — pallet freight that shares space
                    between depots, charged per pallet-space.
                  </p>
                </div>
                {/* Back returns to the standard load view — but only when there IS one to return to.
                    An auto-detected groupage/hub manifest has no single-load view (the standard packer
                    mis-reads it), so a Back that flips to "single" would strand the operator on an empty
                    screen ("it's gone"). Hide it there; groupage is the right home for this document. */}
                {!result?.hubManifest?.isHubManifest && (
                  <button
                    type="button"
                    onClick={() => setQuoteMode("single")}
                    style={buttonSecondary(false)}
                  >
                    ← Back
                  </button>
                )}
              </div>
              <GroupagePanel
                embedded
                prefill={groupagePrefill}
                handoff={groupageHandoff}
                unplaced={packResult?.unplaced ?? []}
                items={packResult?.items ?? []}
                palletMaxHeightM={palletMaxHeightM}
                uploadedDocument={result?.document ?? null}
                onOpenHubs={openHubs}
                onBooked={() => setShipmentsRefresh((n) => n + 1)}
              />
            </div>
          )}

          {/* Stage 3 — Load plan (which van, does it fit, how it packs) */}
          {packing && !packResult && (
            <div
              role="status"
              aria-label="Calculating load plan"
              style={{
                ...card,
                display: "flex",
                alignItems: "center",
                gap: spacing.md,
                color: color.muted,
                fontSize: font.sm,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: "50%",
                  border: `2px solid ${color.border}`,
                  borderTopColor: color.accent,
                  animation: "spin 0.8s linear infinite",
                }}
              />
              Calculating 3D load plan…
            </div>
          )}

          {/* Packing failed — never swallow this; the user needs to know why there's no load plan */}
          {packError && !packing && (
            <ErrorBanner
              icon
              style={{ borderRadius: radius.card, padding: `${spacing.lg}px`, boxShadow: color.shadow, fontSize: font.sm }}
            >
              <strong>Could not calculate a load plan.</strong> {packError}
            </ErrorBanner>
          )}

          {packResult?.selected && (
            <PackingResultPanel
              fleet={packResult.fleet?.length ? packResult.fleet : [packResult.selected]}
              items={packResult.items ?? []}
              unplaced={packResult.unplaced ?? []}
              reasons={packResult.reasons ?? {}}
              fitsInSingleVan={packResult.fitsInSingleVan ?? false}
              packableUnits={packResult.packableUnits ?? 0}
              toleranceM={packResult.toleranceM}
              maxReachHeightM={packResult.maxReachHeightM}
              blockLabels={packResult.blockLabels}
              skippedTables={packResult.skippedTables ?? []}
              flaggedTables={packResult.flaggedTables ?? []}
              availableVanTypes={sessionVans}
              respectReachLimit={respectReachLimit}
              onToggleReachLimit={toggleReachLimit}
              reachBusy={packing}
            />
          )}

          {/* Stage 5 — Quote */}
          {packResult?.selected && (
            <div
              style={{
                ...card,
                display: "flex",
                flexDirection: "column",
                gap: spacing.lg,
              }}
            >
              {/* Header */}
              <div>
                <p
                  style={{
                    fontSize: font.xs,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    color: color.muted,
                    margin: 0,
                    marginBottom: spacing.xs,
                  }}
                >
                  Route & Price
                </p>
                <h2
                  style={{
                    fontSize: font.lg,
                    fontWeight: 700,
                    margin: 0,
                    color: color.text,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.2,
                  }}
                >
                  Get a Quote
                </h2>
                <p
                  style={{
                    fontSize: font.sm,
                    color: color.muted,
                    marginTop: spacing.xs,
                    marginBottom: 0,
                  }}
                >
                  {(() => {
                    const fleet = packResult.fleet?.length ? packResult.fleet : [packResult.selected];
                    const weight = Math.round(
                      fleet.reduce((s, r) => s + r.placements.reduce((w, p) => w + p.weightKg, 0), 0),
                    );
                    return (
                      <>
                        Vehicles: <strong>{fleet.length}</strong> · Total cargo weight:{" "}
                        <strong>{weight} kg</strong>
                      </>
                    );
                  })()}
                </p>
              </div>

              {/* Quote settings — per-quote rate overrides. Session-only: applied to this quote,
                  never written back to config. Collapsed by default; hidden for shared-truck
                  quotes, whose rates come from config/groupage-rates.json — these knobs would
                  not apply and must never look like they do. */}
              {isDeliveryMode && (
              <div style={{ alignSelf: "stretch" }}>
                <button
                  type="button"
                  onClick={() => setSettingsOpen((o) => !o)}
                  aria-expanded={settingsOpen}
                  title="Adjust the rates behind this quote (driver rate, return trip, surcharges). Applies to this quote only."
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: spacing.xs,
                    border: `1px solid ${color.border}`,
                    background: color.surfaceSub,
                    color: overridesActive ? color.accentDark : color.muted,
                    borderRadius: radius.button,
                    padding: "5px 12px",
                    fontSize: font.xs,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  ⚙ Quote settings{overridesActive ? " · customised" : ""} {settingsOpen ? "▾" : "▸"}
                </button>
                {settingsOpen && (
                  <div
                    style={{
                      marginTop: spacing.sm,
                      padding: spacing.md,
                      border: `1px solid ${color.border}`,
                      borderRadius: radius.card - 4,
                      background: color.surfaceSub,
                      display: "flex",
                      flexDirection: "column",
                      gap: spacing.sm,
                    }}
                  >
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: spacing.sm }}>
                      {RATE_FIELDS.map((f) => {
                        const def = pricingDefaults?.[f.key];
                        const cur = pricingDefaults?.currencySymbol ?? "£";
                        const suffix =
                          f.unit === "minutes" ? "min" : f.unit === "factor" ? "×" : f.unit === "currency-hr" ? `${cur}/hr` : cur;
                        const disabled = f.singleDropOnly && quoteMode === "multi";
                        return (
                          <label
                            key={f.key}
                            title={f.hint}
                            style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: font.xs, color: color.muted, opacity: disabled ? 0.5 : 1 }}
                          >
                            <span style={{ fontWeight: 600 }}>
                              {f.label} <span style={{ fontWeight: 400 }}>({suffix})</span>
                            </span>
                            <input
                              type="number"
                              min={0}
                              step="any"
                              inputMode="decimal"
                              value={rateInputs[f.key]}
                              placeholder={def != null ? String(def) : ""}
                              disabled={disabled}
                              onChange={(e) => setRateInputs((p) => ({ ...p, [f.key]: e.target.value }))}
                              style={{
                                padding: "7px 10px",
                                borderRadius: radius.input,
                                border: `1px solid ${color.border}`,
                                background: color.surface,
                                color: color.text,
                                fontSize: font.sm,
                                outline: "none",
                                width: "100%",
                                boxSizing: "border-box",
                              }}
                            />
                          </label>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, flexWrap: "wrap" }}>
                      <span style={{ fontSize: font.xs, color: color.muted }}>
                        Blank = use the default. Applies to this quote only — your saved config is never changed.
                      </span>
                      {overridesActive && (
                        <button
                          type="button"
                          onClick={() =>
                            setRateInputs({ driverHourlyRate: "", loadUnloadMinutesPerVan: "", returnFactor: "", fragilitySurchargePerItem: "" })
                          }
                          style={{
                            border: `1px solid ${color.border}`,
                            background: color.surface,
                            color: color.accentDark,
                            borderRadius: radius.button,
                            padding: "4px 12px",
                            fontSize: font.xs,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Reset to defaults
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
              )}

              {/* Decision matrix — what the quotation itself suggests (advisory, overridable). */}
              {modeRecommendation && (
                <ModeRecommendationBanner
                  rec={modeRecommendation}
                  groupageActive={quoteMode === "groupage"}
                  onUseGroupage={switchToGroupage}
                />
              )}

              {/* Quote-type toggle — single drop stays the default */}
              <div
                role="tablist"
                aria-label="Quote type"
                style={{
                  display: "inline-flex",
                  alignSelf: "flex-start",
                  background: color.surfaceSub,
                  border: `1px solid ${color.border}`,
                  borderRadius: radius.input,
                  padding: 3,
                  gap: 3,
                }}
              >
                {(
                  [
                    ["single", "Single drop"],
                    ["multi", "Multi-stop"],
                    ["collection", "Collection"],
                    ["groupage", "Shared truck"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={quoteMode === m}
                    onClick={() => {
                      if (m === "groupage") {
                        switchToGroupage();
                        return;
                      }
                      setQuoteMode(m);
                      setQuoteResult(null);
                      setQuoteError(null);
                      setQuoteWarnings([]);
                      setVisitOrder(null);
                      // If entering a standard load-plan mode with no load plan yet (a groupage
                      // manifest was auto-opened in the shared-truck planner, which skips the
                      // standard pack), compute it now so the Get Quote button isn't a silent
                      // no-op. For a manifest the standard packer can't handle this surfaces the
                      // honest "can't build a load plan" error instead of doing nothing.
                      if ((m === "single" || m === "multi") && result && !packResult && !packing) {
                        void runPack(result, durabilityOverrides);
                      }
                    }}
                    style={{
                      padding: "6px 14px",
                      borderRadius: radius.input - 3,
                      border: "none",
                      cursor: "pointer",
                      fontSize: font.sm,
                      fontWeight: 600,
                      background: quoteMode === m ? color.surface : "transparent",
                      color: quoteMode === m ? color.text : color.muted,
                      boxShadow: quoteMode === m ? color.shadow : "none",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {duplicateNotice && (
                <div
                  role="status"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: spacing.sm,
                    fontSize: font.sm,
                    color: color.review.fg,
                    background: color.review.bg,
                    border: `1px solid ${color.review.border}`,
                    borderRadius: radius.card - 4,
                    padding: `${spacing.sm}px ${spacing.md}px`,
                  }}
                >
                  <span>⚠️ {duplicateNotice}</span>
                  <button
                    type="button"
                    onClick={() => setDuplicateNotice(null)}
                    aria-label="Dismiss duplicate-order notice"
                    style={{
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      color: color.review.fg,
                      fontSize: font.sm,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* Groupage/hub-consolidation manifest nudge: this file states its load in pallets
                  through a hub — the standard packer mis-reads it (a large piece line blows the
                  packing limit). Point the operator at the shared-truck planner instead. Advisory,
                  never auto-routed (mirrors the mode-selector nudge pattern). */}
              {result?.hubManifest?.isHubManifest && quoteMode !== "groupage" && (
                <div
                  role="status"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: spacing.sm,
                    fontSize: font.sm,
                    color: color.review.fg,
                    background: color.review.bg,
                    border: `1px solid ${color.review.border}`,
                    borderRadius: radius.card - 4,
                    padding: `${spacing.sm}px ${spacing.md}px`,
                  }}
                >
                  <span>
                    🚚 {result.hubManifest.reasons.join(" ")}
                  </span>
                  <button
                    type="button"
                    onClick={switchToGroupage}
                    style={{
                      flexShrink: 0,
                      background: color.review.fg,
                      color: color.surface,
                      border: "none",
                      borderRadius: radius.input - 3,
                      cursor: "pointer",
                      fontSize: font.sm,
                      fontWeight: 600,
                      padding: "6px 12px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Open shared-truck planner →
                  </button>
                </div>
              )}

              {isDeliveryMode && addressNotice && (
                <div
                  role="status"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: spacing.sm,
                    fontSize: font.sm,
                    color: color.review.fg,
                    background: color.review.bg,
                    border: `1px solid ${color.review.border}`,
                    borderRadius: radius.card - 4,
                    padding: `${spacing.sm}px ${spacing.md}px`,
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs, minWidth: 0 }}>
                    <span>📍 {addressNotice}</span>
                    {detectedAddresses && (detectedAddresses.pickup || detectedAddresses.drops.length > 0) && (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                          fontSize: font.xs,
                          // Wrap the full value so a long address clipped by the field stays readable.
                          overflowWrap: "anywhere",
                        }}
                      >
                        {detectedAddresses.pickup && (
                          <span>
                            <strong>Pickup:</strong> {detectedAddresses.pickup}
                          </span>
                        )}
                        {detectedAddresses.drops.map((d, i) => (
                          <span key={i}>
                            <strong>
                              {detectedAddresses.drops.length > 1 ? `Drop ${i + 1}:` : "Delivery:"}
                            </strong>{" "}
                            {d}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={() => {
                      setAddressNotice(null);
                      setDetectedAddresses(null);
                    }}
                    style={{
                      flexShrink: 0,
                      border: "none",
                      background: "none",
                      color: color.review.fg,
                      cursor: "pointer",
                      fontSize: font.base,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              {/* Pickup / Origin — shared by single/multi; Destination shows for single drop only.
                  Shared-truck mode has its own postcode fields, so these are hidden there. */}
              {isDeliveryMode && (
              <div style={{ display: "flex", gap: spacing.md, flexWrap: "wrap" }}>
                <label style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: spacing.xs }}>
                  <span style={{ fontSize: font.sm, fontWeight: 600, color: color.muted }}>
                    {quoteMode === "multi" ? "Pickup" : "Origin"}
                  </span>
                  <PlacesInput
                    value={origin}
                    valid={originSelected}
                    onChange={(v) => { setOrigin(v); setOriginSelected(false); }}
                    onSelect={(s) => { setOrigin(s.label); setOriginSelected(true); }}
                    placeholder="e.g. London, UK"
                    style={{
                      padding: "9px 12px",
                      borderRadius: radius.input,
                      border: `1px solid ${origin.trim() && !originSelected ? color.error : color.border}`,
                      background: color.surfaceSub,
                      color: color.text,
                      fontSize: font.base,
                      outline: "none",
                      width: "100%",
                      boxSizing: "border-box",
                    }}
                  />
                  {origin.trim() && !originSelected && (
                    <span style={{ fontSize: font.xs, color: color.error }}>Select a location from the list.</span>
                  )}
                </label>
                {quoteMode === "single" && (
                  <label style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: spacing.xs }}>
                    <span style={{ fontSize: font.sm, fontWeight: 600, color: color.muted }}>Destination</span>
                    <PlacesInput
                      value={destination}
                      valid={destinationSelected}
                      onChange={(v) => { setDestination(v); setDestinationSelected(false); }}
                      onSelect={(s) => { setDestination(s.label); setDestinationSelected(true); }}
                      placeholder="e.g. Manchester, UK"
                      style={{
                        padding: "9px 12px",
                        borderRadius: radius.input,
                        border: `1px solid ${destination.trim() && !destinationSelected ? color.error : color.border}`,
                        background: color.surfaceSub,
                        color: color.text,
                        fontSize: font.base,
                        outline: "none",
                        width: "100%",
                        boxSizing: "border-box",
                      }}
                    />
                    {destination.trim() && !destinationSelected && (
                      <span style={{ fontSize: font.xs, color: color.error }}>Select a location from the list.</span>
                    )}
                  </label>
                )}
              </div>
              )}

              {/* Multi-stop: ordered drop list + tagging hint */}
              {quoteMode === "multi" && (
                <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
                  <span style={{ fontSize: font.sm, fontWeight: 600, color: color.muted }}>
                    Drop-offs (in visit order)
                  </span>
                  {drops.map((d, i) => (
                    <div key={i} style={{ display: "flex", gap: spacing.sm, alignItems: "flex-start" }}>
                      <span style={{ flexShrink: 0, marginTop: 10, fontSize: font.xs, fontWeight: 700, color: color.muted, minWidth: 44 }}>
                        Drop {i + 1}
                      </span>
                      <div style={{ flex: 1, minWidth: 180 }}>
                        <PlacesInput
                          value={d.value}
                          valid={d.selected}
                          onChange={(v) => setDrop(i, v, false)}
                          onSelect={(s) => setDrop(i, s.label, true)}
                          placeholder="e.g. Leeds, UK"
                          style={{
                            padding: "9px 12px",
                            borderRadius: radius.input,
                            border: `1px solid ${d.value.trim() && !d.selected ? color.error : color.border}`,
                            background: color.surfaceSub,
                            color: color.text,
                            fontSize: font.base,
                            outline: "none",
                            width: "100%",
                            boxSizing: "border-box",
                          }}
                        />
                        {d.value.trim() && !d.selected && (
                          <span style={{ fontSize: font.xs, color: color.error }}>Select a location from the list.</span>
                        )}
                      </div>
                      {drops.length > 1 && (
                        <button
                          type="button"
                          aria-label={`Remove drop ${i + 1}`}
                          onClick={() => removeDrop(i)}
                          style={{
                            flexShrink: 0,
                            marginTop: 4,
                            padding: "6px 10px",
                            borderRadius: radius.input,
                            border: `1px solid ${color.border}`,
                            background: color.surfaceSub,
                            color: color.muted,
                            cursor: "pointer",
                            fontSize: font.sm,
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addDrop}
                    style={{
                      alignSelf: "flex-start",
                      border: `1px dashed ${color.border}`,
                      background: color.surfaceSub,
                      color: color.accentDark,
                      borderRadius: radius.button,
                      padding: "6px 12px",
                      fontSize: font.sm,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    + Add drop
                  </button>
                  <label
                    title="Leave unticked to keep your exact order. Tick to let us reorder the drops for the shortest overall drive — the delivery sequence below updates with the result."
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: spacing.xs,
                      fontSize: font.sm,
                      color: color.text,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={optimizeOrder}
                      onChange={(e) => setOptimizeOrder(e.target.checked)}
                    />
                    Let us pick the best order (shortest drive)
                  </label>

                  {/* Optional pinned final destination — the run ends here (no return journey). */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: spacing.xs,
                      flexWrap: "wrap",
                      fontSize: font.sm,
                      color: color.text,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>End the run at:</span>
                    <select
                      value={
                        finalDest.kind === "drop" && finalDest.index < drops.length
                          ? `drop:${finalDest.index}`
                          : finalDest.kind === "custom"
                            ? "custom"
                            : "last"
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "last") setFinalDest({ kind: "last" });
                        else if (v === "custom") setFinalDest({ kind: "custom", value: "", selected: false });
                        else setFinalDest({ kind: "drop", index: Number(v.slice("drop:".length)) });
                      }}
                      style={{
                        padding: "7px 10px",
                        borderRadius: radius.input,
                        border: `1px solid ${color.border}`,
                        background: color.surfaceSub,
                        color: color.text,
                        fontSize: font.sm,
                        cursor: "pointer",
                      }}
                    >
                      <option value="last">Last drop (default)</option>
                      {drops.map((d, i) => (
                        <option key={i} value={`drop:${i}`}>
                          Drop {i + 1}
                          {d.value.trim() ? ` — ${d.value.trim()}` : ""}
                        </option>
                      ))}
                      <option value="custom">A custom address…</option>
                    </select>
                  </label>
                  {finalDest.kind === "custom" && (
                    <div style={{ marginLeft: 0 }}>
                      <PlacesInput
                        value={finalDest.value}
                        valid={finalDest.selected}
                        onChange={(v) => setFinalDest({ kind: "custom", value: v, selected: false })}
                        onSelect={(s) => setFinalDest({ kind: "custom", value: s.label, selected: true })}
                        placeholder="e.g. depot postcode or address"
                        style={{
                          padding: "9px 12px",
                          borderRadius: radius.input,
                          border: `1px solid ${finalDest.value.trim() && !finalDest.selected ? color.error : color.border}`,
                          background: color.surfaceSub,
                          color: color.text,
                          fontSize: font.base,
                          outline: "none",
                          width: "100%",
                          boxSizing: "border-box",
                        }}
                      />
                      {finalDest.value.trim() && !finalDest.selected && (
                        <span style={{ fontSize: font.xs, color: color.error }}>
                          Select a location from the list.
                        </span>
                      )}
                    </div>
                  )}

                  <p style={{ fontSize: font.xs, color: color.muted, margin: 0, lineHeight: 1.5 }}>
                    The whole load is split across your fleet of{" "}
                    <strong>
                      {fleetVanCount} van{fleetVanCount !== 1 ? "s" : ""}
                    </strong>
                    , and every van drives the same route. The run is <strong>one-way</strong> — it ends at
                    your chosen final stop and does not return to the pickup.
                  </p>
                </div>
              )}

              {/* Dedicated (single/multi) runs can optionally cross-dock through a hub (3PL). */}
              {isDeliveryMode && <ViaHubPicker onChange={setViaHubAddress} />}

              {quoteMode === "groupage" ? (
                <GroupagePanel
                  embedded
                  prefill={groupagePrefill}
                  handoff={groupageHandoff}
                  unplaced={packResult?.unplaced ?? []}
                  items={packResult?.items ?? []}
                  palletMaxHeightM={palletMaxHeightM}
                  uploadedDocument={result?.document ?? null}
                  onOpenHubs={openHubs}
                  onBooked={() => setShipmentsRefresh((n) => n + 1)}
                />
              ) : quoteMode === "collection" ? (
                <CollectionRunPanel embedded prefillPickups={collectPickups} fleetVanId={fleetVanId} onSendHubToHub={sendCollectionHubToHub} stopPalletsSlot={collectionPalletsSlot} />
              ) : quoteMode === "single" ? (
                <button
                  type="button"
                  disabled={quoting || !originSelected || !destinationSelected}
                  onClick={() => void runQuote()}
                  style={buttonPrimary(quoting || !originSelected || !destinationSelected)}
                >
                  {quoting ? "Calculating…" : "Get Quote"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={quoting || !originSelected || !dropsReady || !finalDestReady}
                  onClick={() => void runChainQuote()}
                  style={buttonPrimary(quoting || !originSelected || !dropsReady || !finalDestReady)}
                >
                  {quoting ? "Calculating…" : "Get Multi-Stop Quote"}
                </button>
              )}

              {quoteError && (
                <ErrorBanner style={{ fontSize: font.sm, borderRadius: radius.card - 4, padding: `${spacing.sm}px ${spacing.md}px` }}>
                  {quoteError}
                </ErrorBanner>
              )}

              {quoteWarnings.length > 0 && (
                <div
                  role="status"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: spacing.xs,
                    fontSize: font.sm,
                    color: color.review.fg,
                    background: color.review.bg,
                    border: `1px solid ${color.review.border}`,
                    borderRadius: radius.card - 4,
                    padding: `${spacing.sm}px ${spacing.md}px`,
                  }}
                >
                  {quoteWarnings.map((w, i) => (
                    <span key={i}>⚠️ {w}</span>
                  ))}
                </div>
              )}

              {/* Router-picked order — shown only when it actually differs from the typed order. */}
              {quoteMode === "multi" &&
                visitOrder &&
                visitOrder.some((d, i) => d !== i) && (
                  <p
                    style={{
                      fontSize: font.sm,
                      color: color.accentDark,
                      background: color.accentMuted,
                      border: `1px solid ${color.accentBorder}`,
                      borderRadius: radius.card - 4,
                      padding: `${spacing.sm}px ${spacing.md}px`,
                      margin: 0,
                    }}
                  >
                    Best order for the shortest drive:{" "}
                    <strong>{visitOrder.map((d) => `Drop ${d + 1}`).join(" → ")}</strong>
                  </p>
                )}

              {quoteResult?.quote && <QuotePanel quote={quoteResult.quote} />}
            </div>
          )}

          {/* What-if cost planner — only once a quote exists, and anchored to THIS
              load so it only offers vehicles that can actually carry it. */}
          {quoteResult?.quote && quotedLoad && (
            <FleetCostExplorer
              load={quotedLoad}
              tripMiles={quoteResult.quote.route.distanceMiles}
              recommended={quoteResult.quote.vans.map((v) => v.id)}
            />
          )}
        </main>
      </div>
    </>
  );
}

export default function Home() {
  return (
    <VanSessionProvider>
      <HomeContent />
    </VanSessionProvider>
  );
}

/* ── Local sub-components ────────────────────────────────────────────── */

/**
 * Surfaces the decision matrix's read of the quotation: which mode it suggests and
 * WHY, in plain language. Always visible when a plan exists (a "never guess" surface,
 * not a silent auto-route). When it suggests sharing a truck it offers a hand-off to
 * the Groupage flow, and is honest that that flow still needs pallet details by hand.
 */
function ModeRecommendationBanner({
  rec,
  groupageActive,
  onUseGroupage,
}: {
  rec: ModeRecommendation;
  /** True when the shared-truck form is already on screen — the hand-off button hides. */
  groupageActive: boolean;
  onUseGroupage: () => void;
}) {
  const headline = rec.hubs
    ? "Share a truck (Groupage)"
    : rec.multiStop
      ? "Multi-stop dedicated van"
      : "Single dedicated van";
  return (
    <div
      role="status"
      aria-label="Recommended approach"
      style={{
        background: color.accentMuted,
        border: `1px solid ${color.accentBorder}`,
        borderRadius: radius.card - 4,
        padding: spacing.md,
        display: "flex",
        flexDirection: "column",
        gap: spacing.sm,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: spacing.sm, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: font.xs,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            color: color.accentDark,
          }}
        >
          {rec.confidence === "low" ? "Preliminary read" : "Recommended"}
        </span>
        <span style={{ fontSize: font.base, fontWeight: 700, color: color.text }}>{headline}</span>
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
        {rec.reasons.map((r, i) => (
          <li key={i} style={{ fontSize: font.sm, color: color.muted, lineHeight: 1.5 }}>
            {r}
          </li>
        ))}
      </ul>
      {rec.hubs && !groupageActive && (
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
          <button
            type="button"
            onClick={onUseGroupage}
            style={{
              alignSelf: "flex-start",
              padding: "7px 14px",
              borderRadius: radius.button,
              border: `1px solid ${color.accent}`,
              background: color.surface,
              color: color.accentDark,
              fontSize: font.sm,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Quote as shared truck →
          </button>
          <span style={{ fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
            Your postcodes carry over automatically; the pallet details still need entering by hand —
            reading them straight from the PDF is a later step.
          </span>
        </div>
      )}
    </div>
  );
}

function StatBox({
  label,
  value,
  accent,
  accentColor,
  accentBg,
}: {
  label: string;
  value: string;
  accent: boolean;
  accentColor?: string;
  accentBg?: string;
}) {
  return (
    <div
      style={{
        background: accent && accentBg ? accentBg : color.surfaceSub,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card - 4,
        padding: `${spacing.sm + 2}px ${spacing.md}px`,
      }}
    >
      <div
        style={{
          fontSize: font.xl - 4,
          fontWeight: 700,
          color: accent && accentColor ? accentColor : color.text,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: font.xs,
          color: color.muted,
          marginTop: spacing.xs,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function SkeletonRow({ width }: { width: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        height: 14,
        borderRadius: 4,
        width,
        background: color.border,
        animation: "shimmer 1.4s ease-in-out infinite",
      }}
    />
  );
}
