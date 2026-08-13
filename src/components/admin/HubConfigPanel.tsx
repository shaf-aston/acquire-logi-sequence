"use client";

import { useEffect, useMemo, useState } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import { GroupageError, type Hub } from "@/lib/groupage/groupage.types";
import type { HubCandidate, DroppedDepot } from "@/lib/groupage/hub-extractor";
import { hubIdFromName, postcodeArea, resolveHub } from "@/lib/groupage/hub-resolver";
import { extractPostcode } from "@/lib/geo/address-resolver";
import { HubNetworkMap } from "./HubNetworkMap";
import { HubMap } from "./HubMap";
import { PlacesInput } from "@/components/PlacesInput";

interface Draft {
  id: string;
  name: string;
  catchment: string;
  /** Physical 3PL storage address — where a collection run starts and ends. Blank = not set. */
  address: string;
}

const emptyDraft: Draft = { id: "", name: "", catchment: "", address: "" };

/** An imported candidate the operator can edit (name + catchment) before adding it to the network. */
interface CandidateDraft {
  id: string;
  name: string;
  catchmentText: string;
  warning?: string;
}

const toCandidateDraft = (c: HubCandidate): CandidateDraft => ({
  id: c.id,
  name: c.name,
  catchmentText: c.catchment.join(", "),
  warning: c.warning,
});

function parseCatchment(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== "");
}

function validateDraft(draft: Draft, catchment: string[]): string | null {
  // No Hub ID check — it's derived from the name on save, so the operator never invents one.
  if (!draft.name.trim()) return "Hub name is required.";
  if (catchment.length === 0) return "At least one catchment postcode area is required.";
  return null;
}

export function HubConfigPanel({
  embedded = false,
  prefill,
  onPrefillConsumed,
}: {
  /** True when hosted inside a collapsible sidebar card — drops the panel's own card chrome. */
  embedded?: boolean;
  /** Seeds a fresh Add-hub form — set when a catchment-gap error jumps here with the uncovered area
   *  (and optionally an address) so the fix is one name away. Applied once per distinct prefill. */
  prefill?: { catchment?: string[]; address?: string };
  /** Fired once the prefill has seeded the form, so the parent can clear it — otherwise re-opening
   *  the card keeps dropping the operator back onto a blank "Add hub" form for the same area. */
  onPrefillConsumed?: () => void;
} = {}) {
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // PDF import (hub-sourcing tier 3): extracted candidates are shown for review + edit — nothing is
  // written until the operator clicks "Add", so a bad upload can never overwrite the live network.
  const [candidates, setCandidates] = useState<CandidateDraft[] | null>(null);
  const [duplicates, setDuplicates] = useState<DroppedDepot[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const isEditing = draft.id !== "" && hubs.some((h) => h.id === draft.id);

  // Address → catchment intelligence: pull a postcode out of whatever the operator typed/picked as
  // the storage address, reduce it to its area (the thing a catchment is made of), and suggest adding
  // it — unless it's already covered. Fail-soft: a non-postcode address just yields no suggestion.
  const suggestedArea = useMemo<string | null>(() => {
    const pc = extractPostcode(draft.address);
    if (!pc) return null;
    let area: string;
    try {
      area = postcodeArea(pc);
    } catch {
      return null;
    }
    return parseCatchment(draft.catchment).includes(area) ? null : area;
  }, [draft.address, draft.catchment]);

  // Map interactions edit the same draft as the form — one source of truth, and
  // nothing touches the saved network until the operator clicks Save.
  const selectHub = (h: Hub) => {
    setDraft({ id: h.id, name: h.name, catchment: h.catchment.join(", "), address: h.address ?? "" });
    setConfirmDeleteId(null);
    setMessage(null);
  };
  const toggleArea = (area: string) => {
    setDraft((d) => {
      const cur = parseCatchment(d.catchment);
      const next = cur.includes(area) ? cur.filter((a) => a !== area) : [...cur, area];
      return { ...d, catchment: next.join(", ") };
    });
  };

  // Auto-assign mode: reassign one postcode area straight to whichever hub is nearest by
  // distance — writes immediately (both the losing and gaining hub), unlike the per-dot
  // toggle above which only edits the in-progress draft until Save.
  const assignAreaToNearestHub = async (area: string, nearestId: string) => {
    setMessage(null);
    const currentOwner = hubs.find((h) => h.catchment.includes(area));
    if (currentOwner?.id === nearestId) return;
    try {
      if (currentOwner) {
        const withoutArea = currentOwner.catchment.filter((a) => a !== area);
        // Carry address through — upsert replaces the whole hub, so omitting it would wipe it.
        await fetch("/api/hubs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: currentOwner.id, name: currentOwner.name, catchment: withoutArea, address: currentOwner.address }),
        });
      }
      const gainingHub = hubs.find((h) => h.id === nearestId);
      if (!gainingHub) return;
      const res = await fetch("/api/hubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: gainingHub.id, name: gainingHub.name, catchment: [...gainingHub.catchment, area], address: gainingHub.address }),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (data.success) {
        setMessage({ text: `${area} reassigned to ${gainingHub.name}.`, ok: true });
        loadHubs();
      } else {
        setMessage({ text: data.error ?? "Failed to reassign area.", ok: false });
      }
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Failed to reassign area.", ok: false });
    }
  };

  // ── Hub checker: type a postcode/address, see which hub serves it (or the gap) ──
  const [checkQuery, setCheckQuery] = useState("");
  const [checkResult, setCheckResult] = useState<
    { ok: true; hub: Hub; area: string } | { ok: false; area: string | null; message: string } | null
  >(null);
  const runCheck = () => {
    if (!checkQuery.trim()) { setCheckResult(null); return; }
    try {
      const hub = resolveHub(checkQuery, hubs);
      setCheckResult({ ok: true, hub, area: postcodeArea(checkQuery) });
    } catch (e) {
      const message = e instanceof GroupageError ? e.message : "Could not check that postcode.";
      // Keep the area when it parsed but no hub covers it — lets us offer a one-click assign.
      let area: string | null = null;
      try { area = postcodeArea(checkQuery); } catch { /* not postcode-shaped */ }
      setCheckResult({ ok: false, area, message });
    }
  };

  const importPdf = async (fileToImport: File) => {
    setImportError(null);
    setCandidates(null);
    setDuplicates([]);
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", fileToImport);
      const res = await fetch("/api/ingest-hubs", { method: "POST", body: fd });
      const data = (await res.json()) as {
        success: boolean;
        candidates?: HubCandidate[];
        duplicates?: DroppedDepot[];
        error?: string;
      };
      if (data.success && data.candidates) {
        setCandidates(data.candidates.map(toCandidateDraft));
        setDuplicates(data.duplicates ?? []);
        if (data.candidates.length === 0) setImportError("No depot postcodes found in that PDF.");
      } else {
        setImportError(data.error ?? "Failed to read the PDF.");
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to read the PDF.");
    } finally {
      setImporting(false);
    }
  };

  const editCandidate = (id: string, patch: Partial<CandidateDraft>) =>
    setCandidates((cs) => (cs ? cs.map((c) => (c.id === id ? { ...c, ...patch } : c)) : cs));

  const addCandidate = async (cand: CandidateDraft) => {
    setMessage(null);
    const catchment = parseCatchment(cand.catchmentText);
    if (!cand.name.trim()) {
      setMessage({ text: "Give the depot a name before adding it.", ok: false });
      return;
    }
    if (catchment.length === 0) {
      setMessage({ text: "Set at least one catchment postcode area before adding.", ok: false });
      return;
    }
    try {
      const res = await fetch("/api/hubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cand.id, name: cand.name.trim(), catchment }),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (data.success) {
        setMessage({ text: `Added ${cand.name.trim()}.`, ok: true });
        setCandidates((cs) => (cs ? cs.filter((c) => c.id !== cand.id) : cs));
        loadHubs();
      } else {
        setMessage({ text: data.error ?? "Failed to add hub.", ok: false });
      }
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : "Failed to add hub.", ok: false });
    }
  };

  const loadHubs = () => {
    setLoading(true);
    setLoadError(null);
    fetch("/api/hubs")
      .then((res) => res.json())
      .then((data: { hubs?: Hub[]; error?: string }) => {
        if (data.hubs) {
          setHubs(data.hubs);
        } else {
          setLoadError(data.error ?? "Failed to load hubs.");
        }
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : "Failed to load hubs.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadHubs();
  }, []);

  // A catchment-gap fix jumped here — open a fresh Add-hub form seeded with the uncovered area (and
  // address if known). Keyed on the prefill's contents so it applies once per distinct request, not
  // on every parent re-render.
  const prefillCatchment = prefill?.catchment?.join(", ") ?? "";
  const prefillAddress = prefill?.address ?? "";
  useEffect(() => {
    if (prefillCatchment === "" && prefillAddress === "") return;
    setDraft({ id: "", name: "", catchment: prefillCatchment, address: prefillAddress });
    setConfirmDeleteId(null);
    setMessage(null);
    // Consume the prefill so re-opening the card doesn't re-seed a blank Add-hub form for area X.
    onPrefillConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillCatchment, prefillAddress]);

  const save = async () => {
    setMessage(null);
    const catchment = parseCatchment(draft.catchment);
    const err = validateDraft(draft, catchment);
    if (err) {
      setMessage({ text: err, ok: false });
      return;
    }
    // Editing keeps the record's own id; a new hub gets one derived from its name (unique against
    // the current network) so the operator never has to type an id.
    const id = isEditing ? draft.id.trim() : hubIdFromName(draft.name, hubs.map((h) => h.id));
    setSaving(true);
    try {
      const res = await fetch("/api/hubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: draft.name.trim(), catchment, address: draft.address.trim() || undefined }),
      });
      const data = (await res.json()) as { success: boolean; hub?: Hub; error?: string };
      if (data.success) {
        setMessage({ text: isEditing ? "Hub updated." : "Hub added.", ok: true });
        setDraft(emptyDraft);
        loadHubs();
      } else {
        setMessage({ text: data.error ?? "Failed to save hub.", ok: false });
      }
    } catch (fetchErr) {
      setMessage({ text: fetchErr instanceof Error ? fetchErr.message : "Failed to save hub.", ok: false });
    } finally {
      setSaving(false);
    }
  };

  const del = async (id: string) => {
    setMessage(null);
    try {
      const res = await fetch("/api/hubs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = (await res.json()) as { success: boolean; error?: string };
      if (data.success) {
        if (draft.id === id) setDraft(emptyDraft);
        setMessage({ text: "Hub removed.", ok: true });
        loadHubs();
      } else {
        setMessage({ text: data.error ?? "Failed to remove hub.", ok: false });
      }
    } catch (fetchErr) {
      setMessage({ text: fetchErr instanceof Error ? fetchErr.message : "Failed to remove hub.", ok: false });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  return (
    <div
      style={
        embedded
          ? { display: "flex", flexDirection: "column", gap: spacing.md }
          : {
              background: color.surface,
              border: `1px solid ${color.border}`,
              borderRadius: radius.card,
              padding: spacing.lg,
              display: "flex",
              flexDirection: "column",
              gap: spacing.md,
            }
      }
    >
      {!embedded && (
      <div>
        <p style={sectionLabel}>Hub network</p>
        <h3 style={{ margin: 0, fontSize: font.md, color: color.text, fontWeight: 700, letterSpacing: "-0.01em" }}>
          Depots &amp; catchments
        </h3>
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Each postcode area belongs to exactly one hub. Edits are saved to config/hubs.json.
        </p>
      </div>
      )}

      {embedded && (
        <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Rates and hub locations used by shared-truck quotes. Each postcode area belongs to exactly
          one hub; edits are saved permanently.
        </p>
      )}

      {/* ── Locator map (hero) — real map, drop a pin to find the nearest hub ── */}
      {!loading && !loadError && <HubMap hubs={hubs} />}

      {/* ── Catchment checker — which hub OFFICIALLY covers a postcode (what quotes use) ── */}
      {!loading && !loadError && hubs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
          <div style={{ display: "flex", gap: spacing.xs, alignItems: "stretch" }}>
            <input
              type="text"
              aria-label="Check which hub serves a postcode"
              value={checkQuery}
              onChange={(e) => { setCheckQuery(e.target.value); setCheckResult(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") runCheck(); }}
              placeholder="Check a postcode — e.g. CV1 2AB"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              type="button"
              onClick={runCheck}
              style={{
                padding: "0 14px",
                borderRadius: radius.input,
                border: `1px solid ${color.border}`,
                background: color.surface,
                color: color.text,
                fontSize: font.sm,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Find hub
            </button>
          </div>
          {checkResult?.ok && (
            <p style={{ margin: 0, fontSize: font.xs, color: color.success }}>
              ✓ Area <strong>{checkResult.area}</strong> is served by <strong>{checkResult.hub.name}</strong>.
            </p>
          )}
          {checkResult && !checkResult.ok && (
            <p style={{ margin: 0, fontSize: font.xs, color: color.error, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {checkResult.message}
              {checkResult.area && isEditing && (
                <button
                  type="button"
                  onClick={() => { toggleArea(checkResult.area!); setCheckResult(null); }}
                  style={{
                    border: "none", background: "none", padding: 0,
                    color: color.error, fontSize: font.xs, fontWeight: 700,
                    textDecoration: "underline", cursor: "pointer",
                  }}
                >
                  Add {checkResult.area} to {draft.name || "this hub"}
                </button>
              )}
            </p>
          )}
        </div>
      )}

      {/* ── Advanced: the old postcode-dot editor, collapsed. It's the fiddly bulk tool for
             handing whole postcode areas between hubs — hidden by default so the panel stays clean. ── */}
      {!loading && !loadError && (
        <details style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
          <summary style={summaryStyle}>Edit catchments on a dot map (advanced)</summary>
          <div style={{ paddingTop: spacing.sm }}>
            <HubNetworkMap
              hubs={hubs}
              selectedHubId={isEditing ? draft.id : null}
              selectedCatchment={isEditing ? parseCatchment(draft.catchment) : []}
              onSelectHub={selectHub}
              onToggleArea={toggleArea}
              onAssignArea={assignAreaToNearestHub}
            />
          </div>
        </details>
      )}

      {/* ── Form ── */}
      <div style={embedded ? undefined : { borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
        <p
          style={{
            margin: `0 0 ${spacing.sm}px`,
            fontSize: font.xs,
            fontWeight: 600,
            color: isEditing ? color.text : color.muted,
          }}
        >
          {isEditing ? `Editing: ${draft.name || draft.id}` : "Add new hub"}
        </p>

        <label style={labelWrap}>
          <span style={labelText}>Hub name</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="e.g. Coventry Hub"
            style={inputStyle}
          />
          {isEditing && (
            <span style={{ fontSize: font.xs, color: color.muted }}>ID: {draft.id}</span>
          )}
        </label>

        <label style={{ ...labelWrap, marginTop: spacing.sm }}>
          <span style={labelText}>Catchment (the postcode areas this hub covers)</span>
          {parseCatchment(draft.catchment).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 2 }}>
              {parseCatchment(draft.catchment).map((area) => (
                <span key={area} style={chipStyle}>
                  {area}
                  <button
                    type="button"
                    onClick={() => toggleArea(area)}
                    aria-label={`Remove ${area} from catchment`}
                    style={chipRemoveStyle}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            type="text"
            value={draft.catchment}
            onChange={(e) => setDraft((d) => ({ ...d, catchment: e.target.value }))}
            placeholder="e.g. CV, B, LE"
            style={inputStyle}
          />
        </label>

        <div style={{ ...labelWrap, marginTop: spacing.sm }}>
          <span style={labelText}>Storage address (optional — where collection runs start &amp; end)</span>
          <PlacesInput
            value={draft.address}
            onChange={(val) => setDraft((d) => ({ ...d, address: val }))}
            onSelect={(s) => setDraft((d) => ({ ...d, address: s.label }))}
            placeholder="e.g. Unit 3, Hams Hall Distribution Park, B46 1AL"
            style={inputStyle}
          />
          {suggestedArea && (
            <button type="button" onClick={() => toggleArea(suggestedArea)} style={suggestionChipStyle}>
              This address is in area <strong>{suggestedArea}</strong> — add it to the catchment
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: spacing.md }}>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            style={{ ...primaryBtn, opacity: saving ? 0.6 : 1, cursor: saving ? "not-allowed" : "pointer" }}
          >
            {saving ? "Saving…" : isEditing ? "Update hub" : "Add hub"}
          </button>
          {isEditing && (
            <button type="button" onClick={() => setDraft(emptyDraft)} style={secondaryBtn}>
              Cancel
            </button>
          )}
        </div>

        {message && (
          <p
            role={message.ok ? undefined : "alert"}
            style={{
              fontSize: font.xs,
              marginTop: spacing.xs,
              color: message.ok ? color.success : color.error,
              margin: `${spacing.xs}px 0 0`,
            }}
          >
            {message.text}
          </p>
        )}
      </div>

      {/* ── Import from PDF (tier 3) — collapsed by default; rarely used ── */}
      <details style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
        <summary style={summaryStyle}>Import depots from a PDF</summary>
        <div style={{ paddingTop: spacing.sm }}>
        <p style={{ margin: `0 0 ${spacing.sm}px`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Upload a depot-list PDF. We read every location that has a postcode and list them below to
          review and edit — nothing is saved until you click Add. Each depot starts covering only its
          own postcode area; set its full catchment before adding. Depots listed without a postcode
          aren&rsquo;t detected — add those with the form above.
        </p>
        <input
          type="file"
          accept="application/pdf"
          disabled={importing}
          aria-label="Depot-list PDF"
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
            <p style={{ margin: 0, fontSize: font.xs, fontWeight: 600, color: color.text }}>
              {candidates.length} candidate hub{candidates.length !== 1 ? "s" : ""} — review, edit &amp; add
            </p>
            {candidates.map((c) => (
              <div
                key={c.id}
                style={{
                  border: `1px solid ${c.warning ? color.review.border : color.border}`,
                  background: c.warning ? color.review.bg : "transparent",
                  borderRadius: radius.input,
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                  <label style={{ ...labelWrap, flex: 2, minWidth: 0 }}>
                    <span style={labelText}>Depot name</span>
                    <input
                      type="text"
                      value={c.name}
                      onChange={(e) => editCandidate(c.id, { name: e.target.value })}
                      placeholder="e.g. Birmingham Hub"
                      aria-label="Depot name"
                      style={inputStyle}
                    />
                  </label>
                  <label style={{ ...labelWrap, flex: 1, minWidth: 0 }}>
                    <span style={labelText}>Catchment</span>
                    <input
                      type="text"
                      value={c.catchmentText}
                      onChange={(e) => editCandidate(c.id, { catchmentText: e.target.value })}
                      placeholder="CV, B, LE"
                      aria-label="Catchment postcode areas"
                      style={inputStyle}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void addCandidate(c)}
                    style={{ ...primaryBtn, flexShrink: 0, padding: "7px 12px" }}
                  >
                    Add
                  </button>
                </div>
                {c.warning && (
                  <p style={{ margin: 0, fontSize: font.xs, color: color.review.fg }}>{c.warning}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {duplicates.length > 0 && (
          <div
            style={{
              marginTop: spacing.sm,
              border: `1px solid ${color.review.border}`,
              background: color.review.bg,
              borderRadius: radius.input,
              padding: "8px 10px",
            }}
          >
            <p style={{ margin: `0 0 ${spacing.xs}px`, fontSize: font.xs, fontWeight: 600, color: color.review.fg }}>
              {duplicates.length} more depot{duplicates.length !== 1 ? "s" : ""} share an area we already
              listed
            </p>
            <p style={{ margin: `0 0 ${spacing.xs}px`, fontSize: font.xs, color: color.review.fg, lineHeight: 1.5 }}>
              Each postcode area belongs to one hub, so these weren&rsquo;t added automatically. If one is
              the right depot for its area, add it with the form above.
            </p>
            <ul style={{ margin: 0, paddingLeft: 16, fontSize: font.xs, color: color.review.fg, lineHeight: 1.6 }}>
              {duplicates.map((d, i) => (
                <li key={`${d.area}-${i}`}>
                  <span style={{ fontWeight: 600 }}>{d.area}</span> — {d.text}
                </li>
              ))}
            </ul>
          </div>
        )}
        </div>
      </details>

      {/* ── Hub list ── */}
      <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.sm }}>
        {loading ? (
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>Loading hubs…</p>
        ) : loadError ? (
          <p role="alert" style={{ margin: 0, fontSize: font.xs, color: color.error }}>{loadError}</p>
        ) : (
          <>
            <p style={{ margin: `0 0 ${spacing.sm}px`, fontSize: font.xs, fontWeight: 600, color: color.muted }}>
              {hubs.length === 0 ? "No hubs configured yet" : `${hubs.length} hub${hubs.length !== 1 ? "s" : ""} — click to edit`}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflow: "auto" }}>
              {hubs.map((h) => (
                <div
                  key={h.id}
                  style={{
                    border: `1px solid ${draft.id === h.id ? color.text : color.border}`,
                    borderRadius: radius.badge,
                    padding: "10px 10px 10px 12px",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: draft.id === h.id ? color.surfaceSub : "transparent",
                    transition: "background 0.1s",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => selectHub(h)}
                    style={{
                      border: "none",
                      background: "transparent",
                      padding: 0,
                      color: color.text,
                      cursor: "pointer",
                      textAlign: "left",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontWeight: 600, fontSize: font.sm, color: color.text }}>{h.name}</span>
                    </div>
                    <div style={{ fontSize: font.xs, color: color.muted, marginTop: 1 }}>{h.id}</div>
                    <div style={{ fontSize: font.xs, color: color.muted, marginTop: 2 }}>
                      {h.catchment.join(", ")}
                    </div>
                    <div style={{ fontSize: font.xs, color: h.address ? color.muted : color.review.fg, marginTop: 2 }}>
                      {h.address ?? "No storage address set — needed before planning a collection run"}
                    </div>
                  </button>

                  {confirmDeleteId === h.id ? (
                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={() => del(h.id)}
                        style={{
                          ...secondaryBtn,
                          background: color.fragile.bg,
                          color: color.error,
                          borderColor: color.fragile.border,
                          padding: "4px 8px",
                        }}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        style={{ ...secondaryBtn, padding: "4px 8px" }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(h.id)}
                      style={{ ...secondaryBtn, flexShrink: 0, padding: "4px 8px" }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: font.xs,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: color.muted,
  margin: "0 0 2px",
};
const summaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontSize: font.xs,
  fontWeight: 600,
  color: color.muted,
  userSelect: "none",
};
const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  fontSize: font.xs,
  fontWeight: 600,
  color: color.text,
  background: color.surfaceSub,
  border: `1px solid ${color.border}`,
  borderRadius: radius.badge,
  padding: "2px 4px 2px 8px",
};
const chipRemoveStyle: React.CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  color: color.muted,
  fontSize: font.sm,
  lineHeight: 1,
  padding: "0 2px",
};
const suggestionChipStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  border: `1px solid ${color.accent}`,
  background: color.surface,
  color: color.accentDark,
  borderRadius: radius.badge,
  padding: "4px 10px",
  fontSize: font.xs,
  fontWeight: 600,
  cursor: "pointer",
};
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
