#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = await mkdtemp(join(tmpdir(), "aibill-mcp-fixture-matrix-"));
const stateRoot = join(fixtureRoot, "workspace");
const claudeLogs = join(fixtureRoot, "empty-claude-logs");
const codexLogs = join(fixtureRoot, "empty-codex-logs");
const claudeHome = join(fixtureRoot, "empty-claude-home");
const codexHome = join(fixtureRoot, "empty-codex-home");
await Promise.all([
  mkdir(stateRoot),
  mkdir(claudeLogs),
  mkdir(codexLogs),
  mkdir(claudeHome),
  mkdir(codexHome)
]);

const expectedTools = [
  "scan_ai_spend",
  "sync_local_agent_spend",
  "sync_provider_spend",
  "get_usage_glance",
  "get_context_health",
  "list_sources",
  "get_spend_report",
  "recommend_cuts"
];
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/mcp/dist/server.js"],
  cwd: projectRoot,
  env: {
    ...getDefaultEnvironment(),
    AI_SPEND_CLAUDE_LOGS_DIR: claudeLogs,
    AI_SPEND_CODEX_LOGS_DIR: codexLogs,
    AI_SPEND_CLAUDE_HOME_DIR: claudeHome,
    AI_SPEND_CODEX_HOME_DIR: codexHome,
    AI_SPEND_CLAUDE_CONFIG: join(claudeHome, "missing-config.json"),
    AI_SPEND_CLAUDE_SETTINGS: join(claudeHome, "missing-settings.json"),
    AI_SPEND_CODEX_AUTH: join(codexHome, "missing-auth.json")
  },
  stderr: "pipe"
});
const client = new Client({ name: "aibill-mcp-fixture-matrix", version: "1.0.0" });
const results = [];

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), expectedTools);

  // P0.3: a first report with no transcripts or synced state falls back to an
  // unmistakable in-memory sample without creating project state.
  await callOk("get_spend_report", { path: stateRoot }, (data) => {
    assert.equal(data.mode, "sample");
    assert.equal(data.accounting?.policy, "demo_sample_not_user_data");
    assert.equal(data.fallback?.automatic, true);
    assert.equal(data.fallback?.persisted, false);
    assert.equal(data.fallback?.demoOnly, true);
    assert.equal(data.provenance?.state, "bundled_sample_fallback");
    assert.ok(data.records?.length > 0);
    assert.ok(data.records.every((record) => record.costConfidence !== "verified"));
    assert.equal(data.accounting?.financialsByProvider?.openai?.providerReportedBilledUsd, null);
    assert.equal(data.accounting?.financialsByProvider?.openai?.headlineBasis, "provider_estimated_cost");
  }, false);

  await callOk("scan_ai_spend", { path: stateRoot, sample: true }, (data) => {
    assert.equal(data.dataMode, "sample");
    assert.deepEqual(data.sampleBoundary, {
      demoOnly: true,
      spendRowsAreUserData: false,
      localDiscovery: "skipped",
      persisted: true
    });
    assert.equal(data.registry?.cloudUpload, false);
  });
  await callExpectedError("sync_local_agent_spend", {
    path: stateRoot,
    sinceDays: 30
  }, /No supported Claude Code, Codex, or Gemini CLI financial rows/);
  await callExpectedError("sync_provider_spend", {
    path: stateRoot,
    provider: "openai",
    authReference: "env:AIBILL_INTENTIONALLY_UNSET_KEY",
    startTime: 0,
    endTime: 1
  }, /environment variable|credential|reference/i);
  await callOk("get_usage_glance", {
    path: stateRoot,
    sinceDays: 30
  }, (data) => {
    assert.equal(data.dataMode, "local_transcripts");
    assert.equal(data.coverage?.filesParsed, 0);
    assert.equal(data.currentSession, null);
  });
  await callOk("get_context_health", {
    path: stateRoot,
    sinceDays: 30
  }, (data) => {
    assert.equal(data.provenance?.uploaded, false);
  });
  await callOk("list_sources", { path: stateRoot }, (data) => {
    assert.ok(Array.isArray(data.approvedSources));
    const local = data.approvedSources.find((source) => source.id === "local-root");
    assert.equal(local?.label, "Approved local scan root");
    assert.match(local?.path ?? "", /workspace$/);
    assert.equal(local?.fieldsVerified?.[0], "approved local folder boundary");
    assert.doesNotMatch(JSON.stringify(local), /\[untrusted-metadata:/);
  });
  await callOk("get_spend_report", { path: stateRoot }, (data) => {
    assert.equal(data.mode, "sample");
    assert.equal(data.accounting?.policy, "demo_sample_not_user_data");
    assert.ok(data.records?.length > 0);
    const openai = data.sourceStatuses?.find((status) => status.id === "openai");
    assert.equal(openai?.validationCoverage, "failed");
    assert.equal(openai?.financialEvidence, "missing");
    assert.equal(openai?.freshness?.status, "fresh");
    assert.match(openai?.lastError ?? "", /environment variable|credential reference/i);
  });
  await callOk("recommend_cuts", { path: stateRoot }, (data) => {
    assert.match(data.recommendations?.[0] ?? "", /^DEMO ONLY:/);
  });

  await writeFile(join(stateRoot, ".ai-spend-agent", "source-status.json"), JSON.stringify({
    version: 1,
    providers: {
      openai: { checkedAt: "2026-01-01T00:00:00.000Z", lastError: null }
    }
  }));
  await callOk("get_spend_report", { path: stateRoot }, (data) => {
    const openai = data.sourceStatuses?.find((status) => status.id === "openai");
    assert.equal(openai?.freshness?.status, "stale");
  }, false);

  await writeFile(join(stateRoot, ".ai-spend-agent", "spend.json"), "{not-json\n");
  await callExpectedError("get_spend_report", { path: stateRoot }, /JSON|Unexpected|property name/i, false);

  assert.deepEqual(results.map((result) => result.tool), expectedTools);
  console.log(JSON.stringify({
    status: "ok",
    transport: "stdio",
    serverVersion: client.getServerVersion(),
    tools: results,
    sampleFallback: {
      explicit: true,
      dataMode: "sample",
      automatic: true,
      automaticPersistence: false,
      reason: "With no synced state, get_spend_report returns a clearly labeled in-memory sample. Failed or malformed real state is never silently replaced."
    },
    reliability: {
      staleSourceStatus: "pass",
      malformedPersistedState: "expected_safe_error"
    }
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}

async function callOk(tool, args, verify, recordResult = true) {
  const response = await client.callTool({ name: tool, arguments: args });
  assert.notEqual(response.isError, true, textContent(response));
  const data = structuredData(response);
  verify(data);
  if (recordResult) results.push({ tool, status: "ok" });
}

async function callExpectedError(tool, args, messagePattern, recordResult = true) {
  const response = await client.callTool({ name: tool, arguments: args });
  const message = textContent(response);
  assert.equal(response.isError, true, `${tool} unexpectedly succeeded`);
  assert.match(message, messagePattern);
  if (recordResult) results.push({ tool, status: "expected_error", safe: true });
}

function structuredData(response) {
  if (response.structuredContent) return response.structuredContent;
  return JSON.parse(textContent(response));
}

function textContent(response) {
  return response.content.find((item) => item.type === "text")?.text ?? "";
}
