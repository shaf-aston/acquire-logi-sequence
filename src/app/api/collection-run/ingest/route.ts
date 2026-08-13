/**
 * POST /api/collection-run/ingest — reads a pickup-manifest PDF and returns CANDIDATE pickup
 * addresses for the operator to confirm. Mirrors /api/ingest-hubs exactly: validate the upload at
 * the trust boundary (size + MIME + %PDF- magic byte), OCR the pages, extract candidates — and
 * NEVER writes state. Confirmation happens in the Collection Run panel, so a bad or malicious
 * upload can never inject an address into a run silently.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { validateUpload, FileValidationError } from "@/lib/ingestion/file.validator";
import { getExtractor } from "@/lib/ocr/extractor.factory";
import { OcrExtractionError } from "@/lib/ocr/extractor.types";
import { getPickupListExtractor } from "@/lib/collection-run/pickup-list-extractor";

export const runtime = "nodejs";

const logger = createLogger("api.collection-run.ingest");

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: "No file provided under field 'file'." }, { status: 400 });
    }

    // Trust boundary — validate BEFORE spending OCR on it.
    const validated = validateUpload({
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      filename: file.name,
    });

    const ocr = await getExtractor().extract(validated);
    const text = ocr.pages.map((p) => p.markdown).join("\n");
    const candidates = await getPickupListExtractor().extract(text);

    logger.info("pickup candidates extracted", {
      file: validated.filename,
      candidates: candidates.length,
      unconfident: candidates.filter((c) => !c.confident).length,
    });
    return NextResponse.json({ success: true, candidates });
  } catch (err) {
    if (err instanceof FileValidationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 422 });
    }
    if (err instanceof OcrExtractionError) {
      return NextResponse.json({ success: false, error: "OCR extraction failed." }, { status: 502 });
    }
    logger.error("unexpected collection-run ingest error", { error: String(err) });
    return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
  }
}
