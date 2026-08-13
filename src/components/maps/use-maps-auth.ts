"use client";

import { useSyncExternalStore } from "react";

/**
 * Detects a rejected Google Maps browser key so a map can FAIL LOUD instead of showing a silent
 * blank tile area (the "cream box" with controls but no streets). When the key is wrong, the site
 * isn't on the key's allow-list, or the Maps JavaScript API / billing isn't enabled, Google calls
 * the global `window.gm_authFailure` once — we flip a flag and notify every mounted map so it can
 * swap the blank map for a clear "map couldn't load" message.
 *
 * Module-level (not per-component) because Google exposes exactly one global callback: the first
 * map to mount installs it, and all maps share the resulting signal.
 */

let authFailed = false;
const listeners = new Set<() => void>();

/** Install the global `gm_authFailure` handler once (client-only, idempotent). Chains any handler
 *  already present so we never clobber another integration's callback. */
function ensureHandlerInstalled(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { gm_authFailure?: () => void; __fleetviewMapsAuthHooked?: boolean };
  if (w.__fleetviewMapsAuthHooked) return;
  w.__fleetviewMapsAuthHooked = true;
  const previous = w.gm_authFailure;
  w.gm_authFailure = () => {
    authFailed = true;
    listeners.forEach((notify) => notify());
    previous?.();
  };
}

/** `true` once Google has rejected the Maps key this session. Re-renders the caller when it flips. */
export function useGoogleMapsAuthFailed(): boolean {
  ensureHandlerInstalled();
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => authFailed,
    () => false, // server snapshot: never "failed" during SSR
  );
}
