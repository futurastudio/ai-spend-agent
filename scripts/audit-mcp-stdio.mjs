#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = resolve(import.meta.dirname, "..");
const envPath = resolve(projectRoot, process.argv[2] ?? ".env");
const envValues = parseEnv(await readFile(envPath, "utf8"));
const stateRoot = await mkdtemp(join(tmpdir(), "aibill-mcp-live-"));
const childEnv = {
  ...getDefaultEnvironment(),
  ...pickPresent(envValues, ["OPENAI_ADMIN_KEY", "ANTHROPIC_ADMIN_KEY"])
};
const transport = new StdioClientTransport({
  command: "node",
  args: ["packages/mcp/dist/server.js"],
  cwd: projectRoot,
  env: childEnv,
  stderr: "pipe"
});
const client = new Client({ name: "aibill-mcp-live-audit", version: "1.0.0" });
const endTime = Math.floor(Date.now() / 1000);
const startTime = endTime - 7 * 24 * 60 * 60;

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const results = {
    serverVersion: client.getServerVersion(),
    tools: tools.tools.map((tool) => tool.name),
    stateRoot,
    localLogs: await callSummary("sync_local_agent_spend", {
      path: stateRoot,
      sinceDays: 30,
      project: "agent-finops"
    }),
    glance: await callSummary("get_usage_glance", {
      path: projectRoot,
      sinceDays: 30,
      project: "agent-finops"
    }),
    contextHealth: await callSummary("get_context_health", {
      path: projectRoot,
      sinceDays: 30,
      project: "agent-finops"
    }),
    providers: []
  };

  for (const [provider, envName] of [
    ["openai", "OPENAI_ADMIN_KEY"],
    ["anthropic", "ANTHROPIC_ADMIN_KEY"]
  ]) {
    if (!envValues[envName]) {
      results.providers.push({ provider, status: "missing-key-reference" });
      continue;
    }
    results.providers.push(await callSummary("sync_provider_spend", {
      path: stateRoot,
      provider,
      authReference: `env:${envName}`,
      startTime,
      endTime
    }));
  }

  const report = await callSummary("get_spend_report", { path: stateRoot });
  const sources = await callSummary("list_sources", { path: stateRoot });
  console.log(JSON.stringify({
    ...results,
    report: report.status === "ok"
      ? {
          status: "ok",
          mode: report.data.mode,
          records: report.data.records?.length,
          totalUsd: report.data.summary?.totalUsd,
          providers: Array.from(new Set(
            (report.data.records ?? []).map((record) => record.source?.provider).filter(Boolean)
          )).sort()
        }
      : report,
    sources: sources.status === "ok"
      ? {
          status: "ok",
          approved: (sources.data.approvedSources ?? []).map((source) => ({
            id: source.id,
            provider: source.provider,
            verification: source.verification
          }))
        }
      : sources
  }, null, 2));
} finally {
  await client.close().catch(() => undefined);
}

async function callSummary(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  if (result.isError) return { name, status: "error", message: text };
  const data = result.structuredContent ?? JSON.parse(text);
  if (name === "sync_local_agent_spend") {
    return {
      name,
      status: "ok",
      data: {
        agentsDetected: data.agentsDetected,
        filesParsed: data.filesParsed,
        recordCount: data.recordCount,
        projectFilter: data.projectFilter,
        totalUsd: data.summary?.totalUsd
      }
    };
  }
  if (name === "sync_provider_spend") {
    return {
      name,
      provider: data.provider,
      status: "ok",
      records: data.syncedRecordCount,
      totalUsd: data.syncedTotalUsd,
      completeness: data.completeness,
      responseDriftFields: Array.from(new Set(
        (data.qa?.responseDrift ?? []).map((issue) => issue.field.replace(/\[\d+\]/g, "[]"))
      )).sort()
    };
  }
  if (name === "get_usage_glance") {
    return {
      name,
      status: "ok",
      data: {
        dataMode: data.dataMode,
        filesParsed: data.coverage?.filesParsed,
        detectedAgents: data.coverage?.detectedAgents,
        currentSession: data.currentSession
          ? {
              status: data.currentSession.status,
              agent: data.currentSession.agent,
              project: data.currentSession.project,
              model: data.currentSession.model,
              costConfidence: data.currentSession.costConfidence
            }
          : null,
        reportedLimits: (data.limits ?? []).map((limit) => ({
          agent: limit.agent,
          kind: limit.kind,
          source: limit.source
        })),
        anomaly: data.anomaly?.kind ?? null,
        contextRecommendation: data.sessionHealth?.recommendation ?? null
      }
    };
  }
  if (name === "get_context_health") {
    return {
      name,
      status: "ok",
      data: {
        status: data.status,
        recommendation: data.recommendation,
        confidence: data.confidence,
        activation: data.activation,
        uploaded: data.provenance?.uploaded
      }
    };
  }
  return { name, status: "ok", data };
}

function parseEnv(contents) {
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2] ?? "";
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function pickPresent(values, names) {
  return Object.fromEntries(
    names.filter((name) => values[name]).map((name) => [name, values[name]])
  );
}
