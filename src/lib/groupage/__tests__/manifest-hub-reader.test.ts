import { describe, it, expect } from "vitest";
import { readManifestHubs, widenCollectionHubCatchment, type ManifestHub } from "../manifest-hub-reader";
import type { StructuredDocument, ExtractedTable } from "@/lib/conversion/types";

/** Build a one-page document from raw tables (headers + rows), mirroring the OCR dump shape. */
function doc(tables: Array<{ headers: string[]; rows: string[][] }>): StructuredDocument {
  const pageTables: ExtractedTable[] = tables.map((t, index) => ({ index, headers: t.headers, rows: t.rows }));
  return {
    pageCount: 1,
    tableCount: pageTables.length,
    pages: [{ index: 0, markdown: "", tables: pageTables }],
  };
}

// The exact cells the OCR produced for simple4_groupage_multicompany.pdf (see dump-tables output).
const COLLECTION_HUB_CELL =
  "SwiftHaul Huddersfield Consolidation Centre Unit 2, Bradley Mills Road Huddersfield, HD1 6EJ, UK Hub Mgr: Craig Normanton, +44 1484 550 210";
const DEST_HUB_CELL =
  "SwiftHaul Nottingham Distribution Hub Bay 7, Colwick Industrial Estate Nottingham, NG4 2JT, UK Hub Mgr: Prill Chauhan, +44 115 940 6620";

describe("readManifestHubs", () => {
  it("lifts the two named hubs from the real manifest tables", () => {
    const hubs = readManifestHubs(
      doc([
        { headers: ["Collection Hub", "Assigned Driver", "Vehicle / Asset"], rows: [[COLLECTION_HUB_CELL, "D. Isla MacRae", "18t rigid box van"]] },
        { headers: ["Origin Hub", "Destination Hub", "Operator / Trunk Vehicle"], rows: [[COLLECTION_HUB_CELL, DEST_HUB_CELL, "Trunk operator"]] },
      ]),
    );

    // Collection Hub + Origin Hub name the SAME depot (HD1) → one HD hub; Destination adds NG.
    expect(hubs).toHaveLength(2);
    const [hd, ng] = hubs;

    expect(hd!.catchment).toEqual(["HD"]);
    expect(hd!.postcode).toBe("HD1 6EJ");
    expect(ng!.postcode).toBe("NG4 2JT");
    expect(hd!.name).toBe("SwiftHaul Huddersfield Consolidation Centre");
    expect(hd!.address).toBe("Unit 2, Bradley Mills Road Huddersfield, HD1 6EJ, UK");
    expect(hd!.role).toBe("collection");
    expect(hd!.warning).toBeUndefined();

    expect(ng!.catchment).toEqual(["NG"]);
    expect(ng!.name).toBe("SwiftHaul Nottingham Distribution Hub");
    expect(ng!.address).toBe("Bay 7, Colwick Industrial Estate Nottingham, NG4 2JT, UK");
    expect(ng!.role).toBe("destination");
  });

  it("reconstructs a hub whose identity is split down its column (the real OCR row split)", () => {
    // How buildStructuredDocument actually renders this manifest: name / street / city+postcode /
    // manager each on their own row of the hub column (see the hubcells dump).
    const hubs = readManifestHubs(
      doc([
        {
          headers: ["Origin Hub", "Destination Hub", "Operator / Trunk Vehicle"],
          rows: [
            ["SwiftHaul Huddersfield Consolidation Centre", "SwiftHaul Nottingham Distribution Hub", "Trunk operator"],
            ["Unit 2, Bradley Mills Road", "Bay 7, Colwick Industrial Estate", "13.6m curtainside"],
            ["Huddersfield, HD1 6EJ, UK", "Nottingham, NG4 2JT, UK", "Driver: B. Okonkwo"],
            ["Hub Mgr: Craig Normanton, +44 1484 550 210", "Hub Mgr: Priti Chauhan, +44 115 940 6620", ""],
          ],
        },
      ]),
    );

    expect(hubs).toHaveLength(2);
    expect(hubs[0]!.name).toBe("SwiftHaul Huddersfield Consolidation Centre");
    expect(hubs[0]!.catchment).toEqual(["HD"]);
    expect(hubs[0]!.address).toBe("Unit 2, Bradley Mills Road Huddersfield, HD1 6EJ, UK");
    expect(hubs[0]!.warning).toBeUndefined();
    expect(hubs[1]!.name).toBe("SwiftHaul Nottingham Distribution Hub");
    expect(hubs[1]!.catchment).toEqual(["NG"]);
    expect(hubs[1]!.role).toBe("destination");
  });

  it("gives every hub a unique, stable id", () => {
    const hubs = readManifestHubs(
      doc([{ headers: ["Origin Hub", "Destination Hub", "x"], rows: [[COLLECTION_HUB_CELL, DEST_HUB_CELL, ""]] }]),
    );
    const ids = hubs.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^hub-/);
  });

  it("skips a hub cell with no readable postcode (never guesses a catchment)", () => {
    const hubs = readManifestHubs(
      doc([{ headers: ["Nearest Hub", "x", "y"], rows: [["Huddersfield Consolidation Centre", "", ""]] }]),
    );
    expect(hubs).toEqual([]);
  });

  it("ignores tables whose headers name no hub", () => {
    const hubs = readManifestHubs(
      doc([
        { headers: ["Stop", "Collection Company / Contact", "Collection Address", "Pallets"], rows: [["1", "Acme", "Unit 6, Brighouse, HD6 1UB, UK", "3"]] },
        { headers: ["Origin Company", "Material", "Qty"], rows: [["Brighouse Textile", "fabric rolls", "36"]] },
      ]),
    );
    expect(hubs).toEqual([]);
  });

  it("flags an uncertain name when there is no street lead-in to split on", () => {
    const hubs = readManifestHubs(
      doc([{ headers: ["Collection Hub", "x", "y"], rows: [["Northgate Depot, LS1 4AB, UK", "", ""]] }]),
    );
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.catchment).toEqual(["LS"]);
    expect(hubs[0]!.warning).toBeDefined();
  });

  it("returns empty for a document with no tables (fail-soft)", () => {
    expect(readManifestHubs(doc([]))).toEqual([]);
  });
});

describe("widenCollectionHubCatchment", () => {
  const collectionHub: ManifestHub = {
    id: "hub-huddersfield",
    name: "SwiftHaul Huddersfield Consolidation Centre",
    catchment: ["HD"],
    role: "collection",
    postcode: "HD1 6EJ",
  };
  const destinationHub: ManifestHub = {
    id: "hub-nottingham",
    name: "SwiftHaul Nottingham Distribution Hub",
    catchment: ["NG"],
    role: "destination",
    postcode: "NG4 2JT",
  };

  it("widens the collection hub to cover every origin area the run collects from", () => {
    // Real manifest origins: Brighouse HD6, Elland HX5, Huddersfield HD1, Mirfield WF14.
    const out = widenCollectionHubCatchment(
      [collectionHub, destinationHub],
      ["HD6 1UB", "HX5 9HT", "HD1 6PQ", "WF14 8HE"],
    );
    // HD already covered → not duplicated; HX + WF added, in first-seen order.
    expect(out[0]!.catchment).toEqual(["HD", "HX", "WF"]);
    // Destination hub is untouched — coverage stays disjoint.
    expect(out[1]!.catchment).toEqual(["NG"]);
  });

  it("never claims an area already owned by another manifest hub (stays disjoint)", () => {
    // A stray origin in the destination's own area must NOT be pulled into the collection hub.
    const out = widenCollectionHubCatchment([collectionHub, destinationHub], ["NG1 1AA", "HX5 9HT"]);
    expect(out[0]!.catchment).toEqual(["HD", "HX"]);
    expect(out[1]!.catchment).toEqual(["NG"]);
  });

  it("ignores unreadable origin postcodes (adds no coverage for them)", () => {
    const out = widenCollectionHubCatchment([collectionHub], ["not-a-postcode", "HX5 9HT"]);
    expect(out[0]!.catchment).toEqual(["HD", "HX"]);
  });

  it("leaves the list unchanged when there is no collection hub", () => {
    const out = widenCollectionHubCatchment([destinationHub], ["HX5 9HT"]);
    expect(out).toEqual([destinationHub]);
  });

  it("does not mutate the input hubs", () => {
    const input = [collectionHub, destinationHub];
    widenCollectionHubCatchment(input, ["HX5 9HT"]);
    expect(collectionHub.catchment).toEqual(["HD"]);
  });
});
