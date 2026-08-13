"use client";

import type React from "react";
import { color, font, radius, spacing } from "@/styles/tokens";

/**
 * The one "something went wrong / this didn't fit" box. Before this component the same red
 * box (background/border/role) was hand-built 12+ times across 8 files and had drifted: some
 * copies set role="alert" (so a screen reader announces them), some silently did not — including
 * two of the "pallets that didn't fit" banners, the single most important thing an operator must
 * not miss. This component ALWAYS sets role="alert" so that can never happen again.
 *
 * `icon` and `action` are here because real call sites genuinely differ: DropZone and the
 * load-plan failure banner want the warning-circle icon, most inline form errors don't; a couple
 * of banners (a catchment-gap error, a plan-over-capacity error) want a one-click fix link below
 * the message. Everything else (colour, role, radius, padding) is fixed — that's the point.
 */
export function ErrorBanner({
  children,
  icon = false,
  action,
  style,
}: {
  children: React.ReactNode;
  /** Renders the warning-circle icon beside the message (DropZone, load-plan failure). */
  icon?: boolean;
  /** Optional trailing element below the message, e.g. a "create a hub" fix-it link. */
  action?: React.ReactNode;
  /** Outer overrides (margin, fontSize, borderRadius) — the handful of ways call sites vary. */
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: icon ? spacing.sm : undefined,
        fontSize: font.xs,
        color: color.error,
        background: color.errorBg,
        border: `1px solid ${color.errorBorder}`,
        borderRadius: radius.input,
        padding: "8px 10px",
        lineHeight: 1.5,
        ...style,
      }}
    >
      {icon && (
        <svg
          aria-hidden="true"
          style={{ flexShrink: 0, marginTop: 1 }}
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )}
      <div style={{ flex: 1 }}>
        {children}
        {action}
      </div>
    </div>
  );
}
