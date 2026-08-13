"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { Placement } from "@/types/api";
import { FLOOR_EPS_M } from "@/lib/packing/placement-validator";
import { threeCenter, threeSize, type Frame } from "@/lib/packing/van-scene-geometry";
import type { Theme } from "./theme";
import { tooltip } from "./styles";
import { color } from "@/styles/tokens";

/* ── Drag ghost + capture plane ─────────────────────────────────────────── */

export interface Ghost {
  index: number;
  candidate: Placement;
  valid: boolean;
  reason?: string;
  /** Always-on contact readout ("On the van floor" / "Resting on item 3 · 0.40m
   *  up") so a drag never leaves it ambiguous whether the box actually settled
   *  onto something or is still hanging above it. */
  restingLabel: string;
}

export function GhostBox({ ghost, liveRef, frame, theme }: { ghost: Ghost; liveRef: React.MutableRefObject<Ghost | null>; frame: Frame; theme: Theme }) {
  const { sx, sy, sz } = threeSize(ghost.candidate.size);
  const tint = ghost.valid ? theme.validGhost : theme.invalidGhost;
  const edge = ghost.candidate.fragile ? theme.fragileEdge : theme.standardEdge;
  const label = String(ghost.index + 1);
  // Memoized on size (the box's footprint is fixed for a drag — only its position
  // moves) so a long drag doesn't leak one geometry per pointer-move. Disposed on
  // unmount, i.e. when the drag ends.
  const boxGeom = useMemo(() => new THREE.BoxGeometry(sx, sy, sz), [sx, sy, sz]);
  const edgesGeom = useMemo(() => new THREE.EdgesGeometry(boxGeom), [boxGeom]);
  useEffect(() => () => { boxGeom.dispose(); edgesGeom.dispose(); }, [boxGeom, edgesGeom]);

  // Position is driven straight from `liveRef` every rendered frame, NOT from React
  // state/props — pointer-move fires 100+×/sec and routing each sample through
  // setState re-rendered the whole Scene, which was the actual cause of "not
  // smooth" dragging. `ghost` (props/state) only changes when validity/reason/
  // resting-support flips — rare — so React re-renders for those, while position
  // updates every frame here for free (drei's <Html> tracks the group's transform
  // the same way, so the badge/labels glide with the box without a re-render).
  const groupRef = useRef<THREE.Group>(null);
  useEffect(() => {
    if (!groupRef.current) return;
    const [cx, cy, cz] = threeCenter(ghost.candidate, frame);
    groupRef.current.position.set(cx, cy, cz);
    // Mount-time sync only — every subsequent frame is driven by useFrame below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame(() => {
    const live = liveRef.current;
    if (!live || !groupRef.current) return;
    const [cx, cy, cz] = threeCenter(live.candidate, frame);
    groupRef.current.position.set(cx, cy, cz);
  });

  return (
    <group ref={groupRef}>
      <mesh geometry={boxGeom}>
        <meshStandardMaterial color={tint} transparent opacity={0.35} depthWrite={false} />
      </mesh>
      <lineSegments geometry={edgesGeom}>
        <lineBasicMaterial color={edge} />
      </lineSegments>
      <Html position={[0, sy / 2 + 0.03, 0]} center>
        <div style={{
          background: ghost.candidate.fragile ? theme.fragileEdge : theme.standardEdge,
          color: color.onAccent,
          borderRadius: "50%", width: 20, height: 20,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 700, pointerEvents: "none",
          boxShadow: color.shadowFloatStrong,
          opacity: 0.85,
        }}>
          {label}
        </div>
      </Html>
      <Html position={[0, -sy / 2 - 0.04, 0]} center>
        <div style={{
          ...tooltip,
          padding: "3px 8px",
          borderColor: ghost.valid ? theme.validGhost : theme.invalidGhost,
          color: ghost.valid ? color.text : color.error,
        }}>
          {ghost.restingLabel}
        </div>
      </Html>
      {!ghost.valid && ghost.reason && (
        <Html position={[0, sy / 2 + 0.14, 0]} center>
          <div style={{ ...tooltip, borderColor: theme.invalidGhost, color: color.error }}>{ghost.reason}</div>
        </Html>
      )}
    </group>
  );
}

/**
 * What a candidate at `drop` is actually resting on — the floor, or a specific
 * other placement (by its badge number) at a given height. Shared by every ghost
 * frame so the operator always has a concrete, unambiguous contact readout
 * instead of eyeballing the 3D perspective to guess whether it "sank in."
 */
export function describeSupport(
  candidate: Pick<Placement, "position" | "size">,
  placements: readonly Placement[],
  skipIndex: number,
  tol: number,
): string {
  const { position: pos, size } = candidate;
  if (pos.z <= FLOOR_EPS_M) return "On the van floor";
  for (let i = 0; i < placements.length; i++) {
    if (i === skipIndex) continue;
    const p = placements[i]!;
    if (Math.abs(p.position.z + p.size.z - pos.z) > tol) continue;
    const overlapsXY =
      pos.x < p.position.x + p.size.x && p.position.x < pos.x + size.x &&
      pos.y < p.position.y + p.size.y && p.position.y < pos.y + size.y;
    if (overlapsXY) return `Resting on item ${i + 1} · ${pos.z.toFixed(2)}m up`;
  }
  return `${pos.z.toFixed(2)}m up — no support directly underneath`;
}
