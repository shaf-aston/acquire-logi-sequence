"use client";

/**
 * Session-scoped van fleet context.
 *
 * Loads the fleet from GET /api/vans once. All mutations (add, update, remove)
 * are in-memory only — nothing is written back to the server. Reload the page
 * to reset to the persisted fleet.
 *
 * Both VanConfigPanel and FleetCostExplorer consume from here so they stay in sync.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { inferSizeClass } from "@/lib/packing/van-classifier";
import type { Van } from "@/lib/packing/packing.types";

interface VanSession {
  vans: Van[];
  /**
   * Copies of a van the customer owns when it states no `quantity` of its own. Comes from the
   * SERVER (packing.defaultVanQuantity) rather than being re-derived here, so the browser's
   * fleet-cost estimator and the allocator can never disagree about how many vans exist.
   * `null` until the fleet has loaded — a consumer must not substitute a guess of its own.
   */
  defaultVanQuantity: number | null;
  loadError: boolean;
  /** Re-fetch from API (resets any session mutations). */
  reload(): void;
  /** Add a van to the session fleet. Returns an error string on failure, null on success. */
  addVan(van: Van): string | null;
  /** Update an existing van in the session fleet. */
  updateVan(van: Van): void;
  /** Remove a van from the session fleet by id. */
  removeVan(id: string): void;
}

const VanSessionCtx = createContext<VanSession | null>(null);

export function VanSessionProvider({ children }: { children: ReactNode }) {
  const [vans, setVans] = useState<Van[]>([]);
  const [defaultVanQuantity, setDefaultVanQuantity] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(() => {
    setLoadError(false);
    void (async () => {
      try {
        const res = await fetch("/api/vans");
        const data = (await res.json()) as { vans?: Van[]; defaultVanQuantity?: number };
        setVans(data.vans ?? []);
        setDefaultVanQuantity(data.defaultVanQuantity ?? null);
      } catch {
        setLoadError(true);
      }
    })();
  }, []);

  useEffect(() => reload(), [reload]);

  const ctx = useMemo<VanSession>(
    () => ({
      vans,
      defaultVanQuantity,
      loadError,
      reload,
      addVan(van) {
        if (vans.some((v) => v.id === van.id)) {
          return `A van with ID "${van.id}" already exists in this session.`;
        }
        const sizeClass = van.sizeClass || inferSizeClass(van, vans);
        setVans((prev) => [...prev, { ...van, sizeClass }]);
        return null;
      },
      updateVan(van) {
        const sizeClass = van.sizeClass || inferSizeClass(van, vans);
        setVans((prev) => prev.map((v) => (v.id === van.id ? { ...van, sizeClass } : v)));
      },
      removeVan(id) {
        setVans((prev) => prev.filter((v) => v.id !== id));
      },
    }),
    [vans, defaultVanQuantity, loadError, reload],
  );

  return <VanSessionCtx.Provider value={ctx}>{children}</VanSessionCtx.Provider>;
}

export function useVanSession(): VanSession {
  const ctx = useContext(VanSessionCtx);
  if (!ctx) throw new Error("useVanSession must be used inside VanSessionProvider");
  return ctx;
}
