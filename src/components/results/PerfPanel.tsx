"use client";

import { color, font, spacing, radius } from "@/styles/tokens";
import type { PerfReport } from "@/types/api";

function spanLabel(name: string, provider?: string): string {
  if (name === "ocr") return provider ? `${provider} OCR` : "OCR";
  if (name === "validate") return "Validate file";
  if (name === "convert") return "Markdown → tables";
  if (name === "classify") return "Fragility classify";
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const ms = (n: number) => `${n.toFixed(0)} ms`;
const pct = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(0)}%` : "—";

interface Props {
  perf: PerfReport;
  provider?: string;
  clientMs: number | null;
}

export function PerfPanel({ perf, provider, clientMs }: Props) {
  const sumSpans = perf.spans.reduce((s, x) => s + x.durationMs, 0);
  const overhead = Math.max(0, Math.round((perf.totalMs - sumSpans) * 100) / 100);
  const network =
    clientMs !== null ? Math.max(0, Math.round((clientMs - perf.totalMs) * 100) / 100) : null;

  const maxDuration = Math.max(...perf.spans.map((s) => s.durationMs), overhead);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
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
        Pipeline timing
      </p>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          borderRadius: radius.card,
          border: `1px solid ${color.border}`,
          overflow: "hidden",
        }}
      >
        {/* Header row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 80px 56px",
            padding: `${spacing.xs + 2}px ${spacing.md}px`,
            background: color.surfaceSub,
            borderBottom: `1px solid ${color.border}`,
            fontSize: font.xs,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: color.muted,
          }}
        >
          <span>Stage</span>
          <span style={{ textAlign: "right" }}>Duration</span>
          <span style={{ textAlign: "right" }}>Share</span>
        </div>

        {/* Span rows */}
        {perf.spans.map((s) => (
          <div
            key={s.name}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 80px 56px",
              padding: `${spacing.sm}px ${spacing.md}px`,
              borderBottom: `1px solid ${color.border}`,
              background: color.surface,
              fontSize: font.base,
              alignItems: "center",
              gap: spacing.sm,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ color: color.text }}>{spanLabel(s.name, provider)}</span>
              {/* UX fix H8: mini bar chart for at-a-glance proportions */}
              <div
                aria-hidden="true"
                style={{
                  height: 3,
                  borderRadius: 2,
                  background: color.border,
                  overflow: "hidden",
                  width: "100%",
                  maxWidth: 120,
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${(s.durationMs / maxDuration) * 100}%`,
                    background: color.accent,
                    borderRadius: 2,
                  }}
                />
              </div>
            </div>
            <span style={{ textAlign: "right", color: color.text, fontVariantNumeric: "tabular-nums" }}>
              {ms(s.durationMs)}
            </span>
            <span style={{ textAlign: "right", color: color.muted, fontVariantNumeric: "tabular-nums" }}>
              {pct(s.durationMs, perf.totalMs)}
            </span>
          </div>
        ))}

        {/* Overhead */}
        {overhead > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 80px 56px",
              padding: `${spacing.sm}px ${spacing.md}px`,
              borderBottom: `1px solid ${color.border}`,
              background: color.surface,
              fontSize: font.base,
              alignItems: "center",
            }}
          >
            <span style={{ color: color.muted }}>Orchestration overhead</span>
            <span style={{ textAlign: "right", color: color.muted, fontVariantNumeric: "tabular-nums" }}>
              {ms(overhead)}
            </span>
            <span style={{ textAlign: "right", color: color.muted, fontVariantNumeric: "tabular-nums" }}>
              {pct(overhead, perf.totalMs)}
            </span>
          </div>
        )}

        {/* Totals */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 80px 56px",
            padding: `${spacing.sm}px ${spacing.md}px`,
            background: color.surfaceSub,
            fontSize: font.base,
            fontWeight: 600,
            alignItems: "center",
            ...(network !== null ? { borderBottom: `1px solid ${color.border}` } : {}),
          }}
        >
          <span style={{ color: color.text }}>Server total</span>
          <span style={{ textAlign: "right", color: color.text, fontVariantNumeric: "tabular-nums" }}>
            {ms(perf.totalMs)}
          </span>
          <span style={{ textAlign: "right", color: color.muted }}>100%</span>
        </div>

        {network !== null && (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 80px 56px",
                padding: `${spacing.sm}px ${spacing.md}px`,
                background: color.surface,
                borderBottom: `1px solid ${color.border}`,
                fontSize: font.base,
                alignItems: "center",
              }}
            >
              <span style={{ color: color.muted }}>Network + framework</span>
              <span style={{ textAlign: "right", color: color.muted, fontVariantNumeric: "tabular-nums" }}>
                {ms(network)}
              </span>
              <span style={{ textAlign: "right", color: color.muted }}>—</span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 80px 56px",
                padding: `${spacing.sm}px ${spacing.md}px`,
                background: color.surfaceSub,
                fontSize: font.base,
                fontWeight: 600,
                alignItems: "center",
              }}
            >
              <span style={{ color: color.text }}>Round-trip (browser)</span>
              <span style={{ textAlign: "right", color: color.text, fontVariantNumeric: "tabular-nums" }}>
                {ms(clientMs as number)}
              </span>
              <span style={{ textAlign: "right", color: color.muted }}>—</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
