import { execFile } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AIBILL_POLICY_RELATIVE_PATH, parseClaudeCodeTranscript, projectIndexFinancialParserVersion } from "@agent-finops/core";
import { checkGuard, formatRemaining, formatTokenCount } from "./guard.js";
import { readGuardHookInput, runGuardHook } from "./guardHook.js";
import { AIBILL_POLICY_RELATIVE_PATH as HOOK_POLICY_PATH } from "./guardPolicyPath.js";
import {
  GUARD_HOOK_COMMAND,
  GUARD_MANAGED_HOOK_COMMAND,
  buildGuardLauncherSource,
  mergeGuardSettings,
  removeGuardSettings
} from "./guardSettings.js";
import { GUARD_CACHE_DIRECTORY_NAME, GUARD_READER_VERSION, guardStampPath, resolveGuardHookPackage } from "./guardStamp.js";
import { computeGuardUsage, guardUsageCachePath } from "./guardUsage.js";
import { runCli } from "./index.js";
import { resolveCheckoutRoot } from "./repositoryRoot.js";

const execFileAsync = promisify(execFile);
const NOW = new Date("2026-11-04T15:00:00.000Z");
const DAY = "2026-11-04";
const GUARD_HANDLER = { type: "command", command: GUARD_HOOK_COMMAND, timeout: 10 };

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Hooks every prompt and every tool call; the prompt-only default has its own tests. */
const policy = {
  version: 1,
  models: { allow: ["sonnet", "haiku"], deny: ["claude-opus-5-5"] },
  budget: { perDay: { tokens: 1_500_000, outputTokens: 2_000, sessions: 2 } },
  message: "Daily agent budget for this repository is spent. Ask the platform team for an exception.",
  perToolCall: true,
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

async function linkedWorktree(test: Fixture, name = "feature"): Promise<string> {
  const worktree = join(test.root, `${name}-worktree`);
  await mkdir(join(worktree, "src"), { recursive: true });
  await mkdir(join(test.repo, ".git", "worktrees", name), { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${join(test.repo, ".git", "worktrees", name)}\n`);
  return worktree;
}

function transcriptLine(options: {
  cwd: string;
  sessionId: string;
  requestId: string;
  tokens: number;
  output?: number;
  timestamp?: string;
  final?: boolean;
  model?: string;
}): string {
  const output = options.output ?? 100;
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
  it("writes the model allowlist, the prompt hook and the launcher; the tool-call hook is opt-in", async () => {
    const test = await fixture({ version: 1, models: { allow: ["sonnet", "haiku"] }, budget: { perDay: { outputTokens: 4_000_000 } } });
    const result = await runCli(["guard", "install", "--path", join(test.repo, "src")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill guard installed in checkout-api.");
    expect(result.stdout).toContain(".claude/settings.json: created");
    expect(result.stdout).toContain("hook: every prompt\n");
    expect(result.stdout).toContain(".aibill/guard-hook.mjs: created");
    expect(result.stdout).toContain("hook runs: nothing yet; package.json does not declare aibill or ai-spend-agent");
    expect(result.stdout).not.toContain("models.deny");

    const settingsPath = join(test.repo, ".claude", "settings.json");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      availableModels: ["sonnet", "haiku"],
      hooks: { UserPromptSubmit: [{ hooks: [GUARD_HANDLER] }] }
    });
    expect(GUARD_HOOK_COMMAND).toBe('node "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs"');
    expect(await readFile(join(test.repo, ".aibill", "guard-hook.mjs"), "utf8")).toBe(buildGuardLauncherSource());

    const perToolCall = await runCli(["guard", "install", "--per-tool-call", "--path", test.repo]);
    expect(perToolCall.stdout).toContain("hook: every prompt and every tool call (about 0.1 s each)");
    expect(perToolCall.stdout).toContain("hooks.PreToolUse: guard hook added");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).hooks).toEqual({
      UserPromptSubmit: [{ hooks: [GUARD_HANDLER] }],
      PreToolUse: [{ hooks: [GUARD_HANDLER] }]
    });

    // Without the flag the policy decides: it does not opt in, so the tool-call hook goes.
    const promptOnly = await runCli(["guard", "install", "--path", test.repo]);
    expect(promptOnly.stdout).toContain("hooks.PreToolUse: guard hook removed (not enabled by the policy)");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).hooks).toEqual({ UserPromptSubmit: [{ hooks: [GUARD_HANDLER] }] });
  });

  it("merges into existing settings, is idempotent, and uninstall removes exactly what was added", async () => {
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
    expect(first.stdout).toContain("models.deny: reported only at project scope");
    expect(first.stdout).toContain("codex.model gpt-5.6: reported only");
    const merged = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(merged.$schema).toBe("https://json.schemastore.org/claude-code-settings.json");
    expect(merged.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(merged.theme).toBe("dark");
    expect(merged.availableModels).toEqual(["sonnet", "haiku"]);
    expect(merged.hooks.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/lint-bash.sh" }] },
      { hooks: [GUARD_HANDLER] }
    ]);
    expect(merged.hooks.UserPromptSubmit).toEqual([{ hooks: [GUARD_HANDLER] }]);
    const afterFirst = await readFile(settingsPath, "utf8");

    const second = await runCli(["guard", "install", "--path", test.repo]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already installed in checkout-api; nothing changed");
    expect(await readFile(settingsPath, "utf8")).toBe(afterFirst);

    // A developer's own formatting survives an install with nothing to add.
    const reformatted = JSON.stringify(JSON.parse(afterFirst), null, 4);
    await writeFile(settingsPath, reformatted);
    await runCli(["guard", "install", "--path", test.repo]);
    expect(await readFile(settingsPath, "utf8")).toBe(reformatted);

    // A developer who moved the guard group to the front keeps it there.
    const reordered = JSON.parse(afterFirst);
    reordered.hooks.PreToolUse.reverse();
    await writeFile(settingsPath, `${JSON.stringify(reordered, null, 2)}\n`);
    const third = await runCli(["guard", "install", "--path", test.repo]);
    expect(third.stdout).toContain("nothing changed");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).hooks.PreToolUse[0]).toEqual({ hooks: [GUARD_HANDLER] });
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

  it("writes into the linked worktree Claude Code will start in, naming the main checkout that owns the policy", async () => {
    const test = await fixture();
    const worktree = await linkedWorktree(test);
    expect(resolveCheckoutRoot(join(worktree, "src"))).toBe(worktree);
    expect(resolveCheckoutRoot(join(test.repo, "src"))).toBe(test.repo);
    expect(resolveCheckoutRoot(test.root)).toBeUndefined();

    const result = await runCli(["guard", "install", "--path", join(worktree, "src")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill guard installed in feature-worktree.");
    expect(result.stdout).toContain("checkout: feature-worktree is a linked worktree; its settings are written here, the policy and today's figures belong to checkout-api");
    await expect(stat(join(worktree, ".claude", "settings.json"))).resolves.toBeTruthy();
    await expect(stat(join(worktree, ".aibill", "guard-hook.mjs"))).resolves.toBeTruthy();
    await expect(stat(join(test.repo, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(test.repo, ".aibill", "guard-hook.mjs"))).rejects.toMatchObject({ code: "ENOENT" });

    const removed = await runCli(["guard", "install", "--uninstall", "--path", worktree]);
    expect(removed.stdout).toContain("aibill guard removed from feature-worktree.");
    await expect(stat(join(worktree, ".claude", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses without a policy, with an invalid policy, outside a repository, or over broken settings", async () => {
    const missing = await fixture(null);
    const noPolicy = await runCli(["guard", "install", "--path", missing.repo]);
    expect(noPolicy.exitCode).toBe(1);
    expect(noPolicy.stderr).toContain("checkout-api has no .aibill/policy.json yet");
    expect(noPolicy.stderr).toContain("npx aibill guard status");
    expect(noPolicy.stderr).toContain('"tokens": 400000000');
    expect(noPolicy.stderr).toContain('"outputTokens": 4000000');

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

  it("prints the managed-settings document with deniedModels and a launcher-guarded POSIX hook", async () => {
    const test = await fixture();
    const result = await runCli(["guard", "install", "--managed", "--path", test.repo]);
    expect(result.exitCode).toBe(0);
    const managedHandler = { type: "command", command: GUARD_MANAGED_HOOK_COMMAND, timeout: 10 };
    expect(JSON.parse(result.stdout)).toEqual({
      availableModels: ["sonnet", "haiku"],
      deniedModels: ["claude-opus-5-5"],
      hooks: {
        UserPromptSubmit: [{ hooks: [managedHandler] }],
        PreToolUse: [{ hooks: [managedHandler] }]
      }
    });
    expect(GUARD_MANAGED_HOOK_COMMAND).toBe(
      'if [ -f "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs" ]; then node "${CLAUDE_PROJECT_DIR}/.aibill/guard-hook.mjs"; fi'
    );
    expect(result.stderr).toContain("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(result.stderr).toContain("/etc/claude-code/managed-settings.json");
    expect(result.stderr).toContain("POSIX shell");
    await expect(stat(join(test.repo, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });

    const promptOnly = await fixture({ version: 1, budget: { perDay: { sessions: 3 } } });
    const minimal = await runCli(["guard", "install", "--managed", "--path", promptOnly.repo]);
    expect(Object.keys(JSON.parse(minimal.stdout).hooks)).toEqual(["UserPromptSubmit"]);
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
    expect(merged.changes).toEqual(["availableModels: set to sonnet", "hooks.UserPromptSubmit: guard hook updated"]);
    expect(merged.next.hooks).toEqual({
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "./notify.sh" }, GUARD_HANDLER] }]
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

  it("enforces an output-token budget separately from the all-components figure", async () => {
    const test = await fixture({ version: 1, budget: { perDay: { tokens: 500_000_000, outputTokens: 1_000 } } });
    await writeTranscript(test, "s.jsonl", [
      transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "o1", tokens: 300_000, output: 600 }),
      transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "o2", tokens: 300_000, output: 450, timestamp: `${DAY}T11:00:00.000Z` })
    ]);
    const outcome = await checkGuard({ cwd: test.repo, sessionId: "s1", now: NOW }, deps(test));
    expect(outcome.reason).toBe("output_tokens_spent");
    expect(outcome.usage).toMatchObject({ tokens: 600_000, outputTokens: 1_050 });
    expect(outcome.stderr).toContain(`checkout-api produced 1.1k output tokens of its 1k daily budget (UTC ${DAY})`);
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

  it("reads the whole hook input however large a prompt or tool_input is, so a running session never blocks itself", async () => {
    const test = await fixture();
    await writeTranscript(test, "one.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-1", requestId: "r1", tokens: 1_000 })]);
    await writeTranscript(test, "two.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-2", requestId: "r2", tokens: 1_000 })]);
    const largeWrite = {
      session_id: "sess-2",
      cwd: test.repo,
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: join(test.repo, "src", "big.ts"), content: "x".repeat(70_000) }
    };
    expect(JSON.stringify(largeWrite).length).toBeGreaterThan(70_000);
    const toolCall = await runCli(["guard", "check", "--path", test.repo], { guardStdin: hookStdin(largeWrite), guardNow: NOW, homeDirectory: test.home });
    expect(toolCall).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    const largePrompt = { session_id: "sess-2", cwd: test.repo, hook_event_name: "UserPromptSubmit", prompt: "y".repeat(70_000) };
    const prompt = await runCli(["guard", "check", "--path", test.repo], { guardStdin: hookStdin(largePrompt), guardNow: NOW, homeDirectory: test.home });
    expect(prompt).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    // A sub-agent's hook carries the parent's session id plus agent_id; still the same session.
    const subagent = await runGuardHook({
      stdin: hookStdin({ ...largeWrite, agent_id: "agent-77" }),
      stderr: { write: () => undefined },
      now: NOW,
      dependencies: deps(test)
    });
    expect(subagent).toBe(0);

    // Several MiB still parse; the cap exists only against runaway producers.
    const huge = hookStdin({ ...largeWrite, tool_input: { content: "z".repeat(3 * 1_024 * 1_024) } });
    expect(await readGuardHookInput(huge)).toMatchObject({ status: "ok", input: { sessionId: "sess-2" } });
  });

  it("skips the sessions rule, with a warning, when the hook input could not be read; tokens still count", async () => {
    const test = await fixture();
    await writeTranscript(test, "one.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-1", requestId: "r1", tokens: 1_000 })]);
    await writeTranscript(test, "two.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-2", requestId: "r2", tokens: 1_000 })]);
    expect(await readGuardHookInput(Readable.from(["{ not json"]))).toEqual({ status: "incomplete" });
    expect(await readGuardHookInput(Readable.from(["[1, 2]"]))).toEqual({ status: "incomplete" });
    expect(await readGuardHookInput(Readable.from(["x".repeat(2_048)]), 1_024)).toEqual({ status: "incomplete" });
    expect(await readGuardHookInput(Readable.from([""]))).toEqual({ status: "none" });
    expect(await readGuardHookInput(null)).toEqual({ status: "none" });

    const malformed = await runCli(["guard", "check", "--path", test.repo], { guardStdin: Readable.from(["{ not json"]), guardNow: NOW, homeDirectory: test.home });
    expect(malformed.exitCode).toBe(0);
    expect(malformed.stderr).toBe("aibill guard: the hook input could not be read, so the current session is unknown; the sessions budget was not evaluated this time.");

    await writeTranscript(test, "big.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-3", requestId: "r3", tokens: 1_600_000 })]);
    const spent = await checkGuard({ cwd: test.repo, hookInputIncomplete: true, now: NOW }, deps(test));
    expect(spent).toMatchObject({ exitCode: 2, reason: "tokens_spent" });
  });

  it("attributes a linked worktree's sessions to the main checkout", async () => {
    const test = await fixture();
    const worktree = await linkedWorktree(test);
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

    const noBudget = await fixture({ version: 1, models: { allow: ["sonnet"], deny: ["opus"] } });
    expect(await checkGuard({ cwd: noBudget.repo, now: NOW }, deps(noBudget))).toMatchObject({
      exitCode: 0,
      reason: "nothing_to_enforce",
      stderr: ""
    });
  });

  it("reads only appended transcript bytes on a warm run and keeps no transcript path in the cache", async () => {
    const test = await fixture();
    const path = await writeTranscript(test, "active.jsonl", [
      transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a1", tokens: 400_000 })
    ]);
    const cold = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(cold).toMatchObject({ tokens: 400_000, outputTokens: 100, filesRead: 1, cache: "updated", complete: true });
    const warm = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(warm).toMatchObject({ tokens: 400_000, filesRead: 0, bytesRead: 0, cache: "hit", signature: cold.signature });

    const placeholder = transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a2", tokens: 150, final: false });
    await appendFile(path, `${placeholder}\n`);
    const partial = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(partial.tokens).toBe(400_150);
    expect(partial.bytesRead).toBe(Buffer.byteLength(placeholder) + 1);
    expect(partial.signature).not.toBe(cold.signature);

    const final = transcriptLine({ cwd: test.repo, sessionId: "sess-a", requestId: "a2", tokens: 300_000 });
    await appendFile(path, `${final}\n{"type":"assistant","message":{"usage":`);
    const streamed = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(streamed.tokens).toBe(700_000);
    expect(streamed.calls).toBe(2);
    expect(streamed.bytesRead).toBe(Buffer.byteLength(final) + 1);

    const cachePath = guardUsageCachePath(test.repo, deps(test));
    expect(cachePath).toContain(`${GUARD_CACHE_DIRECTORY_NAME}/`);
    const cacheText = await readFile(cachePath, "utf8");
    expect(cacheText).not.toContain(test.projectsDir);
    expect(cacheText).not.toContain("active.jsonl");
    expect(cacheText).not.toContain('"workingDirectory"');
    expect(cacheText).toContain(test.repo);
    if (process.platform !== "win32") {
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("detects a transcript rewritten in place, same size or larger, and reads it from the start again", async () => {
    const test = await fixture();
    const first = transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "r1", tokens: 2_000 });
    const path = await writeTranscript(test, "rewritten.jsonl", [first]);
    expect((await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) })).tokens).toBe(2_000);

    // Same byte length, different content: the mtime moves but the size does not.
    const sameSize = transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "r2", tokens: 9_000 });
    expect(Buffer.byteLength(sameSize)).toBe(Buffer.byteLength(first));
    await new Promise((done) => setTimeout(done, 15));
    await writeFile(path, `${sameSize}\n`);
    const replaced = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(replaced).toMatchObject({ tokens: 9_000, calls: 1, filesRead: 1 });

    // Larger rewrite with a different prefix: no mixing of a stale prefix with the new tail.
    const rewritten = [
      transcriptLine({ cwd: test.repo, sessionId: "s2", requestId: "r3", tokens: 2_000 }),
      transcriptLine({ cwd: test.repo, sessionId: "s2", requestId: "r4", tokens: 500, timestamp: `${DAY}T11:00:00.000Z` })
    ];
    await writeFile(path, `${rewritten.join("\n")}\n`);
    const larger = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(larger).toMatchObject({ tokens: 2_500, calls: 2, filesRead: 1, sessionIds: ["s2"] });

    // A shrunk file is a rewrite too.
    await writeFile(path, `${transcriptLine({ cwd: test.repo, sessionId: "s3", requestId: "r5", tokens: 500 })}\n`);
    expect(await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) })).toMatchObject({ tokens: 500, calls: 1 });
  });

  it("dedupes a response copied into a sub-agent transcript and ignores other days", async () => {
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
  });

  it("never lets a zeroed copy written after midnight conjure a call or a session", async () => {
    const test = await fixture();
    const final = transcriptLine({ cwd: test.repo, sessionId: "sess-night", requestId: "n1", tokens: 5_000, timestamp: "2026-11-03T23:59:30.000Z" });
    const path = await writeTranscript(test, "night.jsonl", [final]);
    const yesterday = new Date("2026-11-03T23:59:40.000Z");
    expect((await computeGuardUsage({ repositoryRoot: test.repo, now: yesterday, ...deps(test) })).tokens).toBe(5_000);

    const zeroed = JSON.stringify({
      type: "assistant",
      timestamp: `${DAY}T00:00:01.000Z`,
      cwd: test.repo,
      sessionId: "sess-night",
      requestId: "n1",
      message: { id: "msg-n1", model: "claude-sonnet-5", usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    });
    await appendFile(path, `${zeroed}\n`);
    const today = await computeGuardUsage({ repositoryRoot: test.repo, now: new Date(`${DAY}T00:05:00.000Z`), ...deps(test) });
    expect(today).toMatchObject({ tokens: 0, calls: 0, sessionIds: [] });

    // Even as the only kept line for its response, a zeroed copy is not a call.
    const lone = await writeTranscript(test, "lone.jsonl", [zeroed]);
    expect(lone).toBeTruthy();
    const withLone = await computeGuardUsage({ repositoryRoot: test.repo, now: new Date(`${DAY}T00:06:00.000Z`), ...deps(test) });
    expect(withLone).toMatchObject({ calls: 0, sessionIds: [] });
  });

  it("prices a fallback-iterations message the way the whole-file reader does", async () => {
    const test = await fixture({ version: 1, budget: { perDay: { tokens: 1 } } });
    const line = JSON.stringify({
      type: "assistant",
      timestamp: `${DAY}T10:00:00.000Z`,
      cwd: test.repo,
      sessionId: "sess-it",
      requestId: "it-1",
      message: {
        id: "msg-it-1",
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
          // The top-level split sums both attempts; the served iteration's own split is what counts.
          cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 40 },
          iterations: [
            { type: "fallback_message", model: "claude-opus-5-5", input_tokens: 10, output_tokens: 0,
              cache_read_input_tokens: 0, cache_creation_input_tokens: 40,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 } },
            { type: "message", model: "claude-sonnet-5", input_tokens: 10, output_tokens: 20,
              cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
              cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 } }
          ]
        }
      }
    });
    await writeTranscript(test, "iterations.jsonl", [line]);
    const usage = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    const [call] = parseClaudeCodeTranscript(`${line}\n`);
    const expected = call!.usage.inputTokens + call!.usage.outputTokens + (call!.usage.cacheReadTokens ?? 0) +
      (call!.usage.cacheWrite5mTokens ?? 0) + (call!.usage.cacheWrite1hTokens ?? 0);
    expect(expected).toBe(100);
    expect(usage).toMatchObject({ tokens: expected, outputTokens: 20, calls: 1, incompleteCalls: 0 });
    expect(await checkGuard({ cwd: test.repo, now: NOW }, deps(test))).toMatchObject({ reason: "tokens_spent" });
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

  it("ignores a cache written by another reader version and pins the version to core's parser", () => {
    expect(GUARD_READER_VERSION).toBe(projectIndexFinancialParserVersion);
    expect(GUARD_CACHE_DIRECTORY_NAME).toBe(`guard-usage-v1-r${projectIndexFinancialParserVersion}`);
    expect(HOOK_POLICY_PATH).toBe(AIBILL_POLICY_RELATIVE_PATH);
  });

  it("does not trust a cache left under an older reader's directory", async () => {
    const test = await fixture();
    await writeTranscript(test, "s.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "r1", tokens: 1_000 })]);
    const current = guardUsageCachePath(test.repo, deps(test));
    const older = join(dirname(dirname(current)), `guard-usage-v1-r${GUARD_READER_VERSION - 1}`, `${current.split("/").pop()}`);
    await mkdir(dirname(older), { recursive: true });
    await writeFile(older, JSON.stringify({ kind: "aibill.guard_usage_cache", version: 1, repositoryRoot: test.repo, writtenAt: NOW.toISOString(), files: {} }));
    const usage = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, ...deps(test) });
    expect(usage).toMatchObject({ tokens: 1_000, filesRead: 1, cache: "updated" });
    await expect(stat(current)).resolves.toBeTruthy();
  });

  it("throttles cache rewrites while the budget is far away and few bytes arrived", async () => {
    const test = await fixture();
    const path = await writeTranscript(test, "s.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "r1", tokens: 1_000 })]);
    const budget = { tokens: 1_000_000, sessions: 50 };
    const first = await computeGuardUsage({ repositoryRoot: test.repo, now: NOW, budget, ...deps(test) });
    expect(first.cache).toBe("updated");

    await appendFile(path, `${transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "r2", tokens: 1_000 })}\n`);
    const soon = new Date(NOW.getTime() + 5_000);
    const deferred = await computeGuardUsage({ repositoryRoot: test.repo, now: soon, budget, ...deps(test) });
    expect(deferred).toMatchObject({ tokens: 2_000, cache: "deferred" });
    // The deferred bytes are read again next time, so nothing is lost.
    const again = await computeGuardUsage({ repositoryRoot: test.repo, now: soon, budget, ...deps(test) });
    expect(again).toMatchObject({ tokens: 2_000, filesRead: 1, cache: "deferred" });

    const later = new Date(NOW.getTime() + 61_000);
    expect((await computeGuardUsage({ repositoryRoot: test.repo, now: later, budget, ...deps(test) })).cache).toBe("updated");

    await appendFile(path, `${transcriptLine({ cwd: test.repo, sessionId: "s1", requestId: "r3", tokens: 900_000 })}\n`);
    const close = await computeGuardUsage({ repositoryRoot: test.repo, now: new Date(later.getTime() + 1_000), budget, ...deps(test) });
    expect(close).toMatchObject({ tokens: 902_000, cache: "updated" });
  });

  it("reuses the last verdict from the stamp while nothing that could change it has changed", async () => {
    const test = await fixture();
    const path = await writeTranscript(test, "s.jsonl", [transcriptLine({ cwd: test.repo, sessionId: "sess-h", requestId: "h1", tokens: 2_000_000 })]);
    const events: string[] = [];
    let written = "";
    const run = (input: Record<string, unknown>, now = NOW) => runGuardHook({
      stdin: hookStdin(input),
      stderr: { write: (text: string) => { written += text; } },
      now,
      dependencies: deps(test),
      trace: (event) => events.push(event)
    });
    const input = { cwd: test.repo, session_id: "sess-h", hook_event_name: "UserPromptSubmit", prompt: "go" };
    expect(await run(input)).toBe(2);
    expect(written).toContain("checkout-api used 2M tokens of its 1.5M daily budget");
    expect(written.endsWith("\n")).toBe(true);
    await expect(stat(guardStampPath(test.repo, deps(test)))).resolves.toBeTruthy();

    written = "";
    expect(await run(input)).toBe(2);
    expect(written).toContain("2M tokens");
    expect(events).toEqual(["computed", "stamp-reused"]);

    // Another session, a changed transcript, a new day or an edited policy all recompute.
    expect(await run({ ...input, session_id: "sess-other" })).toBe(2);
    await appendFile(path, `${transcriptLine({ cwd: test.repo, sessionId: "sess-h", requestId: "h2", tokens: 10 })}\n`);
    expect(await run(input)).toBe(2);
    expect(await run(input, new Date("2026-11-05T01:00:00.000Z"))).toBe(0);
    await writeFile(join(test.repo, ".aibill", "policy.json"), JSON.stringify({ version: 1, budget: { perDay: { tokens: 5_000_000 } } }));
    await new Promise((done) => setTimeout(done, 15));
    expect(await run(input)).toBe(0);
    expect(events).toEqual(["computed", "stamp-reused", "computed", "computed", "computed", "computed"]);

    // Unreadable input never reuses a verdict, and leaves no stamp of its own.
    const before = await readFile(guardStampPath(test.repo, deps(test)), "utf8");
    events.length = 0;
    expect(await runGuardHook({ stdin: Readable.from(["{ no"]), stderr: { write: () => undefined }, cwd: test.repo, now: NOW, dependencies: deps(test) })).toBe(0);
    expect(await readFile(guardStampPath(test.repo, deps(test)), "utf8")).toBe(before);
  });

  it("runs as the hook entry: stdin JSON in, exit code and stderr out, nothing on stdout", async () => {
    const test = await fixture();
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

  it("launcher: uses the checkout's package only when package.json declares it, else the global install, else warns", async () => {
    const test = await fixture();
    await runCli(["guard", "install", "--path", test.repo]);
    const launcher = join(test.repo, ".aibill", "guard-hook.mjs");
    const env = { ...process.env, HOME: test.home, USERPROFILE: test.home, PATH: process.env.PATH ?? "" };
    const fakePackage = join(test.repo, "node_modules", "ai-spend-agent");
    await mkdir(join(fakePackage, "dist"), { recursive: true });
    await writeFile(join(fakePackage, "package.json"), JSON.stringify({ name: "ai-spend-agent", version: "0.0.0-test", type: "module" }));
    await writeFile(join(fakePackage, "dist", "guardHook.js"),
      "export async function runGuardHook() { process.stderr.write('fake hook ran\\n'); return 2; }\n");

    // Present in node_modules but undeclared: not used.
    expect(resolveGuardHookPackage(test.repo, "/nonexistent/prefix/bin/node", "linux")).toMatchObject({ source: "none" });
    const undeclared = await execFileAsync(process.execPath, [launcher], { cwd: test.repo, env });
    expect(undeclared.stdout).toBe("");
    expect(undeclared.stderr).toBe("aibill guard: no ai-spend-agent package for this checkout (declare aibill in package.json and npm install, or install it globally); policy not checked, not blocking.\n");

    await writeFile(join(test.repo, "package.json"), JSON.stringify({ name: "checkout-api", private: true, devDependencies: { aibill: "*" } }));
    expect(resolveGuardHookPackage(test.repo, "/nonexistent/prefix/bin/node", "linux")).toMatchObject({
      source: "repository",
      entry: join(fakePackage, "dist", "guardHook.js")
    });
    await expect(execFileAsync(process.execPath, [launcher], { cwd: join(test.repo, "src"), env }))
      .rejects.toMatchObject({ code: 2, stderr: "fake hook ran\n", stdout: "" });

    const status = await runCli(["guard", "status", "--path", test.repo], { guardNow: NOW, homeDirectory: test.home });
    expect(status.stdout).toContain(`hook runs: ${join(fakePackage, "dist", "guardHook.js")} (declared in package.json)`);

    // Declared but the package fails to load: not blocking.
    await writeFile(join(fakePackage, "dist", "guardHook.js"), "throw new Error('boom');\n");
    const broken = await execFileAsync(process.execPath, [launcher], { cwd: test.repo, env });
    expect(broken.stderr).toContain("aibill guard: the installed ai-spend-agent could not run the hook (boom); not blocking.");

    // A global install is found next to the running Node.
    const prefix = join(test.root, "prefix");
    await mkdir(join(prefix, "lib", "node_modules", "ai-spend-agent"), { recursive: true });
    await writeFile(join(prefix, "lib", "node_modules", "ai-spend-agent", "package.json"), JSON.stringify({ name: "ai-spend-agent" }));
    expect(resolveGuardHookPackage(join(test.root, "elsewhere"), join(prefix, "bin", "node"), "linux")).toMatchObject({ source: "global" });
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
      transcriptLine({ cwd: test.repo, sessionId: "sess-status", requestId: "s1", tokens: 1_200_000, output: 500 })
    ]);
    const before = await runCli(["guard", "status", "--path", test.repo], { guardNow: NOW, homeDirectory: test.home });
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain("aibill guard · checkout-api");
    expect(before.stdout).not.toContain("checkout    linked worktree");
    expect(before.stdout).toContain("policy      .aibill/policy.json (version 1)");
    expect(before.stdout).toContain("models    allow: sonnet, haiku · deny: claude-opus-5-5 (deniedModels is honoured from managed settings only)");
    expect(before.stdout).toContain("budget    per UTC day: 1.5M tokens · 2k output tokens · 2 sessions");
    expect(before.stdout).toContain("hook      every prompt and every tool call (perToolCall)");
    expect(before.stdout).toContain("codex     model gpt-5.6 · reported only; Codex is not enforced");
    expect(before.stdout).toContain(`today       ${DAY} UTC · 1.2M of 1.5M tokens (80%) · 500 of 2k output tokens (25%) · 1 of 2 sessions · resets in 9h00m`);
    expect(before.stdout).toContain("installed   .claude/settings.json: absent");
    expect(before.stdout).toContain(".aibill/guard-hook.mjs: absent");
    expect(before.stdout).toContain("hook runs: nothing yet; package.json does not declare aibill or ai-spend-agent");
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

    const worktree = await linkedWorktree(test);
    const fromWorktree = await runCli(["guard", "status", "--path", worktree], { guardNow: NOW, homeDirectory: test.home });
    expect(fromWorktree.stdout).toContain("checkout    linked worktree feature-worktree; the policy and today's figures belong to checkout-api");
    expect(fromWorktree.stdout).toContain("installed   .claude/settings.json: absent");

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
    expect((await runCli(["--help"])).stdout).toContain("--per-tool-call");
  });
});

describe("guard formatting", () => {
  it("formats token counts and remaining time compactly", () => {
    expect(formatTokenCount(1_900_000)).toBe("1.9M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(formatTokenCount(400_000_000)).toBe("400M");
    expect(formatTokenCount(950_000)).toBe("950k");
    expect(formatTokenCount(1_234)).toBe("1.2k");
    expect(formatTokenCount(42)).toBe("42");
    expect(formatTokenCount(2_500_000_000)).toBe("2.5B");
    expect(formatRemaining(9 * 3_600_000)).toBe("9h00m");
    expect(formatRemaining(5 * 3_600_000 + 12 * 60_000)).toBe("5h12m");
    expect(formatRemaining(45 * 60_000)).toBe("45m");
    expect(formatRemaining(30_000)).toBe("<1m");
  });

  it("writes a launcher that resolves the declared package first and the global install second", async () => {
    const source = buildGuardLauncherSource();
    expect(source.split("\n")[1]).toContain("aibill guard hook launcher v2");
    expect(source).toContain("declaresAibill()");
    expect(source.indexOf('join(checkoutRoot, "package.json")')).toBeLessThan(source.indexOf('join(globalRoot, "package.json")'));
    expect(source).not.toContain("process.cwd()");
    const directory = await mkdtemp(join(tmpdir(), "aibill-guard-launcher-"));
    await writeFile(join(directory, "guard-hook.mjs"), source);
    await execFileAsync(process.execPath, ["--check", join(directory, "guard-hook.mjs")]);
    expect((await readdir(directory))).toEqual(["guard-hook.mjs"]);
  });
});
