"use client";

import { useEffect, useMemo, useState } from "react";
import { APIProvider, Map, Marker, useMap } from "@vis.gl/react-google-maps";
import { color, font, radius, spacing } from "@/styles/tokens";
import { cssVar } from "@/components/results/van-3d/theme";
import { publicEnv } from "@/config/public-env";
import type { Hub } from "@/lib/groupage/groupage.types";
import { hubPoints, type HubPoint } from "@/lib/groupage/hub-geo";
import { haversineKm } from "@/lib/groupage/nearest-hub";
import { PlacesInput } from "@/components/PlacesInput";

const KM_TO_MI = 0.621371;
const UK_FALLBACK = { lat: 53.0, lng: -1.5 }; // rough centre of England, used only when no hubs exist.

type LatLng = { lat: number; lng: number };

/** Teardrop pin as an inline SVG data-URI — self-contained (no external marker images), colour per role. */
function pin(fill: string, size: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
    `<path fill="${fill}" stroke="white" stroke-width="1.5" d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/>` +
    `<circle cx="12" cy="9" r="2.6" fill="white"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
// Resolved from the design-system tokens (globals.css --color-map-*), same swap-seam
// pattern van-3d/theme.ts uses for Three.js — the SVG data-URI needs a concrete hex,
// not a live `var(--…)`, so it's read once here rather than hardcoded.
const HUB_PIN = pin(cssVar("--color-map-hub"), 26); // a hub
const NEAREST_PIN = pin(cssVar("--color-map-nearest"), 34); // the hub nearest the checked point
const LOCATOR_PIN = pin(cssVar("--color-map-locator"), 32); // the point being checked

/** Nearest hub to a point by straight-line (great-circle) distance, with that distance in km. */
function nearestOf(point: LatLng, points: readonly HubPoint[]): { hub: HubPoint; km: number } | null {
  let best: HubPoint | null = null;
  let bestKm = Infinity;
  for (const h of points) {
    const km = haversineKm(point, h);
    if (km < bestKm) {
      bestKm = km;
      best = h;
    }
  }
  return best ? { hub: best, km: bestKm } : null;
}

/** Pans the live map to a target when it changes (used on search-pick, not on drag — the pin's already in view). */
function MapPanner({ target }: { target: LatLng | null }) {
  const map = useMap();
  useEffect(() => {
    if (map && target) map.panTo(target);
  }, [map, target]);
  return null;
}

/**
 * Depots & hubs locator map. Shows every hub as a red pin; drop/drag/search a point and the
 * nearest hub turns green with its straight-line distance, plus an on-demand road-distance lookup.
 *
 * The straight-line answer is instant and free (client-side haversine). The live Google map needs
 * a browser key (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY); without it the map area shows a placeholder but
 * the search + nearest-hub answer keep working — the feature degrades, it never breaks.
 */
export function HubMap({ hubs }: { hubs: Hub[] }) {
  const apiKey = publicEnv.googleMapsApiKey;
  const points = useMemo(() => hubPoints(hubs), [hubs]);
  const center = useMemo<LatLng>(() => {
    if (points.length === 0) return UK_FALLBACK;
    return {
      lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
      lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
    };
  }, [points]);

  // The point being checked. Starts at the network centre so the pin is immediately draggable.
  const [locator, setLocator] = useState<LatLng>(center);
  // Human address when the point came from the search box — used as the road-distance origin.
  const [locatorLabel, setLocatorLabel] = useState<string | null>(null);
  // A separate target that only changes on search-pick, so the map pans then (not on every drag).
  const [panTarget, setPanTarget] = useState<LatLng | null>(null);
  const [query, setQuery] = useState("");
  const [drive, setDrive] = useState<
    { state: "idle" } | { state: "loading" } | { state: "ok"; miles: number; minutes: number } | { state: "error"; message: string }
  >({ state: "idle" });

  // Re-centre the starting pin if the hub network changes under it and the user hasn't moved it yet.
  useEffect(() => {
    setLocator((cur) => (cur === UK_FALLBACK ? center : cur));
  }, [center]);

  const nearest = useMemo(() => nearestOf(locator, points), [locator, points]);
  const nearestHub = nearest ? hubs.find((h) => h.id === nearest.hub.id) ?? null : null;
  const nearestAddress = nearestHub?.address?.trim() || null;

  const moveLocator = (ll: LatLng, label: string | null, pan: boolean) => {
    setLocator(ll);
    setLocatorLabel(label);
    setDrive({ state: "idle" });
    if (pan) setPanTarget({ ...ll });
  };

  const getDriving = async () => {
    if (!nearest || !nearestAddress) return;
    setDrive({ state: "loading" });
    try {
      const from = locatorLabel ?? `${locator.lat},${locator.lng}`;
      const res = await fetch("/api/hub-distance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: nearestAddress }),
      });
      const data = (await res.json()) as { success: boolean; miles?: number; minutes?: number; error?: string };
      if (data.success && data.miles != null && data.minutes != null) {
        setDrive({ state: "ok", miles: data.miles, minutes: data.minutes });
      } else {
        setDrive({ state: "error", message: data.error ?? "Could not get driving distance." });
      }
    } catch (err) {
      setDrive({ state: "error", message: err instanceof Error ? err.message : "Could not get driving distance." });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
      <p style={{ margin: 0, fontSize: font.xs, color: color.muted, lineHeight: 1.5 }}>
        Search an address, drag the blue pin, or click the map. The nearest hub turns{" "}
        <strong style={{ color: color.mapNearest }}>green</strong> — by straight-line distance.
      </p>

      <PlacesInput
        value={query}
        onChange={setQuery}
        onSelect={(s) => {
          setQuery(s.label);
          if (s.lat != null && s.lng != null) moveLocator({ lat: s.lat, lng: s.lng }, s.label, true);
        }}
        placeholder="Check a place — e.g. Coventry or CV1 2AB"
        style={inputStyle}
      />

      {apiKey ? (
        <div style={{ position: "relative", width: "100%", height: 340, borderRadius: 8, overflow: "hidden", border: `1px solid ${color.border}` }}>
          <APIProvider apiKey={apiKey}>
            <Map
              defaultCenter={center}
              defaultZoom={6}
              gestureHandling="greedy"
              disableDefaultUI={false}
              mapTypeControl={false}
              streetViewControl={false}
              clickableIcons={false}
              style={{ width: "100%", height: "100%" }}
              onClick={(e) => {
                const ll = e.detail.latLng;
                if (ll) moveLocator({ lat: ll.lat, lng: ll.lng }, null, false);
              }}
            >
              {points.map((p) => (
                <Marker
                  key={p.id}
                  position={{ lat: p.lat, lng: p.lng }}
                  title={p.name}
                  icon={nearest?.hub.id === p.id ? NEAREST_PIN : HUB_PIN}
                  zIndex={nearest?.hub.id === p.id ? 2 : 1}
                />
              ))}
              <Marker
                position={locator}
                title="Point being checked — drag me"
                icon={LOCATOR_PIN}
                zIndex={3}
                draggable
                onDragEnd={(e) => {
                  const ll = e.latLng;
                  if (ll) moveLocator({ lat: ll.lat(), lng: ll.lng() }, null, false);
                }}
              />
              <MapPanner target={panTarget} />
            </Map>
          </APIProvider>
        </div>
      ) : (
        <div
          style={{
            minHeight: 180,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            textAlign: "center",
            padding: spacing.lg,
            borderRadius: 8,
            border: `1px dashed ${color.border}`,
            background: color.surfaceSub,
            color: color.muted,
            fontSize: font.xs,
            lineHeight: 1.5,
          }}
        >
          <span style={{ fontWeight: 600, color: color.text }}>Live map disabled</span>
          <span>
            Add a browser map key to <code>.env.local</code> to switch it on:
          </span>
          <code style={{ background: color.surface, padding: "2px 6px", borderRadius: 4, fontSize: 11 }}>
            NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
          </code>
          <span>The nearest-hub answer below still works without it.</span>
        </div>
      )}

      {/* Result banner — the nearest hub + distance, the actual "which hub?" answer. */}
      {nearest && nearestHub ? (
        <div
          style={{
            border: `1px solid ${color.border}`,
            borderRadius: radius.input,
            background: color.surfaceSub,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <span style={{ fontSize: font.sm, color: color.text }}>
            Nearest hub:{" "}
            <strong style={{ color: color.mapNearest }}>{nearestHub.name}</strong> —{" "}
            <strong>{(nearest.km * KM_TO_MI).toFixed(0)} mi</strong> straight-line
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
            {nearestAddress ? (
              <button
                type="button"
                onClick={getDriving}
                disabled={drive.state === "loading"}
                style={driveBtn}
              >
                {drive.state === "loading" ? "Checking road…" : "Get driving distance"}
              </button>
            ) : (
              <span style={{ fontSize: font.xs, color: color.review.fg }}>
                Add this hub&rsquo;s address below to enable road distance.
              </span>
            )}
            {drive.state === "ok" && (
              <span style={{ fontSize: font.xs, color: color.text }}>
                {drive.miles.toFixed(0)} mi by road · {Math.round(drive.minutes)} min
              </span>
            )}
            {drive.state === "error" && (
              <span role="alert" style={{ fontSize: font.xs, color: color.error }}>{drive.message}</span>
            )}
          </div>
        </div>
      ) : (
        <p style={{ margin: 0, fontSize: font.xs, color: color.muted }}>
          No hubs to compare against yet — add one below.
        </p>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  borderRadius: radius.input,
  border: `1px solid ${color.border}`,
  background: color.surfaceSub,
  color: color.text,
  fontSize: font.sm,
};
const driveBtn: React.CSSProperties = {
  border: `1px solid ${color.border}`,
  borderRadius: 999,
  padding: "5px 12px",
  fontSize: font.xs,
  fontWeight: 600,
  background: color.surface,
  color: color.text,
  cursor: "pointer",
};
