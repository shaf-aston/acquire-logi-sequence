"use client";

import { useCallback, useEffect, useState } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { ACTIONS_BY_STATUS } from "@/lib/groupage-ops/state-machine";
import type { Shipment, ShipmentStatus, ShipmentAction } from "@/lib/groupage-ops/lifecycle.types";
import type { Manifest } from "@/lib/groupage-ops/manifest";

/** Actions where the operator may attach a POD reference / reason before confirming. */
const NOTE_ACTIONS = new Set<ShipmentAction>(["deliver", "failDelivery", "returnToSender", "cancel"]);

/** "arriveOriginDepot" → "Arrive Origin Depot" — cosmetic only, not a domain rule. */
function humanizeAction(action: ShipmentAction): string {
  const spaced = action.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const EXCEPTION_STATUSES = new Set<ShipmentStatus>([
  "return-to-sender",
  "failed-delivery",
  "at-hub-awaiting-space",
  "cancelled",
]);

/** Destructive/exception lifecycle transitions — rendered with the danger button style. */
const DANGER_ACTIONS = new Set<ShipmentAction>(["failDelivery", "returnToSender", "cancel"]);

function statusBadgeStyle(status: ShipmentStatus): React.CSSProperties {
  if (status === "complete") {
    return { ...badgeBase, background: color.success, color: color.surface, border: `1px solid ${color.success}` };
  }
  if (EXCEPTION_STATUSES.has(status)) {
    return { ...badgeBase, background: color.fragile.bg, color: color.error, border: `1px solid ${color.fragile.border}` };
  }
  return { ...badgeBase, background: color.surfaceSub, color: color.muted, border: `1px solid ${color.border}` };
}

interface PendingAction {
  shipmentId: string;
  action: ShipmentAction;
}

export function ShipmentsBoard({
  embedded = false,
  onCount,
  refreshKey = 0,
}: {
  /** True when hosted inside a collapsible sidebar card — drops the board's own card chrome. */
  embedded?: boolean;
  /** Reports the loaded shipment count so the host can badge its header. */
  onCount?: (n: number) => void;
  /** Bump to force a reload (e.g. after a booking elsewhere on the page). */
  refreshKey?: number;
} = {}) {
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [noteText, setNoteText] = useState("");
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});

  const loadAll = useCallback(async () => {
    setLoadError(null);
    try {
      const [shipmentsRes, manifestsRes] = await Promise.all([
        fetch("/api/shipments"),
        fetch("/api/manifests"),
      ]);
      const shipmentsData = (await shipmentsRes.json()) as { shipments?: Shipment[]; error?: string };
      const manifestsData = (await manifestsRes.json()) as { manifests?: Manifest[]; error?: string };
      if (!shipmentsRes.ok || shipmentsData.error) {
        throw new Error(shipmentsData.error ?? "Failed to load shipments.");
      }
      if (!manifestsRes.ok || manifestsData.error) {
        throw new Error(manifestsData.error ?? "Failed to load manifests.");
      }
      setShipments(shipmentsData.shipments ?? []);
      setManifests(manifestsData.manifests ?? []);
      onCount?.(shipmentsData.shipments?.length ?? 0);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load shipment data.");
    } finally {
      setLoading(false);
    }
  }, [onCount]);

  useEffect(() => {
    loadAll();
  }, [refreshKey, loadAll]);

  const toggleHistory = (id: string) => {
    setExpandedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runAction = async (shipmentId: string, action: ShipmentAction, note?: string) => {
    setActionErrors((prev) => ({ ...prev, [shipmentId]: "" }));
    setSubmittingId(shipmentId);
    try {
      const res = await fetch(`/api/shipments/${shipmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(note ? { note } : {}) }),
      });
      const data = (await res.json()) as
        | { success: true; shipment: Shipment }
        | { success: false; error: string };
      if (data.success) {
        setPendingAction(null);
        setNoteText("");
        await loadAll();
      } else {
        setActionErrors((prev) => ({ ...prev, [shipmentId]: data.error }));
      }
    } catch (err) {
      setActionErrors((prev) => ({
        ...prev,
        [shipmentId]: err instanceof Error ? err.message : "Action failed.",
      }));
    } finally {
      setSubmittingId(null);
    }
  };

  const onActionClick = (shipmentId: string, action: ShipmentAction) => {
    if (NOTE_ACTIONS.has(action)) {
      setPendingAction({ shipmentId, action });
      setNoteText("");
      return;
    }
    runAction(shipmentId, action);
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
          <p style={sectionLabel}>Operations · tracking</p>
          <h3 style={{ margin: 0, fontSize: font.md, color: color.text, fontWeight: 700, letterSpacing: "-0.01em" }}>
            Shipments
          </h3>
          <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
            Modeled lifecycle — &apos;scans&apos; are status updates, not hardware. Advance a shipment through
            collection, trunk, and delivery.
          </p>
        </div>
      )}

      {/* ── Shipment list ── */}
      <div style={embedded ? undefined : { borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
        {loading ? (
          <p style={{ fontSize: font.sm, color: color.muted, margin: 0 }}>Loading shipments…</p>
        ) : loadError ? (
          <ErrorBanner>{loadError}</ErrorBanner>
        ) : shipments.length === 0 ? (
          <p style={{ fontSize: font.sm, color: color.muted, margin: 0 }}>No shipments booked yet</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
            {shipments.map((s) => {
              const actions = ACTIONS_BY_STATUS[s.status] ?? [];
              const isSubmitting = submittingId === s.id;
              const actionError = actionErrors[s.id];
              const historyOpen = expandedHistory.has(s.id);
              const pending = pendingAction?.shipmentId === s.id ? pendingAction : null;
              return (
                <div
                  key={s.id}
                  style={{
                    border: `1px solid ${color.border}`,
                    borderRadius: radius.badge,
                    padding: "12px 14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 600, fontSize: font.sm, color: color.text }}>{s.id}</span>
                      <span style={statusBadgeStyle(s.status)}>{s.status}</span>
                      {s.isLocal && <span style={mutedBadge}>Local</span>}
                    </div>
                    <span style={{ fontSize: font.sm, fontWeight: 700, color: color.text }}>
                      {s.currencySymbol}
                      {s.total.toFixed(2)}
                    </span>
                  </div>

                  <div style={{ fontSize: font.xs, color: color.muted }}>
                    {s.originPostcode} → {s.destinationPostcode}
                  </div>
                  <div style={{ fontSize: font.xs, color: color.muted }}>
                    {s.demand.palletCount} pallets · {s.demand.footprints} spaces · {s.demand.weightKg} kg
                  </div>
                  <div style={{ display: "flex", gap: 12, fontSize: font.xs, color: color.muted }}>
                    <span>{s.eta ? `ETA: ${s.eta}` : "no ETA"}</span>
                    <span>Attempts: {s.deliveryAttempts}</span>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    {actions.length === 0 ? (
                      <span style={{ fontSize: font.xs, color: color.muted, fontStyle: "italic" }}>
                        Terminal — no further actions
                      </span>
                    ) : (
                      actions.map((action) => (
                        <button
                          key={action}
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => onActionClick(s.id, action)}
                          style={{
                            ...(DANGER_ACTIONS.has(action) ? dangerBtn : secondaryBtn),
                            opacity: isSubmitting ? 0.6 : 1,
                          }}
                        >
                          {humanizeAction(action)}
                        </button>
                      ))
                    )}
                  </div>

                  {/* Inline note + confirm for note-bearing actions */}
                  {pending && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 2 }}>
                      <input
                        type="text"
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Optional note (POD reference / reason)"
                        aria-label="Note (POD reference or reason)"
                        style={{ ...inputStyle, flex: 1, minWidth: 180 }}
                      />
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => runAction(s.id, pending.action, noteText.trim() === "" ? undefined : noteText.trim())}
                        style={primaryBtn}
                      >
                        Confirm {humanizeAction(pending.action)}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingAction(null);
                          setNoteText("");
                        }}
                        style={secondaryBtn}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {actionError && (
                    <ErrorBanner style={{ padding: "6px 8px" }}>
                      {actionError}
                    </ErrorBanner>
                  )}

                  {/* History */}
                  <div>
                    <button type="button" onClick={() => toggleHistory(s.id)} style={linkBtn}>
                      {historyOpen ? "Hide history" : `History (${s.history.length})`}
                    </button>
                    {historyOpen && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
                        {s.history.map((ev, i) => (
                          <span key={i} style={{ fontSize: font.xs, color: color.muted }}>
                            {ev.action}: {ev.from ?? "—"} → {ev.to}
                            {ev.note ? ` (${ev.note})` : ""}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Manifest panel ── */}
      <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
        <p style={fieldGroupLabel}>Active leg manifests</p>
        {loading ? (
          <p style={{ fontSize: font.sm, color: color.muted, margin: 0 }}>Loading manifests…</p>
        ) : manifests.length === 0 ? (
          <p style={{ fontSize: font.sm, color: color.muted, margin: 0 }}>No active legs</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {manifests.map((m) => {
              const overCapacity = m.usedFootprints > m.capacity.palletSpaces || m.usedWeightKg > m.capacity.maxPayloadKg;
              return (
                <div
                  key={m.legKey}
                  style={{
                    border: `1px solid ${overCapacity ? color.fragile.border : color.border}`,
                    background: overCapacity ? color.fragile.bg : "transparent",
                    borderRadius: radius.badge,
                    padding: "8px 12px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, fontSize: font.sm, color: color.text, textTransform: "capitalize" }}>
                      {m.kind}
                    </span>
                    <span style={{ fontSize: font.xs, color: color.muted, marginLeft: 6 }}>
                      {m.from} → {m.to}
                    </span>
                  </div>
                  <span style={{ fontSize: font.xs, color: overCapacity ? color.error : color.muted, fontWeight: overCapacity ? 600 : 400 }}>
                    {m.usedFootprints} / {m.capacity.palletSpaces} spaces · {m.usedWeightKg} / {m.capacity.maxPayloadKg} kg · {m.count} shipments
                    {overCapacity ? " · Over capacity" : ""}
                  </span>
                </div>
              );
            })}
          </div>
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
const fieldGroupLabel: React.CSSProperties = {
  fontSize: font.xs,
  fontWeight: 600,
  color: color.muted,
  margin: `0 0 ${spacing.xs}px`,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const inputStyle: React.CSSProperties = {
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
const dangerBtn: React.CSSProperties = {
  ...baseBtn,
  background: color.fragile.bg,
  color: color.error,
  border: `1px solid ${color.fragile.border}`,
};
const linkBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  color: color.muted,
  fontSize: font.xs,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "underline",
};
const badgeBase: React.CSSProperties = {
  display: "inline-block",
  fontSize: font.xs,
  fontWeight: 600,
  borderRadius: radius.badge,
  padding: "2px 8px",
};
const mutedBadge: React.CSSProperties = {
  display: "inline-block",
  fontSize: font.xs,
  fontWeight: 600,
  color: color.muted,
  background: color.surfaceSub,
  border: `1px solid ${color.border}`,
  borderRadius: radius.badge,
  padding: "2px 8px",
};
