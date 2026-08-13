/**
 * Cloudflare R2 object store via the S3 API (SigV4, stdlib only). One PutObject
 * per call; payload held in memory (ingestion artefacts are small — a PDF + its
 * JSON). Region is always "auto" for R2. A failed upload throws; callers decide
 * whether that's fatal (ingestion treats it as non-blocking — see the service).
 */
import { createLogger } from "@/lib/logger/logger";
import { signPutObject } from "@/lib/storage/sigv4";
import type { ObjectStore, PutObjectInput } from "@/lib/storage/object-store";

const logger = createLogger("storage.r2");

export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(`[storage] ${message}`);
    this.name = "StorageError";
  }
}

/** Encode each path segment but keep the "/" separators (S3 key semantics). */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** Compact basic-format timestamp "YYYYMMDDTHHMMSSZ" from an epoch ms value. */
function amzDate(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export class R2ObjectStore implements ObjectStore {
  readonly backend = "r2";
  private readonly cfg: R2Config;
  private readonly endpoint: string;

  constructor(cfg: R2Config) {
    this.cfg = cfg;
    this.endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  }

  async put(input: PutObjectInput): Promise<void> {
    const url = `${this.endpoint}/${this.cfg.bucket}/${encodeKey(input.key)}`;
    const signed = signPutObject({
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: "auto",
      service: "s3",
      url,
      body: input.body,
      contentType: input.contentType,
      amzDate: amzDate(Date.now()),
    });

    const res = await fetch(signed.url, {
      method: signed.method,
      headers: signed.headers,
      // Uint8Array is a valid BodyInit at runtime; the cast bridges a lib.dom
      // generics mismatch (Uint8Array<ArrayBufferLike> vs BodyInit).
      body: input.body as unknown as BodyInit,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new StorageError(`R2 PUT ${input.key} failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    logger.info("stored object", { key: input.key, bytes: input.body.byteLength });
  }
}
