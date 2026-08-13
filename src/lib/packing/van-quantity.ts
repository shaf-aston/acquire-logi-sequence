/**
 * Single resolver for "how many copies of this van does the customer own" — every
 * fleet-availability site (the exact allocator, the bulk fast-path's split-retry,
 * the split-retry in packer.service.ts) used to inline its own `v.quantity ?? 5`.
 * That's the same business knob (default fleet depth per van) copy-pasted, so a
 * change to the default required editing every call site. One reader, one config
 * value (`packing.defaultVanQuantity`).
 */
import { getConfig } from "@/config/env";
import type { Van } from "@/lib/packing/packing.types";

/** A van's available copies: its own `quantity`, else the configured default. */
export function vanQuantity(van: Van): number {
  return van.quantity ?? getConfig().packing.defaultVanQuantity;
}
