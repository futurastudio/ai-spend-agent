import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";

describe("zero-key instant demo first run", () => {
  // Point agent-log discovery at empty dirs so tests never read this
  // machine's real ~/.claude / ~/.codex transcripts.
  beforeEach(async () => {
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-claude-"));
    process.env.AI_SPEND_CODEX_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-codex-"));
    // Also isolate dead-context inventory + plan detection from this
    // machine's real config (otherwise output depends on the dev machine's
    // actual Claude/ChatGPT subscription).
    process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-home-"));
    process.env.AI_SPEND_CODEX_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-codex-home-"));
    process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
    process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
  });
  afterEach(() => {
    delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
    delete process.env.AI_SPEND_CODEX_LOGS_DIR;
    delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
    delete process.env.AI_SPEND_CODEX_HOME_DIR;
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
  });

  it("renders the wow with no subcommand and no credentials", async () => {
    // Isolated --path: the demo prefers any real synced state in the cwd.
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-demo-"));
    const result = await runCli(["--path", dir]);

    expect(result.exitCode).toBe(0);
    // Headline spend number lands first.
    expect(result.stdout).toContain("$87.00");
    // Actionable, dollar-specific cut list (the wow).
    expect(result.stdout).toContain("Illustrative hypotheses only");
    expect(result.stdout).toMatch(/Move .* to .*model ~\$/);
    // Demo banner + connect CTA, no over-promise about "all four".
    expect(result.stdout).toContain("DEMO");
    expect(result.stdout).toContain("connect openai");
    expect(result.stdout).not.toContain("all four");
  });

  it("keeps explicit sample output deterministic and free of local plan or credential hints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-capture-"));
    const priorKey = process.env.OPENAI_ADMIN_KEY;
    process.env.OPENAI_ADMIN_KEY = `sk-${"capture-test-key".repeat(2)}`;
    await writeFile(process.env.AI_SPEND_CLAUDE_CONFIG!, JSON.stringify({
      oauthAccount: {
        billingType: "stripe_subscription",
        organizationType: "claude_max",
        organizationRateLimitTier: "default_claude_max_20x"
      }
    }));

    try {
      const result = await runCli(["--sample", "--path", dir, "--no-color"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("DATA MODE: demo sample");
      expect(result.stdout).not.toContain("Claude Max 20x");
      expect(result.stdout).not.toContain("Found local key");
      expect(result.stdout).not.toContain("capture-test-key");
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_ADMIN_KEY;
      else process.env.OPENAI_ADMIN_KEY = priorKey;
    }
  });

  it("treats apply --sample as a strict demo/privacy boundary", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-apply-sample-"));
    const priorKey = process.env.OPENAI_ADMIN_KEY;
    process.env.OPENAI_ADMIN_KEY = `sk-${"must-not-appear".repeat(2)}`;
    await writeFile(process.env.AI_SPEND_CLAUDE_CONFIG!, JSON.stringify({
      oauthAccount: {
        billingType: "stripe_subscription",
        organizationType: "claude_max",
        organizationRateLimitTier: "default_claude_max_20x"
      }
    }));

    try {
      const result = await runCli(["apply", "--sample", "--path", dir, "--no-color"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("data: DEMO sample data");
      expect(result.stdout).toContain("NON-EXECUTABLE DEMO");
      expect(result.stdout).toContain("no live transcripts, account metadata, credentials, or persisted spend state were read");
      expect(result.stdout).not.toContain("Claude Max 20x");
      expect(result.stdout).not.toContain("must-not-appear");
      expect(result.stdout).not.toContain(dir);
      expect(result.stdout).not.toContain("$7.50");

      const prompt = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");
      expect(prompt).toContain("NON-EXECUTABLE DEMO");
      expect(prompt).not.toContain("Claude Max 20x");
    } finally {
      if (priorKey === undefined) delete process.env.OPENAI_ADMIN_KEY;
      else process.env.OPENAI_ADMIN_KEY = priorKey;
    }
  });

  it("prints --version without scanning local data", async () => {
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^0\.5\.9$/);
    expect(result.stdout).not.toContain("DATA MODE");
    expect(result.stdout).not.toContain("YOUR USAGE");
  });

  it("accepts a flag-only invocation and drills down by group-by", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-demo-"));
    const result = await runCli(["--group-by", "agent", "--no-color", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cost/value evidence by agent");
    expect(result.stdout).toContain("agent-analyst");
  });

  it("an explicit --group-by renders the focused table view, not the whole readout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-focused-"));
    const result = await runCli(["--group-by", "project", "--no-color", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cost/value evidence by project");
    expect(result.stdout).toMatch(/window: \d+ days? of data/);
    // The drill-down answers one question — the four-stage loop stays out.
    expect(result.stdout).not.toContain("RECOMMEND");
    expect(result.stdout).not.toContain("Plan check");
    expect(result.stdout).toContain("for the full diagnose");
  });

  it("report/apply always re-read local logs fresh — a stale snapshot can never disagree with the readout", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-fresh-"));
    await runCli(["report", "--path", dir]);

    // Add a NEW transcript after the first report persisted its snapshot.
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "-tmp-late"), { recursive: true });
    await writeFile(join(logsDir, "-tmp-late", "late.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      cwd: "/tmp/late",
      sessionId: "late-1",
      requestId: "late-req",
      message: { id: "late-msg", model: "claude-opus-4-8", usage: { input_tokens: 2_000_000, output_tokens: 200_000 } }
    }), "utf8");

    const second = await runCli(["report", "--path", dir]);
    // $7.50 (old fixture) + $15.00 (new one) — the fresh read must include both.
    expect(second.stdout).toContain("cost/value evidence total: $22.50");
  });

  it("uses one explicit 30-day evidence window across quickstart, report, and apply", async () => {
    await writeClaudeLogFixture();
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "-tmp-old"), { recursive: true });
    await writeFile(join(logsDir, "-tmp-old", "old.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString(),
      cwd: "/tmp/old",
      sessionId: "old-1",
      requestId: "old-req",
      message: { id: "old-msg", model: "claude-opus-4-8", usage: { input_tokens: 2_000_000, output_tokens: 200_000 } }
    }), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-window-"));

    const quick = await runCli(["--path", dir, "--no-color"]);
    const report = await runCli(["report", "--path", dir]);
    const apply = await runCli(["apply", "--path", dir]);

    expect(quick.stdout).toContain("$7.50");
    expect(quick.stdout).not.toContain("$22.50");
    expect(report.stdout).toContain("cost/value evidence total: $7.50");
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain("30 days");
  });

  it("re-running after report persists local_logs state does not warn about sample/legacy state", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-nowarn-"));
    await runCli(["report", "--path", dir]);

    const result = await runCli(["--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Ignored persisted sample/legacy state");
  });

  it("report tells the user how to open the deliverables", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-reporthint-"));
    const result = await runCli(["report", "--path", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("open ");
    expect(result.stdout).toContain("aibill apply");
  });

  async function writeClaudeLogFixture() {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "-Users-jose-myproject"), { recursive: true });
    const transcript = JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      cwd: "/Users/jose/myproject",
      sessionId: "sess-1",
      requestId: "req-1",
      message: { id: "msg-1", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }
    });
    await writeFile(join(logsDir, "-Users-jose-myproject", "session.jsonl"), transcript, "utf8");
  }

  it("uses real local agent logs when present (no keys, no sample)", async () => {
    await writeClaudeLogFixture();

    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-logs-"));
    const result = await runCli(["--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("YOUR USAGE");
    expect(result.stdout).not.toContain("DEMO");
    // 1M in @$5 + 100k out @$25 = $7.50, estimated.
    expect(result.stdout).toContain("$7.50");
    expect(result.stdout).toContain("Plan check");
    expect(result.stdout).toContain("API-equivalent ESTIMATES");
  });

  it("emits the native Glance data contract as machine-readable JSON", async () => {
    await writeClaudeLogFixture();

    const result = await runCli([
      "glance",
      "--since-days",
      "365",
      "--project",
      "myproject",
      "--plan",
      "claude-max-5x"
    ]);
    const snapshot = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(snapshot).toMatchObject({
      dataMode: "local_transcripts",
      currentSession: {
        agent: "claude-code",
        project: "myproject",
        model: "claude-opus-4-8",
        costConfidence: "estimated"
      },
      plan: {
        planId: "claude-max-5x",
        planLabel: "Claude Max 5x",
        billing: "subscription",
        monthlyUsd: 100,
        source: "user_declared"
      },
      limits: [],
      coverage: {
        supportedTranscriptAgents: ["claude-code", "codex"],
        detectedAgents: ["claude-code"],
        providerConnectionRequired: ["cursor", "github-copilot"]
      }
    });
  });

  it("rejects an invalid Glance history window", async () => {
    const result = await runCli(["glance", "--since-days", "0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("between 1 and 365");
  });

  it("keeps terminal JSON and Glance on the same Context Health contract", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-context-"));
    const terminal = await runCli([
      "context",
      "--json",
      "--since-days",
      "365",
      "--project",
      "myproject",
      "--path",
      dir
    ]);
    const glance = await runCli([
      "glance",
      "--since-days",
      "365",
      "--project",
      "myproject",
      "--path",
      dir
    ]);
    const terminalHealth = JSON.parse(terminal.stdout);
    const glanceHealth = JSON.parse(glance.stdout).sessionHealth;

    expect(terminal.exitCode).toBe(0);
    expect(terminalHealth).toMatchObject({
      schemaVersion: 1,
      provenance: {
        inventory: "local_agent_configuration",
        invocations: "local_claude_code_and_codex_transcripts",
        uploaded: false
      }
    });
    // generatedAt can differ by milliseconds; every decision/data field must match.
    const { generatedAt: terminalGeneratedAt, ...terminalContract } = terminalHealth;
    const { generatedAt: glanceGeneratedAt, ...glanceContract } = glanceHealth;
    expect(terminalGeneratedAt).toEqual(expect.any(String));
    expect(glanceGeneratedAt).toEqual(expect.any(String));
    expect(glanceContract).toEqual(terminalContract);
  });

  it("renders Context Health as a readable terminal decision", async () => {
    await writeClaudeLogFixture();
    const result = await runCli(["context", "--since-days", "365"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CONTEXT HEALTH");
    expect(result.stdout).toContain("Action:");
    expect(result.stdout).toContain("Activation");
    expect(result.stdout).toContain("hook commands were not run");
  });

  it("report and apply-artifact work right after a quickstart (live local-log fallback, never sample)", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-report-fallback-"));

    // No scan, no persisted state — exactly what a first-run npx user does.
    const report = await runCli(["report", "--path", dir]);
    expect(report.exitCode).toBe(0);
    const markdown = await readFile(join(dir, ".ai-spend-agent", "report.md"), "utf8");
    expect(markdown).toContain("$7.50");
    expect(markdown).not.toContain("$87.00");

    const artifact = await runCli(["apply-artifact", "--path", dir]);
    expect(artifact.exitCode).toBe(0);
    const artifactDir = join(dir, ".ai-spend-agent");
    const prompt = await readFile(join(artifactDir, "ai-spend-coding-agent-prompt.md"), "utf8");
    const action = await readFile(join(artifactDir, "ai-spend-action-plan.md"), "utf8");
    const policy = await readFile(join(artifactDir, "ai-spend-policy-config-draft.md"), "utf8");
    const verification = await readFile(join(artifactDir, "ai-spend-verify-plan.md"), "utf8");
    expect(prompt).toContain("# AI Spend Apply Artifact");
    expect(action).toContain("Observed API-equivalent value: $7.50");
    expect(action).not.toContain("Estimated impact");
    expect(policy).toContain('financialClaim: "unverified"');
    expect(policy).not.toContain("currentTrackedSpendUsd");
    expect(policy).not.toContain("modeledOpportunityUsd");
    expect(verification).toContain("Collect at least 3 new matched sessions");
    expect(verification).not.toContain("Rerun the same workflow/sample window");

    // One command generation uses one exact UTC anchor across every artifact.
    const rangePattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z through \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
    const ranges = [prompt, action, policy, verification].map((text) => text.match(rangePattern)?.[0]);
    expect(ranges.every(Boolean)).toBe(true);
    expect(new Set(ranges).size).toBe(1);
  });

  it("report without state or logs explains what to run — and never suggests sample data as the fix for real data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-report-empty-"));
    const result = await runCli(["report", "--path", dir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npx aibill");
    expect(result.stderr).not.toMatch(/^Run scan --sample/);
  });

  it("keeps a legacy mode-less bundled sample Apply artifact non-executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-legacy-sample-"));
    await runCli(["scan", "--sample", "--path", dir]);
    const statePath = join(dir, ".ai-spend-agent", "spend.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    delete state.mode;
    await writeFile(statePath, JSON.stringify(state));

    const result = await runCli(["apply-artifact", "--path", dir]);
    const prompt = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(prompt).toContain("AI Spend Apply Artifact — Demo Only");
    expect(prompt).toContain("NON-EXECUTABLE DEMO");
    expect(prompt).not.toContain("Copy this into your coding agent");
  });

  it("fails closed for an unlabeled state that is not the bundled sample", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-unlabeled-state-"));
    await runCli(["scan", "--sample", "--path", dir]);
    const statePath = join(dir, ".ai-spend-agent", "spend.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      mode?: string;
      records: Array<{ source: { observedFrom: string } }>;
    };
    delete state.mode;
    state.records = state.records.map((record) => ({
      ...record,
      source: { ...record.source, observedFrom: "legacy_import" }
    }));
    await writeFile(statePath, JSON.stringify(state));

    const result = await runCli(["apply-artifact", "--path", dir]);
    const prompt = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(prompt).toContain("Evidence Mode Required");
    expect(prompt).toContain("NON-EXECUTABLE");
    expect(prompt).not.toContain("Copy this into your coding agent");
  });

  it("honors --plan as an explicit persona override", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-plan-"));

    const result = await runCli(["--plan", "claude-max-5x", "--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("compared with Claude Max 5x");
    expect(result.stdout).toContain("PLAN Claude Max 5x");
  });

  it("rejects an unknown --plan id and lists valid plans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-badplan-"));
    const result = await runCli(["--plan", "claude-mega-100x", "--path", dir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("claude-max-20x");
    expect(result.stderr).toContain("chatgpt-plus");
  });

  it("defaults the table to by-project for local-log users (by-model for demo)", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-defaultgroup-"));
    const local = await runCli(["--path", dir, "--no-color"]);
    expect(local.stdout).toContain("API-equivalent value by project");

    const demo = await runCli(["--sample", "--path", dir, "--no-color"]);
    expect(demo.stdout).toContain("Cost/value evidence by model");
  });

  it("never injects sample dead-context onto a real (local-logs) readout", async () => {
    await writeClaudeLogFixture();

    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-clean-"));
    const result = await runCli(["--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("YOUR USAGE");
    // The illustrative 29-of-38 sample belongs to demo mode only; a real
    // readout with nothing measured shows no fabricated waste.
    expect(result.stdout).not.toContain("29 of 38");
    expect(result.stdout).not.toContain("illustrative — your first run");
  });

  it("uses real local agent logs for report-card before falling back to sample data", async () => {
    await writeClaudeLogFixture();

    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-card-"));
    const cardPath = join(dir, "card.svg");
    const result = await runCli(["report-card", "--path", dir, "--out", cardPath]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("$7.50 in observed API-equivalent value");
    expect(result.stdout).not.toContain("$87.00 in observed API-equivalent value");
    const card = await readFile(cardPath, "utf8");
    expect(card).toContain("$7.50");
    expect(card).not.toContain("$87.00");
  });

  it("appends .svg when report-card --out has no extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-card-ext-"));
    const result = await runCli(["report-card", "--sample", "--out", join(dir, "card"), "--no-color"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`receipt: ${join(dir, "card.svg")}`);
    const svg = await readFile(join(dir, "card.svg"), "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("writes a default .svg filename when report-card --out is a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-card-dir-"));
    const result = await runCli(["report-card", "--sample", "--out", dir, "--no-color"]);
    expect(result.exitCode).toBe(0);
    const expected = join(dir, "ai-spend-receipt.svg");
    expect(result.stdout).toContain(`receipt: ${expected}`);
    const svg = await readFile(expected, "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("refuses default and custom report-card output symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-card-symlink-"));
    const outside = join(await mkdtemp(join(tmpdir(), "ai-spend-cli-card-target-")), "outside.txt");
    await writeFile(outside, "keep-me", "utf8");

    const defaultReceipt = join(dir, "ai-receipt.svg");
    await symlink(outside, defaultReceipt);
    const defaultResult = await runCli(["report-card", "--sample", "--path", dir, "--no-color"]);
    expect(defaultResult.exitCode).toBe(1);
    expect(defaultResult.stderr).toContain("symbolic link");
    expect(await readFile(outside, "utf8")).toBe("keep-me");

    await unlink(defaultReceipt);
    const customReceipt = join(dir, "custom.svg");
    await symlink(outside, customReceipt);
    const customResult = await runCli([
      "report-card", "--sample", "--path", dir, "--out", customReceipt, "--no-color"
    ]);
    expect(customResult.exitCode).toBe(1);
    expect(customResult.stderr).toContain("symbolic link");
    expect(await readFile(outside, "utf8")).toBe("keep-me");
  });

  it("shows persisted sample state as DEMO, never as connected/verified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-quickstart-"));
    await runCli(["scan", "--sample", "--path", dir]);

    const result = await runCli(["quickstart", "--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("$87.00");
    // Sample state must be labeled demo — never silently served as connected.
    expect(result.stdout).toContain("DATA MODE: demo sample");
  });

  it("does not let persisted sample state mask real local logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-mask-"));
    // Persist sample state in the project dir.
    await runCli(["scan", "--sample", "--path", dir]);
    // Place a real Claude Code transcript in the isolated logs dir.
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    const projDir = join(logsDir, "-tmp-proj");
    await mkdir(projDir, { recursive: true });
    const line = JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      cwd: "/tmp/proj",
      sessionId: "s1",
      message: { id: "m1", model: "claude-opus-4-8", usage: { input_tokens: 1000, output_tokens: 200 } }
    });
    await writeFile(join(projDir, "session.jsonl"), `${line}\n`);

    const result = await runCli(["quickstart", "--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DATA MODE: your local agent logs");
    expect(result.stdout).toContain("Ignored persisted sample/legacy state");
  });

  it("--ignore-state bypasses persisted spend.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-ignore-"));
    await runCli(["scan", "--sample", "--path", dir]);
    const result = await runCli(["quickstart", "--path", dir, "--no-color", "--ignore-state"]);
    expect(result.exitCode).toBe(0);
    // No real logs in the isolated env -> falls straight to demo sample.
    expect(result.stdout).toContain("DATA MODE: demo sample");
  });
});

describe("minimal CLI vertical slice", () => {
  beforeEach(async () => {
    // Keep every CLI test hermetic. Without these overrides doctor/provider
    // flows read the developer's real transcript and account metadata, making
    // duration and assertions depend on the host machine.
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-claude-"));
    process.env.AI_SPEND_CODEX_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-codex-"));
    process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-home-"));
    process.env.AI_SPEND_CODEX_HOME_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-codex-home-"));
    process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
    process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_ADMIN_KEY;
    delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
    delete process.env.AI_SPEND_CODEX_LOGS_DIR;
    delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
    delete process.env.AI_SPEND_CODEX_HOME_DIR;
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
  });

  it("leads connect with OpenAI/Anthropic and warns cost is admin-gated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-connect-frame-"));
    await runCli(["init", "--path", dir]);

    const result = await runCli(["connect", "openai", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tier: self-serve");
    expect(result.stdout).toContain("cost data is ADMIN-gated");
  });

  it("labels cursor as an admin-upgrade provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-connect-cursor-"));
    await runCli(["init", "--path", dir]);

    const result = await runCli(["connect", "cursor", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ADMIN UPGRADE");
    expect(result.stdout).toContain("TEAM-ADMIN");
  });

  it("auto-detects a local key on connect without printing the raw secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-connect-detect-"));
    const fakeKey = "sk-proj-" + "detectfakekey1234567890abcdef";
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(join(dir, ".env"), `OPENAI_API_KEY=${fakeKey}`)
    );
    await runCli(["init", "--path", dir]);

    const result = await runCli(["connect", "openai", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("auto-detected");
    expect(result.stdout).toContain("env:OPENAI_API_KEY");
    expect(result.stdout).not.toContain(fakeKey);
  });

  it("gives launch-grade diagnostics in doctor (no stale prototype language)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-"));
    const result = await runCli(["doctor", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill doctor");
    expect(result.stdout).toContain("local-first mode: enabled");
    expect(result.stdout).toContain("redaction policy: secrets are never printed");
    expect(result.stdout).toContain(`path: ${dir}`);
    expect(result.stdout).toContain(`state directory: ${join(dir, ".ai-spend-agent")}`);
    expect(result.stdout).toContain("state mode: no state");
    expect(result.stdout).toContain("plan check: available");
    expect(result.stdout).toContain("data mode you'll get now:");
    // Stale prototype language must be gone.
    expect(result.stdout).not.toContain("not wired in this slice");
  });

  it("initializes local state with a demo-safe manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-"));
    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill init");
    expect(result.stdout).toContain("demo mode: local-first sample workflow");
    expect(result.stdout).toContain("next: ai-spend-agent scan --sample --path");

    const manifest = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      product: "aibill",
      mode: "local-first-demo",
      cloudUpload: false,
      cronJobsEnabled: false
    });
    expect(manifest.redactionPolicy).toContain("secrets are never printed");
    expect(manifest.sourceRegistry).toBe("sources.json");
    expect(manifest.auditLog).toBe("audit-log.json");

    const sources = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8"));
    const auditLog = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "audit-log.json"), "utf8"));
    expect(sources).toMatchObject({
      version: 1,
      localOnly: true,
      cloudUpload: false
    });
    expect(sources.approvedSources[0]).toMatchObject({
      id: "local-root",
      type: "local_folder",
      path: dir,
      readOnly: true
    });
    expect(auditLog.events.map((event: { action: string }) => event.action)).toContain("source_registered");
  });

  it("scans sample data and writes local state plus source registry/audit log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-"));
    const result = await runCli(["scan", "--sample", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("source registry: .ai-spend-agent/sources.json");
    expect(result.stdout).toContain("audit log: .ai-spend-agent/audit-log.json");
    expect(result.stdout).toContain("approved sources: 1");
    expect(result.stdout).toContain("sample records: 9");
    expect(result.stdout).toContain("total spend: $87.00");

    const spend = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "spend.json"), "utf8"));
    const mappings = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "mappings.json"), "utf8"));
    const sources = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8"));
    const auditLog = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "audit-log.json"), "utf8"));
    expect(spend.summary.totalUsd).toBe(87);
    expect(mappings).toHaveLength(9);
    expect(sources.approvedSources[0]).toMatchObject({ path: dir, readOnly: true });
    expect(auditLog.events.map((event: { action: string }) => event.action)).toEqual(expect.arrayContaining([
      "source_registered",
      "scan_started",
      "source_scanned",
      "scan_completed"
    ]));
  });

  it("scans a local path and redacts env secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-path-"));
    const openAiKeyName = "OPENAI" + "_API_KEY";
    const fakeOpenAiKey = "sk-" + "proj-abcdefghijklmnopqrstuvwxyz1234567890";
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(join(dir, ".env"), `${openAiKeyName}=sk-pro...7890`)
    );

    const result = await runCli(["scan", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("discovery signals:");
    expect(result.stdout).not.toContain(fakeOpenAiKey);

    const discovery = await readFile(join(dir, ".ai-spend-agent", "discovery.json"), "utf8");
    expect(discovery).toContain(`${openAiKeyName}=[REDACTED]`);
    expect(discovery).not.toContain(fakeOpenAiKey);
  });

  it("never follows a symlinked CLI state child on reads or writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-state-child-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-spend-cli-state-outside-"));
    const outsideFile = join(outside, "private.json");
    await writeFile(outsideFile, '{"private":"must remain outside"}\n');
    await runCli(["scan", "--sample", "--path", dir]);

    const spendPath = join(dir, ".ai-spend-agent", "spend.json");
    await unlink(spendPath);
    await symlink(outsideFile, spendPath);
    const quickstart = await runCli(["--path", dir, "--no-color"]);
    expect(quickstart.stdout).not.toContain("must remain outside");

    const discoveryPath = join(dir, ".ai-spend-agent", "discovery.json");
    await unlink(discoveryPath);
    await symlink(outsideFile, discoveryPath);
    await expect(runCli(["scan", "--path", dir])).rejects.toThrow(/symbolic link/);
    expect(await readFile(outsideFile, "utf8")).toContain("must remain outside");
  }, 30_000);

  it("refuses a symlinked CLI state directory before reset can delete outside files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-reset-root-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-spend-cli-reset-outside-"));
    const outsideSpend = join(outside, "spend.json");
    await writeFile(outsideSpend, '{"private":"must survive reset"}\n');
    await symlink(outside, join(dir, ".ai-spend-agent"));

    await expect(runCli(["reset", "--path", dir])).rejects.toThrow(/symbolic link/);
    expect(await readFile(outsideSpend, "utf8")).toContain("must survive reset");
  });

  it("refuses to scan the full home directory by default", async () => {
    const result = await runCli(["scan", "--path", homedir()]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Refusing to scan");
    expect(result.stderr).toContain("home directory is too broad");
  });

  it("adds and lists approved sources without scanning them immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-sources-"));
    const exportPath = join(dir, "openai-usage.csv");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(exportPath, "date,model,cost_usd\n"));
    await runCli(["init", "--path", dir]);

    const addResult = await runCli([
      "add-source",
      "--path",
      dir,
      "--source-path",
      exportPath,
      "--type",
      "provider_export",
      "--provider",
      "openai",
      "--label",
      "OpenAI May export"
    ]);
    const listResult = await runCli(["list-sources", "--path", dir]);

    expect(addResult.exitCode).toBe(0);
    expect(addResult.stdout).toContain("source added: openai-may-export");
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("OpenAI May export");
    expect(listResult.stdout).toContain("provider_export");

    const sources = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8"));
    expect(sources.approvedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai-may-export", type: "provider_export", provider: "openai", path: exportPath })
    ]));
  });

  it("registers provider connector stubs without storing secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-connect-"));
    await runCli(["init", "--path", dir]);

    const result = await runCli([
      "connect",
      "anthropic",
      "--path",
      dir,
      "--type",
      "provider_api"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("connector stub: anthropic-provider-api");
    expect(result.stdout).toContain("verification: missing");
    expect(result.stdout).toContain("no raw secrets stored");

    const sourcesRaw = await readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8");
    const sources = JSON.parse(sourcesRaw);
    expect(sourcesRaw).not.toContain("sk-ant");
    expect(sources.approvedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "anthropic-provider-api",
        type: "provider_api",
        provider: "anthropic",
        accessMethod: "api",
        verification: "missing"
      })
    ]));
  });

  it("prints detected-but-missing prompts after scanning local tool signals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-missing-"));
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "latest" } }))
    );

    const result = await runCli(["scan", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("missing source prompts:");
    expect(result.stdout).toContain("connect anthropic --type provider_api");
    const prompts = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "missing-sources.json"), "utf8"));
    expect(prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", status: "detected_unverified" })
    ]));
  });

  it("syncs OpenAI provider costs through a reference-only connector", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-provider-"));
    const fakeToken = "sk-" + "admin-realistic-fake-token-do-not-store";
    process.env.OPENAI_ADMIN_KEY = fakeToken;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          start_time: 1761955200,
          results: [{ amount: { value: 9.75, currency: "usd" }, project_id: "proj_sales", line_item: "Responses API" }]
        }]
      })
    })));
    await runCli(["init", "--path", dir]);

    const result = await runCli([
      "sync-provider",
      "--path",
      dir,
      "--provider",
      "openai",
      "--auth-reference",
      "env:OPENAI_ADMIN_KEY",
      "--start-time",
      "1761955200",
      "--end-time",
      "1762041600"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill sync-provider");
    expect(result.stdout).toContain("provider: openai");
    expect(result.stdout).toContain("coverage: complete");
    expect(result.stdout).toContain("records fetched: 1");
    expect(result.stdout).toContain("headline basis: provider_reported_billed_cost");
    expect(result.stdout).toContain("synced provider headline: $9.75");
    expect(result.stdout).toContain("combined headline spend: $9.75");
    expect(result.stdout).not.toContain(fakeToken);

    const providerRecordsRaw = await readFile(join(dir, ".ai-spend-agent", "provider-records.json"), "utf8");
    const spendRaw = await readFile(join(dir, ".ai-spend-agent", "spend.json"), "utf8");
    const sourcesRaw = await readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8");
    expect(providerRecordsRaw).not.toContain(fakeToken);
    expect(spendRaw).not.toContain(fakeToken);
    expect(sourcesRaw).not.toContain(fakeToken);
    expect(JSON.parse(providerRecordsRaw).records[0]).toMatchObject({ amountUsd: 9.75, costConfidence: "verified" });
    expect(JSON.parse(sourcesRaw).approvedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai-provider-api", provider: "openai", verification: "verified", authReference: "env:OPENAI_ADMIN_KEY" })
    ]));
  });

  it("keeps Anthropic billed cost separate from Claude Code API-equivalent estimates across sync and quickstart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-anthropic-accounting-"));
    const fakeToken = "sk-" + "admin-anthropic-fake-token-do-not-store";
    process.env.ANTHROPIC_ADMIN_KEY = fakeToken;
    const startTime = 1_761_955_200;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => url.includes("cost_report")
        ? {
            data: [{
              starting_at: new Date(startTime * 1000).toISOString(),
              results: [{ amount: "250", currency: "USD", cost_type: "tokens" }]
            }],
            has_more: false
          }
        : {
            data: [{
              date: new Date(startTime * 1000).toISOString().slice(0, 10),
              actor: { email_address: "developer@example.com" },
              core_metrics: { num_sessions: 1 },
              model_breakdown: [{
                model: "claude-sonnet-4-6",
                tokens: { input: 100, output: 20 },
                estimated_cost: { currency: "USD", amount: 123 }
              }]
            }],
            has_more: false
          }
    })));
    await runCli(["init", "--path", dir]);

    const sync = await runCli([
      "sync-provider",
      "--path",
      dir,
      "--provider",
      "anthropic",
      "--auth-reference",
      "env:ANTHROPIC_ADMIN_KEY",
      "--start-time",
      String(startTime),
      "--end-time",
      String(startTime)
    ]);
    const quickstart = await runCli(["--path", dir, "--no-color"]);
    const receiptPath = join(dir, "anthropic-receipt.svg");
    const receipt = await runCli([
      "report-card", "--path", dir, "--out", receiptPath, "--no-color"
    ]);
    const spend = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "spend.json"), "utf8"));

    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toContain("synced provider headline: $2.50");
    expect(sync.stdout).toContain("API-equivalent estimate (kept separate): $1.23");
    expect(sync.stdout).toContain("combined headline spend: $2.50");
    expect(quickstart.stdout).toContain("$2.50");
    expect(quickstart.stdout).not.toContain("$3.73");
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stdout).toContain("$2.50 in provider-reported cost");
    expect(receipt.stdout).not.toContain("$3.73");
    const receiptSvg = await readFile(receiptPath, "utf8");
    expect(receiptSvg).toContain("$2.50");
    expect(receiptSvg).not.toContain("$3.73");
    expect(spend.records).toHaveLength(2);
    expect(spend.summary.totalUsd).toBe(2.5);
    expect(spend.accounting.financialsByProvider.anthropic).toMatchObject({
      providerReportedBilledUsd: 2.5,
      apiEquivalentEstimatedUsd: 1.23,
      headlineUsd: 2.5
    });
  });

  it("rejects plaintext-looking provider auth references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-provider-secret-"));
    const fakeToken = "sk-" + "admin-realistic-fake-token-do-not-store";

    const result = await runCli([
      "sync-provider",
      "--path",
      dir,
      "--provider",
      "openai",
      "--auth-reference",
      fakeToken,
      "--start-time",
      "1761955200"
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("raw secrets are not accepted");
    expect(result.stderr).not.toContain(fakeToken);
  });

  it("persists mapping confirmations locally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-map-"));
    await runCli(["init", "--path", dir]);

    const result = await runCli([
      "confirm-mapping",
      "--path",
      dir,
      "--provider",
      "anthropic",
      "--source-id",
      "anthropic-provider-api",
      "--team",
      "Sales",
      "--project",
      "enterprise-sales",
      "--workflow",
      "proposal drafting",
      "--evidence",
      "Claude account UI report",
      "--confidence",
      "0.82"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mapping confirmed:");
    expect(result.stdout).toContain("Sales / enterprise-sales / proposal drafting");

    const mappings = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "confirmed-mappings.json"), "utf8"));
    expect(mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "anthropic", team: "Sales", project: "enterprise-sales", workflow: "proposal drafting", status: "confirmed" })
    ]));
  });

  it("generates a local markdown and html report from sample state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-report-"));
    await runCli(["scan", "--sample", "--path", dir]);

    const result = await runCli(["report", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill report");
    expect(result.stdout).toContain("cost/value evidence total: $87.00");

    const markdown = await readFile(join(dir, ".ai-spend-agent", "report.md"), "utf8");
    const html = await readFile(join(dir, ".ai-spend-agent", "report.html"), "utf8");
    const applyArtifact = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");
    const actionPlan = await readFile(join(dir, ".ai-spend-agent", "ai-spend-action-plan.md"), "utf8");
    const policyDraft = await readFile(join(dir, ".ai-spend-agent", "ai-spend-policy-config-draft.md"), "utf8");
    const verifyPlan = await readFile(join(dir, ".ai-spend-agent", "ai-spend-verify-plan.md"), "utf8");
    const demoPackage = await readFile(join(dir, ".ai-spend-agent", "demo-package.md"), "utf8");
    expect(markdown).toContain("# aibill Evidence Report");
    expect(markdown).toContain("## Executive accountability brief");
    expect(markdown).toContain("## Priority recommendations");
    expect(markdown).toContain("## Executive action plan");
    expect(markdown).toContain("## Illustrative workflow attribution watch");
    expect(markdown).toContain("client-beta / project-research / research_summary");
    expect(markdown).toContain("Financial inference: attribution concentration only; no margin or savings amount is inferred.");
    expect(markdown).toContain("no executable Apply action is generated from the bundled sample");
    expect(applyArtifact).toContain("# AI Spend Apply Artifact — Demo Only");
    expect(applyArtifact).toContain("NON-EXECUTABLE DEMO");
    expect(applyArtifact).not.toContain("client-beta / project-research / research_summary");
    expect(actionPlan).toContain("# AI Spend Action Plan");
    expect(actionPlan).toContain("No file, configuration, routing, budget, provider, or policy change is authorized");
    expect(policyDraft).toContain("# AI Spend Policy / Config Draft");
    expect(policyDraft).toContain("humanApproved: false");
    expect(policyDraft).toContain("executionAuthorized: false");
    expect(verifyPlan).toContain("# AI Spend Verification Plan");
    expect(verifyPlan).toContain("Do not rerun the sample as a before/after test");
    expect(demoPackage).toContain("# aibill Demo Package");
    expect(demoPackage).toContain("Demo command flow");
    expect(demoPackage).toContain("QA controller checklist");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Executive accountability brief");
    expect(html).toContain("aibill Evidence Report");
  });

  it("refuses a symlinked custom report output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-report-symlink-"));
    await runCli(["scan", "--sample", "--path", dir]);
    const outside = join(await mkdtemp(join(tmpdir(), "ai-spend-cli-report-target-")), "outside.txt");
    await writeFile(outside, "keep-me", "utf8");
    await symlink(outside, join(dir, "custom-report.md"));

    const result = await runCli(["report", "--path", dir, "--out", "custom-report"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("symbolic link");
    expect(await readFile(outside, "utf8")).toBe("keep-me");
  });

  it("prints a plain-English local readout from sample data via quickstart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-quickstart-"));

    const result = await runCli(["quickstart", "--sample", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ILLUSTRATIVE COST / VALUE EVIDENCE");
    expect(result.stdout).toContain("$87.00");
    expect(result.stdout).toContain("combined illustrative evidence across 9 illustrative records");
    expect(result.stdout).toContain("Illustrative hypotheses only");
    expect(result.stdout).toContain("to gpt-5.5-mini");
    expect(result.stdout).toMatch(/model ~\$[\d,]+\.\d{2}\/mo/);
    expect(result.stdout).toContain("Cost/value evidence by model");
    // Human-readable terminal output, not a JSON dump.
    expect(result.stdout).not.toContain("totalUsd");
  });

  it("respects the --group-by flag in quickstart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-quickstart-group-"));

    const result = await runCli(["quickstart", "--sample", "--group-by", "client", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cost/value evidence by client");
  });

  it("reports baseline then deltas across watch cycles and persists snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-watch-"));

    const first = await runCli(["watch", "--sample", "--cycles", "1", "--path", dir]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("First watch snapshot");
    expect(first.stdout).toContain("Baseline AI spend is $87.00");

    const second = await runCli(["watch", "--sample", "--cycles", "1", "--path", dir]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("No change since the last check");

    const latest = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "watch-latest.json"), "utf8"));
    const history = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "watch-history.json"), "utf8"));
    expect(latest.totalUsd).toBe(87);
    expect(history).toHaveLength(2);
  });

  it("emits the baseline exactly once across a multi-cycle watch (streaming path)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-watch-once-"));
    const streamed: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      streamed.push(String(message));
    });
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production"; // exercise the live streaming path
    try {
      const result = await runCli(["watch", "--sample", "--cycles", "2", "--interval", "1", "--path", dir, "--no-color"]);
      expect(result.exitCode).toBe(0);
      const combined = `${streamed.join("\n")}\n${result.stdout}`;
      const baselineCount = combined.split("First watch snapshot").length - 1;
      expect(baselineCount).toBe(1);
      expect(combined).toContain("No change since the last check");
    } finally {
      process.env.NODE_ENV = previousEnv;
      spy.mockRestore();
    }
  });

  it("flags spend increases and new-model anomalies between watch cycles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-watch-anomaly-"));
    await import("node:fs/promises").then(async ({ mkdir, writeFile }) => {
      await mkdir(join(dir, ".ai-spend-agent"), { recursive: true });
      await writeFile(
        join(dir, ".ai-spend-agent", "watch-latest.json"),
        JSON.stringify({
          capturedAt: "2026-06-01T00:00:00.000Z",
          totalUsd: 40,
          recordCount: 5,
          byModel: [{ key: "claude-fable-5", amountUsd: 10 }]
        })
      );
    });

    const result = await runCli(["watch", "--sample", "--cycles", "1", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Spend is UP $47.00");
    expect(result.stdout).toContain('New model "gpt-5.5" appeared');
    expect(result.stdout).toContain('"claude-fable-5" jumped from $10.00 to $24.90');
  });

  it("turns a live provider pull into a plain-English readout end to end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-live-"));
    const fakeToken = "sk-" + "admin-realistic-fake-token-do-not-store";
    process.env.OPENAI_ADMIN_KEY = fakeToken;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/costs")
        ? {
            data: [{
              start_time: 1761955200,
              results: [
                { amount: { value: 42.5, currency: "usd" }, project_id: "proj_acme", line_item: "gpt-4.1", api_key_id: "key_a" },
                { amount: { value: 12, currency: "usd" }, project_id: "proj_beta", line_item: "gpt-4.1-mini", api_key_id: "key_b" }
              ]
            }],
            has_more: false
          }
        : { data: [], has_more: false })
    })));

    const sync = await runCli([
      "sync-provider",
      "--path",
      dir,
      "--provider",
      "openai",
      "--auth-reference",
      "env:OPENAI_ADMIN_KEY",
      "--start-time",
      "1761955200",
      "--end-time",
      "1762041600"
    ]);
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toContain("combined headline spend: $54.50");
    expect(sync.stdout).not.toContain(fakeToken);

    // quickstart without --sample must use the live provider records, not sample data.
    const quick = await runCli(["quickstart", "--group-by", "model", "--path", dir]);
    expect(quick.exitCode).toBe(0);
    expect(quick.stdout).toContain("$54.50");
    expect(quick.stdout).toContain("tracked across 2 provider records");
    expect(quick.stdout).toContain("Provider-reported cost by model");
    expect(quick.stdout).toContain("gpt-4.1");
    expect(quick.stdout).not.toContain(fakeToken);
    expect(quick.stdout).not.toContain("87.00");
  });

  it("generates Apply + Verify artifacts without rebuilding the full report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-apply-"));
    await runCli(["scan", "--sample", "--path", dir]);

    const result = await runCli(["apply-artifact", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill apply-artifact");
    expect(result.stdout).toContain("action plan:");
    expect(result.stdout).toContain("policy/config draft:");
    expect(result.stdout).toContain("verification plan:");
    expect(result.stdout).toContain("demo package:");
    // The paste-ready prompt is printed inline — a terminal user should never
    // have to hunt for a file path to get the deliverable.
    expect(result.stdout).toContain("copy everything below into Claude Code / Codex");
    expect(result.stdout).toContain("# AI Spend Apply Artifact");

    // `apply` is the promoted short form of apply-artifact.
    const short = await runCli(["apply", "--path", dir]);
    expect(short.exitCode).toBe(0);
    expect(short.stdout).toContain("# AI Spend Apply Artifact");
    expect(await readFile(join(dir, ".ai-spend-agent", "ai-spend-action-plan.md"), "utf8")).toContain("# AI Spend Action Plan");
  });
});
