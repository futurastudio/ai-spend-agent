import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const forbiddenVocabulary = [
  "trust",
  "receipt",
  "ignored by Git",
  "worktree",
  "Refusing to scan",
  "state-receipts"
];

async function expectBroadRootRefusal(argv: string[], _target: string) {
  const result = await runCli(argv);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("needs one exact project folder");
  expect(result.stderr).toContain("cd to an exact project or use --path <project>");
  expect(result.stderr).toContain("Nothing was read, created, or changed.");
  for (const word of forbiddenVocabulary) {
    expect(result.stderr.toLowerCase()).not.toContain(word.toLowerCase());
  }
  // Note: ~/.ai-spend-agent may pre-exist from the historical incident run;
  // gate-before-state is pinned by the vocabulary assertions plus code order.
}

describe("B1 broad-root gate", () => {
  it("refuses improve from the home directory with plain guidance", async () => {
    await expectBroadRootRefusal(["improve", "--path", homedir()], homedir());
  });

  it("refuses improve from the filesystem root", async () => {
    await expectBroadRootRefusal(["improve", "--path", "/"], "/");
  });

  it("refuses improve from a system directory", async () => {
    await expectBroadRootRefusal(["improve", "--path", "/etc"], "/etc");
  });

  it("refuses identify and accountability and outcome from home", async () => {
    for (const command of ["identify", "accountability"]) {
      const result = await runCli([command, "--path", homedir()]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("needs one exact project folder");
    }
    const outcome = await runCli(["outcome", "github", "--path", homedir()]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("needs one exact project folder");
  });

  it("refuses a folder that contains the home directory", async () => {
    const parent = join(homedir(), "..");
    const result = await runCli(["improve", "--path", parent]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/contains your home directory|too broad/);
  });

  it("explains a --path that does not exist without breadth language", async () => {
    const result = await runCli(["improve", "--path", "/nope-this-does-not-exist-aibill"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The folder you pointed at does not exist.");
    expect(result.stderr).toContain("cd to an exact project or use --path <project>");
    expect(result.stderr).not.toContain("Refusing to scan");
  });

  it("keeps --sample exempt from the gate (guided demo, B4)", async () => {
    const result = await runCli(["improve", "--sample", "--path", homedir()]);
    expect(result.exitCode).toBe(0);
    // The demo reads nothing, so no broad-root wording may appear.
    expect(result.stderr ?? "").not.toContain("needs one exact project folder");
    expect(result.stdout).toContain("DEMO");
  });

  it("never echoes or keeps a credential-shaped identify flag (B3/B4 QA M1)", async () => {
    const project = await mkdtemp(join(tmpdir(), "aibill-m1-identify-"));
    cleanups.push(() => rm(project, { recursive: true, force: true }));
    const secret = "sk-ant-api03-flagSECRET1234567890";
    const screens: string[] = [];
    const responses = ["Jose Artigas", "Platform", "Lead", "", "", "y"];
    const result = await runCli(["identify", "--path", project, "--person", secret], {
      interactive: true,
      prompt: async (question) => {
        screens.push(question);
        return responses.shift() ?? "";
      }
    });
    // The invalid seed is dropped: never echoed, never Enter-keepable, and
    // the flow completes with the typed owner instead of aborting.
    expect(screens.join("\n")).not.toContain(secret);
    expect(result.stdout).not.toContain(secret);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("owner: Jose Artigas");
    expect(result.stdout).toContain("NEXT COMMAND");
  });

  it("identify confirm back re-opens the fields prefilled instead of discarding", async () => {
    const project = await mkdtemp(join(tmpdir(), "aibill-m3-identify-"));
    cleanups.push(() => rm(project, { recursive: true, force: true }));
    const responses = [
      "Jose Artigas", "Platform", "Lead", "", "",
      "back",
      // Prefilled revisit: keep owner/team, replace role, skip optionals.
      "", "", "Founder", "", "",
      "y"
    ];
    const result = await runCli(["identify", "--path", project], {
      interactive: true,
      prompt: async () => responses.shift() ?? ""
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("owner: Jose Artigas");
    expect(result.stdout).toContain("approval role: Founder");
  });

  it("still runs normally from an exact project folder", async () => {
    const project = await mkdtemp(join(tmpdir(), "aibill-b1-project-"));
    cleanups.push(() => rm(project, { recursive: true, force: true }));
    await mkdir(join(project, "src"), { recursive: true });
    const result = await runCli(["accountability", "--path", project]);
    // Any exit is fine; the gate must not fire and no broad-root text appears.
    expect(result.stderr ?? "").not.toContain("needs one exact project folder");
  });
});
