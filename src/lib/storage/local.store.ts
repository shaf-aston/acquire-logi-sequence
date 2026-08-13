/**
 * Local filesystem object store — the zero-config persistence backend. Writes
 * each object to `<baseDir>/<key>` on disk (e.g. data/uploads/raw/<sha256>.pdf),
 * creating parent folders as needed. Same put-only ObjectStore contract as R2,
 * so ingestion is unaware which backend is active. No cloud account, no
 * credentials — the default whenever storage is on but R2 isn't configured.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "@/lib/logger/logger";
import type { ObjectStore, PutObjectInput } from "@/lib/storage/object-store";

const logger = createLogger("storage.local");

export class LocalObjectStore implements ObjectStore {
  readonly backend = "local";
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(process.cwd(), baseDir);
  }

  async put(input: PutObjectInput): Promise<void> {
    const path = join(this.baseDir, input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    logger.info("stored object", { key: input.key, bytes: input.body.byteLength });
  }
}
