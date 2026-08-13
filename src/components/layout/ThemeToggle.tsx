"use client";

import { useEffect, useState } from "react";
import { color, font, radius } from "@/styles/tokens";

type Mode = "light" | "dark";

/** True when the OS/browser is set to a dark colour scheme — the default when the
 *  user hasn't made an explicit choice yet. */
function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Light/dark switch for the header. Persists the choice in localStorage and writes
 * `data-theme` on <html>, which the globals.css token blocks key off — so one click
 * re-themes the whole app with no per-component work. Defaults to the OS preference
 * until the user picks; an inline script in layout.tsx applies the saved choice before
 * first paint so there's no flash of the wrong theme.
 */
export function ThemeToggle() {
  // null until mounted so server and first client render agree (avoids a hydration
  // mismatch — the real mode is only knowable in the browser).
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    setMode(saved === "dark" || saved === "light" ? saved : (systemPrefersDark() ? "dark" : "light"));
  }, []);

  const apply = (next: Mode) => {
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setMode(next);
  };

  if (mode === null) return null;
  const next: Mode = mode === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => apply(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: radius.input,
        border: `1px solid ${color.border}`,
        background: color.surfaceSub,
        color: color.textSub,
        fontSize: font.md,
        lineHeight: 1,
        cursor: "pointer",
      }}
    >
      <span aria-hidden="true">{mode === "dark" ? "☀" : "☾"}</span>
    </button>
  );
}
