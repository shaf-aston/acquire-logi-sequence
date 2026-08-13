import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const config: NextConfig = {
  // Pin the workspace root to this app — silences the multi-lockfile warning
  // caused by a stray lockfile in a parent directory.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),

  // WASM/native OCR deps must load at runtime, not be bundled by webpack.
  serverExternalPackages: ["mupdf", "tesseract.js"],
  // OCR payloads (base64 PDFs) can exceed the default body limit on server actions;
  // the API route uses formData so this is a safety margin for large uploads.
  experimental: {
    serverActions: { bodySizeLimit: "32mb" },
  },
};

export default config;
