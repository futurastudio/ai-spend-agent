import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, inject } from "vitest";
import { installHomeWriteGuard, takeHomeWriteViolations } from "./homeWriteGuard.js";

// Runs before every test file. Each file gets its own throwaway HOME, so home
// state one file persists (signup.json, telemetry.json, private-state) can
// never leak into another file, and never into the developer's real home.
const testRoot = inject("aibillTestRoot");
const home = mkdtempSync(join(testRoot, "home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AI_SPEND_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";

installHomeWriteGuard({
  launchHome: inject("aibillLaunchHome"),
  allowedRoots: [testRoot, inject("aibillRepoRoot")]
});

function failOnRealHomeWrites(where: string): void {
  const violations = takeHomeWriteViolations();
  if (violations.length === 0) return;
  throw new Error(
    `${where} wrote inside the real home directory (refused):\n` +
    violations.map((violation) => `  - ${violation}`).join("\n")
  );
}

// Registered first, so these run after the file's own after-hooks too.
afterEach((context) => failOnRealHomeWrites(`test "${context.task.name}"`));
afterAll(() => failOnRealHomeWrites("a suite-level hook"));
