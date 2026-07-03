import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    process.env.AI_SPEND_CLAUDE_CONFIG = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing.json");
    process.env.AI_SPEND_CODEX_AUTH = join(process.env.AI_SPEND_CLAUDE_HOME_DIR, "missing-auth.json");
  });
  afterEach(() => {
    delete process.env.AI_SPEND_CLAUDE_LOGS_DIR;
    delete process.env.AI_SPEND_CODEX_LOGS_DIR;
    delete process.env.AI_SPEND_CLAUDE_HOME_DIR;
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
    expect(result.stdout).toContain("Where to cut");
    expect(result.stdout).toMatch(/Move .* to .*save ~\$/);
    // Demo banner + connect CTA, no over-promise about "all four".
    expect(result.stdout).toContain("DEMO");
    expect(result.stdout).toContain("connect openai");
    expect(result.stdout).not.toContain("all four");
  });

  it("accepts a flag-only invocation and drills down by group-by", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-demo-"));
    const result = await runCli(["--group-by", "agent", "--no-color", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Spend by agent");
    expect(result.stdout).toContain("agent-analyst");
  });

  async function writeClaudeLogFixture() {
    const logsDir = process.env.AI_SPEND_CLAUDE_LOGS_DIR!;
    await mkdir(join(logsDir, "-Users-jose-myproject"), { recursive: true });
    const transcript = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-08T10:00:00.000Z",
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
    const prompt = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");
    expect(prompt).toContain("# AI Spend Apply Artifact");
  });

  it("report without state or logs explains what to run — and never suggests sample data as the fix for real data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-report-empty-"));
    const result = await runCli(["report", "--path", dir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npx ai-spend-agent");
    expect(result.stderr).not.toMatch(/^Run scan --sample/);
  });

  it("honors --plan as an explicit persona override", async () => {
    await writeClaudeLogFixture();
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-plan-"));

    const result = await runCli(["--plan", "claude-max-5x", "--path", dir, "--no-color"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("you're on Claude Max 5x");
    expect(result.stdout).toContain("PLAN Claude Max 5x");
  });

  it("rejects an unknown --plan id and lists valid plans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-badplan-"));
    const result = await runCli(["--plan", "claude-mega-100x", "--path", dir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("claude-max-20x");
    expect(result.stderr).toContain("chatgpt-plus");
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
    expect(result.stdout).toContain("$7.50 tracked");
    expect(result.stdout).not.toContain("$87.00 tracked");
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
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_ADMIN_KEY;
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
    expect(result.stdout).toContain("AI Spend Analyst doctor");
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
    expect(result.stdout).toContain("AI Spend Analyst Agent init");
    expect(result.stdout).toContain("demo mode: local-first sample workflow");
    expect(result.stdout).toContain("next: ai-spend-agent scan --sample --path");

    const manifest = JSON.parse(await readFile(join(dir, ".ai-spend-agent", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      product: "AI Spend Analyst Agent",
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
    expect(result.stdout).toContain("AI Spend Analyst Agent sync-provider");
    expect(result.stdout).toContain("provider: openai");
    expect(result.stdout).toContain("verified records: 1");
    expect(result.stdout).toContain("total spend: $9.75");
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
    expect(result.stdout).toContain("AI Spend Analyst Agent report");
    expect(result.stdout).toContain("total spend: $87.00");

    const markdown = await readFile(join(dir, ".ai-spend-agent", "report.md"), "utf8");
    const html = await readFile(join(dir, ".ai-spend-agent", "report.html"), "utf8");
    const applyArtifact = await readFile(join(dir, ".ai-spend-agent", "ai-spend-coding-agent-prompt.md"), "utf8");
    const actionPlan = await readFile(join(dir, ".ai-spend-agent", "ai-spend-action-plan.md"), "utf8");
    const policyDraft = await readFile(join(dir, ".ai-spend-agent", "ai-spend-policy-config-draft.md"), "utf8");
    const verifyPlan = await readFile(join(dir, ".ai-spend-agent", "ai-spend-verify-plan.md"), "utf8");
    const demoPackage = await readFile(join(dir, ".ai-spend-agent", "demo-package.md"), "utf8");
    expect(markdown).toContain("# AI Spend Analyst Report");
    expect(markdown).toContain("## Board brief");
    expect(markdown).toContain("## Priority recommendations");
    expect(markdown).toContain("## Board action plan");
    expect(markdown).toContain("## Agency margin and workflow watch");
    expect(markdown).toContain("client-beta / project-research / research_summary");
    expect(markdown).toContain("Estimated savings: $12.80");
    expect(markdown).toContain("Copy this into your coding agent");
    expect(applyArtifact).toContain("# AI Spend Apply Artifact");
    expect(applyArtifact).toContain("client-beta / project-research / research_summary");
    expect(applyArtifact).toContain("Do not change user-visible quality thresholds without approval");
    expect(actionPlan).toContain("# AI Spend Action Plan");
    expect(actionPlan).toContain("Immediate actions");
    expect(actionPlan).toContain("Estimated impact");
    expect(policyDraft).toContain("# AI Spend Policy / Config Draft");
    expect(policyDraft).toContain("humanApproved: true");
    expect(policyDraft).toContain("cloudUpload: false");
    expect(verifyPlan).toContain("# AI Spend Verification Plan");
    expect(verifyPlan).toContain("Before baseline");
    expect(verifyPlan).toContain("Rollback triggers");
    expect(demoPackage).toContain("# AI Spend Analyst Demo Package");
    expect(demoPackage).toContain("Demo command flow");
    expect(demoPackage).toContain("QA controller checklist");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Board brief");
    expect(html).toContain("AI Spend Analyst Report");
  });

  it("prints a plain-English 90-second readout from sample data via quickstart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-quickstart-"));

    const result = await runCli(["quickstart", "--sample", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AI SPEND");
    expect(result.stdout).toContain("$87.00");
    expect(result.stdout).toContain("tracked across 9 calls");
    expect(result.stdout).toContain("Where to cut");
    expect(result.stdout).toContain("to gpt-5.5-mini");
    expect(result.stdout).toMatch(/save ~\$[\d,]+\.\d{2}\/mo/);
    expect(result.stdout).toContain("Spend by model");
    // Human-readable terminal output, not a JSON dump.
    expect(result.stdout).not.toContain("totalUsd");
  });

  it("respects the --group-by flag in quickstart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-quickstart-group-"));

    const result = await runCli(["quickstart", "--sample", "--group-by", "client", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Spend by client");
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
    expect(sync.stdout).toContain("total spend: $54.50");
    expect(sync.stdout).not.toContain(fakeToken);

    // quickstart without --sample must use the live provider records, not sample data.
    const quick = await runCli(["quickstart", "--group-by", "model", "--path", dir]);
    expect(quick.exitCode).toBe(0);
    expect(quick.stdout).toContain("$54.50");
    expect(quick.stdout).toContain("tracked across 2 calls");
    expect(quick.stdout).toContain("Spend by model");
    expect(quick.stdout).toContain("gpt-4.1");
    expect(quick.stdout).not.toContain(fakeToken);
    expect(quick.stdout).not.toContain("87.00");
  });

  it("generates Apply + Verify artifacts without rebuilding the full report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-cli-apply-"));
    await runCli(["scan", "--sample", "--path", dir]);

    const result = await runCli(["apply-artifact", "--path", dir]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AI Spend Analyst Agent apply-artifact");
    expect(result.stdout).toContain("coding prompt:");
    expect(result.stdout).toContain("action plan:");
    expect(result.stdout).toContain("policy/config draft:");
    expect(result.stdout).toContain("verification plan:");
    expect(result.stdout).toContain("demo package:");
    expect(await readFile(join(dir, ".ai-spend-agent", "ai-spend-action-plan.md"), "utf8")).toContain("# AI Spend Action Plan");
  });
});
