/**
 * Thin HTTP wrapper over the ingestion service. No business logic here — it only
 * adapts the multipart request into IngestionInput and shapes the JSON response.
 */
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/logger/logger";
import { ingestPdf } from "@/lib/ingestion/ingestion.service";
import { FileValidationError } from "@/lib/ingestion/file.validator";
import { OcrExtractionError } from "@/lib/ocr/extractor.types";
import { getConfig } from "@/config/env";

export const runtime = "nodejs";

const logger = createLogger("api.ingest");

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req_${Date.now()}`;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: "No file provided under field 'file'." },
        { status: 400 },
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingestPdf({
      bytes,
      mimeType: file.type,
      filename: file.name,
      requestId,
    });

    // Ship the mode-decision thresholds so the client can run the (pure) mode
    // selector once it also has the load plan — the one place both signals meet.
    return NextResponse.json({
      success: true,
      requestId,
      ...result,
      modeRules: getConfig().modeSelection,
    });
  } catch (err) {
    if (err instanceof FileValidationError) {
      return NextResponse.json({ success: false, requestId, error: err.message }, { status: 422 });
    }
    if (err instanceof OcrExtractionError) {
      return NextResponse.json(
        { success: false, requestId, error: "OCR extraction failed." },
        { status: 502 },
      );
    }
    logger.error("unexpected ingestion error", { requestId, error: String(err) });
    return NextResponse.json(
      { success: false, requestId, error: "Internal error." },
      { status: 500 },
    );
  }
}
