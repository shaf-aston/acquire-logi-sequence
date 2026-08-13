"use client";

import { color, font, radius, spacing } from "@/styles/tokens";
import { SendQuoteButton } from "@/components/results/SendQuoteButton";
import { lineItemsForLeg, legTotal } from "@/lib/groupage/billing-legs";
import type { CompanyBill } from "@/components/groupage/useCompanyBills";

/**
 * Final billing for a shared-truck load: one line PER COMPANY (each is a separate customer paying
 * for its own pallet-spaces) plus the run total, and a per-company email-and-send.
 *
 * Prices come in already computed (`useCompanyBills`, shared with the per-leg breakdowns next to
 * the collection/trunk maps) — this panel never quotes on its own, so every figure the operator or
 * a company sees is the same number wherever it appears.
 *
 * "Other" here means whatever falls OUTSIDE the two mapped legs (last-mile delivery past the
 * destination hub, the heavy-pallet surcharge) — the miscellaneous items the operator asked to see
 * called out separately, collapsed by default since it's the fine print, not the headline number.
 */

export function GroupageBilling({
  bills,
  loading,
}: {
  bills: CompanyBill[] | null;
  loading: boolean;
}) {
  if (!bills && !loading) return null;

  const priced = bills?.filter((b): b is CompanyBill & { quote: NonNullable<CompanyBill["quote"]> } => b.quote !== null) ?? [];
  const currency = priced[0]?.quote.currencySymbol ?? "£";
  const grandTotal = priced.reduce((sum, b) => sum + b.quote.total, 0);
  const otherGrandTotal = priced.reduce((sum, b) => sum + legTotal(b.quote.lineItems, "other"), 0);

  return (
    <div
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: radius.card,
        padding: spacing.md,
        display: "flex",
        flexDirection: "column",
        gap: spacing.sm,
        background: color.surface,
      }}
    >
      <div>
        <p style={{ ...sectionLabel, margin: 0 }}>Final billing — per company</p>
        <p style={{ margin: `2px 0 0`, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          Each company is billed for its own pallet-spaces on the shared truck. Email each their quote below.
        </p>
      </div>

      {loading && !bills && (
        <p style={{ margin: 0, fontSize: font.sm, color: color.muted }}>Pricing each company…</p>
      )}

      {bills && (
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
          {priced.length > 0 && (
            <details>
              <summary style={{ fontSize: font.xs, color: color.accentDark, cursor: "pointer", fontWeight: 600 }}>
                Miscellaneous — last-mile delivery &amp; surcharges ({currency}{otherGrandTotal.toFixed(2)})
              </summary>
              <div style={{ marginTop: spacing.xs, display: "flex", flexDirection: "column", gap: spacing.xs }}>
                {priced.map((b, i) => {
                  const items = lineItemsForLeg(b.quote.lineItems, "other");
                  if (items.length === 0) return null;
                  return (
                    <div key={`${b.company}-other-${i}`} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: font.xs, fontWeight: 600, color: color.text }}>{b.company || "Company"}</span>
                      {items.map((li, j) => (
                        <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: font.xs, color: color.muted }}>
                          <span>{li.label}</span>
                          <span>{currency}{li.amount.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          {bills.map((b, i) => (
            <div
              key={`${b.company}-${i}`}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: spacing.xs,
                borderTop: `1px solid ${color.border}`,
                paddingTop: spacing.sm,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: spacing.sm }}>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>{b.company || "Company"}</span>
                  {b.quote && (
                    <span style={{ fontSize: font.xs, color: color.muted }}>
                      {b.quote.demand.palletCount} pallets · {b.quote.demand.footprints} pallet-spaces
                    </span>
                  )}
                </div>
                {b.quote ? (
                  <span style={{ fontSize: font.md, fontWeight: 700, color: color.text }}>
                    {b.quote.currencySymbol}
                    {b.quote.total.toFixed(2)}
                  </span>
                ) : (
                  <span style={{ fontSize: font.xs, color: color.error, maxWidth: 260, textAlign: "right" }}>{b.error}</span>
                )}
              </div>

              {b.quote && (
                <details>
                  <summary style={{ fontSize: font.xs, color: color.accentDark, cursor: "pointer", fontWeight: 600 }}>
                    Email {b.company || "this company"} their quote
                  </summary>
                  <div style={{ marginTop: spacing.xs }}>
                    <SendQuoteButton groupageQuote={b.quote} />
                  </div>
                </details>
              )}
            </div>
          ))}

          {/* Run total — the carrier's revenue across every company on this truck. When NONE could
              be priced (every company is over capacity / blocked), a bare "Total (0) £0.00" reads as
              a real zero-price quote; show what actually needs attention instead (the per-company
              block messages are already listed above). */}
          {priced.length === 0 ? (
            <div
              role="status"
              style={{
                borderTop: `2px solid ${color.border}`,
                paddingTop: spacing.sm,
                fontSize: font.sm,
                fontWeight: 600,
                color: color.review.fg,
              }}
            >
              No companies priced yet — {bills.length} {bills.length === 1 ? "company needs" : "companies need"} attention above before this truck can be quoted.
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                borderTop: `2px solid ${color.border}`,
                paddingTop: spacing.sm,
              }}
            >
              <span style={{ fontSize: font.sm, fontWeight: 700, color: color.text }}>Total ({priced.length} {priced.length === 1 ? "company" : "companies"})</span>
              <span style={{ fontSize: font.lg, fontWeight: 800, color: color.text }}>
                {currency}
                {grandTotal.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: font.xs,
  fontWeight: 600,
  color: color.muted,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
