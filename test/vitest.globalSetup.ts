import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import "./homeWriteGuard.js";

/**
 * Suite-wide sandbox, local and CI alike. Before any worker starts:
 *
 * - remember the launch-time home so the write trap knows what to protect,
 * - point HOME (and USERPROFILE) at a throwaway directory so every
 *   os.homedir() fallback lands in it,
 * - arm both telemetry kill-switches so nothing can reach production
 *   telemetry, whether or not CI=true is set.
 *
 * vitest.setup.ts then gives each test file its own HOME under the same root.
 */
const ISOLATED_ENV = ["HOME", "USERPROFILE", "AI_SPEND_NO_TELEMETRY", "DO_NOT_TRACK"] as const;

export default function setup(project: TestProject): () => void {
  const launchHome = homedir();
  const testRoot = realpathSync(mkdtempSync(join(tmpdir(), "aibill-vitest-run-")));
  const suiteHome = join(testRoot, "home");
  mkdirSync(suiteHome, { mode: 0o700 });

  const previous = Object.fromEntries(ISOLATED_ENV.map((key) => [key, process.env[key]]));
  process.env.HOME = suiteHome;
  process.env.USERPROFILE = suiteHome;
  process.env.AI_SPEND_NO_TELEMETRY = "1";
  process.env.DO_NOT_TRACK = "1";

  project.provide("aibillLaunchHome", launchHome);
  project.provide("aibillTestRoot", testRoot);
  project.provide("aibillRepoRoot", project.config.root);

  return () => {
    for (const key of ISOLATED_ENV) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch (error) {
      // A test that left a read-only fixture behind must not fail the run;
      // the directory is inside the OS temp dir either way.
      console.warn(`aibill vitest: could not remove ${testRoot}: ${String(error)}`);
    }
  };
}
