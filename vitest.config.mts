import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Route handlers import through the same "@/" alias as tsconfig.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // The database-backed suites share one Postgres, so they must not run
    // against it at the same time.
    fileParallelism: false,
  },
});
