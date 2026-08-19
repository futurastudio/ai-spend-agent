import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function makeEmptyProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aibill-demo-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("B4 improve --sample demo sitting", () => {
  it("explains itself and stays read-only when non-interactive", async () => {
    const dir = await makeEmptyProject();
    const result = await runCli(["improve", "--sample", "--path", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DEMO");
    expect(result.stdout).toContain("Demo sample data can never start a token test.");
    expect(await readdir(dir)).toEqual([]);
  });

  it("walks the full questionnaire with DEMO on every screen and writes nothing", async () => {
    const dir = await makeEmptyProject();
    const questions: string[] = [];
    const responses = [
      "y",
      "y",
      "Start the next task with only its required files and instructions",
      "Restore the prior session workflow",
      "The project tests pass and the requested output is accepted",
      "Jose Artigas",
      "Futura Studio",
      "Founder",
      "",
      "",
      "APPROVE"
    ];
    const result = await runCli(["improve", "--sample", "--path", dir], {
      interactive: true,
      prompt: async (question) => {
        questions.push(question);
        return responses.shift() ?? "";
      }
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DEMO COMPLETE · nothing was created or stored");
    expect(result.stdout).toContain("can never start a real token test or create a real claim");
    // Exactly one NEXT COMMAND block with exactly one command line.
    expect(result.stdout.match(/NEXT COMMAND/g)).toHaveLength(1);
    // Every screen carries the DEMO banner.
    for (const question of questions) {
      expect(question).toContain("DEMO");
    }
    // The practice-approval disclaimer appeared on the review screen.
    expect(questions.join("\n")).toContain(
      "This is a practice approval. It is not recorded and creates no claim."
    );
    // Fail-closed by construction: the project dir stays untouched.
    expect(await readdir(dir)).toEqual([]);
  });

  it("Enter accepts the suggested plan: y y ⏎ ⏎ ⏎ identity APPROVE completes", async () => {
    const dir = await makeEmptyProject();
    const screens: string[] = [];
    const responses = [
      "y", "y",
      "", "", "",
      "Jose Artigas", "Futura Studio", "Founder", "", "",
      "APPROVE"
    ];
    const result = await runCli(["improve", "--sample", "--path", dir], {
      interactive: true,
      prompt: async (question) => {
        screens.push(question);
        return responses.shift() ?? "";
      }
    });
    expect(result.exitCode).toBe(0);
    const allScreens = screens.join("\n");
    expect(allScreens).toContain('Suggested: "Start with only the files and instructions this task needs."');
    expect(allScreens).toContain("Press Enter to accept it, or type your own.");
    // The accepted suggestions reach the review screen verbatim.
    expect(allScreens).toContain("Change:   Start with only the files and instructions this task needs.");
    expect(allScreens).toContain("Rollback: Restore the prior session workflow.");
    expect(result.stdout).toContain("DEMO COMPLETE");
    expect(await readdir(dir)).toEqual([]);
  });

  it("validators run identically in the demo: a pasted command reprompts", async () => {
    const dir = await makeEmptyProject();
    const screens: string[] = [];
    const responses = [
      "y",
      "y",
      "git status",
      "Start the next task with only its required files",
      "cancel"
    ];
    const result = await runCli(["improve", "--sample", "--path", dir], {
      interactive: true,
      prompt: async (question) => {
        screens.push(question);
        return responses.shift() ?? "";
      }
    });
    expect(result.exitCode).toBe(0);
    expect(screens.join("\n")).toContain("shell command");
    expect(result.stdout).toContain("DEMO ENDED · nothing was created or stored");
    expect(await readdir(dir)).toEqual([]);
  });

  it("runs the demo even from the home directory (no broad-root refusal)", async () => {
    const result = await runCli(["improve", "--sample", "--path", homedir()]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("needs one exact project folder");
    expect(result.stdout).toContain("DEMO");
  });
});
