/**
 * Reads a company ROSTER off a document for the shared-truck planner's fast path.
 *
 * Two entry points, one shared tail (getConsignmentReader().read):
 *   - fromUpload: a freshly dropped PDF → validate → OCR → build structured doc → read.
 *   - fromDocument: a document the client ALREADY holds (the manifest ingested at the
 *     start of the quote flow) → read directly, skipping re-OCR entirely.
 *
 * This is deliberately LEANER than ingestPdf: the planner only needs the roster, so it
 * skips classification, address detection, and stop attribution. Knows nothing about
 * HTTP — callable from the API route or a test.
 */
import { createLogger } from "@/lib/logger/logger";
import { PerfTracker } from "@/lib/perf/tracker";
import { getExtractor } from "@/lib/ocr/extractor.factory";
import { buildStructuredDocument } from "@/lib/conversion/document.builder";
import { validateUpload } from "@/lib/ingestion/file.validator";
import { getConsignmentReader } from "@/lib/groupage/consignment-reader.factory";
import { collapseHubJourneyToTrunk, type HubCollapse } from "@/lib/groupage/hub-consolidation";
import type { ConsignmentRoster } from "@/lib/groupage/consignment-reader.types";
import type { StructuredDocument } from "@/lib/conversion/types";

export interface ConsignmentUploadInput {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly filename: string;
  /** Correlation id so one request can be traced end-to-end through the logs. */
  readonly requestId: string;
}

/** Read a roster from a freshly uploaded PDF: validate → OCR → build → read. */
export async function readConsignmentsFromUpload(
  input: ConsignmentUploadInput,
): Promise<RosterReadResult> {
  const logger = createLogger("groupage.consignment-read").child({ requestId: input.requestId });
  const perf = new PerfTracker(logger);

  logger.info("roster read from upload started", {
    file: input.filename,
    bytes: input.bytes.byteLength,
  });

  const file = await perf.track("validate", async () =>
    validateUpload({ bytes: input.bytes, mimeType: input.mimeType, filename: input.filename }),
  );

  const extractor = getExtractor();
  const ocr = await perf.track("ocr", () =>
    extractor.extract({ bytes: file.bytes, mimeType: file.mimeType, filename: file.filename }),
  );

  const document = await perf.track("convert", async () => buildStructuredDocument(ocr));

  return readConsignmentsFromDocument(document, input.requestId);
}

/** A read roster plus (when a hub-consolidation manifest was detected) the trunk-load collapse notice. */
export type RosterReadResult = ConsignmentRoster & { readonly hubCollapse: HubCollapse };

/**
 * Read a roster from an already-built structured document — the reuse path. No OCR,
 * no network beyond the reader engine itself. The reader is fail-soft, so this never
 * throws on a bad read; it returns an empty roster.
 *
 * When the document is a HUB CONSOLIDATION manifest (collect → hub → trunk → deliver),
 * the reader honestly returns both legs — the same load counted twice. We collapse
 * that to the single trunk load the truck carries (see hub-consolidation.ts). A normal
 * roster passes through unchanged, so `hubCollapse.collapsed` is false for it.
 */
export async function readConsignmentsFromDocument(
  document: StructuredDocument,
  requestId: string,
): Promise<RosterReadResult> {
  const logger = createLogger("groupage.consignment-read").child({ requestId });
  const reader = getConsignmentReader();
  const raw = await reader.read(document);
  // The rule parser resolves a two-leg hub manifest itself — it keeps the per-company COLLECTION
  // legs (the ones the cargo summary weighs) and drops the delivery mirror, leaving its reasoning
  // in `notes`. That is a strictly better read than the blind collapse below, which fuses every
  // company into one "Consolidated trunk load" and keeps only the heaviest pallet weight. So when
  // the reader has already reconciled the legs, take its roster and just carry the note through.
  if (raw.notes && raw.notes.length > 0) {
    logger.info("roster read complete", {
      provider: reader.provider,
      consignments: raw.consignments.length,
      hubCollapsed: true,
      rawConsignments: raw.consignments.length,
    });
    return { ...raw, hubCollapse: { collapsed: true, reasons: raw.notes } };
  }
  const { roster, collapse } = collapseHubJourneyToTrunk(raw);
  logger.info("roster read complete", {
    provider: reader.provider,
    consignments: roster.consignments.length,
    hubCollapsed: collapse.collapsed,
    rawConsignments: raw.consignments.length,
  });
  return { ...roster, hubCollapse: collapse };
}
