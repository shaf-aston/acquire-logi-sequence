import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  detectAddresses,
  detectDirection,
  parseAddressDetectionConfigFrom,
  type AddressDetectionConfig,
} from "@/lib/ingestion/address-detector";
import type { StructuredDocument } from "@/lib/conversion/types";

const config: AddressDetectionConfig = {
  version: 1,
  pickupLabels: ["collection", "collect from", "pickup", "pick up", "from", "origin", "loading"],
  dropLabels: ["delivery", "deliver to", "drop", "drop off", "to", "destination", "ship to", "unloading"],
  postcodePattern: "\\b[A-Z]{1,2}[0-9][A-Z0-9]?\\s*[0-9][A-Z]{2}\\b",
  maxLineLength: 160,
  addressColumnPattern: "address",
  typeColumnPattern: "^type|stop type",
  companyColumnPattern: "company|contact|origin",
  outboundHubColumnPattern: "destination hub|outbound hub",
  collectionSignals: ["milk round", "collection run", "consolidation"],
};

function docFromMarkdown(markdown: string): StructuredDocument {
  return {
    pageCount: 1,
    tableCount: 0,
    pages: [{ index: 0, markdown, tables: [] }],
  };
}

/** Read a shipped config JSON from disk (proves the real file parses). */
function readConfigJson(relative: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), relative), "utf8"));
}

describe("detectAddresses", () => {
  it("detects a pickup and a single drop from labeled markdown lines", () => {
    const doc = docFromMarkdown(
      "Collection: 5 Main Road, Leeds, LS1 4AB\nDelivery: 22 Oak Street, Bristol, BS1 5TR",
    );
    const result = detectAddresses(doc, config);
    expect(result.pickup).toBe("5 Main Road, Leeds, LS1 4AB");
    expect(result.drops).toEqual(["22 Oak Street, Bristol, BS1 5TR"]);
  });

  it("returns two distinct drops, deduped", () => {
    const doc = docFromMarkdown(
      [
        "Collection: 1 Start Lane, SW1A 1AA",
        "Delivery: 10 First Ave, M1 2AB",
        "Delivery: 20 Second Ave, E1 6AN",
        "Delivery: 10 First Ave, M1 2AB",
      ].join("\n"),
    );
    const result = detectAddresses(doc, config);
    expect(result.drops).toEqual(["10 First Ave, M1 2AB", "20 Second Ave, E1 6AN"]);
  });

  it("ignores an unlabeled postcode line", () => {
    const doc = docFromMarkdown("Some notes about the job, ref SW1A 1AA maybe.");
    const result = detectAddresses(doc, config);
    expect(result.pickup).toBeNull();
    expect(result.drops).toEqual([]);
  });

  it("returns empty result when no postcodes present", () => {
    const doc = docFromMarkdown("Collection: somewhere\nDelivery: somewhere else");
    const result = detectAddresses(doc, config);
    expect(result.pickup).toBeNull();
    expect(result.drops).toEqual([]);
  });

  it("extracts a same-line label + address", () => {
    const doc = docFromMarkdown("Pickup 5 Main Road, LS1 4AB");
    const result = detectAddresses(doc, config);
    expect(result.pickup).toBe("5 Main Road, LS1 4AB");
  });

  it("prefers the longest matching label ('deliver to' beats 'to')", () => {
    const doc = docFromMarkdown("Deliver to: 12 King St, M1 2AB");
    const result = detectAddresses(doc, config);
    expect(result.pickup).toBeNull();
    expect(result.drops).toEqual(["12 King St, M1 2AB"]);
  });

  it("skips a drop equal to the pickup", () => {
    const doc = docFromMarkdown(
      "Collection: 5 Main Road, LS1 4AB\nDelivery: 5 main road, ls1 4ab",
    );
    const result = detectAddresses(doc, config);
    expect(result.pickup).toBe("5 Main Road, LS1 4AB");
    expect(result.drops).toEqual([]);
  });

  it("skips lines longer than maxLineLength (prose, not an address block)", () => {
    const longLine = `Delivery: ${"x".repeat(160)} M1 2AB`;
    const doc = docFromMarkdown(longLine);
    const result = detectAddresses(doc, config);
    expect(result.drops).toEqual([]);
  });

  it("reads addresses out of table cells", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [
        {
          index: 0,
          markdown: "",
          tables: [
            {
              index: 0,
              headers: ["Type", "Address"],
              rows: [["Collection", "5 Main Road, LS1 4AB"]],
            },
          ],
        },
      ],
    };
    const result = detectAddresses(doc, config);
    expect(result.pickup).toBe("5 Main Road, LS1 4AB");
    // `pickups`/`deliveries` are populated ONLY by the table reader (see DetectedAddresses jsdoc), so
    // this proves the address came from resolving the Address COLUMN, not the line scanner.
    expect(result.pickups).toEqual(["5 Main Road, LS1 4AB"]);
  });

  // `headerless` says "no CARGO header could be proven" — table-normaliser scores a header row against
  // the PACKER's vocabulary (description / weight / qty / dimensions). A stop table's headers are
  // "Collection Address", "Type", "Company": real, meaningful headers that score near zero on cargo
  // words and are therefore flagged headerless. Refusing them here once cost us every detected address
  // on four of the example manifests: they still quoted the right weight, but opened in the WRONG
  // PLANNER — which is the whole bug class this reader exists to prevent.
  //
  // It is safe to read them because this reader never resolves a column by position: it needs a real
  // header-text match, and a table with no usable headers falls out on its own (next test).
  it("still reads a stop table flagged headerless — that flag is about CARGO headers, not address ones", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [
        {
          index: 0,
          markdown: "",
          tables: [
            {
              index: 0,
              headers: ["Type", "Address"],
              rows: [["Collection", "5 Main Road, LS1 4AB"]],
              headerless: true,
            },
          ],
        },
      ],
    };
    const result = detectAddresses(doc, config);
    expect(result.pickups).toEqual(["5 Main Road, LS1 4AB"]);
  });

  it("reports nothing from a table with no usable headers — no column is ever resolved by position", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [
        {
          index: 0,
          markdown: "",
          tables: [
            {
              index: 0,
              headers: [], // the scan lost the header row entirely — nothing is known about these columns
              rows: [["Collection", "5 Main Road, LS1 4AB"]],
              headerless: true,
            },
          ],
        },
      ],
    };
    const result = detectAddresses(doc, config);
    expect(result.pickups).toBeUndefined();
    expect(result.deliveries).toBeUndefined();
  });
});

describe("detectDirection", () => {
  it("flags a collection round from a document-level signal phrase", () => {
    const doc = docFromMarkdown("QUOTE — Bristol Milk Round\nCollect from 6 suppliers into the hub.");
    expect(detectDirection(doc, config.collectionSignals)).toBe("collect");
  });

  it("matches a signal case-insensitively (Consolidation Centre)", () => {
    const doc = docFromMarkdown("Deliver to Bristol Consolidation Centre, BS11 9AZ");
    expect(detectDirection(doc, config.collectionSignals)).toBe("collect");
  });

  it("defaults to deliver when no signal phrase appears", () => {
    const doc = docFromMarkdown("Delivery schedule\nDeliver to 12 High Street, LS1 4AB");
    expect(detectDirection(doc, config.collectionSignals)).toBe("deliver");
  });

  it("is always deliver when the signal list is empty (back-compat)", () => {
    const doc = docFromMarkdown("Milk round — collection run");
    expect(detectDirection(doc, [])).toBe("deliver");
  });

  it("reads signals out of table rows, not just markdown", () => {
    const doc: StructuredDocument = {
      pageCount: 1,
      tableCount: 1,
      pages: [
        {
          index: 0,
          markdown: "",
          tables: [{ index: 0, headers: ["Stop", "Notes"], rows: [["1", "Milk round pickup"]] }],
        },
      ],
    };
    expect(detectDirection(doc, config.collectionSignals)).toBe("collect");
  });
});

describe("loadAddressDetectionConfig / parseAddressDetectionConfigFrom", () => {
  it("rejects empty label arrays", () => {
    expect(() =>
      parseAddressDetectionConfigFrom({
        version: 1,
        pickupLabels: [],
        dropLabels: ["delivery"],
        postcodePattern: "\\d+",
        maxLineLength: 160,
      }),
    ).toThrow();
  });

  it("rejects an invalid regex pattern", () => {
    expect(() =>
      parseAddressDetectionConfigFrom({
        version: 1,
        pickupLabels: ["collection"],
        dropLabels: ["delivery"],
        postcodePattern: "(unclosed",
        maxLineLength: 160,
      }),
    ).toThrow();
  });

  it("parses the real shipped config", () => {
    const parsed = parseAddressDetectionConfigFrom(readConfigJson("config/address-detection.json"));
    expect(parsed.pickupLabels.length).toBeGreaterThan(0);
    expect(parsed.dropLabels.length).toBeGreaterThan(0);
    expect(parsed.maxLineLength).toBe(160);
  });
});
