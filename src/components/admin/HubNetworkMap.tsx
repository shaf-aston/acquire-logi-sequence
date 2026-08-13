"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { color, font, spacing } from "@/styles/tokens";
import type { Hub } from "@/lib/groupage/groupage.types";
import { nearestHubId } from "@/lib/groupage/nearest-hub";
import areasFile from "../../../config/postcode-areas.json";

/** Display-only reference data — approximate postcode-area centres for the map.
 *  Never feeds routing or pricing (see the note inside the JSON itself). */
const AREAS: Record<string, { name: string; lat: number; lng: number }> = areasFile.areas;

/** Stable, evenly-spread hue per hub (golden-angle walk) — computed, not hardcoded,
 *  so any number of hubs stays distinguishable without a colour list to maintain. */
function hubColor(index: number): string {
  return `hsl(${Math.round((index * 137.508) % 360)} 55% 45%)`;
}

/** The place name only, for the on-map marker label — drops the parenthetical region
 *  ("Birmingham (Central England)" → "Birmingham") so labels stay short and readable. */
function shortLabel(name: string): string {
  return name.split(/\s*[(&]/)[0]!.trim();
}

const VIEW_W = 260;
const VIEW_H = 400;
const PAD = 16;

const zoomBtn: React.CSSProperties = {
  width: 26,
  height: 26,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${color.border}`,
  borderRadius: 6,
  background: color.surface,
  color: color.text,
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
  padding: 0,
};

/** Equirectangular projection over the data's own bounds, with latitude-corrected
 *  aspect so Britain keeps its familiar shape at any card width. */
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
    const spanX = (maxLng - minLng) * lngScale;
    const spanY = maxLat - minLat;
    const scale = Math.min((VIEW_W - 2 * PAD) / spanX, (VIEW_H - 2 * PAD) / spanY);
    return (lat: number, lng: number): { x: number; y: number } => ({
      x: PAD + (lng - minLng) * lngScale * scale,
      y: PAD + (maxLat - lat) * scale,
    });
  }, []);
}

export function HubNetworkMap({
  hubs,
  selectedHubId,
  selectedCatchment,
  onSelectHub,
  onToggleArea,
  onAssignArea,
}: {
  hubs: Hub[];
  /** The hub currently loaded in the edit form (draft), or null when adding/none. */
  selectedHubId: string | null;
  /** The DRAFT catchment of the selected hub — the map previews unsaved edits live. */
  selectedCatchment: string[];
  onSelectHub: (hub: Hub) => void;
  onToggleArea: (area: string) => void;
  /** Auto-assign mode: reassign one postcode area directly to whichever hub is nearest by
   *  straight-line distance (a convenience shortcut, not a routing change). */
  onAssignArea?: (area: string, hubId: string) => void;
}) {
  const project = useProjection();
  // Auto-assign mode: clicking a dot reassigns it to the nearest hub by distance instead of
  // toggling it on/off the selected hub — a shortcut for big reassignments.
  const [autoAssign, setAutoAssign] = useState(false);

  // ── Zoom & pan ──────────────────────────────────────────────────────────
  // A view transform (scale + translate in viewBox units) wraps the drawing so
  // the operator can zoom into a dense area to click individual postcode dots.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  // Distinguishes a pan-drag from a click so dragging never toggles a dot.
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const MIN_SCALE = 1;
  const MAX_SCALE = 8;
  const clampScale = (s: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

  /** Keeps the view inside the drawing — at scale 1 there's nothing to pan (snap to
   *  origin); above that, tx/ty are clamped so the viewBox never scrolls past the edge. */
  const clampView = (v: { scale: number; tx: number; ty: number }): { scale: number; tx: number; ty: number } => {
    const scale = clampScale(v.scale);
    if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
    const minTx = VIEW_W * (1 - scale);
    const minTy = VIEW_H * (1 - scale);
    return {
      scale,
      tx: Math.max(minTx, Math.min(0, v.tx)),
      ty: Math.max(minTy, Math.min(0, v.ty)),
    };
  };

  /** Client pixel → viewBox coordinate (no letterboxing: width:100%/height:auto
   *  keeps the rendered aspect ratio identical to the viewBox). */
  const toViewBox = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: ((clientX - rect.left) / rect.width) * VIEW_W,
      y: ((clientY - rect.top) / rect.height) * VIEW_H,
    };
  };

  /** Zoom toward an anchor point so it stays fixed under the cursor. */
  const zoomAt = (factor: number, anchorX: number, anchorY: number) => {
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const worldX = (anchorX - v.tx) / v.scale;
      const worldY = (anchorY - v.ty) / v.scale;
      return clampView({ scale, tx: anchorX - worldX * scale, ty: anchorY - worldY * scale });
    });
  };

  // React 19 registers wheel as a passive root listener, so e.preventDefault() inside
  // an onWheel prop is a silent no-op (page scrolls under the cursor while "zooming").
  // A native, explicitly non-passive listener is the only way to actually block it.
  const toViewBoxRef = useRef(toViewBox);
  toViewBoxRef.current = toViewBox;
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      // Only hijack the wheel for zoom when the operator explicitly asks (Ctrl/⌘+
      // scroll, the Google-Maps-embed convention). A plain scroll over the map must
      // fall through to the PAGE — otherwise scrolling the admin panel past the map
      // silently zooms it to a mess of giant overlapping dots (the reported bug).
      if (!e.ctrlKey && !e.metaKey) return; // let the page scroll
      e.preventDefault();
      const p = toViewBoxRef.current(e.clientX, e.clientY);
      zoomAtRef.current(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, []);

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return; // below threshold — still a click
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView((v) => {
      if (v.scale === 1) return v; // nothing to pan at the default zoom
      return clampView({ ...v, tx: v.tx + (dx / rect.width) * VIEW_W, ty: v.ty + (dy / rect.height) * VIEW_H });
    });
  };
  const onPointerUp = () => {
    // Clear on the next tick so the click handler (fires after pointerup) can read `moved`.
    const d = drag.current;
    if (d) setTimeout(() => { if (drag.current === d) drag.current = null; }, 0);
  };
  /** True when the last gesture was a pan — dot clicks consult this to stay inert. */
  const wasDragged = () => drag.current?.moved ?? false;
  const resetView = () => setView({ scale: 1, tx: 0, ty: 0 });

  // Area → owning hub index, from the SAVED network; the selected hub's ownership
  // is then overlaid from its draft so map clicks preview before Save.
  const ownerByArea = useMemo(() => {
    const m = new Map<string, number>();
    hubs.forEach((h, i) => {
      for (const a of h.catchment) m.set(a.toUpperCase(), i);
    });
    return m;
  }, [hubs]);

  const selectedIndex = selectedHubId ? hubs.findIndex((h) => h.id === selectedHubId) : -1;
  const draftSet = new Set(selectedCatchment.map((a) => a.toUpperCase()));

  const areaEntries = Object.entries(AREAS);
  const unassigned = areaEntries.filter(([code]) => {
    const owner = ownerByArea.get(code);
    if (selectedIndex >= 0) {
      // While editing: the draft owns its set; areas saved to this hub but removed
      // from the draft count as unassigned in the preview.
      if (draftSet.has(code)) return false;
      return owner === undefined || owner === selectedIndex;
    }
    return owner === undefined;
  }).length;

  // Hub markers sit at the mean position of their (saved) catchment areas.
  const hubMarkers = hubs.map((h, i) => {
    const pts = h.catchment
      .map((a) => AREAS[a.toUpperCase()])
      .filter((a): a is NonNullable<typeof a> => a != null)
      .map((a) => project(a.lat, a.lng));
    if (pts.length === 0) return null;
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return { hub: h, index: i, x, y };
  });

  // Same mean-of-catchment centre, but in real lat/lng — feeds the nearest-hub-by-distance
  // shortcut, which needs actual geography, not projected map coordinates.
  const hubPositions = useMemo(
    () =>
      hubs
        .map((h) => {
          const pts = h.catchment.map((a) => AREAS[a.toUpperCase()]).filter((a): a is NonNullable<typeof a> => a != null);
          if (pts.length === 0) return null;
          return {
            id: h.id,
            lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
            lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p != null),
    [hubs],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
      <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
        {autoAssign ? (
          <>Auto-assign is on — click any postcode dot to hand it to whichever hub is nearest by straight-line distance.</>
        ) : selectedIndex >= 0 ? (
          <>
            <strong>{hubs[selectedIndex]?.name}</strong> is active — click any postcode dot to add it,
            click one of its own dots to remove it, then Save below.
          </>
        ) : (
          <>Pick a hub below, then click postcode dots on the map to assign them. Positions are approximate.</>
        )}
      </p>

      {onAssignArea && (
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: font.xs, color: color.text, cursor: "pointer" }}>
          <input type="checkbox" checked={autoAssign} onChange={(e) => setAutoAssign(e.target.checked)} />
          Auto-assign by nearest hub (skip picking a hub — just click dots)
        </label>
      )}

      {/* Active-hub picker — always visible so it's obvious you pick a hub, then click dots.
          The active chip is filled; clicking a dot assigns/removes it for this hub. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.xs, opacity: autoAssign ? 0.5 : 1 }}>
        {hubs.map((h, i) => {
          const active = h.id === selectedHubId;
          return (
            <button
              key={h.id}
              type="button"
              onClick={() => onSelectHub(h)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 10px",
                borderRadius: 999,
                border: `1px solid ${active ? hubColor(i) : color.border}`,
                background: active ? hubColor(i) : color.surface,
                color: active ? color.surface : color.text,
                fontSize: font.xs,
                fontWeight: active ? 700 : 500,
                cursor: "pointer",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: active ? color.surface : hubColor(i),
                  display: "inline-block",
                }}
              />
              {h.name}
            </button>
          );
        })}
        <span style={{ alignSelf: "center", fontSize: font.xs, color: color.muted }}>
          ◌ unassigned: {unassigned}
        </span>
      </div>

      <div style={{ position: "relative" }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label="Map of hubs and their postcode areas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        style={{
          width: "100%",
          height: "auto",
          background: color.surfaceSub,
          border: `1px solid ${color.border}`,
          borderRadius: 8,
          touchAction: "none",
          cursor: view.scale > 1 ? "grab" : "default",
        }}
      >
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
        {/* Trunk lines between every pair of hubs — any hub can trunk to any other. */}
        {hubMarkers.map((a, i) =>
          hubMarkers.slice(i + 1).map(
            (b) =>
              a &&
              b && (
                <line
                  key={`${a.hub.id}-${b.hub.id}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={color.border}
                  strokeWidth={0.5}
                  strokeOpacity={0.35}
                  strokeDasharray="2 4"
                />
              ),
          ),
        )}

        {/* Postcode-area dots */}
        {areaEntries.map(([code, info]) => {
          const { x, y } = project(info.lat, info.lng);
          const savedOwner = ownerByArea.get(code);
          // Draft preview wins for the selected hub; otherwise saved ownership shows.
          const inDraft = selectedIndex >= 0 && draftSet.has(code);
          const removedFromDraft = selectedIndex >= 0 && savedOwner === selectedIndex && !inDraft;
          const ownerIndex = inDraft ? selectedIndex : removedFromDraft ? undefined : savedOwner;
          const fill = ownerIndex !== undefined ? hubColor(ownerIndex) : "transparent";
          const ownerName = ownerIndex !== undefined ? hubs[ownerIndex]?.name : "unassigned";
          return (
            <g
              key={code}
              onClick={() => {
                if (wasDragged()) return;
                if (autoAssign && onAssignArea) {
                  const nearest = nearestHubId(info, hubPositions);
                  if (nearest) onAssignArea(code, nearest);
                  return;
                }
                if (selectedIndex >= 0) onToggleArea(code);
              }}
              style={{ cursor: selectedIndex >= 0 || autoAssign ? "pointer" : "default" }}
            >
              <title>{`${code} — ${info.name} (${ownerName})`}</title>
              <circle
                cx={x}
                cy={y}
                r={4}
                fill={fill}
                fillOpacity={ownerIndex !== undefined ? 0.85 : 1}
                stroke={ownerIndex !== undefined ? "none" : color.muted}
                strokeWidth={1}
                strokeDasharray={ownerIndex !== undefined ? undefined : "2 2"}
              />
              {inDraft && (
                <circle cx={x} cy={y} r={6.5} fill="none" stroke={hubColor(selectedIndex)} strokeWidth={1.2} />
              )}
            </g>
          );
        })}

        {/* Hub markers */}
        {hubMarkers.map(
          (m) =>
            m && (
              <g
                key={m.hub.id}
                onClick={() => !wasDragged() && onSelectHub(m.hub)}
                style={{ cursor: "pointer" }}
              >
                <title>{`${m.hub.name} — ${m.hub.catchment.length} postcode areas`}</title>
                <rect
                  x={m.x - 5}
                  y={m.y - 5}
                  width={10}
                  height={10}
                  rx={2}
                  fill={hubColor(m.index)}
                  stroke={m.hub.id === selectedHubId ? color.text : color.surface}
                  strokeWidth={m.hub.id === selectedHubId ? 2 : 1.2}
                  transform={`rotate(45 ${m.x} ${m.y})`}
                />
                {/* Short hub label on the map so the 6 hubs read as distinct places,
                    not just coloured dots — the "see individual hubs" the operator asked
                    for. Counter-scaled so it stays legible at any zoom; halo via paint
                    order so it survives over dense dots. */}
                <text
                  x={m.x}
                  y={m.y - 8 / view.scale}
                  textAnchor="middle"
                  fontSize={8 / view.scale}
                  fontWeight={700}
                  fill={hubColor(m.index)}
                  stroke={color.surface}
                  strokeWidth={2.5 / view.scale}
                  paintOrder="stroke"
                  style={{ pointerEvents: "none" }}
                >
                  {shortLabel(m.hub.name)}
                </text>
              </g>
            ),
        )}
        </g>
      </svg>

        {/* Zoom controls — for trackpad-less use and quick reset */}
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.3, VIEW_W / 2, VIEW_H / 2)} style={zoomBtn}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.3, VIEW_W / 2, VIEW_H / 2)} style={zoomBtn}>
            −
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            onClick={resetView}
            disabled={view.scale === 1 && view.tx === 0 && view.ty === 0}
            style={{ ...zoomBtn, fontSize: font.xs }}
          >
            ⤢
          </button>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
        {view.scale > 1
          ? `Zoomed ${view.scale.toFixed(1)}× — drag to pan, ⌘/Ctrl+scroll to zoom, ⤢ to reset.`
          : "Use + / − or ⌘/Ctrl+scroll to zoom in on a dense area."}
      </p>

    </div>
  );
}
