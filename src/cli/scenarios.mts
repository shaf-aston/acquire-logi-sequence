/**
 * SCENARIO SWEEP — runs EVERY example quotation in docs/quotation-pdf-examples through the real
 * pipeline and reports, per file, whether it still works.
 *
 *   npm run scenarios                      # all 28, against saved scans (free, instant, offline)
 *   npm run scenarios -- --only milk-run   # just the files whose path contains "milk-run"
 *   npm run scenarios -- --detail large-multi-hub.pdf   # everything read from one PDF
 *   npm run scenarios -- --live            # re-scan through the real OCR (costs money)
 *   npm run scenarios -- --update          # rewrite expectations.json from this run's results
 *
 * WHY THIS EXISTS. Those 28 PDFs cover every scenario the software claims to handle, and not one of
 * them was covered by a test — they were a manual set you ran one at a time and eyeballed. So a fix
 * proved against one manifest could silently break the other 27, and nothing would say so.
 *
 * IT INVENTS NOTHING. Every stage below is the same function the API routes call:
 *   ingestPdf                    (src/lib/ingestion/ingestion.service.ts)  — as /api/ingest does
 *   routeManifest                (src/lib/mode-selection/manifest-routing) — as the upload page does
 *   packJob                      (src/lib/packing/packer.service.ts)       — as /api/pack does
 *   readConsignmentsFromDocument (src/lib/groupage/consignment-read...)    — as /api/groupage/... does
 * If this file ever grows its own idea of what a manifest means, it has stopped being a test.
 *
 * SAVED SCANS. These PDFs are image-only, so reading one costs a paid OCR call. The existing
 * CachingExtractor already content-addresses each PDF by sha256 and skips the provider on a hit, so
 * we simply aim it at a committed snapshot folder: scan once, keep the results, and every later run
 * is free, offline and BYTE-IDENTICAL. That last part is what makes a red result meaningful — it
 * means the code broke, not that the scanner had an off day. `--live` bypasses it to check the
 * scanner itself.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
// Type-only — erased at compile time, so it cannot trigger the config read we are about to guard.
import type { QuoteMode } from "@/lib/mode-selection/manifest-routing";

/* ── Config, before anything reads it ──────────────────────────────────────────
 * env.ts builds and caches its config on the FIRST getConfig() call, so these must be set before any
 * import triggers one. Same discipline as pack-debug.mts and the e2e suite. */
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const LIVE = flag("live");
const UPDATE = flag("update");
const ONLY = value("only");
const DETAIL = value("detail");

const ROOT = resolve(process.cwd(), "docs/quotation-pdf-examples");
const SNAPSHOT_DIR = "docs/quotation-pdf-examples/.ocr-snapshots";
const EXPECTATIONS_PATH = resolve(ROOT, "expectations.json");

if (LIVE) {
  process.env.OCR_CACHE_ENABLED = "false";
} else {
  process.env.OCR_CACHE_ENABLED = "true";
  process.env.OCR_CACHE_DIR = SNAPSHOT_DIR;
}
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error"; // the report IS the output; hush the pipeline

/** Minimal .env.local loader — mirrors ingest.mts. Only matters on a --live run (needs the OCR key). */
async function loadEnv(): Promise<void> {
  try {
    const raw = await readFile(new URL("../../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    /* no .env.local — rely on the ambient environment */
  }
}
await loadEnv();
// Re-assert: a stale OCR_CACHE_* in .env.local must not silently redirect the sweep's snapshots.
if (LIVE) process.env.OCR_CACHE_ENABLED = "false";
else {
  process.env.OCR_CACHE_ENABLED = "true";
  process.env.OCR_CACHE_DIR = SNAPSHOT_DIR;
}

const { ingestPdf } = await import("@/lib/ingestion/ingestion.service");
const { packJob } = await import("@/lib/packing/packer.service");
const { readConsignmentsFromDocument } = await import("@/lib/groupage/consignment-read.service");
const { routeManifest } = await import("@/lib/mode-selection/manifest-routing");
const { getConfig } = await import("@/config/env");

/* ── What "correct" means ──────────────────────────────────────────────────────
 * Expectations are CONFIG (expectations.json), seeded from the figures the folder's own README
 * states — i.e. the manifest's claim about itself. A mismatch is therefore a real disagreement
 * between the document and the software, not a rubber-stamped snapshot of whatever the code did. */
interface Expectation {
  readonly mode: QuoteMode | null;
  /** Point-to-point: cargo lines read. Omit to skip the check. */
  readonly items?: number;
  /** Groupage/collection: distinct companies on the roster. */
  readonly companies?: number;
  /** Groupage/collection: total pallets across all companies. */
  readonly pallets?: number;
  /** Total cargo weight (kg), compared within `tolerancePct` (default 10%). */
  readonly totalKg?: number;
  readonly tolerancePct?: number;
  /** Units the packer could not carry. Default 0 — cargo must never silently vanish. */
  readonly maxUnplaced?: number;
  /** Groupage: every company must end up with a pallet weight (the "reader can't read weights" bug). */
  readonly requireAllWeights?: boolean;
  /** Why this file is allowed to be odd — e.g. an abnormal load that SHOULD be unplaceable. */
  readonly note?: string;
}

interface Reading {
  readonly mode: QuoteMode | null;
  readonly items: number;
  readonly companies: number;
  readonly pallets: number;
  readonly totalKg: number;
  readonly unplaced: number;
  readonly placed: number;
  readonly vans: number;
  /** Companies with no weight on any pallet line. */
  readonly missingWeights: number;
  /** ⚠ things the pipeline itself flagged for human review — never swallowed. */
  readonly flags: string[];
}

const DEFAULT_TOLERANCE_PCT = 10;

/* ── Read one PDF the way the app does ─────────────────────────────────────── */

async function readScenario(path: string): Promise<Reading> {
  const bytes = new Uint8Array(await readFile(path));
  const filename = path.split(sep).pop() ?? path;
  const ingest = await ingestPdf({ bytes, mimeType: "application/pdf", filename, requestId: "scenarios" });

  const route = routeManifest({
    isHubManifest: ingest.hubManifest.isHubManifest,
    direction: ingest.direction,
    dropCount: ingest.addresses.drops.length,
    hasPickup: (ingest.addresses.pickup ?? "").trim() !== "",
    minDropsForMultiStop: getConfig().modeSelection.minDropsForMultiStop,
  });

  const flags: string[] = [];
  if (ingest.classification.counts.lowConfidence > 0) {
    flags.push(`${ingest.classification.counts.lowConfidence} low-confidence classification(s)`);
  }

  // Groupage and collection sheets state their load as a PALLET ROSTER through a hub. The standard
  // per-piece packer mis-reads them (it over-counts the cargo summary), so the app routes them to the
  // roster reader instead — and so does this sweep. Asserting the roster is asserting the thing the
  // document actually determines.
  if (route.mode === "groupage" || route.mode === "collection") {
    const roster = await readConsignmentsFromDocument(ingest.document, "scenarios");
    const cs = roster.consignments;
    const pallets = cs.reduce((n, c) => n + c.pallets.reduce((m, p) => m + p.quantity, 0), 0);
    const totalKg = cs.reduce(
      (n, c) => n + c.pallets.reduce((m, p) => m + p.weightKg * p.quantity, 0),
      0,
    );
    // "No weight anywhere on this company's pallets" is the exact failure the weights bug produced:
    // the quote silently priced 0 kg. It must be a first-class number in the report.
    const missingWeights = cs.filter((c) => c.pallets.every((p) => p.weightKg <= 0)).length;
    for (const c of cs) {
      if (c.needsReview.length > 0) flags.push(`${c.company ?? "?"}: review ${c.needsReview.join("/")}`);
    }
    if (roster.hubCollapse.collapsed) flags.push(...roster.hubCollapse.reasons);

    return {
      mode: route.mode,
      items: ingest.classification.items.length,
      companies: cs.length,
      pallets,
      totalKg,
      unplaced: 0,
      placed: 0,
      vans: 0,
      missingWeights,
      flags,
    };
  }

  // Point-to-point: the load plan is the answer. Run the real packer.
  const pack = await packJob({ doc: ingest.document, classification: ingest.classification, requestId: "scenarios" });
  const unplaced = pack.unplaced.reduce((n, i) => n + Math.max(1, i.quantity), 0);
  const totalKg = pack.items.reduce((n, i) => n + i.weightKg * Math.max(1, i.quantity), 0);
  for (const t of pack.skippedTables) flags.push(`skipped table: ${t.reason ?? "no dimensions or pallet columns"}`);
  for (const t of pack.flaggedTables) flags.push(`guessed header: ${t.reason ?? "unit or column position"}`);
  for (const [id, why] of Object.entries(pack.reasons)) flags.push(`unplaced ${id}: ${why}`);

  return {
    mode: route.mode,
    items: pack.items.length,
    companies: 0,
    pallets: 0,
    totalKg,
    unplaced,
    placed: pack.packableUnits - unplaced,
    vans: pack.fleet.length,
    missingWeights: 0,
    flags,
  };
}

/* ── Grade a reading against its expectation ───────────────────────────────── */

function grade(r: Reading, e: Expectation | undefined): string[] {
  if (!e) return ["no expectation recorded — run with --update to record this file's baseline"];
  const fails: string[] = [];
  const tol = (e.tolerancePct ?? DEFAULT_TOLERANCE_PCT) / 100;

  if (r.mode !== e.mode) fails.push(`opens in ${r.mode ?? "no"} mode, expected ${e.mode ?? "none"}`);
  if (e.items !== undefined && r.items !== e.items) fails.push(`${r.items} cargo lines, expected ${e.items}`);
  if (e.companies !== undefined && r.companies !== e.companies) fails.push(`${r.companies} companies, expected ${e.companies}`);
  if (e.pallets !== undefined && r.pallets !== e.pallets) fails.push(`${r.pallets} pallets, expected ${e.pallets}`);
  if (e.totalKg !== undefined && Math.abs(r.totalKg - e.totalKg) > e.totalKg * tol) {
    fails.push(`${Math.round(r.totalKg)} kg, expected ~${e.totalKg} (±${(tol * 100).toFixed(0)}%)`);
  }
  const maxUnplaced = e.maxUnplaced ?? 0;
  if (r.unplaced > maxUnplaced) fails.push(`${r.unplaced} units unplaced, expected at most ${maxUnplaced}`);
  if (e.requireAllWeights && r.missingWeights > 0) {
    fails.push(`${r.missingWeights} company/companies have NO pallet weight — the quote would price them at 0 kg`);
  }
  return fails;
}

/* ── Report ────────────────────────────────────────────────────────────────── */

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);
const num = (s: string | number, n: number) => String(s).padStart(n);

async function findPdfs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // skip .ocr-snapshots
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findPdfs(full)));
    else if (entry.name.toLowerCase().endsWith(".pdf")) out.push(full);
  }
  return out.sort();
}

async function loadExpectations(): Promise<Record<string, Expectation>> {
  try {
    return JSON.parse(await readFile(EXPECTATIONS_PATH, "utf8")) as Record<string, Expectation>;
  } catch {
    return {}; // first run — everything is unrecorded, and the report says exactly that
  }
}

async function main(): Promise<void> {
  const all = await findPdfs(ROOT);
  const pdfs = ONLY ? all.filter((p) => p.replace(/\\/g, "/").includes(ONLY)) : all;
  if (pdfs.length === 0) {
    console.error(ONLY ? `No example PDFs match "${ONLY}".` : `No example PDFs under ${ROOT}.`);
    process.exit(1);
  }

  const expectations = await loadExpectations();
  const key = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

  console.log(
    `\nScenario sweep — ${pdfs.length} manifest${pdfs.length === 1 ? "" : "s"}, ` +
      `${LIVE ? "LIVE OCR (billed)" : "saved scans"}${UPDATE ? ", recording baseline" : ""}\n`,
  );

  const results: Array<{ path: string; reading?: Reading; fails: string[]; error?: string }> = [];
  let folder = "";

  for (const path of pdfs) {
    const k = key(path);
    const dir = k.slice(0, k.lastIndexOf("/"));
    if (dir !== folder) {
      folder = dir;
      console.log(`\n  ${folder}`);
      console.log(`  ${"".padEnd(96, "─")}`);
      console.log(
        `  ${pad("file", 34)} ${pad("mode", 11)} ${num("lines", 5)} ${num("co", 3)} ${num("plts", 4)} ` +
          `${num("kg", 7)} ${num("unpl", 4)} ${num("vans", 4)}  result`,
      );
    }

    const name = k.slice(k.lastIndexOf("/") + 1);
    try {
      const reading = await readScenario(path);
      const fails = UPDATE ? [] : grade(reading, expectations[k]);
      results.push({ path, reading, fails });

      const verdict = fails.length === 0 ? "PASS" : `FAIL — ${fails[0]}`;
      console.log(
        `  ${pad(name, 34)} ${pad(reading.mode ?? "—", 11)} ${num(reading.items, 5)} ` +
          `${num(reading.companies || "—", 3)} ${num(reading.pallets || "—", 4)} ` +
          `${num(Math.round(reading.totalKg), 7)} ${num(reading.unplaced, 4)} ${num(reading.vans || "—", 4)}  ${verdict}`,
      );
      for (const f of fails.slice(1)) console.log(`  ${"".padEnd(78)}  also — ${f}`);
      if (DETAIL && name === DETAIL) {
        console.log(`\n  ── everything read from ${name} ──`);
        console.log(`  ${JSON.stringify(reading, null, 2).split("\n").join("\n  ")}\n`);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ path, fails: [`threw: ${error}`], error });
      console.log(`  ${pad(name, 34)} ${pad("—", 11)} ${num("—", 5)} ${num("—", 3)} ${num("—", 4)} ${num("—", 7)} ${num("—", 4)} ${num("—", 4)}  ERROR — ${error}`);
    }
  }

  /* Flags are the never-guess surface: things the pipeline itself said it was unsure about. They do
   * not fail a scenario on their own (a manifest may legitimately need a human eye), but they must
   * never be invisible — that is how a silent misread ships. */
  const flagged = results.filter((r) => r.reading && r.reading.flags.length > 0);
  if (flagged.length > 0) {
    console.log(`\n  ⚠ Needs a human eye (the pipeline said so itself)`);
    console.log(`  ${"".padEnd(96, "─")}`);
    for (const r of flagged) {
      console.log(`  ${key(r.path)}`);
      for (const f of r.reading!.flags.slice(0, 6)) console.log(`      • ${f}`);
      if (r.reading!.flags.length > 6) console.log(`      • …and ${r.reading!.flags.length - 6} more`);
    }
  }

  if (UPDATE) {
    const next: Record<string, Expectation> = { ...expectations };
    for (const r of results) {
      if (!r.reading) continue;
      const k = key(r.path);
      const existing = next[k];
      const isRoster = r.reading.mode === "groupage" || r.reading.mode === "collection";
      next[k] = {
        mode: r.reading.mode,
        ...(isRoster
          ? { companies: r.reading.companies, pallets: r.reading.pallets }
          : { items: r.reading.items }),
        totalKg: Math.round(r.reading.totalKg),
        ...(existing?.tolerancePct !== undefined ? { tolerancePct: existing.tolerancePct } : {}),
        maxUnplaced: existing?.maxUnplaced ?? r.reading.unplaced,
        ...(isRoster ? { requireAllWeights: existing?.requireAllWeights ?? r.reading.missingWeights === 0 } : {}),
        ...(existing?.note !== undefined ? { note: existing.note } : {}),
      };
    }
    const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(EXPECTATIONS_PATH, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
    console.log(`\n  Baseline written to ${relative(process.cwd(), EXPECTATIONS_PATH)} — READ IT before trusting it.\n`);
    return;
  }

  const failed = results.filter((r) => r.fails.length > 0);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed.`);
  if (failed.length > 0) {
    console.log(`\n  Failing scenarios — open one in the app with: npm run dev, then drag the file in`);
    for (const r of failed) {
      console.log(`    ✗ ${key(r.path)}`);
      for (const f of r.fails) console.log(`        ${f}`);
    }
    console.log("");
    process.exit(1);
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
