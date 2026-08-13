/* ── Shared styles ──────────────────────────────────────────────────────── */
import { color, font } from "@/styles/tokens";

export const toolBtn: React.CSSProperties = {
  border: `1px solid ${color.border}`,
  background: color.surfaceSub,
  color: color.text,
  borderRadius: 999,
  padding: "6px 10px",
  fontSize: font.xs,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const itemToolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 3,
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: 7,
  padding: "3px 4px",
  boxShadow: color.shadowFloat,
  whiteSpace: "nowrap",
};

export const itemToolBtn: React.CSSProperties = {
  border: `1px solid ${color.accentBorder}`,
  background: color.accentMuted,
  color: color.accent,
  borderRadius: 5,
  padding: 0,
  width: 26,
  height: 24,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 14,
  lineHeight: 1,
  fontWeight: 700,
  cursor: "pointer",
};

export const itemToolBtnDisabled: React.CSSProperties = {
  border: `1px solid ${color.border}`,
  background: color.surfaceSub,
  color: color.muted,
  cursor: "not-allowed",
};

export const itemToolSelect: React.CSSProperties = {
  border: `1px solid ${color.accentBorder}`,
  background: color.accentMuted,
  color: color.accent,
  borderRadius: 5,
  height: 24,
  padding: "0 4px",
  fontSize: font.xs,
  fontWeight: 700,
  cursor: "pointer",
};

// "Won't fit here" banner for a failed drag-from-tray drop — pinned bottom-centre
// over the canvas, tap to dismiss (also auto-clears on the next successful drop).
export const dropErrorBanner: React.CSSProperties = {
  position: "absolute",
  bottom: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 6,
  maxWidth: "calc(100% - 24px)",
  border: `1px solid ${color.errorBorder}`,
  background: color.errorBg,
  color: color.error,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: font.xs,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: color.shadowFloat,
  textAlign: "center",
};

// "N flagged — outside safe limits" banner for hand-overridden placements — pinned
// bottom-centre, amber, sits just above the drop-error banner. Non-dismissible: it
// clears itself the moment the last flagged box is dragged back to a valid spot.
export const flaggedBanner: React.CSSProperties = {
  position: "absolute",
  bottom: 44,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 6,
  maxWidth: "calc(100% - 24px)",
  border: `1px solid ${color.warningBorder}`,
  background: color.warningBg,
  color: color.warning,
  borderRadius: 8,
  padding: "6px 12px",
  fontSize: font.xs,
  fontWeight: 600,
  boxShadow: color.shadowFloat,
  textAlign: "center",
};

export const unplacedTabBtn: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  zIndex: 5,
  border: `1px solid ${color.border}`,
  background: color.surface,
  color: color.text,
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: font.xs,
  fontWeight: 700,
  cursor: "pointer",
  boxShadow: color.shadowFloatSoft,
};

export const unplacedPanel: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  zIndex: 5,
  width: 180,
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: 8,
  padding: 8,
  boxShadow: color.shadowFloat,
};

// Tiny per-row action in the Unplaced tray ("Place 1" / "Place all") — the
// no-drag way to get an item into the van.
export const unplacedPlaceBtn: React.CSSProperties = {
  border: `1px solid ${color.accentBorder}`,
  background: color.accentMuted,
  color: color.accent,
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 700,
  lineHeight: 1.3,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export const unplacedCollapseBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: color.muted,
  cursor: "pointer",
  fontSize: font.xs,
  padding: 2,
  lineHeight: 1,
};

export const tooltip: React.CSSProperties = {
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: font.xs,
  color: color.text,
  whiteSpace: "nowrap",
  pointerEvents: "none",
  boxShadow: color.shadowFloatSoft,
};
