# routing

Gets a driving distance/duration between addresses (single leg or a whole multi-stop chain) behind one `RouteProvider` interface. Does not price anything — that's `lib/pricing`'s job — and does not decide van/pack order, only returns the visiting `order` a caller can feed into packing.

## Key files
| File | Role |
|------|------|
| `types.ts` | `RouteProvider` interface, `RouteChainOptions`/`RouteChainResult`, `RoutingError` |
| `index.ts` | Factory `getRouteProvider()` — picks Google Maps or the straight-line fallback from config |
| `google-maps.provider.ts` | Real provider: Google Routes API v2, one request per whole stop chain (single-drop parity + optimize-order support) |
| `straight-line.provider.ts` | Fallback provider: haversine distance + configured average speed when no API key is set |
| `nominatim-geocoder.ts` | Shared, rate-limited (≤1 req/s — a hard external policy, intentionally a module constant, not config), cached OSM geocoder used only by the straight-line fallback |

## How it fits
Stage 5 (routing + pricing). `pricing/service.ts` and `stop-chain/engine.ts` call `getRouteProvider()` and never import a concrete provider directly (swap-seam). The chosen provider is selected once via `src/config/env.ts` (`ROUTE_PROVIDER` + `GOOGLE_MAPS_API_KEY`) — no env access happens inside this folder.

## Docs
- [`docs/architecture.md`](../../../docs/architecture.md) — overall pipeline and where Stage 5 sits
- [`docs/logistic-modes/multi-stop-full-load-plan.md`](../../../docs/logistic-modes/multi-stop-full-load-plan.md) — why chains route in one call and how `order` drives packing bands
