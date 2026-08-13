/** Stage 3 — durability/orientation classification domain types (Material text → stacking safety facts). */

export type DurabilityTier = "none" | "low" | "medium" | "high";

/**
 * fixed  = must ship in its natural orientation (never tipped/rotated).
 * partial = may rotate around the vertical axis only (stays upright, any facing).
 * none   = any of the 6 axis permutations is acceptable.
 */
export type OrientationLock = "fixed" | "partial" | "none";

export interface DurabilityClassification {
  readonly material: string;
  readonly durabilityTier: DurabilityTier;
  /**
   * Snaps instead of deforming (glass, ceramic, stone, plasterboard). Enforced: it
   * caps the durability tier used for the crush-limit lookup at "low" and softens
   * the result by `brittleFactor` (config/durability-tiers.json), same mechanism
   * as `deformable`.
   */
  readonly brittle: boolean;
  /**
   * Compresses and recovers rather than breaking (foam, fabric). Enforced: it
   * softens the assembled item's crush limit by `deformableFactor`
   * (config/durability-tiers.json) in item-assembler.ts, so less may rest on top
   * than on a rigid item of the same tier. (No lateral-support model — vertical
   * crush + fragility only.)
   */
  readonly deformable: boolean;
  readonly orientationLock: OrientationLock;
  /** false when the engine couldn't classify this material and a conservative fallback was used. */
  readonly confident: boolean;
  readonly reason: string;
}

/**
 * A human correction of the three ENFORCED stacking facts for one packed row
 * (keyed by row id in the assembler). deformable is intentionally absent — it has
 * no reviewer override (unlike durabilityTier/brittle/orientationLock), even
 * though it IS enforced automatically via the deformableFactor crush-limit
 * multiply (see item-assembler.ts). An override is fed through the same
 * conservative blend as an auto classification.
 */
export interface DurabilityOverride {
  readonly durabilityTier: DurabilityTier;
  readonly brittle: boolean;
  readonly orientationLock: OrientationLock;
}

export interface DurabilityClassifier {
  readonly provider: string;
  /** Classifies each distinct material string once; callers may pass duplicates freely. */
  classify(materials: readonly string[]): Promise<Map<string, DurabilityClassification>>;
}
