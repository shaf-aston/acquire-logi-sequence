import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  detectAddresses,
  parseAddressDetectionConfigFrom,
} from "@/lib/ingestion/address-detector";
import type { StructuredDocument, ExtractedTable } from "@/lib/conversion/types";

/**
 * Data-driven regression net for `detectAddresses`. Cases live in
 * `tests/fixtures/addresses/address-cases.json` so new scenarios can be added
 * without touching this runner. Every `expect` value in the fixture was
 * derived by actually running the detector — never guessed. Any remaining
 * `BUG-` prefixed case names pin a real, still-open limitation.
 */

interface FixtureCaseInput {
  readonly markdown: string;
  readonly tables?: readonly ExtractedTable[];
}

interface FixtureCase {
  readonly name: string;
  readonly input: FixtureCaseInput;
  readonly expect: {
    readonly pickup: string | null;
    readonly drops: readonly string[];
  };
}

interface FixtureFile {
  readonly version: number;
  readonly cases: readonly FixtureCase[];
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), "utf8")) as T;
}

function docFromInput(input: FixtureCaseInput): StructuredDocument {
  return {
    pageCount: 1,
    tableCount: input.tables?.length ?? 0,
    pages: [{ index: 0, markdown: input.markdown, tables: input.tables ? [...input.tables] : [] }],
  };
}

// Load the real shipped config the same way production does — the fixtures
// exercise the actual `config/address-detection.json`, not a hand-copied stand-in.
const config = parseAddressDetectionConfigFrom(readJson("config/address-detection.json"));

const fixture = readJson<FixtureFile>("tests/fixtures/addresses/address-cases.json");

describe("detectAddresses (data-driven fixtures)", () => {
  it("loads a non-empty fixture set", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, testCase) => {
    const result = detectAddresses(docFromInput(testCase.input), config);
    expect(result.pickup).toBe(testCase.expect.pickup);
    expect(result.drops).toEqual(testCase.expect.drops);
  });
});
