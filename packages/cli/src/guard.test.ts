import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGuard, formatRemaining, formatTokenCount } from "./guard.js";
import { runGuardHook } from "./guardHook.js";
import {
  GUARD_HOOK_COMMAND,
  GUARD_MANAGED_HOOK_COMMAND,
  buildGuardLauncherSource,
  mergeGuardSettings,
  removeGuardSettings
} from "./guardSettings.js";
import { computeGuardUsage, guardUsageCachePath } from "./guardUsage.js";
import { runCli } from "./index.js";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-11-04T15:00:00.000Z");
const DAY = "2026-11-04";

type Fixture = Awaited<ReturnType<typeof fixture>>;

const policy = {
  version: 1,
  models: { allow: ["sonnet", "haiku"], deny: ["claude-opus-5-5"] },
  budget: { perDay: { tokens: 1_500_000, sessions: 2 } },
  message: "Daily agent budget for this repository is spent. Ask the platform team for an exception.",
  codex: { model: "gpt-5.6" }
};

/** `null` builds a repository without a policy file. */
async function fixture(policyOverride: unknown = policy) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aibill-guard-")));
  const repo = join(root, "checkout-api");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "src"), { recursive: true });
  const projectsDir = join(root, "claude-projects");
  await mkdir(projectsDir);
  const cacheDir = join(root, "cache");
  const home = join(root, "home");
  await mkdir(home);
  if (policyOverride !== null) {
    await mkdir(join(repo, ".aibill"), { recursive: true });
    await writeFile(join(repo, ".aibill", "policy.json"), `${JSON.stringify(policyOverride, null, 2)}\n`);
  }
  process.env.AI_SPEND_CLAUDE_LOGS_DIR = projectsDir;
  process.env.AIBILL_CACHE_DIR = cacheDir;
  return { root, repo, projectsDir, cacheDir, home };
}

function transcriptLine(options: {
  cwd: string;
  sessionId: string;
  requestId: string;
  tokens: number;
  timestamp?: string;
  final?: boolean;
  model?: string;
}): string {
  const output = 100;
  return JSON.stringify({
    type: "assistant",
    timestamp: options.timestamp ?? `${DAY}T10:00:00.000Z`,
    cwd: options.cwd,
    sessionId: options.sessionId,
    requestId: options.requestId,
    message: {
      id: `msg-${options.requestId}`,
      model: options.model ?? "claude-sonnet-5",
      ...(options.final === false ? {} : { stop_reason: "end_turn" }),
      usage: {
        input_tokens: options.tokens - output,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    }
  });
}

async function writeTranscript(test: Fixture, name: string, lines: string[]): Promise<string> {
  const directory = join(test.projectsDir, "-checkout-api");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

const hookStdin = (input: Record<string, unknown>) => Readable.from([JSON.stringify(input)]);

const deps = (test: Fixture) => ({ claudeProjectsDir: test.projectsDir, cacheDirectory: test.cacheDir, homeDirectory: test.home });

const previousEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ["AI_SPEND_CLAUDE_LOGS_DIR", "AIBILL_CACHE_DIR"]) previousEnv[key] = process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("guard install", () => {
  it("writes the model allowlist, both hooks and the launcher into a fresh repository", async () => {
    const test = await fixture();
    const result = await runCli(["guard", "install", "--path", join(test.repo, "src")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill guard installed for checkout-api.");
    expect(result.stdout).toContain(".claude/settings.json: created");
    expect(result.stdout).toContain(".aibill/guard-hook.mjs: created");
    expect(result.stdout).toContain("models.deny: reported only at project scope");
    expect(result.stdout).toContain("codex.model gpt-5.6: reported only");

    const settings = JSON.parse(await readFile(join(test.repo, ".claude", "settings.json"), "utf8"));
    expect(settings).toEqual({
      availableModels: ["sonnet", "haiku"],
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: GUARD_HOOK_COMMAND, timeout: 10 }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: GUARD_HOOK_COMMAND, timeout: 10 }] }]
      }
    });
    expect(GUARD_HOOK_COMMAND).toBe('node "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs"');
    const launcher = await readFile(join(test.repo, ".aibill", "guard-hook.mjs"), "utf8");
    expect(launcher).toBe(buildGuardLauncherSource());
    expect(launcher).toContain("ai-spend-agent/package.json");
  });

  it("merges into existing settings, is idempotent, and uninstall restores the original bytes", async () => {
    const test = await fixture();
    const original = `${JSON.stringify({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./scripts/lint-bash.sh" }] }]
      },
      theme: "dark"
    }, null, 2)}\n`;
    const settingsPath = join(test.repo, ".claude", "settings.json");
    await mkdir(join(test.repo, ".claude"));
    await writeFile(settingsPath, original);

    const first = await runCli(["guard", "install", "--path", test.repo]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(".claude/settings.json: updated · availableModels: set to sonnet, haiku · hooks.UserPromptSubmit: guard hook added · hooks.PreToolUse: guard hook added");
    const merged = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(merged.$schema).toBe("https://json.schemastore.org/claude-code-settings.json");
    expect(merged.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(merged.theme).toBe("dark");
    expect(merged.availableModels).toEqual(["sonnet", "haiku"]);
    expect(merged.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/lint-bash.sh" }] },
      { hooks: [{ type: "command", command: GUARD_HOOK_COMMAND, timeout: 10 }] }
    ]);
    expect(merged.hooks.UserPromptSubmit).toHaveLength(1);
    const afterFirst = await readFile(settingsPath, "utf8");

    const second = await runCli(["guard", "install", "--path", test.repo]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already installed for checkout-api; nothing changed");
    expect(await readFile(settingsPath, "utf8")).toBe(afterFirst);

    // A developer's own formatting survives an install with nothing to add.
    const reformatted = JSON.stringify(JSON.parse(afterFirst), null, 4);
    await writeFile(settingsPath, reformatted);
    await runCli(["guard", "install", "--path", test.repo]);
    expect(await readFile(settingsPath, "utf8")).toBe(reformatted);
    await writeFile(settingsPath, afterFirst);

    const removed = await runCli(["guard", "install", "--uninstall", "--path", test.repo]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain(".claude/settings.json: updated · availableModels: removed · hooks.UserPromptSubmit: guard hook removed · hooks.PreToolUse: guard hook removed");
    expect(removed.stdout).toContain(".aibill/guard-hook.mjs: removed");
    expect(removed.stdout).toContain(".aibill/policy.json is yours and was not touched");
    expect(await readFile(settingsPath, "utf8")).toBe(original);
    await expect(stat(join(test.repo, ".aibill", "guard-hook.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(test.repo, ".aibill", "policy.json"), "utf8")).toContain('"version": 1');
  });

  it("removes a settings file that held nothing but the guard, and keeps an edited allowlist", async () => {
    const test = await fixture();
    await runCli(["guard", "install", "--path", test.repo]);
    const settingsPath = join(test.repo, ".claude", "settings.json");
    const removed = await runCli(["guard", "install", "--uninstall", "--path", test.repo]);
    expect(removed.stdout).toContain(".claude/settings.json: removed");
    await expect(stat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });

    await runCli(["guard", "install", "--path", test.repo]);
    const edited = JSON.parse(await readFile(settingsPath, "utf8"));
    edited.availableModels = ["sonnet", "haiku", "opus"];
    await writeFile(settingsPath, `${JSON.stringify(edited, null, 2)}\n`);
    const kept = await runCli(["guard", "install", "--uninstall", "--path", test.repo]);
    expect(kept.stdout).toContain("availableModels: kept, it no longer equals the policy's models.allow");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({ availableModels: ["sonnet", "haiku", "opus"] });
  });

  it("writes into the main checkout when run from a linked worktree", async () => {
    const test = await fixture();
    const worktree = join(test.root, "feature-worktree");
    await mkdir(worktree);
    await mkdir(join(test.repo, ".git", "worktrees", "feature"), { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${join(test.repo, ".git", "worktrees", "feature")}\n`);
    const result = await runCli(["guard", "install", "--path", worktree]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("installed for checkout-api");
    await expect(stat(join(test.repo, ".claude", "settings.json"))).resolves.toBeTruthy();
    await expect(stat(join(test.repo, ".aibill", "guard-hook.mjs"))).resolves.toBeTruthy();
    await expect(stat(join(worktree, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses without a policy, with an invalid policy, outside a repository, or over broken settings", async () => {
    const missing = await fixture(null);
    const noPolicy = await runCli(["guard", "install", "--path", missing.repo]);
    expect(noPolicy.exitCode).toBe(1);
    expect(noPolicy.stderr).toContain("checkout-api has no .aibill/policy.json yet");
    expect(noPolicy.stderr).toContain('"perDay"');

    const invalid = await fixture({ version: 1, budget: { perDay: { token: 5 } } });
    const bad = await runCli(["guard", "install", "--path", invalid.repo]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toBe("aibill guard: .aibill/policy.json is invalid: budget.perDay: unknown key token");

    const outside = await runCli(["guard", "install", "--path", missing.root]);
    expect(outside.exitCode).toBe(1);
    expect(outside.stderr).toContain("not inside a repository");

    const broken = await fixture();
    await mkdir(join(broken.repo, ".claude"));
    await writeFile(join(broken.repo, ".claude", "settings.json"), "{ not json\n");
    const refused = await runCli(["guard", "install", "--path", broken.repo]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("aibill guard install stopped safely");
    expect(refused.stderr).toContain("not valid JSON");
    expect(await readFile(join(broken.repo, ".claude", "settings.json"), "utf8")).toBe("{ not json\n");
    await expect(stat(join(broken.repo, ".aibill", "guard-hook.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prints the managed-settings document with deniedModels and a launcher-guarded hook", async () => {
    const test = await fixture();
    const result = await runCli(["guard", "install", "--managed", "--path", test.repo]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      availableModels: ["sonnet", "haiku"],
      deniedModels: ["claude-opus-5-5"],
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: GUARD_MANAGED_HOOK_COMMAND, timeout: 10 }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: GUARD_MANAGED_HOOK_COMMAND, timeout: 10 }] }]
      }
    });
    expect(GUARD_MANAGED_HOOK_COMMAND).toBe(
      'if [ -f "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs" ]; then node "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs"; fi'
    );
    expect(result.stderr).toContain("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(result.stderr).toContain("/etc/claude-code/managed-settings.json");
    await expect(stat(join(test.repo, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    const both = await runCli(["guard", "install", "--managed", "--uninstall", "--path", test.repo]);
    expect(both.exitCode).toBe(1);
  });

  it("merge and remove are pure and keep foreign handlers inside a shared group", () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [{ hooks: [
          { type: "command", command: "./notify.sh" },
          { type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs"', timeout: 5 }
        ] }]
      }
    };
    const merged = mergeGuardSettings(existing, { version: 1, models: { allow: ["sonnet"] } });
    expect(existing.hooks.UserPromptSubmit[0]!.hooks).toHaveLength(2);
    expect(merged.changes).toEqual([
      "availableModels: set to sonnet",
      "hooks.UserPromptSubmit: guard hook updated",
      "hooks.PreToolUse: guard hook added"
    ]);
    expect(merged.next.hooks).toMatchObject({
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "./notify.sh" }] },
        { hooks: [{ type: "command", command: GUARD_HOOK_COMMAND, timeout: 10 }] }
      ]
    });
    const removed = removeGuardSettings(merged.next, { version: 1, models: { allow: ["sonnet"] } });
    expect(removed.next).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "./notify.sh" }] }] } });
  });
});

describe("guard check", () => {
  it("exits 0 silently under budget and 2 with the policy message and figure when tokens are spent", async () => {
    const test = await fixture();
    await writeTranscript(test, "session-a.jsonl", [
      transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a1", tokens: 700_000 }),
      transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a2", tokens: 500_000, timestamp: `${DAY}T11:00:00.000Z` })
    ]);
    const under = await runCli(["guard", "check", "--path", test.repo], { guardStdin: null, guardNow: NOW, homeDirectory: test.home });
    expect(under).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    await writeTranscript(test, "session-b.jsonl", [
      transcriptLine({ cwd: join(test.repo, "src"), sessionId: "sess-b", requestId: "b1", tokens: 700_000, timestamp: `${DAY}T12:00:00.000Z` })
    ]);
    const over = await runCli(["guard", "check", "--path", test.repo], {
      guardStdin: hookStdin({ session_id: "sess-b", cwd: join(test.repo, "src"), hook_event_name: "UserPromptSubmit", prompt: "continue" }),
      guardNow: NOW,
      homeDirectory: test.home
    });
    expect(over.exitCode).toBe(2);
    expect(over.stdout).toBe("");
    expect(over.stderr).toBe([
      policy.message,
      `checkout-api used 1.9M tokens of its 1.5M daily budget (UTC ${DAY}); paused until 00:00 UTC (in 9h00m). aibill guard`
    ].join("\n"));
    for (const secret of ["sess-a", "sess-b", test.root, homedir(), "Users/"]) {
      expect(over.stderr).not.toContain(secret);
    }
  });

  it("counts sessions per repository and never counts the current session against itself", async () => {
    const test = await fixture();
    await writeTranscript(test, "one.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-1", requestId: "r1", tokens: 1_000 })]);
    await writeTranscript(test, "two.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-2", requestId: "r2", tokens: 1_000 })]);
    await writeTranscript(test, "elsewhere.jsonl", [transcriptLine({ cwd: join(test.root, "other-repo"), sessionId: "sess-9", requestId: "r9", tokens: 1_000 })]);

    const continuing = await checkGuard({ cwd: test.repo, sessionId: "sess-2", now: NOW }, deps(test));
    expect(continuing).toMatchObject({ exitCode: 0, reason: "within_budget" });
    expect(continuing.usage?.sessionIds).toEqual(["sess-1", "sess-2"]);

    const fresh = await checkGuard({ cwd: test.repo, sessionId: "sess-3", now: NOW }, deps(test));
    expect(fresh.exitCode).toBe(2);
    expect(fresh.reason).toBe("sessions_spent");
    expect(fresh.stderr).toContain(`checkout-api ran 2 Claude Code sessions of its 2 per day (UTC ${DAY}); new sessions paused until 00:00 UTC`);
    expect(fresh.stderr).not.toContain("sess-");

    const terminal = await checkGuard({ cwd: test.repo, now: NOW }, deps(test));
    expect(terminal.reason).toBe("sessions_spent");
  });

  it("attributes a linked worktree's sessions to the main checkout", async () => {
    const test = await fixture();
    const worktree = join(test.root, "wt-feature");
    await mkdir(worktree);
    await mkdir(join(test.repo, ".git", "worktrees", "feature"), { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${join(test.repo, ".git", "worktrees", "feature")}\n`);
    await writeTranscript(test, "wt.jsonl", [transcriptLine({ cwd: worktree, sessionId: "sess-wt", requestId: "w1", tokens: 1_600_000 })]);
    const outcome = await checkGuard({ cwd: worktree, sessionId: "sess-wt", now: NOW }, deps(test));
    expect(outcome.reason).toBe("tokens_spent");
    expect(outcome.stderr).toContain("checkout-api used 1.6M tokens");
  });

  it("fails open with one warning when the policy is missing or invalid, or transcripts cannot be read", async () => {
    const noPolicy = await fixture(null);
    expect(await checkGuard({ cwd: noPolicy.repo, now: NOW }, deps(noPolicy))).toMatchObject({
      exitCode: 0,
      reason: "no_policy",
      stderr: "aibill guard: checkout-api has no .aibill/policy.json; nothing enforced."
    });

    const invalid = await fixture({ version: 1, budget: { perDay: { tokens: -1 } } });
    const invalidOutcome = await checkGuard({ cwd: invalid.repo, now: NOW }, deps(invalid));
    expect(invalidOutcome).toMatchObject({ exitCode: 0, reason: "invalid_policy" });
    expect(invalidOutcome.stderr).toContain("aibill guard: .aibill/policy.json is invalid (budget.perDay.tokens:");
    expect(invalidOutcome.stderr.split("\n")).toHaveLength(1);

    const outside = await checkGuard({ cwd: noPolicy.root, now: NOW }, deps(noPolicy));
    expect(outside).toMatchObject({ exitCode: 0, reason: "no_repository" });

    const unreadable = await fixture();
    await rm(unreadable.projectsDir, { recursive: true });
    await writeFile(unreadable.projectsDir, "not a directory");
    const blocked = await checkGuard({ cwd: unreadable.repo, now: NOW }, deps(unreadable));
    expect(blocked).toMatchObject({ exitCode: 0, reason: "usage_unavailable" });
    expect(blocked.stderr).toBe("aibill guard: the Claude Code transcript directory is unreadable; today's usage is unknown, not blocking.");

    const missing = await fixture();
    await rm(missing.projectsDir, { recursive: true });
    expect(await checkGuard({ cwd: missing.repo, now: NOW }, deps(missing))).toMatchObject({
      exitCode: 0,
      stderr: expect.stringContaining("transcript directory is missing")
    });

    const noBudget = await fixture({ version: 1, models: { allow: ["sonnet"] } });
    expect(await checkGuard({ cwd: noBudget.repo, now: NOW }, deps(noBudget))).toMatchObject({
      exitCode: 0,
      reason: "nothing_to_enforce",
      stderr: ""
    });
  });

  it("refuses a denied model when the hook input carries one", async () => {
    const test = await fixture();
    const denied = await checkGuard({ cwd: test.repo, model: "claude-opus-5-5-20261001", now: NOW }, deps(test));
    expect(denied.exitCode).toBe(2);
    expect(denied.reason).toBe("model_denied");
    expect(denied.stderr).toContain("Model claude-opus-5-5-20261001 is denied by checkout-api's policy (.aibill/policy.json models.deny: claude-opus-5-5)");
    const allowed = await checkGuard({ cwd: test.repo, model: "claude-sonnet-5", now: NOW }, deps(test));
    expect(allowed.exitCode).toBe(0);
  });

  it("reads only appended transcript bytes on a warm run and keeps no transcript path in the cache", async () => {
    const test = await fixture();
    const path = await writeTranscript(test, "active.jsonl", [
      transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a1", tokens: 400_000 })
    ]);
    const cold = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(cold).toMatchObject({ tokens: 400_000, filesRead: 1, cache: "updated", complete: true });
    const warm = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(warm).toMatchObject({ tokens: 400_000, filesRead: 0, bytesRead: 0, cache: "hit" });

    const placeholder = transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a2", tokens: 150, final: false });
    await appendFile(path, `${placeholder}\n`);
    const partial = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(partial.tokens).toBe(400_150);
    expect(partial.bytesRead).toBe(Buffer.byteLength(placeholder) + 1);

    const final = transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a2", tokens: 300_000 });
    await appendFile(path, `${final}\n{"type":"assistant","message":{"usage":`);
    const streamed = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(streamed.tokens).toBe(700_000);
    expect(streamed.calls).toBe(2);
    expect(streamed.bytesRead).toBe(Buffer.byteLength(final) + 1);

    const cachePath = guardUsageCachePath(test.repo, deps(test));
    const cacheText = await readFile(cachePath, "utf8");
    expect(cacheText).not.toContain(test.projectsDir);
    expect(cacheText).not.toContain("active.jsonl");
    expect(cacheText).not.toContain('"workingDirectory"');
    expect(cacheText).toContain(test.repo);
    if (process.platform !== "win32") {
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("dedupes a response copied into a sub-agent transcript, ignores other days, and resets a rewritten file", async () => {
    const test = await fixture();
    const parent = transcriptLine({ cwd: test.repo, sessionId: "sess-p", requestId: "p1", tokens: 500_000 });
    await writeTranscript(test, "parent.jsonl", [
      parent,
      transcriptLine({ cwd: test.repo, sessionId: "sess-p", requestId: "p0", tokens: 900_000, timestamp: "2026-11-03T23:59:00.000Z" }),
      transcriptLine({ cwd: test.repo, sessionId: "sess-p", requestId: "p2", tokens: 900_000, timestamp: "2026-11-05T00:00:00.000Z" })
    ]);
    await mkdir(join(test.projectsDir, "-checkout-api", "sess-p", "subagents"), { recursive: true });
    await writeFile(join(test.projectsDir, "-checkout-api", "sess-p", "subagents", "agent-x.jsonl"), `${parent}\n`);
    const usage = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(usage).toMatchObject({ tokens: 500_000, calls: 1, sessionIds: ["sess-p"], filesConsidered: 2 });

    // A transcript that shrank was rewritten: its cached tally is dropped and
    // the file is read from the start again.
    await rm(join(test.projectsDir, "-checkout-api", "sess-p"), { recursive: true });
    await writeFile(join(test.projectsDir, "-checkout-api", "parent.jsonl"), `${transcriptLine({ cwd: test.repo, sessionId: "sess-p", requestId: "p3", tokens: 1_000 })}\n`);
    const rewritten = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(rewritten).toMatchObject({ tokens: 1_000, calls: 1, filesConsidered: 1 });
  });

  it("defers transcripts beyond the read budget and reports the figure as incomplete", async () => {
    const test = await fixture();
    for (const name of ["a", "b", "c"]) {
      await writeTranscript(test, `${name}.jsonl`, [transcriptLine({ cwd: test.repo, sessionId: `s-${name}`, requestId: name, tokens: 1_000 })]);
    }
    // Each run folds in at least one changed file, so a budget smaller than
    // any file still makes progress: one file per run, three runs to finish.
    const first = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, readBudgetBytes: 10, ...deps(test) });
    expect(first).toMatchObject({ complete: false, filesRead: 1, tokens: 1_000 });
    const outcome = await checkGuard({ cwd: test.repo, now: NOW }, { ...deps(test), readBudgetBytes: 10 });
    expect(outcome).toMatchObject({ exitCode: 0, reason: "usage_indexing" });
    expect(outcome.stderr).toBe("aibill guard: still indexing today's transcripts; not blocking until the figure is complete.");
    expect(outcome.usage).toMatchObject({ complete: false, filesRead: 1, tokens: 2_000 });
    const third = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, readBudgetBytes: 10, ...deps(test) });
    expect(third).toMatchObject({ complete: true, filesRead: 1, tokens: 3_000 });
    expect(third.sessionIds).toEqual(["s-a", "s-b", "s-c"]);
  });

  it("runs as the hook entry: stdin JSON in, exit code and stderr out, nothing on stdout", async () => {
    const test = await fixture();
    await writeTranscript(test, "s.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-h", requestId: "h1", tokens: 2_000_000 })]);
    let written = "";
    const code = await runGuardHook({
      stdin: hookStdin({ cwd: test.repo, session_id: "sess-h", hook_event_name: "PreToolUse", tool_name: "Bash" }),
      stderr: { write: (text: string) => { written += text; } },
      now: NOW,
      dependencies: deps(test)
    });
    expect(code).toBe(2);
    expect(written).toContain("checkout-api used 2M tokens of its 1.5M daily budget");
    expect(written.endsWith("\n")).toBe(true);

    let quiet = "";
    const malformed = await runGuardHook({
      stdin: Readable.from(["{ not json"]),
      stderr: { write: (text: string) => { quiet += text; } },
      cwd: join(test.root, "nowhere"),
      now: NOW,
      dependencies: deps(test)
    });
    expect(malformed).toBe(0);
    expect(quiet).toBe("aibill guard: not inside a repository; nothing to enforce.\n");
  });

  it("launcher: exits 0 with a warning without ai-spend-agent, and runs the installed hook entry when present", async () => {
    const test = await fixture();
    await runCli(["guard", "install", "--path", test.repo]);
    const launcher = join(test.repo, ".aibill", "guard-hook.mjs");
    const env = { ...process.env, HOME: test.home, USERPROFILE: test.home, PATH: process.env.PATH ?? "" };

    const missing = await execFileAsync(process.execPath, [launcher], { cwd: test.repo, env });
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("aibill guard: ai-spend-agent is not installed for this repository, so its policy was not checked. Install it with: npm install --save-dev aibill\n");

    const fakePackage = join(test.repo, "node_modules", "ai-spend-agent");
    await mkdir(join(fakePackage, "dist"), { recursive: true });
    await writeFile(join(fakePackage, "package.json"), JSON.stringify({ name: "ai-spend-agent", version: "0.0.0-test", type: "module" }));
    await writeFile(join(fakePackage, "dist", "guardHook.js"),
      "export async function runGuardHook() { process.stderr.write(`hook ran in ${process.cwd().length > 0 ? 'cwd' : '?'}\\n`); return 2; }\n");
    await expect(execFileAsync(process.execPath, [launcher], { cwd: join(test.repo, "src"), env }))
      .rejects.toMatchObject({ code: 2, stderr: "hook ran in cwd\n", stdout: "" });

    await writeFile(join(fakePackage, "dist", "guardHook.js"), "throw new Error('boom');\n");
    const broken = await execFileAsync(process.execPath, [launcher], { cwd: test.repo, env });
    expect(broken.stderr).toContain("aibill guard: the installed ai-spend-agent could not run the hook (boom); not blocking.");
  });

  it("stays silent on unreadable individual transcripts and still blocks on the certain lower bound", async () => {
    const test = await fixture();
    await writeTranscript(test, "ok.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "ok", tokens: 1_600_000 })]);
    const locked = await writeTranscript(test, "locked.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "s2", requestId: "locked", tokens: 10 })]);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(locked, 0o000);
      const usage = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
      expect(usage).toMatchObject({ filesUnreadable: 1, tokens: 1_600_000, complete: true });
      await chmod(locked, 0o600);
    }
  });
});

describe("guard status", () => {
  it("prints the policy, today's usage, what is installed, and the managed-settings verdict without any person", async () => {
    const test = await fixture();
    await writeTranscript(test, "s.jsonl", [
      transcriptLine({ cwd: test.repo, sessionId: "sess-status", requestId: "s1", tokens: 1_200_000 })
    ]);
    const before = await runCli(["guard", "status", "--path", test.repo], { guardNow: NOW, homeDirectory: test.home });
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain("aibill guard · checkout-api");
    expect(before.stdout).toContain("policy      .aibill/policy.json (version 1)");
    expect(before.stdout).toContain("models    allow: sonnet, haiku · deny: claude-opus-5-5 (deniedModels is honoured from managed settings only)");
    expect(before.stdout).toContain("budget    per UTC day: 1.5M tokens · 2 sessions");
    expect(before.stdout).toContain("codex     model gpt-5.6 · reported only; Codex is not enforced");
    expect(before.stdout).toContain(`today       ${DAY} UTC · 1.2M of 1.5M tokens (80%) · 1 of 2 sessions · resets in 9h00m`);
    expect(before.stdout).toContain("installed   .claude/settings.json: absent");
    expect(before.stdout).toContain(".aibill/guard-hook.mjs: absent");
    // The managed verdict reads the real system directory, which a developer
    // machine may populate; the convention note belongs to the "none" case.
    expect(before.stdout).toMatch(/^managed     (none found in |\d+ files? in )/m);
    if (before.stdout.includes("managed     none found in ")) {
      expect(before.stdout).toContain("project settings are a convention a developer can edit");
    }
    for (const secret of ["sess-status", test.root, homedir()]) expect(before.stdout).not.toContain(secret);

    await runCli(["guard", "install", "--path", test.repo]);
    const after = await runCli(["guard", "status", "--path", test.repo], { guardNow: NOW, homeDirectory: test.home });
    expect(after.stdout).toContain("installed   .claude/settings.json: availableModels: set from the policy · hooks: UserPromptSubmit, PreToolUse");
    expect(after.stdout).toContain(".aibill/guard-hook.mjs: present");

    const none = await fixture(null);
    const bare = await runCli(["guard", "status", "--path", none.repo], { guardNow: NOW, homeDirectory: none.home });
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toContain("policy      none: .aibill/policy.json is missing, so nothing is enforced here");
    const outside = await runCli(["guard", "status", "--path", none.root], { guardNow: NOW, homeDirectory: none.home });
    expect(outside.exitCode).toBe(1);
  });

  it("rejects an unknown action and explains the three actions", async () => {
    const result = await runCli(["guard", "frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown guard action: frobnicate");
    expect(result.stderr).toContain("guard install [--managed|--uninstall] | guard check | guard status");
    expect((await runCli(["guard"])).stderr).toContain("aibill guard needs an action.");
    expect((await runCli(["--help"])).stdout).toContain("guard check");
  });
});

describe("guard formatting", () => {
  it("formats token counts and remaining time compactly", () => {
    expect(formatTokenCount(1_900_000)).toBe("1.9M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(formatTokenCount(950_000)).toBe("950k");
    expect(formatTokenCount(1_234)).toBe("1.2k");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(2_500_000_000)).toBe("2.5B");
    expect(formatRemaining(9 * 3_600_000)).toBe("9h00m");
    expect(formatRemaining(5 * 3_600_000 + 12 * 60_000)).toBe("5h12m");
    expect(formatRemaining(45 * 60_000)).toBe("45m");
    expect(formatRemaining(30_000)).toBe("<1m");
  });

  it("writes a launcher that lists the repository, cwd and global anchors in that order", async () => {
    const source = buildGuardLauncherSource();
    expect(source.split("\n")[1]).toContain("aibill guard hook launcher v1");
    expect(source.indexOf('join(repositoryRoot, "package.json")')).toBeLessThan(source.indexOf('join(process.cwd(), "package.json")'));
    expect(source.indexOf('join(process.cwd(), "package.json")')).toBeLessThan(source.indexOf('join(globalRoot, "package.json")'));
    const directory = await mkdtemp(join(tmpdir(), "aibill-guard-launcher-"));
    await writeFile(join(directory, "guard-hook.mjs"), source);
    await execFileAsync(process.execPath, ["--check", join(directory, "guard-hook.mjs")]);
    expect((await readdir(directory))).toEqual(["guard-hook.mjs"]);
  });
});
