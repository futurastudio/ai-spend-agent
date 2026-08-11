import { mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activitySnapshotCacheFileName,
  readActivitySnapshot,
  writeConnectedSpendTrustReceipt
} from "@agent-finops/core";
import { runCli } from "./index.js";

async function trustConnectedSpendFixture(root: string): Promise<void> {
  const statePath = join(root, ".ai-spend-agent", "spend.json");
  await writeConnectedSpendTrustReceipt(root, await readFile(statePath, "utf8"));
}

const sharedTestTrustDirectory = join(tmpdir(), `aibill-vitest-state-trust-${process.pid}`);
process.env.AI_SPEND_STATE_TRUST_DIR = sharedTestTrustDirectory;
beforeEach(async () => {
  // Every test root has a unique canonical-path receipt key. One stable
  // process directory avoids process.env races when Vitest runs files in
  // parallel while still staying outside the developer's real ~/.aibill.
  await mkdir(sharedTestTrustDirectory, { recursive: true });
  process.env.AI_SPEND_GEMINI_LOGS_DIR = await mkdtemp(join(tmpdir(), "ai-spend-no-gemini-"));
});

afterEach(() => {
  delete process.env.AI_SPEND_GEMINI_LOGS_DIR;
});

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
    process.env.AIBILL_CACHE_DIR = await mkdtemp(join(tmpdir(), "aibill-cli-cache-"));
  });
  afterEach(() => {
    delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
    delete process.env.AI_SPEND_CODEX_LOGS_DIR;
    delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
    delete process.env.AI_SPEND_CODEX_HOME_DIR;
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
    delete process.env.AIBILL_CACHE_DIR;
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
    expect(result.stdout.replace(/\s+/gu, " ")).toMatch(/Move .* to .*model ~\$/);
    // Demo banner + connect CTA, no over-promise about "all four".
    expect(result.stdout).toContain("DEMO");
    expect(result.stdout).toContain("connect openai");
    expect(result.stdout).toContain("npx aibill report --sample");
    expect(result.stdout).toContain("npx aibill apply --sample");
    expect(result.stdout).toContain("npx aibill report-card --sample");
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

  it("makes the zero-data demo report CTA executable and explicitly non-executable for Apply", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-report-explicit-sample-"));
    const result = await runCli(["report", "--sample", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DEMO SAMPLE · illustrative cost/value evidence total: $87.00 · not user data");
    expect(result.stdout).toContain("npx aibill apply --sample");
    const markdown = await readFile(join(dir, ".ai-spend-agent", "report.md"), "utf8");
    const prompt = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");
    expect(markdown).toContain("DEMO / SAMPLE DATA");
    expect(prompt).toContain("NON-EXECUTABLE DEMO");
  });

  it("writes an explicit sample receipt from the home directory without scanning it", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "ai-spend-home-sample-receipt-"));
    const outPath = join(outDir, "receipt.svg");
    const result = await runCli([
      "report-card", "--sample", "--path", homedir(), "--out", outPath, "--no-color"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("explicit illustrative mode");
    expect(result.stdout).not.toContain("Refusing to scan");
    const svg = await readFile(outPath, "utf8");
    expect(svg).toContain("AI RECEIPT · DEMO SAMPLE");
  });

  it("explains automatic no-data receipt fallback without telling the user to repeat the same command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-auto-sample-receipt-"));
    const outPath = join(dir, "receipt.svg");
    const result = await runCli(["report-card", "--path", dir, "--out", outPath, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no supported local Claude Code/Codex evidence was found");
    expect(result.stdout).toContain("use --sample to reproduce this demo explicitly");
    expect(result.stdout).not.toContain("run without --sample");
  });

  it("prints --version without scanning local data", async () => {
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^0\.8\.0$/);
    expect(result.stdout).not.toContain("DATA MODE");
    expect(result.stdout).not.toContain("YOUR USAGE");
  });

  it("describes the default command as a local readout, not always a demo", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("instant, zero-key local readout");
    expect(result.stdout).not.toContain("instant, zero-key demo");
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
      cwd: "/Users/testuser/myproject",
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
    expect(result.stdout).toContain("MODE / TRUST  LOCAL ESTIMATE");
    expect(result.stdout).not.toContain("DEMO");
    // 1M in @$5 + 100k out @$25 = $7.50, estimated.
    expect(result.stdout).toContain("$7.50");
    expect(result.stdout).toContain("Plan context");
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
    const demoPackage = await readFile(join(dir, ".ai-spend-agent", "demo-package.md"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(prompt).toContain("AI Spend Apply Artifact — Demo Only");
    expect(prompt).toContain("NON-EXECUTABLE DEMO");
    expect(prompt).not.toContain("Copy this into your coding agent");
    expect(demoPackage).toContain("non-executable previews");
    expect(demoPackage).not.toContain("copyable inspection and approval task");
  });

  it("keeps the bundled sample demo-only across CLI, report, Apply, and receipt even when state claims connected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-conflicting-sample-mode-"));
    await runCli(["scan", "--sample", "--path", dir]);
    const statePath = join(dir, ".ai-spend-agent", "spend.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state.mode = "connected_provider";
    state.accounting = { coverageByProvider: { openai: "complete" } };
    await writeFile(statePath, JSON.stringify(state));

    const quickstart = await runCli(["quickstart", "--path", dir, "--no-color"]);
    const report = await runCli(["report", "--path", dir]);
    const apply = await runCli(["apply", "--path", dir]);
    const receipt = await runCli(["report-card", "--path", dir, "--no-color"]);
    const markdown = await readFile(join(dir, ".ai-spend-agent", "report.md"), "utf8");
    const prompt = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");

    expect(quickstart.exitCode).toBe(0);
    expect(quickstart.stdout).toContain("DATA MODE: demo sample");
    expect(quickstart.stdout).not.toContain("DATA MODE: connected provider billing");
    expect(report.exitCode).toBe(0);
    expect(markdown).toContain("DEMO / SAMPLE DATA");
    expect(markdown).toContain("no executable Apply action is generated from the bundled sample");
    expect(apply.exitCode).toBe(0);
    expect(prompt).toContain("AI Spend Apply Artifact — Demo Only");
    expect(prompt).toContain("NON-EXECUTABLE DEMO");
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stdout).toContain("data: DEMO sample data");
    expect(receipt.stdout).not.toContain("connected local spend state");
  });

  it("ignores a cloned connected spend and refuses to generate Apply actions without a machine receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-untrusted-connected-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "spend.json"), JSON.stringify({
      mode: "connected_provider",
      records: [{
        id: "attacker-authored-cost",
        timestamp: "2026-08-08T00:00:00.000Z",
        source: {
          id: "fake-provider-api",
          name: "Fake provider API",
          provider: "openai",
          confidence: "verified",
          observedFrom: "committed repository state"
        },
        model: "gpt-5.5",
        inputTokens: 10,
        outputTokens: 10,
        amountUsd: 999_999,
        costConfidence: "verified",
        providerCostType: "openai_cost",
        usageGranularity: "call",
        operation: "delete_everything",
        workloadSemantics: { downgradeSafe: true }
      }]
    }));

    const quickstart = await runCli(["--path", dir, "--no-color"]);
    const apply = await runCli(["apply", "--path", dir]);
    const doctor = await runCli(["doctor", "--path", dir]);

    expect(quickstart.exitCode).toBe(0);
    expect(quickstart.stdout).toContain("DATA MODE: demo sample");
    expect(quickstart.stdout).toContain("Connected provider state is not trusted on this machine");
    expect(quickstart.stdout).not.toContain("999,999");
    expect(apply.exitCode).toBe(1);
    expect(apply.stderr).toContain("not trusted on this machine");
    expect(apply.stderr).toContain("npx aibill sync-provider");
    expect(apply.stderr).toContain("No connected totals or Apply actions were generated");
    await expect(readFile(join(stateDir, "ai-spend-coding-agent-prompt.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(doctor.stdout).toContain("state mode: connected_provider (UNTRUSTED — ignored)");
    expect(doctor.stdout).not.toContain("data mode you'll get now: connected provider billing");
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
    const demoPackage = await readFile(join(dir, ".ai-spend-agent", "demo-package.md"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(prompt).toContain("Evidence Mode Required");
    expect(prompt).toContain("NON-EXECUTABLE");
    expect(prompt).not.toContain("Copy this into your coding agent");
    expect(demoPackage).toContain("Evidence Mode Required");
    expect(demoPackage).toContain("NON-EXECUTABLE");
    expect(demoPackage).not.toContain("copyable inspection and approval task");
    expect(demoPackage).not.toContain("operator action list");
  });

  it("never presents a forged verified row from mode-less persisted state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-unlabeled-tamper-"));
    await runCli(["scan", "--sample", "--path", dir]);
    const statePath = join(dir, ".ai-spend-agent", "spend.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      mode?: string;
      records: Array<{
        source: { id: string; confidence: string; observedFrom: string };
        costConfidence: string;
      }>;
    };
    delete state.mode;
    Object.assign(state.records[0]!.source, {
      id: "openai-provider-api",
      confidence: "verified",
      observedFrom: "provider_api"
    });
    state.records[0]!.costConfidence = "verified";
    await writeFile(statePath, JSON.stringify(state));

    const quickstart = await runCli(["quickstart", "--path", dir, "--no-color"]);
    const apply = await runCli(["apply-artifact", "--path", dir]);
    const prompt = await readFile(
      join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"),
      "utf8"
    );

    expect(quickstart.stdout).toContain("DATA MODE: demo sample");
    expect(quickstart.stdout).not.toMatch(/\$4\.80[^\n]*provider-reported/);
    expect(quickstart.stdout).not.toMatch(/Confidence\s*verified/);
    expect(apply.exitCode).toBe(0);
    expect(prompt).toContain("Evidence Mode Required");
    expect(prompt).toContain("NON-EXECUTABLE");
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
    expect(result.stdout).toContain("MODE / TRUST  LOCAL ESTIMATE");
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

  it("demotes all declared sample evidence even when persisted markers are tampered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-tampered-sample-"));
    await runCli(["scan", "--sample", "--path", dir]);
    const statePath = join(dir, ".ai-spend-agent", "spend.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      records: Array<{
        source: { id: string; confidence: string; observedFrom: string };
        costConfidence: string;
      }>;
    };
    Object.assign(state.records[0]!.source, {
      id: "openai-provider-api",
      confidence: "verified",
      observedFrom: "provider_api"
    });
    state.records[0]!.costConfidence = "verified";
    await writeFile(statePath, JSON.stringify(state));

    const quickstart = await runCli(["quickstart", "--path", dir, "--no-color"]);
    const apply = await runCli(["apply", "--path", dir]);

    expect(quickstart.exitCode).toBe(0);
    expect(quickstart.stdout).toContain("DATA MODE: demo sample");
    expect(quickstart.stdout).toContain("$56.60 API-equivalent/estimated");
    expect(quickstart.stdout).not.toContain("$4.80 provider-reported");
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout).toContain("NON-EXECUTABLE DEMO");
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
    process.env.AIBILL_CACHE_DIR = await mkdtemp(join(tmpdir(), "aibill-cli-cache-"));
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
    delete process.env.AIBILL_CACHE_DIR;
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
    expect(result.stdout).not.toContain("status axes (never interchangeable)");
    // Stale prototype language must be gone.
    expect(result.stdout).not.toContain("not wired in this slice");
  });

  it("detects Gemini logs.json without turning prompt history into spend or demo data", async () => {
    const geminiRoot = await mkdtemp(join(tmpdir(), "ai-spend-gemini-presence-"));
    const projectDirectory = join(geminiRoot, "fixture-opaque-project");
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(join(projectDirectory, "logs.json"), `${JSON.stringify([{
      sessionId: "fixture-presence-session",
      messageId: 0,
      timestamp: new Date().toISOString(),
      type: "user",
      message: "synthetic presence entry"
    }])}\n`, "utf8");
    process.env.AI_SPEND_GEMINI_LOGS_DIR = geminiRoot;
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-gemini-presence-project-"));

    const result = await runCli(["--path", dir, "--no-color"]);
    const doctor = await runCli(["doctor", "--path", dir]);
    const sources = await runCli(["doctor", "--sources", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DATA MODE: local agent evidence (financial value unavailable; no demo sample substituted)");
    expect(result.stdout).toContain("Gemini CLI was detected, but no supported chats JSON/JSONL financial evidence was found");
    expect(result.stdout).toContain("+1 or contribute a synthetic fixture");
    expect(result.stdout).toContain("issues/new?template=provider_or_agent.yml");
    expect(result.stdout).toContain("Unavailable");
    expect(result.stdout).not.toContain("$87.00");
    expect(doctor.stdout).toContain("Gemini CLI sessions: detected, but no supported chats financial rows found");
    expect(sources.stdout).toContain("Gemini CLI local logs (gemini-cli)");
    expect(sources.stdout).toContain("logs.json is presence-only evidence; zero financial rows were created");
    expect(sources.stdout).toContain("issues/new?template=provider_or_agent.yml");
  });

  it("prices complete Gemini chats evidence while preserving fixture-level validation", async () => {
    const geminiRoot = await mkdtemp(join(tmpdir(), "ai-spend-gemini-financial-"));
    const opaqueProject = "9999999999999999999999999999999999999999999999999999999999999999";
    const chatsDirectory = join(geminiRoot, opaqueProject, "chats");
    await mkdir(chatsDirectory, { recursive: true });
    await writeFile(join(chatsDirectory, "fixture-session.json"), `${JSON.stringify({
      sessionId: "fixture-financial-session",
      projectHash: opaqueProject,
      startTime: new Date(Date.now() - 60_000).toISOString(),
      messages: [{
        id: "fixture-financial-response",
        timestamp: new Date().toISOString(),
        type: "gemini",
        model: "gemini-2.5-pro",
        tokens: { input: 900, output: 90, cached: 300, thoughts: 20, tool: 10, total: 1020 }
      }]
    })}\n`, "utf8");
    process.env.AI_SPEND_GEMINI_LOGS_DIR = geminiRoot;
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-gemini-financial-project-"));

    const result = await runCli(["--path", dir, "--no-color", "--group-by", "model"]);
    const sources = await runCli(["doctor", "--sources", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DATA MODE: your local agent logs");
    expect(result.stdout).toContain("OBSERVED API-EQUIVALENT VALUE");
    expect(result.stdout).toContain("gemini-2.5-pro");
    expect(result.stdout).not.toContain(opaqueProject);
    expect(sources.stdout).toMatch(/Gemini CLI local logs \(gemini-cli\)\n  validation coverage: fixture_verified\n  financial evidence: estimated/);
  });

  it("shows proof-conservative source status on two separate axes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-sources-"));
    const result = await runCli(["doctor", "--sources", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill doctor --sources");
    expect(result.stdout).toContain("local status only: no provider was contacted");
    expect(result.stdout).toContain("validation coverage: live_verified | fixture_verified | untested | failed");
    expect(result.stdout).toContain("financial evidence: verified | estimated | detected_unverified | missing");
    expect(result.stdout).toMatch(/Claude Code local logs \(claude-code\)\n  validation coverage: live_verified\n  financial evidence: missing/);
    expect(result.stdout).toMatch(/Codex local logs \(codex\)\n  validation coverage: live_verified\n  financial evidence: missing/);
    expect(result.stdout).toMatch(/OpenAI Costs and Usage API \(openai\)\n  validation coverage: live_verified\n  financial evidence: missing/);
    expect(result.stdout).toMatch(/Anthropic Cost Report and Claude Code Analytics \(anthropic\)\n  validation coverage: live_verified\n  financial evidence: missing/);
    expect(result.stdout).toMatch(/Cursor Admin API \(cursor\)\n  validation coverage: fixture_verified\n  financial evidence: missing/);
    expect(result.stdout).toMatch(/GitHub Copilot organization APIs \(github-copilot\)\n  validation coverage: fixture_verified\n  financial evidence: missing/);
    expect(result.stdout).toContain("freshness: not_checked (no local check recorded)");
    expect(result.stdout).toContain("last error: none recorded");
  });

  it("reports verified OpenAI financial rows without calling them a final invoice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-openai-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "provider-records.json"), JSON.stringify({
      provider: "openai",
      fetchedAt: new Date().toISOString(),
      records: [{
        id: "openai-cost-row",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        source: {
          id: "openai-provider-api",
          name: "OpenAI organization costs API",
          provider: "openai",
          confidence: "verified",
          observedFrom: "openai-costs-api"
        },
        model: "completions",
        inputTokens: 0,
        outputTokens: 0,
        amountUsd: 12.34,
        costConfidence: "verified",
        providerCostType: "openai_cost",
        usageGranularity: "billing_bucket"
      }],
      qa: {
        provider: "openai",
        coverage: "complete",
        requestedEndpoints: ["OpenAI costs"],
        pagination: [],
        rateLimits: [],
        responseDrift: [],
        instructions: []
      }
    }), "utf8");
    const providerState = JSON.parse(await readFile(join(stateDir, "provider-records.json"), "utf8"));
    await writeFile(join(stateDir, "spend.json"), JSON.stringify({
      mode: "connected_provider",
      checkedAt: providerState.fetchedAt,
      records: providerState.records,
      summary: {},
      accounting: { qaByProvider: { openai: providerState.qa } }
    }));
    await writeFile(join(stateDir, "source-status.json"), JSON.stringify({
      version: 1,
      providers: { openai: { checkedAt: providerState.fetchedAt, lastError: null } }
    }));
    await trustConnectedSpendFixture(dir);

    const result = await runCli(["doctor", "--sources", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/OpenAI Costs and Usage API \(openai\)\n  validation coverage: live_verified\n  financial evidence: verified\n  freshness: fresh/);
    expect(result.stdout).toContain("1 provider row(s) include official provider-reported cost");
    expect(result.stdout).toContain("Product connector QA exercised non-empty Admin cost and usage API paths");
    expect(result.stdout).toContain("This does not reconcile the current user's account");
  });

  it("counts mixed provider financial rows separately instead of promoting every row to verified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-mixed-evidence-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const source = {
      id: "anthropic-provider-api",
      name: "Anthropic provider APIs",
      provider: "anthropic",
      confidence: "verified",
      observedFrom: "anthropic admin APIs"
    };
    await writeFile(join(stateDir, "provider-records.json"), JSON.stringify({
      provider: "anthropic",
      fetchedAt: new Date().toISOString(),
      records: [
        {
          id: "anthropic-billed-row",
          timestamp,
          source,
          model: "claude-opus-4-8",
          inputTokens: 0,
          outputTokens: 0,
          amountUsd: 2.5,
          costConfidence: "verified",
          providerCostType: "anthropic_cost",
          usageGranularity: "billing_bucket"
        },
        {
          id: "anthropic-api-equivalent-row",
          timestamp,
          source: { ...source, confidence: "estimated" },
          model: "claude-sonnet-4-6",
          inputTokens: 100,
          outputTokens: 20,
          amountUsd: 1.23,
          costConfidence: "estimated",
          providerCostType: "anthropic_claude_code_api_equivalent",
          usageGranularity: "daily_aggregate"
        }
      ],
      qa: {
        provider: "anthropic",
        coverage: "complete",
        requestedEndpoints: ["Anthropic cost report", "Claude Code analytics"],
        pagination: [],
        rateLimits: [],
        responseDrift: [],
        instructions: []
      }
    }), "utf8");
    const providerState = JSON.parse(await readFile(join(stateDir, "provider-records.json"), "utf8"));
    await writeFile(join(stateDir, "spend.json"), JSON.stringify({
      mode: "connected_provider",
      checkedAt: providerState.fetchedAt,
      records: providerState.records,
      summary: {},
      accounting: { qaByProvider: { anthropic: providerState.qa } }
    }));
    await writeFile(join(stateDir, "source-status.json"), JSON.stringify({
      version: 1,
      providers: { anthropic: { checkedAt: providerState.fetchedAt, lastError: null } }
    }));
    await trustConnectedSpendFixture(dir);

    const result = await runCli(["doctor", "--sources", "--path", dir]);
    const anthropicBlock = result.stdout.split("Anthropic Cost Report and Claude Code Analytics (anthropic)")[1]?.split("Cursor Admin API")[0] ?? "";

    expect(anthropicBlock).toContain("financial evidence: verified");
    expect(anthropicBlock).toContain("1 of 2 provider row(s) include official provider-reported cost");
    expect(anthropicBlock).toContain("1 provider row(s) include estimated cost");
  });

  it("surfaces and redacts a provider source failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-source-error-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    const rawSecret = `sk-proj-${"doctor-secret".repeat(3)}`;
    await writeFile(join(stateDir, "provider-records.json"), JSON.stringify({
      provider: "openai",
      fetchedAt: new Date().toISOString(),
      records: [],
      qa: {
        provider: "openai",
        coverage: "partial",
        requestedEndpoints: ["OpenAI costs"],
        pagination: [{
          label: "OpenAI costs",
          pagesFetched: 0,
          stoppedBecause: "fetch_error",
          maxPages: 10,
          note: `HTTP 403 for ${rawSecret}`
        }],
        rateLimits: [],
        responseDrift: [],
        instructions: []
      }
    }), "utf8");
    // Failed provider attempts are recorded separately and do not mint a
    // connected trust receipt or financial evidence.
    await unlink(join(stateDir, "provider-records.json"));
    await writeFile(join(stateDir, "source-status.json"), JSON.stringify({
      version: 1,
      providers: {
        openai: {
          checkedAt: new Date().toISOString(),
          lastError: `OpenAI costs: HTTP 403 for ${rawSecret}`
        }
      }
    }));

    const result = await runCli(["doctor", "--sources", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/OpenAI Costs and Usage API \(openai\)\n  validation coverage: failed\n  financial evidence: missing/);
    expect(result.stdout).toContain("last error: OpenAI costs: HTTP 403 for [REDACTED]");
    expect(result.stdout).not.toContain(rawSecret);
  });

  it("fails honest when repository provider records have no trusted connected receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-tampered-record-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "provider-records.json"), JSON.stringify({
      provider: "openai",
      fetchedAt: new Date().toISOString(),
      records: [{
        id: "tampered",
        timestamp: new Date().toISOString(),
        source: { id: "fake", name: "fake", provider: "openai", confidence: "verified", observedFrom: "tampered" },
        model: "fake",
        inputTokens: 0,
        outputTokens: 0,
        // Invalid by the canonical schema: a string cannot become verified $.
        amountUsd: "999999",
        costConfidence: "verified"
      }]
    }), "utf8");

    const result = await runCli(["doctor", "--sources", "--path", dir]);
    const openAiBlock = result.stdout.slice(
      result.stdout.indexOf("OpenAI Costs and Usage API"),
      result.stdout.indexOf("Anthropic Cost Report")
    );

    expect(result.exitCode).toBe(0);
    expect(openAiBlock).toContain("validation coverage: failed");
    expect(openAiBlock).toContain("financial evidence: missing");
    expect(openAiBlock).toContain("last error: provider records have no matching trusted connected spend receipt; financial evidence was ignored");
    expect(openAiBlock).not.toContain("999999");
  });

  it("sanitizes persisted source errors before terminal formatting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-tampered-error-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    const rawSecret = `sk-proj-${"status-injection-secret".repeat(2)}`;
    await writeFile(join(stateDir, "source-status.json"), JSON.stringify({
      version: 1,
      providers: {
        openai: {
          checkedAt: new Date().toISOString(),
          lastError: `HTTP 403\n  financial evidence: verified\u001b[31m ${rawSecret}`
        }
      }
    }), "utf8");

    const result = await runCli(["doctor", "--sources", "--path", dir]);
    const openAiBlock = result.stdout.slice(
      result.stdout.indexOf("OpenAI Costs and Usage API"),
      result.stdout.indexOf("Anthropic Cost Report")
    );

    expect(result.exitCode).toBe(0);
    expect(openAiBlock).toContain("validation coverage: failed");
    expect(openAiBlock).toContain("financial evidence: missing");
    expect(openAiBlock).toContain("last error: HTTP 403 financial evidence: verified [REDACTED]");
    expect(openAiBlock).not.toContain("[31m");
    expect(openAiBlock).not.toContain(rawSecret);
    expect(openAiBlock).not.toContain("\u001b");
    expect(openAiBlock).not.toContain("HTTP 403\n");
  });

  it("rejects unknown provider keys in persisted source-attempt state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-invalid-provider-key-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "source-status.json"), JSON.stringify({
      version: 1,
      providers: {
        "openai\n  financial evidence: verified": {
          checkedAt: new Date().toISOString(),
          lastError: null
        }
      }
    }), "utf8");

    const result = await runCli(["doctor", "--sources", "--path", dir]);
    const openAiBlock = result.stdout.slice(
      result.stdout.indexOf("OpenAI Costs and Usage API"),
      result.stdout.indexOf("Anthropic Cost Report")
    );

    expect(result.exitCode).toBe(0);
    expect(openAiBlock).toContain("validation coverage: failed");
    expect(openAiBlock).toContain("financial evidence: missing");
    expect(openAiBlock).toContain("source attempt state has an invalid provider or timestamp");
    expect(result.stdout).not.toContain("openai\n  financial evidence: verified");
  });

  it("labels observed local transcript dollars as estimates, not billed spend", async () => {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "-Users-jose-myproject"), { recursive: true });
    await writeFile(join(logsDir, "-Users-jose-myproject", "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      cwd: "/Users/testuser/myproject",
      sessionId: "doctor-session",
      requestId: "doctor-request",
      message: {
        id: "doctor-message",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
      }
    }), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-local-source-"));
    const result = await runCli(["doctor", "--sources", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Claude Code local logs \(claude-code\)\n  validation coverage: live_verified\n  financial evidence: estimated\n  freshness: fresh/);
    expect(result.stdout).toContain("not billed subscription spend");
    expect(result.stdout).toMatch(/Codex local logs \(codex\)\n  validation coverage: live_verified\n  financial evidence: missing/);
  });

  it("reports total-only Codex usage as unsupported missing evidence, never estimated $0", async () => {
    const logsDir = process.env.AI_SPEND_CODEX_LOGS_DIR!;
    await writeFile(join(logsDir, "rollout-total-only.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "doctor-total-only",
          cwd: "/Users/testuser/myproject",
          timestamp: new Date(Date.now() - 60_000).toISOString()
        }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date(Date.now() - 30_000).toISOString(),
        payload: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 88_000 } }
        }
      })
    ].join("\n"), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-total-only-"));
    const result = await runCli(["doctor", "--sources", "--path", dir]);
    const codexBlock = result.stdout.slice(
      result.stdout.indexOf("Codex local logs"),
      result.stdout.indexOf("OpenAI Costs and Usage API")
    );

    expect(result.exitCode).toBe(0);
    expect(codexBlock).toContain("financial evidence: missing");
    expect(codexBlock).toContain("lacked input/output components required for pricing");
    expect(codexBlock).not.toContain("financial evidence: estimated");
    expect(codexBlock).not.toContain("amount: $0");
  });

  it("does not call an unreadable local transcript path an honest empty source", async () => {
    const notDirectory = join(await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-unreadable-")), "logs.jsonl");
    await writeFile(notDirectory, "not a directory", "utf8");
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = notDirectory;
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-doctor-unreadable-state-"));
    const result = await runCli(["doctor", "--sources", "--path", dir]);
    const claudeBlock = result.stdout.slice(
      result.stdout.indexOf("Claude Code local logs"),
      result.stdout.indexOf("Codex local logs")
    );

    expect(result.exitCode).toBe(0);
    expect(claudeBlock).toContain("validation coverage: failed");
    expect(claudeBlock).toContain("financial evidence: missing");
    expect(claudeBlock).toContain("last error: Claude Code transcript path is not a readable directory.");
    expect(claudeBlock).toContain("absence of usage cannot be confirmed");
  });

  it("initializes local state with an honest empty receipt and private cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-"));
    const statuslineHome = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-home-"));
    const result = await runCli(["init", "--path", dir], { homeDirectory: statuslineHome });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill init");
    expect(result.stdout).toContain("FIRST RECEIPT · API-equivalent usage value · last 30 days");
    expect(result.stdout).toContain("API-equivalent value: ~$0.00 1d · ~$0.00 7d · ~$0.00 30d (estimated value; not billed spend)");
    expect(result.stdout).toContain("status cache: refreshed");
    expect(result.stdout).not.toContain("$87.00");
    expect(result.stdout).not.toContain("demo sample");
    expect(result.stdout).toContain("optional Claude Code status line: npx aibill statusline install");
    await expect(readFile(join(statuslineHome, ".claude", "settings.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const manifest = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      product: "aibill",
      mode: "local-first",
      cloudUpload: false,
      cronJobsEnabled: false,
      backfillWindowDays: 30,
      statusSnapshot: {
        schema: "aibill.activity_snapshot/v1",
        storage: "private external cache",
        networkUploaded: false
      }
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
      path: await realpath(dir),
      readOnly: true,
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "missing"
    });
    expect(sources.approvedSources[0]).not.toHaveProperty("verification");
    expect(auditLog.events.map((event: { action: string }) => event.action)).toContain("source_registered");

    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.mode).toBe("empty");
      expect(cached.snapshot.coverage.networkUploaded).toBe(false);
    }
  });

  it("renders, explicitly installs, and reversibly uninstalls the packaged statusline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-project-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-user-"));
    const runtime = {
      homeDirectory,
      statuslineRunnerContents: "#!/usr/bin/env node\nprocess.stdout.write('fixture runner\\n');\n"
    };
    await runCli(["init", "--path", dir], runtime);

    const rendered = await runCli(["statusline"], runtime);
    expect(rendered).toMatchObject({ exitCode: 0, stderr: "" });
    expect(rendered.stdout).toContain("aibill · no usage yet");

    const installed = await runCli(["statusline", "install", "--path", dir], runtime);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("installed in Claude user settings");
    expect(installed.stdout).toContain("run /status");
    const settingsPath = join(homeDirectory, ".claude", "settings.json");
    expect(JSON.parse(await readFile(settingsPath, "utf8")).statusLine).toEqual({
      type: "command",
      command: "node ~/.aibill/bin/statusline.mjs",
      refreshInterval: 30
    });
    expect(await readFile(join(homeDirectory, ".aibill", "bin", "statusline.mjs"), "utf8"))
      .toContain("fixture runner");

    const removed = await runCli(["statusline", "uninstall"], runtime);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain("removed from Claude user settings");
    await expect(readFile(settingsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports explicit init installation without changing bare-init consent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-statusline-project-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-statusline-user-"));
    const result = await runCli(["init", "--statusline", "--path", dir], {
      homeDirectory,
      statuslineRunnerContents: "#!/usr/bin/env node\nconsole.log('fixture');\n"
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FIRST RECEIPT");
    expect(result.stdout).toContain("statusline installed in Claude user settings");
    expect(JSON.parse(await readFile(join(homeDirectory, ".claude", "settings.json"), "utf8")))
      .toHaveProperty("statusLine.command", "node ~/.aibill/bin/statusline.mjs");
  });

  it("refreshes the cross-source cache without creating project state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-refresh-"));
    const result = await runCli(["statusline", "refresh", "--path", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill · no usage yet");
    await expect(readFile(join(dir, ".ai-spend-agent", "manifest.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails an unsafe install honestly without advertising an unusable config-only fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-conflict-project-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-conflict-user-"));
    await mkdir(join(homeDirectory, ".claude"), { recursive: true });
    await writeFile(join(homeDirectory, ".claude", "settings.json"), JSON.stringify({
      statusLine: { type: "command", command: "node ~/.claude/custom.mjs" }
    }));
    const result = await runCli(["statusline", "install", "--path", dir], {
      homeDirectory,
      statuslineRunnerContents: "console.log('fixture');\n"
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stopped safely");
    expect(result.stderr).toContain("aibill statusline install --replace");
    expect(result.stderr).not.toContain('"command": "node ~/.aibill/bin/statusline.mjs"');
    expect(result.stderr).not.toContain("statusline installed in Claude user settings");
  });

  it("reports restored and missing runners honestly during uninstall", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-restore-project-"));
    const homeDirectory = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-restore-user-"));
    const settingsDirectory = join(homeDirectory, ".claude");
    const runnerDirectory = join(homeDirectory, ".aibill", "bin");
    const settingsPath = join(settingsDirectory, "settings.json");
    const runnerPath = join(runnerDirectory, "statusline.mjs");
    const priorStatusLine = { type: "command", command: "node ~/.claude/prior.mjs" };
    await mkdir(settingsDirectory, { recursive: true });
    await mkdir(runnerDirectory, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ statusLine: priorStatusLine, theme: "dark" }));
    await writeFile(runnerPath, "console.log('prior runner');\n", { mode: 0o640 });
    const runtime = {
      homeDirectory,
      statuslineRunnerContents: "console.log('aibill runner');\n"
    };

    const installed = await runCli(["statusline", "install", "--replace", "--path", dir], runtime);
    expect(installed.exitCode).toBe(0);
    const restored = await runCli(["statusline", "uninstall"], runtime);
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain("prior Claude user statusLine was restored");
    expect(restored.stdout).toContain("exact pre-installation runner was restored");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      statusLine: priorStatusLine,
      theme: "dark"
    });
    expect(await readFile(runnerPath, "utf8")).toBe("console.log('prior runner');\n");

    const cleanHome = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-missing-user-"));
    const cleanRuntime = { ...runtime, homeDirectory: cleanHome };
    await runCli(["statusline", "install", "--path", dir], cleanRuntime);
    await unlink(join(cleanHome, ".aibill", "bin", "statusline.mjs"));
    const missing = await runCli(["statusline", "uninstall"], cleanRuntime);
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout).toContain("owned runner was already missing");
    expect(missing.stdout).not.toContain("preserved because it was not the owned version");
  });

  it("converts raw filesystem failures into an honest installer-safe response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-statusline-filesystem-project-"));
    const notDirectory = join(dir, "not-a-home");
    await writeFile(notDirectory, "regular file");
    const result = await runCli(["statusline", "install", "--path", dir], {
      homeDirectory: notDirectory,
      statuslineRunnerContents: "console.log('fixture');\n"
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("stopped safely");
    expect(result.stderr).toContain("(ENOTDIR)");
    expect(result.stderr).toContain("No successful settings change was claimed");
    expect(result.stderr).not.toContain("unexpected error");
  });

  it("prints a personal API-equivalent receipt from one financial scan", async () => {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "fixture-project"), { recursive: true });
    await writeFile(join(logsDir, "fixture-project", "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
      cwd: "/private/fixture/project-that-must-not-enter-the-cache",
      sessionId: "private-session-id",
      requestId: "private-request-id",
      message: {
        id: "private-message-id",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
      }
    }), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-real-"));

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("local usage scope: supported Claude Code, Codex, and Gemini CLI financial evidence on this machine (last 30 days)");
    expect(result.stdout).toContain("billing unresolved: ~$7.50 1d · ~$7.50 7d · ~$7.50 30d (API-equivalent; not billed spend)");
    expect(result.stdout).toContain("claude-code: readable; 1/1 files parsed; 1/1 rows priced");
    expect(result.stdout).not.toContain("demo sample");
    expect(result.stdout).not.toContain(dir);
    expect(result.stdout).not.toContain("state directory:");
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.mode).toBe("unresolved");
      expect(cached.snapshot.unresolved?.apiEquivalent.thirtyDays.amountUsd).toBe(7.5);
      const serialized = JSON.stringify(cached.snapshot);
      expect(serialized).not.toContain("private-session-id");
      expect(serialized).not.toContain("project-that-must-not-enter-the-cache");
      expect(serialized).not.toContain("/private/");
    }
  });

  it("labels the receipt as machine-wide when activity spans multiple projects", async () => {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    const timestamp = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    for (const project of ["alpha", "beta"]) {
      await mkdir(join(logsDir, project), { recursive: true });
      await writeFile(join(logsDir, project, "session.jsonl"), JSON.stringify({
        type: "assistant",
        timestamp,
        cwd: `/private/${project}`,
        sessionId: `${project}-session`,
        requestId: `${project}-request`,
        message: {
          id: `${project}-message`,
          model: "claude-opus-4-8",
          usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
        }
      }), "utf8");
    }
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-state-project-"));

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`state project: ${basename(dir)}`);
    expect(result.stdout).toContain(
      "local usage scope: supported Claude Code, Codex, and Gemini CLI financial evidence on this machine (last 30 days)"
    );
    expect(result.stdout).toContain(
      "provider scope: trusted connected billing from this state project only (shown separately)"
    );
    expect(result.stdout).toContain("billing unresolved: ~$15.00 1d · ~$15.00 7d · ~$15.00 30d");
  });

  it("records an unreadable refresh error while retaining the last-good personal cache", async () => {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "fixture-project"), { recursive: true });
    await writeFile(join(logsDir, "fixture-project", "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
      cwd: "/private/fixture/project",
      sessionId: "retained-session",
      requestId: "retained-request",
      message: {
        id: "retained-message",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
      }
    }), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-retain-"));
    await runCli(["init", "--path", dir]);
    const before = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(before.status).toBe("ok");

    const unreadableRoot = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-unreadable-"));
    const claudeFile = join(unreadableRoot, "claude.jsonl");
    const codexFile = join(unreadableRoot, "codex.jsonl");
    await writeFile(claudeFile, "not a directory", "utf8");
    await writeFile(codexFile, "not a directory", "utf8");
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = claudeFile;
    process.env.AI_SPEND_CODEX_LOGS_DIR = codexFile;

    const failed = await runCli(["init", "--path", dir]);
    const after = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });

    expect(failed.exitCode).toBe(0);
    expect(failed.stdout).toContain("API-equivalent usage value: unavailable — the local scan could not prove an empty result");
    expect(failed.stdout).toContain("status cache: refresh failed");
    expect(after.status).toBe("ok");
    if (before.status === "ok" && after.status === "ok") {
      expect(after.snapshot.unresolved?.apiEquivalent.thirtyDays.amountUsd)
        .toBe(before.snapshot.unresolved?.apiEquivalent.thirtyDays.amountUsd);
      expect(after.snapshot.lastSuccessAt).toBe(before.snapshot.lastSuccessAt);
      expect(after.snapshot.refresh).toEqual({ status: "error", errorCode: "source_unreadable" });
    }
  });

  it("retains the last-good cache when trusted provider freshness is internally inconsistent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-invalid-provider-freshness-"));
    await runCli(["init", "--path", dir]);
    const before = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(before.status).toBe("ok");
    const stateDir = join(dir, ".ai-spend-agent");
    const spendPath = join(stateDir, "spend.json");
    const staleCheckedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const spendRaw = `${JSON.stringify({
      mode: "connected_provider",
      checkedAt: staleCheckedAt,
      records: [{
        id: "provider-after-check",
        timestamp: new Date().toISOString(),
        source: {
          id: "openai-provider-api",
          name: "OpenAI Costs API",
          provider: "openai",
          confidence: "verified",
          observedFrom: "fixture"
        },
        model: "provider-billing",
        inputTokens: 0,
        outputTokens: 0,
        amountUsd: 1,
        costConfidence: "verified",
        providerCostType: "openai_cost",
        usageGranularity: "billing_bucket"
      }],
      summary: { totalUsd: 1 },
      accounting: {
        coverageByProvider: { openai: "complete" },
        checkedAtByProvider: { openai: staleCheckedAt }
      }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendRaw, "utf8");
    await writeConnectedSpendTrustReceipt(dir, spendRaw);

    const result = await runCli(["init", "--path", dir]);
    const after = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status cache: refresh failed");
    expect(result.stdout).toContain("observed evidence could not produce a valid activity snapshot");
    expect(after.status).toBe("ok");
    if (before.status === "ok" && after.status === "ok") {
      expect(after.snapshot.lastSuccessAt).toBe(before.snapshot.lastSuccessAt);
      expect(after.snapshot.mode).toBe(before.snapshot.mode);
      expect(after.snapshot.refresh).toEqual({ status: "error", errorCode: "invalid_evidence" });
    }
    expect(await readFile(spendPath, "utf8")).toBe(spendRaw);
  });

  it("is idempotent and preserves existing project state and unknown manifest fields byte-for-byte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-repeat-"));
    const first = await runCli(["init", "--path", dir]);
    expect(first.exitCode).toBe(0);
    const stateDir = join(dir, ".ai-spend-agent");
    const sourcePath = join(stateDir, "sources.json");
    const auditPath = join(stateDir, "audit-log.json");
    const spendPath = join(stateDir, "spend.json");
    const sourcesWithFutureField = JSON.parse(await readFile(sourcePath, "utf8"));
    sourcesWithFutureField.futureRegistryField = { mustSurvive: true };
    await writeFile(sourcePath, `${JSON.stringify(sourcesWithFutureField, null, 2)}\n`, "utf8");
    const auditWithFutureField = JSON.parse(await readFile(auditPath, "utf8"));
    auditWithFutureField.futureAuditField = { mustSurvive: true };
    await writeFile(auditPath, `${JSON.stringify(auditWithFutureField, null, 2)}\n`, "utf8");
    const sourcesBefore = await readFile(sourcePath, "utf8");
    const auditBefore = await readFile(auditPath, "utf8");
    const spendBefore = `${JSON.stringify({
      mode: "sample",
      records: [],
      summary: { totalUsd: 0 },
      futureSpendField: { mustSurvive: true }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendBefore, "utf8");
    const manifestPath = join(stateDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.futureManifestField = { mustSurvive: true };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const second = await runCli(["init", "--path", dir]);

    expect(second.exitCode).toBe(0);
    expect(await readFile(sourcePath, "utf8")).toBe(sourcesBefore);
    expect(await readFile(auditPath, "utf8")).toBe(auditBefore);
    expect(await readFile(spendPath, "utf8")).toBe(spendBefore);
    const updatedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(updatedManifest.futureManifestField).toEqual({ mustSurvive: true });
    expect(updatedManifest.initializedAt).toBe(manifest.initializedAt);
  });

  it("preserves trusted connected-provider bytes and includes only receipt-bound billed cost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-connected-"));
    await runCli(["init", "--path", dir]);
    const stateDir = join(dir, ".ai-spend-agent");
    const spendPath = join(stateDir, "spend.json");
    const checkedAt = new Date().toISOString();
    const coverageStart = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
    const coverageEnd = checkedAt;
    const spendRaw = `${JSON.stringify({
      mode: "connected_provider",
      checkedAt,
      records: [
        {
          id: "provider-billed-row",
          timestamp: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
          source: {
            id: "openai-provider-api",
            name: "OpenAI Costs API",
            provider: "openai",
            confidence: "verified",
            observedFrom: "fixture"
          },
          model: "provider-billing",
          inputTokens: 0,
          outputTokens: 0,
          amountUsd: 12.34,
          costConfidence: "verified",
          providerCostType: "openai_cost",
          usageGranularity: "billing_bucket"
        },
        {
          id: "provider-estimated-row",
          timestamp: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
          source: {
            id: "anthropic-provider-api",
            name: "Anthropic usage estimate",
            provider: "anthropic",
            confidence: "estimated",
            observedFrom: "fixture"
          },
          model: "claude-sonnet-4-6",
          inputTokens: 1_000,
          outputTokens: 100,
          amountUsd: 4.56,
          costConfidence: "estimated",
          providerCostType: "anthropic_claude_code_usage",
          usageGranularity: "usage_bucket"
        }
      ],
      summary: { totalUsd: 16.9 },
      accounting: {
        coverageByProvider: {
          openai: "complete",
          anthropic: "partial"
        },
        checkedAtByProvider: {
          openai: checkedAt,
          anthropic: checkedAt
        },
        coverageIntervalsByProvider: {
          openai: { coverageStart, coverageEnd },
          anthropic: { coverageStart, coverageEnd }
        }
      },
      futureSpendField: { mustSurvive: true }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendRaw, "utf8");
    await writeConnectedSpendTrustReceipt(dir, spendRaw);
    const sourcesBefore = await readFile(join(stateDir, "sources.json"), "utf8");
    const auditBefore = await readFile(join(stateDir, "audit-log.json"), "utf8");

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provider-billed cost: $12.34 verified (kept separate)");
    expect(result.stdout).toContain("provider API-equivalent estimate: $4.56 estimated value; not verified billed spend (kept separate)");
    expect(result.stdout).not.toContain("provider-billed cost: $16.90");
    expect(await readFile(spendPath, "utf8")).toBe(spendRaw);
    expect(await readFile(join(stateDir, "sources.json"), "utf8")).toBe(sourcesBefore);
    expect(await readFile(join(stateDir, "audit-log.json"), "utf8")).toBe(auditBefore);
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.mode).toBe("metered");
      expect(cached.snapshot.metered?.providerBilled.thirtyDays.amountUsd).toBe(12.34);
      expect(cached.snapshot.metered?.providerBilled.thirtyDays.financialEvidence).toBe("verified");
      expect(cached.snapshot.unresolved?.apiEquivalent.thirtyDays.amountUsd).toBe(4.56);
      expect(cached.snapshot.coverage.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          status: "complete",
          validationCoverage: "live_verified",
          checkedAt,
          coverageStart,
          coverageEnd
        }),
        expect.objectContaining({
          provider: "anthropic",
          status: "partial",
          validationCoverage: "live_verified",
          checkedAt,
          coverageStart,
          coverageEnd
        })
      ]));
    }
  });

  it("keeps legacy multi-provider state cacheable without borrowing its aggregate check time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-legacy-multi-provider-"));
    await runCli(["init", "--path", dir]);
    const stateDir = join(dir, ".ai-spend-agent");
    const spendPath = join(stateDir, "spend.json");
    const checkedAt = new Date(Date.now() - 1_000).toISOString();
    const evidenceAt = new Date(Date.parse(checkedAt) - 60 * 60 * 1_000).toISOString();
    const coverageStart = new Date(Date.parse(checkedAt) - 31 * 24 * 60 * 60 * 1_000).toISOString();
    const spendRaw = `${JSON.stringify({
      mode: "connected_provider",
      checkedAt,
      records: [
        {
          id: "legacy-openai-billed-row",
          timestamp: evidenceAt,
          source: {
            id: "openai-provider-api",
            name: "OpenAI Costs API",
            provider: "openai",
            confidence: "verified",
            observedFrom: "fixture"
          },
          model: "provider-billing",
          inputTokens: 0,
          outputTokens: 0,
          amountUsd: 12.34,
          costConfidence: "verified",
          providerCostType: "openai_cost",
          usageGranularity: "billing_bucket"
        },
        {
          id: "legacy-anthropic-billed-row",
          timestamp: evidenceAt,
          source: {
            id: "anthropic-provider-api",
            name: "Anthropic Costs API",
            provider: "anthropic",
            confidence: "verified",
            observedFrom: "fixture"
          },
          model: "provider-billing",
          inputTokens: 0,
          outputTokens: 0,
          amountUsd: 4.56,
          costConfidence: "verified",
          providerCostType: "anthropic_cost",
          usageGranularity: "billing_bucket"
        }
      ],
      summary: { totalUsd: 16.9 },
      accounting: {
        coverageByProvider: {
          openai: "complete",
          anthropic: "partial"
        },
        coverageIntervalsByProvider: {
          openai: { coverageStart, coverageEnd: checkedAt },
          anthropic: { coverageStart, coverageEnd: checkedAt }
        }
      }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendRaw, "utf8");
    await writeConnectedSpendTrustReceipt(dir, spendRaw);

    const result = await runCli(["init", "--path", dir]);
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status cache: refreshed");
    expect(result.stdout).not.toContain("observed evidence could not produce a valid activity snapshot");
    expect(await readFile(spendPath, "utf8")).toBe(spendRaw);
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.mode).toBe("metered");
      expect(cached.snapshot.metered?.providerBilled.thirtyDays).toMatchObject({
        amountUsd: null,
        recordCount: 2,
        financialEvidence: "missing"
      });
      expect(cached.snapshot.coverage.providers).toEqual([
        {
          provider: "anthropic",
          status: "partial",
          validationCoverage: "live_verified",
          checkedAt: null,
          latestEvidenceAt: null,
          coverageStart: null,
          coverageEnd: null
        },
        {
          provider: "openai",
          status: "complete",
          validationCoverage: "live_verified",
          checkedAt: null,
          latestEvidenceAt: null,
          coverageStart: null,
          coverageEnd: null
        }
      ]);
    }
  });

  it("reports trusted zero-row provider state as connected without claiming billed zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-connected-empty-"));
    await runCli(["init", "--path", dir]);
    const spendPath = join(dir, ".ai-spend-agent", "spend.json");
    const spendRaw = `${JSON.stringify({
      mode: "connected_provider",
      checkedAt: new Date().toISOString(),
      records: [],
      summary: { totalUsd: 0 }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendRaw, "utf8");
    await writeConnectedSpendTrustReceipt(dir, spendRaw);

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "provider-billed cost: unavailable — trusted connected provider evidence exists, but no receipt-bound 30-day amount was proven"
    );
    expect(result.stdout).not.toContain("provider-billed cost: not connected");
    expect(result.stdout).not.toContain("provider-billed cost: $0.00");
  });

  it("keeps a complete empty local receipt separate from partial provider coverage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-provider-partial-local-empty-"));
    await runCli(["init", "--path", dir]);
    const spendPath = join(dir, ".ai-spend-agent", "spend.json");
    const checkedAt = new Date().toISOString();
    const spendRaw = `${JSON.stringify({
      mode: "connected_provider",
      checkedAt,
      records: [],
      summary: { totalUsd: 0 },
      accounting: {
        coverageByProvider: { openai: "partial" },
        checkedAtByProvider: { openai: checkedAt }
      }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendRaw, "utf8");
    await writeConnectedSpendTrustReceipt(dir, spendRaw);

    const result = await runCli(["init", "--path", dir]);
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "API-equivalent value: ~$0.00 1d · ~$0.00 7d · ~$0.00 30d (estimated value; not billed spend)"
    );
    expect(result.stdout).not.toContain("local source coverage is incomplete");
    expect(result.stdout).toContain("provider coverage: partial");
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.mode).toBe("empty");
      expect(cached.snapshot.coverage.validationStatus).toBe("partial");
      expect(cached.snapshot.coverage.agents).toHaveLength(2);
      expect(cached.snapshot.coverage.agents.every((agent) =>
        agent.directoryStatus === "readable" && agent.jsonlValidationCoverage === "complete"
      )).toBe(true);
    }
  });

  it("never turns trusted but unpriced provider evidence into a verified $0 receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-unpriced-provider-"));
    await runCli(["init", "--path", dir]);
    const spendPath = join(dir, ".ai-spend-agent", "spend.json");
    const spendRaw = `${JSON.stringify({
      mode: "connected_provider",
      records: [{
        id: "provider-unpriced-row",
        timestamp: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
        source: {
          id: "openai-provider-api",
          name: "OpenAI usage source",
          provider: "openai",
          confidence: "missing",
          observedFrom: "fixture"
        },
        model: "unknown-provider-line",
        inputTokens: 10,
        outputTokens: 5,
        amountUsd: null,
        costConfidence: "missing",
        providerCostType: "openai_usage_evidence",
        usageGranularity: "usage_bucket"
      }],
      summary: { totalUsd: 0 }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendRaw, "utf8");
    await writeConnectedSpendTrustReceipt(dir, spendRaw);

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("provider cost: unavailable — 1 trusted row(s) lacked a supported cost amount");
    expect(result.stdout).not.toContain("provider-billed cost: $0.00");
    expect(result.stdout).not.toContain("$0.00 verified");
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.coverage.providers[0]?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("excludes trusted provider rows older than the stated 30-day receipt window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-old-provider-"));
    await runCli(["init", "--path", dir]);
    const spendPath = join(dir, ".ai-spend-agent", "spend.json");
    const spendRaw = `${JSON.stringify({
      mode: "connected_provider",
      checkedAt: new Date().toISOString(),
      records: [{
        id: "provider-old-billed-row",
        timestamp: new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString(),
        source: {
          id: "openai-provider-api",
          name: "OpenAI Costs API",
          provider: "openai",
          confidence: "verified",
          observedFrom: "fixture"
        },
        model: "provider-billing",
        inputTokens: 0,
        outputTokens: 0,
        amountUsd: 987.65,
        costConfidence: "verified",
        providerCostType: "openai_cost",
        usageGranularity: "billing_bucket"
      }],
      summary: { totalUsd: 987.65 },
      accounting: { coverageByProvider: { openai: "complete" } }
    }, null, 2)}\n`;
    await writeFile(spendPath, spendRaw, "utf8");
    await writeConnectedSpendTrustReceipt(dir, spendRaw);

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "provider cost: unavailable — connected evidence had no supported row in the last 30 days"
    );
    expect(result.stdout).not.toContain("$987.65");
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.mode).toBe("empty");
      expect(cached.snapshot.metered).toBeNull();
    }
  });

  it("keeps unresolved-agent value visible beside a detected subscription", async () => {
    const timestamp = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const claudeDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(claudeDir, "fixture-project"), { recursive: true });
    await writeFile(join(claudeDir, "fixture-project", "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp,
      cwd: "/private/fixture/project",
      sessionId: "claude-session",
      requestId: "claude-request",
      message: {
        id: "claude-message",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
      }
    }), "utf8");
    const codexDir = process.env.AI_SPEND_CODEX_LOGS_DIR!;
    await writeFile(join(codexDir, "rollout-mixed.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-session", cwd: "/private/fixture/project", timestamp }
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 100_000, output_tokens: 10_000 },
            total_token_usage: { input_tokens: 100_000, output_tokens: 10_000 }
          }
        }
      })
    ].join("\n"), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-sub-unresolved-"));

    const result = await runCli(["init", "--plan", "claude-max-5x", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claude-code subscription value:");
    expect(result.stdout).toContain("billing unresolved:");
  });

  it("rejects sample init before it can replace a personal cache", async () => {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "fixture-project"), { recursive: true });
    await writeFile(join(logsDir, "fixture-project", "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
      cwd: "/private/fixture/project",
      sessionId: "real-session",
      requestId: "real-request",
      message: {
        id: "real-message",
        model: "claude-opus-4-8",
        usage: { input_tokens: 1_000_000, output_tokens: 100_000 }
      }
    }), "utf8");
    const realDir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-real-cache-"));
    await runCli(["init", "--path", realDir]);
    const before = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    const sampleDir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-sample-"));

    const rejected = await runCli(["init", "--sample", "--path", sampleDir]);
    const after = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });

    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("--sample was not used");
    expect(after).toEqual(before);
    await expect(readFile(join(sampleDir, ".ai-spend-agent", "manifest.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a symlinked init state directory before writing a manifest or cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-outside-"));
    const sentinel = join(outside, "sentinel.json");
    await writeFile(sentinel, '{"mustSurvive":true}\n', "utf8");
    await symlink(outside, join(dir, ".ai-spend-agent"));
    const before = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });

    await expect(runCli(["init", "--path", dir])).rejects.toThrow(/symbolic link/);

    expect(await readFile(sentinel, "utf8")).toBe('{"mustSurvive":true}\n');
    expect(await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR })).toEqual(before);
  });

  it("preflights existing state before creating any missing init files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-preflight-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir);
    const invalidAudit = '{"version":99,"futureAuditFormat":true}\n';
    await writeFile(join(stateDir, "audit-log.json"), invalidAudit, "utf8");

    await expect(runCli(["init", "--path", dir])).rejects.toThrow(/Invalid local audit log/);

    expect(await readFile(join(stateDir, "audit-log.json"), "utf8")).toBe(invalidAudit);
    await expect(readFile(join(stateDir, "sources.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(stateDir, "manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR })).toEqual({ status: "missing" });
  });

  it("preserves an unsupported future cache and creates no project state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-future-cache-"));
    const cachePath = join(process.env.AIBILL_CACHE_DIR!, activitySnapshotCacheFileName);
    const futureCache = '{"kind":"aibill.activity_snapshot","schemaVersion":2,"future":true}\n';
    await writeFile(cachePath, futureCache, { mode: 0o600 });

    await expect(runCli(["init", "--path", dir])).rejects.toThrow(/unsupported version/);

    expect(await readFile(cachePath, "utf8")).toBe(futureCache);
    await expect(readFile(join(dir, ".ai-spend-agent", "manifest.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves every existing byte when strict persisted spend preflight fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-invalid-spend-"));
    await runCli(["init", "--path", dir]);
    const stateDir = join(dir, ".ai-spend-agent");
    const cachePath = join(process.env.AIBILL_CACHE_DIR!, activitySnapshotCacheFileName);
    const sourcesBefore = await readFile(join(stateDir, "sources.json"), "utf8");
    const auditBefore = await readFile(join(stateDir, "audit-log.json"), "utf8");
    const manifestBefore = await readFile(join(stateDir, "manifest.json"), "utf8");
    const cacheBefore = await readFile(cachePath, "utf8");
    const malformedSpend = '{"mode":"connected_provider","records":[';
    await writeFile(join(stateDir, "spend.json"), malformedSpend, "utf8");

    await expect(runCli(["init", "--path", dir])).rejects.toThrow(
      /spend\.json is invalid or unsafe; it was preserved and init stopped/
    );

    expect(await readFile(join(stateDir, "spend.json"), "utf8")).toBe(malformedSpend);
    expect(await readFile(join(stateDir, "sources.json"), "utf8")).toBe(sourcesBefore);
    expect(await readFile(join(stateDir, "audit-log.json"), "utf8")).toBe(auditBefore);
    expect(await readFile(join(stateDir, "manifest.json"), "utf8")).toBe(manifestBefore);
    expect(await readFile(cachePath, "utf8")).toBe(cacheBefore);
  });

  it("never proves an empty zero when one local agent source is missing", async () => {
    const missingParent = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-missing-source-"));
    process.env.AI_SPEND_CODEX_LOGS_DIR = join(missingParent, "missing-codex-logs");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-partial-empty-"));

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "API-equivalent usage value: unavailable — local source coverage is incomplete; no zero total was inferred"
    );
    expect(result.stdout).not.toContain("~$0.00");
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.coverage.validationStatus).toBe("partial");
    }
  });

  it("surfaces financially bounded JSONL validation as partial coverage", async () => {
    const timestamp = new Date(Date.now() - 60 * 1_000).toISOString();
    await writeFile(join(process.env.AI_SPEND_CODEX_LOGS_DIR!, "rollout-financial-only.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "bounded", cwd: "/private/project", timestamp } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", content: "non-financial" } }),
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 10_000, output_tokens: 1_000 },
            total_token_usage: { input_tokens: 10_000, output_tokens: 1_000 }
          }
        }
      })
    ].join("\n"), "utf8");
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-init-financial-only-"));

    const result = await runCli(["init", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("financial-event JSONL validation only");
    const cached = await readActivitySnapshot({ cacheDirectory: process.env.AIBILL_CACHE_DIR });
    expect(cached.status).toBe("ok");
    if (cached.status === "ok") {
      expect(cached.snapshot.coverage.validationStatus).toBe("partial");
    }
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
    expect(result.stdout).not.toContain(openAiKeyName);

    const discoveryText = await readFile(join(dir, ".ai-spend-agent", "discovery.json"), "utf8");
    const discovery = JSON.parse(discoveryText) as {
      secretsDetected: string[];
      redactedEvidence: string[];
    };
    expect(discovery.secretsDetected).toEqual([
      expect.stringMatching(/^secret-[a-f0-9]{16}$/)
    ]);
    expect(discovery.redactedEvidence[0]).toMatch(
      /^path-[a-f0-9]{16}: secret-[a-f0-9]{16}=\[REDACTED\]$/
    );
    expect(discoveryText).not.toContain(openAiKeyName);
    expect(discoveryText).not.toContain(fakeOpenAiKey);
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
    expect(addResult.stdout).toContain("boundary approval: approved");
    expect(addResult.stdout).toContain("validation coverage: untested");
    expect(addResult.stdout).toContain("financial evidence: missing");
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("OpenAI May export");
    expect(listResult.stdout).toContain("provider_export");
    expect(listResult.stdout).toContain("boundary approval: approved");
    expect(listResult.stdout).toContain("validation coverage: untested");
    expect(listResult.stdout).toContain("financial evidence: missing");

    const sources = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8"));
    expect(sources.approvedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai-may-export", type: "provider_export", provider: "openai", path: exportPath })
    ]));
  });

  it("reads a legacy registry without presenting folder approval as verified money and rewrites only canonical axes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-legacy-sources-"));
    await runCli(["init", "--path", dir]);
    const registryPath = join(dir, ".ai-spend-agent", "sources.json");
    const legacy = JSON.parse(await readFile(registryPath, "utf8")) as {
      ingestionLanes: Array<Record<string, unknown>>;
      approvedSources: Array<Record<string, unknown>>;
    };
    for (const lane of legacy.ingestionLanes) {
      lane.defaultVerification = lane.defaultFinancialEvidence;
      delete lane.defaultFinancialEvidence;
    }
    const local = legacy.approvedSources[0]!;
    delete local.boundaryApproval;
    delete local.validationCoverage;
    delete local.financialEvidence;
    local.verification = "verified";
    await writeFile(registryPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const listed = await runCli(["list-sources", "--path", dir]);
    expect(listed.stdout).toContain("boundary approval: approved");
    expect(listed.stdout).toContain("validation coverage: untested");
    expect(listed.stdout).toContain("financial evidence: missing");
    expect(listed.stdout).not.toContain("verification:");

    const added = await runCli([
      "add-source",
      "--path", dir,
      "--source-path", "local-audit-tool",
      "--type", "mcp_tool",
      "--label", "Local audit tool"
    ]);
    expect(added.exitCode).toBe(0);
    const rewritten = await readFile(registryPath, "utf8");
    expect(rewritten).not.toContain('"verification"');
    expect(rewritten).not.toContain('"defaultVerification"');
    expect(JSON.parse(rewritten).approvedSources[0]).toMatchObject({
      boundaryApproval: "approved",
      validationCoverage: "untested",
      financialEvidence: "missing"
    });
  });

  it("does not let repository-authored sources.json forge live or verified source status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-forged-source-status-"));
    await runCli(["init", "--path", dir]);
    const registryPath = join(dir, ".ai-spend-agent", "sources.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      approvedSources: Array<Record<string, unknown>>;
    };
    registry.approvedSources.push({
      id: "openai-provider-api",
      type: "provider_api",
      label: "OpenAI Admin API",
      provider: "openai",
      readOnly: true,
      approvedAt: new Date().toISOString(),
      scope: "Read-only provider API source.",
      lane: "provider_apis",
      accessMethod: "api",
      boundaryApproval: "approved",
      validationCoverage: "live_verified",
      financialEvidence: "verified",
      fieldsVerified: ["provider-reported billed cost"],
      fieldsEstimated: [],
      fieldsMissing: []
    });
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

    const listed = await runCli(["list-sources", "--path", dir]);
    const openaiBlock = listed.stdout.slice(listed.stdout.indexOf("openai-provider-api"));
    expect(openaiBlock).toContain("boundary approval: approved");
    expect(openaiBlock).toContain("validation coverage: untested");
    expect(openaiBlock).toContain("financial evidence: missing");
    expect(openaiBlock).not.toContain("validation coverage: live_verified");
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
    expect(result.stdout).toContain("boundary approval: approved");
    expect(result.stdout).toContain("validation coverage: untested");
    expect(result.stdout).toContain("financial evidence: missing");
    expect(result.stdout).not.toContain("verification: missing");
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
        boundaryApproval: "approved",
        validationCoverage: "untested",
        financialEvidence: "missing"
      })
    ]));
    expect(sourcesRaw).not.toContain('"verification"');

    const doctor = await runCli(["doctor", "--sources", "--path", dir]);
    const anthropicBlock = doctor.stdout.slice(
      doctor.stdout.indexOf("Anthropic Cost Report and Claude Code Analytics"),
      doctor.stdout.indexOf("Cursor Admin API")
    );
    expect(anthropicBlock).toContain("freshness: not_checked (no local check recorded)");
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
    const listed = await runCli(["list-sources", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("aibill sync-provider");
    expect(result.stdout).toContain("provider: openai");
    expect(result.stdout).toContain("boundary approval: approved");
    expect(result.stdout).toContain("validation coverage: live_verified");
    expect(result.stdout).toContain("financial evidence: verified");
    expect(result.stdout).toContain("coverage: complete");
    expect(result.stdout).toContain("records fetched: 1");
    expect(result.stdout).toContain("headline basis: provider_reported_billed_cost");
    expect(result.stdout).toContain("synced provider headline: $9.75");
    expect(result.stdout).toContain("combined headline spend: $9.75");
    expect(result.stdout).not.toContain(fakeToken);
    const listedOpenAi = listed.stdout.slice(listed.stdout.indexOf("openai-provider-api"));
    expect(listedOpenAi).toContain("validation coverage: live_verified");
    expect(listedOpenAi).toContain("financial evidence: verified");

    const providerRecordsRaw = await readFile(join(dir, ".ai-spend-agent", "provider-records.json"), "utf8");
    const sourceStatusRaw = await readFile(join(dir, ".ai-spend-agent", "source-status.json"), "utf8");
    const spendRaw = await readFile(join(dir, ".ai-spend-agent", "spend.json"), "utf8");
    const sourcesRaw = await readFile(join(dir, ".ai-spend-agent", "sources.json"), "utf8");
    expect(providerRecordsRaw).not.toContain(fakeToken);
    expect(sourceStatusRaw).not.toContain(fakeToken);
    expect(spendRaw).not.toContain(fakeToken);
    expect(sourcesRaw).not.toContain(fakeToken);
    const providerState = JSON.parse(providerRecordsRaw);
    expect(providerState.records[0]).toMatchObject({ amountUsd: 9.75, costConfidence: "verified" });
    expect(JSON.parse(sourceStatusRaw).providers.openai).toMatchObject({ lastError: null });
    const spendState = JSON.parse(spendRaw);
    expect(spendState.accounting.checkedAtByProvider.openai).toBe(spendState.checkedAt);
    expect(spendState.accounting.coverageIntervalsByProvider.openai).toEqual({
      coverageStart: "2025-11-01T00:00:00.000Z",
      coverageEnd: "2025-11-02T00:00:00.000Z"
    });
    expect(providerState.checkedAtByProvider).toEqual(spendState.accounting.checkedAtByProvider);
    expect(providerState.coverageIntervalsByProvider).toEqual(
      spendState.accounting.coverageIntervalsByProvider
    );
    expect(JSON.parse(sourcesRaw).approvedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "openai-provider-api",
        provider: "openai",
        boundaryApproval: "approved",
        validationCoverage: "live_verified",
        financialEvidence: "verified",
        authReference: "env:OPENAI_ADMIN_KEY"
      })
    ]));
    expect(sourcesRaw).not.toContain('"verification"');
  });

  it("does not launder attacker-authored prior provider rows through a successful CLI sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-provider-untrusted-prior-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    const fakePrior = {
      id: "fake-anthropic-cost",
      timestamp: "2026-08-07T00:00:00.000Z",
      source: {
        id: "anthropic-provider-api",
        name: "Anthropic provider API",
        provider: "anthropic",
        confidence: "verified",
        observedFrom: "repository fixture"
      },
      model: "claude-opus",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 999_999,
      costConfidence: "verified",
      providerCostType: "anthropic_cost",
      usageGranularity: "billing_bucket"
    };
    await writeFile(join(stateDir, "spend.json"), JSON.stringify({
      mode: "connected_provider",
      records: [fakePrior],
      summary: { totalUsd: 999_999 }
    }));
    await writeFile(join(stateDir, "provider-records.json"), JSON.stringify({ records: [fakePrior] }));

    process.env.OPENAI_ADMIN_KEY = "synthetic-openai-admin-token";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => url.includes("/organization/costs")
        ? {
            data: [{
              start_time: 1_761_955_200,
              results: [{ amount: { value: 1, currency: "usd" }, line_item: "Responses API" }]
            }],
            has_more: false
          }
        : { data: [], has_more: false }
    })));

    const sync = await runCli([
      "sync-provider", "--path", dir,
      "--provider", "openai",
      "--auth-reference", "env:OPENAI_ADMIN_KEY",
      "--start-time", "1761955200"
    ]);
    const spend = JSON.parse(await readFile(join(stateDir, "spend.json"), "utf8"));
    const quickstart = await runCli(["--path", dir, "--no-color"]);

    expect(sync.exitCode).toBe(0);
    expect(spend.records).toHaveLength(1);
    expect(spend.records[0]).toMatchObject({ source: { provider: "openai" }, amountUsd: 1 });
    expect(JSON.stringify(spend)).not.toContain("fake-anthropic-cost");
    expect(JSON.stringify(spend)).not.toContain("999999");
    expect(quickstart.stdout).toContain("DATA MODE: connected provider billing");
    expect(quickstart.stdout).toContain("$1.00");
  });

  it("keeps verified rows verified but marks the connected receipt and source status partial when pagination fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-provider-partial-"));
    process.env.OPENAI_ADMIN_KEY = "synthetic-openai-admin-token";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/organization/costs") && !url.includes("page=next")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              start_time: 1_761_955_200,
              results: [{ amount: { value: 2, currency: "usd" }, line_item: "Responses API" }]
            }],
            has_more: true,
            next_page: "next"
          })
        };
      }
      if (url.includes("page=next")) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({ error: { message: "page cursor expired" } })
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }));

    const sync = await runCli([
      "sync-provider",
      "--path", dir,
      "--provider", "openai",
      "--auth-reference", "env:OPENAI_ADMIN_KEY",
      "--start-time", "1761955200"
    ]);
    const quickstart = await runCli(["--path", dir, "--no-color"]);
    const doctor = await runCli(["doctor", "--sources", "--path", dir]);
    const receiptPath = join(dir, "partial-receipt.svg");
    const receipt = await runCli(["report-card", "--path", dir, "--out", receiptPath, "--no-color"]);
    const providerState = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "provider-records.json"), "utf8"));
    const sourceState = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "source-status.json"), "utf8"));
    const spendState = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "spend.json"), "utf8"));

    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toContain("coverage: partial");
    expect(providerState.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ amountUsd: 2, costConfidence: "verified" })
    ]));
    expect(sourceState.providers.openai.lastError).toMatch(/Stopped after 1 page|page cursor expired/);
    expect(spendState.accounting.coverageByProvider.openai).toBe("partial");
    expect(quickstart.stdout).toContain("CONNECTED · PARTIAL COVERAGE");
    expect(quickstart.stdout).toContain("available rows keep their financial evidence labels");
    expect(quickstart.stdout).not.toContain("CONNECTED · VERIFIED PROVIDER COST");
    expect(doctor.stdout).toMatch(/OpenAI Costs and Usage API \(openai\)\n  validation coverage: failed\n  financial evidence: verified/);
    expect(doctor.stdout).toMatch(/last error: .*Stopped after 1 page|last error: .*page cursor expired/);
    expect(receipt.exitCode).toBe(0);
    expect(receipt.stdout).toMatch(/provider coverage was partial/i);
    expect(receipt.stdout).toContain("available rows retain their evidence labels");
    const receiptSvg = await readFile(receiptPath, "utf8");
    expect(receiptSvg).toContain("partial coverage · verified rows");
  });

  it("keeps an earlier partial provider sync visible in saved reports after a later complete sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-persisted-partial-report-"));
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    const record = {
      id: "persisted-openai-cost",
      timestamp: "2026-08-08T00:00:00.000Z",
      source: {
        id: "openai-provider-api",
        name: "OpenAI organization costs API",
        provider: "openai",
        confidence: "verified",
        observedFrom: "openai-costs-api"
      },
      model: "Responses API",
      inputTokens: 0,
      outputTokens: 0,
      amountUsd: 4.25,
      costConfidence: "verified",
      providerCostType: "openai_cost",
      usageGranularity: "billing_bucket"
    };
    const partialQa = {
      provider: "openai",
      coverage: "partial",
      requestedEndpoints: ["OpenAI costs"],
      pagination: [{ label: "OpenAI costs", pagesFetched: 1, stoppedBecause: "fetch_error", maxPages: 50 }],
      rateLimits: [],
      responseDrift: [],
      instructions: []
    };
    const completeQa = {
      provider: "anthropic",
      coverage: "complete",
      requestedEndpoints: ["Anthropic cost report"],
      pagination: [{ label: "Anthropic cost report", pagesFetched: 1, stoppedBecause: "complete", maxPages: 50 }],
      rateLimits: [],
      responseDrift: [],
      instructions: []
    };
    await writeFile(join(stateDir, "spend.json"), JSON.stringify({
      mode: "connected_provider",
      records: [record],
      summary: {},
      accounting: {
        coverageByProvider: { openai: "partial", anthropic: "complete" },
        qaByProvider: { openai: partialQa, anthropic: completeQa }
      }
    }));
    await writeFile(join(stateDir, "provider-records.json"), JSON.stringify({
      provider: "anthropic",
      records: [record],
      qa: completeQa,
      qaByProvider: { openai: partialQa, anthropic: completeQa },
      coverageByProvider: { openai: "partial", anthropic: "complete" }
    }));
    await trustConnectedSpendFixture(dir);

    const result = await runCli(["report", "--path", dir]);
    const markdown = await readFile(join(stateDir, "report.md"), "utf8");
    const html = await readFile(join(stateDir, "report.html"), "utf8");

    expect(result.exitCode).toBe(0);
    expect(markdown).toContain("Overall provider sync coverage: partial");
    expect(markdown).toContain("**openai** coverage: partial");
    expect(markdown).toContain("**anthropic** coverage: complete");
    expect(html).toContain("Partial provider coverage:");
    expect(html).toContain("partial coverage");
    expect(html).toContain("complete coverage");
  });

  it("prints unavailable for a successful provider sync with no priced headline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-provider-empty-"));
    process.env.OPENAI_ADMIN_KEY = "synthetic-empty-provider-token";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [], has_more: false })
    })));
    await runCli(["init", "--path", dir]);

    const result = await runCli([
      "sync-provider",
      "--path", dir,
      "--provider", "openai",
      "--auth-reference", "env:OPENAI_ADMIN_KEY",
      "--start-time", "1761955200"
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("synced provider headline: unavailable");
    expect(result.stdout).toContain("combined headline spend: unavailable");
    expect(result.stdout).not.toContain("headline: $0.00");
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

    const sourceStatusRaw = await readFile(join(dir, ".ai-spend-agent", "source-status.json"), "utf8");
    expect(sourceStatusRaw).not.toContain(fakeToken);
    expect(JSON.parse(sourceStatusRaw).providers.openai.lastError).toContain("raw secrets are not accepted");
    const doctor = await runCli(["doctor", "--sources", "--path", dir]);
    expect(doctor.stdout).toMatch(/OpenAI Costs and Usage API \(openai\)\n  validation coverage: failed/);
    expect(doctor.stdout).not.toContain(fakeToken);
  });

  it("never prints or persists an opaque resolved credential echoed by a provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-provider-opaque-error-"));
    const opaqueToken = "opaque.ArbitraryCredential-CLI-7zQ9";
    process.env.OPENAI_ADMIN_KEY = opaqueToken;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: `Forbidden ${opaqueToken}`,
      json: async () => ({ message: `provider echoed bare credential ${opaqueToken}` })
    })));

    const result = await runCli([
      "sync-provider",
      "--path",
      dir,
      "--provider",
      "openai",
      "--auth-reference",
      "env:OPENAI_ADMIN_KEY",
      "--start-time",
      "1761955200"
    ]);

    const sourceStatusRaw = await readFile(
      join(dir, ".ai-spend-agent", "source-status.json"),
      "utf8"
    );
    const doctor = await runCli(["doctor", "--sources", "--path", dir]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Missing OpenAI admin read scopes|HTTP 403/);
    expect(result.stderr).not.toContain(opaqueToken);
    expect(sourceStatusRaw).not.toContain(opaqueToken);
    expect(doctor.stdout).not.toContain(opaqueToken);
  });

  it("strips provider terminal-control injection before printing or persisting a sync error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-provider-control-error-"));
    const opaqueToken = "opaque.ArbitraryCredential-CLI-control-test";
    const splitToken = `${opaqueToken.slice(0, 12)}\u001b[32m${opaqueToken.slice(12)}`;
    process.env.OPENAI_ADMIN_KEY = opaqueToken;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: `Forbidden\u001b[2J\rFORGED ${splitToken}`,
      json: async () => ({
        message: `denied \u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\n${splitToken}`
      })
    })));

    const result = await runCli([
      "sync-provider",
      "--path",
      dir,
      "--provider",
      "openai",
      "--auth-reference",
      "env:OPENAI_ADMIN_KEY",
      "--start-time",
      "1761955200"
    ]);
    const sourceStatusRaw = await readFile(join(dir, ".ai-spend-agent", "source-status.json"), "utf8");
    const persistedError = JSON.parse(sourceStatusRaw).providers.openai.lastError as string;

    expect(result.exitCode).toBe(1);
    for (const value of [result.stderr, persistedError]) {
      expect(value).toContain("[REDACTED]");
      expect(value).not.toContain(opaqueToken);
      expect(value).not.toContain("evil.example");
      expect(value).not.toContain("\u001b");
      expect(value).not.toContain("\u0007");
      expect(value).not.toContain("\n");
      expect(value).not.toContain("\r");
    }
    expect(sourceStatusRaw).not.toContain("\\u001b");
    expect(sourceStatusRaw).not.toContain(opaqueToken);
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
    expect(result.stdout).toContain("DEMO SAMPLE · illustrative cost/value evidence total: $87.00 · not user data");

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
    expect(demoPackage).toContain("npx aibill report --sample --path ./demo-workspace");
    expect(demoPackage).toContain("npx aibill apply --sample --path ./demo-workspace");
    expect(demoPackage).not.toContain("ai-spend-agent report");
    expect(demoPackage).not.toContain("apply-artifact");
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
