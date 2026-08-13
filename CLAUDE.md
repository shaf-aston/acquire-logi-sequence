# Project Vision & Architectural Overview

> **Where the real docs live:** this file is the constitution — short on purpose.
> The detailed specs live in [`docs/`](docs/README.md); start at
> [`docs/architecture.md`](docs/architecture.md). Sub-agents are wired in
> [`.claude/agents/`](.claude/agents/).

## 1. Core Vision
An automated logistical quoting pipeline that maps dimensions, optimizes 3D space configuration inside fleet vans, tracks transit routing via Google Maps API, and dynamically calculates client costs using preset mileage rates.

## 2. Core Constraints & Engineering Rules
* **Hyper-Modular codebase following best coding design practices** - MRMR, loose coupling, high cohesion, SRP, use reusable compoonents, NEVER hardcode! NEVER overengineer! 
* **Config, not constants:** Tunable domain knobs live in JSON — `config/vans.json` (fleet + per-mile rates), `config/stackability.json` (stacking matrix + densities), `config/column-map.json` (table columns + category codes), `config/durability-rules.json` (Material → durability/brittle/deformable/orientation keyword ruleset), `config/durability-tiers.json` (durabilityTier → crush-pressure mapping) — and `src/config/env.ts` is the only reader of `process.env`. Change behaviour by editing config, not code.
* **Design System:** All colors via CSS custom properties in `src/app/globals.css :root`. No hardcoded hex anywhere in `src/`. Palette and component patterns in [`docs/code-rules.md`](docs/code-rules.md). Visual reference (Moverta aesthetic) in [`docs/ui-reference.md`](docs/ui-reference.md).
* **Plan & Execute in Micro-Steps:** Break every feature down into independent milestones.
* Critical, blunt, think independantly completely. Fact-based, no bias
* **Never Guess. Always Prove:** Every calculation and function must be systematically verified. Be clear if not understand
* **UI:** All features must have visual testing capability for dev
* **Milestone/Phased Discipline:** Structured Dev. Every milestone is an independent, verifiable unit of work — completed and checked before the next begins.
* **Language: Logical Flow** Prefer Sequenced Microsteps LOGICAL FLOW, Reasonable, Simple 12 yr old Language Communication, Explain from First Principles

## 3. System Architecture & Multi-Agent Matrix
Development utilizes Anthropic Claude Code frameworks, driving three specialized sub-agents:
* **Architect Agent:** Validates module boundaries, data ingestion flow, and 3D geometric math models.
* **Design Agent:** Oversees UI components, preset selectors, and 3D calculation visualizations.
* **Security Agent:** Scans code for vulnerabilities and ensures private keys (e.g., Google Maps API) remain secured.

## 4. End-to-End Execution Roadmap
Status is tracked per-stage in [`docs/README.md`](docs/README.md); this is the high-level map.
* **ML-0:** Core Rules Setup (`CLAUDE.md`). ✅ Built
* **ML-1:** Admin Dashboard: Fleet Van Presets (Dimensions, Widths) & Base Per-Mile Rates. 🚧 Config-driven via `config/vans.json`; admin UI in progress.
* **ML-2:** Core Processor: Cargo Data Ingestion, Classification, & 3D Volume Calculation Engine. ✅ Built (Stages 1–3)
* **ML-3:** Visualization: Front-end 3D Space Render & Interactive Layout Display. ✅ Built (Stage 4) — drag/drop editing, unplaced-item tray, PNG export
* **ML-4:** Logistics: Google Maps API Routing integration & dynamic price quotation output. ✅ Built (Stage 5)