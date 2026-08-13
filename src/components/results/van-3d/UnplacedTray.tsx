"use client";

import type { PackedItem, UnplacedItem } from "@/types/api";
import { color, font } from "@/styles/tokens";
import { unplacedCollapseBtn, unplacedPanel, unplacedPlaceBtn, unplacedTabBtn } from "./styles";

/* ── Unplaced tray — small collapsible drawer over the canvas, top-left ────────
 * Lets the operator get cargo the packer couldn't fit back INTO this van by
 * hand: click a row's Place button, or drag the row onto the canvas. Collapsed
 * to a small tab by default so it never blocks the view; its open/closed state
 * and the underlying `unplaced` list both live one level up
 * (PackingResultPanel), so they survive this component remounting on every van
 * switch. */

export function UnplacedTray({
  unplaced,
  itemById,
  reasonFor,
  collapsed,
  onToggleCollapsed,
  onPlace,
  onDragActive,
}: {
  unplaced: UnplacedItem[];
  itemById?: Map<string, PackedItem>;
  reasonFor?: (id: string) => string;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  /** Place `qty` units of `item` at the first fitting spot — the no-drag path. */
  onPlace?: (item: PackedItem, qty: number) => void;
  /** Tells the viewer what's in flight during an HTML5 drag (null = drag ended),
   *  because dataTransfer is unreadable during dragover — this is how the live
   *  ghost preview knows which item to paint. */
  onDragActive?: (item: PackedItem | null) => void;
}) {
  if (collapsed) {
    return (
      <button type="button" onClick={onToggleCollapsed} title="Show unplaced cargo" style={unplacedTabBtn}>
        ▸ Unplaced ({unplaced.length})
      </button>
    );
  }
  return (
    <div style={unplacedPanel} onPointerDown={(e) => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: font.xs, fontWeight: 700, color: color.text }}>Unplaced ({unplaced.length})</span>
        <button type="button" onClick={onToggleCollapsed} title="Minimise" style={unplacedCollapseBtn}>◂</button>
      </div>
      <p style={{ fontSize: 10, color: color.muted, margin: "0 0 6px" }}>
        {onPlace ? "Click Place, or drag onto the van" : "Drag onto the van to place"}
      </p>
      <div style={{ overflowY: "auto", maxHeight: 180, display: "flex", flexDirection: "column", gap: 4 }}>
        {unplaced.map((item) => {
          const packedItem = itemById?.get(item.id);
          const canDrag = packedItem?.dimensions != null;
          const reason = reasonFor?.(item.id);
          // A "never guess" surface: WHY it's unplaced must be visible text, not
          // only a hover title — reach-limit specifically gets its own colour so
          // it reads as "fixable via the toggle", not "this van is just full".
          const isReachLimited = reason?.includes("reach limit") ?? false;
          return (
            <div
              key={item.id}
              draggable={canDrag}
              onDragStart={
                canDrag
                  ? (e) => {
                      e.dataTransfer.setData("application/van-item", JSON.stringify(packedItem));
                      e.dataTransfer.effectAllowed = "copy";
                      onDragActive?.(packedItem!);
                    }
                  : undefined
              }
              onDragEnd={canDrag ? () => onDragActive?.(null) : undefined}
              title={reason}
              style={{
                fontSize: font.xs,
                padding: "3px 6px",
                borderRadius: 4,
                background: isReachLimited ? color.fragile.bg : color.surfaceSub,
                border: `1px solid ${isReachLimited ? color.fragile.border : color.border}`,
                cursor: canDrag ? "grab" : "default",
                opacity: canDrag ? 1 : 0.55,
                color: color.text,
              }}
            >
              <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {item.name} ×{item.quantity}
              </div>
              {canDrag && onPlace && (
                <div style={{ display: "flex", gap: 4, marginTop: 3 }}>
                  <button
                    type="button"
                    style={unplacedPlaceBtn}
                    title="Put one of these into the van at the first free spot"
                    onClick={() => onPlace(packedItem!, 1)}
                  >
                    Place 1
                  </button>
                  {item.quantity > 1 && (
                    <button
                      type="button"
                      style={unplacedPlaceBtn}
                      title="Put all of these into the van, as many as fit"
                      onClick={() => onPlace(packedItem!, item.quantity)}
                    >
                      Place all {item.quantity}
                    </button>
                  )}
                </div>
              )}
              {reason && reason !== "unknown" && (
                <div
                  style={{
                    fontSize: 9,
                    color: isReachLimited ? color.fragile.fg : color.muted,
                    marginTop: 1,
                    whiteSpace: "normal",
                    lineHeight: 1.25,
                  }}
                >
                  {reason}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
