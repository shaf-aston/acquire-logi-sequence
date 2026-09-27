import { describe, it, expect } from "vitest";
import { validateUpload } from "@/lib/ingestion/file.validator";

// Someone widens the allow-list to a type the validator has no content check for.
process.env.INGEST_ALLOWED_MIME = "application/pdf,image/png";

describe("validateUpload with a widened INGEST_ALLOWED_MIME", () => {
  it("refuses an allowed type that has no content check, instead of skipping the check", () => {
    const bytes = new TextEncoder().encode("anything at all, e.g. a script renamed .png");
    expect(() => validateUpload({ bytes, mimeType: "image/png", filename: "x.png" })).toThrow(/no content check/);
  });

  it("still accepts a real PDF", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\n%%EOF");
    expect(validateUpload({ bytes, mimeType: "application/pdf", filename: "q.pdf" }).filename).toBe("q.pdf");
  });
});
