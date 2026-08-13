"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Placement, Vec3, VanDimensions } from "@/types/api";
import { resolveDrop, validateArrangement, validatePlacement, reconcileFlags, stackLoadByPlacement, FLOOR_EPS_M } from "@/lib/packing/placement-validator";
import { frameFor, threeCenter, worldToVanXY, clamp, mm } from "@/lib/packing/van-scene-geometry";
import type { Theme } from "./theme";
import { ItemBox } from "./ItemBox";
import { type Ghost, GhostBox, describeSupport } from "./GhostBox";
import { CameraCapture, ViewControls, type ViewApi } from "./CameraControls";
import { VanWireframe, WallLabels } from "./SceneDecorations";
import { SelectedItemToolbar } from "./Toolbar";
import van3dSceneConfig from "../../../../config/van-3d-scene.json";

/** Tunable Three.js scene knobs (lighting, camera, render quality, drag interaction) — see the JSON's own note. */
interface Van3DSceneConfig {
  ambientLightIntensity: number;
  directionalLight: { position: [number, number, number]; intensity: number };
  gridDivisions: number;
  cameraFovDeg: number;
  dprRange: [number, number];
  /** How finely (m) a dragged box follows the cursor. Small = smooth/fine, large = chunky. */
  dragSnapStepM: number;
}
const SCENE_CONFIG = van3dSceneConfig as unknown as Van3DSceneConfig;

// Above this many boxes in one van, the per-item number badges (each a DOM overlay
// the browser must reposition every frame) are shown only for the hovered/selected
// item — otherwise 500 always-on labels stall orbiting. Below it, all numbers stay
// visible. A UI-perf knob, not domain logic: raise it if a machine handles more.
const BADGE_DENSITY_THRESHOLD = 60;

/**
 * Only an EXPLICIT partial/none lock permits a floor-spin (an l/w swap keeps the
 * item upright, which those locks allow). A "fixed" lock — or an unknown/undefined
 * one — is treated as not-spinnable: fail safe, never silently loosen the lock.
 */
function canSpin(lock: Placement["orientationLock"]): boolean {
  return lock === "partial" || lock === "none";
}

/**
 * Flipping tips the box onto a different face, so it changes which dimension is
 * vertical — only a fully-free ("none") lock permits that. A "partial" lock means
 * upright-any-facing (spin only); "fixed"/unknown means no turning at all. Fail safe.
 */
function canFlip(lock: Placement["orientationLock"]): boolean {
  return lock === "none";
}

/* ── Scene ───────────────────────────────────────────────────────────────── */

interface SceneProps {
  placements: Placement[];
  interior: VanDimensions;
  itemNames?: string[];
  /** Optional per-placement fill colour (index-aligned) — e.g. the owning company in the
   *  shared-truck stack. Passed straight to each ItemBox; safety tints still win. */
  groupColors?: string[];
  theme: Theme;
  editable: boolean;
  onPlacementsChange?: (next: Placement[]) => void;
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  viewApiRef: React.MutableRefObject<ViewApi | null>;
  initialPos: [number, number, number];
  clearSelRef: React.MutableRefObject<(() => void) | null>;
  /** Clearance slack (m) — the SAME value the packer validated with (config). */
  toleranceM: number;
  /** Every van in the working fleet, for the "move van" menu. */
  vans: { key: string; label: string }[];
  /** This van's key within `vans` — excluded from the "move van" menu. */
  vanKey: string;
  onMoveToVan?: (itemIndex: number, toKey: string) => void;
  /** Remove the item at `itemIndex` in THIS van, returning it to Unplaced. */
  onUnplace?: (itemIndex: number) => void;
  /**
   * Highest a worker may place an item's base by hand (m) — same value the packer
   * validated with. Undefined ⇒ no limit (the operator turned it off). Callers must
   * resolve their own "not provided" default before passing this down — this
   * component does not silently reinterpret undefined as "apply a default limit".
   */
  maxReachHeightM?: number;
  /** Ghost preview for an item dragged in from the Unplaced tray (HTML5 drag —
   *  the viewer computes it from dragover, this scene just paints it). Same
   *  ref+state split as the in-scene drag ghost: `trayGhost` re-renders on
   *  validity flips, `trayGhostLiveRef` drives the position every frame. */
  trayGhost?: Ghost | null;
  trayGhostLiveRef?: React.MutableRefObject<Ghost | null>;
}

export function Scene({ placements, interior, itemNames, groupColors, theme, editable, onPlacementsChange, cameraRef, viewApiRef, initialPos, clearSelRef, toleranceM, vans, vanKey, onMoveToVan, onUnplace, maxReachHeightM, trayGhost, trayGhostLiveRef }: SceneProps) {
  // Stable across renders (only changes with the van) so the memoized ItemBoxes
  // aren't invalidated on every drag/selection re-render.
  const f = useMemo(() => frameFor(interior), [interior]);
  const dense = placements.length > BADGE_DENSITY_THRESHOLD;
  const loads = useMemo(() => stackLoadByPlacement(placements, toleranceM), [placements, toleranceM]);
  const [selected, setSelected] = useState<number | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  // A rotation the operator asked for that doesn't fit where the item currently
  // sits. Rather than refuse and leave the box un-rotated (the old behaviour), we
  // SHOW the spun box in place — flagged invalid (red) — so the operator can grab
  // it and drag it to a spot where it does fit. This is scene-local, transient
  // state: it is NEVER committed to `placements` (an invalid layout would corrupt
  // stackLoadByPlacement / isFleetModified / the next edit's validateArrangement),
  // and it is dropped the moment anything commits (see the [placements] effect) or
  // the selection clears. It is orthogonal to the drag `ghost` on purpose — reusing
  // `ghost` would trip `dragging` and disable orbit/toolbar for a parked preview.
  const [preview, setPreview] = useState<{ index: number; candidate: Placement } | null>(null);

  // Clear the "won't fit" note whenever the selection changes.
  useEffect(() => setEditErr(null), [selected]);
  // A parked rotation preview belongs to one selected box in one arrangement. Drop
  // it whenever the selection changes OR any edit commits (rotate/drag/move/reset
  // all produce a new `placements` identity) — preview is transient scene state,
  // never a settled placement, so a committed change always supersedes it.
  useEffect(() => setPreview(null), [selected]);
  useEffect(() => setPreview(null), [placements]);
  // Let the Canvas clear selection when the user clicks empty space.
  useEffect(() => {
    clearSelRef.current = () => setSelected(null);
    return () => { clearSelRef.current = null; };
  }, [clearSelRef]);
  // Pointer offset (world x,z) between the grab point and the box centre, so the
  // box doesn't jump under the cursor when the drag starts.
  const grab = useRef<{ index: number; dx: number; dz: number } | null>(null);
  // rAF-coalesced drag: pointer-move can fire 100+×/sec, and each setGhost re-renders
  // the whole Scene. We stash the latest world point and recompute at most once per
  // frame — the visible cause of the "choppy" drag was one React render per raw event.
  const pendingPoint = useRef<{ px: number; pz: number } | null>(null);
  const dragRaf = useRef<number | null>(null);
  // Latest ghost every frame — GhostBox reads this imperatively (see its useFrame)
  // so position tracks the pointer at full frame rate without going through React
  // state. `ghost` (state) is the coarser value that only changes on a validity/
  // reason/support flip, and is what endDrag commits.
  const liveGhostRef = useRef<Ghost | null>(null);
  // The snapped candidate (x,y,z + footprint) computed last drag frame. When the
  // cursor maps to the same settled cell — sub-pixel jitter, or sweeping within one
  // support's extent — the verdict can't have changed, so we skip the whole
  // per-frame recompute (incl. the O(n²) arrangement walk) and reuse last frame's
  // ghost verbatim. Pure memo: same inputs ⇒ same output, no behaviour change.
  const lastCell = useRef<string | null>(null);

  const dragging = ghost !== null;

  // The box as the operator SEES it at `index`: the parked rotation preview when
  // one is pending for that box, otherwise its committed placement. A grab must
  // start from — and drag in — the previewed (rotated) footprint, not the stale
  // committed one, or the spin would snap away the instant the drag begins.
  const shownAt = (index: number): Placement =>
    preview?.index === index ? preview.candidate : placements[index]!;

  // Stable identity (deps: placements, preview, f, toleranceM) so it doesn't
  // invalidate every memoized ItemBox on unrelated re-renders; only changes when
  // the layout, tolerance — or a pending rotation preview — actually changes.
  const beginDrag = useCallback((index: number, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setSelected(index);
    const src = preview?.index === index ? preview.candidate : placements[index]!;
    const [cx, , cz] = threeCenter(src, f);
    grab.current = { index, dx: cx - e.point.x, dz: cz - e.point.z };
    lastCell.current = null; // fresh grab — force the first move to compute
    const initial: Ghost = {
      index,
      candidate: src,
      valid: true,
      restingLabel: describeSupport(src, placements, index, toleranceM),
    };
    liveGhostRef.current = initial;
    setGhost(initial);
  }, [placements, preview, f, toleranceM]);

  // The heavy part of a drag frame — runs at most once per animation frame (see updateDrag).
  const computeDrag = () => {
    dragRaf.current = null;
    const g = grab.current;
    const pt = pendingPoint.current;
    if (g === null || pt === null) return;
    const moving = shownAt(g.index);
    const others = placements.filter((_, i) => i !== g.index);

    const worldX = pt.px + g.dx;
    const worldZ = pt.pz + g.dz;
    // Fine snap (config knob) so the box tracks the cursor smoothly instead of jumping a
    // whole metre; clamp to the RAW interior bound (rounding it caused a jump at the wall).
    let { x, y } = worldToVanXY(worldX, worldZ, moving.size, f, SCENE_CONFIG.dragSnapStepM);
    x = clamp(x, 0, interior.l - moving.size.x);
    y = clamp(y, 0, interior.w - moving.size.y);
    // Settle onto whatever is under the footprint, snapping x/y so the box rests
    // fully on its support — otherwise hand-positioned stacks never align and the
    // support check rejects them.
    const drop = resolveDrop(x, y, moving.size, others);
    const {z} = drop;

    // Skip the whole recompute when the box settled in the exact same cell as last
    // frame — the ghost (position + verdict) is already correct, so there's nothing
    // to redo. This is what keeps a slow/steady drag from re-running the O(n²)
    // arrangement walk 60×/sec over the same spot.
    const cell = `${g.index}:${drop.x}:${drop.y}:${drop.z}:${moving.size.x}:${moving.size.y}`;
    if (cell === lastCell.current) return;
    lastCell.current = cell;

    const candidate: Placement = { ...moving, position: drop };
    // Policy: a non-stackable item may only rest on the floor.
    let verdict = validatePlacement(
      {
        position: candidate.position,
        size: candidate.size,
        weightKg: candidate.weightKg,
        fragile: candidate.fragile,
      },
      { others, interior, toleranceM, maxReachHeightM },
    );
    if (verdict.ok && z > 0 && !moving.stackable) {
      verdict = { ok: false, reason: "this item cannot be stacked" };
    }
    // The per-box check above only proves the MOVED box is fine where it lands. It
    // can't see the two ways a drop breaks the REST of the layout: dropping onto a
    // stack can crush a box below, and dragging a base out can orphan whatever sat
    // on it. endDrag re-checks the whole arrangement and refuses those — so unless
    // we mirror that here, the ghost paints green on a drop the commit will reject
    // and silently snap back. Run the same whole-layout gate so green is honest.
    // The whole-layout re-check only ever DOWNGRADES a green ghost, and the only
    // thing it can catch that the per-box check above doesn't is a box orphaned by
    // moving THIS one out — which is impossible unless something sits off the floor.
    // When the rest of the load is single-layer, skip the O(n²) walk entirely (it
    // would always return ok anyway): a big per-frame saving with zero behaviour
    // change. endDrag still runs the full arrangement gate before committing.
    const anyStacked = placements.some((p, i) => i !== g.index && p.position.z > FLOOR_EPS_M);
    if (verdict.ok && anyStacked) {
      // Exclude OTHER already-flagged boxes from the whole-layout gate: a flagged box is a
      // known-bad manual override, so it must not taint a fresh, otherwise-valid move (else
      // one override paints every later drag red). The moved box is always kept.
      const nextLayout = placements
        .map((p, i) => (i === g.index ? candidate : p))
        .filter((p, i) => i === g.index || !p.flagged);
      const arrangement = validateArrangement(nextLayout, interior, toleranceM, maxReachHeightM);
      if (!arrangement.ok) verdict = { ok: false, reason: arrangement.reason };
    }
    // Full `placements` (not the filtered `others`) so badge numbers in the label
    // line up with what's actually painted on each box — filtering shifts indices.
    const restingLabel = describeSupport(candidate, placements, g.index, toleranceM);
    const next: Ghost = { index: g.index, candidate, valid: verdict.ok, reason: verdict.reason, restingLabel };
    // Position always updates (read by GhostBox's useFrame off this ref) but the
    // React state below only commits when something a re-render would actually
    // need to reflect (color, tooltip text, resting label) has changed — that's
    // what keeps dragging smooth at 100+ pointer events/sec.
    liveGhostRef.current = next;
    setGhost((prev) =>
      prev && prev.index === next.index && prev.valid === next.valid &&
      prev.reason === next.reason && prev.restingLabel === next.restingLabel
        ? prev
        : next,
    );
  };

  const updateDrag = (e: ThreeEvent<PointerEvent>) => {
    if (grab.current === null) return;
    e.stopPropagation();
    // Read the pooled event's coords NOW (it's reused after this handler returns), then
    // defer the recompute+re-render to the next frame, coalescing a burst of moves into one.
    pendingPoint.current = { px: e.point.x, pz: e.point.z };
    if (dragRaf.current === null) dragRaf.current = requestAnimationFrame(computeDrag);
  };

  // Never leave a scheduled frame dangling if the component unmounts mid-drag.
  useEffect(() => () => { if (dragRaf.current !== null) cancelAnimationFrame(dragRaf.current); }, []);

  const endDrag = (e: ThreeEvent<PointerEvent>) => {
    const g = grab.current;
    grab.current = null;
    pendingPoint.current = null;
    lastCell.current = null;
    if (dragRaf.current !== null) { cancelAnimationFrame(dragRaf.current); dragRaf.current = null; }
    // Commit from liveGhostRef, not the `ghost` state — state can lag one or more
    // frames behind on position (see the bail check in computeDrag), so committing
    // from it could drop the box a few mm short of where the pointer actually let go.
    const finalGhost = liveGhostRef.current;
    liveGhostRef.current = null;
    if (g === null || finalGhost === null) { setGhost(null); return; }
    e.stopPropagation();
    // MANUAL OVERRIDE: the move commits either way — never silently snapped back — so the
    // operator can keep arranging. reconcileFlags re-checks the WHOLE layout and marks each
    // box honestly: the moved box is flagged (amber) if it landed somewhere invalid, AND
    // anything it orphaned (e.g. a base pulled from under a stack) is flagged too; a box
    // now back in a valid spot is cleared. The "never guess" amber always reflects reality.
    const moved = placements.map((p, i) => (i === g.index ? finalGhost.candidate : p));
    const next = reconcileFlags(moved, interior, toleranceM, maxReachHeightM);
    const movedFlag = next[g.index];
    setEditErr(
      movedFlag?.flagged
        ? `Placed outside safe limits (${movedFlag.flagReason}) — shown amber; drag it to a valid spot to clear.`
        : null,
    );
    onPlacementsChange?.(next);
    setGhost(null);
  };

  // Spin the selected item a quarter-turn on the floor (swap its length/width
  // footprint, height unchanged so it stays upright — safe for every orientation
  // lock). The spin ALWAYS applies visually: if the rotated footprint fits where
  // the item sits, it commits immediately; if it doesn't, the spun box is PARKED
  // as an invalid preview (red) in place, so the operator can grab it and drag it
  // to a spot where it fits — rather than the old behaviour of refusing the spin
  // and leaving the box unturned. Either way it re-validates through the SAME gate
  // as a drag (overlap / support / crush / reach), so nothing invalid ever commits.
  // One re-orientation primitive shared by the spin + both flips. `makeSize` maps the
  // box's currently-SEEN size to its new edge lengths; `allowed` gates it against the
  // item's orientation lock; `lockMsg` explains a refusal. The spin/flips differ only
  // in those three arguments — everything else (drop-settle, whole-layout re-validate,
  // commit-or-park-as-invalid-preview) is identical to a drag commit, so nothing invalid
  // can ever be committed and a move that doesn't fit here is parked (red) to be dragged.
  const reorient = (makeSize: (s: Vec3) => Vec3, allowed: (lock: Placement["orientationLock"]) => boolean, lockMsg: string) => {
    if (selected === null) return;
    // Work from what the operator SEES (committed placement, or a parked preview if they've
    // already turned it once) so repeated clicks keep turning the same box, not snapping back.
    const p = shownAt(selected);
    if (!allowed(p.orientationLock)) {
      setEditErr(lockMsg);
      return;
    }
    const size = makeSize(p.size);
    const others = placements.filter((_, i) => i !== selected);
    const x = clamp(p.position.x, 0, interior.l - size.x);
    const y = clamp(p.position.y, 0, interior.w - size.y);
    const drop = resolveDrop(x, y, size, others);
    // rotationIndex was the packer's permutation id; a hand-turn no longer maps to one.
    const turned: Placement = { ...p, size, position: drop, rotationIndex: undefined };
    const next = placements.map((q, i) => (i === selected ? turned : q));
    const arrangement = validateArrangement(next, interior, toleranceM, maxReachHeightM);
    if (!arrangement.ok) {
      setPreview({ index: selected, candidate: turned });
      setEditErr(arrangement.reason ?? "won't fit turned — drag it to a spot where it fits");
      return;
    }
    setEditErr(null);
    onPlacementsChange?.(next);
  };

  // Spin flat: swap length⇄width, height unchanged → stays upright. Allowed for partial/none.
  const rotateSelected = () =>
    reorient((s) => ({ x: s.y, y: s.x, z: s.z }), canSpin, "locked upright — set Orientation to “Any way” in the table to spin");
  // Flip end-over-end (tip forward/back): swap width⇄height. Changes the vertical face, so
  // only a fully-free ("none") lock permits it — never silently loosen a fixed/partial lock.
  const flipForward = () =>
    reorient((s) => ({ x: s.x, y: s.z, z: s.y }), canFlip, "can’t flip — set Orientation to “Any way” in the table");
  // Flip onto its side (tip left/right): swap length⇄height. Same "none"-only rule.
  const flipSide = () =>
    reorient((s) => ({ x: s.z, y: s.y, z: s.x }), canFlip, "can’t flip — set Orientation to “Any way” in the table");

  return (
    <>
      <CameraCapture cameraRef={cameraRef} />
      <ViewControls apiRef={viewApiRef} initialPos={initialPos} />
      <ambientLight intensity={SCENE_CONFIG.ambientLightIntensity} />
      <directionalLight position={SCENE_CONFIG.directionalLight.position} intensity={SCENE_CONFIG.directionalLight.intensity} />
      <VanWireframe interior={interior} theme={theme} />
      <WallLabels interior={interior} theme={theme} />

      {placements.map((p, i) =>
        dragging && ghost!.index === i ? null : (
          <ItemBox
            key={i}
            // Show the parked rotation preview (spun footprint) for this box when
            // one is pending; otherwise its committed placement. Kept an ItemBox
            // (not a GhostBox) so it stays grabbable — the operator drags THIS box
            // to settle the rotation.
            placement={shownAt(i)}
            frame={f}
            theme={theme}
            index={i}
            name={itemNames?.[i]}
            groupColor={groupColors?.[i]}
            selected={selected === i}
            editable={editable}
            dense={dense}
            // Parked-but-doesn't-fit-here: tint red so it reads as unsettled.
            previewInvalid={preview?.index === i}
            overloaded={loads[i]?.overloaded ?? false}
            loadRatio={loads[i]?.ratio ?? 0}
            onPointerDownBox={beginDrag}
          />
        ),
      )}

      {ghost && <GhostBox ghost={ghost} liveRef={liveGhostRef} frame={f} theme={theme} />}
      {trayGhost && trayGhostLiveRef && <GhostBox ghost={trayGhost} liveRef={trayGhostLiveRef} frame={f} theme={theme} />}

      {editable && !dragging && selected !== null && placements[selected] && (
        <SelectedItemToolbar
          // Anchor above the box as SHOWN (rotated preview when pending) so the
          // Rotate button and its "won't fit — drag it" note ride over the spun box.
          placement={shownAt(selected)}
          frame={f}
          error={editErr}
          locked={!canSpin(shownAt(selected).orientationLock)}
          flipLocked={!canFlip(shownAt(selected).orientationLock)}
          onRotate={rotateSelected}
          onFlipForward={flipForward}
          onFlipSide={flipSide}
          vans={vans}
          vanKey={vanKey}
          onMoveToVan={onMoveToVan ? (toKey) => onMoveToVan(selected, toKey) : undefined}
          onUnplace={onUnplace ? () => { onUnplace(selected); setSelected(null); } : undefined}
        />
      )}

      {/* Invisible capture plane — only active mid-drag so it never blocks orbit. */}
      {dragging && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0, 0]}
          onPointerMove={updateDrag}
          onPointerUp={endDrag}
        >
          <planeGeometry args={[1000, 1000]} />
          <meshBasicMaterial visible={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      <gridHelper args={[mm(interior.l), SCENE_CONFIG.gridDivisions, theme.grid, theme.grid]} position={[0, -f.vanH / 2, 0]} />
      <OrbitControls
        enableDamping
        dampingFactor={0.1}
        enabled={!dragging}
        makeDefault
        onStart={() => viewApiRef.current?.cancel()}
      />
    </>
  );
}
