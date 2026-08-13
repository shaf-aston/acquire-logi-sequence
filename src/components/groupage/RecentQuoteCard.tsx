"use client";

import { color, font, radius } from "@/styles/tokens";
import type { GroupageConsignmentRecord } from "@/lib/groupage/consignment.store";

/**
 * One remembered-quote card in the "Add from recent quotes" sidebar — a tickable, stacked two-line
 * summary of a previously priced consignment. Presentational only; the parent owns selection state.
 *
 * Layout is deliberately stacked (name + pallet-count on line 1, muted route · date on line 2) rather
 * than a single horizontal row: the sidebar is a narrow "small part" column, so a horizontal row of
 * name/route/pallets/date wraps every field 3–4 lines. Kept as its own component so the card can be
 * reused (e.g. a future "pick consignments" picker) without copying the layout, and so the 3D planner
 * host stays readable.
 */

/** Company name, or the route when the quote was priced anonymously (no company captured). */
const recordLabel = (r: GroupageConsignmentRecord): string =>
  r.company && r.company.trim() !== "" ? r.company : `${r.originPostcode} → ${r.destinationPostcode}`;

/** Compact "7 Jul" date — the year is noise (every remembered quote is recent) and the full ISO
 *  string forces the meta row to wrap. Falls back to the raw date on any parse failure so a
 *  malformed timestamp is shown, never swallowed. */
const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/**
 * Why a quote can't join a shared truck, or null when it can. The planner stacks ONE leg per
 * consignment, so a trunk that calls at stops has no single shared leg — `primaryLeg` rejects it
 * loudly. Saying so here, on the card, is the honest place: an un-tickable row with a reason beats
 * a tick that detonates the whole plan (and every other company in it) at "Plan" time.
 */
const blockedReason = (r: GroupageConsignmentRecord): string | null => {
  const stops = r.trunkStopHubIds?.length ?? 0;
  if (stops === 0) return null;
  return `Calls at ${stops} stop${stops === 1 ? "" : "s"} on the way — a stopping trunk can't share a truck, because what's on board changes at each stop. Re-quote it without stops to plan it.`;
};

export function RecentQuoteCard({
  record,
  checked,
  onToggle,
}: {
  record: GroupageConsignmentRecord;
  checked: boolean;
  onToggle: () => void;
}) {
  const palletCount = record.pallets.reduce((n, p) => n + p.quantity, 0);
  const blocked = blockedReason(record);
  const reasonId = blocked ? `recent-blocked-${record.id}` : undefined;
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        background: color.surfaceSub,
        border: `1px solid ${color.border}`,
        borderRadius: radius.input,
        padding: "8px 10px",
        cursor: blocked ? "not-allowed" : "pointer",
        opacity: blocked ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked && !blocked}
        onChange={onToggle}
        disabled={Boolean(blocked)}
        aria-describedby={reasonId}
        style={{ flex: "0 0 auto", marginTop: 3 }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6 }}>
          <strong style={{ fontSize: font.sm, color: color.text, lineHeight: 1.3 }}>{recordLabel(record)}</strong>
          <span style={{ flex: "0 0 auto", fontSize: font.xs, fontWeight: 600, color: color.accentDark, whiteSpace: "nowrap" }}>
            {palletCount} {palletCount === 1 ? "pallet" : "pallets"}
          </span>
        </div>
        <span style={{ fontSize: font.xs, color: color.muted, lineHeight: 1.3 }}>
          {record.originPostcode} → {record.destinationPostcode} · {shortDate(record.createdAt)}
        </span>
        {blocked && (
          <span id={reasonId} style={{ fontSize: font.xs, color: color.warning, lineHeight: 1.3 }}>
            {blocked}
          </span>
        )}
      </div>
    </label>
  );
}
