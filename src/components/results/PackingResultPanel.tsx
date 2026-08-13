"use client";

import { useEffect, useMemo, useState } from "react";
import { color, font, spacing, radius } from "@/styles/tokens";
import { smartNum } from "@/lib/fmt";
import { Van3DViewer, packedItemToItem } from "@/components/results/Van3DViewer";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { rearrangeVan, suggestVansFor } from "@/lib/packing/rearrange";
import { toolBtn } from "@/components/results/van-3d/styles";
import type { Item } from "@/lib/packing/packing.types";
import { VanDebugPanel } from "@/components/results/VanDebugPanel";
import { VanIcon } from "@/components/results/VanIcon";
import { publicEnv } from "@/config/public-env";
import { describeVan } from "@/lib/packing/van-format";
import { computeUtilization, firstFitFloor, validateArrangement, stackLoadByPlacement, cascadeAfterRemoval } from "@/lib/packing/placement-validator";
import type { StackLoad } from "@/lib/packing/placement-validator";
import type { FlaggedTable, PackedItem, PackingResult, Placement, SkippedTable, UnplacedItem, Van } from "@/types/api";

/** One van in the mid-session "working fleet" — packer-chosen or manually added. */
interface WorkingVan {
  key: string;
  van: Van;
  origin: "packed" | "added";
  /** Only meaningful for origin "packed" — the index into the `fleet` prop this entry mirrors. */
  origIndex?: number;
}

function buildWorkingVans(fleet: PackingResult[]): WorkingVan[] {
  return fleet.map((r, i) => ({ key: `packed-${i}`, van: r.van, origin: "packed" as const, origIndex: i }));
}

function buildPlacementsByKey(fleet: PackingResult[]): Record<string, Placement[]> {
  const out: Record<string, Placement[]> = {};
  fleet.forEach((r, i) => { out[`packed-${i}`] = [...r.placements]; });
  return out;
}

interface PackingResultPanelProps {
  /** Chosen fleet, in load order — one entry per van used. */
  fleet: PackingResult[];
  /** Item references so placements can be labelled by description, not just number. */
  items: PackedItem[];
  /** Cargo no van can carry (oversized / missing dimensions). */
  unplaced: UnplacedItem[];
  reasons: Record<string, string>;
  fitsInSingleVan: boolean;
  packableUnits: number;
  /** Clearance slack (m) from the pack response — the 3D editor validates with the
   *  SAME value the packer used. Falls back to the config default if unset. */
  toleranceM?: number;
  /** Max reach height (m) from the pack response — the 3D editor validates with the
   *  SAME value the packer used. `null` ⇒ the operator turned the reach limit off for
   *  this pack (no cap); `undefined` ⇒ falls back to the config default. */
  maxReachHeightM?: number | null;
  /** Full van catalogue to offer when adding an empty van — falls back to the van
   *  types already present in `fleet` when omitted (e.g. the test/pack harness). */
  availableVanTypes?: Van[];
  /** Reach-limit toggle, surfaced as a subtle control beside the 3D model. State
   *  stays owned by the page (it drives a re-pack); this panel only renders + calls back. */
  respectReachLimit?: boolean;
  onToggleReachLimit?: () => void;
  /** True while a re-pack is in flight — disables the toggle. */
  reachBusy?: boolean;
  /** Consolidated-block id → display label, for NAME RESOLUTION ONLY — placements in
   *  `fleet` may reference a block id (e.g. "<sourceId>::block") that never appears in
   *  `items` (that list is deliberately pre-consolidation, for the review table/sums).
   *  Omitted/empty ⇒ current behaviour (raw id shown) — fail-safe. */
  blockLabels?: { id: string; name: string; unitsPerBlock: number }[];
  /** Tables read from the document but skipped whole (no size/pallet columns) — shown
   *  as a warning so a real table never vanishes into a bare "0/0 placed". */
  skippedTables?: SkippedTable[];
  /** Cargo tables read but with a guessed size unit / fixed-position size column —
   *  shown as a "verify these sizes" flag (the never-guess surface for column/unit). */
  flaggedTables?: FlaggedTable[];
}

export function PackingResultPanel({
  fleet,
  items,
  unplaced: unplacedProp,
  reasons,
  fitsInSingleVan,
  packableUnits,
  toleranceM,
  maxReachHeightM,
  availableVanTypes,
  respectReachLimit,
  onToggleReachLimit,
  reachBusy,
  blockLabels,
  skippedTables = [],
  flaggedTables = [],
}: PackingResultPanelProps) {
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const blockLabelMap = new Map((blockLabels ?? []).map((b) => [b.id, b.name]));
  // How many REAL units each placement stands for: a consolidated block placement carries
  // `unitsPerBlock` real units; a normal placement isn't in `blockLabels`, so it counts as 1.
  // Mirrors the server's `realUnitsOfPlacements` so the "units placed" tile reads in real units,
  // not placeable-object count (otherwise a 218-block/628-unit load shows a false "218/628").
  const unitsPerPlacement = new Map((blockLabels ?? []).map((b) => [b.id, b.unitsPerBlock]));
  const realUnitsOf = (p: Placement) => unitsPerPlacement.get(p.itemId) ?? 1;
  const nameFor = (id: string) => itemName.get(id) ?? blockLabelMap.get(id) ?? id;
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Local unplaced state so manually-dragged items can be removed from the list.
  // Cloned (not aliased) on init so a later in-place-looking edit here can never
  // leak back and mutate the parent's packResult.unplaced item objects by reference.
  const [localUnplaced, setLocalUnplaced] = useState(() => unplacedProp.map((u) => ({ ...u })));
  useEffect(() => setLocalUnplaced(unplacedProp.map((u) => ({ ...u }))), [unplacedProp]);
  const unplaced = localUnplaced;

  const onItemPlaced = (itemId: string) =>
    setLocalUnplaced((prev) => prev.filter((u) => u.id !== itemId));

  // Local reason overlay: a van-removed item shows a real reason instead of "unknown".
  const [localReasons, setLocalReasons] = useState<Record<string, string>>({});
  const reasonFor = (id: string) => localReasons[id] ?? reasons[id] ?? "unknown";

  // Placements are lifted out of the per-van cards so only ONE van renders its
  // (expensive) 3D canvas at a time while manual edits to the others survive a
  // switch. Re-sync only when the packer actually produces new placements — a
  // signature over item ids + positions, so an unrelated parent re-render or a
  // manual drag here never clobbers in-progress edits.
  // Folds in van.id (not just placements) so a re-pack that swaps which van was
  // chosen for an otherwise-identical layout — plausible across a 500-van fleet
  // with many same-interior vehicles — still forces a re-sync instead of silently
  // keeping the stale van object/label/rate from the previous fleet response.
  const packerSig = fleet
    .map((r) => `${r.van.id}::${r.placements.map((p) => `${p.itemId}@${p.position.x},${p.position.y},${p.position.z}`).join(",")}`)
    .join("|");
  const [workingVans, setWorkingVans] = useState<WorkingVan[]>(() => buildWorkingVans(fleet));
  const [placementsByKey, setPlacementsByKey] = useState<Record<string, Placement[]>>(() => buildPlacementsByKey(fleet));
  const [focused, setFocused] = useState<string>(() => workingVans[0]?.key ?? "");
  useEffect(() => {
    const rebuiltVans = buildWorkingVans(fleet);
    setWorkingVans(rebuiltVans);
    setPlacementsByKey(buildPlacementsByKey(fleet));
    setFocused(rebuiltVans[0]?.key ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packerSig]);

  const onVanPlacements = (key: string, next: Placement[]) => {
    const current = placementsByKey[key] ?? [];
    const curIds = new Set(current.map((p) => p.itemId));
    next.filter((p) => !curIds.has(p.itemId)).forEach((p) => onItemPlaced(p.itemId));
    setPlacementsByKey((prev) => ({ ...prev, [key]: next }));
  };

  // Cross-van move: lift an item out of `fromKey` and drop it onto the floor of
  // `toKey`, validated against that van's interior with the SAME rules/tolerance
  // the packer used. Fails loud (banner) rather than silently dropping the item when
  // the target van has no safe room. On success the view jumps to the target van so
  // the result is visible. The user can then drag to refine its position.
  const [moveError, setMoveError] = useState<string | null>(null);
  const tol = toleranceM ?? 0.005;
  // null ⇒ the operator explicitly turned the reach limit off (undefined for the
  // validator means "no cap"); undefined ⇒ no value came back, use the config default.
  const reachM = maxReachHeightM === null ? undefined : maxReachHeightM ?? 1.8;
  // Lifted above VanCard (which remounts on every focused-van switch, via its
  // `key={focused}`) so the tray's open/closed state survives switching vans.
  const [unplacedCollapsed, setUnplacedCollapsed] = useState(true);
  const moveItemToVan = (fromKey: string, itemIndex: number, toKey: string) => {
    const from = placementsByKey[fromKey] ?? [];
    const moving = from[itemIndex];
    const toVan = workingVans.find((v) => v.key === toKey)?.van;
    if (!moving || !toVan) return;
    const target = placementsByKey[toKey] ?? [];

    const spot = firstFitFloor(moving.size, toVan.interior, target, tol);
    if (!spot) {
      setMoveError(`${nameFor(moving.itemId)} won't fit on the floor of ${toVan.label}.`);
      return;
    }
    const moved: Placement = { ...moving, position: spot };
    const check = validateArrangement([...target, moved], toVan.interior, tol, reachM);
    if (!check.ok) {
      setMoveError(`Can't move ${nameFor(moving.itemId)} into ${toVan.label}: ${check.reason ?? "no safe spot"}.`);
      return;
    }
    setMoveError(null);
    setPlacementsByKey((prev) => ({
      ...prev,
      [fromKey]: (prev[fromKey] ?? []).filter((_, j) => j !== itemIndex),
      [toKey]: [...(prev[toKey] ?? []), moved],
    }));
    setFocused(toKey);
  };

  // Unplace a single item from a van — mirrors removeVan but for one placement:
  // its cargo returns to Unplaced for reassignment instead of the whole van.
  // Anything that was resting on top of it re-settles onto whatever's now
  // underneath (cascadeAfterRemoval) rather than being left floating; anything
  // that can no longer be validly supported joins it back in Unplaced.
  const unplaceItem = (fromKey: string, itemIndex: number) => {
    const from = placementsByKey[fromKey] ?? [];
    const leaving = from[itemIndex];
    const van = workingVans.find((v) => v.key === fromKey)?.van;
    if (!leaving || !van) return;

    const { settled, displaced } = cascadeAfterRemoval(from, itemIndex, van.interior, tol, reachM);
    const allLeaving = [leaving, ...displaced];

    setLocalUnplaced((prev) => {
      const next = [...prev];
      for (const p of allLeaving) {
        const idx = next.findIndex((u) => u.id === p.itemId);
        if (idx >= 0) next[idx] = { ...next[idx]!, quantity: next[idx]!.quantity + 1 };
        else next.push({ id: p.itemId, name: nameFor(p.itemId), quantity: 1 });
      }
      return next;
    });
    setLocalReasons((prev) => {
      const next = { ...prev };
      for (const p of allLeaving) next[p.itemId] = "removed from van - reassign or leave unplaced";
      return next;
    });
    setPlacementsByKey((prev) => ({ ...prev, [fromKey]: settled }));
    setMoveError(null);
  };

  // Add a brand-new empty van to the working plan — a manual rebalancing tool for
  // vans the packer did not originally choose.
  const addEmptyVan = (vanType: Van) => {
    // Never assign more of a type than the fleet owns (undefined quantity ⇒ unlimited).
    if (vanType.quantity !== undefined) {
      const used = workingVans.filter((v) => v.van.id === vanType.id).length;
      if (used >= vanType.quantity) {
        setMoveError(`No ${vanType.label} left — all ${vanType.quantity} in the fleet are already assigned to this job.`);
        return;
      }
    }
    const key = `added-${vanType.id}-${crypto.randomUUID()}`;
    setWorkingVans((prev) => [...prev, { key, van: vanType, origin: "added" }]);
    setPlacementsByKey((prev) => ({ ...prev, [key]: [] }));
    setFocused(key);
    setMoveError(null);
  };

  // Remove a van from the plan — its cargo returns to Unplaced for reassignment.
  // Never removes the last van (also disabled in the UI).
  const removeVan = (key: string) => {
    if (workingVans.length <= 1) return;
    const returning = placementsByKey[key] ?? [];
    if (returning.length > 0) {
      setLocalUnplaced((prev) => {
        const next = [...prev];
        for (const p of returning) {
          const idx = next.findIndex((u) => u.id === p.itemId);
          if (idx >= 0) next[idx] = { ...next[idx]!, quantity: next[idx]!.quantity + 1 };
          else next.push({ id: p.itemId, name: nameFor(p.itemId), quantity: 1 });
        }
        return next;
      });
      setLocalReasons((prev) => {
        const next = { ...prev };
        for (const p of returning) next[p.itemId] = "removed from van - reassign or leave unplaced";
        return next;
      });
    }
    setWorkingVans((prev) => prev.filter((v) => v.key !== key));
    setPlacementsByKey((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setFocused((f) => (f === key ? workingVans.find((v) => v.key !== key)?.key ?? "" : f));
    setMoveError(null);
  };

  // Has the operator changed the plan from what the packer computed? Any added van,
  // a removed packed van, or a changed layout on a surviving packed van all count.
  const isFleetModified =
    workingVans.some((v) => v.origin === "added") ||
    workingVans.filter((v) => v.origin === "packed").length !== fleet.length ||
    workingVans.some((v) => {
      if (v.origin !== "packed" || v.origIndex === undefined) return false;
      const orig = fleet[v.origIndex]?.placements ?? [];
      const arr = placementsByKey[v.key] ?? [];
      if (arr.length !== orig.length) return true;
      return arr.some((p, i) => {
        const o = orig[i];
        return !o || p.itemId !== o.itemId ||
          p.position.x !== o.position.x || p.position.y !== o.position.y || p.position.z !== o.position.z ||
          p.size.x !== o.size.x || p.size.y !== o.size.y || p.size.z !== o.size.z;
      });
    });

  // Restore the WHOLE computed plan — discards any added vans, restores any removed
  // ones, and resets every van's packer layout and the original unplaced list — so
  // a cross-van move can never leave an item duplicated or lost.
  const resetLayout = () => {
    const rebuiltVans = buildWorkingVans(fleet);
    setWorkingVans(rebuiltVans);
    setPlacementsByKey(buildPlacementsByKey(fleet));
    setLocalUnplaced(unplacedProp.map((u) => ({ ...u })));
    setLocalReasons({});
    setMoveError(null);
    setFocused(rebuiltVans[0]?.key ?? "");
  };

  /**
   * REARRANGE EVERY VAN — re-optimise the inside of each vehicle without undoing the operator's
   * van-to-van decisions. Distinct from Reset layout in the one way that matters: an item stays in
   * the van the operator put it in. (Re-running the fleet allocator from scratch would just
   * reproduce the packer's original plan — that IS Reset layout, so it would be a second button
   * doing the same job.)
   *
   * Each van is re-packed with the real packer (so orientation locks, crush limits, reach height,
   * drop order and the van's PAYLOAD are all honoured), and the unplaced pool is offered to each van
   * in turn, so leftovers land wherever there is genuinely room. Anything a van refuses — including
   * cargo that was already sitting in it but pushes it over its weight limit — joins that pool and
   * is offered to the remaining vans; whatever survives to the end stays honestly unplaced with a
   * reason, never silently vanished.
   */
  const rearrangeFleet = () => {
    const pool = new Map<string, number>();
    for (const u of localUnplaced) pool.set(u.id, (pool.get(u.id) ?? 0) + u.quantity);
    const poolReasons: Record<string, string> = {};
    const nextByKey: Record<string, Placement[]> = {};

    for (const v of workingVans) {
      const wanted = new Map<string, number>();
      for (const p of placementsByKey[v.key] ?? []) wanted.set(p.itemId, (wanted.get(p.itemId) ?? 0) + 1);
      for (const [id, qty] of pool) {
        if (itemById.get(id)?.dimensions == null || qty <= 0) continue;
        wanted.set(id, (wanted.get(id) ?? 0) + qty);
      }
      const packItems: Item[] = [];
      for (const [id, qty] of wanted) {
        const pi = itemById.get(id);
        if (pi && pi.dimensions != null && qty > 0) packItems.push(packedItemToItem(pi, qty));
      }
      if (packItems.length === 0) {
        nextByKey[v.key] = [];
        continue;
      }
      const result = rearrangeVan(packItems, v.van, { toleranceM: tol, maxReachHeightM: reachM });
      nextByKey[v.key] = result.placements;
      // Whatever this van couldn't take becomes the pool the NEXT van is offered. An item this van
      // rejected is only ever re-homed because this van refused it — never moved on a whim.
      pool.clear();
      for (const u of result.unplaced) {
        if (u.quantity > 0) pool.set(u.id, (pool.get(u.id) ?? 0) + u.quantity);
        const why = result.reasons[u.id];
        if (why) poolReasons[u.id] = why;
      }
    }

    setPlacementsByKey(nextByKey);
    const leftover = [...pool.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([id, quantity]) => ({ id, name: nameFor(id), quantity }));
    setLocalUnplaced(leftover);
    setLocalReasons((prev) => ({ ...prev, ...poolReasons }));
    const outUnits = leftover.reduce((n, u) => n + u.quantity, 0);
    if (outUnits === 0) {
      setMoveError(null);
      return;
    }

    // Leftovers on a big job are not a refusal — the load is simply bigger than the fleet currently
    // assigned to it, and the operator's next move is to add a vehicle. So say WHICH vehicle and HOW
    // MANY, proved by actually packing the leftovers into that van type (suggestVansFor), rather than
    // leaving them to work it out from a bare count. Only types they have spare are offered.
    const leftoverItems: Item[] = [];
    for (const u of leftover) {
      const pi = itemById.get(u.id);
      if (pi && pi.dimensions != null) leftoverItems.push(packedItemToItem(pi, u.quantity));
    }
    const spare = catalogueWithAvail.filter((c) => c.remaining === null || c.remaining > 0).map((c) => c.van);
    const suggestion =
      leftoverItems.length > 0 ? suggestVansFor(leftoverItems, spare, { toleranceM: tol, maxReachHeightM: reachM }) : null;
    const units = `${outUnits} unit${outUnits === 1 ? "" : "s"}`;
    setMoveError(
      suggestion
        ? `Rearranged every van — ${units} wouldn’t fit back in. ${suggestion.vansNeeded} more ${suggestion.van.label}${suggestion.vansNeeded === 1 ? "" : "s"} would carry ${outUnits === 1 ? "it" : "them"} — use Add van above. (They're in the Unplaced tray meanwhile, still part of this job.)`
        : `Rearranged every van — ${units} wouldn’t fit back in, and no spare van type in your fleet can carry ${outUnits === 1 ? "it" : "them"}. See the Unplaced tray for why.`,
    );
  };

  // Add-van catalogue: availableVanTypes first, then any fleet van type not already
  // present — so Add-van always offers at least the types already used in this plan.
  const vanCatalogue = useMemo(() => {
    const seen = new Set<string>();
    const out: Van[] = [];
    for (const v of availableVanTypes ?? []) {
      if (!seen.has(v.id)) { seen.add(v.id); out.push(v); }
    }
    for (const r of fleet) {
      if (!seen.has(r.van.id)) { seen.add(r.van.id); out.push(r.van); }
    }
    return out;
  }, [availableVanTypes, fleet]);

  // Remaining availability per van type: the fleet's OWNED count (`van.quantity`)
  // minus how many of that type this plan already uses (packer-chosen + manually
  // added). Derived from the LIVE workingVans, so adding or removing a van reprices
  // the Add-van menu on the very next render — no request, no lag. `quantity`
  // undefined ⇒ unlimited (test harness / an unset fleet), shown without a count.
  const catalogueWithAvail = useMemo(() => {
    const usedByType = new Map<string, number>();
    for (const v of workingVans) usedByType.set(v.van.id, (usedByType.get(v.van.id) ?? 0) + 1);
    return vanCatalogue.map((van) => ({
      van,
      remaining: van.quantity === undefined ? null : Math.max(0, van.quantity - (usedByType.get(van.id) ?? 0)),
    }));
  }, [vanCatalogue, workingVans]);

  // Summary + Fleet-reference stats are derived from the LIVE working fleet
  // (workingVans/placementsByKey), never the pristine `fleet` prop — otherwise
  // these always-visible surfaces would desync from the van strip/card below the
  // moment the operator adds, removes, or moves anything (see isFleetModified).
  // Real units placed = Σ unitsPerBlock over every placement (a block stands for many units).
  const placedUnits = workingVans.reduce(
    (s, v) => s + (placementsByKey[v.key] ?? []).reduce((u, p) => u + realUnitsOf(p), 0),
    0,
  );
  // Placeable-object (pallet/block) count — shown as a sub-caption, not the fraction itself.
  const placedPallets = workingVans.reduce((s, v) => s + (placementsByKey[v.key]?.length ?? 0), 0);
  // Unplaced measured in REAL units (each row's quantity is already expanded server-side), so the
  // row reconciles: placedUnits + unplacedUnits === packableUnits (the server's conservation law).
  const unplacedUnits = unplaced.reduce((s, u) => s + Math.max(1, u.quantity), 0);
  const totalWeightKg = workingVans.reduce(
    (s, v) => s + (placementsByKey[v.key] ?? []).reduce((w, p) => w + p.weightKg, 0),
    0,
  );
  const totalCapacityKg = workingVans.reduce((s, v) => s + v.van.maxPayloadKg, 0);
  const fleetPayloadUtil = totalCapacityKg > 0 ? totalWeightKg / totalCapacityKg : 0;
  const fleetVolumeUtil =
    workingVans.reduce((s, v) => s + computeUtilization(placementsByKey[v.key] ?? [], v.van.interior).volumeFill, 0) /
    Math.max(1, workingVans.length);
  const weightLimited = fleetPayloadUtil > 0.65 && fleetVolumeUtil < 0.25;
  const complete = unplaced.length === 0;
  // How many unplaced units failed ONLY because their spot sat above the reach
  // cap (heuristic-packer's reachLimited reason) — distinct from a genuinely
  // full van, and fixable right now via the toggle above this panel.
  const reachLimitedCount = unplaced.reduce(
    (s, u) => (reasonFor(u.id).includes("reach limit") ? s + u.quantity : s),
    0,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>
      {/* Summary */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md }}>
          <p style={label}>Load plan{workingVans.length > 1 ? ` — ${workingVans.length} vans` : ""}</p>
          <span style={badge(fitsInSingleVan ? "ok" : complete ? "info" : "warn")}>
            {fitsInSingleVan ? "Fits one van" : complete ? `Needs ${workingVans.length} vans` : "Cargo unplaced"}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: spacing.sm }}>
          <StatTile label="Vehicles" value={String(workingVans.length)} />
          <StatTile
            label="Units placed"
            value={`${placedUnits}/${packableUnits}`}
            hint={placedPallets !== placedUnits ? `in ${placedPallets} pallet${placedPallets !== 1 ? "s" : ""}` : undefined}
          />
          <StatTile
            label="Unplaced"
            value={String(unplacedUnits)}
            accent={unplacedUnits > 0}
            hint={unplaced.length > 0 ? `${unplaced.length} item${unplaced.length !== 1 ? "s" : ""}` : undefined}
          />
          <StatTile label="Total weight" value={`${smartNum(totalWeightKg)} kg`} />
        </div>
        {unplaced.length > 0 && (
          <div
            role="alert"
            style={{
              marginTop: spacing.sm,
              padding: `${spacing.sm}px ${spacing.md}px`,
              background: color.fragile.bg,
              border: `1px solid ${color.fragile.border}`,
              borderRadius: radius.input,
              color: color.fragile.fg,
              fontSize: font.xs,
            }}
          >
            <strong>
              ⚠ {unplacedUnits} unit{unplacedUnits !== 1 ? "s" : ""} could not be placed
              {unplaced.length > 1 ? ` (${unplaced.length} items)` : ""}
            </strong>
            <div style={{ marginTop: spacing.xs, display: "flex", flexDirection: "column", gap: spacing.xs }}>
              {unplaced.map((u) => (
                <div key={u.id} style={{ display: "flex", justifyContent: "space-between", gap: spacing.md }}>
                  <span style={{ fontWeight: 600 }}>
                    {nameFor(u.id)} <span style={{ fontWeight: 400, opacity: 0.8 }}>× {u.quantity}</span>
                  </span>
                  <span style={{ textAlign: "right", opacity: 0.9 }}>{reasonFor(u.id)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {skippedTables.length > 0 && (() => {
          const rows = skippedTables.reduce((s, t) => s + t.rowCount, 0);
          return (
            <div
              role="alert"
              style={{
                marginTop: spacing.sm,
                padding: `${spacing.sm}px ${spacing.md}px`,
                background: color.overload.bg,
                border: `1px solid ${color.overload.border}`,
                borderRadius: radius.input,
                color: color.overload.fg,
                fontSize: font.xs,
              }}
            >
              <strong>
                ⚠ {skippedTables.length} table{skippedTables.length !== 1 ? "s" : ""} read but not loaded
              </strong>{" "}
              — {rows} row{rows !== 1 ? "s" : ""} had no size (Height/Width) or Pallet columns to build a load from, so {rows !== 1 ? "they are" : "it is"} not counted above. Check those columns in the source file.
              <details style={{ marginTop: spacing.xs }}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>Which tables</summary>
                <div style={{ overflowX: "auto", marginTop: spacing.xs }}>
                  {skippedTables.map((t, i) => (
                    <div key={i} style={{ marginTop: 4, whiteSpace: "nowrap" }}>
                      Page {t.pageIndex + 1}, table {t.tableIndex + 1} ({t.rowCount} row{t.rowCount !== 1 ? "s" : ""}): {t.headers.join(" · ")}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          );
        })()}
        {flaggedTables.length > 0 && (
          <div
            role="alert"
            style={{
              marginTop: spacing.sm,
              padding: `${spacing.sm}px ${spacing.md}px`,
              background: color.warningBg,
              border: `1px solid ${color.warningBorder}`,
              borderRadius: radius.input,
              color: color.warning,
              fontSize: font.xs,
            }}
          >
            <strong>
              ⚠ {flaggedTables.length} table{flaggedTables.length !== 1 ? "s" : ""} read but the sizes need a check
            </strong>{" "}
            — the size unit or a size column had to be guessed from the layout, so the dimensions above may be wrong. Verify them against the source file.
            <details style={{ marginTop: spacing.xs }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Which tables &amp; why</summary>
              <div style={{ overflowX: "auto", marginTop: spacing.xs }}>
                {flaggedTables.map((t, i) => (
                  <div key={i} style={{ marginTop: 4 }}>
                    <span style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                      Page {t.pageIndex + 1}, table {t.tableIndex + 1}:
                    </span>{" "}
                    {t.reason}
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}
        {reachLimitedCount > 0 && (
          <p style={{ fontSize: font.xs, color: color.fragile.fg, marginTop: spacing.sm, marginBottom: 0 }}>
            {reachLimitedCount} unit{reachLimitedCount !== 1 ? "s" : ""} unplaced only by the reach limit — turn off &ldquo;reach limit&rdquo; below to fit them.
          </p>
        )}
        {weightLimited && (
          <p style={{ fontSize: font.xs, color: color.muted, marginTop: spacing.sm, marginBottom: 0 }}>
            Weight-constrained load — van selected for payload capacity ({smartNum(fleetPayloadUtil * 100)}% of {smartNum(totalCapacityKg)} kg used), not volume ({smartNum(fleetVolumeUtil * 100)}% fill). Smaller vans in this fleet cannot carry {smartNum(totalWeightKg)} kg in a single trip.
          </p>
        )}
        {!weightLimited && complete && workingVans.length > 1 && (
          <p style={{ fontSize: font.xs, color: color.muted, marginTop: spacing.sm, marginBottom: 0 }}>
            {isFleetModified
              ? `Editing this load — ${workingVans.length} vans as currently arranged. Reset layout to return to the packer's original combination.`
              : `Why these ${workingVans.length} vans — this is the cheapest combination that carries every item. Each van is filled as fully as the load allows, and when two combinations cost the same the one with fewer, fuller vans is chosen.`}
          </p>
        )}
      </div>

      {/* Fleet reference — the one table that names the actual vehicles/ids, kept
          in sync with the live working fleet (add/remove/move all reflect here). */}
      <div style={card}>
        <p style={{ ...label, marginBottom: spacing.sm }}>Fleet reference</p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: font.sm }}>
            <thead>
              <tr>
                {["#", "Vehicle", "Van ID", "Description", "Items", "Weight", "Payload", "Volume"].map((h) => (
                  <th key={h} style={{ ...th, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workingVans.map((v, i) => {
                const vanPlacements = placementsByKey[v.key] ?? [];
                const vanWeight = vanPlacements.reduce((s, p) => s + p.weightKg, 0);
                const { volumeFill } = computeUtilization(vanPlacements, v.van.interior);
                return (
                  <tr key={v.key}>
                    <td style={{ ...td, color: color.muted }}>{i + 1}</td>
                    <td style={{ ...td, fontWeight: 600 }}>{v.van.label}</td>
                    <td style={{ ...td, color: color.muted, fontVariantNumeric: "tabular-nums" }}>{v.van.id}</td>
                    <td style={td}>{describeVan(v.van.interior, v.van.maxPayloadKg)}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{vanPlacements.length}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{smartNum(vanWeight)} kg</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{smartNum(vanWeight / v.van.maxPayloadKg * 100)}%</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{smartNum(volumeFill * 100)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-van detail — a gallery: pick a van from the strip, study it in the
          big focus viewer. Only the focused van mounts a 3D canvas, so a 25-van
          fleet stays light instead of stacking 25 WebGL scenes down the page. */}
      <VanStrip
        workingVans={workingVans}
        placementsByKey={placementsByKey}
        focused={focused}
        onPick={setFocused}
        vanCatalogue={catalogueWithAvail}
        onAddVan={addEmptyVan}
      />
      {/* Fleet-wide tidy-up. Deliberately styled as a quiet outline button, NOT like Reset layout:
          Reset is the destructive one (it discards every van-to-van move), this one keeps them. */}
      {workingVans.length > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={rearrangeFleet}
            title="Re-optimise the inside of every van, keeping each item in the van you assigned it to. Respects orientation locks, stacking/crush limits, reach height, drop order and each vehicle's weight limit. Anything that no longer fits goes to Unplaced with a reason. (Reset layout is the one that discards your van-to-van moves.)"
            style={{ ...toolBtn, borderColor: color.accent, color: color.accent }}
          >
            ⇄ Rearrange all vans
          </button>
        </div>
      )}
      {moveError && (
        <ErrorBanner style={{ fontSize: font.sm, padding: `${spacing.sm}px ${spacing.md}px` }}>
          {moveError}
        </ErrorBanner>
      )}
      {(() => {
        const focusedVan = workingVans.find((v) => v.key === focused);
        if (!focusedVan) return null;
        const focusedPos = workingVans.findIndex((v) => v.key === focused);
        return (
          <VanCard
            key={focused}
            index={focusedPos}
            total={workingVans.length}
            van={focusedVan.van}
            placements={placementsByKey[focused] ?? []}
            vans={workingVans.map((v) => ({ key: v.key, label: v.van.label }))}
            vanKey={focused}
            onPlacementsChange={(next) => onVanPlacements(focused, next)}
            onPrev={workingVans.length > 1 ? () => setFocused(workingVans[(focusedPos - 1 + workingVans.length) % workingVans.length]!.key) : undefined}
            onNext={workingVans.length > 1 ? () => setFocused(workingVans[(focusedPos + 1) % workingVans.length]!.key) : undefined}
            onMoveToVan={workingVans.length > 1 ? (itemIndex, toKey) => moveItemToVan(focused, itemIndex, toKey) : undefined}
            onUnplace={(itemIndex) => unplaceItem(focused, itemIndex)}
            onRemove={() => removeVan(focused)}
            isModified={isFleetModified}
            onResetLayout={resetLayout}
            nameFor={nameFor}
            itemById={itemById}
            toleranceM={toleranceM}
            maxReachHeightM={reachM}
            unplaced={unplaced}
            reasonFor={reasonFor}
            unplacedCollapsed={unplacedCollapsed}
            onToggleUnplacedCollapsed={() => setUnplacedCollapsed((c) => !c)}
            respectReachLimit={respectReachLimit}
            onToggleReachLimit={onToggleReachLimit}
            reachBusy={reachBusy}
          />
        );
      })()}
    </div>
  );
}

/* ── Van strip — collapsed thumbnails, one per van, click to maximise ─────── */

function VanStrip({
  workingVans, placementsByKey, focused, onPick, vanCatalogue, onAddVan,
}: {
  workingVans: WorkingVan[];
  placementsByKey: Record<string, Placement[]>;
  focused: string;
  onPick: (key: string) => void;
  /** Each addable van type with how many remain in the fleet (null ⇒ unlimited). */
  vanCatalogue: { van: Van; remaining: number | null }[];
  onAddVan: (vanType: Van) => void;
}) {
  const [adding, setAdding] = useState(false);
  // Something is addable only if at least one type has stock (or is unlimited).
  const canAdd = vanCatalogue.some((c) => c.remaining === null || c.remaining > 0);
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: spacing.sm }}>
        <p style={{ ...label, margin: 0 }}>Assigned vans — {workingVans.length}</p>
        <span style={{ fontSize: font.xs, color: color.muted }}>Tap a van to inspect its load</span>
      </div>
      <div style={{ display: "flex", gap: spacing.sm, overflowX: "auto", paddingBottom: spacing.xs }}>
        {workingVans.map((v, i) => {
          const isOn = v.key === focused;
          const vanPlacements = placementsByKey[v.key] ?? [];
          const { volumeFill } = computeUtilization(vanPlacements, v.van.interior);
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => onPick(v.key)}
              title={`${i + 1}. ${v.van.label}`}
              style={{
                flex: "0 0 auto",
                width: 104,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
                padding: spacing.sm,
                borderRadius: radius.card - 4,
                cursor: "pointer",
                background: isOn ? color.accentMuted : color.surfaceSub,
                border: `1px solid ${isOn ? color.accent : color.border}`,
              }}
            >
              <span style={{ display: "flex", alignItems: "flex-end", height: 34 }}>
                <VanIcon lengthMm={v.van.interior.l} heightMm={v.van.interior.h} px={52} />
              </span>
              <span style={{ fontSize: font.xs, fontWeight: 700, color: color.text }}>{i + 1}. {v.van.label}</span>
              <span style={{ fontSize: font.xs, color: color.muted, whiteSpace: "nowrap" }}>
                {vanPlacements.length} item{vanPlacements.length !== 1 ? "s" : ""} · {smartNum(volumeFill * 100)}%
              </span>
            </button>
          );
        })}
        <div
          style={{
            flex: "0 0 auto",
            width: 104,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: spacing.sm,
            borderRadius: radius.card - 4,
            border: `1px dashed ${color.border}`,
          }}
        >
          {adding ? (
            // Uncontrolled with the placeholder selected, so picking ANY type — including
            // the first in the list — is a change that fires onChange. (A controlled value
            // pre-set to the first van id swallowed the pick of that same first type.)
            <select
              autoFocus
              defaultValue=""
              onChange={(e) => {
                const picked = vanCatalogue.find((c) => c.van.id === e.target.value);
                if (picked && picked.remaining !== 0) onAddVan(picked.van);
                setAdding(false);
              }}
              onBlur={() => setAdding(false)}
              style={{ ...navBtn, width: "100%" }}
            >
              <option value="" disabled>Pick a type…</option>
              {vanCatalogue.map((c) => (
                <option key={c.van.id} value={c.van.id} disabled={c.remaining === 0}>
                  {c.van.label}
                  {c.remaining === null ? "" : c.remaining === 0 ? " — none left" : ` — ${c.remaining} available`}
                </option>
              ))}
            </select>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              disabled={!canAdd}
              title={!canAdd ? "No vans left in the fleet to add" : "Add a van from the available fleet to this job"}
              style={{ ...navBtn, width: "100%" }}
            >
              + Add van
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Per-van card (the maximised focus view) ─────────────────────────────── */

function VanCard({
  index, total, van, placements, vans, vanKey, onPlacementsChange, onPrev, onNext, onMoveToVan, onUnplace, onRemove, isModified, onResetLayout, nameFor, itemById, toleranceM, maxReachHeightM, unplaced, reasonFor, unplacedCollapsed, onToggleUnplacedCollapsed, respectReachLimit, onToggleReachLimit, reachBusy,
}: {
  index: number;
  total: number;
  van: Van;
  placements: Placement[];
  vans: { key: string; label: string }[];
  vanKey: string;
  onPlacementsChange: (next: Placement[]) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onMoveToVan?: (itemIndex: number, toKey: string) => void;
  onUnplace?: (itemIndex: number) => void;
  onRemove: () => void;
  isModified: boolean;
  onResetLayout: () => void;
  nameFor: (id: string) => string;
  itemById: Map<string, PackedItem>;
  toleranceM?: number;
  maxReachHeightM?: number;
  unplaced: UnplacedItem[];
  reasonFor: (id: string) => string;
  unplacedCollapsed: boolean;
  onToggleUnplacedCollapsed: () => void;
  respectReachLimit?: boolean;
  onToggleReachLimit?: () => void;
  reachBusy?: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setConfirmRemove(false), [vanKey]);

  const placed = placements.length;
  const totalWeight = placements.reduce((s, p) => s + p.weightKg, 0);
  const payloadUtil = totalWeight / van.maxPayloadKg;
  const names = placements.map((p) => nameFor(p.itemId));
  const { volumeFill, floorFootprint } = computeUtilization(placements, van.interior);
  const loads = stackLoadByPlacement(placements, toleranceM ?? 0.005);
  const overloadedCount = loads.filter((l) => l.overloaded).length;

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm, flexWrap: "wrap", gap: spacing.sm }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: spacing.sm, flexWrap: "wrap" }}>
          <p style={{ ...label, margin: 0 }}>Van {index + 1}{total > 1 ? ` of ${total}` : ""}</p>
          <span style={{ fontSize: font.md ?? font.sm, fontWeight: 600, color: color.text }}>{van.label}</span>
          <span style={{ fontSize: font.sm, color: color.muted }}>
            {describeVan(van.interior, van.maxPayloadKg)}
          </span>
        </div>
        <div style={{ display: "flex", gap: spacing.xs, alignItems: "center" }}>
          {onToggleReachLimit && (
            <label
              title="Keep stacks within a worker's unaided reach (1.8 m). Uncheck to allow taller stacks — assumes a ladder or lift."
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontSize: font.xs,
                color: color.muted,
                cursor: reachBusy ? "not-allowed" : "pointer",
                opacity: reachBusy ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              <input
                type="checkbox"
                checked={respectReachLimit ?? true}
                disabled={reachBusy}
                onChange={onToggleReachLimit}
              />
              1.8m reach limit
            </label>
          )}
          {(onPrev || onNext) && (
            <>
              <button type="button" onClick={onPrev} aria-label="Previous van" style={navBtn}>‹ Prev</button>
              <button type="button" onClick={onNext} aria-label="Next van" style={navBtn}>Next ›</button>
            </>
          )}
          {total > 1 ? (
            confirmRemove ? (
              <>
                <button
                  type="button"
                  onClick={() => { onRemove(); setConfirmRemove(false); }}
                  style={{ ...navBtn, background: color.fragile.bg, color: color.error, borderColor: color.fragile.border }}
                >
                  Confirm remove
                </button>
                <button type="button" onClick={() => setConfirmRemove(false)} style={navBtn}>Cancel</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmRemove(true)} style={navBtn} title="Remove this van from the plan — its items return to Unplaced">
                Remove van
              </button>
            )
          ) : (
            <button type="button" disabled style={{ ...navBtn, color: color.muted, borderColor: color.border, cursor: "not-allowed" }} title="Can't remove the only van in the plan.">
              Remove van
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: spacing.sm, marginBottom: spacing.md }}>
        <StatTile label="Volume fill" value={`${smartNum(volumeFill * 100)}%`} />
        <StatTile label="Floor used" value={`${smartNum(floorFootprint * 100)}%`} />
        <StatTile label="Payload used" value={`${smartNum(payloadUtil * 100)}%`} accent={payloadUtil > 0.8} />
        <StatTile label="Items" value={String(placed)} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.md }}>
        <div style={{ flex: 1, minWidth: 320 }}>
          <Van3DViewer
            placements={placements}
            interior={van.interior}
            itemNames={names}
            editable
            onPlacementsChange={onPlacementsChange}
            isModified={isModified}
            onResetLayout={onResetLayout}
            itemById={itemById}
            toleranceM={toleranceM}
            maxReachHeightM={maxReachHeightM}
            maxPayloadKg={van.maxPayloadKg}
            vans={vans}
            vanKey={vanKey}
            onMoveToVan={onMoveToVan}
            onUnplace={onUnplace}
            unplaced={unplaced}
            reasonFor={reasonFor}
            unplacedCollapsed={unplacedCollapsed}
            onToggleUnplacedCollapsed={onToggleUnplacedCollapsed}
          />
        </div>
        {publicEnv.debugPanel && (
          <VanDebugPanel
            placements={placements}
            interior={van.interior}
            maxPayloadKg={van.maxPayloadKg}
            maxReachHeightM={maxReachHeightM ?? null}
            hasUnplacedGlobal={unplaced.length > 0}
            nameFor={nameFor}
          />
        )}
      </div>

      {placed > 0 && (
        <details style={{ marginTop: spacing.md }}>
          <summary style={{ ...label, cursor: "pointer" }}>
            Placements ({placed})
            {overloadedCount > 0 && (
              <span style={{ marginLeft: spacing.sm, fontSize: font.xs, fontWeight: 600, padding: "2px 8px", borderRadius: radius.badge, background: color.overload.bg, color: color.overload.fg, border: `1px solid ${color.overload.border}` }}>
                ⚠ {overloadedCount} over crush limit
              </span>
            )}
          </summary>
          <div style={{ overflowX: "auto", marginTop: spacing.sm }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: font.xs }}>
              <thead>
                <tr>
                  {["#", "Item", "From rear (m)", "From left (m)", "From right (m)", "Height from floor (m)", "Size L×W×H (m)", "Weight (kg)", "Load on top", "Type"].map((h) => (
                    <th key={h} style={{ ...th, whiteSpace: "nowrap", padding: "5px 8px" }} title={HEAD_TIP[h]}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {placements.map((p, i) => {
                  const load = loads[i]!;
                  const bg = load.overloaded ? color.overload.bg : p.fragile ? color.fragile.bg : "transparent";
                  return (
                    <tr key={i} style={{ background: bg }}>
                      <td style={{ ...tdSm, color: color.muted, borderLeft: load.overloaded ? `3px solid ${color.overload.edge}` : undefined }}>{i + 1}</td>
                      <td style={{ ...tdSm, fontWeight: 600 }}>{nameFor(p.itemId)}</td>
                      <td style={tdNum}>{smartNum(p.position.x)}</td>
                      <td style={tdNum}>{smartNum(van.interior.w - (p.position.y + p.size.y))}</td>
                      <td style={tdNum}>{smartNum(p.position.y)}</td>
                      <td style={tdNum}>{smartNum(p.position.z)}</td>
                      <td style={tdNum}>{smartNum(p.size.x)}×{smartNum(p.size.y)}×{smartNum(p.size.z)}</td>
                      <td style={tdNum}>{smartNum(p.weightKg)}</td>
                      <td style={tdSm}><LoadMeter load={load} /></td>
                      <td style={{ ...tdSm, color: p.fragile ? color.fragile.fg : color.standard.fg, fontWeight: 600 }}>
                        {p.fragile ? "Fragile" : "Standard"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: font.xs, color: color.muted, marginTop: spacing.sm, marginBottom: 0 }}>
            All distances in metres. Numbers match the wall labels on the 3D view above &mdash; each is the gap from that interior wall to the item&apos;s nearest face, at floor level.
          </p>
        </details>
      )}
    </div>
  );
}

/* ── Shared styles ──────────────────────────────────────────────────────── */

const card: React.CSSProperties = {
  background: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.card,
  padding: spacing.lg,
};

const label: React.CSSProperties = {
  margin: 0,
  fontSize: font.xs,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: color.muted,
};

function badge(kind: "ok" | "info" | "warn"): React.CSSProperties {
  const palette =
    kind === "ok"
      ? color.standard
      : kind === "info"
      ? { bg: color.accentMuted, fg: color.accent, border: color.accentBorder }
      : color.fragile;
  return {
    fontSize: font.xs,
    fontWeight: 600,
    padding: "3px 10px",
    borderRadius: radius.badge,
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.border}`,
  };
}

const th: React.CSSProperties = {
  padding: "6px 10px",
  textAlign: "left",
  background: color.surfaceSub,
  color: color.muted,
  fontWeight: 600,
  borderBottom: `1px solid ${color.border}`,
};

const td: React.CSSProperties = {
  padding: "6px 10px",
  color: color.text,
  borderBottom: `1px solid ${color.border}`,
};

const navBtn: React.CSSProperties = {
  border: `1px solid ${color.border}`,
  background: color.surfaceSub,
  color: color.text,
  borderRadius: 999,
  padding: "4px 12px",
  fontSize: font.xs,
  fontWeight: 600,
  cursor: "pointer",
};

const tdSm: React.CSSProperties = { padding: "5px 8px", color: color.text, borderBottom: `1px solid ${color.border}` };
const tdNum: React.CSSProperties = { ...tdSm, fontVariantNumeric: "tabular-nums" };

/** Plain-language header tooltips for the placements table. */
const HEAD_TIP: Record<string, string> = {
  "Load on top":
    "How full this item's crush limit is — the weight resting on it versus the most it can safely bear. A ⚠ flag means the stack now exceeds its limit; lighten it or raise its On-top load setting.",
};

/** Compact "how full is this item's crush limit" bar + %, shared by the placements
 *  table. Reads a `StackLoad` from `stackLoadByPlacement`. Nothing on top → em-dash;
 *  over a zero limit → "over". The ⚠ + colour come from the validator-faithful
 *  `load.overloaded`, NOT from ratio>1 (they can differ in composite stacks). */
function LoadMeter({ load }: { load: StackLoad }) {
  const { restingKg, pressureKpa, capacityKpa, ratio, overloaded } = load;
  if (restingKg <= 0) {
    return <span style={{ color: color.muted }} title="Nothing is stacked on this item">&mdash;</span>;
  }
  const fillPct = Math.min(100, Number.isFinite(ratio) ? ratio * 100 : 100);
  const pctLabel = Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : "over";
  const title = `${smartNum(pressureKpa)} kPa resting of ${smartNum(capacityKpa)} kPa limit`;
  return (
    <div title={title} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 96 }}>
      <div style={{ position: "relative", flex: 1, height: 6, borderRadius: radius.badge, background: color.surfaceHover, overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: `${fillPct}%`, background: overloaded ? color.overload.edge : color.accent, borderRadius: radius.badge }} />
      </div>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, whiteSpace: "nowrap", color: overloaded ? color.overload.fg : color.muted }}>
        {overloaded ? "⚠ " : ""}{pctLabel}
      </span>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function StatTile({ label: tileLabel, value, accent = false, hint }: { label: string; value: string; accent?: boolean; hint?: string }) {
  return (
    <div style={{
      background: accent ? color.fragile.bg : color.surfaceSub,
      border: `1px solid ${accent ? color.fragile.border : color.border}`,
      borderRadius: radius.card - 4,
      padding: `${spacing.sm}px ${spacing.md}px`,
    }}>
      <div style={{ fontSize: font.xl - 4, fontWeight: 700, color: accent ? color.fragile.fg : color.text, lineHeight: 1.1, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: font.xs, color: color.muted, marginTop: spacing.xs, fontWeight: 500 }}>
        {tileLabel}
      </div>
      {hint && (
        <div style={{ fontSize: font.xs, color: color.muted, marginTop: 2, fontWeight: 400, opacity: 0.8 }}>
          {hint}
        </div>
      )}
    </div>
  );
}
