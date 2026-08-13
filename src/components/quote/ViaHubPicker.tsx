"use client";

import { useEffect, useState } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import type { Hub } from "@/lib/groupage/groupage.types";

/**
 * "Route via a hub" control for DEDICATED (single-drop / multi-stop) quotes — an optional
 * cross-dock / store-and-forward through one of the operator's hubs (pickup → hub → drops).
 *
 * Routing through a hub needs the hub's physical ADDRESS, so hubs without one are listed disabled
 * with a pointer to add it on the Depots & hubs screen — never silently dropped (fail-loud UI).
 * Reports the chosen hub's address (or null) up; the parent adds it to the quote request as `viaHub`.
 */
export function ViaHubPicker({ onChange }: { onChange: (address: string | null) => void }) {
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    fetch("/api/hubs")
      .then((r) => r.json())
      .then((d: { hubs?: Hub[] }) => {
        if (d.hubs) setHubs(d.hubs);
        else setLoadError(true);
      })
      .catch(() => setLoadError(true));
  }, []);

  const routable = hubs.filter((h) => typeof h.address === "string" && h.address.trim() !== "");

  const apply = (nextEnabled: boolean, nextId: string) => {
    setEnabled(nextEnabled);
    setSelectedId(nextId);
    const hub = routable.find((h) => h.id === nextId);
    onChange(nextEnabled && hub?.address ? hub.address.trim() : null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
      <label style={{ display: "flex", alignItems: "center", gap: spacing.sm, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => apply(e.target.checked, selectedId)}
          aria-label="Route via a hub"
        />
        <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>Route via a hub (cross-dock)</span>
      </label>

      {enabled && (
        <>
          <select
            value={selectedId}
            onChange={(e) => apply(true, e.target.value)}
            aria-label="Hub to route through"
            style={{
              width: "100%",
              padding: "8px 10px",
              fontSize: font.sm,
              color: color.text,
              background: color.surfaceSub,
              border: `1px solid ${color.border}`,
              borderRadius: radius.input,
            }}
          >
            <option value="">Choose a hub…</option>
            {hubs.map((h) => {
              const hasAddress = typeof h.address === "string" && h.address.trim() !== "";
              return (
                <option key={h.id} value={h.id} disabled={!hasAddress}>
                  {h.name}
                  {hasAddress ? "" : " — no address yet"}
                </option>
              );
            })}
          </select>
          <span style={{ fontSize: font.xs, color: color.muted, lineHeight: 1.4 }}>
            {loadError
              ? "Couldn't load hubs — check the Depots & hubs panel."
              : routable.length === 0
                ? "No hub has an address yet — add one on the Depots & hubs panel so a run can route through it."
                : "The load is collected, cross-docked at this hub, then carried on to the delivery. Adds the hub-handling fee."}
          </span>
        </>
      )}
    </div>
  );
}
