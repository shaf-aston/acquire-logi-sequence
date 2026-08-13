# Logistics Modes

How the pipeline's **Pack / Route / Price** stages change shape for logistics models beyond
today's shipped van-based single-drop. The shared core (Ingest → Classify) never changes —
see [`../architecture.md`](../architecture.md) for the base pipeline these modes plug into.

Read in this order:

1. **[logistics-modes-flows.md](logistics-modes-flows.md)** — the map. Walks all modes side
   by side (today's single-drop, multi-stop, groupage) as the same 7 conceptual steps, with
   only ⭐-marked steps differing between them. Start here to see how any one mode relates to
   the others.
2. **[multi-stop-full-load-plan.md](multi-stop-full-load-plan.md)** — the reusable **stop-chain
   engine**: an ordered list of stops (`pickup`/`drop`, address, items) that both multi-drop
   delivery and multi-pickup collection are configurations of, not separate features.
3. **[groupage.md](groupage.md)** — the operational blueprint for shared-truck/groupage
   (hubs, catchments, leg chains, pallet-space + weight capacity). Plain-text business logic
   is the source of truth; the diagram at the end only illustrates it.
4. **[groupage-implementation-plan.md](groupage-implementation-plan.md)** — companion to
   `groupage.md`: what gets built now, in what order, and exactly which existing files each
   piece plugs into. This is the source of truth for *build scope/sequencing*, not the business
   logic itself.
