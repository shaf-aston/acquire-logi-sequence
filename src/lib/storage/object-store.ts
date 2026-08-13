/**
 * Storage seam (Stage 1 persistence). A tiny put-only object-store interface so
 * ingestion can archive the source PDF and the derived structured document
 * without knowing the backend. Two implementations:
 *   - R2ObjectStore  — Cloudflare R2 via the S3 API (see r2.store.ts)
 *   - NoopObjectStore — does nothing; the default when storage is unconfigured
 *
 * Put-only by design: ingestion writes, nothing in this app reads back yet
 * (re-processing/audit retrieval is a later milestone). Keys are
 * content-addressed (sha256) by the caller, mirroring the OCR cache, so the same
 * PDF is stored once and re-uploads are idempotent overwrites.
 */

export interface PutObjectInput {
  /** Object key within the bucket, e.g. "raw/<sha256>.pdf". */
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface ObjectStore {
  /** Identifies the backend in logs ("r2" | "noop"). */
  readonly backend: string;
  put(input: PutObjectInput): Promise<void>;
}

/** No-op sink used when storage is disabled or unconfigured. Never throws. */
export class NoopObjectStore implements ObjectStore {
  readonly backend = "noop";
  async put(): Promise<void> {
    /* intentionally empty */
  }
}
