"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APIProvider, Map, Marker, useMap, useMapsLibrary } from "@vis.gl/react-google-maps";
import { color, font, spacing } from "@/styles/tokens";
import { publicEnv } from "@/config/public-env";
import { useGoogleMapsAuthFailed } from "./use-maps-auth";
import type { LatLng } from "@/lib/geo/area-centroids";

/** A numbered stop on the route. `lat/lng` start as coarse area centroids and are refined
 *  client-side (see `geocode`). `label` is the human address used for that refinement + the pin tooltip. */
export interface RoutePoint extends LatLng {
  readonly seq: number;
  readonly label: string;
}

/** The hub the run starts/ends at (collection loop) or an origin/destination hub (groupage). */
export interface RouteHub extends LatLng {
  readonly label: string;
}

// Pin colours are baked into the SVG data-URIs (a data-URI can't read a CSS var), mirroring
// the established HubMap convention — the one place hardcoded hex is unavoidable.
const STOP_FILL = "#1971c2"; // blue — a numbered pickup/stop
const HUB_FILL = "#d64545"; // red — the hub

/** A numbered circle pin as a self-contained SVG data-URI (no external images, number centred). */
function numberedPin(fill: string, n: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
    `<circle cx="14" cy="14" r="12" fill="${fill}" stroke="white" stroke-width="2"/>` +
    `<text x="14" y="19" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="700" fill="white">${n}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Teardrop hub pin (same shape as HubMap). */
function hubPin(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24">` +
    `<path fill="${HUB_FILL}" stroke="white" stroke-width="1.5" d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/>` +
    `<circle cx="12" cy="9" r="2.6" fill="white"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Draws the route as a polyline in visit order; cleans itself up on unmount/change.
 *  Keyed on the coordinate values (`pathKey`), not the array identity, so it rebuilds only when the
 *  pins actually move (first render + each geocode refinement) — never on an incidental re-render. */
function RouteLine({ path, pathKey }: { path: readonly LatLng[]; pathKey: string }) {
  const map = useMap();
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    const pts = pathRef.current;
    if (!map || pts.length < 2) return;
    const line = new google.maps.Polyline({
      path: pts.map((p) => ({ lat: p.lat, lng: p.lng })),
      geodesic: true,
      strokeColor: STOP_FILL,
      strokeOpacity: 0.8,
      strokeWeight: 2,
      map,
    });
    return () => line.setMap(null);
  }, [map, pathKey]);
  return null;
}

/** Fits the viewport to every marker so the whole run is visible. Fires ONCE per distinct route
 *  (`boundsKey` = hub + stop sequence), not on every render — so after the user zooms, refined pin
 *  positions no longer snap the map back. Reads the latest coords via a ref. */
function FitBounds({ points, boundsKey }: { points: readonly LatLng[]; boundsKey: string }) {
  const map = useMap();
  const pointsRef = useRef(points);
  pointsRef.current = points;
  useEffect(() => {
    const pts = pointsRef.current;
    if (!map || pts.length === 0) return;
    const b = new google.maps.LatLngBounds();
    pts.forEach((p) => b.extend({ lat: p.lat, lng: p.lng }));
    if (pts.length === 1) map.setCenter(b.getCenter());
    else map.fitBounds(b, 48);
  }, [map, boundsKey]);
  return null;
}

/** Refines coarse area-centroid pins to street level via the Google geocoder (UK-restricted),
 *  one lookup per label. Failures keep the centroid — the map degrades, never breaks. */
function GeocodeRefiner({
  items,
  geoKey,
  onResolved,
  onSettled,
}: {
  items: ReadonlyArray<{ key: string; label: string }>;
  geoKey: string;
  onResolved: (key: string, ll: LatLng) => void;
  /** Fired once the whole lookup pass finishes (every item resolved or failed) — NOT once per item.
   *  Lets the caller hold the initial map fit until the accurate positions are in, rather than
   *  fitting to the coarse centroids first. */
  onSettled: () => void;
}) {
  const lib = useMapsLibrary("geocoding");
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Keyed on `geoKey` (the label set), not the array identity — so it geocodes each address ONCE,
  // never re-running (and re-billing Google) on every incidental re-render.
  useEffect(() => {
    if (!lib) return;
    const its = itemsRef.current;
    if (its.length === 0) {
      onSettled();
      return;
    }
    const geocoder = new lib.Geocoder();
    let cancelled = false;
    (async () => {
      for (const it of its) {
        if (cancelled) return;
        try {
          const { results } = await geocoder.geocode({
            address: it.label,
            componentRestrictions: { country: "GB" },
          });
          const loc = results[0]?.geometry.location;
          if (!cancelled && loc) onResolved(it.key, { lat: loc.lat(), lng: loc.lng() });
        } catch {
          /* keep the centroid fallback */
        }
      }
      if (!cancelled) onSettled();
    })();
    return () => {
      cancelled = true;
    };
  }, [lib, geoKey, onResolved, onSettled]);
  return null;
}

/**
 * A live, zoomable Google map of a route: numbered stop pins + a polyline in visit order, plus an
 * optional hub. Replaces the frozen SVG mini-maps. Needs a browser Maps key
 * (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY); without it the caller shows its SVG fallback instead — so this
 * renders a small placeholder rather than crashing if ever mounted keyless.
 *
 * `loop` closes the line back to the hub (a collection run returns to base). `geocode` refines the
 * coarse centroid pins to street level (on for real addresses, off for hub-name-only points).
 */
export function RouteMap({
  points,
  hub,
  loop = false,
  geocode = false,
  heightPx = 340,
}: {
  points: readonly RoutePoint[];
  hub?: RouteHub;
  loop?: boolean;
  geocode?: boolean;
  heightPx?: number;
}) {
  const apiKey = publicEnv.googleMapsApiKey;
  const authFailed = useGoogleMapsAuthFailed();
  const [overrides, setOverrides] = useState<Record<string, LatLng>>({});
  const onResolved = useCallback((key: string, ll: LatLng) => {
    setOverrides((o) => {
      const prev = o[key];
      if (prev && prev.lat === ll.lat && prev.lng === ll.lng) return o; // unchanged → skip the re-render
      return { ...o, [key]: ll };
    });
  }, []);
  // Without geocoding, the passed-in coordinates are already final — fit immediately. WITH
  // geocoding, the first render only has coarse area-centroid guesses (sometimes coincident,
  // which zooms Google in tight on a near-empty bounding box); wait for the address lookup to
  // settle so the one-shot initial fit uses the real, spread-out street positions instead.
  const [geoSettled, setGeoSettled] = useState(!geocode);
  const onGeoSettled = useCallback(() => setGeoSettled(true), []);
  // Computed from raw props (never the resolved/overridden coords) so this is stable across the
  // geocode pass itself — reset ONLY when the route being geocoded actually changes.
  const geoKeyForReset = geocode
    ? [hub?.label ?? "", ...points.map((p) => p.label)].join("|")
    : "";
  useEffect(() => {
    if (geocode) setGeoSettled(false);
  }, [geocode, geoKeyForReset]);

  // No key, or Google rejected the key mid-session → fail LOUD with a clear reason, never a silent
  // blank tile area. A rejected key is a Google-account/settings problem (see the message), not a
  // code fault, so the message points the operator at the fix rather than pretending the map works.
  if (!apiKey || authFailed) {
    return <MapUnavailable reason={authFailed ? "rejected" : "missing"} heightPx={heightPx} />;
  }

  const resolvedHub = hub ? { ...hub, ...(overrides["hub"] ?? {}) } : undefined;
  const resolvedPoints = points.map((p) => ({ ...p, ...(overrides[`p${p.seq}`] ?? {}) }));
  const all: LatLng[] = [...(resolvedHub ? [resolvedHub] : []), ...resolvedPoints];
  if (all.length === 0) return null;

  // Line in visit order: hub → stops (→ hub when it's a return loop).
  const linePath: LatLng[] = resolvedHub
    ? loop
      ? [resolvedHub, ...resolvedPoints, resolvedHub]
      : [resolvedHub, ...resolvedPoints]
    : resolvedPoints;

  const geoItems = geocode
    ? [
        ...(hub ? [{ key: "hub", label: hub.label }] : []),
        ...points.map((p) => ({ key: `p${p.seq}`, label: p.label })),
      ]
    : [];

  // Stable value-keys so the effect-driven children react to REAL changes (a new route, refined
  // pins) rather than to incidental re-renders that recreate these arrays. `boundsKey` deliberately
  // ignores coordinates — the fit fires once per route and never fights the user's zoom afterwards.
  const boundsKey = `${hub?.label ?? ""}|${points.map((p) => p.seq).join(",")}`;
  const lineKey = linePath.map((p) => `${p.lat},${p.lng}`).join(";");
  const geoKey = geoItems.map((it) => it.label).join("|");

  return (
    <div style={{ width: "100%", height: heightPx, borderRadius: 8, overflow: "hidden", border: `1px solid ${color.border}` }}>
      <APIProvider apiKey={apiKey}>
        <Map
          defaultCenter={all[0]}
          defaultZoom={7}
          gestureHandling="greedy"
          zoomControl={true}
          mapTypeControl={false}
          streetViewControl={false}
          clickableIcons={false}
          style={{ width: "100%", height: "100%" }}
        >
          {resolvedHub && (
            <Marker position={resolvedHub} icon={hubPin()} title={resolvedHub.label} zIndex={2} />
          )}
          {resolvedPoints.map((p) => (
            <Marker key={p.seq} position={p} icon={numberedPin(STOP_FILL, p.seq)} title={`${p.seq}. ${p.label}`} zIndex={1} />
          ))}
          <RouteLine path={linePath} pathKey={lineKey} />
          {geoSettled && <FitBounds points={all} boundsKey={boundsKey} />}
          {geocode && <GeocodeRefiner items={geoItems} geoKey={geoKey} onResolved={onResolved} onSettled={onGeoSettled} />}
        </Map>
      </APIProvider>
    </div>
  );
}

/**
 * Shown instead of a blank map when the live map can't run: either no key is configured (`missing`)
 * or Google rejected the key this session (`rejected`). Fails loud with the concrete fix so a blank
 * tile area is never mistaken for "no route to show".
 */
function MapUnavailable({ reason, heightPx }: { reason: "missing" | "rejected"; heightPx: number }) {
  return (
    <div
      style={{
        minHeight: 160,
        height: heightPx,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        textAlign: "center",
        padding: spacing.lg,
        borderRadius: 8,
        border: `1px dashed ${reason === "rejected" ? color.errorBorder : color.border}`,
        background: reason === "rejected" ? color.errorBg : color.surfaceSub,
        color: color.muted,
        fontSize: font.xs,
        lineHeight: 1.5,
      }}
    >
      {reason === "missing" ? (
        <>
          <span style={{ fontWeight: 600, color: color.text }}>Live map disabled</span>
          <span>
            Add <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to <code>.env.local</code> to switch it on.
          </span>
        </>
      ) : (
        <>
          <span style={{ fontWeight: 600, color: color.error }}>Map couldn&apos;t load — key rejected by Google</span>
          <span style={{ maxWidth: 340 }}>
            The map key was refused. In the Google Cloud console, check that the <strong>Maps JavaScript API</strong> is
            enabled, <strong>billing</strong> is on for the project, and this site is allowed under the key&apos;s website
            restrictions.
          </span>
        </>
      )}
    </div>
  );
}
