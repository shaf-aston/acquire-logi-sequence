import { describe, expect, it } from "vitest";
import { detectHubConsolidationManifest } from "@/lib/ingestion/hub-manifest-detector";
import type { StructuredDocument, PageContent, ExtractedTable } from "@/lib/conversion/types";

/**
 * The ingest-time hub-consolidation detector: BOTH a pallet column AND consolidation
 * wording are required, so a plain single-drop quote is never flagged.
 */

const table = (headers: string[]): ExtractedTable => ({ index: 0, headers, rows: [] });
const page = (markdown: string, tables: ExtractedTable[]): PageContent => ({ index: 0, markdown, tables });
const doc = (pages: PageContent[]): StructuredDocument => ({
  pageCount: pages.length,
  tableCount: pages.reduce((n, p) => n + p.tables.length, 0),
  pages,
});

describe("detectHubConsolidationManifest", () => {
  it("flags a groupage manifest (pallet table + consolidation wording)", () => {
    const d = doc([
      page(
        "# SwiftHaul Logistics\nGroupage Consolidation — Regional Collections → Hub → Hub → Deliveries",
        [table(["#", "Collection Company", "Address", "Pallets", "Pallet Size (cm)"])],
      ),
    ]);
    const sig = detectHubConsolidationManifest(d);
    expect(sig.isHubManifest).toBe(true);
    expect(sig.reasons.length).toBeGreaterThan(0);
  });

  it("does NOT flag a plain quote with pallets but no consolidation wording", () => {
    const d = doc([page("Standard delivery quote", [table(["Item", "Pallets", "Weight"])])]);
    expect(detectHubConsolidationManifest(d).isHubManifest).toBe(false);
  });

  it("does NOT flag a manifest with consolidation wording but no pallet column", () => {
    const d = doc([page("Groupage consolidation route", [table(["Item", "L x W x D", "Qty"])])]);
    expect(detectHubConsolidationManifest(d).isHubManifest).toBe(false);
  });

  it("does NOT flag an ordinary single-drop cargo sheet", () => {
    const d = doc([page("Delivery note", [table(["Item Description", "Height", "Width", "Weight"])])]);
    expect(detectHubConsolidationManifest(d).isHubManifest).toBe(false);
  });

  it("detects consolidation wording that appears in a table header, not just prose", () => {
    // "Origin Company" is the roster column — the per-consignment statement of WHOSE goods these are,
    // which is what makes a load shared rather than merely palletised. Real consolidation manifests
    // carry it (see docs/quotation-pdf-examples/02-groupage/**), and it is now required.
    const d = doc([
      page("", [
        table(["#", "Pallets", "Pallet Size"]),
        table(["Origin Company", "Consolidated Cargo Summary", "Qty"]),
      ]),
    ]);
    expect(detectHubConsolidationManifest(d).isHubManifest).toBe(true);
  });

  it("does NOT flag one shipper's own pallet job, however much hub/trunk wording it carries", () => {
    // The regression this guards, from docs/quotation-pdf-examples/03-manifest-variants/multi-drop:
    // a single shipper delivering its own 266 pallets to three shops, routed via a hub. It has a
    // Pallets column and says "GROUPAGE MANIFEST" and "trunk" all over it — but it names no
    // consignors and no collection addresses, because there is only one consignor. It was being sent
    // to the shared-truck planner, which found no companies and quoted NOTHING, on a job the standard
    // packer reads exactly right (266 pallets, 35,910 kg). An empty quote is worse than a wrong one.
    const d = doc([
      page("GROUPAGE MANIFEST — MULTI-DROP (3 STOPS). Via SWI Hub. Trunk to Birmingham.", [
        table(["Stop", "#", "Item Description", "Material", "Quantity", "Height (cm)", "Weight (kg)", "Pallets"]),
      ]),
    ]);
    expect(detectHubConsolidationManifest(d).isHubManifest).toBe(false);
  });
});
