/**
 * Trust-boundary tests for validateUpload — the gate every uploaded file must
 * clear before it is OCR'd. Pins: pass path, and every distinct rejection
 * (empty / oversize / MIME not allowed / spoofed extension) with its own
 * FileValidationError, plus the check ORDER (empty wins over the magic-byte
 * check so a zero-length "application/pdf" fails for the right reason).
 *
 * getConfig() resolves lazily on first call and caches for the life of this
 * module's registry, so INGEST_MAX_FILE_BYTES is set here, once, before any
 * test invokes validateUpload (mirrors durability-classifier.factory.test.ts's
 * pattern). A small limit (1000 bytes) lets the oversize test construct a
 * just-over-the-line buffer instead of allocating a real 25MiB one.
 */
import { describe, it, expect } from "vitest";
import { validateUpload, FileValidationError } from "@/lib/ingestion/file.validator";

process.env.INGEST_MAX_FILE_BYTES = "1000";
// INGEST_ALLOWED_MIME left unset — default is ["application/pdf"] only.

const PDF_HEADER = "%PDF-1.4\n";

function pdfBytes(body = "1 0 obj\n<< >>\nendobj\n%%EOF"): Uint8Array {
  return new TextEncoder().encode(PDF_HEADER + body);
}

describe("validateUpload", () => {
  it("passes a well-formed PDF (correct MIME + %PDF- magic bytes)", () => {
    const bytes = pdfBytes();
    const result = validateUpload({ bytes, mimeType: "application/pdf", filename: "quote.pdf" });
    expect(result).toEqual({ bytes, mimeType: "application/pdf", filename: "quote.pdf" });
  });

  it("rejects an empty file", () => {
    expect(() =>
      validateUpload({ bytes: new Uint8Array(0), mimeType: "application/pdf", filename: "empty.pdf" }),
    ).toThrow(FileValidationError);
    expect(() =>
      validateUpload({ bytes: new Uint8Array(0), mimeType: "application/pdf", filename: "empty.pdf" }),
    ).toThrow(/empty/i);
  });

  it("rejects a file over the configured size limit", () => {
    // One byte past the 1000-byte test limit — no need to allocate the real 25MiB ceiling.
    const oversized = new Uint8Array(1001);
    expect(() =>
      validateUpload({ bytes: oversized, mimeType: "application/pdf", filename: "big.pdf" }),
    ).toThrow(FileValidationError);
    expect(() =>
      validateUpload({ bytes: oversized, mimeType: "application/pdf", filename: "big.pdf" }),
    ).toThrow(/limit is 1000/);
  });

  it("rejects a disallowed MIME type", () => {
    const bytes = pdfBytes();
    expect(() =>
      validateUpload({ bytes, mimeType: "image/png", filename: "quote.png" }),
    ).toThrow(FileValidationError);
    expect(() =>
      validateUpload({ bytes, mimeType: "image/png", filename: "quote.png" }),
    ).toThrow(/MIME type "image\/png" not allowed/);
  });

  it("rejects a spoofed extension: allowed MIME but wrong magic bytes", () => {
    const bytes = new TextEncoder().encode("This is not really a PDF, just renamed.");
    expect(() =>
      validateUpload({ bytes, mimeType: "application/pdf", filename: "fake.pdf" }),
    ).toThrow(FileValidationError);
    expect(() =>
      validateUpload({ bytes, mimeType: "application/pdf", filename: "fake.pdf" }),
    ).toThrow(/not a valid PDF/);
  });

  it("check order: an empty application/pdf file fails on emptiness, not the magic-byte sniff", () => {
    // Proves the code's actual check order (empty -> size -> MIME -> magic) rather
    // than assuming it — a reordering that swapped empty/magic would flip this message.
    try {
      validateUpload({ bytes: new Uint8Array(0), mimeType: "application/pdf", filename: "empty.pdf" });
      expect.unreachable("expected validateUpload to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FileValidationError);
      expect((err as FileValidationError).message).toMatch(/empty/i);
      expect((err as FileValidationError).message).not.toMatch(/not a valid PDF/);
    }
  });
});
