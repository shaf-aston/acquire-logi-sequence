"use client";

import { useMemo } from "react";
import { color, font } from "@/styles/tokens";
import type { GroupagePath } from "@/lib/groupage/groupage.types";
import { hubTown } from "@/lib/groupage/hub-display";
import areasFile from "../../../config/postcode-areas.json";

/** Display-only postcode-area centres — same reference data as the admin network map.
 *  Never feeds routing or pricing. */
const AREAS: Record<string, { name: string; lat: number; lng: number }> = areasFile.areas;

const VIEW_W = 220;
const VIEW_H = 300;
const PAD = 14;

/** Equirectangular projection over all areas' bounds, latitude-corrected so Britain
 *  keeps its shape. Mirrors the admin map's projection. */
function useProjection() {
  return useMemo(() => {
    const all = Object.values(AREAS);
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

/** Centre of a hub = mean of its catchment areas' centres. Areas with no reference
 *  point are skipped; a hub with none is dropped (nothing to plot). */
function hubPoint(catchment: readonly string[]): { lat: number; lng: number } | null {
  const pts = catchment.map((a) => AREAS[a.toUpperCase()]).filter((p): p is { name: string; lat: number; lng: number } => Boolean(p));
  if (pts.length === 0) return null;
  return {
    lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
    lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
  };
}

/** Read-only mini-map of a quoted groupage path: faint UK context dots, the origin
 *  and destination hubs highlighted, and a line between them. */
export function GroupageRouteMap({ path }: { path: GroupagePath }) {
  const project = useProjection();

  // Direct (hubless) paths have no hubs to plot — the journey strip carries the story instead.
  if (!path.originHub || !path.destinationHub) return null;

  const origin = hubPoint(path.originHub.catchment);
  const dest = hubPoint(path.destinationHub.catchment);
  if (!origin || !dest) return null;

  const a = project(origin.lat, origin.lng);
  const b = project(dest.lat, dest.lng);

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
      <svg width={VIEW_W} height={VIEW_H} role="img" aria-label="Route map">
        {/* Geographic context — every area as a faint dot. */}
        {Object.values(AREAS).map((area, i) => {
          const p = project(area.lat, area.lng);
          return <circle key={i} cx={p.x} cy={p.y} r={1.5} fill={color.border} />;
        })}

        {/* Trunk line (skipped for a local move — same hub both ends). */}
        {!path.isLocal && (
          <line
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={color.accent}
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        )}

        {/* Hub markers. Destination drawn first so origin sits on top when they coincide. */}
        {!path.isLocal && <Marker x={b.x} y={b.y} label={path.destinationHub.name} />}
        <Marker x={a.x} y={a.y} label={path.originHub.name} />
      </svg>
    </div>
  );
}

function Marker({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={5} fill={color.accent} stroke={color.surface} strokeWidth={1.5} />
      <title>{label}</title>
      <text
        x={x + 8}
        y={y + 3}
        fontSize={font.xs}
        fill={color.text}
        style={{ fontWeight: 600 }}
      >
        {/* Map is height-limited (marker x maxes ~143 of a 220 viewBox) so a tighter cut than
            the journey strip's default. */}
        {hubTown(label, 12)}
      </text>
    </g>
  );
}
