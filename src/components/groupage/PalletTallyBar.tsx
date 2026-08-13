"use client";

import { color, font, radius, spacing } from "@/styles/tokens";
import { tallyPalletLines, type EditablePalletLine } from "@/lib/groupage/footprint-meta";

/**
 * A one-glance read of the pallet lines currently entered: how many pallets, how many
 * pallet-spaces they take on the truck (the thing groupage is priced on), and their total
 * weight — with an honest note when some pallets still have no weight (so can't be priced yet).
 *
 * Presentational only: totals come from the shared, config-driven `tallyPalletLines`, so this
 * bar can never disagree with what the quote actually charges. Renders nothing until there is
 * at least one pallet, so an empty form stays clean.
 */
export function PalletTallyBar({ lines, note }: { lines: readonly EditablePalletLine[]; note?: string }) {
  const t = tallyPalletLines(lines);
  if (t.pallets === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: spacing.sm,
        flexWrap: "wrap",
        background: color.surfaceSub,
        border: `1px solid ${color.border}`,
        borderRadius: radius.input,
        padding: `${spacing.xs}px ${spacing.sm}px`,
      }}
    >
      <Chip label="Pallets" value={String(t.pallets)} />
      <Chip label="Pallet-spaces" value={String(t.spaces)} />
      <Chip label="Total weight" value={t.weightKg > 0 ? `${t.weightKg.toLocaleString()} kg` : "—"} />
      {t.unweighedPallets > 0 && (
        <span style={{ fontSize: font.xs, color: color.review.fg, fontWeight: 600 }}>
          {t.unweighedPallets} pallet{t.unweighedPallets === 1 ? "" : "s"} still need{t.unweighedPallets === 1 ? "s" : ""} a weight
        </span>
      )}
      {note && <span style={{ fontSize: font.xs, color: color.muted, marginLeft: "auto" }}>{note}</span>}
    </div>
  );
}

/** One labelled figure — a soft pill so the numbers read as data, not prose. */
function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 5,
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.badge,
        padding: "3px 9px",
      }}
    >
      <strong style={{ fontSize: font.sm, color: color.text, fontWeight: 700 }}>{value}</strong>
      <span style={{ fontSize: font.xs, color: color.muted }}>{label}</span>
    </span>
  );
}
