"use client";

import { useState } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import { useVanSession } from "@/lib/hooks/use-van-session";
import type { Van } from "@/lib/packing/packing.types";

const emptyVan: Van = {
  id: "",
  label: "",
  interior: { l: 0, w: 0, h: 0 },
  maxPayloadKg: 0,
  fuelCostPerMile: 0,
  perMileRate: 0,
  co2GramsPerMile: 0,
};

function getField(draft: Van, key: string): string | number {
  if (key === "interior.l") return draft.interior.l || "";
  if (key === "interior.w") return draft.interior.w || "";
  if (key === "interior.h") return draft.interior.h || "";
  const val = draft[key as keyof Van] as string | number | undefined;
  return val ?? (key === "id" || key === "label" || key === "sizeClass" ? "" : "");
}

function setField(draft: Van, key: string, raw: string): Van {
  if (key === "interior.l") return { ...draft, interior: { ...draft.interior, l: Number(raw) } };
  if (key === "interior.w") return { ...draft, interior: { ...draft.interior, w: Number(raw) } };
  if (key === "interior.h") return { ...draft, interior: { ...draft.interior, h: Number(raw) } };
  const k = key as keyof Van;
  if (k === "id" || k === "label") return { ...draft, [k]: raw } as Van;
  if (k === "sizeClass") return { ...draft, sizeClass: raw === "" ? undefined : raw };
  return { ...draft, [k]: raw === "" ? undefined : Number(raw) } as Van;
}

function validateDraft(draft: Van): string | null {
  if (!draft.id.trim()) return "Van ID is required.";
  if (!draft.label.trim()) return "Display name is required.";
  if (!draft.interior.l || !draft.interior.w || !draft.interior.h)
    return "All interior dimensions must be greater than 0.";
  if (!draft.maxPayloadKg) return "Max payload must be greater than 0.";
  return null;
}

export function VanConfigPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { vans, addVan, updateVan, removeVan } = useVanSession();
  const [draft, setDraft] = useState<Van>(emptyVan);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const isEditing = draft.id !== "" && vans.some((v) => v.id === draft.id);
  const sizeClasses = Array.from(
    new Set(vans.map((v) => v.sizeClass).filter((c): c is string => !!c)),
  ).sort();

  const save = () => {
    setMessage(null);
    const err = validateDraft(draft);
    if (err) { setMessage({ text: err, ok: false }); return; }
    if (isEditing) {
      updateVan(draft);
      setMessage({ text: "Van updated.", ok: true });
    } else {
      const addErr = addVan(draft);
      if (addErr) { setMessage({ text: addErr, ok: false }); return; }
      setMessage({ text: "Van added to this session.", ok: true });
    }
    setDraft(emptyVan);
  };

  const del = (id: string) => {
    removeVan(id);
    if (draft.id === id) setDraft(emptyVan);
    setConfirmDeleteId(null);
    setMessage({ text: "Removed from this session.", ok: true });
  };

  const field = (
    key: string,
    label: string,
    placeholder: string,
    type: "text" | "number",
    opts?: { step?: string; min?: string },
  ) => (
    <label key={key} style={labelWrap}>
      <span style={labelText}>{label}</span>
      <input
        type={type}
        value={getField(draft, key)}
        onChange={(e) => setDraft((d) => setField(d, key, e.target.value))}
        placeholder={placeholder}
        step={opts?.step}
        min={opts?.min}
        style={inputStyle}
      />
    </label>
  );

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
        <p style={sectionLabel}>Fleet setup · this session</p>
        <h3 style={{ margin: 0, fontSize: font.md, color: color.text, fontWeight: 700, letterSpacing: "-0.01em" }}>
          Van catalogue
        </h3>
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Add or remove vans for this session — changes are not saved permanently. Reload to reset.
          Size class is auto-assigned from volume when left blank.
        </p>
      </div>
      )}
      {embedded && (
        <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Add or remove vans for this session — changes are not saved permanently. Reload to reset.
          Size class is auto-assigned from volume when left blank.
        </p>
      )}

      {/* ── Form ── */}
      <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
        <p
          style={{
            margin: `0 0 ${spacing.sm}px`,
            fontSize: font.xs,
            fontWeight: 600,
            color: isEditing ? color.text : color.muted,
          }}
        >
          {isEditing ? `Editing: ${draft.label || draft.id}` : "Add new van"}
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {field("id", "Van ID", "e.g. transit-l2", "text")}
          {field("label", "Display name", "e.g. Transit L2", "text")}
        </div>

        <label style={{ ...labelWrap, marginTop: spacing.sm }}>
          <span style={labelText}>Size class (auto-assigned if blank)</span>
          <input
            list="van-size-classes"
            value={getField(draft, "sizeClass")}
            onChange={(e) => setDraft((d) => setField(d, "sizeClass", e.target.value))}
            placeholder="e.g. Small · Medium · Large · Luton · Box truck"
            style={inputStyle}
          />
          <datalist id="van-size-classes">
            {sizeClasses.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>

        <p style={fieldGroupLabel}>Capacity &amp; pricing</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {field("maxPayloadKg", "Max payload (kg)", "e.g. 800", "number", { min: "0" })}
          {field("quantity", "Qty available", "e.g. 3", "number", { min: "1" })}
          {field("perMileRate", "Rate (£/mi)", "e.g. 0.90", "number", { min: "0", step: "0.01" })}
          {field("fuelCostPerMile", "Fuel cost (£/mi)", "e.g. 0.21", "number", { min: "0", step: "0.01" })}
          {field("co2GramsPerMile", "CO₂ (g/mi)", "e.g. 306", "number", { min: "0", step: "1" })}
        </div>

        <p style={fieldGroupLabel}>Interior dimensions (m)</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {field("interior.l", "Length", "e.g. 2.85", "number", { min: "0", step: "0.01" })}
          {field("interior.w", "Width", "e.g. 1.80", "number", { min: "0", step: "0.01" })}
          {field("interior.h", "Height", "e.g. 2.05", "number", { min: "0", step: "0.01" })}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: spacing.md }}>
          <button type="button" onClick={save} style={primaryBtn}>
            {isEditing ? "Update van" : "Add van"}
          </button>
          {isEditing && (
            <button type="button" onClick={() => setDraft(emptyVan)} style={secondaryBtn}>
              Cancel
            </button>
          )}
        </div>

        {message && (
          <p
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

      {/* ── Van list ── */}
      <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.sm }}>
        <p style={{ margin: `0 0 ${spacing.sm}px`, fontSize: font.xs, fontWeight: 600, color: color.muted }}>
          {vans.length === 0 ? "No vans configured yet" : `${vans.length} van${vans.length !== 1 ? "s" : ""} — click to edit`}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflow: "auto" }}>
          {vans.map((v) => (
            <div
              key={v.id}
              style={{
                border: `1px solid ${draft.id === v.id ? color.text : color.border}`,
                borderRadius: radius.badge,
                padding: "10px 10px 10px 12px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: draft.id === v.id ? color.surfaceSub : "transparent",
                transition: "background 0.1s",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setDraft(v);
                  setConfirmDeleteId(null);
                  setMessage(null);
                }}
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
                  <span style={{ fontWeight: 600, fontSize: font.sm, color: color.text }}>{v.label}</span>
                  {v.sizeClass && (
                    <span
                      style={{
                        fontSize: font.xs,
                        fontWeight: 600,
                        color: color.muted,
                        background: color.surfaceSub,
                        border: `1px solid ${color.border}`,
                        borderRadius: radius.badge,
                        padding: "1px 6px",
                      }}
                    >
                      {v.sizeClass}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: font.xs, color: color.muted, marginTop: 1 }}>{v.id}</div>
                <div style={{ fontSize: font.xs, color: color.muted, marginTop: 2 }}>
                  {v.interior.l.toFixed(2)} × {v.interior.w.toFixed(2)} × {v.interior.h.toFixed(2)} m
                  {" · "}
                  {v.maxPayloadKg} kg
                  {v.quantity != null ? ` · qty ${v.quantity}` : ""}
                  {" · £"}
                  {v.perMileRate.toFixed(2)}/mi
                </div>
              </button>

              {confirmDeleteId === v.id ? (
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => del(v.id)}
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
                  onClick={() => setConfirmDeleteId(v.id)}
                  style={{ ...secondaryBtn, flexShrink: 0, padding: "4px 8px" }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
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
  margin: `${spacing.md}px 0 ${spacing.xs}px`,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
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
