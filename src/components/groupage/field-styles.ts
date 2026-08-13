import type { CSSProperties } from "react";
import { color, font, radius } from "@/styles/tokens";

/**
 * Shared field/button primitives for the groupage stop + pallet-line forms. Was duplicated
 * character-for-character between `TrunkStopsEditor` and `GroupagePanel` — kept here once so the
 * two never drift.
 */
export const labelWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };
export const labelText: CSSProperties = { fontSize: font.xs, color: color.muted, fontWeight: 500 };
export const inputStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  borderRadius: radius.input,
  border: `1px solid ${color.border}`,
  background: color.surfaceSub,
  color: color.text,
  fontSize: font.sm,
};
export const baseBtn: CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: radius.badge,
  padding: "6px 12px",
  fontSize: font.xs,
  fontWeight: 600,
  cursor: "pointer",
};
export const secondaryBtn: CSSProperties = { ...baseBtn, background: color.surfaceSub, color: color.text };
