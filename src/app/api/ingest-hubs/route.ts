/**
 * POST /api/ingest-hubs — hub-sourcing tier 3. Reads a client's depot-list PDF and returns
 * CANDIDATE hubs for the operator to confirm. It validates the upload at the trust boundary
 * (size + MIME + %PDF- magic byte, same guards as /api/ingest), OCRs the pages, and extracts
 * candidates — but it NEVER writes the hub network. Confirmation happens in the UI via /api/hubs,
 * so a bad or malicious upload can never silently corrupt the live network.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { validateUpload, FileValidationError } from "@/lib/ingestion/file.validator";
import { getExtractor } from "@/lib/ocr/extractor.factory";
import { OcrExtractionError } from "@/lib/ocr/extractor.types";
import { extractHubCandidates } from "@/lib/groupage/hub-extractor";

export const runtime = "nodejs";

const logger = createLogger("api.ingest-hubs");

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
    const { candidates, duplicates } = extractHubCandidates(text);

    logger.info("hub candidates extracted", {
      file: validated.filename,
      candidates: candidates.length,
      duplicates: duplicates.length,
    });
    return NextResponse.json({ success: true, candidates, duplicates });
  } catch (err) {
    if (err instanceof FileValidationError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 422 });
    }
    if (err instanceof OcrExtractionError) {
      return NextResponse.json({ success: false, error: "OCR extraction failed." }, { status: 502 });
    }
    logger.error("unexpected ingest-hubs error", { error: String(err) });
    return NextResponse.json({ success: false, error: "Internal error." }, { status: 500 });
  }
}
