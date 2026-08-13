/**
 * Trust-boundary validation for uploaded files. Enforces size + MIME limits
 * from config. Never simplified away — this guards the OCR cost and the engine.
 */
import { getConfig } from "@/config/env";

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

const PDF_MAGIC = "%PDF-";

export interface ValidatedFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
}

export function validateUpload(file: {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}): ValidatedFile {
  const cfg = getConfig().ingest;

  if (file.bytes.byteLength === 0) {
    throw new FileValidationError("File is empty.");
  }
  if (file.bytes.byteLength > cfg.maxFileBytes) {
    throw new FileValidationError(
      `File is ${file.bytes.byteLength} bytes; limit is ${cfg.maxFileBytes}.`,
    );
  }
  if (!cfg.allowedMimeTypes.includes(file.mimeType)) {
    throw new FileValidationError(
      `MIME type "${file.mimeType}" not allowed. Allowed: ${cfg.allowedMimeTypes.join(", ")}.`,
    );
  }
  // Content sniff: a real PDF starts with %PDF-. Cheap defence against spoofed MIME.
  if (file.mimeType === "application/pdf") {
    const head = Buffer.from(file.bytes.subarray(0, PDF_MAGIC.length)).toString("latin1");
    if (head !== PDF_MAGIC) {
      throw new FileValidationError("File is not a valid PDF (missing %PDF- header).");
    }
  }

  return { bytes: file.bytes, mimeType: file.mimeType, filename: file.filename };
}
