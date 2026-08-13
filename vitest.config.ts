import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * First test-runner config for the repo. Mirrors the `@/*` → `src/*` alias from
 * tsconfig so test imports match production imports exactly.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.tmp.test.ts"],
  },
});
