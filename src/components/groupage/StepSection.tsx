"use client";

import type React from "react";
import { color, font, radius, spacing } from "@/styles/tokens";

/**
 * One numbered step in the groupage flow. A shared wrapper so the three stages —
 * build pallets, load the truck, the two journeys — read as one consistent, clean
 * sequence even though they live across two host components (GroupagePanel +
 * TruckStackPlanner). Presentational only; colours/spacing come from tokens.
 */
export function StepSection({
  step,
  title,
  subtitle,
  children,
}: {
  /** The 1-based step number shown in the badge. Omit for a section that is an outcome rather than a
   *  numbered step (e.g. the final quote) — the badge is dropped and the title stands alone, so a
   *  conditional earlier step never leaves a misleading gap in the numbering. */
  step?: number;
  title: string;
  /** Optional plain-language "what this step is" line under the title. */
  subtitle?: string;
  /** Optional — omit to use the section purely as a numbered header + divider (when the step's
   *  body lives in sibling markup that's awkward to wrap). */
  children?: React.ReactNode;
}) {
  return (
    <section
      style={{
        borderTop: `1px solid ${color.border}`,
        paddingTop: spacing.md,
        display: "flex",
        flexDirection: "column",
        gap: spacing.sm,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: spacing.sm }}>
        {step !== undefined && (
          <span aria-hidden style={badge}>
            {step}
          </span>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h3 style={{ margin: 0, fontSize: font.md, fontWeight: 700, color: color.text, letterSpacing: "-0.01em" }}>
            {step !== undefined && <span style={srOnly}>Step {step}: </span>}
            {title}
          </h3>
          {subtitle && (
            <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>{subtitle}</p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

const badge: React.CSSProperties = {
  flex: "0 0 auto",
  width: 24,
  height: 24,
  borderRadius: radius.badge,
  background: color.accent,
  color: color.onAccent,
  fontSize: font.sm,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  lineHeight: 1,
};

/** Visually hidden but announced to screen readers, so the badge number gets a real label. */
const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};
