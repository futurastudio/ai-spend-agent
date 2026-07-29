import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getContextHealthTool,
  getUsageGlanceTool,
  getSpendReportTool,
  listSourcesTool,
  recommendCutsTool,
  scanAiSpendTool,
  syncLocalAgentSpendTool,
  syncProviderSpendTool
} from "./index.js";
import { createServer, isInvokedAsMain } from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MCP analyst tools", () => {
  it("scans approved local source output through scan_ai_spend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-scan-"));
    await writeFile(join(dir, "openai-usage.csv"), "date,model,cost_usd\n2026-05-01,gpt-4.1,12.34\n");

    const result = await scanAiSpendTool({ path: dir });

    expect(result.discovery.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "openai", kind: "provider_export" })
    ]));
    expect(result.registry.approvedSources[0]).toMatchObject({ path: dir, readOnly: true });
    expect(result.auditLog.events.map((event) => event.action)).toContain("scan_completed");
  });

  it("lists sources from registry JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-sources-"));
    await scanAiSpendTool({ path: dir });

    const result = await listSourcesTool({ path: dir });

    expect(result.approvedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local-root", type: "local_folder" })
    ]));
  });

  it("returns scanner-backed recommendations instead of static demo data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-recs-"));
    await writeFile(join(dir, "anthropic-usage.json"), JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4", cost_usd: 8.5 }));
    await scanAiSpendTool({ path: dir });

    const result = await recommendCutsTool({ path: dir });

    expect(result.recommendations[0]).toContain("anthropic");
    expect(result.source).toBe("scanner");
  });

  it("returns analyzed recommendations when a spend report exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-report-recs-"));
    await scanAiSpendTool({ path: dir, sample: true });

    const result = await recommendCutsTool({ path: dir });

    expect(result.source).toBe("spend_report");
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("syncs real local Claude Code metadata into a non-demo spend report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-local-"));
    const claudeDir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-claude-"));
    const codexDir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-codex-"));
    const claudeHome = await mkdtemp(join(tmpdir(), "ai-spend-mcp-claude-home-"));
    const codexHome = await mkdtemp(join(tmpdir(), "ai-spend-mcp-codex-home-"));
    const project = "mcp-project";
    await writeFile(join(claudeDir, "session.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      cwd: join(dir, project),
      sessionId: "session-1",
      requestId: "request-1",
      message: {
        id: "message-1",
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 1_000,
          output_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    }));
    vi.stubEnv("AI_SPEND_CLAUDE_LOGS_DIR", claudeDir);
    vi.stubEnv("AI_SPEND_CODEX_LOGS_DIR", codexDir);
    vi.stubEnv("AI_SPEND_CLAUDE_HOME_DIR", claudeHome);
    vi.stubEnv("AI_SPEND_CODEX_HOME_DIR", codexHome);
    vi.stubEnv("AI_SPEND_CLAUDE_CONFIG", join(claudeHome, "missing.json"));

    const result = await syncLocalAgentSpendTool({ path: dir, sinceDays: 30, project });
    const glance = await getUsageGlanceTool({ path: dir, sinceDays: 30, project });
    const contextHealth = await getContextHealthTool({ path: dir, sinceDays: 30, project });
    const report = await getSpendReportTool({ path: dir }) as {
      mode: string;
      records: unknown[];
      summary: { totalUsd: number };
    };

    expect(result.agentsDetected).toContain("claude-code");
    expect(result.projectFilter).toBe(project);
    expect(report.mode).toBe("local_logs");
    expect(report.records).toHaveLength(1);
    expect(report.summary.totalUsd).toBeGreaterThan(0);
    expect(glance).toMatchObject({
      dataMode: "local_transcripts",
      currentSession: {
        status: "active",
        agent: "claude-code",
        project,
        costConfidence: "estimated"
      },
      limits: [],
      coverage: {
        supportedTranscriptAgents: ["claude-code", "codex"],
        detectedAgents: ["claude-code"],
        providerConnectionRequired: ["cursor", "github-copilot"]
      }
    });
    const { generatedAt: glanceGeneratedAt, ...glanceContract } = glance.sessionHealth;
    const { generatedAt: contextGeneratedAt, ...contextContract } = contextHealth;
    expect(glanceGeneratedAt).toEqual(expect.any(String));
    expect(contextGeneratedAt).toEqual(expect.any(String));
    expect(glanceContract).toEqual(contextContract);
  });

  it("syncs and combines OpenAI and Anthropic provider records without persisting raw tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-providers-"));
    const startTime = 1_750_000_000;
    const okResponse = (payload: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload
    });
    const openAiToken = "test-openai-secret-value";
    const anthropicToken = "test-anthropic-secret-value";

    const openAiResult = await syncProviderSpendTool({
      path: dir,
      provider: "openai",
      authReference: "env:OPENAI_ADMIN_KEY",
      startTime,
      endTime: startTime
    }, {
      tokenResolver: () => openAiToken,
      fetcher: async (url) => okResponse(url.includes("/costs")
        ? {
            data: [{
              start_time: startTime,
              end_time: startTime + 86_400,
              results: [{
                amount: { value: "1.25", currency: "usd" },
                line_item: "responses"
              }]
            }],
            has_more: false
          }
        : { data: [], has_more: false })
    });

    const anthropicResult = await syncProviderSpendTool({
      path: dir,
      provider: "anthropic",
      authReference: "env:ANTHROPIC_ADMIN_KEY",
      startTime,
      endTime: startTime
    }, {
      tokenResolver: () => anthropicToken,
      fetcher: async (url) => okResponse(url.includes("cost_report")
        ? {
            data: [{
              starting_at: new Date(startTime * 1000).toISOString(),
              ending_at: new Date((startTime + 86_400) * 1000).toISOString(),
              results: [{
                amount: "250",
                currency: "USD",
                cost_type: "tokens",
                model: "claude-opus-4-8"
              }]
            }],
            has_more: false
          }
        : { data: [], has_more: false })
    });

    const providerState = await readFile(join(dir, ".ai-spend-agent", "provider-records.json"), "utf8");
    const report = await getSpendReportTool({ path: dir }) as {
      records: Array<{ source: { provider: string } }>;
      summary: { totalUsd: number };
    };

    expect(openAiResult.syncedRecordCount).toBe(1);
    expect(anthropicResult.syncedRecordCount).toBe(1);
    expect(anthropicResult.combinedRecordCount).toBe(2);
    expect(report.records.map((record) => record.source.provider).sort()).toEqual(["anthropic", "openai"]);
    expect(report.summary.totalUsd).toBe(3.75);
    expect(providerState).not.toContain(openAiToken);
    expect(providerState).not.toContain(anthropicToken);
  });

  it("rejects raw provider credentials before any connector request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-raw-key-"));
    const fetcher = vi.fn();

    await expect(syncProviderSpendTool({
      path: dir,
      provider: "openai",
      authReference: "sk-not-a-reference",
      startTime: 1_750_000_000
    }, { fetcher })).rejects.toThrow(/environment reference/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards GitHub Copilot and Cursor provider-specific options through MCP sync", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-spend-mcp-team-providers-"));
    const startTime = 1_750_000_000;
    const okResponse = (payload: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => payload
    });
    const copilotUrls: string[] = [];

    const copilot = await syncProviderSpendTool({
      path: dir,
      provider: "github-copilot",
      authReference: "env:GITHUB_COPILOT_TOKEN",
      startTime,
      endTime: startTime,
      org: "futurastudio"
    }, {
      tokenResolver: () => "test-copilot-secret-value",
      fetcher: async (url) => {
        copilotUrls.push(url);
        return okResponse(url.includes("/billing/seats")
          ? {
              total_seats: 1,
              plan_type: "business",
              seats: [{ assignee: { login: "developer" } }]
            }
          : {
              day_totals: [{
                day: "2026-07-28",
                totals_by_model_feature: [{ model: "gpt-4.1", feature: "chat" }]
              }]
            });
      }
    });

    const cursor = await syncProviderSpendTool({
      path: dir,
      provider: "cursor",
      authReference: "env:CURSOR_ADMIN_KEY",
      startTime,
      endTime: startTime,
      accountId: "cursor-team"
    }, {
      tokenResolver: () => "test-cursor-secret-value",
      fetcher: async () => okResponse({
        users: [{ email: "developer@example.com", spendCents: 345 }]
      })
    });

    expect(copilotUrls.some((url) => url.includes("/orgs/futurastudio/"))).toBe(true);
    expect(copilot.syncedRecordCount).toBe(2);
    expect(copilot.completeness).toBe("estimated");
    expect(cursor.syncedRecordCount).toBe(1);
    expect(cursor.completeness).toBe("estimated");
    expect(cursor.combinedRecordCount).toBe(3);
  });

  it("refuses to scan the home directory and the filesystem root (same guard as the CLI)", async () => {
    // A prompt-injected MCP client must not be able to walk broad roots.
    await expect(scanAiSpendTool({ path: homedir() })).rejects.toThrow(/too broad/);
    await expect(scanAiSpendTool({ path: "/" })).rejects.toThrow(/too broad/);
    await expect(getContextHealthTool({ path: homedir() })).rejects.toThrow(/too broad/);
  });
});

describe("MCP protocol contract", () => {
  it("recognizes npm-style bin symlinks as the main module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aibill-mcp-bin-"));
    const target = join(dir, "server.js");
    const bin = join(dir, "ai-spend-mcp");
    await writeFile(target, "#!/usr/bin/env node\n");
    await symlink(target, bin);

    expect(isInvokedAsMain(bin, target)).toBe(true);
    expect(isInvokedAsMain(undefined, target)).toBe(false);
  });

  it("initializes with the package version, lists all tools, and returns safe tool errors", async () => {
    const server = createServer();
    const client = new Client({ name: "aibill-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport)
    ]);

    const tools = await client.listTools();
    const unsafeResult = await client.callTool({
      name: "scan_ai_spend",
      arguments: { path: homedir() }
    });

    expect(client.getServerVersion()).toEqual({ name: "aibill", version: "0.5.6" });
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "scan_ai_spend",
      "sync_local_agent_spend",
      "sync_provider_spend",
      "get_usage_glance",
      "get_context_health",
      "list_sources",
      "get_spend_report",
      "recommend_cuts"
    ]);
    expect(tools.tools.find((tool) => tool.name === "sync_provider_spend")?.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: true
    });
    expect(unsafeResult.isError).toBe(true);
    expect(unsafeResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/too broad/)
    });

    await client.close();
    await server.close();
  });
});
