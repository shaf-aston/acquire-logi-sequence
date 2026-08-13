/**
 * Dev CLI: run the REAL packer on a manifest and print the per-van fill diagnostic.
 *   npm run pack:debug -- ./path/to/manifest.pdf
 * Ingests (same service as the API), then packs with PACKING_DEBUG forced on, so the
 * `packing.debug` trace ("why isn't this van fuller?") prints, plus a compact table.
 * Browserless — the fastest way to see why a van stalls at e.g. 41.7% volume.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// Must be set BEFORE any import triggers getConfig() (config is cached on first read).
process.env.PACKING_DEBUG = "1";

const { ingestPdf } = await import("@/lib/ingestion/ingestion.service");
const { packJob } = await import("@/lib/packing/packer.service");
const { analyzeVanFill } = await import("@/lib/packing/van-fill");

async function loadEnv(): Promise<void> {
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
    console.error("Usage: npm run pack:debug -- <path-to.pdf>");
    process.exit(1);
  }
  await loadEnv();
  process.env.PACKING_DEBUG = "1"; // re-assert in case .env.local set it to 0

  const bytes = new Uint8Array(await readFile(path));
  const ingest = await ingestPdf({ bytes, mimeType: "application/pdf", filename: basename(path), requestId: "pack-debug" });
  const result = await packJob({
    doc: ingest.document,
    classification: ingest.classification,
    requestId: "pack-debug",
  });

  const reachM = result.maxReachHeightM;
  const unplacedUnits = result.unplaced.reduce((n, i) => n + Math.max(1, i.quantity), 0);

  console.log("\n── Fleet fill diagnostic ────────────────────────────────");
  console.log(`vans used   : ${result.fleet.length}`);
  console.log(`placed units: ${result.packableUnits - unplacedUnits} / ${result.packableUnits}`);
  console.log(`unplaced    : ${unplacedUnits}`);
  console.log(`reach cap   : ${reachM === null ? "none" : `${reachM} m`}`);
  console.log("\n  #  van                     vol%  floor%  pay%  placed  flr/stk  head  verdict");
  result.fleet.forEach((r, i) => {
    const d = analyzeVanFill(r.placements, r.van.interior, {
      maxReachHeightM: reachM,
      hasUnplacedGlobal: unplacedUnits > 0,
      maxPayloadKg: r.van.maxPayloadKg,
    });
    const row =
      `  ${String(i + 1).padStart(2)}  ${r.van.label.padEnd(22).slice(0, 22)}  ` +
      `${(d.volumeFill * 100).toFixed(1).padStart(5)}  ${(d.floorFootprint * 100).toFixed(1).padStart(6)}  ` +
      `${(d.payloadFraction * 100).toFixed(1).padStart(4)}  ` +
      `${String(d.placed).padStart(6)}  ${`${d.floored}/${d.stacked}`.padStart(7)}  ${d.headroomM.toFixed(2).padStart(4)}  ${d.verdict}`;
    console.log(row);
    console.log(`        └ ${d.reason}`);
    // Fragility split — a fragile pallet may only sit on another fragile one, so a
    // van slice that is fragility-imbalanced cannot build full 2-high columns.
    const flr = r.placements.filter((p) => p.position.z <= 0.001);
    const stk = r.placements.filter((p) => p.position.z > 0.001);
    const frag = (ps: typeof r.placements) => `${ps.filter((p) => p.fragile).length}frag/${ps.filter((p) => !p.fragile).length}std`;
    console.log(`          floor: ${frag(flr)}   stacked: ${frag(stk)}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
