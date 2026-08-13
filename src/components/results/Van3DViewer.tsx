"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";
import type { PackedItem, Placement, UnplacedItem, Vec3, VanDimensions } from "@/types/api";
import { resolveDrop, validatePlacement, firstFitStacked, reconcileFlags } from "@/lib/packing/placement-validator";
import { allOrientations, permittedOrientationIndices } from "@/lib/packing/orientation";
import { color, spacing } from "@/styles/tokens";
import { frameFor, worldToVanXY, clamp, mm } from "@/lib/packing/van-scene-geometry";
import { rearrangeVan } from "@/lib/packing/rearrange";
import type { Item, PackingCategory, Van as PackerVan } from "@/lib/packing/packing.types";
import { readTheme } from "./van-3d/theme";
import { describeSupport, type Ghost } from "./van-3d/GhostBox";
import { Scene } from "./van-3d/Scene";
import type { ViewApi } from "./van-3d/CameraControls";
import { ScreenshotHelper } from "./van-3d/ScreenshotHelper";
import { UnplacedTray } from "./van-3d/UnplacedTray";
import { Legend } from "./van-3d/SceneDecorations";
import { ToolButton } from "./van-3d/Toolbar";
import { toolBtn, dropErrorBanner, flaggedBanner } from "./van-3d/styles";
import van3dSceneConfig from "../../../config/van-3d-scene.json";

/** Only the knobs this orchestrator itself needs (Canvas fov/dpr, and the drag-snap step
 *  for the tray-drop path) — the rest of config/van-3d-scene.json (lighting, grid) is read
 *  where it's used, in Scene.tsx. */
const SCENE_CONFIG = van3dSceneConfig as unknown as { cameraFovDeg: number; dprRange: [number, number]; dragSnapStepM: number };

/**
 * Flattest orientation this item's rotation policy permits (smallest z), ties
 * favouring the lowest/natural rotation index. Used as the default orientation
 * when a previously-unplaced item is dropped back in by hand — a flat
 * orientation is the one most likely to clear whatever headroom remains, so a
 * manual re-drop still "tries the rotation" the auto-packer would have, instead
 * of always offering the item's natural (possibly tallest) orientation again.
 */
function flattestOrientation(
  d: { l: number; w: number; h: number },
  lock: Placement["orientationLock"],
): { size: Vec3; rotationIndex: number } {
  const perms = allOrientations(d.l, d.w, d.h);
  let bestIndex = 0;
  for (const i of permittedOrientationIndices(lock ?? "fixed")) {
    if (perms[i]![2] < perms[bestIndex]![2]) bestIndex = i;
  }
  const [x, y, z] = perms[bestIndex]!;
  return { size: { x, y, z }, rotationIndex: bestIndex };
}

/**
 * The packer needs an `Item`; the viewer holds `PackedItem`. The ONLY field PackedItem
 * lacks is `category`, and the packer never reads it (category drives config-time
 * stackability, already baked into stackable/canSupportWeightKg/maxStackPressureKpa on
 * the item), so a neutral default is safe. `quantity` is the count to pack NOW (the
 * remaining-unplaced count), not the item's original order quantity.
 */
const DEFAULT_PACK_CATEGORY: PackingCategory = "accessory";
export function packedItemToItem(pi: PackedItem, quantity: number): Item {
  return {
    id: pi.id,
    name: pi.name,
    dimensions: pi.dimensions,
    weightKg: pi.weightKg,
    quantity,
    // PackedItem.fragility carries an extra "uncertain" the packer's type doesn't; the
    // packer only ever tests `=== "fragile"`, so everything else folds to "standard" —
    // the same rule handleDrop uses when it sets a placement's `fragile` flag.
    fragility: pi.fragility === "fragile" ? "fragile" : "standard",
    category: DEFAULT_PACK_CATEGORY,
    stackable: pi.stackable,
    canSupportWeightKg: pi.canSupportWeightKg,
    orientationLock: pi.orientationLock,
    maxStackPressureKpa: pi.maxStackPressureKpa,
    material: pi.material,
    durabilityTier: pi.durabilityTier,
    durabilityConfident: pi.durabilityConfident,
    brittle: pi.brittle,
    deformable: pi.deformable,
    // Multi-drop: without the stop tag a client-side re-pack would drop every item into one band
    // and destroy the door-first drop order the server packed. Carry it.
    stopIndex: pi.stopIndex,
  };
}

/** A Placement built from a tray item — one shared constructor for every way an
 *  unplaced item can enter the scene (drop at cursor, drop fallback, click-to-place),
 *  so the field mapping can never drift between paths. */
function placementFor(
  item: PackedItem,
  size: Vec3,
  rotationIndex: number | undefined,
  position: { x: number; y: number; z: number },
): Placement {
  return {
    itemId: item.id,
    position,
    size,
    fragile: item.fragility === "fragile",
    weightKg: item.weightKg,
    canSupportWeightKg: item.canSupportWeightKg,
    stackable: item.stackable,
    maxStackPressureKpa: item.maxStackPressureKpa,
    brittle: item.brittle,
    orientationLock: item.orientationLock,
    rotationIndex,
  };
}

/** Trust-boundary guard shared by every tray-entry path: reject an item whose
 *  dimensions are missing, non-finite, or non-positive before it can enter the
 *  placement model (a zero/negative box slips past the floor-level gate and
 *  commits an invisible/degenerate placement). */
function hasValidDimensions(item: PackedItem): item is PackedItem & { dimensions: NonNullable<PackedItem["dimensions"]> } {
  const d = item.dimensions;
  return d != null && [d.l, d.w, d.h].every((n) => Number.isFinite(n) && n > 0);
}

/* ── Public component ───────────────────────────────────────────────────── */

export interface Van3DViewerProps {
  placements: Placement[];
  interior: VanDimensions;
  /** Per-placement item names (index-aligned with `placements`) for tooltips. */
  itemNames?: string[];
  /** Per-placement fill colour (index-aligned with `placements`) — e.g. the owning company in
   *  the shared-truck stack. Omit for the normal standard/fragile colouring. Safety tints
   *  (overloaded / invalid) always override it. */
  groupColors?: string[];
  heightPx?: number;
  /** r3f render loop. "always" (default) renders 60fps continuously — right for the main editable
   *  viewer. "demand" only renders when something changes (orbit, snap, prop change) — use it for
   *  grids of small read-only cards so N idle canvases don't all burn frames at once and make the
   *  live one janky. Camera-snap animations self-schedule under demand (see CameraControls). */
  frameloop?: "always" | "demand";
  /** Declutter a small preview card in a grid: hide the rotate/top/reset/export toolbar (drag still
   *  orbits) down to a single Maximise button, and drop the per-card colour legend — the card's own
   *  swatch + label already names it. Maximising restores the full toolbar + legend for detail.
   *  The flagged-placement warning is unaffected (it lives in the canvas block, always shown). */
  compact?: boolean;
  /** Enable click-to-select + constraint-checked drag refinement. */
  editable?: boolean;
  /** Called with the updated placements after a valid drag commits. */
  onPlacementsChange?: (next: Placement[]) => void;
  /** True when the plan differs from the packer's computed layout (drives Reset). */
  isModified?: boolean;
  /** Restore the WHOLE fleet to the packer's computed layout (fleet-wide, so a
   *  cross-van move can't leave an item duplicated). */
  onResetLayout?: () => void;
  /** Item lookup map — enables dropping unplaced items from the sidebar into this viewer. */
  itemById?: Map<string, PackedItem>;
  /** Every van in the working fleet, for the "move van" menu. Omit, or pass 0-1
   *  entries, to disable the menu. */
  vans?: { key: string; label: string }[];
  /** This van's key within `vans` — excluded from the "move van" menu. */
  vanKey?: string;
  /** Move the item at `itemIndex` in THIS van into the van keyed `toKey`. */
  onMoveToVan?: (itemIndex: number, toKey: string) => void;
  /** Remove the item at `itemIndex` in THIS van, returning it to Unplaced. */
  onUnplace?: (itemIndex: number) => void;
  /**
   * Clearance slack (m) the interactive editor validates with — must be the SAME
   * value the packer used (config `PACKING_TOLERANCE_M`), threaded from the pack
   * response so a config change can't desync the editor from the packer. Defaults
   * to the config default only when a caller has none to pass.
   */
  toleranceM?: number;
  /**
   * Highest a worker may place an item's base by hand (m) the interactive editor
   * validates with — must be the SAME value the packer used (config
   * `PACKING_MAX_REACH_HEIGHT_M`), threaded from the pack response. Undefined ⇒ no
   * limit — the caller (e.g. the "ignore reach limit" toggle) is responsible for
   * resolving its own default; this component never silently re-applies one.
   */
  maxReachHeightM?: number;
  /**
   * This vehicle's real payload ceiling (kg), used by Rearrange so a re-pack can't produce an
   * ILLEGALLY overweight van — anything over the limit is refused into Unplaced with a reason.
   * Optional: hosts that render a generic container rather than a real vehicle (the groupage
   * pallet builder, the truck-stack planner) pass nothing and keep the space-only behaviour.
   */
  maxPayloadKg?: number;
  /** Cargo no van could carry, shown in a small collapsible tray for manual placement. */
  unplaced?: UnplacedItem[];
  reasonFor?: (id: string) => string;
  unplacedCollapsed?: boolean;
  onToggleUnplacedCollapsed?: () => void;
}

export function Van3DViewer({
  placements,
  interior,
  itemNames,
  groupColors,
  heightPx = 480,
  frameloop = "always",
  compact = false,
  editable = false,
  onPlacementsChange,
  isModified = false,
  onResetLayout,
  itemById,
  toleranceM = 0.005,
  maxReachHeightM,
  maxPayloadKg,
  vans = [],
  vanKey = "",
  onMoveToVan,
  onUnplace,
  unplaced = [],
  reasonFor,
  unplacedCollapsed = true,
  onToggleUnplacedCollapsed,
}: Van3DViewerProps) {
  const captureRef = useRef<(() => void) | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const canvasDivRef = useRef<HTMLDivElement>(null);
  const viewApiRef = useRef<ViewApi | null>(null);
  const clearSelRef = useRef<(() => void) | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useMemo(readTheme, []);
  const [maximized, setMaximized] = useState(false);
  // Why a drag-from-tray drop landed nowhere. Without this the item silently
  // vanished when it couldn't fit — a "never guess" surface must say why.
  const [dropError, setDropError] = useState<string | null>(null);

  const diag = Math.sqrt(mm(interior.l) ** 2 + mm(interior.w) ** 2 + mm(interior.h) ** 2);
  const camZ = diag * 1.5;
  // Camera sits behind the REAR doors (-x) looking toward the cab — the loader's
  // natural view. Shared by the initial mount and the "Reset view" button.
  const initialPos = useMemo<[number, number, number]>(() => [-camZ * 0.6, camZ * 0.5, camZ], [camZ]);

  // Full-screen mode: lock page scroll, move focus into the dialog, trap Tab so it
  // can't reach the now-covered controls behind, close on Escape, and restore focus
  // to the trigger on exit. (The Canvas is NOT remounted — see the return below —
  // so selection and camera survive the toggle.)
  useEffect(() => {
    if (!maximized) return;
    const root = rootRef.current;
    const restoreFocusTo = document.activeElement as HTMLElement | null;
    root?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setMaximized(false); return; }
      if (e.key !== "Tab" || !root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) { e.preventDefault(); return; }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreFocusTo?.focus?.();
    };
  }, [maximized]);

  // The item currently being dragged from the tray. A ref (not dataTransfer)
  // because browsers hide dataTransfer contents during dragover — the tray tells
  // us at dragstart what's in flight so the ghost can be computed mid-drag.
  const trayDragItemRef = useRef<PackedItem | null>(null);
  // Ghost preview for a tray drag — same two-tier shape as Scene's in-scene drag
  // ghost: the ref updates on every dragover (read imperatively by GhostBox's
  // useFrame for smooth motion), state only commits when validity/reason/support
  // flips, so dragging never re-renders the Scene per pointer sample.
  const trayGhostLiveRef = useRef<Ghost | null>(null);
  const [trayGhost, setTrayGhost] = useState<Ghost | null>(null);
  const clearTrayGhost = useCallback(() => {
    trayGhostLiveRef.current = null;
    setTrayGhost((prev) => (prev === null ? prev : null));
  }, []);

  /**
   * Where a tray item would land if released at (clientX, clientY), and whether
   * that landing is valid — ONE computation shared by the dragover ghost and the
   * actual drop, so the preview can never disagree with what a drop commits.
   * Same settle-then-validate steps as an in-scene drag: raycast the floor plane,
   * settle onto whatever is under the footprint (resolveDrop), then run the same
   * placement gate the packer used. Flattest permitted orientation, not the
   * natural one: an item coming back from Unplaced already failed to fit its
   * natural way up, so default to the orientation most likely to clear the
   * remaining headroom — the operator can still spin it after placing.
   */
  const trayCandidateAt = (
    item: PackedItem & { dimensions: NonNullable<PackedItem["dimensions"]> },
    clientX: number,
    clientY: number,
  ): { placement: Placement; ok: boolean; reason?: string } | null => {
    const cam = cameraRef.current;
    const div = canvasDivRef.current;
    if (!cam || !div) return null;

    const rect = div.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const f = frameFor(interior);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);

    // Floor plane: y = -vanH/2 → THREE.Plane normal=(0,1,0), constant=vanH/2
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), f.vanH / 2);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(floorPlane, hit)) return null;

    const { size, rotationIndex } = flattestOrientation(item.dimensions, item.orientationLock);

    let { x, y } = worldToVanXY(hit.x, hit.z, size, f, SCENE_CONFIG.dragSnapStepM);
    x = clamp(x, 0, interior.l - size.x);
    y = clamp(y, 0, interior.w - size.y);

    const drop = resolveDrop(x, y, size, placements);
    const placement = placementFor(item, size, rotationIndex, drop);
    let verdict = validatePlacement(
      { position: placement.position, size, weightKg: item.weightKg, fragile: placement.fragile },
      { others: placements, interior, toleranceM, maxReachHeightM },
    );
    // Same policy the in-scene drag enforces: a non-stackable item may only rest
    // on the floor — without this the tray path could commit what a drag refuses.
    if (verdict.ok && drop.z > 0 && !item.stackable) {
      verdict = { ok: false, reason: "this item cannot be stacked" };
    }
    return { placement, ok: verdict.ok, reason: verdict.ok ? undefined : verdict.reason };
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!itemById) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    // Live green/red preview of where the dragged tray item would land — before
    // this the first feedback the operator got was AFTER letting go.
    const item = trayDragItemRef.current;
    if (!item || !hasValidDimensions(item)) return;
    const c = trayCandidateAt(item, e.clientX, e.clientY);
    if (!c) return;
    const next: Ghost = {
      index: placements.length, // badge shows the number the item will get
      candidate: c.placement,
      valid: c.ok,
      reason: c.reason,
      restingLabel: describeSupport(c.placement, placements, -1, toleranceM),
    };
    trayGhostLiveRef.current = next;
    // Position rides the ref (read per-frame by GhostBox); re-render only when
    // something a render must reflect (colour/tooltip/support text) changes.
    setTrayGhost((prev) =>
      prev && prev.valid === next.valid && prev.reason === next.reason && prev.restingLabel === next.restingLabel
        ? prev
        : next,
    );
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // dragleave also fires when crossing INTO a child of the canvas div — only
    // clear the ghost when the pointer genuinely left the canvas.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    clearTrayGhost();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    clearTrayGhost();
    if (!itemById) return;
    const raw = e.dataTransfer.getData("application/van-item");
    if (!raw) return;

    let item: PackedItem;
    try { item = JSON.parse(raw); } catch { return; }
    if (!hasValidDimensions(item)) return;

    const c = trayCandidateAt(item, e.clientX, e.clientY);
    if (!c) return;

    // Commit where the cursor settled — INCLUDING on top of another box (resolveDrop already
    // stacked it there). "Drop it here" always means here. MANUAL OVERRIDE: if that spot is
    // invalid (occupied, unsupported, too tall, can't-stack…) the box still commits, but
    // flagged (amber) rather than relocating to the floor — so an item aimed at a box lands
    // on the box, not the deck. reconcileFlags marks the new box (and anything it affects)
    // honestly; the flagged banner surfaces it and the pallet quote is gated until it clears.
    setDropError(null);
    onPlacementsChange?.(reconcileFlags([...placements, c.placement], interior, toleranceM, maxReachHeightM));
  };

  /**
   * Click-to-place from the tray — no dragging needed. Each unit fills the floor
   * first, then stacks on top of what's already loaded once the deck is full
   * (firstFitStacked — the same gate the drop fallback and auto-packer use), so a
   * truck of stackable pallets builds a second tier instead of spreading one flat
   * layer across extra vehicles. Deterministic and always valid; items already in
   * the van are never disturbed. Places as many of `qty` as fit, says plainly when
   * some don't. (Auto-stack still exists for a full re-pack that can also re-orient.)
   */
  const placeUnits = (item: PackedItem, qty: number) => {
    if (!onPlacementsChange || !hasValidDimensions(item)) return;
    const { size, rotationIndex } = flattestOrientation(item.dimensions, item.orientationLock);
    const fragile = item.fragility === "fragile";
    const next = [...placements];
    let placed = 0;
    for (let i = 0; i < qty; i++) {
      const spot = firstFitStacked(size, interior, next, toleranceM, item.weightKg, fragile, maxReachHeightM);
      if (!spot) break;
      next.push(placementFor(item, size, rotationIndex, spot));
      placed++;
    }
    if (placed > 0) onPlacementsChange(next);
    if (placed === qty) setDropError(null);
    else if (placed === 0) setDropError(`${item.name} won't fit — this van is full (floor and stacked). Free up space or move it to another van.`);
    else setDropError(`Placed ${placed} of ${qty} — this van is full (floor and stacked) for the rest. Free up space or move the rest to another van.`);
  };

  // How many unplaced units can actually be re-seated by the packer (a size is required).
  const stackableUnits = itemById
    ? unplaced.reduce((n, u) => n + (itemById.get(u.id)?.dimensions != null ? u.quantity : 0), 0)
    : 0;
  // Rearrange is offered whenever there is anything TO rearrange — a loaded van, leftovers, or both.
  // (It used to require leftovers, which meant an operator who had merely dragged boxes around into
  // a mess had no way to ask for a tidy-up.)
  const canRearrange =
    editable && !!onPlacementsChange && !!itemById && (placements.length > 0 || stackableUnits > 0);

  /**
   * Re-optimise this container: re-pack everything already in it PLUS any draggable leftovers, then
   * REPLACE the layout. The packer can't pack into pre-occupied space, so re-packing the whole set
   * is exactly what makes a one-click tidy-up safe — the new layout replaces all of the old one, so
   * it can't overlap it. It reuses the packer the server ran (pure, deterministic), and every limit
   * — orientation lock, crush pressure, fragility, reach height, drop order, payload — is honoured
   * because they all live in the shared validator. The operator can still drag to refine, or Reset.
   */
  const rearrange = () => {
    if (!itemById || !onPlacementsChange) return;
    const wanted = new Map<string, number>();
    for (const p of placements) wanted.set(p.itemId, (wanted.get(p.itemId) ?? 0) + 1);
    for (const u of unplaced) {
      if (itemById.get(u.id)?.dimensions == null) continue;
      wanted.set(u.id, (wanted.get(u.id) ?? 0) + u.quantity);
    }
    const items: Item[] = [];
    for (const [id, qty] of wanted) {
      const pi = itemById.get(id);
      if (pi && pi.dimensions != null && qty > 0) items.push(packedItemToItem(pi, qty));
    }
    if (items.length === 0) return;
    const container: PackerVan = {
      id: "container",
      label: "Container",
      interior,
      // The REAL vehicle's ceiling when the host knows it, so a re-pack can't quote an overweight
      // van. Hosts rendering a generic container (no vehicle behind it) pass none — for them weight
      // is not a constraint we can honestly enforce, so it stays unbounded, as before.
      maxPayloadKg: maxPayloadKg ?? Number.POSITIVE_INFINITY,
      perMileRate: 0,
    };
    const result = rearrangeVan(items, container, { toleranceM, maxReachHeightM });
    onPlacementsChange(result.placements);
    // Anything the re-pack refused is named, never dropped quietly — including the over-payload case,
    // which is the one an operator most needs to see (it makes the van illegal, not just untidy).
    const stillOut = result.unplaced.reduce((n, it) => n + it.quantity, 0);
    const why = result.unplaced.length > 0 ? result.reasons[result.unplaced[0]!.id] : undefined;
    setDropError(
      stillOut > 0
        ? `Rearranged what fits — ${stillOut} unit${stillOut === 1 ? "" : "s"} wouldn’t go back in${why ? ` (${why})` : ""} and stay unplaced.`
        : null,
    );
  };

  const toolbar = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, marginBottom: 8, flexWrap: "wrap" }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <ToolButton onClick={() => viewApiRef.current?.rotate(Math.PI / 2)} title="Turn the view a quarter-turn left">⟲ 90°</ToolButton>
        <ToolButton onClick={() => viewApiRef.current?.rotate(-Math.PI / 2)} title="Turn the view a quarter-turn right">90° ⟳</ToolButton>
        <ToolButton onClick={() => viewApiRef.current?.top()} title="Look straight down from above">Top</ToolButton>
        <ToolButton onClick={() => viewApiRef.current?.reset()} title="Back to the default loading angle">Reset view</ToolButton>
        {canRearrange && (
          <button
            type="button"
            onClick={rearrange}
            title={
              stackableUnits > 0
                ? `Re-optimise this load and stack the ${stackableUnits} leftover unit${stackableUnits === 1 ? "" : "s"} in. Keeps every limit — orientation locks, stacking/crush limits, reach height, drop order and the vehicle's weight limit. Reset layout still undoes it.`
                : "Re-optimise this load: pack what's in here as tightly as the rules allow. Keeps every limit — orientation locks, stacking/crush limits, reach height, drop order and the vehicle's weight limit. Reset layout still undoes it."
            }
            style={{ ...toolBtn, borderColor: color.accent, color: color.accent }}
          >
            {stackableUnits > 0 ? `⤓ Rearrange & fill (${stackableUnits})` : "⇄ Rearrange"}
          </button>
        )}
        {editable && isModified && onResetLayout && (
          <button
            type="button"
            onClick={onResetLayout}
            title="Undo all manual edits and restore the computer-calculated layout for every van"
            style={{ ...toolBtn, borderColor: color.accent, color: color.accent }}
          >
            ↺ Reset layout
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <ToolButton onClick={() => setMaximized((m) => !m)} title={maximized ? "Exit full screen (Esc)" : "Fill the screen for detailed editing"}>
          {maximized ? "⤡ Close" : "⤢ Maximise"}
        </ToolButton>
        <ToolButton onClick={() => captureRef.current?.()} title="Download a PNG snapshot of this view">Export PNG</ToolButton>
      </div>
    </div>
  );

  // Slim toolbar for a compact preview card: just Maximise (drag orbits; full toolbar returns
  // full-screen). Keeps a grid of cards clean instead of repeating 6 buttons under each one.
  const compactToolbar = (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
      <ToolButton onClick={() => setMaximized((m) => !m)} title="Fill the screen to rotate, inspect and edit this stack">
        ⤢ Maximise
      </ToolButton>
    </div>
  );

  // Hand-overridden (invalid) placements the operator forced. A "never guess" surface:
  // always shown, and it gates the pallet quote (GroupagePalletBuilder) until cleared.
  const flaggedCount = placements.reduce((n, p) => n + (p.flagged ? 1 : 0), 0);

  const canvasBlock = (
    <div
      ref={canvasDivRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: "relative",
        width: "100%",
        height: maximized ? "100%" : heightPx,
        flex: maximized ? 1 : undefined,
        minHeight: 0,
        borderRadius: maximized ? 0 : 8,
        overflow: "hidden",
        background: color.surfaceSub,
        border: maximized ? "none" : `1px solid ${color.border}`,
      }}
    >
      <Canvas
        frameloop={frameloop}
        camera={{ position: initialPos, fov: SCENE_CONFIG.cameraFovDeg }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        // Cap the render resolution — hi-DPI screens otherwise render at 2–3× every
        // frame, stalling orbit. Fixed, not adaptive: dropping resolution mid-orbit
        // (via AdaptiveDpr) made the view visibly blur while spinning, so we accept
        // the fixed cost instead of a resolution dip during motion.
        dpr={SCENE_CONFIG.dprRange}
        onPointerMissed={() => clearSelRef.current?.()}
      >
        <ScreenshotHelper captureRef={captureRef} />
        <Scene
          placements={placements}
          interior={interior}
          itemNames={itemNames}
          groupColors={groupColors}
          theme={theme}
          editable={editable}
          onPlacementsChange={onPlacementsChange}
          cameraRef={cameraRef}
          viewApiRef={viewApiRef}
          initialPos={initialPos}
          clearSelRef={clearSelRef}
          toleranceM={toleranceM}
          vans={vans}
          vanKey={vanKey}
          onMoveToVan={onMoveToVan}
          onUnplace={onUnplace}
          maxReachHeightM={maxReachHeightM}
          trayGhost={trayGhost}
          trayGhostLiveRef={trayGhostLiveRef}
        />
      </Canvas>
      {unplaced.length > 0 && (
        <UnplacedTray
          unplaced={unplaced}
          itemById={itemById}
          reasonFor={reasonFor}
          collapsed={unplacedCollapsed}
          onToggleCollapsed={onToggleUnplacedCollapsed}
          onPlace={editable && onPlacementsChange && itemById ? placeUnits : undefined}
          onDragActive={(item) => {
            trayDragItemRef.current = item;
            if (item === null) clearTrayGhost();
          }}
        />
      )}
      {flaggedCount > 0 && (
        <div role="status" style={flaggedBanner}>
          ⚠ {flaggedCount} placement{flaggedCount === 1 ? "" : "s"} flagged — outside safe limits. Drag {flaggedCount === 1 ? "it" : "them"} to a valid spot to clear.
        </div>
      )}
      {dropError && (
        <div role="alert" style={dropErrorBanner} onPointerDown={() => setDropError(null)}>
          {dropError}
        </div>
      )}
    </div>
  );

  // ONE stable root div across both modes — only its styling changes — so toggling
  // full screen never remounts the Canvas (selection + camera survive). No ancestor
  // in this app establishes a containing block, so position:fixed fills the viewport.
  return (
    <div
      ref={rootRef}
      tabIndex={maximized ? -1 : undefined}
      role={maximized ? "dialog" : undefined}
      aria-modal={maximized ? true : undefined}
      aria-label={maximized ? "Load plan — full screen" : undefined}
      style={maximized
        ? { position: "fixed", inset: 0, zIndex: 1000, background: color.pageBg, padding: spacing.lg, display: "flex", flexDirection: "column", outline: "none" }
        : undefined}
    >
      {compact && !maximized ? compactToolbar : toolbar}
      {canvasBlock}
      {(!compact || maximized) && <Legend theme={theme} editable={editable} />}
    </div>
  );
}
