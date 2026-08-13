"use client";

import { color, radius, font } from "@/styles/tokens";
import type { ClassifiedItem } from "@/types/api";

export function FragilityBadge({ item }: { item: ClassifiedItem }) {
  const fragile = item.fragility === "fragile";
  const { bg, fg, border } = fragile ? color.fragile : item.fragility === "uncertain" ? color.review : color.standard;
  const label = fragile ? "Fragile" : item.fragility === "uncertain" ? "Standard?" : "Standard";

  return (
    <span
      title={item.reason}
      aria-label={`${label}${!item.confident ? " — low confidence" : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
        padding: "3px 9px",
        borderRadius: radius.badge,
        fontSize: font.xs,
        fontWeight: 600,
        whiteSpace: "nowrap",
        letterSpacing: "0.02em",
      }}
    >
      {label}
      {!item.confident && (
        <span
          aria-hidden="true"
          title="Low confidence — needs manual review"
          style={{ opacity: 0.7, cursor: "help" }}
        >
          ?
        </span>
      )}
    </span>
  );
}
