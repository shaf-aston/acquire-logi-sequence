import { describe, expect, it } from "vitest";
import { parseCollectionRunRoster } from "@/lib/groupage/collection-run-parser";
import type { ExtractedTable, PageContent, StructuredDocument } from "@/lib/conversion/types";

/**
 * The offline collection-run parser: reads a groupage manifest's structured `Pallets`
 * column into a roster, without an LLM. The load-bearing guarantees are (1) it reads the
 * AUTHORITATIVE pallet count, never the per-piece cargo summary (the 10,000-carton trap),
 * and (2) it never false-matches a plain single-drop quote's route/cargo tables.
 */

const table = (index: number, headers: string[], rows: string[][]): ExtractedTable => ({ index, headers, rows });
const page = (tables: ExtractedTable[], markdown = ""): PageContent => ({ index: 0, markdown, tables });
const doc = (tables: ExtractedTable[]): StructuredDocument => ({
  pageCount: 1,
  tableCount: tables.length,
  pages: [page(tables)],
});

/** The HUB TRANSFER section that names the shared destination hub. */
const hubTransferTable = (destCellWithPostcode: string): ExtractedTable =>
  table(0, ["Origin Hub", "Destination Hub", "Operator / Trunk Vehicle"], [["SwiftHaul Origin Hub ...", destCellWithPostcode, "Trunk operator ..."]]);

const collectionRunHeaders = ["Stop", "Collection Company / Contact", "Collection Address", "Est. Arrival", "Pallets", "Pallet Size (cm)"];

describe("parseCollectionRunRoster — happy path (multi-company)", () => {
  it("reads one consignment per company row with the authoritative pallet count + shared dest hub", () => {
    const d = doc([
      hubTransferTable("SwiftHaul Nottingham Distribution Hub, Nottingham, NG4 2JT, UK"),
      table(1, collectionRunHeaders, [
        ["1", "Brighouse Textile Finishers Ltd Contact: Amanda Kerridge +44 1484 715 220", "Unit 6, Brighouse Trade Park Brighouse, HD6 1UB, UK", "07:00", "3", "120 x 100 x 110 (H)"],
        ["2", "Elland Metal Pressings Contact: Steve Ackroyd +44 1422 373 410", "Elland Industrial Estate Elland, HX5 9HT, UK", "07:45", "4", "120 x 80 x 130 (H)"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments.map((c) => c.company)).toEqual(["Brighouse Textile Finishers Ltd", "Elland Metal Pressings"]);
    expect(consignments.map((c) => c.originPostcode)).toEqual(["HD6 1UB", "HX5 9HT"]);
    expect(consignments.every((c) => c.destinationPostcode === "NG4 2JT")).toBe(true);
    expect(consignments.map((c) => c.pallets[0]!.quantity)).toEqual([3, 4]);
    // Weight is unstated in a collection run — always 0 and always flagged for review.
    expect(consignments.every((c) => c.pallets[0]!.weightKg === 0)).toBe(true);
    expect(consignments.every((c) => c.needsReview.includes("pallets"))).toBe(true);
    // Company / origin / dest were all read cleanly ⇒ not flagged.
    expect(consignments.every((c) => !c.needsReview.includes("company"))).toBe(true);
    expect(consignments.every((c) => !c.needsReview.includes("originPostcode"))).toBe(true);
    expect(consignments.every((c) => !c.needsReview.includes("destinationPostcode"))).toBe(true);
  });

  it("reads a stated Weight (kg) column so the line needs a confirm, not a manual weight", () => {
    const headersWithWeight = ["Stop", "Collection Company / Contact", "Collection Address", "Est. Arrival", "Pallets", "Weight (kg)", "Pallet Size (cm)"];
    const d = doc([
      table(0, headersWithWeight, [
        ["1", "Marlowe Distribution Ltd Contact: Ian Castellan", "1 Marlowe Way Croydon, CR0 4XA, UK", "07:00", "2", "1,250 kg", "120 x 100 x 100 (H)"],
        ["2", "Marlowe Distribution Ltd Contact: Nadia Rourke", "14 Purley Way Croydon, CR0 3RL, UK", "07:40", "1", "640", "120 x 80 x 60 (H)"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments.map((c) => c.pallets[0]!.weightKg)).toEqual([1250, 640]);
    // A read weight ⇒ the pallet line is NOT flagged, so the operator can add it on one confirm.
    expect(consignments.every((c) => !c.needsReview.includes("pallets"))).toBe(true);
  });

  it("still leaves weight blank + flagged when the manifest has NO weight column", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Marlowe Distribution Ltd", "1 Marlowe Way Croydon, CR0 4XA, UK", "07:00", "2", "120 x 100 x 100 (H)"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments[0]!.pallets[0]!.weightKg).toBe(0);
    expect(consignments[0]!.needsReview).toContain("pallets");
  });

  it("does NOT mistake the 'Pallet Size (cm)' column for a weight column", () => {
    // "Pallet Size (cm)" carries dimensions, never kg — the weight detector must skip it.
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Marlowe Distribution Ltd", "1 Marlowe Way Croydon, CR0 4XA, UK", "07:00", "2", "120 x 100 x 100 (H)"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments[0]!.pallets[0]!.weightKg).toBe(0); // size column not read as weight
  });

  it("keeps same-company multi-site rows as distinct consignments (different origins)", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Marlowe Distribution Ltd — Site A (Parts Store) Contact: Ian Castellan", "1 Marlowe Way Croydon, CR0 4XA, UK", "07:00", "2", "120 x 100 x 100 (H)"],
        ["2", "Marlowe Distribution Ltd — Site B (Packaging Depot) Contact: Nadia Rourke", "14 Purley Way Croydon, CR0 3RL, UK", "07:40", "1", "120 x 80 x 60 (H)"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    // The "— Site A" suffix is stripped so all sites share one company label (one colour).
    expect(consignments.map((c) => c.company)).toEqual(["Marlowe Distribution Ltd", "Marlowe Distribution Ltd"]);
    expect(consignments.map((c) => c.originPostcode)).toEqual(["CR0 4XA", "CR0 3RL"]);
    expect(consignments.reduce((n, c) => n + c.pallets[0]!.quantity, 0)).toBe(3);
  });
});

describe("parseCollectionRunRoster — weight CALCULATED from the cargo summary", () => {
  // The real simple4 shape: collection run gives pallet counts (no weight column); the
  // CONSOLIDATED CARGO SUMMARY gives per-unit weight × qty, keyed by a SHORTER company name.
  const cargoSummary = (rows: string[][]): ExtractedTable =>
    table(2, ["Origin Company", "Material / Goods Description", "L x W x D (cm)", "Line Weight", "Qty (units)"], rows);

  it("fills per-pallet weight = Σ(unit weight × qty) ÷ pallet count, matching short↔full names", () => {
    const d = doc([
      hubTransferTable("SwiftHaul Nottingham Distribution Hub, Nottingham, NG4 2JT, UK"),
      table(1, collectionRunHeaders, [
        ["2", "Elland Metal Pressings Contact: Steve Ackroyd +44 1422 373 410", "Elland Industrial Estate Elland, HX5 9HT, UK", "07:45", "4", "120 x 80 x 130 (H)"],
        ["3", "Huddersfield Pharma Packaging Contact: Nusrat Jabeen", "Leeds Road Trade Park Huddersfield, HD1 6PQ, UK", "08:30", "2", "100 x 120 x 90 (H)"],
      ]),
      cargoSummary([
        // Elland: 16×150 + 34×20 = 2400 + 680 = 3080 over 4 pallets → 770 kg/pallet
        ["Elland Metal Pressings", "Pressed steel components, boxed", "60 x 40 x 30", "16 kg/carton", "150"],
        ["Elland Metal Pressings", "Metal offcuts, bundled", "100 x 60 x 40", "34 kg/bundle", "20"],
        // "Huddersfield Pharma" (short) must match "Huddersfield Pharma Packaging": 6×400 = 2400 over 2 → 1200
        ["Huddersfield Pharma", "Pharmaceutical packaging cartons, boxed", "50 x 35 x 30", "6 kg/carton", "400"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments.map((c) => c.pallets[0]!.weightKg)).toEqual([770, 1200]);
    // A cleanly-calculated, plausible weight ⇒ NOT flagged; adds on a single confirm.
    expect(consignments.every((c) => !c.needsReview.includes("pallets"))).toBe(true);
  });

  it("prefers a stated weight column over a calculated one", () => {
    const headersWithWeight = ["Stop", "Collection Company / Contact", "Collection Address", "Est. Arrival", "Pallets", "Weight (kg)", "Pallet Size (cm)"];
    const d = doc([
      table(0, headersWithWeight, [
        ["1", "Elland Metal Pressings", "Elland, HX5 9HT, UK", "07:45", "4", "500", "120 x 80 x 130 (H)"],
      ]),
      cargoSummary([["Elland Metal Pressings", "Pressed steel, boxed", "60 x 40 x 30", "16 kg/carton", "150"]]),
    ]);
    // The stated 500 wins; the summary-derived 770 is not used.
    expect(parseCollectionRunRoster(d).consignments[0]!.pallets[0]!.weightKg).toBe(500);
  });

  it("keeps but FLAGS an implausibly heavy calculated per-pallet weight (doubtful → confirm)", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Netherfield Plastics Manufacturing", "Nottingham, NG4 2QP, UK", "07:30", "8", "120 x 100 x 160 (H)"],
      ]),
      cargoSummary([["Netherfield Plastics", "Injection-moulded containers", "120 x 100 x 160", "5 kg/carton", "10000"]]),
    ]);
    const c = parseCollectionRunRoster(d).consignments[0]!;
    // 5 × 10000 = 50000 over 8 pallets = 6250 kg/pallet — kept, but flagged as doubtful.
    expect(c.pallets[0]!.weightKg).toBe(6250);
    expect(c.needsReview).toContain("pallets");
  });

  it("matches an ABBREVIATED cargo-summary name to the full collection-run name (Mat. → Materials)", () => {
    // The real simple5 trap: the cargo summary truncates "Materials" to "Mat.", so a strict
    // token-subset match misses it and the line comes back blank. Prefix-tolerant matching fixes it.
    const d = doc([
      table(0, collectionRunHeaders, [
        ["4", "Gedling Building Materials Contact: Owen Priestley", "Gedling Trade Estate Nottingham, NG4 4AT, UK", "09:30", "10", "120 x 100 x 100 (H)"],
      ]),
      cargoSummary([
        // 25×800 + 38×1 = 20,038 over 10 pallets = 2003.8 → 2004 kg/pallet (plausible, not flagged)
        ["Gedling Building Mat.", "Bagged cement", "60 x 40 x 15", "25 kg/bag", "800"],
        ["Gedling Building Mat.", "Roofing tile sample, crated", "80 x 60 x 20", "38 kg", "1"],
      ]),
    ]);
    const c = parseCollectionRunRoster(d).consignments[0]!;
    expect(c.pallets[0]!.weightKg).toBe(2004);
    expect(c.needsReview).not.toContain("pallets");
  });

  it("treats the doubtful ceiling as a config knob (opts) — a lower ceiling flags a mid-weight line", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Elland Metal Pressings", "Elland, HX5 9HT, UK", "07:45", "4", "120 x 80 x 130 (H)"],
      ]),
      // 16×150 + 34×20 = 3080 over 4 = 770 kg/pallet — clean at the default 2500 ceiling…
      cargoSummary([
        ["Elland Metal Pressings", "Pressed steel, boxed", "60 x 40 x 30", "16 kg/carton", "150"],
        ["Elland Metal Pressings", "Metal offcuts, bundled", "100 x 60 x 40", "34 kg/bundle", "20"],
      ]),
    ]);
    expect(parseCollectionRunRoster(d).consignments[0]!.needsReview).not.toContain("pallets");
    // …but flagged doubtful once the config ceiling is tightened below 770.
    const flagged = parseCollectionRunRoster(d, { maxPlausibleDerivedPalletKg: 500 }).consignments[0]!;
    expect(flagged.pallets[0]!.weightKg).toBe(770); // kept, never blocked
    expect(flagged.needsReview).toContain("pallets");
  });

  it("leaves weight blank when no cargo-summary company matches", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Marlowe Distribution Ltd", "Croydon, CR0 4XA, UK", "07:00", "2", "120 x 100 x 100 (H)"],
      ]),
      cargoSummary([["Some Other Company", "Widgets", "60 x 40 x 30", "10 kg/carton", "50"]]),
    ]);
    const c = parseCollectionRunRoster(d).consignments[0]!;
    expect(c.pallets[0]!.weightKg).toBe(0);
    expect(c.needsReview).toContain("pallets");
  });
});

describe("parseCollectionRunRoster — paginated collection run (fail-loud, no dropped rows)", () => {
  it("reads rows from EVERY collection-run table, not just the first (page-break split)", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Company A", "Leeds, LS1 1AA, UK", "07:00", "3", "120 x 100 x 100 (H)"],
      ]),
      table(1, collectionRunHeaders, [
        ["2", "Company B", "Leeds, LS2 2BB, UK", "07:30", "5", "120 x 100 x 100 (H)"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments.map((c) => c.company)).toEqual(["Company A", "Company B"]);
    expect(consignments.reduce((n, c) => n + c.pallets[0]!.quantity, 0)).toBe(8);
  });
});

describe("parseCollectionRunRoster — the 10,000-carton trap", () => {
  it("reads the Pallets column (45), NEVER the cargo summary's Qty (units) 10000 line", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Colwick Bulk Packaging Ltd", "Nottingham, NG4 2AN, UK", "06:30", "12", "120 x 100 x 150 (H)"],
        ["2", "Netherfield Plastics Manufacturing", "Nottingham, NG4 2QP, UK", "07:30", "8", "120 x 100 x 160 (H)"],
        ["3", "Carlton Warehousing Solutions", "Nottingham, NG4 3AA, UK", "08:30", "15", "120 x 80 x 140 (H)"],
        ["4", "Gedling Building Materials", "Nottingham, NG4 4AT, UK", "09:30", "10", "120 x 100 x 100 (H)"],
      ]),
      // The explosive per-piece cargo summary — has a company column but NO Pallets column
      // (it uses "Qty (units)"), so the parser must never pick it up.
      table(1, ["Origin Company", "Material / Goods Description", "L x W x D (cm)", "Line Weight", "Qty (units)"], [
        ["Netherfield Plastics", "Injection-moulded plastic containers, boxed", "120 x 100 x 160", "5 kg/carton", "10000"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments).toHaveLength(4);
    expect(consignments.reduce((n, c) => n + c.pallets[0]!.quantity, 0)).toBe(45);
    // The 10,000 must appear nowhere in the roster.
    expect(consignments.every((c) => c.pallets.every((p) => p.quantity <= 15))).toBe(true);
  });
});

describe("parseCollectionRunRoster — no false positives", () => {
  it("returns an empty roster for a plain single-drop cargo table (no Pallets column)", () => {
    const d = doc([
      table(0, ["Stop", "Item / Material", "L (cm)", "W (cm)", "D (cm)", "Weight/Unit", "Qty"], [
        ["1", "Steel workbenches, flat-packed", "180", "70", "15", "42 kg", "20"],
      ]),
    ]);
    expect(parseCollectionRunRoster(d).consignments).toEqual([]);
  });

  it("returns an empty roster for a route table that has a company + address but no Pallets column", () => {
    const d = doc([
      table(0, ["Stop", "Type", "Company / Contact", "Address", "Notes"], [
        ["1", "COLLECTION", "Radford Engineering Supplies Ltd", "Nottingham, NG7 5DT", "Loading bay 2"],
      ]),
    ]);
    expect(parseCollectionRunRoster(d).consignments).toEqual([]);
  });

  it("returns an empty roster for a document with no tables", () => {
    expect(parseCollectionRunRoster({ pageCount: 0, tableCount: 0, pages: [] }).consignments).toEqual([]);
  });
});

describe("parseCollectionRunRoster — footprint classification + honest flags", () => {
  it("classifies base footprint from L×W and flags a missing destination hub", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Full Co", "Leeds, LS1 1AA, UK", "07:00", "1", "120 x 100 x 100 (H)"], // 12000 cm² → full
        ["2", "Half Co", "Leeds, LS2 2BB, UK", "07:10", "1", "80 x 60 x 100 (H)"], // 4800 cm² → half
        ["3", "Quarter Co", "Leeds, LS3 3CC, UK", "07:20", "1", "50 x 40 x 40 (H)"], // 2000 cm² → quarter
        ["4", "Oversize Co", "Leeds, LS4 4DD, UK", "07:30", "1", "300 x 120 x 100 (H)"], // side > 240 → oversize
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments.map((c) => c.pallets[0]!.footprint)).toEqual(["full", "half", "quarter", "oversize"]);
    // No HUB TRANSFER table ⇒ destination unknown ⇒ null + flagged, never guessed.
    expect(consignments.every((c) => c.destinationPostcode === null)).toBe(true);
    expect(consignments.every((c) => c.needsReview.includes("destinationPostcode"))).toBe(true);
  });

  it("flags a row whose company is unreadable but keeps the pallet count", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Contact: only a contact line +44 111 222 333", "Hull, HU1 1AA, UK", "07:00", "5", "120 x 100 x 120 (H)"],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    expect(consignments).toHaveLength(1);
    expect(consignments[0]!.company).toBeNull();
    expect(consignments[0]!.needsReview).toContain("company");
    expect(consignments[0]!.pallets[0]!.quantity).toBe(5);
  });
});

/**
 * The two defects that made a real hub manifest (large-multi-hub.pdf) come back unweighed:
 * OCR splitting one entry across several rows, and the delivery leg being read as freight.
 */
describe("parseCollectionRunRoster — unreadable pallet count (Bug 0.3)", () => {
  it("keeps quantity 1 but FLAGS the line when the Pallets cell is blank/unreadable — never a silent 1", () => {
    // A READABLE weight column is included so weightKg !== null — the pre-existing
    // "weightKg === null" branch cannot be the one raising the flag here. The ONLY
    // possible cause of "pallets" in needsReview is the unread "N/A" pallet count.
    const headersWithWeight = ["Stop", "Collection Company / Contact", "Collection Address", "Est. Arrival", "Pallets", "Weight (kg)", "Pallet Size (cm)"];
    const d = doc([
      table(0, headersWithWeight, [
        // "N/A" has no digit — a smudged/blank cell in the real world. Cargo is NOT dropped
        // (losing it is worse than mis-counting it), but the operator MUST be asked.
        ["1", "Marlowe Distribution Ltd", "1 Marlowe Way Croydon, CR0 4XA, UK", "07:00", "N/A", "500", "120 x 100 x 100 (H)"],
      ]),
    ]);
    const c = parseCollectionRunRoster(d).consignments[0]!;
    expect(c.pallets[0]!.quantity).toBe(1); // never dropped
    expect(c.pallets[0]!.weightKg).toBe(500); // weight WAS read cleanly — isolates the cause to the count
    expect(c.needsReview).toContain("pallets");
  });

  it("does not double-flag a row that already reads its pallet count fine (no spurious ⚠)", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Marlowe Distribution Ltd", "1 Marlowe Way Croydon, CR0 4XA, UK", "07:00", "3", "120 x 100 x 100 (H)"],
      ]),
    ]);
    const c = parseCollectionRunRoster(d).consignments[0]!;
    expect(c.pallets[0]!.quantity).toBe(3);
    // Weight is still unstated here, so "pallets" is flagged for THAT reason — but there is only
    // ONE entry, not two, proving the count-unreadable check doesn't pile on when count is fine.
    expect(c.needsReview.filter((f) => f === "pallets")).toHaveLength(1);
  });

  it("survives mergeComplementaryViews — fusing in a weight from a complementary view must not launder away an unreadable pallet count", () => {
    // Two COMPLEMENTARY views of the same company (mergeComplementaryViews' own trigger condition):
    // view A knows the origin but not the weight (real, readable pallet count = 1); view B knows the
    // weight but its OWN Pallets cell is unreadable (defaults to 1 — the same total, so the merge's
    // "same pallet count" precondition holds and the two views fuse). The fused pallets/quantity are
    // taken from B (the side that supplies the weight) — exactly the side whose count is a guess. The
    // pre-fix bug re-derived "pallets" from weight alone, so a known post-merge weight silently
    // dropped the flag even though the merged quantity is still an unread default.
    const viewA = table(0, collectionRunHeaders, [
      ["1", "Marlowe Distribution Ltd", "1 Marlowe Way Croydon, CR0 4XA, UK", "07:00", "1", "120 x 100 x 100 (H)"],
    ]);
    const viewB = table(1, ["Stop", "Collection Company / Contact", "Pallets", "Weight (kg)"], [
      ["1", "Marlowe Distribution Ltd", "N/A", "500"],
    ]);
    const c = parseCollectionRunRoster(doc([viewA, viewB])).consignments[0]!;
    expect(c.pallets[0]!.weightKg).toBe(500); // the weight fused in fine
    expect(c.pallets[0]!.quantity).toBe(1); // still just the unread default — never invented
    // The operator still has to confirm how many pallets this actually is.
    expect(c.needsReview).toContain("pallets");
  });
});

describe("parseCollectionRunRoster — oversize footprint boundary (Bug 0.4)", () => {
  it("classifies a pallet stated at EXACTLY the oversize side as oversize, not standard (>= not >)", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        // Exactly 240 cm on the long side — the config's own oversize.lengthMm boundary.
        ["1", "Boundary Co", "Leeds, LS1 1AA, UK", "07:00", "1", "240 x 100 x 100 (H)"],
      ]),
    ]);
    const c = parseCollectionRunRoster(d).consignments[0]!;
    expect(c.pallets[0]!.footprint).toBe("oversize");
  });

  it("honours a config-injected oversize threshold (opts), matching how maxPlausibleDerivedPalletKg is threaded", () => {
    const d = doc([
      table(0, collectionRunHeaders, [
        ["1", "Small-Oversize Co", "Leeds, LS1 1AA, UK", "07:00", "1", "150 x 100 x 100 (H)"],
      ]),
    ]);
    // With a tighter 150cm threshold, a pallet the default config would call standard-sized is
    // correctly reported oversize.
    const c = parseCollectionRunRoster(d, { oversizeSideCm: 150 }).consignments[0]!;
    expect(c.pallets[0]!.footprint).toBe("oversize");
  });
});

describe("parseCollectionRunRoster — OCR continuation rows", () => {
  it("folds an entry's continuation lines back into it, so the postcode isn't stranded", () => {
    // Exactly how OCR flattens a multi-line cell: name/street on the entry row, contact +
    // town/postcode on the next, phone on the one after — each a row with everything else blank.
    const d = doc([
      table(0, ["#", "Collection Company / Contact", "Collection Address", "Pallets", "Pallet Size (cm)"], [
        ["1", "Salford Textile Mills Ltd", "Regent Trading Estate", "6", "120 x 100 x 150 (H)"],
        ["", "Contact: Nadia Yusuf", "Salford, M5 4QH, UK", "", ""],
        ["", "+44 161 872 3301", "", "", ""],
        ["2", "Pennine Hardware Co", "Pennine Industrial Park", "2", "120 x 80 x 95 (H)"],
        ["", "Contact: Ravi Sandhu", "Rochdale, OL11 1EX, UK", "", ""],
      ]),
    ]);
    const { consignments } = parseCollectionRunRoster(d);
    // Two companies — not five. The continuation lines must not surface as phantom consignments
    // (they inflate the truck's pallet count and each arrives company-less and flagged).
    expect(consignments).toHaveLength(2);
    expect(consignments.map((c) => c.company)).toEqual(["Salford Textile Mills Ltd", "Pennine Hardware Co"]);
    // The postcode lived on the CONTINUATION line — the whole point of the merge.
    expect(consignments.map((c) => c.originPostcode)).toEqual(["M5 4QH", "OL11 1EX"]);
    expect(consignments.map((c) => c.pallets[0]!.quantity)).toEqual([6, 2]);
    expect(consignments.every((c) => !c.needsReview.includes("originPostcode"))).toBe(true);
  });
});

describe("parseCollectionRunRoster — collection leg vs delivery leg", () => {
  const collect = table(1, ["#", "Collection Company / Contact", "Collection Address", "Pallets", "Pallet Size (cm)"], [
    ["1", "Salford Textile Mills Ltd", "Salford, M5 4QH, UK", "6", "120 x 100 x 150 (H)"],
    ["2", "Pennine Hardware Co", "Rochdale, OL11 1EX, UK", "2", "120 x 80 x 95 (H)"],
  ]);
  const deliver = table(2, ["#", "Delivery Company / Contact", "Delivery Address", "Pallets", "Pallet Size (cm)"], [
    ["1", "Solent Retail Group", "Southampton, SO15 1AA, UK", "5", "120 x 100 x 150 (H)"],
    ["2", "Wessex Home Stores", "Winchester, SO23 7RX, UK", "3", "120 x 80 x 95 (H)"],
  ]);
  const cargoSummary = table(3, ["Origin", "Material / Goods Description", "L x W x D (cm)", "Line Weight", "Qty (units)"], [
    ["Salford Textile", "Woven cotton fabric rolls", "120 x 100 x 150", "22 kg/roll", "18"],
    ["Pennine Hardware", "Steel fixings, boxed", "120 x 80 x 95", "13 kg/carton", "50"],
  ]);

  it("reads the collection leg only — the delivery table is the same freight going out", () => {
    const { consignments, notes } = parseCollectionRunRoster(doc([collect, deliver, cargoSummary]));
    // 8 pallets on the truck, not 16. Reading both legs double-counts the load, and the delivery
    // companies come back UNWEIGHED because the cargo summary is keyed by the ORIGIN companies.
    expect(consignments.map((c) => c.company)).toEqual(["Salford Textile Mills Ltd", "Pennine Hardware Co"]);
    expect(consignments.reduce((n, c) => n + c.pallets[0]!.quantity, 0)).toBe(8);
    // …and with only the collection leg read, every consignment IS weighable from the summary.
    expect(consignments[0]!.pallets[0]!.weightKg).toBe(66); // 22×18 = 396 kg ÷ 6 pallets
    expect(consignments[1]!.pallets[0]!.weightKg).toBe(325); // 13×50 = 650 kg ÷ 2 pallets
    expect(consignments.every((c) => !c.needsReview.includes("pallets"))).toBe(true);
    // The operator is told what was dropped and why — never a silent transformation.
    expect(notes?.[0]).toMatch(/collection companies only/i);
  });

  it("a delivery-only manifest still reads normally — the rule fires only when BOTH legs exist", () => {
    const { consignments, notes } = parseCollectionRunRoster(doc([deliver]));
    expect(consignments.map((c) => c.company)).toEqual(["Solent Retail Group", "Wessex Home Stores"]);
    expect(notes).toBeUndefined();
  });
});
