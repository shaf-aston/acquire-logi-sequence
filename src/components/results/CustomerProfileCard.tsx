"use client";

import { useEffect, useState } from "react";
import { color, font, spacing, radius } from "@/styles/tokens";
import type { QuoteHistoryEntry } from "@/lib/storage/quote-history.store";

interface HistoryResponse {
  readonly entries: QuoteHistoryEntry[];
}

interface CustomerProfileCardProps {
  readonly customer: { name: string | null; phone: string | null } | null;
  readonly filename: string | null;
}

/**
 * CRM surface for the customer detected on the ingested PDF, plus their past orders.
 * Mirrors QuotationHistory's visual pattern (same surface/border/radius/token set) so
 * it reads as one family of collapsible cards. Fetches history itself, like
 * QuotationHistory does, so it stays a drop-in with no wiring beyond the two props.
 */
export function CustomerProfileCard({ customer, filename }: CustomerProfileCardProps) {
  const [entries, setEntries] = useState<QuoteHistoryEntry[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((data: HistoryResponse) => setEntries(data.entries ?? []))
      .catch(() => setEntries([]));
  }, []);

  // Nothing detected from a PDF at all — this card has nothing to say.
  if (customer === null && filename === null) return null;

  const name = customer?.name ?? null;
  const pastOrders = name
    ? entries.filter((e) => (e.customer?.name ?? "").toLowerCase() === name.toLowerCase())
    : [];

  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: radius.card,
        boxShadow: color.shadow,
        overflow: "hidden",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setOpen((o) => !o); }}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: `${spacing.md}px ${spacing.lg}px`,
          cursor: "pointer",
          gap: spacing.sm,
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, minWidth: 0 }}>
          <span style={{ fontSize: font.sm, fontWeight: 600, color: color.text }}>
            {name ?? "Customer not detected"}
          </span>
          {customer && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: color.accentDark,
                background: color.accentMuted,
                border: `1px solid ${color.accentBorder}`,
                borderRadius: radius.badge,
                padding: "0px 7px",
              }}
            >
              detected from PDF
            </span>
          )}
        </div>
        <span style={{ fontSize: font.xs, color: color.muted }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div
          style={{
            borderTop: `1px solid ${color.border}`,
            padding: `${spacing.sm}px ${spacing.lg}px`,
            display: "flex",
            flexDirection: "column",
            gap: spacing.sm,
          }}
        >
          {customer?.phone && (
            <span style={{ fontSize: font.sm, color: color.textSub }}>Phone: {customer.phone}</span>
          )}

          <span style={{ fontSize: font.xs, fontWeight: 600, color: color.muted }}>Past orders</span>
          {!name || pastOrders.length === 0 ? (
            <span style={{ fontSize: font.xs, color: color.muted, fontStyle: "italic" }}>
              No previous orders for this customer.
            </span>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 1,
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {pastOrders.map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    padding: `${spacing.sm}px 0`,
                    borderBottom: `1px solid ${color.border}`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    gap: spacing.sm,
                  }}
                >
                  <span style={{ fontSize: font.sm, color: color.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.quote.route.origin} → {entry.quote.route.destination}
                  </span>
                  <span style={{ fontSize: font.xs, color: color.muted, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                    {new Date(entry.createdAt).toLocaleDateString()}
                  </span>
                  <span
                    style={{
                      fontSize: font.xs,
                      fontWeight: 700,
                      color: color.text,
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                    }}
                  >
                    £{entry.quote.total.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
