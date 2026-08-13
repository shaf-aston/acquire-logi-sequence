/**
 * Client-safe public configuration.
 *
 * `NEXT_PUBLIC_*` variables are inlined into the browser bundle by Next.js at build time, so —
 * unlike `src/config/env.ts`, which reads server-only secrets and must never reach the client —
 * these are readable inside client components. Keeping them here means there is still exactly one
 * module per side that touches the environment (server secrets → env.ts; public build-time vars →
 * this file), satisfying the "one designated env reader" rule without importing server secrets
 * into client code.
 *
 * The reference MUST stay a literal `process.env.NEXT_PUBLIC_…` member access — that is the only
 * form Next.js statically replaces at build time.
 */
export const publicEnv = {
  /** Browser Google Maps JavaScript API key. Empty string = live map disabled (graceful fallback). */
  googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
  /** Show the per-van packing debug panel (dev/ops only). NEXT_PUBLIC_ so it's readable client-side. */
  debugPanel: process.env.NEXT_PUBLIC_DEBUG_PANEL === "1",
} as const;
