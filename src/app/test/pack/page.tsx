"use client";

import { useEffect, useState } from "react";
import { color, font, spacing, radius, buttonPrimary, buttonSecondary } from "@/styles/tokens";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { PackingResultPanel } from "@/components/results/PackingResultPanel";
import type { Van, PackingResult } from "@/lib/packing/packing.types";
import type { PackedItem, UnplacedItem } from "@/types/api";

/* ── Types ─────────────────────────────────────────────────────────────── */

interface TestItem {
  id: string;
  name: string;
  l: number;
  w: number;
  h: number;
  weightKg: number;
  quantity: number;
  fragility: "standard" | "fragile";
  category: string;
  stackable: boolean;
  canSupportWeightKg: number;
  orientationLock: "fixed" | "partial" | "none";
  durabilityTier: "none" | "low" | "medium" | "high";
  brittle: boolean;
  deformable: boolean;
}

interface DirectPackResponse {
  success: boolean;
  error?: string;
  items: PackedItem[];
  fleet: PackingResult[];
  selected: PackingResult;
  fitsInSingleVan: boolean;
  unplaced: UnplacedItem[];
  reasons: Record<string, string>;
  packableUnits: number;
  toleranceM?: number;
  maxReachHeightM?: number;
}

/* ── Preset fixtures ────────────────────────────────────────────────────── */

const PRESETS: Omit<TestItem, "id" | "quantity">[] = [
  { name: "Base cabinet",   l: 600,  w: 600, h: 700,  weightKg: 30, fragility: "standard", category: "base-cabinet", stackable: true,  canSupportWeightKg: 80, orientationLock: "none",  durabilityTier: "medium", brittle: false, deformable: false },
  { name: "Wall cabinet",   l: 800,  w: 400, h: 720,  weightKg: 18, fragility: "standard", category: "wall-cabinet", stackable: true,  canSupportWeightKg: 40, orientationLock: "none",  durabilityTier: "medium", brittle: false, deformable: false },
  { name: "Tall unit",      l: 600,  w: 580, h: 2100, weightKg: 55, fragility: "standard", category: "tall-unit",    stackable: false, canSupportWeightKg: 0,  orientationLock: "fixed", durabilityTier: "high",   brittle: false, deformable: false },
  { name: "Appliance",      l: 900,  w: 600, h: 850,  weightKg: 65, fragility: "standard", category: "appliance",    stackable: true,  canSupportWeightKg: 60, orientationLock: "partial", durabilityTier: "medium", brittle: false, deformable: false },
  { name: "Fragile mirror", l: 1200, w: 30,  h: 800,  weightKg: 8,  fragility: "fragile",  category: "accessory",    stackable: false, canSupportWeightKg: 0,  orientationLock: "fixed", durabilityTier: "low",    brittle: true,  deformable: false },
];

// Presets carry human-friendly millimetres (e.g. 600×600×700), but the packer —
// like every other dimension in the system (van interiors, placements, tolerance)
// — works in METRES. Convert at this boundary; without it a 600mm box is read as
// 600m and fits no van, so the harness placed nothing.
const MM_PER_M = 1000;

function toApiItem(item: TestItem) {
  return {
    id: item.id,
    name: item.name,
    dimensions: { l: item.l / MM_PER_M, w: item.w / MM_PER_M, h: item.h / MM_PER_M },
    weightKg: item.weightKg,
    quantity: item.quantity,
    fragility: item.fragility,
    category: item.category,
    stackable: item.stackable,
    canSupportWeightKg: item.canSupportWeightKg,
    orientationLock: item.orientationLock,
    durabilityTier: item.durabilityTier,
    brittle: item.brittle,
    deformable: item.deformable,
    material: null,
  };
}

/* ── Component ──────────────────────────────────────────────────────────── */

export default function PackTestPage() {
  const [vans, setVans] = useState<Van[]>([]);
  const [selectedVanId, setSelectedVanId] = useState<string>("__auto__");
  const [items, setItems] = useState<TestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DirectPackResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load vans on mount
  useEffect(() => {
    fetch("/api/vans")
      .then((r) => r.json())
      .then((d) => { if (d.vans) setVans(d.vans); })
      .catch(() => setError("Could not load van list."));
  }, []);

  const addPreset = (preset: Omit<TestItem, "id" | "quantity">) => {
    setItems((prev) => [
      ...prev,
      { ...preset, id: crypto.randomUUID(), quantity: 1 },
    ]);
  };

  const removeItem = (id: string) => setItems((prev) => prev.filter((i) => i.id !== id));

  const setQty = (id: string, qty: number) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, quantity: Math.max(1, Math.min(9, qty)) } : i)));

  const pack = async () => {
    if (items.length === 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const body: { items: ReturnType<typeof toApiItem>[]; vanId?: string } = {
        items: items.map(toApiItem),
      };
      if (selectedVanId !== "__auto__") body.vanId = selectedVanId;

      const res = await fetch("/api/pack/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: DirectPackResponse = await res.json();
      if (data.success) setResult(data);
      else setError(data.error ?? "Packing failed.");
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: color.pageBg, padding: spacing.xl }}>
      {/* Header */}
      <div style={{ marginBottom: spacing.xl }}>
        <p style={{ margin: 0, fontSize: font.xs, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: color.muted }}>
          Dev — Stage 3
        </p>
        <h1 style={{ margin: 0, fontSize: font.lg, fontWeight: 700, color: color.text, letterSpacing: "-0.02em" }}>
          Packing Test Harness
        </h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: spacing.xl, alignItems: "start" }}>

        {/* ── Left panel ─────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>

          {/* Van selector */}
          <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.card, padding: spacing.lg }}>
            <p style={{ margin: `0 0 ${spacing.sm}px`, fontSize: font.xs, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: color.muted }}>
              Van
            </p>
            <select
              value={selectedVanId}
              onChange={(e) => setSelectedVanId(e.target.value)}
              style={{
                width: "100%", padding: "8px 12px", borderRadius: radius.input,
                border: `1px solid ${color.border}`, background: color.surface,
                color: color.text, fontSize: font.base, cursor: "pointer",
              }}
            >
              <option value="__auto__">— Auto (rank all) —</option>
              {vans.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
            {selectedVanId !== "__auto__" && (() => {
              const v = vans.find((v) => v.id === selectedVanId);
              return v ? (
                <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.muted }}>
                  {v.interior.l.toFixed(2)} × {v.interior.w.toFixed(2)} × {v.interior.h.toFixed(2)} m · {v.maxPayloadKg} kg
                </p>
              ) : null;
            })()}
          </div>

          {/* Preset chips */}
          <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.card, padding: spacing.lg }}>
            <p style={{ margin: `0 0 ${spacing.sm}px`, fontSize: font.xs, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: color.muted }}>
              Add preset items
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.xs }}>
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => addPreset(preset)}
                  style={{
                    ...buttonSecondary(false),
                    padding: "5px 12px",
                    fontSize: font.xs,
                    borderColor: preset.fragility === "fragile" ? color.fragile.border : color.border,
                    color: preset.fragility === "fragile" ? color.fragile.fg : color.text,
                    background: preset.fragility === "fragile" ? color.fragile.bg : color.surface,
                  }}
                >
                  + {preset.name}
                </button>
              ))}
            </div>
          </div>

          {/* Item list */}
          {items.length > 0 && (
            <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.card, padding: spacing.lg }}>
              <p style={{ margin: `0 0 ${spacing.sm}px`, fontSize: font.xs, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: color.muted }}>
                Items ({items.length})
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
                {items.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      display: "flex", alignItems: "center", gap: spacing.xs,
                      padding: `${spacing.xs}px ${spacing.sm}px`,
                      background: item.fragility === "fragile" ? color.fragile.bg : color.surfaceSub,
                      border: `1px solid ${item.fragility === "fragile" ? color.fragile.border : color.border}`,
                      borderRadius: radius.input,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>{item.name}</span>
                      <span style={{ fontSize: font.xs, color: color.muted, marginLeft: spacing.xs }}>
                        {item.l}×{item.w}×{item.h}
                      </span>
                    </div>
                    {/* Qty spinner */}
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <button
                        onClick={() => setQty(item.id, item.quantity - 1)}
                        style={{ ...buttonSecondary(false), padding: "2px 8px", fontSize: font.sm }}
                      >−</button>
                      <span style={{ fontSize: font.sm, minWidth: 16, textAlign: "center", color: color.text }}>{item.quantity}</span>
                      <button
                        onClick={() => setQty(item.id, item.quantity + 1)}
                        style={{ ...buttonSecondary(false), padding: "2px 8px", fontSize: font.sm }}
                      >+</button>
                    </div>
                    <button
                      onClick={() => removeItem(item.id)}
                      style={{ ...buttonSecondary(false), padding: "2px 8px", fontSize: font.sm, color: color.muted, border: "none" }}
                      aria-label="Remove"
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pack button */}
          <button
            onClick={pack}
            disabled={loading || items.length === 0}
            style={{ ...buttonPrimary(loading || items.length === 0), justifyContent: "center", padding: "11px 0" }}
          >
            {loading ? "Packing…" : "Pack"}
          </button>

          {error && (
            <ErrorBanner style={{ fontSize: font.sm, padding: `${spacing.xs}px ${spacing.sm}px` }}>
              {error}
            </ErrorBanner>
          )}
        </div>

        {/* ── Right panel ─────────────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>

          {!result && !loading && (
            <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius.card, padding: `${spacing.xxl}px ${spacing.xl}px`, textAlign: "center" }}>
              <p style={{ margin: 0, color: color.muted, fontSize: font.base }}>Add items and click Pack to see results.</p>
            </div>
          )}

          {result && (
            <PackingResultPanel
              fleet={result.fleet?.length ? result.fleet : [result.selected]}
              items={result.items ?? []}
              unplaced={result.unplaced ?? []}
              reasons={result.reasons ?? {}}
              fitsInSingleVan={result.fitsInSingleVan}
              packableUnits={result.packableUnits}
              toleranceM={result.toleranceM}
              maxReachHeightM={result.maxReachHeightM}
            />
          )}
        </div>
      </div>
    </div>
  );
}
