"use client";

import { useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { VanDimensions } from "@/types/api";
import { frameFor, type Frame } from "@/lib/packing/van-scene-geometry";
import type { Theme } from "./theme";
import { color, font, spacing } from "@/styles/tokens";

/* ── Wall labels (rotation-aware: shows max 2 most-visible faces) ─────────── */

// The y=0 (van origin) wall sits at three.js -z; in the default loader view that
// wall reads on the RIGHT, so it carries the "Right" label and y=w carries "Left".
const WALL_DEFS = [
  { name: "Rear",  normal: new THREE.Vector3(-1, 0,  0), priority: 2 },
  { name: "Right", normal: new THREE.Vector3( 0, 0, -1), priority: 1 },
  { name: "Left",  normal: new THREE.Vector3( 0, 0,  1), priority: 0 },
  { name: "Top",   normal: new THREE.Vector3( 0, 1,  0), priority: 0 },
] as const;

function wallCenter(name: string, f: Frame): THREE.Vector3 {
  if (name === "Rear")  return new THREE.Vector3(-f.vanW / 2, f.vanH * 0.1, 0);
  if (name === "Right") return new THREE.Vector3(0, f.vanH * 0.1, -f.vanD / 2);
  if (name === "Left")  return new THREE.Vector3(0, f.vanH * 0.1,  f.vanD / 2);
  return new THREE.Vector3(0, f.vanH / 2, 0); // Top
}

function wallLabelPos(name: string, f: Frame): [number, number, number] {
  const c = wallCenter(name, f);
  return [c.x, c.y, c.z];
}

export function WallLabels({ interior, theme }: { interior: VanDimensions; theme: Theme }) {
  const f = frameFor(interior);
  const { camera } = useThree();
  const [visible, setVisible] = useState<Set<string>>(new Set());

  useFrame(() => {
    const scored = WALL_DEFS.map((w) => ({
      name: w.name,
      dot: camera.position.clone().sub(wallCenter(w.name, f)).normalize().dot(w.normal),
      priority: w.priority,
    }));
    const top2 = scored
      .filter((s) => s.dot > 0.25)
      .sort((a, b) => b.priority - a.priority || b.dot - a.dot)
      .slice(0, 2)
      .map((s) => s.name);
    // Only commit when the set actually changed — otherwise this runs setState on
    // every frame, re-rendering the whole scene (all 500 boxes) ~60×/sec.
    setVisible((prev) =>
      prev.size === top2.length && top2.every((n) => prev.has(n)) ? prev : new Set(top2),
    );
  });

  return (
    <>
      {WALL_DEFS.map((w) =>
        visible.has(w.name) ? (
          <Html key={w.name} position={wallLabelPos(w.name, f)} center>
            <span
              style={{
                opacity: 0.28,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.12em",
                color: theme.wire,
                textTransform: "uppercase",
                pointerEvents: "none",
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
            >
              {w.name}
            </span>
          </Html>
        ) : null,
      )}
    </>
  );
}

/* ── Van wireframe ──────────────────────────────────────────────────────── */

export function VanWireframe({ interior, theme }: { interior: VanDimensions; theme: Theme }) {
  const f = frameFor(interior);
  return (
    <lineSegments>
      <edgesGeometry args={[new THREE.BoxGeometry(f.vanW, f.vanH, f.vanD)]} />
      <lineBasicMaterial color={theme.wire} />
    </lineSegments>
  );
}

/* ── Legend ─────────────────────────────────────────────────────────────── */

export function Legend({ theme, editable }: { theme: Theme; editable: boolean }) {
  return (
    <div style={{ display: "flex", gap: spacing.md, marginTop: spacing.xs, alignItems: "center", flexWrap: "wrap" }}>
      <LegendSwatch fill={theme.standardFill} edge={theme.standardEdge} label="Standard" />
      <LegendSwatch fill={theme.fragileFill} edge={theme.fragileEdge} label="Fragile" />
      <LegendSwatch fill={theme.overloadFill} edge={theme.overloadEdge} label="⚠ Over limit" />
      <span style={{ fontSize: font.xs, color: color.muted, marginLeft: "auto" }}>
        {editable
          ? "Click an item to select · Drag to move · Spin/flip with its buttons · Orbit empty space · Scroll to zoom"
          : "Drag to rotate · Scroll to zoom"}
      </span>
    </div>
  );
}

function LegendSwatch({ fill, edge, label }: { fill: string; edge: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: font.xs, color: color.muted }}>
      <span style={{ width: 12, height: 12, background: fill, border: `1px solid ${edge}`, borderRadius: 2, display: "inline-block" }} />
      {label}
    </span>
  );
}
