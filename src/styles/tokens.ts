import type React from "react";

// All color values resolve via CSS custom properties in globals.css :root.
// Never inline hex here — add new colors to :root first, then reference them below.
export const color = {
  pageBg:        "var(--color-page-bg)",
  surface:       "var(--color-surface)",
  surfaceSub:    "var(--color-surface-sub)",
  surfaceHover:  "var(--color-surface-hover)",
  border:        "var(--color-border)",
  borderStrong:  "var(--color-border-strong)",
  headerBg:      "var(--color-header-bg)",
  text:          "var(--color-text)",
  textSub:       "var(--color-text-sub)",
  muted:         "var(--color-muted)",
  accent:        "var(--color-accent)",
  accentDark:    "var(--color-accent-dark)",
  accentMuted:   "var(--color-accent-muted)",
  accentBorder:  "var(--color-accent-border)",
  onAccent:      "var(--color-on-accent)",
  fragile:  { bg: "var(--color-fragile-bg)",  fg: "var(--color-fragile-fg)",  border: "var(--color-fragile-border)"  },
  standard: { bg: "var(--color-standard-bg)", fg: "var(--color-standard-fg)", border: "var(--color-standard-border)" },
  review:   { bg: "var(--color-review-bg)",   fg: "var(--color-review-fg)",   border: "var(--color-review-border)"   },
  overload: { bg: "var(--color-overload-bg)", fg: "var(--color-overload-fg)", border: "var(--color-overload-border)", fill: "var(--color-overload-fill)", edge: "var(--color-overload-edge)" },
  success:       "var(--color-success)",
  error:         "var(--color-error)",
  errorBg:       "var(--color-error-bg)",
  errorBorder:   "var(--color-error-border)",
  warning:       "var(--color-warning)",
  warningBg:     "var(--color-warning-bg)",
  warningBorder: "var(--color-warning-border)",
  statusIdle:       "var(--color-status-idle)",
  statusProcessing: "var(--color-status-processing)",
  statusDone:       "var(--color-status-done)",
  mapHub:      "var(--color-map-hub)",
  mapNearest:  "var(--color-map-nearest)",
  mapLocator:  "var(--color-map-locator)",
  shadow:        "var(--shadow-card)",
  shadowHover:   "var(--shadow-card-hover)",
  shadowFloat:       "var(--shadow-float)",
  shadowFloatSoft:   "var(--shadow-float-soft)",
  shadowFloatStrong: "var(--shadow-float-strong)",
  shadowDrag:        "var(--shadow-drag)",
} as const;

/** Per-company tints for the shared-truck load plan, cycled by company index. CSS custom
 *  properties (globals.css :root); resolve to concrete colours via `cssVar` for a 3D fill. */
export const companyPalette = [
  "var(--color-company-1)",
  "var(--color-company-2)",
  "var(--color-company-3)",
  "var(--color-company-4)",
  "var(--color-company-5)",
  "var(--color-company-6)",
  "var(--color-company-7)",
  "var(--color-company-8)",
] as const;

export const radius = {
  card:   12,
  button: 8,
  badge:  999,
  input:  8,
} as const;

export const font = {
  xs:   11,
  sm:   12,
  base: 13,
  md:   15,
  lg:   22,
  xl:   28,
} as const;

export const spacing = {
  xs:  4,
  sm:  8,
  md:  16,
  lg:  24,
  xl:  32,
  xxl: 48,
} as const;

export const card: React.CSSProperties = {
  background:   color.surface,
  border:       `1px solid ${color.border}`,
  borderRadius: radius.card,
  padding:      `${spacing.lg}px`,
  boxShadow:    color.shadow,
};

export const cardSection: React.CSSProperties = {
  ...card,
  marginTop: spacing.md,
};

export const sectionLabel: React.CSSProperties = {
  fontSize:      font.xs,
  fontWeight:    600,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color:         color.muted,
  margin:        0,
};

export const h2Style: React.CSSProperties = {
  fontSize:   font.md,
  fontWeight: 600,
  margin:     0,
  color:      color.text,
};

export const th: React.CSSProperties = {
  padding:       "10px 14px",
  background:    color.surfaceSub,
  textAlign:     "left",
  fontSize:      font.sm,
  fontWeight:    600,
  color:         color.muted,
  borderBottom:  `1px solid ${color.border}`,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  whiteSpace:    "nowrap",
};

export const td: React.CSSProperties = {
  padding:      "10px 14px",
  fontSize:     font.base,
  borderBottom: `1px solid ${color.border}`,
  color:        color.text,
};

export const tdMuted: React.CSSProperties = {
  ...td,
  color: color.muted,
};

export const tdStrong: React.CSSProperties = {
  ...td,
  fontWeight: 600,
  color:      color.text,
};

export function pill(
  bg: string,
  fg: string,
  border: string,
): React.CSSProperties {
  return {
    display:      "inline-flex",
    alignItems:   "center",
    gap:          5,
    background:   bg,
    color:        fg,
    border:       `1px solid ${border}`,
    padding:      "4px 12px",
    borderRadius: radius.badge,
    fontSize:     font.sm,
    fontWeight:   600,
    lineHeight:   1.4,
  };
}

export function buttonPrimary(disabled: boolean): React.CSSProperties {
  return {
    display:      "inline-flex",
    alignItems:   "center",
    gap:          6,
    padding:      "9px 20px",
    borderRadius: radius.button,
    border:       "none",
    background:   disabled ? color.surfaceHover : color.accent,
    color:        disabled ? color.muted : color.onAccent,
    cursor:       disabled ? "not-allowed" : "pointer",
    fontSize:     font.base,
    fontWeight:   500,
    transition:   "background 0.15s",
    outline:      "none",
  };
}

export function buttonSecondary(disabled: boolean): React.CSSProperties {
  return {
    display:      "inline-flex",
    alignItems:   "center",
    gap:          6,
    padding:      "8px 16px",
    borderRadius: radius.button,
    border:       `1px solid ${disabled ? color.border : color.borderStrong}`,
    background:   color.surface,
    color:        disabled ? color.muted : color.text,
    cursor:       disabled ? "not-allowed" : "pointer",
    fontSize:     font.base,
    fontWeight:   500,
    transition:   "background 0.15s",
    outline:      "none",
  };
}

export const buttonStyle = buttonSecondary;
export const h2 = h2Style;
