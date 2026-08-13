/* ── Theme (single source of truth = globals.css :root) ─────────────────────
 * Three.js materials need concrete color strings, not `var(--…)`, so we resolve
 * the design-system custom properties at runtime. SSR_THEME is a fallback for
 * server renders (Three.js can't run there) — values mirror globals.css :root. */

export interface Theme {
  wire: string; grid: string;
  standardFill: string; standardEdge: string;
  fragileFill: string; fragileEdge: string;
  overloadFill: string; overloadEdge: string;
  flaggedFill: string; flaggedEdge: string;
  selected: string; validGhost: string; invalidGhost: string;
}

// SSR-safe defaults — exact copies of globals.css :root. Three.js is client-only
// so these are only used when window is undefined (initial server pass, no canvas).
export const SSR_THEME: Readonly<Theme> = {
  wire:         "var(--color-muted)",
  grid:         "var(--color-border-strong)",
  standardFill: "var(--color-standard-bg)",
  standardEdge: "var(--color-standard-fg)",
  fragileFill:  "var(--color-fragile-bg)",
  fragileEdge:  "var(--color-fragile-fg)",
  overloadFill: "var(--color-overload-fill)",
  overloadEdge: "var(--color-overload-edge)",
  flaggedFill:  "var(--color-flagged-fill)",
  flaggedEdge:  "var(--color-flagged-edge)",
  selected:     "var(--color-accent)",
  validGhost:   "var(--color-status-done)",
  invalidGhost: "var(--color-error)",
};

export function cssVar(name: string): string {
  if (typeof window === "undefined") return name; // pass the var name; SSR canvas is inert
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || name;
}

export function readTheme(): Theme {
  if (typeof window === "undefined") return SSR_THEME;
  return {
    wire:         cssVar("--color-muted"),
    grid:         cssVar("--color-border-strong"),
    standardFill: cssVar("--color-standard-bg"),
    standardEdge: cssVar("--color-standard-fg"),
    fragileFill:  cssVar("--color-fragile-bg"),
    fragileEdge:  cssVar("--color-fragile-fg"),
    overloadFill: cssVar("--color-overload-fill"),
    overloadEdge: cssVar("--color-overload-edge"),
    flaggedFill:  cssVar("--color-flagged-fill"),
    flaggedEdge:  cssVar("--color-flagged-edge"),
    selected:     cssVar("--color-accent"),
    validGhost:   cssVar("--color-status-done"),
    invalidGhost: cssVar("--color-error"),
  };
}
