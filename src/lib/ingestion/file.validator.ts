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

// Leading bytes each accepted type must start with. The MIME header is client-supplied, so a type
// with no entry here is refused even if INGEST_ALLOWED_MIME lists it.
const CONTENT_CHECKS: Readonly<Record<string, { magic: string; label: string }>> = {
  "application/pdf": { magic: "%PDF-", label: "PDF" },
};

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
  const check = CONTENT_CHECKS[file.mimeType];
  if (check === undefined) {
    throw new FileValidationError(`MIME type "${file.mimeType}" has no content check, so it can't be accepted.`);
  }
  const head = Buffer.from(file.bytes.subarray(0, check.magic.length)).toString("latin1");
  if (head !== check.magic) {
    throw new FileValidationError(`File is not a valid ${check.label} (missing ${check.magic} header).`);
  }

  return { bytes: file.bytes, mimeType: file.mimeType, filename: file.filename };
}
