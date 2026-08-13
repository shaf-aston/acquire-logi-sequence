"use client";

import { useEffect, useId, useRef, useState } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";

/** A single autocomplete suggestion — postcode is null when Nominatim's address
 *  breakdown didn't resolve one (e.g. a city-level result), so consumers can tell
 *  a confirmed pick apart from one that still needs a postcode. */
export interface PlaceSuggestion {
  label: string;
  postcode: string | null;
  /** Coordinates from the geocoder, when available — lets a consumer drop a map pin on select. */
  lat?: number | null;
  lng?: number | null;
}

/** Client-side deadline for the whole browser→server lookup. The server bounds its OWN upstream
 *  calls, but a stalled browser→server socket (dropped Wi-Fi, frozen dev server) would otherwise
 *  never settle and pin "Searching…" on forever — this guarantees the request always settles. */
const CLIENT_TIMEOUT_MS = 8000;

interface PlacesInputProps {
  value: string;
  /** Fires on every keystroke — value is free text, not yet a confirmed location. */
  onChange: (val: string) => void;
  /** Fires only when a suggestion is picked — carries the full suggestion (label + postcode). */
  onSelect: (suggestion: PlaceSuggestion) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  /** When true, show a small green ✓ at the right edge — the location is confirmed/valid. */
  valid?: boolean;
}

export function PlacesInput({ value, onChange, onSelect, placeholder, style, valid }: PlacesInputProps) {
  const [query, setQuery] = useState(value);
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Index of the keyboard-highlighted suggestion (-1 = none). Drives arrow-key
  // navigation and aria-activedescendant so keyboard/screen-reader users can pick
  // a place without a mouse. A stable id ties each option to aria-controls/activedescendant.
  const [highlighted, setHighlighted] = useState(-1);
  const listboxId = useId();
  const optionId = (i: number) => `${listboxId}-opt-${i}`;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id of the latest query. A response only applies if it's still the newest, so a
  // slow/superseded lookup can never overwrite fresher suggestions or leave "Searching…" stuck.
  const latestSeq = useRef(0);

  useEffect(() => { setQuery(value); }, [value]);

  // Drop a pending debounce on unmount so its lookup never fires against a gone component.
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current); }, []);

  const onType = (raw: string) => {
    setQuery(raw);
    onChange(raw);
    if (debounce.current) clearTimeout(debounce.current);
    if (raw.length < 2) { latestSeq.current++; setSuggestions([]); setOpen(false); setLoading(false); return; }
    setLoading(true);
    setOpen(true);
    setHighlighted(-1); // fresh results — no stale highlight carried over
    const mySeq = ++latestSeq.current;
    debounce.current = setTimeout(() => {
      void fetch(`/api/places?q=${encodeURIComponent(raw)}`, { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) })
        .then((r) => r.json() as Promise<{ suggestions: PlaceSuggestion[] }>)
        .then((data) => {
          if (mySeq !== latestSeq.current) return; // a newer keystroke won — ignore this stale result
          setSuggestions(data.suggestions ?? []);
          setOpen(true);
        })
        .catch(() => { if (mySeq === latestSeq.current) setSuggestions([]); })
        .finally(() => { if (mySeq === latestSeq.current) setLoading(false); });
    }, 300);
  };

  const pick = (s: PlaceSuggestion) => {
    latestSeq.current++; // supersede any in-flight lookup so it can't reopen the dropdown after a pick
    setQuery(s.label);
    onSelect(s);
    setSuggestions([]);
    setOpen(false);
    setLoading(false);
    setHighlighted(-1);
  };

  // Keyboard navigation for the suggestion list: arrows move the highlight, Enter picks
  // it, Escape closes. Without this a keyboard-only or screen-reader user can see
  // suggestions but has no way to select one (the options only responded to the mouse).
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setHighlighted((h) => (suggestions.length === 0 ? -1 : Math.min(suggestions.length - 1, h + 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => (suggestions.length === 0 ? -1 : Math.max(0, h - 1)));
    } else if (e.key === "Enter") {
      if (open && highlighted >= 0 && suggestions[highlighted]) {
        e.preventDefault();
        pick(suggestions[highlighted]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setHighlighted(-1);
    }
  };

  // Reserve room on the right for the ✓ so a long value doesn't run under it.
  const inputStyle: React.CSSProperties = valid
    ? { ...style, paddingRight: 28 }
    : (style ?? {});
  return (
    <div style={{ position: "relative" }}>
      <input
        type="text"
        value={query}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => suggestions.length > 0 && setOpen(true)}
        placeholder={placeholder}
        // Long addresses overflow a single-line field — hover shows the full value.
        title={query || undefined}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={highlighted >= 0 ? optionId(highlighted) : undefined}
        style={inputStyle}
      />
      {valid && (
        <span
          aria-label="Confirmed location"
          title="Confirmed location"
          style={{
            position: "absolute",
            right: spacing.sm,
            top: "50%",
            transform: "translateY(-50%)",
            color: color.success,
            fontSize: font.base,
            fontWeight: 700,
            lineHeight: 1,
            pointerEvents: "none",
          }}
        >
          ✓
        </span>
      )}
      {open && (loading || suggestions.length > 0 || query.trim().length >= 2) && (
        <div
          id={listboxId}
          role="listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 100,
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.card,
            marginTop: 3,
            overflow: "hidden",
            boxShadow: color.shadowHover,
          }}
        >
          {loading && suggestions.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: font.sm, color: color.muted }}>Searching…</div>
          )}
          {!loading && suggestions.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: font.sm, color: color.muted }}>No matching places</div>
          )}
          {suggestions.map((s, i) => (
            <button
              key={`${i}-${s.label}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === highlighted}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setHighlighted(i)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                fontSize: font.sm,
                color: color.text,
                // Highlighted row (keyboard or hover) gets the standard hover surface so the
                // active option is visible without a mouse — token-driven, theme-safe.
                background: i === highlighted ? color.surfaceHover : "none",
                border: "none",
                cursor: "pointer",
                borderBottom: `1px solid ${color.border}`,
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      {/* Screen-reader-only status: announces result counts as they change so a
          non-sighted user hears "N places found" instead of silence. */}
      <span
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {open
          ? loading
            ? "Searching for places"
            : suggestions.length > 0
              ? `${suggestions.length} place${suggestions.length === 1 ? "" : "s"} found`
              : query.trim().length >= 2
                ? "No matching places"
                : ""
          : ""}
      </span>
    </div>
  );
}
