import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./index.js";

/**
 * COMMAND-SEQUENCE INVARIANTS.
 *
 * Unit tests exercise commands in isolation; real users run them in sequence
 * against shared persisted state. Every launch-blocking bug found in field
 * testing lived in the seams between commands (stale snapshots, mislabeled
 * modes, artifacts routed by poisoned state). This suite runs the realistic
 * sequences and asserts the invariants that must survive ANY order:
 *
 *  I1. DATA MODE never claims "connected" unless provider-sourced records exist.
 *  I2. Back-to-back commands agree on the total (one engine, one moment).
 *  I3. Local-log users always get the coding-agent artifact — agency framing
 *      (unmapped-client, margin risk) can never leak in via persisted state.
 *  IN PRACTICE: add a sequence here for every new command that writes state.
 */
describe("command-sequence invariants (fixture logs, shared state)", () => {
  beforeEach(async () => {
    process.env.AI_SPEND_CLAUDE_LOGS_DIR = await mkdtemp(join(tmpdir(), "seq-claude-"));
    process.env.AI_SPEND_CODEX_LOGS_DIR = await mkdtemp(join(tmpdir(), "seq-codex-"));
    process.env.AI_SPEND_CLAUDE_HOME_DIR = await mkdtemp(join(tmpdir(), "seq-home-"));
    process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
    process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");

    const projDir = join(process.env.AI_SPEND_CLAUDE_LOGS_DIR, "-Users-dev-myapp");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-08T10:00:00.000Z",
      cwd: "/Users/dev/myapp",
      sessionId: "sess-1",
      requestId: "req-1",
      message: { id: "msg-1", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 100_000 } }
    }), "utf8");
  });
  afterEach(() => {
    delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
    delete process.env.AI_SPEND_CODEX_LOGS_DIR;
    delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
    delete process.env.AI_SPEND_CLAUDE_CONFIG;
    delete process.env.AI_SPEND_CODEX_AUTH;
  });

  it("quickstart → watch → quickstart → report → apply: modes stay truthful, totals agree, artifacts stay local-flavored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seq-state-"));

    const first = await runCli(["--path", dir, "--no-color"]);
    expect(first.stdout).toContain("DATA MODE: your local agent logs");
    expect(first.stdout).toContain("$7.50");

    // Watch must re-read fresh, persist the TRUE mode, and stay compact.
    const watch = await runCli(["watch", "--cycles", "1", "--path", dir, "--no-color"]);
    expect(watch.exitCode).toBe(0);
    expect(watch.stdout).toContain("$7.50");
    expect(watch.stdout).not.toContain("RECOMMEND");
    const spend = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "spend.json"), "utf8"));
    // I1: local-log records must never be persisted as connected_provider.
    expect(spend.mode).toBe("local_logs");

    // I1+I2: the next quickstart must still be truthful and agree on totals.
    const second = await runCli(["--path", dir, "--no-color"]);
    expect(second.stdout).toContain("DATA MODE: your local agent logs");
    expect(second.stdout).not.toContain("connected provider billing");
    expect(second.stdout).toContain("$7.50");

    // I3: report + apply route by TRUE mode — agency framing can never leak.
    await runCli(["report", "--path", dir]);
    const html = await readFile(join(dir, ".ai-spend-agent", "report.html"), "utf8");
    expect(html).toContain("AI Receipt");
    expect(html).not.toContain("unmapped-client");
    expect(html).not.toContain("Board-ready");

    const apply = await runCli(["apply", "--path", dir]);
    expect(apply.stdout).toContain("cleaning up my coding-agent setup");
    expect(apply.stdout).not.toContain("unmapped-client");
    expect(apply.stdout).not.toContain("Margin at risk");
  });

  it("poisoned state (local records stamped connected) is superseded, not served", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seq-poison-"));
    // Simulate the exact historical bug: local-log records persisted as connected.
    const stateDir = join(dir, ".ai-spend-agent");
    await mkdir(stateDir, { recursive: true });
    const poisonRecord = {
      id: "poison-1",
      timestamp: "2026-06-01T00:00:00.000Z",
      source: { id: "local-agent-logs", name: "Local agent session logs", provider: "anthropic", confidence: "estimated", observedFrom: "test" },
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 10,
      amountUsd: 999,
      costConfidence: "estimated",
      agentId: "claude-code",
      providerCostType: "local_agent_logs",
      operation: "claude-code sessions"
    };
    await writeFile(join(stateDir, "spend.json"), JSON.stringify({
      mode: "connected_provider",
      records: [poisonRecord],
      summary: { totalUsd: 999 }
    }), "utf8");

    const result = await runCli(["--path", dir, "--no-color"]);
    expect(result.stdout).toContain("DATA MODE: your local agent logs");
    expect(result.stdout).not.toContain("connected provider billing");
    expect(result.stdout).not.toContain("$999");

    const report = await runCli(["report", "--path", dir]);
    expect(report.exitCode).toBe(0);
    const html = await readFile(join(stateDir, "report.html"), "utf8");
    expect(html).toContain("AI Receipt");
    expect(html).not.toContain("unmapped-client");
  });

  it("--group-by without a dimension errors with usage instead of dumping the full readout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seq-groupby-"));
    const result = await runCli(["--group-by", "--path", dir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("source|model|client|project|agent|user|workspace|apiKey");
  });
});
