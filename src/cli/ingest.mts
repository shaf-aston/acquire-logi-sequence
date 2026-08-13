/**
 * Dev CLI for fast, browserless verification of the ingestion pipeline.
 *   npm run ingest -- ./path/to/quotation.pdf
 * Loads .env.local, runs the real pipeline, prints per-stage timings and a
 * compact table summary. Same service the API route uses — no duplicate logic.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ingestPdf } from "@/lib/ingestion/ingestion.service";

async function loadEnv(): Promise<void> {
  // Minimal .env.local loader — avoids a dependency just for the CLI.
  try {
    const raw = await readFile(new URL("../../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env.local — rely on the ambient environment.
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npm run ingest -- <path-to.pdf>");
    process.exit(1);
  }

  await loadEnv();

  const bytes = new Uint8Array(await readFile(path));
  const result = await ingestPdf({
    bytes,
    mimeType: "application/pdf",
    filename: basename(path),
    requestId: "cli",
  });

  console.log("\n── Summary ──────────────────────────────");
  console.log(`provider : ${result.provider}`);
  console.log(`pages    : ${result.document.pageCount}`);
  console.log(`tables   : ${result.document.tableCount}`);
  console.log(`items    : ${result.classification.items.length}`);
  console.log(`fragile  : ${result.classification.counts.fragile}`);
  console.log(`standard : ${result.classification.counts.standard}`);
  console.log(`review   : ${result.classification.counts.lowConfidence}`);
  console.log(`total    : ${result.perf.totalMs} ms`);
  for (const span of result.perf.spans) console.log(`  ${span.name.padEnd(10)} ${span.durationMs} ms`);

  if (result.classification.items.length > 0) {
    console.log("\nClassified items:");
    for (const it of result.classification.items) {
      const tag = `${it.fragility.toUpperCase()}${it.confident ? "" : "?"}`;
      console.log(`  [${tag.padEnd(9)}] ${it.label}  (${it.reason})`);
    }
  }

  const first = result.document.pages.flatMap((p) => p.tables)[0];
  if (first) {
    console.log("\nFirst table preview:");
    console.log(first.headers.join(" | "));
    for (const row of first.rows.slice(0, 5)) console.log(row.join(" | "));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
