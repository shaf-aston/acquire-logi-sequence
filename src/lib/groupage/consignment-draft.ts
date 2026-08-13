/**
 * Consignment DRAFT rules — the pure domain logic behind the Shared-Truck Planner's "gather
 * consignments" step, lifted out of the view so it is single-sourced and unit-testable.
 *
 * A draft is a consignment held in EDITABLE (string) form while the operator assembles it, before
 * it becomes a domain `ConsignmentDraft` the planner packs. The two rules that matter most live
 * here: `draftReady` (enough filled in to add) and `draftClean` (ready AND nothing the reader was
 * unsure of) — the "never auto-trust a flagged guess" rule the planner leans on in several places.
 *
 * Pure: no React, no I/O, no `@/types/api` — depends only on groupage domain types, so the layer
 * stays clean (the UI/wire mapping that touches `SessionHub` stays in the component).
 */
import type { GroupagePallet, PalletFootprintClass } from "./groupage.types";
import type { GroupageConsignmentRecord } from "./consignment.store";
import type { ConsignmentReviewField, ReadConsignmentDraft } from "./consignment-reader.types";

export interface PalletLine {
  footprint: PalletFootprintClass;
  weightKg: string;
  quantity: string;
}
export interface ConsignmentDraft {
  company: string;
  originPostcode: string;
  destinationPostcode: string;
  pallets: GroupagePallet[];
}
/** A consignment the reader lifted off a document, held in editable (string) form until the
 *  operator confirms it. `review` carries the fields the reader flagged as uncertain. */
export interface ReadDraft {
  company: string;
  originPostcode: string;
  destinationPostcode: string;
  lines: PalletLine[];
  review: ConsignmentReviewField[];
}

export const emptyLine = (): PalletLine => ({ footprint: "full", weightKg: "", quantity: "1" });

/** Company key encoded in a pallet's itemId (`<key>#<footprint>-<n>`) — survives drags/reorders. */
export const companyKeyOf = (itemId: string): string => {
  const i = itemId.indexOf("#");
  return i < 0 ? itemId : itemId.slice(0, i);
};

/** A recent-quote row, once selected, becomes a consignment via this shape (drops id/createdAt). */
export const recordToConsignment = (r: GroupageConsignmentRecord): ConsignmentDraft => ({
  company: r.company,
  originPostcode: r.originPostcode,
  destinationPostcode: r.destinationPostcode,
  pallets: [...r.pallets],
});

/** Pallet lines → domain pallets, dropping any line whose weight is still blank (unconfirmed). */
export const linesToPallets = (lines: PalletLine[]): GroupagePallet[] =>
  lines
    .filter((l) => l.weightKg.trim() !== "")
    .map((l) => ({ footprint: l.footprint, weightKg: Number(l.weightKg), quantity: Number(l.quantity) || 1 }));

/** A read roster (nullable, reader's guess) → editable drafts. A 0-weight pallet the reader
 *  defaulted comes through as a BLANK weight, so the operator is forced to fill it in. */
export const rosterToDrafts = (consignments: ReadConsignmentDraft[]): ReadDraft[] =>
  consignments.map((c) => ({
    company: c.company ?? "",
    originPostcode: c.originPostcode ?? "",
    destinationPostcode: c.destinationPostcode ?? "",
    lines:
      c.pallets.length > 0
        ? c.pallets.map((p) => ({
            footprint: p.footprint,
            weightKg: p.weightKg > 0 ? String(p.weightKg) : "",
            quantity: String(p.quantity),
          }))
        : [emptyLine()],
    review: [...c.needsReview],
  }));

/** A draft is ready to add once it has a company, both postcodes, and ≥1 weighed pallet line. */
export const draftReady = (d: ReadDraft): boolean =>
  d.company.trim() !== "" &&
  d.originPostcode.trim() !== "" &&
  d.destinationPostcode.trim() !== "" &&
  linesToPallets(d.lines).length > 0;

/** A "clean" draft is one the reader was fully confident about: ready AND with no flagged fields.
 *  Only these are auto-accepted onto the truck when a document is read — anything the reader was
 *  unsure of (a ⚠ field) stays in the confirm list, so we never silently trust a guess. */
export const draftClean = (d: ReadDraft): boolean => draftReady(d) && d.review.length === 0;

/** Editable draft → the domain consignment the planner packs (drops review/UI-only fields). */
export const draftToConsignment = (d: ReadDraft): ConsignmentDraft => ({
  company: d.company.trim(),
  originPostcode: d.originPostcode.trim(),
  destinationPostcode: d.destinationPostcode.trim(),
  pallets: linesToPallets(d.lines),
});

/** Identity of a consignment for de-duplication: same company on the same route is the same pickup.
 *  Case/space-insensitive so a re-read of the same manifest matches its earlier read. */
export const consignmentKey = (c: {
  company: string;
  originPostcode: string;
  destinationPostcode: string;
}): string =>
  `${c.company.trim().toLowerCase()}|${c.originPostcode.trim().toLowerCase()}|${c.destinationPostcode.trim().toLowerCase()}`;
