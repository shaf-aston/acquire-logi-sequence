import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Separate config for the slow, keyless Tesseract ingestion e2e suite — kept
 * OUT of the default `vitest run` (vitest.config.ts) so `npm test` stays fast.
 * Mirrors the `@/*` → `src/*` alias from vitest.config.ts / tsconfig.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
