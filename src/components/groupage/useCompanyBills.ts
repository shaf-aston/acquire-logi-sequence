"use client";

import { useEffect, useMemo, useState } from "react";
import type { GroupagePallet, GroupageQuote } from "@/lib/groupage/groupage.types";
import type { SessionHub } from "@/types/api";

/**
 * Prices every company on a shared truck ONCE (`POST /api/groupage`, one call per company, layered
 * over the manifest's session hubs exactly like the manual form) so every billing surface — the
 * per-leg breakdowns next to each journey map, and the final per-company total — reads the same
 * numbers instead of re-quoting independently.
 */

export interface BillingConsignment {
  readonly company: string;
  readonly originPostcode: string;
  readonly destinationPostcode: string;
  readonly pallets: readonly GroupagePallet[];
}

export interface CompanyBill {
  readonly company: string;
  readonly quote: GroupageQuote | null;
  readonly error: string | null;
}

/** The 4-field wire shape the quote route accepts for `sessionHubs` (mirrors the other panels). */
function toWireHub(h: SessionHub): { id: string; name: string; catchment: string[]; address?: string } {
  return { id: h.id, name: h.name, catchment: h.catchment, ...(h.address ? { address: h.address } : {}) };
}

export function useCompanyBills(
  consignments: readonly BillingConsignment[],
  sessionHubs: readonly SessionHub[],
  // The single pricing gate: pricing only runs when the operator has explicitly asked for it
  // (the "Price it" step). Off ⇒ no quote-route calls and no bills, so an unconfirmed/auto-loaded
  // truck never shows a premature £0.00 billing panel.
  enabled = true,
): { bills: CompanyBill[] | null; loading: boolean } {
  const [bills, setBills] = useState<CompanyBill[] | null>(null);
  const [loading, setLoading] = useState(false);

  // Re-price only when the inputs actually change (value signature, not array identity) — so an
  // incidental re-render never re-hits the quote route.
  const signature = useMemo(
    () => JSON.stringify({ consignments, sessionHubs }),
    [consignments, sessionHubs],
  );

  useEffect(() => {
    if (!enabled || consignments.length === 0) {
      setBills(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const wireHubs = sessionHubs.map(toWireHub);

    Promise.all(
      consignments.map(async (c): Promise<CompanyBill> => {
        try {
          const res = await fetch("/api/groupage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // No `routing` — the service applies the configured default (config/groupage default
            // routing), so we never hardcode "via-hub" here.
            body: JSON.stringify({
              originPostcode: c.originPostcode,
              destinationPostcode: c.destinationPostcode,
              pallets: c.pallets,
              customerName: c.company,
              sessionHubs: wireHubs,
            }),
          });
          const data = (await res.json()) as
            | { success: true; quote: GroupageQuote }
            | { success: false; error: string };
          return data.success
            ? { company: c.company, quote: data.quote, error: null }
            : { company: c.company, quote: null, error: data.error };
        } catch {
          return { company: c.company, quote: null, error: "Couldn't price this company." };
        }
      }),
    ).then((rs) => {
      if (!cancelled) setBills(rs);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, enabled]);

  return { bills, loading };
}
