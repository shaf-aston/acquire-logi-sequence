"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { Placement } from "@/types/api";
import { threeCenter, threeSize, type Frame } from "@/lib/packing/van-scene-geometry";
import type { Theme } from "./theme";
import { tooltip } from "./styles";
import { color } from "@/styles/tokens";

/* ── Item box ───────────────────────────────────────────────────────────── */

interface ItemBoxProps {
  placement: Placement;
  frame: Frame;
  theme: Theme;
  index: number;
  name?: string;
  selected: boolean;
  editable: boolean;
  /** Many boxes in this van → show the number badge only on hover, to spare the
   *  browser 500 always-on DOM overlays it must reposition every frame. */
  dense: boolean;
  /** Validator-faithful crush-limit flag from `stackLoadByPlacement` — drives the
   *  orange fill/edge/badge. NEVER derived from `loadRatio > 1` (they can differ). */
  overloaded: boolean;
  /** This box is a PARKED rotation preview that doesn't fit where it sits — tint it
   *  red (the invalid-ghost colour) so it reads as unsettled. It stays a normal,
   *  grabbable ItemBox: the operator drags it to a valid spot to settle the spin. */
  previewInvalid?: boolean;
  /** 0..1+ fill fraction for the on-hover tooltip's "Load on top" line. */
  loadRatio: number;
  /** Optional per-box fill colour keyed to an arbitrary group (e.g. the owning company in the
   *  shared-truck stack). When set it overrides the standard/fragile fill, but NEVER the
   *  overloaded/invalid states — a safety tint must still win, so it stays on the edge. */
  groupColor?: string;
  onPointerDownBox?: (index: number, e: ThreeEvent<PointerEvent>) => void;
}

// memo: during a drag the parent Scene re-renders on every pointer move; without
// this all 500 boxes would reconcile each time. With stable props (see the useMemo
// frame + useCallback beginDrag in Scene) only the box whose `selected`/`dense`
// actually changed re-renders.
export const ItemBox = memo(function ItemBox({ placement, frame, theme, index, name, selected, editable, dense, overloaded, previewInvalid = false, loadRatio, groupColor, onPointerDownBox }: ItemBoxProps) {
  const [hovered, setHovered] = useState(false);

  const { sx, sy, sz } = threeSize(placement.size);
  const [cx, cy, cz] = threeCenter(placement, frame);

  // ONE box geometry, shared by the fill mesh and its edge outline, memoized on size
  // so it isn't reallocated every render and disposed on unmount. (Previously a fresh
  // THREE.BoxGeometry was built inline for the edges on every render — across 500
  // boxes that leaked GPU memory and stalled orbiting.)
  const boxGeom = useMemo(() => new THREE.BoxGeometry(sx, sy, sz), [sx, sy, sz]);
  const edgesGeom = useMemo(() => new THREE.EdgesGeometry(boxGeom), [boxGeom]);
  useEffect(() => () => { boxGeom.dispose(); edgesGeom.dispose(); }, [boxGeom, edgesGeom]);

  // A parked invalid rotation preview reads red first — it outranks the fragile /
  // overload tints because "this doesn't fit here, move it" is the operative state.
  // A hand-flagged box (operator forced an invalid placement) reads amber, below the
  // computed overload/invalid alarms but ABOVE the company/fragile fill, so a forced
  // box is never mistaken for a clean one. A groupColor (company in the shared-truck
  // stack) sits BELOW the safety tints and ABOVE the plain standard tint on both fill
  // AND edge/badge — the edge is what actually reads from a top-down view, so the
  // company colour has to reach it too, not just the translucent fill. Fragile keeps
  // its own dedicated pink edge regardless of company: fragility is a safety flag and
  // must never be swallowed by the company colouring.
  const fill = previewInvalid ? theme.invalidGhost : overloaded ? theme.overloadFill : placement.flagged ? theme.flaggedFill : groupColor ?? (placement.fragile ? theme.fragileFill : theme.standardFill);
  const edge = previewInvalid ? theme.invalidGhost : selected ? theme.selected : overloaded ? theme.overloadEdge : placement.flagged ? theme.flaggedEdge : placement.fragile ? theme.fragileEdge : groupColor ?? theme.standardEdge;
  const label = String(index + 1);

  // Badge hidden while selected (the Rotate toolbar anchors there); for dense loads
  // it shows only on hover so numbers stay reachable without 500 live DOM overlays.
  // Overloaded AND hand-flagged items always show their badge (even dense/unhovered) —
  // a "never guess" safety surface must not be hidden behind a hover.
  const showBadge = !selected && (overloaded || placement.flagged || !dense || hovered);

  return (
    <group>
      <mesh
        geometry={boxGeom}
        position={[cx, cy, cz]}
        scale={hovered || selected ? 1.03 : 1}
        onPointerEnter={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={editable ? (e) => onPointerDownBox?.(index, e) : undefined}
      >
        <meshStandardMaterial color={fill} transparent opacity={selected ? 0.92 : 0.82} />
      </mesh>
      <lineSegments geometry={edgesGeom} position={[cx, cy, cz]}>
        <lineBasicMaterial color={edge} linewidth={selected ? 2 : 1} />
      </lineSegments>
      {showBadge && (
        <Html position={[cx, cy + sy / 2 + 0.03, cz]} center>
          <div style={{
            background: overloaded ? theme.overloadEdge : placement.flagged ? theme.flaggedEdge : placement.fragile ? theme.fragileEdge : groupColor ?? theme.standardEdge,
            color: color.onAccent,
            borderRadius: "50%", width: 20, height: 20,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 700, pointerEvents: "none",
            boxShadow: color.shadowFloatStrong,
          }}>
            {overloaded ? "⚠" : label}
          </div>
        </Html>
      )}
      {hovered && !selected && (
        <Html position={[cx, cy + sy / 2 + 0.12, cz]} center>
          <div style={tooltip}>
            <strong>{label}. {name ?? `Item ${label}`}</strong>
            <br />
            {placement.size.x.toFixed(2)}×{placement.size.y.toFixed(2)}×{placement.size.z.toFixed(2)} m
            <br />
            {placement.weightKg} kg &nbsp;
            <span style={{ color: placement.fragile ? color.fragile.fg : color.standard.fg }}>
              {placement.fragile ? "Fragile" : "Standard"}
            </span>
            {loadRatio > 0 && (
              <>
                <br />
                <span style={{ color: overloaded ? theme.overloadEdge : color.muted }}>
                  Load on top: {Number.isFinite(loadRatio) ? `${Math.round(loadRatio * 100)}%` : "over"} of limit
                </span>
              </>
            )}
          </div>
        </Html>
      )}
    </group>
  );
});
