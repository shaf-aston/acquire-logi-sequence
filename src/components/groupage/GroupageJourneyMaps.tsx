"use client";

import { useMemo } from "react";
import { color, font, radius, spacing } from "@/styles/tokens";
import { RouteMap, type RouteHub, type RoutePoint } from "@/components/maps/RouteMap";
import { publicEnv } from "@/config/public-env";
import { allAreaCentres, areaCentroid, hubCentroid, type LatLng } from "@/lib/geo/area-centroids";
import { postcodeArea } from "@/lib/groupage/hub-resolver";
import { hubTown } from "@/lib/groupage/hub-display";
import { lineItemsForLeg, legTotal, type BillingLeg } from "@/lib/groupage/billing-legs";
import type { CompanyBill } from "@/components/groupage/useCompanyBills";
import type { SessionHub } from "@/types/api";

/**
 * The groupage journey, split into its two real legs so the operator reads them separately:
 *   1. COLLECTION ROUND — the local pickup run: each company's site, in pickup order, into the
 *      consolidation hub.
 *   2. TRUNK — the hub-to-hub line-haul (collection hub → destination hub).
 *
 * Both legs render through ONE reusable `<JourneyLeg>`: the live Google map (`RouteMap`) when a
 * browser Maps key is configured, else a keyless UK schematic so the leg always shows something.
 * Coarse positions come from postcode-area centroids (the shared map reference data); the Google map
 * refines them to street level client-side. Pure display — never feeds routing or pricing.
 */

interface JourneyConsignment {
  readonly company: string;
  readonly originPostcode: string;
}

/** A node on the keyless schematic: a numbered pickup (`seq` set) or a hub (`seq` undefined). */
interface SchematicNode extends LatLng {
  readonly label: string;
  readonly seq?: number;
}

/** Coarse area centroid for a pickup postcode; null when the postcode isn't readable. */
function pickupCentroid(pc: string): LatLng | null {
  try {
    return areaCentroid(postcodeArea(pc));
  } catch {
    return null;
  }
}

/** Geocode-friendly hub label: "Name, PostCode" refines precisely on Google yet reads as the hub. */
function hubRouteLabel(h: SessionHub): string {
  return h.postcode ? `${h.name}, ${h.postcode}` : h.name;
}

export function GroupageJourneyMaps({
  consignments,
  sessionHubs,
  bills,
  billingLoading,
}: {
  consignments: readonly JourneyConsignment[];
  sessionHubs: readonly SessionHub[];
  /** Already-priced companies (shared with the final billing panel via `useCompanyBills`) — drives
   *  the collapsible per-leg breakdown shown right under each leg's map. Pass `null` while nothing
   *  has been priced yet (e.g. no consignments) to hide the breakdown without hiding the maps. */
  bills: CompanyBill[] | null;
  billingLoading: boolean;
}) {
  const collectionHub = sessionHubs.find((h) => h.role === "collection");
  const destinationHub = sessionHubs.find((h) => h.role === "destination");
  const collLL = collectionHub ? hubCentroid(collectionHub.catchment) : null;
  const destLL = destinationHub ? hubCentroid(destinationHub.catchment) : null;

  // Pickups in visit order, re-sequenced after dropping any with an unreadable postcode so the
  // numbers stay 1..N with no gaps.
  const pickups = useMemo<RoutePoint[]>(() => {
    const out: RoutePoint[] = [];
    for (const c of consignments) {
      const ll = pickupCentroid(c.originPostcode);
      if (!ll) continue;
      out.push({ seq: out.length + 1, label: `${c.company?.trim() || "Pickup"}, ${c.originPostcode}`, ...ll });
    }
    return out;
  }, [consignments]);

  // Nothing meaningful to draw without a collection hub anchoring the run.
  if (!collectionHub || !collLL) return null;

  const collectionRouteHub: RouteHub = { ...collLL, label: hubRouteLabel(collectionHub) };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>
      <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
        <p style={{ ...sectionLabel, margin: 0 }}>Collection round — pickups into the hub</p>
        <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
          One van visits each company in order, then delivers into <strong>{hubTown(collectionHub.name, 40)}</strong>.
        </p>
        <JourneyLeg
          hub={collectionRouteHub}
          points={pickups}
          emptyNote={pickups.length === 0 ? "No pickup postcodes to plot yet." : undefined}
        />
        <LegBilling leg="collection" title="Collection billing" bills={bills} loading={billingLoading} />
      </div>

      {destinationHub && destLL && (
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
          <p style={{ ...sectionLabel, margin: 0 }}>Trunk — hub to hub</p>
          <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
            The consolidated load runs <strong>{hubTown(collectionHub.name, 24)}</strong> →{" "}
            <strong>{hubTown(destinationHub.name, 24)}</strong>.
          </p>
          <JourneyLeg
            hub={collectionRouteHub}
            points={[{ seq: 1, label: hubRouteLabel(destinationHub), ...destLL }]}
          />
          <LegBilling leg="trunk" title="Trunk billing" bills={bills} loading={billingLoading} />
        </div>
      )}
    </div>
  );
}

/**
 * Collapsible per-company billing for ONE leg, sitting right under that leg's map so the price the
 * operator reads is anchored to the journey that earned it. Collapsed by default (`<details>`) —
 * the headline number is the final total in `GroupageBilling`; this is the supporting detail.
 */
function LegBilling({
  leg,
  title,
  bills,
  loading,
}: {
  leg: BillingLeg;
  title: string;
  bills: CompanyBill[] | null;
  loading: boolean;
}) {
  if (loading && !bills) {
    return <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>Pricing each company…</p>;
  }
  if (!bills) return null;

  const priced = bills.filter((b): b is CompanyBill & { quote: NonNullable<CompanyBill["quote"]> } => b.quote !== null);
  const rows = priced
    .map((b) => ({ company: b.company, items: lineItemsForLeg(b.quote.lineItems, leg), total: legTotal(b.quote.lineItems, leg) }))
    .filter((r) => r.items.length > 0);
  if (rows.length === 0) return null;

  const currency = priced[0]?.quote.currencySymbol ?? "£";
  const legGrandTotal = rows.reduce((sum, r) => sum + r.total, 0);

  return (
    <details>
      <summary style={{ fontSize: font.xs, color: color.accentDark, cursor: "pointer", fontWeight: 600 }}>
        {title} ({currency}{legGrandTotal.toFixed(2)})
      </summary>
      <div style={{ marginTop: spacing.xs, display: "flex", flexDirection: "column", gap: spacing.xs }}>
        {rows.map((r, i) => (
          <div key={`${r.company}-${i}`} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: font.xs, fontWeight: 600, color: color.text }}>{r.company || "Company"}</span>
              <span style={{ fontSize: font.xs, fontWeight: 600, color: color.text }}>{currency}{r.total.toFixed(2)}</span>
            </div>
            {r.items.map((li, j) => (
              <div key={j} style={{ display: "flex", justifyContent: "space-between", fontSize: font.xs, color: color.muted }}>
                <span>{li.label}</span>
                <span>{currency}{li.amount.toFixed(2)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * One leg of the journey. Live Google map when a Maps key is present (numbered pins refined to street
 * level); the keyless UK schematic otherwise. The single seam both legs share — no per-leg map logic.
 */
function JourneyLeg({ hub, points, emptyNote }: { hub: RouteHub; points: readonly RoutePoint[]; emptyNote?: string }) {
  if (publicEnv.googleMapsApiKey && points.length > 0) {
    return <RouteMap points={points} hub={hub} geocode heightPx={300} />;
  }
  const nodes: SchematicNode[] = [
    { lat: hub.lat, lng: hub.lng, label: hub.label },
    ...points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label, seq: p.seq })),
  ];
  return <UkSchematic nodes={nodes} emptyNote={emptyNote} />;
}

const VIEW_W = 320;
const VIEW_H = 300;
const PAD = 18;

/** Equirectangular projection over every area centre, latitude-corrected so Britain keeps its
 *  shape — the same projection the other groupage/admin maps use, so pins never drift between maps. */
function useProjection() {
  return useMemo(() => {
    const all = allAreaCentres();
    const lats = all.map((a) => a.lat);
    const lngs = all.map((a) => a.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const midLat = (minLat + maxLat) / 2;
    const lngScale = Math.cos((midLat * Math.PI) / 180);
    const scale = Math.min(
      (VIEW_W - 2 * PAD) / ((maxLng - minLng) * lngScale),
      (VIEW_H - 2 * PAD) / (maxLat - minLat),
    );
    return (lat: number, lng: number) => ({
      x: PAD + (lng - minLng) * lngScale * scale,
      y: PAD + (maxLat - lat) * scale,
    });
  }, []);
}

/** Keyless UK schematic: faint context dots, the nodes connected in order, numbered pickup pins and
 *  labelled hub pins. The graceful fallback whenever the live Google map can't render. */
function UkSchematic({ nodes, emptyNote }: { nodes: readonly SchematicNode[]; emptyNote?: string }) {
  const project = useProjection();
  const pts = nodes.map((n) => ({ ...n, ...project(n.lat, n.lng) }));

  return (
    <div
      style={{
        border: `1px solid ${color.border}`,
        borderRadius: radius.input,
        background: color.surface,
        padding: 8,
        // Bound the width so the viewBox never scales up so far that the pin labels turn gigantic
        // (the "messy" full-width schematic). Centred, so it reads as a tidy inset map.
        maxWidth: 380,
        margin: "0 auto",
      }}
    >
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} width="100%" role="img" aria-label="Route schematic" style={{ display: "block" }}>
        {allAreaCentres().map((area, i) => {
          const p = project(area.lat, area.lng);
          return <circle key={i} cx={p.x} cy={p.y} r={1.4} fill={color.border} />;
        })}

        {/* Connecting line through the nodes in order. */}
        {pts.length >= 2 && (
          <polyline
            points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke={color.accent}
            strokeWidth={2}
            strokeDasharray="4 3"
          />
        )}

        {/* Hubs first so a pickup sitting on top of a hub is still visible. */}
        {pts.map((p, i) =>
          p.seq === undefined ? <HubMarker key={`h${i}`} x={p.x} y={p.y} label={p.label} /> : null,
        )}
        {pts.map((p, i) =>
          p.seq !== undefined ? <StopMarker key={`s${i}`} x={p.x} y={p.y} seq={p.seq} /> : null,
        )}
      </svg>
      {emptyNote && (
        <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: font.xs, color: color.muted, textAlign: "center" }}>{emptyNote}</p>
      )}
    </div>
  );
}

function StopMarker({ x, y, seq }: { x: number; y: number; seq: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={7} fill={color.accent} stroke={color.surface} strokeWidth={1.5} />
      <text x={x} y={y + 3} textAnchor="middle" fontSize={9} fontWeight={700} fill={color.surface}>
        {seq}
      </text>
    </g>
  );
}

function HubMarker({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <g>
      <circle cx={x} cy={y} r={5.5} fill={color.error} stroke={color.surface} strokeWidth={1.5} />
      <title>{label}</title>
      <text x={x + 8} y={y + 3} fontSize={font.xs} fill={color.text} style={{ fontWeight: 600 }}>
        {hubTown(label, 14)}
      </text>
    </g>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: font.xs,
  fontWeight: 600,
  color: color.muted,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
