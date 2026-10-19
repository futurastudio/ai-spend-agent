import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@agent-finops/core": resolve(__dirname, "packages/core/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "test/**/*.test.ts"],
    // Never the developer's real HOME: a throwaway HOME per test file, both
    // telemetry kill-switches armed, and a trap that fails any test writing
    // inside the launch-time home directory (see test/).
    globalSetup: ["test/vitest.globalSetup.ts"],
    setupFiles: ["test/vitest.setup.ts"]
  }
});
