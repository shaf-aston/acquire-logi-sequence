"use client";

import { Fragment, useEffect, useRef } from "react";
import { th, td, color, font, spacing, radius } from "@/styles/tokens";
import type {
  ClassifiedItem,
  DurabilityTier,
  Fragility,
  OrientationLock,
  PageContent,
  RowDurabilityOverride,
  RowDurabilityView,
} from "@/types/api";

type ClassMap = Map<string, ClassifiedItem>;
type DurabilityMap = Map<string, RowDurabilityView>;

function itemKey(p: number, t: number, r: number) {
  return `${p}-${t}-${r}`;
}

type PillStyle = { bg: string; fg: string; border: string };

const FRAG_STYLE: Record<Fragility, PillStyle> = {
  fragile:   { bg: color.fragile.bg,  fg: color.fragile.fg,  border: color.fragile.border  },
  standard:  { bg: color.standard.bg, fg: color.standard.fg, border: color.standard.border },
  uncertain: { bg: color.review.bg,   fg: color.review.fg,   border: color.review.border   },
};

// Restrictive settings (a real stacking constraint) get an amber tint so the eye
// lands on them; permissive settings stay neutral. Same palette as fragility.
const RESTRICT_STYLE: PillStyle = { bg: color.review.bg, fg: color.review.fg, border: color.review.border };
const NEUTRAL_STYLE: PillStyle = { bg: color.surfaceSub, fg: color.text, border: color.border };

/** Shared shape for every pill-like control in this table (badges, selects, the stop
 *  tag) — colour comes from each caller, everything else lives here once. */
const PILL_BASE_STYLE = { borderRadius: 999, padding: "3px 10px", fontSize: font.xs, fontWeight: 600 } as const;

/**
 * Static (read-only) colour pill — the non-editable counterpart to `PillSelect` below,
 * sharing the exact same visual language so a row reads consistently whether a cell is
 * a choice or a derived fact. `note` appends a low-confidence-style annotation.
 */
function StatusBadge({ label, style, tip, note }: { label: string; style: PillStyle; tip?: string; note?: string }) {
  return (
    <span
      title={tip}
      style={{ ...PILL_BASE_STYLE, display: "inline-block", background: style.bg, color: style.fg, border: `1px solid ${style.border}` }}
    >
      {label}
      {note && <span style={{ opacity: 0.7, fontWeight: 400 }}> · {note}</span>}
    </span>
  );
}

/** Small "i" info-icon with a hover tooltip — the shared affordance for every column
 *  header that needs a plain-language explanation beyond its label. */
function InfoTip({ tip }: { tip: string }) {
  return (
    <span
      title={tip}
      aria-label={tip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        borderRadius: 999,
        border: `1px solid ${color.border}`,
        color: color.muted,
        fontSize: 9,
        fontWeight: 700,
        cursor: "help",
      }}
    >
      i
    </span>
  );
}

/** Header label + info tooltip pairing, reused by every column whose meaning needs a
 *  one-line explanation (the durability columns, "Deliver to", "Classification"). */
function HeaderLabel({ label, tip }: { label: string; tip: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {label}
      <InfoTip tip={tip} />
    </span>
  );
}

interface PillOption<T extends string> {
  value: T;
  label: string;
  style: PillStyle;
}

/**
 * The shared inline "pill" dropdown used for every editable classification in the
 * review table (Fragile/Standard and the three stacking settings). Colour comes
 * from the selected option; an optional sub-label flags low-confidence rows.
 */
function PillSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  subLabel,
}: {
  value: T;
  options: readonly PillOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  subLabel?: string;
}) {
  const { bg, fg, border } = options.find((o) => o.value === value)?.style ?? NEUTRAL_STYLE;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <select
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value as T)}
        style={{ ...PILL_BASE_STYLE, background: bg, color: fg, border: `1px solid ${border}`, cursor: "pointer" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {subLabel && <span style={{ fontSize: font.xs, color: color.muted, paddingLeft: 4 }}>{subLabel}</span>}
    </div>
  );
}

const FRAGILITY_OPTIONS: readonly PillOption<Fragility>[] = [
  { value: "fragile",   label: "Fragile",   style: FRAG_STYLE.fragile },
  { value: "standard",  label: "Standard",  style: FRAG_STYLE.standard },
  { value: "uncertain", label: "Standard?", style: FRAG_STYLE.uncertain },
];

// Plain-language labels for the three auto-derived facts that drive 3D stacking.
const TIER_OPTIONS: readonly PillOption<DurabilityTier>[] = [
  { value: "none",   label: "Nothing on top", style: RESTRICT_STYLE },
  { value: "low",    label: "Light loads",    style: NEUTRAL_STYLE },
  { value: "medium", label: "Medium loads",   style: NEUTRAL_STYLE },
  { value: "high",   label: "Heavy loads",    style: NEUTRAL_STYLE },
];

const ORIENTATION_OPTIONS: readonly PillOption<OrientationLock>[] = [
  { value: "fixed",   label: "This way up",  style: RESTRICT_STYLE },
  { value: "partial", label: "Keep upright", style: NEUTRAL_STYLE },
  { value: "none",    label: "Any way",      style: NEUTRAL_STYLE },
];

const BRITTLE_OPTIONS: readonly PillOption<"yes" | "no">[] = [
  { value: "yes", label: "Brittle",     style: FRAG_STYLE.fragile },
  { value: "no",  label: "Not brittle", style: NEUTRAL_STYLE },
];

function FragilitySelect({ value, confident, onChange }: { value: Fragility; confident: boolean; onChange: (v: Fragility) => void }) {
  return (
    <PillSelect
      value={value}
      options={FRAGILITY_OPTIONS}
      onChange={onChange}
      ariaLabel="Classification"
      subLabel={!confident ? "low confidence" : undefined}
    />
  );
}

interface DurabilityColumn {
  label: string;
  tip: string;
  minWidth: number;
}

type DurabilityKey = "tier" | "orientation" | "brittle" | "deformable";

/** Single source of truth for the four stacking columns — label, tooltip, and column
 *  width. Read by the header row, the empty-row placeholder, `DurabilityCells`, and the
 *  section-band colspan math below, so adding/removing a column means editing ONE object
 *  instead of four places staying in sync by hand. Keyed by name (not array position) so
 *  `TIER_COL` etc below can never end up bound to the wrong column if entries are reordered. */
const DURABILITY_COLUMNS: Record<DurabilityKey, DurabilityColumn> = {
  tier:        { label: "On-top load", minWidth: 128, tip: "How much weight may be stacked on top of this item. Edit if the automatic guess looks wrong — it changes the load plan." },
  orientation: { label: "Orientation", minWidth: 128, tip: "Which way the item may be turned when loaded. 'This way up' = keep exactly as-is; 'Any way' = free to rotate." },
  brittle:     { label: "Brittle",     minWidth: 120, tip: "Brittle items (glass, ceramic, stone) can still have light things stacked on them, but their safe load is cut hard — much less than a normal item of the same tier." },
  deformable:  { label: "Deformable",  minWidth: 140, tip: "Whether this item is soft/crushable, so it deforms under load and won't hold a clean stack. 'Yes' = soft/crushable, sits on the floor with nothing on top; 'Floor-only' = firm but still can't be placed on top of others; 'No' = firm, stacks cleanly." },
};
// Iteration order for the header row and empty-row placeholder — derived from the object's
// own key order (spec-guaranteed for string keys), so there is no separate list to keep in sync.
const DURABILITY_KEYS = Object.keys(DURABILITY_COLUMNS) as DurabilityKey[];
const { tier: TIER_COL, orientation: ORIENTATION_COL, brittle: BRITTLE_COL, deformable: DEFORMABLE_COL } = DURABILITY_COLUMNS;

/**
 * Why a row's stacking facts are absent. The four On-top/Orientation/Brittle/Deformable
 * columns are fed ONLY by the load-plan calculation (`packResult`), so "no facts" has
 * several distinct causes that must NOT collapse into one silent "…":
 *  - "packing" — the pack is genuinely in flight (transient, legitimate)
 *  - "skipped" — a groupage/hub manifest deliberately skips the per-item packer
 *                (page.tsx: `runPack` is not called for hub manifests)
 *  - "error"   — the pack request failed; the reason is surfaced, not hidden
 *  - "pending" — a document is loaded but no pack has started yet
 *  - "ready"   — the pack succeeded; if facts are STILL missing for a classified row
 *                that is a real defect, shown loudly rather than as an innocent "…"
 */
export type DurabilityStatus = "ready" | "packing" | "skipped" | "error" | "pending";

/** `durabilityStatus` bundled with the one status ("error") that carries extra detail —
 *  a single prop instead of two, so a detail can never travel without its status. */
export type DurabilityStatusInfo = { kind: DurabilityStatus; detail?: string };

const DURABILITY_STATUS_VIEW: Record<DurabilityStatus, { tag: string; text: string; style: PillStyle | null }> = {
  packing: { tag: "Calculating…", text: "working out the load plan", style: null },
  pending: { tag: "Not calculated yet", text: "no load plan has been run for this cargo", style: null },
  skipped: {
    tag: "Not packed",
    text: "groupage/hub manifest — quoted from its pallet roster in the shared-truck planner, so per-item stacking isn't calculated here",
    style: RESTRICT_STYLE,
  },
  error: {
    tag: "Load plan failed",
    text: "the packer could not calculate a load plan — stacking facts are unavailable",
    style: FRAG_STYLE.fragile,
  },
  // Pack succeeded but this classified row has no facts — a real bug, never silent.
  ready: {
    tag: "Missing stacking data",
    text: "this classified row returned no pack facts — this should not happen; check the packer output for this row",
    style: FRAG_STYLE.fragile,
  },
};

/** Honest stand-in for the four stacking columns when a row has no pack facts — spans
 *  them with one labeled reason (via `StatusBadge`), never a silent, unexplained "…". */
function DurabilityPending({ status }: { status: DurabilityStatusInfo }) {
  const { tag, text, style } = DURABILITY_STATUS_VIEW[status.kind];
  const message = status.kind === "error" && status.detail ? status.detail : text;
  return (
    <td colSpan={DURABILITY_KEYS.length} style={{ ...td, whiteSpace: "normal" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <StatusBadge label={tag} style={style ?? NEUTRAL_STYLE} tip={message} />
        <span style={{ fontSize: font.xs, color: color.muted }}>{message}</span>
      </span>
    </td>
  );
}

/** The four stacking-fact cells for one cargo row (three editable, one derived). */
function DurabilityCells({
  facts,
  status,
  onSet,
}: {
  facts: RowDurabilityView | undefined;
  /** Why facts may be absent — drives the labeled stand-in instead of a silent "…". */
  status: DurabilityStatusInfo;
  onSet: (patch: Partial<RowDurabilityOverride>) => void;
}) {
  // No facts yet — show WHY (packing / skipped / error / missing), never a bare "…".
  if (!facts) {
    return <DurabilityPending status={status} />;
  }
  return (
    <>
      <td style={{ ...td, minWidth: TIER_COL.minWidth }}>
        <PillSelect
          value={facts.durabilityTier}
          options={TIER_OPTIONS}
          onChange={(v) => onSet({ durabilityTier: v })}
          ariaLabel={TIER_COL.label}
          subLabel={!facts.confident ? "low confidence" : undefined}
        />
      </td>
      <td style={{ ...td, minWidth: ORIENTATION_COL.minWidth }}>
        <PillSelect
          value={facts.orientationLock}
          options={ORIENTATION_OPTIONS}
          onChange={(v) => onSet({ orientationLock: v })}
          ariaLabel={ORIENTATION_COL.label}
          subLabel={!facts.confident ? "low confidence" : undefined}
        />
      </td>
      <td style={{ ...td, minWidth: BRITTLE_COL.minWidth }}>
        <PillSelect
          value={facts.brittle ? "yes" : "no"}
          options={BRITTLE_OPTIONS}
          onChange={(v) => onSet({ brittle: v === "yes" })}
          ariaLabel={BRITTLE_COL.label}
          subLabel={!facts.confident ? "low confidence" : undefined}
        />
      </td>
      <td style={{ ...td, minWidth: DEFORMABLE_COL.minWidth }}>
        <DeformableStatus stackable={facts.stackable} deformable={facts.deformable} confident={facts.confident} />
      </td>
    </>
  );
}

/**
 * Read-only "Deformable" status: is this item soft/crushable, so it deforms under load?
 * Derived, not editable — it flows from the item's material/geometry, not an operator
 * choice. A deformable item won't hold a clean stack (nothing rests on it, it isn't a
 * base). The rare non-deformable-but-still-floor-only case is surfaced as "Floor-only"
 * so the reason an item sits on the floor is visible here, not only mid-drag in the 3D view.
 */
function DeformableStatus({ stackable, deformable, confident }: { stackable?: boolean; deformable?: boolean; confident?: boolean }) {
  // Facts not populated until the first pack returns.
  if (stackable == null && deformable == null) {
    return <span style={{ color: color.muted }}>…</span>;
  }
  const { label, style, tip } = deformable
    ? { label: "Yes", style: RESTRICT_STYLE, tip: "Soft or crushable — it deforms under load, so nothing is stacked on it and it isn't used as a base." }
    : stackable === false
      ? { label: "Floor-only", style: RESTRICT_STYLE, tip: "Not deformable, but must still sit on the van floor — it can't be placed on top of another item." }
      : { label: "No", style: NEUTRAL_STYLE, tip: "Firm — holds its shape under load, so it stacks cleanly." };
  // confident === false: no Material text matched a known keyword (or the classifier
  // failed), so this is a conservative fallback guess, not a confirmed fact — same
  // "low confidence" signal shown on the editable pills above.
  const uncertain = confident === false;
  return (
    <StatusBadge
      label={label}
      style={style}
      tip={uncertain ? `${tip} (low confidence — material wasn't recognised, this is a conservative default)` : tip}
      note={uncertain ? "low confidence" : undefined}
    />
  );
}

/** Auto-sizing textarea — grows vertically to show full content, no scroll. */
function AutoTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        e.target.style.height = "auto";
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
      style={{
        width: "100%",
        boxSizing: "border-box",
        border: `1px solid ${color.border}`,
        borderRadius: 6,
        padding: "4px 6px",
        font: "inherit",
        color: color.text,
        background: color.surfaceSub,
        resize: "none",
        overflow: "hidden",
        minHeight: 28,
        display: "block",
        lineHeight: "1.5",
      }}
    />
  );
}

function clean(cell: string): string {
  return cell.replace(/\*\*/g, "").trim();
}

export type StopSection = { label: string; rows: { row: string[]; r: number }[]; subtotal?: string };

/**
 * Split a cargo table's flat rows into per-stop sections for multi-drop manifests.
 * Such manifests list every drop in ONE table with "STOP n —…" and "Sub-total Stop n"
 * sitting inline as ordinary rows. This lifts the marker row into a section HEADING (so it
 * no longer reads as a bare data row), groups cargo under its assigned stop — the Stop-column
 * attribution in `stopByItemId`, falling back to the running marker index — and turns the
 * sub-total into a section footer. Returns a single entry when the table has no multi-stop
 * structure, so the caller renders one plain table unchanged (no single-stop regression).
 */
export function stopSections(
  page: PageContent,
  table: PageContent["tables"][number],
  classMap: ClassMap,
  stopByItemId?: Map<string, number>,
): StopSection[] {
  const secs: StopSection[] = [];
  const byIndex = new Map<number, StopSection>();
  const ensure = (idx: number, label: string): StopSection => {
    let s = byIndex.get(idx);
    if (!s) {
      s = { label, rows: [] };
      byIndex.set(idx, s);
      secs.push(s);
    }
    return s; // first label wins — a rich marker label is never overwritten by a plain "Stop N"
  };
  let running = 0;
  table.rows.forEach((row, r) => {
    const key = itemKey(page.index, table.index, r);
    const text = clean(row.join(" "));
    const marker = /^STOP\s+(\d+)\b/i.exec(text);
    if (marker) {
      running = Number(marker[1]) - 1;
      ensure(running, text); // e.g. "STOP 2 — Midlands Wholesale Co. (Northampton, via BHM Hub)"
      return; // heading row — dropped from the data rows
    }
    if (/\bsub-?total\b/i.test(text)) {
      ensure(running, `Stop ${running + 1}`).subtotal = text;
      return; // footer row — dropped from the data rows
    }
    const idx = classMap.has(key) ? stopByItemId?.get(key) ?? running : running;
    ensure(idx, `Stop ${idx + 1}`).rows.push({ row, r });
  });
  return secs;
}

interface Props {
  pages: PageContent[];
  classMap: ClassMap;
  /** Effective stacking facts per row (keyed by `${page}-${table}-${row}`); empty until the first pack returns. */
  durabilityByKey: DurabilityMap;
  /** Why the stacking columns may be empty for a row with no facts yet — drives a
   *  labeled stand-in instead of a silent "…" (see `DurabilityStatus`). */
  durabilityStatus: DurabilityStatusInfo;
  /** When false, cell inputs and add-row are hidden; the classification/stacking selects are always visible. */
  editing: boolean;
  onCellChange: (pageIndex: number, tableIndex: number, rowIndex: number, colIndex: number, value: string) => void;
  onSetFragility: (pageIndex: number, tableIndex: number, rowIndex: number, value: Fragility) => void;
  onSetDurability: (pageIndex: number, tableIndex: number, rowIndex: number, patch: Partial<RowDurabilityOverride>) => void;
  onAddRow: (pageIndex: number, tableIndex: number) => void;
  /** Multi-stop: when true, a "Deliver to" column lets the operator tag each item to a drop. */
  stopMode?: boolean;
  /** Number of drop-off stops the item may be tagged to (drops only, pickup excluded). */
  dropCount?: number;
  /** item key (`${page}-${table}-${row}`) → 0-based drop index. Untagged items default to Drop 1. */
  stopByItemId?: Map<string, number>;
  onSetStop?: (pageIndex: number, tableIndex: number, rowIndex: number, dropIndex: number) => void;
}

// Single source of truth for the "Deliver to" column width — read by both the header
// cell and the data cell, so the two can't drift apart the way the durability columns once did.
const STOP_COL_WIDTH = 110;

/** The per-row drop-off tag (multi-stop only) — which stop this item is delivered to. */
function StopSelect({ value, dropCount, onChange }: { value: number; dropCount: number; onChange: (v: number) => void }) {
  const safe = value < dropCount ? value : 0;
  return (
    <select
      value={String(safe)}
      aria-label="Deliver to stop"
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ ...PILL_BASE_STYLE, background: color.surfaceSub, color: color.text, border: `1px solid ${color.border}`, cursor: "pointer" }}
    >
      {Array.from({ length: Math.max(1, dropCount) }, (_, i) => (
        <option key={i} value={String(i)}>Drop {i + 1}</option>
      ))}
    </select>
  );
}

// Frozen-edge styling: header row, the "#" column (left) and the Classification
// column (right) stay visible while the middle scrolls. Sticky cells need an
// opaque background or scrolled content shows through them.
const stickyHeadBase = { position: "sticky" as const, top: 0, zIndex: 2 };
const stickyLeftCell = {
  position: "sticky" as const,
  left: 0,
  zIndex: 1,
  background: color.surface,
};
const stickyRightCell = {
  position: "sticky" as const,
  right: 0,
  zIndex: 1,
  background: color.surface,
};

export function ResultTables({
  pages,
  classMap,
  durabilityByKey,
  durabilityStatus,
  editing,
  onCellChange,
  onSetFragility,
  onSetDurability,
  onAddRow,
  stopMode = false,
  dropCount = 1,
  stopByItemId,
  onSetStop,
}: Props) {
  const tables = pages.flatMap((page) =>
    page.tables.map((table) => {
      const classifiedCount = table.rows.filter((_, r) =>
        classMap.has(itemKey(page.index, table.index, r)),
      ).length;
      return { page, table, isItemTable: classifiedCount > 0, classifiedCount };
    }),
  );

  if (tables.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: spacing.sm,
          padding: `${spacing.xxl}px ${spacing.xl}px`,
          background: color.surfaceSub,
          borderRadius: radius.card,
          border: `1px dashed ${color.border}`,
          textAlign: "center",
        }}
      >
        {/* UX fix H10: descriptive empty state */}
        <svg
          aria-hidden="true"
          width={32}
          height={32}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color.muted}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="3" y1="15" x2="21" y2="15" />
          <line x1="9" y1="9" x2="9" y2="21" />
        </svg>
        <p style={{ fontSize: font.md, fontWeight: 600, color: color.text, margin: 0 }}>
          No tables found
        </p>
        <p style={{ fontSize: font.base, color: color.muted, margin: 0, maxWidth: 340 }}>
          Ensure the PDF contains a cargo or goods table with recognisable column headers (e.g.
          &ldquo;Item&rdquo;, &ldquo;Description&rdquo;, &ldquo;Qty&rdquo;).
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.lg }}>
      {tables.map(({ page, table, isItemTable, classifiedCount }) => {
        // Multi-drop: split the flat cargo rows into per-stop sections (one entry ⇒ plain table).
        const sections = isItemTable && stopMode ? stopSections(page, table, classMap, stopByItemId) : [];
        const segmented = sections.length > 1;
        // Full-width span for a section heading/footer band: #-col + source cols + durability
        // columns + stop(1) + classification(1).
        const bandColSpan =
          1 + table.headers.length + (isItemTable ? DURABILITY_KEYS.length : 0) + (isItemTable && stopMode ? 1 : 0) + (isItemTable ? 1 : 0);
        const renderCargoRow = (row: string[], r: number) => {
          const item = classMap.get(itemKey(page.index, table.index, r));
          return (
            <tr key={r}>
              <td style={{ ...td, ...stickyLeftCell, color: color.muted }}>{r + 1}</td>
              {row.map((cell, c) => (
                <td
                  key={c}
                  style={{
                    ...td,
                    minWidth: 120,
                    whiteSpace: "normal",
                    wordBreak: "break-word",
                  }}
                >
                  {isItemTable && editing ? (
                    <AutoTextarea
                      value={cell}
                      onChange={(v) => onCellChange(page.index, table.index, r, c, v)}
                    />
                  ) : (
                    clean(cell)
                  )}
                </td>
              ))}
              {isItemTable &&
                (item ? (
                  <DurabilityCells
                    facts={durabilityByKey.get(itemKey(page.index, table.index, r))}
                    status={durabilityStatus}
                    onSet={(patch) => onSetDurability(page.index, table.index, r, patch)}
                  />
                ) : (
                  <>
                    {DURABILITY_KEYS.map((key) => (
                      <td key={key} style={{ ...td, minWidth: DURABILITY_COLUMNS[key].minWidth }} />
                    ))}
                  </>
                ))}
              {isItemTable && stopMode && (
                <td style={{ ...td, minWidth: STOP_COL_WIDTH }}>
                  {item && (
                    <StopSelect
                      value={stopByItemId?.get(itemKey(page.index, table.index, r)) ?? 0}
                      dropCount={dropCount}
                      onChange={(v) => onSetStop?.(page.index, table.index, r, v)}
                    />
                  )}
                </td>
              )}
              {isItemTable && (
                <td style={{ ...td, ...stickyRightCell }}>
                  {item && (
                    <FragilitySelect
                      value={item.fragility}
                      confident={item.confident}
                      onChange={(v) => onSetFragility(page.index, table.index, r, v)}
                    />
                  )}
                </td>
              )}
            </tr>
          );
        };
        return (
        <div key={`${page.index}-${table.index}`}>
          {/* Table meta label */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.sm,
              marginBottom: spacing.sm,
            }}
          >
            <span
              style={{
                fontSize: font.xs,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.07em",
                color: color.muted,
              }}
            >
              Page {page.index + 1} · Table {table.index + 1}
            </span>
            <span
              style={{
                fontSize: font.xs,
                background: isItemTable ? color.accentMuted : color.surfaceHover,
                color: isItemTable ? color.accentDark : color.muted,
                border: `1px solid ${isItemTable ? color.accentBorder : color.border}`,
                borderRadius: 999,
                padding: "1px 8px",
                fontWeight: 500,
              }}
            >
              {isItemTable
                ? `cargo · ${classifiedCount} item${classifiedCount !== 1 ? "s" : ""}`
                : "document details"}
            </span>
          </div>

          {/* Table — scrolls in both axes; header and edge columns stay frozen */}
          <div
            style={{
              maxHeight: "70vh",
              overflow: "auto",
              borderRadius: radius.card,
              border: `1px solid ${isItemTable && editing ? color.accent : color.border}`,
              boxShadow: isItemTable && editing ? `0 0 0 3px ${color.accentMuted}` : undefined,
              transition: "border-color 0.15s, box-shadow 0.15s",
            }}
          >
            <table
              style={{
                borderCollapse: "collapse",
                fontSize: font.base,
                width: "100%",
                background: color.surface,
              }}
            >
              <thead>
                <tr>
                  <th
                    scope="col"
                    style={{
                      ...th,
                      ...stickyHeadBase,
                      left: 0,
                      zIndex: 3,
                      width: 44,
                      fontWeight: 400,
                      textTransform: "none",
                      letterSpacing: 0,
                      opacity: 0.5,
                    }}
                  >
                    #
                  </th>
                  {table.headers.map((h, i) => (
                    <th key={i} scope="col" style={{ ...th, ...stickyHeadBase }}>
                      {clean(h)}
                    </th>
                  ))}
                  {isItemTable && DURABILITY_KEYS.map((key) => (
                    <th key={key} scope="col" style={{ ...th, ...stickyHeadBase, minWidth: DURABILITY_COLUMNS[key].minWidth }}>
                      <HeaderLabel label={DURABILITY_COLUMNS[key].label} tip={DURABILITY_COLUMNS[key].tip} />
                    </th>
                  ))}
                  {isItemTable && stopMode && (
                    <th key="stop-head" scope="col" style={{ ...th, ...stickyHeadBase, minWidth: STOP_COL_WIDTH }}>
                      <HeaderLabel
                        label="Deliver to"
                        tip="Which drop-off this item is delivered to. The van is packed so the last drop sits deepest and the first drop is by the doors."
                      />
                    </th>
                  )}
                  {isItemTable && (
                    <th
                      scope="col"
                      style={{ ...th, ...stickyHeadBase, right: 0, zIndex: 3, width: 150 }}
                    >
                      <HeaderLabel
                        label="Classification"
                        tip="Auto-classified from the description. In edit mode, 'Override' flips an item between fragile and standard if the guess is wrong."
                      />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {segmented
                  ? sections.map((sec, si) => (
                      <Fragment key={`stop-${si}`}>
                        {/* Per-stop heading band — the drop's own "table" starts here */}
                        <tr>
                          <td
                            colSpan={bandColSpan}
                            style={{
                              ...td,
                              background: color.accentMuted,
                              color: color.accentDark,
                              fontWeight: 700,
                              fontSize: font.sm,
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                              borderTop: si === 0 ? undefined : `2px solid ${color.accent}`,
                            }}
                          >
                            {clean(sec.label)}
                          </td>
                        </tr>
                        {sec.rows.map(({ row, r }) => renderCargoRow(row, r))}
                        {sec.subtotal && (
                          <tr>
                            <td
                              colSpan={bandColSpan}
                              style={{
                                ...td,
                                color: color.muted,
                                fontStyle: "italic",
                                background: color.surfaceSub,
                              }}
                            >
                              {clean(sec.subtotal)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))
                  : table.rows.map((row, r) => renderCargoRow(row, r))}
              </tbody>
            </table>
          </div>

          {/* Add-row — edit mode, cargo tables only */}
          {isItemTable && editing && (
            <button
              type="button"
              onClick={() => onAddRow(page.index, table.index)}
              style={{
                marginTop: spacing.sm,
                border: `1px dashed ${color.border}`,
                background: color.surfaceSub,
                color: color.accentDark,
                borderRadius: radius.button,
                padding: "6px 12px",
                fontSize: font.sm,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              + Add row
            </button>
          )}
        </div>
        );
      })}
    </div>
  );
}
