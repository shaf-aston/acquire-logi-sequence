"use client";

import { useEffect, useMemo, useState } from "react";
import { Van3DViewer, packedItemToItem } from "@/components/results/Van3DViewer";
import type { PackedItem, Placement, UnplacedItem, VanDimensions } from "@/types/api";
import type { PalletFootprintClass } from "@/lib/groupage/groupage.types";
import { HeuristicPacker } from "@/lib/packing/heuristic-packer";
import type { Item, Van as PackerVan } from "@/lib/packing/packing.types";
import { buttonSecondary, color, font, spacing } from "@/styles/tokens";
import palletSpec from "../../../config/pallet-spec.json";

/**
 * Stacks an order's LEFTOVER items (the ones the main-van pack couldn't fit) onto pallets,
 * sized to how many the order actually needs. It reuses the whole-van Van3DViewer with a
 * pallet-sized container (a pallet is just a small container), so drag-from-tray, rotate,
 * the smooth cursor drag, and the flagged "never guess" surface all come for free.
 *
 * WHY multiple pallets: a real order rarely fits one pallet. When items exceed a pallet, a
 * new one appears; each pallet fills before the next starts (the packer's own vertical fill),
 * and all pallets of the same order sit together in one view. Stack height is capped by the
 * VEHICLE that will carry them (B1) — never taller than the pallet's own usable height.
 *
 * Visualisation + opt-in quote only: it prices nothing until the operator clicks "Use these
 * pallets", and a forced/flagged (amber) placement blocks that until it's cleared.
 *
 * Only unplaced items with a known size may be stacked — an item with no dimensions can't be
 * placed in a 3D box, so it's excluded up front.
 */

const MM_PER_M = 1000;
// Clearance slack — the SAME default Van3DViewer validates with, kept in one place so the
// auto-fill packer and the interactive editors below never disagree.
const PACK_TOLERANCE_M = 0.005;
// Safety cap: a pathological item too big to ever fit a pallet must not spin auto-fill forever.
const MAX_PALLETS = 40;

// The standard pallet footprint + its own usable stacking height (config, mm → m).
const PALLET_BASE = {
  l: palletSpec.standardPallet.lengthMm / MM_PER_M,
  w: palletSpec.standardPallet.widthMm / MM_PER_M,
  usableH: palletSpec.standardPallet.usableHeightMm / MM_PER_M,
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function GroupagePalletBuilder({
  unplaced,
  itemById,
  maxStackHeightM,
  onUsePallet,
}: {
  unplaced: UnplacedItem[];
  itemById: Map<string, PackedItem>;
  /** Cap the stack height to the vehicle that will carry the pallets (B1). Falls back to the
   *  pallet's own usable height when no vehicle context is known. */
  maxStackHeightM?: number;
  /** Fold ONE built pallet into the quote as a full-footprint pallet line weighing the sum of
   *  its stacked items. Called once per non-empty pallet by "Use these pallets". Opt-in. */
  onUsePallet?: (pallet: { footprint: PalletFootprintClass; weightKg: number; quantity: number }) => void;
}) {
  // The pallet interior: standard footprint, height capped by the carrying vehicle but never
  // above the pallet's own usable height. Recomputed only when the vehicle cap changes.
  const palletInterior = useMemo<VanDimensions>(
    () => ({
      l: PALLET_BASE.l,
      w: PALLET_BASE.w,
      h: Math.min(PALLET_BASE.usableH, maxStackHeightM ?? PALLET_BASE.usableH),
    }),
    [maxStackHeightM],
  );
  const cappedByVehicle = maxStackHeightM != null && maxStackHeightM < PALLET_BASE.usableH;

  // One entry per pallet, holding that pallet's placements. Starts with a single empty pallet.
  const [pallets, setPallets] = useState<Placement[][]>([[]]);
  // Cleared whenever the layout changes, so the "added ✓" note only follows a fresh click.
  const [justUsed, setJustUsed] = useState(false);
  useEffect(() => setJustUsed(false), [pallets]);

  // Only items with a known size can enter a 3D model.
  const palletable = useMemo(
    () => unplaced.filter((u) => itemById.get(u.id)?.dimensions != null),
    [unplaced, itemById],
  );

  // Shared tray — DERIVED from every pallet: each palletable item's remaining count is its
  // quantity minus how many are stacked across ALL pallets. One source of truth, so placing or
  // popping an item on any pallet can never desync the tray from the models.
  const tray = useMemo<UnplacedItem[]>(() => {
    const placed = new Map<string, number>();
    for (const pallet of pallets) for (const p of pallet) placed.set(p.itemId, (placed.get(p.itemId) ?? 0) + 1);
    return palletable
      .map((u) => ({ ...u, quantity: u.quantity - (placed.get(u.id) ?? 0) }))
      .filter((u) => u.quantity > 0);
  }, [palletable, pallets]);

  // Any flagged (forced/invalid) placement anywhere blocks folding into the quote — a bad
  // arrangement must never price. The amber banner inside each viewer says why.
  const anyFlagged = useMemo(() => pallets.some((pallet) => pallet.some((p) => p.flagged)), [pallets]);

  // Nothing stackable ⇒ don't render an empty builder (the summary above already says so).
  if (palletable.length === 0) return null;

  const totalPalletable = palletable.reduce((n, u) => n + u.quantity, 0);
  const totalPlaced = pallets.reduce((n, pallet) => n + pallet.length, 0);
  const nonEmpty = pallets.filter((pallet) => pallet.length > 0);
  const lastIndex = pallets.length - 1;
  const palletWeight = (pallet: Placement[]) => pallet.reduce((n, p) => n + p.weightKg, 0);
  const namesFor = (pallet: Placement[]) => pallet.map((p) => itemById.get(p.itemId)?.name ?? p.itemId);

  const setPalletAt = (i: number) => (next: Placement[]) =>
    setPallets((prev) => prev.map((pallet, j) => (j === i ? next : pallet)));

  const addPallet = () => setPallets((prev) => [...prev, []]);

  // One-click "size to demand": pack ALL palletable items into as few pallets as fit, filling
  // each before the next starts (the packer's own vertical fill), so a big order lands as N
  // grouped pallets automatically. Reuses the exact packer the editors use. Items too big for
  // any pallet stay in the shared tray (derived) — visible, never silently dropped.
  const autoFill = () => {
    const container: PackerVan = { id: "pallet", label: "Pallet", interior: palletInterior, maxPayloadKg: Number.POSITIVE_INFINITY, perMileRate: 0 };
    let pool: Item[] = palletable
      .map((u) => {
        const pi = itemById.get(u.id);
        return pi && pi.dimensions != null ? packedItemToItem(pi, u.quantity) : null;
      })
      .filter((it): it is Item => it !== null);
    const packer = new HeuristicPacker({ toleranceM: PACK_TOLERANCE_M });
    const built: Placement[][] = [];
    while (pool.length > 0 && built.length < MAX_PALLETS) {
      const result = packer.pack(pool, container);
      if (result.placements.length === 0) break; // nothing fit — remaining items exceed a pallet
      built.push(result.placements);
      pool = result.unplaced;
    }
    setPallets(built.length > 0 ? built : [[]]);
  };

  const useAllPallets = () => {
    if (!onUsePallet) return;
    // One full-footprint line per non-empty pallet; useBuiltPallet's functional updater composes
    // the N appends. Blocked while anything is flagged (guarded on the button too).
    for (const pallet of nonEmpty) {
      onUsePallet({ footprint: "full", weightKg: round1(palletWeight(pallet)), quantity: 1 });
    }
    setJustUsed(true);
  };

  const totalKg = round1(nonEmpty.reduce((n, pallet) => n + palletWeight(pallet), 0));
  // Offer a fresh pallet only once the current last one has something on it AND items remain.
  const canAddPallet = tray.length > 0 && pallets[lastIndex]!.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: spacing.sm, flexWrap: "wrap" }}>
        <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>Stack leftover items onto pallets</span>
        <span style={{ fontSize: font.xs, color: color.muted }}>
          {totalPlaced} of {totalPalletable} stacked · {nonEmpty.length} pallet{nonEmpty.length === 1 ? "" : "s"}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.4 }}>
        Standard pallet — {PALLET_BASE.l.toFixed(1)} × {PALLET_BASE.w.toFixed(1)} m, stack to {palletInterior.h.toFixed(1)} m
        {cappedByVehicle ? " (capped by vehicle height)" : ""}. Drag a leftover item from the tray onto a pallet, or fill
        automatically. A new pallet appears when the current one is full.
      </p>

      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
        <button type="button" onClick={autoFill} style={{ ...buttonSecondary(false), borderColor: color.accent, color: color.accent }}>
          ⤓ Auto-fill pallets ({totalPalletable})
        </button>
        {canAddPallet && (
          <button type="button" onClick={addPallet} style={buttonSecondary(false)}>
            + New pallet
          </button>
        )}
      </div>

      {pallets.map((pallet, i) => (
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: spacing.sm }}>
            <span style={{ fontSize: font.xs, fontWeight: 600, color: color.textSub }}>
              Pallet {i + 1}
              {i === lastIndex && pallet.length === 0 ? " (new)" : ""}
            </span>
            <span style={{ fontSize: font.xs, color: color.muted }}>
              {pallet.length} item{pallet.length === 1 ? "" : "s"}
              {pallet.length > 0 ? ` · ${Math.round(palletWeight(pallet))} kg` : ""}
            </span>
          </div>
          <Van3DViewer
            placements={pallet}
            interior={palletInterior}
            itemNames={namesFor(pallet)}
            heightPx={280}
            editable
            toleranceM={PACK_TOLERANCE_M}
            onPlacementsChange={setPalletAt(i)}
            itemById={itemById}
            unplaced={i === lastIndex ? tray : []}
            onUnplace={(idx) =>
              setPallets((prev) => prev.map((pl, j) => (j === i ? pl.filter((_, k) => k !== idx) : pl)))
            }
            unplacedCollapsed={false}
          />
        </div>
      ))}

      {/* Opt-in: fold the built pallets into the quote as full pallet lines. */}
      {onUsePallet && nonEmpty.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
          <button type="button" onClick={useAllPallets} disabled={anyFlagged} style={buttonSecondary(anyFlagged)}>
            Use {nonEmpty.length === 1 ? "this pallet" : "these pallets"} in the quote ({nonEmpty.length} full pallet
            {nonEmpty.length === 1 ? "" : "s"} · {Math.round(totalKg)} kg)
          </button>
          {anyFlagged && (
            <span style={{ fontSize: font.xs, color: color.warning }}>
              Resolve the flagged (amber) placements first — a forced arrangement can’t be priced.
            </span>
          )}
          {justUsed && !anyFlagged && (
            <span style={{ fontSize: font.xs, color: color.success }}>Added to the pallet lines below ✓</span>
          )}
        </div>
      )}
    </div>
  );
}
