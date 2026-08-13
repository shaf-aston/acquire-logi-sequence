"use client";

/**
 * Far-right "why isn't this van fuller?" developer panel — dev/ops only, gated by
 * `publicEnv.debugPanel` at the call site (VanCard in PackingResultPanel.tsx).
 *
 * Pure presentation: ALL the diagnosis (verdict, reason, the couldStackLikeForLike
 * crush/reach/weight check) comes from `analyzeVanFill`, the same pure function the
 * server-side pack-debug trace uses — this panel never re-derives fill logic, it
 * only renders what that one source of truth returns.
 */
import { color, font, spacing, radius } from "@/styles/tokens";
import { smartNum } from "@/lib/fmt";
import { analyzeVanFill, type FillVerdict } from "@/lib/packing/van-fill";
import type { Placement, Dimensions } from "@/lib/packing/packing.types";

/** A placement sitting on the floor (z at/below this many metres). Mirrors van-fill.ts. */
const FLOOR_EPS_M = 0.001;

/** Verdicts where the van's low fill is expected/correct, not a miss. */
const GOOD_VERDICTS: readonly FillVerdict[] = ["ok", "weight-limited"];

interface VanDebugPanelProps {
  placements: Placement[];
  interior: Dimensions;
  maxPayloadKg: number;
  maxReachHeightM: number | null;
  hasUnplacedGlobal: boolean;
  nameFor: (id: string) => string;
}

export function VanDebugPanel({
  placements,
  interior,
  maxPayloadKg,
  maxReachHeightM,
  hasUnplacedGlobal,
  nameFor,
}: VanDebugPanelProps) {
  const diag = analyzeVanFill(placements, interior, { maxReachHeightM, hasUnplacedGlobal, maxPayloadKg });
  const good = GOOD_VERDICTS.includes(diag.verdict);
  const badgeBg = good ? color.standard.bg : color.warningBg;
  const badgeFg = good ? color.standard.fg : color.warning;
  const badgeBorder = good ? color.standard.border : color.warningBorder;

  return (
    <div
      style={{
        width: 300,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: spacing.sm,
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card,
        padding: spacing.md,
        boxShadow: color.shadow,
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: font.xs,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: color.muted,
        }}
      >
        🔧 Fill debug
      </p>

      <div>
        <span
          style={{
            display: "inline-block",
            fontSize: font.xs,
            fontWeight: 700,
            padding: "3px 10px",
            borderRadius: radius.badge,
            background: badgeBg,
            color: badgeFg,
            border: `1px solid ${badgeBorder}`,
          }}
        >
          {diag.verdict}
        </span>
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.textSub, lineHeight: 1.4 }}>
          {diag.reason}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.xs }}>
        <Stat label="Volume" value={`${smartNum(diag.volumeFill * 100)}%`} />
        <Stat label="Floor" value={`${smartNum(diag.floorFootprint * 100)}%`} />
        <Stat label="Payload" value={`${smartNum(diag.payloadFraction * 100)}%`} />
        <Stat label="Headroom" value={`${smartNum(diag.headroomM)} m`} />
        <Stat label="Placed" value={`${diag.placed} (${diag.floored}F/${diag.stacked}S)`} />
        <Stat label="Could stack?" value={diag.couldStackLikeForLike ? "yes" : "no"} />
      </div>

      {placements.length > 0 && (
        <div
          style={{
            maxHeight: 180,
            overflowY: "auto",
            border: `1px solid ${color.border}`,
            borderRadius: radius.card - 4,
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: font.xs }}>
            <tbody>
              {placements.map((p, i) => {
                const floored = p.position.z <= FLOOR_EPS_M;
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${color.border}` }}>
                    <td style={{ padding: "4px 6px", color: color.text }}>{nameFor(p.itemId)}</td>
                    <td
                      style={{
                        padding: "4px 6px",
                        color: color.muted,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {smartNum(p.position.z)} m
                    </td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>
                      <span style={{ fontWeight: 700, color: floored ? color.muted : color.accent }}>
                        {floored ? "FLOOR" : "STACKED"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        background: color.surfaceSub,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card - 4,
        padding: `${spacing.xs}px ${spacing.sm}px`,
      }}
    >
      <div style={{ fontSize: font.sm, fontWeight: 700, color: color.text, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: font.xs, color: color.muted, marginTop: 2, fontWeight: 500 }}>{label}</div>
    </div>
  );
}
