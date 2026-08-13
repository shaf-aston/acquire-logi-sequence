"use client";

import { useState } from "react";
import { color, font, radius, spacing, buttonPrimary } from "@/styles/tokens";
import type { Quote } from "@/types/api";
import type { GroupageQuote } from "@/lib/groupage/groupage.types";

type Props =
  | { quote: Quote; groupageQuote?: never }
  | { quote?: never; groupageQuote: GroupageQuote };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lets the operator email the on-screen quote straight to a client. Appears
 *  wherever a quote is generated (single-drop/multi-stop QuotePanel, groupage GroupagePanel). */
export function SendQuoteButton(props: Props) {
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = EMAIL_RE.test(to.trim());

  const send = async () => {
    if (!valid || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/quote/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to.trim(),
          ...(props.quote ? { quote: props.quote } : { groupageQuote: props.groupageQuote }),
        }),
      });
      const data: { success: boolean; error?: string } = await res.json();
      if (data.success) {
        setSentTo(to.trim());
      } else {
        setError(data.error ?? "Could not send the quote.");
      }
    } catch {
      setError("Network error — could not reach the server.");
    } finally {
      setSending(false);
    }
  };

  if (sentTo) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, fontSize: font.sm, color: color.success }}>
        <span>✓ Quote sent to {sentTo}</span>
        <button
          type="button"
          onClick={() => {
            setSentTo(null);
            setTo("");
          }}
          style={{
            border: "none",
            background: "none",
            color: color.accentDark,
            fontSize: font.sm,
            fontWeight: 600,
            cursor: "pointer",
            textDecoration: "underline",
            padding: 0,
          }}
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="client@email.com"
          aria-label="Recipient email"
          style={{
            flex: 1,
            minWidth: 200,
            padding: "8px 12px",
            borderRadius: radius.input,
            border: `1px solid ${to.trim() && !valid ? color.error : color.border}`,
            background: color.surfaceSub,
            color: color.text,
            fontSize: font.sm,
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        <button
          type="button"
          disabled={!valid || sending}
          onClick={() => void send()}
          style={buttonPrimary(!valid || sending)}
        >
          {sending ? "Sending…" : "Send Quote"}
        </button>
      </div>
      {to.trim() && !valid && (
        <span style={{ fontSize: font.xs, color: color.error }}>Enter a valid email address.</span>
      )}
      {error && <span style={{ fontSize: font.xs, color: color.error }}>{error}</span>}
    </div>
  );
}
