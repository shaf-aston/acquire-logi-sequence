"use client";

/**
 * Per-pickup 3D pallet cards for the collection view — one small viewer per manifest stop,
 * showing only that stop's pallets in their real packed positions. The collection sibling of
 * the groupage PerCompanyStacks: same "read it stop-by-stop instead of one tangled stack"
 * idea, but the collection load has no company key, so it groups by manifest stop (each pickup
 * on a milk-round IS one supplier). Reuses the already-packed placements — no extra pack call.
 */
import { useMemo } from "react";
import { color, companyPalette, font, radius, spacing } from "@/styles/tokens";
import { cssVar } from "@/components/results/van-3d/theme";
import { Van3DViewer } from "@/components/results/Van3DViewer";
import { groupPlacementsByStop, rowIdOfPlacement, type FleetVan } from "@/lib/collection-run/stop-pallet-grouping";

// Max simultaneous 3D cards. Each is a live WebGL context; browsers keep only ~16 before dropping
// the oldest (blank cards), and a wall of canvases clutters the page — so cap the 3D views and
// spill the rest to compact text rows. Sits under 16 to leave headroom for the main viewer + map.
const MAX_3D_CARDS = 12;

export function PerStopPallets({
  fleet,
  stopByItemId,
  nameById,
  stopLabels,
  toleranceM,
  maxReachHeightM,
}: {
  /** The packed fleet (each van's placements + interior) straight from the load plan. */
  fleet: readonly FleetVan[];
  /** Row id → 0-based manifest stop — the same map that tags cargo rows to drops. */
  stopByItemId: ReadonlyMap<string, number>;
  /** Row id → item name, for viewer tooltips. Missing names fall back to the row id. */
  nameById: ReadonlyMap<string, string>;
  /** Optional pickup address/company per 0-based stop (same order as the detected pickups), shown
   *  as a card subtitle so each pallet stack reads as an individual supplier, not just "Stop N".
   *  Absent/blank ⇒ no subtitle; the manifest's "Stop N" stays the authoritative label. */
  stopLabels?: readonly (string | undefined)[];
  toleranceM?: number;
  maxReachHeightM?: number;
}) {
  // Resolve the CSS-var palette once — three.js needs concrete colours. Same palette as the
  // groupage stack so a stop reads with a stable, distinct colour.
  const palette = useMemo(() => companyPalette.map((v) => cssVar(v)), []);
  const groups = useMemo(() => groupPlacementsByStop(fleet, stopByItemId), [fleet, stopByItemId]);
  if (groups.length === 0) return null;

  const multiVan = fleet.length > 1;

  // Each 3D card is its own WebGL context; browsers keep only ~16 alive, so a long milk-round
  // would blank the oldest cards AND wall the UI with canvases. Cap the 3D views and list any
  // overflow as one-line rows (open a shown card full-screen for detail) — nothing is hidden.
  const cards = groups.slice(0, MAX_3D_CARDS);
  const overflow = groups.slice(MAX_3D_CARDS);

  // Shared header so a 3D card and an overflow row read identically (swatch · label · count).
  const colourOf = (stopIndex: number | null) => (stopIndex === null ? color.muted : palette[stopIndex % palette.length]!);
  const labelOf = (stopIndex: number | null) => (stopIndex === null ? "Unassigned cargo" : `Stop ${stopIndex + 1}`);
  const subtitleOf = (stopIndex: number | null) =>
    stopIndex === null ? undefined : stopLabels?.[stopIndex]?.trim() || undefined;
  const Header = ({ g }: { g: (typeof groups)[number] }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.xs, color: color.text }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: colourOf(g.stopIndex), flex: "0 0 auto" }} />
      <strong>{labelOf(g.stopIndex)}</strong>
      {multiVan && <span style={{ color: color.muted }}>· van {g.vanIndex + 1}</span>}
      <span style={{ color: color.muted, marginLeft: "auto" }}>
        {g.placements.length} pallet{g.placements.length === 1 ? "" : "s"}
      </span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <p style={{ margin: 0, fontSize: font.xs, fontWeight: 600, color: color.muted }}>
        Pallets per pickup (from the manifest)
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: spacing.md }}>
        {cards.map((g) => {
          const subtitle = subtitleOf(g.stopIndex);
          const names = g.placements.map((p) => nameById.get(rowIdOfPlacement(p.itemId)) ?? rowIdOfPlacement(p.itemId));
          return (
            <div
              key={g.key}
              style={{ border: `1px solid ${color.border}`, borderRadius: radius.input, padding: spacing.sm, display: "flex", flexDirection: "column", gap: 6 }}
            >
              <Header g={g} />
              {subtitle && (
                <p
                  title={subtitle}
                  style={{ margin: 0, fontSize: font.xs, color: color.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {subtitle}
                </p>
              )}
              <Van3DViewer
                placements={g.placements}
                interior={g.interior}
                itemNames={names}
                groupColors={g.placements.map(() => colourOf(g.stopIndex))}
                heightPx={240}
                frameloop="demand"
                compact
                toleranceM={toleranceM}
                maxReachHeightM={maxReachHeightM}
              />
            </div>
          );
        })}
      </div>
      {overflow.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
            + {overflow.length} more pickup{overflow.length === 1 ? "" : "s"} (listed below — the 3D views are capped to keep this readable)
          </p>
          {overflow.map((g) => {
            const subtitle = subtitleOf(g.stopIndex);
            return (
              <div
                key={g.key}
                style={{ border: `1px solid ${color.border}`, borderRadius: radius.input, padding: `6px ${spacing.sm}px`, display: "flex", flexDirection: "column", gap: 2 }}
              >
                <Header g={g} />
                {subtitle && (
                  <p title={subtitle} style={{ margin: 0, fontSize: font.xs, color: color.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {subtitle}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
