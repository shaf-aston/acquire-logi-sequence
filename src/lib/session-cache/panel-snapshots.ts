/**
 * In-memory, per-session snapshots of each quote-mode panel's state.
 *
 * Why this exists: the quoting screen renders one mode panel at a time and unmounts it when the
 * operator switches modes, so a planned collection run or a priced groupage quote is destroyed on
 * the way out and has to be re-fetched and re-planned on the way back (an API round-trip + spinner
 * + a re-click). This holds each panel's last state so leaving and returning shows the previous
 * result instantly. A "Recalculate" button re-runs on demand.
 *
 * Deliberately NOT persisted (no localStorage/sessionStorage): a full page reload starts fresh, by
 * design — the operator asked for "a reset over a reload rather than no cache at all". Cleared
 * whenever a new manifest is uploaded (the old run no longer describes the load) — see
 * `clearPanelSnapshots` wired into the upload handler.
 *
 * Module-level state is per browser tab, which is exactly the session scope we want; no React
 * context or prop-drilling needed.
 */
const snapshots = new Map<string, unknown>();

/** Read a panel's remembered state, or `undefined` if none saved this session. */
export function readPanelSnapshot<T>(key: string): T | undefined {
  return snapshots.get(key) as T | undefined;
}

/** Save a panel's state under its key, replacing any previous snapshot. */
export function writePanelSnapshot<T>(key: string, value: T): void {
  snapshots.set(key, value);
}

/** Forget one panel's state (e.g. a hub-to-hub hand-off starts a fresh groupage job). */
export function clearPanelSnapshot(key: string): void {
  snapshots.delete(key);
}

/** Forget every panel's state — called when a new manifest is uploaded. */
export function clearPanelSnapshots(): void {
  snapshots.clear();
}

/** Stable keys so panels and their host agree on where each snapshot lives. */
export const PANEL_SNAPSHOT_KEYS = {
  collection: "collection-run",
  groupage: "groupage",
  /**
   * Hubs lifted off the uploaded manifest for THIS session (see manifest-hub-reader). Held here so
   * they survive mode switches and are cleared for free when a new manifest is uploaded (the old
   * document's hubs no longer apply). The quote panels read this and send it as `sessionHubs`.
   */
  manifestHubs: "manifest-hubs",
} as const;
