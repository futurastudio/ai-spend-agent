import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-finops/core": resolve(__dirname, "packages/core/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/web/**/*.test.ts"]
  }
});
