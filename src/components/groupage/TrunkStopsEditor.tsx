"use client";

import { color, font, spacing, buttonSecondary } from "@/styles/tokens";
import { labelWrap, labelText, inputStyle } from "@/components/groupage/field-styles";
import type { Hub } from "@/lib/groupage/groupage.types";

/**
 * Ordered intermediate trunk stops — the hubs the shared truck calls at on its way from the origin
 * hub to the destination hub, like stops on a train line. Pallets can leave and join at each one.
 *
 * A picker, never a text box: the operator can only choose a hub that exists, that isn't already a
 * stop, and that isn't one of the two ends. Every server-side stop rejection is therefore
 * unreachable from this UI — the fail-loud guards stay as the API's own trust boundary, not as an
 * error the operator is expected to hit.
 */
export function TrunkStopsEditor({
  hubs,
  stopHubIds,
  endHubIds,
  hubsState,
  onChange,
  disabled = false,
}: {
  /** Every hub the operator may route through (saved network + this manifest's session hubs). */
  readonly hubs: readonly Hub[];
  readonly stopHubIds: readonly string[];
  /** Origin + destination hub ids, when known — never offerable as a stop. */
  readonly endHubIds: readonly string[];
  /** Load state of `hubs` — drives the "Loading hubs…" / error messaging on "Add a stop" instead of
   *  a silently-disabled button with no explanation. */
  readonly hubsState: "loading" | "ready" | "error";
  readonly onChange: (next: string[]) => void;
  readonly disabled?: boolean;
}) {
  const nameOf = (id: string) => hubs.find((h) => h.id === id)?.name ?? id;

  /** Hubs this row may choose: anything not an end hub and not already a stop elsewhere. */
  const optionsFor = (index: number) =>
    hubs.filter((h) => !endHubIds.includes(h.id) && (!stopHubIds.includes(h.id) || stopHubIds[index] === h.id));

  const firstFree = hubs.find((h) => !endHubIds.includes(h.id) && !stopHubIds.includes(h.id));

  const setAt = (index: number, id: string) => onChange(stopHubIds.map((s, i) => (i === index ? id : s)));
  const removeAt = (index: number) => onChange(stopHubIds.filter((_, i) => i !== index));
  const move = (index: number, delta: number) => {
    const next = [...stopHubIds];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  const addDisabled = disabled || !firstFree;
  const addReasonId = "trunk-stop-add-reason";
  // One reason, always rendered whenever the button is disabled — never a silent/opacity-only cue.
  const addReason = disabled
    ? "Quoting in progress."
    : hubsState === "error"
      ? "Couldn't load your hub network — only this manifest's hubs can be used as stops."
      : hubsState === "loading"
        ? "Loading hubs…"
        : !firstFree && hubs.length > 0
          ? "No other hubs left to stop at."
          : !firstFree
            ? "No hubs available to stop at yet."
            : null;

  return (
    <div style={{ ...labelWrap, marginTop: spacing.sm }}>
      <span style={labelText}>Stops on the way (optional)</span>

      {stopHubIds.length === 0 ? (
        <span style={{ fontSize: font.xs, color: color.muted }}>
          The truck runs straight from the collection hub to the destination hub. Add a stop to call at a hub in
          between — pallets can drop off and join there.
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {stopHubIds.map((id, i) => (
            <div key={id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto auto", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: font.xs, color: color.muted, minWidth: 48 }}>Stop {i + 1}</span>
              <select
                value={id}
                disabled={disabled}
                onChange={(e) => setAt(i, e.target.value)}
                aria-label={`Stop ${i + 1} hub`}
                style={inputStyle}
              >
                {optionsFor(i).map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={disabled || i === 0}
                style={iconBtnStyle(disabled || i === 0)}
                aria-label={`Move ${nameOf(id)} earlier`}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={disabled || i === stopHubIds.length - 1}
                style={iconBtnStyle(disabled || i === stopHubIds.length - 1)}
                aria-label={`Move ${nameOf(id)} later`}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeAt(i)}
                disabled={disabled}
                style={iconBtnStyle(disabled)}
                aria-label={`Remove stop ${nameOf(id)}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => firstFree && onChange([...stopHubIds, firstFree.id])}
          disabled={addDisabled}
          aria-describedby={addDisabled && addReason ? addReasonId : undefined}
          style={{ ...buttonSecondary(addDisabled), marginTop: 4 }}
        >
          Add a stop
        </button>
        {addDisabled && addReason ? (
          <span
            id={addReasonId}
            role={hubsState === "error" ? "alert" : undefined}
            style={{
              fontSize: font.xs,
              color: hubsState === "error" ? color.error : color.muted,
              marginLeft: spacing.sm,
            }}
          >
            {addReason}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Icon-sized secondary button (↑ / ↓ / Remove) — same disabled affordance as `buttonSecondary`
 *  (muted color + `cursor: not-allowed`, no opacity trick) at a tighter padding. */
function iconBtnStyle(disabled: boolean): React.CSSProperties {
  return { ...buttonSecondary(disabled), padding: "6px 10px", fontSize: font.xs, fontWeight: 600 };
}
