/**
 * POST /api/groupage/consignments/read — the shared-truck planner's fast path.
 * Turns a document into a ROSTER of draft consignments (several companies, each with
 * its origin, destination, and pallet lines) that the operator then confirms.
 *
 * Two ways in, decided by Content-Type so the client picks the cheaper one:
 *   - multipart/form-data with `file`  → a freshly dropped PDF (validate → OCR → read).
 *   - application/json with `{ document }` → reuse the manifest already ingested at the
 *     start of the quote flow — no re-upload, no re-OCR.
 *
 * Thin transport: validate the untrusted shape at the boundary, delegate to the read
 * service, shape the JSON. The reader is fail-soft, so a document it can't read comes
 * back as an empty roster (200), never a 500 — an empty roster is an honest answer.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { getConfig } from "@/config/env";
import { readJsonBody } from "@/lib/groupage/parse";
import {
  readConsignmentsFromUpload,
  readConsignmentsFromDocument,
} from "@/lib/groupage/consignment-read.service";
import { FileValidationError } from "@/lib/ingestion/file.validator";
import { OcrExtractionError } from "@/lib/ocr/extractor.types";
import { GroupageError } from "@/lib/groupage/groupage.types";
import type { StructuredDocument, PageContent } from "@/lib/conversion/types";

export const runtime = "nodejs";

const logger = createLogger("api.groupage.consignments.read");

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}`;
}

/**
 * Boundary check for the reuse path: the client sends back a document it received from
 * ingest, but it is still untrusted input. We assert only the shape the reader walks
 * (pages[].markdown + pages[].tables) — enough to fail loud on garbage, not a full
 * schema clone. Malformed rows inside a table degrade in the reader, not here.
 */
function parseDocument(body: unknown): StructuredDocument {
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const doc = o.document;
  if (typeof doc !== "object" || doc === null) {
    throw new GroupageError("input", "Provide a `document` object (from an earlier upload) or POST a PDF.");
  }
  const d = doc as Record<string, unknown>;
  if (!Array.isArray(d.pages)) {
    throw new GroupageError("input", "`document.pages` must be an array.");
  }
  const pages: PageContent[] = d.pages.map((p, i) => {
    const pg = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
    if (typeof pg.markdown !== "string" || !Array.isArray(pg.tables)) {
      throw new GroupageError("input", `document.pages[${i}] must have a string 'markdown' and an array 'tables'.`);
    }
    return pg as unknown as PageContent;
  });
  return {
    pageCount: pages.length,
    tableCount: pages.reduce((n, p) => n + p.tables.length, 0),
    pages,
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  const contentType = request.headers.get("content-type") ?? "";
  try {
    let roster;
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { success: false, requestId, error: "No file provided under field 'file'." },
          { status: 400 },
        );
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      roster = await readConsignmentsFromUpload({
        bytes,
        mimeType: file.type,
        filename: file.name,
        requestId,
      });
    } else {
      const body = await readJsonBody(request, getConfig().groupage.maxRequestBodyBytes);
      const document = parseDocument(body);
      roster = await readConsignmentsFromDocument(document, requestId);
    }

    return NextResponse.json({ success: true, requestId, ...roster });
  } catch (err) {
    if (err instanceof GroupageError) {
      return NextResponse.json({ success: false, requestId, error: err.message }, { status: 400 });
    }
    if (err instanceof FileValidationError) {
      return NextResponse.json({ success: false, requestId, error: err.message }, { status: 422 });
    }
    if (err instanceof OcrExtractionError) {
      return NextResponse.json({ success: false, requestId, error: "OCR extraction failed." }, { status: 502 });
    }
    if (err instanceof SyntaxError) {
      return NextResponse.json({ success: false, requestId, error: "Request body is not valid JSON." }, { status: 400 });
    }
    logger.error("unexpected roster-read error", { requestId, error: String(err) });
    return NextResponse.json({ success: false, requestId, error: "Internal error." }, { status: 500 });
  }
}
