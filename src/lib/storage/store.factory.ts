/**
 * Resolves the active ObjectStore from config:
 *   • storage disabled              → NoopObjectStore (does nothing)
 *   • enabled, all R2 creds present → R2ObjectStore (Cloudflare cloud)
 *   • enabled, R2 creds absent      → LocalObjectStore (on-disk, zero-config)
 * Partially-filled R2 config logs once and degrades to local rather than
 * throwing at request time. Resolved once and cached.
 */
import { getConfig } from "@/config/env";
import { createLogger } from "@/lib/logger/logger";
import { LocalObjectStore } from "@/lib/storage/local.store";
import { NoopObjectStore, type ObjectStore } from "@/lib/storage/object-store";
import { R2ObjectStore } from "@/lib/storage/r2.store";

const logger = createLogger("storage.factory");

let cached: ObjectStore | null = null;

export function getObjectStore(): ObjectStore {
  if (cached) return cached;

  const s = getConfig().storage;
  if (!s.enabled) {
    cached = new NoopObjectStore();
    return cached;
  }

  const r2Keys = ["accountId", "accessKeyId", "secretAccessKey", "bucket"] as const;
  const missing = r2Keys.filter((k) => s[k] === "");

  // No R2 credentials at all → use the local disk backend (the easy default).
  if (missing.length === r2Keys.length) {
    cached = new LocalObjectStore(s.dir);
    logger.info("local storage active", { dir: s.dir });
    return cached;
  }

  // Some-but-not-all R2 credentials → misconfigured; fall back to local, don't throw.
  if (missing.length > 0) {
    logger.warn("R2 partially configured — falling back to local storage", { missing, dir: s.dir });
    cached = new LocalObjectStore(s.dir);
    return cached;
  }

  cached = new R2ObjectStore({
    accountId: s.accountId,
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    bucket: s.bucket,
  });
  logger.info("R2 storage active", { bucket: s.bucket });
  return cached;
}
