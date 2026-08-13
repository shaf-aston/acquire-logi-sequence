"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// Vertical axis for view rotation (spinning the camera around the van, upright).
const UP = new THREE.Vector3(0, 1, 0);

/* ── Camera capture — exposes camera ref outside Canvas ─────────────────── */

export function CameraCapture({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const { camera } = useThree();
  useEffect(() => { cameraRef.current = camera; }, [camera, cameraRef]);
  return null;
}

/* ── View controls — snap the camera to preset angles ─────────────────────── */

/** Imperative camera moves, driven from the toolbar buttons outside the Canvas. */
export interface ViewApi {
  /** Spin the view a quarter-turn around the van (positive = left). */
  rotate: (rad: number) => void;
  /** Look straight down from above. */
  top: () => void;
  /** Return to the default loading angle AND re-centre on the van. */
  reset: () => void;
  /** Abort an in-flight snap so a manual orbit takes over immediately. */
  cancel: () => void;
}

// Minimal structural view of drei's OrbitControls — only what we drive here.
type OrbitLike = { object: { position: THREE.Vector3 }; target: THREE.Vector3; update: () => void };

/**
 * Lives inside the Canvas so it can reach the default OrbitControls. Button
 * presses set a target camera position (and, for reset, a target look-at); each
 * frame the camera eases toward them (a smooth quarter-turn, not a jarring jump)
 * and stops once it arrives. When no target is pending it does nothing, leaving
 * the user's free orbit untouched; a manual orbit (OrbitControls 'start') cancels
 * any in-flight snap so the two never fight.
 */
export function ViewControls({ apiRef, initialPos }: { apiRef: React.MutableRefObject<ViewApi | null>; initialPos: [number, number, number] }) {
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null;
  // Under frameloop="demand" (the small read-only cards) frames only render when requested, so the
  // snap animation below must schedule its own — otherwise a button press would freeze mid-ease.
  // In frameloop="always" invalidate() is harmless, so the sacred main viewer is unaffected.
  const invalidate = useThree((s) => s.invalidate);
  const posGoal = useRef<THREE.Vector3 | null>(null);
  const lookGoal = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    if (!controls) return;
    apiRef.current = {
      rotate: (rad) => {
        const off = controls.object.position.clone().sub(controls.target);
        off.applyAxisAngle(UP, rad);
        posGoal.current = controls.target.clone().add(off);
        lookGoal.current = controls.target.clone(); // keep looking where we are
        invalidate(); // kick the first frame under demand mode
      },
      top: () => {
        const r = controls.object.position.clone().sub(controls.target).length();
        // Tiny x/z nudge avoids a degenerate straight-down gimbal.
        posGoal.current = controls.target.clone().add(new THREE.Vector3(0.001, r, 0.001));
        lookGoal.current = controls.target.clone();
        invalidate();
      },
      reset: () => {
        posGoal.current = new THREE.Vector3(initialPos[0], initialPos[1], initialPos[2]);
        lookGoal.current = new THREE.Vector3(0, 0, 0); // van is centred on the origin
        invalidate();
      },
      cancel: () => { posGoal.current = null; lookGoal.current = null; },
    };
    return () => { apiRef.current = null; };
  }, [controls, apiRef, initialPos, invalidate]);

  useFrame(() => {
    const pos = posGoal.current;
    if (!pos || !controls) return;
    controls.object.position.lerp(pos, 0.25);
    if (lookGoal.current) controls.target.lerp(lookGoal.current, 0.25);
    controls.update();
    const posDone = controls.object.position.distanceTo(pos) < 0.01;
    const lookDone = !lookGoal.current || controls.target.distanceTo(lookGoal.current) < 0.01;
    if (posDone && lookDone) {
      controls.object.position.copy(pos);
      if (lookGoal.current) controls.target.copy(lookGoal.current);
      controls.update();
      posGoal.current = null;
      lookGoal.current = null;
    } else {
      invalidate(); // keep easing next frame under demand mode
    }
  });

  return null;
}
