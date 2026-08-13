/** Stage 2 — fragility classification domain types. */

export type Fragility = "fragile" | "standard";

export interface ClassifiedItem {
  /** Where this item sits in the structured document, for traceability + UI mapping. */
  readonly pageIndex: number;
  readonly tableIndex: number;
  readonly rowIndex: number;
  /** Human-readable item label (description / material text used for the decision). */
  readonly label: string;
  readonly fragility: Fragility;
  /** false when the rules didn't match and we fell back to the default — flag for review. */
  readonly confident: boolean;
  /** Which keyword drove the decision, or null when defaulted. */
  readonly matchedTerm: string | null;
  readonly reason: string;
}

export interface ClassificationCounts {
  readonly fragile: number;
  readonly standard: number;
  readonly lowConfidence: number;
}

export interface ClassificationResult {
  readonly provider: string;
  readonly items: ClassifiedItem[];
  readonly counts: ClassificationCounts;
}

export interface Classifier {
  readonly provider: string;
  classify(doc: import("@/lib/conversion/types").StructuredDocument): Promise<ClassificationResult>;
}
