"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { color, font, radius } from "@/styles/tokens";

// Layout effects must run before paint (we measure/position cards), but useLayoutEffect warns
// during Next's server render of this client component — fall back to useEffect on the server.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * A vertical stack of cards the operator can drag to reorder — with a subtle "make room"
 * slide on the neighbours and a lift on the dragged card. Reorder-only (no add/remove); the
 * chosen order is remembered per `storageKey` so it survives a reload.
 *
 * Design notes (why it's built this way, not with a drag library):
 *  - Native Pointer Events + CSS transforms — no dependency, works for mouse AND touch.
 *  - Cards carry their own buttons/inputs, so dragging starts ONLY from a dedicated grip
 *    handle (top-left). Everything else in a card keeps behaving normally.
 *  - Items whose content renders nothing (a card that self-hides, e.g. no customer yet)
 *    collapse away — no empty shell, no stray handle, no gap.
 *  - Honours `prefers-reduced-motion`: reordering still works, the animation just doesn't play.
 *  - Keyboard-accessible: focus a handle, use ↑/↓ to move that card.
 *
 * Purely presentational — each child owns its own data/state; this only moves them.
 */

export interface SortableEntry {
  /** Stable id — the persisted order is a list of these. */
  readonly id: string;
  readonly node: ReactNode;
}

const EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)"; // gentle ease-out — the "subtle" settle
const DURATION_MS = 180;

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function move<T>(arr: readonly T[], from: number, to: number): T[] {
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function SortableStack({
  storageKey,
  items,
  gap = 16,
}: {
  /** localStorage key the chosen order is remembered under. */
  readonly storageKey: string;
  readonly items: readonly SortableEntry[];
  /** Vertical gap between cards, in px (must match the visual gap for the slide math). */
  readonly gap?: number;
}) {
  // The remembered order (ids). Absent-but-remembered ids are kept so a card that comes and goes
  // (e.g. the stats card) returns to its chosen slot rather than jumping to the end.
  const [order, setOrder] = useState<string[]>(() => items.map((i) => i.id));
  const [activeId, setActiveId] = useState<string | null>(null);

  const elMap = useRef(new Map<string, HTMLDivElement>());
  const lastRects = useRef(new Map<string, number>()); // id -> top (for the keyboard FLIP)
  const prevOrderKey = useRef<string | null>(null); // only FLIP when the ORDER changed, not on expand/collapse
  const clearAfterDrag = useRef(false); // set when a pointer drag committed a reorder — the layout
  //                                        effect then strips the drag's inline styles post-reorder

  // Hydrate the saved order after mount (client-only, so no SSR mismatch).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const saved: unknown = JSON.parse(raw);
        if (Array.isArray(saved) && saved.every((x) => typeof x === "string")) {
          setOrder((cur) => reconcile(saved as string[], cur));
        }
      }
    } catch {
      /* corrupt/blocked storage → keep the default order */
    }
  }, [storageKey]);

  // Fold in newly-appeared / removed ids without losing the remembered positions. Returns the
  // SAME reference when nothing changed so this doesn't loop (items is a fresh array each render).
  const idsKey = items.map((i) => i.id).join("|");
  useEffect(() => {
    const ids = items.map((i) => i.id);
    setOrder((cur) => {
      const next = reconcile(cur, ids);
      return sameArray(next, cur) ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const persist = useCallback(
    (next: string[]) => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* storage blocked — order still applies for this session */
      }
    },
    [storageKey],
  );

  // Render order: remembered ids that still exist, then any brand-new ones (appended).
  const byId = new Map(items.map((i) => [i.id, i] as const));
  // Memoised on the id set (idsKey) so the drag/nudge callbacks below keep a stable identity
  // across renders where only a card's inner content changed.
  const orderedIds = useMemo(() => {
    const present = new Set(items.map((i) => i.id));
    return [
      ...order.filter((id) => present.has(id)),
      ...items.filter((i) => !order.includes(i.id)).map((i) => i.id),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, idsKey]);

  // ── FLIP: animate a reorder that DIDN'T come from a pointer drag (keyboard ↑/↓) ──
  const orderKey = orderedIds.join("|");
  const measureTops = () => {
    const tops = new Map<string, number>();
    for (const id of orderedIds) {
      const el = elMap.current.get(id);
      if (el && el.offsetHeight > 0) tops.set(id, el.getBoundingClientRect().top);
    }
    return tops;
  };
  useIsoLayoutEffect(() => {
    // A pointer drag just committed a reorder: the DOM already reflects the new order and every
    // card sits where it belongs, so strip the drag's inline styles — nothing to animate, no flash.
    if (clearAfterDrag.current) {
      clearAfterDrag.current = false;
      for (const el of elMap.current.values()) {
        el.style.transition = "";
        el.style.transform = "";
        el.style.zIndex = "";
        el.style.filter = "";
        el.style.willChange = "";
      }
      prevOrderKey.current = orderKey;
      lastRects.current = measureTops();
      return;
    }
    const tops = measureTops();
    // Only animate when the ORDER actually changed — not when a card expands/collapses and nudges
    // its neighbours (those settle instantly, as before).
    const orderChanged = prevOrderKey.current !== null && prevOrderKey.current !== orderKey;
    prevOrderKey.current = orderKey;
    if (orderChanged && !prefersReducedMotion()) {
      for (const [id, newTop] of tops) {
        const prevTop = lastRects.current.get(id);
        const el = elMap.current.get(id);
        if (el && prevTop != null && prevTop !== newTop) {
          el.style.transition = "none";
          el.style.transform = `translateY(${prevTop - newTop}px)`;
          // Next frame: release to the natural position, animating the delta away.
          requestAnimationFrame(() => {
            el.style.transition = `transform ${DURATION_MS}ms ${EASING}`;
            el.style.transform = "";
          });
        }
      }
    }
    lastRects.current = tops;
  });

  const registerEl = useCallback(
    (id: string) =>
      (el: HTMLDivElement | null) => {
        if (el) elMap.current.set(id, el);
        else elMap.current.delete(id);
      },
    [],
  );

  // ── Pointer drag ────────────────────────────────────────────────────────
  const startDrag = useCallback(
    (draggedId: string, startClientY: number, pointerId: number, handleEl: HTMLElement) => {
      const reduce = prefersReducedMotion();
      // Snapshot the live layout of the visible cards, in visual order.
      const present = orderedIds.filter((id) => {
        const el = elMap.current.get(id);
        return el && el.offsetHeight > 0;
      });
      if (present.length < 2) return;
      const els = present.map((id) => elMap.current.get(id)!);
      const rects = els.map((el) => el.getBoundingClientRect());
      const centers = rects.map((r) => r.top + r.height / 2);
      const origIndex = present.indexOf(draggedId);
      if (origIndex < 0) return;
      const stride = rects[origIndex]!.height + gap;

      let targetIndex = origIndex;
      const dragged = els[origIndex]!;
      dragged.style.zIndex = "20";
      dragged.style.filter = `drop-shadow(${color.shadowDrag})`;
      dragged.style.willChange = "transform";
      if (!reduce) {
        els.forEach((el, i) => {
          if (i !== origIndex) el.style.transition = `transform ${DURATION_MS}ms ${EASING}`;
        });
      }
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      try {
        handleEl.setPointerCapture(pointerId);
      } catch {
        /* capture is best-effort */
      }
      setActiveId(draggedId);

      const onMove = (e: PointerEvent) => {
        const dy = e.clientY - startClientY;
        dragged.style.transform = `translateY(${dy}px) scale(1.02)`;
        const draggedCenter = centers[origIndex]! + dy;
        let idx = 0;
        for (let i = 0; i < present.length; i++) {
          if (i === origIndex) continue;
          if (centers[i]! < draggedCenter) idx++;
        }
        if (idx === targetIndex) return;
        targetIndex = idx;
        els.forEach((el, i) => {
          if (i === origIndex) return;
          let shift = 0;
          if (origIndex < targetIndex && i > origIndex && i <= targetIndex) shift = -stride;
          else if (origIndex > targetIndex && i >= targetIndex && i < origIndex) shift = stride;
          el.style.transform = shift ? `translateY(${shift}px)` : "";
        });
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      };

      // Strip the inline styles this drag set. Safe to call directly only when the DOM order is
      // unchanged; after a committed reorder the layout effect does it instead (post-reorder).
      const resetEls = () => {
        els.forEach((el) => {
          el.style.transition = "";
          el.style.transform = "";
          el.style.zIndex = "";
          el.style.filter = "";
          el.style.willChange = "";
        });
      };

      const commit = () => {
        setActiveId(null);
        if (targetIndex !== origIndex) {
          // `targetIndex` is the slot in the visible list with the dragged card removed, so the
          // card that should follow the dragged one is `withoutDragged[targetIndex]`.
          const withoutDragged = present.filter((pid) => pid !== draggedId);
          const next = insertBefore(orderedIds, draggedId, withoutDragged[targetIndex]);
          clearAfterDrag.current = true; // layout effect clears the styles once the reorder lands
          setOrder(next);
          persist(next);
        } else {
          resetEls(); // no reorder → DOM unchanged, safe to clear now
        }
      };

      const onUp = () => {
        cleanup();
        if (reduce) {
          commit();
          return;
        }
        // Settle the lifted card into its slot (offset is 0 when it didn't move → a smooth return),
        // then commit. The scale also eases back since the whole transform animates.
        const restingOffset = slotOffset(rects, origIndex, targetIndex, gap);
        dragged.style.transition = `transform ${DURATION_MS}ms ${EASING}`;
        dragged.style.transform = `translateY(${restingOffset}px)`;
        window.setTimeout(commit, DURATION_MS);
      };

      const onCancel = () => {
        cleanup();
        setActiveId(null);
        resetEls();
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") onCancel();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
    },
    [orderedIds, gap, persist],
  );

  // Keyboard reorder from a focused handle (↑/↓ move the card one slot).
  const nudge = useCallback(
    (id: string, dir: -1 | 1) => {
      const present = orderedIds.filter((pid) => {
        const el = elMap.current.get(pid);
        return el && el.offsetHeight > 0;
      });
      const at = present.indexOf(id);
      const to = at + dir;
      if (at < 0 || to < 0 || to >= present.length) return;
      const newPresent = move(present, at, to);
      const followerId = newPresent[to + 1]; // the visible card that should sit just below this one
      const next = insertBefore(orderedIds, id, followerId);
      setOrder(next);
      persist(next);
    },
    [orderedIds, persist],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {orderedIds.map((id) => {
        const entry = byId.get(id);
        if (!entry) return null;
        return (
          <SortableItem
            key={id}
            id={id}
            registerEl={registerEl(id)}
            active={activeId === id}
            onHandleDown={startDrag}
            onNudge={nudge}
          >
            {entry.node}
          </SortableItem>
        );
      })}
    </div>
  );
}

function SortableItem({
  id,
  children,
  registerEl,
  active,
  onHandleDown,
  onNudge,
}: {
  readonly id: string;
  readonly children: ReactNode;
  readonly registerEl: (el: HTMLDivElement | null) => void;
  readonly active: boolean;
  readonly onHandleDown: (id: string, clientY: number, pointerId: number, handle: HTMLElement) => void;
  readonly onNudge: (id: string, dir: -1 | 1) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);

  // A card that renders nothing (self-hidden, e.g. no customer / no quotes / no results yet)
  // collapses away — no empty shell, no stray handle, no phantom flex-gap. Emptiness is driven by
  // the CHILD card's own internal state (it returns null), which re-renders the child but NOT this
  // wrapper — so a plain per-render check goes stale and the handle lingers over nothing. A
  // MutationObserver on the content re-checks whenever the child adds/removes its root element,
  // keeping the collapse in sync with what is actually on screen.
  useIsoLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const check = () => setEmpty(content.childElementCount === 0);
    check(); // sync, before paint → no flash for cards that start empty
    const observer = new MutationObserver(check);
    observer.observe(content, { childList: true });
    return () => observer.disconnect();
  }, []);

  const setRefs = (el: HTMLDivElement | null) => {
    wrapperRef.current = el;
    registerEl(el);
  };

  return (
    <div
      ref={setRefs}
      style={{ position: "relative", display: empty ? "none" : undefined }}
    >
      {!empty && (
        <button
          type="button"
          aria-label={`Reorder this panel — drag, or use arrow keys`}
          title="Drag to reorder"
          onPointerDown={(e) => {
            if (e.button !== 0 && e.pointerType === "mouse") return;
            e.preventDefault();
            e.stopPropagation();
            onHandleDown(id, e.clientY, e.pointerId, e.currentTarget);
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onNudge(id, -1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onNudge(id, 1);
            }
          }}
          style={{
            position: "absolute",
            top: 8,
            left: 4,
            zIndex: 3,
            display: "grid",
            placeItems: "center",
            width: 20,
            height: 24,
            padding: 0,
            border: "none",
            background: "transparent",
            color: color.muted,
            opacity: active ? 1 : 0.4,
            cursor: active ? "grabbing" : "grab",
            borderRadius: radius.button,
            transition: "opacity 0.12s ease",
            touchAction: "none",
            lineHeight: 0,
          }}
          onMouseEnter={(e) => {
            if (!active) e.currentTarget.style.opacity = "0.9";
          }}
          onMouseLeave={(e) => {
            if (!active) e.currentTarget.style.opacity = "0.4";
          }}
          onFocus={(e) => (e.currentTarget.style.opacity = "0.9")}
          onBlur={(e) => (e.currentTarget.style.opacity = active ? "1" : "0.4")}
        >
          <GripIcon />
        </button>
      )}
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

/** A 2×3 dot grip — the near-universal "drag me" affordance. */
function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true" style={{ fontSize: font.xs }}>
      <circle cx="2.5" cy="3" r="1.3" />
      <circle cx="7.5" cy="3" r="1.3" />
      <circle cx="2.5" cy="8" r="1.3" />
      <circle cx="7.5" cy="8" r="1.3" />
      <circle cx="2.5" cy="13" r="1.3" />
      <circle cx="7.5" cy="13" r="1.3" />
    </svg>
  );
}

/** Move one id within `order` so it sits immediately before `followerId` (or last, if none).
 *  Correct even when hidden cards sit between the visible ones — it only relocates the one id. */
function insertBefore(order: readonly string[], id: string, followerId: string | undefined): string[] {
  const base = order.filter((x) => x !== id);
  const at = followerId != null ? base.indexOf(followerId) : -1;
  if (at < 0) base.push(id);
  else base.splice(at, 0, id);
  return base;
}

/** Signed distance the dragged card must travel from its original top to sit at `target`. */
function slotOffset(rects: DOMRect[], from: number, target: number, gap: number): number {
  if (target === from) return 0;
  let off = 0;
  if (target > from) {
    for (let i = from + 1; i <= target; i++) off += rects[i]!.height + gap;
  } else {
    for (let i = target; i < from; i++) off -= rects[i]!.height + gap;
  }
  return off;
}

/** Merge a saved/base order with the ids that actually exist, keeping remembered positions
 *  and appending anything new. Used both to fold in saved order and to reconcile added/removed ids. */
function reconcile(base: readonly string[], present: readonly string[]): string[] {
  const known = new Set(base);
  return [...base, ...present.filter((id) => !known.has(id))];
}
