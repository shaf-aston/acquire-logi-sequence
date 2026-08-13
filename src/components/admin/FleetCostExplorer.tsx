"use client";

import { useMemo, useState } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import { smartNum } from "@/lib/fmt";
import { volumeM3 } from "@/lib/packing/geometry";
import { useVanSession } from "@/lib/hooks/use-van-session";
import type { Van } from "@/lib/packing/packing.types";

/**
 * What-if fleet sandbox. After a quote exists this lets an operator brainstorm a
 * DIFFERENT mix of vehicle bands for the SAME trip — "the computer picked two mediums,
 * what if I used one large + one small?" — and instantly see whether it still fits the
 * load and what it costs versus the fleet the computer actually chose.
 *
 * Deliberately simple: the distance is the real trip (return included, fixed — no
 * slider), the catalogue is size-class BANDS not 20 individual vans, and feasibility is
 * a plain volume + payload check on the running total. Compare-only — the live quote is
 * never touched. To change what's actually carried, edit the 3D load plan above.
 */

/** The quoted load a combo must be able to carry. */
type Load = { volumeM3: number; weightKg: number };

/** Floating-point slack so a fleet sized exactly to the load isn't rejected. */
const FIT_EPS = 1e-6;

/**
 * Available units of a van. A van stating no `quantity` falls back to the fleet-wide default, which
 * is the SERVER's business knob (`packing.defaultVanQuantity`) and arrives with the fleet — this
 * estimator must never invent its own, or it would price a fleet the allocator does not believe in.
 */
function qtyOf(v: Van, defaultQuantity: number): number {
  return v.quantity ?? defaultQuantity;
}

/** Cost + capacity of a set of van ids over the fixed trip distance. */
function fleetCost(ids: string[], byId: Map<string, Van>, miles: number) {
  let perMile = 0;
  for (const id of ids) {
    const v = byId.get(id);
    if (!v) continue;
    perMile += v.perMileRate + (v.fuelCostPerMile ?? 0);
  }
  return { total: perMile * miles };
}

/** One selectable band: a size class represented by its most-capable available van. */
type Band = {
  key: string;
  rep: Van; // largest van in the band — the unit added by the stepper
  available: number; // total units across every van in the band
};

/** Summarise a list of van ids as "2× Medium · 1× Large", grouped by size class. */
function summariseBands(ids: string[], byId: Map<string, Van>): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const v = byId.get(id);
    if (!v) continue;
    const key = v.sizeClass ?? "Other";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([cls, n]) => `${n}× ${cls}`).join(" · ") || "—";
}

export function FleetCostExplorer({
  load,
  tripMiles,
  recommended,
}: {
  load: Load;
  tripMiles: number;
  recommended: string[];
}) {
  const { vans, defaultVanQuantity, loadError, reload } = useVanSession();
  // How many units of each band the operator has picked for the what-if combo.
  const [picked, setPicked] = useState<Map<string, number>>(new Map());

  const byId = useMemo(() => new Map(vans.map((v) => [v.id, v])), [vans]);

  // Collapse the fleet to size-class bands, smallest-first. Each band is represented by
  // its largest available van (most capacity per unit) and carries the band's total
  // availability so the stepper can be bounded.
  const bands = useMemo<Band[]>(() => {
    // No fleet default yet (the fleet is still loading) — show no bands rather than assume a number.
    if (defaultVanQuantity === null) return [];
    const groups = new Map<string, Van[]>();
    for (const v of vans) {
      const key = v.sizeClass ?? "Other";
      const arr = groups.get(key) ?? [];
      arr.push(v);
      groups.set(key, arr);
    }
    const out: Band[] = [];
    for (const [key, group] of groups) {
      const rep = group.reduce((a, b) => (volumeM3(b.interior) > volumeM3(a.interior) ? b : a));
      const available = group.reduce((n, v) => n + qtyOf(v, defaultVanQuantity), 0);
      out.push({ key, rep, available });
    }
    return out.sort((a, b) => volumeM3(a.rep.interior) - volumeM3(b.rep.interior));
  }, [vans, defaultVanQuantity]);

  const countOf = (key: string) => picked.get(key) ?? 0;
  const bump = (b: Band, delta: number) => {
    setPicked((prev) => {
      const next = new Map(prev);
      const n = Math.max(0, Math.min(b.available, (next.get(b.key) ?? 0) + delta));
      if (n === 0) next.delete(b.key);
      else next.set(b.key, n);
      return next;
    });
  };
  const clear = () => setPicked(new Map());

  // Running combo totals (volume, payload, cost) from the picked bands' representatives.
  const combo = useMemo(() => {
    let volume = 0;
    let payload = 0;
    let perMile = 0;
    let units = 0;
    for (const b of bands) {
      const n = picked.get(b.key) ?? 0;
      if (n <= 0) continue;
      units += n;
      volume += n * volumeM3(b.rep.interior);
      payload += n * b.rep.maxPayloadKg;
      perMile += n * (b.rep.perMileRate + (b.rep.fuelCostPerMile ?? 0));
    }
    return { volume, payload, total: perMile * tripMiles, units };
  }, [bands, picked, tripMiles]);

  const fits = combo.volume >= load.volumeM3 - FIT_EPS && combo.payload >= load.weightKg;
  const shortVol = Math.max(0, load.volumeM3 - combo.volume);
  const shortKg = Math.max(0, load.weightKg - combo.payload);

  const baseline = useMemo(() => fleetCost(recommended, byId, tripMiles), [recommended, byId, tripMiles]);
  const delta = combo.total - baseline.total;
  const showCompare = combo.units > 0;

  return (
    <div style={cardStyle}>
      <div>
        <p style={sectionLabel}>What-if · same trip, different vans</p>
        <h3 style={{ margin: 0, fontSize: font.md, color: color.text, fontWeight: 700, letterSpacing: "-0.01em" }}>
          Try another fleet
        </h3>
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Same trip, same load — swap in different vehicle bands and see if it still fits and what it costs.
          What-if only; your live quote is untouched.
        </p>
      </div>

      {/* ── Trip + load: the fixed facts everything is measured against ── */}
      <div style={{ background: color.surfaceSub, border: `1px solid ${color.border}`, borderRadius: radius.input, padding: `${spacing.sm}px ${spacing.md}px`, display: "flex", alignItems: "center", gap: spacing.lg, flexWrap: "wrap" }}>
        <Fact label="This trip" value={`${smartNum(tripMiles)} mi`} hint="return included" />
        <Fact label="To carry" value={`${smartNum(load.volumeM3)} m³`} hint={`${Math.round(load.weightKg)} kg`} />
        <Fact label="Computer picked" value={summariseBands(recommended, byId)} hint={`£${smartNum(baseline.total)}`} />
      </div>

      {/* ── Band builder ── */}
      <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <p style={miniLabel}>Pick your bands</p>
          {combo.units > 0 && (
            <button type="button" onClick={clear} style={linkBtn}>Clear</button>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {bands.map((b) => {
            const n = countOf(b.key);
            const atMax = n >= b.available;
            // Can this band ever carry the load, even at full quantity? If its maxed-out
            // volume OR payload still falls short it's too small to matter — cross it out.
            const maxVol = volumeM3(b.rep.interior) * b.available;
            const maxPay = b.rep.maxPayloadKg * b.available;
            const blocked = maxVol < load.volumeM3 - FIT_EPS || maxPay < load.weightKg;
            const blockReason = b.available <= 0
              ? "None available"
              : `Too small — ${b.available}× only reaches ${smartNum(maxVol)} m³ / ${Math.round(maxPay)} kg`;
            return (
              <div
                key={b.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.sm,
                  padding: "6px 10px",
                  border: `1px solid ${n > 0 ? color.accentBorder : color.border}`,
                  borderRadius: radius.input,
                  background: n > 0 ? color.accentMuted : color.surfaceSub,
                  opacity: blocked ? 0.45 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: font.sm, fontWeight: 700, color: color.text }}>{b.key}</span>
                    {blocked && <span style={{ fontSize: font.sm, color: color.error, fontWeight: 700 }} title={blockReason}>✗</span>}
                  </div>
                  <span style={{ fontSize: font.xs, color: blocked ? color.error : color.muted }}>
                    {blocked
                      ? blockReason
                      : `${smartNum(volumeM3(b.rep.interior))} m³ · ${b.rep.maxPayloadKg} kg · £${b.rep.perMileRate.toFixed(2)}/mi · ${b.available} available`}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button type="button" onClick={() => bump(b, -1)} disabled={n <= 0} aria-label={`Remove one ${b.key}`} style={stepBtn(n <= 0)}>−</button>
                  <span style={{ minWidth: 20, textAlign: "center", fontSize: font.sm, fontWeight: 700, color: color.text, fontVariantNumeric: "tabular-nums" }}>{n}</span>
                  <button type="button" onClick={() => bump(b, +1)} disabled={blocked || atMax} aria-label={`Add one ${b.key}`} style={stepBtn(blocked || atMax)}>+</button>
                </div>
              </div>
            );
          })}
          {vans.length === 0 && !loadError && <span style={{ fontSize: font.xs, color: color.muted }}>Loading fleet…</span>}
          {loadError && (
            <span style={{ fontSize: font.xs, color: color.error }}>
              Couldn’t load the fleet.{" "}
              <button type="button" onClick={reload} style={{ ...linkBtn, color: color.error, textDecoration: "underline" }}>Retry</button>
            </span>
          )}
        </div>
      </div>

      {/* ── Verdict + cost ── */}
      {combo.units > 0 && (
        <div style={{ borderTop: `1px solid ${color.border}`, paddingTop: spacing.md, display: "flex", flexDirection: "column", gap: spacing.sm }}>
          {/* Does the combo fit the load? — the "based on total volume" check. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: `${spacing.sm}px ${spacing.md}px`,
              borderRadius: radius.input,
              background: fits ? color.accentMuted : color.surfaceSub,
              border: `1px solid ${fits ? color.accentBorder : color.error}`,
            }}
          >
            <span style={{ fontSize: font.md, fontWeight: 700, color: fits ? color.success : color.error }}>{fits ? "✓" : "✗"}</span>
            <span style={{ fontSize: font.sm, color: color.text }}>
              {fits
                ? "Fits this load."
                : `Doesn't fit — needs ${shortVol > FIT_EPS ? `+${smartNum(shortVol)} m³` : ""}${shortVol > FIT_EPS && shortKg > 0 ? " · " : ""}${shortKg > 0 ? `+${Math.round(shortKg)} kg` : ""}.`}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.sm }}>
            <Stat label="Trip cost" value={`£${smartNum(combo.total)}`} big />
            <Stat label="vs computer’s fleet" value={`${delta >= 0 ? "+" : "−"}£${smartNum(Math.abs(delta))}`} tone={showCompare ? (delta > 0.01 ? "up" : delta < -0.01 ? "down" : "flat") : "flat"} />
            <Stat label="Volume" value={`${smartNum(combo.volume)} m³`} />
            <Stat label="Payload" value={`${smartNum(combo.payload)} kg`} />
          </div>
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
            Over {smartNum(tripMiles)} mi (return included). Computer’s fleet costs £{smartNum(baseline.total)} for the same trip.
          </p>
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
            To change what’s actually being carried, edit the 3D load plan above.
          </p>
        </div>
      )}
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: font.xs, fontWeight: 600, color: color.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      <span style={{ fontSize: font.md, fontWeight: 700, color: color.text, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      {hint && <span style={{ fontSize: font.xs, color: color.muted }}>{hint}</span>}
    </div>
  );
}

function Stat({ label, value, big = false, tone = "flat" }: { label: string; value: string; big?: boolean; tone?: "up" | "down" | "flat" }) {
  const valueColor = tone === "down" ? color.success : tone === "up" ? color.text : color.text;
  return (
    <div style={{ background: color.surfaceSub, border: `1px solid ${color.border}`, borderRadius: radius.input, padding: `${spacing.xs + 2}px ${spacing.sm}px` }}>
      <div style={{ fontSize: big ? font.lg - 4 : font.md, fontWeight: 700, color: valueColor, lineHeight: 1.1, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: font.xs, color: color.muted, marginTop: 2, fontWeight: 500 }}>{label}</div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.card,
  padding: spacing.lg,
  display: "flex",
  flexDirection: "column",
  gap: spacing.md,
};
const sectionLabel: React.CSSProperties = { fontSize: font.xs, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: color.muted, margin: "0 0 2px" };
const miniLabel: React.CSSProperties = { fontSize: font.xs, fontWeight: 600, color: color.muted, margin: `0 0 ${spacing.sm}px` };
const linkBtn: React.CSSProperties = { border: "none", background: "transparent", color: color.accent, cursor: "pointer", fontSize: font.xs, fontWeight: 600, padding: 0, alignSelf: "flex-start" };
function stepBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${color.border}`,
    borderRadius: radius.input,
    background: color.surface,
    color: disabled ? color.muted : color.text,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    fontSize: font.md,
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
  };
}
