"use client";

import { color, font, spacing, radius, sectionLabel, td, tdMuted, th } from "@/styles/tokens";
import { smartGBP } from "@/lib/fmt";
import { SendQuoteButton } from "@/components/results/SendQuoteButton";
import { RouteMap, type RoutePoint } from "@/components/maps/RouteMap";
import { publicEnv } from "@/config/public-env";
import { extractPostcode } from "@/lib/geo/address-resolver";
import { postcodeArea } from "@/lib/groupage/hub-resolver";
import { areaCentroid } from "@/lib/geo/area-centroids";
import type { Quote } from "@/types/api";

/** A chain address → its coarse area centroid (refined to street level client-side by RouteMap).
 *  Returns null when no UK postcode can be read — that stop is off the map but stays in the
 *  itinerary table above, so nothing is hidden (mirrors the collection-run map). */
function addressCentroid(address: string) {
  const pc = extractPostcode(address);
  if (!pc) return null;
  try {
    return areaCentroid(postcodeArea(pc));
  } catch {
    return null;
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function QuotePanel({ quote }: { quote: Quote }) {
  const multi = quote.vans.length > 1;
  const hasCo2 = quote.co2TotalKg !== undefined;
  // A multi-stop chain carries a leg per hop (pickup→A→…→final stop). It is one-way: there is no
  // drive-home leg. Single-drop quotes have 0–1 legs, so they fall back to the plain
  // origin → destination view untouched.
  const legs = quote.route.legs ?? [];
  const isChain = legs.length > 1;

  // Map waypoints = the ordered stops strictly between the pickup (origin) and the final
  // stop (destination); the endpoints are passed to the map separately.
  const waypointParam = isChain
    ? legs
        .map((l) => l.to)
        .filter((addr) => addr !== quote.route.origin && addr !== quote.route.destination)
    : [];
  // Built client-side from the browser (NEXT_PUBLIC, referrer-restricted) key — the same key
  // RouteMap/HubMap already expose to the browser. The old server route proxied this through the
  // PAID, unrestricted GOOGLE_MAPS_API_KEY via a redirect, which leaked that key into the browser's
  // network tab (see docs/security notes); never route embed URLs through the server key again.
  const embedApiKey = publicEnv.googleMapsApiKey;
  const mapSrc = embedApiKey
    ? `https://www.google.com/maps/embed/v1/directions` +
      `?key=${embedApiKey}` +
      `&origin=${encodeURIComponent(quote.route.origin)}` +
      `&destination=${encodeURIComponent(quote.route.destination)}` +
      (waypointParam.length > 0
        ? `&waypoints=${waypointParam.map(encodeURIComponent).join("|")}`
        : "") +
      `&mode=driving`
    : null;

  // Multi-stop: the Google Directions embed silently fails to a zoomed-out world view when it
  // can't resolve a many-waypoint route, dropping the intermediate stops. Use the marker-based
  // RouteMap instead — it pins EVERY stop and fits the viewport to them (FitBounds), so all
  // locations always show. Ordered visit list = pickup (route origin) + each leg's destination.
  const chainAddresses = isChain ? [quote.route.origin, ...legs.map((l) => l.to)] : [];
  const chainPoints: RoutePoint[] = chainAddresses.flatMap((address, i) => {
    const ll = addressCentroid(address);
    return ll ? [{ seq: i + 1, label: address, ...ll }] : [];
  });
  // Prefer the reliable marker map for a chain when the browser key is set; otherwise fall back
  // to the existing iframe (unchanged for single-drop quotes, which route cleanly there).
  const useMarkerMap = isChain && Boolean(publicEnv.googleMapsApiKey) && chainPoints.length > 0;

  // Round each leg to 1 dp, then sum the rounded legs so the itinerary rows always add
  // up to the headline total (a total summed from unrounded miles would look "off").
  const legMiles = legs.map((l) => Math.round(l.distanceMiles * 10) / 10);
  const chainTotalMiles = legMiles.reduce((s, m) => s + m, 0);
  const chainTotalSeconds = legs.reduce((s, l) => s + l.durationSeconds, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.lg }}>
      <div>
        <p style={sectionLabel}>Route</p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.sm,
            marginTop: spacing.xs,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: font.base, color: color.text, fontWeight: 600 }}>
            {quote.route.origin}
          </span>
          <span style={{ color: color.muted, fontSize: font.base }}>→</span>
          <span style={{ fontSize: font.base, color: color.text, fontWeight: 600 }}>
            {quote.route.destination}
          </span>
          <span style={routeBadge}>
            {(isChain ? chainTotalMiles : quote.route.distanceMiles).toFixed(1)} mi ·{" "}
            {formatDuration(isChain ? chainTotalSeconds : quote.route.durationSeconds)}
          </span>
          {isChain && <span style={routeBadge}>{legs.length} legs · one-way</span>}
          <span style={routeBadge}>
            {quote.vans.length} vehicle{multi ? "s" : ""}
          </span>
          <span style={{ fontSize: 11, color: color.muted, fontStyle: "italic" }}>
            {(quote.route.distanceMethod ?? "road") === "road"
              ? "road distance · Google Maps"
              : "straight-line est. · no Maps key"}
          </span>
        </div>
      </div>

      {isChain && (
        <div>
          <p style={{ ...sectionLabel, marginBottom: spacing.xs }}>Legs</p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={{ ...th, width: "100%" }}>Leg</th>
                <th style={{ ...th, textAlign: "right", whiteSpace: "nowrap" }}>Miles</th>
                <th style={{ ...th, textAlign: "right", whiteSpace: "nowrap" }}>Time</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, i) => {
                const isReturn = leg.to === quote.route.origin;
                return (
                  <tr key={`${leg.from}-${leg.to}-${i}`}>
                    <td style={tdMuted}>{i + 1}</td>
                    <td style={td}>
                      {leg.from} → {leg.to}
                      {isReturn && (
                        <span style={{ ...routeBadge, marginLeft: spacing.sm }}>return home</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {legMiles[i]!.toFixed(1)}
                    </td>
                    <td style={{ ...tdMuted, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {formatDuration(leg.durationSeconds)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ ...td, fontWeight: 700, borderTop: `2px solid ${color.borderStrong}` }} />
                <td style={{ ...td, fontWeight: 700, color: color.text, borderTop: `2px solid ${color.borderStrong}` }}>
                  Total (incl. return, counted once)
                </td>
                <td style={{ ...td, fontWeight: 700, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", borderTop: `2px solid ${color.borderStrong}` }}>
                  {chainTotalMiles.toFixed(1)}
                </td>
                <td style={{ ...td, fontWeight: 700, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", borderTop: `2px solid ${color.borderStrong}` }}>
                  {formatDuration(chainTotalSeconds)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div>
        <p style={{ ...sectionLabel, marginBottom: spacing.xs }}>Route map</p>
        {useMarkerMap ? (
          <RouteMap points={chainPoints} heightPx={320} geocode />
        ) : mapSrc ? (
          <iframe
            src={mapSrc}
            title="Route map"
            style={{
              width: "100%",
              height: 320,
              border: `1px solid ${color.border}`,
              borderRadius: radius.card,
              background: color.surfaceSub,
            }}
          />
        ) : (
          <div
            style={{
              minHeight: 180,
              height: 320,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              textAlign: "center",
              padding: spacing.lg,
              borderRadius: radius.card,
              border: `1px dashed ${color.border}`,
              background: color.surfaceSub,
              color: color.muted,
              fontSize: font.xs,
              lineHeight: 1.5,
            }}
          >
            <span style={{ fontWeight: 600, color: color.text }}>Live map disabled</span>
            <span>
              Add <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to <code>.env.local</code> to switch it on.
            </span>
          </div>
        )}
      </div>

      <div>
        <p style={{ ...sectionLabel, marginBottom: spacing.xs }}>Vehicles</p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>#</th>
              <th style={{ ...th, width: "100%" }}>Description</th>
              <th style={{ ...th, whiteSpace: "nowrap" }}>Van ID</th>
              <th style={{ ...th, textAlign: "right", whiteSpace: "nowrap" }}>Rate</th>
              <th style={{ ...th, textAlign: "right", whiteSpace: "nowrap" }}>Distance cost</th>
              {hasCo2 && <th style={{ ...th, textAlign: "right", whiteSpace: "nowrap" }}>CO₂</th>}
            </tr>
          </thead>
          <tbody>
            {quote.vans.map((v, i) => (
              <tr key={`${v.id}-${i}`}>
                <td style={tdMuted}>{i + 1}</td>
                <td style={td}>{v.description}</td>
                <td style={{ ...tdMuted, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{v.id}</td>
                <td style={{ ...tdMuted, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  £{v.perMileRate.toFixed(2)}/mi
                </td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {smartGBP(v.distanceCost)}
                </td>
                {hasCo2 && (
                  <td style={{ ...tdMuted, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {v.co2Kg.toFixed(1)} kg
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasCo2 && (
        <div>
          <p style={sectionLabel}>Carbon</p>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: spacing.sm,
              marginTop: spacing.xs,
              padding: `${spacing.xs}px ${spacing.md}px`,
              background: color.surfaceSub,
              border: `1px solid ${color.border}`,
              borderRadius: radius.input,
              width: "fit-content",
            }}
          >
            <span style={{ fontSize: font.md, fontWeight: 700, color: color.text, fontVariantNumeric: "tabular-nums" }}>
              {quote.co2TotalKg!.toFixed(1)} kg CO₂
            </span>
            <span style={{ fontSize: font.xs, color: color.muted }}>for this job (all vans, billed distance)</span>
          </div>
        </div>
      )}

      <div>
        <p style={{ ...sectionLabel, marginBottom: spacing.xs }}>Breakdown</p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: "100%" }}>Item</th>
              <th style={{ ...th, textAlign: "right", whiteSpace: "nowrap" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {quote.lineItems.map((item) => (
              <tr key={item.label}>
                <td style={tdMuted}>{item.label}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                  {smartGBP(item.amount)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td
                style={{
                  ...td,
                  fontWeight: 700,
                  color: color.text,
                  fontSize: font.md,
                  borderTop: `2px solid ${color.borderStrong}`,
                  borderBottom: "none",
                }}
              >
                Total
              </td>
              <td
                style={{
                  ...td,
                  fontWeight: 700,
                  fontSize: font.md,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  color: color.accent,
                  borderTop: `2px solid ${color.borderStrong}`,
                  borderBottom: "none",
                }}
              >
                {smartGBP(quote.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div>
        <p style={{ ...sectionLabel, marginBottom: spacing.xs }}>Send Quote</p>
        <SendQuoteButton quote={quote} />
      </div>
    </div>
  );
}

const routeBadge: React.CSSProperties = {
  fontSize: font.sm,
  color: color.muted,
  background: color.surfaceSub,
  border: `1px solid ${color.border}`,
  borderRadius: radius.badge,
  padding: "2px 10px",
};
