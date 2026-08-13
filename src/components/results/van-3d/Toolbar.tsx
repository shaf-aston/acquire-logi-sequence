"use client";

import { Html } from "@react-three/drei";
import type { Placement } from "@/types/api";
import { threeCenter, threeSize, type Frame } from "@/lib/packing/van-scene-geometry";
import { color, font } from "@/styles/tokens";
import { itemToolbar, itemToolBtn, itemToolBtnDisabled, itemToolSelect, toolBtn } from "./styles";

/* ── Toolbar button + selected-item control ─────────────────────────────── */

export function ToolButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} style={toolBtn}>
      {children}
    </button>
  );
}

/**
 * Floating controls anchored just outside the selected item. Compact icon buttons
 * (spin flat · flip forward/back · flip side · move van · unplace) with tooltips —
 * kept small on purpose so the palette doesn't cover the load it edits. The turn
 * buttons dim when the item's orientation lock forbids that move.
 */
export function SelectedItemToolbar({ placement, frame, error, locked, flipLocked, onRotate, onFlipForward, onFlipSide, vans, vanKey, onMoveToVan, onUnplace }: { placement: Placement; frame: Frame; error: string | null; locked: boolean; flipLocked: boolean; onRotate: () => void; onFlipForward: () => void; onFlipSide: () => void; vans: { key: string; label: string }[]; vanKey: string; onMoveToVan?: (toKey: string) => void; onUnplace?: () => void }) {
  const { sy } = threeSize(placement.size);
  const [cx, cy, cz] = threeCenter(placement, frame);
  // Anchor above the item, but flip below when it's near the van ceiling so the
  // control never renders off-screen / clipped by the canvas edge.
  const headroom = frame.vanH / 2 - (cy + sy / 2);
  const yOff = headroom > 0.34 ? sy / 2 + 0.28 : -(sy / 2 + 0.16);
  // A short, visible reason (not just a hover title) so touch/keyboard users see why a
  // turn is refused; kept terse so the palette stays small. aria-disabled (not native
  // `disabled`) keeps the icon focusable so its tooltip is Tab-reachable.
  // Terse on purpose: the full "how to unlock it" sentence lives on each button's hover title, so the
  // always-visible badge stays a state label and doesn't wrap into a block that covers the load.
  const reason = error ?? (locked ? "Locked upright" : null);
  // Other vans this item can be moved into (the current van is excluded).
  const otherVans = onMoveToVan && vans.length > 1
    ? vans.filter((v) => v.key !== vanKey)
    : [];
  return (
    <Html position={[cx, cy + yOff, cz]} center>
      <div style={itemToolbar} onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onRotate}
          aria-disabled={locked}
          aria-label="Spin flat (quarter-turn)"
          title={locked ? "Locked upright — set Orientation to “Any way” in the table" : "Spin flat — quarter-turn on the floor"}
          style={{ ...itemToolBtn, ...(locked ? itemToolBtnDisabled : null) }}
        >
          ⟳
        </button>
        <button
          type="button"
          onClick={onFlipForward}
          aria-disabled={flipLocked}
          aria-label="Flip forward or back"
          title={flipLocked ? "Can’t flip — set Orientation to “Any way” in the table" : "Flip end-over-end (forward/back)"}
          style={{ ...itemToolBtn, ...(flipLocked ? itemToolBtnDisabled : null) }}
        >
          ⇕
        </button>
        <button
          type="button"
          onClick={onFlipSide}
          aria-disabled={flipLocked}
          aria-label="Flip onto its side"
          title={flipLocked ? "Can’t flip — set Orientation to “Any way” in the table" : "Flip onto its side (left/right)"}
          style={{ ...itemToolBtn, ...(flipLocked ? itemToolBtnDisabled : null) }}
        >
          ⇔
        </button>
        {otherVans.length > 0 && (
          <select
            aria-label="Move this item to another van"
            title="Move this item into a different van"
            value=""
            onChange={(e) => {
              const toKey = e.target.value;
              if (toKey) onMoveToVan!(toKey);
              e.currentTarget.selectedIndex = 0; // reset so the same van can be picked again
            }}
            style={itemToolSelect}
          >
            <option value="" disabled>⇄</option>
            {otherVans.map((v) => (
              <option key={v.key} value={v.key}>{v.label}</option>
            ))}
          </select>
        )}
        {onUnplace && (
          <button
            type="button"
            onClick={onUnplace}
            aria-label="Unplace (return to Unplaced)"
            title="Remove this item from the van and return it to Unplaced"
            style={itemToolBtn}
          >
            ⤴
          </button>
        )}
        {reason && (
          <span
            title={locked && !error ? "Locked upright — set Orientation to “Any way” in the table" : reason}
            style={{ color: locked && !error ? color.muted : color.error, fontSize: font.xs, fontWeight: 500, maxWidth: 110, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.2 }}
          >
            {reason}
          </span>
        )}
      </div>
    </Html>
  );
}
