# src/config

The single source of truth for runtime configuration. Owns typed, validated, cached access to `process.env`; does not own the domain-knob JSON files themselves (those live in [`../../config/`](../../config/README.md)) or any business logic.

## Key files
| File | Role |
|------|------|
| `env.ts` | Builds + validates `AppConfig` from `process.env` once at first import (`getConfig()`), with an explicit-source variant for tests/CLI (`buildConfigFrom()`) |
| `__tests__/env.test.ts` | Unit tests for env-var coercion/validation edge cases (e.g. rejecting `ROUTE_RETURN_FACTOR=0`, multi-stop knob defaults) |

## How it fits
Every service module across all five pipeline stages plus groupage/stop-chain calls `getConfig()` here instead of touching `process.env` directly — this is the sole reader. `env.ts` also holds the default file paths for every JSON in `config/` (address detection, fragility/durability rules, stackability, vans, hubs, groupage rates), each overridable via its own env var.

## Docs
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Config, not constants" rule (section 2): `src/config/env.ts` is the only reader of `process.env`
