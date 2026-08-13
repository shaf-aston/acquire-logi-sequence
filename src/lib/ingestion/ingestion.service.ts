/**
 * Stage 1 orchestrator: validate → OCR → convert to structured tables.
 * Each step is a separate module; this service only wires them and times them.
 * Knows nothing about HTTP or the UI — callable from an API route or a CLI.
 */
import { createHash } from "node:crypto";
import { createLogger } from "@/lib/logger/logger";
import { PerfTracker, type PerfReport } from "@/lib/perf/tracker";
import { getExtractor } from "@/lib/ocr/extractor.factory";
import { buildStructuredDocument } from "@/lib/conversion/document.builder";
import { validateUpload } from "@/lib/ingestion/file.validator";
import { getClassifier } from "@/lib/classification/classifier.factory";
import { loadColumnMap } from "@/lib/packing/column-map";
import { attributeStops } from "@/lib/packing/stop-attributor";
import { getObjectStore } from "@/lib/storage/store.factory";
import { getAddressExtractor } from "@/lib/ingestion/address-extractor.factory";
import { detectDirection, detectOutboundHubPostcode, loadAddressDetectionConfig } from "@/lib/ingestion/address-detector";
import { detectHubConsolidationManifest, type HubManifestSignal } from "@/lib/ingestion/hub-manifest-detector";
import { readManifestHubs, widenCollectionHubCatchment, type ManifestHub } from "@/lib/groupage/manifest-hub-reader";
import { parseCollectionRunRoster } from "@/lib/groupage/collection-run-parser";
import type { DetectedAddresses, Direction } from "@/lib/ingestion/address-detector";
import type { StructuredDocument } from "@/lib/conversion/types";
import type { ClassificationResult } from "@/lib/classification/types";

export interface IngestionInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  /** Correlation id for tracing one request end-to-end through the logs. */
  readonly requestId: string;
}

export interface IngestionResult {
  readonly filename: string;
  readonly provider: string;
  readonly document: StructuredDocument;
  readonly classification: ClassificationResult;
  readonly addresses: DetectedAddresses;
  /** Which way the sheet runs — "collect" flips the quote form to collection mode (advisory). */
  readonly direction: Direction;
  /**
   * Row id (`${page}-${table}-${row}`) → 0-based drop index, read from a multi-drop
   * manifest's Stop/Drop column. Empty on a single-drop sheet. Lets the quote form
   * prefill each cargo row's drop tag instead of defaulting every row to "Drop 1".
   */
  readonly itemStopIndex: Record<string, number>;
  /** Advisory signal that this is a groupage/hub-consolidation manifest — drives the UI nudge to the shared-truck planner. */
  readonly hubManifest: HubManifestSignal;
  /**
   * Postcode of the destination/outbound hub named on the sheet (from a hub-transfer table), or
   * null. On a collection round the outbound trunk aims here when no delivery addresses were read
   * to be nearest to — so the milk-round hands off to the RIGHT outbound hub, not the operator's guess.
   */
  readonly outboundHubPostcode: string | null;
  /**
   * Hubs the manifest NAMES for itself (its "Collection/Origin Hub" + "Destination Hub" columns),
   * one per distinct postcode area. Empty when the sheet names none. These are SUGGESTIONS the
   * client shows and can edit — added to the session so a quote routes through the hubs THIS
   * document describes, never silently written to the saved network. See manifest-hub-reader.
   */
  readonly manifestHubs: readonly ManifestHub[];
  readonly perf: PerfReport;
}

/**
 * Persist the source PDF and its structured document to the object store, keyed
 * by the PDF's sha256 so re-uploads are idempotent. Swallows all errors (logs a
 * warning) — archiving is best-effort and out of the request's critical path.
 * A NoopObjectStore (the default) makes this a cheap no-op.
 */
async function archiveArtifacts(
  bytes: Uint8Array,
  document: StructuredDocument,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const store = getObjectStore();
  if (store.backend === "noop") return;

  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    await Promise.all([
      store.put({ key: `raw/${hash}.pdf`, body: bytes, contentType: "application/pdf" }),
      store.put({
        key: `documents/${hash}.json`,
        body: new TextEncoder().encode(JSON.stringify(document)),
        contentType: "application/json",
      }),
    ]);
    logger.info("artifacts archived", { hash, backend: store.backend });
  } catch (err) {
    logger.warn("artifact archive failed — continuing", { error: String(err) });
  }
}

export async function ingestPdf(input: IngestionInput): Promise<IngestionResult> {
  const logger = createLogger("ingestion").child({ requestId: input.requestId });
  const perf = new PerfTracker(logger);

  logger.info("ingestion started", { file: input.filename, bytes: input.bytes.byteLength });

  const file = await perf.track("validate", async () =>
    validateUpload({ bytes: input.bytes, mimeType: input.mimeType, filename: input.filename }),
  );

  const extractor = getExtractor();
  const ocr = await perf.track("ocr", () =>
    extractor.extract({ bytes: file.bytes, mimeType: file.mimeType, filename: file.filename }),
  );

  // The column-heading vocabulary comes from config (column-map.json), never from this layer. It lets
  // the converter tell a real header row from a section banner or a letterhead sitting on top of it —
  // without which the columns resolve against the banner and the packer reads a weight as a dimension.
  const columnMap = await loadColumnMap();
  const document = await perf.track("convert", async () =>
    buildStructuredDocument(ocr, { headerVocabulary: Object.values(columnMap.headerPatterns).filter((rx): rx is RegExp => rx instanceof RegExp) }),
  );

  // Archive source PDF + clean document, content-addressed. Fire-and-forget so it
  // stays off the request's critical path — archiving must never add latency to or
  // fail ingestion. It catches its own errors; `void` marks the intentional no-await.
  void archiveArtifacts(input.bytes, document, logger);

  const classifier = getClassifier();
  const classification = await perf.track("classify", () => classifier.classify(document));

  // Engine chosen by config (ADDRESS_EXTRACTOR_PROVIDER): rule detector or LLM.
  // Fail-soft by contract — the extractor degrades to a weaker result, never throws.
  const addressExtractor = getAddressExtractor();
  const addresses = await perf.track("detect-addresses", () =>
    addressExtractor.extract(document),
  );

  // Attribute each cargo row to its delivery stop from the manifest's Stop/Drop
  // column (multi-drop groupage). Empty for single-drop sheets. Pure + cheap —
  // reuses the cached column map. Independent of address detection so neither can
  // break the other.
  const itemStopIndex = await perf.track("attribute-stops", async () =>
    attributeStops(document, classification, await loadColumnMap()),
  );

  // Collect-vs-deliver hint from document-level keywords. A separate pass from address
  // extraction so it holds whichever extractor (rule/LLM) is wired in. Advisory only —
  // the client pre-selects collection mode from it but the operator can switch back.
  const direction = await perf.track("detect-direction", async () =>
    detectDirection(document, (await loadAddressDetectionConfig()).collectionSignals),
  );

  // Destination/outbound hub named on the sheet (fallback trunk target when no delivery stops
  // were read). Same cached config, pure + fail-soft — null when the sheet names no such hub.
  const addressCfg = await loadAddressDetectionConfig();
  const outboundHubPostcode = detectOutboundHubPostcode(document, addressCfg);

  // Hubs the manifest names for itself (Collection/Origin/Destination hub columns). Pure + fail-soft;
  // reuses the config postcode regex so there is one source for "what a UK postcode looks like".
  // Then widen the collection hub to cover EVERY area the collection run collects from (its own
  // postcode only seeds one area), so all companies resolve to the one consolidation hub and share a
  // truck instead of scattering to their nearest saved hub. Origins come from the same roster reader
  // the shared-truck planner uses — no new parse of the document.
  // Called with NO options, deliberately: the only field read off the roster here is
  // `originPostcode`, and neither tunable option affects it (`maxPlausibleDerivedPalletKg` gates a
  // derived WEIGHT, `oversizeSideCm` classifies a FOOTPRINT). Loading the groupage config just to
  // pass values nothing reads would either couple every ingest — including plain point-to-point
  // jobs that never touch groupage — to the health of config/groupage-rates.json, or need a
  // try/catch that silently swallows a broken config. Both are worse than not asking. The quoting
  // path (rule-consignment-reader.ts) DOES thread the real config, and that is where it matters.
  const manifestHubs = widenCollectionHubCatchment(
    readManifestHubs(document, { postcodePattern: new RegExp(addressCfg.postcodePattern) }),
    parseCollectionRunRoster(document)
      .consignments.map((c) => c.originPostcode)
      .filter((p): p is string => p !== null),
  );

  const hubManifest = detectHubConsolidationManifest(document);

  const report = perf.report();
  logger.info("ingestion complete", {
    file: input.filename,
    pages: document.pageCount,
    tables: document.tableCount,
    items: classification.items.length,
    fragile: classification.counts.fragile,
    pickupDetected: addresses.pickup !== null,
    dropsDetected: addresses.drops.length,
    deliveriesDetected: addresses.deliveries?.length ?? 0,
    direction,
    outboundHub: outboundHubPostcode,
    manifestHubs: manifestHubs.length,
    cargoRowsTaggedToStops: Object.keys(itemStopIndex).length,
    totalMs: report.totalMs,
  });

  return {
    filename: input.filename,
    provider: extractor.provider,
    document,
    classification,
    addresses,
    direction,
    itemStopIndex,
    hubManifest,
    outboundHubPostcode,
    manifestHubs,
    perf: report,
  };
}
