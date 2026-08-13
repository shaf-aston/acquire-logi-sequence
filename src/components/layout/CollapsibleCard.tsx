"use client";

import { useState, type ReactNode } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";

/**
 * Sidebar disclosure card — the QuotationHistory header pattern generalised so the
 * admin/ops panels (hubs, shipments) can sit in the sidebar collapsed by default
 * and expand in place. Purely presentational; children own their data fetching.
 * `open` can be controlled by the parent (e.g. a "fix your hubs" error link that
 * pops the card open); uncontrolled otherwise.
 */
export function CollapsibleCard({
  title,
  badge,
  children,
  open: controlledOpen,
  onToggle,
}: {
  title: string;
  /** Small counter/hint rendered next to the title, e.g. shipment count. */
  badge?: string;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const toggle = () => {
    const next = !open;
    setUncontrolledOpen(next);
    onToggle?.(next);
  };

  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card,
        boxShadow: color.shadow,
        overflow: "hidden",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `${spacing.md}px ${spacing.lg}px`,
          cursor: "pointer",
          gap: spacing.sm,
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>
          {title}
          {badge && (
            <span style={{ fontWeight: 500, color: color.muted, marginLeft: 6, fontSize: font.xs }}>{badge}</span>
          )}
        </span>
        <span style={{ fontSize: font.xs, color: color.muted }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${color.border}`, padding: spacing.lg }}>{children}</div>
      )}
    </div>
  );
}
