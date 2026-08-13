"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Van3DViewer } from "@/components/results/Van3DViewer";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { cssVar } from "@/components/results/van-3d/theme";
import { color, companyPalette, font, radius, spacing } from "@/styles/tokens";
import type { Placement, SessionHub } from "@/types/api";
import type { GroupagePallet, PalletFootprintClass } from "@/lib/groupage/groupage.types";
import type { GroupageConsignmentRecord } from "@/lib/groupage/consignment.store";
import type { PlannedTruck } from "@/lib/groupage/stack-service";
import type { StructuredDocument } from "@/lib/conversion/types";
import type { ConsignmentReviewField, ReadConsignmentDraft } from "@/lib/groupage/consignment-reader.types";
import { FOOTPRINT_META_LIST } from "@/lib/groupage/footprint-meta";
import {
  companyKeyOf,
  consignmentKey,
  draftClean,
  draftReady,
  draftToConsignment,
  emptyLine,
  linesToPallets,
  recordToConsignment,
  rosterToDrafts,
  type ConsignmentDraft,
  type PalletLine,
  type ReadDraft,
} from "@/lib/groupage/consignment-draft";
import { PalletTallyBar } from "@/components/groupage/PalletTallyBar";
import { GroupageJourneyMaps } from "@/components/groupage/GroupageJourneyMaps";
import { GroupageBilling } from "@/components/groupage/GroupageBilling";
import { useCompanyBills } from "@/components/groupage/useCompanyBills";
import { StepSection } from "@/components/groupage/StepSection";
import { RecentQuoteCard } from "@/components/groupage/RecentQuoteCard";
import { readPanelSnapshot, PANEL_SNAPSHOT_KEYS } from "@/lib/session-cache/panel-snapshots";

/**
 * Shared-Truck Planner — the quote-level 3D load plan. The operator gathers several consignments
 * (each = one company's quote detail), the server groups the ones that can share a vehicle and
 * auto-packs their pallets, and each shared truck renders as a 3D stack COLOURED BY COMPANY so the
 * person loading it can see whose pallet goes where. It reuses the whole-van `Van3DViewer` (drag to
 * adjust the suggested layout comes for free) and the same packing engine — no second 3D system.
 *
 * Three ways to gather consignments, fastest first:
 *   1. READ A DOCUMENT — drop a combined manifest (or reuse the one already uploaded) and let the
 *      reader lift a ROSTER of companies off it. Every read is a SUGGESTION: fields the reader
 *      wasn't sure of are flagged, and nothing lands on a truck until the operator confirms it.
 *   2. TICK A RECENT QUOTE — pick from quotes already priced with a company name.
 *   3. TYPE ONE IN — the manual form, for phone-ins / not-yet-quoted work.
 *
 * There are no "bookings" here: the detail lives in the quotes the operator assembles on this
 * screen. Over-capacity trucks and pallets that don't fit are surfaced, never silently split.
 */

/** Wire shape the /api/groupage/stack route accepts for `sessionHubs` — exactly these 4 fields. */
const toWireHub = (h: SessionHub): { id: string; name: string; catchment: string[]; address?: string } => ({
  id: h.id,
  name: h.name,
  catchment: h.catchment,
  ...(h.address ? { address: h.address } : {}),
});

/** Fills a BLANK origin/destination postcode from the manifest's own session hubs (collection hub
 *  → origin, destination hub → destination) — never overwrites a value the reader/operator gave. */
const prefillFromSessionHubs = (drafts: ReadDraft[], sessionHubs: SessionHub[]): ReadDraft[] => {
  const collectionHub = sessionHubs.find((h) => h.role === "collection" && h.postcode);
  const destinationHub = sessionHubs.find((h) => h.role === "destination" && h.postcode);
  if (!collectionHub && !destinationHub) return drafts;
  return drafts.map((d) => ({
    ...d,
    originPostcode: d.originPostcode.trim() === "" && collectionHub ? collectionHub.postcode! : d.originPostcode,
    destinationPostcode:
      d.destinationPostcode.trim() === "" && destinationHub ? destinationHub.postcode! : d.destinationPostcode,
  }));
};

export function TruckStackPlanner({
  seed,
  reloadSignal,
  uploadedDocument,
  onOpenHubs,
}: {
  /** Prefill the add-consignment form from the live quote (company + postcodes + pallet lines). */
  seed?: { company?: string; originPostcode?: string; destinationPostcode?: string; pallets?: GroupagePallet[] };
  /** Changes each time the section is opened — triggers a re-fetch of recent quotes. */
  reloadSignal?: number;
  /** The manifest already ingested at the start of the quote flow — powers the "use the document
   *  I already uploaded" shortcut (no re-upload, no re-OCR). Null when nothing was ingested. */
  uploadedDocument?: StructuredDocument | null;
  /** Lets a "no hub covers area X" plan error offer a one-click jump to the Add-hub form,
   *  seeded with the uncovered area. Undefined ⇒ the error shows without the shortcut. */
  onOpenHubs?: (prefill?: { catchment?: string[]; address?: string }) => void;
} = {}) {
  const [company, setCompany] = useState("");
  const [originPostcode, setOriginPostcode] = useState("");
  const [destinationPostcode, setDestinationPostcode] = useState("");
  const [lines, setLines] = useState<PalletLine[]>([emptyLine()]);
  const [consignments, setConsignments] = useState<ConsignmentDraft[]>([]);
  const [trucks, setTrucks] = useState<PlannedTruck[] | null>(null);
  /** Per-truck live placements (edited by dragging), keyed by legKey; falls back to the packed layout. */
  const [edited, setEdited] = useState<Record<string, Placement[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remembered quotes the operator can tick to add, instead of re-typing. Loaded from
  // GET /api/groupage/consignments on open (bumped via reloadSignal).
  const [recent, setRecent] = useState<GroupageConsignmentRecord[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  // ── Fast path: read a company roster off a document ──
  const [readDrafts, setReadDrafts] = useState<ReadDraft[]>([]);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [readNotice, setReadNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Guards the auto-read-on-mount below so it fires once, not on every render/re-mount of this effect.
  const autoReadRan = useRef(false);

  // Hubs read off the uploaded manifest for THIS session — layered over the saved network as
  // `sessionHubs` on the plan request, and used to prefill blank hub postcodes in read drafts below.
  const [sessionHubs] = useState<SessionHub[]>(
    () => readPanelSnapshot<SessionHub[]>(PANEL_SNAPSHOT_KEYS.manifestHubs) ?? [],
  );

  // Explicit-pricing gate: billing (and the per-leg breakdowns) only compute once the operator asks
  // for a quote, never against freshly-added / auto-loaded consignments. Reset by invalidatePlan on
  // any consignment edit, so a changed load must be re-priced (mirrors the trucks/previews reset).
  const [pricingRequested, setPricingRequested] = useState(false);

  // Priced ONCE here so the per-leg breakdown next to each journey map and the final per-company
  // total (below) always agree — neither component re-quotes on its own. Gated on `pricingRequested`.
  const { bills, loading: billsLoading } = useCompanyBills(consignments, sessionHubs, pricingRequested);

  // ── Per-consignment 3D preview (Task 4) — the authoritative server packer, one company at a time.
  const [previewOpen, setPreviewOpen] = useState<Set<number>>(new Set());
  const [previews, setPreviews] = useState<Record<number, PlannedTruck | null>>({});

  // Fetch recent quotes on mount and whenever the section is (re)opened. Fail-soft: an empty or
  // failed load just shows the manual form — never blocks planning.
  useEffect(() => {
    let cancelled = false;
    setRecentLoading(true);
    fetch("/api/groupage/consignments")
      .then((r) => r.json() as Promise<{ consignments?: GroupageConsignmentRecord[] }>)
      .then((d) => { if (!cancelled) setRecent(Array.isArray(d.consignments) ? d.consignments : []); })
      .catch(() => { if (!cancelled) setRecent([]); })
      .finally(() => { if (!cancelled) setRecentLoading(false); });
    return () => { cancelled = true; };
  }, [reloadSignal]);

  // Any change to the consignment list invalidates the plan AND the per-consignment previews
  // (their indices would otherwise point at the wrong company).
  const invalidatePlan = () => {
    setTrucks(null);
    setPreviews({});
    setPreviewOpen(new Set());
    // A changed load must be re-confirmed before it's re-priced — otherwise stale billing lingers.
    setPricingRequested(false);
  };

  const toggleTick = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const addTicked = () => {
    const picked = recent.filter((r) => ticked.has(r.id)).map(recordToConsignment);
    if (picked.length === 0) return;
    setConsignments((prev) => [...prev, ...picked]);
    setTicked(new Set());
    invalidatePlan();
  };

  // Resolve the CSS-var company palette to concrete colours once (three.js needs real values).
  const palette = useMemo(() => companyPalette.map((v) => cssVar(v)), []);
  const colorForIndex = (i: number) => palette[i % palette.length]!;

  // Group the added consignments by company so a firm shipping from more than one collection point
  // shows as ONE entry (one colour) with its pickups nested, instead of repeated same-name rows.
  const companyGroups = useMemo(() => {
    const order: string[] = [];
    const byId = new Map<string, { label: string; rows: { c: ConsignmentDraft; index: number }[] }>();
    consignments.forEach((c, index) => {
      const id = c.company.trim().toLowerCase();
      let g = byId.get(id);
      if (!g) { g = { label: c.company.trim(), rows: [] }; byId.set(id, g); order.push(id); }
      g.rows.push({ c, index });
    });
    return order.map((id) => byId.get(id)!);
  }, [consignments]);
  const palletsIn = (rows: { c: ConsignmentDraft }[]) =>
    rows.reduce((n, { c }) => n + c.pallets.reduce((s, p) => s + p.quantity, 0), 0);

  const useSeed = () => {
    if (seed?.company) setCompany(seed.company);
    if (seed?.originPostcode) setOriginPostcode(seed.originPostcode);
    if (seed?.destinationPostcode) setDestinationPostcode(seed.destinationPostcode);
    if (seed?.pallets && seed.pallets.length > 0) {
      setLines(seed.pallets.map((p) => ({ footprint: p.footprint, weightKg: String(p.weightKg), quantity: String(p.quantity) })));
    }
  };

  const addConsignment = () => {
    setError(null);
    const pallets = linesToPallets(lines);
    if (company.trim() === "" || originPostcode.trim() === "" || destinationPostcode.trim() === "" || pallets.length === 0) {
      setError("A consignment needs a company, both postcodes, and at least one pallet line with a weight.");
      return;
    }
    setConsignments((prev) => [
      ...prev,
      { company: company.trim(), originPostcode: originPostcode.trim(), destinationPostcode: destinationPostcode.trim(), pallets },
    ]);
    setCompany("");
    setLines([emptyLine()]);
    invalidatePlan();
  };

  const removeConsignment = (i: number) => {
    setConsignments((prev) => prev.filter((_, j) => j !== i));
    invalidatePlan();
  };

  // ── Read a document into drafts ──
  const applyRoster = (data: {
    success?: boolean;
    consignments?: ReadConsignmentDraft[];
    error?: string;
    hubCollapse?: { collapsed?: boolean; reasons?: string[] };
  }) => {
    if (!data.success || !Array.isArray(data.consignments)) {
      setReadError(data.error ?? "Couldn't read that document.");
      return;
    }
    const drafts = rosterToDrafts(data.consignments);
    if (drafts.length === 0) {
      setReadNotice("No companies could be read from that document — tick a recent quote or add one manually below.");
      return;
    }
    // Hub-consolidation manifest: the reader saw both the collection and delivery legs
    // (the same load twice) and the server collapsed them to the single trunk load.
    // Show WHY so the operator isn't surprised by one "Consolidated trunk load" row.
    if (data.hubCollapse?.collapsed && data.hubCollapse.reasons?.length) {
      setReadNotice(data.hubCollapse.reasons.join(" "));
    }
    // A collapsed "Consolidated trunk load" draft carries BLANK origin/destination postcodes —
    // fill them (blanks only) from the manifest's own session hubs so draftReady can pass.
    const prepared = prefillFromSessionHubs(drafts, sessionHubs);

    // Auto-surface the 3D plan: drafts the reader was fully confident about (draftClean) go
    // straight onto the truck and we plan immediately, so an uploaded multi-company manifest
    // shows its packed shared-truck 3D + fit without any manual click. Anything the reader
    // flagged stays below for the operator to confirm (never-guess is preserved).
    const clean = prepared.filter(draftClean);
    const keep = prepared.filter((d) => !draftClean(d));
    if (keep.length > 0) setReadDrafts((prev) => [...prev, ...keep]);
    if (clean.length > 0) {
      // De-dupe against what's already on the truck: reading the SAME manifest twice (the mount
      // auto-read plus a manual "use the uploaded document", or a re-upload of the same file) must
      // not pile the same companies up — that repeated the map pins and doubled the billing total.
      const seen = new Set(consignments.map(consignmentKey));
      const added = clean.map(draftToConsignment).filter((c) => {
        const k = consignmentKey(c);
        if (seen.has(k)) return false;
        seen.add(k); // also collapse duplicates within a single read
        return true;
      });
      if (added.length > 0) {
        // Plan with the concrete combined array (not the async `consignments` state) to avoid a
        // stale-closure empty plan.
        const nextConsignments = [...consignments, ...added];
        setConsignments(nextConsignments);
        invalidatePlan();
        void plan(nextConsignments);
      }
    }
  };

  const readFromFile = async (file: File) => {
    setReading(true); setReadError(null); setReadNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/groupage/consignments/read", { method: "POST", body: form });
      applyRoster(await res.json());
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "Failed to read the document.");
    } finally {
      setReading(false);
    }
  };

  const readFromUploaded = async () => {
    if (!uploadedDocument) return;
    setReading(true); setReadError(null); setReadNotice(null);
    try {
      const res = await fetch("/api/groupage/consignments/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: uploadedDocument }),
      });
      applyRoster(await res.json());
    } catch (e) {
      setReadError(e instanceof Error ? e.message : "Failed to read the uploaded document.");
    } finally {
      setReading(false);
    }
  };

  // Auto-surface the roster: when a document was already ingested at the start of the quote flow,
  // read it into drafts on mount rather than waiting for a manual "use this document" click — this
  // is what lets a hub-consolidation manifest's collapsed trunk load reach the 3D plan unattended.
  // Guarded by a ref (not state) so it fires exactly once even if this effect re-runs.
  useEffect(() => {
    if (autoReadRan.current || !uploadedDocument) return;
    autoReadRan.current = true;
    void readFromUploaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedDocument]);

  const updateDraft = (i: number, patch: Partial<ReadDraft>) =>
    setReadDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const discardDraft = (i: number) => setReadDrafts((prev) => prev.filter((_, j) => j !== i));

  const addDraft = (i: number) => {
    const d = readDrafts[i];
    if (!d || !draftReady(d)) return;
    setConsignments((prev) => [...prev, draftToConsignment(d)]);
    discardDraft(i);
    invalidatePlan();
  };

  // Bulk-add every READY draft (company + both postcodes + ≥1 weighed line). Gating this on
  // draftClean instead would make the button dead: clean drafts are already auto-added on read
  // (see readFrom*), so everything left in the confirm list is flagged by definition. Flagged
  // drafts ARE swept in here — but only because the operator is looking at the ⚠ list and chose
  // to; a draft missing a weight still can't come in, because draftReady refuses it.
  const addAllReadyDrafts = () => {
    const ready = readDrafts.filter(draftReady);
    if (ready.length === 0) return;
    setConsignments((prev) => [...prev, ...ready.map(draftToConsignment)]);
    setReadDrafts((prev) => prev.filter((d) => !draftReady(d)));
    invalidatePlan();
  };

  const plan = async (list: ConsignmentDraft[] = consignments) => {
    if (list.length === 0) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/groupage/stack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consignments: list, sessionHubs: sessionHubs.map(toWireHub) }),
      });
      const data = (await res.json()) as
        | { success: true; trucks: PlannedTruck[] }
        | { success: false; error: string };
      if (data.success) {
        setTrucks(data.trucks);
        setEdited({});
      } else {
        setError(data.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to plan the shared truck.");
    } finally {
      setLoading(false);
    }
  };

  // Model ONE consignment in 3D on its own truck, using the same server packer as the full plan
  // (no faked client-side geometry). Lazy: fetched the first time its preview is opened.
  const togglePreview = async (i: number) => {
    const open = new Set(previewOpen);
    if (open.has(i)) {
      open.delete(i);
      setPreviewOpen(open);
      return;
    }
    open.add(i);
    setPreviewOpen(open);
    if (previews[i] !== undefined) return; // already fetched
    try {
      const res = await fetch("/api/groupage/stack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consignments: [consignments[i]], sessionHubs: sessionHubs.map(toWireHub) }),
      });
      const data = (await res.json()) as
        | { success: true; trucks: PlannedTruck[] }
        | { success: false; error: string };
      setPreviews((prev) => ({ ...prev, [i]: data.success && data.trucks[0] ? data.trucks[0] : null }));
    } catch {
      setPreviews((prev) => ({ ...prev, [i]: null }));
    }
  };

  // Drafts the operator CAN bulk-add, and how many of those still carry a ⚠ (named in the button so
  // "add all" never quietly sweeps in a guess the operator didn't know was a guess).
  const readyDraftCount = readDrafts.filter(draftReady).length;
  const flaggedReadyCount = readDrafts.filter((d) => draftReady(d) && !draftClean(d)).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>
      <StepSection
        step={2}
        title="Load the truck (3D)"
        subtitle="Gather what's on the truck — read a document, tick a recent quote, or add one by hand — then plan it and see the pooled vehicle loaded, coloured by company."
      />

      {/* ── Gather consignments: read a document (primary, wide) beside recent quotes (secondary,
          narrow). One responsive row so the two fastest inputs read as a pair; collapses to stacked
          on narrow screens (.groupage-input-cols). The read-drafts confirm list renders full-width
          BELOW this row — it only appears after a read and needs the width. ── */}
      <div className="groupage-input-cols">
      {/* ── Fast path: read a document (the least manual way) ── */}
      <div style={{ border: `1px solid ${color.border}`, borderRadius: radius.input, padding: spacing.md, display: "flex", flexDirection: "column", gap: 8 }}>
        <p style={{ ...fieldGroupLabel, margin: 0 }}>Read companies from a document</p>
        <p style={{ fontSize: font.xs, color: color.muted, margin: 0, lineHeight: 1.5 }}>
          Drop a combined manifest or a single quote. What the reader finds lands below as drafts to confirm.
        </p>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void readFromFile(f);
          }}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}
          style={{
            border: `1.5px dashed ${dragOver ? color.accent : color.border}`,
            borderRadius: radius.input,
            padding: `${spacing.md}px`,
            textAlign: "center",
            cursor: "pointer",
            background: dragOver ? color.surfaceSub : "transparent",
            color: color.muted,
            fontSize: font.sm,
          }}
        >
          {reading ? "Reading the document…" : "Drop a PDF here, or click to choose one"}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFromFile(f);
            e.target.value = ""; // let the same file be chosen again
          }}
        />

        {uploadedDocument && (
          <button
            type="button"
            onClick={readFromUploaded}
            disabled={reading}
            style={{ ...secondaryBtn, alignSelf: "flex-start", opacity: reading ? 0.6 : 1, cursor: reading ? "not-allowed" : "pointer" }}
          >
            Use the document I already uploaded
          </button>
        )}

        {readError && <ErrorBanner>{readError}</ErrorBanner>}
        {readNotice && (
          <p style={{ fontSize: font.xs, color: color.review.fg, background: color.review.bg, border: `1px solid ${color.review.border}`, borderRadius: radius.input, padding: "8px 10px", margin: 0 }}>
            {readNotice}
          </p>
        )}
      </div>

      {/* ── Add from recent quotes (narrow right column beside the document drop) ── */}
      <details style={{ border: `1px solid ${color.border}`, borderRadius: radius.input, padding: spacing.md }}>
        <summary style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, cursor: "pointer", listStyle: "revert" }}>
          <span style={{ ...fieldGroupLabel }}>
            Add from recent quotes{recent.length > 0 ? ` (${recent.length})` : ""}
          </span>
          {recentLoading && <span style={{ fontSize: font.xs, color: color.muted }}>Loading…</span>}
        </summary>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {recent.length === 0 ? (
            <p style={{ fontSize: font.xs, color: color.muted, margin: 0 }}>
              {recentLoading
                ? "Looking for remembered quotes…"
                : "No remembered quotes yet — price a groupage quote (with a company name) and it'll appear here to pick."}
            </p>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                {recent.map((r) => (
                  <RecentQuoteCard key={r.id} record={r} checked={ticked.has(r.id)} onToggle={() => toggleTick(r.id)} />
                ))}
              </div>
              <button
                type="button"
                onClick={addTicked}
                disabled={ticked.size === 0}
                style={{ ...primaryBtn, alignSelf: "flex-start", opacity: ticked.size === 0 ? 0.6 : 1, cursor: ticked.size === 0 ? "not-allowed" : "pointer" }}
              >
                Add ticked{ticked.size > 0 ? ` (${ticked.size})` : ""}
              </button>
            </>
          )}
        </div>
      </details>
      </div>

      {/* ── Read drafts awaiting confirmation (never-guess surface). Full-width below the input row —
          it appears only after a read and needs the room. ── */}
      {readDrafts.length > 0 && (
        <div style={{ border: `1px solid ${color.review.border}`, background: color.review.bg, borderRadius: radius.input, padding: spacing.md, display: "flex", flexDirection: "column", gap: spacing.sm }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <p style={{ ...fieldGroupLabel, margin: 0, color: color.review.fg }}>
              Read from the document — please confirm ({readDrafts.length})
            </p>
            {readyDraftCount > 0 && (
              <button
                type="button"
                onClick={addAllReadyDrafts}
                title={
                  flaggedReadyCount > 0
                    ? `Adds all ${readyDraftCount} — including ${flaggedReadyCount} with a ⚠ the reader wasn’t sure of. Drafts still missing a weight stay here.`
                    : `Adds all ${readyDraftCount}. Drafts still missing a weight stay here.`
                }
                style={{ ...primaryBtn }}
              >
                Add all {readyDraftCount} to truck{flaggedReadyCount > 0 ? ` (${flaggedReadyCount} ⚠)` : ""}
              </button>
            )}
          </div>
          <p style={{ fontSize: font.xs, color: color.review.fg, margin: 0, lineHeight: 1.5 }}>
            A ⚠ marks a field the reader wasn&apos;t sure of — check it before adding. Blank weights were left
            for you to fill (the reader won&apos;t invent a weight).
          </p>
          {readDrafts.map((d, i) => (
            <ReadDraftCard
              key={i}
              draft={d}
              onChange={(patch) => updateDraft(i, patch)}
              onAdd={() => addDraft(i)}
              onDiscard={() => discardDraft(i)}
            />
          ))}
        </div>
      )}

      {/* ── Or add a consignment manually (phone-ins / not-yet-quoted) ── */}
      <p style={{ ...fieldGroupLabel, margin: 0 }}>Or add one manually</p>
      <div style={{ border: `1px solid ${color.border}`, borderRadius: radius.input, padding: spacing.md, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <label style={labelWrap}>
            <span style={labelText}>Company</span>
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Acme Ltd" style={inputStyle} />
          </label>
          <label style={labelWrap}>
            <span style={labelText}>Origin postcode</span>
            <input value={originPostcode} onChange={(e) => setOriginPostcode(e.target.value)} placeholder="e.g. CV1 2AB" style={inputStyle} />
          </label>
          <label style={labelWrap}>
            <span style={labelText}>Destination postcode</span>
            <input value={destinationPostcode} onChange={(e) => setDestinationPostcode(e.target.value)} placeholder="e.g. EH1 1AA" style={inputStyle} />
          </label>
        </div>

        <p style={fieldGroupLabel}>Pallet lines</p>
        <PalletLinesEditor lines={lines} onChange={setLines} />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {seed && (seed.originPostcode || seed.pallets?.length) ? (
            <button type="button" onClick={useSeed} style={secondaryBtn}>Use current quote details</button>
          ) : null}
          <button type="button" onClick={addConsignment} style={primaryBtn}>Add consignment</button>
        </div>
      </div>

      {/* ── Consignment list, grouped by company (one firm may have several collection points) ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <p style={{ ...fieldGroupLabel, margin: 0 }}>
          On this truck ({companyGroups.length} {companyGroups.length === 1 ? "company" : "companies"}
          {consignments.length !== companyGroups.length ? `, ${consignments.length} pickups` : ""})
        </p>
        {consignments.length === 0 ? (
          <p style={{ fontSize: font.xs, color: color.muted, margin: 0, border: `1px dashed ${color.border}`, borderRadius: radius.input, padding: "10px 12px" }}>
            No companies added yet. Add two or more heading the same way and they&apos;ll share a truck.
          </p>
        ) : (
          companyGroups.map((g, gi) => {
            const single = g.rows.length === 1;
            return (
              <div key={`${g.label}-${gi}`} style={{ display: "flex", flexDirection: "column", gap: 6, background: color.surfaceSub, border: `1px solid ${color.border}`, borderRadius: radius.input, padding: "8px 10px" }}>
                {/* Company header — one colour, one name, even across multiple collection points */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: font.sm, color: color.text }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: companyPalette[gi % companyPalette.length], flex: "0 0 auto" }} />
                  <strong>{g.label}</strong>
                  {!single && (
                    <span style={{ color: color.muted, fontSize: font.xs }}>{g.rows.length} collection points</span>
                  )}
                  <span style={{ color: color.muted, marginLeft: "auto" }}>{palletsIn(g.rows)} pallets</span>
                </div>
                {/* One row per pickup: route + pallets + preview/remove */}
                {g.rows.map(({ c, index }) => (
                  <div key={index} style={single ? undefined : { borderTop: `1px solid ${color.border}`, paddingTop: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: font.xs, color: color.muted }}>
                      <span>{c.originPostcode} → {c.destinationPostcode}</span>
                      <span style={{ marginLeft: "auto" }}>{c.pallets.reduce((n, p) => n + p.quantity, 0)} pallets</span>
                      <button type="button" onClick={() => togglePreview(index)} style={{ ...secondaryBtn, padding: "4px 8px" }}>
                        {previewOpen.has(index) ? "Hide 3D" : "Preview in 3D"}
                      </button>
                      <button type="button" onClick={() => removeConsignment(index)} style={{ ...secondaryBtn, padding: "4px 8px" }}>Remove</button>
                    </div>
                    {previewOpen.has(index) && (
                      <div style={{ marginTop: 6 }}>
                        <ConsignmentPreview
                          truck={previews[index]}
                          loading={previews[index] === undefined}
                          company={c.company}
                          colour={colorForIndex(gi)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })
        )}
        {consignments.length > 0 && (
          <button
            type="button"
            onClick={() => plan()}
            disabled={loading}
            style={{ ...primaryBtn, alignSelf: "flex-start", opacity: loading ? 0.6 : 1, cursor: loading ? "not-allowed" : "pointer" }}
          >
            {loading ? "Planning…" : "Plan shared trucks"}
          </button>
        )}
      </div>

      {error && (
        <ErrorBanner
          action={onOpenHubs && (() => {
            // A "no hub covers area X" plan error names the uncovered area — offer a one-click jump to
            // an Add-hub form already seeded with it, so the operator fixes the gap without hunting.
            const missingArea = error.match(/postcode area "([A-Z]{1,2})"/)?.[1];
            if (!missingArea) return null;
            return (
              <button
                type="button"
                onClick={() => onOpenHubs({ catchment: [missingArea] })}
                style={{ display: "block", marginTop: 6, border: "none", background: "none", padding: 0, color: color.error, fontSize: font.xs, fontWeight: 600, textDecoration: "underline", cursor: "pointer" }}
              >
                Create a hub covering {missingArea} →
              </button>
            );
          })()}
        >
          {error}
        </ErrorBanner>
      )}

      {/* ── Trunk load 3D — the pooled vehicle, coloured by company (per-company stacks + legend
          live in TruckCard). This is the "pallets placed within the vehicle" view; the journey
          maps for that load follow in Step 3 below, so the screen reads load → then route. ── */}
      {trucks && trucks.length > 0 && (
        <p style={{ ...fieldGroupLabel, margin: 0 }}>Trunk load — how the shared van is packed (coloured by company)</p>
      )}
      {trucks && trucks.some((t) => t.splitCount > 1) && (
        <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          This load was too big for one vehicle, so it&apos;s been split across the fewest trucks that each fit
          (on both pallet-spaces and weight). Each truck below shows its own companies and load.
        </p>
      )}
      {trucks?.map((truck) => (
        <TruckCard
          key={truck.legKey}
          truck={truck}
          placements={edited[truck.legKey] ?? truck.stack?.placements ?? []}
          onPlacementsChange={(next) => setEdited((prev) => ({ ...prev, [truck.legKey]: next }))}
          colorForIndex={colorForIndex}
          companyKeyOf={companyKeyOf}
        />
      ))}

      {trucks && trucks.length === 0 && (
        <p style={{ fontSize: font.sm, color: color.muted }}>No shareable trucks — add consignments above.</p>
      )}

      {/* ── Step 3 · The two journeys — the collection round (pickups → hub) then the trunk (hub →
          hub), shown separately with a map each. Placed BELOW the trunk 3D so the flow reads
          load-the-truck → then-see-its-route. GroupageJourneyMaps returns null without a collection
          hub, so gate the whole step on one existing to avoid an empty heading. ── */}
      {consignments.length > 0 && sessionHubs.some((h) => h.role === "collection") && (
        <StepSection
          step={3}
          title="The two journeys"
          subtitle="The local collection round into the hub, then the hub-to-hub trunk — shown separately, each with its own map."
        >
          <GroupageJourneyMaps
            consignments={consignments.map((c) => ({ company: c.company, originPostcode: c.originPostcode }))}
            sessionHubs={sessionHubs}
            bills={bills}
            billingLoading={billsLoading}
          />
        </StepSection>
      )}

      {/* ── Get a Shared-Truck Quote — the final, explicit pricing step. Appears only once the load
          has actually been PLANNED (trucks exist), so it never sits under an unconfirmed truck. The
          operator clicks "Price it" to run the quote; until then nothing is priced (no premature
          £0.00 billing). Any consignment edit resets pricingRequested (invalidatePlan), so a changed
          load must be re-priced. Prices come from the SAME `useCompanyBills` call the per-leg
          breakdowns use, so every figure agrees. ── */}
      {trucks && trucks.length > 0 && (
        <StepSection
          title="Get a Shared-Truck Quote"
          subtitle="Price each company for its own pallet-spaces on the pooled truck — run this once the load above is settled."
        >
          {pricingRequested ? (
            <GroupageBilling bills={bills} loading={billsLoading} />
          ) : (
            <button
              type="button"
              onClick={() => setPricingRequested(true)}
              style={{ ...primaryBtn, alignSelf: "flex-start" }}
            >
              Price it
            </button>
          )}
        </StepSection>
      )}
    </div>
  );
}

/** Shared pallet-line editor — used by the manual form and each read draft (MRMR). */
function PalletLinesEditor({ lines, onChange }: { lines: PalletLine[]; onChange: (next: PalletLine[]) => void }) {
  const update = (i: number, patch: Partial<PalletLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const add = () => onChange([...lines, emptyLine()]);
  const remove = (i: number) => onChange(lines.length <= 1 ? lines : lines.filter((_, j) => j !== i));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr auto", gap: 8, alignItems: "end" }}>
          <label style={labelWrap}>
            <span style={labelText}>Pallet size</span>
            <select value={line.footprint} onChange={(e) => update(i, { footprint: e.target.value as PalletFootprintClass })} style={inputStyle}>
              {FOOTPRINT_META_LIST.map((m) => (
                <option key={m.footprint} value={m.footprint}>{m.optionLabel}</option>
              ))}
            </select>
          </label>
          <label style={labelWrap}>
            <span style={labelText}>Weight per pallet (kg)</span>
            <input type="number" min="0" value={line.weightKg} onChange={(e) => update(i, { weightKg: e.target.value })} placeholder="e.g. 250" style={inputStyle} />
          </label>
          <label style={labelWrap}>
            <span style={labelText}>How many</span>
            <input type="number" min="1" value={line.quantity} onChange={(e) => update(i, { quantity: e.target.value })} placeholder="e.g. 1" style={inputStyle} />
          </label>
          <button type="button" onClick={() => remove(i)} disabled={lines.length <= 1} style={{ ...secondaryBtn, padding: "6px 10px" }}>Remove</button>
        </div>
      ))}
      <PalletTallyBar lines={lines} />
      <button type="button" onClick={add} style={{ ...secondaryBtn, alignSelf: "flex-start" }}>Add pallet line</button>
    </div>
  );
}

/** One read draft, editable, with a ⚠ on each field the reader flagged. */
function ReadDraftCard({
  draft,
  onChange,
  onAdd,
  onDiscard,
}: {
  draft: ReadDraft;
  onChange: (patch: Partial<ReadDraft>) => void;
  onAdd: () => void;
  onDiscard: () => void;
}) {
  const flagged = (f: ConsignmentReviewField) => draft.review.includes(f);
  const ready = draftReady(draft);
  const flagStyle = (f: ConsignmentReviewField): React.CSSProperties =>
    flagged(f) ? { border: `1px solid ${color.review.border}`, background: color.review.bg } : {};
  const flagMark = (f: ConsignmentReviewField) => (flagged(f) ? <span title="The reader wasn't sure — check this" style={{ color: color.review.fg }}> ⚠</span> : null);

  return (
    <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.input, padding: spacing.md, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <label style={labelWrap}>
          <span style={labelText}>Company{flagMark("company")}</span>
          <input value={draft.company} onChange={(e) => onChange({ company: e.target.value })} placeholder="Company name" style={{ ...inputStyle, ...flagStyle("company") }} />
        </label>
        <label style={labelWrap}>
          <span style={labelText}>Origin postcode{flagMark("originPostcode")}</span>
          <input value={draft.originPostcode} onChange={(e) => onChange({ originPostcode: e.target.value })} placeholder="e.g. CV1 2AB" style={{ ...inputStyle, ...flagStyle("originPostcode") }} />
        </label>
        <label style={labelWrap}>
          <span style={labelText}>Destination postcode{flagMark("destinationPostcode")}</span>
          <input value={draft.destinationPostcode} onChange={(e) => onChange({ destinationPostcode: e.target.value })} placeholder="e.g. EH1 1AA" style={{ ...inputStyle, ...flagStyle("destinationPostcode") }} />
        </label>
      </div>
      <p style={{ ...fieldGroupLabel, margin: 0 }}>Pallet lines{flagMark("pallets")}</p>
      <PalletLinesEditor lines={draft.lines} onChange={(next) => onChange({ lines: next })} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={onAdd} disabled={!ready} style={{ ...primaryBtn, opacity: ready ? 1 : 0.6, cursor: ready ? "pointer" : "not-allowed" }}>
          Add to truck
        </button>
        <button type="button" onClick={onDiscard} style={secondaryBtn}>Discard</button>
        {!ready && (
          <span style={{ fontSize: font.xs, color: color.muted }}>
            Fill the company, both postcodes, and at least one pallet weight to add it.
          </span>
        )}
      </div>
    </div>
  );
}

/** A single consignment modelled in 3D on its own truck (server-packed, read-only). */
function ConsignmentPreview({
  truck,
  loading,
  company,
  colour,
}: {
  truck: PlannedTruck | null | undefined;
  loading: boolean;
  company: string;
  colour: string;
}) {
  if (loading) return <p style={{ fontSize: font.xs, color: color.muted, margin: 0 }}>Modelling in 3D…</p>;
  if (!truck) return <p style={{ fontSize: font.xs, color: color.muted, margin: 0 }}>Couldn&apos;t model these pallets in 3D.</p>;
  if (!truck.stack) {
    return (
      <p style={{ fontSize: font.xs, color: color.muted, margin: 0 }}>
        No vehicle is configured for the {truck.legKind} leg, so this can&apos;t be drawn. Set one in
        config/groupage-rates.json.
      </p>
    );
  }
  const placements = truck.stack.placements;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: font.xs, fontWeight: 600, color: truck.fits ? color.success : color.error }}>
        {truck.fits ? "Fits ✓" : "Over capacity"} · {truck.usedFootprints}/{truck.capacity.palletSpaces} spaces · {truck.usedWeightKg}/{truck.capacity.maxPayloadKg} kg
      </span>
      <Van3DViewer
        placements={placements}
        interior={truck.stack.interior}
        itemNames={placements.map(() => company)}
        groupColors={placements.map(() => colour)}
        heightPx={280}
        frameloop="demand"
        compact
        toleranceM={truck.toleranceM}
        maxReachHeightM={truck.maxReachHeightM ?? undefined}
      />
      {truck.stack.unplaced.length > 0 && (
        <ErrorBanner style={{ padding: "6px 10px" }}>
          <strong>Didn&apos;t fit this vehicle:</strong>{" "}
          {truck.stack.unplaced.map((u) => `${u.count} × ${u.footprint}`).join(", ")}. It&apos;ll need more than one run.
        </ErrorBanner>
      )}
    </div>
  );
}

/**
 * The decluttered read of a shared truck: one small 3D viewer PER company, each
 * showing only that company's pallets (in their real shared-truck positions), so a
 * multi-company load can be read company-by-company instead of as one tangled stack.
 * Reuses the already-packed shared placements — no extra pack call. Splitting by the
 * company key encoded in each placement's itemId keeps colours/labels stable.
 */
function PerCompanyStacks({
  truck,
  colorForIndex,
  companyKeyOf,
}: {
  truck: PlannedTruck;
  colorForIndex: (i: number) => string;
  companyKeyOf: (itemId: string) => string;
}) {
  if (!truck.stack) return null;
  const { interior, placements } = truck.stack;
  const byCompany = new Map<string, Placement[]>();
  for (const p of placements) {
    const key = companyKeyOf(p.itemId);
    const bucket = byCompany.get(key);
    if (bucket) bucket.push(p);
    else byCompany.set(key, [p]);
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: spacing.md }}>
      {truck.companies.map((c, i) => {
        const own = byCompany.get(c.key) ?? [];
        if (own.length === 0) return null;
        const colour = colorForIndex(i);
        return (
          <div key={c.key} style={{ border: `1px solid ${color.border}`, borderRadius: radius.input, padding: spacing.sm, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.xs, color: color.text }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: colour, flex: "0 0 auto" }} />
              <strong>{c.label}</strong>
              <span style={{ color: color.muted, marginLeft: "auto" }}>{own.length} pallet{own.length === 1 ? "" : "s"}</span>
            </div>
            {c.origins.length > 1 && (
              <span style={{ fontSize: font.xs, color: color.muted }}>Collecting from {c.origins.join(", ")}</span>
            )}
            <Van3DViewer
              placements={own}
              interior={interior}
              itemNames={own.map(() => c.label)}
              groupColors={own.map(() => colour)}
              heightPx={240}
              frameloop="demand"
              compact
              toleranceM={truck.toleranceM}
              maxReachHeightM={truck.maxReachHeightM ?? undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

function TruckCard({
  truck,
  placements,
  onPlacementsChange,
  colorForIndex,
  companyKeyOf,
}: {
  truck: PlannedTruck;
  placements: Placement[];
  onPlacementsChange: (next: Placement[]) => void;
  colorForIndex: (i: number) => string;
  companyKeyOf: (itemId: string) => string;
}) {
  const indexOfCompany = (key: string) => truck.companies.findIndex((c) => c.key === key);

  // With more companies than palette hues, colours cycle — company 9 looks like company 1.
  // When that happens we prefix an ordinal (#1, #9…) onto both the legend swatch and the 3D
  // hover label so a loader can always tell colour-twins apart and never load the wrong firm's
  // goods. Suppressed when there's no collision so the common case stays clean.
  const paletteWraps = truck.companies.length > companyPalette.length;
  const ordinalOf = (key: string) => {
    const idx = indexOfCompany(key);
    return paletteWraps && idx >= 0 ? `#${idx + 1} ` : "";
  };

  // Colour + label per placement, derived from the itemId so they stay correct after a drag.
  const groupColors = placements.map((p) => colorForIndex(Math.max(0, indexOfCompany(companyKeyOf(p.itemId)))));
  const itemNames = placements.map((p) => {
    const key = companyKeyOf(p.itemId);
    const c = truck.companies[indexOfCompany(key)];
    return `${ordinalOf(key)}${c ? c.label : key}`;
  });

  return (
    <div style={{ border: `1px solid ${color.border}`, borderRadius: radius.card, padding: spacing.md, display: "flex", flexDirection: "column", gap: spacing.sm }}>
      {/* Header: route + vehicle + fit */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: font.sm, color: color.text, textTransform: "capitalize" }}>{truck.legKind} · {truck.vanLabel ?? "no vehicle set"}</span>
          {truck.splitCount > 1 && (
            <span style={{ fontSize: font.xs, fontWeight: 600, color: color.accentDark, marginLeft: 6 }}>
              Truck {truck.splitIndex} of {truck.splitCount}
            </span>
          )}
          <span style={{ fontSize: font.xs, color: color.muted, marginLeft: 6 }}>{truck.from} → {truck.to}</span>
        </div>
        <span style={{ fontSize: font.xs, fontWeight: 600, color: truck.fits ? color.success : color.error }}>
          {truck.fits ? "Fits ✓" : "Over capacity"} · {truck.usedFootprints}/{truck.capacity.palletSpaces} spaces · {truck.usedWeightKg}/{truck.capacity.maxPayloadKg} kg
        </span>
      </div>

      {!truck.fits && truck.overBy && (
        <p role="alert" style={{ margin: 0, fontSize: font.xs, color: color.review.fg, background: color.review.bg, border: `1px solid ${color.review.border}`, borderRadius: radius.input, padding: "6px 10px" }}>
          This shared truck is over by {truck.overBy.footprints > 0 ? `${truck.overBy.footprints} pallet-space${truck.overBy.footprints === 1 ? "" : "s"}` : ""}
          {truck.overBy.footprints > 0 && truck.overBy.weightKg > 0 ? " and " : ""}
          {truck.overBy.weightKg > 0 ? `${truck.overBy.weightKg} kg` : ""}. Move a consignment to another run or use a bigger vehicle.
        </p>
      )}

      {/* Company legend — one swatch per company; multi-pickup firms note their collection points */}
      <div style={{ display: "flex", gap: spacing.md, flexWrap: "wrap" }}>
        {truck.companies.map((c, i) => (
          <span key={c.key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: font.xs, color: color.muted }}>
            <span
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 14, height: 14, borderRadius: 2,
                background: companyPalette[i % companyPalette.length],
                // On colour-collision the ordinal sits inside the swatch so two same-hued
                // firms are still distinguishable at a glance. On-accent white reads on every hue.
                color: color.onAccent, fontSize: 9, fontWeight: 700, lineHeight: 1,
              }}
            >
              {paletteWraps ? i + 1 : ""}
            </span>
            {paletteWraps && <span style={{ fontWeight: 700, color: color.textSub }}>#{i + 1}</span>}
            {c.label}
            {c.origins.length > 1 && <span style={{ opacity: 0.75 }}>· {c.origins.length} pickups</span>}
          </span>
        ))}
      </div>

      {/* The stack. With ≥2 companies the decluttered per-company grid is the primary read
          and the combined, drag-to-rebalance stack sits behind a toggle; a single-company
          truck shows the one combined stack directly (the grid would be identical). */}
      {truck.stack ? (
        truck.companies.length > 1 ? (
          <>
            <PerCompanyStacks truck={truck} colorForIndex={colorForIndex} companyKeyOf={companyKeyOf} />
            <details>
              <summary style={{ fontSize: font.xs, color: color.muted, cursor: "pointer" }}>
                Combined shared-truck view (drag pallets to rebalance)
              </summary>
              <div style={{ marginTop: 6 }}>
                <Van3DViewer
                  placements={placements}
                  interior={truck.stack.interior}
                  itemNames={itemNames}
                  groupColors={groupColors}
                  heightPx={360}
                  editable
                  onPlacementsChange={onPlacementsChange}
                  toleranceM={truck.toleranceM}
                  maxReachHeightM={truck.maxReachHeightM ?? undefined}
                />
              </div>
            </details>
          </>
        ) : (
          <Van3DViewer
            placements={placements}
            interior={truck.stack.interior}
            itemNames={itemNames}
            groupColors={groupColors}
            heightPx={360}
            editable
            onPlacementsChange={onPlacementsChange}
            toleranceM={truck.toleranceM}
            maxReachHeightM={truck.maxReachHeightM ?? undefined}
          />
        )
      ) : (
        <p style={{ fontSize: font.xs, color: color.muted }}>
          No vehicle is configured for the {truck.legKind} leg, so this truck can&apos;t be drawn. Set a
          vehicle id for it in config/groupage-rates.json.
        </p>
      )}

      {/* Pallets that didn't fit — surfaced, never dropped */}
      {truck.stack && truck.stack.unplaced.length > 0 && (
        <ErrorBanner style={{ padding: "6px 10px" }}>
          <strong>Didn&apos;t fit this vehicle:</strong>{" "}
          {truck.stack.unplaced.map((u) => `${u.count} × ${u.footprint} (${u.company})`).join(", ")}. Free up space or use another run.
        </ErrorBanner>
      )}

      {/* Per-company breakdown — who's on this truck and what they brought */}
      <details>
        <summary style={{ fontSize: font.xs, color: color.muted, cursor: "pointer" }}>Who&apos;s on this truck</summary>
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {truck.stack?.companies.map((c, i) => (
            <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.xs, color: color.text }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: companyPalette[i % companyPalette.length] }} />
              <strong>{c.label}</strong>
              {c.origins.length > 0 && (
                <span style={{ color: color.muted }}>· {c.origins.join(", ")}</span>
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

const fieldGroupLabel: React.CSSProperties = { fontSize: font.xs, fontWeight: 600, color: color.muted, margin: `${spacing.sm}px 0 ${spacing.xs}px`, textTransform: "uppercase", letterSpacing: "0.05em" };
const labelWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
const labelText: React.CSSProperties = { fontSize: font.xs, color: color.muted, fontWeight: 500 };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: radius.input, border: `1px solid ${color.border}`, background: color.surfaceSub, color: color.text, fontSize: font.sm };
const baseBtn: React.CSSProperties = { border: `1px solid ${color.border}`, borderRadius: 999, padding: "6px 12px", fontSize: font.xs, fontWeight: 600, cursor: "pointer" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: color.surfaceSub, color: color.text };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: color.text, color: color.surface, border: `1px solid ${color.text}` };
