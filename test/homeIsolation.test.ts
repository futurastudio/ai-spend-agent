import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { runCli } from "../packages/cli/src/index.js";
import {
  PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV,
  projectAccountabilityStatePath
} from "../packages/cli/src/projectAccountabilityState.js";
import { signupStateFilePath } from "../packages/cli/src/signup.js";
import { telemetryStateFilePath } from "../packages/cli/src/telemetry.js";
import { takeHomeWriteViolations } from "./homeWriteGuard.js";

/**
 * Guard for the suite's HOME isolation (2026-10-18 incident: Vitest runs wrote
 * owner/team labels into the founder's real ~/.aibill/private-state).
 *
 * If test/vitest.globalSetup.ts or test/vitest.setup.ts is unwired, or the
 * write trap stops catching a write, this file fails.
 */
const launchHome = inject("aibillLaunchHome");
const testRoot = inject("aibillTestRoot");

const isInside = (path: string, root: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** Clear the private-state overrides so the os.homedir() fallback is what runs. */
function withoutStateOverrides(): void {
  const keys = [PROJECT_ACCOUNTABILITY_PRIVATE_STATE_DIRECTORY_ENV, "AI_SPEND_STATE_TRUST_DIR"];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  cleanups.push(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function projectRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aibill-home-isolation-project-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("suite HOME isolation", () => {
  it("runs every test file under a throwaway HOME, never the launch-time home", () => {
    expect(launchHome).toBeTruthy();
    expect(testRoot).toBeTruthy();
    const home = homedir();
    expect(home).not.toBe(launchHome);
    expect(isInside(home, testRoot)).toBe(true);
    expect(process.env.HOME).toBe(home);
    expect(process.env.USERPROFILE).toBe(home);
  });

  it("arms both telemetry kill-switches whether or not CI is set", () => {
    expect(process.env.AI_SPEND_NO_TELEMETRY).toBe("1");
    expect(process.env.DO_NOT_TRACK).toBe("1");
  });

  it("resolves the CLI's default home state inside the throwaway HOME", async () => {
    withoutStateOverrides();
    const home = homedir();
    expect(isInside(signupStateFilePath(), home)).toBe(true);
    expect(isInside(telemetryStateFilePath(), home)).toBe(true);
    expect(isInside(await projectAccountabilityStatePath(await projectRoot(), { create: true }), home)).toBe(true);
  });

  it("keeps identify's private owner labels out of the real home (the incident path)", async () => {
    // The exact flow that leaked: an interactive identify with no injected
    // HOME and no private-state override, so os.homedir() decides.
    withoutStateOverrides();
    const project = await projectRoot();
    const responses = ["Isolation Probe", "Platform", "Lead", "", "", "y"];
    const identified = await runCli(["identify", "--path", project], {
      interactive: true,
      prompt: async () => responses.shift() ?? ""
    });
    expect(identified.exitCode).toBe(0);
    const statePath = await projectAccountabilityStatePath(project);
    expect(isInside(statePath, homedir())).toBe(true);
    expect(await readFile(statePath, "utf8")).toContain("Isolation Probe");
    expect(takeHomeWriteViolations()).toEqual([]);
  });

  it("refuses and reports any write inside the launch-time home", async () => {
    // The probe's parent never exists, so even with the trap gone these calls
    // could only fail with ENOENT: the probe cannot create anything at home.
    const probe = join(launchHome, `.aibill-home-guard-probe-${process.pid}-${Date.now()}`, "probe.json");
    await expect(writeFile(probe, "{}")).rejects.toMatchObject({ code: "EACCES" });
    expect(() => writeFileSync(probe, "{}")).toThrow(/test home guard/);
    expect(() => mkdirSync(join(dirname(probe), "nested"))).toThrow(/test home guard/);

    const violations = takeHomeWriteViolations();
    expect(violations).toHaveLength(3);
    expect(violations.every((violation) => violation.includes(basename(dirname(probe))))).toBe(true);
  });
});
