"use client";

/**
 * Hub collection run — plan an LTL pickup loop around a 3PL hub. The operator picks a hub,
 * builds the pickup list (PDF import → confirm each candidate, and/or manual rows with
 * autocomplete), picks the van, and plans the run: optimized visit order, mini-map, distance,
 * time, and cost. "Never guess" surfaces: unconfident PDF candidates and out-of-catchment
 * pickups are badged, an address-less hub is called out with the exact fix, and API errors
 * land verbatim next to the button that caused them.
 */
import { useEffect, useMemo, useState } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import { smartGBP } from "@/lib/fmt";
import { PlacesInput } from "@/components/PlacesInput";
import { CollectionRunMap } from "./CollectionRunMap";
import { RouteMap, type RoutePoint } from "@/components/maps/RouteMap";
import { publicEnv } from "@/config/public-env";
import { areaCentroid, hubCentroid } from "@/lib/geo/area-centroids";
import { postcodeArea, resolveHubOrNull } from "@/lib/groupage/hub-resolver";
import { extractPostcode } from "@/lib/geo/address-resolver";
import type { Hub } from "@/lib/groupage/groupage.types";
import type { Van } from "@/lib/packing/packing.types";
import type {
  CollectionIngestResponse,
  CollectionRunQuoteResponse,
  PickupCandidate,
  SessionHub,
} from "@/types/api";
import {
  readPanelSnapshot,
  writePanelSnapshot,
  PANEL_SNAPSHOT_KEYS,
} from "@/lib/session-cache/panel-snapshots";

interface PickupRow {
  value: string;
  /** True once picked from autocomplete or imported — free-typed text stays unconfirmed. */
  selected: boolean;
  /** Company this pickup serves, when known (carried from a groupage origin). */
  company?: string;
  /** True when auto-pulled from a groupage consignment for the chosen hub — lets us swap these
   *  out when the hub changes without touching the operator's own rows. */
  fromGroupage?: boolean;
}

/** Just the fields the collection run needs from a remembered groupage consignment: who it's for
 *  and where we collect from. Origins that fall in the chosen hub's catchment become pickups. */
interface GroupageConsignment {
  company: string;
  originPostcode: string;
}

/** Advisory in/out/unknown verdict for one typed address against the chosen hub. Client-side
 *  preview only — the server recomputes the authoritative verdicts on plan. */
function catchmentBadge(address: string, hub: Hub | undefined, hubs: Hub[]): { label: string; tone: "ok" | "warn" | "muted" } | null {
  if (!hub || address.trim() === "") return null;
  const postcode = extractPostcode(address);
  if (!postcode) return { label: "no postcode", tone: "muted" };
  const area = postcodeArea(postcode);
  if (hub.catchment.includes(area)) return { label: `${area} · in catchment`, tone: "ok" };
  const owner = hubs.find((h) => h.catchment.includes(area));
  return { label: owner ? `${area} · ${owner.name}'s area` : `${area} · no hub covers this`, tone: "warn" };
}

/** What we remember about a collection run so switching modes and returning shows it instantly,
 *  without a re-fetch or re-plan. Held in memory for the session only (see panel-snapshots). */
interface CollectionSnapshot {
  hubs: Hub[];
  vans: Van[];
  consignments: GroupageConsignment[];
  hubId: string;
  hubTouched: boolean;
  vanId: string;
  vanTouched: boolean;
  optimize: boolean;
  rows: PickupRow[];
  result: CollectionRunQuoteResponse | null;
}

export function CollectionRunPanel({
  embedded = false,
  prefillPickups,
  fleetVanId,
  onSendHubToHub,
  stopPalletsSlot,
}: {
  /** True when hosted in the main quote card (a heading sits above it) — drops the
   *  panel's own intro line so the host's heading does the talking. */
  embedded?: boolean;
  /** Pickup addresses to seed the rows from the loaded PDF's detected addresses.
   *  Applied once while the list is still untouched — never clobbers typed input. */
  prefillPickups?: readonly string[];
  /** The van the packer sized for the load (a collect job carries cargo) — pre-selected
   *  over the first-van default so the truck comes from the PDF's volume. Undefined ⇒ fall
   *  back to the first van (a pickup list alone has no volume to size from). */
  fleetVanId?: string;
  /** Hand the consolidated load to the shared-truck flow for the hub-to-hub leg. Called with the
   *  collection hub's postcode (origin); the operator picks the outbound hub over there. Undefined ⇒
   *  the button is hidden (panel shown standalone, not inside the quote flow). */
  onSendHubToHub?: (originHubPostcode: string | null) => void;
  /** Per-pickup 3D pallet cards (built by the host from the load plan) shown above the route map.
   *  A slot so this panel stays free of packing/3D internals. Omit ⇒ nothing rendered. */
  stopPalletsSlot?: React.ReactNode;
} = {}) {
  const snap0 = readPanelSnapshot<CollectionSnapshot>(PANEL_SNAPSHOT_KEYS.collection);

  const [hubs, setHubs] = useState<Hub[]>(() => snap0?.hubs ?? []);
  const [vans, setVans] = useState<Van[]>(() => snap0?.vans ?? []);
  const [consignments, setConsignments] = useState<GroupageConsignment[]>(() => snap0?.consignments ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  // No spinner when we're restoring a remembered run — the reference lists came back with it; the
  // mount effect below still refreshes them in the background.
  const [loading, setLoading] = useState(() => snap0 === undefined);

  const [hubId, setHubId] = useState(() => snap0?.hubId ?? "");
  // True once the operator picks a hub themselves — stops the auto-suggestion below from
  // overriding their choice.
  const [hubTouched, setHubTouched] = useState(() => snap0?.hubTouched ?? false);
  const [vanId, setVanId] = useState(() => snap0?.vanId ?? "");
  // True once the operator picks a van themselves — stops the default/sized van below from
  // overriding their choice.
  const [vanTouched, setVanTouched] = useState(() => snap0?.vanTouched ?? false);
  const [optimize, setOptimize] = useState(() => snap0?.optimize ?? true);
  const [rows, setRows] = useState<PickupRow[]>(() => snap0?.rows ?? [{ value: "", selected: false }]);

  // PDF import — candidates reviewed row by row; nothing joins the run until Add.
  const [candidates, setCandidates] = useState<PickupCandidate[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [result, setResult] = useState<CollectionRunQuoteResponse | null>(() => snap0?.result ?? null);
  // Hubs read off the uploaded manifest for THIS session — layered over the saved network on the
  // plan request below.
  const [sessionHubs] = useState<SessionHub[]>(
    () => readPanelSnapshot<SessionHub[]>(PANEL_SNAPSHOT_KEYS.manifestHubs) ?? [],
  );

  // Remember this run for the session so leaving Collection mode and returning shows it instantly,
  // with no re-fetch or re-plan. Cleared on a new upload (the host calls clearPanelSnapshots).
  useEffect(() => {
    writePanelSnapshot<CollectionSnapshot>(PANEL_SNAPSHOT_KEYS.collection, {
      hubs,
      vans,
      consignments,
      hubId,
      hubTouched,
      vanId,
      vanTouched,
      optimize,
      rows,
      result,
    });
  }, [hubs, vans, consignments, hubId, hubTouched, vanId, vanTouched, optimize, rows, result]);

  useEffect(() => {
    Promise.all([
      fetch("/api/hubs").then((r) => r.json()),
      fetch("/api/vans").then((r) => r.json()),
      // Groupage origins double as this hub's pickup list — a soft, additive source. If it fails
      // to load, the run still works from PDF/manual rows, so its error never blocks the panel.
      fetch("/api/groupage/consignments")
        .then((r) => r.json())
        .catch(() => ({ consignments: [] as GroupageConsignment[] })),
    ])
      .then(
        ([h, v, c]: [
          { hubs?: Hub[]; error?: string },
          { vans?: Van[]; error?: string },
          { consignments?: GroupageConsignment[] },
        ]) => {
          if (h.hubs) setHubs(h.hubs);
          if (v.vans) setVans(v.vans);
          if (c.consignments) setConsignments(c.consignments);
          const err = h.error ?? v.error;
          if (err) setLoadError(err);
        },
      )
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "Failed to load hubs/fleet."))
      .finally(() => setLoading(false));
  }, []);

  const hub = useMemo(() => hubs.find((h) => h.id === hubId), [hubs, hubId]);
  const filledRows = rows.filter((r) => r.value.trim() !== "");

  // Nearest hub suggested from the first pickup's postcode — reuses the same postcode→hub
  // resolution the quote engine uses (resolveHubOrNull: soft, returns null on a catchment gap,
  // never a guess). Applied only until the operator picks a hub themselves; surfaced as a note
  // below so the choice is never made silently.
  const suggestedHub = useMemo<Hub | null>(() => {
    const first = rows.find((r) => r.value.trim() !== "")?.value;
    if (!first) return null;
    const postcode = extractPostcode(first);
    if (!postcode) return null;
    try {
      return resolveHubOrNull(postcode, hubs);
    } catch {
      return null; // malformed postcode — leave the hub unset (fail-soft)
    }
  }, [rows, hubs]);

  useEffect(() => {
    if (!hubTouched && hubId === "" && suggestedHub) setHubId(suggestedHub.id);
  }, [suggestedHub, hubTouched, hubId]);

  const hubIsSuggested = !hubTouched && suggestedHub != null && hubId === suggestedHub.id;

  // Default van: the packer's sized van when the load came from a PDF (fleetVanId), else the first
  // van — a one-click starting point, applied only until the operator picks one themselves.
  useEffect(() => {
    if (vanTouched) return;
    const preferred = fleetVanId ?? vans[0]?.id;
    if (preferred) setVanId(preferred);
  }, [fleetVanId, vans, vanTouched]);

  // Seed the pickup rows from the loaded PDF's detected addresses — applied only while the list is
  // still untouched (never clobbers a typed/added pickup). prefillKey collapses the array to a
  // stable dep so this fires once per distinct address set.
  const prefillKey = (prefillPickups ?? []).join("|");
  useEffect(() => {
    if (!prefillPickups || prefillPickups.length === 0) return;
    setRows((rs) =>
      rs.some((r) => r.value.trim() !== "") ? rs : prefillPickups.map((a) => ({ value: a, selected: false })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillKey]);

  // Groupage records WHERE each company is collected from (its origin postcode). Every origin whose
  // area falls in the CHOSEN hub's catchment is a real stop on that hub's loop — so pull them in as
  // pickups instead of making the operator re-type the same collection list. Deduped by origin +
  // company (two companies at one postcode = two stops the driver serves).
  const hubConsignments = useMemo<GroupageConsignment[]>(() => {
    if (!hub) return [];
    const seen = new Set<string>();
    return consignments.filter((c) => {
      const pc = extractPostcode(c.originPostcode);
      if (!pc || !hub.catchment.includes(postcodeArea(pc))) return false;
      const key = `${c.originPostcode.trim().toLowerCase()}|${c.company.trim().toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [hub, consignments]);

  // Refresh the auto-pulled rows whenever the hub (hence its catchment) changes. The operator's own
  // rows — manual or from a PDF — are never touched, and any auto row can still be removed with ✕.
  useEffect(() => {
    setRows((rs) => {
      const manual = rs.filter((r) => !r.fromGroupage && r.value.trim() !== "");
      const manualAddrs = new Set(manual.map((r) => r.value.trim().toLowerCase()));
      const auto = hubConsignments
        .filter((c) => !manualAddrs.has(c.originPostcode.trim().toLowerCase()))
        .map((c): PickupRow => ({ value: c.originPostcode, selected: true, company: c.company, fromGroupage: true }));
      const next = [...manual, ...auto];
      return next.length > 0 ? next : [{ value: "", selected: false }];
    });
  }, [hubConsignments]);

  const groupageCount = rows.filter((r) => r.fromGroupage).length;

  const setRow = (i: number, value: string, selected: boolean) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { value, selected } : r)));
  const removeRow = (i: number) => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [{ value: "", selected: false }]));
  const addRow = () => setRows((rs) => [...rs, { value: "", selected: false }]);

  const addCandidate = (cand: PickupCandidate) => {
    setRows((rs) => {
      const existing = rs.filter((r) => r.value.trim() !== "");
      if (existing.some((r) => r.value.trim().toLowerCase() === cand.address.toLowerCase())) return rs;
      return [...existing, { value: cand.address, selected: cand.confident }];
    });
    setCandidates((cs) => (cs ? cs.filter((c) => c.address !== cand.address) : cs));
  };

  const importPdf = async (file: File) => {
    setImportError(null);
    setCandidates(null);
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/collection-run/ingest", { method: "POST", body: fd });
      const data = (await res.json()) as CollectionIngestResponse;
      if (data.success && data.candidates) {
        setCandidates(data.candidates);
        if (data.candidates.length === 0) setImportError("No pickup addresses with postcodes found in that PDF.");
      } else {
        setImportError(data.error ?? "Failed to read the PDF.");
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to read the PDF.");
    } finally {
      setImporting(false);
    }
  };

  const planRun = async () => {
    setPlanError(null);
    setResult(null);
    if (!hubId) { setPlanError("Pick a hub first."); return; }
    if (!vanId) { setPlanError("Pick the van driving the run."); return; }
    if (filledRows.length === 0) { setPlanError("Add at least one pickup address."); return; }
    setPlanning(true);
    try {
      const res = await fetch("/api/collection-run/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hubId,
          vanId,
          pickups: filledRows.map((r) => (r.company ? { address: r.value.trim(), company: r.company } : r.value.trim())),
          optimize,
          sessionHubs: sessionHubs.map((h) => ({
            id: h.id,
            name: h.name,
            catchment: h.catchment,
            ...(h.address ? { address: h.address } : {}),
          })),
        }),
      });
      const data = (await res.json()) as CollectionRunQuoteResponse;
      if (data.success) setResult(data);
      else setPlanError(data.error ?? "Failed to plan the run.");
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Failed to plan the run.");
    } finally {
      setPlanning(false);
    }
  };

  if (loading) return <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>Loading hubs &amp; fleet…</p>;
  if (loadError) return <p role="alert" style={{ margin: 0, fontSize: font.xs, color: color.error }}>{loadError}</p>;

  const totalMiles = result?.quote?.route.distanceMiles;
  const totalMinutes = result?.quote ? Math.round(result.quote.route.durationSeconds / 60) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>
      {!embedded && (
        <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Plan a pickup round: the van leaves the hub, collects every order, and returns to the hub.
          Import the orders from a PDF or type them below.
        </p>
      )}

      {/* ── Hub + van ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={labelWrap}>
          <span style={labelText}>Hub (start &amp; end)</span>
          <select value={hubId} onChange={(e) => { setHubId(e.target.value); setHubTouched(true); setResult(null); }} style={inputStyle}>
            <option value="">Choose a hub…</option>
            {hubs.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}{h.address ? "" : " — no address yet"}
              </option>
            ))}
          </select>
        </label>
        <label style={labelWrap}>
          <span style={labelText}>Van / truck</span>
          <select value={vanId} onChange={(e) => { setVanId(e.target.value); setVanTouched(true); }} style={inputStyle}>
            <option value="">Choose a van…</option>
            {vans.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </label>
      </div>
      {hubIsSuggested && hub && (
        <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
          Suggested <strong>{hub.name}</strong> from your first pickup — change it above if that&apos;s not right.
        </p>
      )}
      {hub && !hub.address && (
        <p role="alert" style={{ margin: 0, fontSize: font.xs, color: color.review.fg }}>
          {hub.name} has no storage address yet — add it in Depots &amp; hubs first, then plan the run.
        </p>
      )}

      {/* ── PDF import ── */}
      <div>
        <p style={{ margin: `0 0 ${spacing.xs}px`, fontSize: font.xs, fontWeight: 600, color: color.muted }}>
          Import pickups from a PDF
        </p>
        <input
          type="file"
          accept="application/pdf"
          disabled={importing}
          aria-label="Pickup-manifest PDF"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importPdf(f);
            e.target.value = "";
          }}
          style={{ fontSize: font.xs, color: color.muted }}
        />
        {importing && <p style={{ fontSize: font.xs, color: color.muted, margin: `${spacing.xs}px 0 0` }}>Reading PDF…</p>}
        {importError && <p role="alert" style={{ fontSize: font.xs, color: color.error, margin: `${spacing.xs}px 0 0` }}>{importError}</p>}

        {candidates && candidates.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: spacing.sm }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <p style={{ margin: 0, fontSize: font.xs, fontWeight: 600, color: color.text }}>
                {candidates.length} address{candidates.length !== 1 ? "es" : ""} found — review &amp; add
              </p>
              <button type="button" onClick={() => candidates.forEach(addCandidate)} style={{ ...secondaryBtn, padding: "3px 8px" }}>
                Add all
              </button>
            </div>
            {candidates.map((c) => (
              <div
                key={c.address}
                style={{
                  border: `1px solid ${c.confident ? color.border : color.review.border}`,
                  background: c.confident ? "transparent" : color.review.bg,
                  borderRadius: radius.input,
                  padding: "6px 8px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: font.xs, color: color.text, overflowWrap: "anywhere" }}>{c.address}</p>
                  {!c.confident && (
                    <p style={{ margin: "2px 0 0", fontSize: font.xs, color: color.review.fg }}>
                      Check this one — read straight off the page, may carry extra text.
                    </p>
                  )}
                </div>
                <button type="button" onClick={() => addCandidate(c)} style={{ ...secondaryBtn, flexShrink: 0, padding: "3px 10px" }}>
                  Add
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Pickup rows ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <p style={{ margin: 0, fontSize: font.xs, fontWeight: 600, color: color.muted }}>
          Pickups ({filledRows.length})
        </p>
        {groupageCount > 0 && (
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
            {groupageCount} pulled in from groupage for {hub?.name ?? "this hub"} — edit or remove any that don&apos;t belong.
          </p>
        )}
        {filledRows.length === 0 && (
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
            No pickups yet — import a PDF above, or add addresses below.
          </p>
        )}
        {rows.map((row, i) => {
          const badge = catchmentBadge(row.value, hub, hubs);
          return (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <PlacesInput
                  value={row.value}
                  onChange={(val) => setRow(i, val, false)}
                  onSelect={(s) => setRow(i, s.label, true)}
                  placeholder={`Pickup ${i + 1} — address or postcode`}
                  style={inputStyle}
                  valid={row.selected}
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  aria-label={`Remove pickup ${i + 1}`}
                  style={{ ...secondaryBtn, flexShrink: 0, padding: "6px 10px" }}
                >
                  ✕
                </button>
              </div>
              {(badge || row.company) && (
                <span style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: font.xs }}>
                  {row.company && <span style={{ color: color.muted }}>for <strong>{row.company}</strong></span>}
                  {badge && (
                    <span
                      style={{ color: badge.tone === "ok" ? color.success : badge.tone === "warn" ? color.review.fg : color.muted }}
                    >
                      {badge.label}
                    </span>
                  )}
                </span>
              )}
            </div>
          );
        })}
        <button type="button" onClick={addRow} style={{ ...secondaryBtn, alignSelf: "flex-start" }}>
          + Add pickup
        </button>
      </div>

      {/* ── Plan ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.xs, color: color.text }}>
          <input type="checkbox" checked={optimize} onChange={(e) => setOptimize(e.target.checked)} />
          Let the router pick the best pickup order
        </label>
        <button
          type="button"
          onClick={planRun}
          disabled={planning}
          style={{ ...primaryBtn, opacity: planning ? 0.6 : 1, cursor: planning ? "not-allowed" : "pointer" }}
          title={result?.success ? "Re-run the plan with the current pickups, hub and van" : undefined}
        >
          {planning ? "Planning…" : result?.success ? "Recalculate" : "Plan run"}
        </button>
        {planError && <p role="alert" style={{ margin: 0, fontSize: font.xs, color: color.error }}>{planError}</p>}
      </div>

      {/* ── Results ── */}
      {result?.success && result.quote && result.hub && result.orderedStops && (
        <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md, display: "flex", flexDirection: "column", gap: spacing.sm }}>
          {(result.warnings ?? []).map((w, i) => (
            <p key={i} role="alert" style={{ margin: 0, fontSize: font.xs, color: color.review.fg, lineHeight: 1.5 }}>⚠ {w}</p>
          ))}

          <div style={{ display: "flex", gap: spacing.md, flexWrap: "wrap", fontSize: font.sm, color: color.text }}>
            <span><strong>{totalMiles?.toFixed(1)}</strong> miles</span>
            <span><strong>{totalMinutes}</strong> min driving</span>
            <span><strong>{smartGBP(result.quote.total)}</strong> total</span>
          </div>

          {/* Per-pickup 3D pallets (from the load plan) — read the load stop-by-stop above the map. */}
          {stopPalletsSlot}

          {(() => {
            // Live Google map when a browser key is set (numbered stops, a route loop, zoom/pan,
            // client-side geocoding to street level); otherwise the static SVG mini-map. Both plot
            // the same stops — a pickup with no readable postcode is off the map but still in the
            // numbered list below, so nothing is hidden.
            const hubLL = hubCentroid(hub?.catchment ?? []);
            const points: RoutePoint[] = result.orderedStops.flatMap((s, i) => {
              const ll = areaCentroid(s.postcodeArea);
              return ll ? [{ seq: i + 1, label: s.address, ...ll }] : [];
            });
            return publicEnv.googleMapsApiKey && hubLL ? (
              <RouteMap hub={{ label: result.hub.name, ...hubLL }} points={points} loop geocode />
            ) : (
              <CollectionRunMap
                hubName={result.hub.name}
                hubCatchment={hub?.catchment ?? []}
                orderedStops={result.orderedStops}
              />
            );
          })()}

          <ol style={{ margin: 0, paddingLeft: 18, fontSize: font.xs, color: color.text, lineHeight: 1.7 }}>
            <li style={{ color: color.muted }}>{result.hub.name} — {result.hub.address}</li>
            {result.orderedStops.map((s, i) => (
              <li key={i}>
                {s.address}
                {s.company && <span style={{ color: color.muted }}> · for {s.company}</span>}
                {!s.inCatchment && (
                  <span style={{ color: color.review.fg }}>
                    {" "}
                    ({s.postcodeArea === null ? "no postcode" : s.owningHubId ? "outside catchment" : "no hub covers this area"})
                  </span>
                )}
              </li>
            ))}
            <li style={{ color: color.muted }}>Back to {result.hub.name}</li>
          </ol>

          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {result.quote.lineItems.map((li, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: font.xs, color: color.muted }}>
                <span>{li.label}</span>
                <span>{smartGBP(li.amount)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: font.sm, color: color.text, fontWeight: 700, borderTop: `1px solid ${color.border}`, paddingTop: 4, marginTop: 2 }}>
              <span>Total</span>
              <span>{smartGBP(result.quote.total)}</span>
            </div>
          </div>

          {/* Next step: the load is now consolidated at the hub — offer to trunk it hub-to-hub on the
              shared-truck flow (reuses the groupage quote, no separate engine). Origin = this hub;
              the operator picks the destination hub over there. */}
          {onSendHubToHub && (
            <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.sm, display: "flex", flexDirection: "column", gap: spacing.xs }}>
              <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
                Everything is now gathered at <strong>{result.hub.name}</strong>. Send the consolidated
                load on to another hub as a shared-truck (hub-to-hub) leg.
              </p>
              <button
                type="button"
                onClick={() => onSendHubToHub(extractPostcode(result.hub!.address))}
                style={{ ...primaryBtn, alignSelf: "flex-start" }}
              >
                Send hub-to-hub →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const labelWrap: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
const labelText: React.CSSProperties = { fontSize: font.xs, color: color.muted, fontWeight: 500 };
const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  borderRadius: radius.input,
  border: `1px solid ${color.border}`,
  background: color.surfaceSub,
  color: color.text,
  fontSize: font.sm,
};
const baseBtn: React.CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: 999,
  padding: "6px 12px",
  fontSize: font.xs,
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: color.surfaceSub, color: color.text };
const primaryBtn: React.CSSProperties = {
  ...baseBtn,
  background: color.text,
  color: color.surface,
  border: `1px solid ${color.text}`,
};
