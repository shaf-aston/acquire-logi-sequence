"use client";

import { useMemo } from "react";
import { color, font } from "@/styles/tokens";
import type { CollectionRunStop } from "@/types/api";
import { allAreaCentres, areaCentroid, hubCentroid } from "@/lib/geo/area-centroids";

const VIEW_W = 220;
const VIEW_H = 300;
const PAD = 14;

/** Equirectangular projection over all areas' bounds — mirrors GroupageRouteMap / the admin map. */
function useProjection() {
  return useMemo(() => {
    const all = allAreaCentres();
    const lats = all.map((a) => a.lat);
    const lngs = all.map((a) => a.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const midLat = (minLat + maxLat) / 2;
    const lngScale = Math.cos((midLat * Math.PI) / 180);
    const scale = Math.min(
      (VIEW_W - 2 * PAD) / ((maxLng - minLng) * lngScale),
      (VIEW_H - 2 * PAD) / (maxLat - minLat),
    );
    return (lat: number, lng: number) => ({
      x: PAD + (lng - minLng) * lngScale * scale,
      y: PAD + (maxLat - lat) * scale,
    });
  }, []);
}

/**
 * Read-only mini-map of a planned collection run: faint UK context dots, the hub highlighted,
 * numbered pickup dots at their postcode-AREA centres (display-only approximation, like every
 * other map here), and the loop drawn in visit order. Pickups that can't be plotted (no readable
 * postcode, or an area missing from the reference data) are LISTED under the map, never hidden.
 */
export function CollectionRunMap({
  hubName,
  hubCatchment,
  orderedStops,
}: {
  hubName: string;
  hubCatchment: readonly string[];
  orderedStops: readonly CollectionRunStop[];
}) {
  const project = useProjection();

  const hub = hubCentroid(hubCatchment);
  if (!hub) return null;
  const h = project(hub.lat, hub.lng);

  const plotted: { x: number; y: number; index: number }[] = [];
  const unplottable: { index: number; stop: CollectionRunStop }[] = [];
  orderedStops.forEach((stop, i) => {
    const area = areaCentroid(stop.postcodeArea);
    if (area) {
      const p = project(area.lat, area.lng);
      plotted.push({ x: p.x, y: p.y, index: i });
    } else {
      unplottable.push({ index: i, stop });
    }
  });

  // The drawable loop: hub → plotted pickups in visit order → hub.
  const loop = [{ x: h.x, y: h.y }, ...plotted, { x: h.x, y: h.y }];

  return (
    <div
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: 10,
        background: color.surface,
        padding: 8,
        alignSelf: "center",
      }}
    >
      <svg width={VIEW_W} height={VIEW_H} role="img" aria-label="Collection run map">
        {/* Geographic context — every area as a faint dot. */}
        {allAreaCentres().map((area, i) => {
          const p = project(area.lat, area.lng);
          return <circle key={i} cx={p.x} cy={p.y} r={1.5} fill={color.border} />;
        })}

        {/* The loop, leg by leg, in visit order. */}
        {loop.slice(1).map((to, i) => (
          <line
            key={i}
            x1={loop[i]!.x}
            y1={loop[i]!.y}
            x2={to.x}
            y2={to.y}
            stroke={color.accent}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        ))}

        {/* Numbered pickup dots (visit order). */}
        {plotted.map((p) => (
          <g key={p.index}>
            <circle cx={p.x} cy={p.y} r={7} fill={color.surface} stroke={color.accent} strokeWidth={1.5} />
            <text
              x={p.x}
              y={p.y + 3}
              textAnchor="middle"
              style={{ fontSize: 8, fontWeight: 700, fill: color.text }}
            >
              {p.index + 1}
            </text>
          </g>
        ))}

        {/* Hub marker on top. */}
        <g>
          <circle cx={h.x} cy={h.y} r={5} fill={color.accent} />
          <text
            x={h.x}
            y={h.y - 8}
            textAnchor="middle"
            style={{ fontSize: 9, fontWeight: 700, fill: color.text }}
          >
            {hubName}
          </text>
        </g>
      </svg>

      {unplottable.length > 0 && (
        <p style={{ margin: "6px 0 0", fontSize: font.xs, color: color.review.fg, lineHeight: 1.5 }}>
          Not on the map (no readable postcode):{" "}
          {unplottable.map((u) => `#${u.index + 1} ${u.stop.address}`).join("; ")}
        </p>
      )}
    </div>
  );
}
