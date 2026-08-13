"use client";

import type { CSSProperties } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import type { GroupageQuote } from "@/lib/groupage/groupage.types";
import { catchmentSummary, hubTown } from "@/lib/groupage/hub-display";

/**
 * The groupage result's PRIMARY route view: a plain left-to-right journey —
 *   [your pickup] —collect→ [hub] —between hubs→ [hub] —deliver→ [your delivery]
 * A local move (same hub both ends) collapses to one hub with no between-hubs leg.
 *
 * Why schematic, not a map: groupage prices per pallet-space over a fixed hub network
 * with NO distances/geocoding, and customer addresses are never plotted — so a
 * geographic map (a lone hub dot, no address pins) reads as broken to operators. The
 * steps below answer the real question: "am I going from my address to a hub, and what
 * is that hub?" — in words, in order.
 */
export function GroupageJourneyStrip({ quote }: { quote: GroupageQuote }) {
  const { path, originPostcode, destinationPostcode } = quote;
  const { originHub, destinationHub } = path;

  // Direct (hubless, another carrier): pooled shared truck straight from pickup to delivery, no hub cross-dock.
  if (path.routing === "direct" || !originHub || !destinationHub) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
        <div style={stripBox}>
          <Node icon="📍" value={originPostcode} caption="Your pickup" />
          <Leg label="direct" />
          <Node icon="🏠" value={destinationPostcode} caption="Your delivery" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <p style={noteStyle}>
            <strong>Direct</strong> — no hub cross-dock. Your pallets travel straight from pickup to
            delivery on another carrier&apos;s shared truck.
          </p>
          <p style={{ ...noteStyle, color: color.muted }}>
            Shared truck — you share space with other bookings, priced per pallet-space (not by distance).
          </p>
        </div>
      </div>
    );
  }

  const originTown = hubTown(originHub.name);
  const destTown = hubTown(destinationHub.name);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
      {/* Steps, left → right, wrapping on narrow screens. */}
      <div style={stripBox}>
        <Node icon="📍" value={originPostcode} caption="Your pickup" />
        <Leg label="collect" />
        <Node icon="🏭" value={originTown} caption="hub" tone="hub" />
        {!path.isLocal && (
          <>
            <Leg label="between hubs" />
            <Node icon="🏭" value={destTown} caption="hub" tone="hub" />
          </>
        )}
        <Leg label="deliver" />
        <Node icon="🏠" value={destinationPostcode} caption="Your delivery" />
      </div>

      {/* Plain-language notes: what a hub is, and how this is priced (no distances). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {path.isLocal ? (
          <p style={noteStyle}>
            <strong>{originTown} hub</strong> covers {catchmentSummary(originHub.catchment)} — the depot
            your pallets pass through. Both postcodes sit in this one hub, so it&apos;s a{" "}
            <strong>local move</strong> with no between-hubs leg.
          </p>
        ) : (
          <>
            <p style={noteStyle}>
              <strong>{originTown} hub</strong> covers {catchmentSummary(originHub.catchment)} —
              collected here, then trunked on to…
            </p>
            <p style={noteStyle}>
              <strong>{destTown} hub</strong> covers {catchmentSummary(destinationHub.catchment)} — then
              delivered to your door.
            </p>
          </>
        )}
        <p style={{ ...noteStyle, color: color.muted }}>
          Shared truck — you share space with other bookings, priced per pallet-space (not by distance).
        </p>
      </div>
    </div>
  );
}

const stripBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  flexWrap: "wrap",
  border: `1px solid ${color.border}`,
  borderRadius: radius.badge,
  background: color.surface,
  padding: spacing.sm,
};

/** A point on the journey: the customer's door (address tone) or a hub (accent tone). */
function Node({
  icon,
  value,
  caption,
  tone = "address",
}: {
  icon: string;
  value: string;
  caption: string;
  tone?: "address" | "hub";
}) {
  const isHub = tone === "hub";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        minWidth: 92,
        padding: "8px 10px",
        textAlign: "center",
        border: `1px solid ${isHub ? color.accent : color.border}`,
        borderRadius: radius.badge,
        background: color.surface,
      }}
    >
      <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
        {icon}
      </span>
      <span style={{ fontWeight: 700, fontSize: font.sm, color: color.text }}>{value}</span>
      <span style={{ fontSize: font.xs, color: color.muted }}>{caption}</span>
    </div>
  );
}

/** The labelled arrow between two nodes — names the leg in plain words. */
function Leg({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, minWidth: 56 }}>
      <span style={{ fontSize: font.xs, color: color.muted, whiteSpace: "nowrap" }}>{label}</span>
      <span aria-hidden style={{ fontSize: 16, color: color.accent, lineHeight: 1 }}>
        →
      </span>
    </div>
  );
}

const noteStyle: CSSProperties = { margin: 0, fontSize: font.xs, color: color.text, lineHeight: 1.4 };
